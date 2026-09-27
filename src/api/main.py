"""
FastAPI Backend

Provides REST API and SSE endpoints for the UI.
Routes are organized in separate modules under api/routes/.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from datetime import datetime
import asyncio
import logging
import sys
import os
from pathlib import Path

from dotenv import load_dotenv
from pymongo.errors import ServerSelectionTimeoutError, OperationFailure

from orchestration.orchestrator import Orchestrator
from config.agent_loader import load_agents_from_db
from config.seed_controls import maybe_write_backend_version
from storage.mongo_backend import MongoStorageBackend
from storage.artifact_store import ArtifactStore
from storage.archive_store import ArchiveStore
from llm.client import LLMClient
from tools.tool_registry import ToolRegistry
from tools.mcp_executor import MCPToolExecutor
from tools.mcp_zip_recovery import recover_zip_mcp_servers
from events.emitter import EventEmitter
from sandbox.container_manager import ContainerManager
from sandbox.external_mcp_manager import ExternalMCPServerManager
from deploy.service import DeployService
from telemetry.tracer import get_tracer
from orchestration.project_loader import ProjectLoader

from api import deps
from api.routes import (
    health_router,
    projects_router,
    approvals_router,
    control_router,
    runs_router,
    run_configurations_router,
    deployments_router,
    events_router,
    admin_router,
    messages_router,
    settings_router,
    agent_configurations_router,
    workflow_definitions_router,
    configuration_phases_router,
    tool_configurations_router,
    agents_router,
    mcp_tool_configurations_router,
    config_bundle_router,
    agent_llm_calls_router,
    execution_trace_router,
    a2a_configurations_router,
    checkpoints_router,
    human_input_router,
    a2a_human_input_router,
    archive_router,
    file_attachments_router,
    tenant_artifacts_router,
)
from api.auth.routes import router as auth_router
from api.auth.tenant_routes import router as tenant_router
from config.seed import seed_run_configurations
from storage.message_store import MessageStore
from storage.checkpoint_store import CheckpointStore
from integrations.a2a_client import A2AClientFactory
from integrations.checkpoint_logging import install_checkpoint_log_filter

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
install_checkpoint_log_filter()
for _n in (
        "orchestration.orchestrator",
        "orchestration.auction",
        "agents.base",
        "tools.mcp_executor",
):
    logging.getLogger(_n).setLevel(logging.INFO)

_tracer = get_tracer()
logging.info("[BOOT] logger.online otel_enabled=%s service=%s",
             getattr(_tracer, "enabled", False), getattr(_tracer, "service_name", None))


# Health access log filter
class _HealthAccessFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        from api.routes.health import HEALTH_DETAILS_LOG_ENABLED
        if "/api/health/details" in msg and not HEALTH_DETAILS_LOG_ENABLED:
            return False
        return True

try:
    logging.getLogger("uvicorn.access").addFilter(_HealthAccessFilter())
except Exception:
    pass


ZIP_MCP_RECOVERY_CANCEL_TIMEOUT_SECONDS = 5.0
MCP_LEASE_WORKER_HEARTBEAT_SECONDS = 60.0
WORKFLOW_SHUTDOWN_CANCEL_TIMEOUT_SECONDS = 5.0


async def _recover_zip_mcp_servers_on_startup(*, storage, manager) -> None:
    """Warm durable ZIP MCP runtimes without making API startup unavailable."""
    try:
        await recover_zip_mcp_servers(storage, manager=manager)
    except Exception:
        logging.exception("[MCP_ZIP_RECOVERY] action=summary status=failed")


def _start_zip_mcp_recovery_task(app: FastAPI, *, storage, manager) -> asyncio.Task:
    """Schedule ZIP MCP warm-up without delaying FastAPI lifespan readiness."""
    task = asyncio.create_task(
        _recover_zip_mcp_servers_on_startup(storage=storage, manager=manager),
        name="mcp-zip-startup-recovery",
    )
    app.state.mcp_zip_recovery_task = task
    logging.info("[MCP_ZIP_RECOVERY] action=summary status=scheduled")
    return task


async def _stop_zip_mcp_recovery_task(app: FastAPI) -> None:
    """Cancel background ZIP recovery before its manager and storage are closed."""
    task = getattr(app.state, "mcp_zip_recovery_task", None)
    if not isinstance(task, asyncio.Task) or task.done():
        return
    logging.info("[MCP_ZIP_RECOVERY] action=summary status=cancelling")
    task.cancel()
    try:
        await asyncio.wait_for(
            asyncio.shield(task),
            timeout=ZIP_MCP_RECOVERY_CANCEL_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logging.warning("[MCP_ZIP_RECOVERY] action=summary status=cancel_timeout")
    except asyncio.CancelledError:
        logging.info("[MCP_ZIP_RECOVERY] action=summary status=cancelled")
    except Exception:
        logging.exception("[MCP_ZIP_RECOVERY] action=summary status=failed")


async def _recover_a2a_cursors_on_startup(*, orchestrator) -> None:
    """Resume every project with an open A2A cursor without delaying API
    startup readiness (AppFactory-280 Issue 1)."""
    try:
        await orchestrator.reconcile_open_a2a_cursors()
    except Exception:
        logging.exception("[A2A_RECOVER] action=startup_sweep_summary status=failed")


def _start_a2a_recovery_task(app: FastAPI, *, orchestrator) -> asyncio.Task:
    """Schedule the A2A cursor sweep without delaying FastAPI lifespan readiness."""
    task = asyncio.create_task(
        _recover_a2a_cursors_on_startup(orchestrator=orchestrator),
        name="a2a-startup-recovery",
    )
    app.state.a2a_recovery_task = task
    logging.info("[A2A_RECOVER] action=startup_sweep_summary status=scheduled")
    return task


async def _stop_a2a_recovery_task(app: FastAPI) -> None:
    """Cancel the background A2A sweep before storage/orchestrator are closed."""
    task = getattr(app.state, "a2a_recovery_task", None)
    if not isinstance(task, asyncio.Task) or task.done():
        return
    logging.info("[A2A_RECOVER] action=startup_sweep_summary status=cancelling")
    task.cancel()
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=5.0)
    except asyncio.TimeoutError:
        logging.warning("[A2A_RECOVER] action=startup_sweep_summary status=cancel_timeout")
    except asyncio.CancelledError:
        logging.info("[A2A_RECOVER] action=startup_sweep_summary status=cancelled")
    except Exception:
        logging.exception("[A2A_RECOVER] action=startup_sweep_summary status=failed")


async def _maintain_a2a_cancellation_recovery(*, orchestrator) -> None:
    """Keep retrying durable remote cancellation requests while the API is live."""
    while True:
        try:
            await orchestrator.reconcile_pending_a2a_cancellations()
        except asyncio.CancelledError:
            raise
        except Exception:
            logging.exception("[A2A_RECOVER] action=cancellation_sweep status=failed")
        await asyncio.sleep(30.0)


def _start_a2a_cancellation_recovery_task(app: FastAPI, *, orchestrator) -> asyncio.Task:
    task = asyncio.create_task(
        _maintain_a2a_cancellation_recovery(orchestrator=orchestrator),
        name="a2a-cancellation-recovery",
    )
    app.state.a2a_cancellation_recovery_task = task
    logging.info("[A2A_RECOVER] action=cancellation_sweep status=scheduled")
    return task


async def _stop_a2a_cancellation_recovery_task(app: FastAPI) -> None:
    task = getattr(app.state, "a2a_cancellation_recovery_task", None)
    if not isinstance(task, asyncio.Task) or task.done():
        return
    task.cancel()
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=5.0)
    except asyncio.TimeoutError:
        logging.warning("[A2A_RECOVER] action=cancellation_sweep status=cancel_timeout")
    except asyncio.CancelledError:
        logging.info("[A2A_RECOVER] action=cancellation_sweep status=cancelled")
    except Exception:
        logging.exception("[A2A_RECOVER] action=cancellation_sweep status=failed")


async def _stop_active_workflow_tasks(orchestrator) -> None:
    """Interrupt workflow cleanup before closing its A2A and storage clients."""
    from orchestration.workflow_task_lifecycle import mark_workflow_task_explicit_cancel

    project_tasks = getattr(orchestrator, "project_tasks", {}) or {}
    active_tasks = [
        task
        for task in project_tasks.values()
        if isinstance(task, asyncio.Task) and not task.done()
    ]
    if not active_tasks:
        return

    logging.info(
        "[ENGINE] action=shutdown_cancel_active_workflows count=%d",
        len(active_tasks),
    )
    for project_id, task in list(project_tasks.items()):
        if not isinstance(task, asyncio.Task) or task.done():
            continue
        mark_workflow_task_explicit_cancel(task)
        task.cancel()

    try:
        await asyncio.wait_for(
            asyncio.shield(asyncio.gather(*active_tasks, return_exceptions=True)),
            timeout=WORKFLOW_SHUTDOWN_CANCEL_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logging.warning(
            "[ENGINE] action=shutdown_cancel_active_workflows status=timeout count=%d",
            len(active_tasks),
        )


async def _maintain_mcp_lease_worker(storage) -> None:
    """Publish worker liveness and release only leases abandoned by dead workers."""
    from tools.mcp_package_storage import (
        heartbeat_mcp_lease_worker,
        reconcile_expired_mcp_leases,
    )

    while True:
        try:
            await heartbeat_mcp_lease_worker(storage)
            await reconcile_expired_mcp_leases(storage)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logging.warning("[MCP_DELETE_LEASE] worker_maintenance_failed error=%s", exc)
        await asyncio.sleep(MCP_LEASE_WORKER_HEARTBEAT_SECONDS)


def _start_mcp_lease_worker_task(app: FastAPI, *, storage) -> asyncio.Task:
    task = asyncio.create_task(
        _maintain_mcp_lease_worker(storage), name="mcp-delete-lease-worker"
    )
    app.state.mcp_lease_worker_task = task
    return task


async def _stop_mcp_lease_worker_task(app: FastAPI) -> None:
    task = getattr(app.state, "mcp_lease_worker_task", None)
    if not isinstance(task, asyncio.Task) or task.done():
        return
    task.cancel()
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=2.0)
    except asyncio.TimeoutError:
        logging.warning("[MCP_DELETE_LEASE] worker_maintenance_cancel_timeout")
    except asyncio.CancelledError:
        pass
    except Exception:
        logging.exception("[MCP_DELETE_LEASE] worker_maintenance_failed")


def _project_event_persister(orchestrator, storage):
    async def _persist_event(evt):
        data = evt.get("data", {})
        pid = data.get("project_id")
        if not pid:
            return
        proj = orchestrator.active_projects.get(pid)
        if proj:
            await storage.save_project(pid, {
                "user_prompt": proj.get("user_prompt", ""),
                "title": proj.get("title", "Untitled Project"),
                "status": proj.get("status", "running"),
                "current_phase": proj.get("current_phase"),
                "approval_mode": proj.get("approval_mode", "human"),
                "created_at": proj.get("created_at"),
                "created_by": "system",
                "metadata": proj.get("metadata", {"phase": proj.get("current_phase")})
            })

    return _persist_event


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown logic"""
    print("🚀 Starting AppFactory...")
    logging.info("[SMOKE] app.startup")

    from orchestration.backend_boot import init_backend_boot

    boot_id = init_backend_boot()
    logging.info("[BOOT] backend_boot_id=%s", boot_id)
    
    load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env")
    
    # Version tracking from GitHub Actions
    build_version = os.getenv("BUILD_VERSION", "dev")
    build_sha = os.getenv("BUILD_SHA", "unknown")
    build_run = os.getenv("GITHUB_RUN_NUMBER", "local")
    print(f"📦 Build: #{build_run} ({build_sha[:8] if len(build_sha) > 8 else build_sha}) version={build_version}")
    logging.info(f"[BOOT] build_run={build_run} sha={build_sha} version={build_version}")
    
    # Environment flags
    prod_flag = os.getenv("DEPLOY_AGENT_PROD_ENABLED", "false")
    local_flag = os.getenv("DEPLOY_AGENT_LOCAL_ENABLED", "false")
    print(f"🚢 Deploy flags: PROD={prod_flag!r} LOCAL={local_flag!r}")
    
    # Initialize storage (MongoDB)
    mongodb_uri = os.getenv("MONGODB_URI") or "mongodb://localhost:27017"
    print("📊 Using MongoDB for storage")
    storage = MongoStorageBackend(
        connection_string=mongodb_uri,
        database=os.getenv("MONGODB_DATABASE", "AppFactory"),
        enable_transactions=os.getenv("MONGODB_ENABLE_TRANSACTIONS", "true").lower() == "true"
    )
    try:
        await storage.initialize()
        print("✅ MongoDB connection successful")
        await storage.ensure_indexes()
        print("Database indexes created")
        if hasattr(storage, "migrate_mcp_tools_to_dedicated_collection"):
            migrated = await storage.migrate_mcp_tools_to_dedicated_collection()
            if migrated:
                logging.info(
                    "[BOOT] migrated %d MCP tool(s) to tool_mcp_configurations",
                    migrated,
                )

        from tools.mcp_wizard_migrate import (
            prepare_mcp_wizard_storage,
        )

        migration_result = await prepare_mcp_wizard_storage(storage)
        if migration_result:
            logging.warning(
                "[BOOT] MCP wizard migration enabled packages=%d images=%d "
                "provenance_documents=%d tool_runtimes=%d",
                migration_result.packages,
                migration_result.images,
                migration_result.provenance_documents,
                migration_result.tool_runtimes_repaired,
            )

        from config.migration_runner import run_startup_migrations

        await run_startup_migrations(storage, sha=build_sha)

        from tools.mcp_package_storage import (
            heartbeat_mcp_lease_worker,
            reconcile_expired_mcp_leases,
            reconcile_orphaned_mcp_package_jobs,
        )

        try:
            reconciled = await reconcile_orphaned_mcp_package_jobs(storage)
            if reconciled:
                logging.warning(
                    "[BOOT] reconciled %d orphaned MCP package build job(s) after restart",
                    reconciled,
                )
        except Exception as exc:
            logging.warning("[BOOT] MCP package job reconcile failed: %s", exc)

        try:
            await heartbeat_mcp_lease_worker(storage)
            released_leases = await reconcile_expired_mcp_leases(storage)
            if any(released_leases.values()):
                logging.warning(
                    "[BOOT] reconciled abandoned MCP leases packages=%d images=%d writes=%d",
                    released_leases.get("package_deletions", 0),
                    released_leases.get("image_deletions", 0),
                    released_leases.get("image_writes", 0),
                )
        except Exception as exc:
            logging.warning("[BOOT] MCP lease reconcile failed: %s", exc)

        # Write version info to DB for tracking only when seed-controlled writes are enabled.
        await maybe_write_backend_version(
            storage,
            build_run=build_run,
            build_sha=build_sha,
            build_version=build_version,
            hostname=os.getenv("HOSTNAME", "unknown"),
        )
        try:
            from datetime import datetime, timezone

            await storage.db.system_info.update_one(
                {"_id": "backend_boot"},
                {
                    "$set": {
                        "boot_id": boot_id,
                        "started_at": datetime.now(timezone.utc),
                        "build_sha": build_sha,
                        "build_run": build_run,
                        "hostname": os.getenv("HOSTNAME", "unknown"),
                    }
                },
                upsert=True,
            )
        except Exception as exc:
            logging.warning("[BOOT] backend_boot system_info write failed: %s", exc)
        logging.info(f"[BOOT] version info written to DB: run={build_run}")
        seeded_run_configs = await seed_run_configurations(storage)
        if seeded_run_configs:
            logging.info("[BOOT] seeded %d run configurations", seeded_run_configs)
    except OperationFailure as e:
        print(f"❌ MongoDB authentication failed: {str(e)}")
        raise
    except ServerSelectionTimeoutError as e:
        print(f"❌ MongoDB connection timeout: {str(e)}")
        raise
    except Exception as e:
        print(f"❌ MongoDB connection failed: {str(e)}")
        raise
    
    # Initialize components
    llm_client = LLMClient(model_config_storage=storage)
    tool_registry = ToolRegistry()
    event_emitter = EventEmitter(storage_backend=storage)
    
    # Container manager
    container_enabled = os.getenv("CONTAINER_USE_ENABLED", "true").lower() == "true"
    container_cli_path = os.getenv("CONTAINER_USE_CLI_PATH", "cu")
    try:
        if (not container_cli_path or container_cli_path == "cu") and os.path.exists("/opt/cu/cu"):
            container_cli_path = "/opt/cu/cu"
    except Exception:
        pass
    from config.artifacts import get_repositories_root
    repositories_root = get_repositories_root()
    container_manager = ContainerManager(
        cli_path=container_cli_path,
        enabled=container_enabled,
        repositories_root=repositories_root,
    )
    external_mcp_manager = ExternalMCPServerManager(
        docker_binary=os.getenv("DOCKER_BINARY", "docker"),
        mcp_path=os.getenv("EXTERNAL_MCP_PATH", "/mcp"),
        idle_timeout_seconds=int(os.getenv("EXTERNAL_MCP_IDLE_TIMEOUT_SECONDS", "600")),
        sweep_interval_seconds=int(os.getenv("EXTERNAL_MCP_SWEEP_INTERVAL_SECONDS", "30")),
        host_port_start=int(os.getenv("EXTERNAL_MCP_HOST_PORT_START", "39000")),
        storage=storage,
    )
    await external_mcp_manager.start_lifecycle()

    # Initialize message store (before the executor: ask_human's park-time
    # journal recheck reads it)
    message_store = MessageStore(storage)
    await message_store.initialize()
    checkpoint_store = CheckpointStore(storage, message_store)
    await checkpoint_store.initialize()
    print("✅ Message store initialized")

    mcp_executor = MCPToolExecutor(
        container_manager,
        storage=storage,
        external_mcp_manager=external_mcp_manager,
        message_store=message_store,
    )

    deploy_service = DeployService(
        storage_backend=storage,
        event_emitter=event_emitter,
        container_manager=container_manager,
    )

    # Initialize artifact store (for DB-first file persistence). Pass
    # message_store so save_file can stamp checkpoint_sequence on every
    # write — required for revert_files_to_checkpoint to correctly
    # identify post-checkpoint artifacts.
    # One ArchiveStore shared by the spill (tool results + large file artifacts)
    # and hydrate (restore) paths, so they see the same S3 config and threshold cache.
    archive_store = ArchiveStore.from_env(storage)
    artifact_store = ArtifactStore(storage, message_store=message_store, archive_store=archive_store)
    await artifact_store.initialize()
    print("✅ Artifact store initialized")

    # Wire artifact + archive stores into container manager (auto-sync on write,
    # hydrate spilled files on recovery).
    container_manager.artifact_store = artifact_store
    container_manager.archive_store = archive_store
    
    print(f"🐳 Container execution: {'ENABLED' if container_enabled else 'DISABLED (simulated)'}")
    
    # Initialize orchestrator
    orchestrator = Orchestrator(
        storage_backend=storage,
        llm_client=llm_client,
        tool_registry=tool_registry,
        event_emitter=event_emitter,
        container_manager=container_manager,
        deploy_service=deploy_service,
        message_store=message_store,
        artifact_store=artifact_store,
        mcp_executor=mcp_executor,
    )

    # Load agents dynamically from MongoDB (seeds agents, workflows, tools from YAML/JSON on startup)
    agents = await load_agents_from_db(storage)

    # Load tool registry AFTER seeding — load_agents_from_db already called seed_tools(),
    # so all tools (including deploy_from_artifacts, detect_stack, analyze_and_repair)
    # are now in MongoDB before the registry is populated into memory.
    await tool_registry.load_from_db(storage)
    for agent in agents:
        orchestrator.register_agent(agent)
        agent.mcp_executor = mcp_executor
        try:
            agent.deploy_service = deploy_service
        except Exception:
            pass
    
    print(f"✅ Registered {len(orchestrator.agent_pool)} agents")
    print(f"✅ Loaded {tool_registry.get_stats()['total_tools']} tools")
    
    # Initialize project loader for lazy loading
    project_loader = ProjectLoader(
        storage_backend=storage,
        container_manager=container_manager,
        artifact_store=artifact_store,
        message_store=message_store,
        event_emitter=event_emitter,
    )
    await project_loader.startup_init()
    print("✅ Project loader initialized (lazy mode)")
    
    # Set global dependencies for routes
    deps.set_orchestrator(orchestrator)
    deps.set_storage(storage)
    deps.set_event_emitter(event_emitter)
    deps.set_container_manager(container_manager)
    deps.set_external_mcp_manager(external_mcp_manager)
    deps.set_deploy_service(deploy_service)
    deps.set_message_store(message_store)
    deps.set_project_loader(project_loader)
    deps.set_artifact_store(artifact_store)
    deps.set_agent_llm_calls_store(storage.agent_llm_calls_store)

    # Lazy startup: approval state now derived from messages on-demand
    # No need to recover approvals at startup - messages are the single source of truth
    print("✅ Lazy mode enabled - projects and approvals load on demand from messages")
    
    # Bootstrap: create default tenant + root user on first run (F5 auth)
    try:
        tenant_count = await storage.count_tenants()
        if tenant_count == 0:
            await storage.save_tenant({
                "_id": "__root__",
                "name": "Root",
                "enabled": True,
            })
            # B3: Create default tenant_settings (keys filled via API/Postman)
            existing_settings = await storage.get_tenant_settings("__root__")
            if not existing_settings:
                await storage.save_tenant_settings({
                    "_id": "__root__",
                    "llm_provider": "bifrost",
                    "bifrost_vk": None,
                    "openai_api_key": None,
                    "bifrost_url": None,
                    "bifrost_provider": "openrouter",
                    "default_model": None,
                    "max_concurrent_projects": 5,
                    "enabled": True,
                })
            print("✅ Created root tenant '__root__'")
        
        user_count = await storage.count_users()
        if user_count == 0:
            root_email = os.getenv("AppFactory_ROOT_EMAIL")
            root_password = os.getenv("AppFactory_ROOT_PASSWORD")
            if root_email and root_password:
                from api.auth.utils import hash_password
                import uuid
                await storage.save_user({
                    "_id": str(uuid.uuid4()),
                    "email": root_email,
                    "name": "Root Admin",
                    "password_hash": hash_password(root_password),
                    "role": "root",
                    "tenant_id": "__root__",
                    "enabled": True,
                    "created_at": datetime.utcnow().isoformat(),
                    "created_by": "system",
                    "last_login": None,
                })
                print(f"✅ Root account created: {root_email}")
            else:
                print("⚠️  No AppFactory_ROOT_EMAIL/PASSWORD set — running without auth bootstrap (dev mode)")
    except Exception as e:
        logging.warning(f"Auth bootstrap failed (non-fatal): {e}")
    
    # Show agent overview
    print("\n🤖 Agent Overview:")
    for agent in agents:
        agent_type = agent.agent_type.value if hasattr(agent.agent_type, 'value') else str(agent.agent_type)
        print(f"  • {agent.agent_id} ({agent_type})")
        allowed = getattr(agent, "_effective_allowed_tools", None) or getattr(agent, "allowed_tools", None) or []
        if allowed:
            allow = set(allowed)
            available_tools = [t for t in tool_registry.tools if t["tool_id"] in allow]
        else:
            available_tools = []
        if available_tools:
            tool_names = [t["name"] for t in available_tools[:5]]
            more = f" +{len(available_tools) - 5} more" if len(available_tools) > 5 else ""
            print(f"    Tools: {', '.join(tool_names)}{more}")
    
    print("\n✅ AppFactory ready!")

    # Register event callbacks for persistence
    _persist_event = _project_event_persister(orchestrator, storage)

    async def _snapshot_final_logs(evt):
        try:
            data = evt.get("data", {})
            pid = data.get("project_id")
            if not pid or not container_manager:
                return
            env_id = None
            try:
                status = await container_manager.get_container_status(pid)
                env_id = status.get("environment_id")
            except Exception:
                pass
            try:
                res = await container_manager.get_logs(project_id=pid, environment_id=env_id)
                if storage:
                    max_len = 20000
                    out = (res.get("stdout") or "")
                    err = (res.get("stderr") or "")
                    truncated = False
                    if len(out) > max_len:
                        out = out[-max_len:]
                        truncated = True
                    if len(err) > 1000:
                        err = err[-1000:]
                        truncated = True or truncated
                    await storage.save_container_log(pid, "log_snapshot_final", {
                        "environment_id": env_id,
                        "exit_code": res.get("exit_code", 0),
                        "stdout": out,
                        "stderr": err,
                        "truncated": truncated,
                        "source": evt.get("type")
                    })
            except Exception:
                pass
        except Exception:
            pass
    
    event_emitter.register_callback("project_started", _persist_event)
    # NOTE: phase persistence is enumerated here because EventEmitter does
    # not support wildcards (events/emitter.py:112 uses exact dict lookup).
    # Workflow-defined phases not listed below won't be persisted as system
    # messages — they'll still flow live via SSE but disappear on refresh.
    # TODO: add prefix-match support to register_callback so `phase.*.completed`
    # can be subscribed once; until then, list every phase_label the workflow
    # might emit.
    event_emitter.register_callback("phase.requirements.completed", _persist_event)
    event_emitter.register_callback("phase.planning.completed", _persist_event)
    event_emitter.register_callback("phase.execution.completed", _persist_event)
    event_emitter.register_callback("phase.deployment.completed", _persist_event)
    event_emitter.register_callback("project_completed", _persist_event)
    event_emitter.register_callback("project_failed", _persist_event)
    event_emitter.register_callback("phase.execution.completed", _snapshot_final_logs)
    event_emitter.register_callback("project_completed", _snapshot_final_logs)
    event_emitter.register_callback("project_failed", _snapshot_final_logs)

    _start_zip_mcp_recovery_task(
        app,
        storage=storage,
        manager=external_mcp_manager,
    )
    _start_mcp_lease_worker_task(app, storage=storage)
    _start_a2a_recovery_task(app, orchestrator=orchestrator)
    await orchestrator.recover_a2a_cancellation_deliveries()
    _start_a2a_cancellation_recovery_task(app, orchestrator=orchestrator)
    yield

    # Shutdown
    print("🛑 Shutting down AppFactory...")

    await _stop_active_workflow_tasks(orchestrator)
    await orchestrator.stop_a2a_cancellation_delivery_tasks()

    await _stop_zip_mcp_recovery_task(app)
    await _stop_mcp_lease_worker_task(app)
    await _stop_a2a_recovery_task(app)
    await _stop_a2a_cancellation_recovery_task(app)
    
    if event_emitter:
        try:
            await asyncio.wait_for(event_emitter.shutdown(), timeout=2.0)
            print("✅ Event streams closed")
        except asyncio.TimeoutError:
            print("⚠️  Event emitter shutdown timed out")
        except Exception as e:
            print(f"⚠️  Error shutting down event emitter: {e}")
    
    try:
        if container_manager:
            await asyncio.wait_for(
                container_manager.close_all(keep_for_review=True),
                timeout=5.0
            )
            print("📦 Containers kept for review.")
    except asyncio.TimeoutError:
        print("⚠️  Container cleanup timed out - forcing shutdown")
    except Exception as e:
        print(f"⚠️  Error during container cleanup: {e}")

    try:
        if external_mcp_manager:
            await asyncio.wait_for(external_mcp_manager.stop_lifecycle(), timeout=5.0)
    except asyncio.TimeoutError:
        print("⚠️  External MCP lifecycle shutdown timed out")
    except Exception as e:
        print(f"⚠️  Error during external MCP lifecycle shutdown: {e}")

    try:
        await asyncio.wait_for(A2AClientFactory.close_all(), timeout=5.0)
        print("✅ Closed all A2A clients")
    except asyncio.TimeoutError:
        print("⚠️  A2A client shutdown timed out")
    except Exception as e:
        print(f"⚠️  Error during A2A client shutdown: {e}")
    
    if storage:
        await storage.close()


# Create app
app = FastAPI(
    title="AppFactory API",
    description="Multi-agent orchestration system",
    version="0.1.0",
    lifespan=lifespan,
    openapi_url="/api/openapi.json",
)

# CORS middleware
raw_origins = os.getenv("CORS_ALLOW_ORIGINS")
if not raw_origins:
    raw_origins = os.getenv("WEB_URL")
if not raw_origins:
    web_host = os.getenv("WEB_HOST")
    if web_host:
        scheme = os.getenv("WEB_SCHEME", "https")
        raw_origins = f"{scheme}://{web_host}"
allow_origins = [o.strip() for o in (raw_origins or "").split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(health_router)
app.include_router(projects_router)
app.include_router(approvals_router)
app.include_router(control_router)
app.include_router(runs_router)
app.include_router(run_configurations_router)
app.include_router(deployments_router)
app.include_router(events_router)
app.include_router(admin_router)
app.include_router(messages_router)
app.include_router(settings_router)
app.include_router(auth_router)
app.include_router(tenant_router)
app.include_router(agent_configurations_router)
app.include_router(workflow_definitions_router)
app.include_router(configuration_phases_router)
app.include_router(tool_configurations_router)
app.include_router(agents_router)
app.include_router(mcp_tool_configurations_router)
app.include_router(config_bundle_router)
app.include_router(agent_llm_calls_router)
app.include_router(execution_trace_router)
app.include_router(a2a_configurations_router)
app.include_router(checkpoints_router)
app.include_router(human_input_router)
app.include_router(a2a_human_input_router)
app.include_router(archive_router)
app.include_router(file_attachments_router)
app.include_router(tenant_artifacts_router)

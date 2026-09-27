"""Project CRUD routes"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from api.auth.middleware import require_auth
from pydantic import BaseModel
from llm.agent_model_params import AgentModelParamsValidationError
from typing import Any, List, Literal, Optional
import logging
import os

from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import verify_project_tenant
from api.auth.tenant_key_resolver import resolve_tenant_llm_key
from api.deps import (
    get_orchestrator,
    get_storage,
    get_event_emitter,
    get_container_manager,
    get_project_loader,
    get_artifact_store,
    get_message_store,
)
from schemas.project_listing import PROJECT_LIST_DEFAULT_SORT, PROJECT_LIST_SORT_FIELDS
from telemetry.tracer import create_task_with_context
from api.routes.file_attachments import (
    load_public_user_attachments,
    parse_create_payload,
    prepare_send_files,
    resolve_send_content,
    save_message_attachments,
)
from api.routes.file_attachment_events import emit_attachment_uploaded
from api.routes.project_creator import attach_creators, project_creator
from api.routes.project_launch import project_launch_fields

router = APIRouter(prefix="/api/projects", tags=["projects"], dependencies=[Depends(require_auth)])


def _legacy_context_artifacts(context: Optional[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return legacy context artifacts for backward compatibility."""
    if not isinstance(context, dict):
        return []
    artifacts = context.get("artifacts")
    if not isinstance(artifacts, list):
        return []
    return [artifact for artifact in artifacts if isinstance(artifact, dict) and artifact.get("path")]


async def _load_user_attachments_for_project(
    storage, db_project: dict | None, project_id: str
) -> tuple[list[dict], bool]:
    tenant_id = str((db_project or {}).get("tenant_id") or "")
    try:
        return await load_public_user_attachments(
            storage=storage,
            tenant_id=tenant_id,
            project_id=project_id,
        )
    except Exception:
        logging.warning("[ATTACH] list failed project=%s - Artifacts folder omitted", project_id)
        return [], False


async def _revert_files_only_create_prompt(
    *,
    orchestrator,
    storage,
    project_id: str,
    original_user_prompt: str,
    actor_id: str | None,
) -> None:
    """Undo files-only stub after failed attachment save (top-level + context + runtime)."""
    existing = await storage.load_project(project_id)
    if existing:
        revert_data = dict(existing)
        revert_data["user_prompt"] = original_user_prompt
        await storage.save_project(project_id, revert_data, actor_id=actor_id)

    runtime = None
    active = getattr(orchestrator, "active_projects", None)
    if isinstance(active, dict):
        runtime = active.get(project_id)
    if isinstance(runtime, dict):
        runtime["user_prompt"] = original_user_prompt
        sc = runtime.get("shared_context")
        if sc is not None and hasattr(sc, "import_state"):
            await sc.import_state({"user_prompt": original_user_prompt})
            return

    # No live SharedContext: still clear durable projects.context.user_prompt.
    updater = getattr(storage, "update_context_field", None)
    if callable(updater):
        await updater(project_id, "user_prompt", original_user_prompt)


async def _load_project_artifacts(
    project_id: str,
    artifact_store,
    legacy_context: Optional[dict[str, Any]] = None,
) -> list[dict[str, Any]]:
    """Load project artifacts from ArtifactStore, with legacy-context fallback."""
    if artifact_store:
        try:
            artifacts = await artifact_store.get_all_files(project_id)
            if isinstance(artifacts, list) and artifacts:
                logging.info(
                    "[PROJECTS] artifacts loaded project_id=%s source=db count=%d",
                    project_id, len(artifacts),
                )
                return artifacts
            logging.info(
                "[PROJECTS] artifacts store returned empty project_id=%s returned_type=%s len=%s",
                project_id,
                type(artifacts).__name__,
                (len(artifacts) if isinstance(artifacts, list) else "n/a"),
            )
        except Exception as e:
            logging.warning(
                "[PROJECTS] failed to load artifacts from ArtifactStore project_id=%s err=%s",
                project_id,
                e,
            )
    else:
        logging.info(
            "[PROJECTS] artifact_store=None project_id=%s",
            project_id,
        )

    legacy = _legacy_context_artifacts(legacy_context)
    logging.info(
        "[PROJECTS] artifacts fallback project_id=%s source=legacy count=%d",
        project_id, len(legacy),
    )
    return legacy


class ReasoningConfig(BaseModel):
    enabled: bool = False
    effort: Optional[str] = None


class ProjectCreate(BaseModel):
    user_prompt: str
    # None = "not chosen" → start_project resolves run config's value, else human.
    approval_mode: Optional[Literal["human", "auto"]] = None
    model_id: Optional[str] = None  # Base fallback model when run configuration lacks a value
    workflow_id: Optional[str] = None  # Which workflow to run (defaults to "default_build")
    run_config_id: Optional[str] = None
    force_model: Optional[bool] = False  # When True, model_id wins over run_config entries for every subsystem
    reasoning: Optional[ReasoningConfig] = None  # When `enabled`, `effort` overrides per-agent reasoning_effort
    temperature: Optional[float] = None  # Project-wide temperature override, same precedence tier as `reasoning`

def _resolve_reasoning_effort(reasoning: Optional[ReasoningConfig]) -> Optional[str]:
    """Pick the project-level reasoning effort override from the create payload.

    This layer only normalizes the optional string. The effective agent/model
    resolver validates it against each selected model's catalog contract.
    """
    if reasoning is None or not reasoning.enabled:
        return None
    effort = (reasoning.effort or "").strip().lower()
    return effort or None


class ProjectResponse(BaseModel):
    project_id: str
    status: str
    user_prompt: str
    title: Optional[str] = None


@router.get("/meta")
async def get_project_metadata(
    status: Optional[str] = Query(None),
    current_phase: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    workflow_id: Optional[str] = Query(None),
    run_config_id: Optional[str] = Query(None),
    tenant_id: Optional[str] = Query(None),
    created_from: Optional[datetime] = Query(None),
    created_to: Optional[datetime] = Query(None),
    updated_from: Optional[datetime] = Query(None),
    updated_to: Optional[datetime] = Query(None),
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Return tenant-scoped project facets without project documents."""
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")

    scoped_tenant_id = tenant_id if tenant_ctx.is_root else tenant_ctx.tenant_id
    return await storage.list_project_facets(
        tenant_id=scoped_tenant_id,
        status=status,
        current_phase=current_phase,
        q=q,
        workflow_id=workflow_id,
        run_config_id=run_config_id,
        created_from=created_from,
        created_to=created_to,
        updated_from=updated_from,
        updated_to=updated_to,
    )


@router.post("", response_model=ProjectResponse)
async def create_project(
    request: Request,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Create a new project from user prompt."""
    orchestrator = get_orchestrator()
    storage = get_storage()
    event_emitter = get_event_emitter()
    container_manager = get_container_manager()
    
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")

    project, files = await parse_create_payload(request)
    original_user_prompt = project.user_prompt
    if files:
        files = prepare_send_files(files)
        project = project.model_copy(
            update={"user_prompt": resolve_send_content(project.user_prompt, files)}
        )

    # Tenant guard for execution. A project runs entirely under the caller's
    # tenant: agent pool, MCP tool resolution (tool_registry._tool_matches_tenant)
    # and data are all scoped to it. Starting another tenant's workflow clones
    # the agents by _id (get_agent_configuration is not tenant-scoped) but then
    # dies mid-run when tenant-scoped MCP tools resolve to nothing ("No tool
    # schemas available for tool-enabled agent"). Reject up front so no run is
    # wasted. __system__ / unscoped workflows stay shared. Unlike workflow READ
    # visibility (which lets root see every tenant), this binds root too: to run
    # a tenant's workflow you must act under that tenant.
    if project.workflow_id and storage:
        wf = await storage.get_workflow_definition(
            project.workflow_id,
            tenant_id=str(tenant_ctx.tenant_id),
        )
        wf_tenant = wf.get("tenant_id") if wf else None
        if wf and wf_tenant not in (tenant_ctx.tenant_id, "__system__", None):
            raise HTTPException(
                status_code=403,
                detail=(
                    f"Workflow '{project.workflow_id}' belongs to tenant "
                    f"'{wf_tenant}'. You are acting in tenant "
                    f"'{tenant_ctx.tenant_id}'. Sign in as a user of tenant "
                    f"'{wf_tenant}' to run it."
                ),
            )

    try:
        logging.info("[SMOKE] create_project.begin prompt_len=%d", len(project.user_prompt or ""))
        
        # Debug logging
        try:
            headers = dict(request.headers)
            origin = headers.get("origin") or headers.get("Origin")
            referer = headers.get("referer") or headers.get("Referer")
            host = headers.get("host") or headers.get("Host")
            print(f"?? POST /api/projects headers: origin={origin} referer={referer} host={host}")
            print(
                f"?? Container settings: enabled={(container_manager.enabled if container_manager else None)} "
                f"cli_path={(container_manager.cli_path if container_manager else None)} "
                f"DOCKER_HOST={os.getenv('DOCKER_HOST')}"
            )
        except Exception:
            pass
        
        override_key = request.headers.get("x-bf-vk")
        model_override = project.model_id
        fallback_models_override: Optional[List[str]] = None

        # If no explicit header override, resolve from tenant_settings
        if not override_key:
            tenant_id = tenant_ctx.tenant_id
            if not tenant_id:
                raise HTTPException(status_code=401, detail="Tenant context is required")
            tenant_key, tenant_model, fallback_models_override = await resolve_tenant_llm_key(storage, tenant_id)
            if tenant_key:
                override_key = tenant_key
            if not model_override and tenant_model:
                model_override = tenant_model

        # Lenient resolution: when both model_id and run_config_id are sent
        # without an explicit force_model flag, the model wins. The unified
        # picker in the UI sends only one, but direct API callers and old
        # clients sending both should get a predictable, force-equivalent path.
        force_model_resolved = bool(project.force_model)
        if model_override and project.run_config_id and not force_model_resolved:
            force_model_resolved = True

        reasoning_effort = _resolve_reasoning_effort(project.reasoning)

        project_id = await orchestrator.start_project(
            project.user_prompt,
            approval_mode=project.approval_mode,
            api_key_override=override_key,
            model_override=model_override,
            fallback_models_override=fallback_models_override,
            force_model=force_model_resolved,
            workflow_id=project.workflow_id,
            tenant_id=tenant_ctx.tenant_id,
            run_config_id=project.run_config_id,
            reasoning_effort=reasoning_effort,
            temperature=project.temperature,
            created_by=tenant_ctx.user_id,
        )
        
        logging.info("[SMOKE] create_project.end project_id=%s", project_id)
        print(f"? Project created: id={project_id}")
        
        project_data = orchestrator.active_projects[project_id]
        project_title = project_data.get("title", "Untitled Project")
        
        # Save project immediately (tenant_id stamped from request context if available)
        save_data = {
            "user_prompt": project.user_prompt,
            "title": project_title,
            "status": "started",
            "current_phase": "requirements",
            "approval_mode": project_data.get("approval_mode", "human"),
            "model_id": project_data.get("model_id") or project.model_id,
            "force_model": bool(project_data.get("force_model")),
            "reasoning_effort": project_data.get("reasoning_effort"),
            "temperature": project_data.get("temperature"),
            "workflow_id": project_data.get("workflow_id"),
            "run_config_id": project.run_config_id,
            "created_at": project_data["created_at"],
            "metadata": {"phase": "requirements"},
        }
        # Stamp tenant_id from auth header if present
        tenant_id = tenant_ctx.tenant_id
        if tenant_id:
            save_data["tenant_id"] = tenant_id
        await storage.save_project(project_id, save_data, actor_id=tenant_ctx.user_id)

        if files:
            initial = None
            message_store = get_message_store()
            if message_store:
                try:
                    user_msgs = await message_store.get_messages(
                        project_id, limit=1, only_types=["user"]
                    )
                    initial = user_msgs[0] if user_msgs else None
                except Exception:
                    initial = None
            try:
                docs = await save_message_attachments(
                    storage=storage,
                    tenant_id=str(tenant_ctx.tenant_id or ""),
                    project_id=project_id,
                    files=files,
                    message_id=(initial or {}).get("id"),
                    message_sequence=(initial or {}).get("sequence"),
                    run_id=project_data.get("run_id"),
                    created_by=tenant_ctx.user_id,
                )
                for doc in docs:
                    await emit_attachment_uploaded(
                        project_id=project_id,
                        tenant_id=str(tenant_ctx.tenant_id or ""),
                        doc=doc,
                        run_id=project_data.get("run_id"),
                        message_id=(initial or {}).get("id"),
                    )
            except HTTPException as exc:
                # R2: never delete the project; mirror send_message rollback on fail.
                if message_store and initial and initial.get("id"):
                    await message_store.delete_message_in_project(
                        project_id, initial["id"]
                    )
                    logging.warning(
                        "[ATTACH] create rolled back message=%s project=%s",
                        initial["id"],
                        project_id,
                    )
                if files and project.user_prompt != original_user_prompt:
                    await _revert_files_only_create_prompt(
                        orchestrator=orchestrator,
                        storage=storage,
                        project_id=project_id,
                        original_user_prompt=original_user_prompt,
                        actor_id=tenant_ctx.user_id,
                    )
                logging.warning(
                    "[ATTACH] create files failed project=%s - project kept, workflow not started",
                    project_id,
                )
                raise HTTPException(
                    status_code=exc.status_code,
                    detail={"error": exc.detail, "project_id": project_id},
                ) from exc
        
        # Start workflow in background
        async def run_workflow_with_error_handling():
            try:
                await orchestrator.run_workflow(project_id)
            except Exception as e:
                import traceback
                error_details = traceback.format_exc()
                print(f"? WORKFLOW ERROR for {project_id}:\n{error_details}")
                raise
        
        t = create_task_with_context(run_workflow_with_error_handling())
        try:
            orchestrator.register_workflow_task(project_id, t)
        except Exception as exc:
            logging.warning(
                "[PROJECTS] project_id=%s register_workflow_task failed: %s",
                project_id,
                exc,
            )
            t.cancel()
        
        return ProjectResponse(
            project_id=project_id,
            status="started",
            user_prompt=project.user_prompt,
            title=project_title
        )
    except AgentModelParamsValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.to_detail()) from exc
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"? create_project failed: {e}\n{tb}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{project_id}")
async def get_project(
    project_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Get project status and details with lazy loading support."""
    orchestrator = get_orchestrator()
    storage = get_storage()
    container_manager = get_container_manager()
    project_loader = get_project_loader()
    artifact_store = get_artifact_store()
    
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")

    db_project = await storage.load_project(project_id)
    await verify_project_tenant(db_project, tenant_ctx)
    creator = await project_creator(storage, db_project)
    launch = await project_launch_fields(storage, db_project)
    user_attachments, user_attachments_truncated = await _load_user_attachments_for_project(
        storage, db_project, project_id
    )

    # Page-load is the primary trigger for workflow rehydration after a
    # backend restart - the runtime is in-memory only and does not survive.
    # ensure_workflow_running is idempotent and a no-op when the runtime is
    # already parked or when no gate is pending; mid-phase parks are not
    # rehydrated by design (see orchestrator.ensure_workflow_running docstring).
    try:
        await orchestrator.ensure_workflow_running(project_id, project_doc=db_project)
    except Exception:
        # Rehydration failures must not break project read.
        pass

    # Resolve the currently-active run id from storage. The runs collection is
    # the source of truth (set by activate_run); the in-memory project dict's
    # `run_id` field can lag - e.g. activate_run swaps shared_context but
    # didn't previously update proj["run_id"]. The frontend reads this to
    # scope event/message SSE subscriptions per run; without it, the UI mixes
    # events from different runs on fork/multi-run projects.
    current_run_id: Optional[str] = None
    try:
        active_run = await storage.get_active_run(project_id)
        if active_run:
            current_run_id = active_run.get("run_id")
    except Exception:
        current_run_id = None

    project = orchestrator.active_projects.get(project_id)
    
    if project:
        shared_context = project["shared_context"]
        artifacts = await _load_project_artifacts(
            project_id,
            artifact_store,
            {"artifacts": shared_context.get("artifacts", [])},
        )

        def _jsonable(value):
            try:
                v = getattr(value, "value", value)
            except Exception:
                v = value
            if isinstance(v, dict):
                return {str(k): _jsonable(val) for k, val in v.items()}
            if isinstance(v, (list, tuple)):
                return [_jsonable(x) for x in v]
            return v

        pending_approvals = []
        try:
            for a in (orchestrator.pending_approvals or {}).values():
                if not isinstance(a, dict):
                    continue
                if a.get("project_id") != project_id:
                    continue
                st = a.get("status")
                if st == "pending" or getattr(st, "value", None) == "pending":
                    pending_approvals.append(_jsonable(a))
        except Exception:
            pending_approvals = []

        # Hydrate context_snapshot.artifacts per pa run_id. The in-memory
        # pending_approvals dict can hold a frozen message_store snapshot in
        # the rehydration path (ensure_workflow_running plants the raw DB doc
        # at orchestrator.py:293, and workflow_engine._handle_approval_gate's
        # marker shortcut bypasses request_approval - so the fresh artifacts
        # it built at :543-551 are never stored). Mirror the lazy and DB-
        # fallback branches by hydrating empty snapshots at response time
        # with files scoped to the approval's own run_id.
        cache: dict[Optional[str], list] = {}
        for pa in pending_approvals:
            if not isinstance(pa, dict):
                continue
            data = pa.get("data")
            if not isinstance(data, dict):
                continue
            snap = data.get("context_snapshot")
            if not isinstance(snap, dict) or snap.get("artifacts"):
                continue
            pa_run_id = pa.get("run_id")
            if pa_run_id not in cache:
                if artifact_store is not None:
                    try:
                        cache[pa_run_id] = await artifact_store.get_all_files(project_id, run_id=pa_run_id) or []
                    except Exception:
                        cache[pa_run_id] = list(artifacts or [])
                else:
                    cache[pa_run_id] = list(artifacts or [])
            if cache[pa_run_id]:
                snap["artifacts"] = cache[pa_run_id]

        cu_status = (
            await container_manager.get_container_status(project_id)
            if container_manager
            else {}
        )
        lockout = None
        if container_manager is not None:
            lockout = container_manager.session_unavailable_reason(project_id)
        # Session lockout after failed timeout/recover must surface the banner
        # even while the project is still in active_projects. Inactive session
        # with stored files matches the lazy-load needs_container_recovery rule.
        needs_recovery = bool(lockout) or (
            not bool(cu_status.get("active")) and len(artifacts or []) > 0
        )
        return {
            "project_id": project_id,
            "status": project["status"],
            "current_phase": project.get("current_phase"),
            "user_prompt": project["user_prompt"],
            "title": project.get("title", "Untitled Project"),
            **launch,
            "creator": creator,
            "version": project.get("version", 1),
            "metadata": project.get("metadata", {}),
            "requirements": shared_context.get("requirements"),
            "plan": shared_context.get("plan"),
            "artifacts": artifacts,
            "user_attachments": user_attachments,
            "user_attachments_truncated": user_attachments_truncated,
            "deploy_status": shared_context.get("deploy_status", "not_started"),
            "deploy_error": shared_context.get("deploy_error"),
            "deployments": shared_context.get("deployments", []),
            "pending_approvals": pending_approvals,
            "current_run_id": current_run_id or project.get("run_id"),
            "container_ready": bool(cu_status.get("active")) and not lockout,
            "needs_recovery": needs_recovery,
            "needs_container_recovery": needs_recovery,
            "artifact_count": len(artifacts or []),
            **cu_status,
        }
    
    # Project not in memory - use lazy loading if available
    if project_loader and storage:
        try:
            state = await project_loader.load_project(project_id)
            loader_status = project_loader.get_project_status(project_id)
            artifacts = state.artifacts or await _load_project_artifacts(
                project_id,
                artifact_store,
                state.context,
            )

            # Same artifact hydration as the DB-loaded branch below - lazy
            # loader returns frozen approval rows from the message store, so
            # an empty context_snapshot.artifacts hides the live file list.
            # Per-run cache: each pa carries its own run_id and the original
            # gate snapshot (workflow_engine._handle_approval_gate) was scoped
            # to that run. Project-wide `artifacts` (deduped across all runs)
            # is the fallback when artifact_store is unavailable; it preserves
            # legacy behavior for the single-run case.
            if isinstance(state.approvals, list):
                cache: dict[Optional[str], list] = {}
                for pa in state.approvals:
                    if not isinstance(pa, dict):
                        continue
                    data = pa.get("data")
                    if not isinstance(data, dict):
                        continue
                    snap = data.get("context_snapshot")
                    if not isinstance(snap, dict) or snap.get("artifacts"):
                        continue
                    pa_run_id = pa.get("run_id")
                    if pa_run_id not in cache:
                        if artifact_store is not None:
                            try:
                                cache[pa_run_id] = await artifact_store.get_all_files(project_id, run_id=pa_run_id) or []
                            except Exception:
                                cache[pa_run_id] = list(artifacts or [])
                        else:
                            cache[pa_run_id] = list(artifacts or [])
                    if cache[pa_run_id]:
                        snap["artifacts"] = cache[pa_run_id]

            return {
                "project_id": project_id,
                "status": state.project.get("status", "completed"),
                "current_phase": state.project.get("current_phase"),
                "user_prompt": state.project.get("user_prompt", ""),
                "title": state.project.get("title", "Untitled Project"),
                **launch,
                "creator": creator,
                "version": state.project.get("version", 1),
                "metadata": state.project.get("metadata", {}),
                "requirements": state.context.get("requirements"),
                "plan": state.context.get("plan"),
                "artifacts": artifacts,
            "user_attachments": user_attachments,
            "user_attachments_truncated": user_attachments_truncated,
                "deploy_status": state.context.get("deploy_status", "not_started"),
                "deploy_error": state.context.get("deploy_error"),
                "deployments": state.context.get("deployments", []),
                "pending_approvals": state.approvals,
                "current_run_id": current_run_id,
                "environment_id": None,
                "repo_path": None,
                # Lazy loading / recovery status
                "container_ready": state.container_ready,
                "deployment_ready": state.deployment_ready,
                "needs_container_recovery": state.needs_container_recovery,
                "needs_deployment_recovery": state.needs_deployment_recovery,
                "needs_recovery": loader_status.get("needs_recovery", False) or state.needs_container_recovery,
                "recovery_prompt": loader_status.get("recovery_prompt"),
                "artifact_count": len(artifacts),
            }
        except Exception as e:
            logging.warning(f"Lazy loading failed for {project_id}: {e}")
            # Fall back to direct DB access
    
    # Fallback: direct DB access
    if storage:
        db_project = await storage.load_project(project_id)
        if db_project:
            ctx = await storage.load_context(project_id)
            metadata = db_project.get("metadata", {})
            artifacts = await _load_project_artifacts(project_id, artifact_store, ctx)

            pending_approvals = []
            try:
                # Get pending approvals from messages collection (SINGLE SOURCE OF TRUTH)
                message_store = get_message_store()
                if message_store:
                    pending_approvals = await message_store.get_pending_approvals_for_project(project_id)
            except Exception:
                pending_approvals = []

            # Hydrate context_snapshot.artifacts on PENDING approvals with the
            # live artifact list, run-scoped to the approval's own run_id (matches
            # workflow_engine._handle_approval_gate's get_all_files(project_id,
            # run_id=run_id) at gate-emit time). The snapshot baked into the
            # message at gate creation can be empty (older bug, or pre-snapshot
            # timing window) - the user is reviewing the *current* output. The
            # project-wide `artifacts` list (deduped across runs) stays as the
            # fallback when artifact_store is unavailable or the call raises.
            # Resolved approvals are left untouched so the audit trail of
            # what-was-approved-when stays accurate (get_pending_approvals_for_project
            # already pre-filters to status=pending).
            cache: dict[Optional[str], list] = {}
            for pa in pending_approvals:
                if not isinstance(pa, dict):
                    continue
                data = pa.get("data")
                if not isinstance(data, dict):
                    continue
                snap = data.get("context_snapshot")
                if not isinstance(snap, dict) or snap.get("artifacts"):
                    continue
                pa_run_id = pa.get("run_id")
                if pa_run_id not in cache:
                    if artifact_store is not None:
                        try:
                            cache[pa_run_id] = await artifact_store.get_all_files(project_id, run_id=pa_run_id) or []
                        except Exception:
                            cache[pa_run_id] = list(artifacts or [])
                    else:
                        cache[pa_run_id] = list(artifacts or [])
                if cache[pa_run_id]:
                    snap["artifacts"] = cache[pa_run_id]

            artifact_count = len(artifacts)

            return {
                "project_id": project_id,
                "status": db_project.get("status", "completed"),
                "current_phase": db_project.get("current_phase") or metadata.get("phase"),
                "user_prompt": db_project.get("user_prompt", ""),
                "title": db_project.get("title", "Untitled Project"),
                **launch,
                "creator": creator,
                "version": db_project.get("version", 1),
                "metadata": metadata,
                "requirements": (ctx or {}).get("requirements") if ctx else None,
                "plan": (ctx or {}).get("plan") if ctx else None,
                "artifacts": artifacts,
            "user_attachments": user_attachments,
            "user_attachments_truncated": user_attachments_truncated,
                "deploy_status": (ctx or {}).get("deploy_status", "not_started"),
                "deploy_error": (ctx or {}).get("deploy_error"),
                "deployments": (ctx or {}).get("deployments", []),
                "pending_approvals": pending_approvals,
                "current_run_id": current_run_id,
                "environment_id": None,
                "repo_path": None,
                "container_ready": False,
                "needs_recovery": artifact_count > 0,
                "needs_container_recovery": artifact_count > 0,
                "artifact_count": artifact_count,
            }
    
    raise HTTPException(status_code=404, detail="Project not found")


@router.post("/{project_id}/recover")
async def recover_project(
    project_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """
    Recover project container from stored artifacts.
    
    Creates a fresh container and restores all files from DB.
    Enables continued coding workflow after recovery.
    """
    project_loader = get_project_loader()
    storage = get_storage()
    
    if not project_loader:
        raise HTTPException(status_code=500, detail="Project loader not initialized")
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")

    db_project = await storage.load_project(project_id)
    await verify_project_tenant(db_project, tenant_ctx)
    
    try:
        result = await project_loader.recover_container(project_id)
        return {
            "project_id": project_id,
            **result,
        }
    except Exception as e:
        logging.error(f"Recovery failed for {project_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Recovery failed: {str(e)}")


@router.get("/{project_id}/recovery-status")
async def get_recovery_status(
    project_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Get recovery status for a project."""
    project_loader = get_project_loader()
    storage = get_storage()
    
    if not project_loader:
        raise HTTPException(status_code=500, detail="Project loader not initialized")
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")

    db_project = await storage.load_project(project_id)
    await verify_project_tenant(db_project, tenant_ctx)
    
    return project_loader.get_project_status(project_id)


@router.get("")
async def list_projects(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    status: Optional[str] = Query(None),
    current_phase: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    workflow_id: Optional[str] = Query(None),
    run_config_id: Optional[str] = Query(None),
    tenant_id: Optional[str] = Query(None),
    created_from: Optional[datetime] = Query(None),
    created_to: Optional[datetime] = Query(None),
    updated_from: Optional[datetime] = Query(None),
    updated_to: Optional[datetime] = Query(None),
    sort_by: str = Query(PROJECT_LIST_DEFAULT_SORT),
    sort_dir: str = Query("desc", pattern="^(asc|desc)$"),
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """List projects with backend pagination, filters, sorting, and tenant scope."""
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")

    if sort_by not in PROJECT_LIST_SORT_FIELDS:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid sort_by '{sort_by}'. Must be one of: {sorted(PROJECT_LIST_SORT_FIELDS)}",
        )

    scoped_tenant_id = tenant_id if tenant_ctx.is_root else tenant_ctx.tenant_id
    page = await storage.list_projects(
        limit=limit,
        offset=offset,
        tenant_id=scoped_tenant_id,
        status=status,
        current_phase=current_phase,
        q=q,
        workflow_id=workflow_id,
        run_config_id=run_config_id,
        created_from=created_from,
        created_to=created_to,
        updated_from=updated_from,
        updated_to=updated_to,
        sort_by=sort_by,
        sort_dir=sort_dir,
    )
    await attach_creators(storage, page["projects"])

    for item in page["projects"]:
        if not item.get("title"):
            metadata = item.get("metadata", {})
            item["title"] = metadata.get("title", "Untitled Project")

    return page

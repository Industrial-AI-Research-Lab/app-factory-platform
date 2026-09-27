"""Admin routes (agents, tools, stats, logs)"""

from fastapi import APIRouter, Depends, HTTPException
from api.auth.middleware import require_role
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import load_authorized_project
from typing import Optional
from pydantic import BaseModel
import asyncio
import logging
import os

from fastapi.encoders import jsonable_encoder

from api.deps import get_orchestrator, get_event_emitter, get_storage, get_container_manager
from config.migration_registry import MigrationError, MigrationFailed, RegistryError
from config.migration_runner import Migrator

router = APIRouter(tags=["admin"], dependencies=[Depends(require_role("tenant_admin"))])


@router.get("/api/agents")
async def list_agents():
    """List all registered agents"""
    orchestrator = get_orchestrator()
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")
    
    agents = []
    for agent in orchestrator.agent_pool:
        agents.append({
            "agent_id": agent.agent_id,
            "agent_type": agent.agent_type.value,
            "model": agent.model,
            "temperature": agent.temperature
        })
    
    return {"agents": agents}


@router.get("/api/tools")
async def list_tools():
    """List all available tools"""
    orchestrator = get_orchestrator()
    if not orchestrator or not orchestrator.tool_registry:
        raise HTTPException(status_code=500, detail="Tool registry not initialized")
    
    return {
        "tools": orchestrator.tool_registry.tools,
        "stats": orchestrator.tool_registry.get_stats()
    }


@router.get("/api/stats")
async def get_stats():
    """Get system statistics"""
    orchestrator = get_orchestrator()
    event_emitter = get_event_emitter()
    
    if not orchestrator or not event_emitter:
        raise HTTPException(status_code=500, detail="System not initialized")
    
    return {
        "active_projects": len(orchestrator.active_projects),
        "agents": len(orchestrator.agent_pool),
        "auction_stats": orchestrator.auction.get_stats(),
        "event_stats": event_emitter.get_stats()
    }


@router.get("/api/projects/{project_id}/logs")
async def get_container_logs(
    project_id: str,
    environment_id: Optional[str] = None,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Get container logs for a project."""
    orchestrator = get_orchestrator()
    container_manager = get_container_manager()
    storage = get_storage()
    logger = logging.getLogger(__name__)
    await load_authorized_project(project_id, tenant_ctx)
    
    logger.info(f"📋 Logs requested for project_id={project_id}, environment_id={environment_id}")
    
    if not container_manager:
        raise HTTPException(status_code=500, detail="Container manager not initialized")
    
    if not environment_id:
        project = orchestrator.active_projects.get(project_id) if orchestrator else None
        logger.info(f"🔍 Project in active_projects: {project is not None}")
        
        if project:
            container_status = await container_manager.get_container_status(project_id)
            environment_id = container_status.get("environment_id")
            logger.info(f"🐳 Got environment_id from container_status: {environment_id}")
        else:
            logger.warning(f"⚠️  Project {project_id} not in active_projects")
    else:
        logger.info(f"✅ Using provided environment_id: {environment_id}")
    
    try:
        logger.info(f"🚀 Calling container_manager.get_logs(project_id={project_id}, environment_id={environment_id})")
        result = await container_manager.get_logs(
            project_id=project_id,
            environment_id=environment_id
        )
        
        logger.info(f"📦 Result: exit_code={result.get('exit_code')}, stdout_len={len(result.get('stdout', ''))}")
        
        # Persist a snapshot
        try:
            if storage:
                max_len = 20000
                stdout_full = result.get("stdout", "") or ""
                stderr_full = result.get("stderr", "") or ""
                truncated = False
                if len(stdout_full) > max_len:
                    stdout_full = stdout_full[-max_len:]
                    truncated = True
                if len(stderr_full) > 1000:
                    stderr_full = stderr_full[-1000:]
                    truncated = True or truncated
                await storage.save_container_log(project_id, "log_snapshot", {
                    "environment_id": environment_id,
                    "exit_code": result.get("exit_code", 0),
                    "stdout": stdout_full,
                    "stderr": stderr_full,
                    "truncated": truncated,
                })
        except Exception as pe:
            logger.warning(f"⚠️  Failed to persist container logs snapshot: {pe}")

        return {
            "logs": result.get("stdout", ""),
            "error": result.get("stderr", ""),
            "exit_code": result.get("exit_code", 0)
        }
    except Exception as e:
        logger.error(f"❌ Error getting logs: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/projects/{project_id}/logs/history")
async def get_container_logs_history(
    project_id: str,
    limit: int = 200,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Return persisted container-use log snapshots for a project."""
    storage, _ = await load_authorized_project(project_id, tenant_ctx)
    try:
        rows = await storage.get_container_logs(project_id, limit=limit)
        return {"history": rows}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/projects/{project_id}/tasks/{task_id}/diff")
async def task_changed_files(
    project_id: str,
    task_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Get changed files for a specific task."""
    orchestrator = get_orchestrator()
    container_manager = get_container_manager()
    await load_authorized_project(project_id, tenant_ctx)
    
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")
    if not container_manager:
        raise HTTPException(status_code=500, detail="Container manager not initialized")
    
    try:
        snaps = await orchestrator.list_snapshots(project_id, limit=500)
        start_commit = None
        end_commit = None
        for s in snaps:
            if s.get("event_id") == task_id:
                if s.get("type") == "task_start" and s.get("git_commit"):
                    start_commit = s.get("git_commit")
                if s.get("type") == "task_completed" and s.get("git_commit"):
                    end_commit = s.get("git_commit")
        
        if not start_commit:
            raise HTTPException(status_code=404, detail="No task_start snapshot found for task")
        
        repo_name = f"AppFactory-{project_id}"
        try:
            status = await container_manager.get_container_status(project_id)
            repo_path = (status or {}).get("repo_path")
            if repo_path:
                from pathlib import Path as _Path
                repo_name = _Path(repo_path).name
        except Exception:
            pass
        
        changed = await asyncio.to_thread(
            container_manager.repo_manager.list_changed_files,
            repo_name,
            start_commit,
            end_commit,
        )
        return {"task_id": task_id, "from_commit": start_commit, "to_commit": end_commit or "HEAD", "files": changed}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class UpgradeRequest(BaseModel):
    target: Optional[int] = None
    dry_run: bool = False
    allow_out_of_order: bool = False


class DowngradeRequest(BaseModel):
    to_version: int


class BaselineRequest(BaseModel):
    version: int


class RepairRequest(BaseModel):
    mark_applied: bool = False
    mark_reverted: bool = False


_ROOT_ONLY = [Depends(require_role("root"))]


def _migrator() -> Migrator:
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")
    try:
        return Migrator(storage.db, sha=os.getenv("BUILD_SHA"))
    except RegistryError as e:
        raise HTTPException(status_code=500, detail=_migration_detail(e))


def _migration_detail(e: MigrationError) -> dict:
    return jsonable_encoder({**e.detail, "error": type(e).__name__, "message": str(e)})


async def _run_migration_op(op):
    """State conflicts (dirty, lock, order, checksum, irreversible) are 409;
    a migration that raised is a 500 — the database is now dirty."""
    try:
        return await op()
    except MigrationFailed as e:
        raise HTTPException(status_code=500, detail=_migration_detail(e))
    except MigrationError as e:
        raise HTTPException(status_code=409, detail=_migration_detail(e))


@router.get("/api/admin/migrations")
async def get_migrations_status():
    """Current/head version, applied history, pending, dirty and lock state."""
    return await _migrator().status()


@router.post("/api/admin/migrations/upgrade", dependencies=_ROOT_ONLY)
async def upgrade_migrations(body: UpgradeRequest):
    m = _migrator()
    return await _run_migration_op(lambda: m.upgrade(
        target=body.target, dry_run=body.dry_run, allow_out_of_order=body.allow_out_of_order,
    ))


@router.post("/api/admin/migrations/downgrade", dependencies=_ROOT_ONLY)
async def downgrade_migrations(body: DowngradeRequest):
    m = _migrator()
    return await _run_migration_op(lambda: m.downgrade(to_version=body.to_version))


@router.post("/api/admin/migrations/baseline", dependencies=_ROOT_ONLY)
async def baseline_migrations(body: BaselineRequest):
    m = _migrator()
    return await _run_migration_op(lambda: m.baseline(version=body.version))


@router.post("/api/admin/migrations/repair", dependencies=_ROOT_ONLY)
async def repair_migrations(body: RepairRequest):
    m = _migrator()
    return await _run_migration_op(lambda: m.repair(
        mark_applied=body.mark_applied, mark_reverted=body.mark_reverted,
    ))

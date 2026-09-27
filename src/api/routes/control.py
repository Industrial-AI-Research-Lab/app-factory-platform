"""Control routes (cancel, stop, revert, resume)"""

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from api.auth.middleware import require_auth
from pydantic import BaseModel
from typing import List, Optional

from api.deps import get_orchestrator, get_event_emitter
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import load_authorized_project
from api.auth.tenant_key_resolver import resolve_tenant_llm_key
from orchestration.workflow_task_lifecycle import ResumeBlockedLookupError
from storage.checkpoint_restore_store import RestoreError
from telemetry.tracer import create_task_with_context

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/projects", tags=["control"], dependencies=[Depends(require_auth)])


def _raise_if_revert_refused(res) -> None:
    """A revert delegate returns {"status":"failed"} when it refuses BEFORE
    mutating (unsafe/unrepairable snapshot, no active run, missing snapshot).
    Surface that as 409 — otherwise the dict serializes as HTTP 200 and the
    client reads resp.ok as success, showing "Reverted" and re-sending onto a
    run that was never reverted."""
    if isinstance(res, dict) and res.get("status") == "failed":
        raise HTTPException(status_code=409, detail=res.get("error") or "Revert refused")


async def _assert_resume_allowed(orchestrator, project_id: str) -> None:
    """Fail-closed before any explicit workflow spawn from control routes."""
    if orchestrator.projects.workflow_finalize_pending(project_id):
        raise HTTPException(
            status_code=409,
            detail="Workflow finalize in progress",
        )
    try:
        blocked = await orchestrator.get_resume_blocked_reason(project_id)
    except ResumeBlockedLookupError as exc:
        raise HTTPException(
            status_code=503,
            detail="Cannot verify resume safety",
        ) from exc
    if blocked:
        raise HTTPException(
            status_code=409,
            detail=f"Resume blocked: {blocked}",
        )


async def _spawn_resume_workflow(orchestrator, project_id: str, *, log_tag: str) -> str:
    """Spawn workflow under project lock; idempotent if a live task already exists."""
    existing = orchestrator.project_tasks.get(project_id)
    if existing is not None and not existing.done():
        logger.info(
            "[CONTROL] project_id=%s %s skipped — workflow already running",
            project_id,
            log_tag,
        )
        return "already_running"

    from storage.checkpoint_restore_store import CheckpointRestoreStore
    operations = CheckpointRestoreStore(orchestrator.storage)
    operation = await operations.get(project_id)
    active = await orchestrator.storage.get_active_run(project_id)
    restored_active = bool(active and active.get("restored_from"))
    if operation and operation.get("state") == "dispatched":
        if active and active.get("run_id") != operation["run_id"]:
            operation = None
    if restored_active or (operation and operation.get("state") != "failed"):
        # The coordinator owns this same lock. Call it before acquiring the
        # ordinary spawn lock and never fall back to a fresh scientific send.
        spawned = await orchestrator.ensure_workflow_running(project_id)
        return "resumed" if spawned else "not_resumed"
    async with orchestrator.projects.get_lock(project_id):
        return await _spawn_resume_workflow_locked(orchestrator, project_id, log_tag=log_tag)


async def _spawn_resume_workflow_locked(orchestrator, project_id: str, *, log_tag: str) -> str:
    """Ordinary task registration; caller holds the project lock."""
    from storage.checkpoint_restore_store import CheckpointRestoreStore
    operations = CheckpointRestoreStore(orchestrator.storage)
    existing = orchestrator.project_tasks.get(project_id)
    if existing is not None and not existing.done():
        logger.info(
            "[CONTROL] project_id=%s %s skipped — workflow already running",
            project_id,
            log_tag,
        )
        return "already_running"

    # A restore may have claimed the project after the first lookup.
    # Refuse this ordinary spawn; the caller can recover on its next call.
    try:
        await operations.assert_mutation_allowed(project_id)
    except Exception as exc:
        raise HTTPException(409, "Checkpoint restore prevents fresh resume") from exc
    await _assert_resume_allowed(orchestrator, project_id)

    async def run_workflow_with_error_handling():
        try:
            await orchestrator.run_workflow(project_id)
        except Exception:
            import traceback

            logger.error(
                "[CONTROL] project_id=%s workflow error (%s):\n%s",
                project_id,
                log_tag,
                traceback.format_exc(),
            )
            raise

    t = create_task_with_context(run_workflow_with_error_handling())
    try:
        orchestrator.register_workflow_task(project_id, t)
    except Exception as exc:
        logger.warning(
            "[CONTROL] project_id=%s %s register_workflow_task failed: %s",
            project_id,
            log_tag,
            exc,
        )
        t.cancel()
        raise HTTPException(
            status_code=500,
            detail="Failed to register workflow task",
        ) from exc
    return "started"


async def _persist_resume_running_state(
    storage,
    project_id: str,
    project: dict,
    run_id: Optional[str],
    db_metadata: Optional[dict] = None,
) -> None:
    """Persist running status before reinstate/workflow — DB must lead in-memory."""
    metadata = project.get("metadata") or db_metadata or {}
    await storage.save_project(project_id, {
        "user_prompt": project.get("user_prompt", ""),
        "title": project.get("title", "Untitled Project"),
        "status": "running",
        "current_phase": project.get("current_phase") or "requirements",
        "approval_mode": project.get("approval_mode", "human"),
        "tenant_id": project.get("tenant_id"),
        "created_at": project.get("created_at"),
        "metadata": metadata,
    })
    if run_id:
        await storage.update_run_status(run_id, "running")


class CancelRequest(BaseModel):
    reason: Optional[str] = None
    resume: Optional[bool] = False


class StopRequest(BaseModel):
    reason: Optional[str] = None
    revert_to: Optional[dict] = None
    resume: Optional[bool] = False


class RevertRequest(BaseModel):
    target: dict
    resume: Optional[bool] = False


class RevertPreviewRequest(BaseModel):
    policy: dict


class ResumeRequest(BaseModel):
    prompt: Optional[str] = None


@router.post("/{project_id}/cancel")
async def cancel_project(
    project_id: str,
    body: CancelRequest,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Cancel a running project."""
    orchestrator = get_orchestrator()
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")
    await load_authorized_project(project_id, tenant_ctx)
    
    project = orchestrator.active_projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    await orchestrator.cancel_project(project_id, reason=body.reason or "Cancelled by user")
    return {"status": "cancelled"}


@router.post("/{project_id}/stop")
async def stop_project(
    project_id: str,
    body: StopRequest,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Stop project with optional revert."""
    orchestrator = get_orchestrator()
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")
    await load_authorized_project(project_id, tenant_ctx)
    
    proj = orchestrator.active_projects.get(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")

    if body.revert_to:
        # Revert checks the restore guard before cancelling under the project lock.
        try:
            res = await orchestrator.revert_project(project_id, body.revert_to, resume=bool(body.resume))
        except RestoreError as exc:
            raise HTTPException(
                status_code=exc.status_code,
                detail={"code": exc.code, "run_id": exc.run_id},
            ) from exc
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
        _raise_if_revert_refused(res)
        return {"status": "stopped", "revert": res}

    await orchestrator.cancel_project(project_id, reason=body.reason or "Stopped by user")

    try:
        settled = await orchestrator.projects.wait_for_task_completion(project_id)
        if not settled:
            logger.warning(
                "[CONTROL] project_id=%s stop: workflow task did not settle within timeout",
                project_id,
            )
    except asyncio.CancelledError:
        logger.info(
            "[CONTROL] project_id=%s stop: workflow task cancelled during wait",
            project_id,
        )
    except Exception as exc:
        logger.warning(
            "[CONTROL] project_id=%s stop: error waiting for workflow task: %s",
            project_id,
            exc,
        )

    return {"status": "stopped"}


@router.post("/{project_id}/revert")
async def revert_project(
    project_id: str,
    body: RevertRequest,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Revert project to a snapshot target."""
    orchestrator = get_orchestrator()
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")
    await load_authorized_project(project_id, tenant_ctx)
    
    proj = orchestrator.active_projects.get(project_id)
    if not proj:
        # Try to load project on-demand (lazy loading)
        proj = await orchestrator.projects.load_project_to_active(
            project_id, orchestrator.agent_pool
        )
        if not proj:
            raise HTTPException(status_code=404, detail="Project not found")
    
    try:
        target_type = (body.target or {}).get("type") if isinstance(body.target, dict) else None

        if target_type == "message_sequence":
            # PRIMARY: Message-based revert using unified message system
            sequence = (body.target or {}).get("sequence")
            if sequence is None:
                raise HTTPException(status_code=400, detail="sequence is required for type='message_sequence'")
            res = await orchestrator.revert_to_message_sequence(project_id, int(sequence))
        elif target_type == "user_message":
            # Legacy facade removed in task-13. Reject explicitly instead of
            # silently falling through to revert_project's baseline-reset
            # fallback, which would destructively reset to project_started
            # instead of the requested user-message checkpoint.
            raise HTTPException(
                status_code=400,
                detail=(
                    "target.type='user_message' is removed. "
                    "Use type='message_sequence' with the message sequence number, "
                    "or POST /projects/{id}/stop-and-revert-latest for the previous user action."
                ),
            )
        else:
            res = await orchestrator.revert_project(project_id, body.target, resume=bool(body.resume))
        _raise_if_revert_refused(res)
        return res
    except HTTPException:
        raise
    except RestoreError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "run_id": exc.run_id},
        ) from exc
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{project_id}/revert/preview")
async def revert_preview(
    project_id: str,
    body: RevertPreviewRequest,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Preview what a revert would do."""
    orchestrator = get_orchestrator()
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")
    await load_authorized_project(project_id, tenant_ctx)
    
    proj = orchestrator.active_projects.get(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    
    try:
        policy = body.policy or {"type": "tags", "all": ["user_action"]}
        snap = None
        if policy.get("type") == "tags":
            tags = policy.get("all") or ["user_action"]
            snap = await orchestrator.reverts.resolve_latest_by_tags(project_id, tags)
        if not snap:
            snap = await orchestrator.reverts.resolve_latest_by_tags(project_id, ["system_checkpoint"])
        if not snap:
            return {"resolved": None, "message_for_user": "No revert points found. Will reset to baseline on revert."}
        
        meta = snap.get("meta") or {}
        message = f"Will revert to: {snap.get('label')}"
        prefill = meta.get("input_prefill")
        return {"resolved": snap, "prefill_input": prefill, "message_for_user": message}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{project_id}/stop-and-revert-latest")
async def stop_and_revert_latest(
    project_id: str,
    body: CancelRequest,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Stop the current workflow and revert to the latest user_message checkpoint."""
    orchestrator = get_orchestrator()
    event_emitter = get_event_emitter()
    
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")
    await load_authorized_project(project_id, tenant_ctx)
    
    proj = orchestrator.active_projects.get(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    
    try:
        res = await orchestrator.revert_to_latest_user_message(project_id)
        _raise_if_revert_refused(res)

        if body.resume:
            await _assert_resume_allowed(orchestrator, project_id)
            await _spawn_resume_workflow(
                orchestrator, project_id, log_tag="revert+resume"
            )
        return res
    except HTTPException:
        raise
    except RestoreError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "run_id": exc.run_id},
        ) from exc
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{project_id}/snapshots")
async def list_snapshots(
    project_id: str,
    limit: int = 100,
    tags: Optional[str] = None,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """List snapshots for a project."""
    orchestrator = get_orchestrator()
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")
    await load_authorized_project(project_id, tenant_ctx)
    
    try:
        items = await orchestrator.list_snapshots(project_id, limit)
        if tags:
            want = set([t.strip() for t in tags.split(",") if t.strip()])
            filtered = []
            for s in items:
                s_tags = set(((s.get("meta") or {}).get("tags") or []))
                if want.issubset(s_tags):
                    filtered.append(s)
            items = filtered
        return {"snapshots": items}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{project_id}/resume")
async def resume_project(
    project_id: str,
    body: ResumeRequest,
    request: Request,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Resume a project by starting workflow execution from current state."""
    orchestrator = get_orchestrator()
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")
    from api.routes.checkpoint_guards import checkpoint_resume_required

    # Classify and perform ordinary resume mutations within one lock scope, so
    # restore cannot claim the project between eligibility and those writes.
    async with orchestrator.projects.get_lock(project_id):
        storage, db_project = await load_authorized_project(project_id, tenant_ctx)
        checkpoint_resume = await checkpoint_resume_required(storage, project_id, db_project)
        if not checkpoint_resume:
            return await _resume_project_locked(
                project_id, body, request, tenant_ctx,
                orchestrator=orchestrator, storage=storage, db_project=db_project,
            )

    # Recovery takes the same non-reentrant lock and rechecks durable state.
    # No status/prompt/runtime/event mutations occur in the HTTP path above.
    resumed = await orchestrator.ensure_workflow_running(project_id)
    return {"status": "resumed" if resumed else "not_resumed"}


async def _resume_project_locked(
    project_id, body, request, tenant_ctx, *, orchestrator, storage, db_project,
):
    """The ordinary resume path, called while holding the project lock."""
    event_emitter = get_event_emitter()

    project = orchestrator.active_projects.get(project_id)
    if not project:
        if not db_project:
            raise HTTPException(status_code=404, detail="Project not found")
        try:
            project = await orchestrator.projects.load_project_to_active(
                project_id, orchestrator.agent_pool
            )
        except Exception as re:
            raise HTTPException(status_code=500, detail=f"Failed to reconstruct project context: {re}")
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

    override_key = request.headers.get("x-bf-vk")
    fallback_models_override: Optional[List[str]] = None
    proj_tenant = (db_project or {}).get("tenant_id")
    tenant_id = proj_tenant or tenant_ctx.tenant_id

    # If no explicit header override, resolve the key (and fallback_models)
    # from tenant_settings.
    if not override_key:
        if not tenant_id:
            raise HTTPException(status_code=401, detail="Tenant context is required")
        tenant_key, _, fallback_models_override = await resolve_tenant_llm_key(storage, tenant_id)
        if tenant_key:
            override_key = tenant_key
    elif tenant_id:
        # Header wins for auth, but fallback_models must still be re-resolved:
        # load_project_to_active (cold SharedContext rebuild after a process
        # restart) never restores _ephemeral_fallback_models, so skipping this
        # branch would silently drop a tenant's fallback=[] back to the
        # instance default on the first resume after a restart.
        _, _, fallback_models_override = await resolve_tenant_llm_key(storage, tenant_id)

    await _assert_resume_allowed(orchestrator, project_id)

    sc = project.get("shared_context")
    if sc is not None:
        was_cancelled = (
            orchestrator._is_cancelled(project_id)
            or (db_project or {}).get("status") == "cancelled"
        )
        if was_cancelled:
            run_id = project.get("run_id")
            try:
                if storage:
                    await _persist_resume_running_state(
                        storage,
                        project_id,
                        project,
                        run_id,
                        db_metadata=(db_project or {}).get("metadata"),
                    )
            except Exception as e:
                logger.error(
                    "[RESUME] project_id=%s persist running failed: %s",
                    project_id,
                    e,
                )
                raise HTTPException(
                    status_code=503,
                    detail="Failed to persist resume state",
                ) from e
            orchestrator._reinstate_runtime(project_id, sc)
            project["status"] = "running"
        else:
            try:
                setattr(sc, "_cancelled", False)
            except Exception:
                pass
        if override_key:
            try:
                setattr(sc, "_ephemeral_api_key", override_key)
            except Exception:
                pass
        if fallback_models_override is not None:
            try:
                setattr(sc, "_ephemeral_fallback_models", fallback_models_override)
            except Exception:
                pass

    if body and isinstance(body, ResumeRequest) and body.prompt:
        new_prompt = (body.prompt or "").strip()
        if new_prompt:
            try:
                project["user_prompt"] = new_prompt
            except Exception:
                pass
            try:
                if sc is not None:
                    sc._cache["user_prompt"] = new_prompt
                    await sc._sync_to_db()
            except Exception:
                pass
            try:
                if storage:
                    await storage.save_project(project_id, {
                        "user_prompt": new_prompt,
                        "title": project.get("title", "Untitled Project"),
                        "status": project.get("status") or "initialized",
                        "current_phase": project.get("current_phase") or "requirements",
                        "approval_mode": project.get("approval_mode", "human"),
                        "tenant_id": project.get("tenant_id"),
                        "created_at": project.get("created_at"),
                        "metadata": project.get("metadata", {}),
                    })
            except Exception:
                pass

    try:
        await event_emitter.emit(
            "project_started",
            project.get("run_id"),
            {"project_id": project_id, "user_prompt": project.get("user_prompt", "")},
        )
    except Exception:
        pass

    status = await _spawn_resume_workflow_locked(orchestrator, project_id, log_tag="resume")
    return {"status": status}

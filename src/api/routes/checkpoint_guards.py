"""Serialize Run mutations with the checkpoint runtime handoff."""

from fastapi import Depends, HTTPException

from api import deps
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import load_authorized_project
from storage.checkpoint_restore_store import CheckpointRestoreStore, RestoreError


async def checkpoint_resume_required(storage, project_id, project):
    """Classify under the project lock before ordinary resume changes anything."""
    operation = project.get("checkpoint_restore")
    if not operation:
        return False
    state = operation.get("state")
    if state in ("external-restored", "ready"):
        return True
    if state in ("request-started", "outcome-unknown"):
        raise HTTPException(
            409,
            detail={
                "code": "checkpoint_restore_outcome_unknown",
                "run_id": operation["run_id"],
            },
        )
    active = await storage.get_active_run(project_id)
    if active and active.get("restored_from"):
        if active.get("run_status") in ("cancelled", "completed", "failed"):
            raise HTTPException(
                409,
                detail={
                    "code": "checkpoint_resume_terminal",
                    "run_id": active["run_id"],
                },
            )
        # Known nonterminal restored Runs can only resume through durable
        # cursors. The coordinator checks them again while holding its lock.
        return True
    return False


async def checkpoint_mutation_guard(
    project_id: str, tenant_ctx: TenantContext = Depends(get_tenant_context)
):
    storage, _ = await load_authorized_project(project_id, tenant_ctx)
    orch = deps.get_orchestrator()
    if not orch:
        raise HTTPException(503, "Project runtime unavailable")
    async with orch.projects.get_lock(project_id):
        try:
            operations = CheckpointRestoreStore(storage)
            operation = await operations.get(project_id)
            task = orch.project_tasks.get(project_id)
            if operation and task and not task.done():
                raise RestoreError(
                    "checkpoint_workflow_busy", run_id=operation["run_id"]
                )
            await operations.assert_mutation_allowed(project_id)
        except RestoreError as exc:
            raise HTTPException(
                409, detail={"code": exc.code, "run_id": exc.run_id}
            ) from exc
        yield

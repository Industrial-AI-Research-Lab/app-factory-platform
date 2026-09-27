"""Run management routes (Milestone 3)"""

from fastapi import APIRouter, Depends, HTTPException
from api.auth.middleware import require_auth
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import load_authorized_project
from pydantic import BaseModel
import uuid

from api.deps import get_orchestrator
from api.routes.checkpoint_guards import checkpoint_mutation_guard
from api.routes.run_trace_links import public_jaeger_url, with_trace_link

router = APIRouter(prefix="/api/projects", tags=["runs"], dependencies=[Depends(require_auth)])


async def _sync_in_memory_active_run(orchestrator, storage, project_id: str, run_id: str) -> None:
    """Mirror a DB active-run switch into orchestrator.active_projects.

    The runner reads run_id from the project's shared_context — a stale
    in-memory mirror keeps journaling tool calls into the PREVIOUS run after
    a fork/activate/delete switched the active one. Every route that calls
    storage.set_active_run must call this afterwards.

    Mutate the resident context IN PLACE. The per-project agent clones alias
    this exact object (create_project_agents: ``a.shared_context = sc``) and
    read run_id from it when they journal (base._capture_kwargs_for_runner).
    Swapping the dict slot to a FRESH object would leave every agent bound to
    the old run's context, so a resumed phase keeps stamping tool calls with
    the previous run_id even though the project/FSM/approvals moved on — a
    silent ledger divergence that breaks restart rehydration (ADR-0009) and
    ask_human resume (ADR-0010) for the run the user is on. In place also
    keeps the context's run_config / model / tenant overrides, which a
    rebuilt-from-scratch object dropped.
    """
    if not orchestrator or project_id not in orchestrator.active_projects:
        return
    proj = orchestrator.active_projects[project_id]
    existing = proj.get("shared_context")
    if existing is not None:
        existing.run_id = run_id
        # Refresh the cache from the switched run's stored context. load_from_db
        # MERGES onto the current cache, so run_config and other non-persisted
        # keys survive — a raw ``_cache = ctx`` assignment would drop them.
        await existing.load_from_db()
    else:
        # active_projects entries always carry a shared_context; guard the
        # degenerate case anyway. No agent can alias a missing context, so a
        # fresh object is safe here.
        from context.shared_context import SharedContext as _SC
        sc = _SC(
            project_id,
            storage,
            run_id=run_id,
            message_store=getattr(orchestrator, "message_store", None),
        )
        await sc.load_from_db()
        proj["shared_context"] = sc
    # Stamp the new active run on the project dict so subsequent reads of
    # /projects/{id} (which falls back to proj["run_id"] when
    # storage.get_active_run can't be queried) and direct consumers of
    # proj["run_id"] see the switched run, not the previous one.
    proj["run_id"] = run_id


class ForkRequest(BaseModel):
    conversation_index: int


@router.get("/{project_id}/runs")
async def list_runs(
    project_id: str,
    limit: int = 100,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """List all runs for a project."""
    storage, _ = await load_authorized_project(project_id, tenant_ctx)
    
    try:
        runs = await storage.list_runs(project_id, limit)
        base_url = public_jaeger_url()
        return {"runs": [with_trace_link(run, base_url) for run in runs]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{project_id}/runs/{run_id}")
async def get_run(
    project_id: str,
    run_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Get a specific run."""
    storage, _ = await load_authorized_project(project_id, tenant_ctx)
    
    try:
        run = await storage.get_run(run_id)
        if not run or run.get("project_id") != project_id or run.get("deleted_at"):
            raise HTTPException(status_code=404, detail="Run not found")
        return with_trace_link(run, public_jaeger_url())
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{project_id}/fork", dependencies=[Depends(checkpoint_mutation_guard)])
async def fork_run(
    project_id: str,
    body: ForkRequest,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Fork a new run from an earlier conversation checkpoint."""
    orchestrator = get_orchestrator()
    storage, _ = await load_authorized_project(project_id, tenant_ctx)
    
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")
    
    try:
        new_run_id = str(uuid.uuid4())
        
        active_run = await storage.get_active_run(project_id)
        parent_run_id = active_run.get("run_id") if active_run else None
        
        await storage.create_run(
            project_id=project_id,
            run_id=new_run_id,
            parent_run_id=parent_run_id,
            forked_from_conversation_index=body.conversation_index
        )
        
        parent_context = await storage.load_context(project_id, run_id=parent_run_id) if parent_run_id else None
        if parent_context:
            await storage.save_context(project_id, parent_context, run_id=new_run_id)
        
        await storage.set_active_run(project_id, new_run_id)

        await _sync_in_memory_active_run(orchestrator, storage, project_id, new_run_id)

        return {
            "status": "forked",
            "run_id": new_run_id,
            "parent_run_id": parent_run_id,
            "forked_from_conversation_index": body.conversation_index
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{project_id}/runs/{run_id}/activate", dependencies=[Depends(checkpoint_mutation_guard)])
async def activate_run(
    project_id: str,
    run_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Activate a specific run (switch to it)."""
    orchestrator = get_orchestrator()
    storage, _ = await load_authorized_project(project_id, tenant_ctx)
    
    try:
        run = await storage.get_run(run_id)
        if not run or run.get("project_id") != project_id:
            raise HTTPException(status_code=404, detail="Run not found")
        if run.get("deleted_at"):
            # get_active_run ignores soft-deleted runs, so activating one
            # would leave the project with NO active run — every later load
            # would refuse it.
            raise HTTPException(status_code=409, detail="Cannot activate a deleted run")

        await storage.set_active_run(project_id, run_id)

        await _sync_in_memory_active_run(orchestrator, storage, project_id, run_id)

        return {"status": "activated", "run_id": run_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{project_id}/runs/{run_id}/delete", dependencies=[Depends(checkpoint_mutation_guard)])
async def delete_run(
    project_id: str,
    run_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Soft-delete a run (Milestone 5)."""
    storage, _ = await load_authorized_project(project_id, tenant_ctx)
    
    try:
        run = await storage.get_run(run_id)
        if not run or run.get("project_id") != project_id:
            raise HTTPException(status_code=404, detail="Run not found")
        
        if run.get("deleted_at"):
            raise HTTPException(status_code=404, detail="Run already deleted")

        # Resolve the replacement BEFORE deleting: soft-deleting the only run
        # would leave the project with no active run at all, and every later
        # load would refuse the project (SharedContext requires a run). Refuse
        # the delete instead of manufacturing that state.
        replacement_run_id = None
        if run.get("active"):
            parent_run_id = run.get("parent_run_id")
            if parent_run_id:
                # The parent may itself be soft-deleted — activating it would
                # recreate the no-active-run state this guard exists to prevent.
                parent = await storage.get_run(parent_run_id)
                if parent and not parent.get("deleted_at"):
                    replacement_run_id = parent_run_id
            if not replacement_run_id:
                remaining_runs = [
                    r for r in await storage.list_runs(project_id, limit=2)
                    if r.get("run_id") != run_id
                ]
                if not remaining_runs:
                    raise HTTPException(
                        status_code=409,
                        detail="Cannot delete the last remaining run of a project",
                    )
                replacement_run_id = remaining_runs[0]["run_id"]

        # Activate the replacement BEFORE soft-deleting the outgoing run.
        # set_active_run deactivates every other live run (this one included)
        # as it promotes the replacement, so the project is never — not even
        # for the round-trips in between, not even if the box dies mid-delete —
        # left with zero active-and-live runs, the state every project load now
        # refuses (SharedContext requires a run). The old delete-then-activate
        # order opened exactly that window: delete_run only stamps deleted_at,
        # so the outgoing run still reads active:True yet is filtered out by
        # get_active_run's deleted_at:None, while the replacement isn't active
        # yet — get_active_run returns None for the whole gap, bricking the
        # project if a load or a restart lands in it.
        if replacement_run_id:
            await storage.set_active_run(project_id, replacement_run_id)
            await _sync_in_memory_active_run(
                get_orchestrator(), storage, project_id, replacement_run_id
            )

        await storage.delete_run(run_id)

        return {"status": "deleted", "run_id": run_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

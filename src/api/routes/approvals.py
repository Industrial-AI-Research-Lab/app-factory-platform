"""Approval routes"""

from fastapi import APIRouter, Depends, HTTPException, Request
from api.auth.middleware import require_auth
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import verify_project_tenant
from pydantic import BaseModel
from typing import Any, Optional
import hashlib
import json
import logging
from datetime import datetime

from api.deps import get_orchestrator, get_storage, get_message_store
from api.services.ontology_review import preserve_ontology_history, validate_review_feedback
from orchestration.workflow_approval import publish_workflow_approval
from orchestration.workflow_task_lifecycle import ResumeBlockedLookupError

logger = logging.getLogger(__name__)

router = APIRouter(tags=["approvals"], dependencies=[Depends(require_auth)])


async def _ensure_runtime_for_approval(orchestrator, project_id: str) -> None:
    """Spawn parked runtime before resolving approval; refuse if resume is blocked.

    If a live workflow already exists, ensure is a no-op (returns False) — that is OK.
    If none exists and spawn is blocked/fails, do not resolve the one-shot approval.
    """
    existing = orchestrator.project_tasks.get(project_id)
    if existing is not None and not existing.done():
        return

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

    spawned = await orchestrator.ensure_workflow_running(project_id)
    if spawned:
        return
    existing = orchestrator.project_tasks.get(project_id)
    if existing is not None and not existing.done():
        return
    raise HTTPException(
        status_code=409,
        detail="Cannot start workflow runtime to resolve approval",
    )


class ApprovalRequest(BaseModel):
    approved: bool
    feedback: Optional[str] = None
    expected_version: Optional[int] = None
    interaction_response: Optional[dict[str, Any]] = None
    expected_data: Optional[dict[str, Any]] = None


def _approval_data_revision(approval: dict) -> str:
    payload = json.dumps(
        (approval or {}).get("data") or {},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


async def _load_pending_approval(
    message_store,
    pending_approvals: dict,
    *,
    approval_id: str,
    project_id: str,
    run_id: Optional[str] = None,
) -> dict:
    if message_store is not None:
        record = await message_store.get_approval_by_id(approval_id)
    else:
        record = pending_approvals.get(approval_id)
    if not isinstance(record, dict):
        raise HTTPException(status_code=404, detail="Approval not found")
    if record.get("project_id") != project_id:
        raise HTTPException(
            status_code=403,
            detail="Approval does not belong to this project",
        )
    if run_id is not None and record.get("run_id") != run_id:
        raise HTTPException(
            status_code=403,
            detail="Approval does not belong to this run",
        )
    if record.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Approval is no longer pending")
    data = record.get("data") or {}
    if not isinstance(data, dict):
        raise HTTPException(status_code=409, detail="Approval context is malformed")
    stored_id = data.get("approval_id") or record.get("approval_id")
    if stored_id != approval_id:
        raise HTTPException(status_code=409, detail="Approval context is malformed")
    pending_approvals[approval_id] = record
    return record


async def _resolve_pending_approval(
    *,
    orchestrator,
    message_store,
    approval: ApprovalRequest,
    project_id: str,
    run_id: Optional[str],
    approval_id: str,
    approval_type: str,
) -> bool:
    if message_store is None:
        raise HTTPException(status_code=503, detail="Message store not initialized")
    await _ensure_runtime_for_approval(orchestrator, project_id)
    async with orchestrator.projects.get_lock(project_id):
        current = await _load_pending_approval(
            message_store,
            orchestrator.pending_approvals,
            approval_id=approval_id,
            project_id=project_id,
            run_id=run_id,
        )
        current_data = current.get("data") or {}
        if current_data.get("gate_node_id") and approval.expected_data is None:
            raise HTTPException(
                status_code=409,
                detail="Approval version required; refresh and review the latest version",
            )
        if (
            approval.expected_data is not None
            and _approval_data_revision({"data": approval.expected_data})
            != _approval_data_revision(current)
        ):
            raise HTTPException(
                status_code=409,
                detail="Approval changed; review the latest version",
            )
        if approval.approved:
            await _maybe_respawn_deploy_executor(
                orchestrator,
                project_id,
                approval_id,
                current,
            )
            resolved = await orchestrator.approve(
                approval_id,
                approval.feedback,
                approval.interaction_response,
                expected_data=current.get("data") or {},
            )
        else:
            resolved = await orchestrator.reject(
                approval_id,
                approval.feedback or "Rejected by user",
                approval.interaction_response,
                expected_data=current.get("data") or {},
            )
        if resolved is False:
            raise HTTPException(
                status_code=409,
                detail="Approval was resolved by another request",
            )
        await _persist_resolution_interaction_response(
            orchestrator=orchestrator,
            project_id=project_id,
            approval_id=approval_id,
            approval_type=approval_type,
            approval=approval,
        )
        return True


@router.post("/api/projects/{project_id}/approve/{approval_type}")
async def approve_gate(
    project_id: str,
    approval_type: str,
    approval: ApprovalRequest,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Approve or reject an approval gate (legacy type-based endpoint)."""
    orchestrator = get_orchestrator()
    storage = get_storage()
    message_store = get_message_store()
    
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")
    if not message_store:
        raise HTTPException(status_code=503, detail="Message store not initialized")

    db_project = await storage.load_project(project_id)
    await verify_project_tenant(db_project, tenant_ctx)

    approval_id = f"{project_id}_{approval_type}"

    approval_obj = await _load_pending_approval(
        message_store,
        orchestrator.pending_approvals,
        approval_id=approval_id,
        project_id=project_id,
    )
    # Serialize the (check, reconstruct) pair against ensure_workflow_running.
    # That path stamps `_rehydration_approval_id` on the active_projects dict
    # before spawning the FSM; an unprotected _reconstruct_project here would
    # finish its DB awaits and then unconditionally rewrite active_projects,
    # clobbering the marker dict. The next gate entry would pop None, fall
    # through to request_approval, and (because REJECTED isn't in
    # approval_manager.py's active_statuses) mint a duplicate PENDING after
    # reject flipped status — user sees a fresh "Review …" card after a
    # successful reject. Same lock object as ensure_workflow_running, so the
    # two paths interleave deterministically rather than racing.
    async with orchestrator.projects.get_lock(project_id):
        if project_id not in orchestrator.active_projects:
            await _reconstruct_project(project_id, orchestrator, storage, tenant_ctx=tenant_ctx)

    try:
        await _resolve_pending_approval(
            orchestrator=orchestrator,
            message_store=message_store,
            approval=approval,
            project_id=project_id,
            run_id=approval_obj.get("run_id"),
            approval_id=approval_id,
            approval_type=approval_type,
        )

        return {"status": "success"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/projects/{project_id}/approvals/{approval_id}/resolve")
async def resolve_approval_simple(
    project_id: str,
    approval_id: str,
    approval: ApprovalRequest,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Resolve an approval by UUID without requiring run_id (for approvals without run context)."""
    orchestrator = get_orchestrator()
    storage = get_storage()
    message_store = get_message_store()
    
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")

    db_project = await storage.load_project(project_id)
    await verify_project_tenant(db_project, tenant_ctx)

    approval_obj = await _load_pending_approval(
        message_store,
        orchestrator.pending_approvals,
        approval_id=approval_id,
        project_id=project_id,
    )
    # See approve_gate for the marker-race rationale.
    async with orchestrator.projects.get_lock(project_id):
        if project_id not in orchestrator.active_projects:
            await _reconstruct_project(
                project_id,
                orchestrator,
                storage,
                run_id=approval_obj.get("run_id"),
                tenant_ctx=tenant_ctx,
            )

    try:
        await _resolve_pending_approval(
            orchestrator=orchestrator,
            message_store=message_store,
            approval=approval,
            project_id=project_id,
            run_id=approval_obj.get("run_id"),
            approval_id=approval_id,
            approval_type=_approval_type_for_record(approval_obj, "approval"),
        )

        return {"status": "success"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/projects/{project_id}/runs/{run_id}/approvals/{approval_id}/resolve")
async def resolve_approval(
    project_id: str,
    run_id: str,
    approval_id: str,
    approval: ApprovalRequest,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Resolve an approval by its UUID id (Milestone 4: per-instance approvals)."""
    orchestrator = get_orchestrator()
    storage = get_storage()
    message_store = get_message_store()
    
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")

    db_project = await storage.load_project(project_id)
    await verify_project_tenant(db_project, tenant_ctx)

    approval_obj = await _load_pending_approval(
        message_store,
        orchestrator.pending_approvals,
        approval_id=approval_id,
        project_id=project_id,
        run_id=run_id,
    )
    # See approve_gate for the marker-race rationale.
    async with orchestrator.projects.get_lock(project_id):
        if project_id not in orchestrator.active_projects:
            await _reconstruct_project(project_id, orchestrator, storage, run_id=run_id, tenant_ctx=tenant_ctx)

    try:
        await _resolve_pending_approval(
            orchestrator=orchestrator,
            message_store=message_store,
            approval=approval,
            project_id=project_id,
            run_id=run_id,
            approval_id=approval_id,
            approval_type=_approval_type_for_record(approval_obj, "approval"),
        )

        return {"status": "success"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/projects/{project_id}/refine/{approval_type}")
async def refine_approval(
    project_id: str,
    approval_type: str,
    request: dict,
    req: Request = None,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Refine requirements/plan based on user feedback (HTTP entry).

    Thin wrapper: enforce tenant isolation, then hand off to
    `_refine_approval_core`. Body is shared with `intent_router`'s in-process
    feedback path. See the contract block on `_refine_approval_core` for why
    the split exists.
    """
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")
    db_project = await storage.load_project(project_id)
    await verify_project_tenant(db_project, tenant_ctx)

    return await _refine_approval_core(
        project_id=project_id,
        approval_type=approval_type,
        feedback=request.get("feedback", "") or "",
        approval_id_hint=request.get("approval_id"),
        interaction_response=request.get("interaction_response"),
        expected_data=request.get("expected_data"),
    )


async def _refine_approval_core(
    *,
    project_id: str,
    approval_type: str,
    feedback: str = "",
    approval_id_hint: Optional[str] = None,
    feedback_already_persisted: bool = False,
    interaction_response: Optional[dict[str, Any]] = None,
    expected_data: Optional[dict[str, Any]] = None,
) -> dict:
    """Re-run a pending gate's upstream phase without replacing its approval id.

    The HTTP entry performs tenant checks. The message-intent path calls this
    core after persisting its user message, so it sets
    ``feedback_already_persisted`` to avoid a duplicate conversation entry.
    """
    orchestrator = get_orchestrator()
    storage = get_storage()
    message_store = get_message_store()

    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")
    if not message_store:
        raise HTTPException(status_code=503, detail="Message store not initialized")

    try:
        approval_id = approval_id_hint

        # Resolve approval_id: prefer caller-supplied hint, else look up the
        # latest pending approval whose subtype/type matches approval_type.
        # No fallback to the legacy `f"{project_id}_{approval_type}"` ID
        # convention — current approvals are UUID-based (docs/adr/contexts/orchestration/CONTEXT.md §Approval Id) and
        # legacy IDs would never match a real pending row.
        if not approval_id and message_store:
            try:
                pending = await message_store.get_pending_approvals_for_project(project_id, limit=10)
                for pa in pending or []:
                    pa_type = pa.get("subtype") or pa.get("type")
                    if pa_type == approval_type:
                        pa_id = (pa.get("data") or {}).get("approval_id") or pa.get("approval_id")
                        if pa_id:
                            approval_id = pa_id
                            break
            except Exception:
                pass

        if not approval_id:
            raise HTTPException(
                status_code=404,
                detail=f"No pending approval found for type {approval_type!r}",
            )

        # See approve_gate for the marker-race rationale on the locked block:
        # ensure_workflow_running stamps `_rehydration_approval_id` on the
        # active_projects dict before spawning the FSM; an unprotected
        # _reconstruct_project would clobber that marker. Same lock object,
        # held until refine finishes so concurrent rehydrate / revert /
        # approve / reject / refine paths serialize against each other.
        async with orchestrator.projects.get_lock(project_id):
            project = orchestrator.active_projects.get(project_id)
            if not project:
                await _reconstruct_project(project_id, orchestrator, storage, tenant_ctx=None)
                project = orchestrator.active_projects.get(project_id)
            if not project:
                raise HTTPException(status_code=404, detail="Project not found")

            shared_context = project["shared_context"]
            run_id = project.get("run_id")
            approval_record = await _load_pending_approval(
                message_store,
                orchestrator.pending_approvals,
                approval_id=approval_id,
                project_id=project_id,
                run_id=run_id,
            )
            approval_data_existing = approval_record.get("data") or {}
            if expected_data is not None and (
                not isinstance(expected_data, dict)
                or _approval_data_revision({"data": expected_data})
                != _approval_data_revision(approval_record)
            ):
                logger.warning("[APPROVAL] project_id=%s approval_id=%s — stale refine rejected", project_id, approval_id)
                raise HTTPException(status_code=409, detail="Approval changed; review the current version")
            gate_node_id = approval_data_existing.get("gate_node_id")
            if not isinstance(gate_node_id, str) or not gate_node_id.strip():
                raise HTTPException(
                    status_code=409,
                    detail="Approval context is missing gate_node_id",
                )
            target_node_id = approval_data_existing.get("refine_target_node_id")
            feedback = await validate_review_feedback(
                storage, project_id, approval_data_existing,
                interaction_response, expected_data, feedback,
            )
            orchestrator.update_approval_activity(approval_id)

            # Persist feedback to conversation_history when the caller didn't
            # already do it. The chat path (intent_router via POST /messages)
            # appends via `append_user_message` before invocation; the answer
            # form (POST /refine/{type}) skips that step and arrives here with
            # the feedback only in the request body.
            if feedback and not feedback_already_persisted:
                try:
                    await shared_context.add_conversation_message(
                        role="user",
                        content=feedback,
                        phase=approval_type or "general",
                        metadata={"refine_feedback": True},
                    )
                except Exception:
                    pass

            # User-message snapshot so the user can revert to "before my
            # feedback landed". Mirrors the previous behavior at this point.
            if feedback:
                try:
                    idx = await message_store.get_latest_sequence(project_id) if message_store else 0
                    await orchestrator.snapshot_manager.create_snapshot(
                        project_id, shared_context, snap_type="user_message",
                        label="User message", phase=approval_type,
                        meta={
                            "tags": ["user_action", "user_message"],
                            "conversation_index": idx,
                            "input_prefill": feedback,
                        },
                    )
                except Exception:
                    pass

            await _persist_interaction_response(
                shared_context=shared_context,
                approval_id=approval_id,
                approval_type=approval_type,
                approval_data=approval_data_existing,
                feedback=feedback,
                interaction_response=interaction_response,
            )

            workflow_def = await orchestrator._load_workflow_definition(project)
            nodes_map = {n["id"]: n for n in workflow_def.get("nodes", [])}

            # Generic refine only applies to approvals minted by an
            # `approval_gate` node via `WorkflowEngine.build_approval_data`,
            # which is the only path that stashes `refine_target_node_id`
            # and produces the {gate_node_id, gate_label, context_snapshot}
            # payload shape that build_approval_data emits on re-run.
            #
            # Deploy approvals are created directly in
            # `WorkflowEngine._run_deploy_node` with a different payload
            # (deploy_slug, target_namespace, deploy_mode). Walking back
            # from gate_node_id="deploy" lands on the upstream `execution`
            # node, re-runs it, and then overwrites the deploy approval
            # data with a build_approval_data snapshot that has none of
            # the deploy_* fields — `Orchestrator._execute_deploy` reads
            # them as None and ships a broken deploy task.
            gate_node = nodes_map.get(gate_node_id) if gate_node_id else None
            is_workflow_approval_gate = bool(
                gate_node and gate_node.get("type") == "approval_gate"
            )
            if not is_workflow_approval_gate:
                logger.warning(
                    "[REFINE] approval %s gate=%r type=%r is not a workflow approval_gate; "
                    "feedback recorded but generic refine skipped",
                    approval_id, gate_node_id, approval_type,
                )
                return {
                    "response": "Feedback recorded. This approval type cannot be refined generically.",
                    "updated_data": approval_data_existing,
                    "approval_id": approval_id,
                }

            # Backward-compat: approvals created before refine_target_node_id
            # was stashed don't carry the field. Resolve on demand from the
            # workflow definition; new gates always populate it.
            if not target_node_id and gate_node_id:
                target_node_id = orchestrator.workflow_engine._find_refine_target(
                    workflow_def, gate_node_id
                )
                if target_node_id:
                    logger.info(
                        "[REFINE] approval %s: refine_target_node_id resolved on demand to %r",
                        approval_id, target_node_id,
                    )

            if not target_node_id:
                logger.warning(
                    "[REFINE] approval %s gate=%r has no refine target — feedback recorded but no re-run",
                    approval_id, gate_node_id,
                )
                return {"response": "Feedback recorded", "updated_data": {}}

            target_node = nodes_map.get(target_node_id)
            if not target_node:
                logger.warning(
                    "[REFINE] target_node_id %r not in workflow_def — feedback recorded but no re-run",
                    target_node_id,
                )
                return {"response": "Feedback recorded", "updated_data": {}}

            logger.info(
                "[REFINE] re-executing node %r for project %s (approval=%s, gate=%s)",
                target_node_id, project_id, approval_id, gate_node_id,
            )
            refine_from_approval = approval_data_existing.get("refine_from_approval")
            if refine_from_approval is not None:
                if not isinstance(refine_from_approval, dict):
                    raise HTTPException(
                        status_code=409,
                        detail="Refine approval context is malformed",
                    )
                upstream_approval_id = refine_from_approval.get("approval_id")
                upstream_gate_node_id = refine_from_approval.get("gate_node_id")
                if not upstream_approval_id or not upstream_gate_node_id:
                    raise HTTPException(
                        status_code=409,
                        detail="Refine approval context is incomplete",
                    )
                restored = await publish_workflow_approval(
                    shared_context,
                    message_store,
                    {},
                    approval_id=upstream_approval_id,
                    project_id=project_id,
                    run_id=run_id,
                    gate_node_id=upstream_gate_node_id,
                )
                if restored.get("status") != "approved":
                    raise HTTPException(
                        status_code=409,
                        detail="Approved upstream context is unavailable for refine",
                    )
            refine_result = await orchestrator.workflow_engine.rerun_refine_path(
                target_node=target_node,
                gate_node_id=gate_node_id,
                project_id=project_id,
                workflow_def=workflow_def,
                feedback=feedback,
            )
            if refine_result.get("status") != "approved":
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": "Refined output failed workflow validation",
                        "reason": refine_result.get("reason"),
                        "errors": refine_result.get("errors") or [],
                    },
                )

            # Rebuild approval payload via the same helper the engine uses on
            # initial gate creation — same field shape (including
            # refine_target_node_id stash), same artifacts source-of-truth.
            new_approval_data = await orchestrator.workflow_engine.build_approval_data(
                workflow_def=workflow_def,
                gate_node_id=gate_node_id,
                shared_context=shared_context,
                project_id=project_id,
                run_id=run_id,
            )
            preserve_ontology_history(approval_data_existing, new_approval_data)
            new_approval_data["refined"] = True
            new_approval_data["approval_id"] = approval_id
            if refine_from_approval is not None:
                new_approval_data["refine_from_approval"] = dict(refine_from_approval)

            persisted = await message_store.update_approval_data_by_approval_id(
                approval_id,
                new_approval_data,
                project_id=project_id,
                run_id=run_id,
                gate_node_id=gate_node_id,
                expected_data=approval_data_existing,
            )
            if not persisted:
                previous_state = refine_result.get("previous_state") or {}
                authoritative_state = previous_state
                try:
                    authoritative = await message_store.get_approval_by_id(approval_id)
                    current_data = (authoritative or {}).get("data") or {}
                    current_state = (
                        orchestrator.workflow_engine._refine_state_from_approval(
                            target_node,
                            current_data,
                            previous_state,
                        )
                    )
                    if current_state:
                        authoritative_state = current_state
                except Exception as exc:
                    logger.warning(
                        "[REFINE] approval_id=%s - failed to reload CAS winner: %s",
                        approval_id,
                        exc,
                    )
                await orchestrator.workflow_engine._restore_refine_state(
                    target_node,
                    project_id,
                    authoritative_state,
                )
                raise HTTPException(
                    status_code=409,
                    detail="Approval was resolved while refinement was running",
                )

            # Emit `type` derived from the gate's `label` (the same value
            # `approval_manager.request_approval` uses on initial gate
            # creation), so refined events look identical to fresh ones in
            # the FE regardless of which caller path triggered the refine.
            # The HTTP route passes `approval_type` from the URL ("requirements"),
            # intent_router passes the stored gate_label ("Review requirements");
            # taking it from gate_label here makes the emit deterministic.
            emit_type = new_approval_data.get("gate_label") or approval_type

            orchestrator.pending_approvals[approval_id] = {
                **approval_record,
                "data": persisted.get("data") or new_approval_data,
                "status": "pending",
            }
            try:
                await orchestrator.event_emitter.emit(
                    "approval_updated",
                    run_id,
                    {
                        "approval_id": approval_id,
                        "project_id": project_id,
                        "type": emit_type,
                        "data": new_approval_data,
                    },
                )
            except Exception as e:
                logger.warning("[REFINE] approval_updated emit failed: %s", e)

            return {
                "response": "Refined",
                "updated_data": new_approval_data,
                "approval_id": approval_id,
            }

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"❌ ERROR in _refine_approval_core: {error_details}", flush=True)
        raise HTTPException(status_code=500, detail=f"{str(e)}\n\n{error_details}")


def _approval_type_for_record(approval_obj: Optional[dict], fallback: str) -> str:
    if not isinstance(approval_obj, dict):
        return fallback
    return (
        approval_obj.get("subtype")
        or approval_obj.get("gate_type")
        or approval_obj.get("type")
        or ((approval_obj.get("data") or {}).get("gate_label"))
        or fallback
    )


async def _persist_resolution_interaction_response(
    *,
    orchestrator,
    project_id: str,
    approval_id: str,
    approval_type: str,
    approval: ApprovalRequest,
) -> None:
    if not isinstance(approval.interaction_response, dict) or not approval.interaction_response:
        return
    project = orchestrator.active_projects.get(project_id) or {}
    shared_context = project.get("shared_context")
    if shared_context is None:
        logger.warning(
            "[APPROVAL] approval_id=%s typed_interaction=true - active project has no shared_context",
            approval_id,
        )
        return
    approval_record = orchestrator.pending_approvals.get(approval_id) or {}
    approval_data = approval_record.get("data") or {}
    await _persist_interaction_response(
        shared_context=shared_context,
        approval_id=approval_id,
        approval_type=approval_type,
        approval_data=approval_data,
        feedback=approval.feedback or "",
        interaction_response=approval.interaction_response,
    )


async def _persist_interaction_response(
    *,
    shared_context,
    approval_id: str,
    approval_type: str,
    approval_data: dict,
    feedback: str,
    interaction_response: Optional[dict[str, Any]],
) -> None:
    """Append a typed HITL response to SharedContext custom_context.

    The natural-language feedback stays in the messages collection so agents
    see it in conversation history. The structured response is stored as a
    project-scoped context key so typed gates can be audited and future nodes
    can opt into reading it via `reads`.
    """
    if not isinstance(interaction_response, dict) or not interaction_response:
        return
    if not hasattr(shared_context, "write_context_key"):
        logger.warning(
            "[APPROVAL] approval_id=%s typed_interaction=true - shared_context has no write path",
            approval_id,
        )
        return

    history: list[dict[str, Any]] = []
    reader = getattr(shared_context, "read_context_key_async", None)
    fallback_reader = getattr(shared_context, "read_context_key", None)
    try:
        if callable(reader):
            existing = await reader("hitl_feedback_history", default=[])
        elif callable(fallback_reader):
            existing = fallback_reader("hitl_feedback_history", default=[])
        else:
            existing = []
        if isinstance(existing, list):
            history = list(existing)
    except Exception as e:
        logger.warning(
            "[APPROVAL] approval_id=%s typed_interaction=true - failed to read feedback history: %s",
            approval_id,
            e,
        )

    entry = {
        "approval_id": approval_id,
        "approval_type": approval_type,
        "gate_node_id": approval_data.get("gate_node_id"),
        "gate_label": approval_data.get("gate_label"),
        "interaction_type": interaction_response.get("interaction_type")
        or interaction_response.get("type")
        or (approval_data.get("interaction_schema") or {}).get("type"),
        "decision": interaction_response.get("decision"),
        "feedback": feedback,
        "response": interaction_response,
        "created_at": datetime.utcnow().isoformat(),
    }
    history.append(entry)
    await shared_context.write_context_key("hitl_feedback_history", history[-50:])
    await _persist_research_hitl_projection(
        shared_context=shared_context,
        approval_data=approval_data,
        entry=entry,
    )


async def _persist_research_hitl_projection(
    *,
    shared_context,
    approval_data: dict,
    entry: dict,
) -> None:
    interaction_type = entry.get("interaction_type")
    response = entry.get("response") if isinstance(entry.get("response"), dict) else {}
    if interaction_type == "literature_selection_review":
        selected_ids = [
            str(item)
            for item in response.get("selected_paper_ids", [])
            if str(item).strip()
        ] if isinstance(response.get("selected_paper_ids"), list) else []
        papers = _collect_literature_papers(approval_data)
        selected_papers = [
            paper for paper in papers
            if not selected_ids or _paper_matches_selected_id(paper, selected_ids)
        ]
        await shared_context.write_context_key(
            "approved_literature",
            {
                "decision": response.get("decision"),
                "selected_paper_ids": selected_ids,
                "selected_papers": selected_papers,
                "download_selected": bool(response.get("download_selected")),
                "feedback": entry.get("feedback", ""),
                "approval_id": entry.get("approval_id"),
                "created_at": entry.get("created_at"),
            },
        )
    elif interaction_type == "research_answer_review":
        await shared_context.write_context_key(
            "research_answer_review",
            {
                "decision": response.get("decision"),
                "require_sources": bool(response.get("require_sources")),
                "feedback": entry.get("feedback", ""),
                "approval_id": entry.get("approval_id"),
                "created_at": entry.get("created_at"),
            },
        )


def _collect_literature_papers(approval_data: dict) -> list[dict[str, Any]]:
    snapshot = approval_data.get("context_snapshot") if isinstance(approval_data, dict) else {}
    sources = [
        (snapshot or {}).get("literature") if isinstance(snapshot, dict) else None,
        (snapshot or {}).get("search_results") if isinstance(snapshot, dict) else None,
        (snapshot or {}).get("research_answer") if isinstance(snapshot, dict) else None,
    ]
    papers: list[dict[str, Any]] = []
    seen: set[str] = set()
    for source in sources:
        if not isinstance(source, dict):
            continue
        for candidate in _paper_candidates_from_source(source):
            key = _paper_identity(candidate, len(papers)).lower()
            if key in seen:
                continue
            seen.add(key)
            paper = dict(candidate)
            paper.setdefault("id", _paper_identity(candidate, len(papers)))
            papers.append(paper)
    return papers


def _paper_candidates_from_source(source: dict) -> list[dict[str, Any]]:
    raw_candidates = []
    for key in ("papers", "results", "items"):
        value = source.get(key)
        if isinstance(value, list):
            raw_candidates.extend(value)
    metadata = source.get("metadata")
    if isinstance(metadata, dict) and isinstance(metadata.get("papers"), list):
        raw_candidates.extend(metadata["papers"])
    return [item for item in raw_candidates if isinstance(item, dict)]


def _paper_identity(paper: dict, index: int) -> str:
    for key in ("id", "openalex_id", "doi", "s3_key", "artifact_id", "pdf_url", "url", "title", "paper_title"):
        value = paper.get(key)
        if isinstance(value, (str, int, float)) and str(value).strip():
            return str(value).strip()
    return f"paper-{index + 1}"


def _paper_matches_selected_id(paper: dict, selected_ids: list[str]) -> bool:
    normalized = {item.lower() for item in selected_ids}
    identities = {
        _paper_identity(paper, 0).lower(),
        *{
            str(paper.get(key)).strip().lower()
            for key in ("id", "openalex_id", "doi", "s3_key", "artifact_id", "pdf_url", "url", "title", "paper_title")
            if paper.get(key) is not None and str(paper.get(key)).strip()
        },
    }
    return bool(identities & normalized)


async def _maybe_respawn_deploy_executor(
    orchestrator,
    project_id: str,
    approval_id: str,
    approval_obj: dict,
) -> None:
    """Re-spawn the deploy executor if this is a deploy approval.

    Only `gate_node_id == "deploy"` approvals (the ones seeded by
    `orchestrator._seed_deploy_approval`) need this — they keep their
    post-approval `_execute_deploy` task in RAM and a backend restart
    orphans it. Other gates (gate_req/gate_plan/gate_output) are awaited
    by the workflow FSM, which is rehydrated by `ensure_workflow_running`.

    No-op for non-deploy approvals so callers can call this
    unconditionally before the status flip.
    """
    data = approval_obj.get("data") or {}
    if data.get("gate_node_id") != "deploy":
        return
    try:
        await orchestrator._respawn_deploy_executor(project_id, approval_id, approval_obj)
    except Exception as e:
        logger.warning(
            "[DEPLOY] _maybe_respawn_deploy_executor failed for %s/%s: %s",
            project_id, approval_id, e,
        )


async def _reconstruct_project(
    project_id: str,
    orchestrator,
    storage,
    run_id: str = None,
    tenant_ctx: TenantContext | None = None,
):
    """Reconstruct project from DB into active_projects via canonical loader.

    Performs tenant verification first (the canonical loader trusts callers),
    then delegates to `orchestrator.projects.load_project_to_active` so the
    restored dict carries `workflow_id`, `model_id`, `force_model`,
    `reasoning_effort`, `run_config_id`, and a SharedContext wired with
    `message_store` and `run_config`. The previous inline reconstruction
    populated only a partial subset of these fields; on post-restart approve
    the partial dict was already in `active_projects`, so
    `Orchestrator.ensure_workflow_running` skipped its own
    `load_project_to_active` call (see orchestrator.py:268-276), and the FSM
    spawned with `workflow_id=None` → default_build fallback and no model
    overrides. `run_id` is stamped after the canonical load (canonical
    loader doesn't carry it; `ensure_workflow_running` also stamps from
    the approval, but stamping here keeps callers that only invoke
    `_reconstruct_project` correct).
    """
    if not storage:
        raise HTTPException(status_code=404, detail="Project not found")

    db_project = await storage.load_project(project_id)
    if tenant_ctx is not None:
        await verify_project_tenant(db_project, tenant_ctx)
    if not db_project:
        raise HTTPException(status_code=404, detail="Project not found")

    try:
        project = await orchestrator.projects.load_project_to_active(
            project_id, orchestrator.agent_pool
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load project: {e}")
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if run_id:
        project["run_id"] = run_id

    # Stamp run_id onto the SharedContext too. The canonical loader builds
    # SharedContext without it (callers can't always know run_id at load
    # time — `ensure_workflow_running` for example only learns run_id from
    # the pending approval AFTER loading); but downstream agent emissions
    # and storage save_context calls read `sc.run_id` directly (e.g.
    # agents/base.py:754, context/shared_context.py:645). Without this
    # stamp, post-restart approval emits land with `run_id=None`.
    sc = project.get("shared_context")
    if run_id and sc is not None:
        try:
            sc.run_id = run_id
        except Exception:
            pass

    # Legacy callers (revert flow, agent_pool consumers that hold references
    # to the global prototype agents rather than the per-project clones)
    # expect the active SharedContext to be wired onto the global pool too.
    # The canonical loader creates per-project clones (project_manager.py:
    # 568-570) wired correctly; this rewire keeps the global pool in sync
    # for code paths that still read from it.
    if sc is not None:
        try:
            orchestrator._reinstate_runtime(project_id, sc)
        except Exception:
            pass
        try:
            for agent in orchestrator.agent_pool:
                agent.shared_context = sc
        except Exception:
            pass

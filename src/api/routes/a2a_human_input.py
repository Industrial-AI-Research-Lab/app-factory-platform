"""Answer route for A2A input_required questions (AppFactory-281).

A question is a durable a2a_task_state cursor at status "awaiting_human", plus
a tool_call/tool_result journal pair (name="a2a_human_input", tool_call_id=the
A2A task_id) that renders the card — same journal shape ask_human uses
(tools/ask_human.py, ADR-0010), reused here purely for its pairing/rendering
convenience, NOT its resume mechanics: an a2a_agent node never holds an
in-process waiter the way ask_human's runner does (workflow_engine.py's
TASK_STATE_INPUT_REQUIRED branch always fully returns/exits when it parks), so
there is nothing here to "wake live" — every answer takes what human_input.py
calls its restart path: write the answer, flip the cursor, and poke
ensure_workflow_running to actually send it (continuing the SAME task_id via
message/send, never a new task).
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api import deps
from api.auth.middleware import require_auth
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import load_authorized_project
from tools.ask_human import answered_result

logger = logging.getLogger(__name__)

router = APIRouter(tags=["a2a-human-input"], dependencies=[Depends(require_auth)])

_TERMINAL_STATUSES = ("completed", "failed", "cancelled")


class A2AHumanAnswerRequest(BaseModel):
    answer: str


@router.post("/api/projects/{project_id}/a2a-human-input/{task_id}")
async def answer_a2a_input_required(
    project_id: str,
    task_id: str,
    body: A2AHumanAnswerRequest,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Deliver a human answer to the A2A question parked on ``task_id``."""
    storage, db_project = await load_authorized_project(project_id, tenant_ctx)
    message_store = deps.get_message_store()
    if not message_store:
        raise HTTPException(status_code=503, detail="Message store not initialized")

    answer = (body.answer or "").strip()
    if not answer:
        raise HTTPException(status_code=400, detail="Answer cannot be empty")
    if (db_project or {}).get("status") in _TERMINAL_STATUSES:
        raise HTTPException(status_code=409, detail="Project is finished")

    # AppFactory-281 (found by re-review): the recheck must run INSIDE the lock,
    # not before it — human_input.py's _close_ask_human_pair carries the same
    # lesson explicitly ("the recheck alone doesn't prevent a concurrent answer
    # from writing between it and the append"). An outside-the-lock recheck lets
    # two concurrent POSTs both see "still open" and both append a tool_result —
    # mark_a2a_task_human_answered's own scoped update stays correct (only the
    # first actually flips the cursor), but the journal would still end up with
    # a duplicate/orphaned result. Mirror the reference route's structure:
    # cursor-lookup (404) + journal recheck (409) + write, all as one unit under
    # the lock.

    async def _write_answer(cursor, session=None):
        await storage.mark_a2a_task_human_answered(
            project_id=project_id,
            run_id=cursor["run_id"],
            node_id=cursor["node_id"],
            answer_text=answer,
            session=session,
        )
        await message_store.append_tool_result(
            project_id,
            tool_call_id=task_id,
            name="a2a_human_input",
            result={"status": "success", "answer": answer},
            status="ok",
            run_id=cursor.get("run_id"),
            session=session,
        )

    async def _record_answer_writes(cursor):
        # AppFactory-281 P1 review fix (5th finding): the two writes above must
        # land together — a crash between them left the cursor and the
        # journal permanently disagreeing (dimoniump's finding). Atomic when
        # transactions are available (default deployment, enable_transactions
        # defaults True): makes the crash window this exists to close
        # literally impossible, not just recoverable. Same idiom as
        # set_active_run / delete_tenant_cascade_atomic elsewhere in
        # mongo_backend.py.
        if storage.enable_transactions and storage.client is not None:
            try:
                async with await storage.client.start_session() as session:
                    async with session.start_transaction():
                        await _write_answer(cursor, session=session)
                return
            except Exception as exc:
                if not storage._is_transaction_support_error(exc):
                    raise
                logger.warning(
                    "[A2A_RECOVER] project=%s task_id=%s mode=non_transactional "
                    "reason=transactions_unsupported",
                    project_id, task_id,
                )
        # Fallback (no replica set): cursor-transition FIRST. A crash strictly
        # before the journal write below leaves the cursor already
        # "in_flight" with pending_human_answer set — already resumable via
        # the normal recovery machinery (AppFactory-281 bug #3-#6), so the A2A
        # delivery itself is never blocked. Only the chat-visible journal
        # record would be missing — healed by the self-heal branch below on
        # the next hit of this route (a manual retry, or ensure_workflow_
        # running's own poke at the tail of this function finding nothing
        # new to send).
        await _write_answer(cursor)

    async def _recheck_and_record_answer():
        cursor = await storage.get_awaiting_human_a2a_task_state(project_id, task_id)
        records = await message_store.get_tool_records_for_call(project_id, task_id)
        if answered_result(records) is not None:
            raise HTTPException(status_code=409, detail="Question already answered")

        if cursor is not None:
            await _record_answer_writes(cursor)
            return

        # AppFactory-281 P1 review fix (5th finding): the cursor may have already
        # transitioned past "awaiting_human" on an earlier attempt that
        # crashed strictly between the two writes above — heal the missing
        # journal record instead of 404ing a real prior answer.
        healed_cursor = await storage.get_a2a_task_state_by_task_id(project_id, task_id)
        if healed_cursor is not None and healed_cursor.get("pending_human_answer"):
            logger.warning(
                "[A2A_RECOVER] project=%s task_id=%s — cursor already answered "
                "(status=%s) but journal record was missing (crash between the "
                "two writes on a prior attempt) — backfilling the journal only",
                project_id, task_id, healed_cursor.get("status"),
            )
            await message_store.append_tool_result(
                project_id,
                tool_call_id=task_id,
                name="a2a_human_input",
                result={"status": "success", "answer": healed_cursor["pending_human_answer"]},
                status="ok",
                run_id=healed_cursor.get("run_id"),
            )
            return

        raise HTTPException(status_code=404, detail="No such question")

    orchestrator = deps.get_orchestrator()
    lock = orchestrator.projects.get_lock(project_id) if orchestrator else None
    if lock is not None:
        async with lock:
            await _recheck_and_record_answer()
    else:
        # No orchestrator to borrow the per-project lock from; the residual
        # double-answer race is benign (mark_a2a_task_human_answered's scoped
        # update still keeps only the first transition — same fallback stance
        # human_input.py takes for this same case).
        await _recheck_and_record_answer()

    logger.info(
        "[A2A_RECOVER] project=%s task_id=%s — human answer recorded, resuming",
        project_id, task_id,
    )

    resumed = False
    if orchestrator:
        spawned = bool(await orchestrator.ensure_workflow_running(project_id))
        resumed = spawned or orchestrator.is_workflow_live(project_id)
    return {"status": "ok", "resumed": resumed}

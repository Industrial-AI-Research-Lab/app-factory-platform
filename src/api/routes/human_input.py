"""Answer route for agent questions (ask_human, ADR-0010).

A question is a hanging ``tool_call`` journal record; its answer is the
paired ``tool_result``. This route is deliberately NOT an approval: no row,
no status machine — the journal pair is the whole state. Two cases:

- the asking process is still alive → wake its in-process waiter and let the
  runner persist the result exactly as for any tool;
- the backend restarted since the question (waiter gone) → write the paired
  result here, then poke ``ensure_workflow_running`` so the run resumes at
  its parked node (ADR-0009) with Q+A already in the journal.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api import deps
from api.auth.middleware import require_auth
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import load_authorized_project
from tools.ask_human import (
    answered_result,
    live_answer_claimed,
    resolve_ask_human,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["human-input"], dependencies=[Depends(require_auth)])

_TERMINAL_STATUSES = ("completed", "failed", "cancelled")


class HumanAnswerRequest(BaseModel):
    answer: str


@router.post("/api/projects/{project_id}/human-input/{tool_call_id}")
async def answer_human_question(
    project_id: str,
    tool_call_id: str,
    body: HumanAnswerRequest,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Deliver a human answer to the question parked on ``tool_call_id``."""
    message_store = deps.get_message_store()
    if not message_store:
        raise HTTPException(status_code=503, detail="Message store not initialized")
    _, db_project = await load_authorized_project(project_id, tenant_ctx)

    answer = (body.answer or "").strip()
    if not answer:
        raise HTTPException(status_code=400, detail="Answer cannot be empty")
    if (db_project or {}).get("status") in _TERMINAL_STATUSES:
        raise HTTPException(status_code=409, detail="Project is finished")

    call = await _open_question_or_raise(message_store, project_id, tool_call_id)

    if resolve_ask_human(project_id, tool_call_id, answer):
        # The parked runner persists the tool_result itself on wake; writing
        # it here too would close the pair twice.
        logger.info(
            "[ASK_HUMAN] project=%s call=%s answered live", project_id, tool_call_id
        )
        return {"status": "ok", "mode": "live"}

    # A live answer already claimed this question in THIS process (its woken
    # runner is about to persist it, and the agent is already acting on it). A
    # different answer must not now take the restart path and append a rival
    # result — positional pairing would canonicalize the rival over the answer
    # the run actually used (split-brain, F3). The claim is set synchronously in
    # resolve_ask_human before the waiter is popped, so any answer that saw the
    # waiter gone (above) sees the claim here. 409 as already-answered.
    if live_answer_claimed(project_id, tool_call_id):
        raise HTTPException(status_code=409, detail="Question already answered")

    # No waiter in this process — the backend restarted, or the live runner
    # simply hasn't parked yet (both look identical here; the recheck inside
    # _close_ask_human_pair and the post-write wake below make either safe).
    #
    # Serialize the recheck+write under the project lock — the same lock
    # ensure_workflow_running takes. Without it, two POSTs answering this
    # question in the same window both pass the recheck and both append a
    # result, and positional pairing silently orphans the loser's — a
    # different answer accepted with 200 yet dropped. Under the lock the loser
    # sees the committed result and 409s. Released before ensure_workflow_running
    # re-acquires it below.
    orchestrator = deps.get_orchestrator()
    lock = orchestrator.projects.get_lock(project_id) if orchestrator else None
    if lock is not None:
        async with lock:
            await _close_ask_human_pair(message_store, project_id, tool_call_id, answer)
    else:
        # No orchestrator to borrow the per-project lock from; the residual
        # double-answer race is benign (pairing keeps the earliest).
        await _close_ask_human_pair(message_store, project_id, tool_call_id, answer)

    logger.info(
        "[ASK_HUMAN] project=%s call=%s answered post-restart — pair closed, resuming",
        project_id, tool_call_id,
    )

    # The runner may have parked while we were writing — after its own
    # journal recheck ran, so it saw no result. Wake it with the same
    # answer; the pair is already closed, and the duplicate result the
    # woken runner persists is an orphan pairing skips.
    if resolve_ask_human(project_id, tool_call_id, answer):
        logger.info(
            "[ASK_HUMAN] project=%s call=%s runner parked mid-answer — woken post-write",
            project_id, tool_call_id,
        )

    resumed = False
    if orchestrator:
        # `resumed` means "the workflow is running after this answer", not
        # "this call spawned it": ensure() returns False for an
        # already-live runtime (the slow-to-park window, where the live
        # runner picks the answer up via its recheck) — only a run that is
        # neither spawned nor live warrants the card's warning.
        spawned = bool(await orchestrator.ensure_workflow_running(project_id))
        resumed = spawned or orchestrator.is_workflow_live(project_id)
    return {"status": "ok", "mode": "restart", "resumed": resumed}


async def _open_question_or_raise(message_store, project_id: str, tool_call_id: str):
    """Return the latest open ask_human call for this id, or raise 404/409.

    Open-ness is ``answered_result``'s pairing rule (positional, same as
    resume and the feed), so route, tool recheck and UI never disagree on
    pair state.
    """
    records = await message_store.get_tool_records_for_call(project_id, tool_call_id)
    calls = [r for r in records if r.get("type") == "tool_call"]
    if not calls:
        raise HTTPException(status_code=404, detail="No such question")
    call = calls[-1]
    if (call.get("data") or {}).get("name") != "ask_human":
        raise HTTPException(status_code=404, detail="No such question")

    if answered_result(records) is not None:
        raise HTTPException(status_code=409, detail="Question already answered")
    return call


async def _close_ask_human_pair(message_store, project_id: str, tool_call_id: str, answer: str):
    """Recheck the pair is still open, then write the answer as its result.

    Factored out so the restart path can run the recheck+write as one unit
    under the project lock — the recheck alone doesn't prevent a concurrent
    answer from writing between it and the append. Uses the ids from the call
    record (what pairing and the resume detector group by) and the exact result
    shape the live ask_human tool returns.
    """
    call = await _open_question_or_raise(message_store, project_id, tool_call_id)
    data = call.get("data") or {}
    await message_store.append_tool_result(
        project_id,
        tool_call_id=tool_call_id,
        name="ask_human",
        result={"status": "success", "answer": answer},
        status="ok",
        run_id=call.get("run_id"),
        agent_id=data.get("agent_id"),
        task_id=data.get("task_id"),
    )

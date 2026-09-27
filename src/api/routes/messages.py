"""
Messages API Routes

Provides endpoints for the unified message system.
All messages (user, assistant, approvals, system, events) are stored
in a single ordered stream with sequence numbers.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from api.auth.middleware import require_auth
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import load_authorized_project
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, Dict, Any
import asyncio
import json
import logging

from api import deps
from api.routes.file_attachments import (
    attach_user_files_to_messages,
    parse_send_payload,
    prepare_send_files,
    public_user_attachment,
    resolve_send_content,
    save_message_attachments,
)
from api.routes.file_attachment_events import emit_attachment_uploaded
from config.configuration_resolution import resolve_tenant_config_for_read
from events.emitter import _sse_json_default
from orchestration.intent_classifier import IntentClassifier
from api.intent_router import route_user_message
from storage.message_store import (
    TOOL_JOURNAL_PREVIEW_CHARS,
    TOOL_LEDGER_TYPES,
    tool_payload_preview,
)

logger = logging.getLogger(__name__)


def _journal_view(msg: Dict[str, Any]) -> Dict[str, Any]:
    """Wire shape of a ledger record: bounded previews instead of bodies.

    A tool_result body can be as large as the 512KB spill threshold; the feed
    ships a text preview (`result_is_preview` tells the FE it's not the raw
    object). Copies before mutating — the store may hand back shared dicts.
    """
    if msg.get("type") not in TOOL_LEDGER_TYPES:
        return msg
    out = dict(msg)
    data = dict(out.get("data") or {})
    if out["type"] == "tool_result":
        data["result"] = tool_payload_preview(data.get("result"))
        data["result_is_preview"] = True
    else:
        arguments = data.get("arguments")
        if isinstance(arguments, str) and len(arguments) > TOOL_JOURNAL_PREVIEW_CHARS:
            data["arguments"] = tool_payload_preview(arguments)
            data["arguments_truncated"] = True
    out["data"] = data
    return out

router = APIRouter(prefix="/api/projects/{project_id}/messages", tags=["messages"], dependencies=[Depends(require_auth)])


class SendMessageRequest(BaseModel):
    """Request body for sending a user message."""
    content: str
    metadata: Optional[Dict[str, Any]] = None


@router.get("")
async def get_messages(
    project_id: str,
    after: int = 0,
    run_id: Optional[str] = None,
    limit: int = 1000,
    include_journal: bool = False,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """
    Get all messages for a project, ordered by sequence.

    Use `after` parameter for efficient polling/pagination.

    Args:
        project_id: Project ID
        after: Only return messages with sequence > this value
        run_id: Optional run ID filter
        limit: Maximum messages per stream (default 1000) — with
            include_journal, conversation and journal each get their own
            `limit` budget rather than sharing one window
        include_journal: Also return tool_call/tool_result records, with
            payloads replaced by bounded previews (see _journal_view)

    Returns:
        {
            "messages": [...],
            "latest_sequence": int
        }
    """
    message_store = deps.get_message_store()
    if not message_store:
        raise HTTPException(status_code=503, detail="Message store not initialized")
    storage, db_project = await load_authorized_project(project_id, tenant_ctx)

    if include_journal:
        # ADR-0008: journal volume must not consume conversation read windows.
        # The ledger writes two records per tool call, so one shared
        # oldest-first window would evict the newest conversation (the final
        # answer) after a single tool-heavy run. Journal takes its budget from
        # the newest end — recent activity and the hanging call are the point
        # of the feed, and the FE renders an elided-middle orphan gracefully.
        conversation, journal = await asyncio.gather(
            message_store.get_messages(
                project_id, after_sequence=after, run_id=run_id, limit=limit,
                exclude_types=list(TOOL_LEDGER_TYPES),
            ),
            message_store.get_messages(
                project_id, after_sequence=after, run_id=run_id, limit=limit,
                only_types=list(TOOL_LEDGER_TYPES), tail=True,
            ),
        )
        messages = sorted(
            [*conversation, *(_journal_view(m) for m in journal)],
            key=lambda m: m.get("sequence", 0),
        )
    else:
        # Ledger records stay excluded server-side — callers that don't
        # render them shouldn't pay for up-to-512KB bodies.
        messages = await message_store.get_messages(
            project_id,
            after_sequence=after,
            run_id=run_id,
            limit=limit,
            exclude_types=list(TOOL_LEDGER_TYPES),
        )
    latest_seq = await message_store.get_latest_sequence(project_id)

    # Same hydration as /api/projects/{id}: pending approval rows persisted with
    # an empty context_snapshot.artifacts (older bug, or a snapshot-timing race)
    # would otherwise render an empty Output card. Replace empty artifact lists
    # on PENDING approvals only — resolved rows keep their historical snapshot
    # so the audit trail of what-was-approved-when stays accurate.
    artifact_store = deps.get_artifact_store()
    if artifact_store is not None:
        # Per-run cache. Each pending approval message carries its own run_id
        # (loop-back gates and fork-and-rewind both create approvals scoped to
        # a specific run); workflow_engine._handle_approval_gate originally
        # captured the gate snapshot via get_all_files(project_id, run_id=run_id)
        # at gate emit time. Hydrating with the project-wide list mixes files
        # across runs (deduped by latest updated_at per path), which can show
        # the user files that don't belong to the run their approval is from.
        # Cache keyed by (m.get("run_id"), which may be None) so each distinct
        # run_id pays at most one DB roundtrip per request.
        cache: dict[Optional[str], list] = {}
        for m in messages or []:
            if not isinstance(m, dict) or m.get("type") != "approval":
                continue
            if (m.get("status") or "").lower() != "pending":
                continue
            data = m.get("data")
            if not isinstance(data, dict):
                continue
            snap = data.get("context_snapshot")
            if not isinstance(snap, dict) or snap.get("artifacts"):
                continue
            m_run_id = m.get("run_id")
            if m_run_id not in cache:
                try:
                    cache[m_run_id] = await artifact_store.get_all_files(project_id, run_id=m_run_id) or []
                except Exception:
                    cache[m_run_id] = []
            if cache[m_run_id]:
                snap["artifacts"] = cache[m_run_id]

    await attach_user_files_to_messages(
        messages,
        storage=storage,
        tenant_id=str((db_project or {}).get("tenant_id") or ""),
        project_id=project_id,
    )

    return {
        "messages": messages,
        "latest_sequence": latest_seq
    }


@router.get("/stream")
async def stream_messages(
    project_id: str,
    request: Request,
    after: int = 0,
    run_id: Optional[str] = None,
    include_journal: bool = False,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """
    SSE endpoint for real-time message updates.

    Sends new messages as they are appended.
    Uses polling internally (0.5s interval) to check for new messages.

    Args:
        project_id: Project ID
        after: Start streaming from messages with sequence > this value
        run_id: Optional run ID filter
        include_journal: Same journal opt-in + preview shaping as the REST
            fetch — both feeds must agree or the FE sees records disappear
            on live update
    """
    message_store = deps.get_message_store()
    if not message_store:
        raise HTTPException(status_code=503, detail="Message store not initialized")
    storage, db_project = await load_authorized_project(project_id, tenant_ctx)
    tenant_id = str((db_project or {}).get("tenant_id") or "")

    async def event_generator():
        # Always honor the caller's `after` value. Previously this endpoint
        # backfilled `last_seq` to the current latest sequence when after=0
        # ("to avoid sending all historical messages"), but that created a
        # race: the FE does a REST `GET /messages` first (which returns up
        # to sequence N), then connects SSE in a SEPARATE useEffect with
        # `after=0`. Any message inserted between the REST response and the
        # SSE connect (e.g. coding_agent's "Code Output" message N+1 and the
        # subsequent approval_requested N+2) fell into the gap — the SSE
        # backfilled past them and never delivered them. Verified on project
        # 7c2243a7 where the Code Output card only appeared after a manual
        # page refresh. With the backfill removed, after=0 sends every
        # message; the FE dedupes by id (useMessages.js:128-132) so the
        # overlap with REST is harmless.
        last_seq = after
        yield f"event: connected\ndata: {json.dumps({'project_id': project_id, 'last_sequence': last_seq})}\n\n"
        
        while True:
            if await request.is_disconnected():
                break
            
            try:
                # Same exclusion as the REST fetch above. last_seq only
                # advances past delivered messages, but that's safe: excluded
                # records are filtered in the query itself, so they are never
                # re-scanned into the stream on later polls.
                new_messages = await message_store.get_messages(
                    project_id,
                    after_sequence=last_seq,
                    run_id=run_id,
                    exclude_types=None if include_journal else list(TOOL_LEDGER_TYPES)
                )
                if include_journal:
                    new_messages = [_journal_view(m) for m in new_messages]

                await attach_user_files_to_messages(
                    new_messages,
                    storage=storage,
                    tenant_id=tenant_id,
                    project_id=project_id,
                )

                for msg in new_messages:
                    # Per-message try/except: messages come straight from Mongo
                    # via Motor, which decodes BSON Date fields as Python
                    # `datetime` objects. If a caller ever stuffed a datetime
                    # into `data`/`metadata` (or PyMongo decoded a stored
                    # Date), raw `json.dumps` raises TypeError("Object of
                    # type datetime is not JSON serializable") and the outer
                    # except below would abort the whole poll loop — silently
                    # blackholing every later message in this connection and
                    # forcing a refresh. Verified on project caebdc01 after
                    # the backfill removal exposed this latent issue: the
                    # error landed once in backend.log at 12:22:58 and from
                    # that point the FE never received any further messages
                    # until reload. Reuse the encoder events/emitter.py
                    # already uses (same bug was fixed there for the events
                    # SSE channel per the project 21b8c9e1 comment); skip the
                    # bad message but keep the stream alive.
                    try:
                        msg_json = json.dumps(msg, default=_sse_json_default)
                    except (TypeError, ValueError) as ser_err:
                        logger.exception(
                            "[messages-stream] failed to serialize msg id=%s seq=%s err=%s",
                            msg.get("id"), msg.get("sequence"), ser_err,
                        )
                        last_seq = msg["sequence"]
                        continue
                    yield f"event: message\ndata: {msg_json}\n\n"
                    last_seq = msg["sequence"]

            except Exception as e:
                logger.error(f"Error in message stream: {e}")
                yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
            
            await asyncio.sleep(0.5)
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@router.get("/pending-approval")
async def get_pending_approval(
    project_id: str,
    run_id: Optional[str] = None,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """
    Get the current pending approval message for a project.
    
    Returns null if no pending approval exists.
    """
    message_store = deps.get_message_store()
    if not message_store:
        raise HTTPException(status_code=503, detail="Message store not initialized")
    await load_authorized_project(project_id, tenant_ctx)
    
    approval = await message_store.get_pending_approval(project_id, run_id=run_id)
    return {"pending_approval": approval}


@router.get("/{message_id}")
async def get_message(
    project_id: str,
    message_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Get a single message by ID."""
    message_store = deps.get_message_store()
    if not message_store:
        raise HTTPException(status_code=503, detail="Message store not initialized")
    storage, db_project = await load_authorized_project(project_id, tenant_ctx)

    message = await message_store.get_message_by_id(message_id)
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")

    if message.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="Message not found in this project")

    await attach_user_files_to_messages(
        [message],
        storage=storage,
        tenant_id=str((db_project or {}).get("tenant_id") or ""),
        project_id=project_id,
    )
    return message


@router.post("")
async def send_message(
    project_id: str,
    request: Request,
    run_id: Optional[str] = None,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """
    Send a user message.
    
    This appends a user message to the message stream and routes it
    to the appropriate handler based on current project state.
    
    If there's a pending approval, the message is treated as feedback
    and triggers a refinement of that approval (requirements/plan).
    """
    message_store = deps.get_message_store()
    event_emitter = deps.get_event_emitter()
    orchestrator = deps.get_orchestrator()
    
    if not message_store:
        raise HTTPException(status_code=503, detail="Message store not initialized")
    storage, db_project = await load_authorized_project(project_id, tenant_ctx)
    content, metadata, files = await parse_send_payload(request)
    if files:
        files = prepare_send_files(files)
        content = resolve_send_content(content, files)

    # Always append the user message first (single source of truth)
    message = await message_store.append_user_message(
        project_id,
        content=content,
        run_id=run_id,
        metadata=metadata
    )

    if files:
        try:
            docs = await save_message_attachments(
                storage=storage,
                tenant_id=str((db_project or {}).get("tenant_id") or ""),
                project_id=project_id,
                files=files,
                message_id=message.get("id"),
                message_sequence=message.get("sequence"),
                run_id=run_id,
                created_by=tenant_ctx.user_id,
            )
        except HTTPException:
            await message_store.delete_message_in_project(project_id, message.get("id"))
            logger.warning(
                "[ATTACH] send rolled back message=%s project=%s",
                message.get("id"),
                project_id,
            )
            raise
        message["attachments"] = [public_user_attachment(d, project_id) for d in docs]
        tenant_id = str((db_project or {}).get("tenant_id") or "")
        for doc in docs:
            await emit_attachment_uploaded(
                project_id=project_id,
                tenant_id=tenant_id,
                doc=doc,
                run_id=run_id,
                message_id=message.get("id"),
            )
    
    # Emit event for real-time subscribers
    if event_emitter:
        await event_emitter.emit("message_appended", run_id, {
            "project_id": project_id,
            "message": message
        })

    # Build project_state + workflow context for intent classification.
    # The classifier needs to know which workflow is active (so it can map a
    # message like "redo requirements" onto a real workflow phase) and which
    # approval gate is pending (so feedback on it gets classified as
    # `feedback` directly, instead of falling through to `general` and being
    # rescued by an escalation hack in the router).
    current_phase = None
    shared_context = None
    db_proj = None
    if orchestrator:
        try:
            proj = orchestrator.active_projects.get(project_id)
            if proj:
                current_phase = proj.get("current_phase")
                shared_context = proj.get("shared_context")
        except Exception:
            pass
    if storage:
        try:
            db_proj = await storage.load_project(project_id)
            if db_proj and not current_phase:
                current_phase = db_proj.get("current_phase") or (db_proj.get("metadata", {}) or {}).get("phase")
        except Exception:
            pass

    project_state = {
        "phase": current_phase or "",
    }

    # Load the active workflow definition so the classifier sees real node
    # ids / phases instead of having to guess from a hardcoded enum.
    workflow_def = None
    if storage and db_proj:
        try:
            wid = db_proj.get("workflow_id") or "default_build"
            tenant_id = str(db_proj.get("tenant_id") or tenant_ctx.tenant_id or "").strip()
            wf = await storage.get_workflow_definition(
                wid,
                tenant_id=tenant_id or None,
            )
            if wf:
                if tenant_id:
                    wf = await resolve_tenant_config_for_read(
                        wf,
                        tenant_id=tenant_id,
                        resolve_configuration=storage.resolve_workflow_definition,
                    )
                workflow_def = wf
        except Exception:
            workflow_def = None

    # Pending approval (single source of truth: message store).
    pending_approval_type = None
    if message_store:
        try:
            pending = await message_store.get_pending_approvals_for_project(project_id, limit=1)
            if pending:
                pa = pending[0] or {}
                pending_approval_type = pa.get("subtype") or pa.get("type")
        except Exception:
            pass

    # Currently-registered agent types — workflow nodes name agent types but
    # auction-selection nodes don't, so the pool fills in the rest.
    available_agent_types = None
    if orchestrator and getattr(orchestrator, "agent_pool", None):
        try:
            available_agent_types = []
            for a in orchestrator.agent_pool:
                at = getattr(a, "agent_type", None)
                v = getattr(at, "value", None) if at is not None else None
                if v:
                    available_agent_types.append(v)
                elif at:
                    available_agent_types.append(str(at))
        except Exception:
            available_agent_types = None

    classification = {"intent": "general", "agent": None, "target_phase": None, "summary": content}
    # Resolved once: the classifier's model fallback and the router's degraded
    # (no-loaded-project) fallback both need the tenant, and the router call
    # below reads it unconditionally.
    classifier_tenant_id = str(
        (db_proj or {}).get("tenant_id") or tenant_ctx.tenant_id or ""
    ).strip() or None
    if orchestrator and getattr(orchestrator, "llm_client", None):
        # Emit a status event so the FE can show "Processing your message…"
        # while the classifier LLM call is in flight. Verified roundtrip on
        # project 2bbc159e was 30s (backend.log:498-500) — during that window
        # only `message_appended` had been emitted, which the FE has no
        # semantic hook for ("did the user just submit feedback on the open
        # approval gate, or just chat?" — only the classifier knows).
        # The `*_started` / `*_completed` pairing is handled generically by
        # LiveActivity's resolvedStartedRoots logic, so no FE-side resolver
        # needs to know about these event names.
        if event_emitter:
            try:
                await event_emitter.emit("intent_routing_started", run_id, {
                    "project_id": project_id,
                    "message_id": message.get("id"),
                    "pending_approval_type": pending_approval_type,
                })
            except Exception:
                pass
        try:
            classifier = IntentClassifier(orchestrator.llm_client, storage=storage)
            classification = await classifier.classify_user_intent(
                message=content,
                project_state=project_state,
                shared_context=shared_context,
                workflow_def=workflow_def,
                pending_approval_type=pending_approval_type,
                available_agent_types=available_agent_types,
                tenant_id=classifier_tenant_id,
            )
        except Exception:
            pass
        if event_emitter:
            try:
                await event_emitter.emit("intent_routing_completed", run_id, {
                    "project_id": project_id,
                    "message_id": message.get("id"),
                    "intent": classification.get("intent"),
                    "target_phase": classification.get("target_phase"),
                })
            except Exception:
                pass

    try:
        logger.info(
            "[INTENT] classified project_id=%s message_id=%s intent=%s agent=%s target_phase=%s pending_approval=%s",
            project_id,
            message.get("id"),
            classification.get("intent"),
            classification.get("agent"),
            classification.get("target_phase"),
            pending_approval_type,
        )
    except Exception:
        pass

    return await route_user_message(
        project_id=project_id,
        content=content,
        message=message,
        classification=classification,
        run_id=run_id,
        message_store=message_store,
        event_emitter=event_emitter,
        orchestrator=orchestrator,
        tenant_id=classifier_tenant_id,
    )

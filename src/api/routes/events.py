"""SSE event streaming routes"""

from fastapi import APIRouter, Depends, HTTPException, Request
from api.auth.middleware import require_auth
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import verify_project_tenant
from fastapi.responses import StreamingResponse
from typing import Optional
from datetime import datetime
import asyncio
import json

from api.deps import get_event_emitter, get_storage
from events.emitter import _sse_json_default
router = APIRouter(tags=["events"], dependencies=[Depends(require_auth)])

# Ends the history replay: every frame after it happened live, which is how the
# UI tells a revert finishing now from one replayed on refresh. It has no `id:`
# line, so the client's Last-Event-ID keeps pointing at the last real event.
REPLAY_COMPLETE_FRAME = "event: replay_complete\ndata: {}\n\n"

REPLAY_PAGE_SIZE = 1000


@router.get("/api/projects/{project_id}/events")
async def stream_events(
    project_id: str,
    request: Request,
    since: Optional[str] = None,
    run_id: Optional[str] = None,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Server-Sent Events stream for real-time updates."""
    event_emitter = get_event_emitter()
    storage = get_storage()
    
    if not event_emitter:
        raise HTTPException(status_code=500, detail="Event emitter not initialized")
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")

    db_project = await storage.load_project(project_id)
    await verify_project_tenant(db_project, tenant_ctx)
    
    # Subscribe BEFORE replaying so any events emitted during the replay
    # query land in the queue. Frontend watermark dedups the overlap between
    # the tail of replay and the head of live.
    queue = event_emitter.subscribe(project_id)

    def _parse_since(value: Optional[str]) -> Optional[datetime]:
        if not value:
            return None
        try:
            cleaned = value.strip()
            if cleaned.endswith("Z"):
                cleaned = cleaned[:-1] + "+00:00"
            return datetime.fromisoformat(cleaned)
        except Exception:
            return None

    async def _stored_history():
        # UUID v7 preserves event order; since is used only to seed the first page.
        after_event_id = request.headers.get("last-event-id")
        since_dt = None if after_event_id else _parse_since(since)
        # Read to the end in pages: a long run outgrows one page, and whatever
        # the replay stops short of never reaches this client.
        while True:
            page = await storage.get_events(
                project_id=project_id,
                since=since_dt,
                after_event_id=after_event_id,
                run_id=run_id,
                limit=REPLAY_PAGE_SIZE,
            )
            for event in page:
                yield event
            if len(page) < REPLAY_PAGE_SIZE or not page[-1].get('event_id'):
                return
            after_event_id = page[-1]['event_id']

    async def event_generator():
        try:
            # Replay historical events from MongoDB.
            if hasattr(storage, "get_events"):
                try:
                    # Event types that should NOT be replayed on reconnect
                    # (they are transient errors/notifications, not state changes)
                    skip_on_replay = {"project_revert_failed", "project_reverting", "project_stopping"}

                    async for event in _stored_history():
                        event_type = event.get('type', '')
                        if event_type in skip_on_replay:
                            continue
                        # Skip pre-backfill rows where event_id is missing.
                        # Yielding `id: None` makes the browser store the
                        # literal string "None" as Last-Event-ID; the next
                        # reconnect sends it back as after_event_id and
                        # {$gt: "None"} matches no UUID v7 ('N' > all hex
                        # chars), so the entire replay window is empty
                        # forever. Run scripts/backfill_event_id.py to
                        # populate these rows.
                        event_id = event.get('event_id')
                        if not event_id:
                            continue
                        # Match the live path (emitter.py:_sse_json_default):
                        # one bad event must not abandon the rest of the
                        # replay batch. mongo_backend._sanitize covers only
                        # datetime+ObjectId, so Decimal (LLM cost rows) and
                        # UUID still slip through and the raw json.dumps
                        # would TypeError, drop into the outer except, and
                        # skip every later event.
                        try:
                            data_json = json.dumps(event['data'], default=_sse_json_default)
                        except (TypeError, ValueError) as e:
                            print(f"⚠️  Failed to serialize replay event type={event_type} event_id={event_id}: {e}")
                            continue
                        yield f"event: {event_type}\n"
                        yield f"data: {data_json}\n"
                        yield f"id: {event_id}\n\n"
                except Exception as e:
                    print(f"⚠️  Failed to replay events: {e}")

            yield REPLAY_COMPLETE_FRAME

            # Stream live events
            async for event in event_emitter.stream_events(queue):
                yield event
        except asyncio.CancelledError:
            pass
        finally:
            event_emitter.unsubscribe(project_id, queue)
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream"
    )

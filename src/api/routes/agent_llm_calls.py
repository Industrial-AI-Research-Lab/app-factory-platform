"""Agent LLM call capture (Inspector) endpoints.

UI surface over the `agent_llm_calls` Mongo collection. Operators may also
query the collection directly — see storage/agent_llm_calls_store.py (storage contract).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from api.auth.middleware import require_auth
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import load_authorized_project, verify_project_tenant
from api.deps import get_agent_llm_calls_store, get_storage

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api",
    tags=["agent-llm-calls"],
    dependencies=[Depends(require_auth)],
)


def _store_or_fail():
    store = get_agent_llm_calls_store()
    if store is None:
        raise HTTPException(status_code=500, detail="agent_llm_calls store not initialized")
    return store


async def _load_call_and_verify(
    call_id: str,
    ctx: TenantContext,
) -> Dict[str, Any]:
    store = _store_or_fail()
    doc = await store.get_call(call_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Call not found")
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")
    db_project = await storage.load_project(doc.get("project_id"))
    await verify_project_tenant(db_project, ctx, label="Call")
    return doc


@router.get("/projects/{project_id}/agent-llm-calls")
async def list_project_calls(
    project_id: str,
    agent_id: Optional[str] = Query(None),
    run_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    ctx: TenantContext = Depends(get_tenant_context),
) -> Dict[str, Any]:
    """List summary view of captured LLM invocations for a project."""
    await load_authorized_project(project_id, ctx, label="Project")
    store = _store_or_fail()
    items = await store.list_calls(
        project_id=project_id,
        agent_id=agent_id,
        run_id=run_id,
        limit=limit,
    )
    return {"items": items, "count": len(items)}


@router.get("/agent-llm-calls/{call_id}")
async def get_call(
    call_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
) -> Dict[str, Any]:
    """Return the full capture doc for a single invocation."""
    return await _load_call_and_verify(call_id, ctx)


@router.post("/agent-llm-calls/{call_id}/flag")
async def flag_call(
    call_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
) -> Dict[str, Any]:
    """Mark a capture doc as flagged (exempt from TTL)."""
    await _load_call_and_verify(call_id, ctx)
    store = _store_or_fail()
    matched = await store.flag_call(call_id)
    if not matched:
        raise HTTPException(status_code=404, detail="Call not found")
    return {"call_id": call_id, "flagged": True}

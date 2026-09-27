"""Read-only aggregate execution trace endpoint."""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from api.auth.middleware import require_auth
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import load_authorized_project
from api.deps import get_agent_llm_calls_store, get_artifact_store, get_message_store, get_storage
from orchestration.execution_trace_builder import ExecutionTraceBuilder, InvalidTracePayloadSelection

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["execution-trace"], dependencies=[Depends(require_auth)])


@router.get("/projects/{project_id}/execution-trace")
async def get_execution_trace(
    project_id: str,
    run_id: Optional[str] = Query(None),
    include_payloads: bool = Query(False),
    payload_node_id: Optional[str] = Query(None),
    ctx: TenantContext = Depends(get_tenant_context),
) -> Dict[str, Any]:
    storage, project = await load_authorized_project(project_id, ctx, label="Project")
    messages = get_message_store()
    llm = get_agent_llm_calls_store()
    if not storage or not messages or not llm:
        raise HTTPException(status_code=500, detail="Trace storage is not initialized")
    try:
        result = await ExecutionTraceBuilder(
            storage=storage,
            message_store=messages,
            llm_calls_store=llm,
            artifact_store=get_artifact_store(),
        ).build(
            project, run_id, include_payloads, payload_node_id
        )
    except InvalidTracePayloadSelection as exc:
        message = str(exc)
        status = 404 if "live project run" in message else 422
        raise HTTPException(status_code=status, detail=message) from exc
    logger.info(
        "[TRACE_VIEW] project_id=%s run_id=%s nodes=%d edges=%d status=%s",
        project_id, run_id or "all", len(result.get("nodes", [])),
        len(result.get("edges", [])), result.get("completeness", {}).get("status"),
    )
    return result

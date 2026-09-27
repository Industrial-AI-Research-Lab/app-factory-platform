"""SSE events and structured logs for file attachments (AppFactory-257 step 11)."""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


def attachment_event_payload(
    doc: dict[str, Any],
    *,
    tenant_id: str,
    project_id: str,
    message_id: Optional[str] = None,
) -> dict[str, Any]:
    payload = {
        "project_id": project_id,
        "tenant_id": tenant_id,
        "attachment_id": str(doc.get("_id") or ""),
        "filename": doc.get("filename"),
        "size_bytes": doc.get("size_bytes"),
        "content_type": doc.get("content_type"),
    }
    if message_id:
        payload["message_id"] = message_id
    return payload


async def emit_attachment_uploaded(
    *,
    project_id: str,
    tenant_id: str,
    doc: dict[str, Any],
    run_id: Optional[str] = None,
    message_id: Optional[str] = None,
) -> None:
    payload = attachment_event_payload(
        doc,
        tenant_id=tenant_id,
        project_id=project_id,
        message_id=message_id,
    )
    logger.info(
        "[ATTACH] event=attachment_uploaded project=%s attachment=%s filename=%s size=%s",
        project_id,
        payload["attachment_id"],
        payload.get("filename"),
        payload.get("size_bytes"),
    )
    from api import deps

    emitter = deps.get_event_emitter()
    if emitter:
        await emitter.emit("attachment_uploaded", run_id, payload)


async def emit_attachment_deleted(
    *,
    project_id: str,
    tenant_id: str,
    doc: dict[str, Any],
    run_id: Optional[str] = None,
    reason: str = "deleted",
) -> None:
    payload = attachment_event_payload(doc, tenant_id=tenant_id, project_id=project_id)
    payload["reason"] = reason
    logger.info(
        "[ATTACH] event=attachment_deleted project=%s attachment=%s reason=%s",
        project_id,
        payload["attachment_id"],
        reason,
    )
    from api import deps

    emitter = deps.get_event_emitter()
    if emitter:
        await emitter.emit("attachment_deleted", run_id, payload)


def log_tenant_artifact_event(
    event_type: str,
    *,
    tenant_id: str,
    doc: dict[str, Any] | None = None,
    artifact_id: str | None = None,
) -> None:
    """Tenant artifacts are tenant-scoped; EventEmitter requires project_id for SSE."""
    aid = artifact_id or str((doc or {}).get("_id") or "")
    logger.info(
        "[TENANT_ARTIFACT] event=%s tenant=%s artifact=%s filename=%s size=%s",
        event_type,
        tenant_id,
        aid,
        (doc or {}).get("filename"),
        (doc or {}).get("size_bytes"),
    )

"""Archive ref listing, download-url and content routes.

The bucket, object keys and credentials never leave the backend: a client
gets only a signed URL it is about to dereference, or the bytes themselves.

Ownership: ``load_authorized_project`` proves the caller's tenant owns the
project; the record must then belong to THAT project. ``record.tenant_id`` is
never consulted — absent tenants collapse to ``__root__`` at spill time, so it
cannot be an authority (ADR-0005). The check runs before a URL is minted or a
byte is read: presigned URLs are bearer capabilities and outlive any later
check.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from api.auth.middleware import require_auth
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import load_authorized_project
from api.routes.archive_download import download_disposition, is_file_artifact
from storage.archive_store import ArchiveStore

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/projects", tags=["archive"], dependencies=[Depends(require_auth)])

DEFAULT_DOWNLOAD_URL_TTL_SECONDS = 300
_LIST_LIMIT_CAP = 500
_LIST_PREVIEW_MAX_CHARS = 500
_GONE_DETAIL = "archived object is no longer in storage (most likely expired by retention)"


def _download_ttl_seconds() -> int:
    raw = os.getenv("ARCHIVE_DOWNLOAD_URL_TTL_SECONDS")
    try:
        ttl = int(raw) if raw else DEFAULT_DOWNLOAD_URL_TTL_SECONDS
    except ValueError:
        ttl = DEFAULT_DOWNLOAD_URL_TTL_SECONDS
    return ttl if ttl > 0 else DEFAULT_DOWNLOAD_URL_TTL_SECONDS


def _public_record(record: Dict[str, Any], *, full_preview: bool) -> Dict[str, Any]:
    """The client-safe view of a locator record — no bucket, no object keys."""
    out: Dict[str, Any] = {"ref_id": record.get("_id")}
    for field in ("size_bytes", "content_type", "sha256", "est_tokens", "tool_id", "agent_id", "run_id", "path"):
        if record.get(field) is not None:
            out[field] = record[field]
    created = record.get("created_at")
    if created is not None:
        out["created_at"] = created.isoformat() if hasattr(created, "isoformat") else str(created)
    preview = record.get("preview")
    if isinstance(preview, str):
        out["preview"] = preview if full_preview else preview[:_LIST_PREVIEW_MAX_CHARS]
    reps = record.get("representations")
    if isinstance(reps, dict):
        out["representations"] = {
            name: {k: rep[k] for k in ("content_type", "size_bytes", "kind") if rep.get(k) is not None}
            for name, rep in reps.items()
            if isinstance(rep, dict)
        }
    return out


@router.get("/{project_id}/archive")
async def list_archive_refs(
    project_id: str,
    limit: int = 100,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Locator records for a project's archived results, newest first."""
    storage, _ = await load_authorized_project(project_id, tenant_ctx)
    limit = max(1, min(int(limit), _LIST_LIMIT_CAP))
    cursor = storage.archive_refs.find({"project_id": project_id}).sort("created_at", -1).limit(limit)
    docs = await cursor.to_list(length=limit)
    return {"refs": [_public_record(d, full_preview=False) for d in docs]}


async def _owned_record(project_id: str, ref_id: str, tenant_ctx: TenantContext):
    storage, _ = await load_authorized_project(project_id, tenant_ctx)
    record = await storage.archive_refs.find_one({"_id": ref_id})
    if not record or record.get("project_id") != project_id:
        # same 404 for missing and foreign — no existence oracle across projects
        logger.warning("[ARCHIVE] ref=%s project=%s — unknown or another project's ref", ref_id, project_id)
        raise HTTPException(status_code=404, detail="unknown or inaccessible ref_id")
    return storage, record


async def _stored_object(storage, record: Dict[str, Any], ref_id: str):
    """The store, key and HEAD of a record's object, or the HTTP error that says why not."""
    object_key = record.get("object_key")
    if not object_key:
        logger.warning("[ARCHIVE] ref=%s — record has no stored object", ref_id)
        raise HTTPException(status_code=404, detail="record has no stored object")

    store = ArchiveStore.from_env(storage)
    if not store.is_configured():
        logger.error("[ARCHIVE] ref=%s — archive object storage is not configured", ref_id)
        raise HTTPException(status_code=503, detail="archive object storage is not configured")

    try:
        head = await store.head_blob(object_key)
    except Exception as exc:
        logger.error("[ARCHIVE] head failed for %s: %s", ref_id, exc)
        raise HTTPException(status_code=502, detail="archive storage unavailable")
    if head is None:
        # advisory-index contract: the record outlives the object (retention)
        logger.warning("[ARCHIVE] ref=%s — object gone from storage", ref_id)
        raise HTTPException(status_code=404, detail=_GONE_DETAIL)
    return store, object_key, head


def _object_length(head: Dict[str, Any], record: Dict[str, Any]) -> Optional[int]:
    """Bytes the stream will carry: the object's own length before the record's
    advisory size, since a wrong Content-Length breaks the response."""
    for value in (head.get("ContentLength"), record.get("size_bytes")):
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    return None


@router.get("/{project_id}/archive/{ref_id}")
async def get_archive_ref(
    project_id: str,
    ref_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """One locator record with its full preview (still metadata-only)."""
    _, record = await _owned_record(project_id, ref_id, tenant_ctx)
    return _public_record(record, full_preview=True)


@router.get("/{project_id}/archive/{ref_id}/download-url")
async def get_archive_download_url(
    project_id: str,
    ref_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Mint a short-TTL presigned GET that saves the byte-exact raw object as a named file."""
    storage, record = await _owned_record(project_id, ref_id, tenant_ctx)
    store, object_key, _ = await _stored_object(storage, record, ref_id)

    ttl = _download_ttl_seconds()
    disposition = download_disposition(record)
    try:
        url = await store.presign_get(object_key, ttl, content_disposition=disposition)
    except Exception as exc:
        logger.error("[ARCHIVE] presign failed for %s: %s", ref_id, exc)
        raise HTTPException(status_code=502, detail="failed to mint download url")

    logger.info("[ARCHIVE] download-url ref=%s project=%s ttl=%d — %s", ref_id, project_id, ttl, disposition)
    return {
        "ref_id": ref_id,
        "url": url,
        "expires_in_seconds": ttl,
        "size_bytes": record.get("size_bytes"),
        "content_type": record.get("content_type"),
        "sha256": record.get("sha256"),
    }


@router.get("/{project_id}/archive/{ref_id}/content")
async def get_archive_content(
    project_id: str,
    ref_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Stream a generated file moved to object storage, for the in-browser ZIP,
    which cannot read the storage domain. Tool results are refused: they can be
    tens of megabytes and download through download-url, past this process."""
    storage, record = await _owned_record(project_id, ref_id, tenant_ctx)
    if not is_file_artifact(record):
        logger.warning("[ARCHIVE] content refused ref=%s project=%s — not a generated file", ref_id, project_id)
        raise HTTPException(status_code=404, detail="not a generated file; tool results download via download-url")
    store, object_key, head = await _stored_object(storage, record, ref_id)

    try:
        chunks = await store.open_blob_stream(object_key)
    except Exception as exc:
        logger.error("[ARCHIVE] content read failed for %s: %s", ref_id, exc)
        raise HTTPException(status_code=502, detail="archive storage unavailable")
    if chunks is None:
        logger.warning("[ARCHIVE] ref=%s — object gone between HEAD and GET", ref_id)
        raise HTTPException(status_code=404, detail=_GONE_DETAIL)

    headers = {
        "Content-Type": record.get("content_type") or "application/octet-stream",
        "Content-Disposition": download_disposition(record),
    }
    length = _object_length(head, record)
    if length is not None:
        headers["Content-Length"] = str(length)
    logger.info("[ARCHIVE] content ref=%s project=%s bytes=%s", ref_id, project_id, length)
    return StreamingResponse(chunks, headers=headers)

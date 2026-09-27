"""Tenant-shared artifacts: admin writes, whole tenant reads. Cross-tenant is 404."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from api import deps
from api.auth.middleware import require_auth, require_role
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.routes.file_attachments import (
    _download_ttl_seconds,
    _form_files_http,
    _form_text,
    parse_multipart_form,
    text_preview_payload,
)
from api.routes.file_attachment_events import log_tenant_artifact_event
from storage.file_attachment_store import FileAttachmentStore
from storage.file_blob_store import FileBlobStore
from storage.file_upload_validation import FileUploadError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tenants", tags=["tenant-artifacts"], dependencies=[Depends(require_auth)])

_NOT_FOUND = "Artifact not found"


def _store(blob: FileBlobStore | None = None) -> FileAttachmentStore:
    return FileAttachmentStore(deps.get_storage(), blob or FileBlobStore())


def _require_visible_tenant(tenant_id: str, ctx: TenantContext) -> None:
    if not tenant_id:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    if ctx.is_root or ctx.tenant_id == tenant_id:
        return
    logger.warning("[TENANT_ARTIFACT] deny tenant=%s actor=%s", tenant_id, ctx.tenant_id)
    raise HTTPException(status_code=404, detail=_NOT_FOUND)


def public_tenant_artifact(doc: dict[str, Any], tenant_id: str) -> dict[str, Any]:
    aid = str(doc.get("_id") or "")
    return {
        "id": aid,
        "filename": doc.get("filename"),
        "content_type": doc.get("content_type"),
        "size_bytes": doc.get("size_bytes"),
        "title": doc.get("title"),
        "description": doc.get("description"),
        "created_at": doc.get("created_at"),
        "updated_at": doc.get("updated_at"),
        # Path without /api — UI resolves via apiUrl(VITE_API_BASE), same as archive.
        "download_url": f"/tenants/{tenant_id}/artifacts/{aid}/content",
        "preview_url": f"/tenants/{tenant_id}/artifacts/{aid}/preview",
    }


def _http_upload_error(exc: FileUploadError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


@router.get("/{tenant_id}/artifacts")
async def list_tenant_artifacts(
    tenant_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
):
    _require_visible_tenant(tenant_id, ctx)
    rows, truncated = await _store().list_tenant_artifacts(tenant_id=tenant_id)
    return {
        "artifacts": [public_tenant_artifact(row, tenant_id) for row in rows],
        "truncated": truncated,
    }


@router.get("/{tenant_id}/artifacts/{artifact_id}")
async def get_tenant_artifact(
    tenant_id: str,
    artifact_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
):
    _require_visible_tenant(tenant_id, ctx)
    doc = await _store().get_tenant_artifact(tenant_id=tenant_id, artifact_id=artifact_id)
    if not doc:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return public_tenant_artifact(doc, tenant_id)


@router.get("/{tenant_id}/artifacts/{artifact_id}/preview")
async def preview_tenant_artifact(
    tenant_id: str,
    artifact_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Read-only UTF-8 text of a shared artifact. Same visibility guard as download."""
    _require_visible_tenant(tenant_id, ctx)
    doc = await _store().get_tenant_artifact(tenant_id=tenant_id, artifact_id=artifact_id)
    if not doc:
        logger.warning("[TENANT_ARTIFACT] preview deny tenant=%s id=%s", tenant_id, artifact_id)
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return await text_preview_payload(doc)


@router.get("/{tenant_id}/artifacts/{artifact_id}/content")
async def download_tenant_artifact(
    tenant_id: str,
    artifact_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
):
    _require_visible_tenant(tenant_id, ctx)
    doc = await _store().get_tenant_artifact(tenant_id=tenant_id, artifact_id=artifact_id)
    if not doc:
        logger.warning("[TENANT_ARTIFACT] download deny tenant=%s id=%s", tenant_id, artifact_id)
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    object_key = doc.get("object_key")
    if not object_key:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)

    blob = FileBlobStore.from_env()
    if not blob.is_configured():
        raise HTTPException(status_code=503, detail="object storage is not configured")
    try:
        head = await blob.head_blob(object_key)
    except Exception as exc:
        logger.error("[TENANT_ARTIFACT] head failed id=%s: %s", artifact_id, exc)
        raise HTTPException(status_code=502, detail="object storage unavailable") from exc
    if head is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    ttl = _download_ttl_seconds()
    try:
        url = await blob.presign_get(object_key, ttl)
    except Exception as exc:
        logger.error("[TENANT_ARTIFACT] presign failed id=%s: %s", artifact_id, exc)
        raise HTTPException(status_code=502, detail="failed to mint download url") from exc
    logger.info("[TENANT_ARTIFACT] download-url id=%s tenant=%s", artifact_id, tenant_id)
    return {
        "artifact_id": artifact_id,
        "url": url,
        "expires_in_seconds": ttl,
        "size_bytes": doc.get("size_bytes"),
        "content_type": doc.get("content_type"),
        "filename": doc.get("filename"),
    }


@router.post("/{tenant_id}/artifacts")
async def create_tenant_artifact(
    tenant_id: str,
    request: Request,
    ctx: TenantContext = Depends(get_tenant_context),
    _admin: dict = Depends(require_role("tenant_admin")),
):
    _require_visible_tenant(tenant_id, ctx)
    ctype = (request.headers.get("content-type") or "").lower()
    if "multipart/form-data" not in ctype:
        raise HTTPException(status_code=400, detail="multipart/form-data required")
    form = await parse_multipart_form(request)
    files = await _form_files_http(form)
    if not files:
        raise HTTPException(status_code=400, detail="file required")
    try:
        docs = await FileAttachmentStore(deps.get_storage(), FileBlobStore.from_env()).save_tenant_artifact(
            tenant_id=tenant_id,
            files=files,
            created_by=ctx.user_id,
        )
    except FileUploadError as exc:
        raise _http_upload_error(exc) from exc
    for doc in docs:
        log_tenant_artifact_event("tenant_artifact_uploaded", tenant_id=tenant_id, doc=doc)
    return {"artifacts": [public_tenant_artifact(doc, tenant_id) for doc in docs]}


@router.patch("/{tenant_id}/artifacts/{artifact_id}")
async def update_tenant_artifact(
    tenant_id: str,
    artifact_id: str,
    request: Request,
    ctx: TenantContext = Depends(get_tenant_context),
    _admin: dict = Depends(require_role("tenant_admin")),
):
    _require_visible_tenant(tenant_id, ctx)
    title: Optional[str] = None
    description: Any = ...
    files: list[dict] = []
    ctype = (request.headers.get("content-type") or "").lower()
    if "multipart/form-data" in ctype:
        form = await parse_multipart_form(request)
        files = await _form_files_http(form)
        raw_title = _form_text(form, "title")
        if raw_title is not None:
            title = raw_title
        if form.get("description") is not None and not hasattr(form.get("description"), "read"):
            description = str(form.get("description"))
    else:
        try:
            body = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="JSON or multipart required") from exc
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="JSON object required")
        if "title" in body:
            title = None if body["title"] is None else str(body["title"])
        if "description" in body:
            description = body["description"]
        extra = set(body) - {"title", "description"}
        if extra:
            raise HTTPException(status_code=400, detail="unknown fields")

    if title is None and description is ... and not files:
        raise HTTPException(status_code=400, detail="nothing to update")
    try:
        doc = await FileAttachmentStore(deps.get_storage(), FileBlobStore.from_env()).update_tenant_artifact(
            tenant_id=tenant_id,
            artifact_id=artifact_id,
            title=title,
            description=description,
            files=files or None,
            updated_by=ctx.user_id,
        )
    except FileUploadError as exc:
        raise _http_upload_error(exc) from exc
    if not doc:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    log_tenant_artifact_event("tenant_artifact_updated", tenant_id=tenant_id, doc=doc)
    return public_tenant_artifact(doc, tenant_id)


@router.delete("/{tenant_id}/artifacts/{artifact_id}")
async def delete_tenant_artifact(
    tenant_id: str,
    artifact_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
    _admin: dict = Depends(require_role("tenant_admin")),
):
    _require_visible_tenant(tenant_id, ctx)
    doc = await FileAttachmentStore(deps.get_storage(), FileBlobStore.from_env()).delete_tenant_artifact(
        tenant_id=tenant_id,
        artifact_id=artifact_id,
    )
    if not doc:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    log_tenant_artifact_event("tenant_artifact_deleted", tenant_id=tenant_id, doc=doc)
    return {"id": str(doc.get("_id") or ""), "deleted": True}

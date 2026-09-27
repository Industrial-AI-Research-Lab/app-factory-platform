"""Project user-attachment download and chat upload. Isolation lives in FileAttachmentStore."""

from __future__ import annotations

import json
import logging
import os
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import Response

from api.auth.middleware import require_auth
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import load_authorized_project
from starlette.formparsers import MultiPartException, MultiPartParser

from storage.file_attachment_store import FileAttachmentStore
from storage.file_blob_store import FileBlobStore
from storage.office_text import extract_office_text
from storage.file_upload_validation import (
    FileUploadError,
    load_limits,
    multipart_body_budget_bytes,
    validate_batch,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/projects", tags=["attachments"], dependencies=[Depends(require_auth)])

DEFAULT_DOWNLOAD_URL_TTL_SECONDS = 300
_NOT_FOUND = "Attachment not found"


def _download_ttl_seconds() -> int:
    raw = os.getenv("FILE_DOWNLOAD_URL_TTL_SECONDS")
    try:
        ttl = int(raw) if raw else DEFAULT_DOWNLOAD_URL_TTL_SECONDS
    except ValueError:
        ttl = DEFAULT_DOWNLOAD_URL_TTL_SECONDS
    return ttl if ttl > 0 else DEFAULT_DOWNLOAD_URL_TTL_SECONDS


USER_ATTACHMENTS_FOLDER = "user_attachments"

# Read-only preview cap: enough for any text upload, small enough to stay off the
# streaming path. Larger files are served truncated with a UI banner.
PREVIEW_MAX_BYTES = 1024 * 1024

TEXT_PREVIEW_EXTENSIONS = frozenset(
    {
        ".txt",
        ".md",
        ".py",
        ".json",
        ".csv",
        ".js",
        ".jsx",
        ".ts",
        ".tsx",
        ".yml",
        ".yaml",
        ".html",
        ".css",
        ".sh",
    }
)
OFFICE_PREVIEW_EXTENSIONS = frozenset({".docx", ".xlsx"})
# Zip containers need the whole file; extract is then capped to PREVIEW_MAX_BYTES.
OFFICE_PREVIEW_FETCH_BYTES = 8 * 1024 * 1024


def public_user_attachment(doc: dict[str, Any], project_id: str) -> dict[str, Any]:
    aid = str(doc.get("_id") or "")
    filename = str(doc.get("filename") or "file")
    return {
        "id": aid,
        "filename": filename,
        "content_type": doc.get("content_type"),
        "size_bytes": doc.get("size_bytes"),
        # Virtual folder on the Artifacts tab — not an ArtifactStore path.
        "path": f"{USER_ATTACHMENTS_FOLDER}/{filename}",
        # Path without /api — UI resolves via apiUrl(VITE_API_BASE), same as archive.
        "download_url": f"/projects/{project_id}/attachments/{aid}",
        "preview_url": f"/projects/{project_id}/attachments/{aid}/preview",
    }


async def text_preview_payload(doc: dict[str, Any]) -> dict[str, Any]:
    """UTF-8 text of a stored blob for read-only preview.

    Goes through the API instead of the presigned URL so the browser never needs
    CORS on the object store, and the same auth guard covers preview and download.
    docx/xlsx return a plain-text extract (not a layout-faithful Office view).
    """
    filename = str(doc.get("filename") or "file")
    dot = filename.rfind(".")
    ext = filename[dot:].lower() if dot > 0 else ""
    office = ext in OFFICE_PREVIEW_EXTENSIONS
    if ext not in TEXT_PREVIEW_EXTENSIONS and not office:
        raise HTTPException(
            status_code=415,
            detail=f"{ext or 'This file type'} cannot be previewed as text",
        )

    object_key = doc.get("object_key")
    if not object_key:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)

    blob = FileBlobStore.from_env()
    if not blob.is_configured():
        raise HTTPException(status_code=503, detail="object storage is not configured")

    fetch_cap = OFFICE_PREVIEW_FETCH_BYTES if office else PREVIEW_MAX_BYTES
    data = await blob.get_blob(object_key, max_bytes=fetch_cap + 1)
    if data is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)

    truncated_fetch = len(data) > fetch_cap
    data = data[:fetch_cap]

    if office:
        try:
            text, extracted_truncated = extract_office_text(
                filename, data, max_bytes=PREVIEW_MAX_BYTES
            )
        except ValueError as exc:
            raise HTTPException(status_code=415, detail="could not extract text from this file") from exc
        return {
            "filename": filename,
            "content_type": doc.get("content_type"),
            "size_bytes": doc.get("size_bytes"),
            "text": text,
            "truncated": truncated_fetch or extracted_truncated,
            "extracted": True,
        }

    truncated = truncated_fetch
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        if not truncated:
            raise HTTPException(status_code=415, detail="file is not UTF-8 text") from exc
        text = data.decode("utf-8", errors="ignore")

    return {
        "filename": filename,
        "content_type": doc.get("content_type"),
        "size_bytes": doc.get("size_bytes"),
        "text": text,
        "truncated": truncated,
        "extracted": False,
    }


async def load_public_user_attachments(
    *,
    storage,
    tenant_id: str,
    project_id: str,
    limit: int = 200,
    skip: int = 0,
) -> tuple[list[dict[str, Any]], bool]:
    """Project-scoped user files for Artifacts tab. Empty on missing scope.

    Returns ``(rows, truncated)`` — truncated when the store cap hid older files.
    """
    if not storage or not tenant_id or not project_id:
        return [], False
    rows, truncated = await FileAttachmentStore(storage, FileBlobStore()).list_user_attachments(
        tenant_id=tenant_id,
        project_id=project_id,
        limit=limit,
        skip=skip,
    )
    return [public_user_attachment(row, project_id) for row in rows], truncated


async def attach_user_files_to_messages(
    messages: list,
    *,
    storage,
    tenant_id: str,
    project_id: str,
) -> None:
    """Stamp attachments[] onto messages that have files. Mutates in place."""
    if not storage or not tenant_id or not messages:
        return
    ids = [m.get("id") for m in messages if isinstance(m, dict) and m.get("id")]
    if not ids:
        return
    rows = await FileAttachmentStore(storage, FileBlobStore()).list_user_attachments_for_messages(
        tenant_id=tenant_id,
        project_id=project_id,
        message_ids=ids,
    )
    by_msg: dict[str, list] = {}
    for row in rows:
        mid = row.get("message_id")
        if not mid:
            continue
        by_msg.setdefault(mid, []).append(public_user_attachment(row, project_id))
    for msg in messages:
        if isinstance(msg, dict) and msg.get("id") in by_msg:
            msg["attachments"] = by_msg[msg["id"]]


def _project_tenant_id(db_project: dict | None) -> str:
    return str((db_project or {}).get("tenant_id") or "")


def files_only_content(files: list[dict]) -> str:
    names = [str(item.get("filename") or "file") for item in files]
    return "Attached files: " + ", ".join(names)


def resolve_send_content(content: str, files: list[dict]) -> str:
    if content.strip():
        return content
    return files_only_content(files)


async def _read_upload_capped(item, max_bytes: int) -> bytes:
    """Read at most max_bytes+1 so oversized parts fail without buffering unbounded RAM."""
    data = await item.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise FileUploadError(f"file too large (max {max_bytes} bytes)")
    return data


async def _form_files(form) -> list[dict]:
    limits = load_limits()
    files: list[dict] = []
    for item in form.getlist("files"):
        if not hasattr(item, "read"):
            continue
        # Count before buffering body — otherwise N×max_bytes can fill RAM first.
        if len(files) >= limits.max_files:
            raise FileUploadError(f"too many files (max {limits.max_files})")
        data = await _read_upload_capped(item, limits.max_bytes)
        files.append(
            {
                "filename": getattr(item, "filename", None) or "file",
                "content_type": getattr(item, "content_type", None) or "application/octet-stream",
                "data": data,
            }
        )
    return files


async def _form_files_http(form) -> list[dict]:
    try:
        return await _form_files(form)
    except FileUploadError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


def _form_text(form, key: str) -> Optional[str]:
    raw = form.get(key)
    if raw is None or hasattr(raw, "read"):
        return None
    return str(raw)


def _reject_oversized_content_length(request: Request, budget: int) -> None:
    """Refuse before parse when Content-Length already exceeds the product budget."""
    raw = request.headers.get("content-length")
    if raw is None or not str(raw).strip():
        return
    try:
        size = int(raw)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="invalid content-length") from exc
    if size < 0:
        raise HTTPException(status_code=400, detail="invalid content-length")
    if size > budget:
        logger.warning(
            "[ATTACH] multipart reject content_length=%s budget=%s — body too large before parse",
            size,
            budget,
        )
        raise HTTPException(status_code=413, detail=f"request body too large (max {budget} bytes)")


async def parse_multipart_form(request: Request):
    """Parse multipart with body budget + max_files during parse (not after spool).

    Content-Length over budget → 413 before reading. When ``request.stream`` exists,
    bytes past the budget abort mid-stream so SpooledTemporaryFile cannot eat 1 GiB.
    Test doubles without ``stream`` fall back to ``request.form``.
    """
    limits = load_limits()
    budget = multipart_body_budget_bytes(limits)
    _reject_oversized_content_length(request, budget)
    max_files = limits.max_files
    max_fields = max(32, max_files + 16)

    stream = getattr(request, "stream", None)
    if callable(stream):
        received = 0

        async def capped():
            nonlocal received
            async for chunk in stream():
                received += len(chunk)
                if received > budget:
                    raise MultiPartException(
                        f"request body too large (max {budget} bytes)"
                    )
                yield chunk

        try:
            return await MultiPartParser(
                request.headers,
                capped(),
                max_files=max_files,
                max_fields=max_fields,
            ).parse()
        except MultiPartException as exc:
            status = 413 if "too large" in exc.message else 400
            raise HTTPException(status_code=status, detail=exc.message) from exc

    try:
        return await request.form(max_files=max_files, max_fields=max_fields)
    except TypeError:
        # Test doubles / signatures without max_files kwargs.
        return await request.form()


async def parse_send_payload(request: Request) -> tuple[str, Optional[dict], list[dict]]:
    """JSON body stays 1:1 with SendMessageRequest. Multipart is content + files."""
    ctype = (request.headers.get("content-type") or "").lower()
    if "multipart/form-data" in ctype:
        form = await parse_multipart_form(request)
        raw = form.get("content")
        content = "" if raw is None or hasattr(raw, "read") else str(raw)
        metadata = None
        raw_meta = form.get("metadata")
        if isinstance(raw_meta, str) and raw_meta.strip():
            try:
                parsed_meta = json.loads(raw_meta)
            except json.JSONDecodeError as exc:
                raise HTTPException(status_code=400, detail="invalid metadata") from exc
            if parsed_meta is not None and not isinstance(parsed_meta, dict):
                raise HTTPException(status_code=400, detail="invalid metadata")
            metadata = parsed_meta
        files = await _form_files_http(form)
        if not files and not content.strip():
            raise HTTPException(status_code=400, detail="text or files required")
        return content, metadata, files

    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=422, detail="Invalid JSON") from exc
    from api.routes.messages import SendMessageRequest
    from pydantic import ValidationError

    try:
        parsed = SendMessageRequest.model_validate(body)
    except ValidationError as exc:
        raise RequestValidationError(exc.errors()) from exc
    return parsed.content, parsed.metadata, []


def _form_project_dict(form) -> dict:
    data: dict[str, Any] = {}
    prompt = _form_text(form, "user_prompt")
    data["user_prompt"] = prompt if prompt is not None else ""
    for key in ("approval_mode", "model_id", "workflow_id", "run_config_id"):
        value = _form_text(form, key)
        if value is not None:
            data[key] = value
    force_raw = _form_text(form, "force_model")
    if force_raw is not None:
        lowered = force_raw.strip().lower()
        if lowered in ("1", "true", "yes"):
            data["force_model"] = True
        elif lowered in ("0", "false", "no", ""):
            data["force_model"] = False
        else:
            raise HTTPException(status_code=400, detail="invalid force_model")
    temp_raw = _form_text(form, "temperature")
    if temp_raw is not None and temp_raw.strip():
        try:
            data["temperature"] = float(temp_raw)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid temperature") from exc
    reasoning_raw = _form_text(form, "reasoning")
    if reasoning_raw is not None and reasoning_raw.strip():
        try:
            data["reasoning"] = json.loads(reasoning_raw)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="invalid reasoning") from exc
    return data


async def parse_create_payload(request: Request) -> tuple[Any, list[dict]]:
    """JSON body stays 1:1 with ProjectCreate. Multipart is the same fields + files."""
    from api.routes.projects import ProjectCreate
    from pydantic import ValidationError

    ctype = (request.headers.get("content-type") or "").lower()
    if "multipart/form-data" in ctype:
        form = await parse_multipart_form(request)
        files = await _form_files_http(form)
        data = _form_project_dict(form)
        if not files and not str(data.get("user_prompt") or "").strip():
            raise HTTPException(status_code=400, detail="text or files required")
        try:
            return ProjectCreate.model_validate(data), files
        except ValidationError as exc:
            raise RequestValidationError(exc.errors()) from exc

    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=422, detail="Invalid JSON") from exc
    try:
        return ProjectCreate.model_validate(body), []
    except ValidationError as exc:
        raise RequestValidationError(exc.errors()) from exc


def prepare_send_files(files: list[dict]) -> list[dict]:
    try:
        return validate_batch(files)
    except FileUploadError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


async def save_message_attachments(
    *,
    storage,
    tenant_id: str,
    project_id: str,
    files: list[dict],
    message_id: str,
    message_sequence: Optional[int] = None,
    run_id: Optional[str] = None,
    created_by: Optional[str] = None,
) -> list[dict[str, Any]]:
    if not tenant_id:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    try:
        docs = await FileAttachmentStore(storage, FileBlobStore.from_env()).save_user_attachments(
            tenant_id=tenant_id,
            project_id=project_id,
            files=files,
            message_id=message_id,
            message_sequence=message_sequence,
            run_id=run_id,
            created_by=created_by,
        )
    except FileUploadError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    return docs


@router.get("/{project_id}/attachments")
async def list_user_attachments(
    project_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    skip: Annotated[int, Query(ge=0)] = 0,
):
    """List user uploads for the Artifacts folder ``user_attachments/``."""
    storage, db_project = await load_authorized_project(project_id, tenant_ctx)
    rows, truncated = await load_public_user_attachments(
        storage=storage,
        tenant_id=_project_tenant_id(db_project),
        project_id=project_id,
        limit=limit,
        skip=skip,
    )
    return {
        "attachments": rows,
        "folder": USER_ATTACHMENTS_FOLDER,
        "truncated": truncated,
        "limit": limit,
        "skip": skip,
    }


@router.get("/{project_id}/attachments/{attachment_id}/preview")
async def preview_user_attachment(
    project_id: str,
    attachment_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Read-only UTF-8 text of an attachment. Same ownership guard as download."""
    storage, db_project = await load_authorized_project(project_id, tenant_ctx)
    doc = await FileAttachmentStore(storage, FileBlobStore()).get_user_attachment(
        tenant_id=_project_tenant_id(db_project),
        project_id=project_id,
        attachment_id=attachment_id,
    )
    if not doc:
        logger.warning("[ATTACH] preview deny project=%s attachment=%s", project_id, attachment_id)
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return await text_preview_payload(doc)


@router.get("/{project_id}/attachments/{attachment_id}")
async def download_user_attachment(
    project_id: str,
    attachment_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
    raw: Annotated[bool, Query()] = False,
):
    """Mint a short-TTL presigned GET as JSON (archive pattern). Ownership before mint.

    ``raw=1`` streams bytes through the API so the browser can ZIP without S3 CORS.
    """
    storage, db_project = await load_authorized_project(project_id, tenant_ctx)
    tenant_id = _project_tenant_id(db_project)
    doc = await FileAttachmentStore(storage, FileBlobStore()).get_user_attachment(
        tenant_id=tenant_id,
        project_id=project_id,
        attachment_id=attachment_id,
    )
    if not doc:
        logger.warning("[ATTACH] download deny project=%s attachment=%s", project_id, attachment_id)
        raise HTTPException(status_code=404, detail=_NOT_FOUND)

    object_key = doc.get("object_key")
    if not object_key:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)

    blob = FileBlobStore.from_env()
    if not blob.is_configured():
        raise HTTPException(status_code=503, detail="object storage is not configured")

    if raw:
        data = await blob.get_blob(str(object_key))
        if data is None:
            raise HTTPException(status_code=404, detail=_NOT_FOUND)
        filename = str(doc.get("filename") or "attachment").replace('"', "")
        media = str(doc.get("content_type") or "application/octet-stream")
        logger.info(
            "[ATTACH] download-raw attachment=%s project=%s tenant=%s bytes=%d",
            attachment_id,
            project_id,
            tenant_id,
            len(data),
        )
        return Response(
            content=data,
            media_type=media,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    try:
        head = await blob.head_blob(object_key)
    except Exception as exc:
        logger.error("[ATTACH] head failed attachment=%s: %s", attachment_id, exc)
        raise HTTPException(status_code=502, detail="object storage unavailable")
    if head is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)

    ttl = _download_ttl_seconds()
    try:
        url = await blob.presign_get(object_key, ttl)
    except Exception as exc:
        logger.error("[ATTACH] presign failed attachment=%s: %s", attachment_id, exc)
        raise HTTPException(status_code=502, detail="failed to mint download url")

    logger.info(
        "[ATTACH] download-url attachment=%s project=%s tenant=%s",
        attachment_id,
        project_id,
        tenant_id,
    )
    return {
        "attachment_id": attachment_id,
        "url": url,
        "expires_in_seconds": ttl,
        "size_bytes": doc.get("size_bytes"),
        "content_type": doc.get("content_type"),
        "filename": doc.get("filename"),
    }

"""MCP ZIP upload, Docker build, and built-image gallery.

Mounted under ``/api/configurations/mcp-tools/mcp-packages``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from api.auth.middleware import require_role
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.deps import get_storage
from schemas.configuration_schemas import MCPServerDiscoverRequest
from schemas.mcp_package_schemas import (
    DockerfileCandidateResponse,
    McpBuiltImageItem,
    McpBuiltImageListResponse,
    McpPackageAnalyzeResponse,
    McpPackageAutofill,
    McpPackageBuildRequest,
    McpPackageBuildResponse,
    McpPackageBuildStatusResponse,
    McpPackageUploadResponse,
    PreflightIssueResponse,
)
from tools.mcp_dockerfile_finder import autofill_from_candidates, find_dockerfile_candidates
from tools.mcp_dockerfile_preflight import scan_archive_warnings
from tools.mcp_delete_lease_heartbeat import McpDeleteLeaseHeartbeat, McpDeleteLeaseLost
from tools.mcp_zip_build_policy import (
    _ZIP_SMOKE_SEGMENT,
    assert_dockerfile_allowed_for_build,
    assert_dockerfile_in_package,
    normalize_endpoint_path,
    normalize_zip_build_mode,
    package_blocks_new_upload,
    package_build_in_flight,
    package_rebuild_blocked,
    resolve_listen_port_explicit,
    validate_container_port_for_mode,
)
from tools.mcp_image_build_service import append_build_log, docker_build_mcp_image, mcp_image_tag
from tools.mcp_package_storage import (
    assert_built_image_tag_for_tenant,
    assert_wizard_built_image_doc,
    claim_mcp_built_image_deletion,
    claim_mcp_package_build_job,
    claim_mcp_package_deletion,
    delete_built_image_doc,
    get_built_image_doc,
    get_package_meta,
    image_tag_in_use,
    list_built_image_docs,
    new_upload_id,
    save_built_image_doc,
    save_package_doc,
    update_package_meta,
    update_package_meta_if_job,
    release_mcp_package_deletion,
    release_mcp_built_image_deletion,
)
from tools.mcp_wizard_cleanup import (
    cleanup_after_image_delete,
    flush_pending_server_wizard_cleanup,
)
from tools.mcp_tool_ids import McpSegmentIdError, validate_mcp_segment_id
from tools.mcp_zip_service import (
    McpZipError,
    cleanup_prior_upload_extract,
    extract_mcp_zip,
    normalize_zip_import_server_id,
    read_upload_bounded,
    suggest_server_id_from_zip_filename,
    upload_extract_dir,
)

logger = logging.getLogger(__name__)

# In-process lock avoids duplicate claim attempts per worker; cross-worker uses Mongo claim.
_BUILD_LOCKS: dict[str, asyncio.Lock] = {}


def _storage_or_fail():
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")
    return storage


def _effective_tenant(ctx: TenantContext) -> str:
    return ctx.tenant_id or "__root__"


def _package_lock(tenant_id: str, server_id: str) -> asyncio.Lock:
    """Serialize upload/build start per MCP server, not whole tenant."""
    key = f"{tenant_id}:{server_id}"
    lk = _BUILD_LOCKS.get(key)
    if lk is None:
        lk = asyncio.Lock()
        _BUILD_LOCKS[key] = lk
    return lk


def _resolve_server_id(body_server: Optional[str], pkg: dict, fallback: str) -> str:
    raw = (body_server or pkg.get("server_id") or fallback or "").strip()
    try:
        return normalize_zip_import_server_id(raw)
    except McpSegmentIdError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def _get_pkg_for_upload(
    storage,
    ctx: TenantContext,
    upload_id: str,
    *,
    server_id: Optional[str] = None,
) -> tuple[str, str, dict]:
    tenant = _effective_tenant(ctx)
    if server_id:
        sid = _resolve_server_id(server_id, {}, server_id)
        pkg = await get_package_meta(storage, tenant, sid)
        if not pkg or pkg.get("upload_id") != upload_id:
            raise HTTPException(status_code=404, detail="Package upload not found")
        return tenant, sid, pkg
    from storage.mcp_wizard_storage import list_packages

    docs = await list_packages(storage, None if ctx.is_root else tenant)
    for doc in docs:
        if ctx.is_root or doc.get("tenant_id") in (tenant, "__system__", None):
            pkg = {key: value for key, value in doc.items() if key not in {"_id", "tenant_id", "server_id", "record_type"}}
            if pkg.get("upload_id") == upload_id:
                doc_tenant = str(doc.get("tenant_id") or "__root__")
                return doc_tenant, str(doc.get("server_id") or ""), pkg
    raise HTTPException(status_code=404, detail="Package upload not found")


def register_mcp_package_routes(mcp_router: APIRouter) -> None:
    """Attach MCP package routes to the existing MCP tools router."""

    @mcp_router.post(
        "/mcp-packages/upload",
        response_model=McpPackageUploadResponse,
        status_code=201,
    )
    async def upload_mcp_package(
        file: UploadFile = File(...),
        server_id: Optional[str] = None,
        _admin: dict = Depends(require_role("tenant_admin")),
        ctx: TenantContext = Depends(get_tenant_context),
    ):
        storage = _storage_or_fail()
        tenant = _effective_tenant(ctx)
        if not file.filename or not str(file.filename).lower().endswith(".zip"):
            raise HTTPException(status_code=400, detail="Only .zip archives are supported")
        upload_id = new_upload_id()
        sid = _resolve_server_id(
            server_id,
            {},
            suggest_server_id_from_zip_filename(file.filename or ""),
        )
        async with _package_lock(tenant, sid):
            existing = await get_package_meta(storage, tenant, sid) or {}
            if package_blocks_new_upload(existing.get("status")):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Cannot upload a new ZIP while a build or smoke job is in progress "
                        "for this server (including image_ready)"
                    ),
                )
            old_extract_path = str(existing.get("extract_path") or "").strip() or None
            try:
                content = await read_upload_bounded(file)
            except McpZipError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            size = len(content)
            try:
                await asyncio.to_thread(
                    extract_mcp_zip,
                    BytesIO(content),
                    tenant_id=tenant,
                    upload_id=upload_id,
                    zip_filename=file.filename,
                    declared_size=size,
                )
            except McpZipError as exc:
                logger.warning("[MCP_ZIP] tenant=%s upload rejected: %s", tenant, exc)
                cleanup_prior_upload_extract(str(upload_extract_dir(tenant, upload_id)))
                raise HTTPException(status_code=400, detail=str(exc)) from exc

            extract_path = str(upload_extract_dir(tenant, upload_id))
            pkg_meta = {
                "record_type": "mcp_package",
                "upload_id": upload_id,
                "status": "uploaded",
                "zip_filename": file.filename,
                "extract_path": extract_path,
                "server_id": sid,
                "dockerfile_candidates": [],
                "build_log": "",
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            await save_package_doc(storage, tenant, sid, pkg_meta, actor_id=ctx.user_id)
            if old_extract_path and old_extract_path != extract_path:
                cleanup_prior_upload_extract(old_extract_path)
        return McpPackageUploadResponse(
            upload_id=upload_id,
            server_id=sid,
            status="uploaded",
        )

    @mcp_router.post(
        "/mcp-packages/{upload_id}/analyze",
        response_model=McpPackageAnalyzeResponse,
    )
    async def analyze_mcp_package(
        upload_id: str,
        server_id: Optional[str] = None,
        _admin: dict = Depends(require_role("tenant_admin")),
        ctx: TenantContext = Depends(get_tenant_context),
    ):
        storage = _storage_or_fail()
        tenant, sid, pkg = await _get_pkg_for_upload(storage, ctx, upload_id, server_id=server_id)
        async with _package_lock(tenant, sid):
            tenant, sid, pkg = await _get_pkg_for_upload(storage, ctx, upload_id, server_id=sid)
            if package_build_in_flight(pkg.get("status")):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Cannot analyze while a build or smoke job is in progress "
                        "for this server (including image_ready)"
                    ),
                )
            extract_path = Path(str(pkg.get("extract_path") or ""))
            candidates = await asyncio.to_thread(find_dockerfile_candidates, extract_path)
            cand_dicts = [c.to_dict() for c in candidates]
            tag = mcp_image_tag(tenant, sid, upload_id)
            autofill = autofill_from_candidates(sid, candidates, image_tag=tag)
            current = await get_package_meta(storage, tenant, sid) or {}
            if str(current.get("upload_id") or "") != upload_id:
                raise HTTPException(
                    status_code=409,
                    detail="Package was replaced during analyze; upload the ZIP again and re-run analyze",
                )
            await update_package_meta(
                storage,
                tenant,
                sid,
                {
                    "status": "analyzed",
                    "dockerfile_candidates": cand_dicts,
                    "server_id": sid,
                },
                actor_id=ctx.user_id,
            )
        archive_warnings = [
            PreflightIssueResponse(**i.to_dict())
            for i in await asyncio.to_thread(scan_archive_warnings, extract_path)
        ]

        def _candidate_response(raw: dict) -> DockerfileCandidateResponse:
            issues = raw.get("preflight_issues") or []
            return DockerfileCandidateResponse(
                **{
                    **raw,
                    "preflight_issues": [PreflightIssueResponse(**x) for x in issues],
                }
            )

        return McpPackageAnalyzeResponse(
            upload_id=upload_id,
            server_id=sid,
            status="analyzed",
            candidates=[_candidate_response(c) for c in cand_dicts],
            autofill=McpPackageAutofill(**autofill),
            archive_warnings=archive_warnings,
        )

    @mcp_router.post(
        "/mcp-packages/{upload_id}/build",
        response_model=McpPackageBuildResponse,
    )
    async def build_mcp_package(
        upload_id: str,
        body: McpPackageBuildRequest,
        _admin: dict = Depends(require_role("tenant_admin")),
        ctx: TenantContext = Depends(get_tenant_context),
    ):
        storage = _storage_or_fail()
        tenant = _effective_tenant(ctx)
        sid = _resolve_server_id(body.server_id, {}, body.server_id)
        tenant, sid, pkg = await _get_pkg_for_upload(storage, ctx, upload_id, server_id=sid)
        extract_path = Path(str(pkg.get("extract_path") or ""))
        known = pkg.get("dockerfile_candidates")
        known_list = known if isinstance(known, list) else None
        assert_dockerfile_in_package(
            extract_path,
            body.dockerfile_relative_path,
            known_candidates=known_list,
        )
        assert_dockerfile_allowed_for_build(extract_path, body.dockerfile_relative_path)
        run_mode = normalize_zip_build_mode(body.mode)
        listen_port = validate_container_port_for_mode(run_mode, body.container_port)
        endpoint_path = normalize_endpoint_path(body.endpoint_path)
        job_id = new_upload_id()[:12]
        image_tag = mcp_image_tag(tenant, sid, upload_id)
        async with _package_lock(tenant, sid):
            fresh = await get_package_meta(storage, tenant, sid) or {}
            if fresh.get("upload_id") and str(fresh.get("upload_id")) != upload_id:
                logger.warning(
                    "[MCP_BUILD] upload_id mismatch under lock req=%s fresh=%s tenant=%s server=%s",
                    upload_id,
                    fresh.get("upload_id"),
                    tenant,
                    sid,
                )
            if package_rebuild_blocked(fresh.get("status"), force_rebuild=body.force_rebuild):
                if package_build_in_flight(fresh.get("status")):
                    detail = "A build or smoke test is already in progress for this package"
                elif body.force_rebuild:
                    detail = "force_rebuild only applies when package status is ready"
                else:
                    detail = (
                        "Package is already ready; set force_rebuild=true to run build and smoke again"
                    )
                raise HTTPException(status_code=409, detail=detail)
        claimed = await claim_mcp_package_build_job(
            storage,
            tenant,
            sid,
            upload_id,
            {
                "status": "building",
                "job_id": job_id,
                "image_tag": image_tag,
                "selected_dockerfile": body.dockerfile_relative_path,
                "build_log": "",
                "error": None,
            },
            force_rebuild=body.force_rebuild,
            actor_id=ctx.user_id,
        )
        if not claimed:
            raise HTTPException(
                status_code=409,
                detail="A build or smoke test is already in progress for this package",
            )
        asyncio.create_task(
            _run_build_job(
                storage=storage,
                tenant_id=tenant,
                server_id=sid,
                upload_id=upload_id,
                job_id=job_id,
                dockerfile_relative_path=body.dockerfile_relative_path,
                container_port=listen_port,
                mode=run_mode,
                endpoint_path=endpoint_path,
            )
        )
        return McpPackageBuildResponse(
            upload_id=upload_id,
            job_id=job_id,
            image_tag=image_tag,
            status="building",
        )

    @mcp_router.get(
        "/mcp-packages/{upload_id}/build-status",
        response_model=McpPackageBuildStatusResponse,
    )
    async def mcp_package_build_status(
        upload_id: str,
        job_id: str,
        server_id: Optional[str] = None,
        _admin: dict = Depends(require_role("tenant_admin")),
        ctx: TenantContext = Depends(get_tenant_context),
    ):
        storage = _storage_or_fail()
        tenant, sid, pkg = await _get_pkg_for_upload(storage, ctx, upload_id, server_id=server_id)
        if str(pkg.get("job_id") or "") != job_id:
            raise HTTPException(status_code=404, detail="Build job not found")
        log_tail = str(pkg.get("build_log") or "")[-12000:]
        host_port = pkg.get("host_port")
        container_port = pkg.get("container_port")
        return McpPackageBuildStatusResponse(
            upload_id=upload_id,
            job_id=job_id,
            status=str(pkg.get("status") or "unknown"),
            phase=str(pkg.get("phase") or ""),
            log_tail=log_tail,
            image_tag=pkg.get("image_tag"),
            discover_tool_count=pkg.get("discover_tool_count"),
            container_port=int(container_port) if container_port is not None else None,
            host_port=int(host_port) if host_port is not None else None,
            error=pkg.get("error"),
        )

    @mcp_router.get("/mcp-built-images/", response_model=McpBuiltImageListResponse)
    async def list_mcp_built_images(
        _admin: dict = Depends(require_role("tenant_admin")),
        ctx: TenantContext = Depends(get_tenant_context),
    ):
        storage = _storage_or_fail()
        tid = None if ctx.is_root else _effective_tenant(ctx)
        docs = await list_built_image_docs(storage, tid)
        items: list[McpBuiltImageItem] = []
        for doc in docs:
            if not ctx.is_root and doc.get("tenant_id") not in (ctx.tenant_id, "__system__", None):
                continue
            try:
                img = assert_wizard_built_image_doc(doc)
            except HTTPException:
                continue
            tag = str(img.get("image_tag") or "")
            tenant_doc = str(doc.get("tenant_id") or "__root__")
            in_use = (
                await image_tag_in_use(storage, tenant_doc, tag, global_scope=True)
                if tag
                else False
            )
            items.append(
                McpBuiltImageItem(
                    id=str(doc.get("_id")),
                    image_tag=tag,
                    server_id=str(doc.get("server_id") or ""),
                    tenant_id=tenant_doc,
                    upload_id=img.get("upload_id"),
                    status=str(img.get("status") or ""),
                    created_at=img.get("created_at"),
                    in_use=in_use,
                    discover_tool_count=img.get("discover_tool_count"),
                )
            )
        items.sort(key=lambda x: x.created_at or "", reverse=True)
        return McpBuiltImageListResponse(images=items)

    @mcp_router.delete("/mcp-built-images/{doc_id}", status_code=204)
    async def delete_mcp_built_image(
        doc_id: str,
        _admin: dict = Depends(require_role("tenant_admin")),
        ctx: TenantContext = Depends(get_tenant_context),
    ):
        storage = _storage_or_fail()
        doc = await get_built_image_doc(storage, doc_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Built image not found")
        if not ctx.is_root and doc.get("tenant_id") != ctx.tenant_id:
            raise HTTPException(status_code=404, detail="Built image not found")
        img = assert_wizard_built_image_doc(doc)
        tenant_doc = str(doc.get("tenant_id") or "__root__")
        server_id = str(doc.get("server_id") or "")
        package = await get_package_meta(storage, tenant_doc, server_id)
        reservation_id = uuid.uuid4().hex if package else None
        if package and not await claim_mcp_package_deletion(
            storage,
            tenant_doc,
            server_id,
            reservation_id=reservation_id,
        ):
            raise HTTPException(
                status_code=409,
                detail="Cannot delete a built image while its package build is in flight",
            )
        package_deleted = False
        image_deleted = False
        image_reservation_id = uuid.uuid4().hex
        image_reserved = False
        heartbeat: McpDeleteLeaseHeartbeat | None = None
        try:
            image_reserved = await claim_mcp_built_image_deletion(
                storage, doc_id, reservation_id=image_reservation_id
            )
            if not image_reserved:
                raise HTTPException(
                    status_code=409,
                    detail="Cannot delete a built image while a configuration write is in progress",
                )
            heartbeat = McpDeleteLeaseHeartbeat(
                storage=storage,
                tenant_id=tenant_doc,
                package_server_ids=[server_id] if reservation_id else [],
                package_reservation_id=reservation_id,
                image_doc_ids=[doc_id],
                image_reservation_id=image_reservation_id,
            )
            await heartbeat.start()
            await heartbeat.assert_healthy()
            tag = str(img.get("image_tag") or "").strip()
            if tag:
                assert_built_image_tag_for_tenant(tag, tenant_doc)
            if tag and await image_tag_in_use(storage, tenant_doc, tag, global_scope=True):
                raise HTTPException(
                    status_code=409,
                    detail=f"Image {tag} is referenced by one or more MCP tool configurations",
                )
            if tag:
                from sandbox.host_cli import run_host_cli

                await heartbeat.assert_healthy()
                rmi_res = await run_host_cli(["docker", "rmi", tag], timeout=120)
                rmi_code = int(rmi_res.get("exit_code", 1))
                rmi_err = (rmi_res.get("stderr") or rmi_res.get("stdout") or "").strip()
                if rmi_code != 0 and "No such image" not in rmi_err:
                    raise HTTPException(
                        status_code=409,
                        detail=f"docker rmi failed for {tag}: {rmi_err[:500]}",
                    )
            await heartbeat.assert_healthy()
            deleted = await delete_built_image_doc(storage, doc_id)
            image_deleted = deleted
            if deleted:
                cleanup_result = await cleanup_after_image_delete(
                    storage,
                    tenant_id=tenant_doc,
                    server_id=server_id,
                    deleted_upload_id=str(img.get("upload_id") or ""),
                    extract_cleanup=cleanup_prior_upload_extract,
                    package_deletion_reservation_id=reservation_id,
                )
                package_deleted = cleanup_result.package_deleted
        except McpDeleteLeaseLost as exc:
            raise HTTPException(
                status_code=409,
                detail="MCP image deletion lost its lease; retry the operation",
            ) from exc
        finally:
            if heartbeat is not None:
                await heartbeat.stop()
            if image_reserved and not image_deleted:
                await release_mcp_built_image_deletion(
                    storage, doc_id, reservation_id=image_reservation_id
                )
            if reservation_id and not package_deleted:
                await release_mcp_package_deletion(
                    storage,
                    tenant_doc,
                    server_id,
                    reservation_id=reservation_id,
                )


async def _mark_zip_package_job_failed(
    *,
    storage,
    tenant_id: str,
    server_id: str,
    upload_id: str,
    job_id: str,
    terminal_status: str,
    error_msg: str,
    log: str,
    image_tag: str,
    container_port: int,
    update_built_image: bool = False,
) -> None:
    """Mark terminal failure for a build job (safe if ``_mark_smoke_failed`` is not in scope)."""
    current = await get_package_meta(storage, tenant_id, server_id) or {}
    if str(current.get("job_id") or "") != job_id:
        return
    err = str(error_msg or "build job failed")[:500]
    phase = "done" if terminal_status == "smoke_failed" else "build"
    if update_built_image:
        try:
            await save_built_image_doc(
                storage,
                tenant_id,
                server_id,
                upload_id,
                {
                    "record_type": "mcp_built_image",
                    "upload_id": upload_id,
                    "image_tag": image_tag,
                    "status": terminal_status,
                    "build_log": log,
                    "discover_tool_count": 0,
                    "container_port": container_port,
                    "error": err,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                },
            )
        except Exception as img_exc:
            logger.warning(
                "[MCP_BUILD] tenant=%s server=%s upload=%s — built image doc update failed: %s",
                tenant_id,
                server_id,
                upload_id,
                img_exc,
            )
    updated = await update_package_meta_if_job(
        storage,
        tenant_id,
        server_id,
        job_id,
        {
            "status": terminal_status,
            "phase": phase,
            "build_log": log,
            "error": err,
        },
    )
    if updated:
        await flush_pending_server_wizard_cleanup(
            storage,
            tenant_id=tenant_id,
            server_id=server_id,
            terminal_status=terminal_status,
            trigger=terminal_status,
        )


async def _run_build_job(
    *,
    storage,
    tenant_id: str,
    server_id: str,
    upload_id: str,
    job_id: str,
    dockerfile_relative_path: str,
    container_port: int,
    mode: str,
    endpoint_path: str,
) -> None:
    pkg = await get_package_meta(storage, tenant_id, server_id) or {}
    if pkg.get("job_id") != job_id:
        return
    extract_path = Path(str(pkg.get("extract_path") or ""))
    log = str(pkg.get("build_log") or "")
    image_tag = str(pkg.get("image_tag") or mcp_image_tag(tenant_id, server_id, upload_id))

    async def _job_still_active() -> bool:
        current = await get_package_meta(storage, tenant_id, server_id) or {}
        return str(current.get("job_id") or "") == job_id

    async def _patch(fields: dict) -> bool:
        """Return False if a newer build job replaced this one (do not write stale state)."""
        nonlocal log
        patch_fields = dict(fields)
        if "build_log" in patch_fields:
            log = patch_fields["build_log"]
        else:
            patch_fields["build_log"] = log
        ok = await update_package_meta_if_job(
            storage,
            tenant_id,
            server_id,
            job_id,
            patch_fields,
        )
        if not ok:
            logger.warning(
                "[MCP_BUILD] tenant=%s server=%s upload=%s job=%s — superseded, skip patch",
                tenant_id,
                server_id,
                upload_id,
                job_id,
            )
        elif patch_fields.get("status") in {"ready", "build_failed", "smoke_failed"}:
            await flush_pending_server_wizard_cleanup(
                storage,
                tenant_id=tenant_id,
                server_id=server_id,
                terminal_status=str(patch_fields["status"]),
                trigger=str(patch_fields["status"]),
            )
        return ok

    smoke_budget = _zip_smoke_timeout_seconds() * 6
    smoke_sid = ""
    listen_port = int(container_port)
    in_smoke_phase = False
    try:
        if not await _patch({"phase": "build", "status": "building"}):
            return
        build_res = await docker_build_mcp_image(
            tenant_id=tenant_id,
            server_id=server_id,
            upload_id=upload_id,
            extract_root=extract_path,
            dockerfile_relative_path=dockerfile_relative_path,
        )
        log = append_build_log(log, build_res.get("stdout") or "", build_res.get("stderr") or "")
        if not await _job_still_active():
            return
        if int(build_res.get("exit_code", 1)) != 0:
            await _patch(
                {
                    "status": "build_failed",
                    "phase": "build",
                    "build_log": log,
                    "error": "docker build failed",
                }
            )
            return

        run_mode = normalize_zip_build_mode(mode)
        listen_port = resolve_listen_port_explicit(run_mode, int(container_port))
        log = append_build_log(
            log,
            f"\n[smoke] Docker build finished (image_ready). Image: {image_tag}\n",
            "",
        )
        if not await _job_still_active():
            return
        await save_built_image_doc(
            storage,
            tenant_id,
            server_id,
            upload_id,
            {
                "record_type": "mcp_built_image",
                "upload_id": upload_id,
                "image_tag": image_tag,
                "status": "image_ready",
                "build_log": log,
                "discover_tool_count": 0,
                "container_port": listen_port,
                "created_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        if not await _patch(
            {
                "status": "image_ready",
                "phase": "smoke",
                "build_log": log,
                "container_port": listen_port,
                "error": None,
            }
        ):
            return
        smoke_sid = _zip_smoke_server_id(server_id, upload_id)
        in_smoke_phase = True

        async def _smoke_log(line: str) -> None:
            nonlocal log
            if not await _job_still_active():
                return
            log = append_build_log(log, line, "")
            await _patch(
                {
                    "phase": "smoke",
                    "status": "smoke_running",
                    "build_log": log,
                    "container_port": listen_port,
                }
            )

        port_hint = (
            f"container_port={listen_port}"
            if run_mode == "streamable-http"
            else "stdio (no host port)"
        )
        log = append_build_log(
            log,
            f"\n[smoke] Docker build finished. Starting MCP discover "
            f"(mode={run_mode}, {port_hint}, probe_id={smoke_sid})…\n",
            "",
        )
        if not await _patch(
            {
                "phase": "smoke",
                "status": "smoke_running",
                "build_log": log,
                "container_port": listen_port,
            }
        ):
            return
        runtime_out: dict = {}
        discovered = await asyncio.wait_for(
            _smoke_discover(
                storage=storage,
                tenant_id=tenant_id,
                server_id=smoke_sid,
                image_tag=image_tag,
                mode=run_mode,
                container_port=listen_port,
                endpoint_path=endpoint_path,
                on_progress=_smoke_log,
                runtime_out=runtime_out,
            ),
            timeout=smoke_budget,
        )
        if not await _job_still_active():
            return
        log = append_build_log(
            log,
            f"\n[smoke] Discover OK — {len(discovered)} tool(s).\n",
            "",
        )
        if not await _job_still_active():
            return
        host_port = runtime_out.get("host_port")
        ready_patch: dict = {
            "status": "ready",
            "phase": "done",
            "build_log": log,
            "discover_tool_count": len(discovered),
            "container_port": listen_port,
            "error": None,
        }
        if isinstance(host_port, int) and host_port > 0:
            ready_patch["host_port"] = host_port
        await save_built_image_doc(
            storage,
            tenant_id,
            server_id,
            upload_id,
            {
                "record_type": "mcp_built_image",
                "upload_id": upload_id,
                "image_tag": image_tag,
                "status": "ready",
                "build_log": log,
                "discover_tool_count": len(discovered),
                "container_port": listen_port,
                **({"host_port": host_port} if isinstance(host_port, int) and host_port > 0 else {}),
                "created_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        if not await _patch(ready_patch):
            return
        logger.info(
            "[MCP_SMOKE] tenant=%s server=%s upload=%s tools=%d — ready",
            tenant_id,
            server_id,
            upload_id,
            len(discovered),
        )
    except asyncio.TimeoutError:
        logger.error(
            "[MCP_BUILD] tenant=%s server=%s upload=%s job=%s smoke_sid=%s image=%s — smoke timed out",
            tenant_id,
            server_id,
            upload_id,
            job_id,
            smoke_sid,
            image_tag,
        )
        log = append_build_log(
            log,
            "",
            f"\n[smoke] Timed out after {int(smoke_budget)}s. "
            "Check API logs [MCP_SMOKE] / [EXTERNAL_MCP] or retry.\n",
        )
        await _mark_zip_package_job_failed(
            storage=storage,
            tenant_id=tenant_id,
            server_id=server_id,
            upload_id=upload_id,
            job_id=job_id,
            terminal_status="smoke_failed",
            error_msg=f"Smoke discover timed out after {int(smoke_budget)}s",
            log=log,
            image_tag=image_tag,
            container_port=listen_port,
            update_built_image=True,
        )
    except Exception as exc:
        logger.error(
            "[MCP_BUILD] tenant=%s server=%s upload=%s job=%s failed: %s",
            tenant_id,
            server_id,
            upload_id,
            job_id,
            exc,
            exc_info=True,
        )
        log = append_build_log(log, "", f"\n[smoke] Failed: {exc}\n")
        if in_smoke_phase:
            await _mark_zip_package_job_failed(
                storage=storage,
                tenant_id=tenant_id,
                server_id=server_id,
                upload_id=upload_id,
                job_id=job_id,
                terminal_status="smoke_failed",
                error_msg=str(exc),
                log=log,
                image_tag=image_tag,
                container_port=listen_port,
                update_built_image=True,
            )
        else:
            await _mark_zip_package_job_failed(
                storage=storage,
                tenant_id=tenant_id,
                server_id=server_id,
                upload_id=upload_id,
                job_id=job_id,
                terminal_status="build_failed",
                error_msg=str(exc),
                log=log,
                image_tag=image_tag,
                container_port=listen_port,
                update_built_image=False,
            )

def _zip_smoke_server_id(server_id: str, upload_id: str) -> str:
    """Ephemeral server_id for smoke so host ports do not collide with live MCP configs."""
    suffix = re.sub(r"[^a-zA-Z0-9]+", "", str(upload_id or ""))[:8] or "0"
    return validate_mcp_segment_id(f"{server_id}{_ZIP_SMOKE_SEGMENT}{suffix}", "server_id")


def _zip_smoke_timeout_seconds() -> float:
    raw = os.environ.get("MCP_ZIP_SMOKE_TIMEOUT_SECONDS", "120").strip()
    try:
        return max(30.0, min(300.0, float(raw)))
    except (TypeError, ValueError):
        return 120.0


async def _smoke_discover(
    *,
    storage,
    tenant_id: str,
    server_id: str,
    image_tag: str,
    mode: str,
    container_port: int,
    endpoint_path: str = "/mcp",
    on_progress=None,
    runtime_out: dict | None = None,
) -> list:
    from api.routes.tool_configurations import _execute_mcp_discovery_once

    run_mode = normalize_zip_build_mode(mode)
    timeout_s = _zip_smoke_timeout_seconds()
    discover_kwargs: dict = {
        "server_id": server_id,
        "endpoint": "",
        "mode": run_mode,
        "timeout_seconds": timeout_s,
        "image": image_tag,
    }
    if run_mode == "streamable-http":
        discover_kwargs["container_port"] = container_port
        discover_kwargs["endpoint_path"] = endpoint_path or "/mcp"
    body = MCPServerDiscoverRequest(**discover_kwargs)
    port_log = container_port if run_mode == "streamable-http" else "stdio"
    logger.info(
        "[MCP_SMOKE] tenant=%s server=%s image=%s mode=%s port=%s timeout_s=%s — discover start",
        tenant_id,
        server_id,
        image_tag,
        run_mode,
        port_log,
        timeout_s,
    )
    delays = (2.0, 4.0, 8.0, 12.0)
    attempts = 5
    last_exc: Optional[Exception] = None
    for attempt in range(attempts):
        if on_progress and attempt == 0:
            await on_progress("[smoke] starting container and MCP session…\n")
        if attempt > 0 and on_progress:
            wait_s = delays[min(attempt - 1, len(delays) - 1)]
            err = last_exc
            detail = ""
            if err is not None:
                detail = str(err).replace("\n", " ").strip()[:160]
            kind = type(err).__name__ if err else "error"
            hint = f"{kind}: {detail}" if detail else kind
            await on_progress(
                f"[smoke] retry {attempt + 1}/{attempts} in {wait_s:.0f}s ({hint})…\n"
            )
            await asyncio.sleep(wait_s)
        elif attempt > 0:
            await asyncio.sleep(delays[min(attempt - 1, len(delays) - 1)])
        try:
            return await _execute_mcp_discovery_once(
                body,
                tenant=tenant_id,
                storage=storage,
                runtime_out=runtime_out,
            )
        except Exception as exc:
            last_exc = exc
            logger.warning(
                "[MCP_SMOKE] tenant=%s server=%s attempt=%d/%d failed: %s",
                tenant_id,
                server_id,
                attempt + 1,
                attempts,
                exc,
            )
    assert last_exc is not None
    raise last_exc

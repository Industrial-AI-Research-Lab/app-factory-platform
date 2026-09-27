"""Configuration Import/Export endpoints (admin-scoped).

Exposes three endpoints under /api/admin/config-bundle:
- GET  /export?tenant_id=X       — dump tenant's configs as a JSON bundle
- POST /dry-run                  — validate bundle + compute per-item action
- POST /apply                    — commit bundle (audit-stamped, partial-failure tolerant)

Authorization: tenant_admin or higher (root can target any tenant; tenant_admin
is restricted to its own tenant for both export and apply).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from api.auth.middleware import require_role
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.deps import get_storage
from api.runtime_sync import sync_runtime_after_config_change
from config.bundle_service import (
    BundleError,
    apply_import,
    dry_run_import,
    export_bundle,
)
from integrations.a2a_client import A2AClientFactory

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/admin/config-bundle",
    tags=["admin", "config-bundle"],
    dependencies=[Depends(require_role("tenant_admin"))],
)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class BundleImportBody(BaseModel):
    """Body for dry-run and apply requests."""
    bundle: Dict[str, Any] = Field(..., description="Bundle JSON to import")
    target_tenant_id: str = Field(
        ...,
        min_length=1,
        description="Target tenant id (overrides any tenant_id in bundle items)",
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/export")
async def export_config_bundle(
    tenant_id: str = Query(..., min_length=1, description="Tenant id to export"),
    ctx: TenantContext = Depends(get_tenant_context),
) -> Dict[str, Any]:
    """Dump every configuration for the given tenant into a bundle JSON."""
    _ensure_scope_allowed(ctx, tenant_id, action="export")
    storage = _storage_or_fail()
    try:
        return await export_bundle(storage, tenant_id)
    except BundleError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/dry-run")
async def dry_run_config_bundle(
    body: BundleImportBody,
    ctx: TenantContext = Depends(get_tenant_context),
) -> Dict[str, Any]:
    """Validate bundle + show per-item action without writes."""
    _ensure_scope_allowed(ctx, body.target_tenant_id, action="dry-run")
    storage = _storage_or_fail()
    try:
        return await dry_run_import(storage, body.bundle, body.target_tenant_id)
    except BundleError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/apply")
async def apply_config_bundle(
    body: BundleImportBody,
    ctx: TenantContext = Depends(get_tenant_context),
) -> Dict[str, Any]:
    """Commit bundle with per-item partial-failure tolerance."""
    _ensure_scope_allowed(ctx, body.target_tenant_id, action="apply")
    storage = _storage_or_fail()
    try:
        result = await apply_import(
            storage,
            body.bundle,
            body.target_tenant_id,
            actor_id=ctx.user_id,
        )
    except BundleError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    summary = result.get("summary", {})
    touched_agents = _has_writes(summary.get("agents", {}))
    touched_tools = _has_writes(summary.get("tools", {}))
    if touched_agents or touched_tools:
        await sync_runtime_after_config_change(
            f"config_bundle_apply:{body.target_tenant_id}",
            agents=touched_agents,
            tools=touched_tools,
        )

    if _has_writes(summary.get("a2a_servers", {})):
        await _invalidate_a2a_clients(storage, result, body.target_tenant_id)

    logger.info(
        "[CONFIG-BUNDLE] apply target=%s actor=%s summary=%s",
        body.target_tenant_id, ctx.user_id, summary,
    )
    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ensure_scope_allowed(
    ctx: TenantContext, target_tenant_id: str, *, action: str,
) -> None:
    """Root can target any tenant; tenant_admin only their own."""
    if ctx.is_root:
        return
    if not ctx.tenant_id or target_tenant_id != ctx.tenant_id:
        raise HTTPException(
            status_code=403,
            detail=(
                f"Cannot {action} bundle for tenant '{target_tenant_id}': "
                f"tenant_admin scope is limited to own tenant"
            ),
        )


def _has_writes(kind_summary: Dict[str, int]) -> bool:
    return bool(kind_summary.get("insert", 0) or kind_summary.get("update", 0))


async def _invalidate_a2a_clients(
    storage, result: Dict[str, Any], tenant_id: str,
) -> None:
    """Drop cached A2A SDK clients for servers an import touched.

    The A2A factory caches an SDK client + token provider per server; an import can
    change a server's endpoint or credentials, so a stale cached client would keep
    hitting the old target. No-op for fresh inserts (nothing cached yet)."""
    for item in result.get("items", {}).get("a2a_servers", []):
        if item.get("status") != "success":
            continue
        server_id = item.get("target_id")
        if not server_id:
            continue
        try:
            await A2AClientFactory.invalidate_sdk_client(storage, server_id, tenant_id)
        except Exception as exc:
            logger.warning(
                "[CONFIG-BUNDLE] a2a client invalidate failed id=%s: %s", server_id, exc,
            )


def _storage_or_fail():
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")
    return storage

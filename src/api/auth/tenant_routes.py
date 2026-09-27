"""
Tenant management routes — CRUD for tenants and tenant settings.

Root only:
    GET    /api/tenants
    POST   /api/tenants
    GET    /api/tenants/{tenant_id}
    PUT    /api/tenants/{tenant_id}
    DELETE /api/tenants/{tenant_id}

Tenant admin+ (own tenant) or root (any):
    GET    /api/tenants/{tenant_id}/settings
    PUT    /api/tenants/{tenant_id}/settings
    GET    /api/tenants/{tenant_id}/default-model
"""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status

from api import deps
from api.auth.middleware import require_role
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_provisioning import (
    provision_tenant,
    TenantProvisioningError,
    cleanup_tenant_clones,
)
from api.runtime_sync import sync_runtime_after_config_change
from storage.mongo_backend import (
    TenantCascadeNotFoundError,
    TenantCascadeConflictError,
    TenantCascadeTransactionsRequiredError,
)
from schemas.tenant_schemas import (
    TenantCreate,
    TenantUpdate,
    TenantResponse,
    TenantSettingsUpdate,
    TenantSettingsResponse,
    TenantEffectiveDefaultModelResponse,
)
from schemas.auth_schemas import (
    McpExportApiKeyCreate,
    McpExportApiKeyCreatedResponse,
    McpExportApiKeyListItem,
)
from api.auth.tenant_mcp_export_keys import (
    DuplicateMcpExportKeyNameError,
    create_mcp_export_api_key,
    list_mcp_export_api_keys,
    revoke_mcp_export_api_key,
)
from tools.mcp_wizard_cleanup import cleanup_tenant_extracts, list_tenant_package_extract_paths

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tenants", tags=["tenants"])

# Sensitive fields that are masked in GET/PUT responses
_MASKED_FIELDS = ("bifrost_vk", "openai_api_key")


def _mask_value(raw: object) -> str:
    """Mask sensitive value using the same policy for all secret fields."""
    value = str(raw)
    return value[:4] + "***" + value[-4:] if len(value) > 8 else "***"


def _mask_sensitive(settings: dict) -> dict:
    """Return a copy with sensitive fields masked."""
    out = dict(settings)
    for field in _MASKED_FIELDS:
        val = out.get(field)
        if val is not None and val != "":
            out[field] = _mask_value(val)
    rows = out.get("mcp_export_api_keys")
    if isinstance(rows, list):
        masked_rows = []
        for row in rows:
            if not isinstance(row, dict):
                masked_rows.append(row)
                continue
            item = dict(row)
            kh = item.get("key_hash")
            if kh is not None and kh != "":
                item["key_hash"] = _mask_value(str(kh))
            masked_rows.append(item)
        out["mcp_export_api_keys"] = masked_rows
    return out


# ---------------------------------------------------------------------------
# Tenant CRUD (root only)
# ---------------------------------------------------------------------------

@router.get("/", response_model=list[TenantResponse])
async def list_tenants(user: dict = Depends(require_role("root"))):
    """List all tenants (root only)."""
    storage = deps.get_storage()
    tenants = await storage.get_tenants()
    return [TenantResponse.model_validate(t) for t in tenants]


@router.post("/", response_model=TenantResponse, status_code=status.HTTP_201_CREATED)
async def create_tenant(body: TenantCreate, user: dict = Depends(require_role("root")), ctx: TenantContext = Depends(get_tenant_context)):
    """Create a new tenant (root only)."""
    storage = deps.get_storage()

    existing = await storage.get_tenant(body.id)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Tenant '{body.id}' already exists",
        )

    doc = {
        "_id": body.id,
        "name": body.name,
        "enabled": body.enabled,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    created_tenant = False
    created_settings = False
    try:
        await storage.save_tenant(doc, actor_id=ctx.user_id)
        created_tenant = True
        await storage.save_tenant_settings(
            {
                "_id": body.id,
                "llm_provider": "bifrost",
                "bifrost_vk": None,
                "openai_api_key": None,
                "bifrost_url": None,
                "bifrost_provider": "openrouter",
                "default_model": None,
                "max_concurrent_projects": 5,
                "enabled": True,
            },
            actor_id=ctx.user_id,
        )
        created_settings = True

        counts = await provision_tenant(storage=storage, tenant_id=body.id, actor_id=ctx.user_id)
    except TenantProvisioningError as exc:
        logger.error(
            "[TENANT_PROVISION] tenant_id=%s created_by=%s - failed: %s",
            body.id,
            user["email"],
            exc,
        )
        if exc.rollback_failures:
            logger.error(
                "[TENANT_PROVISION] tenant_id=%s - rollback incomplete failures=%d",
                body.id,
                len(exc.rollback_failures),
            )

        try:
            cleanup_result = await cleanup_tenant_clones(storage=storage, tenant_id=body.id)
        except Exception as cleanup_exc:
            logger.error(
                "[TENANT_PROVISION] tenant_id=%s - route cleanup failed: %s",
                body.id,
                cleanup_exc,
            )
        else:
            deleted = cleanup_result.get("deleted", {})
            failures = cleanup_result.get("failures", [])
            logger.info(
                "[TENANT_PROVISION] tenant_id=%s - route cleanup deleted agents=%d workflows=%d run_configs=%d tools=%d",
                body.id,
                deleted.get("agents", 0),
                deleted.get("workflows", 0),
                deleted.get("run_configs", 0),
                deleted.get("tools", 0),
            )
            if failures:
                logger.error(
                    "[TENANT_PROVISION] tenant_id=%s - route cleanup failures=%d",
                    body.id,
                    len(failures),
                )

        if created_settings:
            await storage.delete_tenant_settings(body.id)
        if created_tenant:
            await storage.delete_tenant(body.id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to provision tenant '{body.id}'",
        ) from exc
    except Exception as exc:
        logger.error(
            "[TENANT_PROVISION] tenant_id=%s created_by=%s - failed before provisioning: %s",
            body.id,
            user["email"],
            exc,
        )
        if created_settings:
            await storage.delete_tenant_settings(body.id)
        if created_tenant:
            await storage.delete_tenant(body.id)
        raise

    logger.info(
        "[TENANT_PROVISION] tenant_id=%s created_by=%s - completed agents=%d workflows=%d run_configs=%d tools=%d",
        body.id,
        user["email"],
        counts.get("agents", 0),
        counts.get("workflows", 0),
        counts.get("run_configs", 0),
        counts.get("tools", 0),
    )
    await sync_runtime_after_config_change(
        f"tenant_provision:{body.id}",
        agents=True,
        tools=True,
    )
    return TenantResponse.model_validate(doc)


@router.get("/{tenant_id}", response_model=TenantResponse)
async def get_tenant(tenant_id: str, user: dict = Depends(require_role("root"))):
    """Get a single tenant by ID (root only)."""
    storage = deps.get_storage()
    doc = await storage.get_tenant(tenant_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")
    return TenantResponse.model_validate(doc)


@router.put("/{tenant_id}", response_model=TenantResponse)
async def update_tenant(
    tenant_id: str,
    body: TenantUpdate,
    user: dict = Depends(require_role("root")),
    ctx: TenantContext = Depends(get_tenant_context)
):
    """Update a tenant (root only)."""
    storage = deps.get_storage()
    doc = await storage.get_tenant(tenant_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")

    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No fields to update")

    doc.update(updates)
    await storage.save_tenant(doc, actor_id=ctx.user_id)
    logger.info("Tenant updated: %s by %s", tenant_id, user["email"])
    return TenantResponse.model_validate(doc)


@router.delete("/{tenant_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tenant(tenant_id: str, user: dict = Depends(require_role("root"))):
    """Delete a tenant with tenant-scoped configuration cascade (root only)."""
    storage = deps.get_storage()

    if tenant_id in ("__root__", "__system__"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot delete system tenant '{tenant_id}'",
        )

    tenant_doc = await storage.get_tenant(tenant_id)
    if not tenant_doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")

    logger.info("[TENANT_CASCADE] tenant_id=%s initiated_by=%s - started", tenant_id, user["email"])
    wizard_extract_paths = await list_tenant_package_extract_paths(storage, tenant_id)
    try:
        deleted = await storage.delete_tenant_cascade_atomic(tenant_id)
    except ValueError as exc:
        logger.error(
            "[TENANT_CASCADE] tenant_id=%s initiated_by=%s rolled_back=true - rejected: %s",
            tenant_id,
            user["email"],
            exc,
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except TenantCascadeNotFoundError as exc:
        logger.warning(
            "[TENANT_CASCADE] tenant_id=%s initiated_by=%s rolled_back=true - not_found: %s",
            tenant_id,
            user["email"],
            exc,
        )
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found") from exc
    except TenantCascadeConflictError as exc:
        logger.error(
            "[TENANT_CASCADE] tenant_id=%s initiated_by=%s rolled_back=true - conflict: %s",
            tenant_id,
            user["email"],
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except TenantCascadeTransactionsRequiredError as exc:
        logger.error(
            "[TENANT_CASCADE] tenant_id=%s initiated_by=%s rolled_back=true - transactions_unavailable: %s",
            tenant_id,
            user["email"],
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        logger.exception(
            "[TENANT_CASCADE] tenant_id=%s initiated_by=%s rolled_back=true - failed: %s",
            tenant_id,
            user["email"],
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to cascade delete tenant '{tenant_id}'",
        ) from exc

    try:
        cleanup_tenant_extracts(tenant_id, wizard_extract_paths)
    except Exception as exc:
        logger.warning(
            "[MCP_CLEANUP] tenant=%s trigger=tenant_purge cleanup_failed=%s",
            tenant_id,
            exc,
        )

    logger.info(
        "[TENANT_CASCADE] tenant_id=%s initiated_by=%s deleted_agents=%d deleted_workflows=%d deleted_run_configs=%d deleted_tools=%d deleted_users=%d deleted_projects=%d deleted_runs=%d deleted_tasks=%d deleted_events=%d deleted_snapshots=%d deleted_container_logs=%d deleted_deployments=%d deleted_archive_refs=%d deleted_a2a_task_contracts=%d deleted_tenant_settings=%d deleted_tenants=%d - completed",
        tenant_id,
        user["email"],
        deleted.get("agents", 0),
        deleted.get("workflows", 0),
        deleted.get("run_configs", 0),
        deleted.get("tools", 0),
        deleted.get("users", 0),
        deleted.get("projects", 0),
        deleted.get("runs", 0),
        deleted.get("tasks", 0),
        deleted.get("events", 0),
        deleted.get("snapshots", 0),
        deleted.get("container_logs", 0),
        deleted.get("deployments", 0),
        deleted.get("archive_refs", 0),
        deleted.get("a2a_task_contracts", 0),
        deleted.get("tenant_settings", 0),
        deleted.get("tenants", 0),
    )

    # Best-effort: reclaim the tenant's archived tool-result blobs. The Mongo
    # cascade already dropped their locators (nothing can address the bytes
    # now); this frees the bytes too. S3 can't join the Mongo transaction, so it
    # runs post-commit, never fails the delete, and leans on the bucket
    # lifecycle rule for anything it can't reach. tenant_id is the top-level key
    # prefix by design (see ArchiveStore.maybe_spill).
    try:
        from storage.archive_store import ArchiveStore

        blobs_deleted, blobs_failed = await ArchiveStore.from_env(storage).delete_prefix(
            f"{tenant_id}/"
        )
        logger.info(
            "[TENANT_CASCADE] tenant_id=%s archived_blobs_deleted=%d archived_blobs_failed=%d",
            tenant_id, blobs_deleted, blobs_failed,
        )
    except Exception as exc:
        logger.warning(
            "[TENANT_CASCADE] tenant_id=%s archive blob cleanup skipped (locators already removed): %s",
            tenant_id, exc,
        )

    try:
        from storage.file_blob_store import (
            ATTACHMENTS_SEGMENT,
            TENANT_ARTIFACTS_SEGMENT,
            FileBlobStore,
        )

        file_blob = FileBlobStore.from_env()
        for segment in (ATTACHMENTS_SEGMENT, TENANT_ARTIFACTS_SEGMENT):
            prefix = f"{tenant_id}/{segment}/"
            blobs_deleted, blobs_failed = await file_blob.delete_prefix(prefix)
            logger.info(
                "[TENANT_CASCADE] tenant_id=%s file_prefix=%s blobs_deleted=%d blobs_failed=%d",
                tenant_id,
                prefix,
                blobs_deleted,
                blobs_failed,
            )
    except Exception as exc:
        logger.warning(
            "[TENANT_CASCADE] tenant_id=%s file blob cleanup skipped (meta already removed): %s",
            tenant_id,
            exc,
        )

    await sync_runtime_after_config_change(
        f"tenant_delete:{tenant_id}",
        agents=True,
        tools=True,
    )


# ---------------------------------------------------------------------------
# Tenant Settings (tenant_admin+ for own tenant, root for any)
# ---------------------------------------------------------------------------

async def _check_tenant_access(tenant_id: str, user: dict):
    """Verify user has access to the given tenant's settings."""
    if user["role"] == "root":
        return  # root can access any tenant
    if user.get("tenant_id") != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only access your own tenant's settings",
        )


@router.get("/{tenant_id}/settings", response_model=TenantSettingsResponse)
async def get_tenant_settings(
    tenant_id: str, user: dict = Depends(require_role("tenant_admin"))
):
    """Get tenant settings (sensitive fields masked)."""
    await _check_tenant_access(tenant_id, user)
    storage = deps.get_storage()

    settings = await storage.get_tenant_settings(tenant_id)
    if not settings:
        # Return empty defaults
        settings = {"_id": tenant_id}

    masked = _mask_sensitive(settings)
    return TenantSettingsResponse.model_validate(masked)


@router.put("/{tenant_id}/settings", response_model=TenantSettingsResponse)
async def update_tenant_settings(
    tenant_id: str,
    body: TenantSettingsUpdate,
    user: dict = Depends(require_role("tenant_admin")),
    ctx: TenantContext = Depends(get_tenant_context)
):
    """Update tenant settings (partial merge)."""
    await _check_tenant_access(tenant_id, user)
    storage = deps.get_storage()

    # Verify tenant exists
    tenant = await storage.get_tenant(tenant_id)
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")

    existing = await storage.get_tenant_settings(tenant_id) or {"_id": tenant_id}
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No fields to update")

    # Defense in depth: never persist masked placeholders back to storage.
    for field in _MASKED_FIELDS:
        value = updates.get(field)
        if isinstance(value, str) and "***" in value:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Field '{field}' looks masked; send real secret or omit this field",
            )

    existing.update(updates)
    await storage.save_tenant_settings(existing, actor_id=ctx.user_id)
    logger.info("Tenant settings updated: %s by %s", tenant_id, user["email"])

    masked = _mask_sensitive(existing)
    return TenantSettingsResponse.model_validate(masked)


@router.get(
    "/{tenant_id}/default-model",
    response_model=TenantEffectiveDefaultModelResponse,
)
async def get_tenant_effective_default_model(
    tenant_id: str,
    user: dict = Depends(require_role("tenant_admin")),
):
    """Effective default model for this tenant (for agent creation pre-fill).

    Resolution chain:
      1. tenant_settings.default_model  — if valid (contains '/')
      2. system_info.default_model      — global fallback
      3. 'gpt-5-mini'                   — hardcoded last resort
    """
    await _check_tenant_access(tenant_id, user)
    storage = deps.get_storage()

    from llm.agent_model_params import resolve_tenant_default_model

    model_id, source = await resolve_tenant_default_model(storage, tenant_id)

    logger.info(
        "[TENANT_DEFAULT_MODEL] tenant_id=%s source=%s model_id=%s",
        tenant_id,
        source,
        model_id,
    )
    return TenantEffectiveDefaultModelResponse(model_id=model_id, source=source)


# ---------------------------------------------------------------------------
# MCP export keys (tenant_admin+ for own tenant, root for any)
# ---------------------------------------------------------------------------

@router.post(
    "/{tenant_id}/mcp-export-keys",
    response_model=McpExportApiKeyCreatedResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_tenant_mcp_export_key(
    tenant_id: str,
    body: McpExportApiKeyCreate,
    user: dict = Depends(require_role("tenant_admin")),
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Create MCP cursor-json-http export key for tenant (plaintext shown once)."""
    await _check_tenant_access(tenant_id, user)
    storage = deps.get_storage()
    tenant = await storage.get_tenant(tenant_id)
    if not tenant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")
    try:
        created = await create_mcp_export_api_key(
            storage,
            tenant_id=tenant_id,
            name=body.name,
            created_by=ctx.user_id,
        )
    except DuplicateMcpExportKeyNameError as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
    return McpExportApiKeyCreatedResponse.model_validate(created)


@router.get(
    "/{tenant_id}/mcp-export-keys",
    response_model=list[McpExportApiKeyListItem],
)
async def list_tenant_mcp_export_keys(
    tenant_id: str,
    user: dict = Depends(require_role("tenant_admin")),
):
    """List tenant MCP export keys (no secrets)."""
    await _check_tenant_access(tenant_id, user)
    storage = deps.get_storage()
    settings = await storage.get_tenant_settings(tenant_id)
    return [
        McpExportApiKeyListItem.model_validate(r)
        for r in list_mcp_export_api_keys(settings)
    ]


@router.delete(
    "/{tenant_id}/mcp-export-keys/{key_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_tenant_mcp_export_key(
    tenant_id: str,
    key_id: str,
    user: dict = Depends(require_role("tenant_admin")),
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Revoke one tenant MCP export key by id."""
    await _check_tenant_access(tenant_id, user)
    storage = deps.get_storage()
    ok = await revoke_mcp_export_api_key(
        storage,
        tenant_id=tenant_id,
        key_id=key_id,
        actor_id=ctx.user_id,
    )
    if not ok:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="API key not found")

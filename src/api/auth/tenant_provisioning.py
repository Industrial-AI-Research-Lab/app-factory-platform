"""Tenant provisioning — mark tenant ready for live configuration inheritance."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

from config.configuration_resolution import SYSTEM_TENANT_ID

PROVISION_ORDER = ("agents", "workflows", "run_configs", "tools")


class TenantProvisioningError(RuntimeError):
    """Raised when tenant provisioning fails."""

    def __init__(
        self,
        message: str,
        *,
        rollback_failures: list[dict[str, str]] | None = None,
    ) -> None:
        super().__init__(message)
        self.rollback_failures = rollback_failures or []


def _normalize_doc(doc: Any) -> dict[str, Any]:
    if isinstance(doc, dict):
        return dict(doc)
    if hasattr(doc, "model_dump"):
        return doc.model_dump(by_alias=True)
    return dict(doc)


async def _set_tenant_provisioning_state(
    storage,
    tenant_id: str,
    status: str,
    *,
    actor_id: str,
    error: str | None = None,
) -> None:
    if not hasattr(storage, "get_tenant") or not hasattr(storage, "save_tenant"):
        return

    try:
        tenant = await storage.get_tenant(tenant_id)
        if not tenant:
            logger.warning(
                "[TENANT_PROVISION] tenant_id=%s status=%s - tenant document not found while updating provisioning state",
                tenant_id,
                status,
            )
            return

        updated = dict(tenant)
        updated["provisioning_status"] = status
        if status == "completed":
            updated["provisioned_at"] = datetime.now(timezone.utc).isoformat()
            updated.pop("provisioning_error", None)
        elif status == "failed":
            if error:
                updated["provisioning_error"] = error
            updated.setdefault("provisioned_at", None)
        elif status == "pending":
            updated.setdefault("provisioned_at", None)
            updated.pop("provisioning_error", None)

        await storage.save_tenant(updated, actor_id=actor_id)
    except Exception as exc:
        logger.warning(
            "[TENANT_PROVISION] tenant_id=%s status=%s - failed to persist provisioning state: %s",
            tenant_id,
            status,
            exc,
        )


async def _delete_clone(storage, kind: str, clone_id: str) -> bool:
    if kind == "agents":
        return bool(await storage.delete_agent_configuration(clone_id))
    if kind == "workflows":
        return bool(await storage.delete_workflow_definition(clone_id))
    if kind == "tools":
        if hasattr(storage, "get_mcp_tool_configuration"):
            mcp_doc = await storage.get_mcp_tool_configuration(clone_id)
            if mcp_doc:
                return bool(await storage.delete_mcp_tool_configuration(clone_id))
        return bool(await storage.delete_tool_configuration(clone_id))
    if kind == "run_configs":
        if hasattr(storage, "delete_run_configuration"):
            return bool(await storage.delete_run_configuration(clone_id))
        store = getattr(storage, "run_config_store", None)
        if store and hasattr(store, "delete_config"):
            return bool(await store.delete_config(clone_id))
        return False
    raise ValueError(f"Unknown provisioning kind: {kind}")


def _is_legacy_prefixed_clone(doc: dict[str, Any], tenant_id: str) -> bool:
    """True when ``_id`` uses the pre-migration ``{tenant}__{name}`` storage key."""
    doc_id = str(doc.get("_id") or "")
    prefix = f"{tenant_id}__"
    return doc_id.startswith(prefix) and len(doc_id) > len(prefix)


async def _get_tenant_clones(storage, kind: str, tenant_id: str) -> list[dict[str, Any]]:
    if kind == "agents":
        docs = await storage.get_agent_configurations(enabled_only=False, tenant_id=None)
        normalized = [_normalize_doc(doc) for doc in docs]
        return [
            doc
            for doc in normalized
            if doc.get("tenant_id") == tenant_id and _is_legacy_prefixed_clone(doc, tenant_id)
        ]

    if kind == "workflows":
        docs = await storage.get_workflow_definitions(tenant_id=None)
        normalized = [_normalize_doc(doc) for doc in docs]
        return [
            doc
            for doc in normalized
            if doc.get("tenant_id") == tenant_id and _is_legacy_prefixed_clone(doc, tenant_id)
        ]

    if kind == "tools":
        from storage.tool_doc_storage import get_mcp_tool_configurations

        docs = await storage.get_tool_configurations(enabled_only=False, tenant_id=None)
        mcp_docs = await get_mcp_tool_configurations(storage, enabled_only=False, tenant_id=None)
        normalized = [_normalize_doc(doc) for doc in list(docs) + list(mcp_docs)]
        return [
            doc
            for doc in normalized
            if doc.get("tenant_id") == tenant_id and _is_legacy_prefixed_clone(doc, tenant_id)
        ]

    if kind == "run_configs":
        if hasattr(storage, "get_run_configurations"):
            docs = await storage.get_run_configurations(tenant_id=tenant_id)
            normalized = [_normalize_doc(doc) for doc in docs]
            return [
                doc for doc in normalized if _is_legacy_prefixed_clone(doc, tenant_id)
            ]

        store = getattr(storage, "run_config_store", None)
        if not store or not hasattr(store, "list_configs"):
            return []

        docs = await store.list_configs(None)
        normalized = [_normalize_doc(doc) for doc in docs]
        return [
            doc
            for doc in normalized
            if doc.get("tenant_id") == tenant_id and _is_legacy_prefixed_clone(doc, tenant_id)
        ]

    raise ValueError(f"Unknown provisioning kind: {kind}")


async def cleanup_tenant_clones(storage, tenant_id: str) -> dict[str, Any]:
    """Best-effort cleanup for orphaned cloned documents of one tenant."""
    deleted: dict[str, int] = {kind: 0 for kind in PROVISION_ORDER}
    failures: list[dict[str, str]] = []

    for kind in reversed(PROVISION_ORDER):
        clones = await _get_tenant_clones(storage, kind, tenant_id)
        for clone in reversed(clones):
            clone_id = str(clone["_id"])
            try:
                removed = await _delete_clone(storage, kind, clone_id)
            except Exception as exc:
                failures.append(
                    {
                        "kind": kind,
                        "clone_id": clone_id,
                        "error": str(exc),
                    }
                )
                logger.warning(
                    "[TENANT_PROVISION] tenant_id=%s kind=%s clone_id=%s - cleanup failed: %s",
                    tenant_id,
                    kind,
                    clone_id,
                    exc,
                )
                continue

            if removed:
                deleted[kind] += 1
                continue

            failures.append(
                {
                    "kind": kind,
                    "clone_id": clone_id,
                    "error": "delete returned no-op",
                }
            )
            logger.warning(
                "[TENANT_PROVISION] tenant_id=%s kind=%s clone_id=%s - cleanup delete returned no-op",
                tenant_id,
                kind,
                clone_id,
            )

    return {"deleted": deleted, "failures": failures}


async def provision_tenant(storage, tenant_id: str, actor_id: str = "system") -> dict[str, int]:
    """Mark tenant provisioned without cloning configurations (live inheritance)."""
    counts: dict[str, int] = {kind: 0 for kind in PROVISION_ORDER}

    logger.info(
        "[TENANT_PROVISION] tenant_id=%s - started (live inheritance, no config clones)",
        tenant_id,
    )
    await _set_tenant_provisioning_state(
        storage=storage,
        tenant_id=tenant_id,
        status="pending",
        actor_id=actor_id,
    )

    if not hasattr(storage, "get_tenant"):
        message = "Storage backend does not support tenant documents"
        await _set_tenant_provisioning_state(
            storage=storage,
            tenant_id=tenant_id,
            status="failed",
            actor_id=actor_id,
            error=message,
        )
        raise TenantProvisioningError(message)

    tenant = await storage.get_tenant(tenant_id)
    if not tenant:
        message = f"Tenant '{tenant_id}' not found"
        await _set_tenant_provisioning_state(
            storage=storage,
            tenant_id=tenant_id,
            status="failed",
            actor_id=actor_id,
            error=message,
        )
        raise TenantProvisioningError(message)

    await _set_tenant_provisioning_state(
        storage=storage,
        tenant_id=tenant_id,
        status="completed",
        actor_id=actor_id,
    )
    logger.info(
        "[TENANT_PROVISION] tenant_id=%s - completed (inherit from %s at read time)",
        tenant_id,
        SYSTEM_TENANT_ID,
    )
    return counts

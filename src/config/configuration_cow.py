"""Copy-on-write helpers for tenant configuration overrides."""

from __future__ import annotations

from typing import Any, Callable, Awaitable

from config.configuration_resolution import (
    SYSTEM_TENANT_ID,
    ResolvedConfiguration,
    agent_wire_name_from_doc,
    normalize_configuration_identity,
    resolve_configuration_storage_id_for_upsert,
)

ResolveConfigurationFn = Callable[[str, str], Awaitable[ResolvedConfiguration | None]]
GetConfigurationFn = Callable[[str], Awaitable[dict[str, Any] | None]]
FindByNameFn = Callable[[str, str], Awaitable[dict[str, Any] | None]]


async def prepare_configuration_cow_update(
    existing: dict[str, Any],
    *,
    tenant_id: str,
    updates: dict[str, Any],
    resolve_configuration: ResolveConfigurationFn,
    get_configuration: GetConfigurationFn | None = None,
    find_by_name: FindByNameFn | None = None,
) -> tuple[dict[str, Any], str]:
    """Build the document to persist for a tenant configuration update.

    When ``existing`` belongs to ``__system__``, creates or updates a tenant
    override without mutating the system source.

    Returns ``(merged_document, storage_id)``.
    """
    owner = str(existing.get("tenant_id") or "").strip()
    requester = str(tenant_id or "").strip()
    if not requester:
        raise ValueError("tenant_id is required for configuration update")

    if owner == requester:
        merged = {**existing, **updates}
        return merged, str(existing["_id"])

    if owner != SYSTEM_TENANT_ID:
        raise PermissionError("Cannot modify configuration from another tenant")

    wire_name = agent_wire_name_from_doc(existing, runtime_tenant_id=requester)
    if not wire_name:
        raise ValueError("Inherited configuration is missing wire identity")

    resolved = await resolve_configuration(requester, wire_name)
    if resolved is not None and not resolved.inherited:
        override = resolved.document
        merged = {**override, **updates}
        return merged, str(override["_id"])

    _ = get_configuration
    existing_by_name = (
        await find_by_name(requester, wire_name) if find_by_name is not None else None
    )
    if existing_by_name is not None and existing_by_name.get("enabled") is False:
        storage_id = str(existing_by_name["_id"])
        merged = normalize_configuration_identity(
            {
                **existing_by_name,
                **updates,
                "_id": storage_id,
                "tenant_id": requester,
            },
            wire_id=wire_name,
        )
        if "enabled" not in updates:
            merged["enabled"] = False
        return merged, storage_id

    storage_id = resolve_configuration_storage_id_for_upsert(
        tenant_id=requester,
        wire_name=wire_name,
        existing_by_name=existing_by_name,
    )
    base = {
        key: value
        for key, value in existing.items()
        if key not in {"created_at", "created_by", "updated_at", "updated_by"}
    }
    merged = normalize_configuration_identity(
        {
            **base,
            **updates,
            "_id": storage_id,
            "tenant_id": requester,
        },
        wire_id=wire_name,
    )
    return merged, storage_id

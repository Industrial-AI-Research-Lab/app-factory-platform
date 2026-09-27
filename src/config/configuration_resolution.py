"""Configuration identity resolution: (tenant_id, name) with system fallback."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

SYSTEM_TENANT_ID = "__system__"
WIRE_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
OPAQUE_STORAGE_ID_RE = re.compile(
    r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{24})$",
    re.IGNORECASE,
)

ResolveConfigurationFn = Callable[[str, str], Awaitable[Optional["ResolvedConfiguration"]]]


@dataclass(frozen=True, slots=True)
class ResolvedConfiguration:
    """A configuration document resolved for a requesting tenant."""

    document: dict[str, Any]
    tenant_id: str
    name: str
    inherited: bool


def configuration_identity_name(doc: dict[str, Any]) -> Optional[str]:
    """Return the stored ``name`` field (wire name after migration)."""
    name = doc.get("name")
    if isinstance(name, str):
        stripped = name.strip()
        if stripped:
            return stripped
    return None


def is_wire_configuration_name(value: str | None) -> bool:
    """Return whether ``value`` matches the configuration wire-name pattern."""
    text = str(value or "").strip()
    return bool(text and WIRE_NAME_RE.fullmatch(text))


def is_opaque_storage_id(value: str | None) -> bool:
    """True for UUIDv7 or legacy ObjectId storage keys (not wire names)."""
    return bool(OPAQUE_STORAGE_ID_RE.fullmatch(str(value or "").strip()))


def mint_configuration_storage_id() -> str:
    """Mint opaque UUIDv7 storage ``_id`` for new configuration documents."""
    from uuid_utils import uuid7

    return str(uuid7())


def _configuration_wire_from_doc(
    doc: dict[str, Any],
    *,
    runtime_tenant_id: str | None = None,
) -> str | None:
    if doc.get("source") == "mcp_server":
        from config.tool_configuration_schema import tool_wire_name_from_doc

        wire = tool_wire_name_from_doc(doc)
        return wire or None
    return agent_wire_name_from_doc(doc, runtime_tenant_id=runtime_tenant_id)


def _configuration_identity_matches(
    doc: dict[str, Any],
    *,
    tenant_id: str,
    wire_name: str,
) -> bool:
    owner = str(doc.get("tenant_id") or "").strip()
    wire = _configuration_wire_from_doc(doc, runtime_tenant_id=owner)
    return owner == str(tenant_id or "").strip() and wire == str(wire_name or "").strip()


def _mcp_tool_row_matches_incoming(
    existing: dict[str, Any],
    *,
    existing_by_id: dict[str, Any] | None,
    incoming_rpc_name: str | None,
    incoming_mcp_server: str | None,
    preassigned_id: str | None,
) -> bool:
    """True when ``existing`` is the same MCP tool row as the incoming save."""
    storage_id = str(existing.get("_id") or "")
    if existing_by_id and str(existing_by_id.get("_id") or "") == storage_id:
        return True
    preassigned = str(preassigned_id or "").strip()
    if preassigned and preassigned == storage_id:
        return True
    ex_rpc = str(existing.get("rpc_name") or "").strip()
    ex_server = str(existing.get("mcp_server") or "").strip()
    in_rpc = str(incoming_rpc_name or "").strip()
    in_server = str(incoming_mcp_server or "").strip()
    if in_rpc and ex_rpc and in_rpc != ex_rpc:
        return False
    if in_server and ex_server and in_server != ex_server:
        return False
    return True


def resolve_configuration_storage_id_for_upsert(
    *,
    tenant_id: str,
    wire_name: str,
    existing_by_name: dict[str, Any] | None = None,
    existing_by_id: dict[str, Any] | None = None,
    preassigned_id: str | None = None,
    incoming_rpc_name: str | None = None,
    incoming_mcp_server: str | None = None,
) -> str:
    """Mint UUIDv7 for new docs; reuse storage ``_id`` only for same (tenant, wire)."""
    tenant = str(tenant_id or "").strip()
    wire = str(wire_name or "").strip()
    if not wire:
        raise ValueError("wire_name is required")

    if isinstance(existing_by_name, dict) and _configuration_identity_matches(
        existing_by_name,
        tenant_id=tenant,
        wire_name=wire,
    ):
        if not _mcp_tool_row_matches_incoming(
            existing_by_name,
            existing_by_id=existing_by_id,
            incoming_rpc_name=incoming_rpc_name,
            incoming_mcp_server=incoming_mcp_server,
            preassigned_id=preassigned_id,
        ):
            raise ValueError(
                f"wire name {wire!r} already used by a different MCP tool in tenant {tenant!r}"
            )
        return str(existing_by_name["_id"])

    if isinstance(existing_by_id, dict) and _configuration_identity_matches(
        existing_by_id,
        tenant_id=tenant,
        wire_name=wire,
    ):
        return str(existing_by_id["_id"])

    if isinstance(existing_by_id, dict):
        owner = str(existing_by_id.get("tenant_id") or "").strip()
        storage_id = str(existing_by_id["_id"])
        preassigned = str(preassigned_id or "").strip()
        if owner == tenant and preassigned == storage_id and is_opaque_storage_id(storage_id):
            return storage_id

    preassigned = str(preassigned_id or "").strip()
    if preassigned and is_opaque_storage_id(preassigned):
        return preassigned

    return mint_configuration_storage_id()


def allocate_override_storage_id(
    *,
    tenant_id: str,
    wire_name: str,
    source_storage_id: str,
    existing_by_name: dict[str, Any] | None = None,
    existing_at_preferred_id: dict[str, Any] | None = None,
) -> str:
    """Pick storage ``_id`` for a first-time tenant override (mint unless exists)."""
    _ = source_storage_id, existing_at_preferred_id
    return resolve_configuration_storage_id_for_upsert(
        tenant_id=str(tenant_id or "").strip(),
        wire_name=str(wire_name or "").strip(),
        existing_by_name=existing_by_name,
    )


def resolve_configuration_storage_id_for_save(
    *,
    requested_id: str,
    tenant_id: str,
    wire_name: str,
    existing_by_id: dict[str, Any] | None = None,
    existing_by_name: dict[str, Any] | None = None,
) -> str:
    """Resolve Mongo ``_id`` for configuration save (identity upsert)."""
    _ = requested_id
    return resolve_configuration_storage_id_for_upsert(
        tenant_id=tenant_id,
        wire_name=wire_name,
        existing_by_id=existing_by_id,
        existing_by_name=existing_by_name,
    )


def normalize_configuration_identity(
    doc: dict[str, Any],
    *,
    wire_id: str | None = None,
) -> dict[str, Any]:
    """Return a copy with wire ``name`` and human label in ``display_name``."""
    out = dict(doc)
    wire = str(wire_id or out.get("name") or "").strip()
    if not wire:
        return out
    current_name = str(out.get("name") or "").strip()
    display = str(out.get("display_name") or "").strip()
    if not display and current_name and current_name != wire:
        out["display_name"] = current_name
    if current_name != wire or not is_wire_configuration_name(current_name):
        out["name"] = wire
    return out


def legacy_clone_bundle_wire_suffix(value: str, tenant_id: str | None) -> str | None:
    """Return bare bundle wire when ``value`` is legacy ``{tenant}__{short_id}`` storage."""
    tenant = str(tenant_id or "").strip()
    text = str(value or "").strip()
    if not tenant or not text:
        return None
    prefix = f"{tenant}__"
    if not text.startswith(prefix):
        return None
    suffix = text[len(prefix):]
    if not suffix or "__" in suffix or len(suffix) > 4:
        return None
    if is_wire_configuration_name(suffix):
        return suffix
    return None


def agent_wire_name_from_doc(
    doc: dict[str, Any],
    *,
    runtime_tenant_id: str | None = None,
) -> str | None:
    """Resolve agent wire name from stored ``name`` or non-opaque bare ``_id``."""
    tenant = str(runtime_tenant_id or doc.get("tenant_id") or "").strip()
    stored_name = configuration_identity_name(doc)
    if stored_name:
        legacy = legacy_clone_bundle_wire_suffix(stored_name, tenant)
        if legacy:
            return legacy
        if is_wire_configuration_name(stored_name):
            return stored_name

    storage_id = str(doc.get("_id") or "").strip()
    if storage_id and not is_opaque_storage_id(storage_id):
        legacy = legacy_clone_bundle_wire_suffix(storage_id, tenant)
        if legacy:
            return legacy
        if is_wire_configuration_name(storage_id):
            return storage_id

    type_name = str(doc.get("type") or "").strip()
    if is_wire_configuration_name(type_name):
        return type_name
    return None


def agent_display_name_from_doc(
    doc: dict[str, Any],
    *,
    runtime_tenant_id: str | None = None,
) -> str:
    """Human-facing agent label for UI and events."""
    explicit = str(doc.get("display_name") or "").strip()
    if explicit:
        return explicit
    wire = agent_wire_name_from_doc(doc, runtime_tenant_id=runtime_tenant_id) or ""
    stored_name = configuration_identity_name(doc) or ""
    if stored_name and stored_name != wire:
        return stored_name
    return wire or str(doc.get("_id") or "").strip() or "agent"


def dedupe_tenant_configs_by_wire_name(
    configs: list[dict[str, Any]],
    tenant_id: str,
    *,
    enabled_only: bool = True,
) -> list[dict[str, Any]]:
    """Resolve tenant overrides over system configs by runtime wire name."""
    by_wire: dict[str, dict[str, Any]] = {}
    tenant = str(tenant_id or "").strip()
    for cfg in configs:
        if enabled_only and cfg.get("enabled") is False:
            continue
        wire = agent_wire_name_from_doc(cfg, runtime_tenant_id=tenant)
        if not wire:
            continue
        existing = by_wire.get(wire)
        if existing is None:
            by_wire[wire] = cfg
            continue
        owner = str(cfg.get("tenant_id") or "").strip()
        existing_owner = str(existing.get("tenant_id") or "").strip()
        if owner == tenant and existing_owner == tenant:
            existing_at = str(
                existing.get("updated_at") or existing.get("created_at") or ""
            )
            candidate_at = str(cfg.get("updated_at") or cfg.get("created_at") or "")
            if candidate_at >= existing_at:
                by_wire[wire] = cfg
        elif owner == tenant and existing_owner != tenant:
            by_wire[wire] = cfg
        elif owner == tenant and existing_owner == SYSTEM_TENANT_ID:
            by_wire[wire] = cfg
    result = list(by_wire.values())
    if enabled_only:
        result = [cfg for cfg in result if cfg.get("enabled") is not False]
    return result


def find_agent_wire_name_collision_in_configs(
    configs: list[dict[str, Any]],
    *,
    tenant_id: str,
    wire_name: str,
    exclude_storage_id: str | None = None,
) -> dict[str, Any] | None:
    """Return a tenant-owned config whose runtime wire name collides."""
    tenant = str(tenant_id or "").strip()
    wire = str(wire_name or "").strip()
    exclude = str(exclude_storage_id or "").strip()
    if not tenant or not wire:
        return None
    for cfg in configs:
        if not isinstance(cfg, dict):
            continue
        if str(cfg.get("tenant_id") or "").strip() != tenant:
            continue
        storage_id = str(cfg.get("_id") or "").strip()
        if exclude and storage_id == exclude:
            continue
        existing_wire = agent_wire_name_from_doc(cfg, runtime_tenant_id=tenant)
        if existing_wire == wire:
            return cfg
    return None


async def find_agent_wire_name_collision(
    storage,
    tenant_id: str,
    wire_name: str,
    *,
    exclude_storage_id: str | None = None,
) -> dict[str, Any] | None:
    """Find a stored agent whose wire identity collides within ``tenant_id``."""
    configs = await storage.get_agent_configurations(enabled_only=False, tenant_id=tenant_id)
    return find_agent_wire_name_collision_in_configs(
        configs if isinstance(configs, list) else [],
        tenant_id=tenant_id,
        wire_name=wire_name,
        exclude_storage_id=exclude_storage_id,
    )


def render_openai_tool(
    *,
    name: str,
    description: str = "",
    parameters: object = None,
) -> dict[str, Any]:
    """Build the OpenAI function-calling envelope at emit time (not stored)."""
    from tools.agent_tool_schemas import ensure_openai_function_schema

    wire_name = str(name or "").strip()
    if parameters is None:
        params: object = {"type": "object", "properties": {}}
    else:
        params = parameters
    return ensure_openai_function_schema(
        params,
        function_name=wire_name,
        description=str(description or ""),
    )


async def resolve_by_tenant_and_name(
    collection: Any,
    tenant_id: str,
    name: str,
    *,
    system_tenant_id: str = SYSTEM_TENANT_ID,
) -> Optional[ResolvedConfiguration]:
    """Resolve ``(tenant_id, name)`` with override-first, then system fallback."""
    normalized_tenant = str(tenant_id or "").strip()
    normalized_name = str(name or "").strip()
    if not normalized_tenant or not normalized_name:
        logger.warning(
            "[RESOLUTION] skip empty tenant_id=%r name=%r",
            tenant_id,
            name,
        )
        return None

    tenant_doc = await collection.find_one(
        {"tenant_id": normalized_tenant, "name": normalized_name},
    )
    if isinstance(tenant_doc, dict) and tenant_doc.get("enabled") is not False:
        wire = agent_wire_name_from_doc(
            tenant_doc,
            runtime_tenant_id=normalized_tenant,
        )
        return ResolvedConfiguration(
            document=tenant_doc,
            tenant_id=normalized_tenant,
            name=wire or normalized_name,
            inherited=False,
        )

    if normalized_tenant == system_tenant_id:
        return None

    system_doc = await collection.find_one(
        {"tenant_id": system_tenant_id, "name": normalized_name},
    )
    if not isinstance(system_doc, dict):
        return None

    return ResolvedConfiguration(
        document=system_doc,
        tenant_id=system_tenant_id,
        name=normalized_name,
        inherited=True,
    )


async def resolve_tenant_config_for_read(
    doc: dict[str, Any],
    *,
    tenant_id: str,
    resolve_configuration: ResolveConfigurationFn,
) -> dict[str, Any]:
    """When a tenant reads a ``__system__`` doc by storage id, return tenant override if any."""
    tenant = str(tenant_id or "").strip()
    if not tenant or str(doc.get("tenant_id") or "").strip() != SYSTEM_TENANT_ID:
        return doc
    wire = agent_wire_name_from_doc(doc, runtime_tenant_id=tenant)
    if not wire:
        return doc
    resolved = await resolve_configuration(tenant, wire)
    if resolved is not None and not resolved.inherited:
        return resolved.document
    return doc

"""Dangling configuration references — single resolver for API and UI."""

from __future__ import annotations

from typing import Any

from config.agent_delegation_identity import (
    agent_identity_from_config,
    bare_delegation_name,
)
from config.tool_configuration_schema import tool_wire_name_from_doc
from tools.agent_allowed_tools import (
    DELEGATE_TO_AGENT_TOOL,
    apply_agent_tool_allowlist_normalization,
    is_mcp_public_tool_id,
)
from tools.mcp_tool_ids import mcp_public_tool_id_from_doc, parse_mcp_public_tool_id

ALL_DELEGATION_TARGETS_TOKEN = "*"


def mcp_reference_installed(
    tool_ref: str,
    catalog: set[str],
    *,
    tenant_id: str | None = None,
) -> bool:
    """Return whether an MCP public reference resolves in the tenant catalog."""
    ref = str(tool_ref or "").strip()
    if not ref:
        return True
    if ref in catalog:
        return True
    parsed = parse_mcp_public_tool_id(ref)
    if not parsed:
        return False
    server_id, mcp_name = parsed
    public_id = f"{server_id}.{mcp_name}"
    if public_id in catalog:
        return True
    if tenant_id and server_id == tenant_id and mcp_name in catalog:
        return True
    if tenant_id:
        tenant_scoped = f"{tenant_id}.{public_id}"
        if tenant_scoped in catalog:
            return True
    return False


async def build_reference_catalogs(
    storage: Any,
    tenant_id: str,
) -> dict[str, set[str]]:
    """Build builtin/MCP/agent name catalogs for one tenant inheritance scope."""
    from storage.tool_doc_storage import get_mcp_tool_configurations

    builtin_names: set[str] = set()
    tool_docs = await storage.get_tool_configurations(
        enabled_only=False,
        tenant_id=tenant_id,
    )
    for doc in tool_docs:
        if not isinstance(doc, dict):
            continue
        wire = tool_wire_name_from_doc(doc)
        if wire:
            builtin_names.add(wire)
        storage_id = str(doc.get("_id") or "").strip()
        if storage_id:
            builtin_names.add(storage_id)

    mcp_catalog: set[str] = set()
    mcp_docs = await get_mcp_tool_configurations(
        storage,
        enabled_only=False,
        tenant_id=tenant_id,
    )
    for doc in mcp_docs:
        if not isinstance(doc, dict):
            continue
        wire = tool_wire_name_from_doc(doc)
        if wire:
            mcp_catalog.add(wire)
        public_id = mcp_public_tool_id_from_doc(doc)
        if public_id:
            mcp_catalog.add(public_id)
            if tenant_id:
                mcp_catalog.add(f"{tenant_id}.{public_id}")
        storage_id = str(doc.get("_id") or "").strip()
        if storage_id:
            mcp_catalog.add(storage_id)

    agent_names: set[str] = set()
    agent_docs = await storage.get_agent_configurations(
        enabled_only=False,
        tenant_id=tenant_id,
    )
    for doc in agent_docs:
        if not isinstance(doc, dict):
            continue
        _, wire_name = agent_identity_from_config(doc, runtime_tenant_id=tenant_id)
        if wire_name:
            agent_names.add(wire_name)
        storage_id = str(doc.get("_id") or "").strip()
        if storage_id:
            agent_names.add(bare_delegation_name(storage_id, tenant_id))

    return {
        "builtin": builtin_names,
        "mcp": mcp_catalog,
        "agents": agent_names,
    }


def collect_dangling_references(
    doc: dict[str, Any],
    catalogs: dict[str, set[str]],
    *,
    tenant_id: str,
) -> list[str]:
    """Return allow-list entries that do not resolve for ``tenant_id`` (warn-only)."""
    normalized = apply_agent_tool_allowlist_normalization(doc)
    builtin_catalog = catalogs.get("builtin") or set()
    mcp_catalog = catalogs.get("mcp") or set()
    agent_catalog = catalogs.get("agents") or set()

    dangling: list[str] = []
    seen: set[str] = set()

    def add_dangling(ref: str) -> None:
        text = str(ref or "").strip()
        if not text or text in seen:
            return
        seen.add(text)
        dangling.append(text)

    for ref in normalized.get("allowed_tools") or []:
        if ref == DELEGATE_TO_AGENT_TOOL:
            continue
        if is_mcp_public_tool_id(ref):
            if not mcp_reference_installed(ref, mcp_catalog, tenant_id=tenant_id):
                add_dangling(ref)
        elif ref not in builtin_catalog:
            add_dangling(ref)

    for ref in normalized.get("allowed_mcp_tools") or []:
        if ref in builtin_catalog:
            continue
        if not mcp_reference_installed(ref, mcp_catalog, tenant_id=tenant_id):
            add_dangling(ref)

    for ref in normalized.get("allowed_delegation_targets") or []:
        if str(ref).strip() == ALL_DELEGATION_TARGETS_TOKEN:
            continue
        bare = bare_delegation_name(str(ref), tenant_id)
        if bare and bare not in agent_catalog:
            add_dangling(str(ref).strip())

    return dangling


async def dangling_references_for_agent(
    storage: Any,
    doc: dict[str, Any],
    *,
    tenant_id: str,
) -> list[str]:
    """Resolve dangling references for one agent document."""
    catalogs = await build_reference_catalogs(storage, tenant_id)
    return collect_dangling_references(doc, catalogs, tenant_id=tenant_id)

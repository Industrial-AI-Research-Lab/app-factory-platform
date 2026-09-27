"""Startup guards for configuration identity invariants."""

from __future__ import annotations

import logging
from typing import Any

from config.configuration_reference_validation import (
    collect_known_wire_names_from_agent_docs,
    legacy_tenant_prefix_in_reference,
    known_tenant_ids_from_storage,
)
from config.configuration_resolution import (
    SYSTEM_TENANT_ID,
    _configuration_wire_from_doc,
)
from storage.tool_doc_storage import get_mcp_tool_configurations

logger = logging.getLogger(__name__)

_SKIP_LEGACY_STORAGE_TENANTS = frozenset({SYSTEM_TENANT_ID, "__root__"})

_AGENT_REF_FIELDS = (
    "allowed_tools",
    "allowed_mcp_tools",
    "allowed_delegation_targets",
)


def _prefixed_refs(
    values: Any,
    *,
    field: str,
    doc_id: str,
    tenant_id: str,
    known_tenant_ids: frozenset[str],
    known_wire_names: frozenset[str],
) -> list[str]:
    violations: list[str] = []
    if not isinstance(values, list):
        return violations
    for ref in values:
        text = str(ref or "").strip()
        legacy_tenant = legacy_tenant_prefix_in_reference(
            text,
            known_tenant_ids,
            known_wire_names=known_wire_names,
        )
        if legacy_tenant is not None:
            violations.append(
                f"{tenant_id}/{doc_id}: {field} has prefixed ref '{text}' "
                "(run python -m scripts.migrate_config_identity_uuidv7 --apply)",
            )
    return violations


def _legacy_prefixed_storage_id_violation(
    doc_id: str,
    *,
    tenant_id: str,
    kind: str,
    name: str | None = None,
) -> str | None:
    tenant = str(tenant_id or "").strip()
    storage_id = str(doc_id or "").strip()
    identity_name = str(name or "").strip()
    if not tenant or tenant in _SKIP_LEGACY_STORAGE_TENANTS or not storage_id:
        return None
    # Wire names like ``data__loader`` use ``_id == name`` in the same tenant.
    if identity_name and storage_id == identity_name:
        return None
    prefix = f"{tenant}__"
    if storage_id.startswith(prefix) and len(storage_id) > len(prefix):
        return (
            f"{tenant}/{storage_id}: legacy prefixed {kind} storage _id "
            "(run python -m scripts.migrate_config_identity_uuidv7 --apply)"
        )
    return None


def _identity_collapse_violations(
    docs: list[dict[str, Any]],
    *,
    kind: str,
) -> list[str]:
    """Flag ``(tenant_id, wire)`` groups holding more than one document.

    After migration each ``(tenant, wire)`` identity has exactly one document
    (the partial unique index on ``(tenant_id, name)`` enforces it). Two
    documents resolving to the same wire — e.g. a clean UUIDv7 doc beside a
    legacy bare-``_id`` orphan whose human label still lives in ``name`` — is the
    un-migrated shape the migration's collapse step removes. It is invisible to
    the prefixed-id check above (orphans carry no ``{tenant}__`` prefix and the
    skipped ``__system__``/``__root__`` tenants are where they cluster), yet each
    such group becomes a duplicate agent in the pool / duplicate tool in the
    catalog at runtime.
    """
    groups: dict[tuple[str, str], list[str]] = {}
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        tenant = str(doc.get("tenant_id") or "").strip()
        wire = _configuration_wire_from_doc(doc, runtime_tenant_id=tenant)
        if not tenant or not wire:
            continue
        groups.setdefault((tenant, wire), []).append(str(doc.get("_id") or "?"))
    violations: list[str] = []
    for (tenant, wire), ids in sorted(groups.items()):
        if len(ids) > 1:
            violations.append(
                f"{tenant}/{wire}: {len(ids)} {kind} docs share (tenant, name) "
                f"identity {sorted(ids)} "
                "(run python -m scripts.migrate_config_identity_uuidv7 --apply)"
            )
    return violations


async def assert_stored_configuration_identity_ready(storage) -> None:
    """Fail fast when MongoDB still has legacy prefixed configuration refs."""
    violations: list[str] = []
    known_tenant_ids = await known_tenant_ids_from_storage(storage)

    agents = await storage.get_agent_configurations(enabled_only=False)
    known_wire_names = collect_known_wire_names_from_agent_docs(agents)

    for doc in agents:
        if not isinstance(doc, dict):
            continue
        doc_id = str(doc.get("_id") or "?")
        tenant_id = str(doc.get("tenant_id") or "?")
        legacy_storage = _legacy_prefixed_storage_id_violation(
            doc_id,
            tenant_id=tenant_id,
            kind="agent",
            name=str(doc.get("name") or ""),
        )
        if legacy_storage:
            violations.append(legacy_storage)
        for field in _AGENT_REF_FIELDS:
            violations.extend(
                _prefixed_refs(
                    doc.get(field),
                    field=field,
                    doc_id=doc_id,
                    tenant_id=tenant_id,
                    known_tenant_ids=known_tenant_ids,
                    known_wire_names=known_wire_names,
                ),
            )

    workflows = await storage.get_workflow_definitions()
    for doc in workflows:
        if not isinstance(doc, dict):
            continue
        doc_id = str(doc.get("_id") or "?")
        tenant_id = str(doc.get("tenant_id") or "?")
        legacy_storage = _legacy_prefixed_storage_id_violation(
            doc_id,
            tenant_id=tenant_id,
            kind="workflow",
            name=str(doc.get("name") or ""),
        )
        if legacy_storage:
            violations.append(legacy_storage)
        for node in doc.get("nodes") or []:
            if not isinstance(node, dict) or node.get("agent_selection") != "direct":
                continue
            agent_type = str(node.get("agent_type") or "").strip()
            if legacy_tenant_prefix_in_reference(
                agent_type,
                known_tenant_ids,
                known_wire_names=known_wire_names,
            ) is not None:
                violations.append(
                    f"{tenant_id}/{doc_id}: workflow.nodes.agent_type has prefixed ref "
                    f"'{agent_type}' (run python -m scripts.migrate_config_identity_uuidv7 --apply)",
                )

    tools = await storage.get_tool_configurations(enabled_only=False)
    for doc in tools:
        if not isinstance(doc, dict):
            continue
        doc_id = str(doc.get("_id") or "?")
        tenant_id = str(doc.get("tenant_id") or "?")
        legacy_storage = _legacy_prefixed_storage_id_violation(
            doc_id,
            tenant_id=tenant_id,
            kind="tool",
            name=str(doc.get("name") or ""),
        )
        if legacy_storage:
            violations.append(legacy_storage)

    mcp_tools = await get_mcp_tool_configurations(storage, enabled_only=False, tenant_id=None)
    for doc in mcp_tools:
        if not isinstance(doc, dict):
            continue
        doc_id = str(doc.get("_id") or "?")
        tenant_id = str(doc.get("tenant_id") or "?")
        legacy_storage = _legacy_prefixed_storage_id_violation(
            doc_id,
            tenant_id=tenant_id,
            kind="mcp_tool",
            name=str(doc.get("name") or ""),
        )
        if legacy_storage:
            violations.append(legacy_storage)

    violations.extend(_identity_collapse_violations(agents, kind="agent"))
    violations.extend(_identity_collapse_violations(workflows, kind="workflow"))
    violations.extend(_identity_collapse_violations(tools, kind="tool"))
    violations.extend(_identity_collapse_violations(mcp_tools, kind="mcp_tool"))

    if not violations:
        return

    preview = "; ".join(violations[:8])
    suffix = f" (+{len(violations) - 8} more)" if len(violations) > 8 else ""
    message = (
        "[IDENTITY_GUARD] Configuration identity migration required before runtime. "
        f"{preview}{suffix}"
    )
    logger.error(message)
    raise RuntimeError(message)

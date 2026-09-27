"""Validate configuration references use bare names (no clone prefixes)."""

from __future__ import annotations

from typing import Any, Iterable

from config.configuration_resolution import (
    SYSTEM_TENANT_ID,
    agent_wire_name_from_doc,
    configuration_identity_name,
)

_LEGACY_TENANT_REF_MARKER = "__"
_SKIP_TENANT_IDS = frozenset({SYSTEM_TENANT_ID, "__root__", ""})


def legacy_tenant_prefix_in_reference(
    ref: str,
    known_tenant_ids: frozenset[str],
    *,
    known_wire_names: frozenset[str] | None = None,
) -> str | None:
    """Return the tenant prefix when ``ref`` is legacy ``{tenant}__{rest}``.

    Wire names that intentionally contain ``__`` (e.g. ``data__loader`` in tenant
    ``data``) are not legacy clone refs when the full string is a known wire name.
    """
    text = str(ref or "").strip()
    if not text or text == "*" or _LEGACY_TENANT_REF_MARKER not in text:
        return None
    wires = known_wire_names or frozenset()
    if text in wires:
        return None
    # tenant names can start with the marker (__root__, __system__),
    # so partition() cuts inside the name — iterate explicitly instead.
    for tenant in sorted(known_tenant_ids, key=len, reverse=True):
        prefix = f"{tenant}{_LEGACY_TENANT_REF_MARKER}"
        if text.startswith(prefix) and text[len(prefix):]:
            return tenant
    return None


def collect_agent_wire_names(
    docs: Iterable[dict[str, Any]],
    tenant_id: str,
) -> frozenset[str]:
    """Collect agent wire/storage names for export/migration prefix preservation."""
    from config.configuration_resolution import agent_wire_name_from_doc

    tenant = str(tenant_id or "").strip()
    names: set[str] = set()
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        wire = agent_wire_name_from_doc(doc, runtime_tenant_id=tenant)
        if wire:
            names.add(wire)
        stored_name = configuration_identity_name(doc)
        if stored_name:
            names.add(stored_name)
        doc_id = str(doc.get("_id") or "").strip()
        if doc_id and (doc_id == wire or doc_id == stored_name):
            names.add(doc_id)
    return frozenset(names)


def strip_legacy_tenant_prefixed_value(
    value: str,
    tenant_id: str,
    *,
    wire_name: str | None = None,
    preserve_wire_names: frozenset[str] | None = None,
) -> str:
    """Strip legacy ``{tenant}__{wire}`` without mangling wire ids like ``data__loader``."""
    text = str(value or "").strip()
    tenant = str(tenant_id or "").strip()
    if not text or not tenant:
        return text
    prefix = f"{tenant}{_LEGACY_TENANT_REF_MARKER}"
    if not text.startswith(prefix):
        return text
    preserved = preserve_wire_names or frozenset()
    if text in preserved:
        return text
    if wire_name and text == wire_name:
        return text
    suffix = text[len(prefix):]
    if not suffix:
        return text
    if wire_name and suffix == wire_name:
        return suffix
    if suffix in preserved:
        return suffix
    if (
        legacy_tenant_prefix_in_reference(
            text,
            frozenset({tenant}),
            known_wire_names=preserved,
        )
        is not None
    ):
        return suffix
    return text


def collect_known_wire_names_from_agent_docs(
    docs: Iterable[dict[str, Any]],
) -> frozenset[str]:
    """Collect agent wire/storage names across all tenants."""
    names: set[str] = set()
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        tenant = str(doc.get("tenant_id") or "").strip()
        names.update(collect_agent_wire_names([doc], tenant))
    return frozenset(names)


async def known_wire_names_from_storage(storage) -> frozenset[str]:
    """Collect configuration wire names from stored agent documents."""
    if storage is None or not hasattr(storage, "get_agent_configurations"):
        return frozenset()
    agents = await storage.get_agent_configurations(enabled_only=False)
    return collect_known_wire_names_from_agent_docs(agents)


async def known_tenant_ids_from_storage(storage) -> frozenset[str]:
    """Collect tenant ids from the tenant registry and stored configuration docs."""
    ids: set[str] = set()
    if storage is None:
        return frozenset()

    if hasattr(storage, "get_tenants"):
        for doc in await storage.get_tenants():
            if isinstance(doc, dict):
                tid = str(doc.get("_id") or "").strip()
                if tid and tid not in _SKIP_TENANT_IDS:
                    ids.add(tid)

    if hasattr(storage, "get_agent_configurations"):
        agents = await storage.get_agent_configurations(enabled_only=False)
        ids.update(_tenant_ids_from_docs(agents))
    if hasattr(storage, "get_workflow_definitions"):
        workflows = await storage.get_workflow_definitions()
        ids.update(_tenant_ids_from_docs(workflows))
    if hasattr(storage, "get_tool_configurations"):
        tools = await storage.get_tool_configurations(enabled_only=False)
        ids.update(_tenant_ids_from_docs(tools))

    return frozenset(ids)


def _tenant_ids_from_docs(docs: Iterable[dict[str, Any]]) -> set[str]:
    ids: set[str] = set()
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        tid = str(doc.get("tenant_id") or "").strip()
        if tid and tid not in _SKIP_TENANT_IDS:
            ids.add(tid)
    return ids


def _wire_names_for_validation(
    doc: dict[str, Any] | None,
    known_wire_names: frozenset[str] | None,
) -> frozenset[str]:
    wires = set(known_wire_names or ())
    if isinstance(doc, dict):
        own_name = configuration_identity_name(doc)
        if own_name:
            wires.add(own_name)
        doc_id = str(doc.get("_id") or "").strip()
        if doc_id:
            wires.add(doc_id)
    return frozenset(wires)


def validate_bare_configuration_reference(
    ref: str,
    *,
    field: str,
    known_tenant_ids: frozenset[str] | None = None,
    known_wire_names: frozenset[str] | None = None,
) -> str:
    """Reject legacy clone references such as ``tenant__agent``, not bare ``data__loader``."""
    text = str(ref or "").strip()
    if not text or text == "*":
        return text
    tenants = known_tenant_ids or frozenset()
    if legacy_tenant_prefix_in_reference(
        text,
        tenants,
        known_wire_names=known_wire_names,
    ) is not None:
        raise ValueError(
            f"{field}: prefixed reference '{text}' is not allowed; use bare name",
        )
    return text


def validate_reference_list(
    values: Iterable[str] | None,
    *,
    field: str,
    known_tenant_ids: frozenset[str] | None = None,
    known_wire_names: frozenset[str] | None = None,
) -> list[str] | None:
    if values is None:
        return None
    return [
        validate_bare_configuration_reference(
            item,
            field=field,
            known_tenant_ids=known_tenant_ids,
            known_wire_names=known_wire_names,
        )
        for item in values
    ]


def validate_agent_configuration_references(
    doc: dict[str, Any],
    *,
    known_tenant_ids: frozenset[str] | None = None,
    known_wire_names: frozenset[str] | None = None,
) -> dict[str, Any]:
    """Validate allow-lists on an agent configuration document."""
    out = dict(doc)
    wires = _wire_names_for_validation(out, known_wire_names)
    for field in ("allowed_tools", "allowed_mcp_tools"):
        if field in out:
            out[field] = validate_reference_list(
                out.get(field),
                field=field,
                known_tenant_ids=known_tenant_ids,
                known_wire_names=wires,
            ) or []
    if "allowed_delegation_targets" in out and out["allowed_delegation_targets"] is not None:
        out["allowed_delegation_targets"] = validate_reference_list(
            out.get("allowed_delegation_targets"),
            field="allowed_delegation_targets",
            known_tenant_ids=known_tenant_ids,
            known_wire_names=wires,
        )
    return out


def validate_workflow_node_references(
    nodes: list[dict[str, Any]] | None,
    *,
    known_tenant_ids: frozenset[str] | None = None,
    known_wire_names: frozenset[str] | None = None,
) -> None:
    """Validate workflow node agent references."""
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        if node.get("agent_selection") != "direct":
            continue
        agent_type = node.get("agent_type")
        if agent_type:
            validate_bare_configuration_reference(
                str(agent_type),
                field="workflow.nodes.agent_type",
                known_tenant_ids=known_tenant_ids,
                known_wire_names=known_wire_names,
            )


async def normalize_workflow_node_agent_type_ref(
    ref: str,
    *,
    tenant_id: str,
    storage: Any,
    known_tenant_ids: frozenset[str] | None = None,
    known_wire_names: frozenset[str] | None = None,
) -> str:
    """Return the agent wire name for a workflow ``agent_type`` reference."""
    text = validate_bare_configuration_reference(
        ref,
        field="workflow.nodes.agent_type",
        known_tenant_ids=known_tenant_ids,
        known_wire_names=known_wire_names,
    )
    tenant = str(tenant_id or "").strip()
    if not tenant or not text:
        return text

    resolve = getattr(storage, "resolve_agent_configuration", None)
    if resolve is not None:
        resolved = await resolve(tenant, text)
        if resolved is not None:
            wire = agent_wire_name_from_doc(
                resolved.document,
                runtime_tenant_id=tenant,
            )
            if wire:
                return wire

    get_doc = getattr(storage, "get_agent_configuration", None)
    if get_doc is not None:
        by_storage_id = await get_doc(text)
        if isinstance(by_storage_id, dict):
            owner = str(by_storage_id.get("tenant_id") or "").strip()
            if owner in {tenant, SYSTEM_TENANT_ID}:
                wire = agent_wire_name_from_doc(
                    by_storage_id,
                    runtime_tenant_id=tenant,
                )
                if wire and wire != text:
                    return wire

    return text


async def normalize_workflow_node_references(
    nodes: list[dict[str, Any]] | None,
    *,
    tenant_id: str,
    storage: Any,
    known_tenant_ids: frozenset[str] | None = None,
    known_wire_names: frozenset[str] | None = None,
) -> None:
    """Validate and normalize direct-phase ``agent_type`` values to wire names."""
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        if node.get("agent_selection") != "direct":
            continue
        agent_type = node.get("agent_type")
        if not agent_type:
            continue
        node["agent_type"] = await normalize_workflow_node_agent_type_ref(
            str(agent_type),
            tenant_id=tenant_id,
            storage=storage,
            known_tenant_ids=known_tenant_ids,
            known_wire_names=known_wire_names,
        )

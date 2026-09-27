"""Tool configuration schema: bare parameters in storage, envelope at emit time."""

from __future__ import annotations

from typing import Any, Iterable

from config.configuration_resolution import SYSTEM_TENANT_ID, render_openai_tool
from tools.agent_tool_schemas import existing_function_name
from tools.mcp_tool_ids import mcp_public_tool_id_from_doc


def stored_parameters_from_doc(doc: dict[str, Any]) -> dict[str, Any]:
    """Return bare JSON Schema parameters from a stored tool document."""
    raw = doc.get("schema")
    if raw is None:
        raw = doc.get("parameters")
    if not isinstance(raw, dict):
        return {"type": "object", "properties": {}}
    if raw.get("type") == "function" and isinstance(raw.get("function"), dict):
        params = raw["function"].get("parameters")
        if isinstance(params, dict):
            return params
    return raw


def tool_wire_name_from_doc(doc: dict[str, Any]) -> str:
    """Resolve the wire name sent to the LLM for a tool configuration document."""
    from config.configuration_resolution import (
        configuration_identity_name,
        is_opaque_storage_id,
        is_wire_configuration_name,
    )

    stored_name = configuration_identity_name(doc)
    if stored_name and is_wire_configuration_name(stored_name):
        return stored_name

    storage_id = str(doc.get("_id") or "").strip()
    if storage_id and not is_opaque_storage_id(storage_id):
        if is_wire_configuration_name(storage_id):
            return storage_id

    wrapped = existing_function_name(doc.get("schema"))
    if wrapped:
        return wrapped

    return str(doc.get("name") or "").strip()


def tool_description_from_doc(doc: dict[str, Any]) -> str:
    """Return full tool description for LLM wire schema (long detail, not UI short)."""
    long_desc = str(doc.get("long_description") or "").strip()
    if long_desc:
        return long_desc
    desc = str(doc.get("description") or "").strip()
    if desc:
        return desc
    short = str(doc.get("short_description") or "").strip()
    if short:
        return short
    raw = doc.get("schema")
    if isinstance(raw, dict) and raw.get("type") == "function":
        fn = raw.get("function")
        if isinstance(fn, dict):
            legacy = str(fn.get("description") or "").strip()
            if legacy:
                return legacy
    return ""


def render_tool_openai_schema(doc: dict[str, Any]) -> dict[str, Any]:
    """Build the OpenAI function-calling envelope for a tool configuration document."""
    return render_openai_tool(
        name=tool_wire_name_from_doc(doc),
        description=tool_description_from_doc(doc),
        parameters=stored_parameters_from_doc(doc),
    )


def normalize_tool_schema_for_storage(doc: dict[str, Any]) -> None:
    """Persist bare JSON Schema parameters only (no OpenAI function envelope)."""
    if "tool_schema" in doc:
        raw = doc.pop("tool_schema", None)
    else:
        raw = doc.get("schema")
    if raw is None:
        return
    if not isinstance(raw, dict):
        doc.pop("schema", None)
        return
    doc["schema"] = stored_parameters_from_doc({"schema": raw})


def _doc_visible_for_tenant(doc: dict[str, Any], tenant_id: str | None) -> bool:
    if doc.get("source") != "mcp_server":
        return True
    if not tenant_id:
        return False
    doc_tenant = str(doc.get("tenant_id") or "__root__")
    # Shared platform offering (ADR-0013): visible to every tenant; _tenant_rank
    # below still picks the tenant's own fork over the shared doc.
    if doc_tenant == SYSTEM_TENANT_ID:
        return True
    return doc_tenant == str(tenant_id)


def tool_doc_matches_allow_ref(doc: dict[str, Any], allow_ref: str) -> bool:
    """Return whether a stored tool document matches an allow-list wire ref."""
    keys = {str(doc.get("_id") or "")}
    wire = tool_wire_name_from_doc(doc)
    if wire:
        keys.add(wire)
    stored_name = str(doc.get("name") or "").strip()
    if stored_name:
        keys.add(stored_name)
    public_id = mcp_public_tool_id_from_doc(doc)
    if public_id:
        keys.add(public_id)
    return str(allow_ref) in keys


def tool_doc_tenant_rank(doc: dict[str, Any], *, tenant_id: str | None) -> int:
    """Shadow precedence for one allow ref: tenant fork > ``__system__`` > foreign."""
    return _tenant_rank(doc, tenant_id=str(tenant_id or "").strip())


def drop_disabled_effective_docs(
    docs: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Apply the ``enabled`` filter AFTER shadow ranking.

    Filtering candidates first lets a disabled tenant fork fall back to the
    still-enabled ``__system__`` doc it shadows (ADR-0013), offering the model a
    function every dispatch refuses.
    """
    return [doc for doc in docs if bool(doc.get("enabled", True))]


def drop_system_docs_shadowed_by_owned(
    docs: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Drop each ``__system__`` MCP doc a tenant fork shadows by identity.

    Input is already tenant-scoped to ``{tenant, __system__}`` (the storage
    listing query guarantees it), so any non-``__system__`` doc is tenant-owned.
    A fork shadows the shared row by ``(mcp_server, name)`` — the identity it
    copies under ADR-0013 — so a *renamed* fork deliberately stops shadowing its
    origin, and both rows then show by design. ``enabled`` is intentionally NOT
    applied here: shadow first, then drop disabled winners with
    ``drop_disabled_effective_docs`` (ADR-0013), or a disabled fork drops out
    before it can shadow and its still-enabled twin resurfaces.
    """
    dicts = [d for d in docs if isinstance(d, dict)]
    owned = {
        (str(d.get("mcp_server") or "").strip(), str(d.get("name") or "").strip())
        for d in dicts
        if str(d.get("tenant_id") or "").strip() != SYSTEM_TENANT_ID
    }
    return [
        d
        for d in dicts
        if str(d.get("tenant_id") or "").strip() != SYSTEM_TENANT_ID
        or (
            str(d.get("mcp_server") or "").strip(),
            str(d.get("name") or "").strip(),
        )
        not in owned
    ]


def _tenant_rank(doc: dict[str, Any], *, tenant_id: str) -> int:
    owner = str(doc.get("tenant_id") or "").strip()
    if tenant_id and owner == tenant_id:
        return 2
    if owner == SYSTEM_TENANT_ID:
        return 1
    return 0


def select_effective_tool_docs_for_allow(
    docs: Iterable[dict[str, Any]],
    allow: frozenset[str],
    *,
    tenant_id: str | None,
) -> list[dict[str, Any]]:
    """Pick one effective tool document per allow ref; tenant override wins over system."""
    tenant = str(tenant_id or "").strip()
    selected_by_key: dict[str, dict[str, Any]] = {}

    for ref in allow:
        candidates = [
            doc
            for doc in docs
            if tool_doc_matches_allow_ref(doc, ref)
            and _doc_visible_for_tenant(doc, tenant_id)
        ]
        if not candidates:
            continue

        best = max(
            candidates,
            key=lambda doc: _tenant_rank(doc, tenant_id=tenant),
        )
        wire_key = tool_wire_name_from_doc(best) or ref
        selected_by_key[wire_key] = best

    return list(selected_by_key.values())

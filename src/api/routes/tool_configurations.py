"""CRUD endpoints for tool_configurations.

Prefix: /api/configurations/tools
Auth: require_auth (all endpoints), tenant-scoped queries.
"""

import asyncio
import copy
import logging
import os
import re
import json
import uuid
import time
import socket
from collections import defaultdict
from typing import Any, List, Optional, Union
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, ValidationError

from tools.mcp_endpoint_policy import (
    is_allowlisted_mcp_hostname,
    is_blocked_mcp_hostname,
    is_blocked_resolved_mcp_ip,
)

from api.deps import get_storage, get_orchestrator, get_external_mcp_manager
from api.runtime_sync import sync_runtime_after_config_change
from api.auth.middleware import require_role
from api.auth.tenant_context import TenantContext, get_tenant_context
from config.configuration_cow import prepare_configuration_cow_update
from config.configuration_resolution import resolve_tenant_config_for_read
from api.auth.mcp_export_key import get_tenant_context_for_cursor_json_http_export
from schemas.configuration_schemas import (
    ENTITY_DESCRIPTION_FIELDS,
    ToolConfigurationCreate,
    ToolConfigurationUpdate,
    ToolConfigurationResponse,
    ToolCategoriesResponse,
    McpToolGroupResponse,
    MCPToolsBatchCreate,
    MCPToolsBatchCreateResponse,
    MCPServerDiscoverRequest,
    MCPServerDiscoverResponse,
    MCPDiscoveredTool,
    MCPServersHealthCheckRequest,
    MCPServerHealthItem,
    MCPServersHealthResponse,
    McpServerLifecycleRequest,
    McpServerLifecycleResponse,
    McpServerConnectionUpdate,
    McpServerConnectionUpdateResponse,
    MCPHeaderPair,
    A2AAuthConfig,
    AUTH_SECRET_FIELDS,
    sync_entity_descriptions_for_save,
)
from schemas.tenant_schemas import (
    DEFAULT_MCP_CALL_TIMEOUT_MAX_SECONDS,
    resolve_mcp_call_timeout_ceiling,
)
from tools.external_mcp import (
    ExternalMCPClient,
    ExternalMCPConfig,
    format_mcp_user_message,
    stdio_docker_container_name,
    stdio_docker_remove_force,
)
from storage.tool_doc_storage import (
    McpToolInsertConflict,
    count_mcp_tools_on_server,
    delete_tool_document,
    find_tools_by_name,
    get_mcp_tool_configurations,
    insert_mcp_tool_document,
    save_tool_document,
)
from utils.json_lenient import json_loads_lenient
from tools.mcp_internal_docs import is_mcp_internal_tool_name
from tools.mcp_package_storage import derive_zip_runtime_provenance
from tools.mcp_wizard_cleanup import (
    cleanup_server_wizard_state,
    mark_server_wizard_cleanup_pending,
)
from tools.mcp_runtime_headers import runtime_headers_dict
from tools.mcp_auth import build_mcp_auth
from integrations.a2a_auth import validate_auth_env_vars
from tools.mcp_server_lifecycle import McpLifecycleConflict, McpServerLifecycle, McpServerNotFound
from tools.mcp_tool_ids import (
    _tenant_owns_doc,
    mcp_public_tool_id,
    mcp_public_tool_id_from_doc,
    mcp_rpc_name_from_doc,
    mcp_tool_document_id,
    resolve_mcp_tool_doc,
    validate_mcp_segment_id,
    McpSegmentIdError,
)

logger = logging.getLogger(__name__)

SYSTEM_TENANT_ID = "__system__"
DEFAULT_EXTERNAL_MCP_IMAGE = "node:22-bookworm-slim"
_MCP_TOOL_NAME_SAFE = re.compile(r"^[a-zA-Z0-9_-]+$")
_MCP_SERVER_ID_SAFE = re.compile(r"^[a-zA-Z0-9_-]+$")


def _normalize_tool_doc_for_storage(doc: dict) -> None:
    """Persist bare JSON Schema parameters; OpenAI envelope is built at emit time."""
    from config.tool_configuration_schema import normalize_tool_schema_for_storage
    from schemas.configuration_schemas import _normalize_stored_tool_category

    normalize_tool_schema_for_storage(doc)
    if isinstance(doc, dict) and "category" in doc:
        # Wire sentinel must not be persisted as a real category value.
        doc["category"] = _normalize_stored_tool_category(doc.get("category"))


async def _metadata_with_derived_zip_provenance(
    storage,
    *,
    tenant_id: str,
    server_id: str,
    metadata: dict | None,
) -> dict:
    """Replace client ZIP markers with provenance derived from built-image records."""
    derived_metadata = copy.deepcopy(metadata) if isinstance(metadata, dict) else {}
    runtime = derived_metadata.get("external_mcp")
    if isinstance(runtime, dict):
        derived_metadata["external_mcp"] = await derive_zip_runtime_provenance(
            storage,
            tenant_id=tenant_id,
            server_id=server_id,
            runtime=runtime,
        )
    return derived_metadata


def _index_mcp_docs_by_rpc(docs: list) -> dict[str, dict]:
    from tools.mcp_tool_ids import mcp_rpc_name_from_doc

    indexed: dict[str, dict] = {}
    for doc in docs or []:
        if not isinstance(doc, dict):
            continue
        rpc = mcp_rpc_name_from_doc(doc)
        if rpc:
            indexed[rpc] = doc
    return indexed


def _mcp_doc_identity(doc: dict) -> tuple[str, str]:
    """``(mcp_server, effective rpc)`` — the identity a fork shares with its source."""
    return (
        str(doc.get("mcp_server") or "").strip(),
        str(mcp_rpc_name_from_doc(doc) or "").strip(),
    )


def _batch_insert_tenant_id(tenant_id: str | None) -> str:
    """Canonical tenant id written on batch-created MCP docs."""
    return str(tenant_id or "__root__").strip() or "__root__"


def _batch_conflict_doc_for_tenant(doc: dict | None, insert_tenant: str) -> bool:
    """True when ``doc`` blocks create into ``insert_tenant``.

    Matches single-create resolve: ``__default__`` and ``__root__`` are the same
    ownership bucket, so a legacy ``__default__`` row conflicts with a root batch
    insert (no shadow dual-wire docs).
    """
    if not isinstance(doc, dict):
        return False
    if _doc_tenant_id_exact(doc) == SYSTEM_TENANT_ID:
        return True
    return _tenant_owns_doc(doc, _batch_insert_tenant_id(insert_tenant))


def _doc_tenant_id_exact(doc: dict | None) -> str:
    return str((doc or {}).get("tenant_id") or "__root__").strip() or "__root__"


async def _batch_find_wire_blocking_insert(storage, insert_tenant: str, wire: str) -> dict | None:
    """Wire occupancy for batch create, including ``__root__``/``__default__`` alias twins.

    Also checks ``__system__`` so phase-2 TOCTOU matches phase-1 listing (ADR-0013).
    Global wire finders stay tenant-scoped; ``__system__`` fallback lives in resolve.
    """
    wire = str(wire or "").strip()
    want = _batch_insert_tenant_id(insert_tenant)
    if not wire:
        return None
    finder = getattr(storage, "find_mcp_tool_configuration_by_wire_name", None)
    if not callable(finder):
        return None
    hit = await finder(want, wire)
    if hit is not None and _batch_conflict_doc_for_tenant(hit, want):
        return hit
    if want != SYSTEM_TENANT_ID:
        sys_hit = await finder(SYSTEM_TENANT_ID, wire)
        if sys_hit is not None and _doc_tenant_id_exact(sys_hit) == SYSTEM_TENANT_ID:
            return sys_hit
    return None


def _shared_wire_is_free_for_tenant(
    doc: dict,
    tenant_id: str,
    claimant_identity: tuple[str, str] | None,
) -> bool:
    """Whether a non-owned doc's wire may be claimed by *this* claimant.

    Scoped to the one claimant whose ``(mcp_server, rpc)`` identity equals the
    shared doc's — i.e. its own fork. Any other doc taking the name silently
    redirects it, because allow-list refs match by wire name alone (ADR-0013).
    """
    if claimant_identity is None or not all(claimant_identity):
        return False
    if _tenant_owns_doc(doc, tenant_id):
        return False
    return _mcp_doc_identity(doc) == claimant_identity


async def _collect_tenant_mcp_wire_names(
    storage,
    tenant_id: str,
    *,
    exclude_storage_id: str | None = None,
    claimant_identity: tuple[str, str] | None = None,
) -> set[str]:
    docs = await get_mcp_tool_configurations(
        storage, enabled_only=False, tenant_id=tenant_id,
    )
    names: set[str] = set()
    exclude = str(exclude_storage_id or "").strip()
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        if exclude and str(doc.get("_id") or "").strip() == exclude:
            continue
        # The fetch spans {tenant, __system__}. A shared doc's wire is taken here
        # unless the claimant IS its fork — that fork is the name's successor, and
        # renaming it to <wire>_2 would break the allow-list refs it holds.
        if _shared_wire_is_free_for_tenant(doc, tenant_id, claimant_identity):
            continue
        wire = str(doc.get("name") or "").strip()
        if not wire:
            from config.tool_configuration_schema import tool_wire_name_from_doc

            wire = tool_wire_name_from_doc(doc)
        if wire:
            names.add(wire)
    return names


def _finalize_mcp_doc_for_storage(doc: dict) -> None:
    """Path A: wire lives in ``name`` only; never persist ``llm_function_name``."""
    doc.pop("llm_function_name", None)


def _validate_mcp_wire_name_field(value: str) -> str:
    from tools.agent_allowed_tools import known_builtin_tool_ids
    from tools.mcp_llm_function_names import LlmFunctionNameError, validate_llm_function_name

    try:
        wire = validate_llm_function_name(value)
    except LlmFunctionNameError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # Dispatch resolves MCP docs before builtins, so this wire name would shadow
    # the builtin tenant-wide (AppFactory-268). The storage guard rejects it too,
    # but with a bare ValueError that has no handler and lands as a 500.
    if wire in known_builtin_tool_ids():
        raise HTTPException(
            status_code=400,
            detail=f"Reserved tool name '{wire}'; it is reserved by a builtin tool",
        )
    return wire


async def _ensure_mcp_wire_name_available(
    storage,
    tenant_id: str,
    wire_name: str,
    *,
    exclude_storage_id: str | None = None,
    claimant_identity: tuple[str, str] | None = None,
) -> None:
    wire = _validate_mcp_wire_name_field(wire_name)
    taken = await _collect_tenant_mcp_wire_names(
        storage,
        tenant_id,
        exclude_storage_id=exclude_storage_id,
        claimant_identity=claimant_identity,
    )
    if wire in taken:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "wire_name_conflict",
                "message": f"Tool wire name '{wire}' already exists in tenant '{tenant_id}'.",
            },
        )


async def _assign_mcp_wire_name(
    doc: dict,
    storage,
    *,
    preserve_existing: bool = True,
    exclude_storage_id: str | None = None,
    extra_existing_names: set[str] | None = None,
) -> None:
    from tools.mcp_llm_function_names import (
        LlmFunctionNameError,
        assign_llm_function_name_to_mcp_doc,
        resolve_server_abbrs,
    )

    tenant_id = str(doc.get("tenant_id") or "__root__")
    all_docs = await get_mcp_tool_configurations(
        storage, enabled_only=False, tenant_id=tenant_id,
    )
    exclude = str(exclude_storage_id or "").strip()
    # The candidate here IS ``doc``, so it claims under its own identity — which
    # may be the fork being minted, not yet in the DB.
    candidate_identity = _mcp_doc_identity(doc)
    existing_names: set[str] = set(extra_existing_names or ())
    server_ids: set[str] = set()
    for d in all_docs:
        if not isinstance(d, dict):
            continue
        if exclude and str(d.get("_id") or "").strip() == exclude:
            continue
        # The shared __system__ doc THIS candidate forks is the name's
        # predecessor, not a competitor — counting it would uniquify the fork to
        # <wire>_2 and break the allow-list refs it holds (ADR-0013). Every other
        # shared wire is taken. Server ids stay full-scope so abbrs stay global.
        if not _shared_wire_is_free_for_tenant(d, tenant_id, candidate_identity):
            wire = str(d.get("name") or "").strip()
            if not wire:
                from config.tool_configuration_schema import tool_wire_name_from_doc

                wire = tool_wire_name_from_doc(d)
            if wire:
                existing_names.add(wire)
        sid = str(d.get("mcp_server") or "").strip()
        if sid:
            server_ids.add(sid)
    server_id = str(doc.get("mcp_server") or "").strip()
    if server_id:
        server_ids.add(server_id)
    abbr_map = resolve_server_abbrs(server_ids)
    wire_before = str(doc.get("name") or "").strip()
    try:
        assign_llm_function_name_to_mcp_doc(
            doc,
            existing_names=existing_names,
            server_abbr_map=abbr_map,
            preserve_existing=preserve_existing,
        )
    except LlmFunctionNameError as exc:
        logger.warning(
            "[MCP_WIRE] tenant_id=%s mcp_server=%s assign_failed err=%s",
            tenant_id,
            doc.get("mcp_server"),
            exc,
        )
        raise HTTPException(
            status_code=400,
            detail={
                "code": "wire_name_invalid",
                "message": str(exc),
            },
        ) from exc
    wire_after = str(doc.get("name") or "").strip()
    _finalize_mcp_doc_for_storage(doc)
    if wire_after and wire_after != wire_before:
        logger.info(
            "[MCP_WIRE] tenant_id=%s mcp_server=%s rpc_name=%s wire_name=%s",
            tenant_id,
            doc.get("mcp_server"),
            doc.get("rpc_name"),
            wire_after,
        )


def _mask_secret_value(raw: object) -> str:
    """Mask a stored secret for responses (same policy as A2A ``_mask_token``)."""
    value = str(raw)
    return value[:4] + "***" + value[-4:] if len(value) > 8 else "***"


def _mask_external_mcp_auth(doc: dict) -> dict:
    """Return a copy of a tool doc with directly-stored MCP auth secrets masked (contract 5).

    Never mutates the stored/cached doc: copies each level it touches down to ``auth``. The
    ``*_env`` fields are variable NAMES, not secrets, and are left as-is. Field list is the
    same ``AUTH_SECRET_FIELDS`` A2A masks, so the two cannot drift apart.
    """
    meta = doc.get("metadata")
    if not isinstance(meta, dict):
        return doc
    rt = meta.get("external_mcp")
    if not isinstance(rt, dict):
        return doc
    auth = rt.get("auth")
    if not isinstance(auth, dict) or not any(auth.get(f) for f in AUTH_SECRET_FIELDS):
        return doc
    masked_auth = dict(auth)
    for f in AUTH_SECRET_FIELDS:
        if masked_auth.get(f):
            masked_auth[f] = _mask_secret_value(masked_auth[f])
    return {**doc, "metadata": {**meta, "external_mcp": {**rt, "auth": masked_auth}}}


def _auth_from_metadata(metadata: object) -> dict | None:
    """The ``external_mcp.auth`` block within a metadata dict, or None."""
    rt = metadata.get("external_mcp") if isinstance(metadata, dict) else None
    auth = rt.get("auth") if isinstance(rt, dict) else None
    return auth if isinstance(auth, dict) else None


def _external_mcp_timeout_from_metadata(metadata: object) -> float | None:
    """The ``external_mcp.timeout_seconds`` within a metadata dict as a float, or None."""
    rt = metadata.get("external_mcp") if isinstance(metadata, dict) else None
    raw = rt.get("timeout_seconds") if isinstance(rt, dict) else None
    if raw is None:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _validate_external_mcp_auth_or_400(metadata: object) -> None:
    """Reject an invalid ``metadata.external_mcp.auth`` at save time (contract 1).

    Catches the same misconfigurations the discover route does — a malformed auth block
    (e.g. oauth2 without token_url) or a secret ``*_env`` that isn't set — so a config that
    would fail mid-run is refused at save with a clear reason, not stored to fail later.
    """
    if not isinstance(metadata, dict):
        return
    rt = metadata.get("external_mcp")
    auth = rt.get("auth") if isinstance(rt, dict) else None
    if not auth:
        return
    try:
        auth_config = auth if isinstance(auth, A2AAuthConfig) else A2AAuthConfig(**auth)
        validate_auth_env_vars(auth_config)
    except (ValidationError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid external MCP auth: {exc}") from exc


async def _tenant_mcp_call_timeout_ceiling(storage, tenant_id: str) -> int:
    """The config OWNER tenant's external-MCP call-timeout ceiling (AppFactory-314).

    Reads ``mcp_call_timeout_max_seconds`` from the owner tenant's settings; a missing
    setting, a storage without settings, or any read error falls back to the default
    300 so tenants that never touched it behave exactly as before.
    """
    getter = getattr(storage, "get_tenant_settings", None)
    if getter is None:
        return DEFAULT_MCP_CALL_TIMEOUT_MAX_SECONDS
    try:
        settings = await getter(tenant_id)
    except Exception:
        return DEFAULT_MCP_CALL_TIMEOUT_MAX_SECONDS
    return resolve_mcp_call_timeout_ceiling(settings if isinstance(settings, dict) else None)


def _validate_external_mcp_timeout_or_400(metadata: object, ceiling: int) -> None:
    """Reject a stored MCP call timeout above the owner tenant's ceiling (contract 2).

    ``ceiling`` is the config OWNER tenant's ``mcp_call_timeout_max_seconds`` (default
    300 — not the calling tenant's, so shared ``__system__``/``__root__`` tools apply one
    rule regardless of who calls them). A value within the ceiling is stored verbatim —
    no silent truncation — so the call uses exactly the admin's chosen timeout; above it,
    the save is refused with a message naming the ceiling rather than quietly clamped.
    """
    value = _external_mcp_timeout_from_metadata(metadata)
    if value is None:
        return
    if value > float(ceiling):
        raise HTTPException(
            status_code=400,
            detail=(
                f"external MCP timeout_seconds {value:g} exceeds this tenant's ceiling "
                f"of {ceiling}s (mcp_call_timeout_max_seconds); raise the tenant ceiling "
                f"or lower the timeout"
            ),
        )


def _restore_masked_external_mcp_auth(incoming_metadata: object, existing_metadata: object) -> None:
    """Restore round-tripped masked auth secrets on update, in place on the incoming metadata.

    A GET masks direct secrets (``token``/``client_secret``/``refresh_token``) to ``abcd***wxyz``;
    a client that PUTs that masked value back means "keep the stored secret", not "set it to the
    literal mask". Swap each still-masked field for the real stored value. Same rule as the A2A
    update route; the ``*_env`` names are never masked, so never restored.
    """
    inc_rt = incoming_metadata.get("external_mcp") if isinstance(incoming_metadata, dict) else None
    inc_auth = inc_rt.get("auth") if isinstance(inc_rt, dict) else None
    if not isinstance(inc_auth, dict):
        return
    ex_rt = existing_metadata.get("external_mcp") if isinstance(existing_metadata, dict) else None
    ex_auth = ex_rt.get("auth") if isinstance(ex_rt, dict) else None
    ex_auth = ex_auth if isinstance(ex_auth, dict) else {}
    for f in AUTH_SECRET_FIELDS:
        v = inc_auth.get(f)
        if isinstance(v, str) and "***" in v:
            inc_auth[f] = ex_auth.get(f)


def _tool_doc_for_api_response(doc: dict) -> dict:
    """Normalize tool document for API (path A: wire ``name`` + ``rpc_name``)."""
    if not isinstance(doc, dict):
        return doc
    doc = _mask_external_mcp_auth(doc)  # copy-on-mask; the stored/cached doc is never mutated
    out = dict(doc)
    if out.get("source") == "mcp_server":
        from config.tool_configuration_schema import tool_wire_name_from_doc
        from tools.mcp_tool_ids import mcp_rpc_name_from_doc

        wire = tool_wire_name_from_doc(out)
        rpc = str(out.get("rpc_name") or "").strip() or mcp_rpc_name_from_doc(out)
        if wire:
            out["name"] = wire
            out["_id"] = wire
        if rpc:
            out["rpc_name"] = rpc
        out.pop("llm_function_name", None)
        return out
    public_id = mcp_public_tool_id_from_doc(out)
    if public_id:
        out["_id"] = public_id
    return out


async def _get_builtin_tool_doc_for_request(
    storage,
    ctx: TenantContext,
    tool_ref: str,
) -> dict | None:
    doc = await storage.get_tool_configuration(tool_ref)
    if not doc or doc.get("source") == "mcp_server":
        return None
    if not ctx.is_root and doc.get("tenant_id") not in (ctx.tenant_id, "__system__", None):
        return None
    if not ctx.is_root and str(doc.get("tenant_id") or "") == SYSTEM_TENANT_ID:
        doc = await resolve_tenant_config_for_read(
            doc,
            tenant_id=str(ctx.tenant_id),
            resolve_configuration=storage.resolve_tool_configuration,
        )
    return doc


async def _get_mcp_tool_doc_for_request(
    storage,
    ctx: TenantContext,
    tool_ref: str,
) -> dict | None:
    effective_tenant = ctx.tenant_id or "__root__"
    mcp_doc = await resolve_mcp_tool_doc(storage, effective_tenant, tool_ref)
    if mcp_doc is None:
        return None
    if ctx.is_root or mcp_doc.get("tenant_id") in (ctx.tenant_id, "__system__", None):
        return mcp_doc
    return None


async def _get_tool_doc_for_request(
    storage,
    ctx: TenantContext,
    tool_ref: str,
) -> dict | None:
    """Resolve builtin or MCP tool (legacy combined lookup)."""
    doc = await _get_mcp_tool_doc_for_request(storage, ctx, tool_ref)
    if doc is not None:
        return doc
    return await _get_builtin_tool_doc_for_request(storage, ctx, tool_ref)


async def _stop_mcp_server_runtime_if_no_tools_remain(
    storage,
    *,
    tenant_id: str,
    mcp_server_id: str,
    log_ref: str,
) -> None:
    """Tear down shared MCP runtime only when no tools remain on this server/tenant."""
    remaining = await count_mcp_tools_on_server(
        storage,
        tenant_id,
        mcp_server_id,
    )
    if remaining > 0:
        logger.info(
            "[CONFIG-API] [MCP_DELETE] %s — skip runtime cleanup tenant_id=%s "
            "mcp_server_id=%s remaining_tools=%d",
            log_ref,
            tenant_id,
            mcp_server_id,
            remaining,
        )
        return
    orchestrator = get_orchestrator()
    mcp_ex = getattr(orchestrator, "mcp_executor", None) if orchestrator is not None else None
    if mcp_ex is None or not hasattr(mcp_ex, "on_mcp_server_config_removed"):
        logger.info(
            "[CONFIG-API] [MCP_DELETE] %s — no mcp_executor, skip runtime cleanup",
            log_ref,
        )
        mcp_ex = None
    if mcp_ex is not None:
        try:
            await mcp_ex.on_mcp_server_config_removed(
                tenant_id=tenant_id,
                mcp_server_id=mcp_server_id,
            )
        except Exception as exc:
            logger.warning(
                "[CONFIG-API] [MCP_DELETE] %s runtime cleanup failed: %s",
                log_ref,
                exc,
            )
    cleanup_result = await cleanup_server_wizard_state(
        storage,
        tenant_id=tenant_id,
        server_id=mcp_server_id,
    )
    if cleanup_result.blocked:
        await mark_server_wizard_cleanup_pending(
            storage,
            tenant_id=tenant_id,
            server_id=mcp_server_id,
        )
        logger.warning(
            "[MCP_CLEANUP] %s deferred after tool deletion: package build is in flight",
            log_ref,
        )


def _require_valid_mcp_server_and_name(server_id: str, mcp_name: str) -> tuple[str, str]:
    try:
        return (
            validate_mcp_segment_id(server_id, "mcp_server"),
            validate_mcp_segment_id(mcp_name, "name"),
        )
    except McpSegmentIdError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _sanitize_mcp_tool_name(name: str) -> tuple[str, bool]:
    raw = str(name or "").strip()
    if not raw:
        return raw, False
    if _MCP_TOOL_NAME_SAFE.match(raw):
        return raw, False
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", raw)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return (cleaned or "tool"), True


def _sanitize_mcp_servers_tool_lists(mcp_servers: dict) -> tuple[dict, list[str]]:
    """Normalize tools/disabledTools names; drop invalid server keys with warnings."""
    warnings: list[str] = []
    if not isinstance(mcp_servers, dict):
        return {}, warnings
    out: dict = {}
    for sid_raw, entry in mcp_servers.items():
        sid = str(sid_raw or "").strip()
        if not sid:
            continue
        if not _MCP_SERVER_ID_SAFE.match(sid):
            warnings.append(
                f"Server key '{sid_raw}' is invalid (use letters, numbers, hyphen, underscore only) — skipped."
            )
            continue
        entry_copy = dict(entry) if isinstance(entry, dict) else {}
        for key in ("tools", "disabledTools"):
            if not isinstance(entry_copy.get(key), list):
                continue
            new_list: list[str] = []
            for item in entry_copy[key]:
                s = str(item or "").strip()
                if not s:
                    continue
                fixed, changed = _sanitize_mcp_tool_name(s)
                if changed:
                    warnings.append(
                        f"Tool name '{s}' in server '{sid}' ({key}) normalized to '{fixed}' "
                        "(only a-z, A-Z, 0-9, _, - allowed)."
                    )
                new_list.append(fixed)
            entry_copy[key] = new_list
        out[sid] = entry_copy
    return out, warnings


def _tools_selection_signature(entry: dict) -> str | None:
    if not isinstance(entry, dict):
        return None
    has_tools = isinstance(entry.get("tools"), list)
    has_disabled = isinstance(entry.get("disabledTools"), list)
    if not has_tools and not has_disabled:
        return None
    enabled = sorted(
        str(x).strip() for x in (entry.get("tools") or []) if str(x).strip()
    ) if has_tools else []
    disabled = sorted(
        str(x).strip() for x in (entry.get("disabledTools") or []) if str(x).strip()
    ) if has_disabled else []
    return json.dumps({"enabled": enabled, "disabled": disabled}, sort_keys=True)


def _compute_mcp_json_import_diff(old_servers: dict, new_servers: dict) -> dict:
    """Describe incremental work for a tenant mcp.json save."""
    old_keys = set(old_servers.keys()) if isinstance(old_servers, dict) else set()
    new_keys = set(new_servers.keys()) if isinstance(new_servers, dict) else set()
    added = sorted(new_keys - old_keys)
    removed = sorted(old_keys - new_keys)
    unchanged: list[str] = []
    tool_list_changed: list[str] = []
    for sid in sorted(old_keys & new_keys):
        new_entry = new_servers.get(sid) or {}
        new_sig = _tools_selection_signature(new_entry)
        if new_sig is None:
            # No tools/disabledTools in incoming JSON — no tool-list sync for this server.
            unchanged.append(sid)
            continue
        old_sig = _tools_selection_signature(old_servers.get(sid) or {})
        if old_sig == new_sig:
            unchanged.append(sid)
        else:
            tool_list_changed.append(sid)
    for sid in added:
        if _tools_selection_signature(new_servers.get(sid) or {}) is not None:
            if sid not in tool_list_changed:
                tool_list_changed.append(sid)
    return {
        "added_servers": added,
        "removed_servers": removed,
        "unchanged_servers": unchanged,
        "servers_tool_list_changed": sorted(tool_list_changed),
    }


def _split_mcp_tool_docs_by_ownership(
    docs: list, tenant_id: str,
) -> tuple[dict[str, list[dict]], set[str]]:
    """``(owned docs per server, server ids that exist only as shared docs)``.

    The listing spans {tenant, __system__}: "this server already has docs" is not
    the same question as "this tenant installed it", and mcp.json only ever
    describes the tenant's own installs (ADR-0013).
    """
    owned: dict[str, list[dict]] = {}
    shared: set[str] = set()
    for d in docs or []:
        if not isinstance(d, dict) or d.get("source") != "mcp_server":
            continue
        sid = str(d.get("mcp_server") or "").strip()
        if not sid:
            continue
        if _tenant_owns_doc(d, tenant_id):
            owned.setdefault(sid, []).append(d)
        else:
            shared.add(sid)
    return owned, shared - set(owned)


def _shared_server_import_warning(server_id: str) -> str:
    return (
        f"Server '{server_id}' is a shared platform server — not imported; "
        "fork it to get your tenant's own copy."
    )


_MCP_SERVER_DISCOVER_STATE_KEY = "mcp_server_discover_state"


def _cursor_entry_has_explicit_empty_tools(entry: dict) -> bool:
    tools = entry.get("tools") if isinstance(entry, dict) else None
    return isinstance(tools, list) and len(tools) == 0


def _load_mcp_server_discover_state(settings: dict) -> dict[str, dict]:
    raw = settings.get(_MCP_SERVER_DISCOVER_STATE_KEY) if isinstance(settings, dict) else None
    if not isinstance(raw, dict):
        return {}
    return {str(k): dict(v) for k, v in raw.items() if isinstance(v, dict)}


def _discover_state_blocks_catchup_reimport(state_entry: dict | None) -> bool:
    """Skip catch-up discover for terminal outcomes; retry transient failures."""
    if not isinstance(state_entry, dict):
        return False
    if state_entry.get("outcome") == "failed":
        return False
    return bool(state_entry.get("attempted_at") or state_entry.get("outcome"))


def _discover_state_should_preserve_in_sync(state_entry: dict | None) -> bool:
    """Keep server in synced cursor JSON when discover left zero tools in DB."""
    if not isinstance(state_entry, dict):
        return False
    return bool(state_entry.get("attempted_at") or state_entry.get("outcome"))


async def _resolve_cursor_json_servers_to_import(
    storage,
    tenant_id: str,
    new_servers: dict,
    import_diff: dict,
) -> tuple[list[str], list[str], dict[str, dict], list[str]]:
    """Pick servers that need discover on this save (not every zero-tool server every time)."""
    settings = await storage.get_tenant_settings(tenant_id) or {}
    discover_state = _load_mcp_server_discover_state(settings if isinstance(settings, dict) else {})
    for sid in list(discover_state.keys()):
        if sid not in (new_servers or {}):
            discover_state.pop(sid, None)

    docs = await get_mcp_tool_configurations(
        storage, enabled_only=False, tenant_id=tenant_id,
    )
    by_server, shared_only_servers = _split_mcp_tool_docs_by_ownership(docs, tenant_id)
    to_import: set[str] = set()
    catchup_missing: list[str] = []
    # Refused wholesale, in every diff bucket: importing a shared server as
    # tenant-owned would mint same-identity shadows and bypass the hand-mint
    # block — forking is the only sanctioned copy (ADR-0013).
    shared_refused = sorted(
        sid for sid in (new_servers or {}) if sid in shared_only_servers
    )

    for sid in import_diff.get("added_servers") or []:
        if sid not in new_servers:
            continue
        entry = new_servers.get(sid) or {}
        if _cursor_entry_has_explicit_empty_tools(entry):
            discover_state[sid] = {
                "outcome": "empty",
                "reason": "explicit_tools_empty",
            }
            continue
        if by_server.get(sid) or sid in shared_only_servers:
            continue
        to_import.add(sid)

    for sid in import_diff.get("unchanged_servers") or []:
        if sid not in new_servers:
            continue
        if by_server.get(sid) or sid in shared_only_servers:
            continue
        if _discover_state_blocks_catchup_reimport(discover_state.get(sid)):
            continue
        to_import.add(sid)
        catchup_missing.append(sid)

    return sorted(to_import), sorted(catchup_missing), discover_state, shared_refused


async def _persist_mcp_server_discover_state(
    storage,
    tenant_id: str,
    discover_state: dict[str, dict],
    *,
    actor_id: str | None,
) -> None:
    if not hasattr(storage, "get_tenant_settings") or not hasattr(storage, "save_tenant_settings"):
        return
    current = await storage.get_tenant_settings(tenant_id) or {"_id": tenant_id}
    if not isinstance(current, dict):
        current = {"_id": tenant_id}
    current[_MCP_SERVER_DISCOVER_STATE_KEY] = discover_state
    await storage.save_tenant_settings(current, actor_id=actor_id)


async def _load_mcp_servers_from_tenant_json_async(storage, tenant_id: str) -> dict:
    try:
        current = await storage.get_tenant_settings(tenant_id) or {}
        raw = current.get("mcp_cursor_json") if isinstance(current, dict) else None
        if not isinstance(raw, str) or not raw.strip():
            return {}
        parsed = json_loads_lenient(raw)
        servers = parsed.get("mcpServers") if isinstance(parsed, dict) else None
        return dict(servers) if isinstance(servers, dict) else {}
    except Exception as e:
        logger.warning(
            "[CONFIG-API] [CURSOR_JSON] could not parse previous tenant json tenant_id=%s: %s",
            tenant_id,
            e,
        )
        return {}


def _endpoint_host_label(endpoint: str) -> str:
    if not (endpoint or "").strip():
        return ""
    try:
        p = urlparse(endpoint.strip())
        if p.hostname:
            port = f":{p.port}" if p.port else ""
            return f"{p.hostname}{port}"
    except Exception:
        pass
    return "(invalid-url)"


def _is_transient_mcp_failure(exc: BaseException) -> bool:
    """True for errors where a short retry may help (remote HTTP MCP)."""
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return True
    if isinstance(
        exc,
        (
            httpx.ConnectError,
            httpx.ReadTimeout,
            httpx.WriteError,
            httpx.ConnectTimeout,
            httpx.PoolTimeout,
        ),
    ):
        return True
    if isinstance(exc, OSError):
        errno = getattr(exc, "errno", None)
        if errno in (10061, 111, 110, 101):  # refused, conn refused variants, network down
            return True
    msg = str(exc).lower()
    if any(x in msg for x in ("connection reset", "broken pipe", "temporarily unavailable")):
        return True
    return False


def _mcp_discover_dedupe_key(body: MCPServerDiscoverRequest) -> str:
    """Stable key so one physical server is probed once per health run."""
    payload = {
        "server_id": (body.server_id or "").strip(),
        "mode": (body.mode or "").strip().lower(),
        "endpoint": (body.endpoint or "").strip(),
        "image": (body.image or "").strip(),
        "command": (body.command or "").strip(),
        "args": tuple(body.command_args or ()),
        "docker_args": tuple(body.docker_cmd_args or ()),
    }
    return json.dumps(payload, sort_keys=True, ensure_ascii=False)


def _external_mcp_container_port(rt: dict) -> int | None:
    raw = rt.get("container_port")
    if isinstance(raw, int) and 1 <= raw <= 65535:
        return raw
    try:
        port = int(raw)
        if 1 <= port <= 65535:
            return port
    except (TypeError, ValueError):
        pass
    return None


def _external_mcp_endpoint_path(rt: dict) -> str | None:
    raw = rt.get("path") or rt.get("endpoint_path")
    if raw is None:
        return None
    path = str(raw).strip()
    return path or None


def _tool_doc_to_discover_request(
    doc: dict, *, ceiling: int = DEFAULT_MCP_CALL_TIMEOUT_MAX_SECONDS
) -> MCPServerDiscoverRequest | None:
    """Build discover request from a stored mcp_server tool row.

    ``ceiling`` is the config OWNER tenant's MCP call-timeout ceiling; the stored
    timeout is truncated to it for discovery/health (AppFactory-314 contract 4). Default
    300 preserves today's behavior for tenants without the setting.
    """
    if not isinstance(doc, dict) or doc.get("source") != "mcp_server":
        return None
    sid = str(doc.get("mcp_server") or "").strip()
    if not sid:
        return None
    meta = doc.get("metadata") if isinstance(doc.get("metadata"), dict) else {}
    rt = meta.get("external_mcp") if isinstance(meta.get("external_mcp"), dict) else {}
    endpoint = str(rt.get("endpoint") or "").strip()
    image = str(rt.get("image") or "").strip() or None
    command = str(rt.get("command") or "").strip() or None
    mode = str(rt.get("mode") or "http").strip().lower()
    container_port = _external_mcp_container_port(rt)
    endpoint_path = _external_mcp_endpoint_path(rt)
    try:
        timeout_seconds = float(rt.get("timeout_seconds") or 30.0)
    except (TypeError, ValueError):
        timeout_seconds = 30.0
    timeout_seconds = max(1.0, min(float(ceiling), timeout_seconds))
    if not endpoint and not image and not command:
        return None
    headers_map = runtime_headers_dict(rt)
    headers_pairs = (
        [MCPHeaderPair(name=k, value=v) for k, v in headers_map.items()] if headers_map else None
    )
    docker_env = rt.get("docker_env_vars") if isinstance(rt.get("docker_env_vars"), dict) else None
    docker_cmd_args = rt.get("docker_cmd_args") if isinstance(rt.get("docker_cmd_args"), list) else None
    cmd_args = rt.get("command_args") if isinstance(rt.get("command_args"), list) else None
    cmd_env = rt.get("command_env") if isinstance(rt.get("command_env"), dict) else None
    return MCPServerDiscoverRequest(
        server_id=sid,
        endpoint=endpoint,
        mode=mode,
        timeout_seconds=timeout_seconds,
        headers=headers_pairs,
        # Health/re-discovery reuse the stored auth block so they carry the same token as calls.
        auth=rt.get("auth") or None,
        image=image,
        docker_env_vars=docker_env,
        docker_cmd_args=[str(x) for x in docker_cmd_args] if docker_cmd_args else None,
        container_port=container_port,
        endpoint_path=endpoint_path,
        command=command,
        command_args=[str(x) for x in cmd_args] if cmd_args else None,
        command_env=cmd_env,
    )


async def _cleanup_mcp_discovery_resources(
    *,
    client,
    manager,
    discovery_project_id: str,
    tenant: str,
    server_id: str,
    disconnect_manager_client: bool = True,
) -> None:
    """Disconnect client / stop discovery container (best-effort).

    disconnect_manager_client: False when same-task already owns aclose (health
    background_cleanup) so stop_server is not blocked on hung disconnect.
    """
    try:
        if client is not None:
            await client.disconnect()
    except Exception:
        pass
    if manager is not None:
        try:
            await manager.stop_server(
                project_id=discovery_project_id,
                tenant_id=tenant,
                server_id=server_id,
                stop_reason="config",
                disconnect_client=disconnect_manager_client,
            )
            logger.info(
                "[EXTERNAL_MCP] [DISCOVERY] discovery container cleanup ok tenant=%s server=%s "
                "project_id=%s",
                tenant,
                server_id,
                discovery_project_id,
            )
        except Exception:
            logger.warning(
                "[EXTERNAL_MCP] [DISCOVERY] cleanup stop_server failed tenant=%s server=%s",
                tenant,
                server_id,
                exc_info=True,
            )


def _signal_mcp_discovery_result(
    result_ready: Optional[asyncio.Future],
    *,
    value: Any = None,
    error: Optional[BaseException] = None,
) -> None:
    """Publish probe outcome before teardown so wait_for need not await disconnect."""
    if result_ready is None or result_ready.done():
        return
    if error is not None:
        result_ready.set_exception(error)
    else:
        result_ready.set_result(value)


async def _execute_mcp_discovery_once(
    body: MCPServerDiscoverRequest,
    *,
    tenant: str,
    storage,
    runtime_out: dict | None = None,
    min_startup_timeout_s: float = 30.0,
    background_cleanup: bool = False,
    result_ready: Optional[asyncio.Future] = None,
    signal_failure: bool = True,
) -> list:
    """Run MCP list_tools once; returns raw dict rows. Cleans up client/manager in finally.

    min_startup_timeout_s: floor for local docker startup (discover keeps 30s; health-check
    passes 1.0 so body.timeout_seconds can be a short per-probe budget).
    background_cleanup: schedule docker stop/rm first, then same-task aclose (anyio).
    Health probes pass result_ready and wait on that future so per_server excludes teardown.
    signal_failure: False on non-final retries so transient errors do not complete the future.
    """
    is_remote_runtime = _is_remote_runtime_discovery(body)
    if is_remote_runtime:
        await _validate_discovery_endpoint_or_raise(body)
    resolved_image = (body.image or "").strip() or None
    is_local_runtime = not is_remote_runtime
    if is_local_runtime and not resolved_image and not (body.command or "").strip():
        resolved_image = await _resolve_discovery_default_image(storage)
    headers_dict = {h.name: h.value for h in body.headers} if body.headers else None
    discovery_request_id = uuid.uuid4().hex[:12]
    discovery_project_id = f"discovery-{tenant}-{discovery_request_id}"
    client = None
    manager = None
    discovered: list = []
    try:
        if is_local_runtime and (body.mode or "").strip().lower() in ("http", "streamable-http"):
            manager = get_external_mcp_manager()
            if manager is None:
                raise RuntimeError("External MCP manager is not initialized")
            if not resolved_image:
                raise RuntimeError("MCP discovery failed: image is required for local runtime")
            listen_port = int(body.container_port) if body.container_port else 8080
            ep_path = (body.endpoint_path or "").strip() or "/mcp"
            floor = max(1.0, float(min_startup_timeout_s))
            startup_timeout = int(max(floor, min(300.0, float(body.timeout_seconds))))
            await manager.ensure_server(
                project_id=discovery_project_id,
                server_id=body.server_id,
                tenant_id=tenant,
                image=resolved_image,
                container_port=listen_port,
                endpoint_path=ep_path,
                startup_timeout_seconds=startup_timeout,
                mode=(body.mode or "").strip().lower(),
                docker_env_vars=body.docker_env_vars,
                docker_cmd_args=body.docker_cmd_args,
            )
            if runtime_out is not None:
                rt_key = manager._key(discovery_project_id, tenant, body.server_id)
                runtime = manager._servers.get(rt_key)
                if runtime is not None and isinstance(runtime.host_port, int) and runtime.host_port > 0:
                    runtime_out["host_port"] = runtime.host_port
            discovered = await manager.discover_tools(
                project_id=discovery_project_id,
                tenant_id=tenant,
                server_id=body.server_id,
            )
        else:
            stdio_nm = (
                stdio_docker_container_name(discovery_project_id, body.server_id)
                if resolved_image
                else None
            )
            client = ExternalMCPClient(
                ExternalMCPConfig(
                    server_id=body.server_id,
                    endpoint=body.endpoint,
                    tenant_id=tenant,
                    timeout_seconds=body.timeout_seconds,
                    mode=body.mode,
                    headers=headers_dict,
                    # One shared provider per server so this probe reuses the token minted
                    # for calls (contract 2). None for stdio/no-auth; ignored by stdio.
                    auth=build_mcp_auth(body.auth, tenant_id=tenant, server_id=body.server_id),
                    image=resolved_image,
                    docker_env_vars=body.docker_env_vars,
                    docker_cmd_args=body.docker_cmd_args,
                    command=body.command,
                    args=body.command_args,
                    env=body.command_env,
                    stdio_docker_name=stdio_nm,
                )
            )
            discovered = await client.discover_tools()
        out = discovered if isinstance(discovered, list) else []
        # Before finally: probe wait_for(result_ready) must not include aclose/rm.
        _signal_mcp_discovery_result(result_ready, value=out)
        return out
    except asyncio.CancelledError:
        raise
    except Exception as e:
        if signal_failure:
            _signal_mcp_discovery_result(result_ready, error=e)
        raise
    finally:
        if background_cleanup:
            # Schedule rm/stop BEFORE await disconnect. shield(disconnect) would make a
            # hung aclose unreachable for cancel and never reach create_task.
            deferred_stdio_docker: Optional[str] = None
            if client is not None:
                deferred_stdio_docker = client.peek_stdio_docker_name()

            async def _background_discovery_cleanup() -> None:
                if deferred_stdio_docker:
                    try:
                        await stdio_docker_remove_force(
                            deferred_stdio_docker,
                            phase="health_background_cleanup",
                            log_tenant=tenant,
                            log_server=body.server_id,
                        )
                    except Exception:
                        logger.warning(
                            "[EXTERNAL_MCP] [DISCOVERY] deferred stdio docker rm failed "
                            "tenant=%s server=%s container=%s",
                            tenant,
                            body.server_id,
                            deferred_stdio_docker,
                            exc_info=True,
                        )
                await _cleanup_mcp_discovery_resources(
                    client=None,
                    manager=manager,
                    discovery_project_id=discovery_project_id,
                    tenant=tenant,
                    server_id=body.server_id,
                    disconnect_manager_client=False,
                )

            _schedule_health_cleanup(
                {
                    asyncio.create_task(
                        _background_discovery_cleanup(),
                        name="mcp-discovery-cleanup",
                    )
                }
            )

            # Same-task aclose (anyio). No shield: cancel may interrupt; rm already running.
            cancel_pending = False
            if client is not None:
                try:
                    await client.disconnect(remove_stdio_docker=False)
                except asyncio.CancelledError:
                    cancel_pending = True
                except Exception:
                    pass
                client = None
            if manager is not None:
                try:
                    await manager.disconnect_cached_client(
                        project_id=discovery_project_id,
                        tenant_id=tenant,
                        server_id=body.server_id,
                    )
                except asyncio.CancelledError:
                    cancel_pending = True
                except Exception:
                    pass
            if cancel_pending:
                raise asyncio.CancelledError()
        else:
            await _cleanup_mcp_discovery_resources(
                client=client,
                manager=manager,
                discovery_project_id=discovery_project_id,
                tenant=tenant,
                server_id=body.server_id,
            )


async def _execute_mcp_discovery_with_retries(
    body: MCPServerDiscoverRequest,
    *,
    tenant: str,
    storage,
    attempts: int = 3,
    min_startup_timeout_s: float = 30.0,
    background_cleanup: bool = False,
    result_ready: Optional[asyncio.Future] = None,
) -> list:
    """Remote MCP probes: retry transient network failures.

    With ``background_cleanup``, each attempt runs as its own task so a hung
    same-task disconnect cannot block the next attempt or leave ``result_ready``
    pending until ``per_server`` timeout.
    """
    delays = (0.5, 1.5)
    n_attempts = max(1, attempts)

    if not background_cleanup:
        for attempt in range(n_attempts):
            is_last = attempt >= n_attempts - 1
            try:
                return await _execute_mcp_discovery_once(
                    body,
                    tenant=tenant,
                    storage=storage,
                    min_startup_timeout_s=min_startup_timeout_s,
                    background_cleanup=False,
                    result_ready=result_ready,
                    signal_failure=is_last,
                )
            except Exception as e:
                is_remote = _is_remote_runtime_discovery(body)
                if (
                    attempt < n_attempts - 1
                    and is_remote
                    and _is_transient_mcp_failure(e)
                ):
                    wait_s = delays[min(attempt, len(delays) - 1)]
                    logger.warning(
                        "[EXTERNAL_MCP] [PROBE_RETRY] tenant=%s server=%s attempt=%d/%d wait_s=%s "
                        "exc_type=%s msg=%s",
                        tenant,
                        body.server_id,
                        attempt + 1,
                        n_attempts,
                        wait_s,
                        type(e).__name__,
                        str(e)[:400],
                    )
                    await asyncio.sleep(wait_s)
                    continue
                _signal_mcp_discovery_result(result_ready, error=e)
                raise
        raise AssertionError("unreachable mcp discovery retry loop")

    loop = asyncio.get_running_loop()
    for attempt in range(n_attempts):
        attempt_ready: asyncio.Future = loop.create_future()
        attempt_task = asyncio.create_task(
            _execute_mcp_discovery_once(
                body,
                tenant=tenant,
                storage=storage,
                min_startup_timeout_s=min_startup_timeout_s,
                background_cleanup=True,
                result_ready=attempt_ready,
                signal_failure=True,
            ),
            name=f"mcp-discovery-attempt-{attempt}",
        )

        def _fill_attempt(task: asyncio.Task, fut: asyncio.Future = attempt_ready) -> None:
            if fut.done():
                return
            if task.cancelled():
                fut.cancel()
                return
            exc = task.exception()
            if exc is not None:
                fut.set_exception(exc)
                return
            fut.set_result(task.result())

        attempt_task.add_done_callback(_fill_attempt)
        try:
            out = await attempt_ready
            _schedule_health_cleanup({attempt_task})
            _signal_mcp_discovery_result(result_ready, value=out)
            return out
        except asyncio.CancelledError:
            # Parent discovery_task.cancel() does not cancel create_task children.
            if not attempt_task.done():
                attempt_task.cancel()
            _schedule_health_cleanup({attempt_task})
            raise
        except Exception as e:
            _schedule_health_cleanup({attempt_task})
            is_remote = _is_remote_runtime_discovery(body)
            if (
                attempt < n_attempts - 1
                and is_remote
                and _is_transient_mcp_failure(e)
            ):
                wait_s = delays[min(attempt, len(delays) - 1)]
                logger.warning(
                    "[EXTERNAL_MCP] [PROBE_RETRY] tenant=%s server=%s attempt=%d/%d wait_s=%s "
                    "exc_type=%s msg=%s",
                    tenant,
                    body.server_id,
                    attempt + 1,
                    n_attempts,
                    wait_s,
                    type(e).__name__,
                    str(e)[:400],
                )
                await asyncio.sleep(wait_s)
                continue
            _signal_mcp_discovery_result(result_ready, error=e)
            raise
    raise AssertionError("unreachable mcp discovery retry loop")


router = APIRouter(
    prefix="/api/configurations/tools",
    tags=["configurations"],
)

mcp_router = APIRouter(
    prefix="/api/configurations/mcp-tools",
    tags=["mcp-tools"],
)


class TenantCursorJsonUpdate(BaseModel):
    cursor_json: str


# ---------------------------------------------------------------------------
# LIST
# ---------------------------------------------------------------------------

TOOL_LIST_UNASSIGNED_CATEGORY = "__unassigned__"


def _tool_list_wire_id(item: dict) -> str:
    return str(item.get("id") or item.get("_id") or "")


def _tool_list_search_blob(item: dict) -> str:
    # Stored category only — wire sentinel matched exactly in _tool_matches_list_query.
    parts: list[Any] = [
        item.get("id") or item.get("_id"),
        item.get("name"),
        item.get("description"),
        str(item.get("category") or "").strip(),
        item.get("version"),
    ]
    return " ".join(str(p or "") for p in parts).lower()


def _tool_matches_list_query(item: dict, q: str) -> bool:
    needle = q.strip().lower()
    if not needle:
        return True
    if needle in _tool_list_search_blob(item):
        return True
    # UI shows __unassigned__ for blank/missing; match full token only (not "g"/"ed").
    return (
        _tool_list_category_key(item) == TOOL_LIST_UNASSIGNED_CATEGORY
        and needle == TOOL_LIST_UNASSIGNED_CATEGORY
    )


def _tool_list_sort_key(item: dict) -> tuple:
    wire_id = _tool_list_wire_id(item)
    return ((item.get("name") or wire_id).lower(), wire_id)


def _tool_list_enabled(item: dict) -> bool:
    """Match ToolConfigurationResponse.enabled coercion for list filters."""
    return ToolConfigurationResponse.model_validate(item).enabled


def _tool_list_category_key(item: dict) -> str:
    """Wire category for list filter/group; empty stored value → synthetic bucket."""
    return str(item.get("category") or "").strip() or TOOL_LIST_UNASSIGNED_CATEGORY


def _group_tools_for_list(items: list[dict]) -> list[McpToolGroupResponse]:
    # ponytail: in-memory groupby; upgrade path — aggregate in Mongo when catalog grows
    buckets: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        buckets[_tool_list_category_key(item)].append(item)
    groups: list[McpToolGroupResponse] = []
    for category in sorted(buckets.keys(), key=str.lower):
        tools = sorted(buckets[category], key=_tool_list_sort_key)
        groups.append(
            McpToolGroupResponse(
                id=category,
                label=category,
                tools_count=len(tools),
                tools=[ToolConfigurationResponse.model_validate(t) for t in tools],
            )
        )
    return groups


@router.get(
    "/",
    response_model=Union[List[McpToolGroupResponse], List[ToolConfigurationResponse]],
)
async def list_tool_configurations(
    enabled_only: bool = False,
    enabled: Optional[bool] = Query(None),
    category: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    grouped: bool = False,
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Return tool configurations scoped to caller's tenant + __system__.

    Flat list by default; ``grouped=true`` returns groups by ``category``.
    """
    if enabled is False and enabled_only:
        raise HTTPException(
            status_code=400,
            detail="enabled=false requires enabled_only=false",
        )
    storage = _storage_or_fail()
    tid = None if ctx.is_root else ctx.tenant_id
    configs = await storage.get_tool_configurations(enabled_only=enabled_only, tenant_id=tid)
    items = [_tool_doc_for_api_response(d) for d in configs if isinstance(d, dict)]
    if enabled is not None:
        items = [item for item in items if _tool_list_enabled(item) == enabled]
    if category:
        category_key = category.strip()
        items = [item for item in items if _tool_list_category_key(item) == category_key]
    if q:
        items = [item for item in items if _tool_matches_list_query(item, q)]
    if grouped:
        return _group_tools_for_list(items)
    return [ToolConfigurationResponse.model_validate(item) for item in items]


@router.get("/categories", response_model=ToolCategoriesResponse)
@router.get("/categories/", response_model=ToolCategoriesResponse, include_in_schema=False)
async def list_tool_categories(ctx: TenantContext = Depends(get_tenant_context)):
    """Return sorted distinct builtin tool categories visible to the caller.

    Spec path: GET /api/configurations/tools/categories/.
    Static segment is registered before /{tool_id}; id ``categories`` is shadowed.
    """
    storage = _storage_or_fail()
    tid = None if ctx.is_root else ctx.tenant_id
    raw = await storage.get_tool_configuration_category_values(tenant_id=tid)
    keys: set[str] = set()
    for value in raw:
        keys.add(_tool_list_category_key({"category": value}))
    logger.info(
        "[CONFIG-API] Listed tool categories count=%s tenant=%s",
        len(keys),
        ctx.tenant_id,
    )
    return ToolCategoriesResponse(items=sorted(keys, key=str.lower))


# ---------------------------------------------------------------------------
# GET ONE
# ---------------------------------------------------------------------------

@router.get("/{tool_id}", response_model=ToolConfigurationResponse)
async def get_tool_configuration(tool_id: str, ctx: TenantContext = Depends(get_tenant_context)):
    """Return a single builtin tool configuration by ID."""
    storage = _storage_or_fail()
    doc = await _get_tool_doc_for_request(storage, ctx, tool_id)
    if not doc:
        raise HTTPException(status_code=404, detail=f"Tool '{tool_id}' not found")
    return _tool_doc_for_api_response(doc)


# ---------------------------------------------------------------------------
# CREATE
# ---------------------------------------------------------------------------

@router.post("/", response_model=ToolConfigurationResponse, status_code=201)
async def create_tool_configuration(
    body: ToolConfigurationCreate, ctx: TenantContext = Depends(get_tenant_context),
):
    """Create a new builtin tool configuration stamped with caller's tenant_id."""
    storage = _storage_or_fail()
    effective_tenant = ctx.tenant_id or "__root__"

    if body.source == "mcp_server":
        return await create_mcp_tool_configuration(body, ctx)

    storage_id = body.id

    existing_by_id = await storage.get_tool_configuration(storage_id)
    if existing_by_id:
        raise HTTPException(status_code=409, detail=f"Tool '{storage_id}' already exists")

    name_conflicts = await find_tools_by_name(
        storage, body.name, effective_tenant, mcp=False,
    )
    if name_conflicts:
        suggestion = _suggest_tool_name(body.name, effective_tenant)
        raise HTTPException(
            status_code=409,
            detail={
                "code": "name_conflict",
                "message": (
                    f"A tool named '{body.name}' already exists in tenant '{effective_tenant}'. "
                    "Tool names must be unique within a tenant."
                ),
                "existing_id": name_conflicts[0].get("_id"),
                "suggested_name": suggestion,
            },
        )

    doc = {"_id": storage_id, **body.model_dump(exclude={"id"}, exclude_none=True)}
    sync_entity_descriptions_for_save(doc)
    _normalize_tool_doc_for_storage(doc)
    # Always stamp with the caller's tenant — non-root cannot inject a foreign tenant_id.
    if not ctx.is_root:
        doc["tenant_id"] = effective_tenant
    else:
        doc.setdefault("tenant_id", effective_tenant)
    saved_id = await storage.save_tool_configuration(doc, actor_id=ctx.user_id)
    persisted = await storage.get_tool_configuration(saved_id)
    if not persisted:
        persisted = {**doc, "_id": saved_id}

    await _reload_tool_registry()

    logger.info("[CONFIG-API] Created tool '%s' (tenant=%s)", saved_id, ctx.tenant_id)
    return _tool_doc_for_api_response(persisted)


# ---------------------------------------------------------------------------
# UPDATE (partial)
# ---------------------------------------------------------------------------

@router.put("/{tool_id}", response_model=ToolConfigurationResponse)
async def update_tool_configuration(
    tool_id: str, body: ToolConfigurationUpdate, ctx: TenantContext = Depends(get_tenant_context),
):
    """Update an existing tool configuration (partial merge)."""
    storage = _storage_or_fail()

    existing = await _get_tool_doc_for_request(storage, ctx, tool_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"Tool '{tool_id}' not found")

    if not ctx.is_root and existing.get("tenant_id") not in (ctx.tenant_id, SYSTEM_TENANT_ID, None):
        raise HTTPException(status_code=403, detail="Cannot modify config from another tenant")

    updates = body.model_dump(exclude_unset=True, exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    new_source = updates.get("source")
    if new_source is not None and new_source != existing.get("source"):
        raise HTTPException(
            status_code=400,
            detail="Changing tool source via PUT is not allowed",
        )

    if existing.get("source") == "mcp_server":
        return await update_mcp_tool_configuration(tool_id, body, ctx)

    if "name" in updates:
        from schemas.configuration_schemas import _validate_wire_tool_name

        try:
            updates["name"] = _validate_wire_tool_name(str(updates["name"]))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        if ctx.is_root or existing.get("tenant_id") in (ctx.tenant_id, None):
            merged = {**existing, **updates}
            target_id = tool_id
        else:
            merged, target_id = await prepare_configuration_cow_update(
                existing,
                tenant_id=str(ctx.tenant_id),
                updates=updates,
                resolve_configuration=storage.resolve_tool_configuration,
                get_configuration=storage.get_tool_configuration,
                find_by_name=storage.find_tool_configuration_by_name,
            )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if ENTITY_DESCRIPTION_FIELDS & updates.keys():
        sync_entity_descriptions_for_save(
            merged,
            touched=ENTITY_DESCRIPTION_FIELDS & frozenset(updates.keys()),
            prior=existing,
        )

    _normalize_tool_doc_for_storage(merged)
    saved_id = await storage.save_tool_configuration(merged, actor_id=ctx.user_id)
    persisted = await storage.get_tool_configuration(saved_id)
    if not persisted:
        persisted = {**merged, "_id": saved_id}

    await _reload_tool_registry()

    logger.info("[CONFIG-API] Updated tool '%s' fields=%s", saved_id, list(updates.keys()))
    return _tool_doc_for_api_response(persisted)


# ---------------------------------------------------------------------------
# DELETE
# ---------------------------------------------------------------------------

@router.delete("/{tool_id}", status_code=204)
async def delete_tool_configuration(tool_id: str, ctx: TenantContext = Depends(get_tenant_context)):
    """Delete a builtin tool configuration."""
    storage = _storage_or_fail()

    existing = await _get_tool_doc_for_request(storage, ctx, tool_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"Tool '{tool_id}' not found")
    if not ctx.is_root and existing.get("tenant_id") not in (ctx.tenant_id, None):
        raise HTTPException(status_code=403, detail="Cannot delete config from another tenant")

    if existing.get("source") == "mcp_server":
        return await delete_mcp_tool_configuration_route(tool_id, ctx)

    mcp_server_id = existing.get("mcp_server")
    source = existing.get("source")
    tenant_for_mcp = existing.get("tenant_id") or ctx.tenant_id or "__root__"
    storage_id = str(existing.get("_id") or tool_id)

    await delete_tool_document(storage, existing)
    await _reload_tool_registry()
    if source == "mcp_server" and mcp_server_id:
        await _sync_tenant_cursor_json_from_tools(
            storage=storage,
            tenant_id=tenant_for_mcp,
            actor_id=ctx.user_id,
        )
        logger.info(
            "[CONFIG-API] [MCP_DELETE] tool_id=%s tenant_id=%s mcp_server_id=%s — "
            "stopping local runtimes",
            tool_id,
            tenant_for_mcp,
            mcp_server_id,
        )
        orchestrator = get_orchestrator()
        mcp_ex = (
            getattr(orchestrator, "mcp_executor", None) if orchestrator is not None else None
        )
        if mcp_ex is not None and hasattr(mcp_ex, "on_mcp_server_config_removed"):
            try:
                await mcp_ex.on_mcp_server_config_removed(
                    tenant_id=tenant_for_mcp,
                    mcp_server_id=mcp_server_id,
                )
            except Exception as e:
                logger.warning(
                    "[CONFIG-API] MCP runtime cleanup on delete failed tool=%s: %s", tool_id, e
                )
        else:
            logger.info(
                "[CONFIG-API] [MCP_DELETE] tool_id=%s — no mcp_executor or on_mcp_server_config_removed, "
                "skip runtime cleanup",
                tool_id,
            )
    logger.info("[CONFIG-API] Deleted tool '%s'", tool_id)


# ---------------------------------------------------------------------------
# MCP DISCOVERY
# ---------------------------------------------------------------------------


@router.get("/mcp-servers/cursor-json")
async def get_tenant_cursor_json(
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Get tenant-level Cursor mcp.json text (always synced from tools in DB)."""
    storage = _storage_or_fail()
    tenant_id = ctx.tenant_id or "__root__"
    await _sync_tenant_cursor_json_from_tools(
        storage=storage,
        tenant_id=tenant_id,
        actor_id=ctx.user_id,
    )
    raw = "{\n  \"mcpServers\": {}\n}"
    if hasattr(storage, "get_tenant_settings"):
        try:
            doc = await storage.get_tenant_settings(tenant_id)
            if isinstance(doc, dict):
                v = doc.get("mcp_cursor_json")
                if isinstance(v, str) and v.strip():
                    raw = v
        except Exception as e:
            logger.warning(
                "[CONFIG-API] [CURSOR_JSON] get failed tenant_id=%s: %s", tenant_id, e
            )
    return {"tenant_id": tenant_id, "cursor_json": raw}


@router.get("/mcp-servers/cursor-json-http")
async def get_tenant_cursor_json_http_only(
    ctx: TenantContext = Depends(get_tenant_context_for_cursor_json_http_export),
):
    """Return Cursor mcp.json with only remote HTTP / streamable-http servers (url + transport)."""
    storage = _storage_or_fail()
    tenant_id = ctx.tenant_id or "__root__"
    await _sync_tenant_cursor_json_from_tools(
        storage=storage,
        tenant_id=tenant_id,
        actor_id=ctx.user_id,
    )
    mcp_servers: dict[str, dict] = {}
    if hasattr(storage, "get_tenant_settings"):
        try:
            doc = await storage.get_tenant_settings(tenant_id)
            raw = doc.get("mcp_cursor_json") if isinstance(doc, dict) else None
            if isinstance(raw, str) and raw.strip():
                parsed = json_loads_lenient(raw)
                if isinstance(parsed, dict):
                    mcp_servers = _filter_cursor_json_http_servers(
                        parsed.get("mcpServers") or {}
                    )
        except Exception as e:
            logger.warning(
                "[CONFIG-API] [CURSOR_JSON_HTTP] parse failed tenant_id=%s: %s",
                tenant_id,
                e,
            )
    if not mcp_servers:
        mcp_servers = await _build_cursor_http_servers_from_tools(storage, tenant_id)
    logger.info(
        "[CONFIG-API] [CURSOR_JSON_HTTP] tenant_id=%s servers=%d",
        tenant_id,
        len(mcp_servers),
    )
    return {"mcpServers": mcp_servers}


@router.put("/mcp-servers/cursor-json")
async def save_tenant_cursor_json(
    body: TenantCursorJsonUpdate,
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Import servers from tenant Cursor mcp.json into DB and return synced snapshot."""
    storage = _storage_or_fail()
    tenant_id = ctx.tenant_id or "__root__"
    text = (body.cursor_json or "").strip()
    parsed = None
    if text:
        try:
            parsed = json_loads_lenient(text)
            if not isinstance(parsed, dict) or not isinstance(parsed.get("mcpServers"), dict):
                raise ValueError("Ожидается JSON-объект с ключом mcpServers")
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid Cursor JSON: {e}")
    else:
        # Пустая форма: сброс к { "mcpServers": {} } — удаляем все MCP server tools из БД
        await _apply_removed_servers_from_cursor_json(
            storage=storage,
            tenant_id=tenant_id,
            actor_id=ctx.user_id,
            mcp_servers={},
        )
        await _persist_mcp_server_discover_state(
            storage, tenant_id, {}, actor_id=ctx.user_id,
        )
    import_diff: dict = {}
    save_warnings: list[str] = []
    preserve_servers_sync: dict = {}

    if isinstance(parsed, dict):
        raw_servers = parsed.get("mcpServers") or {}
        if not isinstance(raw_servers, dict):
            raw_servers = {}
        old_servers = await _load_mcp_servers_from_tenant_json_async(storage, tenant_id)
        new_servers, save_warnings = _sanitize_mcp_servers_tool_lists(raw_servers)
        preserve_servers_sync = new_servers
        import_diff = _compute_mcp_json_import_diff(old_servers, new_servers)

        await _apply_removed_servers_from_cursor_json(
            storage=storage,
            tenant_id=tenant_id,
            actor_id=ctx.user_id,
            mcp_servers=new_servers,
        )

        servers_to_import_ids, catchup_missing, discover_state, shared_refused = (
            await _resolve_cursor_json_servers_to_import(
                storage, tenant_id, new_servers, import_diff,
            )
        )
        import_diff["servers_missing_tools"] = catchup_missing
        if shared_refused:
            refused = set(shared_refused)
            import_diff["skipped_shared_servers"] = shared_refused
            for key in ("added_servers", "servers_tool_list_changed"):
                import_diff[key] = [
                    sid for sid in import_diff.get(key) or [] if sid not in refused
                ]
            save_warnings.extend(
                _shared_server_import_warning(sid) for sid in shared_refused
            )
        servers_to_import = {
            sid: new_servers[sid]
            for sid in servers_to_import_ids
            if sid in new_servers
        }
        if servers_to_import:
            logger.info(
                "[CONFIG-API] [CURSOR_JSON] incremental import tenant_id=%s servers=%s",
                tenant_id,
                servers_to_import_ids,
            )
            await _import_servers_and_tools_from_cursor_json(
                storage=storage,
                tenant_id=tenant_id,
                actor_id=ctx.user_id,
                mcp_servers=servers_to_import,
                warnings=save_warnings,
                discover_state=discover_state,
            )

        servers_tool_apply = {
            sid: new_servers[sid]
            for sid in import_diff.get("servers_tool_list_changed") or []
            if sid in new_servers
        }
        if servers_tool_apply:
            await _apply_explicit_tool_selection_from_cursor_json(
                storage=storage,
                tenant_id=tenant_id,
                actor_id=ctx.user_id,
                mcp_servers=servers_tool_apply,
            )
            from datetime import datetime, timezone

            marked_at = datetime.now(timezone.utc).isoformat()
            for sid in servers_tool_apply:
                entry = new_servers.get(sid) or {}
                if _cursor_entry_has_explicit_empty_tools(entry):
                    discover_state[sid] = {
                        "attempted_at": marked_at,
                        "outcome": "empty",
                        "reason": "explicit_tools_empty",
                    }

        await _persist_mcp_server_discover_state(
            storage, tenant_id, discover_state, actor_id=ctx.user_id,
        )

        skipped_n = len(import_diff.get("unchanged_servers") or [])
        if skipped_n:
            logger.info(
                "[CONFIG-API] [CURSOR_JSON] skipped unchanged servers tenant_id=%s count=%d",
                tenant_id,
                skipped_n,
            )

    await _sync_tenant_cursor_json_from_tools(
        storage=storage,
        tenant_id=tenant_id,
        actor_id=ctx.user_id,
        preserve_servers=preserve_servers_sync,
    )
    await _reload_tool_registry()
    current = await storage.get_tenant_settings(tenant_id) or {"_id": tenant_id}
    raw = "{\n  \"mcpServers\": {}\n}"
    if isinstance(current, dict):
        v = current.get("mcp_cursor_json")
        if isinstance(v, str) and v.strip():
            raw = v
    logger.info(
        "[CONFIG-API] [CURSOR_JSON] save -> synced from tools tenant_id=%s diff=%s warnings=%d",
        tenant_id,
        import_diff,
        len(save_warnings),
    )
    return {
        "tenant_id": tenant_id,
        "cursor_json": raw,
        "import_diff": import_diff,
        "warnings": save_warnings,
    }


@router.post("/mcp-servers/discover", response_model=MCPServerDiscoverResponse)
async def discover_mcp_server_tools(
    body: MCPServerDiscoverRequest,
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Discover tools from an external MCP server endpoint."""
    try:
        validate_mcp_segment_id(str(body.server_id or "").strip(), "server_id")
    except McpSegmentIdError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # Contract 1: a named secret env var that isn't set on the backend is a config error —
    # reject it here, not 5 minutes later at first token fetch. (Field-shape errors like
    # oauth2-without-token_url are already rejected by Pydantic as 422 on request parse.)
    if body.auth is not None:
        try:
            validate_auth_env_vars(body.auth)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    logger.info(
        "[EXTERNAL_MCP] discovery start tenant=%s server=%s mode=%s endpoint=%s image=%s command=%s",
        ctx.tenant_id,
        body.server_id,
        body.mode,
        bool((body.endpoint or "").strip()),
        bool((body.image or "").strip()),
        bool((body.command or "").strip()),
    )
    storage = _storage_or_fail()
    tenant = ctx.tenant_id or "__root__"
    # Discovery honors the same tenant ceiling as health/re-discovery (contract 4): a
    # request timeout above the calling tenant's ceiling is truncated to it, not
    # rejected. The schema no longer caps timeout at 300, so this is the bound now.
    discover_ceiling = await _tenant_mcp_call_timeout_ceiling(storage, tenant)
    if float(body.timeout_seconds) > float(discover_ceiling):
        body = body.model_copy(update={"timeout_seconds": float(discover_ceiling)})
    is_remote_runtime = _is_remote_runtime_discovery(body)
    resolved_preview = (body.image or "").strip() or None
    if not is_remote_runtime and not resolved_preview and not (body.command or "").strip():
        resolved_preview = await _resolve_discovery_default_image(storage)
    logger.info(
        "[EXTERNAL_MCP] discovery resolved runtime server=%s mode=%s runtime=%s resolved_image=%s",
        body.server_id,
        body.mode,
        "remote-direct" if is_remote_runtime else "local-in-docker",
        resolved_preview or "",
    )
    try:
        discovered = await _execute_mcp_discovery_once(body, tenant=tenant, storage=storage)
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(
            "[EXTERNAL_MCP] tenant=%s server=%s discovery failed mode=%s endpoint=%s error=%s",
            ctx.tenant_id,
            body.server_id,
            body.mode,
            body.endpoint,
            e,
        )
        detail = _mcp_discovery_failure_detail(
            e,
            network_discovery=_is_network_mode_discovery(body),
        )
        raise HTTPException(status_code=400, detail=detail) from e

    tools = []
    for item in discovered:
        if not isinstance(item, dict):
            continue
        tools.append(
            MCPDiscoveredTool(
                name=item.get("name", ""),
                description=item.get("description", "") or "",
                schema=item.get("schema"),
                mcp_server=body.server_id,
            )
        )

    logger.info(
        "[CONFIG-API] Discovered %d tools from external MCP server '%s' (tenant=%s)",
        len(tools),
        body.server_id,
        ctx.tenant_id,
    )
    return MCPServerDiscoverResponse(
        server_id=body.server_id,
        endpoint=body.endpoint,
        mode=body.mode,
        tools=tools,
    )


# Batch health-check bounds (keep under typical reverse-proxy timeouts).
# Remote HTTP can fail fast; local docker needs cold-start room (rm/run/warmup/handshake).
def _health_env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        return float(raw)
    except ValueError:
        return default


HEALTH_CHECK_WALL_CLOCK_S = _health_env_float("HEALTH_CHECK_WALL_CLOCK_S", 35.0)
HEALTH_CHECK_PER_SERVER_S = _health_env_float("HEALTH_CHECK_PER_SERVER_S", 6.0)
HEALTH_CHECK_PER_SERVER_LOCAL_S = _health_env_float("HEALTH_CHECK_PER_SERVER_LOCAL_S", 30.0)
# Local docker: one attempt (cold start already eats the budget).
# Remote HTTP: one retry for transient RST/TCP blips within the short remote window.
HEALTH_CHECK_MAX_ATTEMPTS = 1
HEALTH_CHECK_MAX_ATTEMPTS_REMOTE = 2
HEALTH_CHECK_CONCURRENCY = 6


def _health_check_per_server_budget_s(
    body: MCPServerDiscoverRequest, remaining: float
) -> tuple[float, bool]:
    """Return (wait_for budget, wall_limited).

    wall_limited: remaining (not user timeout / remote-local cap) is the binding constraint.
    """
    user_cap = float(body.timeout_seconds or 30.0)
    cap = (
        HEALTH_CHECK_PER_SERVER_S
        if _is_remote_runtime_discovery(body)
        else HEALTH_CHECK_PER_SERVER_LOCAL_S
    )
    desired = min(float(cap), user_cap)
    wall_limited = float(remaining) + 1e-9 < desired
    return max(1.0, min(desired, float(remaining))), wall_limited


def _health_probe_budget_label(
    body: MCPServerDiscoverRequest, per_server: float, *, wall_limited: bool = False
) -> str:
    """Human label for probe timeout; notes when batch clamps user timeout_seconds."""
    user_cap = float(body.timeout_seconds or 30.0)
    if wall_limited:
        return f"{per_server:.0f}s (wall budget)"
    if user_cap > per_server + 0.05:
        return f"{per_server:.0f}s (clamped from timeout_seconds={user_cap:.0f})"
    return f"{per_server:.0f}s"


def _mcp_health_host_label(body: MCPServerDiscoverRequest) -> str:
    host_label = _endpoint_host_label(body.endpoint) if (body.endpoint or "").strip() else ""
    if host_label:
        return host_label
    if (body.image or "").strip():
        return "stdio:docker-image"
    if (body.command or "").strip():
        return "stdio:command"
    return "(no-endpoint)"


def _mcp_health_item(
    body: MCPServerDiscoverRequest | None,
    *,
    server_id: str | None = None,
    status: str,
    message: str = "",
    host_label: str = "",
    mode: str = "",
    tools_count: int | None = None,
    duration_ms: float | None = None,
) -> MCPServerHealthItem:
    """Build health row with runtime_key aligned to discovery dedupe."""
    sid = (server_id if server_id is not None else (body.server_id if body else "")) or ""
    if body is not None:
        return MCPServerHealthItem(
            server_id=sid,
            status=status,
            mode=(mode or body.mode or ""),
            endpoint_host=host_label or _mcp_health_host_label(body),
            runtime_key=_mcp_discover_dedupe_key(body),
            tools_count=tools_count,
            message=message,
            duration_ms=duration_ms,
        )
    return MCPServerHealthItem(
        server_id=sid,
        status=status,
        mode=mode or "",
        endpoint_host=host_label,
        runtime_key=json.dumps({"server_id": sid}, sort_keys=True, ensure_ascii=False),
        tools_count=tools_count,
        message=message,
        duration_ms=duration_ms,
    )


def _mcp_health_skipped_item(
    body: MCPServerDiscoverRequest,
    *,
    host_label: str,
    message: str,
    duration_ms: float,
) -> MCPServerHealthItem:
    return _mcp_health_item(
        body,
        status="skipped",
        host_label=host_label,
        message=message,
        duration_ms=duration_ms,
    )


async def _probe_one_mcp_health(
    body: MCPServerDiscoverRequest,
    *,
    tenant: str,
    storage,
    sem: asyncio.Semaphore,
    deadline: float,
) -> MCPServerHealthItem:
    """Probe one MCP server under batch wall-clock / concurrency limits."""
    host_label = _mcp_health_host_label(body)
    t0 = time.perf_counter()
    async with sem:
        remaining = deadline - time.monotonic()
        # Floor per_server at 1.0 for ensure_server int(timeout); if less wall left, skip.
        if remaining < 1.0:
            return _mcp_health_skipped_item(
                body,
                host_label=host_label,
                message="budget exceeded",
                duration_ms=round((time.perf_counter() - t0) * 1000, 2),
            )
        per_server, wall_limited = _health_check_per_server_budget_s(body, remaining)
        is_remote = _is_remote_runtime_discovery(body)
        # Local cold start needs meaningful room; do not start a doomed probe as error.
        if (
            not is_remote
            and wall_limited
            and remaining < min(10.0, HEALTH_CHECK_PER_SERVER_LOCAL_S / 3.0)
        ):
            return _mcp_health_skipped_item(
                body,
                host_label=host_label,
                message="budget exceeded",
                duration_ms=round((time.perf_counter() - t0) * 1000, 2),
            )
        budget_label = _health_probe_budget_label(
            body, per_server, wall_limited=wall_limited
        )
        probe_body = body.model_copy(update={"timeout_seconds": per_server})
        try:
            if is_remote:
                try:
                    await _validate_discovery_endpoint_or_raise(probe_body)
                except HTTPException as pol_e:
                    logger.warning(
                        "[EXTERNAL_MCP] [HEALTH] tenant=%s server=%s status=policy_blocked host=%s detail=%s",
                        tenant,
                        probe_body.server_id,
                        host_label,
                        str(pol_e.detail)[:300],
                    )
                    return _mcp_health_item(
                        probe_body,
                        status="policy_blocked",
                        host_label=host_label,
                        message=str(pol_e.detail)[:500],
                        duration_ms=round((time.perf_counter() - t0) * 1000, 2),
                    )

            # Local docker: keep discover floor so startup_timeout tracks probe budget.
            # Remote path ignores min_startup. Wait on result_ready (list_tools done),
            # not the full discovery task — same-task aclose runs after signal.
            min_startup = (
                1.0 if is_remote else max(1.0, min(30.0, per_server))
            )
            attempts = (
                HEALTH_CHECK_MAX_ATTEMPTS_REMOTE if is_remote else HEALTH_CHECK_MAX_ATTEMPTS
            )
            result_ready: asyncio.Future = asyncio.get_running_loop().create_future()
            discovery_task = asyncio.create_task(
                _execute_mcp_discovery_with_retries(
                    probe_body,
                    tenant=tenant,
                    storage=storage,
                    attempts=attempts,
                    min_startup_timeout_s=min_startup,
                    background_cleanup=True,
                    result_ready=result_ready,
                )
            )

            def _fill_result_ready_if_needed(task: asyncio.Task) -> None:
                # Production signals before finally; test mocks of with_retries may not.
                if result_ready.done():
                    return
                if task.cancelled():
                    result_ready.cancel()
                    return
                exc = task.exception()
                if exc is not None:
                    result_ready.set_exception(exc)
                    return
                result_ready.set_result(task.result())

            discovery_task.add_done_callback(_fill_result_ready_if_needed)
            try:
                try:
                    discovered = await asyncio.wait_for(
                        asyncio.shield(result_ready),
                        timeout=per_server,
                    )
                except asyncio.TimeoutError:
                    # shield keeps the future; task may still finish list_tools in the gap.
                    if result_ready.done() and not result_ready.cancelled():
                        try:
                            discovered = result_ready.result()
                        except Exception:
                            discovery_task.cancel()
                            raise
                    else:
                        discovery_task.cancel()
                        dt_ms = round((time.perf_counter() - t0) * 1000, 2)
                        # Wall starvation ≠ broken server: same class as pre-sem budget exceeded.
                        if wall_limited:
                            logger.warning(
                                "[EXTERNAL_MCP] [HEALTH] tenant=%s server=%s status=skipped host=%s — wall timeout=%s",
                                tenant,
                                probe_body.server_id,
                                host_label,
                                budget_label,
                            )
                            return _mcp_health_skipped_item(
                                probe_body,
                                host_label=host_label,
                                message="budget exceeded",
                                duration_ms=dt_ms,
                            )
                        logger.warning(
                            "[EXTERNAL_MCP] [HEALTH] tenant=%s server=%s status=error host=%s — per-server timeout=%s",
                            tenant,
                            probe_body.server_id,
                            host_label,
                            budget_label,
                        )
                        return _mcp_health_item(
                            probe_body,
                            status="error",
                            host_label=host_label,
                            message=f"health probe exceeded {budget_label}",
                            duration_ms=dt_ms,
                        )
                except asyncio.CancelledError:
                    if not discovery_task.done():
                        discovery_task.cancel()
                    raise
                dt_ms = round((time.perf_counter() - t0) * 1000, 2)
                logger.info(
                    "[EXTERNAL_MCP] [HEALTH] tenant=%s server=%s status=ok host=%s tools=%d duration_ms=%s",
                    tenant,
                    probe_body.server_id,
                    host_label,
                    len(discovered),
                    dt_ms,
                )
                return _mcp_health_item(
                    probe_body,
                    status="ok",
                    host_label=host_label,
                    tools_count=len(discovered),
                    message="list_tools succeeded",
                    duration_ms=dt_ms,
                )
            finally:
                # ok / error(result_ready) / timeout / cancel — always track discovery_task
                # (teardown may still be in same-task disconnect after the future settles).
                _schedule_health_cleanup({discovery_task})
        except asyncio.CancelledError:
            raise
        except HTTPException as e:
            dt_ms = round((time.perf_counter() - t0) * 1000, 2)
            logger.warning(
                "[EXTERNAL_MCP] [HEALTH] tenant=%s server=%s status=error host=%s http_status=%s detail=%s",
                tenant,
                probe_body.server_id,
                host_label,
                e.status_code,
                str(e.detail)[:400],
            )
            return _mcp_health_item(
                probe_body,
                status="error",
                host_label=host_label,
                message=str(e.detail)[:500],
                duration_ms=dt_ms,
            )
        except Exception as e:
            dt_ms = round((time.perf_counter() - t0) * 1000, 2)
            logger.error(
                "[EXTERNAL_MCP] [HEALTH] tenant=%s server=%s status=error host=%s mode=%s "
                "exc_type=%s msg=%s",
                tenant,
                probe_body.server_id,
                host_label,
                probe_body.mode,
                type(e).__name__,
                str(e)[:500],
                exc_info=True,
            )
            return _mcp_health_item(
                probe_body,
                status="error",
                host_label=host_label,
                message=format_mcp_user_message(e)[:500],
                duration_ms=dt_ms,
            )


async def _drain_cancelled_health_tasks(pending: set[asyncio.Task]) -> None:
    """Finish cancelled probe tasks (incl. discovery finally/cleanup) off the response path."""
    if not pending:
        return
    await asyncio.gather(*pending, return_exceptions=True)


_HEALTH_CLEANUP_TASKS: set[asyncio.Task] = set()


def _schedule_health_cleanup(pending: set[asyncio.Task]) -> None:
    """Fire-and-forget cancel drain so HTTP returns within wall-clock."""
    if not pending:
        return
    task = asyncio.create_task(
        _drain_cancelled_health_tasks(pending),
        name="mcp-health-check-cleanup",
    )
    _HEALTH_CLEANUP_TASKS.add(task)
    task.add_done_callback(_HEALTH_CLEANUP_TASKS.discard)


def _resolve_mcp_server_lifecycle_tenant(
    ctx: TenantContext, requested_tenant_id: str | None
) -> str:
    """Resolve a lifecycle target without allowing tenant-admin escalation."""
    requested = str(requested_tenant_id or "").strip()
    if ctx.is_root:
        if not requested:
            raise HTTPException(status_code=400, detail="root must provide tenant_id")
        return requested
    current = str(ctx.tenant_id or "").strip()
    if requested and requested != current:
        raise HTTPException(status_code=403, detail="Cannot manage MCP server from another tenant")
    if not current:
        raise HTTPException(status_code=400, detail="Tenant context is required")
    return current


def _mcp_server_lifecycle_or_fail(storage):
    manager = get_external_mcp_manager()
    if manager is None:
        raise HTTPException(status_code=503, detail="External MCP manager is not initialized")
    orchestrator = get_orchestrator()
    mcp_executor = getattr(orchestrator, "mcp_executor", None) if orchestrator is not None else None
    return McpServerLifecycle(
        storage=storage,
        manager=manager,
        mcp_executor=mcp_executor,
    )


@mcp_router.post(
    "/mcp-servers/{server_id}/restart",
    response_model=McpServerLifecycleResponse,
    summary="Restart a tenant-scope streamable-http ZIP MCP server",
)
async def restart_mcp_server(
    server_id: str,
    body: McpServerLifecycleRequest = Body(default_factory=McpServerLifecycleRequest),
    _admin: dict = Depends(require_role("tenant_admin")),
    ctx: TenantContext = Depends(get_tenant_context),
):
    tenant_id = _resolve_mcp_server_lifecycle_tenant(ctx, body.tenant_id)
    lifecycle = _mcp_server_lifecycle_or_fail(_storage_or_fail())
    try:
        result = await lifecycle.restart(tenant_id=tenant_id, server_id=server_id)
    except McpServerNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except McpLifecycleConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception(
            "[MCP_LIFECYCLE] action=restart tenant=%s server=%s status=failed", tenant_id, server_id
        )
        raise HTTPException(status_code=502, detail=f"MCP restart failed: {exc}") from exc
    logger.info("[MCP_LIFECYCLE] action=restart tenant=%s server=%s status=ok", tenant_id, server_id)
    return McpServerLifecycleResponse(**result)


@mcp_router.delete(
    "/mcp-servers/{server_id}",
    response_model=McpServerLifecycleResponse,
)
async def delete_mcp_server(
    server_id: str,
    body: McpServerLifecycleRequest = Body(default_factory=McpServerLifecycleRequest),
    _admin: dict = Depends(require_role("tenant_admin")),
    ctx: TenantContext = Depends(get_tenant_context),
):
    tenant_id = _resolve_mcp_server_lifecycle_tenant(ctx, body.tenant_id)
    storage = _storage_or_fail()
    lifecycle = _mcp_server_lifecycle_or_fail(storage)
    try:
        result = await lifecycle.delete(
            tenant_id=tenant_id, server_id=server_id, actor_id=ctx.user_id
        )
        await _reload_tool_registry()
        await sync_runtime_after_config_change("mcp_server_delete", agents=True)
        await _sync_tenant_cursor_json_from_tools(
            storage=storage, tenant_id=tenant_id, actor_id=ctx.user_id
        )
    except McpServerNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except McpLifecycleConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception(
            "[MCP_LIFECYCLE] action=delete tenant=%s server=%s status=failed", tenant_id, server_id
        )
        raise HTTPException(status_code=502, detail=f"MCP delete failed: {exc}") from exc
    logger.info("[MCP_LIFECYCLE] action=delete tenant=%s server=%s status=ok", tenant_id, server_id)
    return McpServerLifecycleResponse(**result)


_CONNECTION_PATCH_KEYS = ("endpoint", "mode", "timeout_seconds", "headers", "auth")


def _connection_patch_from_body(body: McpServerConnectionUpdate) -> dict:
    """Build external_mcp patch from unset-aware body fields."""
    dumped = body.model_dump(exclude_unset=True, exclude_none=False)
    dumped.pop("tenant_id", None)
    patch: dict = {}
    for key in _CONNECTION_PATCH_KEYS:
        if key not in dumped:
            continue
        value = dumped[key]
        if key == "headers":
            if value is None:
                patch["headers"] = []
            else:
                pairs = value if isinstance(value, list) else []
                patch["headers"] = [
                    {"name": str(p.get("name") or "").strip(), "value": str(p.get("value") or "")}
                    for p in pairs
                    if isinstance(p, dict) and str(p.get("name") or "").strip()
                ]
        elif key == "auth":
            if value is None:
                continue
            patch["auth"] = value if isinstance(value, dict) else dict(value)
        elif key in ("endpoint", "mode"):
            # Empty / None must not wipe stored runtime (partial update ≠ clear).
            if value is None or not str(value).strip():
                raise HTTPException(status_code=400, detail=f"{key} must not be empty")
            patch[key] = str(value).strip()
        else:
            patch[key] = value
    return patch


def _fork_required_connection_detail(server_id: str, system_tools: list) -> dict:
    return {
        "code": "fork_required",
        "message": (
            f"'{server_id}' is a shared MCP server. Editing connection settings "
            f"creates your tenant's copy of the whole server "
            f"({len(system_tools)} tools); platform updates and key "
            "rotations will no longer apply to the copy. After forking, open "
            "Settings on your tenant copy to change credentials."
        ),
        "server_id": server_id,
        "tool_count": len(system_tools),
    }


async def _fanout_mcp_server_connection(
    storage,
    *,
    tenant_id: str,
    server_id: str,
    patch: dict,
    actor_id: str | None,
    targeting_shared: bool = False,
) -> int:
    """Merge connection fields into every tenant-owned tool doc for ``server_id``.

    ``targeting_shared`` means the client addressed the ``__system__`` group
    (ADR-0013): never silent-fan-out onto an existing fork — always
    ``fork_required`` while shared tools exist, so catch-up fork runs first and
    connection edits happen on the owned group with an owned-seeded form.
    """
    if not patch:
        raise HTTPException(status_code=400, detail="No connection fields to update")
    # Tenant inheritance scope (owned + __system__), not the whole collection:
    # an uncapped cross-tenant scan would truncate under Mongo's list ceiling.
    docs = await get_mcp_tool_configurations(
        storage, enabled_only=False, tenant_id=tenant_id
    )
    server_docs = [
        d
        for d in (docs or [])
        if isinstance(d, dict)
        and d.get("source") == "mcp_server"
        and str(d.get("mcp_server") or "").strip() == server_id
    ]
    owned = [d for d in server_docs if _tenant_owns_doc(d, tenant_id)]
    system_tools = [
        d for d in server_docs if str(d.get("tenant_id") or "") == SYSTEM_TENANT_ID
    ]
    if targeting_shared and system_tools:
        raise HTTPException(
            status_code=409,
            detail=_fork_required_connection_detail(server_id, system_tools),
        )
    if not owned:
        if system_tools:
            raise HTTPException(
                status_code=409,
                detail=_fork_required_connection_detail(server_id, system_tools),
            )
        raise HTTPException(status_code=404, detail=f"MCP server '{server_id}' not found")

    # Same SSRF/allowlist gate as discover — only when endpoint actually changes,
    # so header-only rotation on a grandfathered URL still works.
    if "endpoint" in patch:
        sample_rt = _runtime_from_tool_doc(owned[0])
        # ZIP/stdio runtimes derive endpoint from image/command; rewriting it here
        # skips provenance helpers and leaves tools pointed at a stale URL.
        for doc in owned:
            rt = _runtime_from_tool_doc(doc)
            if str(rt.get("image") or "").strip() or str(rt.get("command") or "").strip():
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Cannot change endpoint on a zip- or stdio-hosted MCP server "
                        "via connection settings"
                    ),
                )
        old_ep = str(sample_rt.get("endpoint") or "").strip()
        new_ep = str(patch.get("endpoint") or "").strip()
        if new_ep != old_ep:
            await _validate_mcp_entry_runtime_or_raise({**sample_rt, **patch})

    ceiling = await _tenant_mcp_call_timeout_ceiling(storage, tenant_id)
    prepared: list[tuple[dict, dict, dict]] = []
    for doc in owned:
        # Per-doc patch copy: _restore_masked_external_mcp_auth mutates auth in
        # place; a shared patch would leak owned[0]'s secret into later docs.
        doc_patch = copy.deepcopy(patch)
        meta = doc.get("metadata") if isinstance(doc.get("metadata"), dict) else {}
        old_rt = meta.get("external_mcp") if isinstance(meta.get("external_mcp"), dict) else {}
        new_rt = {**old_rt, **doc_patch}
        probe_meta = {"external_mcp": new_rt}
        _restore_masked_external_mcp_auth(probe_meta, {"external_mcp": old_rt})
        new_rt = probe_meta["external_mcp"]
        if _auth_from_metadata(probe_meta) != _auth_from_metadata({"external_mcp": old_rt}):
            _validate_external_mcp_auth_or_400(probe_meta)
        if "timeout_seconds" in doc_patch:
            _validate_external_mcp_timeout_or_400(probe_meta, ceiling)
        # Snapshot before any write so rollback cannot see a half-mutated meta.
        prepared.append((doc, copy.deepcopy(meta), copy.deepcopy(new_rt)))

    written: list[tuple[dict, dict]] = []
    try:
        for doc, prior_meta, new_rt in prepared:
            # Record before save: in-place metadata mutation must roll back even
            # when the write itself raises (including HTTPException from lease claim).
            written.append((doc, prior_meta))
            doc["metadata"] = {**copy.deepcopy(prior_meta), "external_mcp": new_rt}
            _normalize_tool_doc_for_storage(doc)
            await save_tool_document(storage, doc, actor_id=actor_id)
    except Exception as exc:
        # Validation HTTPExceptions happen before ``written`` is non-empty and
        # re-raise untouched. Mid-write failures (lease 409, Mongo, …) roll back.
        if written:
            for doc, prior_meta in reversed(written):
                try:
                    doc_id = str(doc.get("_id") or "").strip()
                    getter = getattr(storage, "get_mcp_tool_configuration", None)
                    current = await getter(doc_id) if callable(getter) and doc_id else None
                    target = current if isinstance(current, dict) else doc
                    target["metadata"] = copy.deepcopy(prior_meta)
                    _normalize_tool_doc_for_storage(target)
                    await save_tool_document(storage, target, actor_id=actor_id)
                except Exception:
                    logger.warning(
                        "[CONFIG-API] [MCP_CONNECTION] rollback failed tenant=%s server=%s tool=%s",
                        tenant_id,
                        server_id,
                        doc.get("name"),
                    )
            logger.error(
                "[CONFIG-API] [MCP_CONNECTION] fan-out failed tenant=%s server=%s "
                "after %d/%d tools: %s",
                tenant_id,
                server_id,
                len(written),
                len(prepared),
                exc,
            )
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(
            status_code=500,
            detail={
                "code": "connection_update_failed",
                "message": (
                    f"Updating connection for MCP server '{server_id}' failed; "
                    "partial writes were rolled back. Retry the save."
                ),
            },
        ) from exc
    return len(prepared)


@mcp_router.put(
    "/mcp-servers/{server_id}/connection",
    response_model=McpServerConnectionUpdateResponse,
    summary="Update connection metadata for all tenant-owned tools on an MCP server",
)
async def update_mcp_server_connection(
    server_id: str,
    body: McpServerConnectionUpdate,
    _admin: dict = Depends(require_role("tenant_admin")),
    ctx: TenantContext = Depends(get_tenant_context),
):
    sid = str(server_id or "").strip()
    if not sid or not _MCP_SERVER_ID_SAFE.match(sid):
        raise HTTPException(status_code=400, detail="Invalid server_id")
    # Shared groups expose tenant_id=__system__ in the UI. That is a display label,
    # not a lifecycle target: tenant_admin sending it hits 403 in resolve before
    # fork_required. Drop it so resolve uses the caller's tenant, but keep
    # targeting_shared so fan-out never silent-overwrites an existing fork
    # (ADR-0013). Root may still pass __system__ to edit platform docs in place.
    requested_tenant = body.tenant_id
    targeting_shared = (
        not ctx.is_root
        and str(requested_tenant or "").strip() == SYSTEM_TENANT_ID
    )
    if targeting_shared:
        requested_tenant = None
    tenant_id = _resolve_mcp_server_lifecycle_tenant(ctx, requested_tenant)
    storage = _storage_or_fail()
    patch = _connection_patch_from_body(body)
    tools_updated = await _fanout_mcp_server_connection(
        storage,
        tenant_id=tenant_id,
        server_id=sid,
        patch=patch,
        actor_id=ctx.user_id,
        targeting_shared=targeting_shared,
    )
    await _reload_tool_registry()
    await _sync_tenant_cursor_json_from_tools(
        storage=storage, tenant_id=tenant_id, actor_id=ctx.user_id
    )
    logger.info(
        "[CONFIG-API] [MCP_CONNECTION] tenant=%s server=%s tools_updated=%d keys=%s",
        tenant_id,
        sid,
        tools_updated,
        sorted(patch.keys()),
    )
    return McpServerConnectionUpdateResponse(
        server_id=sid, tenant_id=tenant_id, tools_updated=tools_updated
    )


@router.post("/mcp-servers/health-check", response_model=MCPServersHealthResponse)
async def health_check_all_mcp_servers(
    ctx: TenantContext = Depends(get_tenant_context),
    body: MCPServersHealthCheckRequest = Body(default_factory=MCPServersHealthCheckRequest),
):
    """Probe distinct MCP servers from saved tools (POST only; JWT required).

    Optional body.server_ids: omit/null = all; [] = empty result; non-empty = filter by
    MCP server_id (UI name). Unknown ids → status=not_found (no remote probe).

    Bounded fan-out: wall-clock / per-server timeout / concurrency / max attempts
    (see HEALTH_CHECK_* constants). Unfinished probes → status=skipped.
    """
    from datetime import datetime, timezone

    storage = _storage_or_fail()
    requested_tenant = str(body.tenant_id or "").strip() if body else ""
    if ctx.is_root and requested_tenant:
        tid = requested_tenant
        tenant = requested_tenant
    else:
        tid = None if ctx.is_root else ctx.tenant_id
        tenant = ctx.tenant_id or "__root__"
    docs = await get_mcp_tool_configurations(storage, enabled_only=False, tenant_id=tid)
    by_key: dict[str, MCPServerDiscoverRequest] = {}
    sids_seen_in_docs: set[str] = set()
    # Truncate each server's timeout to ITS OWNER tenant's ceiling (contract 4), cached
    # per owner so a batch does one settings read per distinct tenant.
    ceiling_by_owner: dict[str, int] = {}
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        sid_doc = str(doc.get("mcp_server") or "").strip()
        if sid_doc:
            sids_seen_in_docs.add(sid_doc)
        owner = str(doc.get("tenant_id") or "").strip() or tenant
        if owner not in ceiling_by_owner:
            ceiling_by_owner[owner] = await _tenant_mcp_call_timeout_ceiling(storage, owner)
        try:
            req = _tool_doc_to_discover_request(doc, ceiling=ceiling_by_owner[owner])
        except Exception:
            # A corrupt stored runtime (e.g. a hand-edited/legacy auth block Pydantic rejects)
            # must not sink the whole batch — skip just this row.
            logger.warning(
                "[EXTERNAL_MCP] [HEALTH] skipping server=%s — unbuildable runtime", sid_doc,
                exc_info=True,
            )
            continue
        if req is None:
            continue
        by_key.setdefault(_mcp_discover_dedupe_key(req), req)

    checked_at = datetime.now(timezone.utc).isoformat()
    requested = _normalize_mcp_health_server_ids(body.server_ids if body else None)

    if requested is not None and len(requested) == 0:
        logger.info(
            "[EXTERNAL_MCP] [HEALTH] batch done tenant=%s servers=0 ok=0 error=0 skipped=0 "
            "wall_ms=0 filter=empty",
            tenant,
        )
        return MCPServersHealthResponse(
            checked_at=checked_at,
            servers=[],
            summary_ok=0,
            summary_error=0,
            summary_skipped=0,
            summary_policy_blocked=0,
            summary_not_found=0,
        )

    not_found: List[MCPServerHealthItem] = []
    if requested is None:
        to_probe: List[MCPServerDiscoverRequest] = list(by_key.values())
    else:
        # Same runtime keying as full check: every distinct runtime for a server_id.
        to_probe = []
        for sid in requested:
            matches = [
                req
                for req in by_key.values()
                if str(req.server_id or "").strip() == sid
            ]
            if matches:
                to_probe.extend(matches)
            elif sid in sids_seen_in_docs:
                not_found.append(
                    _mcp_health_item(
                        None,
                        server_id=sid,
                        status="not_found",
                        message=(
                            "MCP server has no runtime configured "
                            "(endpoint/image/command)"
                        ),
                    )
                )
            else:
                not_found.append(
                    _mcp_health_item(
                        None,
                        server_id=sid,
                        status="not_found",
                        message="MCP server not found in tenant tools",
                    )
                )

    deadline = time.monotonic() + HEALTH_CHECK_WALL_CLOCK_S
    sem = asyncio.Semaphore(HEALTH_CHECK_CONCURRENCY)
    batch_t0 = time.perf_counter()

    task_to_body: dict[asyncio.Task, MCPServerDiscoverRequest] = {}
    servers_out: List[MCPServerHealthItem] = list(not_found)
    try:
        for probe_req in to_probe:
            task = asyncio.create_task(
                _probe_one_mcp_health(
                    probe_req,
                    tenant=tenant,
                    storage=storage,
                    sem=sem,
                    deadline=deadline,
                )
            )
            task_to_body[task] = probe_req

        if task_to_body:
            done, pending = await asyncio.wait(
                task_to_body.keys(),
                timeout=HEALTH_CHECK_WALL_CLOCK_S,
            )
            for task in done:
                try:
                    servers_out.append(task.result())
                except Exception as e:
                    probe_req = task_to_body[task]
                    host_label = _mcp_health_host_label(probe_req)
                    servers_out.append(
                        _mcp_health_item(
                            probe_req,
                            status="error",
                            host_label=host_label,
                            message=format_mcp_user_message(e)[:500],
                            duration_ms=None,
                        )
                    )
            for task in pending:
                # wait()'s pending is a snapshot; task may have finished while we drained done.
                if task.done():
                    try:
                        servers_out.append(task.result())
                    except Exception as e:
                        probe_req = task_to_body[task]
                        host_label = _mcp_health_host_label(probe_req)
                        servers_out.append(
                            _mcp_health_item(
                                probe_req,
                                status="error",
                                host_label=host_label,
                                message=format_mcp_user_message(e)[:500],
                                duration_ms=None,
                            )
                        )
                    continue
                probe_req = task_to_body[task]
                host_label = _mcp_health_host_label(probe_req)
                servers_out.append(
                    _mcp_health_skipped_item(
                        probe_req,
                        host_label=host_label,
                        message="budget exceeded",
                        duration_ms=round((time.perf_counter() - batch_t0) * 1000, 2),
                    )
                )
    finally:
        # Wall-clock pending *and* HTTP CancelledError: cancel every in-flight probe and
        # drain in background (do not await docker stop/rm on the response path).
        leftover = {t for t in task_to_body if not t.done()}
        for t in leftover:
            t.cancel()
        if leftover:
            _schedule_health_cleanup(leftover)

    summary_ok = sum(1 for s in servers_out if s.status == "ok")
    summary_error = sum(1 for s in servers_out if s.status == "error")
    summary_skipped = sum(1 for s in servers_out if s.status == "skipped")
    summary_policy_blocked = sum(1 for s in servers_out if s.status == "policy_blocked")
    summary_not_found = sum(1 for s in servers_out if s.status == "not_found")
    wall_ms = round((time.perf_counter() - batch_t0) * 1000, 2)
    logger.info(
        "[EXTERNAL_MCP] [HEALTH] batch done tenant=%s servers=%d ok=%d error=%d skipped=%d "
        "policy_blocked=%d not_found=%d wall_ms=%s wall_s=%s per_server_s=%s concurrency=%s "
        "max_attempts=%s filter=%s",
        tenant,
        len(servers_out),
        summary_ok,
        summary_error,
        summary_skipped,
        summary_policy_blocked,
        summary_not_found,
        wall_ms,
        HEALTH_CHECK_WALL_CLOCK_S,
        HEALTH_CHECK_PER_SERVER_S,
        HEALTH_CHECK_CONCURRENCY,
        HEALTH_CHECK_MAX_ATTEMPTS,
        "all" if requested is None else f"ids={len(requested)}",
    )

    servers_out.sort(key=lambda x: x.server_id)
    return MCPServersHealthResponse(
        checked_at=checked_at,
        servers=servers_out,
        summary_ok=summary_ok,
        summary_error=summary_error,
        summary_skipped=summary_skipped,
        summary_policy_blocked=summary_policy_blocked,
        summary_not_found=summary_not_found,
    )


def _normalize_mcp_health_server_ids(raw: Optional[List[str]]) -> Optional[List[str]]:
    """None = all servers; [] = no probes; else ordered unique non-empty ids."""
    if raw is None:
        return None
    out: List[str] = []
    seen: set[str] = set()
    for item in raw:
        sid = str(item or "").strip()
        if not sid or sid in seen:
            continue
        seen.add(sid)
        out.append(sid)
    return out


def _cursor_json_entry_from_tool(tool_doc: dict) -> dict | None:
    """Build mcpServers entry from one tool config."""
    if not isinstance(tool_doc, dict):
        return None
    if tool_doc.get("source") != "mcp_server":
        return None
    meta = tool_doc.get("metadata") if isinstance(tool_doc.get("metadata"), dict) else {}
    rt = meta.get("external_mcp") if isinstance(meta.get("external_mcp"), dict) else {}
    mode = str(rt.get("mode") or "http").strip().lower()
    timeout_ms = int(float(rt.get("timeout_seconds") or 30.0) * 1000)
    headers_obj = runtime_headers_dict(rt)

    endpoint = str(rt.get("endpoint") or "").strip()
    image = str(rt.get("image") or "").strip()
    command = str(rt.get("command") or "").strip()
    docker_env = rt.get("docker_env_vars") if isinstance(rt.get("docker_env_vars"), dict) else {}
    docker_args = rt.get("docker_cmd_args") if isinstance(rt.get("docker_cmd_args"), list) else []
    cmd_env = rt.get("command_env") if isinstance(rt.get("command_env"), dict) else {}
    cmd_args = rt.get("command_args") if isinstance(rt.get("command_args"), list) else []

    if endpoint and not image and mode in ("http", "streamable-http"):
        out = {
            "url": endpoint,
            "transport": "streamable-http" if mode == "streamable-http" else "http",
            "timeout": timeout_ms,
            "disabled": False,
        }
        if headers_obj:
            out["headers"] = headers_obj
        return out

    if image:
        out = {
            "image": image,
            "args": docker_args,
            "env": docker_env,
            "timeout": timeout_ms,
            "disabled": False,
        }
        return out

    if command:
        out = {
            "command": command,
            "args": cmd_args,
            "env": cmd_env,
            "timeout": timeout_ms,
            "disabled": False,
        }
        return out
    return None


def _entry_score(v: dict) -> int:
    if not isinstance(v, dict):
        return 0
    score = 0
    for k in ("url", "image", "command", "headers", "env", "args"):
        if k in v and v.get(k):
            score += 1
    return score


_CURSOR_HTTP_TRANSPORTS = frozenset({"http", "streamable-http"})


def _is_cursor_http_remote_entry(entry: dict) -> bool:
    """True for Cursor mcpServers entries that use remote HTTP or streamable-http."""
    if not isinstance(entry, dict):
        return False
    url = str(entry.get("url") or "").strip()
    if not url:
        return False
    if entry.get("image") or entry.get("command"):
        return False
    transport = str(entry.get("transport") or "").strip().lower()
    return transport in _CURSOR_HTTP_TRANSPORTS


def _minimal_cursor_http_entry(entry: dict) -> dict:
    """Strip a Cursor server entry to url + transport only."""
    transport = str(entry.get("transport") or "http").strip().lower()
    if transport not in _CURSOR_HTTP_TRANSPORTS:
        transport = "http"
    return {
        "url": str(entry.get("url") or "").strip(),
        "transport": transport,
    }


def _server_has_enabled_tools_for_http_export(entry: dict) -> bool:
    """True when server should appear in cursor-json-http (at least one enabled tool)."""
    if not isinstance(entry, dict):
        return False
    tools = entry.get("tools")
    disabled = entry.get("disabledTools")
    if isinstance(tools, list) or isinstance(disabled, list):
        enabled_names = [
            str(x).strip() for x in (tools or []) if str(x).strip()
        ]
        return len(enabled_names) > 0
    return True


def _filter_cursor_json_http_servers(mcp_servers: dict) -> dict[str, dict]:
    """Keep only active remote HTTP / streamable-http servers (url + transport)."""
    if not isinstance(mcp_servers, dict):
        return {}
    out: dict[str, dict] = {}
    for name, entry in mcp_servers.items():
        sid = str(name or "").strip()
        if not sid or not _is_cursor_http_remote_entry(entry):
            continue
        if not _server_has_enabled_tools_for_http_export(entry):
            continue
        out[sid] = _minimal_cursor_http_entry(entry)
    return out


async def _build_cursor_http_servers_from_tools(storage, tenant_id: str) -> dict[str, dict]:
    """Build minimal Cursor mcpServers map from enabled MCP tool rows (HTTP only)."""
    from config.tool_configuration_schema import (
        drop_disabled_effective_docs,
        drop_system_docs_shadowed_by_owned,
    )

    # Shadow first, THEN drop disabled (ADR-0013): a fork the tenant disabled must
    # still shadow its __system__ twin, or the shared platform URL resurfaces here
    # and the export silently undoes the disable. Storage returns unfiltered.
    docs = await get_mcp_tool_configurations(
        storage, enabled_only=False, tenant_id=tenant_id,
    )
    docs = drop_disabled_effective_docs(drop_system_docs_shadowed_by_owned(docs))
    servers: dict[str, dict] = {}
    scores: dict[str, int] = {}
    for d in docs:
        sid = str(d.get("mcp_server") or "").strip()
        if not sid:
            continue
        entry = _cursor_json_entry_from_tool(d)
        if not entry or not _is_cursor_http_remote_entry(entry):
            continue
        score = _entry_score(entry)
        if sid not in servers or score >= scores.get(sid, 0):
            servers[sid] = _minimal_cursor_http_entry(entry)
            scores[sid] = score
    return servers


def _cursor_entry_to_external_mcp_runtime(entry: dict) -> dict:
    """Map one mcpServers entry to metadata.external_mcp runtime settings."""
    if not isinstance(entry, dict):
        return {}
    timeout_ms = entry.get("timeout")
    try:
        timeout_seconds = float(timeout_ms) / 1000.0 if timeout_ms is not None else 30.0
    except (TypeError, ValueError):
        timeout_seconds = 30.0
    timeout_seconds = max(1.0, timeout_seconds)

    out: dict = {"timeout_seconds": timeout_seconds}
    transport = str(entry.get("transport") or "").strip().lower()
    url = str(entry.get("url") or "").strip()
    image = str(entry.get("image") or "").strip()
    command = str(entry.get("command") or "").strip()
    args = entry.get("args") if isinstance(entry.get("args"), list) else []
    env = entry.get("env") if isinstance(entry.get("env"), dict) else {}
    headers = entry.get("headers") if isinstance(entry.get("headers"), dict) else {}

    if url:
        out["endpoint"] = url
        out["mode"] = "streamable-http" if transport == "streamable-http" else "http"
        if headers:
            out["headers"] = [{"name": str(k), "value": str(v)} for k, v in headers.items()]
    elif image:
        out["mode"] = "stdio"
        out["image"] = image
        if args:
            out["docker_cmd_args"] = [str(x) for x in args]
        if env:
            out["docker_env_vars"] = {str(k): str(v) for k, v in env.items()}
    elif command:
        out["mode"] = "stdio"
        out["command"] = command
        if args:
            out["command_args"] = [str(x) for x in args]
        if env:
            out["command_env"] = {str(k): str(v) for k, v in env.items()}
    return out


def _mcp_server_runtime_signature(runtime: dict) -> str:
    """Stable key to compare whether two MCP server blocks are the same endpoint/runtime."""
    if not isinstance(runtime, dict):
        return ""
    endpoint = str(runtime.get("endpoint") or "").strip()
    image = str(runtime.get("image") or "").strip()
    command = str(runtime.get("command") or "").strip()
    mode = str(runtime.get("mode") or "").strip().lower()
    return f"{mode}|{endpoint}|{image}|{command}"


def _runtime_from_tool_doc(doc: dict) -> dict:
    meta = doc.get("metadata") if isinstance(doc.get("metadata"), dict) else {}
    rt = meta.get("external_mcp") if isinstance(meta.get("external_mcp"), dict) else {}
    return rt


def _sibling_mcp_auth(docs: list) -> dict | None:
    """First stored ``external_mcp.auth`` among a server's existing tool docs.

    Cursor JSON never carries ``auth``, so a rename/add-tool save derives an authless runtime
    and the credential lives only on sibling docs of the same server. Returns it so those paths
    inherit it instead of discovering unauthenticated / persisting the new tool authless.
    """
    for d in docs or []:
        auth = _runtime_from_tool_doc(d).get("auth") if isinstance(d, dict) else None
        if isinstance(auth, dict) and auth:
            return auth
    return None


async def _stored_server_auth(storage, *, tenant_id: str, server_id: str) -> dict | None:
    """Stored ``external_mcp.auth`` for a server, taken from its own tenant-owned tool docs.

    Create paths (batch / single) inherit this when the client omits auth: the UI discover-import
    and cursor payloads never carry it and a GET only ever exposes it masked, so a tool added to an
    existing oauth2 server would otherwise persist authless and 401 at call time while its siblings
    work. Restricted to tenant-owned docs so a tenant can't inherit a shared/__system__ credential.
    """
    docs = await get_mcp_tool_configurations(storage, enabled_only=False, tenant_id=tenant_id)
    owned = [
        d for d in (docs or [])
        if isinstance(d, dict)
        and d.get("source") == "mcp_server"
        and str(d.get("mcp_server") or "").strip() == server_id
        and _tenant_owns_doc(d, tenant_id)
    ]
    return _sibling_mcp_auth(owned)


def _inherit_missing_external_mcp_auth(metadata: object, sibling_auth: dict | None) -> None:
    """Set ``external_mcp.auth`` from a sibling only when the client supplied none.

    Runs AFTER _validate_external_mcp_auth_or_400 so the inherited (already-stored, trusted) block
    is not re-validated — re-validating it would 400 a create merely because the sibling's secret
    env drifted unset, the same footgun the PUT update path avoids.
    """
    if not sibling_auth:
        return
    rt = metadata.get("external_mcp") if isinstance(metadata, dict) else None
    if isinstance(rt, dict) and "auth" not in rt:
        rt["auth"] = sibling_auth


async def _discover_tools_from_cursor_server_entry(
    *, tenant_id: str, server_id: str, entry: dict, inherited_auth: dict | None = None
) -> list[dict]:
    """Discover MCP tools for one server entry from Cursor JSON.

    ``inherited_auth`` is a sibling doc's stored auth, used because cursor JSON never carries
    one — without it discovery of an oauth2/bearer server would go out unauthenticated and 401.
    """
    runtime = _cursor_entry_to_external_mcp_runtime(entry)
    await _validate_mcp_entry_runtime_or_raise(runtime)
    mode = str(runtime.get("mode") or "http").strip().lower()
    timeout = float(runtime.get("timeout_seconds") or 30.0)
    endpoint = str(runtime.get("endpoint") or "")
    headers = runtime_headers_dict(runtime)

    _img = runtime.get("image")
    stdio_nm = stdio_docker_container_name(tenant_id, server_id) if _img else None
    client = ExternalMCPClient(
        ExternalMCPConfig(
            server_id=server_id,
            auth=build_mcp_auth(
                runtime.get("auth") or inherited_auth,
                tenant_id=tenant_id,
                server_id=server_id,
            ),
            endpoint=endpoint,
            tenant_id=tenant_id,
            timeout_seconds=timeout,
            mode=mode,
            headers=headers,
            image=_img,
            docker_env_vars=runtime.get("docker_env_vars"),
            docker_cmd_args=runtime.get("docker_cmd_args"),
            command=runtime.get("command"),
            args=runtime.get("command_args"),
            env=runtime.get("command_env"),
            stdio_docker_name=stdio_nm,
        )
    )
    try:
        return await client.discover_tools()
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass


async def _migrate_mcp_tool_storage_id(
    storage,
    *,
    tenant_id: str,
    server_id: str,
    tool_name: str,
    existing_doc: dict | None,
) -> str:
    """Resolve tenant-scoped ``_id`` and remove legacy global id for the same tool."""
    from config.configuration_resolution import is_opaque_storage_id

    if isinstance(existing_doc, dict):
        old_id = str(existing_doc.get("_id") or "").strip()
        if old_id and is_opaque_storage_id(old_id):
            return old_id

    new_id = mcp_tool_document_id(tenant_id, server_id, tool_name)
    old_ids: list[str] = []
    if isinstance(existing_doc, dict) and existing_doc.get("_id"):
        old_ids.append(str(existing_doc["_id"]))
    for old_id in old_ids:
        if not old_id or old_id == new_id:
            continue
        getter = getattr(storage, "get_mcp_tool_configuration", storage.get_tool_configuration)
        deleter = getattr(
            storage,
            "delete_mcp_tool_configuration",
            storage.delete_tool_configuration,
        )
        old_doc = await getter(old_id)
        if not old_doc:
            continue
        if old_doc.get("tenant_id") is None:
            continue
        doc_tenant = str(old_doc.get("tenant_id"))
        if doc_tenant != str(tenant_id):
            continue
        await deleter(old_id)
    return new_id


async def _upsert_discovered_tool_configs(
    *,
    storage,
    tenant_id: str,
    actor_id: str | None,
    server_id: str,
    entry: dict,
    discovered: list,
    existing_by_name: dict[str, dict],
    desired_enabled: set[str] | None,
    desired_disabled: set[str],
    names_filter: set[str] | None = None,
    inherited_auth: dict | None = None,
) -> set[str]:
    """Persist tools from discover. When names_filter is set, only those tool names."""
    runtime = await derive_zip_runtime_provenance(
        storage,
        tenant_id=tenant_id,
        server_id=server_id,
        runtime=_cursor_entry_to_external_mcp_runtime(entry),
    )
    # Cursor JSON carries no auth; keep a sibling's stored credential on the new tool docs so a
    # tools[]-added tool isn't persisted authless (call_tool would then 401 while siblings work).
    if inherited_auth and "auth" not in runtime:
        runtime["auth"] = inherited_auth
    imported: set[str] = set()
    for item in discovered or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name or (names_filter is not None and name not in names_filter):
            continue
        rpc_name = name
        doc = existing_by_name.get(rpc_name)
        tool_id = await _migrate_mcp_tool_storage_id(
            storage,
            tenant_id=tenant_id,
            server_id=server_id,
            tool_name=rpc_name,
            existing_doc=doc if isinstance(doc, dict) else None,
        )
        enabled = True
        if desired_enabled is not None:
            enabled = rpc_name in desired_enabled
        elif rpc_name in desired_disabled:
            enabled = False
        incoming_upstream = str(item.get("description") or "").strip()
        new_doc = {
            "_id": tool_id,
            "rpc_name": rpc_name,
            "description": incoming_upstream,
            "category": "mcp",
            "source": "mcp_server",
            "mcp_server": server_id,
            "schema": item.get("schema"),
            "enabled": enabled,
            "tenant_id": tenant_id,
            "metadata": {
                **(
                    doc.get("metadata")
                    if isinstance(doc, dict) and isinstance(doc.get("metadata"), dict)
                    else {}
                ),
                "external_mcp": runtime,
            },
        }
        from tools.mcp_llm_function_names import LlmFunctionNameError, preserved_wire_name_for_identity

        preserved = preserved_wire_name_for_identity(doc, server_id, rpc_name)
        if preserved:
            new_doc["name"] = preserved
        try:
            await _assign_mcp_wire_name(
                new_doc,
                storage,
                preserve_existing=bool(new_doc.get("name")),
                exclude_storage_id=tool_id,
            )
            _normalize_tool_doc_for_storage(new_doc)
            # Prod import only creates missing tools; rebuild short/long from upstream.
            sync_entity_descriptions_for_save(new_doc)
            await save_tool_document(storage, new_doc, actor_id=actor_id)
        except (HTTPException, LlmFunctionNameError) as exc:
            logger.warning(
                "[MCP_DISCOVER] skip tool tenant_id=%s server=%s rpc_name=%s err=%s",
                tenant_id,
                server_id,
                rpc_name,
                exc,
            )
            continue
        imported.add(name)
    return imported


async def _import_servers_and_tools_from_cursor_json(
    *,
    storage,
    tenant_id: str,
    actor_id: str | None,
    mcp_servers: dict,
    warnings: list[str] | None = None,
    discover_state: dict[str, dict] | None = None,
) -> None:
    """Import newly added / catch-up servers from Cursor JSON into Mongo tool configs."""
    if not isinstance(mcp_servers, dict):
        return
    from datetime import datetime, timezone

    warn = warnings if warnings is not None else []
    state = discover_state if discover_state is not None else {}
    existing_docs = await get_mcp_tool_configurations(
        storage, enabled_only=False, tenant_id=tenant_id,
    )
    by_server, shared_only_servers = _split_mcp_tool_docs_by_ownership(
        existing_docs, tenant_id,
    )

    for server_id_raw, entry in mcp_servers.items():
        server_id = str(server_id_raw or "").strip()
        if not server_id or not isinstance(entry, dict):
            continue
        if _cursor_entry_has_explicit_empty_tools(entry):
            state[server_id] = {
                "outcome": "empty",
                "reason": "explicit_tools_empty",
            }
            continue
        if by_server.get(server_id):
            continue
        if server_id in shared_only_servers:
            # Backstop for callers that did not run the resolve-time refusal.
            warn.append(_shared_server_import_warning(server_id))
            continue
        desired_enabled = None
        desired_disabled = set()
        if isinstance(entry.get("tools"), list):
            desired_enabled = {str(x).strip() for x in entry.get("tools") or [] if str(x).strip()}
        if isinstance(entry.get("disabledTools"), list):
            desired_disabled = {str(x).strip() for x in entry.get("disabledTools") or [] if str(x).strip()}
        attempted_at = datetime.now(timezone.utc).isoformat()
        try:
            discovered = await _discover_tools_from_cursor_server_entry(
                tenant_id=tenant_id,
                server_id=server_id,
                entry=entry,
            )
        except HTTPException as exc:
            runtime = _cursor_entry_to_external_mcp_runtime(entry)
            detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
            message = _mcp_discovery_failure_detail(
                exc,
                network_discovery=_is_network_mode_runtime(runtime),
                server_id=server_id,
            )
            state[server_id] = {
                "attempted_at": attempted_at,
                "outcome": "failed",
                "error": detail,
            }
            warn.append(message)
            logger.warning(
                "[CONFIG-API] [CURSOR_JSON] import skipped tenant_id=%s server=%s error=%s",
                tenant_id,
                server_id,
                detail,
            )
            continue
        except AssertionError:
            raise
        except Exception as e:
            runtime = _cursor_entry_to_external_mcp_runtime(entry)
            message = _mcp_discovery_failure_detail(
                e,
                network_discovery=_is_network_mode_runtime(runtime),
                server_id=server_id,
            )
            state[server_id] = {
                "attempted_at": attempted_at,
                "outcome": "failed",
                "error": str(e),
            }
            warn.append(message)
            logger.warning(
                "[CONFIG-API] [CURSOR_JSON] import skipped tenant_id=%s server=%s error=%s",
                tenant_id,
                server_id,
                e,
            )
            continue

        existing_for_server = by_server.get(server_id, [])
        existing_by_name = _index_mcp_docs_by_rpc(existing_for_server)
        imported = await _upsert_discovered_tool_configs(
            storage=storage,
            tenant_id=tenant_id,
            actor_id=actor_id,
            server_id=server_id,
            entry=entry,
            discovered=discovered if isinstance(discovered, list) else [],
            existing_by_name=existing_by_name,
            desired_enabled=desired_enabled,
            desired_disabled=desired_disabled,
        )
        state[server_id] = {
            "attempted_at": attempted_at,
            "outcome": "ok" if imported else "empty",
        }


async def _apply_explicit_tool_selection_from_cursor_json(
    *,
    storage,
    tenant_id: str,
    actor_id: str | None,
    mcp_servers: dict,
) -> None:
    """Apply explicit tools/disabledTools from JSON to DB for existing servers.

    If tools/disabledTools are provided for a server, DB tool configs are pruned to this union.
    """
    if not isinstance(mcp_servers, dict):
        return
    docs = await get_mcp_tool_configurations(
        storage, enabled_only=False, tenant_id=tenant_id,
    )
    by_server: dict[str, list[dict]] = {}
    shared_rpcs_by_server: dict[str, set[str]] = {}
    for d in docs or []:
        if not isinstance(d, dict) or d.get("source") != "mcp_server":
            continue
        sid = str(d.get("mcp_server") or "").strip()
        if not sid:
            continue
        # The fetch spans {tenant, __system__}. mcp.json expresses only the
        # tenant's own installs — acting on shared docs here would disable or
        # delete the platform offering for every tenant (ADR-0013). Their rpcs
        # are still tracked per doc, so tools[] cannot mint a shadow of one on a
        # server the tenant merely co-inhabits.
        if not _tenant_owns_doc(d, tenant_id):
            # `mcp_rpc_name_from_doc` is imported function-locally further down,
            # which makes the name local to this whole body — reaching it here
            # would raise UnboundLocalError.
            rpc = _mcp_doc_identity(d)[1]
            if rpc:
                shared_rpcs_by_server.setdefault(sid, set()).add(rpc)
            continue
        by_server.setdefault(sid, []).append(d)

    for server_id_raw, entry in mcp_servers.items():
        server_id = str(server_id_raw or "").strip()
        if not server_id or not isinstance(entry, dict):
            continue
        has_tools = isinstance(entry.get("tools"), list)
        has_disabled = isinstance(entry.get("disabledTools"), list)
        if not (has_tools or has_disabled):
            continue

        enabled_set = {
            str(x).strip()
            for x in (entry.get("tools") or [])
            if str(x).strip()
        }
        disabled_set = {
            str(x).strip()
            for x in (entry.get("disabledTools") or [])
            if str(x).strip()
        }
        allowed = enabled_set | disabled_set
        if not allowed:
            # Explicit empty selection means remove all tools for this server.
            for d in by_server.get(server_id, []):
                if isinstance(d, dict) and d.get("_id"):
                    await delete_tool_document(storage, d)
            continue

        server_docs = by_server.get(server_id, [])
        existing_names = set(_index_mcp_docs_by_rpc(server_docs).keys())
        new_names_in_json = {n for n in allowed if n not in existing_names}
        removed_names = existing_names - allowed
        sibling_auth = _sibling_mcp_auth(server_docs)

        # A shared doc already holds this (server, rpc). Minting a tenant-owned
        # copy here would reassign the identity behind the platform's back and
        # capture its wire — forking is the only sanctioned copy (ADR-0013).
        # Checked per doc, not per server: owning one doc on a shared server id
        # must not re-open shadow-minting for the rest of it.
        shadow_names = new_names_in_json & shared_rpcs_by_server.get(server_id, set())
        if shadow_names:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "mcp_tool_is_shared",
                    "message": (
                        f"MCP server '{server_id}': tool(s) {sorted(shadow_names)} belong to a "
                        f"shared platform server — fork the server to get your own copy instead "
                        f"of adding them in mcp.json."
                    ),
                },
            )

        # Renaming via tools[] (remove old name + add new name in one save) is forbidden.
        if removed_names and new_names_in_json:
            if len(removed_names) == 1 and len(new_names_in_json) == 1:
                old_name = next(iter(removed_names))
                new_name = next(iter(new_names_in_json))
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "mcp_tool_rename_forbidden",
                        "message": (
                            f"MCP server '{server_id}': renaming tools in mcp.json is not supported "
                            f"('{old_name}' -> '{new_name}'). Remove '{old_name}' from tools[] and Save, "
                            f"then add '{new_name}' in a separate step (Discover or save after removal)."
                        ),
                    },
                )
            logger.info(
                "[CONFIG-API] [CURSOR_JSON] server=%s tenant_id=%s tools removed=%s added=%s — "
                "validate new names on server before deleting removed tools",
                server_id,
                tenant_id,
                sorted(removed_names),
                sorted(new_names_in_json),
            )

        if new_names_in_json:
            try:
                discovered = await _discover_tools_from_cursor_server_entry(
                    tenant_id=tenant_id,
                    server_id=server_id,
                    entry=entry,
                    inherited_auth=sibling_auth,
                )
            except HTTPException:
                raise
            except Exception as e:
                runtime = _cursor_entry_to_external_mcp_runtime(entry)
                raise HTTPException(
                    status_code=400,
                    detail=_mcp_discovery_failure_detail(
                        e,
                        network_discovery=_is_network_mode_runtime(runtime),
                        server_id=server_id,
                        context_suffix=(
                            f": cannot add tools {sorted(new_names_in_json)}"
                        ),
                    ),
                ) from e
            discovered_names = {
                str(item.get("name") or "").strip()
                for item in (discovered or [])
                if isinstance(item, dict) and str(item.get("name") or "").strip()
            }
            missing_on_server = new_names_in_json - discovered_names
            if missing_on_server:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "mcp_tool_not_on_server",
                        "message": (
                            f"MCP server '{server_id}': tool(s) {sorted(missing_on_server)} are not "
                            f"returned by list_tools. Save aborted — removed tools were not deleted. "
                            f"Use Discover to import only tools that exist on the server."
                        ),
                    },
                )
            existing_by_name = _index_mcp_docs_by_rpc(server_docs)
            await _upsert_discovered_tool_configs(
                storage=storage,
                tenant_id=tenant_id,
                actor_id=actor_id,
                server_id=server_id,
                entry=entry,
                discovered=discovered if isinstance(discovered, list) else [],
                existing_by_name=existing_by_name,
                desired_enabled=enabled_set if has_tools else None,
                desired_disabled=disabled_set,
                names_filter=new_names_in_json,
                inherited_auth=sibling_auth,
            )

        for d in server_docs:
            from tools.mcp_tool_ids import mcp_rpc_name_from_doc

            rpc_name = mcp_rpc_name_from_doc(d)
            tid = str(d.get("_id") or "").strip()
            if not tid or not rpc_name:
                continue
            if rpc_name not in allowed:
                await delete_tool_document(storage, d)
                continue
            desired_enabled = rpc_name in enabled_set if has_tools else (rpc_name not in disabled_set)
            if bool(d.get("enabled", True)) != desired_enabled:
                d["enabled"] = desired_enabled
                await save_tool_document(storage, d, actor_id=actor_id)


async def _apply_removed_servers_from_cursor_json(
    *,
    storage,
    tenant_id: str,
    actor_id: str | None,
    mcp_servers: dict,
) -> None:
    """Remove servers from DB when they are removed from Cursor JSON."""
    if not isinstance(mcp_servers, dict):
        return
    desired_servers = {
        str(server_id or "").strip()
        for server_id in mcp_servers.keys()
        if str(server_id or "").strip()
    }
    docs = await get_mcp_tool_configurations(
        storage, enabled_only=False, tenant_id=tenant_id,
    )
    existing_by_server: dict[str, list[dict]] = {}
    for d in docs or []:
        if not isinstance(d, dict) or d.get("source") != "mcp_server":
            continue
        # Absence from the tenant's mcp.json means "uninstall" only for docs the
        # tenant owns; a shared __system__ server is not theirs to remove.
        if not _tenant_owns_doc(d, tenant_id):
            continue
        sid = str(d.get("mcp_server") or "").strip()
        if sid:
            existing_by_server.setdefault(sid, []).append(d)
    removed_servers = [sid for sid in existing_by_server.keys() if sid not in desired_servers]
    added_servers = [sid for sid in desired_servers if sid not in existing_by_server]

    # One removed + one added key: migrate only when runtime matches (true rename), else delete+add.
    if len(removed_servers) == 1 and len(added_servers) == 1:
        old_sid = removed_servers[0]
        new_sid = added_servers[0]
        new_entry = mcp_servers.get(new_sid) if isinstance(mcp_servers, dict) else None
        new_entry = new_entry if isinstance(new_entry, dict) else {}
        new_runtime = await derive_zip_runtime_provenance(
            storage,
            tenant_id=tenant_id,
            server_id=new_sid,
            runtime=_cursor_entry_to_external_mcp_runtime(new_entry),
        )
        old_docs = existing_by_server.get(old_sid, [])
        old_runtime = _runtime_from_tool_doc(old_docs[0]) if old_docs else {}
        if _mcp_server_runtime_signature(old_runtime) == _mcp_server_runtime_signature(new_runtime):
            # Cursor JSON never carries `auth` (export omits it), so the cursor-derived runtime
            # would wipe a saved oauth2/bearer block on rename. A true rename is the same server
            # under a new key — carry the stored auth forward. Cursor-expressible fields
            # (headers/timeout) still come from the new entry.
            if old_runtime.get("auth") and "auth" not in new_runtime:
                new_runtime["auth"] = old_runtime["auth"]
            for d in old_docs:
                mcp_name = str(d.get("rpc_name") or d.get("name") or "").strip()
                if not mcp_name:
                    continue
                meta = d.get("metadata") if isinstance(d.get("metadata"), dict) else {}
                d["mcp_server"] = new_sid
                d["metadata"] = {**meta, "external_mcp": new_runtime}
                d["_id"] = await _migrate_mcp_tool_storage_id(
                    storage,
                    tenant_id=tenant_id,
                    server_id=new_sid,
                    tool_name=mcp_name,
                    existing_doc=d,
                )
                _normalize_tool_doc_for_storage(d)
                await save_tool_document(storage, d, actor_id=actor_id)
            logger.info(
                "[CONFIG-API] [CURSOR_JSON] migrated server id tenant_id=%s %s -> %s tools=%d",
                tenant_id,
                old_sid,
                new_sid,
                len(old_docs),
            )
            return
        logger.info(
            "[CONFIG-API] [CURSOR_JSON] server key change is delete+add tenant_id=%s %s -> %s "
            "(runtime differs)",
            tenant_id,
            old_sid,
            new_sid,
        )

    if not removed_servers:
        return

    for sid in removed_servers:
        for d in existing_by_server.get(sid, []):
            if isinstance(d, dict) and d.get("_id"):
                await delete_tool_document(storage, d)
        await _stop_mcp_server_runtime_if_no_tools_remain(
            storage,
            tenant_id=tenant_id,
            mcp_server_id=sid,
            log_ref=f"cursor_json server={sid}",
        )
    logger.info(
        "[CONFIG-API] [CURSOR_JSON] removed servers from JSON tenant_id=%s count=%d servers=%s",
        tenant_id,
        len(removed_servers),
        removed_servers,
    )


async def _sync_tenant_cursor_json_from_tools(
    storage,
    tenant_id: str,
    actor_id: str | None = None,
    *,
    preserve_servers: dict | None = None,
) -> None:
    """Rebuild tenant mcp_cursor_json from current MCP tool configurations."""
    from tools.mcp_tool_ids import mcp_rpc_name_from_doc

    if not tenant_id:
        tenant_id = "__root__"
    if not (hasattr(storage, "get_tool_configurations") and hasattr(storage, "get_tenant_settings") and hasattr(storage, "save_tenant_settings")):
        return
    try:
        current_settings = await storage.get_tenant_settings(tenant_id) or {"_id": tenant_id}
        discover_state = _load_mcp_server_discover_state(
            current_settings if isinstance(current_settings, dict) else {},
        )
        docs = await get_mcp_tool_configurations(
        storage, enabled_only=False, tenant_id=tenant_id,
    )
        servers = {}
        server_enabled_tools: dict[str, set[str]] = {}
        server_disabled_tools: dict[str, set[str]] = {}
        for d in docs or []:
            if not isinstance(d, dict):
                continue
            # Render only owned docs into the tenant's mcp.json: a shared server
            # block would round-trip through the save path as an "added server"
            # and spawn unintended tenant copies via discovery import. Applies to
            # root too — a root re-import mints __root__ duplicates (ADR-0013).
            if not _tenant_owns_doc(d, tenant_id):
                continue
            sid = str(d.get("mcp_server") or "").strip()
            if not sid:
                continue
            tool_name = str(mcp_rpc_name_from_doc(d) or "").strip()
            if tool_name:
                if bool(d.get("enabled", True)):
                    server_enabled_tools.setdefault(sid, set()).add(tool_name)
                else:
                    server_disabled_tools.setdefault(sid, set()).add(tool_name)
            entry = _cursor_json_entry_from_tool(d)
            if not entry:
                continue
            old = servers.get(sid)
            if old is None or _entry_score(entry) >= _entry_score(old):
                servers[sid] = entry
        for sid, entry in servers.items():
            enabled = sorted(server_enabled_tools.get(sid, set()))
            disabled = sorted(server_disabled_tools.get(sid, set()))
            if enabled:
                entry["tools"] = enabled
            if disabled:
                entry["disabledTools"] = disabled
        for sid, entry in (preserve_servers or {}).items():
            if sid in servers or not isinstance(entry, dict):
                continue
            if _discover_state_should_preserve_in_sync(discover_state.get(sid)):
                servers[sid] = entry
        raw = json.dumps({"mcpServers": servers}, ensure_ascii=False, indent=2)
        current = current_settings if isinstance(current_settings, dict) else {"_id": tenant_id}
        current["mcp_cursor_json"] = raw
        await storage.save_tenant_settings(current, actor_id=actor_id)
        logger.info(
            "[CONFIG-API] [CURSOR_JSON] synced from tools tenant_id=%s servers=%d",
            tenant_id,
            len(servers),
        )
    except Exception as e:
        logger.warning(
            "[CONFIG-API] [CURSOR_JSON] sync from tools failed tenant_id=%s: %s",
            tenant_id,
            e,
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _suggest_tool_name(name: str, tenant_id: str) -> str:
    """Return a candidate alternative name by appending / incrementing a numeric suffix.

    Examples:
        "get_field"       -> "get_field_2"
        "get_field_2"     -> "get_field_3"
        "get_field_10"    -> "get_field_11"
    """
    match = re.match(r"^(.*?)_(\d+)$", name)
    if match:
        base, num = match.group(1), int(match.group(2))
        return f"{base}_{num + 1}"
    return f"{name}_2"


def _storage_or_fail():
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")
    return storage


async def _resolve_discovery_default_image(storage) -> str:
    if storage and hasattr(storage, "get_default_external_mcp_image"):
        try:
            image = await storage.get_default_external_mcp_image()
            if isinstance(image, str) and image.strip():
                resolved = image.strip()
                logger.info("[EXTERNAL_MCP] discovery resolved image from MongoDB: %s", resolved)
                return resolved
        except Exception as exc:
            logger.warning("[EXTERNAL_MCP] discovery failed to read default image from MongoDB: %s", exc)
    logger.warning(
        "[EXTERNAL_MCP] discovery MongoDB default image missing, using code fallback: %s",
        DEFAULT_EXTERNAL_MCP_IMAGE,
    )
    return DEFAULT_EXTERNAL_MCP_IMAGE


async def _reload_tool_registry():
    """Reload tool registry from DB after a tool config change."""
    orchestrator = get_orchestrator()
    if not orchestrator or not orchestrator.tool_registry:
        return
    storage = get_storage()
    if not storage:
        return
    try:
        await orchestrator.tool_registry.load_from_db(storage)
        logger.info("[CONFIG-API] Tool registry reloaded (%d tools)",
                    len(orchestrator.tool_registry.tools))
    except Exception as e:
        logger.error("[CONFIG-API] Failed to reload tool registry: %s", e)


_MCP_DISCOVERY_VALIDATION_PREFIX = "MCP discovery failed"
_MCP_DISCOVERY_UNREACHABLE_DETAIL = (
    f"{_MCP_DISCOVERY_VALIDATION_PREFIX}: endpoint is unreachable or denied"
)


def _is_network_mode_discovery(body: MCPServerDiscoverRequest) -> bool:
    mode = (body.mode or "").strip().lower()
    if mode in ("http", "streamable-http"):
        return True
    if mode == "stdio":
        return False
    parsed = urlparse(body.endpoint or "")
    return parsed.scheme in ("http", "https")


def _is_network_mode_runtime(runtime: dict) -> bool:
    """True when cursor-json / runtime dict uses remote HTTP(S) discovery (not stdio/docker)."""
    if not isinstance(runtime, dict):
        return False
    if str(runtime.get("image") or "").strip() or str(runtime.get("command") or "").strip():
        return False
    mode = str(runtime.get("mode") or "").strip().lower()
    if mode in ("http", "streamable-http"):
        return True
    endpoint = str(runtime.get("endpoint") or "").strip()
    if endpoint:
        parsed = urlparse(endpoint)
        return parsed.scheme in ("http", "https")
    return False


def _is_remote_runtime_discovery(body: MCPServerDiscoverRequest) -> bool:
    endpoint = (body.endpoint or "").strip()
    parsed = urlparse(endpoint) if endpoint else None
    has_remote_endpoint = bool(parsed and parsed.scheme in ("http", "https"))
    image = (body.image or "").strip()
    return has_remote_endpoint and not image


async def _validate_http_endpoint_or_raise(endpoint: str) -> None:
    """SSRF guard for remote HTTP(S) MCP discovery (discover API and cursor-json import)."""
    ep = str(endpoint or "").strip()
    if not ep:
        raise HTTPException(
            status_code=400,
            detail=f"{_MCP_DISCOVERY_VALIDATION_PREFIX}: endpoint is required",
        )

    parsed = urlparse(ep)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(
            status_code=400,
            detail=f"{_MCP_DISCOVERY_VALIDATION_PREFIX}: only http/https endpoints are allowed",
        )
    if not parsed.hostname:
        raise HTTPException(
            status_code=400,
            detail=f"{_MCP_DISCOVERY_VALIDATION_PREFIX}: invalid endpoint host",
        )

    host = parsed.hostname.strip().lower()
    if is_blocked_mcp_hostname(host):
        raise HTTPException(
            status_code=400,
            detail=f"{_MCP_DISCOVERY_VALIDATION_PREFIX}: endpoint host is not allowed",
        )
    if not is_allowlisted_mcp_hostname(host, allowlist=_get_endpoint_allowlist()):
        raise HTTPException(
            status_code=400,
            detail=f"{_MCP_DISCOVERY_VALIDATION_PREFIX}: endpoint host is not in allowlist",
        )

    try:
        infos = await asyncio.get_running_loop().getaddrinfo(
            host,
            parsed.port or (443 if parsed.scheme == "https" else 80),
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror:
        return
    except Exception as exc:
        logger.warning("[EXTERNAL_MCP] endpoint DNS resolution warning host=%s error=%s", host, exc)
        return

    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        ip_candidate = sockaddr[0]
        if is_blocked_resolved_mcp_ip(ip_candidate):
            raise HTTPException(
                status_code=400,
                detail=f"{_MCP_DISCOVERY_VALIDATION_PREFIX}: endpoint host is not allowed",
            )


async def _validate_mcp_entry_runtime_or_raise(runtime: dict) -> None:
    """Validate ``metadata.external_mcp`` / cursor-json runtime before ``ExternalMCPClient``."""
    if not _is_network_mode_runtime(runtime):
        return
    await _validate_http_endpoint_or_raise(str(runtime.get("endpoint") or ""))


async def _validate_discovery_endpoint_or_raise(body: MCPServerDiscoverRequest) -> None:
    if not _is_network_mode_discovery(body):
        return
    await _validate_http_endpoint_or_raise((body.endpoint or "").strip())


def _mcp_discovery_failure_detail(
    exc: BaseException,
    *,
    network_discovery: bool,
    server_id: str | None = None,
    context_suffix: str = "",
) -> str:
    """Map discovery errors; hide upstream status/IP details for HTTP discovery."""
    if isinstance(exc, HTTPException):
        detail = exc.detail
        message = detail if isinstance(detail, str) else str(detail)
    elif network_discovery:
        message = _MCP_DISCOVERY_UNREACHABLE_DETAIL
    else:
        message = f"{_MCP_DISCOVERY_VALIDATION_PREFIX}: {format_mcp_user_message(exc)}"
    if server_id and context_suffix:
        return f"MCP server '{server_id}'{context_suffix}: {message}"
    if server_id:
        return f"MCP server '{server_id}' import failed: {message}"
    return message


def _get_endpoint_allowlist() -> List[str]:
    # Optional override: EXTERNAL_MCP_ENDPOINT_ALLOWLIST="a.example.com,b.example.com"
    raw = os.environ.get("EXTERNAL_MCP_ENDPOINT_ALLOWLIST", "")
    if raw.strip():
        return [p.strip() for p in raw.split(",") if p.strip()]
    # By default we allow public hosts and rely on explicit blocklist checks above.
    return []


# ---------------------------------------------------------------------------
# MCP TOOLS API (/api/configurations/mcp-tools)
# ---------------------------------------------------------------------------

MCP_TOOL_LIST_UNASSIGNED_SERVER = "__unassigned__"


def _mcp_tool_list_wire_id(item: dict) -> str:
    return str(item.get("id") or item.get("_id") or "")


def _mcp_tool_list_search_blob(item: dict) -> str:
    parts: list[Any] = [
        item.get("id") or item.get("_id"),
        item.get("name"),
        item.get("rpc_name"),
        item.get("description"),
        item.get("category"),
        item.get("mcp_server"),
    ]
    return " ".join(str(p or "") for p in parts).lower()


def _mcp_tool_matches_list_query(item: dict, q: str) -> bool:
    needle = q.strip().lower()
    if not needle:
        return True
    return needle in _mcp_tool_list_search_blob(item)


def _mcp_tool_list_sort_key(item: dict) -> tuple:
    wire_id = _mcp_tool_list_wire_id(item)
    return ((item.get("name") or wire_id).lower(), wire_id)


def _mcp_tool_list_enabled(item: dict) -> bool:
    """Match ToolConfigurationResponse.enabled coercion for list filters."""
    return ToolConfigurationResponse.model_validate(item).enabled


def _group_mcp_tools_for_list(items: list[dict]) -> list[McpToolGroupResponse]:
    # ponytail: in-memory groupby; upgrade path — aggregate in Mongo when catalog grows
    buckets: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        server = str(item.get("mcp_server") or "").strip() or MCP_TOOL_LIST_UNASSIGNED_SERVER
        buckets[server].append(item)
    groups: list[McpToolGroupResponse] = []
    for server in sorted(buckets.keys(), key=str.lower):
        tools = sorted(buckets[server], key=_mcp_tool_list_sort_key)
        groups.append(
            McpToolGroupResponse(
                id=server,
                label=server,
                tools_count=len(tools),
                tools=[ToolConfigurationResponse.model_validate(t) for t in tools],
            )
        )
    return groups


@mcp_router.get(
    "/",
    response_model=Union[List[McpToolGroupResponse], List[ToolConfigurationResponse]],
)
async def list_mcp_tool_configurations(
    enabled_only: bool = False,
    enabled: Optional[bool] = Query(None),
    server: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    grouped: bool = False,
    ctx: TenantContext = Depends(get_tenant_context),
):
    if enabled is False and enabled_only:
        raise HTTPException(
            status_code=400,
            detail="enabled=false requires enabled_only=false",
        )
    storage = _storage_or_fail()
    tid = None if ctx.is_root else ctx.tenant_id
    configs = await get_mcp_tool_configurations(
        # Tenant scope always fetches unfiltered: a DISABLED fork must still
        # shadow the shared row in enabled-only listings, so the shadow keys
        # need the full owned set; the enabled filter is re-applied below.
        storage, enabled_only=False if tid else enabled_only, tenant_id=tid,
    )
    if tid:
        from config.tool_configuration_schema import (
            drop_disabled_effective_docs,
            drop_system_docs_shadowed_by_owned,
        )

        # A tenant fork shadows the shared doc by (server, name) (ADR-0013): show
        # the tenant's copy, not both rows. Shadow before dropping disabled, or a
        # disabled fork stops shadowing and its still-enabled twin resurfaces.
        configs = drop_system_docs_shadowed_by_owned(configs)
        if enabled_only:
            configs = drop_disabled_effective_docs(configs)
    items = [_tool_doc_for_api_response(d) for d in configs if isinstance(d, dict)]
    if enabled is not None:
        items = [item for item in items if _mcp_tool_list_enabled(item) == enabled]
    if server:
        server_key = server.strip()
        items = [
            item for item in items
            if str(item.get("mcp_server") or "").strip() == server_key
        ]
    if q:
        items = [item for item in items if _mcp_tool_matches_list_query(item, q)]
    if grouped:
        return _group_mcp_tools_for_list(items)
    return [ToolConfigurationResponse.model_validate(item) for item in items]


@mcp_router.get("/{tool_id}", response_model=ToolConfigurationResponse)
async def get_mcp_tool_configuration_route(
    tool_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
):
    storage = _storage_or_fail()
    doc = await _get_mcp_tool_doc_for_request(storage, ctx, tool_id)
    if not doc:
        raise HTTPException(status_code=404, detail=f"MCP tool '{tool_id}' not found")
    return _tool_doc_for_api_response(doc)


@mcp_router.post("/", response_model=ToolConfigurationResponse, status_code=201)
async def create_mcp_tool_configuration(
    body: ToolConfigurationCreate,
    ctx: TenantContext = Depends(get_tenant_context),
):
    storage = _storage_or_fail()
    effective_tenant = ctx.tenant_id or "__root__"

    server_id = str(body.mcp_server or "").strip()
    mcp_name = str(body.name or "").strip()
    if not server_id or not mcp_name:
        raise HTTPException(
            status_code=400,
            detail="MCP server tools require non-empty mcp_server and name",
        )
    server_id, mcp_name = _require_valid_mcp_server_and_name(server_id, mcp_name)
    submitted_rpc = str(body.rpc_name or "").strip()
    # Document identity is the rpc (tools/call contract), not the wire `name`:
    # keying these guards on `name` let two docs share one
    # (tenant_id, mcp_server, rpc_name) triple, which the unique Mongo index
    # rejects with an unhandled DuplicateKeyError (HTTP 500).
    effective_rpc = mcp_name
    if submitted_rpc:
        _, effective_rpc = _require_valid_mcp_server_and_name(server_id, submitted_rpc)
    if is_mcp_internal_tool_name(mcp_name) or is_mcp_internal_tool_name(effective_rpc):
        raise HTTPException(
            status_code=400,
            detail="Reserved MCP tool name; __package__ and __image__* are system-only",
        )
    public_id = mcp_public_tool_id(server_id, effective_rpc)
    storage_id = mcp_tool_document_id(effective_tenant, server_id, effective_rpc)

    getter = getattr(storage, "get_mcp_tool_configuration", storage.get_tool_configuration)
    existing_by_id = await getter(storage_id)
    if not existing_by_id:
        existing_by_id = await resolve_mcp_tool_doc(storage, effective_tenant, public_id)
    if existing_by_id:
        raise HTTPException(status_code=409, detail=f"Tool '{public_id}' already exists")

    # Unfiltered across {tenant, __system__} on purpose: manually shadowing a
    # shared tool is blocked here, forking is the sanctioned path (ADR-0013).
    name_conflicts = await find_tools_by_name(
        storage,
        effective_rpc,
        effective_tenant,
        mcp=True,
        mcp_server=server_id,
    )
    if name_conflicts:
        suggestion = _suggest_tool_name(effective_rpc, effective_tenant)
        raise HTTPException(
            status_code=409,
            detail={
                "code": "name_conflict",
                "message": (
                    f"A tool named '{effective_rpc}' already exists on MCP server "
                    f"'{server_id}' in tenant '{effective_tenant}'."
                ),
                "existing_id": name_conflicts[0].get("_id"),
                "suggested_name": suggestion,
            },
        )

    payload = body.model_dump(exclude={"id"}, exclude_none=True)
    payload["source"] = "mcp_server"
    doc = {"_id": storage_id, **payload}
    _normalize_tool_doc_for_storage(doc)
    if not ctx.is_root:
        doc["tenant_id"] = effective_tenant
    else:
        doc.setdefault("tenant_id", effective_tenant)
    doc["metadata"] = await _metadata_with_derived_zip_provenance(
        storage,
        tenant_id=str(doc["tenant_id"]),
        server_id=server_id,
        metadata=doc.get("metadata"),
    )
    _validate_external_mcp_auth_or_400(doc["metadata"])
    _validate_external_mcp_timeout_or_400(
        doc["metadata"],
        await _tenant_mcp_call_timeout_ceiling(storage, str(doc["tenant_id"])),
    )
    _inherit_missing_external_mcp_auth(
        doc["metadata"],
        await _stored_server_auth(storage, tenant_id=str(doc["tenant_id"]), server_id=server_id),
    )
    doc["_id"] = await _migrate_mcp_tool_storage_id(
        storage,
        tenant_id=doc.get("tenant_id") or effective_tenant,
        server_id=str(doc.get("mcp_server") or ""),
        tool_name=effective_rpc,
        existing_doc=None,
    )
    if submitted_rpc:
        # An explicit rpc_name means the caller owns both identities, so `name`
        # is the verbatim wire — same contract as PUT. Without rpc_name (legacy
        # Postman/script payloads) `name` IS the rpc and the wire is generated.
        wire = _validate_mcp_wire_name_field(mcp_name)
        await _ensure_mcp_wire_name_available(
            storage,
            str(doc.get("tenant_id") or effective_tenant),
            wire,
            exclude_storage_id=str(doc["_id"]),
            claimant_identity=(server_id, effective_rpc),
        )
        doc["name"] = wire
        doc["rpc_name"] = effective_rpc
    else:
        await _assign_mcp_wire_name(
            doc,
            storage,
            preserve_existing=False,
            exclude_storage_id=str(doc["_id"]),
        )
    _finalize_mcp_doc_for_storage(doc)
    sync_entity_descriptions_for_save(doc)
    await save_tool_document(storage, doc, actor_id=ctx.user_id)
    await _reload_tool_registry()
    await _sync_tenant_cursor_json_from_tools(
        storage=storage,
        tenant_id=doc.get("tenant_id") or effective_tenant,
        actor_id=ctx.user_id,
    )
    logger.info("[CONFIG-API] Created MCP tool '%s' (tenant=%s)", public_id, ctx.tenant_id)
    return _tool_doc_for_api_response(doc)


@mcp_router.post("/batch", response_model=MCPToolsBatchCreateResponse, status_code=201)
async def create_mcp_tools_batch(
    body: MCPToolsBatchCreate,
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Create several MCP tools for one server — all-or-nothing, one registry reload."""
    storage = _storage_or_fail()
    effective_tenant = ctx.tenant_id or "__root__"
    server_id = str(body.mcp_server or "").strip()
    if not server_id:
        raise HTTPException(status_code=400, detail="mcp_server is required")
    server_id, _ = _require_valid_mcp_server_and_name(server_id, "placeholder")

    conflicts: list[dict] = []
    seen_public: set[str] = set()
    seen_rpc: set[str] = set()
    prepared: list[dict] = []
    batch_wires: set[str] = set()

    getter = getattr(storage, "get_mcp_tool_configuration", storage.get_tool_configuration)
    shared_metadata = await _metadata_with_derived_zip_provenance(
        storage,
        tenant_id=effective_tenant,
        server_id=server_id,
        metadata=body.metadata,
    )
    _validate_external_mcp_auth_or_400(shared_metadata)
    _validate_external_mcp_timeout_or_400(
        shared_metadata,
        await _tenant_mcp_call_timeout_ceiling(storage, effective_tenant),
    )
    _inherit_missing_external_mcp_auth(
        shared_metadata,
        await _stored_server_auth(storage, tenant_id=effective_tenant, server_id=server_id),
    )

    for item in body.tools:
        public_id = str(item.id or "").strip()
        mcp_name = str(item.name or "").strip()
        if not public_id or not mcp_name:
            raise HTTPException(
                status_code=400,
                detail="Each batch tool requires non-empty id and name",
            )
        server_id, mcp_name = _require_valid_mcp_server_and_name(server_id, mcp_name)
        if is_mcp_internal_tool_name(mcp_name):
            raise HTTPException(
                status_code=400,
                detail="Reserved MCP tool name; __package__ and __image__* are system-only",
            )
        expected_public = mcp_public_tool_id(server_id, mcp_name)
        if public_id != expected_public:
            # Allow frontend-submitted id when it matches canonical public id.
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Tool id '{public_id}' does not match mcp_server+name "
                    f"(expected '{expected_public}')"
                ),
            )
        if public_id in seen_public:
            conflicts.append(
                {"id": public_id, "name": mcp_name, "reason": "duplicate_id_in_request"}
            )
            continue
        if mcp_name in seen_rpc:
            conflicts.append(
                {"id": public_id, "name": mcp_name, "reason": "duplicate_name_in_request"}
            )
            continue
        seen_public.add(public_id)
        seen_rpc.add(mcp_name)

        storage_id = mcp_tool_document_id(effective_tenant, server_id, mcp_name)
        existing_by_id = await getter(storage_id)
        if not existing_by_id:
            existing_by_id = await resolve_mcp_tool_doc(storage, effective_tenant, public_id)
        if existing_by_id and _batch_conflict_doc_for_tenant(existing_by_id, effective_tenant):
            conflicts.append({"id": public_id, "name": mcp_name, "reason": "id_conflict"})
            continue

        name_conflicts = await find_tools_by_name(
            storage,
            mcp_name,
            effective_tenant,
            mcp=True,
            mcp_server=server_id,
        )
        if name_conflicts:
            conflicts.append({"id": public_id, "name": mcp_name, "reason": "name_conflict"})
            continue
        # Intra-batch: rpc shares the wire namespace (finder $or name/rpc_name).
        if mcp_name in batch_wires:
            conflicts.append(
                {"id": public_id, "name": mcp_name, "reason": "duplicate_name_in_request"}
            )
            continue

        doc = {
            "_id": storage_id,
            "name": mcp_name,
            "description": str(item.description or ""),
            "category": "mcp",
            "source": "mcp_server",
            "schema": item.tool_schema,
            "mcp_server": server_id,
            "metadata": copy.deepcopy(shared_metadata),
            "enabled": True,
        }
        _normalize_tool_doc_for_storage(doc)
        if not ctx.is_root:
            doc["tenant_id"] = effective_tenant
        else:
            doc.setdefault("tenant_id", effective_tenant)
        # Insert-only: opaque id is minted below; no legacy-id migrate on create.
        await _assign_mcp_wire_name(
            doc,
            storage,
            preserve_existing=False,
            exclude_storage_id=str(doc["_id"]),
            extra_existing_names=batch_wires,
        )
        wire = str(doc.get("name") or "").strip()
        # Own rpc is already in seen_rpc; wire==rpc is not an intra-batch duplicate.
        if wire and wire != mcp_name and wire in seen_rpc:
            conflicts.append(
                {"id": public_id, "name": mcp_name, "reason": "duplicate_name_in_request"}
            )
            continue
        if wire:
            batch_wires.add(wire)
        _finalize_mcp_doc_for_storage(doc)
        sync_entity_descriptions_for_save(doc)
        prepared.append(doc)

    if conflicts:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "mcp_tools_conflict",
                "message": "Some MCP tools already exist or conflict in the request",
                "conflicts": conflicts,
            },
        )

    from config.configuration_resolution import (
        is_opaque_storage_id,
        mint_configuration_storage_id,
    )
    from tools.mcp_tool_ids import mcp_rpc_name_from_doc

    async def _rollback_batch_inserts(inserts: list[dict]) -> list[str]:
        """Delete batch-owned inserts. Returns storage ids that could not be removed."""
        leftover: list[str] = []
        for partial in inserts:
            doc_id = str((partial or {}).get("_id") or "").strip()
            if not doc_id:
                continue
            deleted = False
            last_err: Exception | None = None
            for _attempt in range(2):
                try:
                    await delete_tool_document(storage, partial)
                    still = await getter(doc_id) if callable(getter) else None
                    if still is None:
                        deleted = True
                        break
                except Exception as exc:
                    last_err = exc
                    logger.warning(
                        "[CONFIG-API] batch create rollback failed id=%s attempt=%s",
                        doc_id,
                        _attempt + 1,
                        exc_info=True,
                    )
            if not deleted:
                leftover.append(doc_id)
                if last_err is None:
                    logger.warning(
                        "[CONFIG-API] batch create rollback left doc id=%s",
                        doc_id,
                    )
        return leftover

    def _raise_after_rollback(
        leftover: list[str],
        *,
        conflict_detail: dict | None = None,
    ) -> None:
        if leftover:
            raise HTTPException(
                status_code=500,
                detail={
                    "code": "mcp_tools_batch_partial_rollback_failed",
                    "message": (
                        "Batch create failed and compensatory rollback could not "
                        "remove all inserted tools"
                    ),
                    "remaining_ids": leftover,
                },
            )
        if conflict_detail is not None:
            raise HTTPException(status_code=409, detail=conflict_detail)
        raise HTTPException(
            status_code=500,
            detail={
                "code": "mcp_tools_batch_save_failed",
                "message": "Batch create failed; no tools were kept",
            },
        )

    # Claim opaque storage ids up front so a post-save id mismatch means
    # upsert attached to a concurrent row (do not delete that row).
    for doc in prepared:
        if not is_opaque_storage_id(str(doc.get("_id") or "")):
            doc["_id"] = mint_configuration_storage_id()

    created: list[dict] = []
    try:
        for doc in prepared:
            wire = str(doc.get("name") or "").strip()
            rpc = str(doc.get("rpc_name") or "").strip() or mcp_rpc_name_from_doc(doc)
            public_id = mcp_public_tool_id(server_id, rpc)
            claimed_id = str(doc.get("_id") or "").strip()

            # Narrow TOCTOU: refuse alias twins (__root__/__default__) too — same as POST /.
            prior = await _batch_find_wire_blocking_insert(storage, effective_tenant, wire)
            if prior:
                leftover = await _rollback_batch_inserts(created)
                _raise_after_rollback(
                    leftover,
                    conflict_detail={
                        "code": "mcp_tools_conflict",
                        "message": "Some MCP tools already exist or conflict in the request",
                        "conflicts": [
                            {"id": public_id, "name": rpc, "reason": "id_conflict"}
                        ],
                    },
                )
            name_hits = await find_tools_by_name(
                storage,
                rpc,
                effective_tenant,
                mcp=True,
                mcp_server=server_id,
            )
            if name_hits:
                leftover = await _rollback_batch_inserts(created)
                _raise_after_rollback(
                    leftover,
                    conflict_detail={
                        "code": "mcp_tools_conflict",
                        "message": "Some MCP tools already exist or conflict in the request",
                        "conflicts": [
                            {"id": public_id, "name": rpc, "reason": "name_conflict"}
                        ],
                    },
                )

            saved = await insert_mcp_tool_document(storage, doc, actor_id=ctx.user_id)
            landed_id = str((saved or {}).get("_id") or "").strip()
            # Track by claimed_id so rollback deletes the row we inserted even if
            # the returned dict was rewritten/mismatched before append.
            owned = dict(saved) if isinstance(saved, dict) else {}
            owned["_id"] = claimed_id
            created.append(owned)
            if landed_id != claimed_id:
                leftover = await _rollback_batch_inserts(created)
                _raise_after_rollback(
                    leftover,
                    conflict_detail={
                        "code": "mcp_tools_conflict",
                        "message": "Some MCP tools already exist or conflict in the request",
                        "conflicts": [
                            {"id": public_id, "name": rpc, "reason": "id_conflict"}
                        ],
                    },
                )
    except HTTPException:
        raise
    except McpToolInsertConflict as exc:
        leftover = await _rollback_batch_inserts(created)
        reason = str(exc.reason or "id_conflict")
        _raise_after_rollback(
            leftover,
            conflict_detail={
                "code": "mcp_tools_conflict",
                "message": "Some MCP tools already exist or conflict in the request",
                "conflicts": [
                    {
                        "id": getattr(exc, "public_id", None) or "",
                        "name": getattr(exc, "rpc_name", None) or "",
                        "reason": reason,
                    }
                ],
            },
        )
    except Exception:
        leftover = await _rollback_batch_inserts(created)
        _raise_after_rollback(leftover)

    await _reload_tool_registry()
    await _sync_tenant_cursor_json_from_tools(
        storage=storage,
        tenant_id=effective_tenant,
        actor_id=ctx.user_id,
    )
    logger.info(
        "[CONFIG-API] Batch created MCP tools count=%s server=%s tenant=%s",
        len(created),
        server_id,
        effective_tenant,
    )
    return MCPToolsBatchCreateResponse(
        created_count=len(created),
        tools=[_tool_doc_for_api_response(d) for d in created],
    )


@mcp_router.put("/{tool_id}", response_model=ToolConfigurationResponse)
async def update_mcp_tool_configuration(
    tool_id: str,
    body: ToolConfigurationUpdate,
    ctx: TenantContext = Depends(get_tenant_context),
):
    storage = _storage_or_fail()

    existing = await _get_mcp_tool_doc_for_request(storage, ctx, tool_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"MCP tool '{tool_id}' not found")

    if not ctx.is_root and existing.get("tenant_id") not in (ctx.tenant_id, None):
        if str(existing.get("tenant_id") or "") == "__system__":
            # ADR-0013: tenants never edit the shared doc — they fork the whole
            # server behind an explicit confirm. The payload feeds that dialog.
            server_id = str(existing.get("mcp_server") or "").strip()
            server_tools = await _system_server_tool_docs(storage, server_id)
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "fork_required",
                    "message": (
                        f"'{tool_id}' belongs to shared MCP server '{server_id}'. "
                        f"Editing it creates your tenant's copy of the whole server "
                        f"({len(server_tools)} tools); platform updates and key "
                        "rotations will no longer apply to the copy."
                    ),
                    "server_id": server_id,
                    "tool_count": len(server_tools),
                },
            )
        raise HTTPException(status_code=403, detail="Cannot modify config from another tenant")

    updates = body.model_dump(exclude_unset=True, exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    # The UI modal round-trips `name` (the wire name — API responses expose it as
    # `name`) unchanged on every save. An unchanged name is not an rpc rename:
    # feeding it into the rename branch below rewrites rpc_name with the wire and
    # regenerates the wire from it.
    if (
        str(updates.get("name") or "").strip()
        == str(existing.get("name") or "").strip()
    ):
        updates.pop("name", None)
    # Same trap for the modal's rpc_name box: an unchanged value is not a rename,
    # and treating it as one regenerates the wire off the allow-list ref.
    if (
        "rpc_name" in updates
        and str(updates.get("rpc_name") or "").strip()
        == str(mcp_rpc_name_from_doc(existing) or "").strip()
    ):
        updates.pop("rpc_name", None)

    merged = {**existing, **updates}
    merged["source"] = "mcp_server"
    # Contract 1 parity with create: a PUT can carry a new external_mcp.auth block, so reject a
    # bad one here too. Runs before the re-keying migration below, which deletes the old doc: a
    # 400 after that would destroy the doc the request was refused. Auth lives outside
    # zip-provenance, so the raw merged metadata is equivalent to the post-derivation copy here.
    if "metadata" in updates:
        # Restore before comparing/validating: a round-tripped masked secret ("abcd***wxyz")
        # means "keep the stored value", so it must not be validated or written as the mask.
        _restore_masked_external_mcp_auth(merged.get("metadata"), existing.get("metadata"))
        # Validate only a genuinely CHANGED auth block. The edit modal always resends metadata,
        # so gating on "metadata sent" would re-reject an unchanged stored auth whose env secret
        # drifted unset on an edit that never touched auth. Compared after restore so a masked
        # round-trip reads as unchanged.
        if _auth_from_metadata(merged.get("metadata")) != _auth_from_metadata(existing.get("metadata")):
            _validate_external_mcp_auth_or_400(merged.get("metadata"))
        # Validate the timeout only when it actually CHANGED (parity with the auth gate
        # above): the edit modal resends the whole metadata block, so an unconditional check
        # would 400 an edit that never touched the timeout after the ceiling dropped below it.
        if _external_mcp_timeout_from_metadata(merged.get("metadata")) != _external_mcp_timeout_from_metadata(
            existing.get("metadata")
        ):
            _validate_external_mcp_timeout_or_400(
                merged.get("metadata"),
                await _tenant_mcp_call_timeout_ceiling(
                    storage,
                    str(merged.get("tenant_id") or existing.get("tenant_id") or ctx.tenant_id or "__root__"),
                ),
            )
    server_id = str(merged.get("mcp_server") or "").strip()
    tenant_for_id = str(merged.get("tenant_id") or ctx.tenant_id or "__root__")
    existing_id = str(existing.get("_id") or "")
    mcp_name = str(merged.get("name") or "").strip()
    if server_id and mcp_name:
        server_id, mcp_name = _require_valid_mcp_server_and_name(server_id, mcp_name)
        if is_mcp_internal_tool_name(mcp_name):
            raise HTTPException(
                status_code=400,
                detail="Reserved MCP tool name; __package__ and __image__* are system-only",
            )
        merged["mcp_server"] = server_id
        merged["name"] = mcp_name
        if "name" in updates:
            # A submitted `name` renames the WIRE only. Deriving rpc_name from it
            # and regenerating the wire off that discarded the tools/call contract
            # and stored a name the user never typed; rpc_name is its own input.
            merged.pop("llm_function_name", None)
        wire_finder = getattr(storage, "find_mcp_tool_configuration_by_wire_name", None)
        if callable(wire_finder):
            by_wire = await wire_finder(tenant_for_id, mcp_name)
            if isinstance(by_wire, dict) and str(by_wire.get("_id") or "") != existing_id:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "name_conflict",
                        "message": (
                            f"A tool named '{mcp_name}' already exists on MCP server "
                            f"'{server_id}' in tenant '{tenant_for_id}'."
                        ),
                    },
                )
        conflict_rpc = str(
            merged.get("rpc_name") or mcp_rpc_name_from_doc(merged) or mcp_name
        )
        name_conflicts = await find_tools_by_name(
            storage,
            conflict_rpc,
            tenant_for_id,
            mcp=True,
            mcp_server=server_id,
        )
        # The lookup spans {tenant, __system__}; a tenant fork shadowing the shared
        # doc is a legitimate state (ADR-0013), so shared docs are skipped — but
        # only while this edit keeps the identity it already had. A PUT that MOVES
        # a doc onto a shared (mcp_server, rpc_name) is minting that shadow by
        # hand, which create refuses, so it is refused here too: otherwise the
        # wire carve-out below reads the adopted identity back out of this very
        # request and hands over the shared wire.
        keeps_identity = _mcp_doc_identity(merged) == _mcp_doc_identity(existing)
        if any(
            str(c.get("_id") or "") != existing_id
            and (_tenant_owns_doc(c, tenant_for_id) or not keeps_identity)
            for c in name_conflicts
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "name_conflict",
                    # Names the rpc, not the wire: this lookup is keyed on the
                    # upstream tool name, so reporting the wire pointed the user
                    # at a field that was not the problem.
                    "message": (
                        f"A tool named '{conflict_rpc}' already exists on MCP server "
                        f"'{server_id}' in tenant '{tenant_for_id}'."
                    ),
                },
            )
    if "name" in updates and updates.get("name"):
        wire = _validate_mcp_wire_name_field(str(updates["name"]))
        await _ensure_mcp_wire_name_available(
            storage,
            str(tenant_for_id),
            wire,
            exclude_storage_id=str(merged.get("_id") or existing_id),
            claimant_identity=_mcp_doc_identity(merged),
        )
        merged["name"] = wire
    elif "name" not in updates and server_id and (
        server_id != str(existing.get("mcp_server") or "").strip()
        # Regenerate only when the RPC identity changed. `mcp_name` here is the
        # WIRE name (merged `name`), which differs from the rpc name on every
        # path-A doc — comparing it against the rpc regenerated the wire on
        # every non-name edit (renaming forks away from their allow-list refs).
        or str(mcp_rpc_name_from_doc(merged) or "").strip()
        != str(mcp_rpc_name_from_doc(existing) or "").strip()
    ):
        await _assign_mcp_wire_name(
            merged,
            storage,
            preserve_existing=False,
            exclude_storage_id=str(merged.get("_id") or existing_id),
        )
    else:
        from config.configuration_resolution import is_wire_configuration_name

        if not is_wire_configuration_name(str(merged.get("name") or "")):
            await _assign_mcp_wire_name(
                merged,
                storage,
                preserve_existing=True,
                exclude_storage_id=str(merged.get("_id") or existing_id),
            )
    if server_id and mcp_name:
        # Runs after every raising check above: re-keying deletes the old doc
        # when its _id is a legacy deterministic one, so a later 4xx would
        # destroy the doc the request was refused permission to change.
        merged["_id"] = await _migrate_mcp_tool_storage_id(
            storage,
            tenant_id=tenant_for_id,
            server_id=server_id,
            tool_name=str(merged.get("rpc_name") or mcp_rpc_name_from_doc(merged) or mcp_name),
            existing_doc=existing,
        )
    merged["metadata"] = await _metadata_with_derived_zip_provenance(
        storage,
        tenant_id=tenant_for_id,
        server_id=server_id,
        metadata=merged.get("metadata"),
    )
    _finalize_mcp_doc_for_storage(merged)
    _normalize_tool_doc_for_storage(merged)
    if ENTITY_DESCRIPTION_FIELDS & updates.keys():
        sync_entity_descriptions_for_save(
            merged,
            touched=ENTITY_DESCRIPTION_FIELDS & frozenset(updates.keys()),
            prior=existing,
        )
    await save_tool_document(storage, merged, actor_id=ctx.user_id)
    await _reload_tool_registry()
    await _sync_tenant_cursor_json_from_tools(
        storage=storage,
        tenant_id=merged.get("tenant_id") or existing.get("tenant_id") or (ctx.tenant_id or "__root__"),
        actor_id=ctx.user_id,
    )
    logger.info("[CONFIG-API] Updated MCP tool '%s' fields=%s", tool_id, list(updates.keys()))
    return _tool_doc_for_api_response(merged)


@mcp_router.delete("/{tool_id}", status_code=204)
async def delete_mcp_tool_configuration_route(
    tool_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
):
    storage = _storage_or_fail()

    existing = await _get_mcp_tool_doc_for_request(storage, ctx, tool_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"MCP tool '{tool_id}' not found")
    if not ctx.is_root and existing.get("tenant_id") not in (ctx.tenant_id, None):
        raise HTTPException(status_code=403, detail="Cannot delete config from another tenant")

    mcp_server_id = existing.get("mcp_server")
    tenant_for_mcp = existing.get("tenant_id") or ctx.tenant_id or "__root__"

    await delete_tool_document(storage, existing)
    await _reload_tool_registry()
    if mcp_server_id:
        await _sync_tenant_cursor_json_from_tools(
            storage=storage,
            tenant_id=tenant_for_mcp,
            actor_id=ctx.user_id,
        )
        logger.info(
            "[CONFIG-API] [MCP_DELETE] tool_id=%s tenant_id=%s mcp_server_id=%s",
            tool_id,
            tenant_for_mcp,
            mcp_server_id,
        )
        await _stop_mcp_server_runtime_if_no_tools_remain(
            storage,
            tenant_id=tenant_for_mcp,
            mcp_server_id=mcp_server_id,
            log_ref=f"tool_id={tool_id}",
        )


async def _system_server_tool_docs(storage, server_id: str) -> list[dict]:
    """All user-facing tool docs owned by ``__system__`` on one shared server."""
    sid = str(server_id or "").strip()
    lister = getattr(storage, "get_mcp_tool_configurations", None)
    if not sid or not callable(lister):
        return []
    docs = await lister(enabled_only=False, tenant_id="__system__")
    out: list[dict] = []
    for doc in docs or []:
        if not isinstance(doc, dict):
            continue
        # The inheritance listing scope also returns legacy no-tenant rows.
        if str(doc.get("tenant_id") or "") != "__system__":
            continue
        if str(doc.get("mcp_server") or "").strip() != sid:
            continue
        if doc.get("source") != "mcp_server":
            continue
        out.append(doc)
    return out


@mcp_router.post(
    "/mcp-servers/{server_id}/fork",
    response_model=List[ToolConfigurationResponse],
)
async def fork_shared_mcp_server(
    server_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Copy a shared (__system__) MCP server's whole tool set into the caller's tenant.

    ADR-0013: whole-server fork, never per-tool — embedded credentials make a
    partial fork a mixed-upstream footgun. Collisions fail loudly before any copy.
    """
    storage = _storage_or_fail()
    tenant = str(ctx.tenant_id or "").strip()
    if ctx.is_root or tenant in ("", "__root__", "__system__"):
        raise HTTPException(
            status_code=400,
            detail="Fork is for tenant scopes; root edits shared servers in place",
        )
    try:
        sid = validate_mcp_segment_id(server_id, "mcp_server")
    except McpSegmentIdError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    sys_docs = await _system_server_tool_docs(storage, sid)
    if not sys_docs:
        raise HTTPException(status_code=404, detail=f"No shared MCP server '{sid}'")

    finder = getattr(storage, "find_mcp_tool_configuration_by_wire_name", None)
    tenant_docs = await get_mcp_tool_configurations(
        storage, enabled_only=False, tenant_id=tenant,
    )
    owned_by_identity: dict[tuple[str, str], dict] = {}
    for doc in tenant_docs:
        if not isinstance(doc, dict) or not _tenant_owns_doc(doc, tenant):
            continue
        identity = _mcp_doc_identity(doc)
        if all(identity):
            owned_by_identity[identity] = doc
    # A re-fork is a catch-up, not a rebuild — the platform adds tools to a shared
    # server over time and an existing fork must be able to receive them. Split the
    # shared set three ways: tools the tenant already forked (skip — their copy may
    # be customized or renamed), tools whose wire an UNRELATED tenant tool occupies
    # (refuse), and genuinely new tools (copy). "Already forked" is keyed on the
    # (mcp_server, rpc_name) identity, not the wire: a renamed fork is still
    # recognised as ours, and a same-identity twin under another wire is skipped
    # rather than tripping the unique rpc index mid-copy (the old R9-F2 500).
    already_forked: list[dict] = []
    to_copy: list[dict] = []
    conflicts: list[str] = []
    for doc in sys_docs:
        existing = owned_by_identity.get(_mcp_doc_identity(doc))
        if existing is not None:
            already_forked.append(existing)
            continue
        wire = str(doc.get("name") or "").strip()
        hit = await finder(tenant, wire) if callable(finder) else None
        if hit is not None:
            conflicts.append(wire)
            continue
        to_copy.append(doc)
    if conflicts:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "fork_conflict",
                "message": (
                    f"Cannot fork shared MCP server '{sid}': tenant '{tenant}' "
                    f"already has unrelated tools at these wire names: "
                    f"{', '.join(sorted(conflicts))}. Rename or remove them, then "
                    f"fork again. Nothing was copied."
                ),
                "conflicts": sorted(conflicts),
            },
        )

    created: list[dict] = []
    try:
        for doc in to_copy:
            fork_doc = copy.deepcopy(doc)
            for drop in ("_id", "created_at", "updated_at", "created_by", "updated_by"):
                fork_doc.pop(drop, None)
            fork_doc["tenant_id"] = tenant
            fork_doc["source"] = "mcp_server"
            # Metadata (incl. embedded platform credentials) copies verbatim: the
            # shared offering hands its key to the tenant; rotation stops here.
            await save_tool_document(storage, fork_doc, actor_id=ctx.user_id)
            saved = (
                await finder(tenant, str(fork_doc.get("name") or ""))
                if callable(finder)
                else None
            )
            created.append(saved or fork_doc)
    except Exception as exc:
        # A half-forked server wedges the tenant: retries hit fork_conflict on the
        # copied names while every edit still returns fork_required. Roll back so
        # the fork stays all-or-nothing and the retry path stays open.
        for partial in created:
            try:
                await delete_tool_document(storage, partial)
            except Exception:
                logger.warning(
                    "[CONFIG-API] fork rollback failed tenant=%s tool=%s",
                    tenant,
                    partial.get("name"),
                )
        logger.error(
            "[CONFIG-API] fork of shared MCP server '%s' into tenant '%s' failed "
            "after %d/%d tools: %s",
            sid,
            tenant,
            len(created),
            len(to_copy),
            exc,
        )
        raise HTTPException(
            status_code=500,
            detail={
                "code": "fork_failed",
                "message": (
                    f"Fork of shared MCP server '{sid}' failed; partial copies "
                    "were rolled back. Retry the fork."
                ),
            },
        ) from exc

    await _reload_tool_registry()
    await _sync_tenant_cursor_json_from_tools(
        storage=storage,
        tenant_id=tenant,
        actor_id=ctx.user_id,
    )
    logger.info(
        "[CONFIG-API] Forked shared MCP server '%s' into tenant '%s' "
        "(%d new, %d already present)",
        sid,
        tenant,
        len(created),
        len(already_forked),
    )
    # The full current fork of this server: pre-existing (possibly customized)
    # copies plus whatever this call added, so the response is the tenant's fork
    # on both a first fork and a catch-up.
    return [_tool_doc_for_api_response(d) for d in already_forked + created]


mcp_router.add_api_route(
    "/mcp-servers/cursor-json-http",
    get_tenant_cursor_json_http_only,
    methods=["GET"],
    response_model=dict,
)
mcp_router.add_api_route(
    "/mcp-servers/cursor-json",
    get_tenant_cursor_json,
    methods=["GET"],
    response_model=dict,
)
mcp_router.add_api_route(
    "/mcp-servers/cursor-json",
    save_tenant_cursor_json,
    methods=["PUT"],
)
mcp_router.add_api_route(
    "/mcp-servers/discover",
    discover_mcp_server_tools,
    methods=["POST"],
    response_model=MCPServerDiscoverResponse,
)
mcp_router.add_api_route(
    "/mcp-servers/health-check",
    health_check_all_mcp_servers,
    methods=["POST"],
    response_model=MCPServersHealthResponse,
)

from api.routes.mcp_packages import register_mcp_package_routes

register_mcp_package_routes(mcp_router)

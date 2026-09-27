"""Configuration Bundle Service — export/import tenant configs as JSON.

Exposes three coroutines:
- export_bundle(storage, tenant_id) -> dict
- dry_run_import(storage, bundle, target_tenant_id) -> dict
- apply_import(storage, bundle, target_tenant_id, actor_id) -> dict

All apply_import writes go through storage.save_X(doc, actor_id=...) so audit
stamping stays in the storage layer. MCP tools are out of V1 scope — they are
managed by Bifrost discovery, not bundles.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pydantic import ValidationError

from config.configuration_resolution import (
    agent_wire_name_from_doc,
    configuration_identity_name,
    find_agent_wire_name_collision,
    is_opaque_storage_id,
    normalize_configuration_identity,
    resolve_configuration_storage_id_for_upsert,
)
from config.configuration_reference_validation import (
    collect_agent_wire_names,
    collect_known_wire_names_from_agent_docs,
    known_tenant_ids_from_storage,
    known_wire_names_from_storage,
    normalize_workflow_node_references,
    strip_legacy_tenant_prefixed_value,
    validate_agent_configuration_references,
)
from schemas.configuration_schemas import (
    A2AServerConfigurationCreate,
    AgentConfigurationCreate,
    RunConfigurationCreate,
    ToolConfigurationCreate,
    WorkflowDefinitionCreate,
)
from llm.agent_model_params import (
    AgentModelParamsValidationError,
    ModelConfigResolutionError,
    materialize_agent_model_params,
    validate_agent_model_params,
)

logger = logging.getLogger(__name__)

BUNDLE_VERSION = 1
SYSTEM_TENANT_ID = "__system__"
_LEGACY_TENANT_PREFIX_SEP = "__"  # export-only: normalize pre-migration cloned storage
KINDS = ("agents", "workflows", "tools", "run_configurations", "a2a_servers")

# A2A servers diverge from the other kinds: opaque UUID _id (not a wire name),
# name-based per-tenant identity, secrets + a re-fetchable agent-card cache on the doc.
# Export carries the tenant-unique `name` as the portable _id and drops the rest below.
A2A_KIND = "a2a_servers"
# Inline auth secrets are masked (not dropped) on export: a shareable bundle must never
# carry a real credential, but replacing it with an all-asterisk placeholder keeps the
# auth shape valid so the bundle still imports — the import then warns the user to put
# the real secret back (or set the matching *_env). The *_env references are kept as-is.
_A2A_SECRET_AUTH_FIELDS = ("token", "client_secret", "refresh_token")
_A2A_AUTH_ENV_FIELDS = ("token_env", "client_secret_env", "refresh_token_env")
_A2A_SECRET_PLACEHOLDER = "*" * 40


def _is_a2a_secret_placeholder(value: Any) -> bool:
    """True if value is the export placeholder — a non-empty run of only '*'.

    Detected by shape, not exact length, so a hand-edited bundle (different asterisk
    count) is still recognized as 'needs a real secret', never mistaken for one.
    """
    return isinstance(value, str) and set(value) == {"*"}

AUDIT_FIELDS = frozenset({"created_at", "created_by", "updated_at", "updated_by"})
INTERNAL_FIELDS = AUDIT_FIELDS
DIFF_IGNORE_FIELDS = INTERNAL_FIELDS | frozenset({"_id", "tenant_id"})


def _normalize_configuration_identity_on_import(
    doc: Dict[str, Any],
    bare_bundle_id: str,
) -> None:
    """Ensure ``name`` is the wire identity; preserve human label in ``display_name``."""
    normalized = normalize_configuration_identity(doc, wire_id=bare_bundle_id)
    doc.clear()
    doc.update(normalized)


def _normalize_agent_mcp_refs_on_import(
    doc: Dict[str, Any],
    target_tenant_id: str,
) -> None:
    """Canonicalize MCP allow-list refs to public ids (matches MCP catalog)."""
    from tools.agent_allowed_tools import (
        apply_agent_tool_allowlist_normalization,
        is_mcp_public_tool_id,
    )
    from tools.mcp_tool_ids import normalize_mcp_public_tool_ref

    tid = str(target_tenant_id or "").strip()
    for field in ("allowed_tools", "allowed_mcp_tools"):
        values = doc.get(field)
        if not isinstance(values, list):
            continue
        doc[field] = [
            normalize_mcp_public_tool_ref(str(ref), tid)
            if is_mcp_public_tool_id(str(ref or ""))
            else ref
            for ref in values
        ]
    normalized = apply_agent_tool_allowlist_normalization(doc)
    doc["allowed_tools"] = normalized["allowed_tools"]
    doc["allowed_mcp_tools"] = normalized["allowed_mcp_tools"]


# Cross-collection agent-id refs carried verbatim on import. Used only for
# ref_notes when a ref is not present in the bundle. `allowed_tools` is absent:
# builtin names and MCP ids are not bundle-id refs and always pass through.
AGENT_REFS = (
    ("allowed_delegation_targets", "agents"),
)


class BundleError(RuntimeError):
    """Raised on bundle-wide errors (missing target tenant, malformed bundle)."""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def export_bundle(storage, tenant_id: str) -> Dict[str, Any]:
    """Dump all configurations for the given tenant into a JSON-ready bundle.

    Bundle items carry bare wire `_id`s (no `tenant_id` field). Legacy cloned
    storage may still use `{tenant}__{id}` — export normalizes those to bare ids
    and bare refs. Import applies verbatim: only `tenant_id` is set on the target.
    """
    if not tenant_id or not isinstance(tenant_id, str):
        raise BundleError("tenant_id is required")

    items: Dict[str, List[Dict[str, Any]]] = {}
    agent_docs = await _list_tenant_docs(storage, "agents", tenant_id)
    agent_wire_names = collect_agent_wire_names(agent_docs, tenant_id)
    for kind in KINDS:
        docs = agent_docs if kind == "agents" else await _list_tenant_docs(storage, kind, tenant_id)
        items[kind] = [
            _export_doc(d, kind, tenant_id, preserve_wire_names=agent_wire_names)
            for d in docs
        ]

    return {
        "version": BUNDLE_VERSION,
        "exported_from": tenant_id,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "items": items,
    }


def _export_bundle_item_id(
    doc: Dict[str, Any],
    doc_id: str,
    source_tenant: str,
    wire_name: str | None,
    *,
    preserve_wire_names: frozenset[str] | None = None,
) -> str:
    """Normalize storage ``_id`` to portable bundle id (bare wire or legacy suffix)."""
    tenant = str(source_tenant or "").strip()
    if not doc_id:
        return wire_name or ""
    if is_opaque_storage_id(doc_id):
        if wire_name:
            return _export_bundle_item_id(
                doc,
                wire_name,
                tenant,
                wire_name,
                preserve_wire_names=preserve_wire_names,
            )
        # The opaque storage id is tenant-local and meaningless in another tenant. Prefer
        # the human identity (name) so import keeps it instead of clobbering name with the
        # UUID; mirrors _export_a2a_doc. Fall back to the UUID only when there's no usable name.
        stored_name = configuration_identity_name(doc) or ""
        if stored_name and not is_opaque_storage_id(stored_name):
            return stored_name
        return doc_id
    prefix = f"{tenant}{_LEGACY_TENANT_PREFIX_SEP}"
    if doc_id.startswith(prefix):
        suffix = doc_id[len(prefix):]
        stored = configuration_identity_name(doc) or ""
        if (
            doc_id == stored
            and wire_name == doc_id
            and _LEGACY_TENANT_PREFIX_SEP not in suffix
            and len(suffix) <= 4
        ):
            return suffix
        return strip_legacy_tenant_prefixed_value(
            doc_id,
            tenant,
            wire_name=wire_name,
            preserve_wire_names=preserve_wire_names,
        )
    return wire_name or doc_id


def _is_a2a_runtime_cache_field(key: str) -> bool:
    """True for the re-fetchable agent-card cache fields (incl. per-endpoint variants).

    update_a2a_server_cache_with_endpoint writes ``cached_agent_card_<endpoint>`` /
    ``cached_at_<endpoint>`` keys, so a prefix test catches the whole family.
    """
    return (
        key.startswith("cached_agent_card")
        or key.startswith("cached_at")
        or key == "last_validated_at"
    )


def _export_a2a_doc(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Project an A2A server doc to its portable bundle form.

    Carries the tenant-unique ``name`` as the bundle ``_id`` (the UUID storage id is
    not portable), drops the agent-card cache (re-fetched on the target), and masks
    inline auth secrets with a placeholder while keeping the ``*_env`` references and
    non-secret auth fields. See ``_A2A_SECRET_PLACEHOLDER`` for the masking rationale.
    """
    out = _strip_internal(doc)
    out.pop("tenant_id", None)
    name = str(out.get("name") or "").strip()
    if name:
        out["_id"] = name
    for key in list(out.keys()):
        if _is_a2a_runtime_cache_field(key):
            out.pop(key, None)
    auth = out.get("auth")
    if isinstance(auth, dict):
        out["auth"] = {
            k: (_A2A_SECRET_PLACEHOLDER if k in _A2A_SECRET_AUTH_FIELDS and v else v)
            for k, v in auth.items()
        }
    return out


def _export_doc(
    doc: Dict[str, Any],
    kind: str,
    source_tenant: str,
    *,
    preserve_wire_names: frozenset[str] | None = None,
) -> Dict[str, Any]:
    """Strip audit/internal fields, tenant prefix from _id, tenant_id, and refs."""
    if kind == A2A_KIND:
        return _export_a2a_doc(doc)
    out = _strip_internal(doc)
    out.pop("tenant_id", None)
    doc_id = out.get("_id")
    wire_name = None
    if kind in ("agents", "workflows", "tools"):
        wire_name = agent_wire_name_from_doc(out, runtime_tenant_id=source_tenant)
        if not wire_name:
            candidate = str(out.get("name") or "").strip()
            from config.configuration_resolution import is_wire_configuration_name

            if is_wire_configuration_name(candidate):
                wire_name = candidate
    if isinstance(doc_id, str) and doc_id:
        out["_id"] = _export_bundle_item_id(
            out,
            doc_id,
            source_tenant,
            wire_name,
            preserve_wire_names=preserve_wire_names,
        )
    _normalize_refs_on_export(
        out,
        kind,
        source_tenant,
        preserve_wire_names=preserve_wire_names,
    )
    return out


async def dry_run_import(
    storage,
    bundle: Dict[str, Any],
    target_tenant_id: str,
) -> Dict[str, Any]:
    """Validate bundle and compute per-item action without writes."""
    await _validate_target_tenant(storage, target_tenant_id)
    raw_items = _extract_items(bundle)
    bundle_id_maps = _build_bundle_id_maps(raw_items)
    bundle_wire_names = collect_known_wire_names_from_agent_docs(raw_items.get("agents", []))
    storage_wire_names = await known_wire_names_from_storage(storage)
    known_wire_names = frozenset(bundle_wire_names | storage_wire_names)
    results: Dict[str, List[Dict[str, Any]]] = {}
    for kind in KINDS:
        seen_ids: set[str] = set()
        results[kind] = [
            await _evaluate_item(
                storage,
                kind,
                raw,
                target_tenant_id,
                seen_ids,
                bundle_id_maps,
                known_wire_names=known_wire_names,
            )
            for raw in raw_items[kind]
        ]
    _mask_a2a_secrets_in_results(results)
    return {
        "target_tenant_id": target_tenant_id,
        "items": results,
        "summary": _summarize(results),
    }


async def apply_import(
    storage,
    bundle: Dict[str, Any],
    target_tenant_id: str,
    actor_id: str,
) -> Dict[str, Any]:
    """Validate bundle and apply per-item with partial-failure tolerance."""
    await _validate_target_tenant(storage, target_tenant_id)
    raw_items = _extract_items(bundle)
    bundle_id_maps = _build_bundle_id_maps(raw_items)
    bundle_wire_names = collect_known_wire_names_from_agent_docs(raw_items.get("agents", []))
    storage_wire_names = await known_wire_names_from_storage(storage)
    known_wire_names = frozenset(bundle_wire_names | storage_wire_names)
    results: Dict[str, List[Dict[str, Any]]] = {}
    for kind in KINDS:
        kind_results: List[Dict[str, Any]] = []
        seen_ids: set[str] = set()
        for raw in raw_items[kind]:
            evaluation = await _evaluate_item(
                storage,
                kind,
                raw,
                target_tenant_id,
                seen_ids,
                bundle_id_maps,
                known_wire_names=known_wire_names,
            )
            action = evaluation.get("action")
            if action in ("error", "skip"):
                kind_results.append(evaluation)
                continue
            try:
                await _save_item(storage, kind, evaluation["resolved"], actor_id)
                evaluation["status"] = "success"
                logger.info(
                    "[BUNDLE] kind=%s action=%s _id=%s tenant=%s actor=%s",
                    kind, action, evaluation.get("_id"),
                    target_tenant_id, actor_id,
                )
            except Exception as exc:
                logger.exception(
                    "[BUNDLE] kind=%s _id=%s apply failed: %s",
                    kind, evaluation.get("_id"), exc,
                )
                evaluation["action"] = "error"
                evaluation["error"] = f"save failed: {exc}"
            kind_results.append(evaluation)
        results[kind] = kind_results

    # Real secrets were needed above for the save; mask them before echoing back.
    _mask_a2a_secrets_in_results(results)
    return {
        "target_tenant_id": target_tenant_id,
        "items": results,
        "summary": _summarize(results),
    }


# ---------------------------------------------------------------------------
# Internal: bundle parsing and target validation
# ---------------------------------------------------------------------------

def _extract_items(bundle: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    if not isinstance(bundle, dict):
        raise BundleError("Bundle must be a JSON object")
    items_obj = bundle.get("items")
    if not isinstance(items_obj, dict):
        raise BundleError("Bundle missing required 'items' object")
    out: Dict[str, List[Dict[str, Any]]] = {}
    for kind in KINDS:
        kind_items = items_obj.get(kind, [])
        if not isinstance(kind_items, list):
            raise BundleError(f"Bundle items.{kind} must be a list")
        out[kind] = kind_items
    return out


async def _validate_target_tenant(storage, target_tenant_id: str) -> None:
    if not target_tenant_id or not isinstance(target_tenant_id, str):
        raise BundleError("target_tenant_id is required")
    if target_tenant_id == SYSTEM_TENANT_ID:
        raise BundleError(
            "Cannot import into __system__ tenant; use boot-time seed mechanism"
        )
    if not hasattr(storage, "get_tenant"):
        raise BundleError("Storage backend does not support tenant validation")
    tenant = await storage.get_tenant(target_tenant_id)
    if not tenant:
        raise BundleError(f"Target tenant '{target_tenant_id}' does not exist")


# ---------------------------------------------------------------------------
# Internal: per-item evaluation
# ---------------------------------------------------------------------------

async def _evaluate_item(
    storage,
    kind: str,
    raw: Any,
    target_tenant_id: str,
    seen_ids: set[str],
    bundle_id_maps: Dict[str, set[str]],
    *,
    known_wire_names: frozenset[str] | None = None,
) -> Dict[str, Any]:
    """Validate single item, compute target id, keep refs verbatim, compute action."""
    if not isinstance(raw, dict):
        return {"_id": "?", "action": "error", "error": "item must be an object"}

    bare_id = raw.get("_id") or raw.get("id")
    result: Dict[str, Any] = {"_id": bare_id}

    if not bare_id or not isinstance(bare_id, str):
        result["action"] = "error"
        result["error"] = "_id is required and must be a string"
        return result

    if bare_id in seen_ids:
        result["action"] = "error"
        result["error"] = f"duplicate _id within bundle: {bare_id}"
        return result
    seen_ids.add(bare_id)

    if kind == "tools" and raw.get("source") == "mcp_server":
        result["action"] = "error"
        result["error"] = (
            "MCP tools are not supported in bundle "
            "(managed by Bifrost auto-discovery)"
        )
        return result

    try:
        _validate_schema(kind, raw)
    except ValidationError as exc:
        result["action"] = "error"
        result["error"] = f"schema validation failed: {exc.errors()[:3]}"
        return result
    except BundleError as exc:
        result["action"] = "error"
        result["error"] = str(exc)
        return result

    target_id = await _compute_target_id(storage, kind, bare_id, target_tenant_id)
    result["target_id"] = target_id

    existing = await _get_existing(storage, kind, target_id, tenant_id=target_tenant_id)
    if existing is not None:
        existing_tenant = existing.get("tenant_id")
        if existing_tenant not in (target_tenant_id, None):
            result["action"] = "error"
            result["error"] = (
                f"_id collision: existing doc belongs to tenant "
                f"'{existing_tenant}', refusing cross-tenant overwrite"
            )
            return result

    resolved = dict(raw)
    resolved["_id"] = target_id
    resolved.pop("id", None)
    resolved["tenant_id"] = target_tenant_id
    for field in INTERNAL_FIELDS:
        resolved.pop(field, None)

    if kind == "agents":
        resolved = materialize_agent_model_params(resolved)
        try:
            await validate_agent_model_params(
                model=resolved["model"],
                temperature=resolved["temperature"],
                reasoning_effort=resolved["reasoning_effort"],
                storage=storage,
            )
        except AgentModelParamsValidationError as exc:
            result["action"] = "error"
            result["error"] = exc.message
            result["error_detail"] = exc.to_detail()
            return result
        except ModelConfigResolutionError as exc:
            result["action"] = "error"
            result["error"] = str(exc)
            result["error_detail"] = {
                "code": "model_config_unavailable",
                "message": str(exc),
                "field": "model",
                "model": resolved.get("model"),
            }
            return result
        _normalize_configuration_identity_on_import(resolved, bare_id)
        _normalize_agent_mcp_refs_on_import(resolved, target_tenant_id)
        try:
            tenant_ids = await known_tenant_ids_from_storage(storage)
            validate_agent_configuration_references(
                resolved,
                known_tenant_ids=tenant_ids,
                known_wire_names=known_wire_names,
            )
        except ValueError as exc:
            result["action"] = "error"
            result["error"] = str(exc)
            return result
        wire_name = agent_wire_name_from_doc(
            resolved,
            runtime_tenant_id=target_tenant_id,
        )
        if wire_name:
            collision = await find_agent_wire_name_collision(
                storage,
                target_tenant_id,
                wire_name,
                exclude_storage_id=str(target_id),
            )
            if collision:
                other_id = str(collision.get("_id") or "?")
                result["action"] = "error"
                result["error"] = (
                    f"Agent wire name '{wire_name}' already used by '{other_id}' "
                    f"for tenant '{target_tenant_id}'"
                )
                return result

    passthrough = _ref_notes_for_verbatim_import(resolved, kind, bundle_id_maps)
    format_warnings = _bundle_format_warnings(kind, raw)
    if format_warnings:
        passthrough = list(passthrough or []) + format_warnings
    if passthrough:
        result["ref_notes"] = passthrough
        logger.info(
            "[BUNDLE] kind=%s _id=%s refs kept verbatim "
            "(not in bundle, not in target): %s",
            kind, target_id, passthrough,
        )

    if kind == "workflows":
        _normalize_configuration_identity_on_import(resolved, bare_id)
        dag_error = _validate_and_normalize_workflow_dag(resolved)
        if dag_error:
            result["action"] = "error"
            result["error"] = dag_error
            return result
        try:
            tenant_ids = await known_tenant_ids_from_storage(storage)
            await normalize_workflow_node_references(
                resolved.get("nodes"),
                tenant_id=target_tenant_id,
                storage=storage,
                known_tenant_ids=tenant_ids,
                known_wire_names=known_wire_names,
            )
        except ValueError as exc:
            result["action"] = "error"
            result["error"] = str(exc)
            return result

    if existing is None:
        result["action"] = "insert"
    else:
        result["action"] = "update"
        if kind == A2A_KIND:
            # Restore the live secret for any field the bundle re-imported as the export
            # placeholder, so the full-replace save doesn't destroy the stored credential.
            # After this the placeholder fields equal the stored value, so the masked diff
            # honestly shows no change (there is none) instead of concealing a wipe.
            _restore_a2a_secrets_from_existing(resolved, existing)
            # Mask secrets on BOTH sides: the stored doc holds the real secret and the
            # incoming doc may too (if the user replaced the placeholder), and the diff
            # is echoed back to the caller. Masking both also stops the secret fields
            # from showing as spurious changes (placeholder vs the stored real value).
            result["diff"] = _diff_fields(
                _sanitize_a2a_doc_for_diff(existing),
                _sanitize_a2a_doc_for_diff(resolved),
            )
        else:
            result["diff"] = _diff_fields(existing, resolved)

    result["resolved"] = resolved
    return result


def _sanitize_a2a_doc_for_diff(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Drop the card cache and mask inline auth secrets before diffing.

    The dry-run/apply result echoes the diff back to the caller. Without this a
    plaintext secret (token/client_secret/refresh_token) — stored on the target, or
    carried in the incoming bundle if the user replaced the export placeholder — and a
    large re-fetchable agent card would leak into the response. The regular A2A API
    masks secrets, so the bundle path must not be a way around it. Masking every secret
    to the same placeholder also keeps the auth diff like-for-like.
    """
    out = {k: v for k, v in doc.items() if not _is_a2a_runtime_cache_field(k)}
    auth = out.get("auth")
    if isinstance(auth, dict):
        out["auth"] = {
            k: (_A2A_SECRET_PLACEHOLDER if k in _A2A_SECRET_AUTH_FIELDS and v else v)
            for k, v in auth.items()
        }
    return out


def _restore_a2a_secrets_from_existing(
    resolved: Dict[str, Any], existing: Dict[str, Any]
) -> None:
    """Carry the stored secret over when the incoming bundle kept the export placeholder.

    Export masks inline secrets to an all-asterisk placeholder, and on an UPDATE the operator
    usually re-imports without putting the real secret back. Without this a full-replace saves
    the placeholder over the live credential — and the masked diff hides the change, so the
    operator can't see the destruction. For each secret field still holding the placeholder,
    restore the value already on the target; a field the operator genuinely replaced is left
    as-is. Mirrors the UI update path (a2a_configurations.py restores masked auth on save).
    """
    incoming_auth = resolved.get("auth")
    existing_auth = existing.get("auth")
    if not isinstance(incoming_auth, dict) or not isinstance(existing_auth, dict):
        return
    for field in _A2A_SECRET_AUTH_FIELDS:
        if _is_a2a_secret_placeholder(incoming_auth.get(field)) and existing_auth.get(field):
            incoming_auth[field] = existing_auth[field]


def _mask_a2a_secrets_in_results(results: Dict[str, List[Dict[str, Any]]]) -> None:
    """Mask inline auth secrets in the echoed ``resolved`` doc for A2A items.

    ``resolved`` carries the real secret so apply can persist it, but the dry-run/apply
    response is returned to the caller — without this the plaintext token/client_secret/
    refresh_token would leak in the JSON (only ``diff`` was masked). Run this AFTER any save
    has consumed the real value. ``_sanitize_a2a_doc_for_diff`` also drops the re-fetchable
    card cache, which the response shouldn't carry either.
    """
    for item in results.get(A2A_KIND, []):
        resolved = item.get("resolved")
        if isinstance(resolved, dict):
            item["resolved"] = _sanitize_a2a_doc_for_diff(resolved)


def _validate_schema(kind: str, raw: Dict[str, Any]) -> None:
    """Re-use existing Pydantic Create-schemas; map _id <-> id as needed."""
    payload = {k: v for k, v in raw.items() if k not in INTERNAL_FIELDS}
    payload.pop("tenant_id", None)

    if kind == "run_configurations":
        payload["_id"] = raw.get("_id") or raw.get("id")
        payload.pop("id", None)
        RunConfigurationCreate.model_validate(payload)
        return

    if kind == A2A_KIND:
        # _id (the portable name) and any lingering card-cache keys are not Create
        # fields; validate the actual server config (name/endpoint/auth/...). The
        # A2AAuthConfig validator rejects auth that lost its only secret on export
        # (no inline secret, no *_env) — a clear per-item error beats a silent import.
        a2a_payload = {
            k: v for k, v in payload.items()
            if k not in ("_id", "id") and not _is_a2a_runtime_cache_field(k)
        }
        A2AServerConfigurationCreate.model_validate(a2a_payload)
        return

    if "id" not in payload and "_id" in payload:
        payload["id"] = payload["_id"]

    if kind == "agents":
        AgentConfigurationCreate.model_validate(payload)
    elif kind == "workflows":
        # Validate structure but not the create-time id pattern. The bundle carries the
        # existing wire name as _id, and legacy workflow names may predate that pattern
        # (it's enforced only at create). _id-is-nonempty-string is already checked
        # upstream, so swap a pattern-safe placeholder for the structural check and keep
        # the real id verbatim — a legacy hyphenated name must migrate, not error.
        WorkflowDefinitionCreate.model_validate({**payload, "id": "placeholder_id"})
    elif kind == "tools":
        ToolConfigurationCreate.model_validate(payload)
    else:
        raise BundleError(f"Unknown kind: {kind}")


def _validate_and_normalize_workflow_dag(resolved: Dict[str, Any]) -> Optional[str]:
    """Enforce the DAG contract the workflow CRUD API enforces on create/update.

    Pydantic only checks node/edge *shape*; a workflow can be well-shaped yet
    have no start/end node, dangling edges, non-runnable phase nodes, or cycles.
    Without this, bundle import is a back door that persists workflows the editor
    would reject and the engine breaks on at runtime. Mutates `resolved` in place
    to canonicalize nodes/edges for storage, exactly like the CRUD path.

    Returns an error message if the DAG is invalid, else None.

    `validate_dag` is imported lazily: a module-level import would invert the
    config->api layering and trip the api.routes package import cycle (the
    config_bundle router imports this module).
    """
    from api.routes.workflow_definitions import (
        _normalize_edges,
        _normalize_nodes,
        _static_workflow_delegation_violation,
        validate_dag,
    )
    from schemas.configuration_schemas import normalize_workflow_execution_mode

    nodes = resolved.get("nodes") or []
    edges = resolved.get("edges") or []
    validation = validate_dag(nodes, edges, default_reads=resolved.get("default_reads"))
    if not validation.valid:
        return f"invalid workflow DAG: {validation.errors}"
    try:
        resolved["execution_mode"] = normalize_workflow_execution_mode(
            resolved.get("execution_mode"),
        )
    except ValueError as exc:
        return str(exc)
    violation = _static_workflow_delegation_violation(
        resolved["execution_mode"],
        nodes,
    )
    if violation:
        return (
            f"static workflow delegation: {violation['message']} "
            f"(node_id={violation['node_id']})"
        )
    _normalize_edges(edges)
    _normalize_nodes(nodes)
    resolved["nodes"] = nodes
    resolved["edges"] = edges
    return None


def _diff_fields(
    existing: Dict[str, Any],
    incoming: Dict[str, Any],
) -> List[Dict[str, Any]]:
    keys = (set(existing) | set(incoming)) - DIFF_IGNORE_FIELDS
    diff: List[Dict[str, Any]] = []
    for key in sorted(keys):
        e_val = existing.get(key)
        i_val = incoming.get(key)
        if e_val != i_val:
            diff.append({"field": key, "existing": e_val, "incoming": i_val})
    return diff


# ---------------------------------------------------------------------------
# Internal: storage adapters (handles 4-collection variance)
# ---------------------------------------------------------------------------

async def _list_tenant_docs(
    storage, kind: str, tenant_id: str,
) -> List[Dict[str, Any]]:
    if kind == "agents":
        docs = await storage.get_agent_configurations(
            enabled_only=False, tenant_id=None,
        )
        return [
            d for d in (_to_dict(doc) for doc in docs)
            if d.get("tenant_id") == tenant_id
        ]
    if kind == "workflows":
        docs = await storage.get_workflow_definitions(tenant_id=None)
        return [
            d for d in (_to_dict(doc) for doc in docs)
            if d.get("tenant_id") == tenant_id
        ]
    if kind == "tools":
        docs = await storage.get_tool_configurations(
            enabled_only=False, tenant_id=None,
        )
        return [
            d for d in (_to_dict(doc) for doc in docs)
            if d.get("tenant_id") == tenant_id and d.get("source") != "mcp_server"
        ]
    if kind == "run_configurations":
        if hasattr(storage, "get_run_configurations"):
            docs = await storage.get_run_configurations(tenant_id=tenant_id)
            return [_to_dict(doc) for doc in docs]
        store = getattr(storage, "run_config_store", None)
        if not store or not hasattr(store, "list_configs"):
            return []
        docs = await store.list_configs(None)
        return [
            d for d in (_to_dict(doc) for doc in docs)
            if d.get("tenant_id") == tenant_id
        ]
    if kind == A2A_KIND:
        # High limit: export must dump every server, not the default first page of 100.
        docs = await storage.get_a2a_servers(tenant_id, 0, 100_000, True)
        return [_to_dict(doc) for doc in docs]
    raise BundleError(f"Unknown kind: {kind}")


async def _get_existing(
    storage,
    kind: str,
    doc_id: str,
    *,
    tenant_id: str | None = None,
) -> Optional[Dict[str, Any]]:
    if kind == "agents":
        return _to_dict_or_none(
            await storage.get_agent_configuration(doc_id, tenant_id=tenant_id),
        )
    if kind == "workflows":
        return _to_dict_or_none(
            await storage.get_workflow_definition(doc_id, tenant_id=tenant_id),
        )
    if kind == "tools":
        return _to_dict_or_none(await storage.get_tool_configuration(doc_id))
    if kind == "run_configurations":
        if hasattr(storage, "get_run_configuration"):
            return _to_dict_or_none(
                await storage.get_run_configuration(doc_id)
            )
        store = getattr(storage, "run_config_store", None)
        if store and hasattr(store, "get_config"):
            existing = await store.get_config(doc_id)
            return _to_dict_or_none(existing)
        return None
    if kind == A2A_KIND:
        return _to_dict_or_none(await storage.get_a2a_server(doc_id, tenant_id))
    raise BundleError(f"Unknown kind: {kind}")


async def _save_item(
    storage, kind: str, doc: Dict[str, Any], actor_id: str,
) -> None:
    if kind in ("agents", "workflows", "tools", "run_configurations"):
        from schemas.configuration_schemas import sync_entity_descriptions_for_save

        sync_entity_descriptions_for_save(doc)
    if kind == "agents":
        await storage.save_agent_configuration(doc, actor_id=actor_id)
        return
    if kind == "workflows":
        await storage.save_workflow_definition(doc, actor_id=actor_id)
        return
    if kind == "tools":
        await storage.save_tool_configuration(doc, actor_id=actor_id)
        return
    if kind == "run_configurations":
        store = getattr(storage, "run_config_store", None)
        if store and hasattr(store, "validate_config_document"):
            await store.validate_config_document(
                doc,
                tenant_id=doc.get("tenant_id"),
            )
        if hasattr(storage, "save_run_configuration"):
            await storage.save_run_configuration(doc, actor_id=actor_id)
            return
        raise BundleError("Storage does not support save_run_configuration")
    if kind == A2A_KIND:
        await storage.save_a2a_server(doc, actor_id=actor_id)
        return
    raise BundleError(f"Unknown kind: {kind}")


# ---------------------------------------------------------------------------
# Internal: bundle format lint (warnings only)
# ---------------------------------------------------------------------------

def _bundle_format_warnings(kind: str, raw: Dict[str, Any]) -> List[str]:
    """Warn about tenant-specific ids in tenant-agnostic bundle content."""
    from tools.agent_allowed_tools import is_mcp_public_tool_id

    warnings: List[str] = []
    bare_id = raw.get("_id") or raw.get("id")
    if isinstance(bare_id, str) and "__" in bare_id:
        warnings.append(f"bundle _id contains '__' (use bare id): {bare_id}")

    if kind == "agents":
        for field in ("allowed_tools", "allowed_mcp_tools"):
            for ref in raw.get(field) or []:
                tid = str(ref or "").strip()
                if not tid or tid == "delegate_to_agent":
                    continue
                if is_mcp_public_tool_id(tid) and tid.count(".") >= 2:
                    warnings.append(
                        f"MCP ref uses tenant-embedded storage id (prefer server.tool): {tid}"
                    )
        for ref in raw.get("allowed_delegation_targets") or []:
            target = str(ref or "").strip()
            if target and target != "*" and "__" in target:
                warnings.append(
                    f"delegation target contains '__' (use bare id): {target}"
                )

    if kind == "workflows":
        for node in raw.get("nodes") or []:
            if not isinstance(node, dict):
                continue
            agent_type = node.get("agent_type")
            if isinstance(agent_type, str) and "__" in agent_type:
                warnings.append(
                    f"workflow node agent_type contains '__' (use bare id): {agent_type}"
                )

    if kind == A2A_KIND:
        auth = raw.get("auth")
        if isinstance(auth, dict):
            env_refs = [auth.get(f) for f in _A2A_AUTH_ENV_FIELDS if auth.get(f)]
            if env_refs:
                warnings.append(
                    f"auth reads backend env var(s) {env_refs}; ensure they are set on "
                    f"the target backend or the server cannot authenticate"
                )
            placeholder_fields = [
                f for f in _A2A_SECRET_AUTH_FIELDS
                if _is_a2a_secret_placeholder(auth.get(f))
            ]
            if placeholder_fields:
                warnings.append(
                    f"auth secret placeholder(s) {placeholder_fields} were imported as-is "
                    f"(masked on export); replace with the real value on this tenant's A2A "
                    f"server, or set the matching *_env, before use — the server cannot "
                    f"authenticate with the placeholder"
                )

    return warnings


# ---------------------------------------------------------------------------
# Internal: export normalization + verbatim import ref notes
# ---------------------------------------------------------------------------

def _strip_legacy_tenant_prefix(
    value: str,
    tenant_id: str,
    *,
    wire_name: str | None = None,
    preserve_wire_names: frozenset[str] | None = None,
) -> str:
    """Strip leading legacy ``{tenant}__`` clone prefix when safe."""
    return strip_legacy_tenant_prefixed_value(
        value,
        tenant_id,
        wire_name=wire_name,
        preserve_wire_names=preserve_wire_names,
    )


def _ref_fields_for(kind: str) -> tuple[tuple[str, str], ...]:
    """Cross-collection ref fields carried by docs of `kind`. (field, target_kind)."""
    if kind == "agents":
        return AGENT_REFS
    return ()


def _normalize_refs_on_export(
    doc: Dict[str, Any],
    kind: str,
    source_tenant: str,
    *,
    preserve_wire_names: frozenset[str] | None = None,
) -> None:
    """Mutate `doc` in place: normalize legacy `{source_tenant}__` refs to bare."""
    for field, _target_kind in _ref_fields_for(kind):
        values = doc.get(field)
        if not isinstance(values, list):
            continue
        doc[field] = [
            v if not isinstance(v, str) or v == "*"
            else _strip_legacy_tenant_prefix(
                v,
                source_tenant,
                preserve_wire_names=preserve_wire_names,
            )
            for v in values
        ]
    if kind == "workflows":
        nodes = doc.get("nodes")
        if isinstance(nodes, list):
            for node in nodes:
                if not isinstance(node, dict):
                    continue
                agent_type = node.get("agent_type")
                if isinstance(agent_type, str) and agent_type:
                    node["agent_type"] = _strip_legacy_tenant_prefix(
                        agent_type,
                        source_tenant,
                        preserve_wire_names=preserve_wire_names,
                    )


def _build_bundle_id_maps(
    raw_items: Dict[str, List[Dict[str, Any]]],
) -> Dict[str, set[str]]:
    """Return {kind: set of bare _ids present in the bundle} for D' resolution."""
    maps: Dict[str, set[str]] = {}
    for kind in KINDS:
        ids: set[str] = set()
        for raw in raw_items.get(kind, []):
            if not isinstance(raw, dict):
                continue
            doc_id = raw.get("_id") or raw.get("id")
            if isinstance(doc_id, str) and doc_id:
                ids.add(doc_id)
        maps[kind] = ids
    return maps


def _bundle_doc_matches_wire(
    kind: str,
    doc: Dict[str, Any],
    *,
    target_tenant_id: str,
    wire: str,
) -> bool:
    """True when ``doc`` is the tenant override for bundle wire ``wire``."""
    owner = str(doc.get("tenant_id") or "").strip()
    target = str(target_tenant_id or "").strip()
    needle = str(wire or "").strip()
    if not owner or owner != target or not needle:
        return False
    if kind == "agents":
        return agent_wire_name_from_doc(doc, runtime_tenant_id=owner) == needle
    name = configuration_identity_name(doc) or str(doc.get("name") or "").strip()
    return name == needle


async def _compute_target_id(
    storage,
    kind: str,
    bare_id: str,
    target_tenant_id: str,
) -> str:
    """Resolve existing storage ``_id`` for bundle import, or bare wire for mint-on-save."""
    target = str(target_tenant_id or "").strip()
    wire = str(bare_id or "").strip()

    if kind == A2A_KIND:
        # Identity is the tenant-unique name (bundle _id == name). Reuse the existing
        # server's opaque storage id on update; mint a fresh UUID on insert so stored
        # ids stay UUIDs (as UI-created servers are), never the human-readable name.
        existing = await storage.get_a2a_server_by_name(wire, target)
        if isinstance(existing, dict) and str(existing.get("_id") or "").strip():
            return str(existing["_id"])
        return str(uuid.uuid4())

    find_by_name = _find_by_name_fn(storage, kind)
    existing_by_name = await find_by_name(target, wire) if find_by_name else None
    if isinstance(existing_by_name, dict):
        owner = str(existing_by_name.get("tenant_id") or "").strip()
        storage_id = str(existing_by_name.get("_id") or "").strip()
        if owner == target and storage_id:
            return storage_id

    doc = await _get_existing(storage, kind, wire, tenant_id=target)
    if doc is not None and _bundle_doc_matches_wire(
        kind,
        doc,
        target_tenant_id=target,
        wire=wire,
    ):
        return str(doc.get("_id") or wire)

    return resolve_configuration_storage_id_for_upsert(
        tenant_id=target,
        wire_name=wire,
        existing_by_name=existing_by_name if isinstance(existing_by_name, dict) else None,
    )


def _find_by_name_fn(storage, kind: str):
    if kind == "agents":
        return getattr(storage, "find_agent_configuration_by_name", None)
    if kind == "workflows":
        return getattr(storage, "find_workflow_definition_by_name", None)
    if kind == "tools":
        return getattr(storage, "find_tool_configuration_by_name", None)
    return None


def _ref_notes_for_verbatim_import(
    doc: Dict[str, Any],
    kind: str,
    bundle_id_maps: Dict[str, set[str]],
) -> List[str]:
    """Refs outside the bundle are kept verbatim; return non-blocking diagnostics."""
    notes: List[str] = []
    for field, target_kind in _ref_fields_for(kind):
        for ref in doc.get(field) or []:
            if isinstance(ref, str) and ref != "*" and ref not in bundle_id_maps.get(
                target_kind, set(),
            ):
                notes.append(f"{target_kind}/{ref}")
    if kind == "workflows":
        for node in doc.get("nodes") or []:
            if not isinstance(node, dict):
                continue
            agent_type = node.get("agent_type")
            if (
                isinstance(agent_type, str)
                and agent_type
                and agent_type not in bundle_id_maps.get("agents", set())
            ):
                notes.append(f"agents/{agent_type}")
    return notes


# ---------------------------------------------------------------------------
# Internal: helpers
# ---------------------------------------------------------------------------

def _strip_internal(doc: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(doc)
    for field in INTERNAL_FIELDS:
        out.pop(field, None)
    return out


def _to_dict(doc: Any) -> Dict[str, Any]:
    if isinstance(doc, dict):
        return doc
    if hasattr(doc, "model_dump"):
        return doc.model_dump(by_alias=True)
    return dict(doc)


def _to_dict_or_none(doc: Any) -> Optional[Dict[str, Any]]:
    if doc is None:
        return None
    return _to_dict(doc)


def _summarize(
    results: Dict[str, List[Dict[str, Any]]],
) -> Dict[str, Dict[str, int]]:
    summary: Dict[str, Dict[str, int]] = {}
    for kind, items in results.items():
        counts = {
            "insert": 0, "update": 0, "skip": 0,
            "error": 0, "total": len(items),
        }
        for item in items:
            action = item.get("action")
            if action in counts:
                counts[action] += 1
        summary[kind] = counts
    return summary

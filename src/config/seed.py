"""
Seed utility — loads initial configurations into MongoDB.

- ``seed_agents``  : agents.yaml  → agent_configurations
- ``seed_workflows``: workflows.json → workflow_definitions
- ``seed_tools``   : tools.yaml  → tool_configurations

Upsert on every startup: compares YAML/JSON configs with existing
MongoDB docs and updates only when there are differences.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List

import yaml
from config.configuration_resolution import (
    normalize_configuration_identity,
)
from config.seed_controls import seed_writes_enabled
from llm.agent_model_params import (
    AgentModelParamsValidationError,
    ModelConfigResolutionError,
    materialize_agent_model_params,
    validate_agent_model_params,
)
# Hoisted from a function-local import inside seed_run_configurations: the equal-configs
# backfill branch uses RunConfigurationUpdate before the later local import bound it,
# which made Python treat the name as local for the whole function and raised
# UnboundLocalError (PR #99 regression).
from schemas.configuration_schemas import RunConfigurationUpdate

logger = logging.getLogger(__name__)

_DEFAULT_YAML = os.path.join(os.path.dirname(__file__), "agents.yaml")
_DEFAULT_WORKFLOWS_JSON = os.path.join(os.path.dirname(__file__), "workflows.json")
_DEFAULT_TOOLS_YAML = os.path.join(os.path.dirname(__file__), "tools.yaml")
_DEFAULT_RUN_CONFIGS_JSON = os.path.join(os.path.dirname(__file__), "run_configs.json")


# ── helper ───────────────────────────────────────────────────────

def _apply_audit_stamps(config: Dict[str, Any]):
    now = datetime.now(timezone.utc)
    config.update({
        "created_at": now,
        "created_by": "system",
        "updated_at": now,
        "updated_by": "system"
    })


async def _get_system_seed_doc(
    storage,
    *,
    kind: str,
    wire_id: str,
) -> Dict[str, Any] | None:
    """Find an existing ``__system__`` seed document by wire id or (tenant, name)."""
    wire = str(wire_id or "").strip()
    if not wire:
        return None

    if kind == "agents":
        get_doc = storage.get_agent_configuration
        find_by_name = getattr(storage, "find_agent_configuration_by_name", None)
    elif kind == "workflows":
        get_doc = storage.get_workflow_definition
        find_by_name = getattr(storage, "find_workflow_definition_by_name", None)
    elif kind == "tools":
        get_doc = storage.get_tool_configuration
        find_by_name = getattr(storage, "find_tool_configuration_by_name", None)
    else:
        return None

    existing = await get_doc(wire)
    if existing and str(existing.get("tenant_id") or "__system__") == "__system__":
        return existing

    if find_by_name is not None:
        by_name = await find_by_name("__system__", wire)
        if isinstance(by_name, dict):
            return by_name

    return None


# ── agents ───────────────────────────────────────────────────────

async def seed_agents(storage, yaml_path: str = _DEFAULT_YAML) -> int:
    """Upsert agent_configurations from YAML on every startup.

    Compares each agent config with the existing DB doc and updates
    if there are differences.  This ensures changes in agents.yaml
    (e.g. new ``output_save_key``) propagate automatically on redeploy.

    Returns:
        Number of agents inserted or updated.
    """
    agents = _load_yaml(yaml_path)
    if not agents:
        logger.warning("[SEED] No agents found in %s", yaml_path)
        return 0

    enabled = seed_writes_enabled()
    if not enabled:
        logger.info(
            "[SEED] kind=agent mode=dry-run source=%s item_count=%d "
            "— comparing configs without writing",
            yaml_path,
            len(agents),
        )

    changed = 0
    for agent_cfg in agents:
        agent_cfg = materialize_agent_model_params(agent_cfg)
        try:
            await validate_agent_model_params(
                model=agent_cfg["model"],
                temperature=agent_cfg["temperature"],
                reasoning_effort=agent_cfg["reasoning_effort"],
                storage=storage,
            )
        except (AgentModelParamsValidationError, ModelConfigResolutionError) as exc:
            logger.error(
                "[SEED] kind=agent action=skip agent=%s — invalid model params: %s",
                agent_cfg.get("_id", "?"),
                exc,
            )
            continue
        agent_cfg = normalize_configuration_identity(
            agent_cfg,
            wire_id=str(agent_cfg.get("_id") or "").strip() or None,
        )
        agent_cfg.setdefault("tenant_id", "__system__")
        agent_id = agent_cfg.get("_id", "?")
        if agent_cfg.get("tenant_id") != "__system__":
            logger.info(
                "[SEED] kind=agent action=skip agent=%s tenant_id=%s "
                "— non-system scope owned by Configuration I/O tool",
                agent_id,
                agent_cfg.get("tenant_id"),
            )
            continue
        try:
            existing = await _get_system_seed_doc(storage, kind="agents", wire_id=agent_id)
            if existing and _agent_configs_equal(existing, agent_cfg):
                canon = _canonical_agent_allowlists(existing)
                allowlist_fix = _allowlists_raw_differs(existing, canon)
                baseline_fix = _seed_needs_description_baseline(existing, agent_cfg)
                if allowlist_fix or baseline_fix:
                    to_save = {**existing}
                    if allowlist_fix:
                        to_save.update(canon)
                    if baseline_fix:
                        to_save = _backfill_seed_description_baseline(to_save, agent_cfg)
                    _apply_audit_stamps(to_save)
                    if enabled:
                        await storage.save_agent_configuration(to_save)
                        changed += 1
                        logger.info(
                            "[SEED] kind=agent mode=write action=migrated agent=%s "
                            "— canonicalized allowlists and/or seed description baseline",
                            agent_id,
                        )
                continue  # yaml baseline matches (after canonical compare)

            to_save = normalize_configuration_identity(
                _prepare_seed_description_doc(existing, _merge_agent_seed_doc(existing, agent_cfg)),
                wire_id=str(agent_id),
            )
            _apply_audit_stamps(to_save)
            operation, result = ("update", "updated") if existing else ("insert", "inserted")
            if not enabled:
                changed += 1
                logger.info(
                    "[SEED] kind=agent mode=dry-run action=%s agent=%s "
                    "— skipped write because SEED_ENABLED=false",
                    operation,
                    agent_id,
                )
                continue
            await storage.save_agent_configuration(to_save)
            changed += 1
            logger.info(
                "[SEED] kind=agent mode=write action=%s agent=%s",
                result,
                agent_id,
            )
        except Exception as e:
            logger.error("[SEED] Failed to upsert agent '%s': %s", agent_id, e)

    if changed:
        if enabled:
            logger.info(
                "[SEED] kind=agent mode=write changed=%d source=%s "
                "— upserted configurations",
                changed,
                yaml_path,
            )
        else:
            logger.info(
                "[SEED] kind=agent mode=dry-run changed=%d source=%s "
                "— detected configuration changes without writing",
                changed,
                yaml_path,
            )
    else:
        logger.info(
            "[SEED] kind=agent mode=%s changed=0 source=%s total=%d "
            "— all configurations up-to-date",
            "write" if enabled else "dry-run",
            yaml_path,
            len(agents),
        )
    return changed


# ── workflows ────────────────────────────────────────────────────

def _validate_seed_workflow(workflow: dict) -> None:
    """Same DAG + static-delegation checks as CRUD/bundle import."""
    from api.routes.workflow_definitions import (
        _static_workflow_delegation_violation,
        validate_dag,
    )
    from schemas.configuration_schemas import normalize_workflow_execution_mode, WorkflowNode

    nodes = workflow.get("nodes") or []
    edges = workflow.get("edges") or []
    validation = validate_dag(nodes, edges, default_reads=workflow.get("default_reads"))
    if not validation.valid:
        raise ValueError(f"invalid workflow DAG: {validation.errors}")
    for node in nodes:
        try:
            WorkflowNode.model_validate(node)
        except Exception as exc:
            raise ValueError(f"invalid node '{node.get('id', '?')}': {exc}") from exc
    workflow["execution_mode"] = normalize_workflow_execution_mode(
        workflow.get("execution_mode"),
    )
    violation = _static_workflow_delegation_violation(
        workflow["execution_mode"],
        nodes,
    )
    if violation:
        raise ValueError(
            f"static workflow delegation: {violation['message']} "
            f"(node_id={violation['node_id']})"
        )


async def seed_workflows(storage, json_path: str = _DEFAULT_WORKFLOWS_JSON) -> int:
    """Upsert workflow_definitions from JSON on every startup.

    Returns:
        Number of workflows inserted or updated.
    """
    workflows = _load_json(json_path, key="workflows")
    if not workflows:
        logger.warning("[SEED] No workflows found in %s", json_path)
        return 0

    enabled = seed_writes_enabled()
    if not enabled:
        logger.info(
            "[SEED] kind=workflow mode=dry-run source=%s item_count=%d "
            "— comparing configs without writing",
            json_path,
            len(workflows),
        )

    changed = 0
    for wf in workflows:
        wf.setdefault("tenant_id", "__system__")
        wf_id = wf.get("_id", "?")
        if wf.get("tenant_id") != "__system__":
            logger.info(
                "[SEED] kind=workflow action=skip workflow=%s tenant_id=%s "
                "— non-system scope owned by Configuration I/O tool",
                wf_id,
                wf.get("tenant_id"),
            )
            continue
        try:
            existing = await _get_system_seed_doc(storage, kind="workflows", wire_id=wf_id)
            if existing and _configs_equal(existing, wf):
                if _seed_needs_description_baseline(existing, wf):
                    if not enabled:
                        changed += 1
                        logger.info(
                            "[SEED] kind=workflow mode=dry-run action=migrate workflow=%s "
                            "— would backfill seed description baseline",
                            wf_id,
                        )
                        continue
                    to_save = _backfill_seed_description_baseline(existing, wf)
                    _apply_audit_stamps(to_save)
                    await storage.save_workflow_definition(to_save)
                    changed += 1
                    logger.info(
                        "[SEED] kind=workflow mode=write action=migrated workflow=%s "
                        "— backfilled seed description baseline",
                        wf_id,
                    )
                continue
            operation, result = ("update", "updated") if existing else ("insert", "inserted")
            _validate_seed_workflow(wf)
            if not enabled:
                changed += 1
                logger.info(
                    "[SEED] kind=workflow mode=dry-run action=%s workflow=%s "
                    "— skipped write because SEED_ENABLED=false",
                    operation,
                    wf_id,
                )
                continue

            wf = _prepare_seed_description_doc(existing, wf)
            _apply_audit_stamps(wf)
            await storage.save_workflow_definition(wf)
            changed += 1
            logger.info(
                "[SEED] kind=workflow mode=write action=%s workflow=%s",
                result,
                wf_id,
            )
        except Exception as e:
            logger.error("[SEED] Failed to upsert workflow '%s': %s", wf_id, e)

    if changed:
        if enabled:
            logger.info(
                "[SEED] kind=workflow mode=write changed=%d source=%s "
                "— upserted configurations",
                changed,
                json_path,
            )
        else:
            logger.info(
                "[SEED] kind=workflow mode=dry-run changed=%d source=%s "
                "— detected configuration changes without writing",
                changed,
                json_path,
            )
    else:
        logger.info(
            "[SEED] kind=workflow mode=%s changed=0 source=%s total=%d "
            "— all configurations up-to-date",
            "write" if enabled else "dry-run",
            json_path,
            len(workflows),
        )
    return changed


# ── tools ────────────────────────────────────────────────────────

async def seed_tools(storage, yaml_path: str = _DEFAULT_TOOLS_YAML) -> int:
    """Upsert tool_configurations from YAML on every startup.

    Returns:
        Number of tools inserted or updated.
    """
    tools = _load_yaml_key(yaml_path, key="tools")
    if not tools:
        logger.warning("[SEED] No tools found in %s", yaml_path)
        return 0

    enabled = seed_writes_enabled()
    if not enabled:
        logger.info(
            "[SEED] kind=tool mode=dry-run source=%s item_count=%d "
            "— comparing configs without writing",
            yaml_path,
            len(tools),
        )

    changed = 0
    for tool_cfg in tools:
        tool_cfg = normalize_configuration_identity(
            tool_cfg,
            wire_id=str(tool_cfg.get("_id") or "").strip() or None,
        )
        tool_cfg.setdefault("tenant_id", "__system__")
        tool_cfg.pop("allowed_agents", None)
        tool_id = tool_cfg.get("_id", "?")
        if tool_cfg.get("tenant_id") != "__system__":
            logger.info(
                "[SEED] kind=tool action=skip tool=%s tenant_id=%s "
                "— non-system scope owned by Configuration I/O tool",
                tool_id,
                tool_cfg.get("tenant_id"),
            )
            continue
        try:
            existing = await _get_system_seed_doc(storage, kind="tools", wire_id=tool_id)
            if existing and _tool_configs_equal(existing, tool_cfg):
                if _seed_needs_description_baseline(existing, tool_cfg):
                    if not enabled:
                        changed += 1
                        logger.info(
                            "[SEED] kind=tool mode=dry-run action=migrate tool=%s "
                            "— would backfill seed description baseline",
                            tool_id,
                        )
                        continue
                    to_save = normalize_configuration_identity(
                        _backfill_seed_description_baseline(existing, tool_cfg),
                        wire_id=str(tool_id),
                    )
                    _apply_audit_stamps(to_save)
                    await storage.save_tool_configuration(to_save)
                    changed += 1
                    logger.info(
                        "[SEED] kind=tool mode=write action=migrated tool=%s "
                        "— backfilled seed description baseline",
                        tool_id,
                    )
                continue
            operation, result = ("update", "updated") if existing else ("insert", "inserted")
            if not enabled:
                changed += 1
                logger.info(
                    "[SEED] kind=tool mode=dry-run action=%s tool=%s "
                    "— skipped write because SEED_ENABLED=false",
                    operation,
                    tool_id,
                )
                continue

            from config.tool_configuration_schema import normalize_tool_schema_for_storage

            to_save = normalize_configuration_identity(
                _prepare_seed_description_doc(existing, dict(tool_cfg)),
                wire_id=str(tool_id),
            )
            normalize_tool_schema_for_storage(to_save)
            _apply_audit_stamps(to_save)
            await storage.save_tool_configuration(to_save)
            changed += 1
            logger.info(
                "[SEED] kind=tool mode=write action=%s tool=%s",
                result,
                tool_id,
            )
        except Exception as e:
            logger.error("[SEED] Failed to upsert tool '%s': %s", tool_id, e)

    if changed:
        if enabled:
            logger.info(
                "[SEED] kind=tool mode=write changed=%d source=%s "
                "— upserted configurations",
                changed,
                yaml_path,
            )
        else:
            logger.info(
                "[SEED] kind=tool mode=dry-run changed=%d source=%s "
                "— detected configuration changes without writing",
                changed,
                yaml_path,
            )
    else:
        logger.info(
            "[SEED] kind=tool mode=%s changed=0 source=%s total=%d "
            "— all configurations up-to-date",
            "write" if enabled else "dry-run",
            yaml_path,
            len(tools),
        )
    return changed


async def seed_run_configurations(storage, json_path: str = _DEFAULT_RUN_CONFIGS_JSON) -> int:
    """Upsert built-in run configurations on every startup."""
    store = getattr(storage, "run_config_store", None)
    if not store:
        logger.warning("[SEED] run_config_store unavailable; skipping run configuration seed")
        return 0

    run_configs = _load_json(json_path, key="run_configurations")
    if not run_configs:
        logger.warning("[SEED] No run configurations found in %s", json_path)
        return 0

    changed = 0
    for cfg in run_configs:
        cfg.setdefault("tenant_id", "__system__")
        config_id = cfg.get("_id", "?")
        if cfg.get("tenant_id") != "__system__":
            logger.info(
                "[SEED] kind=run_config action=skip run_config=%s tenant_id=%s "
                "— non-system scope owned by Configuration I/O tool",
                config_id,
                cfg.get("tenant_id"),
            )
            continue
        try:
            existing = await store.get_config(config_id)
            existing_data = existing.model_dump(by_alias=True) if existing else None
            if existing_data and _configs_equal(existing_data, cfg):
                if _seed_needs_description_baseline(existing_data, cfg):
                    prepared = _backfill_seed_description_baseline(existing_data, cfg)
                    payload = RunConfigurationUpdate(
                        metadata=prepared.get("metadata")
                        if isinstance(prepared.get("metadata"), dict)
                        else {},
                    )
                    await store.update_config(config_id, payload)
                    changed += 1
                    logger.info(
                        "[SEED] migrated run configuration '%s' — backfilled seed description baseline",
                        config_id,
                    )
                continue

            if existing:
                prepared = _prepare_seed_description_doc(existing_data, cfg)
                payload = RunConfigurationUpdate(
                    name=cfg["name"],
                    description=prepared.get("description", ""),
                    short_description=prepared.get("short_description"),
                    long_description=prepared.get("long_description"),
                    models=cfg.get("models", {}),
                    is_default=cfg.get("is_default", False),
                    metadata=prepared.get("metadata") if isinstance(prepared.get("metadata"), dict) else {},
                )
                await store.update_config(config_id, payload)
                action = "updated"
            else:
                from schemas.configuration_schemas import RunConfigurationCreate

                prepared = _prepare_seed_description_doc(None, cfg)
                payload = RunConfigurationCreate(
                    _id=cfg["_id"],
                    name=cfg["name"],
                    description=prepared.get("description", ""),
                    short_description=prepared.get("short_description"),
                    long_description=prepared.get("long_description"),
                    models=cfg.get("models", {}),
                    is_default=cfg.get("is_default", False),
                    metadata=prepared.get("metadata") if isinstance(prepared.get("metadata"), dict) else {},
                )
                await store.create_config(payload, tenant_id=cfg.get("tenant_id"))
                action = "inserted"

            changed += 1
            logger.info("[SEED] %s run configuration '%s'", action, config_id)
        except Exception as e:
            logger.error("[SEED] Failed to upsert run configuration '%s': %s", config_id, e)

    if changed:
        logger.info("[SEED] Upserted %d run configurations", changed)
    else:
        logger.info("[SEED] All %d run configurations up-to-date", len(run_configs))
    return changed



# ── comparison helpers ────────────────────────────────────────────

# Keys injected by MongoDB that should be ignored when comparing
_MONGO_INTERNAL_KEYS = frozenset({"_class", "__v"})
_SEED_DESCRIPTION_BASELINE_KEY = "seed_description_baseline"

# Operator MCP allowlists are set via UI/API; yaml baseline keeps [].
_AGENT_ALLOWLIST_KEYS = frozenset({"allowed_tools", "allowed_mcp_tools"})


def _configs_equal(existing: Dict[str, Any], desired: Dict[str, Any]) -> bool:
    """Compare two config dicts, ignoring MongoDB-internal metadata."""
    for key, value in desired.items():
        if key == "description":
            if _seed_description_differs_from_yaml(existing, value):
                return False
            continue
        if existing.get(key) != value:
            return False
    return True


def _seed_compare_skip_keys() -> frozenset[str]:
    return frozenset({
        "_id",
        "name",
        "display_name",
        "created_at",
        "updated_at",
        "created_by",
        "updated_by",
    })


def _seed_description_baseline(doc: Dict[str, Any]) -> str:
    """Yaml-owned description anchor from metadata only (empty until first seed write)."""
    metadata = doc.get("metadata")
    if isinstance(metadata, dict):
        return str(metadata.get(_SEED_DESCRIPTION_BASELINE_KEY) or "").strip()
    return ""


def _set_seed_description_baseline(doc: Dict[str, Any], description: Any) -> None:
    metadata = doc.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    metadata = dict(metadata)
    metadata[_SEED_DESCRIPTION_BASELINE_KEY] = str(description or "").strip()
    doc["metadata"] = metadata


def _seed_description_differs_from_yaml(existing: Dict[str, Any], desired_description: Any) -> bool:
    """Whether yaml description should force a seed write vs existing Mongo doc.

    With a baseline, only baseline drift counts (UI-mirrored short/description is ignored).
    Without baseline, any stored vs yaml drift takes the prepare path so equal-path
    backfill cannot stamp desired without applying it.
    """
    desired = str(desired_description or "").strip()
    baseline = _seed_description_baseline(existing)
    if baseline:
        return baseline != desired
    return str(existing.get("description") or "").strip() != desired


def _seed_needs_description_baseline(
    existing: Dict[str, Any],
    desired: Dict[str, Any],
) -> bool:
    desired_description = str(desired.get("description") or "").strip()
    baseline = _seed_description_baseline(existing)
    if baseline == desired_description:
        return False
    if baseline:
        # Drift belongs on the prepare path, not equal-path backfill.
        return False
    # Safe to stamp only when stored description already matches yaml.
    return str(existing.get("description") or "").strip() == desired_description


def _backfill_seed_description_baseline(
    existing: Dict[str, Any],
    desired: Dict[str, Any],
) -> Dict[str, Any]:
    """Copy existing doc and write yaml description baseline without touching short/long.

    Only stamps desired when it already matches stored description — never claim an
    unapplied yaml text is synchronized.
    """
    updated = dict(existing)
    desired_description = str(desired.get("description") or "").strip()
    stored = str(existing.get("description") or "").strip()
    if stored == desired_description:
        _set_seed_description_baseline(updated, desired_description)
    return updated


def _tool_configs_equal(existing: Dict[str, Any], desired: Dict[str, Any]) -> bool:
    """Compare tool seed yaml to Mongo, normalizing identity and stored schema."""
    from config.tool_configuration_schema import stored_parameters_from_doc

    wire_id = str(desired.get("_id") or existing.get("_id") or "").strip() or None
    if _stored_configuration_identity_differs(existing, wire_id=wire_id):
        return False
    desired_view = normalize_configuration_identity(desired, wire_id=wire_id)
    skip = _seed_compare_skip_keys()
    for key, value in desired_view.items():
        if key in skip:
            continue
        if key == "description":
            if _seed_description_differs_from_yaml(existing, value):
                return False
            continue
        if key == "schema":
            if stored_parameters_from_doc(existing) != stored_parameters_from_doc(
                {"schema": value}
            ):
                return False
            continue
        if existing.get(key) != value:
            return False
    if wire_id:
        normalized_existing = normalize_configuration_identity(existing, wire_id=wire_id)
        for key in ("name", "display_name"):
            if desired_view.get(key) != normalized_existing.get(key):
                return False
    return True


def _canonical_agent_allowlists(doc: Dict[str, Any]) -> Dict[str, List[str]]:
    """Split legacy MCP ids out of ``allowed_tools`` (same rules as API read-path)."""
    from tools.agent_allowed_tools import apply_agent_tool_allowlist_normalization

    norm = apply_agent_tool_allowlist_normalization(doc)
    return {
        "allowed_tools": list(norm.get("allowed_tools") or []),
        "allowed_mcp_tools": list(norm.get("allowed_mcp_tools") or []),
    }


def _allowlists_raw_differs(raw: Dict[str, Any], canonical: Dict[str, List[str]]) -> bool:
    raw_tools = raw.get("allowed_tools") if isinstance(raw.get("allowed_tools"), list) else []
    raw_mcp = raw.get("allowed_mcp_tools") if isinstance(raw.get("allowed_mcp_tools"), list) else []
    return raw_tools != canonical["allowed_tools"] or raw_mcp != canonical["allowed_mcp_tools"]


def _stored_configuration_identity_differs(
    existing: Dict[str, Any],
    *,
    wire_id: str | None,
) -> bool:
    """Return whether Mongo still stores legacy display text in identity fields."""
    if not existing or not wire_id:
        return False
    stored_name = str(existing.get("name") or "").strip()
    if not stored_name:
        return False
    normalized = normalize_configuration_identity(existing, wire_id=wire_id)
    if stored_name != str(normalized.get("name") or "").strip():
        return True
    expected_display = str(normalized.get("display_name") or "").strip()
    if expected_display and str(existing.get("display_name") or "").strip() != expected_display:
        return True
    return False


def _agent_configs_equal(existing: Dict[str, Any], desired: Dict[str, Any]) -> bool:
    """Compare yaml baseline to Mongo using canonical allowlists (legacy MCP-aware)."""
    canon = _canonical_agent_allowlists(existing)
    wire_id = str(desired.get("_id") or existing.get("_id") or "").strip() or None
    if _stored_configuration_identity_differs(existing, wire_id=wire_id):
        return False
    desired_view = normalize_configuration_identity(desired, wire_id=wire_id)
    desired_canon = _canonical_agent_allowlists(desired_view)
    skip = _seed_compare_skip_keys()
    for key, value in desired_view.items():
        if key in skip:
            continue
        if key == "description":
            if _seed_description_differs_from_yaml(existing, value):
                return False
            continue
        if key == "allowed_tools":
            if canon["allowed_tools"] != desired_canon["allowed_tools"]:
                return False
            continue
        if key == "allowed_mcp_tools":
            if canon["allowed_mcp_tools"] != desired_canon["allowed_mcp_tools"]:
                if (
                    not desired_canon["allowed_mcp_tools"]
                    and canon["allowed_tools"] == desired_canon["allowed_tools"]
                ):
                    continue
                return False
            continue
        if existing.get(key) != value:
            return False
    if wire_id:
        normalized_existing = normalize_configuration_identity(existing, wire_id=wire_id)
        for key in ("name", "display_name"):
            if desired_view.get(key) != normalized_existing.get(key):
                return False
    return True


def _prepare_seed_description_doc(
    existing: Dict[str, Any] | None,
    desired: Dict[str, Any],
) -> Dict[str, Any]:
    """Merge seed baseline and resync short/long from legacy description when yaml owns it."""
    from schemas.configuration_schemas import (
        preserve_custom_entity_descriptions,
        sync_entity_descriptions_for_save,
    )

    merged = {**(existing or {}), **desired}
    desired_description = str(desired.get("description") or "").strip()
    existing_baseline = _seed_description_baseline(existing) if existing else ""
    stored = str((existing or {}).get("description") or "").strip()
    short = str((existing or {}).get("short_description") or "").strip()
    long = str((existing or {}).get("long_description") or "").strip()
    # Explicit empty long is an admin clear (same as API/MCP), not "still yaml-shaped".
    has_cleared_long = bool(
        existing and "long_description" in existing and not long
    )
    has_admin_custom = bool(
        existing
        and (
            has_cleared_long
            or (long and long not in (stored, short, desired_description))
            or (
                short
                and short != stored
                and short != desired_description
                and short != desired_description[:256]
            )
        )
    )
    # Baseline drift always applies yaml. Without baseline, apply when stored text
    # drifted and short/long still look yaml-owned (not admin-custom).
    yaml_description_changed = bool(existing_baseline) and desired_description != existing_baseline
    unbaselined_yaml_drift = (
        bool(existing)
        and not existing_baseline
        and stored != desired_description
        and not has_admin_custom
    )
    if yaml_description_changed or unbaselined_yaml_drift:
        if "short_description" not in desired:
            merged.pop("short_description", None)
        if "long_description" not in desired:
            merged.pop("long_description", None)
    elif existing:
        preserve_custom_entity_descriptions(existing, merged)
    sync_entity_descriptions_for_save(merged, prior=existing)
    # sync mirrors description → short for cards; never let that card text become
    # seed_description_baseline. Restore a longer yaml/legacy blob when sync collapsed it.
    if not yaml_description_changed and not unbaselined_yaml_drift and existing:
        from schemas.configuration_schemas import SHORT_DESCRIPTION_MAX_LEN

        post = str(merged.get("description") or "").strip()
        long_now = str(merged.get("long_description") or "").strip()
        if (
            desired_description
            and len(desired_description) > SHORT_DESCRIPTION_MAX_LEN
            and post != desired_description
            and (stored == desired_description or long_now == desired_description)
        ):
            merged["description"] = desired_description
        elif (
            desired_description
            and stored == desired_description
            and post != desired_description
            and len(stored) > len(post)
        ):
            merged["description"] = desired_description
        elif (
            has_admin_custom
            and stored != desired_description
            and desired_description
            and not existing_baseline
        ):
            merged["description"] = desired_description
    _set_seed_description_baseline(merged, desired_description)
    return merged


def _merge_agent_seed_doc(
    existing: Dict[str, Any] | None,
    desired: Dict[str, Any],
) -> Dict[str, Any]:
    """Apply yaml baseline; preserve operator MCP (including legacy ``allowed_tools``)."""
    from tools.agent_allowed_tools import apply_agent_tool_allowlist_normalization

    merged = dict(desired)
    if not existing:
        return apply_agent_tool_allowlist_normalization(merged)

    canon = _canonical_agent_allowlists(existing)
    yaml_mcp = merged.get("allowed_mcp_tools") if isinstance(merged.get("allowed_mcp_tools"), list) else []
    if not yaml_mcp and canon["allowed_mcp_tools"]:
        merged["allowed_mcp_tools"] = list(canon["allowed_mcp_tools"])
    return apply_agent_tool_allowlist_normalization(merged)


# ── file loaders ─────────────────────────────────────────────────

def _load_yaml(path: str) -> List[Dict[str, Any]]:
    """Read agents list from YAML file."""
    return _load_yaml_key(path, key="agents")


def _load_yaml_key(path: str, key: str) -> List[Dict[str, Any]]:
    """Read a list of documents from a YAML file under *key*."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        if isinstance(data, dict):
            return data.get(key, [])
        if isinstance(data, list):
            return data
        return []
    except FileNotFoundError:
        logger.error("[SEED] YAML file not found: %s", path)
        return []
    except Exception as e:
        logger.error("[SEED] Failed to parse YAML %s: %s", path, e)
        return []


def _load_json(path: str, key: str = "workflows") -> List[Dict[str, Any]]:
    """Read list of documents from a JSON file under *key*."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data.get(key, [])
        if isinstance(data, list):
            return data
        return []
    except FileNotFoundError:
        logger.error("[SEED] JSON file not found: %s", path)
        return []
    except Exception as e:
        logger.error("[SEED] Failed to parse JSON %s: %s", path, e)
        return []

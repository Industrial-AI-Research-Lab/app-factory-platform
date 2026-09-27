"""CRUD endpoints for workflow_definitions.

Prefix: /api/configurations/workflows
Auth: require_auth (all endpoints), tenant-scoped queries.
"""

import logging
from collections import defaultdict, deque
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException

from api.deps import get_storage
from api.auth.tenant_context import TenantContext, get_tenant_context
from context.shared_context import (
    FULL_CONTEXT_READS_TOKEN,
    READ_ONLY_CONTEXT_KEYS,
    WORKFLOW_DEFAULT_READS_TOKEN,
)
from config.configuration_cow import prepare_configuration_cow_update
from config.configuration_reference_validation import (
    known_tenant_ids_from_storage,
    known_wire_names_from_storage,
    normalize_workflow_node_references,
)
from config.configuration_resolution import (
    agent_wire_name_from_doc,
    resolve_tenant_config_for_read,
)
from config.agent_loader import dedupe_agent_configs_by_wire_name
from orchestration.map_node_contract import map_node_errors
from orchestration.tool_node_contract import binding_errors, tool_node_errors
from orchestration.validator_operators import (
    FIELD_OPERATORS,
    VALUE_RELATION_OPERATORS,
    missing_path_error,
    needs_other_key,
    relation_param_errors,
)
from schemas.configuration_schemas import (
    DAGValidateRequest,
    DAGValidationResult,
    ENTITY_DESCRIPTION_FIELDS,
    WorkflowDefinitionCreate,
    WorkflowDefinitionUpdate,
    WorkflowDefinitionResponse,
    sync_entity_descriptions_for_save,
    normalize_workflow_execution_mode,
)

logger = logging.getLogger(__name__)

SYSTEM_TENANT_ID = "__system__"

router = APIRouter(
    prefix="/api/configurations/workflows",
    tags=["configurations"],
)


# ---------------------------------------------------------------------------
# LIST
# ---------------------------------------------------------------------------

@router.get("/", response_model=List[WorkflowDefinitionResponse])
async def list_workflow_definitions(
    enabled_only: bool = True,
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Return workflow definitions scoped to caller's tenant + __system__."""
    storage = _storage_or_fail()
    tid = None if ctx.is_root else ctx.tenant_id
    workflows = await storage.get_workflow_definitions(tenant_id=tid)
    if tid and not ctx.is_root:
        if enabled_only:
            workflows = dedupe_agent_configs_by_wire_name(
                [w for w in workflows if isinstance(w, dict)],
                str(tid),
                enabled_only=True,
            )
    return workflows


# ---------------------------------------------------------------------------
# VALIDATE (standalone — accepts raw nodes/edges, no workflow_id needed)
# Must be declared BEFORE /{workflow_id} routes to avoid path collision.
# ---------------------------------------------------------------------------

@router.post("/validate", response_model=DAGValidationResult)
async def validate_dag_standalone(body: DAGValidateRequest):
    """Validate a workflow DAG without saving. Accepts raw nodes + edges."""
    result = validate_dag(body.nodes, body.edges, default_reads=body.default_reads)
    return _dag_validation_with_static_mode(result, body.execution_mode, body.nodes)


# ---------------------------------------------------------------------------
# GET ONE
# ---------------------------------------------------------------------------

@router.get("/{workflow_id}", response_model=WorkflowDefinitionResponse)
async def get_workflow_definition(workflow_id: str, ctx: TenantContext = Depends(get_tenant_context)):
    """Return a single workflow definition by ID."""
    storage = _storage_or_fail()
    doc = await _get_workflow_scoped(storage, workflow_id, ctx)
    if not doc:
        raise HTTPException(status_code=404, detail=f"Workflow '{workflow_id}' not found")
    if not ctx.is_root and doc.get("tenant_id") not in (ctx.tenant_id, "__system__", None):
        raise HTTPException(status_code=404, detail=f"Workflow '{workflow_id}' not found")
    if not ctx.is_root:
        doc = await resolve_tenant_config_for_read(
            doc,
            tenant_id=str(ctx.tenant_id),
            resolve_configuration=storage.resolve_workflow_definition,
        )
    return doc


# ---------------------------------------------------------------------------
# CREATE
# ---------------------------------------------------------------------------

@router.post("/", response_model=WorkflowDefinitionResponse, status_code=201)
async def create_workflow_definition(
    body: WorkflowDefinitionCreate, ctx: TenantContext = Depends(get_tenant_context),
):
    """Create a new workflow definition (validates DAG first), stamped with tenant_id."""
    storage = _storage_or_fail()

    tenant_id = _workflow_lookup_tenant(ctx, for_write=True) or SYSTEM_TENANT_ID
    wire = str(body.id).strip()
    existing = await storage.find_workflow_definition_by_name(tenant_id, wire)
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Workflow '{wire}' already exists for tenant '{tenant_id}'",
        )

    # Validate DAG
    nodes_raw = [n.model_dump(exclude_none=True) for n in body.nodes]
    edges_raw = [e.model_dump(by_alias=True, exclude_none=True) for e in body.edges]
    validation = validate_dag(nodes_raw, edges_raw, default_reads=body.default_reads)
    if not validation.valid:
        raise HTTPException(status_code=422, detail={
            "message": "Invalid workflow DAG",
            "errors": validation.errors,
        })

    _normalize_edges(edges_raw)
    _normalize_nodes(nodes_raw)
    _validate_static_workflow_nodes(body.execution_mode, nodes_raw)

    from config.configuration_resolution import normalize_configuration_identity

    doc = normalize_configuration_identity(
        {
            "name": body.name,
            "description": body.description,
            "short_description": body.short_description,
            "long_description": body.long_description,
            "execution_mode": body.execution_mode,
            "nodes": nodes_raw,
            "edges": edges_raw,
            "is_default": body.is_default,
            "tenant_id": SYSTEM_TENANT_ID if ctx.is_root else ctx.tenant_id,
        },
        wire_id=wire,
    )
    if body.default_reads is not None:
        doc["default_reads"] = body.default_reads
    # Cherry-picked like default_reads above: the doc dict is built manually here,
    # so a field Pydantic accepted but this block doesn't copy is silently dropped
    # on create (the engine would then always see the guard as off/default).
    if body.run_timeout_seconds is not None:
        doc["run_timeout_seconds"] = body.run_timeout_seconds
    if body.max_iterations is not None:
        doc["max_iterations"] = body.max_iterations
    # Same manual-copy requirement as the cherry-picked fields above (create hand-builds
    # the doc). Stored unconditionally — an empty list keeps the launch screen on manual entry.
    doc["prompts"] = [p.model_dump(exclude_none=True) for p in body.prompts]
    sync_entity_descriptions_for_save(doc)
    try:
        tenant_ids = await known_tenant_ids_from_storage(storage)
        wire_names = await known_wire_names_from_storage(storage)
        await normalize_workflow_node_references(
            doc.get("nodes"),
            tenant_id=str(doc.get("tenant_id") or ctx.tenant_id or SYSTEM_TENANT_ID),
            storage=storage,
            known_tenant_ids=tenant_ids,
            known_wire_names=wire_names,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    saved_id = await storage.save_workflow_definition(doc, actor_id=ctx.user_id)
    persisted = await storage.get_workflow_definition(saved_id)
    if not persisted:
        persisted = {**doc, "_id": saved_id}
    logger.info("[CONFIG-API] Created workflow '%s' (tenant=%s)", saved_id, ctx.tenant_id)
    return persisted


# ---------------------------------------------------------------------------
# UPDATE (partial)
# ---------------------------------------------------------------------------

@router.put("/{workflow_id}", response_model=WorkflowDefinitionResponse)
async def update_workflow_definition(
    workflow_id: str, body: WorkflowDefinitionUpdate, ctx: TenantContext = Depends(get_tenant_context),
):
    """Update an existing workflow definition (partial merge)."""
    storage = _storage_or_fail()

    existing = await _get_workflow_scoped(storage, workflow_id, ctx)
    if not existing:
        raise HTTPException(status_code=404, detail=f"Workflow '{workflow_id}' not found")

    if not ctx.is_root and existing.get("tenant_id") not in (ctx.tenant_id, SYSTEM_TENANT_ID, None):
        raise HTTPException(status_code=403, detail="Cannot modify config from another tenant")

    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    new_name = updates.get("name")
    if new_name is not None and str(new_name).strip() != str(existing.get("name") or "").strip():
        owner_tenant = str(existing.get("tenant_id") or ctx.tenant_id or SYSTEM_TENANT_ID)
        had_wire = agent_wire_name_from_doc(existing, runtime_tenant_id=owner_tenant)
        new_wire = agent_wire_name_from_doc(
            {**existing, "name": str(new_name).strip()}, runtime_tenant_id=owner_tenant,
        )
        # body.name is the wire identity only when _id is an opaque UUID; when _id is itself
        # a wire name, name is just a display label and may be free text. Reject a rename
        # that strips the workflow of ANY resolvable wire name (the bundle/runtime identity)
        # — that's how a hyphenated wire name slips in via a direct PUT. Keeping an already
        # unresolvable legacy name is allowed (had_wire falsy → not guarded).
        if had_wire and not new_wire:
            # Name is not wire-valid — keep wire name, save user input as display label
            updates.pop("name", None)
            updates["display_name"] = str(new_name).strip()

        # Reject rename that would collide with an existing workflow's wire name.
        # Only check on direct-update path: CoW preserves the old wire name
        # (normalize_configuration_identity forces name back to had_wire), so
        # there is nothing to collide on inherited (__system__) workflows.
        is_direct_update = ctx.is_root or existing.get("tenant_id") in (ctx.tenant_id, None)
        if is_direct_update and new_wire and new_wire != had_wire:
            collision = await storage.find_workflow_definition_by_name(owner_tenant, new_wire)
            if collision and str(collision["_id"]) != str(workflow_id):
                raise HTTPException(
                    status_code=409,
                    detail=f"A workflow named '{new_name}' already exists",
                )

    # Serialize nodes/edges from the Pydantic models directly (not from
    # model_dump output) so that aliases are applied correctly:
    #   WorkflowEdge.source → "from", WorkflowEdge.target → "to"
    if body.nodes is not None:
        updates["nodes"] = [n.model_dump(exclude_none=True) for n in body.nodes]
    if body.edges is not None:
        updates["edges"] = [e.model_dump(by_alias=True, exclude_none=True) for e in body.edges]

    try:
        if ctx.is_root or existing.get("tenant_id") in (ctx.tenant_id, None):
            merged = {**existing, **updates}
            target_id = workflow_id
        else:
            merged, target_id = await prepare_configuration_cow_update(
                existing,
                tenant_id=str(ctx.tenant_id),
                updates=updates,
                resolve_configuration=storage.resolve_workflow_definition,
                get_configuration=storage.get_workflow_definition,
                find_by_name=storage.find_workflow_definition_by_name,
            )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if "default_reads" in updates and updates["default_reads"] is None:
        merged.pop("default_reads", None)
    if ENTITY_DESCRIPTION_FIELDS & updates.keys():
        sync_entity_descriptions_for_save(
            merged,
            touched=ENTITY_DESCRIPTION_FIELDS & frozenset(updates.keys()),
            prior=existing,
        )
    try:
        merged["execution_mode"] = normalize_workflow_execution_mode(merged.get("execution_mode"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _normalize_edges(merged.get("edges", []))
    _normalize_nodes(merged.get("nodes", []))
    try:
        tenant_ids = await known_tenant_ids_from_storage(storage)
        wire_names = await known_wire_names_from_storage(storage)
        owner_tenant = str(merged.get("tenant_id") or ctx.tenant_id or SYSTEM_TENANT_ID)
        await normalize_workflow_node_references(
            merged.get("nodes"),
            tenant_id=owner_tenant,
            storage=storage,
            known_tenant_ids=tenant_ids,
            known_wire_names=wire_names,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    nodes = merged.get("nodes", [])
    edges = merged.get("edges", [])
    validation = validate_dag(nodes, edges, default_reads=merged.get("default_reads"))
    if not validation.valid:
        raise HTTPException(status_code=422, detail={
            "message": "Invalid workflow DAG after merge",
            "errors": validation.errors,
        })

    _validate_static_workflow_nodes(
        normalize_workflow_execution_mode(merged.get("execution_mode")),
        nodes,
    )

    if target_id == workflow_id:
        # Direct update — _id stays fixed, rename is just $set on name
        owner_tenant = str(merged.get("tenant_id") or ctx.tenant_id or SYSTEM_TENANT_ID)
        saved_id = await storage.update_workflow_definition_by_id(
            str(existing["_id"]), owner_tenant, merged, actor_id=ctx.user_id,
        )
        if not saved_id:
            raise HTTPException(status_code=404, detail=f"Workflow '{workflow_id}' not found or not owned by tenant")
    else:
        # CoW: creating a new tenant-scoped override
        saved_id = await storage.save_workflow_definition(merged, actor_id=ctx.user_id)
    persisted = await storage.get_workflow_definition(saved_id or str(existing["_id"]))


    if not persisted:
        persisted = {**merged, "_id": saved_id}
    logger.info("[CONFIG-API] Updated workflow '%s' fields=%s", saved_id, list(updates.keys()))
    return persisted


# ---------------------------------------------------------------------------
# DELETE
# ---------------------------------------------------------------------------

@router.delete("/{workflow_id}", status_code=204)
async def delete_workflow_definition(workflow_id: str, ctx: TenantContext = Depends(get_tenant_context)):
    """Delete a workflow definition."""
    storage = _storage_or_fail()

    existing = await _get_workflow_scoped(storage, workflow_id, ctx)
    if not existing:
        raise HTTPException(status_code=404, detail=f"Workflow '{workflow_id}' not found")
    if not ctx.is_root and existing.get("tenant_id") not in (ctx.tenant_id, SYSTEM_TENANT_ID, None):
        raise HTTPException(status_code=404, detail=f"Workflow '{workflow_id}' not found")

    effective = existing
    if not ctx.is_root:
        effective = await resolve_tenant_config_for_read(
            existing,
            tenant_id=str(ctx.tenant_id),
            resolve_configuration=storage.resolve_workflow_definition,
        )
        if str(effective.get("tenant_id") or "") == SYSTEM_TENANT_ID:
            raise HTTPException(status_code=403, detail="Cannot delete config from another tenant")

    if not ctx.is_root and effective.get("tenant_id") not in (ctx.tenant_id, None):
        raise HTTPException(status_code=403, detail="Cannot delete config from another tenant")

    effective_id = str(effective.get("_id") or workflow_id)
    await storage.delete_workflow_definition(effective_id)
    logger.info("[CONFIG-API] Deleted workflow '%s'", effective_id)


# ---------------------------------------------------------------------------
# VALIDATE (standalone endpoint)
# ---------------------------------------------------------------------------

@router.post("/{workflow_id}/validate", response_model=DAGValidationResult)
async def validate_workflow(workflow_id: str, ctx: TenantContext = Depends(get_tenant_context)):
    """Validate the DAG of an existing workflow definition."""
    storage = _storage_or_fail()
    doc = await _get_workflow_scoped(storage, workflow_id, ctx)
    if not doc:
        raise HTTPException(status_code=404, detail=f"Workflow '{workflow_id}' not found")
    if not ctx.is_root and doc.get("tenant_id") not in (ctx.tenant_id, SYSTEM_TENANT_ID, None):
        raise HTTPException(status_code=404, detail=f"Workflow '{workflow_id}' not found")
    if not ctx.is_root:
        doc = await resolve_tenant_config_for_read(
            doc,
            tenant_id=str(ctx.tenant_id),
            resolve_configuration=storage.resolve_workflow_definition,
        )

    return _dag_validation_with_static_mode(
        validate_dag(
            doc.get("nodes", []),
            doc.get("edges", []),
            default_reads=doc.get("default_reads"),
        ),
        normalize_workflow_execution_mode(doc.get("execution_mode")),
        doc.get("nodes", []),
    )


# ===================================================================
# DAG Validation Logic
# ===================================================================

def validate_dag(
    nodes: list,
    edges: list,
    default_reads: Optional[List[str]] = None,
) -> DAGValidationResult:
    """Validate a workflow DAG.

    Checks:
    1. Exactly 1 'start' and 1 'end' node
    2. All edge endpoints reference existing nodes
    3. Phase nodes define either task_type or description
    4. No cycles (topological sort via Kahn's algorithm)
    """
    errors: list[str] = []
    warnings: list[str] = []

    node_ids = {n["id"] for n in nodes}
    node_types = {n["id"]: n.get("type", "") for n in nodes}

    # 0. Workflow-level contract fields
    _validate_reads_list(
        "workflow.default_reads",
        default_reads,
        errors,
        allow_workflow_default_token=False,
    )

    # 1. Start / end nodes
    start_nodes = [nid for nid, ntype in node_types.items() if ntype == "start"]
    end_nodes = [nid for nid, ntype in node_types.items() if ntype == "end"]

    if len(start_nodes) == 0:
        errors.append("Missing 'start' node")
    elif len(start_nodes) > 1:
        errors.append(f"Multiple 'start' nodes: {start_nodes}")

    if len(end_nodes) == 0:
        errors.append("Missing 'end' node")
    elif len(end_nodes) > 1:
        errors.append(f"Multiple 'end' nodes: {end_nodes}")

    # 2. Edge endpoints exist
    for edge in edges:
        src = edge.get("from", edge.get("source", ""))
        tgt = edge.get("to", edge.get("target", ""))
        if src not in node_ids:
            errors.append(f"Edge source '{src}' not in nodes")
        if tgt not in node_ids:
            errors.append(f"Edge target '{tgt}' not in nodes")

    # 3. Phase / A2A node contracts
    for node in nodes:
        node_type = node.get("type")
        node_id = node.get("id", "<unknown>")
        errors.extend(binding_errors(node))

        if node_type == "phase":
            has_task_type = bool(node.get("task_type"))
            has_description = bool(str(node.get("description") or "").strip())
            # Auction-only: bidders judge fit by reading task_type/description.
            # A direct node already names its agent — an empty pair means
            # "system prompt + previous output is the whole instruction"
            # (the engine defaults task_type to the node id).
            if node.get("agent_selection") != "direct" and not has_task_type and not has_description:
                errors.append(
                    f"Phase node '{node_id}' runs an auction but has neither "
                    f"'task_type' nor 'description' for agents to bid on"
                )

            if node.get("agent_selection") == "direct" and not str(node.get("agent_type") or "").strip():
                errors.append(
                    f"Phase node '{node_id}' uses direct selection but has no agent_type"
                )

            _validate_reads_list(
                f"Phase node '{node_id}' reads",
                node.get("reads"),
                errors,
                allow_workflow_default_token=True,
            )
            _validate_writes_list(f"Phase node '{node_id}' writes", node.get("writes"), errors)
            _validate_max_retries(node_id, node.get("max_retries"), errors)
            _validate_max_output_repairs(
                node_id, node.get("max_output_repairs"), errors
            )
        elif node_type == "tool":
            errors.extend(tool_node_errors(node))
            _validate_reads_list(
                f"Tool node '{node_id}' reads",
                node.get("reads"),
                errors,
                allow_workflow_default_token=True,
            )
            _validate_writes_list(f"Tool node '{node_id}' writes", node.get("writes"), errors)
        elif node_type == "map":
            errors.extend(map_node_errors(node))
            _validate_reads_list(
                f"Map node '{node_id}' reads",
                node.get("reads"),
                errors,
                allow_workflow_default_token=True,
            )
            _validate_writes_list(f"Map node '{node_id}' writes", node.get("writes"), errors)
            item_checks = node.get("item_checks")
            if isinstance(item_checks, list) and item_checks:
                _validate_validator_node_contract(
                    f"{node_id}.item_checks", {"checks": item_checks}, errors
                )
        elif node_type == "a2a_agent":
            _validate_a2a_node_contract(node_id, node, errors)
        elif node_type == "validator":
            _validate_validator_node_contract(node_id, node, errors)
            has_rejected = any(
                (e.get("from", e.get("source", "")) == node_id and e.get("condition") == "rejected")
                for e in edges
            )
            if not has_rejected:
                warnings.append(
                    f"Validator node '{node_id}' has no 'rejected' edge — on fail the workflow terminates"
                )

    # 4. Cycle detection (Kahn's algorithm)
    # Skip "rejected" back-edges from approval_gate, validator and map nodes — they
    # are controlled retry loops, not real cycles (same as WorkflowEngine._check_no_cycles).
    in_degree: dict[str, int] = {nid: 0 for nid in node_ids}
    adjacency: dict[str, list[str]] = defaultdict(list)

    for edge in edges:
        src = edge.get("from", edge.get("source", ""))
        tgt = edge.get("to", edge.get("target", ""))
        if node_types.get(src) in ("approval_gate", "validator", "map") and edge.get("condition") == "rejected":
            continue
        if src in node_ids and tgt in node_ids:
            adjacency[src].append(tgt)
            in_degree[tgt] += 1

    queue: deque[str] = deque(nid for nid, deg in in_degree.items() if deg == 0)
    visited = 0
    while queue:
        node = queue.popleft()
        visited += 1
        for neighbor in adjacency[node]:
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)

    if visited < len(node_ids):
        cycle_nodes = [nid for nid, deg in in_degree.items() if deg > 0]
        errors.append(f"Cycle detected involving nodes: {cycle_nodes}")

    # Warnings
    orphan_nodes = node_ids - {
        e.get("from", e.get("source", "")) for e in edges
    } - {
        e.get("to", e.get("target", "")) for e in edges
    }
    if orphan_nodes:
        warnings.append(f"Orphan nodes (no edges): {sorted(orphan_nodes)}")

    return DAGValidationResult(valid=len(errors) == 0, errors=errors, warnings=warnings)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _static_workflow_delegation_violation(
    execution_mode: str,
    nodes: list,
) -> Optional[dict]:
    """Return structured violation for static workflow + can_delegate nodes."""
    if normalize_workflow_execution_mode(execution_mode) != "static":
        return None
    for node in nodes:
        if node.get("type") == "phase" and node.get("can_delegate") is True:
            return {
                "code": "static_workflow_delegation",
                "message": (
                    "Static workflow cannot contain phase nodes with can_delegate=true"
                ),
                "node_id": node.get("id", "<unknown>"),
            }
    return None


def _dag_validation_with_static_mode(
    result: DAGValidationResult,
    execution_mode: str,
    nodes: list,
) -> DAGValidationResult:
    violation = _static_workflow_delegation_violation(execution_mode, nodes)
    if not violation:
        return result
    msg = f"{violation['message']} (node_id={violation['node_id']})"
    return DAGValidationResult(
        valid=False,
        errors=[*result.errors, msg],
        warnings=result.warnings,
    )


def _validate_static_workflow_nodes(execution_mode: str, nodes: list) -> None:
    """Static workflows cannot contain delegation-enabled phase nodes."""
    violation = _static_workflow_delegation_violation(execution_mode, nodes)
    if violation:
        raise HTTPException(status_code=422, detail=violation)


def _storage_or_fail():
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")
    return storage


def _workflow_lookup_tenant(ctx: TenantContext, *, for_write: bool = False) -> str | None:
    """Tenant scope for workflow wire-name resolution."""
    if ctx.is_root:
        return SYSTEM_TENANT_ID if for_write else None
    return str(ctx.tenant_id)


async def _get_workflow_scoped(
    storage,
    workflow_id: str,
    ctx: TenantContext,
):
    return await storage.get_workflow_definition(
        workflow_id,
        tenant_id=_workflow_lookup_tenant(ctx),
    )


def _normalize_key_list(value: Any) -> Any:
    """Trim string key arrays while preserving explicit empty arrays.

    a2a_agent nodes carry structured reads/writes (dict entries); those are kept
    verbatim. Plain string keys are trimmed + de-duped as before, so phase-node
    configs normalize identically.
    """
    if value is None or not isinstance(value, list):
        return value

    normalized: list = []
    seen: set[str] = set()
    for item in value:
        if isinstance(item, dict):
            normalized.append(item)
            continue
        key = str(item or "").strip()
        if not key or key in seen:
            continue
        normalized.append(key)
        seen.add(key)
    return normalized


def _normalize_nodes(nodes: list) -> list:
    """Normalize contract key arrays in-place before persisting definitions."""
    for node in nodes:
        if "reads" in node:
            node["reads"] = _normalize_key_list(node.get("reads"))
        if "writes" in node:
            node["writes"] = _normalize_key_list(node.get("writes"))
        for key in [k for k, v in node.items() if v is None]:
            del node[key]
    return nodes


def _validate_reads_list(
    label: str,
    value: Any,
    errors: list[str],
    allow_workflow_default_token: bool = False,
) -> None:
    if value is None:
        return
    if not isinstance(value, list):
        errors.append(f"{label} must be a list")
        return

    keys: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            errors.append(f"{label} contains an empty or non-string key")
            continue
        keys.append(item.strip())

    if FULL_CONTEXT_READS_TOKEN in keys and len(keys) > 1:
        errors.append(f"{label} cannot combine '*' with other keys")

    if WORKFLOW_DEFAULT_READS_TOKEN in keys and not allow_workflow_default_token:
        errors.append(f"{label} cannot contain '{WORKFLOW_DEFAULT_READS_TOKEN}'")

    if WORKFLOW_DEFAULT_READS_TOKEN in keys and FULL_CONTEXT_READS_TOKEN in keys:
        errors.append(
            f"{label} cannot combine '{WORKFLOW_DEFAULT_READS_TOKEN}' with '*'"
        )


def _validate_writes_list(label: str, value: Any, errors: list[str]) -> None:
    if value is None:
        return
    if not isinstance(value, list):
        errors.append(f"{label} must be a list")
        return

    for item in value:
        if not isinstance(item, str) or not item.strip():
            errors.append(f"{label} contains an empty or non-string key")
            continue
        key = item.strip()
        if key == FULL_CONTEXT_READS_TOKEN:
            errors.append(f"{label} cannot contain '*'")
        if key == WORKFLOW_DEFAULT_READS_TOKEN:
            errors.append(f"{label} cannot contain '{WORKFLOW_DEFAULT_READS_TOKEN}'")
        if key in READ_ONLY_CONTEXT_KEYS:
            errors.append(f"{label} contains read-only key '{key}'")


def _validate_a2a_node_contract(node_id: str, node: dict, errors: list[str]) -> None:
    """A2A node contract, mirroring WorkflowEngine.validate_dag so a malformed a2a node is
    rejected at create/import instead of raising uncaught mid-run (which leaves the run stuck
    "running"). A2A reads/writes are lists of DICTs ({"artifact_name": ...}) — a different
    shape from phase string-lists — so they must NOT go through _validate_writes_list, which
    requires strings and would reject the correct a2a shape. Keep messages identical to the
    engine's so both validators speak with one voice."""
    if not node.get("server_id"):
        errors.append(f"A2A node '{node_id}' must define 'server_id'")
    for field in ("reads", "writes"):
        if field not in node:
            errors.append(f"A2A node '{node_id}' must define '{field}' (can be empty list)")
        elif not isinstance(node.get(field), list):
            errors.append(f"A2A node '{node_id}' '{field}' must be a list")
    writes = node.get("writes")
    if isinstance(writes, list):
        for i, write in enumerate(writes):
            if not isinstance(write, dict):
                errors.append(f"A2A node '{node_id}' writes[{i}] must be an object")
            elif "artifact_name" not in write:
                errors.append(f"A2A node '{node_id}' writes[{i}] missing 'artifact_name'")

_VALIDATOR_CHECK_KINDS = {"structural", "json_schema", "value_relation", "id_set_equals"}
_VALIDATOR_VALUE_TYPES = {"dict", "array", "string", "number", "bool"}
# Only these have __len__ at runtime (validators.py::_check_structural) — a
# min_length/max_length paired with "number"/"bool" always rejects, no matter
# the actual value, so it must die at save-time rather than mid-run.
_VALIDATOR_LENGTH_COMPATIBLE_TYPES = {"dict", "array", "string"}


def _validate_value_relation_check(
    node_id: str,
    field_name: str,
    index: int,
    check: dict,
    errors: list,
) -> None:
    operator = check.get("operator")
    for path_field in ("key", "other_key") if needs_other_key(check) else ("key",):
        path = check.get(path_field)
        if isinstance(path, str) and path.strip():
            continue
        errors.append(
            f"Validator node '{node_id}' {field_name}[{index}] "
            f"{missing_path_error(path_field, operator)}"
        )
    if not isinstance(operator, str) or operator not in VALUE_RELATION_OPERATORS:
        errors.append(
            f"Validator node '{node_id}' {field_name}[{index}] has unknown "
            f"value_relation operator '{operator}'"
        )
        return
    errors.extend(
        f"Validator node '{node_id}' {field_name}[{index}] {error}"
        for error in relation_param_errors(operator, check)
    )
    if operator in FIELD_OPERATORS and (
        not isinstance(check.get("field"), str) or not check["field"].strip()
    ):
        errors.append(
            f"Validator node '{node_id}' {operator} requires a non-empty field"
        )
    fields = check.get("fields")
    if operator == "same_item_ids" and fields is not None:
        if (
            not isinstance(fields, list)
            or not fields
            or any(not isinstance(field, str) or not field.strip() for field in fields)
            or len(fields) != len(set(fields))
        ):
            errors.append(
                f"Validator node '{node_id}' {field_name}[{index}] same_item_ids "
                "fields must be non-empty unique strings"
            )


def _validate_validator_node_contract(node_id: str, node: dict, errors: list) -> None:
    """Validator checks are executed verbatim by the engine, so malformed
    entries must die at save-time, not mid-run."""
    # Per-validator reject→retry cap (AppFactory-77 F3, ADR-0011). Same shape/bounds as
    # phase max_retries; a malformed value would otherwise fall back to "no cap" at
    # runtime, silently dropping a guard the author asked for — reject it here instead.
    cap = node.get("max_reject_retries")
    if cap is not None:
        if isinstance(cap, bool) or not isinstance(cap, int):
            errors.append(f"Validator node '{node_id}' max_reject_retries must be an integer")
        elif cap < 0 or cap > 10:
            errors.append(f"Validator node '{node_id}' max_reject_retries must be between 0 and 10")
    checks = node.get("checks")
    if not checks:
        errors.append(f"Validator node '{node_id}' has no checks")
        return
    if not isinstance(checks, list):
        errors.append(f"Validator node '{node_id}' checks must be a list")
        return
    for i, check in enumerate(checks):
        if not isinstance(check, dict):
            errors.append(f"Validator node '{node_id}' checks[{i}] must be an object")
            continue
        if not str(check.get("key") or "").strip():
            errors.append(f"Validator node '{node_id}' checks[{i}] missing 'key'")
        kind = check.get("kind", "structural")
        if kind not in _VALIDATOR_CHECK_KINDS:
            errors.append(
                f"Validator node '{node_id}' checks[{i}] has unknown kind '{kind}'"
            )
            continue
        if kind == "json_schema":
            schema = check.get("json_schema")
            # An empty {} passes isinstance but the runner (validators.py::_check_json_schema)
            # treats a falsy schema as missing and always rejects at run time — catch it here too.
            if not (isinstance(schema, dict) and schema):
                errors.append(
                    f"Validator node '{node_id}' checks[{i}] (json_schema) missing or empty 'json_schema' object"
                )
            else:
                # A non-empty but META-INVALID schema (e.g. {"type": "not-a-real-type"})
                # passes the emptiness check above, yet the runner raises SchemaError →
                # InvalidCheckConfig on every run, hard-failing the workflow each time
                # (review finding F1, AppFactory-77 post-merge). Reject it at save-time.
                # NB: check_schema meta-validates the schema document only; it does NOT
                # resolve $ref, so a dangling/external $ref is deliberately NOT caught
                # here and stays a runtime config error (validators.py, covered by
                # test_json_schema_dangling_local_ref_is_config_error) — do not "fix" that.
                try:
                    import jsonschema
                except ImportError:
                    pass  # hard dep since AppFactory-77; if truly absent the runner config-errors at run time
                else:
                    try:
                        jsonschema.Draft202012Validator.check_schema(schema)
                    except jsonschema.SchemaError as e:
                        errors.append(
                            f"Validator node '{node_id}' checks[{i}] (json_schema) is not a valid schema: {e.message}"
                        )
        if kind == "value_relation":
            _validate_value_relation_check(node_id, "checks", i, check, errors)
        if kind == "id_set_equals":
            for field in ("other_key", "id_field", "other_id_field"):
                value = check.get(field)
                if not isinstance(value, str) or not value.strip():
                    errors.append(
                        f"Validator node '{node_id}' checks[{i}] missing '{field}'"
                    )
            fields = check.get("fields", [])
            if (
                not isinstance(fields, list)
                or any(not isinstance(f, str) or not f.strip() for f in fields)
                or len(fields) != len(set(fields))
            ):
                errors.append(
                    f"Validator node '{node_id}' id_set_equals fields must be unique non-empty strings"
                )
        if kind == "structural":
            vtype = check.get("type")
            if vtype is not None and vtype not in _VALIDATOR_VALUE_TYPES:
                errors.append(
                    f"Validator node '{node_id}' checks[{i}] has unknown type '{vtype}'"
                )
            bounds: dict = {}
            for bound in ("min_length", "max_length"):
                if bound not in check:
                    continue
                if (
                    not isinstance(check[bound], int)
                    or isinstance(check[bound], bool)
                    or check[bound] < 0
                ):
                    errors.append(
                        f"Validator node '{node_id}' checks[{i}] '{bound}' must be a non-negative integer"
                    )
                    continue
                if vtype is not None and vtype not in _VALIDATOR_LENGTH_COMPATIBLE_TYPES:
                    errors.append(
                        f"Validator node '{node_id}' checks[{i}] '{bound}' is incompatible "
                        f"with type '{vtype}' (has no length) — every value would reject"
                    )
                bounds[bound] = check[bound]
            # Both bounds can individually be valid, non-negative integers and still
            # form an impossible check (review finding, AppFactory-77 07-24): no length
            # is both >= min_length and <= max_length when min_length > max_length.
            if (
                "min_length" in bounds
                and "max_length" in bounds
                and bounds["min_length"] > bounds["max_length"]
            ):
                errors.append(
                    f"Validator node '{node_id}' checks[{i}] 'min_length' ({bounds['min_length']}) "
                    f"> 'max_length' ({bounds['max_length']}) — every value would reject"
                )
            rks = check.get("required_keys")
            if rks is not None and (
                not isinstance(rks, list) or not all(isinstance(k, str) for k in rks)
            ):
                errors.append(
                    f"Validator node '{node_id}' checks[{i}] 'required_keys' must be a list of strings"
                )
            elif rks and vtype is not None and vtype != "dict":
                # Same class as the length-bound check above (review finding,
                # AppFactory-77 07-24): only "dict" values have keys, so pairing
                # required_keys with any other declared type always rejects.
                errors.append(
                    f"Validator node '{node_id}' checks[{i}] 'required_keys' is incompatible "
                    f"with type '{vtype}' (only 'dict' has keys) — every value would reject"
                )
    refine_checks = node.get("refine_checks")
    if refine_checks is None:
        return
    if not isinstance(refine_checks, list):
        errors.append(f"Validator node '{node_id}' refine_checks must be a list")
        return
    for i, check in enumerate(refine_checks):
        if not isinstance(check, dict):
            errors.append(
                f"Validator node '{node_id}' refine_checks[{i}] must be an object"
            )
            continue
        if not str(check.get("key") or "").strip():
            errors.append(
                f"Validator node '{node_id}' refine_checks[{i}] missing 'key'"
            )
        if check.get("kind") != "value_relation":
            errors.append(
                f"Validator node '{node_id}' refine_checks[{i}] must use value_relation"
            )
            continue
        _validate_value_relation_check(node_id, "refine_checks", i, check, errors)


def _validate_max_retries(node_id: str, value: Any, errors: list[str]) -> None:
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, int):
        errors.append(f"Phase node '{node_id}' max_retries must be an integer")
        return
    if value < 0 or value > 10:
        errors.append(f"Phase node '{node_id}' max_retries must be between 0 and 10")


def _validate_max_output_repairs(node_id: str, value: Any, errors: list[str]) -> None:
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, int):
        errors.append(f"Phase node '{node_id}' max_output_repairs must be an integer")
        return
    if value < 0 or value > 5:
        errors.append(
            f"Phase node '{node_id}' max_output_repairs must be between 0 and 5"
        )


def _normalize_edges(edges: list) -> list:
    """Ensure every edge uses 'from'/'to' keys (not React Flow 'source'/'target').

    Also strips None-valued keys so that optional fields like ``condition``
    are absent rather than ``null`` — the engine uses ``"condition" not in edge``
    style checks.
    """
    for edge in edges:
        if "from" not in edge and "source" in edge:
            edge["from"] = edge.pop("source")
        if "to" not in edge and "target" in edge:
            edge["to"] = edge.pop("target")
        for key in [k for k, v in edge.items() if v is None]:
            del edge[key]
    return edges

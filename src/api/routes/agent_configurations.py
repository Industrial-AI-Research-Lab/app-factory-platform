"""CRUD endpoints for agent_configurations.

Prefix: /api/configurations/agents
Auth: require_auth (all endpoints), tenant-scoped queries.
"""

import logging
from datetime import datetime, timezone
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query

from api.deps import get_storage, get_orchestrator
from api.runtime_sync import sync_runtime_after_config_change
from api.services.configuration_usage_service import (
    WorkflowUsageByAgent,
    build_workflow_usage_by_agent,
    list_visible_workflow_definitions_for_usage,
    workflow_usage_agent_key,
)
from api.services.agent_configuration_identity import (
    agent_owner_tenant_id,
    resolve_agent_configuration_resource,
)
from api.auth.tenant_context import TenantContext, get_tenant_context
from schemas.configuration_schemas import (
    AgentConfigurationCreate,
    AgentConfigurationUpdate,
    AgentConfigurationResponse,
    AgentBulkEnabledRequest,
    AgentBulkEnabledResponse,
    AgentBulkEnabledFailure,
    AGENT_ID_PATTERN,
    AGENT_ID_DESCRIPTION,
    ENTITY_DESCRIPTION_FIELDS,
    sync_entity_descriptions_for_save,
)
from config.configuration_cow import prepare_configuration_cow_update
from config.configuration_dangling import (
    build_reference_catalogs,
    collect_dangling_references,
    dangling_references_for_agent,
)
from config.configuration_reference_validation import (
    known_tenant_ids_from_storage,
    known_wire_names_from_storage,
    validate_agent_configuration_references,
)
from config.configuration_resolution import (
    SYSTEM_TENANT_ID,
    agent_display_name_from_doc,
    agent_wire_name_from_doc,
    find_agent_wire_name_collision,
    normalize_configuration_identity,
    resolve_tenant_config_for_read,
)
from config.agent_loader import dedupe_agent_configs_by_wire_name
from tools.agent_allowed_tools import (
    apply_agent_tool_allowlist_normalization,
    clear_agent_mcp_allowlist,
)
from llm.agent_model_params import (
    AgentModelParamsValidationError,
    MODEL_PARAM_FIELDS,
    ModelConfigResolutionError,
    materialize_agent_model_params,
    validate_agent_model_params,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/configurations/agents",
    tags=["configurations"],
)

# ponytail: in-memory filter/sort after full enrich; push to Mongo if agent count hurts
AGENT_LIST_SORT_FIELDS = frozenset(
    {"name", "display_name", "type", "agent_class", "enabled", "updated_at"}
)
# Max page size for limit= (storage returns the full matching set).
AGENT_LIST_MAX_LIMIT = 100


async def _validate_model_params_or_raise(
    doc: dict,
    storage,
    *,
    fields_to_validate: frozenset[str] | None = None,
) -> dict:
    """Materialize the model contract and validate the selected fields."""
    normalized = materialize_agent_model_params(doc)
    try:
        await validate_agent_model_params(
            model=normalized["model"],
            temperature=normalized["temperature"],
            reasoning_effort=normalized["reasoning_effort"],
            storage=storage,
            fields_to_validate=fields_to_validate,
        )
    except AgentModelParamsValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.to_detail()) from exc
    except ModelConfigResolutionError as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "model_config_unavailable",
                "message": str(exc),
                "field": "model",
                "model": normalized.get("model"),
            },
        ) from exc
    return normalized


def _agent_doc_for_response(doc: dict) -> dict:
    """Canonical allow-lists on read; API ``id`` = wire name for URL routing."""
    out = apply_agent_tool_allowlist_normalization(doc)
    wire = agent_wire_name_from_doc(out, runtime_tenant_id=str(out.get("tenant_id") or ""))
    if wire:
        out = {**out, "_id": wire}
    if not str(out.get("display_name") or "").strip():
        label = agent_display_name_from_doc(out)
        wire = str(out.get("name") or "").strip()
        if label and label != wire:
            out["display_name"] = label
    return out


def _dangling_tenant_for_doc(doc: dict, ctx: TenantContext) -> str:
    if not ctx.is_root:
        return str(ctx.tenant_id or SYSTEM_TENANT_ID)
    return str(doc.get("tenant_id") or SYSTEM_TENANT_ID)


async def _workflow_usage_by_agent_for_context(
    storage,
    ctx: TenantContext,
    *,
    agent_docs: list[dict] | None = None,
    enabled_only: bool = True,
) -> WorkflowUsageByAgent:
    tid = None if ctx.is_root else ctx.tenant_id
    if agent_docs is None:
        agent_docs = await _agent_docs_for_context(storage, ctx, enabled_only=enabled_only)
    workflows = await list_visible_workflow_definitions_for_usage(
        storage,
        tenant_id=str(tid) if tid else None,
        is_root=ctx.is_root,
        enabled_only=enabled_only,
    )
    return build_workflow_usage_by_agent(
        workflows,
        agent_docs=[c for c in agent_docs if isinstance(c, dict)],
        include_tenant=ctx.is_root,
        enabled_only=enabled_only,
    )


async def _agent_docs_for_context(
    storage,
    ctx: TenantContext,
    *,
    enabled_only: bool = True,
) -> list[dict]:
    tid = None if ctx.is_root else ctx.tenant_id
    if tid and not ctx.is_root:
        configs = await storage.get_agent_configurations(enabled_only=False, tenant_id=tid)
        if enabled_only:
            configs = dedupe_agent_configs_by_wire_name(
                [c for c in configs if isinstance(c, dict)],
                str(tid),
                enabled_only=True,
            )
    else:
        configs = await storage.get_agent_configurations(enabled_only=enabled_only, tenant_id=tid)
    return [c for c in configs if isinstance(c, dict)]


def _validate_agent_list_sort(sort_by: str, sort_dir: str) -> None:
    if sort_by not in AGENT_LIST_SORT_FIELDS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid sort_by '{sort_by}'. Must be one of: {sorted(AGENT_LIST_SORT_FIELDS)}",
        )
    if sort_dir not in ("asc", "desc"):
        raise HTTPException(status_code=400, detail="Invalid sort_dir: must be 'asc' or 'desc'.")


def _agent_list_wire_id(item: dict) -> str:
    return str(item.get("id") or item.get("_id") or "")


def _agent_list_updated_at_key(item: dict) -> datetime:
    """Aware UTC for chronological compare; missing/unparseable sorts as epoch (asc = first)."""
    ts = item.get("updated_at")
    if isinstance(ts, str):
        raw = ts.strip()
        if raw:
            try:
                # Accept trailing Z from JSON/ISO dumps.
                ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                ts = None
        else:
            ts = None
    if not isinstance(ts, datetime):
        return datetime.min.replace(tzinfo=timezone.utc)
    if ts.tzinfo is None:
        return ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc)


def _agent_list_search_blob(item: dict) -> str:
    parts: list[Any] = [
        item.get("id") or item.get("_id"),
        item.get("name"),
        item.get("display_name"),
        item.get("description"),
        item.get("short_description"),
        item.get("long_description"),
    ]
    for kw in item.get("eval_keywords") or []:
        parts.append(kw)
    return " ".join(str(p or "") for p in parts).lower()


def _agent_matches_list_query(item: dict, q: str) -> bool:
    needle = q.strip().lower()
    if not needle:
        return True
    return needle in _agent_list_search_blob(item)


def _agent_list_sort_key(item: dict, sort_by: str) -> tuple:
    """Total order for pagination: primary field, then wire name, then tenant owner.

    ``_agent_doc_for_response`` rewrites ``_id`` to the wire name before sort, so
    storage UUIDv7 is unavailable here. ADR-0001 identity is ``(tenant_id, name)``.
    ``sort_by=name`` orders by wire slug; use ``display_name`` for UI label order.
    """
    wire_id = _agent_list_wire_id(item)
    wire = (item.get("name") or wire_id).lower()
    owner = str(item.get("tenant_id") or SYSTEM_TENANT_ID)
    if sort_by == "enabled":
        return (not bool(item.get("enabled", True)), wire, owner)
    if sort_by == "updated_at":
        return (_agent_list_updated_at_key(item), wire, owner)
    if sort_by == "type":
        return ((item.get("type") or "").lower(), wire, owner)
    if sort_by == "agent_class":
        return ((item.get("agent_class") or "").lower(), wire, owner)
    if sort_by == "display_name":
        label = (item.get("display_name") or item.get("name") or wire_id).lower()
        return (label, wire, owner)
    return (wire, wire, owner)


def _sort_agent_list_items(items: list[dict], sort_by: str, sort_dir: str) -> None:
    """Sort in place; wire/owner tiebreakers stay asc regardless of sort_dir."""
    reverse = sort_dir == "desc"
    decorated = [(_agent_list_sort_key(item, sort_by), item) for item in items]
    decorated.sort(key=lambda pair: pair[0][2])
    decorated.sort(key=lambda pair: pair[0][1])
    decorated.sort(key=lambda pair: pair[0][0], reverse=reverse)
    items[:] = [item for _, item in decorated]


async def _agent_doc_for_api(
    doc: dict,
    storage,
    ctx: TenantContext,
    *,
    catalogs_cache: dict[str, dict] | None = None,
    workflow_usage_by_agent: WorkflowUsageByAgent | None = None,
) -> dict:
    out = _agent_doc_for_response(doc)
    if workflow_usage_by_agent is not None:
        wire_id = str(out.get("_id") or "").strip()
        usage_key = workflow_usage_agent_key(
            wire_id,
            tenant_id=str(out.get("tenant_id") or SYSTEM_TENANT_ID) if ctx.is_root else None,
        )
        workflow_usage = workflow_usage_by_agent.get(usage_key, [])
        out["workflow_usage"] = workflow_usage
        out["workflow_usage_count"] = len(workflow_usage)
    tenant_id = _dangling_tenant_for_doc(doc, ctx)
    if catalogs_cache is not None:
        if tenant_id not in catalogs_cache:
            catalogs_cache[tenant_id] = await build_reference_catalogs(storage, tenant_id)
        out["dangling_references"] = collect_dangling_references(
            doc,
            catalogs_cache[tenant_id],
            tenant_id=tenant_id,
        )
    else:
        out["dangling_references"] = await dangling_references_for_agent(
            storage,
            doc,
            tenant_id=tenant_id,
        )
    return out


# ---------------------------------------------------------------------------
# LIST
# ---------------------------------------------------------------------------

@router.get("/", response_model=List[AgentConfigurationResponse])
async def list_agent_configurations(
    enabled_only: bool = True,
    enabled: Optional[bool] = Query(None),
    agent_type: Optional[str] = Query(None, alias="type"),
    agent_class: Optional[str] = Query(None),
    tenant_id: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    sort_by: str = Query(
        "name",
        description=(
            "Sort field. Default `name` is wire identity slug (ADR-0001), not display label. "
            "Use `display_name` for UI label order. Default direction is asc "
            "(replaces previous storage natural order)."
        ),
    ),
    sort_dir: str = Query("asc"),
    limit: Optional[int] = Query(
        None,
        ge=1,
        le=AGENT_LIST_MAX_LIMIT,
        description=(
            "Page size. Omit for the full filtered list (backward compatible). "
            f"When set, max is {AGENT_LIST_MAX_LIMIT} per request (422 if larger)."
        ),
    ),
    offset: int = Query(0, ge=0),
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Return agent configurations scoped to caller's tenant + __system__.

    By default returns the effective (runtime) view: disabled tenant overrides
    fall back to inherited ``__system__`` agents with the same wire name.
    Pass ``enabled_only=false`` for a raw storage audit view (no inheritance dedupe).
    Pass ``enabled=false`` only together with ``enabled_only=false``.
    """
    _validate_agent_list_sort(sort_by, sort_dir)
    if enabled is False and enabled_only:
        raise HTTPException(
            status_code=400,
            detail="enabled=false requires enabled_only=false",
        )
    filter_tenant_id: Optional[str] = None
    if tenant_id and tenant_id.strip():
        if ctx.is_root:
            filter_tenant_id = tenant_id.strip()
        else:
            logger.warning(
                "[CONFIG-API] tenant_id query ignored for non-root caller user=%s",
                ctx.user_id,
            )

    storage = _storage_or_fail()
    configs = await _agent_docs_for_context(storage, ctx, enabled_only=enabled_only)
    if filter_tenant_id:
        configs = [
            c for c in configs
            if str(c.get("tenant_id") or SYSTEM_TENANT_ID) == filter_tenant_id
        ]
    workflow_usage_by_agent = await _workflow_usage_by_agent_for_context(
        storage,
        ctx,
        agent_docs=configs,
        enabled_only=enabled_only,
    )
    catalogs_cache: dict[str, dict] = {}
    items = [
        await _agent_doc_for_api(
            c,
            storage,
            ctx,
            catalogs_cache=catalogs_cache,
            workflow_usage_by_agent=workflow_usage_by_agent,
        )
        for c in configs
        if isinstance(c, dict)
    ]

    if enabled is not None:
        items = [item for item in items if bool(item.get("enabled", True)) == enabled]
    if agent_type:
        items = [item for item in items if (item.get("type") or "") == agent_type]
    if agent_class:
        items = [
            item for item in items
            if (item.get("agent_class") or "GenericAgent") == agent_class
        ]
    if q:
        items = [item for item in items if _agent_matches_list_query(item, q)]

    _sort_agent_list_items(items, sort_by, sort_dir)
    if offset:
        items = items[offset:]
    if limit is not None:
        items = items[:limit]
    return items


# ---------------------------------------------------------------------------
# GET ONE
# ---------------------------------------------------------------------------

@router.get("/{agent_id}", response_model=AgentConfigurationResponse)
async def get_agent_configuration(
    agent_id: str = Path(
        ...,
        pattern=AGENT_ID_PATTERN,
        description=AGENT_ID_DESCRIPTION,
    ),
    tenant_id: str | None = Query(None, description="Root-only tenant selector"),
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Return a single agent configuration by ID."""
    storage = _storage_or_fail()
    doc = await resolve_agent_configuration_resource(
        storage,
        ctx,
        agent_id,
        selected_tenant_id=tenant_id,
    )
    if not doc:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")
    # Tenant scoping: non-root can only see own tenant or __system__
    if not ctx.is_root and doc.get("tenant_id") not in (ctx.tenant_id, "__system__", None):
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")
    if not ctx.is_root:
        doc = await resolve_tenant_config_for_read(
            doc,
            tenant_id=str(ctx.tenant_id),
            resolve_configuration=storage.resolve_agent_configuration,
        )
    workflow_usage_by_agent = await _workflow_usage_by_agent_for_context(storage, ctx)
    return await _agent_doc_for_api(
        doc,
        storage,
        ctx,
        workflow_usage_by_agent=workflow_usage_by_agent,
    )


# ---------------------------------------------------------------------------
# CREATE
# ---------------------------------------------------------------------------

@router.post("/", response_model=AgentConfigurationResponse, status_code=201)
async def create_agent_configuration(
    body: AgentConfigurationCreate, ctx: TenantContext = Depends(get_tenant_context),
):
    """Create a new agent configuration stamped with caller's tenant_id."""
    storage = _storage_or_fail()

    tenant_id = SYSTEM_TENANT_ID if ctx.is_root else str(ctx.tenant_id or "").strip()
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id is required")

    existing = await storage.find_agent_configuration_by_name(tenant_id, body.id)
    if existing:
        raise HTTPException(status_code=409, detail=f"Agent '{body.id}' already exists")
    doc = apply_agent_tool_allowlist_normalization(
        {"_id": body.id, **body.model_dump(exclude={"id"})}
    )
    doc = {
        k: v
        for k, v in doc.items()
        if v is not None or k in MODEL_PARAM_FIELDS
    }
    sync_entity_descriptions_for_save(doc)

    doc.setdefault("tenant_id", tenant_id)
    label = str(doc.get("name") or "").strip()
    if label and label != body.id:
        doc["display_name"] = label
    doc["name"] = body.id
    doc = await _validate_model_params_or_raise(doc, storage)
    try:
        tenant_ids = await known_tenant_ids_from_storage(storage)
        wire_names = await known_wire_names_from_storage(storage)
        doc = validate_agent_configuration_references(
            doc,
            known_tenant_ids=tenant_ids,
            known_wire_names=wire_names,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    wire_name = agent_wire_name_from_doc(doc, runtime_tenant_id=tenant_id)
    if wire_name:
        collision = await find_agent_wire_name_collision(
            storage,
            tenant_id,
            wire_name,
            exclude_storage_id=body.id,
        )
        if collision:
            other_id = str(collision.get("_id") or "?")
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Agent wire name '{wire_name}' already used by '{other_id}' "
                    f"for tenant '{tenant_id}'"
                ),
            )

    identity_name = str(doc.get("name") or "").strip()
    if identity_name and hasattr(storage, "find_agent_configuration_by_name"):
        conflict = await storage.find_agent_configuration_by_name(tenant_id, identity_name)
        if conflict and str(conflict.get("_id") or "") != body.id:
            raise HTTPException(
                status_code=409,
                detail=f"Agent with name '{identity_name}' already exists for tenant '{tenant_id}'",
            )
    saved_id = await storage.save_agent_configuration(doc, actor_id=ctx.user_id)
    persisted = await storage.get_agent_configuration(saved_id)
    if not persisted:
        persisted = {**doc, "_id": saved_id}
    await sync_runtime_after_config_change(
        f"agent_create:{saved_id}",
        agents=True,
    )
    logger.info("[CONFIG-API] Created agent '%s' (tenant=%s)", saved_id, persisted.get("tenant_id"))
    workflow_usage_by_agent = await _workflow_usage_by_agent_for_context(storage, ctx)
    return await _agent_doc_for_api(
        persisted,
        storage,
        ctx,
        workflow_usage_by_agent=workflow_usage_by_agent,
    )


# ---------------------------------------------------------------------------
# BULK ENABLED
# ---------------------------------------------------------------------------

@router.patch("/bulk-enabled", response_model=AgentBulkEnabledResponse)
async def bulk_update_agent_enabled(
    body: AgentBulkEnabledRequest,
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Enable or disable multiple agents in one request with a single runtime sync.

    Always returns HTTP 200 on a valid request body. Inspect ``updated`` and
    ``failed`` in the response: an empty ``updated`` list means every item failed
    (clients must not treat status 200 alone as success).
    """
    storage = _storage_or_fail()
    updated: list[str] = []
    failed: list[AgentBulkEnabledFailure] = []

    for item in body.updates:
        try:
            await _persist_agent_configuration_update(
                storage,
                ctx,
                item.agent_id,
                {"enabled": item.enabled},
                selected_tenant_id=item.tenant_id,
                sync_runtime=False,
            )
            updated.append(item.agent_id)
        except HTTPException as exc:
            failed.append(
                AgentBulkEnabledFailure(
                    agent_id=item.agent_id,
                    tenant_id=item.tenant_id,
                    error=_http_error_detail(exc),
                )
            )
        except Exception as exc:
            logger.warning(
                "[CONFIG-API] agent=%s tenant_id=%s — bulk enabled update failed: %s",
                item.agent_id,
                item.tenant_id,
                exc,
                exc_info=True,
            )
            failed.append(
                AgentBulkEnabledFailure(
                    agent_id=item.agent_id,
                    tenant_id=item.tenant_id,
                    error=str(exc),
                )
            )

    if updated:
        await sync_runtime_after_config_change(
            f"agent_bulk_enabled:{len(updated)}",
            agents=True,
        )
        logger.info(
            "[CONFIG-API] Bulk enabled update count=%s updated=%s failed=%s",
            len(body.updates),
            len(updated),
            len(failed),
        )

    return AgentBulkEnabledResponse(updated=updated, failed=failed)


# ---------------------------------------------------------------------------
# UPDATE (partial)
# ---------------------------------------------------------------------------

@router.put("/{agent_id}", response_model=AgentConfigurationResponse)
async def update_agent_configuration(
    body: AgentConfigurationUpdate,
    agent_id: str = Path(
        ...,
        pattern=AGENT_ID_PATTERN,
        description=AGENT_ID_DESCRIPTION,
    ),
    tenant_id: str | None = Query(None, description="Root-only tenant selector"),
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Update an existing agent configuration (partial merge)."""
    storage = _storage_or_fail()

    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    persisted = await _persist_agent_configuration_update(
        storage,
        ctx,
        agent_id,
        updates,
        selected_tenant_id=tenant_id,
        sync_runtime=True,
    )
    logger.info("[CONFIG-API] Updated agent '%s' fields=%s", persisted.get("_id"), list(updates.keys()))
    workflow_usage_by_agent = await _workflow_usage_by_agent_for_context(storage, ctx)
    return await _agent_doc_for_api(
        persisted,
        storage,
        ctx,
        workflow_usage_by_agent=workflow_usage_by_agent,
    )


# ---------------------------------------------------------------------------
# DELETE
# ---------------------------------------------------------------------------

@router.delete("/{agent_id}", status_code=204)
async def delete_agent_configuration(
    agent_id: str = Path(
        ...,
        pattern=AGENT_ID_PATTERN,
        description=AGENT_ID_DESCRIPTION,
    ),
    tenant_id: str | None = Query(None, description="Root-only tenant selector"),
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Delete an agent configuration."""
    storage = _storage_or_fail()

    existing = await resolve_agent_configuration_resource(
        storage,
        ctx,
        agent_id,
        selected_tenant_id=tenant_id,
    )
    if not existing:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")
    if not ctx.is_root and existing.get("tenant_id") not in (ctx.tenant_id, SYSTEM_TENANT_ID, None):
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")

    effective = existing
    if not ctx.is_root:
        effective = await resolve_tenant_config_for_read(
            existing,
            tenant_id=str(ctx.tenant_id),
            resolve_configuration=storage.resolve_agent_configuration,
        )
        if str(effective.get("tenant_id") or "") == SYSTEM_TENANT_ID:
            raise HTTPException(status_code=403, detail="Cannot delete config from another tenant")

    if not ctx.is_root and effective.get("tenant_id") not in (ctx.tenant_id, None):
        raise HTTPException(status_code=403, detail="Cannot delete config from another tenant")

    effective_id = str(effective.get("_id") or agent_id)
    await storage.delete_agent_configuration(effective_id)
    await sync_runtime_after_config_change(
        f"agent_delete:{effective_id}",
        agents=True,
    )
    logger.info("[CONFIG-API] Deleted agent '%s'", effective_id)


# ---------------------------------------------------------------------------
# HOT-RELOAD (placeholder — full impl requires orchestrator reload logic)
# ---------------------------------------------------------------------------

@router.post("/{agent_id}/reload", status_code=200)
async def reload_agent(
    agent_id: str = Path(
        ...,
        pattern=AGENT_ID_PATTERN,
        description=AGENT_ID_DESCRIPTION,
    ),
    tenant_id: str | None = Query(None, description="Root-only tenant selector"),
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Hot-reload a specific agent in the runtime orchestrator."""
    storage = _storage_or_fail()
    orchestrator = get_orchestrator()
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")

    doc = await resolve_agent_configuration_resource(
        storage,
        ctx,
        agent_id,
        selected_tenant_id=tenant_id,
    )
    if not doc:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")
    if not ctx.is_root and doc.get("tenant_id") not in (ctx.tenant_id, SYSTEM_TENANT_ID, None):
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")
    if not ctx.is_root:
        doc = await resolve_tenant_config_for_read(
            doc,
            tenant_id=str(ctx.tenant_id),
            resolve_configuration=storage.resolve_agent_configuration,
        )

    # Re-create agent instance and replace in pool
    from agents.generic_agent import GenericAgent
    from config.configuration_resolution import agent_wire_name_from_doc

    new_agent = GenericAgent(doc)
    effective_id = str(doc.get("_id") or agent_id)
    wire_id = agent_wire_name_from_doc(
        doc,
        runtime_tenant_id=str(doc.get("tenant_id") or ctx.tenant_id or ""),
    ) or agent_id
    owner_tenant_id = agent_owner_tenant_id(doc)

    # Replace or add in orchestrator pool
    pool = orchestrator.agent_pool
    replaced = False
    for i, a in enumerate(pool):
        runtime_config = getattr(a, "config", {})
        runtime_owner = agent_owner_tenant_id(runtime_config)
        runtime_wire_id = agent_wire_name_from_doc(
            runtime_config,
            runtime_tenant_id=runtime_owner,
        ) or str(getattr(a, "agent_id", ""))
        if runtime_owner == owner_tenant_id and runtime_wire_id == wire_id:
            # Preserve ALL injected dependencies from the old agent
            new_agent.shared_context = getattr(a, "shared_context", None)
            new_agent.tool_registry = getattr(a, "tool_registry", None)
            new_agent.llm_client = getattr(a, "llm_client", None)
            new_agent.event_emitter = getattr(a, "event_emitter", None)
            new_agent.mcp_executor = getattr(a, "mcp_executor", None)
            new_agent.deploy_service = getattr(a, "deploy_service", None)
            new_agent.agent_pool = pool
            pool[i] = new_agent
            replaced = True
            break

    if not replaced:
        orchestrator.register_agent(new_agent)

    logger.info(
        "[CONFIG-API] Hot-reloaded agent '%s' effective_id=%s (replaced=%s)",
        agent_id,
        effective_id,
        replaced,
    )
    return {"status": "reloaded", "agent_id": wire_id, "replaced": replaced}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _http_error_detail(exc: HTTPException) -> str:
    detail = exc.detail
    if isinstance(detail, str):
        return detail
    if isinstance(detail, dict) and detail.get("message"):
        return str(detail["message"])
    return str(detail)


async def _persist_agent_configuration_update(
    storage,
    ctx: TenantContext,
    agent_id: str,
    updates: dict,
    *,
    selected_tenant_id: str | None,
    sync_runtime: bool,
) -> dict:
    """Merge partial updates into an agent configuration and persist."""
    existing = await resolve_agent_configuration_resource(
        storage,
        ctx,
        agent_id,
        selected_tenant_id=selected_tenant_id,
    )
    if not existing:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")

    if not ctx.is_root and existing.get("tenant_id") not in (ctx.tenant_id, SYSTEM_TENANT_ID, None):
        raise HTTPException(status_code=403, detail="Cannot modify config from another tenant")

    try:
        if ctx.is_root or existing.get("tenant_id") in (ctx.tenant_id, None):
            merged = {**existing, **updates}
            target_id = str(existing.get("_id") or agent_id)
        else:
            merged, target_id = await prepare_configuration_cow_update(
                existing,
                tenant_id=str(ctx.tenant_id),
                updates=updates,
                resolve_configuration=storage.resolve_agent_configuration,
                get_configuration=storage.get_agent_configuration,
                find_by_name=storage.find_agent_configuration_by_name,
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

    if "allowed_mcp_tools" in updates and not (updates.get("allowed_mcp_tools") or []):
        merged = clear_agent_mcp_allowlist(merged)
    else:
        merged = apply_agent_tool_allowlist_normalization(merged)
    model_params = {
        field: merged[field]
        for field in MODEL_PARAM_FIELDS
        if field in merged
    }
    merged = {k: v for k, v in merged.items() if v is not None}
    merged.update(model_params)
    owner_tenant = str(merged.get("tenant_id") or ctx.tenant_id or SYSTEM_TENANT_ID).strip()
    wire_id = agent_wire_name_from_doc(existing, runtime_tenant_id=owner_tenant) or str(
        existing.get("_id") or agent_id
    )
    if "name" in updates:
        label = str(updates.get("name") or "").strip()
        if label and label != wire_id:
            merged["display_name"] = label
    merged = normalize_configuration_identity(merged, wire_id=wire_id)
    fields_to_validate = MODEL_PARAM_FIELDS.intersection(updates)
    if updates.get("enabled") is True:
        fields_to_validate = MODEL_PARAM_FIELDS
    if fields_to_validate:
        merged = await _validate_model_params_or_raise(
            merged,
            storage,
            fields_to_validate=fields_to_validate,
        )
    if set(updates.keys()) - {"enabled"}:
        try:
            tenant_ids = await known_tenant_ids_from_storage(storage)
            wire_names = await known_wire_names_from_storage(storage)
            merged = validate_agent_configuration_references(
                merged,
                known_tenant_ids=tenant_ids,
                known_wire_names=wire_names,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        wire_name = agent_wire_name_from_doc(merged, runtime_tenant_id=owner_tenant)
        if wire_name and owner_tenant:
            collision = await find_agent_wire_name_collision(
                storage,
                owner_tenant,
                wire_name,
                exclude_storage_id=target_id,
            )
            if collision:
                other_id = str(collision.get("_id") or "?")
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Agent wire name '{wire_name}' already used by '{other_id}' "
                        f"for tenant '{owner_tenant}'"
                    ),
                )
    saved_id = await storage.save_agent_configuration(merged, actor_id=ctx.user_id)
    persisted = await storage.get_agent_configuration(saved_id)
    if not persisted:
        persisted = {**merged, "_id": saved_id}
    if sync_runtime:
        await sync_runtime_after_config_change(
            f"agent_update:{saved_id}",
            agents=True,
        )
    return persisted


def _storage_or_fail():
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")
    return storage

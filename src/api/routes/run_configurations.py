import logging

from fastapi import APIRouter, Depends, HTTPException, Response, status

from api.auth.middleware import require_auth
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.deps import get_storage
from llm.agent_model_params import AgentModelParamsValidationError
from schemas.configuration_schemas import (
    RunConfigurationCreate,
    RunConfigurationResponse,
    RunConfigurationUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/configurations/run-configurations",
    tags=["run-configurations"],
    dependencies=[Depends(require_auth)],
)


def _get_store():
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")

    store = getattr(storage, "run_config_store", None)
    if not store:
        raise HTTPException(status_code=500, detail="Run configuration store not initialized")

    return store


async def _get_visible_config_or_404(
        config_id: str,
        ctx: TenantContext,
) -> RunConfigurationResponse:
    store = _get_store()
    config = await store.get_config(config_id)

    if not config:
        raise HTTPException(status_code=404, detail="Run configuration not found")

    if not ctx.is_root and config.tenant_id not in (ctx.tenant_id, "__system__"):
        raise HTTPException(status_code=404, detail="Run configuration not found")

    return config


async def _get_owned_config_or_403(
        config_id: str,
        ctx: TenantContext,
):
    store = _get_store()
    config = await store.get_config(config_id)

    if not config:
        raise HTTPException(status_code=404, detail="Run configuration not found")

    if not ctx.is_root and config.tenant_id != ctx.tenant_id:
        raise HTTPException(status_code=403, detail="Cannot modify config from another tenant")

    return store, config


@router.get("/", response_model=list[RunConfigurationResponse])
async def list_run_configurations(
        ctx: TenantContext = Depends(get_tenant_context),
):
    store = _get_store()
    tid = None if ctx.is_root else ctx.tenant_id
    return await store.list_configs(tid)


@router.get("/{config_id}", response_model=RunConfigurationResponse)
async def get_run_configuration(
        config_id: str,
        ctx: TenantContext = Depends(get_tenant_context),
):
    return await _get_visible_config_or_404(config_id, ctx)


@router.post("/", response_model=RunConfigurationResponse, status_code=status.HTTP_201_CREATED)
async def create_run_configuration(
        payload: RunConfigurationCreate,
        ctx: TenantContext = Depends(get_tenant_context),
):
    store = _get_store()

    existing = await store.get_config(payload.id)
    if existing:
        raise HTTPException(status_code=409, detail="Run configuration already exists")

    try:
        return await store.create_config(payload, tenant_id=ctx.tenant_id)
    except AgentModelParamsValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.to_detail()) from exc


@router.put("/{config_id}", response_model=RunConfigurationResponse)
async def update_run_configuration(
        config_id: str,
        payload: RunConfigurationUpdate,
        ctx: TenantContext = Depends(get_tenant_context),
):
    store, _ = await _get_owned_config_or_403(config_id, ctx)

    try:
        updated = await store.update_config(config_id, payload)
    except AgentModelParamsValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.to_detail()) from exc
    if not updated:
        raise HTTPException(status_code=404, detail="Run configuration not found")

    return updated


@router.delete("/{config_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_run_configuration(
        config_id: str,
        ctx: TenantContext = Depends(get_tenant_context),
):
    store, _ = await _get_owned_config_or_403(config_id, ctx)

    deleted = await store.delete_config(config_id)
    if not deleted:
        raise HTTPException(status_code=500, detail="Failed to delete run configuration")

    return Response(status_code=status.HTTP_204_NO_CONTENT)

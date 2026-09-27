"""Settings routes (models, system config)"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from api.auth.middleware import require_auth, require_role
from typing import Optional, List
from datetime import datetime, timedelta
import logging
import httpx
import os
import math

from api.deps import get_storage
from llm.model_catalog import (
    apply_system_price_limit,
    build_catalog_page,
    normalize_openrouter_model,
)

router = APIRouter(tags=["settings"], dependencies=[Depends(require_auth)])
logger = logging.getLogger(__name__)

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
CACHE_DURATION_MINUTES = 30

# Max avg price per 1M tokens - models with (input+output)/2 above this are hidden
# Set to 100 or higher to disable filtering (show all)
MAX_PRICE_PER_MILLION = float(os.getenv("MAX_PRICE_PER_MILLION", "100"))
VALID_SORT_BY = {"name", "provider", "input_price", "output_price", "avg_price"}
VALID_SORT_DIR = {"asc", "desc"}
ALLOWED_QUERY_PARAMS = {
    "force_refresh",
    "q",
    "provider",
    "reasoning",
    "free",
    "min_input_price",
    "max_input_price",
    "min_output_price",
    "max_output_price",
    "min_context_length",
    "sort_by",
    "sort_dir",
    "offset",
    "limit",
}


def _updated_at_iso(value) -> Optional[str]:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _build_models_response(
    models: list[dict],
    *,
    query: dict,
    updated_at,
    cached: bool,
    stale: bool,
    source: str,
    error: Optional[str] = None,
    message: Optional[str] = None,
) -> dict:
    page = build_catalog_page(
        models,
        max_price_per_million=MAX_PRICE_PER_MILLION,
        **query,
    )
    response = {
        **page,
        "updated_at": _updated_at_iso(updated_at),
        "cached": cached,
        "stale": stale,
        "model_count": page["total_count"],
        "max_price_filter": (
            MAX_PRICE_PER_MILLION if 0 < MAX_PRICE_PER_MILLION < 100 else None
        ),
    }
    if error is not None:
        response["error"] = error
    if message is not None:
        response["message"] = message
    logger.info(
        "[MODELS] source=%s cached=%s stale=%s raw_count=%d total=%d "
        "returned=%d offset=%d limit=%s has_query=%s — catalog response",
        source,
        cached,
        stale,
        len(models),
        page["total"],
        page["returned_count"],
        page["offset"],
        page["limit"],
        bool(query.get("q")),
    )
    return response


@router.get("/api/settings/models")
async def list_models(
    request: Request,
    force_refresh: bool = False,
    q: Optional[str] = None,
    provider: Optional[List[str]] = Query(default=None),
    reasoning: Optional[str] = None,
    free: Optional[str] = None,
    min_input_price: Optional[str] = None,
    max_input_price: Optional[str] = None,
    min_output_price: Optional[str] = None,
    max_output_price: Optional[str] = None,
    min_context_length: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_dir: str = "asc",
    offset: Optional[str] = Query(default=None),
    limit: Optional[str] = Query(default=None),
):
    unknown = set(request.query_params.keys()) - ALLOWED_QUERY_PARAMS
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown query parameter(s): {', '.join(sorted(unknown))}",
        )

    if sort_by is not None and sort_by not in VALID_SORT_BY:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid sort_by '{sort_by}'. Must be one of: {sorted(VALID_SORT_BY)}",
        )
    if sort_dir not in VALID_SORT_DIR:
        raise HTTPException(
            status_code=422, detail="Invalid sort_dir: must be 'asc' or 'desc'."
        )

    try:
        offset_int = int(offset) if offset is not None else 0
        if offset_int < 0:
            raise ValueError()
    except ValueError:
        raise HTTPException(
            status_code=422, detail="Invalid offset: must be an integer >= 0."
        )

    limit_int = None
    if limit is not None:
        try:
            limit_int = int(limit)
            if not (1 <= limit_int <= 200):
                raise ValueError()
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail="Invalid limit: must be an integer between 1 and 200.",
            )

    reasoning_bool = None
    if reasoning is not None:
        if reasoning.lower() not in ("true", "false", "1", "0"):
            raise HTTPException(
                status_code=422, detail="Invalid reasoning: must be 'true' or 'false'."
            )
        reasoning_bool = reasoning.lower() in ("true", "1")

    free_bool = None
    if free is not None:
        if free.lower() not in ("true", "false", "1", "0"):
            raise HTTPException(
                status_code=422, detail="Invalid free: must be 'true' or 'false'."
            )
        free_bool = free.lower() in ("true", "1")

    if provider is not None:
        for p in provider:
            if not p or not p.strip():
                raise HTTPException(
                    status_code=422, detail="Invalid provider: value must be non-empty."
                )
            if "," in p:
                raise HTTPException(
                    status_code=422,
                    detail="Invalid provider: use repeated params (?provider=openai&provider=anthropic), not comma-separated values.",
                )

    def parse_price(val, name):
        if val is None:
            return None
        try:
            f = float(val)
        except ValueError:
            raise HTTPException(
                status_code=422, detail=f"Invalid {name}: must be a finite number >= 0."
            )
        if not math.isfinite(f):
            raise HTTPException(
                status_code=422, detail=f"Invalid {name}: must be a finite number >= 0."
            )
        if f < 0:
            raise HTTPException(
                status_code=422, detail=f"Invalid {name}: must be a finite number >= 0."
            )
        return f

    min_input = parse_price(min_input_price, "min_input_price")
    max_input = parse_price(max_input_price, "max_input_price")
    min_output = parse_price(min_output_price, "min_output_price")
    max_output = parse_price(max_output_price, "max_output_price")

    min_context = None
    if min_context_length is not None:
        try:
            min_context = int(min_context_length)
            if min_context < 0 or str(min_context) != min_context_length:
                raise ValueError()
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail="Invalid min_context_length: must be an integer >= 0.",
            )

    if min_input is not None and max_input is not None and min_input > max_input:
        raise HTTPException(
            status_code=422,
            detail="Invalid price range: min_input_price must be <= max_input_price.",
        )
    if min_output is not None and max_output is not None and min_output > max_output:
        raise HTTPException(
            status_code=422,
            detail="Invalid price range: min_output_price must be <= max_output_price.",
        )

    storage = get_storage()
    if not storage:
        logger.error("[MODELS] source=none — storage is not initialized")
        raise HTTPException(status_code=500, detail="Storage not initialized")

    query = {
        "q": q,
        "provider": provider,
        "reasoning": reasoning_bool,
        "free": free_bool,
        "min_input_price": min_input,
        "max_input_price": max_input,
        "min_output_price": min_output,
        "max_output_price": max_output,
        "min_context_length": min_context,
        "sort_by": sort_by,
        "sort_dir": sort_dir,
        "offset": offset_int,
        "limit": limit_int,
    }

    cache_doc = await storage.db.system_info.find_one({"_id": "models_cache"})
    cache_valid = False
    if cache_doc:
        last_updated = cache_doc.get("updated_at")
        if last_updated:
            age = datetime.utcnow() - last_updated
            cache_valid = age < timedelta(minutes=CACHE_DURATION_MINUTES)

    if cache_valid and not force_refresh:
        return _build_models_response(
            cache_doc.get("models", []),
            query=query,
            updated_at=cache_doc.get("updated_at"),
            cached=True,
            stale=False,
            source="cache",
        )

    if not force_refresh:
        if cache_doc:
            return _build_models_response(
                cache_doc.get("models", []),
                query=query,
                updated_at=cache_doc.get("updated_at"),
                cached=True,
                stale=True,
                source="cache",
            )
        logger.warning("[MODELS] source=none — models cache is unavailable")
        return _build_models_response(
            [],
            query=query,
            updated_at=None,
            cached=False,
            stale=False,
            source="none",
            message="No models cached. Click refresh to fetch from OpenRouter.",
        )

    try:
        models = await _fetch_openrouter_models()
        updated_at = datetime.utcnow()
        await storage.db.system_info.update_one(
            {"_id": "models_cache"},
            {
                "$set": {
                    "models": models,
                    "updated_at": updated_at,
                    "source": "openrouter",
                }
            },
            upsert=True,
        )
        return _build_models_response(
            models,
            query=query,
            updated_at=updated_at,
            cached=False,
            stale=False,
            source="openrouter",
        )
    except Exception as e:
        logger.exception(
            "[MODELS] source=openrouter error_type=%s — failed to fetch models",
            type(e).__name__,
        )
        if cache_doc:
            return _build_models_response(
                cache_doc.get("models", []),
                query=query,
                updated_at=cache_doc.get("updated_at"),
                cached=True,
                stale=True,
                source="fallback",
                error=str(e),
            )
        raise HTTPException(status_code=502, detail=f"Failed to fetch models: {e}")


@router.post(
    "/api/settings/models/refresh", dependencies=[Depends(require_role("tenant_admin"))]
)
async def refresh_models(force: bool = False):
    """
    Force refresh models from OpenRouter.

    Respects 30-minute rate limit - will return cached data if refreshed recently.
    Pass force=true to bypass rate limit (for dev/testing).
    """
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")

    # Check if we're within rate limit (skip if force=true)
    if not force:
        cache_doc = await storage.db.system_info.find_one({"_id": "models_cache"})
        if cache_doc:
            last_updated = cache_doc.get("updated_at")
            if last_updated:
                age = datetime.utcnow() - last_updated
                if age < timedelta(minutes=CACHE_DURATION_MINUTES):
                    minutes_remaining = CACHE_DURATION_MINUTES - int(
                        age.total_seconds() / 60
                    )
                    filtered = apply_system_price_limit(
                        cache_doc.get("models", []), MAX_PRICE_PER_MILLION
                    )
                    return {
                        "models": filtered,
                        "updated_at": last_updated.isoformat(),
                        "cached": True,
                        "rate_limited": True,
                        "minutes_until_refresh": minutes_remaining,
                        "model_count": len(filtered),
                        "max_price_filter": MAX_PRICE_PER_MILLION
                        if MAX_PRICE_PER_MILLION < 100
                        else None,
                    }

    # Fetch fresh data
    try:
        models = await _fetch_openrouter_models()
        updated_at = datetime.utcnow()

        await storage.db.system_info.update_one(
            {"_id": "models_cache"},
            {
                "$set": {
                    "models": models,
                    "updated_at": updated_at,
                    "source": "openrouter",
                }
            },
            upsert=True,
        )

        filtered = apply_system_price_limit(models, MAX_PRICE_PER_MILLION)
        logger.info(
            "[MODELS] source=openrouter fetched_count=%d visible_count=%d "
            "— refreshed models cache",
            len(models),
            len(filtered),
        )

        return {
            "models": filtered,
            "updated_at": updated_at.isoformat(),
            "cached": False,
            "model_count": len(filtered),
            "max_price_filter": MAX_PRICE_PER_MILLION
            if MAX_PRICE_PER_MILLION < 100
            else None,
        }
    except Exception as e:
        logger.exception(
            "[MODELS] source=openrouter error_type=%s — failed to refresh models",
            type(e).__name__,
        )
        raise HTTPException(status_code=502, detail=f"Failed to fetch models: {e}")


# Keep this route last among GET /api/settings/models/* — the :path converter
# swallows any sub-path, so a GET route declared below it would never be reached
# and would silently answer "model not found" instead.
@router.get("/api/settings/models/{model_id:path}")
async def get_model_by_id(model_id: str):
    """Return one visible catalog model by its catalog or legacy bare ID."""
    from llm.agent_model_params import (
        ModelConfigResolutionError,
        get_model_metadata_from_cache,
    )

    storage = get_storage()
    if not storage:
        logger.error(
            "[MODELS] operation=get_by_id model_id=%r source=none "
            "— storage is not initialized",
            model_id,
        )
        raise HTTPException(status_code=500, detail="Storage not initialized")

    # Most agent configs store a bare model name ("gpt-5-mini") while the catalog
    # is keyed by the full id ("openai/gpt-5-mini"). Resolve through the same
    # helper every other model consumer uses, so this endpoint cannot answer
    # "not found" for an id the rest of the platform resolves fine.
    try:
        model = await get_model_metadata_from_cache(
            model_id, storage=storage, strict=True
        )
    except ModelConfigResolutionError as exc:
        logger.warning(
            "[MODELS] operation=get_by_id model_id=%r — %s",
            model_id,
            exc,
        )
        raise HTTPException(
            status_code=503,
            detail={
                "code": "model_lookup_unavailable",
                "message": str(exc),
                "field": "model",
                "model": model_id,
            },
        ) from exc

    visible = apply_system_price_limit(
        [model] if model else [],
        MAX_PRICE_PER_MILLION,
    )
    if not visible:
        logger.info(
            "[MODELS] operation=get_by_id model_id=%r resolved=%s "
            "— model not found or hidden by price limit",
            model_id,
            bool(model),
        )
        raise HTTPException(status_code=404, detail=f"Model '{model_id}' not found")

    logger.info(
        "[MODELS] operation=get_by_id model_id=%r resolved_id=%r source=cache "
        "— model found",
        model_id,
        visible[0].get("id"),
    )
    return visible[0]


@router.get("/api/settings/default-model")
async def get_default_model():
    """Get the default model setting."""
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")

    doc = await storage.db.system_info.find_one({"_id": "default_model"})
    if not doc:
        return {"model_id": None, "model_name": None}

    return {
        "model_id": doc.get("model_id"),
        "model_name": doc.get("model_name"),
        "updated_at": doc.get("updated_at").isoformat()
        if doc.get("updated_at")
        else None,
    }


@router.put(
    "/api/settings/default-model", dependencies=[Depends(require_role("tenant_admin"))]
)
async def set_default_model(model_id: str, model_name: Optional[str] = None):
    """Set the default model for new projects."""
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")

    await storage.db.system_info.update_one(
        {"_id": "default_model"},
        {
            "$set": {
                "model_id": model_id,
                "model_name": model_name,
                "updated_at": datetime.utcnow(),
            }
        },
        upsert=True,
    )

    logger.info(f"✅ Default model set to: {model_id}")

    return {
        "model_id": model_id,
        "model_name": model_name,
        "updated_at": datetime.utcnow().isoformat(),
    }


@router.post(
    "/api/settings/test-model", dependencies=[Depends(require_role("tenant_admin"))]
)
async def test_model(model_id: str, reasoning: bool = False, effort: str = "medium"):
    """Test a model by sending a simple message and measuring latency.

    Args:
        model_id: Model to test
        reasoning: Enable reasoning mode (for models that support it)
        effort: Reasoning effort level (xhigh, high, medium, low, minimal, none)
    """
    import time
    from llm.client import LLMClient

    llm = LLMClient(model_config_storage=get_storage())
    start_time = time.time()

    try:
        response = await llm.chat_completion(
            messages=[
                {
                    "role": "system",
                    "content": "You are a helpful assistant. Be very brief.",
                },
                {
                    "role": "user",
                    "content": "Say 'Hello! Model test successful.' in exactly those words.",
                },
            ],
            model=model_id,
            temperature=0,
            max_tokens=100 if reasoning else 50,
            reasoning_effort=effort if reasoning else None,
        )

        latency_ms = int((time.time() - start_time) * 1000)
        # chat_completion returns dict with {content, tool_calls, finish_reason, usage}
        content = response.get("content", "") or ""
        usage = response.get("usage", {})

        return {
            "success": True,
            "model_id": model_id,
            "response": content,
            "latency_ms": latency_ms,
            "tokens": {
                "prompt": usage.get("prompt_tokens", 0)
                if isinstance(usage, dict)
                else getattr(usage, "prompt_tokens", 0),
                "completion": usage.get("completion_tokens", 0)
                if isinstance(usage, dict)
                else getattr(usage, "completion_tokens", 0),
                "total": usage.get("total_tokens", 0)
                if isinstance(usage, dict)
                else getattr(usage, "total_tokens", 0),
            },
        }
    except Exception as e:
        latency_ms = int((time.time() - start_time) * 1000)
        logger.error(f"Model test failed for {model_id}: {e}")
        return {
            "success": False,
            "model_id": model_id,
            "error": str(e),
            "latency_ms": latency_ms,
        }


@router.get("/api/settings/model-config/{model_id:path}")
async def get_model_config(model_id: str):
    from llm.agent_model_params import (
        ModelConfigResolutionError,
        resolve_model_config,
    )
    from llm.model_config import ModelCapability

    try:
        config = await resolve_model_config(model_id, strict=True)
    except ModelConfigResolutionError as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "model_config_unavailable",
                "message": str(exc),
                "field": "model",
                "model": model_id,
            },
        ) from exc

    reasoning = {
        "enabled": config.reasoning.enabled,
        "effort": config.reasoning.effort,
        "supported": config.supports(ModelCapability.REASONING),
        "effort_configurable": config.reasoning.effort_configurable,
        "default_effort": config.reasoning.default_effort,
        "default_enabled": config.reasoning.default_enabled,
        "mandatory": config.reasoning.mandatory,
        "supports_max_tokens": config.reasoning.supports_max_tokens,
    }
    if config.reasoning.effort_configurable:
        reasoning["supported_efforts"] = (
            list(config.reasoning.supported_efforts)
            if config.reasoning.supported_efforts is not None
            else None
        )

    return {
        "model_id": config.model_id,
        "display_name": config.display_name,
        "provider": config.provider,
        "capabilities": [c.value for c in config.capabilities],
        "reasoning": reasoning,
        "temperature": {
            "supported": config.supports_temperature,
            "min": config.min_temperature,
            "max": config.max_temperature,
            "forced": config.force_temperature,
        },
    }


@router.post(
    "/api/settings/model-config/{model_id:path}/reasoning",
    dependencies=[Depends(require_role("tenant_admin"))],
)
async def set_model_reasoning(model_id: str, enabled: bool):
    """Enable or disable reasoning for a model at runtime."""
    from llm.model_config import get_model_registry, get_supported_parameters_from_cache

    registry = get_model_registry()
    registry.set_reasoning_enabled(model_id, enabled)

    # Return updated config
    supported_parameters = await get_supported_parameters_from_cache(model_id)
    config = registry.get_config(model_id, supported_parameters=supported_parameters)

    return {
        "model_id": model_id,
        "reasoning_enabled": config.reasoning.enabled,
        "message": f"Reasoning {'enabled' if enabled else 'disabled'} for {model_id}",
    }


@router.get("/api/settings/plugins")
async def list_plugins():
    """Catalog of platform plugins a tenant can enable and configure.

    Source of truth is the code registry, so a newly registered plugin appears
    here — and in the tenant-settings Plugins card — with no frontend change.
    Read-only: which plugins EXIST is code; whether each is ENABLED is
    per-tenant config, written through PUT /api/tenants/{id}/settings.
    """
    from plugins.registry import PLUGIN_REGISTRY

    return {
        "plugins": [
            {
                "name": name,
                "description": spec.description,
                # Instantiate per the Callable[[], Plugin] contract; the hooks
                # are a classmethod, so no per-call state is read.
                "subscribed_hooks": sorted(spec.factory().subscribed_hooks()),
                # Drives the tenant-settings editor's validation + autocomplete.
                "config_schema": spec.config_schema,
                "guide": spec.guide,
                "param_groups": spec.param_groups,
            }
            for name, spec in PLUGIN_REGISTRY.items()
        ]
    }


# Provider priority tiers for sorting
TIER1_PROVIDERS = {"openai", "anthropic", "google"}  # Highest priority
TIER2_PROVIDERS = {"qwen", "deepseek", "moonshotai"}  # Secondary priority


async def _fetch_openrouter_models() -> List[dict]:
    """Fetch models from OpenRouter API."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(OPENROUTER_MODELS_URL)
        response.raise_for_status()
        data = response.json()

    models = [
        normalize_openrouter_model(model)
        for model in data.get("data", [])
        if isinstance(model, dict)
    ]

    def sort_key(m):
        model_id = m.get("id", "")
        provider = model_id.split("/")[0] if "/" in model_id else ""
        # Tier: 0 = openai/anthropic/google, 1 = qwen/deepseek/moonshotai, 2 = others
        if provider in TIER1_PROVIDERS:
            tier = 0
        elif provider in TIER2_PROVIDERS:
            tier = 1
        else:
            tier = 2
        # Within tier, sort by newest first (negative created_at for descending)
        created = m.get("created_at") or 0
        return (tier, -created, m.get("name", "").lower())

    models.sort(key=sort_key)

    return models

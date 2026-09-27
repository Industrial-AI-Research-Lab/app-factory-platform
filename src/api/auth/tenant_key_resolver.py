"""
Tenant Key Resolver — loads per-tenant LLM API key from tenant_settings.

Priority chain:
  1. Explicit header override (x-bf-vk / X-OpenAI-Key)  — highest
  2. tenant_settings.bifrost_vk / openai_api_key          — per-tenant stored key
  3. Global env (BIFROST_VK / OPENAI_API_KEY)              — fallback (handled by LLMClient)

Usage:
    api_key, model, fallback_models = await resolve_tenant_llm_key(storage, tenant_id)
"""

from typing import List, Optional, Tuple
import logging

logger = logging.getLogger(__name__)


async def resolve_tenant_llm_key(
    storage,
    tenant_id: str | None,
) -> Tuple[Optional[str], Optional[str], Optional[List[str]]]:
    """Load LLM API key + default model + fallback models from tenant_settings.

    Returns:
        (api_key_override, model_override, fallback_models_override) — any may
        be None. fallback_models_override is distinct from an empty list: None
        means the tenant never configured it (caller should use its own
        default); [] means the tenant explicitly disabled fallback.
    """
    if not tenant_id or not storage:
        return None, None, None

    try:
        settings = await storage.get_tenant_settings(tenant_id)
    except Exception as e:
        logger.warning("Failed to load tenant_settings for %s: %s", tenant_id, e)
        return None, None, None

    if not settings:
        return None, None, None

    provider = settings.get("llm_provider", "bifrost")
    if provider == "openai":
        api_key = settings.get("openai_api_key")
    else:
        api_key = settings.get("bifrost_vk")

    model = settings.get("default_model")
    fallback_models = settings.get("fallback_models")

    return api_key or None, model or None, fallback_models

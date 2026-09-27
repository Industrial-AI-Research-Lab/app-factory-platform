"""Fail-fast startup audit for enabled agent model contracts."""

from __future__ import annotations

import logging
from typing import Any

from llm.agent_model_params import (
    AgentModelParamsValidationError,
    MODEL_PARAM_FIELDS,
    ModelConfigResolutionError,
    materialize_agent_model_params,
    validate_agent_model_params,
)

logger = logging.getLogger(__name__)


async def _validation_issue(document: dict[str, Any], *, storage) -> str | None:
    materialized = materialize_agent_model_params(document)
    params = {field: materialized[field] for field in MODEL_PARAM_FIELDS}
    try:
        await validate_agent_model_params(**params, storage=storage)
    except (AgentModelParamsValidationError, ModelConfigResolutionError) as exc:
        return str(exc)
    return None


async def assert_enabled_agent_model_params_ready(storage) -> None:
    """Reject startup when any enabled Mongo agent has an invalid model contract."""
    documents = await storage.get_agent_configurations(enabled_only=True)
    issues: list[str] = []
    for document in documents:
        if not isinstance(document, dict):
            continue
        issue = await _validation_issue(document, storage=storage)
        if issue is None:
            continue
        agent_id = str(document.get("_id") or "?")
        tenant_id = str(document.get("tenant_id") or "?")
        detail = f"tenant_id={tenant_id} agent={agent_id} error={issue}"
        issues.append(detail)
        logger.error("[AGENT_MODEL_AUDIT] %s", detail)

    if not issues:
        logger.info(
            "[AGENT_MODEL_AUDIT] enabled_agents=%d status=ready",
            len(documents),
        )
        return

    preview = "; ".join(issues[:8])
    suffix = f" (+{len(issues) - 8} more)" if len(issues) > 8 else ""
    raise RuntimeError(
        "[AGENT_MODEL_AUDIT] Enabled agent model migration required before "
        f"runtime: {preview}{suffix}. Run "
        "python -m scripts.migrate_agent_model_params --apply"
    )

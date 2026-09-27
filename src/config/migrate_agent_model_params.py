"""Dry-run-first migration for legacy flat agent model parameters."""

from __future__ import annotations

import logging
import math
from dataclasses import asdict, dataclass, field
from types import SimpleNamespace
from typing import Any

from llm.agent_model_params import (
    DEFAULT_AGENT_MODEL,
    AgentModelParamsValidationError,
    MODEL_PARAM_FIELDS,
    ModelConfigResolutionError,
    materialize_agent_model_params,
    resolve_model_config,
    validate_agent_model_params,
)
from llm.model_config import ModelCapability, ModelConfig

logger = logging.getLogger(__name__)

MIGRATION_ACTOR = "migration:agent_model_params_v1"


@dataclass
class AgentModelParamsMigrationReport:
    scanned: int = 0
    enabled_scanned: int = 0
    normalized: int = 0
    enabled_normalized: int = 0
    applied: int = 0
    unchanged: int = 0
    skipped: int = 0
    enabled_skipped: int = 0
    disabled_skipped: int = 0
    conflicted: int = 0
    issues: list[dict[str, str]] = field(default_factory=list)

    def as_dict(self) -> dict[str, int]:
        values = asdict(self)
        values.pop("issues")
        return values


def _migration_error(
    *,
    code: str,
    message: str,
    field_name: str,
    model: str | None = None,
) -> AgentModelParamsValidationError:
    return AgentModelParamsValidationError(
        code=code,
        message=message,
        field=field_name,
        model=model,
    )


def _canonical_reasoning_effort(
    effort: Any,
    *,
    config: ModelConfig,
    model: str,
) -> str | None:
    """Map a legacy effort to the nearest explicit model contract value."""
    normalized_effort = effort.strip() or None if isinstance(effort, str) else effort
    reasoning = config.reasoning
    if not config.supports(ModelCapability.REASONING) or not reasoning.effort_configurable:
        if reasoning.mandatory:
            raise _migration_error(
                code="reasoning_effort_required",
                message=f"Model '{model}' requires a selectable reasoning effort",
                field_name="reasoning_effort",
                model=model,
            )
        return None

    allowed = reasoning.allowed_efforts()
    if normalized_effort in allowed:
        return normalized_effort
    if reasoning.default_effort in allowed:
        return reasoning.default_effort
    if reasoning.mandatory:
        raise _migration_error(
            code="reasoning_effort_required",
            message=f"Model '{model}' requires a valid reasoning effort",
            field_name="reasoning_effort",
            model=model,
        )
    return None


async def normalize_legacy_agent_model_params(
    document: dict[str, Any],
    *,
    storage,
) -> dict[str, Any]:
    """Return a fully validated model contract for one legacy agent document."""
    materialized = materialize_agent_model_params(document)
    model = materialized.get("model")
    if not isinstance(model, str):
        raise _migration_error(
            code="invalid_model",
            message="Model must be a string",
            field_name="model",
        )
    model = model.strip() or DEFAULT_AGENT_MODEL

    temperature = materialized.get("temperature")
    if temperature is None:
        normalized_temperature = None
    elif isinstance(temperature, bool) or not isinstance(temperature, (int, float)):
        raise _migration_error(
            code="invalid_temperature",
            message="Temperature must be a finite number or null",
            field_name="temperature",
            model=model,
        )
    else:
        normalized_temperature = float(temperature)
        if not math.isfinite(normalized_temperature):
            raise _migration_error(
                code="invalid_temperature",
                message="Temperature must be a finite number or null",
                field_name="temperature",
                model=model,
            )

    config = await resolve_model_config(
        model,
        storage=storage,
        strict=True,
        require_known=True,
    )
    normalized = {
        "model": model,
        "temperature": config.resolve_temperature(normalized_temperature),
        "reasoning_effort": _canonical_reasoning_effort(
            materialized.get("reasoning_effort"),
            config=config,
            model=model,
        ),
    }
    await validate_agent_model_params(
        **normalized,
        storage=storage,
    )
    return normalized


def _model_fields_changed(
    document: dict[str, Any],
    normalized: dict[str, Any],
) -> bool:
    return any(
        field_name not in document or document.get(field_name) != normalized[field_name]
        for field_name in MODEL_PARAM_FIELDS
    )


def _model_fields_cas_filter(document: dict[str, Any]) -> dict[str, Any]:
    compare_and_swap: dict[str, Any] = {"_id": document["_id"]}
    for field_name in MODEL_PARAM_FIELDS:
        compare_and_swap[field_name] = (
            document[field_name] if field_name in document else {"$exists": False}
        )
    return compare_and_swap


async def migrate_agent_model_params(
    database,
    *,
    apply: bool,
) -> AgentModelParamsMigrationReport:
    """Plan or apply idempotent model-parameter normalization for all agents."""
    report = AgentModelParamsMigrationReport()
    plans: list[tuple[dict[str, Any], dict[str, Any]]] = []
    storage = SimpleNamespace(db=database)

    async for document in database.agent_configurations.find({}):
        report.scanned += 1
        enabled = document.get("enabled") is True
        if enabled:
            report.enabled_scanned += 1
        agent_id = str(document.get("_id") or "")
        try:
            normalized = await normalize_legacy_agent_model_params(
                document,
                storage=storage,
            )
        except (AgentModelParamsValidationError, ModelConfigResolutionError) as exc:
            report.skipped += 1
            if enabled:
                report.enabled_skipped += 1
            else:
                report.disabled_skipped += 1
            report.issues.append({"agent_id": agent_id, "error": str(exc)})
            logger.warning(
                "[MIGRATE_AGENT_MODEL_PARAMS] agent=%s action=skip — %s",
                agent_id,
                exc,
            )
            continue

        if not _model_fields_changed(document, normalized):
            report.unchanged += 1
            continue
        report.normalized += 1
        if enabled:
            report.enabled_normalized += 1
        plans.append((document, normalized))

    if not apply:
        logger.info(
            "[MIGRATE_AGENT_MODEL_PARAMS] mode=dry-run scanned=%d normalized=%d "
            "unchanged=%d skipped=%d",
            report.scanned,
            report.normalized,
            report.unchanged,
            report.skipped,
        )
        return report

    for document, normalized in plans:
        agent_id = str(document.get("_id") or "")
        result = await database.agent_configurations.update_one(
            _model_fields_cas_filter(document),
            {
                "$set": {
                    **normalized,
                    "updated_by": MIGRATION_ACTOR,
                },
                "$currentDate": {"updated_at": True},
            },
        )
        if result.matched_count:
            report.applied += 1
            logger.info(
                "[MIGRATE_AGENT_MODEL_PARAMS] agent=%s action=normalized",
                agent_id,
            )
        else:
            report.conflicted += 1
            report.issues.append(
                {
                    "agent_id": agent_id,
                    "error": "document changed after migration scan",
                }
            )
            logger.warning(
                "[MIGRATE_AGENT_MODEL_PARAMS] agent=%s action=conflict "
                "— document changed after scan",
                agent_id,
            )
    return report

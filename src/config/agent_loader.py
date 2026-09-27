"""
Agent Loader - loads agent configurations from MongoDB and creates GenericAgent instances.

Flow:
1. Upsert agent_configurations from agents.yaml (only writes if changed)
2. Load enabled configs from MongoDB
3. For each enabled config -> create GenericAgent(config)
4. Return List[BaseAgent]

All agents are GenericAgent. One class, different configs.
"""

from __future__ import annotations

import logging
from typing import List

from agents.generic_agent import GenericAgent
from agents.base import BaseAgent
from config.configuration_resolution import (
    dedupe_tenant_configs_by_wire_name,
)
from config.seed import seed_agents, seed_tools, seed_workflows
from config.seed_controls import seed_writes_enabled
from config.configuration_identity_guard import assert_stored_configuration_identity_ready
from config.agent_model_audit import assert_enabled_agent_model_params_ready

logger = logging.getLogger(__name__)


# Backward-compatible alias used across API routes and tests.
dedupe_agent_configs_by_wire_name = dedupe_tenant_configs_by_wire_name


def _build_agents_from_configs(configs: List[dict]) -> List[BaseAgent]:
    """Instantiate GenericAgent objects from MongoDB configuration docs."""
    agents: List[BaseAgent] = []
    for cfg in configs:
        try:
            agent = GenericAgent(cfg)
            agents.append(agent)
            logger.info(
                "[LOADER] Created %s (type=%s, model=%s, phases=%s, tools=%d)",
                agent.agent_id,
                agent.agent_type.value,
                agent.model,
                agent.allowed_phases,
                len(getattr(agent, "_effective_allowed_tools", None) or agent.allowed_tools),
            )
        except Exception as e:
            logger.error("[LOADER] Failed to create agent from config '%s': %s", cfg.get("_id"), e)
    return agents


async def load_tenant_agent_prototypes(storage, tenant_id: str) -> List[BaseAgent]:
    """Load enabled agents for a tenant with override resolution and wire dedupe."""
    tenant = str(tenant_id or "").strip()
    if not tenant:
        raise ValueError("tenant_id is required for tenant agent prototypes")
    configs = await storage.get_agent_configurations(enabled_only=False, tenant_id=tenant)
    deduped = dedupe_agent_configs_by_wire_name(configs, tenant, enabled_only=True)
    logger.info(
        "[LOADER] tenant_id=%s resolved_prototypes=%d raw_configs=%d",
        tenant,
        len(deduped),
        len(configs),
    )
    return _build_agents_from_configs(deduped)


async def load_enabled_agents_from_db(storage) -> List[BaseAgent]:
    """Load enabled agent configurations from MongoDB without seed writes."""
    configs = await storage.get_agent_configurations(enabled_only=True)
    logger.info("[LOADER] Loaded %d enabled agent configurations from MongoDB", len(configs))
    if not configs:
        logger.error("[LOADER] agent_count=0 - no enabled agent configurations in MongoDB")
        raise RuntimeError("No enabled agent configurations found in MongoDB.")

    agents = _build_agents_from_configs(configs)
    if not agents:
        logger.error(
            "[LOADER] created_agent_count=0 config_count=%d - all enabled configs failed GenericAgent creation",
            len(configs),
        )
        raise RuntimeError(
            "Failed to create any agent instances from enabled MongoDB configurations."
        )

    logger.info("[LOADER] Loaded %d agents from MongoDB", len(agents))
    return agents


async def load_agents_from_db(storage) -> List[BaseAgent]:
    """Load all enabled agent configurations from MongoDB and create GenericAgent instances.

    Always upserts from agents.yaml first so config changes propagate on redeploy.

    Args:
        storage: MongoStorageBackend instance with agent_configurations collection.

    Returns:
        List of BaseAgent (GenericAgent) instances ready for orchestrator registration.
    """
    writes_enabled = seed_writes_enabled()

    # Upsert from YAML - only writes if configs differ
    changed = await seed_agents(storage)
    if changed:
        logger.info(
            "[LOADER] kind=agent mode=%s changed=%d source=agents.yaml",
            "write" if writes_enabled else "dry-run",
            changed,
        )

    wf_changed = await seed_workflows(storage)
    if wf_changed:
        logger.info(
            "[LOADER] kind=workflow mode=%s changed=%d source=workflows.json",
            "write" if writes_enabled else "dry-run",
            wf_changed,
        )

    tools_changed = await seed_tools(storage)
    if tools_changed:
        logger.info(
            "[LOADER] kind=tool mode=%s changed=%d source=tools.yaml",
            "write" if writes_enabled else "dry-run",
            tools_changed,
        )

    await assert_stored_configuration_identity_ready(storage)
    await assert_enabled_agent_model_params_ready(storage)

    return await load_enabled_agents_from_db(storage)

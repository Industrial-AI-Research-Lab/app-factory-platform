"""Helpers for syncing in-memory runtime state with MongoDB configuration changes."""

from __future__ import annotations

import logging

from api import deps
from config.configuration_identity_guard import assert_stored_configuration_identity_ready
from config.agent_loader import load_enabled_agents_from_db

logger = logging.getLogger(__name__)


async def reload_runtime_agents(reason: str) -> bool:
    """Reload orchestrator agent prototypes from MongoDB in the current process."""
    orchestrator = deps.get_orchestrator()
    storage = deps.get_storage()
    if not orchestrator or not storage:
        logger.warning("[RUNTIME_SYNC] kind=agents reason=%s skipped=true - runtime not initialized", reason)
        return False

    await assert_stored_configuration_identity_ready(storage)
    agents = await load_enabled_agents_from_db(storage)

    old_count = len(orchestrator.agent_pool)
    orchestrator.agent_pool = []
    orchestrator.auction.critic_agent = None

    for agent in agents:
        orchestrator.register_agent(agent)
        agent.mcp_executor = getattr(orchestrator, "mcp_executor", None)
        try:
            agent.deploy_service = getattr(orchestrator, "deploy_service", None)
        except Exception:
            pass

    logger.info(
        "[RUNTIME_SYNC] kind=agents reason=%s old_count=%d new_count=%d",
        reason,
        old_count,
        len(orchestrator.agent_pool),
    )
    return True


async def reload_runtime_tool_registry(reason: str) -> bool:
    """Reload tool registry from MongoDB in the current process."""
    orchestrator = deps.get_orchestrator()
    storage = deps.get_storage()
    if not orchestrator or not storage or not getattr(orchestrator, "tool_registry", None):
        logger.warning("[RUNTIME_SYNC] kind=tools reason=%s skipped=true - runtime not initialized", reason)
        return False

    old_count = len(orchestrator.tool_registry.tools)
    await orchestrator.tool_registry.load_from_db(storage)
    new_count = len(orchestrator.tool_registry.tools)

    logger.info(
        "[RUNTIME_SYNC] kind=tools reason=%s old_count=%d new_count=%d",
        reason,
        old_count,
        new_count,
    )
    return True


async def sync_runtime_after_config_change(reason: str, *, agents: bool = False, tools: bool = False) -> None:
    """Best-effort runtime synchronization hook for configuration writes."""
    if agents:
        try:
            await reload_runtime_agents(reason)
        except Exception as exc:
            logger.exception("[RUNTIME_SYNC] kind=agents reason=%s failed: %s", reason, exc)

    if tools:
        try:
            await reload_runtime_tool_registry(reason)
        except Exception as exc:
            logger.exception("[RUNTIME_SYNC] kind=tools reason=%s failed: %s", reason, exc)

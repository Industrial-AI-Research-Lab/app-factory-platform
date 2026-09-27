"""
Agent runtime-context endpoint for the diagnostic drawer.

Returns a snapshot of what a specific agent within a project currently looks
like at runtime: identity, model, available tools, recent task history, and
the conversation slice from the project's shared context.

Used by the frontend `DiagnosticDrawer` to populate the System prompt /
Conversation / Tools sections. Also linkable directly as a JSON view (via
target=_blank from the drawer's live header) for inspection in a new tab.
"""

from typing import Any, Dict, List
import logging

from fastapi import APIRouter, Depends, HTTPException

from api import deps
from api.auth.middleware import require_auth
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import load_authorized_project

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/projects/{project_id}/agents",
    tags=["agents"],
    dependencies=[Depends(require_auth)],
)


def _find_agent(pool, agent_id: str):
    """Match by full id, by base id (before '@'), or by base id of pool entry."""
    if not pool:
        return None
    requested_base = agent_id.split("@")[0]
    for a in pool:
        aid = getattr(a, "agent_id", None)
        if not aid:
            continue
        if aid == agent_id:
            return a
        if aid.split("@")[0] == requested_base:
            return a
    return None


@router.get("/{agent_id}/context")
async def get_agent_context(
    project_id: str,
    agent_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
) -> Dict[str, Any]:
    orchestrator = deps.get_orchestrator()
    if not orchestrator:
        raise HTTPException(status_code=503, detail="Orchestrator not initialized")

    await load_authorized_project(project_id, tenant_ctx)

    project = orchestrator.active_projects.get(project_id)
    pool = (project.get("agents") if project else None) or orchestrator.agent_pool
    agent = _find_agent(pool, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not registered for project")

    agent_type_obj = getattr(agent, "agent_type", None)
    if agent_type_obj is None:
        agent_type = None
    else:
        agent_type = getattr(agent_type_obj, "value", None) or str(agent_type_obj)

    # Tools available to this agent. Returns shape: [{id, description, category}]
    tools: List[Dict[str, Any]] = []
    tool_registry = getattr(agent, "tool_registry", None)
    if tool_registry and hasattr(tool_registry, "get_tools_for_agent"):
        try:
            for t in tool_registry.get_tools_for_agent(agent.agent_id) or []:
                tools.append({
                    "id": t.get("tool_id"),
                    "description": (t.get("description") or "")[:300],
                    "category": t.get("category"),
                })
        except Exception as e:
            logger.warning("[AGENT_CONTEXT] failed to list tools for %s: %s", agent.agent_id, e)

    # Recent task history. task_history is an instance attribute on BaseAgent;
    # entries are dicts the agent appended during run_phase calls. Truncate
    # content fields to keep the response small.
    task_history: List[Dict[str, Any]] = []
    raw_history = getattr(agent, "task_history", None) or []
    for h in raw_history[-5:]:
        if not isinstance(h, dict):
            continue
        task_history.append({
            "task_id": h.get("task_id") or h.get("id"),
            "phase": h.get("phase"),
            "status": h.get("status"),
            "summary": (h.get("summary") or h.get("description") or "")[:200],
        })

    # Conversation slice from project shared_context.
    conversation_preview: List[Dict[str, Any]] = []
    shared_context_keys: List[str] = []
    if project:
        sc = project.get("shared_context")
        if sc is not None:
            try:
                if hasattr(sc, "get_full_context_async"):
                    full = await sc.get_full_context_async()
                elif hasattr(sc, "get_full_context"):
                    full = sc.get_full_context()
                else:
                    full = {}
                if isinstance(full, dict):
                    shared_context_keys = sorted(list(full.keys()))[:40]
                    conv = full.get("conversation_history") or []
                    for entry in conv[-15:]:
                        if not isinstance(entry, dict):
                            continue
                        content = entry.get("content")
                        if isinstance(content, list):  # multimodal — flatten to text only
                            content = " ".join(
                                str(p.get("text", "")) if isinstance(p, dict) else str(p)
                                for p in content
                            )
                        conversation_preview.append({
                            "role": entry.get("role"),
                            "content_preview": (str(content or ""))[:300],
                            "agent_id": entry.get("agent_id"),
                        })
            except Exception as e:
                logger.warning("[AGENT_CONTEXT] failed to extract shared_context for %s: %s", agent.agent_id, e)

    # system_prompt is only populated by agents that store one as an instance
    # attribute (e.g. GenericAgent). Specialized agents (Planner, Coding, QA,
    # ...) build prompts per-task with shared_context inputs and don't expose
    # a static prompt. Returns null in that case — UI shows a hint instead of
    # an empty section.
    system_prompt = getattr(agent, "system_prompt", None)
    if not isinstance(system_prompt, str):
        system_prompt = None

    return {
        "agent_id": agent.agent_id,
        "agent_type": agent_type,
        "model": getattr(agent, "model", None),
        "temperature": getattr(agent, "temperature", None),
        "allowed_phases": getattr(agent, "allowed_phases", None),
        "system_prompt": system_prompt,
        "tools": tools,
        "task_history": task_history,
        "conversation_preview": conversation_preview,
        "shared_context_keys": shared_context_keys,
    }

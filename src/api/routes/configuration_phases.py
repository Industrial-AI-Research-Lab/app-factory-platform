"""Read-only configuration phase dictionary.

Prefix: /api/configurations/phases
Auth: tenant-scoped (same workflow visibility as GET /configurations/workflows/).
"""

from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException

from api.auth.tenant_context import TenantContext, get_tenant_context
from api.deps import get_storage
from config.agent_loader import dedupe_agent_configs_by_wire_name
from schemas.configuration_schemas import PhaseDictionaryItem

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/configurations/phases",
    tags=["configurations"],
)


def collect_phase_ids_from_workflows(workflows: list) -> list[str]:
    """Extract unique phase ids from workflow nodes (parity with AgentConfigurations UI)."""
    phase_set: set[str] = set()
    for workflow in workflows:
        if not isinstance(workflow, dict):
            continue
        for node in workflow.get("nodes") or []:
            if not isinstance(node, dict):
                continue
            if node.get("type") == "phase":
                task_type = str(node.get("task_type") or "").strip()
                if task_type:
                    phase_set.add(task_type)
            phase_label = str(node.get("phase_label") or "").strip()
            if phase_label:
                phase_set.add(phase_label)
    return sorted(phase_set)


def _filter_phases_by_query(phases: list[str], query: Optional[str]) -> list[str]:
    needle = str(query or "").strip().casefold()
    if not needle:
        return phases
    return [
        phase_id
        for phase_id in phases
        if needle in phase_id.casefold()
    ]


async def _accessible_workflows(storage, ctx: TenantContext, *, enabled_only: bool) -> list:
    tid = None if ctx.is_root else ctx.tenant_id
    workflows = await storage.get_workflow_definitions(tenant_id=tid)
    if tid and not ctx.is_root and enabled_only:
        workflows = dedupe_agent_configs_by_wire_name(
            [w for w in workflows if isinstance(w, dict)],
            str(tid),
            enabled_only=True,
        )
    return [w for w in workflows if isinstance(w, dict)]


@router.get("/", response_model=List[PhaseDictionaryItem])
async def list_configuration_phases(
    q: Optional[str] = None,
    enabled_only: bool = True,
    ctx: TenantContext = Depends(get_tenant_context),
):
    """Return unique phase ids from workflows visible to the caller."""
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")

    workflows = await _accessible_workflows(storage, ctx, enabled_only=enabled_only)
    phase_ids = collect_phase_ids_from_workflows(workflows)
    filtered = _filter_phases_by_query(phase_ids, q)
    items = [PhaseDictionaryItem(id=phase_id, label=phase_id) for phase_id in filtered]
    logger.info(
        "[CONFIG-API] Listed phases count=%s q=%r tenant=%s enabled_only=%s",
        len(items),
        q,
        ctx.tenant_id,
        enabled_only,
    )
    return items

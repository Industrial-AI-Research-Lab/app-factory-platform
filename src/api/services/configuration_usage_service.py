"""Usage aggregation helpers for configuration API responses."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from config.agent_loader import dedupe_agent_configs_by_wire_name
from config.configuration_resolution import SYSTEM_TENANT_ID, agent_wire_name_from_doc


WorkflowUsageByAgent = dict[str, list[dict[str, str]]]
_USAGE_KEY_SEPARATOR = "\x1f"


def workflow_usage_agent_key(
    agent_wire_id: str,
    *,
    tenant_id: str | None = None,
) -> str:
    """Return the usage lookup key for an agent wire id."""
    wire = str(agent_wire_id or "").strip()
    tenant = str(tenant_id or "").strip()
    if tenant:
        return f"{tenant}{_USAGE_KEY_SEPARATOR}{wire}"
    return wire


def _agent_tenant_id(doc: dict[str, Any]) -> str:
    return str(doc.get("tenant_id") or SYSTEM_TENANT_ID).strip()


def _build_agent_lookup(
    agent_docs: list[dict[str, Any]],
    *,
    enabled_only: bool,
) -> set[str]:
    lookup: set[str] = set()
    for doc in agent_docs:
        if not isinstance(doc, dict):
            continue
        if enabled_only and doc.get("enabled") is False:
            continue
        tenant_id = _agent_tenant_id(doc)
        wire_id = agent_wire_name_from_doc(doc, runtime_tenant_id=tenant_id)
        if not wire_id:
            continue
        lookup.add(workflow_usage_agent_key(wire_id, tenant_id=tenant_id))
    return lookup


def _resolve_agent_usage_key(
    agent_ref: str,
    *,
    workflow_tenant_id: str,
    agent_lookup: set[str],
    include_tenant: bool,
) -> str | None:
    tenant_key = workflow_usage_agent_key(agent_ref, tenant_id=workflow_tenant_id)
    system_key = workflow_usage_agent_key(agent_ref, tenant_id=SYSTEM_TENANT_ID)

    if tenant_key in agent_lookup:
        return tenant_key if include_tenant else workflow_usage_agent_key(agent_ref)
    if system_key in agent_lookup:
        return system_key if include_tenant else workflow_usage_agent_key(agent_ref)
    return None


async def list_visible_workflow_definitions_for_usage(
    storage: Any,
    *,
    tenant_id: str | None,
    is_root: bool,
    enabled_only: bool = True,
) -> list[dict[str, Any]]:
    """Return workflow definitions using the same scope as the workflows API."""
    lookup_tenant = None if is_root else tenant_id
    workflows = await storage.get_workflow_definitions(tenant_id=lookup_tenant)
    workflow_docs = [w for w in workflows if isinstance(w, dict)]
    if lookup_tenant and enabled_only:
        workflow_docs = dedupe_agent_configs_by_wire_name(
            workflow_docs,
            str(lookup_tenant),
            enabled_only=True,
        )
    return workflow_docs


def build_workflow_usage_by_agent(
    workflows: list[dict[str, Any]],
    *,
    agent_docs: list[dict[str, Any]],
    include_tenant: bool = False,
    enabled_only: bool = True,
) -> WorkflowUsageByAgent:
    """Index direct workflow-node references by resolved agent identity."""
    usage: WorkflowUsageByAgent = defaultdict(list)
    agent_lookup = _build_agent_lookup(agent_docs, enabled_only=enabled_only)
    for workflow in workflows:
        workflow_id = str(
            workflow.get("_id") or workflow.get("id") or workflow.get("name") or ""
        ).strip()
        if not workflow_id:
            continue
        workflow_name = (
            str(
                workflow.get("name") or workflow.get("display_name") or workflow_id
            ).strip()
            or workflow_id
        )
        usage_item = {"id": workflow_id, "name": workflow_name}
        tenant_id = str(workflow.get("tenant_id") or SYSTEM_TENANT_ID).strip()

        refs_in_workflow: set[str] = set()
        for node in workflow.get("nodes") or []:
            if not isinstance(node, dict):
                continue
            if node.get("agent_selection") != "direct":
                continue
            agent_ref = str(node.get("agent_type") or "").strip()
            if not agent_ref:
                continue
            usage_key = _resolve_agent_usage_key(
                agent_ref,
                workflow_tenant_id=tenant_id,
                agent_lookup=agent_lookup,
                include_tenant=include_tenant,
            )
            if not usage_key or usage_key in refs_in_workflow:
                continue
            refs_in_workflow.add(usage_key)
            usage[usage_key].append(usage_item)
    return dict(usage)

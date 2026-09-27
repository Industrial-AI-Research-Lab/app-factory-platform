"""Agent delegation identity: compare agents by (tenant, name), not prefix aliases."""

from __future__ import annotations

from typing import Any, Optional

from config.configuration_resolution import (
    SYSTEM_TENANT_ID,
    agent_wire_name_from_doc,
    configuration_identity_name,
)


def base_agent_id(agent_id: Optional[str]) -> str:
    """Return config-level agent id without the runtime project suffix."""
    raw = str(agent_id or "").strip()
    return raw.split("@", 1)[0] if "@" in raw else raw


def bare_delegation_name(agent_ref: str, tenant_id: Optional[str] = None) -> str:
    """Normalize a delegation reference to its bare agent name.

    Strips only the runtime ``@project`` suffix. Legacy ``tenant__`` prefixes must
    be removed by migration — not at runtime. ``tenant_id`` is kept for call-site
    symmetry; tenant scope is applied in ``agent_identities_equal``, not here.
    """
    _ = tenant_id
    return base_agent_id(agent_ref)


def agent_identity_from_config(
    config: dict[str, Any],
    *,
    runtime_tenant_id: Optional[str] = None,
) -> tuple[str, str]:
    """Derive ``(tenant_id, name)`` identity from an agent configuration document."""
    tenant = str(
        config.get("tenant_id") or runtime_tenant_id or SYSTEM_TENANT_ID,
    ).strip()
    identity_name = agent_wire_name_from_doc(
        config,
        runtime_tenant_id=runtime_tenant_id,
    )
    if identity_name:
        return tenant, identity_name
    storage_id = str(config.get("_id") or "").strip()
    return tenant, storage_id


def agent_identities_equal(
    tenant_a: str,
    name_a: str,
    tenant_b: str,
    name_b: str,
    *,
    scope_tenant: Optional[str] = None,
) -> bool:
    """Return whether two agent identities refer to the same delegation target."""
    if not name_a or not name_b or name_a != name_b:
        return False
    if tenant_a == tenant_b:
        return True
    if tenant_a == SYSTEM_TENANT_ID or tenant_b == SYSTEM_TENANT_ID:
        if scope_tenant and {tenant_a, tenant_b} <= {SYSTEM_TENANT_ID, scope_tenant}:
            return True
    return False


def agent_identity_from_runtime(
    agent: Any,
    *,
    parent_tenant: Optional[str] = None,
) -> tuple[str, str]:
    """Derive delegation identity from a runtime agent (config + runtime id)."""
    config = getattr(agent, "config", None)
    if isinstance(config, dict) and (
        config.get("_id") or configuration_identity_name(config)
    ):
        return agent_identity_from_config(config, runtime_tenant_id=parent_tenant)

    runtime_id = base_agent_id(getattr(agent, "agent_id", ""))
    tenant = SYSTEM_TENANT_ID
    if isinstance(config, dict) and config.get("tenant_id"):
        tenant = str(config["tenant_id"])
    elif parent_tenant:
        tenant = parent_tenant
    return tenant, runtime_id


def agent_identity_matches_reference(
    config: dict[str, Any],
    requested_ref: str,
    *,
    parent_tenant: Optional[str] = None,
    runtime_agent: Any = None,
) -> bool:
    """Return whether ``config``/runtime agent resolves the bare delegation reference."""
    requested_name = bare_delegation_name(requested_ref, parent_tenant)
    if not requested_name:
        return False

    if runtime_agent is not None:
        tenant, name = agent_identity_from_runtime(
            runtime_agent,
            parent_tenant=parent_tenant,
        )
    else:
        tenant, name = agent_identity_from_config(config, runtime_tenant_id=parent_tenant)
    return agent_identities_equal(
        parent_tenant or tenant,
        requested_name,
        tenant,
        name,
        scope_tenant=parent_tenant,
    )


def delegation_agent_references_match(
    requested_id: str,
    candidate_id: str,
    tenant_id: Optional[str] = None,
    *,
    candidate_config: Optional[dict[str, Any]] = None,
    parent_config: Optional[dict[str, Any]] = None,
) -> bool:
    """Return whether two agent references refer to the same configured agent."""
    requested_name = bare_delegation_name(requested_id, tenant_id)
    if not requested_name:
        return False

    if isinstance(parent_config, dict) and isinstance(candidate_config, dict):
        if parent_config is candidate_config:
            parent_tenant, parent_name = agent_identity_from_config(
                parent_config,
                runtime_tenant_id=tenant_id,
            )
            return agent_identities_equal(
                parent_tenant,
                parent_name,
                *agent_identity_from_config(candidate_config, runtime_tenant_id=tenant_id),
                scope_tenant=tenant_id,
            )

    if isinstance(candidate_config, dict):
        return agent_identity_matches_reference(
            candidate_config,
            requested_id,
            parent_tenant=tenant_id,
        )

    candidate_name = bare_delegation_name(candidate_id, tenant_id)
    return agent_identities_equal(
        tenant_id or SYSTEM_TENANT_ID,
        requested_name,
        tenant_id or SYSTEM_TENANT_ID,
        candidate_name,
        scope_tenant=tenant_id,
    )

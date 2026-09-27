"""Tenant-aware resource identity for agent configuration API operations."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException

from api.auth.tenant_context import TenantContext
from config.configuration_resolution import SYSTEM_TENANT_ID


logger = logging.getLogger(__name__)


def agent_owner_tenant_id(doc: dict[str, Any]) -> str:
    """Return the persisted owner, normalizing legacy system documents."""
    owner = str(doc.get("tenant_id") or SYSTEM_TENANT_ID).strip()
    return owner or SYSTEM_TENANT_ID


async def resolve_agent_configuration_resource(
    storage,
    ctx: TenantContext,
    agent_id: str,
    *,
    selected_tenant_id: str | None,
) -> dict[str, Any] | None:
    """Resolve an API wire id without allowing root cross-tenant ambiguity."""
    if not ctx.is_root:
        if selected_tenant_id is not None:
            raise HTTPException(
                status_code=403,
                detail="tenant_id selector is only available to root users",
            )
        return await storage.get_agent_configuration(
            agent_id,
            tenant_id=str(ctx.tenant_id),
        )

    requested_tenant = None
    if selected_tenant_id is not None:
        requested_tenant = str(selected_tenant_id).strip()
        if not requested_tenant:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "invalid_tenant_id",
                    "message": "tenant_id must not be empty",
                    "field": "tenant_id",
                },
            )

    candidates = await storage.find_agent_configurations_by_wire_id(agent_id)
    if requested_tenant is not None:
        candidates = [
            doc for doc in candidates
            if agent_owner_tenant_id(doc) == requested_tenant
        ]

    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]

    owners = sorted({agent_owner_tenant_id(doc) for doc in candidates})
    logger.warning(
        "[CONFIG-API] agent_id=%s tenant_id=%s matches=%s owners=%s "
        "- refusing ambiguous root lookup",
        agent_id,
        requested_tenant,
        len(candidates),
        owners,
    )
    if requested_tenant is None and len(owners) > 1:
        message = (
            f"Agent '{agent_id}' exists in multiple tenants; provide tenant_id"
        )
    else:
        message = (
            f"Agent '{agent_id}' matches multiple configurations for tenant "
            f"'{requested_tenant or owners[0]}'"
        )
    raise HTTPException(
        status_code=409,
        detail={
            "code": "ambiguous_agent_id",
            "message": message,
            "field": "tenant_id",
            "agent_id": agent_id,
            "allowed": owners,
        },
    )

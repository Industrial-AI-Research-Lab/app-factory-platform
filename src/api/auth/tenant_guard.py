"""Tenant isolation guards for project-scoped endpoints."""

from fastapi import HTTPException
from typing import Any

from api.auth.tenant_context import TenantContext
from api.deps import get_storage


async def verify_project_tenant(
    project: dict | None,
    tenant_ctx: TenantContext,
    *,
    label: str = "Project",
) -> dict:
    """Verify that the loaded project belongs to the caller's tenant."""
    if not project:
        raise HTTPException(status_code=404, detail=f"{label} not found")

    if tenant_ctx.is_root:
        return project

    project_tenant = project.get("tenant_id")
    if not project_tenant or project_tenant != tenant_ctx.tenant_id:
        raise HTTPException(status_code=404, detail=f"{label} not found")

    return project


async def load_authorized_project(
    project_id: str,
    tenant_ctx: TenantContext,
    *,
    label: str = "Project",
) -> tuple[Any, dict]:
    """Load project from storage and enforce tenant isolation."""
    storage = get_storage()
    if not storage:
        raise HTTPException(status_code=500, detail="Storage not initialized")
    db_project = await storage.load_project(project_id)
    await verify_project_tenant(db_project, tenant_ctx, label=label)
    return storage, db_project

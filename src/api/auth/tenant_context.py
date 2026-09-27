"""
Tenant context — extracts tenant info from authenticated user for use in routes.

Usage:
    from api.auth.tenant_context import TenantContext, get_tenant_context

    @router.get("/items")
    async def list_items(ctx: TenantContext = Depends(get_tenant_context)):
        items = await storage.get_items(tenant_id=ctx.tenant_id)
"""

from dataclasses import dataclass

from fastapi import Depends

from api.auth.middleware import require_auth


@dataclass
class TenantContext:
    """Immutable tenant context extracted from JWT / authenticated user."""
    tenant_id: str
    user_id: str
    role: str

    @property
    def is_root(self) -> bool:
        return self.role == "root"


async def get_tenant_context(user: dict = Depends(require_auth)) -> TenantContext:
    """FastAPI dependency — build TenantContext from authenticated user."""
    return TenantContext(
        tenant_id=user.get("tenant_id", ""),
        user_id=user["_id"],
        role=user.get("role", "viewer"),
    )

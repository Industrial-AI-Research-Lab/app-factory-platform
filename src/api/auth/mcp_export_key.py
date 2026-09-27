"""
Auth for GET /mcp-servers/cursor-json-http.

1. Per-tenant API keys in MongoDB (tenant_settings.mcp_export_api_keys[], bcrypt hash)
2. JWT (normal UI session)

Invalid X-Api-Key that is not a syn_mcp_* export key does not block JWT fallback.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import Depends, Header, HTTPException, status

from api import deps
from api.auth.middleware import oauth2_scheme, require_auth
from api.auth.tenant_context import TenantContext
from api.auth.tenant_mcp_export_keys import MCP_EXPORT_KEY_PREFIX, verify_mcp_export_api_key

logger = logging.getLogger(__name__)


def _looks_like_export_api_key(value: str) -> bool:
    return bool(value) and value.startswith(MCP_EXPORT_KEY_PREFIX)


async def _try_mongo_export_key(provided: str) -> TenantContext | None:
    if not _looks_like_export_api_key(provided):
        return None
    storage = deps.get_storage()
    if storage is None:
        return None
    verified = await verify_mcp_export_api_key(storage, provided)
    if not verified:
        return None
    tenant_id, entry = verified
    key_id = str(entry.get("id") or "")
    logger.info(
        "[AUTH] [MCP_EXPORT] tenant_id=%s key_id=%s — tenant export key accepted",
        tenant_id,
        key_id,
    )
    return TenantContext(
        tenant_id=tenant_id,
        user_id=f"mcp-export-key:{key_id}",
        role="viewer",
    )


async def get_tenant_context_for_cursor_json_http_export(
    token: Optional[str] = Depends(oauth2_scheme),
    x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
) -> TenantContext:
    """Mongo export API key (X-Api-Key or Bearer syn_mcp_*) or JWT session."""
    x_key = str(x_api_key).strip() if x_api_key is not None and str(x_api_key).strip() else ""

    x_key_invalid_export = False
    if x_key:
        ctx = await _try_mongo_export_key(x_key)
        if ctx:
            return ctx
        if _looks_like_export_api_key(x_key):
            x_key_invalid_export = True

    bearer = (token or "").strip()
    if bearer and _looks_like_export_api_key(bearer):
        ctx = await _try_mongo_export_key(bearer)
        if ctx:
            return ctx
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )

    # Invalid syn_mcp_* in X-Api-Key: fall back to JWT only when Authorization has a session token.
    if x_key_invalid_export and not (bearer and not _looks_like_export_api_key(bearer)):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )

    user = await require_auth(token)
    return TenantContext(
        tenant_id=user.get("tenant_id", ""),
        user_id=user["_id"],
        role=user.get("role", "viewer"),
    )

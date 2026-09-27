"""
Auth middleware — FastAPI dependencies for authentication and authorization.

Usage in routes:
    from api.auth.middleware import require_auth, require_role, require_root

    @router.get("/protected", dependencies=[Depends(require_auth)])
    async def protected_endpoint(user: dict = Depends(require_auth)): ...

    @router.post("/admin-only", dependencies=[Depends(require_role("tenant_admin"))])
    async def admin_endpoint(user: dict = Depends(require_role("tenant_admin"))): ...
"""

import logging
from typing import Optional

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from api.auth.utils import decode_token
from api import deps

logger = logging.getLogger(__name__)

# OAuth2 scheme — extracts Bearer token from Authorization header
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

# Role hierarchy (higher index = more privileges)
ROLE_HIERARCHY = ["viewer", "developer", "tenant_admin", "root"]


def _role_level(role: str) -> int:
    """Get numeric level for a role. Unknown roles get -1."""
    try:
        return ROLE_HIERARCHY.index(role)
    except ValueError:
        return -1


async def require_auth(token: Optional[str] = Depends(oauth2_scheme)) -> dict:
    """
    Core auth dependency.

    1. Extract and decode JWT from Authorization header
    2. Load user from MongoDB by user_id (sub)
    3. Check user is enabled
    4. Return user dict (with _id, email, name, role, tenant_id)
    """
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Decode JWT
    try:
        payload = decode_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Validate token type
    if payload.get("type") != "access":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token type",
        )

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    # Load user from DB
    storage = deps.get_storage()
    user = await storage.get_user_by_id(user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )

    if not user.get("enabled", True):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account disabled",
        )

    return user


def require_role(required_role: str):
    """
    Factory: returns a dependency that checks role hierarchy.

    Usage: Depends(require_role("tenant_admin"))
    Hierarchy: root > tenant_admin > developer > viewer
    """
    required_level = _role_level(required_role)

    async def _check_role(user: dict = Depends(require_auth)) -> dict:
        user_role = user.get("role", "viewer")
        if _role_level(user_role) < required_level:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires role '{required_role}' or higher (you have '{user_role}')",
            )
        return user

    return _check_role


def require_root():
    """Shortcut for require_role('root')."""
    return require_role("root")

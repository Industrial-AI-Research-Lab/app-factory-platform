"""
Auth routes — login, token refresh, current user, user management.

Public:
    POST /api/auth/login
    POST /api/auth/refresh

Authenticated:
    GET  /api/auth/me

Admin (tenant_admin+):
    GET    /api/auth/users
    POST   /api/auth/users
    GET    /api/auth/users/{user_id}
    PUT    /api/auth/users/{user_id}
    DELETE /api/auth/users/{user_id}
    POST   /api/auth/users/{user_id}/reset-password
"""
import asyncio
import os
import random
import uuid
import logging
from datetime import datetime, timezone, timedelta
from urllib.request import Request

from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks

from api import deps
from api.auth.utils import (
    hash_password,
    verify_password,
    create_access_token,
    create_refresh_token,
    decode_token,
)
from api.auth.middleware import require_auth, require_role, _role_level
from api.auth.tenant_context import TenantContext, get_tenant_context
from schemas.auth_schemas import (
    ForgotPasswordRequest,
    LoginRequest,
    TokenResponse,
    RefreshRequest,
    ResetPasswordRequest,
    UserCreate,
    UserUpdate,
    UserResponse,
    PasswordResetRequest,
    MeResponse,
)

from api.auth.email_service import send_password_reset_email

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])


# ---------------------------------------------------------------------------
# Public endpoints
# ---------------------------------------------------------------------------

@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest):
    """Authenticate with email + password, receive JWT tokens."""
    storage = deps.get_storage()
    user = await storage.get_user_by_email(body.email)

    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    if not verify_password(body.password, user.get("password_hash", "")):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    if not user.get("enabled", True):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account disabled")

    # Update last_login
    user["last_login"] = datetime.now(timezone.utc).isoformat()
    await storage.save_user(user)

    access = create_access_token(str(user["_id"]), user.get("tenant_id", ""), user["role"])
    refresh = create_refresh_token(str(user["_id"]))

    logger.info("User %s logged in (role=%s, tenant=%s)", user["email"], user["role"], user.get("tenant_id"))
    return TokenResponse(access_token=access, refresh_token=refresh)


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(body: RefreshRequest):
    """Exchange a valid refresh token for a new access + refresh token pair."""
    import jwt as _jwt

    try:
        payload = decode_token(body.refresh_token)
    except _jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token expired")
    except _jwt.InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    if payload.get("type") != "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not a refresh token")

    user_id = payload.get("sub")
    storage = deps.get_storage()
    user = await storage.get_user_by_id(user_id)

    if not user or not user.get("enabled", True):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or disabled")

    user_id = str(user["_id"])
    access = create_access_token(user_id, user.get("tenant_id", ""), user["role"])
    refresh = create_refresh_token(user_id)
    return TokenResponse(access_token=access, refresh_token=refresh)


# ---------------------------------------------------------------------------
# Authenticated endpoints
# ---------------------------------------------------------------------------

@router.get("/me", response_model=MeResponse)
async def get_me(user: dict = Depends(require_auth)):
    """Return current user info from JWT."""
    return MeResponse(
        user_id=str(user["_id"]),
        email=user["email"],
        name=user["name"],
        role=user["role"],
        tenant_id=user.get("tenant_id"),
    )

# ---------------------------------------------------------------------------
# User management (tenant_admin+ only)
# ---------------------------------------------------------------------------

@router.get("/users", response_model=list[UserResponse])
async def list_users(user: dict = Depends(require_role("tenant_admin"))):
    """List users. tenant_admin sees own tenant; root sees all."""
    storage = deps.get_storage()
    if user["role"] == "root":
        users = await storage.get_users()
    else:
        users = await storage.get_users(tenant_id=user.get("tenant_id"))
    return [UserResponse.model_validate(u) for u in users]


@router.post("/users", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(body: UserCreate, user: dict = Depends(require_role("tenant_admin")), ctx: TenantContext = Depends(get_tenant_context)):
    """Create a new user."""
    storage = deps.get_storage()

    # Validate role assignment
    if body.role == "root" and user["role"] != "root":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only root can create root users")
    if body.role == "tenant_admin" and user["role"] != "root":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only root can create tenant_admin users")

    if _role_level(body.role) > _role_level(user["role"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Cannot create user with higher role than your own ({user['role']})",
        )

    # Check duplicate email
    existing = await storage.get_user_by_email(body.email)
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Email '{body.email}' already registered")

    # Determine tenant_id with explicit tenant-scope enforcement.
    requested_tenant_id = (body.tenant_id or "").strip() or None
    if user["role"] == "root":
        tenant_id = requested_tenant_id or (user.get("tenant_id") or "").strip() or None
        if not tenant_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Your account is not bound to a tenant",
            )
    else:
        actor_tenant_id = user.get("tenant_id")
        if not actor_tenant_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Your account is not bound to a tenant",
            )
        if requested_tenant_id and requested_tenant_id != actor_tenant_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Cannot create user in another tenant",
            )
        tenant_id = actor_tenant_id

    tenant = await storage.get_tenant(tenant_id)
    if not tenant:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tenant '{tenant_id}' not found",
        )

    doc = {
        "_id": str(uuid.uuid4()),
        "email": body.email,
        "name": body.name,
        "password_hash": hash_password(body.password),
        "role": body.role,
        "tenant_id": tenant_id,
        "enabled": body.enabled,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "last_login": None,
    }
    await storage.save_user(doc,  actor_id=ctx.user_id)
    logger.info("User created: %s (role=%s, tenant=%s) by %s", doc["email"], doc["role"], tenant_id, user["email"])
    return UserResponse.model_validate(doc)


@router.get("/users/{user_id}", response_model=UserResponse)
async def get_user(user_id: str, user: dict = Depends(require_role("tenant_admin"))):
    """Get a single user by ID."""
    storage = deps.get_storage()
    target = await storage.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    # Tenant scoping: tenant_admin can only see own tenant's users
    if user["role"] != "root" and target.get("tenant_id") != user.get("tenant_id"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    return UserResponse.model_validate(target)


@router.put("/users/{user_id}", response_model=UserResponse)
async def update_user(user_id: str, body: UserUpdate, user: dict = Depends(require_role("tenant_admin")), ctx: TenantContext = Depends(get_tenant_context)):
    """Update a user (partial)."""
    storage = deps.get_storage()
    target = await storage.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    # Tenant scoping
    if user["role"] != "root" and target.get("tenant_id") != user.get("tenant_id"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    # Prevent escalation
    if body.role and _role_level(body.role) > _role_level(user["role"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Cannot assign role higher than your own ({user['role']})",
        )

    # Only root can change tenant_id
    if body.tenant_id is not None and user["role"] != "root":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only root can change tenant assignment")
    if body.tenant_id is not None and user["role"] == "root":
        tenant = await storage.get_tenant(body.tenant_id)
        if not tenant:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Tenant '{body.tenant_id}' not found",
            )

    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No fields to update")

    target.update(updates)
    await storage.save_user(target, actor_id=ctx.user_id)
    logger.info("User updated: %s by %s", target["email"], user["email"])
    return UserResponse.model_validate(target)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(user_id: str, user: dict = Depends(require_role("tenant_admin"))):
    """Delete a user."""
    storage = deps.get_storage()
    target = await storage.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    # Cannot delete yourself
    if target["_id"] == user["_id"]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete yourself")

    # Tenant scoping
    if user["role"] != "root" and target.get("tenant_id") != user.get("tenant_id"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    # Cannot delete root if you're not root
    if target["role"] == "root" and user["role"] != "root":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot delete root user")

    deleted = await storage.delete_user(user_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    logger.info("User deleted: %s by %s", target["email"], user["email"])


@router.post("/users/{user_id}/reset-password", status_code=status.HTTP_200_OK)
async def reset_password(
    user_id: str,
    body: PasswordResetRequest,
    user: dict = Depends(require_role("tenant_admin")),
    ctx: TenantContext = Depends(get_tenant_context)
):
    """Reset a user's password (admin action)."""
    storage = deps.get_storage()
    target = await storage.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    # Tenant scoping
    if user["role"] != "root" and target.get("tenant_id") != user.get("tenant_id"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    target["password_hash"] = hash_password(body.new_password)
    await storage.save_user(target,  actor_id=ctx.user_id)
    logger.info("Password reset for %s by %s", target["email"], user["email"])
    return {"detail": "Password reset successfully"}


@router.post("/forgot-password", status_code=status.HTTP_200_OK)
async def forgot_password(
        body: ForgotPasswordRequest,
        background_tasks: BackgroundTasks,
):
    """Send password reset email with one-time token."""
    storage = deps.get_storage()
    recent_requests = await storage.get_recent_reset_requests(body.email, hours=1)
    if recent_requests >= 3:
        logger.warning(f"Rate limit exceeded for password reset: {body.email}")
        return {"message": "If your email exists, you will receive a reset link"}
    user = await storage.db.users.find_one({"email": body.email})
    if user:
        tenant_id = user.get("tenant_id", "default")
        token = await storage.save_reset_token(
            user_id=user["_id"],
            tenant_id=tenant_id,
            ttl_minutes=15
        )
        frontend_url = os.getenv("WEB_HOST", "http://localhost:5173")
        tenant_settings = await storage.get_tenant_settings(tenant_id)
        tenant_name = tenant_settings.get("name") if tenant_settings else None
        background_tasks.add_task(
            send_password_reset_email,
            to_email=body.email,
            frontend_url=frontend_url,
            reset_token=token,
            tenant_name=tenant_name,
            tenant_settings=tenant_settings,
        )
        logger.info(f"Password reset token generated for user: {body.email}, tenant: {tenant_id}")
    else:
        logger.warning(f"Password reset requested for non-existent email: {body.email}")
        await asyncio.sleep(random.uniform(0.001, 0.003))
    return {"message": "If your email exists, you will receive a reset link"}


@router.post("/reset-password", status_code=status.HTTP_200_OK)
async def reset_password_with_token(body: ResetPasswordRequest):
    """Reset password using one-time token from email."""
    storage = deps.get_storage()
    token_data = await storage.get_reset_token(body.token)
    if not token_data:
        logger.warning(f"Invalid or expired reset token used: {body.token[:8]}...")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset token"
        )
    if token_data["expires_at"] <= datetime.utcnow():
        await storage.delete_reset_token(body.token)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Reset token has expired"
        )
    user = await storage.get_user_by_id(token_data["user_id"])
    if not user:
        logger.error(f"User not found for valid token: {token_data['user_id']}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid reset token"
        )
    if not user.get("enabled", True):
        logger.warning(f"Disabled user attempted password reset: {user['email']}")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is disabled. Contact administrator."
        )
    hashed_password = hash_password(body.new_password)
    await storage.db.users.update_one(
        {"_id": token_data["user_id"]},
        {"$set": {
            "password_hash": hashed_password,
            "updated_at": datetime.utcnow().isoformat()
        }}
    )
    await storage.delete_reset_token(body.token)
    logger.info(f"Password reset successful for user: {user['email']}")
    return {"message": "Password reset successful. You can now login with your new password."}

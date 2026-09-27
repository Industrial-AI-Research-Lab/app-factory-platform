import logging
from typing import List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status, Path, Query
from fastapi.responses import StreamingResponse
from pymongo.errors import DuplicateKeyError
import json

from api import deps
from api.auth.middleware import require_role
from api.auth.tenant_context import TenantContext, get_tenant_context
from schemas.configuration_schemas import (
    A2AServerConfigurationCreate,
    A2AServerConfigurationUpdate,
    A2AServerConfigurationResponse,
    A2AValidateResponse,
    A2AAgentCardSummary,
    A2APreviewRequest,
    A2APreviewResponse,
    AUTH_SECRET_FIELDS,
)
from api.services.a2a_configuration_service import (
    A2AConfigurationService,
    _reject_stream_longrunning_conflict,
)
from integrations.a2a_client import A2AClientFactory

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/configurations/a2a", tags=["a2a configurations"])


def get_a2a_service() -> A2AConfigurationService:
    """Dependency injection for A2A service."""
    storage = deps.get_storage()
    return A2AConfigurationService(storage)


def _mask_token(raw: object) -> str:
    """Mask a stored secret for responses (same policy as tenant settings)."""
    value = str(raw)
    return value[:4] + "***" + value[-4:] if len(value) > 8 else "***"


def _mask_server_auth(server: Dict[str, Any]) -> Dict[str, Any]:
    """Copy of a server doc with any directly-stored auth secrets masked.

    Returns a shallow copy (never mutates the stored/cached doc).
    """
    auth = server.get("auth")
    if not isinstance(auth, dict) or not any(auth.get(f) for f in AUTH_SECRET_FIELDS):
        return server
    masked = dict(auth)
    for f in AUTH_SECRET_FIELDS:
        if masked.get(f):
            masked[f] = _mask_token(masked[f])
    return {**server, "auth": masked}


@router.get("/", response_model=List[A2AServerConfigurationResponse])
async def list_a2a_servers(
    include_disabled: bool = Query(True, description="Include disabled servers"),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    ctx: TenantContext = Depends(get_tenant_context),
    _: dict = Depends(require_role("tenant_admin")),
):
    """List all A2A servers for the current tenant."""
    storage = deps.get_storage()
    servers = await storage.get_a2a_servers(
        ctx.tenant_id, skip, limit, include_disabled
    )
    response_servers = []
    for server in servers:
        if "cached_agent_card" in server:
            del server["cached_agent_card"]
        response_servers.append(_mask_server_auth(server))

    logger.info(
        "Listed %d A2A servers for tenant %s",
        len(response_servers),
        ctx.tenant_id
    )
    return response_servers


@router.get("/{server_id}", response_model=A2AServerConfigurationResponse)
async def get_a2a_server(
    server_id: str = Path(..., description="A2A server ID"),
    include_card: bool = Query(False),
    ctx: TenantContext = Depends(get_tenant_context),
    _: dict = Depends(require_role("tenant_admin")),
):
    """Get a single A2A server configuration."""
    storage = deps.get_storage()
    server = await storage.get_a2a_server(server_id, ctx.tenant_id)

    if not server:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"A2A server with id {server_id} not found"
        )

    if not include_card and "cached_agent_card" in server:
        del server["cached_agent_card"]

    return _mask_server_auth(server)


@router.post("/preview", response_model=A2APreviewResponse)
async def preview_a2a_server(
    req: A2APreviewRequest,
    ctx: TenantContext = Depends(get_tenant_context),
    service: A2AConfigurationService = Depends(get_a2a_service),
    _: dict = Depends(require_role("tenant_admin")),
):
    """Fetch + validate an agent card without saving; returns a card summary and
    suggested field values for the Add/Edit form's Discover button. Errors surface
    the same rich detail as create (unreachable host, 404 card, bad schema, …)."""
    result = await service.preview_agent_card(
        req.endpoint_url, req.auth, req.agent_card_url, req.request_timeout_seconds
    )
    logger.info(
        "Previewed A2A card from %s for tenant %s",
        result.get("discovered_card_url"),
        ctx.tenant_id,
    )
    return result


@router.post("/", response_model=A2AServerConfigurationResponse, status_code=status.HTTP_201_CREATED)
async def create_a2a_server(
    config: A2AServerConfigurationCreate,
    ctx: TenantContext = Depends(get_tenant_context),
    service: A2AConfigurationService = Depends(get_a2a_service),
    _: dict = Depends(require_role("tenant_admin")),
):
    """Create a new A2A server configuration."""
    created = await service.create_with_validation(ctx.tenant_id, config)

    if "cached_agent_card" in created:
        del created["cached_agent_card"]

    logger.info(
        "Created A2A server '%s' (id=%s) for tenant %s",
        config.name,
        created["_id"],
        ctx.tenant_id
    )
    return _mask_server_auth(created)


@router.put("/{server_id}", response_model=A2AServerConfigurationResponse)
async def update_a2a_server(
    server_id: str,
    update_data: A2AServerConfigurationUpdate,
    ctx: TenantContext = Depends(get_tenant_context),
    service: A2AConfigurationService = Depends(get_a2a_service),
    _: dict = Depends(require_role("tenant_admin")),
):
    """Update an existing A2A server configuration."""
    storage = deps.get_storage()

    existing = await storage.get_a2a_server(server_id, ctx.tenant_id)
    if not existing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"A2A server with id {server_id} not found"
        )
    update_dict = update_data.model_dump(exclude_unset=True, mode="json")

    # The edit form only ever receives the masked token, so a token still containing
    # "***" means "keep the current secret" — restore the real stored value rather
    # than overwriting it with the mask. Done before the sensitive-field diff so an
    # unchanged token doesn't needlessly invalidate the cached agent card.
    auth_in = update_dict.get("auth")
    if isinstance(auth_in, dict):
        existing_auth = existing.get("auth") or {}
        for f in AUTH_SECRET_FIELDS:
            if isinstance(auth_in.get(f), str) and "***" in auth_in[f]:
                auth_in[f] = existing_auth.get(f)

    if "name" in update_dict and update_dict["name"] != existing["name"]:
        name_exists = await storage.get_a2a_server_by_name(
            update_dict["name"], ctx.tenant_id
        )
        if name_exists:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A2A server with name '{update_dict['name']}' already exists"
            )

    sensitive_fields_changed = False
    sensitive_fields = [
        "endpoint_url",
        "agent_card_url",
        "auth",
        "rpc_endpoint",
        "request_timeout_seconds",
    ]

    for field in sensitive_fields:
        if field in update_dict and update_dict[field] != existing.get(field):
            sensitive_fields_changed = True
            logger.info(
                f"Field '{field}' changed for server '{server_id}', "
                "will validate the candidate configuration"
            )
            break

    if sensitive_fields_changed:
        cache_fields = await service.validate_update_candidate(existing, update_dict)
        update_dict.update(cache_fields)
        logger.info(
            "[A2A_CONTRACT] server_id=%s — candidate configuration validated",
            server_id,
        )

    # Reject the mutually exclusive pair on the merged (existing +
    # update) state, so turning on one mode while the other is already set is a 422
    # rather than a silently ignored flag.
    effective_long_running = update_dict.get(
        "long_running", existing.get("long_running", False)
    )
    effective_use_a2a_streaming = update_dict.get(
        "use_a2a_streaming", existing.get("use_a2a_streaming", False)
    )
    _reject_stream_longrunning_conflict(
        effective_long_running, effective_use_a2a_streaming
    )

    update_kwargs = {}
    if existing.get("updated_at") is not None:
        update_kwargs["expected_updated_at"] = existing["updated_at"]
    try:
        updated = await storage.update_a2a_server(
            server_id, ctx.tenant_id, update_dict, **update_kwargs
        )
    except DuplicateKeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A2A server with name '{update_dict.get('name')}' already exists",
        ) from exc

    if not updated:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A2A server {server_id} changed concurrently; reload and retry",
        )

    try:
        await A2AClientFactory.invalidate_sdk_client(storage, server_id, ctx.tenant_id)
        logger.info(f"Invalidated A2A client cache for {ctx.tenant_id}:{server_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate client cache: {e}")
    if "cached_agent_card" in updated:
        del updated["cached_agent_card"]

    logger.info(
        "Updated A2A server '%s' (id=%s) for tenant %s",
        updated["name"],
        server_id,
        ctx.tenant_id
    )
    return _mask_server_auth(updated)


@router.delete("/{server_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_a2a_server(
    server_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
    _: dict = Depends(require_role("tenant_admin")),
):
    """Delete an A2A server configuration."""
    storage = deps.get_storage()
    try:
        await A2AClientFactory.invalidate_sdk_client(storage, server_id, ctx.tenant_id)
        logger.info(f"Invalidated A2A client cache for {ctx.tenant_id}:{server_id}")
    except Exception as e:
        logger.warning(f"Failed to invalidate client cache: {e}")
    deleted = await storage.delete_a2a_server(server_id, ctx.tenant_id)

    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"A2A server with id {server_id} not found"
        )


@router.post("/{server_id}/validate", response_model=A2AValidateResponse)
async def validate_a2a_server(
    server_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
    service: A2AConfigurationService = Depends(get_a2a_service),
    _: dict = Depends(require_role("tenant_admin")),
):
    """Re-fetch and validate agent card for an existing server."""
    updated = await service.validate_existing(server_id, ctx.tenant_id)

    card_summary = updated.get("cached_agent_card_summary", {})
    skills_count = len(card_summary.get("skills", []))
    default_output_modes = card_summary.get("defaultOutputModes", [])

    agent_card_summary = A2AAgentCardSummary(
        name=card_summary.get("name", ""),
        version=card_summary.get("version", ""),
        url=card_summary.get("url", ""),
        defaultInputModes=card_summary.get("defaultInputModes", []),
        defaultOutputModes=default_output_modes,
        skills=card_summary.get("skills", []),
        capabilities=card_summary.get("capabilities", {})
    )

    logger.info(
        "Validated A2A server '%s' (id=%s) for tenant %s - found %d skills",
        updated["name"],
        server_id,
        ctx.tenant_id,
        skills_count
    )

    return A2AValidateResponse(
        id=server_id,
        name=updated["name"],
        validated_at=updated["last_validated_at"],
        skills_count=skills_count,
        default_output_modes=default_output_modes,
        agent_card_summary=agent_card_summary
    )


@router.get("/{server_id}/skills", response_model=dict)
async def get_server_skills(
    server_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
    _: dict = Depends(require_role("tenant_admin")),
):
    """Get available skills for an A2A server from cached agent card."""
    storage = deps.get_storage()
    server = await storage.get_a2a_server(server_id, ctx.tenant_id)

    if not server:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"A2A server with id {server_id} not found"
        )

    if not server.get("cached_agent_card"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Server '{server_id}' has no cached agent card. Please validate first."
        )

    agent_card = server["cached_agent_card"]
    skills = agent_card.get("skills", [])

    return {
        "server_id": server_id,
        "server_name": server.get("name"),
        "skills": [
            {
                "id": skill.get("id"),
                "name": skill.get("name"),
                "tags": skill.get("tags", [])
            }
            for skill in skills
        ],
        "default_input_modes": agent_card.get("defaultInputModes", []),
        "default_output_modes": agent_card.get("defaultOutputModes", []),
        "cached_at": server.get("cached_at")
    }

@router.post("/{server_id}/send-message")
async def send_a2a_message(
    server_id: str,
    request: Dict[str, Any],
    ctx: TenantContext = Depends(get_tenant_context),
    _: dict = Depends(require_role("tenant_admin")),
):
    """Send a message to an A2A server and stream response."""
    storage = deps.get_storage()
    client = A2AClientFactory.get_client(storage)

    message = request.get("message")
    context_id = request.get("context_id")
    task_id = request.get("task_id")
    metadata = request.get("metadata")
    skill_id = request.get("skill_id")

    if not message:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Message is required"
        )

    async def generate():
        try:
            async for response in client.send_message(
                    server_id=server_id,
                    tenant_id=ctx.tenant_id,
                    message=message,
                    context_id=context_id,
                    task_id=task_id,
                    metadata=metadata,
                    skill_id=skill_id,
            ):
                yield json.dumps(response) + "\n"
        except Exception as e:
            logger.error(f"Error sending message: {e}")
            yield json.dumps({"error": str(e)}) + "\n"

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson"
    )


@router.get("/{server_id}/tasks/{task_id}")
async def get_a2a_task(
    server_id: str,
    task_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
    _: dict = Depends(require_role("tenant_admin")),
):
    """Get task status from A2A server."""
    storage = deps.get_storage()
    client = A2AClientFactory.get_client(storage)

    try:
        task = await client.tasks_get(
            server_id=server_id,
            tenant_id=ctx.tenant_id,
            task_id=task_id
        )
        return task
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get task: {str(e)}"
        )


@router.post("/{server_id}/tasks/{task_id}/cancel")
async def cancel_a2a_task(
    server_id: str,
    task_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
    _: dict = Depends(require_role("tenant_admin")),
):
    """Cancel a running task on A2A server."""
    storage = deps.get_storage()
    client = A2AClientFactory.get_client(storage)

    try:
        task = await client.tasks_cancel(
            server_id=server_id,
            tenant_id=ctx.tenant_id,
            task_id=task_id
        )
        return task
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to cancel task: {str(e)}"
        )


@router.post("/{server_id}/refresh-cache")
async def refresh_agent_card_cache(
    server_id: str,
    ctx: TenantContext = Depends(get_tenant_context),
    service: A2AConfigurationService = Depends(get_a2a_service),
    _: dict = Depends(require_role("tenant_admin")),
):
    """Force refresh agent card cache."""
    updated = await service.validate_existing(server_id, ctx.tenant_id)

    return {
        "server_id": server_id,
        "name": updated.get("name"),
        "validated_at": updated.get("last_validated_at"),
        "skills_count": len(updated.get("cached_agent_card_summary", {}).get("skills", []))
    }

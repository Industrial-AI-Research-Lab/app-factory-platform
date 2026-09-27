import json
import logging
from typing import Awaitable, Callable, Dict, Any, Optional, Tuple
from datetime import datetime
from urllib.parse import urlparse
import httpx
from fastapi import HTTPException, status
from pymongo.errors import DuplicateKeyError

from schemas.configuration_schemas import (
    A2AServerConfigurationCreate,
    A2AAuthConfig,
)
from integrations.a2a_auth import (
    build_auth,
    build_oauth2_provider,
    validate_auth_env_vars,
    OAuth2TokenError,
)
from integrations.a2a_contracts import (
    A2AContractError,
    A2AContractSnapshot,
    url_origin,
    validate_agent_card,
)

logger = logging.getLogger(__name__)


def _card_declares_streaming(agent_card: Dict[str, Any]) -> bool:
    """Whether an agent card advertises SSE streaming (capabilities.streaming)."""
    return bool((agent_card.get("capabilities") or {}).get("streaming"))


def _resolve_use_a2a_streaming(
    explicit: bool | None, agent_card: Dict[str, Any], long_running: bool
) -> bool:
    """Effective streaming flag for a server: an explicit operator choice wins;
    otherwise derive from the card, forced off for long_running servers (which
    submit-and-poll and never open a stream)."""
    if explicit is not None:
        return bool(explicit)
    return _card_declares_streaming(agent_card) and not long_running


def _reject_stream_longrunning_conflict(
    long_running: bool, use_a2a_streaming: bool
) -> None:
    """long_running submits once and polls tasks/get
    (message/send) and never reaches the streaming path, so enabling both is a
    silent no-op that misleads the operator."""
    if long_running and use_a2a_streaming:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "use_a2a_streaming and long_running are mutually exclusive: a "
                "long_running server submits once and polls tasks/get (message/send) "
                "and never opens a stream. Disable one."
            ),
        )


class A2AConfigurationService:
    """Business logic for A2A server configuration management."""

    def __init__(self, storage):
        self.storage = storage

    async def fetch_agent_card(
            self,
            endpoint_url: str,
            auth_config: A2AAuthConfig,
            agent_card_url: Optional[str] = None,
            timeout_seconds: int = 30,
            on_refresh_token: Optional[Callable[[str], Awaitable[None]]] = None,
    ) -> Tuple[Dict[str, Any], int]:
        """Fetch agent card from A2A server.

        ``on_refresh_token`` (when the caller has a server to persist to) is invoked with a
        rotated OAuth2 refresh token so an admin fetch doesn't silently burn it; omit it for
        stateless discovery/preview where there is nothing to save to.
        """
        if agent_card_url:
            card_url = agent_card_url
        else:
            base_url = endpoint_url.rstrip('/')
            card_url = f"{base_url}/.well-known/agent-card.json"

        # Every auth type becomes an httpx.Auth attached via auth= (see a2a_auth.build_auth);
        # a fresh OAuth2 provider per fetch is fine — admin validate/preview is infrequent.
        # A provider_factory carrying on_refresh_token lets a rotated refresh token be saved.
        try:
            if on_refresh_token is not None:
                auth_obj = build_auth(
                    auth_config,
                    provider_factory=lambda: build_oauth2_provider(
                        auth_config, on_refresh_token=on_refresh_token
                    ),
                )
            else:
                auth_obj = build_auth(auth_config)
        except ValueError as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

        try:
            async with httpx.AsyncClient(timeout=timeout_seconds, auth=auth_obj) as client:
                response = await client.get(card_url)

                if response.status_code != 200:
                    if response.status_code == 401:
                        # The AGENT rejected our configured credentials. Report as 502
                        # (upstream failure), NOT 401 — the UI reserves 401 for the caller's
                        # own expired session and force-logs-out on it (utils_api apiFetch).
                        error_msg = "Agent rejected the configured credentials (HTTP 401)"
                        status_code = status.HTTP_502_BAD_GATEWAY
                    elif response.status_code == 403:
                        error_msg = "Access forbidden (403 Forbidden)"
                        status_code = status.HTTP_403_FORBIDDEN
                    elif response.status_code == 404:
                        error_msg = "Agent card not found at /.well-known/agent-card.json"
                        status_code = status.HTTP_404_NOT_FOUND
                    else:
                        error_msg = f"Agent card fetch failed: HTTP {response.status_code}"
                        status_code = status.HTTP_502_BAD_GATEWAY

                    raise HTTPException(
                        status_code=status_code,
                        detail=error_msg
                    )

                try:
                    card_data = response.json()
                except json.JSONDecodeError as e:
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,  # 502, т.к. проблема на стороне агента
                        detail=f"Invalid JSON in agent card: {str(e)}"
                    )

                self._validate_agent_card_schema(card_data)

                return card_data, response.status_code

        except HTTPException:
            raise

        except OAuth2TokenError as e:
            # Minting the upstream token (e.g. Keycloak) failed — an agent-side/gateway
            # problem, not the caller's AppFactory session. Must NOT be 401: the UI treats a
            # 401 as its own session expiry and logs the admin out (utils_api apiFetch).
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"OAuth2 token acquisition failed: {e}"
            )

        except httpx.TimeoutException:
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail=f"Timeout fetching agent card after {timeout_seconds} seconds"
            )
        except httpx.ConnectError:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Cannot connect to {card_url}. Check endpoint URL and network connectivity."
            )
        except httpx.HTTPStatusError as e:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"HTTP error {e.response.status_code}: {e.response.text[:200]}"
            )
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Unexpected error fetching agent card: {str(e)}"
            )

    def _validate_agent_card_schema(
        self, card_data: Dict[str, Any]
    ) -> A2AContractSnapshot:
        """Validate the raw card against its versioned contract."""
        try:
            return validate_agent_card(card_data)
        except A2AContractError as exc:
            logger.warning(
                "[A2A_CONTRACT] error_type=%s location=%s — Agent Card rejected: %s",
                exc.error_type,
                exc.location,
                exc,
            )
            raise HTTPException(
                # Starlette 0.45+ renamed ENTITY→CONTENT; keep ENTITY for older pins.
                status_code=getattr(
                    status,
                    "HTTP_422_UNPROCESSABLE_CONTENT",
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                ),
                detail=exc.as_dict(),
            ) from exc

    def _validate_env_vars(self, auth_config: A2AAuthConfig) -> None:
        """Validate that required environment variables exist (HTTP 400 on miss).

        Delegates to the shared validator so A2A and external MCP reject the same
        misconfigurations identically; here it maps ValueError to the API's 400.
        """
        try:
            validate_auth_env_vars(auth_config)
        except ValueError as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    _origin = staticmethod(url_origin)

    async def preview_agent_card(
            self,
            endpoint_url,
            auth: A2AAuthConfig,
            agent_card_url=None,
            timeout_seconds: int = 30
    ) -> Dict[str, Any]:
        """Fetch + validate an agent card WITHOUT persisting, and derive suggested
        form values for the Discover button.

        Discovery resolves the well-known path against the ORIGIN (the A2A spec makes
        it origin-relative), so this still succeeds when the caller pasted a full RPC
        path into endpoint_url — and the returned `suggested.endpoint_url` then corrects
        it to the origin so the subsequent save works.
        """
        self._validate_env_vars(auth)

        if agent_card_url:
            fetch_url = str(agent_card_url)
        else:
            parsed = urlparse(str(endpoint_url))
            origin = f"{parsed.scheme}://{parsed.netloc}"
            fetch_url = f"{origin}/.well-known/agent-card.json"

        agent_card, _ = await self.fetch_agent_card(
            endpoint_url, auth, fetch_url, timeout_seconds
        )
        summary = self.storage.build_a2a_card_summary(agent_card)

        # The card's own service url is authoritative for where RPC calls must go.
        card_url = summary.get("url") or ""
        parsed_card = urlparse(card_url)
        suggested_endpoint = self._origin(parsed_card) or None
        suggested_rpc = parsed_card.path or "/"

        # Suggest an explicit card URL only when saving with the default route would
        # MISS the card: the card's advertised RPC origin (which becomes the saved
        # endpoint_url) differs from where we actually discovered the card. Otherwise
        # leave it empty so the default {origin}/.well-known/... route is used.
        suggested_card_url = None
        if agent_card_url:
            suggested_card_url = str(agent_card_url)
        elif suggested_endpoint and suggested_endpoint != self._origin(urlparse(fetch_url)):
            suggested_card_url = fetch_url

        return {
            "agent_card_summary": summary,
            "suggested": {
                "name": summary.get("name"),
                "endpoint_url": suggested_endpoint,
                "rpc_endpoint": suggested_rpc,
                "agent_card_url": suggested_card_url,
            },
            "discovered_card_url": fetch_url,
            "protocol_version": agent_card.get("protocolVersion"),
            "preferred_transport": agent_card.get("preferredTransport"),
        }

    async def create_with_validation(
            self,
            tenant_id: str,
            config_data: A2AServerConfigurationCreate
    ) -> Dict[str, Any]:
        """Create new A2A server configuration after validating agent card."""
        self._validate_env_vars(config_data.auth)

        existing = await self.storage.get_a2a_server_by_name(config_data.name, tenant_id)
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A2A server with name '{config_data.name}' already exists in this tenant"
            )

        # Capture (not persist — no server exists yet) a refresh token the IdP may rotate
        # during validation, so the created doc stores the live one instead of a spent one.
        rotated_refresh: Dict[str, str] = {}

        async def _capture_rotated(new_rt: str) -> None:
            rotated_refresh["refresh_token"] = new_rt

        agent_card, _ = await self.fetch_agent_card(
            str(config_data.endpoint_url),
            config_data.auth,
            str(config_data.agent_card_url) if config_data.agent_card_url else None,
            config_data.request_timeout_seconds,
            on_refresh_token=_capture_rotated,
        )
        contract = self._validate_agent_card_schema(agent_card)

        use_a2a_streaming = _resolve_use_a2a_streaming(
            config_data.use_a2a_streaming, agent_card, config_data.long_running
        )
        _reject_stream_longrunning_conflict(
            config_data.long_running, use_a2a_streaming
        )

        auth_dict = config_data.auth.model_dump()
        if rotated_refresh.get("refresh_token"):
            auth_dict["refresh_token"] = rotated_refresh["refresh_token"]

        server_doc = {
            "name": config_data.name,
            "endpoint_url": str(config_data.endpoint_url),
            "agent_card_url": str(config_data.agent_card_url) if config_data.agent_card_url else None,
            "rpc_endpoint": config_data.rpc_endpoint,
            "auth": auth_dict,
            "request_timeout_seconds": config_data.request_timeout_seconds,
            "enabled": config_data.enabled,
            "long_running": config_data.long_running,
            "poll_interval_seconds": config_data.poll_interval_seconds,
            "use_a2a_streaming": use_a2a_streaming,
            "checkpoints": config_data.checkpoints.model_dump(mode="json"),
            "cached_agent_card": agent_card,
            "cached_agent_card_summary": self.storage.build_a2a_card_summary(agent_card),
            "a2a_contract": contract.as_dict(),
            "cached_at": datetime.utcnow(),
            "last_validated_at": datetime.utcnow()
        }

        # The (tenant_id, name) unique index is the real guard; the get-by-name check
        # above can lose a concurrent-create race, so map the index violation to 409
        # instead of letting the raw E11000 surface as a 500.
        try:
            created = await self.storage.create_a2a_server(tenant_id, server_doc)
        except DuplicateKeyError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A2A server with name '{config_data.name}' already exists in this tenant"
            )
        return created

    async def validate_existing(
            self,
            server_id: str,
            tenant_id: str
    ) -> Dict[str, Any]:
        """Re-fetch and update agent card for existing server."""
        server = await self.storage.get_a2a_server(server_id, tenant_id)
        if not server:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"A2A server with id {server_id} not found"
            )

        auth_config = A2AAuthConfig(**server["auth"])

        self._validate_env_vars(auth_config)

        rotated_refresh: Dict[str, str] = {}

        async def _capture_rotated(new_token: str) -> None:
            rotated_refresh["refresh_token"] = new_token

        agent_card, _ = await self.fetch_agent_card(
            server["endpoint_url"],
            auth_config,
            server.get("agent_card_url"),
            server.get("request_timeout_seconds", 60),
            on_refresh_token=_capture_rotated,
        )
        contract = self._validate_agent_card_schema(agent_card)

        # Manual re-discovery resyncs the streaming flag with the fresh card,
        # deliberately overwriting an operator override — unlike the background /
        # endpoint-change refetch path, which leaves the flag untouched.
        use_a2a_streaming = _card_declares_streaming(agent_card) and not bool(
            server.get("long_running", False)
        )

        validated_at = datetime.utcnow()
        cache_kwargs = {
            "contract": contract.as_dict(),
            "use_a2a_streaming": use_a2a_streaming,
        }
        if server.get("updated_at") is not None:
            cache_kwargs["expected_updated_at"] = server["updated_at"]
        if rotated_refresh.get("refresh_token"):
            cache_kwargs["refresh_token"] = rotated_refresh["refresh_token"]
        updated = await self.storage.update_a2a_server_cache(
            server_id, tenant_id, agent_card, validated_at, **cache_kwargs
        )

        if not updated:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"A2A server {server_id} changed during validation; "
                    "retry against the current configuration"
                ),
            )

        return updated

    async def validate_update_candidate(
        self,
        existing: Dict[str, Any],
        update: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Validate a merged connection configuration without persisting it."""
        candidate = {**existing, **update}
        auth_data = candidate.get("auth") or {}
        auth_config = A2AAuthConfig(**auth_data)
        self._validate_env_vars(auth_config)

        rotated_refresh: Dict[str, str] = {}

        async def _capture_rotated(new_token: str) -> None:
            rotated_refresh["refresh_token"] = new_token

        agent_card, _ = await self.fetch_agent_card(
            str(candidate["endpoint_url"]),
            auth_config,
            str(candidate["agent_card_url"])
            if candidate.get("agent_card_url")
            else None,
            candidate.get("request_timeout_seconds", 60),
            on_refresh_token=_capture_rotated,
        )
        contract = self._validate_agent_card_schema(agent_card)
        validated_at = datetime.utcnow()
        cache_fields = {
            "cached_agent_card": agent_card,
            "cached_agent_card_summary": self.storage.build_a2a_card_summary(agent_card),
            "a2a_contract": contract.as_dict(),
            "cached_at": validated_at,
            "last_validated_at": validated_at,
        }
        if rotated_refresh.get("refresh_token"):
            updated_auth = dict(auth_data)
            updated_auth["refresh_token"] = rotated_refresh["refresh_token"]
            cache_fields["auth"] = updated_auth
        return cache_fields

    async def get_server_summary(self, server_id: str, tenant_id: str) -> Dict[str, Any]:
        """Get server with summary of cached agent card (without full card)."""
        server = await self.storage.get_a2a_server(server_id, tenant_id)
        if not server:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"A2A server with id {server_id} not found"
            )

        if "cached_agent_card" in server:
            del server["cached_agent_card"]

        return server

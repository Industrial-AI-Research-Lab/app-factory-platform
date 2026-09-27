"""PluginHost: per-agent-execution hook dispatch with error isolation.

The host knows which plugins are active for this execution and dispatches the
six hook points to them in registration order. A failing plugin never fails
the execution — it produces a ``plugin.error`` event and dispatch continues.
That includes a spurious CancelledError leaking out of a torn-down connection
inside a hook; only genuine run cancellation re-raises. Config resolves ONCE
here (at build time), never per hook call.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional, Tuple

from schemas.event_schema import EventSchema

from .config_chain import plugin_enabled, resolve_plugin_config
from .contract import (
    HOOK_CONTEXT_RENDER,
    HOOK_METHODS,
    HOOK_OVERFLOW,
    HOOK_POST_TURN,
    HOOK_PRE_FLIGHT,
    HOOK_PRE_SEND,
    HOOK_TOOL_RESULT,
    Plugin,
    PluginRunContext,
)
from .registry import PLUGIN_REGISTRY
from .services import PluginServices

logger = logging.getLogger(__name__)


class PluginHost:
    def __init__(
        self,
        entries: List[Tuple[Plugin, PluginServices]],
        *,
        run_context: PluginRunContext,
        event_emitter=None,
        cancellation_token=None,
    ):
        self._entries = list(entries)
        self._run_context = run_context
        self._event_emitter = event_emitter
        self._cancellation_token = cancellation_token
        self._subscribers: Dict[str, List[Tuple[Plugin, PluginServices]]] = {}
        for hook in HOOK_METHODS:
            self._subscribers[hook] = [
                (plugin, services)
                for plugin, services in self._entries
                if hook in type(plugin).subscribed_hooks()
            ]

    def _is_cancelled(self) -> bool:
        # Same authority as StreamingAgentRunner._is_cancelled: token set OR a
        # real Task-level cancel in flight (run_timeout_seconds cancels the node
        # via asyncio.wait_for without setting the token). A spurious scope-leak
        # cancel reads False so the hook isolation below still contains it.
        # Imported lazily: orchestration/__init__ is heavy and cycles back here.
        from orchestration.cancellation import is_genuinely_cancelled
        return is_genuinely_cancelled(self._cancellation_token)

    async def _report_plugin_error(self, plugin: Plugin, hook: str, exc: BaseException) -> None:
        ctx = self._run_context
        logger.warning(
            "[PLUGIN] %s failed at %s (agent=%s run=%s): %s",
            plugin.name,
            hook,
            ctx.agent_id,
            ctx.run_id,
            exc,
        )
        if self._event_emitter is None:
            return
        try:
            await self._event_emitter.emit(
                EventSchema.PLUGIN_ERROR,
                ctx.run_id,
                {
                    "plugin": plugin.name,
                    "hook": hook,
                    "error": str(exc),
                    "project_id": ctx.project_id,
                    "agent_id": ctx.agent_id,
                    "task_id": ctx.task_id,
                },
            )
        except asyncio.CancelledError as emit_exc:
            # Without this guard a spurious cancel from the emitter would
            # escape the very handler that just contained one from the hook.
            if self._is_cancelled():
                raise
            logger.warning("[PLUGIN] plugin.error emit failed: %s", emit_exc)
        except Exception as emit_exc:
            logger.warning("[PLUGIN] plugin.error emit failed: %s", emit_exc)

    async def _dispatch(
        self,
        hook: str,
        kwargs: Dict[str, Any],
        *,
        transform_key: Optional[str] = None,
        transform_type: Optional[type] = None,
    ) -> Tuple[Any, bool]:
        """Run every subscriber; chain valid replacements into ``kwargs``.

        Returns (final value of the transform key, whether any plugin changed
        it). A replacement of the wrong type counts as a plugin error — the
        runner must never receive a corrupted payload.
        """
        changed = False
        for plugin, services in self._subscribers[hook]:
            method = getattr(plugin, HOOK_METHODS[hook])
            try:
                replacement = await method(services, **kwargs)
            except asyncio.CancelledError as exc:
                # A library can raise this without the run being cancelled — a
                # failed connection unwinds its cancel scope on the wrong task
                # (the runner guards its tool handlers the same way). It is not
                # an Exception, so the net below misses it; the tool_result
                # hook runs inside an open ledger call/result pair, and letting
                # it escape would strand the call as hanging and make resume
                # drop the completed tool.
                if self._is_cancelled():
                    raise
                await self._report_plugin_error(plugin, hook, exc)
                continue
            except Exception as exc:
                await self._report_plugin_error(plugin, hook, exc)
                continue
            if transform_key is None or replacement is None:
                continue
            if transform_type is not None and not isinstance(replacement, transform_type):
                await self._report_plugin_error(
                    plugin,
                    hook,
                    TypeError(
                        f"replacement must be {transform_type.__name__}, "
                        f"got {type(replacement).__name__}"
                    ),
                )
                continue
            kwargs[transform_key] = replacement
            changed = True
        return (kwargs.get(transform_key) if transform_key else None), changed

    async def dispatch_pre_flight(
        self, *, tools: List[Dict[str, Any]], system_prompt: Optional[str]
    ) -> None:
        await self._dispatch(
            HOOK_PRE_FLIGHT, {"tools": tools, "system_prompt": system_prompt}
        )

    async def dispatch_context_render(self, rendered: str) -> str:
        out, _ = await self._dispatch(
            HOOK_CONTEXT_RENDER,
            {"rendered": rendered},
            transform_key="rendered",
            transform_type=str,
        )
        return out

    async def dispatch_tool_result(
        self,
        *,
        name: str,
        arguments: str,
        call_id: Optional[str],
        result: Dict[str, Any],
    ) -> Dict[str, Any]:
        out, _ = await self._dispatch(
            HOOK_TOOL_RESULT,
            {"name": name, "arguments": arguments, "call_id": call_id, "result": result},
            transform_key="result",
            transform_type=dict,
        )
        return out

    async def dispatch_pre_send(
        self, input_items: List[Dict[str, Any]], *, turn: int
    ) -> List[Dict[str, Any]]:
        out, _ = await self._dispatch(
            HOOK_PRE_SEND,
            {"input_items": input_items, "turn": turn},
            transform_key="input_items",
            transform_type=list,
        )
        return out

    async def dispatch_post_turn(
        self,
        *,
        turn: int,
        usage: Optional[Dict[str, Any]],
        stop_reason: Optional[str],
    ) -> None:
        await self._dispatch(
            HOOK_POST_TURN,
            {"turn": turn, "usage": usage, "stop_reason": stop_reason},
        )

    async def dispatch_overflow(
        self,
        *,
        error: BaseException,
        input_items: List[Dict[str, Any]],
        turn: int,
    ) -> Optional[List[Dict[str, Any]]]:
        """Returns transformed items when some plugin proposed a recovery,
        else None (caller re-raises the overflow)."""
        out, changed = await self._dispatch(
            HOOK_OVERFLOW,
            {"error": error, "input_items": input_items, "turn": turn},
            transform_key="input_items",
            transform_type=list,
        )
        return out if changed else None


async def build_plugin_host(
    *,
    agent_config: Optional[Dict[str, Any]],
    shared_context,
    event_emitter,
    agent_id: Optional[str],
    model: Optional[str],
    task_id: Optional[str],
    cancellation_token=None,
    llm_caller=None,
) -> Optional[PluginHost]:
    """Resolve the config chain once and build the host for one execution.

    Returns None when no plugin is enabled — the runner then pays zero
    dispatch overhead. tenant_settings is one read per agent execution; a
    failed read degrades that level to "not configured" instead of failing
    the run.
    """
    sc = shared_context
    tenant_id = getattr(sc, "tenant_id", None) if sc else None
    storage = getattr(sc, "storage", None) if sc else None

    run_config: Any = None
    cache = getattr(sc, "cache", None) if sc else None
    if isinstance(cache, dict):
        run_config = cache.get("run_config")

    tenant_settings: Any = None
    if storage is not None and tenant_id and hasattr(storage, "get_tenant_settings"):
        try:
            tenant_settings = await storage.get_tenant_settings(tenant_id)
        except Exception as exc:
            logger.warning(
                "[PLUGIN] tenant_settings read failed for %s — level skipped: %s",
                tenant_id,
                exc,
            )

    run_context = PluginRunContext(
        project_id=getattr(sc, "project_id", None) if sc else None,
        run_id=getattr(sc, "run_id", None) if sc else None,
        agent_id=agent_id,
        tenant_id=tenant_id,
        task_id=task_id,
        model=model,
    )

    entries: List[Tuple[Plugin, PluginServices]] = []
    for plugin_name, spec in PLUGIN_REGISTRY.items():
        effective = resolve_plugin_config(
            plugin_name,
            code_defaults=spec.code_defaults,
            tenant_settings=tenant_settings,
            run_config=run_config,
            agent_config=agent_config,
        )
        if not plugin_enabled(effective):
            continue
        try:
            plugin = spec.factory()
        except Exception as exc:
            logger.warning("[PLUGIN] %s factory failed — skipped: %s", plugin_name, exc)
            continue
        services = PluginServices(
            plugin_name=plugin_name,
            config=effective,
            run_context=run_context,
            event_emitter=event_emitter,
            message_store=getattr(sc, "message_store", None) if sc else None,
            storage=storage,
            rolling_summary_store=getattr(storage, "rolling_summary_store", None),
            llm_caller=llm_caller,
        )
        entries.append((plugin, services))

    if not entries:
        return None
    return PluginHost(
        entries,
        run_context=run_context,
        event_emitter=event_emitter,
        cancellation_token=cancellation_token,
    )

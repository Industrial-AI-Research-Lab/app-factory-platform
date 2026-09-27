"""Hook-point contract for plugins (ADR-0004, decision #23).

Six named points cover the agent execution lifecycle:

    pre_flight     — before the first Turn: observe tool schemas + system prompt
    context_render — while the Assembled Context is built: may replace the render
    tool_result    — a tool result before it enters the dialog (and the journal):
                     may replace/archive the content
    pre_send       — before each LLM request: may transform the input items
    post_turn      — after the provider response: observe actual usage
    overflow       — typed context-overflow error: may propose a recovery
                     transformation for a single resend

A Plugin subscribes by overriding the corresponding ``on_<hook>`` method;
un-overridden methods mean "not subscribed" and are never dispatched.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

HOOK_PRE_FLIGHT = "pre_flight"
HOOK_CONTEXT_RENDER = "context_render"
HOOK_TOOL_RESULT = "tool_result"
HOOK_PRE_SEND = "pre_send"
HOOK_POST_TURN = "post_turn"
HOOK_OVERFLOW = "overflow"

HOOK_POINTS = (
    HOOK_PRE_FLIGHT,
    HOOK_CONTEXT_RENDER,
    HOOK_TOOL_RESULT,
    HOOK_PRE_SEND,
    HOOK_POST_TURN,
    HOOK_OVERFLOW,
)

HOOK_METHODS = {
    HOOK_PRE_FLIGHT: "on_pre_flight",
    HOOK_CONTEXT_RENDER: "on_context_render",
    HOOK_TOOL_RESULT: "on_tool_result",
    HOOK_PRE_SEND: "on_pre_send",
    HOOK_POST_TURN: "on_post_turn",
    HOOK_OVERFLOW: "on_overflow",
}


@dataclass(frozen=True)
class PluginRunContext:
    """Identity of one agent execution, fixed at host build time.

    The Turn number is NOT here — it changes per hook call and rides in the
    dispatch arguments instead.
    """

    project_id: Optional[str] = None
    run_id: Optional[str] = None
    agent_id: Optional[str] = None
    tenant_id: Optional[str] = None
    task_id: Optional[str] = None
    model: Optional[str] = None


class Plugin:
    """Base plugin: override ``on_<hook>`` methods to subscribe.

    Transform hooks (context_render, tool_result, pre_send, overflow) return a
    replacement value or ``None`` for "no change". Observe hooks (pre_flight,
    post_turn) always return ``None``. Every method receives the
    ``PluginServices`` facade as its first argument — the plugin's only door
    to the platform.
    """

    name: str = "plugin"

    async def on_pre_flight(
        self, services, *, tools: List[Dict[str, Any]], system_prompt: Optional[str]
    ) -> None:
        return None

    async def on_context_render(self, services, *, rendered: str) -> Optional[str]:
        return None

    async def on_tool_result(
        self,
        services,
        *,
        name: str,
        arguments: str,
        call_id: Optional[str],
        result: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        return None

    async def on_pre_send(
        self, services, *, input_items: List[Dict[str, Any]], turn: int
    ) -> Optional[List[Dict[str, Any]]]:
        return None

    async def on_post_turn(
        self,
        services,
        *,
        turn: int,
        usage: Optional[Dict[str, Any]],
        stop_reason: Optional[str],
    ) -> None:
        return None

    async def on_overflow(
        self,
        services,
        *,
        error: BaseException,
        input_items: List[Dict[str, Any]],
        turn: int,
    ) -> Optional[List[Dict[str, Any]]]:
        return None

    @classmethod
    def subscribed_hooks(cls) -> frozenset[str]:
        """Hooks whose methods this class overrides relative to ``Plugin``."""
        subscribed = set()
        for hook, method in HOOK_METHODS.items():
            if getattr(cls, method) is not getattr(Plugin, method):
                subscribed.add(hook)
        return frozenset(subscribed)

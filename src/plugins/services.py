"""Services facade: the plugin's single door to the platform (ADR-0004).

Lives apart from the host so the services contract does not depend on hook
mechanics. v1 doors: resolved config, execution-feed event emission, run
identity, and platform storage handles (message store / storage backend) for
plugins that need durable reads. v2 (AppFactory-149) adds the two doors the
compaction engine needs: a single-shot utility LLM call (the compactor) and the
model context-window / token-estimate the trigger reasons about.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from .contract import PluginRunContext

logger = logging.getLogger(__name__)

# Mirrors agents.base.ESTIMATED_CHARS_PER_TOKEN. Duplicated (not imported) to
# keep the plugin services free of an agents-layer dependency — importing base
# here would cycle (agents imports plugins.host).
_ESTIMATED_CHARS_PER_TOKEN = 4


class PluginServices:
    def __init__(
        self,
        *,
        plugin_name: str,
        config: Dict[str, Any],
        run_context: PluginRunContext,
        event_emitter=None,
        message_store=None,
        storage=None,
        rolling_summary_store=None,
        llm_caller=None,
    ):
        self.plugin_name = plugin_name
        self.config = config
        self.run_context = run_context
        self._event_emitter = event_emitter
        self.message_store = message_store
        self.storage = storage
        # Versioned rolling-summary store (AppFactory-149). Held on the backend and
        # forwarded here; None on paths that wire no storage (tests, simple
        # runner) — the compaction plugin skips folding rather than raising.
        self.rolling_summary_store = rolling_summary_store
        # Async callable (messages, *, model, temperature) -> str. Injected by
        # build_plugin_host from the agent; None on paths that don't wire it
        # (simple runner, tests) — call_model raises rather than silently no-op.
        self._llm_caller = llm_caller

    async def emit(self, event_type: str, data: Optional[Dict[str, Any]] = None) -> None:
        """Emit an execution-feed event enriched with the run identity.

        Best-effort by contract: observability must never take down the
        workload, so emitter absence or failure is logged and swallowed.
        """
        if self._event_emitter is None:
            return
        ctx = self.run_context
        payload = {
            **(data or {}),
            "plugin": self.plugin_name,
            "project_id": ctx.project_id,
            "agent_id": ctx.agent_id,
            "task_id": ctx.task_id,
            "model": ctx.model,
        }
        try:
            await self._event_emitter.emit(event_type, ctx.run_id, payload)
        except Exception as exc:
            logger.warning(
                "[PLUGIN] %s event emit failed (%s): %s",
                self.plugin_name,
                event_type,
                exc,
            )

    async def call_model(
        self,
        messages: List[Dict[str, Any]],
        *,
        model: Optional[str] = None,
        temperature: Optional[float] = None,
    ) -> str:
        """Single-shot utility LLM call — the compactor's summariser door.

        Per the ADR-0004 amendment this is a private call: not journaled to the
        tool ledger, invisible to the execution feed (the injected caller uses a
        non-streaming completion), and it must never itself trip compaction. It
        returns the model's text. Raises if no caller was wired.
        """
        if self._llm_caller is None:
            raise RuntimeError(
                f"[PLUGIN] {self.plugin_name}: call_model used but no LLM caller "
                "was wired into services"
            )
        return await self._llm_caller(messages, model=model, temperature=temperature)

    async def model_context_window(self, model: Optional[str] = None) -> int:
        """Real context window (tokens) for ``model`` (defaults to the run's model).

        Gateway cache first, model registry on a miss — the same order the
        history valve uses. Any failure degrades to 0 so the caller can fall back
        to its own default; it never raises into the run path.
        """
        from llm.model_config import get_context_length_from_cache, get_model_registry

        target = model or self.run_context.model
        window = None
        try:
            window = await get_context_length_from_cache(target, storage=self.storage)
        except Exception:
            window = None
        if not window:
            try:
                window = get_model_registry().get_config(target).max_context_tokens
            except Exception:
                window = None
        return int(window) if window else 0

    @staticmethod
    def estimate_tokens(text: Optional[str]) -> int:
        """Cheap ceil(chars/4) token estimate — the heuristic the history valve uses.

        Deliberately approximate: the trigger only needs "are we near the window",
        and the real ``prompt_tokens`` from ``post_turn`` calibrates after the fact.
        """
        if not text:
            return 0
        return (len(text) + _ESTIMATED_CHARS_PER_TOKEN - 1) // _ESTIMATED_CHARS_PER_TOKEN

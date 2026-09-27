"""Context Compaction plugin — the Rolling Summary engine (AppFactory-149, ADR-0014).

One algorithm — head verbatim · middle summarized · tail verbatim — applied to the
items about to be sent to the model. The middle folds into a persistent, versioned
Rolling Summary (``rolling_summaries`` store); each fold extends the previous version
rather than re-reading the whole past (Decision 3). Originals stay the source of
truth, so a fold is recoverable and revert just drops the versions covering rewound
messages.

Scope of THIS seam (pre_send / overflow): the verbatim head is the system prompt plus
the current task message; the compactable body is the in-run trajectory (the
function_call ↔ function_call_output pile that grows each round). Cross-run
conversation history still rides inside the task message via the base.py valve until
the assembly seam consumes the summary in its place — the same engine, extended there,
not a second mechanism.

The observe hooks (pre_flight / context_render / tool_result / post_turn) stay
marker-only: they proved the plugin infrastructure in AppFactory-147 and remain the
execution-feed breadcrumbs an admin watches. Compaction acts only where it holds the
full item list.
"""

from __future__ import annotations

import math

from typing import Any, Callable, Dict, List, Optional, Tuple, TypeVar

from schemas.event_schema import EventSchema

from .contract import Plugin

# Defaults; every knob is overridable via plugins.context_compaction.* (Decision 8).
_DEFAULT_KEEP_RECENT_TOOL_TOKENS = 30_000
_DEFAULT_COMPACT_AT_PERCENT = 75  # compact when the assembled stream passes this % of the window
_DEFAULT_SUMMARY_TEMPERATURE = 0.2
_DEFAULT_MIN_MIDDLE_ITEMS = 1  # below this the fold isn't worth an LLM call
# Cap the verbatim tail at this × window so head + summary + tail can't re-overflow
# a small window on the reactive resend (which has already overflowed once).
_DEFAULT_TAIL_WINDOW_FRACTION = 0.5

_Number = TypeVar("_Number", int, float)


def _coerce_number(value: Any, default: _Number, cast: Callable[[Any], _Number]) -> _Number:
    """Coerce a tenant-config value to a number, degrading to ``default`` on junk.

    Tenant plugin config is an unvalidated dict (schemas: plugins is dict[str, dict])
    and the UI Save isn't blocked by a schema squiggle, so a non-numeric string
    ("abc", "10.5") reaches these knob reads. A bare int()/float() would raise and
    fail the run; compaction's contract is to degrade, not crash. None / absent →
    default; an explicit 0 is kept (a valid setting, distinct from absent)."""
    if value is None:
        return default
    try:
        result = cast(value)
    except (ValueError, TypeError, OverflowError):
        # int(float("inf")) is OverflowError, not ValueError; JSON "1e400" parses to
        # inf, so a tenant number can reach here as a non-finite float.
        return default
    # float() accepts "NaN"/"inf"; a non-finite value still crashes the downstream
    # int(window * pct / 100) math, so treat it as junk too.
    if isinstance(result, float) and not math.isfinite(result):
        return default
    return result

# The injected summary is a plain user message; this prefix is how a later fold
# recognises its own prior injection and drops it before re-rendering, so the
# summary text is never fed to the compactor twice (once as prior, once as body).
_SUMMARY_PREFIX_MATCH = "[Rolling summary of earlier context]"
_SUMMARY_PREFIX = _SUMMARY_PREFIX_MATCH + "\n"
# Public alias: the seeder (agents.base) injects the rolling summary as an item
# with this exact prefix, so an in-run fold here recognises and replaces it
# instead of duplicating it (AppFactory-149 slice 5).
SUMMARY_PREFIX = _SUMMARY_PREFIX

_COMPACTOR_SYSTEM = (
    "You compress an AI agent's working context so it fits a smaller budget. "
    "Return a concise, factual summary under these sections:\n"
    "Narrative — what happened and why.\n"
    "Achievements — what is done and verified.\n"
    "State — current status, pending gates, open decisions.\n"
    "Notable tool calls — key actions and their outcomes.\n"
    "Preserve identifiers — file paths, IDs, error strings, URLs — VERBATIM; a "
    "paraphrased identifier is useless. Compress everything else. If a prior "
    "summary is given, fold the new activity into it and return one merged summary "
    "in the same sections — do not repeat the prior summary verbatim."
)


# ---------------------------------------------------------------------------
# Pure helpers (no services / IO) — the item-shape logic and the pair guard.
# Item shapes (Responses API, see streaming_agent_runner):
#   {"type":"message","role":...,"content":str}
#   {"type":"function_call","call_id":...,"name":...,"arguments":...}
#   {"type":"function_call_output","call_id":...,"output":...}
# ---------------------------------------------------------------------------


def _item_text(item: Dict[str, Any]) -> str:
    """Best-effort text of an item, for token estimation and rendering."""
    if not isinstance(item, dict):
        return str(item)
    itype = item.get("type")
    if itype == "function_call":
        return f"{item.get('name', '')} {item.get('arguments', '')}"
    if itype == "function_call_output":
        out = item.get("output")
        return out if isinstance(out, str) else str(out)
    content = item.get("content")
    if isinstance(content, str):
        return content
    return str(content) if content is not None else ""


def _is_injected_summary(item: Dict[str, Any]) -> bool:
    return (
        isinstance(item, dict)
        and item.get("type") == "message"
        and isinstance(item.get("content"), str)
        and item["content"].startswith(_SUMMARY_PREFIX_MATCH)
    )


def _split_head(items: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Peel off the verbatim head: leading system message(s) + the first user
    message (the current task). The rest is the compactable body.

    The task message is never summarised — it is the instruction in force, not
    past context. Cross-run history bundled into it by the valve is compacted at
    the assembly seam, not here.
    """
    head: List[Dict[str, Any]] = []
    i = 0
    n = len(items)
    while i < n and items[i].get("type") == "message" and items[i].get("role") == "system":
        head.append(items[i])
        i += 1
    if i < n and items[i].get("type") == "message" and items[i].get("role") == "user":
        head.append(items[i])
        i += 1
    return head, items[i:]


def _pull_pairs_boundary(body: List[Dict[str, Any]], tail_start: int) -> int:
    """Move ``tail_start`` earlier until no function_call_output in the tail is
    separated from its function_call (ADR pair-atomicity, layers 1–2).

    A call always precedes its output, so including an output means its call is
    at an earlier index; we pull the boundary back to that call. Pulling back can
    expose still-earlier outputs, so iterate to a fixed point.
    """
    while tail_start > 0:
        tail_call_ids = {
            it.get("call_id")
            for it in body[tail_start:]
            if it.get("type") == "function_call"
        }
        earliest_needed: Optional[int] = None
        for it in body[tail_start:]:
            if it.get("type") == "function_call_output":
                cid = it.get("call_id")
                if cid in tail_call_ids:
                    continue
                for j in range(tail_start - 1, -1, -1):
                    bj = body[j]
                    if bj.get("type") == "function_call" and bj.get("call_id") == cid:
                        earliest_needed = j if earliest_needed is None else min(earliest_needed, j)
                        break
        if earliest_needed is None:
            break
        tail_start = earliest_needed
    return tail_start


def _repair_pairs(tail: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Final repair net (ADR layer 3): drop orphans that would violate the API
    contract — a function_call with no output in the tail (a hanging call), or a
    function_call_output with no call (should not survive the boundary pull, kept
    as belt-and-suspenders)."""
    call_ids = {
        it.get("call_id") for it in tail if it.get("type") == "function_call"
    }
    out_ids = {
        it.get("call_id") for it in tail if it.get("type") == "function_call_output"
    }
    cleaned: List[Dict[str, Any]] = []
    for it in tail:
        itype = it.get("type")
        if itype == "function_call" and it.get("call_id") not in out_ids:
            continue
        if itype == "function_call_output" and it.get("call_id") not in call_ids:
            continue
        cleaned.append(it)
    return cleaned


def _partition_body(
    body: List[Dict[str, Any]],
    *,
    tail_budget_tokens: int,
    estimate: Callable[[Dict[str, Any]], int],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Split the body into (middle, tail).

    Tail = trailing items whose token estimate fits ``tail_budget_tokens`` (always
    at least the last item), with the boundary pulled earlier for pair-atomicity
    and the result run through the repair net. Middle = everything before it.
    """
    n = len(body)
    if n == 0:
        return [], []
    acc = 0
    tail_start = n
    for i in range(n - 1, -1, -1):
        t = estimate(body[i])
        if tail_start < n and acc + t > tail_budget_tokens:
            break
        acc += t
        tail_start = i
    tail_start = _pull_pairs_boundary(body, tail_start)
    middle = body[:tail_start]
    tail = _repair_pairs(body[tail_start:])
    return middle, tail


def _render_middle(items: List[Dict[str, Any]]) -> str:
    """Render the middle items into text for the compactor prompt."""
    parts: List[str] = []
    for it in items:
        itype = it.get("type")
        if itype == "function_call":
            parts.append(f"TOOL CALL {it.get('name', '')}({it.get('arguments', '')})")
        elif itype == "function_call_output":
            parts.append(f"TOOL RESULT: {_item_text(it)}")
        else:
            parts.append(f"{str(it.get('role', '')).upper()}: {_item_text(it)}")
    return "\n\n".join(parts)


def build_compactor_messages(
    prior_text: Optional[str], new_activity_text: str
) -> List[Dict[str, str]]:
    """The compactor's chat payload, shared by both fold sites (AppFactory-149).

    The in-run plugin fold (trajectory items) and the seeder's cross-run fold
    (conversation turns) speak to the summariser through this one prompt, so a
    fold is a fold regardless of what it is folding — the fold-forward contract
    lives in exactly one place. ``new_activity_text`` is the already-rendered body
    (items via _render_middle for the plugin, turns for the seeder).
    """
    user_parts: List[str] = []
    if prior_text:
        user_parts.append("PRIOR SUMMARY (fold the new activity into this):\n" + prior_text)
    user_parts.append("NEW ACTIVITY TO FOLD IN:\n" + new_activity_text)
    return [
        {"role": "system", "content": _COMPACTOR_SYSTEM},
        {"role": "user", "content": "\n\n".join(user_parts)},
    ]


# ---------------------------------------------------------------------------


class ContextCompactionPlugin(Plugin):
    name = "context_compaction"

    async def on_pre_flight(
        self, services, *, tools: List[Dict[str, Any]], system_prompt: Optional[str]
    ) -> None:
        await services.emit(
            EventSchema.PLUGIN_MARKER,
            {
                "hook": "pre_flight",
                "tools_count": len(tools or []),
                "system_prompt_chars": len(system_prompt or ""),
            },
        )

    async def on_context_render(self, services, *, rendered: str) -> Optional[str]:
        await services.emit(
            EventSchema.PLUGIN_MARKER,
            {"hook": "context_render", "rendered_chars": len(rendered or "")},
        )
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
        await services.emit(
            EventSchema.PLUGIN_MARKER,
            {"hook": "tool_result", "tool": name, "call_id": call_id},
        )
        return None

    async def on_pre_send(
        self, services, *, input_items: List[Dict[str, Any]], turn: int
    ) -> Optional[List[Dict[str, Any]]]:
        result, marker = await self._compute(
            services, input_items, turn, reason="pre_send", force=False
        )
        await services.emit(EventSchema.PLUGIN_MARKER, marker)
        return result

    async def on_post_turn(
        self,
        services,
        *,
        turn: int,
        usage: Optional[Dict[str, Any]],
        stop_reason: Optional[str],
    ) -> None:
        await services.emit(
            EventSchema.PLUGIN_MARKER,
            {"hook": "post_turn", "turn": turn, "usage": usage, "stop_reason": stop_reason},
        )

    async def on_overflow(
        self,
        services,
        *,
        error: BaseException,
        input_items: List[Dict[str, Any]],
        turn: int,
    ) -> Optional[List[Dict[str, Any]]]:
        # Reactive backstop: we already overflowed, so compact regardless of the
        # proactive threshold. The runner allows exactly one recovery resend.
        result, marker = await self._compute(
            services, input_items, turn, reason="overflow", force=True
        )
        marker["error"] = str(error)
        await services.emit(EventSchema.PLUGIN_MARKER, marker)
        return result

    async def _compute(
        self,
        services,
        input_items: List[Dict[str, Any]],
        turn: int,
        *,
        reason: str,
        force: bool,
    ) -> Tuple[Optional[List[Dict[str, Any]]], Dict[str, Any]]:
        """Decide and perform compaction. Returns (replacement or None, marker).

        Emits no event itself — the caller emits the single marker — so each hook
        call produces exactly one execution-feed breadcrumb.
        """
        marker: Dict[str, Any] = {"hook": reason, "turn": turn, "compacted": False}

        store = getattr(services, "rolling_summary_store", None)
        project_id = services.run_context.project_id
        if store is None or not project_id:
            marker["skipped"] = "no-store" if store is None else "no-project"
            return None, marker

        cfg = services.config or {}
        keep_recent_tool_tokens = _coerce_number(cfg.get("keep_recent_tool_tokens"), _DEFAULT_KEEP_RECENT_TOOL_TOKENS, int)
        compact_at_percent = _coerce_number(cfg.get("compact_at_percent_full"), _DEFAULT_COMPACT_AT_PERCENT, float)
        # Absolute-token trigger: when > 0 it replaces the percent bar (capped at the
        # window), so an operator can pin compaction to a flat token count instead of
        # a percent that drifts with each model's window. 0 / absent keeps the percent.
        compact_above_tokens = _coerce_number(cfg.get("compact_above_tokens"), 0, int)
        min_middle = _DEFAULT_MIN_MIDDLE_ITEMS  # internal guard (empty middle), not a user knob

        total_tokens = sum(services.estimate_tokens(_item_text(it)) for it in input_items)
        marker["before_tokens"] = total_tokens

        window = await services.model_context_window()
        if not force:
            if window <= 0:
                marker["skipped"] = "no-window"
                return None, marker
            threshold = (
                min(compact_above_tokens, window)
                if compact_above_tokens > 0
                else int(window * compact_at_percent / 100)
            )
            marker["threshold"] = threshold
            if total_tokens <= threshold:
                marker["skipped"] = "under-threshold"
                return None, marker
            marker["window"] = window

        # Keep the verbatim tail to a fraction of the window so head + summary +
        # tail can't exceed a small window — otherwise the reactive resend (already
        # overflowed once) rebuilds an over-window context and the runner, out of
        # its one retry, fails the run. Window unknown (0) → keep the fixed budget;
        # a huge head can still overflow, which stays the valve's problem.
        if window > 0:
            frac = _DEFAULT_TAIL_WINDOW_FRACTION  # internal safety cap, not a user knob
            keep_recent_tool_tokens = min(keep_recent_tool_tokens, max(1, int(window * frac)))

        head, body = _split_head(input_items)
        body = [it for it in body if not _is_injected_summary(it)]

        def estimate(it: Dict[str, Any]) -> int:
            return services.estimate_tokens(_item_text(it))

        middle, tail = _partition_body(
            body, tail_budget_tokens=keep_recent_tool_tokens, estimate=estimate,
        )
        if force and sum(estimate(it) for it in tail) > keep_recent_tool_tokens:
            # The tail always keeps the newest item, and the pair pull then drags its
            # call in, so the tail can bust the budget two ways: one item alone (a
            # tool result under the archive's 512KB spill yet over the model window),
            # or a call+result pair whose halves each fit but whose sum does not.
            # Measuring the whole tail catches both; a per-item check misses the pair.
            # The input that just overflowed already carried this tail and the runner
            # allows no third send, so resending it verbatim is the failure we are here
            # to avert — fold the whole body and let the summary carry it (originals
            # stay in the ledger). Proactive sends keep it: over the tail budget is not
            # over the window.
            middle, tail = list(body), []
            marker["tail_folded"] = True
        if len(middle) < min_middle:
            # Nothing foldable here — e.g. the tail alone (or the verbatim head)
            # already fills the budget. The head case is the valve's job until the
            # assembly seam lands; surface it rather than looping to no effect.
            marker["skipped"] = "middle-too-small"
            marker["middle_items"] = len(middle)
            return None, marker

        prior = await store.get_latest(project_id)
        prior_text = prior.get("summary") if prior else None
        summary_text = await self._summarize(services, prior_text, middle, cfg)
        if not summary_text:
            marker["skipped"] = "empty-summary"
            return None, marker

        covers_to = await self._high_water(services, project_id, prior)
        # Trajectory-only fold: this seam never folds conversation turns (they ride
        # in the head, folded by the seeder), so the conversation frontier does not
        # move — carry the prior value forward. Advancing it to the message
        # high-water would make the seeder skip recent verbatim turns next run that
        # were never summarised: silent cross-run loss (see store two-frontier note).
        conv_covers_to = int(prior.get("conversation_covers_to_sequence", 0)) if prior else 0
        version = await store.append_version(
            project_id,
            summary=summary_text,
            covers_from_sequence=0,
            covers_to_sequence=covers_to,
            conversation_covers_to_sequence=conv_covers_to,
            run_id=services.run_context.run_id,
            meta={"turn": turn, "reason": reason, "middle_items": len(middle)},
        )

        summary_item = {
            "type": "message",
            "role": "user",
            "content": _SUMMARY_PREFIX + summary_text,
        }
        rebuilt = list(head) + [summary_item] + list(tail)

        marker.update(
            {
                "compacted": True,
                "version": version["version"],
                "covers_to_sequence": covers_to,
                "middle_items": len(middle),
                "tail_items": len(tail),
                "before_items": len(input_items),
                "after_items": len(rebuilt),
            }
        )
        return rebuilt, marker

    async def _summarize(
        self,
        services,
        prior_text: Optional[str],
        middle: List[Dict[str, Any]],
        cfg: Dict[str, Any],
    ) -> Optional[str]:
        """Single-shot compactor call. Returns the summary text, or None if the
        summariser is unavailable or gave nothing (caller keeps the original
        context rather than sending a broken one)."""
        messages = build_compactor_messages(prior_text, _render_middle(middle))
        model = cfg.get("summary_model") or None
        temperature = cfg.get("summary_temperature", _DEFAULT_SUMMARY_TEMPERATURE)
        try:
            text = await services.call_model(messages, model=model, temperature=temperature)
        except Exception as exc:
            await services.emit(
                EventSchema.PLUGIN_ERROR, {"hook": "compactor", "error": str(exc)}
            )
            return None
        return (text or "").strip() or None

    async def _high_water(self, services, project_id: str, prior: Optional[Dict[str, Any]]) -> int:
        """Conservative covered-range upper bound: the project's current max
        message sequence. It is ≥ every sequence the summary actually covers, so
        the revert sweep (drop versions with covers_to > rewind point) can never
        keep a stale summary — at worst it re-folds a version that was still
        valid. Precise per-item stamping is a later refinement."""
        ms = getattr(services, "message_store", None)
        if ms is not None:
            try:
                return int(await ms.get_latest_sequence(project_id))
            except Exception:
                pass
        return int(prior.get("covers_to_sequence", 0)) if prior else 0

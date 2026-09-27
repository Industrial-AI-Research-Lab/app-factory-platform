"""Registry of platform plugins: name -> (factory, code-level defaults).

The registry is code, not config: which plugins EXIST ships with the
platform; whether each is ACTIVE resolves through the config chain
(agent > run > tenant > these code defaults) at host build time.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List

from .context_compaction import ContextCompactionPlugin
from .contract import Plugin


@dataclass(frozen=True)
class PluginSpec:
    factory: Callable[[], Plugin]
    code_defaults: Dict[str, Any] = field(default_factory=dict)
    # One-line, human-facing summary for the tenant-settings plugin catalog
    # (GET /api/settings/plugins). Kept here, not on the Plugin class, so the
    # catalog reads registration metadata without constructing every plugin.
    description: str = ""
    # JSON Schema served in the catalog to validate/autocomplete the config editor.
    # Every property must be a key the plugin actually reads, or it's a no-op knob.
    config_schema: Dict[str, Any] = field(default_factory=dict)
    # Markdown explainer the card shows above the parameter list.
    guide: str = ""
    # Ordered {"title", "summary", "keys"} sections the card lists parameters under,
    # so each key reads next to the mechanism it steers.
    param_groups: List[Dict[str, Any]] = field(default_factory=list)


# Two internal knobs are deliberately NOT exposed here — they are safety guards,
# not tuning dials, so they live as constants in context_compaction.py:
#   * the empty-middle guard (never call the summary model with nothing to fold)
#   * the verbatim-tail window cap (tail can't exceed a fraction of the window)
# keep_recent_conversation_tokens is absent-by-default: the run fold falls back to
# a window fraction (base.py:_resolve_history_char_budget) unless it is set.
_CONTEXT_COMPACTION_CONFIG_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,  # an unknown key is a typo, not config — flag it
    "properties": {
        "enabled": {
            "type": "boolean",
            "default": False,
            "description": (
                "The switch for tool-call compaction: during a task, once the request "
                "passes compact_at_percent_full of the context window (or "
                "compact_above_tokens), the task's older tool calls and results are "
                "summarized into the project summary. Off by default. History "
                "compaction runs whether the switch is on or off."
            ),
        },
        "summarize_overflow_conversation": {
            "type": "boolean",
            "default": True,
            "description": (
                "What history compaction does with project history older than "
                "keep_recent_conversation_tokens, at the start of a task: summarize "
                "it into the project summary (true, the default) or leave it out of "
                "the request (false). Exception: with false, a workflow phase whose "
                "Reads is Full context or lists conversation_history gets the history "
                "as raw JSON, not limited by keep_recent_conversation_tokens. "
                "Nothing is deleted either way. Works whether the plugin switch is on "
                "or off."
            ),
        },
        "summary_model": {
            "type": "string",
            "description": (
                "Model that writes the project summary, for both history compaction "
                "and tool-call compaction. Empty = the run config's model for this "
                "agent (Agent Configs), else the run config's compaction model, else "
                "its Fallback Model, else the project's model, else the agent's own "
                "model. A run that forces one model for everything (e.g. "
                "the tenant Default Model on a run started with a run config) uses "
                "the forced model instead."
            ),
        },
        "summary_temperature": {
            "type": "number",
            "default": 0.2,
            "minimum": 0,
            "maximum": 2,
            "description": (
                "Sampling temperature for tool-call compaction summaries, so it "
                "matters only while the plugin switch is on. History compaction always "
                "asks for 0.2 instead. If the model writing the summary has gpt-5 in "
                "its name (except gpt-5-chat-latest) or is an o1 or o3 model, it runs "
                "at 1 whatever either kind of compaction asks for."
            ),
        },
        "compact_at_percent_full": {
            "type": "integer",
            "default": 75,
            "minimum": 0,
            "maximum": 100,
            "description": (
                "Tool-call compaction starts once the request (every part except the "
                "tool list) passes this percent of the context window of the model "
                "the task runs on; write 75 for 75%. Ignored while compact_above_tokens is "
                "above 0. Only while the plugin switch is on."
            ),
        },
        "compact_above_tokens": {
            "type": "integer",
            "minimum": 0,
            "description": (
                "Tool-call compaction starts once the request (every part except the "
                "tool list) passes this many tokens, capped at the context window. "
                "Above 0 replaces compact_at_percent_full; 0 or absent keeps the "
                "percent. Only while the plugin switch is on."
            ),
        },
        "keep_recent_tool_tokens": {
            "type": "integer",
            "default": 30000,
            "minimum": 0,
            "description": (
                "When tool-call compaction runs: how many tokens of the current "
                "task's newest tool calls and results stay word for word; older ones "
                "are summarized into the project summary. Capped at 50% of the "
                "context window of the model the task runs on. Only while the plugin "
                "switch is on."
            ),
        },
        "keep_recent_conversation_tokens": {
            "type": "integer",
            "minimum": 0,
            "description": (
                "How much project history the task message carries word for word, in "
                "tokens (estimated as 4 characters each). Project history = messages from the "
                "user and agents, plus tool calls and results from before the current "
                "task started. Sizes only that history, not the whole request. Absent "
                "or 0 = 60% of the context window of the model saved on the agent; "
                "larger values are capped at that 60%. Not applied while "
                "summarize_overflow_conversation is false on a workflow phase whose "
                "Reads is Full context or lists conversation_history. Works whether "
                "the plugin switch is on or off."
            ),
        },
    },
}


_CONTEXT_COMPACTION_GUIDE = "\n".join(
    [
        "An agent works on a task by sending **requests** to a model. One request can "
        "hold at most the model's **context window**, measured in tokens. The "
        "platform estimates 1 token as 4 characters.",
        "",
        "This plugin makes room under that limit by **compaction**: replacing "
        "older material with a short summary written by a model. There are two kinds, "
        "**history compaction** and **tool-call compaction**, and each kind shrinks a "
        "different part of the request. Tool-call compaction runs only while the "
        "switch on this card is on; history compaction runs either way.",
        "",
        "**Project history** is everything that happened in the project before the "
        "current task started: messages from the user and from agents, plus earlier "
        "tool calls with their results. The current task's own tool calls are not "
        "history.",
        "",
        "### The four parts of one request, in the order they are sent",
        "",
        "| Part | What is in it | What shrinks it |",
        "|---|---|---|",
        "| 1. Instructions | The agent's system prompt and tool list | Nothing |",
        "| 2. Task message | The user's request, the project history, the plan, the "
        "project's file list, attachment text, the current task. In a workflow "
        "phase, the **Reads** setting can change this: see the next section | Only "
        "the project history inside it, by history compaction |",
        "| 3. Project summary | The summary written by compaction, once one exists. "
        "One per project, shared by all of the project's agents and tasks | "
        "Rewritten by each compaction |",
        "| 4. This task's tool calls | Every tool call the agent makes during the "
        "current task, with its result | Tool-call compaction, only while the switch "
        "is on |",
        "",
        "### Workflow phases: the Reads setting decides the task message",
        "",
        "In the workflow editor, every phase has a **Reads** setting; a phase set to "
        "**Inherit workflow defaults** uses the workflow's **Workflow Default "
        "Reads**. The setting picks which **keys** the phase receives. A key is one "
        "named piece of project data, such as **requirements**, **plan** or a key an "
        "agent wrote; project history is the key **conversation_history**. The "
        "setting a phase ends up with decides its task message:",
        "",
        "- **Legacy full context**, inherited from the workflow: the task message in "
        "the table above. Any task that is not a workflow phase gets this one too.",
        "- **Full context** (not the same as **Legacy full context**): every key, "
        "each written out in full as raw JSON, then the current task.",
        "- A list of keys, from **Custom keys only**, **Workflow defaults + extra "
        "keys**, **System base + extra** or **Custom defaults**: only the listed "
        "keys, each written out in full as raw JSON, then the current task. **System "
        "base + extra** always lists **conversation_history**.",
        "- **No context**: only the current task.",
        "",
        "Project history is the one key handled differently, as the next section "
        "explains.",
        "",
        "### History compaction: at the start of a task, switch on or off",
        "",
        "History compaction works on the project history inside the task message. A "
        "phase whose Reads is **No context**, or a list of keys without "
        "**conversation_history**, has no project history there: "
        "`summarize_overflow_conversation` and `keep_recent_conversation_tokens` "
        "change nothing for it, and no project summary is sent at the start of its "
        "task.",
        "",
        "With `summarize_overflow_conversation` set to `true` (the default), the task "
        "message carries the newest project history word for word, up to "
        "`keep_recent_conversation_tokens`, and older history is summarized into the "
        "project summary.",
        "",
        "With `summarize_overflow_conversation` set to `false`, no project summary is "
        "sent at the start of the task, and the history depends on the Reads "
        "setting:",
        "",
        "- **Legacy full context**, or a task that is not a workflow phase: the "
        "newest project history stays word for word, up to "
        "`keep_recent_conversation_tokens`; older history is left out of the request.",
        "- **Full context**, or a list of keys with **conversation_history**: the "
        "project history goes in as raw JSON, and "
        "`keep_recent_conversation_tokens` does not limit it.",
        "",
        "Nothing is deleted either way: the full history stays in the project's "
        "records.",
        "",
        "### Tool-call compaction: during a task, only while the switch is on",
        "",
        "Before every model call, the plugin estimates the size of the request (every "
        "part except the tool list). Once the size passes `compact_at_percent_full` of "
        "the context window, or `compact_above_tokens` when that is above 0, the "
        "task's older tool calls are summarized into the project summary; the "
        "originals stay in the project's records. The newest tool calls, up to "
        "`keep_recent_tool_tokens`, stay word for word.",
        "",
        "If the model rejects a request as too long anyway, the plugin compacts at "
        "once and resends the request one time; a second rejection ends the task "
        "with an error. With the switch off, the first rejection ends the task with "
        "an error.",
        "",
        "### What nothing on this card shrinks",
        "",
        "The instructions, the user's request, the plan, the file list, the current "
        "task, attachment text, and every key a phase receives through Reads other "
        "than **conversation_history**. Attachment text has its own limit, set "
        "outside this card: by default "
        "a file over 32 KB, or past 128 KB in total, is listed without its text. If "
        "the parts that never shrink exceed the context window on their own, the "
        "model rejects the request and the task ends with an error.",
        "",
        "### Example: an agent running on its own model, 400,000-token context window, "
        "the switch on, every other setting at its default",
        "",
        "| What | Tokens | Where the number comes from |",
        "|---|---|---|",
        "| Project history carried word for word | 240,000 | 60% of the window: "
        "default and cap of `keep_recent_conversation_tokens` |",
        "| Request size that starts tool-call compaction | 300,000 | 75% of the "
        "window: `compact_at_percent_full` |",
        "| This task's tool calls kept word for word | 30,000 | "
        "`keep_recent_tool_tokens`; cap 200,000, which is 50% of the window |",
        "",
        "### Questions people ask",
        "",
        "- **Is `keep_recent_conversation_tokens` the size of the whole request?** "
        "No. The setting sizes only the project history inside the task message. The "
        "instructions, the rest of the task message, the project summary and this "
        "task's tool calls come on top.",
        "- **Does turning the switch off stop all compaction?** No. The switch "
        "controls tool-call compaction only. History compaction keeps running; "
        "`summarize_overflow_conversation` decides what it does with older history.",
        "- **Which model's context window do the percentages use?** The 60% for "
        "`keep_recent_conversation_tokens` comes from the model saved on the agent. "
        "The 75% of `compact_at_percent_full` and the 50% cap on "
        "`keep_recent_tool_tokens` come from the model the task actually runs on. That "
        "is the agent's own model unless the run config sets a model (the agent's "
        "entry in **Agent Configs**, or the **Fallback Model**) or the project has one "
        "(the model picked at launch or, if none is picked, the tenant **Default "
        "Model**).",
        "- **What are the hook names on this card?** `pre_send` and `overflow` run "
        "tool-call compaction. `pre_flight`, `context_render`, `tool_result` and "
        "`post_turn` only record markers in the run's events and change nothing.",
    ]
)

_CONTEXT_COMPACTION_PARAM_GROUPS: List[Dict[str, Any]] = [
    {
        "title": "History compaction",
        "summary": (
            "At the start of a task, whether the switch is on or off. Shrinks only the "
            "project history inside the task message, so a workflow phase whose Reads "
            "leaves that history out is not affected."
        ),
        "keys": ["summarize_overflow_conversation", "keep_recent_conversation_tokens"],
    },
    {
        "title": "Tool-call compaction",
        "summary": (
            "During a task, only while the switch is on. Shrinks only the current "
            "task's tool calls and results."
        ),
        "keys": [
            "enabled",
            "compact_at_percent_full",
            "compact_above_tokens",
            "keep_recent_tool_tokens",
            "summary_temperature",
        ],
    },
    {
        "title": "Both kinds",
        "summary": "Used by history compaction and tool-call compaction alike.",
        "keys": ["summary_model"],
    },
]


PLUGIN_REGISTRY: Dict[str, PluginSpec] = {
    # Disabled unless configured (code default below). The compaction engine
    # (AppFactory-149) is live: when enabled, pre_send/overflow fold the trajectory
    # into a rolling summary; the other four hooks only emit markers.
    "context_compaction": PluginSpec(
        factory=ContextCompactionPlugin,
        code_defaults={"enabled": False},
        description=(
            "Helps each request an agent sends to the model fit the model's context "
            "window by replacing older material with a model-written summary. Two "
            "kinds: history compaction runs at the start of each task that carries "
            "project history, whether the switch is on or off; tool-call compaction "
            "runs during a task only while the switch is on."
        ),
        config_schema=_CONTEXT_COMPACTION_CONFIG_SCHEMA,
        guide=_CONTEXT_COMPACTION_GUIDE,
        param_groups=_CONTEXT_COMPACTION_PARAM_GROUPS,
    ),
}

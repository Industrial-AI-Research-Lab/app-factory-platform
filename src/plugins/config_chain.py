"""Plugin config resolution: agent > run > tenant > code default (decision #20).

Each level contributes a partial ``plugins.<name>`` dict; nearer-to-the-agent
levels override per key, so an agent can flip one knob without restating the
rest. Resolution happens once per agent execution — never per hook call.
"""

from __future__ import annotations

import copy
from typing import Any, Mapping, Optional


def _plugin_section(surface: Any, plugin_name: str) -> dict[str, Any]:
    """Extract ``surface["plugins"][plugin_name]`` if every layer is a dict.

    Config surfaces are user-editable Mongo docs — malformed shapes must
    degrade to "not configured", never to an exception in the run path.
    """
    if not isinstance(surface, Mapping):
        return {}
    plugins = surface.get("plugins")
    if not isinstance(plugins, Mapping):
        return {}
    section = plugins.get(plugin_name)
    if not isinstance(section, Mapping):
        return {}
    return dict(section)


def resolve_plugin_config(
    plugin_name: str,
    *,
    code_defaults: Optional[Mapping[str, Any]] = None,
    tenant_settings: Any = None,
    run_config: Any = None,
    agent_config: Any = None,
) -> dict[str, Any]:
    """Merge one plugin's config across the chain; later levels win per key.

    Returns a deep copy: callers and plugins may mutate the effective config
    without corrupting the cached run_config / agent doc they came from.
    """
    effective: dict[str, Any] = dict(code_defaults or {})
    for surface in (tenant_settings, run_config, agent_config):
        effective.update(_plugin_section(surface, plugin_name))
    return copy.deepcopy(effective)


# The only string spellings that count as "on". Config surfaces are
# user-editable, so "enabled" can arrive as a string; everything not listed
# here — "false"/"no"/"0"/"" included — is off.
_TRUTHY_ENABLED_STRINGS = frozenset({"true", "1", "yes", "on"})


# The falsy spellings a human types in the JSON config editor. Only meaningful
# for flags whose default is ON (plugin_flag): an unrecognized string there must
# fall back to the default, but a clearly-off spelling must win over it.
_FALSY_FLAG_STRINGS = frozenset({"false", "0", "no", "off", ""})


def plugin_flag(effective_config: Mapping[str, Any], key: str, *, default: bool) -> bool:
    """Read a boolean plugin knob, tolerating the JSON editor's loose typing.

    Same parse as ``plugin_enabled`` (real bools, truthy/falsy strings, non-zero
    numbers), but for an arbitrary key with a caller-chosen default — used by
    knobs that default ON (e.g. the conversation-fold seeder switch), where an
    absent or unrecognizable value must land on the default, and only a clearly
    truthy/falsy value overrides it.
    """
    if not isinstance(effective_config, Mapping) or key not in effective_config:
        return default
    value = effective_config[key]
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        s = value.strip().lower()
        if s in _TRUTHY_ENABLED_STRINGS:
            return True
        if s in _FALSY_FLAG_STRINGS:
            return False
        return default
    if isinstance(value, (int, float)):
        return value != 0
    return default


def plugin_enabled(effective_config: Mapping[str, Any]) -> bool:
    """A plugin is off unless its resolved config clearly says on.

    Only real booleans, the recognized truthy strings, and non-zero numbers
    enable it. A bare bool() would fail OPEN: every non-empty string is
    truthy, so the "false"/"no"/"0" a human types in the JSON config editor
    would turn the plugin ON — the opposite of the False default this gate,
    and the whole chain's degrade-to-not-configured stance, is built around.
    """
    value = effective_config.get("enabled", False)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in _TRUTHY_ENABLED_STRINGS
    if isinstance(value, (int, float)):
        return value != 0
    return False

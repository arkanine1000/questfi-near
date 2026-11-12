"""Parsing for the ``type:key=value`` action strings agents emit."""

from __future__ import annotations


def parse_action_string(action_string: str) -> dict:
    """Parse a ``type:key=value:key=value`` string into an engine action dict.

    Examples::

        "move:direction=N"        -> {"action": "move", "direction": "N"}
        "attack:target=goblin_1"  -> {"action": "attack", "target": "goblin_1"}
        "search"                  -> {"action": "search"}

    An optional leading ``ACTION:`` prefix is tolerated — LLM brains emit it
    unprompted, and it was the wire format of the removed v1 player agent.
    """
    s = action_string.strip()
    if s.upper().startswith("ACTION:"):
        s = s[len("ACTION:"):]

    parts = s.split(":")
    if not parts or not parts[0]:
        raise ValueError(f"Empty action string: {action_string!r}")

    result: dict = {"action": parts[0].strip()}
    for part in parts[1:]:
        if "=" in part:
            key, value = part.split("=", 1)
            result[key.strip()] = value.strip()
    return result

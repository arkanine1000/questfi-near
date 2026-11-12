"""Tests for character presets and agent personality data.

These cover ``models/presets.py`` only. The presets are consumed by
``engine/sandbox/build.py``, which reads ``CHARACTER_PRESETS`` directly and
builds its own ``Character`` — so the assertions here stay on the data, not on
any constructor.
"""

from __future__ import annotations

from quest_sim.models.presets import (
    AGENT_PERSONALITIES,
    CHARACTER_PRESETS,
    AgentPersonalityKey,
    CharacterPresetKey,
)

# ---------------------------------------------------------------------------
# CharacterPreset data integrity
# ---------------------------------------------------------------------------


def test_all_preset_keys_have_entries():
    """Every CharacterPresetKey enum value must have a corresponding entry."""
    for key in CharacterPresetKey:
        assert key in CHARACTER_PRESETS, f"Missing preset entry for {key}"


def test_preset_stats_are_distinct():
    """No two presets should have identical (hp, ac, strength) combinations."""
    signatures = [
        (p.hp, p.ac, p.abilities.strength)
        for p in CHARACTER_PRESETS.values()
    ]
    assert len(signatures) == len(set(signatures)), "Two presets share identical stats"


def test_preset_values_are_positive():
    """HP, max_hp, AC and weapon damage must be positive integers."""
    for key, preset in CHARACTER_PRESETS.items():
        assert preset.hp > 0, f"{key}: hp must be > 0"
        assert preset.max_hp > 0, f"{key}: max_hp must be > 0"
        assert preset.hp == preset.max_hp, f"{key}: hp must equal max_hp at creation"
        assert preset.ac > 0, f"{key}: ac must be > 0"
        assert preset.starter_weapon_damage > 0, f"{key}: weapon damage must be > 0"


def test_preset_starter_weapons_are_named():
    """Every preset names its starter weapon — build.py puts this in the inventory."""
    for key, preset in CHARACTER_PRESETS.items():
        assert preset.starter_weapon_name.strip(), f"{key}: starter weapon needs a name"


def test_preset_abilities_are_non_negative():
    """Abilities are roll modifiers — zero is fine (barbarian DEX), negative is not."""
    for key, preset in CHARACTER_PRESETS.items():
        assert preset.abilities.strength >= 0, f"{key}: STR modifier must be >= 0"
        assert preset.abilities.dexterity >= 0, f"{key}: DEX modifier must be >= 0"
        assert preset.abilities.constitution >= 0, f"{key}: CON modifier must be >= 0"


def test_each_preset_has_a_standout_ability():
    """Every preset leans somewhere — a flat spread would make the kits identical."""
    for key, preset in CHARACTER_PRESETS.items():
        mods = (
            preset.abilities.strength,
            preset.abilities.dexterity,
            preset.abilities.constitution,
        )
        assert max(mods) >= 2, f"{key}: no ability stands out"


def test_preset_abilities_are_not_shared():
    """Presets must not alias one ability object — mutating one would hit them all."""
    ability_ids = [id(p.abilities) for p in CHARACTER_PRESETS.values()]
    assert len(ability_ids) == len(set(ability_ids)), "Presets share an abilities object"


# ---------------------------------------------------------------------------
# AgentPersonality data integrity
# ---------------------------------------------------------------------------


def test_all_personality_keys_have_entries():
    """Every AgentPersonalityKey enum value must have a corresponding entry."""
    for key in AgentPersonalityKey:
        assert key in AGENT_PERSONALITIES, f"Missing personality entry for {key}"


def test_balanced_addendum_is_empty():
    """Balanced personality has no addendum (default behaviour)."""
    assert AGENT_PERSONALITIES[AgentPersonalityKey.balanced].system_prompt_addendum == ""


def test_non_balanced_addenda_are_nonempty():
    """All non-balanced personalities must supply a non-empty addendum."""
    for key, personality in AGENT_PERSONALITIES.items():
        if key == AgentPersonalityKey.balanced:
            continue
        assert personality.system_prompt_addendum.strip(), (
            f"Personality '{key}' must have a non-empty system_prompt_addendum"
        )


def test_personality_addenda_contain_key_phrase():
    """Each non-balanced addendum contains a recognisable keyword."""
    expected_keywords = {
        AgentPersonalityKey.cautious: "cautious",
        AgentPersonalityKey.aggressive: "aggressive",
        AgentPersonalityKey.explorer: "explorer",
    }
    for key, phrase in expected_keywords.items():
        addendum = AGENT_PERSONALITIES[key].system_prompt_addendum.lower()
        assert phrase in addendum, f"Personality '{key}' addendum missing '{phrase}'"

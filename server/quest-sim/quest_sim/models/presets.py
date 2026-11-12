from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict

from quest_sim.models.character import AbilityScores


class CharacterPresetKey(str, Enum):
    fighter = "fighter"
    rogue = "rogue"
    barbarian = "barbarian"


class CharacterPreset(BaseModel):
    model_config = ConfigDict(frozen=True)

    key: CharacterPresetKey
    name: str
    description: str
    hp: int
    max_hp: int
    ac: int
    abilities: AbilityScores
    starter_weapon_name: str
    starter_weapon_id: str   # item id for the equipped_weapon reference
    starter_weapon_damage: int  # damage_bonus used in attack rolls


class AgentPersonalityKey(str, Enum):
    balanced = "balanced"
    cautious = "cautious"
    aggressive = "aggressive"
    explorer = "explorer"


class AgentPersonality(BaseModel):
    model_config = ConfigDict(frozen=True)

    key: AgentPersonalityKey
    name: str
    description: str
    system_prompt_addendum: str


# ---------------------------------------------------------------------------
# Character Presets
#
# Stat design:
#   STR  → attack modifier (attack roll = d20 + STR + weapon to-hit bonus, and a
#          weapon's bonus feeds BOTH the attack roll and the damage roll unless
#          its to_hit_bonus is set apart — see Item.to_hit_bonus)
#   DEX  → initiative modifier (acts first in combat), and evasion: taking the
#          Dodge action guards you at +2 + DEX AC until your next turn
#   CON  → HP pool (not derived, just named as flavor)
#   AC   → direct stat; set high for defensive builds, low for offensive ones
#
# Fighter  — balanced: solid HP, high AC, strong hit chance
# Rogue    — speed:    lower HP, decent AC, DEX-based initiative, acts first
# Barbarian — power:   massive HP, very high attack, low AC (glass-cannon flip)
# ---------------------------------------------------------------------------
CHARACTER_PRESETS: dict[CharacterPresetKey, CharacterPreset] = {
    CharacterPresetKey.fighter: CharacterPreset(
        key=CharacterPresetKey.fighter,
        name="Fighter",
        description=(
            "A versatile warrior clad in chainmail. High attack bonus and solid "
            "armor make the Fighter the safest all-around choice."
        ),
        hp=35,
        max_hp=35,
        ac=16,
        abilities=AbilityScores(strength=3, dexterity=1, constitution=2),
        starter_weapon_name="Longsword",
        starter_weapon_id="longsword",
        starter_weapon_damage=2,  # attack mod = STR(3) + weapon(2) = +5
    ),
    CharacterPresetKey.rogue: CharacterPreset(
        key=CharacterPresetKey.rogue,
        name="Rogue",
        description=(
            "A quick and cunning adventurer in leather armor. Lower HP but "
            "high Dexterity means striking first and dodging effectively."
        ),
        hp=25,
        max_hp=25,
        ac=14,
        abilities=AbilityScores(strength=1, dexterity=3, constitution=1),
        starter_weapon_name="Daggers",
        starter_weapon_id="daggers",
        starter_weapon_damage=2,  # attack mod = STR(1) + weapon(2) = +3, but DEX(3) wins initiative and makes Dodge AC 19
    ),
    CharacterPresetKey.barbarian: CharacterPreset(
        key=CharacterPresetKey.barbarian,
        name="Barbarian",
        description=(
            "An unstoppable berserker with massive HP and a devastating axe. "
            "Light on armor — wins by hitting first and hitting hard."
        ),
        hp=45,
        max_hp=45,
        ac=12,
        abilities=AbilityScores(strength=4, dexterity=0, constitution=3),
        starter_weapon_name="Greataxe",
        starter_weapon_id="greataxe",
        starter_weapon_damage=3,  # attack mod = STR(4) + weapon(3) = +7
    ),
}


# ---------------------------------------------------------------------------
# Agent Personalities
#
# Each personality appends a short directive block to PLAYER_SYSTEM_PROMPT.
# The Balanced addendum is intentionally empty (default behaviour).
# ---------------------------------------------------------------------------
AGENT_PERSONALITIES: dict[AgentPersonalityKey, AgentPersonality] = {
    AgentPersonalityKey.balanced: AgentPersonality(
        key=AgentPersonalityKey.balanced,
        name="Balanced",
        description="A well-rounded adventurer who weighs risks and rewards equally.",
        system_prompt_addendum="",
    ),
    AgentPersonalityKey.cautious: AgentPersonality(
        key=AgentPersonalityKey.cautious,
        name="Cautious",
        description=(
            "Careful and methodical. Searches every room, flees early, "
            "and never wastes a healing potion."
        ),
        system_prompt_addendum=(
            "\n\n## Personality Override: Cautious\n"
            "- Search every room before moving on — you hate leaving secrets behind.\n"
            "- Flee from combat immediately if your HP drops below 50%.\n"
            "- Use a healing potion any time your HP drops below 60% and you have one.\n"
            "- Never rush toward the objective until you are fully prepared and have "
            "explored all reachable rooms."
        ),
    ),
    AgentPersonalityKey.aggressive: AgentPersonality(
        key=AgentPersonalityKey.aggressive,
        name="Aggressive",
        description=(
            "Charges into battle headfirst. Fights everything in sight, "
            "skips searching, and beelines for the objective."
        ),
        system_prompt_addendum=(
            "\n\n## Personality Override: Aggressive\n"
            "- Rush toward enemies and the objective without hesitation.\n"
            "- Never flee from combat — stand and fight to the end.\n"
            "- Do NOT waste time searching rooms; fighting is more important.\n"
            "- Move toward unexplored exits aggressively; reach the objective ASAP."
        ),
    ),
    AgentPersonalityKey.explorer: AgentPersonality(
        key=AgentPersonalityKey.explorer,
        name="Explorer",
        description=(
            "Driven by curiosity. Must see every room, search every corner, "
            "and talk to every NPC before touching the objective."
        ),
        system_prompt_addendum=(
            "\n\n## Personality Override: Explorer\n"
            "- Your top priority is mapping the entire dungeon before pursuing the objective.\n"
            "- Search every unsearched room you visit.\n"
            "- Talk to every NPC you encounter.\n"
            "- Only head for the objective when you have visited every reachable room "
            "or have no other unexplored exits available."
        ),
    ),
}

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class CombatAction(str, Enum):
    attack = "attack"
    dodge = "dodge"
    flee = "flee"
    use_item = "use_item"


class InitiativeEntry(BaseModel):
    character_id: str
    roll: int  # d20 + DEX mod
    has_acted: bool = False


class AttackResult(BaseModel):
    attacker_id: str
    defender_id: str
    attack_roll: int
    target_ac: int
    hit: bool
    damage: int = 0
    critical: bool = False


class CombatState(BaseModel):
    active: bool = False
    round_number: int = 0
    initiative_order: list[InitiativeEntry] = Field(default_factory=list)
    current_turn_index: int = 0
    combatant_ids: list[str] = Field(default_factory=list)
    fled_ids: list[str] = Field(default_factory=list)
    # Combatants who took the Dodge action and have not yet had their next turn.
    # Attacks against them roll against a raised AC. Cleared when the dodger
    # acts again, when they flee, and when the fight ends.
    dodging_ids: list[str] = Field(default_factory=list)
    flee_direction: str | None = None  # direction chosen by player when fleeing (N/S/E/W)

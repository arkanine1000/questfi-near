from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class EntityType(str, Enum):
    player = "player"
    hostile = "hostile"
    npc = "npc"
    invader = "invader"


class ItemType(str, Enum):
    weapon = "weapon"
    potion = "potion"
    shield = "shield"
    misc = "misc"


class AbilityScores(BaseModel):
    strength: int = 0
    dexterity: int = 0
    constitution: int = 0
    intelligence: int = 0
    wisdom: int = 0
    charisma: int = 0


class Item(BaseModel):
    id: str
    name: str
    item_type: ItemType
    damage_bonus: int = 0
    # A weapon's bonus has always applied to BOTH the attack roll and the damage
    # roll, from one field — deliberate (see the preset stat design) but invisible
    # at the point of use. The two are now separate stats; None keeps the historical
    # mirror, so every existing weapon and every prefab is unchanged. Set it
    # explicitly to make a weapon heavy (high damage, low to-hit) or vice versa.
    to_hit_bonus: int | None = None
    ac_bonus: int = 0
    heal_amount: int = 0
    consumable: bool = False
    description: str = ""


class Character(BaseModel):
    id: str
    name: str
    entity_type: EntityType
    hp: int
    max_hp: int
    ac: int = 10
    abilities: AbilityScores = Field(default_factory=AbilityScores)
    # Natural attack, independent of equipment. Everything in the game rolled a
    # flat d6 before these existed, so the defaults are the old hardcoded
    # behaviour and only entities that opt in are affected. A weapon's
    # damage_bonus stacks on top of damage_bonus here.
    damage_dice: int = 6
    damage_bonus: int = 0
    inventory: list[Item] = Field(default_factory=list)
    equipped_weapon: str | None = None  # Item id
    equipped_armor: str | None = None  # Item id (shield/armor with ac_bonus)
    position: tuple[int, int] = (0, 0)  # (row, col)
    is_alive: bool = True
    point_cost: int = 0
    description: str = ""
    interacted: bool = False  # Track if this NPC has been talked to

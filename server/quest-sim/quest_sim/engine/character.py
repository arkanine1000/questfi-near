from __future__ import annotations

from quest_sim.models.character import Character, Item, ItemType


def apply_damage(character: Character, amount: int) -> tuple[Character, bool]:
    """Apply damage to a character. Returns (updated character, is_dead)."""
    character.hp = max(0, character.hp - amount)
    if character.hp == 0:
        character.is_alive = False
    return character, not character.is_alive


def heal(character: Character, amount: int) -> Character:
    """Heal a character, clamping to max_hp."""
    character.hp = min(character.max_hp, character.hp + amount)
    return character


def use_item(character: Character, item_name: str) -> tuple[Character, Item | None]:
    """Use an item from inventory by name. Returns (updated character, used_item or None)."""
    item = None
    for inv_item in character.inventory:
        if inv_item.name.lower() == item_name.lower():
            item = inv_item
            break

    if item is None:
        return character, None

    if item.item_type == ItemType.potion and item.heal_amount > 0:
        character = heal(character, item.heal_amount)

    if item.consumable:
        character.inventory = [i for i in character.inventory if i.id != item.id]

    return character, item


def _equipped_weapon(character: Character) -> Item | None:
    if character.equipped_weapon is None:
        return None
    for item in character.inventory:
        if item.id == character.equipped_weapon:
            return item
    return None


def get_weapon_bonus(character: Character) -> int:
    """Get the damage bonus from the equipped weapon."""
    item = _equipped_weapon(character)
    return item.damage_bonus if item is not None else 0


def get_weapon_to_hit(character: Character) -> int:
    """Get the attack-roll bonus from the equipped weapon.

    Unset (``None``) mirrors the damage bonus — the single-stat behaviour every
    weapon in the game was authored against.
    """
    item = _equipped_weapon(character)
    if item is None:
        return 0
    return item.damage_bonus if item.to_hit_bonus is None else item.to_hit_bonus


def get_armor_bonus(character: Character) -> int:
    """Get the AC bonus from the equipped armor piece."""
    if character.equipped_armor is None:
        return 0
    for item in character.inventory:
        if item.id == character.equipped_armor:
            return item.ac_bonus
    return 0


def effective_ac(character: Character) -> int:
    """Base AC plus equipped armor — the number attacks roll against."""
    return character.ac + get_armor_bonus(character)


def dodge_ac_bonus(character: Character) -> int:
    """AC granted while taking the Dodge action, until your next turn.

    This is the one place DEX buys evasion; everywhere else it only moves you
    up the initiative order. The flat +2 keeps Dodge worth taking for a
    DEX-dumped Barbarian, and the DEX term is what makes it a Rogue's answer to
    a fight it cannot win by trading blows.
    """
    return 2 + max(character.abilities.dexterity, 0)

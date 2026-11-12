"""Actor-agnostic combat math.

These cores know Characters, dice, and events; they never touch
SandboxWorld. Orchestration (who is hostile, what death means for the
season, corpse handling, phase transitions) stays with the caller, which is
now only ``engine/sandbox/combat.py``.

Event data and description strings are frozen shapes, not free prose: the
frontend's crawler beat pipeline reads ``attack``/``damage``/``death``
payloads field by field to animate a fight. They outlived the solo engine
they were written for, and changing one silently breaks an animation rather
than a test.
"""

from __future__ import annotations

import random
from collections.abc import Callable

from quest_sim.engine.character import (
    apply_damage,
    dodge_ac_bonus,
    effective_ac,
    get_weapon_bonus,
    get_weapon_to_hit,
    use_item,
)
from quest_sim.engine.dice import roll_attack, roll_initiative
from quest_sim.models.character import Character, ItemType
from quest_sim.models.combat import CombatState, InitiativeEntry
from quest_sim.models.events import EngineEvent, EngineEventType


def roll_group_initiative(
    actors: list[Character], rng: random.Random, tick: int
) -> tuple[list[InitiativeEntry], list[EngineEvent]]:
    """Roll initiative for a group. Returns (sorted order, roll events).

    Events are emitted in the given actor order; the returned order is
    sorted by roll descending, ties keeping actor order (stable sort).
    """
    events: list[EngineEvent] = []
    order: list[InitiativeEntry] = []
    for entity in actors:
        init_roll = roll_initiative(rng, entity.abilities.dexterity)
        order.append(InitiativeEntry(character_id=entity.id, roll=init_roll))
        events.append(
            EngineEvent(
                event_type=EngineEventType.initiative_roll,
                tick=tick,
                data={"character_id": entity.id, "roll": init_roll},
                description=f"{entity.name} rolls initiative: {init_roll}.",
            )
        )
    order.sort(key=lambda e: e.roll, reverse=True)
    return order, events


def resolve_attack(
    actor: Character,
    target: Character,
    rng: random.Random,
    tick: int,
    target_ac_bonus: int = 0,
) -> tuple[list[EngineEvent], bool]:
    """One attack: d20 vs effective AC, nat-20 crit, damage, death event.

    ``target_ac_bonus`` is transient defence the core cannot see for itself —
    today only a Dodge taken this round. The caller owns that state; this
    module never touches the world.

    Mutates the target's HP. Returns (events, target_died). The caller owns
    the corpse — removal from rooms, remains, kill credit.
    """
    events: list[EngineEvent] = []
    attack_mod = actor.abilities.strength + get_weapon_to_hit(actor)
    target_ac = effective_ac(target) + target_ac_bonus
    result = roll_attack(
        rng, actor.id, target.id, attack_mod, target_ac,
        damage_dice=actor.damage_dice,
        damage_bonus=get_weapon_bonus(actor) + actor.damage_bonus,
    )

    weapon_item = next(
        (i for i in actor.inventory if i.id == actor.equipped_weapon), None
    )
    weapon_name = weapon_item.name if weapon_item else (actor.equipped_weapon or "unarmed")
    events.append(
        EngineEvent(
            event_type=EngineEventType.attack,
            tick=tick,
            data=result.model_dump(),
            description=(
                f"{actor.name} attacks {target.name} with {weapon_name}: "
                f"{'CRITICAL HIT!' if result.critical else 'Hit!' if result.hit else 'Miss!'} "
                f"(rolled {result.attack_roll} vs AC {target_ac})"
            ),
        )
    )

    died = False
    if result.hit:
        _, died = apply_damage(target, result.damage)
        events.append(
            EngineEvent(
                event_type=EngineEventType.damage,
                tick=tick,
                data={
                    "target_id": target.id,
                    "damage": result.damage,
                    "hp_remaining": target.hp,
                },
                description=f"{target.name} takes {result.damage} damage ({target.hp}/{target.max_hp} HP).",
            )
        )
        if died:
            events.append(
                EngineEvent(
                    event_type=EngineEventType.death,
                    tick=tick,
                    data={"character_id": target.id},
                    description=f"{target.name} has been slain!",
                )
            )
    return events, died


def resolve_dodge(actor: Character, tick: int, ac_bonus: int = 0) -> list[EngineEvent]:
    """The Dodge action.

    Pure announcement even now: the guard itself lives on the caller's combat
    state, because only the caller knows when the dodger's next turn comes
    round. ``ac_bonus`` of 0 is a dodge that earns nothing — the fallback the
    engine substitutes for a timeout, a missing decision, or a rejected action.
    """
    data: dict = {"character_id": actor.id, "ac_bonus": ac_bonus}
    desc = f"{actor.name} takes the Dodge action."
    if ac_bonus > 0:
        data["ac"] = effective_ac(actor) + ac_bonus
        desc = (
            f"{actor.name} takes the Dodge action "
            f"(AC {data['ac']} until their next turn)."
        )
    return [
        EngineEvent(
            event_type=EngineEventType.dodge,
            tick=tick,
            data=data,
            description=desc,
        )
    ]


def resolve_use_item(actor: Character, item_name: str, tick: int) -> list[EngineEvent]:
    """Use an inventory item by name (potions heal; consumables vanish)."""
    events: list[EngineEvent] = []
    _, used = use_item(actor, item_name)
    if used:
        data: dict = {"character_id": actor.id, "item": used.name}
        desc = f"{actor.name} uses {used.name}."
        if used.item_type == ItemType.potion and used.heal_amount > 0:
            # spectators need the healed value — damage events carry
            # hp_remaining, so heals must too
            data["heal_amount"] = used.heal_amount
            data["hp_remaining"] = actor.hp
            desc = (
                f"{actor.name} uses {used.name} "
                f"(+{used.heal_amount} HP, {actor.hp}/{actor.max_hp})."
            )
        events.append(
            EngineEvent(
                event_type=EngineEventType.item_used,
                tick=tick,
                data=data,
                description=desc,
            )
        )
    return events


def advance_rotation(combat: CombatState, is_active: Callable[[str], bool]) -> None:
    """Advance a rotation to its next active combatant.

    ``is_active(cid)`` decides participation (alive, not fled — the caller
    knows how to look its combatants up). Wrapping the order increments the
    round and resets has_acted flags.
    """
    if not combat.active:
        return

    if combat.initiative_order:
        combat.initiative_order[combat.current_turn_index].has_acted = True

    combat.current_turn_index += 1

    if combat.current_turn_index >= len(combat.initiative_order):
        combat.current_turn_index = 0
        combat.round_number += 1
        for entry in combat.initiative_order:
            entry.has_acted = False

    attempts = 0
    while attempts < len(combat.initiative_order):
        current = combat.initiative_order[combat.current_turn_index]
        if is_active(current.character_id):
            break
        combat.current_turn_index = (combat.current_turn_index + 1) % len(
            combat.initiative_order
        )
        attempts += 1

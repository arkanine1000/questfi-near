from __future__ import annotations

import random

from quest_sim.engine.character import apply_damage
from quest_sim.engine.dice import roll_ability_check
from quest_sim.models.character import Character, Item
from quest_sim.models.events import EngineEvent, EngineEventType
from quest_sim.models.map import Room


# ---------------------------------------------------------------------------
# Actor-agnostic cores. They know Characters and Rooms and nothing about the
# world around them, which is why they survived the solo engine that once
# shared them. The sandbox is now the only caller (actions.py), and it always
# passes ``subject=agent.name`` — the parameter stays because these functions
# name the actor in player-facing prose and should not have to guess.
# ---------------------------------------------------------------------------


def trap_core(
    actor: Character, room: Room, rng: random.Random, tick: int, subject: str | None = None
) -> list[EngineEvent]:
    """An untriggered trap fires at the actor: DEX save vs trap_dc.

    The trap latches (first visitor eats it) — correct for shared interiors.
    """
    events: list[EngineEvent] = []
    if room.trap_dc is None or room.trap_triggered:
        return events

    label = subject or actor.name
    room.trap_triggered = True
    total, success = roll_ability_check(rng, actor.abilities.dexterity, room.trap_dc)

    if success:
        events.append(
            EngineEvent(
                event_type=EngineEventType.trap_disarm,
                tick=tick,
                data={"roll": total, "dc": room.trap_dc},
                description=f"{label} dodges the trap! (rolled {total} vs DC {room.trap_dc})",
            )
        )
    else:
        damage = room.trap_damage
        apply_damage(actor, damage)
        events.append(
            EngineEvent(
                event_type=EngineEventType.trap_trigger,
                tick=tick,
                data={
                    "roll": total,
                    "dc": room.trap_dc,
                    "damage": damage,
                    "hp_remaining": actor.hp,
                },
                description=f"Trap triggered! {label} takes {damage} damage (rolled {total} vs DC {room.trap_dc}). HP: {actor.hp}/{actor.max_hp}",
            )
        )

    return events


def search_core(
    actor: Character,
    room: Room,
    items_by_id: dict[str, Item],
    rng: random.Random,
    tick: int,
    subject: str | None = None,
    already_attempted: bool = False,
) -> list[EngineEvent]:
    """Search a room: WIS vs search_dc; found items move to the actor.

    ``items_by_id`` is the loot source — the site's item pool. Treasure ids
    missing from it (e.g. entity ids) are skipped rather than raising. The
    room's searched latch and treasure clearing persist: a looted room stays
    looted for everyone.

    ``already_attempted`` is the per-agent half of the split — whether THIS
    agent has rolled here before. The room's own ``searched`` latch is the
    global half, and collapsing the two back together is the bug that made
    the WIS check meaningless. See tests/test_sandbox_exploration.py.
    """
    events: list[EngineEvent] = []
    label = subject or actor.name

    if already_attempted or room.searched:
        events.append(
            EngineEvent(
                event_type=EngineEventType.search,
                tick=tick,
                data={"already_searched": True, "by_you": already_attempted},
                description=(
                    f"{label} has already searched this room."
                    if already_attempted
                    else f"{label} finds this room already turned over."
                ),
            )
        )
        return events

    # `room.searched` is set per-outcome below, never up here. It means
    # REVEALED TO EVERYONE, and a failed roll reveals nothing — latching it
    # before the check handed the failer the loot they had just missed and
    # closed the room to every other agent at the same time.

    # No treasure in room
    if not room.treasure_item_ids:
        # Not a DC-gated secret: "there is nothing here" is true for the
        # whole table, and latching it keeps a policy brain's unfinished-room
        # set shrinking instead of churning on empty rooms.
        room.searched = True
        events.append(
            EngineEvent(
                event_type=EngineEventType.search,
                tick=tick,
                data={"found": False},
                description=f"{label} searches the room but finds nothing of interest.",
            )
        )
        return events

    def _claim_items() -> None:
        for item_id in room.treasure_item_ids:
            item = items_by_id.get(item_id)
            if item is None:
                continue  # not an item (e.g. an entity id)
            actor.inventory.append(item)
            events.append(
                EngineEvent(
                    event_type=EngineEventType.item_found,
                    tick=tick,
                    data={"item_id": item_id, "item_name": item.name},
                    description=f"{label} finds {item.name}!",
                )
            )
        room.treasure_item_ids.clear()

    # Treasure exists but no DC required - auto-reveal items
    if room.search_dc is None:
        room.searched = True
        events.append(
            EngineEvent(
                event_type=EngineEventType.search,
                tick=tick,
                data={"found": True, "auto_reveal": True},
                description=f"{label} searches the room and finds something!",
            )
        )
        _claim_items()
        return events

    # Treasure exists with DC - roll to find
    total, success = roll_ability_check(rng, actor.abilities.wisdom, room.search_dc)

    if success:
        room.searched = True  # found it — the room is open to everyone now
        events.append(
            EngineEvent(
                event_type=EngineEventType.search,
                tick=tick,
                data={"roll": total, "dc": room.search_dc, "found": True},
                description=(
                    f"{label}'s search turns something up! "
                    f"(rolled {total} vs DC {room.search_dc})"
                ),
            )
        )
        _claim_items()
    else:
        events.append(
            EngineEvent(
                event_type=EngineEventType.search,
                tick=tick,
                data={"roll": total, "dc": room.search_dc, "found": False},
                description=f"{label} searches the room but finds nothing of interest.",
            )
        )

    return events

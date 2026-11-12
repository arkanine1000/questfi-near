"""Sandbox world verbs — movement, dungeon transitions, loot, gear.

Every verb is ``(world, agent, ...) -> list[EngineEvent]``: it mutates the
world and reports what happened. Invalid orders fail LOUDLY (``action_failed``
with a reason the agent reads next turn) — silent no-ops teach agents nothing
on the dead branches.

Combat is deliberately absent here: movement does not know what a fight is.
The tick pipeline scans for hostile co-location after applying actions.
"""

from __future__ import annotations

import random

from quest_sim.engine.combat_core import resolve_use_item
from quest_sim.engine.exploration import search_core, trap_core
from quest_sim.models.character import Item, ItemType
from quest_sim.models.events import EngineEvent, EngineEventType
from quest_sim.models.map import DIRECTION_OFFSETS, Direction
from quest_sim.models.overworld import (
    HEX_DIRECTIONS,
    WorldPos,
    hex_key,
    parse_hex_key,
)
from quest_sim.models.sandbox import DungeonSite, SandboxAgent, SandboxWorld


def _ev(
    event_type: EngineEventType,
    world: SandboxWorld,
    data: dict,
    description: str,
    agent: SandboxAgent | None = None,
    location: str | None = None,
) -> EngineEvent:
    return EngineEvent(
        event_type=event_type,
        tick=world.tick,
        data=data,
        description=description,
        actor=agent.agent_id if agent else None,
        location=location or (agent.loc_key if agent else None),
    )


def fail(
    world: SandboxWorld,
    agent: SandboxAgent,
    action: str,
    reason: str,
    code: str = "invalid_action",
) -> list[EngineEvent]:
    """A failed action, with a machine-readable `code` beside the prose.

    The code exists so a BYO client can tell "you named something that was
    never here" from "someone killed it before your blow landed" without
    pattern-matching English. It is a data key rather than an EngineEventType
    member on purpose: the enum is the spectator taxonomy, and the feed, the
    commentator and the frontend should not have to learn a failure
    sub-species only the acting agent cares about."""
    return [
        _ev(
            EngineEventType.action_failed, world,
            {"agent": agent.agent_id, "action": action, "reason": reason, "code": code},
            f"{agent.name}'s {action} failed: {reason}", agent,
        )
    ]


def _tile_add(world: SandboxWorld, hex_key_str: str, agent_id: str) -> None:
    tile = world.overworld.get_key(hex_key_str)
    if tile is not None and agent_id not in tile.occupants:
        tile.occupants.append(agent_id)


def _tile_remove(world: SandboxWorld, hex_key_str: str | None, agent_id: str) -> None:
    if hex_key_str is None:
        return
    tile = world.overworld.get_key(hex_key_str)
    if tile is not None and agent_id in tile.occupants:
        tile.occupants.remove(agent_id)


def mark_visited(agent: SandboxAgent, site_id: str, room_key: str) -> bool:
    """Record per-agent room knowledge. Returns True on first visit."""
    seen = agent.visited.setdefault(site_id, set())
    first = room_key not in seen
    seen.add(room_key)
    return first


def mark_searched(agent: SandboxAgent, site_id: str, room_key: str) -> bool:
    """Record that this agent spent a search here. True on the first attempt."""
    tried = agent.searched_rooms.setdefault(site_id, set())
    first = room_key not in tried
    tried.add(room_key)
    return first


def has_searched(agent: SandboxAgent, site_id: str | None, room_key: str | None) -> bool:
    """Has this agent already spent its one search on this room?"""
    if not site_id or not room_key:
        return False
    return room_key in agent.searched_rooms.get(site_id, set())


def loot_revealed(room) -> bool:
    """This room's treasure is on show — no roll needed to take it.

    `room.searched` means REVEALED TO EVERYONE, not "somebody tried". The
    two meanings used to be one flag, which is why a failed roll handed the
    failer the loot it had just missed."""
    return room.search_dc is None or room.searched


def search_spent(agent: SandboxAgent, room, site_id: str | None, room_key: str | None) -> bool:
    """Nothing left here for THIS agent to gain by searching.

    Either it already tried, or someone else already found what was here —
    both make `search` a wasted tick, for different reasons."""
    return room.searched or has_searched(agent, site_id, room_key)


def search_worthwhile(
    agent: SandboxAgent, room, site_id: str | None, room_key: str | None
) -> bool:
    """Can searching HERE actually pay out? The single source of truth shared
    by the policy brain and the valid_actions offer.

    `search_spent` only asks whether the attempt is still available — it says
    nothing about whether there is anything to find. Measured over 15 ten-agent
    seasons, that gap put `search` on the menu 1,592 times, of which **78% were
    rooms the engine already knew were empty** (`treasure_item_ids == []`) and
    another 10% had their loot already visible with `pick_up` on the same menu.
    94% of all searches returned nothing. Hosted brains take what the menu
    offers, so they burned a turn per room on a coin flip with no coin — the
    same defect `best_upgrade` fixed for `equip`, which used to loop forever on
    a looser offer.

    Consequence accepted deliberately: because this is exactly the set of rooms
    hiding something, `search` appearing on the menu now TELLS an agent this
    room holds loot. The WIS check still decides whether they get it — they
    just no longer roll in empty corridors."""
    return (
        bool(room.treasure_item_ids)
        and room.search_dc is not None
        and not search_spent(agent, room, site_id, room_key)
    )


def current_room(site: DungeonSite | None, agent: SandboxAgent):
    if site is None or not agent.position.room:
        return None
    r, c = (int(x) for x in agent.position.room.split(","))
    return site.map_grid.get_room(r, c)


# ---------------------------------------------------------------------------
# Surface movement
# ---------------------------------------------------------------------------


def travel(world: SandboxWorld, agent: SandboxAgent, direction: str) -> list[EngineEvent]:
    """One hex step on the surface (E/W/NE/NW/SE/SW)."""
    if agent.position.kind != "overworld" or not agent.position.hex:
        return fail(world, agent, "travel", "you are underground — exit the dungeon first")
    direction = (direction or "").upper()
    if direction not in HEX_DIRECTIONS:
        return fail(world, agent, "travel",
                    f"unknown direction '{direction}' (use E, W, NE, NW, SE, SW)")

    q, r = parse_hex_key(agent.position.hex)
    dq, dr = HEX_DIRECTIONS[direction]
    target_key = hex_key(q + dq, r + dr)
    tile = world.overworld.get_key(target_key)
    if tile is None:
        return fail(world, agent, "travel", f"nothing but open sea lies {direction}")

    old_key = agent.position.hex
    _tile_remove(world, old_key, agent.agent_id)
    agent.position = WorldPos.at_hex(q + dq, r + dr)
    _tile_add(world, target_key, agent.agent_id)

    return [
        _ev(
            EngineEventType.travel, world,
            {
                "character_id": agent.agent_id,
                "name": agent.name,
                "from": old_key,
                "to": target_key,
                "direction": direction,
                "terrain": tile.terrain.value,
                "site_id": tile.site_id,
            },
            f"{agent.name} travels {direction} to ({target_key}) [{tile.terrain.value}].",
            agent, location=f"hex:{target_key}",
        )
    ]


# ---------------------------------------------------------------------------
# Dungeon transitions + interior movement
# ---------------------------------------------------------------------------


def _entrance_room_for_hex(site: DungeonSite, hex_key_str: str) -> str | None:
    """The entrance room that surfaces at this hex (first by room key)."""
    matches = sorted(rk for rk, hk in site.entrances.items() if hk == hex_key_str)
    return matches[0] if matches else None


def enter_dungeon(world: SandboxWorld, agent: SandboxAgent, rng: random.Random) -> list[EngineEvent]:
    if agent.position.kind != "overworld" or not agent.position.hex:
        return fail(world, agent, "enter", "you are already underground")
    tile = world.overworld.get_key(agent.position.hex)
    if tile is None or tile.site_id is None:
        return fail(world, agent, "enter", "there is no dungeon mouth here")
    site = world.get_site(tile.site_id)
    if site is None:
        return fail(world, agent, "enter", "there is no dungeon mouth here")

    room_key = _entrance_room_for_hex(site, agent.position.hex)
    if room_key is None:
        return fail(world, agent, "enter", "the way down has collapsed")

    er, ec = (int(x) for x in room_key.split(","))
    room = site.map_grid.get_room(er, ec)
    if room is None:
        return fail(world, agent, "enter", "the way down has collapsed")

    _tile_remove(world, agent.position.hex, agent.agent_id)
    agent.position = WorldPos.in_site(site.site_id, er, ec)
    agent.last_room = None
    first = mark_visited(agent, site.site_id, room_key)

    events = [
        _ev(
            EngineEventType.site_enter, world,
            {
                "character_id": agent.agent_id,
                "name": agent.name,
                "site_id": site.site_id,
                "site_name": site.name,
                "room": room_key,
                "room_type": room.room_type.value,
                "first_visit": first,
            },
            f"{agent.name} descends into {site.name}.",
            agent, location=f"{site.site_id}:{room_key}",
        )
    ]
    events.extend(trap_core(agent.character, room, rng, world.tick, subject=agent.name))
    events.extend(_trap_death(world, agent))
    return _stamp_actor(events, agent)


def _trap_death(world: SandboxWorld, agent: SandboxAgent) -> list[EngineEvent]:
    """Exploration damage kills too: run full permadeath when a trap drops
    an agent. Combat used to be the only death pipeline — trap victims
    became silent ghosts (no feed event, no cause, loot stuck on the
    corpse)."""
    if agent.is_alive:
        return []
    from quest_sim.engine.sandbox.combat import handle_actor_death  # local: cycle

    return handle_actor_death(
        world, agent.agent_id, None, agent.loc_key, killer_label="a trap"
    )


def _stamp_actor(events: list[EngineEvent], agent: SandboxAgent) -> list[EngineEvent]:
    for ev in events:
        if ev.actor is None:
            ev.actor = agent.agent_id
        if ev.location is None:
            ev.location = agent.loc_key
    return events


def exit_dungeon(world: SandboxWorld, agent: SandboxAgent) -> list[EngineEvent]:
    if agent.position.kind != "dungeon" or not agent.position.site_id:
        return fail(world, agent, "exit", "you are not inside a dungeon")
    site = world.get_site(agent.position.site_id)
    if site is None:
        return fail(world, agent, "exit", "you are not inside a dungeon")
    room_key = agent.position.room or ""
    if room_key not in site.entrances:
        return fail(world, agent, "exit", "you must stand in an entrance room to leave")

    target_key = site.entrances[room_key]
    q, r = parse_hex_key(target_key)
    agent.position = WorldPos.at_hex(q, r)
    agent.last_room = None
    _tile_add(world, target_key, agent.agent_id)

    return [
        _ev(
            EngineEventType.site_exit, world,
            {
                "character_id": agent.agent_id,
                "name": agent.name,
                "site_id": site.site_id,
                "site_name": site.name,
                "to": target_key,
            },
            f"{agent.name} climbs back to the surface from {site.name}.",
            agent, location=f"hex:{target_key}",
        )
    ]


def dungeon_move(
    world: SandboxWorld, agent: SandboxAgent, direction: str, rng: random.Random
) -> list[EngineEvent]:
    if agent.position.kind != "dungeon" or not agent.position.site_id:
        return fail(world, agent, "move", "you are on the surface — use travel")
    site = world.get_site(agent.position.site_id)
    if site is None or not agent.position.room:
        return fail(world, agent, "move", "you are on the surface — use travel")

    try:
        d = Direction((direction or "").upper())
    except ValueError:
        return fail(world, agent, "move",
                    f"unknown direction '{direction}' (use N, S, E, W)")

    cur_r, cur_c = (int(x) for x in agent.position.room.split(","))
    cur_room = site.map_grid.get_room(cur_r, cur_c)
    if cur_room is None or not cur_room.connections.get(d):
        return fail(world, agent, "move", f"no passage leads {d.value} from here")

    dr, dc = DIRECTION_OFFSETS[d]
    new_r, new_c = cur_r + dr, cur_c + dc
    new_room = site.map_grid.get_room(new_r, new_c)
    if new_room is None:
        return fail(world, agent, "move", f"no passage leads {d.value} from here")

    old_key = f"{cur_r},{cur_c}"
    new_key = f"{new_r},{new_c}"
    agent.position = WorldPos.in_site(site.site_id, new_r, new_c)
    agent.last_room = old_key
    first = mark_visited(agent, site.site_id, new_key)

    events = [
        _ev(
            EngineEventType.room_enter, world,
            {
                "character_id": agent.agent_id,
                "name": agent.name,
                "from": [cur_r, cur_c],
                "to": [new_r, new_c],
                "direction": d.value,
                "room_type": new_room.room_type.value,
                "first_visit": first,
            },
            f"{agent.name} moved {d.value} to row {new_r}, col {new_c} [{new_room.room_type.value}].",
            agent, location=f"{site.site_id}:{new_key}",
        )
    ]
    events.extend(trap_core(agent.character, new_room, rng, world.tick, subject=agent.name))
    events.extend(_trap_death(world, agent))
    return _stamp_actor(events, agent)


# ---------------------------------------------------------------------------
# Loot: searching, floors, gear
# ---------------------------------------------------------------------------


def search_here(world: SandboxWorld, agent: SandboxAgent, rng: random.Random) -> list[EngineEvent]:
    if agent.position.kind != "dungeon" or not agent.position.site_id:
        return fail(world, agent, "search", "nothing to search on the open surface")
    site = world.get_site(agent.position.site_id)
    room = current_room(site, agent)
    if site is None or room is None:
        return fail(world, agent, "search", "nothing to search here")
    room_key = agent.position.room or ""
    events = search_core(
        agent.character, room, site.items, rng, world.tick,
        subject=agent.name,
        already_attempted=has_searched(agent, site.site_id, room_key),
    )
    # Idempotent, and after the call so the fail() paths above never record a
    # search that did not happen.
    mark_searched(agent, site.site_id, room_key)
    for ev in events:
        if ev.actor is None:
            ev.actor = agent.agent_id
        if ev.location is None:
            ev.location = agent.loc_key
    _auto_equip_new(agent, events)
    return events


def _auto_equip_new(agent: SandboxAgent, events: list[EngineEvent]) -> None:
    """Fill empty hands with anything item_found events just delivered."""
    found_ids = {
        e.data.get("item_id") for e in events
        if e.event_type is EngineEventType.item_found
    }
    for item in agent.character.inventory:
        if item.id in found_ids:
            _auto_equip(agent, item)


def _auto_equip(agent: SandboxAgent, item: Item) -> bool:
    """Fill an empty hand/back with a picked-up weapon/armor piece."""
    char = agent.character
    if item.item_type == ItemType.weapon and char.equipped_weapon is None:
        char.equipped_weapon = item.id
        return True
    if (item.item_type == ItemType.shield or item.ac_bonus > 0) and char.equipped_armor is None:
        char.equipped_armor = item.id
        return True
    return False


def visible_floor_items(world: SandboxWorld, agent: SandboxAgent) -> list[Item]:
    """Loot the agent can see at their feet without a search roll.

    Dungeon floors show their treasure when the room needs no roll or has
    already been searched (dropped gear lands in the same pool — rifling a
    fresh corpse in an unsearched trove still takes a search).
    """
    if agent.position.kind == "dungeon":
        site = world.get_site(agent.position.site_id)
        room = current_room(site, agent)
        if site is None or room is None:
            return []
        if not loot_revealed(room):
            return []
        return [site.items[i] for i in room.treasure_item_ids if i in site.items]
    tile = world.overworld.get_key(agent.position.hex or "")
    if tile is None:
        return []
    return list(tile.ground_items)


_ARTICLES = ("the ", "a ", "an ")


def _norm(text: str) -> str:
    """Casefold, collapse whitespace, drop a leading article."""
    out = " ".join((text or "").split()).lower()
    for article in _ARTICLES:
        if out.startswith(article):
            return out[len(article):]
    return out


def resolve_item_ref(items: list[Item], item_ref: str) -> Item | None:
    """The one item an agent means, or None. NEVER guesses between two.

    Agents write item names the way people do — they drop articles and
    shorten. Requiring the exact string produced a real livelock: an agent
    at 11/25 HP issued ``pick_up:item=Vault Seal`` on six consecutive ticks
    against an item named "The Vault Seal" sitting in its own observation,
    and took it the moment the model happened to write the article.

    An ambiguous ref still fails loudly. Taking "the nearest thing" would
    hand an agent something it did not ask for, which is worse than a
    refusal it can read and correct."""
    ref = _norm(item_ref)
    if not ref:
        return None
    exact = [i for i in items if _norm(i.name) == ref or i.id.lower() == ref]
    if exact:
        # Same-name duplicates are normal — sites share prefab templates.
        return exact[0]
    partial = [i for i in items if ref in _norm(i.name)]
    return partial[0] if len(partial) == 1 else None


def pick_up(
    world: SandboxWorld, agent: SandboxAgent, item_ref: str | None = None
) -> list[EngineEvent]:
    """Take loot here: bare = everything visible; with a ref = that one item."""
    events: list[EngineEvent] = []
    ref = (item_ref or "").strip()
    # Resolve the ref ONCE against what the agent can actually see, then match
    # by identity below. visible_floor_items covers both branches and already
    # respects the dungeon's loot-reveal gate, so an unrevealed item can never
    # become the resolution target.
    wanted = resolve_item_ref(visible_floor_items(world, agent), ref) if ref else None

    def _matches(item: Item) -> bool:
        return item is wanted if ref else True

    if agent.position.kind == "dungeon":
        site = world.get_site(agent.position.site_id)
        room = current_room(site, agent)
        visible = {i.id for i in visible_floor_items(world, agent)}
        if site is not None and room is not None:
            for item_id in list(room.treasure_item_ids):
                item = site.items.get(item_id)
                if item is None or item.id not in visible or not _matches(item):
                    continue
                room.treasure_item_ids.remove(item_id)
                agent.character.inventory.append(item)
                _auto_equip(agent, item)
                events.append(
                    _ev(
                        EngineEventType.item_found, world,
                        {"character_id": agent.agent_id, "item_id": item.id, "item_name": item.name},
                        f"{agent.name} picks up {item.name}.", agent,
                    )
                )
                if ref:
                    return events
    else:
        tile = world.overworld.get_key(agent.position.hex or "")
        if tile is not None:
            for item in list(tile.ground_items):
                if not _matches(item):
                    continue
                tile.ground_items.remove(item)
                agent.character.inventory.append(item)
                _auto_equip(agent, item)
                events.append(
                    _ev(
                        EngineEventType.item_found, world,
                        {"character_id": agent.agent_id, "item_id": item.id, "item_name": item.name},
                        f"{agent.name} picks up {item.name}.", agent,
                    )
                )
                if ref:
                    return events

    if not events:
        what = f"'{item_ref}'" if item_ref else "anything to take"
        return fail(world, agent, "pick_up", f"there is no {what} here")
    return events


# ---------------------------------------------------------------------------
# Gear + idle
# ---------------------------------------------------------------------------


def find_inventory_item(agent: SandboxAgent, item_ref: str) -> Item | None:
    """Backs both equip and use_item — so they tolerate the same refs as
    pick_up. `use_item:item=Potion` against "Potion of Healing" used to fail
    exactly the way the pick_up livelock did, just on a different verb."""
    return resolve_item_ref(agent.character.inventory, item_ref)


def best_upgrade(agent: SandboxAgent) -> Item | None:
    """The best STRICTLY-better swap waiting in the pack, weapons first.

    The single source of truth shared by the policy brains and the
    valid_actions equip offer. When the offer used a looser test (any
    unequipped item), LLM brains saw `equip` on the menu every tick after
    their first spare and looped on it forever."""
    char = agent.character
    current_w = next((i for i in char.inventory if i.id == char.equipped_weapon), None)
    best_w = max(
        (i for i in char.inventory if i.item_type == ItemType.weapon),
        key=lambda i: i.damage_bonus, default=None,
    )
    if best_w is not None and (current_w is None or best_w.damage_bonus > current_w.damage_bonus):
        return best_w
    current_a = next((i for i in char.inventory if i.id == char.equipped_armor), None)
    best_a = max(
        (
            i for i in char.inventory
            if i.item_type != ItemType.weapon
            and (i.item_type == ItemType.shield or i.ac_bonus > 0)
        ),
        key=lambda i: i.ac_bonus, default=None,
    )
    if best_a is not None and (current_a is None or best_a.ac_bonus > current_a.ac_bonus):
        return best_a
    return None


def equip(world: SandboxWorld, agent: SandboxAgent, item_ref: str) -> list[EngineEvent]:
    item = find_inventory_item(agent, item_ref)
    if item is None:
        return fail(world, agent, "equip", f"no '{item_ref}' in your pack")

    char = agent.character
    if item.id in (char.equipped_weapon, char.equipped_armor):
        # Same-name duplicates exist (sites share prefab templates): prefer
        # an unequipped copy of the ref before declaring a no-op.
        alt = resolve_item_ref(
            [
                i for i in char.inventory
                if i is not item
                and i.id not in (char.equipped_weapon, char.equipped_armor)
            ],
            item_ref,
        )
        if alt is None:
            return fail(world, agent, "equip", f"{item.name} is already equipped")
        item = alt
    if item.item_type == ItemType.weapon:
        char.equipped_weapon = item.id
        slot = "weapon"
    elif item.item_type == ItemType.shield or item.ac_bonus > 0:
        char.equipped_armor = item.id
        slot = "armor"
    else:
        return fail(world, agent, "equip", f"{item.name} cannot be equipped")

    return [
        _ev(
            EngineEventType.item_used, world,
            {"character_id": agent.agent_id, "item": item.name, "slot": slot},
            f"{agent.name} equips {item.name}.", agent,
        )
    ]


def use_inventory_item(world: SandboxWorld, agent: SandboxAgent, item_name: str) -> list[EngineEvent]:
    item = find_inventory_item(agent, item_name or "")
    if item is None:
        return fail(world, agent, "use_item", f"no '{item_name}' in your pack")
    if item.item_type == ItemType.potion and agent.character.hp >= agent.character.max_hp:
        return fail(world, agent, "use_item", "you are already at full health — save it")
    events = resolve_use_item(agent.character, item.name, world.tick)
    for ev in events:
        ev.actor = agent.agent_id
        ev.location = agent.loc_key
    return events


def wait(world: SandboxWorld, agent: SandboxAgent) -> list[EngineEvent]:
    return [
        _ev(
            EngineEventType.wait, world,
            {"character_id": agent.agent_id},
            f"{agent.name} waits, watching for movement.", agent,
        )
    ]


def gear_score(agent: SandboxAgent) -> int:
    """The timeout tiebreak: weapon tiers + armor tiers + half-value potions."""
    score = 0
    for item in agent.character.inventory:
        if item.item_type == ItemType.weapon:
            score += 2 * item.damage_bonus
        elif item.ac_bonus > 0:
            score += 2 * item.ac_bonus
        elif item.item_type == ItemType.potion:
            score += 1
    return score

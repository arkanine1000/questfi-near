"""The zero-LLM policy fleet — dispositional scripted brains.

One decision core, six parameter tables. These play whole seasons for free:
E2E tests and demo rehearsals run without a token, and ``hosted_brain=llm``
swaps them out per agent without touching the engine.

Policies read the world directly (pathfinding over full site layouts) rather
than parsing observations — they model *competent* play for pacing purposes,
not fair play. House rules are honoured structurally: no rival is ever
attacked on the surface (the truce is not negotiable), and betrayal only
comes from dispositions that hunt.

The boss push guarantees termination: once geared (or the season drags),
pushers converge on the Heart of the Island and hunt the crown.
"""

from __future__ import annotations

from collections import deque

from quest_sim.engine.sandbox.actions import (
    best_upgrade,
    gear_score,
    loot_revealed,
    search_spent,
    search_worthwhile,
)
from quest_sim.engine.sandbox.rng import sub_rng
from quest_sim.models.character import ItemType
from quest_sim.models.map import DIRECTION_OFFSETS
from quest_sim.models.overworld import (
    HEX_DIRECTIONS,
    hex_distance,
    hex_key,
    parse_hex_key,
)
from quest_sim.models.sandbox import DungeonSite, SandboxAgent, SandboxWorld

# potion_at / flee_at are HP fractions. boss_push marks the dispositions that
# race for the crown; gear_at is the gear score that flips them to pushing.
POLICY_PARAMS: dict[str, dict] = {
    "greedy": dict(potion_at=0.45, flee_at=0.25, enters_occupied=True,
                   hunts=False, hunts_weak=False, camps=False,
                   boss_push=True, gear_at=14),
    "cautious": dict(potion_at=0.65, flee_at=0.50, enters_occupied=False,
                     hunts=False, hunts_weak=False, camps=False,
                     boss_push=False, gear_at=99),
    "aggressive": dict(potion_at=0.35, flee_at=0.0, enters_occupied=True,
                       hunts=True, hunts_weak=True, camps=False,
                       boss_push=True, gear_at=10),
    "turtle": dict(potion_at=0.70, flee_at=0.55, enters_occupied=False,
                   hunts=False, hunts_weak=False, camps=True,
                   boss_push=False, gear_at=99),
    "opportunist": dict(potion_at=0.50, flee_at=0.35, enters_occupied=True,
                        hunts=False, hunts_weak=True, camps=False,
                        boss_push=True, gear_at=12),
    "balanced": dict(potion_at=0.50, flee_at=0.30, enters_occupied=True,
                     hunts=False, hunts_weak=False, camps=False,
                     boss_push=True, gear_at=12),
}


# ---------------------------------------------------------------------------
# Pathfinding: first-step BFS on both layers
# ---------------------------------------------------------------------------


def bfs_step_rooms(site: DungeonSite, start_key: str, goals: set[str]) -> str | None:
    """First move direction (N/S/E/W) toward the nearest goal room."""
    if not goals or start_key in goals:
        return None
    start = site.map_grid.rooms.get(start_key)
    if start is None:
        return None
    seen = {start_key}
    queue: deque[tuple[str, str]] = deque()
    for d, connected in start.connections.items():
        if not connected:
            continue
        dr, dc = DIRECTION_OFFSETS[d]
        nk = f"{start.row + dr},{start.col + dc}"
        if nk in site.map_grid.rooms:
            seen.add(nk)
            queue.append((nk, d.value))
    while queue:
        key, first = queue.popleft()
        if key in goals:
            return first
        room = site.map_grid.rooms.get(key)
        if room is None:
            continue
        for d, connected in room.connections.items():
            if not connected:
                continue
            dr, dc = DIRECTION_OFFSETS[d]
            nk = f"{room.row + dr},{room.col + dc}"
            if nk not in seen and nk in site.map_grid.rooms:
                seen.add(nk)
                queue.append((nk, first))
    return None


def bfs_step_hexes(world: SandboxWorld, start_key: str, goal_key: str) -> str | None:
    """First travel direction toward a hex across the island."""
    if start_key == goal_key:
        return None
    sq, sr = parse_hex_key(start_key)
    seen = {start_key}
    queue: deque[tuple[str, str]] = deque()
    for name, (dq, dr) in HEX_DIRECTIONS.items():
        nk = hex_key(sq + dq, sr + dr)
        if world.overworld.get_key(nk) is not None:
            seen.add(nk)
            queue.append((nk, name))
    while queue:
        key, first = queue.popleft()
        if key == goal_key:
            return first
        q, r = parse_hex_key(key)
        for name, (dq, dr) in HEX_DIRECTIONS.items():
            nk = hex_key(q + dq, r + dr)
            if nk not in seen and world.overworld.get_key(nk) is not None:
                seen.add(nk)
                queue.append((nk, first))
    return None


# ---------------------------------------------------------------------------
# Decision helpers
# ---------------------------------------------------------------------------


def _hp_frac(agent: SandboxAgent) -> float:
    char = agent.character
    return char.hp / char.max_hp if char.max_hp else 0.0


def _potion_name(agent: SandboxAgent) -> str | None:
    for item in agent.character.inventory:
        if item.item_type == ItemType.potion and item.heal_amount > 0:
            return item.name
    return None


def _best_unequipped(agent: SandboxAgent) -> str | None:
    """A strictly better weapon or armor piece waiting in the pack —
    delegated to the shared engine helper so policy and valid_actions can
    never disagree about what counts as an upgrade."""
    upgrade = best_upgrade(agent)
    return upgrade.name if upgrade else None


def _room_of(world: SandboxWorld, agent: SandboxAgent):
    site = world.get_site(agent.position.site_id)
    if site is None or not agent.position.room:
        return None, None
    r, c = (int(x) for x in agent.position.room.split(","))
    return site, site.map_grid.get_room(r, c)


def _living_mobs(site: DungeonSite, room) -> list:
    if room is None:
        return []
    return [
        site.entities[eid] for eid in room.entity_ids
        if eid in site.entities and site.entities[eid].is_alive
    ]


def _pushing_boss(world: SandboxWorld, agent: SandboxAgent, params: dict) -> bool:
    """Geared enough (or the season is dragging) → race for the crown."""
    if not params["boss_push"]:
        # Even the reluctant push once the bell looms — someone must end it.
        return world.tick >= int(world.config.max_ticks * 0.75)
    if world.tick >= world.config.max_ticks // 2:
        return True
    return gear_score(agent) >= params["gear_at"]


def _combat_decision(world: SandboxWorld, agent: SandboxAgent, params: dict) -> dict:
    frac = _hp_frac(agent)
    potion = _potion_name(agent)
    if potion and frac < params["potion_at"]:
        return {"action": "use_item", "item": potion}
    if frac < params["flee_at"]:
        room_dir = None
        site, room = _room_of(world, agent)
        if room is not None:
            # prefer the way we came, else any open passage
            if agent.last_room is not None:
                for d, connected in room.connections.items():
                    dr, dc = DIRECTION_OFFSETS[d]
                    if connected and f"{room.row + dr},{room.col + dc}" == agent.last_room:
                        room_dir = d.value
                        break
            if room_dir is None:
                room_dir = next(
                    (d.value for d, on in room.connections.items() if on), None
                )
        return {"action": "flee", "direction": room_dir or "N"}

    sc = world.combats.get(agent.loc_key)
    site, room = _room_of(world, agent)
    mobs = _living_mobs(site, room) if site else []
    rivals = [
        world.agents[cid]
        for cid in (sc.combat.combatant_ids if sc else [])
        if cid in world.agents and cid != agent.agent_id and world.agents[cid].is_alive
    ]
    # Betrayal comes only from the hunting dispositions, only in dungeons.
    if params["hunts_weak"] and rivals and agent.position.kind == "dungeon":
        weakest = min(rivals, key=lambda a: a.character.hp)
        if weakest.character.hp <= agent.character.hp or params["hunts"]:
            return {"action": "attack", "target": weakest.name}
    if mobs:
        return {"action": "attack", "target": mobs[0].name}
    hostile = [
        r for r in rivals if sc is not None and sc.is_hostile(agent.agent_id, r.agent_id)
    ]
    if hostile:
        return {"action": "attack", "target": hostile[0].name}
    return {"action": "dodge"}


def _dungeon_decision(world: SandboxWorld, agent: SandboxAgent, params: dict) -> dict:
    site, room = _room_of(world, agent)
    if site is None or room is None:
        return {"action": "wait"}
    room_key = agent.position.room

    frac = _hp_frac(agent)
    potion = _potion_name(agent)
    if potion and frac < params["potion_at"]:
        return {"action": "use_item", "item": potion}

    upgrade = _best_unequipped(agent)
    if upgrade:
        return {"action": "equip", "item": upgrade}

    mobs = _living_mobs(site, room)
    rivals = [a for a in world.agents_at(agent.loc_key) if a.agent_id != agent.agent_id]
    if params["hunts_weak"] and rivals:
        weakest = min(rivals, key=lambda a: a.character.hp)
        if weakest.character.hp < agent.character.hp:
            return {"action": "attack", "target": weakest.name}
    if mobs:
        if frac < params["flee_at"] and room_key in site.entrances:
            return {"action": "exit"}
        return {"action": "attack", "target": mobs[0].name}

    # Loot the ground we stand on.
    visible_loot = room.treasure_item_ids and loot_revealed(room)
    if visible_loot:
        return {"action": "pick_up"}
    if search_worthwhile(agent, room, site.site_id, room_key):
        return {"action": "search"}

    # The crown: inside the boss site, hunt the boss chamber.
    if (
        site.site_id == world.boss_site_id
        and site.boss_id is not None
        and site.boss_id in site.entities
        and site.entities[site.boss_id].is_alive
    ):
        boss = site.entities[site.boss_id]
        boss_room = f"{boss.position[0]},{boss.position[1]}"
        step = bfs_step_rooms(site, room_key, {boss_room})
        if step:
            return {"action": "move", "direction": step}

    # Route to the nearest room this agent hasn't seen or searched.
    # Both halves must be PER-AGENT or this never terminates: pair a per-agent
    # search attempt with a global "searched" here and a brain that fails a
    # roll refuses to re-search, still sees the room as unfinished, and walks
    # out and back in forever. `seen` and `search_spent` both shrink this set
    # monotonically for a given agent, which is the termination argument.
    seen = agent.visited.get(site.site_id, set())
    unfinished = {
        key for key, rm in site.map_grid.rooms.items()
        if key not in seen or search_worthwhile(agent, rm, site.site_id, key)
    }
    unfinished.discard(room_key)
    step = bfs_step_rooms(site, room_key, unfinished)
    if step:
        return {"action": "move", "direction": step}

    # Site exhausted: campers hold the door, everyone else moves on.
    if params["camps"] and room_key in site.entrances and not _pushing_boss(world, agent, params):
        return {"action": "wait"}
    if room_key in site.entrances:
        return {"action": "exit"}
    step = bfs_step_rooms(site, room_key, set(site.entrances))
    return {"action": "move", "direction": step or "N"}


def _site_worthwhile(world: SandboxWorld, agent: SandboxAgent, site: DungeonSite) -> bool:
    seen = agent.visited.get(site.site_id, set())
    if len(seen) < len(site.map_grid.rooms):
        return True
    # Same per-agent requirement as `unfinished` above, for the same reason —
    # at site scale it would be leave-and-re-enter forever instead.
    return any(
        search_worthwhile(agent, rm, site.site_id, key)
        or (rm.treasure_item_ids and loot_revealed(rm))
        for key, rm in site.map_grid.rooms.items()
    )


def _pick_target_site(
    world: SandboxWorld, agent: SandboxAgent, params: dict
) -> DungeonSite | None:
    """Nearest worthwhile POI mouth (the boss site is the push's business)."""
    my_hex = agent.position.hex or world.center_hex
    best, best_dist = None, None
    for site in world.sites.values():
        if site.site_id == world.boss_site_id:
            continue
        if not _site_worthwhile(world, agent, site):
            continue
        if not params["enters_occupied"]:
            occupied = any(
                a.position.kind == "dungeon" and a.position.site_id == site.site_id
                for a in world.living_agents() if a.agent_id != agent.agent_id
            )
            if occupied:
                continue
        for target_hex in site.entrances.values():
            aq, ar = parse_hex_key(my_hex)
            tq, tr = parse_hex_key(target_hex)
            dist = hex_distance(aq, ar, tq, tr)
            if best_dist is None or dist < best_dist:
                best, best_dist = site, dist
    return best


def _surface_decision(world: SandboxWorld, agent: SandboxAgent, params: dict) -> dict:
    my_hex = agent.position.hex or world.center_hex

    frac = _hp_frac(agent)
    potion = _potion_name(agent)
    if potion and frac < params["potion_at"]:
        return {"action": "use_item", "item": potion}

    upgrade = _best_unequipped(agent)
    if upgrade:
        return {"action": "equip", "item": upgrade}

    # Loot underfoot (a fallen rival's field drop).
    tile = world.overworld.get_key(my_hex)
    if tile is not None and tile.ground_items:
        return {"action": "pick_up"}

    pushing = _pushing_boss(world, agent, params)

    # Standing on a worthwhile mouth → descend (the boss mouth only when pushing).
    if tile is not None and tile.site_id:
        site = world.get_site(tile.site_id)
        if site is not None:
            if site.site_id == world.boss_site_id:
                if pushing and frac > 0.5:
                    return {"action": "enter"}
            elif _site_worthwhile(world, agent, site):
                return {"action": "enter"}

    # The crown: pushers march on the center.
    if pushing and frac > 0.5:
        step = bfs_step_hexes(world, my_hex, world.center_hex)
        if step:
            return {"action": "travel", "direction": step}
        if my_hex == world.center_hex:
            return {"action": "enter"}

    # Otherwise: nearest worthwhile dungeon.
    target = _pick_target_site(world, agent, params)
    if target is not None:
        goal = min(
            target.entrances.values(),
            key=lambda hk: _hex_distance_between(my_hex, hk),
            default=None,
        )
        if goal == my_hex:
            return {"action": "enter"}
        if goal is not None:
            step = bfs_step_hexes(world, my_hex, goal)
            if step:
                return {"action": "travel", "direction": step}

    # Nothing left out here: drift toward the center and hold.
    step = bfs_step_hexes(world, my_hex, world.center_hex)
    if step:
        return {"action": "travel", "direction": step}
    return {"action": "wait"}


def _hex_distance_between(a: str, b: str) -> int:
    aq, ar = parse_hex_key(a)
    bq, br = parse_hex_key(b)
    return hex_distance(aq, ar, bq, br)


# ---------------------------------------------------------------------------
# Flavor: the fleet's inner monologue
# ---------------------------------------------------------------------------

# Terse, dispositional, deterministic — the zero-LLM fleet narrates its
# seasons so follow-mode thought traces stay alive without spending a token.
# LLM personas replace these wholesale under hosted_brain="llm".
_FLAVOR: dict[str, dict[str, list[str]]] = {
    "attack": {
        "aggressive": ["{target}. No speeches.", "{target} dies first, then we talk."],
        "cautious": ["No way around {target}. Quick and clean, then."],
        "opportunist": ["{target} is already bleeding. Rude not to finish it."],
        "*": ["{target} stands between me and the shelves.", "Steel first. Questions never."],
    },
    "use_item": {
        "*": ["Drinking now — dying proud is still dying.", "Potion. The math demanded it."],
    },
    "flee": {
        "turtle": ["This is not my fight. Out."],
        "*": ["Not like this. OUT.", "Living cowards loot dead heroes."],
    },
    "enter": {
        "greedy": ["Down into {site}. Everything not nailed down is mine."],
        "cautious": ["Down into {site}. Slow steps, open eyes."],
        "*": ["Down into {site}. Let's see what's left.", "{site}. Someone's been here — good, they softened it."],
    },
    "exit": {
        "*": ["Back to the sky. This hole is spent.", "Done here. The island keeps its secrets."],
    },
    "search": {
        "*": ["Every shelf, every corpse-pocket.", "If it glitters under the dust, it's mine."],
    },
    "pick_up": {
        "*": ["Mine now.", "The dead travel light. I don't."],
    },
    "wait": {
        "turtle": ["Let them come to me. They always do.", "Patience is armor."],
        "*": ["Hold. Watch. Breathe."],
    },
    "travel": {
        "aggressive": ["Somewhere out there someone thinks they're winning."],
        "greedy": ["Next hoard. Legs, do your work."],
        "cautious": ["Keep the strangers far and the exits close."],
        "opportunist": ["Follow the noise. Arrive late. Collect."],
        "turtle": ["New ground, same plan: outlast."],
        "*": ["One hex at a time.", "The center pulls at everyone. Even me."],
    },
}


def policy_thought(world: SandboxWorld, agent: SandboxAgent, action: dict) -> str | None:
    """A short in-character line for a fleet decision, or None (no spam)."""
    kind = str(action.get("action") or "")
    rng = sub_rng(world.seed, world.tick, agent.agent_id, "flavor")

    if kind == "travel" and rng.random() > 0.22:
        return None  # most steps pass in silence
    if kind in ("search", "pick_up") and rng.random() > 0.5:
        return None
    if kind == "wait" and rng.random() > 0.35:
        return None
    if kind in ("move", "dodge", "equip"):
        return None

    pools = _FLAVOR.get(kind)
    if not pools:
        return None
    pool = pools.get(agent.disposition) or pools["*"]
    line = rng.choice(pool)

    site_name = ""
    if kind == "enter" and agent.position.hex:
        tile = world.overworld.get_key(agent.position.hex)
        site = world.get_site(tile.site_id) if tile else None
        site_name = site.name if site else "the dark"
    return line.format(target=action.get("target") or "the nearest threat", site=site_name)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def policy_decide(world: SandboxWorld, agent_id: str) -> dict:
    """The fleet brain: reads the agent's disposition off the roster.
    Returns an action dict, with a flavor thought attached when one lands."""
    agent = world.get_agent(agent_id)
    if agent is None or not agent.is_alive:
        return {"action": "wait"}
    params = POLICY_PARAMS.get(agent.disposition, POLICY_PARAMS["balanced"])

    sc = world.combats.get(agent.loc_key)
    if (
        sc is not None
        and sc.combat.active
        and agent.agent_id in sc.combat.combatant_ids
        and agent.agent_id not in sc.combat.fled_ids
    ):
        action = _combat_decision(world, agent, params)
    elif agent.position.kind == "dungeon":
        action = _dungeon_decision(world, agent, params)
    else:
        action = _surface_decision(world, agent, params)

    thought = policy_thought(world, agent, action)
    if thought:
        action = {**action, "thought": thought}
    return action

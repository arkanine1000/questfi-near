"""What agents and spectators see.

``build_observation`` is the single source of agent-facing truth: the hosted
LLM prompt and the BYO JSON payload both render from it, so an external brain
never knows more or less than a hosted one. Self stats are exact; RIVALS are
worded (``hp_band``) — drama over spreadsheets. Dungeon knowledge is
per-agent (``agent.visited``), never the shared room flags.

Spectator serializers are omniscient: ``site_map_view`` speaks the solo
``get_full_map`` dialect (the FE dungeon adapter's ground truth) extended
with a ``players`` list per room; ``island_map_view`` is the static overworld
sheet the FE fetches once per world.
"""

from __future__ import annotations

from quest_sim.engine.sandbox.actions import (
    best_upgrade,
    gear_score,
    has_searched,
    loot_revealed,
    search_spent,
    search_worthwhile,
    visible_floor_items,
)
from quest_sim.engine.character import effective_ac
from quest_sim.models.character import Character
from quest_sim.models.events import EngineEventType
from quest_sim.models.map import Room
from quest_sim.models.overworld import (
    HEX_DIRECTIONS,
    hex_distance,
    hex_neighbors,
    parse_hex_key,
)
from quest_sim.models.sandbox import DungeonSite, SandboxAgent, SandboxWorld, WorldPhase

BOSS_OBJECTIVE = (
    "Reach the island's center and slay the boss of the Heart of the Island "
    "for instant victory — or outlive everyone else. Dungeons hold the gear "
    "you'll need to survive it."
)


def _bearing(q: int, r: int, tq: int, tr: int, overworld=None) -> str | None:
    """The hex direction that closes the most distance toward the target.

    With an overworld given, only directions whose destination tile EXISTS
    qualify — a compass pointing into open sea costs its follower a wasted
    turn (agents obeyed it straight into 'travel failed: open sea'). In a
    coastal pocket the best legal step may hold distance rather than close
    it; that's still better advice than the water."""
    if (q, r) == (tq, tr):
        return None
    best_dir, best_dist = None, None
    for name, (dq, dr) in HEX_DIRECTIONS.items():
        if overworld is not None and overworld.get(q + dq, r + dr) is None:
            continue
        d = hex_distance(q + dq, r + dr, tq, tr)
        if best_dist is None or d < best_dist:
            best_dir, best_dist = name, d
    return best_dir


def _boss_readiness(world: SandboxWorld, agent: SandboxAgent, score: int) -> str:
    """An engine-computed verdict on braving the Heart. The standing 'the
    boss is deadly' warning needs a counterweight: a myopic per-tick
    reasoner with a 10-turn window re-reads the fear every tick, never
    accumulates confidence, and waits forever. The engine knows the real
    odds (gear bands calibrated to the policy fleet's boss-push
    thresholds) — and knows when waiting is the WORSE bet."""
    hp_frac = agent.character.hp / max(agent.character.max_hp, 1)
    if score >= 10:
        # Gear alone decides this verdict. It used to demote READY when the
        # agent was hurt, and agents read the demotion as "not ready yet" and
        # went back to stockpiling instead of healing. Health is a detail of
        # the push, not a precondition for it.
        verdict = (
            "READY — challengers with your gear slay the Heart. Stop "
            "stockpiling; go claim the crown"
        )
        if hp_frac < 0.6:
            verdict += " (heal on the way in if you can)"
    elif score >= 6:
        verdict = "close — one more weapon or relic and the Heart is winnable"
    else:
        verdict = "under-geared — the Heart would eat you; loot the outer dungeons"

    if world.tick >= (world.config.max_ticks * 3) // 4:
        living = sorted(
            world.living_agents(),
            key=lambda a: (-a.kills, -gear_score(a), -a.character.hp, a.name),
        )
        if not living or living[0].agent_id == agent.agent_id:
            verdict += (
                ". The bell currently favors you — but any rival's crown run "
                "beats your wait; consider guarding the Heart"
            )
        elif score >= 6 or hp_frac >= 0.5:
            # desperation only when it's actually the better bet: they can
            # at least swing a sword at the boss
            verdict += (
                ". THE BELL LOSES YOU THE CROWN as things stand — waiting is "
                "a guaranteed loss, the Heart is a chance. Desperation is a "
                "strategy"
            )
        else:
            verdict += (
                ". THE BELL LOSES YOU THE CROWN as things stand, and the "
                "Heart would end you in a few rounds — kills outrank gear in "
                "the tiebreak; hunting a leader beats a quiet loss"
            )
    return verdict


def _objective_view(world: SandboxWorld, agent: SandboxAgent) -> dict:
    """The win condition plus where it lives — every agent knows the way to
    the Heart from tick 0. Aimless wandering is a protocol failure, not fog."""
    boss_site = world.get_site(world.boss_site_id) if world.boss_site_id else None
    score = gear_score(agent)
    out: dict = {
        "text": BOSS_OBJECTIVE,
        "boss_site": boss_site.name if boss_site else None,
        "center_hex": world.center_hex or None,
        "your_gear_score": score,
        "boss_readiness": _boss_readiness(world, agent, score),
    }
    if (
        world.center_hex
        and agent.position.kind == "overworld"
        and agent.position.hex
    ):
        q, r = parse_hex_key(agent.position.hex)
        tq, tr = parse_hex_key(world.center_hex)
        out["distance_hexes"] = hex_distance(q, r, tq, tr)
        out["bearing"] = _bearing(q, r, tq, tr, overworld=world.overworld)
    return out


def hp_band(char: Character) -> str:
    """Worded health for rivals — drama over spreadsheets."""
    frac = char.hp / char.max_hp if char.max_hp else 0
    if frac > 0.75:
        return "hale"
    if frac > 0.4:
        return "wounded"
    if frac > 0.15:
        return "badly wounded"
    return "near death"


def weapon_name(char: Character) -> str:
    item = next((i for i in char.inventory if i.id == char.equipped_weapon), None)
    return item.name if item else "bare hands"


def _item_label(item) -> str:
    bits = []
    if item.damage_bonus:
        bits.append(f"+{item.damage_bonus} atk")
    if item.ac_bonus:
        bits.append(f"+{item.ac_bonus} AC")
    if getattr(item, "heal_amount", 0):
        bits.append(f"heals {item.heal_amount} hp")
    return f"{item.name} ({', '.join(bits)})" if bits else item.name


def _rival_view(world: SandboxWorld, me: SandboxAgent, rival: SandboxAgent) -> dict:
    sc = world.combats.get(me.loc_key)
    return {
        "name": rival.name,
        "color": rival.color,
        "hp_band": hp_band(rival.character),
        "weapon": weapon_name(rival.character),
        "kills": rival.kills,
        "in_combat_with_you": bool(
            sc is not None
            and sc.combat.active
            and rival.agent_id in sc.combat.combatant_ids
            and me.agent_id in sc.combat.combatant_ids
            and sc.is_hostile(me.agent_id, rival.agent_id)
        ),
    }


def _mob_views(world: SandboxWorld, site: DungeonSite, room: Room) -> list[dict]:
    mobs = []
    for eid in room.entity_ids:
        mob = site.entities.get(eid)
        if mob is not None and mob.is_alive:
            mobs.append({
                "id": eid,
                "name": mob.name,
                "hp": mob.hp,
                "max_hp": mob.max_hp,
            })
    return mobs


def _agent_room(world: SandboxWorld, agent: SandboxAgent) -> tuple[DungeonSite | None, Room | None]:
    if agent.position.kind != "dungeon":
        return None, None
    site = world.get_site(agent.position.site_id)
    if site is None or not agent.position.room:
        return None, None
    r, c = (int(x) for x in agent.position.room.split(","))
    return site, site.map_grid.get_room(r, c)


def _fogged_site_map(world: SandboxWorld, agent: SandboxAgent, site: DungeonSite) -> dict:
    """The agent's private knowledge of this interior — solo fog dialect:
    visited rooms full, their unvisited neighbours type-only, rest hidden."""
    seen = agent.visited.get(site.site_id, set())
    rooms: dict[str, dict] = {}
    partial: set[str] = set()
    for key in seen:
        room = site.map_grid.rooms.get(key)
        if room is None:
            continue
        rooms[key] = {
            "row": room.row,
            "col": room.col,
            "room_type": room.room_type.value,
            "visited": True,
            "connections": {d.value: v for d, v in room.connections.items()},
            "entities": [
                {"id": m["id"], "name": m["name"], "type": "hostile"}
                for m in _mob_views(world, site, room)
            ],
            "has_items": bool(room.treasure_item_ids and loot_revealed(room)),
            # Per-agent: this is the agent's PRIVATE map. The global flag here
            # would quietly tell you a rival had worked this room.
            "searched": has_searched(agent, site.site_id, key),
        }
        r, c = room.row, room.col
        from quest_sim.models.map import DIRECTION_OFFSETS  # local: avoid cycle at import time

        for d, open_ in room.connections.items():
            if not open_:
                continue
            dr, dc = DIRECTION_OFFSETS[d]
            nkey = f"{r + dr},{c + dc}"
            if nkey not in seen and nkey in site.map_grid.rooms:
                partial.add(nkey)
    for key in partial:
        room = site.map_grid.rooms[key]
        rooms[key] = {
            "row": room.row,
            "col": room.col,
            "room_type": room.room_type.value,
            "visited": False,
            "fog": "partial",
        }
    if agent.position.room in rooms:
        rooms[agent.position.room]["player_here"] = True
    return {
        "site_id": site.site_id,
        "site_name": site.name,
        "grid_rows": site.map_grid.rows,
        "grid_cols": site.map_grid.cols,
        "rooms": rooms,
    }


def _nearest_unvisited_site(world: SandboxWorld, agent: SandboxAgent) -> dict | None:
    """The gear compass: the closest OUTER dungeon this agent has never set
    foot in — name, mouth hex, distance, bearing. Deliberately singular: the
    Heart's coordinates gave the crown a magnetic pull while "find gear
    first" pointed nowhere, so cautious agents orbited the boss mouth
    flip-flopping between the two instincts. One concrete alternative
    destination breaks the orbit; a full site list would leak the world."""
    if agent.position.kind != "overworld" or not agent.position.hex:
        return None
    q, r = parse_hex_key(agent.position.hex)
    best: tuple | None = None
    for site in world.sites.values():
        if site.site_id == world.boss_site_id:
            continue
        if agent.visited.get(site.site_id):
            continue  # already been inside
        for hex_key in set(site.entrances.values()):
            tq, tr = parse_hex_key(hex_key)
            d = hex_distance(q, r, tq, tr)
            if best is None or d < best[0]:
                best = (d, site.name, hex_key, tq, tr)
    if best is None:
        return None
    d, name, hex_key, tq, tr = best
    return {
        "name": name,
        "hex": hex_key,
        "distance_hexes": d,
        "bearing": _bearing(q, r, tq, tr, overworld=world.overworld),
    }


def _surface_location(world: SandboxWorld, agent: SandboxAgent) -> dict:
    tile = world.overworld.get_key(agent.position.hex or "")
    q, r = parse_hex_key(agent.position.hex or "0,0")
    center = parse_hex_key(world.center_hex) if world.center_hex else None
    neighbours = []
    # Iterate named directions (not raw offsets) so every neighbour carries
    # the exact `travel` argument that reaches it — agents were bouncing
    # between hexes trying to reverse-engineer the axial convention.
    for direction, (dq, dr) in HEX_DIRECTIONS.items():
        nq, nr = q + dq, r + dr
        nt = world.overworld.get(nq, nr)
        if nt is None:
            continue
        rivals = [
            world.agents[aid].name
            for aid in nt.occupants
            if aid in world.agents and world.agents[aid].is_alive
        ]
        entry: dict = {"direction": direction, "hex": nt.key, "terrain": nt.terrain.value}
        if center is not None:
            entry["heart_distance"] = hex_distance(nq, nr, *center)
        if nt.site_id:
            site = world.get_site(nt.site_id)
            entry["site"] = site.name if site else nt.site_id
        if rivals:
            entry["rivals"] = rivals
        neighbours.append(entry)
    out: dict = {
        "kind": "overworld",
        "hex": agent.position.hex,
        "terrain": tile.terrain.value if tile else "plain",
        "neighbours": neighbours,
        "nearest_unexplored_site": _nearest_unvisited_site(world, agent),
        "ground_items": [_item_label(i) for i in (tile.ground_items if tile else [])],
    }
    if tile and tile.site_id:
        site = world.get_site(tile.site_id)
        out["site_here"] = {
            "site_id": tile.site_id,
            "name": site.name if site else tile.site_id,
            "is_boss_site": tile.site_id == world.boss_site_id,
        }
    return out


def _nearest_unexplored(site: DungeonSite, room, seen: set[str]) -> dict | None:
    """BFS over open connections to the closest room this agent has NOT
    visited: first-step direction + distance. None = every reachable room
    seen. The anti-amnesia compass — without it, LLM brains re-walk shiny
    'treasure_room' labels forever instead of pushing into the dark."""
    from collections import deque

    from quest_sim.models.map import DIRECTION_OFFSETS

    start_key = f"{room.row},{room.col}"
    queue = deque([(start_key, None, 0)])
    reached = {start_key}
    while queue:
        key, first_dir, dist = queue.popleft()
        if dist > 0 and key not in seen:
            return {"direction": first_dir, "distance": dist}
        cur = site.map_grid.rooms[key]
        for d, open_ in cur.connections.items():
            if not open_:
                continue
            dr, dc = DIRECTION_OFFSETS[d]
            nkey = f"{cur.row + dr},{cur.col + dc}"
            if nkey in reached or nkey not in site.map_grid.rooms:
                continue
            reached.add(nkey)
            queue.append((nkey, first_dir or d.value, dist + 1))
    return None


def _nearest_exit(site: DungeonSite, room) -> dict | None:
    """BFS to the closest entrance room: the way OUT as first step +
    distance. Agents announced 'time to leave' for a dozen ticks while
    failing to derive the route from a fogged grid — the exit gets a
    compass like everything else."""
    from collections import deque

    from quest_sim.models.map import DIRECTION_OFFSETS

    start_key = f"{room.row},{room.col}"
    if start_key in site.entrances:
        return {"direction": None, "distance": 0}
    queue = deque([(start_key, None, 0)])
    reached = {start_key}
    while queue:
        key, first_dir, dist = queue.popleft()
        if dist > 0 and key in site.entrances:
            return {"direction": first_dir, "distance": dist}
        cur = site.map_grid.rooms[key]
        for d, open_ in cur.connections.items():
            if not open_:
                continue
            dr, dc = DIRECTION_OFFSETS[d]
            nkey = f"{cur.row + dr},{cur.col + dc}"
            if nkey in reached or nkey not in site.map_grid.rooms:
                continue
            reached.add(nkey)
            queue.append((nkey, first_dir or d.value, dist + 1))
    return None


def _dungeon_location(world: SandboxWorld, agent: SandboxAgent) -> dict:
    site, room = _agent_room(world, agent)
    assert site is not None and room is not None
    exits = {}
    from quest_sim.models.map import DIRECTION_OFFSETS

    seen = agent.visited.get(site.site_id, set())
    for d, open_ in room.connections.items():
        if not open_:
            continue
        dr, dc = DIRECTION_OFFSETS[d]
        nkey = f"{room.row + dr},{room.col + dc}"
        nroom = site.map_grid.rooms.get(nkey)
        if nroom is None:
            continue
        exits[d.value] = {
            "room_type": nroom.room_type.value,
            "visited": nkey in seen,
        }
    return {
        "kind": "dungeon",
        "site_id": site.site_id,
        "site_name": site.name,
        "is_boss_site": site.site_id == world.boss_site_id,
        "room": agent.position.room,
        "room_type": room.room_type.value,
        "description": room.description,
        # "have I searched here", not "has anyone" — this is the agent's own
        # readout, and it feeds the hosted brain's prompt.
        "searched": has_searched(agent, site.site_id, agent.position.room),
        "at_entrance": (agent.position.room or "") in site.entrances,
        "exits": exits,
        "nearest_unexplored": (nearest := _nearest_unexplored(site, room, seen)),
        "site_explored": nearest is None,
        "nearest_exit": _nearest_exit(site, room),
        "mobs": _mob_views(world, site, room),
        "ground_items": [_item_label(i) for i in visible_floor_items(world, agent)],
    }


def _combat_view(world: SandboxWorld, agent: SandboxAgent) -> dict | None:
    sc = world.combats.get(agent.loc_key)
    if sc is None or not sc.combat.active:
        return None
    if agent.agent_id not in sc.combat.combatant_ids:
        return None
    combatants = []
    for entry in sc.combat.initiative_order:
        cid = entry.character_id
        if cid in sc.combat.fled_ids or cid not in sc.combat.combatant_ids:
            continue
        rival = world.get_agent(cid)
        if rival is not None:
            if not rival.is_alive:
                continue
            combatants.append({
                "name": rival.name,
                "kind": "you" if cid == agent.agent_id else "agent",
                "hp_band": hp_band(rival.character),
                "hostile_to_you": sc.is_hostile(agent.agent_id, cid),
            })
        else:
            site = world.get_site(sc.loc_key.partition(":")[0])
            mob = site.entities.get(cid) if site else None
            if mob is None or not mob.is_alive:
                continue
            combatants.append({
                "name": mob.name,
                "kind": "mob",
                "hp_band": hp_band(mob),
            })
    return {
        "active": True,
        "round": sc.combat.round_number,
        "combatants": combatants,
    }


def _has_equippable(agent: SandboxAgent) -> bool:
    """A STRICT upgrade is waiting in the pack — same test the policy brain
    uses. Anything looser puts `equip` on the LLM menu every tick once the
    agent carries a spare, and LLM brains loop on menu items forever."""
    return best_upgrade(agent) is not None


def valid_actions(world: SandboxWorld, agent: SandboxAgent) -> list[str]:
    """Context-sensitive action vocabulary — what would NOT fail right now."""
    sc = world.combats.get(agent.loc_key)
    in_combat = (
        sc is not None
        and sc.combat.active
        and agent.agent_id in sc.combat.combatant_ids
        and agent.agent_id not in sc.combat.fled_ids
    )
    has_potion = any(i.heal_amount > 0 for i in agent.character.inventory)

    if in_combat:
        acts = ["attack:target=<name>", "dodge", "flee:direction=<dir>"]
        # dodge earns its slot on the menu now: it is +2+DEX AC until your
        # next turn, not the no-op it was when this list was written.
        if has_potion:
            acts.append("use_item:item=<name>")
        return acts

    if agent.position.kind == "overworld":
        acts = ["travel:direction=<E|W|NE|NW|SE|SW>"]
        tile = world.overworld.get_key(agent.position.hex or "")
        if tile and tile.site_id:
            acts.append("enter")
        if tile and tile.ground_items:
            acts.append("pick_up:item=<name>")
        if has_potion:
            acts.append("use_item:item=<name>")
        if _has_equippable(agent):
            acts.append("equip:item=<name>")
        acts.append("wait")
        return acts

    site, room = _agent_room(world, agent)
    acts = []
    if room is not None:
        open_dirs = [d.value for d, v in room.connections.items() if v]
        if open_dirs:
            acts.append(f"move:direction=<{'|'.join(sorted(open_dirs))}>")
        # Worth a turn only where something is actually hidden — not merely
        # "my attempt is unspent". See search_worthwhile.
        if search_worthwhile(agent, room, site.site_id if site else None,
                             agent.position.room):
            acts.append("search")
        if visible_floor_items(world, agent):
            acts.append("pick_up:item=<name>")
        mobs = _mob_views(world, site, room) if site else []
        rivals = [a for a in world.agents_at(agent.loc_key) if a.agent_id != agent.agent_id]
        if mobs or rivals:
            acts.append("attack:target=<name>")
        if (agent.position.room or "") in (site.entrances if site else {}):
            acts.append("exit")
    if has_potion:
        acts.append("use_item:item=<name>")
    if _has_equippable(agent):
        acts.append("equip:item=<name>")
    acts.append("wait")
    return acts


# Where each event type names the one it happened TO. Player characters are
# built with id == agent_id, so these match an agent directly; mob ids are
# namespaced ({site_id}.{orig_id}) and cannot collide with them.
_VICTIM_KEYS: dict[EngineEventType, str] = {
    EngineEventType.attack: "defender_id",
    EngineEventType.damage: "target_id",
    EngineEventType.death: "character_id",
    EngineEventType.agent_death: "agent",
}


def _victim_id(ev) -> str | None:
    key = _VICTIM_KEYS.get(ev.event_type)
    value = ev.data.get(key) if key else None
    return str(value) if value is not None else None


def _presence(world: SandboxWorld, agent: SandboxAgent, tick: int) -> set[str]:
    """Where this agent stood during `tick`.

    The recorded trail when we have it; today's location for the tick still
    in progress; and NOTHING for older ticks we never recorded. That last
    case must not guess — assuming the past looked like the present is what
    handed an agent ten ticks of a room's history the moment it walked in,
    and hid from it every blow struck in a room it had already left.
    """
    recorded = agent.loc_trail.get(str(tick))
    if recorded is not None:
        return set(recorded)
    return {agent.loc_key} if tick >= world.tick else set()


def _agent_can_see(world: SandboxWorld, agent: SandboxAgent, ev) -> bool:
    """Would this agent have known about this event?

    Three ways, and the middle one is the fix: victim-identifying events are
    always stamped to the ATTACKER, so a victim who moved that tick — fleeing,
    usually — matched neither clause and was never told it had been hit. It
    read its own HP dropping and had to guess why.
    """
    if ev.actor == agent.agent_id:
        return True  # my own act, wherever it landed
    if _victim_id(ev) == agent.agent_id:
        return True  # it happened TO me; I always feel it
    return bool(ev.location) and ev.location in _presence(world, agent, ev.tick)


def build_observation(
    world: SandboxWorld,
    agent_id: str,
    last_events: list | None = None,
) -> dict:
    """The one agent-facing view: hosted prompts and BYO JSON render this."""
    agent = world.agents[agent_id]
    char = agent.character

    rivals_here = [
        _rival_view(world, agent, a)
        for a in world.agents_at(agent.loc_key)
        if a.agent_id != agent_id
    ]

    rivals_adjacent: list[dict] = []
    if agent.position.kind == "overworld" and agent.position.hex:
        q, r = parse_hex_key(agent.position.hex)
        for nq, nr in hex_neighbors(q, r):
            tile = world.overworld.get(nq, nr)
            if tile is None:
                continue
            for aid in tile.occupants:
                rival = world.agents.get(aid)
                if rival is not None and rival.is_alive:
                    rivals_adjacent.append({
                        "name": rival.name,
                        "hex": tile.key,
                        "hp_band": hp_band(rival.character),
                    })

    location = (
        _dungeon_location(world, agent)
        if agent.position.kind == "dungeon"
        else _surface_location(world, agent)
    )

    site_map = None
    if agent.position.kind == "dungeon":
        site = world.get_site(agent.position.site_id)
        if site is not None:
            site_map = _fogged_site_map(world, agent, site)

    visible = [ev for ev in (last_events or []) if _agent_can_see(world, agent, ev)]
    filtered_events = []
    for ev in visible:
        entry = {
            "event_type": ev.event_type.value,
            "tick": ev.tick,
            "description": ev.description,
        }
        # Why YOUR action failed, machine-readable. Gated on actor == me,
        # so it tells nobody anything about anybody else.
        if ev.event_type is EngineEventType.action_failed and ev.actor == agent_id:
            entry["code"] = ev.data.get("code")
        filtered_events.append(entry)

    # Sharp edges the agent should not have to infer. The classic death:
    # co-op vs mobs ends, ex-ally swings first, victim never saw it coming.
    warnings: list[str] = []
    if rivals_here and any(
        # THIS tick's truce, not one from any tick still inside the replay
        # window — a stale combat_end re-raised this warning every turn.
        ev.event_type is EngineEventType.combat_end and ev.tick == world.tick
        for ev in visible
    ):
        warnings.append(
            "The shared fight is over and the truce died with it — rivals in "
            "this room can turn on you with fresh initiative next tick. "
            "Leave, or strike first."
        )

    return {
        "world_id": world.world_id,
        "tick": world.tick,
        "phase": world.phase.value,
        "you": {
            "agent_id": agent.agent_id,
            "name": agent.name,
            "color": agent.color,
            "hp": char.hp,
            "max_hp": char.max_hp,
            # effective_ac, not char.ac: worn armour counts. The engine has
            # always rolled against effective_ac (combat_core.resolve_attack),
            # so the bare number told players to plan around an AC they did
            # not have — twice now, a cloak one season and a shield the next.
            "ac": effective_ac(char),
            "kills": agent.kills,
            "mob_kills": agent.mob_kills,
            "alive": agent.is_alive,
            "inventory": [_item_label(i) for i in char.inventory],
            "equipped_weapon": weapon_name(char),
            "position": {
                "kind": agent.position.kind,
                "hex": agent.position.hex,
                "site_id": agent.position.site_id,
                "room": agent.position.room,
            },
        },
        "location": location,
        "rivals_here": rivals_here,
        "rivals_adjacent": rivals_adjacent,
        "combat": _combat_view(world, agent),
        "objective": _objective_view(world, agent),
        "map": site_map,
        "valid_actions": valid_actions(world, agent),
        "last_tick_events": filtered_events,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Spectator serializers (omniscient)
# ---------------------------------------------------------------------------


def site_map_view(world: SandboxWorld, site_id: str) -> dict | None:
    """Full interior in the solo ``get_full_map`` dialect + per-room players."""
    site = world.get_site(site_id)
    if site is None:
        return None

    agents_by_room: dict[str, list[dict]] = {}
    for agent in world.living_agents():
        if agent.position.kind == "dungeon" and agent.position.site_id == site_id:
            agents_by_room.setdefault(agent.position.room or "", []).append({
                "agent_id": agent.agent_id,
                "name": agent.name,
                "color": agent.color,
            })

    rooms: dict[str, dict] = {}
    for key, room in site.map_grid.rooms.items():
        loc_key = f"{site_id}:{key}"
        sc = world.combats.get(loc_key)
        combat = None
        if sc is not None and sc.combat.active:
            active_ids = {
                cid for cid in sc.combat.combatant_ids
                if cid not in sc.combat.fled_ids
            }
            hostile_pairs = [
                [a, b] for a, b in sorted(sc.hostile_pairs)
                if a in active_ids and b in active_ids
                and world.get_agent(a) is not None and world.get_agent(a).is_alive
                and world.get_agent(b) is not None and world.get_agent(b).is_alive
            ]
            combat = {
                "active": True,
                "combatant_ids": sorted(active_ids),
                "hostile_pairs": hostile_pairs,
                "pvp_active": bool(hostile_pairs),
            }
        rooms[key] = {
            "row": room.row,
            "col": room.col,
            "room_type": room.room_type.value,
            "visited": room.visited,
            "connections": {d.value: v for d, v in room.connections.items()},
            "entities": [
                {
                    "id": m["id"],
                    "name": m["name"],
                    "type": "hostile",
                    "hp": m["hp"],
                    "max_hp": m["max_hp"],
                }
                for m in _mob_views(world, site, room)
            ],
            # Spectators are omniscient by design: reveal state, not fog.
            "has_items": bool(room.treasure_item_ids and loot_revealed(room)),
            "players": agents_by_room.get(key, []),
            "is_entrance": key in site.entrances,
            # Spectators need the distinction between implicit co-op and an
            # actual agent-v-agent grudge.  The client uses this to keep the
            # persistent PvP danger vignette honest across reconnects rather
            # than guessing from "two agents share a combat room".
            "combat": combat,
        }

    return {
        "site_id": site.site_id,
        "site_name": site.name,
        "is_boss_site": site.site_id == world.boss_site_id,
        "grid_rows": site.map_grid.rows,
        "grid_cols": site.map_grid.cols,
        "rooms": rooms,
    }


def island_map_view(world: SandboxWorld) -> dict:
    """The static overworld sheet: fetched once per world by the spectator."""
    tiles = {}
    for key, tile in world.overworld.tiles.items():
        entry: dict = {"q": tile.q, "r": tile.r, "terrain": tile.terrain.value}
        if tile.site_id:
            site = world.get_site(tile.site_id)
            entry["site_id"] = tile.site_id
            entry["site_name"] = site.name if site else tile.site_id
            entry["is_boss_site"] = tile.site_id == world.boss_site_id
        tiles[key] = entry
    return {
        "world_id": world.world_id,
        "center_hex": world.center_hex,
        "boss_site_id": world.boss_site_id,
        "spawn_ring": world.spawn_ring,
        "tiles": tiles,
        "sites": {
            sid: {
                "name": s.name,
                "entrances": s.entrances,
                "is_boss_site": sid == world.boss_site_id,
            }
            for sid, s in world.sites.items()
        },
    }


def roster_view(world: SandboxWorld) -> list[dict]:
    """Spectator roster — exact HP (spectators see all), positions, colors.

    ``ready`` appears in the LOBBY only. This same view feeds every SSE
    frame and every line of ticks.jsonl, and it is material for the
    commentator's prompt — a per-agent always-false key does not belong in
    an append-only log forever, or in a token-billed prompt, for a flag
    that stops meaning anything the moment the season starts."""
    in_lobby = world.phase == WorldPhase.lobby
    roster = []
    for agent in world.agents.values():
        char = agent.character
        sc = world.combats.get(agent.loc_key)
        in_combat = bool(
            sc is not None
            and sc.combat.active
            and agent.agent_id in sc.combat.combatant_ids
            and agent.agent_id not in sc.combat.fled_ids
        )
        roster.append({
            "in_combat": in_combat,
            "agent_id": agent.agent_id,
            "name": agent.name,
            "tactics": agent.persona or None,
            "color": agent.color,
            "brain": agent.brain,
            "preset": agent.preset,
            **({"ready": agent.ready} if in_lobby else {}),
            # Only when there is one, for the same reason as ``ready``: an
            # always-null key would ride every frame of an off-chain season.
            **({"pass_id": agent.pass_id} if agent.pass_id else {}),
            "alive": agent.is_alive,
            "hp": char.hp,
            "max_hp": char.max_hp,
            "kills": agent.kills,
            "mob_kills": agent.mob_kills,
            "weapon": weapon_name(char),
            "weapon_bonus": next(
                (i.damage_bonus for i in char.inventory if i.id == char.equipped_weapon),
                0,
            ),
            "position": {
                "kind": agent.position.kind,
                "hex": agent.position.hex,
                "site_id": agent.position.site_id,
                "room": agent.position.room,
            },
            "last_action": agent.last_action,
            "cause_of_death": agent.cause_of_death,
        })
    return roster

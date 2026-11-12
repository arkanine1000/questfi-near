"""Observations: banded rivals, context-sensitive actions, spectator views."""

from __future__ import annotations

from quest_sim.engine.sandbox.build import build_world, start_season
from quest_sim.engine.sandbox.perception import (
    build_observation,
    hp_band,
    island_map_view,
    roster_view,
    site_map_view,
    valid_actions,
)
from quest_sim.engine.sandbox.tick import run_world_tick
from quest_sim.models.overworld import WorldPos, hex_neighbors, parse_hex_key
from quest_sim.models.sandbox import SandboxConfig


def _world(seed=7, pool=4):
    w = build_world(SandboxConfig(pool_size=pool), seed=seed)
    start_season(w)
    return w


def _colocate_surface(w, a, b):
    tile = w.overworld.get_key(b.position.hex)
    if tile and b.agent_id in tile.occupants:
        tile.occupants.remove(b.agent_id)
    q, r = parse_hex_key(a.position.hex)
    b.position = WorldPos.at_hex(q, r)
    w.overworld.get_key(a.position.hex).occupants.append(b.agent_id)


def test_hp_band_words():
    class C:
        max_hp = 20
        def __init__(self, hp): self.hp = hp
    assert hp_band(C(20)) == "hale"
    assert hp_band(C(10)) == "wounded"
    assert hp_band(C(6)) == "badly wounded"
    assert hp_band(C(2)) == "near death"


def test_self_exact_rivals_banded():
    w = _world()
    agents = list(w.agents.values())
    a, b = agents[0], agents[1]
    _colocate_surface(w, a, b)
    b.character.hp = max(1, int(b.character.max_hp * 0.3))

    obs = build_observation(w, a.agent_id)
    assert obs["you"]["hp"] == a.character.hp  # exact self
    rivals = obs["rivals_here"]
    assert len(rivals) == 1
    assert rivals[0]["name"] == b.name
    assert rivals[0]["hp_band"] == "badly wounded"
    assert "hp" not in rivals[0], "rival HP must never be exact"
    assert rivals[0]["color"] == b.color


def test_rivals_adjacent_on_neighbour_hex():
    w = _world()
    agents = list(w.agents.values())
    a, b = agents[0], agents[1]
    q, r = parse_hex_key(a.position.hex)
    neighbour = next(
        (nq, nr) for nq, nr in hex_neighbors(q, r) if w.overworld.get(nq, nr)
    )
    tile = w.overworld.get_key(b.position.hex)
    if tile and b.agent_id in tile.occupants:
        tile.occupants.remove(b.agent_id)
    b.position = WorldPos.at_hex(*neighbour)
    w.overworld.get(*neighbour).occupants.append(b.agent_id)

    obs = build_observation(w, a.agent_id)
    assert any(rv["name"] == b.name for rv in obs["rivals_adjacent"])
    assert obs["rivals_here"] == []


def test_valid_actions_follow_context():
    w = _world()
    a = list(w.agents.values())[0]

    # surface, no mouth underfoot
    obs = build_observation(w, a.agent_id)
    acts = obs["valid_actions"]
    assert any(x.startswith("travel:") for x in acts)
    assert "enter" not in acts
    assert "wait" in acts

    # surface on a mouth
    site_id = next(s for s in w.sites if s != w.boss_site_id)
    mouth = list(w.sites[site_id].entrances.values())[0]
    tile = w.overworld.get_key(a.position.hex)
    tile.occupants.remove(a.agent_id)
    a.position = WorldPos.at_hex(*parse_hex_key(mouth))
    w.overworld.get_key(mouth).occupants.append(a.agent_id)
    acts = build_observation(w, a.agent_id)["valid_actions"]
    assert "enter" in acts

    # inside, at the entrance room
    run_world_tick(w, {a.agent_id: {"action": "enter"}})
    acts = build_observation(w, a.agent_id)["valid_actions"]
    assert "exit" in acts
    assert any(x.startswith("move:") for x in acts)
    assert not any(x.startswith("travel:") for x in acts)


def test_combat_actions_when_fighting():
    w = _world()
    a = list(w.agents.values())[0]
    site_id = next(s for s in w.sites if s != w.boss_site_id)
    site = w.sites[site_id]
    room_key, mob_id = next(
        (key, eid)
        for key in sorted(site.map_grid.rooms)
        for eid in site.map_grid.rooms[key].entity_ids
        if site.entities.get(eid) is not None and site.entities[eid].is_alive
    )
    tile = w.overworld.get_key(a.position.hex)
    tile.occupants.remove(a.agent_id)
    r, c = (int(x) for x in room_key.split(","))
    a.position = WorldPos.in_site(site_id, r, c)
    a.visited.setdefault(site_id, set()).add(room_key)
    run_world_tick(w, {a.agent_id: {"action": "wait"}})  # upkeep ignites

    obs = build_observation(w, a.agent_id)
    assert obs["combat"] is not None
    assert obs["combat"]["active"]
    names = {c["name"] for c in obs["combat"]["combatants"]}
    assert site.entities[mob_id].name in names or len(names) >= 2
    acts = obs["valid_actions"]
    assert any(x.startswith("attack:") for x in acts)
    assert "dodge" in acts
    assert any(x.startswith("flee:") for x in acts)
    assert not any(x.startswith("move:") for x in acts)


def test_observation_map_respects_personal_fog():
    w = _world()
    a = list(w.agents.values())[0]
    site_id = next(s for s in w.sites if s != w.boss_site_id)
    mouth = list(w.sites[site_id].entrances.values())[0]
    tile = w.overworld.get_key(a.position.hex)
    tile.occupants.remove(a.agent_id)
    a.position = WorldPos.at_hex(*parse_hex_key(mouth))
    w.overworld.get_key(mouth).occupants.append(a.agent_id)
    run_world_tick(w, {a.agent_id: {"action": "enter"}})

    obs = build_observation(w, a.agent_id)
    site = w.sites[site_id]
    fog_map = obs["map"]
    assert fog_map["site_id"] == site_id
    visited_rooms = [k for k, r in fog_map["rooms"].items() if r.get("visited")]
    assert visited_rooms == [a.position.room]
    # frontier rooms are typed but not fully revealed
    partial = [k for k, r in fog_map["rooms"].items() if r.get("fog") == "partial"]
    assert partial, "adjacent unvisited rooms surface as partial"
    assert len(fog_map["rooms"]) < len(site.map_grid.rooms)
    assert fog_map["rooms"][a.position.room].get("player_here")


def test_site_map_view_lists_players_and_hp():
    w = _world()
    a = list(w.agents.values())[0]
    site_id = next(s for s in w.sites if s != w.boss_site_id)
    site = w.sites[site_id]
    entrance = list(site.entrances)[0]
    tile = w.overworld.get_key(a.position.hex)
    tile.occupants.remove(a.agent_id)
    r, c = (int(x) for x in entrance.split(","))
    a.position = WorldPos.in_site(site_id, r, c)

    view = site_map_view(w, site_id)
    assert view["site_name"] == site.name
    assert len(view["rooms"]) == len(site.map_grid.rooms)
    room = view["rooms"][entrance]
    assert room["players"] == [
        {"agent_id": a.agent_id, "name": a.name, "color": a.color}
    ]
    assert room["is_entrance"]
    # never the solo player_here flag — the FE adapter derives focus itself
    assert "player_here" not in room
    for rv in view["rooms"].values():
        for ent in rv["entities"]:
            assert {"id", "name", "type", "hp", "max_hp"} <= set(ent)

    assert site_map_view(w, "nope") is None


def test_island_map_view_static_sheet():
    w = _world()
    view = island_map_view(w)
    assert view["center_hex"] == w.center_hex
    assert len(view["tiles"]) == 120
    assert view["boss_site_id"] == w.boss_site_id
    assert set(view["spawn_ring"]) == set(w.spawn_ring)
    mouth_tiles = [t for t in view["tiles"].values() if t.get("site_id")]
    assert len(mouth_tiles) >= len(w.sites)
    assert any(t.get("is_boss_site") for t in mouth_tiles)


def test_roster_view_exact_for_spectators():
    w = _world()
    roster = roster_view(w)
    assert len(roster) == len(w.agents)
    for row in roster:
        assert {"agent_id", "name", "color", "hp", "max_hp", "kills",
                "alive", "position", "brain"} <= set(row)
    colors = [r["color"] for r in roster]
    assert len(set(colors)) == len(colors)


def test_equip_offered_only_when_something_equips():
    """The menu must never invite an equip that the engine will refuse."""
    from quest_sim.models.character import Item, ItemType
    from quest_sim.engine.sandbox.perception import valid_actions

    w = _world()
    a = list(w.agents.values())[0]
    # fresh spawn: starter weapon already in hand, nothing else to wear
    assert "equip:item=<name>" not in valid_actions(w, a)

    # a looted relic (crown) makes equip appear...
    crown = Item(id=f"{a.agent_id}.crown", name="Crown of the Hollow King",
                 item_type=ItemType.shield, ac_bonus=1)
    a.character.inventory.append(crown)
    assert "equip:item=<name>" in valid_actions(w, a)

    # ...and once worn, the offer goes away again
    a.character.equipped_armor = crown.id
    assert "equip:item=<name>" not in valid_actions(w, a)


def test_truce_end_warning_when_shared_fight_ends_with_rivals_present():
    """The classic betrayal death: co-op vs mobs ends, ex-ally swings first.
    The observation must call it out instead of leaving it to inference."""
    from quest_sim.models.events import EngineEvent, EngineEventType

    w = _world()
    agents = list(w.living_agents())
    a, b, c = agents[0], agents[1], agents[2]
    _colocate_surface(w, a, b)
    ev = EngineEvent(
        event_type=EngineEventType.combat_end, tick=w.tick,
        location=a.loc_key, description="The last mob falls.",
    )
    obs = build_observation(w, a.agent_id, last_events=[ev])
    assert any("truce" in warning for warning in obs["warnings"])

    # elsewhere, or alone: no warning
    assert build_observation(w, c.agent_id, last_events=[ev])["warnings"] == []


def test_surface_gear_compass_points_to_nearest_unvisited_dungeon():
    """The Dain orbit: the Heart had coordinates while 'gear up first' had
    none, so cautious agents flip-flopped around the boss mouth. The surface
    observation now names exactly ONE alternative — the closest outer
    dungeon this agent has never entered."""
    w = _world()
    a = next(iter(w.living_agents()))
    ptr = build_observation(w, a.agent_id)["location"]["nearest_unexplored_site"]
    assert ptr is not None
    assert ptr["name"] and ptr["hex"]
    assert ptr["distance_hexes"] >= 0
    boss_name = w.get_site(w.boss_site_id).name
    assert ptr["name"] != boss_name  # the Heart is the objective, not gear

    # setting foot inside moves the compass to a different site
    first_id = next(s.site_id for s in w.sites.values() if s.name == ptr["name"])
    a.visited[first_id] = {"0,0"}
    ptr2 = build_observation(w, a.agent_id)["location"]["nearest_unexplored_site"]
    assert ptr2 is None or ptr2["name"] != ptr["name"]

    # every outer dungeon entered -> the compass goes dark
    for s in w.sites.values():
        if s.site_id != w.boss_site_id:
            a.visited[s.site_id] = {"0,0"}
    assert build_observation(w, a.agent_id)["location"]["nearest_unexplored_site"] is None


def test_dungeon_observation_carries_anti_amnesia_compass():
    """The wander loop: agents re-walked shiny 'treasure_room' exit labels
    because nothing distinguished explored-and-emptied rooms from fresh
    ones. Exits carry visited flags, nearest_unexplored points into the
    dark, and site_explored says when a dungeon is truly done."""
    w = _world()
    a = next(iter(w.living_agents()))
    site = next(s for s in w.sites.values() if s.site_id != w.boss_site_id)
    entrance = next(iter(site.entrances))
    a.position = WorldPos(kind="dungeon", site_id=site.site_id, room=entrance)
    a.visited[site.site_id] = {entrance}

    loc = build_observation(w, a.agent_id)["location"]
    assert loc["kind"] == "dungeon"
    nu = loc["nearest_unexplored"]
    assert nu is not None and nu["distance"] >= 1
    assert nu["direction"] in {"N", "S", "E", "W"}
    assert loc["site_explored"] is False
    # exit visited flags reflect THIS agent's fog
    assert any(not e["visited"] for e in loc["exits"].values())

    # every room seen -> the compass goes dark and the site reads done
    a.visited[site.site_id] = set(site.map_grid.rooms)
    loc = build_observation(w, a.agent_id)["location"]
    assert loc["nearest_unexplored"] is None
    assert loc["site_explored"] is True


def test_equip_offer_needs_strict_upgrade_not_any_spare():
    """The Bren loop: a duplicate wearable (same stats, different id — sites
    share prefab templates) kept `equip` on the LLM menu every tick, and the
    brain obediently 'equipped' it forever. The offer must demand a STRICT
    upgrade, exactly like the policy brain."""
    from quest_sim.engine.sandbox.actions import equip
    from quest_sim.models.character import Item, ItemType
    from quest_sim.models.events import EngineEventType

    w = _world()
    a = next(iter(w.living_agents()))
    cloak = Item(id="roost-1.windwrap_cloak", name="Windwrap Cloak",
                 item_type=ItemType.shield, ac_bonus=1)
    a.character.inventory.append(cloak)
    assert "equip:item=<name>" in valid_actions(w, a)  # genuine upgrade

    a.character.equipped_armor = cloak.id
    dupe = Item(id="roost-2.windwrap_cloak", name="Windwrap Cloak",
                item_type=ItemType.shield, ac_bonus=1)
    a.character.inventory.append(dupe)
    # a same-stat duplicate is NOT an upgrade — no offer, no loop
    assert "equip:item=<name>" not in valid_actions(w, a)

    # ...and a spare (worse) weapon isn't an offer either
    rusty = Item(id="x.rusty", name="Rusty Dagger",
                 item_type=ItemType.weapon, damage_bonus=0)
    a.character.inventory.append(rusty)
    assert "equip:item=<name>" not in valid_actions(w, a)

    # equip-by-name with the worn copy first prefers the unequipped duplicate
    events = equip(w, a, "Windwrap Cloak")
    assert a.character.equipped_armor == dupe.id
    assert all(e.event_type != EngineEventType.action_failed for e in events)

    # a strictly better cloak brings the offer back
    better = Item(id="y.stormcloak", name="Stormcloak",
                  item_type=ItemType.shield, ac_bonus=2)
    a.character.inventory.append(better)
    assert "equip:item=<name>" in valid_actions(w, a)


def test_equip_already_equipped_fails_loudly():
    from quest_sim.engine.sandbox.actions import equip
    from quest_sim.models.character import Item, ItemType
    from quest_sim.models.events import EngineEventType

    w = _world()
    a = next(iter(w.living_agents()))
    crown = Item(id="z.crown", name="Crown of the Hollow King",
                 item_type=ItemType.shield, ac_bonus=1)
    a.character.inventory.append(crown)
    a.character.equipped_armor = crown.id
    events = equip(w, a, "Crown of the Hollow King")
    assert [e.event_type for e in events] == [EngineEventType.action_failed]
    assert "already equipped" in events[0].description


def test_surface_neighbours_carry_direction_and_heart_distance():
    """No hex geometry required of agents: every neighbour names the exact
    travel direction that reaches it and its own distance to the Heart (a
    player bounced between two hexes reverse-engineering axial deltas)."""
    from quest_sim.models.overworld import HEX_DIRECTIONS, hex_key

    w = _world()
    a = next(iter(w.living_agents()))
    obs = build_observation(w, a.agent_id)
    loc = obs["location"]
    assert loc["kind"] == "overworld"
    assert loc["neighbours"], "spawn ring hexes have neighbours"

    q, r = parse_hex_key(a.position.hex)
    for n in loc["neighbours"]:
        dq, dr = HEX_DIRECTIONS[n["direction"]]  # label must reach its hex
        assert n["hex"] == hex_key(q + dq, r + dr)
        assert n["heart_distance"] >= 0

    # the compass is actionable: some neighbour actually closes the gap
    my_d = obs["objective"]["distance_hexes"]
    assert any(n["heart_distance"] == my_d - 1 for n in loc["neighbours"])


def test_boss_readiness_counterweights_the_fear():
    """Agents NEVER braved the Heart: the 'deadly' warning had no
    counter-signal, so myopic per-tick reasoning waited forever. The
    engine now issues a verdict — including the desperation read when
    waiting is the worse bet — but only when a run actually makes sense."""
    from quest_sim.models.character import Item, ItemType

    w = _world()
    agents = list(w.living_agents())
    a = agents[0]

    obj = build_observation(w, a.agent_id)["objective"]
    assert "under-geared" in obj["boss_readiness"]  # starter kit
    assert obj["your_gear_score"] >= 0

    # a looted kit flips the verdict to READY
    a.character.inventory.append(Item(id="x.axe", name="Runed Greataxe",
                                      item_type=ItemType.weapon, damage_bonus=4))
    a.character.inventory.append(Item(id="x.cloak", name="Stormcloak",
                                      item_type=ItemType.shield, ac_bonus=1))
    obj = build_observation(w, a.agent_id)["objective"]
    assert "READY" in obj["boss_readiness"]

    # and it stays READY when hurt — gear alone decides the verdict
    a.character.hp = max(1, a.character.max_hp // 4)
    obj = build_observation(w, a.agent_id)["objective"]
    assert "READY" in obj["boss_readiness"]
    assert "heal on the way in" in obj["boss_readiness"]
    a.character.hp = a.character.max_hp

    # late game, behind on the bell, still able to swing -> yolo is rational
    w.tick = w.config.max_ticks  # past the 3/4 mark
    agents[1].kills = 5  # someone else owns the bell
    obj = build_observation(w, a.agent_id)["objective"]
    assert "Desperation is a strategy" in obj["boss_readiness"]

    # hopeless (no gear, near death) -> the hunt, not the Heart
    a.character.inventory = [i for i in a.character.inventory
                             if i.item_type == ItemType.potion]
    a.character.equipped_weapon = None
    a.character.hp = 1
    obj = build_observation(w, a.agent_id)["objective"]
    assert "hunting a leader" in obj["boss_readiness"]

    # the bell leader is told to guard, not to panic
    obj = build_observation(w, agents[1].agent_id)["objective"]
    assert "bell currently favors you" in obj["boss_readiness"]


def test_dungeon_observation_carries_exit_compass():
    """Agents declared 'time to leave' for a dozen ticks while failing to
    route to the entrance — nearest_exit gives first step + distance, and
    distance 0 marks standing in the doorway."""
    w = _world()
    a = next(iter(w.living_agents()))
    site = next(s for s in w.sites.values() if s.site_id != w.boss_site_id)
    entrance = next(iter(site.entrances))

    a.position = WorldPos(kind="dungeon", site_id=site.site_id, room=entrance)
    a.visited[site.site_id] = {entrance}
    loc = build_observation(w, a.agent_id)["location"]
    assert loc["nearest_exit"] == {"direction": None, "distance": 0}
    assert loc["at_entrance"] is True

    # from any other reachable room the compass points a legal first step
    from quest_sim.models.map import DIRECTION_OFFSETS
    inner = next(
        k for k in a.visited[site.site_id].union(site.map_grid.rooms)
        if k not in site.entrances
    )
    a.position = WorldPos(kind="dungeon", site_id=site.site_id, room=inner)
    a.visited[site.site_id].add(inner)
    ptr = build_observation(w, a.agent_id)["location"]["nearest_exit"]
    assert ptr is not None and ptr["distance"] >= 1
    assert ptr["direction"] in {"N", "S", "E", "W"}


def test_objective_bearing_only_points_at_land():
    """The compass must never point into open sea — agents obeyed it
    straight into 'travel failed: nothing but open sea lies E'."""
    from quest_sim.engine.sandbox.perception import _bearing
    from quest_sim.models.overworld import HEX_DIRECTIONS

    w = _world()
    cq, cr = parse_hex_key(w.center_hex)
    checked = 0
    for key in island_map_view(w)["tiles"]:
        q, r = parse_hex_key(key)
        b = _bearing(q, r, cq, cr, overworld=w.overworld)
        if (q, r) == (cq, cr):
            assert b is None
            continue
        assert b is not None  # land always offers SOME legal step
        dq, dr = HEX_DIRECTIONS[b]
        assert w.overworld.get(q + dq, r + dr) is not None
        checked += 1
    assert checked > 50  # the whole island, not a lucky corner


def test_roster_view_carries_weapon_bonus():
    """The crawler HUD shows '+N DMG' next to the weapon name — the roster
    must carry the equipped weapon's bonus, not just its label."""
    w = _world()
    a = next(iter(w.living_agents()))
    me = next(r for r in roster_view(w) if r["agent_id"] == a.agent_id)
    starter = next(
        i for i in a.character.inventory if i.id == a.character.equipped_weapon
    )
    assert me["weapon"] == starter.name
    assert me["weapon_bonus"] == starter.damage_bonus > 0  # starter kits are +N

    a.character.equipped_weapon = None
    me = next(r for r in roster_view(w) if r["agent_id"] == a.agent_id)
    assert me["weapon"] == "bare hands" and me["weapon_bonus"] == 0


def test_objective_carries_boss_coordinates():
    """Every agent knows where the Heart is from tick 0 — with distance and
    bearing while on the surface. No aimless wandering."""
    w = _world()
    a = next(iter(w.living_agents()))
    obj = build_observation(w, a.agent_id)["objective"]
    assert obj["center_hex"] == w.center_hex
    assert obj["boss_site"]
    # the spawn ring is never the center — the compass must point somewhere
    assert obj["distance_hexes"] >= 1
    assert obj["bearing"] in {"E", "W", "NE", "NW", "SE", "SW"}

    # underground: coordinates stay, the surface compass goes dark
    boss_site = w.get_site(w.boss_site_id)
    room_key = next(iter(boss_site.map_grid.rooms))
    a.position = WorldPos(kind="dungeon", site_id=w.boss_site_id, room=room_key)
    a.visited.setdefault(w.boss_site_id, set()).add(room_key)
    obj = build_observation(w, a.agent_id)["objective"]
    assert obj["center_hex"] == w.center_hex
    assert "distance_hexes" not in obj


def test_you_ac_is_the_number_attacks_roll_against():
    """The AC a player reads must be the AC the engine rolls against.

    `you.ac` sent the bare `character.ac` while combat has always resolved
    against `effective_ac`, so anyone carrying armour planned around a number
    they did not have. Twice reported from live seasons — a cloak, then a
    shield — so this asserts EQUALITY WITH THE COMBAT PATH rather than a
    literal, or the third recurrence walks straight through it."""
    from quest_sim.engine.character import effective_ac
    from quest_sim.models.character import Item, ItemType

    w = _world()
    agent = next(iter(w.agents.values()))
    shield = Item(
        id="test-aegis",
        name="Grave Aegis",
        item_type=ItemType.shield,
        ac_bonus=1,
    )
    agent.character.inventory.append(shield)
    agent.character.equipped_armor = shield.id

    obs = build_observation(w, agent.agent_id)
    assert obs["you"]["ac"] == effective_ac(agent.character)
    assert obs["you"]["ac"] > agent.character.ac, "worn armour was not counted"


# ---------------------------------------------------------------------------
# Which events reach which agent
# ---------------------------------------------------------------------------


def _hit(victim, attacker=None, *, tick, location, kind="damage"):
    """A blow, stamped the way combat stamps one: actor is the ATTACKER."""
    from quest_sim.models.events import EngineEvent, EngineEventType

    if kind == "damage":
        etype, data = EngineEventType.damage, {
            "target_id": victim.agent_id, "damage": 6, "hp_remaining": 12,
        }
    else:
        etype, data = EngineEventType.attack, {
            "attacker_id": attacker.agent_id if attacker else "mob",
            "defender_id": victim.agent_id, "hit": True,
        }
    return EngineEvent(
        event_type=etype, tick=tick, location=location, data=data,
        actor=(attacker.agent_id if attacker else "site-1.skeleton_3"),
        description=f"{victim.name} takes 6 damage.",
    )


def _descriptions(obs):
    return [e["description"] for e in obs["last_tick_events"]]


def test_a_victim_who_fled_is_still_told_it_was_hit():
    """Reported from a live season: an agent went 18 -> 12 with no attack or
    damage line in its feed, just a room-move, and had to infer the fight
    from its own HP. Victim events are stamped to the ATTACKER, so a victim
    that moved matched neither the actor clause nor its current location."""
    w = _world()
    a, b = list(w.agents.values())[:2]
    struck_at = a.loc_key
    ev = _hit(a, b, tick=w.tick, location=struck_at)

    # ...and now A flees somewhere else entirely
    q, r = parse_hex_key(a.position.hex)
    a.position = WorldPos.at_hex(q + 1, r)
    assert a.loc_key != struck_at

    obs = build_observation(w, a.agent_id, last_events=[ev])
    assert _descriptions(obs), "the victim was never told it was hit"


def test_mob_damage_reaches_the_agent_it_landed_on():
    """Mob attacks stamp actor to the MOB id, which can never match an agent,
    so the actor clause alone would not save this one."""
    w = _world()
    a = next(iter(w.agents.values()))
    struck_at = a.loc_key
    ev = _hit(a, None, tick=w.tick, location=struck_at)

    q, r = parse_hex_key(a.position.hex)
    a.position = WorldPos.at_hex(q + 1, r)

    obs = build_observation(w, a.agent_id, last_events=[ev])
    assert _descriptions(obs)


def test_a_room_does_not_hand_over_its_history():
    """The other direction of the same bug. The replay window reaches back
    ten ticks but was matched against ONE current location, so walking into
    a room served you everything that had happened there while you were
    elsewhere."""
    w = _world()
    a, b, c = list(w.agents.values())[:3]
    w.tick = 8
    ev = _hit(b, c, tick=4, location=a.loc_key)  # a fight A was not at

    obs = build_observation(w, a.agent_id, last_events=[ev])
    assert _descriptions(obs) == [], "a room leaked its past to a newcomer"


def test_events_from_a_room_i_stood_in_still_reach_me():
    """...without throwing away the replay the lookback exists for."""
    w = _world()
    a, b, c = list(w.agents.values())[:3]
    where = a.loc_key
    a.loc_trail["4"] = [where]  # A WAS there on tick 4
    w.tick = 8
    ev = _hit(b, c, tick=4, location=where)

    obs = build_observation(w, a.agent_id, last_events=[ev])
    assert _descriptions(obs)


def test_a_fight_i_never_saw_stays_invisible():
    """Fog non-regression: widening the victim clause must not widen anyone
    else's view of a fight they had no part in."""
    w = _world()
    a, b, c = list(w.agents.values())[:3]
    ev = _hit(b, c, tick=w.tick, location=b.loc_key)
    assert b.loc_key != a.loc_key

    obs = build_observation(w, a.agent_id, last_events=[ev])
    assert _descriptions(obs) == []


def test_truce_warning_does_not_refire_on_a_stale_combat_end():
    """The warning had no tick guard, so once the replay window grew to ten
    ticks a single old combat_end told you every turn that the truce had
    just died."""
    from quest_sim.models.events import EngineEvent, EngineEventType

    w = _world()
    a, b = list(w.agents.values())[:2]
    _colocate_surface(w, a, b)
    w.tick = 9
    a.loc_trail["4"] = [a.loc_key]
    stale = EngineEvent(
        event_type=EngineEventType.combat_end, tick=4,
        location=a.loc_key, description="The last mob falls.",
    )
    assert build_observation(w, a.agent_id, last_events=[stale])["warnings"] == []

    fresh = EngineEvent(
        event_type=EngineEventType.combat_end, tick=9,
        location=a.loc_key, description="The last mob falls.",
    )
    assert any(
        "truce" in warn
        for warn in build_observation(w, a.agent_id, last_events=[fresh])["warnings"]
    )

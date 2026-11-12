"""Combat house rules: implicit co-op, betrayal, dungeon-only PvP, the crown."""

from __future__ import annotations

import random

import pytest

from quest_sim.engine.character import (
    dodge_ac_bonus,
    effective_ac,
    get_weapon_bonus,
    get_weapon_to_hit,
)
from quest_sim.engine.combat_core import resolve_attack
from quest_sim.engine.sandbox.build import build_world, create_agent, start_season
from quest_sim.models.character import (
    AbilityScores,
    Character,
    EntityType,
    Item,
    ItemType,
)
from quest_sim.engine.sandbox.perception import site_map_view
from quest_sim.engine.sandbox.tick import run_world_tick
from quest_sim.models.events import EngineEventType
from quest_sim.models.overworld import WorldPos, parse_hex_key
from quest_sim.models.sandbox import SandboxConfig, WorldPhase


def _world(pool: int = 4, seed: int = 7):
    w = build_world(SandboxConfig(pool_size=pool, max_ticks=50), seed=seed)
    start_season(w)
    return w


def _agents(w, n=None):
    out = list(w.agents.values())
    return out if n is None else out[:n]


def _teleport(w, agent, site_id: str, room_key: str) -> None:
    if agent.position.kind == "overworld" and agent.position.hex:
        tile = w.overworld.get_key(agent.position.hex)
        if tile and agent.agent_id in tile.occupants:
            tile.occupants.remove(agent.agent_id)
    r, c = (int(x) for x in room_key.split(","))
    agent.position = WorldPos.in_site(site_id, r, c)
    agent.visited.setdefault(site_id, set()).add(room_key)


def _first_mob_room(w, site_id: str) -> tuple[str, str]:
    """(room_key, mob_id) of the first room holding a living mob."""
    site = w.sites[site_id]
    for key in sorted(site.map_grid.rooms):
        room = site.map_grid.rooms[key]
        for eid in room.entity_ids:
            mob = site.entities.get(eid)
            if mob is not None and mob.is_alive:
                return key, eid
    raise AssertionError(f"no living mob in {site_id}")


def _empty_room(w, site_id: str) -> str:
    site = w.sites[site_id]
    for key in sorted(site.map_grid.rooms):
        room = site.map_grid.rooms[key]
        if not room.entity_ids and room.trap_dc is None:
            return key
    raise AssertionError(f"no empty room in {site_id}")


def _poi(w) -> str:
    return next(s for s in w.sites if s != w.boss_site_id)


def _tick(w, decisions):
    return run_world_tick(w, decisions)


def _types(events):
    return [e.event_type for e in events]


# ---------------------------------------------------------------------------
# Ignition
# ---------------------------------------------------------------------------


def test_implicit_coop_ignition_rolls_everyone():
    w = _world()
    a, b = _agents(w, 2)
    site_id = _poi(w)
    room_key, mob_id = _first_mob_room(w, site_id)
    _teleport(w, a, site_id, room_key)
    _teleport(w, b, site_id, room_key)

    events = _tick(w, {a.agent_id: {"action": "wait"}, b.agent_id: {"action": "wait"}})

    loc = f"{site_id}:{room_key}"
    assert loc in w.combats
    combat = w.combats[loc].combat
    assert combat.active
    assert a.agent_id in combat.combatant_ids
    assert b.agent_id in combat.combatant_ids
    assert mob_id in combat.combatant_ids
    assert EngineEventType.combat_start in _types(events)
    # co-op is presumed: no hostile pair between the agents
    assert not w.combats[loc].is_hostile(a.agent_id, b.agent_id)
    room_view = site_map_view(w, site_id)["rooms"][room_key]
    assert room_view["combat"]["active"] is True
    assert room_view["combat"]["pvp_active"] is False
    # everyone present rolled initiative
    rolled = {e.data["character_id"] for e in events
              if e.event_type is EngineEventType.initiative_roll}
    assert {a.agent_id, b.agent_id, mob_id} <= rolled


def test_lone_agent_vs_mob_ignites():
    w = _world()
    a = _agents(w, 1)[0]
    site_id = _poi(w)
    room_key, _ = _first_mob_room(w, site_id)
    _teleport(w, a, site_id, room_key)
    _tick(w, {a.agent_id: {"action": "wait"}})
    assert f"{site_id}:{room_key}" in w.combats


def test_mobs_strike_the_most_wounded():
    w = _world()
    a, b = _agents(w, 2)
    site_id = _poi(w)
    room_key, mob_id = _first_mob_room(w, site_id)
    _teleport(w, a, site_id, room_key)
    _teleport(w, b, site_id, room_key)
    a.character.hp = a.character.max_hp  # hale
    b.character.hp = max(1, b.character.max_hp // 10)  # nearly dead

    _tick(w, {a.agent_id: {"action": "wait"}, b.agent_id: {"action": "wait"}})
    # next tick the mob acts within the rotation
    events = _tick(w, {a.agent_id: {"action": "dodge"}, b.agent_id: {"action": "dodge"}})
    mob_attacks = [
        e for e in events
        if e.event_type is EngineEventType.attack and e.data.get("attacker_id") == mob_id
    ]
    assert mob_attacks, "mob should act in the rotation"
    assert all(e.data["defender_id"] == b.agent_id for e in mob_attacks)


# ---------------------------------------------------------------------------
# PvP legality
# ---------------------------------------------------------------------------


def test_overworld_pvp_rejected():
    w = _world()
    a, b = _agents(w, 2)
    # co-locate on the surface
    b_hex = a.position.hex
    tile = w.overworld.get_key(b.position.hex)
    if tile and b.agent_id in tile.occupants:
        tile.occupants.remove(b.agent_id)
    q, r = parse_hex_key(b_hex)
    b.position = WorldPos.at_hex(q, r)
    w.overworld.get_key(b_hex).occupants.append(b.agent_id)

    events = _tick(w, {a.agent_id: {"action": "attack", "target": b.name},
                       b.agent_id: {"action": "wait"}})
    fails = [e for e in events if e.event_type is EngineEventType.action_failed
             and e.actor == a.agent_id]
    assert fails and "truce" in fails[0].description
    assert not w.combats
    assert b.is_alive


def test_dungeon_ambush_ignites_with_grudge():
    w = _world()
    a, b = _agents(w, 2)
    site_id = _poi(w)
    room_key = _empty_room(w, site_id)
    _teleport(w, a, site_id, room_key)
    _teleport(w, b, site_id, room_key)

    events = _tick(w, {a.agent_id: {"action": "attack", "target": b.name},
                       b.agent_id: {"action": "wait"}})
    loc = f"{site_id}:{room_key}"
    attacks = [e for e in events if e.event_type is EngineEventType.attack]
    assert attacks and attacks[0].data["attacker_id"] == a.agent_id
    assert loc in w.combats, "the ambush becomes the brawl"
    assert w.combats[loc].is_hostile(a.agent_id, b.agent_id)
    room_view = site_map_view(w, site_id)["rooms"][room_key]
    assert room_view["combat"]["pvp_active"] is True
    assert sorted(room_view["combat"]["hostile_pairs"][0]) == sorted(
        [a.agent_id, b.agent_id]
    )


# ---------------------------------------------------------------------------
# Betrayal and end conditions
# ---------------------------------------------------------------------------


def _coop_fight(w):
    """Two agents + one mob in one container; returns (a, b, mob_id, loc)."""
    a, b = _agents(w, 2)
    site_id = _poi(w)
    room_key, mob_id = _first_mob_room(w, site_id)
    _teleport(w, a, site_id, room_key)
    _teleport(w, b, site_id, room_key)
    _tick(w, {a.agent_id: {"action": "wait"}, b.agent_id: {"action": "wait"}})
    return a, b, mob_id, f"{site_id}:{room_key}"


def test_allies_stand_down_when_mobs_fall():
    w = _world()
    a, b, mob_id, loc = _coop_fight(w)
    site = w.sites[loc.split(":")[0]]
    # keep everyone safely alive; execute the mob outside the roll of the dice
    a.character.hp = a.character.max_hp
    b.character.hp = b.character.max_hp
    site.entities[mob_id].hp = 0
    site.entities[mob_id].is_alive = False
    room = site.map_grid.rooms[loc.split(":")[1]]
    if mob_id in room.entity_ids:
        room.entity_ids.remove(mob_id)

    events = _tick(w, {a.agent_id: {"action": "dodge"}, b.agent_id: {"action": "dodge"}})
    ends = [e for e in events if e.event_type is EngineEventType.combat_end]
    assert ends and ends[0].data["reason"] == "truce"
    assert loc not in w.combats
    assert a.is_alive and b.is_alive


def test_betrayal_keeps_the_fight_alive_after_mobs():
    w = _world()
    a, b, mob_id, loc = _coop_fight(w)
    site = w.sites[loc.split(":")[0]]
    a.character.hp = a.character.max_hp
    b.character.hp = b.character.max_hp
    # betrayal mid-fight
    _tick(w, {a.agent_id: {"action": "attack", "target": b.name},
              b.agent_id: {"action": "dodge"}})
    assert w.combats[loc].is_hostile(a.agent_id, b.agent_id)

    # mob dies; the grudge keeps the container hot
    site.entities[mob_id].hp = 0
    site.entities[mob_id].is_alive = False
    room = site.map_grid.rooms[loc.split(":")[1]]
    if mob_id in room.entity_ids:
        room.entity_ids.remove(mob_id)
    a.character.hp = a.character.max_hp
    b.character.hp = b.character.max_hp

    events = _tick(w, {a.agent_id: {"action": "dodge"}, b.agent_id: {"action": "dodge"}})
    assert loc in w.combats, "hostile pair keeps fighting after the mobs fall"
    assert EngineEventType.combat_end not in _types(events)


def test_flee_leaves_combat_and_room():
    w = _world()
    a, b, mob_id, loc = _coop_fight(w)
    a.character.hp = a.character.max_hp
    before_room = a.position.room
    events = _tick(w, {a.agent_id: {"action": "flee"}, b.agent_id: {"action": "dodge"}})
    assert EngineEventType.flee in _types(events)
    sc = w.combats.get(loc)
    if sc is not None:
        assert a.agent_id not in sc.combat.combatant_ids
    assert a.position.room != before_room


def test_flee_provokes_a_parting_blow():
    """Escaping combat is no longer free: every engaged enemy takes one
    swing as the fleer turns their back (and the prompts say so)."""
    w = _world()
    a, = _agents(w, 1)
    site_id = _poi(w)
    room_key, mob_id = _first_mob_room(w, site_id)
    _teleport(w, a, site_id, room_key)
    a.character.hp = a.character.max_hp

    _tick(w, {a.agent_id: {"action": "wait"}})  # combat ignites via upkeep
    assert w.combats, "fight should be live"
    events = _tick(w, {a.agent_id: {"action": "flee"}})

    parting = [
        e for e in events
        if e.event_type is EngineEventType.attack
        and e.data.get("attacker_id") == mob_id
        and e.data.get("defender_id") == a.agent_id
    ]
    assert parting, "the mob takes a free swing at the fleeing agent"
    assert any("Parting blow" in e.description for e in parting)
    assert EngineEventType.flee in _types(events)
    # survivor cleared the room (flee still works when it doesn't kill you)
    if a.is_alive:
        assert a.position.room != room_key


def test_trap_death_runs_full_permadeath(monkeypatch):
    """A live world had an agent trap-killed at 0 HP who became a silent
    ghost for 58 ticks: no agent_death event, no cause, loot stuck on the
    corpse. Exploration damage must run the same death pipeline as combat."""
    w = _world()
    a, = _agents(w, 1)
    site = w.sites[_poi(w)]
    mouth_hex = next(iter(site.entrances.values()))
    tile = w.overworld.get_key(a.position.hex)
    if tile and a.agent_id in tile.occupants:
        tile.occupants.remove(a.agent_id)
    q, r = parse_hex_key(mouth_hex)
    a.position = WorldPos.at_hex(q, r)
    w.overworld.get_key(mouth_hex).occupants.append(a.agent_id)
    a.character.hp = 1
    assert a.character.inventory, "carries the starter weapon"

    def lethal_trap(char, room, rng, tick, subject=None):
        from quest_sim.models.events import EngineEvent, EngineEventType
        char.hp = 0
        char.is_alive = False  # what apply_damage does at 0 HP
        return [EngineEvent(
            event_type=EngineEventType.trap_trigger, tick=tick,
            description=f"Trap triggered! {subject} takes 999 damage. HP: 0/1",
        )]

    monkeypatch.setattr("quest_sim.engine.sandbox.actions.trap_core", lethal_trap)
    events = _tick(w, {a.agent_id: {"action": "enter"}})
    types = _types(events)
    assert EngineEventType.trap_trigger in types
    assert EngineEventType.agent_death in types  # the feed learns
    assert not a.is_alive
    assert a.cause_of_death == "slain by a trap"
    assert a.character.inventory == []  # loot scatters where they fell
    death = next(e for e in events if e.event_type == EngineEventType.agent_death)
    assert "fallen to a trap" in death.description


def test_mob_kill_credits_mob_tally_not_rival_kills():
    """Skeletons count somewhere: mob kills land on mob_kills, never on the
    rival-kill tiebreak (a player watched two kills vanish from the tally)."""
    w = _world()
    a, = _agents(w, 1)
    site_id = _poi(w)
    room_key, mob_id = _first_mob_room(w, site_id)
    _teleport(w, a, site_id, room_key)
    site = w.sites[site_id]
    mob = site.entities[mob_id]
    mob.hp = 1
    a.character.hp = 999  # survive whatever the room throws back

    for _ in range(12):
        if not mob.is_alive:
            break
        _tick(w, {a.agent_id: {"action": "attack", "target": mob.name}})
    assert not mob.is_alive
    assert a.mob_kills == 1
    assert a.kills == 0


def test_permadeath_drops_loot_and_credits_killer():
    w = _world()
    a, b = _agents(w, 2)
    site_id = _poi(w)
    room_key = _empty_room(w, site_id)
    _teleport(w, a, site_id, room_key)
    _teleport(w, b, site_id, room_key)
    b.character.hp = 1
    b_items = [i.id for i in b.character.inventory]
    assert b_items, "victim carries a starter weapon"

    # swing until the 1-hp victim falls (misses are possible)
    for _ in range(8):
        if not b.is_alive:
            break
        _tick(w, {a.agent_id: {"action": "attack", "target": b.name},
                  b.agent_id: {"action": "dodge"}})
    assert not b.is_alive
    assert b.character.inventory == []
    assert b.cause_of_death == f"slain by {a.name}"
    assert a.kills == 1
    site = w.sites[site_id]
    room = site.map_grid.rooms[room_key]
    for iid in b_items:
        assert iid in site.items
        assert iid in room.treasure_item_ids


def test_boss_kill_is_instant_season_win():
    w = _world()
    a = _agents(w, 1)[0]
    boss_site = w.sites[w.boss_site_id]
    boss = boss_site.entities[boss_site.boss_id]
    boss_room = f"{boss.position[0]},{boss.position[1]}"
    _teleport(w, a, w.boss_site_id, boss_room)
    # strip the boss room to just the boss for a clean duel
    room = boss_site.map_grid.rooms[boss_room]
    for eid in list(room.entity_ids):
        if eid != boss_site.boss_id:
            room.entity_ids.remove(eid)
    boss.hp = 1

    for _ in range(10):
        if w.phase == WorldPhase.finished:
            break
        events = _tick(w, {x.agent_id: ({"action": "attack", "target": boss.name}
                                        if x.agent_id == a.agent_id else {"action": "wait"})
                           for x in w.living_agents()})
    assert w.phase == WorldPhase.finished
    assert w.win_reason == "boss"
    assert w.winner == a.agent_id
    assert EngineEventType.season_end in _types(events)


def _punching_bag(id="bag", name="Bag", ac=0, **kwargs):
    """A target that cannot dodge and cannot die, for damage-roll sampling."""
    return Character(
        id=id, name=name, entity_type=EntityType.hostile,
        hp=10**6, max_hp=10**6, ac=ac, **kwargs,
    )


def _sample_damage(attacker, rolls=400, seed=3):
    rng = random.Random(seed)
    target = _punching_bag()
    out = []
    for tick in range(rolls):
        events, _ = resolve_attack(attacker, target, rng, tick)
        result = next(e for e in events if e.event_type == EngineEventType.attack).data
        if result["hit"] and not result["critical"]:
            out.append(result["damage"])
    return out


def test_boss_rolls_its_natural_damage_die():
    """The crown fight is the one place damage_dice is not the d6 default.

    Nothing overrode roll_attack's damage_dice before this, so the boss hit
    exactly as hard as a 9-HP skeleton and only its to-hit set it apart. The
    assertion that matters is that the per-entity die actually reaches the
    dice roller — a plumbing break would silently restore the old d6.
    """
    w = _world()
    boss_site = w.sites[w.boss_site_id]
    boss = boss_site.entities[boss_site.boss_id]
    assert (boss.damage_dice, boss.damage_bonus) == (8, 1)

    damages = _sample_damage(boss)
    # d8+1 with no weapon: 2..9, and crucially above the d6 ceiling of 6
    assert min(damages) >= 2
    assert max(damages) == 9
    assert any(d > 6 for d in damages)


def test_default_actors_still_roll_a_plain_d6():
    """The two new Character fields must be inert for everyone else."""
    grunt = _punching_bag(id="grunt", name="Grunt")
    assert (grunt.damage_dice, grunt.damage_bonus) == (6, 0)
    damages = _sample_damage(grunt)
    assert min(damages) >= 1
    assert max(damages) == 6


# ---------------------------------------------------------------------------
# Weapon to-hit vs weapon damage
#
# One Item field fed both the attack roll and the damage roll. Splitting it in
# two must not have moved a single live number — every weapon in the game and
# every prefab was authored against the mirrored behaviour, and the boss win
# rates were simulated against it.
# ---------------------------------------------------------------------------


def _armed(bonus: int, to_hit: int | None = None, **kwargs) -> Character:
    weapon = Item(
        id="w", name="Blade", item_type=ItemType.weapon,
        damage_bonus=bonus, to_hit_bonus=to_hit,
    )
    return Character(
        id="atk", name="Attacker", entity_type=EntityType.player,
        hp=30, max_hp=30, abilities=AbilityScores(strength=3),
        inventory=[weapon], equipped_weapon="w", **kwargs,
    )


def test_unset_to_hit_bonus_mirrors_the_damage_bonus():
    """The historical single stat. A tier-6 weapon is +6 to hit AND +6 damage."""
    fighter = _armed(6)
    assert get_weapon_to_hit(fighter) == 6 == get_weapon_bonus(fighter)

    rng = random.Random(11)
    target = _punching_bag(ac=15)
    rolls = [
        next(e for e in resolve_attack(fighter, target, rng, t)[0]
             if e.event_type is EngineEventType.attack).data
        for t in range(400)
    ]
    # STR 3 + weapon 6 = +9, so the lowest possible total against a d20 is 10
    assert min(r["attack_roll"] for r in rolls) == 10
    assert max(r["attack_roll"] for r in rolls) == 29
    dmg = [r["damage"] for r in rolls if r["hit"] and not r["critical"]]
    assert (min(dmg), max(dmg)) == (7, 12)  # d6 + 6


def test_to_hit_bonus_can_be_set_apart_from_damage():
    """The reason for the split: a heavy weapon that hits hard and lands rarely."""
    heavy = _armed(6, to_hit=1)
    assert get_weapon_bonus(heavy) == 6
    assert get_weapon_to_hit(heavy) == 1

    rng = random.Random(11)
    target = _punching_bag(ac=15)
    rolls = [
        next(e for e in resolve_attack(heavy, target, rng, t)[0]
             if e.event_type is EngineEventType.attack).data
        for t in range(400)
    ]
    assert min(r["attack_roll"] for r in rolls) == 5  # STR 3 + weapon 1 = +4
    dmg = [r["damage"] for r in rolls if r["hit"] and not r["critical"]]
    assert (min(dmg), max(dmg)) == (7, 12)  # damage untouched by the to-hit cut


def test_loot_weapons_still_mirror_after_the_split():
    """Every weapon build.py and the prefabs produce leaves to_hit_bonus unset."""
    w = _world()
    weapons = [
        item
        for site in w.sites.values()
        for item in site.items.values()
        if item.item_type is ItemType.weapon
    ]
    assert weapons, "expected loot weapons to inspect"
    assert all(item.to_hit_bonus is None for item in weapons)


# ---------------------------------------------------------------------------
# Dodge
#
# Dodge announced itself and did nothing at all: no flag, no AC, mechanically
# identical to skipping the turn, while valid_actions and the Rogue's own
# description sold it as evasion. It is now +2 + DEX AC until your next turn —
# but only for an agent that chose it.
# ---------------------------------------------------------------------------


def _dodger(w):
    """One agent in a mob room, with the mob's turn still ahead of it."""
    a = _agents(w, 1)[0]
    site_id = _poi(w)
    room_key, mob_id = _first_mob_room(w, site_id)
    _teleport(w, a, site_id, room_key)
    _tick(w, {a.agent_id: {"action": "wait"}})
    a.character.hp = a.character.max_hp
    return a, mob_id, f"{site_id}:{room_key}"


def _mob_swings(events, mob_id):
    return [
        e for e in events
        if e.event_type is EngineEventType.attack
        and e.data.get("attacker_id") == mob_id
    ]


def test_dodge_raises_the_ac_attacks_roll_against():
    w = _world()
    a, mob_id, loc = _dodger(w)
    guarded = effective_ac(a.character) + dodge_ac_bonus(a.character)

    events = _tick(w, {a.agent_id: {"action": "dodge"}})
    assert a.agent_id in w.combats[loc].combat.dodging_ids

    swings = _mob_swings(events, mob_id)
    assert swings, "the mob should have swung this round"
    assert all(e.data["target_ac"] == guarded for e in swings)

    dodge_ev = next(e for e in events if e.event_type is EngineEventType.dodge)
    assert dodge_ev.data["ac_bonus"] == dodge_ac_bonus(a.character)
    assert dodge_ev.data["ac"] == guarded


def test_dodge_bonus_scales_with_dexterity():
    """The evasion half of DEX, promised by the stat design and never delivered."""
    nimble = Character(
        id="r", name="Rogue", entity_type=EntityType.player, hp=25, max_hp=25,
        ac=14, abilities=AbilityScores(dexterity=3),
    )
    lumbering = Character(
        id="b", name="Barbarian", entity_type=EntityType.player, hp=45, max_hp=45,
        ac=12, abilities=AbilityScores(dexterity=0),
    )
    assert dodge_ac_bonus(nimble) == 5   # AC 14 -> 19
    assert dodge_ac_bonus(lumbering) == 2  # AC 12 -> 14


def test_the_guard_lapses_on_the_dodgers_next_turn():
    w = _world()
    a, mob_id, loc = _dodger(w)
    _tick(w, {a.agent_id: {"action": "dodge"}})
    assert a.agent_id in w.combats[loc].combat.dodging_ids

    a.character.hp = a.character.max_hp
    events = _tick(w, {a.agent_id: {"action": "attack", "target": "nobody at all"}})
    assert a.agent_id not in w.combats[loc].combat.dodging_ids
    swings = _mob_swings(events, mob_id)
    assert swings
    assert all(e.data["target_ac"] == effective_ac(a.character) for e in swings)


def test_a_defaulted_dodge_grants_nothing():
    """Timing out must not be safer than acting."""
    w = _world()
    a, mob_id, loc = _dodger(w)

    events = _tick(w, {})  # silence -> timeout -> the engine's own dodge
    assert EngineEventType.action_timeout in _types(events)
    assert a.agent_id not in w.combats[loc].combat.dodging_ids

    dodge_ev = next(e for e in events if e.event_type is EngineEventType.dodge)
    assert dodge_ev.data["ac_bonus"] == 0
    assert "ac" not in dodge_ev.data
    swings = _mob_swings(events, mob_id)
    assert swings
    assert all(e.data["target_ac"] == effective_ac(a.character) for e in swings)


def test_a_rejected_action_does_not_earn_a_guard():
    """The fallback dodge after a bad verb is a spent turn, not free defence."""
    w = _world()
    a, mob_id, loc = _dodger(w)

    events = _tick(w, {a.agent_id: {"action": "search"}})  # illegal in combat
    assert EngineEventType.action_failed in _types(events)
    assert a.agent_id not in w.combats[loc].combat.dodging_ids
    swings = _mob_swings(events, mob_id)
    assert swings
    assert all(e.data["target_ac"] == effective_ac(a.character) for e in swings)


def test_an_agent_cannot_claim_a_guard_by_forging_a_key():
    """The defaulted flag rides beside the decisions, never inside them."""
    w = _world()
    a, mob_id, loc = _dodger(w)
    _tick(w, {a.agent_id: {"action": "dodge", "defaulted": True, "_defaulted": True}})
    # an agent's own keys are inert — it chose dodge, so it is guarded
    assert a.agent_id in w.combats[loc].combat.dodging_ids


def test_fleeing_drops_the_guard():
    w = _world()
    a, b, mob_id, loc = _coop_fight(w)
    a.character.hp = a.character.max_hp
    b.character.hp = b.character.max_hp
    _tick(w, {a.agent_id: {"action": "dodge"}, b.agent_id: {"action": "dodge"}})
    assert a.agent_id in w.combats[loc].combat.dodging_ids

    a.character.hp = a.character.max_hp
    b.character.hp = b.character.max_hp
    _tick(w, {a.agent_id: {"action": "flee"}, b.agent_id: {"action": "dodge"}})
    sc = w.combats.get(loc)
    if sc is not None:
        assert a.agent_id not in sc.combat.dodging_ids


def test_killing_a_poi_boss_does_not_win():
    w = _world()
    a = _agents(w, 1)[0]
    lair_id = next(
        (sid for sid, s in w.sites.items()
         if s.boss_id is not None and sid != w.boss_site_id),
        None,
    )
    assert lair_id is not None, "template pool includes a POI lair with a boss"
    site = w.sites[lair_id]
    boss = site.entities[site.boss_id]
    boss_room = f"{boss.position[0]},{boss.position[1]}"
    _teleport(w, a, lair_id, boss_room)
    room = site.map_grid.rooms[boss_room]
    for eid in list(room.entity_ids):
        if eid != site.boss_id:
            room.entity_ids.remove(eid)
    boss.hp = 1

    for _ in range(10):
        if not boss.is_alive:
            break
        _tick(w, {x.agent_id: ({"action": "attack", "target": boss.name}
                               if x.agent_id == a.agent_id else {"action": "wait"})
                  for x in w.living_agents()})
    assert not boss.is_alive
    assert w.phase == WorldPhase.running
    assert w.winner is None


def test_last_alive_ends_season():
    w = _world()
    agents = _agents(w)
    for x in agents[1:]:
        x.character.hp = 0
        x.character.is_alive = False
    events = _tick(w, {agents[0].agent_id: {"action": "wait"}})
    assert w.phase == WorldPhase.finished
    assert w.win_reason == "last_alive"
    assert w.winner == agents[0].agent_id
    assert EngineEventType.season_end in _types(events)


def test_timeout_tiebreak_prefers_kills():
    w = _world()
    agents = _agents(w)
    w.tick = w.config.max_ticks - 1
    agents[2].kills = 3
    events = _tick(w, {x.agent_id: {"action": "wait"} for x in agents})
    assert w.phase == WorldPhase.finished
    assert w.win_reason == "timeout"
    assert w.winner == agents[2].agent_id
    assert EngineEventType.season_end in _types(events)


def test_extinction_ends_with_no_winner():
    w = _world()
    agents = _agents(w)
    for x in agents:
        x.character.hp = 0
        x.character.is_alive = False
    _tick(w, {})
    assert w.phase == WorldPhase.finished
    assert w.win_reason == "extinction"
    assert w.winner is None


def _failures(events, code=None):
    return [
        e for e in events
        if e.event_type is EngineEventType.action_failed
        and (code is None or e.data.get("code") == code)
    ]


def test_an_attack_on_a_target_slain_this_round_says_so():
    """A live player targeted a 2 HP mob, a rival killed it earlier in the
    same initiative round, and the engine answered "no target called 'Sanctum
    Shadow' here" — indistinguishable from naming something imaginary. The
    turn is spent either way, but only one of those is the player's fault."""
    w = _world()
    a, b = _agents(w, 2)
    site_id = _poi(w)
    room_key, mob_id = _first_mob_room(w, site_id)
    _teleport(w, a, site_id, room_key)
    _teleport(w, b, site_id, room_key)
    mob = w.sites[site_id].entities[mob_id]
    mob.hp = 1  # whoever swings first this round ends it

    _tick(w, {a.agent_id: {"action": "wait"}, b.agent_id: {"action": "wait"}})
    mob.hp = 1
    events = _tick(w, {
        a.agent_id: {"action": "attack", "target": mob.name},
        b.agent_id: {"action": "attack", "target": mob.name},
    })

    voided = _failures(events, code="target_slain_this_round")
    assert voided, [e.description for e in _failures(events)]
    assert mob.name in voided[0].description
    assert "no target called" not in voided[0].description
    # the tick is still spent — this is a clearer message, not a free swing
    assert voided[0].data["action"] == "attack"


def test_a_target_that_was_never_there_still_fails_as_unknown():
    """The distinction has to cut both ways, or the new code is just noise."""
    w = _world()
    a, = _agents(w, 1)
    site_id = _poi(w)
    room_key, _ = _first_mob_room(w, site_id)
    _teleport(w, a, site_id, room_key)

    events = _tick(w, {a.agent_id: {"action": "attack", "target": "Gilgamesh"}})

    unknown = _failures(events, code="no_such_target")
    assert unknown, [e.data.get("code") for e in _failures(events)]
    assert "no target called 'Gilgamesh' here" in unknown[0].description


def test_a_death_on_an_earlier_tick_is_not_slain_this_round():
    """Guards the pruning: the memory is one tick deep, so a corpse from
    last turn reads as gone, not as freshly stolen."""
    w = _world()
    a, = _agents(w, 1)
    site_id = _poi(w)
    room_key, mob_id = _first_mob_room(w, site_id)
    _teleport(w, a, site_id, room_key)
    mob = w.sites[site_id].entities[mob_id]

    mob.hp = 1
    _tick(w, {a.agent_id: {"action": "attack", "target": mob.name}})
    assert not mob.is_alive, "the mob should be down"

    for _ in range(2):
        events = _tick(w, {a.agent_id: {"action": "attack", "target": mob.name}})

    assert not _failures(events, code="target_slain_this_round")
    assert w.recent_deaths == {} or all(
        rec.tick >= w.tick - 1 for rec in w.recent_deaths.values()
    )

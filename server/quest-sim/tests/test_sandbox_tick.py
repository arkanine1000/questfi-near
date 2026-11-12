"""Tick engine: determinism, verb legality, timeouts, fog isolation."""

from __future__ import annotations

from quest_sim.engine.sandbox.build import build_world, start_season
from quest_sim.engine.sandbox.perception import build_observation
from quest_sim.engine.sandbox.policy import policy_decide
from quest_sim.engine.sandbox.tick import run_world_tick
from quest_sim.models.events import EngineEventType
from quest_sim.models.overworld import HEX_DIRECTIONS, hex_key, parse_hex_key
from quest_sim.models.sandbox import SandboxConfig, WorldPhase


def _world(seed=7, pool=4, **cfg):
    w = build_world(SandboxConfig(pool_size=pool, **cfg), seed=seed)
    start_season(w)
    return w


def _first(w):
    return next(iter(w.agents.values()))


def _types(events):
    return [e.event_type for e in events]


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_same_seed_and_decisions_replay_identically():
    def play(seed):
        w = _world(seed=seed, pool=6)
        dump = []
        for _ in range(40):
            if w.phase != WorldPhase.running:
                break
            decisions = {a.agent_id: policy_decide(w, a.agent_id)
                         for a in w.living_agents()}
            events = run_world_tick(w, decisions)
            dump.extend(e.model_dump() for e in events)
        return dump, w

    d1, w1 = play(11)
    d2, w2 = play(11)
    assert d1 == d2
    assert w1.tick == w2.tick
    assert {a: x.character.hp for a, x in w1.agents.items()} == {
        a: x.character.hp for a, x in w2.agents.items()
    }


def test_different_seeds_diverge():
    def play(seed):
        w = _world(seed=seed, pool=6)
        dump = []
        for _ in range(30):
            decisions = {a.agent_id: policy_decide(w, a.agent_id)
                         for a in w.living_agents()}
            dump.extend(e.model_dump() for e in run_world_tick(w, decisions))
        return dump

    assert play(1) != play(2)


def test_events_are_seq_stamped_monotonically():
    w = _world()
    seqs = []
    for _ in range(5):
        decisions = {a.agent_id: {"action": "wait"} for a in w.living_agents()}
        seqs.extend(e.seq for e in run_world_tick(w, decisions))
    assert seqs == sorted(seqs)
    assert len(set(seqs)) == len(seqs)
    assert w.event_seq == seqs[-1]


# ---------------------------------------------------------------------------
# Verbs through the tick
# ---------------------------------------------------------------------------


def test_travel_moves_and_updates_occupancy():
    w = _world()
    a = _first(w)
    start_hex = a.position.hex
    q, r = parse_hex_key(start_hex)
    direction = next(
        d for d, (dq, dr) in HEX_DIRECTIONS.items()
        if w.overworld.get(q + dq, r + dr) is not None
    )
    events = run_world_tick(
        w, {a.agent_id: {"action": "travel", "direction": direction}}
    )
    assert EngineEventType.travel in _types(events)
    assert a.position.hex != start_hex
    assert a.agent_id not in w.overworld.get_key(start_hex).occupants
    assert a.agent_id in w.overworld.get_key(a.position.hex).occupants


def test_travel_into_open_sea_fails_loudly():
    w = _world()
    a = _first(w)
    q, r = parse_hex_key(a.position.hex)
    sea = next(
        (d for d, (dq, dr) in HEX_DIRECTIONS.items()
         if w.overworld.get(q + dq, r + dr) is None),
        None,
    )
    if sea is None:  # landlocked spawn — nothing to assert
        return
    start = a.position.hex
    events = run_world_tick(w, {a.agent_id: {"action": "travel", "direction": sea}})
    fails = [e for e in events if e.event_type is EngineEventType.action_failed]
    assert fails and "sea" in fails[0].description
    assert a.position.hex == start


def test_enter_exit_roundtrip():
    w = _world()
    a = _first(w)
    site_id = next(s for s in w.sites if s != w.boss_site_id)
    site = w.sites[site_id]
    mouth = list(site.entrances.values())[0]
    # place the agent on the mouth
    tile = w.overworld.get_key(a.position.hex)
    tile.occupants.remove(a.agent_id)
    q, r = parse_hex_key(mouth)
    from quest_sim.models.overworld import WorldPos
    a.position = WorldPos.at_hex(q, r)
    w.overworld.get_key(mouth).occupants.append(a.agent_id)

    events = run_world_tick(w, {a.agent_id: {"action": "enter"}})
    assert EngineEventType.site_enter in _types(events)
    assert a.position.kind == "dungeon"
    assert a.position.site_id == site_id
    assert a.position.room in site.entrances
    assert a.agent_id not in w.overworld.get_key(mouth).occupants
    # per-agent fog began
    assert a.position.room in a.visited[site_id]

    events = run_world_tick(w, {a.agent_id: {"action": "exit"}})
    assert EngineEventType.site_exit in _types(events)
    assert a.position.kind == "overworld"
    assert a.position.hex == mouth
    assert a.agent_id in w.overworld.get_key(mouth).occupants


def test_unknown_action_fails_loudly():
    w = _world()
    a = _first(w)
    events = run_world_tick(w, {a.agent_id: {"action": "moonwalk"}})
    fails = [e for e in events if e.event_type is EngineEventType.action_failed]
    assert fails and "unknown action" in fails[0].description


# ---------------------------------------------------------------------------
# Timeouts + thoughts
# ---------------------------------------------------------------------------


def test_missing_decision_times_out_with_default():
    w = _world()
    a = _first(w)
    events = run_world_tick(w, {})  # nobody submitted anything
    timeouts = [e for e in events if e.event_type is EngineEventType.action_timeout]
    assert {e.actor for e in timeouts} == {x.agent_id for x in w.agents.values()}
    # defaults applied: unthreatened surface agents wait
    assert any(e.event_type is EngineEventType.wait and e.actor == a.agent_id
               for e in events)
    assert w.tick == 1  # world advanced regardless


def test_thought_rides_along_as_event_and_state():
    w = _world()
    a = _first(w)
    events = run_world_tick(
        w, {a.agent_id: {"action": "wait", "thought": "I bide my time."}}
    )
    thoughts = [e for e in events if e.event_type is EngineEventType.agent_thought]
    assert thoughts and thoughts[0].data["thought"] == "I bide my time."
    assert a.last_thought == "I bide my time."
    assert a.last_action == "wait"


def test_dead_agents_do_not_act():
    w = _world()
    a = _first(w)
    a.character.hp = 0
    a.character.is_alive = False
    events = run_world_tick(w, {a.agent_id: {"action": "wait"}})
    assert not any(e.actor == a.agent_id for e in events)


# ---------------------------------------------------------------------------
# Per-agent fog isolation
# ---------------------------------------------------------------------------


def test_fog_is_per_agent():
    w = _world()
    agents = list(w.agents.values())
    a, b = agents[0], agents[1]
    site_id = next(s for s in w.sites if s != w.boss_site_id)
    site = w.sites[site_id]
    entrance_key = list(site.entrances)[0]

    from quest_sim.models.overworld import WorldPos
    r, c = (int(x) for x in entrance_key.split(","))
    tile = w.overworld.get_key(a.position.hex)
    tile.occupants.remove(a.agent_id)
    a.position = WorldPos.in_site(site_id, r, c)
    a.visited.setdefault(site_id, set()).add(entrance_key)

    # A explores a few rooms
    for _ in range(4):
        obs = build_observation(w, a.agent_id)
        exits = obs["location"].get("exits", {})
        if not exits:
            break
        direction = sorted(exits)[0]
        run_world_tick(w, {a.agent_id: {"action": "move", "direction": direction}})

    assert len(a.visited.get(site_id, set())) >= 2
    # B never entered: no knowledge of the site at all
    assert site_id not in b.visited
    obs_b = build_observation(w, b.agent_id)
    assert obs_b["map"] is None
    # the shared room.visited flags stay untouched (spectator fog is per-agent)
    assert all(not room.visited for room in site.map_grid.rooms.values())


def test_location_trail_records_both_ends_of_a_tick_and_prunes():
    """Per-agent event visibility places an event by where the agent stood on
    that event's tick. Two samples per tick is exact, not approximate: one
    action per tick and at most one hop per mover, so {start, end} is the
    complete occupancy set."""
    from quest_sim.engine.sandbox.tick import LOC_TRAIL_TICKS

    w = _world()
    a = next(iter(w.agents.values()))
    start = a.loc_key

    run_world_tick(w, {a.agent_id: {"action": "travel", "direction": "E"}})

    trail = a.loc_trail[str(w.tick)]
    assert start in trail, "the tick's starting position was not recorded"
    assert a.loc_key in trail, "the tick's ending position was not recorded"

    for _ in range(LOC_TRAIL_TICKS + 2):
        run_world_tick(w, {})
    assert all(
        int(k) > w.tick - LOC_TRAIL_TICKS - 1 for k in a.loc_trail
    ), f"trail was not pruned: {sorted(a.loc_trail)}"
    assert len(a.loc_trail) <= LOC_TRAIL_TICKS + 1

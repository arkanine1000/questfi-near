"""Policy fleet: full seasons terminate; dispositions behave in character."""

from __future__ import annotations

import pytest

from quest_sim.engine.sandbox.build import build_world, start_season
from quest_sim.engine.sandbox.policy import policy_decide
from quest_sim.engine.sandbox.tick import run_world_tick
from quest_sim.models.overworld import WorldPos
from quest_sim.models.sandbox import SandboxConfig, WorldPhase


def _play_season(seed: int, pool: int = 10, max_ticks: int = 300):
    w = build_world(SandboxConfig(pool_size=pool, max_ticks=max_ticks), seed=seed)
    start_season(w)
    while w.phase == WorldPhase.running:
        decisions = {a.agent_id: policy_decide(w, a.agent_id)
                     for a in w.living_agents()}
        run_world_tick(w, decisions)
        assert w.tick <= max_ticks + 1, "season failed to terminate"
    return w


@pytest.mark.parametrize("seed", [1, 7, 42])
def test_full_policy_season_terminates(seed):
    w = _play_season(seed)
    assert w.phase == WorldPhase.finished
    assert w.win_reason in {"boss", "last_alive", "timeout", "extinction"}
    if w.win_reason != "extinction":
        assert w.winner is not None
        assert w.winner_name == w.agents[w.winner].name


def test_seasons_vary_by_seed():
    outcomes = {(w.winner_name, w.tick) for w in (_play_season(s) for s in (1, 7, 42))}
    assert len(outcomes) >= 2


def _combat_setup(disposition: str):
    w = build_world(SandboxConfig(pool_size=4), seed=7)
    start_season(w)
    a = list(w.agents.values())[0]
    a.disposition = disposition
    site_id = next(s for s in w.sites if s != w.boss_site_id)
    site = w.sites[site_id]
    room_key = next(
        key for key in sorted(site.map_grid.rooms)
        if any(site.entities.get(e) is not None and site.entities[e].is_alive
               for e in site.map_grid.rooms[key].entity_ids)
    )
    tile = w.overworld.get_key(a.position.hex)
    tile.occupants.remove(a.agent_id)
    r, c = (int(x) for x in room_key.split(","))
    a.position = WorldPos.in_site(site_id, r, c)
    a.visited.setdefault(site_id, set()).add(room_key)
    run_world_tick(w, {a.agent_id: {"action": "wait"}})  # ignite
    return w, a


def test_cautious_flees_when_bloodied():
    w, a = _combat_setup("cautious")
    a.character.hp = int(a.character.max_hp * 0.3)  # below flee_at=0.5
    # ensure no potion muddies the decision
    a.character.inventory = [i for i in a.character.inventory if i.heal_amount == 0]
    decision = policy_decide(w, a.agent_id)
    assert decision["action"] == "flee"


def test_wounded_policy_drinks_first():
    w, a = _combat_setup("balanced")
    from quest_sim.models.character import Item, ItemType
    a.character.inventory.append(
        Item(id=f"{a.agent_id}.potion", name="Healing Draught",
             item_type=ItemType.potion, heal_amount=8, consumable=True)
    )
    a.character.hp = int(a.character.max_hp * 0.2)
    decision = policy_decide(w, a.agent_id)
    assert decision["action"] == "use_item"
    assert decision["item"] == "Healing Draught"


def test_aggressive_hunts_the_weak():
    w = build_world(SandboxConfig(pool_size=4), seed=7)
    start_season(w)
    agents = list(w.agents.values())
    hunter, prey = agents[0], agents[1]
    hunter.disposition = "aggressive"
    site_id = next(s for s in w.sites if s != w.boss_site_id)
    site = w.sites[site_id]
    room_key = next(
        key for key in sorted(site.map_grid.rooms)
        if not site.map_grid.rooms[key].entity_ids
        and site.map_grid.rooms[key].trap_dc is None
    )
    for agent in (hunter, prey):
        tile = w.overworld.get_key(agent.position.hex)
        if tile and agent.agent_id in tile.occupants:
            tile.occupants.remove(agent.agent_id)
        r, c = (int(x) for x in room_key.split(","))
        agent.position = WorldPos.in_site(site_id, r, c)
        agent.visited.setdefault(site_id, set()).add(room_key)
    hunter.character.hp = hunter.character.max_hp
    prey.character.hp = max(1, prey.character.max_hp // 4)

    decision = policy_decide(w, hunter.agent_id)
    assert decision == {"action": "attack", "target": prey.name} or (
        decision.get("action") == "attack" and decision.get("target") == prey.name
    )


def test_no_policy_ever_attacks_on_the_surface():
    """The truce is structural: co-located surface rivals never draw a policy attack."""
    w = build_world(SandboxConfig(pool_size=4), seed=7)
    start_season(w)
    agents = list(w.agents.values())
    a, b = agents[0], agents[1]
    tile = w.overworld.get_key(b.position.hex)
    if tile and b.agent_id in tile.occupants:
        tile.occupants.remove(b.agent_id)
    from quest_sim.models.overworld import parse_hex_key
    b.position = WorldPos.at_hex(*parse_hex_key(a.position.hex))
    w.overworld.get_key(a.position.hex).occupants.append(b.agent_id)
    b.character.hp = 1  # maximum temptation

    for disposition in ("aggressive", "opportunist", "greedy"):
        a.disposition = disposition
        decision = policy_decide(w, a.agent_id)
        assert decision["action"] != "attack", disposition


def test_policy_pushes_boss_when_geared():
    w = build_world(SandboxConfig(pool_size=4), seed=7)
    start_season(w)
    a = list(w.agents.values())[0]
    a.disposition = "aggressive"
    from quest_sim.models.character import Item, ItemType
    a.character.inventory.append(
        Item(id=f"{a.agent_id}.greatblade", name="Greatblade",
             item_type=ItemType.weapon, damage_bonus=6)
    )
    decision = policy_decide(w, a.agent_id)
    # geared → march on the center (or descend if already on the mouth)
    assert decision["action"] in {"travel", "enter", "equip"}

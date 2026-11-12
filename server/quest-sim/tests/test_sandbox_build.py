"""Season world construction: determinism, layout fairness, roster rules."""

from __future__ import annotations

import math

import pytest

from quest_sim.content.island_tiles import ISLAND_TILES
from quest_sim.engine.sandbox.build import (
    AGENT_PALETTE,
    _angle_from,
    build_world,
    backfill_hosted,
    create_agent,
    start_season,
)
from quest_sim.models.character import EntityType
from quest_sim.models.overworld import TerrainType, hex_distance, parse_hex_key
from quest_sim.models.sandbox import SandboxConfig, WorldPhase


def _world(seed: int = 7, **cfg) -> object:
    return build_world(SandboxConfig(**cfg), seed=seed)


def test_build_is_deterministic_per_seed():
    a, b = _world(seed=11), _world(seed=11)
    assert a.center_hex == b.center_hex
    assert list(a.sites) == list(b.sites)
    for sid in a.sites:
        assert a.sites[sid].model_dump() == b.sites[sid].model_dump()
    assert {k: t.terrain for k, t in a.overworld.tiles.items()} == {
        k: t.terrain for k, t in b.overworld.tiles.items()
    }


def test_different_seeds_differ():
    a, b = _world(seed=1), _world(seed=2)
    assert list(a.sites[s].entrances for s in a.sites) != list(
        b.sites[s].entrances for s in b.sites
    )


def test_boss_site_at_centroid():
    w = _world()
    boss = w.sites[w.boss_site_id]
    assert w.center_hex in boss.entrances.values()
    assert boss.boss_id is not None
    assert boss.boss_id.startswith("boss_site.")
    assert boss.boss_id in boss.entities
    # centroid is the tile minimising total distance — spot-check it beats neighbours
    cq, cr = parse_hex_key(w.center_hex)
    total = sum(hex_distance(cq, cr, q, r) for q, r in ISLAND_TILES)
    for q, r in ISLAND_TILES:
        assert total <= sum(hex_distance(q, r, q2, r2) for q2, r2 in ISLAND_TILES)


def test_poi_sites_on_mid_rings_with_spacing():
    w = _world()
    cfg = w.config
    cq, cr = parse_hex_key(w.center_hex)
    mouths = []
    for sid, site in w.sites.items():
        if sid == w.boss_site_id:
            continue
        primary = list(site.entrances.values())[0]
        q, r = parse_hex_key(primary)
        d = hex_distance(q, r, cq, cr)
        assert cfg.site_ring_min <= d <= cfg.site_ring_max, (sid, d)
        mouths.append((q, r))
    for i, m in enumerate(mouths):
        for m2 in mouths[i + 1 :]:
            assert hex_distance(m[0], m[1], m2[0], m2[1]) >= cfg.site_min_spacing


def test_mouth_tiles_marked_on_overworld():
    w = _world()
    for site in w.sites.values():
        for hexk in site.entrances.values():
            tile = w.overworld.get_key(hexk)
            assert tile is not None
            assert tile.terrain == TerrainType.dungeon_mouth
            assert tile.site_id == site.site_id


def test_site_ids_namespaced_and_collision_free():
    w = _world()
    all_entity_ids: set[str] = set()
    all_item_ids: set[str] = set()
    for sid, site in w.sites.items():
        for eid, char in site.entities.items():
            assert eid.startswith(f"{sid}.")
            assert char.id == eid
            assert char.entity_type != EntityType.npc
            all_entity_ids.add(eid)
        for iid in site.items:
            assert iid.startswith(f"{sid}.")
            all_item_ids.add(iid)
        for room in site.map_grid.rooms.values():
            assert not room.visited and not room.searched
            for eid in room.entity_ids:
                assert eid in site.entities
            for tid in room.treasure_item_ids:
                assert tid in site.items
    # Sites share templates, ids must still never collide
    assert len(all_entity_ids) == sum(len(s.entities) for s in w.sites.values())
    assert len(all_item_ids) == sum(len(s.items) for s in w.sites.values())


def test_multi_entrance_sites_map_distinct_hexes():
    w = _world()
    multi = [s for s in w.sites.values() if len(s.entrances) > 1]
    assert multi, "template pool includes multi-entrance dungeons"
    for site in multi:
        hexes = list(site.entrances.values())
        assert len(set(hexes)) == len(hexes)


def test_join_assigns_color_id_token_by_order():
    w = _world()
    a1 = create_agent(w, name="Atlas", brain="external")
    a2 = create_agent(w, name="Nova", brain="external")
    assert (a1.agent_id, a2.agent_id) == ("agent-01", "agent-02")
    assert a1.color == AGENT_PALETTE[0] and a2.color == AGENT_PALETTE[1]
    assert a1.token and a2.token and a1.token != a2.token


def test_join_name_sanitation_and_uniqueness():
    w = _world()
    a1 = create_agent(w, name="  Atlas  ")
    a2 = create_agent(w, name="atlas")
    a3 = create_agent(w, name=None)
    assert a1.name == "Atlas"
    assert a2.name == "atlas 2"
    assert a3.name.startswith("Challenger")


def test_join_rejects_bad_preset_and_full_roster():
    w = _world(pool_size=2)
    with pytest.raises(ValueError, match="unknown preset"):
        create_agent(w, name="X", preset="wizard")
    create_agent(w, name="A")
    create_agent(w, name="B")
    with pytest.raises(ValueError, match="roster is full"):
        create_agent(w, name="C")


def test_backfill_skips_taken_names_and_fills_pool():
    w = _world(pool_size=6)
    create_agent(w, name="Kell", brain="external")  # collides with roster seat
    added = backfill_hosted(w)
    assert len(w.agents) == 6
    assert all(a.brain == "hosted" for a in added)
    assert all(not a.token for a in added)
    names = [a.name.lower() for a in w.agents.values()]
    assert len(set(names)) == len(names)


def test_start_season_spawns_equidistant_dispersed_and_seed_rotated():
    rings = set()
    for seed in (1, 7, 42):
        w = build_world(SandboxConfig(pool_size=10), seed=seed)
        create_agent(w, name="Atlas", brain="external")
        start_season(w)
        assert w.phase == WorldPhase.running
        assert len(w.agents) == 10
        assert len(w.spawn_ring) == 10
        assert len(set(w.spawn_ring)) == 10

        cq, cr = parse_hex_key(w.center_hex)
        dists = {hex_distance(*parse_hex_key(k), cq, cr) for k in w.spawn_ring}
        assert len(dists) == 1, f"spawns not equidistant: {dists}"

        angles = sorted(
            _angle_from((cq, cr), parse_hex_key(k)) % (2 * math.pi)
            for k in w.spawn_ring
        )
        gaps = [
            (angles[(i + 1) % len(angles)] - angles[i]) % (2 * math.pi)
            for i in range(len(angles))
        ]
        assert max(gaps) <= math.radians(75), "spawns bunch on one coast"

        # no spawning on a dungeon mouth
        for k in w.spawn_ring:
            assert w.overworld.get_key(k).site_id is None

        # agents landed and tiles know their occupants
        for agent in w.agents.values():
            assert agent.spawn_hex in w.spawn_ring
            assert agent.position.hex == agent.spawn_hex
            assert agent.agent_id in w.overworld.get_key(agent.spawn_hex).occupants

        rings.add(tuple(w.spawn_ring))
    assert len(rings) == 3, "spawn ring should rotate with the seed"


def test_start_season_only_once():
    w = _world()
    start_season(w)
    with pytest.raises(ValueError, match="already started"):
        start_season(w)


def test_join_after_start_rejected():
    w = _world()
    start_season(w)
    with pytest.raises(ValueError, match="lobby"):
        create_agent(w, name="Late")


def test_misc_quest_tokens_become_wearable_relics():
    """Solo objective tokens (crowns, seals) must not be inert loot here —
    an agent who equips one should get something for it."""
    from quest_sim.models.character import ItemType

    w = _world()
    misc = [i for s in w.sites.values() for i in s.items.values()
            if i.item_type == ItemType.misc]
    assert misc == [], "no inert quest tokens in sandbox sites"
    relics = [i for s in w.sites.values() for i in s.items.values()
              if i.item_type == ItemType.shield and "relic" in i.description]
    assert relics, "crown/seal converted to wearable relics"
    assert all(i.ac_bonus >= 1 for i in relics)


def test_sandbox_weapons_outclass_starter_kits():
    from quest_sim.models.character import ItemType

    w = _world()
    for site in w.sites.values():
        for item in site.items.values():
            if item.item_type == ItemType.weapon:
                assert item.damage_bonus >= 3, (site.site_id, item.name)


@pytest.mark.parametrize("seed", [3, 7, 11, 29])
def test_war_accordion_survives_the_loot_retier(seed):
    """The easter egg keeps its name, or the crawler stops recognising it.

    _retier_weapon renames every prefab weapon to an archetype ("Runed
    Greatsword"). The frontend picks the accordion viewmodel by matching
    that name, so a re-tiered accordion would silently render as a
    broadsword with nothing failing anywhere.
    """
    w = _world(seed=seed)
    found = [
        item
        for site in w.sites.values()
        for item in site.items.values()
        if item.id.endswith(".war_accordion")
    ]
    assert len(found) == 1, [i.id for i in found]
    accordion = found[0]
    assert accordion.name == "War Accordion"
    assert accordion.damage_bonus == 5
    # Unset, so get_weapon_to_hit mirrors damage_bonus — +5/+5 with no
    # second stat to keep in sync, and _item_label stays truthful.
    assert accordion.to_hit_bonus is None

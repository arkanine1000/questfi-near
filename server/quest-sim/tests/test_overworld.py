"""Overworld hex model + baked island mirror — FE parity is the contract."""

from __future__ import annotations

from quest_sim.content.island_tiles import ISLAND_ELEVATIONS, ISLAND_TILES
from quest_sim.models.overworld import (
    HEX_DIRECTIONS,
    HEX_NEIGHBOR_OFFSETS,
    HexGrid,
    OverworldTile,
    WorldPos,
    hex_distance,
    hex_key,
    hex_neighbors,
    location_key,
    parse_hex_key,
)

# Pinned copy of quest-map/src/components/HexGrid/hexUtils.js getHexNeighbors().
# If this test fails, the FE and BE disagree on adjacency — fix the FE mirror,
# never this fixture, without checking hexUtils.js first.
FE_NEIGHBOR_OFFSETS = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, -1), (-1, 1)]


def test_neighbor_offsets_match_frontend():
    assert HEX_NEIGHBOR_OFFSETS == FE_NEIGHBOR_OFFSETS


def test_directions_cover_all_offsets():
    assert sorted(HEX_DIRECTIONS.values()) == sorted(HEX_NEIGHBOR_OFFSETS)
    assert set(HEX_DIRECTIONS) == {"E", "W", "SE", "NW", "NE", "SW"}


def test_island_mask_size_and_shape():
    assert len(ISLAND_TILES) == 120
    assert len(set(ISLAND_TILES)) == 120
    # Elevations cover every tile with a sane normalised value
    for q, r in ISLAND_TILES:
        elev = ISLAND_ELEVATIONS[hex_key(q, r)]
        assert 0.0 <= elev <= 1.0


def test_hex_key_roundtrip():
    for q, r in [(0, 0), (13, 4), (-2, 7)]:
        assert parse_hex_key(hex_key(q, r)) == (q, r)


def test_hex_distance_axial():
    assert hex_distance(0, 0, 0, 0) == 0
    assert hex_distance(0, 0, 1, 0) == 1
    assert hex_distance(0, 0, 1, -1) == 1
    assert hex_distance(0, 0, 2, -1) == 2
    assert hex_distance(3, 1, 6, 7) == hex_distance(6, 7, 3, 1)


def test_hex_neighbors_order_matches_offsets():
    assert hex_neighbors(4, 5) == [(4 + dq, 5 + dr) for dq, dr in HEX_NEIGHBOR_OFFSETS]


def test_world_pos_addressing_and_location_key():
    surface = WorldPos.at_hex(3, 1)
    assert surface.kind == "overworld"
    assert location_key(surface) == "hex:3,1"

    inside = WorldPos.in_site("site_2", 4, 1)
    assert inside.kind == "dungeon"
    assert location_key(inside) == "site_2:4,1"

    # Co-location means equal keys; different rooms differ
    assert location_key(WorldPos.in_site("site_2", 4, 1)) == location_key(inside)
    assert location_key(WorldPos.in_site("site_2", 0, 1)) != location_key(inside)


def test_hexgrid_neighbors_respect_mask():
    grid = HexGrid()
    grid.set(OverworldTile(q=0, r=0))
    grid.set(OverworldTile(q=1, r=0))
    names = [t.key for t in grid.neighbors(0, 0)]
    assert names == ["1,0"]

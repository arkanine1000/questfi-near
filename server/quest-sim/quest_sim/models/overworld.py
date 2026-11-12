"""Overworld spatial model for the multi-agent sandbox world.

The *overworld* layer — a pointy-top axial hex grid that sits above the
existing square ``MapGrid`` dungeon interiors (`models/map.py`). The two
layers are addressed uniformly by :class:`WorldPos`.

The hex neighbour scheme **must** match the frontend's ``getHexNeighbors`` in
``quest-map/src/components/HexGrid/hexUtils.js`` so the backend
(authoritative) and the renderer agree on adjacency.

This module is additive: nothing in the single-player engine imports it.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field

from quest_sim.models.character import Item


class TerrainType(str, Enum):
    """Overworld tile flavour. Drives the FE surface-view biome shells and
    the agent-facing surroundings text; ``dungeon_mouth`` tiles host a
    dungeon interior."""

    plain = "plain"
    valley = "valley"
    clearing = "clearing"
    forest = "forest"
    dungeon_mouth = "dungeon_mouth"


# Pointy-top axial hex, 6 neighbours. Mirrors the frontend getHexNeighbors():
#   (q+1,r) (q-1,r) (q,r+1) (q,r-1) (q+1,r-1) (q-1,r+1)
HEX_NEIGHBOR_OFFSETS: list[tuple[int, int]] = [
    (1, 0),
    (-1, 0),
    (0, 1),
    (0, -1),
    (1, -1),
    (-1, 1),
]

# Named pointy-top axial directions for agent `travel` actions, consistent
# with HEX_NEIGHBOR_OFFSETS and the FE pixel layout (E/W along q; the
# diagonals span r).
HEX_DIRECTIONS: dict[str, tuple[int, int]] = {
    "E": (1, 0),
    "W": (-1, 0),
    "SE": (0, 1),
    "NW": (0, -1),
    "NE": (1, -1),
    "SW": (-1, 1),
}


def hex_key(q: int, r: int) -> str:
    """Stable dict key for an axial coordinate (mirrors MapGrid's 'row,col')."""
    return f"{q},{r}"


def parse_hex_key(key: str) -> tuple[int, int]:
    """Inverse of :func:`hex_key`."""
    q_str, r_str = key.split(",")
    return int(q_str), int(r_str)


def hex_neighbors(q: int, r: int) -> list[tuple[int, int]]:
    """The 6 axial neighbours of ``(q, r)`` — order matches the FE offsets."""
    return [(q + dq, r + dr) for dq, dr in HEX_NEIGHBOR_OFFSETS]


def hex_distance(q1: int, r1: int, q2: int, r2: int) -> int:
    """Axial hex distance (minimum steps between two hexes)."""
    return (abs(q1 - q2) + abs(r1 - r2) + abs((q1 + r1) - (q2 + r2))) // 2


class WorldPos(BaseModel):
    """Unified address across both spatial layers.

    - overworld: ``kind='overworld'`` with ``hex`` set.
    - dungeon:   ``kind='dungeon'`` with ``site_id`` + ``room`` set.
    """

    kind: str = "overworld"  # "overworld" | "dungeon"
    hex: str | None = None  # "q,r" when kind == "overworld"
    site_id: str | None = None  # when kind == "dungeon"
    room: str | None = None  # "row,col" when kind == "dungeon"

    @classmethod
    def at_hex(cls, q: int, r: int) -> WorldPos:
        return cls(kind="overworld", hex=hex_key(q, r))

    @classmethod
    def in_site(cls, site_id: str, row: int, col: int) -> WorldPos:
        return cls(kind="dungeon", site_id=site_id, room=f"{row},{col}")


def location_key(pos: WorldPos) -> str:
    """Canonical co-location key: agents sharing this key share a place.

    ``hex:q,r`` on the surface, ``site_id:row,col`` inside a dungeon. Used
    for group formation, combat containers, and event routing.
    """
    if pos.kind == "dungeon":
        return f"{pos.site_id}:{pos.room}"
    return f"hex:{pos.hex}"


class OverworldTile(BaseModel):
    """One hex on the overworld."""

    q: int
    r: int
    terrain: TerrainType = TerrainType.plain
    site_id: str | None = None  # set when this tile hosts a dungeon mouth
    occupants: list[str] = Field(default_factory=list)  # agent ids on this tile
    ground_items: list[Item] = Field(default_factory=list)  # dropped loot

    @property
    def key(self) -> str:
        return hex_key(self.q, self.r)


class HexGrid(BaseModel):
    """The overworld hex map, keyed by 'q,r' (pointy-top axial)."""

    tiles: dict[str, OverworldTile] = Field(default_factory=dict)

    def get(self, q: int, r: int) -> OverworldTile | None:
        return self.tiles.get(hex_key(q, r))

    def get_key(self, key: str) -> OverworldTile | None:
        return self.tiles.get(key)

    def set(self, tile: OverworldTile) -> None:
        self.tiles[tile.key] = tile

    def neighbors(self, q: int, r: int) -> list[OverworldTile]:
        """Existing neighbour tiles (those present in the island mask)."""
        result: list[OverworldTile] = []
        for nq, nr in hex_neighbors(q, r):
            tile = self.get(nq, nr)
            if tile is not None:
                result.append(tile)
        return result

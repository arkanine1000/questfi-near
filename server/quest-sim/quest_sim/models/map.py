from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class RoomType(str, Enum):
    empty = "empty"
    corridor = "corridor"
    chamber = "chamber"
    boss_room = "boss_room"
    trap_room = "trap_room"
    treasure_room = "treasure_room"
    entrance = "entrance"


class Direction(str, Enum):
    N = "N"
    S = "S"
    E = "E"
    W = "W"


DIRECTION_OFFSETS: dict[Direction, tuple[int, int]] = {
    Direction.N: (-1, 0),
    Direction.S: (1, 0),
    Direction.E: (0, 1),
    Direction.W: (0, -1),
}

OPPOSITE_DIRECTION: dict[Direction, Direction] = {
    Direction.N: Direction.S,
    Direction.S: Direction.N,
    Direction.E: Direction.W,
    Direction.W: Direction.E,
}


class Room(BaseModel):
    row: int
    col: int
    room_type: RoomType = RoomType.empty
    connections: dict[Direction, bool] = Field(default_factory=dict)
    entity_ids: list[str] = Field(default_factory=list)
    trap_dc: int | None = None
    trap_damage: int = 0
    trap_triggered: bool = False
    search_dc: int | None = None
    searched: bool = False
    treasure_item_ids: list[str] = Field(default_factory=list)
    description: str = ""
    visited: bool = False

    @property
    def coord_key(self) -> str:
        return f"{self.row},{self.col}"


class MapGrid(BaseModel):
    rows: int
    cols: int
    rooms: dict[str, Room] = Field(default_factory=dict)  # keyed by "row,col"

    def get_room(self, row: int, col: int) -> Room | None:
        return self.rooms.get(f"{row},{col}")

    def set_room(self, room: Room) -> None:
        self.rooms[room.coord_key] = room

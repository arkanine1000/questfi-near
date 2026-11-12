from __future__ import annotations

from collections import deque

from quest_sim.models.map import (
    DIRECTION_OFFSETS,
    OPPOSITE_DIRECTION,
    Direction,
    MapGrid,
    Room,
    RoomType,
)
from quest_sim.models.quest import QuestDefinition


def get_adjacent_coords(
    row: int, col: int, rows: int, cols: int
) -> list[tuple[Direction, int, int]]:
    """Get valid adjacent coordinates within grid bounds."""
    result = []
    for direction, (dr, dc) in DIRECTION_OFFSETS.items():
        nr, nc = row + dr, col + dc
        if 0 <= nr < rows and 0 <= nc < cols:
            result.append((direction, nr, nc))
    return result


def build_map_from_quest(quest: QuestDefinition) -> MapGrid:
    """Build the final MapGrid from the quest definition.

    Ensures all rooms referenced in quest are present in the grid
    and sets up bidirectional connections.
    """
    grid = quest.grid
    # Ensure entrance room exists
    er, ec = quest.entrance_position
    entrance_key = f"{er},{ec}"
    if entrance_key not in grid.rooms:
        grid.rooms[entrance_key] = Room(
            row=er, col=ec, room_type=RoomType.entrance, visited=True
        )
    else:
        grid.rooms[entrance_key].room_type = RoomType.entrance
        grid.rooms[entrance_key].visited = True
    return grid


def validate_map_connected(grid: MapGrid, start: tuple[int, int]) -> bool:
    """BFS from start to verify all rooms with content are reachable via connections."""
    start_key = f"{start[0]},{start[1]}"
    if start_key not in grid.rooms:
        return False

    visited: set[str] = set()
    queue: deque[str] = deque([start_key])
    visited.add(start_key)

    while queue:
        key = queue.popleft()
        room = grid.rooms[key]
        for direction, connected in room.connections.items():
            if not connected:
                continue
            dr, dc = DIRECTION_OFFSETS[direction]
            nr, nc = room.row + dr, room.col + dc
            nkey = f"{nr},{nc}"
            if nkey in grid.rooms and nkey not in visited:
                visited.add(nkey)
                queue.append(nkey)

    # All rooms that exist must be reachable
    return visited == set(grid.rooms.keys())


def connect_rooms(
    grid: MapGrid, r1: int, c1: int, r2: int, c2: int
) -> bool:
    """Create a bidirectional connection between two adjacent rooms.
    Returns True if connection was made, False if rooms aren't adjacent or don't exist.
    """
    k1, k2 = f"{r1},{c1}", f"{r2},{c2}"
    if k1 not in grid.rooms or k2 not in grid.rooms:
        return False

    dr, dc = r2 - r1, c2 - c1
    direction = None
    for d, (odr, odc) in DIRECTION_OFFSETS.items():
        if (odr, odc) == (dr, dc):
            direction = d
            break
    if direction is None:
        return False  # not adjacent

    grid.rooms[k1].connections[direction] = True
    grid.rooms[k2].connections[OPPOSITE_DIRECTION[direction]] = True
    return True

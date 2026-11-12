from __future__ import annotations

from quest_sim.engine.map_builder import (
    build_map_from_quest,
    connect_rooms,
    get_adjacent_coords,
    validate_map_connected,
)
from quest_sim.models.map import Direction, MapGrid, Room, RoomType
from quest_sim.models.quest import QuestDefinition


def test_get_adjacent_coords_center():
    adj = get_adjacent_coords(1, 1, 3, 3)
    assert len(adj) == 4  # all four directions valid


def test_get_adjacent_coords_corner():
    adj = get_adjacent_coords(0, 0, 3, 3)
    assert len(adj) == 2  # only S and E


def test_connect_rooms():
    grid = MapGrid(rows=3, cols=3)
    grid.rooms["0,0"] = Room(row=0, col=0, room_type=RoomType.entrance)
    grid.rooms["0,1"] = Room(row=0, col=1, room_type=RoomType.corridor)

    result = connect_rooms(grid, 0, 0, 0, 1)
    assert result is True
    assert grid.rooms["0,0"].connections[Direction.E] is True
    assert grid.rooms["0,1"].connections[Direction.W] is True


def test_connect_rooms_non_adjacent():
    grid = MapGrid(rows=3, cols=3)
    grid.rooms["0,0"] = Room(row=0, col=0)
    grid.rooms["2,2"] = Room(row=2, col=2)

    result = connect_rooms(grid, 0, 0, 2, 2)
    assert result is False


def test_validate_map_connected():
    grid = MapGrid(rows=3, cols=3)
    grid.rooms["0,0"] = Room(row=0, col=0, room_type=RoomType.entrance)
    grid.rooms["0,1"] = Room(row=0, col=1, room_type=RoomType.corridor)
    grid.rooms["1,1"] = Room(row=1, col=1, room_type=RoomType.chamber)

    connect_rooms(grid, 0, 0, 0, 1)
    connect_rooms(grid, 0, 1, 1, 1)

    assert validate_map_connected(grid, (0, 0)) is True


def test_validate_map_disconnected():
    grid = MapGrid(rows=3, cols=3)
    grid.rooms["0,0"] = Room(row=0, col=0, room_type=RoomType.entrance)
    grid.rooms["2,2"] = Room(row=2, col=2, room_type=RoomType.chamber)

    # No connections
    assert validate_map_connected(grid, (0, 0)) is False


def test_validate_map_connected_dead_end():
    """A reachable dead-end room (no outgoing connections) still counts as connected."""
    grid = MapGrid(rows=3, cols=3)
    grid.rooms["0,0"] = Room(row=0, col=0, room_type=RoomType.entrance)
    grid.rooms["0,1"] = Room(row=0, col=1, room_type=RoomType.chamber)
    grid.rooms["0,2"] = Room(row=0, col=2, room_type=RoomType.treasure_room)
    connect_rooms(grid, 0, 0, 0, 1)
    connect_rooms(grid, 0, 1, 0, 2)
    # Remove 0,2's westward connection — makes it a dead end
    del grid.rooms["0,2"].connections[Direction.W]
    # BFS can still reach 0,2 via 0,1's E flag
    assert validate_map_connected(grid, (0, 0)) is True


def test_validate_map_connected_asymmetric_connection():
    """BFS traverses a one-way flag: A→B reachable even if B has no back-connection."""
    grid = MapGrid(rows=2, cols=2)
    grid.rooms["0,0"] = Room(row=0, col=0, room_type=RoomType.entrance)
    grid.rooms["0,1"] = Room(row=0, col=1, room_type=RoomType.chamber)
    # Only set A→B, not B→A
    grid.rooms["0,0"].connections[Direction.E] = True
    assert validate_map_connected(grid, (0, 0)) is True


def test_validate_map_connected_missing_start():
    """Returns False immediately when the start position has no room."""
    grid = MapGrid(rows=3, cols=3)
    grid.rooms["1,1"] = Room(row=1, col=1, room_type=RoomType.chamber)
    assert validate_map_connected(grid, (0, 0)) is False


def test_build_map_from_quest():
    grid = MapGrid(rows=5, cols=5)
    grid.rooms["0,0"] = Room(row=0, col=0)
    grid.rooms["0,1"] = Room(row=0, col=1, room_type=RoomType.corridor)

    quest = QuestDefinition(grid=grid, entrance_position=(0, 0))
    result_grid = build_map_from_quest(quest)

    assert result_grid.rooms["0,0"].room_type == RoomType.entrance
    assert result_grid.rooms["0,0"].visited is True

"""Tests for StoredQuest persistence (Milestone 2)."""

from __future__ import annotations

from pathlib import Path

import pytest

from quest_sim.engine.map_builder import connect_rooms
from quest_sim.models.character import AbilityScores, Character, EntityType
from quest_sim.models.map import MapGrid, Room, RoomType
from quest_sim.models.quest import Objective, ObjectiveType, QuestDefinition
from quest_sim.persistence.quest_store import (
    StoredQuest,
    list_quests,
    list_quests_with_metadata,
    load_quest,
    save_quest,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def tmp_data_dir(tmp_path: Path) -> Path:
    return tmp_path / "games"


@pytest.fixture
def minimal_stored_quest() -> StoredQuest:
    """A minimal StoredQuest with one room and one hostile."""
    goblin = Character(
        id="goblin_1",
        name="Goblin",
        entity_type=EntityType.hostile,
        hp=8,
        max_hp=8,
        ac=10,
        abilities=AbilityScores(strength=1, dexterity=1),
        position=(0, 1),
    )
    room_entrance = Room(row=0, col=0, room_type=RoomType.entrance)
    room_boss = Room(row=0, col=1, room_type=RoomType.boss_room, entity_ids=["goblin_1"])
    grid = MapGrid(rows=3, cols=3, rooms={"0,0": room_entrance, "0,1": room_boss})
    connect_rooms(grid, 0, 0, 0, 1)

    quest = QuestDefinition(
        quest_name="Tiny Test Quest",
        description="A one-room dungeon.",
        difficulty="easy",
        budget_total=10,
        entrance_position=(0, 0),
        objective=Objective(
            type=ObjectiveType.defeat_boss,
            target_id="goblin_1",
            description="Defeat the Goblin",
        ),
    )
    return StoredQuest(
        quest_id="test-quest-abc",
        quest=quest,
        map_grid=grid,
        entities={"goblin_1": goblin},
    )


# ---------------------------------------------------------------------------
# Round-trip
# ---------------------------------------------------------------------------


def test_save_and_load_quest(tmp_data_dir, minimal_stored_quest):
    """save_quest + load_quest round-trip preserves all fields."""
    save_quest(tmp_data_dir, minimal_stored_quest)
    loaded = load_quest(tmp_data_dir, "test-quest-abc")

    assert loaded is not None
    assert loaded.quest_id == "test-quest-abc"
    assert loaded.quest.quest_name == "Tiny Test Quest"
    assert loaded.quest.difficulty == "easy"
    assert loaded.quest.entrance_position == (0, 0)
    assert loaded.quest.objective is not None
    assert loaded.quest.objective.target_id == "goblin_1"


def test_round_trip_preserves_map(tmp_data_dir, minimal_stored_quest):
    """Room data (connections, entity_ids, room_type) survives serialisation."""
    save_quest(tmp_data_dir, minimal_stored_quest)
    loaded = load_quest(tmp_data_dir, "test-quest-abc")

    assert "0,0" in loaded.map_grid.rooms
    assert "0,1" in loaded.map_grid.rooms
    entrance = loaded.map_grid.rooms["0,0"]
    boss = loaded.map_grid.rooms["0,1"]
    assert entrance.room_type == RoomType.entrance
    assert boss.room_type == RoomType.boss_room
    assert "goblin_1" in boss.entity_ids


def test_round_trip_preserves_entities(tmp_data_dir, minimal_stored_quest):
    """Entity character data survives serialisation."""
    save_quest(tmp_data_dir, minimal_stored_quest)
    loaded = load_quest(tmp_data_dir, "test-quest-abc")

    assert "goblin_1" in loaded.entities
    goblin = loaded.entities["goblin_1"]
    assert goblin.name == "Goblin"
    assert goblin.hp == 8
    assert goblin.entity_type == EntityType.hostile


def test_load_nonexistent_returns_none(tmp_data_dir):
    """Loading an unknown quest_id returns None (no exception)."""
    result = load_quest(tmp_data_dir, "does-not-exist")
    assert result is None


def test_load_missing_data_dir_returns_none(tmp_path):
    """Loading from a data_dir whose quests directory doesn't exist yet returns None."""
    result = load_quest(tmp_path / "games", "any-id")
    assert result is None


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------


def test_list_quests_empty(tmp_data_dir):
    """list_quests returns [] when no quests have been saved."""
    assert list_quests(tmp_data_dir) == []


def test_list_quests_single(tmp_data_dir, minimal_stored_quest):
    save_quest(tmp_data_dir, minimal_stored_quest)
    ids = list_quests(tmp_data_dir)
    assert ids == ["test-quest-abc"]


def test_list_quests_multiple(tmp_data_dir, minimal_stored_quest):
    """list_quests returns all quest ids, sorted."""
    second = minimal_stored_quest.model_copy(update={"quest_id": "aaa-quest"})
    save_quest(tmp_data_dir, minimal_stored_quest)
    save_quest(tmp_data_dir, second)

    ids = list_quests(tmp_data_dir)
    assert "test-quest-abc" in ids
    assert "aaa-quest" in ids
    assert ids == sorted(ids)


def test_list_quests_skips_corrupt_files(tmp_data_dir, minimal_stored_quest):
    """Unreadable quest files are not presented as available quests."""
    save_quest(tmp_data_dir, minimal_stored_quest)
    corrupt_path = tmp_data_dir.parent / "quests" / "corrupt-quest" / "quest.json"
    corrupt_path.parent.mkdir(parents=True)
    corrupt_path.write_text("{not valid json")

    assert list_quests(tmp_data_dir) == ["test-quest-abc"]

    metadata = list_quests_with_metadata(tmp_data_dir)
    assert [row["quest_id"] for row in metadata] == ["test-quest-abc"]


# ---------------------------------------------------------------------------
# Isolation / deep copy
# ---------------------------------------------------------------------------


def test_loaded_quest_is_independent(tmp_data_dir, minimal_stored_quest):
    """Mutating a loaded StoredQuest does not affect the stored JSON."""
    save_quest(tmp_data_dir, minimal_stored_quest)
    loaded = load_quest(tmp_data_dir, "test-quest-abc")

    # Mutate the loaded copy
    loaded.entities["goblin_1"].hp = 999
    loaded.quest.quest_name = "MUTATED"

    # Reload fresh copy — mutations must not have persisted
    reloaded = load_quest(tmp_data_dir, "test-quest-abc")
    assert reloaded.entities["goblin_1"].hp == 8
    assert reloaded.quest.quest_name == "Tiny Test Quest"


def test_deep_copy_map_grid(tmp_data_dir, minimal_stored_quest):
    """model_copy(deep=True) on map_grid produces fully independent Room objects."""
    save_quest(tmp_data_dir, minimal_stored_quest)
    loaded = load_quest(tmp_data_dir, "test-quest-abc")

    copy_a = loaded.map_grid.model_copy(deep=True)
    copy_b = loaded.map_grid.model_copy(deep=True)

    # Mutate room in copy_a
    copy_a.rooms["0,1"].entity_ids.append("extra_entity")

    # copy_b must be unaffected
    assert "extra_entity" not in copy_b.rooms["0,1"].entity_ids


def test_deep_copy_entities(tmp_data_dir, minimal_stored_quest):
    """Deep-copying entities dict produces fully independent Character objects."""
    save_quest(tmp_data_dir, minimal_stored_quest)
    loaded = load_quest(tmp_data_dir, "test-quest-abc")

    entities_a = {k: v.model_copy(deep=True) for k, v in loaded.entities.items()}
    entities_b = {k: v.model_copy(deep=True) for k, v in loaded.entities.items()}

    entities_a["goblin_1"].hp = 0
    assert entities_b["goblin_1"].hp == 8


# ---------------------------------------------------------------------------
# Quest storage path
# ---------------------------------------------------------------------------


def test_quest_stored_in_correct_path(tmp_data_dir, minimal_stored_quest):
    """Quest file is written at data/quests/{quest_id}/quest.json."""
    save_quest(tmp_data_dir, minimal_stored_quest)
    expected_path = tmp_data_dir.parent / "quests" / "test-quest-abc" / "quest.json"
    assert expected_path.exists()

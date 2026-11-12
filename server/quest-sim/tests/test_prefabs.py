from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from quest_sim.config import Settings
from quest_sim.engine.map_builder import connect_rooms
from quest_sim.engine.quest_validation import validate_quest
from quest_sim.models.character import (
    AbilityScores,
    Character,
    EntityType,
    Item,
    ItemType,
)
from quest_sim.models.map import Direction, MapGrid, Room, RoomType
from quest_sim.models.quest import Objective, ObjectiveType, QuestDefinition
from quest_sim.persistence.quest_store import list_quests, load_quest, save_quest
from quest_sim.prefabs import (
    PREFAB_FILES,
    load_prefab_definitions,
    seed_prefab_quests,
)

EXPECTED_QUEST_IDS = [
    "prefab-crypt-retrieve",
    "prefab-lair-boss",
    "prefab-gauntlet-reach",
]

EXPECTED_OBJECTIVE_TYPES = {
    "prefab-crypt-retrieve": ObjectiveType.retrieve_item,
    "prefab-lair-boss": ObjectiveType.defeat_boss,
    "prefab-gauntlet-reach": ObjectiveType.reach_room,
}

EXPECTED_HOSTILE_COUNTS = {
    "prefab-crypt-retrieve": 4,
    "prefab-lair-boss": 4,
    "prefab-gauntlet-reach": 3,
}

ARCHETYPE_PREFIXES = {"skeleton", "shadow", "harpy", "mage", "wraith"}

EXPECTED_ARCHETYPES = {
    "prefab-crypt-retrieve": {"skeleton", "wraith"},
    "prefab-lair-boss": {"shadow", "wraith"},
    "prefab-gauntlet-reach": {"harpy", "mage"},
}


@pytest.fixture
def tmp_data_dir(tmp_path: Path) -> Path:
    return tmp_path / "games"


@pytest.fixture
def settings(tmp_data_dir: Path) -> Settings:
    return Settings(_env_file=None, data_dir=tmp_data_dir)


# ---------------------------------------------------------------------------
# Prefab definitions parse + validate
# ---------------------------------------------------------------------------


def test_prefab_definitions_load():
    prefabs = load_prefab_definitions()
    assert len(prefabs) == len(PREFAB_FILES) == 3
    assert [qid for qid, _ in prefabs] == EXPECTED_QUEST_IDS
    for quest_id, quest in prefabs:
        assert quest.quest_name
        assert quest.grid.rows == 5 and quest.grid.cols == 5
        assert 12 <= len(quest.grid.rooms) <= 16
        assert quest.objective is not None
        assert quest.objective.type == EXPECTED_OBJECTIVE_TYPES[quest_id]


def test_prefab_definitions_validate():
    for quest_id, quest in load_prefab_definitions():
        errors = validate_quest(quest)
        assert errors == [], f"{quest_id}: {errors}"


def test_prefab_archetype_rosters():
    """Each prefab draws from its own archetype mix; the tyrant only lives in the lair."""
    for quest_id, quest in load_prefab_definitions():
        assert len(quest.characters) == EXPECTED_HOSTILE_COUNTS[quest_id]
        seen_archetypes: set[str] = set()
        for char in quest.characters:
            assert char.entity_type == EntityType.hostile
            archetype = char.id.split("_")[0]
            assert archetype in ARCHETYPE_PREFIXES
            seen_archetypes.add(archetype)
            if char.id == "wraith_tyrant":
                assert quest_id == "prefab-lair-boss"
                assert char.hp == 30  # ~3x a regular hostile
            else:
                assert 8 <= char.hp <= 12
                assert 8 <= char.ac <= 11
        assert seen_archetypes == EXPECTED_ARCHETYPES[quest_id]


def test_prefab_healing_potions_placed():
    for quest_id, quest in load_prefab_definitions():
        potions = [i for i in quest.items if i.item_type == ItemType.potion]
        assert potions, f"{quest_id} has no healing potion"
        assert all(p.heal_amount > 0 and p.consumable for p in potions)


def test_prefab_retrieve_item_room_freely_searchable():
    """The crypt's objective item must sit in a room with no search DC."""
    prefabs = dict(load_prefab_definitions())
    quest = prefabs["prefab-crypt-retrieve"]
    target_id = quest.objective.target_id
    holding_rooms = [
        r for r in quest.grid.rooms.values() if target_id in r.treasure_item_ids
    ]
    assert holding_rooms
    assert all(r.search_dc is None for r in holding_rooms)


# ---------------------------------------------------------------------------
# New validate_quest checks (symmetry + entity consistency + targets)
# ---------------------------------------------------------------------------


def _small_quest() -> QuestDefinition:
    """A minimal valid quest: entrance + one chamber, wraith, visible potion."""
    grid = MapGrid(rows=3, cols=3)
    grid.rooms["0,0"] = Room(
        row=0, col=0, room_type=RoomType.entrance, treasure_item_ids=["pot_1"]
    )
    grid.rooms["0,1"] = Room(
        row=0, col=1, room_type=RoomType.chamber, entity_ids=["wraith_1"]
    )
    connect_rooms(grid, 0, 0, 0, 1)

    wraith = Character(
        id="wraith_1", name="Wraith", entity_type=EntityType.hostile,
        hp=9, max_hp=9, ac=9,
        abilities=AbilityScores(strength=1, dexterity=1),
        position=(0, 1),
    )
    potion = Item(
        id="pot_1", name="Potion of Healing", item_type=ItemType.potion,
        heal_amount=8, consumable=True,
    )
    return QuestDefinition(
        quest_name="Small Quest",
        grid=grid,
        characters=[wraith],
        items=[potion],
        objective=Objective(
            type=ObjectiveType.reach_room, target_id="0,1", description="Reach it"
        ),
        entrance_position=(0, 0),
    )


def test_validate_quest_small_quest_ok():
    assert validate_quest(_small_quest()) == []


def test_validate_quest_asymmetric_connection():
    quest = _small_quest()
    quest.grid.rooms["0,1"].connections[Direction.W] = False
    errors = validate_quest(quest)
    assert any("does not connect back" in e for e in errors)


def test_validate_quest_connection_to_missing_room():
    quest = _small_quest()
    quest.grid.rooms["0,1"].connections[Direction.E] = True  # no room at (0,2)
    errors = validate_quest(quest)
    assert any("missing room" in e for e in errors)


def test_validate_quest_entity_position_mismatch():
    quest = _small_quest()
    quest.characters[0].position = (0, 0)  # room "0,1" still lists wraith_1
    errors = validate_quest(quest)
    assert any("not listed in that room's entity_ids" in e for e in errors)
    assert any("its position is" in e for e in errors)


def test_validate_quest_unknown_entity_in_room():
    quest = _small_quest()
    quest.grid.rooms["0,0"].entity_ids.append("ghost_9")
    errors = validate_quest(quest)
    assert any("unknown entity id 'ghost_9'" in e for e in errors)


def test_validate_quest_defeat_boss_target_missing():
    quest = _small_quest()
    quest.objective = Objective(
        type=ObjectiveType.defeat_boss, target_id="boss_nope", description="Slay"
    )
    errors = validate_quest(quest)
    assert any("does not match any placed entity" in e for e in errors)


def test_validate_quest_reach_room_target_missing():
    quest = _small_quest()
    quest.objective = Objective(
        type=ObjectiveType.reach_room, target_id="2,2", description="Reach"
    )
    errors = validate_quest(quest)
    assert any("does not match any placed room" in e for e in errors)


# ---------------------------------------------------------------------------
# Seeder
# ---------------------------------------------------------------------------


def test_seed_prefab_quests_writes_all(settings: Settings, tmp_data_dir: Path):
    written = seed_prefab_quests(settings)
    assert written == EXPECTED_QUEST_IDS
    assert sorted(list_quests(tmp_data_dir)) == sorted(EXPECTED_QUEST_IDS)

    for quest_id in EXPECTED_QUEST_IDS:
        stored = load_quest(tmp_data_dir, quest_id)
        assert stored is not None
        # Design-time data was cleared — map_grid/entities are the live copies
        assert stored.quest.characters == []
        assert stored.quest.grid.rooms == {}
        assert len(stored.entities) == EXPECTED_HOSTILE_COUNTS[quest_id]
        er, ec = stored.quest.entrance_position
        entrance = stored.map_grid.get_room(er, ec)
        assert entrance is not None
        assert entrance.room_type == RoomType.entrance
        assert entrance.visited is True


def test_seed_prefab_quests_idempotent(settings: Settings):
    assert seed_prefab_quests(settings) == EXPECTED_QUEST_IDS
    assert seed_prefab_quests(settings) == []


def test_seed_prefab_quests_rewrites_tampered(settings: Settings, tmp_data_dir: Path):
    seed_prefab_quests(settings)
    stored = load_quest(tmp_data_dir, "prefab-lair-boss")
    stored.quest.quest_name = "Tampered Lair"
    save_quest(tmp_data_dir, stored)

    written = seed_prefab_quests(settings)
    assert written == ["prefab-lair-boss"]
    restored = load_quest(tmp_data_dir, "prefab-lair-boss")
    assert restored.quest.quest_name == "Lair of the Wraith Tyrant"


def test_seed_prefab_quests_rewrites_corrupt_file(settings: Settings, tmp_data_dir: Path):
    seed_prefab_quests(settings)
    quest_path = tmp_data_dir.parent / "quests" / "prefab-gauntlet-reach" / "quest.json"
    quest_path.write_text("{not valid json")

    written = seed_prefab_quests(settings)
    assert written == ["prefab-gauntlet-reach"]
    assert load_quest(tmp_data_dir, "prefab-gauntlet-reach") is not None


def test_seed_prefab_quests_raises_on_invalid(settings: Settings):
    broken = QuestDefinition(quest_name="Broken Prefab")  # no entrance/objective/items
    with patch(
        "quest_sim.prefabs.load_prefab_definitions",
        return_value=[("prefab-broken", broken)],
    ):
        with pytest.raises(ValueError, match="failed validation"):
            seed_prefab_quests(settings)

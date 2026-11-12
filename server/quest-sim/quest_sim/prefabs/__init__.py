"""Hand-authored prefab dungeons seeded into the quest store at startup.

Each *.json file in this package is a design-time QuestDefinition dump
(populated grid.rooms + characters) wrapped with its fixed quest_id.  At boot,
seed_prefab_quests() validates every prefab and applies the post-processing
step (build_map_from_quest → capture entities → clear design-time
grid/characters) that leaves map_grid and entities as the only live copies.

These outlived the v1 route that once generated quests this way; they are now
the island's hand-authored dungeon content and nothing else writes the store.
"""

from __future__ import annotations

import json
from pathlib import Path

from quest_sim.config import Settings
from quest_sim.engine.map_builder import build_map_from_quest
from quest_sim.engine.quest_validation import validate_quest
from quest_sim.models.character import Character
from quest_sim.models.map import MapGrid
from quest_sim.models.quest import QuestDefinition
from quest_sim.persistence.quest_store import StoredQuest, load_quest, save_quest

PREFAB_FILES = [
    "crypt_retrieve.json",
    "lair_boss.json",
    "gauntlet_reach.json",
]

# Sandbox-only content. Kept a separate list from the three above because
# those are still loaded through quest_store as StoredQuests; the world
# builder instantiates DungeonSites from these directly.
SANDBOX_PREFAB_FILES = [
    "sunken_vault.json",
    "howling_roost.json",
    "sanctum_heart.json",
]

_PREFAB_DIR = Path(__file__).parent


def _load_definitions(filenames: list[str]) -> list[tuple[str, QuestDefinition]]:
    prefabs: list[tuple[str, QuestDefinition]] = []
    for filename in filenames:
        raw = json.loads((_PREFAB_DIR / filename).read_text(encoding="utf-8"))
        quest = QuestDefinition.model_validate(raw["quest"])
        prefabs.append((raw["quest_id"], quest))
    return prefabs


def load_prefab_definitions() -> list[tuple[str, QuestDefinition]]:
    """Load all bundled prefab quests as (quest_id, QuestDefinition) pairs.

    Each JSON file is {"quest_id": str, "quest": QuestDefinition-dump} with
    the design-time grid.rooms and characters still populated.
    """
    return _load_definitions(PREFAB_FILES)


def load_sandbox_stored_quests() -> dict[str, StoredQuest]:
    """Validated, post-processed StoredQuests for the sandbox world builder.

    Includes BOTH the solo prefabs and the sandbox-only prefabs — the full
    template pool for dungeon sites. Pure (no disk store involved).
    """
    stored: dict[str, StoredQuest] = {}
    for quest_id, quest in _load_definitions(PREFAB_FILES + SANDBOX_PREFAB_FILES):
        stored[quest_id] = _build_stored_quest(quest_id, quest)
    return stored


def _build_stored_quest(quest_id: str, quest: QuestDefinition) -> StoredQuest:
    """Validate and post-process a design-time prefab into a StoredQuest.

    Build the live map from the blueprint, capture entities, then clear the
    design-time data so map_grid and entities are the only live copies.

    Raises ValueError if the prefab fails validation.
    """
    errors = validate_quest(quest)
    if errors:
        raise ValueError(
            f"Prefab quest '{quest_id}' failed validation:\n"
            + "\n".join(f"- {e}" for e in errors)
        )

    # Build live map from the quest blueprint
    grid = build_map_from_quest(quest)

    # Capture entities before clearing them from quest
    entities: dict[str, Character] = {char.id: char for char in quest.characters}

    # Clear design-time data from quest — map_grid and entities are now the live copies
    quest.grid = MapGrid(rows=quest.grid.rows, cols=quest.grid.cols)
    quest.characters = []

    return StoredQuest(quest_id=quest_id, quest=quest, map_grid=grid, entities=entities)


def seed_prefab_quests(settings: Settings) -> list[str]:
    """Seed the bundled prefab quests into the quest store.

    Idempotent: a prefab is (re)written only when it is missing from the
    store or its stored content differs from the bundled version.  Raises
    ValueError if any bundled prefab fails validation (fail fast at boot).

    Returns the quest_ids that were written this call.
    """
    written: list[str] = []
    for quest_id, quest in load_prefab_definitions():
        stored = _build_stored_quest(quest_id, quest)
        try:
            existing = load_quest(settings.data_dir, quest_id)
        except Exception:
            existing = None  # corrupt/unreadable on disk — rewrite it
        if existing == stored:
            continue
        save_quest(settings.data_dir, stored)
        written.append(quest_id)
    return written

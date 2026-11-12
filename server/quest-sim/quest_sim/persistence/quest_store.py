"""Persistence for standalone quest definitions (independent of game state).

Quests are stored in  data/quests/{quest_id}/quest.json  — a sibling directory
to the  data/games/  tree.  The data_dir argument is always the games directory
(Settings.data_dir), so quests live at  data_dir.parent / "quests".
"""

from __future__ import annotations

import logging
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from quest_sim.models.character import Character
from quest_sim.models.map import MapGrid
from quest_sim.models.quest import QuestDefinition


logger = logging.getLogger(__name__)


class StoredQuest(BaseModel):
    """A fully generated quest ready to be instantiated as a game.

    Separates three concerns that otherwise drift apart:
      - quest: QuestDefinition (objective, items, name — characters/grid cleared)
      - map_grid: live MapGrid built by build_map_from_quest()
      - entities: hostile/NPC characters keyed by their id

    When a game is created from a StoredQuest, all three are deep-copied so
    multiple concurrent games never share mutable objects.
    """

    quest_id: str
    quest: QuestDefinition
    map_grid: MapGrid
    entities: dict[str, Character] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _quests_dir(data_dir: Path) -> Path:
    """Return the quests root: data_dir.parent / 'quests' (i.e. data/quests/)."""
    return data_dir.parent / "quests"


def _quest_path(data_dir: Path, quest_id: str) -> Path:
    return _quests_dir(data_dir) / quest_id / "quest.json"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def save_quest(data_dir: Path, stored: StoredQuest) -> None:
    """Serialise a StoredQuest to disk."""
    path = _quest_path(data_dir, stored.quest_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(stored.model_dump_json(indent=2))


def load_quest(data_dir: Path, quest_id: str) -> StoredQuest | None:
    """Load a StoredQuest by id.  Returns None if not found."""
    path = _quest_path(data_dir, quest_id)
    if not path.exists():
        return None
    return StoredQuest.model_validate_json(path.read_text())


def list_quests(data_dir: Path) -> list[str]:
    """Return sorted ids for quest files that can be loaded successfully."""
    qdir = _quests_dir(data_dir)
    if not qdir.exists():
        return []
    quest_ids: list[str] = []
    for directory in sorted(qdir.iterdir(), key=lambda path: path.name):
        if not directory.is_dir() or not (directory / "quest.json").exists():
            continue
        try:
            if load_quest(data_dir, directory.name) is not None:
                quest_ids.append(directory.name)
        except (OSError, UnicodeError, ValidationError):
            logger.warning("skipping unreadable quest.json under %s", directory.name)
    return quest_ids


def list_quests_with_metadata(data_dir: Path) -> list[dict]:
    """Return metadata for all stored quests.

    Each entry: {quest_id, quest_name, description, difficulty, objective_description}.
    Quests that fail to load are logged and skipped.
    """
    results: list[dict] = []
    for quest_id in list_quests(data_dir):
        try:
            stored = load_quest(data_dir, quest_id)
            if stored is None:
                continue
            q = stored.quest
            obj = q.objective
            results.append({
                "quest_id": quest_id,
                "quest_name": q.quest_name,
                "description": q.description,
                "difficulty": q.difficulty,
                "objective_description": obj.description if obj else "",
            })
        except (OSError, UnicodeError, ValidationError):
            logger.warning("skipping unreadable quest.json under %s", quest_id)
            continue
    return results

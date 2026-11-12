from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field

from quest_sim.models.character import Character, Item
from quest_sim.models.map import MapGrid


class ObjectiveType(str, Enum):
    defeat_boss = "defeat_boss"
    reach_room = "reach_room"
    retrieve_item = "retrieve_item"


class Objective(BaseModel):
    type: ObjectiveType
    target_id: str
    description: str = ""


class QuestDefinition(BaseModel):
    quest_name: str = ""
    description: str = ""
    budget_total: int = 30
    budget_spent: int = 0
    grid: MapGrid = Field(default_factory=lambda: MapGrid(rows=8, cols=8))
    characters: list[Character] = Field(default_factory=list)
    items: list[Item] = Field(default_factory=list)
    objective: Objective | None = None
    difficulty: str = "normal"
    entrance_position: tuple[int, int] = (0, 0)
    # Multi-entrance dungeons (sandbox through-routes). Empty = the single
    # classic entrance_position. When set, it must include entrance_position.
    entrances: list[tuple[int, int]] = Field(default_factory=list)


def quest_entrance_positions(quest: QuestDefinition) -> list[tuple[int, int]]:
    """Effective entrance list — the declared set, or the single primary."""
    if quest.entrances:
        return [tuple(e) for e in quest.entrances]
    return [tuple(quest.entrance_position)]

"""Validation for design-time quest definitions.

Extracted from FinalizeQuest so both the LLM quest generator and the prefab
seeder run the exact same checks.  validate_quest() returns a list of
human-readable error strings — an empty list means the quest is valid.
"""

from __future__ import annotations

from quest_sim.engine.map_builder import validate_map_connected
from quest_sim.models.character import ItemType
from quest_sim.models.map import DIRECTION_OFFSETS, OPPOSITE_DIRECTION, RoomType
from quest_sim.models.quest import ObjectiveType, QuestDefinition, quest_entrance_positions


def validate_quest(quest: QuestDefinition) -> list[str]:
    """Validate a design-time QuestDefinition (populated grid + characters).

    Checks: entrance exists, objective set and resolvable, map connected,
    connections symmetric, healing potion present, treasure rooms non-empty,
    objective items freely obtainable, trap rooms configured, and entity
    positions consistent with room entity_ids.
    """
    errors: list[str] = []

    # Check entrance
    entrance_key = f"{quest.entrance_position[0]},{quest.entrance_position[1]}"
    entrance_room = quest.grid.rooms.get(entrance_key)
    if entrance_room is None or entrance_room.room_type != RoomType.entrance:
        errors.append("No entrance room found.")

    # Multi-entrance dungeons (sandbox through-routes): every declared entrance
    # must be a real entrance room, the primary must be among them, and the
    # map must be walkable from each doorway.
    if quest.entrances:
        declared = quest_entrance_positions(quest)
        if tuple(quest.entrance_position) not in declared:
            errors.append("entrance_position must be one of the declared entrances.")
        for pos in declared:
            room = quest.grid.rooms.get(f"{pos[0]},{pos[1]}")
            if room is None or room.room_type != RoomType.entrance:
                errors.append(f"Declared entrance at ({pos[0]},{pos[1]}) is not an entrance room.")
            elif not validate_map_connected(quest.grid, pos):
                errors.append(f"Map is not fully connected from entrance ({pos[0]},{pos[1]}).")

    # Check objective
    if quest.objective is None:
        errors.append("No objective set.")

    # Check map connectivity
    if not validate_map_connected(quest.grid, quest.entrance_position):
        errors.append("Map is not fully connected from entrance.")

    # Check minimum items / healing
    if not quest.items:
        errors.append("Quest must contain at least one item (e.g. a healing potion).")
    elif not any(i.item_type == ItemType.potion for i in quest.items):
        errors.append("Quest must contain at least one healing potion.")

    # Check treasure rooms have treasure
    for key, room in quest.grid.rooms.items():
        if room.room_type == RoomType.treasure_room and not room.treasure_item_ids:
            errors.append(f"Treasure room at ({room.row},{room.col}) has no items.")

    # Check objective items are not behind DC checks (could make quest uncompleteable)
    if quest.objective and quest.objective.type == ObjectiveType.retrieve_item:
        target_id = quest.objective.target_id
        for key, room in quest.grid.rooms.items():
            if target_id in room.treasure_item_ids and room.search_dc is not None:
                errors.append(
                    f"Objective item '{target_id}' is in room ({room.row},{room.col}) "
                    f"behind a DC {room.search_dc} check. Objective items must be freely obtainable "
                    f"(set search_dc to null for that room)."
                )

    # Check that retrieve_item target_id exists in placed items
    if quest.objective and quest.objective.type == ObjectiveType.retrieve_item:
        target_id = quest.objective.target_id
        placed_ids = [item.id for item in quest.items]
        if target_id not in placed_ids:
            errors.append(
                f"Objective target_id '{target_id}' does not match any placed item. "
                f"Placed item IDs: {placed_ids}. Use an exact matching ID."
            )

    # Check that defeat_boss target_id exists in placed entities
    if quest.objective and quest.objective.type == ObjectiveType.defeat_boss:
        target_id = quest.objective.target_id
        placed_ids = [char.id for char in quest.characters]
        if target_id not in placed_ids:
            errors.append(
                f"Objective target_id '{target_id}' does not match any placed entity. "
                f"Placed entity IDs: {placed_ids}. Use an exact matching ID."
            )

    # Check that reach_room target_id is an existing room key
    if quest.objective and quest.objective.type == ObjectiveType.reach_room:
        target_id = quest.objective.target_id
        if target_id not in quest.grid.rooms:
            errors.append(
                f"Objective target_id '{target_id}' does not match any placed room. "
                f"Use an exact 'row,col' key of an existing room."
            )

    # Check trap rooms actually have traps
    for key, room in quest.grid.rooms.items():
        if room.room_type == RoomType.trap_room:
            if room.trap_dc is None:
                errors.append(f"Trap room at ({room.row},{room.col}) has no trap configured (use place_trap).")

    # Check connection symmetry (a one-way connection breaks return movement)
    for key, room in quest.grid.rooms.items():
        for direction, connected in room.connections.items():
            if not connected:
                continue
            dr, dc = DIRECTION_OFFSETS[direction]
            nr, nc = room.row + dr, room.col + dc
            neighbor = quest.grid.rooms.get(f"{nr},{nc}")
            if neighbor is None:
                errors.append(
                    f"Room ({room.row},{room.col}) connects {direction.value} to a missing room ({nr},{nc})."
                )
            elif not neighbor.connections.get(OPPOSITE_DIRECTION[direction]):
                errors.append(
                    f"Asymmetric connection: ({room.row},{room.col}) connects {direction.value} "
                    f"but ({nr},{nc}) does not connect back."
                )

    # Check entity positions are consistent with room entity_ids
    chars_by_id = {char.id: char for char in quest.characters}
    for char in quest.characters:
        cr, cc = char.position
        room = quest.grid.rooms.get(f"{cr},{cc}")
        if room is None:
            errors.append(f"Entity '{char.id}' is positioned at ({cr},{cc}) but no room exists there.")
        elif char.id not in room.entity_ids:
            errors.append(
                f"Entity '{char.id}' is positioned at ({cr},{cc}) but is not listed in that room's entity_ids."
            )
    for key, room in quest.grid.rooms.items():
        for entity_id in room.entity_ids:
            char = chars_by_id.get(entity_id)
            if char is None:
                errors.append(f"Room ({room.row},{room.col}) lists unknown entity id '{entity_id}'.")
            elif tuple(char.position) != (room.row, room.col):
                errors.append(
                    f"Room ({room.row},{room.col}) lists entity '{entity_id}' but its position is "
                    f"({char.position[0]},{char.position[1]})."
                )

    return errors

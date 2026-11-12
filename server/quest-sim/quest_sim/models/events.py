from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class EngineEventType(str, Enum):
    dice_roll = "dice_roll"
    attack = "attack"
    damage = "damage"
    heal = "heal"
    movement = "movement"
    trap_trigger = "trap_trigger"
    trap_disarm = "trap_disarm"
    search = "search"
    item_found = "item_found"
    item_used = "item_used"
    combat_start = "combat_start"
    combat_end = "combat_end"
    initiative_roll = "initiative_roll"
    dodge = "dodge"
    flee = "flee"
    death = "death"
    objective_complete = "objective_complete"
    room_enter = "room_enter"
    npc_interact = "npc_interact"
    player_thought = "player_thought"
    invader_spawn = "invader_spawn"
    invader_movement = "invader_movement"
    invader_death = "invader_death"
    fog_wall_blocked = "fog_wall_blocked"
    fog_wall_lifted = "fog_wall_lifted"
    wait = "wait"

    # Sandbox (multi-agent season).
    travel = "travel"  # overworld hex move
    site_enter = "site_enter"
    site_exit = "site_exit"
    agent_joined = "agent_joined"
    agent_ready = "agent_ready"
    world_started = "world_started"
    action_failed = "action_failed"
    action_timeout = "action_timeout"  # BYO deadline missed — engine played the default
    agent_death = "agent_death"  # an agent (not a mob) died — the headline feed
    loot_drop = "loot_drop"  # a death left gear on the ground
    season_end = "season_end"
    agent_thought = "agent_thought"  # follow-mode-only brain trace


class EngineEvent(BaseModel):
    event_type: EngineEventType
    tick: int = 0
    data: dict = Field(default_factory=dict)
    description: str = ""
    # Sandbox spine (additive — solo-engine events keep the defaults):
    seq: int = 0  # global monotonic sequence within a world
    actor: str | None = None  # acting agent id, when one exists
    location: str | None = None  # location_key() where it happened


class NarrativeEntry(BaseModel):
    tick: int
    text: str
    phase: str = ""

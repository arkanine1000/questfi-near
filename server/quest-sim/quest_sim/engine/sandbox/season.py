"""Season end — three win paths in strict precedence.

1. Boss crown: slaying the central boss stakes the win the moment it lands
   (recorded by combat's death handler; finalised here even if the slayer
   died later the same tick).
2. Last alive / extinction.
3. The bell: at max_ticks, the living are ranked by kills, then gear score,
   then current hp, then name — fully deterministic.
"""

from __future__ import annotations

from quest_sim.engine.sandbox.actions import gear_score
from quest_sim.models.events import EngineEvent, EngineEventType
from quest_sim.models.sandbox import SandboxWorld, WorldPhase


def _finish(world: SandboxWorld) -> list[EngineEvent]:
    world.phase = WorldPhase.finished
    if world.winner_name:
        desc = f"The season is over — {world.winner_name} wins ({world.win_reason})."
    else:
        desc = "The season is over — no one survived the island."
    return [
        EngineEvent(
            event_type=EngineEventType.season_end,
            tick=world.tick,
            data={
                "winner": world.winner,
                "winner_name": world.winner_name,
                "win_reason": world.win_reason,
                "tick": world.tick,
            },
            description=desc,
        )
    ]


def check_season_end(world: SandboxWorld) -> list[EngineEvent]:
    if world.phase != WorldPhase.running:
        return []

    # 1. The crown was staked this tick.
    if world.win_reason == "boss" and world.winner:
        return _finish(world)

    living = world.living_agents()

    # 2. Attrition.
    if len(living) == 0:
        world.win_reason = "extinction"
        return _finish(world)
    if len(living) == 1:
        world.winner = living[0].agent_id
        world.winner_name = living[0].name
        world.win_reason = "last_alive"
        return _finish(world)

    # 3. The bell.
    if world.tick >= world.config.max_ticks:
        ranked = sorted(
            living,
            key=lambda a: (-a.kills, -gear_score(a), -a.character.hp, a.name),
        )
        world.winner = ranked[0].agent_id
        world.winner_name = ranked[0].name
        world.win_reason = "timeout"
        return _finish(world)

    return []

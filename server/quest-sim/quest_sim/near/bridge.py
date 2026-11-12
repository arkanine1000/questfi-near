"""From game moments to contract calls.

The game knows agents by agent id; the contract knows them by pass id
(the agent pass NFT that holds the stake). This module maps one to the
other and decides which calls each lifecycle moment produces:

==========================  ===================================================
World created               ``create_season(world_id, entry_stake)``
World started               ``enter_season`` for every house pass, then
                            ``start_season``
Each tick                   that tick's agent deaths as ``kill`` events, and a
                            ``loot`` event for each dungeon boss slain
Tick reaches the lock tick  ``lock_market``
World finished              ``lock_market`` if not yet sent, then exactly one
                            ``settle_season`` (after the tick's events)
World deleted or swept      ``cancel_season``, unless it was settled
==========================  ===================================================

An agent with no pass (a world can mix chain and non-chain agents) is
left out of every event, and a kill by it is reported as a monster kill.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from quest_sim.models.sandbox import SandboxWorld, WorldPhase
from quest_sim.near.client import NearError
from quest_sim.near.settler import Settler

logger = logging.getLogger(__name__)

LOOT_XP = 80  # per dungeon boss slain; the contract caps it at xp_loot_max
LOOT_TEXT_MAX = 80


def load_house_passes(path: Path | None) -> dict[str, str]:
    """The operator's own passes, as a JSON object of agent name to pass id."""
    if path is None:
        return {}
    try:
        raw = json.loads(Path(path).read_text())
    except FileNotFoundError:
        logger.warning("house pass map %s not found; hosted agents play without passes", path)
        return {}
    except (OSError, ValueError):
        logger.warning("house pass map %s is unreadable; hosted agents play without passes", path)
        return {}
    if not isinstance(raw, dict):
        logger.warning("house pass map %s is not a JSON object; ignoring it", path)
        return {}
    return {
        str(name): str(pass_id)
        for name, pass_id in raw.items()
        if isinstance(pass_id, (str, int)) and str(pass_id).strip()
    }


def _house_pass_for(name: str, passes: dict[str, str]) -> str | None:
    if name in passes:
        return passes[name]
    low = name.lower()
    for key, value in passes.items():
        if key.lower() == low:
            return value
    return None


def on_world_created(settler: Settler, world: SandboxWorld, **season_options) -> None:
    settler.create_season(world.world_id, **season_options)


def assign_house_passes(settler: Settler, world: SandboxWorld) -> list[str]:
    """Give each hosted agent its house pass, by name. Skips a pass already
    seated in this world, or still in another season the chain has not
    settled (a pass is in one season at a time). Returns the passes given."""
    passes = load_house_passes(settler.passes_file)
    seated = {a.pass_id for a in world.agents.values() if a.pass_id}
    given = []
    for agent in world.agents.values():
        if agent.brain == "external" or agent.pass_id:
            continue
        pass_id = _house_pass_for(agent.name, passes)
        if pass_id is None or pass_id in seated:
            continue
        if settler.pass_busy(pass_id, except_season=world.world_id):
            logger.warning(
                "house pass %s (%s) is still in another season; %s plays without it",
                pass_id, agent.name, world.world_id,
            )
            continue
        agent.pass_id = pass_id
        seated.add(pass_id)
        given.append(pass_id)
    return given


def on_world_started(settler: Settler, world: SandboxWorld) -> None:
    """Call after the engine has backfilled the roster, before the world is
    saved, so the passes are persisted and reach the spectators."""
    if not settler.tracks(world.world_id):
        return
    for pass_id in assign_house_passes(settler, world):
        settler.enter_season(world.world_id, pass_id)
    settler.start_season(world.world_id)


def season_events(world: SandboxWorld, events: list[dict]) -> list[dict]:
    """One tick's frame events as contract events, in the order they
    happened."""
    out: list[dict] = []
    for ev in events:
        kind = ev.get("event_type")
        data = ev.get("data") or {}
        if kind == "agent_death":
            victim = world.get_agent(data.get("agent") or "")
            if victim is None or not victim.pass_id:
                continue
            killer_agent = world.get_agent(data.get("killer") or "")
            killer = killer_agent.pass_id if killer_agent is not None else None
            if killer == victim.pass_id:
                killer = None
            out.append({"kind": "kill", "killer": killer or None, "victim": victim.pass_id})
        elif kind == "death":
            # A mob's death; credit a dungeon boss to the agent who slew it.
            site_id = (ev.get("location") or "").partition(":")[0]
            site = world.get_site(site_id) if site_id != "hex" else None
            if site is None or not site.boss_id or data.get("character_id") != site.boss_id:
                continue
            slayer = world.get_agent(ev.get("actor") or "")
            if slayer is None or not slayer.pass_id:
                continue
            out.append({
                "kind": "loot",
                "pass": slayer.pass_id,
                "xp": LOOT_XP,
                "text": f"Cleared {site.name}"[:LOOT_TEXT_MAX],
            })
    return out


def winner_pass(world: SandboxWorld) -> str | None:
    """The winner's pass, alive or not: the boss crown can go to an agent
    that died later in the same final tick."""
    agent = world.get_agent(world.winner or "")
    return agent.pass_id if agent is not None and agent.pass_id else None


def on_tick(settler: Settler, world: SandboxWorld, frame: dict) -> None:
    """After each tick's broadcast. Only queues calls; returns at once."""
    season_id = world.world_id
    if not settler.is_open(season_id):
        return
    events = season_events(world, frame.get("events") or [])
    if events:
        settler.report_events(season_id, events)
    finished = world.phase == WorldPhase.finished
    lock_tick = settler.lock_tick_for(season_id)
    lock_due = lock_tick > 0 and world.tick >= lock_tick
    if (lock_due or finished) and not settler.is_locked(season_id):
        settler.lock_market(season_id)
    if finished:
        settler.settle_season(season_id, winner_pass(world))


def on_world_removed(settler: Settler, world_id: str) -> None:
    """Deleted or swept. Before it finished, that means the season will
    never settle: cancel it so every stake is refunded."""
    if not settler.tracks(world_id):
        return
    settler.cancel_season(world_id)
    settler.mark_removed(world_id)


async def verify_entry(settler: Settler, world_id: str, pass_id: str) -> bool | None:
    """Is this pass an entrant of the season on chain? None when the chain
    could not be asked."""
    try:
        season = await settler.fetch_season(world_id)
    except NearError as e:
        logger.warning("could not verify pass %s for %s: %s", pass_id, world_id, e)
        return None
    if not isinstance(season, dict):
        return False
    return any(str(e.get("pass_id")) == pass_id for e in season.get("entrants") or [])

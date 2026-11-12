"""The world tick — one deterministic global turn.

``run_world_tick(world, decisions)`` is SYNCHRONOUS and is the world's sole
mutator. It is a pure function of (world state, decisions, world.seed): all
wall-clock concerns — BYO deadlines, LLM latency, pacing — live in the async
runner, which only ever produces the ``decisions`` dict. Nothing here awaits,
sleeps, or reads a clock, so a reader between ticks can never observe a
half-applied world, and identical inputs replay identical seasons.

Pipeline: clock → thoughts → defaults for the silent → exploration actions
in a seeded order → one initiative round per active combat → upkeep (ignite /
join / end fights) → season check → seq-stamp.

Every living agent submits at most ONE action per tick. Agents standing in
an active combat spend it as their combat-round action; everyone else spends
it exploring.
"""

from __future__ import annotations

from quest_sim.engine.sandbox import actions as verbs
from quest_sim.engine.sandbox.combat import (
    attack_action,
    combat_upkeep,
    run_rotation,
)
from quest_sim.engine.sandbox.rng import sub_rng
from quest_sim.engine.sandbox.season import check_season_end
from quest_sim.models.events import EngineEvent, EngineEventType
from quest_sim.models.sandbox import SandboxAgent, SandboxWorld, WorldPhase

DecisionMap = dict[str, "dict | None"]


def default_action(world: SandboxWorld, agent_id: str) -> dict:
    """The missed-deadline stand-in: guard up when threatened, else wait.
    The world never blocks on a slow or silent brain."""
    agent = world.get_agent(agent_id)
    if agent is None or not agent.is_alive:
        return {"action": "wait"}
    threatened = world.combats.get(agent.loc_key) is not None or any(
        o.agent_id != agent_id for o in world.agents_at(agent.loc_key)
    )
    if not threatened and agent.position.kind == "dungeon":
        site = world.get_site(agent.position.site_id)
        room = verbs.current_room(site, agent)
        threatened = bool(
            room and site and any(
                (m := site.entities.get(e)) is not None and m.is_alive
                for e in room.entity_ids
            )
        )
    return {"action": "dodge"} if threatened else {"action": "wait"}


def in_active_combat(world: SandboxWorld, agent: SandboxAgent) -> bool:
    sc = world.combats.get(agent.loc_key)
    if sc is None or not sc.combat.active:
        return False
    return (
        agent.agent_id in sc.combat.combatant_ids
        and agent.agent_id not in sc.combat.fled_ids
    )


def _describe(action: dict) -> str:
    kind = str(action.get("action") or "wait")
    detail = action.get("direction") or action.get("target") or action.get("item")
    return f"{kind} {detail}" if detail else kind


def apply_exploration_action(
    world: SandboxWorld, agent_id: str, action: dict
) -> list[EngineEvent]:
    """Dispatch one agent's non-combat action. In-combat agents are handled
    by their location's rotation, never through here."""
    agent = world.get_agent(agent_id)
    if agent is None or not agent.is_alive:
        return []  # died earlier this tick — the decision dies with them

    rng = sub_rng(world.seed, "tick", world.tick, agent_id)
    kind = str(action.get("action") or "wait").lower()

    if kind == "travel":
        return verbs.travel(world, agent, action.get("direction") or "")
    if kind == "move":
        return verbs.dungeon_move(world, agent, action.get("direction") or "", rng)
    if kind == "enter":
        return verbs.enter_dungeon(world, agent, rng)
    if kind == "exit":
        return verbs.exit_dungeon(world, agent)
    if kind == "search":
        return verbs.search_here(world, agent, rng)
    if kind in ("pickup", "pick_up"):
        return verbs.pick_up(world, agent, action.get("item") or action.get("item_id"))
    if kind in ("equip", "equip_weapon"):
        return verbs.equip(world, agent, action.get("item") or "")
    if kind == "use_item":
        return verbs.use_inventory_item(world, agent, action.get("item") or "")
    if kind == "attack":
        return attack_action(world, agent, action.get("target"), rng, agent.loc_key)
    if kind in ("wait", "dodge"):
        return verbs.wait(world, agent)
    return verbs.fail(world, agent, kind, "unknown action")


# How many ticks of location history to keep. Must be >= the observation
# replay window (api.world_routes.MISSED_TICK_LOOKBACK) — an event older than
# the trail cannot be placed, and falls back to "not visible".
LOC_TRAIL_TICKS = 12


def record_presence(world: SandboxWorld) -> None:
    """Note where every agent stands right now, under the current tick.

    Called twice per tick, at the start and the end. Two samples are exact
    rather than approximate: an agent takes one action per tick and every
    mover advances at most one hop, so {start, end} is the complete set of
    places it occupied. The dead are recorded too — a victim's final tick
    still has to be explicable to it.
    """
    key = str(world.tick)
    cutoff = world.tick - LOC_TRAIL_TICKS
    for agent in world.agents.values():
        here = agent.loc_trail.setdefault(key, [])
        if agent.loc_key not in here:
            here.append(agent.loc_key)
        for old in [k for k in agent.loc_trail if int(k) < cutoff]:
            del agent.loc_trail[old]


def run_world_tick(world: SandboxWorld, decisions: DecisionMap) -> list[EngineEvent]:
    """Advance the world one tick. Deterministic given world state, seed,
    and the decisions. Returns the tick's events, seq-stamped."""
    if world.phase != WorldPhase.running:
        return []

    world.tick += 1
    tick = world.tick
    events: list[EngineEvent] = []

    # Corpses stay explicable for one tick — long enough for an attack voided
    # by someone else's initiative to name what it swung at, no longer.
    world.recent_deaths = {
        cid: rec for cid, rec in world.recent_deaths.items() if rec.tick >= tick - 1
    }
    record_presence(world)  # where everyone STARTED the tick

    living = sorted(world.living_agents(), key=lambda a: a.agent_id)

    # Thoughts ride along with decisions; they are spectator/follow-mode
    # detail, never engine input.
    for agent in living:
        decision = decisions.get(agent.agent_id)
        if decision and decision.get("thought"):
            agent.last_thought = str(decision["thought"])[:500]
            events.append(
                EngineEvent(
                    event_type=EngineEventType.agent_thought,
                    tick=tick,
                    actor=agent.agent_id,
                    location=agent.loc_key,
                    data={"agent": agent.agent_id, "thought": agent.last_thought},
                    description=f"{agent.name} thinks.",
                )
            )

    # The silent get a loud timeout and a defensive default.
    resolved: DecisionMap = {}
    defaulted: set[str] = set()
    for agent in living:
        decision = decisions.get(agent.agent_id)
        if decision is None or not decision.get("action"):
            defaulted.add(agent.agent_id)
            events.append(
                EngineEvent(
                    event_type=EngineEventType.action_timeout,
                    tick=tick,
                    actor=agent.agent_id,
                    location=agent.loc_key,
                    data={"agent": agent.agent_id},
                    description=f"{agent.name} hesitates — the world moves on.",
                )
            )
            decision = default_action(world, agent.agent_id)
        resolved[agent.agent_id] = decision
        agent.last_action = _describe(decision)

    # Split the roster by combat standing AT TICK START: your one action is
    # either your combat-round action or your exploration action, never both.
    fighters = {a.agent_id for a in living if in_active_combat(world, a)}
    explorers = [a.agent_id for a in living if a.agent_id not in fighters]

    # Exploration in a seeded per-tick order (no positional favoritism).
    sub_rng(world.seed, "order", tick).shuffle(explorers)
    for agent_id in explorers:
        events += apply_exploration_action(world, agent_id, resolved[agent_id])

    # One full initiative round per active combat.
    for loc_key in sorted(world.combats):
        events += run_rotation(
            world, loc_key, resolved, sub_rng(world.seed, "combat", tick, loc_key),
            defaulted,
        )

    # Ignite / join / end fights, then the season gate.
    events += combat_upkeep(world, events, sub_rng(world.seed, "upkeep", tick))
    events += check_season_end(world)
    record_presence(world)  # where everyone ENDED the tick

    for ev in events:
        ev.seq = world.next_seq()
    return events

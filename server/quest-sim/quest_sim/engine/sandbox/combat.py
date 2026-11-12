"""Per-location combat — d20 rotations, N agents + mobs, permadeath.

One ``SandboxCombat`` per contested location lives in ``world.combats``.
A world tick runs ONE full rotation per active combat (every agent acts
exactly once per tick, fighting or not).

House rules (user-confirmed):
- PvP is legal ONLY inside dungeons, and only ever opt-in (an explicit
  attack naming a rival). The overworld holds an unconditional truce.
- Implicit co-op: agents sharing a room with living mobs are rolled into
  one combat presumed to be fighting the mobs together.
- Betrayal is legal mid-fight; ``hostile_pairs`` remembers who drew steel
  on whom. When the mobs are down, a fight only continues between live
  hostile pairs — allies simply stand down.
- Permadeath: a fallen agent's gear drops where they fell.
- Slaying the central boss stakes an instant season win.
"""

from __future__ import annotations

import random

from quest_sim.engine.character import dodge_ac_bonus
from quest_sim.engine.combat_core import (
    resolve_attack,
    resolve_dodge,
    roll_group_initiative,
)
from quest_sim.engine.sandbox.actions import (
    _tile_remove,
    dungeon_move,
    fail,
    travel,
    use_inventory_item,
)
from quest_sim.models.character import Character
from quest_sim.models.combat import CombatState
from quest_sim.models.events import EngineEvent, EngineEventType
from quest_sim.models.overworld import HEX_DIRECTIONS, parse_hex_key
from quest_sim.models.sandbox import (
    SandboxAgent,
    SandboxCombat,
    SandboxWorld,
    SlainRecord,
)


def split_loc(loc_key: str) -> tuple[str | None, str]:
    """('site_id', 'room_key') for interiors, (None, 'q,r') for hexes."""
    prefix, _, rest = loc_key.partition(":")
    if prefix == "hex":
        return None, rest
    return prefix, rest


def _combatant(world: SandboxWorld, loc_key: str, cid: str) -> Character | None:
    agent = world.get_agent(cid)
    if agent is not None:
        return agent.character
    site_id, _ = split_loc(loc_key)
    site = world.get_site(site_id)
    if site is not None:
        return site.entities.get(cid)
    return None


def _living_mob_ids(world: SandboxWorld, loc_key: str) -> list[str]:
    site_id, place = split_loc(loc_key)
    site = world.get_site(site_id)
    if site is None:
        return []
    room = site.map_grid.rooms.get(place)
    if room is None:
        return []
    return [
        eid for eid in room.entity_ids
        if (m := site.entities.get(eid)) is not None and m.is_alive
    ]


def handle_actor_death(
    world: SandboxWorld, dead_id: str, killer_id: str | None, loc_key: str,
    killer_label: str | None = None,
) -> list[EngineEvent]:
    """Permadeath bookkeeping: ground loot, kill credit, the crown stake.

    killer_label names a killer that is not a combatant — "a trap" — so
    non-combat deaths still read properly in the feed and on the corpse."""
    events: list[EngineEvent] = []
    site_id, place = split_loc(loc_key)
    site = world.get_site(site_id)

    # Remember the corpse before either branch returns, so a later slot in the
    # same round can be told its target was cut down rather than imaginary.
    dead_char = _combatant(world, loc_key, dead_id)
    dead_for_name = world.get_agent(dead_id)
    world.recent_deaths[dead_id] = SlainRecord(
        tick=world.tick,
        loc_key=loc_key,
        name=(dead_for_name.name if dead_for_name
              else (dead_char.name if dead_char else dead_id)),
    )

    killer_agent = world.get_agent(killer_id) if killer_id else None
    killer_char = _combatant(world, loc_key, killer_id) if killer_id else None
    killer_name = killer_label or (killer_agent.name if killer_agent else (
        killer_char.name if killer_char else "something"
    ))

    dead_agent = world.get_agent(dead_id)
    if dead_agent is not None:
        # An agent falls: everything they carried hits the ground.
        char = dead_agent.character
        loot = list(char.inventory)
        char.inventory = []
        char.equipped_weapon = None
        char.equipped_armor = None
        dead_agent.cause_of_death = f"slain by {killer_name}"
        if site is not None:
            room = site.map_grid.rooms.get(place)
            for item in loot:
                site.items[item.id] = item
                if room is not None:
                    room.treasure_item_ids.append(item.id)
        else:
            tile = world.overworld.get_key(place)
            if tile is not None:
                tile.ground_items.extend(loot)
            _tile_remove(world, place, dead_id)
        if killer_agent is not None:
            killer_agent.kills += 1
        events.append(
            EngineEvent(
                event_type=EngineEventType.agent_death,
                tick=world.tick,
                actor=killer_id,
                location=loc_key,
                data={
                    "agent": dead_id,
                    "name": dead_agent.name,
                    "color": dead_agent.color,
                    "cause": "slain",
                    "killer": killer_id,
                    "killer_name": killer_name,
                },
                description=f"{dead_agent.name} has fallen to {killer_name}.",
            )
        )
        if loot:
            events.append(
                EngineEvent(
                    event_type=EngineEventType.loot_drop,
                    tick=world.tick,
                    location=loc_key,
                    data={"owner": dead_agent.name, "items": len(loot)},
                    description=f"{dead_agent.name}'s gear scatters where they fell — {len(loot)} items.",
                )
            )
        return events

    # A mob falls: corpse out of the room.
    if site is not None:
        mob = site.entities.get(dead_id)
        if mob is not None:
            room = site.map_grid.rooms.get(place)
            if room is not None and dead_id in room.entity_ids:
                room.entity_ids.remove(dead_id)
            if killer_agent is not None:
                killer_agent.mob_kills += 1
            # The crown: slaying the central boss stakes the win (finalised
            # by the season check even if the slayer dies this very tick).
            if (
                site.site_id == world.boss_site_id
                and site.boss_id == dead_id
                and killer_agent is not None
            ):
                world.winner = killer_agent.agent_id
                world.winner_name = killer_agent.name
                world.win_reason = "boss"
    return events


def start_local_combat(
    world: SandboxWorld, loc_key: str, rng: random.Random
) -> list[EngineEvent]:
    """Roll initiative for everyone standing here — agents AND mobs."""
    agent_ids = sorted(a.agent_id for a in world.agents_at(loc_key))
    mob_ids = _living_mob_ids(world, loc_key)

    combatant_ids = agent_ids + mob_ids
    actors = [c for cid in combatant_ids if (c := _combatant(world, loc_key, cid)) is not None]
    if len(actors) < 2:
        return []

    order, events = roll_group_initiative(actors, rng, world.tick)
    world.combats[loc_key] = SandboxCombat(
        combat=CombatState(
            active=True,
            round_number=1,
            initiative_order=order,
            current_turn_index=0,
            combatant_ids=combatant_ids,
        ),
        loc_key=loc_key,
    )
    names = [a.name for a in actors]
    events.append(
        EngineEvent(
            event_type=EngineEventType.combat_start,
            tick=world.tick,
            location=loc_key,
            data={"combatant_ids": combatant_ids, "names": names},
            description="Combat begins! " + " vs ".join(names),
        )
    )
    for ev in events:
        ev.location = loc_key
    return events


def _resolve_target(
    world: SandboxWorld, loc_key: str, actor_id: str, target_ref: str | None
) -> tuple[str, Character] | None:
    """A living co-located combatant by name or id; sensible auto-target.

    Auto-target picks mobs first; a rival only when already hostile to the
    actor. Turning on an ally must always be explicit.
    """
    site_id, place = split_loc(loc_key)
    site = world.get_site(site_id)

    mobs: list[tuple[str, Character]] = []
    if site is not None:
        room = site.map_grid.rooms.get(place)
        if room is not None:
            for eid in room.entity_ids:
                mob = site.entities.get(eid)
                if mob is not None and mob.is_alive:
                    mobs.append((eid, mob))
    rivals = [
        (a.agent_id, a.character)
        for a in world.agents_at(loc_key)
        if a.agent_id != actor_id
    ]

    if target_ref:
        ref = target_ref.strip().lower()
        for cid, char in mobs + rivals:
            if cid.lower() == ref or char.name.lower() == ref:
                return cid, char
        return None

    if mobs:
        return mobs[0]
    combat = world.combats.get(loc_key)
    if combat is not None:
        for cid, char in rivals:
            if combat.is_hostile(actor_id, cid):
                return cid, char
    return None


def _pvp_allowed(agent: SandboxAgent) -> bool:
    return agent.position.kind == "dungeon"


def _slain_here_now(
    world: SandboxWorld, loc_key: str, target_ref: str | None
) -> SlainRecord | None:
    """The corpse of a named target that fell HERE, on THIS tick."""
    if not target_ref:
        return None
    ref = target_ref.strip().lower()
    for cid, rec in world.recent_deaths.items():
        if rec.tick != world.tick or rec.loc_key != loc_key:
            continue
        if cid.lower() == ref or rec.name.lower() == ref:
            return rec
    return None


def attack_action(
    world: SandboxWorld,
    agent: SandboxAgent,
    target_ref: str | None,
    rng: random.Random,
    loc_key: str,
) -> list[EngineEvent]:
    """One attack, in or out of combat. Marks hostility on agent targets."""
    resolved = _resolve_target(world, loc_key, agent.agent_id, target_ref)
    if resolved is None:
        # A target that was legal when the order was submitted and died to an
        # earlier initiative slot is not a mistake by this player. Say which
        # it was — the turn is spent either way, but only one of them is
        # something they could have done differently.
        slain = _slain_here_now(world, loc_key, target_ref)
        if slain is not None:
            return fail(
                world, agent, "attack",
                f"{slain.name} was cut down before your blow landed — someone "
                "else got there first this round",
                code="target_slain_this_round",
            )
        return fail(
            world, agent, "attack",
            f"no target called '{target_ref}' here" if target_ref else "no target here",
            code="no_such_target" if target_ref else "no_target_here",
        )

    target_id, target_char = resolved
    target_agent = world.get_agent(target_id)
    if target_agent is not None and not _pvp_allowed(agent):
        return fail(
            world, agent, "attack",
            "the overworld truce holds — steel is drawn only in the dark",
        )

    if target_agent is not None:
        combat = world.combats.get(loc_key)
        if combat is not None:
            combat.mark_hostile(agent.agent_id, target_id)

    events, died = resolve_attack(
        agent.character, target_char, rng, world.tick,
        target_ac_bonus=_dodge_bonus(world, loc_key, target_id, target_char),
    )
    for ev in events:
        ev.actor = agent.agent_id
        ev.location = loc_key
    if died:
        events += handle_actor_death(world, target_id, agent.agent_id, loc_key)
    return events


def _dodge_bonus(
    world: SandboxWorld, loc_key: str, target_id: str, target: Character
) -> int:
    """AC the target has from a Dodge it took and has not yet spent.

    Mobs never dodge — ``mob_action`` only ever attacks — so in practice this
    only ever fires for agents.
    """
    sc = world.combats.get(loc_key)
    if sc is None or target_id not in sc.combat.dodging_ids:
        return 0
    return dodge_ac_bonus(target)


def apply_combat_action(
    world: SandboxWorld,
    agent: SandboxAgent,
    action: dict,
    rng: random.Random,
    loc_key: str,
    defaulted: bool = False,
) -> list[EngineEvent]:
    """One combat turn for an agent: attack / dodge / use_item / flee.

    ``defaulted`` marks a turn the engine supplied rather than the agent —
    a timeout, a missing decision. Only a dodge the agent actually chose
    raises their AC; a defaulted one is the wasted turn it has always been,
    and so is the dodge we fall back to after a rejected action.
    """
    sc = world.combats.get(loc_key)
    combat = sc.combat if sc is not None else None
    kind = str((action or {}).get("action") or "dodge").lower()
    events: list[EngineEvent] = []

    if kind == "attack":
        atk = attack_action(world, agent, action.get("target"), rng, loc_key)
        events += atk
        if atk and atk[0].event_type is EngineEventType.action_failed:
            events += resolve_dodge(agent.character, world.tick)
        return _stamp(events, agent, loc_key)

    if kind == "use_item":
        return _stamp(use_inventory_item(world, agent, action.get("item") or ""), agent, loc_key)

    if kind == "flee":
        # Turning your back is not free: every enemy engaged with you takes
        # one parting blow before you clear the room. Mobs always swing;
        # rivals only if hostilities are open. Cut down mid-flight = dead
        # where you stood.
        if combat is not None:
            for cid in list(combat.combatant_ids):
                if cid == agent.agent_id:
                    continue
                attacker = _combatant(world, loc_key, cid)
                if attacker is None or not attacker.is_alive:
                    continue
                if world.get_agent(cid) is not None and not sc.is_hostile(
                    agent.agent_id, cid
                ):
                    continue  # neutral rivals let you go
                opp, died = resolve_attack(
                    attacker, agent.character, rng, world.tick,
                    target_ac_bonus=_dodge_bonus(
                        world, loc_key, agent.agent_id, agent.character
                    ),
                )
                if opp:
                    opp[0].description = f"Parting blow! {opp[0].description}"
                for ev in opp:
                    ev.actor = cid
                    ev.location = loc_key
                events += opp
                if died:
                    events += handle_actor_death(world, agent.agent_id, cid, loc_key)
                    return _stamp(events, agent, loc_key)
        if combat is not None:
            if agent.agent_id not in combat.fled_ids:
                combat.fled_ids.append(agent.agent_id)
            if agent.agent_id in combat.combatant_ids:
                combat.combatant_ids.remove(agent.agent_id)
            if agent.agent_id in combat.dodging_ids:
                combat.dodging_ids.remove(agent.agent_id)
        events.append(
            EngineEvent(
                event_type=EngineEventType.flee,
                tick=world.tick,
                actor=agent.agent_id,
                location=loc_key,
                data={"character_id": agent.agent_id},
                description=f"{agent.name} flees from combat!",
            )
        )
        direction = str(action.get("direction") or "").upper()
        if agent.position.kind == "dungeon":
            move_events = dungeon_move(world, agent, direction, rng)
            if move_events and move_events[0].event_type is EngineEventType.action_failed:
                # fallback: any open passage (fleeing is uncontested)
                site = world.get_site(agent.position.site_id)
                room = None
                if site is not None and agent.position.room:
                    r, c = (int(x) for x in agent.position.room.split(","))
                    room = site.map_grid.get_room(r, c)
                if room is not None:
                    for d, connected in room.connections.items():
                        if connected:
                            move_events = dungeon_move(world, agent, d.value, rng)
                            break
            events += move_events
        else:
            move_events = travel(world, agent, direction)
            if move_events and move_events[0].event_type is EngineEventType.action_failed:
                q, r = parse_hex_key(agent.position.hex or "0,0")
                for d, (dq, dr) in HEX_DIRECTIONS.items():
                    if world.overworld.get(q + dq, r + dr) is not None:
                        move_events = travel(world, agent, d)
                        break
            events += move_events
        return _stamp(events, agent, loc_key)

    guarded = kind == "dodge" and not defaulted
    if kind != "dodge":
        events += fail(world, agent, kind, "only attack, dodge, flee, or use_item in combat")
    bonus = dodge_ac_bonus(agent.character) if guarded else 0
    if guarded and combat is not None and agent.agent_id not in combat.dodging_ids:
        combat.dodging_ids.append(agent.agent_id)
    events += resolve_dodge(agent.character, world.tick, bonus)
    return _stamp(events, agent, loc_key)


def _stamp(events: list[EngineEvent], agent: SandboxAgent, loc_key: str) -> list[EngineEvent]:
    for ev in events:
        if ev.actor is None:
            ev.actor = agent.agent_id
        if ev.location is None:
            ev.location = loc_key
    return events


def mob_action(
    world: SandboxWorld, loc_key: str, mob_id: str, rng: random.Random
) -> list[EngineEvent]:
    """Mob AI: the bloodied draw the pack — strike the most WOUNDED agent
    (hp fraction, not absolute hp)."""
    mob = _combatant(world, loc_key, mob_id)
    if mob is None or not mob.is_alive:
        return []
    targets = sorted(
        world.agents_at(loc_key),
        key=lambda a: (a.character.hp / max(a.character.max_hp, 1), a.agent_id),
    )
    if not targets:
        return []
    victim = targets[0]
    events, died = resolve_attack(
        mob, victim.character, rng, world.tick,
        target_ac_bonus=_dodge_bonus(world, loc_key, victim.agent_id, victim.character),
    )
    for ev in events:
        ev.actor = mob_id
        ev.location = loc_key
    if died:
        events += handle_actor_death(world, victim.agent_id, mob_id, loc_key)
    return events


def run_rotation(
    world: SandboxWorld,
    loc_key: str,
    decisions: dict[str, dict | None],
    rng: random.Random,
    defaulted_ids: set[str] | None = None,
) -> list[EngineEvent]:
    """One full initiative round from the tick's submitted decisions.

    Agents act on the action they submitted this tick (default: dodge);
    mobs strike the weakest. One round per world tick.

    ``defaulted_ids`` names the agents the caller answered for. It is passed
    alongside the decisions rather than folded into them on purpose: the
    decision dicts come from agents, and no agent should be able to claim —
    or be robbed of — a Dodge guard by choosing a key.
    """
    sc = world.combats.get(loc_key)
    if sc is None or not sc.combat.active:
        return []
    combat = sc.combat
    defaulted_ids = defaulted_ids or set()

    events: list[EngineEvent] = []
    for entry in list(combat.initiative_order):
        cid = entry.character_id
        if cid in combat.fled_ids or cid not in combat.combatant_ids:
            continue
        agent = world.get_agent(cid)
        if agent is not None:
            if not agent.is_alive or agent.loc_key != loc_key:
                continue
            # Your guard lasts until your next turn — which is now.
            if cid in combat.dodging_ids:
                combat.dodging_ids.remove(cid)
            submitted = decisions.get(cid)
            action = submitted or {"action": "dodge"}
            events += apply_combat_action(
                world, agent, action, rng, loc_key,
                defaulted=submitted is None or cid in defaulted_ids,
            )
        else:
            mob = _combatant(world, loc_key, cid)
            if mob is None or not mob.is_alive:
                continue
            events += mob_action(world, loc_key, cid, rng)

    combat.round_number += 1
    return events


def check_local_combat_end(world: SandboxWorld, loc_key: str) -> list[EngineEvent]:
    """A fight ends when no opposed living pair remains here.

    Opposition = mobs vs agents, or a live hostile agent pair (betrayal).
    Co-located agents with no grudge simply stand down once the mobs fall.
    """
    sc = world.combats.get(loc_key)
    if sc is None:
        return []
    combat = sc.combat

    living_agents = [
        cid for cid in combat.combatant_ids
        if (a := world.get_agent(cid)) is not None
        and a.is_alive and a.loc_key == loc_key and cid not in combat.fled_ids
    ]
    living_mobs = [
        cid for cid in combat.combatant_ids
        if world.get_agent(cid) is None
        and (m := _combatant(world, loc_key, cid)) is not None and m.is_alive
    ]

    if living_mobs and living_agents:
        return []
    hostile_pair_alive = any(
        sc.is_hostile(a, b)
        for i, a in enumerate(living_agents)
        for b in living_agents[i + 1 :]
    )
    if hostile_pair_alive:
        return []

    if not living_agents:
        desc = "Combat ends — the room falls silent."
        reason = "no_one_left_standing"
    elif len(living_agents) == 1:
        victor = world.get_agent(living_agents[0])
        desc = f"Combat ends — {victor.name if victor else 'the last one standing'} takes the field!"
        reason = "victor"
    else:
        desc = "Combat ends — the survivors lower their weapons."
        reason = "truce"

    combat.active = False
    del world.combats[loc_key]
    return [
        EngineEvent(
            event_type=EngineEventType.combat_end,
            tick=world.tick,
            location=loc_key,
            data={"reason": reason},
            description=desc,
        )
    ]


def combat_upkeep(
    world: SandboxWorld, tick_events: list[EngineEvent], rng: random.Random
) -> list[EngineEvent]:
    """After all actions: fold joiners in, ignite new fights, end dead ones.

    New fights start where living mobs share a room with agents (implicit
    co-op — everyone present is rolled in, presumed fighting the mobs) or
    where an out-of-combat attack happened this tick and both parties still
    stand there (the ambush becomes the brawl).
    """
    events: list[EngineEvent] = []

    ambush_locs = {
        e.location for e in tick_events
        if e.event_type is EngineEventType.attack and e.location
        and e.location not in world.combats
    }
    # An ambush between agents seeds the fight's first grudge.
    ambush_pairs: dict[str, list[tuple[str, str]]] = {}
    for e in tick_events:
        if e.event_type is not EngineEventType.attack or not e.location:
            continue
        attacker = e.data.get("attacker_id")
        defender = e.data.get("defender_id")
        if attacker and defender and world.get_agent(attacker) and world.get_agent(defender):
            ambush_pairs.setdefault(e.location, []).append((attacker, defender))

    by_loc: dict[str, list[SandboxAgent]] = {}
    for agent in world.living_agents():
        by_loc.setdefault(agent.loc_key, []).append(agent)

    for loc_key, agents_here in sorted(by_loc.items()):
        sc = world.combats.get(loc_key)
        mobs_here = _living_mob_ids(world, loc_key)

        if sc is not None and sc.combat.active:
            combat = sc.combat
            joiners = [a for a in agents_here if a.agent_id not in combat.combatant_ids
                       and a.agent_id not in combat.fled_ids]
            if joiners:
                order, roll_events = roll_group_initiative(
                    [j.character for j in joiners], rng, world.tick
                )
                for ev in roll_events:
                    ev.location = loc_key
                events += roll_events
                combat.combatant_ids.extend(j.agent_id for j in joiners)
                combat.initiative_order.extend(order)
                combat.initiative_order.sort(key=lambda e: e.roll, reverse=True)
        elif mobs_here or (loc_key in ambush_locs and len(agents_here) >= 2):
            if agents_here and (mobs_here or len(agents_here) >= 2):
                events += start_local_combat(world, loc_key, rng)
                new_sc = world.combats.get(loc_key)
                if new_sc is not None:
                    for a, b in ambush_pairs.get(loc_key, []):
                        new_sc.mark_hostile(a, b)

    for loc_key in sorted(world.combats):
        events += check_local_combat_end(world, loc_key)

    return events

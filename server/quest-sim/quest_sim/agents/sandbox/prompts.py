"""System prompt + observation renderer for hosted sandbox brains.

The prompt renders ``build_observation``'s dict — the hosted brain sees
exactly what a BYO agent sees, worded for an LLM.
"""

from __future__ import annotations

SANDBOX_SYSTEM_PROMPT = """\
You are {name}, one of {pool_size} competitors dropped onto a hostile island. \
There is exactly one crown and you want it.

## How to win
- **The crown**: at the island's center lies the Heart of the Island. Slay its \
boss for INSTANT victory. It is deadly at STARTER gear — but your objective \
carries an engine-computed gear check, and when it says READY, the Heart is \
winnable BY YOU: acting on it is how seasons are won, waiting past it is how \
they are lost.
- **Outlast**: be the last one standing. Death is permanent and drops \
everything you carry.

## The island
- You travel a hex overworld (directions E, W, NE, NW, SE, SW) and descend \
into dungeons at their mouths (grid rooms, directions N, S, E, W).
- Dungeons hold monsters, traps, and the loot that decides fights: weapons \
(+attack), shields (+AC), healing potions.
- **The overworld truce is absolute**: attacking a rival on the surface always \
fails. Inside dungeons, attacking rivals is legal — and so is being attacked.
- **Implicit co-op**: sharing a room with monsters pulls everyone present into \
one fight, presumed allied against the mobs. You may betray mid-fight; grudges \
persist until the fight ends.
- Combat is one initiative round per turn: attack, dodge, flee, or drink.
- **Dodge is real defence**: +2 + your DEX to AC against every attack until \
your next turn, but you deal no damage. Worth it when you are outmatched and \
waiting on a potion, an ally, or better odds — dead weight when you are winning.
- **Fleeing provokes.** Every enemy engaged with you takes one free parting \
blow as you turn your back. Flee early, not at death's door — and know that \
a wounded rival trying to flee YOU is at their most killable.
- Your own stats are exact. Rivals' health is worded: hale, wounded, badly \
wounded, near death.
- **Explored, searched rooms hold nothing new — ever.** Do not re-enter them \
without a reason. Chase exits marked UNEXPLORED, follow the "nearest \
UNEXPLORED room" pointer, and when a dungeon is fully explored, leave. \
"Already searched" means YOU searched it: you get one look per room, and a \
failed look is spent. A room a rival gave up on may still hold everything.
- **`search` is offered ONLY where something is actually hidden.** If it is \
not on your action list, this room has nothing to find and searching it would \
waste the turn — move on. When it IS offered, it is worth the turn.
- **Commit to a destination.** Pick a target — a dungeon mouth or the Heart — \
and walk it down before reconsidering. Reversing course every turn is how \
challengers die gearless within sight of the crown.

## Response format
Respond with a short Thought (1-3 sentences, in character, it is shown to \
spectators) then a code block calling final_answer with ONE action string:

Thought: The vault is picked clean and I'm still hale — time to push inward.
```py
final_answer("ACTION:travel:direction=NE")
```

Action strings: `type:key=value` — for example `move:direction=N`, \
`attack:target=Skeleton Guard`, `use_item:item=Potion of Healing`, `search`, \
`pick_up`, `equip:item=Iron Blade`, `enter`, `exit`, `travel:direction=SE`, \
`dodge`, `flee:direction=W`, `wait`. The observation lists exactly which \
actions are valid right now — never choose anything else.

## Persona
{persona}
"""


def _lines(items: list[str]) -> str:
    return "\n".join(f"- {x}" for x in items) if items else "- none"


def format_sandbox_prompt(obs: dict) -> str:
    """Render one observation into the per-tick task prompt."""
    you = obs["you"]
    loc = obs["location"]
    obj = obs["objective"]
    objective = obj["text"]
    if obj.get("center_hex"):
        objective += f" The {obj.get('boss_site') or 'Heart'} waits at hex {obj['center_hex']}"
        if obj.get("distance_hexes") and obj.get("bearing"):
            objective += f" — {obj['distance_hexes']} hexes {obj['bearing']} of you"
        objective += "."
    if obj.get("boss_readiness"):
        objective += (
            f"\nGear check (engine-computed, trust it over your fear): "
            f"{obj['boss_readiness']} [gear score {obj.get('your_gear_score', 0)}]."
        )
    parts: list[str] = [
        "## You",
        f"{you['name']} — HP {you['hp']}/{you['max_hp']} | AC {you['ac']}"
        f" | rival kills {you['kills']} | mobs slain {you.get('mob_kills', 0)}",
        f"Weapon: {you['equipped_weapon']}",
        f"Inventory: {', '.join(you['inventory']) or 'empty'}",
        "",
        "## Objective",
        objective,
        "",
    ]

    if loc["kind"] == "overworld":
        parts += [
            "## Where you stand (overworld)",
            f"Hex {loc['hex']} — {loc['terrain']}.",
        ]
        if loc.get("site_here"):
            site = loc["site_here"]
            tag = " ← THE BOSS DUNGEON" if site.get("is_boss_site") else ""
            parts.append(f"A dungeon mouth yawns here: {site['name']}{tag}. `enter` descends.")
        if loc.get("ground_items"):
            parts.append(f"On the ground: {', '.join(loc['ground_items'])}")
        neigh = []
        for n in loc.get("neighbours", []):
            bits = n["terrain"]
            if n.get("heart_distance") is not None:
                bits += f", Heart {n['heart_distance']} away"
            if n.get("site"):
                bits += f", mouth of {n['site']}"
            if n.get("rivals"):
                bits += f", rivals: {', '.join(n['rivals'])}"
            label = f"{n['direction']} ({n['hex']})" if n.get("direction") else n["hex"]
            neigh.append(f"{label}: {bits}")
        parts += ["", "## Neighbouring hexes", _lines(neigh)]
        gear_ptr = loc.get("nearest_unexplored_site")
        if gear_ptr:
            where = (
                f"{gear_ptr['distance_hexes']} hexes {gear_ptr['bearing']}"
                if gear_ptr.get("bearing")
                else "right here"
            )
            parts.append(
                f"Nearest UNEXPLORED dungeon: {gear_ptr['name']} — {where} "
                f"(hex {gear_ptr['hex']}). That is where fresh gear lives."
            )
    else:
        tag = " — THE BOSS DUNGEON" if loc.get("is_boss_site") else ""
        parts += [
            f"## Where you stand ({loc['site_name']}{tag})",
            f"Room {loc['room']} — {loc['room_type']}."
            + (" Already searched." if loc.get("searched") else ""),
        ]
        if loc.get("description"):
            parts.append(loc["description"])
        if loc.get("at_entrance"):
            parts.append("This is an entrance room — `exit` returns to the surface.")
        if loc.get("mobs"):
            parts.append("Monsters here: " + ", ".join(
                f"{m['name']} ({m['hp']}/{m['max_hp']} HP)" for m in loc["mobs"]
            ))
        if loc.get("ground_items"):
            parts.append(f"Visible loot: {', '.join(loc['ground_items'])}")
        exits = [
            f"{d}: {e['room_type']}"
            + (" (already explored)" if e.get("visited") else " (UNEXPLORED)")
            for d, e in sorted(loc.get("exits", {}).items())
        ]
        parts += ["", "## Exits", _lines(exits)]
        nu = loc.get("nearest_unexplored")
        if nu:
            parts.append(
                f"Nearest UNEXPLORED room: {nu['distance']} room(s) away — "
                f"first step {nu['direction']}."
            )
        elif loc.get("site_explored"):
            parts.append(
                "You have explored EVERY room of this dungeon — nothing new "
                "remains here. Head for the entrance and `exit`."
            )
        exit_ptr = loc.get("nearest_exit")
        if exit_ptr and exit_ptr.get("distance", 0) > 0:
            parts.append(
                f"Nearest exit: {exit_ptr['distance']} room(s) away — "
                f"first step {exit_ptr['direction']}."
            )

    rivals = [
        f"{r['name']} — {r['hp_band']}, wielding {r['weapon']}, {r['kills']} kills"
        + (" (FIGHTING YOU)" if r.get("in_combat_with_you") else "")
        for r in obs.get("rivals_here", [])
    ]
    if rivals:
        parts += ["", "## Rivals here", _lines(rivals)]
    adjacent = [f"{r['name']} at {r['hex']} — {r['hp_band']}" for r in obs.get("rivals_adjacent", [])]
    if adjacent:
        parts += ["", "## Rivals one hex away", _lines(adjacent)]

    combat = obs.get("combat")
    if combat and combat.get("active"):
        combatants = [
            f"{c['name']} ({c['kind']}, {c.get('hp_band', '?')})"
            + (" — HOSTILE TO YOU" if c.get("hostile_to_you") else "")
            for c in combat.get("combatants", [])
            if c.get("kind") != "you"
        ]
        parts += ["", f"## COMBAT — round {combat['round']}", _lines(combatants)]

    events = [e["description"] for e in obs.get("last_tick_events", [])]
    if events:
        parts += ["", "## Since your last turn", _lines(events)]

    if obs.get("warnings"):
        parts += ["", "## ⚠ Warnings", _lines(obs["warnings"])]

    parts += [
        "",
        "## Valid actions right now",
        _lines(obs.get("valid_actions", [])),
        "",
        'Respond with Thought: then a code block calling final_answer("ACTION:...").',
    ]

    if you["hp"] <= you["max_hp"] * 0.25:
        parts.insert(0, f"⚠ CRITICAL: {you['hp']}/{you['max_hp']} HP. Survive first.\n")

    return "\n".join(parts)

#!/usr/bin/env python
"""A scripted BYO (bring-your-own) agent playing over plain HTTP.

Exactly what an external competitor would run: join the lobby, then loop
observation -> decide -> action until death or season end. The decision
logic is deliberately simple and reads ONLY the observation payload — no
engine imports, no privileged knowledge. Doubles as the E2E proof that the
play-by-API surface is complete.

    python scripts/sandbox_byo_client.py --server http://localhost:8000 \\
        [--world w-XXXX | --new] [--name CHALLENGER] [--start-when-full] [--poll 0.5]
"""

from __future__ import annotations

import argparse
import random
import sys
import time

import httpx


def decide(obs: dict, rng: random.Random) -> str:
    """A competent-enough brain over the public observation contract."""
    you = obs["you"]
    acts = obs.get("valid_actions", [])
    combat = obs.get("combat")
    location = obs.get("location", {})

    def can(prefix: str) -> bool:
        return any(a.startswith(prefix) for a in acts)

    # Drink when hurt and allowed
    potion = next((i for i in you.get("inventory", []) if "heals" in i), None)
    if potion and you["hp"] < you["max_hp"] * 0.45 and can("use_item"):
        return f"use_item:item={potion.split(' (')[0]}"

    if combat and combat.get("active"):
        mobs = [c for c in combat.get("combatants", []) if c.get("kind") == "mob"]
        if mobs:
            return f"attack:target={mobs[0]['name']}"
        hostiles = [c for c in combat.get("combatants", [])
                    if c.get("kind") == "agent" and c.get("hostile_to_you")]
        if hostiles:
            return f"attack:target={hostiles[0]['name']}"
        return "dodge"

    if location.get("kind") == "dungeon":
        mobs = location.get("mobs", [])
        if mobs:
            return f"attack:target={mobs[0]['name']}"
        if location.get("ground_items") and can("pick_up"):
            return "pick_up"
        if "search" in acts:
            return "search"
        exits = location.get("exits", {})
        unvisited = [d for d, e in exits.items() if not e.get("visited")]
        if unvisited:
            return f"move:direction={rng.choice(unvisited)}"
        if "exit" in acts and rng.random() < 0.5:
            return "exit"
        if exits:
            return f"move:direction={rng.choice(list(exits))}"
        return "wait"

    # Overworld: descend when standing on a mouth, otherwise wander with a
    # pull toward the boss site (the objective text says: the center).
    if "enter" in acts:
        return "enter"
    if location.get("ground_items") and can("pick_up"):
        return "pick_up"
    travel = next((a for a in acts if a.startswith("travel")), None)
    if travel:
        directions = ["E", "W", "NE", "NW", "SE", "SW"]
        return f"travel:direction={rng.choice(directions)}"
    return "wait"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default="http://localhost:8000")
    parser.add_argument("--world", default=None, help="world id to join")
    parser.add_argument("--new", action="store_true", help="create a fresh world")
    parser.add_argument("--seed", type=int, default=None, help="seed for --new")
    parser.add_argument("--name", default="CHALLENGER")
    parser.add_argument("--preset", default=None, choices=["fighter", "rogue", "barbarian"],
                        help="stat kit (default: server picks)")
    parser.add_argument("--tactics", default=None,
                        help="one-liner shown to spectators")
    parser.add_argument("--start-when-full", action="store_true",
                        help="POST /start right after joining")
    parser.add_argument("--poll", type=float, default=0.5)
    parser.add_argument("--rng-seed", type=int, default=None)
    args = parser.parse_args()

    rng = random.Random(args.rng_seed)
    client = httpx.Client(base_url=args.server, timeout=30.0)

    world_id = args.world
    if args.new or world_id is None:
        body = {} if args.seed is None else {"seed": args.seed}
        r = client.post("/world/new", json=body)
        r.raise_for_status()
        world_id = r.json()["world_id"]
        print(f"created world {world_id}")

    r = client.post(f"/world/{world_id}/join", json={
        "name": args.name, "preset": args.preset, "tactics": args.tactics,
    })
    r.raise_for_status()
    me = r.json()
    agent_id, token = me["agent_id"], me["token"]
    headers = {"X-Agent-Token": token}
    print(f"joined as {me['name']} ({agent_id}, color {me['color']}) — "
          f"{me['lobby']['joined']}/{me['lobby']['pool_size']} in lobby")

    if args.start_when_full:
        r = client.post(f"/world/{world_id}/start")
        r.raise_for_status()
        print("season started")

    obs_url = f"/world/{world_id}/agent/{agent_id}/observation"
    act_url = f"/world/{world_id}/agent/{agent_id}/action"
    last_acted_for = 0

    while True:
        r = client.get(obs_url, headers=headers)
        if r.status_code == 404:
            print("world is gone; exiting")
            return 1
        r.raise_for_status()
        obs = r.json()

        if obs.get("game_over"):
            print(f"season over — winner: {obs.get('winner_name') or 'no one'}")
            return 0
        if not obs["you"]["alive"]:
            print("we died. permadeath is final.")
            return 0
        if obs["phase"] == "lobby":
            time.sleep(args.poll)
            continue

        pending_tick = obs["awaiting_action_for_tick"]
        if pending_tick > last_acted_for and not obs.get("action_submitted"):
            action = decide(obs, rng)
            resp = client.post(act_url, json={"action": action}, headers=headers)
            if resp.status_code == 409:
                print(f"[t{pending_tick}] rejected: {resp.json().get('detail')}")
                return 0
            resp.raise_for_status()
            last_acted_for = pending_tick
            print(f"[t{pending_tick}] {obs['you']['hp']}/{obs['you']['max_hp']}hp "
                  f"@{obs['location'].get('kind')} -> {action}")
        time.sleep(args.poll)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nbye")
        sys.exit(0)

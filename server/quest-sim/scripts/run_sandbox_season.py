#!/usr/bin/env python
"""Run a full sandbox season headless with the zero-LLM policy fleet.

Deterministic per seed, sub-second, no server, no tokens — the E2E backbone.

    python scripts/run_sandbox_season.py --seed 7 [--pool 10] [--max-ticks 300] [-v]
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from quest_sim.engine.sandbox.build import build_world, start_season
from quest_sim.engine.sandbox.policy import policy_decide
from quest_sim.engine.sandbox.tick import run_world_tick
from quest_sim.models.events import EngineEventType
from quest_sim.models.sandbox import SandboxConfig, WorldPhase

HEADLINES = {
    EngineEventType.agent_death,
    EngineEventType.season_end,
    EngineEventType.site_enter,
    EngineEventType.combat_start,
    EngineEventType.loot_drop,
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--pool", type=int, default=10)
    parser.add_argument("--max-ticks", type=int, default=300)
    parser.add_argument("--sites", type=int, default=6)
    parser.add_argument("-v", "--verbose", action="store_true", help="print every event")
    args = parser.parse_args()

    t0 = time.perf_counter()
    world = build_world(
        SandboxConfig(pool_size=args.pool, num_sites=args.sites, max_ticks=args.max_ticks),
        seed=args.seed,
    )
    start_season(world)
    print(f"season seed={args.seed}: {len(world.agents)} agents, "
          f"{len(world.sites)} sites, center {world.center_hex}")

    while world.phase == WorldPhase.running:
        decisions = {
            a.agent_id: policy_decide(world, a.agent_id) for a in world.living_agents()
        }
        events = run_world_tick(world, decisions)
        for ev in events:
            if args.verbose or ev.event_type in HEADLINES:
                print(f"  t{ev.tick:>3} [{ev.event_type.value:>13}] {ev.description}")

    dt = time.perf_counter() - t0
    alive = [a.name for a in world.living_agents()]
    print(f"\nseason over in {world.tick} ticks ({dt:.2f}s)")
    print(f"winner: {world.winner_name or '—'} ({world.win_reason}); "
          f"survivors: {', '.join(alive) or 'none'}")
    kills = sorted(world.agents.values(), key=lambda a: -a.kills)[:3]
    print("top kills: " + ", ".join(f"{a.name}={a.kills}" for a in kills))
    return 0 if world.phase == WorldPhase.finished else 1


if __name__ == "__main__":
    raise SystemExit(main())

# Sandbox Demo Runbook — Agent Island

Everything needed to run, rehearse, and present the multi-agent sandbox.
Both repos: `main` (quest-sim + quest-map). The `feat/demo-v2` branches this
runbook was written against are long merged; `main` auto-deploys on push.
In the QuestFi NEAR repository, quest-sim is `server/quest-sim` and quest-map
is `apps/island`.

## Local stack

```bash
# backend — hosted agents think with the LLM by default (the product);
# model + key come from .env (QUEST_SIM_LLM_MODEL / QUEST_SIM_LLM_API_KEY)
cd quest-sim
pip install -e ".[dev]" && pytest                    # all green before demo day
uvicorn quest_sim.main:app --port 8000

# frontend
cd quest-map
npm install && npm run dev                           # http://localhost:5173
```

The spectator opens on a lobby (or adopts a live world). `?world=w-xxxx`
pins a specific world — use it for a second screen or a projector.

## Season lifecycle (spectator drives it from the UI)

The landing view lists every open season: **Watch** to spectate, **Play** to
get the invite line for a coding agent, **Open a lobby** to host your own.
Opening one makes you its host — Begin, the clock and delete are yours, and
a spectator sees none of them. Begin → hosted agents backfill to
`QUEST_SIM_SANDBOX_POOL_SIZE` (default 10) → auto-run at 1×/2×/4×. Pause,
follow, and bet at will. The wordmark returns to the landing view.

By API instead — the create response returns `host_key` once, and the clock
routes need it back as `X-Host-Key`:

```bash
curl -s -X POST localhost:8000/world/new -H 'content-type: application/json' -d '{"seed": 10}'
# → {"world_id": "w-XXXX", "host_key": "kP3n…", …}
W=w-XXXX; HK=<host_key>

curl -s -X POST localhost:8000/world/$W/start -H "X-Host-Key: $HK"
curl -s -X POST localhost:8000/world/$W/run -H "X-Host-Key: $HK" \
  -H 'content-type: application/json' -d '{"tick_seconds": 2.0}'
```

## Curated seeds (pool 10, policy brains, 300-tick bell)

Swept over seeds 1–40; all end in a crown or attrition. Highlights:

| seed | ticks | winner | deaths | feel |
|-----:|------:|--------|-------:|------|
| 16   | 59    | Sorsha | 4      | tight — ~2 min at 2s/tick |
| **10** | **93** | **Sorsha** | **7** | **the demo cut: bloodbath + crown** |
| 7    | 63    | Grix   | 3      | balanced classic |
| 38   | 112   | Grix   | 8      | attrition epic |

`python scripts/run_sandbox_season.py --seed N -v` previews any season in
under a second.

## The BYO showcase (the killer feature)

Any coding agent can join a lobby with three HTTP calls — the protocol
guide at `GET /world/guide` is self-contained (kits, tactics, the exact
observe→act loop). Live on stage:

```bash
# the reference client — join, then drive from a laptop
python scripts/sandbox_byo_client.py --server http://<backend> \
    --world w-XXXX --name CHALLENGER --preset rogue \
    --tactics "Loot fast, betray faster"
```

Or hand a Claude Code session the guide URL and let it write its own loop.
Kill the client mid-season to show resilience: the agent hesitates
(`action_timeout`), the engine plays safe defaults, the world never stalls,
and the client can reconnect with its token.

## Brains

**LLM reasoning + narration is the default** — hosted agents think with the
configured model every tick, and their thoughts stream into the follow
panel, crawler toasts, and memory mirrors. Without it the sandbox is just a
fancy illusion. Budget ~5–15s per tick at pool 10 depending on the model.

The zero-LLM policy fleet remains as the rehearsal/CI mode (deterministic,
instant, token-free — it also drives the seed table above):

```bash
QUEST_SIM_SANDBOX_HOSTED_BRAIN=policy uvicorn quest_sim.main:app --port 8000
```

Scale: brain calls fan out on worker threads, bounded at 16 concurrent
(`LLM_CONCURRENCY` in `agents/sandbox/agent.py`) — a pool of 10 fans out
fully; 100+ agents queue politely within a tick. Growing past ~32 truly
concurrent brains is the cue to move the fan-out to async litellm.

## E2E verification

```bash
# backend suite
cd quest-sim && pytest -q

# spectator E2E (needs both servers up)
cd quest-map && node scripts/pw-sandbox.mjs http://localhost:5173
```

The Playwright run asserts: lobby → betting dock (simulated funds) →
begin season → 10 uniquely-colored roster chips → follow mode + exit pill
→ Escape flows → live ticker → crawler overlay on an underground agent →
no [BRACKET] buttons → no unexpected console errors.

## Demo-day flow (suggested)

1. Open on the lobby — betting line visible, pool at rest.
2. Join a BYO agent from a second terminal (its chip appears, `API` badge).
3. Begin season — spawn ring lands 10 colored beacons, equidistant.
4. Let the god view breathe: descents tick by in the headline feed.
5. Click a beacon → follow into the crawler; initiative announcement +
   per-agent colored skeletons when a fight ignites.
6. Back a favorite in the pool; speed to 4× for the boss push.
7. Crown lands → winner banner + payout toast. "Run it back."

## Environment knobs

| var | default | meaning |
|-----|---------|---------|
| `QUEST_SIM_SANDBOX_POOL_SIZE` | 10 | season roster size |
| `QUEST_SIM_SANDBOX_NUM_SITES` | 6 | POI dungeons (boss site is +1) |
| `QUEST_SIM_SANDBOX_TICK_SECONDS` | 2.0 | auto-run pacing (UI speed ×1) |
| `QUEST_SIM_SANDBOX_ACTION_DEADLINE_S` | 5.0 | BYO action window per tick |
| `QUEST_SIM_SANDBOX_MAX_TICKS` | 300 | season bell |
| `QUEST_SIM_SANDBOX_HOSTED_BRAIN` | llm | `llm` (product) or `policy` (rehearsal/CI) |
| `QUEST_SIM_NEAR_ENABLED` | off | settle seasons on the NEAR contract; see [near_settlement.md](near_settlement.md) |

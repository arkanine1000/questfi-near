# Quickstart

Get Agent Island running and watch your first season in under 5 minutes.

## 1. Install

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
```

## 2. Configure your LLM

Copy the example env file and add your API key:

```bash
cp .env.example .env
```

Edit `.env` with your provider. Examples:

**OpenAI:**
```
QUEST_SIM_LLM_MODEL=openai/gpt-4o-mini
QUEST_SIM_LLM_API_KEY=sk-...
```

**Anthropic:**
```
QUEST_SIM_LLM_MODEL=anthropic/claude-sonnet-4-20250514
QUEST_SIM_LLM_API_KEY=sk-ant-...
```

**Ollama (local, no key needed):**
```
QUEST_SIM_LLM_MODEL=ollama/llama3
QUEST_SIM_LLM_API_BASE=http://localhost:11434
```

## 3. Run tests (no LLM required)

```bash
pytest
```

All tests should pass — they use deterministic RNG seeds and don't call any LLM.

## 4. Start the server

```bash
uvicorn quest_sim.main:app --reload
```

The API is now live at `http://localhost:8000`. Interactive docs at `http://localhost:8000/docs`.

## 5. Preview a season with no LLM spend

The policy brain is deterministic and token-free — the fastest way to see a
whole season resolve:

```bash
python scripts/run_sandbox_season.py --seed 10 -v
```

Seeds 7, 10, 16 and 38 are curated; see [sandbox_demo.md](sandbox_demo.md).

## 6. Open a lobby

```bash
curl -s -X POST localhost:8000/world/new \
  -H 'content-type: application/json' \
  -d '{"seed": 10, "hosted_brain": "policy", "pool_size": 4}'
```

```json
{"world_id": "w-4cce128c", "phase": "lobby", "seed": 10, "pool_size": 4,
 "join_url": "/world/w-4cce128c/join", "guide_url": "/world/guide",
 "host_key": "kP3n…", "host": {"start_url": "/world/w-4cce128c/start", …}}
```

**Keep `host_key`.** It is returned exactly once, and it is what lets you
start, pause and delete this season. The `host` block spells out the routes
it opens. Export it now:

```bash
W=w-4cce128c; HK=<host_key from above>
```

Use `"hosted_brain": "policy"` while you are exploring — `"llm"` (the default)
spends tokens on every hosted agent, every tick.

## 7. Join as a player

```bash
curl -s -X POST localhost:8000/world/w-4cce128c/join \
  -H 'content-type: application/json' \
  -d '{"name": "Rook", "preset": "rogue"}'
```

Returns your `agent_id` and a `token`. Keep the token — every action needs it as
an `X-Agent-Token` header. Kits are `fighter`, `rogue` and `barbarian`.

## 8. Start the season

```bash
curl -s -X POST localhost:8000/world/$W/start -H "X-Host-Key: $HK"
```

Hosted brains backfill the roster to `pool_size` and the clock starts.

Only the host starts a season. Players can signal they are ready
(`POST /world/{id}/agent/{aid}/ready`) and it shows on the lobby roster, but
it never starts anything. Without a valid key this route answers 403 — see
[Host controls](../README.md#host-controls) for the deploy-time modes.

## 9. Play a turn

Observe, then act. One turn is one GET and one POST:

```bash
A=agent-01; T=<your token>

curl -s localhost:8000/world/$W/agent/$A/observation -H "X-Agent-Token: $T"

curl -s -X POST localhost:8000/world/$W/agent/$A/action \
  -H "X-Agent-Token: $T" -H 'content-type: application/json' \
  -d '{"action": "move:direction=N"}'
```

Every observation carries an exhaustive `valid_actions` list — it is always
correct, so pick from it rather than guessing. Actions are
`type:key=value` strings: `move:direction=N`, `attack:target=agent-03`,
`search`, `use:item=Healing Potion`.

The tick advances the moment every living player has submitted, or when a
player's own deadline runs out — whichever comes first. Your clock starts
when the observation is handed to you: `deadline_s` is the full budget and
`remaining_s` is what is left. Miss it and the engine plays a defensive
default for you, and says so in your next observation's `missed_ticks`.

## 10. Auto-run and spectate

```bash
curl -s -X POST localhost:8000/world/$W/run -H "X-Host-Key: $HK" \
  -H 'content-type: application/json' -d '{"tick_seconds": 2.0}'

curl -N localhost:8000/world/$W/stream     # SSE: ticks, combat, deaths, commentary
curl -s localhost:8000/world/$W/state      # roster + phase snapshot (no key needed)
```

`tick_seconds` paces a world with no external players in it. As soon as
one is playing, the readiness barrier sets the rhythm instead and
`min_tick_gap_s` is only a floor between frames; `/state` reports which
regime is live as `pacing_mode`.

`POST /world/{id}/pause` stops the clock and `POST /world/{id}/tick` steps
exactly one tick by hand — both need `X-Host-Key` too. A manual step waits
for the players like any other tick; add `?wait_s=0` to step instantly when
scripting a season. When you are done,
`curl -X DELETE localhost:8000/world/$W -H "X-Host-Key: $HK"` erases the
season rather than waiting for the TTL sweep.

## 11. Play with a coding agent instead

Point any coding agent at the invite for a world and it can play unaided:

```bash
echo "Read http://localhost:8000/world/$W/invite.md and play."
```

The `.md` matters: handed an extensionless URL an agent has to guess what is
behind it, and at least one started a browser rather than fetching a
document. Both docs are markdown and are served at either path.

`GET /world/guide.md` is the self-contained briefing behind that invite,
written to the agent rather than to you; `scripts/sandbox_byo_client.py` is a
reference client.

There is also an **experimental** MCP transport over the same engine:

```bash
claude mcp add --transport http island http://localhost:8000/mcp/
```

It exposes `join_season`, `take_turn`, `look` and `rejoin` as native tools.
HTTP is the supported path — fall back to it if MCP misbehaves.

## Persistence

```
data/
├── quests/          # prefab quest definitions, seeded at startup
└── worlds/          # one directory per season (world.json + event log)
```

Abandoned seasons are garbage-collected on a TTL per phase — see the
`QUEST_SIM_SANDBOX_*_TTL_H` settings.

## Troubleshooting

**`Address already in use`** — something already holds port 8000. Pass
`--port 8011`, or point the frontend at the new port with `VITE_BACKEND_URL`.

**Hosted agents do nothing / the season stalls** — the LLM brain needs
`QUEST_SIM_LLM_API_KEY`. Use `"hosted_brain": "policy"` to run without one.

**`/tts` returns 503** — Prompt-chan's voice is unconfigured. Set
`QUEST_SIM_TTS_API_KEY` and `QUEST_SIM_TTS_VOICE_ID`, or let the browser fall
back to its own Web Speech voice.

**`401 Missing or invalid X-Agent-Token`** — the action endpoint needs the token
returned by `join`, not the `agent_id`.

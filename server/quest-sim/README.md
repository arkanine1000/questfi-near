# Quest-Sim — Agent Island

A live, multi-agent survival season on a hostile island. Up to N challengers —
hosted LLM agents, or **your own coding agent joining over HTTP or MCP** — explore
an overworld, raid prefab dungeon sites, fight each other, and race for the
Heart of the Island. A deterministic D&D-lite engine resolves every tick, and
humans spectate in real time.

The spectator frontend (quest-map) is [`apps/island`](../../apps/island) in this
repository. With NEAR settlement on, the server is the operator of the QuestFi
contract and settles every season on chain; see
[docs/near_settlement.md](docs/near_settlement.md).

## How It Works

```
POST /world/new          → open a lobby; returns a host_key, once
POST /world/{id}/join    → claim an agent; returns agent_id + token
POST /world/{id}/start   → host begins the season; hosted brains backfill

  per tick, for every living agent:
    GET  /world/{id}/agent/{aid}/observation   → what you can see + valid_actions
    POST /world/{id}/agent/{aid}/action        → one action, e.g. "move:direction=N"

  the tick advances the moment every living player has submitted

GET /world/{id}/stream   → SSE: ticks, combat, deaths, commentary (spectators)
```

Agents act **simultaneously**; the engine is the single source of truth. Every
action is a `type:key=value` string (`move:direction=N`, `attack:target=agent-03`,
`search`), and each observation carries an exhaustive `valid_actions` list, so a
player never has to guess the protocol.

### Bring your own agent

Any coding agent can play. The self-contained protocol briefing lives at
`GET /world/guide` — it is written *to the agent*, not to a developer.

`scripts/sandbox_byo_client.py` is a reference HTTP client.

There is also an **experimental** MCP transport over the same engine:

```bash
claude mcp add --transport http island <HOST>/mcp/
```

That exposes `join_season`, `take_turn`, `look` and `rejoin` as native tools.
HTTP remains the supported path — if MCP misbehaves, fall back to it.

### Hosted brains

Agents that nobody brings are filled by hosted brains, selected per world with
`hosted_brain`:

| Brain | Cost | Use |
|-------|------|-----|
| `llm` | tokens | the product — smolagents `CodeAgent` reasoning + in-character narration |
| `policy` | free | deterministic rehearsal and CI; no API key needed |

Prompt-chan, the commentator, narrates the season for spectators and is voiced
through the `/tts` ElevenLabs proxy (falls back to the browser's Web Speech
voice when unconfigured).

### The Engine

Combat is light D&D: d20 attack rolls vs AC, ability modifiers, initiative
order, DC-based skill checks, critical hits. Every roll takes a seeded
`random.Random`, so a season is reproducible from its seed given the same agent
outputs. Dungeon sites are instantiated from hand-authored **prefab quests** in
`quest_sim/prefabs/`, validated at load.

## Project Structure

```
quest_sim/
├── models/          # Pydantic data models (Character, Map, Quest, Combat, Sandbox, Events, Presets)
├── engine/          # Deterministic rules (dice, combat_core, exploration, map_builder, quest_validation)
│   └── sandbox/     # The season: world build, tick, combat, perception, policy brain, runner
├── agents/          # smolagents setup (model factory)
│   └── sandbox/     # The LLM brain (CodeAgent) + Prompt-chan the commentator
├── prefabs/         # Hand-authored prefab dungeons (JSON) + startup seeder
├── api/             # world_routes (REST + SSE), mcp_server, world_guide, tts_routes
└── persistence/     # quest_store (prefab quests) + sandbox_store (worlds)

scripts/             # run_sandbox_season.py (headless), sandbox_byo_client.py (reference BYO client)
tests/               # 366 unit + integration tests
```

## API

### Season lifecycle

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/world/new` | Open a lobby (`seed`, `pool_size`, `num_sites`, `hosted_brain`, pacing, `require_invite`). Returns `host_key` **once** |
| `GET`  | `/world` | List worlds; envelope carries `can_create` + `operator_only` |
| `POST` | `/world/{id}/join` | Claim an agent — returns `agent_id` + token |
| `GET`  | `/world/{id}/invite` | Invite code for an unlisted world |
| `POST` | `/world/{id}/start` | 🔑 Start the season; hosted brains backfill the pool |
| `POST` | `/world/{id}/run` | 🔑 Auto-run at a tick cadence |
| `POST` | `/world/{id}/pause` | 🔑 Pause auto-run |
| `POST` | `/world/{id}/tick` | 🔑 Advance exactly one tick |
| `DELETE` | `/world/{id}` | 🔑 Destroy the season — runner, clock, and disk |

🔑 = host-gated; see [Host controls](#host-controls).

### Playing

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/world/{id}/agent/{aid}/observation` | Your view + exhaustive `valid_actions` |
| `POST` | `/world/{id}/agent/{aid}/action` | Submit one action (needs `X-Agent-Token`) |
| `POST` | `/world/{id}/agent/{aid}/ready` | Signal you're wired up (needs `X-Agent-Token`) |
| `GET`  | `/world/guide` | The BYO protocol briefing |

`ready` is a courtesy signal shown on the lobby roster. It starts nothing —
only the host begins a season, always.

### Spectating

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/world/{id}/stream` | SSE — ticks, combat, deaths, commentary |
| `GET`  | `/world/{id}/state` | Full season snapshot (roster, phase, tick) |
| `GET`  | `/world/{id}/events` | Event log |
| `GET`  | `/world/{id}/map` | Island overworld map |
| `GET`  | `/world/{id}/site/{site_id}/map` | Dungeon interior map |
| `POST` | `/tts` | Prompt-chan's voice (503 when unconfigured) |

MCP is mounted at `/mcp` in the same process, sharing the in-memory world
registry. It is **experimental** — the HTTP protocol above is the supported
path, and `GET /world/guide` says so to the agents that read it.

## Host controls

The clock belongs to whoever opened the season. `POST /world/new` mints a
`host_key` and returns it **once**, in that response; send it back as
`X-Host-Key` (or `?host_key=`) on the 🔑 routes above. `QUEST_SIM_ADMIN_KEY`
is the operator's skeleton key over every world.

`GET /world/{id}/state` answers `can_control` and `can_create` so a client
can render the right affordances instead of offering a button that 403s. It
never 403s itself — a stale key just means `can_control: false`, because a
spectator watching someone else's season must not be broken by a credential
they no longer need.

Three modes, set at deploy time:

| `HOST_KEY_ENFORCED` | `OPERATOR_ONLY` | Who can open a lobby | Who runs a season |
|---|---|---|---|
| `false` (default) | `false` | anyone | anyone |
| `true` | `false` | anyone | its host, or the operator |
| any | `true` | operator only | operator only — host keys go inert |

`DELETE` honours the key in **every** mode, including the dormant default:
no deployed client calls it, so there was nothing to regress by gating it
from the start.

Enforcement defaults **off** so a backend can deploy ahead of a frontend
that knows to send a key. Turn it on once clients carry one. With
`OPERATOR_ONLY` set and no admin key, the server **refuses to boot** rather
than run as an instance nobody can use.

Players are never gated by any of this: joining, readying, observing and
acting stay open (subject to a world's invite code) in all three modes.

## Configuration

All settings use the `QUEST_SIM_` env prefix. See [.env.example](.env.example).

| Variable | Default | Description |
|----------|---------|-------------|
| `QUEST_SIM_LLM_MODEL` | `deepseek/deepseek-chat` | LiteLLM model identifier for hosted brains |
| `QUEST_SIM_LLM_API_KEY` | — | API key for your LLM provider |
| `QUEST_SIM_LLM_API_BASE` | — | Custom API base URL (optional) |
| `QUEST_SIM_SANDBOX_POOL_SIZE` | `10` | Season-start roster size |
| `QUEST_SIM_SANDBOX_NUM_SITES` | `6` | POI dungeons (the central boss site is always +1) |
| `QUEST_SIM_SANDBOX_ACTION_DEADLINE_S` | `5.0` | Per-tick BYO action window |
| `QUEST_SIM_SANDBOX_TICK_SECONDS` | `2.0` | Auto-run pacing |
| `QUEST_SIM_SANDBOX_MAX_TICKS` | `300` | Season bell (timeout tiebreak) |
| `QUEST_SIM_SANDBOX_HOSTED_BRAIN` | `llm` | `llm` (product) or `policy` (token-free) |
| `QUEST_SIM_SANDBOX_DATA_DIR` | `data/worlds` | Where seasons are persisted |
| `QUEST_SIM_DATA_DIR` | `data/games` | Prefab quest root is derived from this |
| `QUEST_SIM_COMMENTATOR_MODEL` | — | Prompt-chan's model; unset silences her |
| `QUEST_SIM_ADMIN_KEY` | — | Operator's skeleton key over every world |
| `QUEST_SIM_SANDBOX_HOST_KEY_ENFORCED` | `false` | Arm the host gate on the clock routes |
| `QUEST_SIM_SANDBOX_OPERATOR_ONLY` | `false` | Only the operator may open or run a season |

⚠ `QUEST_SIM_ADMIN_KEY` is a **backend** variable. Never expose it to a
frontend build — bundlers inline build-time env vars into the JavaScript
they ship, which would publish the key that opens every world on the
server. quest-map takes it from the operator at runtime instead.

LiteLLM supports [many providers](https://docs.litellm.ai/docs/providers) — set
`QUEST_SIM_LLM_MODEL` to your provider's format (e.g.
`anthropic/claude-sonnet-4-20250514`, `ollama/llama3`).

## Tech Stack

- **Python 3.11+**
- **FastAPI** + **uvicorn** — async web framework
- **smolagents** — the agent framework; `CodeAgent` separates reasoning from action
- **LiteLLM** — smolagents' model backend, with Anthropic prompt-cache markers
- **fastmcp** — the native MCP tool surface
- **Pydantic v2** — data validation and serialization
- **sse-starlette** — Server-Sent Events for spectators

## Docs

- [docs/QUICKSTART.md](docs/QUICKSTART.md) — install → first season
- [docs/sandbox_demo.md](docs/sandbox_demo.md) — demo runbook and curated seeds
- [docs/SMOL.md](docs/SMOL.md) — smolagents primer
- [docs/near_settlement.md](docs/near_settlement.md) — seasons settled on the NEAR contract, and the arena

## License

MIT

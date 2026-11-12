# QuestFi on NEAR

Built at **NEAR HACKATHON** (November 2026).

QuestFi is a set of games that AI agents play while people watch and bet. This
repository is the NEAR version: an **agent pass** NFT that owns money, a
capped key that lets an AI agent spend from it, games that settle to it, and a
spectator market that pays the winning agent a cut.

> **Status, 2026-11-12: work in progress.** The start app's interface is built
> and runs, but it does not talk to a chain yet: its wallet, balances and
> earnings are scripted. The NEAR contract and the wiring are specified in
> [`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md) and not yet written. This section
> will be replaced with what actually runs before submission.

## What is in here

| Path | What | Origin |
|---|---|---|
| `apps/start` | Access card and Agent Management screen (Vite + three.js) | New, hackathon |
| `contracts/questfi` | The NEAR contract (Rust) | New, hackathon, **not yet written** |
| `apps/island` | Agent Island spectator app (React 19 + React Three Fiber) | Baseline, see below |
| `server/quest-sim` | Agent Island game engine and API (Python, FastAPI) | Baseline, see below |
| `docs/BUILD_SPEC.md` | Build spec for the NEAR work | New, hackathon |

## Run it

Start app (Node 22+):

```bash
cd apps/start
npm install
npm run dev        # http://localhost:5177
```

Click the card, then use the panels on the right to connect the (simulated)
wallet and link an agent. Drag the scene to turn the model.

Game server and island spectator: see section 2 of
[`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md).

## Baseline and hackathon work

This project builds on QuestFi code that existed before the hackathon. Per the
rules, only the NEAR integration built during the hackathon is to be judged.

- **Baseline** is the commit tagged [`pre-hackathon`]. It imports, unchanged:
  - `server/quest-sim` from `github.com/arkanine1000/quest-sim` at `beb90a2`
    (last commit 2026-08-20)
  - `apps/island` from `github.com/gptdnd/quest-map` at `d45b6f7`
    (last commit 2026-08-20)

  Neither contains any NEAR code.
- **Hackathon work** is everything after that tag. The final commit will be
  tagged `hackathon-submission`; the diff between the two tags is the
  submission.

### Reused pieces inside the hackathon work

`apps/start` was written during the hackathon. It reuses these from earlier
QuestFi projects:

- The hologram materials (`src/holo.js`) and the bloom + CRT post-processing
  pass (`src/post.js`), ported from the QuestFi lobby and Agent World apps.
- The graded-card "slab" markup and styles, ported from the QuestFi landing
  page.
- 3D models, the logo and card art under `apps/start/public/`, taken from the
  QuestFi lobby and landing page repositories.

### Libraries

- `apps/start`: three.js, Vite.
- `apps/island`: see its `package.json` (React, React Three Fiber, drei,
  postprocessing, vite-plugin-pwa).
- `server/quest-sim`: see its `requirements.txt` (FastAPI, uvicorn, Pydantic,
  smolagents, LiteLLM, fastmcp).

### AI assistance

Code in this repository was written with AI coding assistants (Claude Code).

## Licence

Source code: MIT, see [`LICENSE`](LICENSE). Art assets under `public/`
directories are not covered by it and keep their own licences.

[`pre-hackathon`]: ../../tree/pre-hackathon

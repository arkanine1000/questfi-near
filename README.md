# QuestFi on NEAR

QuestFi is a set of games that AI agents play while people watch and bet. This
repository is its NEAR version, built at **NEAR HACKATHON** (November 2026).
In **Agent Island** a season of AI agents loot dungeons, fight each other and
race for the boss. Each agent plays from an **agent pass**, an NFT that holds
NEAR: the agent stakes into a season from it, a kill pays the killer half of
the victim's stake, the winner takes the pot, and spectators bet on agents in
a parimutuel market that pays the winning pass a cut. It all settles on a
NEAR testnet contract.

## The problem

Agents are worth watching when they play for something, so they need money
they can spend on their own. Without a better tool an agent either holds a
wallet key that can spend everything, or waits for its owner to sign each
move. A bankroll in a wallet also carries no record, and cannot be handed on
with the agent. QuestFi puts the bankroll and the record in an NFT, and gives
the agent a key that can only stake from it, within limits the owner sets.

## Links

| What | Where |
|---|---|
| Site: the start app, Agent World at `/world/`, the island at `/island/` | https://near.questfi.ai |
| Contract `pass.questfi.testnet` on NEAR testnet | https://testnet.nearblocks.io/address/pass.questfi.testnet |
| Game server: the season open for entry | https://quest-sim-near-production.up.railway.app/near/arena |
| Every check, with its command and what it shows | [`docs/try-it.md`](docs/try-it.md) |
| Contract interface, trust model, known limits | [`contracts/README.md`](contracts/README.md) |
| How the game server settles on NEAR | [`server/quest-sim/docs/near_settlement.md`](server/quest-sim/docs/near_settlement.md) |

## What runs on NEAR, and why

- **The pass is an NFT that holds a balance.** Passes are NEP-171 tokens (with
  NEP-177 metadata and NEP-181 enumeration). The contract holds each pass's
  NEAR and its record: level, seasons, wins, kills and an activity log.
  `nft_transfer` moves all of it and clears the agent link, so an agent's
  bankroll and record change hands together.
- **The agent's key cannot withdraw.** Linking an agent adds a function-call
  access key to the owner's account, valid only for this contract's
  `enter_season` and `pay_agent`. NEAR refuses any other method and any
  attached deposit from that key, and every owner method that moves money out
  of a pass requires 1 yoctoNEAR attached. In the two agent methods the
  contract applies the pass's per-call cap and daily limit. So the agent can
  play unattended and still cannot take the money out.
- **Seasons and the market settle on the contract.** The game server, a
  registered operator, opens each season and reports its kills and winner;
  the contract moves the stakes, the pot and the bets. The money never sits
  with the game server.
- **A visitor needs no wallet.** `/api/guest` creates a testnet account
  (`g-<random>.play.questfi.testnet`, 0.5 NEAR) for a public key the browser
  made. The private key stays in the browser's storage, which the three apps
  share because one origin serves them.

## The deployed contract

| | |
|---|---|
| Account | `pass.questfi.testnet`: owner `questfi.testnet`, treasury `treasury.questfi.testnet`, operator `operator.questfi.testnet` |
| Code hash | `93fJ8Fv1HLottZXcAjsjkAj1Ty8ZrCKYH77biVJJ1hW4`, the base58 form of the wasm's SHA-256 `778bf52679a4c840a757b6d55057767bf2da49332b2588208b39d826ea59a565` |
| Built by | CI run [`43302333944`](https://github.com/arkanine1000/questfi-near/actions/runs/43302333944) (workflow `contract-build`): unit tests, a reproducible build in Docker, sandbox tests on that wasm |
| From commit | [`1b1c088d08ee48ad756f95a07ed0da1f7dbf2ceb`](https://github.com/arkanine1000/questfi-near/tree/1b1c088d08ee48ad756f95a07ed0da1f7dbf2ceb) |
| Deployed in | [`EtQMXMdJwQDxVi4JD4jYqZWn1SEFAkpPUykTMCQ2Emxz`](https://testnet.nearblocks.io/txns/EtQMXMdJwQDxVi4JD4jYqZWn1SEFAkpPUykTMCQ2Emxz) |

`scripts/check-public.sh` (bash, curl, jq) checks all three: it reads the
code hash and the deployed wasm's SHA-256 over NEAR's public RPC, and the
`contract_source_metadata` view (NEP-330), which names the commit and the
build image. The CI run's summary lists the same SHA-256 and code hash.

Amounts are small to fit the testnet faucet (in NEAR: stake 0.05, rentals
0.04 and 0.06, caps 0.2 per call and 1 per day, card burn 0.2, mint fee 0.05,
minimum bet 0.01); `get_config` reads them back. The contract account keeps
its full-access key, so a fix can be deployed during the event.

## Try it

**In a browser, about five minutes** ([`docs/try-it.md`](docs/try-it.md) says
what appears at each step):

1. Open https://near.questfi.ai and click the card. The panels open.
2. Press **PLAY WITH A TEST ACCOUNT**. An account with 0.5 testnet NEAR is made; no wallet, no popup.
3. Press **MINT AGENT PASS**. A pass is minted with 0.2 NEAR inside.
4. Open **AGENT LINK** and click a house agent. It is linked and its key added.
5. Open **SPENDING POLICY**, press **TEST THE LIMITS**. The agent's key tries a
   spend over the cap (**REFUSED BY THE CONTRACT**) and a withdrawal
   (**REFUSED BY NEAR ITSELF**).
6. Press **DEPLOY TO AGENT WORLD**. The agent's key, not the owner's, signs the
   season entry, and the agent takes a seat.
7. Press **ENTER AGENT WORLD** and enter the **AGENT ISLAND** venue. Start the
   season or wait out its countdown.
8. Follow an agent and back it from the **MARKET** dock on the right; once the
   season settles, press **CLAIM** under **YOUR BETS**.

**From a terminal, one command** after the install (Node 22):

1. `git clone https://github.com/arkanine1000/questfi-near && cd questfi-near/apps/start && npm ci`
2. `node scripts/walkthrough.mjs --contract pass.questfi.testnet --app https://near.questfi.ai --game https://quest-sim-near-production.up.railway.app`
3. A fresh test account runs the whole flow: twelve numbered `ok` lines and
   `all steps passed` once a season has played and settled, a few minutes;
   exit code 0, or 1 if a step fails.

## How it works

| Part | Path | What it does |
|---|---|---|
| Contract | `contracts/questfi` | Rust, near-sdk 5.30. Passes with balances, records and caps; agent links; seasons; the market. 46 unit tests, and 3 sandbox tests that CI runs on the wasm it builds. |
| Start app | `apps/start` | Vite, three.js. The pass card, test accounts, minting, agent links, the limits test, and the deploy that enters a season with the agent's key. |
| Game server | `server/quest-sim` | Python, FastAPI. The Agent Island engine and the contract's operator: it keeps a season open on chain, seats an agent for each pass that entered, reports kills every tick through a queue, tops up a house pass that has run dry, and settles. 373 tests. |
| Island | `apps/island` | React, React Three Fiber. The spectator view and the contract's parimutuel market: `get_market`, `place_bet`, `claim_winnings`. |

Agent World (`apps/world`), a globe and a city, is the hub between the start
app and the island. One Vercel project builds the three apps into one site
(`apps/start/scripts/build-site.mjs`); the game server runs on Railway.

## Trust model and limits

- **The game server is a trusted reporter.** The contract checks who may
  report, the money maths and the caps, not that a kill or a win happened.
  The contract's own known limits and their planned fixes are in
  [`contracts/README.md`](contracts/README.md#known-limits).
- Everything runs on NEAR testnet.
- Implemented but not run with a real wallet: connecting a NEAR wallet
  (near-connect) and **MOVE PASS TO MY WALLET**. Linking your own agent over
  MCP is implemented on the game server but not run end to end from the start
  app.
- The card claim at level 5 is covered by contract tests; no pass on the site
  has reached level 5. `pay_agent` is what the limits test calls; agents do
  not pay each other during play.
- The city's other venues (the Colosseum, the Green Room, Speed Traders) open
  the existing hosted QuestFi lobby and do not use NEAR.

## Baseline and what is new

The tag [`pre-hackathon`](https://github.com/arkanine1000/questfi-near/tree/pre-hackathon)
(commit `0ef346c`) imports, unchanged, `server/quest-sim` from the repository
`arkanine1000/quest-sim` at `beb90a2` and `apps/island` from `gptdnd/quest-map`
at `d45b6f7`, both last changed on 2026-08-20. Both repositories are private.
Neither had any NEAR code. `apps/world` was written from 2026-10-27 to
2026-10-30, inside the event's window but before the decision to enter, and
had no NEAR code when it was imported (commit `7d3e10d` of its repository);
since then it has gained the Agent Island venue.

Everything else is new: the contract, the start app, the settlement and arena
code in the game server, the on-chain market in the island, the island's
interface and 3D look (rebuilt to match the start app and Agent World; its
game logic, map, models and sprites are the baseline's), the scripts and the
CI workflow. The final commit is tagged `hackathon-submission`; the whole
change (305 files) is
https://github.com/arkanine1000/questfi-near/compare/pre-hackathon...hackathon-submission.

## Reused pieces

- From earlier QuestFi apps: the hologram materials (`apps/start/src/holo.js`)
  and bloom and CRT pass (`post.js`) from the lobby and Agent World, the card
  "slab" from the landing page, and the models and art in `apps/start/public/`.
- The island's `Scene3D/holo.js` and `HouseFx.jsx` are ports of those
  hologram materials and that bloom and CRT pass.
- From the island's baseline: the spectator logic, the map, the dungeon
  view's models, sprites and textures, and the commentator's art. Its market
  ran on simulated chips and now uses the contract; the simulation remains as
  the fallback when no contract is configured. Agent World's city, characters
  and vehicles are licensed assets.
- The CI workflow follows the one the team wrote for its other entry.

## Libraries

- Contract: near-sdk and near-contract-standards 5.30, near-workspaces 0.24,
  cargo-near 0.23.0.
- Start app: near-api-js 7.4.0, @hot-labs/near-connect 0.12.0, three.js, Vite.
  Agent World: three.js, Vite.
- Island: React 19, React Three Fiber, drei, postprocessing, near-api-js 7.4.0,
  Vite (`apps/island/package.json`).
- Game server: FastAPI, uvicorn, Pydantic, sse-starlette, smolagents, LiteLLM,
  fastmcp; httpx and cryptography for NEAR RPC and ed25519 signing
  (`server/quest-sim/requirements.txt`).

Code in this repository was written with AI coding assistants (Claude Code).

## The team's other entry

ATNX: https://github.com/arkanine1000/atnx-near

## Licence

Source code: MIT, see [`LICENSE`](LICENSE). Art assets under `public/`
directories are not covered by it and keep their own licences.

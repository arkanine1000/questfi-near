# QuestFi on NEAR: build spec

Handoff document for whoever builds the NEAR side on the Linux machine.
Written 2026-11-12. Read sections 1 to 4 before writing any code.

**Deadline: development ends 2026-11-14 23:59 UTC.** Results by 2026-11-18.

---

## 1. What we are submitting

QuestFi is a set of games that AI agents play while people watch and bet.
For NEAR HACKATHON the pitch is one mechanic:

> An **agent pass** is an NFT that owns money. You link an AI agent to it,
> give that agent a capped key, and send it out to play. Whatever the agent
> stakes, loses, loots or wins moves in and out of the pass. Spectators bet
> on agents, and the winning agent's pass takes a cut. At level 5 the pass
> can be burned against for a physical trading card.

The user flow, start to finish:

1. **Start app** (`apps/start`): a 3D access card. Click it to open Agent
   Management: connect a NEAR wallet, mint or load a pass, link an agent
   (rent a house agent or bring your own over MCP), set spending caps.
2. **Deploy**: the agent gets a function-call access key scoped to the game
   methods, and stakes into a season from the pass balance.
3. **Agent World** (`apps/world`): the globe and city hub. Games are venues
   in the city.
4. **Agent Island** (`apps/island` + `server/quest-sim`): the one game wired
   end to end. Agents loot dungeons and kill each other; kills and the season
   result settle on chain; the spectator market takes real NEAR bets.
5. Back in the start app, the pass balance, level and activity update from
   chain. At level 5 the owner claims the physical card.

Poker, racing and the colosseum appear as venues in the city but are **not**
wired to NEAR. They are shown as "next".

### What is judged

Only the NEAR integration built in the hackathon window counts
(rule Q-002/Q-004). The games existed before. So the scored work is:

- the contract (section 4)
- the start app talking to it (section 7)
- the game server settling to it (section 8)
- the spectator market using it (section 9)

An AI pass (Claude Code and Codex) screens every repo first for "runs, and
does what the README says". A small thing that works beats a large thing that
half works. **Do not describe anything in the README that is not running.**

### Tracks we will tick

| Track | Earned by |
|---|---|
| Games With Real Economies | Agents with wallets, loot and stakes on chain, a player market |
| NFTs That Do Something | The pass owns a balance, carries a record, gates a physical claim |
| AI Security & Defense | Function-call key scoped to game methods, plus per-call and daily caps enforced in the contract |
| Agent Economy | Agents stake, earn, pay rental, and (P2) pay each other |
| Open Innovation | Catch-all |

AI Swarms only if `pay_agent` (P2) lands and agents actually use it.

---

## 2. Current state of the repo

```
questfi_near/
  apps/start/        NEW. Vite + three.js. A working UI with NO chain calls.
  apps/world/        Agent World: globe and city hub. Vite + three.js. Written
                     2026-10-27..30, imported at 7d3e10d, plus an Island venue.
  apps/island/       BASELINE. quest-map @ d45b6f7. React 19 + R3F spectator.
  server/quest-sim/  BASELINE. quest-sim @ beb90a2. Python FastAPI game engine.
  contracts/         does not exist yet (you create it)
  docs/BUILD_SPEC.md this file
```

- Tag `pre-hackathon` marks the baseline import. Everything after it is
  hackathon work. Keep it that way: **never edit history before that tag.**
- `apps/start` is a flow mockup. Every value in it is scripted in
  `apps/start/src/config.js`. Section 7 maps each fake to its real call.
- `apps/world` is the hub and already lists Agent Island as a venue. The 3D
  lobby (poker, racing, colosseum) is on the Windows machine and not imported.
  See section 10.

### Run what exists

```bash
# start app
cd apps/start && npm install && npm run dev        # http://localhost:5177

# game server (Python 3.11+)
cd server/quest-sim && python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                               # add an LLM key, or use the policy brain
uvicorn quest_sim.main:app --port 8000             # same entry point as the Procfile

# island spectator
cd apps/island && npm install && npm run dev       # http://localhost:5173, proxies /api -> 127.0.0.1:8000

# agent world
cd apps/world && npm install && npm run dev        # http://localhost:5175
```

The game server's real docs are `server/quest-sim/docs/sandbox_demo.md`,
`docs/INTEGRATION_GUIDE.md` and `docs/HANDOFF-2026-07-16.md`. Its README only
covers a legacy solo mode. A zero-LLM "policy" brain exists
(`QUEST_SIM_SANDBOX_HOSTED_BRAIN=policy`) and is the right choice for
development and for the recorded demo, since it is deterministic with a seed.

---

## 3. Toolchain

Checked against docs.near.org, crates.io and npm on 2026-11-12. Items marked
**(unverified)** could not be confirmed from the docs and must be checked with
`--help` or the source before relying on them.

### Versions

| Thing | Version | Note |
|---|---|---|
| near-sdk | 5.30.1 | MSRV is Rust 1.95.0 |
| near-contract-standards | 5.30.1 | NEP-171 helpers |
| near-workspaces | 0.24.0 | Current docs use `near-sandbox` + `near-api` for integration tests instead; either is fine, pick whichever works first |
| @hot-labs/near-connect | 0.12.0 | Wallet connection. **`@near-wallet-selector/*` is deprecated; do not use it** |
| near-api-js | 7.5.3 | Needs Node >= 22.22.2 |

Pin Rust with a `rust-toolchain.toml` at 1.95 in `contracts/questfi`. The docs
do not pin one; this is our choice, to keep builds repeatable.

### Install (Linux)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.sh | sh
```

### Build

```bash
cd contracts && cargo near new questfi        # scaffold
cd questfi && cargo near build non-reproducible-wasm
# output: target/near/questfi.wasm
```

### CLI

```bash
# account, funded by the faucet
near create-account <name>.testnet --useFaucet --networkId testnet

# deploy with init
near contract deploy <contract>.testnet use-file ./target/near/questfi.wasm \
  with-init-call new json-args '{"owner_id":"<owner>.testnet"}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send

# change call / view
near call <contract> <method> '<json>' --deposit 0.1 --useAccount <acct> --networkId testnet
near view <contract> <method> '<json>' --networkId testnet

# function-call access key (unverified syntax; check `near account add-key --help`)
near account add-key <acct> grant-function-call-access --allowance '0.25 NEAR' \
  --contract-account-id <contract> --function-names 'enter_season, pay_agent' \
  autogenerate-new-keypair save-to-keychain network-config testnet sign-with-keychain send
```

### Network

- RPC: `https://test.rpc.fastnear.com` (alternatives: `https://near-testnet.drpc.org`)
- Explorer: `https://testnet.nearblocks.io` (the account and transaction URL
  patterns are **unverified**; open one and copy the pattern)
- **Testnet only.** The rules accept testnet for every track. The only mainnet
  item is the payout address on the submission form.

### Contract conventions (near-sdk 5.x)

- `#[near(contract_state)]` on the struct with `#[derive(PanicOnDefault)]`,
  `#[near]` on impl blocks, `#[init]`, `#[payable]`, `#[private]`.
- Amounts cross the JSON boundary as `U128` (a base-10 string of yoctoNEAR).
  `NearToken`'s JSON form is **unverified**, so use `U128` in every public
  signature and convert inside.
- NEP-171: no derive macro. Each trait (`NonFungibleTokenCore`, `Resolver`,
  `Enumeration`, `MetadataProvider`) gets its own `#[near] impl` that delegates
  to a `NonFungibleToken` field. Copy the shape from
  `near-sdk-rs/examples/non-fungible-token/nft/src/lib.rs`.
- Events: NEP-297. One log line per event, `EVENT_JSON:` followed by
  `{"standard":"questfi","version":"1.0.0","event":"<name>","data":[{...}]}`.
- Set `overflow-checks = true` in the release profile.

---

## 4. The contract

One contract. Working name `questfi`. Suggested account
`questfi-hack.testnet` (any free name; record it in section 6).

### 4.1 The idea that everything hangs on

**A function-call access key cannot attach a NEAR deposit.** This is stated on
the docs' access-keys page. Its allowance only pays gas, and it can only call
the listed methods on the listed contract.

So an agent can never move NEAR out of its owner's wallet. All agent spending
must come from money already inside the contract. That is the design:

- The owner deposits NEAR into the **pass balance** (held by the contract).
- The agent's key can call only the agent methods. Those methods spend from
  the pass balance, and the contract applies the owner's caps to them.
- `withdraw` is not in the key's method list, so the protocol itself stops the
  agent from taking money out. The caps stop it from staking it all.

Two independent limits, then: the protocol limits *which methods*, the
contract limits *how much*.

### 4.2 Constants

Make these fields of a `Config` struct set in `new`, not literals, so the demo
can be tuned without a redeploy of logic.

| Name | Default | Meaning |
|---|---|---|
| `mint_storage_fee` | 0.05 NEAR | Charged on `mint_pass`, covers the pass's storage |
| `min_bet` | 0.01 NEAR | Smallest bet; also covers the bet's storage |
| `xp_per_level` | 300 | `level = 1 + xp / xp_per_level` |
| `xp_enter` | 20 | Awarded on entering a season |
| `xp_kill` | 120 | Awarded to the killer |
| `xp_win` | 200 | Awarded to the season winner |
| `xp_loot_max` | 200 | Cap on XP an operator may grant in one loot event |
| `kill_bounty_bps` | 5000 | Share of the victim's stake paid to the killer at once |
| `market_agent_cut_bps` | 500 | Share of the losing bets paid to the winning agent's pass |
| `market_house_bps` | 200 | Share of the losing bets paid to the treasury |
| `claim_level` | 5 | Level needed to claim the physical card |
| `claim_burn` | 2 NEAR | Burned from the pass balance on claim |
| `max_entrants` | 16 | Per season |
| `max_events_per_call` | 20 | For `report_events` |
| `activity_cap` | 40 | Activity entries kept per pass |

### 4.3 State

```
Contract
  owner_id: AccountId
  treasury_id: AccountId                 // receives rental fees and house cut
  operators: set<AccountId>              // game servers allowed to run seasons
  config: Config
  tokens: NonFungibleToken               // NEP-171, token_id = "1", "2", ...
  metadata: NFTContractMetadata
  next_pass_id: u64
  passes: map<TokenId, Pass>
  seasons: map<SeasonId, Season>
  bets: map<(SeasonId, AccountId), map<TokenId, u128>>
  roster: map<String, RosterAgent>       // house agents for rent
  burned_total: u128                     // NEAR locked for ever by card claims

Pass
  balance: u128                          // yoctoNEAR held for this pass
  total_in: u128                         // every credit from play and market
  total_out: u128                        // every debit from play
  market_cut: u128
  xp: u32
  seasons: u32, wins: u32, kills: u32
  agent: Option<AgentLink>
  policy: Policy
  active_season: Option<SeasonId>
  claim_ticket: Option<String>
  activity: bounded list<Activity>       // newest first, capped

AgentLink { kind: Rented | Byo, name: String, roster_id: Option<String>, public_key: Option<PublicKey> }
Policy    { per_call_cap: u128, daily_limit: u128, spent_today: u128, day: u64 }
Activity  { kind: String, text: String, amount: i128-as-two-fields, timestamp_ms: u64 }
RosterAgent { name: String, blurb: String, price: u128 }   // price per season

Season
  status: Open | Running | Settled | Cancelled
  entry_stake: u128
  entrants: map<TokenId, Entrant>        // Entrant { at_risk: u128, alive: bool }
  pot: u128
  market_open: bool
  bet_totals: map<TokenId, u128>
  bet_pool: u128
  winner: Option<TokenId>
  payout_per_unit: stored at settle so claims are O(1)   // see 4.6
```

Signed amounts: avoid `i128` in JSON. Represent a signed activity amount as
`amount: U128` plus `negative: bool`.

`day` is `block_timestamp / 86_400_000_000_000`. When a spend arrives on a new
day, reset `spent_today` to 0 first.

### 4.4 Methods

**Caller** column: O = pass owner, A = agent key or owner, Op = operator,
Any = anyone, Adm = contract owner.

#### Pass and money

| Method | Caller | Deposit | Behaviour |
|---|---|---|---|
| `new(owner_id, treasury_id)` | init | 0 | Sets config defaults, NFT metadata (`name: "QuestFi Agent Pass"`, `symbol: "QFPASS"`). |
| `mint_pass()` → `TokenId` | Any | ≥ `mint_storage_fee` | Mints the next pass to the caller. Anything above the fee is credited to the pass balance. Default policy: `per_call_cap` 2 NEAR, `daily_limit` 10 NEAR. |
| `deposit(pass_id)` | Any | > 0 | Credits the pass balance. Anyone may fund any pass. |
| `withdraw(pass_id, amount)` | O | 1 yocto | Debits the balance, transfers to the owner. The 1 yocto forces a full-access signature, so no function-call key can ever reach it. |
| `set_policy(pass_id, per_call_cap, daily_limit)` | O | 1 yocto | Replaces the caps. Does not reset `spent_today`. |
| `claim_card(pass_id)` → `String` | O | 1 yocto | Requires level ≥ `claim_level`, no existing ticket, balance ≥ `claim_burn`. Debits the balance, adds to `burned_total`, sets `claim_ticket` to `QF-TCG-<pass_id>-<block_height>`, updates the token's metadata `extra`, emits `card_claimed`. |

#### Agent link

| Method | Caller | Deposit | Behaviour |
|---|---|---|---|
| `link_agent(pass_id, kind, name, roster_id, public_key)` | O | rental price if `Rented`, else 1 yocto | Stores the link and the agent's public key. For `Rented`, `roster_id` must exist and the attached deposit must cover its `price`; forward the price to the treasury. Refuse while `active_season` is set. |
| `unlink_agent(pass_id)` | O | 1 yocto | Clears the link and key. Refuse while `active_season` is set. |
| `set_roster(roster_id, name, blurb, price)` | Adm | 0 | Adds or edits a house agent. |

The contract only *records* the public key. Adding and deleting the key on the
owner's NEAR account is a separate `AddKey` / `DeleteKey` transaction the
frontend sends (section 7.3).

#### Agent methods (the only ones in the function-call key's list)

| Method | Caller | Behaviour |
|---|---|---|
| `enter_season(pass_id, season_id)` | A | Season must be `Open`, pass not already in a season, entrants < max. Spends `entry_stake` from the pass balance into the pot under the policy (4.5). Sets `active_season`, awards `xp_enter`, increments `seasons`. |
| `pay_agent(from_pass, to_pass, amount, memo)` **(P2)** | A | Moves balance between two passes under the policy. For agents hiring or tipping each other. |

Authorisation for agent methods:

1. `predecessor_account_id` must be the pass owner. (A function-call key lives
   on the owner's account, so calls signed with it arrive from the owner.)
2. If `env::signer_account_pk()` equals the pass's recorded agent key, the
   policy applies.
3. If it is any other key of the owner (their own wallet), the call is the
   owner acting directly. **Still apply the policy.** One rule is easier to
   reason about and to demo than two.

#### Seasons (operator)

| Method | Caller | Behaviour |
|---|---|---|
| `add_operator(account_id)` / `remove_operator` | Adm | |
| `create_season(season_id, entry_stake)` | Op | Status `Open`, `market_open: true`. `season_id` is the game server's world id, ≤ 64 chars. |
| `start_season(season_id)` | Op | `Open` → `Running`. No more entrants. |
| `lock_market(season_id)` | Op | `market_open: false`. The server calls this at a fixed tick so nobody bets on a decided game. |
| `report_events(season_id, events)` | Op | Up to `max_events_per_call`. Each event is one of the two below. |
| `settle_season(season_id, winner_pass)` | Op | See 4.6. `winner_pass` may be null (everyone died). |
| `cancel_season(season_id)` | Op | Refunds every entrant's remaining `at_risk` to their pass and marks all bets refundable in full. For server crashes. |

`report_events` event shapes:

- `{"kind":"kill","killer":"<pass_id>","victim":"<pass_id>"}`. The victim must
  be alive. `bounty = victim.at_risk * kill_bounty_bps / 10000`. Credit
  `bounty` to the killer's pass, debit the pot and the victim's `at_risk` by
  it, mark the victim dead, `kills += 1` and `xp += xp_kill` on the killer.
  A kill by a monster has `killer: null`: mark dead, no bounty.
- `{"kind":"loot","pass":"<pass_id>","xp":<u32>,"text":"<=80 chars"}`. Adds
  `min(xp, xp_loot_max)` and an activity entry. No money moves.

Every event appends an `Activity` to the passes involved and emits an event
log.

#### Market

| Method | Caller | Deposit | Behaviour |
|---|---|---|---|
| `place_bet(season_id, pass_id)` | Any | ≥ `min_bet` | Market must be open and the pass an entrant. Adds to the bettor's stake on that pass, `bet_totals`, `bet_pool`. |
| `claim_winnings(season_id)` | Any | 0 | After settle or cancel. Pays the caller's share (4.6), then deletes their bet record so it cannot be claimed twice. |

#### Views

| Method | Returns |
|---|---|
| `get_config()` | `Config` |
| `get_pass(pass_id)` | `PassView` (below) or null |
| `get_activity(pass_id, from_index, limit)` | `Activity[]`, newest first |
| `get_roster()` | `[{roster_id, name, blurb, price}]` |
| `get_season(season_id)` | status, stake, pot, winner, entrants `[{pass_id, name, at_risk, alive}]` |
| `get_market(season_id)` | `{open, pool, totals: [{pass_id, amount}], settled, winner}` |
| `get_bets(season_id, account_id)` | `[{pass_id, amount}]` plus `claimable` once settled |
| NEP-171 views | `nft_token`, `nft_tokens_for_owner`, `nft_supply_for_owner`, `nft_metadata`, ... |

`PassView`, exactly, because the frontend binds to it:

```json
{
  "token_id": "42",
  "owner_id": "pilot.testnet",
  "balance": "3200000000000000000000000",
  "total_in": "9400000000000000000000000",
  "total_out": "2000000000000000000000000",
  "market_cut": "900000000000000000000000",
  "xp": 120,
  "level": 4,
  "xp_per_level": 300,
  "seasons": 11, "wins": 2, "kills": 17,
  "agent": { "kind": "rented", "name": "MIMIR", "roster_id": "mimir", "public_key": "ed25519:..." },
  "policy": { "per_call_cap": "2000000000000000000000000", "daily_limit": "10000000000000000000000000", "spent_today": "500000000000000000000000" },
  "active_season": "wld_ab12",
  "claim_ticket": null
}
```

`agent` is `null` when nothing is linked. Lifetime profit shown in the UI is
`total_in - total_out`, computed client-side.

### 4.5 Policy enforcement

One internal function, used by every agent method that spends:

```
fn spend(pass, amount):
    roll the day forward if needed (reset spent_today)
    require amount <= pass.policy.per_call_cap        -> "POLICY: over per-call cap"
    require spent_today + amount <= daily_limit       -> "POLICY: over daily limit"
    require amount <= pass.balance                    -> "insufficient pass balance"
    pass.balance -= amount; pass.total_out += amount; spent_today += amount
```

Panic messages must start with `POLICY:` for the two cap failures. The
frontend matches on that prefix to show the refusal (section 7.5).

### 4.6 Settlement maths

Stakes. Entry stake `S`, `n` entrants, pot starts at `n * S`. Each kill pays
half the victim's stake to the killer straight away; the rest stays in the
pot. At settle the winner's pass is credited whatever is left in the pot,
plus `wins += 1` and `xp += xp_win`. If `winner_pass` is null the pot goes to
the treasury.

Market. Let `P` be the whole bet pool, `W` the bets on the winner,
`L = P - W` the losing bets.

```
agent_cut = L * market_agent_cut_bps / 10000    -> winner's pass balance and market_cut
house_cut = L * market_house_bps / 10000        -> treasury
distributable = P - agent_cut - house_cut
payout(bettor) = bettor_stake_on_winner * distributable / W      (floor)
```

- If `W == 0` (nobody backed the winner) or there is no winner: no cuts, every
  bet is refundable in full.
- Rounding dust stays in the contract.
- Store `distributable` and `W` on the season at settle; `claim_winnings`
  computes the caller's payout from those and their own stake.

Worked example: 4 entrants at 0.5 NEAR, pot 2.0. Two kills by A pay A
0.25 + 0.25 immediately; pot is now 1.5. A wins: A's pass gets 1.5 more.
Bets: 3.0 on A, 1.0 on B, 1.0 on C, so `P = 5`, `W = 3`, `L = 2`.
`agent_cut = 0.1`, `house_cut = 0.04`, `distributable = 4.86`. A bettor with
1.5 on A is paid `1.5 * 4.86 / 3 = 2.43`.

### 4.7 Transfers of the pass

`nft_transfer` and `nft_transfer_call` must, after delegating to the standard
implementation, clear the pass's `agent` link. The balance and record travel
with the token: that is the "NFT as an account" claim. A pass in a running
season may be transferred; its stake is already in the pot and any winnings go
to the pass, so to the new owner.

### 4.8 Events

`pass_minted`, `deposit`, `withdraw`, `policy_set`, `agent_linked`,
`agent_unlinked`, `season_created`, `season_entered`, `season_started`,
`kill`, `loot`, `season_settled`, `season_cancelled`, `bet_placed`,
`winnings_claimed`, `card_claimed`, `agent_payment`. Standard `questfi`,
version `1.0.0`. Include `pass_id`, `season_id`, `account_id` and `amount`
where they apply.

### 4.9 Checklist before deploy

- Every state change happens **before** the `Promise` that sends NEAR.
- Every method that moves money out to an account, or changes who can spend,
  requires 1 yocto (`assert_one_yocto`).
- `report_events`, `settle_season`, `start_season`, `lock_market`,
  `create_season`, `cancel_season` reject non-operators.
- A season cannot be settled twice. A victim cannot be killed twice. A bet
  cannot be claimed twice.
- `enter_season` cannot be called for a pass the caller does not own.
- Nothing can withdraw `burned_total`.

### 4.10 What the contract does not do

Say this in the README. **The game server is a trusted reporter.** The
contract does not verify that a kill or a win really happened in the game. It
enforces who may report, the money maths, and the agent's limits.

---

## 5. Tests

Unit tests (`cargo test`, `testing_env!` with `VMContextBuilder`):

1. Mint: fee charged, surplus credited, ids increase, owner recorded.
2. Deposit and withdraw: balance moves; non-owner withdraw panics; withdraw
   without 1 yocto panics.
3. Policy: a spend over `per_call_cap` panics with `POLICY:`; spends adding up
   past `daily_limit` panic; advancing the block timestamp a day resets it.
4. Season happy path: create, three passes enter, start, kill, settle. Check
   every balance against section 4.6 by hand.
5. Market: the worked example in 4.6, to the yocto. Then `W == 0` refunds.
6. Double actions: settle twice, kill a dead pass, claim twice, enter twice.
7. Operator gating on every operator method.
8. Claim: below level 5 panics; at level 5 burns, issues a ticket, cannot
   repeat.
9. Transfer clears the agent link and keeps the balance.

One integration test on the sandbox: deploy, mint, add a real function-call
key limited to `enter_season`, and show that a call to `withdraw` signed with
that key is **rejected by the protocol**, while `enter_season` succeeds. This
is the single most valuable test for the AI Security track; keep its output
for the README.

---

## 6. Deploy and seed

Fill these in as they are created, and commit the file.

| Role | Account |
|---|---|
| Contract | `________.testnet` |
| Owner / treasury | `________.testnet` |
| Operator (game server) | `________.testnet` |
| Demo player | `________.testnet` |

Write `scripts/seed.sh` that, on a fresh deploy:

1. Adds the operator.
2. Calls `set_roster` for the four house agents, with the names, blurbs and
   prices from `apps/start/src/config.js` (`ROSTER`): mimir and cassandra at
   0.4 NEAR, roko and aegis at 0.6.
3. Mints **house passes** from the operator account, one per agent the game
   server will field in a season (default pool size is 10), and funds each
   with enough for several entry stakes. Every entrant in a season needs a
   pass, or kills cannot settle. Save the `agent name -> pass_id` map to
   `server/quest-sim/near_passes.json`.

Never commit a private key. Operator credentials go in
`server/quest-sim/.env` (git-ignored) or the CLI keychain.

---

## 7. Wiring the start app

All of `apps/start` is plain ES modules with three.js; no framework. The
scripted state lives in `src/config.js` and the `state` object at the top of
`src/main.js`. `render()` redraws everything from `state`, so the job is to
fill `state` from chain and replace each simulated action.

Add `src/near.js` to hold every chain call, so `main.js` stays about the UI.

### 7.1 Libraries

```bash
npm i @hot-labs/near-connect near-api-js
```

```js
import { NearConnector } from '@hot-labs/near-connect';
import { JsonRpcProvider } from 'near-api-js';

const connector = new NearConnector({ network: 'testnet' });
connector.on('wallet:signIn', ...); connector.on('wallet:signOut', ...);
const wallet = await connector.wallet();

await wallet.signAndSendTransaction({
  receiverId: CONTRACT,
  actions: [{ type: 'FunctionCall', params: { methodName, args, gas: '30000000000000', deposit: '0' } }],
});

const rpc = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
await rpc.callFunction({ contractId: CONTRACT, method: 'get_pass', args: { pass_id } });
```

Vite will probably need `vite-plugin-node-polyfills` for `Buffer`
**(unverified; add it when the first error says so)**.

Put the contract id and RPC URL in `apps/start/.env` as `VITE_CONTRACT_ID` and
`VITE_RPC_URL`, with an `.env.example` committed.

### 7.2 Mock to real

| In `main.js` now | Becomes |
|---|---|
| `toggleWallet()` waits 800 ms and sets `state.wallet = WALLET` | `connector.connect()`; on sign-in set `state.wallet = { account, near }` from the account's real balance |
| `state.pass = { ...PASS }` | After sign-in: `nft_tokens_for_owner`. If none, show a **MINT PASS** button in place of the deploy button and call `mint_pass` with 0.05 NEAR + an optional first deposit. Then `get_pass` |
| Pass fields (`level`, `xp`, `balance`, `seasons`, `wins`, `kills`, `marketCut`) | Mapped from `PassView`. Amounts arrive as yocto strings; convert once, in `near.js` |
| `ROSTER` from config | `get_roster()`, keeping `model` and `tint` in config keyed by `roster_id` |
| `linkAgent()` sets `state.agent` | Section 7.3 |
| Policy sliders write `state.policy` | `set_policy` on release of the slider (not on every drag), 1 yocto |
| `deploy()` prints `DEPLOY_LOG` lines on a timer | Section 7.4. Each log line is a real step and gets its `ok` when the transaction confirms; print the transaction hash as a link |
| `FIELD_EVENTS` on a 2.6 s timer, `applyField()` | Poll `get_pass` and `get_activity` every 3 s while `active_season` is set. Diff against the last result; new activity rows go through the existing `pushLog()` |
| Deposit / Withdraw buttons show a toast | `deposit(pass_id)` with an amount prompt; `withdraw(pass_id, amount)` with 1 yocto |
| `confirmClaim()` sets `state.claimed` | `claim_card`, then show the returned ticket in the existing modal |
| `recall()` | `unlink_agent` + a `DeleteKey` transaction for the agent key. Only allowed when `active_season` is null |
| `TIERS` labels (PASS, TITLE, SKIN, BOOST) | Placeholders. Leave the track; only level 5 is real |

The card texture (`redrawCard()`) and the level track (`renderTrack()`)
already read from `state.pass`, so they follow automatically.

Remove nothing from the UI. Where a real call is not ready, leave the scripted
path behind a `MOCK` flag (`?mock=1`) so the demo can still be recorded.

### 7.3 Linking an agent and its key

1. Generate an ed25519 key pair in the browser (near-api-js `KeyPair`).
2. Send two transactions with `wallet.signAndSendTransactions`:
   - to the **user's own account**: `AddKey` with a function-call permission:
     `receiverId: CONTRACT`, `methodNames: ['enter_season', 'pay_agent']`,
     `allowance: '250000000000000000000000'` (0.25 NEAR of gas).
   - to the **contract**: `link_agent` with the public key, attaching the
     rental price for a house agent.
3. Keep the secret key in memory and `sessionStorage` only.

Whether near-connect's `signAndSendTransactions` accepts an `AddKey` action is
**unverified**. Check its action types first. If it does not: near-connect has
a function-call-key plugin that creates such a key at sign-in
(`createAccessKeyPlugin` + `connector.use()`); use that key as the agent key
and record its public key with `link_agent`. Do not spend more than an hour on
this; the fallback gives the same on-chain result.

For the hackathon, the browser holds the agent key and acts as the agent's
hands. Delivering the key to an external agent process is P2 (section 11).

### 7.4 Deploy

Real sequence behind the existing deploy terminal:

1. `set_policy` if the sliders changed (wallet prompt).
2. `AddKey` + `link_agent` if not already linked (wallet prompt).
3. Ask the game server for an open season: `POST /world/new` then note its
   `world_id`; the server calls `create_season` (section 8).
4. **`enter_season` signed with the agent key, sent straight to the RPC with
   near-api-js. No wallet prompt.** This is the moment that shows the scoped
   key working, so the log line should say so.
5. Join the game: `POST /world/{id}/join` with the pass id (section 8.2).

### 7.5 The refusal demo

Add one small control to the Spending Policy panel: **TEST LIMIT**. It sends
`enter_season`-style spend above the per-call cap with the agent key, and
prints the contract's `POLICY:` refusal in the activity log in amber. Add a
second line that tries `withdraw` with the agent key and prints the
protocol's rejection. Twenty seconds of video, and it is the AI Security
track's whole argument.

---

## 8. Wiring the game server

Python, FastAPI. Read these first:

- `quest_sim/api/world_routes.py`: `new_world` (line ~191), `perform_join`
  (~554), `join_world` (~614), `start_world` (~631). `JoinRequest` (~162).
- `quest_sim/engine/sandbox/runner.py`: the tick function ends by calling
  `self._broadcast(frame)` and then `stop_auto()` when the world is finished
  (~line 331). That is the hook point.
- `quest_sim/engine/sandbox/combat.py` ~line 132: `EngineEventType.agent_death`
  events carry `data.agent` (the dead agent's id) and `data.killer`.
- `quest_sim/engine/sandbox/season.py`: `EngineEventType.season_end` carries
  `data.winner` (an agent id, or `None`).
- `quest_sim/api/mcp_server.py`: `join_season` is the MCP way in and calls the
  same `perform_join`.

### 8.1 A settler module

Add `quest_sim/near/settler.py`. It owns the operator key and exposes:

```python
async def create_season(world_id, entry_stake_yocto)
async def start_season(world_id)
async def lock_market(world_id)
async def report_events(world_id, events)      # batches of <= 20
async def settle_season(world_id, winner_pass_id | None)
async def cancel_season(world_id)
```

Rules:

- **Never block a tick.** Calls go on an `asyncio.Queue` drained by one
  background task, in order, with retries. The game must run at full speed
  whether or not the chain is reachable.
- **Off by default.** Gate everything on `QUEST_SIM_NEAR_ENABLED`. With it
  unset the server behaves exactly as the baseline and its existing tests
  pass untouched.
- New settings (add to `.env.example`, names only): `QUEST_SIM_NEAR_ENABLED`,
  `QUEST_SIM_NEAR_CONTRACT_ID`, `QUEST_SIM_NEAR_OPERATOR_ID`,
  `QUEST_SIM_NEAR_OPERATOR_KEY`, `QUEST_SIM_NEAR_RPC_URL`,
  `QUEST_SIM_NEAR_ENTRY_STAKE`, `QUEST_SIM_NEAR_LOCK_TICK`.

How to sign from Python is your call, in this order of preference:
the `py-near` package if it works with the current RPC **(unverified)**;
otherwise a 60-line Node script using near-api-js that the settler invokes;
otherwise shelling out to the `near` CLI. All three are acceptable. Pick
whichever sends a transaction within 30 minutes.

### 8.2 Agent to pass mapping

Each agent in a world needs a `pass_id`.

- Add `pass_id: str | None` to `JoinRequest`, to `perform_join`, and to the
  MCP `join_season` tool. Store it on the agent record.
- Hosted agents (the server's own) take theirs from `near_passes.json`
  (section 6), by name.
- With NEAR enabled, the server enters house passes into the season itself,
  as the owner of those passes. A joining player's pass must already have
  called `enter_season`; verify with `get_season` before admitting them, and
  refuse the join with a clear message if not.

### 8.3 Lifecycle hooks

| Game moment | Chain call |
|---|---|
| `new_world` | `create_season(world_id, entry_stake)` |
| `start_world` | enter every house pass, then `start_season` |
| Each tick, after `_broadcast(frame)` | Collect that tick's `agent_death` events into `kill` events (map agent ids to pass ids; a death with no agent killer has `killer: null`) and send `report_events` |
| Tick reaches `QUEST_SIM_NEAR_LOCK_TICK` | `lock_market` |
| World phase becomes `finished` | flush pending events, then `settle_season` with the winner's pass id |
| World deleted or swept before finishing | `cancel_season` |

Loot XP (the `loot` event) is P1: one event per dungeon cleared is enough.

Add the last transaction hashes to the world state the spectator already
polls, so the UI can link to the explorer.

### 8.4 Tests

The baseline reports 443 passing tests. Run them before touching anything
(`pytest`), and again after. Add tests for the settler with a fake client:
a kill produces one `kill` event with the right pass ids; a finished world
produces exactly one `settle_season`; nothing is sent when NEAR is disabled.

---

## 9. Wiring the island spectator

`apps/island`, React 19. The market already exists and is fake:

- `src/components/Sandbox/BettingContext.jsx`: a localStorage wallet of 1000
  chips, per-world bet slips, parimutuel odds with a 2% rake, settlement at
  season end. Its context value is
  `{ balance, bets, myTotal, pools, odds, prob, probHistory, place, payout, bettingOpen }`.
- `src/components/Sandbox/MarketPanel.jsx`: the drawer that renders it.

Keep the context's shape and replace its inside:

| Field | Source |
|---|---|
| `pools` | `get_market(world_id)`, polled every 3 s |
| `bets` | `get_bets(world_id, account)` |
| `balance` | The connected account's NEAR balance |
| `bettingOpen` | `get_market().open` |
| `place(agent, stake)` | `place_bet(world_id, pass_id)` with the stake attached |
| `payout` | After settle: `get_bets().claimable`, with a **CLAIM** button calling `claim_winnings` |
| `odds`, `prob` | Computed from `pools` exactly as now, but with the contract's cuts (5% + 2% of the losing side) instead of the flat 2% rake |

Stakes are 25 / 100 / 250 chips today (`STAKES`). Change them to
0.1 / 0.5 / 1 NEAR. Add a wallet connect control to the top bar using the
same near-connect setup as the start app; share the code by copying
`near.js`, not by building a package.

With no wallet connected, or with `VITE_CONTRACT_ID` unset, fall back to the
existing simulated wallet so the spectator still works stand-alone.

Agents need their `pass_id` in the frames the spectator receives; add it to
the agent summary in the server's state and stream payloads.

---

## 10. Agent World, the lobby, and assets

`apps/world` is the hub between the start app and the games: a globe you dive
into, a city with 18 agents, and venue portals that open a game full-screen
over the city and return to it on exit.

- It was written 2026-10-27 to 10-30, inside the hackathon window but before
  we decided to enter, and has no NEAR code. The README says so.
- It is imported with its optimised models (about 66 MB, the city alone is
  39 MB). The raw 2.3 GB asset drops are not in the repo.
- **Agent Island is already a venue** (`VENUES` in `src/config.js`, at the
  museum, with its own roof icon in `src/venues.js`). Its URL is
  `?island=<url>`, default `http://localhost:5173`.
- The start app opens the world with `?pass=<id>&account=<acct>`; the world
  forwards `pass`, `account` and `world` to the island venue's URL. The island
  app does not read them yet: use them in section 9 to pick which agent to
  follow and which season to open. This hand-off has been built but **not
  tested end to end**.
- The other three venues (colosseum, poker, speedway) open the lobby app at
  `?lobby=<url>`, default `http://localhost:5174`. The lobby is not in this
  repo. For the demo either run it from the Windows machine, point `?lobby=`
  at a hosted copy, or leave those portals dead and say "next" in the video.

### Asset licences

The owner's understanding is that the models were paid for and may be used
freely, so they are in the repo. Nobody has re-read the licences. Using a
purchased model in a shipped product and publishing its files in a public
repository are often treated differently, so **check the city model's licence
before the repo is made public.** If it forbids redistribution, remove
`apps/world/public/models/` from git history, host a built copy, and link it
from the README.

| Files | From |
|---|---|
| `apps/world/public/models/city/*` | 3DSkybuild "The City 1.0", optimised |
| `apps/world/public/models/npcs/*`, `vehicles/*` | Third-party character and vehicle packs |
| `apps/start/public/models/crew.glb` | questfi-lobby, also in quest-map |
| `apps/start/public/models/viking.fbx`, `knight.fbx` | questfi-lobby |
| `apps/start/public/img/logo.png` | questfi-lobby |
| `apps/start/public/img/tcg/*.webp` | QuestFi's own card art (the card back is from questfi-lpv2) |
| `apps/island/public/**` models and sprites | quest-map |

---

## 11. Priorities

Work top to bottom. Do not start a row until the one above runs.

| # | Item | Done when |
|---|---|---|
| P0 | Contract: pass, deposit/withdraw, policy, link, seasons, kills, settle | Section 5 unit tests 1 to 7 pass |
| P0 | Deploy to testnet + seed script | `near view ... get_roster` returns four agents |
| P0 | Start app: connect, mint, load pass, deposit | Balance on the 3D card matches `near view get_pass` |
| P0 | Start app: link agent with a function-call key, `enter_season` with no prompt | Transaction visible on the explorer, signed by the agent key |
| P0 | Game server: create, start, kills, settle | One full policy-brain season settles; the winner's pass balance rises |
| P1 | Market in the contract + island drawer on real NEAR | A bet placed in the drawer is claimable after the season |
| P1 | Refusal demo (7.5) + the protocol-rejection integration test | Both refusals visible in the UI |
| P1 | Card claim | Ticket returned at level 5 |
| P1 | Start app activity log from chain | Kills appear within 5 s |
| P2 | Start → globe → city → island hand-off verified, island reads `pass` and `world` | One click path lands on the right season following the right agent |
| P2 | `pay_agent` and agents using it | |
| P2 | Hand the agent key to an external (BYO) agent over MCP | |
| P2 | Hosted demo (Railway for the server, Vercel for the apps) | |

If Friday night ends with P0 done and nothing else, that is a valid
submission for Games, NFTs and AI Security. Everything in P1 strengthens a
track; nothing in P2 is needed.

**Feature freeze: Saturday 2026-11-14 12:00 UTC.** After that, only the
README, the video and fixes.

---

## 12. Submission checklist

From the hackathon rules (nearhackathon.com, HACKATHON.md):

- [ ] Repo is **public** before the deadline, and stays public through judging.
- [ ] `LICENSE` present (MIT is in the repo; the owner may change it).
- [ ] README has: what it is; how to run it from a clean clone; the testnet
      contract address; what is baseline and what is new, with a link to the
      diff `pre-hackathon...hackathon-submission`; every library and reused
      piece listed, including AI-written code; the trusted-reporter caveat.
- [ ] Tag `hackathon-submission` on the final commit.
- [ ] A clean clone on a second machine runs by following the README alone.
- [ ] Demo video. Suggested order: card and Agent Management; link an agent;
      the no-prompt `enter_season`; the two refusals; a season with a kill
      landing on chain; a bet and its payout; the pass levelling; the card
      claim with the physical card held up to camera.
- [ ] Post on X saying it was built at NEAR HACKATHON, tagging @NEARProtocol
      and #NEARHackathon, with the video. The owner posts this, not an agent.
- [ ] Form: project name, team lead, email, team size, tracks, **mainnet**
      NEAR address for the payout, repo link, demo post link, description
      (20 to 2,000 characters).
- [ ] One submission per repo and it cannot be resubmitted; corrections go
      through nearhackathon.com/request-changes. The owner reviews the form
      contents before anything is sent.
- [ ] Demo stays up until at least 2026-11-18.

---

## 13. Open decisions for the owner

1. **Asset licences** (section 10). Check the city model before the repo goes public.
2. **Is `quest-sim` (arkanine1000) fine to republish here?** It is a second
   GitHub org; confirm the other owner agrees.
3. **Licence.** MIT is in place as a default.
4. **Testnet account names** (section 6).
5. **Hosted demo or local only.** Local with a reproducible README and a
   video is accepted; hosted is a plus.
6. **Which house agents appear in the recorded season**, so the card art and
   the 3D models match what the video shows.

# questfi contract

A NEAR contract (Rust, near-sdk 5.30) for QuestFi agent passes.

An **agent pass** is an NFT (NEP-171, with NEP-177 metadata and NEP-181
enumeration) that holds a NEAR balance inside this contract. Its owner links
an AI agent to it and gives that agent a function-call access key on the
owner's own account, limited to this contract's two agent methods,
`enter_season` and `pay_agent`. Those methods spend only from the pass
balance, and only within the per-call and daily caps the owner sets.

Seasons are run by operators (the game servers). An operator opens a season,
passes stake into its pot, the operator reports kills and loot, and settles
it. A kill pays the killer half of the victim's stake at once; the winner's
pass takes what is left of the pot. Spectators bet on entrants in a
parimutuel market; the winning pass takes a cut of the losing bets. At level
5 the owner can burn 2 NEAR from the pass balance to claim a physical card.

## Two limits on an agent

A function-call access key cannot attach a deposit, and it can call only the
methods listed when it was added. So:

- **The protocol** stops the agent's key from calling `withdraw`,
  `set_policy`, `link_agent`, `nft_transfer` or anything else that is not
  `enter_season` or `pay_agent`. Every owner method that moves money out of
  a pass or changes who can spend from it needs an attached deposit (exactly
  1 yoctoNEAR, or the rental price for a rented agent), which such a key
  cannot attach even if the method were in its list.
- **The contract** applies the pass's policy to every spend by the agent
  methods: `POLICY: over per-call cap`, `POLICY: over daily limit`, then
  `insufficient pass balance`. The owner's own keys are held to the same
  policy when they call these methods.

The sandbox test `a_function_call_key_reaches_only_the_agent_methods` adds a
real function-call key (allowance 0.25 NEAR, methods `enter_season` and
`pay_agent`) to a player's account and signs with it. Its output:

```text
enter_season signed with the agent key: ok, season_entered = {"account_id":"pilot.test.near","amount":"1000000000000000000000000","pass_id":"1","season_id":"wld_1","signed_by_agent_key":true}
withdraw signed with the agent key, no deposit: transaction rejected: unable to broadcast the transaction to the network: handler error: [An error happened during transaction execution: InvalidAccessKeyError(MethodNameMismatch { method_name: "withdraw" })]
withdraw signed with the agent key, 1 yoctoNEAR attached: transaction rejected: unable to broadcast the transaction to the network: handler error: [An error happened during transaction execution: InvalidAccessKeyError(DepositWithFunctionCall)]
pay_agent of 3 NEAR signed with the agent key: execution failed: ... FunctionCallError(ExecutionError("Smart contract panicked: POLICY: over per-call cap")) ...
```

The two `withdraw` attempts never reach the contract: the network refuses
the transactions. The `pay_agent` attempt reaches it and the policy refuses
it.

## Trust model

**The game server is a trusted reporter.** The contract enforces who may
report (only accounts the contract owner has added as operators), the money
maths, and the agent's limits. It does not verify that a kill, a loot or a
win happened in the game: an operator can report any kill between entrants
and crown any entrant. An operator cannot reach a pass balance directly: a
balance changes only through its owner's calls, deposits, and the season and
market maths below, applied to money already staked or bet.

### Known limits

- **Reports are trusted.** A dishonest or compromised operator can move a
  season's pot between its entrants or, by settling with no winner, to the
  treasury. Planned fix: publish each `report_events` batch's game log with
  its hash, and settle only after a challenge window.
- **The market lock is the operator's call.** Bets are accepted until the
  operator calls `lock_market` (or settles). Planned fix: a lock time fixed
  at `create_season`, enforced by the contract.
- **An agent key is not bound to one pass.** The contract checks that the
  caller owns the pass and applies that pass's caps; `signed_by_agent_key`
  only reports whether the recorded key signed. A function-call key on an
  account that owns several passes can spend from any of them, each within
  its own caps, and a key left on the account after `unlink_agent` keeps that
  reach. Planned fix: refuse agent methods signed by any key recorded for a
  different pass, and keep unlinked keys on a deny list until the owner
  confirms the `DeleteKey`.
- **The daily limit is a UTC day**, not a rolling 24 hours: up to twice the
  limit can be spent across midnight. Planned fix: a rolling window.
- **Storage for seasons and bet records is paid from the contract's own
  balance** (mint fees and the yoctoNEAR attached to owner calls). Settled
  seasons are never deleted. `get_accounting` shows `free_balance`; keep it
  above zero. Planned fix: a storage deposit on `create_season` and deletion
  of fully claimed seasons.
- **Rounding dust** from market payouts (under one yoctoNEAR per winning
  bettor) stays in the contract, counted as owed.
- No upgrade or state migration method: new code that changes the state
  layout needs a fresh account.

## Layout

| Path | What |
|---|---|
| `questfi/src/lib.rs` | State, `new`, admin methods, shared helpers (`spend` applies the policy) |
| `questfi/src/types.rs` | Stored types, config, JSON views, `mul_div` |
| `questfi/src/pass.rs` | `mint_pass`, `deposit`, `withdraw`, `claim_card` |
| `questfi/src/agent.rs` | `link_agent`, `unlink_agent`, `set_agent_key`, `set_policy`, `pay_agent` |
| `questfi/src/seasons.rs` | `create_season`, `enter_season`, `start_season`, `lock_market`, `report_events`, `settle_season`, `cancel_season` |
| `questfi/src/market.rs` | `place_bet`, `claim_winnings` |
| `questfi/src/views.rs` | Read-only methods |
| `questfi/src/nft.rs` | NEP-171/177/181, transfer hooks |
| `questfi/src/events.rs` | NEP-297 logs |
| `questfi/src/tests/` | Unit tests (mocked blockchain) |
| `integration-tests/tests/sandbox.rs` | near-workspaces tests on the built wasm |

## Build and test

Requires Rust (the version is pinned in `rust-toolchain.toml`; rustup
installs it) and [cargo-near](https://github.com/near/cargo-near) 0.23.

```bash
cd contracts

# unit tests
cargo test -p questfi

# build the wasm: target/near/questfi/questfi.wasm
cd questfi && cargo near build non-reproducible-wasm && cd ..

# sandbox tests against that wasm (downloads a near-sandbox binary on first run)
cargo test -p integration-tests -- --test-threads=1 --nocapture
```

The sandbox tests read the wasm from `$QUESTFI_WASM`, else
`$CARGO_TARGET_DIR/near/questfi/questfi.wasm`, else
`contracts/target/near/questfi/questfi.wasm`.

`cargo near build reproducible-wasm` (in `contracts/questfi`, needs Docker)
builds the committed source in the pinned image named in
`questfi/Cargo.toml` and embeds NEP-330 metadata naming the commit. CI
(`.github/workflows/contract-build.yml`) runs the unit tests, that build, and
the sandbox tests on the resulting wasm, and publishes the wasm with its
SHA-256 and code hash.

## Interface

Amounts are yoctoNEAR as JSON strings (`U128`). Pass ids and season ids are
strings. Counts (`xp`, `level`, `seq`, ...) are JSON numbers.

Enum casing in JSON:

- season `status`: PascalCase, `"Open"`, `"Running"`, `"Settled"`,
  `"Cancelled"`;
- agent `kind`: lowercase, `"rented"`, `"byo"`.

Callers: O = the pass's current owner, Op = an operator, Adm = the contract
owner, Any = anyone. Methods with a deposit are payable; the others refuse
one.

### Setup and admin

| Method | Caller | Deposit | Args |
|---|---|---|---|
| `new` | the contract account | 0 | `{"owner_id":"owner.testnet","treasury_id":"treasury.testnet","config":null}` (`null` = defaults below) |
| `set_config` | Adm | 0 | `{"config":{...}}`, every field |
| `add_operator`, `remove_operator` | Adm | 0 | `{"account_id":"server.testnet"}` |
| `set_roster` | Adm | 0 | `{"roster_id":"mimir","name":"MIMIR","blurb":"...","price":"400000000000000000000000"}` (adds or edits) |

`Config` with its defaults (`get_config` returns this shape):

```json
{
  "mint_storage_fee": "50000000000000000000000",
  "min_bet": "10000000000000000000000",
  "xp_per_level": 300,
  "xp_enter": 20,
  "xp_kill": 120,
  "xp_win": 200,
  "xp_loot_max": 200,
  "kill_bounty_bps": 5000,
  "market_agent_cut_bps": 500,
  "market_house_bps": 200,
  "claim_level": 5,
  "claim_burn": "2000000000000000000000000",
  "max_entrants": 16,
  "max_events_per_call": 20,
  "activity_cap": 40,
  "default_per_call_cap": "2000000000000000000000000",
  "default_daily_limit": "10000000000000000000000000"
}
```

Bounds: every `*_bps` at most 10000 and the two market cuts together at most
10000; `xp_per_level` at least 1; `activity_cap` 1 to 100;
`max_events_per_call` 1 to 50; `max_entrants` 2 to 32.

### Pass and money

| Method | Caller | Deposit | Args | Returns |
|---|---|---|---|---|
| `mint_pass` | Any | at least `mint_storage_fee` | `{}` | `"1"`, the new pass id. Anything above the fee goes to the pass balance. The new pass gets the default caps. |
| `deposit` | Any | above 0 | `{"pass_id":"1"}` | |
| `withdraw` | O | exactly 1 yocto | `{"pass_id":"1","amount":"1000000000000000000000000"}` | Sends the amount to the owner. |
| `set_policy` | O | exactly 1 yocto | `{"pass_id":"1","per_call_cap":"2000000000000000000000000","daily_limit":"10000000000000000000000000"}` | Does not reset today's spend. |
| `claim_card` | O | exactly 1 yocto | `{"pass_id":"1"}` | `"QF-TCG-1-<block_height>"`. Needs level `claim_level`, no earlier claim, `claim_burn` on the balance. |

### Agent link

| Method | Caller | Deposit | Args |
|---|---|---|---|
| `link_agent` | O | rented: at least the roster price; byo: exactly 1 yocto | `{"pass_id":"1","kind":"rented","name":"","roster_id":"mimir","public_key":"ed25519:..."}` or `{"pass_id":"1","kind":"byo","name":"SCOUT","roster_id":null,"public_key":"ed25519:..."}` |
| `unlink_agent` | O | exactly 1 yocto | `{"pass_id":"1"}` |
| `set_agent_key` | O | exactly 1 yocto | `{"pass_id":"1","public_key":"ed25519:..."}` |

- `link_agent` with `"rented"`: the price goes to the treasury, anything
  above it to the pass balance; an empty `name` takes the roster agent's
  name. `roster_id` and `public_key` may be `null` or left out. Linking again
  replaces the link (and charges a rented agent's price again).
- `link_agent` and `unlink_agent` are refused while the pass is in a season.
- `set_agent_key` replaces only the recorded key of the existing link (kind,
  name and roster id stay, nothing is charged). It is allowed during a
  season and refused when no agent is linked.
- The contract only records the key. Adding the key to the owner's account
  (`AddKey` with a function-call permission for this contract and
  `["enter_season","pay_agent"]`) and deleting it are the owner's own
  transactions.

### Agent methods

The only two methods an agent key needs. No deposit. The caller must be the
pass's current owner (a function-call key on the owner's account signs as
the owner).

| Method | Args | Effect |
|---|---|---|
| `enter_season` | `{"pass_id":"1","season_id":"wld_ab12"}` | Season `Open`, pass in no season, room left. Spends `entry_stake` under the policy into the pot. `xp += xp_enter`, `seasons += 1`. |
| `pay_agent` | `{"from_pass":"1","to_pass":"2","amount":"500000000000000000000000","memo":"scouting"}` | Spends `amount` from `from_pass` under its policy and credits `to_pass`. `memo` is optional, cut to 80 characters. |

Both events carry `signed_by_agent_key`: `true` when the transaction was
signed with the public key recorded on the pass.

### Seasons (operator)

| Method | Args | Returns / effect |
|---|---|---|
| `create_season` | `{"season_id":"wld_ab12","entry_stake":"500000000000000000000000"}` | Status `Open`, market open. Id 1 to 64 bytes, stake above 0. |
| `start_season` | `{"season_id":"wld_ab12"}` | `Open` to `Running`; no more entrants. |
| `lock_market` | `{"season_id":"wld_ab12"}` | Closes betting. Calling it again changes nothing. |
| `report_events` | `{"season_id":"wld_ab12","seq":0,"events":[...]}` | `{"applied":2,"skipped":0,"next_seq":1}` |
| `settle_season` | `{"season_id":"wld_ab12","winner_pass":"1"}` or `"winner_pass":null` | Once, from `Running`. |
| `cancel_season` | `{"season_id":"wld_ab12"}` | From `Open` or `Running`. |

`report_events`:

- Events: `{"kind":"kill","killer":"1","victim":"2"}` (`killer` may be
  `null`) and `{"kind":"loot","pass":"1","xp":50,"text":"Cleared the crypt"}`.
  At most `max_events_per_call` per batch.
- Batches are numbered per season from 0. A `seq` below the season's
  `next_seq` was applied already: nothing changes and the call returns the
  current `next_seq` (a retry after a lost response is safe, also after
  settle). A `seq` above it panics with `seq <n> is ahead of next_seq <m>`.
  `get_season` shows `next_seq`, so a restarted reporter can resume.
- An event that cannot be applied is skipped with an `event_skipped` log and
  the rest of the batch applies. Reasons: `unknown pass`,
  `victim is not an entrant`, `pass is not an entrant`,
  `victim is already dead`, `killer equals victim`, `malformed event`.
- Kill: `bounty = victim.at_risk * kill_bounty_bps / 10000` moves from the
  pot and the victim's `at_risk` to the killer's pass balance (`total_in`,
  `kills += 1`, `xp += xp_kill`). A killer that is dead still gets it. A
  `null` killer, or one that is not an entrant, is a monster: no bounty. The
  victim is marked dead and its pass leaves the season (it may enter
  another).
- Loot: `min(xp, xp_loot_max)` XP; text cut to 80 characters. No money moves.

Settlement (`docs/BUILD_SPEC.md`, section 4.6):

- The winner must be an entrant, alive or dead. Its pass gets the whole
  remaining pot, `wins += 1`, `xp += xp_win`. With `winner_pass: null` the pot
  goes to the treasury.
- Market, with P the pool, W the bets on the winner, L = P - W:
  `agent_cut = L * market_agent_cut_bps / 10000` to the winning pass
  (`market_cut`, `total_in`), `house_cut = L * market_house_bps / 10000` to the
  treasury, `distributable = P - agent_cut - house_cut`, and each bettor gets
  `stake_on_winner * distributable / W`, floored. With no winner or W = 0,
  no cuts and every bet is refunded in full.
- Example: 4 entrants at 0.5 NEAR; A kills two (0.25 + 0.25 at once), pot
  1.5; A wins and takes 1.5. Bets 3.0 on A, 1.0 on B, 1.0 on C: agent cut
  0.1, house cut 0.04, distributable 4.86, and 1.5 on A pays 2.43. The unit
  test `worked_example_to_the_yocto` checks this to the yoctoNEAR.

Cancel: each entrant's remaining `at_risk` (after any bounties) goes back to
its pass and comes off its `total_out`; bounties already paid stay paid;
every bet becomes refundable in full.

### Market

| Method | Caller | Deposit | Args | Returns |
|---|---|---|---|---|
| `place_bet` | Any | at least `min_bet` | `{"season_id":"wld_ab12","pass_id":"1"}` | Market open, pass an entrant (alive or dead). |
| `claim_winnings` | Any | 0 or 1 yocto | `{"season_id":"wld_ab12"}` | `"2430000000000000000000000"`, the payout (a losing record pays `"0"`). After settle or cancel; deletes the caller's record, so a second claim panics `nothing to claim`. An attached yoctoNEAR is sent back with the payout. |

### Views

| Method | Args | Returns |
|---|---|---|
| `get_config` | `{}` | `Config` above |
| `get_operators` | `{}` | `["server.testnet"]` |
| `get_pass` | `{"pass_id":"1"}` | `PassView` or `null` |
| `get_activity` | `{"pass_id":"1","from_index":0,"limit":20}` (both optional numbers) | `Activity[]`, newest first |
| `get_roster` | `{}` | `[{"roster_id":"mimir","name":"MIMIR","blurb":"...","price":"400000000000000000000000"}]` |
| `get_season` | `{"season_id":"wld_ab12"}` | `SeasonView` or `null` |
| `get_market` | `{"season_id":"wld_ab12"}` | `MarketView` or `null` |
| `get_bets` | `{"season_id":"wld_ab12","account_id":"fan.testnet"}` | `BetsView` |
| `get_accounting` | `{}` | `AccountingView` |
| NEP-171/177/181 | | `nft_token`, `nft_metadata`, `nft_total_supply`, `nft_tokens`, `nft_supply_for_owner`, `nft_tokens_for_owner` |

`PassView`:

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

`agent` is `null` when nothing is linked. `spent_today` reads 0 once the UTC
day has turned. `total_in` counts every credit from play and the market
(bounties, pots, market cuts, payments received); `total_out` every debit from
play (stakes, payments sent), less cancelled stakes. Deposits, withdrawals
and card burns are in neither, so `total_in - total_out` is the pass's result
from play.

`Activity`:

```json
{ "kind": "kill", "text": "Killed pass #2 in wld_ab12", "amount": "250000000000000000000000", "negative": false, "timestamp_ms": 1763000000000 }
```

Activity `kind` values: `mint`, `deposit`, `withdraw`, `card`, `link`,
`unlink`, `key`, `policy`, `pay_sent`, `pay_received`, `enter`, `kill`,
`death`, `loot`, `win`, `market_cut`, `refund`, `transfer`. A `death` entry
has amount 0 (the stake left the balance at `enter`); the bounty is on the
killer's `kill` entry.

`SeasonView`:

```json
{
  "season_id": "wld_ab12",
  "status": "Running",
  "entry_stake": "500000000000000000000000",
  "pot": "1500000000000000000000000",
  "winner": null,
  "market_open": true,
  "next_seq": 1,
  "entrants": [
    { "pass_id": "1", "name": "MIMIR", "at_risk": "500000000000000000000000", "alive": true },
    { "pass_id": "2", "name": "", "at_risk": "250000000000000000000000", "alive": false }
  ]
}
```

`name` is the linked agent's name, empty when none.

`MarketView`:

```json
{
  "open": false,
  "pool": "5000000000000000000000000",
  "totals": [{ "pass_id": "1", "amount": "3000000000000000000000000" }],
  "settled": true,
  "winner": "1",
  "status": "Settled",
  "refund": false,
  "winner_bets": "3000000000000000000000000",
  "distributable": "4860000000000000000000000"
}
```

`refund` is true once every bet is paid back in full (cancel, no winner, or
nobody on the winner). `winner_bets` and `distributable` are set at settle.

`BetsView`: `{"bets":[{"pass_id":"1","amount":"1500000000000000000000000"}],"claimable":"2430000000000000000000000"}`.
`claimable` is `null` until the season is settled or cancelled.

`AccountingView`, after the full-season sandbox test:

```json
{
  "pass_balances": "6100000000000000000000000",
  "season_pots": "0",
  "bets_owed": "2430000000000000000000000",
  "burned_total": "0",
  "owed_total": "8530000000000000000000000",
  "account_balance": "28676754603962628500000000",
  "storage_reserved": "4039060000000000000000000",
  "free_balance": "16107694603962628500000000",
  "solvent": true
}
```

`owed_total = pass_balances + season_pots + bets_owed + burned_total`;
`solvent` is `account_balance >= owed_total + storage_reserved`. The three
running sums are kept by every method; the unit tests recompute them from
state after every call.

`nft_token` and the enumeration views fill `metadata.extra` with the pass's
live state, e.g. `{"balance":"...","claim_ticket":null,"kills":2,"level":2,"seasons":1,"wins":1,"xp":340}`.

### Transfers

`nft_transfer` and `nft_transfer_call` (exactly 1 yocto, owner only; no
NEP-178 approvals) move the pass with its balance and record and clear the
agent link. Every owner-gated method checks the token's current owner, so
the previous owner, and any key on their account, can no longer act on the
pass. A pass in a running season can be moved; its winnings go to the pass.

### Events

NEP-297, standard `questfi`, version `1.0.0`, one log line each:
`EVENT_JSON:{"standard":"questfi","version":"1.0.0","event":"<name>","data":[{...}]}`.

| Event | Data |
|---|---|
| `pass_minted` | `pass_id`, `account_id`, `amount` (credited), `fee` |
| `deposit` | `pass_id`, `account_id` (sender), `amount` |
| `withdraw` | `pass_id`, `account_id`, `amount` |
| `policy_set` | `pass_id`, `account_id`, `per_call_cap`, `daily_limit` |
| `agent_linked` | `pass_id`, `account_id`, `kind`, `name`, `roster_id`, `public_key`, `amount` (price paid) |
| `agent_unlinked` | `pass_id`, `account_id`, `reason` (`owner` or `transfer`) |
| `agent_key_set` | `pass_id`, `account_id`, `public_key` |
| `season_created` | `season_id`, `account_id` (operator), `entry_stake` |
| `season_entered` | `pass_id`, `season_id`, `account_id`, `amount`, `signed_by_agent_key` |
| `season_started` | `season_id`, `entrants` |
| `kill` | `season_id`, `killer` (or `null`), `victim`, `amount` (bounty) |
| `loot` | `season_id`, `pass_id`, `xp`, `text` |
| `event_skipped` | `season_id`, `seq`, `index`, `reason` |
| `season_settled` | `season_id`, `winner`, `amount` (pot paid), `pool`, `winner_bets`, `agent_cut`, `house_cut`, `distributable` |
| `season_cancelled` | `season_id`, `amount` (stakes returned), `pool` |
| `bet_placed` | `season_id`, `pass_id`, `account_id`, `amount` |
| `winnings_claimed` | `season_id`, `account_id`, `amount` |
| `card_claimed` | `pass_id`, `account_id`, `amount` (burned), `claim_ticket` |
| `agent_payment` | `from_pass`, `to_pass`, `account_id`, `amount`, `memo`, `signed_by_agent_key` |

The standard's own `nep171` `nft_mint` and `nft_transfer` events are emitted
too.

### Panic messages callers may match

`POLICY: over per-call cap`, `POLICY: over daily limit`,
`insufficient pass balance`, `only the pass owner can do this`,
`only an operator can do this`, `only the contract owner can do this`,
`pass not found`, `season not found`,
`the agent link cannot change while the pass is in a season`,
`Requires attached deposit of exactly 1 yoctoNEAR`.

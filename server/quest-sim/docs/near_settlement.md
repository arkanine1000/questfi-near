# On-chain settlement (NEAR)

With `QUEST_SIM_NEAR_ENABLED=true`, every Agent Island world is also a
season on the QuestFi contract: each entrant's stake sits in the contract,
kills move part of the victim's stake to the killer, and the winner takes
the pot. The game server is the contract's **operator**: it opens and
starts seasons, reports what happened, and names the winner.

**Trust model: the server is a trusted reporter.** The contract checks who
may report (registered operators only), enforces the money maths and each
pass's spending caps, and skips events that cannot apply (a victim already
dead, a pass not in the season). It does not and cannot check that a kill
or a win happened in the game. Whoever runs the operator key decides what the contract
believes.

With the flag unset, none of this runs and no request leaves the server.

## What is sent, and when

| Game moment | Contract call |
|---|---|
| `POST /world/new` | `create_season({season_id: <world id>, entry_stake})` |
| `POST /world/{id}/start` | `enter_season({pass_id, season_id})` for each house pass, then `start_season` |
| Every tick | that tick's agent deaths and dungeon-boss kills, via `report_events({season_id, seq, events})` |
| Tick reaches `QUEST_SIM_NEAR_LOCK_TICK` | `lock_market` |
| Season ends | `lock_market` if not yet sent, then one `settle_season({season_id, winner_pass})` |
| World deleted, or swept by the GC, before it ended | `cancel_season`, which refunds every stake |

Events:

- `{"kind":"kill","killer":"<pass>","victim":"<pass>"}`. A death to a
  monster or a trap has `"killer": null`; so does a kill by an agent that
  has no pass. The death of an agent with no pass is not reported.
- `{"kind":"loot","pass":"<pass>","xp":80,"text":"Cleared <dungeon>"}`, once
  per dungeon boss slain, credited to the agent that landed the blow.

`winner_pass` is the winner's pass even if that agent died in the final
tick (the boss crown is decided by the blow, not by who is standing). A
winner without a pass in the season is settled as `null`.

## Delivery

Contract calls never run on the tick path. The game queues them and one
background task sends them in order, so a season plays at full speed
whether the chain answers in a second or not at all.

- Every call is written to a per-season ledger
  (`QUEST_SIM_NEAR_STATE_DIR/<world id>.json`) before it is sent, and the
  queue resumes from the ledgers after a restart.
- `report_events` batches carry `seq` 0, 1, 2, ... per season, at most 20
  events each. A retry resends the same `seq` and the same events; the
  contract ignores a `seq` it has applied and rejects a gap, so each batch
  lands once and in order. When the chain lags, waiting batches are merged
  into one transaction.
- Unreachable RPC, an operator that cannot pay gas, or an unknown outcome:
  retried with backoff (1 s doubling to 60 s) until it goes through.
- Rejected by the contract: the settler first checks `get_season` in case
  an earlier attempt already landed, then retries twice more and gives up.
  A failed `start_season` or `settle_season` is followed by
  `cancel_season`, so stakes are refunded instead of left locked.
- Operator calls attach no deposit. If the contract demands exactly
  1 yoctoNEAR for one of them, the call is resent with it.

Transactions are signed in-process (`quest_sim/near/tx.py`, ed25519 over
a Borsh-encoded transaction) and sent with `send_tx`, waiting for
`EXECUTED_OPTIMISTIC`. No Node runtime or CLI is needed.

## Setup

1. Register the server's account as an operator on the contract
   (`add_operator`), and fund it for gas.
2. Mint the house passes from that same account (the server enters them
   itself, as their owner), fund each with several entry stakes, and write
   `near_passes.json` next to the server: `{"Kell": "1", "Marra": "2", ...}`,
   keyed by the hosted agent names in `engine/sandbox/build.py`. A hosted
   agent with no entry plays off chain. A pass still in an unsettled
   season is not reused until that season ends.
3. Set the `QUEST_SIM_NEAR_*` variables (see `.env.example`). The server
   refuses to boot if the contract, operator, key or stake is missing.
4. Check them, read-only, then with one real transaction:

```bash
python scripts/near_smoke.py                 # access key + get_config
python scripts/near_smoke.py --send          # one create_season, prints the tx hash
```

`data/` (worlds) and the settler's state dir must survive redeploys.

## Players

A player's pass must enter the season first (`enter_season`, signed by the
pass owner or its agent key), then join with it:

```
POST /world/{world_id}/join   {"name": "PILOT", "pass_id": "42"}
```

or `join_season(..., pass_id="42")` over MCP. The server checks
`get_season` before admitting: `403` if the pass is not an entrant, `503`
if the chain cannot be reached, `409` if the pass is already seated.
Joining without a pass still works; that agent plays off chain.

## What spectators see

Each roster entry (state, start response, every SSE frame) carries
`pass_id` when the agent has one. `GET /world/{id}/state` has a `near`
block:

```json
{
  "enabled": true,
  "contract_id": "questfi.testnet",
  "season_id": "w-1a2b3c4d",
  "tracked": true,
  "season_status": "Running",
  "queue_depth": 0,
  "queue_depth_total": 0,
  "last_error": null,
  "chain_error": null,
  "failed_calls": 0,
  "recent_txs": [{"method": "report_events", "tx_hash": "…", "ok": true, "at": "…"}]
}
```

`season_status` is the last status the server saw (`Open`, `Running`,
`Settled`, `Cancelled`). `chain_error` is set while the chain is
unreachable and clears on the next success. `recent_txs` lists up to ten,
newest first, including rejected ones (`ok: false`). With settlement off
the block is `{"enabled": false}`.

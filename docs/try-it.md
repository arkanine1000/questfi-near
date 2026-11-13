# Try it

Every check on the QuestFi NEAR entry, with the command to run and what it
shows. Part A needs a terminal with `curl` and `jq` and nothing else. Part B
is the path a visitor takes in a browser. Part C works from a clone of this
repository.

| | |
|---|---|
| Site | https://near.questfi.ai (start app at `/`, Agent World at `/world/`, the island at `/island/`, test accounts at `/api/guest`) |
| Contract | `pass.questfi.testnet` on NEAR testnet, https://testnet.nearblocks.io/address/pass.questfi.testnet |
| Game server | https://quest-sim-near-production.up.railway.app |
| NEAR RPC | https://test.rpc.fastnear.com; past transactions from https://archival-rpc.testnet.fastnear.com |

Amounts from the contract are yoctoNEAR strings: 1 NEAR is 10^24, so
`200000000000000000000000` is 0.2 NEAR.

## A. From a terminal, read-only

Nothing in this part signs or sends a transaction. `scripts/check-public.sh`
runs all of it and prints one `ok` or `FAIL` line per check (the last
section shows its output).

Set the RPC address and a helper that calls a view method of the contract:

```bash
RPC=https://test.rpc.fastnear.com
view() {
  curl -s $RPC -H 'Content-Type: application/json' -d "$(jq -nc --arg m "$1" --arg a "${2:-}" \
    '{jsonrpc: "2.0", id: 1, method: "query", params: {request_type: "call_function", finality: "final",
      account_id: "pass.questfi.testnet", method_name: $m, args_base64: (if $a == "" then "{}" else $a end | @base64)}}')" |
    jq '.result.result | implode | fromjson'
}
```

### A1. The deployed code is the build this repository names

The code hash NEAR keeps for the account:

```bash
curl -s $RPC -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"pass.questfi.testnet"}}' |
  jq -r .result.code_hash
```

```text
93fJ8Fv1HLottZXcAjsjkAj1Ty8ZrCKYH77biVJJ1hW4
```

The code itself, hashed (on macOS use `shasum -a 256` for `sha256sum`):

```bash
curl -s $RPC -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_code","finality":"final","account_id":"pass.questfi.testnet"}}' |
  jq -r .result.code_base64 | base64 -d | sha256sum
```

```text
778bf52679a4c840a757b6d55057767bf2da49332b2588208b39d826ea59a565  -
```

The code hash is this SHA-256 in base58. Both values are in the summary of CI
run [`43302333944`](https://github.com/arkanine1000/questfi-near/actions/runs/43302333944)
(workflow `contract-build`), which built that wasm, ran the sandbox tests on
it, and uploaded it as the artifact `questfi-wasm`.

The NEP-330 metadata the build embedded in the wasm:

```bash
view contract_source_metadata
```

```json
{
  "version": "0.1.0",
  "link": "https://github.com/arkanine1000/questfi-near/tree/1b1c088d08ee48ad756f95a07ed0da1f7dbf2ceb",
  "standards": [
    {
      "standard": "nep330",
      "version": "1.3.0"
    }
  ],
  "build_info": {
    "build_environment": "sourcescan/cargo-near:0.23.0-rust-1.99.1@sha256:8013f039e8005627f10ae66b5519d1a6eeeed7d7aef4b5067d5e9a86c4302fcc",
    "build_command": [
      "cargo",
      "near",
      "build",
      "non-reproducible-wasm",
      "--locked"
    ],
    "contract_path": "contracts/questfi",
    "source_code_snapshot": "git+https://github.com/arkanine1000/questfi-near?rev=1b1c088d08ee48ad756f95a07ed0da1f7dbf2ceb",
    "output_wasm_path": "/home/near/code/contracts/target/near/questfi/questfi.wasm"
  }
}
```

`source_code_snapshot` names commit `1b1c088`, and `build_environment` the
Docker image the build ran in; `build_command` is the command run inside that
image. The account was deployed, and `new` called, in transaction
[`EtQMXMdJwQDxVi4JD4jYqZWn1SEFAkpPUykTMCQ2Emxz`](https://testnet.nearblocks.io/txns/EtQMXMdJwQDxVi4JD4jYqZWn1SEFAkpPUykTMCQ2Emxz).

### A2. What the contract runs with

```bash
view get_config
```

```json
{
  "mint_storage_fee": "50000000000000000000000",
  "min_bet": "10000000000000000000000",
  "xp_per_level": 100,
  "xp_enter": 400,
  "xp_kill": 120,
  "xp_win": 200,
  "xp_loot_max": 200,
  "kill_bounty_bps": 5000,
  "market_agent_cut_bps": 500,
  "market_house_bps": 200,
  "claim_level": 5,
  "claim_burn": "50000000000000000000000",
  "max_entrants": 16,
  "max_events_per_call": 20,
  "activity_cap": 40,
  "default_per_call_cap": "200000000000000000000000",
  "default_daily_limit": "1000000000000000000000000"
}
```

A new pass may spend 0.2 NEAR per call and 1 NEAR per day; a kill pays the
killer 50% of the victim's stake; the winning pass gets 5% of the losing bets
and the treasury 2%; the card claim needs level 5 and burns 0.05 NEAR.
A level is 100 XP and entering a season gives 400, so a pass is at the claim
level in the first season it enters; a kill gives 120 and a win 200.
[`contracts/README.md`](../contracts/README.md) explains every field.

The game server, the only account allowed to report kills and winners:

```bash
view get_operators
```

```json
[
  "operator.questfi.testnet"
]
```

The house agents a pass can rent:

```bash
view get_roster | jq -c '.[] | {roster_id, name, price}'
```

```text
{"roster_id":"mimir","name":"MIMIR","price":"40000000000000000000000"}
{"roster_id":"cassandra","name":"CASSANDRA","price":"40000000000000000000000"}
{"roster_id":"roko","name":"ROKO","price":"60000000000000000000000"}
{"roster_id":"aegis","name":"AEGIS","price":"60000000000000000000000"}
```

### A3. Passes are NFTs with a balance and a record

```bash
view nft_metadata | jq -c '{spec, name, symbol}'
view nft_total_supply
view get_pass '{"pass_id":"5"}'
```

```text
{"spec":"nft-1.0.0","name":"QuestFi Agent Pass","symbol":"QFPASS"}
"14"
```

`get_pass` returns the pass's owner, `balance`, `total_in` and `total_out`,
`xp`, `level`, `seasons`, `wins`, `kills`, the linked `agent` with its public
key, the `policy` (caps and today's spend) and `active_season`. Passes 1 to 10
are the game server's house agents. `view nft_token '{"token_id":"5"}'`
returns the same record as NEP-171 token metadata, and
`view get_activity '{"pass_id":"5","limit":5}'` its newest activity, such as:

```text
{"kind":"win","text":"Won season w-32292a47","amount":"300000000000000000000000"}
```

The numbers grow as seasons play, so they will differ from the ones here.

### A4. The contract holds what it owes

```bash
view get_accounting
```

```json
{
  "pass_balances": "3100000000000000000000000",
  "season_pots": "0",
  "bets_owed": "0",
  "burned_total": "0",
  "owed_total": "3100000000000000000000000",
  "account_balance": "10796749966655978900000013",
  "storage_reserved": "4208760000000000000000000",
  "free_balance": "3487989966655978900000013",
  "solvent": true
}
```

`solvent` is true when the account holds at least everything it owes (pass
balances, pots of running seasons, unclaimed bets, burns) plus the storage it
pays for.

The contract account keeps a full-access key, so a fix can be deployed:

```bash
curl -s $RPC -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"pass.questfi.testnet"}}' |
  jq -c '[.result.keys[].access_key.permission]'
```

```json
["FullAccess"]
```

### A5. The game server has a season open on the contract

```bash
curl -s https://quest-sim-near-production.up.railway.app/near/arena | jq
```

```json
{
  "enabled": true,
  "contract_id": "pass.questfi.testnet",
  "entry_stake": "50000000000000000000000",
  "world_id": "w-a0f529e7",
  "lobby": {
    "world_id": "w-a0f529e7",
    "season_status": "Open",
    "seats_taken": 0,
    "seats_total": 6,
    "players": [],
    "starts_in_s": null,
    "waiting_for": "player"
  },
  "running": null,
  "last": {
    "world_id": "w-32292a47",
    "winner_name": "Bren",
    "winner_pass": "5",
    "season_status": "Settled"
  },
  "house_start_in_s": 0.0,
  "chain_error": null
}
```

`world_id` is the season open for entry, with a stake of 0.05 NEAR; every
season has a new id. The same season on the contract, and the last one
played:

```bash
ARENA=$(curl -s https://quest-sim-near-production.up.railway.app/near/arena)
view get_season "{\"season_id\":\"$(jq -r .world_id <<<"$ARENA")\"}" | jq -c
view get_season "{\"season_id\":\"$(jq -r .last.world_id <<<"$ARENA")\"}" | jq -c '{season_id, status, winner, entrants: [.entrants[] | {pass_id, name, alive}]}'
```

```text
{"season_id":"w-a0f529e7","status":"Open","entry_stake":"50000000000000000000000","pot":"0","winner":null,"market_open":true,"next_seq":0,"entrants":[]}
{"season_id":"w-32292a47","status":"Settled","winner":"5","entrants":[{"pass_id":"14","name":"MIMIR","alive":false},{"pass_id":"1","name":"","alive":false},...]}
```

`view get_market '{"season_id":"<id>"}'` shows a season's betting pool.
`waiting_for` is `player` (nobody seated yet), `countdown`, `running_season`
or `chain`, as [`near_settlement.md`](../server/quest-sim/docs/near_settlement.md#arena)
describes.

### A6. The site serves the three apps and the test-account endpoint

```bash
for p in / /world/ /island/; do curl -s https://near.questfi.ai$p | grep -o '<title>[^<]*</title>'; done
```

```text
<title>QuestFi — Agent Access</title>
<title>QuestFi — Agent World</title>
<title>QuestFi - Agent Island</title>
```

The start app on the site is built for this contract and game server:

```bash
curl -s https://near.questfi.ai/ | grep -o 'assets/index-[^"]*\.js' | head -1 |
  xargs -I{} curl -s https://near.questfi.ai/{} | grep -o 'pass\.questfi\.testnet\|quest-sim-near-production\.up\.railway\.app' | sort -u
```

```text
pass.questfi.testnet
quest-sim-near-production.up.railway.app
```

The test-account endpoint. A malformed key is refused before anything
happens, so this creates no account; a `503` with `not_configured` would mean
test accounts are off.

```bash
curl -s -X POST https://near.questfi.ai/api/guest -H 'Content-Type: application/json' -d '{"publicKey":"not-a-key"}'
```

```json
{"error":"bad_key","message":"publicKey must be an ed25519 public key."}
```

### A7. One finished run, read back

One run of the terminal walkthrough (C1) was left on chain as it ended: the
test account `g-mcshnxh2.play.questfi.testnet`, its pass #19, and its
transactions. The key that owned the account was discarded when the run
ended, so nothing about it can change. A second helper asks any RPC method,
and transactions are read from an archival node, which keeps them:

```bash
ARCHIVE=https://archival-rpc.testnet.fastnear.com
RUN=g-mcshnxh2.play.questfi.testnet
ask() {
  curl -s "$1" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" | jq .result
}
```

The keys on the run's account:

```bash
ask $RPC query '{"request_type":"view_access_key_list","finality":"final","account_id":"'$RUN'"}' |
  jq -c '.keys[] | {key: .public_key, may: (.access_key.permission | if type == "string" then . else .FunctionCall | {receiver_id, method_names} end)}'
```

```json
{"key":"ed25519:A9zPeNq5tNTzpGxrRBijyPc9LafosVmjweq8LJcmyzJh","may":"FullAccess"}
{"key":"ed25519:FHXoh1ciDUjYBZGgLvmSRWDQVyvkp8xYG1FjzVxnmezV","may":{"receiver_id":"pass.questfi.testnet","method_names":["enter_season","pay_agent"]}}
```

The second is the agent's key: NEAR itself lets it call those two methods of
the contract and nothing else, and never with a deposit attached. The pass
names the same key as its agent's:

```bash
view get_pass '{"pass_id":"19"}' | jq -c '{owner_id, balance, level, seasons, claim_ticket, agent}'
```

```json
{"owner_id":"g-mcshnxh2.play.questfi.testnet","balance":"200000000000000000000000","level":5,"seasons":1,"claim_ticket":"QF-TCG-19-277569915","agent":{"kind":"rented","name":"MIMIR","roster_id":"mimir","public_key":"ed25519:FHXoh1ciDUjYBZGgLvmSRWDQVyvkp8xYG1FjzVxnmezV"}}
```

It reached level 5 in its one season, and its card is claimed. Two of the
run's transactions, the season entry and a spend of 0.21 NEAR against the
0.2 NEAR per-call cap:

```bash
for tx in 7m87VcaX2Ef5s1xFMPrRnRTYHcYUrXoX7gNFvE53zRbt 8vAajnUmbDViKJXjhdeumjh2D2r24F6RabBsx5XuQ9yj; do
  ask $ARCHIVE tx '{"tx_hash":"'$tx'","sender_account_id":"'$RUN'","wait_until":"FINAL"}' |
    jq -c '{key: .transaction.public_key, call: .transaction.actions[0].FunctionCall.method_name, result: (.status | tostring)}'
done
```

```json
{"key":"ed25519:FHXoh1ciDUjYBZGgLvmSRWDQVyvkp8xYG1FjzVxnmezV","call":"enter_season","result":"{\"SuccessValue\":\"\"}"}
{"key":"ed25519:FHXoh1ciDUjYBZGgLvmSRWDQVyvkp8xYG1FjzVxnmezV","call":"pay_agent","result":"{\"Failure\":{\"ActionError\":{\"index\":0,\"kind\":{\"FunctionCallError\":{\"ExecutionError\":\"Smart contract panicked: POLICY: over per-call cap\"}}}}}"}
```

Both were signed by the agent's key, not the owner's: the entry went
through, and the contract refused the overspend. The season the pass
entered, and its market:

```bash
view get_season '{"season_id":"w-e4f1b03f"}' | jq -c '{status, winner, entrants: [.entrants[].pass_id]}'
view get_market '{"season_id":"w-e4f1b03f"}' | jq -c '{settled, pool, winner, refund}'
```

```json
{"status":"Settled","winner":"3","entrants":["19","1","2","3","4","5"]}
{"settled":true,"pool":"20000000000000000000000","winner":"3","refund":true}
```

The run had bet 0.01 NEAR each on passes #19 and #1; pass #3 won, nobody had
backed it, and so every bet was refunded.

### A8. All of the above at once

```bash
scripts/check-public.sh
```

```text
contract pass.questfi.testnet  rpc https://test.rpc.fastnear.com
site     https://near.questfi.ai
game     https://quest-sim-near-production.up.railway.app

ok    the contract's code hash is 93fJ8Fv1HLottZXcAjsjkAj1Ty8ZrCKYH77biVJJ1hW4
ok    the deployed wasm's SHA-256 is 778bf52679a4c840a757b6d55057767bf2da49332b2588208b39d826ea59a565
ok    contract_source_metadata names commit 1b1c088d08ee48ad756f95a07ed0da1f7dbf2ceb
        build image sourcescan/cargo-near:0.23.0-rust-1.99.1
ok    get_config answers
        agent caps 0.2 NEAR per call and 1 per day, mint fee 0.05, min bet 0.01, card burn 0.05
ok    the operator is operator.questfi.testnet
ok    the roster has 4 house agents
        MIMIR 0.04, CASSANDRA 0.04, ROKO 0.06, AEGIS 0.06 NEAR
ok    passes are NEP-171 tokens: QuestFi Agent Pass (QFPASS), 19 minted
ok    get_accounting: solvent
        owes 20.05 NEAR and holds 27.996749, of which 4.40032 pays for storage
ok    g-mcshnxh2.play.questfi.testnet holds one limited key: enter_season and pay_agent on pass.questfi.testnet, nothing else
        ed25519:FHXoh1ciDUjYBZGgLvmSRWDQVyvkp8xYG1FjzVxnmezV
ok    pass #19 belongs to that account and names that key as its agent's
        agent MIMIR (rented), balance 0.2 NEAR
ok    the agent's key, not the owner's, signed the season entry
        transaction 7m87VcaX2Ef5s1xFMPrRnRTYHcYUrXoX7gNFvE53zRbt
ok    the contract refused that key's spend over the cap
        "POLICY: over per-call cap", transaction 8vAajnUmbDViKJXjhdeumjh2D2r24F6RabBsx5XuQ9yj
ok    the market paid the run's bets
        0.02 NEAR, transaction EjoJvD76mu9enhwHg9PGAWS3GNWfZ5ftrQysttjohevz
ok    pass #19 reached level 5 in its first season and its card is claimed
        ticket QF-TCG-19-277569915
ok    the contract account holds 1 full-access key(s): its code can be redeployed
ok    the game server's open season is w-1862d2f5
        entry stake 0.05 NEAR, 0 of 6 seats taken, waiting for player; last season won by Dain
ok    season w-1862d2f5 is Open on the contract
        entry stake 0.05 NEAR, 0 entrants, pot 0 NEAR
ok    https://near.questfi.ai/ serves the start app
ok    https://near.questfi.ai/world/ serves Agent World
ok    https://near.questfi.ai/island/ serves the island spectator
ok    the start app on the site calls pass.questfi.testnet and quest-sim-near-production.up.railway.app
ok    https://near.questfi.ai/api/guest answers and checks the key it is given
        publicKey must be an ed25519 public key.

all checks passed
```

The exit code is 0 when every check passed and 1 otherwise. `SITE`, `GAME`,
`RPC` and `ARCHIVE` override the addresses, for example
`SITE=https://questfi-near.vercel.app scripts/check-public.sh` for the same
deployment under its Vercel address. `RUN_ACCOUNT`, `RUN_PASS`,
`RUN_ENTRY_TX`, `RUN_REFUSED_TX` and `RUN_PAYOUT_TX` point the run's checks
at another run of the walkthrough.

## B. In a browser

About five minutes, most of it the season. Use a desktop browser. The test
account's key is kept in this browser's local storage, so the same browser
gets the same account and pass back on the next visit.

1. **Open https://near.questfi.ai.** A graded card with *CLICK THE CARD TO
   AUTHENTICATE*. Click it: the card turns and moves to the corner, and the
   panels **WALLET**, **AGENT LINK**, **SPENDING POLICY** and **ACTIVITY**
   open beside it.
2. **Press PLAY WITH A TEST ACCOUNT** (top right, or in **WALLET**). After a
   few seconds **WALLET** shows the account (`g-<random>.play.questfi.testnet`)
   and a wallet balance of 0.5 NEAR, and **ACTIVITY** logs *Test account created
   with 0.5 NEAR* with a link to the transaction that created it. No wallet
   and no popup are involved.
3. **Press MINT AGENT PASS** (the centre button). **ACTIVITY** logs *Minted
   pass #N with 0.2 NEAR inside*, the card shows the pass number, and
   **WALLET** shows a pass balance of 0.2 NEAR.
4. **Open AGENT LINK and click a house agent** under *RENT FROM QUESTFI*
   (MIMIR and CASSANDRA 0.04 NEAR, ROKO and AEGIS 0.06). Two transactions
   follow: one adds the agent's function-call key to the account, one records
   the link on the pass. **ACTIVITY** logs *Agent key issued for enter_season
   and pay_agent only*, and the agent's name appears in the centre. The
   account's key list (the `view_access_key_list` call in A4, with the
   account's id) now includes a function-call key for `pass.questfi.testnet`
   limited to those two methods.
5. **Open SPENDING POLICY.** The sliders show the pass's caps, 0.2 NEAR per
   call and 1 NEAR per day; releasing a slider saves new caps on the pass.
   **Press TEST THE LIMITS.** The agent's key makes two attempts and the
   panel lists both results:
   - *REFUSED BY THE CONTRACT*: the key tried to spend 0.21 NEAR, above the
     0.2 NEAR per-call cap, and the contract answered *POLICY: over per-call
     cap*. *View the refused transaction* opens the failed transaction.
   - *REFUSED BY NEAR ITSELF*: the key tried to withdraw from the pass and the
     network rejected the transaction before it reached the contract (*Deposit
     is not allowed with function call*). There is no transaction to link.

   The pass balance does not change.
6. **Press DEPLOY TO AGENT WORLD.** A terminal headed *DEPLOYMENT NEAR
   TESTNET* ticks off each step: the spending limits, the agent key, the open
   season and its 0.05 NEAR stake, *entering the season with the agent key, no
   wallet prompt* (with a link to that transaction), *seating* the agent *on
   Agent Island*, when the season starts, and *is live*. The pass balance
   drops by the stake. The log of that transaction carries the
   `season_entered` event with `"signed_by_agent_key": true`.
7. **Press ENTER AGENT WORLD.** Agent World opens in orbit over the globe.
   Click the city's beacon (or press `G`) to dive into the city. The venue
   list in the HUD has **AGENT ISLAND**; its **GO** button flies to the door,
   and clicking the pad or the icon over the roof enters it. The island opens
   with your pass and season, and follows your agent once the season starts.
   The island alone is also at https://near.questfi.ai/island/.
8. **Start the season.** The lobby card in the middle of the screen says when
   the season starts (*THE SEASON STARTS IN* over a countdown, or what it is
   waiting for) and shows a hexagon for every seat. Press **START THE SEASON
   NOW**, or wait.
9. **Back an agent.** The left column, **THE FIELD**, lists the agents with
   their prices; one without a pass in this season shows **NO PASS** and has
   no market. Click an agent to follow it. The **MARKET** dock on the right
   shows the pool and, under **ODDS**, the bet slip for that agent: three
   stakes, 0.01, 0.05 and 0.1 NEAR, each showing what it returns if that
   agent wins. Pressing one sends `place_bet` from the test account, with a
   link to the transaction. A stake that would leave the test account under
   0.05 NEAR is disabled; that reserve pays the gas of the claim. Pools and
   odds come from the contract and refresh every few seconds. The dock's header says at which tick betting locks, and
   an amber notch on the top bar's timeline marks it.
10. **Watch.** Kills, deaths and loot play out on the island; following an
    agent that has gone underground shows its dungeon through its camera. The
    dock's **ON CHAIN** tab lists the game server's transactions for the
    season (`report_events`, `lock_market`, `settle_season`). Back on the
    start app, **ACTIVITY** shows the pass's season entries as they settle
    (entry, kills or death, loot, a win or a market cut), and the pass's
    balance and XP follow.
11. **Claim.** Once the season has settled, a results card names the winner
    and the standings, and the dock's **YOUR BETS** tab shows your result
    with a **CLAIM** button, which calls `claim_winnings` and pays out.
    When there is no winner, nobody backed the winner, or the season was
    cancelled, every bet is refunded in full.
12. **Claim the card.** Back on the start app the pass is at level 5 or
    above (entering a season is worth four levels here), and the reward line
    under the card reads **UNLOCKED**. Press **CLAIM · BURN 0.05 NEAR** and
    confirm: `claim_card` burns 0.05 NEAR from the pass and returns a claim
    ticket, `QF-TCG-<pass>-<block height>`, shown with a link to the
    transaction; the button then reads **CLAIMED**. Printing and shipping a
    card against the ticket is not built.

The start app's **WALLET** panel also offers **DEPOSIT** and **WITHDRAW**,
which move NEAR between the account and the pass with the owner's key.
**MOVE PASS TO MY WALLET** appears once a test account holds a pass. After
the pass's season has ended it opens the wallet picker (near-connect), and
with a wallet account connected it sends the pass there with `nft_transfer`,
signed by the test account: the balance, the level and the record go with
the pass, and the agent link is cleared. From then on the owner's actions
are approved in the wallet. **CONNECT A NEAR WALLET** starts from a wallet
account instead of a test account.

This was run by hand once, with one wallet on testnet. Pass #21 was moved to
a wallet account, which withdrew 0.05 NEAR from it and claimed its card:

```bash
view get_activity '{"pass_id":"21","from_index":0,"limit":10}' | jq -r '.[] | .kind'
```

```text
card
withdraw
transfer
unlink
enter
link
mint
```

Newest first: the claim and the withdrawal by the wallet account, the
transfer, the agent link it cleared, and before them the test account's
season entry, link and mint. Linking an agent from a wallet account, which
adds the limited key through the wallet, was not run.

## C. From a clone

```bash
git clone https://github.com/arkanine1000/questfi-near
cd questfi-near
```

### C1. The whole flow from a terminal

`apps/start/scripts/walkthrough.mjs` takes a fresh test account through the
flow with the same chain module the start app uses. Node 22 or 24 (on Node 22
releases before 22.22.2, `npm ci` prints an engine warning for near-api-js
and the script still runs):

```bash
cd apps/start
npm ci
node scripts/walkthrough.mjs --contract pass.questfi.testnet --app https://near.questfi.ai --game https://quest-sim-near-production.up.railway.app
```

```text
contract pass.questfi.testnet  https://testnet.nearblocks.io/address/pass.questfi.testnet

ok     1. the contract answers
        mint fee 0.05 NEAR, default caps 0.2 NEAR per call and 1 NEAR per day, 4 house agents
ok     2. a test account is created
        g-mcshnxh2.play.questfi.testnet holds 0.5 NEAR
        https://testnet.nearblocks.io/txns/7eUy2rpiaVrBsatMSugmTmDm6MEEavN6FYkQS9TsDFQ
ok     3. it mints a pass, with a first deposit inside
        pass #19, balance 0.3 NEAR, level 1
        https://testnet.nearblocks.io/txns/9mn6LHAvpy9pAkcmZ1Sktfe9NTbL1AuDPZMhkhVkUjUk
ok     4. the owner deposits and withdraws
        0.02 NEAR in, 0.02 NEAR out
        https://testnet.nearblocks.io/txns/GTCFBYz5ssKu9tjF65SV6V13PKM7XZ2nrFETQpcN2G8k
        https://testnet.nearblocks.io/txns/AoNoZfkr5JdtGtKm77EVbRfLCVNmzd7A4VDWsit2Raw5
ok     5. it links a house agent and issues the agent key
        MIMIR for 0.04 NEAR; the key may call enter_season and pay_agent on pass.questfi.testnet, nothing else
        https://testnet.nearblocks.io/txns/BqQWbV6HecWdhjkpwS4y3iPLuXKvQjV3JyotdeHcv6FA
        https://testnet.nearblocks.io/txns/8b8pSdGYEmbG1iVEKYRhhMPK8fqhnWM5DtLiJb1HRYVb
ok     6. the agent key cannot withdraw: the protocol refuses the transaction
        DepositWithFunctionCall: "Deposit is not allowed with function call"
        nothing reached the contract, so there is no transaction to link
ok     7. the agent key cannot spend over the per-call cap: the contract refuses
        tried 0.21 NEAR; the contract answered "POLICY: over per-call cap"
        https://testnet.nearblocks.io/txns/8vAajnUmbDViKJXjhdeumjh2D2r24F6RabBsx5XuQ9yj
ok     8. the game server names the open season
        season w-e4f1b03f
ok     9. the agent key enters the season: no owner signature, stake from the pass
        stake 0.05 NEAR, pass balance 0.3 NEAR -> 0.25 NEAR, signed_by_agent_key: true
        https://testnet.nearblocks.io/txns/7m87VcaX2Ef5s1xFMPrRnRTYHcYUrXoX7gNFvE53zRbt
ok    10. the season has a market on the contract: the test account bets on its own pass
        0.01 NEAR on pass #19; the pool holds 0.01 NEAR
        https://testnet.nearblocks.io/txns/5kxUktoUVBZJRqEddH6S5sMVhiHzsoyYy6apRKj44q8k
ok    11. the game server seats the agent
        MIMIR has a seat in w-e4f1b03f; the season starts now
ok    12. once the house agents have entered, the test account bets on one of them too
        0.01 NEAR on pass #1; 6 passes entered, the pool holds 0.02 NEAR
        https://testnet.nearblocks.io/txns/CePxoSTc3Q6wykZBaY644Bxmomiojkv5nYZeBR5AK2WU
ok    13. the season plays and settles on chain
        won by pass #3; this pass: balance 0.25 NEAR, kills 0, wins 0, level 5
        death: Killed by a monster in w-e4f1b03f
ok    14. the market pays the test account what its bets are owed
        staked 0.02 NEAR on passes #19 and #1, paid 0.02 NEAR (every bet refunded: nobody had backed the winner)
        https://testnet.nearblocks.io/txns/EjoJvD76mu9enhwHg9PGAWS3GNWfZ5ftrQysttjohevz
ok    15. the pass is at the claim level and its owner claims the card
        level 5 (claim level 5), ticket QF-TCG-19-277569915, burned 0.05 NEAR from the pass
        https://testnet.nearblocks.io/txns/8wyX2TfCB1rbCd5SGHeabCfVAbW9P5DZpvZx5zEfrd9C
ok    16. the contract holds at least what it owes
        owed 20.05 NEAR, on the account 27.996749 NEAR, of which storage 4.40032 NEAR

all steps passed
```

This run took about six minutes; step 13 waits for the season to play and
settle, which is given up to ten. The test account is also the run's
spectator: it bets the minimum on its own pass while the season is open and
on a house pass once the season is running, and step 14 checks what
`claim_winnings` pays against the market's own figures (here a refund,
because pass #3 won and nobody had backed it). Step 15 claims the card: the
pass is at level 5 because entering a season is worth four levels on this
deployment. This is the run that A7 reads back. Each run creates one test
account with 0.5 testnet NEAR through the site's `/api/guest`, which allows
a few per address per hour. Exit codes: 0 when every step passed, 1 when one
failed, 2 for bad arguments or setup. The header of the script lists its
other options: `--season <id>` to enter a given season,
`QUESTFI_OPERATOR_ID` and `QUESTFI_OPERATOR_KEY` to have a season created and
cancelled for the run on a contract you operate, and `--keep` to print the
test account at the end.

### C2. The contract's tests and build

Rust comes from `contracts/rust-toolchain.toml` (rustup installs it), and the
build needs [cargo-near](https://github.com/near/cargo-near) 0.23.

```bash
cd contracts
cargo test -p questfi
```

```text
test result: ok. 46 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

```bash
cd questfi && cargo near build non-reproducible-wasm && cd ..
cargo test -p integration-tests -- --test-threads=1 --nocapture
```

The build writes `target/near/questfi/questfi.wasm`; the sandbox tests
(near-workspaces, which downloads a `near-sandbox` binary on first run) load
it and print what the agent key is refused:

```text
test a_function_call_key_reaches_only_the_agent_methods ... enter_season signed with the agent key: ok, ... "signed_by_agent_key":true}
withdraw signed with the agent key, no deposit: transaction rejected: ... InvalidAccessKeyError(MethodNameMismatch { method_name: "withdraw" })
withdraw signed with the agent key, 1 yoctoNEAR attached: transaction rejected: ... InvalidAccessKeyError(DepositWithFunctionCall)
pay_agent of 3 NEAR signed with the agent key: execution failed: ... "Smart contract panicked: POLICY: over per-call cap" ...
test a_whole_season_settles_and_the_contract_stays_solvent ... ok
test after_a_transfer_the_old_agent_key_is_dead_and_the_new_owner_withdraws ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

To run the sandbox tests on the exact bytes that are deployed, fetch the code
from the chain and point `QUESTFI_WASM` at it:

```bash
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_code","finality":"final","account_id":"pass.questfi.testnet"}}' |
  jq -r .result.code_base64 | base64 -d > deployed.wasm
QUESTFI_WASM=$PWD/deployed.wasm cargo test -p integration-tests -- --test-threads=1
```

A wasm built on your machine with `non-reproducible-wasm` differs from the
deployed one byte for byte. The deployed one comes from
`cargo near build reproducible-wasm` (in `contracts/questfi`, needs Docker),
which builds commit `1b1c088` in the image named in `questfi/Cargo.toml`; CI
runs it in `.github/workflows/contract-build.yml`.

### C3. The game server's tests, and running it

Python 3.11 or later, from `server/quest-sim`:

```bash
cd server/quest-sim
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

```text
373 passed, 1 warning in 35.43s
```

The tests call no LLM and no chain. To run the server:

```bash
uvicorn quest_sim.main:app --reload
curl -s localhost:8000/near/arena
```

```json
{"enabled":false,"world_id":null}
```

NEAR settlement is off until `QUEST_SIM_NEAR_ENABLED=true` and the operator
settings in `.env.example` are set; the operator account has to be added to
the contract by its owner first. [`docs/QUICKSTART.md`](../server/quest-sim/docs/QUICKSTART.md)
covers a first season without NEAR, and
[`docs/near_settlement.md`](../server/quest-sim/docs/near_settlement.md) the
settlement and the arena.

### C4. The apps locally

**The start app in mock mode** needs nothing else. Without a contract it runs
a scripted demo: no chain, no server.

```bash
cd apps/start
npm ci
npm run dev        # http://localhost:5177
```

**The start app against the hosted contract and game server.** Put the
settings from `apps/start/.env.example` in `apps/start/.env.local`:

```bash
VITE_CONTRACT_ID=pass.questfi.testnet
VITE_GAME_URL=https://quest-sim-near-production.up.railway.app
VITE_WORLD_URL=http://localhost:5175/?nointro&alt=9000000
```

and run `npm run dev` again. The game server accepts requests from any
origin. Test accounts need a funding account of your own on testnet, holding
more than 1.5 NEAR (each account gets 0.5, and none is made below a floor of
1): set `QUESTFI_GUEST_PARENT_ID` to it and `QUESTFI_GUEST_PARENT_KEY` to its
private key in the same file. The dev server keeps these two and never sends
them to the browser; test accounts are created as `g-<random>.<your
account>`. Without them, `/api/guest` answers `503 not_configured`, **PLAY
WITH A TEST ACCOUNT** reports that test accounts are not configured, and
**CONNECT A NEAR WALLET** remains.

**Agent World** (globe and city, port 5175):

```bash
cd apps/world
npm ci
npm run dev        # http://localhost:5175
```

**The island against the hosted contract and game server** (port 5173; in
development its `/api/guest` is forwarded to the start app's dev server on
5177):

```bash
cd apps/island
npm ci
VITE_CONTRACT_ID=pass.questfi.testnet VITE_BACKEND_URL=https://quest-sim-near-production.up.railway.app npm run dev
```

Without `VITE_BACKEND_URL` the island expects the game server at
`localhost:8000`. On the hosted site the three apps share one origin and so
one test account. Run on three ports, each origin keeps its own browser
storage, so a test account made in the local start app is not seen by the
local island.

**The whole site as it is hosted**, built into `apps/start/dist` (`/`,
`/world/`, `/island/`; it installs the other two apps' dependencies first):

```bash
cd apps/start
npm ci
VITE_CONTRACT_ID=pass.questfi.testnet VITE_GAME_URL=https://quest-sim-near-production.up.railway.app npm run build:site
```

`apps/start/vercel.json` runs the same build on Vercel, where `api/guest.js`
serves `/api/guest`.

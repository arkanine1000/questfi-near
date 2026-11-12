//! Sandbox tests: the built questfi.wasm deployed to a local near-sandbox.
//!
//! Build the wasm first (`cargo near build non-reproducible-wasm` in
//! `contracts/questfi`). It is read from `$QUESTFI_WASM`, else
//! `$CARGO_TARGET_DIR/near/questfi/questfi.wasm`, else
//! `contracts/target/near/questfi/questfi.wasm`.
//!
//! Run with `cargo test -p integration-tests -- --test-threads=1`; add
//! `--nocapture` to see the errors each refusal returns.

use std::path::PathBuf;

use anyhow::{ensure, Context};
use near_workspaces::network::Sandbox;
use near_workspaces::result::{ExecutionFinalResult, ExecutionSuccess};
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{AccessKey, Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

const N: u128 = 1_000_000_000_000_000_000_000_000;
const MN: u128 = N / 1_000;
const FEE: u128 = 50 * MN;
/// Gas for calls signed with the agent key: its allowance (0.25 NEAR) must
/// cover the prepaid gas.
const AGENT_GAS: Gas = Gas::from_tgas(100);
/// Gas for every other call: enough for any method here, and small enough
/// that a gas refund still in flight cannot hide a balance change.
const CALL_GAS: Gas = Gas::from_tgas(100);

fn wasm() -> anyhow::Result<Vec<u8>> {
    let path = match std::env::var("QUESTFI_WASM") {
        Ok(p) => PathBuf::from(p),
        Err(_) => std::env::var("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target"))
            .join("near/questfi/questfi.wasm"),
    };
    std::fs::read(&path).with_context(|| format!("{} is missing: build it with cargo near first", path.display()))
}

struct Env {
    worker: Worker<Sandbox>,
    root: Account,
    contract: Contract,
    treasury: Account,
    operator: Account,
}

impl Env {
    fn id(&self) -> &AccountId {
        self.contract.id()
    }
}

async fn account(root: &Account, name: &str) -> anyhow::Result<Account> {
    Ok(root.create_subaccount(name).initial_balance(NearToken::from_near(30)).transact().await?.into_result()?)
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let owner = account(&root, "owner").await?;
    let treasury = account(&root, "treasury").await?;
    let operator = account(&root, "server").await?;
    let contract = root
        .create_subaccount("questfi")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?
        .deploy(&wasm()?)
        .await?
        .into_result()?;
    contract
        .call("new")
        .args_json(json!({ "owner_id": owner.id(), "treasury_id": treasury.id(), "config": null }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    call_ok(&owner, contract.id(), "add_operator", json!({ "account_id": operator.id() }), 0).await?;
    Ok(Env { worker, root, contract, treasury, operator })
}

async fn call(
    who: &Account,
    contract: &AccountId,
    method: &str,
    args: Value,
    deposit: u128,
) -> near_workspaces::Result<ExecutionFinalResult> {
    who.call(contract, method)
        .args_json(args)
        .deposit(NearToken::from_yoctonear(deposit))
        .gas(CALL_GAS)
        .transact()
        .await
}

async fn call_ok(
    who: &Account,
    contract: &AccountId,
    method: &str,
    args: Value,
    deposit: u128,
) -> anyhow::Result<ExecutionSuccess> {
    match call(who, contract, method, args, deposit).await?.into_result() {
        Ok(r) => Ok(r),
        Err(e) => anyhow::bail!("{method} failed: {e:?}"),
    }
}

async fn view<T: serde::de::DeserializeOwned>(c: &Contract, method: &str, args: Value) -> anyhow::Result<T> {
    Ok(c.view(method).args_json(args).await?.json()?)
}

/// An account's NEAR balance, read once the gas refunds of earlier
/// transactions have landed.
async fn near_balance(worker: &Worker<Sandbox>, a: &Account) -> anyhow::Result<u128> {
    worker.fast_forward(3).await?;
    Ok(a.view_account().await?.balance.as_yoctonear())
}

fn n(v: &Value) -> u128 {
    v.as_str().unwrap_or_else(|| panic!("a string amount, got {v}")).parse().unwrap()
}

/// The data of each `questfi` event called `name` in the logs.
fn events(logs: &[&str], name: &str) -> Vec<Value> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| serde_json::from_str::<Value>(j).ok())
        .filter(|v| v["standard"] == "questfi" && v["event"] == name)
        .map(|v| v["data"][0].clone())
        .collect()
}

/// The error a call came back with: an RPC error when the protocol refused
/// the transaction, or the execution failure when the contract panicked.
fn rejection<E: std::error::Error>(r: Result<ExecutionFinalResult, E>) -> String {
    match r {
        Err(e) => {
            let mut text = format!("transaction rejected: {e}");
            let mut source = e.source();
            while let Some(s) = source {
                text.push_str(&format!(": {s}"));
                source = s.source();
            }
            text
        }
        Ok(out) => match out.into_result() {
            Ok(_) => "the call succeeded".to_string(),
            Err(f) => format!("execution failed: {f:?}"),
        },
    }
}

/// Adds a function-call key to `owner`'s account for `enter_season` and
/// `pay_agent` on the contract, records it with `link_agent`, and returns
/// an `Account` that signs with it.
async fn agent_key(env: &Env, owner: &Account, pass: &str) -> anyhow::Result<Account> {
    let sk = SecretKey::from_random(KeyType::ED25519);
    let pk = sk.public_key();
    owner
        .batch(owner.id())
        .add_key(
            pk.clone(),
            AccessKey::function_call_access(
                env.id(),
                &["enter_season", "pay_agent"],
                Some(NearToken::from_millinear(250)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let link =
        json!({ "pass_id": pass, "kind": "byo", "name": "SCOUT", "roster_id": null, "public_key": pk.to_string() });
    call_ok(owner, env.id(), "link_agent", link, 1).await?;
    let pass_view: Value = view(&env.contract, "get_pass", json!({ "pass_id": pass })).await?;
    ensure!(pass_view["agent"]["public_key"] == pk.to_string(), "{pass_view}");
    Ok(Account::from_secret_key(owner.id().clone(), sk, &env.worker))
}

#[tokio::test]
async fn a_function_call_key_reaches_only_the_agent_methods() -> anyhow::Result<()> {
    let env = setup().await?;
    let c = env.id();
    let pilot = account(&env.root, "pilot").await?;
    let friend = account(&env.root, "friend").await?;
    let pass: String = call_ok(&pilot, c, "mint_pass", json!({}), FEE + 4 * N).await?.json()?;
    let other: String = call_ok(&friend, c, "mint_pass", json!({}), FEE).await?.json()?;
    call_ok(&pilot, c, "deposit", json!({ "pass_id": pass }), N).await?;
    call_ok(&env.operator, c, "create_season", json!({ "season_id": "wld_1", "entry_stake": N.to_string() }), 0)
        .await?;
    let agent = agent_key(&env, &pilot, &pass).await?;

    // 1. enter_season, signed with the agent key: no wallet, no deposit.
    let out = agent
        .call(c, "enter_season")
        .args_json(json!({ "pass_id": pass, "season_id": "wld_1" }))
        .gas(AGENT_GAS)
        .transact()
        .await?;
    let logs: Vec<String> = out.logs().iter().map(|s| s.to_string()).collect();
    out.into_result().map_err(|e| anyhow::anyhow!("enter_season with the agent key failed: {e:?}"))?;
    let logs: Vec<&str> = logs.iter().map(String::as_str).collect();
    let entered = events(&logs, "season_entered");
    ensure!(entered.len() == 1, "{logs:?}");
    ensure!(entered[0]["signed_by_agent_key"] == true, "{}", entered[0]);
    println!("enter_season signed with the agent key: ok, season_entered = {}", entered[0]);

    // 2. withdraw with the agent key, no deposit: not in the key's method list.
    let r = agent
        .call(c, "withdraw")
        .args_json(json!({ "pass_id": pass, "amount": N.to_string() }))
        .gas(AGENT_GAS)
        .transact()
        .await;
    let err = rejection(r);
    println!("withdraw signed with the agent key, no deposit: {err}");
    ensure!(err.starts_with("transaction rejected") && err.contains("MethodNameMismatch"), "{err}");

    // 3. withdraw with the agent key and 1 yoctoNEAR: a function-call key cannot attach a deposit.
    let r = agent
        .call(c, "withdraw")
        .args_json(json!({ "pass_id": pass, "amount": N.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(AGENT_GAS)
        .transact()
        .await;
    let err = rejection(r);
    println!("withdraw signed with the agent key, 1 yoctoNEAR attached: {err}");
    ensure!(err.starts_with("transaction rejected") && err.contains("DepositWithFunctionCall"), "{err}");

    // 4. pay_agent above the per-call cap (2 NEAR): the contract's policy refuses it.
    let r = agent
        .call(c, "pay_agent")
        .args_json(json!({ "from_pass": pass, "to_pass": other, "amount": (3 * N).to_string(), "memo": "hire" }))
        .gas(AGENT_GAS)
        .transact()
        .await;
    let err = rejection(r);
    println!("pay_agent of 3 NEAR signed with the agent key: {err}");
    ensure!(err.starts_with("execution failed") && err.contains("POLICY: over per-call cap"), "{err}");

    // Within the cap, pay_agent goes through and is flagged as the agent's.
    let out = agent
        .call(c, "pay_agent")
        .args_json(json!({ "from_pass": pass, "to_pass": other, "amount": N.to_string(), "memo": "scouting" }))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .into_result()
        .map_err(|e| anyhow::anyhow!("pay_agent within the cap failed: {e:?}"))?;
    let paid = events(&out.logs(), "agent_payment");
    ensure!(paid.len() == 1 && paid[0]["signed_by_agent_key"] == true, "{paid:?}");

    // Nothing left the pass except the stake and the payment.
    let p: Value = view(&env.contract, "get_pass", json!({ "pass_id": pass })).await?;
    ensure!(n(&p["balance"]) == 3 * N, "{p}");
    ensure!(n(&p["policy"]["spent_today"]) == 2 * N, "{p}");
    ensure!(p["active_season"] == "wld_1", "{p}");

    // The owner's own full-access key can withdraw.
    let before = near_balance(&env.worker, &pilot).await?;
    call_ok(&pilot, c, "withdraw", json!({ "pass_id": pass, "amount": N.to_string() }), 1).await?;
    let after = near_balance(&env.worker, &pilot).await?;
    ensure!(after > before + N - 10 * MN && after < before + N, "{before} -> {after}");
    Ok(())
}

#[tokio::test]
async fn a_whole_season_settles_and_the_contract_stays_solvent() -> anyhow::Result<()> {
    let env = setup().await?;
    let c = env.id();
    let names = ["alice", "bob", "carol"];
    let mut players = Vec::new();
    let mut passes = Vec::new();
    for name in names {
        let who = account(&env.root, name).await?;
        let pass: String = call_ok(&who, c, "mint_pass", json!({}), FEE + 2 * N).await?.json()?;
        players.push(who);
        passes.push(pass);
    }
    let (a, b, cc) = (&passes[0], &passes[1], &passes[2]);
    let dave = account(&env.root, "dave").await?;
    let erin = account(&env.root, "erin").await?;
    let season = "wld_2";
    call_ok(&env.operator, c, "create_season", json!({ "season_id": season, "entry_stake": (N / 2).to_string() }), 0)
        .await?;
    for (who, pass) in players.iter().zip(passes.iter()) {
        call_ok(who, c, "enter_season", json!({ "pass_id": pass, "season_id": season }), 0).await?;
    }
    // P = 5, W = 3 (on a), L = 2.
    call_ok(&dave, c, "place_bet", json!({ "season_id": season, "pass_id": a }), 3 * N / 2).await?;
    call_ok(&erin, c, "place_bet", json!({ "season_id": season, "pass_id": a }), 3 * N / 2).await?;
    call_ok(&erin, c, "place_bet", json!({ "season_id": season, "pass_id": b }), N).await?;
    call_ok(&erin, c, "place_bet", json!({ "season_id": season, "pass_id": cc }), N).await?;

    call_ok(&env.operator, c, "start_season", json!({ "season_id": season }), 0).await?;
    let kills = json!([
        { "kind": "kill", "killer": a, "victim": b },
        { "kind": "kill", "killer": a, "victim": cc },
        { "kind": "loot", "pass": a, "xp": 50, "text": "Cleared the crypt" },
    ]);
    let r: Value =
        call_ok(&env.operator, c, "report_events", json!({ "season_id": season, "seq": 0, "events": kills }), 0)
            .await?
            .json()?;
    ensure!(r == json!({ "applied": 3, "skipped": 0, "next_seq": 1 }), "{r}");
    call_ok(&env.operator, c, "lock_market", json!({ "season_id": season }), 0).await?;

    let treasury_before = near_balance(&env.worker, &env.treasury).await?;
    call_ok(&env.operator, c, "settle_season", json!({ "season_id": season, "winner_pass": a }), 0).await?;
    let treasury_after = near_balance(&env.worker, &env.treasury).await?;
    // house_cut = 2 * 200 / 10000 = 0.04 NEAR.
    ensure!(treasury_after - treasury_before == 40 * MN, "treasury got {}", treasury_after - treasury_before);

    let pa: Value = view(&env.contract, "get_pass", json!({ "pass_id": a })).await?;
    // 2 - 0.5 + 0.25 + 0.25 + 1.0 (pot left) + 0.1 (agent cut)
    ensure!(n(&pa["balance"]) == 3_100 * MN, "{pa}");
    ensure!(n(&pa["market_cut"]) == 100 * MN, "{pa}");
    ensure!(pa["wins"] == 1 && pa["kills"] == 2 && pa["active_season"].is_null(), "{pa}");
    let m: Value = view(&env.contract, "get_market", json!({ "season_id": season })).await?;
    ensure!(n(&m["distributable"]) == 4_860 * MN && m["settled"] == true && m["open"] == false, "{m}");
    let s: Value = view(&env.contract, "get_season", json!({ "season_id": season })).await?;
    ensure!(s["status"] == "Settled" && s["winner"] == *a && n(&s["pot"]) == 0, "{s}");

    let bets: Value = view(&env.contract, "get_bets", json!({ "season_id": season, "account_id": dave.id() })).await?;
    ensure!(n(&bets["claimable"]) == 2_430 * MN, "{bets}");
    let before = near_balance(&env.worker, &dave).await?;
    let paid: String = call_ok(&dave, c, "claim_winnings", json!({ "season_id": season }), 0).await?.json()?;
    ensure!(paid.parse::<u128>()? == 2_430 * MN, "{paid}");
    let after = near_balance(&env.worker, &dave).await?;
    ensure!(after > before + 2_420 * MN && after < before + 2_430 * MN, "{before} -> {after}");

    let acct: Value = view(&env.contract, "get_accounting", json!({})).await?;
    println!("get_accounting after one claim: {acct}");
    ensure!(acct["solvent"] == true, "{acct}");
    // Passes: 3.1 + 1.5 + 1.5; erin's 2.43 still owed.
    ensure!(n(&acct["pass_balances"]) == 6_100 * MN, "{acct}");
    ensure!(n(&acct["season_pots"]) == 0, "{acct}");
    ensure!(n(&acct["bets_owed"]) == 2_430 * MN, "{acct}");
    ensure!(n(&acct["owed_total"]) == 8_530 * MN, "{acct}");
    ensure!(n(&acct["account_balance"]) >= n(&acct["owed_total"]) + n(&acct["storage_reserved"]), "{acct}");
    let contract_balance = env.contract.view_account().await?.balance.as_yoctonear();
    ensure!(n(&acct["account_balance"]) == contract_balance, "{acct} vs {contract_balance}");

    let paid: String = call_ok(&erin, c, "claim_winnings", json!({ "season_id": season }), 0).await?.json()?;
    ensure!(paid.parse::<u128>()? == 2_430 * MN, "{paid}");
    let again = rejection(call(&erin, c, "claim_winnings", json!({ "season_id": season }), 0).await);
    ensure!(again.contains("nothing to claim"), "{again}");
    let acct: Value = view(&env.contract, "get_accounting", json!({})).await?;
    ensure!(n(&acct["bets_owed"]) == 0 && acct["solvent"] == true, "{acct}");
    Ok(())
}

#[tokio::test]
async fn after_a_transfer_the_old_agent_key_is_dead_and_the_new_owner_withdraws() -> anyhow::Result<()> {
    let env = setup().await?;
    let c = env.id();
    let pilot = account(&env.root, "pilot").await?;
    let heir = account(&env.root, "heir").await?;
    let pass: String = call_ok(&pilot, c, "mint_pass", json!({}), FEE + 3 * N).await?.json()?;
    let agent = agent_key(&env, &pilot, &pass).await?;
    call_ok(&env.operator, c, "create_season", json!({ "season_id": "wld_3", "entry_stake": N.to_string() }), 0)
        .await?;

    call_ok(&pilot, c, "nft_transfer", json!({ "receiver_id": heir.id(), "token_id": pass }), 1).await?;
    let p: Value = view(&env.contract, "get_pass", json!({ "pass_id": pass })).await?;
    ensure!(p["owner_id"] == heir.id().as_str() && p["agent"].is_null() && n(&p["balance"]) == 3 * N, "{p}");
    let tok: Value = view(&env.contract, "nft_token", json!({ "token_id": pass })).await?;
    ensure!(tok["owner_id"] == heir.id().as_str(), "{tok}");

    let r = agent
        .call(c, "enter_season")
        .args_json(json!({ "pass_id": pass, "season_id": "wld_3" }))
        .gas(AGENT_GAS)
        .transact()
        .await;
    let err = rejection(r);
    println!("enter_season with the old owner's agent key after the transfer: {err}");
    ensure!(err.contains("only the pass owner can do this"), "{err}");

    let err = rejection(call(&pilot, c, "withdraw", json!({ "pass_id": pass, "amount": N.to_string() }), 1).await);
    ensure!(err.contains("only the pass owner can do this"), "{err}");

    let before = near_balance(&env.worker, &heir).await?;
    call_ok(&heir, c, "withdraw", json!({ "pass_id": pass, "amount": (3 * N).to_string() }), 1).await?;
    let after = near_balance(&env.worker, &heir).await?;
    ensure!(after > before + 3 * N - 10 * MN && after < before + 3 * N, "{before} -> {after}");
    let p: Value = view(&env.contract, "get_pass", json!({ "pass_id": pass })).await?;
    ensure!(n(&p["balance"]) == 0, "{p}");
    Ok(())
}

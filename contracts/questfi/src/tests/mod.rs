//! Unit tests on the mocked blockchain (`near-sdk` `unit-testing`).
//!
//! Every call goes through `T::call` or `T::fails`, and each of them checks
//! afterwards, by recomputing from state:
//! - the running sums (`pass_balances`, `season_pots`, `bets_owed`) equal
//!   the sums over every pass and season;
//! - each season's pot is the sum of its entrants' `at_risk`, and is 0 once
//!   the season is over;
//! - the bet money a season still holds covers what its remaining bettors
//!   can claim, and exceeds it by less than one yocto per bettor (dust);
//! - a pass's `active_season` names a live season it is alive in, and every
//!   live entrant points back at its season.

use std::collections::BTreeSet;
use std::panic::{catch_unwind, AssertUnwindSafe};

pub use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
pub use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
pub use near_contract_standards::non_fungible_token::metadata::NonFungibleTokenMetadataProvider;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PublicKey};

use crate::types::*;
use crate::*;

mod market;
mod pass;
mod policy;
mod seasons;
mod transfer;

pub const N: u128 = ONE_NEAR;
pub const MN: u128 = MILLI_NEAR;
pub const FEE: u128 = 50 * MILLI_NEAR;
pub const T0: u64 = 1_763_000_000_000_000_000; // ns
pub const DAY: u64 = NANOS_PER_DAY;

pub fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
pub fn contract_id() -> AccountId {
    acc("questfi.near")
}
pub fn owner() -> AccountId {
    acc("owner.near")
}
pub fn treasury() -> AccountId {
    acc("treasury.near")
}
pub fn operator() -> AccountId {
    acc("server.near")
}
pub fn alice() -> AccountId {
    acc("alice.near")
}
pub fn bob() -> AccountId {
    acc("bob.near")
}
pub fn carol() -> AccountId {
    acc("carol.near")
}
pub fn dave() -> AccountId {
    acc("dave.near")
}
pub fn erin() -> AccountId {
    acc("erin.near")
}
pub fn frank() -> AccountId {
    acc("frank.near")
}

/// The key a pass owner hands to the agent.
pub fn agent_pk() -> PublicKey {
    "ed25519:4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi".parse().unwrap()
}
/// The owner's own wallet key.
pub fn wallet_pk() -> PublicKey {
    "ed25519:8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR".parse().unwrap()
}
pub fn other_pk() -> PublicKey {
    "ed25519:CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8".parse().unwrap()
}

thread_local! {
    /// While set, the panic hook stays silent, so expected failures don't
    /// flood the output and real assertion failures still print.
    static QUIET: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn quiet_panics() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if !QUIET.with(|q| q.get()) {
                default(info)
            }
        }));
    });
}

fn panic_text(err: Box<dyn std::any::Any + Send>) -> String {
    err.downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

pub struct T {
    pub c: Contract,
    pub now: u64,
    pub height: u64,
    /// Every (season, bettor) that ever placed a bet.
    pub bettors: BTreeSet<(SeasonId, AccountId)>,
}

impl T {
    /// A contract with the default config and `server.near` as operator.
    pub fn new() -> Self {
        Self::with_config(None)
    }

    pub fn with_config(config: Option<Config>) -> Self {
        ctx(&contract_id(), 0, &wallet_pk(), T0, 100);
        let c = Contract::new(owner(), treasury(), config);
        let mut t = T { c, now: T0, height: 100, bettors: BTreeSet::new() };
        t.call(&owner(), 0, |c| c.add_operator(operator()));
        t
    }

    pub fn env(&self, who: &AccountId, deposit: u128, pk: &PublicKey) {
        ctx(who, deposit, pk, self.now, self.height);
    }

    /// Runs `f` as `who` with `deposit` attached, signed with the wallet key.
    pub fn call<R>(&mut self, who: &AccountId, deposit: u128, f: impl FnOnce(&mut Contract) -> R) -> R {
        self.call_pk(who, deposit, &wallet_pk(), f)
    }

    pub fn call_pk<R>(
        &mut self,
        who: &AccountId,
        deposit: u128,
        pk: &PublicKey,
        f: impl FnOnce(&mut Contract) -> R,
    ) -> R {
        self.height += 1;
        self.env(who, deposit, pk);
        let r = f(&mut self.c);
        self.check();
        r
    }

    /// Runs `f`, which must panic with a message containing `msg`, and
    /// checks that the state still adds up.
    pub fn fails<R>(&mut self, who: &AccountId, deposit: u128, msg: &str, f: impl FnOnce(&mut Contract) -> R) {
        self.fails_pk(who, deposit, &wallet_pk(), msg, f)
    }

    pub fn fails_pk<R>(
        &mut self,
        who: &AccountId,
        deposit: u128,
        pk: &PublicKey,
        msg: &str,
        f: impl FnOnce(&mut Contract) -> R,
    ) {
        self.height += 1;
        self.env(who, deposit, pk);
        quiet_panics();
        QUIET.with(|q| q.set(true));
        let r = catch_unwind(AssertUnwindSafe(|| {
            f(&mut self.c);
        }));
        QUIET.with(|q| q.set(false));
        let text = match r {
            Ok(()) => panic!("expected a panic with {msg:?}, the call succeeded"),
            Err(e) => panic_text(e),
        };
        assert!(text.contains(msg), "expected a panic with {msg:?}, got {text:?}");
        self.check();
    }

    pub fn view<R>(&self, f: impl FnOnce(&Contract) -> R) -> R {
        self.env(&alice(), 0, &wallet_pk());
        f(&self.c)
    }

    pub fn advance(&mut self, ns: u64) {
        self.now += ns;
    }

    // ------------------------------------------------------ shortcuts

    /// Mints a pass for `who` with `balance` on it. Returns its id.
    pub fn mint(&mut self, who: &AccountId, balance: u128) -> String {
        self.call(who, FEE + balance, |c| c.mint_pass())
    }

    pub fn pass(&self, id: &str) -> PassView {
        self.view(|c| c.get_pass(id.to_string())).expect("pass exists")
    }

    pub fn balance(&self, id: &str) -> u128 {
        self.pass(id).balance.0
    }

    pub fn season(&self, id: &str) -> SeasonView {
        self.view(|c| c.get_season(id.to_string())).expect("season exists")
    }

    pub fn create(&mut self, season: &str, stake: u128) {
        self.call(&operator(), 0, |c| c.create_season(season.into(), U128(stake)));
    }

    pub fn enter(&mut self, who: &AccountId, pass: &str, season: &str) {
        self.call(who, 0, |c| c.enter_season(pass.into(), season.into()));
    }

    pub fn start(&mut self, season: &str) {
        self.call(&operator(), 0, |c| c.start_season(season.into()));
    }

    pub fn report(&mut self, season: &str, seq: u64, events: Vec<Value>) -> ReportResult {
        self.call(&operator(), 0, |c| c.report_events(season.into(), seq, events))
    }

    pub fn settle(&mut self, season: &str, winner: Option<&str>) {
        self.call(&operator(), 0, |c| c.settle_season(season.into(), winner.map(|w| w.to_string())));
    }

    pub fn bet(&mut self, who: &AccountId, season: &str, pass: &str, amount: u128) {
        self.bettors.insert((season.to_string(), who.clone()));
        self.call(who, amount, |c| c.place_bet(season.into(), pass.into()));
    }

    pub fn claim(&mut self, who: &AccountId, season: &str) -> u128 {
        self.call(who, 0, |c| c.claim_winnings(season.into())).0
    }

    /// The NEAR the last call sent to `to`, from its transfer receipts.
    pub fn sent_to(&self, to: &AccountId) -> u128 {
        get_created_receipts()
            .iter()
            .filter(|r| &r.receiver_id == to)
            .flat_map(|r| r.actions.iter())
            .map(|a| match a {
                near_sdk::mock::MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
                _ => 0,
            })
            .sum()
    }

    // --------------------------------------------------- invariants

    pub fn check(&self) {
        let c = &self.c;
        let cfg = &c.config;

        let mut balances = 0u128;
        for n in 1..c.next_pass_id {
            let id = n.to_string();
            let p = c.passes.get(&id).expect("every minted pass is stored");
            balances += p.balance;
            let act = c.activity.get(&id).map(|a| a.len()).unwrap_or(0);
            assert!(act <= cfg.activity_cap as usize, "pass {id}: {act} activity entries");
            if let Some(sid) = &p.active_season {
                let s = c.seasons.get(sid).expect("active season exists");
                assert!(s.is_live(), "pass {id} is held by finished season {sid}");
                let e = &s.entrants[s.entrant_index(&id).expect("pass is an entrant of its active season")];
                assert!(e.alive, "pass {id} is dead in {sid} but still holds it");
            }
        }
        assert_eq!(c.pass_balances, balances, "pass_balances counter");

        let (mut pots, mut owed) = (0u128, 0u128);
        for (sid, s) in c.seasons.iter() {
            let at_risk: u128 = s.entrants.iter().map(|e| e.at_risk).sum();
            assert_eq!(s.pot, at_risk, "season {sid}: pot is the sum of at_risk");
            let bets: u128 = s.entrants.iter().map(|e| e.bets).sum();
            assert_eq!(s.bet_pool, bets, "season {sid}: pool is the sum of bets");
            if s.is_live() {
                pots += s.pot;
                assert!(s.market_paid == 0);
                for e in &s.entrants {
                    if e.alive {
                        let p = c.passes.get(&e.pass_id).unwrap();
                        assert_eq!(p.active_season.as_ref(), Some(sid), "live entrant {} points at {sid}", e.pass_id);
                    }
                }
            } else {
                assert_eq!(s.pot, 0, "season {sid} is over and still holds a pot");
                assert!(s.market_paid <= s.distributable);
            }
            owed += s.market_owed();

            // What the remaining bettors can claim against what is held.
            let mut claimable = 0u128;
            for (bs, who) in &self.bettors {
                if bs != sid {
                    continue;
                }
                if let Some(stakes) = c.bets.get(&(bs.clone(), who.clone())) {
                    claimable += if s.is_live() { stakes.iter().map(|b| b.amount).sum() } else { s.payout(stakes) };
                }
            }
            let held = s.market_owed();
            assert!(claimable <= held, "season {sid}: bettors can claim {claimable}, only {held} held");
            if s.is_live() {
                assert_eq!(claimable, held, "season {sid}: live pool is every stake");
            } else {
                let all = self.bettors.iter().filter(|(bs, _)| bs == sid).count() as u128;
                assert!(held - claimable <= all, "season {sid}: dust {} above {all}", held - claimable);
            }
        }
        assert_eq!(c.season_pots, pots, "season_pots counter");
        assert_eq!(c.bets_owed, owed, "bets_owed counter");
    }
}

/// A fresh mocked context; storage carries over from the last one.
pub fn ctx(who: &AccountId, deposit: u128, pk: &PublicKey, now: u64, height: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(contract_id())
        .predecessor_account_id(who.clone())
        .signer_account_id(who.clone())
        .signer_account_pk(pk.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(1_000_000))
        .block_timestamp(now)
        .block_height(height)
        .build());
}

/// The NEP-297 events in the last call's logs, as (name, data).
pub fn events() -> Vec<(String, Value)> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str::<Value>(j).unwrap())
        .filter(|v| v["standard"] == "questfi")
        .map(|v| {
            assert_eq!(v["version"], "1.0.0");
            (v["event"].as_str().unwrap().to_string(), v["data"][0].clone())
        })
        .collect()
}

/// The data of the one event called `name` in the last call's logs.
pub fn event(name: &str) -> Value {
    let found: Vec<Value> = events().into_iter().filter(|(n, _)| n == name).map(|(_, d)| d).collect();
    assert_eq!(found.len(), 1, "expected one {name} event, logs: {:?}", get_logs());
    found[0].clone()
}

pub fn kill(killer: Option<&str>, victim: &str) -> Value {
    json!({ "kind": "kill", "killer": killer, "victim": victim })
}

pub fn loot(pass: &str, xp: u32, text: &str) -> Value {
    json!({ "kind": "loot", "pass": pass, "xp": xp, "text": text })
}

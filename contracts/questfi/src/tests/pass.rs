//! Minting, deposits, withdrawals, the card claim, config and helpers.

use super::*;

const ONE_YOCTO_MSG: &str = "Requires attached deposit of exactly 1 yoctoNEAR";

#[test]
fn mint_charges_the_fee_credits_the_surplus_and_numbers_passes() {
    let mut t = T::new();
    let a = t.mint(&alice(), 3 * N);
    assert_eq!(a, "1");
    let ev = event("pass_minted");
    assert_eq!(ev["pass_id"], "1");
    assert_eq!(ev["account_id"], "alice.near");
    assert_eq!(ev["amount"], (3 * N).to_string());
    assert_eq!(ev["fee"], FEE.to_string());

    let b = t.call(&bob(), FEE, |c| c.mint_pass());
    assert_eq!(b, "2");
    let c3 = t.mint(&alice(), 0);
    assert_eq!(c3, "3");

    let p = t.pass("1");
    assert_eq!(p.token_id, "1");
    assert_eq!(p.owner_id, alice());
    assert_eq!(p.balance.0, 3 * N);
    assert_eq!((p.total_in.0, p.total_out.0, p.market_cut.0), (0, 0, 0));
    assert_eq!((p.xp, p.level, p.xp_per_level, p.seasons, p.wins, p.kills), (0, 1, 300, 0, 0, 0));
    assert_eq!(p.agent, None);
    assert_eq!(p.policy, PolicyView { per_call_cap: U128(2 * N), daily_limit: U128(10 * N), spent_today: U128(0) });
    assert_eq!(p.active_season, None);
    assert_eq!(p.claim_ticket, None);
    assert_eq!(t.balance("2"), 0);
    assert_eq!(t.pass("2").owner_id, bob());

    // NEP-171/181 views agree on who owns what.
    let tok = t.view(|c| c.nft_token("1".into())).unwrap();
    assert_eq!(tok.owner_id, alice());
    assert_eq!(tok.metadata.as_ref().unwrap().title.as_deref(), Some("QuestFi Agent Pass #1"));
    assert_eq!(t.view(|c| c.nft_supply_for_owner(alice())).0, 2);
    assert_eq!(t.view(|c| c.nft_total_supply()).0, 3);
    let mine: Vec<String> =
        t.view(|c| c.nft_tokens_for_owner(alice(), None, None)).into_iter().map(|t| t.token_id).collect();
    assert_eq!(mine, vec!["1", "3"]);
    let md = t.view(|c| c.nft_metadata());
    assert_eq!((md.name.as_str(), md.symbol.as_str(), md.spec.as_str()), ("QuestFi Agent Pass", "QFPASS", "nft-1.0.0"));

    t.fails(&carol(), FEE - 1, "mint_storage_fee", |c| c.mint_pass());
    assert_eq!(t.view(|c| c.get_accounting()).pass_balances.0, 3 * N);
    assert_eq!(t.view(|c| c.get_pass("9".into())), None);
}

#[test]
fn deposit_and_withdraw_move_the_balance_and_only_the_owner_withdraws() {
    let mut t = T::new();
    let a = t.mint(&alice(), N);
    t.call(&bob(), 2 * N, |c| c.deposit(a.clone()));
    let ev = event("deposit");
    assert_eq!((ev["pass_id"].as_str(), ev["account_id"].as_str()), (Some("1"), Some("bob.near")));
    assert_eq!(ev["amount"], (2 * N).to_string());
    assert_eq!(t.balance(&a), 3 * N);

    t.fails(&alice(), 0, "attach a deposit", |c| c.deposit(a.clone()));
    t.fails(&alice(), N, ERR_PASS_NOT_FOUND, |c| c.deposit("7".into()));
    t.fails(&alice(), 0, ONE_YOCTO_MSG, |c| c.withdraw(a.clone(), U128(N)));
    t.fails(&alice(), 2, ONE_YOCTO_MSG, |c| c.withdraw(a.clone(), U128(N)));
    t.fails(&bob(), 1, ERR_NOT_PASS_OWNER, |c| c.withdraw(a.clone(), U128(N)));
    t.fails(&alice(), 1, ERR_BALANCE, |c| c.withdraw(a.clone(), U128(3 * N + 1)));
    t.fails(&alice(), 1, "amount must be above 0", |c| c.withdraw(a.clone(), U128(0)));

    t.call(&alice(), 1, |c| c.withdraw(a.clone(), U128(N)));
    assert_eq!(t.sent_to(&alice()), N);
    let ev = event("withdraw");
    assert_eq!(ev["amount"], N.to_string());
    let p = t.pass(&a);
    assert_eq!(p.balance.0, 2 * N);
    // Deposits and withdrawals are not play: no profit or loss recorded.
    assert_eq!((p.total_in.0, p.total_out.0), (0, 0));

    let act = t.view(|c| c.get_activity(a.clone(), None, None));
    let kinds: Vec<&str> = act.iter().map(|x| x.kind.as_str()).collect();
    assert_eq!(kinds, vec!["withdraw", "deposit", "mint"]);
    assert!(act[0].negative && act[0].amount.0 == N);
    assert_eq!(t.view(|c| c.get_activity(a.clone(), Some(1), Some(1)))[0].kind, "deposit");
}

#[test]
fn claim_card_needs_level_five_burns_once_and_issues_a_ticket() {
    let mut t = T::new();
    let a = t.mint(&alice(), 5 * N);
    let b = t.mint(&bob(), 5 * N);
    t.create("s1", N);
    t.enter(&alice(), &a, "s1");
    t.enter(&bob(), &b, "s1");
    t.start("s1");
    // xp_enter 20 + 5 loots of 200 = 1020: level 4.
    let events: Vec<Value> = (0..5).map(|i| loot(&a, 500, &format!("dungeon {i}"))).collect();
    t.report("s1", 0, events);
    assert_eq!(t.pass(&a).xp, 1020);
    assert_eq!(t.pass(&a).level, 4);
    t.fails(&alice(), 1, "below the claim level", |c| c.claim_card(a.clone()));

    t.report("s1", 1, vec![loot(&a, 200, "boss")]);
    assert_eq!(t.pass(&a).level, 5);
    t.fails(&alice(), 0, ONE_YOCTO_MSG, |c| c.claim_card(a.clone()));
    t.fails(&bob(), 1, ERR_NOT_PASS_OWNER, |c| c.claim_card(a.clone()));

    let height = t.height + 1;
    let ticket = t.call(&alice(), 1, |c| c.claim_card(a.clone()));
    assert_eq!(ticket, format!("QF-TCG-1-{height}"));
    let ev = event("card_claimed");
    assert_eq!(ev["claim_ticket"], ticket);
    assert_eq!(ev["amount"], (2 * N).to_string());
    let p = t.pass(&a);
    assert_eq!(p.claim_ticket.as_deref(), Some(ticket.as_str()));
    assert_eq!(p.balance.0, 5 * N - N - 2 * N);
    assert_eq!(t.c.burned_total, 2 * N);
    let acct = t.view(|c| c.get_accounting());
    assert_eq!(acct.burned_total.0, 2 * N);
    assert_eq!(acct.owed_total.0, acct.pass_balances.0 + acct.season_pots.0 + acct.bets_owed.0 + 2 * N);

    // The token shows the ticket and the live record in metadata.extra.
    let tok = t.view(|c| c.nft_token(a.clone())).unwrap();
    let extra: Value = near_sdk::serde_json::from_str(tok.metadata.unwrap().extra.as_deref().unwrap()).unwrap();
    assert_eq!(extra["claim_ticket"], ticket);
    assert_eq!(extra["level"], 5);
    assert_eq!(extra["xp"], 1220);
    assert_eq!(extra["balance"], (2 * N).to_string());

    t.fails(&alice(), 1, "already claimed", |c| c.claim_card(a.clone()));
}

#[test]
fn claim_card_needs_the_burn_on_the_balance() {
    let mut t = T::new();
    let a = t.mint(&alice(), 2 * N);
    let b = t.mint(&bob(), 2 * N);
    t.create("s1", N);
    t.enter(&alice(), &a, "s1");
    t.enter(&bob(), &b, "s1");
    t.start("s1");
    t.report("s1", 0, (0..6).map(|_| loot(&a, 200, "")).collect());
    assert_eq!(t.pass(&a).level, 5);
    assert_eq!(t.balance(&a), N);
    t.fails(&alice(), 1, ERR_BALANCE, |c| c.claim_card(a.clone()));
}

#[test]
fn config_defaults_bounds_and_owner_only_changes() {
    let mut t = T::new();
    let cfg = t.view(|c| c.get_config());
    assert_eq!(cfg, Config::default());
    assert_eq!(cfg.mint_storage_fee.0, 50 * MN);
    assert_eq!(cfg.min_bet.0, 10 * MN);
    assert_eq!(cfg.claim_burn.0, 2 * N);
    assert_eq!((cfg.default_per_call_cap.0, cfg.default_daily_limit.0), (2 * N, 10 * N));

    let bad: Vec<(Config, &str)> = vec![
        (Config { kill_bounty_bps: 10_001, ..Config::default() }, "bps value"),
        (
            Config { market_agent_cut_bps: 9_000, market_house_bps: 1_001, ..Config::default() },
            "market_agent_cut_bps + market_house_bps",
        ),
        (Config { activity_cap: 0, ..Config::default() }, "activity_cap"),
        (Config { activity_cap: 101, ..Config::default() }, "activity_cap"),
        (Config { max_events_per_call: 0, ..Config::default() }, "max_events_per_call"),
        (Config { max_events_per_call: 51, ..Config::default() }, "max_events_per_call"),
        (Config { max_entrants: 1, ..Config::default() }, "max_entrants"),
        (Config { max_entrants: 33, ..Config::default() }, "max_entrants"),
        (Config { xp_per_level: 0, ..Config::default() }, "xp_per_level"),
    ];
    for (cfg, msg) in bad {
        t.fails(&owner(), 0, msg, |c| c.set_config(cfg));
    }
    let new = Config {
        default_per_call_cap: U128(N),
        default_daily_limit: U128(3 * N),
        mint_storage_fee: U128(60 * MN),
        ..Config::default()
    };
    t.fails(&alice(), 0, ERR_NOT_OWNER, |c| c.set_config(new.clone()));
    t.call(&owner(), 0, |c| c.set_config(new.clone()));
    assert_eq!(t.view(|c| c.get_config()), new);
    t.fails(&alice(), FEE, "mint_storage_fee", |c| c.mint_pass());
    let a = t.call(&alice(), 60 * MN, |c| c.mint_pass());
    assert_eq!(t.pass(&a).policy.per_call_cap.0, N);
    assert_eq!(t.pass(&a).policy.daily_limit.0, 3 * N);
}

#[test]
fn new_takes_a_config_and_validates_it() {
    let cfg = Config { max_entrants: 4, ..Config::default() };
    let t = T::with_config(Some(cfg.clone()));
    assert_eq!(t.view(|c| c.get_config()), cfg);

    quiet_panics();
    QUIET.with(|q| q.set(true));
    let r = catch_unwind(|| {
        ctx(&contract_id(), 0, &wallet_pk(), T0, 1);
        Contract::new(owner(), treasury(), Some(Config { max_entrants: 40, ..Config::default() }))
    });
    QUIET.with(|q| q.set(false));
    assert!(panic_text(r.err().expect("new must refuse a bad config")).contains("max_entrants"));
}

#[test]
fn activity_is_capped_newest_first() {
    let cfg = Config { activity_cap: 3, ..Config::default() };
    let mut t = T::with_config(Some(cfg));
    let a = t.mint(&alice(), 0);
    for i in 1..=5u128 {
        t.call(&alice(), i, |c| c.deposit(a.clone()));
    }
    let act = t.view(|c| c.get_activity(a.clone(), None, None));
    assert_eq!(act.len(), 3);
    let amounts: Vec<u128> = act.iter().map(|x| x.amount.0).collect();
    assert_eq!(amounts, vec![5, 4, 3]);
    assert_eq!(act[0].timestamp_ms, T0 / 1_000_000);
}

#[test]
fn mul_div_is_exact_where_the_product_overflows() {
    assert_eq!(mul_div(15 * N / 10, 486 * N / 100, 3 * N), 243 * N / 100);
    assert_eq!(mul_div(7, 3, 2), 10);
    assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
    assert_eq!(mul_div(u128::MAX, 2, 4), u128::MAX / 2);
    assert_eq!(mul_div(1 << 100, 1 << 100, 1 << 90), 1 << 110);
    assert_eq!(mul_div(0, N, 1), 0);
}

#[test]
fn text_is_cut_on_character_boundaries() {
    assert_eq!(truncate_chars("abc", 2), "ab");
    let long = "é".repeat(100);
    let cut = truncate_chars(&long, MAX_TEXT_CHARS);
    assert_eq!(cut.chars().count(), 80);
    assert_eq!(cut.len(), 160);
    assert_eq!(amount_text(1_500 * MN), "1.500 NEAR");
}

#[test]
fn admin_methods_are_owner_only() {
    let mut t = T::new();
    t.fails(&alice(), 0, ERR_NOT_OWNER, |c| c.add_operator(alice()));
    t.fails(&operator(), 0, ERR_NOT_OWNER, |c| c.remove_operator(operator()));
    t.fails(&alice(), 0, ERR_NOT_OWNER, |c| c.set_roster("x".into(), "X".into(), "".into(), U128(0)));
    t.call(&owner(), 0, |c| c.set_roster("mimir".into(), "MIMIR".into(), "Reads the map".into(), U128(400 * MN)));
    t.call(&owner(), 0, |c| c.set_roster("roko".into(), "ROKO".into(), "Fights".into(), U128(600 * MN)));
    t.call(&owner(), 0, |c| c.set_roster("mimir".into(), "MIMIR".into(), "Reads every map".into(), U128(400 * MN)));
    let roster = t.view(|c| c.get_roster());
    assert_eq!(roster.len(), 2);
    assert_eq!(
        roster[0],
        RosterView {
            roster_id: "mimir".into(),
            name: "MIMIR".into(),
            blurb: "Reads every map".into(),
            price: U128(400 * MN)
        }
    );
    assert_eq!(roster[1].roster_id, "roko");
    t.fails(&owner(), 0, "roster_id", |c| c.set_roster("".into(), "X".into(), "".into(), U128(0)));
    t.fails(&owner(), 0, "name", |c| c.set_roster("x".into(), "".into(), "".into(), U128(0)));
    assert_eq!(t.view(|c| c.get_operators()), vec![operator()]);
}

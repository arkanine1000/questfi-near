//! Seasons: entry, events, settlement, cancellation and operator gating.

use super::*;

/// alice, bob and carol each mint a pass with `balance` and enter `season`
/// at `stake`. Returns the pass ids.
fn three_in(t: &mut T, season: &str, stake: u128, balance: u128) -> (String, String, String) {
    let a = t.mint(&alice(), balance);
    let b = t.mint(&bob(), balance);
    let c = t.mint(&carol(), balance);
    t.create(season, stake);
    t.enter(&alice(), &a, season);
    t.enter(&bob(), &b, season);
    t.enter(&carol(), &c, season);
    (a, b, c)
}

fn entrant(t: &T, season: &str, pass: &str) -> EntrantView {
    t.season(season).entrants.into_iter().find(|e| e.pass_id == pass).unwrap()
}

#[test]
fn happy_path_three_enter_one_kill_settle() {
    let mut t = T::new();
    let (a, b, c) = three_in(&mut t, "s1", N, 5 * N);
    for p in [&a, &b, &c] {
        let v = t.pass(p);
        assert_eq!((v.balance.0, v.total_out.0, v.xp, v.seasons), (4 * N, N, 20, 1));
        assert_eq!(v.active_season.as_deref(), Some("s1"));
    }
    let s = t.season("s1");
    assert_eq!((s.status, s.pot.0, s.entry_stake.0, s.entrants.len()), (SeasonStatus::Open, 3 * N, N, 3));
    t.start("s1");
    assert_eq!(event("season_started")["entrants"], 3);
    assert_eq!(t.season("s1").status, SeasonStatus::Running);

    let r = t.report("s1", 0, vec![kill(Some(&a), &b)]);
    assert_eq!(r, ReportResult { applied: 1, skipped: 0, next_seq: 1 });
    let ev = event("kill");
    assert_eq!((ev["killer"].as_str(), ev["victim"].as_str()), (Some("1"), Some("2")));
    assert_eq!(ev["amount"], (N / 2).to_string());
    let pa = t.pass(&a);
    assert_eq!((pa.balance.0, pa.total_in.0, pa.kills, pa.xp), (4 * N + N / 2, N / 2, 1, 140));
    let eb = entrant(&t, "s1", &b);
    assert_eq!((eb.at_risk.0, eb.alive), (N / 2, false));
    assert_eq!(t.pass(&b).active_season, None);
    assert_eq!(t.season("s1").pot.0, 2 * N + N / 2);
    let death = &t.view(|c| c.get_activity(b.clone(), None, Some(1)))[0];
    assert_eq!((death.kind.as_str(), death.amount.0, death.negative), ("death", N / 2, true));

    t.settle("s1", Some(&a));
    assert_eq!(t.sent_to(&treasury()), 0);
    let ev = event("season_settled");
    assert_eq!(ev["winner"], "1");
    assert_eq!(ev["amount"], (2 * N + N / 2).to_string());
    let pa = t.pass(&a);
    assert_eq!((pa.balance.0, pa.total_in.0, pa.wins, pa.xp, pa.level), (7 * N, 3 * N, 1, 340, 2));
    assert_eq!(pa.active_season, None);
    assert_eq!(t.balance(&b), 4 * N);
    assert_eq!(t.balance(&c), 4 * N);
    assert_eq!(t.pass(&c).active_season, None);
    let s = t.season("s1");
    assert_eq!((s.status, s.pot.0, s.winner.as_deref()), (SeasonStatus::Settled, 0, Some("1")));
    assert!(s.entrants.iter().all(|e| e.at_risk.0 == 0));
    let acct = t.view(|c| c.get_accounting());
    assert_eq!((acct.pass_balances.0, acct.season_pots.0, acct.bets_owed.0), (15 * N, 0, 0));
    assert!(acct.solvent);
    // JSON names of the season view.
    let json = near_sdk::serde_json::to_value(t.season("s1")).unwrap();
    assert_eq!(json["status"], "settled");
    assert_eq!(json["entry_stake"], N.to_string());
    assert_eq!(json["entrants"][1]["alive"], false);
}

#[test]
fn the_pot_stays_the_sum_of_at_risk_through_kills() {
    let mut t = T::new();
    let (a, b, c) = three_in(&mut t, "s1", 3 * N / 2, 5 * N);
    t.start("s1");
    t.report("s1", 0, vec![kill(Some(&a), &b), kill(Some(&b), &c)]);
    // A dead killer (b, killed in the first event) still takes its bounty.
    let s = t.season("s1");
    assert_eq!(s.pot.0, s.entrants.iter().map(|e| e.at_risk.0).sum::<u128>());
    assert_eq!(s.pot.0, 3 * (3 * N / 2) - 3 * N / 4 - 3 * N / 4);
    let pb = t.pass(&b);
    assert_eq!((pb.kills, pb.total_in.0), (1, 3 * N / 4));
    assert_eq!(t.balance(&b), 5 * N - 3 * N / 2 + 3 * N / 4);
}

#[test]
fn monster_kills_pay_no_bounty() {
    let mut t = T::new();
    let (a, b, c) = three_in(&mut t, "s1", N, 5 * N);
    let outsider = t.mint(&dave(), 0);
    t.start("s1");
    let r = t.report("s1", 0, vec![kill(None, &b), kill(Some(&outsider), &c), kill(Some("999"), &a)]);
    assert_eq!(r.applied, 3);
    for (_, ev) in events().into_iter().filter(|(n, _)| n == "kill") {
        assert_eq!(ev["killer"], Value::Null);
        assert_eq!(ev["amount"], "0");
    }
    let s = t.season("s1");
    assert_eq!(s.pot.0, 3 * N);
    assert!(s.entrants.iter().all(|e| !e.alive));
    assert_eq!(t.view(|c| c.get_activity(b.clone(), None, Some(1)))[0].text, "Killed by a monster in s1");
    // Everyone is dead and nobody won: the pot goes to the treasury.
    t.settle("s1", None);
    assert_eq!(t.sent_to(&treasury()), 3 * N);
    assert_eq!(t.balance(&a), 4 * N);
}

#[test]
fn report_events_replay_is_a_no_op_and_a_gap_is_refused() {
    let mut t = T::new();
    let (a, b, c) = three_in(&mut t, "s1", N, 5 * N);
    t.fails(&operator(), 0, "the season is not running", |x| x.report_events("s1".into(), 0, vec![]));
    t.start("s1");
    assert_eq!(t.report("s1", 0, vec![kill(Some(&a), &b)]).next_seq, 1);
    let before = (t.pass(&a), t.pass(&b), t.pass(&c), t.season("s1"));

    // The same seq again (a retry after a lost response), even with other events: nothing happens.
    let r = t.report("s1", 0, vec![kill(Some(&a), &c), loot(&a, 100, "x")]);
    assert_eq!(r, ReportResult { applied: 0, skipped: 0, next_seq: 1 });
    assert!(get_logs().is_empty());
    assert_eq!((t.pass(&a), t.pass(&b), t.pass(&c), t.season("s1")), before);

    t.fails(&operator(), 0, "seq 2 is ahead of next_seq 1", |x| x.report_events("s1".into(), 2, vec![]));
    let too_many: Vec<Value> = (0..21).map(|_| loot(&a, 1, "")).collect();
    t.fails(&operator(), 0, "too many events", |x| x.report_events("s1".into(), 1, too_many));
    assert_eq!(t.report("s1", 1, vec![]).next_seq, 2);
    assert_eq!(t.season("s1").next_seq, 2);

    // After settle, an old batch is still ignored rather than refused.
    t.settle("s1", Some(&a));
    assert_eq!(t.report("s1", 0, vec![]).next_seq, 2);
    t.fails(&operator(), 0, "the season is not running", |x| x.report_events("s1".into(), 2, vec![]));
}

#[test]
fn a_bad_event_is_skipped_and_the_rest_of_the_batch_applies() {
    let mut t = T::new();
    let (a, b, c) = three_in(&mut t, "s1", N, 5 * N);
    let d = t.mint(&dave(), 0);
    t.start("s1");
    let batch = vec![
        kill(None, "99"),
        kill(Some(&a), &a),
        kill(Some(&a), &d),
        loot(&d, 10, "x"),
        json!({ "kind": "dance", "pass": a }),
        json!({ "kind": "kill", "killer": a }),
        kill(Some(&a), &b),
        kill(Some(&c), &b),
        loot(&a, 50, "gold"),
        loot("77", 50, "gold"),
    ];
    let r = t.report("s1", 0, batch);
    assert_eq!(r, ReportResult { applied: 2, skipped: 8, next_seq: 1 });
    let skipped: Vec<(u64, String)> = events()
        .into_iter()
        .filter(|(n, _)| n == "event_skipped")
        .map(|(_, d)| {
            assert_eq!((d["season_id"].as_str(), d["seq"].as_u64()), (Some("s1"), Some(0)));
            (d["index"].as_u64().unwrap(), d["reason"].as_str().unwrap().to_string())
        })
        .collect();
    let want: Vec<(u64, String)> = [
        (0, "unknown pass"),
        (1, "killer equals victim"),
        (2, "victim is not an entrant"),
        (3, "pass is not an entrant"),
        (4, "malformed event"),
        (5, "malformed event"),
        (7, "victim is already dead"),
        (9, "unknown pass"),
    ]
    .iter()
    .map(|(i, r)| (*i, r.to_string()))
    .collect();
    assert_eq!(skipped, want);
    // Money moved once for b, to a only.
    assert_eq!(t.balance(&a), 4 * N + N / 2);
    assert_eq!(t.balance(&c), 4 * N);
    assert_eq!(t.pass(&a).xp, 20 + 120 + 50);
    assert_eq!(t.pass(&c).kills, 0);
}

#[test]
fn loot_caps_xp_and_cuts_text_without_moving_money() {
    let mut t = T::new();
    let (a, _b, c) = three_in(&mut t, "s1", N, 5 * N);
    t.start("s1");
    let text = format!("{}{}", "ä".repeat(79), "🗡️ and more");
    t.report("s1", 0, vec![loot(&a, 1_000, &text), loot(&c, 30, "")]);
    let ev: Vec<Value> = events().into_iter().filter(|(n, _)| n == "loot").map(|(_, d)| d).collect();
    assert_eq!(ev[0]["xp"], 200);
    let cut = ev[0]["text"].as_str().unwrap();
    assert_eq!(cut.chars().count(), 80);
    assert!(cut.starts_with(&"ä".repeat(79)));
    assert_eq!(t.pass(&a).xp, 220);
    assert_eq!(t.balance(&a), 4 * N);
    assert_eq!(t.season("s1").pot.0, 3 * N);
    assert_eq!(t.view(|x| x.get_activity(c.clone(), None, Some(1)))[0].text, "Loot in s1: 30 XP");
}

#[test]
fn a_dead_winner_can_be_settled() {
    let mut t = T::new();
    let (a, b, c) = three_in(&mut t, "s1", N, 5 * N);
    t.start("s1");
    // a kills b, then c kills a in the same tick; the game crowns a.
    t.report("s1", 0, vec![kill(Some(&a), &b), kill(Some(&c), &a)]);
    assert!(!entrant(&t, "s1", &a).alive);
    assert_eq!(t.season("s1").pot.0, 2 * N);
    t.settle("s1", Some(&a));
    let pa = t.pass(&a);
    assert_eq!((pa.balance.0, pa.wins, pa.kills), (4 * N + N / 2 + 2 * N, 1, 1));
    assert_eq!(t.balance(&c), 4 * N + N / 2);
    assert_eq!(t.pass(&c).active_season, None);
    t.fails(&operator(), 0, "the season is not running", |x| x.settle_season("s1".into(), Some(a.clone())));
}

#[test]
fn settle_checks_its_inputs_and_happens_once() {
    let mut t = T::new();
    let (a, _b, _c) = three_in(&mut t, "s1", N, 5 * N);
    let d = t.mint(&dave(), 0);
    t.fails(&operator(), 0, "the season is not running", |x| x.settle_season("s1".into(), Some(a.clone())));
    t.start("s1");
    t.fails(&operator(), 0, "the winner is not an entrant", |x| x.settle_season("s1".into(), Some(d.clone())));
    t.fails(&operator(), 0, ERR_SEASON_NOT_FOUND, |x| x.settle_season("nope".into(), None));
    t.settle("s1", Some(&a));
    t.fails(&operator(), 0, "the season is not running", |x| x.settle_season("s1".into(), Some(a.clone())));
    t.fails(&operator(), 0, "the season is not running", |x| x.settle_season("s1".into(), None));
    t.fails(&operator(), 0, "already settled or cancelled", |x| x.cancel_season("s1".into()));
    assert_eq!(t.balance(&a), 7 * N);
}

#[test]
fn cancel_after_a_kill_refunds_exactly_the_remaining_at_risk() {
    let mut t = T::new();
    let (a, b, c) = three_in(&mut t, "s1", N, 5 * N);
    t.bet(&dave(), "s1", &a, N);
    t.bet(&erin(), "s1", &b, N / 2);
    t.start("s1");
    t.report("s1", 0, vec![kill(Some(&a), &b)]);
    t.call(&operator(), 0, |x| x.cancel_season("s1".into()));
    let ev = event("season_cancelled");
    assert_eq!(ev["amount"], (2 * N + N / 2).to_string());
    assert_eq!(ev["pool"], (N + N / 2).to_string());

    let (pa, pb, pc) = (t.pass(&a), t.pass(&b), t.pass(&c));
    // a: stake back, bounty kept. b: what was left of its stake. c: all of it.
    assert_eq!((pa.balance.0, pa.total_in.0, pa.total_out.0), (5 * N + N / 2, N / 2, 0));
    assert_eq!((pb.balance.0, pb.total_in.0, pb.total_out.0), (4 * N + N / 2, 0, N / 2));
    assert_eq!((pc.balance.0, pc.total_out.0), (5 * N, 0));
    assert!([&pa, &pb, &pc].iter().all(|p| p.active_season.is_none()));
    let s = t.season("s1");
    assert_eq!((s.status, s.pot.0, s.market_open), (SeasonStatus::Cancelled, 0, false));
    assert!(t.view(|x| x.get_market("s1".into())).unwrap().refund);

    assert_eq!(t.claim(&dave(), "s1"), N);
    assert_eq!(t.sent_to(&dave()), N);
    assert_eq!(t.claim(&erin(), "s1"), N / 2);
    t.fails(&dave(), 0, "nothing to claim", |x| x.claim_winnings("s1".into()));
    t.fails(&operator(), 0, "already settled or cancelled", |x| x.cancel_season("s1".into()));
    t.fails(&operator(), 0, "the season is not running", |x| x.settle_season("s1".into(), None));
    let acct = t.view(|x| x.get_accounting());
    assert_eq!((acct.season_pots.0, acct.bets_owed.0, acct.pass_balances.0), (0, 0, 15 * N));
}

#[test]
fn cancel_an_open_season() {
    let mut t = T::new();
    let (a, _b, _c) = three_in(&mut t, "s1", N, 5 * N);
    t.call(&operator(), 0, |x| x.cancel_season("s1".into()));
    assert_eq!(t.balance(&a), 5 * N);
    assert_eq!(t.pass(&a).total_out.0, 0);
    // Free to enter another season.
    t.create("s2", N);
    t.enter(&alice(), &a, "s2");
}

#[test]
fn enter_season_rules() {
    let cfg = Config { max_entrants: 2, ..Config::default() };
    let mut t = T::with_config(Some(cfg));
    let a = t.mint(&alice(), 5 * N);
    let b = t.mint(&bob(), 5 * N);
    let c = t.mint(&carol(), 5 * N);
    t.create("s1", N);
    t.fails(&bob(), 0, ERR_NOT_PASS_OWNER, |x| x.enter_season(a.clone(), "s1".into()));
    t.fails(&alice(), 0, ERR_SEASON_NOT_FOUND, |x| x.enter_season(a.clone(), "nope".into()));
    t.fails(&alice(), 0, ERR_PASS_NOT_FOUND, |x| x.enter_season("42".into(), "s1".into()));
    t.enter(&alice(), &a, "s1");
    t.fails(&alice(), 0, "already in a season", |x| x.enter_season(a.clone(), "s1".into()));
    t.create("s2", N);
    t.fails(&alice(), 0, "already in a season", |x| x.enter_season(a.clone(), "s2".into()));
    t.enter(&bob(), &b, "s1");
    t.fails(&carol(), 0, "the season is full", |x| x.enter_season(c.clone(), "s1".into()));
    t.start("s1");
    t.fails(&carol(), 0, "not open for entry", |x| x.enter_season(c.clone(), "s1".into()));

    // A pass killed in s1 may enter s2, and settling s1 leaves it there.
    t.report("s1", 0, vec![kill(Some(&a), &b)]);
    t.enter(&bob(), &b, "s2");
    t.settle("s1", Some(&a));
    assert_eq!(t.pass(&b).active_season.as_deref(), Some("s2"));
    assert_eq!(t.pass(&a).active_season, None);
}

#[test]
fn create_season_rules() {
    let mut t = T::new();
    t.fails(&operator(), 0, "season_id must be", |x| x.create_season("".into(), U128(N)));
    t.fails(&operator(), 0, "season_id must be", |x| x.create_season("w".repeat(65), U128(N)));
    t.fails(&operator(), 0, "entry_stake must be above 0", |x| x.create_season("s".into(), U128(0)));
    t.call(&operator(), 0, |x| x.create_season("w".repeat(64), U128(N)));
    t.create("s1", N);
    let ev = event("season_created");
    assert_eq!((ev["season_id"].as_str(), ev["account_id"].as_str()), (Some("s1"), Some("server.near")));
    t.fails(&operator(), 0, "already exists", |x| x.create_season("s1".into(), U128(N)));
    let m = t.view(|x| x.get_market("s1".into())).unwrap();
    assert!(m.open && !m.settled && !m.refund);
    assert_eq!(t.view(|x| x.get_season("nope".into())), None);
}

#[test]
fn operator_methods_reject_everyone_else() {
    let mut t = T::new();
    let (a, _b, _c) = three_in(&mut t, "s1", N, 5 * N);
    for who in [alice(), owner()] {
        t.fails(&who, 0, ERR_NOT_OPERATOR, |x| x.create_season("s2".into(), U128(N)));
        t.fails(&who, 0, ERR_NOT_OPERATOR, |x| x.start_season("s1".into()));
        t.fails(&who, 0, ERR_NOT_OPERATOR, |x| x.lock_market("s1".into()));
        t.fails(&who, 0, ERR_NOT_OPERATOR, |x| x.report_events("s1".into(), 0, vec![]));
        t.fails(&who, 0, ERR_NOT_OPERATOR, |x| x.settle_season("s1".into(), Some(a.clone())));
        t.fails(&who, 0, ERR_NOT_OPERATOR, |x| x.cancel_season("s1".into()));
    }
    t.call(&owner(), 0, |x| x.remove_operator(operator()));
    t.fails(&operator(), 0, ERR_NOT_OPERATOR, |x| x.start_season("s1".into()));
    t.call(&owner(), 0, |x| x.add_operator(dave()));
    t.call(&dave(), 0, |x| x.start_season("s1".into()));
}

#[test]
fn season_view_names_the_linked_agents() {
    let mut t = T::new();
    let a = t.mint(&alice(), 5 * N);
    let b = t.mint(&bob(), 5 * N);
    t.call(&alice(), 1, |x| x.link_agent(a.clone(), AgentKind::Byo, "SCOUT".into(), None, None));
    t.create("s1", N);
    t.enter(&alice(), &a, "s1");
    t.enter(&bob(), &b, "s1");
    let names: Vec<String> = t.season("s1").entrants.into_iter().map(|e| e.name).collect();
    assert_eq!(names, vec!["SCOUT".to_string(), String::new()]);
    let s = t.season("s1");
    assert_eq!((s.season_id.as_str(), s.market_open, s.next_seq, s.winner), ("s1", true, 0, None));
}

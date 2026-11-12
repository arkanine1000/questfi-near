//! The spectator market, including the worked example of the spec to the
//! yocto.

use super::*;

fn gina() -> AccountId {
    acc("gina.near")
}
fn hank() -> AccountId {
    acc("hank.near")
}

/// Four passes (alice, bob, carol, frank) in `season` at `stake`.
fn four_in(t: &mut T, season: &str, stake: u128) -> [String; 4] {
    let ids = [alice(), bob(), carol(), frank()].map(|who| t.mint(&who, 5 * N));
    t.create(season, stake);
    for (who, id) in [alice(), bob(), carol(), frank()].iter().zip(ids.iter()) {
        t.enter(who, id, season);
    }
    ids
}

#[test]
fn worked_example_to_the_yocto() {
    // 4 entrants at 0.5 NEAR, pot 2.0. A kills two: 0.25 + 0.25 at once,
    // pot 1.5. A wins and takes the 1.5. Bets: 3.0 on A, 1.0 on B, 1.0 on
    // C: P = 5, W = 3, L = 2. agent_cut 0.1, house_cut 0.04,
    // distributable 4.86. A bettor with 1.5 on A is paid 2.43.
    let mut t = T::new();
    let [a, b, c, _d] = four_in(&mut t, "s1", N / 2);
    assert_eq!(t.season("s1").pot.0, 2 * N);
    t.bet(&dave(), "s1", &a, 3 * N / 2);
    t.bet(&erin(), "s1", &a, N);
    t.bet(&erin(), "s1", &a, N / 2);
    t.bet(&gina(), "s1", &b, N);
    t.bet(&hank(), "s1", &c, N);
    let ev = event("bet_placed");
    assert_eq!(
        (ev["season_id"].as_str(), ev["pass_id"].as_str(), ev["account_id"].as_str()),
        (Some("s1"), Some("3"), Some("hank.near"))
    );
    assert_eq!(
        t.view(|x| x.get_bets("s1".into(), erin())).bets,
        vec![PassAmount { pass_id: a.clone(), amount: U128(3 * N / 2) }]
    );
    assert_eq!(t.view(|x| x.get_bets("s1".into(), erin())).claimable, None);

    t.start("s1");
    t.report("s1", 0, vec![kill(Some(&a), &b), kill(Some(&a), &c)]);
    assert_eq!(t.balance(&a), 5 * N - N / 2 + N / 2);
    assert_eq!(t.season("s1").pot.0, 3 * N / 2);
    t.call(&operator(), 0, |x| x.lock_market("s1".into()));
    t.fails(&dave(), N, "the market is closed", |x| x.place_bet("s1".into(), a.clone()));
    t.call(&operator(), 0, |x| x.lock_market("s1".into()));

    t.settle("s1", Some(&a));
    assert_eq!(t.sent_to(&treasury()), 40 * MN);
    let ev = event("season_settled");
    assert_eq!(ev["amount"], (3 * N / 2).to_string());
    assert_eq!(ev["pool"], (5 * N).to_string());
    assert_eq!(ev["winner_bets"], (3 * N).to_string());
    assert_eq!(ev["agent_cut"], (100 * MN).to_string());
    assert_eq!(ev["house_cut"], (40 * MN).to_string());
    assert_eq!(ev["distributable"], (4_860 * MN).to_string());

    let pa = t.pass(&a);
    // 5 - 0.5 + 0.25 + 0.25 + 1.5 + 0.1
    assert_eq!(pa.balance.0, 6_600 * MN);
    assert_eq!(pa.total_in.0, 2_100 * MN);
    assert_eq!(pa.market_cut.0, 100 * MN);
    let m = t.view(|x| x.get_market("s1".into())).unwrap();
    assert_eq!((m.open, m.settled, m.refund, m.winner.as_deref()), (false, true, false, Some("1")));
    assert_eq!((m.pool.0, m.winner_bets.0, m.distributable.0), (5 * N, 3 * N, 4_860 * MN));
    assert_eq!(m.totals[0], PassAmount { pass_id: a.clone(), amount: U128(3 * N) });

    assert_eq!(t.view(|x| x.get_bets("s1".into(), dave())).claimable, Some(U128(2_430 * MN)));
    assert_eq!(t.view(|x| x.get_bets("s1".into(), gina())).claimable, Some(U128(0)));
    assert_eq!(t.view(|x| x.get_accounting()).bets_owed.0, 4_860 * MN);

    assert_eq!(t.claim(&dave(), "s1"), 2_430 * MN);
    assert_eq!(t.sent_to(&dave()), 2_430 * MN);
    assert_eq!(event("winnings_claimed")["amount"], (2_430 * MN).to_string());
    t.fails(&dave(), 0, "nothing to claim", |x| x.claim_winnings("s1".into()));
    assert_eq!(t.view(|x| x.get_bets("s1".into(), dave())), BetsView { bets: vec![], claimable: Some(U128(0)) });

    // A losing record pays 0 and is gone.
    assert_eq!(t.claim(&gina(), "s1"), 0);
    assert_eq!(t.sent_to(&gina()), 0);
    t.fails(&gina(), 0, "nothing to claim", |x| x.claim_winnings("s1".into()));

    // 1 yoctoNEAR may be attached; it comes back with the payout.
    t.fails(&erin(), 2, "exactly 1 yoctoNEAR", |x| x.claim_winnings("s1".into()));
    t.call(&erin(), 1, |x| x.claim_winnings("s1".into()));
    assert_eq!(t.sent_to(&erin()), 2_430 * MN + 1);
    assert_eq!(t.view(|x| x.get_accounting()).bets_owed.0, 0);
}

#[test]
fn nobody_on_the_winner_means_full_refunds_and_no_cuts() {
    let mut t = T::new();
    let [a, b, _c, _d] = four_in(&mut t, "s1", N / 2);
    t.bet(&dave(), "s1", &b, N);
    t.bet(&erin(), "s1", &b, N / 2);
    t.start("s1");
    t.settle("s1", Some(&a));
    assert_eq!(t.sent_to(&treasury()), 0);
    let ev = event("season_settled");
    assert_eq!((ev["agent_cut"].as_str(), ev["house_cut"].as_str()), (Some("0"), Some("0")));
    assert_eq!(t.pass(&a).market_cut.0, 0);
    assert_eq!(t.pass(&a).balance.0, 5 * N - N / 2 + 2 * N);
    let m = t.view(|x| x.get_market("s1".into())).unwrap();
    assert!(m.refund && m.settled);
    assert_eq!(t.claim(&dave(), "s1"), N);
    assert_eq!(t.claim(&erin(), "s1"), N / 2);
    assert_eq!(t.view(|x| x.get_accounting()).bets_owed.0, 0);
}

#[test]
fn no_winner_sends_the_pot_to_the_treasury_and_refunds_bets() {
    let mut t = T::new();
    let [a, _b, _c, _d] = four_in(&mut t, "s1", N / 2);
    t.bet(&dave(), "s1", &a, N);
    t.start("s1");
    t.settle("s1", None);
    assert_eq!(t.sent_to(&treasury()), 2 * N);
    assert_eq!(event("season_settled")["winner"], Value::Null);
    assert_eq!(t.season("s1").winner, None);
    assert_eq!(t.claim(&dave(), "s1"), N);
}

#[test]
fn every_bet_on_the_winner_pays_back_the_stake() {
    let mut t = T::new();
    let [a, _b, _c, _d] = four_in(&mut t, "s1", N / 2);
    t.bet(&dave(), "s1", &a, N);
    t.bet(&erin(), "s1", &a, 2 * N);
    t.start("s1");
    t.settle("s1", Some(&a));
    assert_eq!(t.sent_to(&treasury()), 0);
    assert_eq!(t.claim(&dave(), "s1"), N);
    assert_eq!(t.claim(&erin(), "s1"), 2 * N);
}

#[test]
fn rounding_dust_stays_counted_as_owed() {
    let mut t = T::new();
    let [a, b, _c, _d] = four_in(&mut t, "s1", N / 2);
    let odd = 10 * MN + 1;
    t.bet(&dave(), "s1", &a, odd);
    t.bet(&erin(), "s1", &a, odd + 1);
    t.bet(&gina(), "s1", &a, 2 * odd);
    t.bet(&hank(), "s1", &b, 3 * odd + 7);
    t.start("s1");
    t.settle("s1", Some(&a));
    let m = t.view(|x| x.get_market("s1".into())).unwrap();
    let paid = t.claim(&dave(), "s1") + t.claim(&erin(), "s1") + t.claim(&gina(), "s1") + t.claim(&hank(), "s1");
    let dust = m.distributable.0 - paid;
    assert!(dust > 0 && dust < 3, "dust {dust}");
    let acct = t.view(|x| x.get_accounting());
    assert_eq!(acct.bets_owed.0, dust);
    assert_eq!(acct.owed_total.0, acct.pass_balances.0 + dust);
}

#[test]
fn place_bet_rules() {
    let mut t = T::new();
    let [a, _b, _c, _d] = four_in(&mut t, "s1", N / 2);
    let outsider = t.mint(&dave(), 0);
    t.fails(&dave(), 10 * MN - 1, "min_bet", |x| x.place_bet("s1".into(), a.clone()));
    t.fails(&dave(), 0, "min_bet", |x| x.place_bet("s1".into(), a.clone()));
    t.fails(&dave(), N, "the pass is not an entrant", |x| x.place_bet("s1".into(), outsider.clone()));
    t.fails(&dave(), N, ERR_SEASON_NOT_FOUND, |x| x.place_bet("s9".into(), a.clone()));
    t.fails(&dave(), 0, "not settled or cancelled yet", |x| x.claim_winnings("s1".into()));
    t.start("s1");
    // Betting stays open while running, until lock_market.
    t.bet(&dave(), "s1", &a, 10 * MN);
    t.settle("s1", Some(&a));
    t.fails(&dave(), N, "the market is closed", |x| x.place_bet("s1".into(), a.clone()));
}

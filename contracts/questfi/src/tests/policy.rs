//! The spending policy, the agent link and `pay_agent`.

use super::*;

fn roster(t: &mut T) {
    t.call(&owner(), 0, |c| c.set_roster("mimir".into(), "MIMIR".into(), "Reads the map".into(), U128(400 * MN)));
}

fn link_byo(t: &mut T, who: &AccountId, pass: &str) {
    t.call(who, 1, |c| c.link_agent(pass.into(), AgentKind::Byo, "SCOUT".into(), None, Some(agent_pk())));
}

#[test]
fn a_spend_over_the_per_call_cap_is_refused() {
    let mut t = T::new();
    let a = t.mint(&alice(), 10 * N);
    let b = t.mint(&bob(), 0);
    t.create("big", 3 * N);
    t.fails(&alice(), 0, ERR_PER_CALL_CAP, |c| c.enter_season(a.clone(), "big".into()));
    t.fails(&alice(), 0, ERR_PER_CALL_CAP, |c| c.pay_agent(a.clone(), b.clone(), U128(2 * N + 1), None));
    // Exactly the cap is allowed.
    t.call(&alice(), 0, |c| c.pay_agent(a.clone(), b.clone(), U128(2 * N), None));
    assert_eq!(t.balance(&a), 8 * N);
    assert_eq!(t.pass(&a).policy.spent_today.0, 2 * N);
}

#[test]
fn caps_are_checked_before_the_balance() {
    let mut t = T::new();
    let a = t.mint(&alice(), 0);
    let b = t.mint(&bob(), 0);
    t.fails(&alice(), 0, ERR_PER_CALL_CAP, |c| c.pay_agent(a.clone(), b.clone(), U128(3 * N), None));
    t.fails(&alice(), 0, ERR_BALANCE, |c| c.pay_agent(a.clone(), b.clone(), U128(N), None));
}

#[test]
fn spends_past_the_daily_limit_are_refused_until_the_next_day() {
    let mut t = T::new();
    let a = t.mint(&alice(), 20 * N);
    let b = t.mint(&bob(), 0);
    for _ in 0..5 {
        t.call(&alice(), 0, |c| c.pay_agent(a.clone(), b.clone(), U128(2 * N), Some("tip".into())));
    }
    assert_eq!(t.pass(&a).policy.spent_today.0, 10 * N);
    t.fails(&alice(), 0, ERR_DAILY_LIMIT, |c| c.pay_agent(a.clone(), b.clone(), U128(1), None));

    // Most of a day later: same UTC day, still refused.
    let into_day = t.now % DAY;
    t.advance(DAY - into_day - 1);
    t.fails(&alice(), 0, ERR_DAILY_LIMIT, |c| c.pay_agent(a.clone(), b.clone(), U128(1), None));
    // Next day: the view shows nothing spent before any spend, and spending works again.
    t.advance(1);
    assert_eq!(t.pass(&a).policy.spent_today.0, 0);
    t.call(&alice(), 0, |c| c.pay_agent(a.clone(), b.clone(), U128(2 * N), None));
    assert_eq!(t.pass(&a).policy.spent_today.0, 2 * N);
    assert_eq!(t.balance(&a), 8 * N);
    assert_eq!(t.balance(&b), 12 * N);
}

#[test]
fn set_policy_replaces_the_caps_and_keeps_todays_spend() {
    let mut t = T::new();
    let a = t.mint(&alice(), 20 * N);
    let b = t.mint(&bob(), 0);
    t.call(&alice(), 0, |c| c.pay_agent(a.clone(), b.clone(), U128(2 * N), None));
    t.fails(&alice(), 0, "exactly 1 yoctoNEAR", |c| c.set_policy(a.clone(), U128(5 * N), U128(4 * N)));
    t.fails(&bob(), 1, ERR_NOT_PASS_OWNER, |c| c.set_policy(a.clone(), U128(5 * N), U128(4 * N)));
    t.call(&alice(), 1, |c| c.set_policy(a.clone(), U128(5 * N), U128(4 * N)));
    let ev = event("policy_set");
    assert_eq!(
        (ev["per_call_cap"].as_str(), ev["daily_limit"].as_str()),
        (Some("5000000000000000000000000"), Some("4000000000000000000000000"))
    );
    let p = t.pass(&a).policy;
    assert_eq!((p.per_call_cap.0, p.daily_limit.0, p.spent_today.0), (5 * N, 4 * N, 2 * N));
    t.fails(&alice(), 0, ERR_DAILY_LIMIT, |c| c.pay_agent(a.clone(), b.clone(), U128(2 * N + 1), None));
    t.call(&alice(), 0, |c| c.pay_agent(a.clone(), b.clone(), U128(2 * N), None));
}

#[test]
fn rented_link_pays_the_treasury_and_credits_the_rest() {
    let mut t = T::new();
    roster(&mut t);
    let a = t.mint(&alice(), N);
    t.fails(&alice(), 400 * MN - 1, "rental price", |c| {
        c.link_agent(a.clone(), AgentKind::Rented, "".into(), Some("mimir".into()), Some(agent_pk()))
    });
    t.fails(&alice(), N, "roster agent not found", |c| {
        c.link_agent(a.clone(), AgentKind::Rented, "".into(), Some("nobody".into()), Some(agent_pk()))
    });
    t.fails(&alice(), N, "needs a roster_id", |c| c.link_agent(a.clone(), AgentKind::Rented, "".into(), None, None));
    t.fails(&bob(), N, ERR_NOT_PASS_OWNER, |c| {
        c.link_agent(a.clone(), AgentKind::Rented, "".into(), Some("mimir".into()), Some(agent_pk()))
    });

    t.call(&alice(), 500 * MN, |c| {
        c.link_agent(a.clone(), AgentKind::Rented, "".into(), Some("mimir".into()), Some(agent_pk()))
    });
    assert_eq!(t.sent_to(&treasury()), 400 * MN);
    let ev = event("agent_linked");
    assert_eq!(ev["kind"], "rented");
    assert_eq!(ev["name"], "MIMIR");
    assert_eq!(ev["amount"], (400 * MN).to_string());
    assert_eq!(ev["public_key"], agent_pk().to_string().as_str());
    let p = t.pass(&a);
    assert_eq!(p.balance.0, N + 100 * MN);
    assert_eq!(
        p.agent,
        Some(AgentLink {
            kind: AgentKind::Rented,
            name: "MIMIR".into(),
            roster_id: Some("mimir".into()),
            public_key: Some(agent_pk())
        })
    );
    // The JSON form the start app reads.
    let json = near_sdk::serde_json::to_value(&p).unwrap();
    assert_eq!(json["agent"]["kind"], "rented");
    assert_eq!(json["agent"]["roster_id"], "mimir");
    assert_eq!(json["agent"]["public_key"], agent_pk().to_string().as_str());
    assert_eq!(json["balance"], (N + 100 * MN).to_string());
}

#[test]
fn byo_link_takes_exactly_one_yocto_and_unlink_clears_it() {
    let mut t = T::new();
    let a = t.mint(&alice(), N);
    t.fails(&alice(), 0, "exactly 1 yoctoNEAR", |c| {
        c.link_agent(a.clone(), AgentKind::Byo, "SCOUT".into(), None, Some(agent_pk()))
    });
    t.fails(&alice(), 2, "exactly 1 yoctoNEAR", |c| {
        c.link_agent(a.clone(), AgentKind::Byo, "SCOUT".into(), None, Some(agent_pk()))
    });
    t.fails(&alice(), 1, "roster_id is only for rented", |c| {
        c.link_agent(a.clone(), AgentKind::Byo, "SCOUT".into(), Some("mimir".into()), None)
    });
    t.fails(&alice(), 1, "name must be", |c| c.link_agent(a.clone(), AgentKind::Byo, "".into(), None, None));
    t.fails(&alice(), 1, "name must be", |c| c.link_agent(a.clone(), AgentKind::Byo, "x".repeat(65), None, None));
    link_byo(&mut t, &alice(), &a);
    assert_eq!(t.balance(&a), N);
    assert!(t.sent_to(&treasury()) == 0);
    let p = t.pass(&a);
    assert_eq!(near_sdk::serde_json::to_value(&p).unwrap()["agent"]["kind"], "byo");
    assert_eq!(p.agent.unwrap().roster_id, None);

    t.fails(&alice(), 0, "exactly 1 yoctoNEAR", |c| c.unlink_agent(a.clone()));
    t.fails(&bob(), 1, ERR_NOT_PASS_OWNER, |c| c.unlink_agent(a.clone()));
    t.call(&alice(), 1, |c| c.unlink_agent(a.clone()));
    assert_eq!(event("agent_unlinked")["reason"], "owner");
    assert_eq!(t.pass(&a).agent, None);
    t.fails(&alice(), 1, "no agent is linked", |c| c.unlink_agent(a.clone()));
}

#[test]
fn the_link_cannot_change_while_the_pass_is_in_a_season() {
    let mut t = T::new();
    roster(&mut t);
    let a = t.mint(&alice(), 5 * N);
    let b = t.mint(&bob(), 5 * N);
    link_byo(&mut t, &alice(), &a);
    t.create("s1", N);
    t.enter(&alice(), &a, "s1");
    t.enter(&bob(), &b, "s1");
    t.fails(&alice(), 1, ERR_IN_SEASON, |c| c.link_agent(a.clone(), AgentKind::Byo, "X".into(), None, None));
    t.fails(&alice(), N, ERR_IN_SEASON, |c| {
        c.link_agent(a.clone(), AgentKind::Rented, "".into(), Some("mimir".into()), None)
    });
    t.fails(&alice(), 1, ERR_IN_SEASON, |c| c.unlink_agent(a.clone()));
    t.start("s1");
    t.report("s1", 0, vec![kill(Some(&b), &a)]);
    // Dead: out of the season, so the link may change again.
    assert_eq!(t.pass(&a).active_season, None);
    t.call(&alice(), 1, |c| c.unlink_agent(a.clone()));
}

#[test]
fn enter_season_reports_which_key_signed() {
    let mut t = T::new();
    let a = t.mint(&alice(), 5 * N);
    let b = t.mint(&bob(), 5 * N);
    link_byo(&mut t, &alice(), &a);
    link_byo(&mut t, &bob(), &b);
    t.create("s1", N);
    t.call_pk(&alice(), 0, &agent_pk(), |c| c.enter_season(a.clone(), "s1".into()));
    let ev = event("season_entered");
    assert_eq!(ev["signed_by_agent_key"], true);
    assert_eq!(
        (ev["pass_id"].as_str(), ev["season_id"].as_str(), ev["account_id"].as_str()),
        (Some("1"), Some("s1"), Some("alice.near"))
    );
    assert_eq!(ev["amount"], N.to_string());
    t.call_pk(&bob(), 0, &wallet_pk(), |c| c.enter_season(b.clone(), "s1".into()));
    assert_eq!(event("season_entered")["signed_by_agent_key"], false);
    // The owner's own key is held to the same policy.
    let p = t.pass(&b);
    assert_eq!((p.balance.0, p.total_out.0, p.policy.spent_today.0), (4 * N, N, N));
}

#[test]
fn pay_agent_moves_balance_under_the_policy() {
    let mut t = T::new();
    let a = t.mint(&alice(), 5 * N);
    let b = t.mint(&bob(), N);
    link_byo(&mut t, &alice(), &a);

    let memo = "m".repeat(100);
    t.call_pk(&alice(), 0, &agent_pk(), |c| c.pay_agent(a.clone(), b.clone(), U128(N), Some(memo.clone())));
    let ev = event("agent_payment");
    assert_eq!(
        (ev["from_pass"].as_str(), ev["to_pass"].as_str(), ev["account_id"].as_str()),
        (Some("1"), Some("2"), Some("alice.near"))
    );
    assert_eq!(ev["amount"], N.to_string());
    assert_eq!(ev["memo"].as_str().unwrap().chars().count(), 80);
    assert_eq!(ev["signed_by_agent_key"], true);
    let (pa, pb) = (t.pass(&a), t.pass(&b));
    assert_eq!((pa.balance.0, pa.total_out.0), (4 * N, N));
    assert_eq!((pb.balance.0, pb.total_in.0), (2 * N, N));
    assert_eq!(t.view(|c| c.get_activity(a.clone(), None, Some(1)))[0].kind, "pay_sent");
    assert_eq!(t.view(|c| c.get_activity(b.clone(), None, Some(1)))[0].kind, "pay_received");

    t.call_pk(&alice(), 0, &other_pk(), |c| c.pay_agent(a.clone(), b.clone(), U128(1), None));
    assert_eq!(event("agent_payment")["signed_by_agent_key"], false);
    assert_eq!(event("agent_payment")["memo"], "");

    t.fails_pk(&alice(), 0, &agent_pk(), ERR_PER_CALL_CAP, |c| c.pay_agent(a.clone(), b.clone(), U128(3 * N), None));
    t.fails(&alice(), 0, "cannot pay the same pass", |c| c.pay_agent(a.clone(), a.clone(), U128(1), None));
    t.fails(&alice(), 0, ERR_PASS_NOT_FOUND, |c| c.pay_agent(a.clone(), "9".into(), U128(1), None));
    t.fails(&alice(), 0, "amount must be above 0", |c| c.pay_agent(a.clone(), b.clone(), U128(0), None));
    t.fails(&bob(), 0, ERR_NOT_PASS_OWNER, |c| c.pay_agent(a.clone(), b.clone(), U128(1), None));
}

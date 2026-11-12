//! Moving a pass: the balance and record go with it, the agent link and the
//! old owner's rights do not.

use super::*;

fn linked_pass(t: &mut T) -> String {
    let a = t.mint(&alice(), 3 * N);
    t.call(&alice(), 1, |x| x.link_agent(a.clone(), AgentKind::Byo, "SCOUT".into(), None, Some(agent_pk())));
    a
}

#[test]
fn transfer_clears_the_agent_link_and_keeps_the_balance() {
    let mut t = T::new();
    let a = linked_pass(&mut t);
    t.fails(&alice(), 0, "exactly 1 yoctoNEAR", |x| x.nft_transfer(bob(), a.clone(), None, None));
    t.fails(&bob(), 1, ERR_NOT_PASS_OWNER, |x| x.nft_transfer(bob(), a.clone(), None, None));
    t.call(&alice(), 1, |x| x.nft_transfer(bob(), a.clone(), None, Some("gift".into())));
    assert_eq!(event("agent_unlinked")["reason"], "transfer");
    assert!(get_logs().iter().any(|l| l.contains("\"standard\":\"nep171\"") && l.contains("nft_transfer")));

    let p = t.pass(&a);
    assert_eq!(p.owner_id, bob());
    assert_eq!(p.agent, None);
    assert_eq!(p.balance.0, 3 * N);
    assert_eq!(t.view(|x| x.nft_token(a.clone())).unwrap().owner_id, bob());
    assert_eq!(t.view(|x| x.nft_supply_for_owner(alice())).0, 0);
    assert_eq!(t.view(|x| x.get_activity(a.clone(), None, Some(1)))[0].text, "Transferred to bob.near");
}

#[test]
fn the_old_owner_cannot_act_on_the_pass_after_a_transfer() {
    let mut t = T::new();
    let a = linked_pass(&mut t);
    let other = t.mint(&carol(), 0);
    t.create("s1", N);
    t.call(&alice(), 1, |x| x.nft_transfer(bob(), a.clone(), None, None));

    t.fails(&alice(), 1, ERR_NOT_PASS_OWNER, |x| x.withdraw(a.clone(), U128(N)));
    t.fails(&alice(), 0, ERR_NOT_PASS_OWNER, |x| x.enter_season(a.clone(), "s1".into()));
    t.fails_pk(&alice(), 0, &agent_pk(), ERR_NOT_PASS_OWNER, |x| x.enter_season(a.clone(), "s1".into()));
    t.fails_pk(&alice(), 0, &agent_pk(), ERR_NOT_PASS_OWNER, |x| x.pay_agent(a.clone(), other.clone(), U128(1), None));
    t.fails(&alice(), 1, ERR_NOT_PASS_OWNER, |x| {
        x.link_agent(a.clone(), AgentKind::Byo, "X".into(), None, Some(agent_pk()))
    });
    t.fails(&alice(), 1, ERR_NOT_PASS_OWNER, |x| x.unlink_agent(a.clone()));
    t.fails(&alice(), 1, ERR_NOT_PASS_OWNER, |x| x.set_policy(a.clone(), U128(N), U128(N)));
    t.fails(&alice(), 1, ERR_NOT_PASS_OWNER, |x| x.claim_card(a.clone()));
    t.fails(&alice(), 1, ERR_NOT_PASS_OWNER, |x| x.nft_transfer(alice(), a.clone(), None, None));

    // The new owner has all of it.
    t.call(&bob(), 1, |x| x.withdraw(a.clone(), U128(3 * N)));
    assert_eq!(t.sent_to(&bob()), 3 * N);
    assert_eq!(t.balance(&a), 0);
}

#[test]
fn a_pass_moved_mid_season_wins_for_its_new_owner() {
    let mut t = T::new();
    let a = linked_pass(&mut t);
    let b = t.mint(&carol(), 3 * N);
    t.create("s1", N);
    t.call_pk(&alice(), 0, &agent_pk(), |x| x.enter_season(a.clone(), "s1".into()));
    t.enter(&carol(), &b, "s1");
    t.start("s1");
    t.call(&alice(), 1, |x| x.nft_transfer(bob(), a.clone(), None, None));
    assert_eq!(t.pass(&a).active_season.as_deref(), Some("s1"));
    t.fails(&bob(), 1, ERR_IN_SEASON, |x| x.link_agent(a.clone(), AgentKind::Byo, "Y".into(), None, None));
    t.report("s1", 0, vec![kill(Some(&a), &b)]);
    t.settle("s1", Some(&a));
    assert_eq!(t.balance(&a), 2 * N + N / 2 + 3 * N / 2);
    t.call(&bob(), 1, |x| x.withdraw(a.clone(), U128(4 * N)));
    assert_eq!(t.sent_to(&bob()), 4 * N);
}

#[test]
fn transfer_call_clears_the_link_before_calling_the_receiver() {
    let mut t = T::new();
    let a = linked_pass(&mut t);
    let market = acc("market.near");
    t.call(&alice(), 1, |x| {
        let _ = x.nft_transfer_call(market.clone(), a.clone(), None, None, "list".into());
    });
    assert!(get_created_receipts().iter().any(|r| r.receiver_id == market));
    assert_eq!(t.pass(&a).owner_id, market);
    assert_eq!(t.pass(&a).agent, None);
}

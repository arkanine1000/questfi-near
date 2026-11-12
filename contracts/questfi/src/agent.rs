//! The agent link, the spending policy and `pay_agent`.
//!
//! `enter_season` (in `seasons`) and `pay_agent` are the agent methods: the
//! only ones a function-call key needs. Both spend through
//! `Contract::spend`, which applies the policy whichever key signed.

use near_contract_standards::non_fungible_token::TokenId;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, NearToken, Promise, PublicKey};

use crate::events::{amt, emit};
use crate::types::*;
use crate::*;

#[near]
impl Contract {
    /// Links an agent to the pass and records its public key.
    ///
    /// `kind: "rented"`: `roster_id` must name a roster agent and the
    /// attached deposit must cover its price, which goes to the treasury;
    /// anything above the price is credited to the pass balance. An empty
    /// `name` takes the roster agent's name.
    ///
    /// `kind: "byo"`: attach exactly 1 yoctoNEAR.
    ///
    /// Refused while the pass is in a season.
    #[payable]
    pub fn link_agent(
        &mut self,
        pass_id: TokenId,
        kind: AgentKind,
        name: String,
        roster_id: Option<String>,
        public_key: Option<PublicKey>,
    ) {
        let owner = self.assert_pass_owner(&pass_id);
        let mut pass = self.pass(&pass_id);
        check(pass.active_season.is_none(), ERR_IN_SEASON);
        let deposit = env::attached_deposit().as_yoctonear();
        let roster_id = roster_id.filter(|r| !r.is_empty());

        let (name, price, roster_id) = match kind {
            AgentKind::Rented => {
                let rid = roster_id.unwrap_or_else(|| env::panic_str("a rented agent needs a roster_id"));
                let agent = self.roster.get(&rid).unwrap_or_else(|| env::panic_str("roster agent not found"));
                let price = agent.price;
                if deposit < price.max(1) {
                    env::panic_str(&format!("attach the rental price of {price} yoctoNEAR"));
                }
                let name = if name.is_empty() { agent.name.clone() } else { name };
                (name, price, Some(rid))
            }
            AgentKind::Byo => {
                assert_one_yocto();
                check(roster_id.is_none(), "roster_id is only for rented agents");
                (name, 0, None)
            }
        };
        check(!name.is_empty() && name.len() <= MAX_NAME_LEN, "name must be 1 to 64 bytes");

        // The 1 yoctoNEAR of a BYO link stays with the contract.
        let surplus = if kind == AgentKind::Rented { deposit - price } else { 0 };
        self.credit(&mut pass, surplus);
        pass.agent =
            Some(AgentLink { kind, name: name.clone(), roster_id: roster_id.clone(), public_key: public_key.clone() });
        self.save_pass(&pass_id, pass);
        self.push_activity(&pass_id, "link", format!("Agent {name} linked ({})", kind.as_str()), price, price > 0);
        emit(
            "agent_linked",
            json!({
                "pass_id": pass_id,
                "account_id": owner,
                "kind": kind.as_str(),
                "name": name,
                "roster_id": roster_id,
                "public_key": public_key,
                "amount": amt(price),
            }),
        );
        if price > 0 {
            Promise::new(self.treasury_id.clone()).transfer(NearToken::from_yoctonear(price)).detach();
        }
    }

    /// Clears the agent link and its key. Refused while the pass is in a
    /// season. Deleting the key from the owner's account is a separate
    /// transaction.
    #[payable]
    pub fn unlink_agent(&mut self, pass_id: TokenId) {
        assert_one_yocto();
        self.assert_pass_owner(&pass_id);
        let pass = self.pass(&pass_id);
        check(pass.active_season.is_none(), ERR_IN_SEASON);
        check(pass.agent.is_some(), "no agent is linked to this pass");
        self.clear_agent_link(&pass_id, "owner");
    }

    /// Replaces the public key recorded for the linked agent, for an owner
    /// who issued the agent a new key. The rest of the link stays as it is
    /// and no rental is charged. Allowed during a season, since the agent
    /// itself does not change.
    #[payable]
    pub fn set_agent_key(&mut self, pass_id: TokenId, public_key: PublicKey) {
        assert_one_yocto();
        let owner = self.assert_pass_owner(&pass_id);
        let mut pass = self.pass(&pass_id);
        let link = pass.agent.as_mut().unwrap_or_else(|| env::panic_str("no agent is linked to this pass"));
        link.public_key = Some(public_key.clone());
        self.save_pass(&pass_id, pass);
        self.push_activity(&pass_id, "key", "Agent key replaced".to_string(), 0, false);
        emit("agent_key_set", json!({ "pass_id": pass_id, "account_id": owner, "public_key": public_key }));
    }

    /// Replaces the pass's caps. Does not reset what was spent today.
    #[payable]
    pub fn set_policy(&mut self, pass_id: TokenId, per_call_cap: U128, daily_limit: U128) {
        assert_one_yocto();
        let owner = self.assert_pass_owner(&pass_id);
        let mut pass = self.pass(&pass_id);
        pass.policy.per_call_cap = per_call_cap.0;
        pass.policy.daily_limit = daily_limit.0;
        self.save_pass(&pass_id, pass);
        self.push_activity(
            &pass_id,
            "policy",
            format!("Caps set: {} per call, {} a day", amount_text(per_call_cap.0), amount_text(daily_limit.0)),
            0,
            false,
        );
        emit(
            "policy_set",
            json!({
                "pass_id": pass_id,
                "account_id": owner,
                "per_call_cap": amt(per_call_cap.0),
                "daily_limit": amt(daily_limit.0),
            }),
        );
    }

    /// Agent method. Moves `amount` from one pass to another, under the
    /// paying pass's policy. The caller must own `from_pass`; `memo` is cut
    /// to 80 characters.
    pub fn pay_agent(&mut self, from_pass: TokenId, to_pass: TokenId, amount: U128, memo: Option<String>) {
        let owner = self.assert_pass_owner(&from_pass);
        check(from_pass != to_pass, "cannot pay the same pass");
        let amount = amount.0;
        check(amount > 0, "amount must be above 0");
        let mut from = self.pass(&from_pass);
        let mut to = self.pass(&to_pass);
        let by_agent = signed_by_agent_key(&from);
        self.spend(&mut from, amount);
        self.credit(&mut to, amount);
        to.total_in += amount;
        self.save_pass(&from_pass, from);
        self.save_pass(&to_pass, to);

        let memo = truncate_chars(memo.as_deref().unwrap_or(""), MAX_TEXT_CHARS);
        let note = if memo.is_empty() { String::new() } else { format!(": {memo}") };
        self.push_activity(&from_pass, "pay_sent", format!("Paid pass #{to_pass}{note}"), amount, true);
        self.push_activity(&to_pass, "pay_received", format!("Paid by pass #{from_pass}{note}"), amount, false);
        emit(
            "agent_payment",
            json!({
                "from_pass": from_pass,
                "to_pass": to_pass,
                "account_id": owner,
                "amount": amt(amount),
                "memo": memo,
                "signed_by_agent_key": by_agent,
            }),
        );
    }
}

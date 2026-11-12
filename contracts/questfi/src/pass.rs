//! The pass and its money: minting, deposits, withdrawals, the card claim.

use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::TokenMetadata;
use near_contract_standards::non_fungible_token::TokenId;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, NearToken, Promise};

use crate::events::{amt, emit};
use crate::types::*;
use crate::*;

#[near]
impl Contract {
    /// Mints the next pass to the caller. The attached deposit must cover
    /// `mint_storage_fee`; anything above it goes to the pass balance.
    /// Returns the new pass id ("1", "2", ...).
    #[payable]
    pub fn mint_pass(&mut self) -> TokenId {
        let deposit = env::attached_deposit().as_yoctonear();
        let fee = self.config.mint_storage_fee.0;
        if deposit < fee {
            env::panic_str(&format!("attach at least the mint_storage_fee of {fee} yoctoNEAR"));
        }
        let owner = env::predecessor_account_id();
        let pass_id = self.next_pass_id.to_string();
        self.next_pass_id += 1;

        let metadata = TokenMetadata {
            title: Some(format!("QuestFi Agent Pass #{pass_id}")),
            description: Some("An agent pass: an NFT that holds a NEAR balance for the AI agent linked to it.".into()),
            copies: Some(1),
            issued_at: Some(env::block_timestamp_ms().to_string()),
            ..Default::default()
        };
        // No refund: the fee pays for storage and the rest is credited below.
        self.tokens.internal_mint_with_refund(pass_id.clone(), owner.clone(), Some(metadata), None);
        NftMint { owner_id: &owner, token_ids: &[&pass_id], memo: None }.emit();

        let mut pass = Pass {
            balance: 0,
            total_in: 0,
            total_out: 0,
            market_cut: 0,
            xp: 0,
            seasons: 0,
            wins: 0,
            kills: 0,
            agent: None,
            policy: Policy {
                per_call_cap: self.config.default_per_call_cap.0,
                daily_limit: self.config.default_daily_limit.0,
                spent_today: 0,
                day: today(),
            },
            active_season: None,
            claim_ticket: None,
        };
        let surplus = deposit - fee;
        self.credit(&mut pass, surplus);
        self.save_pass(&pass_id, pass);
        self.push_activity(&pass_id, "mint", format!("Pass #{pass_id} minted"), surplus, false);
        emit(
            "pass_minted",
            json!({ "pass_id": pass_id, "account_id": owner, "amount": amt(surplus), "fee": amt(fee) }),
        );
        pass_id
    }

    /// Credits the attached deposit to the pass balance. Anyone may fund
    /// any pass.
    #[payable]
    pub fn deposit(&mut self, pass_id: TokenId) {
        let amount = env::attached_deposit().as_yoctonear();
        check(amount > 0, "attach a deposit");
        let mut pass = self.pass(&pass_id);
        self.credit(&mut pass, amount);
        self.save_pass(&pass_id, pass);
        let from = env::predecessor_account_id();
        self.push_activity(&pass_id, "deposit", format!("Deposit from {from}"), amount, false);
        emit("deposit", json!({ "pass_id": pass_id, "account_id": from, "amount": amt(amount) }));
    }

    /// Sends `amount` of the pass balance to the pass owner. Needs exactly
    /// 1 yoctoNEAR, so only a full-access key can call it.
    #[payable]
    pub fn withdraw(&mut self, pass_id: TokenId, amount: U128) {
        assert_one_yocto();
        let owner = self.assert_pass_owner(&pass_id);
        let amount = amount.0;
        check(amount > 0, "amount must be above 0");
        let mut pass = self.pass(&pass_id);
        self.debit(&mut pass, amount);
        self.save_pass(&pass_id, pass);
        self.push_activity(&pass_id, "withdraw", format!("Withdrawn to {owner}"), amount, true);
        emit("withdraw", json!({ "pass_id": pass_id, "account_id": owner, "amount": amt(amount) }));
        Promise::new(owner).transfer(NearToken::from_yoctonear(amount)).detach();
    }

    /// Burns `claim_burn` from the pass balance for the physical card.
    /// Needs level `claim_level` and no earlier claim. Returns the ticket,
    /// `QF-TCG-<pass_id>-<block_height>`.
    #[payable]
    pub fn claim_card(&mut self, pass_id: TokenId) -> String {
        assert_one_yocto();
        let owner = self.assert_pass_owner(&pass_id);
        let mut pass = self.pass(&pass_id);
        check(pass.claim_ticket.is_none(), "the card for this pass is already claimed");
        check(pass.level(self.config.xp_per_level) >= self.config.claim_level, "the pass is below the claim level");
        let burn = self.config.claim_burn.0;
        self.debit(&mut pass, burn);
        self.burned_total += burn;
        let ticket = format!("QF-TCG-{pass_id}-{}", env::block_height());
        pass.claim_ticket = Some(ticket.clone());
        self.save_pass(&pass_id, pass);
        self.push_activity(&pass_id, "card", format!("Card claimed: {ticket}"), burn, true);
        emit(
            "card_claimed",
            json!({ "pass_id": pass_id, "account_id": owner, "amount": amt(burn), "claim_ticket": ticket }),
        );
        ticket
    }
}

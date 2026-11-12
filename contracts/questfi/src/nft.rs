//! NEP-171 core, NEP-177 metadata and NEP-181 enumeration, delegated to
//! `near_contract_standards`. No approvals (NEP-178): only the owner can
//! move a pass.
//!
//! A transfer clears the pass's agent link, so the old owner's agent key no
//! longer counts as the pass's agent; every owner-gated method checks the
//! token's current owner, so the old owner (and any key on their account)
//! cannot act on the pass at all. The balance and the record travel with
//! the token.
//!
//! Token views fill `metadata.extra` from the pass when they are read, so
//! the token shows its live level, record and balance without a write.

use std::collections::HashMap;

use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{NFTContractMetadata, NonFungibleTokenMetadataProvider};
use near_contract_standards::non_fungible_token::{Token, TokenId};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, near, AccountId, PromiseOrValue};

use crate::*;

#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        self.assert_pass_owner(&token_id);
        self.before_transfer(&token_id, &receiver_id);
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo);
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        assert_one_yocto();
        self.assert_pass_owner(&token_id);
        self.before_transfer(&token_id, &receiver_id);
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id).map(|t| self.live_token(t))
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit).into_iter().map(|t| self.live_token(t)).collect()
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens
            .nft_tokens_for_owner(account_id, from_index, limit)
            .into_iter()
            .map(|t| self.live_token(t))
            .collect()
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.clone()
    }
}

impl Contract {
    /// Runs before the standard transfer, once the caller is known to be
    /// the owner: the agent link does not travel with the token.
    fn before_transfer(&mut self, token_id: &TokenId, receiver_id: &AccountId) {
        self.clear_agent_link(token_id, "transfer");
        self.push_activity(token_id, "transfer", format!("Transferred to {receiver_id}"), 0, false);
    }

    /// The token with `metadata.extra` set to the pass's live state.
    fn live_token(&self, mut token: Token) -> Token {
        if let (Some(pass), Some(metadata)) = (self.passes.get(&token.token_id), token.metadata.as_mut()) {
            let extra = json!({
                "level": pass.level(self.config.xp_per_level),
                "xp": pass.xp,
                "seasons": pass.seasons,
                "wins": pass.wins,
                "kills": pass.kills,
                "balance": U128(pass.balance),
                "claim_ticket": pass.claim_ticket,
            });
            metadata.extra = Some(extra.to_string());
        }
        token
    }
}

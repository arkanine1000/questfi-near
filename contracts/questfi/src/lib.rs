//! QuestFi agent passes.
//!
//! An agent pass is an NFT (NEP-171) that holds a NEAR balance inside this
//! contract. Its owner links an AI agent to it and gives that agent a
//! function-call access key on the owner's account, limited to the agent
//! methods (`enter_season`, `pay_agent`). A function-call key cannot attach a
//! deposit, so it can never reach `withdraw` or any other method that needs
//! 1 yoctoNEAR; the agent methods spend only from the pass balance, under
//! the owner's per-call and daily caps.
//!
//! Seasons are run by operators (game servers): they open a season, report
//! kills and loot, and settle it. Stakes sit in the season's pot; kills pay
//! a bounty from the victim's stake to the killer; the winner takes what is
//! left. Spectators bet on entrants in a parimutuel market, and the winning
//! pass takes a cut of the losing side.
//!
//! The operator is trusted to report what happened in the game. The
//! contract enforces who may report, the money maths and the agent's caps.
//!
//! Modules: `types` (state and JSON shapes), `pass` (minting, deposits,
//! withdrawals, card claims), `agent` (agent link, spending policy,
//! `pay_agent`), `seasons` (operator lifecycle and `enter_season`),
//! `market` (bets and payouts), `views`, `nft` (NEP-171/177/181) and
//! `events` (NEP-297 logs).

use near_contract_standards::non_fungible_token::metadata::{NFTContractMetadata, NFT_METADATA_SPEC};
use near_contract_standards::non_fungible_token::{NonFungibleToken, TokenId};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

pub mod agent;
pub mod events;
pub mod market;
pub mod nft;
pub mod pass;
pub mod seasons;
pub mod types;
pub mod views;

#[cfg(test)]
mod tests;

use events::emit;
use types::*;

pub const ERR_PASS_NOT_FOUND: &str = "pass not found";
pub const ERR_NOT_PASS_OWNER: &str = "only the pass owner can do this";
pub const ERR_NOT_OWNER: &str = "only the contract owner can do this";
pub const ERR_NOT_OPERATOR: &str = "only an operator can do this";
pub const ERR_SEASON_NOT_FOUND: &str = "season not found";
pub const ERR_PER_CALL_CAP: &str = "POLICY: over per-call cap";
pub const ERR_DAILY_LIMIT: &str = "POLICY: over daily limit";
pub const ERR_BALANCE: &str = "insufficient pass balance";
pub const ERR_IN_SEASON: &str = "the agent link cannot change while the pass is in a season";

pub(crate) fn check(cond: bool, msg: &str) {
    require!(cond, msg);
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    NftOwners,
    NftMetadata,
    NftEnumeration,
    Operators,
    Passes,
    Activity,
    Seasons,
    Bets,
    Roster,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub(crate) owner_id: AccountId,
    /// Receives rental fees, the house cut and the pots of seasons settled
    /// without a winner.
    pub(crate) treasury_id: AccountId,
    pub(crate) operators: IterableSet<AccountId>,
    pub(crate) config: Config,
    pub(crate) tokens: NonFungibleToken,
    pub(crate) metadata: NFTContractMetadata,
    pub(crate) next_pass_id: u64,
    pub(crate) passes: LookupMap<TokenId, Pass>,
    /// Newest first, at most `config.activity_cap` per pass.
    pub(crate) activity: LookupMap<TokenId, Vec<Activity>>,
    pub(crate) seasons: IterableMap<SeasonId, Season>,
    pub(crate) bets: LookupMap<(SeasonId, AccountId), Vec<BetEntry>>,
    pub(crate) roster: IterableMap<String, RosterAgent>,
    /// NEAR burned by card claims. Nothing can withdraw it.
    pub(crate) burned_total: u128,
    /// Running sums the contract owes, kept in step with every change.
    pub(crate) pass_balances: u128,
    pub(crate) season_pots: u128,
    pub(crate) bets_owed: u128,
}

#[near]
impl Contract {
    /// `config: None` means the defaults.
    #[init]
    #[private]
    pub fn new(owner_id: AccountId, treasury_id: AccountId, config: Option<Config>) -> Self {
        let config = config.unwrap_or_default();
        config.assert_valid();
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "QuestFi Agent Pass".to_string(),
            symbol: "QFPASS".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };
        metadata.assert_valid();
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::NftOwners,
                owner_id.clone(),
                Some(StorageKey::NftMetadata),
                Some(StorageKey::NftEnumeration),
                None::<StorageKey>,
            ),
            owner_id,
            treasury_id,
            operators: IterableSet::new(StorageKey::Operators),
            config,
            metadata,
            next_pass_id: 1,
            passes: LookupMap::new(StorageKey::Passes),
            activity: LookupMap::new(StorageKey::Activity),
            seasons: IterableMap::new(StorageKey::Seasons),
            bets: LookupMap::new(StorageKey::Bets),
            roster: IterableMap::new(StorageKey::Roster),
            burned_total: 0,
            pass_balances: 0,
            season_pots: 0,
            bets_owed: 0,
        }
    }

    // ---------------------------------------------------------- admin

    /// Replaces every config value. Contract owner only.
    pub fn set_config(&mut self, config: Config) {
        self.assert_owner();
        config.assert_valid();
        self.config = config;
    }

    pub fn add_operator(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.operators.insert(account_id);
    }

    pub fn remove_operator(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.operators.remove(&account_id);
    }

    /// Adds or edits a house agent for rent. `price` is paid to the treasury
    /// on each `link_agent`.
    pub fn set_roster(&mut self, roster_id: String, name: String, blurb: String, price: U128) {
        self.assert_owner();
        check(!roster_id.is_empty() && roster_id.len() <= MAX_ID_LEN, "roster_id must be 1 to 64 bytes");
        check(!name.is_empty() && name.len() <= MAX_NAME_LEN, "name must be 1 to 64 bytes");
        check(blurb.len() <= MAX_BLURB_LEN, "blurb is longer than 280 bytes");
        self.roster.insert(roster_id, RosterAgent { name, blurb, price: price.0 });
    }
}

// -------------------------------------------------------------- helpers

impl Contract {
    pub(crate) fn assert_owner(&self) {
        check(env::predecessor_account_id() == self.owner_id, ERR_NOT_OWNER);
    }

    pub(crate) fn assert_operator(&self) {
        check(self.operators.contains(&env::predecessor_account_id()), ERR_NOT_OPERATOR);
    }

    /// The pass's current NFT owner.
    pub(crate) fn owner_of(&self, pass_id: &TokenId) -> AccountId {
        self.tokens.owner_by_id.get(pass_id).unwrap_or_else(|| env::panic_str(ERR_PASS_NOT_FOUND))
    }

    /// Panics unless the caller is the pass's current owner. Returns it.
    pub(crate) fn assert_pass_owner(&self, pass_id: &TokenId) -> AccountId {
        let owner = self.owner_of(pass_id);
        check(env::predecessor_account_id() == owner, ERR_NOT_PASS_OWNER);
        owner
    }

    pub(crate) fn pass(&self, pass_id: &TokenId) -> Pass {
        self.passes.get(pass_id).cloned().unwrap_or_else(|| env::panic_str(ERR_PASS_NOT_FOUND))
    }

    pub(crate) fn save_pass(&mut self, pass_id: &TokenId, pass: Pass) {
        self.passes.insert(pass_id.clone(), pass);
    }

    pub(crate) fn season(&self, season_id: &SeasonId) -> Season {
        self.seasons.get(season_id).cloned().unwrap_or_else(|| env::panic_str(ERR_SEASON_NOT_FOUND))
    }

    pub(crate) fn save_season(&mut self, season_id: &SeasonId, season: Season) {
        self.seasons.insert(season_id.clone(), season);
    }

    /// Adds to a pass balance and to the running sum of balances.
    pub(crate) fn credit(&mut self, pass: &mut Pass, amount: u128) {
        pass.balance += amount;
        self.pass_balances += amount;
    }

    /// Takes from a pass balance and from the running sum of balances.
    pub(crate) fn debit(&mut self, pass: &mut Pass, amount: u128) {
        check(amount <= pass.balance, ERR_BALANCE);
        pass.balance -= amount;
        self.pass_balances -= amount;
    }

    /// Every spend an agent method makes goes through here. Caps are
    /// checked before the balance, so a refusal names the cap.
    pub(crate) fn spend(&mut self, pass: &mut Pass, amount: u128) {
        let today = today();
        if pass.policy.day != today {
            pass.policy.day = today;
            pass.policy.spent_today = 0;
        }
        check(amount <= pass.policy.per_call_cap, ERR_PER_CALL_CAP);
        let after = pass.policy.spent_today.checked_add(amount);
        check(after.is_some_and(|s| s <= pass.policy.daily_limit), ERR_DAILY_LIMIT);
        check(amount <= pass.balance, ERR_BALANCE);
        self.debit(pass, amount);
        pass.total_out += amount;
        pass.policy.spent_today += amount;
    }

    pub(crate) fn push_activity(&mut self, pass_id: &TokenId, kind: &str, text: String, amount: u128, negative: bool) {
        let cap = self.config.activity_cap as usize;
        let mut list = self.activity.get(pass_id).cloned().unwrap_or_default();
        list.insert(
            0,
            Activity {
                kind: kind.to_string(),
                text,
                amount: U128(amount),
                negative,
                timestamp_ms: env::block_timestamp_ms(),
            },
        );
        list.truncate(cap);
        self.activity.insert(pass_id.clone(), list);
    }

    /// Clears the pass's agent link, e.g. after a transfer.
    pub(crate) fn clear_agent_link(&mut self, pass_id: &TokenId, reason: &str) {
        let mut pass = self.pass(pass_id);
        if let Some(link) = pass.agent.take() {
            self.save_pass(pass_id, pass);
            self.push_activity(pass_id, "unlink", format!("Agent {} unlinked: {reason}", link.name), 0, false);
            emit(
                "agent_unlinked",
                json!({ "pass_id": pass_id, "account_id": self.owner_of(pass_id), "reason": reason }),
            );
        }
    }
}

/// Whether the transaction was signed with the agent key recorded on `pass`.
pub(crate) fn signed_by_agent_key(pass: &Pass) -> bool {
    match pass.agent.as_ref().and_then(|a| a.public_key.as_ref()) {
        Some(pk) => *pk == env::signer_account_pk(),
        None => false,
    }
}

pub(crate) fn today() -> u64 {
    env::block_timestamp() / NANOS_PER_DAY
}

/// The first `max` characters of `s`, never splitting a character.
pub(crate) fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

pub(crate) fn amount_text(v: u128) -> String {
    // Whole and thousandths of a NEAR, for activity text only.
    let whole = v / ONE_NEAR;
    let milli = (v % ONE_NEAR) / MILLI_NEAR;
    format!("{whole}.{milli:03} NEAR")
}

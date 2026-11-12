//! Read-only methods.

use near_contract_standards::non_fungible_token::TokenId;
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId};

use crate::types::*;
use crate::*;

#[near]
impl Contract {
    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_operators(&self) -> Vec<AccountId> {
        self.operators.iter().cloned().collect()
    }

    pub fn get_pass(&self, pass_id: TokenId) -> Option<PassView> {
        let pass = self.passes.get(&pass_id)?;
        let owner_id = self.tokens.owner_by_id.get(&pass_id)?;
        Some(PassView {
            token_id: pass_id,
            owner_id,
            balance: U128(pass.balance),
            total_in: U128(pass.total_in),
            total_out: U128(pass.total_out),
            market_cut: U128(pass.market_cut),
            xp: pass.xp,
            level: pass.level(self.config.xp_per_level),
            xp_per_level: self.config.xp_per_level,
            seasons: pass.seasons,
            wins: pass.wins,
            kills: pass.kills,
            agent: pass.agent.clone(),
            policy: PolicyView {
                per_call_cap: U128(pass.policy.per_call_cap),
                daily_limit: U128(pass.policy.daily_limit),
                spent_today: U128(pass.policy.spent_on(today())),
            },
            active_season: pass.active_season.clone(),
            claim_ticket: pass.claim_ticket.clone(),
        })
    }

    /// Newest first. `from_index` defaults to 0, `limit` to all kept.
    pub fn get_activity(&self, pass_id: TokenId, from_index: Option<u32>, limit: Option<u32>) -> Vec<Activity> {
        let list = match self.activity.get(&pass_id) {
            Some(l) => l,
            None => return Vec::new(),
        };
        let limit = limit.unwrap_or(u32::MAX) as usize;
        list.iter().skip(from_index.unwrap_or(0) as usize).take(limit).cloned().collect()
    }

    pub fn get_roster(&self) -> Vec<RosterView> {
        self.roster
            .iter()
            .map(|(id, a)| RosterView {
                roster_id: id.clone(),
                name: a.name.clone(),
                blurb: a.blurb.clone(),
                price: U128(a.price),
            })
            .collect()
    }

    pub fn get_season(&self, season_id: SeasonId) -> Option<SeasonView> {
        let s = self.seasons.get(&season_id)?;
        let entrants = s
            .entrants
            .iter()
            .map(|e| EntrantView {
                pass_id: e.pass_id.clone(),
                name: self
                    .passes
                    .get(&e.pass_id)
                    .and_then(|p| p.agent.as_ref())
                    .map(|a| a.name.clone())
                    .unwrap_or_default(),
                at_risk: U128(e.at_risk),
                alive: e.alive,
            })
            .collect();
        Some(SeasonView {
            season_id,
            status: s.status,
            entry_stake: U128(s.entry_stake),
            pot: U128(s.pot),
            winner: s.winner.clone(),
            market_open: s.market_open,
            next_seq: s.next_seq,
            entrants,
        })
    }

    pub fn get_market(&self, season_id: SeasonId) -> Option<MarketView> {
        let s = self.seasons.get(&season_id)?;
        Some(MarketView {
            open: s.market_open,
            pool: U128(s.bet_pool),
            totals: s
                .entrants
                .iter()
                .map(|e| PassAmount { pass_id: e.pass_id.clone(), amount: U128(e.bets) })
                .collect(),
            settled: s.status == SeasonStatus::Settled,
            winner: s.winner.clone(),
            status: s.status,
            refund: !s.is_live() && s.refund_bets,
            winner_bets: U128(s.winner_bets),
            distributable: U128(s.distributable),
        })
    }

    /// The account's bets on a season. `claimable` is null until the season
    /// is settled or cancelled, then what `claim_winnings` would pay.
    pub fn get_bets(&self, season_id: SeasonId, account_id: AccountId) -> BetsView {
        let stakes = self.bets.get(&(season_id.clone(), account_id)).cloned().unwrap_or_default();
        let claimable = self.seasons.get(&season_id).filter(|s| !s.is_live()).map(|s| U128(s.payout(&stakes)));
        BetsView {
            bets: stakes.iter().map(|b| PassAmount { pass_id: b.pass_id.clone(), amount: U128(b.amount) }).collect(),
            claimable,
        }
    }

    /// What the contract owes against what it holds.
    pub fn get_accounting(&self) -> AccountingView {
        let owed = self.pass_balances + self.season_pots + self.bets_owed + self.burned_total;
        let balance = env::account_balance().as_yoctonear();
        let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        AccountingView {
            pass_balances: U128(self.pass_balances),
            season_pots: U128(self.season_pots),
            bets_owed: U128(self.bets_owed),
            burned_total: U128(self.burned_total),
            owed_total: U128(owed),
            account_balance: U128(balance),
            storage_reserved: U128(storage),
            free_balance: U128(balance.saturating_sub(owed).saturating_sub(storage)),
            solvent: balance >= owed + storage,
        }
    }
}

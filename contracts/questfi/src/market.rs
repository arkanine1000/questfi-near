//! The spectator market: parimutuel bets on a season's entrants.
//!
//! At settle, with P the pool, W the bets on the winner and L = P - W:
//! `agent_cut = L * market_agent_cut_bps / 10000` goes to the winning pass,
//! `house_cut = L * market_house_bps / 10000` to the treasury, and
//! `distributable = P - agent_cut - house_cut` is shared by the winner's
//! backers: `payout = stake_on_winner * distributable / W`, floored. The
//! rounding dust stays in the contract. With no winner, nobody on the
//! winner, or a cancel, every bet is paid back in full.

use near_contract_standards::non_fungible_token::TokenId;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, NearToken, Promise};

use crate::events::{amt, emit};
use crate::types::*;
use crate::*;

#[near]
impl Contract {
    /// Bets the attached deposit on an entrant. The market must be open and
    /// the deposit at least `min_bet`.
    #[payable]
    pub fn place_bet(&mut self, season_id: SeasonId, pass_id: TokenId) {
        let amount = env::attached_deposit().as_yoctonear();
        let min_bet = self.config.min_bet.0;
        if amount == 0 || amount < min_bet {
            env::panic_str(&format!("attach at least the min_bet of {min_bet} yoctoNEAR"));
        }
        let mut season = self.season(&season_id);
        check(season.is_live() && season.market_open, "the market is closed");
        let i = season.entrant_index(&pass_id).unwrap_or_else(|| env::panic_str("the pass is not an entrant"));
        season.entrants[i].bets += amount;
        season.bet_pool += amount;
        self.bets_owed += amount;
        self.save_season(&season_id, season);

        let bettor = env::predecessor_account_id();
        let key = (season_id.clone(), bettor.clone());
        let mut stakes = self.bets.get(&key).cloned().unwrap_or_default();
        match stakes.iter_mut().find(|b| b.pass_id == pass_id) {
            Some(b) => b.amount += amount,
            None => stakes.push(BetEntry { pass_id: pass_id.clone(), amount }),
        }
        self.bets.insert(key, stakes);
        emit(
            "bet_placed",
            json!({ "season_id": season_id, "pass_id": pass_id, "account_id": bettor, "amount": amt(amount) }),
        );
    }

    /// Pays the caller what their bets on this season are owed, once it is
    /// settled or cancelled, and deletes their bet record so it cannot be
    /// claimed twice. A record with only losing bets pays 0. Accepts no
    /// deposit or 1 yoctoNEAR (returned with the payout). Returns the payout.
    #[payable]
    pub fn claim_winnings(&mut self, season_id: SeasonId) -> U128 {
        let deposit = env::attached_deposit().as_yoctonear();
        check(deposit <= 1, "attach no deposit, or exactly 1 yoctoNEAR");
        let mut season = self.season(&season_id);
        check(!season.is_live(), "the season is not settled or cancelled yet");
        let bettor = env::predecessor_account_id();
        let key = (season_id.clone(), bettor.clone());
        let stakes = self.bets.remove(&key).unwrap_or_else(|| env::panic_str("nothing to claim"));
        let payout = season.payout(&stakes);
        season.market_paid += payout;
        self.bets_owed -= payout;
        self.save_season(&season_id, season);
        emit("winnings_claimed", json!({ "season_id": season_id, "account_id": bettor, "amount": amt(payout) }));
        let send = payout + deposit;
        if send > 0 {
            Promise::new(bettor).transfer(NearToken::from_yoctonear(send)).detach();
        }
        U128(payout)
    }
}

//! Seasons: created, started, reported on and settled by an operator, and
//! entered by passes through the agent method `enter_season`.
//!
//! Invariant: `season.pot` is the sum of its entrants' `at_risk`, and the
//! running sum `season_pots` is the sum of the pots of open and running
//! seasons.

use near_contract_standards::non_fungible_token::TokenId;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, NearToken, Promise};

use crate::events::{amt, emit};
use crate::types::*;
use crate::*;

#[near]
impl Contract {
    /// Opens a season for entry and betting. Operator only. `season_id` is
    /// the game server's world id, 1 to 64 bytes.
    pub fn create_season(&mut self, season_id: SeasonId, entry_stake: U128) {
        self.assert_operator();
        check(!season_id.is_empty() && season_id.len() <= MAX_ID_LEN, "season_id must be 1 to 64 bytes");
        check(!self.seasons.contains_key(&season_id), "the season already exists");
        check(entry_stake.0 > 0, "entry_stake must be above 0");
        let season = Season {
            status: SeasonStatus::Open,
            entry_stake: entry_stake.0,
            entrants: Vec::new(),
            pot: 0,
            market_open: true,
            bet_pool: 0,
            winner: None,
            winner_bets: 0,
            distributable: 0,
            refund_bets: false,
            market_paid: 0,
            next_seq: 0,
        };
        self.save_season(&season_id, season);
        emit(
            "season_created",
            json!({
                "season_id": season_id,
                "account_id": env::predecessor_account_id(),
                "entry_stake": amt(entry_stake.0),
            }),
        );
    }

    /// Agent method. Stakes `entry_stake` from the pass balance into the
    /// season's pot, under the pass's policy. The caller must own the pass;
    /// the season must be open and not full, and the pass not in a season.
    pub fn enter_season(&mut self, pass_id: TokenId, season_id: SeasonId) {
        let owner = self.assert_pass_owner(&pass_id);
        let mut season = self.season(&season_id);
        check(season.status == SeasonStatus::Open, "the season is not open for entry");
        let mut pass = self.pass(&pass_id);
        check(pass.active_season.is_none(), "the pass is already in a season");
        check(season.entrant_index(&pass_id).is_none(), "the pass has already entered this season");
        check((season.entrants.len() as u32) < self.config.max_entrants, "the season is full");
        let by_agent = signed_by_agent_key(&pass);
        let stake = season.entry_stake;
        self.spend(&mut pass, stake);

        season.entrants.push(Entrant { pass_id: pass_id.clone(), at_risk: stake, alive: true, bets: 0 });
        season.pot += stake;
        self.season_pots += stake;
        pass.active_season = Some(season_id.clone());
        pass.xp = pass.xp.saturating_add(self.config.xp_enter);
        pass.seasons += 1;
        self.save_pass(&pass_id, pass);
        self.save_season(&season_id, season);
        self.push_activity(&pass_id, "enter", format!("Entered season {season_id}"), stake, true);
        emit(
            "season_entered",
            json!({
                "pass_id": pass_id,
                "season_id": season_id,
                "account_id": owner,
                "amount": amt(stake),
                "signed_by_agent_key": by_agent,
            }),
        );
    }

    /// `open` -> `running`: no more entrants. Operator only.
    pub fn start_season(&mut self, season_id: SeasonId) {
        self.assert_operator();
        let mut season = self.season(&season_id);
        check(season.status == SeasonStatus::Open, "the season is not open");
        season.status = SeasonStatus::Running;
        let entrants = season.entrants.len() as u32;
        self.save_season(&season_id, season);
        emit("season_started", json!({ "season_id": season_id, "entrants": entrants }));
    }

    /// Closes the market to new bets. Operator only. Calling it on a closed
    /// market changes nothing.
    pub fn lock_market(&mut self, season_id: SeasonId) {
        self.assert_operator();
        let mut season = self.season(&season_id);
        if season.market_open {
            season.market_open = false;
            self.save_season(&season_id, season);
        }
    }

    /// Applies a batch of game events. Operator only.
    ///
    /// Batches are numbered from 0. A batch with `seq` below the season's
    /// `next_seq` was applied already and is ignored, so a retry is safe; a
    /// `seq` above it is refused. An event that cannot be applied is
    /// skipped with an `event_skipped` log, and the rest of the batch still
    /// applies. Returns what happened and the next `seq` expected.
    pub fn report_events(&mut self, season_id: SeasonId, seq: u64, events: Vec<Value>) -> ReportResult {
        self.assert_operator();
        let mut season = self.season(&season_id);
        if seq < season.next_seq {
            return ReportResult { applied: 0, skipped: 0, next_seq: season.next_seq };
        }
        check(season.status == SeasonStatus::Running, "the season is not running");
        if seq > season.next_seq {
            env::panic_str(&format!("seq {seq} is ahead of next_seq {}", season.next_seq));
        }
        check(events.len() as u32 <= self.config.max_events_per_call, "too many events in one call");

        let (mut applied, mut skipped) = (0u32, 0u32);
        for (index, raw) in events.into_iter().enumerate() {
            let outcome = match serde_json::from_value::<GameEvent>(raw) {
                Ok(GameEvent::Kill { killer, victim }) => self.apply_kill(&season_id, &mut season, killer, victim),
                Ok(GameEvent::Loot { pass, xp, text }) => self.apply_loot(&season_id, &season, pass, xp, text),
                Err(_) => Err("malformed event"),
            };
            match outcome {
                Ok(()) => applied += 1,
                Err(reason) => {
                    skipped += 1;
                    emit(
                        "event_skipped",
                        json!({ "season_id": season_id, "seq": seq, "index": index, "reason": reason }),
                    );
                }
            }
        }
        season.next_seq += 1;
        let next_seq = season.next_seq;
        self.save_season(&season_id, season);
        ReportResult { applied, skipped, next_seq }
    }

    /// Ends a running season. Operator only.
    ///
    /// `winner_pass` must be an entrant, alive or dead; its pass takes the
    /// whole remaining pot and, if anyone backed it, the agent cut of the
    /// losing bets. With no winner the pot goes to the treasury and every
    /// bet is refundable in full, as it is when nobody backed the winner.
    pub fn settle_season(&mut self, season_id: SeasonId, winner_pass: Option<TokenId>) {
        self.assert_operator();
        let mut season = self.season(&season_id);
        check(season.status == SeasonStatus::Running, "the season is not running");
        let winner = winner_pass.map(|w| {
            let i = season.entrant_index(&w).unwrap_or_else(|| env::panic_str("the winner is not an entrant"));
            (i, w)
        });

        let pot = season.pot;
        for e in season.entrants.iter_mut() {
            e.at_risk = 0;
        }
        season.pot = 0;
        self.season_pots -= pot;

        // Market: P is the pool, W the bets on the winner, L = P - W.
        let pool = season.bet_pool;
        let winner_bets = winner.as_ref().map(|(i, _)| season.entrants[*i].bets).unwrap_or(0);
        let (mut agent_cut, mut house_cut) = (0, 0);
        if winner.is_some() && winner_bets > 0 {
            let losing = pool - winner_bets;
            agent_cut = mul_div(losing, self.config.market_agent_cut_bps as u128, BPS);
            house_cut = mul_div(losing, self.config.market_house_bps as u128, BPS);
            season.refund_bets = false;
            season.distributable = pool - agent_cut - house_cut;
        } else {
            season.refund_bets = true;
            season.distributable = pool;
        }
        season.winner_bets = winner_bets;
        self.bets_owed -= agent_cut + house_cut;

        let mut to_treasury = house_cut;
        match &winner {
            Some((_, wid)) => {
                let mut wp = self.pass(wid);
                self.credit(&mut wp, pot + agent_cut);
                wp.total_in += pot + agent_cut;
                wp.market_cut += agent_cut;
                wp.wins += 1;
                wp.xp = wp.xp.saturating_add(self.config.xp_win);
                self.save_pass(wid, wp);
                self.push_activity(wid, "win", format!("Won season {season_id}"), pot, false);
                if agent_cut > 0 {
                    self.push_activity(
                        wid,
                        "market_cut",
                        format!("Market cut from season {season_id}"),
                        agent_cut,
                        false,
                    );
                }
            }
            None => to_treasury += pot,
        }

        season.status = SeasonStatus::Settled;
        season.market_open = false;
        season.winner = winner.as_ref().map(|(_, w)| w.clone());
        self.release_entrants(&season_id, &season);
        let distributable = season.distributable;
        let winner_id = season.winner.clone();
        self.save_season(&season_id, season);
        emit(
            "season_settled",
            json!({
                "season_id": season_id,
                "winner": winner_id,
                "amount": amt(pot),
                "pool": amt(pool),
                "winner_bets": amt(winner_bets),
                "agent_cut": amt(agent_cut),
                "house_cut": amt(house_cut),
                "distributable": amt(distributable),
            }),
        );
        if to_treasury > 0 {
            Promise::new(self.treasury_id.clone()).transfer(NearToken::from_yoctonear(to_treasury)).detach();
        }
    }

    /// Calls off an open or running season, for a server crash or a world
    /// deleted early. Operator only. Each entrant's remaining `at_risk` goes
    /// back to its pass (and comes off its `total_out`); every bet becomes
    /// refundable in full. Kill bounties already paid stay paid.
    pub fn cancel_season(&mut self, season_id: SeasonId) {
        self.assert_operator();
        let mut season = self.season(&season_id);
        check(season.is_live(), "the season is already settled or cancelled");
        let mut refunded = 0;
        for i in 0..season.entrants.len() {
            let refund = season.entrants[i].at_risk;
            season.entrants[i].at_risk = 0;
            if refund == 0 {
                continue;
            }
            let pid = season.entrants[i].pass_id.clone();
            let mut p = self.pass(&pid);
            self.credit(&mut p, refund);
            p.total_out = p.total_out.saturating_sub(refund);
            self.save_pass(&pid, p);
            self.push_activity(&pid, "refund", format!("Season {season_id} cancelled, stake returned"), refund, false);
            refunded += refund;
        }
        self.season_pots -= season.pot;
        season.pot = 0;
        season.status = SeasonStatus::Cancelled;
        season.market_open = false;
        season.refund_bets = true;
        season.distributable = season.bet_pool;
        self.release_entrants(&season_id, &season);
        let pool = season.bet_pool;
        self.save_season(&season_id, season);
        emit("season_cancelled", json!({ "season_id": season_id, "amount": amt(refunded), "pool": amt(pool) }));
    }
}

impl Contract {
    /// Clears `active_season` on every entrant still in this season.
    fn release_entrants(&mut self, season_id: &SeasonId, season: &Season) {
        for e in &season.entrants {
            let mut p = self.pass(&e.pass_id);
            if p.active_season.as_ref() == Some(season_id) {
                p.active_season = None;
                self.save_pass(&e.pass_id, p);
            }
        }
    }

    fn missing_reason(&self, pass_id: &TokenId, role: &'static str) -> &'static str {
        if !self.passes.contains_key(pass_id) {
            "unknown pass"
        } else {
            role
        }
    }

    fn apply_kill(
        &mut self,
        season_id: &SeasonId,
        season: &mut Season,
        killer: Option<TokenId>,
        victim: TokenId,
    ) -> Result<(), &'static str> {
        let vi = match season.entrant_index(&victim) {
            Some(i) => i,
            None => return Err(self.missing_reason(&victim, "victim is not an entrant")),
        };
        if !season.entrants[vi].alive {
            return Err("victim is already dead");
        }
        if killer.as_ref() == Some(&victim) {
            return Err("killer equals victim");
        }
        // A killer that is not an entrant counts as a monster: no bounty.
        let ki = killer.as_ref().and_then(|k| season.entrant_index(k));

        let mut bounty = 0;
        let mut killer_id = None;
        if let Some(ki) = ki {
            bounty = mul_div(season.entrants[vi].at_risk, self.config.kill_bounty_bps as u128, BPS);
            season.entrants[vi].at_risk -= bounty;
            season.pot -= bounty;
            self.season_pots -= bounty;
            let kid = season.entrants[ki].pass_id.clone();
            let mut kp = self.pass(&kid);
            self.credit(&mut kp, bounty);
            kp.total_in += bounty;
            kp.kills += 1;
            kp.xp = kp.xp.saturating_add(self.config.xp_kill);
            self.save_pass(&kid, kp);
            self.push_activity(&kid, "kill", format!("Killed pass #{victim} in {season_id}"), bounty, false);
            killer_id = Some(kid);
        }

        season.entrants[vi].alive = false;
        let mut vp = self.pass(&victim);
        if vp.active_season.as_ref() == Some(season_id) {
            vp.active_season = None;
        }
        self.save_pass(&victim, vp);
        let by = match &killer_id {
            Some(k) => format!("pass #{k}"),
            None => "a monster".to_string(),
        };
        // Amount 0: the stake left the balance at entry and shows there; the
        // bounty is on the killer's line.
        self.push_activity(&victim, "death", format!("Killed by {by} in {season_id}"), 0, false);
        emit("kill", json!({ "season_id": season_id, "killer": killer_id, "victim": victim, "amount": amt(bounty) }));
        Ok(())
    }

    fn apply_loot(
        &mut self,
        season_id: &SeasonId,
        season: &Season,
        pass_id: TokenId,
        xp: u32,
        text: String,
    ) -> Result<(), &'static str> {
        if season.entrant_index(&pass_id).is_none() {
            return Err(self.missing_reason(&pass_id, "pass is not an entrant"));
        }
        let xp = xp.min(self.config.xp_loot_max);
        let text = truncate_chars(&text, MAX_TEXT_CHARS);
        let mut p = self.pass(&pass_id);
        p.xp = p.xp.saturating_add(xp);
        self.save_pass(&pass_id, p);
        let line = if text.is_empty() { format!("Loot in {season_id}: {xp} XP") } else { text.clone() };
        self.push_activity(&pass_id, "loot", line, 0, false);
        emit("loot", json!({ "season_id": season_id, "pass_id": pass_id, "xp": xp, "text": text }));
        Ok(())
    }
}

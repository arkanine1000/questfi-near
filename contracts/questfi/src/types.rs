//! Stored state and the JSON shapes that cross the contract boundary.
//!
//! Amounts are yoctoNEAR: `u128` in storage, `U128` (a base-10 string) in
//! JSON. Pass and season ids are strings.

use near_contract_standards::non_fungible_token::TokenId;
use near_sdk::json_types::U128;
use near_sdk::{near, AccountId, PublicKey};

pub type SeasonId = String;

pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const MILLI_NEAR: u128 = ONE_NEAR / 1_000;
pub const BPS: u128 = 10_000;
pub const NANOS_PER_DAY: u64 = 86_400_000_000_000;

/// Longest season id, agent name, roster id or blurb accepted.
pub const MAX_ID_LEN: usize = 64;
pub const MAX_NAME_LEN: usize = 64;
pub const MAX_BLURB_LEN: usize = 280;
/// Loot text and payment memos are cut to this many characters.
pub const MAX_TEXT_CHARS: usize = 80;

/// Every tunable number. Set in `new`, replaced with `set_config`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// Charged on `mint_pass`; covers the pass's storage.
    pub mint_storage_fee: U128,
    /// Smallest bet; also covers the bet's storage.
    pub min_bet: U128,
    /// `level = 1 + xp / xp_per_level`.
    pub xp_per_level: u32,
    pub xp_enter: u32,
    pub xp_kill: u32,
    pub xp_win: u32,
    /// Cap on the XP one loot event can grant.
    pub xp_loot_max: u32,
    /// Share of the victim's stake paid to the killer at once.
    pub kill_bounty_bps: u32,
    /// Share of the losing bets paid to the winning pass.
    pub market_agent_cut_bps: u32,
    /// Share of the losing bets paid to the treasury.
    pub market_house_bps: u32,
    /// Level needed to claim the physical card.
    pub claim_level: u32,
    /// Burned from the pass balance on a card claim.
    pub claim_burn: U128,
    pub max_entrants: u32,
    pub max_events_per_call: u32,
    /// Activity entries kept per pass.
    pub activity_cap: u32,
    /// Policy given to a newly minted pass.
    pub default_per_call_cap: U128,
    pub default_daily_limit: U128,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            mint_storage_fee: U128(50 * MILLI_NEAR),
            min_bet: U128(10 * MILLI_NEAR),
            xp_per_level: 300,
            xp_enter: 20,
            xp_kill: 120,
            xp_win: 200,
            xp_loot_max: 200,
            kill_bounty_bps: 5_000,
            market_agent_cut_bps: 500,
            market_house_bps: 200,
            claim_level: 5,
            claim_burn: U128(2 * ONE_NEAR),
            max_entrants: 16,
            max_events_per_call: 20,
            activity_cap: 40,
            default_per_call_cap: U128(2 * ONE_NEAR),
            default_daily_limit: U128(10 * ONE_NEAR),
        }
    }
}

impl Config {
    /// Panics if a value is out of range.
    pub fn assert_valid(&self) {
        let bps = [self.kill_bounty_bps, self.market_agent_cut_bps, self.market_house_bps];
        crate::check(bps.iter().all(|b| *b as u128 <= BPS), "config: a bps value is above 10000");
        crate::check(
            (self.market_agent_cut_bps as u128) + (self.market_house_bps as u128) <= BPS,
            "config: market_agent_cut_bps + market_house_bps is above 10000",
        );
        crate::check(self.xp_per_level >= 1, "config: xp_per_level must be at least 1");
        crate::check((1..=100).contains(&self.activity_cap), "config: activity_cap must be 1..=100");
        crate::check((1..=50).contains(&self.max_events_per_call), "config: max_events_per_call must be 1..=50");
        crate::check((2..=32).contains(&self.max_entrants), "config: max_entrants must be 2..=32");
    }
}

/// In JSON in lowercase: "rented", "byo".
#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentKind {
    /// A house agent from the roster, paid for per link.
    Rented,
    /// Bring your own agent.
    Byo,
}

impl AgentKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentKind::Rented => "rented",
            AgentKind::Byo => "byo",
        }
    }
}

/// The agent linked to a pass. The contract records the public key only to
/// report whether a call was signed with it; adding and deleting the key on
/// the owner's account is the owner's own transaction.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentLink {
    pub kind: AgentKind,
    pub name: String,
    pub roster_id: Option<String>,
    pub public_key: Option<PublicKey>,
}

/// Spending caps applied to every spend from the pass balance.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub per_call_cap: u128,
    pub daily_limit: u128,
    pub spent_today: u128,
    /// `block_timestamp / NANOS_PER_DAY` of the last spend.
    pub day: u64,
}

impl Policy {
    /// What has been spent on `today`: zero once the day has rolled over.
    pub fn spent_on(&self, today: u64) -> u128 {
        if self.day == today {
            self.spent_today
        } else {
            0
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pass {
    /// yoctoNEAR held by the contract for this pass.
    pub balance: u128,
    /// Every credit from play and the market (not deposits).
    pub total_in: u128,
    /// Every debit from play (not withdrawals or card claims).
    pub total_out: u128,
    pub market_cut: u128,
    pub xp: u32,
    pub seasons: u32,
    pub wins: u32,
    pub kills: u32,
    pub agent: Option<AgentLink>,
    pub policy: Policy,
    pub active_season: Option<SeasonId>,
    pub claim_ticket: Option<String>,
}

impl Pass {
    pub fn level(&self, xp_per_level: u32) -> u32 {
        1 + self.xp / xp_per_level.max(1)
    }
}

/// One line of a pass's history. A signed amount is `amount` plus `negative`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Activity {
    pub kind: String,
    pub text: String,
    pub amount: U128,
    pub negative: bool,
    pub timestamp_ms: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RosterAgent {
    pub name: String,
    pub blurb: String,
    /// Paid to the treasury on each `link_agent`.
    pub price: u128,
}

/// In JSON as written here: "Open", "Running", "Settled", "Cancelled".
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeasonStatus {
    Open,
    Running,
    Settled,
    Cancelled,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entrant {
    pub pass_id: TokenId,
    /// The part of this entrant's stake still in the pot.
    pub at_risk: u128,
    pub alive: bool,
    /// Sum of the bets placed on this entrant.
    pub bets: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Season {
    pub status: SeasonStatus,
    pub entry_stake: u128,
    pub entrants: Vec<Entrant>,
    /// Always the sum of the entrants' `at_risk`.
    pub pot: u128,
    pub market_open: bool,
    /// Every bet placed (P).
    pub bet_pool: u128,
    pub winner: Option<TokenId>,
    /// Bets on the winner (W), stored at settle.
    pub winner_bets: u128,
    /// What the bettors on the winner share, stored at settle. With
    /// `refund_bets` it is the whole pool.
    pub distributable: u128,
    /// After a cancel, a settle without a winner, or a settle where nobody
    /// backed the winner: every bet is paid back in full.
    pub refund_bets: bool,
    /// Paid out so far by `claim_winnings`.
    pub market_paid: u128,
    /// The `seq` the next `report_events` batch must carry.
    pub next_seq: u64,
}

impl Season {
    pub fn entrant_index(&self, pass_id: &str) -> Option<usize> {
        self.entrants.iter().position(|e| e.pass_id == pass_id)
    }

    pub fn is_live(&self) -> bool {
        matches!(self.status, SeasonStatus::Open | SeasonStatus::Running)
    }

    /// Bet money the contract still holds for this season. After settle it
    /// keeps the rounding dust of the payouts.
    pub fn market_owed(&self) -> u128 {
        if self.is_live() {
            self.bet_pool
        } else {
            self.distributable - self.market_paid
        }
    }

    /// What a bettor with `stakes` is owed once the season is over.
    pub fn payout(&self, stakes: &[BetEntry]) -> u128 {
        if self.refund_bets {
            return stakes.iter().map(|b| b.amount).sum();
        }
        let winner = match &self.winner {
            Some(w) => w,
            None => return 0,
        };
        let on_winner: u128 = stakes.iter().filter(|b| &b.pass_id == winner).map(|b| b.amount).sum();
        if on_winner == 0 || self.winner_bets == 0 {
            return 0;
        }
        mul_div(on_winner, self.distributable, self.winner_bets)
    }
}

/// `a * b / c`, floored, without overflow for any amount of NEAR that can
/// exist (the product of two u128 values is formed in 256 bits).
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    if let Some(p) = a.checked_mul(b) {
        return p / c;
    }
    // Long multiplication into two u128 halves, then long division.
    let (hi, lo) = mul_wide(a, b);
    div_wide(hi, lo, c)
}

fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let mask = u64::MAX as u128;
    let (a1, a0) = (a >> 64, a & mask);
    let (b1, b0) = (b >> 64, b & mask);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & mask) + (p10 & mask);
    let lo = (p00 & mask) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

fn div_wide(hi: u128, lo: u128, c: u128) -> u128 {
    crate::check(hi < c, "amount overflow");
    let mut rem = hi;
    let mut q: u128 = 0;
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        if carry == 1 || rem >= c {
            rem = rem.wrapping_sub(c);
            q |= 1 << i;
        }
    }
    q
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BetEntry {
    pub pass_id: TokenId,
    pub amount: u128,
}

/// One event in a `report_events` batch, after parsing.
///
/// `{"kind":"kill","killer":"<pass_id>"|null,"victim":"<pass_id>"}` or
/// `{"kind":"loot","pass":"<pass_id>","xp":<u32>,"text":"..."}`.
#[near(serializers = [json])]
#[serde(tag = "kind", rename_all = "lowercase")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GameEvent {
    Kill {
        #[serde(default)]
        killer: Option<TokenId>,
        victim: TokenId,
    },
    Loot {
        pass: TokenId,
        xp: u32,
        #[serde(default)]
        text: String,
    },
}

// ---------------------------------------------------------------- views

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyView {
    pub per_call_cap: U128,
    pub daily_limit: U128,
    pub spent_today: U128,
}

/// The shape the start app binds to.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PassView {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub balance: U128,
    pub total_in: U128,
    pub total_out: U128,
    pub market_cut: U128,
    pub xp: u32,
    pub level: u32,
    pub xp_per_level: u32,
    pub seasons: u32,
    pub wins: u32,
    pub kills: u32,
    pub agent: Option<AgentLink>,
    pub policy: PolicyView,
    pub active_season: Option<SeasonId>,
    pub claim_ticket: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RosterView {
    pub roster_id: String,
    pub name: String,
    pub blurb: String,
    pub price: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntrantView {
    pub pass_id: TokenId,
    /// The linked agent's name, empty when none.
    pub name: String,
    pub at_risk: U128,
    pub alive: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeasonView {
    pub season_id: SeasonId,
    pub status: SeasonStatus,
    pub entry_stake: U128,
    pub pot: U128,
    pub winner: Option<TokenId>,
    pub market_open: bool,
    pub next_seq: u64,
    pub entrants: Vec<EntrantView>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PassAmount {
    pub pass_id: TokenId,
    pub amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketView {
    pub open: bool,
    pub pool: U128,
    pub totals: Vec<PassAmount>,
    pub settled: bool,
    pub winner: Option<TokenId>,
    pub status: SeasonStatus,
    /// True once every bet is paid back in full (cancel, no winner, or
    /// nobody backed the winner).
    pub refund: bool,
    /// Set at settle: bets on the winner (W) and what they share.
    pub winner_bets: U128,
    pub distributable: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BetsView {
    pub bets: Vec<PassAmount>,
    /// Null while the season is open or running; afterwards what
    /// `claim_winnings` would pay now.
    pub claimable: Option<U128>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReportResult {
    pub applied: u32,
    pub skipped: u32,
    pub next_seq: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountingView {
    /// Sum of every pass balance.
    pub pass_balances: U128,
    /// Sum of the pots of open and running seasons.
    pub season_pots: U128,
    /// Bet money not yet claimed, rounding dust included.
    pub bets_owed: U128,
    /// NEAR burned by card claims; it stays in the contract for ever.
    pub burned_total: U128,
    /// pass_balances + season_pots + bets_owed + burned_total.
    pub owed_total: U128,
    pub account_balance: U128,
    /// Storage staking for the contract's current state.
    pub storage_reserved: U128,
    /// account_balance - owed_total - storage_reserved, floored at 0.
    pub free_balance: U128,
    /// account_balance >= owed_total + storage_reserved.
    pub solvent: bool,
}

/**
 * The contract's parimutuel maths, mirrored for display.
 *
 * Amounts are yoctoNEAR as BigInt, exactly as the contract counts them, so a
 * number shown here is the number the contract will pay. At settle, with P
 * the pool, W the bets on the winner and L = P - W:
 *
 *   agent_cut     = L * market_agent_cut_bps / 10000   (floored)
 *   house_cut     = L * market_house_bps / 10000       (floored)
 *   distributable = P - agent_cut - house_cut
 *   payout        = stake_on_winner * distributable / W (floored)
 *
 * The cuts come off the losing side only. No module imports here, so the
 * same code runs in the browser and in a plain Node script.
 */

const BPS = 10000n;
const YOCTO_PER_MICRO = 10n ** 18n; // one millionth of a NEAR

/** yoctoNEAR (string, number or BigInt) to NEAR, exact to a millionth. */
export function fromYocto(yocto) {
  const v = BigInt(yocto ?? 0);
  return Number(v / YOCTO_PER_MICRO) / 1e6;
}

/**
 * NEAR as text for the screen: up to four decimals under 1, three under 10,
 * two above, trailing zeros dropped. Takes yocto (BigInt or string) or a
 * NEAR number.
 */
export function formatNear(amount) {
  const near = typeof amount === 'number' ? amount : fromYocto(amount);
  const abs = Math.abs(near);
  const digits = abs >= 10 ? 2 : abs >= 1 ? 3 : 4;
  const text = near.toFixed(digits).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
}

/** The two market cuts from the contract's Config, as BigInt basis points. */
export function cutsFrom(config) {
  return {
    agentBps: BigInt(config?.market_agent_cut_bps ?? 0),
    houseBps: BigInt(config?.market_house_bps ?? 0),
  };
}

/** What `stakeOnWinner` pays when the pass holding `winnerBets` wins a pool. */
export function settlePayout({ pool, winnerBets, stakeOnWinner, agentBps, houseBps }) {
  if (winnerBets <= 0n) return 0n;
  const losing = pool - winnerBets;
  const agentCut = (losing * agentBps) / BPS;
  const houseCut = (losing * houseBps) / BPS;
  const distributable = pool - agentCut - houseCut;
  return (stakeOnWinner * distributable) / winnerBets;
}

/**
 * What a new bet of `stake` on a pass pays if that pass wins, with the pool
 * as it stands plus this bet. Defined even when nobody has backed the pass
 * yet: the bet is then the whole winning side.
 */
export function betReturn({ pool, onPass, stake, agentBps, houseBps }) {
  return settlePayout({
    pool: pool + stake,
    winnerBets: onPass + stake,
    stakeOnWinner: stake,
    agentBps,
    houseBps,
  });
}

const ratio = (a, b) => Number((a * 1_000_000n) / b) / 1e6;

/**
 * The price of a pass as a payout multiple: NEAR returned per NEAR staked if
 * it wins. With nothing on the pass yet, the multiple a bet of `probe` would
 * get (never infinity). Null only when there is nothing to price.
 */
export function oddsFor({ pool, onPass, probe, agentBps, houseBps }) {
  if (onPass > 0n) {
    return ratio(settlePayout({ pool, winnerBets: onPass, stakeOnWinner: onPass, agentBps, houseBps }), onPass);
  }
  if (probe > 0n) return ratio(betReturn({ pool, onPass: 0n, stake: probe, agentBps, houseBps }), probe);
  return null;
}

/**
 * MarketView totals as a map: pass id -> yocto on it. Every entrant of the
 * season is listed, with "0" when nobody has backed it.
 */
export function totalsByPass(market) {
  const out = new Map();
  for (const row of market?.totals ?? []) out.set(String(row.pass_id), BigInt(row.amount ?? 0));
  return out;
}

/** The season's status in lower case ('open', 'running', 'settled', 'cancelled'), or ''. */
export function statusOf(market, season) {
  return String(market?.status ?? season?.status ?? '').toLowerCase();
}

export const isLive = (status) => status === 'open' || status === 'running';
export const isOver = (status) => status === 'settled' || status === 'cancelled';

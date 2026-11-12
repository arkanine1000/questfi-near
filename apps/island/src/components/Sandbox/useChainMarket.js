/**
 * The spectator market on the QuestFi contract: the same value the simulated
 * market gives the drawer, read from and written to the chain.
 *
 * - pools: `get_market(season).totals`, read every 3 s while the season is
 *   open or running (and until it settles, which can trail the game's end);
 * - bets and what they can claim: `get_bets(season, account)`;
 * - place: `place_bet(season, pass)` with the stake attached;
 * - claim: `claim_winnings(season)` once the season is settled or cancelled.
 *
 * The season id is the game's world id (the server's `near.season_id` when
 * it sends one). An agent is bettable when it carries a `pass_id` that is an
 * entrant in the market's totals.
 *
 * A season on chain always shows its real market. Without a test account it
 * is read only (pools, odds and whether betting is open); the account only
 * adds the bettor's own stakes and the right to bet.
 */

import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  betReturn, cutsFrom, formatNear, fromYocto, isLive, isOver, oddsFor,
  settlePayout, statusOf, totalsByPass,
} from '../../services/marketMath';

const POLL_MS = 3000;
const WAIT_MS = 6000; // the season is not on chain (yet), or the network failed
const BETS_EVERY = 4; // polls between reads of the account's own bets
const STAKE_MULTIPLES = [1n, 5n, 10n]; // times the contract's min_bet
const MAX_TXS = 8;

const passOf = (agent) => (agent?.pass_id != null && agent.pass_id !== '' ? String(agent.pass_id) : null);

// Per account and season, what this browser sent and claimed, so a reload
// keeps the explorer links. Best effort: without storage they last the page.
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage blocked */ }
  },
};

/** One probability sample per tick, as the simulated market keeps. */
export function useProbHistory(worldId, tick, pools) {
  const [probHistory, setProbHistory] = useState([]);
  useEffect(() => { setProbHistory([]); }, [worldId]);
  useEffect(() => {
    if (!worldId || tick == null || !pools.total) return;
    setProbHistory((prev) => {
      if (prev.length && prev[prev.length - 1].tick === tick) return prev;
      const probs = {};
      for (const [id, share] of Object.entries(pools.byAgent)) {
        probs[id] = share / pools.total;
      }
      return [...prev.slice(-399), { tick, probs }];
    });
  }, [worldId, tick, pools]);
  return probHistory;
}

export function useChainMarket({ near, world, roster }) {
  const {
    chain, config, session, refreshBalance, createTestAccount,
  } = near;
  const seasonId = world?.near?.season_id || world?.world_id || null;
  // The server's near block says whether this season settles on chain:
  // true, false, or undefined for a server that sends no such block.
  const serverSays = world?.near?.enabled;
  const offChain = serverSays === false;
  const canRead = Boolean(near.enabled && chain && seasonId && !offChain);
  const hasAccount = Boolean(near.status === 'ready' && session && near.accountId);
  const accountId = hasAccount ? near.accountId : null;
  // Able to bet: the market can be read, priced, and signed for.
  const ready = Boolean(canRead && config && hasAccount);

  const [market, setMarket] = useState(undefined); // undefined: not read; null: no such season
  const [season, setSeason] = useState(null);
  const [myBets, setMyBets] = useState(null);
  const [feedError, setFeedError] = useState(null);
  const [pending, setPending] = useState(null); // {kind:'bet', agentId, stake} | {kind:'claim'}
  const [notice, setNotice] = useState(null); // {tone:'ok'|'bad', text, txHash}
  const [txs, setTxs] = useState([]);
  const [claimed, setClaimed] = useState(null);

  // The market belongs to the season; bets, links and claims to the account.
  const readKey = canRead ? `${chain.contractId}:${seasonId}` : null;
  const keyBase = readKey && accountId ? `${readKey}:${accountId}` : null;
  useEffect(() => {
    setMarket(undefined);
    setSeason(null);
    setFeedError(null);
  }, [readKey]);
  useEffect(() => {
    setMyBets(null);
    setNotice(null);
    setTxs(keyBase ? store.get(`questfi.island.txs:${keyBase}`, []) : []);
    setClaimed(keyBase ? store.get(`questfi.island.claim:${keyBase}`, null) : null);
  }, [keyBase]);

  // ---- reading ------------------------------------------------------------
  const readAll = useCallback(async ({ bets = true } = {}) => {
    const [m, s] = await Promise.all([chain.getMarket(seasonId), chain.getSeason(seasonId)]);
    const b = bets && m && accountId ? await chain.getBets(seasonId, accountId) : undefined;
    return { m: m ?? null, s: s ?? null, b };
  }, [chain, seasonId, accountId]);

  // Which season and account a read in flight was for; a late answer for
  // another one is dropped.
  const pollKey = `${readKey}|${accountId}`;
  const liveKey = useRef(null);
  liveKey.current = pollKey;

  useEffect(() => {
    if (!readKey) return undefined;
    const key = pollKey;
    let stop = false;
    let timer = null;
    let n = 0;
    let lastStatus = null;
    const run = async () => {
      let next = POLL_MS;
      try {
        const peek = await readAll({ bets: false });
        if (stop || liveKey.current !== key) return;
        const status = statusOf(peek.m, peek.s);
        let { b } = peek;
        if (peek.m && accountId && (n % BETS_EVERY === 0 || status !== lastStatus)) {
          b = await chain.getBets(seasonId, accountId);
          if (stop || liveKey.current !== key) return;
        }
        setMarket(peek.m);
        setSeason(peek.s);
        if (b !== undefined) setMyBets(b);
        setFeedError(null);
        lastStatus = status;
        // Settled or cancelled is final: nothing more moves on its own.
        next = !peek.m ? WAIT_MS : isOver(status) ? null : POLL_MS;
      } catch {
        if (stop) return;
        setFeedError('Could not reach the NEAR network. Retrying…');
        next = WAIT_MS;
      }
      n += 1;
      if (!stop && next) timer = setTimeout(run, next);
    };
    run();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [readKey, pollKey, readAll, chain, seasonId, accountId]);

  const refreshNow = useCallback(async () => {
    const key = pollKey;
    try {
      const { m, s, b } = await readAll();
      if (liveKey.current !== key) return;
      setMarket(m);
      setSeason(s);
      if (b !== undefined) setMyBets(b);
    } catch { /* the poll catches up */ }
    refreshBalance();
  }, [pollKey, readAll, refreshBalance]);

  const addTx = useCallback((tx) => {
    if (!keyBase) return;
    setTxs((prev) => {
      const next = [{ ...tx, at: Date.now() }, ...prev].slice(0, MAX_TXS);
      store.set(`questfi.island.txs:${keyBase}`, next);
      return next;
    });
  }, [keyBase]);

  // ---- the market as numbers ---------------------------------------------
  const cuts = useMemo(() => cutsFrom(config), [config]);
  const minBet = useMemo(() => BigInt(config?.min_bet ?? 0), [config]);
  const status = statusOf(market, season);
  const byPass = useMemo(() => totalsByPass(market), [market]);
  const poolY = useMemo(() => BigInt(market?.pool ?? 0), [market]);

  const agentByPass = useMemo(() => {
    const map = new Map();
    for (const a of roster) {
      const p = passOf(a);
      if (p) map.set(p, a);
    }
    return map;
  }, [roster]);

  const agentById = useMemo(() => new Map(roster.map((a) => [a.agent_id, a])), [roster]);

  const pools = useMemo(() => {
    const byAgent = {};
    for (const a of roster) {
      const p = passOf(a);
      if (p && byPass.has(p)) byAgent[a.agent_id] = fromYocto(byPass.get(p));
    }
    return { total: fromYocto(poolY), totalYocto: poolY, byAgent, byPass };
  }, [roster, byPass, poolY]);

  const onPassOf = useCallback((agentId) => {
    const p = passOf(agentById.get(agentId));
    return p && byPass.has(p) ? byPass.get(p) : null;
  }, [agentById, byPass]);

  /** Bettable: the agent has a pass, and that pass is entered in this season. */
  const canBack = useCallback((agent) => {
    const p = passOf(agent);
    return Boolean(p && byPass.has(p));
  }, [byPass]);

  const odds = useCallback((agentId) => {
    const onPass = onPassOf(agentId);
    if (onPass == null) return null;
    return oddsFor({ pool: poolY, onPass, probe: minBet, ...cuts });
  }, [onPassOf, poolY, minBet, cuts]);

  const prob = useCallback((agentId) => {
    const onPass = onPassOf(agentId);
    if (onPass == null || poolY === 0n) return 0;
    return Number((onPass * 1_000_000n) / poolY) / 1e6;
  }, [onPassOf, poolY]);

  const myByPass = useMemo(() => {
    const map = new Map();
    for (const row of myBets?.bets ?? []) map.set(String(row.pass_id), BigInt(row.amount ?? 0));
    return map;
  }, [myBets]);

  const stakedY = useMemo(() => [...myByPass.values()].reduce((s, v) => s + v, 0n), [myByPass]);

  const bets = useMemo(() => {
    const out = {};
    for (const [p, amount] of myByPass) {
      const agent = agentByPass.get(p);
      out[agent ? agent.agent_id : `pass:${p}`] = fromYocto(amount);
    }
    return out;
  }, [myByPass, agentByPass]);

  const stakes = useMemo(() => STAKE_MULTIPLES.map((k) => ({ near: fromYocto(minBet * k), yocto: minBet * k })), [minBet]);

  /** What a new bet of `stake` (an entry of `stakes`) on the agent pays if it wins. */
  const quote = useCallback((agentId, stake) => {
    const onPass = onPassOf(agentId);
    if (onPass == null || !stake) return null;
    return fromYocto(betReturn({ pool: poolY, onPass, stake: stake.yocto, ...cuts }));
  }, [onPassOf, poolY, cuts]);

  /** What the account's present stake on the agent pays if it wins, the pool as it stands. */
  const ifWins = useCallback((agentId) => {
    const p = passOf(agentById.get(agentId));
    const mine = p ? myByPass.get(p) ?? 0n : 0n;
    const onPass = onPassOf(agentId);
    if (!mine || onPass == null) return null;
    return fromYocto(settlePayout({ pool: poolY, winnerBets: onPass, stakeOnWinner: mine, ...cuts }));
  }, [agentById, myByPass, onPassOf, poolY, cuts]);

  // Whether the season's market takes bets, read from the contract whether
  // or not this browser can bet. The game's end closes it here at once: the
  // contract stays open until the server's lock, but the result is known.
  const readState = market === undefined || !config ? 'loading' : market === null ? 'waiting' : 'live';
  const bettingOpen = Boolean(readState === 'live' && market.open && isLive(status) && world?.phase !== 'finished');
  const balance = hasAccount && near.balance != null ? fromYocto(near.balance) : null;

  // ---- the account's actions ---------------------------------------------
  const place = useCallback(async (agent, stake) => {
    if (!ready || pending || !bettingOpen || !agent?.alive) return;
    const passId = passOf(agent);
    if (!passId || !byPass.has(passId)) {
      setNotice({ tone: 'bad', text: `${agent.name} has no agent pass in this season, so there is no market on it.` });
      return;
    }
    const yocto = typeof stake === 'object' ? stake.yocto : null;
    if (!yocto) return;
    if (near.balance != null && near.balance < yocto) {
      setNotice({ tone: 'bad', text: `The test account holds ${formatNear(near.balance)} NEAR, less than this ${formatNear(yocto)} NEAR bet.` });
      return;
    }
    const label = `${formatNear(yocto)} NEAR on ${agent.name}`;
    setPending({ kind: 'bet', agentId: agent.agent_id, stake: fromYocto(yocto) });
    setNotice(null);
    try {
      const done = await chain.placeBet(session, seasonId, passId, yocto);
      addTx({ method: 'place_bet', label, txHash: done.txHash, ok: true });
      setNotice({ tone: 'ok', text: `Bet placed: ${label}.`, txHash: done.txHash });
    } catch (err) {
      const e = chain.explainError(err);
      if (e.txHash) addTx({ method: 'place_bet', label, txHash: e.txHash, ok: false });
      const text = e.kind === 'network'
        ? `${e.text} If the bet went through, it shows in your stake within a few seconds.`
        : e.text;
      setNotice({ tone: 'bad', text, txHash: e.txHash });
      console.error('[place_bet]', err);
    } finally {
      setPending(null);
      refreshNow();
    }
  }, [ready, pending, bettingOpen, byPass, near.balance, chain, session, seasonId, addTx, refreshNow]);

  const claim = useCallback(async () => {
    if (!ready || pending) return;
    setPending({ kind: 'claim' });
    setNotice(null);
    try {
      const done = await chain.claimWinnings(session, seasonId);
      const record = { amount: done.paid.toString(), txHash: done.txHash, refund: Boolean(market?.refund) };
      setClaimed(record);
      store.set(`questfi.island.claim:${keyBase}`, record);
      addTx({ method: 'claim_winnings', label: `${formatNear(done.paid)} NEAR paid out`, txHash: done.txHash, ok: true });
      setNotice({ tone: 'ok', text: `Paid ${formatNear(done.paid)} NEAR to your test account.`, txHash: done.txHash });
    } catch (err) {
      const e = chain.explainError(err);
      if (e.txHash) addTx({ method: 'claim_winnings', label: 'claim refused', txHash: e.txHash, ok: false });
      setNotice({ tone: 'bad', text: e.text, txHash: e.txHash });
      console.error('[claim_winnings]', err);
    } finally {
      setPending(null);
      refreshNow();
    }
  }, [ready, pending, chain, session, seasonId, market?.refund, keyBase, addTx, refreshNow]);

  // ---- the result ----------------------------------------------------------
  const payout = useMemo(() => {
    const winnerAgent = market?.winner != null ? agentByPass.get(String(market.winner)) : null;
    const base = {
      staked: fromYocto(stakedY),
      refund: Boolean(market?.refund),
      cancelled: status === 'cancelled',
      winnerName: winnerAgent?.name ?? world?.winner_name ?? null,
    };
    if (claimed) {
      return { ...base, state: 'paid', won: BigInt(claimed.amount) > 0n, amount: fromYocto(claimed.amount), txHash: claimed.txHash, refund: claimed.refund };
    }
    if (stakedY === 0n) return null;
    if (isOver(status) && myBets?.claimable != null) {
      const claimable = BigInt(myBets.claimable);
      return { ...base, state: claimable > 0n ? 'claimable' : 'lost', won: claimable > 0n && !base.refund, amount: fromYocto(claimable) };
    }
    if (world?.phase === 'finished') return { ...base, state: 'waiting', won: false, amount: 0 };
    return null;
  }, [market, agentByPass, stakedY, status, world?.winner_name, world?.phase, claimed, myBets]);

  const myTotal = fromYocto(stakedY);
  const probHistory = useProbHistory(readState === 'live' ? seasonId : null, world?.tick, pools);

  // The drawer shows this market for every season on chain, account or not.
  // Practice chips are left only where they are honest: the server says the
  // season is off chain, or (a server with no near block) the contract has
  // no such season.
  const notOnChain = offChain || (serverSays !== true && market === null);
  const active = Boolean(near.enabled && seasonId && !notOnChain);
  const note = near.enabled && seasonId && notOnChain
    ? 'This season is not on chain. These are practice chips, not NEAR.'
    : null;

  const value = useMemo(() => ({
    mode: 'chain',
    unit: 'NEAR',
    balance,
    bets,
    myTotal,
    pools,
    odds,
    prob,
    probHistory,
    place,
    payout,
    bettingOpen,
    stakes,
    quote,
    ifWins,
    canBack,
    claim,
    pending,
    notice,
    dismissNotice: () => setNotice(null),
    feedError,
    txs,
    status,
    readState,
    seasonId,
    accountId,
    hasAccount,
    accountStatus: near.status,
    accountError: near.error,
    createTestAccount,
    minBet: fromYocto(minBet),
  }), [balance, bets, myTotal, pools, odds, prob, probHistory, place, payout, bettingOpen,
       stakes, quote, ifWins, canBack, claim, pending, notice, feedError, txs, status, readState,
       seasonId, accountId, hasAccount, near.status, near.error, createTestAccount, minBet]);

  return { active, note, value };
}

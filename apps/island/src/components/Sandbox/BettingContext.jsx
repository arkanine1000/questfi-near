/**
 * Parimutuel state, shared by the roster rail (per-agent odds + stakes live
 * ON the chips — least friction) and the wallet pill.
 *
 * Two markets behind one value. With a contract configured (VITE_CONTRACT_ID)
 * and a NEAR test account in this browser, bets are real testnet NEAR on the
 * QuestFi contract (useChainMarket.js). Otherwise it is the simulation: a
 * localStorage sim-wallet, per-world slips, deterministic house liquidity
 * that drifts with live performance, true parimutuel odds with a 2% rake,
 * pro-rata settlement at season end.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';
import { useSandbox } from '../../context/SandboxContext';
import { useNear } from '../../context/NearContext';
import { useChainMarket } from './useChainMarket';

const START_BALANCE = 1000;
export const STAKES = [25, 100, 250];
const RAKE = 0.02;

const readJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
const writeJSON = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage blocked — sim chips are best-effort */ }
};

/** Deterministic per-(world, agent) house liquidity seed. */
function seedPool(worldId, agentId) {
  let h = 2166136261;
  for (const ch of `${worldId}:${agentId}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return 250 + (Math.abs(h) % 650);
}

const BettingContext = createContext(null);

/** The simulated market, unchanged from before the chain existed. */
function useSimMarket() {
  const { world, roster } = useSandbox();
  const worldId = world?.world_id;
  const [balance, setBalance] = useState(() => readJSON('sbx-chips', START_BALANCE));
  const [bets, setBets] = useState({});
  const [payout, setPayout] = useState(null);

  useEffect(() => {
    if (worldId) setBets(readJSON(`sbx-bets:${worldId}`, {}));
    setPayout(null);
    // The house stakes you again each season: a wallet drained across
    // abandoned worlds (stakes are never refunded on abandon) left every
    // stake button permanently disabled. Broke at a fresh world → refill.
    if (worldId && readJSON('sbx-chips', START_BALANCE) < Math.min(...STAKES)) {
      writeJSON('sbx-chips', START_BALANCE);
      setBalance(START_BALANCE);
    }
  }, [worldId]);

  const pools = useMemo(() => {
    if (!worldId) return { total: 0, byAgent: {} };
    const byAgent = {};
    let total = 0;
    for (const a of roster) {
      const house = seedPool(worldId, a.agent_id)
        + a.kills * 180
        + (a.max_hp ? Math.round((a.hp / a.max_hp) * 120) : 0);
      const mine = bets[a.agent_id] ?? 0;
      byAgent[a.agent_id] = house + mine;
      total += house + mine;
    }
    return { total, byAgent };
  }, [worldId, roster, bets]);

  const odds = useCallback((agentId) => {
    const share = pools.byAgent[agentId] ?? 0;
    if (!share || !pools.total) return null;
    return Math.max(1.01, (pools.total / share) * (1 - RAKE));
  }, [pools]);

  /** Implied win probability — the market's price for an agent. */
  const prob = useCallback((agentId) => {
    const share = pools.byAgent[agentId] ?? 0;
    return pools.total ? share / pools.total : 0;
  }, [pools]);

  // The market's memory: one probability sample per tick, so the chart can
  // tell the season's story. Capped well past max_ticks (300).
  const [probHistory, setProbHistory] = useState([]);
  useEffect(() => { setProbHistory([]); }, [worldId]);
  const tick = world?.tick;
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

  const bettingOpen = !!world && world.phase !== 'finished';

  const place = useCallback((agent, stake) => {
    if (!worldId || !bettingOpen || !agent.alive || stake > balance) return;
    setBets((prev) => {
      const next = { ...prev, [agent.agent_id]: (prev[agent.agent_id] ?? 0) + stake };
      writeJSON(`sbx-bets:${worldId}`, next);
      return next;
    });
    setBalance((b) => {
      const nb = b - stake;
      writeJSON('sbx-chips', nb);
      return nb;
    });
  }, [worldId, bettingOpen, balance]);

  // Settlement — once per world, pro-rata share of the whole pool
  useEffect(() => {
    if (!worldId || world?.phase !== 'finished') return;
    if (readJSON(`sbx-settled:${worldId}`, false)) return;
    writeJSON(`sbx-settled:${worldId}`, true);
    const myStake = Object.values(bets).reduce((s, v) => s + v, 0);
    if (!myStake) return;
    const winStake = world.winner ? (bets[world.winner] ?? 0) : 0;
    if (winStake > 0) {
      const winnings = Math.round(
        pools.total * (winStake / (pools.byAgent[world.winner] || winStake)) * (1 - RAKE),
      );
      setBalance((b) => {
        const nb = b + winnings;
        writeJSON('sbx-chips', nb);
        return nb;
      });
      setPayout({ won: true, amount: winnings });
    } else {
      setPayout({ won: false, amount: myStake });
    }
  }, [world?.phase, world?.winner, worldId, bets, pools]);

  const myTotal = useMemo(
    () => Object.values(bets).reduce((s, v) => s + v, 0),
    [bets],
  );

  /** What a new stake on the agent pays if it wins, the pool as it stands
   *  plus this stake: the same sum settlement does, for this stake alone. */
  const quote = useCallback((agentId, stake) => {
    const share = pools.byAgent[agentId] ?? 0;
    if (!stake || !pools.total) return null;
    return Math.round((pools.total + stake) * (stake / (share + stake)) * (1 - RAKE));
  }, [pools]);

  /** What the chips already on the agent pay if it wins, the pool as it stands. */
  const ifWins = useCallback((agentId) => {
    const mine = bets[agentId] ?? 0;
    const share = pools.byAgent[agentId] ?? 0;
    if (!mine || !share) return null;
    return Math.round(pools.total * (mine / share) * (1 - RAKE));
  }, [bets, pools]);

  return useMemo(() => ({
    mode: 'sim', unit: '⬡', stakes: STAKES,
    balance, bets, myTotal, pools, odds, prob, probHistory, place, payout, bettingOpen,
    quote, ifWins, rakePct: RAKE * 100,
  }), [balance, bets, myTotal, pools, odds, prob, probHistory, place, payout, bettingOpen,
       quote, ifWins]);
}

export function BetsProvider({ children }) {
  const { world, roster } = useSandbox();
  const near = useNear();
  const sim = useSimMarket();
  const chain = useChainMarket({ near, world, roster });
  const value = useMemo(
    () => (chain.active ? chain.value : (chain.note ? { ...sim, note: chain.note } : sim)),
    [chain.active, chain.value, chain.note, sim],
  );
  return <BettingContext.Provider value={value}>{children}</BettingContext.Provider>;
}

const INERT = {
  mode: 'sim', unit: '⬡', stakes: STAKES,
  balance: 0, bets: {}, myTotal: 0, pools: { total: 0, byAgent: {} },
  odds: () => null, prob: () => 0, probHistory: [], place: () => {},
  payout: null, bettingOpen: false,
  quote: () => null, ifWins: () => null, rakePct: RAKE * 100,
};

/** Safe outside the provider (legacy view) — everything inert. */
export function useBets() {
  return useContext(BettingContext) ?? INERT;
}

/**
 * How betting works, in plain sentences built from the live market: its
 * cuts, when it locks, and a worked example on the pool as it stands and
 * the agent the slip is for.
 */

import { useSandbox } from '../../../context/SandboxContext';
import { useBets } from '../BettingContext';
import Modal from '../../ui/Modal';
import { fmtOdds, fmtReturn, moneyOf } from './bits';

const pct = (n) => `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;

function ChainRules() {
  const {
    agentCutPct, houseCutPct, lockTick,
  } = useBets();
  const cuts = agentCutPct != null && houseCutPct != null;
  return (
    <>
      <p>Everyone&apos;s stakes, on every agent, go into one pool.</p>
      <p>
        When the season settles, the pool is paid out to the people who backed the winner, each in
        proportion to their stake.
      </p>
      <p>
        {cuts
          ? `Before that, ${pct(agentCutPct)} of the losing side goes to the winning agent's pass and ${pct(houseCutPct)} to the house. Stakes on the winner are never cut.`
          : 'Before that, a cut of the losing side goes to the winning agent\'s pass and another to the house. The exact numbers show here once the contract has been read.'}
      </p>
      <p>
        {lockTick
          ? `Bets close a few ticks into the season, at tick ${lockTick}. `
          : 'Bets close a few ticks into the season, when the game server locks the market. '}
        Until then the odds move with every bet, so the × beside an agent is what each NEAR of a bet
        placed now would return if that agent wins and nobody else bets afterwards.
      </p>
      <p>If the season is cancelled, or nobody backed the winner, every stake is refunded.</p>
      <p>It all runs on NEAR testnet, so the NEAR here has no value.</p>
    </>
  );
}

function SimRules() {
  const { rakePct } = useBets();
  return (
    <>
      <p>These are practice chips, not NEAR: nothing here touches a blockchain.</p>
      <p>
        Everyone&apos;s chips, on every agent, go into one pool. The island keeps chips of its own on
        every agent, and they move with how well each one fights.
      </p>
      <p>
        When the game ends, the pool is paid out to those who backed the winner, each in proportion to
        their stake, less {pct(rakePct ?? 2)} the island keeps. Practice chips have no cut for the
        winning agent&apos;s pass: that part of the market exists only on NEAR.
      </p>
      <p>
        Practice bets stay open until the game ends. The odds move all the while, so the × beside an
        agent is what each chip staked now would return if that agent wins and nothing else changes.
      </p>
      <p>A practice season is never cancelled. If you run out of chips, a fresh season fills your stack again.</p>
    </>
  );
}

/** Two lines of sums on the pool as it stands. */
function Example() {
  const { followedAgent } = useSandbox();
  const m = useBets();
  const { chain, fmt, amountOf } = moneyOf(m);
  const agent = followedAgent;
  const live = !chain || m.readState === 'live';
  const backable = agent?.alive && live && (!chain || m.canBack(agent));
  const st = m.stakes?.[1] ?? m.stakes?.[0];
  const u = chain ? 'NEAR' : 'chips';

  if (!live) return <p>The worked example appears once this season&apos;s market has been read.</p>;
  const pool = `${fmt(m.pools.total)} ${u}`;
  if (!backable || !st) {
    return (
      <>
        <p>The pool holds {pool} right now.</p>
        <p>Follow an agent to see what a bet on it would return.</p>
      </>
    );
  }
  const onAgent = m.pools.byAgent[agent.agent_id] ?? 0;
  const amount = amountOf(st);
  const q = m.quote(agent.agent_id, st);
  return (
    <>
      <p>The pool holds {pool} right now, {fmt(onAgent)} {u} of it on {agent.name}.</p>
      <p>
        {q != null
          ? `${fmt(amount)} ${u} on ${agent.name} now would return ${fmtReturn(q, chain)} ${u} if ${agent.name} wins (×${fmtOdds(q / amount)}), ${chain ? 'as long as nobody bets after you' : 'if nothing else changes'}.`
          : `Nothing prices ${agent.name} yet.`}
      </p>
    </>
  );
}

export default function HowBetting({ onClose }) {
  const { mode } = useBets();
  return (
    <Modal title="How betting works" onClose={onClose} wide className="qf-mkt-help">
      <div className="qf-body qf-mkt-help__rules">
        {mode === 'chain' ? <ChainRules /> : <SimRules />}
      </div>
      <div className="qf-mkt-help__example">
        <div className="qf-label qf-label--small">For example</div>
        <div className="qf-body"><Example /></div>
      </div>
    </Modal>
  );
}

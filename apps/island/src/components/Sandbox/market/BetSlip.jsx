/**
 * The bet slip: the followed agent, what is on it, and three stakes with
 * what each returns if that agent wins. Every number the bettor acts on is
 * in full here, none of it behind a hover.
 *
 * One slip for both markets. On chain the stakes are 1x, 5x and 10x the
 * contract's minimum bet and go out as transactions from the test account;
 * without that account the slip shows what the bet would be and offers to
 * make one. In the simulation the stakes are practice chips, placed at once.
 */

import { useEffect, useState } from 'react';
import { useSandbox } from '../../../context/SandboxContext';
import { useBets } from '../BettingContext';
import { IconLock, IconWarn } from '../../ui/icons';
import {
  AgentHex, AgentName, Amount, Notice, closedReason, closesSoon, fmtOdds, fmtPct, moneyOf,
} from './bits';

/** In place of the stakes when this browser has no test account yet. */
export function AccountOffer() {
  const { accountStatus, accountError, createTestAccount } = useBets();
  const busy = accountStatus === 'creating' || accountStatus === 'loading';
  let label = 'Play with a test account to bet';
  if (accountStatus === 'creating') label = 'Creating your test account…';
  else if (accountStatus === 'loading') label = 'Looking for your test account…';
  return (
    <div className="qf-mkt-join">
      <button
        type="button"
        className={`qf-btn qf-btn--primary qf-btn--wide qf-mkt-join__btn${busy ? ' is-busy' : ''}`}
        onClick={createTestAccount}
        disabled={busy}
      >
        {label}
      </button>
      {accountError && <p className="qf-mkt-warn" role="alert"><IconWarn size={14} /><span>{accountError}</span></p>}
    </div>
  );
}

/** Every living agent the market prices, as buttons that follow it. */
function QuickPicks({ agents, onFollow, label }) {
  const { prob, pools } = useBets();
  if (!agents.length) return null;
  return (
    <div className="qf-mkt-picks-wrap">
      <div className="qf-label qf-mkt-picks__label">{label}</div>
      <div className="qf-mkt-picks">
        {agents.map((a) => {
          const price = pools.total > 0 ? fmtPct(prob(a.agent_id)) : '—';
          return (
            <button
              key={a.agent_id}
              type="button"
              className="qf-mkt-pick"
              style={{ '--agent': a.color }}
              onClick={() => onFollow?.(a)}
              aria-label={`Follow ${a.name} and open the slip for it, ${price === '—' ? 'no price yet' : `${price} to win`}`}
            >
              <AgentHex agent={a} size={24} />
              <AgentName agent={a} />
              <span className="qf-num qf-num--small qf-mkt-pick__price">{price}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Betting is closed: the lock and today's reason, and a way to the viewer's bets. */
function Closed({ reason, onSeeBets, hasStake }) {
  return (
    <div className="qf-mkt-closed" role="status">
      <div className="qf-mkt-closed__head">
        <IconLock size={15} />
        <span>Betting closed</span>
      </div>
      <p className="qf-mkt-msg">{reason}</p>
      {hasStake && onSeeBets && (
        <button type="button" className="qf-btn qf-btn--small" onClick={onSeeBets}>See your bets</button>
      )}
    </div>
  );
}

export default function BetSlip({ onFollow, onSeeBets }) {
  const { followedAgent, world, roster } = useSandbox();
  const m = useBets();
  const {
    chain, unit, fmt, amountOf, keyOf,
  } = moneyOf(m);
  const agent = followedAgent;
  const phase = world?.phase;

  // On chain nothing is known until the season's market has been read, and
  // only an agent whose pass is entered in the season has a market.
  const live = !chain || m.readState === 'live';
  const backableAgent = (a) => !chain || (live && m.canBack(a));
  const backable = agent ? backableAgent(agent) : false;
  const hasAccount = !chain || m.hasAccount;
  const closed = live ? closedReason({
    chain, status: m.status, phase, bettingOpen: m.bettingOpen,
  }) : null;
  const open = live && !closed;

  // The simulation places a bet at once and says nothing back, so the slip
  // keeps its own report of the last one.
  const [simNotice, setSimNotice] = useState(null);
  useEffect(() => { setSimNotice(null); }, [world?.world_id]);

  const picks = roster
    .filter((a) => a.alive && backableAgent(a))
    .sort((a, b) => m.prob(b.agent_id) - m.prob(a.agent_id));

  const onAgent = agent ? m.pools.byAgent[agent.agent_id] ?? 0 : 0;
  const mine = agent ? m.bets[agent.agent_id] ?? 0 : 0;
  const x = agent && backable ? m.odds(agent.agent_id) : null;
  const win = agent && mine > 0 ? m.ifWins(agent.agent_id) : null;

  const place = (st) => {
    m.place(agent, st);
    if (!chain) {
      setSimNotice({ tone: 'ok', text: `Backed ${agent.name} with ${fmt(st)} practice chips.` });
    }
  };

  const stakesBlock = () => {
    const short = m.stakes.some((st) => m.balance != null && amountOf(st) > m.balance);
    let why = null;
    if (chain && m.pending?.kind === 'bet') why = 'Sending your bet to NEAR…';
    else if (chain && m.pending?.kind === 'claim') why = 'Claiming…';
    else if (short) {
      why = chain
        ? 'Not enough NEAR on the test account for every stake.'
        : 'Not enough practice chips for every stake.';
    }
    return (
      <>
        <div className="qf-mkt-stakes__label qf-label qf-label--small">
          Stake · returns if <AgentName agent={agent} /> wins
        </div>
        <div className="qf-mkt-stakes">
          {m.stakes.map((st) => {
            const amount = amountOf(st);
            const q = m.quote(agent.agent_id, st);
            const placing = chain && m.pending?.kind === 'bet'
              && m.pending.agentId === agent.agent_id && m.pending.stake === amount;
            const disabled = (chain && Boolean(m.pending)) || (m.balance != null && amount > m.balance);
            return (
              <button
                key={keyOf(st)}
                type="button"
                className={`qf-btn qf-btn--amber qf-mkt-stake${placing ? ' is-busy' : ''}`}
                disabled={disabled}
                onClick={() => place(st)}
                aria-label={chain
                  ? `Bet ${fmt(amount)} NEAR on ${agent.name}${q != null ? `, returns ${fmt(q)} NEAR if it wins` : ''}`
                  : `Back ${agent.name} with ${fmt(amount)} practice chips${q != null ? `, returns ${fmt(q)} if it wins` : ''}`}
              >
                {placing ? (
                  <span className="qf-mkt-stake__amt qf-mkt-stake__amt--busy">Sending…</span>
                ) : (
                  <span className="qf-mkt-stake__amt">
                    {fmt(amount)}
                    <span className="qf-unit">{unit}</span>
                  </span>
                )}
                <span className="qf-mkt-stake__ret">
                  {q != null ? <>Returns <b>{fmt(q)}</b></> : 'No price yet'}
                </span>
              </button>
            );
          })}
        </div>
        {why && <p className="qf-mkt-why">{why}</p>}
        {chain && <p className="qf-mkt-soon">{closesSoon(phase)}</p>}
      </>
    );
  };

  // Without a test account: what a bet would return, then the offer to make one.
  const offerBlock = (withExample) => {
    const st = m.stakes[1] ?? m.stakes[0];
    const q = withExample && st ? m.quote(agent.agent_id, st) : null;
    return (
      <>
        {q != null && (
          <p className="qf-mkt-msg">
            A {fmt(amountOf(st))} NEAR bet now returns {fmt(q)} NEAR if {agent.name} wins.
          </p>
        )}
        <AccountOffer />
        <p className="qf-mkt-soon">{closesSoon(phase)}</p>
      </>
    );
  };

  let head = null;
  let body;
  if (chain && m.readState === 'loading') {
    body = <p className="qf-mkt-msg is-waiting">Reading this season&apos;s market on NEAR…</p>;
  } else if (chain && m.readState === 'waiting') {
    body = <p className="qf-mkt-msg is-waiting">This season&apos;s market is opening on NEAR…</p>;
  } else if (!agent) {
    head = <div className="qf-mkt-slip__head"><span className="qf-label qf-label--strong">Back an agent</span></div>;
    body = closed ? (
      <Closed reason={closed} onSeeBets={onSeeBets} hasStake={m.myTotal > 0} />
    ) : (
      <>
        <QuickPicks agents={picks} onFollow={onFollow} label="Pick one to fill the slip" />
        <p className="qf-mkt-msg">
          {hasAccount
            ? `Pick an agent above to back it with ${chain ? 'testnet NEAR' : 'practice chips'}.`
            : 'Pick an agent above to see its pool and odds.'}
        </p>
        {!hasAccount && <><AccountOffer /><p className="qf-mkt-soon">{closesSoon(phase)}</p></>}
      </>
    );
  } else {
    head = (
      <div className="qf-mkt-slip__head">
        <span className="qf-label">Back</span>
        <AgentHex agent={agent} size={24} />
        <AgentName agent={agent} className="qf-mkt-slip__name" />
        {x != null && <span className="qf-num qf-num--large qf-mkt-slip__odds">×{fmtOdds(x)}</span>}
      </div>
    );
    if (!backable) {
      body = (
        <>
          <p className="qf-mkt-msg">{agent.name} has no agent pass in this season, so there is no market on it.</p>
          {closed ? (
            <Closed reason={closed} onSeeBets={onSeeBets} hasStake={m.myTotal > 0} />
          ) : (
            <>
              <QuickPicks agents={picks} onFollow={onFollow} label="Back another agent" />
              {!hasAccount && offerBlock(false)}
            </>
          )}
        </>
      );
    } else {
      let action;
      if (closed) action = <Closed reason={closed} onSeeBets={onSeeBets} hasStake={m.myTotal > 0} />;
      else if (!agent.alive) action = <p className="qf-mkt-msg">{agent.name} is out of the fight.</p>;
      else if (!hasAccount) action = offerBlock(true);
      else action = stakesBlock();
      body = (
        <>
          <div className="qf-mkt-figures">
            <div className="qf-row">
              <span>Pool on {agent.name}</span>
              <Amount value={onAgent} unit={unit} fmt={fmt} tone="amber" />
            </div>
            <div className="qf-row">
              <span>Your stake on {agent.name}</span>
              <Amount value={hasAccount ? mine : null} unit={unit} fmt={fmt} tone="ice" />
            </div>
            <div className="qf-row">
              <span>Pays if {agent.name} wins</span>
              <Amount value={win} unit={unit} fmt={fmt} tone="amber" />
            </div>
          </div>
          {action}
        </>
      );
    }
  }

  return (
    <section
      className={`qf-panel qf-mkt-slip${open ? ' qf-panel--amber' : ''}`}
      aria-label="Bet slip"
    >
      {head}
      {body}
      {chain ? (
        <Notice notice={m.notice} onDismiss={m.dismissNotice} />
      ) : (
        <Notice notice={simNotice} onDismiss={() => setSimNotice(null)} />
      )}
      {chain && m.feedError && (
        <p className="qf-mkt-warn"><IconWarn size={14} /><span>{m.feedError}</span></p>
      )}
      {!chain && (m.note
        ? <p className="qf-mkt-msg qf-mkt-practice-note">{m.note}</p>
        : <p className="qf-mkt-practice">Practice chips · not NEAR</p>)}
    </section>
  );
}

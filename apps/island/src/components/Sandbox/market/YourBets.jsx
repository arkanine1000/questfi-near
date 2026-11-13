/**
 * YOUR BETS: every agent the viewer backed this season, what each stake
 * stands to pay while the season runs and how it ended once it has, the
 * totals, and the result: waiting for the chain, a claim, or the loss.
 */

import { useSandbox } from '../../../context/SandboxContext';
import { useLayout } from '../../../context/LayoutContext';
import { formatNear, isOver } from '../../../services/marketMath';
import { useBets } from '../BettingContext';
import { IconDead } from '../../ui/icons';
import { AccountOffer } from './BetSlip';
import {
  AgentHex, AgentName, Amount, Notice, TxLink, moneyOf,
} from './bits';

/** The chain's result for this account, in the words the rail has always used. */
function ChainResult({ payout }) {
  const { tv } = useLayout();
  const { claim, pending } = useBets();
  const busy = pending?.kind === 'claim';

  let why;
  if (payout.cancelled) why = 'The season was cancelled: every bet is refunded.';
  else if (payout.refund) why = 'Nobody backed the winner: every bet is refunded.';
  else if (payout.winnerName) why = `${payout.winnerName} won the season.`;
  else why = 'The season is settled.';

  if (payout.state === 'waiting') {
    return <p className="qf-mkt-wait">Game over. Waiting for the result to settle on chain…</p>;
  }
  if (payout.state === 'paid') {
    return (
      <div className="qf-panel qf-mkt-result">
        <div className="qf-label">Claimed</div>
        <div className="qf-mkt-result__line">
          <Amount value={payout.amount} unit="NEAR" fmt={formatNear} tone="amber" size="large" />
          <span className="qf-mkt-result__paid">paid</span>
        </div>
        <TxLink hash={payout.txHash} />
      </div>
    );
  }
  if (payout.state === 'lost') {
    return (
      <div className="qf-mkt-result qf-mkt-result--lost">
        <p className="qf-mkt-msg">{why}</p>
        <p className="qf-mkt-msg">Your {formatNear(payout.staked)} NEAR stays in the pool.</p>
      </div>
    );
  }
  return (
    <div className="qf-panel qf-panel--amber qf-mkt-result">
      <p className="qf-mkt-msg">{why}</p>
      <div className="qf-label qf-mkt-result__claim">You can claim</div>
      <Amount value={payout.amount} unit="NEAR" fmt={formatNear} tone="amber" size="hero" />
      {!tv && (
        <button
          type="button"
          className={`qf-btn qf-btn--amber qf-btn--big qf-btn--wide qf-mkt-claim${busy ? ' is-busy' : ''}`}
          onClick={claim}
          disabled={Boolean(pending)}
        >
          {busy ? 'Claiming…' : 'Claim'}
        </button>
      )}
    </div>
  );
}

/** The practice market settles itself when the game ends. */
function SimResult({ payout }) {
  const { fmt, unit } = moneyOf({ mode: 'sim' });
  if (payout.won) {
    return (
      <div className="qf-panel qf-panel--amber qf-mkt-result">
        <div className="qf-label">Crown backed · payout</div>
        <Amount value={payout.amount} unit={unit} fmt={(n) => `+${fmt(n)}`} tone="amber" size="hero" />
      </div>
    );
  }
  return (
    <div className="qf-mkt-result qf-mkt-result--lost">
      <p className="qf-mkt-msg">The island keeps your {fmt(payout.amount)} practice chips</p>
    </div>
  );
}

export default function YourBets({ onFollow }) {
  const { roster, world } = useSandbox();
  const m = useBets();
  const { chain, unit, fmt } = moneyOf(m);
  const byId = new Map(roster.map((a) => [a.agent_id, a]));
  const entries = Object.entries(m.bets).filter(([, v]) => v > 0);
  const hasAccount = !chain || m.hasAccount;

  // How each stake ended, once the season has: on chain when the contract
  // settles or cancels it, in practice when the game ends.
  const settled = chain ? isOver(m.status) : world?.phase === 'finished';
  const refunded = chain && (m.status === 'cancelled' || Boolean(m.payout?.refund));
  const winnerId = (chain ? m.winnerId : null) ?? world?.winner ?? null;
  const wonAmount = (id) => {
    if (chain && (m.payout?.state === 'claimable' || m.payout?.state === 'paid')) return m.payout.amount;
    if (!chain && m.payout?.won) return m.payout.amount;
    return m.ifWins(id);
  };

  const rows = entries.map(([id, stake]) => {
    const agent = byId.get(id) ?? null;
    const name = agent ? agent.name : `Pass #${id.replace(/^pass:/, '')}`;
    let outcome;
    if (settled && refunded) {
      outcome = <span className="qf-mkt-bet__out is-refunded">Refunded</span>;
    } else if (settled && winnerId != null) {
      outcome = id === winnerId ? (
        <span className="qf-mkt-bet__out is-won">
          Won <Amount value={wonAmount(id)} unit={unit} fmt={fmt} tone="amber" size="small" />
        </span>
      ) : (
        <span className="qf-mkt-bet__out is-lost">Lost</span>
      );
    } else if (settled) {
      outcome = <span className="qf-mkt-bet__out">—</span>;
    } else {
      outcome = <Amount value={m.ifWins(id)} unit={unit} fmt={fmt} tone="amber" size="small" />;
    }
    const dead = agent && !agent.alive;
    return (
      <tr key={id} className={`qf-mkt-bet${dead ? ' is-dead' : ''}`}>
        <th scope="row" className="qf-mkt-bet__agent">
          {agent ? (
            <button
              type="button"
              className="qf-mkt-bet__who"
              onClick={() => onFollow?.(agent)}
              disabled={!agent.alive}
              aria-label={agent.alive ? `Follow ${agent.name}` : `${agent.name}, out of the fight`}
            >
              <AgentHex agent={agent} size={24} />
              <AgentName agent={agent} />
              {dead && <IconDead size={14} className="qf-mkt-bet__dead" />}
            </button>
          ) : (
            <span className="qf-mkt-bet__who"><AgentHex agent={null} size={24} /><span className="qf-mkt-name">{name}</span></span>
          )}
        </th>
        <td><Amount value={stake} unit={unit} fmt={fmt} tone="ice" size="small" /></td>
        <td>{outcome}</td>
      </tr>
    );
  });

  return (
    <div className="qf-mkt-yours">
      {entries.length === 0 ? (
        <p className="qf-mkt-msg">You have not backed anyone this season.</p>
      ) : (
        <table className="qf-mkt-bets">
          <caption className="qf-mkt-sr">Your bets this season</caption>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Stake</th>
              <th scope="col">{settled ? 'Result' : 'Pays if it wins'}</th>
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      )}

      <div className="qf-mkt-totals">
        {entries.length > 0 && (
          <div className="qf-row">
            <span>Staked</span>
            <Amount value={m.myTotal} unit={unit} fmt={fmt} tone="ice" />
          </div>
        )}
        <div className="qf-row">
          <span>Balance</span>
          <Amount value={hasAccount ? m.balance : null} unit={unit} fmt={fmt} tone="ice" />
        </div>
      </div>

      {chain && !hasAccount && m.bettingOpen && <AccountOffer />}

      {m.payout && (chain ? <ChainResult payout={m.payout} /> : <SimResult payout={m.payout} />)}

      {chain && <Notice notice={m.notice} onDismiss={m.dismissNotice} />}
    </div>
  );
}

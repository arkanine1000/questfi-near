/**
 * Small pieces the market dock's tabs share: money in the market's own unit,
 * an agent's hexagon and name in its colour, a transaction link, and the
 * line that reports a bet or a claim.
 */

import { useEffect, useRef } from 'react';
import { formatNear } from '../../../services/marketMath';
import { explorerTx, shortHash } from '../../../services/explorer';
import { IconClose, IconExternal } from '../../ui/icons';

/** A payout multiple as text: two decimals while it is small. */
export const fmtOdds = (x) => (x < 10 ? x.toFixed(2) : x.toFixed(1));

/**
 * What a stake returns, short enough for its button: two decimals, three
 * only below 0.01, rounded down so the button never promises more than the
 * contract pays. Practice chips are whole numbers already.
 */
export function fmtReturn(n, chain) {
  if (!chain) return Math.round(n).toLocaleString('en-US');
  const places = n < 0.01 ? 3 : 2;
  const k = 10 ** places;
  return (Math.floor(n * k) / k).toFixed(places).replace(/\.?0+$/, '') || '0';
}

/** An implied win chance as a whole percentage. */
export const fmtPct = (p) => `${Math.round(p * 100)}%`;

/**
 * How this market counts money. On chain it is NEAR, shown to the precision
 * formatNear gives; in the simulation it is whole practice chips.
 */
export function moneyOf(market) {
  const chain = market.mode === 'chain';
  return {
    chain,
    unit: chain ? 'NEAR' : 'CHIPS',
    fmt: chain ? (n) => formatNear(n) : (n) => Math.round(n).toLocaleString('en-US'),
    // a stake as the market hands it over: {near, yocto} on chain, a number of chips otherwise
    amountOf: chain ? (st) => st.near : (st) => st,
    keyOf: chain ? (st) => String(st.yocto) : (st) => String(st),
  };
}

/** A value with its unit after it, in the house numerals. */
export function Amount({
  value, unit, fmt, tone = '', size = '', className = '',
}) {
  const cls = ['qf-num', tone && `qf-num--${tone}`, size && `qf-num--${size}`, className].filter(Boolean).join(' ');
  return (
    <span className={cls}>
      {value == null ? '—' : fmt(value)}
      {value != null && <span className="qf-unit">{unit}</span>}
    </span>
  );
}

/** An agent's hexagon in its colour; from 20px up it carries the initial. */
export function AgentHex({ agent, size = 24 }) {
  const dead = agent && !agent.alive;
  return (
    <span
      className={`qf-hex qf-mkt-hex${size < 20 ? ' qf-hex--solid' : ''}${dead ? ' is-dead' : ''}`}
      style={{ '--hex': `${size}px`, '--agent': agent?.color || 'var(--qf-green)' }}
      aria-hidden
    >
      {size >= 20 && agent ? String(agent.name || '?').charAt(0).toUpperCase() : null}
    </span>
  );
}

/** An agent's name, uppercase, in its own colour (lifted when the colour is dark). */
export function AgentName({ agent, className = '' }) {
  return (
    <span className={`qf-mkt-name ${className}`} style={{ '--agent': agent?.color || 'var(--qf-green)' }}>
      {agent?.name ?? ''}
    </span>
  );
}

/** A transaction on the testnet explorer. */
export function TxLink({ hash, children }) {
  if (!hash) return null;
  return (
    <a
      className="qf-mkt-tx"
      href={explorerTx(hash)}
      target="_blank"
      rel="noreferrer"
      aria-label={`Transaction ${shortHash(hash)} on the NEAR explorer`}
    >
      <span>{children ?? shortHash(hash)}</span>
      <IconExternal size={12} />
    </a>
  );
}

/**
 * The line that reports a bet or a claim: what happened, the transaction,
 * and a way to dismiss it. The live region is always in the page, so a
 * screen reader hears the report when it arrives.
 */
export function Notice({ notice, onDismiss }) {
  // A report lands at the foot of a panel that may be scrolled; bring it
  // into view, so a bettor sees what became of the bet without hunting.
  const ref = useRef(null);
  useEffect(() => {
    if (!notice || !ref.current) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    ref.current.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  }, [notice]);
  return (
    <div className="qf-mkt-live" aria-live="polite" ref={ref}>
      {notice && (
        <p className={`qf-mkt-notice qf-mkt-notice--${notice.tone}`} role={notice.tone === 'bad' ? 'alert' : undefined}>
          <span className="qf-mkt-notice__text">{notice.text}</span>
          <TxLink hash={notice.txHash} />
          {onDismiss && (
            <button type="button" className="qf-x qf-mkt-notice__x" onClick={onDismiss} aria-label="Dismiss">
              <IconClose size={13} />
            </button>
          )}
        </p>
      )}
    </div>
  );
}

/** Today's reason the market is closed, or null while it is open. */
export function closedReason({
  chain, status, phase, bettingOpen,
}) {
  if (!chain) return bettingOpen ? null : 'The game is over. Practice bets settled the moment it ended.';
  if (status === 'settled') return 'The season is settled on chain.';
  if (status === 'cancelled') return 'The season was cancelled on chain; every bet is refunded.';
  if (phase === 'finished') return 'The game is over. Bets stay closed while the result settles on chain.';
  if (!bettingOpen) return 'The market locked a few ticks into the season, so nobody bets on a fight that is already decided.';
  return null;
}

/** While betting is open on chain: it will not stay open for long. */
export const closesSoon = (phase) => (phase === 'lobby'
  ? 'Betting closes shortly after the season starts.'
  : 'Betting closes any moment now: the market locks a few ticks into the season.');

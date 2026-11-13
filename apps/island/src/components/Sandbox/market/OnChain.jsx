/**
 * ON CHAIN: where this season lives on NEAR, and every transaction it has
 * seen: the game server's (season, kills, settle) with this browser's own
 * bets and claims, newest first.
 */

import { useEffect, useState } from 'react';
import { useSandbox } from '../../../context/SandboxContext';
import { getWorldState } from '../../../services/sandboxApi';
import { explorerAccount, explorerTx, shortAccount, shortHash } from '../../../services/explorer';
import { useBets } from '../BettingContext';
import { IconExternal, IconWarn } from '../../ui/icons';

const isOverStatus = (s) => /^(settled|cancelled)$/i.test(String(s ?? ''));

/**
 * The game server's `near` block (GET /world/{id}/state), kept fresh while
 * the market is on screen. The stream frames do not carry it, so it is read
 * every five seconds until the season is final on chain and nothing is
 * queued.
 */
export function useNearBlock(active) {
  const { world } = useSandbox();
  const worldId = world?.world_id;
  const [block, setBlock] = useState(world?.near ?? null);
  useEffect(() => { setBlock(world?.near ?? null); }, [world?.near]);
  const enabled = Boolean(active && block?.enabled);
  const done = isOverStatus(block?.season_status) && !block?.queue_depth;
  useEffect(() => {
    if (!worldId || !enabled || done) return undefined;
    let stop = false;
    const id = setInterval(async () => {
      try {
        const state = await getWorldState(worldId);
        if (!stop && state?.near) setBlock(state.near);
      } catch { /* the next read tries again */ }
    }, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [worldId, enabled, done]);
  return block;
}

const STATUS_TONE = {
  open: '', running: '', settled: 'amber', cancelled: 'red',
};

/** The season's state on chain as a pill. */
export function SeasonPill({ status }) {
  const s = String(status ?? '').toLowerCase();
  if (!s) return <span className="qf-pill qf-pill--off">Unknown</span>;
  const tone = STATUS_TONE[s] ?? '';
  return (
    <span className={`qf-pill qf-mkt-pill${tone ? ` qf-pill--${tone}` : ''}`}>
      {(s === 'open' || s === 'running') && <i className="qf-dot" aria-hidden />}
      {s}
    </span>
  );
}

function AccountLink({ id }) {
  return (
    <a className="qf-mkt-tx qf-mkt-acct" href={explorerAccount(id)} target="_blank" rel="noreferrer" aria-label={`${id} on the NEAR explorer`}>
      <span>{shortAccount(id, 26)}</span>
      <IconExternal size={12} />
    </a>
  );
}

export default function OnChain({ block }) {
  const {
    txs, status, contractId, accountId,
  } = useBets();

  const server = (Array.isArray(block?.recent_txs) ? block.recent_txs : [])
    .filter((t) => t && t.tx_hash)
    .map((t, i) => ({
      key: `s-${t.tx_hash}-${i}`,
      who: 'server',
      method: t.method || 'call',
      hash: t.tx_hash,
      ok: t.ok !== false,
      at: Date.parse(t.at) || 0,
      order: i,
    }));
  const mine = (txs ?? []).filter((t) => t?.txHash).map((t, i) => ({
    key: `m-${t.txHash}-${i}`,
    who: 'you',
    method: t.method,
    label: t.label,
    hash: t.txHash,
    ok: t.ok !== false,
    at: t.at || 0,
    order: i,
  }));
  const rows = [...server, ...mine].sort((a, b) => (b.at - a.at) || (a.order - b.order));

  return (
    <div className="qf-mkt-chain">
      <div className="qf-mkt-chain__facts">
        <div className="qf-row">
          <span>Season</span>
          <SeasonPill status={status || block?.season_status} />
        </div>
        {contractId && (
          <div className="qf-row">
            <span>Contract</span>
            <AccountLink id={contractId} />
          </div>
        )}
        {accountId && (
          <div className="qf-row">
            <span>Your account</span>
            <AccountLink id={accountId} />
          </div>
        )}
      </div>

      {block?.chain_error && (
        <p className="qf-mkt-warn" role="status">
          <IconWarn size={14} />
          <span>The game server cannot reach NEAR right now; results post when it can.</span>
        </p>
      )}

      <div className="qf-label qf-label--small qf-mkt-feed__label">Transactions</div>
      {rows.length === 0 ? (
        <p className="qf-mkt-msg">No transactions yet.</p>
      ) : (
        <ul className="qf-mkt-feed" aria-label="Transactions on chain, newest first">
          {rows.map((r) => (
            <li key={r.key}>
              <a
                className={`qf-mkt-feed__row${r.ok ? '' : ' is-failed'}${r.who === 'you' ? ' is-mine' : ''}`}
                href={explorerTx(r.hash)}
                target="_blank"
                rel="noreferrer"
                title={r.label || undefined}
                aria-label={`${r.who === 'you' ? 'You' : 'Game'}: ${r.label || r.method}${r.ok ? '' : ', failed'}, transaction ${shortHash(r.hash)} on the NEAR explorer`}
              >
                <span className="qf-mkt-feed__who">{r.who === 'you' ? 'You' : 'Game'}</span>
                <span className="qf-mkt-feed__method">{r.method}</span>
                {!r.ok && <span className="qf-mkt-feed__fail">Failed</span>}
                <span className="qf-mkt-feed__hash">
                  {shortHash(r.hash)}
                  <IconExternal size={12} />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

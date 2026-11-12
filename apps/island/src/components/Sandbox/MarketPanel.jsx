/**
 * The market rail — the left panel as a prediction market. Win-probability
 * chart for the four front-runners on top (scrub it to read back the
 * season), every challenger priced below, the pool ledger at the foot.
 *
 * Chips keep all their old jobs: clicking follows, hovering unfolds stake
 * buttons, combat pulses, the dead go to ash. Color always belongs to the
 * agent — the chart lines, dots and beacons all share it, so identity is
 * carried by name labels, never by hue alone.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSandbox } from '../../context/SandboxContext';
import { getWorldState } from '../../services/sandboxApi';
import { formatNear } from '../../services/marketMath';
import { explorerTx, shortHash } from '../../services/explorer';
import { IS_TV } from '../../services/cast';
import { STAKES, useBets } from './BettingContext';

/** A payout multiple as text: two decimals while it is small. */
const fmtOdds = (x) => (x < 10 ? x.toFixed(2) : x.toFixed(1));

function TxLink({ hash, children }) {
  if (!hash) return null;
  return (
    <a className="sbx-txlink" href={explorerTx(hash)} target="_blank" rel="noreferrer">
      {children ?? `tx ${shortHash(hash)}`} ↗
    </a>
  );
}

// Mirrors the CSS compact tier — the market auto-folds underground there.
const COMPACT_MQ = '(max-width: 1100px), (max-height: 640px)';

function useCompactViewport() {
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_MQ).matches);
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_MQ);
    const onChange = () => setCompact(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return compact;
}

const CHART_W = 320;
const CHART_H = 150;
const PAD_T = 10;
const PAD_B = 8;
const PAD_R = 42; // room for the % gridline labels

/** Snap the y-ceiling to a readable step just above the season's peak. */
const niceMax = (v) => [0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1].find((s) => v <= s - 0.02) ?? 1;

function MarketChart({ onFollow }) {
  const { roster } = useSandbox();
  const { probHistory } = useBets();
  const [cursor, setCursor] = useState(null); // history index while scrubbing

  const living = roster.filter((a) => a.alive);
  const latest = probHistory[probHistory.length - 1];

  // Only agents the market prices (on chain, an agent without a pass has
  // none) get a line and a legend entry.
  const top = useMemo(() => living
    .filter((a) => latest?.probs[a.agent_id] != null)
    .sort((a, b) => (latest?.probs[b.agent_id] ?? 0) - (latest?.probs[a.agent_id] ?? 0))
    .slice(0, 4), [living, latest]);

  const series = useMemo(() => top.map((agent) => ({
    agent,
    pts: probHistory
      .map((s) => [s.tick, s.probs[agent.agent_id]])
      .filter(([, p]) => p != null),
  })), [top, probHistory]);

  if (probHistory.length < 2 || !top.length) {
    return (
      <div className="sbx-market__chartcard is-forming">
        <span>market forming…</span>
      </div>
    );
  }

  const x0 = probHistory[0].tick;
  const x1 = probHistory[probHistory.length - 1].tick;
  const span = Math.max(1, x1 - x0);
  const peak = Math.max(...series.flatMap(({ pts }) => pts.map(([, p]) => p)));
  const yMax = niceMax(peak);
  const X = (t) => ((t - x0) / span) * (CHART_W - PAD_R);
  const Y = (p) => PAD_T + (1 - p / yMax) * (CHART_H - PAD_T - PAD_B);

  const sample = cursor != null ? probHistory[cursor] : null;
  const shown = sample ?? latest;

  const scrub = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const t = x0 + frac * span;
    let best = 0;
    let bestD = Infinity;
    probHistory.forEach((s, i) => {
      const d = Math.abs(s.tick - t);
      if (d < bestD) { bestD = d; best = i; }
    });
    setCursor(best);
  };

  return (
    <div className="sbx-market__chartcard">
      <div className="sbx-market__legend">
        {top.map((agent) => (
          <button
            key={agent.agent_id}
            type="button"
            style={{ '--chip-color': agent.color }}
            onClick={() => onFollow?.(agent)}
            title={`Follow ${agent.name}`}
          >
            <i aria-hidden />
            <span>{agent.name}</span>
            <strong>{Math.round((shown?.probs[agent.agent_id] ?? 0) * 100)}%</strong>
          </button>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="sbx-market__plot"
        role="img"
        aria-label={`Win odds over ticks — ${top.map((a) => a.name).join(', ')}`}
        onMouseMove={scrub}
        onMouseLeave={() => setCursor(null)}
      >
        {[yMax, yMax / 2].map((v) => (
          <g key={v}>
            <line
              className="sbx-market__grid"
              x1="0"
              x2={CHART_W - PAD_R}
              y1={Y(v)}
              y2={Y(v)}
            />
            <text className="sbx-market__axis" x={CHART_W - PAD_R + 5} y={Y(v) + 3}>
              {Math.round(v * 100)}%
            </text>
          </g>
        ))}
        <line
          className="sbx-market__grid is-base"
          x1="0"
          x2={CHART_W - PAD_R}
          y1={Y(0)}
          y2={Y(0)}
        />
        {sample && (
          <line
            className="sbx-market__cursor"
            x1={X(sample.tick)}
            x2={X(sample.tick)}
            y1={PAD_T - 3}
            y2={CHART_H - PAD_B + 3}
          />
        )}
        {series.map(({ agent, pts }) => (
          <g key={agent.agent_id} style={{ '--chip-color': agent.color }}>
            <polyline
              className="sbx-market__line"
              points={pts.map(([t, p]) => `${X(t)},${Y(p)}`).join(' ')}
            />
            {pts.length > 0 && (
              <circle
                className="sbx-market__enddot"
                cx={X((sample ? pts.find(([t]) => t >= sample.tick) : null)?.[0] ?? pts[pts.length - 1][0])}
                cy={Y((sample ? pts.find(([t]) => t >= sample.tick) : null)?.[1] ?? pts[pts.length - 1][1])}
                r="2.4"
              />
            )}
          </g>
        ))}
      </svg>
      <div className="sbx-market__xlabel">
        {sample ? `tick ${sample.tick}` : `tick ${x0} — ${x1}`}
      </div>
    </div>
  );
}

function Chip({ agent, followed, onClick }) {
  const {
    mode, odds, prob, bets, place, bettingOpen, balance, pools, canBack, readState,
  } = useBets();
  const onChain = mode === 'chain';
  // On chain, only an agent whose pass is entered in the season has a market
  // (unknown until the market has been read).
  const known = !onChain || readState === 'live';
  const backable = !onChain || (known && canBack(agent));
  const hpFrac = agent.max_hp ? Math.max(0, agent.hp / agent.max_hp) : 0;
  const x = agent.alive && backable ? odds(agent.agent_id) : null;
  const p = agent.alive ? prob(agent.agent_id) : 0;
  const myStake = bets[agent.agent_id] ?? 0;
  // The chain market takes bets in the bet slip below the list, where the
  // stake, its return and the transaction stay on screen.
  const canBet = bettingOpen && agent.alive && !onChain;
  const cls = [
    'sbx-chipwrap',
    followed ? 'is-followed' : '',
    !agent.alive ? 'is-dead' : '',
    agent.alive && agent.in_combat ? 'is-fighting' : '',
    onChain ? 'is-chain' : '',
  ].filter(Boolean).join(' ');
  let price = null;
  if (agent.alive) {
    if (!onChain) price = `${Math.round(p * 100)}%`;
    else if (backable) price = pools.total > 0 ? `${Math.round(p * 100)}%` : '—';
  }
  const noMarket = onChain && known && !backable;

  return (
    <div className={cls} style={{ '--chip-color': agent.color }}>
      <button
        type="button"
        className="sbx-chip"
        onClick={onClick}
        title={agent.alive
          ? `Follow ${agent.name}`
          : `${agent.name} — ${agent.cause_of_death || 'fallen'}`}
      >
        <span className="sbx-chip__dot" aria-hidden />
        <span className="sbx-chip__body">
          <span className="sbx-chip__name">
            {agent.name}
            {agent.brain === 'external' && <span className="sbx-chip__byo" title="External agent">API</span>}
          </span>
          {agent.alive ? (
            <span className="sbx-chip__hp">
              <span className="sbx-chip__hpfill" style={{ width: `${hpFrac * 100}%` }} />
            </span>
          ) : (
            <span className="sbx-chip__fate">☠ {agent.cause_of_death || 'fallen'}</span>
          )}
        </span>
        <span className="sbx-chip__meta">
          {price && <span className="sbx-chip__prob">{price}</span>}
          {noMarket && <span className="sbx-chip__nopass">no pass</span>}
          <span className="sbx-chip__badges">
            {agent.alive && <span className="sbx-chip__hpnum">{agent.hp}</span>}
            {agent.kills > 0 && <span className="sbx-chip__kills">⚔{agent.kills}</span>}
            {x != null && <span className="sbx-chip__odds">×{onChain ? fmtOdds(x) : x.toFixed(1)}</span>}
            {myStake > 0 && (
              <span className="sbx-chip__stake">{onChain ? `${formatNear(myStake)} NEAR` : `⬡${myStake}`}</span>
            )}
          </span>
        </span>
      </button>
      {canBet && (
        <div className="sbx-chip__bets" aria-label={`Back ${agent.name}`}>
          <span className="sbx-chip__betlabel">back · chips</span>
          {STAKES.map((s) => (
            <button
              key={s}
              type="button"
              disabled={s > balance}
              onClick={(e) => { e.stopPropagation(); place(agent, s); }}
              aria-label={`Back ${agent.name} with ${s} practice chips`}
            >
              +{s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Ledger() {
  const {
    mode, balance, myTotal, pools, payout, note,
  } = useBets();
  if (mode === 'chain') return <ChainLedger />;
  return (
    <div className="sbx-market__ledger">
      {note && <div className="sbx-market__note">{note}</div>}
      {payout && (
        <div className={`sbx-bets__payout${payout.won ? ' is-won' : ''}`}>
          {payout.won
            ? `Crown backed — payout +${payout.amount.toLocaleString()} practice chips`
            : `The island keeps your ${payout.amount.toLocaleString()} practice chips`}
        </div>
      )}
      <div className="sbx-market__ledgerrow" title="Parimutuel pool — simulated funds, no chain">
        <span className="sbx-market__ledgerseg">◈ pool {pools.total.toLocaleString()} ⬡</span>
        <span className="sbx-market__ledgerseg">yours {balance.toLocaleString()} ⬡</span>
        {myTotal > 0 && (
          <span className="sbx-market__ledgerseg">staked {myTotal.toLocaleString()} ⬡</span>
        )}
        <span className="sbx-bets__sim sbx-bets__practice">practice chips · not NEAR</span>
      </div>
    </div>
  );
}

/**
 * Why betting is closed, as prominent as the stake buttons it replaces:
 * when it closed and why.
 */
function closedReason({ status, phase, bettingOpen }) {
  if (status === 'settled') return 'The season is settled on chain.';
  if (status === 'cancelled') return 'The season was cancelled on chain; every bet is refunded.';
  if (phase === 'finished') return 'The game is over. Bets stay closed while the result settles on chain.';
  if (!bettingOpen) return 'The market locked a few ticks into the season, so nobody bets on a fight that is already decided.';
  return null;
}

/** While betting is open: it will not stay open for long. */
const closesSoon = (phase) => (phase === 'lobby'
  ? 'Betting closes shortly after the season starts.'
  : 'Betting closes any moment now: the market locks a few ticks into the season.');

/** In place of the stakes when this browser has no test account yet. */
function AccountOffer() {
  const { accountStatus, accountError, createTestAccount } = useBets();
  const busy = accountStatus === 'creating' || accountStatus === 'loading';
  let label = 'Play with a test account to bet';
  if (accountStatus === 'creating') label = 'Creating your test account…';
  else if (accountStatus === 'loading') label = 'Looking for your test account…';
  return (
    <div className="sbx-slip__join">
      <button type="button" className="sbx-slip__account" onClick={createTestAccount} disabled={busy}>
        {label}
      </button>
      {accountError && <p className="sbx-slip__notice is-bad" role="alert"><span>{accountError}</span></p>}
    </div>
  );
}

/**
 * The chain market's bet slip: the followed agent, what is on it, and three
 * stakes with what each returns if that agent wins. Every number the bettor
 * acts on is here in full, none of it behind a hover. Without a test account
 * the slip is read only and offers to make one.
 */
function BetSlip() {
  const { followedAgent, world } = useSandbox();
  const {
    stakes, quote, ifWins, odds, canBack, place, pending, notice, dismissNotice,
    bettingOpen, balance, bets, pools, status, feedError, readState, hasAccount,
  } = useBets();
  const agent = followedAgent;
  const live = readState === 'live';
  const backable = agent && live ? canBack(agent) : false;
  const onAgent = agent ? pools.byAgent[agent.agent_id] ?? 0 : 0;
  const mine = agent ? bets[agent.agent_id] ?? 0 : 0;
  const x = agent && backable ? odds(agent.agent_id) : null;
  const win = agent && mine > 0 ? ifWins(agent.agent_id) : null;
  const closed = live ? closedReason({ status, phase: world?.phase, bettingOpen }) : null;
  const open = live && !closed;

  // What takes the stake buttons' place, or the buttons themselves.
  const action = (agentCanBet) => {
    if (closed) {
      return (
        <div className="sbx-slip__closed" role="status">
          <strong>Betting closed</strong>
          <span>{closed}</span>
        </div>
      );
    }
    if (!open) return null;
    if (!hasAccount) {
      return (
        <>
          <AccountOffer />
          <p className="sbx-slip__soon">{closesSoon(world?.phase)}</p>
        </>
      );
    }
    if (!agentCanBet) return null;
    const short = stakes.some((st) => balance != null && st.near > balance);
    return (
      <>
        <div className="sbx-slip__caption">bet · returns if {agent.name} wins</div>
        <div className="sbx-slip__stakes">
          {stakes.map((st) => {
            const q = quote(agent.agent_id, st);
            const placing = pending?.kind === 'bet' && pending.agentId === agent.agent_id && pending.stake === st.near;
            return (
              <button
                key={String(st.yocto)}
                type="button"
                disabled={Boolean(pending) || (balance != null && st.near > balance)}
                onClick={() => place(agent, st)}
                aria-label={`Bet ${formatNear(st.near)} NEAR on ${agent.name}`}
              >
                {placing ? (
                  <span className="sbx-slip__stake is-busy">sending…</span>
                ) : (
                  <span className="sbx-slip__stake">
                    {formatNear(st.near)}
                    <small>NEAR</small>
                  </span>
                )}
                {q != null && <span className="sbx-slip__quote">→ {formatNear(q)}</span>}
              </button>
            );
          })}
        </div>
        <p className="sbx-slip__soon">{closesSoon(world?.phase)}</p>
        {short && <p className="sbx-slip__msg">Not enough NEAR on the test account for every stake.</p>}
      </>
    );
  };

  let body;
  if (readState === 'loading') {
    body = <p className="sbx-slip__msg">Reading this season&apos;s market on NEAR…</p>;
  } else if (readState === 'waiting') {
    body = <p className="sbx-slip__msg">This season&apos;s market is opening on NEAR…</p>;
  } else if (!agent) {
    body = (
      <>
        <p className="sbx-slip__msg">
          {hasAccount ? 'Pick an agent above to back it with testnet NEAR.' : 'Pick an agent above to see its pool and odds.'}
        </p>
        {action(false)}
      </>
    );
  } else if (!backable) {
    body = (
      <>
        <p className="sbx-slip__msg">{agent.name} has no agent pass in this season, so there is no market on it.</p>
        {action(false)}
      </>
    );
  } else {
    body = (
      <>
        <div className="sbx-slip__figures">
          <div>
            <span>on {agent.name}</span>
            <b>{formatNear(onAgent)} NEAR</b>
          </div>
          {hasAccount && (
            <div>
              <span>your stake</span>
              <b className={mine > 0 ? 'is-mine' : ''}>{formatNear(mine)} NEAR</b>
            </div>
          )}
          {win != null && (
            <div>
              <span>pays if it wins</span>
              <b className="is-win">{formatNear(win)} NEAR</b>
            </div>
          )}
        </div>
        {agent.alive || closed ? action(true) : <p className="sbx-slip__msg">{agent.name} is out of the fight.</p>}
      </>
    );
  }

  return (
    <section className="sbx-slip" style={agent ? { '--chip-color': agent.color } : undefined} aria-label="Bet slip">
      <header className="sbx-slip__head">
        <span className="sbx-slip__label">back</span>
        {agent && <i aria-hidden />}
        <strong className="sbx-slip__name">{agent ? agent.name : 'an agent'}</strong>
        {x != null && <span className="sbx-slip__odds">×{fmtOdds(x)}</span>}
      </header>
      {body}
      {pending?.kind === 'claim' && <p className="sbx-slip__notice">Claiming…</p>}
      {notice && (
        <p className={`sbx-slip__notice is-${notice.tone}`} role={notice.tone === 'bad' ? 'alert' : 'status'}>
          <span>{notice.text}</span>
          <TxLink hash={notice.txHash} />
          <button type="button" className="sbx-slip__dismiss" onClick={dismissNotice} aria-label="Dismiss">✕</button>
        </p>
      )}
      {feedError && <p className="sbx-slip__notice is-bad">{feedError}</p>}
    </section>
  );
}

/** The chain ledger: pool, the account's stake and balance, and the result. */
function ChainLedger() {
  const {
    balance, myTotal, pools, payout, claim, pending, hasAccount, readState,
  } = useBets();
  return (
    <div className="sbx-market__ledger">
      {payout && <ChainPayout payout={payout} claim={claim} busy={Boolean(pending)} />}
      <div className="sbx-market__ledgerrow sbx-market__ledgerrow--chain">
        <span className="sbx-market__fig">
          <small>pool</small>
          <b>{readState === 'live' ? formatNear(pools.total) : '…'}</b>
        </span>
        {hasAccount && (
          <>
            <span className="sbx-market__fig">
              <small>your stake</small>
              <b>{formatNear(myTotal)}</b>
            </span>
            <span className="sbx-market__fig">
              <small>balance</small>
              <b>{balance != null ? formatNear(balance) : '…'}</b>
            </span>
          </>
        )}
        <span className="sbx-bets__sim sbx-bets__net">{hasAccount ? 'NEAR testnet' : 'NEAR testnet · read only'}</span>
      </div>
    </div>
  );
}

function ChainPayout({ payout, claim, busy }) {
  let why;
  if (payout.cancelled) why = 'The season was cancelled: every bet is refunded.';
  else if (payout.refund) why = 'Nobody backed the winner: every bet is refunded.';
  else if (payout.winnerName) why = `${payout.winnerName} won the season.`;
  else why = 'The season is settled.';

  if (payout.state === 'waiting') {
    return <div className="sbx-bets__payout sbx-payout">Game over. Waiting for the result to settle on chain…</div>;
  }
  if (payout.state === 'paid') {
    return (
      <div className="sbx-bets__payout sbx-payout is-won">
        <span className="sbx-payout__why">Claimed</span>
        <span className="sbx-payout__amount">{formatNear(payout.amount)} NEAR paid</span>
        <TxLink hash={payout.txHash} />
      </div>
    );
  }
  if (payout.state === 'lost') {
    return (
      <div className="sbx-bets__payout sbx-payout">
        <span className="sbx-payout__why">{why}</span>
        <span>Your {formatNear(payout.staked)} NEAR stays in the pool.</span>
      </div>
    );
  }
  return (
    <div className="sbx-bets__payout sbx-payout is-won">
      <span className="sbx-payout__why">{why}</span>
      <span className="sbx-payout__amount">You can claim {formatNear(payout.amount)} NEAR</span>
      {!IS_TV && (
        <button type="button" className="sbx-btn sbx-btn--primary sbx-payout__claim" onClick={claim} disabled={busy}>
          {busy ? 'Claiming…' : 'Claim'}
        </button>
      )}
    </div>
  );
}

const TX_ROWS = 4;
const isOverStatus = (s) => /^(settled|cancelled)$/i.test(String(s ?? ''));

/**
 * The game server's `near` block (GET /world/{id}/state), kept fresh while
 * the drawer is open. The stream frames do not carry it, so it is read every
 * five seconds until the season is final on chain and nothing is queued.
 */
function useNearBlock() {
  const { world } = useSandbox();
  const worldId = world?.world_id;
  const [block, setBlock] = useState(world?.near ?? null);
  useEffect(() => { setBlock(world?.near ?? null); }, [world?.near]);
  const enabled = Boolean(block?.enabled);
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

/**
 * ON CHAIN: the newest transactions of this season, the game server's
 * (season, kills, settle) with this browser's own bets and claims.
 */
function OnChainFeed() {
  const block = useNearBlock();
  const { txs } = useBets();
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
  if (!block?.enabled && !mine.length) return null;
  const rows = [...server, ...mine]
    .sort((a, b) => (b.at - a.at) || (a.order - b.order))
    .slice(0, TX_ROWS);

  return (
    <section className="sbx-onchain" aria-label="On-chain transactions">
      <header className="sbx-onchain__head">
        <span>On chain</span>
        {block?.season_status && <span className="sbx-onchain__status">{String(block.season_status)}</span>}
      </header>
      {block?.chain_error && (
        <p className="sbx-onchain__warn">The game server cannot reach NEAR right now; results post when it can.</p>
      )}
      {rows.length === 0 && <p className="sbx-onchain__empty">No transactions yet.</p>}
      {rows.map((r) => (
        <a
          key={r.key}
          className={`sbx-onchain__row${r.ok ? '' : ' is-failed'}${r.who === 'you' ? ' is-mine' : ''}`}
          href={explorerTx(r.hash)}
          target="_blank"
          rel="noreferrer"
        >
          <span className="sbx-onchain__who">{r.who === 'you' ? 'you' : 'game'}</span>
          <span className="sbx-onchain__method">{r.who === 'you' && r.label ? r.label : r.method}</span>
          {!r.ok && <span className="sbx-onchain__fail">failed</span>}
          <span className="sbx-onchain__hash">{shortHash(r.hash)} ↗</span>
        </a>
      ))}
    </section>
  );
}

export default function MarketPanel({ onFollow }) {
  const {
    world, roster, followedAgentId, followedAgent,
  } = useSandbox();
  const { prob, mode } = useBets();
  const onChain = mode === 'chain';

  // Collapsible: auto-folds when a phone-sized screen is underground (the
  // crawler needs the pixels), auto-opens again topside. A manual toggle
  // wins until the next view transition resets it.
  const compact = useCompactViewport();
  const dungeon = followedAgent?.position?.kind === 'dungeon';
  const [collapsed, setCollapsed] = useState(compact && dungeon);
  useEffect(() => {
    setCollapsed(compact && dungeon);
  }, [compact, dungeon]);

  if (!roster.length) return null;
  // The simulated market opens with the season. The contract's opens with
  // the lobby, and the game server locks it a few ticks into the season, so
  // on chain the lobby is when most bets are placed.
  if (world?.phase === 'lobby' && !onChain) return null;

  // Market order: the priciest names first, the fallen at the bottom.
  const living = roster.filter((a) => a.alive)
    .sort((a, b) => prob(b.agent_id) - prob(a.agent_id));
  const fallen = roster.filter((a) => !a.alive);

  // Drawer, not modal: the rail stays mounted and slides off-screen, the
  // edge handle slides in to take its place — chart history stays warm.
  return (
    <>
      <button
        type="button"
        className={`sbx-market__handle${collapsed ? '' : ' is-open'}`}
        onClick={() => setCollapsed(false)}
        aria-expanded={!collapsed}
        tabIndex={collapsed ? 0 : -1}
        title="Pull out the prediction market"
      >
        <span className="sbx-market__handlearrow" aria-hidden>▸</span>
        <span className="sbx-market__handletext">market</span>
      </button>
      <nav
        className={`sbx-roster sbx-market${collapsed ? ' is-folded' : ''}${onChain ? ' is-chain' : ''}`}
        aria-label="Prediction market"
        aria-hidden={collapsed}
        inert={collapsed || undefined}
      >
        <div className="sbx-market__head">
          <span>Market</span>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-expanded="true"
            aria-label="Tuck the market away"
            title="Tuck away"
          >
            ◂
          </button>
        </div>
        <MarketChart onFollow={onFollow} />
      {/* five markets above the fold, the long tail scrolls */}
      <div className="sbx-market__list">
        {living.map((agent) => (
          <Chip
            key={agent.agent_id}
            agent={agent}
            followed={agent.agent_id === followedAgentId}
            onClick={() => onFollow?.(agent)}
          />
        ))}
        {fallen.length > 0 && <div className="sbx-roster__rule" aria-hidden />}
        {fallen.map((agent) => (
          <Chip key={agent.agent_id} agent={agent} followed={false} onClick={() => {}} />
        ))}
      </div>
        {onChain && !IS_TV && <BetSlip />}
        <Ledger />
        <OnChainFeed />
      </nav>
    </>
  );
}

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
import { STAKES, useBets } from './BettingContext';

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

  const top = useMemo(() => [...living]
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
  const { odds, prob, bets, place, bettingOpen, balance } = useBets();
  const hpFrac = agent.max_hp ? Math.max(0, agent.hp / agent.max_hp) : 0;
  const x = agent.alive ? odds(agent.agent_id) : null;
  const p = agent.alive ? prob(agent.agent_id) : 0;
  const myStake = bets[agent.agent_id] ?? 0;
  const canBet = bettingOpen && agent.alive;
  const cls = [
    'sbx-chipwrap',
    followed ? 'is-followed' : '',
    !agent.alive ? 'is-dead' : '',
    agent.alive && agent.in_combat ? 'is-fighting' : '',
  ].filter(Boolean).join(' ');

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
          {agent.alive && <span className="sbx-chip__prob">{Math.round(p * 100)}%</span>}
          <span className="sbx-chip__badges">
            {agent.alive && <span className="sbx-chip__hpnum">{agent.hp}</span>}
            {agent.kills > 0 && <span className="sbx-chip__kills">⚔{agent.kills}</span>}
            {x != null && <span className="sbx-chip__odds">×{x.toFixed(1)}</span>}
            {myStake > 0 && <span className="sbx-chip__stake">⬡{myStake}</span>}
          </span>
        </span>
      </button>
      {canBet && (
        <div className="sbx-chip__bets" aria-label={`Back ${agent.name}`}>
          <span className="sbx-chip__betlabel">back</span>
          {STAKES.map((s) => (
            <button
              key={s}
              type="button"
              disabled={s > balance}
              onClick={(e) => { e.stopPropagation(); place(agent, s); }}
              title={`Back ${agent.name} with ${s} sim-chips`}
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
  const { balance, myTotal, pools, payout } = useBets();
  return (
    <div className="sbx-market__ledger">
      {payout && (
        <div className={`sbx-bets__payout${payout.won ? ' is-won' : ''}`}>
          {payout.won
            ? `Crown backed — payout +${payout.amount.toLocaleString()} ⬡`
            : `The island keeps your ${payout.amount.toLocaleString()} ⬡`}
        </div>
      )}
      <div className="sbx-market__ledgerrow" title="Parimutuel pool — simulated funds, no chain">
        <span className="sbx-market__ledgerseg">◈ pool {pools.total.toLocaleString()} ⬡</span>
        <span className="sbx-market__ledgerseg">yours {balance.toLocaleString()} ⬡</span>
        {myTotal > 0 && (
          <span className="sbx-market__ledgerseg">staked {myTotal.toLocaleString()} ⬡</span>
        )}
        <span className="sbx-bets__sim">sim</span>
      </div>
    </div>
  );
}

export default function MarketPanel({ onFollow }) {
  const { roster, followedAgentId, followedAgent } = useSandbox();
  const { prob } = useBets();

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
        className={`sbx-roster sbx-market${collapsed ? ' is-folded' : ''}`}
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
        <Ledger />
      </nav>
    </>
  );
}

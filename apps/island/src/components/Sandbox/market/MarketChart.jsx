/**
 * The market's memory: each front-runner's implied win chance over the
 * season, one line per agent in its own colour. Scrub across it to read the
 * prices back at any tick; the legend above follows the cursor.
 *
 * The geometry is fixed (a 320 x 150 viewBox drawn at the dock's width), so
 * the scrub cursor maps a pointer to a tick by measuring the SVG itself.
 */

import { useMemo, useState } from 'react';
import { useSandbox } from '../../../context/SandboxContext';
import { useBets } from '../BettingContext';
import { AgentHex, AgentName, fmtPct } from './bits';

const CHART_W = 320;
const CHART_H = 150;
const PAD_T = 10;
const PAD_B = 8;
const PAD_R = 42; // room for the % gridline labels

/** Snap the y-ceiling to a readable step just above the season's peak. */
const niceMax = (v) => [0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1].find((s) => v <= s - 0.02) ?? 1;

export default function MarketChart({ onFollow }) {
  const { roster, followedAgentId, world } = useSandbox();
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
    // after the game nothing is forming any more: no history, no chart
    if (world?.phase === 'finished') return null;
    return (
      <div className="qf-mkt-chart is-forming">
        <span>Market forming…</span>
      </div>
    );
  }

  // the span of ticks sampled; taken from the extremes, not the ends, so a
  // history that is not in tick order still fits the plot
  const ticks = probHistory.map((s) => s.tick);
  const x0 = Math.min(...ticks);
  const x1 = Math.max(...ticks);
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
    <div className="qf-mkt-chart">
      <div className="qf-mkt-legend">
        {top.map((agent) => (
          <button
            key={agent.agent_id}
            type="button"
            className={`qf-mkt-legend__item${agent.agent_id === followedAgentId ? ' is-followed' : ''}`}
            onClick={() => onFollow?.(agent)}
            aria-label={`Follow ${agent.name}, ${fmtPct(shown?.probs[agent.agent_id] ?? 0)} to win`}
          >
            <AgentHex agent={agent} size={16} />
            <AgentName agent={agent} />
            <span className="qf-num qf-num--small">{fmtPct(shown?.probs[agent.agent_id] ?? 0)}</span>
          </button>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="qf-mkt-plot"
        role="img"
        aria-label={`Win odds over ticks: ${top.map((a) => a.name).join(', ')}`}
        onPointerMove={scrub}
        onPointerDown={scrub}
        onPointerLeave={() => setCursor(null)}
      >
        {[yMax, yMax / 2].map((v) => (
          <g key={v}>
            <line className="qf-mkt-grid" x1="0" x2={CHART_W - PAD_R} y1={Y(v)} y2={Y(v)} />
            <text className="qf-mkt-axis" x={CHART_W - PAD_R + 6} y={Y(v) + 4}>
              {Math.round(v * 100)}%
            </text>
          </g>
        ))}
        <line className="qf-mkt-grid is-base" x1="0" x2={CHART_W - PAD_R} y1={Y(0)} y2={Y(0)} />
        {sample && (
          <line
            className="qf-mkt-cursor"
            x1={X(sample.tick)}
            x2={X(sample.tick)}
            y1={PAD_T - 3}
            y2={CHART_H - PAD_B + 3}
          />
        )}
        {series.map(({ agent, pts }) => (
          <g key={agent.agent_id} style={{ '--agent': agent.color }}>
            <polyline
              className="qf-mkt-line"
              points={pts.map(([t, p]) => `${X(t)},${Y(p)}`).join(' ')}
            />
            {pts.length > 0 && (
              <circle
                className="qf-mkt-enddot"
                cx={X((sample ? pts.find(([t]) => t >= sample.tick) : null)?.[0] ?? pts[pts.length - 1][0])}
                cy={Y((sample ? pts.find(([t]) => t >= sample.tick) : null)?.[1] ?? pts[pts.length - 1][1])}
                r="2.6"
              />
            )}
          </g>
        ))}
      </svg>
      <div className="qf-mkt-xlabel">
        {sample ? `Tick ${sample.tick}` : `Tick ${x0} to ${x1}`}
      </div>
    </div>
  );
}

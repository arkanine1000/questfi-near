/**
 * Follow mode's controls: the way back to the island view with the previous
 * and next living agent either side of it, and the picker for a hex that
 * holds more than one agent.
 */

import { ISLAND_MASK, axialToPixel, getHexPoints } from '../HexGrid/hexUtils';


// The exit control wears the island itself — the real hex mask shrunk to
// a glyph, so "back to the island" is a picture, not a caption.
const MINI_HEX = 3.2;
const MINI_ISLAND = (() => {
  const hexPts = getHexPoints(MINI_HEX * 0.88);
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const cells = [...ISLAND_MASK].map((key) => {
    const [q, r] = key.split(',').map(Number);
    const { x, y } = axialToPixel(q, r, MINI_HEX);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    return { key, x, y };
  });
  const pad = MINI_HEX * 1.5;
  return {
    cells,
    hexPts,
    viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`,
  };
})();

function MiniIsland() {
  return (
    <svg viewBox={MINI_ISLAND.viewBox} className="sbx-exit-pill__island" aria-hidden>
      {MINI_ISLAND.cells.map(({ key, x, y }) => (
        <polygon key={key} points={MINI_ISLAND.hexPts} transform={`translate(${x} ${y})`} />
      ))}
    </svg>
  );
}

/** A crowded hex: choose who to ride. */
export function HexPicker({ agents, onFollow, onClose }) {
  return (
    <div className="sbx-hexpicker" role="menu">
      <span className="sbx-hexpicker__label">Follow</span>
      {agents.map((a) => (
        <button
          key={a.agent_id}
          type="button"
          style={{ '--chip-color': a.color }}
          onClick={() => onFollow(a)}
        >
          <i aria-hidden />{a.name}
        </button>
      ))}
      <button
        type="button"
        className="sbx-hexpicker__close"
        onClick={onClose}
        aria-label="Close"
      >
        ✕
      </button>
    </div>
  );
}

/** The way home, flanked by the previous and next living agent when there
 *  is another one to jump to. */
export default function FollowNav({ prevAgent, nextAgent, onFollow, onExit }) {
  return (
    <div className="sbx-agent-nav">
      {prevAgent && (
        <button
          type="button"
          className="sbx-agent-nav__btn sbx-agent-nav__btn--prev"
          style={{ '--chip-color': prevAgent.color }}
          onClick={() => onFollow(prevAgent)}
          title={`Follow ${prevAgent.name}`}
        >
          <span className="sbx-agent-nav__arrow" aria-hidden>←</span>
          <span className="sbx-agent-nav__name">{prevAgent.name}</span>
        </button>
      )}
      <button
        type="button"
        className="sbx-exit-pill"
        onClick={onExit}
        title="Back to island view"
        aria-label="Back to island view (Esc)"
      >
        <span className="sbx-exit-pill__back" aria-hidden>⬑</span>
        <MiniIsland />
        <span className="sbx-exit-pill__key">esc</span>
      </button>
      {nextAgent && (
        <button
          type="button"
          className="sbx-agent-nav__btn sbx-agent-nav__btn--next"
          style={{ '--chip-color': nextAgent.color }}
          onClick={() => onFollow(nextAgent)}
          title={`Follow ${nextAgent.name}`}
        >
          <span className="sbx-agent-nav__name">{nextAgent.name}</span>
          <span className="sbx-agent-nav__arrow" aria-hidden>→</span>
        </button>
      )}
    </div>
  );
}

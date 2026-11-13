/**
 * What preview mode draws where the app would mount a <canvas>. The four
 * canvas-holding components (IslandScene, CrawlerScene, WinnerCelebration,
 * InviteQr) each hand over to standIn() when window.__questfiPreview is set,
 * so the DOM chrome has something behind it and no canvas, WebGL or 2D,
 * ever reaches the page.
 *
 * Hooks for the preview itself are data-preview-* attributes, never the
 * app's class names.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

// ---- the island ----------------------------------------------------------

/** Where the latest onSelectHex lives, for the hex step (readiness.js). */
const islandHandlers = { selectHex: null };

export function selectHex(hex) {
  if (!islandHandlers.selectHex) return false;
  islandHandlers.selectHex(hex);
  return true;
}

function IslandBackdrop({ onSelectHex }) {
  islandHandlers.selectHex = onSelectHex ?? null;
  useEffect(() => {
    window.__questfiPreview?.note?.('standin:island');
    return () => { islandHandlers.selectHex = null; };
  }, []);
  return <div className="pv-backdrop pv-backdrop--island" data-preview-backdrop="island" aria-hidden />;
}

// ---- the dungeon ---------------------------------------------------------

/**
 * Stands in for the crawler's canvas, and does the one job the canvas did
 * for the DOM around it: CrawlerRig, inside the canvas, advances the beat
 * queue every frame, and the HUD's log, thoughts and flashes all hang off
 * that queue. So this drives it on requestAnimationFrame, and reports the
 * scene ready the way the in-canvas probe would.
 */
function DungeonBackdrop({ queue, onReady }) {
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    let raf;
    let last = performance.now();
    let frames = 0;
    const step = (now) => {
      const delta = Math.min(0.1, (now - last) / 1000);
      last = now;
      queue?.update(delta);
      frames += 1;
      if (frames === 3) {
        ready.current?.();
        window.__questfiPreview?.note?.('standin:dungeon');
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [queue]);
  return (
    <div className="pv-backdrop pv-backdrop--dungeon" data-preview-backdrop="dungeon" aria-hidden>
      <div className="pv-dungeon__floor" />
      <div className="pv-dungeon__door" />
    </div>
  );
}

// ---- the finale ----------------------------------------------------------

/** In the finale card's trophy box (Finale's qf-fin-trophy, which sizes it). */
function TrophyPlaceholder() {
  return (
    <div className="qf-fin-trophy pv-trophy" data-preview-backdrop="trophy" aria-hidden>
      <svg viewBox="0 0 100 100" width="100%" height="100%">
        <path d="M30 18h40v14c0 16-8 28-20 30-12-2-20-14-20-30z" />
        <path d="M30 24H18c0 12 6 18 14 20M70 24h12c0 12-6 18-14 20" fill="none" />
        <path d="M46 62h8v12h-8zM34 74h32v8H34z" />
      </svg>
    </div>
  );
}

const CONFETTI_COLORS = ['#69ff8f', '#00bfff', '#ffaa00', '#ff5d5d', '#a04dff', '#ff67d1', '#ffe14d'];

/** A still of the confetti rain: deterministic flakes, no animation. */
function ConfettiStill() {
  const flakes = useMemo(() => {
    let s = 7;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    return Array.from({ length: 60 }, (_, i) => ({
      left: `${rnd() * 100}%`,
      top: `${rnd() * 100}%`,
      rot: Math.round(rnd() * 180),
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    }));
  }, []);
  return (
    <div className="pv-confetti" data-preview-backdrop="confetti" aria-hidden>
      {flakes.map((f, i) => (
        <i key={i} style={{ left: f.left, top: f.top, background: f.color, transform: `rotate(${f.rot}deg)` }} />
      ))}
    </div>
  );
}

// ---- the invite QR -------------------------------------------------------

/**
 * The real drawing (InviteQr's own draw()), made on a detached canvas and
 * shown as an image. Wears InviteQr's class (qf-onb-qr) so its styles apply;
 * change it here if that markup changes.
 */
function QrImage({ text, draw, size = 512 }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!text || !draw) return;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    try {
      draw(c, text);
      setSrc(c.toDataURL('image/png'));
    } catch {
      setSrc(null);
    }
  }, [text, draw, size]);
  if (!src) return <span className="qf-onb-qr" data-preview-backdrop="qr" />;
  return (
    <img
      src={src}
      width={size}
      height={size}
      className="qf-onb-qr"
      data-preview-backdrop="qr"
      alt="QR code for this lobby's agent invite"
    />
  );
}

// --------------------------------------------------------------------------

export function standIn(kind, props = {}) {
  switch (kind) {
    case 'island': return <IslandBackdrop {...props} />;
    case 'dungeon': return <DungeonBackdrop {...props} />;
    case 'trophy': return <TrophyPlaceholder />;
    case 'confetti': return <ConfettiStill />;
    case 'qr': return <QrImage {...props} />;
    default: return <div className="pv-backdrop" data-preview-backdrop={kind} aria-hidden />;
  }
}

export { IslandBackdrop, DungeonBackdrop };

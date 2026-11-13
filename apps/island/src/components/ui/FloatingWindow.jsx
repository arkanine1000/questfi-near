/**
 * A small window that floats over the scene: drag it by its title bar, fold
 * it to the bar, close it. It stays inside the viewport, comes to the front
 * when touched, and remembers where it was left for the rest of the visit
 * (per `id`).
 *
 *   <FloatingWindow id="dossier-kell" title="Dossier · Kell" onClose={close}
 *     initial={{ x: 380, y: 120 }} width={320} accent={agent.color}>…</FloatingWindow>
 */

import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { IconClose, IconMinus, IconPlus } from './icons';

const MARGIN = 8;
let topZ = 0; // windows share one stacking counter; the last touched wins

function recall(id) {
  try {
    return JSON.parse(sessionStorage.getItem(`qf.window.${id}`)) || null;
  } catch {
    return null;
  }
}

function remember(id, state) {
  try {
    sessionStorage.setItem(`qf.window.${id}`, JSON.stringify(state));
  } catch {
    /* private mode: the window simply forgets */
  }
}

export default function FloatingWindow({
  id, title, children, onClose, initial = { x: 80, y: 120 }, width = 320, height,
  accent, tools = null, className = '', minimizable = true,
}) {
  const ref = useRef(null);
  const saved = useRef(recall(id));
  const [pos, setPos] = useState(() => saved.current?.pos || initial);
  const [min, setMin] = useState(() => Boolean(saved.current?.min));
  const [dragging, setDragging] = useState(false);
  const [z, setZ] = useState(() => { topZ += 1; return topZ; });
  const drag = useRef(null);

  const clamp = useCallback((p) => {
    const el = ref.current;
    const w = el?.offsetWidth ?? width;
    const h = el?.offsetHeight ?? 40;
    return {
      x: Math.min(Math.max(MARGIN, p.x), Math.max(MARGIN, window.innerWidth - w - MARGIN)),
      // the title bar must always stay reachable
      y: Math.min(Math.max(MARGIN, p.y), Math.max(MARGIN, window.innerHeight - Math.min(h, 40) - MARGIN)),
    };
  }, [width]);

  // keep it on screen when it first appears and when the window resizes
  useLayoutEffect(() => { setPos((p) => clamp(p)); }, [clamp]);
  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  useEffect(() => { remember(id, { pos, min }); }, [id, pos, min]);

  const front = useCallback(() => { topZ += 1; setZ(topZ); }, []);

  const onPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest('button, a, input, select')) return;
    front();
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    setPos(clamp({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }));
  };
  const endDrag = (e) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  const style = {
    left: pos.x,
    top: pos.y,
    width,
    height: min ? undefined : height,
    // windows stack among themselves above the base layer the stylesheet gives them
    zIndex: `calc(var(--qf-z-window) + ${z})`,
    ...(accent ? { '--qf-window-accent': accent, borderColor: accent } : null),
  };

  return createPortal(
    <section
      ref={ref}
      className={`qf-window ${min ? 'is-min' : ''} ${dragging ? 'is-dragging' : ''} ${className}`}
      style={style}
      aria-label={typeof title === 'string' ? title : undefined}
      onPointerDownCapture={front}
    >
      <header
        className="qf-window__bar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => minimizable && setMin((v) => !v)}
      >
        <span className="qf-window__title" style={accent ? { color: accent, textShadow: `0 0 8px ${accent}` } : undefined}>{title}</span>
        <span className="qf-window__tools">
          {tools}
          {minimizable && (
            <button
              type="button"
              className="qf-x"
              onClick={() => setMin((v) => !v)}
              aria-label={min ? 'Open the window' : 'Fold the window to its title bar'}
              aria-expanded={!min}
            >
              {min ? <IconPlus size={14} /> : <IconMinus size={14} />}
            </button>
          )}
          {onClose && (
            <button type="button" className="qf-x" onClick={onClose} aria-label="Close the window"><IconClose size={14} /></button>
          )}
        </span>
      </header>
      <div className="qf-window__body">{children}</div>
    </section>,
    document.body,
  );
}

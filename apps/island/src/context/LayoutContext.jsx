/**
 * The frame's state: which of the two side columns are open, and what kind
 * of window the app is in. See styles/shell.css for the picture.
 *
 * The provider owns the state; the element that carries `shellProps` turns
 * it into data attributes, and the stylesheet turns those into the
 * --stage-* insets everything else is placed from. Nothing reads a column's
 * width in JavaScript.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';
import { IS_TV } from '../services/cast';

/** Small windows and landscape phones. The stylesheets never repeat this
 *  query: they key off [data-compact] on the shell. */
export const COMPACT_MQ = '(max-width: 1100px), (max-height: 640px)';

/** True inside another page's frame: Agent World opens the island that way,
 *  under its own title bar, so the island drops its wordmark there. */
export const IS_EMBEDDED = (() => {
  try {
    return typeof window !== 'undefined' && window.self !== window.top;
  } catch {
    return true; // a cross-origin parent refuses the comparison
  }
})();

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined'
    && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return undefined;
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

const LayoutContext = createContext(null);

export function LayoutProvider({ children }) {
  const compact = useMediaQuery(COMPACT_MQ);
  // A wide window shows both columns; a compact one starts with both folded
  // so the island is what you see first. The viewer's own choice then holds
  // until the window changes tier.
  const [fieldOpen, setFieldOpen] = useState(!compact);
  const [dockOpen, setDockOpen] = useState(!compact);
  // Whether each column exists at all right now (the market has no dock in a
  // lobby without NEAR, the TV cut has no field). A column that is absent
  // gives its space to the stage.
  const [fieldPresent, setFieldPresent] = useState(false);
  const [dockPresent, setDockPresent] = useState(false);

  useEffect(() => {
    setFieldOpen(!compact);
    setDockOpen(!compact);
  }, [compact]);

  const toggleField = useCallback(() => setFieldOpen((v) => !v), []);
  const toggleDock = useCallback(() => setDockOpen((v) => !v), []);

  const value = useMemo(() => {
    const state = (present, open) => (!present ? 'none' : open ? 'open' : 'closed');
    return {
      compact,
      embedded: IS_EMBEDDED,
      tv: IS_TV,
      fieldOpen,
      dockOpen,
      setFieldOpen,
      setDockOpen,
      toggleField,
      toggleDock,
      setFieldPresent,
      setDockPresent,
      /** Spread on the root element of the frame (class `qf-shell`). */
      shellProps: {
        'data-field': state(fieldPresent, fieldOpen),
        'data-dock': state(dockPresent, dockOpen),
        'data-compact': compact ? '' : undefined,
        'data-embedded': IS_EMBEDDED ? '' : undefined,
        'data-tv': IS_TV ? '' : undefined,
      },
    };
  }, [compact, fieldOpen, dockOpen, fieldPresent, dockPresent, toggleField, toggleDock]);

  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout() {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error('useLayout must be used inside <LayoutProvider>');
  return ctx;
}

/** Declares that a column is on screen for as long as the caller is mounted
 *  and `present` is true. Call it from the column's own component. */
export function useColumnPresence(side, present = true) {
  const { setFieldPresent, setDockPresent } = useLayout();
  const set = side === 'field' ? setFieldPresent : setDockPresent;
  useEffect(() => {
    set(present);
    return () => set(false);
  }, [set, present]);
}

import { useState, useSyncExternalStore } from 'react';
import {
  look, LOOK_DEFAULTS, setLook, resetLook, subscribeLook, lookVersion,
} from './look';

/**
 * Development-only tuning panel for the island's look (`?look=1` on the dev
 * server). Sliders write to the look store, which the scene reads every
 * frame; "copy values" puts the current values on the clipboard as JSON so
 * they can be pasted into LOOK_DEFAULTS. Plain DOM with inline styles, so it
 * does not depend on the app's stylesheets.
 */

// [key, label, min, max, step]
const SECTIONS = [
  {
    title: 'post pass',
    rows: [
      ['bloomIntensity', 'bloom intensity', 0, 2, 0.01],
      ['bloomThreshold', 'bloom threshold', 0, 1, 0.01],
      ['bloomRadius', 'bloom radius', 0, 1, 0.01],
      ['grade', 'green grade', 0, 1, 0.01],
      ['aberration', 'aberration', 0, 3, 0.01],
      ['scan', 'scanlines', 0, 0.3, 0.005],
      ['vignette', 'vignette', 0, 1, 0.01],
      ['noise', 'noise', 0, 0.15, 0.001],
    ],
  },
  {
    title: 'scene',
    rows: [
      ['fogDensity', 'fog density', 0, 0.12, 0.001],
      ['terrainFill', 'terrain fill brightness', 0, 4, 0.01],
      ['contours', 'contour brightness', 0, 1.5, 0.01],
      ['shoreline', 'shoreline brightness', 0, 3, 0.01],
      ['hexOutline', 'hex outline at rest', 0, 0.5, 0.005],
      ['propEdges', 'prop edges', 0, 2, 0.01],
      ['seaLattice', 'sea lattice', 0, 3, 0.01],
      ['sonar', 'sonar rings', 0, 3, 0.01],
      ['projector', 'projector rings', 0, 2, 0.01],
      ['motes', 'motes', 0, 1, 0.01],
      ['agentBeam', 'agent beams', 0, 3, 0.01],
    ],
  },
];

const COLLAPSED_KEY = 'questfi.lookPanel.collapsed';

const S = {
  panel: {
    position: 'fixed',
    top: 60,
    left: 8,
    zIndex: 10000,
    width: 268,
    maxHeight: 'calc(100vh - 72px)',
    overflowY: 'auto',
    boxSizing: 'border-box',
    padding: '6px 10px 10px',
    background: 'rgba(1, 8, 4, 0.84)',
    border: '1px solid rgba(53, 255, 125, 0.35)',
    borderRadius: 6,
    color: '#b8ffd2',
    font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    pointerEvents: 'auto',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: { color: '#35ff7d', letterSpacing: 1, textTransform: 'uppercase' },
  section: {
    margin: '8px 0 2px',
    color: '#7dffb0',
    opacity: 0.75,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  row: { margin: '4px 0' },
  label: { display: 'flex', justifyContent: 'space-between', gap: 8 },
  changed: { color: '#ffd678' },
  slider: { width: '100%', margin: '2px 0 0', accentColor: '#35ff7d' },
  buttons: { display: 'flex', gap: 6, marginTop: 10 },
  button: {
    flex: 1,
    padding: '4px 6px',
    background: 'rgba(53, 255, 125, 0.1)',
    border: '1px solid rgba(53, 255, 125, 0.45)',
    borderRadius: 4,
    color: '#b8ffd2',
    font: 'inherit',
    cursor: 'pointer',
  },
  toggle: {
    padding: '0 6px',
    background: 'none',
    border: '1px solid rgba(53, 255, 125, 0.45)',
    borderRadius: 4,
    color: '#b8ffd2',
    font: 'inherit',
    cursor: 'pointer',
  },
  note: { marginTop: 6, opacity: 0.7 },
};

function readCollapsed() {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(value) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0');
  } catch {
    // storage unavailable: the panel simply opens expanded next time
  }
}

/** The current values, rounded, as pretty JSON. */
function valuesJson() {
  const out = {};
  for (const key of Object.keys(LOOK_DEFAULTS)) out[key] = Number(look[key].toFixed(4));
  return JSON.stringify(out, null, 2);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API refused (e.g. not a secure context): try the old way
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export default function LookPanel({ postActive = true }) {
  useSyncExternalStore(subscribeLook, lookVersion);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [status, setStatus] = useState('');

  const toggle = () => {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  };

  const copy = async () => {
    const text = valuesJson();
    const ok = await copyText(text);
    // eslint-disable-next-line no-console
    console.info('[look]', text);
    setStatus(ok ? 'copied to the clipboard' : 'copy failed: values are in the console');
  };

  const reset = () => {
    resetLook();
    setStatus('reset to defaults');
  };

  return (
    <div style={S.panel} data-look-panel="">
      <div style={S.header}>
        <span style={S.title}>look</span>
        <button
          type="button"
          style={S.toggle}
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand the look panel' : 'Collapse the look panel'}
        >
          {collapsed ? '+' : '−'}
        </button>
      </div>

      {!collapsed && (
        <>
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <div style={S.section}>{section.title}</div>
              {section.rows.map(([key, label, min, max, step]) => {
                const value = look[key];
                const changed = value !== LOOK_DEFAULTS[key];
                return (
                  <div key={key} style={S.row} title="double-click to reset this value">
                    <div
                      style={changed ? { ...S.label, ...S.changed } : S.label}
                      onDoubleClick={() => setLook(key, LOOK_DEFAULTS[key])}
                    >
                      <span>{label}</span>
                      <span>{value.toFixed(3)}</span>
                    </div>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={value}
                      onChange={(e) => setLook(key, Number(e.target.value))}
                      style={S.slider}
                      aria-label={label}
                    />
                  </div>
                );
              })}
              {section.title === 'post pass' && !postActive && (
                <div style={S.note}>post pass is off here (?fx=0, reduced motion or a low-end device)</div>
              )}
            </div>
          ))}

          <div style={S.buttons}>
            <button type="button" style={S.button} onClick={copy}>copy values</button>
            <button type="button" style={S.button} onClick={reset}>reset</button>
          </div>
          {status && <div style={S.note}>{status}</div>}
        </>
      )}
    </div>
  );
}

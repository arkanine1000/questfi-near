/**
 * The booth: the settings dialog behind the top bar's gear, for everyone.
 *
 *   CLOCK  pause, play and speed (the host only, while the season runs)
 *   SOUND  Prompt-chan's voice and the dungeon's sound effects
 *   VIEW   the auto-director, the same switch as the top-bar button
 *   BUILD  which build this device is running
 *
 * Opening lobbies and the operator key live on the landing view: this is
 * about the game in front of you, not about administering the server.
 */

import { useId, useSyncExternalStore } from 'react';
import { useSandbox } from '../../context/SandboxContext';
import { isSfxMuted, setSfxMuted } from '../Scene3D/Crawler/sfx';
import { IconPause, IconPlay } from '../ui/icons';
import Modal from '../ui/Modal';
import { useVoiceEnabled, setVoiceEnabled } from './promptChanVoice';

const SPEED_STEPS = [1, 2, 4];

// ---- sound effects on or off ----------------------------------------------
// sfx.js keeps a plain flag; this adds the viewer's choice across visits and
// tells the top bar and the booth when it changes.
const SFX_KEY = 'qf-sfx-muted';
const sfxListeners = new Set();
try {
  // Restoring "muted" only: unmuting builds an AudioContext, which has to
  // wait for a click.
  if (typeof window !== 'undefined' && localStorage.getItem(SFX_KEY) === '1') setSfxMuted(true);
} catch { /* storage blocked: sound stays on, as sfx.js starts */ }

/** Turn the sound effects off (true) or on (false), and remember it. */
export function setSfxOff(off) {
  setSfxMuted(Boolean(off));
  try {
    localStorage.setItem(SFX_KEY, off ? '1' : '0');
  } catch { /* storage blocked: the choice lasts this page */ }
  sfxListeners.forEach((l) => l());
}

const subscribeSfx = (l) => {
  sfxListeners.add(l);
  return () => sfxListeners.delete(l);
};

/** Whether the sound effects are off, kept current. */
export function useSfxMuted() {
  return useSyncExternalStore(subscribeSfx, isSfxMuted, isSfxMuted);
}

/** A two-state button: ON (lit) or OFF (quiet). */
function Switch({ on, onChange, label }) {
  return (
    <button
      type="button"
      className={`qf-btn qf-btn--small qf-booth-switch${on ? ' is-on' : ' qf-btn--quiet'}`}
      aria-pressed={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      {on ? 'On' : 'Off'}
    </button>
  );
}

export default function SettingsPanel({ onClose, directorOn = false, onToggleDirector }) {
  const {
    world, autoRunning, speed, setRunning, changeSpeed, canControl,
  } = useSandbox();
  const voiceOn = useVoiceEnabled();
  const sfxMuted = useSfxMuted();
  const speedId = useId();
  const running = world?.phase === 'running';

  return (
    <Modal title="Booth" onClose={onClose} className="qf-booth">
      {canControl && running && (
        <section className="qf-booth-section">
          <h3 className="qf-head">Clock</h3>
          <div className="qf-row">
            <span id={speedId}>Season clock</span>
            <div className="qf-booth-group" role="group" aria-labelledby={speedId}>
              <button
                type="button"
                className="qf-btn qf-btn--small qf-btn--icon"
                onClick={() => setRunning(!autoRunning)}
                aria-label={autoRunning ? 'Pause the season' : 'Run the season'}
                title={autoRunning ? 'Pause' : 'Play'}
              >
                {autoRunning ? <IconPause size={14} /> : <IconPlay size={14} />}
              </button>
              {SPEED_STEPS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`qf-btn qf-btn--small${speed === s ? ' is-on' : ''}`}
                  onClick={() => changeSpeed(s)}
                  aria-pressed={speed === s}
                  aria-label={`Speed ${s} times`}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="qf-booth-section">
        <h3 className="qf-head">Sound</h3>
        <div className="qf-row">
          <span>Prompt-chan reads her lines aloud</span>
          <Switch on={voiceOn} onChange={setVoiceEnabled} label="Prompt-chan reads her lines aloud" />
        </div>
        <div className="qf-row">
          <span>Sound effects</span>
          <Switch on={!sfxMuted} onChange={(on) => setSfxOff(!on)} label="Sound effects" />
        </div>
      </section>

      {onToggleDirector && (
        <section className="qf-booth-section">
          <h3 className="qf-head">View</h3>
          <div className="qf-row">
            <span>Auto-director</span>
            <Switch on={directorOn} onChange={() => onToggleDirector()} label="Auto-director" />
          </div>
        </section>
      )}

      {/* baked at bundle time (vite define): a device on a stale
          service-worker build betrays itself here */}
      <div className="qf-row qf-booth-build">
        <span>Build</span>
        <span className="qf-num qf-num--small">{__BUILD_STAMP__}</span>
      </div>
    </Modal>
  );
}

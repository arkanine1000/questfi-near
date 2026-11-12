/**
 * The gear's panel — the host's console for the season on screen, and
 * nothing else. Rendered only for someone who can actually control it.
 *
 * Opening lobbies and the operator key moved to the landing view: this
 * panel is about the game in front of you, not about administering the
 * server. What's left is the clock and the booth.
 */

import { useSandbox } from '../../context/SandboxContext';
import { useVoiceEnabled, setVoiceEnabled } from './promptChanVoice';

const SPEED_STEPS = [1, 2, 4];

export default function SettingsPanel({ onClose }) {
  const { world, autoRunning, speed, setRunning, changeSpeed } = useSandbox();
  const voiceOn = useVoiceEnabled();
  const running = world?.phase === 'running';

  return (
    <div className="sbx-newseason" role="dialog" aria-label="Season settings">
      {running && (
        <>
          <h2 className="sbx-newseason__title">Clock</h2>
          <div className="sbx-popover__row">
            <button
              type="button"
              className="sbx-btn sbx-btn--icon"
              onClick={() => setRunning(!autoRunning)}
              aria-label={autoRunning ? 'Pause' : 'Play'}
              title={autoRunning ? 'Pause' : 'Play'}
            >
              {autoRunning ? '❚❚' : '▶'}
            </button>
            <div className="sbx-speed" role="group" aria-label="Speed">
              {SPEED_STEPS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`sbx-speed__step${speed === s ? ' is-active' : ''}`}
                  onClick={() => changeSpeed(s)}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>
          <div className="sbx-newseason__rule" aria-hidden />
        </>
      )}
      <h2 className="sbx-newseason__title">Booth</h2>
      <label className="sbx-newseason__check">
        <input
          type="checkbox"
          checked={voiceOn}
          onChange={(e) => setVoiceEnabled(e.target.checked)}
        />
        <span>Prompt-chan voice — she reads her lines aloud</span>
      </label>
      <div className="sbx-newseason__actions">
        <button type="button" className="sbx-btn" onClick={onClose}>Close</button>
      </div>
      {/* baked at bundle time (vite define) — a stale service-worker
          build betrays itself here */}
      <p className="sbx-newseason__stamp">build {__BUILD_STAMP__}</p>
    </div>
  );
}

/**
 * The slim command strip: identity on the left, clock in the centre, and a
 * deliberately small surface on the right.
 *
 * A spectator gets no controls at all — not disabled ones, none. Begin and
 * the settings gear belong to whoever holds this season's key; browsing,
 * opening lobbies and the operator key all live on the landing view now,
 * which the brand mark returns to. That leaves a watcher with a clock, a
 * phase, and the island.
 */

import { useEffect, useState } from 'react';
import { FaCog } from 'react-icons/fa';
import { MdCast, MdCastConnected, MdVideocam } from 'react-icons/md';
import { useSandbox } from '../../context/SandboxContext';
import {
  IS_TV, sendToTv, startCast, stopCast, subscribeCast, watchCastAvailability,
} from '../../services/cast';
import SettingsPanel from './SettingsPanel';

export default function TopBar({ directorOn = false, onToggleDirector }) {
  // autoRunning stays: the phase pill still reads LIVE vs PAUSED.
  const { world, autoRunning, startSeason, canControl, detachWorld } = useSandbox();
  const [showSettings, setShowSettings] = useState(false);
  const [cast, setCast] = useState({ supported: false, available: false, casting: false });

  // Cast button lifecycle: appears only when a TV is reachable (the
  // Presentation API's availability monitor), lights up while casting.
  useEffect(() => {
    watchCastAvailability();
    return subscribeCast(setCast);
  }, []);

  // Season hops (attachWorld swaps in place) drag the cast TV along.
  useEffect(() => {
    if (world?.world_id) sendToTv({ type: 'world', worldId: world.world_id });
  }, [world?.world_id]);

  if (!world) return null;
  const phase = world.phase;

  return (
    <header className="sbx-topbar">
      {/* the wordmark is the way back to every other season */}
      <button
        type="button"
        className="sbx-topbar__brand sbx-topbar__brand--link"
        onClick={detachWorld}
        title="All seasons"
        aria-label="All seasons"
        disabled={IS_TV}
      >
        <span className="sbx-topbar__glyph">⬢</span>
        <span className="sbx-topbar__title">QUESTFI</span>
        <span className={`sbx-phase sbx-phase--${phase}`}>
          <i className="sbx-phase__dot" />
          {phase === 'lobby' && 'LOBBY'}
          {phase === 'running' && (autoRunning ? 'LIVE' : 'PAUSED')}
          {phase === 'finished' && 'GAME OVER'}
        </span>
      </button>

      <div className="sbx-topbar__clock">
        <span className="sbx-topbar__ticklabel">TICK</span>
        <span className="sbx-topbar__tick">{String(world.tick ?? 0).padStart(3, '0')}</span>
      </div>

      {/* the TV keeps the identity strip but drops every control — a
          couch can't click, and the casting phone holds the remote */}
      {!IS_TV && (
      <div className="sbx-topbar__controls">
        {phase === 'lobby' && canControl && (
          <button type="button" className="sbx-btn sbx-btn--primary" onClick={startSeason}>
            Begin Game
          </button>
        )}
        {/* The auto-director as a spectator luxury, not just a TV
            necessity: the camera cuts itself between fights and heroes
            while the cursor (and every control) stays live — any click
            outranks the rotation for a while, exactly like a cast
            command does on the TV. */}
        {phase === 'running' && onToggleDirector && (
          <button
            type="button"
            className={`sbx-btn sbx-btn--icon${directorOn ? ' sbx-btn--director' : ''}`}
            aria-label={directorOn ? 'Stop auto-director' : 'Start auto-director'}
            aria-pressed={directorOn}
            title={directorOn
              ? 'Auto-director on — the camera cuts itself; click anything to overrule it'
              : 'Auto-director — lean back and let the camera cut between fights and heroes'}
            onClick={onToggleDirector}
          >
            <MdVideocam aria-hidden />
          </button>
        )}
        {/* Rendered whenever the browser CAN cast, dimmed until a TV is
            actually discovered — an absent icon and an absent Chromecast
            used to look identical. Still tappable while dimmed: the
            system picker is the ground truth when availability
            monitoring is conservative (Android saves radio here). */}
        {cast.supported && (
          <button
            type="button"
            className={`sbx-btn sbx-btn--icon${cast.casting ? ' sbx-btn--casting' : ''}${!cast.casting && !cast.available ? ' sbx-btn--nocast' : ''}`}
            aria-label={cast.casting ? 'Stop casting' : 'Cast to TV'}
            aria-pressed={cast.casting}
            title={cast.casting ? 'Stop casting'
              : cast.available ? 'Cast to TV'
                : 'Cast to TV — no TV found on this network yet'}
            onClick={() => {
              if (cast.casting) stopCast();
              else startCast(world.world_id).catch(() => { /* picker dismissed */ });
            }}
          >
            {cast.casting ? <MdCastConnected aria-hidden /> : <MdCast aria-hidden />}
          </button>
        )}
        {/* Nothing in this panel belongs to a spectator any more: the clock
            is the host's and the booth rides with it. */}
        {canControl && (
          <button
            type="button"
            className="sbx-btn sbx-btn--icon"
            aria-label="Settings"
            aria-expanded={showSettings}
            title="Settings"
            onClick={() => setShowSettings((v) => !v)}
          >
            <FaCog aria-hidden />
          </button>
        )}
      </div>
      )}

      {showSettings && canControl && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </header>
  );
}

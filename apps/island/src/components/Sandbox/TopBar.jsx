/**
 * The top bar: who and where on the left, the season clock in the centre,
 * the viewer's own things on the right, and along its bottom edge the
 * season's timeline filling toward the last tick.
 *
 * The island usually runs inside Agent World's frame, under two other bars,
 * so this one stays light: a brand (or, when embedded or small, a quiet way
 * back to the seasons), the season and its phase, the tick, then the test
 * account and a few icon buttons. The host also gets Begin in the lobby.
 * A TV has no pointer, so it keeps the identity and the clock and drops the
 * right-hand side.
 */

import { useEffect, useState } from 'react';
import { useSandbox } from '../../context/SandboxContext';
import { useNear } from '../../context/NearContext';
import { useLayout } from '../../context/LayoutContext';
import {
  sendToTv, startCast, stopCast, subscribeCast, watchCastAvailability,
} from '../../services/cast';
import { formatNear } from '../../services/marketMath';
import { explorerAccount, explorerTx, shortAccount, shortHash } from '../../services/explorer';
import { publicUrl } from '../../services/publicUrl';
import {
  IconCast, IconDirector, IconExternal, IconLeft, IconSettings, IconSoundOff, IconSoundOn,
  IconYou, IconClose,
} from '../ui/icons';
import SettingsPanel, { setSfxOff, useSfxMuted } from './SettingsPanel';
import { useBets } from './BettingContext';
import '../../styles/top.css';

/** A season id cut to fit the pill. */
const shortSeason = (id) => {
  const s = String(id ?? '');
  return s.length > 12 ? `${s.slice(0, 11)}…` : s;
};

/**
 * The visitor's NEAR test account, when the market runs on chain: its id
 * and spendable balance, or the offer to make one. Absent without a contract.
 */
function AccountControl({ compact }) {
  const near = useNear();
  if (!near.enabled) return null;
  const {
    status, accountId, balance, createTestAccount,
  } = near;

  return (
    <>
      {status === 'ready' && accountId && (
        <a
          className="qf-pill qf-pill--ice qf-top-account"
          href={explorerAccount(accountId)}
          target="_blank"
          rel="noreferrer"
          title={`Your test account ${accountId}, on the explorer`}
          aria-label={`Your test account ${accountId}: ${balance != null ? formatNear(balance) : 'balance loading'} NEAR. Opens the explorer.`}
        >
          <IconYou size={14} />
          <span className="qf-top-account-you">You</span>
          {!compact && <span className="qf-top-account-id">{shortAccount(accountId)}</span>}
          <span className="qf-top-account-bal">
            {balance != null ? formatNear(balance) : '…'}
            <span className="qf-unit">NEAR</span>
          </span>
        </a>
      )}
      {(status === 'none' || status === 'creating') && (
        <button
          type="button"
          className={`qf-btn qf-btn--small qf-top-play${status === 'creating' ? ' is-busy' : ''}`}
          onClick={createTestAccount}
          disabled={status === 'creating'}
        >
          {status === 'creating' ? 'Creating test account…' : 'Play with a test account'}
        </button>
      )}
    </>
  );
}

/**
 * What last happened to the account (a new one made, or an error), as
 * toasts at the top-right of the stage: never over a column, and below the
 * follow controls while someone is followed. The news of a new account
 * clears itself after a while; an error stays until dismissed.
 */
const MADE_TOAST_MS = 10000;

function AccountToasts() {
  const near = useNear();
  const [seenTx, setSeenTx] = useState(null);
  const {
    status, error, createdTx, dismissError,
  } = near;
  const made = near.enabled && createdTx && status === 'ready' && seenTx !== createdTx.txHash ? createdTx : null;
  const madeHash = made?.txHash ?? null;
  useEffect(() => {
    if (!madeHash) return undefined;
    const t = setTimeout(() => setSeenTx(madeHash), MADE_TOAST_MS);
    return () => clearTimeout(t);
  }, [madeHash]);
  if (!near.enabled || !(error || made)) return null;

  return (
    <div className="qf-top-toasts">
      {made && (
        <div className="qf-toast qf-top-toast qf-top-toast--ice" role="status">
          <a href={explorerTx(made.txHash)} target="_blank" rel="noreferrer">
            <span className="qf-top-toast-label">Test account created</span>
            {made.grant ? ` with ${made.grant} NEAR` : ''}
            {' · '}
            <span className="qf-top-toast-tx">
              tx {shortHash(made.txHash)}
              <IconExternal size={12} />
            </span>
          </a>
          <button type="button" className="qf-x" onClick={() => setSeenTx(made.txHash)} aria-label="Dismiss">
            <IconClose size={13} />
          </button>
        </div>
      )}
      {error && (
        <div className="qf-toast qf-top-toast qf-top-toast--bad" role="alert">
          <span>{error}</span>
          <button type="button" className="qf-x" onClick={dismissError} aria-label="Dismiss">
            <IconClose size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

/** LOBBY, LIVE, PAUSED or FINAL. */
function PhasePill({ phase, running }) {
  if (phase === 'lobby') {
    return <span className="qf-pill qf-pill--amber qf-top-phase"><i className="qf-dot" />Lobby</span>;
  }
  if (phase === 'running' && running) {
    return <span className="qf-pill qf-top-phase qf-top-phase--live"><i className="qf-dot qf-dot--live" />Live</span>;
  }
  if (phase === 'running') {
    return <span className="qf-pill qf-top-phase qf-top-phase--paused"><i className="qf-dot" />Paused</span>;
  }
  if (phase === 'finished') {
    return <span className="qf-pill qf-pill--amber qf-top-phase"><i className="qf-dot" />Final</span>;
  }
  return null;
}

export default function TopBar({ directorOn = false, onToggleDirector }) {
  const {
    world, autoRunning, startSeason, canControl, detachWorld,
  } = useSandbox();
  const { compact, embedded, tv } = useLayout();
  const [showBooth, setShowBooth] = useState(false);
  const [cast, setCast] = useState({ supported: false, available: false, casting: false });
  const sfxMuted = useSfxMuted();
  // The tick at which the chain market stops taking bets, when the game
  // server says (its near block's lock_tick); absent off chain.
  const { lockTick } = useBets();

  // The cast button appears only where the browser can cast, dimmed until a
  // TV is reachable, lit while casting.
  useEffect(() => {
    watchCastAvailability();
    return subscribeCast(setCast);
  }, []);

  // Season hops (attachWorld swaps in place) drag the cast TV along.
  useEffect(() => {
    if (world?.world_id) sendToTv({ type: 'world', worldId: world.world_id });
  }, [world?.world_id]);

  if (!world) return null;
  const { phase } = world;
  const tick = world.tick ?? 0;
  // The season's last tick, when the server says (GET /state's max_ticks).
  const lastTick = Number.isFinite(world.max_ticks) && world.max_ticks > 0 ? world.max_ticks : null;
  const progress = lastTick ? Math.min(1, Math.max(0, tick / lastTick)) : null;
  const lockAt = lastTick && Number.isFinite(lockTick) && lockTick > 0 && lockTick <= lastTick
    ? lockTick / lastTick
    : null;
  const quietBack = embedded || compact;

  return (
    <>
      <header className="qf-top">
        <div className="qf-top-left">
          {tv && (
            <span className="qf-top-brand">
              <img src={publicUrl('/brand/quest-logo.png')} alt="" />
              <span>QUESTFI<span className="qf-top-brand-sub"> <i>//</i> AGENT ISLAND</span></span>
            </span>
          )}
          {!tv && !quietBack && (
            // the wordmark is the way back to every other season
            <button type="button" className="qf-top-brand" onClick={detachWorld} title="All seasons">
              <img src={publicUrl('/brand/quest-logo.png')} alt="" />
              <span>QUESTFI<span className="qf-top-brand-sub"> <i>//</i> AGENT ISLAND</span></span>
            </button>
          )}
          {!tv && quietBack && (
            <button
              type="button"
              className="qf-btn qf-btn--small qf-btn--quiet qf-top-back"
              onClick={detachWorld}
              aria-label="Back to all seasons"
            >
              <IconLeft size={14} />Seasons
            </button>
          )}
          <span className="qf-pill qf-top-season" title={`Season ${world.world_id}`}>
            <span className="qf-top-season-label">Season</span>
            <span className="qf-top-season-id">{shortSeason(world.world_id)}</span>
          </span>
          <PhasePill phase={phase} running={autoRunning} />
        </div>

        <div
          className="qf-top-clock"
          role="timer"
          aria-label={`${lastTick ? `Tick ${tick} of ${lastTick}` : `Tick ${tick}`}${lockAt != null ? `; betting locks at tick ${lockTick}` : ''}`}
        >
          <span className="qf-top-clock-label" aria-hidden>Tick</span>
          <span className="qf-top-tick" aria-hidden>{String(tick).padStart(3, '0')}</span>
          {lastTick && <span className="qf-top-of" aria-hidden>/ {lastTick}</span>}
        </div>

        {!tv && (
          <div className="qf-top-right">
            {phase === 'lobby' && canControl && (
              <button type="button" className="qf-btn qf-btn--small qf-btn--primary qf-top-begin" onClick={startSeason}>
                Begin game
              </button>
            )}
            <AccountControl compact={compact} />
            {/* the auto-director: the camera cuts itself between fights and
                heroes while every control stays live; any click outranks it
                for a while */}
            {phase === 'running' && onToggleDirector && (
              <button
                type="button"
                className={`qf-btn qf-btn--icon qf-btn--quiet qf-top-icon${directorOn ? ' is-on' : ''}`}
                onClick={onToggleDirector}
                aria-pressed={directorOn}
                aria-label="Auto-director"
                title={directorOn
                  ? 'Auto-director on: the camera cuts itself. Click anything to overrule it.'
                  : 'Auto-director: let the camera cut between fights and heroes'}
              >
                <IconDirector />
              </button>
            )}
            {/* shown whenever the browser can cast, dimmed until a TV is
                found: the system picker is the ground truth when the
                availability monitor is conservative */}
            {cast.supported && (
              <button
                type="button"
                className={`qf-btn qf-btn--icon qf-btn--quiet qf-top-icon${cast.casting ? ' is-on' : ''}${!cast.casting && !cast.available ? ' is-idle' : ''}`}
                onClick={() => {
                  if (cast.casting) stopCast();
                  else startCast(world.world_id).catch(() => { /* picker dismissed */ });
                }}
                aria-pressed={cast.casting}
                aria-label={cast.casting ? 'Stop casting' : 'Cast to a TV'}
                title={cast.casting ? 'Stop casting'
                  : cast.available ? 'Cast to a TV'
                    : 'Cast to a TV (none found on this network yet)'}
              >
                <IconCast />
              </button>
            )}
            <button
              type="button"
              className="qf-btn qf-btn--icon qf-btn--quiet qf-top-icon"
              onClick={() => setSfxOff(!sfxMuted)}
              aria-pressed={!sfxMuted}
              aria-label="Sound effects"
              title={sfxMuted ? 'Sound effects are off' : 'Sound effects are on'}
            >
              {sfxMuted ? <IconSoundOff /> : <IconSoundOn />}
            </button>
            <button
              type="button"
              className="qf-btn qf-btn--icon qf-btn--quiet qf-top-icon"
              onClick={() => setShowBooth(true)}
              aria-haspopup="dialog"
              aria-label="Booth settings"
              title="Booth: clock, sound and view"
            >
              <IconSettings />
            </button>
          </div>
        )}

        {progress != null && (
          <div className="qf-top-timeline" aria-hidden>
            <i style={{ width: `${progress * 100}%` }} />
            {lockAt != null && (
              <span
                className={`qf-top-lock${tick >= lockTick ? ' is-past' : ''}`}
                style={{ left: `${lockAt * 100}%` }}
                title={`Betting locks at tick ${lockTick}`}
              />
            )}
          </div>
        )}

        {showBooth && !tv && (
          <SettingsPanel
            onClose={() => setShowBooth(false)}
            directorOn={directorOn}
            onToggleDirector={onToggleDirector}
          />
        )}
      </header>
      {/* outside the bar, whose slide-in would otherwise hold them */}
      {!tv && <AccountToasts />}
    </>
  );
}

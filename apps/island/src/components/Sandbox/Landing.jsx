/**
 * The season list: the first thing of the island a visitor sees.
 *
 * The island hologram turns behind a light veil and two things sit over it,
 * the way Agent World sets a city's name over its globe: the AGENT ISLAND
 * title at the top, and one board of seasons at the bottom. Every open
 * season, and the two things you can do with one: watch it, or play it.
 * That choice belongs here, not on the lobby card behind it: by the time
 * you are inside a season you have already decided.
 *
 * Opening a lobby, bringing an agent, deleting a season and the operator's
 * key each open a dialog, so the board itself stays one table.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSandbox } from '../../context/SandboxContext';
import { listWorlds, whoami } from '../../services/sandboxApi';
import { getAdminKey, getHostKey, setAdminKey } from '../../services/hostKeys';
import { publicUrl } from '../../services/publicUrl';
import Modal from '../ui/Modal';
import {
  IconClose, IconInfo, IconKey, IconTrash, IconWarn,
} from '../ui/icons';
import { OnboardingDialog } from './AgentOnboarding';
import OpenLobbyForm from './OpenLobbyForm';
import '../../styles/landing.css';

const POLL_MS = 5000;

const pad3 = (n) => String(Math.max(0, n ?? 0)).padStart(3, '0');

/** The status cell: what kind of season this row is. */
function Status({ phase }) {
  if (phase === 'lobby') {
    return <span className="qf-land-status is-lobby"><i className="qf-dot" aria-hidden />Lobby</span>;
  }
  if (phase === 'running') {
    return <span className="qf-land-status is-live"><i className="qf-dot qf-dot--live" aria-hidden />Live</span>;
  }
  return <span className="qf-land-status is-ended">Ended</span>;
}

/** The figure cell: the one number (or name) a visitor scans the row for. */
function Figure({ world }) {
  const { phase, tick, joined, pool_size: seats } = world;
  if (phase === 'lobby') {
    return (
      <>
        <b className="qf-land-fig">{joined ?? 0} / {seats ?? '?'}</b>
        <span className="qf-land-fig__unit">Seats</span>
      </>
    );
  }
  if (phase === 'running') {
    return (
      <>
        <b className="qf-land-fig">Tick {pad3(tick)}</b>
        <span className="qf-land-fig__unit">{joined ?? 0} challenger{joined === 1 ? '' : 's'}</span>
      </>
    );
  }
  return world.winner_name ? (
    <>
      <b className="qf-land-fig is-winner">{world.winner_name}</b>
      <span className="qf-land-fig__unit">Took the island</span>
    </>
  ) : (
    <b className="qf-land-fig is-none">No one</b>
  );
}

function SeasonRow({ world, onWatch, onPlay, onDelete }) {
  const { world_id: id, phase } = world;
  // can_control on a LIST row can only answer for the operator key:
  // X-Host-Key is one header and this is many worlds, so a host holding
  // per-world keys cannot prove it in a single request. Our own keyring
  // covers that; the server still gates the DELETE itself.
  const mine = world.can_control || Boolean(getHostKey(id));
  const open = phase === 'lobby';
  const ended = phase !== 'lobby' && phase !== 'running';

  return (
    // The row is a mouse target for watching; the WATCH button inside it is
    // the same action for the keyboard, so the row itself takes no focus.
    <tr
      className={`qf-land-row${ended ? ' is-ended' : ''}`}
      onClick={(e) => { if (!e.target.closest('button')) onWatch(id); }}
    >
      <td className="qf-land-cell qf-land-cell--status"><Status phase={phase} /></td>
      <td className="qf-land-cell qf-land-cell--id">{id}</td>
      <td className="qf-land-cell qf-land-cell--fig"><Figure world={world} /></td>
      <td className="qf-land-cell qf-land-cell--act">
        <div className="qf-land-acts">
          <button
            type="button"
            className={`qf-btn qf-btn--small ${ended ? 'qf-btn--quiet' : 'qf-btn--primary'} qf-land-act--watch`}
            onClick={() => onWatch(id)}
            aria-label={`Watch ${id}`}
          >
            Watch
          </button>
          {open ? (
            <button
              type="button"
              className="qf-btn qf-btn--small qf-land-act--play"
              onClick={() => onPlay(id)}
              aria-label={`Play ${id}: bring your agent`}
            >
              Play
            </button>
          ) : <span className="qf-land-act--play" aria-hidden />}
          {mine ? (
            <button
              type="button"
              className="qf-btn qf-btn--quiet qf-btn--icon qf-land-act--del"
              onClick={() => onDelete(id)}
              aria-label={`Delete ${id}`}
              title="Delete this season"
            >
              <IconTrash />
            </button>
          ) : <span className="qf-land-act--del" aria-hidden />}
        </div>
      </td>
    </tr>
  );
}

/**
 * The operator's skeleton key, typed at runtime.
 *
 * Never a build-time variable: anything reachable from import.meta.env is
 * inlined into the bundle and served to every visitor, which would publish
 * the credential that opens every world on the server. Typing it grants
 * nothing locally: it is sent as X-Host-Key and the server decides.
 *
 * A saved key that the server refuses used to look exactly like a good one.
 * GET /world/whoami answers the question directly: `operator` is the server
 * comparing what we sent against its admin key, in either mode.
 *
 * `whoami` (null when the route is missing, i.e. an older backend) falls
 * back to inferring from can_create. That inference only holds on an
 * operator-only server, where can_create IS the key comparison; an open one
 * grants it to everybody, so the fallback can only ever say "held" there.
 */
function useOperatorKey({ operatorOnly, canCreate, verdict }) {
  const held = Boolean(getAdminKey());
  const accepted = held && (verdict ? verdict.operator : operatorOnly && canCreate);
  const refused = held && (verdict ? !verdict.operator : operatorOnly && !canCreate);
  // "No key can work here" is a different sentence to "your key is wrong",
  // and sends the operator to the server's env rather than their clipboard.
  const noOperator = refused && verdict && !verdict.admin_key_configured;
  let why = null;
  if (refused) {
    why = noOperator
      ? 'This server has no operator key configured, so no key can grant operator access here.'
      : operatorOnly
        ? 'The server refused this operator key. Seasons can only be opened here by the operator, so nothing you do will take effect until it is replaced.'
        : 'The server refused this operator key. You can still open your own lobbies — anyone may — but you will not be able to control seasons opened by someone else.';
  }
  const label = refused ? 'Operator key refused'
    : accepted ? 'Operator key accepted'
      : held ? 'Operator key held'
        : 'Operator sign-in';
  return {
    held, refused, why, label,
  };
}

function OperatorDialog({ op, onClose }) {
  const [value, setValue] = useState('');
  const save = (e) => {
    e.preventDefault();
    setAdminKey(value.trim() || null);
    window.location.reload(); // everything on screen was fetched without it
  };
  const footer = (
    <>
      {op.held && (
        <button
          type="button"
          className="qf-btn qf-btn--quiet"
          onClick={() => { setAdminKey(null); window.location.reload(); }}
        >
          Clear
        </button>
      )}
      <button type="submit" form="qf-land-opkey" className="qf-btn qf-btn--primary">Save</button>
    </>
  );
  return (
    <Modal title="Operator sign-in" onClose={onClose} footer={footer}>
      <form id="qf-land-opkey" className="qf-land-form" onSubmit={save}>
        <div className="qf-land-field">
          <label className="qf-land-field__label" htmlFor="qf-land-opkey-input">Operator key</label>
          <div className="qf-land-field__control">
            <input
              id="qf-land-opkey-input"
              type="password"
              autoComplete="off"
              className="qf-land-input"
              placeholder={op.held ? '•••••••• saved' : 'paste key'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
        </div>
      </form>
      {op.why && <p className="qf-land-refused" role="status">{op.why}</p>}
      <p className="qf-muted qf-land-hint">
        Or from the console: <code>window.questfi.setOperatorKey(&quot;…&quot;)</code>
      </p>
    </Modal>
  );
}

function DeleteDialog({ worldId, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const footer = (
    <>
      <button type="button" className="qf-btn qf-btn--quiet" onClick={onCancel} disabled={busy}>Cancel</button>
      <button
        type="button"
        className={`qf-btn qf-btn--danger${busy ? ' is-busy' : ''}`}
        disabled={busy}
        onClick={async () => { setBusy(true); await onConfirm(); }}
      >
        Delete
      </button>
    </>
  );
  return (
    <Modal title="Delete season" onClose={busy ? undefined : onCancel} footer={footer} tone="red">
      <p className="qf-body">Delete {worldId}? This erases the season for everyone.</p>
    </Modal>
  );
}

export default function Landing() {
  const { attachWorld, deleteSeason, notice, dismissNotice } = useSandbox();
  const [worlds, setWorlds] = useState(null); // null = first load pending
  const [playing, setPlaying] = useState(null); // world id whose onboarding is open
  const [deleting, setDeleting] = useState(null); // world id awaiting confirmation
  const [opening, setOpening] = useState(false);
  const [operatorOpen, setOperatorOpen] = useState(false);
  const [error, setError] = useState(null);
  // Assume creation is allowed until told otherwise, so a slow first poll
  // doesn't flash the locked-down copy at everyone.
  const [canCreate, setCanCreate] = useState(true);
  const [operatorOnly, setOperatorOnly] = useState(false);
  // The server's verdict on the saved operator key. null = never asked, or
  // asked a backend too old to answer; the key's label falls back to inference.
  const [keyVerdict, setKeyVerdict] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const listing = await listWorlds();
      setWorlds(listing.worlds);
      setCanCreate(listing.can_create !== false);
      setOperatorOnly(Boolean(listing.operator_only));
      setError(null);
    } catch {
      setError('The island is not answering.');
      setWorlds((prev) => prev ?? []);
    }
    // Only worth asking when we're holding something to ask about. A failure
    // here is not an outage (the listing above is what says the island is
    // up), so it clears the verdict rather than raising an alarm.
    if (!getAdminKey()) {
      setKeyVerdict(null);
      return;
    }
    try {
      setKeyVerdict(await whoami());
    } catch {
      setKeyVerdict(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const confirmDelete = useCallback(async () => {
    const worldId = deleting;
    try {
      await deleteSeason(worldId);
    } catch {
      setError('That season could not be deleted.');
    }
    setDeleting(null);
    refresh();
  }, [deleting, deleteSeason, refresh]);

  const op = useOperatorKey({ operatorOnly, canCreate, verdict: keyVerdict });

  const live = (worlds || []).filter((w) => w.phase === 'lobby' || w.phase === 'running');
  const over = (worlds || []).filter((w) => w.phase === 'finished').slice(0, 3);
  const rows = [...live, ...over];

  let empty = null;
  if (worlds === null) empty = 'Scanning for seasons…';
  else if (rows.length === 0) {
    empty = canCreate
      ? 'Nothing on air. Open a lobby and point an agent at it.'
      : 'Nothing on air. Seasons here are opened by the operator — check back shortly.';
  }

  return (
    <div className="qf-land">
      <div className="qf-land-veil" aria-hidden />

      <div className="qf-land-frame">
        <header className="qf-land-title">
          <img className="qf-land-title__logo" src={publicUrl('/brand/quest-logo.png')} alt="" aria-hidden />
          <p className="qf-land-title__kicker">QuestFi</p>
          {/* two words, so a small window can stack them */}
          <h1 className="qf-title qf-land-title__name"><span>Agent</span> <span>Island</span></h1>
          <p className="qf-land-title__tag">Loot · Duel · Slay the boss · Settles on NEAR</p>
          {live.length > 0 ? (
            <span className="qf-pill qf-land-onair">
              <i className="qf-dot qf-dot--live" aria-hidden />
              {live.length} season{live.length === 1 ? '' : 's'} on air
            </span>
          ) : (
            <span className="qf-pill qf-pill--off qf-land-onair">Standing by</span>
          )}
        </header>

        <main className="qf-panel qf-land-board" aria-labelledby="qf-land-board-title">
          <div className="qf-head qf-land-board__head">
            <h2 id="qf-land-board-title" className="qf-land-board__title">Seasons</h2>
            {canCreate ? (
              <button type="button" className="qf-btn qf-btn--small qf-btn--primary" onClick={() => setOpening(true)}>
                Open a lobby
              </button>
            ) : operatorOnly && (
              <span className="qf-label qf-label--small">Operator-run server</span>
            )}
          </div>

          {notice && (
            <p className="qf-land-notice" role="status">
              <IconInfo className="qf-land-notice__icon" />
              <span>{notice}</span>
              <button type="button" className="qf-land-notice__x" onClick={dismissNotice} aria-label="Dismiss">
                <IconClose size={14} />
              </button>
            </p>
          )}
          {error && (
            <p className="qf-land-notice is-bad" role="status">
              <IconWarn className="qf-land-notice__icon" />
              <span>{error}</span>
            </p>
          )}

          <div className="qf-land-list qf-scroll">
            {empty ? (
              <p className="qf-land-empty">{empty}</p>
            ) : (
              <table className="qf-land-table">
                <caption className="qf-sr">Seasons on this server</caption>
                <thead className="qf-sr">
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Season</th>
                    <th scope="col">Now</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((w) => (
                    <SeasonRow
                      key={w.world_id}
                      world={w}
                      onWatch={attachWorld}
                      onPlay={setPlaying}
                      onDelete={setDeleting}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </main>

        <footer className="qf-land-foot">
          <button
            type="button"
            className={`qf-land-op${op.refused ? ' is-refused' : op.held ? ' is-held' : ''}`}
            onClick={() => setOperatorOpen(true)}
          >
            <IconKey size={12} />
            {op.label}
          </button>
        </footer>
      </div>

      {opening && canCreate && <OpenLobbyForm onClose={() => setOpening(false)} />}
      {playing && <OnboardingDialog worldId={playing} onClose={() => setPlaying(null)} />}
      {deleting && (
        <DeleteDialog worldId={deleting} onCancel={() => setDeleting(null)} onConfirm={confirmDelete} />
      )}
      {operatorOpen && <OperatorDialog op={op} onClose={() => setOperatorOpen(false)} />}
    </div>
  );
}

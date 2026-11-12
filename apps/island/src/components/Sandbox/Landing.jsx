/**
 * The front door: a broadcast board over the live island.
 *
 * One centred column: masthead, then the season board, then the operator's
 * way in. A side rail holding four elements was not earning a column — a
 * traditional top-down hierarchy reads faster and centres cleanly on any
 * display. The stage stays narrow enough to breathe and is centred
 * vertically, rather than a ribbon pinned to the top of a 1900px screen.
 *
 * Every open season, and the two things you can do with one: watch it, or
 * play it. That choice belongs HERE, not on the lobby card behind it — by
 * the time you are inside a season you have already decided.
 *
 * The island renders behind this (IslandScene sits outside the ready gate),
 * so the backdrop is a light scrim, not a wall: the tiles carry their own
 * glass so the water stays visible between them. If WebGL is dead,
 * SceneBoundary leaves black behind and everything still reads.
 */

import { useCallback, useEffect, useState } from 'react';
import { FaEye, FaRobot } from 'react-icons/fa';
import { useSandbox } from '../../context/SandboxContext';
import { listWorlds, whoami } from '../../services/sandboxApi';
import { getAdminKey, getHostKey, setAdminKey } from '../../services/hostKeys';
import AgentOnboarding from './AgentOnboarding';
import OpenLobbyForm from './OpenLobbyForm';
import { publicUrl } from '../../services/publicUrl';
import '../../styles/Landing.css';

const POLL_MS = 5000;

const PHASE = {
  lobby: { label: 'Lobby open', cls: 'lobby' },
  running: { label: 'Live', cls: 'running' },
  finished: { label: 'Ended', cls: 'finished' },
};

function SeasonRow({ world, index, onWatch, onPlay, onDelete, playing }) {
  const { world_id: id, phase, tick, joined, pool_size: seats } = world;
  // can_control on a LIST row can only answer for the operator key —
  // X-Host-Key is one header and this is many worlds, so a host holding
  // per-world keys cannot prove it in a single request. Our own keyring
  // covers that; the server still gates the DELETE itself.
  const mine = world.can_control || Boolean(getHostKey(id));
  const meta = PHASE[phase] || { label: phase, cls: 'finished' };
  const open = phase === 'lobby';

  return (
    <li className={`qf-row qf-row--${meta.cls}`} style={{ '--i': index }}>
      <div className="qf-row__main">
        <div className="qf-row__read">
          <span className={`qf-status qf-status--${meta.cls}`}>
            <i aria-hidden />
            {meta.label}
          </span>
          <p className="qf-row__figure">
            {open ? (
              <>
                <strong>{joined ?? 0}</strong>
                <span>of {seats ?? '?'} seats taken</span>
              </>
            ) : (
              <>
                <strong>{phase === 'finished' ? (world.winner_name || 'No one') : `t${tick ?? 0}`}</strong>
                <span>
                  {phase === 'finished' ? 'took the island' : `${joined ?? 0} challengers`}
                </span>
              </>
            )}
          </p>
          <p className="qf-row__id">{id}</p>
        </div>

        {/* Play leads and Watch anchors: Play is the conditional one (lobbies
            only), so putting it first keeps Watch in the same place whether or
            not a season is still open to join. */}
        <div className="qf-row__actions">
          {open && (
            <button
              type="button"
              className={`qf-btn ${playing ? '' : 'qf-btn--primary'}`}
              aria-expanded={playing}
              onClick={() => onPlay(playing ? null : id)}
            >
              <FaRobot aria-hidden />
              {playing ? 'Close' : 'Play'}
            </button>
          )}
          <button type="button" className="qf-btn" onClick={() => onWatch(id)}>
            <FaEye aria-hidden />
            Watch
          </button>
          {mine && (
            <button
              type="button"
              className="qf-row__kill"
              aria-label={`Delete ${id}`}
              title="Delete this season"
              onClick={() => onDelete(id)}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {playing && <AgentOnboarding worldId={id} />}
    </li>
  );
}

/**
 * The operator's skeleton key, typed at runtime.
 *
 * Never a build-time variable: anything reachable from import.meta.env is
 * inlined into the bundle and served to every visitor, which would publish
 * the credential that opens every world on the server. Typing it grants
 * nothing locally — it is sent as X-Host-Key and the server decides.
 *
 * A saved key that the server refuses used to look exactly like a good one:
 * the toggle read "operator key held" and the only symptom was that the
 * doors it should open stayed shut. GET /world/whoami answers the question
 * directly — `operator` is the server comparing what we sent against its
 * admin key, in either mode.
 *
 * `whoami` (null when the route is missing, i.e. an older backend) falls
 * back to inferring from can_create. That inference only holds on an
 * operator-only server, where can_create IS the key comparison; an open one
 * grants it to everybody, so the fallback can only ever say "held" there —
 * claiming a key is good on no evidence is the bug being fixed.
 */
function OperatorKey({ operatorOnly, canCreate, verdict }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const held = Boolean(getAdminKey());

  const accepted = held && (verdict ? verdict.operator : operatorOnly && canCreate);
  const refused = held && (verdict ? !verdict.operator : operatorOnly && !canCreate);
  // "No key can work here" is a different sentence to "your key is wrong",
  // and sends the operator to the server's env rather than their clipboard.
  const noOperator = refused && verdict && !verdict.admin_key_configured;

  const label = refused ? '✕ Operator key refused'
    : accepted ? '◆ Operator key accepted'
      : held ? '◆ Operator key held'
        : 'Operator sign-in';

  // The refusal has to survive the panel being shut — the operator may
  // never reopen the form to find out why their key does nothing.
  const notice = refused && (
    <p className="qf-operator__refused" role="status">
      {noOperator
        ? 'This server has no operator key configured, so no key can grant operator access here.'
        : operatorOnly
          ? 'The server refused this operator key. Seasons can only be opened here by the operator, so nothing you do will take effect until it is replaced.'
          : 'The server refused this operator key. You can still open your own lobbies — anyone may — but you will not be able to control seasons opened by someone else.'}
    </p>
  );

  if (!open) {
    return (
      <>
        <button
          type="button"
          className={`qf-operator__toggle${refused ? ' is-refused' : ''}`}
          onClick={() => setOpen(true)}
        >
          {label}
        </button>
        {notice}
      </>
    );
  }
  return (
    <form
      className="qf-operator"
      onSubmit={(e) => {
        e.preventDefault();
        setAdminKey(value.trim() || null);
        window.location.reload(); // everything on screen was fetched without it
      }}
    >
      <label className="qf-operator__label" htmlFor="qf-opkey">Operator key</label>
      <div className="qf-operator__row">
        <input
          id="qf-opkey"
          type="password"
          autoComplete="off"
          className="qf-input"
          placeholder={held ? '•••••••• saved' : 'paste key'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="qf-btn qf-btn--primary">Save</button>
        {held && (
          <button
            type="button"
            className="qf-btn"
            onClick={() => { setAdminKey(null); window.location.reload(); }}
          >
            Clear
          </button>
        )}
      </div>
      {notice}
      <p className="qf-operator__hint">
        Or from the console: <code>window.questfi.setOperatorKey("…")</code>
      </p>
    </form>
  );
}

export default function Landing() {
  const { attachWorld, deleteSeason, notice, dismissNotice } = useSandbox();
  const [worlds, setWorlds] = useState(null); // null = first load pending
  const [playing, setPlaying] = useState(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(null);
  // Assume creation is allowed until told otherwise, so a slow first poll
  // doesn't flash the locked-down copy at everyone.
  const [canCreate, setCanCreate] = useState(true);
  const [operatorOnly, setOperatorOnly] = useState(false);
  // The server's verdict on the saved operator key. null = never asked, or
  // asked a backend too old to answer — OperatorKey falls back to inference.
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
    // here is not an outage — the listing above is what says the island is
    // up — so it clears the verdict rather than raising an alarm.
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

  const handleDelete = useCallback(async (worldId) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete ${worldId}? This erases the season for everyone.`)) return;
    try {
      await deleteSeason(worldId);
    } catch {
      setError('That season could not be deleted.');
    }
    refresh();
  }, [deleteSeason, refresh]);

  const live = (worlds || []).filter((w) => w.phase === 'lobby' || w.phase === 'running');
  const over = (worlds || []).filter((w) => w.phase === 'finished').slice(0, 3);
  const rows = [...live, ...over];

  return (
    <div className="qf-landing">
      <div className="qf-landing__veil" aria-hidden />
      <div className="qf-landing__scroll">
        <div className="qf-landing__stage">

          {/* ---- masthead ---- */}
          <header className="qf-brand">
            <div className="qf-brand__lockup">
              <img className="qf-brand__mark" src={publicUrl('/brand/quest-logo.png')} alt="" aria-hidden />
              <span className="qf-brand__word">QUESTFI</span>
            </div>
            <h1 className="qf-brand__title">Agent Island</h1>
            {/* <p className="qf-brand__sub">
              Coding agents land on a hostile island. One walks off.
            </p> */}
            <span className="qf-brand__onair">
              <i className="qf-brand__dot" aria-hidden />
              {live.length > 0
                ? `${live.length} season${live.length === 1 ? '' : 's'} on air`
                : 'Standing by'}
            </span>
          </header>

          {/* ---- season board ---- */}
          <main className="qf-board">
            <div className="qf-board__head">
              <h2 className="qf-board__title">Seasons</h2>
              {canCreate ? (
                <button
                  type="button"
                  className={`qf-btn ${opening ? '' : 'qf-btn--primary'}`}
                  aria-expanded={opening}
                  onClick={() => setOpening((v) => !v)}
                >
                  {opening ? 'Cancel' : 'Open a lobby'}
                </button>
              ) : operatorOnly && (
                <span className="qf-board__locked">Operator-run server</span>
              )}
            </div>

            {notice && (
              <p className="qf-alert" role="status">
                <span>{notice}</span>
                <button type="button" className="qf-alert__x" onClick={dismissNotice} aria-label="Dismiss">✕</button>
              </p>
            )}
            {error && <p className="qf-alert qf-alert--bad" role="status"><span>{error}</span></p>}

            {canCreate && opening && (
              <div className="qf-panel">
                <OpenLobbyForm onDone={() => setOpening(false)} onCancel={() => setOpening(false)} />
              </div>
            )}

            {worlds === null && <p className="qf-empty">Scanning for seasons…</p>}
            {worlds !== null && rows.length === 0 && !opening && (
              <p className="qf-empty">
                {canCreate
                  ? 'Nothing on air. Open a lobby and point an agent at it.'
                  : 'Nothing on air. Seasons here are opened by the operator — check back shortly.'}
              </p>
            )}

            {rows.length > 0 && (
              <ul className="qf-list">
                {rows.map((w, i) => (
                  <SeasonRow
                    key={w.world_id}
                    world={w}
                    index={i}
                    playing={playing === w.world_id}
                    onWatch={attachWorld}
                    onPlay={setPlaying}
                    onDelete={handleDelete}
                  />
                ))}
              </ul>
            )}
          </main>

          <footer className="qf-foot">
            <OperatorKey
              operatorOnly={operatorOnly}
              canCreate={canCreate}
              verdict={keyVerdict}
            />
          </footer>
        </div>
      </div>
    </div>
  );
}

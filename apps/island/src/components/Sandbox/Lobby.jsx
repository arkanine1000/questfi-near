/**
 * The lobby: what everyone is waiting for, and who has taken a seat.
 *
 * A card in the stage, the clear area between the two side columns, so the
 * market dock beside it stays usable: bets are open while the lobby fills.
 * Deciding to play or watch happened on the season list; the card reports
 * who has arrived and says what the season is waiting for. Bringing an
 * agent opens the same dialog the season list's PLAY does.
 */

import { useEffect, useRef, useState } from 'react';
import { useSandbox } from '../../context/SandboxContext';
import { getArena, startArena } from '../../services/sandboxApi';
import { IS_TV } from '../../services/cast';
import { IconAgent, IconCheck } from '../ui/icons';
import { OnboardingDialog } from './AgentOnboarding';
import '../../styles/lobby.css';

const ARENA_POLL_MS = 2000;

/**
 * The arena's view of this lobby, when the server runs it by itself: no host
 * presses Begin there. The season starts on a countdown after the first
 * seat, and anyone watching can start it sooner. Null for a hosted lobby, or
 * when the server has no arena.
 */
function useArenaLobby(worldId) {
  const [lobby, setLobby] = useState(null);
  useEffect(() => {
    if (!worldId) return undefined;
    let live = true;
    const read = async () => {
      try {
        const arena = await getArena();
        if (live) setLobby(arena?.enabled && arena.lobby?.world_id === worldId ? arena.lobby : null);
      } catch {
        if (live) setLobby(null);
      }
    };
    read();
    const timer = setInterval(read, ARENA_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [worldId]);
  return lobby;
}

/**
 * Seconds left on the arena's countdown, counted down here between the
 * server's reads so the numeral ticks once a second instead of jumping every
 * two. A fresh reading close to the local count only ever pulls it down
 * (network jitter must not make it tick back up); one far from it (the
 * countdown restarted) replaces it.
 */
function useCountdown(seconds) {
  const base = useRef(null); // { s, at }
  const [left, setLeft] = useState(seconds);

  useEffect(() => {
    if (seconds == null) {
      base.current = null;
      setLeft(null);
      return;
    }
    const now = performance.now();
    const prev = base.current;
    const projected = prev ? prev.s - (now - prev.at) / 1000 : null;
    const s = projected != null && Math.abs(seconds - projected) < 1.5 ? Math.min(seconds, projected) : seconds;
    base.current = { s, at: now };
    setLeft(s);
  }, [seconds]);

  // the local clock runs while there is a countdown at all, across readings
  const active = seconds != null;
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      const b = base.current;
      if (b) setLeft(Math.max(0, b.s - (performance.now() - b.at) / 1000));
    }, 250);
    return () => clearInterval(timer);
  }, [active]);

  return left;
}

/** 72 -> "1:12" */
function clock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The sentence for an arena lobby that is not counting down. */
function arenaWaiting(lobby) {
  switch (lobby.waiting_for) {
    case 'running_season': return 'The season starts when the one now running has settled.';
    case 'chain': return 'Opening the season on NEAR…';
    default: return 'The season starts once a challenger takes a seat.';
  }
}

/**
 * How many seats go on a line, so a lobby that needs two lines splits them
 * evenly (ten seats are five and five, not eight and two). At most eight on
 * a line, ten on a small window where the hexagons are smaller.
 */
function seatRows(seats) {
  const even = (most) => Math.ceil(seats / Math.ceil(seats / most));
  return { '--per-row': even(8), '--per-row-compact': even(10) };
}

function Seat({ agent }) {
  if (!agent) {
    return (
      <li className="qf-lobby-seat is-open" aria-label="Open seat">
        <span className="qf-hex qf-lobby-seat__hex" aria-hidden>
          <svg className="qf-lobby-seat__dash" viewBox="0 0 100 100" preserveAspectRatio="none">
            <polygon points="25.5,4 74.5,4 99,50 74.5,96 25.5,96 1,50" />
          </svg>
        </span>
        <span className="qf-lobby-seat__name" aria-hidden />
        <span className="qf-lobby-seat__meta" aria-hidden />
      </li>
    );
  }
  const external = agent.brain === 'external';
  const label = [agent.name, external ? 'plays by API' : null, agent.ready ? 'ready' : null]
    .filter(Boolean).join(', ');
  return (
    <li className="qf-lobby-seat" style={{ '--agent': agent.color }} aria-label={label}>
      <span className="qf-hex qf-lobby-seat__hex" aria-hidden>{(agent.name || '?').trim().charAt(0)}</span>
      <span className="qf-lobby-seat__name" aria-hidden>{agent.name}</span>
      <span className="qf-lobby-seat__meta" aria-hidden>
        {external && <span className="qf-lobby-seat__api">API</span>}
        {agent.ready && <IconCheck size={11} className="qf-lobby-seat__ready" />}
      </span>
    </li>
  );
}

export default function LobbyOverlay() {
  const {
    world, roster, canControl, invite,
  } = useSandbox();
  const arenaLobby = useArenaLobby(world?.world_id);
  const counting = arenaLobby?.waiting_for === 'countdown' && arenaLobby.starts_in_s != null;
  const left = useCountdown(counting ? arenaLobby.starts_in_s : null);
  const [starting, setStarting] = useState(false);
  const [startNote, setStartNote] = useState('');
  const [onboarding, setOnboarding] = useState(false);
  if (!world) return null;

  const joined = roster.length;
  const seats = Math.max(world.pool_size ?? 10, joined);

  let waiting;
  if (arenaLobby) waiting = arenaWaiting(arenaLobby);
  else if (IS_TV || !canControl) waiting = 'Waiting on the host to begin…';
  else waiting = 'Press Begin when the roster looks right.';

  const canStartArena = arenaLobby && !IS_TV
    && (arenaLobby.waiting_for === 'countdown' || arenaLobby.waiting_for === 'player');
  const startNow = async () => {
    setStarting(true);
    setStartNote('');
    try {
      await startArena();
    } catch (err) {
      // 429: a season with no challenger ran too recently. 409: one is running.
      setStartNote(err.status === 429
        ? 'A season with no challenger ran a few minutes ago. Take a seat, or try again shortly.'
        : 'The season could not be started just now.');
      setStarting(false);
    }
  };

  // Whoever opened this lobby lands straight here, and the invite is the
  // only thing they can act on. The create response's invite_url is the one
  // that carries ?code= for an invite-only lobby; it only applies to the
  // world it was minted for.
  const invitePath = invite?.worldId === world.world_id ? invite.url : undefined;

  return (
    <div className="qf-lobby">
      <section className="qf-panel qf-lobby-card" aria-label={`Lobby for season ${world.world_id}`}>
        <div className="qf-lobby-card__top">
          <span className="qf-label">Season {world.world_id}</span>
          <span className="qf-pill qf-pill--amber">Lobby</span>
        </div>

        <div className="qf-lobby-card__headline">
          {counting ? (
            <>
              <span className="qf-label qf-lobby-card__when" id="qf-lobby-when">The season starts in</span>
              {/* a timer is not announced every second; it is read on request */}
              <span className="qf-lobby-count" role="timer" aria-labelledby="qf-lobby-when">
                {clock(left ?? arenaLobby.starts_in_s)}
              </span>
            </>
          ) : (
            <p className="qf-lobby-wait" role="status">{waiting}</p>
          )}
        </div>

        <div className="qf-lobby-card__seats">
          <p className="qf-lobby-taken">
            <b className="qf-num">{joined} / {seats}</b>
            <span className="qf-label qf-label--small">Seats taken</span>
          </p>
          <ul className="qf-lobby-seats" aria-label="Seats" style={seatRows(seats)}>
            {Array.from({ length: seats }, (_, i) => (
              <Seat key={roster[i]?.agent_id ?? `open-${i}`} agent={roster[i]} />
            ))}
          </ul>
        </div>

        {canStartArena && (
          <div className="qf-lobby-card__start">
            <button
              type="button"
              className={`qf-btn qf-btn--big qf-btn--primary${starting ? ' is-busy' : ''}`}
              onClick={startNow}
              disabled={starting}
            >
              {starting ? 'Starting…' : 'Start the season now'}
            </button>
            {startNote && <p className="qf-muted qf-lobby-note" role="status">{startNote}</p>}
          </div>
        )}

        {/* the TV has no pointer and no clipboard: it only ever waits */}
        {!IS_TV && (
          <div className="qf-lobby-card__foot">
            <button type="button" className="qf-btn qf-btn--small" onClick={() => setOnboarding(true)}>
              <IconAgent size={14} />
              Bring your agent
            </button>
          </div>
        )}
      </section>

      {onboarding && (
        <OnboardingDialog
          worldId={world.world_id}
          invitePath={invitePath}
          onClose={() => setOnboarding(false)}
        />
      )}
    </div>
  );
}

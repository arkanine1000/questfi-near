/**
 * The lobby: who has taken a seat, and what the season is waiting for.
 */

import { useEffect, useState } from 'react';
import { useSandbox } from '../../context/SandboxContext';
import { getArena, startArena } from '../../services/sandboxApi';
import { IS_TV } from '../../services/cast';
import { publicUrl } from '../../services/publicUrl';
import AgentOnboarding from './AgentOnboarding';

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
    const timer = setInterval(read, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [worldId]);
  return lobby;
}

function arenaWaiting(lobby) {
  switch (lobby.waiting_for) {
    case 'countdown': return 'The season starts in';
    case 'running_season': return 'The season starts when the one now running has settled.';
    case 'chain': return 'Opening the season on NEAR…';
    default: return 'The season starts once a challenger takes a seat.';
  }
}

export default function LobbyOverlay() {
  const { world, roster, canControl, invite } = useSandbox();
  const arenaLobby = useArenaLobby(world?.world_id);
  const [starting, setStarting] = useState(false);
  const [startNote, setStartNote] = useState('');
  const joined = roster.length;
  const seats = world?.pool_size ?? 10;
  if (!world) return null;

  // Deciding to play or watch happened on the landing view — by the time
  // you are looking at this card, you chose. So the card does one job:
  // report who has arrived, and say what everyone is waiting for.
  const waiting = canControl
    ? 'Press Begin when the roster looks right.'
    : 'Waiting on the host to begin…';

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
  // only thing they can act on — sending them back to the landing board to
  // find their own season was the long way round. The create response's
  // invite_url is the one that carries ?code= for an invite-only lobby;
  // it only applies to the world it was minted for.
  const invitePath = invite?.worldId === world.world_id ? invite.url : undefined;

  return (
    <div className="sbx-lobby">
      <div className="sbx-lobby__card">
        <img className="sbx-lobby__logo" src={publicUrl('/brand/quest-logo.png')} alt="" aria-hidden />
        <h1 className="sbx-lobby__title">The island is waiting</h1>
        <p className="sbx-lobby__seats">
          <strong>{joined}</strong> of <strong>{seats}</strong> challengers in the lobby
        </p>
        {joined > 0 && (
          <ul className="sbx-lobby__list">
            {roster.map((a) => (
              <li key={a.agent_id} style={{ '--chip-color': a.color }}>
                <i />{a.name}
                {a.brain === 'external' ? ' · API' : ''}
                {a.ready ? ' ✓' : ''}
              </li>
            ))}
          </ul>
        )}
        {/* the TV has no pointer and no clipboard — it only ever waits */}
        {!IS_TV && (
          <div className="sbx-lobby__invite">
            <AgentOnboarding worldId={world.world_id} invitePath={invitePath} />
          </div>
        )}
        {arenaLobby ? (
          <>
            <p className="sbx-lobby__waiting sbx-lobby__waiting--arena">
              {arenaWaiting(arenaLobby)}
              {arenaLobby.waiting_for === 'countdown' && arenaLobby.starts_in_s != null && (
                <strong className="sbx-lobby__count">{Math.ceil(arenaLobby.starts_in_s)} s</strong>
              )}
            </p>
            {canStartArena && (
              <button type="button" className="sbx-btn sbx-btn--primary sbx-lobby__start" onClick={startNow} disabled={starting}>
                {starting ? 'Starting…' : 'Start the season now'}
              </button>
            )}
            {startNote && <p className="sbx-lobby__note">{startNote}</p>}
          </>
        ) : (
          <p className="sbx-lobby__waiting">{IS_TV ? 'Waiting on the host to begin…' : waiting}</p>
        )}
      </div>
    </div>
  );
}

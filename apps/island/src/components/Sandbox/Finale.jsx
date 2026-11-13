/**
 * The finale: who took the island, or that nobody did.
 */

import { useSandbox } from '../../context/SandboxContext';
import { IS_TV } from '../../services/cast';
import { WinnerTrophy, WinnerConfetti, WinnerChan } from './WinnerCelebration';

export default function WinnerBanner() {
  const { world, detachWorld } = useSandbox();
  if (!world || world.phase !== 'finished') return null;
  const reason = {
    boss: 'slew the Heart of the Island',
    last_alive: 'outlived every rival',
    timeout: 'outlasted the bell',
    extinction: null,
  }[world.win_reason];
  const won = Boolean(world.winner_name);
  return (
    <div className="sbx-winner">
      {won && <WinnerConfetti />}
      <div className="sbx-winner__card">
        {won ? <WinnerTrophy /> : <div className="sbx-winner__crown">☠</div>}
        {won ? (
          <>
            <h1 className="sbx-winner__name">{world.winner_name}</h1>
            <p className="sbx-winner__reason">{reason}</p>
          </>
        ) : (
          <h1 className="sbx-winner__name">No one survived</h1>
        )}
        {/* The season is over, so the only move is out of it. This used to
            open a lobby directly — either with silent server defaults or,
            later, a setup form bolted onto the finale card. Both made the
            finale carry a decision that the landing board already handles
            better, next to every other season on air. The TV has no pointer
            and stays put; the phone drives it. */}
        {!IS_TV && (
          <button
            type="button"
            className="sbx-btn sbx-btn--primary"
            onClick={() => detachWorld()}
          >
            Back to seasons
          </button>
        )}
      </div>
      {won && <WinnerChan name={world.winner_name} />}
    </div>
  );
}

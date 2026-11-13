/**
 * The finale: who took the island (or that nobody did), how the whole
 * roster finished, and what it meant for the viewer's bets.
 *
 * A results card in the stage, the clear area between the two side columns,
 * so the market dock beside it stays usable: winnings are claimed there.
 * The card is centred above the stage's bottom band, where the caster
 * cheers the winner.
 *
 * The card folds away to a pill at the top of the stage, so the viewer can
 * go on looking at the island and the agents once the season is over: by
 * its own button, and by itself when the viewer starts following an agent.
 * The pill brings it back.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSandbox } from '../../context/SandboxContext';
import { IS_TV } from '../../services/cast';
import { formatNear } from '../../services/marketMath';
import { useBets } from './BettingContext';
import {
  IconArrowRight, IconDead, IconKills, IconMinus, IconTrophy, IconYou,
} from '../ui/icons';
import { WinnerTrophy, WinnerConfetti, WinnerChan } from './WinnerCelebration';
import '../../styles/finale.css';

const REASONS = {
  boss: 'slew the Heart of the Island',
  last_alive: 'outlived every rival',
  timeout: 'outlasted the bell',
  extinction: null,
};

const byKills = (a, b) => (b.kills ?? 0) - (a.kills ?? 0)
  || String(a.name).localeCompare(String(b.name));

/**
 * The roster in finishing order: the winner, then the survivors by kills,
 * then the dead, latest death first.
 *
 * The roster does not say when an agent died; the headline log does, as
 * agent_death events. That log keeps only the season's latest events, so a
 * death it has dropped is older than every death it still holds: those
 * come last, by kills.
 */
function finishingOrder(roster, world, eventLog) {
  const diedAt = new Map();
  for (const ev of eventLog) {
    const id = ev.event_type === 'agent_death' ? ev.data?.agent : null;
    if (id) diedAt.set(id, Math.max(diedAt.get(id) ?? -1, ev.tick ?? 0));
  }
  const won = (a) => (world.winner ? a.agent_id === world.winner : a.name === world.winner_name);
  const winners = roster.filter((a) => world.winner_name && won(a));
  const rest = roster.filter((a) => !winners.includes(a));
  const survivors = rest.filter((a) => a.alive).sort(byKills);
  const dead = rest.filter((a) => !a.alive).sort((a, b) => {
    const ta = diedAt.get(a.agent_id);
    const tb = diedAt.get(b.agent_id);
    if (ta != null && tb != null && ta !== tb) return tb - ta;
    if (ta != null && tb == null) return -1;
    if (ta == null && tb != null) return 1;
    return byKills(a, b);
  });
  return { order: [...winners, ...survivors, ...dead], winner: winners[0] ?? null };
}

function Standings({ order, winner }) {
  return (
    <div className="qf-fin-standings qf-scroll">
      <table className="qf-fin-table">
        <caption className="qf-sr">Final standings</caption>
        {/* A header row with no height: its cells give the fixed layout its
            column widths, and their names are there for screen readers. */}
        <thead>
          <tr className="qf-fin-head">
            <th scope="col" className="qf-fin-rank"><span className="qf-sr">Place</span></th>
            <th scope="col" className="qf-fin-agent"><span className="qf-sr">Agent</span></th>
            <th scope="col" className="qf-fin-kills"><span className="qf-sr">Kills</span></th>
            <th scope="col" className="qf-fin-fate"><span className="qf-sr">Finish</span></th>
          </tr>
        </thead>
        <tbody>
          {order.map((a, i) => {
            const isWinner = a === winner;
            const fate = isWinner ? 'Winner' : a.alive ? 'Survived' : (a.cause_of_death || 'Fallen');
            return (
              <tr
                key={a.agent_id}
                className={`qf-fin-row${isWinner ? ' is-winner' : ''}${a.alive ? '' : ' is-dead'}`}
                style={{ '--agent': a.color }}
              >
                <td className="qf-fin-rank">{String(i + 1).padStart(2, '0')}</td>
                <td className="qf-fin-agent">
                  <span className="qf-fin-agent__in">
                    <span className="qf-hex qf-fin-hex" aria-hidden>{(a.name || '?').trim().charAt(0)}</span>
                    <span className="qf-fin-who">{a.name}</span>
                  </span>
                </td>
                <td className="qf-fin-kills">
                  <IconKills size={13} />
                  <span className="qf-sr">kills</span>
                  {a.kills ?? 0}
                </td>
                <td className="qf-fin-fate" title={fate}>{fate}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The viewer's own result, read from the market: what their bets came to.
 * Claiming lives in the market dock; this line only points there.
 */
function YourResult() {
  const { mode, payout } = useBets();
  if (!payout) return null;

  let line;
  let tone;
  let hint = false;
  let paid = false;
  if (mode === 'chain') {
    const refund = payout.refund || payout.cancelled;
    if (payout.state === 'waiting') {
      tone = 'is-waiting';
      line = <>Settling on NEAR…</>;
    } else if (payout.state === 'lost' || (payout.state === 'paid' && !payout.won && !refund)) {
      tone = 'is-lost';
      line = <>Your <b>{formatNear(payout.staked)}</b> NEAR stays in the pool</>;
    } else {
      paid = payout.state === 'paid';
      hint = !paid && !IS_TV;
      tone = refund ? 'is-refund' : 'is-won';
      line = refund
        ? <>Refunded <b>{formatNear(payout.amount)}</b> NEAR</>
        : <>Won <b>{formatNear(payout.amount)}</b> NEAR</>;
    }
  } else if (payout.won) {
    // the simulated market: practice chips, settled on the spot
    tone = 'is-won';
    line = <>Won <b>{payout.amount.toLocaleString()}</b> practice chips</>;
  } else {
    tone = 'is-lost';
    line = <>Your <b>{payout.amount.toLocaleString()}</b> practice chips stay in the pool</>;
  }

  return (
    <div className={`qf-fin-you ${tone}`} role="status">
      <p className="qf-fin-you__line">
        <span className="qf-pill qf-pill--ice qf-fin-you__tag">
          <IconYou size={12} />
          You
        </span>
        <span className="qf-fin-you__what">{line}</span>
        {paid && <span className="qf-label qf-label--small">Paid</span>}
      </p>
      {hint && (
        <p className="qf-fin-you__hint">
          Claim it in the market, under your bets
          <IconArrowRight size={13} />
        </p>
      )}
    </div>
  );
}

/**
 * Whether the results are folded away. Unfolded for each new season; folded
 * by the viewer, or by the viewer starting to follow an agent once the
 * season is over (they have chosen to look at something), and it stays
 * folded until they open it again. The TV never folds: it has no pointer,
 * and its director follows agents on its own.
 */
function useFold(world, followedAgentId) {
  const [folded, setFolded] = useState(false);
  const worldId = world?.world_id;
  const finished = world?.phase === 'finished';
  useEffect(() => { setFolded(false); }, [worldId]);

  const lastFollow = useRef(followedAgentId);
  useEffect(() => {
    if (!IS_TV && finished && followedAgentId && followedAgentId !== lastFollow.current) {
      setFolded(true);
    }
    lastFollow.current = followedAgentId;
  }, [followedAgentId, finished]);

  return [!IS_TV && folded, setFolded];
}

export default function WinnerBanner() {
  const {
    world, roster, eventLog, detachWorld, followedAgentId,
  } = useSandbox();
  const { order, winner } = useMemo(
    () => (world ? finishingOrder(roster, world, eventLog) : { order: [], winner: null }),
    [roster, world, eventLog],
  );
  const [folded, setFolded] = useFold(world, followedAgentId);
  if (!world || world.phase !== 'finished') return null;

  const won = Boolean(world.winner_name);
  const reason = REASONS[world.win_reason];
  const color = winner?.color;

  return (
    <div className={`qf-fin${won ? '' : ' is-none'}${folded ? ' is-folded' : ''}`}>
      {won && !folded && <WinnerConfetti color={color} />}
      {folded ? (
        <button
          type="button"
          className={`qf-fin-pill${won ? '' : ' is-none'}`}
          onClick={() => setFolded(false)}
          aria-label={`Show the results: ${won ? `${world.winner_name} won` : 'no one survived'}`}
        >
          <IconTrophy size={14} />
          <span className="qf-fin-pill__what">Results</span>
          <span className="qf-fin-pill__sep" aria-hidden>·</span>
          {won ? (
            <span>
              <b className="qf-fin-pill__name" style={color ? { '--agent': color } : undefined}>{world.winner_name}</b>
              {' '}won
            </span>
          ) : <span>No one survived</span>}
        </button>
      ) : (
        // the part of the stage the card is centred in: above the caster
        <div className="qf-fin-area">
          <section
            className={`qf-panel ${won ? 'qf-panel--amber' : 'qf-panel--red'} qf-fin-card`}
            aria-label="Season results"
          >
            {!IS_TV && (
              <button
                type="button"
                className="qf-btn qf-btn--quiet qf-btn--icon qf-fin-fold"
                onClick={() => setFolded(true)}
                aria-label="Fold the results away"
                title="Fold the results away"
              >
                <IconMinus />
              </button>
            )}
            <div className="qf-fin-hero" style={color ? { '--agent': color } : undefined}>
              {won ? (
                // the slot sets the trophy's size; whatever draws it fills the slot
                <div className="qf-fin-cup"><WinnerTrophy /></div>
              ) : <IconDead size={56} className="qf-fin-skull" />}
              <p className="qf-label qf-fin-season">Season {world.world_id} · Final</p>
              {won ? (
                <>
                  <p className="qf-fin-crown">Winner</p>
                  <h1 className="qf-fin-name">{world.winner_name}</h1>
                  {reason && <p className="qf-fin-reason">{reason}</p>}
                </>
              ) : (
                <h1 className="qf-fin-name is-none">No one survived</h1>
              )}
            </div>

            <div className="qf-fin-side">
              {order.length > 0 && <Standings order={order} winner={winner} />}
              <YourResult />
              {/* The season is over, so the only move is out of it. The TV has
                  no pointer and stays put; the phone drives it. */}
              {!IS_TV && (
                <div className="qf-fin-foot">
                  <button type="button" className="qf-btn qf-btn--primary" onClick={() => detachWorld()}>
                    Back to seasons
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
      {/* stays mounted while folded (only hidden), so unfolding does not
          make her say her line again */}
      {won && <WinnerChan name={world.winner_name} />}
    </div>
  );
}

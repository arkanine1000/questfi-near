/**
 * The TV auto-director — a couch has no mouse, so the camera cuts itself.
 *
 * Shot priorities, highest first:
 *   1. A fresh combat_start cuts straight to a fighter in that dungeon and
 *      holds the shot while the fight plays out.
 *   2. A phone-issued command (cast message) pins its pick for a while —
 *      the human with the remote outranks the rotation.
 *   3. Otherwise rotate through the living roster, with a god-view breather
 *      every few follows so the island itself stays part of the broadcast.
 *
 * A dead hero gets a short linger on the aftermath, then the cut moves on
 * regardless of any hold — the shot is over.
 */

import { useCallback, useEffect, useRef } from 'react';

const FOLLOW_CUT_MS = 20000; // one agent's screen time in rotation
const GOD_CUT_MS = 12000; // island breather between follow runs
const GOD_EVERY_N_SHOTS = 4; // every 4th cut surfaces
const COMBAT_HOLD_MS = 28000; // stay on a fight once cut to it
const MANUAL_HOLD_MS = 45000; // respect the phone's pick this long
const DEATH_LINGER_MS = 4000; // beat on the corpse before moving on

export default function useTvDirector({
  enabled, phase, roster, eventLog, followedAgentId, onFollow, onDeselect,
}) {
  // The 1s ticker reads everything through refs so the interval never
  // re-arms on data churn.
  const stateRef = useRef(null);
  stateRef.current = {
    phase, roster, followedAgentId, onFollow, onDeselect,
  };
  const holdUntilRef = useRef(0); // combat/manual pin
  const nextCutRef = useRef(0); // rotation clock
  const shotRef = useRef(0); // counts cuts for the god-view cadence
  const deathAtRef = useRef(null); // when the followed agent was seen dead
  const combatSeqRef = useRef(null); // null = not yet baselined

  /** External picks (cast commands) pin the camera for a while. */
  const noteManual = useCallback(() => {
    holdUntilRef.current = Date.now() + MANUAL_HOLD_MS;
    nextCutRef.current = 0;
  }, []);

  // Combat is the show: cut to a fighter the moment a fresh combat_start
  // lands. Baselined exactly like CombatBeacons — a reconnect backfill
  // replays history and must not trigger a cut for an ancient fight.
  useEffect(() => {
    if (!enabled) return;
    const starts = eventLog.filter((e) => e.event_type === 'combat_start' && e.location);
    if (combatSeqRef.current == null) {
      combatSeqRef.current = starts.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
      return;
    }
    const fresh = starts.filter((e) => (e.seq ?? 0) > combatSeqRef.current);
    if (!fresh.length) return;
    combatSeqRef.current = fresh.reduce(
      (m, e) => Math.max(m, e.seq ?? 0), combatSeqRef.current,
    );
    if (Date.now() < holdUntilRef.current) return; // phone's pick wins
    const ev = fresh[fresh.length - 1];
    const siteId = ev.location.split(':')[0]; // location_key(): "{site}:{row},{col}"
    const fighter = roster.find((a) => a.alive
      && a.position?.kind === 'dungeon' && a.position.site_id === siteId);
    if (!fighter) return;
    onFollow(fighter);
    holdUntilRef.current = Date.now() + COMBAT_HOLD_MS;
    nextCutRef.current = 0;
  }, [enabled, eventLog, roster, onFollow]);

  // The rotation clock.
  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => {
      const s = stateRef.current;
      if (s.phase !== 'running') return; // lobby/finished own the screen
      const now = Date.now();
      const living = s.roster.filter((a) => a.alive);
      const followed = s.roster.find((a) => a.agent_id === s.followedAgentId) || null;

      if (s.followedAgentId && (!followed || !followed.alive)) {
        // Hero down: linger a beat, then cut away through any hold.
        if (deathAtRef.current == null) {
          deathAtRef.current = now;
          return;
        }
        if (now - deathAtRef.current < DEATH_LINGER_MS) return;
        holdUntilRef.current = 0;
      } else {
        deathAtRef.current = null;
        if (now < holdUntilRef.current || now < nextCutRef.current) return;
      }
      deathAtRef.current = null;

      shotRef.current += 1;
      if (!living.length || shotRef.current % GOD_EVERY_N_SHOTS === 0) {
        s.onDeselect();
        nextCutRef.current = now + GOD_CUT_MS;
        return;
      }
      const i = living.findIndex((a) => a.agent_id === s.followedAgentId);
      s.onFollow(living[(i + 1) % living.length]); // -1 wraps to living[0]
      nextCutRef.current = now + FOLLOW_CUT_MS;
    }, 1000);
    return () => clearInterval(id);
  }, [enabled]);

  return noteManual;
}

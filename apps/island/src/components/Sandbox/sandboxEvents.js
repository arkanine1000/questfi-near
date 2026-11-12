/**
 * Sandbox tick events → crawler beats, focused on ONE followed agent.
 *
 * A clean second dialect (deliberately NOT grafted onto the solo
 * normalizers): sandbox frames carry every agent's events with
 * seq/actor/location stamps, so this module first slices out the followed
 * agent's story — their own actions, blows aimed at them, and everything
 * that happens in the room where they stand — then remaps their agent id to
 * the solo vocabulary's 'player' before reusing normalizeTick's mapping.
 */

import { normalizeTick, thoughtBeat } from '../Scene3D/Crawler/crawlerEvents';

export { thoughtBeat };

const ID_KEYS = ['attacker_id', 'defender_id', 'target_id', 'character_id'];

/** Does this event belong in the followed agent's first-person story? */
function concernsSelf(ev, selfId, selfLoc, adjacentLocs) {
  if (ev.actor === selfId) return true;
  const d = ev.data || {};
  if (ID_KEYS.some((k) => d[k] === selfId)) return true;
  // co-located drama: the room the agent currently stands in
  if (selfLoc && ev.location === selfLoc) return true;
  // the scene is fully revealed to spectators — a viewer standing at an
  // open doorway can see into the next room too, so combat-relevant
  // events there should animate. SELF_ONLY_TYPES (below) still re-scopes
  // camera-affecting event types back to strictly self, regardless.
  if (adjacentLocs && ev.location && adjacentLocs.has(ev.location)) return true;
  return false;
}

/**
 * Normalize one frame's events for the followed agent.
 * `selfLoc` is the agent's location_key ("site_id:row,col") this frame.
 * Returns crawler beats (move/attack/damage/trap/loot/death/victory).
 */
// Camera-affecting beats belong to the followed agent ALONE — a rival
// walking into the room or springing a trap must never move or shake the
// followed camera. Their sprites update from the polled site map instead.
const SELF_ONLY_TYPES = new Set([
  'room_enter', 'trap_trigger', 'trap_disarm', 'item_found', 'item_used', 'flee',
]);

export function normalizeSandboxTick(events, selfId, selfLoc, adjacentLocs) {
  // Initiative is NOT announced through the thought toasts — the follow
  // panel's initiative strip owns that surface; doubling it up meant the
  // toast channel showed nothing but rolls for thought-less BYO agents.
  const mapped = [];
  for (const ev of events ?? []) {
    if (!ev?.event_type) continue;
    if (ev.event_type === 'season_end') {
      // the crown ends everyone's story
      mapped.push({
        event_type: 'objective_complete',
        tick: ev.tick,
        data: {},
        description: ev.description,
      });
      continue;
    }
    if (!concernsSelf(ev, selfId, selfLoc, adjacentLocs)) continue;
    if (SELF_ONLY_TYPES.has(ev.event_type)
      && ev.actor !== selfId && ev.data?.character_id !== selfId) {
      continue;
    }
    const data = { ...(ev.data || {}) };
    for (const k of ID_KEYS) {
      if (data[k] === selfId) data[k] = 'player';
    }
    // Sandbox agent deaths use the headline-friendly `agent_death` dialect
    // (`data.agent`) while the shared crawler understands `death`
    // (`data.character_id`). Normalize it here so the rig can actually play
    // Death01 and the retention layer knows when the fall has finished.
    if (ev.event_type === 'agent_death') {
      const deadId = data.agent === selfId ? 'player' : data.agent;
      mapped.push({
        ...ev,
        event_type: 'death',
        data: { ...data, character_id: deadId },
      });
    } else {
      mapped.push({ ...ev, data });
    }
  }
  return normalizeTick(mapped);
}

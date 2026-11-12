/**
 * Beat queue + event normalization — the core of the first-person crawler.
 *
 * Backend EngineEvent dicts ({event_type, tick, data, description}) are
 * normalized by normalizeTick() into ONE beat vocabulary that every scene
 * component consumes:
 *   move | attack | damage | trap | loot | death | victory
 *
 * The queue is frame-clock driven: a single consumer (CrawlerRig) calls
 * update(delta) from useFrame — no timers, so background tabs simply pause
 * and burst catch-up handles the backlog on return.
 */

// Beat durations in seconds
const BEAT_DURATIONS = {
  move: 0.5,
  attack: 0.4,
  damage: 0.3,
  trap: 0.5,
  loot: 0.6,
  death: 1.0,
  victory: 1.2,
  thought: 1.1, // a held "thinking" pause — camera idles, toast types out
};

// Combat detail is droppable during burst catch-up; state-changing beats
// (move/trap/loot/death/victory) always play. Dropped thought pauses hand
// their text to the next kept beat, so nothing is lost — only the pause.
const COSMETIC_KINDS = new Set(['attack', 'damage', 'thought']);
const BURST_ENTER = 10; // queue length that trips catch-up mode
const BURST_EXIT = 4; // drop cosmetic beats until the backlog is this short

let nextBeatId = 0;

function beat(kind, extra = {}) {
  nextBeatId += 1;
  return { id: nextBeatId, kind, dur: BEAT_DURATIONS[kind], ...extra };
}

const gridId = (pos) => (Array.isArray(pos) && pos.length === 2 ? `${pos[0]},${pos[1]}` : null);

/**
 * A standalone thinking-pause beat. It sequences a reactive thought BETWEEN
 * ticks: after the beats it reacts to, before the action it produced — the
 * scene holds while the toast types out.
 */
export function thoughtBeat(id, text) {
  return beat('thought', { thought: { id, text } });
}

/** Normalize one tick's backend engine events into beats. */
export function normalizeTick(events) {
  const beats = [];
  for (const ev of events ?? []) {
    const type = ev?.event_type;
    const d = ev?.data ?? {};
    const label = ev?.description || null;
    const before = beats.length;
    switch (type) {
      case 'room_enter':
        beats.push(beat('move', {
          fromId: gridId(d.from),
          toId: gridId(d.to),
          roomType: d.room_type ?? null,
          label,
        }));
        break;
      case 'attack':
        beats.push(beat('attack', {
          byPlayer: d.attacker_id === 'player',
          attackerId: d.attacker_id ?? null,
          targetId: d.defender_id ?? null,
          hit: !!d.hit,
          crit: !!d.critical,
          label,
        }));
        break;
      case 'damage':
        // All targets: player damage drives camera shake / red flash /
        // the HP bar, enemy damage drives the TARGET plate
        beats.push(beat('damage', {
          targetId: d.target_id ?? null,
          amount: d.damage ?? null,
          hpRemaining: d.hp_remaining ?? null,
          player: d.target_id === 'player',
          label,
        }));
        break;
      case 'trap_trigger':
        beats.push(beat('trap', { hpRemaining: d.hp_remaining ?? null, label }));
        break;
      case 'item_found':
        beats.push(beat('loot', { label }));
        break;
      case 'item_used':
        // potions carry hp_remaining (heal); equips are log-only
        if (d.hp_remaining != null) {
          beats.push(beat('loot', {
            targetId: d.character_id ?? null,
            hpRemaining: d.hp_remaining,
            player: d.character_id === 'player',
            label,
          }));
        }
        break;
      case 'death':
        beats.push(beat('death', {
          entityId: d.character_id ?? null,
          player: d.character_id === 'player',
          label,
        }));
        break;
      case 'objective_complete':
        beats.push(beat('victory', { label }));
        break;
      default:
        break; // ambient events (searches, dice rolls...) don't need a beat
    }
    // tag beats with their source tick — thought reveal keys on it
    for (let i = before; i < beats.length; i += 1) beats[i].tick = ev?.tick ?? null;
  }
  return beats;
}

/**
 * Frame-clock beat queue. One component calls update(delta) per frame;
 * everyone else reads .current/.progress or subscribes to start/end.
 */
export function createBeatQueue({ durScale = 1 } = {}) {
  const state = {
    pending: [],
    current: null,
    elapsed: 0,
    duration: 0,
    burst: false,
  };
  const listeners = new Set();
  const emit = (event, b) => {
    for (const fn of listeners) fn(event, b);
  };

  return {
    get current() { return state.current; },
    get progress() { return state.duration > 0 ? Math.min(state.elapsed / state.duration, 1) : 0; },
    get size() { return state.pending.length + (state.current ? 1 : 0); },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    enqueue(beats) {
      if (beats?.length) state.pending.push(...beats);
    },
    /** Drop everything queued — used on mount and after huge tick gaps. */
    snapToLatest() {
      state.pending.length = 0;
      if (state.current) {
        const done = state.current;
        state.current = null;
        emit('end', done);
      }
      state.burst = false;
    },
    update(dt) {
      if (state.current) {
        state.elapsed += dt;
        if (state.elapsed >= state.duration) {
          const done = state.current;
          state.current = null;
          emit('end', done);
        }
      }
      if (!state.current && state.pending.length > 0) {
        // Burst catch-up: halve durations + drop cosmetic beats until the
        // backlog is manageable again
        if (state.pending.length > BURST_ENTER) {
          state.burst = true;
          const kept = [];
          let excess = state.pending.length - BURST_EXIT;
          let carriedThought = null; // dropped beats hand their thought on
          for (const b of state.pending) {
            if (excess > 0 && COSMETIC_KINDS.has(b.kind)) {
              excess -= 1;
              if (b.thought) carriedThought = b.thought;
              continue;
            }
            if (carriedThought && !b.thought) {
              kept.push({ ...b, thought: carriedThought });
              carriedThought = null;
            } else {
              kept.push(b);
            }
          }
          state.pending = kept;
        } else if (state.pending.length <= BURST_EXIT) {
          state.burst = false;
        }
        const next = state.pending.shift();
        state.current = next;
        state.elapsed = 0;
        state.duration = Math.max(next.dur * durScale * (state.burst ? 0.5 : 1), 0.05);
        emit('start', next);
      }
      return state.current;
    },
  };
}

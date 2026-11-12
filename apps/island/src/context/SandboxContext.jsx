/**
 * Sandbox spectator state — one SSE frame stream in, clean slices out.
 *
 * Deliberately lean:
 * world meta, the static island sheet, the live roster, a capped headline
 * event log, and the follow selection. Reconnects resume from the last seen
 * tick via the ?since_tick= cursor — spectators never notice.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  createWorld, deleteWorld as deleteWorldApi, getWorldMap, getWorldState,
  pauseWorld, runWorld, startWorld, streamWorld,
} from '../services/sandboxApi';
import { forgetHostKey } from '../services/hostKeys';

const SandboxContext = createContext(null);

// Ticker-worthy event types — the god view stays uncluttered; everything
// else is follow-mode detail.
const HEADLINE_TYPES = new Set([
  'agent_joined', 'world_started', 'site_enter', 'site_exit',
  'combat_start', 'agent_death', 'loot_drop', 'season_end',
]);

const MAX_LOG = 60;
const SPEEDS = { 1: 2.0, 2: 1.0, 4: 0.5 };
// A dropped stream is usually a blip. Retrying forever is how a deleted
// world became an invisible infinite loop, so the ladder is finite and
// ends at "offline" — an honest answer beats a silent one.
const STREAM_RETRIES = 5;
const STREAM_BACKOFF_MS = [1500, 3000, 5000, 8000, 12000];

export function SandboxProvider({ children }) {
  // landing = backend is up and no world is attached. Distinct from
  // offline (backend unreachable) — the old single try/catch could not
  // tell those apart, so a dead ?world= looked like an outage.
  const [status, setStatus] = useState('connecting'); // connecting | landing | offline | ready
  // Why we bounced back to the landing page, if we did.
  const [notice, setNotice] = useState(null);
  const [world, setWorld] = useState(null); // {world_id, phase, tick, ...} from /state
  const [islandMap, setIslandMap] = useState(null);
  const [roster, setRoster] = useState([]);
  const [eventLog, setEventLog] = useState([]);
  const [latestFrame, setLatestFrame] = useState(null);
  const [followedAgentId, setFollowedAgentId] = useState(null);
  const [speed, setSpeed] = useState(1);
  const [autoRunning, setAutoRunning] = useState(false);
  // Invite credentials only exist in the create response — keyed by world so
  // a stale code never renders against a different lobby.
  const [invite, setInvite] = useState(null); // {worldId, code, url}
  // Prompt-chan's latest line; id makes every line a fresh render even if
  // the text repeats.
  const [commentary, setCommentary] = useState(null); // {id, tick, text}
  const commentarySeq = useRef(0);

  // Follow-mode detail feeds: per-agent thought stream + action log.
  // God view never renders these — they exist for FollowPanel only.
  const [agentFeeds, setAgentFeeds] = useState({});
  // Live initiative order per contested location — the "why is it not my
  // turn" answer, rendered in follow mode. {locKey: [{id, name, roll}]}
  const [combatOrders, setCombatOrders] = useState({});

  const worldIdRef = useRef(null);
  const sinceTickRef = useRef(0);
  const streamRef = useRef(null);
  const retryRef = useRef(null);
  const retriesRef = useRef(0);

  const ingestFrame = useCallback((frame) => {
    sinceTickRef.current = Math.max(sinceTickRef.current, (frame.tick ?? 0) + 1);
    setLatestFrame(frame);
    if (frame.roster) setRoster(frame.roster);
    const detail = {};
    for (const ev of frame.events || []) {
      if (!ev.actor) continue;
      const slot = detail[ev.actor] ?? (detail[ev.actor] = { thoughts: [], log: [] });
      if (ev.event_type === 'agent_thought') {
        if (ev.data?.thought) slot.thoughts.push({ tick: ev.tick, text: ev.data.thought });
      } else if (ev.description && ev.event_type !== 'action_timeout') {
        slot.log.push({ tick: ev.tick, seq: ev.seq, text: ev.description });
      }
    }
    if (Object.keys(detail).length) {
      setAgentFeeds((prev) => {
        const next = { ...prev };
        for (const [aid, slot] of Object.entries(detail)) {
          const cur = next[aid] ?? { thoughts: [], log: [] };
          next[aid] = {
            thoughts: [...cur.thoughts, ...slot.thoughts].slice(-8),
            log: [...cur.log, ...slot.log].slice(-24),
          };
        }
        return next;
      });
    }
    const rolls = (frame.events || []).filter((e) => e.event_type === 'initiative_roll' && e.location);
    const ends = (frame.events || []).filter((e) => e.event_type === 'combat_end' && e.location);
    if (rolls.length || ends.length) {
      setCombatOrders((prev) => {
        const next = { ...prev };
        for (const ev of rolls) {
          const name = (ev.description || '').split(' rolls initiative')[0] || ev.data?.character_id;
          const entry = { id: ev.data?.character_id, name, roll: ev.data?.roll ?? 0 };
          const order = (next[ev.location] ?? []).filter((c) => c.id !== entry.id);
          order.push(entry);
          order.sort((a, b) => b.roll - a.roll);
          next[ev.location] = order;
        }
        for (const ev of ends) delete next[ev.location];
        return next;
      });
    }
    setWorld((prev) => prev && {
      ...prev,
      tick: frame.tick,
      phase: frame.phase,
      winner: frame.winner,
      winner_name: frame.winner_name,
      win_reason: frame.win_reason,
    });
    const headlines = (frame.events || []).filter((e) => HEADLINE_TYPES.has(e.event_type));
    if (headlines.length) {
      setEventLog((prev) => [...prev, ...headlines].slice(-MAX_LOG));
    }
    if (frame.phase === 'finished') setAutoRunning(false);
  }, []);

  // Tear down the socket and any pending reconnect, but LEAVE the retry
  // counter alone — this is what a reconnect attempt runs through, and
  // zeroing it here is how the ladder used to reset itself every attempt:
  // one error, one reconnect, count back to zero, retry forever at 1500ms
  // and never reach 'offline'.
  const dropStream = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.close();
    if (retryRef.current) clearTimeout(retryRef.current);
    retryRef.current = null;
  }, []);

  // Deliberate teardown (leaving a world, unmounting): the ladder is done,
  // so the next world starts from the top.
  const closeStream = useCallback(() => {
    dropStream();
    retriesRef.current = 0;
  }, [dropStream]);

  /** Let go of the current world and show the lobby browser. */
  const goLanding = useCallback((why = null) => {
    worldIdRef.current = null;
    closeStream();
    const params = new URLSearchParams(window.location.search);
    if (params.has('world')) {
      params.delete('world');
      const qs = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    }
    setWorld(null);
    setRoster([]);
    setIslandMap(null);
    setLatestFrame(null);
    setAutoRunning(false);
    setNotice(why);
    setStatus('landing');
  }, [closeStream]);

  const openStream = useCallback((worldId) => {
    dropStream();
    let stream;
    stream = streamWorld(worldId, {
      sinceTick: sinceTickRef.current,
      onFrame: (frame) => {
        if (streamRef.current !== stream) return;
        // A frame is proof the stream is healthy again — only now does the
        // ladder reset, so a flapping connection still climbs to 'offline'.
        retriesRef.current = 0;
        ingestFrame(frame);
      },
      onCommentary: (line) => {
        if (streamRef.current !== stream) return;
        commentarySeq.current += 1;
        setCommentary({ id: commentarySeq.current, tick: line.tick, text: line.text });
      },
      onDeleted: () => {
        if (streamRef.current !== stream) return;
        streamRef.current = null;
        forgetHostKey(worldId); // the key names a world that no longer exists
        goLanding('That season was ended by its host.');
      },
      onError: () => {
        if (streamRef.current !== stream) return;
        streamRef.current = null;
        if (retriesRef.current >= STREAM_RETRIES) {
          setStatus('offline');
          return;
        }
        const wait = STREAM_BACKOFF_MS[retriesRef.current] ?? 12000;
        retriesRef.current += 1;
        if (retryRef.current) clearTimeout(retryRef.current);
        retryRef.current = setTimeout(async () => {
          if (worldIdRef.current !== worldId) return;
          // Ask whether the world still exists before reconnecting to it.
          // Reconnecting in a loop to a deleted season was invisible: no
          // error, no frames, a spectator staring at a frozen board.
          try {
            await getWorldState(worldId);
          } catch (err) {
            if (err?.status === 404) {
              forgetHostKey(worldId);
              goLanding('That season is over or was deleted.');
              return;
            }
          }
          if (worldIdRef.current === worldId) openStream(worldId);
        }, wait);
      },
    });
    streamRef.current = stream;
  }, [dropStream, goLanding, ingestFrame]);

  const attachWorld = useCallback(async (worldId, { resetLog = true } = {}) => {
    worldIdRef.current = worldId;
    sinceTickRef.current = 0;
    retriesRef.current = 0; // a new world gets the full ladder, not the last one's tail
    // The address bar always names the world being watched: a reload lands
    // back here, and creating a season needs no copy-the-URL step.
    const params = new URLSearchParams(window.location.search);
    if (params.get('world') !== worldId) {
      params.set('world', worldId);
      window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
    }
    if (resetLog) setEventLog([]);
    setAgentFeeds({});
    setCombatOrders({});
    setFollowedAgentId(null);
    // A stale sign-off from the previous season must not bleed into the
    // new one's tick 0 — PromptChan remounts on the lobby->running flip
    // and would otherwise adopt whatever line is still sitting here.
    setCommentary(null);
    setNotice(null);
    setStatus('connecting');
    let state;
    let map;
    try {
      [state, map] = await Promise.all([
        getWorldState(worldId),
        getWorldMap(worldId),
      ]);
    } catch (err) {
      if (worldIdRef.current !== worldId) return null;
      // A world id that no longer resolves is not an outage — it is a
      // shared link to a season that has been swept, deleted, or never
      // existed. Send them somewhere they can actually do something.
      if (err?.status === 404) {
        forgetHostKey(worldId);
        goLanding('That season is over or was deleted.');
      } else {
        setStatus('offline');
      }
      return null;
    }
    if (worldIdRef.current !== worldId) return null;
    setWorld(state);
    setRoster(state.roster || []);
    setIslandMap(map);
    setAutoRunning(!!state.auto_running);
    openStream(worldId);
    setStatus('ready');
    return state;
  }, [goLanding, openStream]);

  // Boot: honor ?world=, otherwise show the lobby browser.
  //
  // This used to auto-adopt the first live world and, failing that, CREATE
  // one. Both were wrong: opening the page is not a request to start a
  // season, every visit littered a lobby nobody chose, and two tabs would
  // silently fight over the same world. Choosing is the landing page's job.
  useEffect(() => {
    let cancelled = false;
    const forced = new URLSearchParams(window.location.search).get('world');
    if (!forced) {
      setStatus('landing');
    } else {
      attachWorld(forced).catch(() => { if (!cancelled) setStatus('offline'); });
    }
    return () => { cancelled = true; closeStream(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lobby liveness fallback: joins broadcast frames now, but a spectator who
  // attached across a backend restart (or raced a reconnect) would still sit
  // on a stale roster — poll /state gently while the lobby is open.
  useEffect(() => {
    const lobbyWorldId = world?.phase === 'lobby' ? world.world_id : null;
    if (!lobbyWorldId) return undefined;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const state = await getWorldState(lobbyWorldId);
        if (cancelled || worldIdRef.current !== lobbyWorldId) return;
        setWorld(state);
        setRoster(state.roster || []);
      } catch (err) {
        if (cancelled || worldIdRef.current !== lobbyWorldId) return;
        // The host can delete a lobby out from under a watcher.
        if (err?.status === 404) goLanding('That season is over or was deleted.');
        /* anything else is transient — the stream will catch us up */
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [world?.phase, world?.world_id, goLanding]);

  // --- host controls ---

  const startSeason = useCallback(async () => {
    const worldId = worldIdRef.current;
    if (!worldId) return;
    await startWorld(worldId);
    const state = await getWorldState(worldId);
    setWorld(state);
    setRoster(state.roster || []);
    await runWorld(worldId, SPEEDS[speed]);
    setAutoRunning(true);
  }, [speed]);

  const setRunning = useCallback(async (running) => {
    const worldId = worldIdRef.current;
    if (!worldId) return;
    if (running) {
      await runWorld(worldId, SPEEDS[speed]);
      setAutoRunning(true);
    } else {
      await pauseWorld(worldId);
      setAutoRunning(false);
    }
  }, [speed]);

  const changeSpeed = useCallback(async (next) => {
    setSpeed(next);
    const worldId = worldIdRef.current;
    if (!worldId || !autoRunning) return;
    await pauseWorld(worldId);
    await runWorld(worldId, SPEEDS[next]);
  }, [autoRunning]);

  const newSeason = useCallback(async (opts = {}) => {
    const worldId = worldIdRef.current;
    try {
      // Only pause what we're allowed to pause — a spectator opening their
      // own lobby must not 403 on the way out of someone else's season.
      if (worldId && world?.can_control) await pauseWorld(worldId).catch(() => {});
      const created = await createWorld(opts); // stashes our host key
      setInvite(created.invite_code
        ? { worldId: created.world_id, code: created.invite_code, url: created.invite_url }
        : null);
      await attachWorld(created.world_id);
      return created;
    } catch {
      setStatus('offline');
      return null;
    }
  }, [attachWorld, world?.can_control]);

  /** Leave the current world for the lobby browser. */
  const detachWorld = useCallback(() => goLanding(null), [goLanding]);

  /** Destroy a season. Landing cards pass an id; the HUD deletes the
   *  world in view. Either way we end up back at the browser. */
  const deleteSeason = useCallback(async (worldId) => {
    const target = worldId || worldIdRef.current;
    if (!target) return false;
    try {
      await deleteWorldApi(target);
    } catch (err) {
      // Already gone is the outcome we wanted; anything else is real.
      if (err?.status !== 404) throw err;
    }
    forgetHostKey(target);
    if (worldIdRef.current === target) goLanding('Season deleted.');
    return true;
  }, [goLanding]);

  const followedAgent = useMemo(
    () => roster.find((a) => a.agent_id === followedAgentId) || null,
    [roster, followedAgentId],
  );

  const value = useMemo(() => ({
    status,
    notice,
    dismissNotice: () => setNotice(null),
    // Whether this browser may drive the world in view. The server's
    // answer, never our own guess — we hold a key, it decides what it opens.
    canControl: Boolean(world?.can_control),
    // Operator-only servers refuse lobby creation outright. Absent means an
    // older backend that has no such mode — treat that as allowed.
    canCreate: world?.can_create !== false,
    world,
    islandMap,
    roster,
    eventLog,
    latestFrame,
    agentFeeds,
    combatOrders,
    followedAgentId,
    followedAgent,
    setFollowedAgentId,
    speed,
    autoRunning,
    invite,
    commentary,
    startSeason,
    setRunning,
    changeSpeed,
    newSeason,
    attachWorld,
    detachWorld,
    deleteSeason,
  }), [status, notice, world, islandMap, roster, eventLog, latestFrame, agentFeeds,
       combatOrders, followedAgentId, followedAgent, speed, autoRunning,
       invite, commentary, startSeason, setRunning, changeSpeed, newSeason,
       attachWorld, detachWorld, deleteSeason]);

  return <SandboxContext.Provider value={value}>{children}</SandboxContext.Provider>;
}

export function useSandbox() {
  const ctx = useContext(SandboxContext);
  if (!ctx) throw new Error('useSandbox must be used within SandboxProvider');
  return ctx;
}

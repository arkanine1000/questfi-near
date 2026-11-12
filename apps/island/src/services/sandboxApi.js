/**
 * Sandbox world API client — mirrors quest_sim/api/world_routes.py.
 *
 * Lobby-first seasons: create → (BYO agents join over HTTP) → start
 * (hosted backfill) → auto-run. The spectator consumes one SSE stream of
 * whole tick frames ({tick, roster, events, phase, winner}) with
 * ?since_tick= cursor backfill, so reconnects are seamless.
 */

import { fetchEventSource } from '@microsoft/fetch-event-source';
import { credentialFor, setHostKey, setServerOperatorOnly } from './hostKeys';

const BASE_URL = import.meta.env.VITE_BACKEND_URL || '/api';

/** Absolute base an external agent can be pointed at (dev proxy included). */
export function apiBaseUrl() {
  return BASE_URL.startsWith('http') ? BASE_URL : `${window.location.origin}${BASE_URL}`;
}

/**
 * Pass `worldId` and the caller's host credential rides along as X-Host-Key.
 * Harmless when we hold none — the server answers can_control: false rather
 * than erroring, so a spectator's reads work exactly as before.
 *
 * A route that needs the credential but has NO world to key it to must pass
 * `auth: true` explicitly (GET /world, POST /world/new). Forgetting that is
 * silent: the call simply goes out unauthenticated and 403s only on a
 * server that has enforcement or operator-only turned on.
 */
async function request(path, { worldId, auth = Boolean(worldId), ...options } = {}) {
  const credential = auth ? credentialFor(worldId) : null;
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(credential ? { 'X-Host-Key': credential } : {}),
      ...options.headers,
    },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // .status matters now: 404 (world gone -> landing), 403 (not the host)
    // and a real outage each want different handling, and string-parsing a
    // message to tell them apart is how that goes wrong quietly.
    const err = new Error(`Sandbox API ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// --- lifecycle ---

export function createWorld({
  seed, poolSize, hostedBrain, actionDeadlineS, tickSeconds, maxTicks, requireInvite,
} = {}) {
  const body = {};
  if (seed !== undefined) body.seed = seed;
  if (poolSize !== undefined) body.pool_size = poolSize;
  if (hostedBrain !== undefined) body.hosted_brain = hostedBrain;
  if (actionDeadlineS !== undefined) body.action_deadline_s = actionDeadlineS;
  if (tickSeconds !== undefined) body.tick_seconds = tickSeconds;
  if (maxTicks !== undefined) body.max_ticks = maxTicks;
  if (requireInvite !== undefined) body.require_invite = requireInvite;
  // auth:true, not a worldId — this is the one credentialed route with no
  // world to key against yet, which is why the server gates it through its
  // own _can_create rather than _is_host. Omitting it 403s on an
  // operator-only instance while listWorlds (which DOES send the key) still
  // reports can_create:true, so the button renders and then fails.
  return request('/world/new', { method: 'POST', auth: true, body: JSON.stringify(body) })
    .then((created) => {
      // Handed back exactly once. Miss it and this browser is a spectator
      // of a season it just opened.
      setHostKey(created.world_id, created.host_key);
      return created;
    });
}

export function listWorlds() {
  return request('/world', { auth: true }).then(noteMode);
}

/**
 * Does the server consider our key the operator's? `{operator, operator_only,
 * admin_key_configured}`.
 *
 * The one route that answers the question directly rather than reporting a
 * permission we then reason backwards from. can_create only tells us on an
 * operator-only instance; an open one grants it to everybody, so a typo'd
 * key looks perfect there right up until it fails on someone else's world.
 */
export function whoami() {
  return request('/world/whoami', { auth: true });
}

/** Record the server's mode; credentialFor() picks its precedence from it. */
function noteMode(payload) {
  if (payload && typeof payload.operator_only === 'boolean') {
    setServerOperatorOnly(payload.operator_only);
  }
  return payload;
}

export function deleteWorld(worldId) {
  return request(`/world/${worldId}`, { method: 'DELETE', worldId });
}

export function joinWorld(worldId, { name, preset } = {}) {
  return request(`/world/${worldId}/join`, {
    method: 'POST',
    body: JSON.stringify({ name, preset }),
  });
}

export function startWorld(worldId) {
  return request(`/world/${worldId}/start`, { method: 'POST', worldId });
}

// --- the arena: seasons the server runs by itself ---

/** The season open for entry, the one running and the last result. */
export function getArena() {
  return request('/near/arena');
}

/** Start the open season now instead of waiting out its countdown. */
export function startArena() {
  return request('/near/arena/start', { method: 'POST' });
}

// --- clock ---

export function tickWorld(worldId) {
  return request(`/world/${worldId}/tick`, { method: 'POST', worldId });
}

export function runWorld(worldId, tickSeconds) {
  return request(`/world/${worldId}/run`, {
    method: 'POST',
    worldId,
    body: JSON.stringify(tickSeconds ? { tick_seconds: tickSeconds } : {}),
  });
}

export function pauseWorld(worldId) {
  return request(`/world/${worldId}/pause`, { method: 'POST', worldId });
}

// --- spectator reads ---

export function getWorldState(worldId) {
  return request(`/world/${worldId}/state`, { worldId }).then(noteMode);
}

export function getWorldMap(worldId) {
  return request(`/world/${worldId}/map`);
}

export function getSiteMap(worldId, siteId) {
  return request(`/world/${worldId}/site/${siteId}/map`);
}

export function getEvents(worldId, { sinceTick = 0, sinceSeq = 0 } = {}) {
  return request(`/world/${worldId}/events?since_tick=${sinceTick}&since_seq=${sinceSeq}`);
}

/**
 * Subscribe to the spectator frame stream. `onFrame(frame)` fires for every
 * tick frame (backfill first, then live); `onCommentary(line)` fires when
 * Prompt-chan speaks; `onDeleted()` fires when the host destroys the season,
 * after which the server closes the stream and there is nothing to
 * reconnect to. Returns { close }.
 */
export function streamWorld(worldId, {
  sinceTick = 0, onFrame, onCommentary, onDeleted, onError,
} = {}) {
  const ctrl = new AbortController();
  fetchEventSource(`${BASE_URL}/world/${worldId}/stream?since_tick=${sinceTick}`, {
    method: 'GET',
    signal: ctrl.signal,
    openWhenHidden: true,
    onmessage(ev) {
      if (ev.event === 'deleted') {
        ctrl.abort(); // the season is gone; don't let onerror retry it
        onDeleted?.();
        return;
      }
      const handler = ev.event === 'commentary' ? onCommentary
        : ev.event === 'frame' ? onFrame : null;
      if (!handler) return;
      try {
        handler(JSON.parse(ev.data));
      } catch {
        /* malformed payload — skip */
      }
    },
    onerror(err) {
      onError?.(err);
      throw err; // stop auto-reconnect; the context re-subscribes deliberately
    },
  });
  return { close: () => ctrl.abort() };
}

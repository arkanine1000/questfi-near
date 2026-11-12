/**
 * Host credentials, held client-side only.
 *
 * Opening a lobby mints a host_key that the backend hands back exactly once
 * (POST /world/new). Whoever holds it runs that season; everyone else
 * spectates. We stash it per world, the same shape BettingContext uses for
 * `sbx-bets:${worldId}`.
 *
 * The operator's skeleton key (QUEST_SIM_ADMIN_KEY) is a BACKEND variable and
 * must never be built into this bundle — anything reachable from
 * import.meta.env is inlined into the JS at build time and served to every
 * visitor. The operator types it into Settings at runtime instead, and it
 * lives here in their browser only.
 *
 * Nothing here decides anything. The key is sent; the server answers with
 * can_control. There is no client-side notion of "am I an admin".
 */

const WORLD_KEYS = 'sbx-host-keys'; // { [worldId]: key }
const ADMIN_KEY = 'sbx-admin-key';

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback; // private mode / disabled storage — spectate quietly
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* nothing to do; the key just won't survive a reload */ }
}

export function getHostKey(worldId) {
  if (!worldId) return null;
  return readJSON(WORLD_KEYS, {})[worldId] || null;
}

export function setHostKey(worldId, key) {
  if (!worldId || !key) return;
  writeJSON(WORLD_KEYS, { ...readJSON(WORLD_KEYS, {}), [worldId]: key });
}

export function forgetHostKey(worldId) {
  const all = readJSON(WORLD_KEYS, {});
  if (!(worldId in all)) return;
  delete all[worldId];
  writeJSON(WORLD_KEYS, all);
}

export function getAdminKey() {
  try {
    return localStorage.getItem(ADMIN_KEY) || null;
  } catch {
    return null;
  }
}

export function setAdminKey(key) {
  try {
    if (key) localStorage.setItem(ADMIN_KEY, key);
    else localStorage.removeItem(ADMIN_KEY);
  } catch { /* ignore */ }
}

const OPERATOR_ONLY = 'sbx-operator-only';

/**
 * Whether the server is running operator-only, as last reported by it.
 *
 * Persisted because precedence below has to be right on the FIRST request
 * of a page load — a `?world=` deep link fetches /state before anything has
 * told us which mode the server is in.
 */
export function setServerOperatorOnly(on) {
  try {
    if (on) localStorage.setItem(OPERATOR_ONLY, '1');
    else localStorage.removeItem(OPERATOR_ONLY);
  } catch { /* ignore */ }
}

function serverIsOperatorOnly() {
  try {
    return localStorage.getItem(OPERATOR_ONLY) === '1';
  } catch {
    return false;
  }
}

/**
 * The credential to send for a world. One header, so we must choose.
 *
 * Normally the world's own host key wins: it is the specific credential for
 * this season, and an operator key held alongside it opens the same doors
 * anyway.
 *
 * Under operator-only the order INVERTS, because host keys are inert there
 * by design — sending one is sending the single credential the server is
 * guaranteed to refuse. That is what made an operator who had just opened a
 * lobby unable to start or delete it: creating stored a host key, and from
 * then on we handed the server nothing else.
 */
export function credentialFor(worldId) {
  const host = getHostKey(worldId);
  const admin = getAdminKey();
  return serverIsOperatorOnly() ? (admin || host) : (host || admin);
}

/**
 * Console access for the operator, so a key can be set on a machine where
 * clicking through the landing view is awkward (a TV, a kiosk, a shared
 * screen). Reloads because everything already fetched was fetched without
 * the header.
 */
export function installConsoleHelpers() {
  if (typeof window === 'undefined' || window.questfi) return;
  window.questfi = {
    setOperatorKey(key) {
      if (!key || typeof key !== 'string') {
        console.warn('QUESTFI — pass the key as a string.');
        return;
      }
      setAdminKey(key.trim());
      console.info('QUESTFI — operator key saved, reloading.');
      window.location.reload();
    },
    clearOperatorKey() {
      setAdminKey(null);
      console.info('QUESTFI — operator key cleared, reloading.');
      window.location.reload();
    },
    hasOperatorKey: () => Boolean(getAdminKey()),
  };
  // Discoverable without reading source; harmless to everyone else.
  console.info(
    '%cQUESTFI%c operator? window.questfi.setOperatorKey("…")',
    'color:#00ff41;font-weight:bold', 'color:#7abf8f',
  );
}

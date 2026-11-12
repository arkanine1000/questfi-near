/**
 * TV casting — one thin seam over the Presentation API.
 *
 * Sender side (the phone/laptop): TopBar's cast button launches the
 * `?view=tv` receiver page on a Chromecast/Android TV and keeps a message
 * channel open so following an agent locally steers the TV's camera too.
 * No Google Cast SDK, no receiver registration — Chrome presents any
 * HTTPS URL to a Cast device natively.
 *
 * Receiver side (the TV): the same app booted with `?view=tv` renders the
 * lean-back broadcast and listens for follow/deselect/world commands.
 *
 * Plain module, no context: anything can fire-and-forget `sendToTv()`
 * and it no-ops unless a session is live (promptChanVoice.js pattern).
 */

/** True when this page IS the TV — the lean-back `?view=tv` broadcast. */
export const IS_TV = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('view') === 'tv';

/** Absolute receiver URL, optionally pinned to a world. */
function tvUrl(worldId) {
  const params = new URLSearchParams({ view: 'tv' });
  if (worldId) params.set('world', worldId);
  return `${window.location.origin}${window.location.pathname}?${params}`;
}

// --- sender ---------------------------------------------------------------

let availabilityRequest = null;
let connection = null;
let state = {
  // Secure context + API present. The TV itself never casts onward.
  supported: typeof window !== 'undefined' && 'PresentationRequest' in window && !IS_TV,
  available: false, // a cast target is reachable on the network
  casting: false, // a live session exists
};
const listeners = new Set();

function emit(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

/** Subscribe to {supported, available, casting}; fires immediately. */
export function subscribeCast(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

/**
 * Start monitoring whether a cast target exists so the button only renders
 * when there's a TV to cast to. Idempotent; safe to call from any mount.
 */
export function watchCastAvailability() {
  if (!state.supported || availabilityRequest) return;
  try {
    availabilityRequest = new PresentationRequest([tvUrl()]);
    availabilityRequest.getAvailability()
      .then((availability) => {
        emit({ available: availability.value });
        availability.addEventListener('change', () => {
          emit({ available: availability.value });
        });
      })
      // Some platforms can't monitor availability (NotSupportedError) —
      // show the button and let start() find out.
      .catch(() => emit({ available: true }));
  } catch {
    // Insecure context or exotic UA — constructor threw; stay hidden.
    emit({ supported: false });
  }
}

function adoptConnection(conn) {
  connection = conn;
  const drop = () => {
    if (connection !== conn) return;
    connection = null;
    emit({ casting: false });
  };
  conn.addEventListener('close', drop);
  conn.addEventListener('terminate', drop);
  emit({ casting: true });
}

/**
 * Open the system cast picker (user gesture required) and present the
 * world-pinned TV page. Resolves once the receiver launches; rejects if
 * the user dismisses the picker — callers can ignore that.
 */
export async function startCast(worldId) {
  if (!state.supported) return;
  const request = new PresentationRequest([tvUrl(worldId)]);
  adoptConnection(await request.start());
}

/** End the session AND close the page on the TV. */
export function stopCast() {
  connection?.terminate();
  connection = null;
  emit({ casting: false });
}

/** Fire-and-forget a command at the TV; silent no-op when not casting. */
export function sendToTv(msg) {
  if (connection?.state !== 'connected') return;
  try {
    connection.send(JSON.stringify(msg));
  } catch {
    // racing a close — the drop handler will catch up
  }
}

// --- receiver -------------------------------------------------------------

/**
 * On the TV page, hand every sender command ({type, ...}) to `handler`.
 * Present-API receivers can host several controllers; all get wired.
 * Returns a disposer (listeners on dead connections are GC'd with them).
 */
export function onTvCommand(handler) {
  const receiver = typeof navigator !== 'undefined' && navigator.presentation?.receiver;
  if (!IS_TV || !receiver) return () => {};
  let disposed = false;
  const wire = (conn) => {
    conn.addEventListener('message', (e) => {
      if (disposed) return;
      try {
        handler(JSON.parse(e.data));
      } catch {
        // not ours / malformed — ignore
      }
    });
  };
  receiver.connectionList.then((list) => {
    if (disposed) return;
    list.connections.forEach(wire);
    list.addEventListener('connectionavailable', (e) => wire(e.connection));
  });
  return () => { disposed = true; };
}

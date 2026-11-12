/**
 * Settle-tracking for the crawler's *imperative* texture loads.
 *
 * `useLoader`/`useTexture` suspend, so a Suspense boundary is proof enough
 * that they landed. The module-level getters in crawlerTextures.js and
 * spriteSheet.js do not suspend — they hand back a THREE.Texture straight
 * away and fill in the pixels (and, for a sprite sheet, the UV window)
 * whenever the decode finishes. Untracked, that is precisely the pop-in the
 * loading screen exists to hide: untextured walls that snap to brick, torch
 * flames that play the wrong cell of the sheet for a frame or two.
 *
 * So every such load registers here, and the loading gate waits on all of
 * them before revealing the scene.
 */

const pending = new Set();

// A request that neither loads nor errors — a black-holed proxy, a hung
// connection — would otherwise sit in `pending` forever. `pending` is
// module-global and outlives the component, so one stalled texture would
// gate not just this descent but every descent for the life of the tab.
// Force-settle instead: a texture this late is not worth waiting on.
const STALL_MS = 10000;

/**
 * Load a texture through `loader` and register the in-flight decode.
 *
 * Returns the texture synchronously, exactly as `loader.load()` does — the
 * tracking is a side channel, not a change to the call contract.
 *
 * Failures SETTLE rather than reject: a 404 on a decorative texture must
 * degrade to an untextured surface, never wedge the loading screen open.
 */
export function trackedLoad(loader, url, onLoad) {
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  pending.add(done);
  done.then(() => pending.delete(done));

  const stall = setTimeout(settle, STALL_MS);
  const finish = () => { clearTimeout(stall); settle(); };

  return loader.load(
    url,
    (loaded) => {
      try {
        onLoad?.(loaded);
      } finally {
        finish();
      }
    },
    undefined,
    finish,
  );
}

/**
 * Resolves once every load registered so far has settled. Snapshots the set,
 * so a load kicked off later does not extend an await already in flight.
 */
export function whenTrackedLoadsSettle() {
  return Promise.all([...pending]);
}

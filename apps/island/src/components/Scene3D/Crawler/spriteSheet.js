import * as THREE from 'three';
import { trackedLoad } from './loadTracker';
import { makeTintVariant } from './crawlerTextures';

/**
 * Runtime half of the project's sprite-animation convention. The build half
 * is scripts/buildSpriteSheet.mjs, which packs equal-sized frames into a
 * horizontal strip and writes a sidecar .json manifest describing the
 * layout.
 *
 * Sheets are memoized at module level so repeated crawler mounts reuse the
 * same GPU upload, matching crawlerTextures.js.
 *
 * Callers pass the layout explicitly rather than fetching the manifest: the
 * manifest is build provenance that lives next to the asset, and a runtime
 * fetch would stall the first frame behind a second round-trip for three
 * numbers that never change.
 */

const sheetCache = new Map();

/**
 * Memoized sprite sheet texture, framed to a single cell.
 *
 * Wrapping MUST be ClampToEdge: with RepeatWrapping, a UV that lands a hair
 * outside the cell wraps to the far side of the sheet and samples a
 * completely different frame.
 *
 * The frame window is also inset by half a texel on each side. Bilinear
 * filtering samples a 2x2 neighbourhood, so a UV exactly on a cell boundary
 * blends in the first column of the adjacent frame — the classic sprite
 * sheet edge-bleed. The inset costs half a pixel of the frame and removes
 * the artifact entirely.
 *
 * The load is tracked because it does not suspend: until the decode lands
 * the inset is zero and the sheet samples the wrong window, so the loading
 * gate holds the curtain until every sheet has settled.
 */
export function getSpriteSheetTexture(url, { columns = 1, rows = 1 } = {}) {
  const key = `${url}|${columns}x${rows}`;
  if (sheetCache.has(key)) return sheetCache.get(key);

  const tex = trackedLoad(new THREE.TextureLoader(), url, (loaded) => {
    // Image dimensions are only known once decoding finishes, so the
    // half-texel inset has to be applied here rather than up front.
    const { width, height } = loaded.image;
    const insetU = width ? 0.5 / width : 0;
    const insetV = height ? 0.5 / height : 0;
    loaded.repeat.set(1 / columns - insetU * 2, 1 / rows - insetV * 2);
    loaded.userData.spriteInset = { u: insetU, v: insetV };
    loaded.needsUpdate = true;
  });
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(1 / columns, 1 / rows);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.sheet = { columns, rows };
  tex.userData.spriteInset = { u: 0, v: 0 };

  sheetCache.set(key, tex);
  return tex;
}

/**
 * Independent playback head on a shared sheet.
 *
 * THREE.Texture.clone() copies the uniforms (offset/repeat) but SHARES the
 * underlying .source, and the renderer keys its GPU texture cache on source
 * — so N clones cost exactly one upload while each animates on its own
 * frame and phase. This is what keeps a room full of torches from flickering
 * in lockstep without paying for N copies of the image.
 */
export function cloneFrameTexture(base) {
  const tex = base.clone();
  tex.userData = { ...base.userData };
  tex.needsUpdate = true;
  return tex;
}

/** Point a cloned sheet texture at frame `index` (row-major, wraps). */
export function setFrame(tex, index) {
  const { columns = 1, rows = 1 } = tex.userData.sheet ?? {};
  const { u = 0, v = 0 } = tex.userData.spriteInset ?? {};
  const total = columns * rows;
  const i = ((Math.floor(index) % total) + total) % total;
  const col = i % columns;
  const row = Math.floor(i / columns);
  // Sheets are packed top-down; three.js UV origin is bottom-left.
  tex.offset.set(col / columns + u, 1 - (row + 1) / rows + v);
}

/**
 * Channel-swap tint of a sheet, still framed to a single cell.
 *
 * makeTintVariant memoizes on the decoded image and hands back a plain
 * CanvasTexture: full-sheet UVs, no sheet layout, no inset. Bound as a
 * material's map it would show every cell at once, squashed onto the quad.
 * Clone it — the clone shares the tinted .source, so the whole tint costs one
 * extra upload no matter how many playback heads exist — and carry the base's
 * layout and half-texel inset across, so setFrame drives tint and base
 * identically.
 *
 * MUST be called after `base` has decoded: getSpriteSheetTexture applies the
 * inset in its load callback, and a variant built before that would sample
 * half a texel into the neighbouring frame for the life of the texture.
 * Callers build it lazily, on first use.
 */
export function makeSheetTintVariant(base, mode) {
  const tex = makeTintVariant(base.image, mode).clone();
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.userData = { ...base.userData }; // sheet layout + spriteInset
  tex.repeat.copy(base.repeat);
  tex.offset.copy(base.offset);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Frame index for a ping-pong cycle: 0,1,2,1,0,1,2...
 *
 * A short sheet played as a straight loop snaps visibly when it wraps from
 * the last frame back to the first. Ping-pong reads as continuous motion,
 * which is what sells a 3-frame flame as a flicker rather than a stutter.
 */
export function pingPongFrame(elapsed, frames, fps) {
  if (frames <= 1) return 0;
  const period = frames * 2 - 2; // 3 frames -> 0,1,2,1
  const step = Math.floor(elapsed * fps) % period;
  return step < frames ? step : period - step;
}

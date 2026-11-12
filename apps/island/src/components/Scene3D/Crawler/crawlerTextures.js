import * as THREE from 'three';
import { trackedLoad } from './loadTracker';
import { publicUrl } from '../../../services/publicUrl';

/**
 * Procedural phosphor-grid canvas textures for the first-person crawler —
 * port of questfi-lobby src/textures.js makeGridTexture (green phosphor),
 * tuned per surface. Zero art assets: everything is drawn at runtime.
 *
 * All textures are memoized at module level so repeated crawler mounts
 * reuse the same GPU uploads.
 */

export function makeGridTexture({
  size = 256,
  lineColor = 'rgba(53,255,125,1)',
  glowColor = 'rgba(30,180,90,0.55)',
  bg = '#020a05',
  lineWidth = 2,
  glowWidth = 7,
  brightness = 1,
  repeat = [1, 1],
} = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  // faint inner noise/texture so tiles don't look flat black
  ctx.fillStyle = 'rgba(40,120,70,0.05)';
  for (let i = 0; i < 60; i++) {
    ctx.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
  }

  ctx.globalAlpha = brightness;
  // soft glow pass then crisp line pass, drawn on the tile edges
  for (const [color, w] of [
    [glowColor, glowWidth],
    [lineColor, lineWidth],
  ]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.strokeRect(0, 0, size, size);
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Surface variants: floor reads brightest (it carries the player light),
// walls a step dimmer, ceiling barely-there so the space feels tall & dark.
const VARIANTS = {
  floor: {
    lineColor: 'rgba(53,255,125,0.9)',
    glowColor: 'rgba(30,180,90,0.5)',
    bg: '#021008',
    brightness: 1,
    repeat: [2, 2],
  },
  wall: {
    lineColor: 'rgba(53,255,125,0.55)',
    glowColor: 'rgba(30,180,90,0.3)',
    bg: '#020c06',
    brightness: 0.8,
    repeat: [2, 1.5],
  },
  ceiling: {
    lineColor: 'rgba(53,255,125,0.28)',
    glowColor: 'rgba(30,180,90,0.16)',
    bg: '#010805',
    brightness: 0.55,
    repeat: [2, 2],
  },
};

const textureCache = new Map();

/** Memoized phosphor grid texture for a surface kind: floor|wall|ceiling. */
export function getCrawlerTexture(kind) {
  if (!textureCache.has(kind)) {
    textureCache.set(kind, makeGridTexture(VARIANTS[kind] ?? VARIANTS.wall));
  }
  return textureCache.get(kind);
}

export const WALL_TILES_URL = publicUrl('/crawler/textures/wall-tiles.jpg');
export const WALL_TILES_NORMAL_URL = publicUrl('/crawler/textures/wall-tiles-normal.png');

const wallTilesCache = new Map();

/**
 * The green-brick wall texture (public/crawler/textures/wall-tiles.jpg), repeat
 * tuned per surface: walls are 4x3 world units, ceilings 4x4.
 *
 * CrawlerMaze sits OUTSIDE the scene's Suspense boundary, so nothing waits on
 * this load — hence trackedLoad, which lets the loading screen wait instead.
 */
export function getWallTilesTexture(kind = 'wall') {
  if (wallTilesCache.has(kind)) return wallTilesCache.get(kind);
  const tex = trackedLoad(new THREE.TextureLoader(), WALL_TILES_URL);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, kind === 'ceiling' ? 1 : 0.75);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  wallTilesCache.set(kind, tex);
  return tex;
}

const wallNormalCache = new Map();

/**
 * Tangent-space normal map paired with the wall tiles — generated from the
 * diffuse by scripts/generate_wall_normal_map.py, so brick edges register
 * exactly. Wrap/repeat must mirror getWallTilesTexture for the same kind;
 * colorSpace stays linear (the default) — normal data is not sRGB.
 */
export function getWallTilesNormalTexture(kind = 'wall') {
  if (wallNormalCache.has(kind)) return wallNormalCache.get(kind);
  const tex = trackedLoad(new THREE.TextureLoader(), WALL_TILES_NORMAL_URL);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, kind === 'ceiling' ? 1 : 0.75);
  tex.anisotropy = 8;
  wallNormalCache.set(kind, tex);
  return tex;
}

const glowDiscCache = new Map();

/**
 * Additive radial glow disc used as a floor indicator wash for special
 * room types (trap / treasure / boss / entrance). Memoized per color.
 */
export function getGlowDiscTexture(color) {
  if (glowDiscCache.has(color)) return glowDiscCache.get(color);
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, color);
  g.addColorStop(0.55, `${color}59`); // ~35% alpha
  g.addColorStop(1, `${color}00`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  glowDiscCache.set(color, tex);
  return tex;
}

// Channel-swap tints for the enemy billboard art. Green art x red tint would
// go black under additive blending, so rebuild the pixels instead (same
// technique as questfi-lobby enemy.js makeRedVariant).
const TINTS = {
  red: (d, i, g) => {
    d[i] = Math.min(255, g * 1.15); // green energy becomes red
    d[i + 1] = g * 0.12;
    d[i + 2] = d[i + 2] * 0.25;
  },
  cyan: (d, i, g) => {
    d[i] = g * 0.1; // green energy becomes cyan
    d[i + 1] = Math.min(255, g * 0.85);
    d[i + 2] = Math.min(255, g * 1.2);
  },
};

const tintCache = new WeakMap(); // img -> { red?, cyan?, '#rrggbb'? }

/**
 * Arbitrary-hue variant of a loaded sprite image: the sprite's green energy
 * channel is remapped into the given hex color (sandbox agents wear their
 * roster color in the crawler exactly as on the island). Memoized per
 * (img, color).
 */
export function makeColorTint(img, hexColor) {
  let entry = tintCache.get(img);
  if (entry?.[hexColor]) return entry[hexColor];

  const rr = parseInt(hexColor.slice(1, 3), 16) / 255;
  const gg = parseInt(hexColor.slice(3, 5), 16) / 255;
  const bb = parseInt(hexColor.slice(5, 7), 16) / 255;

  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = d[i + 1];
    d[i] = Math.min(255, g * rr * 1.15);
    d[i + 1] = Math.min(255, g * gg * 1.15);
    d[i + 2] = Math.min(255, g * bb * 1.2);
  }
  ctx.putImageData(id, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;

  if (!entry) {
    entry = {};
    tintCache.set(img, entry);
  }
  entry[hexColor] = tex;
  return tex;
}

/** Memoized tinted variant of a loaded sprite image ('red' | 'cyan'). */
export function makeTintVariant(img, mode) {
  let entry = tintCache.get(img);
  if (entry?.[mode]) return entry[mode];

  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  const swap = TINTS[mode] ?? TINTS.red;
  for (let i = 0; i < d.length; i += 4) {
    swap(d, i, d[i + 1]);
  }
  ctx.putImageData(id, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;

  if (!entry) {
    entry = {};
    tintCache.set(img, entry);
  }
  entry[mode] = tex;
  return tex;
}

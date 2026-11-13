/**
 * Shared world-space constants and helpers for the 3D holographic war table.
 *
 * The axial (q, r) hex coordinate system is the contract with all game logic.
 * This module maps it 1:1 into world space: image pixels 0..1536 x 0..1024
 * become a plane centered at the origin (divide by 100), Y-up.
 */
import { axialToPixel } from '../HexGrid/hexUtils';
import { getActiveMap } from '../../data/maps';

// Grid constants — must stay identical to HexGrid.jsx / generateMask.js
export const IMG_WIDTH = 1536;
export const IMG_HEIGHT = 1024;
export const HEX_SIZE = 46;
export const GRID_OFFSET_X = 100;
export const GRID_OFFSET_Y = 65;
export const GRID_COLS = 18;
export const GRID_ROWS = 14;

export const WORLD_PER_PIXEL = 1 / 100;
export const WORLD_WIDTH = IMG_WIDTH * WORLD_PER_PIXEL; // 15.36
export const WORLD_DEPTH = IMG_HEIGHT * WORLD_PER_PIXEL; // 10.24
export const HEX_WORLD_RADIUS = HEX_SIZE * WORLD_PER_PIXEL; // 0.46

// Terrain peak height in world units (≈0.18x of the island's world width —
// pronounced relief that still reads top-down). The single tuning knob.
export const TERRAIN_HEIGHT_SCALE = 1.9;

// The house palette shared with the start app and Agent World: phosphor
// green on near-black. Agent colours come from the server and are the only
// other vivid hues in the scene.
export const COLORS = {
  green: '#35ff7d',
  greenBright: '#7dffb0',
  bright: '#7dffb0',
  deep: '#0a3d1e',
  fill: '#1fd465', // hologram fill tint (emissive under the wireframe)
  wire: '#49ff8c', // hologram wireframe tint
  bg: '#010603',
  fog: '#021207',
  amber: '#ffd678', // money, the boss, treasure
  red: '#ff5d5d', // combat, danger
  ice: '#9be8ff',
  cyan: '#9be8ff', // older name for ice
  // terrain fill at sea level and at the peaks: near black, so the relief
  // reads from the contour lines rather than from lit faces
  terrain: '#020d07',
  terrainHigh: '#06200f',
  ocean: '#010603', // older name for bg
  flash: '#dfffe8',
};

/** Normalized 0..1 elevation at a land hex center (0 for water). */
export function hexElevationNorm(q, r) {
  return getActiveMap().elevations[`${q},${r}`] ?? 0;
}

/** World-space Y of the terrain surface at a hex center. */
export function hexElevation(q, r) {
  return hexElevationNorm(q, r) * TERRAIN_HEIGHT_SCALE;
}

/** Map image-space pixels to world-space X/Z. */
export function imagePxToWorld(px, py) {
  return {
    x: (px - IMG_WIDTH / 2) * WORLD_PER_PIXEL,
    z: (py - IMG_HEIGHT / 2) * WORLD_PER_PIXEL,
  };
}

/**
 * Axial hex -> world position. Reuses the exact axialToPixel math so agents
 * land in exactly the same spot as on the 2D map. Accepts fractional q/r
 * (e.g. guild centroids); elevation falls back to the nearest whole hex.
 */
export function axialToWorld(q, r) {
  const { x, y } = axialToPixel(q, r, HEX_SIZE);
  const { x: wx, z: wz } = imagePxToWorld(x + GRID_OFFSET_X, y + GRID_OFFSET_Y);
  const elev = getActiveMap().elevations[`${Math.round(q)},${Math.round(r)}`] ?? 0;
  return { x: wx, y: elev * TERRAIN_HEIGHT_SCALE, z: wz };
}

export function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function isWebGLAvailable() {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

export function isTouchDevice() {
  return typeof window !== 'undefined'
    && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
}

/** Capability gate for bloom postprocessing — emissive-only path otherwise. */
export function canUseBloom() {
  if (prefersReducedMotion()) return false;
  if ((navigator.hardwareConcurrency ?? 0) < 4) return false;
  return true;
}

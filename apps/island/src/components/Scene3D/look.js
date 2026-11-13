/**
 * Live look values for the 3D views.
 *
 * Covers the island and the dungeon view (keys prefixed `dungeon`).
 *
 * A tiny mutable store: the scene reads `look` every frame, so changing a
 * value needs no React render. Production builds never change it and simply
 * render the defaults; in development the `?look=1` panel (LookPanel.jsx)
 * writes to it so the look can be tuned by eye and the numbers copied back
 * into LOOK_DEFAULTS.
 */

export const LOOK_DEFAULTS = Object.freeze({
  // post pass (HouseFx)
  bloomIntensity: 0.6,
  bloomThreshold: 0.4,
  bloomRadius: 0.5,
  grade: 0.22,
  aberration: 0.8,
  scan: 0.06,
  vignette: 0.45,
  noise: 0.035,
  // scene
  fogDensity: 0.04,
  terrainFill: 1, // gain on the near-black height ramp of the land
  contours: 0.28, // brightness of the topographic contour lines
  shoreline: 0.9, // brightness of the sea-level contour
  hexOutline: 0.08, // brightness of a grid cell outline at rest
  propEdges: 0.35, // gain on the outline around trees, rocks and ruins
  seaLattice: 0.5, // brightness of the hex lattice drawn on the sea
  sonar: 1, // strength of the sonar pulses crossing the sea
  projector: 1, // gain on the projector rings around the island
  motes: 0.55, // opacity of the drifting motes
  agentBeam: 1, // gain on the light beams under the agents

  // dungeon (first-person view): the house lens at point-of-view values
  dungeonBloomIntensity: 0.6,
  dungeonBloomThreshold: 0.4,
  dungeonBloomRadius: 0.5,
  dungeonGrade: 0.55,
  dungeonAberration: 1,
  dungeonScan: 0.06,
  dungeonVignette: 0.55,
  dungeonNoise: 0.05,
  // dungeon scene
  dungeonWallTint: 1, // gain on the stone's base colour (what the lights catch)
  dungeonWallEmissive: 0.02, // the stone's own glow, away from any light
  dungeonEdgeLines: 1, // lines where the walls meet the floor and the ceiling
  dungeonFloorLines: 1, // the floor's phosphor grid
  dungeonTorch: 1, // gain on the wall torches' light
  dungeonAgentLight: 1, // gain on the light the followed agent carries
  dungeonWeaponFill: 0.12, // the held weapon's emissive fill
  dungeonWeaponWire: 0.5, // the held weapon's wireframe opacity
});

export const look = { ...LOOK_DEFAULTS };

const listeners = new Set();
let version = 0;

function notify() {
  version += 1;
  for (const fn of listeners) fn();
}

export function setLook(key, value) {
  if (!(key in LOOK_DEFAULTS) || !Number.isFinite(value) || look[key] === value) return;
  look[key] = value;
  notify();
}

export function resetLook() {
  Object.assign(look, LOOK_DEFAULTS);
  notify();
}

/** Calls `fn` after every change; returns the unsubscribe function. */
export function subscribeLook(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Increments on every change (a snapshot for useSyncExternalStore). */
export function lookVersion() {
  return version;
}

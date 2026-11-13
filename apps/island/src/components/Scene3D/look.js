/**
 * The look of the 3D views, in numbers.
 *
 * Covers the island and the dungeon view (keys prefixed `dungeon`). The
 * values were set by eye against the start app and Agent World; the scenes
 * read `look` every frame, so this file is the one place to change them.
 */

export const LOOK_DEFAULTS = Object.freeze({
  // post pass (HouseFx)
  bloomIntensity: 0.82,
  bloomThreshold: 0.15,
  bloomRadius: 0.5,
  grade: 0.22,
  aberration: 0.8,
  scan: 0.3,
  vignette: 0.45,
  noise: 0.006,
  // scene
  fogDensity: 0.04,
  terrainFill: 1.88, // gain on the near-black height ramp of the land
  contours: 0.56, // brightness of the topographic contour lines
  shoreline: 1.17, // brightness of the sea-level contour
  hexOutline: 0.08, // brightness of a grid cell outline at rest
  propEdges: 0.57, // gain on the outline around trees, rocks and ruins
  seaLattice: 0.5, // brightness of the hex lattice drawn on the sea
  sonar: 1, // strength of the sonar pulses crossing the sea
  projector: 1, // gain on the projector rings around the island
  motes: 0.55, // opacity of the drifting motes
  agentBeam: 1.36, // gain on the light beams under the agents

  // dungeon (first-person view): the house lens at point-of-view values
  dungeonBloomIntensity: 1.22,
  dungeonBloomThreshold: 0.33,
  dungeonBloomRadius: 0.75,
  dungeonGrade: 0.57,
  dungeonAberration: 0.78,
  dungeonScan: 0.3,
  dungeonVignette: 0.8,
  dungeonNoise: 0.006,
  // dungeon scene
  dungeonWallTint: 1.47, // gain on the stone's base colour (what the lights catch)
  dungeonWallEmissive: 0.15, // the stone's own glow, away from any light
  dungeonEdgeLines: 0.77, // lines where the walls meet the floor and the ceiling
  dungeonFloorLines: 2.51, // the floor's phosphor grid
  dungeonTorch: 0.91, // gain on the wall torches' light
  dungeonAgentLight: 0.29, // gain on the light the followed agent carries
  dungeonWeaponFill: 0.525, // the held weapon's emissive fill
  dungeonWeaponWire: 0.2, // the held weapon's wireframe opacity
});

export const look = LOOK_DEFAULTS;

import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  COLORS, GRID_OFFSET_X, GRID_OFFSET_Y, HEX_WORLD_RADIUS, imagePxToWorld,
} from './worldUtils';
import { look } from './look';

/**
 * The projector table under the island: the same projector as the start
 * app's agent pad, scaled up to hold a whole island.
 *
 * - The sea: a faint hex lattice continuing the island's grid out over the
 *   water, fading to nothing by SEA_FADE_END, crossed by slow sonar pulses
 *   that brighten the lattice lines they pass.
 * - The projector rings: one bright thin ring just outside the island, a
 *   fainter ring beyond it, an outer ring of dashed arcs, 5-degree ticks and
 *   four arrowheads. The whole projector turns once every few minutes.
 * - Sparse motes drifting in the air above the table.
 *
 * There is no solid surface: the sea is black (the background) and only its
 * lines are drawn. A depth-only floor just under sea level hides anything
 * that reaches below the water line.
 */

// ---------------------------------------------------------------------------
// Sea: hex lattice + sonar
// ---------------------------------------------------------------------------

const SEA_RADIUS = 16.5;
const SEA_FADE_START = 4;
const SEA_FADE_END = 16;
const SEA_Y = 0;
const SEA_TIME_WRAP = 600; // seconds; a multiple of the 5 s sonar period

// Hex (0, 0) in world space and the distance between neighbouring cell
// centres: the lattice uses the island grid's own layout (pointy-top cells,
// see hexUtils.axialToPixel), so the land grid continues out to sea.
const LATTICE_ORIGIN = imagePxToWorld(GRID_OFFSET_X, GRID_OFFSET_Y);
const LATTICE_CELL = HEX_WORLD_RADIUS * Math.sqrt(3);

const SEA_VERTEX = /* glsl */ `
varying vec2 vSeaXZ;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vSeaXZ = worldPos.xz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const SEA_FRAGMENT = /* glsl */ `
uniform vec3 uDeep;
uniform vec3 uGreen;
uniform vec2 uOrigin;
uniform float uCell;
uniform float uLattice;
uniform float uSonar;
uniform float uTime;
uniform float uFadeStart;
uniform float uFadeEnd;

varying vec2 vSeaXZ;

const float SONAR_SPEED = 1.2;   // world units per second
const float SONAR_SPACING = 6.0; // world units between pulses (one every 5 s)

void main() {
  // Lattice coordinates in cell units: neighbouring cells are one unit apart
  // along x, rows are offset by (0.5, sqrt(3)/2). The nearer of the two
  // rectangular sub-lattices gives the offset from the cell centre.
  vec2 p = (vSeaXZ - uOrigin) / uCell;
  vec2 rep = vec2(1.0, 1.7320508);
  vec2 halfRep = rep * 0.5;
  vec2 a = mod(p, rep) - halfRep;
  vec2 b = mod(p - halfRep, rep) - halfRep;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;

  // hexagonal distance: 0 at the centre, 0.5 on the cell's edge
  vec2 ag = abs(g);
  float edge = max(dot(ag, vec2(0.5, 0.8660254)), ag.x);
  float aa = max(fwidth(edge), 0.0001);
  float line = 1.0 - smoothstep(0.6 * aa, 1.6 * aa, 0.5 - edge);
  // drop the lines where a cell shrinks to a few pixels, before they shimmer
  float cellPixels = 1.0 / max(length(fwidth(p)), 0.0001);
  line *= smoothstep(5.0, 12.0, cellPixels);

  float r = length(vSeaXZ);
  float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, r);

  // sonar: signed distance to the nearest pulse front travelling outwards
  float dr = (fract((r - uTime * SONAR_SPEED) / SONAR_SPACING + 0.5) - 0.5) * SONAR_SPACING;
  float wake = exp(-(dr * dr) / 0.36) * uSonar;
  float front = exp(-(dr * dr) / 0.0025) * uSonar;

  vec3 latticeColor = mix(uDeep, uGreen, 0.5 * clamp(wake, 0.0, 1.0));
  vec3 color = latticeColor * line * uLattice * (1.0 + 4.0 * wake);
  color += uGreen * front * 0.1;

  gl_FragColor = vec4(color * fade, 1.0);
  #include <colorspace_fragment>
}
`;

function Sea({ reducedMotion }) {
  const clock = useRef(0);

  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      uDeep: { value: new THREE.Color(COLORS.deep) },
      uGreen: { value: new THREE.Color(COLORS.green) },
      uOrigin: { value: new THREE.Vector2(LATTICE_ORIGIN.x, LATTICE_ORIGIN.z) },
      uCell: { value: LATTICE_CELL },
      uLattice: { value: look.seaLattice },
      uSonar: { value: reducedMotion ? 0 : look.sonar },
      uTime: { value: 0 },
      uFadeStart: { value: SEA_FADE_START },
      uFadeEnd: { value: SEA_FADE_END },
    },
    vertexShader: SEA_VERTEX,
    fragmentShader: SEA_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }), [reducedMotion]);

  useFrame((_, delta) => {
    const u = material.uniforms;
    u.uLattice.value = look.seaLattice;
    // the pulses are motion: off under reduced motion, lattice stays
    u.uSonar.value = reducedMotion ? 0 : look.sonar;
    if (!reducedMotion) {
      clock.current = (clock.current + Math.min(delta, 0.1)) % SEA_TIME_WRAP;
      u.uTime.value = clock.current;
    }
  });

  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position-y={SEA_Y}
      material={material}
      raycast={() => null}
    >
      <circleGeometry args={[SEA_RADIUS, 96]} />
    </mesh>
  );
}

/** Writes depth just under sea level and no colour: hides whatever reaches
    below the water line (e.g. the sunk lower part of coastal grid cells). */
function SeaFloor() {
  return (
    <mesh rotation-x={-Math.PI / 2} position-y={-0.02} renderOrder={-1} raycast={() => null}>
      <circleGeometry args={[40, 48]} />
      <meshBasicMaterial colorWrite={false} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Projector rings
// ---------------------------------------------------------------------------

// The island's terrain plane spans WORLD_WIDTH x WORLD_DEPTH (15.36 x 10.24),
// so its corners sit 9.23 from the centre; the bright ring clears them.
const RING_R = 9.5;
const RING_W = 0.04;
const OUTER_R = 10.15;
const OUTER_W = 0.014;
const DASH_R = 11.3;
const DASH_W = 0.03;
const DASH_SLOTS = 72;
const RING_Y = 0.01;
const TURN_SECONDS = 360; // one turn of the projector
const DASH_TURN_SECONDS = 240; // the dashed ring turns the other way

/** Flat ring in the XZ plane between radius r and r + w. */
function flatRing(r, w, segments, thetaStart = 0, thetaLength = Math.PI * 2) {
  const geo = new THREE.RingGeometry(r, r + w, segments, 1, thetaStart, thetaLength);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** Dashed arcs: two dashes of every three slots, each 70% of its slot. */
function dashedRing() {
  const parts = [];
  const slot = (Math.PI * 2) / DASH_SLOTS;
  for (let i = 0; i < DASH_SLOTS; i++) {
    if (i % 3 === 2) continue;
    parts.push(flatRing(DASH_R, DASH_W, 4, i * slot, slot * 0.7));
  }
  return mergeGeometries(parts);
}

/** Tick marks every 5 degrees, longer every 30, none at the cardinal points
    (the arrowheads stand there). */
function tickGeometry() {
  const pts = [];
  const r0 = RING_R + RING_W + 0.03;
  for (let deg = 0; deg < 360; deg += 5) {
    if (deg % 90 === 0) continue;
    const a = THREE.MathUtils.degToRad(deg);
    const r1 = r0 + (deg % 30 === 0 ? 0.36 : 0.13);
    const c = Math.cos(a);
    const s = Math.sin(a);
    pts.push(c * r0, 0, s * r0, c * r1, 0, s * r1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

/** Four small arrowhead outlines at the cardinal points, pointing inward. */
function arrowGeometry() {
  const pts = [];
  const apexR = RING_R + RING_W + 0.08;
  const baseR = apexR + 0.3;
  const half = 0.15;
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const apex = [c * apexR, 0, s * apexR];
    const left = [c * baseR - s * half, 0, s * baseR + c * half];
    const right = [c * baseR + s * half, 0, s * baseR - c * half];
    pts.push(...apex, ...left, ...left, ...right, ...right, ...apex);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

function glowMaterial(color, opacity, line = false) {
  const params = {
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  };
  if (line) return new THREE.LineBasicMaterial(params);
  return new THREE.MeshBasicMaterial({ ...params, side: THREE.DoubleSide });
}

// Base opacities, scaled every frame by look.projector
const PROJECTOR_PARTS = {
  ring: { color: COLORS.wire, opacity: 0.85 },
  outer: { color: COLORS.wire, opacity: 0.4 },
  dashes: { color: COLORS.green, opacity: 0.4 },
  ticks: { color: COLORS.green, opacity: 0.3 },
  arrows: { color: COLORS.bright, opacity: 0.7 },
};
const PART_KEYS = Object.keys(PROJECTOR_PARTS);

function ProjectorRings() {
  const groupRef = useRef();
  const dashRef = useRef();

  const parts = useMemo(() => ({
    ring: { geometry: flatRing(RING_R, RING_W, 192), material: glowMaterial(PROJECTOR_PARTS.ring.color, PROJECTOR_PARTS.ring.opacity) },
    outer: { geometry: flatRing(OUTER_R, OUTER_W, 192), material: glowMaterial(PROJECTOR_PARTS.outer.color, PROJECTOR_PARTS.outer.opacity) },
    dashes: { geometry: dashedRing(), material: glowMaterial(PROJECTOR_PARTS.dashes.color, PROJECTOR_PARTS.dashes.opacity) },
    ticks: { geometry: tickGeometry(), material: glowMaterial(PROJECTOR_PARTS.ticks.color, PROJECTOR_PARTS.ticks.opacity, true) },
    arrows: { geometry: arrowGeometry(), material: glowMaterial(PROJECTOR_PARTS.arrows.color, PROJECTOR_PARTS.arrows.opacity, true) },
  }), []);

  // Turns even under reduced motion: one revolution takes minutes
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    if (groupRef.current) groupRef.current.rotation.y += (dt * Math.PI * 2) / TURN_SECONDS;
    if (dashRef.current) {
      dashRef.current.rotation.y -= (dt * Math.PI * 2) * (1 / DASH_TURN_SECONDS + 1 / TURN_SECONDS);
    }
    const gain = look.projector;
    for (let i = 0; i < PART_KEYS.length; i++) {
      const key = PART_KEYS[i];
      parts[key].material.opacity = PROJECTOR_PARTS[key].opacity * gain;
    }
  });

  return (
    <group ref={groupRef} position-y={RING_Y}>
      <mesh geometry={parts.ring.geometry} material={parts.ring.material} raycast={() => null} />
      <mesh geometry={parts.outer.geometry} material={parts.outer.material} raycast={() => null} />
      <mesh ref={dashRef} geometry={parts.dashes.geometry} material={parts.dashes.material} raycast={() => null} />
      <lineSegments geometry={parts.ticks.geometry} material={parts.ticks.material} raycast={() => null} />
      <lineSegments geometry={parts.arrows.geometry} material={parts.arrows.material} raycast={() => null} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Motes
// ---------------------------------------------------------------------------

const MOTE_COUNT = 140;
const MOTE_RADIUS = 13;
const MOTE_MIN_Y = 0.35;
const MOTE_MAX_Y = 4.5;
const MOTE_SIZE = 0.045; // world units, attenuated with distance like the start app's
const MOTE_SPIN = 0.012; // rad/s, the start app's drift

/** Deterministic 0..1 sequence so the motes sit in the same places on every load. */
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Small soft round dot, so a mote close to the camera is not a square. */
function makeDotTexture() {
  const N = 32;
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x + 0.5 - N / 2, y + 0.5 - N / 2) / (N / 2);
      const v = Math.round(255 * Math.max(0, 1 - d) ** 2);
      const i = (y * N + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = v;
    }
  }
  const tex = new THREE.DataTexture(data, N, N);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function Motes({ reducedMotion }) {
  const pointsRef = useRef();

  const { geometry, material } = useMemo(() => {
    const rand = seededRandom(20261113);
    const pos = new Float32Array(MOTE_COUNT * 3);
    for (let i = 0; i < MOTE_COUNT; i++) {
      const r = MOTE_RADIUS * Math.sqrt(rand());
      const a = rand() * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = MOTE_MIN_Y + rand() * (MOTE_MAX_Y - MOTE_MIN_Y);
      pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: COLORS.wire,
      size: MOTE_SIZE,
      sizeAttenuation: true,
      map: makeDotTexture(),
      transparent: true,
      opacity: look.motes,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    return { geometry: geo, material: mat };
  }, []);

  useFrame(({ clock }) => {
    material.opacity = look.motes;
    if (!reducedMotion && pointsRef.current) {
      pointsRef.current.rotation.y = clock.elapsedTime * MOTE_SPIN;
    }
  });

  return (
    <points ref={pointsRef} geometry={geometry} material={material} raycast={() => null} />
  );
}

export default function TableStage({ reducedMotion }) {
  return (
    <group>
      <SeaFloor />
      <Sea reducedMotion={reducedMotion} />
      <ProjectorRings />
      <Motes reducedMotion={reducedMotion} />
    </group>
  );
}

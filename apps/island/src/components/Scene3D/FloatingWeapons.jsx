import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { axialToWorld, COLORS } from './worldUtils';
import { getActiveMapId } from '../../data/maps';
import { BOOT, bootRamp } from './bootFx';
import { holoFillMaterial, holoWireMaterial, holoRamp } from './holo';

// Global miniaturization knob — relics are set dressing, not centerpieces
const RELIC_SCALE = 0.4;

// Float height of a weapon's pivot above the terrain surface
const FLOAT_ALTITUDE = 0.34;
const BOB_AMPLITUDE = 0.025;
const BOB_SPEED = 0.9;

// House hologram recipe: a weak emissive fill (small subjects, mostly black
// land) under a bright wire
const FILL_INTENSITY = 0.12;
const WIRE_OPACITY = 0.8;

// mergeGeometries needs uniform indexing; normalize every part first
// (same convention as TerrainProps)
function mergeParts(parts) {
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
}

function box(w, h, d, tx = 0, ty = 0, tz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(tx, ty, tz);
  return g;
}

function cyl(rTop, rBot, h, seg, tx = 0, ty = 0, tz = 0) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  g.translate(tx, ty, tz);
  return g;
}

/** Flat silhouette (blades, axe heads, shields) extruded to a thin slab. */
function slab(points, depth, tx = 0, ty = 0, tz = 0) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 4 });
  g.translate(tx, ty, tz - depth / 2);
  return g;
}

// --- Weapon geometry vocabulary: Y-up, pivot at the visual center ---

function buildSword() {
  const pommel = new THREE.OctahedronGeometry(0.035);
  pommel.translate(0, -0.44, 0);
  return mergeParts([
    pommel,
    cyl(0.02, 0.024, 0.13, 6, 0, -0.365, 0),
    box(0.2, 0.035, 0.05, 0, -0.29, 0),
    slab([[-0.045, -0.27], [-0.03, 0.36], [0, 0.47], [0.03, 0.36], [0.045, -0.27]], 0.024),
  ]);
}

function buildTrident() {
  const pommel = new THREE.OctahedronGeometry(0.03);
  pommel.translate(0, -0.51, 0);
  const parts = [
    pommel,
    cyl(0.016, 0.02, 0.85, 6, 0, -0.07, 0),
    box(0.22, 0.03, 0.03, 0, 0.33, 0),
    cyl(0.012, 0.012, 0.14, 5, 0, 0.42, 0),
    cyl(0, 0.028, 0.12, 4, 0, 0.55, 0),
  ];
  for (const sx of [-0.095, 0.095]) {
    parts.push(cyl(0.011, 0.011, 0.11, 5, sx, 0.4, 0));
    parts.push(cyl(0, 0.024, 0.1, 4, sx, 0.5, 0));
  }
  const geo = mergeParts(parts);
  geo.translate(0, -0.04, 0);
  return geo;
}

function buildAxe() {
  const spike = new THREE.CylinderGeometry(0, 0.03, 0.1, 4);
  spike.rotateZ(Math.PI / 2);
  spike.translate(-0.06, 0.28, 0);
  return mergeParts([
    cyl(0.018, 0.022, 0.9, 6),
    slab(
      [[0, 0.14], [0.09, 0.17], [0.19, 0.12], [0.235, 0], [0.19, -0.12], [0.09, -0.17], [0, -0.14]],
      0.03, 0.02, 0.28,
    ),
    spike,
  ]);
}

function buildScythe() {
  return mergeParts([
    cyl(0.018, 0.022, 0.95, 6),
    cyl(0.026, 0.026, 0.05, 6, 0, 0.44, 0),
    slab(
      [
        [0, 0], [0.14, -0.02], [0.26, -0.1], [0.33, -0.22],
        [0.29, -0.2], [0.22, -0.11], [0.12, -0.055], [0, -0.045],
      ],
      0.022, 0, 0.46,
    ),
  ]);
}

function buildHammer() {
  const pommel = new THREE.OctahedronGeometry(0.03);
  pommel.translate(0, -0.46, 0);
  return mergeParts([
    pommel,
    cyl(0.02, 0.024, 0.75, 6, 0, -0.05, 0),
    box(0.3, 0.15, 0.15, 0, 0.36, 0),
    box(0.04, 0.18, 0.18, -0.17, 0.36, 0),
    box(0.04, 0.18, 0.18, 0.17, 0.36, 0),
    cyl(0, 0.035, 0.09, 4, 0, 0.48, 0),
  ]);
}

function buildStaff() {
  const gem = new THREE.OctahedronGeometry(0.055);
  gem.scale(1, 1.4, 1);
  gem.translate(0, 0.52, 0);
  const ring = new THREE.TorusGeometry(0.085, 0.008, 4, 12);
  ring.translate(0, 0.52, 0);
  return mergeParts([
    gem,
    ring,
    cyl(0.014, 0.018, 0.95, 6, 0, -0.03, 0),
    cyl(0.022, 0.022, 0.04, 6, 0, 0.43, 0),
  ]);
}

function buildShield() {
  const boss = new THREE.IcosahedronGeometry(0.055, 0);
  boss.scale(1, 1, 0.5);
  boss.translate(0, 0, 0.03);
  return mergeParts([
    slab(
      [[-0.19, 0.22], [0.19, 0.22], [0.21, 0.1], [0.13, -0.14], [0, -0.3], [-0.13, -0.14], [-0.21, 0.1]],
      0.035,
    ),
    boss,
  ]);
}

function buildBow() {
  // Limbs: partial torus centered on +X, so the string is a vertical chord
  // at x≈0.12 and the belly/grip sits at x=0.34 — the arrow nocks on the
  // string and flies +X, tip clearing the belly.
  const arc = new THREE.TorusGeometry(0.34, 0.016, 4, 24, 2.4);
  arc.rotateZ(-1.2);
  const chordX = Math.cos(1.2) * 0.34;
  const chordHalf = Math.sin(1.2) * 0.34;
  const arrowShaft = new THREE.CylinderGeometry(0.006, 0.006, 0.5, 4);
  arrowShaft.rotateZ(Math.PI / 2);
  arrowShaft.translate(0.37, 0, 0); // nock at the string, shaft out past the grip
  const arrowHead = new THREE.CylinderGeometry(0, 0.02, 0.06, 4);
  arrowHead.rotateZ(-Math.PI / 2); // apex toward +X — the direction of flight
  arrowHead.translate(0.65, 0, 0);
  const geo = mergeParts([
    arc,
    box(0.007, chordHalf * 2, 0.007, chordX, 0, 0),
    cyl(0.024, 0.024, 0.1, 6, 0.34, 0, 0),
    arrowShaft,
    arrowHead,
  ]);
  geo.translate(-0.39, 0, 0); // recenter the silhouette on the spin pivot
  return geo;
}

// Relic armory — visual definitions. `bright` moves the wire along the
// house ramp (green toward bright green), `tilt` is a fixed lean so
// silhouettes stay readable while they spin.
const WEAPONS = [
  { key: 'sword', build: buildSword, scale: 1.35, intensity: 0.95, bright: 0.3, tilt: 0.16, spin: 0.4 },
  { key: 'trident', build: buildTrident, scale: 1.3, intensity: 0.9, bright: 0.45, tilt: 0.12, spin: 0.34 },
  { key: 'axe', build: buildAxe, scale: 1.3, intensity: 0.9, bright: 0.12, tilt: 0.2, spin: 0.45 },
  { key: 'scythe', build: buildScythe, scale: 1.3, intensity: 0.9, bright: 0.25, tilt: 0.18, spin: 0.3 },
  { key: 'hammer', build: buildHammer, scale: 1.35, intensity: 0.9, bright: 0.1, tilt: 0.14, spin: 0.38 },
  { key: 'staff', build: buildStaff, scale: 1.3, intensity: 1.0, bright: 0.5, tilt: 0.1, spin: 0.28 },
  { key: 'shield', build: buildShield, scale: 1.4, intensity: 0.95, bright: 0.2, tilt: 0.08, spin: 0.32 },
  { key: 'bow', build: buildBow, scale: 1.3, intensity: 0.9, bright: 0.18, tilt: 0.22, spin: 0.42 },
];

// Per-map hex placements. Island: ringed around the caldera. B4LK4N:
// landmark spots — sword on the Dinaric peak, trident over Crete, shield
// in the Southern Carpathians, staff at Olympus, scythe on the Wallachian
// plain, axe up in Istria, hammer at the Iron Gates, bow in the interior.
const PLACEMENTS = {
  island: {
    sword: [2, 4], trident: [11, 8], axe: [9, 3], scythe: [9, 9],
    hammer: [1, 8], staff: [4, 10], shield: [3, 2], bow: [11, 5],
  },
  balkan: {
    sword: [4, 4], trident: [4, 13], axe: [2, 2], scythe: [11, 3],
    hammer: [8, 3], staff: [4, 8], shield: [10, 2], bow: [6, 6],
  },
};

function Weapon({ def, hex, index, reducedMotion }) {
  const spinRef = useRef();
  const geometry = useMemo(def.build, [def]);
  const world = useMemo(() => axialToWorld(hex[0], hex[1]), [hex]);
  const wireColor = useMemo(() => holoRamp(def.bright, def.intensity), [def]);
  const fillMaterial = useMemo(
    () => holoFillMaterial(COLORS.fill, { intensity: FILL_INTENSITY }),
    [],
  );
  const wireMaterial = useMemo(() => holoWireMaterial(wireColor, WIRE_OPACITY), [wireColor]);

  const baseY = world.y + FLOAT_ALTITUDE;
  const phase = index * 1.7;

  useFrame(({ clock }) => {
    const g = spinRef.current;
    if (!g) return;
    const t = clock.elapsedTime;
    const boot = bootRamp(t, [BOOT.relics[0] + index * 0.08, BOOT.relics[1]], reducedMotion);
    g.scale.setScalar(Math.max(boot, 0.0001));
    if (reducedMotion) return;
    g.position.y = baseY + Math.sin(t * BOB_SPEED + phase) * BOB_AMPLITUDE;
    g.rotation.y = t * def.spin + phase;
  });

  return (
    <group>
      <group ref={spinRef} position={[world.x, baseY, world.z]} rotation-y={phase}>
        <group rotation-z={def.tilt} scale={def.scale * RELIC_SCALE}>
          {/* Fill pass — dark emissive body so the wires read as volume edges */}
          <mesh geometry={geometry} material={fillMaterial} raycast={() => null} />
          {/* Wire pass is the hologram itself — always on, independent of
              the terrain wireframe toggle */}
          <mesh geometry={geometry} material={wireMaterial} raycast={() => null} />
        </group>
      </group>

      {/* Faint projection ring on the terrain under the relic */}
      <mesh
        rotation-x={-Math.PI / 2}
        position={[world.x, world.y + 0.02, world.z]}
        raycast={() => null}
      >
        <ringGeometry args={[0.07, 0.095, 24]} />
        <meshBasicMaterial
          color={wireColor}
          transparent
          opacity={0.12}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

/**
 * Floating holographic weapon relics — purely cosmetic showpieces hovering
 * over scattered hexes. No raycasting, no game state.
 */
export default function FloatingWeapons({ reducedMotion }) {
  const placements = PLACEMENTS[getActiveMapId()] ?? {};
  return (
    <group>
      {WEAPONS.filter((def) => placements[def.key]).map((def, i) => (
        <Weapon
          key={def.key}
          def={def}
          hex={placements[def.key]}
          index={i}
          reducedMotion={reducedMotion}
        />
      ))}
    </group>
  );
}

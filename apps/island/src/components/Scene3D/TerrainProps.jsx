import { useMemo, useRef, useLayoutEffect } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { PROP_STRIDE } from '../../data/propMap';
import { getActiveMap } from '../../data/maps';
import { TERRAIN_HEIGHT_SCALE, COLORS, canUseBloom } from './worldUtils';
import { look } from './look';

// Degradation flags (applied automatically on low-end hardware via the same
// capability gate as bloom): halve tree density, drop the flicker effect.
const LOW_END = !canUseBloom();
const FLICKER_ENABLED = !LOW_END;

// Flicker tuning — barely-noticeable projector packet loss
const FLICKER_MIN_INTERVAL = 2;
const FLICKER_MAX_INTERVAL = 5;
const FLICKER_DURATION = 0.09; // seconds (~a frame or two)
const FLICKER_MAX_CONCURRENT = 3;

const _dummy = new THREE.Object3D();
const _color = new THREE.Color();
const GREEN = new THREE.Color(COLORS.green);
const BRIGHT = new THREE.Color(COLORS.bright);
const AMBER = new THREE.Color(COLORS.amber);
const SOLID_FILL = '#010904';

// World-space thickness of the outline drawn around every prop (about one
// pixel at the home framing)
const EDGE_WORLD = 0.013;

/** Deterministic per-instance hash for tilts / non-uniform scale. */
function hash01(i) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// --- Organic geometry vocabulary: unit height, base at y=0 ---
// AoE-style silhouettes (clumpy canopies, boulder piles) reinterpreted as
// holograms: dark fill + green wire over noise-displaced low-poly blobs.

// mergeGeometries needs uniform indexing; polyhedra are non-indexed, so
// normalize every part to non-indexed before merging
function mergeParts(parts) {
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
}

/**
 * Deterministic per-vertex noise displacement. Hashing the vertex position
 * keeps duplicated (non-indexed) vertices coherent so shells stay watertight
 * while the silhouette turns irregular/organic.
 */
function roughen(geo, amount) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const h = (k) => {
      const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + k * 53.3) * 43758.5453;
      return (s - Math.floor(s)) - 0.5;
    };
    pos.setXYZ(i, x + h(1) * 2 * amount, y + h(2) * 2 * amount, z + h(3) * 2 * amount);
  }
  return geo;
}

function canopyBlob(radius, sx, sy, sz, tx, ty, tz, roughness) {
  const blob = new THREE.IcosahedronGeometry(radius, 1);
  roughen(blob, radius * roughness);
  blob.scale(sx, sy, sz);
  blob.translate(tx, ty, tz);
  return blob;
}

// Broadleaf: clump of three overlapping rough blobs, like an AoE oak
function buildTreeA() {
  const trunk = new THREE.CylinderGeometry(0.035, 0.05, 0.32, 5);
  trunk.translate(0, 0.16, 0);
  return mergeParts([
    trunk,
    canopyBlob(0.30, 1.05, 0.85, 1.0, 0, 0.62, 0, 0.18),
    canopyBlob(0.21, 1.0, 0.8, 1.0, 0.19, 0.48, 0.09, 0.22),
    canopyBlob(0.19, 1.0, 0.85, 1.0, -0.17, 0.54, -0.08, 0.22),
  ]);
}

// Bushy round tree: single fat rough blob, smaller
function buildTreeB() {
  const trunk = new THREE.CylinderGeometry(0.03, 0.045, 0.26, 5);
  trunk.translate(0, 0.13, 0);
  return mergeParts([
    trunk,
    canopyBlob(0.32, 1.0, 0.82, 1.0, 0, 0.52, 0, 0.24),
  ]);
}

/** One rounded weathered boulder, gently roughened so it stays round. */
function boulder(radius, sx, sy, sz, tx, ty, tz) {
  const b = new THREE.IcosahedronGeometry(radius, 1);
  roughen(b, radius * 0.13);
  b.scale(sx, sy, sz);
  b.translate(tx, ty, tz);
  return b;
}

// AoE-style boulder pile: one large stone with a huddle of smaller ones
// tucked around its base
function buildRock() {
  return mergeParts([
    boulder(0.34, 1.1, 0.78, 1.0, 0, 0.22, 0),
    boulder(0.22, 1.0, 0.75, 1.05, 0.3, 0.13, 0.1),
    boulder(0.18, 1.05, 0.7, 1.0, -0.28, 0.11, 0.14),
    boulder(0.15, 1.0, 0.72, 1.0, 0.05, 0.09, -0.3),
    boulder(0.13, 1.0, 0.68, 1.0, -0.16, 0.08, -0.24),
  ]);
}

// Highland spire: elongated rough shard, jagged but grounded
function buildCrag() {
  const geo = new THREE.IcosahedronGeometry(0.5, 0);
  roughen(geo, 0.12);
  geo.scale(0.42, 1.3, 0.42);
  geo.translate(0, 0.5, 0);
  return geo;
}

// --- Ancient structures: weathered low-poly stonework ---

function box(w, h, d, tx, ty, tz) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(tx, ty, tz);
  return g;
}

function column(rTop, rBot, height, tx, ty, tz, lean = 0) {
  const shaft = new THREE.CylinderGeometry(rTop, rBot, height, 8);
  if (lean) shaft.rotateZ(lean);
  shaft.translate(tx, ty + height / 2, tz);
  return shaft;
}

// Lone Greek column: plinth + fluted shaft + capital. Unit height ~0.88.
function buildPillar() {
  const geo = mergeParts([
    box(0.22, 0.07, 0.22, 0, 0.035, 0),
    column(0.055, 0.07, 0.7, 0, 0.07, 0),
    box(0.2, 0.06, 0.2, 0, 0.81, 0),
  ]);
  roughen(geo, 0.012);
  return geo;
}

// Ruined temple: stepped platform, a colonnade with broken stumps, one
// surviving lintel and a fallen column across the floor
function buildRuin() {
  const parts = [
    box(1.0, 0.07, 0.72, 0, 0.035, 0),
    box(0.86, 0.06, 0.58, 0, 0.1, 0),
  ];
  // colonnade: standing columns front-left, broken stumps elsewhere
  const spots = [
    [-0.34, -0.2, 0.34], [-0.34, 0.2, 0.34],
    [-0.11, -0.2, 0.13], [-0.11, 0.2, 0.34],
    [0.12, -0.2, 0.34], [0.12, 0.2, 0.1],
    [0.35, -0.2, 0.17], [0.35, 0.2, 0.28],
  ];
  for (const [cx, cz, h] of spots) {
    parts.push(column(0.035, 0.045, h, cx, 0.13, cz, 0));
  }
  // lintel surviving over the left pair
  parts.push(box(0.36, 0.05, 0.1, -0.225, 0.13 + 0.34 + 0.025, -0.2));
  parts.push(box(0.36, 0.05, 0.1, -0.225, 0.13 + 0.34 + 0.025, 0.2));
  // fallen column lying across the platform
  const fallen = new THREE.CylinderGeometry(0.04, 0.045, 0.42, 7);
  fallen.rotateZ(Math.PI / 2);
  fallen.rotateY(0.4);
  fallen.translate(0.16, 0.17, -0.02);
  parts.push(fallen);
  const geo = mergeParts(parts);
  roughen(geo, 0.01);
  return geo;
}

// Collapsed aqueduct: arcade of piers under a broken channel; one end has
// lost its span, a fragment lies on the ground beside it. Length 1, h ~0.38.
function buildAqueduct() {
  const parts = [];
  const pierXs = [-0.45, -0.225, 0, 0.225, 0.45];
  for (let i = 0; i < pierXs.length; i++) {
    const broken = i === pierXs.length - 1;
    parts.push(box(0.08, broken ? 0.13 : 0.3, 0.11, pierXs[i], (broken ? 0.13 : 0.3) / 2, 0));
  }
  // surviving channel over the first four piers
  parts.push(box(0.73, 0.07, 0.13, -0.115, 0.3 + 0.035, 0));
  // small arch shoulders between piers (suggested arches)
  for (const x of [-0.34, -0.11, 0.11]) {
    parts.push(box(0.1, 0.07, 0.1, x, 0.26, 0));
  }
  // fallen span fragment by the collapsed end
  const frag = new THREE.BoxGeometry(0.2, 0.06, 0.11);
  frag.rotateY(0.5);
  frag.translate(0.42, 0.04, 0.16);
  parts.push(frag);
  const geo = mergeParts(parts);
  roughen(geo, 0.012);
  return geo;
}

// Visual hierarchy: terrain contours > hex outlines > props, so prop
// lines stay dimmer than the grid. Fills are near black, so a prop reads as
// a dark shape with a thin dim outline and forests never add up to a green
// texture. Structures are rigid (uniform scale, no tilt) and drift toward
// the bright end of the green ramp: ancient monuments on the tactical table.
const TYPES = [
  { key: 'treeA', build: buildTreeA, intensity: 0.45, tilt: 0.07, solidColor: '#020f08', halveOnLowEnd: true },
  { key: 'treeB', build: buildTreeB, intensity: 0.50, tilt: 0.07, solidColor: '#020f08', halveOnLowEnd: true },
  { key: 'rock', build: buildRock, intensity: 0.26, tilt: 0.12, solidColor: '#020b06', halveOnLowEnd: false },
  { key: 'crag', build: buildCrag, intensity: 0.45, tilt: 0.3, solidColor: '#010904', halveOnLowEnd: false },
  { key: 'pillar', build: buildPillar, intensity: 0.62, tilt: 0.06, solidColor: '#020e09', rigid: true, breakable: true, bright: 0.3 },
  { key: 'ruin', build: buildRuin, intensity: 0.62, tilt: 0, solidColor: '#020e09', rigid: true, bright: 0.3 },
  { key: 'aqueduct', build: buildAqueduct, intensity: 0.62, tilt: 0, solidColor: '#020e09', rigid: true, bright: 0.3 },
];

function wireColorFor(jitter, type, out) {
  if (jitter > 1.5) {
    // crater spikes — the only amber in the prop layer
    return out.copy(AMBER).multiplyScalar(0.5 + 0.1 * (jitter - 2));
  }
  out.copy(GREEN).lerp(BRIGHT, type.bright ?? 0.12 * Math.abs(jitter));
  return out.multiplyScalar(type.intensity * (1 + 0.1 * jitter));
}

/**
 * The prop's shell pushed out along smoothed normals. Drawn with back faces
 * only, it hides behind the dark fill everywhere except a thin band at the
 * silhouette: an outline that stays one line however dense the mesh is.
 */
function makeEdgeShell(geometry, inflate) {
  const g = geometry.clone();
  // weld by position alone, so the normals average across the flat faces
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const shell = mergeVertices(g, 1e-4);
  g.dispose();
  shell.computeVertexNormals();
  const pos = shell.attributes.position;
  const nor = shell.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) + nor.getX(i) * inflate,
      pos.getY(i) + nor.getY(i) * inflate,
      pos.getZ(i) + nor.getZ(i) * inflate,
    );
  }
  shell.computeBoundingSphere();
  return shell;
}

function PropType({
  type, edgeMaterial, registerWire, unregisterWire, wireframe,
}) {
  const solidRef = useRef();
  const edgeRef = useRef();
  const wireRef = useRef();

  const geometry = useMemo(type.build, []);

  // Indices actually rendered (low-end hardware halves the forests)
  const indices = useMemo(() => {
    const data = getActiveMap().props[type.key] ?? [];
    const n = data.length / PROP_STRIDE;
    const list = [];
    const stride = LOW_END && type.halveOnLowEnd ? 2 : 1;
    for (let i = 0; i < n; i += stride) list.push(i);
    return list;
  }, [type]);

  // One shell per type, inflated so the outline is about EDGE_WORLD thick
  // on a prop of this type's average size
  const edgeGeometry = useMemo(() => {
    const data = getActiveMap().props[type.key] ?? [];
    let sum = 0;
    for (const i of indices) sum += data[i * PROP_STRIDE + 3];
    const meanScale = indices.length ? sum / indices.length : 0.15;
    return makeEdgeShell(geometry, EDGE_WORLD / Math.max(meanScale, 0.02));
  }, [geometry, indices, type]);

  // Static scene: matrices + colors set once on mount
  useLayoutEffect(() => {
    const solid = solidRef.current;
    const edge = edgeRef.current;
    const wire = wireRef.current;
    if (!solid || !edge) return undefined;
    const data = getActiveMap().props[type.key] ?? [];

    for (let k = 0; k < indices.length; k++) {
      const o = indices[k] * PROP_STRIDE;
      const x = data[o];
      const z = data[o + 1];
      const y = data[o + 2] * TERRAIN_HEIGHT_SCALE;
      const scale = data[o + 3];
      const rotY = data[o + 4];
      const jitter = data[o + 5];

      const h1 = hash01(indices[k] + 1);
      const h2 = hash01(indices[k] + 101);
      _dummy.position.set(x, y, z);
      _dummy.rotation.set((h1 - 0.5) * 2 * type.tilt, rotY, (h2 - 0.5) * 2 * type.tilt);
      if (type.rigid) {
        // structures keep their proportions; "breakable" ones sometimes
        // survive only as truncated stumps
        const sy = type.breakable && h1 < 0.4 ? scale * 0.45 : scale;
        _dummy.scale.set(scale, sy, scale);
      } else {
        // mild non-uniform scale for irregular silhouettes
        _dummy.scale.set(scale * (0.85 + 0.4 * h2), scale, scale * (0.85 + 0.4 * h1));
      }
      _dummy.updateMatrix();
      solid.setMatrixAt(k, _dummy.matrix);
      edge.setMatrixAt(k, _dummy.matrix);
      edge.setColorAt(k, wireColorFor(jitter, type, _color));
      if (wire) {
        wire.setMatrixAt(k, _dummy.matrix);
        wire.setColorAt(k, wireColorFor(jitter, type, _color));
      }
    }
    solid.instanceMatrix.needsUpdate = true;
    edge.instanceMatrix.needsUpdate = true;
    if (edge.instanceColor) edge.instanceColor.needsUpdate = true;
    registerWire(`${type.key}:edge`, edge, indices.length);
    if (wire) {
      wire.instanceMatrix.needsUpdate = true;
      if (wire.instanceColor) wire.instanceColor.needsUpdate = true;
      registerWire(`${type.key}:wire`, wire, indices.length);
    }
    return () => {
      unregisterWire(`${type.key}:edge`);
      unregisterWire(`${type.key}:wire`);
    };
  }, [type, indices, registerWire, unregisterWire, wireframe]);

  return (
    <group>
      {/* Solid pass — near-black fill so wireframes read as volume edges */}
      <instancedMesh
        ref={solidRef}
        args={[geometry, undefined, indices.length]}
        raycast={() => null}
      >
        <meshBasicMaterial color={type.solidColor ?? SOLID_FILL} toneMapped={false} />
      </instancedMesh>

      {/* Outline pass — always on: the thin dim edge that makes a dark
          prop readable on the dark land */}
      <instancedMesh
        ref={edgeRef}
        args={[edgeGeometry, edgeMaterial, indices.length]}
        raycast={() => null}
      />

      {/* Emissive wireframe pass */}
      {wireframe && (
        <instancedMesh
          ref={wireRef}
          args={[geometry, undefined, indices.length]}
          raycast={() => null}
        >
          <meshBasicMaterial
            wireframe
            transparent
            opacity={0.7}
            depthWrite={false}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
            toneMapped={false}
          />
        </instancedMesh>
      )}
    </group>
  );
}

/** Faint amber emissive disc inside the caldera spike ring. */
function CraterDisc({ crater }) {
  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position={[crater.x, crater.elev * TERRAIN_HEIGHT_SCALE + 0.015, crater.z]}
      raycast={() => null}
    >
      <circleGeometry args={[crater.radius * 0.85, 24]} />
      <meshBasicMaterial
        color={COLORS.amber}
        transparent
        opacity={0.14}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}

/**
 * Procedurally placed holographic terrain props. Purely cosmetic: no
 * raycasting, no game state — placement comes baked from propMap.js.
 */
export default function TerrainProps({ reducedMotion, wireframe = true }) {
  // One outline material for every type: instance colours carry the hue,
  // the material colour is the look's gain
  const edgeMaterial = useMemo(() => new THREE.MeshBasicMaterial({
    side: THREE.BackSide,
    toneMapped: false,
  }), []);

  // Outline and wire meshes registered per type for the flicker effect
  const wireMeshes = useRef({});
  const registerWire = useMemo(() => (key, mesh, count) => {
    wireMeshes.current[key] = { mesh, count };
  }, []);
  const unregisterWire = useMemo(() => (key) => {
    delete wireMeshes.current[key];
  }, []);

  // Projection flicker — preallocated slots, zero per-frame allocation
  const flicker = useRef({
    next: 3,
    slots: Array.from({ length: FLICKER_MAX_CONCURRENT }, () => ({
      active: false, key: null, idx: 0, r: 0, g: 0, b: 0, until: 0,
    })),
  });

  useFrame(({ clock }) => {
    edgeMaterial.color.setScalar(look.propEdges);
    if (reducedMotion || !FLICKER_ENABLED) return;
    const t = clock.elapsedTime;
    const state = flicker.current;

    for (const slot of state.slots) {
      if (!slot.active || t < slot.until) continue;
      const entry = wireMeshes.current[slot.key];
      if (entry?.mesh.instanceColor) {
        const arr = entry.mesh.instanceColor.array;
        arr[slot.idx * 3] = slot.r;
        arr[slot.idx * 3 + 1] = slot.g;
        arr[slot.idx * 3 + 2] = slot.b;
        entry.mesh.instanceColor.needsUpdate = true;
      }
      slot.active = false;
    }

    if (t < state.next) return;
    state.next = t + FLICKER_MIN_INTERVAL
      + Math.random() * (FLICKER_MAX_INTERVAL - FLICKER_MIN_INTERVAL);
    const keys = Object.keys(wireMeshes.current);
    if (keys.length === 0) return;
    const burst = 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < burst; k++) {
      const slot = state.slots.find((s) => !s.active);
      if (!slot) break;
      const key = keys[Math.floor(Math.random() * keys.length)];
      const entry = wireMeshes.current[key];
      if (!entry?.mesh.instanceColor || entry.count === 0) continue;
      const idx = Math.floor(Math.random() * entry.count);
      const arr = entry.mesh.instanceColor.array;
      slot.key = key;
      slot.idx = idx;
      slot.r = arr[idx * 3];
      slot.g = arr[idx * 3 + 1];
      slot.b = arr[idx * 3 + 2];
      slot.until = t + FLICKER_DURATION;
      slot.active = true;
      arr[idx * 3] *= 0.1;
      arr[idx * 3 + 1] *= 0.1;
      arr[idx * 3 + 2] *= 0.1;
      entry.mesh.instanceColor.needsUpdate = true;
    }
  });

  return (
    <group>
      {TYPES.map((type) => (
        <PropType
          key={type.key}
          type={type}
          edgeMaterial={edgeMaterial}
          registerWire={registerWire}
          unregisterWire={unregisterWire}
          wireframe={wireframe}
        />
      ))}
      {getActiveMap().crater && <CraterDisc crater={getActiveMap().crater} />}
    </group>
  );
}

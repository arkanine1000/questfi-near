import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useLoader } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { axialToWorld, COLORS, TERRAIN_HEIGHT_SCALE } from './worldUtils';
import { getActiveMapId } from '../../data/maps';
import { BOOT, bootRamp } from './bootFx';

// Global miniaturization knob — hostiles are set dressing, not centerpieces
const ENEMY_SCALE = 0.4;

// Hostile projections stand ON the terrain (unlike the floating relics) —
// they should read as units on the war table, not trophies.
const BREATH_AMPLITUDE = 0.012;
const SWAY_AMPLITUDE = 0.1;
const SOLID_FILL = '#031c0e';

const GREEN = new THREE.Color(COLORS.green);
const CYAN = new THREE.Color(COLORS.cyan);

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _quat = new THREE.Quaternion();

// mergeGeometries needs uniform indexing; normalize every part first
// (same convention as TerrainProps / FloatingWeapons)
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

/** Limb segment between two points — the workhorse for legs/necks/tails. */
function strut(ax, ay, az, bx, by, bz, rA, rB, seg = 4) {
  _dir.set(bx - ax, by - ay, bz - az);
  const len = _dir.length();
  const g = new THREE.CylinderGeometry(rB, rA, len, seg);
  g.translate(0, len / 2, 0);
  _quat.setFromUnitVectors(_up, _dir.normalize());
  g.applyQuaternion(_quat);
  g.translate(ax, ay, az);
  return g;
}

/** Cone spike whose base sits at (tx,ty,tz), tip rotated by rx/rz. */
function spike(r, h, seg, rx, rz, tx, ty, tz) {
  const g = new THREE.CylinderGeometry(0, r, h, seg);
  g.translate(0, h / 2, 0);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  g.translate(tx, ty, tz);
  return g;
}

/** Flat silhouette extruded to a thin slab (wings, blades). */
function slab(points, depth) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 4 });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** Rough organic blob — same vertex-hash displacement as TerrainProps. */
function blob(radius, detail, amount, sx, sy, sz, tx, ty, tz) {
  const g = new THREE.IcosahedronGeometry(radius, detail);
  const pos = g.attributes.position;
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
  g.scale(sx, sy, sz);
  g.translate(tx, ty, tz);
  return g;
}

// --- Enemy geometry vocabulary: Y-up, feet at y=0, facing +Z ---

// Armored revenant: pauldroned torso over tassets, greatsword held low
function buildKnight() {
  const parts = [
    // legs
    cyl(0.022, 0.028, 0.22, 5, -0.05, 0.11, 0),
    cyl(0.022, 0.028, 0.22, 5, 0.05, 0.11, 0),
    // tasset skirt + torso (broad shoulders up top)
    cyl(0.085, 0.105, 0.1, 6, 0, 0.27, 0),
    cyl(0.095, 0.065, 0.24, 6, 0, 0.43, 0),
    // pauldrons + helm
    blob(0.04, 0, 0.006, 1, 0.75, 1, -0.115, 0.55, 0),
    blob(0.04, 0, 0.006, 1, 0.75, 1, 0.115, 0.55, 0),
    blob(0.042, 0, 0.005, 0.85, 1.1, 0.85, 0, 0.64, 0),
  ];
  // arms — right one drops to the sword grip
  const armR = cyl(0.016, 0.02, 0.2, 5);
  armR.rotateZ(-0.35);
  armR.translate(0.15, 0.43, 0);
  const armL = cyl(0.016, 0.02, 0.2, 5);
  armL.rotateZ(0.3);
  armL.translate(-0.15, 0.43, 0);
  parts.push(armR, armL);
  // greatsword, point down, tip just above the ground
  const bladeGeo = slab(
    [[-0.018, 0], [-0.012, -0.22], [0, -0.28], [0.012, -0.22], [0.018, 0]],
    0.014,
  );
  bladeGeo.translate(0.21, 0.31, 0);
  parts.push(bladeGeo, box(0.09, 0.016, 0.025, 0.21, 0.31, 0));
  return mergeParts(parts);
}

// Giant spider: fat abdomen, low thorax, eight two-segment legs
function buildSpider() {
  const parts = [
    blob(0.11, 1, 0.02, 1, 0.85, 1.25, 0, 0.16, -0.14),
    blob(0.07, 1, 0.012, 1, 0.9, 1.1, 0, 0.13, 0.04),
    spike(0.015, 0.05, 4, 2.4, 0, -0.03, 0.1, 0.11),
    spike(0.015, 0.05, 4, 2.4, 0, 0.03, 0.1, 0.11),
  ];
  const kneeSpread = [0.1, 0.03, -0.04, -0.12];
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const z = 0.08 - i * 0.06;
      const dz = kneeSpread[i];
      parts.push(strut(s * 0.06, 0.15, z, s * 0.19, 0.26, z + dz, 0.01, 0.008));
      parts.push(strut(s * 0.19, 0.26, z + dz, s * 0.3, 0, z + dz * 2, 0.008, 0.005));
    }
  }
  return mergeParts(parts);
}

const ENEMY_TYPES = {
  knight: { build: buildKnight, intensity: 0.9, cyan: 0.15 },
  spider: { build: buildSpider, intensity: 0.85, cyan: 0.05 },
};

// One geometry per type, shared across every instance
const geoCache = {};
function typeGeometry(type) {
  geoCache[type] ??= ENEMY_TYPES[type].build();
  return geoCache[type];
}

// Grounded hostile contacts per map, on hexes free of weapon relics.
// `offset` nudges instances inside their hex so groups don't overlap.
// Island: revenants in the northern fields, broodspiders in the west
// highlands. B4LK4N: revenants in the Dinarides, broodspiders in
// Transylvania (of course).
const DEPLOYMENTS = {
  island: [
    { type: 'knight', hex: [6, 3], offset: [-0.3, -0.06], rotY: 2.6, scale: 1.2 },
    { type: 'knight', hex: [6, 3], offset: [0.28, 0.18], rotY: -2.1, scale: 1.15 },
    { type: 'knight', hex: [6, 3], offset: [0.04, -0.32], rotY: 0.4, scale: 1.25 },
    { type: 'spider', hex: [2, 6], offset: [-0.12, 0.08], rotY: 1.1, scale: 1.25 },
    { type: 'spider', hex: [2, 6], offset: [0.16, -0.1], rotY: -2.4, scale: 0.95 },
    { type: 'spider', hex: [2, 6], offset: [0.02, 0.2], rotY: 3.0, scale: 0.75 },
  ],
  balkan: [
    { type: 'knight', hex: [3, 3], offset: [-0.3, -0.06], rotY: 2.6, scale: 1.2 },
    { type: 'knight', hex: [3, 3], offset: [0.28, 0.18], rotY: -2.1, scale: 1.15 },
    { type: 'knight', hex: [3, 3], offset: [0.04, -0.32], rotY: 0.4, scale: 1.25 },
    { type: 'spider', hex: [10, 1], offset: [-0.12, 0.08], rotY: 1.1, scale: 1.25 },
    { type: 'spider', hex: [10, 1], offset: [0.16, -0.1], rotY: -2.4, scale: 0.95 },
    { type: 'spider', hex: [10, 1], offset: [0.02, 0.2], rotY: 3.0, scale: 0.75 },
  ],
};

// Twilight Wyvern flight circuit — a perpetual lap around the landmass,
// high above the peaks. Never lands; the table projects it mid-cruise.
// The model is the questfi-lobby dragon (island/dragon/dragon.glb + palette,
// Flying_loop) given the same two-pass holo dressing as the lobby's den:
// palette base with a green emissive lift + a wire pass bound to the
// skeleton so it deforms with the wingbeats.
const WYVERN = {
  size: 0.75, // world units, largest bind-pose dimension after fitting
  yawOffset: 0, // set to Math.PI if a model swap ever flies tail-first
  radiusX: 4.6,
  radiusZ: 3.2,
  altitude: TERRAIN_HEIGHT_SCALE + 0.55,
  angularSpeed: 0.14,
  bobAmplitude: 0.12,
  bobSpeed: 0.5,
  bank: 0.24,
};

const WYVERN_MODEL = '/island/dragon/dragon.glb';
const WYVERN_PALETTE = '/island/dragon/palette.png';
const WYVERN_ANIM = 'Flying_loop';

/**
 * Mesh-node bounds lie for skinned models (the skeleton, not the node
 * transform, decides the rendered size), so measure the bind-pose bone
 * positions instead and scale/center from those. (Ported from
 * questfi-lobby dragons.js.)
 */
function fitSkinnedToSize(model, size) {
  model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let bones = 0;
  model.traverse((o) => {
    if (o.isBone) {
      bones += 1;
      box.expandByPoint(v.setFromMatrixPosition(o.matrixWorld).applyMatrix4(inv));
    }
  });
  if (!bones) box.setFromObject(model);
  const dims = box.getSize(new THREE.Vector3());
  const scale = size / Math.max(dims.x, dims.y, dims.z);
  model.scale.multiplyScalar(scale);
  const center = box.getCenter(new THREE.Vector3());
  model.position.x -= center.x * scale;
  model.position.z -= center.z * scale;
  model.position.y -= center.y * scale; // pivot at volume center: it flies
}

function wireMaterialProps(def) {
  return {
    wireframe: true,
    color: GREEN.clone().lerp(CYAN, def.cyan).multiplyScalar(def.intensity),
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    side: THREE.DoubleSide,
    toneMapped: false,
  };
}

/** Two-pass hologram mesh: near-black solid fill + additive-free wire pass.
    Wires are the hologram itself — always on, independent of the terrain
    wireframe toggle. */
function HoloMesh({ geometry, def }) {
  const wireProps = useMemo(() => wireMaterialProps(def), [def]);
  return (
    <>
      <mesh geometry={geometry} raycast={() => null}>
        <meshBasicMaterial color={SOLID_FILL} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <mesh geometry={geometry} raycast={() => null}>
        <meshBasicMaterial {...wireProps} />
      </mesh>
    </>
  );
}

function GroundedEnemy({ entry, index, reducedMotion }) {
  const groupRef = useRef();
  const def = ENEMY_TYPES[entry.type];
  const geometry = useMemo(() => typeGeometry(entry.type), [entry.type]);
  const world = useMemo(() => {
    const w = axialToWorld(entry.hex[0], entry.hex[1]);
    // Offsets were authored for full-size units; pull groups proportionally
    // tighter so miniatures still read as one pack
    return {
      x: w.x + entry.offset[0] * 0.6,
      y: w.y,
      z: w.z + entry.offset[1] * 0.6,
    };
  }, [entry]);
  const wireColor = useMemo(
    () => GREEN.clone().lerp(CYAN, def.cyan).multiplyScalar(def.intensity),
    [def],
  );

  const baseY = world.y + 0.01;
  const phase = index * 2.3;
  const scale = entry.scale * ENEMY_SCALE;

  useFrame(({ clock }) => {
    const g = groupRef.current;
    if (!g) return;
    const t = clock.elapsedTime;
    const boot = bootRamp(t, [BOOT.relics[0] + index * 0.1, BOOT.relics[1]], reducedMotion);
    g.scale.setScalar(scale * Math.max(boot, 0.0001));
    if (reducedMotion) return;

    // Grounded units breathe, scan, and drift on a slow patrol loop
    const driftX = entry.type === 'knight' ? Math.sin(t * 0.1 + phase) * 0.08 : 0;
    const driftZ = entry.type === 'knight' ? Math.cos(t * 0.08 + phase * 1.7) * 0.08 : 0;
    g.position.set(
      world.x + driftX,
      baseY + (Math.sin(t * 1.3 + phase) * 0.5 + 0.5) * BREATH_AMPLITUDE,
      world.z + driftZ,
    );
    g.rotation.y = entry.rotY + Math.sin(t * 0.35 + phase) * SWAY_AMPLITUDE;
  });

  return (
    <group>
      <group
        ref={groupRef}
        position={[world.x, baseY, world.z]}
        rotation-y={entry.rotY}
        scale={scale}
      >
        <HoloMesh geometry={geometry} def={def} />
      </group>

      {/* Faint projection ring where the unit touches the table */}
      <mesh
        rotation-x={-Math.PI / 2}
        position={[world.x, world.y + 0.02, world.z]}
        raycast={() => null}
      >
        <ringGeometry args={[0.11 * scale, 0.15 * scale, 20]} />
        <meshBasicMaterial
          color={wireColor}
          transparent
          opacity={0.1}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

/** The Twilight Wyvern — perpetually circling the landmass on an elliptical
    cruise, banked into the turn, nose slightly down. */
function TwilightWyvern({ reducedMotion }) {
  const groupRef = useRef();
  const { scene, animations } = useGLTF(WYVERN_MODEL);
  const palette = useLoader(THREE.TextureLoader, WYVERN_PALETTE);

  const { model, mixer, action } = useMemo(() => {
    const root = cloneSkinned(scene);
    fitSkinnedToSize(root, WYVERN.size);

    const palTex = palette.clone();
    palTex.colorSpace = THREE.SRGBColorSpace;
    palTex.flipY = false; // glTF UV convention
    palTex.needsUpdate = true;

    const baseMat = new THREE.MeshStandardMaterial({
      map: palTex,
      emissive: new THREE.Color(0x1fd465),
      emissiveIntensity: 0.25,
      roughness: 0.45,
      metalness: 0.1,
      side: THREE.DoubleSide, // wing membranes are single-sided surfaces
    });
    const wireMat = new THREE.MeshBasicMaterial({
      color: GREEN.clone().lerp(CYAN, 0.55),
      wireframe: true,
      transparent: true,
      opacity: 0.35,
      toneMapped: false,
    });

    // Collect first, then dress — adding wire children mid-traverse would
    // make traverse() visit them too
    const meshes = [];
    root.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) meshes.push(o);
    });
    for (const o of meshes) {
      o.frustumCulled = false; // skinned bounds don't track the animation
      o.material = baseMat;
      o.raycast = () => null;
      let wire;
      if (o.isSkinnedMesh) {
        wire = new THREE.SkinnedMesh(o.geometry, wireMat);
        wire.bind(o.skeleton, o.bindMatrix);
        wire.frustumCulled = false;
      } else {
        wire = new THREE.Mesh(o.geometry, wireMat);
      }
      wire.raycast = () => null;
      o.add(wire);
    }

    const anim = new THREE.AnimationMixer(root);
    const clip = THREE.AnimationClip.findByName(animations, WYVERN_ANIM) ?? animations[0];
    return { model: root, mixer: anim, action: clip ? anim.clipAction(clip) : null };
  }, [scene, animations, palette]);

  // Start the wingbeat from the effect, not the memo: StrictMode's
  // mount -> cleanup -> remount cycle calls stopAllAction(), and a play()
  // buried in useMemo never reruns — which left the wyvern gliding frozen
  // in dev. reset().play() survives any number of remounts.
  useEffect(() => {
    if (!action) return undefined;
    action.reset().play();
    mixer.update(0); // settle the flying pose even under reduced motion
    return () => mixer.stopAllAction();
  }, [action, mixer]);

  useFrame(({ clock }, delta) => {
    const g = groupRef.current;
    if (!g) return;
    const t = clock.elapsedTime;
    const boot = bootRamp(t, [BOOT.relics[0] + 0.6, BOOT.relics[1]], reducedMotion);
    g.scale.setScalar(Math.max(boot, 0.0001));
    if (reducedMotion) {
      g.position.set(WYVERN.radiusX, WYVERN.altitude, 0);
      g.rotation.set(-0.12, WYVERN.yawOffset - Math.PI / 2, 0);
      return;
    }
    mixer.update(delta);
    const angle = t * WYVERN.angularSpeed;
    g.position.set(
      Math.cos(angle) * WYVERN.radiusX,
      WYVERN.altitude + Math.sin(t * WYVERN.bobSpeed) * WYVERN.bobAmplitude,
      Math.sin(angle) * WYVERN.radiusZ,
    );
    // Face along the flight tangent (model forward is +Z), banked into the
    // turn, nose slightly down
    const vx = -Math.sin(angle) * WYVERN.radiusX;
    const vz = Math.cos(angle) * WYVERN.radiusZ;
    g.rotation.set(-0.12, Math.atan2(vx, vz) + WYVERN.yawOffset, WYVERN.bank);
  });

  return (
    <group ref={groupRef} position={[WYVERN.radiusX, WYVERN.altitude, 0]}>
      <primitive object={model} />
    </group>
  );
}

useGLTF.preload(WYVERN_MODEL);

/**
 * Holographic enemy NPC projections — purely cosmetic showcases of hostile
 * unit types on the war table. No raycasting, no game state.
 */
export default function EnemyHolograms({ reducedMotion }) {
  const enemies = DEPLOYMENTS[getActiveMapId()] ?? [];
  return (
    <group>
      {enemies.map((entry, i) => (
        <GroundedEnemy
          key={`${entry.type}-${i}`}
          entry={entry}
          index={i}
          reducedMotion={reducedMotion}
        />
      ))}
      <TwilightWyvern reducedMotion={reducedMotion} />
    </group>
  );
}

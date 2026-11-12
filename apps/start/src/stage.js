import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { applyHoloToRig, holoFillMaterial } from './holo.js';

// The agent on its projector pad. Every agent is the lobby's animated crew
// mannequin, tinted per agent.

const AGENT_HEIGHT = 1.8;
const GREEN = 0x35ff7d;

// The QuestFi mark in 3D, traced from the logo: a thick flat-topped hexagon
// ring left open at the lower right, the tail cutting through that opening,
// and the logo's nested hexagons pushed back in depth so they read as a
// tunnel when the mark turns. Units: outer hexagon radius = 1.
function buildLogoQ() {
  const g = new THREE.Group();
  const R = 1;
  const r = 0.81;
  const DEPTH = 0.3;
  const vert = (rad, i) => new THREE.Vector2(rad * Math.cos((i * Math.PI) / 3), rad * Math.sin((i * Math.PI) / 3));
  const along = (rad, a, b, t) => vert(rad, a).lerp(vert(rad, b), t);

  // ring: from part-way down the lower-right edge, anticlockwise round to
  // most of the way along the bottom edge
  const ring = new THREE.Shape([
    along(R, 0, 5, 0.6), vert(R, 0), vert(R, 1), vert(R, 2), vert(R, 3), vert(R, 4), along(R, 4, 5, 0.9),
    along(r, 4, 5, 0.78), vert(r, 4), vert(r, 3), vert(r, 2), vert(r, 1), vert(r, 0), along(r, 0, 5, 0.72),
  ]);
  const tail = new THREE.Shape([
    new THREE.Vector2(0.1, -0.38), new THREE.Vector2(0.32, -0.38),
    new THREE.Vector2(0.87, -0.99), new THREE.Vector2(0.67, -0.99),
  ]);

  const fill = new THREE.MeshStandardMaterial({
    // kept dim: the bloom pass turns anything brighter into a white blob
    color: 0x06260f, emissive: 0x35ff7d, emissiveIntensity: 0.26, roughness: 0.35, metalness: 0.3,
  });
  const edge = new THREE.LineBasicMaterial({ color: 0xcfffe0, transparent: true, opacity: 0.9 });
  for (const shape of [ring, tail]) {
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: DEPTH, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.02, bevelSegments: 2,
    });
    geo.translate(0, 0, -DEPTH / 2);
    g.add(new THREE.Mesh(geo, fill));
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), edge));
  }

  // the tunnel: hexagon outlines shrinking as they recede
  const tunnel = [];
  const radii = [0.66, 0.53, 0.42, 0.33, 0.25, 0.18, 0.12];
  radii.forEach((rad, i) => {
    const pts = [];
    for (let k = 0; k < 6; k++) pts.push(new THREE.Vector3(rad * Math.cos((k * Math.PI) / 3), rad * Math.sin((k * Math.PI) / 3), 0));
    const base = 0.95 - i * 0.11;
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    // Mirrored about the mid-plane and kept inside the ring's thickness: the
    // rings step inward from both faces and meet in the middle. So the tunnel
    // looks the same from the back, and nothing pokes out behind the mark.
    const inset = (DEPTH / 2 - 0.02) * (1 - i / (radii.length - 1));
    for (const z of inset > 0.001 ? [inset, -inset] : [0]) {
      const loop = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: 0x49ff8c, transparent: true, opacity: base }));
      loop.position.z = z;
      loop.userData.base = base;
      loop.userData.order = i;
      g.add(loop);
      tunnel.push(loop);
    }
  });
  g.userData.tunnel = tunnel;

  // sit the mark on its visual centre (the tail hangs below the hexagon)
  g.children.forEach((c) => { c.position.y += 0.06; });
  return g;
}

export function createStage(scene) {
  const group = new THREE.Group();
  scene.add(group);

  // ---- projector pad ------------------------------------------------------
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(1.15, 1.3, 0.1, 64),
    holoFillMaterial(GREEN, { intensity: 0.12, base: 0.1 })
  );
  pad.position.y = -0.05;
  group.add(pad);

  const ringMat = new THREE.MeshBasicMaterial({ color: 0x49ff8c, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const ring = (r, w, y, opacity) => {
    const m = new THREE.Mesh(new THREE.RingGeometry(r, r + w, 96), ringMat.clone());
    m.material.opacity = opacity;
    m.rotation.x = -Math.PI / 2;
    m.position.y = y;
    group.add(m);
    return m;
  };
  ring(1.14, 0.03, 0.005, 0.9);
  ring(0.8, 0.012, 0.006, 0.5);
  const dashed = [];
  for (const [r, n] of [[1.5, 36], [1.85, 60]]) {
    const g = new THREE.Group();
    for (let i = 0; i < n; i++) {
      if (i % 3 === 2) continue;
      const a0 = (i / n) * Math.PI * 2;
      const seg = new THREE.Mesh(
        new THREE.RingGeometry(r, r + 0.025, 6, 1, a0, (Math.PI * 2) / n * 0.7),
        new THREE.MeshBasicMaterial({ color: 0x35ff7d, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
      );
      seg.rotation.x = -Math.PI / 2;
      g.add(seg);
    }
    g.position.y = 0.004;
    group.add(g);
    dashed.push(g);
  }

  // projection cone
  const coneMat = new THREE.MeshBasicMaterial({
    color: 0x35ff7d, transparent: true, opacity: 0.045, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.1, 2.9, 48, 1, true), coneMat);
  cone.position.y = 1.45;
  group.add(cone);

  // placeholder when nothing is linked
  const ghost = buildLogoQ();
  ghost.scale.setScalar(0.66);
  ghost.position.y = 1.2;
  group.add(ghost);

  const holder = new THREE.Group();
  group.add(holder);

  // ---- models -------------------------------------------------------------
  let crew = null; // Promise of the one model every agent shares
  const built = new Map(); // agent key -> { root, mixer }
  let token = 0;
  let current = null;

  function source() {
    crew ??= new GLTFLoader().loadAsync('models/crew.glb');
    return crew;
  }

  function buildCrew(gltf, def) {
    const rig = skeletonClone(gltf.scene);
    rig.rotation.y = Math.PI; // authored facing backwards
    applyHoloToRig(rig, def.tint);
    const mixer = new THREE.AnimationMixer(rig);
    const idle = gltf.animations.find((c) => c.name.endsWith('|Idle_Loop')) ?? gltf.animations[0];
    let minY = 0;
    let maxY = 1;
    if (idle) {
      const action = mixer.clipAction(idle);
      action.play();
      mixer.update(0.05);
    }
    // measure the posed rig, not the T-pose box (lobby's approach)
    rig.updateMatrixWorld(true);
    let sm = null;
    rig.traverse((o) => { if (o.isSkinnedMesh && !sm) sm = o; });
    if (sm) {
      sm.skeleton.update();
      const v = new THREE.Vector3();
      minY = Infinity;
      maxY = -Infinity;
      for (let i = 0; i < sm.geometry.attributes.position.count; i += 5) {
        sm.getVertexPosition(i, v).applyMatrix4(sm.matrixWorld);
        minY = Math.min(minY, v.y);
        maxY = Math.max(maxY, v.y);
      }
    }
    const s = AGENT_HEIGHT / (maxY - minY);
    rig.scale.setScalar(s);
    rig.position.y = -minY * s;
    const root = new THREE.Group();
    root.add(rig);
    return { root, mixer };
  }

  async function setAgent(def) {
    const my = ++token;
    if (!def) {
      holder.clear();
      current = null;
      ghost.visible = true;
      return;
    }
    let entry = built.get(def.key);
    if (!entry) {
      try {
        entry = buildCrew(await source(), def);
        built.set(def.key, entry);
      } catch (err) {
        console.error('[stage] model failed to load:', err);
        return;
      }
    }
    if (my !== token) return;
    holder.clear();
    holder.add(entry.root);
    current = entry;
    ghost.visible = false;
    entry.root.scale.setScalar(0.001); // materialise
    appear = 0;
    coneMat.color.set(def.tint);
  }

  // drag-to-spin: yaw is free with inertia, pitch is a small lean that eases
  // back. The idle sway fades in again a few seconds after the last touch.
  const spin = { yaw: 0, pitch: 0, vel: 0, dragging: false, idle: 99, sway: 1, phase: 0 };
  function dragStart() {
    spin.yaw = holder.rotation.y; // fold the current sway into the base angle
    spin.phase = 0;
    spin.sway = 0;
    spin.vel = 0;
    spin.idle = 0;
    spin.dragging = true;
  }
  function drag(dx, dy, dt) {
    if (!spin.dragging) return;
    const d = dx * 0.0085;
    spin.yaw += d;
    spin.vel = d / Math.max(dt, 0.008);
    spin.pitch = THREE.MathUtils.clamp(spin.pitch + dy * 0.004, -0.3, 0.38);
  }
  function dragEnd() {
    spin.dragging = false;
    spin.idle = 0;
    spin.vel = THREE.MathUtils.clamp(spin.vel, -14, 14);
  }

  let ghostTurn = 0;
  let appear = 1;
  let beam = 0; // 0 idle → 1 fully beamed out
  let beamTarget = 0;

  function update(dt, t) {
    dashed[0].rotation.y += dt * 0.25;
    dashed[1].rotation.y -= dt * 0.12;
    ghostTurn += dt * 0.7;
    ghost.rotation.y = ghostTurn + spin.yaw; // dragging turns the logo too
    ghost.rotation.x = spin.pitch;
    ghost.position.y = 1.2 + Math.sin(t * 1.4) * 0.05;
    ghost.userData.tunnel.forEach((ring) => {
      ring.material.opacity = ring.userData.base * (0.65 + 0.35 * Math.sin(t * 2.2 - ring.userData.order * 0.7));
    });

    beam += (beamTarget - beam) * Math.min(1, dt * 2.2);
    coneMat.opacity = 0.02 + beam * 0.13 + Math.sin(t * 3.0) * 0.004;

    if (current) {
      current.mixer?.update(dt);
      appear = Math.min(1, appear + dt * 2.4);
      const e = 1 - Math.pow(1 - appear, 3);
      const sxz = e * (1 - beam * 0.96);
      const sy = e * (1 + beam * 5);
      current.root.scale.set(Math.max(sxz, 0.001), Math.max(sy, 0.001), Math.max(sxz, 0.001));
      holder.visible = beam < 0.97;
    }

    if (!spin.dragging) {
      spin.yaw += spin.vel * dt;
      spin.vel *= Math.exp(-dt * 2.6);
      spin.pitch *= Math.exp(-dt * 3);
      spin.idle += dt;
      const settled = spin.idle > 3 && Math.abs(spin.vel) < 0.05;
      spin.sway += ((settled ? 1 : 0) - spin.sway) * Math.min(1, dt * 0.8);
      spin.phase += dt * 0.35 * spin.sway;
    }
    holder.rotation.y = spin.yaw + Math.sin(spin.phase) * 0.55 * spin.sway;
    holder.rotation.x = spin.pitch;
  }

  return {
    group,
    setAgent,
    update,
    preload: () => source().catch(() => {}),
    dragStart,
    drag,
    dragEnd,
    get dragging() { return spin.dragging; },
    beamOut: () => { beamTarget = 1; },
    beamIn: () => { beamTarget = 0; },
  };
}

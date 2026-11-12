import * as THREE from 'three';

/**
 * Deform rigs for weapons that animate without a skeleton.
 *
 * The accordion GLB is 32 static parts authored mid-squeeze — bellows bent
 * ~90° between the keyboard body and the bass body, no rig, no clips, and no
 * usable node split (the buttons are one mesh spanning both bodies; one casing
 * mesh spans the whole instrument). So it is rigged here instead, as a
 * per-vertex rotation field about the bellows' elbow line: vertices past the
 * fan swing as one rigid bass side, pleat vertices follow in proportion to
 * their angle around the hinge, and the keyboard side holds still. One rule,
 * no seams, straps and buttons included.
 *
 * Ported from the questfi-lobby armory exhibit, where the same model pumps on
 * a pedestal. The hinge constants are read off the authored pose in model
 * space and only hold because the GLB's node transforms were never re-baked —
 * if the asset is ever re-exported, re-measure them.
 */

const HX = 0.05; // hinge line, model space (z-aligned)
const HY = -0.32;
const SPAN = Math.PI / 2; // authored fan: keyboard face -> bass face
const MAX_ANGLE = 0.78; // full squeeze: swings the ~90° elbow down to ~45°

export const BELLOWS_MAX_ANGLE = MAX_ANGLE;

/**
 * Build the bellows rig for a cloned accordion, or throw if the model does
 * not match the authored pose the hinge constants were measured against.
 *
 * `root` must already be in its final local pose — the rig rebases every
 * vertex through `inv(root.matrixWorld)`, so it has to see settled matrices.
 * Geometry is cloned per call: the deform rewrites vertex buffers in place,
 * and three's `clone()` shares geometry between instances.
 */
export function rigBellows(root) {
  root.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const toModel = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const parts = [];

  root.traverse((o) => {
    if (!o.isMesh) return;
    // The deform moves vertices without touching the cached bounds, so
    // three would cull against the rest pose. A viewmodel is always on
    // screen and never raycast, so switch culling off rather than pay for
    // a bounds recompute on every mesh on every frame.
    o.frustumCulled = false;
    o.geometry = o.geometry.clone();
    let attr = o.geometry.attributes.position;
    if (attr.isInterleavedBufferAttribute) {
      attr = attr.clone(); // de-interleave so we can rewrite freely
      o.geometry.setAttribute('position', attr);
    }
    toModel.copy(inv).multiply(o.matrixWorld);
    const base = new Float32Array(attr.count * 3); // rest pose, model space
    const weight = new Float32Array(attr.count);
    let moving = 0;
    for (let i = 0; i < attr.count; i++) {
      v.fromBufferAttribute(attr, i).applyMatrix4(toModel);
      base[i * 3] = v.x;
      base[i * 3 + 1] = v.y;
      base[i * 3 + 2] = v.z;
      // angle around the hinge, measured from the keyboard face's plane
      // toward the bass side; clamped so each rigid side moves as one
      const phi = Math.atan2(v.x - HX, v.y - HY);
      weight[i] = THREE.MathUtils.clamp(phi / SPAN, 0, 1);
      if (weight[i] > 0) moving++;
    }
    if (!moving) return; // keyboard-side parts never move — skip forever
    parts.push({ attr, base, weight, back: toModel.clone().invert() });
  });

  if (!parts.length) {
    // Silence here would ship a motionless accordion with nothing to debug.
    throw new Error(
      'rigBellows: no vertices fell in the hinge band — the accordion asset '
      + 'no longer matches the authored pose HX/HY/SPAN were measured against.',
    );
  }
  return { parts };
}

/**
 * Swing the bass side shut by `angle` radians around the hinge, pleats
 * folding in proportion. Rewrites vertex positions from the stored rest pose
 * rather than incrementally, so repeated calls never accumulate drift.
 */
export function pumpBellows(rig, angle) {
  const v = new THREE.Vector3();
  for (const p of rig.parts) {
    const { attr, base, weight, back } = p;
    for (let i = 0; i < attr.count; i++) {
      const w = weight[i];
      if (w === 0) continue;
      const a = angle * w;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const dx = base[i * 3] - HX;
      const dy = base[i * 3 + 1] - HY;
      // decreasing phi closes the fan: rotate toward the keyboard face
      v.set(HX + c * dx - s * dy, HY + s * dx + c * dy, base[i * 3 + 2]);
      v.applyMatrix4(back);
      attr.setXYZ(i, v.x, v.y, v.z);
    }
    attr.needsUpdate = true;
    // No computeBoundingSphere here: the pedestal version recomputed it
    // every frame to keep hover picking honest, but a viewmodel is never
    // raycast. rigBellows turns off frustum culling to match.
  }
}

/**
 * Idle: a wandering-tempo breath, shallower than a real squeeze. The tempo
 * term keeps it off the metronome — more busker than machine.
 */
export function bellowsIdleAngle(t) {
  return 0.45 * MAX_ANGLE * (0.5 + 0.5 * Math.sin(t * 1.15 + Math.sin(t * 0.4) * 1.9));
}

/**
 * Attack: two full squeezes across the beat, landing back at the idle depth
 * so a dropped beat can never leave the bellows folded open.
 */
export function bellowsPlayAngle(progress) {
  const p = THREE.MathUtils.clamp(progress, 0, 1);
  return MAX_ANGLE * Math.abs(Math.sin(p * Math.PI * 2));
}

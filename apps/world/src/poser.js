import * as THREE from 'three';
import { RIGS } from './config.js';

// Procedural poser for the human rigs. The FBX drops key only their hand
// props, so the skeleton is driven here: a walk cycle (legs swing from the
// hip with the knee folding on the back swing, arms counter-swing, pelvis
// bobs, torso rolls), a breathing idle, a flailing panic and a dance.
// States blend through eased amplitudes, so a walker slowing to a stop just
// settles instead of popping.
//
// The rigs' bone-local axes are whatever the authoring tool left; rather
// than guess, each joint is calibrated once against the rest pose: the
// world side axis (character X) and up axis are expressed in bone space,
// and a test rotation tells which sign swings the end effector forward.

const _q = new THREE.Quaternion();
const _r = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export function createPoser(rig, boneMap) {
  const W = RIGS.walk;
  const get = (...names) => {
    for (const n of names) {
      for (const [base, full] of boneMap) {
        if (base.toLowerCase() === n.toLowerCase()) return rig.getObjectByName(full);
      }
    }
    return null;
  };
  const bones = {
    pelvis: get('Pelvis', 'Hips'),
    spine: get('Spine'),
    chest: get('Chest', 'Spine_1', 'Spine1'),
    neck: get('Neck'),
    head: get('Head'),
    lUp: get('LeftUpLeg'), lLeg: get('LeftLeg'), lFoot: get('LeftFoot'),
    rUp: get('RightUpLeg'), rLeg: get('RightLeg'), rFoot: get('RightFoot'),
    lArm: get('LeftArm'), lFore: get('LeftForeArm', 'LeftForearm'), lHand: get('LeftHand'),
    rArm: get('RightArm'), rFore: get('RightForeArm', 'RightForearm'), rHand: get('RightHand'),
  };

  rig.updateMatrixWorld(true);
  const rigInv = new THREE.Matrix4().copy(rig.matrixWorld).invert();

  // joint calibration -----------------------------------------------------
  function joint(bone, effector, { forwardIsPlus = true } = {}) {
    if (!bone) return null;
    const rest = bone.quaternion.clone();
    bone.getWorldQuaternion(_q);
    const inv = _q.clone().invert();
    const axisSide = new THREE.Vector3(1, 0, 0).applyQuaternion(inv).normalize();
    const axisUp = new THREE.Vector3(0, 1, 0).applyQuaternion(inv).normalize();
    const axisFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(inv).normalize();
    let sign = 1;
    if (effector) {
      // which way does a positive side-axis rotation push the effector?
      effector.getWorldPosition(_v).applyMatrix4(rigInv);
      const z0 = _v.z;
      bone.quaternion.copy(rest).multiply(_r.setFromAxisAngle(axisSide, 0.4));
      bone.updateWorldMatrix(true, true);
      effector.getWorldPosition(_w).applyMatrix4(rigInv);
      sign = (_w.z - z0 >= 0) === forwardIsPlus ? 1 : -1;
      bone.quaternion.copy(rest);
      bone.updateWorldMatrix(true, true);
    }
    return { bone, rest, axisSide, axisUp, axisFwd, sign };
  }

  const J = {
    pelvis: joint(bones.pelvis, null),
    spine: joint(bones.spine, bones.head),
    chest: joint(bones.chest, bones.head),
    neck: joint(bones.neck, bones.head),
    head: joint(bones.head, null),
    lUp: joint(bones.lUp, bones.lFoot),
    rUp: joint(bones.rUp, bones.rFoot),
    lLeg: joint(bones.lLeg, bones.lFoot, { forwardIsPlus: false }), // knees fold back
    rLeg: joint(bones.rLeg, bones.rFoot, { forwardIsPlus: false }),
    lArm: joint(bones.lArm, bones.lHand),
    rArm: joint(bones.rArm, bones.rHand),
    lFore: joint(bones.lFore, bones.lHand),
    rFore: joint(bones.rFore, bones.rHand),
  };
  const pelvisRestY = bones.pelvis ? bones.pelvis.position.y : 0;

  // state ------------------------------------------------------------------
  const amp = { walk: 0, idle: 1, panic: 0, dance: 0 };
  let mode = 'idle';
  let speedScale = 1;
  let phase = Math.random() * Math.PI * 2;
  let t = Math.random() * 10;

  function set(name, speed = 1) {
    mode = ['walk', 'panic', 'dance'].includes(name) ? name : 'idle';
    if (name === 'walk') speedScale = speed;
  }

  // side = rotation about the side axis (forward swing positive), up = about
  // the vertical axis, fwd = about the forward axis (roll)
  function pose(j, side = 0, up = 0, fwd = 0) {
    if (!j) return;
    _q.copy(j.rest);
    if (side) _q.multiply(_r.setFromAxisAngle(j.axisSide, side * j.sign));
    if (up) _q.multiply(_r.setFromAxisAngle(j.axisUp, up));
    if (fwd) _q.multiply(_r.setFromAxisAngle(j.axisFwd, fwd));
    j.bone.quaternion.copy(_q);
  }

  function update(dt) {
    t += dt;
    for (const k of Object.keys(amp)) {
      const target = k === mode ? 1 : 0;
      amp[k] += (target - amp[k]) * (1 - Math.exp(-(target ? 9 : 6) * dt));
    }
    // the cycle keeps turning while there's any walk left to blend out
    const cyclesPerSec = (1.4 * speedScale) / W.stride;
    phase += cyclesPerSec * Math.PI * 2 * dt * Math.max(amp.walk, 0.15);
    const s = Math.sin(phase);
    const c = Math.cos(phase);

    const wk = amp.walk;
    const id = amp.idle;
    const pn = amp.panic;
    const dn = amp.dance;
    const breathe = Math.sin(t * 1.6) * 0.5 + 0.5;
    const dbeat = Math.sin(t * 7.5);
    const dbeat2 = Math.sin(t * 3.75);
    const jitter = Math.sin(t * 23) * 0.5 + Math.sin(t * 31) * 0.5;

    // legs: hips swing opposite, knees fold on the back half of the swing
    const legL = s * W.legSwing * wk;
    const legR = -s * W.legSwing * wk;
    const kneeL = Math.max(0, -c) * W.kneeBend * wk + dn * 0.25 * (dbeat * 0.5 + 0.5);
    const kneeR = Math.max(0, c) * W.kneeBend * wk + dn * 0.25 * (-dbeat * 0.5 + 0.5);
    pose(J.lUp, legL + dn * 0.12 * dbeat2);
    pose(J.rUp, legR - dn * 0.12 * dbeat2);
    pose(J.lLeg, kneeL);
    pose(J.rLeg, kneeR);

    // arms: counter-swing, hang relaxed in idle, up and shaking in panic,
    // pumping in the dance
    const armIdle = 0.08 * id * (breathe - 0.5);
    const armL = -s * W.armSwing * wk + armIdle + pn * (1.9 + jitter * 0.25) + dn * (0.9 + 0.5 * dbeat);
    const armR = s * W.armSwing * wk + armIdle + pn * (1.9 - jitter * 0.25) + dn * (0.9 - 0.5 * dbeat);
    pose(J.lArm, armL, 0, dn * 0.35 + pn * 0.4);
    pose(J.rArm, armR, 0, -(dn * 0.35 + pn * 0.4));
    pose(J.lFore, W.elbowBend * wk * (0.5 + 0.5 * -s) + pn * (0.9 + jitter * 0.3) + dn * (0.8 + 0.4 * dbeat) + id * 0.12);
    pose(J.rFore, W.elbowBend * wk * (0.5 + 0.5 * s) + pn * (0.9 - jitter * 0.3) + dn * (0.8 - 0.4 * dbeat) + id * 0.12);

    // torso: a little roll and twist with the stride, a shimmy in the dance,
    // hunched and shaking in panic
    const roll = Math.sin(phase * 2) * W.sway * wk + dn * 0.12 * dbeat;
    pose(J.spine, pn * 0.25 + dn * 0.08 * dbeat2, s * 0.08 * wk + dn * 0.3 * dbeat2, roll);
    pose(J.chest, -pn * 0.1 + id * 0.015 * breathe, -s * 0.05 * wk, roll * 0.4);
    pose(J.neck, 0, -s * 0.04 * wk + pn * 0.2 * jitter);
    pose(J.head, pn * 0.15 + dn * 0.1 * dbeat, dn * 0.2 * dbeat2 + id * 0.05 * Math.sin(t * 0.7), 0);

    // pelvis bounce (twice per cycle) + dance bounce
    if (bones.pelvis) {
      bones.pelvis.position.y = pelvisRestY
        + (Math.abs(Math.sin(phase)) - 0.5) * W.bob * 2 * wk
        + dn * 0.04 * (dbeat * 0.5 - 0.5)
        - pn * 0.03;
      pose(J.pelvis, 0, s * 0.06 * wk + dn * 0.15 * dbeat2, -roll * 0.5);
    }
  }

  return {
    set,
    setSpeed(v) { speedScale = v; },
    duration(name) { return name === 'panic' ? 2.2 : name === 'dance' ? 6 : 1; },
    update,
    get mode() { return mode; },
    joints: J,
  };
}

import * as THREE from 'three';
import { GLOBE } from '../config.js';
import { R, CENTER, NORTH_AXIS, upAt } from './geo.js';
import { terrainHeight } from './terrain.js';

// The GLOBE camera. Its whole state is a local frame on the sphere — a
// quaternion whose +Y is "up" at the camera's ground point and whose −Z is
// the heading — plus altitude and a pitch offset. Moving over the planet
// rotates that frame, so heading is carried along the surface without
// singularities anywhere on the sphere.
//
//   wheel / SPACE / C   log zoom: every notch is the same altitude *factor*
//   WASD                move over the planet (speed scales with altitude)
//   mouse               heading (x), pitch offset (y)
//
// Pitch follows altitude: straight at the planet's center from orbit,
// swinging up toward the horizon as you come down, so arriving at the
// handoff altitude looks exactly like free flight does.

const Y = new THREE.Vector3(0, 1, 0);
const qTmp = new THREE.Quaternion();
const vTmp = new THREE.Vector3();
const vTmp2 = new THREE.Vector3();

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

export function pitchCurve(h) {
  const [a, b] = GLOBE.pitchBlend;
  const s = smooth(Math.log(a), Math.log(b), Math.log(Math.max(h, 1)));
  return GLOBE.pitchLow + (-Math.PI / 2 - GLOBE.pitchLow) * s;
}

// a frame quaternion for a ground point (site-local x, z) and heading yaw
export function frameAt(x, z, yaw, out = new THREE.Quaternion()) {
  out.setFromUnitVectors(Y, upAt(x, z, vTmp));
  return out.multiply(qTmp.setFromAxisAngle(Y, yaw));
}

export function createGlobeCam(camera) {
  const st = {
    q: new THREE.Quaternion(),
    h: GLOBE.orbitAlt,
    hTarget: GLOBE.orbitAlt,
    pitchOff: 0,
    idle: 0,
    tween: null,
  };

  // where the city is: dives and the zoom keep this point in frame
  const focus = { x: GLOBE.sites[0].landing.x, z: GLOBE.sites[0].landing.z };
  const fC = new THREE.Vector3();
  const fUp = new THREE.Vector3();
  const fFwd = new THREE.Vector3();
  const fV = new THREE.Vector3();
  // the camera's base pitch for a frame + altitude: the altitude curve, but
  // below ~60 km never so shallow that the focus point drops out of the
  // bottom of the frame (a smooth min keeps it continuous)
  function basePitch(q = st.q, h = st.h) {
    const c = pitchCurve(h);
    const w = 1 - smooth(30_000, 60_000, h);
    if (w <= 0) return c;
    fUp.copy(Y).applyQuaternion(q);
    fFwd.set(0, 0, -1).applyQuaternion(q);
    fC.copy(CENTER).addScaledVector(fUp, R + h);
    fV.set(focus.x, 0, focus.z).sub(fC);
    const aim = Math.atan2(fV.dot(fUp), Math.max(fV.dot(fFwd), 1e-3));
    const b = aim + 0.45; // the focus ~10° inside the bottom edge
    const sm = (c + b - Math.sqrt((c - b) * (c - b) + 0.0064)) / 2;
    return c + (sm - c) * w;
  }

  function pitch() {
    return THREE.MathUtils.clamp(basePitch() + st.pitchOff, -Math.PI / 2, 0.35);
  }

  function apply() {
    const up = vTmp.copy(Y).applyQuaternion(st.q);
    camera.position.copy(CENTER).addScaledVector(up, R + st.h);
    camera.quaternion.copy(st.q).multiply(qTmp.setFromAxisAngle(vTmp2.set(1, 0, 0), pitch()));
  }

  // FREE FLIGHT → GLOBE, continuous: same position, heading and pitch
  function enterFrom(pos, yaw, pitchNow, hTarget = null) {
    st.q.setFromUnitVectors(Y, vTmp.copy(pos).sub(CENTER).normalize());
    st.q.multiply(qTmp.setFromAxisAngle(Y, yaw));
    st.h = Math.max(1, vTmp.copy(pos).sub(CENTER).length() - R);
    st.hTarget = hTarget ?? st.h;
    st.pitchOff = pitchNow - basePitch();
    st.idle = 0;
    st.tween = null;
    apply();
  }

  // GLOBE → FREE FLIGHT: the fly state that reproduces this exact view
  function flyState() {
    const f = vTmp.set(0, 0, -1).applyQuaternion(st.q);
    return { pos: camera.position.clone(), yaw: Math.atan2(-f.x, -f.z), pitch: pitch() };
  }

  // ground arc distance (m) from the camera's nadir to a site-local point
  function arcTo(x, z) {
    const up = vTmp.copy(Y).applyQuaternion(st.q);
    const s = upAt(x, z, vTmp2);
    return Math.atan2(vTmp.clone().cross(s).length(), up.dot(s)) * R;
  }

  // an eased flight to a target frame / altitude / pitch. Diving, the ground
  // travel happens up high and the last stretch is all descent; climbing,
  // the reverse — nobody skims the rooftops at 3,000 km/h.
  function flyTo(target, { duration = null, onDone = null } = {}) {
    const h0 = st.h;
    const h1 = target.h;
    const dur = duration ?? THREE.MathUtils.clamp(1.4 + 0.5 * Math.abs(Math.log(h1 / h0)), 1.6, GLOBE.diveSeconds);
    st.tween = {
      t: 0,
      dur,
      q0: st.q.clone(),
      q1: target.q.clone(),
      h0,
      h1,
      off0: pitch() - basePitch(st.q, h0),
      off1: target.pitch - basePitch(target.q, h1),
      diving: h1 < h0,
      // ground distance the frame has to cover, for keeping the target in view
      arc: new THREE.Vector3(0, 1, 0).applyQuaternion(st.q).angleTo(new THREE.Vector3(0, 1, 0).applyQuaternion(target.q)) * R,
      onDone,
    };
  }

  function stepTween(dt) {
    const tw = st.tween;
    tw.t += dt;
    const u = clamp01(tw.t / tw.dur);
    const ph = easeInOut(u);
    let pq = tw.diving ? easeInOut(clamp01(u / 0.72)) : easeInOut(clamp01((u - 0.28) / 0.72));
    st.h = Math.exp(Math.log(tw.h0) + (Math.log(tw.h1) - Math.log(tw.h0)) * ph);
    // diving, never let the target slide further off the nadir than ~ the
    // altitude: the beacon stays in frame the whole way down
    if (tw.diving && tw.arc > 1) pq = Math.max(pq, 1 - (0.35 * st.h) / tw.arc);
    st.q.slerpQuaternions(tw.q0, tw.q1, pq);
    st.hTarget = st.h;
    st.pitchOff = tw.off0 + (tw.off1 - tw.off0) * ph;
    if (u >= 1) {
      st.tween = null;
      tw.onDone?.();
    }
  }

  function look(dx, dy) {
    if (st.tween) return;
    st.q.multiply(qTmp.setFromAxisAngle(Y, -dx * 0.0021));
    st.pitchOff = THREE.MathUtils.clamp(st.pitchOff - dy * 0.0021, -1.6, 1.6);
    st.idle = 0;
  }

  function zoom(notches) {
    if (st.tween) return;
    st.hTarget = THREE.MathUtils.clamp(st.hTarget * Math.pow(GLOBE.zoomStep, notches), GLOBE.minAlt, GLOBE.maxAlt);
    st.idle = 0;
  }

  const site = GLOBE.sites[0];
  // returns 'land' when it's time to hand back to FREE FLIGHT
  function update(dt, keys) {
    if (st.tween) {
      stepTween(dt);
      apply();
      return null;
    }
    // WASD over the planet; SPACE / C zoom
    const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3 : 1;
    let fwd = 0;
    let side = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) side += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) side -= 1;
    if (keys.has('Space')) st.hTarget = Math.min(GLOBE.maxAlt, st.hTarget * Math.exp(1.6 * dt * boost));
    if (keys.has('KeyC')) st.hTarget = Math.max(GLOBE.minAlt, st.hTarget * Math.exp(-1.6 * dt * boost));
    if (fwd || side) {
      const dist = Math.min(st.h, R) * 0.9 * boost * dt;
      const a = dist / R;
      const len = Math.hypot(fwd, side);
      st.q.multiply(qTmp.setFromAxisAngle(vTmp.set(side / len, 0, -fwd / len).cross(Y).negate().normalize(), a));
    }
    if (fwd || side || keys.has('Space') || keys.has('KeyC')) st.idle = 0;
    else st.idle += dt;

    // log-smoothed altitude; the pitch offset relaxes as the altitude changes
    const lh = Math.log(st.h);
    const nl = lh + (Math.log(st.hTarget) - lh) * (1 - Math.exp(-7 * dt));
    st.h = Math.exp(nl);
    st.pitchOff *= Math.exp(-Math.abs(nl - lh) * 1.1);
    // keep clear of the mountains under the camera
    if (st.h < 8000) {
      const up = vTmp.copy(Y).applyQuaternion(st.q);
      const floor = terrainHeight(up.x * R, up.z * R) + 250;
      if (st.h < floor) st.h = st.hTarget = Math.max(st.hTarget, floor);
    }

    // the planet turns under an idle orbit camera
    if (st.idle > 4 && st.h > GLOBE.bands.regional) {
      st.q.premultiply(qTmp.setFromAxisAngle(NORTH_AXIS, (-GLOBE.idleSpin * Math.PI / 180) * dt));
    }

    // coming down, the city reels you in: below ~40 km the nadir is pulled
    // toward the landing point so every descent ends over the streets
    if (st.h < 40_000) {
      const d = arcTo(site.landing.x, site.landing.z);
      const allowed = Math.max(900, st.h * 3);
      if (d > allowed) {
        const up = vTmp.copy(Y).applyQuaternion(st.q);
        const s = upAt(site.landing.x, site.landing.z, vTmp2);
        const axis = up.clone().cross(s).normalize();
        st.q.premultiply(qTmp.setFromAxisAngle(axis, ((d - allowed) / R) * (1 - Math.exp(-4 * dt))));
      }
    }
    apply();
    if (st.h <= GLOBE.handoff.down && arcTo(site.landing.x, site.landing.z) < 2500) return 'land';
    return null;
  }

  return {
    st,
    enterFrom,
    flyState,
    flyTo,
    look,
    zoom,
    update,
    apply,
    pitch,
    basePitch,
    setFocus(p) {
      focus.x = p.x;
      focus.z = p.z;
    },
    get altitude() { return st.h; },
    get busy() { return !!st.tween; },
    get heading() {
      const f = vTmp.set(0, 0, -1).applyQuaternion(st.q);
      return Math.atan2(-f.x, -f.z);
    },
  };
}

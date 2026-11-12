import * as THREE from 'three';
import { GLOBE } from '../config.js';
import { R, NORTH_AXIS } from './geo.js';
import { frameAt } from './globecam.js';

// ?cinematic=1 — the marketing take. A pure function of time τ: orbit with
// the planet turning, the beacon in view; an accelerating dive; the pitch
// swinging from the planet's center to the horizon; then a slow fly-over of
// downtown that keeps drifting after the take ends. Every parameter blends
// on overlapping smootherstep curves, so position, velocity and rotation are
// continuous throughout.

const sm = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

export function createCinematic({ globeCam, establishing, duration = GLOBE.cinematic.duration }) {
  const D = duration;
  const est = establishing();
  const qEst = frameAt(est.pos.x, est.pos.z, est.yaw);
  const landing = GLOBE.sites[0].landing;
  const qSite = frameAt(landing.x, landing.z, 0);
  const h0 = GLOBE.orbitAlt;
  const hEst = est.pos.y;
  const hEnd = 260; // clear of all but the tallest towers (up to 430 m)
  const pEst = est.pitch;
  const pEnd = -0.36;
  const spin0 = (40 * Math.PI) / 180; // start 40° east of the city…
  const spin = (1.1 * Math.PI) / 180; // …the planet turning it into view, 1.1°/s
  const v = 22; // fly-over speed, m/s
  const ta = 0.74 * D;
  const tb = 0.9 * D;

  const qOrbit = new THREE.Quaternion();
  const qTmp = new THREE.Quaternion();
  const up0 = new THREE.Vector3();
  const up1 = new THREE.Vector3(0, 1, 0).applyQuaternion(qEst);
  const X = new THREE.Vector3(1, 0, 0);

  // forward travel: the integral of a smoothstep ramp, constant speed, and
  // after the take ends a long coast to a stop (time constant tc)
  const tc = 9;
  function travel(t) {
    const x = (t - ta) / (tb - ta);
    if (x <= 0) return 0;
    if (x <= 1) return v * (tb - ta) * (x * x * x - (x * x * x * x) / 2);
    const cruise = v * (tb - ta) * 0.5;
    if (t <= D) return cruise + v * (t - tb);
    return cruise + v * (D - tb) + v * tc * (1 - Math.exp(-(t - D) / tc));
  }

  function sample(t, out = { q: new THREE.Quaternion(), h: 0, pitch: 0 }) {
    const u = t / D;
    // altitude: the dive, then settle lower for the fly-over (log space)
    const s1 = sm(0.16, 0.76, u);
    const s2 = sm(0.74, 1.0, u);
    out.h = Math.exp(Math.log(h0) + (Math.log(hEst) - Math.log(h0)) * s1 + (Math.log(hEnd) - Math.log(hEst)) * s2);

    // ground track: orbit → over the city. In meters still to go: the
    // schedule's, and the dive's own (a third of the height left above the
    // establishing altitude), joined by a harmonic minimum. The second one
    // reaches zero exactly when the descent does, with zero speed, so the
    // track glides in — no sprint to close the last few hundred meters.
    qOrbit.setFromAxisAngle(NORTH_AXIS, Math.max(0, spin0 - spin * t)).multiply(qSite);
    up0.set(0, 1, 0).applyQuaternion(qOrbit);
    const arc = up0.angleTo(up1) * R;
    const hDive = Math.exp(Math.log(h0) + (Math.log(hEst) - Math.log(h0)) * s1);
    const k = sm(0.06, 0.3, u);
    const dSched = arc * (1 - 0.98 * sm(0.08, 0.62, u)); // never forces the finish itself
    let rest = dSched;
    if (k > 0) {
      const dDive = (0.35 * Math.max(0, hDive - hEst)) / k;
      rest = dSched > 0 && dDive > 0 ? 1 / (1 / dSched + 1 / dDive) : 0;
    }
    out.q.slerpQuaternions(qOrbit, qEst, arc > 1e-3 ? 1 - rest / arc : 1);
    // the fly-over: carry the frame forward along its heading
    const f = travel(t);
    if (f > 0) out.q.multiply(qTmp.setFromAxisAngle(X, -f / R));

    // pitch: the curve (center → horizon), then the establishing angle,
    // then a shallower cruise
    const base = globeCam.basePitch(out.q, out.h); // keeps the city in frame
    const pe = base + (pEst - base) * sm(0.5, 0.78, u);
    out.pitch = pe + (pEnd - pe) * s2;
    return out;
  }

  const state = { q: new THREE.Quaternion(), h: 0, pitch: 0 };
  return {
    duration: D,
    sample,
    // drive the globe camera to time t
    apply(t) {
      sample(t, state);
      const st = globeCam.st;
      st.tween = null;
      st.q.copy(state.q);
      st.h = st.hTarget = state.h;
      st.pitchOff = state.pitch - globeCam.basePitch(state.q, state.h);
      globeCam.apply();
    },
  };
}

import * as THREE from 'three';
import { SPECTATE, CITY, GLOBE } from './config.js';
import { createGlobeCam, frameAt } from './globe/globecam.js';
import { NORTH_AXIS } from './globe/geo.js';

// The spectator: three modes over one pointer-locked mouse look.
//   FLY   — noclip camera. WASD along the view, SPACE up, C down, SHIFT boost,
//           wheel zooms the altitude (a constant factor per notch). Speed
//           scales with height. Climb past the top of the street band and
//           the GLOBE camera takes over from the same spot.
//   POV   — first person on an agent's eyes (head bone, or the driver's seat
//           when they're behind a wheel). N/P or ] [ cycle the roster, T
//           toggles the auto-cycle timer, mouse adds a free-look offset.
//   GLOBE — orbit the planet, log zoom (src/globe/globecam.js). Coming down
//           below the handoff altitude lands you back in FLY, no jump.
//   TAB   cycles FLY → POV → GLOBE → FLY; F flips FLY / POV; G climbs to orbit
//         or dives back to the city.

export function createSpectator(camera, canvas, feed) {
  const spec = {
    mode: 'fly',
    yaw: SPECTATE.spawn.yaw,
    pitch: SPECTATE.spawn.pitch,
    pos: new THREE.Vector3(SPECTATE.spawn.x, SPECTATE.spawn.y, SPECTATE.spawn.z),
    vel: new THREE.Vector3(),
    keys: new Set(),
    locked: false,
    zoomTarget: null, // fly: altitude the wheel asked for
    // pov
    roster: [],
    target: null,
    index: -1,
    auto: true,
    autoT: SPECTATE.autoCycle,
    lookYaw: 0,
    lookPitch: 0,
    camYaw: 0,
    camPitch: 0,
    eye: new THREE.Vector3(),
    eyeSmooth: new THREE.Vector3(),
    onChange: null, // (spec) → HUD refresh
  };
  const globeCam = createGlobeCam(camera);
  let landing = null; // establishing-view override from main (the venues' centroid)

  const isTouch = window.matchMedia('(pointer: coarse)').matches;

  document.addEventListener('pointerlockchange', () => {
    spec.locked = document.pointerLockElement === canvas;
  });
  document.addEventListener('mousemove', (e) => {
    if (!spec.locked) return;
    const k = 0.0021;
    if (spec.mode === 'fly') {
      spec.yaw -= e.movementX * k;
      spec.pitch = THREE.MathUtils.clamp(spec.pitch - e.movementY * k, -1.5, 1.5);
    } else if (spec.mode === 'globe') {
      globeCam.look(e.movementX, e.movementY);
    } else {
      spec.lookYaw = THREE.MathUtils.clamp(spec.lookYaw - e.movementX * k, -2.4, 2.4);
      spec.lookPitch = THREE.MathUtils.clamp(spec.lookPitch - e.movementY * k, -1.2, 1.2);
    }
  });
  document.addEventListener('keydown', (e) => {
    spec.keys.add(e.code);
    if (e.code === 'Space') e.preventDefault();
    if (e.repeat) return;
    if (e.code === 'Tab') {
      e.preventDefault();
      cycleMode();
    }
    if (e.code === 'KeyF') toggleMode();
    if (e.code === 'KeyG') toggleGlobe();
    if (e.code === 'KeyN' || e.code === 'BracketRight') cycle(1);
    if (e.code === 'KeyP' || e.code === 'BracketLeft') cycle(-1);
    if (e.code === 'KeyT') {
      spec.auto = !spec.auto;
      spec.autoT = SPECTATE.autoCycle;
      feed.push(spec.auto ? 'auto-cycle on' : 'auto-cycle off', '#7dffb0');
      spec.onChange?.(spec);
    }
  });
  document.addEventListener('keyup', (e) => spec.keys.delete(e.code));
  window.addEventListener('blur', () => spec.keys.clear());
  canvas.addEventListener('wheel', (e) => {
    // scroll down / back = out. Trackpads send many small deltas.
    const notches = THREE.MathUtils.clamp(e.deltaY / 100, -3, 3);
    if (spec.mode === 'fly') {
      const from = spec.zoomTarget ?? spec.pos.y;
      spec.zoomTarget = THREE.MathUtils.clamp(from * Math.pow(GLOBE.zoomStep, notches), SPECTATE.flyMinY, GLOBE.maxAlt);
    } else if (spec.mode === 'globe') globeCam.zoom(notches);
  }, { passive: true });

  // TAB: FLY → POV → GLOBE → FLY
  function cycleMode() {
    if (globeCam.busy) return;
    if (spec.mode === 'fly') toggleMode();
    else if (spec.mode === 'pov') ascend();
    else dive();
  }

  // F: FLY ⇄ POV
  function toggleMode() {
    if (globeCam.busy || spec.mode === 'globe') return;
    if (spec.mode === 'fly') {
      if (!spec.roster.length) return;
      enterPov(spec.target ?? spec.roster[Math.max(0, spec.index)] ?? spec.roster[0]);
    } else exitPov();
  }

  // G: to orbit, or back down
  function toggleGlobe() {
    if (globeCam.busy) return;
    if (spec.mode === 'globe') dive();
    else ascend();
  }

  function setMode(m) {
    spec.mode = m;
    spec.onChange?.(spec);
  }

  // take over from wherever the camera is, as GLOBE
  function enterGlobe(hTarget = null) {
    if (spec.mode === 'pov') exitPov(true);
    const yaw = spec.yaw;
    globeCam.enterFrom(spec.mode === 'fly' ? spec.pos : camera.position, yaw, spec.pitch, hTarget);
    setMode('globe');
  }

  // GLOBE → FLY from a fly-state, continuous
  function land(state) {
    spec.pos.copy(state.pos);
    spec.yaw = state.yaw;
    spec.pitch = state.pitch;
    spec.vel.set(0, 0, 0);
    spec.zoomTarget = state.zoomTarget ?? null;
    setMode('fly');
    updateFly(0);
  }

  function ascend() {
    if (spec.mode !== 'globe') enterGlobe();
    globeCam.flyTo({ q: globeCam.st.q.clone(), h: GLOBE.orbitAlt, pitch: -Math.PI / 2 });
    feed.push('pulling out to orbit', '#7dffb0');
  }

  // a fly-state above the city that frames downtown and the venues
  function establishing() {
    const e = GLOBE.establishing;
    const look = landing ?? GLOBE.sites[0].landing;
    const pitch = (e.pitch * Math.PI) / 180;
    const back = e.alt / Math.tan(-pitch);
    return {
      pos: new THREE.Vector3(look.x + Math.sin(e.yaw) * back, e.alt, look.z + Math.cos(e.yaw) * back),
      yaw: e.yaw,
      pitch,
    };
  }

  // GLOBE (or anywhere) → an eased dive that lands in FLY at `state`
  function dive(state = establishing(), then = null) {
    if (spec.mode !== 'globe') enterGlobe();
    const q = frameAt(state.pos.x, state.pos.z, state.yaw);
    globeCam.flyTo({ q, h: Math.max(1, state.pos.y), pitch: state.pitch }, {
      onDone: () => {
        land(state);
        then?.();
      },
    });
    feed.push('diving to the city', '#7dffb0');
  }

  function enterPov(agent) {
    if (!agent) return;
    if (spec.mode === 'globe') {
      // from orbit: dive to just above them, then drop into their eyes
      dive({ pos: new THREE.Vector3(agent.pos.x, 70, agent.pos.z + 60), yaw: 0, pitch: -0.75 }, () => enterPov(agent));
      return;
    }
    const idx = spec.roster.indexOf(agent);
    spec.index = idx;
    if (spec.target && spec.target !== agent) spec.target.holder.visible = !spec.target.isDriver;
    spec.target = agent;
    spec.mode = 'pov';
    spec.autoT = SPECTATE.autoCycle;
    spec.lookYaw = 0;
    spec.lookPitch = 0;
    spec.camYaw = agent.yaw;
    spec.camPitch = 0;
    agent.eye(spec.eyeSmooth);
    if (!agent.isDriver) agent.holder.visible = false; // no skulls from the inside
    feed.push(`riding along with ${agent.name}`, '#7dffb0');
    spec.onChange?.(spec);
  }

  function exitPov(silent = false) {
    if (spec.mode !== 'pov') return;
    const a = spec.target;
    if (a && !a.isDriver) a.holder.visible = true;
    // step out: hover a few meters up and behind where the eyes were
    spec.pos.copy(camera.position);
    spec.pos.y += 2.5;
    spec.pos.x -= Math.sin(spec.camYaw) * 4;
    spec.pos.z -= Math.cos(spec.camYaw) * 4;
    spec.yaw = spec.camYaw + spec.lookYaw;
    spec.pitch = -0.25;
    spec.vel.set(0, 0, 0);
    spec.zoomTarget = null;
    spec.mode = 'fly';
    if (!silent) {
      feed.push('free flight', '#7dffb0');
      spec.onChange?.(spec);
    }
  }

  function cycle(dir) {
    if (!spec.roster.length || spec.mode === 'globe') return;
    const n = spec.roster.length;
    const next = spec.mode === 'pov' ? (spec.index + dir + n) % n : Math.max(0, spec.index);
    enterPov(spec.roster[next]);
  }

  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const wish = new THREE.Vector3();

  function updateFly(dt) {
    const k = spec.keys;
    const boost = k.has('ShiftLeft') || k.has('ShiftRight');
    // speed rides the altitude: walking pace at the curb, a jet over the roofs
    const scale = THREE.MathUtils.clamp(spec.pos.y / 60, 0.35, 8);
    const speed = (boost ? SPECTATE.flyBoost : SPECTATE.flySpeed) * scale;
    fwd.set(-Math.sin(spec.yaw) * Math.cos(spec.pitch), Math.sin(spec.pitch), -Math.cos(spec.yaw) * Math.cos(spec.pitch));
    right.set(Math.cos(spec.yaw), 0, -Math.sin(spec.yaw));
    wish.set(0, 0, 0);
    if (k.has('KeyW') || k.has('ArrowUp')) wish.add(fwd);
    if (k.has('KeyS') || k.has('ArrowDown')) wish.sub(fwd);
    if (k.has('KeyD') || k.has('ArrowRight')) wish.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) wish.sub(right);
    if (k.has('Space')) wish.y += 1;
    if (k.has('KeyC')) wish.y -= 1;
    if (k.has('Space') || k.has('KeyC')) spec.zoomTarget = null;
    if (wish.lengthSq() > 1) wish.normalize();
    spec.vel.lerp(wish.multiplyScalar(speed), 1 - Math.exp(-7 * dt));
    spec.pos.addScaledVector(spec.vel, dt);
    // the wheel's zoom: log-smoothed toward the asked-for altitude
    if (spec.zoomTarget !== null) {
      const ly = Math.log(Math.max(spec.pos.y, 0.1));
      spec.pos.y = Math.exp(ly + (Math.log(spec.zoomTarget) - ly) * (1 - Math.exp(-7 * dt)));
      if (Math.abs(spec.pos.y - spec.zoomTarget) < spec.zoomTarget * 0.005) spec.zoomTarget = null;
    }
    const b = CITY.bounds;
    const m = 1500; // the ground runs on past the asphalt now
    spec.pos.x = THREE.MathUtils.clamp(spec.pos.x, b.minX - m, b.maxX + m);
    spec.pos.z = THREE.MathUtils.clamp(spec.pos.z, b.minZ - m, b.maxZ + m);
    spec.pos.y = Math.max(spec.pos.y, SPECTATE.flyMinY);
    camera.position.copy(spec.pos);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(spec.yaw);
    camera.rotateX(spec.pitch);
    // past the top of the street band, GLOBE takes it from here
    if (dt > 0 && spec.pos.y > GLOBE.handoff.up) enterGlobe(spec.zoomTarget);
  }

  function updateGlobe(dt) {
    if (globeCam.update(dt, spec.keys) === 'land') {
      const s = globeCam.flyState();
      s.zoomTarget = globeCam.st.hTarget < s.pos.y ? globeCam.st.hTarget : null;
      land(s);
    }
  }

  function updatePov(dt) {
    const a = spec.target;
    if (!a) {
      exitPov();
      return;
    }
    if (spec.auto) {
      spec.autoT -= dt;
      if (spec.autoT <= 0) {
        cycle(1);
        return;
      }
    }
    // follow the agent's heading, critically damped; a driver's view turns
    // with the car, a walker's head leads the body a little
    let d = (a.yaw - spec.camYaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    spec.camYaw += d * (1 - Math.exp(-(a.isDriver ? 9 : 6) * dt));
    a.eye(spec.eye);
    spec.eyeSmooth.lerp(spec.eye, 1 - Math.exp(-(a.isDriver ? 30 : 18) * dt));
    camera.position.copy(spec.eyeSmooth);
    // the model's +Z is its face; the camera looks down -Z, so turn around
    camera.rotation.set(0, 0, 0);
    camera.rotateY(spec.camYaw + Math.PI + spec.lookYaw);
    camera.rotateX(spec.lookPitch);
    // free-look drifts back to center while nobody's steering it
    if (!spec.locked || (Math.abs(spec.lookYaw) < 0.02 && Math.abs(spec.lookPitch) < 0.02)) return;
    spec.lookYaw *= Math.exp(-0.35 * dt);
    spec.lookPitch *= Math.exp(-0.35 * dt);
  }

  return {
    spec,
    globeCam,
    get mode() { return spec.mode; },
    get target() { return spec.target; },
    get locked() { return spec.locked; },
    get busy() { return globeCam.busy; },
    // the heading the minimap should point up
    get viewYaw() {
      if (spec.mode === 'fly') return spec.yaw;
      if (spec.mode === 'globe') return globeCam.heading;
      return spec.camYaw + Math.PI + spec.lookYaw;
    },
    lock() { if (!isTouch) canvas.requestPointerLock?.(); },
    setRoster(list) { spec.roster = list; },
    setLanding(p) {
      landing = p;
      globeCam.setFocus(p);
    },
    enterPov,
    exitPov,
    cycle,
    ascend,
    dive,
    establishing,
    enterGlobe,
    // start parked in orbit (the intro), or at an altitude above the landing
    startInOrbit(h = GLOBE.orbitAlt) {
      const s = GLOBE.sites[0].landing;
      // start east of the city so it's on the near side, turning toward you
      globeCam.enterFrom(new THREE.Vector3(s.x, 1000, s.z), 0, -Math.PI / 2);
      globeCam.st.h = globeCam.st.hTarget = h;
      globeCam.st.pitchOff = 0;
      globeCam.st.idle = 10;
      if (h > GLOBE.bands.regional) {
        // 35° east along the parallel, so the beacon sits on the visible disk
        globeCam.st.q.premultiply(new THREE.Quaternion().setFromAxisAngle(NORTH_AXIS, (35 * Math.PI) / 180));
      }
      globeCam.apply();
      spec.mode = 'globe';
      spec.onChange?.(spec);
    },
    // after something else drove the globe camera (the cinematic): keep the
    // exact view, as FLY if we're low enough, GLOBE otherwise
    resumeFromGlobe() {
      globeCam.st.tween = null;
      globeCam.st.idle = 0;
      if (globeCam.st.h <= GLOBE.handoff.down) land(globeCam.flyState());
      else setMode('globe');
    },
    update(dt) {
      if (spec.mode === 'fly') updateFly(dt);
      else if (spec.mode === 'globe') updateGlobe(dt);
      else updatePov(dt);
    },
  };
}

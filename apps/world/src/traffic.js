import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VEHICLES, TRAFFIC, SPECTATE, CITY } from './config.js';
import { holoFillMaterial, holoWireMaterial, applyHoloToMesh } from './holo.js';
import { makeGlow } from './sprites.js';

// Traffic: the vehicle drop (models/vehicles, meters, front +Z) cruising the
// road cells of the baked grid. Each car paths to a far-off road cell, the
// path is pushed to the right-hand lane, and a steering model with a turn
// radius follows it: ease off in corners, queue behind slower cars, brake
// for walkers on the tarmac. Agent drivers ride inside and get the car's
// events (depart / arrive / brake / queue) to narrate.

export function createTraffic(scene, manager, nav, agentsRef) {
  const group = new THREE.Group();
  scene.add(group);

  const world = { group, cars: [], pickables: [] };

  const protos = {};
  const pending = {};
  function loadProto(key) {
    if (pending[key]) return pending[key];
    pending[key] = new Promise((resolve) => {
      new GLTFLoader(manager).load(VEHICLES[key].file, (gltf) => {
        const root = gltf.scene;
        root.traverse((o) => {
          if (!o.isMesh) return;
          o.frustumCulled = true;
          const m = o.material;
          if (m && m.transparent) {
            m.depthWrite = false;
            m.opacity = Math.min(m.opacity, 0.55);
          }
          if (m && m.map) m.map.anisotropy = 4;
        });
        protos[key] = root;
        resolve(root);
      }, undefined, () => resolve(null));
    });
    return pending[key];
  }

  const downtown = new THREE.Vector3(CITY.downtown.x, 0, CITY.downtown.z);
  const rand = ([a, b]) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ---------------------------------------------------------------------
  // lane offset: push a centerline path to the right of travel
  // ---------------------------------------------------------------------
  const _d1 = new THREE.Vector3();
  const _d2 = new THREE.Vector3();
  function laneify(path) {
    if (!path || path.length < 2) return path;
    const out = [];
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      _d1.set(0, 0, 0);
      if (i > 0) _d1.add(_d2.subVectors(p, path[i - 1]).normalize());
      if (i < path.length - 1) _d1.add(_d2.subVectors(path[i + 1], p).normalize());
      if (_d1.lengthSq() < 1e-6) {
        out.push(p.clone());
        continue;
      }
      _d1.normalize();
      // right of travel (y-up, forward (sin yaw, 0, cos yaw)): (-dz, 0, dx)
      const rx = -_d1.z;
      const rz = _d1.x;
      let off = TRAFFIC.laneOffset;
      let q = null;
      while (off > 0.4) {
        const x = p.x + rx * off;
        const z = p.z + rz * off;
        if (nav.isRoad(x, z)) {
          q = new THREE.Vector3(x, 0, z);
          break;
        }
        off -= 0.8;
      }
      out.push(q ?? p.clone());
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // cars
  // ---------------------------------------------------------------------
  function buildCar(key, proto, { driver = null } = {}) {
    const def = VEHICLES[key];
    const holder = new THREE.Group();
    const model = proto.clone();
    holder.add(model);
    group.add(holder);

    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    model.position.y = -box.min.y;

    const wheels = [];
    model.traverse((o) => {
      if (o.isMesh && /wheel|tire/i.test(o.name)) wheels.push(o);
    });

    // lights: headlight / taillight glows, plus a roof bar for sirens
    const fz = box.max.z - 0.1;
    const bz = box.min.z + 0.1;
    const lightY = 0.75;
    const hx = size.x * 0.36;
    const head = [makeGlow(0xfff4d0, 0.9, 0.9), makeGlow(0xfff4d0, 0.9, 0.9)];
    head[0].position.set(-hx, lightY, fz);
    head[1].position.set(hx, lightY, fz);
    const tail = [makeGlow(0xff3030, 0.55, 0.8), makeGlow(0xff3030, 0.55, 0.8)];
    tail[0].position.set(-hx, lightY, bz);
    tail[1].position.set(hx, lightY, bz);
    [...head, ...tail].forEach((s) => holder.add(s));
    let siren = null;
    if (def.siren) {
      siren = [makeGlow(0xff2020, 1.3, 0), makeGlow(0x2060ff, 1.3, 0)];
      siren[0].position.set(-0.35, size.y + 0.15, 0);
      siren[1].position.set(0.35, size.y + 0.15, 0);
      siren.forEach((s) => holder.add(s));
    }

    const hitProxy = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y, size.z),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hitProxy.position.y = size.y / 2;
    holder.add(hitProxy);

    const spawn = nav.randomCell(0, downtown, CITY.downtown.radius, 2) ?? downtown.clone();
    const car = {
      key,
      def,
      holder,
      model,
      wheels,
      head,
      tail,
      siren,
      sirenOn: !!def.siren && Math.random() < 0.35,
      size,
      driver,
      pos: spawn.clone(),
      yaw: Math.random() * Math.PI * 2,
      speed: 0,
      cruise: rand(def.slow ? TRAFFIC.slowSpeed : TRAFFIC.speed),
      targetSpeed: 0,
      path: [],
      dest: null,
      destLabel: null,
      waitT: 0,
      state: 'plan',
      events: [],
      queuedT: 0,
      brakeCd: 0,
      hitMeshes: [hitProxy],
      get prompt() {
        return driver
          ? `${driver.name} · ${driver.role} · ${driver.thought} — CLICK TO RIDE ALONG`
          : `${key.toUpperCase()} · ambient traffic · ${this.speed.toFixed(0)} m/s`;
      },
      onActivate: null,
      // the driver's eye, in world space
      seat(out = new THREE.Vector3()) {
        out.set(SPECTATE.seat.x, SPECTATE.seat.y, Math.min(SPECTATE.seat.z, size.z * 0.5 - 0.6));
        return holder.localToWorld(out);
      },
    };
    holder.position.copy(car.pos);
    holder.rotation.y = car.yaw;
    if (driver) driver.car = car;
    world.cars.push(car);
    world.pickables.push(car);
    if (holoOn) holoCar(car, true);
    return car;
  }

  world.spawnCar = async (key, opts) => {
    const proto = await loadProto(key);
    if (!proto) return null;
    return buildCar(key, proto, opts);
  };

  // ambient fleet
  (async () => {
    const keys = TRAFFIC.ambientPool;
    await Promise.all(keys.map(loadProto));
    for (let i = 0; i < TRAFFIC.ambient; i++) {
      const key = keys[i % keys.length];
      if (protos[key]) buildCar(key, protos[key]);
    }
  })();

  // ---------------------------------------------------------------------
  // planning
  // ---------------------------------------------------------------------
  let planBudget = 0; // one A* per frame keeps the frame time flat
  function plan(car) {
    const far = 160 + Math.random() * 420;
    let target = null;
    let label = null;
    const poi = Math.random() < 0.6 ? nav.randomPoi(car.pos, far) : null;
    if (poi) {
      target = nav.nearestCell(0, poi.center.clone().add(new THREE.Vector3((Math.random() - 0.5) * poi.size, 0, (Math.random() - 0.5) * poi.size)), 40);
      label = poi.label;
    }
    if (!target) {
      target = nav.randomCell(0, car.pos.distanceTo(downtown) > CITY.downtown.radius * 1.3 ? downtown : car.pos, far, 2);
      label = pick(['the far side of town', 'the next district', 'the ring road', 'the waterfront', 'uptown']);
    }
    if (!target) return false;
    const raw = nav.pathDrive(car.pos, target);
    if (!raw || raw.length < 2) return false;
    car.path = laneify(raw).slice(1);
    car.dest = target;
    car.destLabel = label;
    car.state = 'drive';
    // narrate only real departures — an off-road replan a few meters on is noise
    if (!car.lastDepart || car.lastDepart.distanceTo(car.pos) > 25) car.events.push({ type: 'depart', label });
    car.lastDepart = car.pos.clone();
    return true;
  }

  // ---------------------------------------------------------------------
  // steering
  // ---------------------------------------------------------------------
  const TURN_RADIUS = 5.5;
  const _fwd = new THREE.Vector3();
  const _to = new THREE.Vector3();

  function carAhead(car) {
    _fwd.set(Math.sin(car.yaw), 0, Math.cos(car.yaw));
    let best = null;
    let bd = TRAFFIC.followGap + car.size.z;
    for (const o of world.cars) {
      if (o === car) continue;
      _to.subVectors(o.pos, car.pos);
      const d = _to.length();
      if (d > bd) continue;
      const along = _to.dot(_fwd) / d;
      if (along < 0.86) continue; // not in my lane cone
      // lateral check: within ~a lane
      const lateral = Math.abs(_to.x * _fwd.z - _to.z * _fwd.x);
      if (lateral > 2.4) continue;
      bd = d;
      best = o;
    }
    return best;
  }

  function walkerAhead(car) {
    const agents = agentsRef.current?.agents;
    if (!agents) return null;
    _fwd.set(Math.sin(car.yaw), 0, Math.cos(car.yaw));
    for (const a of agents) {
      if (a.isDriver) continue;
      _to.subVectors(a.pos, car.pos);
      const d = _to.length();
      if (d > TRAFFIC.pedBrake + car.size.z * 0.5 || d < 0.1) continue;
      if (_to.dot(_fwd) / d < 0.8) continue;
      const lateral = Math.abs(_to.x * _fwd.z - _to.z * _fwd.x);
      if (lateral > 2.6) continue;
      if (!nav.isRoad(a.pos.x, a.pos.z)) continue;
      return a;
    }
    return null;
  }

  function updateCar(car, dt) {
    switch (car.state) {
      case 'plan': {
        car.targetSpeed = 0;
        if (planBudget > 0) {
          planBudget--;
          if (!plan(car)) car.waitT = 0.5;
        }
        break;
      }
      case 'wait': {
        car.waitT -= dt;
        car.targetSpeed = 0;
        if (car.waitT <= 0) car.state = 'plan';
        break;
      }
      case 'drive': {
        const next = car.path[0];
        if (!next) {
          car.state = 'wait';
          car.waitT = 2 + Math.random() * 4;
          car.events.push({ type: 'arrive', label: car.destLabel });
          break;
        }
        const dx = next.x - car.pos.x;
        const dz = next.z - car.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < Math.max(2.2, car.speed * 0.25)) {
          car.path.shift();
          break;
        }
        const want = Math.atan2(dx, dz);
        let diff = (want - car.yaw) % (Math.PI * 2);
        if (diff > Math.PI) diff -= Math.PI * 2;
        if (diff < -Math.PI) diff += Math.PI * 2;
        // corner speed from the upcoming bend, then follow / brake rules
        let target = car.cruise * (Math.abs(diff) > 0.9 ? 0.3 : Math.abs(diff) > 0.4 ? 0.55 : 1);
        const ahead = carAhead(car);
        if (ahead) {
          const gap = ahead.pos.distanceTo(car.pos) - car.size.z * 0.5 - ahead.size.z * 0.5;
          target = Math.min(target, gap < 2.5 ? 0 : Math.min(ahead.speed, target) * Math.min(1, gap / TRAFFIC.followGap));
          car.queuedT += dt;
          if (car.queuedT > 6) {
            car.queuedT = -14;
            car.events.push({ type: 'queue' });
          }
        } else car.queuedT = Math.max(0, car.queuedT - dt);
        const walker = walkerAhead(car);
        if (walker) {
          target = 0;
          car.brakeCd -= dt;
          if (car.brakeCd <= 0) {
            car.brakeCd = 8;
            car.events.push({ type: 'brake' });
          }
        }
        car.targetSpeed = target;
        // yaw rate bounded by the turn radius at the current speed
        const maxRate = Math.max(0.9, car.speed / TURN_RADIUS);
        const step = THREE.MathUtils.clamp(diff * 4, -maxRate, maxRate) * dt;
        car.yaw += step;
        break;
      }
      default:
        break;
    }
    // speed easing: brisk brakes, gentle throttle
    const accel = car.targetSpeed < car.speed ? 11 : 4;
    car.speed += THREE.MathUtils.clamp(car.targetSpeed - car.speed, -accel * dt, accel * dt);
    car.pos.x += Math.sin(car.yaw) * car.speed * dt;
    car.pos.z += Math.cos(car.yaw) * car.speed * dt;
    // stay on the tarmac: a car that slides onto the curb replans
    if (car.state === 'drive' && !nav.isRoad(car.pos.x, car.pos.z)) {
      const back = nav.nearestCell(0, car.pos, 8) ?? nav.randomCell(0, downtown, CITY.downtown.radius, 2);
      if (back) car.pos.copy(back);
      car.speed = 0;
      car.state = 'plan';
      car.path = [];
    }

    car.holder.position.copy(car.pos);
    car.holder.rotation.y = car.yaw;
    const spin = (car.speed / 0.34) * dt;
    for (const w of car.wheels) w.rotation.x += spin;
    const braking = car.targetSpeed < car.speed - 0.5;
    car.tail.forEach((t) => { t.material.opacity = braking ? 1 : 0.55; t.scale.setScalar(braking ? 0.8 : 0.55); });
  }

  // siren strobe + helpers --------------------------------------------------
  let t = 0;
  world.update = (dt) => {
    t += dt;
    planBudget = 1;
    for (const car of world.cars) {
      updateCar(car, dt);
      if (car.siren) {
        const on = car.sirenOn;
        const phase = Math.floor(t * 6) % 2;
        car.siren[0].material.opacity = on && phase === 0 ? 1 : 0;
        car.siren[1].material.opacity = on && phase === 1 ? 1 : 0;
      }
    }
  };

  world.carNear = (p, r) => {
    let best = null;
    let bd = r;
    for (const car of world.cars) {
      const d = car.pos.distanceTo(p);
      if (d < bd + car.size.z * 0.25) {
        bd = d;
        best = car;
      }
    }
    return best;
  };

  // hologram toggle (H) — also applied to cars that spawn while it's on
  let holoOn = false;
  let holoMats = null;
  const originals = new Map();
  function holoCar(car, on) {
    if (!holoMats) {
      holoMats = {
        fill: holoFillMaterial(0x9fffe0, { intensity: 0.2, base: 0.12 }),
        wire: holoWireMaterial(0x9fffe0, 0.3),
        // windows stay see-through, or the driver's POV is a wall of fill
        glass: new THREE.MeshBasicMaterial({ color: 0x9fffe0, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }),
      };
    }
    // an agent's ride glows in their color so it reads from the air
    if (car.driver && !car.holoFill) car.holoFill = holoFillMaterial(car.driver.tint, { intensity: 0.3, base: 0.14 });
    const fillFor = (o) => ((originals.get(o) ?? o.material)?.transparent ? holoMats.glass : (car.holoFill ?? holoMats.fill));
    const meshes = [];
    car.model.traverse((o) => { if (o.isMesh && !originals.has(o) && o.material !== holoMats.wire) meshes.push(o); else if (o.isMesh && originals.has(o)) meshes.push(o); });
    meshes.forEach((o) => {
        if (!o.isMesh) return;
        if (on) {
          if (!originals.has(o)) {
            originals.set(o, o.material);
            if (o.material.transparent) o.material = holoMats.glass; // no wire over glass
            else applyHoloToMesh(o, fillFor(o), holoMats.wire);
            o.userData.wire = o.children.find((c) => c.material === holoMats.wire) ?? null;
          } else {
            o.material = fillFor(o);
            if (o.userData.wire) o.userData.wire.visible = true;
          }
        } else if (originals.has(o)) {
          o.material = originals.get(o);
          if (o.userData.wire) o.userData.wire.visible = false;
        }
    });
  }
  world.setHologram = (on) => {
    holoOn = on;
    for (const car of world.cars) holoCar(car, on);
  };

  return world;
}

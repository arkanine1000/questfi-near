import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { AGENTS, RIGS, SIM, SPECTATE, CITY } from './config.js';
import { applyHoloToRig } from './holo.js';
import { createPoser } from './poser.js';
import { makeTextSprite, makeBeacon, makeRing, css } from './sprites.js';

// The roster: real low-poly character rigs (models/npcs) living in the city.
// Walkers run errands over the sidewalk grid — pick a building, path there,
// loiter, think out loud — and flinch when traffic brushes past. Drivers
// hand their body to a car (traffic.js) and narrate the ride. Every agent
// exposes the same small surface (pos / yaw / eye() / thought / log) so the
// spectator and, later, an external agent-connect loop can plug in.
//
// Animation: the animal FBX files ship real idle/walk clips and run on a
// mixer. The human files only animate their hand props (the skeleton keys
// are flat), so humans are posed procedurally (see poser.js): a calibrated
// walk cycle, breathing idle, a panic flail and a dance, blended by state.

const N = 'models/npcs/';

const IDLE_LINES = {
  default: ['Taking in the skyline', 'Checking the map', 'Waiting for the light', 'People-watching', 'Reading the street signs', 'Catching my breath'],
  courier: ['Checking the drop list', 'Package is late. Again.', 'Shortcut through the alley?', 'Where is unit 4B'],
  'beat cop': ['Scanning the block', 'All quiet here', 'Noting a plate', 'Radio check'],
  firefighter: ['Hydrant check', 'Off duty, finally', 'Smells like smoke? No.', 'Stretching out'],
  analyst: ['Running the numbers', 'Market opens soon', 'Need coffee', 'That chart was wrong'],
  tourist: ['Taking a photo', 'Which way is the museum?', 'This city is huge', 'Lost, happily'],
  partygoer: ['Where is the party', 'Pre-game at the park?', 'Found the beat', 'Toga check'],
  'site foreman': ['Inspecting the scaffold', 'Where is my crew', 'Permits, permits', 'Counting pallets'],
  'street vendor': ['Setting up the stall', 'Fresh produce!', 'Slow day', 'Watching the crowd'],
  student: ['Late for class', 'Earbuds in', 'Skipping lecture', 'Library run'],
  'night-shift': ['Just clocked off', 'So tired', 'Breakfast at 9pm', 'Sun is too bright'],
  'escaped exhibit': ['Free at last', 'Sniffing the air', 'Too many humans', 'Where is the zoo gate'],
};
const PANIC_LINES = ['Whoa! Watch it!', 'That was close', 'Hey, I am walking here!', 'Nearly flattened'];

export function createAgents(scene, manager, nav, traffic, feed) {
  const group = new THREE.Group();
  scene.add(group);

  const world = {
    group,
    agents: [],
    pickables: [],
    ready: false,
    viewer: new THREE.Vector3(), // camera position, fed by main each frame
    venues: [], // venue pads join the errand pool (main sets this)
  };

  // ---------------------------------------------------------------------
  // rig loading: one FBX per model, cloned per agent; textures redirected
  // ---------------------------------------------------------------------
  const texByDir = {};
  AGENTS.forEach((a) => { texByDir[a.model] = a.tex; });
  manager.setURLModifier((url) => {
    // the FBX files reference their color map by an authoring-time path —
    // route anything image-shaped under an npc folder to its shipped texture
    const m = url.match(/models\/npcs\/([^/]+)\/([^/]+)$/);
    if (m && /\.(png|jpe?g|tga|bmp|tif|dds)$/i.test(m[2]) && texByDir[m[1]] && m[2] !== texByDir[m[1]]) {
      return url.replace(m[2], texByDir[m[1]]);
    }
    return url;
  });

  const sources = {}; // model dir → { root, clips }
  const pending = {};
  function loadRig(dir) {
    if (pending[dir]) return pending[dir];
    pending[dir] = new Promise((resolve) => {
      const loader = new FBXLoader(manager);
      loader.setResourcePath(`${N}${dir}/`);
      loader.load(`${N}${dir}/model.fbx`, (fbx) => {
        sources[dir] = { root: fbx, clips: fbx.animations ?? [] };
        resolve(sources[dir]);
      }, undefined, () => resolve(null));
    });
    return pending[dir];
  }

  // bone names minus the per-model prefix ("Farmer_Pelvis" → "Pelvis")
  function boneMap(root) {
    const bones = [];
    root.traverse((o) => { if (o.isBone) bones.push(o.name); });
    let prefix = '';
    const withUnderscore = bones.filter((b) => b.includes('_'));
    if (withUnderscore.length > bones.length * 0.6) {
      const first = withUnderscore[0].slice(0, withUnderscore[0].indexOf('_') + 1);
      if (bones.every((b) => b.startsWith(first) || !b.includes('_'))) prefix = first;
    }
    const map = new Map();
    for (const b of bones) map.set(b.startsWith(prefix) ? b.slice(prefix.length) : b, b);
    return map;
  }

  const findClip = (clips, name) => clips.find((c) => c.name === name || c.name.endsWith(`|${name}`));

  // ---------------------------------------------------------------------
  // build
  // ---------------------------------------------------------------------
  const downtown = new THREE.Vector3(CITY.downtown.x, 0, CITY.downtown.z);
  const DOWNTOWN_R = CITY.downtown.radius;

  async function build() {
    const dirs = [...new Set(AGENTS.map((a) => a.model))];
    await Promise.all(dirs.map(loadRig));

    AGENTS.forEach((def, i) => {
      const src = sources[def.model];
      if (!src) return;
      spawnAgent(def, i, src);
    });
    world.ready = true;
    feed.push(`${world.agents.length} agents online`, '#7dffb0');
  }
  build();

  function spawnAgent(def, i, src) {
    const rig = skeletonClone(src.root);
    const holder = new THREE.Group();
    holder.add(rig);
    group.add(holder);
    rig.rotation.y = RIGS.faceFix ?? 0;

    // materials: the FBX ships phong + the redirected color map; rebuild as
    // standard so the night lighting reads, and keep the originals for H
    const orig = new Map();
    const skinned = [];
    rig.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const rebuilt = mats.map((m) => new THREE.MeshStandardMaterial({
        map: m.map ?? null,
        color: m.map ? 0xffffff : (m.color ?? new THREE.Color(0xbbbbbb)),
        roughness: 0.85,
        metalness: 0,
        emissive: 0xffffff,
        emissiveMap: m.map ?? null,
        emissiveIntensity: m.map ? 0.22 : 0, // a touch of self-light so faces read at night
      }));
      if (rebuilt[0].map) rebuilt[0].map.colorSpace = THREE.SRGBColorSpace;
      o.material = Array.isArray(o.material) ? rebuilt : rebuilt[0];
      o.frustumCulled = false;
      o.castShadow = false;
      orig.set(o, o.material);
      if (o.isSkinnedMesh) skinned.push(o);
    });

    // true authored scale is meters already; just plant the feet on y=0
    const box = new THREE.Box3().setFromObject(rig);
    rig.position.y = -box.min.y;
    const height = box.max.y - box.min.y;

    // animals: real clips on a mixer. humans: the procedural poser, calibrated
    // against the rest pose before the holder gets its spawn yaw
    const mixer = new THREE.AnimationMixer(rig);
    const actions = {};
    let poser = null;
    if (def.kind === 'human') {
      poser = createPoser(rig, boneMap(rig));
    } else {
      for (const [role, clipName] of Object.entries(RIGS.animalClips)) {
        const c = findClip(src.clips, clipName);
        if (c && c.duration > 0.1) actions[role] = mixer.clipAction(c);
      }
    }

    const headBone = (() => {
      let h = null;
      rig.traverse((o) => { if (o.isBone && !h && /head$/i.test(o.name)) h = o; });
      return h;
    })();

    const tag = makeTextSprite(def.name, css(def.tint));
    tag.position.y = height + 0.38;
    holder.add(tag);
    // a light beacon + pulsing ground ring: the GTA blip, in world space
    const beacon = makeBeacon(def.tint, 34, 0.13);
    beacon.position.y = height + 0.6;
    holder.add(beacon);
    const ring = makeRing(def.tint, 0.9);
    ring.position.y = 0.04;
    holder.add(ring);

    const hitProxy = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(0.8, height * 0.5), height + 0.2, Math.max(0.8, height * 0.5)),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hitProxy.position.y = (height + 0.2) / 2;
    holder.add(hitProxy);

    // spawn on a downtown sidewalk
    const start = nav.randomCell(1, downtown, DOWNTOWN_R * 0.6, 1) ?? downtown.clone();

    const a = {
      def,
      i,
      name: def.name,
      role: def.role,
      tint: def.tint,
      kind: def.kind,
      holder,
      rig,
      mixer,
      actions,
      poser,
      orig,
      skinned,
      holo: null,
      headBone,
      height,
      tag,
      beacon,
      ring,
      hitMeshes: [hitProxy],
      pos: start.clone(),
      yaw: Math.random() * Math.PI * 2,
      vel: new THREE.Vector3(),
      speed: def.speed ?? 1.3,
      state: 'idle',
      stateT: rand(SIM.idleTime) * Math.random(),
      path: [],
      dest: null,
      destLabel: null,
      thought: 'Booting up',
      log: [],
      current: null,
      panicCd: 0,
      car: null,
      isDriver: !!def.driver,
      get prompt() {
        return `${def.name} · ${def.role} · ${this.thought} — CLICK TO RIDE ALONG`;
      },
      onActivate: null, // main.js wires the spectator in
      // --- the agent surface -------------------------------------------
      eye(out = new THREE.Vector3()) {
        if (this.car) return this.car.seat(out);
        if (this.headBone && this.holder.visible) {
          this.headBone.getWorldPosition(out);
          out.y += 0.05;
        } else {
          out.set(this.pos.x, this.pos.y + Math.min(this.height * 0.93, SPECTATE.eyeHeight), this.pos.z);
        }
        out.x += Math.sin(this.yaw) * 0.12;
        out.z += Math.cos(this.yaw) * 0.12;
        return out;
      },
      think(text, color) {
        this.thought = text;
        this.log.unshift({ t: performance.now() / 1000, text });
        this.log.length = Math.min(this.log.length, 8);
        feed.push(`${this.name}: ${text}`, color ?? css(this.tint));
        shout(this, text, color ?? css(this.tint));
      },
    };
    holder.position.copy(a.pos);
    holder.rotation.y = a.yaw;
    play(a, 'idle');
    if (a.actions.idle) a.actions.idle.time = Math.random() * 5;

    world.agents.push(a);
    world.pickables.push(a);
    if (holoOn) holoAgent(a, true);

    if (a.isDriver) {
      traffic.spawnCar(def.driver, { driver: a });
      a.state = 'drive';
      holder.visible = false;
      a.think(`Rolling out in the ${def.driver}`);
    } else {
      a.think(IDLE_LINES.default[Math.floor(Math.random() * IDLE_LINES.default.length)]);
    }
  }

  const rand = ([a, b]) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // thoughts float up off the agent's head for a moment, like the fps shouts
  const shouts = [];
  function shout(a, text, colorCss) {
    if (!world.ready) return;
    const sp = makeTextSprite(text, colorCss, { width: 3.2, font: '600 30px "Chakra Petch", monospace' });
    const y = a.car ? a.car.size.y + 0.9 : a.height + 0.9;
    sp.position.set(a.pos.x, a.pos.y + y, a.pos.z);
    group.add(sp);
    shouts.push({ sp, a, t: 3.2, y });
  }

  function play(a, name, { once = false, fade = 0.25, speed = 1 } = {}) {
    if (a.poser) {
      a.current = name;
      a.poser.set(name, speed);
      return a.poser.duration(name);
    }
    const action = a.actions[name] ?? a.actions.idle;
    if (!action) return 0;
    const key = a.actions[name] ? name : 'idle';
    if (a.current === key) {
      action.timeScale = speed;
      return action.getClip().duration / speed;
    }
    const prev = a.current && a.actions[a.current];
    a.current = key;
    action.reset();
    action.timeScale = speed;
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    action.clampWhenFinished = once;
    action.play();
    if (prev && prev !== action) prev.crossFadeTo(action, fade, false);
    return action.getClip().duration / speed;
  }

  // ---------------------------------------------------------------------
  // errands
  // ---------------------------------------------------------------------
  function pickErrand(a) {
    const range = rand(SIM.wanderRange);
    let target = null;
    let label = null;
    let line = null;
    if (world.venues?.length && Math.random() < SIM.venueChance) {
      const v = pick(world.venues);
      if (v.pad.distanceTo(a.pos) < 420) {
        target = v.pad.clone();
        label = v.label;
        line = pick(v.def.visit);
      }
    }
    if (!target && Math.random() < SIM.poiChance) {
      const poi = nav.randomPoi(a.pos, range);
      if (poi) {
        const edge = nav.nearestCell(1, poi.center.clone().add(new THREE.Vector3((Math.random() - 0.5) * poi.size, 0, (Math.random() - 0.5) * poi.size)), 30);
        if (edge) {
          target = edge;
          label = poi.label;
        }
      }
    }
    if (!target) {
      // keep the roster downtown-ish so the cycle never lands in the suburbs
      const center = a.pos.distanceTo(downtown) > DOWNTOWN_R ? downtown : a.pos;
      target = nav.randomCell(1, center, range, 1);
      label = pick(['the corner', 'the next block', 'a quieter street', 'the crossing', 'the plaza']);
    }
    if (!target) return false;
    const path = nav.pathWalk(a.pos, target);
    if (!path || path.length < 2) return false;
    a.path = path.slice(1);
    a.dest = target;
    a.destLabel = label;
    a.state = 'walk';
    a.think(line ?? pick(['Heading to', 'Walking over to', 'Off to', 'Making my way to']) + ` ${label}`);
    play(a, 'walk', { speed: a.speed / SIM.walkSpeed });
    return true;
  }

  function faceYaw(a, targetYaw, dt, rate = 6) {
    let d = (targetYaw - a.yaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    a.yaw += d * (1 - Math.exp(-rate * dt));
  }

  function arrive(a) {
    const poi = a.destLabel;
    a.path = [];
    if (a.def.role === 'partygoer' && Math.random() < SIM.danceChance * 3 && (a.poser || a.actions.dance)) {
      a.state = 'dance';
      a.stateT = 6 + Math.random() * 6;
      a.think('Found the beat — dancing');
      play(a, 'dance');
      return;
    }
    if (Math.random() < SIM.danceChance && (a.poser || a.actions.dance)) {
      a.state = 'dance';
      a.stateT = 4 + Math.random() * 5;
      a.think(`Arrived at ${poi}. Why not dance`);
      play(a, 'dance');
      return;
    }
    a.state = 'idle';
    a.stateT = rand(SIM.idleTime);
    a.think(`Arrived at ${poi}. ` + pick(IDLE_LINES[a.def.role] ?? IDLE_LINES.default));
    play(a, 'idle');
  }

  function updateWalker(a, dt) {
    a.panicCd -= dt;
    // traffic brushing past startles anyone on foot
    if (a.panicCd <= 0 && a.state !== 'panic' && (a.poser || a.actions.panic)) {
      const near = traffic.carNear(a.pos, SIM.panicRadius);
      if (near && near.speed > 3) {
        a.state = 'panic';
        a.stateT = 2.2;
        a.panicCd = 12;
        a.think(pick(PANIC_LINES), '#ff8a6a');
        play(a, 'panic', { fade: 0.12 });
      }
    }

    switch (a.state) {
      case 'idle': {
        a.stateT -= dt;
        if (a.stateT <= 0 && !pickErrand(a)) a.stateT = 1.5;
        break;
      }
      case 'walk': {
        const next = a.path[0];
        if (!next) {
          arrive(a);
          break;
        }
        const dx = next.x - a.pos.x;
        const dz = next.z - a.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.6) {
          a.path.shift();
          break;
        }
        const want = Math.atan2(dx, dz);
        faceYaw(a, want, dt, 7);
        // slow into sharp turns so the feet don't skate
        let turn = Math.abs(((want - a.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const sp = a.speed * (turn > 1.2 ? 0.35 : 1);
        a.pos.x += Math.sin(a.yaw) * sp * dt;
        a.pos.z += Math.cos(a.yaw) * sp * dt;
        if (a.actions.walk) a.actions.walk.timeScale = sp / SIM.walkSpeed;
        if (a.poser) a.poser.setSpeed(sp / SIM.walkSpeed);
        // crossing commentary
        if (nav.isRoad(a.pos.x, a.pos.z) && !a.onRoad) {
          a.onRoad = true;
          if (Math.random() < 0.5) a.think(pick(['Crossing here', 'Looking both ways', 'Jaywalking, sorry']));
        } else if (!nav.isRoad(a.pos.x, a.pos.z)) a.onRoad = false;
        break;
      }
      case 'dance':
      case 'panic': {
        a.stateT -= dt;
        if (a.stateT <= 0) {
          if (a.path.length) {
            a.state = 'walk';
            play(a, 'walk', { speed: a.speed / SIM.walkSpeed });
            a.think(`Back on the way to ${a.destLabel}`);
          } else {
            a.state = 'idle';
            a.stateT = rand(SIM.idleTime);
            play(a, 'idle');
          }
        }
        break;
      }
      default:
        break;
    }
    a.holder.position.copy(a.pos);
    a.holder.rotation.y = a.yaw;
  }

  function updateDriver(a, dt) {
    const car = a.car;
    if (!car) return;
    a.pos.copy(car.pos);
    a.yaw = car.yaw;
    // narrate the ride off the car's events
    while (car.events.length) {
      const ev = car.events.shift();
      if (ev.type === 'depart') {
        const lines = {
          cabbie: [`Fare to ${ev.label}`, `Taking a passenger to ${ev.label}`],
          'patrol unit': [`Patrol route toward ${ev.label}`, `Cruising past ${ev.label}`],
          delivery: [`Delivery run to ${ev.label}`, `Next drop: ${ev.label}`],
          joyrider: [`Let's see how fast we get to ${ev.label}`, `Burning rubber toward ${ev.label}`],
        };
        a.think(pick(lines[a.def.role] ?? [`Driving to ${ev.label}`]));
      } else if (ev.type === 'arrive') {
        a.think(pick([`Arrived at ${ev.label}`, `Pulling over at ${ev.label}`, `Here we are: ${ev.label}`]));
      } else if (ev.type === 'brake') {
        a.think(pick(['Pedestrian! Braking', 'Easy… someone is crossing', 'Hold up, walker ahead']), '#ff8a6a');
      } else if (ev.type === 'queue') {
        a.think(pick(['Stuck behind this guy', 'Traffic. Great.', 'Come on, move']));
      }
    }
  }

  // ---------------------------------------------------------------------
  // hologram toggle (H): the house wireframe look over every rig
  // ---------------------------------------------------------------------
  let holoOn = false;
  function holoAgent(a, on) {
    {
      if (on && !a.holo) {
        a.holo = applyHoloToRig(a.rig, a.tint);
        a.holoWires = [];
        a.rig.traverse((o) => { if (o.isSkinnedMesh && o.material === a.holo.wireMat) a.holoWires.push(o); });
      } else if (on) {
        for (const [mesh, mat] of a.orig) mesh.material = a.holo.fillMat;
        a.holoWires.forEach((w) => { w.visible = true; });
      } else if (a.holo) {
        for (const [mesh, mat] of a.orig) mesh.material = mat;
        a.holoWires.forEach((w) => { w.visible = false; });
      }
    }
  }
  world.setHologram = (on) => {
    holoOn = on;
    for (const a of world.agents) holoAgent(a, on);
  };

  world.update = (dt, t) => {
    for (let i = shouts.length - 1; i >= 0; i--) {
      const sh = shouts[i];
      sh.t -= dt;
      sh.sp.position.set(sh.a.pos.x, sh.a.pos.y + sh.y + (3.2 - sh.t) * 0.35, sh.a.pos.z);
      sh.sp.material.opacity = Math.min(1, sh.t * 0.8);
      if (sh.t <= 0) {
        group.remove(sh.sp);
        sh.sp.material.map.dispose();
        sh.sp.material.dispose();
        shouts.splice(i, 1);
      }
    }
    const pulse = 0.55 + 0.45 * Math.sin(t * 3.2);
    for (const a of world.agents) {
      a.ring.material.opacity = 0.25 + 0.35 * pulse;
      a.ring.scale.setScalar(1 + 0.18 * pulse);
      // the beacon is an air-side aid: it fades as the viewer closes in
      const d = world.viewer.distanceTo(a.pos);
      a.beacon.material.opacity = 0.42 * THREE.MathUtils.smoothstep(d, 12, 60);
      if (a.poser) a.poser.update(dt);
      else a.mixer.update(dt);
      if (a.isDriver) updateDriver(a, dt);
      else updateWalker(a, dt);
    }
  };

  // the spectated agent's own blip would sit on the camera - hide it, and
  // move a driver's beacon onto their car
  world.setSpectated = (target) => {
    for (const a of world.agents) {
      const own = a === target;
      a.beacon.visible = !own;
      a.ring.visible = !own && !a.isDriver;
      if (a.isDriver && a.car && a.beacon.parent !== a.car.holder) {
        a.car.holder.add(a.beacon);
        a.beacon.position.y = a.car.size.y + 0.5;
      }
    }
  };

  return world;
}

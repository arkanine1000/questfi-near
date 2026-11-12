import './seed.js'; // first: ?cinematic seeds Math.random before anything rolls dice
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { COLORS, CITY, SPECTATE, SIM, LITE } from './config.js';
import { loadNav } from './nav.js';
import { createCity } from './city.js';
import { createTraffic } from './traffic.js';
import { createAgents } from './agents.js';
import { createSpectator } from './spectate.js';
import { createRain } from './rain.js';
import { createRadar } from './radar.js';
import { createVenues } from './venues.js';
import { createLauncher } from './launcher.js';
import { css } from './sprites.js';
import { R, altitudeOf, bandOf } from './globe/geo.js';
import { GLOBE } from './config.js';
const GLOBE_SITES = GLOBE.sites.length;
import { createDebug } from './debug.js';
import { createGlobe } from './globe/globe.js';
import { bandWeights } from './globe/bands.js';
import { createImpostor } from './globe/impostor.js';
import { createBeacons } from './globe/beacon.js';
import { createOutskirts } from './globe/outskirts.js';
import { createTitle } from './globe/title.js';
import { createCinematic } from './globe/cinematic.js';

// ---------------------------------------------------------------------------
// renderer / scene
// ---------------------------------------------------------------------------
const params0 = new URLSearchParams(location.search);
const canvas = document.getElementById('scene');
// log depth: one buffer has to hold a POV eye 10 cm from a windshield and a
// planet 15,000 km away — see GLOBE_ZOOM_SPEC.md
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: !params0.has('nologdepth') });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, LITE ? 1 : 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x030a10);
scene.fog = new THREE.FogExp2(0x04101a, CITY.fogDensity);

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, CITY.far);

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------
const manager = new THREE.LoadingManager();
const loadFill = document.getElementById('loadbar-fill');
const loadNote = document.getElementById('loadnote');
const enterBtn = document.getElementById('enter');
manager.onProgress = (url, loaded, total) => {
  loadFill.style.width = `${Math.round((loaded / total) * 100)}%`;
  loadNote.textContent = /city\.glb/.test(url) ? 'STREAMING THE CITY (40 MB)…' : `${loaded} / ${total} · ${url.split('/').pop().toUpperCase()}`;
};
// ENTER waits for the assets AND the shader warm-up, so the dive never hitches
let loaded = false;
let warmed = false;
function tryReady() {
  if (!loaded || !warmed) return;
  loadFill.style.width = '100%';
  loadNote.textContent = 'READY';
  enterBtn.disabled = false;
  enterBtn.textContent = 'ENTER THE CITY';
}
manager.onLoad = () => {
  loaded = true;
  loadNote.textContent = 'WARMING THE PROJECTORS…';
  tryReady();
};

// ---------------------------------------------------------------------------
// the feed: one shared event log, mirrored into the HUD
// ---------------------------------------------------------------------------
const feedEl = document.getElementById('feed');
const feed = {
  lines: [],
  push(text, color = '#9fffc8') {
    this.lines.unshift({ text, color, t: performance.now() });
    this.lines.length = Math.min(this.lines.length, SIM.feedLength);
    this.dirty = true;
  },
  dirty: false,
  render() {
    if (!this.dirty) return;
    this.dirty = false;
    feedEl.replaceChildren(...this.lines.map((l) => {
      const d = document.createElement('div');
      d.className = 'fd';
      d.style.color = l.color;
      d.textContent = l.text;
      return d;
    }));
  },
};

// ---------------------------------------------------------------------------
// world
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const city = createCity(scene, manager);
const globe = createGlobe(scene, manager);
const beacons = createBeacons(scene);
const outskirts = createOutskirts(scene);
const title = createTitle();

// U: hide every piece of UI for clean shots (the AGENT EARTH title stays —
// it's part of the shot). A toast says how to get it back.
const toast = document.createElement('div');
toast.id = 'ui-toast';
document.body.appendChild(toast);
let toastTimer = 0;
function setUiHidden(on) {
  document.body.classList.toggle('no-ui', on);
  toast.textContent = on ? 'UI HIDDEN · U TO SHOW' : 'UI ON';
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1400);
}
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyU' && !e.repeat) setUiHidden(!document.body.classList.contains('no-ui'));
});
const weights = bandWeights(SPECTATE.spawn.y);
const agentsRef = { current: null };
let nav = null;
let traffic = null;
let agents = null;
let venues = null;
const spectator = createSpectator(camera, canvas, feed);
const rain = createRain({ center: new THREE.Vector3(CITY.downtown.x, 0, CITY.downtown.z) });
let rainOn = params.has('rain'); // off by default — R toggles it
rain.visible = rainOn;
scene.add(rain.points);
const rainPill = document.getElementById('rain');
function setRain(on) {
  rainOn = on; // the altitude may still hold it off (no rain above the City band)
  rainPill.classList.toggle('off', !on);
}
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') setRain(!rainOn);
});
let radar = null;
let impostor = null;

loadNav(CITY.nav, manager).then((n) => {
  nav = n;
  traffic = createTraffic(scene, manager, nav, agentsRef);
  agents = createAgents(scene, manager, nav, traffic, feed);
  agentsRef.current = agents;
  for (const a of agents.agents) a.onActivate = () => spectator.enterPov(a);
  venues = createVenues(scene, nav);
  agents.venues = venues.list;
  for (const v of venues.list) v.onActivate = () => launcher.open(v);
  radar = createRadar(document.getElementById('radar'), nav);
  impostor = createImpostor(scene, nav, renderer.getPixelRatio());
  // dives frame the venues: aim the establishing shot at their middle
  if (venues.list.length) {
    const c = venues.list.reduce((m, v) => ({ x: m.x + v.pad.x / venues.list.length, z: m.z + v.pad.z / venues.list.length }), { x: 0, z: 0 });
    spectator.setLanding({ x: (c.x + CITY.downtown.x) / 2, z: (c.z + CITY.downtown.z) / 2 });
  }
  buildVenueList();
});

// the launcher: a game over the city, the city paused underneath
const launcher = createLauncher({
  onOpen: (v) => {
    feed.push(`entering ${v.name.toLowerCase()}`, css(v.tint));
    hud.classList.add('covered');
  },
  onClose: (v) => {
    feed.push(`back in the city from ${v.name.toLowerCase()}`, css(v.tint));
    hud.classList.remove('covered');
    clock.getDelta(); // swallow the paused time so the sim doesn't lurch
    spectator.lock();
  },
});

// ---------------------------------------------------------------------------
// post-processing: bloom + CRT scanlines/vignette — the house look
// ---------------------------------------------------------------------------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.45, 0.4, 0.55);
composer.addPass(bloom);

const CRTShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    grade: { value: 0.22 },
    aberration: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float grade;
    uniform float aberration;
    uniform vec2 resolution;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      // chromatic aberration: the channels drift apart toward the edges, and
      // the whole projection jolts for a frame now and then
      vec2 d = (vUv - 0.5);
      float jolt = step(0.975, hash(vec2(floor(time * 18.0), 7.0))) * 2.5;
      vec2 off = d * (0.0022 + 0.004 * jolt) * aberration;
      vec3 c = vec3(
        texture2D(tDiffuse, vUv + off).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - off).b
      );
      // hologram flicker: rare one-frame dips plus a slow rolling band
      float dip = 1.0 - 0.08 * step(0.985, hash(vec2(floor(time * 24.0), 3.0)));
      float roll = 1.0 + 0.035 * smoothstep(0.985, 1.0, 1.0 - abs(fract(vUv.y * 0.5 + time * 0.05) - 0.5) * 2.0);
      c *= dip * roll;

      // gentle green grade
      float lum = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(c, lum * vec3(0.45, 1.0, 0.62), grade);

      // scanlines
      float scan = 0.94 + 0.06 * sin(vUv.y * resolution.y * 1.8 + time * 5.0);
      c *= scan;

      // vignette
      float vig = smoothstep(1.35, 0.35, length(vUv - 0.5) * 1.7);
      c *= mix(0.55, 1.0, vig);

      // subtle noise
      c += (hash(vUv * (time + 1.0)) - 0.5) * 0.035 * vec3(0.6, 1.0, 0.7);

      gl_FragColor = vec4(c, 1.0);
    }
  `,
};
const crtPass = new ShaderPass(CRTShader);
composer.addPass(crtPass);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------------------
// hologram toggle
// ---------------------------------------------------------------------------
let holo = !params.has('tex'); // the projection is the default; H (or ?tex) reveals the textures
const holoPill = document.getElementById('holo');
function setHologram(on) {
  holo = on;
  city.setHologram(on);
  globe.setMode(on ? 'holo' : 'textured');
  outskirts.setMode(on ? 'holo' : 'textured');
  agents?.setHologram(on);
  traffic?.setHologram(on);
  crtPass.uniforms.grade.value = on ? 0.55 : 0.22;
  crtPass.uniforms.aberration.value = on ? 1.0 : 0.35;
  bloom.strength = on ? 0.7 : 0.45;
  bloom.threshold = on ? 0.3 : 0.55;
  holoPill.classList.toggle('off', !on);
}
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyH' && city.ready) setHologram(!holo);
});

// ---------------------------------------------------------------------------
// interaction: hover + click on agents / cars (fly mode)
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
raycaster.far = 400;
const crosshair = document.getElementById('crosshair');
const prompt = document.getElementById('prompt');
let hovered = null;

function pickTarget(ndcX, ndcY) {
  if (!agents) return null;
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  let best = null;
  let bd = Infinity;
  const pools = [agents.pickables, traffic?.pickables ?? [], venues?.pickables ?? []];
  for (const pool of pools) {
    for (const p of pool) {
      if (p.holder && !p.holder.visible) continue;
      const hits = raycaster.intersectObjects(p.hitMeshes, true);
      if (hits.length && hits[0].distance < bd) {
        bd = hits[0].distance;
        best = p;
      }
    }
  }
  return best;
}

function activate(target) {
  if (!target) return;
  if (target.isVenue) launcher.open(target);
  else if (target.onActivate) target.onActivate();
  else if (target.driver) spectator.enterPov(target.driver);
  else feed.push('ambient traffic — nobody aboard to ride with', '#9fffc8');
}

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !spectator.locked) return;
  if (spectator.mode === 'fly') activate(hovered);
  else if (spectator.mode === 'globe' && hoveredSite && !spectator.busy) diveToSite(hoveredSite);
});

// from orbit: the beacon is the door
let hoveredSite = null;
function diveToSite(s) {
  feed.push(`dropping into ${s.site.name.toLowerCase()}`, '#7dffb0');
  spectator.dive();
}
const mouseNdc = { x: 0, y: 0 };
canvas.addEventListener('mousemove', (e) => {
  mouseNdc.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNdc.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const hud = document.getElementById('hud');
const modeText = document.getElementById('mode-text');
const autoPill = document.getElementById('auto');
const autoT = document.getElementById('auto-t');
const card = document.getElementById('card');
const cardName = document.getElementById('card-name');
const cardRole = document.getElementById('card-role');
const cardThought = document.getElementById('card-thought');
const cardLog = document.getElementById('card-log');
const rosterEl = document.getElementById('roster');
const venueListEl = document.getElementById('venues');
const followEl = document.getElementById('follow');
let followVenue = null;

function buildVenueList() {
  venueListEl.replaceChildren(...venues.list.map((v) => {
    const row = document.createElement('div');
    row.className = 'ven';
    row.style.color = css(v.tint);
    row.innerHTML = `<i></i><b>${v.name}</b><em>GO</em>`;
    // GO flies the camera to the door; a second click enters
    row.addEventListener('click', () => {
      if (spectator.busy) return;
      if (spectator.mode === 'globe') {
        spectator.dive({ pos: new THREE.Vector3(v.pad.x, 26, v.pad.z + 40), yaw: 0, pitch: -0.5 });
        spectator.lock();
        return;
      }
      if (spectator.mode === 'pov') spectator.exitPov();
      const s = spectator.spec;
      s.pos.set(v.pad.x - Math.sin(s.yaw) * 0, 26, v.pad.z + 40);
      s.yaw = 0;
      s.pitch = -0.5;
      s.vel.set(0, 0, 0);
      spectator.lock();
    });
    return row;
  }));
}

// POV: when the agent you're riding reaches a venue door, E follows them in
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyE' && followVenue && !launcher.isOpen) launcher.open(followVenue);
});
const keyEls = [...document.querySelectorAll('#keys-fly .key')];
const keyByCode = { KeyW: 0, KeyA: 1, KeyS: 2, KeyD: 3, Space: 4, KeyC: 5, ShiftLeft: 6, ShiftRight: 6 };
document.addEventListener('keydown', (e) => keyEls[keyByCode[e.code]]?.classList.add('down'));
document.addEventListener('keyup', (e) => keyEls[keyByCode[e.code]]?.classList.remove('down'));

let rosterBuilt = 0;
function buildRoster() {
  if (!agents || agents.agents.length === rosterBuilt) return;
  rosterBuilt = agents.agents.length;
  spectator.setRoster(agents.agents);
  rosterEl.replaceChildren(...agents.agents.map((a) => {
    const row = document.createElement('div');
    row.className = 'ros';
    row.style.color = css(a.tint);
    row.innerHTML = `<i></i><b>${a.name}</b><em></em>`;
    row.addEventListener('click', () => {
      spectator.enterPov(a);
      spectator.lock();
    });
    a.rosterEl = row;
    return row;
  }));
}

const fmtAlt = (m) => (m >= 100_000 ? `${Math.round(m / 1000).toLocaleString('en-US')} KM` : m >= 1000 ? `${(m / 1000).toFixed(1)} KM` : `${Math.round(m)} M`);

let cardAgent = null;
let cardStamp = -1;
function refreshHud(force = false) {
  const pov = spectator.mode === 'pov';
  const inGlobe = spectator.mode === 'globe';
  hud.classList.toggle('pov', pov);
  hud.classList.toggle('globe', inGlobe);
  const t = spectator.target;
  modeText.textContent = pov && t ? `POV · ${t.name}` : inGlobe ? `GLOBE · ${fmtAlt(altitude)}` : 'FREE FLIGHT';
  autoPill.classList.toggle('off', !spectator.spec.auto);
  if (pov) autoT.textContent = spectator.spec.auto ? `${Math.ceil(spectator.spec.autoT)}s` : 'OFF';
  card.hidden = !(pov && t);
  if (pov && t && (force || cardAgent !== t || cardStamp !== t.log.length + t.thought.length)) {
    cardAgent = t;
    cardStamp = t.log.length + t.thought.length;
    const col = css(t.tint);
    cardName.textContent = t.name;
    cardName.style.color = col;
    cardRole.textContent = `${t.role} · ${t.isDriver ? 'driving' : t.state}`;
    cardThought.textContent = t.thought;
    cardThought.style.borderColor = col;
    cardLog.replaceChildren(...t.log.slice(1, 6).map((l) => {
      const li = document.createElement('li');
      const ago = Math.max(0, Math.round(performance.now() / 1000 - l.t));
      li.innerHTML = `<span>-${ago}s</span>${l.text}`;
      return li;
    }));
  }
  followVenue = pov && t && venues ? venues.nearest(t.pos, 9) : null;
  followEl.hidden = !followVenue;
  if (followVenue) {
    followEl.textContent = `E — FOLLOW ${t.name} INTO ${followVenue.name}`;
    followEl.style.color = css(followVenue.tint);
  }
  if (agents) {
    for (const a of agents.agents) {
      if (!a.rosterEl) continue;
      a.rosterEl.classList.toggle('live', pov && t === a);
      const em = a.rosterEl.lastElementChild;
      const label = a.isDriver ? 'driving' : a.state;
      if (em.textContent !== label) em.textContent = label;
    }
  }
}
spectator.spec.onChange = () => {
  refreshHud(true);
  agents?.setSpectated(spectator.mode === 'pov' ? spectator.target : null);
};

let entered = false;
function enter({ dive = true } = {}) {
  entered = true;
  setRain(rainOn);
  document.getElementById('overlay').classList.add('fade');
  hud.hidden = false;
  spectator.lock();
  refreshHud(true);
  // the hero shot: from orbit, straight down into the city
  if (dive && spectator.mode === 'globe') spectator.dive();
}
enterBtn.addEventListener('click', () => enter());
canvas.addEventListener('click', () => {
  if (!entered || spectator.locked) return;
  // unlocked in GLOBE: clicking the beacon under the mouse dives too
  const s = spectator.mode === 'globe' && !spectator.busy ? beacons.pick(camera, mouseNdc) : null;
  if (s) diveToSite(s);
  spectator.lock();
});


// debug / autoplay params: ?nointro skips the overlay, ?pov=NAME starts on
// an agent, ?tex starts in textured mode, ?rain starts the digital rain,
// ?noauto parks the auto-cycle
if (params.has('nointro')) {
  manager.onLoad = () => enter({ dive: false });
  setTimeout(() => { if (!entered) enter({ dive: false }); }, 20000);
}
if (params.has('noauto')) spectator.spec.auto = false;


// ---------------------------------------------------------------------------
// resize + loop
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  crtPass.uniforms.resolution.value.set(window.innerWidth, window.innerHeight);
});

window.__world = {
  scene,
  camera,
  city,
  globe,
  weights,
  spectator,
  feed,
  pickTarget,
  setHologram,
  beacons,
  get nav() { return nav; },
  get agents() { return agents; },
  get traffic() { return traffic; },
  get venues() { return venues; },
  launcher,
  get entered() { return entered; },
  get hovered() { return hovered; },
  get altitude() { return altitude; },
  get cine() { return cine; },
  stats: () => ({
    agents: agents?.agents.map((a) => `${a.name}:${a.isDriver ? 'drive' : a.state}@${a.pos.x.toFixed(0)},${a.pos.z.toFixed(0)} "${a.thought}"`),
    cars: traffic?.cars.length,
    carStates: traffic?.cars.reduce((m, c) => { m[c.state] = (m[c.state] || 0) + 1; return m; }, {}),
    mode: spectator.mode,
    target: spectator.target?.name ?? null,
    tris: city.tris,
    calls: renderer.info.render.calls,
    drawTris: renderer.info.render.triangles,
    altitude,
    near: camera.near,
    far: camera.far,
    fps: debug?.fps,
  }),
};

const debug = params.has('debug') ? createDebug(renderer, camera) : null;

// near / far ride the altitude: centimeters at a windshield, the whole planet
// from orbit (log depth keeps the precision; see the spec's depth notes)
let altitude = SPECTATE.spawn.y;
function updateClipPlanes() {
  altitude = Math.max(0, altitudeOf(camera.position));
  const near = Math.max(0.1, altitude * 0.001);
  const far = altitude + R * 2.2;
  if (Math.abs(camera.near - near) > near * 0.02 || Math.abs(camera.far - far) > far * 0.02) {
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}

// compile every program the zoom can show (hidden layers included) before
// anyone can start a dive, so there's no shader hitch on the way down
function precompile() {
  const hidden = [];
  scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
  });
  renderer.compile(scene, camera);
  for (const o of hidden) o.visible = false;
  warmed = true;
  tryReady();
}

// ---------------------------------------------------------------------------
// ?cinematic=1 — the marketing take (src/globe/cinematic.js). No UI; waits
// for every asset and shader, pre-runs the sim so the streets are already
// busy, then plays the dive. &record=1 steps exactly 1/60 s per frame for a
// screen recorder; &seek=S starts S seconds in; &duration=S sets the length.
// Any key or click afterwards hands the camera back.
// ---------------------------------------------------------------------------
const cinematicOn = params.has('cinematic');
const recordOn = params.has('record');
const cine = { on: cinematicOn, playing: false, t: Number(params.get('seek')) || 0, take: null };
if (cinematicOn) {
  document.getElementById('overlay').style.display = 'none';
  hud.hidden = true;
  spectator.startInOrbit();
  cine.take = createCinematic({ globeCam: spectator.globeCam, establishing: spectator.establishing });
  cine.take.apply(cine.t);
  const stop = () => {
    if (!cine.playing) return;
    cine.playing = false;
    cine.on = false;
    spectator.resumeFromGlobe();
    hud.hidden = false;
    entered = true;
    refreshHud(true);
  };
  addEventListener('keydown', stop);
  addEventListener('mousedown', stop);
}
function startCinematic() {
  // pre-run the streets: 8 s of traffic and errands before the first frame
  for (let i = 0; i < 240; i++) {
    traffic?.update(1 / 30, i / 30);
    agents?.update(1 / 30, i / 30);
  }
  // rebuild the take now the venues are placed: it aims at their middle
  cine.take = createCinematic({ globeCam: spectator.globeCam, establishing: spectator.establishing });
  cine.take.apply(cine.t);
  cine.playing = true;
}

// the intro opens on the planet, the city's beacon turning into view;
// ?alt=METERS starts in GLOBE mode at that altitude over the city instead
if (params.has('alt')) spectator.startInOrbit(Number(params.get('alt')) || undefined);
else if (!params.has('nointro') && !cinematicOn) spectator.startInOrbit();

// every altitude-driven layer, from one set of weights (src/globe/bands.js)
let trafficAcc = 0;
let trafficTick = 0;
function applyBands(dt, t) {
  const w = weights;
  beacons.update(camera, altitude, w, t, { agentCount: agents?.agents.length ?? 0, venueCount: venues?.list.length ?? 0 });
  scene.fog.density = CITY.fogDensity * w.fog;
  globe.update(camera, altitude, w, dt);
  outskirts.update(w, dt);
  title.update(camera, altitude, dt, {
    agents: agents?.agents.length ?? 0,
    sites: GLOBE_SITES,
    // not over the intro card (it has its own title) or a venue
    gate: (entered || cine.on) && !launcher.isOpen ? 1 : 0,
  });
  city.setFade(w.city);
  venues?.setFade(w.venues);
  if (agents) agents.group.visible = w.street;
  if (traffic) traffic.group.visible = w.street;
  impostor?.update(w, { agents: agents?.agents ?? [], cars: traffic?.cars ?? [], holo });
  rain.visible = rainOn && w.rain > 0.003;
  rain.opacity = w.rain;
}

const clock = new THREE.Clock();
let hoverTimer = 0;
let hudTimer = 0;
let radarTimer = 0;
let startedParams = false;

let simT = 0;
renderer.setAnimationLoop(() => {
  if (launcher.isOpen) return; // a venue has the screen — the city waits
  // record: exactly one 60th of a second per frame, whatever the wall clock says
  const dt = recordOn ? 1 / 60 : Math.min(clock.getDelta(), 0.05);
  simT += dt;
  const t = recordOn ? simT : clock.elapsedTime;

  if (agents?.ready && !startedParams) {
    startedParams = true;
    buildRoster();
    setHologram(holo);
    precompile();
    if (params.has('pov')) {
      const want = params.get('pov').toUpperCase();
      const a = agents.agents.find((x) => x.name === want) ?? agents.agents[0];
      spectator.enterPov(a);
    }
  }

  // client-side ambient traffic: full rate low, a quarter rate in the
  // Regional band (it's sparks on a map by then), stopped from orbit. The
  // agents never pause — they're the simulation, not scenery.
  trafficAcc += dt;
  trafficTick++;
  if (weights.trafficRate >= 1 || (weights.trafficRate > 0 && trafficTick % Math.round(1 / weights.trafficRate) === 0)) {
    traffic?.update(Math.min(trafficAcc, 0.1), t);
    trafficAcc = 0;
  } else if (weights.trafficRate === 0) trafficAcc = 0;
  agents?.viewer.copy(camera.position);
  agents?.update(dt, t);
  venues?.update(dt, t);
  if (cine.on) {
    if (!cine.playing && loaded && warmed && agents?.ready) startCinematic();
    else if (cine.playing) {
      cine.t += dt;
      cine.take.apply(cine.t);
    }
  } else spectator.update(dt);
  updateClipPlanes();
  bandWeights(altitude, weights);
  applyBands(dt, t);
  if (rain.visible) rain.update(t);
  crtPass.uniforms.time.value = t;

  hoverTimer -= dt;
  if (entered && hoverTimer <= 0) {
    hoverTimer = 0.12;
    hovered = spectator.mode === 'fly' ? pickTarget(0, 0) : null;
    hoveredSite = spectator.mode === 'globe' && !spectator.busy ? beacons.pick(camera, spectator.locked ? { x: 0, y: 0 } : mouseNdc) : null;
    crosshair.classList.toggle('hot', !!(hovered || hoveredSite));
    if (hovered) {
      prompt.textContent = hovered.prompt;
      prompt.classList.add('show');
    } else if (hoveredSite) {
      prompt.textContent = `${hoveredSite.site.name} · ${agents?.agents.length ?? 0} AGENTS LIVE — CLICK TO DIVE`;
      prompt.classList.add('show');
    } else prompt.classList.remove('show');
  }
  hudTimer -= dt;
  if (entered && hudTimer <= 0) {
    hudTimer = 0.25;
    refreshHud();
    feed.render();
  }
  radarTimer -= dt;
  if (entered && radar && radarTimer <= 0) {
    radarTimer = 0.1;
    const yaw = spectator.viewYaw;
    radar.draw({
      x: camera.position.x, z: camera.position.z, yaw, altitude: camera.position.y,
      agents: agents?.agents ?? [], cars: traffic?.cars ?? [], venues: venues?.list ?? [],
      target: spectator.mode === 'pov' ? spectator.target : null, mode: spectator.mode,
    });
  }

  debug?.begin();
  composer.render();
  debug?.end(dt, { altitude, band: bandOf(altitude), mode: spectator.mode.toUpperCase() });
});

/**
 * Headless verification of the first-person crawler, driven through the
 * sandbox spectator (the only path to it).
 *
 * Replaces the old pw-verify.mjs, which entered via the removed solo-quest
 * view and had been silently failing ever since the spectator island became
 * the default.
 *
 * Beyond "does it render", this asserts the CrawlerLightPool invariant that
 * motivated the pool in the first place: three.js bakes the point-light
 * count into the shader program cache key, so the program count must stay
 * FLAT while the camera moves. If it climbs, something is mounting lights
 * conditionally again and every material is recompiling as you walk.
 *
 * REQUIRES A GPU-BACKED BROWSER. `?capture=1` sets preserveDrawingBuffer,
 * which is what lets us read real scene pixels back (headless compositors
 * screenshot WebGL canvases black) — but as of Chromium 149 swiftshader
 * fails to create a context with it at all, and the crawler's
 * EffectComposer additionally throws on `getContextAttributes().alpha`
 * returning null. Both are software-GL limitations, not app bugs: the same
 * build renders correctly on real hardware. Run this on a machine with a
 * real GPU, or with `headless: false`.
 *
 * Usage (from a desktop session — PW_HEADED needs a display):
 *   # A policy (non-LLM) brain needs no API keys. Operator-only must be OFF:
 *   # the harness opens its own lobby, which an operator-only server refuses.
 *   QUEST_SIM_SANDBOX_OPERATOR_ONLY=false \
 *     uvicorn quest_sim.main:create_app --factory --port 8000
 *   npm run dev -- --port 5199
 *   PW_HEADED=1 node scripts/pw-crawler.mjs http://localhost:5199 pw-shots
 *
 * To leave an existing backend alone, run a second one on another port and
 * point both vite (VITE_BACKEND_URL) and the harness (PW_BACKEND) at it.
 *
 * Without PW_HEADED it runs headless on swiftshader, where the GL checks
 * cannot pass; the run is still useful for the DOM-level assertions.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:5199';
const SHOTS = resolve(process.argv[3] ?? 'pw-shots');
// 8000 matches the port vite.config.js already proxies /api to, so a stock
// `npm run dev` needs no VITE_BACKEND_URL.
const BACKEND = process.env.PW_BACKEND ?? 'http://127.0.0.1:8000';
mkdirSync(SHOTS, { recursive: true });

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

// A world driven by the policy brain: deterministic, no LLM calls, and it
// runs itself underground within a few seconds.
const world = await fetch(`${BACKEND}/world/new`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  // Slow ticks and a high ceiling: the crawler must stay mounted for the
  // whole sampling window. At default pacing a policy season resolves in
  // well under a minute and tears the scene down mid-run.
  body: JSON.stringify({
    hosted_brain: 'policy', tick_seconds: 2.5, max_ticks: 1000,
  }),
}).then((r) => r.json());
const WORLD = world.world_id;
if (!WORLD) {
  console.error(`could not open a lobby on ${BACKEND}: ${JSON.stringify(world)}`);
  console.error('an operator-only server refuses /world/new — run the backend with '
    + 'QUEST_SIM_SANDBOX_OPERATOR_ONLY=false, or point PW_BACKEND at one that is.');
  process.exit(1);
}
console.log(`world under test: ${WORLD}`);

// /start and /run are host-authenticated. Without the key the calls 403 and
// the season simply never begins — which surfaces 40s later as the far more
// confusing "an agent went underground: none found".
const HOST = { 'content-type': 'application/json', 'X-Host-Key': world.host_key };

const started = await fetch(`${BACKEND}/world/${WORLD}/start`, {
  method: 'POST', headers: HOST,
}).then((r) => r.json());
check('season started', started.phase === 'running', started.detail ?? started.phase);

await fetch(`${BACKEND}/world/${WORLD}/run`, {
  method: 'POST',
  headers: HOST,
  body: JSON.stringify({ tick_seconds: 2.5 }),
});

// Wait for someone to actually be underground — the crawler only mounts in
// follow mode on a dungeon-side agent.
let underground = null;
for (let i = 0; i < 40 && !underground; i += 1) {
  await new Promise((r) => { setTimeout(r, 1000); });
  const state = await fetch(`${BACKEND}/world/${WORLD}/state`).then((r) => r.json());
  underground = (state.roster ?? []).find(
    (a) => a.alive && a.position?.kind === 'dungeon',
  ) ?? null;
}
check('an agent went underground', !!underground, underground?.name ?? 'none found');
if (!underground) process.exit(1);
console.log(`following: ${underground.name} (${underground.position.site_id})`);

// PW_HEADED=1 launches a real window on the real GPU, which is the only way
// the pixel and program-count checks actually pass — see the note above.
// Headless falls back to swiftshader, where they cannot.
const HEADED = process.env.PW_HEADED === '1';
const browser = await chromium.launch({
  channel: 'chromium',
  headless: !HEADED,
  args: HEADED ? [] : ['--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(`${BASE}/?world=${WORLD}&capture=1`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

// Enter follow mode by clicking the agent's roster chip.
const chip = page.locator('.sbx-chip', { hasText: underground.name }).first();
await chip.click({ timeout: 15000 }).catch(() => {});
await page.waitForTimeout(6000);

const mounted = await page.evaluate(() => ({
  canvas: !!window.__crawler?.gl.domElement,
  seam: !!window.__crawler,
}));
check('crawler canvas mounted', mounted.canvas);
check('renderer test seam present', mounted.seam);

/** Scene-graph + renderer stats straight from three.js. */
const stats = () => page.evaluate(() => {
  const ctx = window.__crawler;
  // The seam is deleted on unmount, so its absence means "no crawler",
  // which must not be confused with "the crawler has no lights".
  if (!ctx || !document.contains(ctx.gl.domElement)) return null;
  let pointLights = 0;
  let poolSlots = 0;
  let poolLit = 0;
  let flames = 0;
  let cobwebs = 0;
  ctx.scene.traverse((o) => {
    if (o.isPointLight) {
      pointLights += 1;
      // Only pool slots count against the budget; the rig's key light is
      // deliberately unpooled and always on.
      if (o.userData.poolSlot) {
        poolSlots += 1;
        if (o.intensity > 0) poolLit += 1;
      }
    }
    if (o.material?.map?.userData?.sheet) flames += 1;
    if (o.isInstancedMesh && o.material?.map?.image?.src?.includes('cobweb')) {
      cobwebs = Math.max(cobwebs, o.count);
    }
  });
  return {
    programs: ctx.gl.info.programs?.length ?? 0,
    pointLights,
    poolSlots,
    poolLit,
    flames,
    cobwebs,
  };
});

const first = await stats();
check('scene has point lights', (first?.pointLights ?? 0) > 0, JSON.stringify(first));

// Sample across a stretch of movement: the pool must hold both counts flat.
const programSeq = [];
const lightSamples = new Set();
let peakLitFrac = 0;
let peakGreenFrac = 0;
let peakLit = 0;
let peakFlames = 0;
let peakCobwebs = 0;
let live = 0;
let tornDown = false;
for (let i = 0; i < 12; i += 1) {
  await page.waitForTimeout(1500);
  const s = await stats();
  // A null sample means the crawler unmounted — the season ended, or the
  // followed agent surfaced. Everything after that would measure a scene
  // that no longer exists, so stop rather than fold teardown into the
  // assertions (which reads as the light count collapsing to zero).
  if (!s) { tornDown = true; break; }
  live += 1;
  programSeq.push(s.programs);
  lightSamples.add(s.pointLights);
  peakLit = Math.max(peakLit, s.poolLit);
  peakFlames = Math.max(peakFlames, s.flames);
  peakCobwebs = Math.max(peakCobwebs, s.cobwebs);

  // Pixels must be read WHILE the crawler is mounted, from its own canvas.
  const px = await page.evaluate(() => {
    const c = window.__crawler?.gl.domElement;
    if (!c) return null;
    const off = document.createElement('canvas');
    off.width = 320; off.height = 180;
    const cx = off.getContext('2d');
    cx.drawImage(c, 0, 0, off.width, off.height);
    const d = cx.getImageData(0, 0, off.width, off.height).data;
    let lit = 0; let green = 0;
    for (let k = 0; k < d.length; k += 4) {
      if (d[k] + d[k + 1] + d[k + 2] > 24) lit += 1;
      if (d[k + 1] > d[k] && d[k + 1] >= d[k + 2]) green += 1;
    }
    return { litFrac: lit / (d.length / 4), greenFrac: green / (d.length / 4) };
  });
  if (px) {
    peakLitFrac = Math.max(peakLitFrac, px.litFrac);
    peakGreenFrac = Math.max(peakGreenFrac, px.greenFrac);
  }

  if (i % 4 === 0) {
    const dataUrl = await page.evaluate(() => {
      // MUST be the crawler's own canvas: it is the only one created with
      // preserveDrawingBuffer, and the island's sits earlier in the DOM, so
      // querySelector('canvas') reads back a blank buffer every time.
      const c = window.__crawler?.gl.domElement;
      if (!c) return null;
      const off = document.createElement('canvas');
      off.width = 720;
      off.height = Math.round((720 / c.width) * c.height);
      off.getContext('2d').drawImage(c, 0, 0, off.width, off.height);
      return off.toDataURL('image/png');
    });
    if (dataUrl) {
      writeFileSync(`${SHOTS}/crawler-${i}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
    }
  }
}

check('sampled a live crawler', live >= 4, `${live} live samples${tornDown ? ' (scene torn down early)' : ''}`);

// The pool's actual guarantee: the number of point lights in the scene
// never changes, so three.js never rebuilds its shader programs for a new
// light count.
check(
  'point-light count constant while moving',
  lightSamples.size === 1,
  `saw ${[...lightSamples].join(',')}`,
);

// Programs may legitimately FALL as materials are disposed, and rise once
// during warm-up while assets stream in and compile. What must not happen
// is upward drift as the camera moves — that is the recompile signature.
const settled = programSeq.slice(3);
check(
  'shader programs stop churning once warm',
  settled.length > 0 && Math.max(...settled) - Math.min(...settled) <= 1,
  `sequence ${programSeq.join(',')}`,
);

check('pooled lights stay within budget', peakLit <= 6, `peak lit ${peakLit}`);
check('flame billboards present', peakFlames > 0, `peak ${peakFlames}`);
check('cobwebs placed', peakCobwebs > 0, `peak ${peakCobwebs}`);
check('scene pixels lit', peakLitFrac > 0.02, `peak litFrac ${peakLitFrac.toFixed(3)}`);
check('scene green-dominant', peakGreenFrac > 0.1, `peak greenFrac ${peakGreenFrac.toFixed(3)}`);
check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
await fetch(`${BACKEND}/world/${WORLD}/pause`, { method: 'POST' }).catch(() => {});

console.log(`\nshots: ${SHOTS}`);
if (failures.length) {
  console.error(`\n${failures.length} FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall checks passed');

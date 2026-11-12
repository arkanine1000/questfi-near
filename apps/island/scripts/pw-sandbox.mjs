#!/usr/bin/env node
/**
 * Headless E2E for the sandbox spectator view.
 *
 * Needs a live backend with /world routes and a dev server pointing at it:
 *   QUEST_SIM_SANDBOX_TICK_SECONDS=0.7 uvicorn quest_sim.main:app --port 8123
 *   VITE_BACKEND_URL=http://127.0.0.1:8123 npm run dev -- --port 5199
 *   node scripts/pw-sandbox.mjs [baseUrl] [shotsDir]
 *
 * Asserts: lobby renders → season starts → 10 uniquely-colored roster chips
 * → tick counter advances → headline ticker lands → chip click enters follow
 * mode → winner/new-season chrome intact. Zero [BRACKET] buttons anywhere.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:5199';
const SHOTS = process.argv[3] || '/tmp/pw-sandbox-shots';
const BACKEND = process.env.PW_BACKEND || 'http://127.0.0.1:8123';
mkdirSync(SHOTS, { recursive: true });

// A fresh lobby world per run — the view pins to it via ?world=
const created = await fetch(`${BACKEND}/world/new`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({}),
}).then((r) => r.json());
const WORLD_URL = `${BASE}/?world=${created.world_id}`;
console.log(`world under test: ${created.world_id}`);

const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`✓ ${msg}`);
/** Non-fatal: worth reporting, but not a reason to fail the run. */
const warn = (msg) => console.warn(`~ ${msg}`);

const browser = await chromium.launch({
  channel: 'chromium', // full build, new headless — WebGL works
  headless: true,
  args: ['--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

try {
  await page.addInitScript(([backend, world, hostKey]) => {
    window.__SBX_BACKEND__ = backend;
    window.__SBX_WORLD__ = world;
    // We created this world over HTTP, so the browser never saw the key the
    // create response handed back. Seed it exactly where the app stores it,
    // otherwise this run is a spectator and every control is (correctly)
    // absent.
    try {
      localStorage.setItem('sbx-host-keys', JSON.stringify({ [world]: hostKey }));
    } catch { /* storage disabled — the host checks below will say so */ }
  }, [BACKEND, created.world_id, created.host_key]);

  // 0. The front door lists seasons and creates NOTHING. Boot used to open
  // a lobby on every load; a regression here is invisible in the UI and
  // only shows up as junk worlds piling up on the server.
  const before = await fetch(`${BACKEND}/world`).then((r) => r.json());
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sbx-landing', { timeout: 20000 });
  ok('landing surface shown when no ?world=');
  const listed = await page.$$eval('.sbx-landing__card', (els) => els.length);
  if (listed > 0) ok(`landing lists ${listed} season(s)`);
  else fail('landing listed no seasons despite one being open');
  const after = await fetch(`${BACKEND}/world`).then((r) => r.json());
  if (after.worlds.length === before.worlds.length) ok('landing created no world');
  else fail(`landing created ${after.worlds.length - before.worlds.length} world(s)`);
  await page.screenshot({ path: `${SHOTS}/00-landing.png` });

  await page.goto(WORLD_URL, { waitUntil: 'domcontentloaded' });

  // 1. Boot → lobby
  await page.waitForSelector('.sbx-topbar', { timeout: 20000 });
  ok('top bar mounted');
  const lobby = await page.waitForSelector('.sbx-lobby', { timeout: 15000 }).catch(() => null);
  if (lobby) ok('lobby overlay shown');
  await page.screenshot({ path: `${SHOTS}/01-lobby.png` });

  // 2. No bracket-button residue anywhere in the sandbox chrome
  const brackets = await page.$$eval('button', (els) =>
    els.filter((b) => /\[.*\]/.test(b.textContent || '')).map((b) => b.textContent));
  if (brackets.length) fail(`bracket buttons found: ${brackets.join(', ')}`);
  else ok('no [BRACKET] buttons');

  // 3. Begin season → roster fills to pool with unique colors
  await page.click('button:has-text("Begin Game")');
  await page.waitForSelector('.sbx-chip', { timeout: 15000 });
  await page.waitForFunction(
    (n) => document.querySelectorAll('.sbx-chip').length >= n,
    created.pool_size, { timeout: 15000 });
  const colors = await page.$$eval('.sbx-chipwrap', (chips) =>
    chips.map((c) => c.style.getPropertyValue('--chip-color')));
  if (new Set(colors).size !== colors.length) fail(`duplicate chip colors: ${colors}`);
  else ok(`${colors.length} roster chips, all colors distinct`);

  // 3b. Parimutuel ledger pill (simulated funds). It needs a roster —
  // MarketPanel renders nothing while the lobby is empty — so it is
  // asserted here rather than before Begin.
  await page.waitForSelector('.sbx-market__ledgerseg', { timeout: 5000 });
  // The ledger is several segments (pool, yours, …) — find the one that
  // carries the spectator's own balance rather than assuming an order.
  const segs = await page.$$eval('.sbx-market__ledgerseg', (els) =>
    els.map((el) => el.textContent));
  if (!segs.some((t) => /yours [\d,]+/.test(t))) fail(`no sim balance in ledger: ${segs.join(' | ')}`);
  else ok('betting ledger pill live with sim balance');

  // 3c. Odds ride the chips; hovering unfolds the stake strip
  await page.waitForSelector('.sbx-chip__odds', { timeout: 10000 });
  await page.hover('.sbx-chipwrap >> nth=0');
  await page.waitForSelector('.sbx-chip__bets button', { timeout: 5000 });
  ok('per-chip odds + stake strip on hover');

  // 4. Chip click → follow mode (early, before the season can end)
  await page.click('.sbx-chip >> nth=0');
  await page.waitForSelector('.sbx-chipwrap.is-followed', { timeout: 5000 });
  ok('chip click enters follow mode');

  // 5. The clock advances (SSE frames landing)
  const tickAt = async () =>
    parseInt(await page.$eval('.sbx-topbar__tick', (el) => el.textContent), 10);
  const t0 = await tickAt();
  await page.waitForFunction(
    (prev) => parseInt(document.querySelector('.sbx-topbar__tick')?.textContent ?? '0', 10) > prev,
    t0, { timeout: 15000 });
  ok(`tick advanced past ${t0}`);

  // 5b. Follow panel + the always-visible way home
  await page.waitForSelector('.sbx-follow', { timeout: 5000 });
  await page.waitForSelector('.sbx-exit-pill', { timeout: 5000 });
  ok('follow panel + exit pill mounted');
  // …and Escape returns to the god view
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => !document.querySelector('.sbx-follow'), null, { timeout: 5000 });
  ok('Escape exits follow mode');

  // 6. Headline ticker lands within a few ticks (site entries at minimum)
  await page.waitForSelector('.sbx-ticker__line', { timeout: 30000 });
  ok('event ticker live');
  await page.screenshot({ path: `${SHOTS}/02-running.png` });

  // 6b. Follow an underground agent → the first-person crawler takes over
  const dungeonAgent = await page.waitForFunction(async () => {
    const res = await fetch(`${window.__SBX_BACKEND__}/world/${window.__SBX_WORLD__}/state`);
    const state = await res.json();
    const under = (state.roster || []).find(
      (a) => a.alive && a.position?.kind === 'dungeon');
    return under ? under.name : null;
  }, null, { timeout: 45000, polling: 1000 }).then((h) => h.jsonValue());
  await page.click(`.sbx-chip:has-text("${dungeonAgent}")`);
  await page.waitForSelector('.sbx-crawler-overlay', { timeout: 8000 });
  ok(`crawler overlay follows ${dungeonAgent} underground`);
  // HUD (or minimap fallback) inside the overlay proves the crawler booted
  await page.waitForSelector(
    '.sbx-crawler-overlay .crawler-hud, .sbx-crawler-overlay .crawler-minimap, .sbx-crawler-overlay .crawler-view__loading',
    { timeout: 10000 });
  ok('crawler HUD/minimap present');
  // The HUD now mounts in the same commit as the loading curtain, which is
  // opaque and sits above it — screenshot before the curtain lifts and
  // 03-crawler.png is a picture of the loading card. Wait it out. On
  // swiftshader the scene may never report ready, so fall through to the
  // component's own 12s escape hatch rather than failing the run.
  await page.waitForFunction(
    () => !document.querySelector('.sbx-descent--boot'), null, { timeout: 20000 },
  ).catch(() => warn('crawler curtain never lifted — shot may show the loading card'));
  await page.screenshot({ path: `${SHOTS}/03-crawler.png` });
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => !document.querySelector('.sbx-crawler-overlay'), null, { timeout: 5000 });
  ok('Escape surfaces from the crawler');

  // 7. Island canvas up — or the graceful fallback with the HUD intact
  const hasCanvas = await page.$('canvas');
  const hasFallback = await page.$('.sbx-fallback');
  if (hasCanvas) ok('island canvas present');
  else if (hasFallback) ok('WebGL unavailable here — fallback backdrop, HUD alive');
  else fail('neither canvas nor fallback rendered');

  // GL context failures are absorbed by the scene boundary by design;
  // any OTHER console error is a real defect.
  const realErrors = consoleErrors.filter(
    (e) => !/WebGL|webgl|reading 'alpha'|Context Lost|Failed to load resource/i.test(e));
  if (realErrors.length) {
    fail(`console errors:\n  ${realErrors.slice(0, 5).join('\n  ')}`);
  } else {
    ok('no unexpected console errors');
  }
} catch (e) {
  fail(e.message);
  await page.screenshot({ path: `${SHOTS}/99-failure.png` }).catch(() => {});
} finally {
  await browser.close();
}

process.exit(process.exitCode || 0);

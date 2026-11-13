#!/usr/bin/env node
/**
 * Screenshots of every preview scenario (src/dev/preview/catalog.js), taken
 * from the dev server with the GPU and every 3D API switched off.
 *
 *   npm run dev -- --port 5311 --strictPort        # in another terminal
 *   node scripts/preview-shots.mjs --out <dir> [--only a,b] [--viewports 1600x900,844x390]
 *                                  [--base http://localhost:5311/]
 *
 * For each scenario and viewport it loads the page, waits for the fonts and
 * for <html data-preview-ready="1">, and writes <out>/<scenario>@<w>x<h>.png.
 * It stops with a non-zero exit and says why when a page contains a <canvas>,
 * asks a host other than the dev server (or a font host) for anything, throws
 * an uncaught error, or never becomes ready. One page at a time.
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { DEFAULT_VIEWPORTS, SCENARIOS } from '../src/dev/preview/catalog.js';

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const READY_TIMEOUT_MS = 45000;

function parseArgs(argv) {
  const out = { base: 'http://localhost:5311/', only: null, viewports: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      i += 1;
      return argv[i];
    };
    if (a === '--base') out.base = next();
    else if (a === '--out') out.out = next();
    else if (a === '--only') out.only = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--viewports') out.viewports = next().split(',').map(parseViewport);
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}

function parseViewport(text) {
  const m = /^(\d+)x(\d+)$/.exec(text.trim());
  if (!m) throw new Error(`a viewport is WIDTHxHEIGHT, not "${text}"`);
  return [Number(m[1]), Number(m[2])];
}

const usage = 'usage: node scripts/preview-shots.mjs --out <dir> [--base <url>] [--only a,b] [--viewports 1600x900,844x390]';

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`${err.message}\n${usage}`);
  process.exit(2);
}
if (args.help) {
  console.log(usage);
  process.exit(0);
}
if (!args.out) {
  console.error(`--out is required\n${usage}`);
  process.exit(2);
}

let scenarios = SCENARIOS;
if (args.only) {
  const known = new Set(SCENARIOS.map((s) => s.name));
  const unknown = args.only.filter((n) => !known.has(n));
  if (unknown.length) {
    console.error(`no such scenario: ${unknown.join(', ')}\nknown: ${[...known].join(', ')}`);
    process.exit(2);
  }
  scenarios = SCENARIOS.filter((s) => args.only.includes(s.name));
}

const base = new URL(args.base);
const outDir = resolve(args.out);
mkdirSync(outDir, { recursive: true });

const jobs = [];
for (const s of scenarios) {
  const viewports = args.viewports ?? s.viewports ?? (s.core ? DEFAULT_VIEWPORTS : [DEFAULT_VIEWPORTS[0]]);
  for (const [w, h] of viewports) jobs.push({ scenario: s, w, h });
}

const browser = await chromium.launch({
  headless: true, // the headless shell
  args: ['--disable-gpu', '--disable-3d-apis', '--disable-webgl', '--disable-webgl2'],
});

const failures = [];
const t0 = Date.now();
try {
  for (const { scenario, w, h } of jobs) {
    const label = `${scenario.name}@${w}x${h}`;
    const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const problems = [];
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.protocol === 'data:' || u.protocol === 'blob:') return;
      if (u.host === base.host || FONT_HOSTS.includes(u.hostname)) return;
      problems.push(`asked another host: ${req.method()} ${req.url()}`);
    });
    page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
    const url = new URL(`?${scenario.query}`, base).href;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(
        () => document.documentElement.dataset.previewReady,
        null,
        { timeout: READY_TIMEOUT_MS, polling: 100 },
      );
      await page.evaluate(() => document.fonts.ready);
      const state = await page.evaluate(() => ({
        ready: document.documentElement.dataset.previewReady,
        error: document.documentElement.dataset.previewError || null,
        blocked: document.documentElement.dataset.previewBlocked || null,
        canvases: [...document.querySelectorAll('canvas')].map((c) => c.parentElement?.className || c.parentElement?.tagName),
      }));
      if (state.ready !== '1') problems.push(`not ready: ${state.error ?? state.ready}`);
      if (state.canvases.length) problems.push(`the page contains ${state.canvases.length} <canvas> (in ${state.canvases.join(', ')})`);
      if (state.blocked) problems.push(`the page tried to reach ${state.blocked}`);
      await page.screenshot({ path: join(outDir, `${label}.png`) });
    } catch (err) {
      problems.push(err.message.split('\n')[0]);
    } finally {
      await context.close();
    }
    if (problems.length) {
      failures.push({ label, problems });
      console.error(`✗ ${label}\n    ${problems.join('\n    ')}`);
    } else {
      console.log(`✓ ${label}`);
    }
  }
} finally {
  await browser.close();
}

const secs = Math.round((Date.now() - t0) / 1000);
if (failures.length) {
  console.error(`\n${failures.length} of ${jobs.length} screenshots failed (${secs} s): ${failures.map((f) => f.label).join(', ')}`);
  process.exit(1);
}
console.log(`\n${jobs.length} screenshots in ${outDir} (${secs} s)`);

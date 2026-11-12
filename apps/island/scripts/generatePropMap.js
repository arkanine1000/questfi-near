/**
 * Prop Map Generator — Phase 6 holographic terrain props
 *
 * Deterministically scatters trees, rocks and crags across the island using
 * elevation-band biome rules sampled from the existing heightmap artifact
 * (src/assets/heightmap.png — NOT regenerated here). A fixed seed drives a
 * mulberry32 PRNG: same seed -> identical island forever.
 *
 * Output: src/data/propMap.js — flat numeric arrays per prop type
 *   [x, z, elevNorm, scale, rotY, jitter] * N   (world coordinates, Y-up)
 * plus the crater feature descriptor. Also writes scripts/prop-debug.png,
 * a scatter-plot sanity render (gitignored).
 *
 * Usage: npm run generate:props
 */

import { createCanvas, loadImage } from 'canvas';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PROP_SEED = 0x5eed1;

// Grid constants — must match HexGrid.jsx / worldUtils.js exactly
const HEX_SIZE = 46;
const GRID_OFFSET_X = 100;
const GRID_OFFSET_Y = 65;
const IMG_WIDTH = 1536;
const IMG_HEIGHT = 1024;
const WORLD_PER_PIXEL = 1 / 100;

// All counts tunable from here; hard cap enforced below
const PROP_CONFIG = {
  forestClusters: 40,        // clumps of trees in the lowland belt
  clumpSizeMin: 6,           // denser AoE-style woods
  clumpSizeMax: 16,
  loneLowland: 50,           // scattered lone trees/rocks between clumps
  shoreRocks: 48,
  highlandScatter: 90,       // type-B-biased trees + rocks
  cragClusters: 34,          // 2-4 spikes each, peak slopes only
  craterSpikes: 6,
  ruins: 2,                  // ancient temple ruin landmarks
  aqueducts: 1,              // one collapsed aqueduct landmark
  pillarFields: 5,           // standalone clusters of 2-3 lone columns
  fillScatter: 290,          // final pass: texture the barren gaps
  hardCap: 1200,
};

// Placement constraints (image px; 1 world unit = 100 px)
const HEX_CENTER_EXCLUSION = 18; // 0.18 world units
const MIN_SPACING = 4;           // 0.04 world units
const SLOPE_SAMPLE = 16;         // px offset for cliff detection
const SLOPE_MAX_DIFF = 0.09;     // normalized elevation delta

// Elevation bands (normalized). Tuned to this island's elevation histogram —
// the inland-dome blend puts most of the interior at 0.4-0.7, so the forest
// belt extends higher than the spec's generic 0.45 cutoff.
const BAND = {
  shoreMax: 0.10,
  lowlandMax: 0.55,
  highlandMax: 0.78,
  peakMax: 0.95,
};

const HEIGHTMAP_PATH = resolve(__dirname, '../src/assets/heightmap.png');
const OUTPUT_PATH = resolve(__dirname, '../src/data/propMap.js');
const DEBUG_PNG_PATH = resolve(__dirname, 'prop-debug.png');

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32, no dependency
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(PROP_SEED);
const randRange = (min, max) => min + rand() * (max - min);
// Box-Muller gaussian for cluster scatter
function randGauss(sigma) {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
}

// ---------------------------------------------------------------------------
// Hex math (duplicated to avoid ESM import issues)
// ---------------------------------------------------------------------------
function axialToPixel(q, r, hexSize) {
  return {
    x: hexSize * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r),
    y: hexSize * ((3 / 2) * r),
  };
}

function getHexNeighbors(q, r) {
  return [
    { q: q + 1, r }, { q: q - 1, r },
    { q, r: r + 1 }, { q, r: r - 1 },
    { q: q + 1, r: r - 1 }, { q: q - 1, r: r + 1 },
  ];
}

/** Image px -> rounded axial hex (pointy-top, cube rounding). */
function pixelToAxial(px, py) {
  const x = px - GRID_OFFSET_X;
  const y = py - GRID_OFFSET_Y;
  const qf = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / HEX_SIZE;
  const rf = ((2 / 3) * y) / HEX_SIZE;
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { ISLAND_MASK } = await import('../src/components/HexGrid/hexUtils.js');

  // Load heightmap artifact (192x128 grayscale)
  const img = await loadImage(HEIGHTMAP_PATH);
  const hCanvas = createCanvas(img.width, img.height);
  const hCtx = hCanvas.getContext('2d');
  hCtx.drawImage(img, 0, 0);
  const hData = hCtx.getImageData(0, 0, img.width, img.height).data;
  const GW = img.width;
  const GH = img.height;
  const CELL = IMG_WIDTH / GW;

  /** Bilinear elevation sample at image px coords, normalized 0..1. */
  function sampleElev(px, py) {
    const gx = Math.min(Math.max(px / CELL - 0.5, 0), GW - 1.001);
    const gy = Math.min(Math.max(py / CELL - 0.5, 0), GH - 1.001);
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(x0 + 1, GW - 1);
    const y1 = Math.min(y0 + 1, GH - 1);
    const fx = gx - x0;
    const fy = gy - y0;
    const v = (x, y) => hData[(y * GW + x) * 4] / 255;
    const a = v(x0, y0) * (1 - fx) + v(x1, y0) * fx;
    const b = v(x0, y1) * (1 - fx) + v(x1, y1) * fx;
    return a * (1 - fy) + b * fy;
  }

  // Bounding box of land hexes for rejection sampling
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  const edgeHexes = new Set();
  for (const key of ISLAND_MASK) {
    const [q, r] = key.split(',').map(Number);
    const { x, y } = axialToPixel(q, r, HEX_SIZE);
    minX = Math.min(minX, x + GRID_OFFSET_X - HEX_SIZE);
    maxX = Math.max(maxX, x + GRID_OFFSET_X + HEX_SIZE);
    minY = Math.min(minY, y + GRID_OFFSET_Y - HEX_SIZE);
    maxY = Math.max(maxY, y + GRID_OFFSET_Y + HEX_SIZE);
    if (getHexNeighbors(q, r).some((n) => !ISLAND_MASK.has(`${n.q},${n.r}`))) {
      edgeHexes.add(key);
    }
  }

  // Low-frequency value noise for forest clumping (~7 cells across island)
  const NOISE_W = 8;
  const NOISE_H = 6;
  const noiseGrid = Array.from({ length: NOISE_W * NOISE_H }, () => rand());
  function forestNoise(px, py) {
    const nx = Math.min(Math.max(((px - minX) / (maxX - minX)) * (NOISE_W - 1), 0), NOISE_W - 1.001);
    const ny = Math.min(Math.max(((py - minY) / (maxY - minY)) * (NOISE_H - 1), 0), NOISE_H - 1.001);
    const x0 = Math.floor(nx);
    const y0 = Math.floor(ny);
    const fx = nx - x0;
    const fy = ny - y0;
    const v = (x, y) => noiseGrid[Math.min(y, NOISE_H - 1) * NOISE_W + Math.min(x, NOISE_W - 1)];
    const a = v(x0, y0) * (1 - fx) + v(x0 + 1, y0) * fx;
    const b = v(x0, y0 + 1) * (1 - fx) + v(x0 + 1, y0 + 1) * fx;
    return a * (1 - fy) + b * fy;
  }

  // ---- Constraint checks ----
  const spacingHash = new Map(); // "gx,gy" -> [{px,py}]
  const keepOuts = []; // {px, py, radius} — structure footprints

  function constraintsOk(px, py, { exclusion = HEX_CENTER_EXCLUSION, slopeMax = SLOPE_MAX_DIFF } = {}) {
    // 1. land only
    const { q, r } = pixelToAxial(px, py);
    if (!ISLAND_MASK.has(`${q},${r}`)) return false;
    // 2. hex-center exclusion (own + neighbor centers)
    const centers = [{ q, r }, ...getHexNeighbors(q, r)];
    for (const c of centers) {
      const p = axialToPixel(c.q, c.r, HEX_SIZE);
      const dx = px - (p.x + GRID_OFFSET_X);
      const dy = py - (p.y + GRID_OFFSET_Y);
      if (dx * dx + dy * dy < exclusion * exclusion) return false;
    }
    // 3. slope check — skip cliff faces
    const e0 = sampleElev(px, py);
    for (const [ox, oy] of [[SLOPE_SAMPLE, 0], [-SLOPE_SAMPLE, 0], [0, SLOPE_SAMPLE], [0, -SLOPE_SAMPLE]]) {
      if (Math.abs(sampleElev(px + ox, py + oy) - e0) > slopeMax) return false;
    }
    // 4. structure keep-out zones
    for (const k of keepOuts) {
      const dx = px - k.px;
      const dy = py - k.py;
      if (dx * dx + dy * dy < k.radius * k.radius) return false;
    }
    // 5. min spacing via grid hash
    const gx = Math.floor(px / MIN_SPACING);
    const gy = Math.floor(py / MIN_SPACING);
    for (let yy = gy - 1; yy <= gy + 1; yy++) {
      for (let xx = gx - 1; xx <= gx + 1; xx++) {
        const bucket = spacingHash.get(`${xx},${yy}`);
        if (!bucket) continue;
        for (const o of bucket) {
          const dx = px - o.px;
          const dy = py - o.py;
          if (dx * dx + dy * dy < MIN_SPACING * MIN_SPACING) return false;
        }
      }
    }
    return true;
  }

  function registerSpacing(px, py) {
    const key = `${Math.floor(px / MIN_SPACING)},${Math.floor(py / MIN_SPACING)}`;
    if (!spacingHash.has(key)) spacingHash.set(key, []);
    spacingHash.get(key).push({ px, py });
  }

  // ---- Emit helpers ----
  const props = {
    treeA: [], treeB: [], rock: [], crag: [], pillar: [], ruin: [], aqueduct: [],
  };
  let total = 0;

  function place(type, px, py, scale, jitter, rotY = null) {
    if (total >= PROP_CONFIG.hardCap) return false;
    const elev = sampleElev(px, py);
    props[type].push(
      +((px - IMG_WIDTH / 2) * WORLD_PER_PIXEL).toFixed(4),
      +((py - IMG_HEIGHT / 2) * WORLD_PER_PIXEL).toFixed(4),
      +elev.toFixed(4),
      +scale.toFixed(4),
      +((rotY ?? rand() * Math.PI * 2)).toFixed(4),
      +jitter.toFixed(3),
    );
    registerSpacing(px, py);
    total += 1;
    return true;
  }

  const inBand = (px, py, lo, hi) => {
    const e = sampleElev(px, py);
    return e >= lo && e < hi;
  };

  function randomLandPoint() {
    return { px: randRange(minX, maxX), py: randRange(minY, maxY) };
  }

  const jitterStd = () => randRange(-1, 1);

  // ---- 0. Crater first: the signature feature must never lose its budget
  // to the hard cap. Ring of amber-tinted spikes around the caldera. ----
  let peak = { v: -1, gx: 0, gy: 0 };
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      const v = hData[(gy * GW + gx) * 4] / 255;
      if (v > peak.v) peak = { v, gx, gy };
    }
  }
  const craterPx = (peak.gx + 0.5) * CELL;
  const craterPy = (peak.gy + 0.5) * CELL;
  const craterRadiusPx = 30;
  for (let i = 0; i < PROP_CONFIG.craterSpikes; i++) {
    const angle = (i / PROP_CONFIG.craterSpikes) * Math.PI * 2 + randRange(-0.2, 0.2);
    const px = craterPx + Math.cos(angle) * craterRadiusPx * randRange(0.9, 1.1);
    const py = craterPy + Math.sin(angle) * craterRadiusPx * randRange(0.9, 1.1);
    // jitter > 1.5 marks the amber crater spikes for the renderer
    place('crag', px, py, randRange(0.14, 0.22), randRange(2, 3));
  }
  const crater = {
    x: +((craterPx - IMG_WIDTH / 2) * WORLD_PER_PIXEL).toFixed(4),
    z: +((craterPy - IMG_HEIGHT / 2) * WORLD_PER_PIXEL).toFixed(4),
    elev: +sampleElev(craterPx, craterPy).toFixed(4),
    radius: +(craterRadiusPx * WORLD_PER_PIXEL).toFixed(4),
  };

  // ---- 0b. Ancient structures (before vegetation so keep-outs apply) ----
  // Strict siting: extra clearance from hex centers + flatter ground.
  const STRUCT_OPTS = { exclusion: 34, slopeMax: 0.05 };

  // Temple ruins, each with a ring of weathered columns around it
  for (let attempt = 0, placed = 0; attempt < 8000 && placed < PROP_CONFIG.ruins; attempt++) {
    const { px, py } = randomLandPoint();
    if (!inBand(px, py, 0.15, 0.7)) continue;
    if (!constraintsOk(px, py, STRUCT_OPTS)) continue;
    place('ruin', px, py, randRange(0.4, 0.48), jitterStd());
    keepOuts.push({ px, py, radius: 28 });
    for (let i = 0, ringed = 0; i < 14 && ringed < 4; i++) {
      const a = rand() * Math.PI * 2;
      const d = randRange(32, 46);
      const cx = px + Math.cos(a) * d;
      const cy = py + Math.sin(a) * d;
      if (!constraintsOk(cx, cy)) continue;
      place('pillar', cx, cy, randRange(0.14, 0.2), jitterStd());
      keepOuts.push({ px: cx, py: cy, radius: 6 });
      ringed += 1;
    }
    placed += 1;
  }

  // One collapsed aqueduct — keep-out strip along its axis
  for (let attempt = 0, placed = 0; attempt < 8000 && placed < PROP_CONFIG.aqueducts; attempt++) {
    const { px, py } = randomLandPoint();
    if (!inBand(px, py, 0.12, 0.55)) continue;
    if (!constraintsOk(px, py, STRUCT_OPTS)) continue;
    const rotY = rand() * Math.PI * 2;
    const scale = 0.6;
    // both ends must be on land and not on a cliff
    const ex = Math.cos(rotY) * scale * 50;
    const ey = -Math.sin(rotY) * scale * 50;
    if (!constraintsOk(px + ex, py + ey, { ...STRUCT_OPTS, exclusion: 10 })) continue;
    if (!constraintsOk(px - ex, py - ey, { ...STRUCT_OPTS, exclusion: 10 })) continue;
    place('aqueduct', px, py, scale, jitterStd(), rotY);
    for (const t of [-0.5, 0, 0.5]) {
      keepOuts.push({ px: px + ex * t * 2, py: py + ey * t * 2, radius: 14 });
    }
    placed += 1;
  }

  // Lone column clusters dotted around the island
  for (let attempt = 0, placed = 0; attempt < 6000 && placed < PROP_CONFIG.pillarFields; attempt++) {
    const { px, py } = randomLandPoint();
    if (!inBand(px, py, 0.1, 0.75)) continue;
    if (!constraintsOk(px, py, { exclusion: 24, slopeMax: 0.06 })) continue;
    const count = Math.floor(randRange(2, 4));
    let any = 0;
    for (let i = 0; i < count * 3 && any < count; i++) {
      const cx = px + randGauss(9);
      const cy = py + randGauss(9);
      if (any > 0 && !constraintsOk(cx, cy)) continue;
      place('pillar', any === 0 ? px : cx, any === 0 ? py : cy, randRange(0.13, 0.2), jitterStd());
      keepOuts.push({ px: cx, py: cy, radius: 5 });
      any += 1;
    }
    if (any > 0) placed += 1;
  }

  // ---- 1. Forest belt: clustered trees (lowland, noise-gated) ----
  let clusters = 0;
  for (let attempt = 0; attempt < 4000 && clusters < PROP_CONFIG.forestClusters; attempt++) {
    const { px, py } = randomLandPoint();
    if (!inBand(px, py, BAND.shoreMax, BAND.lowlandMax)) continue;
    if (forestNoise(px, py) < 0.55) continue;
    if (!constraintsOk(px, py)) continue;
    const clumpSize = Math.floor(randRange(PROP_CONFIG.clumpSizeMin, PROP_CONFIG.clumpSizeMax + 1));
    let placed = 0;
    for (let i = 0; i < clumpSize * 3 && placed < clumpSize; i++) {
      const tx = px + randGauss(22);
      const ty = py + randGauss(22);
      if (!inBand(tx, ty, BAND.shoreMax, BAND.lowlandMax)) continue;
      if (!constraintsOk(tx, ty)) continue;
      const typeB = rand() < 0.3;
      const ok = typeB
        ? place('treeB', tx, ty, randRange(0.08, 0.14), jitterStd())
        : place('treeA', tx, ty, randRange(0.10, 0.18), jitterStd());
      if (ok) placed += 1;
    }
    if (placed > 0) clusters += 1;
  }

  // ---- 2. Lone trees / rocks between clumps ----
  for (let attempt = 0, placed = 0; attempt < 3000 && placed < PROP_CONFIG.loneLowland; attempt++) {
    const { px, py } = randomLandPoint();
    if (!inBand(px, py, BAND.shoreMax, BAND.lowlandMax)) continue;
    if (forestNoise(px, py) >= 0.55) continue;
    if (!constraintsOk(px, py)) continue;
    const roll = rand();
    const ok = roll < 0.35
      ? place('rock', px, py, randRange(0.03, 0.08), jitterStd())
      : roll < 0.75
        ? place('treeA', px, py, randRange(0.10, 0.16), jitterStd())
        : place('treeB', px, py, randRange(0.08, 0.13), jitterStd());
    if (ok) placed += 1;
  }

  // ---- 3. Shore rocks (sparse, biased toward the mask edge) ----
  for (let attempt = 0, placed = 0; attempt < 4000 && placed < PROP_CONFIG.shoreRocks; attempt++) {
    const { px, py } = randomLandPoint();
    if (!inBand(px, py, 0.005, BAND.shoreMax)) continue;
    const { q, r } = pixelToAxial(px, py);
    if (!edgeHexes.has(`${q},${r}`) && rand() < 0.7) continue; // edge bias
    if (!constraintsOk(px, py)) continue;
    if (place('rock', px, py, randRange(0.03, 0.08), jitterStd())) placed += 1;
  }

  // ---- 4. Highland sparse scrub ----
  for (let attempt = 0, placed = 0; attempt < 4000 && placed < PROP_CONFIG.highlandScatter; attempt++) {
    const { px, py } = randomLandPoint();
    if (!inBand(px, py, BAND.lowlandMax, BAND.highlandMax)) continue;
    if (!constraintsOk(px, py)) continue;
    const roll = rand();
    const ok = roll < 0.45
      ? place('rock', px, py, randRange(0.03, 0.08), jitterStd())
      : roll < 0.85
        ? place('treeB', px, py, randRange(0.08, 0.14), jitterStd())
        : place('treeA', px, py, randRange(0.10, 0.14), jitterStd());
    if (ok) placed += 1;
  }

  // ---- 5. Peak slopes: crag clusters + rocks ----
  for (let attempt = 0, placed = 0; attempt < 5000 && placed < PROP_CONFIG.cragClusters; attempt++) {
    const { px, py } = randomLandPoint();
    if (!inBand(px, py, BAND.highlandMax, BAND.peakMax)) continue;
    if (!constraintsOk(px, py)) continue;
    const spikes = Math.floor(randRange(2, 5));
    let any = false;
    for (let s = 0; s < spikes; s++) {
      const sx = px + randGauss(6);
      const sy = py + randGauss(6);
      if (s > 0 && !constraintsOk(sx, sy)) continue;
      if (place('crag', s === 0 ? px : sx, s === 0 ? py : sy, randRange(0.12, 0.25), jitterStd())) any = true;
    }
    if (any) {
      placed += 1;
      // a couple of companion rocks
      for (let k = 0; k < 2; k++) {
        const rx = px + randGauss(14);
        const ry = py + randGauss(14);
        if (constraintsOk(rx, ry)) place('rock', rx, ry, randRange(0.03, 0.07), jitterStd());
      }
    }
  }

  // ---- 6. Fill pass: texture the barren gaps everywhere on land ----
  for (let attempt = 0, placed = 0; attempt < 12000 && placed < PROP_CONFIG.fillScatter; attempt++) {
    const { px, py } = randomLandPoint();
    if (!inBand(px, py, 0.02, 0.93)) continue;
    if (!constraintsOk(px, py)) continue;
    const roll = rand();
    let ok;
    if (roll < 0.3) ok = place('rock', px, py, randRange(0.025, 0.06), jitterStd());
    else if (roll < 0.6) ok = place('treeA', px, py, randRange(0.09, 0.15), jitterStd());
    else if (roll < 0.85) ok = place('treeB', px, py, randRange(0.07, 0.12), jitterStd());
    // small shrubs — bushy type at miniature scale
    else ok = place('treeB', px, py, randRange(0.045, 0.07), jitterStd());
    if (ok) placed += 1;
  }

  // ---- Write propMap.js ----
  const counts = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.length / 6]));
  console.log('Placed:', counts, 'total:', total);

  let js = '/**\n';
  js += ' * Procedural terrain prop placement (world coordinates, Y-up).\n';
  js += ` * Auto-generated by scripts/generatePropMap.js (seed ${PROP_SEED}) — do not edit.\n`;
  js += ' * Layout per record: [x, z, elevNorm, scale, rotY, jitter]\n';
  js += ' * jitter in [-1,1] = green brightness/hue drift; jitter > 1.5 = amber crater spike.\n';
  js += ' */\n';
  js += 'export const PROP_STRIDE = 6;\n\n';
  js += 'export const PROPS = {\n';
  for (const [type, arr] of Object.entries(props)) {
    js += `  // ${arr.length / 6} instances\n`;
    js += `  ${type}: [${arr.join(', ')}],\n`;
  }
  js += '};\n\n';
  js += `export const CRATER = ${JSON.stringify(crater)};\n`;
  writeFileSync(OUTPUT_PATH, js, 'utf-8');
  console.log('Written:', OUTPUT_PATH, `(${(js.length / 1024).toFixed(1)} KB)`);

  // ---- Debug scatter plot ----
  const dbg = createCanvas(IMG_WIDTH / 2, IMG_HEIGHT / 2);
  const dctx = dbg.getContext('2d');
  dctx.fillStyle = '#000';
  dctx.fillRect(0, 0, dbg.width, dbg.height);
  // faint heightmap underlay
  dctx.globalAlpha = 0.35;
  dctx.drawImage(img, 0, 0, dbg.width, dbg.height);
  dctx.globalAlpha = 1;
  // hex centers
  dctx.fillStyle = '#114422';
  for (const key of ISLAND_MASK) {
    const [q, r] = key.split(',').map(Number);
    const { x, y } = axialToPixel(q, r, HEX_SIZE);
    dctx.beginPath();
    dctx.arc((x + GRID_OFFSET_X) / 2, (y + GRID_OFFSET_Y) / 2, HEX_CENTER_EXCLUSION / 2, 0, Math.PI * 2);
    dctx.fill();
  }
  const dotColor = {
    treeA: '#00ff41', treeB: '#7dffa8', rock: '#3a7a55', crag: '#e8fff0',
    pillar: '#55ccff', ruin: '#00bfff', aqueduct: '#00bfff',
  };
  for (const [type, arr] of Object.entries(props)) {
    for (let i = 0; i < arr.length; i += 6) {
      const px = arr[i] * 100 + IMG_WIDTH / 2;
      const py = arr[i + 1] * 100 + IMG_HEIGHT / 2;
      dctx.fillStyle = arr[i + 5] > 1.5 ? '#ffaa00' : dotColor[type];
      dctx.fillRect(px / 2 - 1, py / 2 - 1, 2, 2);
    }
  }
  writeFileSync(DEBUG_PNG_PATH, dbg.toBuffer('image/png'));
  console.log('Debug plot:', DEBUG_PNG_PATH);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});

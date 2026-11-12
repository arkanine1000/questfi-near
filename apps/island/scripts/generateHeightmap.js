/**
 * Heightmap Generator — Quest Map 3D holographic war table
 *
 * Extends the generateMask.js approach into elevation data:
 *   1. Loads src/assets/island-map.png and computes per-pixel luminance.
 *   2. Downsamples to a 192x128 grid (8px cells, matches 1536x1024 aspect).
 *   3. Gaussian-blurs the grid so terrain is smooth, not spiky.
 *   4. Clamps cells outside the ISLAND_MASK neighborhood to elevation 0
 *      (ocean) with a smooth coastal falloff, then normalizes land to 0..1.
 *   5. Writes two artifacts:
 *        - src/assets/heightmap.png   (grayscale, used as displacementMap)
 *        - src/data/hexElevations.js  ({ "q,r": elevation } at hex centers)
 *
 * Usage: npm run generate:heightmap
 */

import { createCanvas, loadImage } from 'canvas';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration — grid constants must match HexGrid.jsx exactly
// ---------------------------------------------------------------------------
const HEX_SIZE = 46;
const GRID_OFFSET_X = 100;
const GRID_OFFSET_Y = 65;
const GRID_COLS = 18;
const GRID_ROWS = 14;

const IMG_WIDTH = 1536;
const IMG_HEIGHT = 1024;

// Downsampled heightmap grid (8px cells, same aspect as source image)
const GRID_W = 192;
const GRID_H = 128;
const CELL = IMG_WIDTH / GRID_W; // 8

// Gaussian blur radius in grid cells
const BLUR_RADIUS = 3;

// Elevation = LUM_WEIGHT * luminance + (1 - LUM_WEIGHT) * inland-distance dome.
// Pure luminance makes bright coastal texture compete with the volcano; the
// dome term guarantees the most inland region (the volcano) is the peak.
const LUM_WEIGHT = 0.55;

// Coastal falloff: full elevation within INNER px of a land hex center,
// fading to 0 (ocean) at OUTER px
const FALLOFF_INNER = HEX_SIZE * 0.9;
const FALLOFF_OUTER = HEX_SIZE * 2.0;

const IMAGE_PATH = resolve(__dirname, '../src/assets/island-map.png');
const HEIGHTMAP_PATH = resolve(__dirname, '../src/assets/heightmap.png');
const ELEVATIONS_PATH = resolve(__dirname, '../src/data/hexElevations.js');

// ---------------------------------------------------------------------------
// Hex math — duplicated from hexUtils.js to avoid ESM import issues
// ---------------------------------------------------------------------------
function axialToPixel(q, r, hexSize) {
  const x = hexSize * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
  const y = hexSize * ((3 / 2) * r);
  return { x, y };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

function gaussianKernel(radius) {
  const size = Math.ceil(radius * 3);
  const kernel = [];
  let sum = 0;
  for (let i = -size; i <= size; i++) {
    const w = Math.exp(-(i * i) / (2 * radius * radius));
    kernel.push(w);
    sum += w;
  }
  return kernel.map((w) => w / sum);
}

/** Separable gaussian blur on a GRID_W x GRID_H float array. */
function blurGrid(grid, radius) {
  const kernel = gaussianKernel(radius);
  const half = (kernel.length - 1) / 2;
  const tmp = new Float64Array(grid.length);
  const out = new Float64Array(grid.length);

  // Horizontal pass
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      let acc = 0;
      for (let k = 0; k < kernel.length; k++) {
        const sx = Math.min(Math.max(x + k - half, 0), GRID_W - 1);
        acc += grid[y * GRID_W + sx] * kernel[k];
      }
      tmp[y * GRID_W + x] = acc;
    }
  }
  // Vertical pass
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      let acc = 0;
      for (let k = 0; k < kernel.length; k++) {
        const sy = Math.min(Math.max(y + k - half, 0), GRID_H - 1);
        acc += tmp[sy * GRID_W + x] * kernel[k];
      }
      out[y * GRID_W + x] = acc;
    }
  }
  return out;
}

/** Bilinear sample of the grid at image-space pixel coords. */
function sampleGrid(grid, px, py) {
  const gx = Math.min(Math.max(px / CELL - 0.5, 0), GRID_W - 1.001);
  const gy = Math.min(Math.max(py / CELL - 0.5, 0), GRID_H - 1.001);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(x0 + 1, GRID_W - 1);
  const y1 = Math.min(y0 + 1, GRID_H - 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const a = grid[y0 * GRID_W + x0] * (1 - fx) + grid[y0 * GRID_W + x1] * fx;
  const b = grid[y1 * GRID_W + x0] * (1 - fx) + grid[y1 * GRID_W + x1] * fx;
  return a * (1 - fy) + b * fy;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Import the live mask so the pipeline always tracks hexUtils.js
  const { ISLAND_MASK } = await import('../src/components/HexGrid/hexUtils.js');

  console.log('Loading image:', IMAGE_PATH);
  const img = await loadImage(IMAGE_PATH);
  if (img.width !== IMG_WIDTH || img.height !== IMG_HEIGHT) {
    throw new Error(`Expected ${IMG_WIDTH}x${IMG_HEIGHT} image, got ${img.width}x${img.height}`);
  }

  const canvas = createCanvas(IMG_WIDTH, IMG_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, IMG_WIDTH, IMG_HEIGHT).data;

  // 1. Per-pixel luminance, downsampled to GRID_W x GRID_H by cell average
  let grid = new Float64Array(GRID_W * GRID_H);
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      let acc = 0;
      for (let dy = 0; dy < CELL; dy++) {
        for (let dx = 0; dx < CELL; dx++) {
          const px = gx * CELL + dx;
          const py = gy * CELL + dy;
          const i = (py * IMG_WIDTH + px) * 4;
          // Rec. 709 luminance
          acc += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        }
      }
      grid[gy * GRID_W + gx] = acc / (CELL * CELL) / 255;
    }
  }

  // 2. Gaussian blur — smooth terrain, no texture-noise spikes
  grid = blurGrid(grid, BLUR_RADIUS);

  // 3. Clamp to ISLAND_MASK neighborhood with smooth coastal falloff
  const landCenters = [];
  for (const key of ISLAND_MASK) {
    const [q, r] = key.split(',').map(Number);
    const { x, y } = axialToPixel(q, r, HEX_SIZE);
    landCenters.push({ x: x + GRID_OFFSET_X, y: y + GRID_OFFSET_Y });
  }

  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const px = (gx + 0.5) * CELL;
      const py = (gy + 0.5) * CELL;
      let minDistSq = Infinity;
      for (const c of landCenters) {
        const dx = px - c.x;
        const dy = py - c.y;
        const d = dx * dx + dy * dy;
        if (d < minDistSq) minDistSq = d;
      }
      const dist = Math.sqrt(minDistSq);
      const weight = 1 - smoothstep(FALLOFF_INNER, FALLOFF_OUTER, dist);
      grid[gy * GRID_W + gx] *= weight;
    }
  }

  // 3b. Blend in an inland-distance dome so the volcano is the visible peak.
  // BFS distance (in cells) from ocean across land cells, normalized.
  const land = grid.map((v) => v > 0.02);
  const dist = new Float64Array(grid.length).fill(-1);
  let frontier = [];
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const i = gy * GRID_W + gx;
      if (!land[i]) {
        dist[i] = 0;
        frontier.push(i);
      }
    }
  }
  let d = 0;
  while (frontier.length > 0) {
    d++;
    const next = [];
    for (const i of frontier) {
      const gx = i % GRID_W;
      const gy = (i / GRID_W) | 0;
      for (const [nx, ny] of [[gx + 1, gy], [gx - 1, gy], [gx, gy + 1], [gx, gy - 1]]) {
        if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
        const ni = ny * GRID_W + nx;
        if (dist[ni] === -1) {
          dist[ni] = d;
          next.push(ni);
        }
      }
    }
    frontier = next;
  }
  const maxDist = Math.max(...dist);
  let dome = new Float64Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    dome[i] = land[i] ? dist[i] / maxDist : 0;
  }
  dome = blurGrid(dome, BLUR_RADIUS);
  for (let i = 0; i < grid.length; i++) {
    if (!land[i]) continue;
    grid[i] = LUM_WEIGHT * grid[i] + (1 - LUM_WEIGHT) * dome[i];
  }

  // 4. Normalize land elevations to 0..1
  let max = 0;
  let peakCell = { gx: 0, gy: 0 };
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const v = grid[gy * GRID_W + gx];
      if (v > max) {
        max = v;
        peakCell = { gx, gy };
      }
    }
  }
  if (max <= 0) throw new Error('Heightmap is empty — check mask/falloff settings');
  for (let i = 0; i < grid.length; i++) grid[i] /= max;
  console.log(`Peak at grid cell (${peakCell.gx}, ${peakCell.gy}) ≈ image px (${(peakCell.gx + 0.5) * CELL | 0}, ${(peakCell.gy + 0.5) * CELL | 0})`);

  // 5a. Write grayscale heightmap PNG
  const outCanvas = createCanvas(GRID_W, GRID_H);
  const outCtx = outCanvas.getContext('2d');
  const outImage = outCtx.createImageData(GRID_W, GRID_H);
  for (let i = 0; i < grid.length; i++) {
    const v = Math.round(grid[i] * 255);
    outImage.data[i * 4] = v;
    outImage.data[i * 4 + 1] = v;
    outImage.data[i * 4 + 2] = v;
    outImage.data[i * 4 + 3] = 255;
  }
  outCtx.putImageData(outImage, 0, 0);
  writeFileSync(HEIGHTMAP_PATH, outCanvas.toBuffer('image/png'));
  console.log('Written:', HEIGHTMAP_PATH);

  // 5b. Sample elevation at every land hex center → hexElevations.js
  const rows = {};
  for (const key of ISLAND_MASK) {
    const [q, r] = key.split(',').map(Number);
    const { x, y } = axialToPixel(q, r, HEX_SIZE);
    const elev = sampleGrid(grid, x + GRID_OFFSET_X, y + GRID_OFFSET_Y);
    if (!rows[r]) rows[r] = [];
    rows[r].push({ q, elev });
  }

  let js = '/**\n';
  js += ' * Normalized terrain elevation (0..1) at each land hex center.\n';
  js += ' * Auto-generated by scripts/generateHeightmap.js — do not edit by hand.\n';
  js += ' */\n';
  js += 'export const HEX_ELEVATIONS = {\n';
  const sortedRows = Object.keys(rows).map(Number).sort((a, b) => a - b);
  for (const r of sortedRows) {
    rows[r].sort((a, b) => a.q - b.q);
    const entries = rows[r].map(({ q, elev }) => `'${q},${r}': ${elev.toFixed(4)}`).join(', ');
    js += `  // Row ${r}\n  ${entries},\n`;
  }
  js += '};\n';
  writeFileSync(ELEVATIONS_PATH, js, 'utf-8');
  console.log('Written:', ELEVATIONS_PATH);
  console.log(`Elevation entries: ${ISLAND_MASK.size} (mask size: ${ISLAND_MASK.size})`);

  // ASCII sanity check of elevations
  console.log('\n--- Elevation map (0-9 per land hex) ---\n');
  const elevByKey = {};
  for (const r of sortedRows) for (const { q, elev } of rows[r]) elevByKey[`${q},${r}`] = elev;
  for (let r = 0; r < GRID_ROWS; r++) {
    const indent = ' '.repeat(r);
    let row = `Row ${String(r).padStart(2)}: ${indent}`;
    for (let q = 0; q < GRID_COLS; q++) {
      const e = elevByKey[`${q},${r}`];
      row += e === undefined ? '. ' : `${Math.min(9, Math.floor(e * 10))} `;
    }
    console.log(row);
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});

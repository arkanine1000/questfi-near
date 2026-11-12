/**
 * Hex Island Mask Generator
 *
 * Analyzes the island reference image and generates a pixel-accurate
 * ISLAND_MASK Set for hexUtils.js. Uses the exact same hex grid math
 * as the app so hex centers line up precisely.
 *
 * Usage: node scripts/generateMask.js
 */

import { createCanvas, loadImage } from 'canvas';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration — must match HexGrid.jsx exactly
// ---------------------------------------------------------------------------
const HEX_SIZE = 46;
const GRID_OFFSET_X = 100;
const GRID_OFFSET_Y = 65;
const GRID_COLS = 18;
const GRID_ROWS = 14;

// Brightness threshold (0-255). Pixels with avg brightness above this are "land".
const BRIGHTNESS_THRESHOLD = 30;

// Sampling radius around each hex center (px) for multi-pixel sampling
const SAMPLE_RADIUS = 8;

// Number of sample points around center (evenly spaced on circle)
const SAMPLE_POINTS = 8;

// Path to source image
const IMAGE_PATH = resolve(__dirname, '../src/assets/island-map.png');

// Output path
const OUTPUT_PATH = resolve(__dirname, 'generated-mask.js');

// ---------------------------------------------------------------------------
// Hex math — duplicated from hexUtils.js to avoid ESM import issues
// ---------------------------------------------------------------------------
function axialToPixel(q, r, hexSize) {
  const x = hexSize * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
  const y = hexSize * ((3 / 2) * r);
  return { x, y };
}

function getHexNeighbors(q, r) {
  return [
    { q: q + 1, r: r },
    { q: q - 1, r: r },
    { q: q, r: r + 1 },
    { q: q, r: r - 1 },
    { q: q + 1, r: r - 1 },
    { q: q - 1, r: r + 1 },
  ];
}

// ---------------------------------------------------------------------------
// Image sampling
// ---------------------------------------------------------------------------

/**
 * Get brightness at a single pixel (clamped to image bounds).
 * Returns (R + G + B) / 3.
 */
function getBrightness(imageData, width, height, px, py) {
  const ix = Math.round(px);
  const iy = Math.round(py);
  if (ix < 0 || ix >= width || iy < 0 || iy >= height) return 0;

  const idx = (iy * width + ix) * 4;
  const r = imageData[idx];
  const g = imageData[idx + 1];
  const b = imageData[idx + 2];
  return (r + g + b) / 3;
}

/**
 * Sample brightness at a hex center plus surrounding points.
 * Returns the MAX brightness found (to avoid false negatives from
 * dark terrain features like the crater).
 */
function sampleHexBrightness(imageData, width, height, cx, cy) {
  let maxBrightness = getBrightness(imageData, width, height, cx, cy);

  for (let i = 0; i < SAMPLE_POINTS; i++) {
    const angle = (2 * Math.PI * i) / SAMPLE_POINTS;
    const sx = cx + SAMPLE_RADIUS * Math.cos(angle);
    const sy = cy + SAMPLE_RADIUS * Math.sin(angle);
    const b = getBrightness(imageData, width, height, sx, sy);
    if (b > maxBrightness) maxBrightness = b;
  }

  return maxBrightness;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('Loading image:', IMAGE_PATH);
  const img = await loadImage(IMAGE_PATH);
  const width = img.width;
  const height = img.height;
  console.log(`Image dimensions: ${width} x ${height}`);

  // Draw image onto canvas to access pixel data
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height).data;

  // Pass 1: Brightness-based land detection
  const landSet = new Set();
  const allHexes = [];

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let q = 0; q < GRID_COLS; q++) {
      const { x, y } = axialToPixel(q, r, HEX_SIZE);
      // Apply the same offset as the app's <g transform="translate(...)">
      const px = x + GRID_OFFSET_X;
      const py = y + GRID_OFFSET_Y;

      allHexes.push({ q, r, px, py });

      const brightness = sampleHexBrightness(imageData, width, height, px, py);

      if (brightness > BRIGHTNESS_THRESHOLD) {
        landSet.add(`${q},${r}`);
      }
    }
  }

  console.log(`\nPass 1 (brightness): ${landSet.size} land hexes`);

  // Pass 2: Flood fill — dark hexes fully surrounded by land become land
  let changed = true;
  let iteration = 0;
  while (changed) {
    changed = false;
    iteration++;
    for (const hex of allHexes) {
      const key = `${hex.q},${hex.r}`;
      if (landSet.has(key)) continue;

      const neighbors = getHexNeighbors(hex.q, hex.r);
      const allNeighborsLand = neighbors.every((n) => {
        // Neighbors outside grid bounds don't count as land
        if (n.q < 0 || n.q >= GRID_COLS || n.r < 0 || n.r >= GRID_ROWS) return false;
        return landSet.has(`${n.q},${n.r}`);
      });

      if (allNeighborsLand) {
        landSet.add(key);
        changed = true;
      }
    }
  }

  console.log(`Pass 2 (flood fill): ${landSet.size} land hexes after ${iteration} iterations`);

  // Build sorted mask array grouped by row
  const maskByRow = {};
  for (const key of landSet) {
    const [q, r] = key.split(',').map(Number);
    if (!maskByRow[r]) maskByRow[r] = [];
    maskByRow[r].push(q);
  }

  // Sort each row
  for (const r in maskByRow) {
    maskByRow[r].sort((a, b) => a - b);
  }

  // Generate JS output
  let jsOutput = 'export const ISLAND_MASK = new Set([\n';
  const rows = Object.keys(maskByRow)
    .map(Number)
    .sort((a, b) => a - b);

  for (const r of rows) {
    const entries = maskByRow[r].map((q) => `'${q},${r}'`).join(', ');
    jsOutput += `  // Row ${r}\n`;
    jsOutput += `  ${entries},\n\n`;
  }
  jsOutput += ']);\n';

  // Print to console
  console.log('\n--- Generated ISLAND_MASK ---\n');
  console.log(jsOutput);

  // ASCII visualization
  console.log('--- ASCII Map ---\n');
  for (let r = 0; r < GRID_ROWS; r++) {
    const indent = r % 2 === 1 ? ' ' : '';
    let row = `Row ${String(r).padStart(2)}: ${indent}`;
    for (let q = 0; q < GRID_COLS; q++) {
      row += landSet.has(`${q},${r}`) ? '# ' : '. ';
    }
    console.log(row);
  }
  console.log('');

  // Write to file
  writeFileSync(OUTPUT_PATH, jsOutput, 'utf-8');
  console.log(`Written to: ${OUTPUT_PATH}`);
  console.log(`Total land hexes: ${landSet.size}`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});

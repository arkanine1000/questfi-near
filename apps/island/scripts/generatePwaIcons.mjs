/**
 * PWA icon set from public/brand/quest-logo.png.
 *
 * - icon-192 / icon-512: transparent, purpose "any"
 * - icon-maskable-512: solid CRT-dark card with the logo inside the 80%
 *   safe zone (maskable icons get cropped to circles/squircles)
 * - apple-touch-icon (180): solid card — iOS composites no alpha
 *
 * Usage: node scripts/generatePwaIcons.mjs
 */
import { createCanvas, loadImage } from 'canvas';
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BG = '#02140a';

const logo = await loadImage(path.join(PUBLIC, 'brand', 'quest-logo.png'));

function render(size, { solid, content }) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  if (solid) {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, size, size);
  }
  const box = size * content;
  const scale = Math.min(box / logo.width, box / logo.height);
  const w = logo.width * scale;
  const h = logo.height * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(logo, (size - w) / 2, (size - h) / 2, w, h);
  return c.toBuffer('image/png');
}

const JOBS = [
  ['icon-192.png', 192, { solid: false, content: 0.94 }],
  ['icon-512.png', 512, { solid: false, content: 0.94 }],
  ['icon-maskable-512.png', 512, { solid: true, content: 0.72 }],
  ['apple-touch-icon.png', 180, { solid: true, content: 0.82 }],
];

for (const [name, size, opts] of JOBS) {
  writeFileSync(path.join(PUBLIC, 'icons', name), render(size, opts));
  console.log(`${name}: ${size}x${size}`);
}

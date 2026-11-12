/**
 * One-shot cleanup for the Prompt-chan expression sprites.
 *
 * The mood/gesture renders came off the generator on an opaque black card,
 * while the base + talk sprites carry real cut-out alpha. The overlay
 * composites against the live map, so black cards would read as floating
 * rectangles. Measured split: background noise tops out around channel
 * value ~30, the darkest garment fills start ~40 — so everything below
 * CUT goes fully transparent and the CUT..RAMP band fades out to keep
 * keyed edges from crunching.
 *
 * Usage: node scripts/normalizePromptChanSprites.mjs
 * Idempotent — already-keyed pixels just stay transparent.
 *
 * NOTE: the .png sources below are no longer in the tree — the keyed
 * output was converted to .webp and only those ship. Drop the renders
 * back into public/prompt-chan/ before re-running, or delete this script
 * if the sprite set is final.
 */
import { createCanvas, loadImage } from 'canvas';
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'prompt-chan');

const FILES = [
  'happy-1.png',
  'happy-2.png',
  'happy-3.png',
  'surprised-1.png',
  'surprised-2.png',
  'surprised-3.png',
  'gesture-point.png',
  'gesture-wave.png',
];

const CUT = 20;
const RAMP = 36;

for (const name of FILES) {
  const file = path.join(PUBLIC, name);
  const img = await loadImage(file);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const image = ctx.getImageData(0, 0, img.width, img.height);
  const d = image.data;
  let keyed = 0;
  for (let i = 0; i < d.length; i += 4) {
    const m = Math.max(d[i], d[i + 1], d[i + 2]);
    if (m < CUT) {
      d[i + 3] = 0;
      keyed++;
    } else if (m < RAMP) {
      d[i + 3] = Math.round((d[i + 3] * (m - CUT)) / (RAMP - CUT));
    }
  }
  ctx.putImageData(image, 0, 0);
  writeFileSync(file, canvas.toBuffer('image/png'));
  console.log(`${name}: keyed ${((keyed / (d.length / 4)) * 100).toFixed(1)}% of pixels`);
}

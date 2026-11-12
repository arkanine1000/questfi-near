/**
 * Pack an ordered list of equal-sized frames into a horizontal sprite strip,
 * plus a sidecar manifest describing the layout.
 *
 * This is the project's sprite-animation convention, established with the
 * torch flame. The runtime half lives in
 * src/components/Scene3D/Crawler/spriteSheet.js, which reads the same
 * manifest shape.
 *
 * Frames are laid out left-to-right in a single row. One row keeps the
 * runtime math to a single `offset.x` step and keeps the texture within the
 * 2D sampler width limits for any frame count we'd plausibly hand-author;
 * if a sheet ever needs a grid, the manifest already carries `columns`/
 * `rows` so the runtime doesn't have to change.
 *
 * node-canvas cannot encode webp (the same reason prepAgentSprites.mjs
 * emits PNG), so this writes PNG and the shipped webp is a second step:
 *
 *   node scripts/buildSpriteSheet.mjs
 *   convert public/crawler/fx/flame-sheet.png \
 *     -define webp:exact=true -quality 90 public/crawler/fx/flame-sheet.webp
 *
 * `webp:exact=true` is load-bearing: libwebp otherwise clears the RGB of
 * fully-transparent pixels, which makes bilinear filtering bleed black into
 * the sprite's soft edges.
 *
 * Usage: node scripts/buildSpriteSheet.mjs
 */
import { createCanvas, loadImage } from 'canvas';
import { writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * node-canvas decodes PNG/JPEG only — no webp, in either direction. Source
 * frames are authored as webp, so pipe them through ImageMagick (already
 * required for the encode step below) into an in-memory PNG buffer, which
 * loadImage accepts directly.
 */
async function loadFrame(absPath) {
  if (!/\.webp$/i.test(absPath)) return loadImage(absPath);
  const png = execFileSync('convert', [absPath, 'png:-'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return loadImage(png);
}

const JOBS = [
  {
    out: 'public/crawler/fx/flame-sheet.png',
    frames: [
      'temp/flame_sprite1.webp',
      'temp/flame_sprite2.webp',
      'temp/flame_sprite3.webp',
    ],
  },
];

for (const job of JOBS) {
  const images = [];
  for (const rel of job.frames) {
    images.push(await loadFrame(path.join(ROOT, rel)));
  }

  // A mismatched frame would silently shear the whole animation — the
  // runtime slices by a single constant frame width.
  const { width: fw, height: fh } = images[0];
  images.forEach((img, i) => {
    if (img.width !== fw || img.height !== fh) {
      throw new Error(
        `${job.frames[i]} is ${img.width}x${img.height}, expected ${fw}x${fh} `
        + '— every frame in a sheet must share one size',
      );
    }
  });

  const columns = images.length;
  const sheet = createCanvas(fw * columns, fh);
  const ctx = sheet.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  images.forEach((img, i) => ctx.drawImage(img, i * fw, 0));

  const outPath = path.join(ROOT, job.out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, sheet.toBuffer('image/png'));

  const manifest = {
    frameWidth: fw,
    frameHeight: fh,
    frames: columns,
    columns,
    rows: 1,
  };
  const manifestPath = outPath.replace(/\.png$/, '.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `${job.out}: ${fw * columns}x${fh} — ${columns} frames of ${fw}x${fh}`,
  );
}

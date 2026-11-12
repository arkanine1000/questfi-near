/**
 * Build the hand-alignment template for the Aethermaw boss sprite sheet.
 *
 * The two gen-AI source strips (temp/aethermaw_fly.png, temp/aethermaw_attack.png)
 * are each 4 frames of 543x724 packed edge-to-edge with NO gutter, and the
 * content genuinely bleeds across the seams: the fly strip's cells 3 and 4 run
 * to x=0/x=542 and their wingtips abut at absolute x~1085, and the attack
 * strip's beam frame is the full 543 wide — the beam exits left into cell 2,
 * the wing exits right into cell 4. Automated bbox registration would have to
 * special-case the beam frame, which is exactly the kind of thing that looks
 * fine in a unit test and wrong on screen.
 *
 * So this script does NOT try to register the frames. It lays them out
 * pre-scaled and pre-positioned on the target grid and hands the job to
 * Photoshop, where a human can nudge and erase.
 *
 * Outputs (all under temp/, which is gitignored):
 *
 *   temp/aethermaw-template.psd      layered: 6 frame layers, grid on top
 *   temp/aethermaw-grid.png          the grid/safe-area overlay on its own
 *   temp/aethermaw-frames/f0..f5.png each layer as a standalone 1536x1024 RGBA
 *
 * The loose PNGs are the fallback: ImageMagick's PSD writer is the only part
 * of this that can plausibly produce something Photoshop dislikes, and if it
 * does, the frames can be dropped into a fresh document by hand.
 *
 * Once the frames are aligned, flatten and export a 1536x1024 PNG, then encode
 * the shipped asset:
 *
 *   convert temp/aethermaw-sheet.png -define webp:exact=true -quality 90 \
 *     public/crawler/enemies/aethermaw-sheet.webp
 *
 * ~130KB, and lossy is the right call despite this being thin neon linework.
 * Whole-image PSNR reads a scary 33.9dB, but that number is dominated by the
 * black card: measured over lit pixels only the mean error is 2.1/255, and at
 * 1:1 the encode is indistinguishable from the source. The sprite is also
 * additively blended at 0.9 opacity over a dark scene and rarely sampled above
 * 1:1, which hides more still. Lossless encodes to ~790KB for no visible gain.
 *
 * Two deliberate choices worth knowing:
 *
 * 1. Frames are extracted WITH CONTEXT (60px of the neighbouring cell on each
 *    side), not on a tight 543 crop. The bleed is the whole problem — you
 *    cannot erase what the template has already cropped away.
 *
 * 2. Layers are alpha-keyed (black -> transparent) even though the shipped
 *    asset does not need it. That is a working convenience, not an asset
 *    decision: opaque black layers would each hide the ones beneath and make
 *    alignment against the grid impossible. Flatten onto the black background
 *    layer on export and the result is a black-background sheet again, which
 *    is what the additive-blended enemy material wants.
 *
 * Usage: node scripts/buildAethermawTemplate.mjs
 */
import { createCanvas, loadImage } from 'canvas';
import { writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- Target sheet geometry -------------------------------------------------
// 512 cells keep the sheet a clean power of two (2048x1024) and give the
// runtime an exact 1.0 aspect, so crawlerAssets.js can hardcode `aspect: 1`
// instead of deriving it.
const CELL = 512;
const COLUMNS = 3;
const ROWS = 2;
const SHEET_W = CELL * COLUMNS; // 1536
const SHEET_H = CELL * ROWS; // 1024

// The gutter is what permanently kills the bleed: with every wingtip inside
// the safe box, spriteSheet.js's half-texel inset has margin to spare.
const GUTTER = 20;
const SAFE = CELL - GUTTER * 2; // 472
const BASELINE = CELL - GUTTER; // 492 — cell-local y the tail/feet sit on

// --- Source geometry -------------------------------------------------------
const SRC_FRAME_W = 543;
const SRC_FRAME_H = 724;
const SRC_FRAMES = 4;
const CONTEXT = 60; // px of the neighbouring cell to carry into each layer

// Measured across all 8 frames of both strips: content is bottom-anchored at
// y = 553..577 and spans y = 78..577. Registering on the bottom is what makes
// a single uniform transform land every frame close enough to nudge.
const SRC_BASELINE = 574;
const SRC_CENTER_X = SRC_FRAME_W / 2;

// One uniform scale for all 8 frames — fit the 543 width into the safe box.
// Uniform matters: the pose variation between frames (wing elevation, head
// pitch) IS the animation, and per-frame autoscaling would flatten it out.
const SCALE = SAFE / SRC_FRAME_W; // ~0.869

// Black-to-alpha ramp, same shape as normalizePromptChanSprites.mjs. RGB is
// preserved so the neon glow survives; only alpha is touched.
//
// These are far lower than that script's 20/36, and deliberately so. Measured
// on these strips, the background floor is a true max=1 — the card is
// essentially perfect black — while ~400k pixels of real content (outer glow,
// dark interior linework) sit in the 1..40 range. A cut anywhere near 20 eats
// the dragon. Key at the actual floor instead, with a 5-step ramp only to
// avoid a hard 1px edge.
const KEY_CUT = 1;
const KEY_RAMP = 6;

/**
 * Target cell order — 3 frames per state, one state per row.
 *
 * Row 0 is the idle flap, ordered by WING ELEVATION rather than source order,
 * so pingPongFrame(t, 3, fps) -> 0,1,2,1 reads as a literal down-up-down beat
 * instead of a shuffle. This is the same 3-frame ping-pong the torch flame
 * uses, which is the point: no new runtime concept.
 *
 * Two source frames are dropped as redundant. Fly's source f0 is the same
 * wings-spread pose as f3 at a more extreme extension; attack's source f0
 * (windup) is nearly identical to f1 (roar), and the attack beat is only 0.4s
 * — three frames is already one per ~130ms.
 */
const LAYOUT = [
  { name: 'fly-low', strip: 'fly', index: 2 },
  { name: 'fly-mid', strip: 'fly', index: 1 },
  { name: 'fly-up', strip: 'fly', index: 3 },
  { name: 'atk-roar', strip: 'attack', index: 1 },
  { name: 'atk-beam', strip: 'attack', index: 2 },
  { name: 'atk-fade', strip: 'attack', index: 3 },
];

const STRIPS = {
  fly: 'temp/aethermaw_fly.png',
  attack: 'temp/aethermaw_attack.png',
};

/** Replace the black card with alpha, preserving RGB (and so the glow). */
function keyBlack(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const m = Math.max(d[i], d[i + 1], d[i + 2]);
    if (m < KEY_CUT) d[i + 3] = 0;
    else if (m < KEY_RAMP) {
      d[i + 3] = Math.round((d[i + 3] * (m - KEY_CUT)) / (KEY_RAMP - KEY_CUT));
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

const cellOrigin = (i) => ({
  x: (i % COLUMNS) * CELL,
  y: Math.floor(i / COLUMNS) * CELL,
});

/** One full-canvas RGBA layer holding a single pre-placed source frame. */
function buildFrameLayer(strip, index, slot) {
  const canvas = createCanvas(SHEET_W, SHEET_H);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  const { x: cx, y: cy } = cellOrigin(slot);

  // Source rect, widened by CONTEXT on both sides and clamped to the strip.
  const rawX = index * SRC_FRAME_W - CONTEXT;
  const sx = Math.max(0, rawX);
  const sw = Math.min(SRC_FRAME_W + CONTEXT * 2 - (sx - rawX), strip.width - sx);

  // Map source (SRC_CENTER_X, SRC_BASELINE) -> cell (CELL/2, BASELINE).
  const dx = cx + CELL / 2 - (SRC_CENTER_X - (sx - index * SRC_FRAME_W)) * SCALE;
  const dy = cy + BASELINE - SRC_BASELINE * SCALE;

  ctx.drawImage(strip, sx, 0, sw, SRC_FRAME_H, dx, dy, sw * SCALE, SRC_FRAME_H * SCALE);
  return keyBlack(canvas);
}

/** Cell boundaries, safe boxes, baselines and labels — the alignment guide. */
function buildGrid() {
  const canvas = createCanvas(SHEET_W, SHEET_H);
  const ctx = canvas.getContext('2d');

  LAYOUT.forEach((entry, i) => {
    const { x, y } = cellOrigin(i);

    // cell boundary — the hard edge nothing may touch
    ctx.strokeStyle = 'rgba(255,64,64,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, CELL - 2, CELL - 2);

    // safe box — keep every wingtip inside this
    ctx.strokeStyle = 'rgba(80,180,255,0.85)';
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 1;
    ctx.strokeRect(x + GUTTER, y + GUTTER, SAFE, SAFE);
    ctx.setLineDash([]);

    // baseline — tail/feet sit here
    ctx.strokeStyle = 'rgba(255,220,64,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + GUTTER, y + BASELINE);
    ctx.lineTo(x + CELL - GUTTER, y + BASELINE);
    ctx.stroke();

    // centerline — body centers here, IGNORING the beam
    ctx.strokeStyle = 'rgba(255,220,64,0.45)';
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.moveTo(x + CELL / 2, y + GUTTER);
    ctx.lineTo(x + CELL / 2, y + BASELINE);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '16px sans-serif';
    ctx.fillText(`${i}  ${entry.name}`, x + GUTTER + 4, y + GUTTER + 20);
  });

  return canvas;
}

// --- Build -----------------------------------------------------------------
const outDir = path.join(ROOT, 'temp');
const frameDir = path.join(outDir, 'aethermaw-frames');
mkdirSync(frameDir, { recursive: true });

const strips = {};
for (const [key, rel] of Object.entries(STRIPS)) {
  const img = await loadImage(path.join(ROOT, rel));
  if (img.width !== SRC_FRAME_W * SRC_FRAMES || img.height !== SRC_FRAME_H) {
    throw new Error(
      `${rel} is ${img.width}x${img.height}, expected `
      + `${SRC_FRAME_W * SRC_FRAMES}x${SRC_FRAME_H} — `
      + 'the layout constants in this script assume 4 frames of 543x724',
    );
  }
  strips[key] = img;
}

// Black background: the layer everything gets flattened onto, and what makes
// the alpha-keyed frame layers read the way the shipped asset will.
const bg = createCanvas(SHEET_W, SHEET_H);
const bgCtx = bg.getContext('2d');
bgCtx.fillStyle = '#000000';
bgCtx.fillRect(0, 0, SHEET_W, SHEET_H);
const bgPath = path.join(frameDir, 'background.png');
writeFileSync(bgPath, bg.toBuffer('image/png'));

const layerPaths = [];
LAYOUT.forEach((entry, i) => {
  const canvas = buildFrameLayer(strips[entry.strip], entry.index, i);
  const p = path.join(frameDir, `f${i}-${entry.name}.png`);
  writeFileSync(p, canvas.toBuffer('image/png'));
  layerPaths.push({ path: p, label: `${i}-${entry.name}` });
});

const gridPath = path.join(outDir, 'aethermaw-grid.png');
writeFileSync(gridPath, buildGrid().toBuffer('image/png'));

// ImageMagick writes a multi-layer PSD from a sequence of images; -label names
// each layer so the Photoshop layer list is readable. Bottom-to-top order:
// background, the eight frames, grid on top.
//
// The black background layer is deliberately NOT in the PSD. ImageMagick 6's
// PSD writer takes the whole document's colour mode from the FIRST image in
// the sequence, and a pure-black canvas is detected as grayscale — which
// writes a 2-channel mode-1 PSD and throws away every layer's colour and
// alpha. Leading with a frame instead yields 4-channel mode-3 RGB. No
// combination of -colorspace/-type/-alpha fixes it; only the ordering does.
//
// Nothing is lost: exporting with alpha is equivalent to exporting on black
// for an additive-blended material. background.png is still written to the
// frames dir for anyone who wants to flatten onto it explicitly.
const psdPath = path.join(outDir, 'aethermaw-template.psd');
const args = [];
for (const { path: p, label } of layerPaths) args.push('-label', label, p);
args.push('-label', 'GRID (hide before export)', gridPath, psdPath);
execFileSync('convert', args, { maxBuffer: 512 * 1024 * 1024 });

console.log(`temp/aethermaw-template.psd — ${SHEET_W}x${SHEET_H}, `
  + `${COLUMNS}x${ROWS} cells of ${CELL}, safe box ${SAFE}, baseline y=${BASELINE}`);
console.log(`temp/aethermaw-grid.png, temp/aethermaw-frames/ — ${layerPaths.length} layers + background`);

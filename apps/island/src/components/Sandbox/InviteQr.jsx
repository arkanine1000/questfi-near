/**
 * The invite as a thing you can point a phone at.
 *
 * Carries the same payload as the copy button above it — the instruction
 * line, not the bare URL — for the case the copy button can't serve: the
 * agent lives on a different machine than the lobby is open on. Scanning
 * gives you the whole sentence to hand over, so the phone that reads it is
 * a courier rather than a browser.
 *
 * Drawn by hand onto a canvas rather than taking `qrcode`'s stock PNG, so the
 * code wears the same phosphor chrome as the rest of the console: rounded
 * modules, hollow-ring finder eyes, a mark knocked out of the middle.
 * Error correction H buys back the modules the knockout eats.
 */

import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

const INK = '#35ff7d';
const INK_BRIGHT = '#7dffb0';
const PANEL = 'rgba(2, 22, 10, 0.92)';
const MONO = "'Courier New', 'Consolas', monospace";
const SIZE = 512; // fixed backing resolution; CSS sizes it on screen

function draw(canvas, text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'H' });
  const n = qr.modules.size;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const pad = Math.round(W * 0.09); // >= 4-module quiet zone
  const cell = (W - pad * 2) / n;

  ctx.clearRect(0, 0, W, W);

  ctx.fillStyle = PANEL;
  ctx.fillRect(0, 0, W, W);
  ctx.strokeStyle = 'rgba(53, 255, 125, 0.4)';
  ctx.lineWidth = 2;
  ctx.strokeRect(9, 9, W - 18, W - 18);

  const inFinder = (x, y) =>
    (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);

  const hole = Math.max(3, Math.floor(n * 0.14));
  const h0 = Math.floor((n - hole) / 2);
  const inHole = (x, y) => x >= h0 && x < h0 + hole && y >= h0 && y < h0 + hole;

  // data modules: near-full rounded squares — styled, but a downscale to
  // phone-camera size must still resolve them, so the gaps stay hairline
  ctx.fillStyle = INK;
  const inset = cell * 0.04;
  const rad = cell * 0.16;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!qr.modules.get(x, y) || inFinder(x, y) || inHole(x, y)) continue;
      ctx.beginPath();
      ctx.roundRect(pad + x * cell + inset, pad + y * cell + inset, cell - inset * 2, cell - inset * 2, rad);
      ctx.fill();
    }
  }

  // finder eyes: classic 7/5/3 proportions, lightly rounded
  const eye = (gx, gy) => {
    const ox = pad + gx * cell;
    const oy = pad + gy * cell;
    ctx.strokeStyle = INK;
    ctx.lineWidth = cell;
    ctx.beginPath();
    ctx.roundRect(ox + cell * 0.5, oy + cell * 0.5, cell * 6, cell * 6, cell * 1.2);
    ctx.stroke();
    ctx.fillStyle = INK_BRIGHT;
    ctx.beginPath();
    ctx.roundRect(ox + cell * 2, oy + cell * 2, cell * 3, cell * 3, cell * 0.7);
    ctx.fill();
  };
  eye(0, 0);
  eye(n - 7, 0);
  eye(0, n - 7);

  // center mark: a chip with a plain letter rather than a pictorial glyph —
  // the mono stack has no sword or flag, and the fallback font that does have
  // one is nobody's idea of the console's typeface
  const c = pad + (n * cell) / 2;
  const chip = hole * cell;
  ctx.fillStyle = INK_BRIGHT;
  ctx.beginPath();
  ctx.roundRect(c - chip / 2, c - chip / 2, chip, chip, chip * 0.28);
  ctx.fill();
  ctx.fillStyle = PANEL;
  ctx.font = `700 ${chip * 0.72}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Q', c, c + chip * 0.04);
}

export default function InviteQr({ text }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !text) return;
    try {
      draw(canvas, text);
    } catch {
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    }
  }, [text]);

  return (
    <div className="qf-inviteqr">
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        className="qf-inviteqr__canvas"
        aria-label="QR code for this lobby's agent invite"
        role="img"
      />
    </div>
  );
}

/**
 * The invite as a thing you can point a phone at.
 *
 * Carries the same payload as the copy button beside it (the instruction
 * line, not the bare URL) for the case the copy button can't serve: the
 * agent lives on a different machine than the lobby is open on. Scanning
 * gives you the whole sentence to hand over, so the phone that reads it is
 * a courier rather than a browser.
 *
 * Drawn by hand onto a canvas rather than taking `qrcode`'s stock PNG, so the
 * code wears the house look: square phosphor modules, hollow finder eyes, a
 * chip with a VT323 "Q" knocked out of the middle. Error correction H buys
 * back the modules the knockout eats. The corner brackets around it are the
 * page's (qf-frame), not the canvas's.
 */

import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { PALETTE } from '../../styles/palette';

const SIZE = 512; // fixed backing resolution; CSS sizes it on screen
const FACE = "'VT323', ui-monospace, monospace";

function draw(canvas, text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'H' });
  const n = qr.modules.size;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const pad = Math.round(W * 0.09); // >= 4-module quiet zone
  const cell = (W - pad * 2) / n;

  ctx.clearRect(0, 0, W, W);
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, W, W);

  const inFinder = (x, y) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);

  const hole = Math.max(3, Math.floor(n * 0.14));
  const h0 = Math.floor((n - hole) / 2);
  const inHole = (x, y) => x >= h0 && x < h0 + hole && y >= h0 && y < h0 + hole;

  // data modules: near-full squares. A downscale to phone-camera size must
  // still resolve them, so the gaps stay hairline.
  ctx.fillStyle = PALETTE.green;
  const inset = cell * 0.06;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!qr.modules.get(x, y) || inFinder(x, y) || inHole(x, y)) continue;
      ctx.fillRect(pad + x * cell + inset, pad + y * cell + inset, cell - inset * 2, cell - inset * 2);
    }
  }

  // finder eyes: the classic 7/5/3 proportions, square
  const eye = (gx, gy) => {
    const ox = pad + gx * cell;
    const oy = pad + gy * cell;
    ctx.strokeStyle = PALETTE.green;
    ctx.lineWidth = cell;
    ctx.strokeRect(ox + cell * 0.5, oy + cell * 0.5, cell * 6, cell * 6);
    ctx.fillStyle = PALETTE.greenBright;
    ctx.fillRect(ox + cell * 2, oy + cell * 2, cell * 3, cell * 3);
  };
  eye(0, 0);
  eye(n - 7, 0);
  eye(0, n - 7);

  // centre mark: a chip with a plain letter rather than a pictorial glyph
  const c = pad + (n * cell) / 2;
  const chip = hole * cell;
  ctx.fillStyle = PALETTE.greenBright;
  ctx.fillRect(c - chip / 2, c - chip / 2, chip, chip);
  ctx.fillStyle = PALETTE.bg;
  ctx.font = `${Math.round(chip * 0.95)}px ${FACE}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Q', c, c + chip * 0.04);
}

export default function InviteQr({ text }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !text) return undefined;
    let live = true;
    const paint = () => {
      if (!live) return;
      try {
        draw(canvas, text);
      } catch {
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      }
    };
    paint();
    // A canvas draws with whatever face is loaded right now. VT323 arrives
    // from the font service, so draw again once it is in.
    document.fonts?.load(`40px ${FACE}`).then(paint, () => {});
    return () => { live = false; };
  }, [text]);

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      className="qf-onb-qr"
      aria-label="QR code for this lobby's agent invite"
      role="img"
    />
  );
}

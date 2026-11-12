import * as THREE from 'three';

// Procedural canvas textures: glowing grid tiles + sign plaques.

export function makeGridTexture({
  size = 256,
  lineColor = 'rgba(53,255,125,1)',
  glowColor = 'rgba(30,180,90,0.55)',
  bg = '#020a05',
  lineWidth = 2,
  glowWidth = 7,
  brightness = 1,
} = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  // faint inner noise/texture so tiles don't look flat black
  ctx.fillStyle = 'rgba(40,120,70,0.05)';
  for (let i = 0; i < 60; i++) {
    ctx.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
  }

  ctx.globalAlpha = brightness;
  // soft glow pass then crisp line pass, drawn on the tile edges
  for (const [color, w] of [
    [glowColor, glowWidth],
    [lineColor, lineWidth],
  ]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.strokeRect(0, 0, size, size);
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function makeSignTexture(label, { sub = '', hot = false, arrow = true } = {}) {
  const w = 1024;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');

  const glow = hot ? 1.5 : 1;

  // panel background
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, hot ? '#06351a' : '#03200f');
  grad.addColorStop(1, hot ? '#032512' : '#02150a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // scanline texture inside the panel
  ctx.fillStyle = 'rgba(53,255,125,0.045)';
  for (let y = 0; y < h; y += 6) ctx.fillRect(0, y, w, 2);

  // border
  ctx.strokeStyle = `rgba(53,255,125,${0.85 * glow > 1 ? 1 : 0.85 * glow})`;
  ctx.lineWidth = 6;
  ctx.shadowColor = 'rgba(53,255,125,0.9)';
  ctx.shadowBlur = 24 * glow;
  ctx.strokeRect(10, 10, w - 20, h - 20);

  // text
  ctx.shadowBlur = 30 * glow;
  ctx.fillStyle = hot ? '#b9ffd6' : '#6dffa4';
  ctx.font = '700 108px "Chakra Petch", "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(arrow ? `‹  ${label}` : label, 56, h / 2 + (sub ? -20 : 4), w - 120);

  if (sub) {
    ctx.shadowBlur = 12;
    ctx.fillStyle = 'rgba(140,255,180,0.65)';
    ctx.font = '500 40px "Chakra Petch", "Segoe UI", system-ui, sans-serif';
    ctx.fillText(sub, 60, h / 2 + 68);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

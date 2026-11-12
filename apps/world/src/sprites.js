import * as THREE from 'three';

// Canvas sprites shared by the sim: nameplates, floating shouts, glow dots.

export const css = (hex) => `#${hex.toString(16).padStart(6, '0')}`;

export function makeTextSprite(text, colorCss, { width = 1.6, font = '700 40px "Chakra Petch", monospace' } = {}) {
  const c = document.createElement('canvas');
  c.width = 384;
  c.height = 96;
  const ctx = c.getContext('2d');
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = colorCss;
  ctx.shadowBlur = 14;
  ctx.fillStyle = colorCss;
  ctx.fillText(text, 192, 48, 360);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  sprite.scale.set(width, width / 4, 1);
  sprite.renderOrder = 10;
  return sprite;
}

let glowTex = null;
export function getGlowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

export function makeGlow(color, scale = 0.5, opacity = 1) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: getGlowTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  s.scale.set(scale, scale, 1);
  return s;
}

let beaconTex = null;
function getBeaconTexture() {
  if (beaconTex) return beaconTex;
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 128);
  beaconTex = new THREE.CanvasTexture(c);
  return beaconTex;
}

// a column of light rising off a blip, brightest at the base, fading up
export function makeBeacon(color, height = 30, radius = 0.22) {
  const geo = new THREE.CylinderGeometry(radius * 0.6, radius, height, 10, 1, true);
  geo.translate(0, height / 2, 0);
  const mat = new THREE.MeshBasicMaterial({
    map: getBeaconTexture(), color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 5;
  return m;
}

export function makeRing(color, r = 0.9) {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(r * 0.82, r, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
  );
  m.rotation.x = -Math.PI / 2;
  return m;
}

import { GLOBE } from '../config.js';

// The land around the city: a flat basin the city and its suburbs sit in,
// foothills from ~5 km, and ridged mountain ranges out to ~90 km that
// fade back into the flat globe. One height function, written twice — GLSL
// for the globe's vertex shader, JS for the camera (so nothing flies through
// a peak) — with a sine-free hash so both sides agree to well under a meter.

const T = GLOBE.terrain;

export const TERRAIN_GLSL = /* glsl */ `
  uniform float uTerrainScale;
  float tHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float tNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x),
               mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float tRidged(vec2 p) {
    float a = 0.5;
    float s = 0.0;
    for (int k = 0; k < 6; k++) {
      float n = 1.0 - abs(tNoise(p) * 2.0 - 1.0);
      s += a * n * n;
      p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(17.0, 9.0);
      a *= 0.5;
    }
    return s;
  }
  // meters above the sphere at site-local (x, z)
  float terrainHeight(vec2 xz) {
    float d = length(xz);
    if (d < ${T.basin.toFixed(1)} || d > ${(T.outer[1] * 1.6).toFixed(1)}) return 0.0;
    // the range's outer edge wanders (no perfect circle from orbit)
    float dOut = d + (tNoise(xz / 26000.0 + vec2(41.0, 7.0)) - 0.5) * ${(T.outer[1] * 0.9).toFixed(1)};
    vec2 q = xz / ${T.scale.toFixed(1)};
    float m = smoothstep(${T.basin.toFixed(1)}, ${T.foot.toFixed(1)}, d) * (1.0 - smoothstep(${T.outer[0].toFixed(1)}, ${T.outer[1].toFixed(1)}, dOut));
    float amp = 0.35 + 0.65 * tNoise(q * 0.32 + vec2(7.0, 3.0));
    float h = tRidged(q + vec2(3.1, 1.7)) * ${T.peak.toFixed(1)} * amp + tNoise(q * 3.0) * 120.0;
    return h * m * uTerrainScale;
  }
`;

// --- the same, in JS ----------------------------------------------------
const fract = (x) => x - Math.floor(x);
function tHash(x, y) {
  let a = fract(x * 0.1031);
  let b = fract(y * 0.1031);
  let c = fract(x * 0.1031);
  const dd = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += dd;
  b += dd;
  c += dd;
  return fract((a + b) * c);
}
function tNoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = tHash(ix, iy);
  const b = tHash(ix + 1, iy);
  const c = tHash(ix, iy + 1);
  const d = tHash(ix + 1, iy + 1);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}
function tRidged(x, y) {
  let a = 0.5;
  let s = 0;
  for (let k = 0; k < 6; k++) {
    const n = 1 - Math.abs(tNoise(x, y) * 2 - 1);
    s += a * n * n;
    // GLSL mat2(1.6, 1.2, -1.2, 1.6) is column-major: x' = 1.6x − 1.2y, y' = 1.2x + 1.6y
    const nx = 1.6 * x - 1.2 * y + 17;
    const ny = 1.2 * x + 1.6 * y + 9;
    x = nx;
    y = ny;
    a *= 0.5;
  }
  return s;
}
const ss = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export function terrainHeight(x, z, scale = 1) {
  const d = Math.hypot(x, z);
  if (d < T.basin || d > T.outer[1] * 1.6) return 0;
  const dOut = d + (tNoise(x / 26000 + 41, z / 26000 + 7) - 0.5) * T.outer[1] * 0.9;
  const qx = x / T.scale;
  const qz = z / T.scale;
  const m = ss(T.basin, T.foot, d) * (1 - ss(T.outer[0], T.outer[1], dOut));
  const amp = 0.35 + 0.65 * tNoise(qx * 0.32 + 7, qz * 0.32 + 3);
  const h = tRidged(qx + 3.1, qz + 1.7) * T.peak * amp + tNoise(qx * 3, qz * 3) * 120;
  return h * m * scale;
}

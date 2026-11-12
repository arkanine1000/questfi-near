// Natural Earth land polygons → public/geo/land.json, compact enough to ship.
//   node tools/bake-geo.mjs <ne_50m_land.geojson> [tolerance-deg]
// Each ring is Douglas–Peucker simplified, quantized to 0.01° and delta
// encoded: { scale: 100, rings: [[x0, y0, dx, dy, dx, dy, ...], ...] }.
// The browser fills these into the land mask and strokes them as coastlines.
// Data: Natural Earth (public domain), https://www.naturalearthdata.com
import fs from 'node:fs';
import path from 'node:path';

const [,, src, tolArg = '0.02'] = process.argv;
const tol = Number(tolArg);
const gj = JSON.parse(fs.readFileSync(src, 'utf8'));

function dp(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-12;
    let best = -1;
    let bd = eps;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const rings = [];
let inPts = 0;
let outPts = 0;
for (const f of gj.features) {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for (const poly of polys) {
    for (const ring of poly) {
      inPts += ring.length;
      // closed rings start and end on the same point, which gives DP a zero
      // baseline — simplify the two halves separately
      const mid = ring.length >> 1;
      const s = [...dp(ring.slice(0, mid + 1), tol), ...dp(ring.slice(mid), tol).slice(1)];
      if (s.length < 4) continue;
      const q = s.map(([x, y]) => [Math.round(x * 100), Math.round(y * 100)]);
      const enc = [q[0][0], q[0][1]];
      for (let i = 1; i < q.length; i++) {
        const dx = q[i][0] - q[i - 1][0];
        const dy = q[i][1] - q[i - 1][1];
        if (dx === 0 && dy === 0) continue;
        enc.push(dx, dy);
      }
      outPts += enc.length / 2;
      rings.push(enc);
    }
  }
}
const out = path.resolve('public/geo/land.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ source: 'Natural Earth 1:50m land (public domain)', scale: 100, rings }));
console.log(`${rings.length} rings, ${inPts} → ${outPts} points, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);

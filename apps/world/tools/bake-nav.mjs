// Bake a top-down occupancy grid from the city GLB:
//   '.' road (asphalt plane, nothing on top)   '=' sidewalk/paving   '#' building/obstacle   'p' park / grass
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'node:fs';
const [,, input, output, cellArg] = process.argv;
const CELL = Number(cellArg ?? 2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
const scene = doc.getRoot().listScenes()[0];

// world bounds from the asphalt plane
const MINX = -407, MAXX = 583, MINZ = -899, MAXZ = 346;
const W = Math.ceil((MAXX - MINX) / CELL), H = Math.ceil((MAXZ - MINZ) / CELL);
const grid = new Uint8Array(W * H); // 0 road, 1 sidewalk, 2 obstacle, 3 park
const PRI = { 0: 0, 3: 1, 1: 2, 2: 3 }; // obstacle wins over sidewalk wins over park
const put = (i, v) => { if (PRI[v] > PRI[grid[i]]) grid[i] = v; };

function mat4FromNode(n) { return n.getWorldMatrix(); }
function xf(m, p) { const x = p[0], y = p[1], z = p[2];
  return [m[0]*x + m[4]*y + m[8]*z + m[12], m[1]*x + m[5]*y + m[9]*z + m[13], m[2]*x + m[6]*y + m[10]*z + m[14]]; }

function rasterTri(a, b, c, v) {
  // a,b,c world [x,y,z]; rasterize XZ footprint into cells (conservative: sample cell centers + bbox edge)
  const minx = Math.max(0, Math.floor((Math.min(a[0],b[0],c[0]) - MINX) / CELL));
  const maxx = Math.min(W-1, Math.floor((Math.max(a[0],b[0],c[0]) - MINX) / CELL));
  const minz = Math.max(0, Math.floor((Math.min(a[2],b[2],c[2]) - MINZ) / CELL));
  const maxz = Math.min(H-1, Math.floor((Math.max(a[2],b[2],c[2]) - MINZ) / CELL));
  if (maxx - minx > 400 && maxz - minz > 400) return; // the ground plane itself
  for (let gz = minz; gz <= maxz; gz++) for (let gx = minx; gx <= maxx; gx++) {
    // test 5 sample points per cell (center + 4 inset corners)
    const cx = MINX + (gx + 0.5) * CELL, cz = MINZ + (gz + 0.5) * CELL;
    const h = CELL * 0.35;
    let hit = false;
    for (const [sx, sz] of [[0,0],[-h,-h],[h,-h],[-h,h],[h,h]]) { if (ptInTri(cx+sx, cz+sz, a, b, c)) { hit = true; break; } }
    if (hit) put(gz * W + gx, v);
  }
}
function ptInTri(px, pz, a, b, c) {
  const d1 = (px - b[0]) * (a[2] - b[2]) - (a[0] - b[0]) * (pz - b[2]);
  const d2 = (px - c[0]) * (b[2] - c[2]) - (b[0] - c[0]) * (pz - c[2]);
  const d3 = (px - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (pz - a[2]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

const stats = {};
import { getBounds } from '@gltf-transform/core';
const pois = [];
for (const node of scene.listChildren()) {
  const name = node.getName();
  if (!/^(001_Skyscraper|002_Building|004_|04_Church|03_Houses)/.test(name) || !node.getMesh()) continue;
  const b = getBounds(node);
  pois.push({ name, min: [+b.min[0].toFixed(1), +b.min[2].toFixed(1)], max: [+b.max[0].toFixed(1), +b.max[2].toFixed(1)], height: +b.max[1].toFixed(1) });
}
for (const node of scene.listChildren()) {
  const name = node.getName();
  const mesh = node.getMesh(); if (!mesh) continue;
  if (/^Camera/.test(name) || /000_Street_001|000_S\.Stripes|000_StreetsLamp/.test(name)) continue;
  const m = mat4FromNode(node);
  for (const prim of mesh.listPrimitives()) {
    const matName = prim.getMaterial()?.getName() ?? '';
    let v;
    if (/^000_Block/.test(name)) { if (/Paving/.test(matName)) v = 1; else continue; }
    else if (/CityPark/.test(name)) { if (/Grass|Water/.test(matName)) v = 3; else if (/Paving|Concrete/.test(matName)) v = 1; else continue; }
    else if (/^000_Street_002/.test(name)) { v = /Grass/.test(matName) ? 3 : (/Concrete/.test(matName) ? 1 : 2); }
    else v = 2;
    const pos = prim.getAttribute('POSITION'); const idx = prim.getIndices();
    const n = idx ? idx.getCount() : pos.getCount();
    const pa = [], pb = [], pc = [];
    for (let i = 0; i < n; i += 3) {
      const ia = idx ? idx.getScalar(i) : i, ib = idx ? idx.getScalar(i+1) : i+1, ic = idx ? idx.getScalar(i+2) : i+2;
      const a = xf(m, pos.getElement(ia, pa)), b = xf(m, pos.getElement(ib, pb)), c = xf(m, pos.getElement(ic, pc));
      // obstacles: only count geometry that reaches pedestrian height (skip rooftop detail above 60m is fine too)
      if (v === 2 && Math.max(a[1], b[1], c[1]) < -0.5) continue; // underground plumbing only
      rasterTri(a, b, c, v);
    }
    stats[v] = (stats[v] || 0) + 1;
  }
}
// close small holes inside buildings: a road cell fully surrounded by obstacle in a 3x3 → obstacle
const counts = [0,0,0,0]; for (const g of grid) counts[g]++;
console.log('grid', W, 'x', H, 'cells', W*H, 'road/sidewalk/obstacle/park', counts);
const rows = []; const chars = ['.', '=', '#', 'p'];
for (let z = 0; z < H; z++) { let s = ''; for (let x = 0; x < W; x++) s += chars[grid[z*W + x]]; rows.push(s); }
fs.writeFileSync(output, JSON.stringify({ cell: CELL, minX: MINX, minZ: MINZ, w: W, h: H, rows, pois }));
// ascii preview, downsampled 8x
const step = Math.max(1, Math.round(16 / CELL));
let prev = '';
for (let z = 0; z < H; z += step) { let s = ''; for (let x = 0; x < W; x += step) s += rows[z][x]; prev += s + '\n'; }
fs.writeFileSync(output + '.txt', prev);
console.log(prev.split('\n').slice(0, 80).join('\n'));

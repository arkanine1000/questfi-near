import * as THREE from 'three';

// The baked city grid (tools/bake-nav.mjs): one char per 2 m cell —
//   '.' road   '=' sidewalk / paving   '#' building footprint   'p' park
// Pedestrians path over sidewalks (roads cost extra, so they cross where
// they must and nowhere else); cars path over road cells only, then the
// path is pushed to the right-hand lane. A* runs on typed arrays with a
// generation stamp, so searches never clear the 300k-cell grid.

export async function loadNav(url, manager) {
  manager?.itemStart(url);
  const res = await fetch(url);
  const data = await res.json();
  manager?.itemEnd(url);
  return createNav(data);
}

export function createNav(data) {
  const { cell, minX, minZ, w, h, rows, pois } = data;
  const grid = new Uint8Array(w * h); // 0 road, 1 sidewalk, 2 obstacle, 3 park
  const CODE = { '.': 0, '=': 1, '#': 2, p: 3 };
  for (let z = 0; z < h; z++) {
    const row = rows[z];
    for (let x = 0; x < w; x++) grid[z * w + x] = CODE[row[x]] ?? 2;
  }

  // distance-to-obstacle (in cells, capped) — pedestrians hug neither walls
  // nor curbs, cars keep off the curb line
  const clearance = new Uint8Array(w * h);
  {
    // two-pass chamfer over "obstacle or sidewalk-edge" seeds is overkill;
    // a 3x3 / 5x5 ring test is enough at 2 m cells
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const i = z * w + x;
        let c = 3;
        outer: for (let r = 1; r <= 2; r++) {
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
              const xx = x + dx;
              const zz = z + dz;
              if (xx < 0 || zz < 0 || xx >= w || zz >= h || grid[zz * w + xx] === 2) {
                c = r - 1;
                break outer;
              }
            }
          }
        }
        clearance[i] = c;
      }
    }
  }

  const toCell = (x, z) => [Math.floor((x - minX) / cell), Math.floor((z - minZ) / cell)];
  const toWorld = (cx, cz) => new THREE.Vector3(minX + (cx + 0.5) * cell, 0, minZ + (cz + 0.5) * cell);
  const inside = (cx, cz) => cx >= 0 && cz >= 0 && cx < w && cz < h;
  const at = (cx, cz) => (inside(cx, cz) ? grid[cz * w + cx] : 2);
  const kindAt = (x, z) => at(...toCell(x, z));

  // ---------------------------------------------------------------------
  // A* (8-connected, octile heuristic, binary heap)
  // ---------------------------------------------------------------------
  const gScore = new Float32Array(w * h);
  const stamp = new Uint32Array(w * h);
  const came = new Int32Array(w * h);
  const closed = new Uint8Array(w * h);
  let generation = 0;
  const heapIdx = new Int32Array(w * h);
  const heapKey = new Float32Array(w * h);
  let heapSize = 0;
  function heapPush(i, key) {
    let p = heapSize++;
    heapIdx[p] = i;
    heapKey[p] = key;
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (heapKey[q] <= heapKey[p]) break;
      [heapIdx[p], heapIdx[q]] = [heapIdx[q], heapIdx[p]];
      [heapKey[p], heapKey[q]] = [heapKey[q], heapKey[p]];
      p = q;
    }
  }
  function heapPop() {
    const top = heapIdx[0];
    heapSize--;
    if (heapSize > 0) {
      heapIdx[0] = heapIdx[heapSize];
      heapKey[0] = heapKey[heapSize];
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        const r = l + 1;
        let m = p;
        if (l < heapSize && heapKey[l] < heapKey[m]) m = l;
        if (r < heapSize && heapKey[r] < heapKey[m]) m = r;
        if (m === p) break;
        [heapIdx[p], heapIdx[m]] = [heapIdx[m], heapIdx[p]];
        [heapKey[p], heapKey[m]] = [heapKey[m], heapKey[p]];
        p = m;
      }
    }
    return top;
  }

  const DIRS = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, 1.4142], [-1, 1, 1.4142], [1, -1, 1.4142], [-1, -1, 1.4142],
  ];

  // costFn(kind, clearance) → step multiplier, or Infinity when impassable
  function astar(sx, sz, tx, tz, costFn, maxExpand = 60000) {
    if (!inside(sx, sz) || !inside(tx, tz)) return null;
    generation++;
    heapSize = 0;
    const start = sz * w + sx;
    const goal = tz * w + tx;
    const hfn = (i) => {
      const dx = Math.abs((i % w) - tx);
      const dz = Math.abs(((i / w) | 0) - tz);
      return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
    };
    stamp[start] = generation;
    gScore[start] = 0;
    came[start] = -1;
    closed[start] = 0;
    heapPush(start, hfn(start));
    let expanded = 0;
    let best = start;
    let bestH = hfn(start);
    while (heapSize > 0) {
      const cur = heapPop();
      if (closed[cur] === 1 && stamp[cur] === generation) continue;
      closed[cur] = 1;
      if (cur === goal) return unwind(cur);
      const hc = hfn(cur);
      if (hc < bestH) {
        bestH = hc;
        best = cur;
      }
      if (++expanded > maxExpand) break;
      const cx = cur % w;
      const cz = (cur / w) | 0;
      for (const [dx, dz, len] of DIRS) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (!inside(nx, nz)) continue;
        const ni = nz * w + nx;
        const mult = costFn(grid[ni], clearance[ni]);
        if (mult === Infinity) continue;
        // no corner cutting through walls on diagonals
        if (dx && dz && (costFn(at(cx + dx, cz), 0) === Infinity || costFn(at(cx, cz + dz), 0) === Infinity)) continue;
        const ng = gScore[cur] + len * mult;
        if (stamp[ni] !== generation) {
          stamp[ni] = generation;
          closed[ni] = 0;
          gScore[ni] = Infinity;
        }
        if (ng < gScore[ni]) {
          gScore[ni] = ng;
          came[ni] = cur;
          heapPush(ni, ng + hfn(ni));
        }
      }
    }
    // out of budget — walk toward the closest point reached
    return best !== start ? unwind(best) : null;
  }
  function unwind(i) {
    const cells = [];
    while (i !== -1) {
      cells.push(i);
      i = came[i];
    }
    cells.reverse();
    return cells.map((c) => toWorld(c % w, (c / w) | 0));
  }

  // string-pulling: drop waypoints that a straight segment can skip
  function clearLine(a, b, passable) {
    const [ax, az] = toCell(a.x, a.z);
    const [bx, bz] = toCell(b.x, b.z);
    const n = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
    for (let s = 1; s < n; s++) {
      const t = s / n;
      const cx = Math.round(ax + (bx - ax) * t);
      const cz = Math.round(az + (bz - az) * t);
      if (!passable(at(cx, cz), clearance[cz * w + cx])) return false;
    }
    return true;
  }
  function smooth(path, passable) {
    if (!path || path.length < 3) return path;
    const out = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
      let j = path.length - 1;
      while (j > i + 1 && !clearLine(path[i], path[j], passable)) j--;
      out.push(path[j]);
      i = j;
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // the two travellers
  // ---------------------------------------------------------------------
  const walkCost = (k, c) => (k === 2 ? Infinity : k === 0 ? 4.5 : c === 0 ? 2.2 : 1);
  const walkPass = (k) => k !== 2;
  const driveCost = (k, c) => (k !== 0 ? Infinity : c === 0 ? 3 : 1);
  const drivePass = (k) => k === 0;

  function pathWalk(from, to) {
    const [sx, sz] = toCell(from.x, from.z);
    const [tx, tz] = toCell(to.x, to.z);
    return smooth(astar(sx, sz, tx, tz, walkCost, 40000), walkPass);
  }
  function pathDrive(from, to) {
    const [sx, sz] = toCell(from.x, from.z);
    const [tx, tz] = toCell(to.x, to.z);
    const raw = astar(sx, sz, tx, tz, driveCost, 90000);
    return smooth(raw, drivePass);
  }

  // random cells of a kind inside a disc, with a bit of clearance
  function randomCell(kind, center, radius, minClear = 1, tries = 60) {
    for (let t = 0; t < tries; t++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const x = center.x + Math.cos(a) * r;
      const z = center.z + Math.sin(a) * r;
      const [cx, cz] = toCell(x, z);
      if (!inside(cx, cz)) continue;
      const i = cz * w + cx;
      if (grid[i] === kind && clearance[i] >= minClear) return toWorld(cx, cz);
    }
    return null;
  }
  // nearest cell of a kind to a point (spiral search)
  function nearestCell(kind, p, maxR = 20) {
    const [cx, cz] = toCell(p.x, p.z);
    for (let r = 0; r <= maxR; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (at(cx + dx, cz + dz) === kind && clearance[(cz + dz) * w + cx + dx] >= 1) return toWorld(cx + dx, cz + dz);
        }
      }
    }
    return null;
  }

  // points of interest: named buildings, labelled for the thought feed
  const LABELS = [
    [/Skyscraper/, 'the tower'], [/Hospital/, 'the hospital'], [/Hotel/, 'the hotel'], [/Mall/, 'the mall'],
    [/Museum/, 'the museum'], [/School/, 'the school'], [/Stadium/, 'the stadium'], [/Church/, 'the church'],
    [/CityPark/, 'the park'], [/Building/, 'the office block'], [/Houses/, 'the houses'],
  ];
  const POIS = (pois ?? []).map((p) => {
    const label = LABELS.find(([re]) => re.test(p.name))?.[1] ?? 'downtown';
    return {
      name: p.name,
      label,
      center: new THREE.Vector3((p.min[0] + p.max[0]) / 2, 0, (p.min[1] + p.max[1]) / 2),
      size: Math.max(p.max[0] - p.min[0], p.max[1] - p.min[1]),
      height: p.height,
    };
  });
  function randomPoi(center, radius) {
    const near = POIS.filter((p) => p.center.distanceTo(center) < radius && p.size < 220);
    if (!near.length) return null;
    return near[Math.floor(Math.random() * near.length)];
  }
  function poiNear(p, within = 40) {
    let best = null;
    let bd = within;
    for (const poi of POIS) {
      const d = poi.center.distanceTo(p) - poi.size * 0.5;
      if (d < bd) {
        bd = d;
        best = poi;
      }
    }
    return best;
  }

  return {
    cell, w, h, minX, minZ, grid, clearance, pois: POIS,
    kindAt, toCell, toWorld,
    pathWalk, pathDrive, randomCell, nearestCell, randomPoi, poiNear,
    isRoad: (x, z) => kindAt(x, z) === 0,
    isWalkable: (x, z) => kindAt(x, z) !== 2,
  };
}

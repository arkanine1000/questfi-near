import * as THREE from 'three';
import { getGlowTexture } from '../sprites.js';

// The city as seen from kilometers up: the street layout as a glowing
// footprint (baked from the nav grid, like the minimap), a light point on
// every building, traffic as moving sparks and agents as roster-colored
// dots. A handful of draw calls standing in for ~1,500. Crossfades in over
// the City → Regional boundary while the real meshes dissolve.

export function createImpostor(scene, nav, pixelRatio = 1) {
  const group = new THREE.Group();
  group.name = 'city-impostor';
  scene.add(group);

  // footprint
  const c = document.createElement('canvas');
  c.width = nav.w;
  c.height = nav.h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(nav.w, nav.h);
  for (let i = 0; i < nav.grid.length; i++) {
    const k = nav.grid[i];
    const o = i * 4;
    const [r, g, b, a] = k === 0 ? [80, 255, 150, 255] : k === 1 ? [30, 130, 70, 150] : k === 3 ? [20, 110, 50, 120] : [8, 40, 22, 255];
    img.data[o] = r;
    img.data[o + 1] = g;
    img.data[o + 2] = b;
    img.data[o + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const W = nav.w * nav.cell;
  const H = nav.h * nav.cell;
  const footMat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const foot = new THREE.Mesh(new THREE.PlaneGeometry(W, H), footMat);
  foot.rotation.x = -Math.PI / 2;
  foot.position.set(nav.minX + W / 2, 0.8, nav.minZ + H / 2);
  foot.renderOrder = 2;
  group.add(foot);

  const glow = getGlowTexture();
  const pointsMat = (size) => new THREE.PointsMaterial({
    size: size * pixelRatio, sizeAttenuation: false, map: glow, vertexColors: true, transparent: true,
    opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
  });

  // a light on every roof
  const pois = nav.pois ?? [];
  const bp = new Float32Array(pois.length * 3);
  const bc = new Float32Array(pois.length * 3);
  pois.forEach((p, i) => {
    bp[i * 3] = p.center.x;
    bp[i * 3 + 1] = (p.height ?? 10) + 2;
    bp[i * 3 + 2] = p.center.z;
    const k = 0.45 + Math.random() * 0.55;
    bc[i * 3] = 0.55 * k;
    bc[i * 3 + 1] = 1.0 * k;
    bc[i * 3 + 2] = 0.72 * k;
  });
  const bGeo = new THREE.BufferGeometry();
  bGeo.setAttribute('position', new THREE.BufferAttribute(bp, 3));
  bGeo.setAttribute('color', new THREE.BufferAttribute(bc, 3));
  const buildingMat = pointsMat(3.2);
  const buildings = new THREE.Points(bGeo, buildingMat);
  buildings.renderOrder = 3;
  group.add(buildings);

  // live points: traffic + agents, refilled every frame they're visible
  function livePoints(max, size) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const pts = new THREE.Points(geo, pointsMat(size));
    pts.frustumCulled = false;
    pts.renderOrder = 4;
    group.add(pts);
    return pts;
  }
  const carPts = livePoints(256, 6);
  const agentPts = livePoints(64, 14);
  const col = new THREE.Color();
  const warm = new THREE.Color(0xfff0c8);

  function fill(pts, list, colorOf, y) {
    const pos = pts.geometry.attributes.position;
    const cl = pts.geometry.attributes.color;
    const n = Math.min(list.length, pos.count);
    for (let i = 0; i < n; i++) {
      const it = list[i];
      pos.setXYZ(i, it.pos.x, it.pos.y + y, it.pos.z);
      colorOf(it, col);
      cl.setXYZ(i, col.r, col.g, col.b);
    }
    pts.geometry.setDrawRange(0, n);
    pos.needsUpdate = true;
    cl.needsUpdate = true;
  }

  return {
    group,
    // w: band weights; holo picks the palette
    update(w, { agents = [], cars = [], holo = true }) {
      footMat.opacity = w.impostor * 0.9;
      foot.visible = w.impostor > 0.003;
      footMat.color.setHex(holo ? 0xffffff : 0xffd9a0);
      buildingMat.opacity = w.impostor;
      buildings.visible = foot.visible;

      carPts.material.opacity = w.carPoints;
      carPts.visible = w.carPoints > 0.003;
      if (carPts.visible) fill(carPts, cars, (car, out) => out.copy(car.driver ? col.setHex(car.driver.tint) : warm), 1.6);
      agentPts.material.opacity = w.agentDots;
      agentPts.visible = w.agentDots > 0.003;
      if (agentPts.visible) fill(agentPts, agents, (a, out) => out.setHex(a.tint), 2.5);
    },
  };
}

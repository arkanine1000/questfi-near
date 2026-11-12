import * as THREE from 'three';
import { GLOBE, CITY, LITE } from '../config.js';
import { R } from './geo.js';
import { terrainHeight, TERRAIN_GLSL } from './terrain.js';

// The suburbs: the city stops being a lone tile on a parking lot. Procedural
// blocks fill the basin around it on the same 60 m street grid the ground
// draws — mid-rises hugging the city's edge, a few satellite towers, then
// houses thinning out toward the foothills. One instanced draw call; the
// shader draws the hologram edges and the window grid itself, so there are
// no extra line meshes. Textured mode gets dark facades and warm windows.

const vert = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  attribute float aSeed;
  varying vec3 vLocal;
  varying vec3 vScale;
  varying vec3 vNrm;
  varying float vSeed;
  void main() {
    vLocal = position;
    vNrm = normal;
    vSeed = aSeed;
    vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    vec4 mvPosition = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }
`;

const frag = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  ${TERRAIN_GLSL}
  uniform float uMode;
  uniform float uOpacity;
  uniform vec3 uFill, uEdge, uWin, uTFill, uTEdge, uTWin;
  varying vec3 vLocal;
  varying vec3 vScale;
  varying vec3 vNrm;
  varying float vSeed;
  void main() {
    #include <logdepthbuf_fragment>
    // dithered fade: no sorting, no extra pass
    if (uOpacity < 0.999 && tHash(gl_FragCoord.xy) > uOpacity) discard;
    // meters from the box's corner along each axis
    vec3 p = (vLocal + vec3(0.5, 0.0, 0.5)) * vScale;
    vec3 e = min(p, vScale - p);
    float mn = min(e.x, min(e.y, e.z));
    float mx = max(e.x, max(e.y, e.z));
    float mid = e.x + e.y + e.z - mn - mx; // distance to this face's nearest edge
    float fw = length(fwidth(p));
    float edge = 1.0 - smoothstep(0.0, 1.6 * fw, mid);
    // once a building is only a few pixels wide its edges would fill it
    // solid: fade them to a faint average instead of a glowing slab
    float tiny = smoothstep(0.08, 0.3, fw / min(vScale.x, vScale.z));
    edge = mix(edge, 0.12, tiny);

    // windows on the walls: 4 m bays, 3.5 m floors, about a third lit
    float win = 0.0;
    if (abs(vNrm.y) < 0.5) {
      float along = abs(vNrm.x) > 0.5 ? p.z : p.x;
      vec2 wc = vec2(along / 4.0, (p.y - 1.5) / 3.5);
      vec2 wf = fract(wc);
      float shape = step(0.22, wf.x) * step(wf.x, 0.78) * step(0.3, wf.y) * step(wf.y, 0.78);
      float lit = step(0.78, tHash(floor(wc) + vSeed * 97.0)) * step(0.0, wc.y);
      float wfw = max(fwidth(wc.x), fwidth(wc.y));
      // too small to draw: blend to the average glow instead of shimmering
      win = mix(shape * lit, 0.05, smoothstep(0.25, 0.6, wfw));
    }
    float roof = step(0.5, vNrm.y);

    vec3 holo = uFill * (1.0 - 0.35 * roof) + uEdge * edge + uWin * win;
    vec3 tex = uTFill * (1.0 - 0.3 * roof) + uTEdge * edge + uTWin * win;
    gl_FragColor = vec4(mix(holo, tex, uMode), 1.0);
    #include <fog_fragment>
  }
`;

const ss = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createOutskirts(scene) {
  const O = GLOBE.outskirts;
  const b = CITY.bounds;
  const cell = O.cell;
  const maxR = LITE ? O.radius * 0.7 : O.radius;
  // satellite downtowns: a few clusters of towers out in the basin
  const clusters = [
    { x: 2700, z: -2300, r: 650, h: [70, 230] },
    { x: -3000, z: 900, r: 520, h: [50, 160] },
    { x: 1200, z: 3300, r: 450, h: [40, 120] },
  ];
  const lots = [];
  const ox = b.minX;
  const oz = b.minZ;
  const n0 = Math.ceil(maxR / cell) + 2;
  for (let gx = -n0; gx <= n0; gx++) {
    for (let gz = -n0; gz <= n0; gz++) {
      // blocks sit between the 60 m grid lines, which read as streets
      const x0 = ox + Math.round(-ox / cell) * cell + gx * cell;
      const z0 = oz + Math.round(-oz / cell) * cell + gz * cell;
      const cx = x0 + cell / 2;
      const cz = z0 + cell / 2;
      const d = Math.hypot(cx, cz);
      if (d > maxR) continue;
      // stay clear of the real city
      if (cx > b.minX - O.margin - cell / 2 && cx < b.maxX + O.margin + cell / 2 && cz > b.minZ - O.margin - cell / 2 && cz < b.maxZ + O.margin + cell / 2) continue;
      if (terrainHeight(cx, cz) > 25) continue; // not up the hillsides
      let cl = null;
      for (const c of clusters) if (Math.hypot(cx - c.x, cz - c.z) < c.r) cl = c;
      const density = cl ? 0.95 : 0.85 * (1 - ss(1800, maxR, d)) + 0.12;
      if (Math.random() > density) continue;
      // 1, 2 or 4 lots in the block, smaller lots further out
      const split = cl ? (Math.random() < 0.6 ? 1 : 2) : d < 2500 ? (Math.random() < 0.5 ? 2 : 4) : Math.random() < 0.7 ? 4 : 2;
      const inner = cell - O.street;
      const parts = split === 1 ? [[0, 0, 1, 1]] : split === 2 ? (Math.random() < 0.5 ? [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]] : [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]]) : [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]];
      for (const [u, v, w, hh] of parts) {
        if (split === 4 && Math.random() < 0.15) continue; // a yard
        const set = 1.5 + Math.random() * 2.5;
        const sx = Math.max(6, w * inner - set * 2);
        const sz = Math.max(6, hh * inner - set * 2);
        const px = x0 + O.street / 2 + (u + w / 2) * inner;
        const pz = z0 + O.street / 2 + (v + hh / 2) * inner;
        let h;
        if (cl) {
          const k = 1 - Math.hypot(px - cl.x, pz - cl.z) / cl.r;
          h = cl.h[0] + (cl.h[1] - cl.h[0]) * k * (0.4 + 0.6 * Math.random());
        } else if (d < 2200) h = 14 + Math.random() * 46 * (1 - ss(900, 2200, d)) + Math.random() * 12;
        else h = 5 + Math.random() * (d < 3800 ? 16 : 7);
        lots.push({ x: px, z: pz, sx, sz, h });
      }
    }
  }

  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const seeds = new Float32Array(lots.length);
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uMode: { value: 0 },
    uOpacity: { value: 1 },
    uTerrainScale: { value: 1 },
    uFill: { value: new THREE.Color(0x03170c) },
    uEdge: { value: new THREE.Color(0x249a52) },
    uWin: { value: new THREE.Color(0x3fae6c) },
    uTFill: { value: new THREE.Color(0x0e1316) },
    uTEdge: { value: new THREE.Color(0x1d262b) },
    uTWin: { value: new THREE.Color(0xffc777) },
  }]);
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag, fog: true });
  const mesh = new THREE.InstancedMesh(geo, mat, lots.length);
  mesh.name = 'outskirts';
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  lots.forEach((l, i) => {
    // sit on the curved ground (the globe drops d²/2R away from the city)
    const d2 = l.x * l.x + l.z * l.z;
    pos.set(l.x, -d2 / (2 * R) - 0.6 + terrainHeight(l.x, l.z), l.z);
    scl.set(l.sx, l.h, l.sz);
    m.compose(pos, q, scl);
    mesh.setMatrixAt(i, m);
    seeds[i] = Math.random();
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  scene.add(mesh);

  let mode = 'holo';
  let modeT = 0;
  return {
    mesh,
    count: lots.length,
    setMode(mm) { mode = mm; },
    update(w, dt = 0.016) {
      modeT += ((mode === 'textured' ? 1 : 0) - modeT) * (1 - Math.exp(-6 * dt));
      uniforms.uMode.value = modeT;
      uniforms.uOpacity.value = w.outskirts;
      mesh.visible = w.outskirts > 0.003;
    },
  };
}

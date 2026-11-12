import * as THREE from 'three';
import { R, CENTER, GEO, GEO_T } from './geo.js';
import { GLOBE, CITY, LITE } from '../config.js';
import { TERRAIN_GLSL } from './terrain.js';

// The planet under the city. Small interface on purpose — update(camera,
// altitude, weights) and setMode('holo' | 'textured') — so a quadtree
// terrain can replace it later without touching anything else.
//
// The surface IS the ground skirt: one sphere mesh whose pole sits on the
// city, with rings spaced geometrically (60 m apart at the city, ~1° at the
// equator). Near the city the triangles are tiny, so the mesh follows the
// true curve to centimeters — the ground bends away to the horizon exactly
// like the spec's `y -= d²/2R` skirt, with no second mesh and so no seam to
// blend. Vertices are stored relative to the city (RTC), so the city end
// keeps float32 precision; the far side is only ever seen from far away.
//
// HOLO: near-black ocean, lifted land, the street grid running out from the
// city, a lat/lon graticule and Natural Earth coastlines, green rim.
// TEXTURED: day albedo + night lights, the terminator just past the city.

const DROP = 0.6; // the globe sits this far under the city's asphalt (no z-fight)

function buildSurface() {
  // ring arc distances: geometric near the city, a fine even step through
  // the mountains (the vertex shader displaces them), ~0.9° far away
  const arcs = [0];
  let d = 60;
  const end = Math.PI * R;
  const tOuter = GLOBE.terrain.outer[1] * 1.6;
  const fine = LITE ? 700 : 350;
  while (d < end) {
    arcs.push(d);
    if (d < 4000) d += d * 0.07;
    else if (d < tOuter) d += Math.max(fine, d * (LITE ? 0.025 : 0.012));
    else d += Math.min(d * 0.07, 100_000);
  }
  arcs.push(end);
  const SEG = LITE ? 256 : 512;
  const rings = arcs.length;
  const pos = new Float32Array((2 + (rings - 2) * SEG) * 3);
  const nrm = new Float32Array(pos.length);
  let v = 0;
  const put = (theta, phi) => {
    const s = Math.sin(theta);
    const nx = s * Math.cos(phi);
    const ny = Math.cos(theta);
    const nz = s * Math.sin(phi);
    // RTC: position relative to the tangent point, computed in doubles
    pos[v * 3] = R * nx;
    pos[v * 3 + 1] = -2 * R * Math.sin(theta / 2) ** 2 - DROP;
    pos[v * 3 + 2] = R * nz;
    nrm[v * 3] = nx;
    nrm[v * 3 + 1] = ny;
    nrm[v * 3 + 2] = nz;
    return v++;
  };
  const top = put(0, 0);
  const ringStart = [];
  for (let i = 1; i < rings - 1; i++) {
    ringStart.push(v);
    const theta = arcs[i] / R;
    for (let j = 0; j < SEG; j++) put(theta, (j / SEG) * Math.PI * 2);
  }
  const bottom = put(Math.PI, 0);
  const idx = [];
  const r0 = ringStart[0];
  for (let j = 0; j < SEG; j++) idx.push(top, r0 + ((j + 1) % SEG), r0 + j);
  for (let i = 0; i < ringStart.length - 1; i++) {
    const a = ringStart[i];
    const b = ringStart[i + 1];
    for (let j = 0; j < SEG; j++) {
      const j1 = (j + 1) % SEG;
      idx.push(a + j, a + j1, b + j);
      idx.push(a + j1, b + j1, b + j);
    }
  }
  const rl = ringStart[ringStart.length - 1];
  for (let j = 0; j < SEG; j++) idx.push(rl + j, rl + ((j + 1) % SEG), bottom);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(new THREE.BufferAttribute(v > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  geo.boundingSphere = new THREE.Sphere(CENTER.clone(), R * 1.01);
  return geo;
}

const surfaceVert = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  uniform mat3 uGeo;
  uniform sampler2D uLand;
  ${TERRAIN_GLSL}
  varying vec3 vN;
  varying vec3 vW;
  varying float vH;
  void main() {
    vN = normal;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    // mountains around the basin — on land only, never out of the sea
    float h = terrainHeight(wp.xz);
    if (h > 0.0) {
      vec3 g = normalize(uGeo * normal);
      vec2 guv = vec2(atan(-g.z, g.x) / (2.0 * PI) + 0.5, asin(clamp(g.y, -1.0, 1.0)) / PI + 0.5);
      h *= smoothstep(0.35, 0.8, textureLod(uLand, guv, 0.0).r);
    }
    wp.xyz += normal * h;
    vH = h;
    vW = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }
`;

const surfaceFrag = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  ${TERRAIN_GLSL}
  uniform mat3 uGeo;
  uniform sampler2D uLand;
  uniform sampler2D uLights;
  uniform sampler2D uAlbedo;
  uniform float uMode;      // 0 holo → 1 textured
  uniform float uLocal;     // street-grid weight (altitude)
  uniform float uGrat;      // graticule weight (altitude)
  uniform float uRimW;      // limb glow weight (altitude)
  uniform float uLightsW;   // city-lights glow (altitude)
  uniform vec3 uSun;
  uniform vec2 uGridOrigin;
  uniform vec3 uOcean, uLandCol, uNearCol, uGridCol, uGratCol, uRimCol, uLightCol;
  uniform vec3 uTexNear, uTexRim;
  varying vec3 vN;
  varying vec3 vW;
  varying float vH;

  // anti-aliased grid lines; c in cell units, w its screen-space footprint
  float gridLines(vec2 c, vec2 w, float width) {
    vec2 g = abs(fract(c - 0.5) - 0.5) / max(w, vec2(1e-7));
    float line = 1.0 - min(min(g.x, g.y) / width, 1.0);
    return line * (1.0 - smoothstep(0.2, 0.7, max(w.x, w.y))); // fades before it moirés
  }
  float contour(float c, float width) {
    float w = fwidth(c);
    float line = 1.0 - min(abs(fract(c - 0.5) - 0.5) / max(w, 1e-6) / width, 1.0);
    return line * (1.0 - smoothstep(0.25, 0.7, w));
  }
  float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  // city lights as crisp points instead of a magnified blur: one candidate
  // light per lat/lon cell, kept with the odds of the night-lights texture.
  // vis = how far the cell is from sub-pixel (faded in as it resolves)
  float lightDots(vec2 ll, float cell, vec2 fwDeg, float dens, out float vis) {
    vec2 c = ll / cell;
    vec2 fw = max(fwDeg / cell, vec2(1e-6));
    vis = smoothstep(5.0, 12.0, 1.0 / max(fw.x, fw.y));
    if (vis <= 0.0) return 0.0;
    vec2 i = floor(c);
    vec2 f = fract(c);
    float on = step(tHash(i + 0.5), dens);
    vec2 o = vec2(tHash(i + vec2(13.1, 3.7)), tHash(i + vec2(7.7, 29.1))) * 0.7 + 0.15;
    float r = 0.7 + tHash(i + vec2(5.3, 1.1)) * 0.9; // pixels
    return on * vis * smoothstep(r + 0.9, r * 0.3, length((f - o) / fw));
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec3 n = normalize(vN);
    vec3 g = normalize(uGeo * n);
    float lat = asin(clamp(g.y, -1.0, 1.0));
    float lon = atan(-g.z, g.x);
    vec2 uv = vec2(lon / (2.0 * PI) + 0.5, lat / PI + 0.5);
    // the longitude seam: take derivatives from whichever copy doesn't wrap
    vec2 uvB = vec2(fract(uv.x + 0.5), uv.y);
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    vec2 dxB = dFdx(uvB), dyB = dFdy(uvB);
    if (abs(dxB.x) < abs(dx.x)) dx.x = dxB.x;
    if (abs(dyB.x) < abs(dy.x)) dy.x = dyB.x;

    float land = textureGrad(uLand, uv, dx, dy).r;
    vec3 lights = textureGrad(uLights, uv, dx, dy).rgb;
    vec3 albedo = textureGrad(uAlbedo, uv, dx, dy).rgb;

    vec3 V = normalize(cameraPosition - vW);
    float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0) * uRimW;
    float dCity = length(vW.xz);
    float near = 1.0 - smoothstep(3000.0, 30000.0, dCity);

    // the terrain: relief from the actual displaced surface
    float tMask = smoothstep(2.0, 60.0, vH);
    vec3 tn = normalize(cross(dFdx(vW), dFdy(vW)));
    if (dot(tn, n) < 0.0) tn = -tn;
    float slope = 1.0 - clamp(dot(tn, n), 0.0, 1.0);
    float relief = clamp(0.5 + 0.8 * dot(tn - n, normalize(vec3(-0.6, 0.0, -0.5))) + 0.35, 0.0, 1.5);
    // topo lines: 50 m / 250 m up close, 1 km ones that hold from far away
    float contours = (contour(vH / 50.0, 1.0) * 0.18 + contour(vH / 250.0, 1.2) * 0.45 + contour(vH / 1000.0, 1.4) * 0.6) * tMask;

    // the street grid, carried out past the asphalt: 6 m cells like the
    // city's ground, with 60 m / 600 m / 6 km majors taking over with height
    vec2 p = vW.xz - uGridOrigin;
    vec2 pw = fwidth(p);
    float grid = gridLines(p / 6.0, pw / 6.0, 1.2) * 0.5
               + gridLines(p / 60.0, pw / 60.0, 1.2) * 0.42
               + gridLines(p / 600.0, pw / 600.0, 1.2) * 0.4
               + gridLines(p / 6000.0, pw / 6000.0, 1.2) * 0.3;
    grid *= uLocal * (1.0 - smoothstep(6000.0, 60000.0, dCity)) * (1.0 - 0.75 * tMask);

    // graticule every 10°
    vec2 ll = vec2(uv.x * 360.0, uv.y * 180.0);
    vec2 fwDeg = (abs(dx) + abs(dy)) * vec2(360.0, 180.0);
    float grat = gridLines(ll / 10.0, fwDeg / 10.0, 1.0) * uGrat;

    // lights: the texture from orbit, resolving into points as you descend
    float dens = clamp(lum(lights) * 1.8 - 0.06, 0.0, 1.0) * land * (1.0 - near) * (1.0 - 0.7 * tMask);
    float vis1;
    float vis2;
    float dots = lightDots(ll, 0.08, fwDeg, dens, vis1) + 0.8 * lightDots(ll + 0.37, 0.025, fwDeg, dens * 0.8, vis2);
    float blobK = 1.0 - 0.9 * vis1;

    // HOLO
    vec3 holo = mix(uOcean, uLandCol, land);
    holo = mix(holo, uNearCol, near);
    holo = mix(holo, (uNearCol + uLandCol * (0.4 + 1.4 * slope)) * relief, tMask);
    holo += uGridCol * grid;
    holo += uGridCol * contours;
    holo += uGridCol * 0.55 * slope * slope * tMask; // ridgelines catch the light
    holo += uGratCol * grat * 0.4;
    holo += uLightCol * (pow(lum(lights), 2.0) * uLightsW * land * (1.0 - near) * blobK + dots * 0.55);
    holo += uRimCol * rim * 0.7;

    // TEXTURED
    float lam = dot(n, uSun);
    float day = smoothstep(-0.12, 0.22, lam);
    vec3 dayCol = albedo * (0.06 + 1.05 * max(lam, 0.0));
    float lightsK = (0.1 + 1.3 * clamp((uLightsW - 0.04) / 0.3, 0.0, 1.0)) * blobK;
    vec3 nightCol = albedo * 0.012 + lights * vec3(1.0, 0.72, 0.42) * lightsK;
    vec3 tex = mix(nightCol, dayCol, day);
    tex = mix(tex, uTexNear, near);
    // rock takes the same light as the land around it: moonlit relief at
    // night, sunlit albedo by day — never a grey patch pasted on the planet
    vec3 rockNight = (vec3(0.014, 0.018, 0.022) + albedo * 0.03) * (0.35 + relief * (0.8 + slope));
    vec3 rockDay = albedo * (0.06 + 1.05 * max(lam, 0.0)) * (0.6 + 0.5 * relief);
    tex = mix(tex, mix(rockNight, rockDay, day), tMask);
    tex += vec3(0.05, 0.09, 0.11) * (grid * 0.6 + contours * 0.5); // cooler and quieter
    tex += vec3(1.0, 0.75, 0.45) * dots * 0.9 * (1.0 - day);
    tex += uTexRim * rim * (0.25 + 0.75 * day);

    gl_FragColor = vec4(mix(holo, tex, uMode), 1.0);
    #include <fog_fragment>
  }
`;

// the atmosphere: a back-faced shell whose brightness is the ray's actual
// path length through the air — a correct limb halo from orbit, a glowing
// horizon from inside, and dark straight up
const atmoVert = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }
`;
const atmoFrag = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uCenter;
  uniform float uR;
  uniform float uRa;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vW;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 rd = normalize(vW - cameraPosition);
    vec3 oc = uCenter - cameraPosition;
    float tca = dot(oc, rd);
    float b2 = dot(oc, oc) - tca * tca;
    float ra2 = uRa * uRa;
    if (b2 > ra2) discard;
    float half_ = sqrt(ra2 - b2);
    float t0 = max(0.0, tca - half_);
    float t1 = tca + half_;
    float path = max(0.0, t1 - t0);
    float maxPath = 2.0 * sqrt(ra2 - uR * uR);
    float k = clamp(path / maxPath, 0.0, 1.0);
    // densest at the bottom of the shell
    float b = sqrt(max(b2, 0.0));
    float low = 1.0 - clamp((b - uR) / (uRa - uR), 0.0, 1.0);
    float glow = pow(k, 1.6) * (0.35 + 0.65 * low * low);
    gl_FragColor = vec4(uColor * glow * uOpacity, 1.0);
  }
`;

async function loadLand(url) {
  const res = await fetch(url);
  return res.json();
}

function buildLandMask(land, w = 2048, h = 1024) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  const s = land.scale;
  for (const ring of land.rings) {
    let x = ring[0];
    let y = ring[1];
    ctx.moveTo(((x / s + 180) / 360) * w, ((90 - y / s) / 180) * h);
    for (let i = 2; i < ring.length; i += 2) {
      x += ring[i];
      y += ring[i + 1];
      ctx.lineTo(((x / s + 180) / 360) * w, ((90 - y / s) / 180) * h);
    }
    ctx.closePath();
  }
  ctx.fill('evenodd');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// coastlines as line segments a little above the surface, segments split to
// ≤0.15° so their chords never dip under the curve
function buildCoast(land, lift = 30) {
  const s = land.scale;
  const out = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const toWorld = (lon, lat, v) => {
    const la = (lat * Math.PI) / 180;
    const lo = (lon * Math.PI) / 180;
    v.set(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).applyMatrix3(GEO_T).normalize();
    return v;
  };
  const r = R + lift;
  for (const ring of land.rings) {
    let x = ring[0] / s;
    let y = ring[1] / s;
    for (let i = 2; i < ring.length; i += 2) {
      const nx = x + ring[i] / s;
      const ny = y + ring[i + 1] / s;
      // skip the artificial edges Natural Earth adds along the antimeridian / pole
      const seam = (Math.abs(x) >= 179.99 && Math.abs(nx) >= 179.99) || (y <= -89.9 && ny <= -89.9) || (y <= -84.5 && ny <= -84.5 && Math.abs(nx - x) > 2);
      if (!seam) {
        const steps = Math.max(1, Math.ceil(Math.hypot(nx - x, ny - y) / 0.15));
        toWorld(x, y, a);
        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          toWorld(x + (nx - x) * t, y + (ny - y) * t, b);
          // world = center + dir · r, stored relative to the origin
          out.push(a.x * r, a.y * r - R, a.z * r, b.x * r, b.y * r - R, b.z * r);
          a.copy(b);
        }
      }
      x = nx;
      y = ny;
    }
  }
  void tmp;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
  geo.boundingSphere = new THREE.Sphere(CENTER.clone(), R * 1.01);
  return geo;
}

function buildStars(n = 4200) {
  const p = new Float32Array(n * 3);
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    p[i * 3] = s * Math.cos(a);
    p[i * 3 + 1] = u;
    p[i * 3 + 2] = s * Math.sin(a);
    const k = 0.35 + Math.pow(Math.random(), 4) * 0.9;
    c[i * 3] = k * 0.85;
    c[i * 3 + 1] = k;
    c[i * 3 + 2] = k * 0.9;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

export function createGlobe(scene, manager) {
  const group = new THREE.Group();
  group.name = 'globe';
  scene.add(group);

  const texLoader = new THREE.TextureLoader(manager);
  const albedo = texLoader.load('textures/earth/albedo.webp');
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = THREE.RepeatWrapping;
  albedo.anisotropy = 4;
  const lights = texLoader.load('textures/earth/lights.webp');
  lights.colorSpace = THREE.SRGBColorSpace;
  lights.wrapS = THREE.RepeatWrapping;
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;

  const sunEl = (GLOBE.sunElevation * Math.PI) / 180;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uGeo: { value: GEO },
    uLand: { value: blank },
    uLights: { value: lights },
    uAlbedo: { value: albedo },
    uMode: { value: 0 },
    uLocal: { value: 1 },
    uGrat: { value: 0 },
    uRimW: { value: 0 },
    uTerrainScale: { value: 1 },
    uLightsW: { value: 0.3 },
    // the sun sits west of the city, a little under its horizon: dusk
    uSun: { value: new THREE.Vector3(-Math.cos(sunEl), Math.sin(sunEl), 0.18).normalize() },
    uGridOrigin: { value: new THREE.Vector2(CITY.bounds.minX, CITY.bounds.minZ) },
    uOcean: { value: new THREE.Color(0x010805) },
    uLandCol: { value: new THREE.Color(0x052a16) },
    uNearCol: { value: new THREE.Color(0x02100a) },
    uGridCol: { value: new THREE.Color(0x1f8c4a) },
    uGratCol: { value: new THREE.Color(0x35ff7d) },
    uRimCol: { value: new THREE.Color(0x35ff7d) },
    uLightCol: { value: new THREE.Color(0x9fffc8) },
    uTexNear: { value: new THREE.Color(0x0f1416) },
    uTexRim: { value: new THREE.Color(0x6aa8ff) },
  }]);
  // UniformsUtils.merge clones values — keep the live texture references
  uniforms.uLights.value = lights;
  uniforms.uAlbedo.value = albedo;
  uniforms.uGeo.value = GEO;

  const surfaceMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: surfaceVert,
    fragmentShader: surfaceFrag,
    fog: true,
  });
  const surface = new THREE.Mesh(buildSurface(), surfaceMat);
  surface.name = 'globe-surface';
  surface.renderOrder = -2;
  group.add(surface);

  // coastlines arrive with the land data
  const coastMat = new THREE.LineBasicMaterial({ color: 0x49ff8c, transparent: true, opacity: 0, depthWrite: false });
  let coast = null;
  const ready = loadLand('geo/land.json').then((land) => {
    uniforms.uLand.value = buildLandMask(land);
    coast = new THREE.LineSegments(buildCoast(land), coastMat);
    coast.name = 'coastlines';
    coast.frustumCulled = false;
    group.add(coast);
  });

  // atmosphere
  const thickness = Math.max(R * 0.018, 20_000);
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: {
      uCenter: { value: CENTER.clone() },
      uR: { value: R },
      uRa: { value: R + thickness },
      uColor: { value: new THREE.Color(0x35ff7d) },
      uOpacity: { value: 0 },
    },
    vertexShader: atmoVert,
    fragmentShader: atmoFrag,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const atmoGeo = new THREE.SphereGeometry(R + thickness, 128, 64);
  atmoGeo.translate(0, -R, 0);
  const atmosphere = new THREE.Mesh(atmoGeo, atmoMat);
  atmosphere.name = 'atmosphere';
  atmosphere.frustumCulled = false;
  atmosphere.renderOrder = 1;
  group.add(atmosphere);

  // stars: a shell that rides the camera, drawn first and behind everything
  const starMat = new THREE.PointsMaterial({
    size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false,
  });
  const stars = new THREE.Points(buildStars(), starMat);
  stars.name = 'stars';
  stars.frustumCulled = false;
  stars.renderOrder = -10;
  group.add(stars);

  let mode = 'holo';
  let modeT = 0;
  const holoAtmo = new THREE.Color(0x35ff7d);
  const texAtmo = new THREE.Color(0x5a9cff);

  return {
    group,
    surface,
    atmosphere,
    stars,
    ready,
    get coast() { return coast; },
    setMode(m) { mode = m; },
    // everything the band weights drive; called once per frame
    update(camera, altitude, w, dt = 0.016) {
      modeT += ((mode === 'textured' ? 1 : 0) - modeT) * (1 - Math.exp(-6 * dt));
      if (Math.abs(modeT - (mode === 'textured' ? 1 : 0)) < 1e-3) modeT = mode === 'textured' ? 1 : 0;
      uniforms.uMode.value = modeT;
      uniforms.uLocal.value = w.localGrid;
      uniforms.uGrat.value = w.graticule;
      uniforms.uRimW.value = w.atmosphere;
      uniforms.uLightsW.value = 0.04 + 0.3 * Math.min(1, Math.max(0, Math.log(altitude / 60_000) / Math.log(40)));

      atmoMat.uniforms.uOpacity.value = w.atmosphere * 1.15;
      atmoMat.uniforms.uColor.value.copy(holoAtmo).lerp(texAtmo, modeT);
      atmosphere.visible = w.atmosphere > 0.002;

      coastMat.opacity = w.coast * (0.55 - 0.3 * modeT);
      if (coast) coast.visible = w.coast > 0.002;

      starMat.opacity = w.stars;
      stars.visible = w.stars > 0.002;
      if (stars.visible) {
        stars.position.copy(camera.position);
        stars.scale.setScalar(camera.far * 0.45);
      }
    },
  };
}

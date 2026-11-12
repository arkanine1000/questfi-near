import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { CITY, COLORS } from './config.js';
import { makeGridTexture } from './textures.js';
import { holoFillMaterial } from './holo.js';
import { createFader } from './fade.js';

// The City: one optimized GLB (see tools/optimize-city.mjs) plus its
// pre-baked edge lines (tools/bake-edges.mjs). The hologram is the default
// look - holo fill on every mesh, the baked edges over it, the asphalt plane
// as the lobby's glowing grid. H drops the projection: the real textures
// come back under a dusk sky. A runtime wireframe over 1.66 M triangles
// would stall for seconds on first build and push 10 M line vertices a
// frame; the baked edges are 1.36 M segments in two draw calls.

export function createCity(scene, manager) {
  const group = new THREE.Group();
  scene.add(group);

  const world = { group, ready: false, meshes: [] };

  // lighting: a cold moon, a sky wash, the ground bouncing a little green
  const moon = new THREE.DirectionalLight(0xaac4ff, 1.1);
  moon.position.set(-300, 520, 180);
  group.add(moon);
  group.add(new THREE.HemisphereLight(0x5570a0, 0x14201a, 1.7));
  group.add(new THREE.AmbientLight(0x22352c, 1.8));

  // the ground plane gets a holo grid in hologram mode
  const gridTex = makeGridTexture({ lineWidth: 2, glowWidth: 5, brightness: 0.3, bg: '#02100a' });
  gridTex.repeat.set((CITY.bounds.maxX - CITY.bounds.minX) / 6, (CITY.bounds.maxZ - CITY.bounds.minZ) / 6);
  const gridMat = new THREE.MeshBasicMaterial({ map: gridTex });

  const holoFill = holoFillMaterial(0x1fd465, { intensity: 0.05, base: 0.05 });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x49ff8c, transparent: true, opacity: 0.3 });
  // street lamps / traffic lights keep burning in the projection
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xc8ffe0 });
  const LAMP = /EmissionLamp|TrafficLight|GlassRedLight|GlassGreenLight|^Emission|Emisson/i;

  const originals = new Map();
  let asphalt = null;
  let asphaltOrig = null;
  let wantHolo = true;
  let fader = null;
  let fade = 1;

  const edges = new THREE.Group();
  edges.visible = wantHolo;
  group.add(edges);

  const loader = new GLTFLoader(manager);
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.load(CITY.file, (gltf) => {
    const root = gltf.scene;
    let tris = 0;
    root.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        if (m.map) m.map.anisotropy = 4;
        for (const rule of CITY.emissive) {
          if (rule.match.test(m.name)) {
            m.emissive = new THREE.Color(rule.color);
            m.emissiveIntensity = rule.intensity;
            if (m.map && !m.emissiveMap) m.emissiveMap = m.map;
            break;
          }
        }
        if (/Asphalt/i.test(m.name)) {
          asphalt = o;
          asphaltOrig = m;
        }
      }
      const g = o.geometry;
      tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      originals.set(o, o.material);
      world.meshes.push(o);
    });
    group.add(root);
    // the dissolve from kilometers up (GLOBE_ZOOM_SPEC: city → impostor):
    // every material the city can wear joins the fader before first use
    fader = createFader(root);
    [holoFill, lampMat, gridMat].forEach(fader.add);
    fader.set(fade);
    world.ready = true;
    world.tris = tris;
    world.setHologram(wantHolo);
  });
  loader.load(CITY.edges, (gltf) => {
    gltf.scene.traverse((o) => {
      if (o.isLineSegments || o.isLine) {
        o.material = edgeMat;
        o.frustumCulled = false; // two city-wide chunks; culling them is pointless
      }
    });
    edges.add(gltf.scene);
  });

  world.setHologram = (on) => {
    wantHolo = on;
    for (const [mesh, mat] of originals) mesh.material = on ? (LAMP.test(mat.name) ? lampMat : holoFill) : mat;
    edges.visible = on && fade > 0.003;
    if (asphalt) asphalt.material = on ? gridMat : asphaltOrig;
    scene.background = new THREE.Color(on ? COLORS.bg : 0x030a10);
    scene.fog.color.setHex(on ? COLORS.fog : 0x04101a);
    moon.intensity = on ? 0.2 : 1.1;
  };

  // 1 = solid, 0 = gone (and not drawn)
  world.setFade = (f) => {
    fade = f;
    fader?.set(f);
    edgeMat.opacity = 0.3 * f;
    edges.visible = wantHolo && f > 0.003;
  };

  world.update = () => {};

  return world;
}

// Inspect an FBX: clip names, bbox, bones, skinned meshes, texture refs.
// usage: node tools/inspect-fbx.mjs <file.fbx> [...]
import fs from 'node:fs';
// minimal DOM stubs so FBXLoader's texture path doesn't explode in node
globalThis.self = globalThis; globalThis.window = globalThis;
globalThis.document = {
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }),
  createElement: () => ({ getContext: () => null, addEventListener() {}, removeEventListener() {}, style: {} }),
};
globalThis.URL.createObjectURL ??= () => 'blob:stub';
const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
for (const file of process.argv.slice(2)) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new FBXLoader();
  let obj;
  try { obj = loader.parse(ab, ''); } catch (e) { console.log('!!', file, e.message); continue; }
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  let bones = 0, skinned = 0, meshes = 0, tris = 0; const boneNames = []; const mats = new Set(); const maps = new Set();
  obj.traverse((o) => {
    if (o.isBone) { bones++; if (boneNames.length < 80) boneNames.push(o.name); }
    if (o.isSkinnedMesh) skinned++;
    if (o.isMesh) { meshes++; const g = o.geometry; tris += Math.round((g.index ? g.index.count : g.attributes.position.count) / 3);
      const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach((m) => { mats.add(m.name); if (m.map?.name) maps.add(m.map.name); if (m.map?.image?.src) maps.add(m.map.image.src); }); }
  });
  console.log(`== ${file}`);
  console.log(`   bbox min ${box.min.toArray().map(v=>v.toFixed(1))} max ${box.max.toArray().map(v=>v.toFixed(1))} size ${size.toArray().map(v=>v.toFixed(1))}`);
  console.log(`   meshes=${meshes} skinned=${skinned} tris=${tris} bones=${bones} mats=${[...mats].join(',')} maps=${[...maps].join(',')}`);
  console.log(`   clips: ${obj.animations.map(c => `${c.name}(${c.duration.toFixed(2)}s,${c.tracks.length}tr)`).join(' | ')}`);
  console.log(`   bones: ${boneNames.join(',')}`);
  console.log(`   root children: ${obj.children.map(c => `${c.name}[${c.type}]`).join(', ')}`);
}

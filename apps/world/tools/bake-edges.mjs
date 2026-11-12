// Bake the hologram's edge lines offline: EdgesGeometry (crease angle > threshold +
// boundary edges) over every primitive of the optimized city, merged into a few big
// LINES primitives and meshopt-compressed.  usage: node bake-edges.mjs city.glb city_edges.glb [angleDeg]
import { NodeIO, Document, Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import * as THREE from 'three';
const [,, input, output, angleArg] = process.argv;
const ANGLE = Number(angleArg ?? 20);
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(input);
const scene = doc.getRoot().listScenes()[0];
const chunks = []; let cur = []; let curCount = 0; let totalSeg = 0; let prims = 0;
const m4 = new THREE.Matrix4(); const v = new THREE.Vector3();
scene.traverse((node) => {
  const mesh = node.getMesh(); if (!mesh) return;
  m4.fromArray(node.getWorldMatrix());
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
    const pos = prim.getAttribute('POSITION'); const idx = prim.getIndices();
    const n = pos.getCount(); const arr = new Float32Array(n * 3); const tmp = [0, 0, 0];
    for (let i = 0; i < n; i++) { pos.getElement(i, tmp); v.set(tmp[0], tmp[1], tmp[2]).applyMatrix4(m4); arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    if (idx) g.setIndex(new THREE.BufferAttribute(idx.getArray().slice(), 1));
    const e = new THREE.EdgesGeometry(g, ANGLE);
    const ep = e.getAttribute('position').array;
    if (ep.length) { cur.push(ep); curCount += ep.length / 3; totalSeg += ep.length / 6; prims++; }
    if (curCount > 1_500_000) { chunks.push({ parts: cur, count: curCount }); cur = []; curCount = 0; }
    g.dispose(); e.dispose();
  }
});
if (curCount) chunks.push({ parts: cur, count: curCount });
console.log('prims', prims, 'segments', totalSeg, 'chunks', chunks.length);
const out = new Document();
const buffer = out.createBuffer();
const sc = out.createScene('edges');
chunks.forEach((ch, i) => {
  const arr = new Float32Array(ch.count * 3); let o = 0;
  for (const p of ch.parts) { arr.set(p, o); o += p.length; }
  const acc = out.createAccessor().setType('VEC3').setArray(arr).setBuffer(buffer);
  const prim = out.createPrimitive().setMode(Primitive.Mode.LINES).setAttribute('POSITION', acc);
  const mesh = out.createMesh(`edges_${i}`).addPrimitive(prim);
  sc.addChild(out.createNode(`edges_${i}`).setMesh(mesh));
});
const outIo = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
await out.transform(quantize({ quantizePosition: 14 }), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
await outIo.write(output, out);
console.log('wrote', output);

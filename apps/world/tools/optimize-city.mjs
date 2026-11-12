// Tolerant city optimizer: per-texture resize + WebP (bad JPEGs fall back to a flat tile),
// then dedup/flatten/join/weld/meshopt. usage: node optimize-city.mjs in.glb out.glb [maxTex]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, flatten, join, weld, prune, resample, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
const [,, input, output, maxArg] = process.argv;
const MAX = Number(maxArg ?? 1024);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
await MeshoptEncoder.ready;
const doc = await io.read(input);
const root = doc.getRoot();
const skipTextures = process.argv.includes('--skip-textures');
if (!skipTextures) doc.createExtension(EXTTextureWebP).setRequired(true);
let i = 0, failed = 0, bytesIn = 0, bytesOut = 0;
for (const tex of skipTextures ? [] : root.listTextures()) {
  const img = tex.getImage(); if (!img) continue;
  bytesIn += img.byteLength;
  const name = tex.getName() || tex.getURI() || `tex${i}`;
  i++;
  let out;
  try {
    let s = sharp(Buffer.from(img), { failOn: 'none', limitInputPixels: false });
    const meta = await s.metadata();
    if (Math.max(meta.width, meta.height) > MAX) s = s.resize({ width: MAX, height: MAX, fit: 'inside' });
    out = await s.webp({ quality: 72 }).toBuffer();
  } catch (e) {
    failed++;
    console.log('texture fallback:', name, '-', e.message);
    out = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 120, g: 120, b: 120, alpha: 1 } } }).webp().toBuffer();
  }
  bytesOut += out.byteLength;
  tex.setImage(new Uint8Array(out)).setMimeType('image/webp');
  if (i % 50 === 0) console.log(`textures ${i}/${root.listTextures().length}`);
}
console.log(`textures: ${(bytesIn / 1e6).toFixed(1)}MB -> ${(bytesOut / 1e6).toFixed(1)}MB, ${failed} fallbacks`);
if (!skipTextures) { await io.write(output.replace(/\.glb$/, '_tex.glb'), doc); console.log('cached texture pass'); }
const doJoin = process.argv.includes('--join');
await doc.transform(
  dedup(),
  flatten(),
  ...(doJoin ? [join({ keepNamed: false })] : []),
  weld(),
  resample(),
  prune(),
  meshopt({ encoder: MeshoptEncoder, level: 'high' })
);
let prims = 0; for (const m of root.listMeshes()) prims += m.listPrimitives().length;
console.log('after join: meshes', root.listMeshes().length, 'prims', prims, 'materials', root.listMaterials().length, 'nodes', root.listNodes().length);
await io.write(output, doc);
console.log('wrote', output);

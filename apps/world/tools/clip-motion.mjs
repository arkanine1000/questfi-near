// For each clip in an FBX: how much do the tracks actually move? (max key deviation per track)
import fs from 'node:fs';
globalThis.self = globalThis; globalThis.window = globalThis;
globalThis.document = { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }), createElement: () => ({ getContext: () => null, addEventListener() {}, removeEventListener() {}, style: {} }) };
globalThis.URL.createObjectURL ??= () => 'blob:stub';
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
for (const file of process.argv.slice(2)) {
  const buf = fs.readFileSync(file);
  const obj = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  console.log('==', file);
  for (const c of obj.animations) {
    let moving = 0; const movers = [];
    for (const t of c.tracks) {
      const n = t.getValueSize(); let dev = 0;
      for (let i = n; i < t.values.length; i++) dev = Math.max(dev, Math.abs(t.values[i] - t.values[i % n]));
      if (dev > 0.01) { moving++; if (movers.length < 6) movers.push(`${t.name}:${dev.toFixed(2)}`); }
    }
    console.log(`   ${c.name} (${c.duration.toFixed(2)}s) moving ${moving}/${c.tracks.length}  ${movers.join(' ')}`);
  }
}

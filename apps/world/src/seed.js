// Deterministic takes: with ?cinematic or ?seed=N, Math.random becomes a
// seeded generator (mulberry32) before any other module runs, so the sim,
// the traffic and the starfield come out the same on every recording.
// Imported first in main.js.
const p = new URLSearchParams(location.search);
if (p.has('cinematic') || p.has('seed')) {
  let a = (Number(p.get('seed')) || 0x51ce5eed) >>> 0;
  Math.random = function mulberry32() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

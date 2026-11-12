// Fade a whole subtree without re-sorting it: opaque materials switch to
// alpha-hash (a dithered dissolve, compiled once up front so the dive never
// hitches), transparent ones scale their opacity. At 0 the root hides and
// costs no draw calls. `skip` leaves materials whose opacity something else
// animates every frame.

export function createFader(root, { skip = [] } = {}) {
  const entries = [];
  const seen = new Set(skip);
  const add = (m) => {
    if (!m || seen.has(m)) return;
    seen.add(m);
    entries.push({ m, base: m.opacity });
    if (!m.transparent) {
      m.alphaHash = true;
      m.needsUpdate = true;
    }
  };
  root.traverse((o) => {
    if (!o.material) return;
    if (Array.isArray(o.material)) o.material.forEach(add);
    else add(o.material);
  });
  let cur = 1;
  return {
    add, // materials swapped in later (hologram ↔ textured) join the fade
    set(f) {
      if (Math.abs(f - cur) < 1e-4) return;
      cur = f;
      for (const e of entries) e.m.opacity = e.base * f;
      root.visible = f > 0.003;
    },
    get value() { return cur; },
  };
}

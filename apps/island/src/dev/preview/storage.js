/**
 * Preview mode's localStorage: an in-memory store, seeded per scenario.
 *
 * The dev origin is shared with real local runs, so a preview must neither
 * read the visitor's real test account nor write its fake one where the real
 * app would find it. Every Storage call on `localStorage` is redirected here
 * for the life of the page; `sessionStorage` is left alone.
 */

export function installMemoryStorage(seed = {}) {
  const real = window.localStorage;
  const mem = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const proto = Storage.prototype;
  const pick = (self) => (self === real ? mem : null);
  const orig = {
    getItem: proto.getItem,
    setItem: proto.setItem,
    removeItem: proto.removeItem,
    clear: proto.clear,
    key: proto.key,
  };
  proto.getItem = function getItem(k) {
    const m = pick(this);
    return m ? (m.has(String(k)) ? m.get(String(k)) : null) : orig.getItem.call(this, k);
  };
  proto.setItem = function setItem(k, v) {
    const m = pick(this);
    if (m) m.set(String(k), String(v));
    else orig.setItem.call(this, k, v);
  };
  proto.removeItem = function removeItem(k) {
    const m = pick(this);
    if (m) m.delete(String(k));
    else orig.removeItem.call(this, k);
  };
  proto.clear = function clear() {
    const m = pick(this);
    if (m) m.clear();
    else orig.clear.call(this);
  };
  proto.key = function key(i) {
    const m = pick(this);
    return m ? [...m.keys()][i] ?? null : orig.key.call(this, i);
  };
  // `length` is an accessor on the prototype
  const lengthDesc = Object.getOwnPropertyDescriptor(proto, 'length');
  Object.defineProperty(proto, 'length', {
    configurable: true,
    get() {
      const m = pick(this);
      return m ? m.size : lengthDesc.get.call(this);
    },
  });
  return mem;
}

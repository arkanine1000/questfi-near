/**
 * When is a preview page done? When everything its scenario needs has been
 * answered, the network has gone quiet, the scripted steps have run and the
 * page has had a moment to settle. Then <html data-preview-ready="1">; the
 * screenshot script waits for exactly that. A page that cannot get there
 * says why in data-preview-error instead.
 *
 * Steps find their targets the way a person would: by accessible name
 * (aria-label, else visible text), never by class name.
 */

const root = () => document.documentElement;

export function createTracker() {
  const served = new Map();
  const open = new Set();
  const blockedHosts = new Set();
  let seq = 0;
  let lastActivity = performance.now();
  return {
    note(kind) {
      served.set(kind, (served.get(kind) ?? 0) + 1);
      lastActivity = performance.now();
    },
    begin() {
      seq += 1;
      open.add(seq);
      lastActivity = performance.now();
      return seq;
    },
    end(tok) {
      if (open.delete(tok)) lastActivity = performance.now();
    },
    blocked(href) {
      blockedHosts.add(new URL(href).origin);
      root().dataset.previewBlocked = [...blockedHosts].join(' ');
    },
    has: (kind) => served.has(kind),
    get inflight() { return open.size; },
    get quietFor() { return open.size ? 0 : performance.now() - lastActivity; },
    get served() { return Object.fromEntries(served); },
  };
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function until(test, timeoutMs, stepMs = 80) {
  const t0 = performance.now();
  for (;;) {
    const v = test();
    if (v) return v;
    if (performance.now() - t0 > timeoutMs) return null;
    await sleep(stepMs); // eslint-disable-line no-await-in-loop
  }
}

function accessibleName(el) {
  return (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
}

function visible(el) {
  if (!el.getClientRects().length) return false;
  if (el.closest('[inert], [aria-hidden="true"]')) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
}

function findClickable(re) {
  const els = document.querySelectorAll('button, a[href], [role="button"]');
  for (const el of els) {
    if (!el.disabled && visible(el) && re.test(accessibleName(el))) return el;
  }
  return null;
}

async function runStep(step) {
  if (step.hex) {
    const [q, r] = String(step.hex).split(',').map(Number);
    const ok = await until(() => window.__questfiPreview?.selectHex?.({ q, r }), 6000);
    if (!ok) throw new Error(`step: nothing took the click on hex ${step.hex}`);
  } else if (step.click) {
    const el = await until(() => findClickable(step.click), 8000);
    if (!el) throw new Error(`step: no visible, enabled control named ${step.click}`);
    el.click();
  }
  await sleep(step.settleMs ?? 450);
}

function imagesLoaded() {
  return [...document.images].every((img) => img.complete);
}

/**
 * Wait for the spec's readiness, run its steps, settle, then flag the page.
 * Never throws: a failure lands in data-preview-error.
 */
export async function watchReadiness(spec, tracker) {
  const fail = (msg) => {
    root().dataset.previewError = msg;
    root().dataset.previewReady = 'error';
    console.error(`[preview] ${msg}`);
  };
  try {
    const need = spec.ready ?? [];
    const got = await until(() => need.every((k) => tracker.has(k)), 20000);
    if (!got) {
      const missing = need.filter((k) => !tracker.has(k));
      fail(`timed out waiting for ${missing.join(', ')} (answered: ${JSON.stringify(tracker.served)})`);
      return;
    }
    await until(() => tracker.quietFor > 350 && imagesLoaded(), 15000);
    for (const step of spec.steps ?? []) {
      await runStep(step); // eslint-disable-line no-await-in-loop
      await until(() => tracker.quietFor > 300, 8000); // eslint-disable-line no-await-in-loop
    }
    await sleep(spec.settleMs ?? 1300);
    await until(imagesLoaded, 5000);
    await document.fonts?.ready;
    const canvas = document.querySelector('canvas');
    if (canvas) {
      fail(`a <canvas> is in the page (inside ${canvas.parentElement?.outerHTML.slice(0, 120)}…)`);
      return;
    }
    root().dataset.previewReady = '1';
  } catch (err) {
    fail(String(err?.message ?? err));
  }
}

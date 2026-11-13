/**
 * Preview mode: ?preview=<scenario> on the dev server renders the real
 * interface from recorded data, with no canvas and no network. App.jsx loads
 * this lazily and only in development; nothing here reaches a production
 * bundle.
 *
 * On import, before the app mounts, it puts in place:
 *   - an in-memory localStorage, seeded for the scenario (storage.js), so
 *     the real app's slots on this origin are neither read nor written;
 *   - a fetch that serves the game server, its SSE stream, the NEAR RPC and
 *     the test-account service from fixtures (network.js);
 *   - window.__questfiPreview, which the canvas-holding components check to
 *     render a DOM stand-in instead of a <canvas> (standIns.jsx);
 *   - a getContext that never creates a WebGL context.
 * Then it mounts the app's own providers and SandboxView.
 *
 * ?preview with no (or an unknown) name lists every scenario.
 */

import { Component, useEffect, useState } from 'react';
import { SandboxProvider } from '../../context/SandboxContext';
import { NearProvider } from '../../context/NearContext';
import SandboxView from '../../components/Sandbox/SandboxView';
import { SCENARIOS } from './catalog';
import {
  CONTRACT_ID, FAKE_TX, GUEST_SLOT, VISITOR, buildScenario,
} from './scenarios';
import { installMemoryStorage } from './storage';
import { installNetwork } from './network';
import { createTracker, watchReadiness } from './readiness';
import { selectHex, standIn } from './standIns';
import Gallery from './Gallery';
import './preview.css';

const params = new URLSearchParams(window.location.search);
const name = params.get('preview');
const root = document.documentElement;
root.dataset.preview = name || 'index';

/** WebGL never gets a context here. A stub keeps isWebGLAvailable() truthy,
 * so the app takes its normal path, where the stand-ins take over. */
function refuseWebGL() {
  const stub = Object.freeze({ previewStub: true });
  for (const proto of [window.HTMLCanvasElement?.prototype, window.OffscreenCanvas?.prototype]) {
    if (!proto) continue;
    const real = proto.getContext;
    proto.getContext = function getContext(type, ...rest) {
      if (/webgl|webgpu/i.test(String(type))) return stub;
      return real.call(this, type, ...rest);
    };
  }
}

let spec = null;
let buildError = null;
let redirecting = false;
const tracker = createTracker();

if (name && name !== 'gallery' && name !== 'index') {
  try {
    spec = buildScenario(params);
  } catch (err) {
    buildError = err;
  }
}

if (spec?.needView === 'tv' && params.get('view') !== 'tv') {
  // cast.js reads ?view=tv once, at load
  params.set('view', 'tv');
  redirecting = true;
  window.location.replace(`${window.location.pathname}?${params}`);
}

if (!redirecting) {
  refuseWebGL();
  installMemoryStorage(spec?.storage ?? {});
  window.__questfiPreview = { standIn, selectHex, note: (k) => tracker.note(k) };
  if (spec) {
    installNetwork(spec, tracker);
    // the address bar the app reads at mount: the world to attach, the pass to follow
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(spec.url ?? {})) next.set(k, v);
    window.history.replaceState(null, '', `${window.location.pathname}?${next}`);
    root.dataset.previewTitle = spec.title ?? name;
  } else {
    installNetwork({ game: {} }, tracker); // the index and gallery need nothing
  }
}

/** The visitor's test account: a fresh key pair, made here, kept in memory. */
async function seedVisitor() {
  if (!spec?.guest) return;
  const { KeyPair } = await import('near-api-js');
  const secretKey = KeyPair.fromRandom('ed25519').toString();
  localStorage.setItem(GUEST_SLOT, JSON.stringify({ accountId: VISITOR, secretKey }));
  if (spec.feed) {
    const seasonId = spec.url?.world;
    const at = Date.parse('2026-11-13T17:21:50Z');
    localStorage.setItem(`questfi.island.txs:${CONTRACT_ID}:${seasonId}:${VISITOR}`, JSON.stringify([
      { method: 'place_bet', label: '0.05 NEAR on Kell', txHash: FAKE_TX[0], ok: true, at: at + 4000 },
      { method: 'place_bet', label: '0.01 NEAR on Marra', txHash: FAKE_TX[1], ok: true, at },
    ]));
  }
}

class PreviewBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    root.dataset.previewError = `the app crashed: ${error?.message ?? error}`;
    root.dataset.previewReady = 'error';
  }

  render() {
    if (this.state.error) {
      return <pre className="pv-error">{`Preview: the app crashed.\n\n${this.state.error?.stack ?? this.state.error}`}</pre>;
    }
    return this.props.children;
  }
}

function ScenarioIndex({ problem }) {
  useEffect(() => {
    document.fonts?.ready.then(() => { root.dataset.previewReady = '1'; });
  }, []);
  return (
    <div className="pv-page" data-preview-backdrop="index">
      <h1>Preview scenarios</h1>
      <p>
        {problem ?? 'Each link renders the interface from recorded data, with no canvas and no network. Development server only.'}
      </p>
      <div className="pv-index">
        {SCENARIOS.map((s) => (
          <a key={s.name} href={`?${s.query}`}>
            {s.name}
            <small>?{s.query}</small>
          </a>
        ))}
      </div>
    </div>
  );
}

function GalleryPage() {
  useEffect(() => {
    document.fonts?.ready.then(() => { root.dataset.previewReady = '1'; });
  }, []);
  return <Gallery />;
}

function ScenarioApp() {
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    let live = true;
    seedVisitor()
      .catch((err) => { root.dataset.previewError = `could not seed the test account: ${err?.message ?? err}`; })
      .finally(() => { if (live) setSeeded(true); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (seeded) watchReadiness(spec, tracker);
  }, [seeded]);
  if (!seeded) return null;
  return (
    <PreviewBoundary>
      <SandboxProvider>
        <NearProvider contractId={spec.contractId}>
          <SandboxView />
        </NearProvider>
      </SandboxProvider>
    </PreviewBoundary>
  );
}

export default function PreviewApp() {
  if (redirecting) return null;
  if (name === 'gallery') return <GalleryPage />;
  if (!spec) {
    const problem = buildError
      ? `Could not build "${name}": ${buildError.message}`
      : name && name !== 'index' ? `No scenario named "${name}". Pick one:` : null;
    return <ScenarioIndex problem={problem} />;
  }
  return <ScenarioApp />;
}


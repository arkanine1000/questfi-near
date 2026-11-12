import { lazy, Suspense } from 'react';
import { SandboxProvider } from './context/SandboxContext';
import { NearProvider } from './context/NearContext';
import SandboxView from './components/Sandbox/SandboxView';

// Dev-only viewmodel harness (?bench=weapon). Lazy + DEV-gated so it never
// reaches a production bundle.
const WeaponBench = import.meta.env.DEV
  ? lazy(() => import('./components/Scene3D/Crawler/WeaponBench'))
  : null;

// The multi-agent sandbox is the product, and now the only view. ?view=tv is
// still the sandbox — the lean-back broadcast cut (cast receiver / TV
// browsers), handled inside SandboxView via services/cast.js.
export default function App() {
  if (WeaponBench && new URLSearchParams(window.location.search).get('bench') === 'weapon') {
    return (
      <Suspense fallback={null}>
        <WeaponBench />
      </Suspense>
    );
  }
  return (
    <SandboxProvider>
      <NearProvider>
        <SandboxView />
      </NearProvider>
    </SandboxProvider>
  );
}

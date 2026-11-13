import { lazy, Suspense } from 'react';
import { SandboxProvider } from './context/SandboxContext';
import { NearProvider } from './context/NearContext';
import { LayoutProvider } from './context/LayoutContext';
import SandboxView from './components/Sandbox/SandboxView';

// Dev-only viewmodel harness (?bench=weapon). Lazy + DEV-gated so it never
// reaches a production bundle.
const WeaponBench = import.meta.env.DEV
  ? lazy(() => import('./components/Scene3D/Crawler/WeaponBench'))
  : null;

// Dev-only preview mode (?preview=<scenario>): the interface from recorded
// data, with no canvas and no network (src/dev/preview). Lazy + DEV-gated
// like the bench, so none of it reaches a production bundle.
const Preview = import.meta.env.DEV
  ? lazy(() => import('./dev/preview/PreviewApp'))
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
  if (Preview && new URLSearchParams(window.location.search).has('preview')) {
    return (
      <Suspense fallback={null}>
        <Preview />
      </Suspense>
    );
  }
  return (
    <SandboxProvider>
      <NearProvider>
        <LayoutProvider>
          <SandboxView />
        </LayoutProvider>
      </NearProvider>
    </SandboxProvider>
  );
}

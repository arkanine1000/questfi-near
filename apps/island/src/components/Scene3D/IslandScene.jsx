import {
  Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { Canvas, useFrame } from '@react-three/fiber';
import Terrain from './Terrain';
import TerrainProps from './TerrainProps';
import FloatingWeapons from './FloatingWeapons';
import EnemyHolograms from './EnemyHolograms';
import HexGrid3D from './HexGrid3D';
import CameraRig from './CameraRig';
import HouseFx, { houseFxAllowedByUrl } from './HouseFx';
import TableStage from './TableStage';
import MissileArc from './MissileArc';
import {
  prefersReducedMotion, canUseBloom, isTouchDevice, COLORS,
} from './worldUtils';
import { look, LOOK_DEFAULTS, subscribeLook, lookVersion } from './look';
import { IS_TV } from '../../services/cast';
import '../../styles/Scene3D.css';

// Development-only tuning panel (?look=1). Lazy and DEV-gated so it never
// reaches a production bundle; production renders the look defaults.
const LookPanel = import.meta.env.DEV ? lazy(() => import('./LookPanel')) : null;
const SHOW_LOOK_PANEL = import.meta.env.DEV && typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('look') === '1';

// Clicks that follow an orbit drag larger than this (px) don't deselect
const DRAG_CLICK_PX = 5;

/** Keeps the fog density on the look store's value. */
function LookFog() {
  useFrame(({ scene }) => {
    if (scene.fog) scene.fog.density = look.fogDensity;
  });
  return null;
}

/** The house post pass with the island's values from the look store. */
function IslandFx({ reducedMotion }) {
  useSyncExternalStore(subscribeLook, lookVersion);
  return (
    <HouseFx
      bloomIntensity={look.bloomIntensity}
      bloomThreshold={look.bloomThreshold}
      bloomRadius={look.bloomRadius}
      grade={look.grade}
      aberration={look.aberration}
      scan={look.scan}
      vignette={look.vignette}
      noise={look.noise}
      reducedMotion={reducedMotion}
    />
  );
}

/**
 * The holographic war table. Renders fullscreen behind the DOM UI chrome;
 * all game state flows through the same selectHex/deselectHex contract as
 * the 2D SVG grid.
 */
export default function IslandScene({
  selectedHex, onSelectHex, onDeselect,
  rippleHexes, wavefrontHexes, warBorderHexes, missileArc,
  interactive = true,
  wireframe = true,
  // The scene draws no agents of its own — the caller supplies the layer.
  // Render-prop receiving { reducedMotion }.
  agentLayer = null,
  focusRequestExternal = null,
  followTarget = null,
  onUnfollow = null,
  onHexDoubleClick = null,
}) {
  const [hoveredKey, setHoveredKey] = useState(null);
  const [focusRequest, setFocusRequest] = useState(null);
  const reducedMotion = useMemo(prefersReducedMotion, []);
  const bloomEnabled = useMemo(canUseBloom, []);
  const fxEnabled = useMemo(() => bloomEnabled && houseFxAllowedByUrl(), [bloomEnabled]);
  const downPos = useRef({ x: 0, y: 0 });

  // Double-click a hex -> fly the camera in (sandbox also rides along)
  const handleFocusHex = useCallback((hex) => {
    setFocusRequest({
      type: 'hex',
      point: [hex.world.x, hex.world.y, hex.world.z],
      ts: Date.now(),
    });
    onHexDoubleClick?.(hex);
  }, [onHexDoubleClick]);

  // Sandbox chrome (roster chips) can drive the camera too
  useEffect(() => {
    if (focusRequestExternal) setFocusRequest(focusRequestExternal);
  }, [focusRequestExternal]);

  // Escape -> home framing + close panel
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setFocusRequest({ type: 'home', ts: Date.now() });
      onDeselect?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDeselect]);

  const handlePointerMissed = useCallback((e) => {
    const dx = e.clientX - downPos.current.x;
    const dy = e.clientY - downPos.current.y;
    if (Math.hypot(dx, dy) > DRAG_CLICK_PX) return;
    if (e.detail === 2) setFocusRequest({ type: 'home', ts: Date.now() });
    onDeselect?.();
  }, [onDeselect]);

  // Tighter DPR when bloom runs on touch hardware (perf budget); drop to 1
  // while the gameplay panel is open and the dungeon canvas is also live.
  // TV receivers (Chromecast-class GPUs pushing 1080p+) always render at 1 —
  // canUseBloom's core-count gate already sheds bloom on the weakest sticks.
  const dpr = IS_TV || !interactive ? 1
    : bloomEnabled && isTouchDevice() ? [1, 1.5] : [1, 2];

  // Preview mode (dev only, src/dev/preview) puts a DOM backdrop here: no canvas.
  if (import.meta.env.DEV && window.__questfiPreview) return window.__questfiPreview.standIn('island', { onSelectHex });

  return (
    <div
      className="island-scene"
      onPointerDown={(e) => { downPos.current = { x: e.clientX, y: e.clientY }; }}
    >
      <Canvas
        flat
        dpr={dpr}
        camera={{ fov: 50, near: 0.1, far: 120, position: [-1.9, 8.7, 7.4] }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onPointerMissed={handlePointerMissed}
      >
        {/* The table is a hologram over a dark room: near-black background,
            a slightly greener fog that the far side of the island fades to */}
        <color attach="background" args={[COLORS.bg]} />
        <fogExp2 attach="fog" args={[COLORS.fog, LOOK_DEFAULTS.fogDensity]} />
        <LookFog />

        {/* The land is unlit; the lights only shape the hologram fills of
            the relics, creatures and the wyvern */}
        <ambientLight color={COLORS.green} intensity={0.25} />
        <directionalLight position={[5, 9, -7]} color="#9dffb8" intensity={0.8} />

        {/* Sea lattice, projector rings and motes: no loading, so the table
            is up before the terrain arrives */}
        <TableStage reducedMotion={reducedMotion} />

        <Suspense fallback={null}>
          <Terrain wireframe={wireframe} />
          <TerrainProps reducedMotion={reducedMotion} wireframe={wireframe} />
          <FloatingWeapons reducedMotion={reducedMotion} />
          <EnemyHolograms reducedMotion={reducedMotion} />
          <HexGrid3D
            selectedHex={selectedHex}
            onSelectHex={onSelectHex}
            onFocusHex={handleFocusHex}
            onHoverChange={setHoveredKey}
            rippleHexes={rippleHexes}
            wavefrontHexes={wavefrontHexes}
            warBorderHexes={warBorderHexes}
            reducedMotion={reducedMotion}
          />
          {agentLayer?.({ reducedMotion })}
          {missileArc && <MissileArc missileArc={missileArc} reducedMotion={reducedMotion} />}
        </Suspense>

        <CameraRig
          focusRequest={focusRequest}
          followTarget={followTarget}
          onUnfollow={onUnfollow}
          enabled={interactive}
          reducedMotion={reducedMotion}
        />

        {fxEnabled && <IslandFx reducedMotion={reducedMotion} />}
      </Canvas>
      {SHOW_LOOK_PANEL && LookPanel && createPortal(
        <Suspense fallback={null}><LookPanel postActive={fxEnabled} /></Suspense>,
        document.body,
      )}
    </div>
  );
}

import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { EffectComposer, Bloom, Noise, Vignette } from '@react-three/postprocessing';
import { canUseBloom, COLORS } from '../worldUtils';
import CrawlerRig from './CrawlerRig';
import CrawlerMaze from './CrawlerMaze';
import CrawlerEnemy from './CrawlerEnemy';
import CrawlerProps from './CrawlerProps';
import CrawlerAmbience from './CrawlerAmbience';
import CrawlerLightPool from './CrawlerLightPool';
import CrawlerWeapon from './CrawlerWeapon';

const FOG_COLOR = COLORS.bg;

// Frames to let land after the shader warm-up, before calling the scene
// presentable. Postprocessing compiles its own chain on the composer's first
// render, and that render can only happen once — these frames buy it.
const WARMUP_FRAMES = 3;

/**
 * Reports the scene as presentable, to whoever is holding the loading
 * screen up. Fires once per mount — but the boundary CAN re-suspend later
 * (a rival arrives with an unloaded weapon, a treasure room first brings in
 * the chest), which remounts the probe and warms the new material set. The
 * consumer must therefore treat readiness as a latch, not an event.
 *
 * Mounted as the LAST child of the asset Suspense boundary, so its effect
 * cannot run until every suspending loader in that boundary has resolved and
 * the real meshes are in the graph.
 *
 * Resolution alone is not readiness. three compiles a material's program on
 * its first draw, and that first draw IS the stutter — so warm every program
 * in the graph up front with compileAsync, then let a few frames land so the
 * composer pays its own compile behind the curtain too.
 */
function SceneReadyProbe({ armed, onReady }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const [warm, setWarm] = useState(false);
  const framesRef = useRef(0);
  const firedRef = useRef(false);

  useEffect(() => {
    let live = true;
    const done = () => { if (live) setWarm(true); };
    // compileAsync is only genuinely async where KHR_parallel_shader_compile
    // exists; elsewhere three compiles synchronously. Either is right here —
    // the cost is paid under the loading screen instead of on the first
    // frame the viewer sees.
    Promise.resolve(gl.compileAsync?.(scene, camera) ?? gl.compile(scene, camera))
      .then(done, done); // a failed warm-up must still open the curtain
    return () => { live = false; };
  }, [gl, scene, camera]);

  useFrame(() => {
    if (!warm || !armed || firedRef.current) return;
    framesRef.current += 1;
    if (framesRef.current < WARMUP_FRAMES) return;
    firedRef.current = true;
    onReady();
  });

  return null;
}

// Postprocessing is strictly cosmetic: if the composer blows up on a flaky
// GL context (software renderers can return null context attributes mid-
// flight), drop the effects and keep the dungeon — never crash the scene.
class PostFxBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.warn('Crawler postprocessing disabled:', error?.message ?? error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The crawler canvas: wide-FOV first-person view drowned in dense phosphor
 * fog, lit almost entirely by the player's flickering torch. Postprocessing
 * (Bloom + Noise + Vignette) rides the same capability gate as the island —
 * the emissive materials must read on their own without it.
 */
export default function CrawlerScene({
  model, queue, activeBeat, weapon, reducedMotion,
  agentsLayer = null, // sandbox seam: rival-agent billboards join the scene
  weaponTint = null, // sandbox seam: the followed agent's color, in-hand
  onReady = null, // sandbox seam: fires once the scene is safe to reveal
}) {
  // Postprocessing mounts only AFTER the real GL context is verified:
  // software/headless GL can hand back null context attributes, which
  // crashes the composer's addPass in the very first commit — so the
  // composer must never render before onCreated has vetted the context.
  // (The emissive materials are tuned to read fine without it.)
  //
  // null means "onCreated has not run yet", which is distinct from a decided
  // false: the readiness probe must not start counting warm-up frames until
  // the composer has had its chance to mount, or it would call the scene
  // ready one commit before the postprocessing shaders compile.
  const [postFx, setPostFx] = useState(null);
  // ?capture=1 keeps the drawing buffer so headless tests can read real
  // canvas pixels (headless compositors screenshot WebGL canvases black)
  const capture = useMemo(
    () => new URLSearchParams(window.location.search).get('capture') === '1',
    [],
  );

  // Tear the test seam down with the scene. Left dangling it hands the
  // harness a stale, emptied scene graph after the crawler unmounts — which
  // reads as "the light count collapsed to zero" rather than "there is no
  // crawler", and silently turns a teardown into a failed assertion.
  useEffect(() => () => { delete window.__crawler; }, []);

  return (
    <Canvas
      dpr={capture ? 1 : [1, 1.5]} // capture mode eases software-GL memory pressure
      gl={{ antialias: true, powerPreference: 'default', preserveDrawingBuffer: capture }}
      camera={{ fov: 90, near: 0.1, far: 40, position: [0, 1.7, 0] }}
      onCreated={({ gl, scene }) => {
        setPostFx(canUseBloom() && !!gl.getContext()?.getContextAttributes?.());
        // Test seam, gated on the same ?capture=1 flag as the preserved
        // drawing buffer: scripts/pw-crawler.mjs reads renderer.info to
        // assert the light pool never grows the shader program count.
        if (capture) window.__crawler = { gl, scene };
      }}
    >
      <color attach="background" args={[FOG_COLOR]} />
      <fog attach="fog" args={[FOG_COLOR, 2, 22]} />
      <ambientLight color={COLORS.deep} intensity={0.8} />

      {/* Rig first: it advances the beat queue for everyone downstream */}
      <CrawlerRig model={model} queue={queue} reducedMotion={reducedMotion} />
      <CrawlerMaze model={model} reducedMotion={reducedMotion} />
      {/* The pool's slots are siblings of the Suspense boundary, not
          children of it — they must exist (and hold the light count fixed)
          before any asset resolves, or the count would change on load and
          recompile every material in the scene. */}
      <CrawlerLightPool reducedMotion={reducedMotion}>
        <Suspense fallback={null}>
          <CrawlerEnemy model={model} queue={queue} reducedMotion={reducedMotion} />
          {agentsLayer}
          <CrawlerProps model={model} queue={queue} activeBeat={activeBeat} reducedMotion={reducedMotion} />
          <CrawlerAmbience model={model} reducedMotion={reducedMotion} />
          <CrawlerWeapon queue={queue} weaponName={weapon?.name ?? null} tint={weaponTint} reducedMotion={reducedMotion} />
          {onReady && <SceneReadyProbe armed={postFx !== null} onReady={onReady} />}
        </Suspense>
      </CrawlerLightPool>

      {postFx && (
        <PostFxBoundary>
          <EffectComposer>
            <Bloom
              mipmapBlur
              intensity={0.9}
              luminanceThreshold={0.18}
              luminanceSmoothing={0.3}
              radius={0.75}
            />
            <Noise premultiply opacity={0.35} />
            <Vignette eskil={false} offset={0.2} darkness={0.85} />
          </EffectComposer>
        </PostFxBoundary>
      )}
    </Canvas>
  );
}

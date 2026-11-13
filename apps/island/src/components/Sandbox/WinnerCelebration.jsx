/**
 * Victory-screen dressing: a procedural holographic trophy (no asset —
 * a lathe cup spun from the same phosphor-gold the card wears) and a
 * full-screen confetti rain in the roster's colors. Both sit out the
 * extinction ending and prefers-reduced-motion.
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';
import { speakLine } from './promptChanVoice';
import { useSandbox } from '../../context/SandboxContext';
import { publicUrl } from '../../services/publicUrl';

// --- the trophy -------------------------------------------------------

// Cup silhouette, base to lip: [radius, height] pairs for LatheGeometry.
const PROFILE = [
  [0.02, 0], [0.46, 0], [0.46, 0.07], [0.34, 0.1], [0.14, 0.14],
  [0.11, 0.3], [0.13, 0.38], [0.3, 0.46], [0.42, 0.6], [0.46, 0.78],
  [0.44, 0.94], [0.42, 0.96], [0.4, 0.9], [0.38, 0.68], [0.3, 0.52],
];

// Outer-wall radius at a given height, sampled off the ascending half of
// PROFILE (base to rim, before it turns back down the inside of the bowl).
// Handles attach here instead of a fixed x-offset — a fixed offset floats
// at a constant radius while the cup's own radius tapers, leaving a gap
// wherever the wall is narrower than the offset (worst at the neck).
const OUTER_WALL = PROFILE.slice(0, 12);
function outerRadiusAt(y) {
  for (let i = 1; i < OUTER_WALL.length; i++) {
    const [r0, y0] = OUTER_WALL[i - 1];
    const [r1, y1] = OUTER_WALL[i];
    if (y <= y1) {
      const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
      return r0 + (r1 - r0) * t;
    }
  }
  return OUTER_WALL[OUTER_WALL.length - 1][0];
}

const HANDLE_Y_LO = 0.5;
const HANDLE_Y_HI = 0.82;
const HANDLE_REACH = 0.22; // how far the loop bows out past the wall

// A loop whose two ends land exactly on the cup's surface at HANDLE_Y_LO/HI
// (whatever the wall radius is there) and bows outward between them.
function handleCurve(side) {
  const rLo = outerRadiusAt(HANDLE_Y_LO);
  const rHi = outerRadiusAt(HANDLE_Y_HI);
  const midY = (HANDLE_Y_LO + HANDLE_Y_HI) / 2;
  const midR = Math.max(rLo, rHi) + HANDLE_REACH;
  return new THREE.CatmullRomCurve3([
    new THREE.Vector3(side * rLo, HANDLE_Y_LO, 0),
    new THREE.Vector3(side * midR, midY, 0),
    new THREE.Vector3(side * rHi, HANDLE_Y_HI, 0),
  ]);
}

function TrophyMesh() {
  const group = useRef();
  const geo = useMemo(
    () => new THREE.LatheGeometry(PROFILE.map(([x, y]) => new THREE.Vector2(x, y)), 48),
    [],
  );
  const handleGeo = useMemo(
    () => [1, -1].map((side) => new THREE.TubeGeometry(handleCurve(side), 20, 0.03, 10, false)),
    [],
  );
  useEffect(() => () => { geo.dispose(); handleGeo.forEach((g) => g.dispose()); }, [geo, handleGeo]);

  useFrame(({ clock }) => {
    if (!group.current) return;
    const t = clock.elapsedTime;
    group.current.rotation.y = t * 0.7;
    group.current.position.y = -0.48 + Math.sin(t * 1.4) * 0.02;
  });

  const gold = (
    <meshStandardMaterial
      color="#b5780f"
      emissive="#ff9900"
      emissiveIntensity={0.42}
      metalness={0.85}
      roughness={0.35}
    />
  );

  return (
    <group ref={group} position={[0, -0.48, 0]}>
      <mesh geometry={geo}>{gold}</mesh>
      {/* the holo wireframe pass — same silhouette, additive scanline green */}
      <mesh geometry={geo} scale={1.012}>
        <meshBasicMaterial
          color="#ffcf6a"
          wireframe
          transparent
          opacity={0.12}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {[1, -1].map((side, i) => (
        <mesh key={side} geometry={handleGeo[i]}>
          {gold}
        </mesh>
      ))}
    </group>
  );
}

export function WinnerTrophy() {
  // Preview mode (dev only, src/dev/preview) puts a DOM placeholder here: no canvas.
  if (import.meta.env.DEV && window.__questfiPreview) return window.__questfiPreview.standIn('trophy');
  return (
    <div className="sbx-winner__trophy" aria-hidden>
      <Canvas
        // far enough back that the lip and both handles clear the frame
        camera={{ position: [0, 0.18, 2.45], fov: 38 }}
        dpr={[1, 2]}
        gl={{ alpha: true, antialias: true }}
      >
        <ambientLight intensity={0.5} />
        <pointLight position={[1.4, 1.6, 1.8]} intensity={26} color="#ffd9a0" />
        <pointLight position={[-1.6, 0.4, 1.2]} intensity={9} color="#69ff8f" />
        <TrophyMesh />
      </Canvas>
    </div>
  );
}

// Placeholder cheer shown the instant the crown lands — her real sign-off
// call takes a few seconds (the backend LLM call), so this fills the gap
// rather than leaving the cameo silent.
const placeholderLine = (name) => `Winner winner!! All hail ${name}-sama — the island `
  + 'remembers its champion! ☆*:.｡.o(≧▽≦)o.｡.:*☆';

/** The caster at her usual desk, cheering the crown — same classes as the
 * live booth so position, size and bubble all match her normal presence.
 * Once her real generated sign-off lands (commentary stamped with the
 * world's final tick), it replaces the placeholder cheer — she's never
 * just a hardcoded line trapped behind the trophy screen. */
export function WinnerChan({ name }) {
  const { world, commentary } = useSandbox();
  const signedOff = commentary != null && commentary.tick === world?.tick;
  const text = signedOff ? commentary.text : placeholderLine(name);

  useEffect(() => {
    speakLine(text);
  }, [text]);

  return (
    <div className="sbx-promptchan sbx-promptchan--victory is-live" aria-live="polite">
      <img
        className="sbx-promptchan__sprite"
        src={publicUrl('/prompt-chan/happy-3.webp')}
        alt=""
        draggable="false"
      />
      <div className="sbx-promptchan__bubble">
        <span className="sbx-promptchan__name">PROMPT-CHAN</span>
        <p className="sbx-promptchan__text">{text}</p>
      </div>
    </div>
  );
}

// --- the confetti -----------------------------------------------------

const CONFETTI_COLORS = [
  '#69ff8f', '#00bfff', '#ffaa00', '#ff5d5d', '#a04dff',
  '#ff67d1', '#4d9fff', '#ffe14d', '#ff9e58', '#8fffe0', '#ffd27a',
];
const COUNT = 150;

export function WinnerConfetti() {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined; // preview mode renders no canvas
    const ctx = canvas.getContext('2d');
    let w = (canvas.width = canvas.offsetWidth);
    let h = (canvas.height = canvas.offsetHeight);

    const spawn = (burst) => ({
      x: Math.random() * w,
      // the opening burst starts mid-air; the standing rain re-enters above
      y: burst ? Math.random() * h * 0.4 : -12,
      vy: 1 + Math.random() * 1.6,
      drift: (Math.random() - 0.5) * 0.7,
      sway: Math.random() * Math.PI * 2,
      swaySpeed: 0.02 + Math.random() * 0.04,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.12,
      size: 4 + Math.random() * 5,
      color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
    });
    const flakes = Array.from({ length: COUNT }, () => spawn(true));

    let raf;
    const onResize = () => {
      w = canvas.width = canvas.offsetWidth;
      h = canvas.height = canvas.offsetHeight;
    };
    window.addEventListener('resize', onResize);

    const step = () => {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < flakes.length; i++) {
        let f = flakes[i];
        f.y += f.vy;
        f.sway += f.swaySpeed;
        f.x += f.drift + Math.sin(f.sway) * 0.8;
        f.rot += f.vr;
        if (f.y > h + 14) f = flakes[i] = spawn(false);
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(f.rot);
        ctx.fillStyle = f.color;
        ctx.globalAlpha = 0.85;
        // scale-x on the sine gives the paper-flip shimmer for free
        ctx.fillRect((-f.size / 2) * Math.cos(f.sway * 1.7), -f.size / 3.4,
          f.size * Math.cos(f.sway * 1.7), f.size / 1.7);
        ctx.restore();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  if (import.meta.env.DEV && window.__questfiPreview) return window.__questfiPreview.standIn('confetti');
  return <canvas ref={canvasRef} className="sbx-winner__confetti" aria-hidden />;
}

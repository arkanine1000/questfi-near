/**
 * The finale's dressing: a procedural holographic trophy (no asset, a lathe
 * cup in the house amber), a confetti rain over the stage in the house
 * colours and the winner's own, and the caster's victory cameo. The trophy
 * and confetti sit out the ending where nobody survived, and the confetti
 * sits out prefers-reduced-motion.
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';
import { speakLine } from './promptChanVoice';
import { useSandbox } from '../../context/SandboxContext';
import { publicUrl } from '../../services/publicUrl';
import { PALETTE } from '../../styles/palette';

// --- the trophy -------------------------------------------------------

// the cup's body: a darker amber than the house amber its glow and wireframe wear
const TROPHY_BODY = '#8a6122';

// Cup silhouette, base to lip: [radius, height] pairs for LatheGeometry.
const PROFILE = [
  [0.02, 0], [0.46, 0], [0.46, 0.07], [0.34, 0.1], [0.14, 0.14],
  [0.11, 0.3], [0.13, 0.38], [0.3, 0.46], [0.42, 0.6], [0.46, 0.78],
  [0.44, 0.94], [0.42, 0.96], [0.4, 0.9], [0.38, 0.68], [0.3, 0.52],
];

// Outer-wall radius at a given height, sampled off the ascending half of
// PROFILE (base to rim, before it turns back down the inside of the bowl).
// Handles attach here instead of a fixed x-offset: a fixed offset floats
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
      color={TROPHY_BODY}
      emissive={PALETTE.amber}
      emissiveIntensity={0.32}
      metalness={0.85}
      roughness={0.35}
    />
  );

  return (
    <group ref={group} position={[0, -0.48, 0]}>
      <mesh geometry={geo}>{gold}</mesh>
      {/* the hologram's wireframe pass: same silhouette, additive amber */}
      <mesh geometry={geo} scale={1.012}>
        <meshBasicMaterial
          color={PALETTE.amber}
          wireframe
          transparent
          opacity={0.14}
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
    <div className="qf-fin-trophy" aria-hidden>
      <Canvas
        // far enough back that the lip and both handles clear the frame
        camera={{ position: [0, 0.18, 2.45], fov: 38 }}
        dpr={[1, 2]}
        gl={{ alpha: true, antialias: true }}
      >
        <ambientLight intensity={0.5} />
        <pointLight position={[1.4, 1.6, 1.8]} intensity={26} color="#ffe6b0" />
        <pointLight position={[-1.6, 0.4, 1.2]} intensity={9} color={PALETTE.green} />
        <TrophyMesh />
      </Canvas>
    </div>
  );
}

// --- the caster's cameo -------------------------------------------------

// Placeholder cheer shown the instant the crown lands: her real sign-off
// call takes a few seconds (the backend LLM call), so this fills the gap
// rather than leaving the cameo silent.
const placeholderLine = (name) => `Winner winner!! All hail ${name}-sama — the island `
  + 'remembers its champion! ☆*:.｡.o(≧▽≦)o.｡.:*☆';

/** The caster cheering the crown, in the stage's bottom band, in the same
 * two forms the live caster takes: standing at the stage's bottom-left with
 * her caption as a desk in front of her when the stage is wide, or a
 * bracketed camera square with the caption beside it, centred under the
 * results card, when it is not (finale.css picks the form).
 * Once her real generated sign-off lands (commentary stamped with the
 * world's final tick), it replaces the placeholder cheer, so she is never
 * just a hardcoded line. */
export function WinnerChan({ name }) {
  const { world, commentary } = useSandbox();
  const signedOff = commentary != null && commentary.tick === world?.tick;
  const text = signedOff ? commentary.text : placeholderLine(name);

  useEffect(() => {
    speakLine(text);
  }, [text]);

  return (
    <div className="qf-fin-chan">
      <div className="qf-frame qf-fin-chan__cam" aria-hidden>
        <img
          className="qf-fin-chan__sprite"
          src={publicUrl('/prompt-chan/happy-3.webp')}
          alt=""
          draggable="false"
        />
      </div>
      <div className="qf-panel qf-panel--dense qf-fin-chan__desk" aria-live="polite">
        <p className="qf-fin-chan__who">
          <span className="qf-fin-chan__name">Prompt-chan</span>
          <span className="qf-fin-chan__role">Caster</span>
        </p>
        <p className="qf-fin-chan__text">{text}</p>
      </div>
    </div>
  );
}

// --- the confetti -----------------------------------------------------

const COUNT = 90;

/** Confetti over the stage, in the house colours and the winner's own. */
export function WinnerConfetti({ color }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined; // preview mode renders no canvas
    const ctx = canvas.getContext('2d');
    // the winner's colour twice, so it reads as theirs among the house colours
    const colors = [PALETTE.green, PALETTE.greenBright, PALETTE.amber, PALETTE.ice];
    if (color) colors.push(color, color);
    let w = 0;
    let h = 0;

    // The stage changes size when a side column folds, without the window
    // resizing, so the canvas follows its own box.
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.offsetWidth;
      h = canvas.offsetHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);

    const spawn = (burst) => ({
      x: Math.random() * w,
      // the opening burst starts mid-air; the standing rain re-enters above
      y: burst ? Math.random() * h * 0.4 : -12,
      vy: 0.9 + Math.random() * 1.4,
      drift: (Math.random() - 0.5) * 0.6,
      sway: Math.random() * Math.PI * 2,
      swaySpeed: 0.02 + Math.random() * 0.04,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.12,
      size: 4 + Math.random() * 4,
      color: colors[(Math.random() * colors.length) | 0],
    });
    const flakes = Array.from({ length: COUNT }, () => spawn(true));

    let raf;
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
        ctx.globalAlpha = 0.8;
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
      ro.disconnect();
    };
  }, [color]);

  if (import.meta.env.DEV && window.__questfiPreview) return window.__questfiPreview.standIn('confetti');
  return <canvas ref={canvasRef} className="qf-fin-confetti" aria-hidden />;
}

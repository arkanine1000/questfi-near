/**
 * Overworld combat beacons — a red pillar fires skyward from a dungeon's
 * mouth hex the instant combat starts inside it, then fades. Purely a
 * spectator cue: the site itself carries no other sign that a fight just
 * broke out below.
 *
 * Self-contained lifecycle: each beacon owns its own rise/fade animation
 * and calls back to remove itself from the parent's list when done — the
 * parent only needs to append on `combat_start` and drop the id on
 * completion, no timers to keep in sync with the animation.
 */

import { useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { COLORS } from '../Scene3D/worldUtils';

const BEAM_HEIGHT = 3.2;
const RISE_FRAC = 0.2; // reaches full height in the first 20% of its life
const FADE_START_FRAC = 0.35; // starts fading at 35%, gone by 100%
const LIFETIME = 1.8; // seconds

function Beacon({ point, onDone }) {
  const groupRef = useRef();
  const matRef = useRef();
  const glowMatRef = useRef();
  const startRef = useRef(null);

  useFrame(({ clock }) => {
    if (startRef.current == null) startRef.current = clock.elapsedTime;
    const t = (clock.elapsedTime - startRef.current) / LIFETIME;
    if (t >= 1) {
      onDone();
      return;
    }
    const group = groupRef.current;
    if (!group) return;
    const rise = Math.min(t / RISE_FRAC, 1);
    const fade = t < FADE_START_FRAC
      ? 1
      : Math.max(0, 1 - (t - FADE_START_FRAC) / (1 - FADE_START_FRAC));
    group.scale.y = Math.max(rise, 0.001);
    if (matRef.current) matRef.current.opacity = fade * 0.85;
    if (glowMatRef.current) glowMatRef.current.opacity = fade * 0.35;
  });

  return (
    <group ref={groupRef} position={[point.x, point.y, point.z]}>
      <mesh position-y={BEAM_HEIGHT / 2}>
        <cylinderGeometry args={[0.03, 0.1, BEAM_HEIGHT, 12, 1, true]} />
        <meshBasicMaterial
          ref={matRef}
          color={COLORS.red}
          transparent
          opacity={0.85}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      {/* wider, softer glow core so the beam doesn't read as a thin wire */}
      <mesh position-y={BEAM_HEIGHT / 2}>
        <cylinderGeometry args={[0.09, 0.26, BEAM_HEIGHT, 12, 1, true]} />
        <meshBasicMaterial
          ref={glowMatRef}
          color={COLORS.red}
          transparent
          opacity={0.35}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

export default function CombatBeacons({ beacons, onBeaconDone }) {
  if (!beacons.length) return null;
  return (
    <>
      {beacons.map((b) => (
        <Beacon key={b.id} point={b.point} onDone={() => onBeaconDone(b.id)} />
      ))}
    </>
  );
}

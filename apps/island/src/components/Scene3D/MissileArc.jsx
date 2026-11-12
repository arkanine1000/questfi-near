import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { axialToWorld, COLORS } from './worldUtils';

const FLIGHT_PERIOD = 2.5; // matches the 2D SVG animateMotion duration
const ARC_HEIGHT = 1.3;

/** WarGames-style red missile arc between the Claude and Gemini guilds. */
export default function MissileArc({ missileArc, reducedMotion }) {
  const warheadRef = useRef();
  const trailRef = useRef();

  const curve = useMemo(() => {
    const s = axialToWorld(missileArc.claudeCentroid.q, missileArc.claudeCentroid.r);
    const e = axialToWorld(missileArc.geminiCentroid.q, missileArc.geminiCentroid.r);
    const start = new THREE.Vector3(s.x, s.y + 0.2, s.z);
    const end = new THREE.Vector3(e.x, e.y + 0.2, e.z);
    const mid = start.clone().add(end).multiplyScalar(0.5);
    mid.y = Math.max(start.y, end.y) + ARC_HEIGHT;
    return new THREE.QuadraticBezierCurve3(start, mid, end);
  }, [missileArc]);

  const points = useMemo(() => curve.getPoints(48), [curve]);

  useFrame(({ clock }) => {
    const warhead = warheadRef.current;
    const trail = trailRef.current;
    if (!warhead) return;
    const t = reducedMotion ? 0.5 : (clock.elapsedTime % FLIGHT_PERIOD) / FLIGHT_PERIOD;
    curve.getPoint(t, warhead.position);
    if (trail) trail.position.copy(warhead.position);
  });

  return (
    <group>
      <Line
        points={points}
        color={COLORS.red}
        transparent
        opacity={0.5}
        dashed
        dashSize={0.16}
        gapSize={0.1}
        lineWidth={1.5}
      />
      <mesh ref={warheadRef}>
        <sphereGeometry args={[0.05, 12, 12]} />
        <meshBasicMaterial color={COLORS.red} toneMapped={false} />
      </mesh>
      <mesh ref={trailRef}>
        <sphereGeometry args={[0.1, 12, 12]} />
        <meshBasicMaterial
          color={COLORS.red}
          transparent
          opacity={0.25}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

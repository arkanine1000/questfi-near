/**
 * Dungeon mouths on the war table — each entrance is a real monument now:
 * a dark descending pit ringed in phosphor, flanked by two standing stones
 * under a lintel. The boss site rises taller in crown-amber with a pulse.
 * Still deliberately sparse — sites announce themselves through the ticker,
 * not through labels (the crown alone is named).
 */

import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { axialToWorld } from '../Scene3D/worldUtils';

const RING_COLOR = '#2dff6e';
const BOSS_COLOR = '#ffaa00';
const PIT_COLOR = '#000d04';

const pillarGeo = new THREE.BoxGeometry(0.055, 0.3, 0.055);
const lintelGeo = new THREE.BoxGeometry(0.34, 0.05, 0.07);
const pitGeo = new THREE.CircleGeometry(0.24, 24);
const ringGeo = new THREE.RingGeometry(0.26, 0.31, 32);

function Mouth({ position, boss, reducedMotion }) {
  const ringRef = useRef();
  const color = boss ? BOSS_COLOR : RING_COLOR;
  const s = boss ? 1.5 : 1;

  const stoneMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: new THREE.Color(color).multiplyScalar(0.55),
    toneMapped: false,
  }), [color]);
  const pitMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: PIT_COLOR,
    toneMapped: false,
  }), []);
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: boss ? 0.9 : 0.45,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  }), [color, boss]);

  useFrame(({ clock }) => {
    if (!ringRef.current || reducedMotion || !boss) return;
    const k = 1 + Math.sin(clock.elapsedTime * 2.2) * 0.08;
    ringRef.current.scale.set(k, k, k);
  });

  return (
    <group position={position} scale={[s, s, s]}>
      {/* the hole in the world */}
      <mesh geometry={pitGeo} material={pitMat} rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.012, 0]} raycast={() => null} />
      <mesh ref={ringRef} geometry={ringGeo} material={ringMat}
        rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} raycast={() => null} />
      {/* standing stones + lintel over the descent */}
      <mesh geometry={pillarGeo} material={stoneMat} position={[-0.14, 0.15, -0.22]} raycast={() => null} />
      <mesh geometry={pillarGeo} material={stoneMat} position={[0.14, 0.15, -0.22]} raycast={() => null} />
      <mesh geometry={lintelGeo} material={stoneMat} position={[0, 0.32, -0.22]} raycast={() => null} />
      {/* mouth-glow rising out of the pit */}
      <pointLight position={[0, 0.18, 0]} color={color}
        intensity={boss ? 2.6 : 1.1} distance={1.6} decay={2} />
    </group>
  );
}

export default function SandboxSiteMarkers({ islandMap, reducedMotion }) {
  const marks = useMemo(() => {
    if (!islandMap) return [];
    const out = [];
    for (const [siteId, site] of Object.entries(islandMap.sites || {})) {
      const seen = new Set();
      for (const hex of Object.values(site.entrances || {})) {
        if (seen.has(hex)) continue;
        seen.add(hex);
        const [q, r] = hex.split(',').map(Number);
        const world = axialToWorld(q, r);
        out.push({
          key: `${siteId}:${hex}`,
          position: [world.x, world.y + 0.02, world.z],
          boss: !!site.is_boss_site,
          name: site.name,
        });
      }
    }
    return out;
  }, [islandMap]);

  const boss = marks.find((m) => m.boss);

  return (
    <group>
      {marks.map((m) => (
        <Mouth
          key={m.key}
          position={m.position}
          boss={m.boss}
          reducedMotion={reducedMotion}
        />
      ))}
      {boss && (
        <Html
          position={[boss.position[0], boss.position[1] + 0.8, boss.position[2]]}
          center
          occlude={false}
          zIndexRange={[80, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div className="sbx-boss-tag">
            <span className="sbx-boss-tag__crown">♛</span> {boss.name}
          </div>
        </Html>
      )}
    </group>
  );
}

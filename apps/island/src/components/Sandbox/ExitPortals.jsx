/**
 * The way out, made unmissable: every entrance room in the followed dungeon
 * carries a slowly-turning phosphor ring under the ceiling with a soft
 * light shaft to the floor — the FPV twin of the overworld mouth monument.
 */

import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { CELL, cellCenter } from '../Scene3D/Crawler/CrawlerMaze';
import { useRoomLight, LIGHT_PRIORITY } from '../Scene3D/Crawler/CrawlerLightPool';
import { COLORS } from '../Scene3D/worldUtils';

const RING_Y = 2.72; // just under the crawler ceiling
const ringGeo = new THREE.TorusGeometry(0.72, 0.045, 10, 40);
const shaftGeo = new THREE.CylinderGeometry(0.55, 0.72, RING_Y, 24, 1, true);

function Portal({ x, z, reducedMotion }) {
  const ringRef = useRef();
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: COLORS.green,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  }), []);
  const shaftMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: COLORS.green,
    transparent: true,
    opacity: 0.05,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  }), []);

  useFrame(({ clock }) => {
    if (!ringRef.current || reducedMotion) return;
    ringRef.current.rotation.z = clock.elapsedTime * 0.4;
    ringMat.opacity = 0.7 + Math.sin(clock.elapsedTime * 1.8) * 0.2;
  });

  useRoomLight({
    x, y: RING_Y - 0.5, z, color: COLORS.green, intensity: 2.2, distance: 5, decay: 2,
    priority: LIGHT_PRIORITY.prop,
  });

  return (
    <group position={[x, 0, z]}>
      <mesh
        ref={ringRef}
        geometry={ringGeo}
        material={ringMat}
        position={[0, RING_Y, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        raycast={() => null}
      />
      <mesh
        geometry={shaftGeo}
        material={shaftMat}
        position={[0, RING_Y / 2, 0]}
        raycast={() => null}
      />
    </group>
  );
}

export default function ExitPortals({ model, reducedMotion }) {
  const portals = useMemo(
    () => model.rooms
      .filter((r) => r.isEntrance)
      .map((r) => ({ id: r.id, ...cellCenter(r.gridX, r.gridY, model) })),
    [model],
  );
  return (
    <group>
      {portals.map((p) => (
        <Portal key={p.id} x={p.x} z={p.z} reducedMotion={reducedMotion} />
      ))}
    </group>
  );
}

import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useLoader } from '@react-three/fiber';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { cellCenter } from './CrawlerMaze';
import { getGlowDiscTexture } from './crawlerTextures';
import { CHEST_MODEL_URL, CHEST_TEXTURE_URL } from './crawlerAssets';
import { useRoomLight, LIGHT_PRIORITY } from './CrawlerLightPool';

// Room dressing: the textured chest model for treasure rooms, trap warning
// rings, NPC beacon markers, and additive glow-mote particles (a custom
// points effect — drei Sparkles ships NormalBlending internally, which
// renders visible point-quad squares against a dark scene).
//
// None of these mount their own light. They used to, one <pointLight> each,
// for every room in the model with no culling — which meant a large dungeon
// carried dozens of lights and the count changed on every model update,
// recompiling every material in the scene each time. They now declare a
// request against CrawlerLightPool's fixed slots instead. See that file for
// why the count has to stay constant.

const CHEST_TARGET_SIZE = 0.95; // longest dimension, world units

/**
 * Additive rising glow motes. Each point loops up through the column with
 * its own phase; the disc texture + additive blending keeps them soft.
 */
function GlowMotes({ position, count = 8, color = '#ffaa00', size = 0.15, area = [1.0, 1.1, 0.8], speed = 0.25 }) {
  const pointsRef = useRef();
  const { positions, phases } = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const ph = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      pos[i * 3] = (Math.random() - 0.5) * area[0];
      pos[i * 3 + 1] = Math.random() * area[1];
      pos[i * 3 + 2] = (Math.random() - 0.5) * area[2];
      ph[i] = Math.random();
    }
    return { positions: pos, phases: ph };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  const mat = useMemo(() => new THREE.PointsMaterial({
    map: getGlowDiscTexture(color),
    size,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  }), [color, size]);

  useFrame(({ clock }) => {
    const pts = pointsRef.current;
    if (!pts) return;
    const t = clock.elapsedTime;
    const arr = pts.geometry.attributes.position.array;
    for (let i = 0; i < count; i += 1) {
      arr[i * 3 + 1] = ((phases[i] + t * speed) % 1) * area[1];
    }
    pts.geometry.attributes.position.needsUpdate = true;
  });

  return (
    <points ref={pointsRef} position={position} material={mat}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
    </points>
  );
}

/** The questfi-lobby chest model, green-graded into the phosphor language. */
function ChestModel({ x, z }) {
  const obj = useLoader(OBJLoader, CHEST_MODEL_URL);
  const chestTex = useLoader(THREE.TextureLoader, CHEST_TEXTURE_URL);

  const template = useMemo(() => {
    chestTex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({
      map: chestTex,
      color: '#58d98c',
      emissive: '#0d5a2b',
      emissiveMap: chestTex,
      emissiveIntensity: 0.25,
      roughness: 0.8,
      metalness: 0.1,
    });
    const root = obj.clone(true);
    root.traverse((child) => {
      if (child.isMesh) child.material = mat;
    });
    // The OBJ is Z-up (it rendered tipped onto its back, lid skyward);
    // stand it up BEFORE the bbox so scale + floor grounding stay true.
    // The π about its own up-axis (z, applied first in XYZ order) turns
    // the front of the chest toward the viewer.
    root.rotation.set(-Math.PI / 2, 0, Math.PI);
    const box = new THREE.Box3().setFromObject(root);
    const dims = new THREE.Vector3();
    box.getSize(dims);
    const scale = CHEST_TARGET_SIZE / Math.max(dims.x, dims.y, dims.z);
    return { root, scale, yOffset: -box.min.y * scale };
  }, [obj, chestTex]);

  const instance = useMemo(() => template.root.clone(true), [template]);

  // warm hoard-light so the chest reads from across the room
  useRoomLight({
    x: x + 0.9,
    y: 0.8,
    z: z + 0.7,
    color: '#ffaa00',
    intensity: 2.4,
    distance: 4.5,
    decay: 2,
    priority: LIGHT_PRIORITY.prop,
  });

  return (
    <group position={[x + 0.9, template.yOffset, z + 0.7]} rotation-y={0.6}>
      <primitive object={instance} scale={template.scale} />
      <GlowMotes position={[0, 0.35, 0]} />
    </group>
  );
}

const trapRingGeo = (() => {
  const g = new THREE.TorusGeometry(1.15, 0.05, 8, 40);
  g.rotateX(-Math.PI / 2);
  return g;
})();

/** Trap warning ring — flat torus that flares when the trap fires. */
function TrapRing({ x, z, isPlayerRoom, queue, reducedMotion }) {
  const matRef = useRef();
  useRoomLight({
    x, y: 0.4, z, color: '#ff2038', intensity: 0.6, distance: 3, decay: 2,
    priority: LIGHT_PRIORITY.prop,
  });
  useFrame(({ clock }) => {
    const mat = matRef.current;
    if (!mat) return;
    const t = clock.elapsedTime;
    const beat = queue.current;
    const firing = beat?.kind === 'trap' && isPlayerRoom && !reducedMotion;
    if (firing) {
      // brighten hard while the trap beat plays
      mat.opacity = 0.9;
      mat.color.setHex(0xff2038);
    } else {
      // calm baseline — up close at fov 90 a hot ring dominates the frame
      mat.opacity = reducedMotion ? 0.35 : 0.26 + 0.1 * Math.sin(t * 2.4);
      mat.color.setHex(0xff0040);
    }
  });
  return (
    <group position={[x, 0, z]}>
      <mesh geometry={trapRingGeo} position={[0, 0.03, 0]}>
        <meshBasicMaterial
          ref={matRef}
          color="#ff0040"
          transparent
          opacity={0.45}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

const npcDiscGeo = new THREE.PlaneGeometry(1.1, 1.1);

/** NPC beacon: a soft cyan glow disc on the floor with a gentle pulse. */
function NpcMarker({ x, z }) {
  const meshRef = useRef();
  useRoomLight({
    x, y: 1.0, z, color: '#00bfff', intensity: 1.2, distance: 3.5, decay: 2,
    priority: LIGHT_PRIORITY.prop,
  });
  const mat = useMemo(() => new THREE.MeshBasicMaterial({
    map: getGlowDiscTexture('#7fdfff'),
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  }), []);
  useFrame(({ clock }) => {
    const m = meshRef.current;
    if (!m) return;
    const k = 1 + Math.sin(clock.elapsedTime * 1.6) * 0.12;
    m.scale.set(k, k, 1);
    mat.opacity = 0.4 + 0.15 * Math.sin(clock.elapsedTime * 1.6);
  });
  return (
    <group position={[x, 0, z]}>
      <mesh ref={meshRef} geometry={npcDiscGeo} material={mat} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} />
      <GlowMotes position={[0, 0.1, 0]} count={5} color="#7fdfff" size={0.12} area={[0.6, 1.4, 0.6]} speed={0.18} />
    </group>
  );
}

/**
 * Room-type + entity props for every room, plus the loot-beat burst in the
 * player's room. Pure render from the adapter model.
 */
export default function CrawlerProps({ model, queue, activeBeat, reducedMotion }) {
  const items = useMemo(() => {
    const out = [];
    for (const room of model.rooms) {
      const { x, z } = cellCenter(room.gridX, room.gridY, model);
      const npc = room.entities.find((e) => e.type === 'npc');

      if (room.type === 'trap_room') {
        out.push({ kind: 'trap', key: `${room.id}-trap`, x, z, roomId: room.id });
      }
      if (room.type === 'treasure_room' && room.hasItems) {
        out.push({ kind: 'chest', key: `${room.id}-chest`, x, z });
      }
      if (npc) out.push({ kind: 'npc', key: `${room.id}-npc`, x: x - 1.2, z: z - 0.9 });
    }
    return out;
  }, [model]);

  const playerRoom = model.rooms.find((r) => r.id === model.playerRoomId) ?? null;
  const lootBurst = activeBeat?.kind === 'loot' && playerRoom
    ? cellCenter(playerRoom.gridX, playerRoom.gridY, model)
    : null;

  return (
    <group>
      {items.map((item) => {
        switch (item.kind) {
          case 'trap':
            return (
              <TrapRing
                key={item.key}
                x={item.x}
                z={item.z}
                isPlayerRoom={item.roomId === model.playerRoomId}
                queue={queue}
                reducedMotion={reducedMotion}
              />
            );
          case 'chest':
            return <ChestModel key={item.key} x={item.x} z={item.z} />;
          case 'npc':
            return <NpcMarker key={item.key} x={item.x} z={item.z} />;
          default:
            return null;
        }
      })}

      {/* Loot beat — mote fountain where the player stands (small sizes:
          point sprites right next to the camera blow up into streaks) */}
      {lootBurst && (
        <GlowMotes
          position={[lootBurst.x, 0.2, lootBurst.z]}
          count={26}
          color="#ffd75e"
          size={0.11}
          area={[2.0, 2.2, 2.0]}
          speed={1.0}
        />
      )}
    </group>
  );
}

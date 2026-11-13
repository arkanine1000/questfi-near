import { useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Instances, Instance } from '@react-three/drei';
import { roomToWorld } from '../dungeonAdapter';
import { COLORS } from '../worldUtils';
import { look } from '../look';
import {
  getCrawlerTexture, getWallTilesTexture, getWallTilesNormalTexture, getGlowDiscTexture,
} from './crawlerTextures';

// 1 room = 1 cell — the whole room is a walkable box the camera stands in
export const CELL = 4;
export const WALL_H = 3;
export const EYE = 1.7;

const MAX_CELLS = 64; // QuestSetupModal allows up to 8x8
const MAX_WALLS = MAX_CELLS * 4;
export const WALL_INSET = 0.02; // back-to-back walls of adjacent rooms never z-fight

export const DIRS = {
  N: { dr: -1, dc: 0, rotY: 0 }, // plane normal +Z faces into the room
  S: { dr: 1, dc: 0, rotY: Math.PI },
  E: { dr: 0, dc: 1, rotY: -Math.PI / 2 },
  W: { dr: 0, dc: -1, rotY: Math.PI / 2 },
};

/** World-space center of a room cell (minimap pitch x CELL). */
export function cellCenter(gridX, gridY, model) {
  const w = roomToWorld(gridX, gridY, model.gridCols, model.gridRows);
  return { x: w.x * CELL, z: w.z * CELL };
}

/** Parse a "row,col" room id into grid coordinates. */
export function idToGrid(id) {
  const [row, col] = String(id).split(',').map(Number);
  return { row, col };
}

export const WALL_T = 0.24; // real wall thickness — no paper-thin seams
// Overlong so corner joints seal — but by a hair LESS than the thickness,
// otherwise an end cap lands exactly on the perpendicular wall's face
// plane and the L-corners z-fight. Slightly overtall for the same reason:
// tops/bottoms punch through the ceiling/floor planes instead of lying
// coplanar with them.
const wallGeo = new THREE.BoxGeometry(CELL + WALL_T - 0.05, WALL_H + 0.04, WALL_T);
const sealGeo = new THREE.PlaneGeometry(CELL, WALL_H);
const tileGeo = new THREE.PlaneGeometry(CELL, CELL);
const tintGeo = new THREE.PlaneGeometry(CELL * 0.94, CELL * 0.94);

// Floor glow wash per special room type — the walk-in "what is this room"
// cue (danger red, loot amber, the boss a stronger red, entrance bright
// green)
const TINT_COLORS = {
  trap_room: COLORS.red,
  treasure_room: COLORS.amber,
  boss_room: COLORS.red,
  entrance: COLORS.bright,
};
const TINT_STRENGTH = {
  trap_room: 1,
  treasure_room: 1,
  boss_room: 1.6,
  entrance: 1,
};

// Black first, lit by torches: the stone barely glows on its own, so away
// from a light it falls to near black and near one it shows its relief.
// Base tints are the house bright green scaled down; the look values scales
// them again live (`dungeonWallTint`, `dungeonWallEmissive`).
const WALL_BASE = new THREE.Color(COLORS.bright).multiplyScalar(0.45);
const CEIL_BASE = new THREE.Color(COLORS.bright).multiplyScalar(0.18);
const CEIL_EMISSIVE_SHARE = 0.5; // the ceiling glows half as much as the walls
const FLOOR_LINE_INTENSITY = 0.35; // the floor grid's emissive at gain 1

// Edge lines where a wall meets the floor and the ceiling, drawn in the wall
// shader from the fragment's world height: EDGE_W thick, never thinner than
// about a pixel, house green, fogged with distance like the stone.
const EDGE_W = 0.035;

function injectWallEdges(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vEdgeY;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          // world height, computed here rather than through a worldpos chunk
          // that may be compiled out: instance transform, then the mesh's own
          vec4 edgeWorld = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            edgeWorld = instanceMatrix * edgeWorld;
          #endif
          edgeWorld = modelMatrix * edgeWorld;
          vEdgeY = edgeWorld.y;
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vEdgeY;
        uniform vec3 uEdgeColor;
        uniform float uEdgeGain;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float edgeAa = max(fwidth(vEdgeY), 1e-4);
          float edgeW = max(${EDGE_W.toFixed(4)}, 1.2 * edgeAa);
          float foot = 1.0 - smoothstep(edgeW - 0.5 * edgeAa, edgeW + 0.5 * edgeAa, vEdgeY);
          float top = smoothstep(
            ${WALL_H.toFixed(4)} - edgeW - 0.5 * edgeAa,
            ${WALL_H.toFixed(4)} - edgeW + 0.5 * edgeAa,
            vEdgeY
          );
          totalEmissiveRadiance += uEdgeColor * max(foot, top) * uEdgeGain;
        }`,
      );
  };
  // onBeforeCompile changes require a distinct program cache entry
  material.customProgramCacheKey = () => 'crawler-wall-edges';
}

/**
 * Dungeon shell from the shared adapter model: explored rooms only (fog of
 * war by construction), solid phosphor-grid walls where no connection
 * exists, open portals to explored neighbors, near-black pulsing "unknown"
 * planes toward unexplored connections, and translucent red planes sealing
 * fog-walled rooms. Optimistic destination cells arrive pre-merged into
 * model.rooms by SandboxCrawler.
 */
export default function CrawlerMaze({ model, reducedMotion }) {
  // Floor keeps the procedural phosphor grid (the aesthetic signature);
  // walls and ceilings wear the brick tiles
  const floorTex = useMemo(() => getCrawlerTexture('floor'), []);
  const wallTex = useMemo(() => getWallTilesTexture('wall'), []);
  const ceilTex = useMemo(() => getWallTilesTexture('ceiling'), []);
  const wallNormalTex = useMemo(() => getWallTilesNormalTexture('wall'), []);
  const ceilNormalTex = useMemo(() => getWallTilesNormalTexture('ceiling'), []);

  // Floor, ceiling and wall materials; their brightness follows the look
  // store every frame
  const floorMat = useMemo(() => new THREE.MeshStandardMaterial({
    map: floorTex,
    emissive: COLORS.green,
    emissiveMap: floorTex,
    emissiveIntensity: FLOOR_LINE_INTENSITY * look.dungeonFloorLines,
    color: COLORS.deep,
    roughness: 0.85,
    metalness: 0,
  }), [floorTex]);
  const ceilMat = useMemo(() => new THREE.MeshStandardMaterial({
    map: ceilTex,
    normalMap: ceilNormalTex,
    normalScale: new THREE.Vector2(2.2, 2.2),
    emissive: COLORS.green,
    emissiveMap: ceilTex,
    emissiveIntensity: look.dungeonWallEmissive * CEIL_EMISSIVE_SHARE,
    color: CEIL_BASE.clone().multiplyScalar(look.dungeonWallTint),
    roughness: 0.7,
    metalness: 0,
  }), [ceilTex, ceilNormalTex]);
  const edgeUniforms = useMemo(() => ({
    uEdgeColor: { value: new THREE.Color(COLORS.green) },
    uEdgeGain: { value: look.dungeonEdgeLines },
  }), []);
  const wallMat = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      map: wallTex,
      normalMap: wallNormalTex,
      normalScale: new THREE.Vector2(2.2, 2.2),
      emissive: COLORS.green,
      emissiveMap: wallTex,
      emissiveIntensity: look.dungeonWallEmissive,
      color: WALL_BASE.clone().multiplyScalar(look.dungeonWallTint),
      roughness: 0.55,
      metalness: 0,
    });
    injectWallEdges(mat, edgeUniforms);
    return mat;
  }, [wallTex, wallNormalTex, edgeUniforms]);

  // Shared materials mutated in useFrame — every fog seal / tint pulses
  // in unison
  const fogMat = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: COLORS.red,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
    [],
  );
  const tintMats = useMemo(() => {
    const map = new Map();
    for (const [type, color] of Object.entries(TINT_COLORS)) {
      const mat = new THREE.MeshBasicMaterial({
        map: getGlowDiscTexture(color),
        transparent: true,
        opacity: 0.22 * TINT_STRENGTH[type],
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      mat.userData.strength = TINT_STRENGTH[type];
      map.set(type, mat);
    }
    return map;
  }, []);
  // array copy for the frame loop: iterating the Map allocates an iterator
  const tintList = useMemo(() => [...tintMats.values()], [tintMats]);

  const layout = useMemo(() => {
    const rooms = model.rooms.slice(0, MAX_CELLS);
    const byId = new Map(rooms.map((r) => [r.id, r]));
    const tiles = [];
    const wallEdges = new Map(); // canonical boundary -> one thick wall
    const fogWalls = [];
    const tints = [];

    for (const room of rooms) {
      const { x, z } = cellCenter(room.gridX, room.gridY, model);
      tiles.push({ key: room.id, x, z });
      if (TINT_COLORS[room.type]) {
        tints.push({ key: `${room.id}-tint`, x, z, type: room.type });
      }

      for (const [dir, spec] of Object.entries(DIRS)) {
        const neighborId = `${room.gridY + spec.dr},${room.gridX + spec.dc}`;
        const neighbor = byId.get(neighborId);
        if (!room.connections?.[dir] || !neighbor) {
          // no door — or a door into a room the model doesn't know
          // (shouldn't happen with the omniscient map; wall it off rather
          // than leave a hole). One shared box per boundary, both sides.
          const key = room.id < neighborId
            ? `${room.id}|${neighborId}`
            : `${neighborId}|${room.id}`;
          if (!wallEdges.has(key)) {
            // The boxes are overlong so corners seal, which leaves two
            // COLLINEAR segments overlapping past a junction vertex with
            // side faces on the exact same plane — a guaranteed z-fight
            // strip at every L/T junction (invisible on the old matte
            // walls, shimmering under the specular sheen). Nudge each wall
            // a hair along its own normal, cycling offset by grid step so
            // collinear neighbors (always one CELL apart) never share a
            // plane. ±8mm on a 0.24-thick wall doesn't read.
            const wx = x + spec.dc * (CELL / 2);
            const wz = z + spec.dr * (CELL / 2);
            const alongX = spec.dc === 0; // N/S boundary: box runs along X
            const step = Math.round((alongX ? wx : wz) / CELL);
            const jitter = ((((step % 3) + 3) % 3) - 1) * 0.008;
            wallEdges.set(key, {
              key,
              x: wx + (alongX ? 0 : jitter),
              z: wz + (alongX ? jitter : 0),
              rotY: alongX ? 0 : Math.PI / 2,
            });
          }
        } else if (neighbor.fogWall && !room.fogWall) {
          // portal into the fog-walled objective room — sealed in red
          fogWalls.push({
            key: `${room.id}-${dir}`,
            x: x + spec.dc * (CELL / 2 - WALL_INSET),
            z: z + spec.dr * (CELL / 2 - WALL_INSET),
            rotY: spec.rotY,
          });
        }
        // else: open portal
      }
    }
    return { tiles, walls: [...wallEdges.values()], fogWalls, tints };
  }, [model]);

  // Faint life in the fog-seal/tint planes — the only animated materials —
  // and the surface brightness from the look values
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    fogMat.opacity = reducedMotion ? 0.3 : 0.24 + 0.1 * Math.sin(t * 2.1);
    for (let i = 0; i < tintList.length; i += 1) {
      const mat = tintList[i];
      const base = reducedMotion ? 0.22 : 0.19 + 0.07 * Math.sin(t * 1.7 + i + 1);
      mat.opacity = base * mat.userData.strength;
    }
    wallMat.color.copy(WALL_BASE).multiplyScalar(look.dungeonWallTint);
    wallMat.emissiveIntensity = look.dungeonWallEmissive;
    ceilMat.color.copy(CEIL_BASE).multiplyScalar(look.dungeonWallTint);
    ceilMat.emissiveIntensity = look.dungeonWallEmissive * CEIL_EMISSIVE_SHARE;
    floorMat.emissiveIntensity = FLOOR_LINE_INTENSITY * look.dungeonFloorLines;
    edgeUniforms.uEdgeGain.value = look.dungeonEdgeLines;
  });

  return (
    <group>
      {/* Floors — near-black tiles, the phosphor grid in house green */}
      <Instances limit={MAX_CELLS} geometry={tileGeo} material={floorMat} frustumCulled={false}>
        {layout.tiles.map((tile) => (
          <Instance key={tile.key} position={[tile.x, 0, tile.z]} rotation={[-Math.PI / 2, 0, 0]} />
        ))}
      </Instances>

      {/* Ceilings — brick, darker than the walls, so the space reads tall
          and dark */}
      <Instances limit={MAX_CELLS} geometry={tileGeo} material={ceilMat} frustumCulled={false}>
        {layout.tiles.map((tile) => (
          <Instance key={tile.key} position={[tile.x, WALL_H, tile.z]} rotation={[Math.PI / 2, 0, 0]} />
        ))}
      </Instances>

      {/* Solid walls — brick masonry, near black until a torch finds it,
          with bright edge lines at the foot and the top. The agent's light
          rides AT the camera, so diffuse N·L barely varies with surface
          detail (L≈V ⇒ N·L≈1 head-on) — the relief has to read through the
          specular sheen instead. That needs real roughness headroom (0.9
          left no lobe at all) and an overdriven normalScale. */}
      <Instances limit={MAX_WALLS} geometry={wallGeo} material={wallMat} frustumCulled={false}>
        {layout.walls.map((wall) => (
          <Instance key={wall.key} position={[wall.x, WALL_H / 2, wall.z]} rotation={[0, wall.rotY, 0]} />
        ))}
      </Instances>

      {/* Room-type floor washes — walk-in danger/loot cues */}
      {layout.tints.map((tint) => (
        <mesh
          key={tint.key}
          geometry={tintGeo}
          material={tintMats.get(tint.type)}
          position={[tint.x, 0.015, tint.z]}
          rotation={[-Math.PI / 2, 0, 0]}
        />
      ))}

      {/* Fog wall portals — translucent red seal on the objective room */}
      {layout.fogWalls.map((face) => (
        <mesh
          key={face.key}
          geometry={wallGeo}
          material={fogMat}
          position={[face.x, WALL_H / 2, face.z]}
          rotation={[0, face.rotY, 0]}
        />
      ))}
    </group>
  );
}

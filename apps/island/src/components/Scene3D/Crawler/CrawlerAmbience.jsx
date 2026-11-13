import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useLoader } from '@react-three/fiber';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { Instances, Instance } from '@react-three/drei';
import {
  CELL, WALL_H, WALL_T, DIRS, cellCenter,
} from './CrawlerMaze';
import FacingBillboard from './FacingBillboard';
import { getSpriteSheetTexture, cloneFrameTexture, setFrame, pingPongFrame } from './spriteSheet';
import {
  FLAME_SHEET, TORCH_MODEL_URL, TORCH_TEXTURE_URLS, COBWEB_TEXTURE_URL,
} from './crawlerAssets';
import { useRoomLight, LIGHT_PRIORITY } from './CrawlerLightPool';
import { COLORS } from '../worldUtils';
import { look } from '../look';

// Cosmetic set dressing: wall torches with an animated billboarded flame,
// and cobwebs in wall corners. Nothing here reads or affects game state —
// placement is a pure function of the room id, so a room's dressing is
// identical every time it's rendered.

const FLAME_FPS = 10;
// Pooled torch light at look gain 1; brighter than before because the stone
// no longer glows on its own, so the torches are what reveal it
const TORCH_LIGHT = 9;
const FLAME_SIZE = 0.62;
const TORCH_HEIGHT = 1.05; // bracket only, world units — reads at 4m room scale
// Mount point. The head lands at 2.40 — above EYE (1.7) so the flame reads
// overhead rather than in-face — and keeps the flame quad's top under the
// 3.0 ceiling, which it punches through at anything much higher.
const TORCH_Y = 1.35;

// How far the flame must stand off the wall face.
//
// The flame is a billboard: FacingBillboard yaws it to face the camera, so
// when you look ALONG a wall the quad turns perpendicular to it and half its
// width swings toward the masonry. The material is depthWrite:false but
// still depth-TESTED, so whatever ends up behind the wall is culled — the
// flame reads fine head-on and vanishes side-on.
//
// Half the quad's width (0.31) is the hard geometric minimum that survives
// any yaw; the remainder is margin so the sprite's glow doesn't graze the
// brick. Tuned in-engine — don't drop the margin to zero or the flame will
// clip the wall again at grazing angles.
const FLAME_STANDOFF = FLAME_SIZE * 0.5 + 0.04;

// Corner placement always pins the quad flush to the wall's edges, so its
// size is purely how far into the wall the web reaches — capped by WALL_H
// (3.0), past which the corner offset inverts and it would overhang.
const COBWEB_SIZE = 2.25; // ~56% of the 4-wide face, 75% of the 3-tall one
const COBWEB_OPACITY = 0.35;

const TORCH_CHANCE = 0.5;
// Torches only ever claim E/W walls, so a room's N/S walls are always free
// for webbing — at 0.5 a typical room webs about one and a half of its
// solid walls, which reads as neglected rather than infested.
const COBWEB_CHANCE = 0.5;

// Webs strung across a passage, which the crawler walks through.
//
// Only ever hung on tiles with a single unambiguous through-axis: a straight
// corridor (two opposite exits) or a dead end (one exit). That restriction
// is what makes them look deliberate rather than scattered.
//
// Two properties fall out of it, and both matter:
//  - The tile's side walls are solid BY DEFINITION, so every corner of the
//    quad is backed by real geometry for the corner art to hang from. At a
//    '+' junction there is no such corner, which is exactly where a
//    centre-of-tile web read as floating at random.
//  - The player can only approach along the through-axis, so a quad
//    perpendicular to it always faces them square-on. No billboarding —
//    which is just as well, since a billboard's corners don't map to any
//    fixed world direction and corner-anchored art can't survive that.
//
// Skipped on the tile the player occupies, so arriving reads as having
// broken through the web — and no quad ever reaches the near plane.
const TILE_WEB_CHANCE = 0.55;
const TILE_WEB_SIZE = 2.8; // spans y 0.1..2.9 of the 3.0-tall passage
const TILE_WEB_OPACITY = 0.28; // lighter than the wall webs — you look through these

/**
 * Deterministic 0..1 from an arbitrary key — the string-keyed sibling of
 * TerrainProps' hash01. Room ids are "row,col", so placement has to hash a
 * string rather than an instance index.
 */
function hashKey(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const v = Math.sin((h >>> 0) * 0.0001) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * Which of a room's four sides are solid wall. Mirrors CrawlerMaze's rule
 * exactly — no connection, or a connection to a room the model doesn't know,
 * both get walled off — so a torch can never end up floating in a doorway.
 */
function solidWalls(room, byId) {
  const out = [];
  for (const [dir, spec] of Object.entries(DIRS)) {
    const neighborId = `${room.gridY + spec.dr},${room.gridX + spec.dc}`;
    if (!room.connections?.[dir] || !byId.has(neighborId)) out.push(dir);
  }
  return out;
}

/**
 * The single axis a tile can be walked through, or null if it has none.
 *
 * 'NS' / 'EW' for a straight corridor or a dead end along that axis. A
 * junction, an L-bend or an isolated room returns null: there is no one
 * approach direction to orient against, and no guaranteed pair of flanking
 * walls for corner art to hang from.
 */
function throughAxis(room, byId) {
  const open = [];
  for (const [dir, spec] of Object.entries(DIRS)) {
    const neighborId = `${room.gridY + spec.dr},${room.gridX + spec.dc}`;
    if (room.connections?.[dir] && byId.has(neighborId)) open.push(dir);
  }
  if (open.length === 1) return open[0] === 'N' || open[0] === 'S' ? 'NS' : 'EW';
  if (open.length === 2) {
    if (open.includes('N') && open.includes('S')) return 'NS';
    if (open.includes('E') && open.includes('W')) return 'EW';
  }
  return null; // junction, L-bend, or no exits
}

/**
 * Wall-face frame: centre of the visible face, and the rotation that faces
 * it inward.
 *
 * CrawlerMaze centres each wall slab ON the room boundary, so the surface
 * you can actually see is half a thickness INSIDE it — at CELL/2 - WALL_T/2,
 * not at CELL/2. Mounting at the boundary buries the prop in the masonry:
 * a flat cobweb disappears completely, and a torch shows only the tip that
 * happens to poke out. The extra 12mm keeps the face clear of z-fighting.
 */
function wallFrame(room, dir, model) {
  const { x, z } = cellCenter(room.gridX, room.gridY, model);
  const spec = DIRS[dir];
  const inset = CELL / 2 - WALL_T / 2 - 0.012;
  return {
    x: x + spec.dc * inset,
    z: z + spec.dr * inset,
    rotY: spec.rotY,
  };
}

/**
 * One wall torch: the bracket model, an additive flame billboard playing the
 * sheet on its own phase, and a pooled light request.
 */
function Torch({ placement, template, reducedMotion }) {
  const {
    x, z, rotY, key,
  } = placement;

  // Own playback head on the shared sheet — clones share the GPU upload but
  // animate independently, so adjacent torches never flicker in lockstep.
  const flameTex = useMemo(() => cloneFrameTexture(template.flameSheet), [template]);
  const flameMat = useMemo(() => new THREE.MeshBasicMaterial({
    map: flameTex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false, // let it blow out into the Bloom pass
  }), [flameTex]);

  const phase = useMemo(() => hashKey(`${key}:phase`) * 10, [key]);
  const frameRef = useRef(-1);

  useFrame(({ clock }) => {
    // the pool reads the live spec every frame
    torchLight.intensity = TORCH_LIGHT * look.dungeonTorch;
    const frame = reducedMotion
      ? 1 // hold the mid frame — a lit torch, just not a moving one
      : pingPongFrame(clock.elapsedTime + phase, FLAME_SHEET.columns, FLAME_FPS);
    if (frame === frameRef.current) return; // only touch uniforms on a change
    frameRef.current = frame;
    setFrame(flameTex, frame);
  });

  const bracket = useMemo(() => template.bracket.clone(true), [template]);

  // The flame is placed in WORLD space, as a sibling of the torch rather
  // than a child of it.
  //
  // FacingBillboard sets rotation.y directly, which is a LOCAL rotation. Sat
  // inside the torch group — already yawed by rotY to stand off its wall —
  // the flame's world yaw came out as rotY + cameraYaw, so it never actually
  // faced the spectator: a 90-degree error on every east/west wall, which
  // presents the quad edge-on and makes it disappear. Hoisting it out of the
  // rotated parent makes the billboard yaw absolute again.
  const flameWorld = useMemo(() => {
    const [ax, ay, az] = template.flameAnchor;
    const s = Math.sin(rotY);
    const c = Math.cos(rotY);
    return [x + ax * c + az * s, TORCH_Y + ay, z - ax * s + az * c];
  }, [template, rotY, x, z]);

  const torchLight = useRoomLight({
    x: flameWorld[0],
    y: flameWorld[1] + FLAME_SIZE * 0.4, // sit the light in the flame itself
    z: flameWorld[2],
    color: COLORS.bright,
    intensity: TORCH_LIGHT,
    distance: CELL * 2.4,
    decay: 2,
    priority: LIGHT_PRIORITY.ambience,
    flicker: 1.8,
  });

  return (
    <>
      <group position={[x, TORCH_Y, z]} rotation={[0, rotY, 0]}>
        <primitive object={bracket} />
      </group>
      {/* The sprite's content is bottom-anchored within its frame, so the
          quad is raised half its height to burn UP from the anchor rather
          than straddle it. */}
      <FacingBillboard position={flameWorld}>
        <mesh material={flameMat} position={[0, FLAME_SIZE / 2, 0]}>
          <planeGeometry args={[FLAME_SIZE, FLAME_SIZE]} />
        </mesh>
      </FacingBillboard>
    </>
  );
}

export default function CrawlerAmbience({ model, reducedMotion }) {
  const fbx = useLoader(FBXLoader, TORCH_MODEL_URL);
  const [baseColor, normal, orm] = useLoader(THREE.TextureLoader, TORCH_TEXTURE_URLS);
  // Re-derived from the 1024 source PNG rather than the authored webp: that
  // webp zeroed the RGB of its transparent pixels, which bleeds black into
  // the strands under bilinear filtering. See scripts/buildSpriteSheet.mjs
  // for the webp:exact rationale.
  const cobwebTex = useLoader(THREE.TextureLoader, COBWEB_TEXTURE_URL);

  const template = useMemo(() => {
    baseColor.colorSpace = THREE.SRGBColorSpace;
    // Green-graded into the phosphor palette, but pushed much harder than
    // the chest in CrawlerProps — for two reasons.
    //
    // 1. The authored basecolor is very dark: mean green 53/255, peaking at
    //    142, never reaching white. Multiplied by a <=1 tint it turns to mud
    //    against the brick. `color` is a plain shader multiplier and is NOT
    //    clamped to 1, so values above it scale the map back up while
    //    keeping every bit of its detail — cheaper and lossless next to a
    //    canvas pass over the texture.
    // 2. Only 6 torches can hold a pooled light at once (CrawlerLightPool),
    //    so MOST torches in a dungeon are unlit and would otherwise be
    //    visible only when your own rig torch happens to rake across them.
    //    The emissive term is what makes them read down a corridor, so it
    //    carries the object rather than merely tinting it.
    //
    // aoMap is deliberately absent: it only ever subtracts light from a prop
    // we are trying to brighten, and it samples the second UV set, which
    // this FBX is not guaranteed to carry.
    const mat = new THREE.MeshStandardMaterial({
      map: baseColor,
      normalMap: normal,
      roughnessMap: orm, // ORM: roughness in G, metalness in B
      metalnessMap: orm,
      color: new THREE.Color(1.75, 2.45, 2.0),
      emissive: COLORS.fill,
      emissiveMap: baseColor,
      emissiveIntensity: 1.15,
      roughness: 0.62, // some specular headroom so the relief catches light
      metalness: 0.12,
    });

    const root = fbx.clone(true);
    root.traverse((child) => {
      if (child.isMesh) child.material = mat;
    });

    // Normalize orientation the same way CrawlerWeapon does: stand the
    // dominant axis up as +Y, then scale to a known height. Authored FBX
    // orientation varies by DCC tool and can't be assumed.
    const wrapper = new THREE.Group();
    wrapper.add(root);
    const dims = new THREE.Vector3();
    new THREE.Box3().setFromObject(root).getSize(dims);
    if (dims.x >= dims.y && dims.x >= dims.z) root.rotation.set(0, 0, Math.PI / 2);
    else if (dims.z >= dims.y && dims.z >= dims.x) root.rotation.set(-Math.PI / 2, 0, 0);

    const box = new THREE.Box3().setFromObject(wrapper);
    box.getSize(dims);
    wrapper.scale.setScalar(TORCH_HEIGHT / Math.max(dims.y, 0.0001));

    // Sit the bracket's back against the wall face and its base at the
    // mount point, so the model protrudes into the room.
    const scaled = new THREE.Box3().setFromObject(wrapper);
    wrapper.position.set(
      -(scaled.min.x + scaled.max.x) / 2,
      -scaled.min.y,
      -scaled.min.z,
    );

    const holder = new THREE.Group();
    holder.add(wrapper);

    // Anchor the flame on the model's MEASURED head rather than a guessed
    // fraction of its height: the normalization above can flip the dominant
    // axis, so where the bowl ends is only known after the fact. Sinking it
    // a little into the head keeps the sprite's soft base from floating.
    // The group sits ON the wall face with local +Z pointing into the room,
    // so z is literally distance from the wall. The model's own mid-depth is
    // not enough clearance for a billboard, hence the FLAME_STANDOFF floor.
    const final = new THREE.Box3().setFromObject(holder);
    const flameAnchor = [
      (final.min.x + final.max.x) / 2,
      final.max.y - FLAME_SIZE * 0.18,
      Math.max((final.min.z + final.max.z) / 2, FLAME_STANDOFF),
    ];

    return {
      bracket: holder,
      flameAnchor,
      flameSheet: getSpriteSheetTexture(FLAME_SHEET.url, FLAME_SHEET),
    };
  }, [fbx, baseColor, normal, orm]);

  const cobwebMat = useMemo(() => {
    cobwebTex.colorSpace = THREE.SRGBColorSpace;
    // The one prop in the scene that must NOT be additive: a cobweb
    // occludes the brick behind it, it doesn't glow. Additive would make it
    // read as light and vanish against the dark walls.
    return new THREE.MeshStandardMaterial({
      map: cobwebTex,
      color: COLORS.bright,
      transparent: true,
      opacity: COBWEB_OPACITY,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
    });
  }, [cobwebTex]);

  // Same art, lighter — these hang in the walkway rather than on masonry.
  const tileWebMat = useMemo(() => {
    const m = cobwebMat.clone();
    m.opacity = TILE_WEB_OPACITY;
    return m;
  }, [cobwebMat]);

  const { torches, cobwebs, tileWebs } = useMemo(() => {
    const byId = new Map(model.rooms.map((r) => [r.id, r]));
    const torchOut = [];
    const webOut = [];
    const tileOut = [];

    for (const room of model.rooms) {
      const walls = solidWalls(room, byId);
      const taken = new Set();

      // Torches: east/west walls only, each side decided independently so
      // rooms come out with left, right, both, or none.
      for (const dir of walls) {
        if (dir !== 'E' && dir !== 'W') continue;
        if (hashKey(`${room.id}:torch:${dir}`) >= TORCH_CHANCE) continue;
        taken.add(dir);
        const frame = wallFrame(room, dir, model);
        torchOut.push({ key: `${room.id}-torch-${dir}`, ...frame });
      }

      // Cobwebs: any solid wall the torches didn't claim — the two never
      // share a wall.
      for (const dir of walls) {
        if (taken.has(dir)) continue;
        if (hashKey(`${room.id}:web:${dir}`) >= COBWEB_CHANCE) continue;
        const frame = wallFrame(room, dir, model);
        // Corner index runs clockwise from top-left; the art's apex sits in
        // its own top-left, so rotating -90 deg per step walks it round.
        const corner = Math.floor(hashKey(`${room.id}:web:${dir}:corner`) * 4) % 4;
        const halfW = CELL / 2 - COBWEB_SIZE / 2;
        const halfH = WALL_H / 2 - COBWEB_SIZE / 2;
        const ox = corner === 1 || corner === 2 ? halfW : -halfW;
        const oy = corner === 0 || corner === 1 ? halfH : -halfH;
        webOut.push({
          key: `${room.id}-web-${dir}`,
          ...frame,
          ox,
          oy,
          rotZ: -corner * (Math.PI / 2),
        });
      }

      // Passage web: hung across the through-axis, so it faces the only
      // direction the player can arrive from and its corners land on the
      // flanking walls. Same corner maths as the wall webs — it is just a
      // corner web on a virtual wall spanning the passage.
      const axis = throughAxis(room, byId);
      if (axis && room.id !== model.playerRoomId
        && hashKey(`${room.id}:tileweb`) < TILE_WEB_CHANCE) {
        const { x, z } = cellCenter(room.gridX, room.gridY, model);
        const corner = Math.floor(hashKey(`${room.id}:tileweb:corner`) * 4) % 4;
        const halfW = CELL / 2 - TILE_WEB_SIZE / 2;
        const halfH = WALL_H / 2 - TILE_WEB_SIZE / 2;
        tileOut.push({
          key: `${room.id}-tileweb`,
          x,
          z,
          // Plane normal runs ALONG the passage: a N-S corridor needs a quad
          // in the E-W plane, and vice versa.
          rotY: axis === 'NS' ? 0 : Math.PI / 2,
          ox: corner === 1 || corner === 2 ? halfW : -halfW,
          oy: corner === 0 || corner === 1 ? halfH : -halfH,
          rotZ: -corner * (Math.PI / 2),
        });
      }
    }
    return { torches: torchOut, cobwebs: webOut, tileWebs: tileOut };
  }, [model]);

  return (
    <group>
      {torches.map((placement) => (
        <Torch
          key={placement.key}
          placement={placement}
          template={template}
          reducedMotion={reducedMotion}
        />
      ))}

      {/* Cobwebs share one material and geometry, so they instance cleanly */}
      {cobwebs.length > 0 && (
        <Instances limit={256} frustumCulled={false} material={cobwebMat}>
          <planeGeometry args={[COBWEB_SIZE, COBWEB_SIZE]} />
          {cobwebs.map((web) => (
            <group
              key={web.key}
              position={[web.x, WALL_H / 2, web.z]}
              rotation={[0, web.rotY, 0]}
            >
              <Instance position={[web.ox, web.oy, 0.03]} rotation={[0, 0, web.rotZ]} />
            </group>
          ))}
        </Instances>
      )}

      {/* Passage webs. Fixed orientation, so unlike a billboard they batch
          into one draw call just as the wall webs do. */}
      {tileWebs.length > 0 && (
        <Instances limit={64} frustumCulled={false} material={tileWebMat}>
          <planeGeometry args={[TILE_WEB_SIZE, TILE_WEB_SIZE]} />
          {tileWebs.map((web) => (
            <group key={web.key} position={[web.x, WALL_H / 2, web.z]} rotation={[0, web.rotY, 0]}>
              <Instance position={[web.ox, web.oy, 0]} rotation={[0, 0, web.rotZ]} />
            </group>
          ))}
        </Instances>
      )}
    </group>
  );
}

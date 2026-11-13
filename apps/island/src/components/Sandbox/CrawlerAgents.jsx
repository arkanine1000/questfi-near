/**
 * Animated rival agents inside the followed agent's dungeon.
 *
 * This is the same skinned mannequin and animation library used by the
 * Questfi Lobby's crew deck, colosseum and battlefield. Each clone gets the
 * roster's exact color, a matching equipped weapon on the right-hand bone,
 * and real idle / run / sword attack / hit / death animation clips driven by
 * the crawler's combat beat queue.
 */

import {
  useEffect, useLayoutEffect, useMemo, useRef,
} from 'react';
import * as THREE from 'three';
import { useFrame, useLoader } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { CELL, cellCenter } from '../Scene3D/Crawler/CrawlerMaze';
import { loaderFor, weaponModelUrl, weaponSpecFor } from '../Scene3D/Crawler/weaponCatalog';
import { useRoomLight, LIGHT_PRIORITY } from '../Scene3D/Crawler/CrawlerLightPool';
import { AGENT_MODEL_URL as AGENT_MODEL } from '../Scene3D/Crawler/crawlerAssets';
import { COLORS } from '../Scene3D/worldUtils';
import { holoFillMaterial, holoWireMaterial } from '../Scene3D/holo';
import { useSandbox } from '../../context/SandboxContext';

const AGENT_H = 1.7;
const SLOT_SPREAD = 1.75;
const ROW_BACKOFF = 0.85;
const CLEARANCE = 1.7;
const MIN_AGENT_CLEARANCE = 1.05;
const ROLL_DIST = 0.65;
const WIRE_TRI_LIMIT = 120_000;
const ANIM_NAMES = [
  'Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sword_Idle', 'Sword_Attack',
  'Punch_Cross', 'Hit_Chest', 'Hit_Head', 'Roll', 'Death01', 'Dance_Loop',
];

// House hologram values (holo.js), a step brighter than the start app's
// figure so a rival stays readable against the near-black dungeon stone
const RIVAL_FILL_INTENSITY = 0.36;
const RIVAL_FILL_OPACITY = 0.55;
const RIVAL_WIRE_OPACITY = 0.6;
const HIT_FILL_INTENSITY = 0.9;
const HELD_FILL_INTENSITY = 0.6;
const HELD_WIRE_OPACITY = 0.7;
const RIVAL_LIGHT = 3;
const HIT_COLOR = new THREE.Color(COLORS.red);

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const _target = new THREE.Vector3();
const _worldScale = new THREE.Vector3();
const _vertex = new THREE.Vector3();
const _holderPos = new THREE.Vector3();
const _box = new THREE.Box3();

// Wall margin fallback (origin-only, the pre-measurement value) and the
// floor on how much lateral room the clamp must always leave.
const MIN_WALL_MARGIN = 0.35;
const MIN_ROOM_HALF_WIDTH = 0.6;

/**
 * Lateral offset for rival i in a cell holding `mobCount` mobs and
 * `rivalCount` rivals. Mobs own the center line; agents stagger around it.
 */
export function rivalSlotX(i, rivalCount, mobCount) {
  if (mobCount === 0) return (i - (rivalCount - 1) / 2) * SLOT_SPREAD;
  const magnitude = (Math.floor(i / 2) + 1) * SLOT_SPREAD;
  return i % 2 === 0 ? magnitude : -magnitude;
}

/**
 * Slot index must be a stable function of *who* is in the room, not of
 * array position — the polled payload's ordering can shift between polls
 * (join/leave/reorder) with no change in who's actually present, which
 * would otherwise swap two agents' slots and send them crossing through
 * each other. Sorting by id keeps a given agent's slot fixed across polls.
 */
export function stableAgentOrder(agents) {
  return [...agents].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function triangleCount(geometry) {
  return geometry.index
    ? geometry.index.count / 3
    : geometry.attributes.position.count / 3;
}

/** Duplicate a skinned mesh as an extra render pass bound to the same
 * skeleton (used for the wire overlay). */
function addSkinnedPass(mesh, material) {
  const pass = new THREE.SkinnedMesh(mesh.geometry, material);
  pass.bind(mesh.skeleton, mesh.bindMatrix);
  pass.bindMode = mesh.bindMode;
  pass.frustumCulled = false;
  pass.position.copy(mesh.position);
  pass.quaternion.copy(mesh.quaternion);
  pass.scale.copy(mesh.scale);
  mesh.parent.add(pass);
  return pass;
}

/**
 * Agent-flavored holo treatment: translucent tinted fill + strong wire
 * overlay.
 *
 * The fill is transparent but KEEPS depthWrite on — deliberate, and load-
 * bearing both ways. Writing depth means opaque geometry (walls) occludes
 * the rig strictly by distance, so holograms never leak through the shell.
 * Being transparent puts the fill in the same back-to-front object-sorted
 * queue as the enemy billboards and other agents, so overlaps BLEND by
 * distance instead of occluding: a nearer hologram draws over a farther
 * agent or skeleton while letting it ghost through — that's the visible
 * translucency. (A previous depth-prepass version occluded like a solid:
 * anything behind the silhouette vanished, so agents read as opaque the
 * moment they overlapped another actor.) The cost is triangle-order
 * artifacts within one rig — a farther limb drawn after a nearer torso is
 * depth-rejected rather than blended — which doesn't read at 0.55 opacity
 * on this low-poly mannequin. No renderOrder overrides anywhere: correct
 * layering depends on default distance sorting.
 */
function makeColoredRig(scene, color) {
  const rig = skeletonClone(scene);
  rig.rotation.y = Math.PI; // source mannequin is authored backward

  const tint = new THREE.Color(color || COLORS.greenBright);
  const fillMat = holoFillMaterial(tint, { intensity: RIVAL_FILL_INTENSITY });
  fillMat.roughness = 1;
  fillMat.metalness = 0;
  fillMat.transparent = true;
  fillMat.opacity = RIVAL_FILL_OPACITY;
  fillMat.toneMapped = false;
  const wireMat = holoWireMaterial(tint, RIVAL_WIRE_OPACITY);
  wireMat.polygonOffset = true;
  wireMat.polygonOffsetFactor = -1;
  wireMat.polygonOffsetUnits = -1;

  // Collect first, mutate after — adding pass meshes mid-traverse would
  // visit the passes themselves and re-skin them as fills.
  const staticMeshes = [];
  const skinnedMeshes = [];
  rig.traverse((object) => {
    if (object.isSkinnedMesh) skinnedMeshes.push(object);
    else if (object.isMesh) staticMeshes.push(object);
  });

  for (const mesh of staticMeshes) {
    mesh.material = fillMat;
    if (triangleCount(mesh.geometry) < WIRE_TRI_LIMIT) {
      mesh.add(new THREE.Mesh(mesh.geometry, wireMat));
    }
  }

  for (const mesh of skinnedMeshes) {
    mesh.material = fillMat;
    mesh.frustumCulled = false;
    if (triangleCount(mesh.geometry) < WIRE_TRI_LIMIT) {
      addSkinnedPass(mesh, wireMat);
    }
  }

  return {
    rig, fillMat, wireMat, tint,
  };
}

/** Clone and normalize one of the map's existing low-poly weapon models,
 * in the same fill-plus-wire dress as the rig that holds it. */
function makeHeldWeapon(model, spec, color) {
  const tint = new THREE.Color(color || COLORS.greenBright);
  const material = holoFillMaterial(tint, { intensity: HELD_FILL_INTENSITY, base: 0.24 });
  material.toneMapped = false;
  const wireMat = holoWireMaterial(tint, HELD_WIRE_OPACITY);
  const source = model.clone(true);
  const meshes = [];
  source.traverse((object) => {
    if (object.isMesh) meshes.push(object);
  });
  for (const mesh of meshes) {
    mesh.material = material;
    if (triangleCount(mesh.geometry) < WIRE_TRI_LIMIT) {
      mesh.add(new THREE.Mesh(mesh.geometry, wireMat));
    }
  }

  const normalized = new THREE.Group();
  normalized.add(source);
  const size = new THREE.Vector3();

  // Weapons carrying their own hold transform skip the blade pipeline
  // below: it stands the longest axis upright and grips 28% along it,
  // which is right for a blade and wrong for anything else. Rivals get
  // the model centred and scaled, with no deform rig — see CrawlerWeapon
  // for the animated first-person path.
  if (spec.hold) {
    normalized.scale.setScalar(spec.hold.scale);
    const scaled = new THREE.Box3().setFromObject(normalized);
    normalized.position.set(
      -(scaled.min.x + scaled.max.x) / 2,
      -(scaled.min.y + scaled.max.y) / 2,
      -(scaled.min.z + scaled.max.z) / 2,
    );
    const held = new THREE.Group();
    held.add(normalized);
    held.rotation.set(...spec.hold.rotation);
    return { object: held, material };
  }

  new THREE.Box3().setFromObject(source).getSize(size);
  if (size.x >= size.y && size.x >= size.z) source.rotation.set(0, 0, Math.PI / 2);
  else if (size.z >= size.y && size.z >= size.x) source.rotation.set(-Math.PI / 2, 0, 0);

  const box = new THREE.Box3().setFromObject(normalized);
  box.getSize(size);
  normalized.scale.setScalar(spec.length / Math.max(size.y, 0.0001));
  const scaled = new THREE.Box3().setFromObject(normalized);
  normalized.position.set(
    -(scaled.min.x + scaled.max.x) / 2,
    -scaled.min.y - (scaled.max.y - scaled.min.y) * 0.28,
    -(scaled.min.z + scaled.max.z) / 2,
  );

  const holder = new THREE.Group();
  holder.add(normalized);
  holder.rotation.y = Math.PI / 2;
  return { object: holder, material };
}

// Rigify deform-bone names baked into crew.glb — confirmed via the GLTF's
// node list, not guessed. Preset scale tweaks only ever touch these.
const BONE = {
  spineUpper: 'DEF-spine.003',
  upperArmL: 'DEF-upper_arm.L',
  upperArmR: 'DEF-upper_arm.R',
};

/**
 * Class-preset build differences via bone-scale tweaks on the shared rig:
 * leaner rogue, bulkier barbarian. Accessory geometry (pauldrons, hoods)
 * was tried and rolled back — placement on this rig's untrustworthy
 * bone-local axes was too fiddly to nail down without visual iteration.
 */
const PRESET_SCALES = {
  fighter: [],
  rogue: [{ bone: BONE.spineUpper, scale: 0.9 }],
  barbarian: [
    { bone: BONE.spineUpper, scale: 1.18 },
    { bone: BONE.upperArmL, scale: 1.22 },
    { bone: BONE.upperArmR, scale: 1.22 },
  ],
};

function clipByName(clips, name) {
  return clips.find((clip) => clip.name === name || clip.name.endsWith(`|${name}`));
}

/** World position of any combat actor: the followed agent ('player') is
 * the camera, rivals stand at their stagger slots, mobs hold the center
 * line. Used both for aiming attacks (targetId) and for orienting dodges
 * away from the incoming attacker (attackerId). */
function actorPointFor(actorId, agent, model, camera, out) {
  if (!actorId || actorId === 'player') {
    return out.set(camera.position.x, 0, camera.position.z);
  }
  const room = model.rooms.find((entry) => entry.id === agent.roomId);
  const home = cellCenter(agent.gridX, agent.gridY, model);
  const orderedAgents = stableAgentOrder(room?.agents ?? []);
  const rivalIndex = orderedAgents.findIndex((entry) => entry.id === actorId);
  if (rivalIndex >= 0) {
    const mobCount = room.entities.filter(
      (entry) => entry.type === 'hostile' || entry.type === 'invader',
    ).length;
    return out.set(
      home.x + rivalSlotX(rivalIndex, orderedAgents.length, mobCount),
      0,
      home.z + ROW_BACKOFF,
    );
  }
  return out.set(home.x, 0, home.z); // mobs occupy the center line
}

function AnimatedAgent({
  agent, model, queue, reducedMotion, gltf, positions,
}) {
  const holderRef = useRef();
  const posRef = useRef(null);
  const yawRef = useRef(0);
  const currentActionRef = useRef(null);
  const lastBeatRef = useRef(null);
  const deadRef = useRef(false);
  const seedRef = useRef(Math.random() * 10);
  const scaledBonesRef = useRef([]);
  const reachRef = useRef(MIN_WALL_MARGIN);

  // Rival's colored light — pooled, position driven from the frame below.
  const rivalLight = useRoomLight({
    x: 0,
    y: 0.65,
    z: 0,
    color: agent.color || COLORS.greenBright,
    intensity: RIVAL_LIGHT,
    distance: 4.5,
    decay: 2,
    priority: LIGHT_PRIORITY.prop,
  });
  const dodgeSideRef = useRef(1);

  const colored = useMemo(
    () => makeColoredRig(gltf.scene, agent.color),
    [gltf.scene, agent.color],
  );
  const mixer = useMemo(() => new THREE.AnimationMixer(colored.rig), [colored.rig]);
  const actions = useMemo(() => Object.fromEntries(
    ANIM_NAMES.map((name) => [name, clipByName(gltf.animations, name)])
      .filter(([, clip]) => clip)
      .map(([name, clip]) => [name, mixer.clipAction(clip)]),
  ), [gltf.animations, mixer]);

  const weaponSpec = useMemo(() => weaponSpecFor(agent.weapon), [agent.weapon]);
  const weaponAsset = useLoader(
    loaderFor(weaponSpec),
    weaponModelUrl(weaponSpec),
  );
  // GLTFLoader hands back a document; FBXLoader hands back the object.
  const weaponModel = weaponAsset.scene ?? weaponAsset;
  const heldWeapon = useMemo(
    () => makeHeldWeapon(weaponModel, weaponSpec, agent.color),
    [weaponModel, weaponSpec, agent.color],
  );

  const play = (name, {
    once = false, duration = null, clampPose = once, restart = false,
  } = {}) => {
    const action = actions[name];
    if (!action || (currentActionRef.current === name && !restart)) return;
    const previous = currentActionRef.current === name
      ? null
      : currentActionRef.current && actions[currentActionRef.current];
    currentActionRef.current = name;
    action.reset();
    action.enabled = true;
    action.paused = false;
    action.timeScale = duration
      ? Math.max(0.1, action.getClip().duration / duration)
      : 1;
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    action.clampWhenFinished = clampPose;
    action.play();
    if (previous && previous !== action) previous.crossFadeTo(action, 0.12, false);
  };

  useLayoutEffect(() => {
    const holder = holderRef.current;
    if (!holder) return undefined;

    // The source animation clips carry root scale, so a bind-pose Box3 gives
    // the wrong height. Pose the idle, sample real skinned vertices, and use
    // the same floor/height calibration as the lobby worlds.
    colored.rig.scale.setScalar(1);
    colored.rig.position.y = 0;
    actions.Idle_Loop?.play();
    mixer.update(0.05);
    holder.updateMatrixWorld(true);
    let skin = null;
    colored.rig.traverse((object) => {
      if (object.isSkinnedMesh && !skin) skin = object;
    });
    let minY = Infinity;
    let maxY = -Infinity;
    if (skin) {
      skin.skeleton.update();
      for (let i = 0; i < skin.geometry.attributes.position.count; i += 5) {
        skin.getVertexPosition(i, _vertex).applyMatrix4(skin.matrixWorld);
        minY = Math.min(minY, _vertex.y);
        maxY = Math.max(maxY, _vertex.y);
      }
    }
    if (Number.isFinite(minY) && maxY > minY) {
      const scale = AGENT_H / (maxY - minY);
      colored.rig.scale.setScalar(scale);
      colored.rig.position.y = -minY * scale;
    }

    mixer.stopAllAction();
    currentActionRef.current = null;
    play(actions.Sword_Idle ? 'Sword_Idle' : 'Idle_Loop');
    const idle = actions[currentActionRef.current];
    if (idle) idle.time = seedRef.current % Math.max(idle.getClip().duration, 0.1);

    // Weapons are authored in meters but the armature's hand bone carries a
    // large inherited scale. Counter it after the calibrated rig is posed.
    holder.updateMatrixWorld(true);
    const hand = colored.rig.getObjectByName('DEF-handR')
      ?? colored.rig.getObjectByName('DEF-hand.R');
    if (hand) {
      hand.getWorldScale(_worldScale);
      const handScale = Math.max(Math.abs(_worldScale.x), 0.0001);
      heldWeapon.object.scale.setScalar(1 / handScale);
      hand.add(heldWeapon.object);
    }

    // Class-preset build tweaks — record which bones need a per-frame scale
    // override (see the useFrame loop: some clips may carry their own scale
    // keyframes that would otherwise stomp a one-time set here).
    scaledBonesRef.current = (PRESET_SCALES[agent.preset] || [])
      .map(({ bone: boneName, scale }) => ({ bone: colored.rig.getObjectByName(boneName), scale }))
      .filter((entry) => entry.bone);
    // Apply preset scales now, not just in useFrame — the reach measurement
    // below must see the final silhouette (a widened barbarian reaches
    // farther than the base mannequin).
    for (const { bone, scale } of scaledBonesRef.current) bone.scale.setScalar(scale);

    // Measure the stance's true horizontal reach. The wall clamp bounds the
    // holder origin, but the combat idle holds limbs — and a spear-length
    // weapon — well outside the origin, so an origin-only margin lets the
    // stance poke through the shell. Sample the actual idle clip at several
    // loop phases (skinned fill vertices + the weapon box) and use the
    // worst case as this agent's personal wall margin in useFrame.
    const idleAction = actions[currentActionRef.current];
    let reach = MIN_WALL_MARGIN;
    if (idleAction) {
      const clipDuration = Math.max(idleAction.getClip().duration, 0.1);
      const seededTime = idleAction.time;
      for (let phase = 0; phase < 4; phase += 1) {
        idleAction.time = (clipDuration * phase) / 4;
        mixer.update(0);
        holder.updateMatrixWorld(true);
        holder.getWorldPosition(_holderPos);
        colored.rig.traverse((object) => {
          if (!object.isSkinnedMesh || object.material !== colored.fillMat) return;
          object.skeleton.update();
          for (let i = 0; i < object.geometry.attributes.position.count; i += 7) {
            object.getVertexPosition(i, _vertex).applyMatrix4(object.matrixWorld).sub(_holderPos);
            reach = Math.max(reach, Math.hypot(_vertex.x, _vertex.z));
          }
        });
        if (heldWeapon.object.parent) {
          _box.setFromObject(heldWeapon.object);
          if (!_box.isEmpty()) {
            reach = Math.max(reach, Math.hypot(
              Math.max(Math.abs(_box.min.x - _holderPos.x), Math.abs(_box.max.x - _holderPos.x)),
              Math.max(Math.abs(_box.min.z - _holderPos.z), Math.abs(_box.max.z - _holderPos.z)),
            ));
          }
        }
      }
      idleAction.time = seededTime;
      mixer.update(0);
    }
    // Small pad for sway between sampled phases; cap so a long-reach stance
    // in a small cell still leaves a usable interior instead of pinning
    // everyone to the exact center.
    reachRef.current = Math.min(reach + 0.1, CELL / 2 - MIN_ROOM_HALF_WIDTH);

    return () => {
      hand?.remove(heldWeapon.object);
      scaledBonesRef.current = [];
    };
    // All inputs own stable, memoized Three objects for this clone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colored.rig, heldWeapon.object, agent.preset, mixer, actions]);

  useEffect(() => () => {
    // Keep mixer bindings and memoized materials alive through React Strict
    // Mode's development-only effect replay. uncacheRoot()/dispose() here
    // invalidates the same action objects that the immediate replay reuses.
    // The clone is bounded by the roster (24 max) and is released with its
    // Canvas, while the loader-owned geometries remain globally cached.
    mixer.stopAllAction();
  }, [mixer, colored, heldWeapon]);

  useEffect(() => () => {
    positions?.current?.delete(agent.id);
  }, [positions, agent.id]);

  useFrame(({ camera }, delta) => {
    const holder = holderRef.current;
    if (!holder) return;
    mixer.update(delta);
    // Re-assert preset bone scales every frame — cheap, and guards against
    // any clip that carries its own scale keyframes for these bones.
    for (const { bone, scale } of scaledBonesRef.current) bone.scale.setScalar(scale);

    const home = cellCenter(agent.gridX, agent.gridY, model);
    // Personal wall margin: the stance's measured horizontal reach (limbs +
    // weapon at the combat idle), so the clamp keeps the whole silhouette
    // inside the shell rather than just the origin.
    const limit = Math.max(CELL / 2 - reachRef.current, MIN_ROOM_HALF_WIDTH);
    const tx = clamp(
      home.x + rivalSlotX(agent.slot, agent.count, agent.mobCount),
      home.x - limit,
      home.x + limit,
    );
    const tz = clamp(home.z + ROW_BACKOFF, home.z - limit, home.z + limit);

    if (!posRef.current) posRef.current = new THREE.Vector3(tx, 0, tz);
    const position = posRef.current;
    const moveDx = tx - position.x;
    const moveDz = tz - position.z;
    const moving = moveDx * moveDx + moveDz * moveDz > 0.0025;
    const moveEase = reducedMotion ? 1 : 1 - Math.exp(-delta * 6);
    position.x += moveDx * moveEase;
    position.z += moveDz * moveEase;

    let px = position.x;
    let pz = position.z;

    // Mutual separation from same-room agents. Slot math alone only spaces
    // agents that were already assigned distinct slots — it does nothing
    // for the transient frames while two agents' targets are still crossing
    // (a join/leave slot reshuffle, or a beat-driven lunge). Read is one
    // frame stale (siblings haven't written this frame's position yet),
    // which is fine for a soft cosmetic nudge — each agent only resolves
    // half the overlap, the other half converges from the other agent's own
    // pass next frame.
    if (positions?.current) {
      for (const [otherId, other] of positions.current) {
        if (otherId === agent.id || other.roomId !== agent.roomId) continue;
        const dx = px - other.x;
        const dz = pz - other.z;
        const distSq = dx * dx + dz * dz;
        if (distSq < MIN_AGENT_CLEARANCE * MIN_AGENT_CLEARANCE && distSq > 1e-4) {
          const distance = Math.sqrt(distSq);
          const push = (MIN_AGENT_CLEARANCE - distance) * 0.5;
          px += (dx / distance) * push;
          pz += (dz / distance) * push;
        }
      }
    }

    // Keep a rival from filling the first-person lens while it glides between
    // polled cells. This only nudges where the rig is drawn (px/pz below) —
    // it must never feed back into `position`, or a rival idling near the
    // camera would see its own slot-distance reopen every frame and read as
    // permanently "moving" (stuck in the run cycle).
    const cameraDx = px - camera.position.x;
    const cameraDz = pz - camera.position.z;
    const cameraDistSq = cameraDx * cameraDx + cameraDz * cameraDz;
    if (cameraDistSq < CLEARANCE * CLEARANCE && cameraDistSq > 1e-4) {
      const distance = Math.sqrt(cameraDistSq);
      px = camera.position.x + (cameraDx / distance) * CLEARANCE;
      pz = camera.position.z + (cameraDz / distance) * CLEARANCE;
    }

    if (positions?.current) {
      positions.current.set(agent.id, { x: px, z: pz, roomId: agent.roomId });
    }

    const beat = queue.current;
    const attacking = beat?.kind === 'attack' && beat.attackerId === agent.id;
    const takingHit = beat?.kind === 'attack' && beat.hit && beat.targetId === agent.id;
    const dodging = beat?.kind === 'attack' && !beat.hit && beat.targetId === agent.id;
    const dying = beat?.kind === 'death' && beat.entityId === agent.id;

    if (dying) deadRef.current = true;
    if (beat?.id !== lastBeatRef.current) {
      lastBeatRef.current = beat?.id ?? null;
      if (dying) {
        play('Death01', {
          once: true, duration: beat.dur, clampPose: true, restart: true,
        });
      } else if (attacking) {
        play(actions.Sword_Attack ? 'Sword_Attack' : 'Punch_Cross', {
          once: true,
          duration: beat.dur,
          clampPose: false,
          restart: true,
        });
      } else if (takingHit) {
        play(Math.random() < 0.5 ? 'Hit_Chest' : 'Hit_Head', {
          once: true,
          duration: beat.dur,
          clampPose: false,
          restart: true,
        });
      } else if (dodging) {
        play('Roll', {
          once: true, duration: beat.dur, clampPose: false, restart: true,
        });
        // Pick the roll side once per beat, not per frame — flipping the
        // sign mid-roll would teleport the rig across the attack line. Of
        // the two perpendiculars to the incoming attack, take the one whose
        // FULL extension ends deeper inside the room shell, so the roll
        // never aims at a wall (the final clamp below stays as backstop).
        actorPointFor(beat.attackerId, agent, model, camera, _target);
        const inDx = _target.x - px;
        const inDz = _target.z - pz;
        const inLen = Math.hypot(inDx, inDz);
        if (inLen > 0.01) {
          const sideDepth = (side) => {
            const ex = px + (-inDz / inLen) * ROLL_DIST * side;
            const ez = pz + (inDx / inLen) * ROLL_DIST * side;
            return Math.min(
              limit - Math.abs(ex - home.x),
              limit - Math.abs(ez - home.z),
            );
          };
          dodgeSideRef.current = sideDepth(1) >= sideDepth(-1) ? 1 : -1;
        } else {
          dodgeSideRef.current = 1;
        }
      }
    }

    const reacting = dying || attacking || takingHit || dodging || deadRef.current;
    if (!reacting) {
      play(moving
        ? (actions.Jog_Fwd_Loop ? 'Jog_Fwd_Loop' : 'Walk_Loop')
        : (actions.Sword_Idle ? 'Sword_Idle' : 'Idle_Loop'));
    }

    let desiredYaw;
    if (attacking) {
      actorPointFor(beat.targetId, agent, model, camera, _target);
      const dx = _target.x - px;
      const dz = _target.z - pz;
      desiredYaw = Math.atan2(dx, dz);
      if (!reducedMotion) {
        const length = Math.hypot(dx, dz);
        const lunge = Math.sin(queue.progress * Math.PI) * 0.48;
        if (length > 0.01) {
          px += (dx / length) * lunge;
          pz += (dz / length) * lunge;
        }
      }
    } else if (dodging) {
      // Face the incoming attack, dart sideways out of its line and back —
      // same sine envelope as the lunge, so the rig ends the beat at its
      // slot. The Roll clip is the in-place variant (Roll, not Roll_RM);
      // the sway here is the roll's whole displacement.
      actorPointFor(beat.attackerId, agent, model, camera, _target);
      const dx = _target.x - px;
      const dz = _target.z - pz;
      const length = Math.hypot(dx, dz);
      desiredYaw = length > 0.01 ? Math.atan2(dx, dz) : yawRef.current;
      if (!reducedMotion && length > 0.01) {
        const sway = Math.sin(queue.progress * Math.PI) * ROLL_DIST * dodgeSideRef.current;
        px += (-dz / length) * sway;
        pz += (dx / length) * sway;
      }
    } else if (moving) {
      desiredYaw = Math.atan2(moveDx, moveDz);
    } else {
      // Idle rivals square up on the tile center — they're in the fight,
      // not performing for the lens. Facing the spectator is reserved for
      // attacks actually aimed at the followed agent (the attacking branch
      // above, via actorPointFor). Rivals stand offset from center (slot
      // spread + row backoff), so the direction is well-defined; hold the
      // last yaw in the degenerate dead-center case.
      const centerDx = home.x - px;
      const centerDz = home.z - pz;
      desiredYaw = centerDx * centerDx + centerDz * centerDz > 1e-4
        ? Math.atan2(centerDx, centerDz)
        : yawRef.current;
    }
    let yawDelta = (desiredYaw - yawRef.current) % (Math.PI * 2);
    if (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
    if (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
    yawRef.current += yawDelta * (reducedMotion ? 1 : 1 - Math.exp(-delta * 9));

    // Final wall clamp: the separation push, camera-clearance push and
    // attack lunge each nudge px/pz after the slot target was clamped, and
    // any of them can shove the rig into the room shell. The depth-writing
    // fill can't leak through a wall into the next room, but the near half
    // would still visibly sink into the wall, so keep the drawn position
    // inside the shell too. Last so nothing re-offsets after it.
    px = clamp(px, home.x - limit, home.x + limit);
    pz = clamp(pz, home.z - limit, home.z + limit);

    holder.position.set(px, 0, pz);
    holder.rotation.y = yawRef.current;

    // The rival's own light rides the shared pool (see CrawlerLightPool):
    // it walks, so its world position is pushed to the live spec here. This
    // is independent of how the rival is DRAWN — it survives the move from
    // billboard sprites to rigged 3D models untouched.
    rivalLight.pos.set(px, 0.65, pz);

    // Lobby-style red material hit flash, restored every other frame.
    // Copies prebuilt colours: parsing a colour string every frame allocates.
    if (takingHit && queue.progress < 0.72) {
      colored.fillMat.emissive.copy(HIT_COLOR);
      colored.fillMat.emissiveIntensity = HIT_FILL_INTENSITY;
      colored.wireMat.color.copy(HIT_COLOR);
    } else {
      colored.fillMat.emissive.copy(colored.tint);
      colored.fillMat.emissiveIntensity = RIVAL_FILL_INTENSITY;
      colored.wireMat.color.copy(colored.tint);
    }
  });

  return (
    <group ref={holderRef}>
      <primitive object={colored.rig} />
      <Html
        position={[0, AGENT_H + 0.18, 0]}
        center
        occlude={false}
        zIndexRange={[60, 0]}
        style={{ pointerEvents: 'none' }}
      >
        <div className="sbx-tag sbx-tag--focus" style={{ '--tag-color': agent.color }}>
          {agent.name}
        </div>
      </Html>
    </group>
  );
}

export default function CrawlerAgents({ model, queue, reducedMotion }) {
  const { roster } = useSandbox();
  const gltf = useLoader(GLTFLoader, AGENT_MODEL);
  // Shared cross-agent position registry for mutual-clearance separation —
  // see the useFrame loop in AnimatedAgent. One map for the whole roster
  // (not per-room) since agents can move between rooms.
  const positionsRef = useRef(new Map());
  const rosterById = useMemo(
    () => Object.fromEntries(roster.map((agent) => [agent.agent_id, agent])),
    [roster],
  );

  const rivals = useMemo(() => {
    const out = [];
    for (const room of model.rooms) {
      const list = stableAgentOrder(room.agents || []);
      const mobCount = room.entities.filter(
        (entry) => entry.type === 'hostile' || entry.type === 'invader',
      ).length;
      list.forEach((entry, index) => {
        const identity = rosterById[entry.id] || {};
        out.push({
          ...entry,
          color: entry.color || identity.color || COLORS.greenBright,
          preset: identity.preset || 'fighter',
          weapon: identity.weapon || null,
          roomId: room.id,
          gridX: room.gridX,
          gridY: room.gridY,
          slot: index,
          count: list.length,
          mobCount,
        });
      });
    }
    return out;
  }, [model, rosterById]);

  return (
    <group>
      {rivals.map((rival) => (
        <AnimatedAgent
          key={rival.id}
          agent={rival}
          model={model}
          queue={queue}
          reducedMotion={reducedMotion}
          gltf={gltf}
          positions={positionsRef}
        />
      ))}
    </group>
  );
}

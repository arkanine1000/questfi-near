import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';
import FacingBillboard from './FacingBillboard';
import { CELL, WALL_H, cellCenter } from './CrawlerMaze';
import { makeTintVariant } from './crawlerTextures';
import { useRoomLight, LIGHT_PRIORITY } from './CrawlerLightPool';
import { ENEMY_SPRITE_KEYS, ENEMY_SPRITE_URLS, bossSheetFor } from './crawlerAssets';
import {
  getSpriteSheetTexture, cloneFrameTexture, setFrame, pingPongFrame,
  makeSheetTintVariant,
} from './spriteSheet';
import { COLORS } from '../worldUtils';

// Hostile holograms: the questfi-lobby enemy.js treatment — additive
// projection billboard, no depth write, hovering idle, red-channel-swap
// flash when the player lands a hit, soft dissolve on death.

const ENEMY_H = 1.9;
const BOSS_SCALE = 1.4; // boss absolute size unchanged (~2.66) after the mob bump
const SLOT_SPREAD = 0.9; // world-space lateral gap between cellmates
const MIN_CLEARANCE = 1.05; // only push a sprite the camera truly intersects
// No head through the roof: lift + bob + death-rise together can carry a
// tall floater (boss wraith especially) past WALL_H, so the frame loop
// clamps every sprite's top edge below the ceiling instead of per-type
// number tuning.
const CEIL_CLEARANCE = WALL_H - 0.12;

// Mirrors CrawlerAgents.jsx's rivalSlotX/ROW_BACKOFF, duplicated rather
// than imported — this file is shared with the solo crawler, which has
// no rivals, so it must not depend on Sandbox/-namespaced code.
const RIVAL_SLOT_SPREAD = 1.75;
const RIVAL_ROW_BACKOFF = 0.85;
function rivalSlotX(i, rivalCount, mobCount) {
  if (mobCount === 0) return (i - (rivalCount - 1) / 2) * RIVAL_SLOT_SPREAD;
  const magnitude = (Math.floor(i / 2) + 1) * RIVAL_SLOT_SPREAD;
  return i % 2 === 0 ? magnitude : -magnitude;
}

// Archetype sprite set — keyed by keyword match over the entity name/id.
// Sprites have mixed aspects (portrait, square, landscape); each billboard
// derives width from its own image.
// Urls live in crawlerAssets.js so the warm-up preloads this exact list, in
// this exact order — r3f's cache key is the loader plus the url array.
const SPRITE_KEYS = ENEMY_SPRITE_KEYS;

// How far off the floor each archetype floats — fliers and spirits hover,
// bones walk
const SPRITE_LIFT = {
  harpy: 0.75,
  mage: 0.5,
  wraith: 0.45,
  shadow: 0.2,
  skeleton: 0.05,
};

// Per-archetype height multiplier — the wraith sprite is tall AND floats
// high, which drove its head through the ceiling at full size
const SPRITE_SCALE = {
  wraith: 0.82,
};

function spriteKeyFor(enemy) {
  const hay = `${enemy.name ?? ''} ${enemy.id ?? ''}`.toLowerCase();
  for (const key of SPRITE_KEYS) {
    if (hay.includes(key)) return key;
  }
  if (hay.includes('goblin')) return 'shadow'; // legacy demo stand-in
  // A sheet boss falls back to the wraith rather than the default skeleton:
  // sheet bosses are the biggest thing in their dungeon, and if the sheet is
  // ever missing, a hulking wraith is a far less wrong stand-in than bones.
  if (bossSheetFor(enemy.id)) return 'wraith';
  return 'skeleton';
}

// Idle flap speed. 3 frames ping-pong = 4 steps, so ~1.5 wingbeats a second.
const SHEET_IDLE_FPS = 6;
// Share of the attack beat that drives the sheet's frames; the remainder is
// covered by SHEET_ATTACK_TAIL below.
const SHEET_ATTACK_FRAC = 0.7;
// Burst catch-up halves beat durations, so a 0.4s attack can compress far
// enough that the breath frame would strobe for a few tens of milliseconds and
// snap back to a flap mid-exhale. A fixed wall-clock tail holds the final
// frame regardless of how short the beat got.
const SHEET_ATTACK_TAIL = 0.18;

const planeGeo = new THREE.PlaneGeometry(1, 1);
const _toEnemy = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function smoothstep(t) {
  const k = clamp(t, 0, 1);
  return k * k * (3 - 2 * k);
}

function beatTargetsEnemy(beatId, enemyId, inPlayerRoom) {
  return beatId != null ? beatId === enemyId : inPlayerRoom;
}

function EnemyBillboard({ enemy, model, queue, reducedMotion, textures }) {
  const groupRef = useRef();
  const meshRef = useRef();
  const seedRef = useRef(Math.random() * 10);
  const frameRef = useRef(-1); // last frame index written to the uniforms
  const attackEndRef = useRef(0); // wall clock the attack tail expires at
  const redSheetRef = useRef(null); // lazily built, see the flash below

  const sheet = enemy.sheet ?? null;

  // Menacing underlight — red for the boss, faction color otherwise.
  // Position and intensity are driven live from the animation frame below.
  const underLight = useRoomLight({
    x: 0,
    y: 0.35,
    z: 0,
    color: sheet?.light
      ?? (enemy.boss ? COLORS.red : enemy.invader ? COLORS.ice : COLORS.green),
    intensity: 3.5,
    distance: 5,
    decay: 2,
    priority: LIGHT_PRIORITY.prop,
  });

  // A sheet boss gets its own playback head on the shared sheet. The clone
  // shares .source, so this stays one GPU upload however many exist, and the
  // per-instance offset writes below cannot stomp the module-memoized texture.
  const sheetTex = useMemo(
    () => (sheet ? cloneFrameTexture(getSpriteSheetTexture(sheet.url, sheet)) : null),
    [sheet],
  );
  useEffect(() => () => sheetTex?.dispose(), [sheetTex]);

  const baseTex = sheetTex ?? (enemy.invader ? textures.cyan : textures.green);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({
    map: baseTex,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  }), [baseTex]);
  useEffect(() => () => mat.dispose(), [mat]);

  // A sheet's aspect is ONE CELL's, declared in the registry — deriving it
  // from the image would give the whole sheet's and squash the sprite.
  const aspect = sheet ? sheet.aspect : textures.aspect;
  const height = ENEMY_H * (
    sheet ? sheet.scale
      : enemy.boss ? BOSS_SCALE
        : enemy.spriteScale ?? 1
  );
  const inPlayerRoom = enemy.roomId === model.playerRoomId;
  const home = cellCenter(enemy.gridX, enemy.gridY, model);
  const basePosRef = useRef(null); // smoothed ground anchor
  const sawDeathRef = useRef(false); // latched once a dissolve has begun

  useFrame(({ clock, camera }, delta) => {
    const t = clock.elapsedTime + seedRef.current;
    const group = groupRef.current;
    const mesh = meshRef.current;
    if (!group || !mesh) return;

    const beat = queue.current;
    const progress = queue.progress;

    // Dissolve on the death beat — LATCHED: the beat ends a frame or more
    // before the parent unmounts us (map poll / state flush), and deriving
    // the fade from the live beat alone popped the sprite back for that gap
    let dying = 0;
    if (beat?.kind === 'death' && !beat.player
      && beatTargetsEnemy(beat.entityId, enemy.id, inPlayerRoom)) {
      dying = smoothstep(progress);
      if (dying > 0) sawDeathRef.current = true;
    } else if (sawDeathRef.current) {
      group.visible = false;
      return;
    }

    // World-anchored placement: the enemy stands at its cell, cellmates
    // fanned into stable lateral slots. It does NOT track the camera — a
    // fixed anchor is what makes an approach actually grow the sprite on
    // screen (camera-relative face-off retreated to hold its distance,
    // which read as the enemy shrinking as you closed in). The rig's
    // combat backoff keeps the camera off the anchor; the clearance push
    // below handles genuine intersections only.
    const lim = CELL / 2 - 0.35; // stay inside the room shell
    let tx = clamp(
      home.x + (enemy.slot - (enemy.count - 1) / 2) * SLOT_SPREAD,
      home.x - lim, home.x + lim,
    );
    let tz = home.z;
    const dxc = tx - camera.position.x;
    const dzc = tz - camera.position.z;
    const distSq = dxc * dxc + dzc * dzc;
    if (distSq < MIN_CLEARANCE * MIN_CLEARANCE) {
      if (distSq > 1e-4) {
        const d = Math.sqrt(distSq);
        tx = camera.position.x + (dxc / d) * MIN_CLEARANCE;
        tz = camera.position.z + (dzc / d) * MIN_CLEARANCE;
      } else {
        camera.getWorldDirection(_fwd);
        _fwd.y = 0;
        if (_fwd.lengthSq() < 1e-4) _fwd.set(0, 0, -1);
        else _fwd.normalize();
        tx = camera.position.x + _fwd.x * MIN_CLEARANCE;
        tz = camera.position.z + _fwd.z * MIN_CLEARANCE;
      }
      tx = clamp(tx, home.x - lim, home.x + lim);
      tz = clamp(tz, home.z - lim, home.z + lim);
    }
    if (!basePosRef.current) {
      basePosRef.current = new THREE.Vector3(tx, 0, tz);
    } else {
      const k = 1 - Math.exp(-delta * 8);
      basePosRef.current.x += (tx - basePosRef.current.x) * k;
      basePosRef.current.z += (tz - basePosRef.current.z) * k;
    }
    let px = basePosRef.current.x;
    let pz = basePosRef.current.z;

    // lunge toward the camera on this enemy's attack beat
    let lunge = 0;
    if (
      beat?.kind === 'attack' && !beat.byPlayer
      && beatTargetsEnemy(beat.attackerId, enemy.id, inPlayerRoom)
      && !reducedMotion
    ) {
      // The clearance push above runs BEFORE this, so the lunge is unclamped —
      // a big sprite at full distance drives itself through the near plane.
      lunge = Math.sin(progress * Math.PI) * 0.7 * (enemy.lungeScale ?? 1);
    }
    if (lunge > 0) {
      if (beat.targetId === 'player') {
        // attacking the spectated agent — lunge straight at the camera
        _toEnemy.set(camera.position.x - px, 0, camera.position.z - pz);
      } else {
        // attacking a co-located rival, not the spectator — aim at the
        // rival's own stagger slot (mirrors CrawlerAgents.jsx's
        // rivalSlotX). Room center is NOT a safe fallback here: a lone
        // mob (the common case) already sits dead-center itself, so
        // "lunge toward center" would be a zero-length no-op.
        const room = model.rooms.find((r) => r.id === enemy.roomId);
        const rivals = room?.agents ?? [];
        const idx = rivals.findIndex((a) => a.id === beat.targetId);
        if (idx !== -1) {
          const mobCount = room.entities.filter(
            (e) => e.type === 'hostile' || e.type === 'invader',
          ).length;
          const tx = home.x + rivalSlotX(idx, rivals.length, mobCount);
          const tz = home.z + RIVAL_ROW_BACKOFF;
          _toEnemy.set(tx - px, 0, tz - pz);
        } else {
          _toEnemy.set(home.x - px, 0, home.z - pz); // unknown target — center is the best guess
        }
      }
      if (_toEnemy.lengthSq() > 0.01) {
        _toEnemy.normalize();
        px += _toEnemy.x * lunge;
        pz += _toEnemy.z * lunge;
      }
    }

    // red channel-swap flash while a hit connects — any attacker, not
    // just the player, so a rival landing a blow on a co-located mob
    // reads as clearly as the player's own hits do
    const flashing = beat?.kind === 'attack' && beat.hit
      && beatTargetsEnemy(beat.targetId, enemy.id, inPlayerRoom)
      && progress < 0.6;

    // Sheet playback: idle flap, or a one-shot attack sequence driven by the
    // beat's own progress rather than a private clock — that is what keeps the
    // breath locked to the lunge above, which reads the same progress.
    let breathing = false;
    if (sheet) {
      const attacking = beat?.kind === 'attack' && !beat.byPlayer
        && beatTargetsEnemy(beat.attackerId, enemy.id, inPlayerRoom);
      if (attacking) {
        attackEndRef.current = clock.elapsedTime + SHEET_ATTACK_TAIL;
      }

      const last = sheet.attack.length - 1;
      let frame;
      if (dying > 0) {
        // the dissipation frame IS a dissolve — free reuse under the fade
        frame = sheet.attack[last];
      } else if (reducedMotion) {
        frame = sheet.idle[1]; // a poised sprite, just not a moving one
      } else if (attacking) {
        const step = Math.floor(progress * SHEET_ATTACK_FRAC * sheet.attack.length);
        frame = sheet.attack[Math.min(step, last)];
      } else if (clock.elapsedTime < attackEndRef.current) {
        frame = sheet.attack[last];
      } else {
        frame = sheet.idle[pingPongFrame(t, sheet.idle.length, SHEET_IDLE_FPS)];
      }
      breathing = frame === sheet.attack[Math.min(1, last)];

      // Only touch the uniforms on an actual frame change, and move the tint
      // in lockstep so a flash landing mid-sequence never shows a stale frame.
      if (frame !== frameRef.current) {
        frameRef.current = frame;
        setFrame(baseTex, frame);
        if (redSheetRef.current) setFrame(redSheetRef.current, frame);
      }
    }

    // The tint is built on first flash, not up front: getSpriteSheetTexture
    // only knows its half-texel inset once the image has decoded, and a
    // variant cloned before that samples into the neighbouring frame forever.
    // `baseTex.image` is the decode guard too: trackedLoad settles a 404
    // rather than wedging the curtain, so a missing sheet must degrade to an
    // un-flashing sprite instead of throwing inside the frame loop.
    if (flashing && sheet && !redSheetRef.current && baseTex.image) {
      redSheetRef.current = makeSheetTintVariant(baseTex, 'red');
      setFrame(redSheetRef.current, frameRef.current);
    }
    const wantTex = flashing
      ? (sheet ? redSheetRef.current : textures.red)
      : baseTex;
    if (wantTex && mat.map !== wantTex) {
      mat.map = wantTex;
      mat.needsUpdate = true;
    }

    const hover = reducedMotion ? 0 : Math.sin(t * 0.9) * 0.07;
    group.position.set(px, 0, pz);
    mesh.position.y = Math.min(
      height / 2 + 0.2 + enemy.lift + hover + dying * 0.45,
      CEIL_CLEARANCE - height / 2,
    );
    mesh.scale.set(height * aspect, height, 1);
    mat.opacity = (flashing || breathing ? 1 : 0.9) * (1 - dying);

    // The underlight rides the pool, so drive its live spec rather than a
    // light of our own — the enemy lunges, so position tracks per frame.
    //
    // The breath spike is doing real work: the art breathes down and to one
    // side, and the billboard yaws to the camera every frame, so the beam
    // rarely points anywhere meaningful. Flooding the room on that frame sells
    // "it just breathed" from any angle, which aim never could.
    underLight.pos.set(px, 0.35, pz);
    underLight.intensity = (flashing ? 10 : breathing ? 14 : 3.5) * (1 - dying);
  });

  return (
    <group ref={groupRef}>
      <FacingBillboard>
        <mesh ref={meshRef} geometry={planeGeo} material={mat} />
      </FacingBillboard>
    </group>
  );
}

/**
 * All hostile/invader billboards for explored rooms, plus short-lived
 * "ghosts" so a death dissolve still plays after the map poll has already
 * removed the entity from the room.
 */
export default function CrawlerEnemy({ model, queue, reducedMotion }) {
  const texArr = useTexture(ENEMY_SPRITE_URLS);
  const bundles = useMemo(() => {
    const out = {};
    SPRITE_KEYS.forEach((key, i) => {
      const tex = texArr[i];
      out[key] = {
        green: tex,
        red: makeTintVariant(tex.image, 'red'),
        cyan: makeTintVariant(tex.image, 'cyan'),
        aspect: tex.image ? tex.image.width / tex.image.height : 0.7,
      };
    });
    return out;
  }, [texArr]);

  const [ghosts, setGhosts] = useState([]);
  const [deadCount, setDeadCount] = useState(0); // memo invalidation for deadRef
  const deadRef = useRef(new Set());
  const lastSeenRef = useRef(new Map());

  const live = useMemo(() => {
    const out = [];
    const roomCounts = new Map();
    for (const room of model.rooms) {
      for (const e of room.entities) {
        if (e.type !== 'hostile' && e.type !== 'invader') continue;
        if (deadRef.current.has(e.id)) continue;
        const slot = roomCounts.get(room.id) ?? 0;
        roomCounts.set(room.id, slot + 1);
        const enemy = {
          id: e.id,
          name: e.name ?? null,
          roomId: room.id,
          gridX: room.gridX,
          gridY: room.gridY,
          boss: room.type === 'boss_room',
          invader: e.type === 'invader',
          slot,
          count: 1,
        };
        out.push(enemy);
        lastSeenRef.current.set(e.id, enemy);
      }
    }
    for (const enemy of out) enemy.count = roomCounts.get(enemy.roomId) ?? 1;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, deadCount]);

  // Death beats: spawn a ghost if the entity already left the model, and
  // retire the id for good once the dissolve finishes
  useEffect(() => queue.subscribe((event, b) => {
    if (b.kind !== 'death' || b.player) return;
    if (event === 'start') {
      const id = b.entityId;
      if (!id) return;
      const known = lastSeenRef.current.get(id);
      const stillLive = model.rooms.some((r) => r.entities.some((e) => e.id === id));
      if (known && !stillLive && !deadRef.current.has(id)) {
        setGhosts((prev) => (prev.some((g) => g.id === id) ? prev : [...prev, known]));
      }
    } else if (event === 'end') {
      if (b.entityId) {
        deadRef.current.add(b.entityId);
        setDeadCount(deadRef.current.size); // unmount the billboard NOW,
        // not on the next map poll — the beat is over, nothing may linger
      }
      setGhosts((prev) => prev.filter((g) => g.id !== b.entityId));
    }
  }), [queue, model]);

  const enemies = useMemo(() => {
    const ids = new Set(live.map((e) => e.id));
    return [...live, ...ghosts.filter((g) => !ids.has(g.id))];
  }, [live, ghosts]);

  return (
    <group>
      {enemies.map((enemy) => {
        const key = spriteKeyFor(enemy);
        // Registry objects, so the identity is stable across renders and the
        // billboard's texture memo does not thrash.
        const sheet = bossSheetFor(enemy.id);
        return (
          <EnemyBillboard
            key={enemy.id}
            enemy={{
              ...enemy,
              // A sheet boss carries its own lift/lunge. These must NOT go
              // into SPRITE_LIFT/SPRITE_SCALE, which are keyed by sprite key —
              // a sheet boss shares 'wraith' with ordinary mobs, so anything
              // added there would leak onto them.
              sheet,
              lift: sheet?.lift ?? SPRITE_LIFT[key] ?? 0.1,
              lungeScale: sheet?.lunge ?? 1,
              spriteScale: SPRITE_SCALE[key] ?? 1,
            }}
            model={model}
            queue={queue}
            reducedMotion={reducedMotion}
            textures={bundles[key]}
          />
        );
      })}
    </group>
  );
}

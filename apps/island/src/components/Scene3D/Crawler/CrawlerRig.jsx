import { useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { CELL, EYE, cellCenter, idToGrid } from './CrawlerMaze';
import { COLORS } from '../worldUtils';
import { look } from '../look';

// The single queue consumer: calls queue.update(delta) every frame (frame
// clock, no timers) and drives the first-person camera from the beats.
// Rendered first inside the Canvas so every other component reads the
// already-advanced queue state in the same frame.

const COMBAT_BACKOFF = 1.25; // stand back from the cell center when foes wait there
// The light the followed agent carries, at look gain 1. A step up from
// before: the stone has almost no glow of its own now, so this light is
// what shows its relief.
const AGENT_LIGHT = 26;
const AGENT_LIGHT_FLICKER = 8;
const _from = new THREE.Vector3();

function smoothstep(t) {
  const k = Math.min(Math.max(t, 0), 1);
  return k * k * (3 - 2 * k);
}

/** Shortest-arc delta from one yaw to another, in [-PI, PI]. */
function shortestArc(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Yaw that faces a (dx, dz) direction — camera forward is (0,0,-1). */
function yawFor(dx, dz) {
  return Math.atan2(-dx, -dz);
}

export default function CrawlerRig({ model, queue, reducedMotion }) {
  const { camera } = useThree();
  const lightRef = useRef();
  const s = useRef({
    pos: null, // Vector3 — current camera ground position
    yaw: Math.PI, // facing +Z (south) matches the entrance-at-top map layout
    move: null, // { from, to, fromYaw, arc } while a move beat plays
    shakeAmp: 0,
    shakeStart: 0,
    shakeDur: 0,
    mode: 'live', // 'live' | 'dead' | 'victory'
    modeT: 0,
    prevBeat: null,
    lastBeatEnd: 0,
    idle: null, // { start, dur, amp } — an in-flight look-around excursion
    nextIdleAt: 0,
  }).current;

  const roomCenter = (roomId) => {
    const { row, col } = idToGrid(roomId);
    const c = cellCenter(col, row, model);
    return new THREE.Vector3(c.x, 0, c.z);
  };

  const roomHasFoes = (roomId) => {
    const room = model.rooms.find((r) => r.id === roomId);
    return !!room?.entities?.some((e) => e.type === 'hostile' || e.type === 'invader');
  };

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    const current = queue.update(delta); // durScale handles reduced motion
    const progress = queue.progress;

    // Snap to the player's room on the very first frame
    if (!s.pos) {
      const startId = model.playerRoomId ?? model.rooms[0]?.id;
      s.pos = startId ? roomCenter(startId) : new THREE.Vector3();
    }

    // --- beat-start bookkeeping (queue transitions observed in-frame) -----
    if (current !== s.prevBeat) {
      if (!current) s.lastBeatEnd = t;
      s.prevBeat = current;
      if (current) {
        // a beat interrupts any idle look-around
        s.idle = null;
        s.nextIdleAt = t + 5;
      }
      if (current?.kind === 'move' && current.toId) {
        const to = roomCenter(current.toId);
        const dir = to.clone().sub(s.pos);
        if (dir.lengthSq() > 0.001) {
          dir.normalize();
          // stop short of the cell center when enemies hold the room —
          // Grimrock-style face-off framing
          if (roomHasFoes(current.toId)) to.addScaledVector(dir, -COMBAT_BACKOFF);
          s.move = {
            from: s.pos.clone(),
            to,
            fromYaw: s.yaw,
            arc: shortestArc(s.yaw, yawFor(dir.x, dir.z)),
          };
        }
      } else if ((current?.kind === 'damage' && current.player) || current?.kind === 'trap') {
        s.shakeAmp = current.kind === 'trap' ? 0.14 : 0.1;
        s.shakeStart = t;
        s.shakeDur = Math.max(current.dur, 0.2);
      } else if (current?.kind === 'death' && current.player) {
        s.mode = 'dead';
        s.modeT = t;
      } else if (current?.kind === 'victory') {
        s.mode = 'victory';
        s.modeT = t;
      }
    }

    // --- position + yaw -----------------------------------------------------
    let bob = 0;
    if (current?.kind === 'move' && s.move) {
      const k = smoothstep(progress);
      s.pos.lerpVectors(s.move.from, s.move.to, k);
      // turn during the first 40% of the step, then walk it out
      const turnK = smoothstep(Math.min(progress / 0.4, 1));
      s.yaw = s.move.fromYaw + s.move.arc * turnK;
      if (!reducedMotion) bob = Math.sin(progress * Math.PI * 4) * 0.05;
    } else {
      s.move = null;
      // idle: converge on the model's ground-truth player room (covers
      // snap-to-latest mounts and any beats lost to gap snaps)
      if (model.playerRoomId && queue.size === 0 && t - s.lastBeatEnd > 1.5) {
        _from.copy(roomCenter(model.playerRoomId));
        if (roomHasFoes(model.playerRoomId)) {
          const back = s.pos.clone().sub(_from);
          if (back.lengthSq() > 0.01) _from.addScaledVector(back.normalize(), Math.min(COMBAT_BACKOFF, CELL / 2 - 0.5));
        }
        s.pos.lerp(_from, reducedMotion ? 1 : 1 - Math.exp(-delta * 3));
      }
    }

    // --- idle life: breathing + occasional look-around ----------------------
    let breath = 0;
    let breathRoll = 0;
    let idleYaw = 0;
    if (!reducedMotion && s.mode === 'live') {
      breath = Math.sin(t * 1.4) * 0.02;
      breathRoll = Math.sin(t * 0.9) * 0.004;
      if (!s.idle && !current && queue.size === 0
        && t - s.lastBeatEnd > 4 && t > s.nextIdleAt) {
        s.idle = {
          start: t,
          dur: 2.2 + Math.random() * 1.2,
          amp: (Math.random() < 0.5 ? -1 : 1) * (0.12 + Math.random() * 0.16),
        };
      }
      if (s.idle) {
        const k = (t - s.idle.start) / s.idle.dur;
        if (k >= 1) {
          s.idle = null;
          s.nextIdleAt = t + 5 + Math.random() * 5;
        } else {
          // glance out and back — sine envelope keeps both ends gentle
          idleYaw = s.idle.amp * Math.sin(Math.PI * k);
        }
      }
    }

    // --- player attack: step in with the swing -------------------------------
    let lungeX = 0;
    let lungeZ = 0;
    let lungePitch = 0;
    if (!reducedMotion && current?.kind === 'attack' && current.byPlayer) {
      const surge = Math.sin(progress * Math.PI);
      lungeX = -Math.sin(s.yaw) * surge * 0.3;
      lungeZ = -Math.cos(s.yaw) * surge * 0.3;
      lungePitch = -surge * 0.05;
    }

    // --- shake / death / victory offsets -------------------------------------
    let shakeX = 0;
    let shakeY = 0;
    let roll = 0;
    let pitch = 0;
    let eyeY = EYE;

    const shakeAge = t - s.shakeStart;
    if (!reducedMotion && s.shakeAmp > 0 && shakeAge < s.shakeDur) {
      const decay = 1 - shakeAge / s.shakeDur;
      shakeX = (Math.random() - 0.5) * 2 * s.shakeAmp * decay;
      shakeY = (Math.random() - 0.5) * 2 * s.shakeAmp * decay;
    }

    if (s.mode === 'dead') {
      // camera crumples to the floor and rolls over
      const k = smoothstep(Math.min((t - s.modeT) / 1.2, 1));
      eyeY = EYE - (EYE - 0.35) * k;
      roll = 0.9 * k;
      pitch = 0.25 * k;
    } else if (s.mode === 'victory') {
      // slow triumphant rise (staying under the ceiling), gaze dipping
      // back over the conquered floor
      const k = smoothstep(Math.min((t - s.modeT) / 3, 1));
      eyeY = EYE + 0.9 * k;
      pitch = -0.4 * k;
    }

    camera.rotation.order = 'YXZ';
    camera.position.set(
      s.pos.x + shakeX + lungeX,
      eyeY + bob + breath + shakeY,
      s.pos.z + lungeZ,
    );
    camera.rotation.set(pitch + lungePitch, s.yaw + idleYaw, roll + breathRoll);
    // FacingBillboard reads this base yaw instead of the camera's full
    // rotation — idle sway/look-around is a camera-only flourish and must
    // not leak into "face the camera" billboards (enemies, rivals), or an
    // engaged enemy visibly swings with every idle glance.
    camera.userData.crawlerBaseYaw = s.yaw;

    // --- player torch: flickering point light riding the camera --------------
    const light = lightRef.current;
    if (light) {
      light.position.set(s.pos.x, eyeY + 0.3, s.pos.z);
      const flicker = reducedMotion
        ? 0
        : Math.sin(t * 11) * 0.18 + Math.sin(t * 23 + 1.7) * 0.12;
      light.intensity = (AGENT_LIGHT + flicker * AGENT_LIGHT_FLICKER) * look.dungeonAgentLight;
    }
  });

  return (
    <pointLight
      ref={lightRef}
      color={COLORS.wire}
      intensity={AGENT_LIGHT}
      distance={CELL * 4.5}
      decay={1.6}
    />
  );
}

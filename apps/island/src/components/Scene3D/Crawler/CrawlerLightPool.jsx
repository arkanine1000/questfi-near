import {
  createContext, useContext, useEffect, useId, useMemo, useRef,
} from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { CELL } from './CrawlerMaze';

/**
 * A fixed-size pool of point lights, reassigned each tick to whichever room
 * lights are actually visible.
 *
 * WHY A POOL, and not simply mounting a light per prop: three.js bakes the
 * scene's point-light count into the shader program cache key, so every
 * change in that count recompiles every material in the scene. Mounting and
 * unmounting lights as the player walks — the obvious way to cull — would
 * therefore cause a compile hitch on essentially every step, which is worse
 * than the problem it set out to solve.
 *
 * So the slots are mounted once and never unmounted. Culling changes which
 * light a slot *represents*, never how many exist. Unused slots sit at
 * intensity 0. Light count is constant for the lifetime of the scene, so
 * the shader programs compile once.
 *
 * Consumers don't render lights at all; they declare a request with
 * useRoomLight() and the pool decides who gets a slot.
 */

const LightPoolContext = createContext(null);

export const LIGHT_PRIORITY = {
  // Functional markers outrank ambience: a chest in the room you're standing
  // in must never lose its slot to a decorative torch two rooms away.
  prop: 2,
  ambience: 1,
};

// Past this a light contributes nothing worth a slot. The scene fog is
// [2, 22] world units (CrawlerScene) and the player's own torch already
// falls off at CELL * 4.5, so a light beyond ~4.5 rooms is invisible by
// construction rather than by choice.
const MAX_DIST = CELL * 4.5;

// Half-angle of the "player can see it" cone. The camera runs at fov 90, so
// 75 gives 30 degrees of margin either side — lights fade up before they
// enter frame instead of popping in at the screen edge.
const FACING_COS = Math.cos(THREE.MathUtils.degToRad(75));

// Inside this radius the facing test is skipped. A light essentially on top
// of the camera would otherwise snap off the instant you turn past it, which
// reads far worse than the cost of keeping it.
const NEAR_RADIUS = CELL * 0.75;

const SELECT_HZ = 10; // slot assignment; flicker still runs every frame

/**
 * Declare a light. The pool grants it a slot when it's close enough and in
 * front of the camera, ranked against every other request.
 *
 * Position is world-space. `flicker` is an amplitude in intensity units —
 * the pool animates it so callers don't need their own useFrame.
 *
 * Returns the live spec. Callers whose light MOVES or changes brightness
 * (enemies lunging, rival agents walking) mutate `spec.pos` / `spec.intensity`
 * from their own useFrame; the pool reads both every frame, so a bound slot
 * tracks them exactly.
 */
export function useRoomLight({
  x, y, z, color, intensity, distance, decay = 2,
  priority = LIGHT_PRIORITY.prop, flicker = 0, enabled = true,
}) {
  const api = useContext(LightPoolContext);
  const id = useId();

  const spec = useMemo(() => ({
    id,
    pos: new THREE.Vector3(x, y, z),
    color: new THREE.Color(color),
    intensity,
    distance,
    decay,
    priority,
    flicker,
    // Deterministic per-light phase so neighbouring torches never pulse in
    // unison. Same sin-hash trick as TerrainProps' hash01.
    phase: (() => {
      let h = 0;
      for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 9973;
      const v = Math.sin(h * 12.9898) * 43758.5453;
      return (v - Math.floor(v)) * Math.PI * 2;
    })(),
  }), [id, x, y, z, color, intensity, distance, decay, priority, flicker]);

  useEffect(() => {
    if (!api || !enabled) return undefined;
    api.register(spec);
    return () => api.unregister(spec.id);
  }, [api, spec, enabled]);

  return spec;
}

/**
 * Mounts the slots and owns selection. Must wrap every component that calls
 * useRoomLight.
 */
export default function CrawlerLightPool({ children, slots = 6, reducedMotion = false }) {
  const registry = useRef(new Map());
  const slotRefs = useRef([]);
  const bound = useRef([]); // slot index -> spec currently driving it
  const acc = useRef(Infinity); // force a selection pass on the first frame

  const api = useMemo(() => ({
    register: (spec) => registry.current.set(spec.id, spec),
    unregister: (id) => registry.current.delete(id),
  }), []);

  const scratch = useMemo(() => ({
    forward: new THREE.Vector3(),
    toLight: new THREE.Vector3(),
    visible: [],
  }), []);

  useFrame(({ camera, clock }, delta) => {
    acc.current += delta;

    if (acc.current >= 1 / SELECT_HZ) {
      acc.current = 0;

      // The rig rotates the camera IN PLACE for idle sway and look-around
      // beats, so the facing test reads the rig's BASE yaw rather than the
      // camera's live rotation — exactly as FacingBillboard does. Testing
      // live rotation would flicker torches on and off during an idle
      // glance, with no player input at all.
      const yaw = camera.userData.crawlerBaseYaw ?? camera.rotation.y;
      scratch.forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));

      const visible = scratch.visible;
      visible.length = 0;

      for (const spec of registry.current.values()) {
        scratch.toLight.subVectors(spec.pos, camera.position);
        const dist = scratch.toLight.length();
        if (dist > MAX_DIST) continue;
        if (dist > NEAR_RADIUS) {
          scratch.toLight.y = 0;
          scratch.toLight.normalize();
          if (scratch.toLight.dot(scratch.forward) < FACING_COS) continue;
        }
        visible.push({ spec, dist });
      }

      // Priority tier first, then proximity within a tier.
      visible.sort((a, b) => (
        b.spec.priority - a.spec.priority || a.dist - b.dist
      ));

      for (let i = 0; i < slots; i += 1) {
        const light = slotRefs.current[i];
        const entry = visible[i];
        if (!light) continue;
        if (!entry) {
          bound.current[i] = null;
          light.intensity = 0;
          continue;
        }
        const { spec } = entry;
        bound.current[i] = spec;
        light.color.copy(spec.color);
        light.distance = spec.distance;
        light.decay = spec.decay;
      }
    }

    // Position, brightness and flicker track every frame on whatever is
    // currently bound. The 10Hz selection cadence is fine for deciding WHO
    // gets a slot, but a moving light bound at 10Hz visibly stutters, and
    // flicker would go steppy.
    const t = clock.elapsedTime;
    for (let i = 0; i < slots; i += 1) {
      const light = slotRefs.current[i];
      const spec = bound.current[i];
      if (!light || !spec) continue;
      light.position.copy(spec.pos);
      if (reducedMotion || !spec.flicker) {
        light.intensity = spec.intensity;
      } else {
        const f = Math.sin(t * 11 + spec.phase) * 0.6
          + Math.sin(t * 23 + spec.phase * 1.7) * 0.4;
        light.intensity = Math.max(0, spec.intensity + f * spec.flicker);
      }
    }
  });

  return (
    <LightPoolContext.Provider value={api}>
      {Array.from({ length: slots }, (unused, i) => (
        <pointLight
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          ref={(el) => {
            slotRefs.current[i] = el;
            // Lets scripts/pw-crawler.mjs tell pool slots from the rig's
            // own key light when it audits the budget.
            if (el) el.userData.poolSlot = true;
          }}
          intensity={0}
          distance={MAX_DIST}
          decay={2}
        />
      ))}
      {children}
    </LightPoolContext.Provider>
  );
}

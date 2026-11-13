import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useLoader } from '@react-three/fiber';
import { WEAPON_PALETTE_URL, loaderFor, weaponModelUrl, weaponSpecFor } from './weaponCatalog';
import {
  bellowsIdleAngle, bellowsPlayAngle, pumpBellows, rigBellows,
} from './weaponRigs';
import { COLORS } from '../worldUtils';

// First-person weapon viewmodel: a lag-following group that trails the
// camera (R3F's default camera lives outside the scene graph, so a
// useFrame follow-group beats parenting — and the lag reads as organic
// sway). Mounted AFTER CrawlerRig so it samples the post-rig camera
// transform in the same frame.

const HOLD_OFFSET = [0.56, -0.42, -0.62]; // right-low, clear of the thought toasts
const HOLD_ROTATION = [-0.3, -0.35, -0.12]; // pitch back, yaw inward, slight roll
// Weapons may carry their own `hold` (see weaponCatalog); this is the blade default.
const DEFAULT_HOLD = { offset: HOLD_OFFSET, rotation: HOLD_ROTATION };

function smoothstep(t) {
  const k = Math.min(Math.max(t, 0), 1);
  return k * k * (3 - 2 * k);
}

/** Piecewise slash arc keyed on beat progress: windup, cut, recover. */
function slashPose(p, out) {
  if (p < 0.25) {
    const k = smoothstep(p / 0.25);
    out.rotX = 0.45 * k; // raise
    out.rotZ = 0.15 * k;
  } else if (p < 0.6) {
    const k = smoothstep((p - 0.25) / 0.35);
    out.rotX = 0.45 - 1.35 * k; // cut down-across
    out.rotZ = 0.15 - 0.75 * k;
    out.posY = -0.08 * k;
  } else {
    const k = smoothstep((p - 0.6) / 0.4);
    out.rotX = -0.9 * (1 - k);
    out.rotZ = -0.6 * (1 - k);
    out.posY = -0.08 * (1 - k);
  }
}

/** Stab thrust for daggers/spears/casters: forward jab with a dip. */
function stabPose(p, out) {
  const k = Math.sin(Math.min(p, 1) * Math.PI);
  out.posZ = -0.34 * k;
  out.rotX = -0.18 * k;
}

/**
 * Playing, not swinging: the instrument is shoved out and lifted on the
 * downbeat while the rig does the squeezing. Deliberately small — the
 * bellows deform is the animation, this only sells the intent.
 */
function playPose(p, out) {
  const k = Math.sin(Math.min(p, 1) * Math.PI);
  out.posZ = -0.1 * k;
  out.posY = 0.05 * k;
  out.rotX = -0.12 * k;
  out.rotZ = 0.08 * Math.sin(Math.min(p, 1) * Math.PI * 2);
}

/** Parry on an enemy miss: blade whips horizontal across the view. */
function blockPose(p, out) {
  const k = Math.sin(Math.min(p, 1) * Math.PI);
  out.rotZ = -1.3 * k;
  out.posX = -0.22 * k;
  out.posY = 0.1 * k;
  out.posZ = 0.06 * k;
}

/** Load a weapon spec's model, unwrapping whichever loader it needed. */
function useWeaponModel(spec) {
  const asset = useLoader(loaderFor(spec), weaponModelUrl(spec));
  // GLTFLoader hands back a document; FBXLoader hands back the object.
  return asset.scene ?? asset;
}

function WeaponModel({ spec, tint }) {
  const model = useWeaponModel(spec);
  const palette = useLoader(THREE.TextureLoader, WEAPON_PALETTE_URL);

  const template = useMemo(() => {
    palette.colorSpace = THREE.SRGBColorSpace;
    // Sandbox tint must be EXACT: the palette texture multiplies the color
    // and ACES tone mapping shifts hues, so the tinted path drops both —
    // an emissive-dominant, tone-mapping-exempt material reads as the
    // agent's true color, with the darkened base catching torch light for
    // form. The legacy holo-green path keeps the palette look untouched.
    // Both paths render slightly translucent — a viewmodel that reads as a
    // light-construct hologram, not a slab of opaque plastic. depthWrite
    // stays ON so the weapon's own overlapping parts occlude correctly;
    // only the world behind bleeds through.
    const mat = tint
      ? new THREE.MeshStandardMaterial({
        color: new THREE.Color(tint).multiplyScalar(0.25),
        emissive: new THREE.Color(tint),
        emissiveIntensity: 0.9,
        roughness: 0.6,
        metalness: 0.1,
        toneMapped: false,
        transparent: true,
        opacity: 0.72,
      })
      : new THREE.MeshStandardMaterial({
        map: palette,
        color: COLORS.fill,
        emissive: COLORS.deep,
        emissiveMap: palette,
        emissiveIntensity: 0.24, // a touch brighter to sell the holo look
        roughness: 0.82,
        metalness: 0.05,
        transparent: true,
        opacity: 0.78,
      });
    const root = model.clone(true);
    root.traverse((child) => {
      if (child.isMesh) child.material = mat;
    });

    // Normalize: dominant axis -> +Y, sized to spec.length, grip-ish origin
    const wrapper = new THREE.Group();
    wrapper.add(root);
    const dims = new THREE.Vector3();
    new THREE.Box3().setFromObject(root).getSize(dims);
    if (dims.x >= dims.y && dims.x >= dims.z) root.rotation.set(0, 0, Math.PI / 2);
    else if (dims.z >= dims.y && dims.z >= dims.x) root.rotation.set(-Math.PI / 2, 0, 0);

    const box = new THREE.Box3().setFromObject(wrapper);
    box.getSize(dims);
    const scale = spec.length / Math.max(dims.y, 0.0001);
    wrapper.scale.setScalar(scale);

    const scaled = new THREE.Box3().setFromObject(wrapper);
    wrapper.position.set(
      -(scaled.min.x + scaled.max.x) / 2,
      -scaled.min.y - (scaled.max.y - scaled.min.y) * 0.28, // hand ~28% up
      -(scaled.min.z + scaled.max.z) / 2,
    );
    const holder = new THREE.Group();
    holder.add(wrapper);
    // spin 90° CCW around the blade's own long axis so the crossguard
    // runs parallel to the camera plane (we see the flat of the blade)
    holder.rotation.y = Math.PI / 2;
    return holder;
  }, [model, palette, spec, tint]);

  return <primitive object={template} />;
}

/**
 * A weapon with its own hold transform and a deform rig, animated per frame.
 *
 * Self-contained on purpose: it owns the deform loop so the shared
 * camera-follow group above stays untouched, and it never reads the palette
 * texture — the accordion GLB ships no UVs, so a mapped material would
 * sample one corner of the atlas across the whole instrument.
 */
function RiggedWeaponModel({ spec, tint, queue, reducedMotion }) {
  const model = useWeaponModel(spec);
  const settledRef = useRef(false);

  // Object and rig are built together and returned together: the rig holds
  // references into this clone's vertex buffers, so anything that rebuilds
  // one has to rebuild the other or the deform drives a discarded model.
  const { object, rig } = useMemo(() => {
    const base = new THREE.Color(tint || COLORS.greenBright);
    const mat = new THREE.MeshStandardMaterial({
      color: base.clone().multiplyScalar(0.25),
      emissive: base,
      emissiveIntensity: 0.9,
      roughness: 0.6,
      metalness: 0.1,
      toneMapped: false,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide, // the bellows fan is single-sided sheet geometry
    });
    const root = model.clone(true);
    root.traverse((child) => {
      if (child.isMesh) child.material = mat;
    });

    // Rig before parenting: the deform rebases through inv(matrixWorld), so
    // it has to measure the model's own local frame, not the hold transform.
    const built = rigBellows(root);

    const wrapper = new THREE.Group();
    wrapper.add(root);
    wrapper.scale.setScalar(spec.hold.scale);
    const scaled = new THREE.Box3().setFromObject(wrapper);
    wrapper.position.set(
      -(scaled.min.x + scaled.max.x) / 2,
      -(scaled.min.y + scaled.max.y) / 2,
      -(scaled.min.z + scaled.max.z) / 2,
    );
    return { object: wrapper, rig: built };
  }, [model, spec, tint]);

  useFrame(({ clock }) => {
    if (reducedMotion) {
      // Settle to rest once, then leave it alone.
      if (!settledRef.current) {
        pumpBellows(rig, 0);
        settledRef.current = true;
      }
      return;
    }
    settledRef.current = false;
    const beat = queue.current;
    // Playing is a whole-beat animation; anything else breathes. Both are
    // pure functions of the current frame, so a dropped attack beat just
    // means the next frame breathes again — never a bellows stuck folded.
    const playing = beat?.kind === 'attack' && beat.byPlayer;
    pumpBellows(
      rig,
      playing ? bellowsPlayAngle(queue.progress) : bellowsIdleAngle(clock.elapsedTime),
    );
  });

  return <primitive object={object} />;
}

export default function CrawlerWeapon({ queue, weaponName, reducedMotion, tint = null }) {
  const spec = useMemo(() => weaponSpecFor(weaponName), [weaponName]);
  const hold = spec.hold ?? DEFAULT_HOLD;
  const followRef = useRef();
  const animRef = useRef();
  const initRef = useRef(false);
  const pose = useRef({ rotX: 0, rotZ: 0, posX: 0, posY: 0, posZ: 0 }).current;

  useFrame(({ camera, clock }, delta) => {
    const follow = followRef.current;
    const anim = animRef.current;
    if (!follow || !anim) return;

    // Lag-follow the camera (snap on the first frame)
    if (!initRef.current) {
      follow.position.copy(camera.position);
      follow.quaternion.copy(camera.quaternion);
      initRef.current = true;
    } else {
      const k = 1 - Math.exp(-delta * 25);
      follow.position.lerp(camera.position, k);
      follow.quaternion.slerp(camera.quaternion, k);
    }

    // Idle sway + move bob + attack animation, all local to the hold point
    const t = clock.elapsedTime;
    const beat = queue.current;
    const progress = queue.progress;

    pose.rotX = 0;
    pose.rotZ = 0;
    pose.posX = 0;
    pose.posY = 0;
    pose.posZ = 0;
    if (!reducedMotion) {
      pose.posY += Math.sin(t * 1.7) * 0.006;
      pose.rotZ += Math.sin(t * 0.9) * 0.012;
      if (beat?.kind === 'move') {
        pose.posY += Math.sin(progress * Math.PI * 4) * 0.02;
        pose.posZ += Math.sin(progress * Math.PI * 2) * -0.02;
      }
      if (beat?.kind === 'attack') {
        if (beat.byPlayer) {
          // A rigged weapon animates itself — the accordion is played, not
          // swung, so it gets a shove forward instead of an arc.
          if (spec.rig) playPose(progress, pose);
          else (spec.kind === 'stab' ? stabPose : slashPose)(progress, pose);
        } else if (!beat.hit) {
          blockPose(progress, pose); // enemy swings, the blade turns it away
        }
      }
    }
    anim.position.set(
      hold.offset[0] + pose.posX,
      hold.offset[1] + pose.posY,
      hold.offset[2] + pose.posZ,
    );
    anim.rotation.set(
      hold.rotation[0] + pose.rotX,
      hold.rotation[1],
      hold.rotation[2] + pose.rotZ,
    );
  });

  return (
    <group ref={followRef}>
      <group ref={animRef} position={hold.offset} rotation={hold.rotation}>
        {spec.rig ? (
          <RiggedWeaponModel
            spec={spec}
            tint={tint}
            queue={queue}
            reducedMotion={reducedMotion}
          />
        ) : (
          <WeaponModel spec={spec} tint={tint} />
        )}
      </group>
    </group>
  );
}

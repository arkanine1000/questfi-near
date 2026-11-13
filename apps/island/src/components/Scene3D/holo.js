import * as THREE from 'three';
import { COLORS } from './worldUtils';

/**
 * The house hologram recipe shared with the start app and Agent World
 * (apps/start/src/holo.js): a dark emissive fill under a bright wireframe.
 *
 * `intensity` scales with how much of the frame a subject covers; the
 * island's small relics and creatures run a weak fill so the wire carries
 * them and the land stays mostly black.
 */
export function holoFillMaterial(tint = COLORS.fill, { intensity = 0.3, base = 0.18 } = {}) {
  const t = new THREE.Color(tint);
  return new THREE.MeshStandardMaterial({
    color: t.clone().multiplyScalar(base),
    emissive: t,
    emissiveIntensity: intensity,
    roughness: 0.45,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });
}

/**
 * The bright wireframe overlay. It draws on the same geometry as the fill,
 * so it does not write depth (the fill already did) and is never tone
 * mapped.
 */
export function holoWireMaterial(tint = COLORS.wire, opacity = 0.35) {
  return new THREE.MeshBasicMaterial({
    color: tint,
    wireframe: true,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

const GREEN = new THREE.Color(COLORS.green);
const BRIGHT = new THREE.Color(COLORS.bright);

/** A wire tint on the house ramp: t = 0 is the house green, 1 the bright green. */
export function holoRamp(t, intensity = 1, out = new THREE.Color()) {
  return out.copy(GREEN).lerp(BRIGHT, t).multiplyScalar(intensity);
}

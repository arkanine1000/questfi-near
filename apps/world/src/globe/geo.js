import * as THREE from 'three';
import { GLOBE } from '../config.js';

// Planet math. The city is the fixed point: world origin, meters, y up, north
// toward −Z, east toward +X. The planet hangs under it, center (0, −R, 0).
//
// "Geo space" is an Earth-fixed frame: unit vectors with +Y through the north
// pole, lon 0 on +X, lon +90°E on −Z. `GEO` maps a world-aligned direction
// (from the planet center) into geo space; its transpose goes back. Site 0 —
// the city — is pinned to world +Y with its north on −Z.

export const R = GLOBE.radius;
export const CENTER = new THREE.Vector3(0, -R, 0);
const DEG = Math.PI / 180;

export function geoDir(latDeg, lonDeg, out = new THREE.Vector3()) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return out.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
}

// columns: east, up, south (geo-space vectors at the site) — so GEO·(1,0,0)
// is east, GEO·(0,1,0) up, GEO·(0,0,1) south: world → geo.
function frameAt(lat, lon) {
  const up = geoDir(lat, lon);
  const east = new THREE.Vector3(-Math.sin(lon * DEG), 0, -Math.cos(lon * DEG));
  const south = new THREE.Vector3().crossVectors(east, up);
  return new THREE.Matrix3().set(
    east.x, up.x, south.x,
    east.y, up.y, south.y,
    east.z, up.z, south.z,
  );
}

const home = GLOBE.sites[0];
export const GEO = frameAt(home.lat, home.lon);               // world → geo
export const GEO_T = GEO.clone().transpose();                  // geo → world
export const GEO_T4 = new THREE.Matrix4().setFromMatrix3(GEO_T);

// world-space unit "up" (from the planet center) of a lat/lon
export function worldDir(latDeg, lonDeg, out = new THREE.Vector3()) {
  return geoDir(latDeg, lonDeg, out).applyMatrix3(GEO_T).normalize();
}
// the geographic north axis in world space (for the idle spin)
export const NORTH_AXIS = new THREE.Vector3(0, 1, 0).applyMatrix3(GEO_T).normalize();

// altitude above the sphere, exact enough in doubles at any distance
export function altitudeOf(p) {
  const y = p.y + R;
  return Math.sqrt(p.x * p.x + y * y + p.z * p.z) - R;
}

// the world point of a site-local (x, z) on the ground — site 0 is the city,
// so for it this is just (x, ~0, z) bent by curvature
export function upAt(x, z, out = new THREE.Vector3()) {
  return out.set(x, R, z).normalize();
}

// fades
const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const fadeIn = ([a, b], h) => sstep(a, b, h);
export const fadeOut = ([a, b], h) => 1 - sstep(a, b, h);
export { sstep };

export function bandOf(h) {
  const b = GLOBE.bands;
  if (h < b.street) return 'STREET';
  if (h < b.city) return 'CITY';
  if (h < b.regional) return 'REGIONAL';
  return 'ORBITAL';
}

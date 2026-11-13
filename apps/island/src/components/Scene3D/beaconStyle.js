/**
 * Shared agent-beacon style — single source of truth for the marker +
 * light-beam visual used on BOTH the island war table and the dungeon
 * projection. Critical cohesion rule (Phase 7): the dot on the island and
 * the dot in the dungeon must read as the same beacon.
 */
import * as THREE from 'three';

export const BEACON = {
  markerRadius: 0.09,
  markerAltitude: 0.35, // float height above the surface
  bobAmplitude: 0.02,
  bobSpeed: 1.6,
  spinSpeed: 0.6,
  beamRadius: 0.022,
  beamOpacity: 0.15,
};

export function makeMarkerGeometry() {
  return new THREE.OctahedronGeometry(BEACON.markerRadius);
}

/** Base-anchored unit-height beam; scale Y to stretch surface -> marker. */
export function makeBeamGeometry() {
  const geo = new THREE.CylinderGeometry(BEACON.beamRadius, BEACON.beamRadius, 1, 6, 1, true);
  geo.translate(0, 0.5, 0);
  return geo;
}

/**
 * Flat hexagonal outline lying in the XZ plane, pointy-top like the grid
 * cells (HexGrid3D), between radius `inner` and `outer`. Used for the tile an
 * agent stands on and for the focus ring around the followed agent.
 */
export function makeHexOutlineGeometry(outer, inner) {
  const corners = (radius) => {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      pts.push(new THREE.Vector2(radius * Math.cos(a), radius * Math.sin(a)));
    }
    return pts;
  };
  const shape = new THREE.Shape(corners(outer));
  shape.holes.push(new THREE.Path(corners(inner).reverse()));
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

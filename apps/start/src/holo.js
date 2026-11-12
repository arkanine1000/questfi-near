import * as THREE from 'three';

// The house hologram look, ported from questfi-lobby / agent_world: a dark
// emissive fill plus a bright wireframe overlay.

export const WIRE_TRI_LIMIT = 120_000;

export function holoFillMaterial(tint = 0x1fd465, { intensity = 0.3, base = 0.18 } = {}) {
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

export function holoWireMaterial(tint = 0x49ff8c, opacity = 0.35) {
  return new THREE.MeshBasicMaterial({ color: tint, wireframe: true, transparent: true, opacity });
}

function triCount(geometry) {
  return geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
}

export function applyHoloToMesh(mesh, fillMat, wireMat) {
  mesh.material = fillMat;
  if (triCount(mesh.geometry) < WIRE_TRI_LIMIT) mesh.add(new THREE.Mesh(mesh.geometry, wireMat));
}

// Skinned meshes get a second SkinnedMesh bound to the same skeleton so the
// wire overlay deforms with the animation.
// Dense rigs want a weaker fill and wire, or bloom washes the detail out.
export function applyHoloToRig(rig, tint, { intensity = 0.3, wire = 0.35 } = {}) {
  const fillMat = holoFillMaterial(tint, { intensity });
  const wireMat = holoWireMaterial(tint, wire);
  const skinned = [];
  const statics = [];
  rig.traverse((o) => {
    if (o.isSkinnedMesh) skinned.push(o);
    else if (o.isMesh) statics.push(o);
  });
  statics.forEach((o) => applyHoloToMesh(o, fillMat, wireMat));
  for (const sm of skinned) {
    sm.material = fillMat;
    sm.frustumCulled = false;
    if (triCount(sm.geometry) >= WIRE_TRI_LIMIT) continue;
    const wire = new THREE.SkinnedMesh(sm.geometry, wireMat);
    wire.bind(sm.skeleton, sm.bindMatrix);
    wire.bindMode = sm.bindMode;
    wire.frustumCulled = false;
    wire.position.copy(sm.position);
    wire.quaternion.copy(sm.quaternion);
    wire.scale.copy(sm.scale);
    sm.parent.add(wire);
  }
  return { fillMat, wireMat };
}

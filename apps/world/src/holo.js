import * as THREE from 'three';

// The lobby's hologram look, packaged for the newer worlds: a dark emissive
// fill plus a bright wireframe overlay (see exhibits.js, where the style was
// born). Tinted variants keep per-character colors while staying on-vibe.

export const WIRE_TRI_LIMIT = 120_000; // same guard as the exhibits

// `intensity` scales with subject size: exhibit-strength glow (0.3) turns a
// building-sized mesh into neon soup — big structures want 0.05-ish and let
// the wireframe carry the look.
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
  return new THREE.MeshBasicMaterial({
    color: tint,
    wireframe: true,
    transparent: true,
    opacity,
  });
}

function triCount(geometry) {
  return geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
}

// Static meshes: hang the wireframe copy off the mesh itself, exhibits-style.
export function applyHoloToMesh(mesh, fillMat, wireMat) {
  mesh.material = fillMat;
  if (triCount(mesh.geometry) < WIRE_TRI_LIMIT) {
    mesh.add(new THREE.Mesh(mesh.geometry, wireMat));
  }
}

// Skinned meshes: a plain child mesh would freeze in the bind pose, so the
// overlay is a second SkinnedMesh bound to the SAME skeleton — it deforms in
// lockstep with the animation.
export function applyHoloToRig(rig, tint) {
  const fillMat = holoFillMaterial(tint);
  const wireMat = holoWireMaterial(tint);
  const skinned = [];
  rig.traverse((o) => {
    if (o.isSkinnedMesh) skinned.push(o);
    else if (o.isMesh) applyHoloToMesh(o, fillMat, wireMat);
  });
  for (const sm of skinned) {
    sm.material = fillMat;
    sm.frustumCulled = false;
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

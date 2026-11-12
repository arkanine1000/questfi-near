import * as THREE from 'three';
import { VENUES, CITY } from './config.js';
import { makeSignTexture } from './textures.js';
import { holoFillMaterial, holoWireMaterial, applyHoloToMesh } from './holo.js';
import { makeBeacon, makeRing, css } from './sprites.js';
import { createFader } from './fade.js';

// Venues: the lobby's games, anchored to city landmarks. Each one gets a
// portal pad on the sidewalk at the building's door (click it in flight,
// or follow an agent onto it in POV), a plaque, a beacon, and a big holo
// icon hovering over the roof so it reads from across town — crossed
// swords for the arena, a fan of cards for the card room, a checkered flag
// for the speedway. Agents put venues on their errand lists too.

export function createVenues(scene, nav) {
  const group = new THREE.Group();
  scene.add(group);
  const world = { group, list: [], pickables: [] };

  const downtown = new THREE.Vector3(CITY.downtown.x, 0, CITY.downtown.z);
  const edgeLine = new THREE.LineBasicMaterial({ color: 0xdfffe8, transparent: true, opacity: 0.6 });

  // --- icon builders --------------------------------------------------------
  function holoify(root, tint) {
    const fill = holoFillMaterial(tint, { intensity: 0.55, base: 0.25 });
    const wire = holoWireMaterial(0xffffff, 0.35);
    const meshes = [];
    root.traverse((o) => { if (o.isMesh && !o.userData.keepMaterial) meshes.push(o); });
    meshes.forEach((m) => applyHoloToMesh(m, fill, wire));
    return root;
  }

  function swords(tint) {
    const g = new THREE.Group();
    for (const s of [-1, 1]) {
      const sword = new THREE.Group();
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.6, 0.04), new THREE.MeshBasicMaterial());
      blade.position.y = 0.9;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.35, 4), new THREE.MeshBasicMaterial());
      tip.position.y = 2.37;
      tip.rotation.y = Math.PI / 4;
      const guard = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.12, 0.12), new THREE.MeshBasicMaterial());
      guard.position.y = -0.4;
      const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.7, 8), new THREE.MeshBasicMaterial());
      grip.position.y = -0.8;
      const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), new THREE.MeshBasicMaterial());
      pommel.position.y = -1.2;
      sword.add(blade, tip, guard, grip, pommel);
      sword.rotation.z = s * 0.6;
      g.add(sword);
    }
    return holoify(g, tint);
  }

  function cardFace(rank, suit, red) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 360;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#7fb896'; // muted, or the bloom pass turns the fan into a white blob
    ctx.fillRect(0, 0, 256, 360);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, 244, 348);
    ctx.fillStyle = red ? '#c8262f' : '#06110b';
    ctx.font = '700 72px "Chakra Petch", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(rank, 20, 14);
    ctx.font = '700 60px serif';
    ctx.fillText(suit, 22, 86);
    ctx.font = '700 190px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(suit, 128, 200);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
  }

  function cards(tint) {
    const g = new THREE.Group();
    const faces = [['A', '♠', false], ['K', '♥', true], ['Q', '♣', false]];
    faces.forEach(([r, s, red], i) => {
      const card = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.83), cardFace(r, s, red));
      card.userData.keepMaterial = true;
      const a = (i - 1) * 0.38;
      card.rotation.z = -a;
      card.position.set(Math.sin(a) * 1.1, Math.cos(a) * 0.3 - 0.3, i * 0.03);
      card.add(new THREE.LineSegments(new THREE.EdgesGeometry(card.geometry), edgeLine));
      g.add(card);
    });
    // a stack of chips under the fan
    for (let i = 0; i < 4; i++) {
      const chip = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.1, 24), new THREE.MeshBasicMaterial());
      chip.position.set(-1.4 + i * 0.08, -1.45 + i * 0.11, 0.2);
      g.add(chip);
    }
    return holoify(g, tint);
  }

  function flag(tint) {
    const g = new THREE.Group();
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 160;
    const ctx = c.getContext('2d');
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 8; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#9fd4b4' : '#06110b';
        ctx.fillRect(x * 32, y * 32, 32, 32);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.6, 12, 6), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    cloth.userData.keepMaterial = true;
    cloth.position.set(1.35, 1.0, 0);
    cloth.userData.wave = true;
    g.add(cloth);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.4, 8), new THREE.MeshBasicMaterial());
    pole.position.y = 0.2;
    g.add(pole);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), new THREE.MeshBasicMaterial());
    knob.position.y = 1.95;
    g.add(knob);
    return holoify(g, tint);
  }

  // Agent Island: a hex tile with three peaks, the island game's own motif
  function island(tint) {
    const g = new THREE.Group();
    const tile = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.35, 6), new THREE.MeshBasicMaterial());
    g.add(tile);
    for (const [x, z, r, h] of [[-0.45, 0.1, 0.5, 1.5], [0.4, -0.25, 0.42, 1.1], [0.2, 0.55, 0.3, 0.75]]) {
      const peak = new THREE.Mesh(new THREE.ConeGeometry(r, h, 6), new THREE.MeshBasicMaterial());
      peak.position.set(x, 0.175 + h / 2, z);
      g.add(peak);
    }
    return holoify(g, tint);
  }

  const ICONS = { swords, cards, flag, island };

  // --- build each venue -------------------------------------------------------
  VENUES.forEach((def) => {
    const poi = nav.pois.find((p) => p.name === def.building);
    if (!poi) return;
    // the door: the building's edge facing downtown, snapped to the sidewalk
    const toward = downtown.clone().sub(poi.center);
    if (toward.lengthSq() < 1) toward.set(0, 0, 1);
    toward.normalize();
    const doorGuess = poi.center.clone().addScaledVector(toward, poi.size * 0.5 + 5);
    const pad = nav.nearestCell(1, doorGuess, 40) ?? doorGuess;
    pad.y = 0;

    const tint = def.tint;
    const vg = new THREE.Group();
    group.add(vg);

    // pad: disc + ring + rim, lobby parking-ring style
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(4.2, 48),
      new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(pad.x, 0.05, pad.z);
    vg.add(disc);
    const ring = makeRing(tint, 4.4);
    ring.position.set(pad.x, 0.06, pad.z);
    ring.material.opacity = 0.7;
    vg.add(ring);
    const beacon = makeBeacon(tint, 60, 0.35);
    beacon.position.set(pad.x, 0, pad.z);
    beacon.material.opacity = 0.5;
    vg.add(beacon);

    // plaque over the pad, facing downtown
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 2.25),
      new THREE.MeshBasicMaterial({ map: makeSignTexture(def.name, { sub: def.tagline, arrow: false, hot: true }), transparent: true, side: THREE.DoubleSide })
    );
    sign.position.set(pad.x, 5.2, pad.z);
    sign.rotation.y = Math.atan2(toward.x, toward.z);
    vg.add(sign);

    // the hovering icon over the roof
    const icon = ICONS[def.icon](tint);
    icon.scale.setScalar(def.iconScale ?? 7);
    icon.position.set(poi.center.x, poi.height + 14 + (def.iconScale ?? 7) * 1.2, poi.center.z);
    vg.add(icon);
    const halo = makeRing(tint, (def.iconScale ?? 7) * 2.2);
    halo.position.set(poi.center.x, poi.height + 8, poi.center.z);
    halo.material.opacity = 0.35;
    vg.add(halo);

    // click target: a fat invisible column over the pad
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 12, 12), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.set(pad.x, 6, pad.z);
    vg.add(hit);
    const hitIcon = new THREE.Mesh(new THREE.SphereGeometry((def.iconScale ?? 7) * 2.2, 10, 8), new THREE.MeshBasicMaterial({ visible: false }));
    hitIcon.position.copy(icon.position);
    vg.add(hitIcon);

    const venue = {
      def,
      key: def.key,
      name: def.name,
      label: def.label,
      tint,
      pad,
      poi,
      icon,
      halo,
      ring,
      hitMeshes: [hit, hitIcon],
      get prompt() {
        return `${def.name} · ${def.tagline} — CLICK TO ENTER`;
      },
      onActivate: null, // main wires the launcher
      isVenue: true,
    };
    world.list.push(venue);
    world.pickables.push(venue);
  });

  // venues dissolve with the city on the way up; rings animate their own
  // opacity, so they take the fade in update()
  const fader = createFader(group, { skip: world.list.map((v) => v.ring.material) });
  let fade = 1;
  world.setFade = (f) => {
    fade = f;
    fader.set(f);
  };

  world.nearest = (p, within = 9) => {
    let best = null;
    let bd = within;
    for (const v of world.list) {
      const d = Math.hypot(v.pad.x - p.x, v.pad.z - p.z);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  };

  world.update = (dt, t) => {
    if (fade <= 0.003) return;
    world.list.forEach((v, i) => {
      v.icon.rotation.y = t * 0.5 + i;
      v.icon.position.y = v.poi.height + 14 + (v.def.iconScale ?? 7) * 1.2 + Math.sin(t * 1.3 + i) * 1.5;
      v.halo.rotation.z = -t * 0.3;
      v.ring.material.opacity = (0.45 + 0.3 * Math.sin(t * 2.5 + i)) * fade;
      v.icon.traverse((o) => {
        if (!o.userData.wave) return;
        const pos = o.geometry.attributes.position;
        for (let k = 0; k < pos.count; k++) {
          const x = pos.getX(k);
          pos.setZ(k, Math.sin(x * 3 + t * 6) * 0.08 * (x + 1.3));
        }
        pos.needsUpdate = true;
      });
    });
  };

  world.setHologram = () => {}; // venues are holo in both modes

  return world;
}

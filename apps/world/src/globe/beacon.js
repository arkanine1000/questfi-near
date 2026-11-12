import * as THREE from 'three';
import { GLOBE } from '../config.js';
import { CENTER, R, worldDir } from './geo.js';
import { makeBeacon, makeRing } from '../sprites.js';

// Site beacons: from the Regional band up, each site is a light pillar, a
// pulsing ring and a label (name + live agent count), all scaled with the
// camera's altitude so they read the same from 15 km and 15,000 km. Built
// from GLOBE.sites — one today, any number later. Hover/click is screen
// space: near the label or the base, on the visible side of the planet.

const GREEN = 0x35ff7d;

function labelTexture(name, sub) {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 160;
  const ctx = c.getContext('2d');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#35ff7d';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#dfffe8';
  ctx.font = '700 56px "Chakra Petch", monospace';
  ctx.fillText(name, 320, 56, 620);
  ctx.shadowBlur = 10;
  ctx.fillStyle = '#7dffb0';
  ctx.font = '600 32px "Chakra Petch", monospace';
  ctx.fillText(sub, 320, 118, 620);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createBeacons(scene) {
  const group = new THREE.Group();
  group.name = 'beacons';
  scene.add(group);

  const sites = GLOBE.sites.map((site, i) => {
    const up = i === 0 ? new THREE.Vector3(0, 1, 0) : worldDir(site.lat, site.lon);
    const base = i === 0 ? new THREE.Vector3(0, 0, 0) : CENTER.clone().addScaledVector(up, R);
    const g = new THREE.Group();
    g.position.copy(base);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    group.add(g);

    const core = makeBeacon(0xdfffe8, 1, 1);
    const halo = makeBeacon(GREEN, 1, 1);
    const ring = makeRing(GREEN, 1);
    const ping = makeRing(GREEN, 1);
    core.material.depthWrite = halo.material.depthWrite = false;
    g.add(halo, core, ring, ping);

    const labelMat = new THREE.SpriteMaterial({ map: labelTexture(site.name, ''), transparent: true, depthWrite: false, sizeAttenuation: false });
    const label = new THREE.Sprite(labelMat);
    label.center.set(0.5, 0);
    label.renderOrder = 20;
    g.add(label);

    return { site, up, base, g, core, halo, ring, ping, label, labelMat, sub: '' };
  });

  const v = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  let weight = 0;

  function facing(s, camera) {
    toCam.copy(camera.position).sub(s.base);
    return toCam.dot(s.up) > 0;
  }

  return {
    group,
    sites,
    update(camera, altitude, w, t, { agentCount = 0, venueCount = 0 } = {}) {
      weight = w.beacon;
      group.visible = weight > 0.003;
      if (!group.visible) return;
      const h = Math.max(altitude, 1);
      for (const s of sites) {
        const sub = `● ${agentCount} AGENTS LIVE · ${venueCount} VENUES`;
        if (sub !== s.sub) {
          s.sub = sub;
          s.labelMat.map.dispose();
          s.labelMat.map = labelTexture(s.site.name, sub);
        }
        const height = THREE.MathUtils.clamp(h * 0.3, 600, 1_500_000);
        const rad = h * 0.0028;
        s.core.scale.set(rad * 0.45, height, rad * 0.45);
        s.halo.scale.set(rad * 1.6, height * 0.8, rad * 1.6);
        s.core.material.opacity = 0.9 * weight;
        s.halo.material.opacity = 0.35 * weight;
        const pulse = 0.5 + 0.5 * Math.sin(t * 3.2);
        s.ring.scale.setScalar(h * 0.022 * (1 + 0.12 * pulse));
        s.ring.material.opacity = (0.45 + 0.35 * pulse) * weight;
        const k = (t * 0.55) % 1; // an expanding ping every ~2 s
        s.ping.scale.setScalar(h * 0.022 * (1 + 2.6 * k));
        s.ping.material.opacity = (1 - k) * 0.6 * weight;
        s.ring.position.y = s.ping.position.y = h * 0.0004;
        s.label.position.set(0, height * 1.02, 0);
        s.label.scale.set(0.26, 0.065, 1);
        s.labelMat.opacity = weight;
      }
    },
    // screen-space pick; ndc = {x, y} in −1..1
    pick(camera, ndc) {
      if (weight < 0.3) return null;
      let best = null;
      let bd = 0.09;
      for (const s of sites) {
        if (!facing(s, camera)) continue;
        for (const p of [s.base, s.label.getWorldPosition(v.set(0, 0, 0)).clone()]) {
          v.copy(p).project(camera);
          if (v.z > 1) continue;
          const d = Math.hypot((v.x - ndc.x) * camera.aspect, v.y - ndc.y);
          if (d < bd) {
            bd = d;
            best = s;
          }
        }
      }
      return best;
    },
  };
}

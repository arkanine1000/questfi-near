import * as THREE from 'three';
import { R, CENTER } from './geo.js';
import { sstep } from './geo.js';

// "AGENT EARTH": a big terminal-type title that hangs above the planet from
// orbit. It's tracked to the planet's projected limb every frame, so it sits
// just over the globe at any zoom, types itself out the first time it shows,
// and fades away as you come down (or when the planet fills the screen).

export function createTitle({ name = 'AGENT EARTH' } = {}) {
  const el = document.createElement('div');
  el.id = 'earth-title';
  el.innerHTML = `<div class="et-name"></div>`;
  document.body.appendChild(el);
  const nameEl = el.querySelector('.et-name');

  let typed = 0;
  let typing = false;
  let shown = 0;
  const v = new THREE.Vector3();

  return {
    el,
    // weight: 0..1 extra gate from main (intro overlay, launcher)
    update(camera, altitude, dt, { agents = 0, sites = 1, gate = 1 } = {}) {
      const d = camera.position.distanceTo(CENTER);
      // the planet's projected center and radius, in px
      v.copy(CENTER).project(camera);
      const H = window.innerHeight;
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const ang = Math.asin(Math.min(1, R / d));
      const rPx = (Math.tan(ang) / tanHalf) * (H / 2);
      const cy = (1 - v.y) * 0.5 * H;
      const cx = (v.x + 1) * 0.5 * window.innerWidth;
      const top = cy - rPx; // the limb's highest point on screen
      // fade in from ~2,000 km; out when the limb leaves room above it
      let w = sstep(1_500_000, 3_500_000, altitude) * sstep(40, 150, top) * gate;
      if (v.z > 1) w = 0;
      shown += (w - shown) * (1 - Math.exp(-5 * dt));
      el.style.opacity = shown.toFixed(3);
      el.style.visibility = shown < 0.01 ? 'hidden' : 'visible';
      if (shown < 0.01) return;

      // as big as the planet suggests, but never crowding the top edge
      const size = Math.max(36, Math.min(THREE.MathUtils.clamp(rPx * 0.36, 44, 150), (top - 28) / 1.35));
      el.style.setProperty('--et-size', `${size.toFixed(1)}px`);
      el.style.left = `${cx.toFixed(1)}px`;
      el.style.top = `${(top - size * 0.42).toFixed(1)}px`;

      // types out once, the first time it's on screen
      if (!typing && shown > 0.3) typing = true;
      if (typing && typed < name.length) {
        typed = Math.min(name.length, typed + dt * 14);
        nameEl.textContent = name.slice(0, Math.floor(typed));
      }
    },
  };
}

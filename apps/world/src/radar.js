import { css } from './sprites.js';

// The minimap: a circular radar in the corner, the baked nav grid rendered
// once to an offscreen canvas (roads bright, pavement dim, buildings dark)
// and redrawn each tick rotated so the camera's forward is up. Agents are
// tinted blips, the spectated one rings, cars are faint dots, and the north
// needle rides the rim.

export function createRadar(canvas, nav) {
  const SIZE = canvas.width;
  const R = SIZE / 2 - 4;
  const ctx = canvas.getContext('2d');

  // the base map: one pixel per cell
  const map = document.createElement('canvas');
  map.width = nav.w;
  map.height = nav.h;
  const mctx = map.getContext('2d');
  const img = mctx.createImageData(nav.w, nav.h);
  for (let i = 0; i < nav.grid.length; i++) {
    const k = nav.grid[i];
    const o = i * 4;
    if (k === 0) { img.data[o] = 60; img.data[o + 1] = 255; img.data[o + 2] = 130; img.data[o + 3] = 120; }
    else if (k === 2) { img.data[o] = 10; img.data[o + 1] = 60; img.data[o + 2] = 30; img.data[o + 3] = 170; }
    else { img.data[o] = 40; img.data[o + 1] = 150; img.data[o + 2] = 80; img.data[o + 3] = 55; }
  }
  mctx.putImageData(img, 0, 0);

  let metersPerPx = 1.35; // zoom: the disc spans ~250 m across

  function draw({ x, z, yaw, agents = [], cars = [], venues = [], target = null, mode = 'fly', altitude = 0 }) {
    // from the air the radar zooms out so the whole district reads
    const zoom = mode === 'fly' ? metersPerPx * (1 + Math.min(3, altitude / 120)) : metersPerPx;
    const pxPerCell = nav.cell / zoom;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(2, 18, 9, 0.9)';
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.translate(SIZE / 2, SIZE / 2);
    ctx.rotate(yaw); // forward (−Z at yaw 0) points up
    const cx = (x - nav.minX) / nav.cell;
    const cz = (z - nav.minZ) / nav.cell;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(map, -cx * pxPerCell, -cz * pxPerCell, nav.w * pxPerCell, nav.h * pxPerCell);

    // blips
    const blip = (px, pz, color, r, ring = false) => {
      const dx = (px - x) / zoom;
      const dz = (pz - z) / zoom;
      if (dx * dx + dz * dz > R * R * 1.1) return;
      ctx.beginPath();
      ctx.arc(dx, dz, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.fill();
      ctx.shadowBlur = 0;
      if (ring) {
        ctx.beginPath();
        ctx.arc(dx, dz, r + 4 + 2 * Math.sin(performance.now() / 160), 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    };
    for (const c of cars) if (!c.driver) blip(c.pos.x, c.pos.z, 'rgba(159,255,224,0.55)', 1.6);
    // venues: a diamond at the door, clamped to the rim when out of range
    for (const v of venues) {
      let dx = (v.pad.x - x) / zoom;
      let dz = (v.pad.z - z) / zoom;
      const d = Math.hypot(dx, dz);
      if (d > R - 8) { dx *= (R - 8) / d; dz *= (R - 8) / d; }
      ctx.save();
      ctx.translate(dx, dz);
      ctx.rotate(-yaw);
      ctx.beginPath();
      ctx.moveTo(0, -6); ctx.lineTo(5, 0); ctx.lineTo(0, 6); ctx.lineTo(-5, 0); ctx.closePath();
      ctx.fillStyle = css(v.tint);
      ctx.shadowColor = css(v.tint);
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#02120a';
      ctx.font = '700 7px "Chakra Petch", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(v.name[4] ?? v.name[0], 0, 0.5);
      ctx.restore();
    }
    for (const a of agents) blip(a.pos.x, a.pos.z, css(a.tint), 3, a === target);
    ctx.restore();

    // the viewer: a wedge at the center pointing up
    ctx.save();
    ctx.translate(SIZE / 2, SIZE / 2);
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 5);
    ctx.lineTo(0, 2);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fillStyle = '#dfffe8';
    ctx.shadowColor = '#35ff7d';
    ctx.shadowBlur = 8;
    ctx.fill();
    // north marker on the rim
    ctx.rotate(yaw);
    ctx.fillStyle = '#35ff7d';
    ctx.font = '700 11px "Chakra Petch", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', 0, -R + 9);
    ctx.restore();

    // rim + sweep
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(53,255,125,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
    const sweep = (performance.now() / 1400) % (Math.PI * 2);
    const g = ctx.createConicGradient ? ctx.createConicGradient(sweep, SIZE / 2, SIZE / 2) : null;
    if (g) {
      g.addColorStop(0, 'rgba(53,255,125,0.22)');
      g.addColorStop(0.12, 'rgba(53,255,125,0)');
      g.addColorStop(1, 'rgba(53,255,125,0)');
      ctx.save();
      ctx.beginPath();
      ctx.arc(SIZE / 2, SIZE / 2, R, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.restore();
    }
  }

  return { draw, set zoom(v) { metersPerPx = v; } };
}

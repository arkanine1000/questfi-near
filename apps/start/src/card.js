import * as THREE from 'three';

// The access card: the agent pass as an object you can hold. A bevelled
// slab with canvas-drawn faces that glow under the bloom pass, plus an
// additive foil sheen that slides with the tilt.

export const CARD_W = 3.2;
export const CARD_H = 2.0;
const RADIUS = 0.15;
const DEPTH = 0.05;
const TEX_W = 1280;
const TEX_H = 800;

function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

// ShapeGeometry UVs come out in shape units; remap them to 0..1.
function faceGeometry(shape, flipU = false) {
  const g = new THREE.ShapeGeometry(shape, 10);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) / CARD_W + 0.5;
    uv.setXY(i, flipU ? 1 - u : u, pos.getY(i) / CARD_H + 0.5);
  }
  return g;
}

function hexPath(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    const px = cx + r * Math.cos(a);
    const py = cy + r * Math.sin(a);
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  }
  ctx.closePath();
}

function backdrop(ctx) {
  const g = ctx.createLinearGradient(0, 0, TEX_W, TEX_H);
  g.addColorStop(0, '#04180c');
  g.addColorStop(0.55, '#020d07');
  g.addColorStop(1, '#062414');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  // hex lattice
  ctx.strokeStyle = 'rgba(53,255,125,0.10)';
  ctx.lineWidth = 2;
  const r = 46;
  const dx = r * Math.sqrt(3);
  for (let row = -1; row < 12; row++) {
    for (let col = -1; col < 18; col++) {
      hexPath(ctx, col * dx + (row % 2 ? dx / 2 : 0), row * r * 1.5, r);
      ctx.stroke();
    }
  }
  // inner frame
  ctx.strokeStyle = 'rgba(53,255,125,0.75)';
  ctx.lineWidth = 4;
  ctx.strokeRect(34, 34, TEX_W - 68, TEX_H - 68);
  ctx.strokeStyle = 'rgba(53,255,125,0.25)';
  ctx.lineWidth = 2;
  ctx.strokeRect(48, 48, TEX_W - 96, TEX_H - 96);
}

function glowText(ctx, text, x, y, font, color = '#b9ffd2', blur = 18) {
  ctx.font = font;
  ctx.shadowColor = 'rgba(53,255,125,0.9)';
  ctx.shadowBlur = blur;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.shadowBlur = 0;
}

function drawFront(ctx, info) {
  backdrop(ctx);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  // logo hex
  ctx.lineWidth = 7;
  ctx.strokeStyle = '#49ff8c';
  ctx.shadowColor = '#35ff7d';
  ctx.shadowBlur = 22;
  hexPath(ctx, 132, 138, 50);
  ctx.stroke();
  ctx.shadowBlur = 0;
  glowText(ctx, 'Q', 112, 160, '700 62px "Chakra Petch", sans-serif', '#dfffe8');

  glowText(ctx, 'QUESTFI', 208, 132, '700 64px "Chakra Petch", sans-serif', '#dfffe8');
  glowText(ctx, 'AGENT ACCESS PASS', 210, 176, '600 28px "Chakra Petch", sans-serif', 'rgba(159,255,200,0.85)', 8);

  // chip
  const cx = 96;
  const cy = 300;
  ctx.strokeStyle = '#49ff8c';
  ctx.lineWidth = 4;
  ctx.fillStyle = 'rgba(53,255,125,0.12)';
  ctx.beginPath();
  ctx.roundRect(cx, cy, 170, 124, 16);
  ctx.fill();
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy + 42); ctx.lineTo(cx + 56, cy + 42); ctx.lineTo(cx + 56, cy + 82); ctx.lineTo(cx, cy + 82);
  ctx.moveTo(cx + 170, cy + 42); ctx.lineTo(cx + 114, cy + 42); ctx.lineTo(cx + 114, cy + 82); ctx.lineTo(cx + 170, cy + 82);
  ctx.moveTo(cx + 85, cy); ctx.lineTo(cx + 85, cy + 124);
  ctx.stroke();

  // level block, top right
  ctx.textAlign = 'right';
  glowText(ctx, 'LEVEL', TEX_W - 96, 118, '600 26px "Chakra Petch", sans-serif', 'rgba(159,255,200,0.8)', 6);
  glowText(ctx, String(info.level).padStart(2, '0'), TEX_W - 92, 218, '700 104px "VT323", monospace', '#eafff1', 26);
  ctx.textAlign = 'left';

  // pass number
  glowText(ctx, `PASS  #${info.id}`, 300, 352, '400 78px "VT323", monospace', '#eafff1', 20);
  glowText(ctx, 'NEP-171  ·  NEAR TESTNET', 302, 400, '600 26px "Chakra Petch", sans-serif', 'rgba(159,255,200,0.75)', 6);

  // fields
  const fields = [
    ['HOLDER', info.holder],
    ['AGENT', info.agent],
    ['PASS BALANCE', info.balance],
  ];
  let fx = 96;
  for (const [label, value] of fields) {
    glowText(ctx, label, fx, 548, '600 22px "Chakra Petch", sans-serif', 'rgba(159,255,200,0.6)', 4);
    glowText(ctx, value, fx, 598, '400 46px "VT323", monospace', '#dfffe8', 12);
    fx += 372;
  }

  // xp bar
  ctx.strokeStyle = 'rgba(53,255,125,0.7)';
  ctx.lineWidth = 3;
  ctx.strokeRect(96, 648, TEX_W - 192, 26);
  ctx.fillStyle = '#35ff7d';
  ctx.shadowColor = '#35ff7d';
  ctx.shadowBlur = 16;
  ctx.fillRect(101, 653, (TEX_W - 202) * info.xpFrac, 16);
  ctx.shadowBlur = 0;

  // footer strip
  glowText(ctx, info.status, 96, 728, '600 24px "Chakra Petch", sans-serif', info.locked ? 'rgba(255,214,120,0.9)' : '#9dffc4', 8);
  ctx.textAlign = 'right';
  glowText(ctx, 'QFI-AP // 01', TEX_W - 96, 728, '400 34px "VT323", monospace', 'rgba(159,255,200,0.7)', 6);
  ctx.textAlign = 'left';
}

function drawBack(ctx, info) {
  backdrop(ctx);
  ctx.textBaseline = 'alphabetic';
  // mag stripe
  ctx.fillStyle = 'rgba(53,255,125,0.2)';
  ctx.fillRect(34, 96, TEX_W - 68, 96);

  ctx.textAlign = 'left';
  glowText(ctx, 'SERVICE RECORD', 96, 290, '700 40px "Chakra Petch", sans-serif', '#dfffe8', 14);
  const rows = [
    ['SEASONS', info.seasons],
    ['WINS', info.wins],
    ['KILLS', info.kills],
    ['LIFETIME PROFIT', info.lifetime],
  ];
  let y = 372;
  for (const [k, v] of rows) {
    glowText(ctx, k, 96, y, '600 28px "Chakra Petch", sans-serif', 'rgba(159,255,200,0.7)', 4);
    ctx.textAlign = 'right';
    glowText(ctx, String(v), TEX_W - 96, y, '400 52px "VT323", monospace', '#eafff1', 12);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(53,255,125,0.2)';
    ctx.fillRect(96, y + 16, TEX_W - 192, 2);
    y += 82;
  }
  glowText(ctx, 'THIS PASS OWNS ITS AGENT’S EARNINGS. REDEEMABLE FOR A PHYSICAL CARD AT LEVEL 5.', 96, 728,
    '600 20px "Chakra Petch", sans-serif', 'rgba(159,255,200,0.65)', 4);
}

export function createCard() {
  const group = new THREE.Group(); // faces the camera (set by main)
  const pivot = new THREE.Group(); // tilt + flip happen here
  group.add(pivot);

  const shape = roundedRect(CARD_W, CARD_H, RADIUS);

  const body = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: DEPTH, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2, curveSegments: 10 }),
    new THREE.MeshStandardMaterial({ color: 0x03140a, emissive: 0x1fd465, emissiveIntensity: 0.22, roughness: 0.35, metalness: 0.6 })
  );
  body.position.z = -DEPTH / 2;
  pivot.add(body);

  const makeFace = () => {
    const canvas = document.createElement('canvas');
    canvas.width = TEX_W;
    canvas.height = TEX_H;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return { canvas, ctx: canvas.getContext('2d'), tex };
  };
  const front = makeFace();
  const back = makeFace();

  const faceMat = (tex) => new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  const frontMesh = new THREE.Mesh(faceGeometry(shape), faceMat(front.tex));
  frontMesh.position.z = DEPTH / 2 + 0.014;
  pivot.add(frontMesh);
  // turned to face -Z, so its local +X is already the viewer's right
  const backMesh = new THREE.Mesh(faceGeometry(shape), faceMat(back.tex));
  backMesh.position.z = -DEPTH / 2 - 0.014;
  backMesh.rotation.y = Math.PI;
  pivot.add(backMesh);

  // foil sheen
  const sheenMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { time: { value: 0 }, tilt: { value: new THREE.Vector2() }, scan: { value: -1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float time; uniform vec2 tilt; uniform float scan;
      varying vec2 vUv;
      void main() {
        float p = (vUv.x + vUv.y * 0.6) * 3.2 + tilt.x * 5.0 - tilt.y * 3.0 + time * 0.12;
        float band = pow(max(0.0, sin(p * 3.14159)), 22.0);
        vec3 foil = mix(vec3(0.2, 1.0, 0.55), vec3(0.45, 0.9, 1.0), 0.5 + 0.5 * sin(p * 2.0));
        vec3 c = foil * band * 0.16;
        // authentication sweep
        float s = 1.0 - smoothstep(0.0, 0.035, abs(vUv.y - scan));
        c += vec3(0.7, 1.0, 0.8) * s * 1.6;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const sheen = new THREE.Mesh(faceGeometry(shape), sheenMat);
  sheen.position.z = DEPTH / 2 + 0.02;
  pivot.add(sheen);

  // glowing rim
  const rim = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(shape.getPoints(10).map((p) => new THREE.Vector3(p.x * 1.012, p.y * 1.02, 0))),
    new THREE.LineBasicMaterial({ color: 0x49ff8c, transparent: true, opacity: 0.9 })
  );
  pivot.add(rim);

  function redraw(info) {
    drawFront(front.ctx, info);
    drawBack(back.ctx, info);
    front.tex.needsUpdate = true;
    back.tex.needsUpdate = true;
  }

  return { group, pivot, body, sheenMat, redraw };
}

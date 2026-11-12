import * as THREE from 'three';

// Digital rain: columns of glyphs falling through the sky over downtown, one
// Points draw call. Each column is `trail` points; the vertex shader drops
// them on time, the head burns white, the tail fades to green, and every
// glyph re-rolls as it falls. Additive, so it reads as light on the black.

function makeGlyphAtlas(n = 16, cell = 64) {
  const c = document.createElement('canvas');
  c.width = cell * n;
  c.height = cell;
  const ctx = c.getContext('2d');
  const chars = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789ZXQ';
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${cell * 0.78}px "Chakra Petch", "MS Gothic", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const ch = chars[Math.floor(Math.random() * chars.length)];
    ctx.save();
    ctx.translate(i * cell + cell / 2, cell / 2);
    if (Math.random() < 0.5) ctx.scale(-1, 1); // mirrored glyphs, as the canon demands
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createRain({ center, radius = 520, height = 280, columns = 2600, trail = 9 } = {}) {
  const count = columns * trail;
  const origin = new Float32Array(count * 3);
  const data = new Float32Array(count * 4); // speed, phase, glyph seed, trail index
  for (let c = 0; c < columns; c++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    const x = center.x + Math.cos(a) * r;
    const z = center.z + Math.sin(a) * r;
    const speed = 14 + Math.random() * 30;
    const phase = Math.random() * height;
    const seed = Math.random() * 16;
    for (let k = 0; k < trail; k++) {
      const i = c * trail + k;
      origin[i * 3] = x;
      origin[i * 3 + 1] = 0;
      origin[i * 3 + 2] = z;
      data[i * 4] = speed;
      data[i * 4 + 1] = phase;
      data[i * 4 + 2] = seed;
      data[i * 4 + 3] = k;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(origin, 3));
  geo.setAttribute('aData', new THREE.BufferAttribute(data, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(center.x, height / 2, center.z), radius + height);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uAtlas: { value: makeGlyphAtlas() },
      uHeight: { value: height },
      uSpacing: { value: 2.6 },
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec4 aData;
      uniform float uTime;
      uniform float uHeight;
      uniform float uSpacing;
      varying float vTrail;
      varying float vGlyph;
      void main() {
        float speed = aData.x;
        float phase = aData.y;
        float k = aData.w;
        float y = uHeight - mod(uTime * speed + phase, uHeight + 40.0) + k * uSpacing;
        vec3 p = vec3(position.x, y, position.z);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(1200.0 / -mv.z, 2.0, 22.0);
        #include <logdepthbuf_vertex>
        vTrail = k;
        // glyphs re-roll on a slow tick, offset down the trail
        vGlyph = mod(floor(aData.z + uTime * 2.5 + k * 3.0), 16.0);
      }
    `,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D uAtlas;
      uniform float uOpacity;
      varying float vTrail;
      varying float vGlyph;
      void main() {
        #include <logdepthbuf_fragment>
        vec2 uv = gl_PointCoord;
        uv.x = (uv.x + vGlyph) / 16.0;
        float a = texture2D(uAtlas, uv).a;
        if (a < 0.2) discard;
        float head = step(vTrail, 0.5);
        float fade = 1.0 - vTrail / 9.0;
        vec3 col = mix(vec3(0.12, 0.9, 0.38) * fade, vec3(0.85, 1.0, 0.9), head);
        gl_FragColor = vec4(col, a * (0.25 + 0.75 * fade) * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return {
    points,
    update(t) {
      mat.uniforms.uTime.value = t;
    },
    set opacity(v) { mat.uniforms.uOpacity.value = v; },
    set visible(v) { points.visible = v; },
    get visible() { return points.visible; },
  };
}

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Bloom + CRT scanlines / aberration / vignette — the house look, same pass
// agent_world runs.
const CRTShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    resolution: { value: new THREE.Vector2(1, 1) },
    grade: { value: 0.3 },
    aberration: { value: 0.8 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float grade;
    uniform float aberration;
    uniform vec2 resolution;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec2 d = (vUv - 0.5);
      float jolt = step(0.975, hash(vec2(floor(time * 18.0), 7.0))) * 2.5;
      vec2 off = d * (0.0022 + 0.004 * jolt) * aberration;
      vec3 c = vec3(
        texture2D(tDiffuse, vUv + off).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - off).b
      );
      float dip = 1.0 - 0.08 * step(0.985, hash(vec2(floor(time * 24.0), 3.0)));
      float roll = 1.0 + 0.035 * smoothstep(0.985, 1.0, 1.0 - abs(fract(vUv.y * 0.5 + time * 0.05) - 0.5) * 2.0);
      c *= dip * roll;
      float lum = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(c, lum * vec3(0.45, 1.0, 0.62), grade);
      float scan = 0.94 + 0.06 * sin(vUv.y * resolution.y * 1.8 + time * 5.0);
      c *= scan;
      float vig = smoothstep(1.35, 0.35, length(vUv - 0.5) * 1.7);
      c *= mix(0.55, 1.0, vig);
      c += (hash(vUv * (time + 1.0)) - 0.5) * 0.035 * vec3(0.6, 1.0, 0.7);
      gl_FragColor = vec4(c, 1.0);
    }
  `,
};

export function createPost(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.45, 0.4);
  composer.addPass(bloom);
  const crt = new ShaderPass(CRTShader);
  composer.addPass(crt);
  composer.addPass(new OutputPass());

  return {
    bloom,
    resize(w, h) {
      composer.setSize(w, h);
      crt.uniforms.resolution.value.set(w, h);
    },
    render(t) {
      crt.uniforms.time.value = t;
      composer.render();
    },
  };
}

import { memo, useMemo, useRef } from 'react';
import { Uniform } from 'three';
import { useFrame } from '@react-three/fiber';
import { EffectComposer } from '@react-three/postprocessing';
import {
  BlendFunction, BloomEffect, Effect, EffectAttribute,
} from 'postprocessing';

/**
 * The house post pass shared with the start app and Agent World: a modest
 * bloom, then a CRT pass (chromatic aberration that jolts now and then, a
 * brightness dip and slow rolling band, a gentle green grade, faint
 * scanlines, a vignette and a little noise).
 *
 * The CRT shader is a port of the one in apps/start/src/post.js. Every
 * strength is a uniform written each frame from props, so one compiled
 * shader serves the island and the dungeon with different values.
 *
 * `?fx=0` in the URL turns the whole pass off (see houseFxAllowedByUrl), so
 * a broken shader can be ruled out quickly.
 */

// GLSL: names are prefixed by postprocessing when the effect is merged into
// its EffectPass, so every uniform and function here carries a `crt` prefix
// that no local variable reuses. `inputBuffer` is the pass's own input.
const CRT_FRAGMENT = /* glsl */ `
uniform float crtTime;
uniform float crtMotion;
uniform float crtScreenHeight;
uniform float crtGrade;
uniform float crtAberration;
uniform float crtScan;
uniform float crtVignette;
uniform float crtNoise;

float crtHash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // chromatic aberration: the channels drift apart toward the edges, and
  // the whole projection jolts for a frame now and then
  vec2 d = uv - 0.5;
  float jolt = step(0.975, crtHash(vec2(floor(crtTime * 18.0), 7.0))) * 2.5 * crtMotion;
  vec2 off = d * (0.0022 + 0.004 * jolt) * crtAberration;
  vec3 c = vec3(
    texture2D(inputBuffer, uv + off).r,
    inputColor.g,
    texture2D(inputBuffer, uv - off).b
  );

  // hologram flicker: rare one-frame dips plus a slow rolling band
  float dip = 1.0 - 0.08 * step(0.985, crtHash(vec2(floor(crtTime * 24.0), 3.0))) * crtMotion;
  float band = 1.0 - abs(fract(uv.y * 0.5 + crtTime * 0.05) - 0.5) * 2.0;
  float roll = 1.0 + 0.035 * smoothstep(0.985, 1.0, band) * crtMotion;
  c *= dip * roll;

  // gentle green grade
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, lum * vec3(0.45, 1.0, 0.62), crtGrade);

  // scanlines (crtScan 0.06 gives the reference 0.94 + 0.06 * sin)
  float scanTerm = (1.0 - crtScan) + crtScan * sin(uv.y * crtScreenHeight * 1.8 + crtTime * 5.0);
  c *= scanTerm;

  // vignette (crtVignette 0.45 gives the reference mix(0.55, 1.0, vig));
  // 1.0 - smoothstep(0.35, 1.35, x) is the reference smoothstep(1.35, 0.35, x)
  // written with ascending edges
  float vig = 1.0 - smoothstep(0.35, 1.35, length(uv - 0.5) * 1.7);
  c *= mix(1.0 - crtVignette, 1.0, vig);

  // subtle noise
  c += (crtHash(uv * (crtTime + 1.0)) - 0.5) * crtNoise * vec3(0.6, 1.0, 0.7);

  outputColor = vec4(c, 1.0);
}
`;

/**
 * The CRT pass as a postprocessing Effect. It samples its input at offset
 * coordinates (the aberration), hence CONVOLUTION: the composer gives it an
 * EffectPass of its own after the bloom.
 */
export class HouseCrtEffect extends Effect {
  constructor() {
    const crt = {
      time: new Uniform(0),
      motion: new Uniform(1),
      screenHeight: new Uniform(1080),
      grade: new Uniform(0.22),
      aberration: new Uniform(0.8),
      scan: new Uniform(0.06),
      vignette: new Uniform(0.45),
      noise: new Uniform(0.035),
    };
    super('HouseCrtEffect', CRT_FRAGMENT, {
      attributes: EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['crtTime', crt.time],
        ['crtMotion', crt.motion],
        ['crtScreenHeight', crt.screenHeight],
        ['crtGrade', crt.grade],
        ['crtAberration', crt.aberration],
        ['crtScan', crt.scan],
        ['crtVignette', crt.vignette],
        ['crtNoise', crt.noise],
      ]),
    });
    this.crt = crt;
  }
}

/** False when the URL carries `?fx=0`: render the scene without any post pass. */
export function houseFxAllowedByUrl() {
  if (typeof window === 'undefined') return true;
  return new URLSearchParams(window.location.search).get('fx') !== '0';
}

// Bloom threshold softness and the CRT clock's wrap. The wrap keeps the
// hash inputs small enough for float precision; 1200 s is a multiple of the
// 20 s roll period, so the band does not jump when the clock wraps.
const BLOOM_SMOOTHING = 0.1;
const TIME_WRAP = 1200;

function HouseFx({
  bloomIntensity = 0.6,
  bloomThreshold = 0.4,
  bloomRadius = 0.5,
  grade = 0.22,
  aberration = 0.8,
  scan = 0.06,
  vignette = 0.45,
  noise = 0.035,
  reducedMotion = false,
  multisampling = 4,
}) {
  // Latest props, read by the frame loop. Re-rendering never rebuilds the
  // effects or the composer's passes, which would recompile their shaders.
  const live = useRef(null);
  live.current = {
    bloomIntensity, bloomThreshold, bloomRadius,
    grade, aberration, scan, vignette, noise, reducedMotion,
  };
  const clock = useRef(0);

  // Built once per mounted composer; their GPU resources go with the
  // canvas's context when the scene unmounts.
  const bloom = useMemo(() => new BloomEffect({
    blendFunction: BlendFunction.ADD,
    mipmapBlur: true,
    intensity: live.current.bloomIntensity,
    luminanceThreshold: live.current.bloomThreshold,
    luminanceSmoothing: BLOOM_SMOOTHING,
    radius: live.current.bloomRadius,
  }), []);
  const crt = useMemo(() => new HouseCrtEffect(), []);

  // Runs before the composer's render (its frame callback has priority 1)
  useFrame((state, delta) => {
    const v = live.current;
    bloom.intensity = v.bloomIntensity;
    if (bloom.luminanceMaterial.threshold !== v.bloomThreshold) {
      bloom.luminanceMaterial.threshold = v.bloomThreshold;
    }
    bloom.mipmapBlurPass.radius = v.bloomRadius;

    const u = crt.crt;
    if (v.reducedMotion) {
      // static look: no jolt, dip or roll, and the noise stands still
      u.time.value = 0;
      u.motion.value = 0;
    } else {
      clock.current = (clock.current + Math.min(delta, 0.1)) % TIME_WRAP;
      u.time.value = clock.current;
      u.motion.value = 1;
    }
    // scanline spacing follows CSS pixels, like the start app's innerHeight
    u.screenHeight.value = state.size.height;
    u.grade.value = v.grade;
    u.aberration.value = v.aberration;
    u.scan.value = v.scan;
    u.vignette.value = v.vignette;
    u.noise.value = v.noise;
  });

  // Stable children: the composer rebuilds its passes whenever they change
  const effects = useMemo(() => [
    <primitive key="bloom" object={bloom} />,
    <primitive key="crt" object={crt} />,
  ], [bloom, crt]);

  return <EffectComposer multisampling={multisampling}>{effects}</EffectComposer>;
}

export default memo(HouseFx);

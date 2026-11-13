import { useMemo } from 'react';
import * as THREE from 'three';
import { useFrame, useLoader } from '@react-three/fiber';
import { getActiveMap } from '../../data/maps';
import {
  WORLD_WIDTH, WORLD_DEPTH, TERRAIN_HEIGHT_SCALE, COLORS,
} from './worldUtils';
import { look } from './look';

// 256x170 segments keeps total vertices under ~44k (budget: 50k)
const SEG_X = 256;
const SEG_Y = 170;

// The wireframe pass uses a much sparser mesh — at full density the lines
// merge into a solid fill; sparse gives the low-poly hologram look
const WIRE_SEG_X = 96;
const WIRE_SEG_Y = 64;

// Topo contour lines: one band every CONTOUR_STEP world units of elevation
const CONTOUR_STEP = TERRAIN_HEIGHT_SCALE / 9;

/** Bilinear sample of grayscale image data, u/v in 0..1. */
function sampleHeight(data, w, h, u, v) {
  const gx = Math.min(Math.max(u * w - 0.5, 0), w - 1.001);
  const gy = Math.min(Math.max(v * h - 0.5, 0), h - 1.001);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const px = (x, y) => data[(y * w + x) * 4] / 255;
  const a = px(x0, y0) * (1 - fx) + px(x1, y0) * fx;
  const b = px(x0, y1) * (1 - fx) + px(x1, y1) * fx;
  return a * (1 - fy) + b * fy;
}

// Fragments at/below sea level are discarded so the terrain meshes are
// clipped to the island silhouette — no rectangular plate around it
const SEA_LEVEL_CLIP = 0.02;

/**
 * The land as a dark shape described by its lines: an unlit, near-black fill
 * that lifts very slightly with height, topographic contour bands in the
 * house green, and the sea-level contour drawn as the island's glowing
 * outline. Everything is clipped at sea level.
 *
 * The fill ignores the scene lights on purpose: lit flat-shaded faces read
 * as a green mass, so the relief comes from the contours and the ramp.
 */
function injectTerrainShading(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vElev;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvElev = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vElev;
        uniform vec3 uTerrainLow;
        uniform vec3 uTerrainHigh;
        uniform float uFillGain;
        uniform vec3 uContourColor;
        uniform float uContourGain;
        uniform vec3 uShoreColor;
        uniform float uShoreGain;`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
          if (vElev < ${SEA_LEVEL_CLIP.toFixed(4)}) discard;
          float heightNorm = clamp(vElev / ${TERRAIN_HEIGHT_SCALE.toFixed(4)}, 0.0, 1.0);
          outgoingLight = mix(uTerrainLow, uTerrainHigh, heightNorm) * uFillGain;
        }
        #include <opaque_fragment>`,
      )
      .replace(
        '#include <colorspace_fragment>',
        `{
          float band = vElev / ${CONTOUR_STEP.toFixed(5)};
          float distToLine = min(fract(band), 1.0 - fract(band));
          // fwidth keeps the lines ~1.5px wide in screen space regardless
          // of slope; fraction-based widths smear out on shallow terrain
          float w = max(fwidth(band), 1e-4);
          float contour = 1.0 - smoothstep(0.75 * w, 2.0 * w, distToLine);
          // the band at sea level is the shoreline below, not a contour
          contour *= smoothstep(0.015, 0.06, vElev);
          // shoreline: the strip just above the clip line, a little wider
          // than a contour line and brighter
          float sw = max(fwidth(vElev), 1e-5);
          float shore = 1.0 - smoothstep(2.5 * sw, 4.5 * sw, vElev - ${SEA_LEVEL_CLIP.toFixed(4)});
          gl_FragColor.rgb += uContourColor * contour * uContourGain + uShoreColor * shore * uShoreGain;
        }
        #include <colorspace_fragment>`,
      );
  };
  // onBeforeCompile changes require a distinct program cache entry
  material.customProgramCacheKey = () => 'holo-terrain-lines';
}

/** Same sea-level clip for the wireframe pass. */
function injectSeaLevelClip(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vElev;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvElev = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vElev;')
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        if (vElev < ${SEA_LEVEL_CLIP.toFixed(4)}) discard;`,
      );
  };
  material.customProgramCacheKey = () => 'holo-wire-clip';
}

export default function Terrain({ wireframe = true }) {
  const heightImg = useLoader(THREE.ImageLoader, getActiveMap().heightmapUrl);

  // Displace the planes on the CPU once — keeps materials simple and keeps
  // prisms flush via the same heightmap data the elevations were sampled from.
  const { geometry, wireGeometry } = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = heightImg.width;
    canvas.height = heightImg.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(heightImg, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    const displace = (segX, segY) => {
      const geo = new THREE.PlaneGeometry(WORLD_WIDTH, WORLD_DEPTH, segX, segY);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const u = pos.getX(i) / WORLD_WIDTH + 0.5;
        const v = pos.getZ(i) / WORLD_DEPTH + 0.5;
        pos.setY(i, sampleHeight(data, canvas.width, canvas.height, u, v) * TERRAIN_HEIGHT_SCALE);
      }
      geo.computeVertexNormals();
      return geo;
    };

    return {
      geometry: displace(SEG_X, SEG_Y),
      wireGeometry: displace(WIRE_SEG_X, WIRE_SEG_Y),
    };
  }, [heightImg]);

  // Shared with the shader through onBeforeCompile; the gains follow the
  // look store every frame
  const uniforms = useMemo(() => ({
    uTerrainLow: { value: new THREE.Color(COLORS.terrain) },
    uTerrainHigh: { value: new THREE.Color(COLORS.terrainHigh) },
    uFillGain: { value: look.terrainFill },
    uContourColor: { value: new THREE.Color(COLORS.green) },
    uContourGain: { value: look.contours },
    uShoreColor: { value: new THREE.Color(COLORS.bright) },
    uShoreGain: { value: look.shoreline },
  }), []);

  const solidMaterial = useMemo(() => {
    const mat = new THREE.MeshBasicMaterial({ color: COLORS.terrain, toneMapped: false });
    injectTerrainShading(mat, uniforms);
    return mat;
  }, [uniforms]);

  const wireMaterial = useMemo(() => {
    const mat = new THREE.MeshBasicMaterial({
      wireframe: true,
      color: COLORS.green,
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      toneMapped: false,
    });
    injectSeaLevelClip(mat);
    return mat;
  }, []);

  useFrame(() => {
    uniforms.uFillGain.value = look.terrainFill;
    uniforms.uContourGain.value = look.contours;
    uniforms.uShoreGain.value = look.shoreline;
  });

  // The sea, its lattice and the sonar pulses live in TableStage
  return (
    <group>
      {/* Solid pass — near-black fill, contour bands and the shoreline */}
      <mesh geometry={geometry} material={solidMaterial} />

      {/* Wireframe pass — the "projected mesh" hologram look, island only */}
      {wireframe && <mesh geometry={wireGeometry} material={wireMaterial} />}
    </group>
  );
}

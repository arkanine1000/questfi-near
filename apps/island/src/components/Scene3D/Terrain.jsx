import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useLoader } from '@react-three/fiber';
import { getActiveMap } from '../../data/maps';
import {
  WORLD_WIDTH, WORLD_DEPTH, TERRAIN_HEIGHT_SCALE, COLORS,
} from './worldUtils';

// 256x170 segments keeps total vertices under ~44k (budget: 50k)
const SEG_X = 256;
const SEG_Y = 170;

// The wireframe pass uses a much sparser mesh — at full density the lines
// merge into a solid fill; sparse gives the low-poly hologram look
const WIRE_SEG_X = 96;
const WIRE_SEG_Y = 64;

// Topo contour lines: one band every CONTOUR_STEP world units of elevation
const CONTOUR_STEP = TERRAIN_HEIGHT_SCALE / 9;

const SCAN_PERIOD = 6; // seconds per ocean scan ring sweep
const SCAN_MAX_RADIUS = 9;

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
 * Inject the sea-level clip + emissive topo contour bands into the standard
 * material — the detail that makes the terrain read as a tactical hologram
 * rather than a wireframe demo. Bands are horizontal slices of elevation.
 */
function injectContours(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vElev;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvElev = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vElev;')
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        {
          if (vElev < ${SEA_LEVEL_CLIP.toFixed(4)}) discard;
          float band = vElev / ${CONTOUR_STEP.toFixed(5)};
          float distToLine = min(fract(band), 1.0 - fract(band));
          // fwidth keeps the lines ~1.5px wide in screen space regardless
          // of slope — fraction-based widths smear out on shallow terrain
          float w = max(fwidth(band), 1e-4);
          float contour = 1.0 - smoothstep(0.75 * w, 2.0 * w, distToLine);
          // fade contours out at sea level so the coast stays clean
          contour *= smoothstep(0.015, 0.06, vElev);
          gl_FragColor.rgb += vec3(0.0, 1.0, 0.255) * contour * 0.25;
        }`,
      );
  };
  // onBeforeCompile changes require a distinct program cache entry
  material.customProgramCacheKey = () => 'holo-contours';
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

export default function Terrain({ reducedMotion, wireframe = true }) {
  const heightImg = useLoader(THREE.ImageLoader, getActiveMap().heightmapUrl);
  const scanRef = useRef();

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

  const solidMaterial = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      color: COLORS.terrain,
      flatShading: true,
      emissive: COLORS.green,
      emissiveIntensity: 0.05,
      roughness: 1,
      metalness: 0,
    });
    injectContours(mat);
    return mat;
  }, []);

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

  // Animated concentric scan ring expanding from the island center
  useFrame(({ clock }) => {
    const ring = scanRef.current;
    if (!ring) return;
    const t = (clock.elapsedTime % SCAN_PERIOD) / SCAN_PERIOD;
    const radius = 0.5 + t * SCAN_MAX_RADIUS;
    ring.scale.setScalar(radius);
    ring.material.opacity = 0.1 * (1 - t);
  });

  return (
    <group>
      {/* Solid pass — near-black green with faint emissive + contour bands */}
      <mesh geometry={geometry} material={solidMaterial} />

      {/* Wireframe pass — the "projected mesh" hologram look, island only */}
      {wireframe && <mesh geometry={wireGeometry} material={wireMaterial} />}

      {/* Ocean void — oversized well past the point the exp2 fog has fully
          saturated (background now matches the fog color too), so its
          literal edge never reads as a visible seam */}
      <mesh rotation-x={-Math.PI / 2} position-y={-0.03}>
        <planeGeometry args={[240, 240]} />
        <meshBasicMaterial color={COLORS.ocean} toneMapped={false} />
      </mesh>

      {/* Expanding ocean scan ring (skipped for reduced motion) */}
      {!reducedMotion && (
        <mesh ref={scanRef} rotation-x={-Math.PI / 2} position-y={0.01}>
          <ringGeometry args={[0.985, 1, 96]} />
          <meshBasicMaterial
            color={COLORS.green}
            transparent
            opacity={0.1}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}
    </group>
  );
}

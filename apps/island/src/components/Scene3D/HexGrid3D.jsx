import { useMemo, useRef, useLayoutEffect, useCallback } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { getActiveMap } from '../../data/maps';
import { axialToWorld, HEX_WORLD_RADIUS, COLORS } from './worldUtils';
import { look } from './look';

// Clicks that follow an orbit drag larger than this (px) are ignored
const DRAG_CLICK_PX = 5;

// Prisms extend this far below the hex-center elevation so sloped terrain
// never shows gaps under the glass
const SINK = 0.25;

// Extrusion heights per visual state (world units)
const EXTRUDE = {
  empty: 0.02,
  hover: 0.10,
  selected: 0.16,
};

// Fills use additive blending, so color brightness doubles as opacity.
// At rest a cell is a dim outline only (look.hexOutline), so the grid sits
// behind the terrain contours; hover and selection light the outline and
// add a low fill.
const FILL = { empty: 0, hover: 0.15, selected: 0.25 };
const RING = { hover: 0.6, selected: 1.0 };

const _color = new THREE.Color();
const _base = new THREE.Color();
const _dummy = new THREE.Object3D();
const GREEN = new THREE.Color(COLORS.green);
const RED = new THREE.Color(COLORS.red);
const FLASH = new THREE.Color(COLORS.flash);

function hexShapePoints(radius) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    pts.push(new THREE.Vector2(radius * Math.cos(a), radius * Math.sin(a)));
  }
  return pts;
}

/** Flat hexagonal ring lying in the XZ plane — the glowing hex outline. */
function makeHexRingGeometry(outer, inner) {
  const shape = new THREE.Shape(hexShapePoints(outer));
  shape.holes.push(new THREE.Path(hexShapePoints(inner).reverse()));
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export default function HexGrid3D({
  selectedHex, onSelectHex, onFocusHex, onHoverChange,
  rippleHexes, wavefrontHexes, warBorderHexes, reducedMotion,
}) {
  const fillsRef = useRef();
  const ringsRef = useRef();
  const hoverRef = useRef(null);
  const extrusionRef = useRef();

  // Land hexes — instanceId -> (q, r) mapping lives in this array's order
  const hexes = useMemo(() => {
    const list = [];
    for (const key of getActiveMap().mask) {
      const [q, r] = key.split(',').map(Number);
      list.push({ q, r, key, world: axialToWorld(q, r) });
    }
    return list;
  }, []);

  if (!extrusionRef.current || extrusionRef.current.length !== hexes.length) {
    extrusionRef.current = new Float32Array(hexes.length).fill(EXTRUDE.empty);
  }

  // Pointy-top hexagonal prism, unit height, base at y=0 (Y-scaled per state).
  // CylinderGeometry's 6 radial segments natively match the SVG orientation:
  // first vertex at +Z = the SVG hex point at +y.
  const prismGeo = useMemo(() => {
    const g = new THREE.CylinderGeometry(HEX_WORLD_RADIUS * 0.94, HEX_WORLD_RADIUS * 0.94, 1, 6);
    g.translate(0, 0.5, 0);
    return g;
  }, []);
  // thin outline, about 2px at the home framing
  const ringGeo = useMemo(
    () => makeHexRingGeometry(HEX_WORLD_RADIUS * 0.97, HEX_WORLD_RADIUS * 0.925),
    [],
  );

  // Initial land layout so raycasting works before the first animation frame
  useLayoutEffect(() => {
    const fills = fillsRef.current;
    const rings = ringsRef.current;
    if (!fills || !rings) return;
    for (let i = 0; i < hexes.length; i++) {
      const { world } = hexes[i];
      _dummy.rotation.set(0, 0, 0);
      _dummy.position.set(world.x, world.y - SINK, world.z);
      _dummy.scale.set(1, SINK + EXTRUDE.empty, 1);
      _dummy.updateMatrix();
      fills.setMatrixAt(i, _dummy.matrix);
      fills.setColorAt(i, _color.copy(GREEN).multiplyScalar(FILL.empty));
      _dummy.position.set(world.x, world.y + EXTRUDE.empty + 0.012, world.z);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      rings.setMatrixAt(i, _dummy.matrix);
      rings.setColorAt(i, _color.copy(GREEN).multiplyScalar(look.hexOutline));
    }
    fills.instanceMatrix.needsUpdate = true;
    rings.instanceMatrix.needsUpdate = true;
    if (fills.instanceColor) fills.instanceColor.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
  }, [hexes]);

  // Per-frame state machine: targets from game state, manual lerp for springs
  useFrame(({ clock }, delta) => {
    const fills = fillsRef.current;
    const rings = ringsRef.current;
    if (!fills || !rings) return;

    const t = clock.elapsedTime;
    const lerpK = 1 - Math.exp(-delta * 12);
    const extrusions = extrusionRef.current;

    for (let i = 0; i < hexes.length; i++) {
      const hex = hexes[i];
      const isSelected = !!selectedHex && selectedHex.q === hex.q && selectedHex.r === hex.r;
      const isHovered = hoverRef.current === hex.key;
      const isWarBorder = !!warBorderHexes?.has(hex.key);
      const isRipple = !!rippleHexes?.has(hex.key);
      const isWavefront = !!wavefrontHexes?.has(hex.key);

      // Base hue: green, red for war border. Per-agent hex tinting belonged
      // to the removed solo-quest flow; the sandbox draws its agents in its
      // own marker layer instead.
      if (isWarBorder) {
        _base.copy(RED);
      } else {
        _base.copy(GREEN);
      }

      let targetExtr;
      let fillLevel;
      let ringLevel;
      if (isSelected) {
        targetExtr = EXTRUDE.selected;
        fillLevel = FILL.selected;
        ringLevel = RING.selected;
      } else if (isHovered) {
        targetExtr = EXTRUDE.hover;
        fillLevel = FILL.hover;
        ringLevel = RING.hover;
      } else {
        targetExtr = EXTRUDE.empty;
        fillLevel = FILL.empty;
        ringLevel = look.hexOutline;
      }

      if (isWarBorder && !reducedMotion) {
        const warPulse = 0.7 + 0.3 * Math.abs(Math.sin((t * Math.PI) / 0.8));
        fillLevel = Math.max(fillLevel, 0.18) * warPulse;
        ringLevel = warPulse;
      }
      if (isWavefront) {
        const wavePulse = reducedMotion ? 0.5 : 0.35 + 0.25 * Math.abs(Math.sin((t * Math.PI) / 0.3));
        _base.lerp(FLASH, 0.4);
        fillLevel = wavePulse;
        ringLevel = 1;
      } else if (isRipple) {
        _base.lerp(FLASH, 0.5);
        fillLevel = Math.max(fillLevel, 0.45);
        ringLevel = 1;
      }

      const extr = extrusions[i] + (targetExtr - extrusions[i]) * lerpK;
      extrusions[i] = extr;

      const { world } = hex;
      _dummy.rotation.set(0, 0, 0);
      _dummy.position.set(world.x, world.y - SINK, world.z);
      _dummy.scale.set(1, SINK + extr, 1);
      _dummy.updateMatrix();
      fills.setMatrixAt(i, _dummy.matrix);
      fills.setColorAt(i, _color.copy(_base).multiplyScalar(fillLevel));

      _dummy.position.set(world.x, world.y + extr + 0.012, world.z);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      rings.setMatrixAt(i, _dummy.matrix);
      rings.setColorAt(i, _color.copy(_base).multiplyScalar(ringLevel));
    }

    fills.instanceMatrix.needsUpdate = true;
    rings.instanceMatrix.needsUpdate = true;
    if (fills.instanceColor) fills.instanceColor.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
  });

  const handleClick = useCallback((e) => {
    e.stopPropagation();
    if (e.delta > DRAG_CLICK_PX) return;
    const hex = hexes[e.instanceId];
    if (hex) onSelectHex(hex.q, hex.r);
  }, [hexes, onSelectHex]);

  const handleDoubleClick = useCallback((e) => {
    e.stopPropagation();
    if (e.delta > DRAG_CLICK_PX) return;
    const hex = hexes[e.instanceId];
    if (hex) onFocusHex?.(hex);
  }, [hexes, onFocusHex]);

  const handlePointerMove = useCallback((e) => {
    const key = hexes[e.instanceId]?.key ?? null;
    if (hoverRef.current !== key) {
      hoverRef.current = key;
      onHoverChange?.(key);
    }
  }, [hexes, onHoverChange]);

  const handlePointerOut = useCallback(() => {
    hoverRef.current = null;
    onHoverChange?.(null);
  }, [onHoverChange]);

  return (
    <group>
      {/* Glassy hex prisms — raycast picking target */}
      <instancedMesh
        ref={fillsRef}
        args={[prismGeo, undefined, hexes.length]}
        frustumCulled={false}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
      >
        <meshBasicMaterial
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>

      {/* Glowing hex outlines riding the prism tops */}
      <instancedMesh
        ref={ringsRef}
        args={[ringGeo, undefined, hexes.length]}
        frustumCulled={false}
        raycast={() => null}
      >
        <meshBasicMaterial
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </instancedMesh>
    </group>
  );
}

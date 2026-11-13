/**
 * Season roster on the war table — one beacon per living agent, tinted with
 * the agent's backend-assigned color in BOTH views (island + crawler).
 *
 * God-view rules: minimal clutter. A beacon, a thin beam, a small name tag.
 * Everything else (HP, thoughts, actions) lives in the roster chips and
 * follow mode. Agents sharing a hex fan out radially so ten spawns never
 * merge into one dot; agents inside a dungeon dim + sink to the mouth hex.
 * Markers glide between hexes (no teleporting) and are click-to-follow.
 *
 * The beacon is the house hologram in the agent's colour: a glowing diamond
 * body under a bright wireframe, a beam down to the ground, and a hex
 * outline on the tile the agent stands on. The followed and the hovered
 * agent get a larger outline that slowly turns and pulses. Underground
 * agents are hollow (wire only), dimmer and have no beam.
 */

import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { axialToWorld, HEX_WORLD_RADIUS, COLORS } from '../Scene3D/worldUtils';
import {
  BEACON, makeMarkerGeometry, makeBeamGeometry, makeHexOutlineGeometry,
} from '../Scene3D/beaconStyle';
import { look } from '../Scene3D/look';

const MAX_AGENTS = 24;
const FAN_RADIUS = HEX_WORLD_RADIUS * 0.42;
const GLIDE = 4.2; // approach rate for marker movement (1/s)
const DESCEND_ALTITUDE = 0.16; // beacon float height while underground
const FALLBACK_COLOR = COLORS.greenBright;

// Brightness of each layer relative to the agent's colour
const FILL_LEVEL = 0.45; // the diamond's body, under its wire
const WIRE_LEVEL = 1;
const UNDER_WIRE_LEVEL = 0.5; // underground: hollow and dimmer
const BEAM_LEVEL = 0.16;
const TILE_LEVEL = 0.7;
const UNDER_TILE_LEVEL = 0.3;

// Tile outline: a grid cell's shape, slightly inset; agents sharing a tile
// nest their outlines inside each other
const TILE_OUTER = HEX_WORLD_RADIUS * 0.86;
const TILE_INNER = HEX_WORLD_RADIUS * 0.8;
const TILE_Y = 0.045; // above the grid's resting outline
const TILE_NEST_STEP = 0.09;
const TILE_NEST_MIN = 0.55;

// Focus outline around the followed / hovered agent
const FOCUS_OUTER = HEX_WORLD_RADIUS * 1.2;
const FOCUS_INNER = HEX_WORLD_RADIUS * 1.13;
const FOCUS_Y = 0.05;
const FOCUS_SPIN = 0.35; // rad/s
const FOCUS_PULSE = 2.4; // rad/s
const FOCUS_OPACITY = 0.85;

const _dummy = new THREE.Object3D();
const _color = new THREE.Color();
const _target = new THREE.Vector3();

/** Stable world-space target for each living agent, with same-hex fan-out. */
function computeTargets(roster, siteAnchors) {
  const byHex = new Map();
  const entries = [];
  for (const agent of roster) {
    if (!agent.alive) continue;
    const pos = agent.position || {};
    const underground = pos.kind === 'dungeon';
    const hex = underground ? siteAnchors[pos.site_id] : pos.hex;
    if (!hex) continue;
    const entry = {
      agent, hex, underground, tint: new THREE.Color(agent.color || FALLBACK_COLOR),
    };
    entries.push(entry);
    if (!byHex.has(hex)) byHex.set(hex, []);
    byHex.get(hex).push(entry);
  }
  for (const cohabitants of byHex.values()) {
    const k = cohabitants.length;
    cohabitants.forEach((entry, i) => {
      const [q, r] = entry.hex.split(',').map(Number);
      const tile = axialToWorld(q, r);
      const world = { ...tile };
      if (k > 1) {
        const angle = (i / k) * Math.PI * 2;
        world.x += Math.cos(angle) * FAN_RADIUS;
        world.z += Math.sin(angle) * FAN_RADIUS;
      }
      entry.target = world;
      entry.tile = tile;
      entry.slot = i;
    });
  }
  return entries;
}

/** Turning, pulsing outline on the tile of `entry`; hidden without one. */
function placeFocus(mesh, material, entry, tilePositions, t, phase, reducedMotion) {
  if (!mesh) return;
  const p = entry && tilePositions.get(entry.agent.agent_id);
  if (!p) {
    mesh.visible = false;
    return;
  }
  mesh.visible = true;
  mesh.position.set(p.x, p.y + FOCUS_Y, p.z);
  const wave = reducedMotion ? 0 : Math.sin(t * FOCUS_PULSE + phase);
  mesh.rotation.y = reducedMotion ? 0 : t * FOCUS_SPIN + phase;
  mesh.scale.setScalar(1 + 0.06 * wave);
  material.color.copy(entry.tint);
  material.opacity = FOCUS_OPACITY * (0.75 + 0.25 * wave);
}

function glowMaterial(extra = {}) {
  return new THREE.MeshBasicMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    ...extra,
  });
}

export default function SandboxAgentMarkers({
  roster, siteAnchors, followedAgentId, onFollow, reducedMotion,
}) {
  const fillsRef = useRef();
  const wiresRef = useRef();
  const beamsRef = useRef();
  const tilesRef = useRef();
  const focusFollowRef = useRef();
  const focusHoverRef = useRef();
  const positionsRef = useRef(new Map()); // agent_id -> THREE.Vector3 (current)
  const tilePositionsRef = useRef(new Map()); // agent_id -> THREE.Vector3 (tile centre)
  const [hoveredId, setHoveredId] = useState(null);

  const markerGeo = useMemo(makeMarkerGeometry, []);
  const beamGeo = useMemo(makeBeamGeometry, []);
  const tileGeo = useMemo(() => makeHexOutlineGeometry(TILE_OUTER, TILE_INNER), []);
  const focusGeo = useMemo(() => makeHexOutlineGeometry(FOCUS_OUTER, FOCUS_INNER), []);

  const materials = useMemo(() => ({
    // glowing body: additive, so an underground agent's black body vanishes
    // and leaves the diamond hollow while staying clickable
    fill: glowMaterial(),
    wire: new THREE.MeshBasicMaterial({
      wireframe: true, transparent: true, depthWrite: false, toneMapped: false,
    }),
    beam: glowMaterial(),
    tile: glowMaterial(),
    focusFollow: glowMaterial({ opacity: FOCUS_OPACITY }),
    focusHover: glowMaterial({ opacity: FOCUS_OPACITY }),
  }), []);

  const entries = useMemo(
    () => computeTargets(roster, siteAnchors || {}).slice(0, MAX_AGENTS),
    [roster, siteAnchors],
  );

  // Instance colors track the roster
  useEffect(() => {
    const fills = fillsRef.current;
    const wires = wiresRef.current;
    const beams = beamsRef.current;
    const tiles = tilesRef.current;
    if (!fills || !wires || !beams || !tiles) return;
    for (let i = 0; i < entries.length; i++) {
      const { tint, underground } = entries[i];
      fills.setColorAt(i, _color.copy(tint).multiplyScalar(underground ? 0 : FILL_LEVEL));
      wires.setColorAt(i, _color.copy(tint).multiplyScalar(underground ? UNDER_WIRE_LEVEL : WIRE_LEVEL));
      beams.setColorAt(i, _color.copy(tint).multiplyScalar(underground ? 0 : BEAM_LEVEL));
      tiles.setColorAt(i, _color.copy(tint).multiplyScalar(underground ? UNDER_TILE_LEVEL : TILE_LEVEL));
    }
    for (const mesh of [fills, wires, beams, tiles]) {
      mesh.count = entries.length;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }, [entries]);

  useFrame(({ clock }, delta) => {
    const fills = fillsRef.current;
    const wires = wiresRef.current;
    const beams = beamsRef.current;
    const tiles = tilesRef.current;
    if (!fills || !wires || !beams || !tiles) return;
    const t = clock.elapsedTime;
    const positions = positionsRef.current;
    const tilePositions = tilePositionsRef.current;
    const glide = reducedMotion ? 1 : Math.min(1, GLIDE * delta);
    materials.beam.color.setScalar(look.agentBeam);
    const n = entries.length;
    fills.count = n;
    wires.count = n;
    beams.count = n;
    tiles.count = n;

    let followIndex = -1;
    let hoverIndex = -1;
    for (let i = 0; i < entries.length; i++) {
      const {
        agent, target, tile, slot, underground,
      } = entries[i];
      let cur = positions.get(agent.agent_id);
      if (!cur) {
        cur = new THREE.Vector3(target.x, target.y, target.z);
        positions.set(agent.agent_id, cur);
      }
      cur.lerp(_target.set(target.x, target.y, target.z), glide);
      let curTile = tilePositions.get(agent.agent_id);
      if (!curTile) {
        curTile = new THREE.Vector3(tile.x, tile.y, tile.z);
        tilePositions.set(agent.agent_id, curTile);
      }
      curTile.lerp(_target.set(tile.x, tile.y, tile.z), glide);

      const followed = agent.agent_id === followedAgentId;
      const hovered = agent.agent_id === hoveredId;
      if (followed) followIndex = i;
      if (hovered) hoverIndex = i;

      const altitude = underground ? DESCEND_ALTITUDE : BEACON.markerAltitude;
      const bob = reducedMotion ? 0
        : Math.sin(t * BEACON.bobSpeed + i * 0.7) * BEACON.bobAmplitude;
      const scale = (followed || hovered ? 1.45 : 1) * (underground ? 0.8 : 1);
      const markerY = cur.y + altitude + bob;

      _dummy.position.set(cur.x, markerY, cur.z);
      _dummy.rotation.set(0, reducedMotion ? 0 : t * BEACON.spinSpeed + i, 0);
      _dummy.scale.setScalar(scale);
      _dummy.updateMatrix();
      fills.setMatrixAt(i, _dummy.matrix);
      wires.setMatrixAt(i, _dummy.matrix);

      // no beam underground
      _dummy.position.set(cur.x, cur.y + 0.04, cur.z);
      _dummy.rotation.set(0, 0, 0);
      if (underground) _dummy.scale.set(0, 0, 0);
      else _dummy.scale.set(1, Math.max(markerY - cur.y - 0.08, 0.02), 1);
      _dummy.updateMatrix();
      beams.setMatrixAt(i, _dummy.matrix);

      const nest = Math.max(1 - slot * TILE_NEST_STEP, TILE_NEST_MIN);
      _dummy.position.set(curTile.x, curTile.y + TILE_Y, curTile.z);
      _dummy.scale.set(nest, 1, nest);
      _dummy.updateMatrix();
      tiles.setMatrixAt(i, _dummy.matrix);
    }
    fills.instanceMatrix.needsUpdate = true;
    // InstancedMesh caches the bounding sphere its raycast tests first;
    // markers move, so refresh it (reuses the same Sphere, 24 instances)
    fills.computeBoundingSphere();
    wires.instanceMatrix.needsUpdate = true;
    beams.instanceMatrix.needsUpdate = true;
    tiles.instanceMatrix.needsUpdate = true;

    // Focus outlines: the followed agent's, and the hovered agent's when it
    // is someone else
    placeFocus(
      focusFollowRef.current, materials.focusFollow,
      entries[followIndex], tilePositions, t, 0, reducedMotion,
    );
    placeFocus(
      focusHoverRef.current, materials.focusHover,
      hoverIndex !== followIndex ? entries[hoverIndex] : undefined,
      tilePositions, t, Math.PI / 6, reducedMotion,
    );
  });

  const handleClick = useCallback((e) => {
    e.stopPropagation();
    const entry = entries[e.instanceId];
    if (entry) onFollow?.(entry.agent);
  }, [entries, onFollow]);

  // Beacons are the one reliably-"occupied" hover target — pointer here
  // never raced with anything since beacons don't overlap each other, and
  // CameraRig no longer touches the cursor at all (grabbing/rotate cursor
  // logic was dropped — camera drag stays plain `default`, same as idle).
  const handleOver = useCallback((e) => {
    e.stopPropagation();
    const entry = entries[e.instanceId];
    setHoveredId(entry ? entry.agent.agent_id : null);
    document.body.style.cursor = entry ? 'pointer' : 'default';
  }, [entries]);

  const handleOut = useCallback(() => {
    setHoveredId(null);
    document.body.style.cursor = 'default';
  }, []);

  return (
    <group>
      {/* Diamond bodies: the click / hover target */}
      <instancedMesh
        ref={fillsRef}
        args={[markerGeo, materials.fill, MAX_AGENTS]}
        frustumCulled={false}
        onClick={handleClick}
        onPointerOver={handleOver}
        onPointerOut={handleOut}
      />

      {/* Bright wire over each diamond */}
      <instancedMesh
        ref={wiresRef}
        args={[markerGeo, materials.wire, MAX_AGENTS]}
        frustumCulled={false}
        renderOrder={1}
        raycast={() => null}
      />

      <instancedMesh
        ref={beamsRef}
        args={[beamGeo, materials.beam, MAX_AGENTS]}
        frustumCulled={false}
        raycast={() => null}
      />

      {/* The tile each agent stands on */}
      <instancedMesh
        ref={tilesRef}
        args={[tileGeo, materials.tile, MAX_AGENTS]}
        frustumCulled={false}
        raycast={() => null}
      />

      <mesh
        ref={focusFollowRef}
        geometry={focusGeo}
        material={materials.focusFollow}
        visible={false}
        raycast={() => null}
      />
      <mesh
        ref={focusHoverRef}
        geometry={focusGeo}
        material={materials.focusHover}
        visible={false}
        raycast={() => null}
      />

      {entries.map(({ agent, target, underground }) => {
        const cur = positionsRef.current.get(agent.agent_id) || target;
        const focus = agent.agent_id === followedAgentId || agent.agent_id === hoveredId;
        return (
          <Html
            key={agent.agent_id}
            position={[cur.x, cur.y + (underground ? DESCEND_ALTITUDE : BEACON.markerAltitude) + 0.17, cur.z]}
            center
            occlude={false}
            zIndexRange={[90, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <div
              className={`sbx-tag${focus ? ' sbx-tag--focus' : ''}${underground ? ' sbx-tag--under' : ''}`}
              style={{ '--tag-color': agent.color }}
            >
              {agent.name}
              {underground && <span className="sbx-tag__depth">▾</span>}
            </div>
          </Html>
        );
      })}
    </group>
  );
}

/**
 * Season roster on the war table — one beacon per living agent, tinted with
 * the agent's backend-assigned color in BOTH views (island + crawler).
 *
 * God-view rules: minimal clutter. A beacon, a thin beam, a small name tag.
 * Everything else (HP, thoughts, actions) lives in the roster chips and
 * follow mode. Agents sharing a hex fan out radially so ten spawns never
 * merge into one dot; agents inside a dungeon dim + sink to the mouth hex.
 * Markers glide between hexes (no teleporting) and are click-to-follow.
 */

import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { axialToWorld, HEX_WORLD_RADIUS } from '../Scene3D/worldUtils';
import { BEACON, makeMarkerGeometry, makeBeamGeometry } from '../Scene3D/beaconStyle';

const MAX_AGENTS = 24;
const FAN_RADIUS = HEX_WORLD_RADIUS * 0.42;
const GLIDE = 4.2; // approach rate for marker movement (1/s)
const DESCEND_ALTITUDE = 0.16; // beacon float height while underground
const _dummy = new THREE.Object3D();
const _color = new THREE.Color();

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
    const entry = { agent, hex, underground };
    entries.push(entry);
    if (!byHex.has(hex)) byHex.set(hex, []);
    byHex.get(hex).push(entry);
  }
  for (const cohabitants of byHex.values()) {
    const k = cohabitants.length;
    cohabitants.forEach((entry, i) => {
      const [q, r] = entry.hex.split(',').map(Number);
      const world = axialToWorld(q, r);
      if (k > 1) {
        const angle = (i / k) * Math.PI * 2;
        world.x += Math.cos(angle) * FAN_RADIUS;
        world.z += Math.sin(angle) * FAN_RADIUS;
      }
      entry.target = world;
    });
  }
  return entries;
}

export default function SandboxAgentMarkers({
  roster, siteAnchors, followedAgentId, onFollow, reducedMotion,
}) {
  const markersRef = useRef();
  const beamsRef = useRef();
  const positionsRef = useRef(new Map()); // agent_id -> THREE.Vector3 (current)
  const [hoveredId, setHoveredId] = useState(null);

  const markerGeo = useMemo(makeMarkerGeometry, []);
  const beamGeo = useMemo(makeBeamGeometry, []);

  const entries = useMemo(
    () => computeTargets(roster, siteAnchors || {}).slice(0, MAX_AGENTS),
    [roster, siteAnchors],
  );

  // Instance colors track the roster (in-combat pulse handled in useFrame)
  useEffect(() => {
    const markers = markersRef.current;
    const beams = beamsRef.current;
    if (!markers || !beams) return;
    for (let i = 0; i < entries.length; i++) {
      _color.set(entries[i].agent.color || '#69ff8f');
      markers.setColorAt(i, _color);
      beams.setColorAt(i, _color.multiplyScalar(entries[i].underground ? 0.06 : 0.16));
    }
    markers.count = entries.length;
    beams.count = entries.length;
    if (markers.instanceColor) markers.instanceColor.needsUpdate = true;
    if (beams.instanceColor) beams.instanceColor.needsUpdate = true;
  }, [entries]);

  useFrame(({ clock }, delta) => {
    const markers = markersRef.current;
    const beams = beamsRef.current;
    if (!markers || !beams) return;
    const t = clock.elapsedTime;
    const positions = positionsRef.current;
    const glide = reducedMotion ? 1 : Math.min(1, GLIDE * delta);

    for (let i = 0; i < entries.length; i++) {
      const { agent, target, underground } = entries[i];
      let cur = positions.get(agent.agent_id);
      if (!cur) {
        cur = new THREE.Vector3(target.x, target.y, target.z);
        positions.set(agent.agent_id, cur);
      }
      cur.lerp(new THREE.Vector3(target.x, target.y, target.z), glide);

      const altitude = underground ? DESCEND_ALTITUDE : BEACON.markerAltitude;
      const bob = reducedMotion ? 0
        : Math.sin(t * BEACON.bobSpeed + i * 0.7) * BEACON.bobAmplitude;
      const focus = agent.agent_id === followedAgentId || agent.agent_id === hoveredId;
      const scale = (focus ? 1.45 : 1) * (underground ? 0.8 : 1);
      const markerY = cur.y + altitude + bob;

      _dummy.position.set(cur.x, markerY, cur.z);
      _dummy.rotation.set(0, reducedMotion ? 0 : t * BEACON.spinSpeed + i, 0);
      _dummy.scale.setScalar(scale);
      _dummy.updateMatrix();
      markers.setMatrixAt(i, _dummy.matrix);

      _dummy.position.set(cur.x, cur.y + 0.04, cur.z);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.set(1, Math.max(markerY - cur.y - 0.08, 0.02), 1);
      _dummy.updateMatrix();
      beams.setMatrixAt(i, _dummy.matrix);
    }
    markers.instanceMatrix.needsUpdate = true;
    beams.instanceMatrix.needsUpdate = true;
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
      <instancedMesh
        ref={markersRef}
        args={[markerGeo, undefined, MAX_AGENTS]}
        frustumCulled={false}
        onClick={handleClick}
        onPointerOver={handleOver}
        onPointerOut={handleOut}
      >
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      <instancedMesh
        ref={beamsRef}
        args={[beamGeo, undefined, MAX_AGENTS]}
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

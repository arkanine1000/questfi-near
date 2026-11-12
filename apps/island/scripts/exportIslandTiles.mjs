#!/usr/bin/env node
/**
 * Export the frontend island tileset to a Python module for the backend.
 *
 * The v2 backend authors its overworld onto these exact hexes so real agents
 * render on the baked 3D war-table island (the god-view). ISLAND_MASK +
 * HEX_ELEVATIONS are the canonical source (themselves generated from the
 * reference image by generateMask.js / generateHeightmap.js).
 *
 * Run from the quest-map repo root:
 *   node scripts/exportIslandTiles.mjs > ../quest_sim/content/island_tiles.py
 */
import { ISLAND_MASK } from '../src/components/HexGrid/hexUtils.js';
import { HEX_ELEVATIONS } from '../src/data/hexElevations.js';

const tiles = [...ISLAND_MASK].map((k) => {
  const [q, r] = k.split(',').map(Number);
  return { q, r, key: k };
});
// Deterministic order: row (r) then column (q).
tiles.sort((a, b) => a.r - b.r || a.q - b.q);

const L = [];
L.push('"""Island overworld tile set — GENERATED, do not edit by hand.');
L.push('');
L.push("Mirror of the quest-map frontend's baked island so the backend can author its");
L.push('overworld onto the exact tiles the 3D war-table scene renders (the god-view).');
L.push('');
L.push('Source of truth (frontend):');
L.push('  quest-map/src/components/HexGrid/hexUtils.js  (ISLAND_MASK)');
L.push('  quest-map/src/data/hexElevations.js           (HEX_ELEVATIONS)');
L.push('Regenerate:');
L.push('  node quest-map/scripts/exportIslandTiles.mjs > quest_sim/content/island_tiles.py');
L.push('"""');
L.push('');
L.push('from __future__ import annotations');
L.push('');
L.push(`# ${tiles.length} land hexes (pointy-top axial q,r), mirroring the FE ISLAND_MASK.`);
L.push('ISLAND_TILES: list[tuple[int, int]] = [');
for (const t of tiles) L.push(`    (${t.q}, ${t.r}),`);
L.push(']');
L.push('');
L.push('# Normalized terrain elevation (0..1) per land hex, keyed "q,r".');
L.push('ISLAND_ELEVATIONS: dict[str, float] = {');
for (const t of tiles) {
  const e = HEX_ELEVATIONS[t.key];
  if (e !== undefined) L.push(`    "${t.key}": ${e},`);
}
L.push('}');
L.push('');

process.stdout.write(L.join('\n'));

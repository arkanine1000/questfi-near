/**
 * Dungeon site-state adapter.
 *
 * Pure functions normalizing the backend's sandbox site-map payload into the
 * scene model the first-person crawler renders.
 *
 * Input mapData shape (from sandboxApi.getSiteMap):
 *   {
 *     grid_rows, grid_cols,
 *     rooms: {
 *       "row,col": {
 *         row, col, room_type, fog, fog_wall, player_here,
 *         connections: { N, S, E, W },          // booleans
 *         entities: [{ type: 'hostile'|'npc'|'invader', id?, name? }],
 *         has_items,
 *       }
 *     }
 *   }
 *
 * Known gaps:
 * - The payload exposes no door-vs-wall detail beyond `connections`.
 * - trap_triggered is not in the payload; trap rooms render their warning
 *   ring as soon as they are explored.
 * - Combat hit/miss/crit detail is not in mapData — it arrives separately
 *   as the tick event list (see Sandbox/sandboxEvents.js).
 */

const EMPTY_DUNGEON_MODEL = {
  gridRows: 0,
  gridCols: 0,
  rooms: [],
  connections: [],
  frontier: [],
  playerRoomId: null,
  combatRoomId: null,
  pvpRoomId: null,
};

const DIRS = { N: [-1, 0], S: [1, 0], E: [0, 1], W: [0, -1] };

/** World-space center of a grid slot (x = col, z = row), 1 unit pitch. */
export function roomToWorld(gridX, gridY, gridCols, gridRows) {
  return {
    x: gridX - (gridCols - 1) / 2,
    z: gridY - (gridRows - 1) / 2,
  };
}

/**
 * Sandbox variant: normalize `GET /world/:id/site/:siteId/map` into the same
 * scene model, focused on one followed agent.
 *
 * The sandbox payload is omniscient (every room, mob hp) and carries a
 * `players` list per room instead of the solo `player_here` flag. The
 * adapter DERIVES `playerRoomId` from wherever the followed agent stands and
 * hoists their co-located rivals into `room.agents` for the crawler's
 * colored-billboard layer. The legacy `adaptMapData` path is untouched.
 */
export function adaptSiteMapData(mapData, followedAgentId) {
  if (!mapData?.rooms) return EMPTY_DUNGEON_MODEL;

  const rooms = [];
  const byId = new Map();
  let playerRoomId = null;

  for (const key of Object.keys(mapData.rooms)) {
    const r = mapData.rooms[key];
    const players = r.players || [];
    const here = players.some((p) => p.agent_id === followedAgentId);
    if (here) playerRoomId = key;
    const room = {
      id: key,
      gridX: r.col,
      gridY: r.row,
      type: r.room_type || 'corridor',
      explored: true, // spectator omniscience — the whole site renders
      visited: r.visited !== false,
      playerHere: here,
      hasItems: !!r.has_items,
      fogWall: false,
      isEntrance: !!r.is_entrance,
      combatActive: !!r.combat?.active,
      pvpActive: !!r.combat?.pvp_active,
      combatantIds: r.combat?.combatant_ids || [],
      hostilePairs: r.combat?.hostile_pairs || [],
      entities: (r.entities || []).map((e) => ({
        type: e.type,
        id: e.id ?? e.name ?? e.type,
        name: e.name ?? null,
        hp: e.hp ?? null,
        maxHp: e.max_hp ?? null,
      })),
      agents: players
        .filter((p) => p.agent_id !== followedAgentId)
        .map((p) => ({
          id: p.agent_id,
          name: p.name,
          color: p.color,
          inCombat: (r.combat?.combatant_ids || []).includes(p.agent_id),
          hostileToPlayer: (r.combat?.hostile_pairs || []).some(
            ([a, b]) => (a === followedAgentId && b === p.agent_id)
              || (b === followedAgentId && a === p.agent_id),
          ),
        })),
      connections: r.connections || {},
    };
    rooms.push(room);
    byId.set(key, room);
  }

  const connections = [];
  for (const room of rooms) {
    for (const [dir, open] of Object.entries(room.connections)) {
      if (!open || !DIRS[dir]) continue;
      const [dr, dc] = DIRS[dir];
      const neighborId = `${room.gridY + dr},${room.gridX + dc}`;
      if (room.id > neighborId) continue;
      if (!byId.has(neighborId)) continue;
      connections.push({ fromId: room.id, toId: neighborId });
    }
  }

  const playerRoom = byId.get(playerRoomId) ?? null;
  const combatRoomId = playerRoom?.combatActive
    || playerRoom?.entities.some((e) => e.type === 'hostile' || e.type === 'invader')
    ? playerRoom.id
    : null;

  return {
    gridRows: mapData.grid_rows ?? 0,
    gridCols: mapData.grid_cols ?? 0,
    siteId: mapData.site_id ?? null,
    siteName: mapData.site_name ?? null,
    isBossSite: !!mapData.is_boss_site,
    rooms,
    connections,
    frontier: [],
    playerRoomId,
    combatRoomId,
    pvpRoomId: playerRoom?.pvpActive ? playerRoom.id : null,
  };
}

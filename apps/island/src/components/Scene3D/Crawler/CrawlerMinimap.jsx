import { useRef, useState } from 'react';

// North-up corner minimap: the dial (room grid + cardinal letters) never
// rotates — "N" always points to the top of the screen. Only the center
// arrow turns to reflect the player's current facing, compass-needle
// style. Same palette as the 2D panel minimap. Rendered from the
// omniscient model; rooms the agent has not visited yet render dimmed.
// Rival agents show as colored pips (bottom-right corner of their room) —
// the map itself stays pointer-events:none, but the pips opt back in so
// clicking one switches spectated agent.

const ROOM_COLORS = {
  entrance: '#00ff41',
  corridor: '#1a6b2a',
  chamber: '#3adf6f',
  boss_room: '#ff0040',
  trap_room: '#ffaa00',
  treasure_room: '#00bfff',
};

const FACING_DEG = { N: 0, E: 90, S: 180, W: 270 };

const CELLPX = 26;
const GAP = 6;
const PITCH = CELLPX + GAP;
const PAD = 8;
const VIEW = 236; // viewport square, px

const DIRS = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

export default function CrawlerMinimap({ model, facing, onSelectAgent }) {
  // The hovered pip, if any — { id, name, color, x, y } in map-svg space
  const [hoveredAgent, setHoveredAgent] = useState(null);

  // Unwrapped cumulative heading so 270° -> 0° eases 90° instead of
  // spinning the long way round. This now drives only the needle arrow —
  // the dial itself stays north-up and never rotates.
  const rotRef = useRef({ facing: 'S', deg: FACING_DEG.S });
  if (facing !== rotRef.current.facing && FACING_DEG[facing] != null) {
    const target = FACING_DEG[facing];
    const cur = rotRef.current.deg;
    const delta = (((target - cur) % 360) + 540) % 360 - 180;
    rotRef.current = { facing, deg: cur + delta };
  }
  const needleRotation = rotRef.current.deg;

  const rooms = model.rooms;
  if (rooms.length === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of rooms) {
    if (r.gridX < minX) minX = r.gridX;
    if (r.gridX > maxX) maxX = r.gridX;
    if (r.gridY < minY) minY = r.gridY;
    if (r.gridY > maxY) maxY = r.gridY;
  }
  const width = (maxX - minX + 1) * PITCH - GAP + PAD * 2;
  const height = (maxY - minY + 1) * PITCH - GAP + PAD * 2;
  const cx = (r) => (r.gridX - minX) * PITCH + PAD + CELLPX / 2;
  const cy = (r) => (r.gridY - minY) * PITCH + PAD + CELLPX / 2;

  const byId = new Map(rooms.map((r) => [r.id, r]));
  const player = byId.get(model.playerRoomId) ?? rooms[0];
  const px = cx(player);
  const py = cy(player);

  const bridges = [];
  for (const room of rooms) {
    for (const [dir, open] of Object.entries(room.connections || {})) {
      if (!open || !DIRS[dir]) continue;
      const [dx, dy] = DIRS[dir];
      const neighborId = `${room.gridY + dy},${room.gridX + dx}`;
      if (!byId.has(neighborId) || room.id > neighborId) continue;
      bridges.push({
        key: `${room.id}-${dir}`,
        x1: cx(room) + dx * (CELLPX / 2),
        y1: cy(room) + dy * (CELLPX / 2),
        x2: cx(room) + dx * (CELLPX / 2 + GAP),
        y2: cy(room) + dy * (CELLPX / 2 + GAP),
      });
    }
  }

  // Fixed screen offsets from the rotor's origin (viewport center) — the
  // dial is north-up and never rotates, so these are plain constants, not
  // something to derive from a rotate() transform.
  const CARDINAL_R = 98; // stays inside the 118px viewport radius
  const cardinals = [
    ['N', 0, -CARDINAL_R],
    ['E', CARDINAL_R, 0],
    ['S', 0, CARDINAL_R],
    ['W', -CARDINAL_R, 0],
  ];

  return (
    <div className="crawler-minimap">
      <div className="crawler-minimap__viewport" style={{ width: VIEW, height: VIEW }}>
        <div className="crawler-minimap__rotor">
          <div
            className="crawler-minimap__maplayer"
            style={{ width, height, transform: `translate(${-px}px, ${-py}px)` }}
          >
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
              {bridges.map((b) => (
                <line key={b.key} x1={b.x1} y1={b.y1} x2={b.x2} y2={b.y2} stroke="rgba(0,255,65,0.5)" strokeWidth="4" />
              ))}
              {rooms.map((room) => {
                const color = ROOM_COLORS[room.type] || ROOM_COLORS.corridor;
                const dim = room.visited === false;
                return (
                  <g key={room.id} opacity={dim ? 0.38 : 1}>
                    <rect
                      x={cx(room) - CELLPX / 2}
                      y={cy(room) - CELLPX / 2}
                      width={CELLPX}
                      height={CELLPX}
                      rx="3"
                      fill={color}
                      fillOpacity={room.id === model.playerRoomId ? 0.42 : dim ? 0.12 : 0.22}
                      stroke={room.fogWall ? '#ff0040' : color}
                      strokeOpacity="0.9"
                      strokeWidth={room.fogWall ? 2 : 1.2}
                      strokeDasharray={dim ? '3 3' : undefined}
                    />
                    {room.isEntrance && (
                      /* sandbox site maps mark exit rooms — circled up-arrow */
                      <g stroke="#00ff41" strokeWidth="1.6">
                        <circle cx={cx(room)} cy={cy(room)} r="7" fill="none" opacity="0.9" />
                        <path
                          d={`M ${cx(room)} ${cy(room) - 3.6} L ${cx(room) - 3.2} ${cy(room) + 2.8} L ${cx(room) + 3.2} ${cy(room) + 2.8} Z`}
                          fill="#00ff41"
                          stroke="none"
                        />
                      </g>
                    )}
                    {room.hasItems && (
                      <circle cx={cx(room) - CELLPX / 2 + 5} cy={cy(room) + CELLPX / 2 - 5} r="3" fill="#ffaa00" />
                    )}
                    {room.entities?.some((e) => e.type === 'hostile') && (
                      <circle cx={cx(room) + CELLPX / 2 - 5} cy={cy(room) - CELLPX / 2 + 5} r="3.6" fill="#ff0040" />
                    )}
                    {room.entities?.some((e) => e.type === 'invader') && (
                      <circle cx={cx(room) + CELLPX / 2 - 5} cy={cy(room) - CELLPX / 2 + 5} r="3.6" fill="#00bfff" />
                    )}
                    {room.entities?.some((e) => e.type === 'npc') && (
                      <circle cx={cx(room) - CELLPX / 2 + 5} cy={cy(room) - CELLPX / 2 + 5} r="3" fill="#7fdfff" />
                    )}
                    {room.agents?.slice(0, 3).map((agent, i) => {
                      const px2 = cx(room) + CELLPX / 2 - 5 - i * 6;
                      const py2 = cy(room) + CELLPX / 2 - 5;
                      return (
                        <circle
                          key={agent.id}
                          cx={px2}
                          cy={py2}
                          r="3.2"
                          fill={agent.color || '#eaffef'}
                          stroke="#010603"
                          strokeWidth="0.8"
                          style={{ pointerEvents: 'auto', cursor: onSelectAgent ? 'pointer' : 'default' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectAgent?.(agent.id);
                          }}
                          onPointerEnter={() => setHoveredAgent({
                            id: agent.id, name: agent.name, color: agent.color, x: px2, y: py2,
                          })}
                          onPointerLeave={() => setHoveredAgent(
                            (h) => (h?.id === agent.id ? null : h),
                          )}
                        />
                      );
                    })}
                  </g>
                );
              })}
            </svg>
          </div>
          {cardinals.map(([letter, dx, dy]) => (
            <div
              key={letter}
              className={`crawler-minimap__cardinal${letter === 'N' ? ' crawler-minimap__cardinal--north' : ''}`}
              style={{ left: dx, top: dy }}
            >
              {letter}
            </div>
          ))}
        </div>
        <svg
          className="crawler-minimap__arrow"
          width="22"
          height="22"
          viewBox="-11 -11 22 22"
          style={{ transform: `translate(-50%, -50%) rotate(${needleRotation}deg)` }}
        >
          <polygon
            points="0,-8 6.4,6.4 0,3.4 -6.4,6.4"
            fill="#eaffef"
            stroke="#00ff41"
            strokeWidth="1.2"
          />
        </svg>
        {/* Hover label — a plain sibling rendered AFTER the arrow (not
            inside the rotor's SVG), so it clears the arrow regardless of
            DOM/paint order. Map-space -> viewport-space: the rotor's
            origin sits at the viewport center and the maplayer is
            translated by (-px,-py), so a map point (x,y) lands at
            (VIEW/2 + x - px, VIEW/2 + y - py). */}
        {hoveredAgent && (
          <div
            className="crawler-minimap__pip-label"
            style={{
              left: VIEW / 2 + (hoveredAgent.x - px),
              top: VIEW / 2 + (hoveredAgent.y - py),
              color: hoveredAgent.color,
              borderColor: hoveredAgent.color,
            }}
          >
            {hoveredAgent.name}
          </div>
        )}
      </div>
    </div>
  );
}

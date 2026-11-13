import { useRef, useState } from 'react';
import { PALETTE, rgba } from '../../../styles/palette';

// The scope: a north-up radar disc in the corner of the dungeon feed, the
// same instrument as Agent World's radar. The dial (room grid and cardinal
// letters) never rotates: N always points to the top of the screen. Only
// the needle at the centre turns, to show which way the agent faces. It is
// drawn from the omniscient site model; rooms the agent has not visited yet
// are dimmed.
//
// Other agents in the site are pips in the corner of their room. The scope
// itself takes no pointer events, but the pips opt back in so clicking one
// follows that agent instead (unless no handler is given, as on the TV).
//
// The geometry below (a 236px viewport, 26px cells with a 6px gap, the
// cardinal letters at radius 98) is what styles/cam.css is built around;
// change them together.

// Room fills and outlines by kind, in the house palette: green is plain
// ground, red is danger (the boss solid, a trap dashed), amber is treasure.
const ROOM_STYLES = {
  entrance: { stroke: PALETTE.greenBright, fill: PALETTE.greenBright, fillOpacity: 0.28 },
  corridor: { stroke: rgba(PALETTE.green, 0.45), fill: PALETTE.greenDeep, fillOpacity: 0.85 },
  chamber: { stroke: PALETTE.green, fill: PALETTE.green, fillOpacity: 0.18 },
  boss_room: { stroke: PALETTE.red, fill: PALETTE.red, fillOpacity: 0.3 },
  trap_room: { stroke: PALETTE.red, fill: PALETTE.red, fillOpacity: 0.08, dash: '3 2' },
  treasure_room: { stroke: PALETTE.amber, fill: PALETTE.amber, fillOpacity: 0.22 },
};

const FACING_DEG = { N: 0, E: 90, S: 180, W: 270 };

const CELLPX = 26;
const GAP = 6;
const PITCH = CELLPX + GAP;
const PAD = 8;
const VIEW = 236; // viewport square, px

const DIRS = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

export default function CrawlerMinimap({ model, facing, onSelectAgent }) {
  // The hovered (or focused) pip, if any: { id, name, color, x, y } in map-svg space
  const [hoveredAgent, setHoveredAgent] = useState(null);

  // Unwrapped cumulative heading so 270° -> 0° eases 90° instead of
  // spinning the long way round. Only the needle turns.
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

  // Fixed screen offsets from the rotor's origin (viewport center): the
  // dial is north-up and never rotates, so these are plain constants.
  const CARDINAL_R = 98; // inside the inner ring of the 118px-radius disc
  const cardinals = [
    ['N', 0, -CARDINAL_R],
    ['E', CARDINAL_R, 0],
    ['S', 0, CARDINAL_R],
    ['W', -CARDINAL_R, 0],
  ];

  const selectable = typeof onSelectAgent === 'function';
  const hover = (agent, x, y) => setHoveredAgent({
    id: agent.id, name: agent.name, color: agent.color || PALETTE.ice, x, y,
  });
  const unhover = (agent) => setHoveredAgent((h) => (h?.id === agent.id ? null : h));

  return (
    <div className="qf-cam-scope">
      <div className="qf-cam-scope__disc" style={{ width: VIEW, height: VIEW }}>
        <div className="qf-cam-scope__rotor">
          <div
            className="qf-cam-scope__map"
            style={{ width, height, transform: `translate(${-px}px, ${-py}px)` }}
          >
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
              {bridges.map((b) => (
                <line
                  key={b.key}
                  x1={b.x1}
                  y1={b.y1}
                  x2={b.x2}
                  y2={b.y2}
                  stroke={rgba(PALETTE.green, 0.45)}
                  strokeWidth="4"
                />
              ))}
              {rooms.map((room) => {
                const look = ROOM_STYLES[room.type] || ROOM_STYLES.corridor;
                const here = room.id === model.playerRoomId;
                // the agent is standing in its own room: that one never dims
                const dim = room.visited === false && !here;
                const x0 = cx(room) - CELLPX / 2;
                const y0 = cy(room) - CELLPX / 2;
                return (
                  <g key={room.id}>
                    <g opacity={dim ? 0.38 : 1}>
                      <rect
                        x={x0}
                        y={y0}
                        width={CELLPX}
                        height={CELLPX}
                        fill={look.fill}
                        fillOpacity={here ? look.fillOpacity + 0.22 : dim ? look.fillOpacity * 0.6 : look.fillOpacity}
                        stroke={room.fogWall ? PALETTE.red : look.stroke}
                        strokeOpacity="0.9"
                        strokeWidth={room.fogWall ? 2 : here ? 1.6 : 1.2}
                        strokeDasharray={room.fogWall ? undefined : look.dash}
                      />
                      {room.isEntrance && (
                        /* sandbox site maps mark the way out: a circled up-arrow */
                        <g stroke={PALETTE.greenBright} strokeWidth="1.6">
                          <circle cx={cx(room)} cy={cy(room)} r="7" fill="none" opacity="0.9" />
                          <path
                            d={`M ${cx(room)} ${cy(room) - 3.6} L ${cx(room) - 3.2} ${cy(room) + 2.8} L ${cx(room) + 3.2} ${cy(room) + 2.8} Z`}
                            fill={PALETTE.greenBright}
                            stroke="none"
                          />
                        </g>
                      )}
                      {room.hasItems && (
                        <rect x={x0 + 2.5} y={y0 + CELLPX - 7.5} width="5" height="5" fill={PALETTE.amber} />
                      )}
                      {room.entities?.some((e) => e.type === 'hostile') && (
                        <circle cx={x0 + CELLPX - 5} cy={y0 + 5} r="3.4" fill={PALETTE.red} />
                      )}
                      {room.entities?.some((e) => e.type === 'invader') && (
                        <circle cx={x0 + CELLPX - 5} cy={y0 + 5} r="3.4" fill={PALETTE.ice} />
                      )}
                      {room.entities?.some((e) => e.type === 'npc') && (
                        <circle cx={x0 + 5} cy={y0 + 5} r="3" fill={PALETTE.ice} />
                      )}
                    </g>
                    {/* other agents are live: their pips never dim with the room */}
                    {room.agents?.slice(0, 3).map((agent, i) => {
                      const ax = x0 + CELLPX - 5 - i * 6;
                      const ay = y0 + CELLPX - 5;
                      const color = agent.color || PALETTE.ice;
                      const hovered = hoveredAgent?.id === agent.id;
                      return (
                        <g key={agent.id}>
                          {hovered && (
                            <circle cx={ax} cy={ay} r="6" fill="none" stroke={color} strokeWidth="1.2" />
                          )}
                          <circle
                            cx={ax}
                            cy={ay}
                            r="3.2"
                            fill={color}
                            stroke={PALETTE.bg}
                            strokeWidth="0.8"
                          />
                          {selectable && (
                            /* a larger, invisible hit area: the pip itself is a 6px dot */
                            <circle
                              className="qf-cam-scope__pip"
                              cx={ax}
                              cy={ay}
                              r="5"
                              fill="transparent"
                              role="button"
                              tabIndex={0}
                              aria-label={`Follow ${agent.name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectAgent(agent.id);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  onSelectAgent(agent.id);
                                }
                              }}
                              onPointerEnter={() => hover(agent, ax, ay)}
                              onPointerLeave={() => unhover(agent)}
                              onFocus={() => hover(agent, ax, ay)}
                              onBlur={() => unhover(agent)}
                            />
                          )}
                        </g>
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
              className={`qf-cam-scope__cardinal${letter === 'N' ? ' is-north' : ''}`}
              style={{ left: dx, top: dy }}
            >
              {letter}
            </div>
          ))}
        </div>
        <svg
          className="qf-cam-scope__needle"
          width="22"
          height="22"
          viewBox="-11 -11 22 22"
          style={{ transform: `translate(-50%, -50%) rotate(${needleRotation}deg)` }}
          aria-hidden="true"
        >
          <polygon points="0,-8 6.4,6.4 0,3.4 -6.4,6.4" strokeWidth="1" />
        </svg>
        {/* Hover label: a plain sibling rendered AFTER the needle (not
            inside the rotor's SVG), so it clears the needle whatever the
            paint order. Map-space -> viewport-space: the rotor's origin sits
            at the viewport center and the map layer is translated by
            (-px,-py), so a map point (x,y) lands at
            (VIEW/2 + x - px, VIEW/2 + y - py). */}
        {hoveredAgent && (
          <div
            className="qf-cam-scope__tag"
            style={{
              left: VIEW / 2 + (hoveredAgent.x - px),
              top: VIEW / 2 + (hoveredAgent.y - py),
              '--pip': hoveredAgent.color,
            }}
          >
            {hoveredAgent.name}
          </div>
        )}
      </div>
    </div>
  );
}

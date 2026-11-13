import { useEffect, useRef, useState } from 'react';
import { weaponSpecFor } from './weaponCatalog';
import Typewriter from '../../Typewriter';
import { IconDanger, IconFlag, IconThought } from '../../ui/icons';

// The overlay of the followed agent's body camera, drawn over the dungeon
// feed. It is a readout, never a control: the viewer is watching what the
// agent lives through. Everything sits inside the stage (the clear area
// between the frame's side columns), in its corners:
//
//   feed line (REC, who, where)                          scope (the minimap)
//                       target (in a fight only)
//
//   combat log
//   vitals                    thoughts                              weapon
//                       (the caster's band below)
//
// The element is a size container named `cam`; styles/cam.css adapts the
// plates to the width of the stage rather than of the window.

// The combat log keeps the last three beats. It never climbs past the middle
// of the stage: lines that do not fit are hidden whole (see cam.css).
const LOG_LINES = 3;

// The followed agent's room, as the pill in the feed line names it, and the
// colour its meaning gets (red for danger, amber for treasure).
const ROOM_KINDS = {
  entrance: { label: 'Entrance' },
  corridor: { label: 'Corridor' },
  chamber: { label: 'Chamber' },
  trap_room: { label: 'Trap', tone: 'red' },
  treasure_room: { label: 'Treasure', tone: 'amber' },
  boss_room: { label: 'Boss', tone: 'red' },
};

/** Percent of a health pool, or null when either number is unknown. */
function hpPercent(hp, maxHp) {
  if (hp == null || !maxHp) return null;
  return Math.max(0, Math.min(100, (hp / maxHp) * 100));
}

// Damage-drain ghost: on a hit, the ghost holds at the PRE-damage width (in
// pale ink, behind the fill) while the real fill has already snapped to the
// new value, then eases down to meet it: the lighter sliver that peels off
// and drains. Healing and the first paint skip the hold, since there is
// nothing to drain. The caller keys the target's bar by target id, so a new
// target starts fresh instead of reading as a drain between two creatures.
function HpBar({ hp, maxHp, className }) {
  const pct = hpPercent(hp, maxHp);

  const [ghostPct, setGhostPct] = useState(pct);
  const prevPctRef = useRef(pct);

  useEffect(() => {
    const prev = prevPctRef.current;
    prevPctRef.current = pct;
    if (pct == null || prev == null || pct >= prev) {
      setGhostPct(pct);
      return undefined;
    }
    const t = setTimeout(() => setGhostPct(pct), 150);
    return () => clearTimeout(t);
  }, [pct]);

  // An unknown pool reads as a faint full bar rather than an empty one.
  return (
    <div className={`qf-cam-hp ${className}`} aria-hidden="true">
      <i
        className="qf-cam-hp__ghost"
        style={{ width: ghostPct != null ? `${ghostPct}%` : '100%', opacity: ghostPct != null ? undefined : 0.2 }}
      />
      <i
        className="qf-cam-hp__fill"
        style={{ width: pct != null ? `${pct}%` : '100%', opacity: pct != null ? undefined : 0.25 }}
      />
    </div>
  );
}

function HuntedPill({ where }) {
  return (
    <span className={`qf-cam-pill qf-cam-pill--red qf-cam-hunted-pill is-${where}`}>
      <IconDanger size={11} />
      Hunted
    </span>
  );
}

// Two rows: who (REC, HUNTED, the name), then where (the site, the room).
// On a narrow stage HUNTED moves down beside the room, so the first row is
// just REC and the name; it is rendered in both rows and cam.css shows one.
function FeedLine({ agentName, siteName, roomType, tick, hunted }) {
  const room = ROOM_KINDS[roomType];
  return (
    <div className="qf-cam-feed">
      <div className="qf-cam-feed__main">
        <div className="qf-cam-feed__row">
          <span className="qf-cam-rec">
            <i className="qf-dot qf-dot--live" />
            REC
          </span>
          {hunted && <HuntedPill where="who" />}
          <span className="qf-cam-feed__name">{agentName}</span>
        </div>
        {(siteName || room || hunted) && (
          <div className="qf-cam-feed__row qf-cam-feed__row--where">
            {hunted && <HuntedPill where="where" />}
            {siteName && <span className="qf-cam-feed__site">{siteName}</span>}
            {room && (
              <span className={`qf-cam-pill${room.tone ? ` qf-cam-pill--${room.tone}` : ''}`}>
                {room.label}
              </span>
            )}
          </div>
        )}
      </div>
      {tick != null && (
        <div className="qf-cam-feed__tick">TICK {String(tick).padStart(3, '0')}</div>
      )}
    </div>
  );
}

function TargetPlate({ target }) {
  const known = target.hp != null && target.maxHp != null;
  return (
    <div
      className={`qf-cam-target${target.invader ? ' is-rival' : ''}`}
      style={target.invader && target.color ? { '--rival': target.color } : undefined}
    >
      <div className="qf-cam-target__head">
        <span className="qf-cam-target__label">Target</span>
        <span className="qf-cam-target__name">{target.name}</span>
        <span className="qf-cam-target__hp">
          {known ? `${target.hp} / ${target.maxHp}` : '??'}
          <small>HP</small>
        </span>
      </div>
      <HpBar key={target.id} hp={target.hp} maxHp={target.maxHp} className="qf-cam-hp--thin" />
    </div>
  );
}

function Vitals({ agentName, hp, maxHp, reducedMotion }) {
  const low = hp != null && maxHp && hp / maxHp <= 0.3;

  // Each drop in health replays a short red flash on the plate's edge.
  const [hits, setHits] = useState(0);
  const prevHpRef = useRef(hp);
  useEffect(() => {
    const prev = prevHpRef.current;
    prevHpRef.current = hp;
    if (!reducedMotion && prev != null && hp != null && hp < prev) setHits((n) => n + 1);
  }, [hp, reducedMotion]);

  return (
    <div className={`qf-cam-vitals${low ? ' is-low' : ''}`}>
      {hits > 0 && <i key={hits} className="qf-cam-vitals__hit" aria-hidden="true" />}
      <div className="qf-cam-vitals__head">
        <span className="qf-cam-vitals__name">{agentName}</span>
        <span className="qf-cam-vitals__tag">Vitals</span>
      </div>
      <div className="qf-cam-vitals__num">
        {hp}
        {maxHp != null && <small>/ {maxHp}</small>}
      </div>
      <HpBar hp={hp} maxHp={maxHp} className="qf-cam-hp--seg" />
    </div>
  );
}

function WeaponPlate({ weapon }) {
  const WeaponIcon = weaponSpecFor(weapon.name).icon;
  return (
    <div className="qf-cam-weapon">
      <WeaponIcon className="qf-cam-weapon__glyph" size={28} aria-hidden />
      <div className="qf-cam-weapon__text">
        <div className="qf-cam-weapon__label">Weapon</div>
        <div className="qf-cam-weapon__name">{weapon.name}</div>
        {weapon.damageBonus != null && (
          <div className="qf-cam-weapon__dmg">
            {weapon.damageBonus >= 0 ? '+' : ''}
            {weapon.damageBonus}
            <small>DMG</small>
          </div>
        )}
      </div>
    </div>
  );
}

function Thoughts({ thoughts, agentName, gameOver, gameOverMsg, reducedMotion }) {
  // Two cards at most: the newest in full, the one before it as a single
  // dimmed line above. When the quest ends, its card becomes the newest.
  const newest = gameOver ? null : thoughts[thoughts.length - 1] ?? null;
  const previous = gameOver ? thoughts[thoughts.length - 1] : thoughts[thoughts.length - 2];
  if (!newest && !previous && !gameOver) return null;

  return (
    <div className="qf-cam-thoughts">
      {previous && (
        <div key={previous.id} className="qf-cam-thought qf-cam-thought--old">{previous.text}</div>
      )}
      {newest && (
        <div key={newest.id} className="qf-cam-thought">
          <div className="qf-cam-thought__head">
            <IconThought size={12} />
            <span>{agentName} · Thinking</span>
          </div>
          <div className="qf-cam-thought__text">
            <Typewriter text={newest.text} reducedMotion={reducedMotion} />
          </div>
        </div>
      )}
      {gameOver && (
        <div className="qf-cam-thought qf-cam-thought--done">
          <div className="qf-cam-thought__head">
            <IconFlag size={12} />
            <span>Quest complete</span>
          </div>
          {gameOverMsg && <div className="qf-cam-thought__text">{gameOverMsg}</div>}
        </div>
      )}
    </div>
  );
}

export default function CrawlerHud({
  queue, thoughts, agentName, siteName, roomType, tick, hunted, live,
  hp, maxHp, weapon, target, gameOver, gameOverMsg, reducedMotion, children,
}) {
  const [log, setLog] = useState([]);
  const [flash, setFlash] = useState(null); // { id, tone }
  const flashIdRef = useRef(0);

  // Beat starts feed the combat log and the flash washes
  useEffect(() => queue.subscribe((event, b) => {
    if (event !== 'start') return;
    const hurt = (b.kind === 'damage' && b.player) || b.kind === 'trap' || (b.kind === 'death' && b.player);
    if (b.label) {
      const tone = hurt ? 'red' : b.kind === 'loot' ? 'amber' : '';
      setLog((prev) => [...prev.slice(-(LOG_LINES - 1)), { id: b.id, label: b.label, tone }]);
    }
    if (reducedMotion) return;
    if (hurt) {
      flashIdRef.current += 1;
      setFlash({ id: flashIdRef.current, tone: 'red' });
    } else if (b.kind === 'victory' || (b.kind === 'attack' && b.byPlayer && b.crit)) {
      flashIdRef.current += 1;
      setFlash({ id: flashIdRef.current, tone: 'pale' });
    }
  }), [queue, reducedMotion]);

  const cls = ['qf-cam-hud', 'qf-frame', live ? 'is-live' : '', hunted ? 'is-hunted' : '']
    .filter(Boolean).join(' ');

  return (
    <div className={cls}>
      <div className="qf-cam-layer">
        {/* washes first, so every plate stays crisp above them */}
        {hunted && <div className="qf-cam-hunted" aria-hidden="true" />}
        {flash && (
          <div key={flash.id} className={`qf-cam-flash qf-cam-flash--${flash.tone}`} aria-hidden="true" />
        )}

        <FeedLine
          agentName={agentName}
          siteName={siteName}
          roomType={roomType}
          tick={tick}
          hunted={hunted}
        />

        {/* the scope (the minimap), passed in by the crawler */}
        {children}

        {target && <TargetPlate target={target} />}

        <div className="qf-cam-left">
          {/* newest first in the DOM: the log stacks upward from the vitals */}
          <div className="qf-cam-log">
            {[...log].reverse().map((line) => (
              <div key={line.id} className={`qf-cam-log__line${line.tone ? ` is-${line.tone}` : ''}`}>
                <span>{line.label}</span>
              </div>
            ))}
          </div>
          {hp != null && (
            <Vitals agentName={agentName} hp={hp} maxHp={maxHp} reducedMotion={reducedMotion} />
          )}
        </div>

        {weapon && <WeaponPlate weapon={weapon} />}

        <Thoughts
          thoughts={thoughts}
          agentName={agentName}
          gameOver={gameOver}
          gameOverMsg={gameOverMsg}
          reducedMotion={reducedMotion}
        />
      </div>
    </div>
  );
}

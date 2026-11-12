import { useEffect, useRef, useState } from 'react';
import { weaponSpecFor } from './weaponCatalog';
import Typewriter from '../../Typewriter';

// DOM overlay riding on top of the crawler canvas, in the concept-art
// plate language: TARGET plate (top-left, combat only), COMBAT LOG
// (bottom-left), WEAPON plate (bottom-right), a prominent player VITALS
// plate + thought toasts (bottom-center), and damage/victory washes.
// Pointer events stay off except on the log toggle.

const LOG_LINES = 6;

// Damage-drain ghost: on a hit, this holds at the PRE-damage width (a
// lightened tint of the fill color, see .crawler-plate__bar-ghost) while
// the real fill has already snapped to the new value underneath it, then
// eases down to meet it — the classic "lightened sliver peels off and
// drains" readout. Healing and the first paint skip the hold, since
// there's nothing to drain. The caller keys this by target id so
// switching targets resets state instead of reading as a drain between
// two unrelated creatures' HP.
function HpBar({ hp, maxHp, low }) {
  const pct = hp != null && maxHp
    ? Math.max(0, Math.min(100, (hp / maxHp) * 100))
    : null;

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

  return (
    <div className="crawler-plate__bar">
      <div
        className="crawler-plate__bar-ghost"
        style={{ width: ghostPct != null ? `${ghostPct}%` : '100%', opacity: ghostPct != null ? 1 : 0.25 }}
      />
      <div
        className={`crawler-plate__bar-fill${low ? ' crawler-plate__bar-fill--low' : ''}`}
        style={{ width: pct != null ? `${pct}%` : '100%', opacity: pct != null ? 1 : 0.25 }}
      />
    </div>
  );
}

export default function CrawlerHud({
  queue, thoughts, agentName, hp, maxHp, weapon, target,
  gameOver, gameOverMsg, reducedMotion,
}) {
  const [log, setLog] = useState([]);
  const [logOpen, setLogOpen] = useState(false); // collapsed by default
  const [flash, setFlash] = useState(null); // { id, color }
  const flashIdRef = useRef(0);

  // Beat starts feed the combat log + the flash washes
  useEffect(() => queue.subscribe((event, b) => {
    if (event !== 'start') return;
    if (b.label) {
      setLog((prev) => [...prev.slice(-(LOG_LINES - 1)), { id: b.id, label: b.label }]);
    }
    if (reducedMotion) return;
    if ((b.kind === 'damage' && b.player) || b.kind === 'trap' || (b.kind === 'death' && b.player)) {
      flashIdRef.current += 1;
      setFlash({ id: flashIdRef.current, color: 'red' });
    } else if (b.kind === 'victory' || (b.kind === 'attack' && b.byPlayer && b.crit)) {
      flashIdRef.current += 1;
      setFlash({ id: flashIdRef.current, color: 'white' });
    }
  }), [queue, reducedMotion]);

  const hpLow = hp != null && maxHp && hp / maxHp <= 0.3;

  return (
    <div className="crawler-hud">
      {/* TARGET plate — combat only */}
      {target && (
        <div className={`crawler-plate crawler-plate--target${target.invader ? ' crawler-plate--invader' : ''}`}>
          <div className="crawler-plate__header">TARGET</div>
          <div className="crawler-plate__title">{target.name}</div>
          <HpBar key={target.id} hp={target.hp} maxHp={target.maxHp} low={false} />
          <div className="crawler-plate__row">
            {target.hp != null && target.maxHp != null
              ? `${target.hp} / ${target.maxHp} HP`
              : '?? HP'}
          </div>
        </div>
      )}

      {/* COMBAT LOG — bottom left, collapsible (starts collapsed: the
          latest line stays visible as a one-line peek) */}
      {log.length > 0 && (
        <div className={`crawler-plate crawler-plate--log${logOpen ? '' : ' crawler-plate--log-collapsed'}`}>
          <button
            className="crawler-plate__log-toggle"
            onClick={() => setLogOpen((o) => !o)}
          >
            COMBAT LOG {logOpen ? '▾' : '▸'}
          </button>
          {logOpen
            ? log.map((line) => (
              <div key={line.id} className="crawler-plate__log-line">{'> '}{line.label}</div>
            ))
            : (
              <div key={log[log.length - 1].id} className="crawler-plate__log-line">
                {'> '}{log[log.length - 1].label}
              </div>
            )}
        </div>
      )}

      {/* WEAPON plate — bottom right, glyph matches the equipped weapon */}
      {weapon && (() => {
        const WeaponIcon = weaponSpecFor(weapon.name).icon;
        return (
          <div className="crawler-plate crawler-plate--weapon">
            <WeaponIcon className="crawler-plate__wicon" aria-hidden />
            <div className="crawler-plate__wtext">
              <div className="crawler-plate__header">WEAPON</div>
              <div className="crawler-plate__title">{weapon.name}</div>
              {weapon.damageBonus != null && (
                <div className="crawler-plate__row">+{weapon.damageBonus} DMG</div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Health orb — bottom right, under the weapon card */}
      {hp != null && (
        <div className="crawler-hud__orbwrap">
          <div className="crawler-hud__orbname">{agentName}</div>
          <div className={`crawler-orb${hpLow ? ' crawler-orb--low' : ''}`}>
            <div
              className="crawler-orb__fill"
              // The slosh overlay (::after) carves a moving waterline into
              // the top of the fill, so a literal 100% never visually
              // reaches the rim — remap into a wider range so full HP
              // actually reads full and empty HP actually reads empty.
              style={{ height: `${10 + Math.max(0, Math.min(100, maxHp ? (hp / maxHp) * 100 : 100)) * 1.05}%` }}
            />
            <div className="crawler-orb__label">
              {hp}
              {maxHp != null && <span>/{maxHp}</span>}
            </div>
          </div>
        </div>
      )}

      {/* Bottom center column: thought toasts */}
      <div className="crawler-hud__bottom">
        {(thoughts.length > 0 || gameOver) && (
          <div className="crawler-hud__thoughts">
            {thoughts.map((th, i) => {
              const isLatest = i === thoughts.length - 1;
              return (
                <div
                  key={th.id}
                  className={`crawler-hud__thought${isLatest ? '' : ' crawler-hud__thought--old'}`}
                >
                  <span className="crawler-hud__thought-label">{'> '}{agentName} (thinking)</span>
                  <span className="crawler-hud__thought-text">
                    {isLatest && !gameOver
                      ? <Typewriter text={th.text} reducedMotion={reducedMotion} />
                      : th.text}
                  </span>
                </div>
              );
            })}
            {gameOver && (
              <div className="crawler-hud__thought">
                <span className="crawler-hud__gameover">
                  {'> QUEST COMPLETE'}{gameOverMsg ? ` — ${gameOverMsg}` : ''}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Damage / victory washes — keyed div per beat, CSS fades it out */}
      {flash && (
        <div key={flash.id} className={`crawler-hud__flash crawler-hud__flash--${flash.color}`} />
      )}
    </div>
  );
}

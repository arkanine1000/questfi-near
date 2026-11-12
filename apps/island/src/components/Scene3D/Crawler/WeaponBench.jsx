import { useCallback, useEffect, useMemo, useState } from 'react';
import CrawlerScene from './CrawlerScene';
import { createBeatQueue } from './crawlerEvents';
import { adaptSiteMapData } from '../dungeonAdapter';
import { weaponSpecFor } from './weaponCatalog';
import { preloadCrawlerAssets } from './crawlerAssets';

/**
 * Dev harness for first-person weapon viewmodels — `?bench=weapon`.
 *
 * Mounts the crawler scene against a fabricated one-room site with a hostile
 * already in combat, so a viewmodel can be looked at without running a season
 * and waiting for an agent to find the weapon. No backend, no SSE, no roster.
 *
 * It exists because a weapon's hold transform is the one part of it no test
 * can check — it has to be looked at. The nudge keys write straight into the
 * live catalog spec and the readout prints a paste-ready snippet, so dialing
 * one in is a loop inside a single page load rather than an edit-reload cycle.
 *
 * Dev-only: App.jsx gates the import on `import.meta.env.DEV`, so none of
 * this reaches a production bundle.
 */

const PLAYER_ID = 'bench-player';

const ENEMIES = ['skeleton', 'wraith', 'shadow', 'harpy', 'mage', 'aethermaw'];

// One name per distinct viewmodel path: the accordion (own hold transform +
// deform rig), the archetypes build.py's loot re-tier actually produces, and
// the unarmed fallback. Cycling these is how you check that a change to the
// special-cased weapon left the shared blade pipeline alone.
const WEAPONS = [
  'War Accordion',
  'Runed Greatsword',
  "Exalted Reaver's Scythe",
  'Sovereign Warhammer',
  'Tempered Boar Spear',
  'bare hands',
];

const BEAT_DUR = { attack: 0.4, move: 0.5 };

/** A one-room site payload in the shape `GET /world/:id/site/:id/map` returns. */
function benchMapData(enemyId) {
  return {
    site_id: 'bench',
    site_name: 'Weapon Bench',
    grid_rows: 1,
    grid_cols: 1,
    is_boss_site: enemyId === 'aethermaw',
    rooms: {
      '0,0': {
        row: 0,
        col: 0,
        room_type: 'chamber',
        visited: true,
        is_entrance: true,
        connections: {},
        players: [{ agent_id: PLAYER_ID, name: 'Bench', color: '#69ff8f' }],
        entities: [{ type: 'hostile', id: enemyId, name: enemyId, hp: 20, max_hp: 20 }],
        combat: { active: true, combatant_ids: [PLAYER_ID, enemyId] },
      },
    },
  };
}

// offset axis, rotation axis, and the sign each key applies.
const NUDGE_KEYS = {
  ArrowRight: ['offset', 0, +1],
  ArrowLeft: ['offset', 0, -1],
  ArrowUp: ['offset', 1, +1],
  ArrowDown: ['offset', 1, -1],
  PageUp: ['offset', 2, +1],
  PageDown: ['offset', 2, -1],
  i: ['rotation', 0, +1],
  k: ['rotation', 0, -1],
  j: ['rotation', 1, +1],
  l: ['rotation', 1, -1],
  u: ['rotation', 2, +1],
  o: ['rotation', 2, -1],
};

const HELP = [
  'space attack   b parry   m move   a auto-loop',
  'w weapon   e enemy   r reduced-motion',
];
const HOLD_HELP = 'arrows/pgup/pgdn offset   ijkluo rotation   +/- scale   (shift = fine)';

const fmt = (n) => Number(n.toFixed(3));

const PANEL = {
  position: 'absolute',
  padding: '10px 14px',
  font: '12px/1.55 ui-monospace, monospace',
  background: 'rgba(0, 20, 8, 0.82)',
  border: '1px solid #1c6b3a',
  borderRadius: 6,
  whiteSpace: 'pre',
};

export default function WeaponBench() {
  const [enemyIdx, setEnemyIdx] = useState(0);
  const [weaponIdx, setWeaponIdx] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [auto, setAuto] = useState(false);
  const [activeBeat, setActiveBeat] = useState(null);
  // `scale` is baked into the viewmodel's useMemo (unlike offset/rotation,
  // which are read per frame), so changing it has to remount the canvas.
  const [rebuild, setRebuild] = useState(0);
  // The nudge keys mutate the catalog spec in place; nothing about that is
  // React state, so the readout needs an explicit poke to repaint.
  const [readoutTick, setReadoutTick] = useState(0);

  const enemy = ENEMIES[enemyIdx];
  const weaponName = WEAPONS[weaponIdx];
  const spec = weaponSpecFor(weaponName);
  const hold = spec.hold ?? null;

  const queue = useMemo(() => createBeatQueue(), []);
  const model = useMemo(() => adaptSiteMapData(benchMapData(enemy), PLAYER_ID), [enemy]);

  const push = useCallback((kind, extra) => {
    queue.enqueue([{ id: `bench-${Date.now()}-${Math.random()}`, kind, dur: BEAT_DUR[kind], ...extra }]);
  }, [queue]);

  const swing = useCallback(
    () => push('attack', { byPlayer: true, hit: true, attackerId: PLAYER_ID, targetId: enemy }),
    [push, enemy],
  );

  useEffect(() => { preloadCrawlerAssets(WEAPONS); }, []);

  useEffect(() => queue.subscribe((event, beat) => {
    setActiveBeat(event === 'start' ? beat : (cur) => (cur?.id === beat.id ? null : cur));
  }), [queue]);

  // Auto-loop, for watching an animation on repeat with both hands free.
  useEffect(() => {
    if (!auto) return undefined;
    const timer = setInterval(swing, 900);
    return () => clearInterval(timer);
  }, [auto, swing]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      let handled = true;

      if (key === ' ') swing();
      else if (key === 'b') push('attack', { byPlayer: false, hit: false, targetId: PLAYER_ID });
      else if (key === 'm') push('move', { fromId: '0,0', toId: '0,0' });
      else if (key === 'a') setAuto((v) => !v);
      else if (key === 'e') setEnemyIdx((i) => (i + 1) % ENEMIES.length);
      else if (key === 'w') setWeaponIdx((i) => (i + 1) % WEAPONS.length);
      else if (key === 'r') setReducedMotion((v) => !v);
      else if (hold && NUDGE_KEYS[key]) {
        const [field, axis, sign] = NUDGE_KEYS[key];
        hold[field][axis] += sign * (e.shiftKey ? 0.01 : 0.04);
      } else if (hold && (key === '+' || key === '=' || key === '-' || key === '_')) {
        hold.scale += (key === '-' || key === '_' ? -1 : 1) * (e.shiftKey ? 0.01 : 0.02);
        setRebuild((v) => v + 1);
      } else handled = false;

      if (!handled) return;
      e.preventDefault();
      setReadoutTick((v) => v + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hold, push, swing]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000' }}>
      <CrawlerScene
        // Remount on weapon or scale change: both rebuild the viewmodel.
        key={`${weaponName}-${rebuild}`}
        model={model}
        queue={queue}
        activeBeat={activeBeat}
        weapon={{ name: weaponName }}
        weaponTint="#69ff8f"
        reducedMotion={reducedMotion}
      />

      <div style={{
        ...PANEL, top: 12, left: 12, color: '#9dffc0', pointerEvents: 'none',
      }}
      >
        {[
          `weapon  ${weaponName}${spec.rig ? `  [rig: ${spec.rig}]` : ''}`,
          `enemy   ${enemy}`,
          `motion  ${reducedMotion ? 'REDUCED' : 'full'}   auto ${auto ? 'ON' : 'off'}`,
          '',
          ...HELP,
          ...(hold ? [HOLD_HELP] : []),
        ].join('\n')}
      </div>

      {hold && (
        <div
          key={readoutTick}
          style={{
            ...PANEL,
            bottom: 12,
            left: 12,
            color: '#ffd79d',
            background: 'rgba(20, 10, 0, 0.82)',
            borderColor: '#6b4a1c',
            userSelect: 'text',
          }}
        >
          {`hold: {\n`
            + `  offset: [${hold.offset.map(fmt).join(', ')}],\n`
            + `  rotation: [${hold.rotation.map(fmt).join(', ')}],\n`
            + `  scale: ${fmt(hold.scale)},\n`
            + '},'}
        </div>
      )}
    </div>
  );
}

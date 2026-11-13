/**
 * Follow-mode first-person crawler — rides ONE sandbox agent underground.
 *
 * The omniscient site map is
 * polled (players[] per room), tick frames from the spectator stream are
 * sliced to the followed agent's story and fed to the same beat queue, and
 * the untouched Crawler scene stack (rig, maze, enemies, props) renders it.
 * Rivals join the scene as color-tinted billboards.
 *
 * Over the scene sits the agent's body-camera overlay (CrawlerHud, with the
 * scope from CrawlerMinimap), placed in the frame's stage; see
 * styles/cam.css. The descent curtain and the death screen are drawn here.
 *
 * Remounts whenever the followed agent or their site changes — the descent
 * cut IS the transition.
 */

import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSandbox } from '../../context/SandboxContext';
import { useLayout } from '../../context/LayoutContext';
import { getSiteMap } from '../../services/sandboxApi';
import { adaptSiteMapData } from '../Scene3D/dungeonAdapter';
import { isWebGLAvailable, prefersReducedMotion } from '../Scene3D/worldUtils';
import { createBeatQueue } from '../Scene3D/Crawler/crawlerEvents';
import { preloadCrawlerAssets } from '../Scene3D/Crawler/crawlerAssets';
import { idToGrid } from '../Scene3D/Crawler/CrawlerMaze';
import CrawlerScene from '../Scene3D/Crawler/CrawlerScene';
import CrawlerHud from '../Scene3D/Crawler/CrawlerHud';
import CrawlerMinimap from '../Scene3D/Crawler/CrawlerMinimap';
import { playCue } from '../Scene3D/Crawler/sfx';
import { weaponSpecFor } from '../Scene3D/Crawler/weaponCatalog';
import { IconDead, IconDescend } from '../ui/icons';
import { PALETTE } from '../../styles/palette';
import { normalizeSandboxTick, thoughtBeat } from './sandboxEvents';
import CrawlerAgents from './CrawlerAgents';
import ExitPortals from './ExitPortals';
import '../../styles/cam.css';

const POLL_MS = 1500;
// Shortest the loading screen ever holds — the descent is a deliberate beat,
// not just a spinner, so a warm cache still gets the cut rather than a snap.
const DESCENT_MS = 1000;
// Curtain fade, and how long it stays mounted past the reveal.
const LIFT_MS = 420;
// Hard ceiling on the hold. A 404 on set dressing, a wedged shader compile,
// or a GL context that never produces a frame must degrade to "show the
// scene anyway" — never to a loading screen the viewer cannot escape.
const MAX_HOLD_MS = 12000;
// row/col deltas — matches dungeonAdapter.js's room.gridY/gridX + connections convention
const ADJ_DIRS = { N: [-1, 0], S: [1, 0], E: [0, 1], W: [0, -1] };

/**
 * What the curtain says it is waiting on. Deliberately in the fiction's
 * voice — the viewer is watching a descent, not a download.
 */
function loadStageLabel({ sceneMountable, assetsSettled, sceneReady }) {
  if (!sceneMountable) return 'mapping the site';
  if (!assetsSettled) return 'hauling gear';
  if (!sceneReady) return 'lighting the dark';
  return 'ready';
}

/**
 * An agent's colour, made legible as text on the near-black HUD: a dark
 * colour (a deep blue or purple) is mixed toward the pale ink; a bright one
 * is returned unchanged. Anything that is not a hex colour passes through.
 */
function legibleColor(color, fallback) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color ?? '')?.[1];
  if (!hex) return color || fallback;
  const full = hex.length === 3 ? hex.replace(/./g, '$&$&') : hex;
  const n = parseInt(full, 16);
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return lum < 0.2 ? `color-mix(in srgb, ${color} 55%, ${PALETTE.inkHi})` : color;
}

/** A dead GL context downgrades to minimap + HUD — never a blank overlay. */
class CrawlerBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.warn('Sandbox crawler 3D failed — minimap fallback:', error?.message ?? error);
    this.props.onFail();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function SandboxCrawler({ agent, worldId, siteId }) {
  const {
    world, latestFrame, setFollowedAgentId, roster,
  } = useSandbox();
  const { tv } = useLayout();
  const reducedMotion = useMemo(prefersReducedMotion, []);
  const [sceneFailed, setSceneFailed] = useState(false);
  const supported = useMemo(isWebGLAvailable, []);

  // The descent cut: hold a brief interstitial so surfacing into the
  // first-person view reads as a deliberate transition, not a hard swap.
  // This is the FLOOR on the hold, not the whole of it — the curtain also
  // waits on assets and shader warm-up below.
  const [descentDone, setDescentDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDescentDone(true), reducedMotion ? 150 : DESCENT_MS);
    return () => clearTimeout(t);
  }, [reducedMotion]);

  // --- the loading gate ---
  //
  // Everything the crawler needs is pulled while the descent card is up,
  // rather than after it: the scene used to mount into an empty cache, so
  // walls arrived untextured, torches played the wrong sprite cell, and
  // every actor popped in at once when the last of ~13MB finally landed.
  //
  // Two signals have to agree before the curtain lifts. `assetsSettled`
  // covers the imperative loads nothing suspends on (wall tiles, the flame
  // sheet); `sceneReady` is the in-canvas probe, which cannot fire until the
  // Suspense boundary has resolved AND every shader program is compiled.
  const [assetsSettled, setAssetsSettled] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [heldTooLong, setHeldTooLong] = useState(false);

  // A rival can walk in carrying a weapon the followed agent never held, and
  // its FBX would load on screen. Warm every weapon on the roster too.
  const weaponKey = useMemo(() => (
    [agent.weapon, ...roster.map((r) => r.weapon)].filter(Boolean).sort().join('|')
  ), [agent.weapon, roster]);

  useEffect(() => {
    let on = true;
    preloadCrawlerAssets(weaponKey ? weaponKey.split('|') : [])
      // Only ever latches true: a later warm-up for a newly-seen weapon must
      // not re-close a curtain that has already lifted.
      .then(() => { if (on) setAssetsSettled(true); });
    return () => { on = false; };
  }, [weaponKey]);

  useEffect(() => {
    const t = setTimeout(() => setHeldTooLong(true), MAX_HOLD_MS);
    return () => clearTimeout(t);
  }, []);

  // A latch, not an event: the Suspense boundary can re-suspend later and
  // remount the probe, which would otherwise re-report readiness.
  const handleSceneReady = useCallback(() => setSceneReady(true), []);

  // Death cut: a short grace lets the killing-blow beat play, then the
  // death screen takes over. Without this latch the site map drops the
  // dead agent from its players list, playerRoomId goes null, and the
  // render gate replayed the DESCENT interstitial over a corpse.
  const [deathScreen, setDeathScreen] = useState(false);
  useEffect(() => {
    if (agent.alive) {
      setDeathScreen(false);
      return undefined;
    }
    const t = setTimeout(() => setDeathScreen(true), reducedMotion ? 300 : 2600);
    return () => clearTimeout(t);
  }, [agent.alive, reducedMotion]);

  // --- omniscient site map, polled ---
  const [mapData, setMapData] = useState(null);
  useEffect(() => {
    let on = true;
    const load = () => getSiteMap(worldId, siteId)
      .then((d) => { if (on) setMapData(d); })
      .catch(() => {});
    load();
    const iv = setInterval(load, POLL_MS);
    return () => { on = false; clearInterval(iv); };
  }, [worldId, siteId]);

  // Death retention: the site-map poll can delete a slain mob/rival BEFORE
  // its death beat has played, which popped the sprite at the moment of
  // defeat. Remember everyone last seen in the followed room and keep them
  // in the model until their dissolve beat finishes (the billboard's own
  // death latch handles the fade).
  const lastSeenRef = useRef(new Map()); // id -> {roomKey, entry, kind}
  const settledDeathsRef = useRef(new Set());
  const [retainVersion, setRetainVersion] = useState(0);

  const model = useMemo(() => {
    const m = adaptSiteMapData(mapData, agent.agent_id);
    const focusRoom = m.rooms.find((r) => r.id === m.playerRoomId);
    if (focusRoom) {
      // An entity that left the followed room may already be live in another
      // rendered room. Never retain a second copy under the old room key;
      // retention is only for actors absent from the whole fresh map (death
      // beats whose authoritative removal outran the animation queue).
      const presentAnywhere = new Set(m.rooms.flatMap((room) => [
        ...room.entities.map((e) => e.id),
        ...room.agents.map((a) => a.id),
      ]));
      const present = new Set([
        ...focusRoom.entities.map((e) => e.id),
        ...focusRoom.agents.map((a) => a.id),
      ]);
      for (const [id, seen] of lastSeenRef.current) {
        if (seen.roomKey !== focusRoom.id) continue;
        if (present.has(id) || settledDeathsRef.current.has(id)) continue;
        if (presentAnywhere.has(id)) continue;
        if (seen.kind === 'entity') focusRoom.entities.push(seen.entry);
        else focusRoom.agents.push(seen.entry);
      }
      for (const e of focusRoom.entities) {
        lastSeenRef.current.set(e.id, { roomKey: focusRoom.id, entry: e, kind: 'entity' });
      }
      for (const a of focusRoom.agents) {
        lastSeenRef.current.set(a.id, { roomKey: focusRoom.id, entry: a, kind: 'agent' });
      }
    }
    return m;
    // retainVersion re-runs this after a dissolve completes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapData, agent.agent_id, retainVersion]);

  // Rooms visible through an open doorway from the followed agent's own
  // room — the scene renders them (the site is fully revealed to
  // spectators), so combat there should be visible too, not just combat
  // in the agent's exact cell.
  const adjacentLocs = useMemo(() => {
    const room = model.rooms.find((r) => r.id === model.playerRoomId);
    if (!room) return null;
    const locs = new Set();
    for (const [dir, open] of Object.entries(room.connections || {})) {
      if (!open || !ADJ_DIRS[dir]) continue;
      const [dr, dc] = ADJ_DIRS[dir];
      locs.add(`${siteId}:${room.gridY + dr},${room.gridX + dc}`);
    }
    return locs;
  }, [model, siteId]);

  // A finished death beat releases its corpse from retention
  useEffect(() => queueRef.current && queueRef.current.subscribe((event, b) => {
    if (event === 'end' && b.kind === 'death' && b.entityId) {
      settledDeathsRef.current.add(b.entityId);
      lastSeenRef.current.delete(b.entityId);
      setRetainVersion((v) => v + 1);
    }
  }), []);

  // --- beat queue, fed from spectator frames ---
  const queueRef = useRef(null);
  if (!queueRef.current) {
    queueRef.current = createBeatQueue({ durScale: reducedMotion ? 0.3 : 1 });
  }
  const queue = queueRef.current;

  const [activeBeat, setActiveBeat] = useState(null);
  const [hpOverride, setHpOverride] = useState(null);
  const [facing, setFacing] = useState('S');
  const [thoughts, setThoughts] = useState([]);
  const [enemyHp, setEnemyHp] = useState({});
  const [targetId, setTargetId] = useState(null);
  const [pvpEventActive, setPvpEventActive] = useState(false);
  const lastTickRef = useRef(null);

  const pushThought = useCallback((id, text) => {
    if (!text) return;
    setThoughts((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].text === text) return prev;
      return [...prev.slice(-2), { id, text }];
    });
  }, []);

  // Beat lifecycle → HUD state + sfx + facing (mirrors the solo crawler)
  useEffect(() => queue.subscribe((event, b) => {
    if (event === 'start') {
      setActiveBeat(b);
      if (b.thought) pushThought(b.thought.id, b.thought.text);
      // Our own attack can carry a weapon-specific cue (see weaponCatalog);
      // an enemy's whiff is always the parry, whatever we are holding.
      let cue = b.kind;
      if (b.kind === 'attack') {
        if (b.byPlayer) cue = weaponSpecFor(agent.weapon).cue ?? 'attack';
        else if (!b.hit) cue = 'block';
      }
      if (!(b.kind === 'damage' && b.player === false)) playCue(cue);
      if (b.hpRemaining != null && b.player !== false) setHpOverride(b.hpRemaining);
      if ((b.kind === 'damage' || b.kind === 'loot')
        && b.player === false && b.targetId && b.hpRemaining != null) {
        setEnemyHp((prev) => ({
          ...prev,
          [b.targetId]: { hp: b.hpRemaining, maxHp: prev[b.targetId]?.maxHp ?? null },
        }));
      }
      if (b.kind === 'attack' && b.byPlayer && b.targetId) setTargetId(b.targetId);
      if (b.kind === 'move' && b.fromId && b.toId) {
        const from = idToGrid(b.fromId);
        const to = idToGrid(b.toId);
        if (to.row < from.row) setFacing('N');
        else if (to.row > from.row) setFacing('S');
        else if (to.col > from.col) setFacing('E');
        else if (to.col < from.col) setFacing('W');
      }
    } else if (event === 'end') {
      setActiveBeat((cur) => (cur?.id === b.id ? null : cur));
    }
  }), [queue, pushThought, agent.weapon]);

  // Frames → the followed agent's beats (one frame = one tick, complete)
  useEffect(() => {
    if (!latestFrame) return;
    if (lastTickRef.current == null) {
      lastTickRef.current = latestFrame.tick;
      queue.snapToLatest();
      return;
    }
    if (latestFrame.tick <= lastTickRef.current) return;
    lastTickRef.current = latestFrame.tick;

    const selfRow = (latestFrame.roster || []).find((r) => r.agent_id === agent.agent_id);
    const pos = selfRow?.position;
    const selfLoc = pos?.kind === 'dungeon' && pos.site_id
      ? `${pos.site_id}:${pos.room}` : null;

    const beats = normalizeSandboxTick(latestFrame.events, agent.agent_id, selfLoc, adjacentLocs);
    // A thought toast shows whenever the agent supplied one this tick —
    // hosted brains always do; external (BYO) agents do too when they
    // pass `thought` to take_turn, and the MCP instructions tell them
    // spectators will see it, so the crawler HUD should honor that.
    const thought = (latestFrame.events || []).find(
      (e) => e.event_type === 'agent_thought' && e.actor === agent.agent_id,
    );
    if (thought?.data?.thought) {
      beats.unshift(thoughtBeat(`t${latestFrame.tick}`, thought.data.thought));
    }
    if (beats.length) queue.enqueue(beats);
  }, [latestFrame, agent.agent_id, queue, adjacentLocs]);

  // The polled site map is authoritative and survives reconnects, but an
  // agent-v-agent attack should light the danger frame on the very SSE frame
  // it happens rather than waiting up to POLL_MS for the next map sample.
  // combat_end clears the event latch; the map's pvp flag covers attach-mid-
  // fight and remains true for the full grudge, not just the attack beat.
  const currentLoc = model.playerRoomId ? `${siteId}:${model.playerRoomId}` : null;
  useEffect(() => {
    setPvpEventActive(false);
  }, [currentLoc]);
  useEffect(() => {
    if (!latestFrame || !currentLoc) return;
    const events = (latestFrame.events || []).filter((e) => e.location === currentLoc);
    if (events.some((e) => e.event_type === 'combat_end')) {
      setPvpEventActive(false);
      return;
    }
    const agentIds = new Set((latestFrame.roster || roster).map((a) => a.agent_id));
    const pvpStrike = events.some((e) => e.event_type === 'attack'
      && agentIds.has(e.data?.attacker_id)
      && agentIds.has(e.data?.defender_id));
    if (pvpStrike) setPvpEventActive(true);
  }, [latestFrame, currentLoc, roster]);
  const pvpActive = model.pvpRoomId === model.playerRoomId || pvpEventActive;

  // Polled model is authoritative for enemy HP between beats
  useEffect(() => {
    setEnemyHp((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const room of model.rooms) {
        for (const e of room.entities) {
          if (e.type !== 'hostile' && e.type !== 'invader') continue;
          if (e.hp == null) continue;
          const cur = next[e.id];
          if (!cur || cur.hp !== e.hp || cur.maxHp !== e.maxHp) {
            next[e.id] = { hp: e.hp, maxHp: e.maxHp ?? cur?.maxHp ?? null };
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [model]);

  // Sticky combat target plate
  const combatFoes = useMemo(() => {
    const room = model.rooms.find((r) => r.id === model.combatRoomId);
    if (!room) return [];
    const mobs = room.entities.filter((e) => e.type === 'hostile' || e.type === 'invader');
    const rivals = room.agents
      .filter((a) => a.hostileToPlayer)
      .map((a) => {
        const row = roster.find((entry) => entry.agent_id === a.id);
        return {
          ...a,
          type: 'agent',
          hp: row?.hp ?? null,
          maxHp: row?.max_hp ?? null,
        };
      });
    return [...mobs, ...rivals];
  }, [model, roster]);
  const target = useMemo(() => {
    const foe = combatFoes.find((e) => e.id === targetId) ?? combatFoes[0] ?? null;
    if (!foe) return null;
    const tracked = enemyHp[foe.id];
    const rival = foe.type === 'agent';
    return {
      id: foe.id,
      name: foe.name ?? foe.id,
      hp: tracked?.hp ?? foe.hp ?? null,
      maxHp: tracked?.maxHp ?? foe.maxHp ?? null,
      invader: rival,
      // a rival agent's plate wears that agent's own colour
      color: rival && foe.color ? legibleColor(foe.color) : null,
    };
  }, [combatFoes, targetId, enemyHp]);

  // --- the curtain ---
  // The scene mounts the moment there is a room to stand in and does all of
  // its loading, cloning and compiling underneath; the curtain lifts only
  // once that work is done. A scene that will never render (no WebGL, or the
  // boundary tripped) skips the in-canvas half of the gate rather than
  // waiting on a probe that can never fire.
  //
  // `heldTooLong` bypasses the asset and shader gates only. It deliberately
  // does NOT bypass `sceneMountable`: with no site map there is no scene and
  // no HUD to reveal, so lifting would show black. That case gets a stalled
  // message on the card instead — Esc still surfaces, the listener is on
  // window and the curtain never sees the key.
  const sceneMountable = !!mapData && !!model.playerRoomId;
  const willRenderScene = supported && !sceneFailed;
  const gatesClear = sceneMountable && descentDone
    && (heldTooLong || (assetsSettled && (sceneReady || !willRenderScene)));

  // Latched: the site-map poll can transiently drop the followed agent's
  // room, and an unlatched reveal would slam a fully opaque curtain back
  // over a live scene mid-session.
  const revealedRef = useRef(false);
  if (gatesClear) revealedRef.current = true;
  const revealed = revealedRef.current;

  // Held one fade past the reveal so it dissolves instead of cutting.
  const [curtainUp, setCurtainUp] = useState(true);
  useEffect(() => {
    if (!revealed) return undefined;
    const t = setTimeout(() => setCurtainUp(false), reducedMotion ? 0 : LIFT_MS);
    return () => clearTimeout(t);
  }, [revealed, reducedMotion]);

  // One segment per gate. drei's useProgress is deliberately NOT used: its
  // store is global and never resets, so it still reads 100 from the
  // island's own load when the crawler mounts — a bar that starts full and
  // stays full. Three honest steps beat one confident lie, and the step in
  // flight pulses so a long asset load never reads as a frozen screen.
  const stagesDone = revealed
    ? 3
    : [sceneMountable, assetsSettled, sceneReady || !willRenderScene].filter(Boolean).length;
  const stalled = heldTooLong && !sceneMountable;

  const siteName = model.siteName ?? mapData?.site_name ?? null;
  // Everything inside reads the agent's colour from here, legible on black.
  const camStyle = { '--agent': legibleColor(agent.color, PALETTE.green) };

  // The fallen never "descend" again: once dead, the only interstitial is
  // the death screen (immediately if the scene can no longer place them).
  if (!agent.alive && (deathScreen || !model.playerRoomId)) {
    return (
      <div className="qf-cam" style={camStyle}>
        <div className="qf-cam-curtain qf-cam-curtain--death" role="status">
          <div className="qf-cam-curtain__body">
            <IconDead size={48} className="qf-cam-curtain__glyph" />
            <span className="qf-cam-curtain__name">{agent.name}</span>
            <span className="qf-cam-curtain__cause">
              {agent.cause_of_death || 'has fallen'} — {siteName ?? 'the dark'} keeps them
            </span>
            <span className="qf-cam-curtain__hint">
              <kbd className="qf-key">Esc</kbd>
              Back to the island
            </span>
          </div>
        </div>
      </div>
    );
  }

  const playerRoom = model.rooms.find((r) => r.id === model.playerRoomId) ?? null;

  return (
    <div className="qf-cam" style={camStyle}>
      {sceneMountable && supported && !sceneFailed && (
        <CrawlerBoundary onFail={() => setSceneFailed(true)}>
          <CrawlerScene
            model={model}
            queue={queue}
            activeBeat={activeBeat}
            weapon={agent.weapon ? { name: agent.weapon, damageBonus: agent.weapon_bonus ?? null } : null}
            weaponTint={agent.color}
            reducedMotion={reducedMotion}
            agentsLayer={(
              <>
                <CrawlerAgents model={model} queue={queue} reducedMotion={reducedMotion} />
                <ExitPortals model={model} reducedMotion={reducedMotion} />
              </>
            )}
            onReady={handleSceneReady}
          />
        </CrawlerBoundary>
      )}
      {sceneMountable && (
        <CrawlerHud
          queue={queue}
          thoughts={thoughts}
          agentName={agent.name}
          siteName={siteName}
          roomType={playerRoom?.type ?? null}
          tick={world?.tick ?? latestFrame?.tick ?? null}
          hunted={pvpActive}
          live={!curtainUp}
          hp={hpOverride ?? agent.hp ?? null}
          maxHp={agent.max_hp ?? null}
          weapon={agent.weapon ? { name: agent.weapon, damageBonus: agent.weapon_bonus ?? null } : null}
          target={target}
          gameOver={!agent.alive}
          gameOverMsg={agent.alive ? null : agent.cause_of_death}
          reducedMotion={reducedMotion}
        >
          {/* on the TV nobody holds a pointer: the pips are not buttons there */}
          <CrawlerMinimap model={model} facing={facing} onSelectAgent={tv ? null : setFollowedAgentId} />
        </CrawlerHud>
      )}
      {curtainUp && (
        <div
          className={`qf-cam-curtain${revealed ? ' is-lifting' : ''}${stalled ? ' is-stalled' : ''}`}
          role="status"
          aria-live="polite"
        >
          <div className="qf-cam-curtain__body">
            <IconDescend size={32} className="qf-cam-curtain__glyph" />
            <span className="qf-cam-curtain__name">{agent.name}</span>
            <span className="qf-cam-curtain__into">Descends into</span>
            <span className="qf-cam-curtain__site">{siteName ?? 'the dark'}</span>
            <div className="qf-cam-steps" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <i
                  key={i}
                  className={`qf-cam-step${i < stagesDone ? ' is-done' : i === stagesDone ? ' is-current' : ''}`}
                />
              ))}
            </div>
            <span className="qf-cam-curtain__stage">
              {loadStageLabel({
                sceneMountable,
                assetsSettled,
                sceneReady: sceneReady || !willRenderScene,
              })}
            </span>
            {stalled && (
              <span className="qf-cam-curtain__stall">
                The site map is not answering
                <kbd className="qf-key">Esc</kbd>
                to surface
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

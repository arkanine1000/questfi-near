/**
 * The island spectator: the full-bleed 3D island under the frame described
 * in styles/shell.css (top bar, the field on the left, the market dock on
 * the right, the stage between them).
 *
 * God view stays clean: coloured beacons, dungeon-mouth rings, one crown
 * tag. Clicking a beacon or a row in the field enters FOLLOW mode: the
 * camera flies to the agent, and if it is underground the first-person
 * dungeon feed takes the stage. Escape always returns to the god view.
 */

import {
  Component, useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import IslandScene from '../Scene3D/IslandScene';
import { useSandbox } from '../../context/SandboxContext';
import { useLayout } from '../../context/LayoutContext';
import { IS_TV, onTvCommand, sendToTv } from '../../services/cast';
import useTvDirector from '../../hooks/useTvDirector';
import { axialToWorld, prefersReducedMotion } from '../Scene3D/worldUtils';
import TopBar from './TopBar';
import Field from './Field';
import Dossier from './Dossier';
import MarketPanel from './MarketPanel';
import SandboxAgentMarkers from './SandboxAgentMarkers';
import SandboxSiteMarkers from './SandboxSiteMarkers';
import CombatBeacons from './CombatBeacons';
import SandboxCrawler from './SandboxCrawler';
import PromptChan from './PromptChan';
import FollowThoughts from './FollowThoughts';
import Landing from './Landing';
import LobbyOverlay from './Lobby';
import WinnerBanner from './Finale';
import FollowNav, { HexPicker } from './FollowNav';
import { BootCurtain, OfflineOverlay, RotateGate } from './SystemScreens';
import { BetsProvider } from './BettingContext';
// the stage's furniture, and the 3D name tags the scenes project into the DOM
import '../../styles/stage.css';

/** Dossier windows open at once; opening one more closes the oldest. */
const MAX_DOSSIERS = 3;
/** Each further dossier opens this far down and right of the last. */
const DOSSIER_CASCADE = 28;

/** The HUD must outlive the hologram: if WebGL dies (headless CI, exotic
 * GPUs, context loss), the island degrades to a quiet backdrop and the
 * spectator chrome keeps broadcasting. */
class SceneBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { dead: false };
  }

  static getDerivedStateFromError() {
    return { dead: true };
  }

  componentDidCatch() {
    /* logged by the browser; nothing to add */
  }

  render() {
    if (this.state.dead) return <div className="qf-stage-fallback" aria-hidden />;
    return this.props.children;
  }
}

export default function SandboxView() {
  const {
    status, world, islandMap, roster, followedAgentId, followedAgent, setFollowedAgentId,
    eventLog,
  } = useSandbox();
  const { shellProps, fieldOpen, setFieldOpen } = useLayout();
  const [focusRequest, setFocusRequest] = useState(null);
  const reducedMotion = useMemo(prefersReducedMotion, []);
  // Clicking a crowded hex offers its occupants: { key, agents: [...] }
  const [hexPicker, setHexPicker] = useState(null);
  // Lean-back spectating with a mouse still in hand: the same auto-director
  // the TV runs, toggled from the top bar (or booted on via ?director=1).
  // Unlike the TV cut, every control stays mounted and the cursor stays.
  const [directorOn, setDirectorOn] = useState(() => !IS_TV
    && new URLSearchParams(window.location.search).get('director') === '1');

  // site_id -> primary mouth hex (where underground agents surface visually)
  const siteAnchors = useMemo(() => {
    const anchors = {};
    for (const [siteId, site] of Object.entries(islandMap?.sites || {})) {
      const first = Object.values(site.entrances || {})[0];
      if (first) anchors[siteId] = first;
    }
    return anchors;
  }, [islandMap]);

  // Dungeon agents resolve to their site's (fixed) mouth hex; surface
  // agents resolve to their own live hex.
  const agentWorldPoint = useCallback((agent) => {
    const pos = agent.position || {};
    const hex = pos.kind === 'dungeon' ? siteAnchors[pos.site_id] : pos.hex;
    if (!hex) return null;
    const [q, r] = hex.split(',').map(Number);
    const world3 = axialToWorld(q, r);
    return [world3.x, world3.y, world3.z];
  }, [siteAnchors]);

  const flyToAgent = useCallback((agent) => {
    const point = agentWorldPoint(agent);
    if (!point) return;
    setFocusRequest({ type: 'hex', point, ts: Date.now() });
  }, [agentWorldPoint]);

  // Combat beacons: a red pillar fires from a dungeon's mouth hex the
  // instant a fight breaks out inside it. combat_start's `location` is
  // "{site_id}:{row},{col}" (location_key() in the backend) — split on the
  // first ':' for the site id, then resolve the SAME mouth hex used for
  // dungeon agents' beacon/camera-follow position.
  //
  // Deliberately watches `eventLog`, NOT `latestFrame`. latestFrame is a
  // plain setState (last-write-wins) — under React's batching, a burst of
  // rapid SSE frames (a reconnect backfill in particular, which can replay
  // 100+ historical ticks near-instantly) can skip straight to the final
  // frame without ever rendering the ones in between, silently dropping
  // whatever combat_start events lived only in those skipped frames. This
  // was the actual cause of "the event never fired" — not a bad location
  // format or a bad site anchor. eventLog accumulates via a FUNCTIONAL
  // update (prev => [...prev, ...headlines]) in SandboxContext, which
  // queues and applies correctly regardless of batching — it can't drop
  // an event, only cap the tail (MAX_LOG=60) once truly old.
  const [combatBeacons, setCombatBeacons] = useState([]);
  const lastBeaconSeqRef = useRef(null); // null = not yet baselined
  useEffect(() => {
    if (reducedMotion) return;
    const starts = eventLog.filter((e) => e.event_type === 'combat_start' && e.location);
    if (lastBeaconSeqRef.current == null) {
      // First sight of this event log (mount, or a fresh attach/reconnect
      // that reset it) — baseline without firing, so reconnecting to an
      // already-running world doesn't flash a beacon for every fight
      // that's already history.
      lastBeaconSeqRef.current = starts.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
      return;
    }
    const fresh = starts.filter((e) => (e.seq ?? 0) > lastBeaconSeqRef.current);
    if (!fresh.length) return;
    lastBeaconSeqRef.current = fresh.reduce(
      (m, e) => Math.max(m, e.seq ?? 0), lastBeaconSeqRef.current,
    );
    const added = [];
    for (const ev of fresh) {
      const siteId = ev.location.split(':')[0];
      const hex = siteAnchors[siteId];
      if (!hex) continue;
      const [q, r] = hex.split(',').map(Number);
      const world3 = axialToWorld(q, r);
      added.push({ id: `${siteId}-${ev.tick}-${ev.seq}`, point: world3 });
    }
    if (added.length) setCombatBeacons((prev) => [...prev, ...added]);
  }, [eventLog, siteAnchors, reducedMotion]);

  const handleBeaconDone = useCallback((id) => {
    setCombatBeacons((prev) => (prev.length ? prev.filter((b) => b.id !== id) : prev));
  }, []);

  // Soft follow: recomputed whenever the roster moves, so CameraRig can
  // continuously ease the orbit target toward the agent's live position
  // (surface agents only move meaningfully — a dungeon's mouth hex is
  // fixed, so this is a no-op there beyond the initial fly-in above).
  const followTarget = useMemo(
    () => (followedAgent ? agentWorldPoint(followedAgent) : null),
    [followedAgent, agentWorldPoint],
  );

  const handleFollow = useCallback((agent) => {
    if (!agent.alive) return;
    setHexPicker(null);
    setFollowedAgentId(agent.agent_id);
    flyToAgent(agent);
    // Mirror the pick onto a cast TV; silent no-op when not casting.
    sendToTv({ type: 'follow', agentId: agent.agent_id });
  }, [setFollowedAgentId, flyToAgent]);

  // ?pass=<id>: the page that opened the island (the start app, through
  // Agent World) names the viewer's agent pass. Follow the agent carrying it
  // as soon as it appears in the roster, once per season; any later pick is
  // the viewer's own. In the lobby this already points the bet slip at it.
  const passToFollow = useMemo(() => new URLSearchParams(window.location.search).get('pass'), []);
  const passFollowedIn = useRef(null);
  const userFollowRef = useRef(null);
  useEffect(() => {
    const worldId = world?.world_id;
    if (!passToFollow || !worldId) return;
    if (passFollowedIn.current === worldId) return;
    const agent = roster.find((a) => a.alive && a.pass_id != null && String(a.pass_id) === passToFollow);
    if (!agent) return;
    passFollowedIn.current = worldId;
    userFollowRef.current?.(agent);
  }, [passToFollow, world?.world_id, roster]);

  // Underground follow hands the screen to the first-person crawler, which
  // brings its own HUD; on the surface the island map stays in view and the
  // overworld overlays (thought toasts) do that job instead.
  const crawlerActive = Boolean(
    followedAgent && world?.phase !== 'lobby'
      && followedAgent.position?.kind === 'dungeon'
      && followedAgent.position.site_id,
  );

  // The dungeon feed wants the width: fold the field while it has the stage
  // and reopen it on the way out if it was open before. The viewer can still
  // open it by hand meanwhile. A TV has no pointer to bring it back, so there
  // the field stays where it is.
  const fieldOpenRef = useRef(fieldOpen);
  fieldOpenRef.current = fieldOpen;
  const fieldBeforeCam = useRef(null);
  useEffect(() => {
    if (IS_TV) return;
    if (crawlerActive) {
      if (fieldBeforeCam.current == null) fieldBeforeCam.current = fieldOpenRef.current;
      setFieldOpen(false);
    } else if (fieldBeforeCam.current != null) {
      if (fieldBeforeCam.current) setFieldOpen(true);
      fieldBeforeCam.current = null;
    }
  }, [crawlerActive, setFieldOpen]);

  const handleDeselect = useCallback(() => {
    setHexPicker(null);
    setFollowedAgentId(null);
    sendToTv({ type: 'deselect' });
  }, [setFollowedAgentId]);

  // The auto-director runs the camera (combat cuts, roster rotation,
  // god-view breathers) on a TV always — no pointer on a couch — and on the
  // regular view whenever the top-bar toggle turns it on. A command from
  // the casting phone, or a local click while the toggle is on, pins its
  // pick past the rotation for a while.
  const noteManual = useTvDirector({
    enabled: (IS_TV || directorOn) && status === 'ready',
    phase: world?.phase,
    roster,
    eventLog,
    followedAgentId,
    onFollow: handleFollow,
    onDeselect: handleDeselect,
  });

  // Every pointer/keyboard path goes through these instead of the raw
  // handlers, so a human pick outranks the rotation exactly like a cast
  // command does. The director itself keeps the raw handlers — its own
  // cuts must not pin themselves.
  const userFollow = useCallback((agent) => {
    if (directorOn) noteManual();
    handleFollow(agent);
  }, [directorOn, noteManual, handleFollow]);
  userFollowRef.current = userFollow;
  const userDeselect = useCallback(() => {
    if (directorOn) noteManual();
    handleDeselect();
  }, [directorOn, noteManual, handleDeselect]);

  // Receiver side of the cast channel. Wired once; reads live state
  // through a ref because connection listeners accumulate per wire-up.
  const tvRef = useRef(null);
  tvRef.current = {
    roster, worldId: world?.world_id, handleFollow, handleDeselect, noteManual,
  };
  useEffect(() => {
    if (!IS_TV) return undefined;
    return onTvCommand((cmd) => {
      const s = tvRef.current;
      if (cmd?.type === 'follow') {
        const agent = s.roster.find((a) => a.agent_id === cmd.agentId);
        if (agent?.alive) {
          s.noteManual();
          s.handleFollow(agent);
        }
      } else if (cmd?.type === 'deselect') {
        s.noteManual();
        s.handleDeselect();
      } else if (cmd?.type === 'world' && cmd.worldId && cmd.worldId !== s.worldId) {
        // The phone hopped seasons/games — hard cut, the reload re-attaches.
        window.location.search = `?world=${cmd.worldId}&view=tv`;
      }
    });
  }, []);

  // Prev/next spectator cycle: the full living roster, island-wide (not
  // just the followed agent's own dungeon — the minimap pips cover that
  // contextual same-dungeon jump separately).
  const livingRoster = useMemo(() => roster.filter((a) => a.alive), [roster]);
  const { prevAgent, nextAgent } = useMemo(() => {
    if (!followedAgent || livingRoster.length < 2) return { prevAgent: null, nextAgent: null };
    const i = livingRoster.findIndex((a) => a.agent_id === followedAgent.agent_id);
    if (i === -1) return { prevAgent: null, nextAgent: null };
    const n = livingRoster.length;
    return {
      prevAgent: livingRoster[(i - 1 + n) % n],
      nextAgent: livingRoster[(i + 1) % n],
    };
  }, [livingRoster, followedAgent]);

  // Clicking a hex resolves to the agents standing on it (or descended
  // through its mouth): one occupant follows immediately, a crowd offers
  // a picker. A single click arrives as (q, r) and a double click as the
  // hex object, so both forms are read.
  const handleSelectHex = useCallback((hexOrQ, maybeR) => {
    const isObj = hexOrQ != null && typeof hexOrQ === 'object';
    const q = isObj ? hexOrQ.q : hexOrQ;
    const r = isObj ? hexOrQ.r : maybeR;
    if (q == null || r == null) return;
    const key = `${q},${r}`;
    const here = roster.filter((a) => {
      if (!a.alive) return false;
      const pos = a.position || {};
      const shown = pos.kind === 'dungeon' ? siteAnchors[pos.site_id] : pos.hex;
      return shown === key;
    });
    if (here.length === 1) userFollow(here[0]);
    else if (here.length > 1) setHexPicker({ key, agents: here });
    else setHexPicker(null);
  }, [roster, siteAnchors, userFollow]);

  // Escape always surfaces — the HUD owns this, so it works even when the
  // 3D scene is on its fallback (IslandScene resets its camera separately).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') userDeselect();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [userDeselect]);

  // Dossier windows, one per agent, oldest first. Each opens cascading from
  // the stage's top-left corner; the window remembers where it was dragged.
  const stageRef = useRef(null);
  const [dossiers, setDossiers] = useState([]); // [{ id, initial, nonce }]
  const openDossier = useCallback((agent) => {
    if (!agent?.agent_id) return;
    const rect = stageRef.current?.getBoundingClientRect();
    const origin = { x: (rect?.left ?? 80) + 16, y: (rect?.top ?? 80) + 16 };
    setDossiers((prev) => {
      const open = prev.find((d) => d.id === agent.agent_id);
      // Already open: bring it back to the front of the pile.
      if (open) {
        return [...prev.filter((d) => d !== open), { ...open, nonce: open.nonce + 1 }];
      }
      const slot = Math.min(prev.length, MAX_DOSSIERS - 1);
      const entry = {
        id: agent.agent_id,
        nonce: 0,
        initial: { x: origin.x + slot * DOSSIER_CASCADE, y: origin.y + slot * DOSSIER_CASCADE },
      };
      return [...prev, entry].slice(-MAX_DOSSIERS);
    });
  }, []);
  const closeDossier = useCallback((id) => {
    setDossiers((prev) => prev.filter((d) => d.id !== id));
  }, []);
  // A new season has new agents.
  useEffect(() => { setDossiers([]); }, [world?.world_id]);

  const agentLayer = useCallback(({ reducedMotion: sceneReducedMotion }) => (
    <>
      <SandboxAgentMarkers
        roster={roster}
        siteAnchors={siteAnchors}
        followedAgentId={followedAgentId}
        onFollow={userFollow}
        reducedMotion={sceneReducedMotion}
      />
      <SandboxSiteMarkers islandMap={islandMap} reducedMotion={sceneReducedMotion} />
      <CombatBeacons beacons={combatBeacons} onBeaconDone={handleBeaconDone} />
    </>
  ), [
    roster, siteAnchors, followedAgentId, userFollow, islandMap,
    combatBeacons, handleBeaconDone,
  ]);

  const ready = status === 'ready' && Boolean(world);
  const phase = world?.phase;

  return (
    <div
      className="qf-shell"
      {...shellProps}
      data-phase={ready ? phase : undefined}
      data-follow={ready && followedAgent ? '' : undefined}
      data-cam={ready && crawlerActive ? '' : undefined}
    >
      <SceneBoundary>
        <IslandScene
          wireframe={false}
          onSelectHex={handleSelectHex}
          onHexDoubleClick={handleSelectHex}
          onDeselect={userDeselect}
          agentLayer={agentLayer}
          focusRequestExternal={focusRequest}
          followTarget={followTarget}
          onUnfollow={userDeselect}
        />
      </SceneBoundary>

      {ready && (
        <BetsProvider>
          {/* FOLLOW MODE: an underground agent hands the stage to the
              first-person dungeon feed. It places itself; the columns and
              the stage furniture stay above it, so the viewer can hop
              between agents without surfacing. */}
          {crawlerActive && (
            <SandboxCrawler
              key={`${followedAgent.agent_id}:${followedAgent.position.site_id}`}
              agent={followedAgent}
              worldId={world.world_id}
              siteId={followedAgent.position.site_id}
            />
          )}

          <TopBar
            directorOn={directorOn}
            onToggleDirector={() => setDirectorOn((v) => !v)}
          />
          {/* the left column: who is on the island */}
          <Field onFollow={userFollow} onInfo={openDossier} />
          {/* the right-hand dock decides for itself whether the lobby gets a market */}
          <MarketPanel onFollow={userFollow} />
          {phase === 'lobby' && <LobbyOverlay />}

          <div className="qf-stage" ref={stageRef}>
            {/* follow mode always shows the way home, flanked by the
                previous and next living agent: pointless on a TV, where
                the director cuts */}
            {followedAgent && !IS_TV && (
              <FollowNav
                agent={followedAgent}
                prevAgent={prevAgent}
                nextAgent={nextAgent}
                onCam={crawlerActive}
                onFollow={userFollow}
                onExit={userDeselect}
                onInfo={openDossier}
              />
            )}

            {/* crowded-hex picker: choose who to ride */}
            {hexPicker && !followedAgent && (
              <HexPicker agents={hexPicker.agents} onFollow={userFollow} onClose={() => setHexPicker(null)} />
            )}

            {/* Above ground the followed agent's thoughts stack over the
                caster's band; underground the dungeon HUD shows them. */}
            {followedAgent && !crawlerActive && phase !== 'lobby' && (
              <FollowThoughts agent={followedAgent} reducedMotion={reducedMotion} />
            )}

            {/* The caster works both desks, the god view and over the
                dungeon feed, and her name-drops are camera cues (click to
                follow). During a crowned finale the victory cameo takes
                her chair instead. */}
            {phase !== 'lobby' && !(phase === 'finished' && world.winner_name) && (
              <PromptChan onFollow={userFollow} />
            )}
          </div>

          <WinnerBanner />

          {dossiers.map((d) => (
            <Dossier
              key={`${d.id}:${d.nonce}`}
              agentId={d.id}
              initial={d.initial}
              onClose={() => closeDossier(d.id)}
              onFollow={userFollow}
            />
          ))}
        </BetsProvider>
      )}

      <RotateGate />

      {status === 'connecting' && <BootCurtain />}
      {status === 'landing' && <Landing />}
      {status === 'offline' && <OfflineOverlay />}
    </div>
  );
}

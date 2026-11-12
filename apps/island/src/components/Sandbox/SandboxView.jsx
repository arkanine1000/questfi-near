/**
 * The sandbox spectator — full-bleed island under a thin overlay HUD.
 *
 * God view stays clean: colored beacons, dungeon-mouth rings, one crown tag,
 * a quiet ticker. Clicking a beacon or a roster chip enters FOLLOW mode:
 * the camera flies to the agent; if they're underground the first-person
 * crawler takes over (M6). Escape always returns to the god view.
 */

import {
  Component, useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import IslandScene from '../Scene3D/IslandScene';
import { ISLAND_MASK, axialToPixel, getHexPoints } from '../HexGrid/hexUtils';
import { useSandbox } from '../../context/SandboxContext';
import { IS_TV, onTvCommand, sendToTv } from '../../services/cast';
import useTvDirector from '../../hooks/useTvDirector';
import { axialToWorld, prefersReducedMotion } from '../Scene3D/worldUtils';
import TopBar from './TopBar';
import MarketPanel from './MarketPanel';
import SandboxAgentMarkers from './SandboxAgentMarkers';
import SandboxSiteMarkers from './SandboxSiteMarkers';
import CombatBeacons from './CombatBeacons';
import SandboxCrawler from './SandboxCrawler';
import PromptChan from './PromptChan';
import FollowThoughts from './FollowThoughts';
import Landing from './Landing';
import AgentOnboarding from './AgentOnboarding';
import { WinnerTrophy, WinnerConfetti, WinnerChan } from './WinnerCelebration';
import { BetsProvider } from './BettingContext';
import '../../styles/Sandbox.css';

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
    if (this.state.dead) return <div className="sbx-fallback" aria-hidden />;
    return this.props.children;
  }
}

// The exit control wears the island itself — the real hex mask shrunk to
// a glyph, so "back to the island" is a picture, not a caption.
const MINI_HEX = 3.2;
const MINI_ISLAND = (() => {
  const hexPts = getHexPoints(MINI_HEX * 0.88);
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const cells = [...ISLAND_MASK].map((key) => {
    const [q, r] = key.split(',').map(Number);
    const { x, y } = axialToPixel(q, r, MINI_HEX);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    return { key, x, y };
  });
  const pad = MINI_HEX * 1.5;
  return {
    cells,
    hexPts,
    viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`,
  };
})();

function MiniIsland() {
  return (
    <svg viewBox={MINI_ISLAND.viewBox} className="sbx-exit-pill__island" aria-hidden>
      {MINI_ISLAND.cells.map(({ key, x, y }) => (
        <polygon key={key} points={MINI_ISLAND.hexPts} transform={`translate(${x} ${y})`} />
      ))}
    </svg>
  );
}

function LobbyOverlay() {
  const { world, roster, canControl, invite } = useSandbox();
  const joined = roster.length;
  const seats = world?.pool_size ?? 10;
  if (!world) return null;

  // Deciding to play or watch happened on the landing view — by the time
  // you are looking at this card, you chose. So the card does one job:
  // report who has arrived, and say what everyone is waiting for.
  const waiting = canControl
    ? 'Press Begin when the roster looks right.'
    : 'Waiting on the host to begin…';

  // Whoever opened this lobby lands straight here, and the invite is the
  // only thing they can act on — sending them back to the landing board to
  // find their own season was the long way round. The create response's
  // invite_url is the one that carries ?code= for an invite-only lobby;
  // it only applies to the world it was minted for.
  const invitePath = invite?.worldId === world.world_id ? invite.url : undefined;

  return (
    <div className="sbx-lobby">
      <div className="sbx-lobby__card">
        <img className="sbx-lobby__logo" src="/brand/quest-logo.png" alt="" aria-hidden />
        <h1 className="sbx-lobby__title">The island is waiting</h1>
        <p className="sbx-lobby__seats">
          <strong>{joined}</strong> of <strong>{seats}</strong> challengers in the lobby
        </p>
        {joined > 0 && (
          <ul className="sbx-lobby__list">
            {roster.map((a) => (
              <li key={a.agent_id} style={{ '--chip-color': a.color }}>
                <i />{a.name}
                {a.brain === 'external' ? ' · API' : ''}
                {a.ready ? ' ✓' : ''}
              </li>
            ))}
          </ul>
        )}
        {/* the TV has no pointer and no clipboard — it only ever waits */}
        {!IS_TV && (
          <div className="sbx-lobby__invite">
            <AgentOnboarding worldId={world.world_id} invitePath={invitePath} />
          </div>
        )}
        <p className="sbx-lobby__waiting">{IS_TV ? 'Waiting on the host to begin…' : waiting}</p>
      </div>
    </div>
  );
}

function WinnerBanner() {
  const { world, detachWorld } = useSandbox();
  if (!world || world.phase !== 'finished') return null;
  const reason = {
    boss: 'slew the Heart of the Island',
    last_alive: 'outlived every rival',
    timeout: 'outlasted the bell',
    extinction: null,
  }[world.win_reason];
  const won = Boolean(world.winner_name);
  return (
    <div className="sbx-winner">
      {won && <WinnerConfetti />}
      <div className="sbx-winner__card">
        {won ? <WinnerTrophy /> : <div className="sbx-winner__crown">☠</div>}
        {won ? (
          <>
            <h1 className="sbx-winner__name">{world.winner_name}</h1>
            <p className="sbx-winner__reason">{reason}</p>
          </>
        ) : (
          <h1 className="sbx-winner__name">No one survived</h1>
        )}
        {/* The season is over, so the only move is out of it. This used to
            open a lobby directly — either with silent server defaults or,
            later, a setup form bolted onto the finale card. Both made the
            finale carry a decision that the landing board already handles
            better, next to every other season on air. The TV has no pointer
            and stays put; the phone drives it. */}
        {!IS_TV && (
          <button
            type="button"
            className="sbx-btn sbx-btn--primary"
            onClick={() => detachWorld()}
          >
            Back to seasons
          </button>
        )}
      </div>
      {won && <WinnerChan name={world.winner_name} />}
    </div>
  );
}

function OfflineOverlay() {
  return (
    <div className="sbx-lobby">
      <h1 className="sbx-lobby__title">Signal lost</h1>
      <p className="sbx-lobby__hint">
        The island isn't answering. Check that the backend is up, then reload.
      </p>
    </div>
  );
}

export default function SandboxView() {
  const {
    status, world, islandMap, roster, followedAgentId, followedAgent, setFollowedAgentId,
    eventLog,
  } = useSandbox();
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

  // Underground follow hands the screen to the first-person crawler, which
  // brings its own HUD; on the surface the island map stays in view and the
  // overworld overlays (thought toasts) do that job instead.
  const crawlerActive = Boolean(
    followedAgent && world?.phase !== 'lobby'
      && followedAgent.position?.kind === 'dungeon'
      && followedAgent.position.site_id,
  );

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
  // a picker.
  const handleSelectHex = useCallback((hex) => {
    const key = `${hex.q},${hex.r}`;
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

  const rootCls = [
    'sbx-root',
    IS_TV ? 'sbx-root--tv' : '',
    crawlerActive ? 'sbx-root--crawler' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={rootCls}>
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

      {status === 'ready' && world && (
        <BetsProvider>
          {/* FOLLOW MODE: underground agents take over the screen with the
              first-person crawler; the roster rail stays on top so the
              spectator can hop between agents without surfacing. */}
          {crawlerActive && (
            <div className="sbx-crawler-overlay">
              <SandboxCrawler
                key={`${followedAgent.agent_id}:${followedAgent.position.site_id}`}
                agent={followedAgent}
                worldId={world.world_id}
                siteId={followedAgent.position.site_id}
              />
            </div>
          )}

          <TopBar
            directorOn={directorOn}
            onToggleDirector={() => setDirectorOn((v) => !v)}
          />
          {world.phase !== 'lobby' && <MarketPanel onFollow={userFollow} />}
          {world.phase === 'lobby' && <LobbyOverlay />}
          {/* the caster works both desks: god view AND over the crawler —
              and her name-drops are camera cues (click to follow). During
              a crowned finale the victory cameo takes her chair instead. */}
          {world.phase !== 'lobby' && !(world.phase === 'finished' && world.winner_name) && (
            <PromptChan onFollow={userFollow} />
          )}

          {/* crowded-hex picker: choose who to ride */}
          {hexPicker && !followedAgent && (
            <div className="sbx-hexpicker" role="menu">
              <span className="sbx-hexpicker__label">Follow</span>
              {hexPicker.agents.map((a) => (
                <button
                  key={a.agent_id}
                  type="button"
                  style={{ '--chip-color': a.color }}
                  onClick={() => userFollow(a)}
                >
                  <i aria-hidden />{a.name}
                </button>
              ))}
              <button
                type="button"
                className="sbx-hexpicker__close"
                onClick={() => setHexPicker(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          )}

          {/* follow mode always shows the way home, flanked by prev/next
              spectator-cycle buttons when there's another living agent
              to jump to — pointless on a TV, where the director cuts */}
          {followedAgent && !IS_TV && (
            <div className="sbx-agent-nav">
              {prevAgent && (
                <button
                  type="button"
                  className="sbx-agent-nav__btn sbx-agent-nav__btn--prev"
                  style={{ '--chip-color': prevAgent.color }}
                  onClick={() => userFollow(prevAgent)}
                  title={`Follow ${prevAgent.name}`}
                >
                  <span className="sbx-agent-nav__arrow" aria-hidden>←</span>
                  <span className="sbx-agent-nav__name">{prevAgent.name}</span>
                </button>
              )}
              <button
                type="button"
                className="sbx-exit-pill"
                onClick={userDeselect}
                title="Back to island view"
                aria-label="Back to island view (Esc)"
              >
                <span className="sbx-exit-pill__back" aria-hidden>⬑</span>
                <MiniIsland />
                <span className="sbx-exit-pill__key">esc</span>
              </button>
              {nextAgent && (
                <button
                  type="button"
                  className="sbx-agent-nav__btn sbx-agent-nav__btn--next"
                  style={{ '--chip-color': nextAgent.color }}
                  onClick={() => userFollow(nextAgent)}
                  title={`Follow ${nextAgent.name}`}
                >
                  <span className="sbx-agent-nav__name">{nextAgent.name}</span>
                  <span className="sbx-agent-nav__arrow" aria-hidden>→</span>
                </button>
              )}
            </div>
          )}
          {/* Above ground the thought stream has no crawler HUD to ride on —
              same toasts, same bottom-center slot, fed from agentFeeds. */}
          {followedAgent && !crawlerActive && world.phase !== 'lobby' && (
            <FollowThoughts agent={followedAgent} reducedMotion={reducedMotion} />
          )}

          <WinnerBanner />
        </BetsProvider>
      )}

      {/* Phones held upright get a polite bounce — the broadcast is
          widescreen. Pure CSS gate; the installed PWA locks landscape. */}
      <div className="sbx-rotate-gate" role="status">
        <img src="/brand/quest-logo.png" alt="" />
        <p>
          Rotate your device
          <span>the island broadcasts in widescreen</span>
        </p>
      </div>

      {status === 'connecting' && (
        <div className="sbx-boot" aria-label="Connecting">
          <span className="sbx-boot__pulse" />
        </div>
      )}
      {status === 'landing' && <Landing />}
      {status === 'offline' && <OfflineOverlay />}
    </div>
  );
}

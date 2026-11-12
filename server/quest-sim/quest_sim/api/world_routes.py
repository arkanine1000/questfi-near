"""The /world API — multi-agent sandbox seasons.

Lobby-first: BYO agents join as primary players; POST /start backfills
hosted agents to the pool size and goes live. All world mutation flows
through the world's WorldRunner on the event loop (single-writer).

Three secrets ride in the models — SandboxAgent.token, SandboxWorld
.invite_code, SandboxWorld.host_key — and all three are written to
world.json. Nothing but hand-built response dicts keeps them off the
wire, so: NEVER splat **world.model_dump() into a response.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets as _secrets

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from quest_sim.api.world_guide import WORLD_GUIDE, render_invite
from quest_sim.config import get_settings
from quest_sim.engine.action_parse import parse_action_string
from quest_sim.engine.sandbox.build import build_world, create_agent, start_season
from quest_sim.engine.sandbox.perception import (
    build_observation,
    island_map_view,
    roster_view,
    site_map_view,
)
from quest_sim.engine.sandbox.runner import WorldRunner, build_tick_frame
from quest_sim.engine.sandbox.tick import LOC_TRAIL_TICKS
from quest_sim.models.events import EngineEvent, EngineEventType
from quest_sim.models.sandbox import SandboxConfig, SandboxWorld, WorldPhase
from quest_sim.near import bridge as near_bridge
from quest_sim.near import get_settler
from quest_sim.near.arena import get_arena
from quest_sim.persistence import sandbox_store

logger = logging.getLogger(__name__)

world_router = APIRouter(prefix="/world", tags=["sandbox"])

# Long-poll ceiling. Matches action_deadline_s's upper bound on purpose: a
# poll that cannot outlast the turn window is guaranteed to expire and hand
# back a stale snapshot, which is how players ended up on the wrong side of
# a tick boundary. Widening a validator breaks no existing caller.
MAX_WAIT_S = 300.0

# In-memory registries (single-process server; disk is the cold backup)
_runners: dict[str, WorldRunner] = {}


def _get_settings():
    return get_settings()


def _data_dir():
    return _get_settings().sandbox_data_dir


def _runner(world_id: str) -> WorldRunner:
    runner = _runners.get(world_id)
    if runner is None:
        world = sandbox_store.load_world(_data_dir(), world_id)
        if world is None:
            raise HTTPException(status_code=404, detail=f"World '{world_id}' not found")
        runner = WorldRunner(world, _data_dir())
        _install_llm_hook(runner)
        _install_commentator(runner)
        _install_settler(runner)
        _runners[world_id] = runner
    return runner


def _settler():
    """The on-chain settler, or None when NEAR settlement is off."""
    return get_settler(_get_settings())


def _install_settler(runner: WorldRunner) -> None:
    """Report each tick to the chain — only when settlement is on. The hook
    only queues calls; the settler's own task sends them."""
    settler = _settler()
    if settler is None:
        return
    runner.on_tick = lambda world, frame: near_bridge.on_tick(settler, world, frame)


def _near_status(world_id: str, settings) -> dict:
    settler = get_settler(settings)
    return settler.status(world_id) if settler is not None else {"enabled": False}


def _install_llm_hook(runner: WorldRunner) -> None:
    """Attach the hosted-LLM decision gatherer when it is available (M4)."""
    try:
        from quest_sim.agents.sandbox.agent import gather_llm_decisions
    except ImportError:
        return
    runner.llm_decide = gather_llm_decisions


def _install_commentator(runner: WorldRunner) -> None:
    """Give the world a booth — only when a commentator model is configured
    (unset in CI/rehearsals keeps Prompt-chan token-free and silent)."""
    settings = _get_settings()
    if not settings.commentator_enabled or not settings.commentator_model:
        return
    try:
        from quest_sim.agents.sandbox.commentator import Commentator
    except ImportError:
        return
    runner.commentator = Commentator(
        runner.world.world_id,
        _data_dir(),
        model=settings.commentator_model,
        api_key=settings.llm_api_key,
        api_base=settings.llm_api_base,
        memory_window=runner.world.config.memory_window,
    )
    runner.start_booth()


def _peek_world(world_id: str) -> SandboxWorld:
    """Resolve a world WITHOUT arming a runner — for callers that only read
    a field or are about to destroy it. _runner() would install an LLM hook
    and start a commentator booth, which is absurd on the way to a DELETE."""
    runner = _runners.get(world_id)
    if runner is not None:
        return runner.world
    world = sandbox_store.load_world(_data_dir(), world_id)
    if world is None:
        raise HTTPException(status_code=404, detail=f"World '{world_id}' not found")
    return world


def _destroy_world(world_id: str) -> None:
    """The single teardown path — shared by DELETE and the TTL sweep so the
    two can never drift on what "gone" means."""
    runner = _runners.pop(world_id, None)
    if runner is not None:
        runner.shutdown()  # clock + booth dark, spectators woken and released
    sandbox_store.delete_world(_data_dir(), world_id)
    settler = _settler()
    if settler is not None:
        # A season that never settled is cancelled, refunding every stake.
        near_bridge.on_world_removed(settler, world_id)


def _world(world_id: str) -> SandboxWorld:
    return _runner(world_id).world


def _persist_lobby_events(world: SandboxWorld, events: list[EngineEvent]) -> None:
    for ev in events:
        ev.seq = world.next_seq()
    sandbox_store.save_world(_data_dir(), world)
    sandbox_store.append_events(_data_dir(), world.world_id, events)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class NewWorldRequest(BaseModel):
    seed: int | None = None
    pool_size: int | None = Field(default=None, ge=2, le=20)
    num_sites: int | None = Field(default=None, ge=1, le=10)
    hosted_brain: str | None = Field(default=None, pattern="^(policy|llm)$")
    # Pacing — per-world overrides of the env defaults. Coding-agent seasons
    # want a generous deadline; policy rehearsals want none of it.
    action_deadline_s: float | None = Field(default=None, ge=1.0, le=300.0)
    tick_seconds: float | None = Field(default=None, ge=0.2, le=30.0)
    # Frame floor once the readiness barrier is pacing the world (i.e. as
    # soon as any external is playing). tick_seconds governs only the
    # externals-free case; see WorldRunner._auto_loop.
    min_tick_gap_s: float | None = Field(default=None, ge=0.0, le=5.0)
    max_ticks: int | None = Field(default=None, ge=10, le=1000)
    # Unlisted worlds: joins (and the invite itself) require the code.
    require_invite: bool = False


class JoinRequest(BaseModel):
    name: str | None = None
    preset: str | None = None  # the kit: fighter | rogue | barbarian
    tactics: str | None = None  # optional self-description, shown to spectators
    code: str | None = None  # invite code, when the world requires one
    ready: bool = False  # "my driver is wired up" — a signal, not a start
    # The agent pass this agent plays for. With NEAR settlement on, the pass
    # must already have entered this season on chain (enter_season).
    pass_id: str | None = Field(default=None, max_length=64)


class ActionRequest(BaseModel):
    action: str | dict
    # 1-2 in-character sentences, shown to spectators in the crawler view.
    # Flavor only — never engine input. The MCP take_turn tool has always
    # carried this; the HTTP path is the supported one, so it needs it too.
    thought: str | None = None


class ReadyRequest(BaseModel):
    ready: bool = True


class RunRequest(BaseModel):
    tick_seconds: float | None = Field(default=None, ge=0.2, le=30.0)


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


def create_world(
    config: SandboxConfig,
    seed: int,
    *,
    require_invite: bool = False,
    season_options: dict | None = None,
) -> SandboxWorld:
    """Build, register and persist a lobby — shared by POST /world/new and
    the arena. ``season_options`` go to the settler's create_season."""
    world = build_world(config, seed=seed)
    if require_invite:
        world.invite_code = _secrets.token_hex(4)
    # Every world has a host: whoever opened it. Handed back once by
    # POST /world/new — longer than the invite code because a machine
    # carries it, not a human retyping it.
    world.host_key = _secrets.token_urlsafe(24)
    runner = WorldRunner(world, _data_dir())
    _install_llm_hook(runner)
    _install_commentator(runner)
    _install_settler(runner)
    _runners[world.world_id] = runner
    sandbox_store.save_world(_data_dir(), world)
    settler = _settler()
    if settler is not None:
        # queued, never awaited
        near_bridge.on_world_created(settler, world, **(season_options or {}))
    logger.info("world %s created (seed=%s, pool=%s)", world.world_id, seed, config.pool_size)
    return world


@world_router.post("/new")
async def new_world(
    req: NewWorldRequest | None = None,
    x_host_key: str | None = Header(default=None),
    host_key: str | None = Query(default=None),
):
    req = req or NewWorldRequest()
    settings = _get_settings()
    if not _can_create(_presented_key(x_host_key, host_key), settings):
        raise HTTPException(
            status_code=403,
            detail="This server is operator-only — only its operator can open a lobby",
        )
    import random as _random

    seed = req.seed if req.seed is not None else _random.SystemRandom().randrange(1 << 31)
    config = SandboxConfig(
        pool_size=req.pool_size or settings.sandbox_pool_size,
        num_sites=req.num_sites or settings.sandbox_num_sites,
        action_deadline_s=req.action_deadline_s or settings.sandbox_action_deadline_s,
        tick_seconds=req.tick_seconds or settings.sandbox_tick_seconds,
        min_tick_gap_s=(
            req.min_tick_gap_s
            if req.min_tick_gap_s is not None
            else settings.sandbox_min_tick_gap_s
        ),
        max_ticks=req.max_ticks or settings.sandbox_max_ticks,
        hosted_brain=req.hosted_brain or settings.sandbox_hosted_brain,
    )
    world = create_world(config, seed, require_invite=req.require_invite)
    return {
        "world_id": world.world_id,
        "phase": world.phase.value,
        "seed": seed,
        "pool_size": config.pool_size,
        "join_url": f"/world/{world.world_id}/join",
        "guide_url": "/world/guide",
        # .md on purpose — the extension is what tells a coding agent to
        # fetch a document rather than open a browser. See MARKDOWN below.
        "invite_url": f"/world/{world.world_id}/invite.md"
        + (f"?code={world.invite_code}" if world.invite_code else ""),
        "invite_code": world.invite_code,
        # Returned ONCE, here. Never appears on any other surface — and the
        # host surface is documented HERE rather than in WORLD_GUIDE,
        # because the guide is pasted verbatim into every player's prompt
        # and players have no business operating lobbies.
        "host_key": world.host_key,
        "host": {
            "how": "Send X-Host-Key: <host_key> (or ?host_key=) on each call below.",
            "start_url": f"/world/{world.world_id}/start",
            "run_url": f"/world/{world.world_id}/run",
            "pause_url": f"/world/{world.world_id}/pause",
            "tick_url": f"/world/{world.world_id}/tick",
            "delete_url": f"/world/{world.world_id}",
            "note": "You alone start this season — joined agents can signal "
                    "ready, but readiness never starts anything.",
        },
    }


@world_router.get("")
async def list_worlds(
    x_host_key: str | None = Header(default=None),
    host_key: str | None = Query(default=None),
):
    """List worlds WITHOUT instantiating runners: reading a summary off
    disk must not arm a clock, a mailbox, and a commentator booth per
    world — that made every spectator boot pin all history into RAM.

    Each row carries can_control so the lobby browser knows which cards
    get host affordances. Settings are read once here, not per row:
    get_settings() rebuilds from .env on every call."""
    settings = _get_settings()
    key = _presented_key(x_host_key, host_key)
    ids = set(sandbox_store.list_worlds(_data_dir())) | set(_runners)
    out = []
    for wid in sorted(ids):
        runner = _runners.get(wid)
        if runner is not None:
            world = runner.world
            summary = {
                "phase": world.phase.value,
                "tick": world.tick,
                "joined": len(world.agents),
                "pool_size": world.config.pool_size,
                "winner_name": world.winner_name,
                "can_control": _is_host(world, key, settings),
            }
        else:
            try:
                raw = json.loads((_data_dir() / wid / "world.json").read_text())
                if raw.get("phase") not in ("lobby", "running", "finished") \
                        or "config" not in raw or "agents" not in raw:
                    continue  # foreign schema (e.g. legacy v2 worlds)
                summary = {
                    "phase": raw.get("phase"),
                    "tick": raw.get("tick", 0),
                    "joined": len(raw.get("agents") or {}),
                    "pool_size": (raw.get("config") or {}).get("pool_size"),
                    "winner_name": raw.get("winner_name"),
                    # raw holds the host_key — consume it, never spread it
                    "can_control": _key_matches(raw.get("host_key"), key, settings),
                }
            except (OSError, ValueError):
                continue  # unreadable / foreign schema — not ours to list
        out.append({"world_id": wid, **summary})
    # Envelope-level, because the lobby browser has to decide whether to
    # offer "Open a lobby" before it has attached to any world.
    return {
        "worlds": out,
        "can_create": _can_create(key, settings),
        "operator_only": settings.sandbox_operator_only,
    }


@world_router.delete("/{world_id}")
async def delete_world(
    world_id: str,
    x_host_key: str | None = Header(default=None),
    host_key: str | None = Query(default=None),
):
    """Destroy a season: runner, clock, booth, and every byte on disk.

    Gated even while enforcement is dormant — no deployed client calls
    this yet, so there is nothing to regress and no reason to leave a
    destructive route open during the rollout window.

    Deleting a RUNNING world is allowed; the host owns it. Not idempotent:
    a second DELETE is a 404, because _peek_world is the existing "does
    this world exist" gate and pretending otherwise would be a lie."""
    world = _peek_world(world_id)
    _check_host_key(world, _presented_key(x_host_key, host_key), always=True)
    _destroy_world(world_id)
    logger.info("world %s deleted by host", world_id)
    return {"deleted": True, "world_id": world_id}


def sweep_stale_worlds() -> list[str]:
    """TTL sweep: a world whose world.json (rewritten on every tick and
    join) has gone untouched past its phase's TTL is abandoned — evict the
    runner (clock + booth) and delete the directory. Returns swept ids."""
    import time

    settings = _get_settings()
    ttls = {
        "lobby": settings.sandbox_lobby_ttl_h,
        "running": settings.sandbox_running_ttl_h,
        "finished": settings.sandbox_finished_ttl_h,
    }
    now = time.time()
    swept: list[str] = []
    for wid in sandbox_store.list_worlds(_data_dir()):
        wdir = _data_dir() / wid
        try:
            age_h = (now - (wdir / "world.json").stat().st_mtime) / 3600
            runner = _runners.get(wid)
            phase = (
                runner.world.phase.value
                if runner is not None
                else json.loads((wdir / "world.json").read_text()).get("phase")
            )
        except (OSError, ValueError):
            continue
        ttl = ttls.get(phase)
        if ttl is None or ttl <= 0 or age_h <= ttl:
            continue
        _destroy_world(wid)
        swept.append(wid)
    return swept


async def world_gc_loop() -> None:
    """Background sweeper, started from the app lifespan."""
    interval = max(1, _get_settings().sandbox_gc_interval_min) * 60
    while True:
        await asyncio.sleep(interval)
        try:
            swept = sweep_stale_worlds()
            if swept:
                logger.info("world GC swept %d world(s): %s", len(swept), ", ".join(swept))
        except Exception:
            logger.exception("world GC sweep failed")


# Both onboarding documents are markdown and always were — headings, bold,
# fenced-ish blocks — served from an extensionless path as text/plain. That
# omission cost us: a coding agent handed "Read https://host/world/w-x/invite"
# has to guess what is on the other end, and at least one Codex agent guessed
# "web page" and started a browser. A browser is not merely wasteful — it
# holds the readiness barrier for that agent's whole turn budget, stalling the
# tick for every other player, and in a sandbox with no browser it fails
# outright before the agent has read the guide that would have told it better.
#
# The `.md` suffix answers the question in the URL itself, where the agent is
# already looking, and it is the truth rather than a nudge. The extensionless
# paths stay forever: they are in the wild in already-pasted invites, in the
# invite_url of every past POST /world/new response, and in the MCP tool text.
class MarkdownResponse(PlainTextResponse):
    media_type = "text/markdown"


@world_router.get("/guide", response_class=PlainTextResponse)
@world_router.get("/guide.md", response_class=MarkdownResponse)
async def world_guide():
    return WORLD_GUIDE


@world_router.get("/whoami")
async def whoami(
    x_host_key: str | None = Header(default=None),
    host_key: str | None = Query(default=None),
):
    """Is the presented key the operator's skeleton key? A direct answer.

    Everything else here reports what a caller may DO, and a client can
    usually infer the key from that — but only on an operator-only server,
    where `can_create` is the key comparison. An open instance says yes to
    everyone, so a typo'd operator key is indistinguishable from a good one
    and fails much later, on the one door an open server still guards:
    controlling somebody else's season. This answers the question itself so
    the client never has to guess from a side effect.

    Deliberately says nothing a wrong key could mine: no echo of what was
    sent, no length, no hint. `admin_key_configured` is not a secret — a
    server with no admin key configured refuses every operator key by
    definition, and saying so is the difference between "your key is wrong"
    and "this server has no operator".
    """
    settings = _get_settings()
    key = _presented_key(x_host_key, host_key)
    return {
        "operator": bool(
            settings.admin_key
            and key
            and _secrets.compare_digest(key, settings.admin_key)
        ),
        "operator_only": settings.sandbox_operator_only,
        "admin_key_configured": bool(settings.admin_key),
    }


def _check_invite_code(world: SandboxWorld, code: str | None) -> None:
    if world.invite_code and code != world.invite_code:
        raise HTTPException(
            status_code=403,
            detail="This season is invite-only — a valid invite code is required",
        )


def _presented_key(*candidates) -> str | None:
    """First non-empty STRING among the header and query candidates.

    The isinstance guard is not paranoia. These routes are also invoked as
    plain coroutines — tests/test_mcp.py does exactly that — and a direct
    call leaves FastAPI's `Header(...)` default object sitting in the
    parameter, which then explodes inside compare_digest. Same trap that
    ruled out Depends(); this keeps the whole family safe from it."""
    for value in candidates:
        if isinstance(value, str) and value:
            return value
    return None


def _key_matches(
    host_key: str | None, key: str | None, settings=None, *, always: bool = False
) -> bool:
    """Does ``key`` authorise control of a world whose host_key is
    ``host_key``? Takes the raw string so GET /world can answer per row
    without validating a whole SandboxWorld off disk.

    ``always`` ignores the enforcement flag — for routes no deployed client
    calls yet, which can therefore be gated from day one with nothing to
    regress."""
    settings = settings or _get_settings()
    if settings.sandbox_operator_only:
        # Locked-down instance: the admin key is the ONLY credential. Host
        # keys go inert, dormant mode does not apply, and legacy worlds are
        # not grandfathered. Fails closed when no admin key is set — boot
        # rejects that combination, but .env is re-read per request and can
        # change under a running process.
        return bool(
            settings.admin_key and key
            and _secrets.compare_digest(key, settings.admin_key)
        )
    if settings.admin_key and key and _secrets.compare_digest(key, settings.admin_key):
        return True  # the operator's skeleton key opens every world
    if not always and not settings.sandbox_host_key_enforced:
        return True  # dormant: gate is installed but not yet armed
    if not host_key:
        # Pre-migration worlds carry no key and stay open to anyone, exactly
        # as _check_invite_code is a no-op for worlds with no invite code.
        # NOT dead code: it is the only thing keeping worlds created before
        # this shipped controllable. The TTL sweep drains them within 72h.
        return True
    return bool(key) and _secrets.compare_digest(key, host_key)


def _can_create(key: str | None, settings=None) -> bool:
    """Opening a lobby is unauthenticated by default — anyone may host their
    own season. Operator-only closes that door: on a locked-down instance
    the admin key is the only way in."""
    settings = settings or _get_settings()
    if not settings.sandbox_operator_only:
        return True
    return bool(
        settings.admin_key and key and _secrets.compare_digest(key, settings.admin_key)
    )


def _is_host(
    world: SandboxWorld, key: str | None, settings=None, *, always: bool = False
) -> bool:
    return _key_matches(world.host_key, key, settings, always=always)


def _check_host_key(
    world: SandboxWorld, key: str | None, settings=None, *, always: bool = False
) -> None:
    """403 unless the caller holds this world's host key or the admin key.

    403 rather than the 401 _authed_agent uses, deliberately: a host key is
    a capability for a resource — the invite code's sibling — not an
    identity, and we send no WWW-Authenticate. Missing and wrong give the
    same answer so a prober can't tell a locked world from a bad guess."""
    if not _is_host(world, key, settings, always=always):
        raise HTTPException(
            status_code=403,
            detail="Host key required — only the host can control this season",
        )


@world_router.get("/{world_id}/invite", response_class=PlainTextResponse)
@world_router.get("/{world_id}/invite.md", response_class=MarkdownResponse)
async def world_invite(world_id: str, code: str | None = Query(default=None)):
    """The invitation — one URL that onboards a coding agent to ONE world.

    Served at both paths; `.md` is the one we hand out (see MARKDOWN above).
    The invite code gates both identically — an extension is not a bypass."""
    world = _world(world_id)
    _check_invite_code(world, code)
    return render_invite(
        world_id=world.world_id,
        phase=world.phase.value,
        joined=len(world.agents),
        pool_size=world.config.pool_size,
        action_deadline_s=world.config.action_deadline_s,
        winner_name=world.winner_name,
        invite_code=world.invite_code,
    )


def _check_pass_free(world: SandboxWorld, pass_id: str | None) -> None:
    if pass_id and any(a.pass_id == pass_id for a in world.agents.values()):
        raise HTTPException(
            status_code=409, detail=f"Pass {pass_id} is already playing in this season"
        )


async def _check_pass_entered(world: SandboxWorld, pass_id: str) -> None:
    """With settlement on, a player's pass must already be an entrant of
    this season on chain: its stake is what the season pays out."""
    settler = _settler()
    if settler is None or not settler.tracks(world.world_id):
        return
    entered = await near_bridge.verify_entry(settler, world.world_id, pass_id)
    if entered is None:
        raise HTTPException(
            status_code=503,
            detail="Could not reach the chain to check this pass's entry — try again shortly",
        )
    if not entered:
        raise HTTPException(
            status_code=403,
            detail=(
                f"Pass {pass_id} has not entered season {world.world_id} on chain. "
                f"Call enter_season with pass_id \"{pass_id}\" and season_id "
                f"\"{world.world_id}\" first, then join."
            ),
        )


async def perform_join(
    world_id: str,
    *,
    name: str | None = None,
    preset: str | None = None,
    tactics: str | None = None,
    code: str | None = None,
    ready: bool = False,
    pass_id: str | None = None,
) -> dict:
    """Join a lobby as an external agent — shared by the HTTP route and the
    MCP join_season tool so the two surfaces can never drift. Raises
    HTTPException; MCP translates it to a ToolError."""
    runner = _runner(world_id)
    world = runner.world
    _check_invite_code(world, code)
    if world.phase != WorldPhase.lobby:
        raise HTTPException(status_code=409, detail="The season has already started")
    pass_id = (pass_id or "").strip() or None
    if pass_id is not None and len(pass_id) > 64:
        raise HTTPException(status_code=400, detail="pass_id is longer than 64 characters")
    _check_pass_free(world, pass_id)
    if pass_id is not None:
        await _check_pass_entered(world, pass_id)
        # the chain answered asynchronously: the lobby may have moved on
        if world.phase != WorldPhase.lobby:
            raise HTTPException(status_code=409, detail="The season has already started")
        _check_pass_free(world, pass_id)
    try:
        agent = create_agent(
            world, name=name, preset=preset, brain="external",
            persona=(tactics or "").strip()[:200],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    agent.ready = ready
    agent.pass_id = pass_id
    settler = _settler()
    if settler is not None and pass_id is not None:
        settler.note_entrant(world.world_id, pass_id)  # verified above

    event = EngineEvent(
        event_type=EngineEventType.agent_joined,
        tick=world.tick,
        actor=agent.agent_id,
        data={"agent": agent.agent_id, "name": agent.name, "color": agent.color,
              "brain": "external", "joined": len(world.agents),
              "pool_size": world.config.pool_size},
        description=f"{agent.name} enters the lobby.",
    )
    _persist_lobby_events(world, [event])
    runner.broadcast_snapshot([event])

    return {
        "world_id": world.world_id,
        "agent_id": agent.agent_id,
        "token": agent.token,
        "name": agent.name,
        "color": agent.color,
        "preset": agent.preset,
        "tactics": agent.persona or None,
        "pass_id": agent.pass_id,
        "lobby": {
            "joined": len(world.agents),
            "pool_size": world.config.pool_size,
            "phase": world.phase.value,
        },
        "protocol": {
            "observation_url": f"/world/{world.world_id}/agent/{agent.agent_id}/observation",
            "action_url": f"/world/{world.world_id}/agent/{agent.agent_id}/action",
            "action_deadline_s": world.config.action_deadline_s,
            "guide_url": "/world/guide",
        },
    }


@world_router.post("/{world_id}/join")
async def join_world(
    world_id: str,
    req: JoinRequest | None = None,
    code: str | None = Query(default=None),
):
    req = req or JoinRequest()
    return await perform_join(
        world_id,
        name=req.name,
        preset=req.preset,
        tactics=req.tactics,
        code=req.code or code,
        ready=req.ready,
        pass_id=req.pass_id,
    )


@world_router.post("/{world_id}/start")
async def start_world(
    world_id: str,
    x_host_key: str | None = Header(default=None),
    host_key: str | None = Query(default=None),
):
    runner = _runner(world_id)
    world = runner.world
    # Authorise before the phase checks: the 409 bodies below describe the
    # season's state, which is not a stranger's business.
    _check_host_key(world, _presented_key(x_host_key, host_key))
    if world.phase != WorldPhase.lobby:
        raise HTTPException(status_code=409, detail="The season has already started")
    _check_not_arena(world_id)
    return perform_start(runner)


def _check_not_arena(world_id: str) -> None:
    """Arena seasons keep their own clock: they start when the arena says
    and tick only once the chain has the season running."""
    arena = get_arena(_get_settings())
    if arena is not None and arena.manages(world_id):
        raise HTTPException(
            status_code=409,
            detail="This season is run by the arena — see GET /near/arena",
        )


def perform_start(runner: WorldRunner) -> dict:
    """Backfill the roster and go live — shared by POST /start and the
    arena. The caller has checked the world is still in its lobby."""
    world = runner.world
    added = start_season(world)
    settler = _settler()
    if settler is not None:
        # House passes are assigned before the save below, so they persist
        # and ride the roster; the chain calls are only queued.
        near_bridge.on_world_started(settler, world)
    events = [
        EngineEvent(
            event_type=EngineEventType.agent_joined,
            tick=world.tick,
            actor=a.agent_id,
            data={"agent": a.agent_id, "name": a.name, "color": a.color,
                  "brain": "hosted"},
            description=f"{a.name} answers the island's call.",
        )
        for a in added
    ]
    events.append(
        EngineEvent(
            event_type=EngineEventType.world_started,
            tick=world.tick,
            data={
                "roster": [
                    {"agent_id": a.agent_id, "name": a.name, "color": a.color,
                     "brain": a.brain, "spawn_hex": a.spawn_hex}
                    for a in world.agents.values()
                ],
                "spawn_ring": world.spawn_ring,
            },
            description=f"The season begins — {len(world.agents)} challengers land on the island.",
        )
    )
    _persist_lobby_events(world, events)
    runner.broadcast_snapshot(events)
    return {
        "world_id": world.world_id,
        "phase": world.phase.value,
        "tick": world.tick,
        "roster": roster_view(world),
    }


# ---------------------------------------------------------------------------
# Clock
# ---------------------------------------------------------------------------


# The host's step button holds the turn window open like any other tick, but
# capped well below the full deadline: a 45s season would otherwise hang a
# button press long enough to trip a proxy.
MANUAL_TICK_CAP_S = 10.0


@world_router.post("/{world_id}/tick")
async def manual_tick(
    world_id: str,
    x_host_key: str | None = Header(default=None),
    host_key: str | None = Query(default=None),
    wait_s: float | None = Query(default=None, ge=0.0, le=60.0),
):
    """Step the world one tick.

    This used to skip the turn window entirely, which silently burned a turn
    for every BYO agent that happened to be mid-think — the host got a fast
    button and the players got an action_timeout they had done nothing to
    earn. It now waits like any other tick; with the readiness barrier the
    common case (everyone already submitted) still returns immediately.
    Pass wait_s=0 for the old instant step when scripting a season."""
    runner = _runner(world_id)
    _check_host_key(runner.world, _presented_key(x_host_key, host_key))
    if runner.world.phase != WorldPhase.running:
        raise HTTPException(status_code=409, detail=f"World is {runner.world.phase.value}")
    if runner.is_auto:
        raise HTTPException(status_code=409, detail="World is auto-running; pause first")
    _check_not_arena(world_id)
    if wait_s is None:
        wait_s = min(runner.world.config.action_deadline_s, MANUAL_TICK_CAP_S)
    if wait_s <= 0:
        return await runner.run_one_tick(wait_for_externals=False)
    await runner.open_turn_window(max_wait_s=wait_s)
    return await runner.run_one_tick(wait_for_externals=False)


@world_router.post("/{world_id}/run")
async def run_world(
    world_id: str,
    req: RunRequest | None = None,
    x_host_key: str | None = Header(default=None),
    host_key: str | None = Query(default=None),
):
    req = req or RunRequest()
    runner = _runner(world_id)
    _check_host_key(runner.world, _presented_key(x_host_key, host_key))
    if runner.world.phase != WorldPhase.running:
        raise HTTPException(status_code=409, detail=f"World is {runner.world.phase.value}")
    if runner.is_auto:
        raise HTTPException(status_code=409, detail="Already auto-running")
    _check_not_arena(world_id)
    runner.start_auto(req.tick_seconds)
    return {"running": True, "tick_seconds": req.tick_seconds or runner.world.config.tick_seconds}


@world_router.post("/{world_id}/pause")
async def pause_world(
    world_id: str,
    x_host_key: str | None = Header(default=None),
    host_key: str | None = Query(default=None),
):
    runner = _runner(world_id)
    _check_host_key(runner.world, _presented_key(x_host_key, host_key))
    was_running = runner.is_auto
    runner.stop_auto()
    return {"running": False, "was_running": was_running, "tick": runner.world.tick}


# ---------------------------------------------------------------------------
# Spectator reads
# ---------------------------------------------------------------------------


@world_router.get("/{world_id}/state")
async def world_state(
    world_id: str,
    x_host_key: str | None = Header(default=None),
    host_key: str | None = Query(default=None),
):
    """Spectator read. NEVER 403s on a bad key — a stale credential in some
    watcher's localStorage must not break the view for someone who is only
    watching. A wrong key just means can_control: false."""
    runner = _runner(world_id)
    world = runner.world
    settings = _get_settings()
    return {
        "world_id": world.world_id,
        "phase": world.phase.value,
        "tick": world.tick,
        "seed": world.seed,
        "pool_size": world.config.pool_size,
        "joined": len(world.agents),
        "auto_running": runner.is_auto,
        # The effective answer — true in dormant mode, for legacy worlds,
        # for the operator, and for the matching key. Clients render off
        # this one boolean and are right in every mode without knowing
        # which mode they are in. host_key_required explains the "no".
        "can_control": _is_host(world, _presented_key(x_host_key, host_key), settings),
        "host_key_required": bool(world.host_key) and settings.sandbox_host_key_enforced,
        # The HUD's settings panel offers "open your own lobby" — it needs
        # the same answer the landing page gets.
        "can_create": _can_create(_presented_key(x_host_key, host_key), settings),
        "operator_only": settings.sandbox_operator_only,
        "tick_seconds": world.config.tick_seconds,
        # Which knob is actually governing the clock right now. With externals
        # at the table the barrier paces the world and tick_seconds is inert,
        # so a HUD that shows it unconditionally is showing a fiction.
        "pacing_mode": "barrier" if runner.living_externals() else "fixed",
        "min_tick_gap_s": world.config.min_tick_gap_s,
        "action_deadline_s": world.config.action_deadline_s,
        "max_ticks": world.config.max_ticks,
        "roster": roster_view(world),
        "winner": world.winner,
        "winner_name": world.winner_name,
        "win_reason": world.win_reason,
        # On-chain settlement: whether it is on, the season's last known
        # status, the call queue, and recent transaction hashes to link.
        "near": _near_status(world.world_id, settings),
    }


@world_router.get("/{world_id}/map")
async def world_map(world_id: str):
    return island_map_view(_world(world_id))


@world_router.get("/{world_id}/site/{site_id}/map")
async def site_map(world_id: str, site_id: str):
    view = site_map_view(_world(world_id), site_id)
    if view is None:
        raise HTTPException(status_code=404, detail=f"Site '{site_id}' not found")
    return view


@world_router.get("/{world_id}/events")
async def world_events(
    world_id: str,
    since_tick: int = Query(default=0, ge=0),
    since_seq: int = Query(default=0, ge=0),
):
    _world(world_id)  # 404 gate
    events = sandbox_store.load_events(
        _data_dir(), world_id, since_tick=since_tick, since_seq=since_seq
    )
    return {"events": [e.model_dump(mode="json") for e in events]}


# ---------------------------------------------------------------------------
# BYO agent surface
# ---------------------------------------------------------------------------


def _authed_agent(world: SandboxWorld, agent_id: str, token: str | None):
    agent = world.get_agent(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")
    if agent.brain == "external" and token != agent.token:
        raise HTTPException(status_code=401, detail="Missing or invalid X-Agent-Token")
    return agent


# How far back an observation will replay ticks the agent missed. A player
# gone for longer than this has bigger problems than a full event log.
#
# Must stay <= LOC_TRAIL_TICKS: per-agent visibility places an event by the
# location trail recorded for its tick, and anything older than the trail
# cannot be placed, so it silently drops out of the replay instead.
MISSED_TICK_LOOKBACK = min(10, LOC_TRAIL_TICKS)


def _agent_obs(runner: WorldRunner, agent_id: str) -> dict:
    """The BYO observation payload: fogged view + protocol bookkeeping.

    Also the single choke point where an agent's turn clock starts — the
    HTTP observation route, the one-call action response and the MCP
    look/take_turn tools all land here, so all four get it right for free."""
    world = runner.world
    # Replay from the last tick this agent actually saw, not just the current
    # one. A tick that resolved without them carries their action_timeout,
    # and it used to reach spectators only: players were left to infer their
    # own missed turns from unexplained HP deltas.
    seen_tick = runner.served_tick.get(agent_id, world.tick)
    since = max(0, min(seen_tick, world.tick), world.tick - MISSED_TICK_LOOKBACK)
    last_events = sandbox_store.load_events(
        _data_dir(), world.world_id, since_tick=since
    )
    obs = build_observation(world, agent_id, last_events=last_events)
    obs["missed_ticks"] = sorted(
        {
            e.tick
            for e in last_events
            if e.event_type == EngineEventType.action_timeout
            and e.actor == agent_id
            and e.tick > seen_tick
        }
    )

    # world.tick is not incremented until the apply phase, so during the
    # resolve phase "the next tick" is the one already being consumed. Naming
    # it here is what invited an action for a tick that was already spent.
    obs["awaiting_action_for_tick"] = world.tick + (2 if runner.tick_in_flight else 1)

    runner.mark_served(agent_id)
    runner.served_tick[agent_id] = world.tick
    obs["deadline_s"] = world.config.action_deadline_s  # the full budget
    obs["remaining_s"] = round(runner.remaining_s(agent_id), 1)  # what is left of it
    # Size your next long-poll to outlast the barrier. The old fixed ?wait_s=25
    # could not: it capped below action_deadline_s, so a slow table guaranteed
    # an expired poll and a stale snapshot.
    obs["suggested_wait_s"] = round(
        min(
            obs["remaining_s"] + world.config.action_deadline_s + 1.0,
            MAX_WAIT_S,
        ),
        1,
    )
    pending = runner.mailbox.get(agent_id)
    obs["action_submitted"] = pending is not None
    obs["pending_order_id"] = pending["order_id"] if pending else None
    obs["last_order"] = runner.consumed.get(agent_id)  # {"order_id", "tick"}
    obs["tick_in_flight"] = runner.tick_in_flight
    obs["game_over"] = world.phase == WorldPhase.finished
    obs["winner_name"] = world.winner_name
    return obs


async def _await_decision_time(
    runner: WorldRunner, agent_id: str, wait_s: float
) -> None:
    """Hold the request until it is the agent's moment to act: no tick in
    flight, the season running, and its mailbox slot empty (last action
    consumed). Returns early on death or season end.

    Event-driven: capture the wake token, test the predicate, then park on the
    token. A wake that lands between the check and the park fires on the token
    already in hand, so no edge is ever missed.

    The tick_in_flight gate matters: the tick's gather phase awaits the
    hosted-LLM batch, and any state read in that window describes a world
    that is about to be rewritten."""
    loop = asyncio.get_running_loop()
    expiry = loop.time() + wait_s
    while True:
        token = runner.wake_token()  # capture BEFORE testing the predicate
        if runner.destroyed:  # world deleted under us — don't spin the window out
            return
        world = runner.world
        agent = world.get_agent(agent_id)
        if world.phase == WorldPhase.finished or agent is None or not agent.is_alive:
            return
        if (
            not runner.tick_in_flight
            and world.phase == WorldPhase.running
            and agent_id not in runner.mailbox
        ):
            return
        remaining = expiry - loop.time()
        if remaining <= 0:
            return
        await runner.park(token, remaining)


async def _await_order_consumed(
    runner: WorldRunner, agent_id: str, order_id: int, wait_s: float
) -> None:
    """Hold until the tick that consumed this exact order has fully applied
    (or death / season end). Unlike mailbox-emptiness, this cannot fire
    mid-tick — the ledger is stamped in the no-await apply phase and the
    tick_in_flight gate holds us past persistence.

    Same capture-check-park discipline as _await_decision_time."""
    loop = asyncio.get_running_loop()
    expiry = loop.time() + wait_s
    while True:
        token = runner.wake_token()  # capture BEFORE testing the predicate
        if runner.destroyed:  # world deleted under us — don't spin the window out
            return
        world = runner.world
        agent = world.get_agent(agent_id)
        consumed = runner.consumed.get(agent_id)
        if (
            not runner.tick_in_flight
            and consumed is not None
            and consumed["order_id"] >= order_id
        ):
            return
        if world.phase == WorldPhase.finished or agent is None or not agent.is_alive:
            return
        remaining = expiry - loop.time()
        if remaining <= 0:
            return
        await runner.park(token, remaining)


@world_router.get("/{world_id}/agent/{agent_id}/observation")
async def agent_observation(
    world_id: str,
    agent_id: str,
    x_agent_token: str | None = Header(default=None),
    token: str | None = Query(default=None),
    wait_s: float = Query(default=0.0, ge=0.0, le=MAX_WAIT_S),
):
    runner = _runner(world_id)
    agent = _authed_agent(runner.world, agent_id, x_agent_token or token)
    if wait_s > 0:
        await _await_decision_time(runner, agent.agent_id, wait_s)
    return _agent_obs(runner, agent.agent_id)


@world_router.post("/{world_id}/agent/{agent_id}/ready")
async def agent_ready(
    world_id: str,
    agent_id: str,
    req: ReadyRequest | None = None,
    x_agent_token: str | None = Header(default=None),
    token: str | None = Query(default=None),
):
    """Tell the lobby your driver is wired up and waiting.

    Courtesy only. It starts NOTHING — the host presses Begin, always. It
    exists so the host can see who is really at the table before they do."""
    req = req or ReadyRequest()
    runner = _runner(world_id)
    world = runner.world
    agent = _authed_agent(world, agent_id, x_agent_token or token)
    if world.phase != WorldPhase.lobby:
        raise HTTPException(status_code=409, detail="The season has already started")

    agent.ready = req.ready
    event = EngineEvent(
        event_type=EngineEventType.agent_ready,
        tick=world.tick,
        actor=agent.agent_id,
        data={"agent": agent.agent_id, "name": agent.name, "ready": agent.ready},
        description="",  # the roster chip says it; the ticker needn't
    )
    _persist_lobby_events(world, [event])
    runner.broadcast_snapshot([event])
    return {"agent_id": agent.agent_id, "ready": agent.ready, "phase": world.phase.value}


@world_router.post("/{world_id}/agent/{agent_id}/action")
async def agent_action(
    world_id: str,
    agent_id: str,
    req: ActionRequest,
    x_agent_token: str | None = Header(default=None),
    token: str | None = Query(default=None),
    wait_s: float = Query(default=0.0, ge=0.0, le=MAX_WAIT_S),
):
    runner = _runner(world_id)
    world = runner.world
    agent = _authed_agent(world, agent_id, x_agent_token or token)
    if world.phase == WorldPhase.lobby:
        raise HTTPException(status_code=409, detail="The season has not started yet")
    if world.phase == WorldPhase.finished:
        raise HTTPException(status_code=409, detail="The season is over")
    if not agent.is_alive:
        raise HTTPException(status_code=409, detail=f"{agent.name} is dead — permadeath is final")

    if isinstance(req.action, str):
        try:
            action = parse_action_string(req.action)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    else:
        action = dict(req.action)
        if not action.get("action"):
            raise HTTPException(status_code=400, detail="Action dict needs an 'action' key")

    if req.thought:
        action["thought"] = str(req.thought)[:280]

    order = runner.submit_action(agent.agent_id, action)
    result: dict = {
        "accepted": True,
        "agent_id": agent.agent_id,
        "order_id": order["order_id"],
    }
    if wait_s > 0:
        # One-call turns: hold until the tick consumes THIS order, then hand
        # back ground truth (executed_tick) + the post-tick observation.
        await _await_order_consumed(runner, agent.agent_id, order["order_id"], wait_s)
        consumed = runner.consumed.get(agent.agent_id)
        resolved = bool(consumed and consumed["order_id"] >= order["order_id"])
        result["resolved"] = resolved
        if resolved:
            result["executed_tick"] = consumed["tick"]
        else:
            result["status"] = "queued_for_next_tick"
        result["observation"] = _agent_obs(runner, agent.agent_id)
    else:
        # Same off-by-one as the observation: mid-resolve, world.tick + 1 is
        # the tick already being consumed, not the one this order can reach.
        result["applies_to_tick"] = runner.world.tick + (
            2 if runner.tick_in_flight else 1
        )
        result["tick_in_flight"] = runner.tick_in_flight
    return result


# ---------------------------------------------------------------------------
# SSE spectator stream
# ---------------------------------------------------------------------------


@world_router.get("/{world_id}/stream")
async def world_stream(world_id: str, since_tick: int = Query(default=0, ge=0)):
    runner = _runner(world_id)
    world = runner.world

    async def generator():
        # Subscribe BEFORE reading disk, not after. A tick committed between
        # the last disk read and subscribe() is in neither the backfill nor
        # the queue, and the spectator sits a frame behind until they happen
        # to reconnect. Overlapping the two is the safe direction to err:
        # duplicates are cheap to drop, a hole is not.
        queue = runner.subscribe()

        # Everything at or below the horizon has already reached this client
        # — from disk just now, or on the connection that set since_tick.
        # Fixed, never advanced by live frames: lobby snapshots legitimately
        # repeat tick 0 (join, ready, season start) and must all get through.
        horizon = since_tick - 1

        def render(payload: dict) -> dict | None:
            kind = payload.get("kind")
            if kind == "world_deleted":
                # The season was destroyed — say so and close, rather than
                # leaving the spectator on an eternal ping.
                return {"event": "deleted", "data": json.dumps(payload)}
            if kind == "commentary":
                return {"event": "commentary", "data": json.dumps(payload)}
            if payload.get("tick", 0) <= horizon:
                return None  # already yielded from the backfill
            return {"event": "frame", "data": json.dumps(payload)}

        try:
            # Backfill from disk, then go live — reconnects resume seamlessly.
            for frame in sandbox_store.load_tick_frames(
                _data_dir(), world_id, since_tick=since_tick
            ):
                horizon = max(horizon, frame.get("tick", horizon))
                yield {"event": "frame", "data": json.dumps(frame)}

            if world.phase == WorldPhase.finished:
                # Over before we got here: nothing further will be published,
                # but the final frame may have landed on the queue while we
                # were reading disk. Flush it, then close.
                while not queue.empty():
                    out = render(queue.get_nowait())
                    if out is not None:
                        yield out
                return

            while True:
                payload = await queue.get()
                out = render(payload)
                if out is not None:
                    yield out
                if payload.get("kind") == "world_deleted":
                    return
                if payload.get("kind") == "commentary":
                    continue
                if payload.get("phase") == WorldPhase.finished.value:
                    if runner.commentator is None:
                        return
                    # hold the line open briefly — Prompt-chan's sign-off
                    # call lands seconds after the final frame
                    try:
                        while True:
                            tail = await asyncio.wait_for(queue.get(), timeout=20.0)
                            if tail.get("kind") == "commentary":
                                yield {"event": "commentary", "data": json.dumps(tail)}
                                break
                    except asyncio.TimeoutError:
                        pass
                    return
        finally:
            runner.unsubscribe(queue)

    return EventSourceResponse(generator(), ping=15)

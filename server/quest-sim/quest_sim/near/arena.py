"""The arena: Agent Island seasons that run themselves, settled on NEAR.

On when both ``QUEST_SIM_NEAR_ENABLED`` and ``QUEST_SIM_NEAR_ARENA_ENABLED``
are set. The arena keeps exactly one world in its lobby (the next season,
already created on chain) and runs at most one season at a time:

* A visitor's agent key calls ``enter_season`` on chain; then
  ``POST /near/arena/join`` seats a hosted agent for that pass in the lobby.
* The lobby starts ``countdown_s`` after its first seat, as soon as no
  arena season is running. ``POST /near/arena/start`` starts it with house
  agents only, at most once per ``house_gap_s``.
* Starting reads ``get_season`` and gives a seat to every entrant on chain
  that has none, so every stake has an agent playing for it; backfills
  the house cast; queues the house entries and ``start_season``; and only
  once the settler has seen the season ``Running`` does the clock start.
  A new lobby is opened the moment the old one starts.
* Arena worlds use the zero-LLM policy brain. Betting locks
  ``lock_ticks`` ticks in. The latest finished world is kept for
  spectators; older ones are dropped.

At boot the arena cancels any arena season a previous process left open,
and reads every house pass on chain: a pass whose ``active_season`` is a
season this server has no record of (its disk went with a redeploy) has
that season cancelled, which refunds its stakes and frees its passes.

As with all settlement, the server is a trusted reporter of the game.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from collections.abc import Callable

from quest_sim.engine.sandbox.build import create_agent
from quest_sim.models.events import EngineEvent, EngineEventType
from quest_sim.models.sandbox import SandboxConfig, SandboxWorld, WorldPhase
from quest_sim.near import bridge, get_settler
from quest_sim.near.client import NearError, TransportError
from quest_sim.near.settler import Settler

logger = logging.getLogger(__name__)

# The house agents a visitor can rent, as the start app names them:
# roster_id -> (kit, policy disposition, one-line persona).
ROSTER_KITS: dict[str, tuple[str, str, str]] = {
    "mimir": ("rogue", "opportunist", "Market oracle. Plays the odds, loots late."),
    "cassandra": ("fighter", "aggressive", "Sees the loss coming. Goes in anyway."),
    "roko": ("barbarian", "aggressive", "Berserker. First into every dungeon."),
    "aegis": ("fighter", "turtle", "Armoured and patient. Wins by outlasting."),
}
DEFAULT_KIT = ("fighter", "balanced", "")
MAX_SEATS = 16  # the contract's max_entrants


class ArenaRefusal(Exception):
    """A request the arena turns down; the routes answer with ``status``."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _routes():
    # world_routes owns the world registry; imported late (it imports us)
    from quest_sim.api import world_routes

    return world_routes


class Arena:
    def __init__(
        self,
        settler: Settler,
        *,
        pool_size: int = 6,
        tick_seconds: float = 1.0,
        max_ticks: int = 150,
        countdown_s: float = 20.0,
        house_gap_s: float = 600.0,
        lock_ticks: int = 10,
        num_sites: int = 6,
        action_deadline_s: float = 5.0,
        poll_s: float = 0.5,
        seed_fn: Callable[[], int] | None = None,
    ):
        self.settler = settler
        self.pool_size = pool_size
        self.tick_seconds = tick_seconds
        self.max_ticks = max_ticks
        self.countdown_s = countdown_s
        self.house_gap_s = house_gap_s
        self.lock_ticks = lock_ticks
        self.num_sites = num_sites
        self.action_deadline_s = action_deadline_s
        self.poll_s = poll_s
        self._seed = seed_fn or (lambda: random.SystemRandom().randrange(1 << 31))

        self.lobby_id: str | None = None
        self.first_seat_at: float | None = None
        self.running_id: str | None = None
        self.running_stage: str | None = None  # starting | ticking | settling
        self.last_id: str | None = None
        self.last_result: dict | None = None
        self.last_house_start_at: float | None = None
        self.scan_done = False  # boot self-heal finished
        self._next_scan_at = 0.0
        self._last_refusal: str | None = None  # logged once per change
        self._healed: set[str] = set()
        self._booted = False
        self._starting: str | None = None  # lobby whose start is in progress
        self._start_lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    @staticmethod
    def _now() -> float:
        return time.monotonic()

    def manages(self, world_id: str) -> bool:
        return world_id in (self.lobby_id, self.running_id, self.last_id)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def ensure_started(self) -> None:
        """Boot once, and keep the background loop running on this loop."""
        loop = asyncio.get_running_loop()
        if not self._booted:
            self._booted = True
            self._drop_previous()
            self._ensure_lobby()
        alive = self._task is not None and not self._task.done()
        if alive and self._loop is loop:
            return
        self._loop = loop
        self._task = loop.create_task(self._run(), name="near-arena")

    async def start(self) -> None:
        self.ensure_started()

    async def stop(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._task = None

    async def _run(self) -> None:
        while True:
            try:
                await self.step()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("arena step failed")
            await asyncio.sleep(self.poll_s)

    async def step(self) -> None:
        if not self.scan_done and self._now() >= self._next_scan_at:
            await self._self_heal()
        self._ensure_lobby()
        self._advance_running()
        lobby = self._lobby_world()
        if lobby is None:
            return
        if lobby.agents and self.first_seat_at is None:
            self.first_seat_at = self._now()  # seated through another route
        if (
            self.running_id is None
            and self.first_seat_at is not None
            and self._now() - self.first_seat_at >= self.countdown_s
            and self._chain_ready(self.lobby_id)
        ):
            try:
                await self.start_lobby(requested=False)
                self._last_refusal = None
            except ArenaRefusal as e:
                if e.detail != self._last_refusal:  # once, not every poll
                    logger.info("arena: lobby %s not started yet: %s", self.lobby_id, e.detail)
                self._last_refusal = e.detail

    # ------------------------------------------------------------------
    # Boot self-heal
    # ------------------------------------------------------------------

    def _drop_previous(self) -> None:
        """Cancel and drop arena worlds a previous process left open."""
        wr = _routes()
        for season_id in self.settler.open_arena_seasons():
            logger.warning("arena: cancelling season %s left open by a previous run", season_id)
            wr._destroy_world(season_id)

    async def _self_heal(self) -> None:
        """Cancel seasons that hold a house pass but that this server has no
        record of. Retried on the next step until the chain answers."""
        passes = sorted(set(bridge.load_house_passes(self.settler.passes_file).values()))
        for pass_id in passes:
            try:
                view = await self.settler.client.view("get_pass", {"pass_id": pass_id})
            except TransportError as e:
                logger.warning("arena: chain unreachable for the boot check (%s); retrying", e)
                self._next_scan_at = self._now() + 10.0
                return
            except NearError as e:
                logger.warning("arena: cannot read pass %s: %s", pass_id, e)
                continue
            active = view.get("active_season") if isinstance(view, dict) else None
            if not active or active in self._healed or self.settler.tracks(str(active)):
                continue
            self._healed.add(str(active))
            if self.settler.cancel_orphan(str(active)) is not None:
                logger.warning(
                    "arena: house pass %s is held by season %s, which this server has "
                    "no record of; cancelling it", pass_id, active,
                )
        self.scan_done = True

    # ------------------------------------------------------------------
    # The lobby
    # ------------------------------------------------------------------

    def _lobby_world(self) -> SandboxWorld | None:
        runner = _routes()._runners.get(self.lobby_id) if self.lobby_id else None
        return runner.world if runner is not None else None

    def _ensure_lobby(self) -> None:
        wr = _routes()
        if self.lobby_id is not None:
            runner = wr._runners.get(self.lobby_id)
            state = self.settler.season_state(self.lobby_id)
            gone = runner is None or runner.world.phase != WorldPhase.lobby
            failed = state is not None and (
                state["create_failed"] or state["status"] == "Cancelled" or state["closed"]
            )
            if gone or failed:
                if failed and not gone:
                    logger.warning("arena: lobby %s failed on chain; replacing it", self.lobby_id)
                    wr._destroy_world(self.lobby_id)
                self.lobby_id = None
                self.first_seat_at = None
        if self.lobby_id is None:
            config = SandboxConfig(
                pool_size=self.pool_size,
                num_sites=self.num_sites,
                tick_seconds=self.tick_seconds,
                max_ticks=self.max_ticks,
                action_deadline_s=self.action_deadline_s,
                hosted_brain="policy",
            )
            world = wr.create_world(
                config, self._seed(),
                season_options={"arena": True, "lock_tick": self.lock_ticks},
            )
            self.lobby_id = world.world_id
            self.first_seat_at = None
            logger.info("arena: lobby %s open for entry", world.world_id)

    def _chain_ready(self, season_id: str | None) -> bool:
        if not self.scan_done or season_id is None:
            return False
        state = self.settler.season_state(season_id)
        return bool(state and state["status"] == "Open")

    @staticmethod
    def _seat_of(world: SandboxWorld, pass_id: str):
        return next((a for a in world.agents.values() if a.pass_id == pass_id), None)

    def _seat(self, world: SandboxWorld, pass_id: str, name: str, roster_id: str | None):
        """A hosted agent playing for this pass. The stake is already in, so
        a full lobby grows a seat rather than turning the stake away."""
        if len(world.agents) >= world.config.pool_size:
            if len(world.agents) >= MAX_SEATS:
                raise ArenaRefusal(409, "The arena is full for this season")
            world.config.pool_size = len(world.agents) + 1
        preset, disposition, persona = ROSTER_KITS.get((roster_id or "").lower(), DEFAULT_KIT)
        agent = create_agent(
            world, name=name, preset=preset, brain="hosted",
            disposition=disposition, persona=persona,
        )
        agent.pass_id = pass_id
        self.settler.note_entrant(world.world_id, pass_id)
        event = EngineEvent(
            event_type=EngineEventType.agent_joined,
            tick=world.tick,
            actor=agent.agent_id,
            data={"agent": agent.agent_id, "name": agent.name, "color": agent.color,
                  "brain": "hosted", "pass_id": pass_id, "joined": len(world.agents),
                  "pool_size": world.config.pool_size},
            description=f"{agent.name} enters the lobby.",
        )
        wr = _routes()
        wr._persist_lobby_events(world, [event])
        runner = wr._runners.get(world.world_id)
        if runner is not None:
            runner.broadcast_snapshot([event])
        if self.first_seat_at is None:
            self.first_seat_at = self._now()
        return agent

    def _seat_entrants(self, world: SandboxWorld, season: dict) -> int:
        """Seat every entrant on chain that has no agent and is not a house
        pass (house passes are seated by the backfill)."""
        house = set(bridge.load_house_passes(self.settler.passes_file).values())
        added = 0
        for entrant in season.get("entrants") or []:
            pass_id = str(entrant.get("pass_id") or "")
            if not pass_id or pass_id in house or self._seat_of(world, pass_id):
                continue
            name = str(entrant.get("name") or "").strip() or f"PASS-{pass_id}"
            self._seat(world, pass_id, name, None)
            added += 1
        return added

    async def join(
        self,
        *,
        world_id: str | None,
        pass_id: str,
        name: str | None = None,
        roster_id: str | None = None,
        account_id: str | None = None,
    ) -> dict:
        self.ensure_started()
        pass_id = (pass_id or "").strip()
        if not pass_id or len(pass_id) > 64:
            raise ArenaRefusal(400, "pass_id must be 1 to 64 characters")
        world_id = world_id or self.lobby_id
        if world_id is None or not self.manages(world_id):
            raise ArenaRefusal(404, f"{world_id} is not an arena season")
        runner = _routes()._runners.get(world_id)
        if runner is None:
            raise ArenaRefusal(404, f"{world_id} is not an arena season")
        world = runner.world

        seat = self._seat_of(world, pass_id)
        if seat is not None:
            return self._join_reply(world, seat)  # a retry: same seat
        self._refuse_if_started(world)
        entered = await bridge.verify_entry(self.settler, world_id, pass_id)
        if entered is None:
            raise ArenaRefusal(
                503, "Could not reach the chain to check this pass's entry — try again shortly"
            )
        if not entered:
            raise ArenaRefusal(
                403,
                f"Pass {pass_id} has not entered season {world_id} on chain. Call "
                f"enter_season with pass_id \"{pass_id}\" and season_id \"{world_id}\" "
                "first, then join.",
            )
        seat = self._seat_of(world, pass_id)  # seated while we asked the chain
        if seat is not None:
            return self._join_reply(world, seat)
        self._refuse_if_started(world)
        agent = self._seat(world, pass_id, (name or "").strip() or f"PASS-{pass_id}", roster_id)
        logger.info(
            "arena: pass %s (%s) seated in %s as %s",
            pass_id, account_id or "unknown account", world_id, agent.name,
        )
        return self._join_reply(world, agent)

    def _refuse_if_started(self, world: SandboxWorld) -> None:
        if world.phase != WorldPhase.lobby or self._starting == world.world_id:
            raise ArenaRefusal(
                409,
                f"Season {world.world_id} has already started. The next one is "
                f"{self.lobby_id}.",
            )

    def _join_reply(self, world: SandboxWorld, agent) -> dict:
        in_lobby = world.world_id == self.lobby_id and world.phase == WorldPhase.lobby
        return {
            "world_id": world.world_id,
            "agent_id": agent.agent_id,
            "name": agent.name,
            "starts_in_s": self._lobby_timing(world)[0] if in_lobby else 0,
        }

    # ------------------------------------------------------------------
    # Starting a season
    # ------------------------------------------------------------------

    def _house_wait_s(self) -> float:
        if self.last_house_start_at is None:
            return 0.0
        return max(0.0, self.house_gap_s - (self._now() - self.last_house_start_at))

    async def start_lobby(self, *, requested: bool) -> dict:
        """Start the lobby: on its countdown, or on request (house start)."""
        self.ensure_started()
        async with self._start_lock:
            lobby_id = self.lobby_id
            world = self._lobby_world()
            if lobby_id is None or world is None:
                raise ArenaRefusal(409, "No lobby is open yet")
            if self.running_id is not None:
                raise ArenaRefusal(409, f"Season {self.running_id} is still running")
            if not self._chain_ready(lobby_id):
                raise ArenaRefusal(409, f"Season {lobby_id} is not open on chain yet")
            if requested and self._house_wait_s() > 0:
                raise ArenaRefusal(
                    429,
                    f"A house season can start again in {self._house_wait_s():.0f}s",
                )
            self._starting = lobby_id
            try:
                try:
                    season = await self.settler.fetch_season(lobby_id)
                except NearError as e:
                    raise ArenaRefusal(503, f"Could not read the season on chain: {e}") from None
                if not isinstance(season, dict):
                    raise ArenaRefusal(409, f"Season {lobby_id} is not on chain yet")
                if world.phase != WorldPhase.lobby:
                    raise ArenaRefusal(409, f"Season {lobby_id} has already started")
                self._seat_entrants(world, season)
                house_only = not world.agents
                wr = _routes()
                result = wr.perform_start(wr._runners[lobby_id])
            finally:
                self._starting = None

            self.running_id, self.running_stage = lobby_id, "starting"
            if house_only:
                self.last_house_start_at = self._now()
            self.lobby_id = None
            self.first_seat_at = None
            self._ensure_lobby()
            logger.info(
                "arena: season %s starting (%d agents%s); next lobby %s",
                lobby_id, len(world.agents), ", house only" if house_only else "",
                self.lobby_id,
            )
            return {"world_id": lobby_id, "roster": result["roster"], "next_world_id": self.lobby_id}

    def _advance_running(self) -> None:
        season_id = self.running_id
        if season_id is None:
            return
        wr = _routes()
        runner = wr._runners.get(season_id)
        if runner is None:  # deleted from under us
            self.running_id = self.running_stage = None
            return
        world = runner.world
        state = self.settler.season_state(season_id)

        if self.running_stage == "starting":
            if state is None or state["create_failed"] or state["start_failed"] or (
                state["status"] == "Cancelled"
            ):
                logger.warning("arena: season %s failed to start on chain; dropping it", season_id)
                wr._destroy_world(season_id)  # its stakes are refunded by the cancel
                self.running_id = self.running_stage = None
                return
            if state["status"] in ("Running", "Settled"):
                # Only now: the chain takes kill reports and the market is
                # live, so the first tick is the first tick it can see.
                runner.start_auto(self.tick_seconds)
                self.running_stage = "ticking"
            return

        if self.running_stage == "ticking":
            if world.phase == WorldPhase.finished:
                self.running_stage = "settling"
            elif not runner.is_auto:
                runner.start_auto(self.tick_seconds)  # the clock stopped: restart it
                return

        if self.running_stage == "settling" and (state is None or state["done"]):
            self._finish(season_id, world, state)

    def _finish(self, season_id: str, world: SandboxWorld, state: dict | None) -> None:
        previous = self.last_id
        self.last_id = season_id
        self.last_result = {
            "world_id": season_id,
            "winner_name": world.winner_name,
            "winner_pass": bridge.winner_pass(world),
            "season_status": state["status"] if state else None,
        }
        self.running_id = self.running_stage = None
        if previous and previous != season_id:
            _routes()._destroy_world(previous)  # keep one finished world, not all
        logger.info("arena: season %s done (%s)", season_id, self.last_result["season_status"])

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def _lobby_timing(self, world: SandboxWorld) -> tuple[float | None, str]:
        """(starts_in_s, waiting_for) for the lobby."""
        if not self._chain_ready(world.world_id):
            return None, "chain"
        if not world.agents:
            return None, "player"
        if self.running_id is not None:
            return None, "running_season"
        since = self._now() - (self.first_seat_at or self._now())
        return round(max(0.0, self.countdown_s - since), 1), "countdown"

    def status(self) -> dict:
        self.ensure_started()
        self._ensure_lobby()
        wr = _routes()
        lobby = None
        world = self._lobby_world()
        if world is not None:
            state = self.settler.season_state(world.world_id)
            starts_in, waiting_for = self._lobby_timing(world)
            lobby = {
                "world_id": world.world_id,
                "season_status": state["status"] if state else None,
                "seats_taken": len(world.agents),
                "seats_total": world.config.pool_size,
                "players": [
                    {"name": a.name, "pass_id": a.pass_id} for a in world.agents.values()
                ],
                "starts_in_s": starts_in,
                "waiting_for": waiting_for,
            }
        running = None
        runner = wr._runners.get(self.running_id) if self.running_id else None
        if runner is not None:
            state = self.settler.season_state(self.running_id)
            running = {
                "world_id": self.running_id,
                "tick": runner.world.tick,
                "max_ticks": runner.world.config.max_ticks,
                "season_status": state["status"] if state else None,
                "stage": self.running_stage,
            }
        return {
            "enabled": True,
            "contract_id": self.settler.contract_id,
            "entry_stake": str(self.settler.entry_stake_yocto),
            "world_id": self.lobby_id,
            "lobby": lobby,
            "running": running,
            "last": dict(self.last_result) if self.last_result else None,
            # when POST /near/arena/start will next be accepted
            "house_start_in_s": None if self.running_id else round(self._house_wait_s(), 1),
            # set while the chain cannot be reached or paid; clears on success
            "chain_error": self.settler.chain_error,
        }


_arena: Arena | None = None


def get_arena(settings) -> Arena | None:
    """The process's arena, or None unless settlement and the arena are on."""
    global _arena
    if not (settings.near_enabled and settings.near_arena_enabled):
        return None
    if _arena is None:
        _arena = Arena(
            get_settler(settings),
            pool_size=settings.near_arena_pool_size,
            tick_seconds=settings.near_arena_tick_seconds,
            max_ticks=settings.near_arena_max_ticks,
            countdown_s=settings.near_arena_countdown_s,
            house_gap_s=settings.near_arena_house_gap_s,
            lock_ticks=settings.near_arena_lock_ticks,
            num_sites=settings.sandbox_num_sites,
            action_deadline_s=settings.sandbox_action_deadline_s,
        )
    return _arena


def install_arena(arena: Arena | None) -> None:
    """Replace the process's arena (tests build one around a fake chain)."""
    global _arena
    _arena = arena

"""The async world runner — the ONLY place wall-clock time exists.

Single-writer discipline: every world mutation happens inside
``run_one_tick`` on the event loop, and the mutation section
(``run_world_tick`` + persistence) contains no awaits — a request handler
can never observe a half-applied tick. Concurrency only ever *produces
inputs*: BYO actions arrive through a mailbox ahead of the tick, and hosted
LLM decisions are gathered from snapshots on worker threads. No thread
touches the world.

Two clocks decide when a tick fires, and neither is a fixed sleep:

* **The readiness barrier** (``open_turn_window``). The tick fires the
  moment the last living external submits, not when a timer says so. This
  is what makes a table of fast agents fast.
* **Per-agent turn budgets.** Each external's ``action_deadline_s`` starts
  when *that* agent is handed an observation (``mark_served``), not when
  the window opened, and the window recomputes rather than waiting out the
  earliest expiry — so an agent served late still gets its whole turn while
  an earlier one is already timed out. ``deadline_for`` is per-agent; there
  is no global deadline.

The world never stalls: when an agent's own budget expires it gets the
engine's defensive default (with a loud ``action_timeout`` event), and a
seat silent for ``PRESUMED_ABSENT`` consecutive windows stops holding the
barrier at all.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from pathlib import Path

from quest_sim.engine.sandbox.perception import roster_view
from quest_sim.engine.sandbox.policy import policy_decide
from quest_sim.engine.sandbox.tick import run_world_tick
from quest_sim.models.sandbox import SandboxWorld, WorldPhase
from quest_sim.persistence import sandbox_store

logger = logging.getLogger(__name__)

# Optional hosted-LLM decision hook, installed by agents/sandbox (M4):
# async (world, agent_ids, last_events) -> dict[agent_id, action dict]
LlmDecideFn = Callable[[SandboxWorld, list[str], list], "dict[str, dict]"]

# Consecutive silent windows before an external seat is presumed abandoned.
# It keeps playing the defensive default and still announces its timeouts —
# it just stops holding the barrier, so a driver that quit or never connected
# costs its own turns instead of everyone's wall-clock. One submission brings
# it straight back to a full deadline.
PRESUMED_ABSENT = 2


def build_tick_frame(world: SandboxWorld, events: list) -> dict:
    """The spectator SSE payload: roster + events, one frame per tick."""
    return {
        "world_id": world.world_id,
        "tick": world.tick,
        "phase": world.phase.value,
        "roster": roster_view(world),
        "events": [e.model_dump(mode="json") for e in events],
        "winner": world.winner,
        "winner_name": world.winner_name,
        "win_reason": world.win_reason,
    }


class WorldRunner:
    """Owns one world's clock, BYO mailbox, and SSE fan-out."""

    def __init__(self, world: SandboxWorld, data_dir: Path):
        self.world = world
        self.data_dir = data_dir
        self.mailbox: dict[str, dict] = {}  # agent_id -> order envelope (submit_action)
        self.consumed: dict[str, dict] = {}  # agent_id -> {"order_id", "tick"} last executed
        self._order_seq = 0
        self.subscribers: list[asyncio.Queue] = []
        self._auto_task: asyncio.Task | None = None
        self._tick_lock = asyncio.Lock()
        self.llm_decide: LlmDecideFn | None = None  # installed in M4
        # Prompt-chan's booth (agents.sandbox.commentator.Commentator),
        # installed by the API layer when a commentator model is configured.
        # She runs on her OWN loop (start_booth) — never on the tick path.
        self.commentator = None
        self._booth_task: asyncio.Task | None = None
        # Called with (world, frame) after every tick's broadcast — the
        # on-chain settler's hook, installed by the API layer when NEAR
        # settlement is on. Synchronous and must only queue work: it runs on
        # the tick path, and an exception from it is logged, never raised.
        self.on_tick: Callable[[SandboxWorld, dict], None] | None = None
        # True from the RESOLVE phase until the world + persistence have
        # advanced. Wait loops must never report state while this is up —
        # mid-tick reads are lies-in-waiting.
        #
        # This flag deliberately does NOT cover the turn window. It used to,
        # and that was the bug: the readiness barrier ran underneath it while
        # _await_decision_time refuses to release under it, so the barrier
        # held the world open waiting for orders from agents that were, for
        # that whole duration, forbidden from receiving an observation. The
        # only window they could be served in was the auto-loop's "pacing"
        # sleep, which is why deleting that sleep required this split.
        self.tick_in_flight = False
        # The readiness barrier's edge, set by submit_action.
        self._ready_event = asyncio.Event()
        # One barrier waiter at a time. Two concurrent waiters could each
        # clear() the ready edge and drop the other's wake; the lock makes
        # single-waiter an invariant instead of an argument.
        self._window_lock = asyncio.Lock()
        self._window_open_at = 0.0  # loop clock the current turn window opened
        self._last_tick_at = 0.0  # loop clock the last tick finished applying
        # agent_id -> loop clock its observation was handed over. The turn
        # deadline is measured from here, not from the barrier's start.
        self.served_at: dict[str, float] = {}
        # agent_id -> the world tick its last observation described. Anything
        # that resolved after this is a tick it has not been told about.
        self.served_tick: dict[str, int] = {}
        # agent_id -> consecutive windows that closed without an order from
        # them. Past the threshold the seat is presumed abandoned and stops
        # costing the rest of the table wall-clock; see PRESUMED_ABSENT.
        self.absent_windows: dict[str, int] = {}
        # Hosted-LLM gather, started at window open so model latency overlaps
        # the humans' thinking instead of being serialised after it.
        self._llm_task: asyncio.Task | None = None
        self._llm_ids: list[str] = []
        # Set once the world has been deleted out from under this runner.
        # Long-polls hold a direct reference to us and would otherwise spin
        # for their full 25-30s window before answering off a world that no
        # longer exists on disk.
        self.destroyed = False
        # The long-poll wake. Every state change that can satisfy a parked
        # request's release predicate must call wake(); see its docstring for
        # the swap-then-set discipline that makes a missed edge impossible.
        self._wake_event = asyncio.Event()

    # ------------------------------------------------------------------
    # Long-poll wake-ups
    # ------------------------------------------------------------------

    def wake_token(self) -> asyncio.Event:
        """Grab the current wake edge. Callers must capture this BEFORE
        testing their release predicate: capture-then-check-then-park is what
        makes a wake landing between the check and the park impossible to
        miss — it would have already fired on the token in hand."""
        return self._wake_event

    def wake(self) -> None:
        """Release every long-poll parked on us.

        Swap-then-set, never set-and-clear: a waiter that captures its token
        after this call gets the *fresh* event, so it can neither latch onto
        an already-set edge (returning instantly forever) nor miss the one it
        was waiting for."""
        event, self._wake_event = self._wake_event, asyncio.Event()
        event.set()

    async def park(self, token: asyncio.Event, timeout: float) -> None:
        """Sleep until the captured edge fires or the timeout expires.

        The inner wait is capped at 5s on purpose. This design is correct only
        if every state change calls wake(); the cap means a wake source we
        forgot degrades to the old polling behaviour instead of hanging a
        player for their full 25-30s window."""
        try:
            await asyncio.wait_for(token.wait(), min(timeout, 5.0))
        except (TimeoutError, asyncio.TimeoutError):
            pass

    # ------------------------------------------------------------------
    # BYO mailbox
    # ------------------------------------------------------------------

    def submit_action(self, agent_id: str, action: dict) -> dict:
        """Buffer an external agent's action as an order envelope. Last write
        wins. Returns the envelope — its order_id is how the API verifies
        consumption instead of guessing from mailbox emptiness."""
        self._order_seq += 1
        order = {
            "order_id": self._order_seq,
            "action": action,
            "submitted_tick": self.world.tick,
        }
        self.mailbox[agent_id] = order
        # Back at the table: a returning driver gets its full deadline again
        # from the very next window, with no probation.
        self.absent_windows.pop(agent_id, None)
        self._ready_event.set()  # the barrier may now be satisfied
        return order

    def living_externals(self) -> list[str]:
        return [
            a.agent_id for a in self.world.living_agents() if a.brain == "external"
        ]

    def _all_externals_ready(self) -> bool:
        return all(a in self.mailbox for a in self.living_externals())

    # ------------------------------------------------------------------
    # The turn window — per-agent budgets and the readiness barrier
    # ------------------------------------------------------------------

    @staticmethod
    def _now() -> float:
        # loop clock, never time.time(): immune to wall-clock steps
        return asyncio.get_running_loop().time()

    def mark_served(self, agent_id: str) -> None:
        """Start this agent's turn clock, at most ONCE per window.

        Called wherever an observation is handed over. The once-per-window
        rule is what stops an agent from re-GETting its way to a fresh budget
        and holding the season hostage."""
        if self.world.phase != WorldPhase.running or self.tick_in_flight:
            return
        agent = self.world.get_agent(agent_id)
        if agent is None or not agent.is_alive or agent.brain != "external":
            return
        if agent_id in self.mailbox:
            return  # already acted this window
        if self.served_at.get(agent_id, -1.0) >= self._window_open_at:
            return  # clock already running
        self.served_at[agent_id] = self._now()

    def deadline_for(self, agent_id: str) -> float:
        """Absolute loop-clock expiry of this agent's turn.

        An agent that never fetched an observation falls back to window open
        — exactly the old behaviour, so a silent agent is never better off."""
        served = self.served_at.get(agent_id)
        base = served if served is not None else self._window_open_at
        return base + self.world.config.action_deadline_s

    def remaining_s(self, agent_id: str) -> float:
        return max(0.0, self.deadline_for(agent_id) - self._now())

    async def open_turn_window(self, max_wait_s: float | None = None) -> None:
        """Hold the world open until every living external has an order or
        its own budget expires — whichever comes first.

        Runs OUTSIDE tick_in_flight, so agents are served and can submit
        throughout. The mailbox is the state and the event is only an edge:
        a lost or stale edge costs a re-check, never a hang.

        Note this loops and recomputes rather than waiting out the earliest
        expiry and giving up. If A was served at t=0 and B at t=4 with a 5s
        budget, A is dropped and timed out at t=5 while the world keeps
        holding for B until t=9 — each agent gets its own full turn.

        ``max_wait_s`` shortens the wall for callers that cannot afford the
        full deadline — the host's step button, which is a click and not a
        clock."""
        async with self._window_lock:
            self._window_open_at = self._now()
            config = self.world.config
            # Belt-and-braces wall. Under the once-per-window rule in
            # mark_served this should never bind, so log loudly if it does.
            budget = config.action_deadline_s + config.min_tick_gap_s
            if max_wait_s is not None:
                budget = min(budget, max_wait_s)
            hard_cap = self._window_open_at + budget
            while True:
                if self.destroyed or self.world.phase != WorldPhase.running:
                    return
                now = self._now()
                pending = [
                    a
                    for a in self.living_externals()
                    if a not in self.mailbox
                    and self.deadline_for(a) > now
                    and self.absent_windows.get(a, 0) < PRESUMED_ABSENT
                ]
                if not pending:
                    return
                if now >= hard_cap:
                    if max_wait_s is None:
                        # A caller-supplied cap binding is expected; the real
                        # wall binding means mark_served's once-per-window rule
                        # failed to bound someone's budget. Say so out loud.
                        logger.warning(
                            "turn window hit its hard cap for %s; still pending: %s",
                            self.world.world_id,
                            pending,
                        )
                    return
                self._ready_event.clear()  # clear BEFORE re-checking the mailbox
                if self._all_externals_ready() or self.destroyed:
                    return
                wake_at = min(min(self.deadline_for(a) for a in pending), hard_cap)
                try:
                    await asyncio.wait_for(
                        self._ready_event.wait(), max(0.0, wake_at - now)
                    )
                except (TimeoutError, asyncio.TimeoutError):
                    pass  # a budget expired — the loop head recomputes

    # ------------------------------------------------------------------
    # The tick
    # ------------------------------------------------------------------

    async def run_one_tick(self, wait_for_externals: bool = True) -> dict:
        """Hold the turn window open, then apply one tick, persist, broadcast.
        Returns the spectator frame.

        The window closes BEFORE tick_in_flight rises. Serving observations
        and resolving the world are mutually exclusive states, and conflating
        them is what used to strand every BYO agent."""
        async with self._tick_lock:
            if self.world.phase != WorldPhase.running:
                return build_tick_frame(self.world, [])

            # --- TURN WINDOW: flag down, observations served, orders taken ---
            if wait_for_externals and self.living_externals():
                self.start_llm_gather()
                await self.open_turn_window()
                if self.world.phase != WorldPhase.running:
                    return build_tick_frame(self.world, [])

            # --- RESOLVE: flag up, no more serving until the world moves ---
            self.tick_in_flight = True
            try:
                frame = await self._tick_body()
            finally:
                self.tick_in_flight = False
            self._last_tick_at = self._now()

        # The dead take no more turns; their stale clocks must not linger in
        # the next window's expiry arithmetic.
        living = set(self.living_externals())
        for agent_id in [a for a in self.served_at if a not in living]:
            del self.served_at[agent_id]

        # Wake source: the tick landed. Must fire AFTER the flag drops and
        # after persistence — both long-polls gate on tick_in_flight, and a
        # wake raised any earlier would release them onto a half-applied world.
        self.wake()
        self._broadcast(frame)
        if self.on_tick is not None:
            try:
                self.on_tick(self.world, frame)
            except Exception:
                logger.exception("tick hook failed for %s", self.world.world_id)
        if self.world.phase == WorldPhase.finished:
            self.stop_auto()
        return frame

    # ------------------------------------------------------------------
    # The booth — Prompt-chan's own clock
    # ------------------------------------------------------------------

    def start_booth(self) -> None:
        """Put the caster on her own loop. She opens the moment the season
        does (tick 0), fires whenever due — mid-tick, between ticks — and
        signs off after the final frame. A slow model just makes her lines
        sparser; it never stalls the world."""
        if self.commentator is None or self.world.phase == WorldPhase.finished:
            return
        if self._booth_task is not None and not self._booth_task.done():
            return
        self._booth_task = asyncio.create_task(self._booth_loop())

    async def _booth_loop(self) -> None:
        booth = self.commentator
        try:
            while True:
                world = self.world
                if world.phase == WorldPhase.lobby:
                    await asyncio.sleep(1.0)
                    continue
                if world.phase == WorldPhase.finished:
                    # guaranteed sign-off: the season_end material is the one
                    # line she must never miss, cadence be damned
                    if booth.pending:
                        await self._speak_once()
                    return
                if booth.due(world.tick):
                    spoke = await self._speak_once()
                    if not spoke:
                        await asyncio.sleep(4.0)  # model hiccup — back off
                        continue
                await asyncio.sleep(0.7)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("booth loop crashed for %s", self.world.world_id)

    async def _speak_once(self) -> bool:
        text = await self.commentator.speak(self.world)
        if not text:
            return False
        self._broadcast({
            "kind": "commentary",
            "world_id": self.world.world_id,
            "tick": self.world.tick,
            "speaker": "prompt-chan",
            "text": text,
        })
        return True

    def start_llm_gather(self) -> None:
        """Kick off the hosted-LLM batch at window open, so model latency
        overlaps the externals' thinking instead of being tacked on after it.

        Safe to start this early: run_world_tick is the sole mutator and is
        synchronous, so the world is byte-identical from one apply phase to
        the next — the gather reads the same state either way. Hosted agents
        perceive through build_observation, which cannot see pending external
        orders, so nothing is lost by not waiting for the mailbox."""
        if self.llm_decide is None or self.world.config.hosted_brain != "llm":
            return
        if self._llm_task is not None and not self._llm_task.done():
            return
        if self.world.phase != WorldPhase.running:
            return
        ids = [
            a.agent_id for a in self.world.living_agents() if a.brain != "external"
        ]
        if not ids:
            return
        self._llm_ids = ids
        self._llm_task = asyncio.create_task(self._collect_llm(ids))

    def _recent_events(self) -> list:
        """The previous tick's events, for the hosted brains' observations.

        Last tick only: hosted agents decide every tick through the gather, so
        unlike a BYO client they never miss a window and have nothing to replay.
        Widening this is not free — per-agent visibility places an event by the
        location trail recorded for its tick, so anything older than
        LOC_TRAIL_TICKS silently drops instead of replaying (see
        MISSED_TICK_LOOKBACK in api/world_routes.py before changing it).

        Called at window open, BEFORE this tick resolves — so what is on disk
        is exactly the previous tick's events."""
        try:
            return sandbox_store.load_events(
                self.data_dir, self.world.world_id, since_tick=self.world.tick
            )
        except OSError:  # reading history must never stop a season
            logger.warning("could not load recent events for %s", self.world.world_id)
            return []

    async def _collect_llm(self, agent_ids: list[str]) -> dict[str, dict]:
        try:
            return await self.llm_decide(self.world, agent_ids, self._recent_events())
        except Exception:
            logger.exception("LLM decision gathering failed; defaults apply")
            return {}

    def _cancel_llm(self) -> None:
        """An orphaned model call would resolve against a paused or deleted
        world, so the clock stopping must take the gather with it."""
        if self._llm_task is not None and not self._llm_task.done():
            self._llm_task.cancel()
        self._llm_task = None
        self._llm_ids = []

    async def _tick_body(self) -> dict:
        """The RESOLVE phase — runs under the lock with tick_in_flight up.

        The turn window has already closed by the time we get here: the
        barrier runs in run_one_tick, before the flag rises."""

        # --- decision gathering (reads only — the mailbox is NOT popped
        # here: the hosted-LLM gather below awaits for real seconds, and
        # an empty mailbox mid-tick made act long-polls report resolution
        # against a world that hadn't moved) ---
        decisions: dict[str, dict | None] = {}
        gathered: dict[str, dict] = {}  # external orders read this tick
        hosted_llm: list[str] = []
        for agent in self.world.living_agents():
            if agent.brain == "external":
                order = self.mailbox.get(agent.agent_id)
                if order is not None:
                    gathered[agent.agent_id] = order
                decisions[agent.agent_id] = order["action"] if order else None
            elif self.world.config.hosted_brain == "llm" and self.llm_decide:
                hosted_llm.append(agent.agent_id)
            else:
                decisions[agent.agent_id] = policy_decide(self.world, agent.agent_id)

        if hosted_llm and self.llm_decide:
            if self._llm_task is not None and self._llm_ids == hosted_llm:
                # Pre-started at window open — normally already resolved, so
                # this costs nothing and the model latency is already spent.
                llm_decisions = await self._llm_task
                self._llm_task = None
                self._llm_ids = []
            else:
                # No overlap available (manual tick, or the roster moved under
                # the pre-start). Inline, exactly as before — tick_in_flight
                # stays up across this await, which is what keeps act
                # long-polls from resolving mid-gather.
                llm_decisions = await self._collect_llm(hosted_llm)
            for aid in hosted_llm:
                decisions[aid] = llm_decisions.get(aid)

        # Attendance for the window that just closed. Submitting resets the
        # count in submit_action; silence accrues toward PRESUMED_ABSENT.
        for agent_id in self.living_externals():
            if agent_id in gathered:
                self.absent_windows.pop(agent_id, None)
            else:
                self.absent_windows[agent_id] = self.absent_windows.get(agent_id, 0) + 1

        # --- apply phase: synchronous, no awaits, sole mutation site ---
        # Atomic pop: remove exactly the orders gathered above. An order
        # re-submitted during the LLM gather is a DIFFERENT object — it
        # survives untouched and cleanly becomes next tick's action.
        for aid, order in gathered.items():
            if self.mailbox.get(aid) is order:
                del self.mailbox[aid]
        events = run_world_tick(self.world, decisions)
        # Consumption ledger: ground truth for "your order N executed on tick
        # T" — stamped post-apply so world.tick is the tick that ran it.
        for aid, order in gathered.items():
            self.consumed[aid] = {"order_id": order["order_id"], "tick": self.world.tick}
        frame = build_tick_frame(self.world, events)
        sandbox_store.save_world(self.data_dir, self.world)
        sandbox_store.append_events(self.data_dir, self.world.world_id, events)
        sandbox_store.append_tick_frame(self.data_dir, self.world.world_id, frame)
        return frame

    # ------------------------------------------------------------------
    # Auto-run
    # ------------------------------------------------------------------

    @property
    def is_auto(self) -> bool:
        return self._auto_task is not None and not self._auto_task.done()

    def start_auto(self, tick_seconds: float | None = None) -> None:
        if self.is_auto:
            return
        pace = tick_seconds or self.world.config.tick_seconds
        self._auto_task = asyncio.create_task(self._auto_loop(pace))

    def stop_auto(self) -> None:
        if self._auto_task is not None and not self._auto_task.done():
            self._auto_task.cancel()
        self._auto_task = None
        self._cancel_llm()

    def shutdown(self) -> None:
        """Full stop for eviction: the clock and the booth both go dark,
        and every spectator parked on the fan-out is woken and released."""
        self.stop_auto()
        if self._booth_task is not None and not self._booth_task.done():
            self._booth_task.cancel()
        self._booth_task = None
        self.close_stream()

    def close_stream(self) -> None:
        """Wake and drop every SSE subscriber. Cancelling the tasks is not
        enough: a spectator generator is parked on ``queue.get()``, which
        nothing else will ever resolve, so it would hold the connection open
        on sse-starlette's pings forever."""
        # Flag before wake: a released waiter must observe the teardown, not
        # race it and answer off a world that no longer exists.
        self.destroyed = True
        self.wake()
        self._ready_event.set()  # release a barrier parked on the window
        for q in list(self.subscribers):
            q.put_nowait({"kind": "world_deleted", "world_id": self.world.world_id})
        self.subscribers.clear()

    async def _sleep_until(self, when: float) -> None:
        delay = when - self._now()
        if delay > 0:
            await asyncio.sleep(delay)

    async def _auto_loop(self, pace: float) -> None:
        """The clock.

        Two pacing regimes, chosen per tick by who is actually playing:

        With external agents the readiness barrier sets the rhythm — the tick
        fires the moment the last living external submits — and min_tick_gap_s
        is only a floor between frames so spectators can follow. There is no
        unconditional sleep. There used to be, and because it was the sole
        window in which observations could be served, it silently defined
        every player's real turn budget as tick_seconds regardless of the
        deadline they were promised.

        With no externals the barrier is trivially satisfied and would free-
        run, so tick_seconds remains the clock exactly as before.

        The gap sleep goes BEFORE the window, not after the tick, so agents
        are served throughout it and their thinking overlaps the floor."""
        try:
            while self.world.phase == WorldPhase.running:
                externals = bool(self.living_externals())
                floor = self.world.config.min_tick_gap_s if externals else pace
                if externals:
                    self.start_llm_gather()
                await self._sleep_until(self._last_tick_at + floor)
                if externals:
                    await self.open_turn_window()
                await self.run_one_tick(wait_for_externals=False)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("auto loop crashed for world %s", self.world.world_id)

    # ------------------------------------------------------------------
    # SSE fan-out
    # ------------------------------------------------------------------

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self.subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        if q in self.subscribers:
            self.subscribers.remove(q)

    def _broadcast(self, frame: dict) -> None:
        # every frame that reaches spectators also feeds the booth's
        # material buffer (commentary payloads carry no events — harmless)
        if self.commentator is not None and frame.get("events"):
            self.commentator.note_frame(frame)
        for q in list(self.subscribers):
            q.put_nowait(frame)

    def broadcast_snapshot(self, events: list) -> None:
        """Push a non-tick frame (lobby join, season start) to spectators.

        Frames normally only flow when a tick lands, which leaves the lobby
        silent — spectators would never see challengers arrive.

        Wake source too, and a load-bearing one: this is the path the host's
        Begin runs through, and an agent long-polling in the lobby releases on
        ``phase == running``. Without the wake it would hang until its window
        ran out instead of getting the season's first turn."""
        self.wake()
        self._broadcast(build_tick_frame(self.world, events))

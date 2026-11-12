"""Races between the BYO act path and the tick's awaited LLM gather.

A real external player hit all of these: with hosted_brain="llm" the tick
awaits the model batch for seconds AFTER reading the mailbox. The old code
popped the mailbox at read time, so act long-polls "resolved" mid-tick
against a world that hadn't moved, and a mid-gather resubmit silently
became next tick's action — replayed stale against the new world state.
Generous sleep margins here: these guard timing behavior, and a flaky
guard is worse than a slow one.
"""

from __future__ import annotations

import asyncio

from quest_sim.api.world_routes import _await_decision_time, _await_order_consumed
from quest_sim.engine.sandbox.build import build_world, create_agent, start_season
from quest_sim.engine.sandbox.runner import PRESUMED_ABSENT, WorldRunner
from quest_sim.models.sandbox import SandboxConfig


def _llm_world(tmp_path, gather_s: float):
    """A running world with one external + hosted LLM brains whose gather
    takes ``gather_s`` of real awaited time (the race window)."""
    config = SandboxConfig(pool_size=3, hosted_brain="llm", action_deadline_s=5.0)
    world = build_world(config, seed=7)
    ext = create_agent(world, name="Sonnet", preset="rogue", brain="external")
    start_season(world)
    runner = WorldRunner(world, tmp_path)

    async def slow_llm(_world, _agent_ids, _events=None):
        await asyncio.sleep(gather_s)
        return {}

    runner.llm_decide = slow_llm
    return world, runner, ext


def test_act_long_poll_never_resolves_mid_gather(tmp_path):
    async def scenario():
        world, runner, ext = _llm_world(tmp_path, gather_s=1.5)
        order = runner.submit_action(ext.agent_id, {"action": "wait"})
        tick = asyncio.create_task(runner.run_one_tick())
        await asyncio.sleep(0.4)  # inside the llm gather
        assert runner.tick_in_flight
        assert ext.agent_id in runner.mailbox  # atomic pop: not popped yet

        # a short-budget wait must EXPIRE mid-tick, not report resolution
        await _await_order_consumed(runner, ext.agent_id, order["order_id"], wait_s=0.5)
        assert world.tick == 0
        assert runner.consumed.get(ext.agent_id) is None

        # once the tick lands, it resolves with ground truth
        await _await_order_consumed(runner, ext.agent_id, order["order_id"], wait_s=10.0)
        assert world.tick == 1
        assert runner.consumed[ext.agent_id] == {"order_id": order["order_id"], "tick": 1}
        await tick

    asyncio.run(scenario())


def test_resubmit_mid_gather_becomes_next_ticks_action(tmp_path):
    async def scenario():
        world, runner, ext = _llm_world(tmp_path, gather_s=1.0)
        first = runner.submit_action(ext.agent_id, {"action": "wait"})
        tick = asyncio.create_task(runner.run_one_tick())
        await asyncio.sleep(0.4)  # mid-gather: the agent re-POSTs
        second = runner.submit_action(
            ext.agent_id, {"action": "wait", "thought": "again"}
        )
        await tick

        # the tick executed FIRST; the resubmit survived, cleanly queued
        assert runner.consumed[ext.agent_id] == {"order_id": first["order_id"], "tick": 1}
        assert runner.mailbox[ext.agent_id] is second

        await runner.run_one_tick(wait_for_externals=False)
        assert runner.consumed[ext.agent_id] == {"order_id": second["order_id"], "tick": 2}
        assert ext.agent_id not in runner.mailbox

    asyncio.run(scenario())


def test_observation_wait_blocks_while_tick_in_flight(tmp_path):
    async def scenario():
        world, runner, ext = _llm_world(tmp_path, gather_s=1.0)
        runner.submit_action(ext.agent_id, {"action": "wait"})
        tick = asyncio.create_task(runner.run_one_tick())
        await asyncio.sleep(0.3)  # mid-gather
        await _await_decision_time(runner, ext.agent_id, wait_s=10.0)
        # returned only after the tick fully applied — never mid-flight
        assert not runner.tick_in_flight
        assert world.tick == 1
        await tick

    asyncio.run(scenario())


def test_policy_worlds_consume_in_one_pass(tmp_path):
    """No gather await, no race window — the pre-existing fast path holds."""

    async def scenario():
        config = SandboxConfig(pool_size=3, hosted_brain="policy")
        world = build_world(config, seed=7)
        ext = create_agent(world, name="Sonnet", preset="rogue", brain="external")
        start_season(world)
        runner = WorldRunner(world, tmp_path)
        order = runner.submit_action(ext.agent_id, {"action": "wait"})
        await runner.run_one_tick()
        assert runner.consumed[ext.agent_id] == {"order_id": order["order_id"], "tick": 1}
        assert not runner.tick_in_flight
        assert ext.agent_id not in runner.mailbox

    asyncio.run(scenario())


def _byo_world(tmp_path, count: int = 2, **config_kw):
    """A running world of ``count`` externals and nothing else to wait on."""
    config = SandboxConfig(pool_size=count, hosted_brain="policy", **config_kw)
    world = build_world(config, seed=7)
    agents = [
        create_agent(world, name=f"Ext{i}", preset="rogue", brain="external")
        for i in range(count)
    ]
    start_season(world)
    return world, WorldRunner(world, tmp_path), agents


def test_tick_fires_as_soon_as_every_external_is_ready(tmp_path):
    """The headline fix.

    The auto loop used to sleep tick_seconds after every tick unconditionally,
    so the per-turn floor was that sleep no matter how fast the table played
    — while the guide promised the tick advanced "the moment every living
    player has submitted". With tick_seconds at 5s, two ticks used to take
    upwards of 10s; now they take about as long as the agents do."""

    async def scenario():
        world, runner, agents = _byo_world(
            tmp_path, count=2, tick_seconds=5.0, min_tick_gap_s=0.05
        )
        runner.start_auto()
        started = asyncio.get_event_loop().time()
        for _ in range(2):
            for agent in agents:
                runner.submit_action(agent.agent_id, {"action": "wait"})
            await asyncio.sleep(0.2)
        runner.stop_auto()

        assert world.tick >= 2
        assert asyncio.get_event_loop().time() - started < 1.0

    asyncio.run(scenario())


def test_world_without_externals_is_still_paced_by_tick_seconds(tmp_path):
    """The barrier is trivially satisfied with nobody to wait for, so the
    externals-free path must keep its old clock or a spectator sim would
    free-run at the frame floor."""

    async def scenario():
        config = SandboxConfig(pool_size=2, hosted_brain="policy", tick_seconds=0.5)
        world = build_world(config, seed=7)
        start_season(world)
        runner = WorldRunner(world, tmp_path)
        runner.start_auto()
        await asyncio.sleep(1.2)
        runner.stop_auto()

        assert 1 <= world.tick <= 3, f"expected tick_seconds pacing, got {world.tick}"

    asyncio.run(scenario())


def test_a_silent_external_only_costs_its_own_turn(tmp_path):
    """One agent's silence must not cost the season more than that agent's
    own deadline, and must not cost the agents who did submit anything."""

    async def scenario():
        world, runner, agents = _byo_world(
            tmp_path, count=2, action_deadline_s=1.0, min_tick_gap_s=0.05
        )
        talker, mute = agents
        runner.submit_action(talker.agent_id, {"action": "wait"})

        started = asyncio.get_event_loop().time()
        frame = await runner.run_one_tick()
        elapsed = asyncio.get_event_loop().time() - started

        assert world.tick == 1
        # held for the mute agent's deadline, and no longer
        assert 0.9 < elapsed < 1.6, elapsed

        timed_out = {
            e["actor"] for e in frame["events"] if e["event_type"] == "action_timeout"
        }
        assert timed_out == {mute.agent_id}, timed_out
        # the agent that did submit had its order executed, not defaulted
        assert runner.consumed[talker.agent_id]["tick"] == 1

    asyncio.run(scenario())


def test_an_abandoned_seat_stops_taxing_the_table(tmp_path):
    """A driver that quit, or never connected at all, used to cost every
    other player the full deadline on every single tick — the 45s seasons
    the UI ships made that a 45s stall per tick, forever.

    It still plays the defensive default and still announces its timeouts.
    It just stops holding the barrier after PRESUMED_ABSENT silent windows,
    and one submission puts it straight back on a full deadline."""

    async def scenario():
        world, runner, agents = _byo_world(
            tmp_path, count=2, action_deadline_s=1.0, min_tick_gap_s=0.0
        )
        talker, ghost = agents

        for _ in range(PRESUMED_ABSENT):
            runner.submit_action(talker.agent_id, {"action": "wait"})
            await runner.run_one_tick()

        # now presumed absent: the window no longer waits on it
        runner.submit_action(talker.agent_id, {"action": "wait"})
        started = asyncio.get_event_loop().time()
        await runner.run_one_tick()
        assert asyncio.get_event_loop().time() - started < 0.3

        # ...but it is still in the season, still timing out loudly
        assert world.get_agent(ghost.agent_id).is_alive
        assert runner.absent_windows[ghost.agent_id] > PRESUMED_ABSENT

        # one submission and it is a full citizen again
        runner.submit_action(ghost.agent_id, {"action": "wait"})
        assert ghost.agent_id not in runner.absent_windows
        runner.submit_action(talker.agent_id, {"action": "wait"})
        await runner.run_one_tick()
        assert runner.consumed[ghost.agent_id]["tick"] == world.tick

    asyncio.run(scenario())


def test_llm_gather_overlaps_the_turn_window(tmp_path):
    """Hosted model latency used to be serialised AFTER the barrier and
    inside tick_in_flight, so in a mixed world every BYO agent paid for the
    NPCs' thinking on its own critical path. Started at window open, the two
    latencies now run concurrently."""

    async def scenario():
        config = SandboxConfig(
            pool_size=3, hosted_brain="llm", action_deadline_s=5.0, min_tick_gap_s=0.05
        )
        world = build_world(config, seed=7)
        ext = create_agent(world, name="Sonnet", preset="rogue", brain="external")
        start_season(world)
        runner = WorldRunner(world, tmp_path)

        async def slow_llm(_world, _agent_ids, _events=None):
            await asyncio.sleep(1.0)
            return {}

        runner.llm_decide = slow_llm

        async def submit_late():
            await asyncio.sleep(0.6)
            runner.submit_action(ext.agent_id, {"action": "wait"})

        started = asyncio.get_event_loop().time()
        await asyncio.gather(runner.run_one_tick(), submit_late())
        elapsed = asyncio.get_event_loop().time() - started

        assert world.tick == 1
        # overlapped: ~max(1.0, 0.6). Serialised it would be ~1.6s.
        assert elapsed < 1.4, f"gather did not overlap the window: {elapsed:.2f}s"

    asyncio.run(scenario())


def test_shutdown_wakes_a_parked_barrier(tmp_path):
    """Eviction mid-window must not leave the barrier holding for its full
    deadline against a world that no longer exists."""

    async def scenario():
        world, runner, agents = _byo_world(tmp_path, count=2, action_deadline_s=30.0)
        tick = asyncio.create_task(runner.run_one_tick())
        await asyncio.sleep(0.1)  # parked on the barrier, nobody has submitted

        started = asyncio.get_event_loop().time()
        runner.shutdown()
        await tick
        assert asyncio.get_event_loop().time() - started < 0.5

    asyncio.run(scenario())


def test_long_poll_wakes_within_ms_of_the_tick(tmp_path):
    """The wake is an edge, not a poll.

    The old helpers slept 250ms between predicate checks, so every turn paid
    up to half a second of dead time on the two long-polls alone. Proves the
    event path: a parked observation must release on the tick's wake, not on
    the next poll that happens to notice."""

    async def scenario():
        config = SandboxConfig(pool_size=3, hosted_brain="policy")
        world = build_world(config, seed=7)
        ext = create_agent(world, name="Sonnet", preset="rogue", brain="external")
        start_season(world)
        runner = WorldRunner(world, tmp_path)
        runner.submit_action(ext.agent_id, {"action": "wait"})

        waiter = asyncio.create_task(
            _await_decision_time(runner, ext.agent_id, wait_s=10.0)
        )
        await asyncio.sleep(0.05)  # let it park on the mailbox predicate
        assert not waiter.done()

        landed = asyncio.get_event_loop().time()
        await runner.run_one_tick(wait_for_externals=False)
        await waiter
        assert asyncio.get_event_loop().time() - landed < 0.1
        assert world.tick == 1

    asyncio.run(scenario())


def test_lobby_long_poll_wakes_on_season_start(tmp_path):
    """Wake-source completeness guard.

    An agent long-polling in the lobby releases on ``phase == running``, and
    the host's Begin reaches the runner only through broadcast_snapshot. Miss
    that wake source and every player joins the season one full window late."""

    async def scenario():
        config = SandboxConfig(pool_size=3, hosted_brain="policy")
        world = build_world(config, seed=7)
        ext = create_agent(world, name="Sonnet", preset="rogue", brain="external")
        runner = WorldRunner(world, tmp_path)  # still in the lobby

        waiter = asyncio.create_task(
            _await_decision_time(runner, ext.agent_id, wait_s=10.0)
        )
        await asyncio.sleep(0.05)
        assert not waiter.done()  # the lobby holds it

        began = asyncio.get_event_loop().time()
        start_season(world)
        runner.broadcast_snapshot([])
        await waiter
        assert asyncio.get_event_loop().time() - began < 0.1

    asyncio.run(scenario())


def test_shutdown_wakes_spectators_and_long_polls(tmp_path):
    """Eviction must release everyone parked on this runner.

    shutdown() used to cancel the clock and the booth and stop there, which
    left a spectator generator blocked on queue.get() forever (sse-starlette
    keeps pinging, so the socket never closes) and left long-polls spinning
    their full window against a world that no longer exists."""

    async def scenario():
        config = SandboxConfig(pool_size=3, hosted_brain="policy")
        world = build_world(config, seed=7)
        ext = create_agent(world, name="Sonnet", preset="rogue", brain="external")
        start_season(world)
        runner = WorldRunner(world, tmp_path)
        queue = runner.subscribe()

        runner.shutdown()

        assert runner.destroyed
        assert runner.subscribers == []
        payload = queue.get_nowait()
        assert payload["kind"] == "world_deleted"
        assert payload["world_id"] == world.world_id

        # both long-polls bail immediately rather than burning their window
        started = asyncio.get_event_loop().time()
        await _await_decision_time(runner, ext.agent_id, wait_s=10.0)
        await _await_order_consumed(runner, ext.agent_id, order_id=1, wait_s=10.0)
        assert asyncio.get_event_loop().time() - started < 0.5

    asyncio.run(scenario())


def test_the_gather_is_handed_the_previous_tick_events(tmp_path):
    """The hosted half of the roster used to get last_tick_events == [] forever,
    because gather_llm_decisions built observations with no events at all. The
    runner owns the data dir, so it is the one that must supply them.

    Ordering is the subtle part: run_world_tick increments world.tick on ENTRY,
    so at window open world.tick still names the tick that just finished — which
    is exactly the window we want to replay."""
    seen: list[list] = []

    async def scenario():
        config = SandboxConfig(pool_size=3, hosted_brain="llm", action_deadline_s=0.1)
        world = build_world(config, seed=7)
        start_season(world)
        runner = WorldRunner(world, tmp_path)

        async def capture(_world, _agent_ids, events=None):
            seen.append(list(events or []))
            return {}

        runner.llm_decide = capture
        await runner.run_one_tick()  # tick 1 — nothing before it
        await runner.run_one_tick()  # tick 2 — must see tick 1's events
        return world

    world = asyncio.run(scenario())

    assert len(seen) == 2
    assert seen[1], "the gather saw no events from the tick that just resolved"
    assert {e.tick for e in seen[1]} == {1}
    assert world.tick == 2

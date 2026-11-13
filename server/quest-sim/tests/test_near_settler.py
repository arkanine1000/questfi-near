"""On-chain settlement: the settler's queue and the game's lifecycle hooks.

Everything runs against FakeNearClient, an in-memory contract that records
every call and applies the same seq rules as the real one. End-to-end
seasons use the zero-LLM policy brain, so they are deterministic per seed:
seed 29 (pool 4) has one rival kill, monster kills and a boss slain; seed
23 ends on the boss crown.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from quest_sim import near
from quest_sim.config import Settings
from quest_sim.engine.sandbox.build import HOSTED_ROSTER, build_world, create_agent
from quest_sim.models.sandbox import SandboxConfig, WorldPhase
from quest_sim.near import bridge
from quest_sim.near.client import ContractError, FakeNearClient, TransportError
from quest_sim.near.settler import Settler
from tests.conftest import ADMIN_KEY

HOUSE_PASSES = {name: str(i + 1) for i, (name, *_rest) in enumerate(HOSTED_ROSTER)}


def _settler(tmp_path: Path, fake: FakeNearClient, **kw) -> Settler:
    passes = tmp_path / "near_passes.json"
    if not passes.exists():
        passes.write_text(json.dumps(HOUSE_PASSES))
    return Settler(
        fake,
        contract_id="questfi.test",
        state_dir=tmp_path / "near",
        entry_stake_yocto=10**23,
        lock_tick=kw.pop("lock_tick", 5),
        passes_file=passes,
        backoff_base_s=0.01,
        backoff_max_s=0.02,
        **kw,
    )


def _started(settler: Settler, season: str, passes=("1", "2")) -> None:
    settler.create_season(season)
    for p in passes:
        settler.enter_season(season, p)
    settler.start_season(season)


def _kill(killer, victim):
    return {"kind": "kill", "killer": killer, "victim": victim}


# ---------------------------------------------------------------------------
# The settler on its own
# ---------------------------------------------------------------------------


async def test_batches_carry_consecutive_seq_and_a_retry_reuses_its_seq(tmp_path):
    fake = FakeNearClient()
    settler = _settler(tmp_path, fake)
    _started(settler, "w-a")
    assert await settler.drain()

    fake.fail_next("report_events", TransportError("timed out"))
    for victim in ("1", "2"):
        settler.report_events("w-a", [_kill(None, victim)])
        assert await settler.drain()
    settler.report_events("w-a", [_kill(None, "1")])  # already dead: skipped on chain
    assert await settler.drain()

    attempts = [c for c in fake.calls if c.method == "report_events"]
    assert [c.args["seq"] for c in attempts] == [0, 0, 1, 2]
    assert attempts[0].outcome == "TransportError"
    assert attempts[0].args == attempts[1].args  # same seq, same events
    assert fake.seasons["w-a"]["next_seq"] == 3


async def test_a_lagging_chain_merges_batches_into_one_transaction(tmp_path):
    fake = FakeNearClient(hang=True)
    settler = _settler(tmp_path, fake)
    _started(settler, "w-a", passes=("1", "2", "3"))
    for victim in ("1", "2", "3"):
        settler.report_events("w-a", [_kill("3" if victim != "3" else None, victim)])
    await asyncio.sleep(0.05)
    assert settler.queue_depth("w-a") == 8  # the game kept going; nothing sent
    fake.release()
    assert await settler.drain()
    reports = fake.applied("report_events")
    assert len(reports) == 1
    assert reports[0].args["seq"] == 0
    assert [e["victim"] for e in reports[0].args["events"]] == ["1", "2", "3"]


async def test_a_rejected_batch_is_dropped_and_its_seq_reused(tmp_path):
    fake = FakeNearClient()
    settler = _settler(tmp_path, fake)
    _started(settler, "w-a")
    assert await settler.drain()
    fake.fail_next("report_events", ContractError("bad event"), times=3)
    settler.report_events("w-a", [_kill(None, "1")])
    assert await settler.drain()
    settler.report_events("w-a", [_kill(None, "2")])
    assert await settler.drain()
    applied = fake.applied("report_events")
    assert [c.args["seq"] for c in applied] == [0]
    assert applied[0].args["events"] == [_kill(None, "2")]
    assert settler.status("w-a")["failed_calls"] == 1


async def test_the_status_block_says_when_betting_locks(tmp_path):
    fake = FakeNearClient()
    by_tick = _settler(tmp_path, fake, lock_tick=5)
    _started(by_tick, "w-a")
    assert by_tick.status("w-a")["lock_tick"] == 5
    # a lock tick of 0 means only the season's end locks the market
    other = tmp_path / "other"
    other.mkdir()
    at_the_end = _settler(other, fake, lock_tick=0)
    _started(at_the_end, "w-b")
    assert at_the_end.status("w-b")["lock_tick"] is None


async def test_a_settle_that_landed_but_timed_out_is_not_sent_twice(tmp_path):
    fake = FakeNearClient()
    settler = _settler(tmp_path, fake)
    _started(settler, "w-a")
    fake.fail_next("settle_season", TransportError("timed out"), after_apply=True)
    settler.settle_season("w-a", "1")
    assert await settler.drain()
    assert fake.seasons["w-a"]["status"] == "Settled"
    assert fake.seasons["w-a"]["winner"] == "1"
    settles = [c for c in fake.calls if c.method == "settle_season"]
    assert [c.outcome for c in settles] == ["TransportError", "ContractError"]
    assert settler.status("w-a")["season_status"] == "Settled"
    assert settler.status("w-a")["failed_calls"] == 0


async def test_events_for_passes_not_in_the_season_are_filtered(tmp_path):
    fake = FakeNearClient()
    settler = _settler(tmp_path, fake)
    _started(settler, "w-a")
    settler.report_events("w-a", [
        _kill("9", "1"),  # killer never entered: reported as a monster kill
        _kill("1", "9"),  # victim never entered: dropped
        {"kind": "loot", "pass": "9", "xp": 80, "text": "x"},  # dropped
        {"kind": "loot", "pass": "2", "xp": 80, "text": "Cleared The Crypt"},
    ])
    settler.settle_season("w-a", "9")  # not an entrant: no winner
    assert await settler.drain()
    (report,) = fake.applied("report_events")
    assert report.args["events"] == [
        _kill(None, "1"), {"kind": "loot", "pass": "2", "xp": 80, "text": "Cleared The Crypt"},
    ]
    (settle,) = fake.applied("settle_season")
    assert settle.args["winner_pass"] is None


async def test_queued_calls_survive_a_restart_with_the_same_seq(tmp_path):
    fake = FakeNearClient()
    first = _settler(tmp_path, fake)
    _started(first, "w-a")
    assert await first.drain()
    fake.outage = True
    first.report_events("w-a", [_kill("2", "1")])
    first.settle_season("w-a", "2")
    await asyncio.sleep(0.05)
    sent_before = [c.args for c in fake.calls if c.method == "report_events"]
    await first.stop()

    fake.outage = False
    second = _settler(tmp_path, fake)
    assert second.queue_depth("w-a") == 2
    await second.start()
    assert await second.drain()
    (report,) = fake.applied("report_events")
    assert report.args == sent_before[0]  # sealed before the restart, resent as is
    assert fake.applied("settle_season")[0].args["winner_pass"] == "2"
    assert second.status("w-a")["season_status"] == "Settled"


async def test_a_contract_that_demands_one_yocto_gets_it(tmp_path):
    fake = FakeNearClient()
    settler = _settler(tmp_path, fake)
    _started(settler, "w-a")
    fake.fail_next("settle_season", ContractError(
        "Smart contract panicked: Requires attached deposit of exactly 1 yoctoNEAR"
    ))
    settler.settle_season("w-a", "1")
    assert await settler.drain()
    settles = [c for c in fake.calls if c.method == "settle_season"]
    assert [(c.deposit_yocto, c.outcome) for c in settles] == [(0, "ContractError"), (1, "ok")]
    assert settler.status("w-a")["failed_calls"] == 0


async def test_a_failed_settle_falls_back_to_cancel(tmp_path):
    fake = FakeNearClient()
    settler = _settler(tmp_path, fake)
    _started(settler, "w-a")
    fake.fail_next("settle_season", ContractError("nope"), times=3)
    settler.settle_season("w-a", "1")
    assert await settler.drain()
    assert fake.seasons["w-a"]["status"] == "Cancelled"


async def test_a_house_pass_in_an_unsettled_season_is_not_reused(tmp_path):
    fake = FakeNearClient()
    settler = _settler(tmp_path, fake)
    _started(settler, "w-a", passes=("1",))
    assert settler.pass_busy("1", except_season="w-b")
    settler.settle_season("w-a", "1")
    assert not settler.pass_busy("1", except_season="w-b")


# ---------------------------------------------------------------------------
# House passes that have run dry
# ---------------------------------------------------------------------------

STAKE = 10**23  # what _settler sets
TOPUP = 20 * STAKE


def _entries(fake: FakeNearClient, season: str) -> list[str]:
    return sorted(fake.seasons[season]["entrants"])


async def test_a_house_pass_that_cannot_pay_the_stake_is_topped_up_first(tmp_path):
    fake = FakeNearClient(balances={"1": 0, "2": STAKE})
    settler = _settler(tmp_path, fake, house_topup_yocto=TOPUP)
    _started(settler, "w-a")
    assert await settler.drain()
    # only the pass that could not pay was given anything
    assert [(c.args, c.deposit_yocto) for c in fake.applied("deposit")] == [({"pass_id": "1"}, TOPUP)]
    assert _entries(fake, "w-a") == ["1", "2"]
    assert fake.balances == {"1": TOPUP - STAKE, "2": 0}
    order = [(c.method, c.args.get("pass_id")) for c in fake.calls]
    assert order.index(("deposit", "1")) < order.index(("enter_season", "1"))
    assert settler.status("w-a")["failed_calls"] == 0
    assert fake.seasons["w-a"]["status"] == "Running"


async def test_without_a_top_up_a_house_pass_that_cannot_pay_stays_out(tmp_path):
    fake = FakeNearClient(balances={"1": 0})
    settler = _settler(tmp_path, fake)
    _started(settler, "w-a")
    assert await settler.drain()
    assert fake.applied("deposit") == []
    assert _entries(fake, "w-a") == ["2"]


async def test_a_top_up_leaves_the_operator_account_its_reserve(tmp_path):
    reserve = 10**24
    fake = FakeNearClient(balances={"1": 0}, operator_balance=reserve + TOPUP - 1)
    settler = _settler(tmp_path, fake, house_topup_yocto=TOPUP, operator_reserve_yocto=reserve)
    _started(settler, "w-a")
    assert await settler.drain()
    assert [c for c in fake.calls if c.method == "deposit"] == []
    assert fake.operator_balance == reserve + TOPUP - 1
    assert _entries(fake, "w-a") == ["2"]  # the season still runs, without that pass
    assert fake.seasons["w-a"]["status"] == "Running"

    fake.operator_balance = reserve + TOPUP  # exactly enough
    _started(settler, "w-b", passes=("1",))
    assert await settler.drain()
    assert _entries(fake, "w-b") == ["1"]
    assert fake.operator_balance == reserve


async def test_a_top_up_that_landed_but_timed_out_is_not_sent_twice(tmp_path):
    fake = FakeNearClient(balances={"1": 0})
    settler = _settler(tmp_path, fake, house_topup_yocto=TOPUP)
    fake.fail_next("deposit", TransportError("timed out"), after_apply=True)
    _started(settler, "w-a")
    assert await settler.drain()
    assert [c.outcome for c in fake.calls if c.method == "deposit"] == ["TransportError"]
    assert fake.balances["1"] == TOPUP - STAKE
    assert _entries(fake, "w-a") == ["1", "2"]


async def test_a_top_up_waits_out_a_chain_outage_and_keeps_its_place(tmp_path):
    fake = FakeNearClient(balances={"1": 0}, outage=True)
    settler = _settler(tmp_path, fake, house_topup_yocto=TOPUP)
    _started(settler, "w-a", passes=("1",))
    await asyncio.sleep(0.05)
    assert fake.applied() == []
    fake.outage = False
    assert await settler.drain()
    assert [c.method for c in fake.applied()] == [
        "create_season", "deposit", "enter_season", "start_season",
    ]


def test_the_top_up_is_set_in_stakes_and_the_reserve_in_yocto(tmp_path):
    from tests.test_near_client import _test_secret

    settler = near.build_settler(
        _settings(tmp_path, near_operator_key=_test_secret(), near_house_topup_stakes=7)
    )
    assert settler.house_topup_yocto == 7 * 10**23
    assert settler.operator_reserve_yocto == 2 * 10**24
    assert Settings(_env_file=None).near_house_topup_stakes == 20


# ---------------------------------------------------------------------------
# Game events to contract events
# ---------------------------------------------------------------------------


def _lobby_world(n=3):
    world = build_world(SandboxConfig(pool_size=n), seed=3)
    agents = [create_agent(world, name=f"P{i}", brain="hosted") for i in range(n)]
    return world, agents


def _death(victim, killer):
    return {"event_type": "agent_death", "data": {"agent": victim, "killer": killer}}


def test_a_kill_becomes_one_kill_event_with_both_pass_ids():
    world, (a, b, c) = _lobby_world()
    a.pass_id, b.pass_id = "11", "12"
    out = bridge.season_events(world, [_death(b.agent_id, a.agent_id)])
    assert out == [{"kind": "kill", "killer": "11", "victim": "12"}]


def test_a_monster_or_passless_killer_is_reported_as_null():
    world, (a, b, c) = _lobby_world()
    a.pass_id, b.pass_id = "11", "12"  # c plays without a pass
    mob = "site-1.skeleton"
    out = bridge.season_events(world, [
        _death(a.agent_id, mob),
        _death(b.agent_id, c.agent_id),
        _death(c.agent_id, a.agent_id),  # a passless victim: left out
        _death(b.agent_id, None),  # a trap
    ])
    assert out == [_kill(None, "11"), _kill(None, "12"), _kill(None, "12")]


def test_a_slain_dungeon_boss_is_loot_for_its_slayer():
    world, (a, b, c) = _lobby_world()
    a.pass_id = "11"
    site = next(s for s in world.sites.values() if s.boss_id)
    ev = {"event_type": "death", "actor": a.agent_id, "location": f"{site.site_id}:0,0",
          "data": {"character_id": site.boss_id}}
    minion = {**ev, "data": {"character_id": "someone-else"}}
    out = bridge.season_events(world, [minion, ev])
    assert out == [{"kind": "loot", "pass": "11", "xp": bridge.LOOT_XP,
                    "text": f"Cleared {site.name}"[:80]}]


def test_the_winner_pass_is_sent_even_if_the_winner_died():
    world, (a, b, c) = _lobby_world()
    a.pass_id = "11"
    a.character.hp = 0  # crowned by the boss, killed later the same tick
    world.winner, world.win_reason = a.agent_id, "boss"
    assert bridge.winner_pass(world) == "11"
    world.winner = c.agent_id
    assert bridge.winner_pass(world) is None


# ---------------------------------------------------------------------------
# End to end through the API
# ---------------------------------------------------------------------------


def _settings(tmp_path: Path, **kw) -> Settings:
    base = dict(
        _env_file=None,
        data_dir=tmp_path / "games",
        sandbox_data_dir=tmp_path / "worlds",
        sandbox_pool_size=4,
        sandbox_hosted_brain="policy",
        admin_key=ADMIN_KEY,
        sandbox_host_key_enforced=True,
        near_enabled=True,
        near_contract_id="questfi.test",
        near_operator_id="operator.test",
        near_entry_stake=10**23,
        near_lock_tick=5,
        near_state_dir=tmp_path / "near",
    )
    base.update(kw)
    return Settings(**base)


@pytest.fixture
def chain_api(tmp_path: Path):
    """The API with settlement ON, backed by a fake contract."""
    from quest_sim.api import world_routes
    from quest_sim.main import create_app

    fake = FakeNearClient()
    settler = _settler(tmp_path, fake)
    near.install_settler(settler)
    settings = _settings(tmp_path)
    original = world_routes._get_settings
    world_routes._get_settings = lambda: settings
    world_routes._runners.clear()
    with TestClient(create_app(), headers={"X-Host-Key": ADMIN_KEY}) as client:
        client.drain = lambda: client.portal.call(settler.drain, 10.0)
        yield client, settler, fake
        client.portal.call(settler.stop)  # the worker lives on the app's loop
    world_routes._get_settings = original
    world_routes._runners.clear()
    near.install_settler(None)


def _play_out(client, wid, budget=400) -> list[float]:
    """Step the season to its end; returns each tick's wall time."""
    times = []
    for _ in range(budget):
        t0 = time.perf_counter()
        r = client.post(f"/world/{wid}/tick", params={"wait_s": 0})
        times.append(time.perf_counter() - t0)
        assert r.status_code == 200, r.text
        if r.json()["phase"] == "finished":
            return times
    raise AssertionError("season did not finish")


def _new_started_world(client, seed=29):
    wid = client.post("/world/new", json={"seed": seed, "pool_size": 4}).json()["world_id"]
    r = client.post(f"/world/{wid}/start")
    assert r.status_code == 200, r.text
    return wid, r.json()


def test_a_finished_season_settles_exactly_once_after_its_events(chain_api):
    client, settler, fake = chain_api
    wid, started = _new_started_world(client, seed=29)
    pass_of = {a["agent_id"]: a.get("pass_id") for a in started["roster"]}
    assert all(pass_of.values()), "every hosted agent takes its house pass"

    _play_out(client, wid)
    assert client.drain()
    state = client.get(f"/world/{wid}/state").json()

    methods = [c.method for c in fake.applied()]
    assert methods[0] == "create_season"
    assert methods[1:5] == ["enter_season"] * 4
    assert methods[5] == "start_season"
    assert methods.count("settle_season") == 1
    assert methods[-1] == "settle_season"
    assert methods.count("lock_market") == 1
    assert fake.calls[0].args == {"season_id": wid, "entry_stake": str(10**23)}

    reports = fake.applied("report_events")
    assert [c.args["seq"] for c in reports] == list(range(len(reports)))
    events = [e for c in reports for e in c.args["events"]]
    kills = [e for e in events if e["kind"] == "kill"]
    assert len(kills) == 3  # every agent death but the winner's
    rival = [e for e in kills if e["killer"] is not None]
    monster = [e for e in kills if e["killer"] is None]
    assert len(rival) == 1 and len(monster) == 2
    events_log = client.get(f"/world/{wid}/events").json()["events"]
    (pvp,) = [e for e in events_log if e["event_type"] == "agent_death"
              and e["data"]["killer"] in pass_of]
    assert rival[0] == {"kind": "kill", "killer": pass_of[pvp["data"]["killer"]],
                        "victim": pass_of[pvp["data"]["agent"]]}
    assert any(e["kind"] == "loot" for e in events)

    (settle,) = fake.applied("settle_season")
    assert settle.args == {"season_id": wid, "winner_pass": pass_of[state["winner"]]}
    assert fake.seasons[wid]["status"] == "Settled"

    near_block = state["near"]
    assert near_block["enabled"] is True and near_block["contract_id"] == "questfi.test"
    assert near_block["season_status"] == "Settled"
    assert near_block["lock_tick"] == 5
    assert near_block["queue_depth"] == 0
    assert near_block["recent_txs"][0]["method"] == "settle_season"
    assert all(a["pass_id"] for a in state["roster"])

    # the stream carries the passes too, frame by frame
    frames = client.get(f"/world/{wid}/stream").text
    assert '"pass_id": "' in frames


def test_the_boss_crown_settles_to_the_crowned_pass(chain_api):
    client, settler, fake = chain_api
    wid, started = _new_started_world(client, seed=23)
    pass_of = {a["agent_id"]: a["pass_id"] for a in started["roster"]}
    _play_out(client, wid)
    assert client.drain()
    state = client.get(f"/world/{wid}/state").json()
    assert state["win_reason"] == "boss"
    (settle,) = fake.applied("settle_season")
    assert settle.args["winner_pass"] == pass_of[state["winner"]]


def test_deleting_or_sweeping_an_unfinished_world_cancels_its_season(chain_api):
    from quest_sim.api import world_routes

    client, settler, fake = chain_api
    running, _ = _new_started_world(client, seed=7)
    client.post(f"/world/{running}/tick", params={"wait_s": 0})
    assert client.delete(f"/world/{running}").status_code == 200

    lobby = client.post("/world/new", json={"seed": 8}).json()["world_id"]
    world_json = world_routes._data_dir() / lobby / "world.json"
    old = time.time() - 13 * 3600  # past the 12h lobby TTL
    os.utime(world_json, (old, old))
    assert lobby in client.portal.call(_sweep)
    assert client.drain()

    cancels = [c.args["season_id"] for c in fake.applied("cancel_season")]
    assert sorted(cancels) == sorted([running, lobby])
    assert fake.seasons[running]["status"] == "Cancelled"
    assert not fake.applied("settle_season")


async def _sweep():
    from quest_sim.api import world_routes

    return world_routes.sweep_stale_worlds()


def test_deleting_a_settled_world_cancels_nothing(chain_api):
    client, settler, fake = chain_api
    wid, _ = _new_started_world(client, seed=7)
    _play_out(client, wid)
    assert client.delete(f"/world/{wid}").status_code == 200
    assert client.drain()
    assert not fake.applied("cancel_season")
    assert len(fake.applied("settle_season")) == 1


def test_a_join_needs_the_pass_entered_on_chain(chain_api):
    client, settler, fake = chain_api
    wid = client.post("/world/new", json={"seed": 7}).json()["world_id"]
    assert client.drain()

    r = client.post(f"/world/{wid}/join", json={"name": "Pilot", "pass_id": "77"})
    assert r.status_code == 403
    assert "has not entered season" in r.json()["detail"]
    assert "enter_season" in r.json()["detail"]

    fake.add_entrant(wid, "77", "Pilot")
    r = client.post(f"/world/{wid}/join", json={"name": "Pilot", "pass_id": "77"})
    assert r.status_code == 200, r.text
    assert r.json()["pass_id"] == "77"

    again = client.post(f"/world/{wid}/join", json={"name": "Copycat", "pass_id": "77"})
    assert again.status_code == 409

    # a player without a pass may still play; it just stays off chain
    assert client.post(f"/world/{wid}/join", json={"name": "Tourist"}).status_code == 200

    fake.outage = True
    r = client.post(f"/world/{wid}/join", json={"name": "Late", "pass_id": "78"})
    assert r.status_code == 503
    fake.outage = False

    started = client.post(f"/world/{wid}/start").json()
    roster = {a["name"]: a for a in started["roster"]}
    assert roster["Pilot"]["pass_id"] == "77"
    assert "pass_id" not in roster["Tourist"]
    assert client.drain()
    entered = [c.args["pass_id"] for c in fake.applied("enter_season")]
    assert "77" not in entered  # the player entered itself; the server enters only its own
    assert len(entered) == 2  # the two hosted seats


def test_a_chain_outage_neither_slows_nor_breaks_ticks(chain_api):
    client, settler, fake = chain_api
    fake.hang = True  # every call blocks until released
    wid, _ = _new_started_world(client, seed=29)
    times = _play_out(client, wid)
    assert max(times) < 0.5, f"slowest tick took {max(times):.3f}s"
    near_block = client.get(f"/world/{wid}/state").json()["near"]
    assert near_block["queue_depth"] > 5
    assert not fake.applied()

    fake.hang = False
    fake.outage = True
    fake.release()
    time.sleep(0.1)
    near_block = client.get(f"/world/{wid}/state").json()["near"]
    assert near_block["chain_error"] and "TransportError" in near_block["chain_error"]["message"]
    assert near_block["last_error"]

    fake.outage = False
    assert client.drain()
    assert len(fake.applied("settle_season")) == 1
    assert fake.seasons[wid]["status"] == "Settled"
    assert client.get(f"/world/{wid}/state").json()["near"]["chain_error"] is None


def test_mcp_join_season_carries_the_pass(chain_api):
    from fastmcp import Client

    from quest_sim.api.mcp_server import _sessions, mcp

    client, settler, fake = chain_api
    wid = client.post("/world/new", json={"seed": 7}).json()["world_id"]
    fake.add_entrant(wid, "42")

    async def join():
        async with Client(mcp) as mcp_client:
            return (await mcp_client.call_tool(
                "join_season", {"world_id": wid, "name": "Claw", "pass_id": "42"}
            )).data

    try:
        joined = client.portal.call(join)
    finally:
        _sessions.clear()
    assert joined["pass_id"] == "42"
    roster = client.get(f"/world/{wid}/state").json()["roster"]
    assert [a["pass_id"] for a in roster if a["name"] == "Claw"] == ["42"]


# ---------------------------------------------------------------------------
# Off means off
# ---------------------------------------------------------------------------


def test_nothing_is_sent_when_settlement_is_off(tmp_path):
    from quest_sim.api import world_routes
    from quest_sim.main import create_app

    fake = FakeNearClient()
    near.install_settler(_settler(tmp_path, fake))  # present, but must stay unused
    settings = _settings(tmp_path, near_enabled=False)
    original = world_routes._get_settings
    world_routes._get_settings = lambda: settings
    world_routes._runners.clear()
    try:
        with TestClient(create_app(), headers={"X-Host-Key": ADMIN_KEY}) as client:
            wid = client.post("/world/new", json={"seed": 29, "pool_size": 4}).json()["world_id"]
            r = client.post(f"/world/{wid}/join", json={"name": "Pilot", "pass_id": "77"})
            assert r.status_code == 200  # no chain to check against
            client.post(f"/world/{wid}/start")
            _play_out(client, wid)
            state = client.get(f"/world/{wid}/state").json()
            other = client.post("/world/new", json={"seed": 8}).json()["world_id"]
            client.delete(f"/world/{other}")
    finally:
        world_routes._get_settings = original
        world_routes._runners.clear()
        near.install_settler(None)
    assert fake.calls == [] and fake.views == []
    assert state["near"] == {"enabled": False}
    assert [a.get("pass_id") for a in state["roster"] if a["brain"] != "external"] == [None] * 3
    assert not (tmp_path / "near").exists()


def test_boot_refuses_a_half_configured_operator(tmp_path, monkeypatch):
    import quest_sim.main as main_mod

    secret = "ed25519:" + "1" * 10
    monkeypatch.setattr(
        main_mod, "get_settings",
        lambda: _settings(tmp_path, near_contract_id=None, near_operator_key=secret),
    )
    with pytest.raises(RuntimeError) as info:
        main_mod.create_app()
    message = str(info.value)
    assert "QUEST_SIM_NEAR_CONTRACT_ID" in message
    assert "QUEST_SIM_NEAR_OPERATOR_KEY is not usable" in message
    assert secret not in message


def test_old_world_files_without_pass_ids_still_load(tmp_path):
    from quest_sim.persistence import sandbox_store

    world, _ = _lobby_world()
    sandbox_store.save_world(tmp_path, world)
    path = tmp_path / world.world_id / "world.json"
    raw = json.loads(path.read_text())
    for agent in raw["agents"].values():
        agent.pop("pass_id")
    path.write_text(json.dumps(raw))
    loaded = sandbox_store.load_world(tmp_path, world.world_id)
    assert loaded is not None
    assert all(a.pass_id is None for a in loaded.agents.values())
    assert loaded.phase == WorldPhase.lobby

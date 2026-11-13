"""The arena: seasons that run themselves, against the in-memory contract.

Each test boots the real app (lifespan included) with a fake-backed settler
and arena installed, so the arena's background loop runs exactly as in
production, only with short timings.
"""

from __future__ import annotations

import hashlib
import json
import time
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from quest_sim import near
from quest_sim.config import Settings
from quest_sim.engine.sandbox.build import HOSTED_ROSTER
from quest_sim.near.arena import Arena, install_arena
from quest_sim.near.client import FakeNearClient
from quest_sim.near.settler import Settler
from quest_sim.near.tx import KeyPair, b58encode

HOUSE_PASSES = {name: str(i + 1) for i, (name, *_rest) in enumerate(HOSTED_ROSTER)}


def _test_key() -> str:
    seed = hashlib.sha256(b"questfi-settler-test-vector").digest()
    pub = KeyPair.from_secret("ed25519:" + b58encode(seed)).public_key
    return "ed25519:" + b58encode(seed + pub)


def _settings(tmp_path: Path, **kw) -> Settings:
    base = dict(
        _env_file=None,
        data_dir=tmp_path / "games",
        sandbox_data_dir=tmp_path / "worlds",
        sandbox_hosted_brain="policy",
        near_enabled=True,
        near_arena_enabled=True,
        near_contract_id="questfi.testnet",
        near_operator_id="operator.testnet",
        near_operator_key=_test_key(),
        near_entry_stake=10**23,
        near_passes_file=tmp_path / "near_passes.json",
        near_state_dir=tmp_path / "near",
    )
    base.update(kw)
    return Settings(**base)


@contextmanager
def arena_app(tmp_path, monkeypatch, *, fake=None, arena_on=True, **arena_kw):
    """Boot the app with the arena on a fake chain. Yields
    (client, arena, settler, fake)."""
    import quest_sim.main as main_mod
    from quest_sim.api import world_routes

    (tmp_path / "near_passes.json").write_text(json.dumps(HOUSE_PASSES))
    fake = fake or FakeNearClient()
    settings = _settings(tmp_path, near_arena_enabled=arena_on)
    settler = Settler(
        fake, contract_id="questfi.testnet", state_dir=tmp_path / "near",
        entry_stake_yocto=10**23, lock_tick=10,
        passes_file=tmp_path / "near_passes.json",
        backoff_base_s=0.01, backoff_max_s=0.02,
    )
    options = dict(
        pool_size=4, tick_seconds=0.02, max_ticks=40, countdown_s=60.0,
        house_gap_s=0.0, lock_ticks=3, poll_s=0.02, seed_fn=lambda: 29,
    )
    options.update(arena_kw)
    arena = Arena(settler, **options)
    near.install_settler(settler)
    install_arena(arena if arena_on else None)
    monkeypatch.setattr(world_routes, "_get_settings", lambda: settings)
    monkeypatch.setattr(main_mod, "get_settings", lambda: settings)
    world_routes._runners.clear()
    try:
        with TestClient(main_mod.create_app()) as client:
            yield client, arena, settler, fake
    finally:
        world_routes._runners.clear()
        near.install_settler(None)
        install_arena(None)


def wait_for(predicate, timeout=10.0, what="condition"):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {what}")


def arena_state(client) -> dict:
    r = client.get("/near/arena")
    assert r.status_code == 200, r.text
    return r.json()


def ready_lobby(client) -> str:
    """The lobby's world id, once its season is open on chain."""
    state = wait_for(
        lambda: (s := arena_state(client))["lobby"]["season_status"] == "Open"
        and s["lobby"]["waiting_for"] != "chain" and s,
        what="an open lobby",
    )
    return state["world_id"]


def join(client, wid, pass_id, **body):
    return client.post("/near/arena/join", json={"world_id": wid, "pass_id": pass_id, **body})


# ---------------------------------------------------------------------------


def test_a_lobby_is_open_at_boot_and_after_each_start(tmp_path, monkeypatch):
    with arena_app(tmp_path, monkeypatch) as (client, arena, settler, fake):
        first = ready_lobby(client)
        assert fake.applied("create_season")[0].args["season_id"] == first

        r = client.post("/near/arena/start")
        assert r.status_code == 200, r.text
        state = arena_state(client)
        assert state["world_id"] not in (None, first)
        assert state["running"]["world_id"] == first
        assert wait_for(lambda: len(fake.applied("create_season")) == 2, what="next create")


def test_get_arena_has_the_documented_shape(tmp_path, monkeypatch):
    with arena_app(tmp_path, monkeypatch) as (client, arena, settler, fake):
        wid = ready_lobby(client)
        state = arena_state(client)
        assert state["enabled"] is True
        assert state["contract_id"] == "questfi.testnet"
        assert state["entry_stake"] == str(10**23)
        assert state["world_id"] == wid
        assert state["lobby"] == {
            "world_id": wid, "season_status": "Open", "seats_taken": 0, "seats_total": 4,
            "players": [], "starts_in_s": None, "waiting_for": "player",
        }
        assert state["running"] is None and state["last"] is None

        fake.add_entrant(wid, "101", "MIMIR")
        assert join(client, wid, "101", name="MIMIR", roster_id="mimir").status_code == 200
        lobby = arena_state(client)["lobby"]
        assert lobby["players"] == [{"name": "MIMIR", "pass_id": "101"}]
        assert lobby["waiting_for"] == "countdown"
        assert 0 < lobby["starts_in_s"] <= 60


def test_join_seats_an_entrant_and_refuses_a_non_entrant(tmp_path, monkeypatch):
    from quest_sim.api import world_routes

    with arena_app(tmp_path, monkeypatch) as (client, arena, settler, fake):
        wid = ready_lobby(client)
        r = join(client, wid, "101", name="MIMIR", roster_id="mimir")
        assert r.status_code == 403
        assert "has not entered season" in r.json()["detail"]

        fake.add_entrant(wid, "101", "MIMIR")
        r = join(client, wid, "101", name="MIMIR", roster_id="mimir", account_id="pilot.testnet")
        assert r.status_code == 200, r.text
        body = r.json()
        assert set(body) == {"world_id", "agent_id", "name", "starts_in_s"}
        assert body["world_id"] == wid and body["name"] == "MIMIR"
        agent = world_routes._runners[wid].world.agents[body["agent_id"]]
        assert (agent.brain, agent.preset, agent.disposition, agent.pass_id) == (
            "hosted", "rogue", "opportunist", "101",
        )
        assert agent.persona == "Market oracle. Plays the odds, loots late."

        fake.add_entrant(wid, "102")
        r = join(client, wid, "102", roster_id="nobody-we-know")
        assert r.status_code == 200
        other = world_routes._runners[wid].world.agents[r.json()["agent_id"]]
        assert (other.name, other.preset, other.disposition) == ("PASS-102", "fighter", "balanced")

        fake.outage = True
        assert join(client, wid, "103").status_code == 503
        fake.outage = False


def test_a_repeated_join_returns_the_same_seat(tmp_path, monkeypatch):
    with arena_app(tmp_path, monkeypatch) as (client, arena, settler, fake):
        wid = ready_lobby(client)
        fake.add_entrant(wid, "101", "AEGIS")
        first = join(client, wid, "101", name="AEGIS", roster_id="aegis").json()
        again = join(client, wid, "101", name="AEGIS", roster_id="aegis")
        assert again.status_code == 200
        assert again.json()["agent_id"] == first["agent_id"]
        assert arena_state(client)["lobby"]["seats_taken"] == 1


def test_the_countdown_starts_the_season_and_it_settles(tmp_path, monkeypatch):
    with arena_app(tmp_path, monkeypatch, countdown_s=0.4) as (client, arena, settler, fake):
        wid = ready_lobby(client)
        fake.add_entrant(wid, "101", "ROKO")
        seated_at = time.monotonic()
        assert join(client, wid, "101", name="ROKO", roster_id="roko").status_code == 200

        wait_for(lambda: (arena_state(client)["running"] or {}).get("world_id") == wid,
                 what="the countdown start")
        assert time.monotonic() - seated_at >= 0.4
        last = wait_for(lambda: arena_state(client)["last"], timeout=20, what="the result")
        assert last["world_id"] == wid
        assert fake.seasons[wid]["status"] == "Settled"
        settles = [c for c in fake.applied("settle_season") if c.args["season_id"] == wid]
        assert len(settles) == 1
        assert settles[0].args["winner_pass"] == last["winner_pass"]
        entered = {c.args["pass_id"] for c in fake.applied("enter_season")
                   if c.args["season_id"] == wid}
        assert len(entered) == 3 and "101" not in entered  # three house seats
        # betting locked a fixed number of ticks in (lock_ticks=3)
        assert settler.lock_tick_for(wid) == 3
        assert settler.status(wid)["lock_tick"] == 3
        assert [c for c in fake.applied("lock_market") if c.args["season_id"] == wid]


def test_ticks_wait_until_the_chain_has_the_season_running(tmp_path, monkeypatch):
    from quest_sim.api import world_routes

    with arena_app(tmp_path, monkeypatch) as (client, arena, settler, fake):
        wid = ready_lobby(client)
        fake.hang = True  # every transaction stalls: entries and start_season stay queued
        assert client.post("/near/arena/start").status_code == 200
        time.sleep(0.5)  # 25 polls of the arena loop, 25 tick lengths
        running = arena_state(client)["running"]
        assert running["world_id"] == wid
        assert running["stage"] == "starting" and running["season_status"] == "Open"
        assert world_routes._runners[wid].world.tick == 0
        assert not world_routes._runners[wid].is_auto

        fake.release()
        wait_for(lambda: world_routes._runners[wid].world.tick > 0, what="the first tick")

        def order():
            return [c.method for c in fake.applied() if c.args.get("season_id") == wid]

        wait_for(lambda: "lock_market" in order(), what="the market lock")
        assert order().index("start_season") < order().index("lock_market")


def test_a_second_lobby_waits_for_the_running_season_to_settle(tmp_path, monkeypatch):
    from quest_sim.api import world_routes

    with arena_app(tmp_path, monkeypatch, countdown_s=0.2) as (client, arena, settler, fake):
        first = ready_lobby(client)
        assert client.post("/near/arena/start").status_code == 200
        wait_for(lambda: (arena_state(client)["running"] or {}).get("stage") == "ticking",
                 what="the first season ticking")
        second = ready_lobby(client)
        fake.hang = True  # the first season's settle cannot land
        fake.add_entrant(second, "101", "CASSANDRA")
        assert join(client, second, "101", roster_id="cassandra").status_code == 200

        wait_for(lambda: world_routes._runners[first].world.phase.value == "finished",
                 timeout=20, what="the first season's game over")
        time.sleep(0.4)  # the countdown has long passed
        state = arena_state(client)
        assert state["running"]["world_id"] == first
        assert state["lobby"]["world_id"] == second
        assert state["lobby"]["waiting_for"] == "running_season"
        assert state["lobby"]["starts_in_s"] is None

        fake.release()
        wait_for(lambda: (arena_state(client)["running"] or {}).get("world_id") == second,
                 timeout=20, what="the second season")
        methods = [(c.method, c.args.get("season_id")) for c in fake.applied()]
        assert methods.index(("settle_season", first)) < methods.index(("start_season", second))


def test_an_unseated_entrant_gets_a_seat_at_start(tmp_path, monkeypatch):
    with arena_app(tmp_path, monkeypatch) as (client, arena, settler, fake):
        wid = ready_lobby(client)
        fake.add_entrant(wid, "202", "ROKO")  # entered on chain, never joined
        fake.add_entrant(wid, "203")  # no name on chain either
        r = client.post("/near/arena/start")
        assert r.status_code == 200, r.text
        roster = {a.get("pass_id"): a for a in r.json()["roster"]}
        assert roster["202"]["name"] == "ROKO"
        assert roster["203"]["name"] == "PASS-203"
        assert len(roster) == 4  # two players, two house agents
        assert arena.last_house_start_at is None  # players were in it


def test_a_house_start_respects_the_gap_and_one_season_at_a_time(tmp_path, monkeypatch):
    with arena_app(tmp_path, monkeypatch, house_gap_s=60.0) as (client, arena, settler, fake):
        ready_lobby(client)
        assert client.post("/near/arena/start").status_code == 200
        busy = client.post("/near/arena/start")
        assert busy.status_code == 409 and "still running" in busy.json()["detail"]

        wait_for(lambda: arena_state(client)["last"], timeout=20, what="the house season")
        ready_lobby(client)
        too_soon = client.post("/near/arena/start")
        assert too_soon.status_code == 429
        assert 0 < arena_state(client)["house_start_in_s"] <= 60


def test_a_start_request_with_a_player_seated_skips_the_countdown_and_the_gap(tmp_path, monkeypatch):
    with arena_app(tmp_path, monkeypatch, house_gap_s=60.0, countdown_s=600.0) as (client, arena, settler, fake):
        ready_lobby(client)
        assert client.post("/near/arena/start").status_code == 200  # a house season
        wait_for(lambda: arena_state(client)["last"], timeout=20, what="the house season")

        wid = ready_lobby(client)
        assert client.post("/near/arena/start").status_code == 429  # inside the house gap
        fake.add_entrant(wid, "101", "ROKO")
        assert join(client, wid, "101", name="ROKO", roster_id="roko").status_code == 200
        assert arena_state(client)["lobby"]["waiting_for"] == "countdown"

        started = client.post("/near/arena/start")
        assert started.status_code == 200, started.text
        assert started.json()["world_id"] == wid
        assert any(a["name"] == "ROKO" for a in started.json()["roster"])
        assert arena.last_house_start_at is not None  # unchanged by a season with a player


def test_only_the_latest_finished_world_is_kept(tmp_path, monkeypatch):
    from quest_sim.api import world_routes

    with arena_app(tmp_path, monkeypatch) as (client, arena, settler, fake):
        first = ready_lobby(client)
        client.post("/near/arena/start")
        wait_for(lambda: (arena_state(client)["last"] or {}).get("world_id") == first,
                 timeout=20, what="the first result")
        second = ready_lobby(client)
        client.post("/near/arena/start")
        wait_for(lambda: (arena_state(client)["last"] or {}).get("world_id") == second,
                 timeout=20, what="the second result")
        assert first not in world_routes._runners
        assert not (tmp_path / "worlds" / first).exists()
        assert client.get(f"/world/{second}/state").status_code == 200


def test_arena_worlds_keep_their_own_clock(tmp_path, monkeypatch):
    with arena_app(tmp_path, monkeypatch) as (client, arena, settler, fake):
        wid = ready_lobby(client)
        for path in ("start", "run", "tick"):
            r = client.post(f"/world/{wid}/{path}")
            assert r.status_code == 409, (path, r.text)
        assert "arena" in client.post(f"/world/{wid}/start").json()["detail"]


def test_boot_cancels_seasons_left_behind_exactly_once(tmp_path, monkeypatch):
    fake = FakeNearClient()
    # A season this server has no record of holds two house passes.
    fake.seasons["w-lost"] = {
        "status": "Running", "entry_stake": "1", "next_seq": 0, "events": [],
        "winner": None, "market_open": True,
        "entrants": {"1": {"name": "", "alive": True}, "2": {"name": "", "alive": True}},
    }
    fake.active.update({"1": "w-lost", "2": "w-lost"})

    with arena_app(tmp_path, monkeypatch, fake=fake) as (client, arena, settler, _):
        left_open = ready_lobby(client)
        assert wait_for(lambda: fake.applied("cancel_season"), what="the orphan cancel")
        assert client.portal.call(settler.drain, 5.0)
    cancels = [c.args["season_id"] for c in fake.applied("cancel_season")]
    assert cancels == ["w-lost"]
    assert fake.seasons["w-lost"]["status"] == "Cancelled"
    assert "1" not in fake.active and "2" not in fake.active

    # A restart: the lobby the first process left open is cancelled and
    # dropped, and the orphan is not cancelled again.
    with arena_app(tmp_path, monkeypatch, fake=fake) as (client, arena, settler, _):
        fresh = ready_lobby(client)
        assert fresh != left_open
        assert client.portal.call(settler.drain, 5.0)
    cancels = [c.args["season_id"] for c in fake.applied("cancel_season")]
    assert cancels == ["w-lost", left_open]
    assert not (tmp_path / "worlds" / left_open).exists()


def test_nothing_changes_with_the_arena_off(tmp_path, monkeypatch):
    with arena_app(tmp_path, monkeypatch, arena_on=False) as (client, arena, settler, fake):
        assert client.get("/near/arena").json() == {"enabled": False, "world_id": None}
        assert client.post("/near/arena/join", json={"pass_id": "1"}).status_code == 404
        assert client.post("/near/arena/start").status_code == 404
        assert client.get("/world").json()["worlds"] == []
        time.sleep(0.1)
    assert fake.calls == [] and fake.views == []


@pytest.mark.parametrize("roster_id,kit", [
    ("mimir", ("rogue", "opportunist")), ("cassandra", ("fighter", "aggressive")),
    ("roko", ("barbarian", "aggressive")), ("aegis", ("fighter", "turtle")),
])
def test_roster_ids_pick_kit_and_disposition(roster_id, kit):
    from quest_sim.near.arena import ROSTER_KITS

    assert ROSTER_KITS[roster_id][:2] == kit

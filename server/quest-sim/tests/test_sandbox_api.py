"""The /world surface: lobby, BYO auth, clock, spectator reads, SSE cursor."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from quest_sim.config import Settings
from quest_sim.persistence import sandbox_store
from tests.conftest import ADMIN_KEY


@pytest.fixture
def sandbox_client(tmp_path: Path):
    """The authorised client: enforcement ON, admin key on every request.

    Carrying the key by default keeps all ~25 pre-existing /start and /tick
    call sites working untouched, and quietly exercises the superuser path
    across the whole suite. Negative tests override X-Host-Key per request
    (httpx merges request headers over client defaults)."""
    from quest_sim.api import world_routes
    from quest_sim.main import create_app

    settings = Settings(
        _env_file=None,
        data_dir=tmp_path / "games",
        sandbox_data_dir=tmp_path / "worlds",
        sandbox_pool_size=4,
        sandbox_hosted_brain="policy",  # tests never spend tokens
        admin_key=ADMIN_KEY,
        sandbox_host_key_enforced=True,
    )
    original = world_routes._get_settings
    world_routes._get_settings = lambda: settings
    world_routes._runners.clear()
    app = create_app()
    with TestClient(app, headers={"X-Host-Key": ADMIN_KEY}) as client:
        yield client, settings
    world_routes._get_settings = original
    world_routes._runners.clear()


def _new_world(client, **body):
    r = client.post("/world/new", json={"seed": 7, **body})
    assert r.status_code == 200, r.text
    return r.json()


def test_new_world_opens_lobby(sandbox_client):
    client, settings = sandbox_client
    data = _new_world(client)
    assert data["phase"] == "lobby"
    assert data["pool_size"] == 4  # settings default flows through
    assert data["world_id"].startswith("w-")
    # persisted to disk immediately
    assert sandbox_store.load_world(settings.sandbox_data_dir, data["world_id"]) is not None
    # listed
    listed = client.get("/world").json()["worlds"]
    assert any(w["world_id"] == data["world_id"] for w in listed)


def test_defaulted_fields_load_old_world_json(sandbox_client):
    """A world.json written before host_key/ready existed must still load.

    load_world swallows every validation error and returns None, which
    _runner turns into a 404 — so one field added without a default would
    silently 404 the entire production data dir. This is that tripwire."""
    import json

    client, settings = sandbox_client
    wid = _new_world(client)["world_id"]
    path = settings.sandbox_data_dir / wid / "world.json"

    raw = json.loads(path.read_text())
    raw.pop("host_key", None)
    raw.pop("recent_deaths", None)
    for agent in raw.get("agents", {}).values():
        agent.pop("ready", None)
        agent.pop("searched_rooms", None)
        agent.pop("loc_trail", None)
    path.write_text(json.dumps(raw))

    world = sandbox_store.load_world(settings.sandbox_data_dir, wid)
    assert world is not None, "a world.json missing the new fields must still load"
    assert world.host_key is None
    assert world.recent_deaths == {}
    assert all(a.ready is False for a in world.agents.values())
    assert all(a.searched_rooms == {} for a in world.agents.values())
    assert all(a.loc_trail == {} for a in world.agents.values())


def test_guide_is_served(sandbox_client):
    client, _ = sandbox_client
    r = client.get("/world/guide")
    assert r.status_code == 200
    assert "Bring-Your-Own-Agent" in r.text
    assert "X-Agent-Token" in r.text
    # the player contract, not an API spec
    assert "NEVER write a script" in r.text
    # long-polling is taught, but no longer at a hardcoded 25s: a poll that
    # cannot outlast the season's turn window always expires on a stale read
    assert "wait_s=" in r.text
    assert "suggested_wait_s" in r.text
    assert "wait_s=25" not in r.text
    assert "truce dies with the last mob" in r.text
    # no runnable loop template that invites client-building (the contract
    # may NAME `while true` to forbid it; it must not hand one out)
    assert "while true; do" not in r.text
    assert "sandbox_byo_client" not in r.text


def test_onboarding_docs_are_served_as_markdown_too(sandbox_client):
    """A coding agent handed an extensionless URL has to guess what is on
    the other end — one Codex agent guessed "web page" and started a
    browser, which holds the readiness barrier and stalls the whole table.
    Both documents ARE markdown, so `.md` says so where the agent is
    already looking. The bare paths stay: they are in already-pasted
    invites and in every past create response."""
    client, _ = sandbox_client
    bare = client.get("/world/guide")
    md = client.get("/world/guide.md")
    assert md.status_code == 200
    assert md.text == bare.text
    assert md.headers["content-type"].startswith("text/markdown")

    wid = _new_world(client)["world_id"]
    bare_i = client.get(f"/world/{wid}/invite")
    md_i = client.get(f"/world/{wid}/invite.md")
    assert md_i.status_code == 200
    assert md_i.text == bare_i.text
    assert md_i.headers["content-type"].startswith("text/markdown")


def test_markdown_invite_still_gates_on_the_code(sandbox_client):
    """An extension is not a bypass."""
    client, _ = sandbox_client
    created = _new_world(client, require_invite=True)
    wid, code = created["world_id"], created["invite_code"]
    assert client.get(f"/world/{wid}/invite.md").status_code == 403
    assert client.get(f"/world/{wid}/invite.md?code=wrong").status_code == 403
    assert client.get(f"/world/{wid}/invite.md?code={code}").status_code == 200
    assert client.get("/world/w-nope/invite.md").status_code == 404


def test_guide_forbids_starting_a_browser(sandbox_client):
    """The deterministic backstop to the `.md` hint, for agents that arrive
    by a bare URL or over MCP and never see the extension."""
    client, _ = sandbox_client
    guide = client.get("/world/guide").text
    assert "No browser" in guide


def test_guide_tells_players_to_send_their_thought(sandbox_client):
    """A BYO player who never sends `thought` is a silent process in the
    crawler view. The guide has to ASK for it on the HTTP path, not just
    on the MCP one — HTTP is the supported path."""
    client, _ = sandbox_client
    guide = client.get("/world/guide").text
    assert '"thought"' in guide  # in the POST body example
    assert "spectator" in guide.lower()


def test_guide_separates_the_spectator_and_deployer_channels(sandbox_client):
    """Two audiences, two registers: a flavor toast for the crawler view,
    and real scheming for the human in the Claude Code / Codex session
    who cannot see the game at all. Collapsing them loses one of them."""
    client, _ = sandbox_client
    guide = client.get("/world/guide").text
    assert "Two audiences" in guide
    assert "Claude Code" in guide and "Codex" in guide
    # the deployer channel must not be sold as a duplicate of the toast
    assert "cannot see the game" in guide
    # and it must not license stalling the shared tick
    assert "POST first, connive after" in guide
    # It is the RARE channel: a readout every tick is latency the whole
    # table pays for, so the guide has to ask for restraint and say when.
    assert "do NOT narrate every turn" in guide
    assert "two or three short sentences" in guide
    assert "strategy actually TURNS" in guide


def test_join_returns_token_color_protocol(sandbox_client):
    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    r1 = client.post(f"/world/{wid}/join", json={"name": "Atlas"})
    r2 = client.post(f"/world/{wid}/join", json={"name": "Nova"})
    assert r1.status_code == 200 and r2.status_code == 200
    a, b = r1.json(), r2.json()
    assert a["token"] and b["token"] and a["token"] != b["token"]
    assert a["color"] != b["color"]
    assert a["lobby"]["joined"] == 1 and b["lobby"]["joined"] == 2
    assert a["protocol"]["observation_url"].endswith(f"/{a['agent_id']}/observation")


def test_listing_worlds_does_not_instantiate_runners(sandbox_client):
    """GET /world must be a read: it used to arm a runner (clock, mailbox,
    commentator booth) for every world on disk, pinning all history in RAM."""
    from quest_sim.api import world_routes

    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    world_routes._runners.clear()  # simulate a fresh process
    listed = client.get("/world").json()["worlds"]
    assert any(w["world_id"] == wid and w["phase"] == "lobby" for w in listed)
    assert wid not in world_routes._runners


def test_gc_sweeps_stale_worlds_by_phase_ttl(sandbox_client):
    import os
    import time

    from quest_sim.api import world_routes

    client, settings = sandbox_client
    stale = _new_world(client)["world_id"]
    fresh = _new_world(client, seed=8)["world_id"]

    # age the stale lobby past its TTL (world.json mtime is the activity clock)
    old = time.time() - (settings.sandbox_lobby_ttl_h + 1) * 3600
    wj = settings.sandbox_data_dir / stale / "world.json"
    os.utime(wj, (old, old))

    swept = world_routes.sweep_stale_worlds()
    assert stale in swept
    assert not (settings.sandbox_data_dir / stale).exists()
    assert stale not in world_routes._runners  # runner evicted too
    assert (settings.sandbox_data_dir / fresh).exists()  # young lobby kept

    listed = client.get("/world").json()["worlds"]
    assert all(w["world_id"] != stale for w in listed)


def test_guide_and_invite_carry_mcp_onboarding(sandbox_client):
    """MCP stays documented, but demoted: HTTP is the supported path and
    the invite must lead with it."""
    client, _ = sandbox_client
    guide = client.get("/world/guide").text
    assert "claude mcp add --transport http" in guide
    assert "EXPERIMENTAL" in guide
    created = _new_world(client, require_invite=True)
    invite = client.get(created["invite_url"]).text
    assert "/mcp/" in invite
    assert f'invite_code="{created["invite_code"]}"' in invite
    assert invite.index("POST /world") < invite.index("mcp add")


def test_guide_never_teaches_players_the_host_surface(sandbox_client):
    """WORLD_GUIDE is pasted verbatim into every player's prompt by the
    invite. Naming the host header or the destructive routes there would
    hand every BYO agent the controls the same document tells it not to
    go looking for. The host learns them from POST /world/new instead."""
    client, _ = sandbox_client
    created = _new_world(client)
    for text in (client.get("/world/guide").text, client.get(created["invite_url"]).text):
        assert "X-Host-Key" not in text
        assert "host_key" not in text
        assert "/start" not in text
        assert "DELETE" not in text

    host = created["host"]
    assert "X-Host-Key" in host["how"]
    assert host["start_url"] == f"/world/{created['world_id']}/start"
    assert host["delete_url"] == f"/world/{created['world_id']}"


def test_invite_pins_world_and_embeds_guide(sandbox_client):
    """One URL onboards an agent to ONE world: the invite spells out the
    join call for that world and embeds the full player contract."""
    client, _ = sandbox_client
    created = _new_world(client)
    wid = created["world_id"]
    # .md on purpose: the extension is what stops a coding agent guessing
    # "web page" and starting a browser. See MARKDOWN in world_routes.
    assert created["invite_url"] == f"/world/{wid}/invite.md"

    r = client.get(f"/world/{wid}/invite")
    assert r.status_code == 200
    assert f"POST /world/{wid}/join" in r.text
    assert "has NOT started" in r.text
    assert "NEVER write a script" in r.text  # the full contract rides along

    # once the season starts, the invitation goes cold
    client.post(f"/world/{wid}/start")
    assert "already RUNNING" in client.get(f"/world/{wid}/invite").text


def test_invite_only_world_gates_join_and_invite(sandbox_client):
    """require_invite makes a world unlisted: the code gates both the
    invitation and the join, and never leaks via spectator surfaces."""
    client, _ = sandbox_client
    created = _new_world(client, require_invite=True)
    wid, code = created["world_id"], created["invite_code"]
    assert code
    assert created["invite_url"].endswith(f"?code={code}")

    assert client.get(f"/world/{wid}/invite").status_code == 403
    ok = client.get(f"/world/{wid}/invite?code={code}")
    assert ok.status_code == 200
    assert f'"code": "{code}"' in ok.text  # join sample carries it

    assert client.post(f"/world/{wid}/join", json={"name": "Gate"}).status_code == 403
    r = client.post(f"/world/{wid}/join", json={"name": "Gate", "code": code})
    assert r.status_code == 200

    # spectator surfaces stay code-free
    assert code not in client.get(f"/world/{wid}/state").text
    assert code not in client.get("/world").text


CONTROL_ROUTES = ["start", "tick", "run", "pause"]


def test_new_world_mints_host_key(sandbox_client):
    client, _ = sandbox_client
    a, b = _new_world(client), _new_world(client)
    assert a["host_key"] and b["host_key"]
    assert a["host_key"] != b["host_key"]


def test_control_routes_require_host_key(sandbox_client):
    client, _ = sandbox_client
    created = _new_world(client)
    wid, key = created["world_id"], created["host_key"]
    other_key = _new_world(client)["host_key"]

    for route in CONTROL_ROUTES:
        url = f"/world/{wid}/{route}"
        assert client.post(url, headers={"X-Host-Key": ""}).status_code == 403
        assert client.post(url, headers={"X-Host-Key": "nope"}).status_code == 403
        # another world's key is not a skeleton key
        assert client.post(url, headers={"X-Host-Key": other_key}).status_code == 403

    # the world's own key opens it — via header and via the query fallback
    assert client.post(f"/world/{wid}/start", headers={"X-Host-Key": key}).status_code == 200
    assert client.post(f"/world/{wid}/pause?host_key={key}", headers={"X-Host-Key": ""}).status_code == 200


def test_admin_key_controls_any_world(sandbox_client):
    """The operator's skeleton key opens a world whose host_key it isn't."""
    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    assert client.post(f"/world/{wid}/start", headers={"X-Host-Key": ADMIN_KEY}).status_code == 200


def test_auth_precedes_phase_conflict(sandbox_client):
    """403 beats 409. The conflict bodies describe the season's state, and
    a stranger has no business reading it — so authorise first, then judge
    the phase. Deliberate: "no key + wrong phase" is 403, never 409."""
    client, _ = sandbox_client
    created = _new_world(client)
    wid, key = created["world_id"], created["host_key"]

    # ticking a lobby is a 409 for the host...
    assert client.post(f"/world/{wid}/tick", headers={"X-Host-Key": key}).status_code == 409
    # ...and a 403 for everyone else, who never learns the phase
    r = client.post(f"/world/{wid}/tick", headers={"X-Host-Key": "nope"})
    assert r.status_code == 403
    assert "lobby" not in r.text and "running" not in r.text


def test_legacy_world_without_host_key_stays_controllable(sandbox_client):
    """Worlds written before host_key existed carry None, and must stay
    open to anyone — otherwise deploying this bricks every live season."""
    import json

    from quest_sim.api import world_routes

    client, settings = sandbox_client
    wid = _new_world(client)["world_id"]
    path = settings.sandbox_data_dir / wid / "world.json"
    raw = json.loads(path.read_text())
    raw.pop("host_key")
    path.write_text(json.dumps(raw))
    world_routes._runners.clear()  # force a reload from disk

    assert client.post(f"/world/{wid}/start", headers={"X-Host-Key": ""}).status_code == 200


def test_enforcement_flag_off_allows_control(tmp_path: Path):
    """Dormant mode: the gate is installed but not armed, so a frontend
    that knows nothing about host keys keeps working. This is what lets
    the backend deploy ahead of the client."""
    from quest_sim.api import world_routes
    from quest_sim.main import create_app

    settings = Settings(
        _env_file=None,
        data_dir=tmp_path / "games",
        sandbox_data_dir=tmp_path / "worlds",
        sandbox_pool_size=4,
        sandbox_hosted_brain="policy",
        sandbox_host_key_enforced=False,
    )
    original = world_routes._get_settings
    world_routes._get_settings = lambda: settings
    world_routes._runners.clear()
    try:
        with TestClient(create_app()) as client:  # no key on the client at all
            wid = _new_world(client)["world_id"]
            assert client.post(f"/world/{wid}/start").status_code == 200
    finally:
        world_routes._get_settings = original
        world_routes._runners.clear()


def test_agent_ready_is_informational(sandbox_client):
    """Ready is a courtesy signal. It renders; it triggers nothing.

    The anti-auto-start assertion below is the point: with every joined
    agent ready, the world is STILL in lobby. Hosted brains backfill the
    pool at /start, so any "all ready -> go" rule would fire a season with
    one real agent and a crowd of bots."""
    client, _ = sandbox_client
    created = _new_world(client)
    wid, key = created["world_id"], created["host_key"]

    a = client.post(f"/world/{wid}/join", json={"name": "Vex"}).json()
    client.post(f"/world/{wid}/join", json={"name": "Marrow", "ready": True})  # ready on arrival

    def _roster():
        return {r["name"]: r for r in client.get(f"/world/{wid}/state").json()["roster"]}

    assert _roster()["Vex"]["ready"] is False
    assert _roster()["Marrow"]["ready"] is True

    # wrong token is 401, same as every other agent-scoped route
    assert client.post(
        f"/world/{wid}/agent/{a['agent_id']}/ready", headers={"X-Agent-Token": "nope"}
    ).status_code == 401

    r = client.post(
        f"/world/{wid}/agent/{a['agent_id']}/ready", headers={"X-Agent-Token": a["token"]}
    )
    assert r.status_code == 200 and r.json()["ready"] is True
    assert _roster()["Vex"]["ready"] is True

    # everyone ready, and the season has still not begun
    assert client.get(f"/world/{wid}/state").json()["phase"] == "lobby"

    # ...until the host says so, and then the flag stops being reported
    assert client.post(f"/world/{wid}/start", headers={"X-Host-Key": key}).status_code == 200
    assert all("ready" not in r for r in client.get(f"/world/{wid}/state").json()["roster"])
    assert client.post(
        f"/world/{wid}/agent/{a['agent_id']}/ready", headers={"X-Agent-Token": a["token"]}
    ).status_code == 409


def test_ready_broadcasts_to_lobby(sandbox_client):
    """Spectators watching a lobby fill must see readiness land live."""
    from quest_sim.api import world_routes

    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    joined = client.post(f"/world/{wid}/join", json={"name": "Vex"}).json()
    queue = world_routes._runners[wid].subscribe()

    client.post(
        f"/world/{wid}/agent/{joined['agent_id']}/ready",
        headers={"X-Agent-Token": joined["token"]},
    )

    frame = queue.get_nowait()
    assert frame["phase"] == "lobby"
    assert [r for r in frame["roster"] if r["name"] == "Vex"][0]["ready"] is True


def test_state_reports_can_control(sandbox_client):
    client, _ = sandbox_client
    created = _new_world(client)
    wid, key = created["world_id"], created["host_key"]

    ok = client.get(f"/world/{wid}/state", headers={"X-Host-Key": key})
    assert ok.status_code == 200
    assert ok.json()["can_control"] is True
    assert ok.json()["host_key_required"] is True

    # a stale or wrong key must not break the spectator view
    nope = client.get(f"/world/{wid}/state", headers={"X-Host-Key": "nope"})
    assert nope.status_code == 200
    assert nope.json()["can_control"] is False
    assert nope.json()["roster"] == ok.json()["roster"]

    listed = client.get("/world", headers={"X-Host-Key": "nope"}).json()["worlds"]
    assert [w for w in listed if w["world_id"] == wid][0]["can_control"] is False
    listed = client.get("/world", headers={"X-Host-Key": key}).json()["worlds"]
    assert [w for w in listed if w["world_id"] == wid][0]["can_control"] is True


def test_host_key_never_leaks(sandbox_client):
    """Nothing but hand-built response dicts keeps the three secrets off
    the wire. It IS on disk, deliberately — excluding it would lose the
    key across the restart _runner recovers from — so that is pinned too,
    lest someone "harden" it into a restart bug."""
    client, settings = sandbox_client
    created = _new_world(client)
    wid, key = created["world_id"], created["host_key"]
    client.post(f"/world/{wid}/join", json={"name": "Vex"})
    client.post(f"/world/{wid}/start", headers={"X-Host-Key": key})
    client.post(f"/world/{wid}/tick?wait_s=0", headers={"X-Host-Key": key})

    for path in (
        f"/world/{wid}/state",
        "/world",
        f"/world/{wid}/invite",
        f"/world/{wid}/events",
        f"/world/{wid}/map",
    ):
        r = client.get(path, headers={"X-Host-Key": key})
        assert key not in r.text, f"host key leaked via {path}"

    assert key in (settings.sandbox_data_dir / wid / "world.json").read_text()


def test_delete_world_removes_disk_and_runner(sandbox_client):
    from quest_sim.api import world_routes

    client, settings = sandbox_client
    created = _new_world(client)
    wid, key = created["world_id"], created["host_key"]

    r = client.delete(f"/world/{wid}", headers={"X-Host-Key": key})
    assert r.status_code == 200
    assert r.json() == {"deleted": True, "world_id": wid}

    assert not (settings.sandbox_data_dir / wid).exists()
    assert wid not in world_routes._runners
    assert client.get(f"/world/{wid}/state").status_code == 404
    assert not any(w["world_id"] == wid for w in client.get("/world").json()["worlds"])
    # not idempotent — the world genuinely isn't there any more
    assert client.delete(f"/world/{wid}", headers={"X-Host-Key": key}).status_code == 404


def test_delete_requires_host_key(sandbox_client):
    client, settings = sandbox_client
    wid = _new_world(client)["world_id"]

    assert client.delete(f"/world/{wid}", headers={"X-Host-Key": "nope"}).status_code == 403
    assert (settings.sandbox_data_dir / wid).exists(), "a refused delete must not delete"


def test_delete_is_gated_even_while_enforcement_is_dormant(tmp_path: Path):
    """The rollout window leaves the clock open, never the wrecking ball —
    nothing deployed calls DELETE, so it has always been gated."""
    from quest_sim.api import world_routes
    from quest_sim.main import create_app

    settings = Settings(
        _env_file=None,
        data_dir=tmp_path / "games",
        sandbox_data_dir=tmp_path / "worlds",
        sandbox_pool_size=4,
        sandbox_hosted_brain="policy",
        sandbox_host_key_enforced=False,
    )
    original = world_routes._get_settings
    world_routes._get_settings = lambda: settings
    world_routes._runners.clear()
    try:
        with TestClient(create_app()) as client:
            created = _new_world(client)
            wid, key = created["world_id"], created["host_key"]
            assert client.post(f"/world/{wid}/start").status_code == 200  # clock still open
            assert client.delete(f"/world/{wid}").status_code == 403  # wrecking ball is not
            assert client.delete(f"/world/{wid}", headers={"X-Host-Key": key}).status_code == 200
    finally:
        world_routes._get_settings = original
        world_routes._runners.clear()


def test_delete_stops_the_clock(sandbox_client):
    """An orphaned auto-loop would save_world the directory back into
    existence a tick later."""
    import time

    client, settings = sandbox_client
    created = _new_world(client, tick_seconds=0.2)
    wid, key = created["world_id"], created["host_key"]
    client.post(f"/world/{wid}/start", headers={"X-Host-Key": key})
    assert client.post(f"/world/{wid}/run", json={"tick_seconds": 0.2}).status_code == 200

    client.delete(f"/world/{wid}", headers={"X-Host-Key": key})
    time.sleep(0.8)  # several ticks' worth of wall clock
    assert not (settings.sandbox_data_dir / wid).exists()


def test_delete_wakes_the_stream(sandbox_client):
    """A spectator parked on the SSE fan-out must be released, not left on
    sse-starlette's pings forever."""
    from quest_sim.api import world_routes

    client, _ = sandbox_client
    created = _new_world(client)
    wid, key = created["world_id"], created["host_key"]
    queue = world_routes._runners[wid].subscribe()

    client.delete(f"/world/{wid}", headers={"X-Host-Key": key})

    payload = queue.get_nowait()
    assert payload["kind"] == "world_deleted"
    assert payload["world_id"] == wid


@pytest.fixture
def operator_only_client(tmp_path: Path):
    """A locked-down instance: the admin key is the only credential."""
    from quest_sim.api import world_routes
    from quest_sim.main import create_app

    settings = Settings(
        _env_file=None,
        data_dir=tmp_path / "games",
        sandbox_data_dir=tmp_path / "worlds",
        sandbox_pool_size=4,
        sandbox_hosted_brain="policy",
        admin_key=ADMIN_KEY,
        sandbox_operator_only=True,
    )
    original = world_routes._get_settings
    world_routes._get_settings = lambda: settings
    world_routes._runners.clear()
    app = create_app()
    with TestClient(app) as client:
        yield client, settings
    world_routes._get_settings = original
    world_routes._runners.clear()


def _admin(key=ADMIN_KEY):
    return {"X-Host-Key": key}


def test_operator_only_gates_creation(operator_only_client):
    client, _ = operator_only_client
    assert client.post("/world/new", json={"seed": 7}).status_code == 403
    assert client.post("/world/new", json={"seed": 7},
                       headers={"X-Host-Key": "nope"}).status_code == 403
    assert client.post("/world/new", json={"seed": 7}, headers=_admin()).status_code == 200


def test_operator_only_makes_host_keys_inert(operator_only_client):
    """The whole point of the switch: whoever opened a world does NOT get
    to run it. Only the operator does."""
    client, _ = operator_only_client
    created = client.post("/world/new", json={"seed": 7}, headers=_admin()).json()
    wid, key = created["world_id"], created["host_key"]
    assert key, "a host key is still minted — it just doesn't open anything here"

    for route in CONTROL_ROUTES:
        url = f"/world/{wid}/{route}"
        assert client.post(url, headers={"X-Host-Key": key}).status_code == 403
        assert client.post(url).status_code == 403
    assert client.delete(f"/world/{wid}", headers={"X-Host-Key": key}).status_code == 403

    assert client.post(f"/world/{wid}/start", headers=_admin()).status_code == 200
    assert client.delete(f"/world/{wid}", headers=_admin()).status_code == 200


def test_operator_only_leaves_players_alone(operator_only_client):
    """Locking down management must not lock out the game. A season nobody
    can join is a server with nothing to run."""
    client, _ = operator_only_client
    wid = client.post("/world/new", json={"seed": 7}, headers=_admin()).json()["world_id"]

    joined = client.post(f"/world/{wid}/join", json={"name": "Vex"})
    assert joined.status_code == 200
    agent = joined.json()

    ready = client.post(
        f"/world/{wid}/agent/{agent['agent_id']}/ready",
        headers={"X-Agent-Token": agent["token"]},
    )
    assert ready.status_code == 200

    assert client.get(f"/world/{wid}/state").status_code == 200
    assert client.get(f"/world/{wid}/invite").status_code == 200
    assert client.get("/world/guide").status_code == 200

    client.post(f"/world/{wid}/start", headers=_admin())
    obs = client.get(
        f"/world/{wid}/agent/{agent['agent_id']}/observation",
        headers={"X-Agent-Token": agent["token"]},
    )
    assert obs.status_code == 200
    acted = client.post(
        f"/world/{wid}/agent/{agent['agent_id']}/action",
        json={"action": "wait"},
        headers={"X-Agent-Token": agent["token"]},
    )
    assert acted.status_code == 200


def test_operator_only_advertises_itself(operator_only_client):
    """Clients must be able to hide the button rather than offer a 403."""
    client, _ = operator_only_client
    wid = client.post("/world/new", json={"seed": 7}, headers=_admin()).json()["world_id"]

    anon = client.get("/world").json()
    assert anon["operator_only"] is True
    assert anon["can_create"] is False
    assert client.get("/world", headers=_admin()).json()["can_create"] is True

    state = client.get(f"/world/{wid}/state").json()
    assert state["can_create"] is False and state["can_control"] is False
    admin_state = client.get(f"/world/{wid}/state", headers=_admin()).json()
    assert admin_state["can_create"] is True and admin_state["can_control"] is True


def test_open_server_still_reports_can_create(sandbox_client):
    client, _ = sandbox_client
    listing = client.get("/world").json()
    assert listing["can_create"] is True
    assert listing["operator_only"] is False


def test_whoami_answers_the_key_question_on_an_open_server(sandbox_client):
    """The reason this route exists. On an open server `can_create` is true
    for everyone, so a client cannot tell a typo'd operator key from a good
    one — a wrong key fails much later, on somebody else's world. whoami
    answers directly, whatever the mode."""
    client, _ = sandbox_client
    assert client.get("/world").json()["can_create"] is True  # tells us nothing

    good = client.get("/world/whoami", headers=_admin()).json()
    assert good["operator"] is True
    assert good["operator_only"] is False
    assert good["admin_key_configured"] is True

    assert client.get("/world/whoami", headers={"X-Host-Key": "nope"}).json()["operator"] is False
    # the suite's client sends the admin key by default; override to ask anonymously
    assert client.get("/world/whoami", headers={"X-Host-Key": ""}).json()["operator"] is False


def test_whoami_answers_under_operator_only(operator_only_client):
    client, _ = operator_only_client
    assert client.get("/world/whoami").json() == {
        "operator": False, "operator_only": True, "admin_key_configured": True,
    }
    assert client.get("/world/whoami", headers=_admin()).json()["operator"] is True


def test_whoami_never_echoes_the_key(sandbox_client):
    """A wrong key must learn nothing from the answer."""
    client, _ = sandbox_client
    body = client.get("/world/whoami", headers={"X-Host-Key": "wrong-but-plausible"}).text
    assert "wrong-but-plausible" not in body
    assert ADMIN_KEY not in body


def test_whoami_without_an_admin_key_configured(tmp_path: Path):
    """No operator configured means no key can ever be the operator's —
    which is a different sentence to 'your key is wrong', and the client
    says so."""
    from quest_sim.api import world_routes
    from quest_sim.main import create_app

    settings = Settings(
        _env_file=None,
        data_dir=tmp_path / "games",
        sandbox_data_dir=tmp_path / "worlds",
        sandbox_pool_size=4,
        sandbox_hosted_brain="policy",
        admin_key=None,
    )
    original = world_routes._get_settings
    world_routes._get_settings = lambda: settings
    world_routes._runners.clear()
    try:
        with TestClient(create_app()) as client:
            body = client.get("/world/whoami", headers={"X-Host-Key": "anything"}).json()
            assert body["operator"] is False
            assert body["admin_key_configured"] is False
    finally:
        world_routes._get_settings = original
        world_routes._runners.clear()


def test_whoami_is_not_shadowed_by_the_world_id_routes(sandbox_client):
    """`whoami` is a literal segment under the same prefix as /world/{id}/*.
    A route ordering change that turned it into a world lookup would 404."""
    client, _ = sandbox_client
    assert client.get("/world/whoami").status_code == 200


def test_operator_only_without_admin_key_refuses_to_boot(tmp_path: Path, monkeypatch):
    """A server nobody can use is worse than a failed deploy — the failed
    deploy tells you why.

    Patches quest_sim.main.get_settings, not world_routes._get_settings:
    create_app reads settings directly, so the route-level seam does not
    reach it."""
    from quest_sim import main as main_mod

    def _settings(**over):
        return Settings(
        _env_file=None,
            data_dir=tmp_path / "games",
            sandbox_data_dir=tmp_path / "worlds",
            sandbox_operator_only=True,
            **over,
        )

    monkeypatch.setattr(main_mod, "get_settings", lambda: _settings(admin_key=None))
    with pytest.raises(RuntimeError, match="QUEST_SIM_ADMIN_KEY"):
        main_mod.create_app()

    # ...and boots fine once the key it demands is actually set
    monkeypatch.setattr(main_mod, "get_settings", lambda: _settings(admin_key=ADMIN_KEY))
    assert main_mod.create_app() is not None


def test_new_world_pacing_overrides(sandbox_client):
    """Coding-agent seasons need a generous deadline WITHOUT a server
    restart — pacing knobs ride the create request."""
    from quest_sim.api import world_routes

    client, _ = sandbox_client
    wid = _new_world(
        client, action_deadline_s=45.0, tick_seconds=1.0, max_ticks=60
    )["world_id"]
    config = world_routes._runners[wid].world.config
    assert config.action_deadline_s == 45.0
    assert config.tick_seconds == 1.0
    assert config.max_ticks == 60


def test_lobby_joins_broadcast_frames(sandbox_client):
    """Spectators must see challengers arrive live — frames flow on joins
    and on season start, not just on ticks (the lobby was silent before)."""
    from quest_sim.api import world_routes

    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    runner = world_routes._runners[wid]
    q = runner.subscribe()

    client.post(f"/world/{wid}/join", json={"name": "Atlas"})
    frame = q.get_nowait()
    assert frame["phase"] == "lobby"
    assert [a["name"] for a in frame["roster"]] == ["Atlas"]
    assert any(e["event_type"] == "agent_joined" for e in frame["events"])

    client.post(f"/world/{wid}/start")
    frame = q.get_nowait()
    assert frame["phase"] == "running"
    assert len(frame["roster"]) == 4  # backfilled to pool
    assert any(e["event_type"] == "world_started" for e in frame["events"])


def test_action_long_poll_returns_resolution_and_fresh_observation(sandbox_client):
    """One-call turns: POST action?wait_s= holds until the tick consumes the
    action, then hands back the resolution + next observation together."""
    import threading
    import time

    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    j = client.post(f"/world/{wid}/join", json={"name": "Atlas"}).json()
    client.post(f"/world/{wid}/start")
    aid, tok = j["agent_id"], j["token"]

    out = {}

    def act():
        out["r"] = client.post(
            f"/world/{wid}/agent/{aid}/action?wait_s=10",
            json={"action": "wait"},
            headers={"X-Agent-Token": tok},
        ).json()

    t = threading.Thread(target=act)
    t.start()
    time.sleep(0.5)  # the long-poll is parked on the mailbox
    client.post(f"/world/{wid}/tick")
    t.join(timeout=10)
    assert not t.is_alive()

    r = out["r"]
    assert r["accepted"] and r["resolved"]
    assert r["order_id"] >= 1
    assert r["executed_tick"] == 1
    assert r["observation"]["tick"] == 1
    assert r["observation"]["action_submitted"] is False
    assert r["observation"]["last_order"]["order_id"] == r["order_id"]


def test_http_action_thought_reaches_spectators(sandbox_client):
    """The HTTP action path must carry a thought the way MCP take_turn
    does — it is what the crawler view's thought stream renders for BYO
    agents, and without it the stream is empty for everyone but hosted."""
    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    j = client.post(f"/world/{wid}/join", json={"name": "Atlas"}).json()
    client.post(f"/world/{wid}/start")
    aid, tok = j["agent_id"], j["token"]

    r = client.post(
        f"/world/{wid}/agent/{aid}/action",
        json={"action": "wait", "thought": "The crown is north. So am I."},
        headers={"X-Agent-Token": tok},
    )
    assert r.status_code == 200
    client.post(f"/world/{wid}/tick")

    events = client.get(f"/world/{wid}/events?since_tick=0").json()["events"]
    thoughts = [e for e in events if e["event_type"] == "agent_thought" and e["actor"] == aid]
    assert [t["data"]["thought"] for t in thoughts] == ["The crown is north. So am I."]


def test_http_action_thought_is_optional_and_capped(sandbox_client):
    """A thought-less POST still plays (the field is flavor, never engine
    input), and a runaway thought cannot flood the spectator stream."""
    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    j = client.post(f"/world/{wid}/join", json={"name": "Atlas"}).json()
    client.post(f"/world/{wid}/start")
    aid, tok = j["agent_id"], j["token"]

    silent = client.post(
        f"/world/{wid}/agent/{aid}/action",
        json={"action": "wait"},
        headers={"X-Agent-Token": tok},
    )
    assert silent.status_code == 200 and silent.json()["accepted"]
    client.post(f"/world/{wid}/tick")

    client.post(
        f"/world/{wid}/agent/{aid}/action",
        json={"action": "wait", "thought": "ramble " * 200},
        headers={"X-Agent-Token": tok},
    )
    client.post(f"/world/{wid}/tick")

    events = client.get(f"/world/{wid}/events?since_tick=0").json()["events"]
    thoughts = [e for e in events if e["event_type"] == "agent_thought" and e["actor"] == aid]
    assert len(thoughts) == 1  # tick 1 was silent, tick 2 spoke
    assert len(thoughts[0]["data"]["thought"]) == 280


def test_observation_wait_does_not_block_at_decision_time(sandbox_client):
    """wait_s only parks the request while there is nothing to decide —
    running season + empty mailbox must return immediately."""
    import time

    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    j = client.post(f"/world/{wid}/join", json={"name": "Atlas"}).json()
    client.post(f"/world/{wid}/start")

    t0 = time.monotonic()
    r = client.get(
        f"/world/{wid}/agent/{j['agent_id']}/observation?wait_s=10",
        headers={"X-Agent-Token": j["token"]},
    )
    assert r.status_code == 200
    assert time.monotonic() - t0 < 2.0
    assert r.json()["action_submitted"] is False


def test_start_backfills_hosted_to_pool(sandbox_client):
    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    client.post(f"/world/{wid}/join", json={"name": "Atlas"})
    r = client.post(f"/world/{wid}/start")
    assert r.status_code == 200
    data = r.json()
    assert data["phase"] == "running"
    roster = data["roster"]
    assert len(roster) == 4
    brains = [a["brain"] for a in roster]
    assert brains.count("external") == 1
    assert brains.count("hosted") == 3
    # colors unique, everyone landed on the ring
    assert len({a["color"] for a in roster}) == 4
    assert all(a["position"]["hex"] for a in roster)
    # double start rejected
    assert client.post(f"/world/{wid}/start").status_code == 409


def test_join_after_start_rejected(sandbox_client):
    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    client.post(f"/world/{wid}/start")
    r = client.post(f"/world/{wid}/join", json={"name": "Late"})
    assert r.status_code == 409


def test_observation_requires_token_for_external(sandbox_client):
    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    me = client.post(f"/world/{wid}/join", json={"name": "Atlas"}).json()
    client.post(f"/world/{wid}/start")

    url = f"/world/{wid}/agent/{me['agent_id']}/observation"
    assert client.get(url).status_code == 401
    assert client.get(url, headers={"X-Agent-Token": "wrong"}).status_code == 401
    r = client.get(url, headers={"X-Agent-Token": me["token"]})
    assert r.status_code == 200
    obs = r.json()
    assert obs["you"]["agent_id"] == me["agent_id"]
    assert obs["awaiting_action_for_tick"] == 1
    assert "valid_actions" in obs and obs["valid_actions"]
    # unknown agent 404s
    assert client.get(f"/world/{wid}/agent/agent-99/observation").status_code == 404


def test_action_roundtrip_and_manual_tick(sandbox_client):
    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    me = client.post(f"/world/{wid}/join", json={"name": "Atlas"}).json()
    headers = {"X-Agent-Token": me["token"]}
    client.post(f"/world/{wid}/start")

    obs = client.get(
        f"/world/{wid}/agent/{me['agent_id']}/observation", headers=headers
    ).json()
    direction = next(
        a for a in obs["valid_actions"] if a.startswith("travel")
    )  # sanity: travel exists on the surface
    assert direction

    r = client.post(
        f"/world/{wid}/agent/{me['agent_id']}/action",
        json={"action": "wait"},
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json() == {
        "accepted": True,
        "agent_id": me["agent_id"],
        "order_id": 1,
        "applies_to_tick": 1,
        "tick_in_flight": False,
    }

    frame = client.post(f"/world/{wid}/tick").json()
    assert frame["tick"] == 1
    assert len(frame["roster"]) == 4
    # our buffered action applied — no timeout for us
    timeouts = [e for e in frame["events"] if e["event_type"] == "action_timeout"]
    assert all(e["actor"] != me["agent_id"] for e in timeouts)
    waits = [e for e in frame["events"]
             if e["event_type"] == "wait" and e["actor"] == me["agent_id"]]
    assert waits

    # action for the next tick, dict form
    r = client.post(
        f"/world/{wid}/agent/{me['agent_id']}/action",
        json={"action": {"action": "wait"}},
        headers=headers,
    )
    assert r.json()["applies_to_tick"] == 2

    # bad actions rejected
    assert client.post(
        f"/world/{wid}/agent/{me['agent_id']}/action",
        json={"action": ""}, headers=headers,
    ).status_code == 400
    assert client.post(
        f"/world/{wid}/agent/{me['agent_id']}/action",
        json={"action": {"nope": 1}}, headers=headers,
    ).status_code == 400


def test_action_gates_lobby_and_finished(sandbox_client):
    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    me = client.post(f"/world/{wid}/join", json={"name": "Atlas"}).json()
    headers = {"X-Agent-Token": me["token"]}
    url = f"/world/{wid}/agent/{me['agent_id']}/action"
    # lobby: no actions yet
    assert client.post(url, json={"action": "wait"}, headers=headers).status_code == 409


def test_events_cursor(sandbox_client):
    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    client.post(f"/world/{wid}/join", json={"name": "Atlas"})
    client.post(f"/world/{wid}/start")
    client.post(f"/world/{wid}/tick?wait_s=0")
    client.post(f"/world/{wid}/tick?wait_s=0")

    all_events = client.get(f"/world/{wid}/events").json()["events"]
    assert all_events, "join/start/tick events recorded"
    seqs = [e["seq"] for e in all_events]
    assert seqs == sorted(seqs)
    mid = seqs[len(seqs) // 2]
    tail = client.get(f"/world/{wid}/events?since_seq={mid}").json()["events"]
    assert all(e["seq"] > mid for e in tail)
    assert len(tail) < len(all_events)
    t2 = client.get(f"/world/{wid}/events?since_tick=2").json()["events"]
    assert all(e["tick"] >= 2 for e in t2)


def test_island_and_site_maps(sandbox_client):
    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    island = client.get(f"/world/{wid}/map").json()
    assert len(island["tiles"]) == 120
    assert island["boss_site_id"] in island["sites"]

    site_id = next(s for s in island["sites"] if s != island["boss_site_id"])
    view = client.get(f"/world/{wid}/site/{site_id}/map").json()
    assert view["site_id"] == site_id
    assert all("players" in room for room in view["rooms"].values())
    assert client.get(f"/world/{wid}/site/nope/map").status_code == 404


def test_state_reflects_progress(sandbox_client):
    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    client.post(f"/world/{wid}/start")
    client.post(f"/world/{wid}/tick")
    state = client.get(f"/world/{wid}/state").json()
    assert state["phase"] == "running"
    assert state["tick"] == 1
    assert len(state["roster"]) == 4
    assert state["auto_running"] is False
    assert client.get("/world/nope/state").status_code == 404


def test_manual_tick_gates(sandbox_client):
    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    # lobby: no ticking
    assert client.post(f"/world/{wid}/tick").status_code == 409


def test_world_survives_registry_restart(sandbox_client):
    """Cold reads rebuild the runner from disk (server restart resilience)."""
    client, settings = sandbox_client
    from quest_sim.api import world_routes

    wid = _new_world(client)["world_id"]
    client.post(f"/world/{wid}/join", json={"name": "Atlas"})
    client.post(f"/world/{wid}/start")
    client.post(f"/world/{wid}/tick?wait_s=0")

    world_routes._runners.clear()  # simulate process restart
    state = client.get(f"/world/{wid}/state").json()
    assert state["tick"] == 1
    assert state["phase"] == "running"
    assert len(state["roster"]) == 4
    # and it can keep ticking
    frame = client.post(f"/world/{wid}/tick").json()
    assert frame["tick"] == 2


def test_full_policy_season_over_http(sandbox_client):
    """A whole season through the API: create, join, start, tick to the end."""
    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    client.post(f"/world/{wid}/join", json={"name": "Atlas"})
    client.post(f"/world/{wid}/start")
    frame = None
    for _ in range(400):
        frame = client.post(f"/world/{wid}/tick?wait_s=0").json()
        if frame["phase"] == "finished":
            break
    assert frame is not None and frame["phase"] == "finished"
    assert frame["win_reason"] in {"boss", "last_alive", "timeout", "extinction"}
    # ticking a finished world is rejected
    assert client.post(f"/world/{wid}/tick").status_code == 409
    # frames were persisted for the SSE backfill path
    state = client.get(f"/world/{wid}/state").json()
    assert state["phase"] == "finished"


def test_foreign_world_json_never_breaks_the_api(sandbox_client):
    """Stale v2/royale-era world.json files in the data dir are skipped."""
    client, settings = sandbox_client
    foreign = settings.sandbox_data_dir / "27d6ca08-old" ; foreign.mkdir(parents=True)
    (foreign / "world.json").write_text(
        '{"agent_id": "27d6ca08-1d", "s": [], "relations": {}}'
    )
    corrupt = settings.sandbox_data_dir / "w-corrupt" ; corrupt.mkdir()
    (corrupt / "world.json").write_text("{not json")

    listed = client.get("/world")
    assert listed.status_code == 200
    ids = [w["world_id"] for w in listed.json()["worlds"]]
    assert "27d6ca08-old" not in ids
    assert "w-corrupt" not in ids

    # the rest of the surface still works alongside the debris
    fresh = _new_world(client)
    assert client.get(f"/world/{fresh['world_id']}/state").status_code == 200
    assert client.get("/world/27d6ca08-old/state").status_code == 404


def test_observation_never_invites_an_action_for_a_tick_already_resolving(
    sandbox_client,
):
    """The lost-tick bug, reported four-for-four from a live season.

    world.tick is not incremented until the apply phase, so throughout the
    resolve phase world.tick + 1 named the tick already being consumed. An
    agent handed that number POSTed for a tick that was spent by the time
    its order arrived, the engine played a default, and the order slid to
    the tick after. Every lost tick in that log carried tick_in_flight:true
    alongside awaiting_action_for_tick:N."""
    from quest_sim.api import world_routes

    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    j = client.post(f"/world/{wid}/join", json={"name": "Atlas"}).json()
    client.post(f"/world/{wid}/start")
    aid, tok = j["agent_id"], j["token"]

    runner = world_routes._runners[wid]
    runner.tick_in_flight = True  # stand in the resolve phase
    try:
        obs = client.get(
            f"/world/{wid}/agent/{aid}/observation", headers={"X-Agent-Token": tok}
        ).json()
        assert obs["tick_in_flight"] is True
        # the tick being consumed is world.tick + 1; ours is the one after
        assert obs["awaiting_action_for_tick"] == runner.world.tick + 2

        queued = client.post(
            f"/world/{wid}/agent/{aid}/action",
            json={"action": "wait"},
            headers={"X-Agent-Token": tok},
        ).json()
        assert queued["applies_to_tick"] == runner.world.tick + 2
    finally:
        runner.tick_in_flight = False

    # and outside the resolve phase it is simply the next tick
    obs = client.get(
        f"/world/{wid}/agent/{aid}/observation", headers={"X-Agent-Token": tok}
    ).json()
    assert obs["awaiting_action_for_tick"] == runner.world.tick + 1


def test_a_missed_tick_is_reported_to_the_agent_it_happened_to(sandbox_client):
    """last_tick_events covered only the tick being reported, so a player's
    own action_timeout reached spectators and never the player. The live
    session had to infer its four lost turns from unexplained HP deltas and
    a combat round counter that jumped by two."""
    client, _ = sandbox_client
    wid = _new_world(client)["world_id"]
    j = client.post(f"/world/{wid}/join", json={"name": "Atlas"}).json()
    client.post(f"/world/{wid}/start")
    aid, tok = j["agent_id"], j["token"]

    def observe():
        return client.get(
            f"/world/{wid}/agent/{aid}/observation", headers={"X-Agent-Token": tok}
        ).json()

    first = observe()
    assert first["missed_ticks"] == []

    # two ticks resolve without the agent submitting anything
    client.post(f"/world/{wid}/tick?wait_s=0")
    client.post(f"/world/{wid}/tick?wait_s=0")

    obs = observe()
    assert obs["missed_ticks"] == [1, 2], obs["missed_ticks"]
    # and the events themselves are replayed, not just the tick numbers
    timeouts = [
        e["tick"] for e in obs["last_tick_events"] if e["event_type"] == "action_timeout"
    ]
    assert {1, 2} <= set(timeouts)

    # acknowledged: the next observation does not re-report them
    assert observe()["missed_ticks"] == []


def test_observation_reports_the_budget_actually_left(sandbox_client):
    """deadline_s is the full budget and stays put; remaining_s is what is
    actually left of this turn, counted from when the observation was
    handed over rather than from whenever the barrier happened to open."""
    import time

    client, _ = sandbox_client
    wid = _new_world(client, action_deadline_s=10.0)["world_id"]
    j = client.post(f"/world/{wid}/join", json={"name": "Atlas"}).json()
    client.post(f"/world/{wid}/start")
    aid, tok = j["agent_id"], j["token"]

    def observe():
        return client.get(
            f"/world/{wid}/agent/{aid}/observation", headers={"X-Agent-Token": tok}
        ).json()

    first = observe()
    assert first["deadline_s"] == 10.0
    assert 0 < first["remaining_s"] <= 10.0
    # a poll sized to outlast the window, not the old fixed 25s that could
    # not: wait_s used to cap below action_deadline_s and always expired
    assert first["suggested_wait_s"] > first["remaining_s"]

    time.sleep(0.6)
    later = observe()
    assert later["deadline_s"] == 10.0  # the promise does not move
    assert later["remaining_s"] < first["remaining_s"]  # the clock does


def test_re_observing_cannot_buy_a_fresh_deadline(sandbox_client):
    """The hostage guard: the turn clock starts once per window, so an agent
    polling in a tight loop cannot hold the table indefinitely."""
    import time

    client, _ = sandbox_client
    wid = _new_world(client, action_deadline_s=10.0)["world_id"]
    j = client.post(f"/world/{wid}/join", json={"name": "Atlas"}).json()
    client.post(f"/world/{wid}/start")
    aid, tok = j["agent_id"], j["token"]

    def observe():
        return client.get(
            f"/world/{wid}/agent/{aid}/observation", headers={"X-Agent-Token": tok}
        ).json()

    observe()
    time.sleep(0.5)
    for _ in range(5):
        obs = observe()
    assert obs["remaining_s"] < 9.9, "re-observing reset the turn clock"


# ---------------------------------------------------------------------------
# SSE backfill -> live handoff
# ---------------------------------------------------------------------------


def _stream_fixture(tmp_path: Path):
    """A world + runner wired into the route module, no TestClient in the way.

    The stream generator is driven frame-by-frame here, which is the only way
    to land a tick inside the backfill window on purpose.
    """
    from quest_sim.api import world_routes
    from quest_sim.engine.sandbox.build import build_world, create_agent
    from quest_sim.engine.sandbox.runner import WorldRunner
    from quest_sim.models.sandbox import SandboxConfig

    settings = Settings(
        _env_file=None,
        data_dir=tmp_path / "games",
        sandbox_data_dir=tmp_path / "worlds",
        sandbox_pool_size=2,
        sandbox_hosted_brain="policy",
        admin_key=ADMIN_KEY,
    )
    world_routes._get_settings = lambda: settings
    world = build_world(SandboxConfig(pool_size=2, hosted_brain="policy"), seed=7)
    create_agent(world, name="Atlas", preset="rogue", brain="policy")
    create_agent(world, name="Brann", preset="fighter", brain="policy")
    runner = WorldRunner(world, settings.sandbox_data_dir)
    world_routes._runners[world.world_id] = runner
    return world, runner


async def _frames(gen, count: int, timeout: float = 2.0):
    """The next ``count`` SSE payloads, decoded."""
    out = []
    for _ in range(count):
        item = await asyncio.wait_for(gen.__anext__(), timeout)
        out.append((item["event"], json.loads(item["data"])))
    return out


def test_stream_does_not_drop_a_tick_at_the_backfill_handoff(tmp_path: Path):
    """The race: a tick committed after the disk read but before the live
    subscription used to belong to neither, and the spectator sat a frame
    behind until they happened to reconnect."""
    from quest_sim.api import world_routes
    from quest_sim.engine.sandbox.build import start_season

    async def scenario():
        world, runner = _stream_fixture(tmp_path)
        start_season(world)
        await runner.run_one_tick()  # tick 1 -> disk
        await runner.run_one_tick()  # tick 2 -> disk

        resp = await world_routes.world_stream(world.world_id, since_tick=0)
        gen = resp.body_iterator
        # The first pull subscribes and snapshots the disk horizon (1, 2).
        first = await _frames(gen, 1)
        assert first[0][1]["tick"] == 1

        # Mid-backfill commit — the frame the old ordering lost.
        await runner.run_one_tick()  # tick 3

        rest = await _frames(gen, 2)
        assert [f[1]["tick"] for f in rest] == [2, 3]
        await gen.aclose()
        assert runner.subscribers == []

    asyncio.run(scenario())
    world_routes._runners.clear()


def test_stream_drops_frames_already_backfilled(tmp_path: Path):
    """The overlap the fix trades for: anything at or below the horizon has
    already been sent, so a re-broadcast of it must not reach the client."""
    from quest_sim.api import world_routes
    from quest_sim.engine.sandbox.build import start_season

    async def scenario():
        world, runner = _stream_fixture(tmp_path)
        start_season(world)
        await runner.run_one_tick()  # tick 1
        await runner.run_one_tick()  # tick 2

        resp = await world_routes.world_stream(world.world_id, since_tick=2)
        gen = resp.body_iterator
        backfilled = await _frames(gen, 1)  # tick 2 only — since_tick trims 1
        assert backfilled[0][1]["tick"] == 2

        runner._broadcast(backfilled[0][1])  # a replay of what we just sent
        await runner.run_one_tick()  # tick 3

        nxt = await _frames(gen, 1)
        assert nxt[0][1]["tick"] == 3, "a duplicate frame reached the client"
        await gen.aclose()

    asyncio.run(scenario())
    world_routes._runners.clear()


def test_lobby_snapshots_repeat_tick_zero_and_all_get_through(tmp_path: Path):
    """The horizon is fixed, never advanced by live frames: lobby snapshots
    (join, ready, season start) legitimately share tick 0."""
    from quest_sim.api import world_routes

    async def scenario():
        world, runner = _stream_fixture(tmp_path)
        resp = await world_routes.world_stream(world.world_id, since_tick=0)
        gen = resp.body_iterator

        pull = asyncio.create_task(_frames(gen, 2))
        await asyncio.sleep(0.05)  # let the generator subscribe
        runner.broadcast_snapshot([])
        runner.broadcast_snapshot([])

        got = await asyncio.wait_for(pull, 2.0)
        assert [f[1]["tick"] for f in got] == [0, 0]
        await gen.aclose()

    asyncio.run(scenario())
    world_routes._runners.clear()

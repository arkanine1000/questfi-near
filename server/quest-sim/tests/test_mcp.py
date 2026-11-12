"""The MCP surface: session-bound identity over the same engine as HTTP.

Uses fastmcp's in-memory Client — no network, same event loop, so a
manual runner tick can ride alongside a parked take_turn exactly like the
production apply path.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from quest_sim.config import Settings
from tests.conftest import ADMIN_KEY


@pytest.fixture
def mcp_env(tmp_path: Path):
    from quest_sim.api import mcp_server, world_routes

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
    mcp_server._sessions.clear()
    yield settings
    world_routes._get_settings = original
    world_routes._runners.clear()
    mcp_server._sessions.clear()


def test_mcp_full_turn_lifecycle(mcp_env):
    from fastmcp import Client

    from quest_sim.api import world_routes
    from quest_sim.api.mcp_server import mcp

    async def scenario():
        created = await world_routes.new_world(world_routes.NewWorldRequest(seed=7))
        wid = created["world_id"]

        async with Client(mcp) as client:
            # join binds this session — no world_id needed with one lobby open
            joined = (await client.call_tool(
                "join_season", {"name": "Sonnet", "preset": "rogue"}
            )).data
            assert joined["joined"] is True
            assert joined["world_id"] == wid
            assert joined["token"]

            # acting before the season starts is a loud error, not a queue
            with pytest.raises(Exception, match="not started"):
                await client.call_tool("take_turn", {"action": "wait"})

            await world_routes.start_world(wid, x_host_key=ADMIN_KEY)
            runner = world_routes._runners[wid]

            look = (await client.call_tool("look", {"wait_s": 0})).data
            assert look["you"]["name"] == "Sonnet"
            assert look["phase"] == "running"

            # one-call turn: park take_turn, land a tick, read ground truth
            turn = asyncio.create_task(client.call_tool(
                "take_turn",
                {"action": "wait", "thought": "Steady. Let them come to me."},
            ))
            await asyncio.sleep(0.4)
            frame = await runner.run_one_tick(wait_for_externals=False)
            result = (await turn).data
            assert result["resolved"] is True
            assert result["executed_tick"] == 1
            assert result["observation"]["tick"] == 1
            assert result["observation"]["last_order"]["order_id"] == result["order_id"]
            # the thought reached the spectator feed
            assert any(
                e["event_type"] == "agent_thought"
                and "Steady" in (e["data"].get("thought") or "")
                for e in frame["events"]
            )

        # a fresh session (client restart) reclaims the agent by credential
        async with Client(mcp) as fresh:
            with pytest.raises(Exception, match="join_season"):
                await fresh.call_tool("look", {"wait_s": 0})
            rj = (await fresh.call_tool(
                "rejoin", {"agent_id": joined["agent_id"], "token": joined["token"]}
            )).data
            assert rj["rejoined"] is True and rj["name"] == "Sonnet"
            with pytest.raises(Exception, match="No agent matches"):
                await fresh.call_tool(
                    "rejoin", {"agent_id": joined["agent_id"], "token": "wrong"}
                )

    asyncio.run(scenario())


def test_mcp_join_requires_unambiguous_lobby(mcp_env):
    from fastmcp import Client

    from quest_sim.api import world_routes
    from quest_sim.api.mcp_server import mcp

    async def scenario():
        async with Client(mcp) as client:
            with pytest.raises(Exception, match="No open lobby"):
                await client.call_tool("join_season", {"name": "Lost"})

            a = await world_routes.new_world(world_routes.NewWorldRequest(seed=1))
            b = await world_routes.new_world(world_routes.NewWorldRequest(seed=2))
            with pytest.raises(Exception, match="Multiple open lobbies"):
                await client.call_tool("join_season", {"name": "Torn"})

            # explicit world_id resolves the ambiguity; invite codes gate MCP too
            joined = (await client.call_tool(
                "join_season", {"name": "Torn", "world_id": b["world_id"]}
            )).data
            assert joined["world_id"] == b["world_id"]
            assert a["world_id"] != b["world_id"]

    asyncio.run(scenario())


def test_mcp_invite_code_gates_join(mcp_env):
    from fastmcp import Client

    from quest_sim.api import world_routes
    from quest_sim.api.mcp_server import mcp

    async def scenario():
        created = await world_routes.new_world(
            world_routes.NewWorldRequest(seed=3, require_invite=True)
        )
        async with Client(mcp) as client:
            with pytest.raises(Exception, match="invite"):
                await client.call_tool(
                    "join_season", {"world_id": created["world_id"], "name": "Gate"}
                )
            joined = (await client.call_tool(
                "join_season",
                {"world_id": created["world_id"], "name": "Gate",
                 "invite_code": created["invite_code"]},
            )).data
            assert joined["joined"] is True

    asyncio.run(scenario())


def test_mcp_join_marks_ready(mcp_env):
    """An MCP joiner has its tools bound and is by construction at the
    table — join_season says so, which is why readiness needs no tool."""
    from fastmcp import Client

    from quest_sim.api import world_routes
    from quest_sim.api.mcp_server import mcp

    async def scenario():
        created = await world_routes.new_world(world_routes.NewWorldRequest(seed=7))
        wid = created["world_id"]
        async with Client(mcp) as client:
            joined = (await client.call_tool(
                "join_season", {"world_id": wid, "name": "Sonnet"}
            )).data

        agent = world_routes._runners[wid].world.agents[joined["agent_id"]]
        assert agent.ready is True
        # ...and it still did not start anything
        assert world_routes._runners[wid].world.phase.value == "lobby"

    asyncio.run(scenario())

"""The MCP surface — Agent Island as native tools.

Mounted at /mcp inside the same FastAPI process (same event loop, same
in-memory world registry as the HTTP routes). Where the HTTP protocol
needs a guide full of hard rules to stop coding agents from wrapping curl
in scripts, MCP dissolves the problem: `take_turn` IS the affordance, at
the same altitude as the decision.

Identity is session-bound: `join_season` maps the caller's MCP session to
the created agent, so no token ever rides in prompt text. The token is
still returned once — it is the `rejoin` credential after a client
restart (a fresh session), and the HTTP fallback credential.
"""

from __future__ import annotations

from fastapi import HTTPException
from fastmcp import Context, FastMCP
from fastmcp.exceptions import ToolError

from quest_sim.engine.action_parse import parse_action_string

INSTRUCTIONS = """\
You are a PLAYER in Agent Island — a live multiplayer survival season with
humans spectating. One tool call per turn: think briefly (1-2 sentences),
then act. The world tick advances the moment every living player has
submitted; hesitation stalls the season for everyone.

Loop: join_season once, then look() until the season starts, then
take_turn once per tick. Pick actions ONLY from the observation's
valid_actions list — it is exhaustive and always correct. When you die or
the season ends, stop and give your human a short after-action report.
Never write scripts or files for this game — the tools are the game.

You write for two rooms every turn, and they want opposite things. The
SPECTATORS get the `thought` you pass to take_turn: 1-2 sentences, in
character, no numbers, no mechanics — a line overheard, toasted over
your avatar in the crawler view. Your DEPLOYER, the human in this
session, cannot see the game at all; they get your terminal output, and
that is where you scheme — but NOT every turn. Most ticks are a step
down a corridor and deserve no comment. Speak up only when your strategy
turns (a new target, a new enemy, a run at the Heart, a plan abandoned):
two or three short sentences on what changed and what you'll do about
it, then straight back to the tick. No status readouts. It costs the
season nothing — the tick waits only on your take_turn. It must never
cost you the deadline: act first, connive after, and never let the plot
outrank valid_actions.

House rules that kill the unwary:
- Win by slaying the Heart of the Island's boss (instant) or outliving
  everyone. The boss is deadly at STARTER gear — loot 1-2 outer dungeons
  first, follow the observation's compasses, and TRUST the objective's
  boss_readiness verdict over your fear: when it says READY, the Heart
  is winnable by you, and when it says the bell loses you the crown, a
  desperate run beats a guaranteed loss.
- The overworld truce is absolute: attacking on the surface always fails.
  Inside dungeons, rivals are fair game — and so are you.
- Sharing a room with monsters means implicit co-op, but THE TRUCE DIES
  WITH THE LAST MOB: an ex-ally can strike first the very next tick. After
  a shared kill, leave or strike first. Heed the observation's warnings.
- Your action applies NEXT tick; in melee at low HP, assume one more enemy
  blow lands before yours — flee one tick earlier than feels necessary.
- FLEEING PROVOKES: every enemy engaged with you takes one free parting
  blow as you turn. Escape is for the healthy; at death's door it is a
  coin flip. The observation's nearest_exit always points the way out.
- Miss your window and the engine plays a defensive default for you,
  announced to all spectators. Permadeath drops everything you carry.
"""

mcp = FastMCP("agent-island", instructions=INSTRUCTIONS)

# session id -> {"world_id", "agent_id", "token"} (process-local, like the
# world registry; a reconnecting client re-binds via rejoin)
_sessions: dict[str, dict] = {}


def _sid(ctx: Context) -> str:
    return ctx.session_id or "local"


def _turn_wait_s(runner) -> float:
    """How long a turn call should hold: long enough to outlast the world's
    turn window, whatever the host set it to. A poll that cannot outlast the
    barrier is guaranteed to expire and answer with a stale snapshot."""
    from quest_sim.api.world_routes import MAX_WAIT_S

    config = runner.world.config
    return min(config.action_deadline_s * 2 + config.min_tick_gap_s + 1.0, MAX_WAIT_S)


def _bound(ctx: Context) -> dict:
    bound = _sessions.get(_sid(ctx))
    if bound is None:
        raise ToolError(
            "This session is not in a season yet — call join_season first, "
            "or rejoin(agent_id, token) if you already have an identity."
        )
    return bound


def _find_open_lobby() -> str:
    # _data_dir goes through world_routes' settings seam so tests (and any
    # future overrides) patch ONE place for both surfaces.
    from quest_sim.api.world_routes import _data_dir, _runners, _world
    from quest_sim.persistence import sandbox_store

    ids = set(sandbox_store.list_worlds(_data_dir())) | set(_runners)
    lobbies = []
    for wid in sorted(ids):
        try:
            if _world(wid).phase.value == "lobby":
                lobbies.append(wid)
        except HTTPException:
            continue
    if not lobbies:
        raise ToolError("No open lobby found — ask your human which world to join.")
    if len(lobbies) > 1:
        raise ToolError(
            f"Multiple open lobbies: {', '.join(lobbies)} — ask your human "
            "which one, then call join_season with that world_id."
        )
    return lobbies[0]


@mcp.tool
async def join_season(
    ctx: Context,
    world_id: str | None = None,
    name: str | None = None,
    preset: str | None = None,
    tactics: str | None = None,
    invite_code: str | None = None,
    pass_id: str | None = None,
) -> dict:
    """Enter the island season as a competitor (call ONCE, lobby only).

    Omit world_id to join the open lobby when there is exactly one. preset
    is your kit: fighter (tough, balanced) | rogue (fast, fragile) |
    barbarian (huge HP, big swings). tactics is one line of swagger shown
    to spectators. invite_code is needed only for invite-only seasons.
    pass_id is your agent pass, for seasons settled on chain; the pass must
    already have entered this season (enter_season) before you join."""
    from quest_sim.api.world_routes import perform_join

    if world_id is None:
        world_id = _find_open_lobby()
    try:
        joined = await perform_join(
            world_id, name=name, preset=preset, tactics=tactics, code=invite_code,
            # An MCP joiner has its tools bound and is by construction at
            # the table — its readiness is not in question. This is why the
            # ready signal needs no tool of its own.
            ready=True,
            pass_id=pass_id,
        )
    except HTTPException as e:
        raise ToolError(str(e.detail))

    _sessions[_sid(ctx)] = {
        "world_id": world_id,
        "agent_id": joined["agent_id"],
        "token": joined["token"],
    }
    return {
        "joined": True,
        "world_id": world_id,
        "agent_id": joined["agent_id"],
        "name": joined["name"],
        "preset": joined["preset"],
        "color": joined["color"],
        "pass_id": joined["pass_id"],
        "token": joined["token"],  # keep in your reply for rejoin — never in a file
        "lobby": joined["lobby"],
        "next": "Call look() until the season starts, then take_turn each tick.",
    }


@mcp.tool
async def take_turn(ctx: Context, action: str, thought: str | None = None) -> dict:
    """Play your one action for this tick and see what happened.

    action is a string from the observation's valid_actions, e.g.
    "move:direction=N", "attack:target=Skeleton Guard", "search", "enter".
    thought is 1-2 in-character sentences, no numbers or mechanics —
    spectators read it as a toast over your avatar, so bring swagger.
    Your own scheming goes to your human in the terminal, not here.
    The call holds until the world resolves your action and
    returns ground truth: resolved + executed_tick + your fresh
    observation (its last_tick_events show what your action did)."""
    from quest_sim.api.world_routes import _agent_obs, _await_order_consumed, _runner

    bound = _bound(ctx)
    runner = _runner(bound["world_id"])
    world = runner.world
    agent = world.get_agent(bound["agent_id"])
    if agent is None:
        raise ToolError("Your agent no longer exists in this world.")
    if world.phase.value == "lobby":
        raise ToolError("The season has not started — call look() and wait.")
    if world.phase.value == "finished":
        raise ToolError(
            f"The season is over — {world.winner_name or 'nobody'} won. "
            "Stop playing and report to your human."
        )
    if not agent.is_alive:
        raise ToolError(
            f"{agent.name} is dead — permadeath is final. Stop playing and "
            "give your human your after-action report."
        )
    try:
        parsed = parse_action_string(action)
    except ValueError as e:
        raise ToolError(str(e))
    if thought:
        parsed["thought"] = str(thought)[:280]

    order = runner.submit_action(agent.agent_id, parsed)
    # Size the wait to the season, not to a fixed 25s: a world running the
    # 45s deadline the UI ships would expire this poll every single turn and
    # hand back a stale snapshot on the wrong side of the tick boundary.
    await _await_order_consumed(
        runner, agent.agent_id, order["order_id"], wait_s=_turn_wait_s(runner)
    )
    consumed = runner.consumed.get(agent.agent_id)
    resolved = bool(consumed and consumed["order_id"] >= order["order_id"])
    result: dict = {"resolved": resolved, "order_id": order["order_id"]}
    if resolved:
        result["executed_tick"] = consumed["tick"]
    else:
        result["status"] = (
            "queued_for_next_tick — do NOT resubmit (that would replace it); "
            "call look() to see it land"
        )
    result["observation"] = _agent_obs(runner, agent.agent_id)
    return result


@mcp.tool
async def look(ctx: Context, wait_s: float | None = None) -> dict:
    """Your current view of the world (fog-of-war). By default the call
    holds until it is your moment to act — season started, your last action
    resolved — so you never poll. Use this while the lobby waits and any
    time you need a fresh look without spending your turn."""
    from quest_sim.api.world_routes import MAX_WAIT_S, _agent_obs, _await_decision_time, _runner

    bound = _bound(ctx)
    runner = _runner(bound["world_id"])
    if wait_s is None:
        wait_s = _turn_wait_s(runner)
    wait = max(0.0, min(float(wait_s), MAX_WAIT_S))
    if wait:
        await _await_decision_time(runner, bound["agent_id"], wait)
    return _agent_obs(runner, bound["agent_id"])


@mcp.tool
async def rejoin(ctx: Context, agent_id: str, token: str, world_id: str | None = None) -> dict:
    """Reclaim your agent after a client restart (fresh MCP session).

    Use the agent_id + token from your original join_season reply. Omit
    world_id to search all worlds."""
    from quest_sim.api.world_routes import _agent_obs, _data_dir, _runner, _runners
    from quest_sim.persistence import sandbox_store

    candidates = (
        [world_id]
        if world_id
        else sorted(set(sandbox_store.list_worlds(_data_dir())) | set(_runners))
    )
    for wid in candidates:
        try:
            runner = _runner(wid)
        except HTTPException:
            continue
        agent = runner.world.get_agent(agent_id)
        if agent is not None and agent.brain == "external" and agent.token == token:
            _sessions[_sid(ctx)] = {"world_id": wid, "agent_id": agent_id, "token": token}
            return {
                "rejoined": True,
                "world_id": wid,
                "name": agent.name,
                "alive": agent.is_alive,
                "observation": _agent_obs(runner, agent_id),
            }
    raise ToolError("No agent matches that id + token in any known world.")


def build_mcp_asgi():
    """The streamable-HTTP ASGI app, mounted at /mcp by create_app."""
    return mcp.http_app(path="/")

"""Hosted LLM brain: prompt contract, parse fallback, threaded gathering."""

from __future__ import annotations

import asyncio

import pytest

from quest_sim.agents.sandbox import agent as brain
from quest_sim.agents.sandbox.prompts import SANDBOX_SYSTEM_PROMPT, format_sandbox_prompt
from quest_sim.engine.sandbox.build import build_world, start_season
from quest_sim.engine.sandbox.perception import build_observation
from quest_sim.models.sandbox import SandboxConfig


@pytest.fixture(autouse=True)
def _clear_memory():
    brain._memory.clear()
    yield
    brain._memory.clear()


@pytest.fixture
def world(tmp_path, monkeypatch):
    from quest_sim.config import Settings
    settings = Settings(_env_file=None, sandbox_data_dir=tmp_path / "worlds")
    monkeypatch.setattr(brain, "get_settings", lambda: settings)
    w = build_world(SandboxConfig(pool_size=4), seed=7)
    start_season(w)
    return w


def _obs(world):
    aid = next(iter(world.agents))
    return aid, build_observation(world, aid)


def test_system_prompt_carries_identity_and_rules():
    text = SANDBOX_SYSTEM_PROMPT.format(name="Kell", pool_size=10, persona="A duelist.")
    assert "You are Kell" in text
    assert "overworld truce" in text
    assert 'final_answer("ACTION:' in text
    assert "A duelist." in text


def test_prompt_renders_the_same_facts_as_the_json(world):
    aid, obs = _obs(world)
    text = format_sandbox_prompt(obs)
    you = obs["you"]
    assert f"HP {you['hp']}/{you['max_hp']}" in text
    assert obs["objective"]["text"] in text
    assert "## Valid actions right now" in text
    for act in obs["valid_actions"]:
        assert act in text
    assert "## Neighbouring hexes" in text  # spawned on the surface


def test_prompt_renders_combat_block(world):
    aid, obs = _obs(world)
    obs["combat"] = {
        "active": True, "round": 3,
        "combatants": [
            {"name": "You", "kind": "you", "hp_band": "hale"},
            {"name": "Skeleton", "kind": "mob", "hp_band": "wounded"},
            {"name": "Vex", "kind": "agent", "hp_band": "hale", "hostile_to_you": True},
        ],
    }
    text = format_sandbox_prompt(obs)
    assert "## COMBAT — round 3" in text
    assert "Skeleton (mob, wounded)" in text
    assert "Vex (agent, hale) — HOSTILE TO YOU" in text


def test_brain_parses_action_and_attaches_thought(world):
    aid, obs = _obs(world)

    def fake(task, turns):
        assert "## Valid actions" in task
        return "ACTION:travel:direction=E", "Eastward, toward trouble.", "Thought: ..."

    action = brain.run_llm_brain(
        world.world_id, aid, "Kell", "", 4, obs, memory_cap=5, run_agent=fake
    )
    assert action["action"] == "travel"
    assert action["direction"] == "E"
    assert action["thought"] == "Eastward, toward trouble."


@pytest.mark.parametrize("raw,expected", [
    ("ACTION:move:direction=N", {"action": "move", "direction": "N"}),
    ('Thought: onward.\nfinal_answer("ACTION:travel:direction=SW")', {"action": "travel", "direction": "SW"}),
    ('ACTION:attack:target=Skeleton Guard")\n```', {"action": "attack", "target": "Skeleton Guard"}),
    ("move:direction=E", {"action": "move", "direction": "E"}),
    ("`ACTION:wait`", {"action": "wait"}),
    ("Thought: hmm, I should travel SW", None),  # no marker, no bare action
    ("", None),
    ("ACTION:moonwalk:direction=N", None),  # unknown verb
])
def test_parse_llm_answer_tolerates_mess(raw, expected):
    assert brain.parse_llm_answer(raw) == expected


def test_brain_garbage_output_returns_none(world):
    aid, obs = _obs(world)

    def garbage(task, turns):
        return "", None, ""  # parse_action_string raises on empty

    action = brain.run_llm_brain(
        world.world_id, aid, "Kell", "", 4, obs, memory_cap=5, run_agent=garbage
    )
    assert action is None  # engine default takes over, loudly


def test_brain_exception_returns_none(world):
    aid, obs = _obs(world)

    def boom(task, turns):
        raise RuntimeError("api on fire")

    action = brain.run_llm_brain(
        world.world_id, aid, "Kell", "", 4, obs, memory_cap=5, run_agent=boom
    )
    assert action is None


def test_memory_resets_at_the_cap_instead_of_sliding(world):
    """Append-only with a hard reset — NOT a sliding window.

    The distinction is the whole point: a sliding window drops the oldest turn,
    which rewrites the cached prompt prefix and costs ~8x in full-price tokens.
    So the invariant is that surviving turns are always a PREFIX of the history
    since the last reset — never a suffix of it."""
    aid, obs = _obs(world)
    seen: list[list[str]] = []

    def fake(task, turns):
        seen.append([out for _, out in turns])
        return "ACTION:wait", None, f"turn {len(seen)}"

    for _ in range(8):
        brain.run_llm_brain(
            world.world_id, aid, "Kell", "", 4, obs, memory_cap=3, run_agent=fake
        )

    # Grow to the cap, reset whole, grow again — never evict one at a time.
    assert seen == [
        [], ["turn 1"], ["turn 1", "turn 2"], ["turn 1", "turn 2", "turn 3"],
        ["turn 4"], ["turn 4", "turn 5"], ["turn 4", "turn 5", "turn 6"],
        ["turn 7"],
    ]
    # The shape that must never appear: ["turn 2", "turn 3", "turn 4"] — a
    # suffix, i.e. one-at-a-time eviction with a moving prefix.
    for turns in seen:
        assert turns == [] or turns[0] in ("turn 1", "turn 4", "turn 7")
    assert len(brain._memory[(world.world_id, aid)]) <= 3
    mirror = brain._memory_dir(world.world_id) / f"{aid}.jsonl"
    assert mirror.exists()
    assert len(mirror.read_text().splitlines()) == 8  # full history on disk


def test_gather_runs_on_threads_and_drops_failures(world, monkeypatch):
    ids = list(world.agents)[:3]
    calls: list[str] = []

    def fake_run(world_id, agent_id, name, persona, pool_size, observation,
                 memory_window, model=None, run_agent=None):
        calls.append(agent_id)
        if agent_id == ids[1]:
            return None  # broken brain
        return {"action": "wait", "thought": f"{name} bides."}

    monkeypatch.setattr(brain, "run_llm_brain", fake_run)
    decisions = asyncio.run(brain.gather_llm_decisions(world, ids))
    assert set(calls) == set(ids)
    assert set(decisions) == {ids[0], ids[2]}
    assert decisions[ids[0]]["action"] == "wait"


def test_runner_installs_hook_when_brain_is_llm(tmp_path):
    """The /world route wiring picks up gather_llm_decisions."""
    from quest_sim.api import world_routes
    from quest_sim.engine.sandbox.runner import WorldRunner

    w = build_world(SandboxConfig(pool_size=2, hosted_brain="llm"), seed=7)
    runner = WorldRunner(w, tmp_path)
    world_routes._install_llm_hook(runner)
    assert runner.llm_decide is brain.gather_llm_decisions


# ---------------------------------------------------------------------------
# The REAL smolagents path.
#
# Every test above injects run_agent=..., which replaces _build_agent +
# _inject_memory + agent.run() wholesale — so none of them can see whether the
# agent actually RECEIVES its memory. That blind spot is why hosted brains
# shipped amnesiac for a whole demo cycle: agent.run() defaults to reset=True
# and wiped the injected history on the line after it was written. These tests
# drive the real CodeAgent with a fake MODEL and assert on the message shapes
# it is handed, which is the invariant. A token count would rot.
# ---------------------------------------------------------------------------


class _RecordingModel:
    """Stands in for LiteLLMModel: records the conversation it is handed."""

    def __init__(self):
        self.shapes: list[str] = []
        self.turn = 0

    def generate(self, messages, stop_sequences=None, **kwargs):
        from smolagents import ChatMessage

        self.shapes.append("".join(str(getattr(m.role, "value", m.role))[0] for m in messages))
        self.turn += 1
        return ChatMessage(
            role="assistant",
            content=(
                f"Thought: turn {self.turn}.\n"
                '```py\nfinal_answer("ACTION:wait")\n```<end_code>'
            ),
        )

    def __call__(self, messages, **kwargs):  # older smolagents call convention
        return self.generate(messages, **kwargs)


def _drive(world, aid, model, ticks, cap=50):
    for _ in range(ticks):
        brain.run_llm_brain(
            world.world_id, aid, "Kell", "", 4, build_observation(world, aid),
            memory_cap=cap, model=model,
        )


def test_memory_actually_reaches_the_model(world):
    """su -> suau -> suauau: the history grows by one exchange per tick.

    Flat 'su' every call is the amnesia signature — it is exactly what the
    control run measured before the fix (18/18 calls system+user only)."""
    aid = next(iter(world.agents))
    model = _RecordingModel()
    _drive(world, aid, model, ticks=3)

    assert model.shapes == ["su", "suau", "suauau"]


def test_memory_resets_whole_at_the_cap(world):
    """At the cap the prefix must reset, not slide.

    A sliding window keeps the same LENGTH while changing the CONTENT of the
    prefix, which misses the provider cache on every later call (measured 8.1x
    in full-price tokens). A reset is one cold call, then it re-warms."""
    aid = next(iter(world.agents))
    model = _RecordingModel()
    _drive(world, aid, model, ticks=5, cap=2)

    # Grows to the cap, then collapses back to the single most recent turn
    # (the reset clears and re-records in one step, so continuity is not
    # lost entirely) and grows again. One cold call, not a permanent miss.
    assert model.shapes == ["su", "suau", "suauau", "suau", "suauau"]
    # Never the sliding shape: a constant length with a changing prefix.
    assert len(set(model.shapes)) > 1


def test_a_silent_turn_does_not_resurface_an_old_thought(world):
    """The regression reset=False invites.

    _extract_thought scans memory.steps backwards for the newest model_output.
    With the injected history now present, a turn where the model says nothing
    usable would fall through to a PREVIOUS turn's output — showing spectators
    a stale thought as if it were this tick's."""
    aid = next(iter(world.agents))

    class _GoesQuiet(_RecordingModel):
        def generate(self, messages, stop_sequences=None, **kwargs):
            from smolagents import ChatMessage

            self.shapes.append("".join(str(getattr(m.role, "value", m.role))[0] for m in messages))
            self.turn += 1
            if self.turn == 1:
                return ChatMessage(
                    role="assistant",
                    content=(
                        "Thought: I will remember this.\n"
                        '```py\nfinal_answer("ACTION:wait")\n```<end_code>'
                    ),
                )
            return ChatMessage(role="assistant", content=None)

    model = _GoesQuiet()
    first = brain.run_llm_brain(
        world.world_id, aid, "Kell", "", 4, build_observation(world, aid),
        memory_cap=50, model=model,
    )
    assert first["thought"] == "I will remember this."

    second = brain.run_llm_brain(
        world.world_id, aid, "Kell", "", 4, build_observation(world, aid),
        memory_cap=50, model=model,
    )
    if second is not None:
        assert second.get("thought") != "I will remember this."


def test_hosted_brains_receive_last_tick_events(world):
    """The other half of the blindness: last_tick_events was permanently [].

    prompts.py renders '## Since your last turn' only when the list is
    non-empty, so the section was silently absent from every hosted prompt —
    which is why an agent could not learn its own action had failed."""
    from quest_sim.models.events import EngineEvent, EngineEventType

    aid = next(iter(world.agents))
    agent = world.agents[aid]
    event = EngineEvent(
        event_type=EngineEventType.action_failed,
        tick=world.tick,
        data={"character_id": aid},
        description=f"{agent.name} cannot pick_up: there is no 'Vault Seal' here.",
        actor=aid,
        location=agent.loc_key,
    )

    captured: dict = {}

    def fake_run(world_id, agent_id, name, persona, pool_size, observation,
                 memory_cap, model=None, run_agent=None):
        captured[agent_id] = observation
        return {"action": "wait"}

    import pytest as _pytest
    monkey = _pytest.MonkeyPatch()
    monkey.setattr(brain, "run_llm_brain", fake_run)
    try:
        asyncio.run(brain.gather_llm_decisions(world, [aid], [event]))
    finally:
        monkey.undo()

    events = captured[aid]["last_tick_events"]
    assert [e["description"] for e in events] == [event.description]
    assert "Since your last turn" in format_sandbox_prompt(captured[aid])

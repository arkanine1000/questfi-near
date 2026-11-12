"""Hosted LLM brains: one fresh single-step CodeAgent per decision.

``gather_llm_decisions`` is the runner's hook: it builds observations from
the live world ON the event loop (reads only), then fans the blocking
smolagents/LiteLLM calls out to worker threads with ``asyncio.gather`` —
each thread sees only its snapshot dict and returns a pure action, so no
thread ever touches the world. A broken brain never raises: it returns None
and the engine plays its loud defensive default.

Memory is an append-only run of (prompt, response) turns kept in-process and
mirrored to ``{world_dir}/memory/{agent_id}.jsonl`` for postmortems. It is
replayed into each fresh agent and reset whole at ``sandbox_memory_cap`` —
append-only rather than sliding because the turns ARE the cached prompt
prefix; see ``_remember``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path

from quest_sim.agents.model_factory import create_model
from quest_sim.agents.sandbox.prompts import SANDBOX_SYSTEM_PROMPT, format_sandbox_prompt
from quest_sim.config import get_settings
from quest_sim.engine.action_parse import parse_action_string
from quest_sim.engine.sandbox.perception import build_observation
from quest_sim.models.sandbox import SandboxWorld

logger = logging.getLogger(__name__)

# (world_id, agent_id) -> rolling [(task, output)] window
_memory: dict[tuple[str, str], list[tuple[str, str]]] = {}


def _memory_dir(world_id: str) -> Path:
    return get_settings().sandbox_data_dir / world_id / "memory"


def _remember(world_id: str, agent_id: str, task: str, output: str, cap: int) -> None:
    """Append-only, with a hard reset at the cap — NOT a sliding window.

    The distinction is worth 8x in full-price tokens. Every turn is replayed
    as the prompt prefix, so dropping the oldest turn rewrites that prefix and
    misses the provider's cache on every subsequent call (measured: 93.5% ->
    38.3% hit rate, 46k -> 288k uncached tokens over 30 ticks). Clearing the
    whole window instead costs exactly one cold call, and then it re-warms."""
    key = (world_id, agent_id)
    turns = _memory.setdefault(key, [])
    if cap > 0 and len(turns) >= cap:
        turns.clear()
    turns.append((task, output))
    try:
        mdir = _memory_dir(world_id)
        mdir.mkdir(parents=True, exist_ok=True)
        with (mdir / f"{agent_id}.jsonl").open("a") as f:
            f.write(json.dumps({"t": time.time(), "task": task, "output": output}) + "\n")
    except OSError:  # memory mirroring must never break a season
        logger.warning("could not mirror memory for %s/%s", world_id, agent_id)


def _build_agent(name: str, persona: str, pool_size: int, model):
    from smolagents import CodeAgent

    dummy = CodeAgent(tools=[], model=model)
    templates = dummy.prompt_templates.copy()
    templates["system_prompt"] = SANDBOX_SYSTEM_PROMPT.format(
        name=name, pool_size=pool_size,
        persona=persona or "Pragmatic. Wants the crown. Dislikes dying.",
    )
    return CodeAgent(tools=[], model=model, prompt_templates=templates, max_steps=1)


def _inject_memory(agent, turns: list[tuple[str, str]]) -> None:
    from smolagents import ActionStep, TaskStep
    from smolagents.monitoring import Timing

    for task, output in turns:
        agent.memory.steps.append(TaskStep(task=task, task_images=[]))
        agent.memory.steps.append(
            ActionStep(
                step_number=len(agent.memory.steps),
                timing=Timing(start_time=time.time(), end_time=time.time()),
                model_output=output or None,
                observations_images=[],
            )
        )


# Both readers below take `since` — the step count captured immediately BEFORE
# agent.run(). Under reset=False the injected history is still in memory.steps,
# so an unbounded scan would happily return a PREVIOUS turn's output when this
# turn produced none: a stale thought shown to spectators as if it were this
# tick's, and an old output re-remembered as new. Only steps this run appended
# may be read.
def _extract_thought(agent, since: int = 0) -> str | None:
    from smolagents import ActionStep

    for step in reversed(agent.memory.steps[since:]):
        if isinstance(step, ActionStep) and step.model_output:
            text = step.model_output.strip()
            for marker in ("```py", "```python", "```"):
                idx = text.find(marker)
                if idx != -1:
                    text = text[:idx].strip()
                    break
            if text.lower().startswith("thought:"):
                text = text[len("thought:"):].strip()
            return text or None
    return None


def _last_output(agent, since: int = 0) -> str:
    from smolagents import ActionStep

    for step in reversed(agent.memory.steps[since:]):
        if isinstance(step, ActionStep) and step.model_output:
            return step.model_output
    return ""


_KNOWN_VERBS = {
    "travel", "move", "enter", "exit", "search", "pick_up", "pickup",
    "equip", "equip_weapon", "use_item", "attack", "dodge", "flee", "wait",
}


def parse_llm_answer(raw: str) -> dict | None:
    """Extract one action from a possibly messy LLM answer.

    Tolerates reasoning around the action, an ``ACTION:`` marker anywhere in
    a line, and trailing code-fence/string debris (``")``, backticks). Returns
    None when nothing actionable survives — the engine default takes over.
    """
    if not raw:
        return None
    candidate: str | None = None
    for line in str(raw).splitlines():
        idx = line.find("ACTION:")
        if idx != -1:
            candidate = line[idx:]
            break
    if candidate is None:
        # No marker: accept a bare action string ("move:direction=N") only.
        candidate = str(raw).strip().splitlines()[0] if str(raw).strip() else ""
    candidate = candidate.strip().strip("`").rstrip('")').rstrip("')").strip()
    if not candidate:
        return None
    try:
        action = parse_action_string(candidate)
    except ValueError:
        return None
    if action.get("action") not in _KNOWN_VERBS:
        return None
    return action


def run_llm_brain(
    world_id: str,
    agent_id: str,
    name: str,
    persona: str,
    pool_size: int,
    observation: dict,
    memory_cap: int,
    model=None,
    run_agent=None,
) -> "dict | None":
    """One blocking decision from one snapshot. NEVER raises.

    Returns an action dict (with the spectator ``thought`` riding along) or
    None — the engine then plays the loud defensive default.

    ``run_agent(task, previous_turns) -> (raw_answer, thought, full_output)``
    is injectable for tests; the default builds a real CodeAgent.
    """
    task = format_sandbox_prompt(observation)
    turns = list(_memory.get((world_id, agent_id), []))
    try:
        if run_agent is None:
            agent = _build_agent(name, persona, pool_size, model or create_model())
            _inject_memory(agent, turns)
            # reset=False is load-bearing: CodeAgent.run defaults to reset=True
            # and calls memory.reset() on entry, which threw away everything
            # _inject_memory had just written. Every hosted turn was a cold read
            # of a fogged snapshot — no plan, no grudge, no target held across
            # ticks. The agent is rebuilt per decision, so the seed above is
            # still required; this is what stops run() discarding it.
            since = len(agent.memory.steps)
            raw = str(agent.run(task, reset=False))
            thought = _extract_thought(agent, since)
            output = _last_output(agent, since)
        else:
            raw, thought, output = run_agent(task, turns)

        action = parse_llm_answer(raw)
        _remember(world_id, agent_id, task, output, memory_cap)
        if action is None:
            logger.info("%s produced no parseable action: %r", name, str(raw)[:120])
            return None
        valid = {a.split(":", 1)[0] for a in observation.get("valid_actions", [])}
        if valid and action.get("action") not in valid:
            logger.info("%s chose off-menu action %r", name, action.get("action"))
        if thought:
            action.setdefault("thought", thought)
        return action
    except Exception:
        logger.exception("brain failure for %s (%s)", name, agent_id)
        _remember(world_id, agent_id, task, "(brain error)", memory_cap)
        return None


# Concurrent brain calls per tick. Ten agents fan out fully; a 100+ roster
# queues politely instead of exhausting the thread pool / provider rate
# limits. (Scaling past ~32 wants async litellm instead of threads.)
LLM_CONCURRENCY = 16


async def gather_llm_decisions(
    world: SandboxWorld, agent_ids: list[str], last_events: list | None = None
) -> dict[str, dict]:
    """The runner hook: snapshot observations on the loop, decide on threads.

    ``last_events`` is the previous tick's event log, supplied by the runner
    (which owns the data dir). Without it ``last_tick_events`` came out empty
    for every hosted agent, so the prompt's "Since your last turn" block never
    rendered at all: the hosted half of the roster played blind to the events
    BYO players could see, including the failures caused by their own actions.
    ``build_observation`` still fogs it per agent — nobody sees more than they
    should.
    """
    observations = {
        aid: build_observation(world, aid, last_events=last_events)
        for aid in agent_ids
    }
    pool_size = world.config.pool_size
    # Operator knob, not a per-world field: world.config.memory_window stays
    # the commentator's (genuinely sliding) window.
    cap = get_settings().sandbox_memory_cap
    sem = asyncio.Semaphore(LLM_CONCURRENCY)

    async def one(aid: str):
        agent = world.agents[aid]
        async with sem:
            return aid, await asyncio.to_thread(
                run_llm_brain,
                world.world_id, aid, agent.name, agent.persona, pool_size,
                observations[aid], cap,
            )

    results = await asyncio.gather(*(one(aid) for aid in agent_ids))
    return {aid: action for aid, action in results if action is not None}

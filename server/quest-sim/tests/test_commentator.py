"""Prompt-chan's booth: cadence gate, material handling, runner wiring.

No test here ever touches a model — _complete is patched; the litellm
path is exercised only in production when QUEST_SIM_COMMENTATOR_MODEL is
set.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from quest_sim.agents.sandbox.commentator import Commentator
from quest_sim.engine.sandbox.build import build_world, create_agent, start_season
from quest_sim.engine.sandbox.runner import WorldRunner
from quest_sim.models.sandbox import SandboxConfig


def _booth(tmp_path: Path, **kw) -> Commentator:
    return Commentator("w-test", tmp_path, model="test/model", **kw)


def _frame(*descriptions, event_type="agent_death"):
    return {"events": [
        {"event_type": event_type, "description": d} for d in descriptions
    ]}


def test_cadence_gate(tmp_path):
    booth = _booth(tmp_path, min_gap_ticks=1, max_quiet_ticks=3)

    # never spoken -> she opens immediately (color if nothing pending)
    assert booth.due(1) is True

    booth.last_spoken_tick = 5
    # cooldown: one line per tick minimum
    booth.note_frame(_frame("Kell has fallen to Marra."))
    assert booth.due(5) is False
    # interesting material fires as soon as the cooldown clears
    assert booth.due(6) is True

    # quiet stretch: silent until the liveness bound, then color
    booth.pending.clear()
    assert booth.due(6) is False
    assert booth.due(7) is False
    assert booth.due(8) is True  # 3 ticks without her is the maximum


def test_note_frame_filters_and_caps(tmp_path):
    booth = _booth(tmp_path)
    booth.note_frame(_frame("boring step", event_type="room_enter"))
    assert booth.pending == []
    booth.note_frame(_frame(*[f"death {i}" for i in range(20)]))
    assert len(booth.pending) == 12  # freshest material only
    assert booth.pending[-1] == "death 19"


def test_speak_consumes_material_and_rolls_memory(tmp_path, monkeypatch):
    booth = _booth(tmp_path, memory_window=3)
    world = build_world(SandboxConfig(pool_size=3), seed=7)
    start_season(world)

    lines = iter([f"line {i}" for i in range(6)])
    monkeypatch.setattr(booth, "_complete", lambda digest: next(lines))

    async def run():
        booth.note_frame(_frame("Kell has fallen."))
        text = await booth.speak(world)
        assert text == "line 0"
        assert booth.pending == []  # material spent
        assert booth.last_spoken_tick == world.tick
        for _ in range(5):
            await booth.speak(world)
        assert len(booth.memory) == 3  # same rolling window as the agents

    asyncio.run(run())

    log = tmp_path / "w-test" / "memory" / "prompt-chan.jsonl"
    entries = [json.loads(line) for line in log.read_text().splitlines()]
    assert entries[0]["line"] == "line 0" and len(entries) == 6


def test_failed_call_keeps_material_for_the_retry(tmp_path, monkeypatch):
    """A model hiccup delays a line instead of eating it: pending stays,
    the cadence clock does not advance."""
    booth = _booth(tmp_path)
    world = build_world(SandboxConfig(pool_size=3), seed=7)
    start_season(world)

    def boom(digest):
        raise RuntimeError("model down")

    monkeypatch.setattr(booth, "_complete", boom)

    async def run():
        booth.note_frame(_frame("Kell has fallen."))
        assert await booth.speak(world) is None
        assert booth.pending  # material survives for the retry
        assert booth.last_spoken_tick is None

    asyncio.run(run())


def test_booth_loop_opens_at_tick_zero_without_any_tick(tmp_path, monkeypatch):
    """Her own clock: she speaks the moment the season is running — no
    completed tick required (the old design waited for tick 1)."""
    world = build_world(SandboxConfig(pool_size=3, hosted_brain="policy"), seed=7)
    create_agent(world, name="Ext", preset="rogue", brain="external")
    start_season(world)
    runner = WorldRunner(world, tmp_path)
    booth = Commentator(world.world_id, tmp_path, model="test/model")
    monkeypatch.setattr(booth, "_complete", lambda digest: "WELCOME to the island!")
    runner.commentator = booth

    async def run():
        q = runner.subscribe()
        runner.start_booth()
        await asyncio.sleep(1.0)  # loop polls every 0.7s
        assert world.tick == 0  # no tick ever ran
        payloads = []
        while not q.empty():
            payloads.append(q.get_nowait())
        booths = [p for p in payloads if p.get("kind") == "commentary"]
        assert len(booths) == 1
        assert booths[0]["tick"] == 0
        assert booths[0]["text"] == "WELCOME to the island!"
        runner._booth_task.cancel()

    asyncio.run(run())


def test_booth_loop_signs_off_on_finished_world(tmp_path, monkeypatch):
    world = build_world(SandboxConfig(pool_size=3, hosted_brain="policy"), seed=7)
    start_season(world)
    world.phase = type(world.phase).finished
    world.winner_name = "Kell"
    world.win_reason = "boss"
    runner = WorldRunner(world, tmp_path)
    booth = Commentator(world.world_id, tmp_path, model="test/model")
    booth.last_spoken_tick = world.tick  # cadence would normally block her
    booth.note_frame(_frame("The season ends.", event_type="season_end"))
    monkeypatch.setattr(booth, "_complete", lambda digest: "Your champion: KELL!")
    runner.commentator = booth

    async def run():
        q = runner.subscribe()
        runner.start_booth()  # phase check happens inside the loop
        runner._booth_task = asyncio.get_event_loop().create_task(runner._booth_loop())
        await asyncio.sleep(0.3)
        booths = [q.get_nowait() for _ in range(q.qsize())]
        booths = [p for p in booths if p.get("kind") == "commentary"]
        assert len(booths) == 1 and "KELL" in booths[0]["text"]
        assert runner._booth_task.done()  # sign-off ends the shift

    asyncio.run(run())


def test_roster_card_pinned_with_bios_and_api_signifier(tmp_path, monkeypatch):
    """Stable facts live in the stable prefix: kits, tactics and the
    API-challenger signifier are pinned once, not re-sent through the
    rolling window."""
    from quest_sim.agents.sandbox.commentator import build_roster_card

    world = build_world(SandboxConfig(pool_size=3, hosted_brain="policy"), seed=7)
    create_agent(world, name="Sonnet", preset="rogue", brain="external",
                 persona="Loot fast, betray faster")
    start_season(world)

    card = build_roster_card(world)
    assert "Sonnet (rogue, API challenger" in card
    assert '"Loot fast, betray faster"' in card
    assert "house champion" in card  # the backfilled cast

    booth = _booth(tmp_path)
    monkeypatch.setattr(booth, "_complete", lambda digest: "line")

    async def run():
        await booth.speak(world)
        assert booth.roster_card == card  # built once at first speak

    asyncio.run(run())


def test_polish_and_sentence_finishing():
    from quest_sim.agents.sandbox.commentator import _finish_sentence, _polish

    # token-capped fragments lose the dangling clause, not the whole line
    assert _finish_sentence(
        "Kell cleans his fight without a scratch! Meanwhile Marra dives into the"
    ) == "Kell cleans his fight without a scratch!"
    assert _finish_sentence("K") == "K…"
    assert _finish_sentence("A complete call.") == "A complete call."

    assert _polish('  "Two   fights, one island."  ') == "Two fights, one island."
    long = " ".join(["Hype!"] * 120)
    polished = _polish(long)
    assert len(polished) <= 241 and not polished.endswith(" ")

    # an overlong list with no sentence ends cuts at a comma, never
    # mid-word ("...Dain-san, Marra-…" reached the air once)
    roll_call = ", ".join(["Challenger-san"] * 30)
    polished = _polish(roll_call)
    assert polished.endswith("Challenger-san…")


def test_digest_carries_standings_and_signoff(tmp_path):
    booth = _booth(tmp_path)
    world = build_world(SandboxConfig(pool_size=3), seed=7)
    start_season(world)
    digest = booth._digest(world)
    assert f"Tick {world.tick}" in digest
    assert "Alive 3/3" in digest
    assert "give us color" in digest  # nothing pending -> color prompt

    # geography rides every digest, PRE-TRANSLATED — never raw coordinates
    # (she must speak in bearings and wings, not "hex 10,8")
    import re

    agents = list(world.living_agents())
    standings = digest.splitlines()[0]
    assert "of the Heart" in standings  # spawn ring is never the center
    assert re.search(r"\bhex \d+,\d+", standings) is None
    assert re.search(r"\brow \d+", standings) is None

    from quest_sim.models.overworld import WorldPos
    site = next(s for s in world.sites.values() if s.site_id != world.boss_site_id)
    room_key = next(iter(site.entrances))
    agents[0].position = WorldPos(kind="dungeon", site_id=site.site_id, room=room_key)
    dungeon_standings = booth._digest(world).splitlines()[0]
    assert f"in {site.name}" in dungeon_standings
    assert "wing" in dungeon_standings or "central rooms" in dungeon_standings
    assert room_key not in dungeon_standings.split(f"in {site.name}")[1][:30]

    world.phase = type(world.phase).finished
    world.winner_name = "Kell"
    world.win_reason = "boss"
    assert "sign-off" in booth._digest(world)

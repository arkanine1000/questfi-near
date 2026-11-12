"""Sandbox world persistence — JSON state + JSONL event/frame logs.

Layout (under settings.sandbox_data_dir):
    {world_id}/world.json    — full SandboxWorld snapshot, rewritten per tick
    {world_id}/events.jsonl  — every EngineEvent, seq-stamped, append-only
    {world_id}/ticks.jsonl   — one spectator frame per tick (SSE backfill)
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from quest_sim.models.events import EngineEvent
from quest_sim.models.sandbox import SandboxWorld

logger = logging.getLogger(__name__)


def _world_dir(data_dir: Path, world_id: str) -> Path:
    return data_dir / world_id


def save_world(data_dir: Path, world: SandboxWorld) -> None:
    wdir = _world_dir(data_dir, world.world_id)
    wdir.mkdir(parents=True, exist_ok=True)
    (wdir / "world.json").write_text(world.model_dump_json(indent=2))


def load_world(data_dir: Path, world_id: str) -> SandboxWorld | None:
    """Load a world snapshot; None when missing OR unreadable.

    The data dir can hold worlds written by earlier engines (v2/royale used
    different schemas) or by future ones — a foreign world.json must never
    take the API down, it just isn't a sandbox world.
    """
    path = _world_dir(data_dir, world_id) / "world.json"
    if not path.exists():
        return None
    try:
        world = SandboxWorld.model_validate_json(path.read_text())
    except Exception:
        logger.warning("skipping unreadable world.json under %s (foreign schema?)", world_id)
        return None
    if world.world_id != world_id:
        # A foreign engine's file can accidentally validate against our
        # defaults; a genuine sandbox snapshot always knows its own id.
        logger.warning("skipping world.json under %s (identity mismatch)", world_id)
        return None
    return world


def delete_world(data_dir: Path, world_id: str) -> bool:
    """Erase a world entirely — snapshot, events, frames. Returns whether
    there was anything there. The store owns the on-disk layout, so callers
    never reach around it with their own rmtree."""
    import shutil

    wdir = _world_dir(data_dir, world_id)
    existed = wdir.exists()
    shutil.rmtree(wdir, ignore_errors=True)
    return existed


def list_worlds(data_dir: Path) -> list[str]:
    if not data_dir.exists():
        return []
    return sorted(
        d.name for d in data_dir.iterdir()
        if d.is_dir() and (d / "world.json").exists()
    )


def append_events(data_dir: Path, world_id: str, events: list[EngineEvent]) -> None:
    if not events:
        return
    wdir = _world_dir(data_dir, world_id)
    wdir.mkdir(parents=True, exist_ok=True)
    with (wdir / "events.jsonl").open("a") as f:
        for event in events:
            f.write(event.model_dump_json() + "\n")


def load_events(
    data_dir: Path, world_id: str, since_tick: int = 0, since_seq: int = 0
) -> list[EngineEvent]:
    """Events with tick >= since_tick AND seq > since_seq (cursor semantics)."""
    path = _world_dir(data_dir, world_id) / "events.jsonl"
    if not path.exists():
        return []
    events = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        event = EngineEvent.model_validate_json(line)
        if event.tick >= since_tick and event.seq > since_seq:
            events.append(event)
    return events


def append_tick_frame(data_dir: Path, world_id: str, frame: dict) -> None:
    wdir = _world_dir(data_dir, world_id)
    wdir.mkdir(parents=True, exist_ok=True)
    with (wdir / "ticks.jsonl").open("a") as f:
        f.write(json.dumps(frame) + "\n")


def load_tick_frames(data_dir: Path, world_id: str, since_tick: int = 0) -> list[dict]:
    """Frames with tick >= since_tick, in order (SSE reconnect backfill)."""
    path = _world_dir(data_dir, world_id) / "ticks.jsonl"
    if not path.exists():
        return []
    frames = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        frame = json.loads(line)
        if frame.get("tick", 0) >= since_tick:
            frames.append(frame)
    return frames

"""The arena's HTTP surface: /near/arena.

Live only when NEAR settlement and the arena are both on; otherwise GET
answers ``{"enabled": false}`` and the POSTs are 404. See
``quest_sim.near.arena`` for the start rules.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from quest_sim.api import world_routes
from quest_sim.near.arena import Arena, ArenaRefusal, get_arena

arena_router = APIRouter(prefix="/near", tags=["near"])


class ArenaJoinRequest(BaseModel):
    world_id: str | None = None  # the lobby's; omitted means the current lobby
    pass_id: str = Field(min_length=1, max_length=64)
    name: str | None = Field(default=None, max_length=64)
    roster_id: str | None = None  # mimir | cassandra | roko | aegis
    account_id: str | None = None  # the pass owner, for the log


def _arena() -> Arena | None:
    return get_arena(world_routes._get_settings())


def _require_arena() -> Arena:
    arena = _arena()
    if arena is None:
        raise HTTPException(status_code=404, detail="The arena is not enabled on this server")
    return arena


@arena_router.get("/arena")
async def arena_state():
    """The season open for entry (top-level world_id), the one running,
    and the last result."""
    arena = _arena()
    if arena is None:
        return {"enabled": False, "world_id": None}
    return arena.status()


@arena_router.post("/arena/join")
async def arena_join(req: ArenaJoinRequest):
    """Seat a hosted agent for a pass that has entered the lobby's season
    on chain. Repeating it returns the same seat."""
    arena = _require_arena()
    try:
        return await arena.join(
            world_id=req.world_id,
            pass_id=req.pass_id,
            name=req.name,
            roster_id=req.roster_id,
            account_id=req.account_id,
        )
    except ArenaRefusal as e:
        raise HTTPException(status_code=e.status, detail=e.detail) from None


@arena_router.post("/arena/start")
async def arena_start():
    """Start the lobby now, house agents filling every empty seat. With a
    player seated this only skips the countdown. With none it is a
    house-only season, refused within the house gap of the last one.
    Always refused while a season runs."""
    arena = _require_arena()
    try:
        return await arena.start_lobby(requested=True)
    except ArenaRefusal as e:
        raise HTTPException(status_code=e.status, detail=e.detail) from None

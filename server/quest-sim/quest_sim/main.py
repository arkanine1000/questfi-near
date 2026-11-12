from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from quest_sim.api.arena_routes import arena_router
from quest_sim.api.tts_routes import tts_router
from quest_sim.api.world_routes import world_router
from quest_sim.config import get_settings
from quest_sim.prefabs import seed_prefab_quests


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.sandbox_data_dir.mkdir(parents=True, exist_ok=True)

    # Configure logging with both console and file output
    log_file = settings.data_dir / "uvicorn.log"
    logging.basicConfig(
        level=logging.INFO,  # Info level - less cluttered than DEBUG
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        handlers=[
            logging.StreamHandler(),  # Console output
            logging.FileHandler(log_file, mode='a')  # Persistent file logging
        ],
        force=True,  # Override any existing config
    )

    # Suppress noisy debug loggers
    logging.getLogger("LiteLLM").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("markdown_it").setLevel(logging.WARNING)
    logging.getLogger("asyncio").setLevel(logging.WARNING)

    logger = logging.getLogger(__name__)
    logger.info(f"Logging to console and {log_file}")

    # Seed bundled prefab quests (idempotent; raises on an invalid prefab)
    seeded = seed_prefab_quests(settings)
    if seeded:
        logger.info(f"Seeded prefab quests: {', '.join(seeded)}")

    # Abandoned-season GC (disk + runners + booths); 0 interval disables
    import asyncio as _asyncio

    from quest_sim.api.world_routes import world_gc_loop

    gc_task = (
        _asyncio.create_task(world_gc_loop())
        if settings.sandbox_gc_interval_min > 0
        else None
    )

    # On-chain settlement: resume any calls a previous process left queued.
    from quest_sim.near import get_settler

    settler = get_settler(settings)
    if settler is not None:
        await settler.start()
        logger.info(
            "NEAR settlement on: contract %s, operator %s, %d call(s) queued",
            settings.near_contract_id, settings.near_operator_id, settler.queue_depth(),
        )
    # The arena: seasons that run themselves. Boots after the settler so its
    # self-heal can queue cancels for seasons a previous process left open.
    from quest_sim.near.arena import get_arena

    arena = get_arena(settings)
    if arena is not None:
        await arena.start()
        logger.info("NEAR arena on: lobby %s open for entry", arena.lobby_id)
    elif settings.near_arena_enabled:
        logger.warning("QUEST_SIM_NEAR_ARENA_ENABLED is set but settlement is off; no arena")
    try:
        yield
    finally:
        if gc_task is not None:
            gc_task.cancel()
        if arena is not None:
            await arena.stop()
        if settler is not None:
            await settler.stop()  # unsent calls stay in the ledgers for next boot


def create_app() -> FastAPI:
    settings = get_settings()

    # Fail fast rather than boot a server nobody can use: operator-only makes
    # the admin key the ONLY credential that opens anything, so without one
    # set there is no way to create or run a season. Catching this at deploy
    # beats discovering it later as a mysteriously dead instance.
    if settings.sandbox_operator_only and not settings.admin_key:
        raise RuntimeError(
            "QUEST_SIM_SANDBOX_OPERATOR_ONLY is set but QUEST_SIM_ADMIN_KEY is "
            "empty — no one could create or run a season. Set the admin key, "
            "or unset operator-only."
        )
    # Same reasoning for settlement: a half-configured operator would accept
    # seasons and then fail every call to the contract, quietly.
    if settings.near_enabled:
        from quest_sim.near import config_problems

        problems = config_problems(settings)
        if problems:
            raise RuntimeError(
                "QUEST_SIM_NEAR_ENABLED is set but " + "; ".join(problems)
                + ". Fill these in, or unset QUEST_SIM_NEAR_ENABLED."
            )

    # MCP surface (streamable HTTP) rides in-process at /mcp — same event
    # loop and world registry as the routes. Its session manager needs its
    # lifespan threaded into FastAPI's (nested lifespans are not detected).
    from quest_sim.api.mcp_server import build_mcp_asgi

    mcp_asgi = build_mcp_asgi()

    @asynccontextmanager
    async def combined_lifespan(app: FastAPI):
        async with lifespan(app):
            async with mcp_asgi.lifespan(app):
                yield

    app = FastAPI(
        title="Quest-Sim",
        description="Agent-native dungeon-crawler RPG-lite",
        version="0.1.0",
        lifespan=combined_lifespan,
    )
    app.mount("/mcp", mcp_asgi)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(world_router)
    app.include_router(tts_router)
    app.include_router(arena_router)  # inert unless the arena is on

    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception):
        logger = logging.getLogger(__name__)
        logger.exception("Unhandled exception")
        return JSONResponse(
            status_code=500,
            content={"detail": f"Internal server error: {type(exc).__name__}"},
        )

    return app


app = create_app()

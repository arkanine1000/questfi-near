from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="QUEST_SIM_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # LLM
    llm_model: str = "deepseek/deepseek-chat"
    llm_api_base: str | None = None
    llm_api_key: str | None = None

    # Prompt-chan, the commentator. OFF until a model is set — that keeps
    # CI/policy rehearsals token-free. QUEST_SIM_COMMENTATOR_MODEL, shares
    # the LLM api key/base above.
    commentator_model: str | None = None
    commentator_enabled: bool = True  # kill switch without unsetting the model

    # Prompt-chan's voice — ElevenLabs proxy for the spectator's TTS.
    # OFF until both key and voice id are set; the frontend falls back to
    # the browser's Web Speech voice when /tts answers 503.
    tts_api_key: str | None = None  # QUEST_SIM_TTS_API_KEY (ElevenLabs)
    tts_voice_id: str | None = None  # QUEST_SIM_TTS_VOICE_ID (library voice)
    tts_model: str = "eleven_flash_v2_5"  # fast + cheap; quality: eleven_multilingual_v2

    # Persistence. Still load-bearing after the v1 removal: quest_store
    # derives the quest root as data_dir.parent / "quests", prefabs seed
    # through it, and main's lifespan writes uvicorn.log here.
    data_dir: Path = Path("data/games")

    # Sandbox (multi-agent season)
    sandbox_pool_size: int = 10  # QUEST_SIM_SANDBOX_POOL_SIZE — season-start roster size
    sandbox_num_sites: int = 6  # POI dungeons (the central boss site is always +1)
    sandbox_action_deadline_s: float = 5.0  # per-tick BYO action window
    sandbox_tick_seconds: float = 2.0  # auto-run pacing (hosted/policy worlds)
    sandbox_min_tick_gap_s: float = 0.35  # frame floor when the barrier paces
    sandbox_max_ticks: int = 300  # season bell (timeout tiebreak)
    # "llm" | "policy". LLM reasoning + narration is the product — policy
    # brains are the token-free rehearsal/CI mode, never the default.
    sandbox_hosted_brain: str = "llm"
    # Hosted-brain memory is append-only so the cached prompt prefix stays
    # stable; at the cap it resets WHOLE rather than sliding. A sliding window
    # rewrites the prefix on every eviction and costs ~8x in full-price tokens
    # (measured: 38% cache hit vs 93% append-only). ~370 tokens/turn, so 50
    # turns is ~11k per call — real seasons run ~32 ticks, so this rarely fires.
    sandbox_memory_cap: int = 50  # QUEST_SIM_SANDBOX_MEMORY_CAP
    sandbox_data_dir: Path = Path("data/worlds")
    # World GC: abandoned seasons are swept (disk + runner + booth) once
    # their world.json has not been touched for the phase's TTL. 0 disables.
    sandbox_gc_interval_min: int = 30
    sandbox_lobby_ttl_h: float = 12.0  # empty lobbies rot fastest
    sandbox_running_ttl_h: float = 48.0  # mid-season but nobody ticking
    sandbox_finished_ttl_h: float = 72.0  # keep results a few days

    # Host controls. The clock and DELETE belong to whoever opened the world
    # (its host_key, minted at creation); QUEST_SIM_ADMIN_KEY is the operator's
    # skeleton key over every world. Enforcement is OFF by default so the
    # backend can deploy ahead of a frontend that knows to send a key —
    # flip QUEST_SIM_SANDBOX_HOST_KEY_ENFORCED once clients carry it. DELETE
    # honours the key regardless, since nothing deployed calls it yet.
    admin_key: str | None = None  # QUEST_SIM_ADMIN_KEY — server-wide superuser
    sandbox_host_key_enforced: bool = False
    # Locked-down deployment: ONLY the admin key may open a lobby or touch a
    # season's clock. Per-world host keys go inert — this is the "my server,
    # my seasons" switch for a public instance. Players are unaffected: they
    # still join, ready up, and take turns. Deploy-time only (.env / Railway),
    # and boot fails when it is on with no admin key set — see main.create_app.
    sandbox_operator_only: bool = False

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: list[str] = ["*"]


def get_settings() -> Settings:
    return Settings()

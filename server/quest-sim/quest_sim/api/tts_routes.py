"""Prompt-chan's voice box — a thin ElevenLabs proxy.

The spectator never sees the API key: the frontend POSTs a line, this
route streams back mp3. Unconfigured deployments answer 503 and the
frontend falls back to the browser's Web Speech voice, so the feature
degrades instead of breaking.
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from quest_sim.config import get_settings

tts_router = APIRouter(prefix="/tts", tags=["tts"])

MAX_CHARS = 600  # commentary lines run ~150-300 chars; cap the bill

# One shared client: connection reuse matters when every line is a call.
_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=30.0)
    return _client


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_CHARS)


@tts_router.post("")
async def speak(req: SpeakRequest):
    settings = get_settings()
    if not settings.tts_api_key or not settings.tts_voice_id:
        raise HTTPException(status_code=503, detail="TTS not configured")

    url = (
        "https://api.elevenlabs.io/v1/text-to-speech/"
        f"{settings.tts_voice_id}/stream"
    )
    upstream = await _http().send(
        _http().build_request(
            "POST",
            url,
            headers={"xi-api-key": settings.tts_api_key},
            json={
                "text": req.text,
                "model_id": settings.tts_model,
                # lively and expressive over perfectly stable — she's a caster
                "voice_settings": {
                    "stability": 0.35,
                    "similarity_boost": 0.8,
                    "style": 0.6,
                },
            },
        ),
        stream=True,
    )
    if upstream.status_code != 200:
        detail = (await upstream.aread())[:200].decode(errors="replace")
        await upstream.aclose()
        raise HTTPException(status_code=502, detail=f"TTS upstream: {detail}")

    async def relay():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(relay(), media_type="audio/mpeg")

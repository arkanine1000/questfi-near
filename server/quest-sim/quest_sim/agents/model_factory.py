from __future__ import annotations

from smolagents import LiteLLMModel
from smolagents.models import ChatMessage

from quest_sim.config import Settings


class CachingLiteLLMModel(LiteLLMModel):
    """
    LiteLLMModel that marks the system prompt as cacheable.

    Converts the system message content from a plain string to a structured
    content block with Anthropic's cache_control marker. LiteLLM forwards this
    to Anthropic's prompt caching API and silently drops it for all other
    providers, so this is safe to use unconditionally.

    Savings: ~90% cost reduction on system prompt tokens (cached reads cost
    ~1/10th of regular input tokens on Anthropic).
    """

    _ANTHROPIC_PREFIXES = ("anthropic/", "claude-")

    def generate(self, messages: list[ChatMessage | dict], **kwargs) -> ChatMessage:
        if any(self.model_id.startswith(p) for p in self._ANTHROPIC_PREFIXES):
            for msg in messages:
                if (
                    isinstance(msg, ChatMessage)
                    and msg.role == "system"
                    and isinstance(msg.content, str)
                    and msg.content
                ):
                    msg.content = [
                        {
                            "type": "text",
                            "text": msg.content,
                            "cache_control": {"type": "ephemeral"},
                        }
                    ]
        return super().generate(messages, **kwargs)


def create_model(settings: Settings | None = None) -> CachingLiteLLMModel:
    """Create a LiteLLMModel with prompt caching enabled."""
    if settings is None:
        from quest_sim.config import get_settings
        settings = get_settings()

    kwargs: dict = {"model_id": settings.llm_model}
    if settings.llm_api_base:
        kwargs["api_base"] = settings.llm_api_base
    if settings.llm_api_key:
        kwargs["api_key"] = settings.llm_api_key

    return CachingLiteLLMModel(**kwargs)

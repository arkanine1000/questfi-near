from __future__ import annotations

import os
import random

import pytest

from quest_sim.config import Settings

# The operator's skeleton key, shared by the API and MCP fixtures. Suites
# run with enforcement ON and this key on the client, so the entire test
# body exercises the authorised path and negative tests opt out per request.
ADMIN_KEY = "test-admin-key"


@pytest.fixture(autouse=True)
def _hermetic_settings(monkeypatch):
    """The suite must never inherit the developer's .env.

    Fixtures pass explicit Settings, but pydantic-settings fills every field
    they DON'T pass — so a local QUEST_SIM_SANDBOX_OPERATOR_ONLY silently
    rewrote authorisation behaviour under 15 tests, and the failures moved
    around with test order.

    Neither `_env_file=None` nor a bogus `env_file` in model_config fixes
    it, because the leak is not the dotenv source: something in the app's
    import/startup path calls load_dotenv(), which copies the whole file
    into os.environ — real environment variables then outrank every other
    source. (The giveaway was dead keys like QUEST_SIM_DEFAULT_BUDGET,
    which no current field reads, appearing in os.environ mid-run.)

    So scrub the prefix before each test. Tests get defaults plus whatever
    their fixture passes, and nothing else.
    """
    for key in [k for k in os.environ if k.startswith("QUEST_SIM_")]:
        monkeypatch.delenv(key, raising=False)
    Settings.model_config["env_file"] = None  # belt and braces for fresh procs
    yield


@pytest.fixture
def rng() -> random.Random:
    """Deterministic RNG for reproducible tests."""
    return random.Random(42)


@pytest.fixture
def rng_seed_99() -> random.Random:
    return random.Random(99)

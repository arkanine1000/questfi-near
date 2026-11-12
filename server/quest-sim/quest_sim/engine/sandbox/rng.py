"""Keyed deterministic randomness for sandbox seasons.

``sub_rng(seed, *key)`` returns an independent generator per (seed, key)
tuple — order-independent, replay-stable, no global state. String seeding of
``random.Random`` hashes via SHA-512 and is stable across processes.
"""

from __future__ import annotations

import random


def sub_rng(seed: int, *parts: object) -> random.Random:
    return random.Random(f"{seed}|" + "|".join(str(p) for p in parts))

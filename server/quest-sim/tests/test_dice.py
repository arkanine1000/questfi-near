from __future__ import annotations

import random

from quest_sim.engine.dice import (
    d,
    d20,
    roll_ability_check,
    roll_attack,
    roll_initiative,
    roll_with_modifier,
)


def test_d20_range(rng: random.Random):
    results = [d20(rng) for _ in range(200)]
    assert all(1 <= r <= 20 for r in results)
    assert min(results) >= 1
    assert max(results) <= 20


def test_d_range(rng: random.Random):
    for n in [4, 6, 8, 10, 12]:
        results = [d(n, rng) for _ in range(200)]
        assert all(1 <= r <= n for r in results)


def test_d20_deterministic():
    r1 = random.Random(42)
    r2 = random.Random(42)
    assert [d20(r1) for _ in range(10)] == [d20(r2) for _ in range(10)]


def test_roll_with_modifier(rng: random.Random):
    raw, mod, total = roll_with_modifier(rng, modifier=3)
    assert 1 <= raw <= 20
    assert mod == 3
    assert total == raw + 3


def test_roll_attack_hit(rng: random.Random):
    result = roll_attack(rng, "attacker", "defender", attacker_mod=5, target_ac=10)
    assert result.attacker_id == "attacker"
    assert result.defender_id == "defender"
    if result.hit:
        assert result.damage > 0


def test_roll_attack_crit():
    """Force a crit by using an RNG that always returns 20."""

    class CritRng:
        def randint(self, a, b):
            return b  # always max

    result = roll_attack(CritRng(), "a", "d", attacker_mod=0, target_ac=25)
    assert result.critical is True
    assert result.hit is True
    assert result.damage > 0


def test_roll_ability_check_success(rng: random.Random):
    total, success = roll_ability_check(rng, modifier=10, dc=5)
    assert success is True
    assert total >= 5


def test_roll_ability_check_deterministic():
    r1 = random.Random(42)
    r2 = random.Random(42)
    assert roll_ability_check(r1, 2, 15) == roll_ability_check(r2, 2, 15)


def test_roll_initiative(rng: random.Random):
    result = roll_initiative(rng, dex_mod=2)
    assert 3 <= result <= 22  # d20 (1-20) + 2

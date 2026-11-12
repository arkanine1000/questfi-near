from __future__ import annotations

import random

from quest_sim.models.combat import AttackResult


def d20(rng: random.Random) -> int:
    return rng.randint(1, 20)


def d(n: int, rng: random.Random) -> int:
    return rng.randint(1, n)


def roll_with_modifier(rng: random.Random, modifier: int = 0) -> tuple[int, int, int]:
    """Roll d20 + modifier. Returns (raw_roll, modifier, total)."""
    raw = d20(rng)
    return raw, modifier, raw + modifier


def roll_attack(
    rng: random.Random,
    attacker_id: str,
    defender_id: str,
    attacker_mod: int,
    target_ac: int,
    damage_dice: int = 6,
    damage_bonus: int = 0,
) -> AttackResult:
    """Roll to attack: d20 + mod vs AC. On hit, roll damage."""
    raw, _, total = roll_with_modifier(rng, attacker_mod)
    critical = raw == 20
    hit = critical or total >= target_ac

    damage = 0
    if hit:
        damage = d(damage_dice, rng) + damage_bonus
        if critical:
            damage += d(damage_dice, rng)  # extra die on crit

    return AttackResult(
        attacker_id=attacker_id,
        defender_id=defender_id,
        attack_roll=total,
        target_ac=target_ac,
        hit=hit,
        damage=damage,
        critical=critical,
    )


def roll_ability_check(
    rng: random.Random, modifier: int, dc: int
) -> tuple[int, bool]:
    """Roll d20 + modifier vs DC. Returns (total_roll, success)."""
    raw, _, total = roll_with_modifier(rng, modifier)
    return total, total >= dc


def roll_initiative(rng: random.Random, dex_mod: int) -> int:
    """Roll d20 + DEX modifier for initiative."""
    _, _, total = roll_with_modifier(rng, dex_mod)
    return total

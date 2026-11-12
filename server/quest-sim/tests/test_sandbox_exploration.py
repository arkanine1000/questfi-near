"""Searching, revealing and taking loot in a shared dungeon.

None of this had any coverage, which is how three bugs shipped together in
one season: a failed search revealed the loot it had just failed to find,
that failure spent the room for every other agent, and the two events that
name found items named nobody — so a rival in the same room read someone
else's roll and someone else's axe as their own.
"""

from __future__ import annotations

import random

from quest_sim.engine.sandbox.actions import (
    pick_up,
    search_here,
    visible_floor_items,
)
from quest_sim.engine.sandbox.build import build_world, start_season
from quest_sim.engine.sandbox.perception import valid_actions
from quest_sim.models.character import Item, ItemType
from quest_sim.models.overworld import WorldPos
from quest_sim.models.sandbox import SandboxConfig


def _world(seed=7, pool=4):
    w = build_world(SandboxConfig(pool_size=pool), seed=seed)
    start_season(w)
    return w


def _teleport(w, agent, site_id: str, room_key: str) -> None:
    if agent.position.kind == "overworld" and agent.position.hex:
        tile = w.overworld.get_key(agent.position.hex)
        if tile and agent.agent_id in tile.occupants:
            tile.occupants.remove(agent.agent_id)
    r, c = (int(x) for x in room_key.split(","))
    agent.position = WorldPos.in_site(site_id, r, c)
    agent.visited.setdefault(site_id, set()).add(room_key)


def _trove(w, agents, *, search_dc: int | None = 12, items=("Runed Greataxe",)):
    """Put `agents` in one room holding `items` behind `search_dc`.

    Returns (site_id, room_key, room, item_ids).
    """
    site_id = sorted(w.sites)[0]
    site = w.sites[site_id]
    room_key = sorted(site.map_grid.rooms)[0]
    room = site.map_grid.rooms[room_key]

    room.entity_ids = []  # no mobs: this is about loot, not combat
    room.searched = False
    room.search_dc = search_dc
    room.treasure_item_ids = []
    item_ids = []
    for i, name in enumerate(items):
        item = Item(id=f"{site_id}.loot{i}", name=name, item_type=ItemType.weapon)
        site.items[item.id] = item
        room.treasure_item_ids.append(item.id)
        item_ids.append(item.id)

    for agent in agents:
        _teleport(w, agent, site_id, room_key)
    return site_id, room_key, room, item_ids


class _Roll:
    """Force the WIS check, and count how many times it was actually rolled."""

    def __init__(self, success: bool):
        self.success = success
        self.calls = 0

    def __call__(self, rng, score, dc):
        self.calls += 1
        return (dc if self.success else dc - 1), self.success


def _force_roll(monkeypatch, success: bool) -> _Roll:
    roll = _Roll(success)
    monkeypatch.setattr("quest_sim.engine.exploration.roll_ability_check", roll)
    return roll


# ---------------------------------------------------------------------------
# Every loot line names who found it
# ---------------------------------------------------------------------------


def test_every_search_line_names_the_searcher(monkeypatch):
    """A co-located rival receives these events through the location filter.
    Unlabelled, they read as the rival's own find — which is exactly how one
    player reported 'rolling a 17' for loot another player walked out with.

    Asserts the invariant across every branch rather than pinning strings:
    a new branch that forgets the subject should fail this."""
    w = _world()
    a = next(iter(w.agents.values()))

    for dc, success in ((12, False), (12, True), (None, False), (12, False)):
        _trove(w, [a], search_dc=dc, items=("Runed Greataxe",) if dc else ("Grave Aegis",))
        _force_roll(monkeypatch, success=success)
        events = search_here(w, a, random.Random(1))
        assert events, f"no events for dc={dc} success={success}"
        for ev in events:
            assert a.name in ev.description, (dc, success, ev.description)

    # ...including the already-searched branch, which named nobody at all
    events = search_here(w, a, random.Random(1))
    assert events and all(a.name in ev.description for ev in events)


def test_pick_up_names_the_taker(monkeypatch):
    """Same defect, second site: `Picked up: X.` let a rival in the room read
    someone else's loot grab as their own."""
    w = _world()
    a = next(iter(w.agents.values()))
    _, room_key, room, _ = _trove(w, [a], search_dc=None, items=("Grave Aegis",))
    # reveal without claiming, so there is something left to pick up
    room.searched = True

    events = pick_up(w, a)

    assert events
    for ev in events:
        assert a.name in ev.description, ev.description


# ---------------------------------------------------------------------------
# A failed search is the failer's alone
# ---------------------------------------------------------------------------


def test_failed_search_hides_the_loot_and_leaves_the_room_open(monkeypatch):
    """The whole bug in one test.

    `room.searched` was latched before the roll and floor visibility keyed off
    that latch, so failing revealed exactly the treasure you had just failed
    to find — and closed the room to everyone else at the same time."""
    w = _world()
    a, b = list(w.agents.values())[:2]
    _, _, room, _ = _trove(w, [a, b])
    _force_roll(monkeypatch, success=False)

    events = search_here(w, a, random.Random(1))

    assert any(e.data.get("found") is False for e in events)
    assert room.searched is False, "a failed roll must not mark the room revealed"
    assert visible_floor_items(w, a) == [], "a failed search revealed the loot"
    assert room.treasure_item_ids, "the treasure must still be there to find"
    assert "pick_up:item=<name>" not in valid_actions(w, a)
    assert "search" in valid_actions(w, b), "one bad roll must not spend the room"


def test_a_failed_search_is_spent_for_the_agent_who_failed_it(monkeypatch):
    """Per-agent attempt: one roll per room, not unlimited retries."""
    w = _world()
    a = next(iter(w.agents.values()))
    _trove(w, [a])
    roll = _force_roll(monkeypatch, success=False)

    search_here(w, a, random.Random(1))
    assert roll.calls == 1
    assert "search" not in valid_actions(w, a)

    events = search_here(w, a, random.Random(1))
    assert roll.calls == 1, "a second attempt must not re-roll the same room"
    assert any(e.data.get("already_searched") for e in events)
    assert any(e.data.get("by_you") for e in events)


def test_a_rivals_failure_does_not_spend_my_search(monkeypatch):
    """The reported season lost a vault this way: one bad roll from the first
    agent through the door, and the room was shut to everyone after."""
    w = _world()
    a, b = list(w.agents.values())[:2]
    _, _, room, item_ids = _trove(w, [a, b])

    _force_roll(monkeypatch, success=False)
    search_here(w, a, random.Random(1))
    _force_roll(monkeypatch, success=True)
    search_here(w, b, random.Random(1))

    assert room.searched is True
    assert [i.id for i in b.character.inventory if i.id in item_ids] == item_ids


def test_a_successful_search_reveals_the_room_for_everyone(monkeypatch):
    """Reveal is global — one agent's success ends the room for the table."""
    w = _world()
    a, b = list(w.agents.values())[:2]
    _, _, room, item_ids = _trove(w, [a, b])
    _force_roll(monkeypatch, success=True)

    search_here(w, a, random.Random(1))

    assert room.searched is True
    assert [i.id for i in a.character.inventory if i.id in item_ids] == item_ids
    assert "search" not in valid_actions(w, b), "nothing left here to find"


def test_a_room_with_no_dc_reveals_without_a_roll(monkeypatch):
    """Guards the reordering of the latch: free loot must still be claimed."""
    w = _world()
    a = next(iter(w.agents.values()))
    _, _, room, item_ids = _trove(w, [a], search_dc=None)
    roll = _force_roll(monkeypatch, success=False)

    search_here(w, a, random.Random(1))

    assert roll.calls == 0, "a room with no DC must not roll"
    assert room.searched is True
    assert [i.id for i in a.character.inventory if i.id in item_ids] == item_ids


def test_an_empty_room_is_spent_for_everyone():
    """'Nothing here' is not a DC-gated secret, so it stays a global latch —
    which is also what keeps a policy brain's unfinished-room set shrinking."""
    w = _world()
    a, b = list(w.agents.values())[:2]
    _, _, room, _ = _trove(w, [a, b], items=())

    search_here(w, a, random.Random(1))

    assert room.searched is True
    assert "search" not in valid_actions(w, b)


def test_visible_floor_items_hides_unrevealed_treasure():
    """The visibility predicate on its own, with no search involved."""
    w = _world()
    a = next(iter(w.agents.values()))
    _trove(w, [a])
    assert visible_floor_items(w, a) == []


def test_dropped_loot_in_an_unsearched_trove_stays_hidden():
    """Pins the documented contract: rifling a fresh corpse in a trove nobody
    has turned over still takes a search."""
    w = _world()
    a = next(iter(w.agents.values()))
    site_id, _, room, _ = _trove(w, [a])
    dropped = Item(id=f"{site_id}.dropped", name="Dead Rival's Blade",
                   item_type=ItemType.weapon)
    w.sites[site_id].items[dropped.id] = dropped
    room.treasure_item_ids.append(dropped.id)

    assert visible_floor_items(w, a) == []


def test_my_private_map_does_not_report_a_rivals_search(monkeypatch):
    """`searched` in the agent's own fogged map is 'have I searched here',
    not 'has anyone' — the global flag there leaked a rival's movements."""
    from quest_sim.engine.sandbox.perception import build_observation

    w = _world()
    a, b = list(w.agents.values())[:2]
    site_id, room_key, _, _ = _trove(w, [a, b])
    _force_roll(monkeypatch, success=False)
    search_here(w, b, random.Random(1))  # the RIVAL searches

    obs = build_observation(w, a.agent_id)
    assert obs["location"]["searched"] is False
    assert obs["map"]["rooms"][room_key]["searched"] is False


# ---------------------------------------------------------------------------
# Item refs resolve the way a player writes them
#
# The livelock this fixes: agent-04 at 11/25 HP issued `pick_up:item=Vault
# Seal` on six consecutive ticks against an item named "The Vault Seal" listed
# in its own observation, and took it the instant the model happened to write
# the article. The engine was blameless — it emitted the failure every time.
# ---------------------------------------------------------------------------


def _seal_room(w, agent, *names):
    _, _, room, _ = _trove(w, [agent], search_dc=None, items=names)
    room.searched = True  # revealed, unclaimed
    return room


def _taken(agent):
    """Loot names in the pack. Agents start carrying their own weapon, so the
    interesting quantity is always the delta, never the whole inventory."""
    return {i.name for i in agent.character.inventory} - {"Longsword", "Dagger"}


def test_pick_up_tolerates_a_dropped_article():
    """The exact regression. `Vault Seal` must take "The Vault Seal"."""
    w = _world()
    a = next(iter(w.agents.values()))
    _seal_room(w, a, "The Vault Seal")

    events = pick_up(w, a, "Vault Seal")

    assert _taken(a) == {"The Vault Seal"}
    assert events and all(e.event_type.value != "action_failed" for e in events)


def test_pick_up_tolerates_case_and_unique_shortenings():
    for ref in ("the vault seal", "THE VAULT SEAL", "Seal", "vault seal"):
        w = _world()
        a = next(iter(w.agents.values()))
        _seal_room(w, a, "The Vault Seal")

        pick_up(w, a, ref)

        assert _taken(a) == {"The Vault Seal"}, ref


def test_an_ambiguous_ref_takes_nothing_and_says_so():
    """Never guess. A short name matching two items must fail loudly —
    handing an agent something it did not ask for is worse than a refusal
    it can read and correct."""
    w = _world()
    a = next(iter(w.agents.values()))
    _seal_room(w, a, "The Vault Seal", "The Vault Key")

    events = pick_up(w, a, "Vault")

    assert _taken(a) == set()
    assert events and all(e.event_type.value == "action_failed" for e in events)
    assert "Vault" in events[0].description


def test_pick_up_bare_still_takes_everything():
    w = _world()
    a = next(iter(w.agents.values()))
    _seal_room(w, a, "The Vault Seal", "The Vault Key")

    pick_up(w, a)

    assert _taken(a) == {"The Vault Seal", "The Vault Key"}


def test_an_unrevealed_item_is_not_a_resolution_target():
    """Loosening the match must not leak loot past the search gate."""
    w = _world()
    a = next(iter(w.agents.values()))
    _trove(w, [a], search_dc=12, items=("The Vault Seal",))  # unsearched

    events = pick_up(w, a, "Vault Seal")

    assert _taken(a) == set()
    assert events and all(e.event_type.value == "action_failed" for e in events)


def test_inventory_refs_are_just_as_forgiving():
    """use_item and equip share the helper — the same livelock on a different
    verb ('Potion' vs "Potion of Healing") is closed by the same change."""
    from quest_sim.engine.sandbox.actions import find_inventory_item

    w = _world()
    a = next(iter(w.agents.values()))
    potion = Item(id="p1", name="Potion of Healing", item_type=ItemType.potion)
    a.character.inventory.append(potion)

    assert find_inventory_item(a, "Potion") is potion
    assert find_inventory_item(a, "potion of healing") is potion
    assert find_inventory_item(a, "Elixir") is None


# ---------------------------------------------------------------------------
# `search` is offered only where it can pay
#
# Measured on main: search sat on the menu in 17% of agent-turns and 94% of
# searches found nothing — 78% of the offers were rooms the engine already
# knew were empty. Hosted brains take what the menu offers (the same defect
# best_upgrade fixed for `equip`), so they burned a turn per room on a coin
# flip with no coin.
# ---------------------------------------------------------------------------


def _room_with(w, agent, *, dc, treasure):
    site_id, room_key, room, _ = _trove(
        w, [agent], search_dc=dc, items=("The Vault Seal",) if treasure else ()
    )
    return site_id, room_key, room


def test_search_is_not_offered_in_a_provably_empty_room():
    """The 78% case. The engine knows treasure_item_ids is empty."""
    w = _world()
    a = next(iter(w.agents.values()))
    _room_with(w, a, dc=12, treasure=False)

    assert "search" not in valid_actions(w, a)


def test_search_is_not_offered_when_the_loot_is_already_visible():
    """No DC means the loot is on show and pick_up is already on the menu —
    searching would be a redundant way to take what you can already take."""
    w = _world()
    a = next(iter(w.agents.values()))
    _room_with(w, a, dc=None, treasure=True)

    acts = valid_actions(w, a)
    assert "search" not in acts
    assert any(x.startswith("pick_up") for x in acts)


def test_search_is_offered_where_treasure_is_actually_hidden():
    w = _world()
    a = next(iter(w.agents.values()))
    _room_with(w, a, dc=12, treasure=True)

    assert "search" in valid_actions(w, a)


def test_search_leaves_the_menu_once_this_agent_has_tried():
    w = _world()
    a = next(iter(w.agents.values()))
    _room_with(w, a, dc=12, treasure=True)
    assert "search" in valid_actions(w, a)

    search_here(w, a, random.Random(1))

    assert "search" not in valid_actions(w, a)


def test_an_off_menu_search_still_resolves_instead_of_crashing():
    """Narrowing the OFFER must not remove the VERB — a BYO player can still
    submit `search` anywhere, and the engine owes them a real answer."""
    w = _world()
    a = next(iter(w.agents.values()))
    _room_with(w, a, dc=12, treasure=False)

    events = search_here(w, a, random.Random(1))

    assert events and all(a.name in e.description for e in events)

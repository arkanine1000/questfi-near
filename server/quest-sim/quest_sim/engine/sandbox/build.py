"""World construction for sandbox seasons.

Lays a season onto the baked 120-hex island: terrain from elevation bands,
the boss site at the graph centroid, POI dungeon mouths on the mid rings,
and an equidistant outer spawn ring (evenly spaced by angle, randomly
rotated per seed).

Dungeon sites are instantiated from prefab templates with every entity/item
id namespaced ``{site_id}.{orig_id}`` so several sites can share one layout
without collisions. Names are left untouched — agents and the FE speak in
names.

Agents are NOT created here: the world opens as a lobby. BYO players join
first-class via the API; ``start_season`` backfills hosted agents to the
configured pool size and lands everyone on the spawn ring.
"""

from __future__ import annotations

import math
import random
import uuid

from quest_sim.engine.sandbox.rng import sub_rng

from quest_sim.content.island_tiles import ISLAND_ELEVATIONS, ISLAND_TILES
from quest_sim.models.character import Character, EntityType, Item, ItemType
from quest_sim.models.overworld import (
    HexGrid,
    OverworldTile,
    TerrainType,
    WorldPos,
    hex_distance,
    hex_key,
    hex_neighbors,
    parse_hex_key,
)
from quest_sim.models.presets import CHARACTER_PRESETS, CharacterPresetKey
from quest_sim.models.quest import ObjectiveType, quest_entrance_positions
from quest_sim.models.sandbox import (
    DungeonSite,
    SandboxAgent,
    SandboxConfig,
    SandboxWorld,
    WorldPhase,
)
from quest_sim.persistence.quest_store import StoredQuest
from quest_sim.prefabs import load_sandbox_stored_quests

# Curated spectator palette — distinct hues, readable on the dark holo
# background in both the island god-view and the crawler. Assigned by join
# order; pools past 10 wrap.
AGENT_PALETTE = [
    "#69ff8f",  # green (FE greenBright)
    "#00bfff",  # cyan
    "#ffaa00",  # amber
    "#ff5d5d",  # coral
    "#a04dff",  # violet — deepened so violet↔pink stay apart (ΔE floor)
    "#ff67d1",  # pink
    "#4d9fff",  # azure
    "#ffe14d",  # yellow
    "#ff9e58",  # orange
    "#8fffe0",  # mint
]

# The POI template pool (the boss site is placed separately, always once).
SITE_TEMPLATE_IDS = [
    "prefab-crypt-retrieve",
    "prefab-lair-boss",
    "prefab-gauntlet-reach",
    "prefab-sunken-vault",
    "prefab-howling-roost",
]
BOSS_TEMPLATE_ID = "prefab-sanctum-heart"
BOSS_SITE_NAME = "Heart of the Island"

_SHORT_NAMES = {
    "prefab-crypt-retrieve": "Crypt",
    "prefab-lair-boss": "Lair",
    "prefab-gauntlet-reach": "Gauntlet",
    "prefab-sunken-vault": "Vault",
    "prefab-howling-roost": "Roost",
}

_ROMAN = ["", " II", " III", " IV"]

# Sandbox loot re-tier: the prefabs were authored for solo play, where +2
# was the ceiling — starter-kit parity makes looting pointless here. Site
# weapons are re-rolled onto real upgrade tiers with archetype names the
# crawler's weapon catalog maps to DISTINCT viewmodels (greataxe ≠ hammer ≠
# spear...), so an equip visibly changes what's in the followed hand.
_LOOT_ARCHETYPES = [
    ("Greatsword", "greatsword"),
    ("Greataxe", "greataxe"),
    ("Warhammer", "hammer"),
    ("Boar Spear", "spear"),
    ("Reaver's Scythe", "scythe"),
    ("Raider's Axe", "axe"),
]
_TIER_ADJECTIVES = {3: "Tempered", 4: "Runed", 5: "Exalted", 6: "Sovereign"}
_POI_WEAPON_TIERS = [3, 4, 4, 5]
_BOSS_WEAPON_TIERS = [5, 6]

# Hand-authored uniques keep their own name and stats through instantiation.
# The re-tier exists to lift solo-play prefab weapons to sandbox power; these
# were written at sandbox power already, and their names are load-bearing —
# the crawler picks their viewmodel by matching the name (see weaponCatalog).
_UNIQUE_WEAPONS = {"war_accordion"}


def _retier_weapon(item: Item, rng: random.Random, boss_site: bool) -> None:
    # Ids are namespaced `{site_id}.{prefab_id}` by the time we see them.
    if item.id.rsplit(".", 1)[-1] in _UNIQUE_WEAPONS:
        return
    tier = rng.choice(_BOSS_WEAPON_TIERS if boss_site else _POI_WEAPON_TIERS)
    base, _ = rng.choice(_LOOT_ARCHETYPES)
    item.damage_bonus = tier
    item.name = f"{_TIER_ADJECTIVES[tier]} {base}"
    item.description = (
        f"A {item.name.lower()}, +{tier} to attack and damage. Worth killing for."
    )


def _relic_from_misc(item: Item, boss_site: bool) -> None:
    """Prefab quest tokens (crowns, seals) have no objective to serve here —
    the prefabs were authored for quests with win conditions, and this world
    wins on the boss instead. Make them wearable relics rather than inert
    loot that confuses agents into trying to equip them. They keep their
    names; they gain an armor-slot AC bonus."""
    item.item_type = ItemType.shield
    item.ac_bonus = 2 if boss_site else 1
    item.description = (
        f"{item.name} — a relic of the island. +{item.ac_bonus} AC while worn."
    )

# Hosted backfill roster: name + stat kit + zero-LLM policy archetype + a
# one-line persona seed for the LLM brain. BYO players take priority; these
# fill the remaining seats at season start.
HOSTED_ROSTER: list[tuple[str, str, str, str]] = [
    ("Kell", "fighter", "aggressive", "A duelist who believes hesitation is the only sin — and that rivals are just loot that fights back. Hunts challengers in the dark."),
    ("Marra", "rogue", "cautious", "A tomb-robber who plans three rooms ahead and owes nobody a rescue."),
    ("Dain", "barbarian", "greedy", "Hoards gear the way a dragon hoards grudges."),
    ("Vex", "rogue", "opportunist", "Strikes when someone else has opened the wound — then takes the kill, the loot, and the credit. Wounded rivals are invitations."),
    ("Bren", "fighter", "turtle", "A shield-bearer who outlasts rather than outfights."),
    ("Sorsha", "barbarian", "aggressive", "Counts every dawn as a countdown to glory, and every rival as a rung on the ladder. Would rather die swinging at a challenger than at a skeleton."),
    ("Tamsin", "rogue", "greedy", "Would loot a gravestone mid-sentence — and isn't above making the gravestone first."),
    ("Aldric", "fighter", "cautious", "A veteran who has seen exactly what overreach buys."),
    ("Grix", "barbarian", "opportunist", "A scavenger of other people's battles who's learned the freshest loot walks on two legs."),
    ("Yara", "fighter", "greedy", "Collects blades the way others collect debts."),
    ("Petra", "rogue", "turtle", "Survives by being nobody's problem until the end."),
    ("Mordekai", "barbarian", "cautious", "Slow to anger, impossible to stop."),
]

_PRESET_CYCLE = ["fighter", "rogue", "barbarian"]


def _graph_centroid(coords: list[tuple[int, int]]) -> tuple[int, int]:
    """The tile minimising total hex-distance to all others."""
    best, best_total = coords[0], None
    for q, r in coords:
        total = sum(hex_distance(q, r, q2, r2) for q2, r2 in coords)
        if best_total is None or total < best_total:
            best, best_total = (q, r), total
    return best


def _terrain_for_elevation(elev: float, rng: random.Random) -> TerrainType:
    """Map a normalised elevation (0..1) to a plausible terrain."""
    if elev < 0.30:
        return rng.choice([TerrainType.valley, TerrainType.clearing])
    if elev < 0.50:
        return rng.choice([TerrainType.plain, TerrainType.clearing])
    if elev < 0.65:
        return rng.choice([TerrainType.plain, TerrainType.forest])
    return TerrainType.forest


def _angle_from(origin: tuple[int, int], coord: tuple[int, int]) -> float:
    """Screen-space angle of ``coord`` around ``origin`` (axial → cartesian)."""
    dq, dr = coord[0] - origin[0], coord[1] - origin[1]
    x = dq + dr / 2
    y = dr * 0.8660254
    return math.atan2(y, x)


def _direction_adjective(origin: tuple[int, int], coord: tuple[int, int]) -> str:
    """Eight-way compass adjective for site naming ("Northern", "Southeast")."""
    # Screen-north is -y (r grows southward on the FE island).
    angle = math.degrees(_angle_from(origin, coord))  # 0 = east, 90 = south
    sector = int(((angle + 22.5) % 360) // 45)
    return [
        "Eastern", "Southeast", "Southern", "Southwest",
        "Western", "Northwest", "Northern", "Northeast",
    ][sector]


def _place_site_mouths(
    coords: list[tuple[int, int]],
    center: tuple[int, int],
    config: SandboxConfig,
    rng: random.Random,
) -> list[tuple[int, int]]:
    """Seeded POI placement on the mid rings with min pairwise spacing."""
    cq, cr = center
    candidates = [
        c for c in coords
        if config.site_ring_min <= hex_distance(c[0], c[1], cq, cr) <= config.site_ring_max
    ]
    rng.shuffle(candidates)
    chosen: list[tuple[int, int]] = []
    for spacing in range(config.site_min_spacing, 0, -1):
        chosen = []
        for c in candidates:
            if all(hex_distance(c[0], c[1], m[0], m[1]) >= spacing for m in chosen):
                chosen.append(c)
                if len(chosen) == config.num_sites:
                    return chosen
    return chosen


def pick_spawn_hexes(
    coords: list[tuple[int, int]],
    center: tuple[int, int],
    n: int,
    exclude: set[str],
    rng: random.Random,
) -> list[str]:
    """N spawn hexes: random but equidistant from the island center.

    Uses the largest exact-distance ring that seats everyone with decent
    compass coverage (the island is elongated, so far rings hug two coasts —
    strictly equal distance beats raw remoteness for fairness), then walks
    ``n`` evenly spaced target angles from a random rotation, snapping each
    to the nearest unused ring tile. Evenly dispersed, exactly equidistant,
    differently placed every season.
    """
    cq, cr = center

    def dist(c: tuple[int, int]) -> int:
        return hex_distance(c[0], c[1], cq, cr)

    def max_gap(tiles: list[tuple[int, int]]) -> float:
        angs = sorted(_angle_from(center, t) % (2.0 * math.pi) for t in tiles)
        return max(
            (angs[(i + 1) % len(angs)] - angs[i]) % (2.0 * math.pi)
            for i in range(len(angs))
        )

    usable = [c for c in coords if hex_key(*c) not in exclude]
    rings: dict[int, list[tuple[int, int]]] = {}
    for c in usable:
        rings.setdefault(dist(c), []).append(c)

    band: list[tuple[int, int]] = []
    for radius in sorted(rings, reverse=True):
        ring = rings[radius]
        if len(ring) >= n and max_gap(ring) <= math.radians(60):
            band = ring
            break
    if not band:  # coastline too ragged — fall back to the biggest ring
        band = max(rings.values(), key=len)
    if len(band) < n:
        band = usable

    rotation = rng.uniform(0.0, 2.0 * math.pi)
    remaining = list(band)
    chosen: list[tuple[int, int]] = []
    for i in range(n):
        want = (rotation + i * 2.0 * math.pi / n) % (2.0 * math.pi)

        def gap(c: tuple[int, int]) -> float:
            have = _angle_from(center, c) % (2.0 * math.pi)
            d = abs(have - want)
            return min(d, 2.0 * math.pi - d)

        # Nearest-by-angle first; among near-ties prefer the farther tile.
        best = min(remaining, key=lambda c: (round(gap(c), 3), -dist(c)))
        remaining.remove(best)
        chosen.append(best)
    return [hex_key(*c) for c in chosen]


def _instantiate_site(
    site_id: str,
    template_id: str,
    stored: StoredQuest,
    display_name: str,
    mouth_key: str,
    island_keys: set[str],
    used_hexes: set[str],
    seed: int = 0,
) -> DungeonSite:
    """A fresh shared interior from a template: ids namespaced, NPCs stripped,
    mutable flags reset, weapons re-tiered for the season economy, entrance
    rooms mapped to overworld hexes."""
    grid = stored.map_grid.model_copy(deep=True)
    boss_site = template_id == BOSS_TEMPLATE_ID

    # Namespace entities, dropping NPCs (the sandbox's social layer is the agents).
    entities: dict[str, Character] = {}
    for old_id, char in stored.entities.items():
        if char.entity_type == EntityType.npc:
            continue
        clone = char.model_copy(deep=True)
        clone.id = f"{site_id}.{old_id}"
        entities[clone.id] = clone

    items: dict[str, Item] = {}
    for item in stored.quest.items:
        clone = item.model_copy(deep=True)
        clone.id = f"{site_id}.{item.id}"
        if clone.item_type == ItemType.weapon:
            _retier_weapon(clone, sub_rng(seed, "loot", clone.id), boss_site)
        elif clone.item_type == ItemType.misc:
            _relic_from_misc(clone, boss_site)
        items[clone.id] = clone

    for room in grid.rooms.values():
        namespaced_ids = []
        for eid in room.entity_ids:
            src = stored.entities.get(eid)
            if src is not None and src.entity_type == EntityType.npc:
                continue
            namespaced_ids.append(f"{site_id}.{eid}")
        room.entity_ids = namespaced_ids
        room.treasure_item_ids = [f"{site_id}.{t}" for t in room.treasure_item_ids]
        # Shared interiors: the solo fog flag is meaningless here (per-agent
        # visited sets govern sandbox fog) — normalise everything pristine.
        room.visited = False
        room.searched = False
        room.trap_triggered = False

    # Entrance rooms → overworld hexes. The first entrance is the mouth; each
    # extra surfaces on a free neighbouring hex (a through-route), falling
    # back to the mouth hex if the coast crowds us out.
    entrances: dict[str, str] = {}
    entrance_positions = quest_entrance_positions(stored.quest)
    for i, (er, ec) in enumerate(entrance_positions):
        room_key = f"{er},{ec}"
        if i == 0:
            entrances[room_key] = mouth_key
            used_hexes.add(mouth_key)
            continue
        mq, mr = parse_hex_key(mouth_key)
        chosen = mouth_key
        for nq, nr in hex_neighbors(mq, mr):
            candidate = hex_key(nq, nr)
            if candidate in island_keys and candidate not in used_hexes:
                chosen = candidate
                break
        entrances[room_key] = chosen
        used_hexes.add(chosen)

    boss_id = None
    objective = stored.quest.objective
    if objective is not None and objective.type == ObjectiveType.defeat_boss:
        boss_id = f"{site_id}.{objective.target_id}"

    return DungeonSite(
        site_id=site_id,
        template_quest_id=template_id,
        name=display_name,
        map_grid=grid,
        entities=entities,
        items=items,
        entrances=entrances,
        boss_id=boss_id,
    )


def build_world(config: SandboxConfig | None = None, *, seed: int = 0) -> SandboxWorld:
    """Construct a season world in the lobby phase. Deterministic given seed.

    Island + terrain + dungeon sites + the central boss site; no agents yet.
    """
    config = config or SandboxConfig()
    world = SandboxWorld(seed=seed, config=config)

    coords = list(ISLAND_TILES)
    island_keys = {hex_key(q, r) for q, r in coords}
    center = _graph_centroid(coords)
    world.center_hex = hex_key(*center)

    # Terrain from elevation bands (per-tile keyed rng: order-independent).
    grid = HexGrid()
    for q, r in coords:
        elev = ISLAND_ELEVATIONS.get(hex_key(q, r), 0.4)
        terrain = _terrain_for_elevation(elev, sub_rng(seed, "terrain", q, r))
        grid.set(OverworldTile(q=q, r=r, terrain=terrain))
    world.overworld = grid

    # Dungeon sites: POI mouths from the 5-template pool + the boss site.
    templates = load_sandbox_stored_quests()
    mouths = _place_site_mouths(coords, center, config, sub_rng(seed, "mouths"))
    if len(mouths) < config.num_sites:
        raise ValueError(
            f"Only {len(mouths)} mouth hexes fit rings "
            f"{config.site_ring_min}-{config.site_ring_max}; need {config.num_sites}"
        )
    pool = SITE_TEMPLATE_IDS * (config.num_sites // len(SITE_TEMPLATE_IDS) + 1)
    pool = pool[: config.num_sites]
    sub_rng(seed, "sites").shuffle(pool)

    used_hexes: set[str] = {world.center_hex}
    name_counts: dict[str, int] = {}
    for i, (mouth, template_id) in enumerate(zip(mouths, pool)):
        site_id = f"site_{i + 1}"
        base = f"The {_direction_adjective(center, mouth)} {_SHORT_NAMES[template_id]}"
        count = name_counts.get(base, 0)
        name_counts[base] = count + 1
        display_name = base + _ROMAN[min(count, len(_ROMAN) - 1)]
        site = _instantiate_site(
            site_id, template_id, templates[template_id], display_name,
            hex_key(*mouth), island_keys, used_hexes, seed=seed,
        )
        world.sites[site_id] = site

    boss_site = _instantiate_site(
        "boss_site", BOSS_TEMPLATE_ID, templates[BOSS_TEMPLATE_ID],
        BOSS_SITE_NAME, world.center_hex, island_keys, used_hexes, seed=seed,
    )
    world.sites["boss_site"] = boss_site
    world.boss_site_id = "boss_site"

    # Mark every entrance hex as a mouth tile pointing at its site.
    for site in world.sites.values():
        for target_hex in site.entrances.values():
            tile = world.overworld.get_key(target_hex)
            if tile is not None:
                tile.terrain = TerrainType.dungeon_mouth
                tile.site_id = site.site_id

    return world


def _agent_character(preset_key: str, name: str, agent_id: str) -> Character:
    """A competitor's body — preset stats + namespaced starter weapon."""
    preset = CHARACTER_PRESETS[CharacterPresetKey(preset_key)]
    weapon = Item(
        id=f"{agent_id}.{preset.starter_weapon_id}",
        name=preset.starter_weapon_name,
        item_type=ItemType.weapon,
        damage_bonus=preset.starter_weapon_damage,
        description=f"{name}'s {preset.starter_weapon_name.lower()}, carried onto the island.",
    )
    return Character(
        id=agent_id,
        name=name,
        entity_type=EntityType.player,
        hp=preset.hp,
        max_hp=preset.max_hp,
        ac=preset.ac,
        abilities=preset.abilities.model_copy(),
        inventory=[weapon],
        equipped_weapon=weapon.id,
        position=(0, 0),
        description=preset.description,
    )


def _unique_name(world: SandboxWorld, requested: str | None) -> str:
    """Sanitize a requested display name and uniquify it across the roster."""
    base = (requested or "").strip()[:20] or f"Challenger {len(world.agents) + 1}"
    taken = {a.name.lower() for a in world.agents.values()}
    name, suffix = base, 2
    while name.lower() in taken:
        name = f"{base} {suffix}"
        suffix += 1
    return name


def create_agent(
    world: SandboxWorld,
    *,
    name: str | None = None,
    preset: str | None = None,
    brain: str = "external",
    disposition: str = "balanced",
    persona: str = "",
) -> SandboxAgent:
    """Add one agent to the roster (lobby only). Color/id follow join order.

    External agents get an opaque auth token; hosted agents don't need one.
    """
    if world.phase != WorldPhase.lobby:
        raise ValueError("agents can only join while the world is in the lobby phase")
    if len(world.agents) >= world.config.pool_size:
        raise ValueError(f"the roster is full ({world.config.pool_size} seats)")

    index = len(world.agents)
    agent_id = f"agent-{index + 1:02d}"
    display_name = _unique_name(world, name)
    if preset is None:
        preset = _PRESET_CYCLE[index % len(_PRESET_CYCLE)]
    if preset not in {p.value for p in CharacterPresetKey}:
        raise ValueError(f"unknown preset '{preset}'")

    agent = SandboxAgent(
        agent_id=agent_id,
        name=display_name,
        brain=brain,
        token=uuid.uuid4().hex if brain == "external" else "",
        color=AGENT_PALETTE[index % len(AGENT_PALETTE)],
        persona=persona,
        disposition=disposition,
        preset=preset,
        character=_agent_character(preset, display_name, agent_id),
    )
    world.agents[agent_id] = agent
    return agent


def backfill_hosted(world: SandboxWorld) -> list[SandboxAgent]:
    """Fill remaining roster seats with hosted agents from the cast."""
    taken = {a.name.lower() for a in world.agents.values()}
    added: list[SandboxAgent] = []
    roster = [m for m in HOSTED_ROSTER if m[0].lower() not in taken]
    while len(world.agents) < world.config.pool_size:
        if roster:
            name, preset, disposition, persona = roster.pop(0)
        else:
            name, preset, disposition, persona = None, None, "balanced", ""
        added.append(
            create_agent(
                world, name=name, preset=preset, brain="hosted",
                disposition=disposition, persona=persona,
            )
        )
    return added


def start_season(world: SandboxWorld) -> list[SandboxAgent]:
    """Backfill hosted agents, land everyone on the spawn ring, go live.

    Spawn hexes are equidistant from the island center, evenly spread by
    angle, rotated randomly per seed; seats are assigned in join order.
    Returns the hosted agents added by the backfill.
    """
    if world.phase != WorldPhase.lobby:
        raise ValueError("season already started")
    added = backfill_hosted(world)

    coords = list(ISLAND_TILES)
    mouth_hexes = {
        tile.key for tile in world.overworld.tiles.values() if tile.site_id is not None
    }
    spawn_keys = pick_spawn_hexes(
        coords,
        parse_hex_key(world.center_hex),
        len(world.agents),
        mouth_hexes,
        sub_rng(world.seed, "spawns"),
    )
    world.spawn_ring = spawn_keys
    for agent, spawn in zip(world.agents.values(), spawn_keys):
        q, r = parse_hex_key(spawn)
        agent.spawn_hex = spawn
        agent.position = WorldPos.at_hex(q, r)
        tile = world.overworld.get_key(spawn)
        if tile is not None:
            tile.occupants.append(agent.agent_id)

    world.phase = WorldPhase.running
    return added

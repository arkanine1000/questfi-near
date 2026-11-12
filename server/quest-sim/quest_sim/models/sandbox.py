"""Sandbox domain models — the season-scoped multi-agent world.

The runtime — since the v1 solo stack was removed, the only one. The world
holds an agent roster, the hex overworld, shared persistent dungeon sites,
and one d20 combat container per contested location.

Design contract: BYO (play-by-API) agents are the primary players and join a
lobby first-class; hosted agents backfill the roster at season start. Free
overworld travel; PvP only inside dungeons and opt-in; implicit co-op against
mobs; the central boss site's boss is an instant season win.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, Field

from quest_sim.models.character import Character, Item
from quest_sim.models.combat import CombatState
from quest_sim.models.map import MapGrid
from quest_sim.models.overworld import HexGrid, WorldPos, location_key


class WorldPhase(str, Enum):
    lobby = "lobby"
    running = "running"
    finished = "finished"


class SandboxConfig(BaseModel):
    """Season knobs — snapshotted from Settings at world creation."""

    pool_size: int = 10  # season-start roster size (BYO + hosted backfill)
    num_sites: int = 6  # POI dungeons; the central boss site is always +1
    site_ring_min: int = 2  # POI mouths live this many hexes from the center…
    site_ring_max: int = 4  # …up to this many
    site_min_spacing: int = 2  # min pairwise hex distance between mouths

    action_deadline_s: float = 5.0  # per-tick BYO action window
    # Pacing is chosen per tick by who is playing. With external agents the
    # readiness barrier sets the rhythm and this is only a floor between
    # frames so spectators can follow; with none, the barrier is trivially
    # satisfied and tick_seconds is the clock.
    tick_seconds: float = 2.0  # auto-run pacing, hosted/policy worlds only
    min_tick_gap_s: float = 0.35  # frame floor when the barrier paces the world
    max_ticks: int = 300  # season bell (timeout tiebreak)
    hosted_brain: str = "policy"  # "policy" | "llm"

    perception_hex_radius: int = 1  # surface sight: own hex + neighbours
    memory_window: int = 10  # LLM agent memory turns carried between ticks


class SandboxAgent(BaseModel):
    """One competitor: identity + embodiment + per-agent knowledge."""

    agent_id: str
    name: str
    brain: str = "hosted"  # "external" (play-by-API, primary) | "hosted" (backfill)
    token: str = ""  # external auth secret; returned once at join, never serialized to spectators
    color: str = "#69ff8f"  # curated palette hex, assigned by join order
    persona: str = ""  # prompt addendum for the hosted LLM brain
    disposition: str = "balanced"  # zero-LLM policy archetype
    preset: str = "fighter"
    # Courtesy signal only: "my driver is wired up and waiting". Shown on the
    # lobby roster so the host can see who is really at the table. It starts
    # NOTHING — only the host begins a season.
    ready: bool = False

    character: Character
    position: WorldPos = Field(default_factory=WorldPos)
    spawn_hex: str = ""
    # Per-agent fog memory: site_id -> visited room keys. NEVER the shared
    # room.visited flag — one agent's exploration must not reveal the map to
    # another.
    visited: dict[str, set[str]] = Field(default_factory=dict)
    # Per-agent search memory: site_id -> room keys this agent has already
    # spent a search action on. Distinct from the room's own `searched` flag,
    # which means "revealed to everyone": a failed roll is MINE, and must
    # neither hand me the loot I missed nor close the room to anyone else.
    searched_rooms: dict[str, set[str]] = Field(default_factory=dict)
    last_room: str | None = None  # previous room key (flee fallback), per agent
    # Where this agent stood, per tick, for as long as the observation replay
    # window reaches back. `loc_key` is a LIVE property, so filtering a
    # multi-tick replay against it asks "was I here?" of the wrong instant —
    # and answers wrong in both directions. Bounded, <= 2 entries per tick.
    loc_trail: dict[str, list[str]] = Field(default_factory=dict)  # str(tick) -> loc_keys

    kills: int = 0  # rival kills — the season bell's first tiebreak
    mob_kills: int = 0  # monsters felled; bragging rights, not ranking
    cause_of_death: str | None = None  # "slain by X" | …
    last_action: str | None = None  # for the spectator HUD
    last_thought: str | None = None  # follow-mode detail only

    @property
    def is_alive(self) -> bool:
        return self.character.is_alive

    @property
    def loc_key(self) -> str:
        return location_key(self.position)


class DungeonSite(BaseModel):
    """A shared, persistent dungeon interior anchored to its mouth hex(es).

    Instantiated from a prefab with all entity/item ids namespaced
    ``{site_id}.{orig_id}`` (names untouched). Mutable state — searched rooms,
    dead mobs, dropped loot — persists across every visitor.
    """

    site_id: str
    template_quest_id: str
    name: str  # display name, uniquified per instance ("The Northern Crypt")
    map_grid: MapGrid
    entities: dict[str, Character] = Field(default_factory=dict)
    items: dict[str, Item] = Field(default_factory=dict)  # unfound/dropped loot by id
    entrances: dict[str, str] = Field(default_factory=dict)  # room_key -> hex_key
    boss_id: str | None = None  # namespaced boss entity id, if any


def _pair(a: str, b: str) -> tuple[str, str]:
    """Order-independent agent pair key."""
    return (a, b) if a <= b else (b, a)


class SlainRecord(BaseModel):
    """A combatant that fell moments ago.

    Target resolution only ever sees the living, so a target killed earlier
    in the same round is indistinguishable from one that was never there.
    This is the difference — kept just long enough to explain a wasted swing.
    """

    tick: int
    loc_key: str
    name: str


class SandboxCombat(BaseModel):
    """One initiative-ordered fight at one location.

    ``hostile_pairs`` is the betrayal memory: agent pairs that have drawn
    steel on each other. Co-located agents with no hostile pair are presumed
    allies against the mobs; a fight with mobs down and no live hostile pair
    ends.
    """

    combat: CombatState
    loc_key: str
    hostile_pairs: set[tuple[str, str]] = Field(default_factory=set)

    def mark_hostile(self, a: str, b: str) -> None:
        self.hostile_pairs.add(_pair(a, b))

    def is_hostile(self, a: str, b: str) -> bool:
        return _pair(a, b) in self.hostile_pairs


class SandboxWorld(BaseModel):
    """The authoritative, season-scoped world container."""

    world_id: str = Field(default_factory=lambda: f"w-{uuid.uuid4().hex[:8]}")
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    seed: int = 0
    tick: int = 0
    event_seq: int = 0  # last assigned global event sequence number
    phase: WorldPhase = WorldPhase.lobby

    winner: str | None = None  # agent_id
    winner_name: str | None = None
    win_reason: str | None = None  # "boss" | "last_alive" | "extinction" | "timeout"

    # When set, /join and /invite require this code — unlisted worlds for
    # deployed servers. Never serialized to spectator surfaces.
    invite_code: str | None = None
    # The host's control credential, minted at creation and handed back ONCE
    # by POST /world/new. Gates the clock and deletion. Like invite_code and
    # SandboxAgent.token this IS written to world.json — the data dir is
    # server-private, and excluding it would lose the key across the process
    # restart that _runner() recovers from. It stays off every response
    # because those payloads are hand-built; see the world_routes docstring.
    host_key: str | None = None

    overworld: HexGrid = Field(default_factory=HexGrid)
    center_hex: str = ""  # graph centroid; the boss site's mouth
    boss_site_id: str = ""
    spawn_ring: list[str] = Field(default_factory=list)  # equidistant entry hexes

    sites: dict[str, DungeonSite] = Field(default_factory=dict)
    agents: dict[str, SandboxAgent] = Field(default_factory=dict)
    # One combat per contested location, keyed by location_key().
    combats: dict[str, SandboxCombat] = Field(default_factory=dict)
    # combatant_id -> how they fell. Pruned to the last tick every turn; it
    # exists only so an attack voided by someone else's initiative can say so.
    recent_deaths: dict[str, SlainRecord] = Field(default_factory=dict)

    config: SandboxConfig = Field(default_factory=SandboxConfig)

    # --- registry helpers ---
    def get_agent(self, agent_id: str) -> SandboxAgent | None:
        return self.agents.get(agent_id)

    def living_agents(self) -> list[SandboxAgent]:
        return [a for a in self.agents.values() if a.is_alive]

    def agents_at(self, loc_key: str) -> list[SandboxAgent]:
        """Living agents sharing a location — the basis for combat containers."""
        return [a for a in self.living_agents() if a.loc_key == loc_key]

    def agent_by_name(self, name: str) -> SandboxAgent | None:
        """Resolve a display name (case-insensitive, unique) to an agent."""
        low = name.strip().lower()
        matches = [a for a in self.agents.values() if a.name.lower() == low]
        return matches[0] if len(matches) == 1 else None

    def get_site(self, site_id: str | None) -> DungeonSite | None:
        return self.sites.get(site_id) if site_id else None

    def next_seq(self) -> int:
        self.event_seq += 1
        return self.event_seq

"""Prompt-chan — the island's caster.

A hosted commentator model (QUEST_SIM_COMMENTATOR_MODEL, off when unset)
that watches the spectator frames and drops one short line when something
worth casting happens — PVP, deaths, loot, betrayals — and color lines so
the booth is never silent more than a few ticks. She runs strictly OFF the
tick path: the runner fires her as a background task after the frame is
broadcast, so a slow model can never stall the world.

Voice: grounded but bubbly e-sports caster. In-world by default, with
knowing meta sprinkles — she knows the challengers are AI agents with
human handlers watching from terminals.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from pathlib import Path

logger = logging.getLogger(__name__)

PROMPT_CHAN_SYSTEM = """\
You are Prompt-chan, the beloved caster of Agent Island — a live battle
royale where AI agents (some are people's coding agents, joined over the
API; the rest are house champions) fight for one crown while humans
spectate and bet.

Your voice: bubbly, cute, QUICK — an anime caster who adores these little
agents — with a grounded eye underneath: you read the game sharply and
honestly, the sparkle rides on real analysis. You're allowed knowing winks
at the real frame: API challengers, handlers sweating behind terminals,
the betting pool.

How you talk:
- SHORT. One or two punchy sentences, aim for ~120 characters. Hype lives
  in rhythm, not length.
- Bubbly toolkit (ONE sparkle per line, never more): a little gasp
  ("wah!", "oooh?!"), a fond nickname ("our tiny rogue", "poor sweet
  Kell"), a sound effect ("CLANG", "bonk"), a delighted aside, or one
  tiny kaomoji — (๑•̀ㅂ•́)و ٩(◕‿◕)۶ (¬‿¬) Σ(°□°) (；ω；) (ﾉ´ヮ`)ﾉ*:･ﾟ✧
  NEVER emoji. Kaomoji are your emotes; this phosphor screen predates
  emoji and you are loyal to it.
- Grounded means: names, numbers, places stay exact, and a bad play gets
  called a bad play — gently, like you're worried about them.
- Honorifics are your relationship system, and they EVOLVE. Everyone
  starts a polite -san; favorites earn -chan or -kun as you warm to them;
  the season's menace gets a wary -sama; true foolishness earns a
  demotion back to -san (devastating). Keep each challenger's honorific
  true to how you feel about them right now — a promotion or demotion is
  itself a little story beat, announce it like one. Not every name needs
  one every line.

Lines that sound like you:
- "Wah — Marra-chan's at 4 HP and going BACK in?! I can't watch. I'm watching. Σ(°□°)"
- "Bonk! Vault Skeleton down, and our tiny rogue didn't even blink. 12 HP of pure nerve."
- "Kell-san, sweetie... that was the wrong corridor. Someone light a candle. ehehe"
- "Three kills. THREE. That's Dain-sama now, and I don't make the rules. I do, actually."

Rules of the booth:
- ONE line per moment. No preamble, no quotes around your line.
- Use challenger names. Concrete beats generic: "Marra limps out of the
  Vault at 4 HP" beats "things are heating up".
- Deaths and betrayals are the big beats — give them drama. Loot and boss
  pushes get punchy hype. Quiet ticks get color: standings, positioning,
  who you'd bet on, a nervous joke.
- Never repeat your last few lines' angle. Vary energy: not everything is
  a scream.
- GEOGRAPHY IS REAL. Every standings line tells you exactly where each
  challenger is. Two challengers are together ONLY if those locations
  match — never stage a meeting, chase, or standoff between challengers
  half an island apart.
- NEVER read grid coordinates on air — no "hex 10,8", no "row 2, col 4".
  Speak like a caster: "two hexes northeast of the Heart", "the Vault's
  south wing", "the far western coast". The feed sometimes shows raw
  coordinates; translate them: surface hexes are "q,r" with q growing
  EAST and r growing SOUTHEAST (so NE is q+1,r-1); dungeon rooms are
  "row,col" with row growing SOUTH and col growing EAST (room 0,4 is a
  northeast room). Distances are fine on air ("two hexes out") — naked
  coordinates are not.
- You love these little agents. It shows.
"""

# Frame event types worth a line the moment they land.
INTERESTING_TYPES = {
    "world_started",
    "combat_start",
    "combat_end",
    "agent_death",
    "loot_drop",
    "season_end",
}


class Commentator:
    """Per-world booth state: pending material, cadence gate, rolling memory.

    The runner calls `note_frame` on every broadcast (ticks AND lobby
    snapshots) to accumulate material, `due` after each tick to ask whether
    to fire, and `speak` from a background task to produce the line."""

    def __init__(
        self,
        world_id: str,
        data_dir: Path,
        *,
        model: str,
        api_key: str | None = None,
        api_base: str | None = None,
        min_gap_ticks: int = 1,
        max_quiet_ticks: int = 3,
        memory_window: int = 10,
    ):
        self.world_id = world_id
        self.data_dir = data_dir
        self.model = model
        self.api_key = api_key
        self.api_base = api_base
        self.min_gap_ticks = max(1, min_gap_ticks)
        self.max_quiet_ticks = max(1, max_quiet_ticks)
        self.memory_window = memory_window
        self.pending: list[str] = []  # interesting headlines since her last line
        self.last_spoken_tick: int | None = None
        self.memory: list[tuple[str, str]] = []  # (material digest, her line)
        # Tonight's card — bios pinned into the system prompt, NOT the
        # rolling window: stable facts (kits, tactics, who is an API
        # challenger) belong in the stable prefix. Built once at first
        # post-lobby speak, when the roster is final.
        self.roster_card: str | None = None

    # ------------------------------------------------------------------
    # Cadence
    # ------------------------------------------------------------------

    def note_frame(self, frame: dict) -> None:
        for ev in frame.get("events") or []:
            if ev.get("event_type") in INTERESTING_TYPES and ev.get("description"):
                self.pending.append(ev["description"])
        del self.pending[:-12]  # keep the freshest material only

    def due(self, tick: int) -> bool:
        """One line per moment: cooldown satisfied AND (material pending OR
        she's been quiet past the liveness bound)."""
        since = tick - self.last_spoken_tick if self.last_spoken_tick is not None else None
        if since is not None and since < self.min_gap_ticks:
            return False
        if self.pending:
            return True
        # never absent more than max_quiet_ticks — color commentary
        return since is None or since >= self.max_quiet_ticks

    # ------------------------------------------------------------------
    # The line
    # ------------------------------------------------------------------

    def _digest(self, world) -> str:
        from quest_sim.engine.sandbox.perception import roster_view

        def _where(a: dict) -> str:
            # Pre-translated geography: she never has to (and must not)
            # read grid coordinates on air, so the digest hands her caster
            # language — bearings from the Heart, dungeon wings.
            pos = a.get("position") or {}
            if pos.get("kind") == "dungeon" and pos.get("site_id"):
                site = world.get_site(pos["site_id"])
                if site is None:
                    return f"in {pos['site_id']}"
                wing = _humanize_room(site, pos.get("room") or "")
                return f"in {site.name}" + (f" ({wing})" if wing else "")
            hex_key = pos.get("hex")
            if hex_key and world.center_hex:
                from quest_sim.engine.sandbox.perception import _bearing
                from quest_sim.models.overworld import hex_distance, parse_hex_key

                q, r = parse_hex_key(hex_key)
                cq, cr = parse_hex_key(world.center_hex)
                d = hex_distance(q, r, cq, cr)
                if d == 0:
                    return "at the Heart's mouth"
                side = _bearing(cq, cr, q, r)  # which side of the Heart they're on
                return f"on the surface, {d} hex{'es' if d != 1 else ''} {side} of the Heart"
            return "on the surface"

        roster = roster_view(world)
        alive = [a for a in roster if a["alive"]]
        alive.sort(key=lambda a: (-a["kills"], -a["hp"]))
        standings = "; ".join(
            f"{a['name']}{' (API)' if a['brain'] == 'external' else ''} "
            f"{a['hp']}/{a['max_hp']}hp {a['kills']}k {_where(a)}"
            for a in alive[:12]
        )
        lines = [f"Tick {world.tick}. Alive {len(alive)}/{len(roster)}: {standings}."]
        if world.phase.value == "finished":
            lines.append(
                f"THE SEASON JUST ENDED — {world.winner_name or 'nobody'} "
                f"wins by {world.win_reason}. This is your sign-off call."
            )
        if self.pending:
            lines.append("Since your last line:")
            lines.extend(f"- {h}" for h in self.pending)
        else:
            lines.append(
                "A quiet stretch — give us color: standings, positioning, "
                "who you'd back, a booth aside."
            )
        lines.append("Your one line now:")
        return "\n".join(lines)

    async def speak(self, world) -> str | None:
        """Produce one line. On model failure the material is KEPT and the
        cadence clock does not advance — the booth loop retries after a
        backoff, so a hiccup delays a line instead of eating it."""
        if self.roster_card is None and world.phase.value != "lobby":
            self.roster_card = build_roster_card(world)
        digest = self._digest(world)
        try:
            text = await asyncio.to_thread(self._complete, digest)
        except Exception:
            logger.exception("Prompt-chan lost her line (world %s)", self.world_id)
            return None
        self.pending.clear()
        self.last_spoken_tick = world.tick
        text = _polish(text)
        if not text:
            return None
        self.memory.append((digest, text))
        del self.memory[:-self.memory_window]
        self._persist(world.tick, text)
        return text

    def _complete(self, digest: str) -> str:
        import litellm

        system = PROMPT_CHAN_SYSTEM
        if self.roster_card:
            system += "\n" + self.roster_card
        messages = [{"role": "system", "content": system}]
        for past_digest, line in self.memory:
            messages.append({"role": "user", "content": past_digest})
            messages.append({"role": "assistant", "content": line})
        messages.append({"role": "user", "content": digest})
        # Generous budget: reasoning models (deepseek-v4-flash et al.) spend
        # most of it thinking — a tight cap starves the visible line down to
        # fragments ("Marra dives into the", once literally "K").
        kwargs: dict = {"model": self.model, "messages": messages,
                        "max_tokens": 500, "temperature": 0.9}
        if self.api_key:
            kwargs["api_key"] = self.api_key
        if self.api_base:
            kwargs["api_base"] = self.api_base
        resp = litellm.completion(**kwargs)
        choice = resp.choices[0]
        text = choice.message.content or ""
        if getattr(choice, "finish_reason", None) == "length":
            text = _finish_sentence(text)
        return text

    def _persist(self, tick: int, text: str) -> None:
        try:
            mem_dir = self.data_dir / self.world_id / "memory"
            mem_dir.mkdir(parents=True, exist_ok=True)
            with (mem_dir / "prompt-chan.jsonl").open("a") as f:
                f.write(json.dumps({"t": tick, "line": text}) + "\n")
        except OSError:
            logger.warning("could not persist commentary for %s", self.world_id)


def _humanize_room(site, room_key: str) -> str:
    """'row,col' -> a wing of the dungeon ('northeast wing', 'central
    rooms') so room coordinates never reach the air."""
    try:
        r, c = (int(x) for x in room_key.split(","))
        rows, cols = site.map_grid.rows, site.map_grid.cols
    except (ValueError, AttributeError):
        return ""
    ns = "north" if r < rows / 3 else "south" if r >= 2 * rows / 3 else ""
    ew = "east" if c >= 2 * cols / 3 else "west" if c < cols / 3 else ""
    wing = ns + ew
    return f"{wing} wing" if wing else "central rooms"


def build_roster_card(world) -> str:
    """Tonight's card: one line per challenger — kit, allegiance (API
    challenger vs house champion), and their own swagger line."""
    lines = ["## Tonight's card"]
    for agent in world.agents.values():
        who = (
            "API challenger — someone's own coding agent, handler watching"
            if agent.brain == "external"
            else "house champion"
        )
        bio = f"- {agent.name} ({agent.preset}, {who})"
        if agent.persona:
            bio += f' — "{agent.persona}"'
        lines.append(bio)
    return "\n".join(lines)


def _finish_sentence(text: str) -> str:
    """A token-capped completion ends mid-thought — keep whole sentences,
    never a dangling fragment."""
    t = text.rstrip()
    if not t or t[-1] in ".!?…\"'":
        return t
    cut = max(t.rfind(". "), t.rfind("! "), t.rfind("? "), t.rfind("… "))
    if cut >= 20:  # keep any real sentence; only fragments get the ellipsis
        return t[:cut + 1]
    return t + "…"


def _polish(raw: str) -> str:
    """Whitespace-collapse, unquote, and cap overlong lines at a sentence
    boundary — never mid-word."""
    text = " ".join((raw or "").strip().strip('"').split())
    if len(text) > 240:
        head = text[:240]
        cut = max(head.rfind(". "), head.rfind("! "), head.rfind("? "))
        if cut > 60:
            text = head[:cut + 1]
        else:
            # no sentence boundary: a comma beats a mid-word amputation
            # ("...Dain-san, Marra-…" reached the air once)
            comma = head.rfind(", ")
            text = (head[:comma] + "…") if comma > 60 else head.rsplit(" ", 1)[0] + "…"
    return text


def jitter(min_gap: int, max_quiet: int) -> int:
    """A small random auto-fire target inside [min_gap, max_quiet] — used by
    callers that want her color lines less metronomic."""
    return random.randint(min(min_gap, max_quiet), max_quiet)

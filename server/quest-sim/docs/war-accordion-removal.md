# Removing the War Accordion

The War Accordion is a demo easter egg: a joke weapon whose entire payload is
visual. This is the note for deleting it cleanly afterwards, and the honest
accounting of what it cost.

Written 2026-08-14, against the commit that added it. It spans two repos.

---

## TL;DR

**~640 lines across 12 files, plus one 287 KB asset.** Measured, not estimated:

| | lines | fate |
|---|---:|---|
| The gag itself | ~350 | delete — the lists below |
| `loaderFor()` + spec-keyed preload | ~40 | **keep**, it fixes a latent bug |
| The dev weapon bench | ~236 | keep by decision, weapon-agnostic |

Backend is 39 insertions across 3 files; everything else is frontend. The two
largest single pieces are `weaponRigs.js` (130 lines, all gag) and
`WeaponBench.jsx` (222 lines, all keeper).

Nothing in the engine, combat, event, or perception layers was touched. The
accordion is a prefab item and a frontend render path, nothing more.

---

## Delete: backend (`quest-sim`)

| File | What | Note |
|---|---|---|
| `quest_sim/prefabs/howling_roost.json` | The `war_accordion` item block + its id in `treasure_item_ids` | **Restore `talon_dagger`** in both places, or the Roost has no weapon at all |
| `quest_sim/engine/sandbox/build.py` | `_UNIQUE_WEAPONS` set + the early return at the top of `_retier_weapon` | Delete both; nothing else references them |
| `tests/test_sandbox_build.py` | `test_war_accordion_survives_the_loot_retier` | Delete |

The original `talon_dagger`, for restoring:

```json
{ "id": "talon_dagger", "name": "Talon Dagger", "item_type": "weapon",
  "damage_bonus": 1,
  "description": "A harpy's sheared talon set into a leather grip — light, wicked, and always slightly warm." }
```

No other backend test, fixture, or invariant knows the accordion exists —
that was the point of giving it +5/+5 with `to_hit_bonus` unset.

## Delete: frontend (`quest-map`)

| File | What |
|---|---|
| `public/crawler/models/weapons/accordion.glb` | The asset (287 KB) |
| `src/components/Scene3D/Crawler/weaponRigs.js` | **Whole file.** Accordion-only |
| `src/components/Scene3D/Crawler/weaponCatalog.js` | The `/accordion\|squeezebox\|concertina/` entry, `GiAccordion` import, and the three optional-field lines in the header comment |
| `src/components/Scene3D/Crawler/CrawlerWeapon.jsx` | `RiggedWeaponModel`, `playPose`, the `weaponRigs` import, and the `spec.rig` ternary in the returned JSX |
| `src/components/Scene3D/Crawler/sfx.js` | `MUSETTE_DETUNE`, `reedChord`, and `case 'accordion'` |
| `src/components/Sandbox/CrawlerAgents.jsx` | The `if (spec.hold)` branch in `makeHeldWeapon` |
| `src/components/Sandbox/SandboxCrawler.jsx` | The per-weapon cue lookup — revert to the one-line `const cue = …` ternary, drop the `weaponSpecFor` import and `agent.weapon` from the dep array |

### Judgement calls, not clear-cut

- **`DEFAULT_HOLD` / the `hold` indirection in `CrawlerWeapon.jsx`.** Introduced
  for the accordion, but it is what lets any weapon opt out of the blade
  pipeline. Three lines. Keep it if another odd-shaped weapon is plausible;
  delete it and inline `HOLD_OFFSET`/`HOLD_ROTATION` if not.
- **`useWeaponModel`.** Only exists because GLTF and FBX unwrap differently.
  If the accordion goes and every weapon is FBX again, it can be inlined —
  but see the keeper below before deciding.

---

## Keep regardless: `loaderFor()`

**This is the one thing here that improved the codebase.**

Before, three separate places hardcoded `FBXLoader` for weapon models:
`crawlerAssets.js`'s preload loop, `CrawlerWeapon.jsx`, and
`CrawlerAgents.jsx`. Two problems, both latent:

1. r3f caches loads under `[LoaderClass, ...urls]`. The preloader and the
   component had to agree on the class or the warm-up silently missed and the
   asset loaded on screen instead of behind the loading gate — the exact
   failure `crawlerAssets.js`'s header comment warns about, with nothing
   enforcing it.
2. A non-FBX weapon throws inside Suspense, `CrawlerBoundary` catches it, and
   **the whole 3D scene downgrades to the minimap.** The rival path in
   `CrawlerAgents.jsx` is the one that trips, which is the easy one to miss.

`loaderFor(spec)` in `weaponCatalog.js` makes the choice once, next to the
filenames it depends on. Keep it, keep its three call sites, and keep the
spec-keyed (not url-keyed) preload map in `crawlerAssets.js`. All of it is
correct for an all-FBX catalog too.

## Keep by decision: the weapon bench

`src/components/Scene3D/Crawler/WeaponBench.jsx` + the `?bench=weapon` branch
in `App.jsx`. Written to dial in the accordion's hold transform, but it is
weapon-agnostic: it mounts the crawler against a fabricated one-room combat
site so any viewmodel can be checked without running a season.

It is `import.meta.env.DEV`-gated and lazily imported — verified absent from
the production bundle. If the accordion goes, drop `'War Accordion'` from its
`WEAPONS` list and everything else still works.

---

## Verifying the removal

```bash
cd quest-sim && .venv/bin/pytest tests/ -q          # 313 now; 309 after deleting
                                                   # the new test (4 seeds)
cd quest-map && npm run build
grep -ri "accordion\|squeezebox\|concertina\|bellows" quest-sim/quest_sim quest-sim/tests quest-map/src quest-map/public
```

That grep should come back empty except for `WeaponBench.jsx` if you left a
stale entry in its weapon list. Then open `?bench=weapon` and cycle weapons
with `w` — every one should still render, which is what proves `loaderFor`
survived the surgery intact.

---

## What it did NOT touch

Worth stating, because it bounds the blast radius: no change to
`combat_core.py`, `engine/sandbox/combat.py`, `actions.py`, `perception.py`,
`policy.py`, the event taxonomy, the SSE frame shape, or the MCP surface. The
accordion never needed a new verb, a new event, a new wire field, or a
`valid_actions` change — at +5 `damage_bonus` the existing `best_upgrade`
ranking offers `equip` on its own.

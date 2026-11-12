# `public/` — static assets

Everything here is copied to the deploy root verbatim and referenced by
**root-absolute URL string** (`/crawler/textures/wall-tiles.jpg`). Nothing here is
imported by the bundler.

## Layout

```
public/
├─ icons/            PWA install icons — generated, do not hand-edit
├─ brand/            logo / favicon source
├─ prompt-chan/      mascot expression sprites
├─ island/           overworld (Scene3D) scene assets
│   └─ dragon/
└─ crawler/          dungeon-crawler assets
    ├─ enemies/      enemy billboard sprites
    ├─ textures/     wall + décor textures
    ├─ fx/           sprite-sheet effects (+ their layout manifests)
    └─ models/       3D models, one folder per model that has textures
        ├─ chest/
        ├─ torch/
        └─ weapons/
```

**Which folder does a new asset go in?** Ask who owns it — the overworld scene
(`island/`), the dungeon crawler (`crawler/`), or the app chrome (`brand/`, `icons/`,
`prompt-chan/`). Group by owner, not by file type: a model's textures live beside the
model, not in a global `textures/`.

## Naming

1. **kebab-case, lowercase, ASCII.** No underscores, no PascalCase, no spaces.
2. **No redundant directory prefix.** In `enemies/` it's `mage.webp`, not
   `enemy_mage.webp`; in `models/torch/` it's `normal.webp`, not `torch_normal.webp`.
   The path already says it.
3. **Variants take a trailing `-<n>`**: `happy-1.webp`, `happy-2.webp`.
4. **PBR maps use the bare channel name** inside the model's folder: `basecolor`,
   `normal`, `orm`.
5. **Format by role** — `.webp` for sprites and colour textures, `.png` where lossless
   matters (normal maps, icons, palettes), `.glb` preferred for new models.
6. **Vendor provenance goes in a comment, not the filename.** Pack assets get renamed to
   their in-game role on import; record where they came from in the code that loads them.

Renamed pack assets in this tree: `crawler/models/weapons/` (the "PP" polygon weapon
pack — see the header of `src/components/Scene3D/Crawler/weaponCatalog.js`) and
`island/dragon/` (the questfi-lobby dragon).

## `public/` vs `src/assets/`

Deliberate split, keep it:

- **`src/assets/`** — small textures *imported* by JS so the bundler hashes and inlines
  them (`src/data/maps.js` imports the island/balkan map + heightmap PNGs).
- **`public/`** — everything heavy or lazily loaded. The service worker
  (`vite.config.js`) precaches only the app shell and runtime-caches these by extension
  with a 30-day CacheFirst. Bundling them would give them a new content hash every build
  and bust that cache on every deploy.

## Generated files

Regenerate rather than hand-edit:

| Target | Script |
|---|---|
| `icons/*` | `node scripts/generatePwaIcons.mjs` (source: `brand/quest-logo.png`) |
| `crawler/textures/wall-tiles-normal.png` | `python3 scripts/generate_wall_normal_map.py` |
| `crawler/fx/flame-sheet.*` | `npm run build:spritesheet` |
| `crawler/enemies/aethermaw-sheet.*` | `node scripts/buildAethermawTemplate.mjs`, then hand-aligned in Photoshop |

The `*-sheet.json` manifests are never fetched at runtime — callers pass the sheet layout
inline (see `src/components/Scene3D/Crawler/spriteSheet.js`, and the `BOSS_SHEETS`
registry in `crawlerAssets.js`). They are kept as build provenance next to the `.webp`.

The Aethermaw sheet is the one asset here that is *not* fully generated. Its two gen-AI
source strips bleed across their own frame boundaries, so the script emits a layered
alignment template (`temp/aethermaw-template.psd`) rather than a finished sheet; a human
nudges the frames onto the grid and exports `aethermaw-sheet.webp` at 1536x1024, 3x2
cells of 512. Re-running the script regenerates the *template*, never the shipped asset.

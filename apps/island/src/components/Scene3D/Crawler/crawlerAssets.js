import * as THREE from 'three';
import { useLoader } from '@react-three/fiber';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WEAPON_PALETTE_URL, loaderFor, weaponModelUrl, weaponSpecFor } from './weaponCatalog';
import { getWallTilesTexture, getWallTilesNormalTexture } from './crawlerTextures';
import { getSpriteSheetTexture } from './spriteSheet';
import { whenTrackedLoadsSettle } from './loadTracker';
import { publicUrl } from '../../../services/publicUrl';
import { COLORS } from '../worldUtils';

/**
 * The crawler's fixed asset manifest, plus the warm-up that pulls all of it
 * before the scene is ever shown.
 *
 * Every URL the crawler loads lives here so the preloader and the components
 * cannot drift apart. That matters more than tidiness: r3f caches a load
 * under the key `[LoaderClass, ...urls]`, so a preload only counts as a hit
 * if it uses the *same* loader class and the *same* url list, in the same
 * order, as the component's `useLoader`/`useTexture` call. A url copied into
 * two places is a cache miss waiting to happen — and a cache miss here means
 * the asset loads on screen instead of behind the curtain.
 */

export const TORCH_MODEL_URL = publicUrl('/crawler/models/torch/torch.fbx');
// One array, one useLoader call, one cache entry — order is load-bearing.
export const TORCH_TEXTURE_URLS = [
  publicUrl('/crawler/models/torch/basecolor.webp'),
  publicUrl('/crawler/models/torch/normal.webp'),
  publicUrl('/crawler/models/torch/orm.webp'),
];
export const COBWEB_TEXTURE_URL = publicUrl('/crawler/textures/cobweb-corner.webp');

export const CHEST_MODEL_URL = publicUrl('/crawler/models/chest/chest.obj');
export const CHEST_TEXTURE_URL = publicUrl('/crawler/models/chest/chest.jpg');

export const AGENT_MODEL_URL = publicUrl('/crawler/models/crew.glb');

export const ENEMY_SPRITES = {
  wraith: publicUrl('/crawler/enemies/wraith.webp'),
  skeleton: publicUrl('/crawler/enemies/skeleton.webp'),
  shadow: publicUrl('/crawler/enemies/shadow.webp'),
  harpy: publicUrl('/crawler/enemies/harpy.webp'),
  mage: publicUrl('/crawler/enemies/mage.webp'),
};
export const ENEMY_SPRITE_KEYS = Object.keys(ENEMY_SPRITES);
export const ENEMY_SPRITE_URLS = ENEMY_SPRITE_KEYS.map((key) => ENEMY_SPRITES[key]);

export const FLAME_SHEET = { url: publicUrl('/crawler/fx/flame-sheet.webp'), columns: 3, rows: 1 };

/**
 * Bosses that render as an animated sprite sheet instead of a static
 * billboard, keyed by their bare prefab entity id.
 *
 * Keyed by ID, not by the `boss_room` room type: BOTH sanctum_heart.json and
 * lair_boss.json use that room type, so a room-type check would hand the
 * season boss's art to every lesser POI boss too. Lookup is a suffix match
 * because the sandbox namespaces ids per site — the prefab declares
 * `aethermaw`, the live world calls it `boss_site.aethermaw`.
 *
 * Everything a sheet boss needs beyond the generic billboard lives in its
 * entry, so adding the next one is a data change and nothing in
 * CrawlerEnemy.jsx has to learn a new name:
 *
 *   idle/attack  absolute frame indices into the sheet (row-major), not
 *                offsets — the state machine indexes these arrays directly
 *   aspect       ONE CELL's width/height, never the whole sheet's
 *   scale        multiplier on ENEMY_H, replacing BOSS_SCALE for this entity
 *   lift         metres off the floor
 *   lunge        multiplier on the attack lunge distance
 *   light        underlight colour, overriding the default boss red
 */
export const BOSS_SHEETS = {
  aethermaw: {
    url: publicUrl('/crawler/enemies/aethermaw-sheet.webp'),
    columns: 3,
    rows: 2,
    // row 0, packed low -> mid -> up, so a ping-pong reads as a wingbeat
    idle: [0, 1, 2],
    // row 1: roar, breath, dissipate
    attack: [3, 4, 5],
    aspect: 1, // 512x512 cells
    // A wingspan-wide sprite reads far bigger on screen than a tall thin one
    // at equal height. Full BOSS_SCALE puts the wingtips at 2.8 units in a
    // CELL=4 room and pins the sprite flat against the ceiling clamp.
    scale: 1.26,
    lift: 0.15, // perched and rearing, not airborne — the art has planted feet
    lunge: 0.45, // a heavy thing lunges less, and a 2.4-unit quad at full
    // lunge distance swallows the viewport
    light: COLORS.green, // green, to match the breath — the default boss red
    // fights it
  },
};

/** The sheet spec for a live entity id, or null for an ordinary billboard. */
export function bossSheetFor(entityId) {
  const id = `${entityId ?? ''}`.toLowerCase();
  for (const key of Object.keys(BOSS_SHEETS)) {
    if (id === key || id.endsWith(`.${key}`)) return BOSS_SHEETS[key];
  }
  return null;
}

/**
 * Pull every asset the crawler will need, off screen.
 *
 * Suspending assets go through `useLoader.preload`, which fills the very
 * cache the components later read from — so by the time the Suspense
 * boundary mounts there is nothing left to suspend on. The imperative
 * textures are kicked by calling their memoized getters, which registers
 * them with the load tracker.
 *
 * `weaponNames` is the equipped weapon of the followed agent and of every
 * rival who might share their room; each maps to its own FBX, and a rival
 * walking in with an unloaded weapon is a pop-in the gate cannot catch.
 *
 * Returns a promise that settles when the untracked-by-Suspense loads are
 * done. Suspense covers the rest — see SandboxCrawler's readiness gate,
 * which waits on both.
 */
export function preloadCrawlerAssets(weaponNames = []) {
  useLoader.preload(FBXLoader, TORCH_MODEL_URL);
  useLoader.preload(THREE.TextureLoader, TORCH_TEXTURE_URLS);
  useLoader.preload(THREE.TextureLoader, COBWEB_TEXTURE_URL);
  useLoader.preload(OBJLoader, CHEST_MODEL_URL);
  useLoader.preload(THREE.TextureLoader, CHEST_TEXTURE_URL);
  useLoader.preload(GLTFLoader, AGENT_MODEL_URL);
  useLoader.preload(THREE.TextureLoader, ENEMY_SPRITE_URLS);
  useLoader.preload(THREE.TextureLoader, WEAPON_PALETTE_URL);

  const weaponSpecs = new Map(
    weaponNames.filter(Boolean).map((name) => {
      const spec = weaponSpecFor(name);
      return [weaponModelUrl(spec), spec];
    }),
  );
  // The catalog default is what an unarmed or unrecognised agent renders,
  // so it is always a possibility regardless of the roster.
  const fallback = weaponSpecFor(null);
  weaponSpecs.set(weaponModelUrl(fallback), fallback);
  // Keyed by spec, not url: the loader class is half the cache key, and not
  // every weapon is an FBX (see loaderFor).
  for (const [url, spec] of weaponSpecs) useLoader.preload(loaderFor(spec), url);

  // Imperative + module-memoized: calling the getter IS the load.
  getWallTilesTexture('wall');
  getWallTilesTexture('ceiling');
  getWallTilesNormalTexture('wall');
  getWallTilesNormalTexture('ceiling');
  getSpriteSheetTexture(FLAME_SHEET.url, FLAME_SHEET);
  for (const sheet of Object.values(BOSS_SHEETS)) {
    getSpriteSheetTexture(sheet.url, sheet);
  }

  return whenTrackedLoadsSettle();
}

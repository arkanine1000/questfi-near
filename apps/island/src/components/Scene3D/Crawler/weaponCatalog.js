// Equipped-weapon name -> viewmodel model mapping. Ordered: specific
// keywords must win over generic ones (greataxe before axe, greatsword
// before sword). `length` is the normalized world-unit size of the
// dominant axis; `kind` picks the attack animation (slash arc vs stab);
// `icon` is the HUD glyph on the weapon plate.
//
// The FBX files come from the "PP" polygon weapon pack and were renamed
// to their in-game role on import (e.g. PP_Theme_06_Sword_Two-Handed_001
// -> greatsword.fbx); they all share `palette.png` as their texture.
//
// Three fields are optional and exist for weapons that cannot go through
// the shared blade pipeline. They are undefined for every pack weapon:
//   hold: { offset, rotation, scale } — skip the normalization below and
//         place the model explicitly, in camera space
//   rig:  a deform rig name from weaponRigs.js, animated per frame
//   cue:  an sfx.js cue that replaces the default 'attack' sound

import {
  GiTwoHandedSword, GiBattleAxe, GiDaggers, GiWarAxe, GiWarhammer,
  GiBowArrow, GiStoneSpear, GiLunarWand, GiWizardStaff, GiScythe,
  GiBroadsword, GiAccordion,
} from 'react-icons/gi';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const CATALOG = [
  { match: /greatsword|two.?handed sword/, file: 'greatsword.fbx', length: 1.15, kind: 'slash', icon: GiTwoHandedSword },
  { match: /greataxe/, file: 'greataxe.fbx', length: 1.1, kind: 'slash', icon: GiBattleAxe },
  { match: /dagger|knife/, file: 'dagger.fbx', length: 0.55, kind: 'stab', icon: GiDaggers },
  { match: /axe/, file: 'axe.fbx', length: 0.85, kind: 'slash', icon: GiWarAxe },
  { match: /hammer|mace|maul/, file: 'hammer.fbx', length: 0.9, kind: 'slash', icon: GiWarhammer },
  { match: /bow/, file: 'bow.fbx', length: 1.05, kind: 'stab', icon: GiBowArrow },
  { match: /spear|lance|pike/, file: 'spear.fbx', length: 1.45, kind: 'stab', icon: GiStoneSpear },
  { match: /wand/, file: 'wand.fbx', length: 0.55, kind: 'stab', icon: GiLunarWand },
  { match: /scepter|sceptre/, file: 'scepter.fbx', length: 0.75, kind: 'stab', icon: GiWizardStaff },
  { match: /scythe/, file: 'scythe.fbx', length: 1.25, kind: 'slash', icon: GiScythe },
  // The easter egg. Authored mid-squeeze with no rig and no clips, so it
  // carries its own hold transform and a per-vertex bellows rig instead of
  // going through the blade pipeline — see weaponRigs.js.
  {
    match: /accordion|squeezebox|concertina/,
    file: 'accordion.glb',
    length: 0.62,
    kind: 'play',
    icon: GiAccordion,
    rig: 'bellows',
    cue: 'accordion',
    // Dialed in on the bench (?bench=weapon), not derived. The rotation is
    // the wrapped equivalent of the raw [-4.20, 3.70, 3.50] it was nudged
    // to — same orientation, readable as angles.
    hold: {
      offset: [0.65, -0.55, -0.8],
      rotation: [2.083, -2.583, -2.783],
      scale: 0.65,
    },
  },
  { match: /sword|blade|edge/, file: 'sword.fbx', length: 0.95, kind: 'slash', icon: GiBroadsword },
];

const DEFAULT_SPEC = CATALOG[CATALOG.length - 1]; // one-handed sword

const MODEL_DIR = '/crawler/models/weapons';

/** Shared texture for every weapon in the pack. */
export const WEAPON_PALETTE_URL = `${MODEL_DIR}/palette.png`;

/** Resolve the viewmodel spec for an equipped-weapon display name. */
export function weaponSpecFor(name) {
  const hay = (name ?? '').toLowerCase();
  return CATALOG.find((w) => w.match.test(hay)) ?? DEFAULT_SPEC;
}

/** Public URL of a spec's model. Keeps the asset path with the filenames. */
export function weaponModelUrl(spec) {
  return `${MODEL_DIR}/${(spec ?? DEFAULT_SPEC).file}`;
}

/**
 * The loader class for a spec, by file extension.
 *
 * Single-sourced on purpose: r3f caches under `[LoaderClass, ...urls]`, so
 * the preloader and every component reading a weapon must pick the class the
 * same way or the warm-up silently misses. Guessing FBX for a .glb is worse
 * than a miss — it throws inside Suspense, and CrawlerBoundary answers by
 * dropping the whole 3D scene to the minimap fallback.
 */
export function loaderFor(spec) {
  return (spec ?? DEFAULT_SPEC).file.endsWith('.glb') ? GLTFLoader : FBXLoader;
}

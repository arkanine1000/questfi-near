/**
 * Map registry — every theatre the war table can project.
 *
 * A "map" bundles the artifacts the generator pipeline produces from one
 * source image: the land-hex mask, per-hex elevations, prop placements, the
 * 2D backdrop image and the 3D displacement heightmap. Everything that
 * consumes terrain data reads it through getActiveMap() so a switch only
 * requires remounting the scene (the view keys the scene by map id).
 */
import { ISLAND_MASK } from '../components/HexGrid/hexUtils';
import { HEX_ELEVATIONS } from './hexElevations';
import { PROPS, CRATER } from './propMap';
import { BALKAN_MASK } from './balkan/mask';
import { BALKAN_ELEVATIONS } from './balkan/elevations';
import { BALKAN_PROPS, BALKAN_CRATER } from './balkan/propMap';
import islandMapUrl from '../assets/island-map.png';
import islandHeightmapUrl from '../assets/heightmap.png';
import balkanMapUrl from '../assets/balkan-map.png';
import balkanHeightmapUrl from '../assets/balkan-heightmap.png';

export const MAPS = {
  island: {
    id: 'island',
    label: 'ISLAND',
    mask: ISLAND_MASK,
    elevations: HEX_ELEVATIONS,
    props: PROPS,
    crater: CRATER,
    mapImageUrl: islandMapUrl,
    heightmapUrl: islandHeightmapUrl,
  },
  balkan: {
    id: 'balkan',
    label: 'B4LK4N',
    mask: BALKAN_MASK,
    elevations: BALKAN_ELEVATIONS,
    props: BALKAN_PROPS,
    crater: BALKAN_CRATER,
    mapImageUrl: balkanMapUrl,
    heightmapUrl: balkanHeightmapUrl,
  },
};

export const MAP_ORDER = ['island', 'balkan'];

let activeMapId = 'island';

export function setActiveMapId(id) {
  if (MAPS[id]) activeMapId = id;
}

export function getActiveMapId() {
  return activeMapId;
}

export function getActiveMap() {
  return MAPS[activeMapId];
}

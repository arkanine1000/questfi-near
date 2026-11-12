import { GLOBE } from '../config.js';
import { fadeIn, fadeOut, bandOf } from './geo.js';

// Every altitude-driven layer reads its weight from here, so the whole zoom is
// tuned from GLOBE.fade in config.js. Weights are 0..1 opacities; a layer at 0
// should also go `visible = false` so it costs no draw calls.

export function bandWeights(h, out = {}) {
  const f = GLOBE.fade;
  out.altitude = h;
  out.band = bandOf(h);
  out.fog = fadeOut(f.fog, h);
  out.carPoints = fadeIn(f.carPoints, h) * fadeOut(f.carPointsOut, h);
  out.agentDots = fadeIn(f.agentDots, h) * fadeOut(f.agentDotsOut, h);
  out.street = h < f.streetHide; // car + agent meshes, nameplates, shouts
  out.venues = fadeOut(f.venues, h);
  out.city = fadeOut(f.city, h);
  out.impostor = fadeIn(f.impostor, h) * fadeOut(f.impostorOut, h);
  out.rain = fadeOut(f.rain, h);
  out.beacon = fadeIn(f.beacon, h);
  out.atmosphere = fadeIn(f.atmosphere, h);
  out.coast = fadeIn(f.coast, h);
  out.graticule = fadeIn(f.graticule, h);
  out.localGrid = fadeOut(f.localGrid, h);
  out.stars = fadeIn(f.stars, h);
  out.outskirts = fadeOut(f.outskirts, h);
  // client-side ambient sims: full rate low, throttled in Regional, stopped above
  out.trafficRate = h < GLOBE.bands.city ? 1 : h < GLOBE.bands.regional ? 0.25 : 0;
  return out;
}

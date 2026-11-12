# Globe ⇄ City Zoom — Implementation Spec

## Goal

Add a continuous camera transition from **orbit around a planet** down to **the existing city**, and back. No scene cut, no loading screen, no visible pop. This is the hero feature: the first thing a visitor sees is the planet, a beacon on it, and a dive into a living city with agents and traffic.

The existing city build (holo wireframe style, NPC cars, agent roster, minimap, portals to THE COLOSSEUM / THE GREEN ROOM / SPEED TRADERS, free flight, HOLO / RAIN / textures toggles) must keep working exactly as it does now. This feature adds altitude above it; it does not rewrite it.

---

## Step 0 — Read before you write

Before changing anything, inspect the repo and report back (short summary, then wait for confirmation):

1. Renderer and framework (Three.js version? R3F? vanilla?), build tool, entry point.
2. How the city is loaded (single glTF? many?), its units (meters?), and where its origin sits.
3. Camera controller(s): free flight, mode switching (TAB), follow cam. Where near/far planes are set.
4. Render loop: where traffic, agents, rain, and holo post-processing update each frame.
5. Post-processing stack (bloom, scanlines, noise, etc.) and how HOLO vs textured mode switches materials.
6. Current world-space extent of the city (bounding box).

Then propose the module layout for the changes below before implementing.

---

## Core architecture decision: the city never moves

**The city stays at the world origin, in meters, untouched.** The planet is placed *under* it:

- Planet center at `(0, -PLANET_RADIUS, 0)`.
- The city's ground plane is tangent to the sphere at its top (the north-pole-equivalent of the local frame). The city's real lat/lon only affects how the globe's surface texture/outlines are rotated so the right continent sits under the city.
- `PLANET_RADIUS` is a config constant. Start with real Earth (`6_371_000` m). Keep it configurable; we may shrink it for a more dramatic, shorter dive.

Why: all precision-sensitive detail (agents, cars, street-level geometry) lives near the origin where 32-bit floats are exact. The planet is only seen in detail when the camera is far away, where millimeter error is invisible. This avoids a floating-origin rebase system entirely for now.

Required renderer settings:

- `logarithmicDepthBuffer: true` on the WebGLRenderer (or an equivalent reversed-Z setup). Verify the holo post-processing and any custom shaders still write depth correctly; custom ShaderMaterials need the `logdepthbuf` chunks included.
- Near/far planes set **dynamically from altitude** every frame, e.g. `near = max(0.1, altitude * 0.001)`, `far = altitude + PLANET_RADIUS * 2`. Tune so there is no z-fighting at any altitude band.

---

## Altitude bands

Altitude = distance from camera to sphere surface (`|cam - planetCenter| - PLANET_RADIUS`). All blending is driven by this single number, mapped through `smoothstep` ranges defined in one config object so they're easy to tune.

| Band | Altitude (initial guess) | What's visible |
|---|---|---|
| Street | 0 – 300 m | Everything as today: agents, cars, labels, rain, portals |
| City | 300 m – 3 km | City meshes, traffic as moving light points, agent dots, no per-agent text |
| Regional | 3 – 80 km | City becomes a glowing footprint + light grid; curved ground skirt to the horizon; atmosphere begins |
| Orbital | 80 km + | Full globe, atmosphere rim, city beacon, other site beacons (future) |

Rules:

- Every visual layer gets an `opacity`/`visible` driven by these bands. Fade, never toggle, except where something is fully invisible (then set `visible = false` to save draw calls).
- **Simulation is not paused by altitude** (agents and server state keep updating), but **client-side ambient sims are throttled**: traffic updates at full rate below City band, at low rate in Regional, and stop above it.
- Rain is disabled above the City band.

---

## Visual components to build

### 1. Globe (`globe/`)
- Sphere at planet scale with enough segments to look round from orbit (it never needs to hold detail; the city covers close range).
- **HOLO mode (default):** match the existing phosphor-green wireframe look. Lat/long graticule lines, continent coastline outlines (use Natural Earth 110m/50m coastlines as GeoJSON → line geometry projected onto the sphere), faint scanline/noise from the existing post stack. Ocean is near-black, land slightly lifted.
- **Textured mode (H key):** an equirectangular Earth-like albedo + night-lights texture (or the baked procedural planet textures if we provide them later). Keep this behind the same toggle the city already uses.
- Atmosphere: a slightly larger back-faced sphere with a fresnel rim shader, in the holo green for HOLO mode, blue-ish in textured mode.

### 2. City beacon
- From Regional altitude up: a vertical light pillar and pulsing ring at the city's location, plus a label (city name + live agent count from existing roster data).
- Clickable/tappable from orbit → triggers the dive (see camera).

### 3. Ground skirt / horizon
The city's ground ends at the edge of the model. At City/Regional altitude you'd see it floating in a void. Fix:
- A large ground disc (radius ~ several hundred km) centered on the city, with a radial grid in the holo style, fading with distance.
- Apply **curvature in the vertex shader**: for horizontal distance `d` from origin, `y -= d*d / (2*PLANET_RADIUS)`. This makes the skirt bend down to meet the sphere seamlessly. Do **not** apply it to the city meshes themselves (the drop is <1 m inside the city anyway).
- Blend the skirt into the globe surface over the Regional band so there is no visible seam.

### 4. City impostor
In Regional band, swap detailed city rendering for a cheap representation: a footprint texture/emissive grid of the street layout plus small light points for buildings and moving points for traffic. Crossfade over the City→Regional boundary. Above Regional, hide city meshes entirely.

### 5. Agents at altitude
- Street: current behavior.
- City: colored dots matching roster colors, no text.
- Regional/Orbital: aggregated into the beacon count. The side roster panel and minimap stay visible at all altitudes.

---

## Camera

Add a new camera mode, **GLOBE**, alongside FREE FLIGHT (keep TAB cycling; add it to the cycle).

- **Orbit control:** rotate around planet center, zoom along the radial direction.
- **Zoom is log-mapped:** each scroll step changes altitude by a constant *factor*, not a constant distance, so going from 100 km to 100 m feels as smooth as 100 m to 10 cm would.
- As altitude drops into City band, the camera should **pitch from looking-at-planet-center to looking-at-the-horizon** smoothly (interpolate the look target from planet center to a point on the ground ahead). Landing in Street band hands control to the existing FREE FLIGHT controller with matching position/orientation (no jump).
- Reverse (zoom out from FREE FLIGHT): scrolling out past the top of Street band hands over to GLOBE mode with the same continuity.
- **Dive action:** clicking the beacon, or a key (`G` = go to globe / dive toggle), runs an eased camera path from current position to a nice establishing view of the city (~400 m altitude, ~35° pitch toward downtown/the portals).
- Keyboard hint bar at the bottom: add `G globe`.

### Cinematic / marketing mode
URL flag `?cinematic=1`:
- Hide all UI.
- Play a deterministic dive: start at orbit with the planet slowly rotating, beacon visible, accelerate down, pitch toward horizon, end in a slow fly-over of downtown with traffic and agents. Duration configurable (default ~20 s).
- Preload/warm everything the path needs before starting (city, textures, shaders compiled with `renderer.compile`).
- `?cinematic=1&record=1`: fixed timestep (advance the sim by exactly 1/60 s per frame regardless of real time) so a screen recorder captures a perfectly smooth take even if the machine drops frames.

---

## Performance targets

- Desktop (integrated GPU laptop): 60 fps in every band, including mid-transition.
- Mid-range phone: 30+ fps in Orbital and City bands. Street band may use lower-detail settings.
- Draw calls in Orbital band should be a small fraction of Street band (city hidden, traffic stopped).
- No shader compile hitches during the dive: precompile on load.
- Measure with an on-screen debug overlay (`?debug=1`): fps, altitude, active band, draw calls, triangles, near/far.

---

## Future-proofing (design for, don't build yet)

- Store sites as data: `{ id, name, lat, lon, tileAsset, portals[] }`. Today there's one site. Code should not assume there's only one beacon.
- A second site will eventually *not* be at the origin. When that day comes we'll add a floating-origin rebase (snap the active site to origin as the camera approaches it). Keep all city/agent code working in **site-local coordinates** so that's a localized change.
- Later: the globe surface gets replaced by a quadtree terrain. Keep the globe renderer behind a small interface (`update(camera, altitude)`, `setMode(holo|textured)`) so it can be swapped.

---

## Don'ts

- Don't move, rescale, or re-export the city to fit the planet. The planet fits the city.
- Don't put the city at planet-scale world coordinates (e.g. `y = 6,371,000`). Precision will shred it.
- Don't hard-cut between scenes. If something must swap, it crossfades.
- Don't break existing controls, portals, roster, minimap, HOLO/RAIN/textures toggles, or the agent data feed.
- Don't add heavy dependencies for this (no Cesium, no full GIS stack). Three.js + one coastline GeoJSON file is enough.

---

## Milestones (commit after each, each one must run)

1. **Renderer prep:** log depth buffer, dynamic near/far, debug overlay. City looks identical.
2. **Globe exists:** holo sphere + graticule + coastlines + atmosphere, placed under the city. Can be seen by flying the free camera very high.
3. **GLOBE camera mode:** orbit + log zoom, handoff to/from FREE FLIGHT with no jump.
4. **Bands + blending:** ground skirt with curvature, city impostor, agent/traffic LOD, rain cutoff.
5. **Beacon + dive action** (click / `G`).
6. **Cinematic mode** with record flag.
7. **Perf pass** on desktop and a phone; tune band thresholds.

## Acceptance check

Run `?cinematic=1` and watch it full-screen. It passes if:
- No frame where geometry pops, flickers, or z-fights.
- No moment where the city is visibly floating, disconnected from the ground, or seams with the globe.
- Traffic and agents are already moving when they become visible.
- Then do the same dive manually with scroll, and zoom back out to orbit. Same result.

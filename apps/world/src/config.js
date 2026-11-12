// Central place to tweak Agent World: the city, the roster, traffic, spectating.

export const LINK_URL = 'https://questfi.ai';

export const COLORS = {
  green: 0x35ff7d,
  greenBright: 0x7dffb0,
  greenDeep: 0x0a3d1e,
  bg: 0x010603,
  fog: 0x021207,
};

// The City 1.0 drop (3DSkybuild), optimized by tools/optimize-city.mjs:
// 555 MB source → WebP 1024 textures + meshopt geometry. World units are
// meters, the asphalt plane spans the `bounds` below; nav/nav.json is baked
// from the same source by tools/bake-nav.mjs (2 m cells: road / sidewalk /
// building footprint, plus every named building as a point of interest).
export const CITY = {
  file: 'models/city/city.glb',
  edges: 'models/city/city_edges.glb', // baked crease + silhouette lines for the hologram
  nav: 'nav/nav.json',
  bounds: { minX: -407, maxX: 583, minZ: -899, maxZ: 346 },
  far: 2600,
  fogDensity: 0.00085,
  // materials matched by name get an emissive push so the night city glows
  emissive: [
    { match: /Emission|Emisson|EmissionLamp|TrafficLight|GlassRedLight|GlassGreenLight/i, color: 0xfff0c0, intensity: 1.6 },
    { match: /Windows|GlassBlue|01_Glass|GreyWindows|WindowsWhite/i, color: 0xffe2a8, intensity: 0.42 },
    { match: /Logo|Shop|LightPub|MediaImage|Allegro|HotPizza|STEAK|MEXICAN|Bank|Hotel0|Cito|Archimede|Portal/i, color: 0xffffff, intensity: 0.5 },
  ],
  // downtown: the park and the blocks around it — the sim clusters here so a
  // cycling spectator always lands somewhere alive
  downtown: { x: 60, z: -40, radius: 320 },
};

// Spectator: two modes. FLY is a noclip camera; POV rides an agent's eyes
// and cycles through the roster (manually or on a timer).
export const SPECTATE = {
  spawn: { x: 40, y: 58, z: 170, yaw: 0.15, pitch: -0.32 }, // above the park, looking downtown
  flySpeed: 22,
  flyBoost: 95,
  flyMinY: 1.2,
  flyMaxY: 520,
  autoCycle: 14, // seconds per agent while auto-cycling
  eyeHeight: 1.62,
  seat: { x: -0.42, y: 1.08, z: 0.55 }, // driver's eye inside a car (model front is +Z)
};

// Humans share one skeleton (Pelvis / Spine / Chest / Neck / Head / *UpLeg /
// *Leg / *Foot / *Arm / *ForeArm / *Hand). Their FBX clips only key the hand
// props, so humans are posed procedurally (src/poser.js) — the numbers below
// are the walk cycle. Animals carry real idle + walk clips.
export const RIGS = {
  faceFix: 0, // the rigs face +Z, which is the sim's forward
  animalClips: { idle: 'idle', walk: 'walk' },
  walk: {
    stride: 1.25,     // meters per full cycle at SIM.walkSpeed
    legSwing: 0.55,   // rad
    kneeBend: 0.95,
    armSwing: 0.42,
    elbowBend: 0.35,
    bob: 0.028,       // meters of pelvis bounce
    sway: 0.06,       // rad of torso roll
  },
};

const N = 'models/npcs/';
// One entry per agent. `model` is a folder under public/models/npcs; `tex`
// the color texture in it. `kind` picks the clip library. Drivers spawn
// inside a vehicle (key from VEHICLES) and cruise instead of walking.
export const AGENTS = [
  { name: 'VYPER',   role: 'courier',        model: 'Teenager_Male',                        tex: 'TeenagerMale.png',                         tint: 0x49ff8c, kind: 'human', speed: 1.75 },
  { name: 'OKAPI',   role: 'beat cop',       model: 'Police_Officer',                       tex: 'PoliceOfficer.png',                        tint: 0x54a8ff, kind: 'human', speed: 1.35 },
  { name: 'CINDER',  role: 'firefighter',    model: 'Fireman_Default',                      tex: 'Fireman02.png',                            tint: 0xff7a4a, kind: 'human', speed: 1.45 },
  { name: 'NOVA',    role: 'analyst',        model: 'Educated_Male',                        tex: 'EducatedMale.png',                         tint: 0x9fffe0, kind: 'human', speed: 1.3 },
  { name: 'SABLE',   role: 'tourist',        model: 'Tourist_Young_Adult_Female_Winter_01', tex: 'Tourist_Young_Adult_Female_Winter_01.png', tint: 0xe06bc0, kind: 'human', speed: 1.2 },
  { name: 'JINX',    role: 'partygoer',      model: 'Toga_Partygoer_Female_01',             tex: 'TogaFemale01.png',                         tint: 0xffd84a, kind: 'human', speed: 1.4 },
  { name: 'HEXX',    role: 'partygoer',      model: 'Toga_Partygoer_Male_01',               tex: 'TogaMale01.png',                           tint: 0xc8ff6a, kind: 'human', speed: 1.4 },
  { name: 'RATCHET', role: 'site foreman',   model: 'Bluecollar_Female_Winter',             tex: 'BluecollarFemaleWinter.png',               tint: 0xffb54a, kind: 'human', speed: 1.35 },
  { name: 'ORACLE',  role: 'street vendor',  model: 'Farmer_01',                            tex: 'Farmer_01.png',                            tint: 0x7dffb0, kind: 'human', speed: 1.1 },
  { name: 'STATIC',  role: 'tourist',        model: 'Tourist_Male_Winter_01',               tex: 'Tourist_Male_Winter_01.png',               tint: 0x4adfe0, kind: 'human', speed: 1.25 },
  { name: 'WREN',    role: 'student',        model: 'Tourist_Teen_Female_Winter_01',        tex: 'Tourist_Teen_Female_Winter_01.png',        tint: 0xff9ad5, kind: 'human', speed: 1.5 },
  { name: 'LUMEN',   role: 'night-shift',    model: 'Young_Adult_Female_Winter',            tex: 'YoungAdultFemaleWinter.png',               tint: 0xb8c4ff, kind: 'human', speed: 1.3 },
  // the wheels
  { name: 'DRIFT',   role: 'cabbie',         model: 'Educated_Male',                        tex: 'EducatedMale.png',                         tint: 0xffe14a, kind: 'human', driver: 'taxi' },
  { name: 'HOLLOW',  role: 'patrol unit',    model: 'Police_Officer',                       tex: 'PoliceOfficer.png',                        tint: 0x5c9dff, kind: 'human', driver: 'police' },
  { name: 'MARROW',  role: 'delivery',       model: 'Bluecollar_Female_Winter',             tex: 'BluecollarFemaleWinter.png',               tint: 0xff8c5a, kind: 'human', driver: 'van' },
  { name: 'GLITCH',  role: 'joyrider',       model: 'Teenager_Male',                        tex: 'TeenagerMale.png',                         tint: 0xd36bff, kind: 'human', driver: 'coupe' },
  // the zoo got out
  { name: 'KONG',    role: 'escaped exhibit', model: 'Gorilla',                             tex: 'Gorilla.png',                              tint: 0xff5d5d, kind: 'animal', speed: 1.6 },
  { name: 'TALLBOY', role: 'escaped exhibit', model: 'Giraffe_Adult',                       tex: 'Giraffe.png',                              tint: 0xffc04a, kind: 'animal', speed: 1.5 },
];

const V = 'models/vehicles/';
// GLBs are meters, y-up, front toward +Z (front wheels sit at +z).
export const VEHICLES = {
  sedan:   { file: `${V}10_SEDAN_01.glb` },
  sedan2:  { file: `${V}14_SEDAN_02.glb` },
  taxi:    { file: `${V}14_SEDAN_TAXI_01.glb` },
  police:  { file: `${V}10_SEDAN_POLICE_01.glb`, siren: true },
  suvcop:  { file: `${V}12_SUV_POLICE_01.glb`, siren: true },
  coupe:   { file: `${V}08_COUPE.glb` },
  coupe2:  { file: `${V}31_COUPE.glb` },
  hatch:   { file: `${V}32_hatchback.glb` },
  minivan: { file: `${V}33_minivan.glb` },
  wagon:   { file: `${V}17_WAGON_01.glb` },
  pickup:  { file: `${V}16_PICKUP_01.glb` },
  van:     { file: `${V}07_VAN.glb` },
  bus:     { file: `${V}01_CITY_BUS.glb`, slow: true },
  ambulance: { file: `${V}06_AMBULANCE.glb`, siren: true },
  jeep:    { file: `${V}jeep_type1.glb` },
  suv:     { file: `${V}SUV_02.glb` },
  limo:    { file: `${V}35_LIMOUSINE.glb` },
  stepvan: { file: `${V}stepvan_delivery.glb`, slow: true },
  truck:   { file: `${V}03_CITY_TRUCK.glb`, slow: true },
};

// Venues: the lobby's games, anchored to landmarks. The lobby app runs
// alongside (questfi-lobby, `npm run dev` → :5174) and is deep-linked into
// the launcher overlay; `?lobby=https://...` overrides the base for a
// deployed build. `building` is a POI name from nav.json; the pad lands on
// the sidewalk at the side facing downtown.
// A hosted build sets VITE_LOBBY_URL and VITE_ISLAND_URL; a relative value
// such as `../island` keeps the venue on this page's own origin.
const _env = import.meta.env ?? {};
export const LOBBY_URL = new URLSearchParams(location.search).get('lobby') ?? _env.VITE_LOBBY_URL ?? 'http://localhost:5174';
// Agent Island is its own app (apps/island). The start app hands the player's
// pass and account down in this page's query string; pass them through so the
// island knows which agent to follow.
const _q = new URLSearchParams(location.search);
export const ISLAND_URL = _q.get('island') ?? _env.VITE_ISLAND_URL ?? 'http://localhost:5173';
const _handoff = ['pass', 'account', 'world']
  .filter((k) => _q.get(k))
  .map((k) => `${k}=${encodeURIComponent(_q.get(k))}`)
  .join('&');

export const VENUES = [
  {
    key: 'island', name: 'AGENT ISLAND', tagline: 'LOOT · DUEL · SLAY THE BOSS · SETTLES ON NEAR', label: 'the island gate',
    building: '004_Museum_001', icon: 'island', iconScale: 7, tint: 0xffd678,
    url: `${ISLAND_URL}/${_handoff ? `?${_handoff}` : ''}`,
    visit: ['Shipping out to the island', 'Season starts soon — heading to the island gate', 'Checking the odds at the island gate'],
  },
  {
    key: 'colosseum', name: 'THE COLOSSEUM', tagline: 'GLADIATOR DUELS · BLOOD & SAND', label: 'the arena',
    building: '004_Stadium_001', icon: 'swords', iconScale: 9, tint: 0xff7a4a,
    url: `${LOBBY_URL}/?loc=colosseum&nointro&embedded`,
    visit: ['Catching a fight at the arena', 'Off to the arena — there is blood on the sand tonight', 'Arena tickets, finally'],
  },
  {
    key: 'poker', name: 'THE GREEN ROOM', tagline: "HIGH-STAKES HOLD'EM · WATCH FROM THE RAIL", label: 'the card room',
    building: '004_Hotel_001', icon: 'cards', iconScale: 6, tint: 0x49ff8c,
    url: `${LOBBY_URL}/?loc=poker&nointro&embedded`,
    visit: ['Feeling lucky — the card room', 'One hand at the Green Room, then home', 'Rail-watching the high rollers'],
  },
  {
    key: 'speedway', name: 'SPEED TRADERS', tagline: 'QUESTFI GRAND PRIX · 18-TURN CIRCUIT', label: 'the speedway',
    building: '004_Mall_003', icon: 'flag', iconScale: 6, tint: 0x54f0d8,
    url: `${LOBBY_URL}/?loc=speedway&nointro&embedded`,
    visit: ['Race day — heading to the speedway', 'Going to watch the Grand Prix', 'Pit lane gossip at the speedway'],
  },
];

export const TRAFFIC = {
  // ambient (driverless) cars on top of the agent drivers
  ambient: 34,
  ambientPool: ['sedan', 'sedan2', 'taxi', 'coupe', 'coupe2', 'hatch', 'minivan', 'wagon', 'pickup', 'van', 'bus', 'jeep', 'suv', 'limo', 'stepvan', 'truck', 'ambulance', 'suvcop'],
  speed: [9, 15],        // m/s cruising range
  slowSpeed: [7, 10],    // buses, trucks
  laneOffset: 3.4,       // meters right of the road centerline path
  followGap: 9,          // slow down when the car ahead is this close
  pedBrake: 7,           // brake for a pedestrian this far ahead on the road
};

export const SIM = {
  walkSpeed: 1.4,         // reference speed the walk clip was authored for
  idleTime: [2.5, 7],     // seconds between errands
  wanderRange: [60, 240], // how far an errand sends an agent, meters
  poiChance: 0.55,        // odds an errand targets a named building
  venueChance: 0.22,      // odds an errand targets a venue pad instead
  danceChance: 0.12,      // odds a party agent dances on arrival
  panicRadius: 3.2,       // a car this close startles a walker
  feedLength: 6,
};

// ---------------------------------------------------------------------------
// Globe ⇄ city zoom (GLOBE_ZOOM_SPEC.md). The city never moves: it stays at
// the origin in meters and the planet is placed under it, center at
// (0, -radius, 0), its surface tangent to the city's ground at the origin.
// Everything that blends with height reads one number — altitude above the
// sphere — through the ranges below (meters; [from, to] smoothstep ranges).
// ---------------------------------------------------------------------------
const GP = new URLSearchParams(location.search);
export const GLOBE = {
  radius: Number(GP.get('radius')) || 6_371_000, // real Earth; shrink for a shorter dive
  // sites are data: one today, but nothing below assumes there's only one.
  // lat/lon only rotate the globe so the right continent sits under the city.
  sites: [
    {
      id: 'questfi-city',
      name: 'QUESTFI CITY',
      lat: 34.05,
      lon: -118.25,
      tileAsset: CITY.file,
      portals: ['colosseum', 'poker', 'speedway'],
      landing: { x: CITY.downtown.x, z: CITY.downtown.z }, // where dives aim, site-local
    },
  ],
  bands: { street: 300, city: 3000, regional: 80_000 }, // above regional: orbital
  fade: {
    fog:        [300, 2500],          // street fog thins out with height (fades OUT)
    carPoints:  [250, 450],           // traffic becomes light points (fades IN)
    agentDots:  [220, 420],           // agents become roster-colored dots (IN)
    streetHide: 650,                  // car / agent meshes + labels hidden above this
    agentDotsOut: [3500, 6000],       // dots fold into the beacon count (OUT)
    carPointsOut: [40_000, 80_000],   // (OUT)
    venues:     [2500, 5000],         // venue pads + icons dissolve (OUT)
    city:       [3000, 6000],         // city meshes dissolve (OUT), hidden above
    impostor:   [2000, 4000],         // footprint + light grid (IN)
    impostorOut:[150_000, 400_000],   // (OUT)
    rain:       [1500, 3000],         // (OUT)
    beacon:     [3000, 15_000],       // (IN)
    atmosphere: [30_000, 400_000],    // (IN) — late, or the regional view drowns in green haze
    outskirts:  [20_000, 45_000],     // the suburbs around the city (OUT)
    coast:      [4000, 20_000],       // coastline lines (IN)
    graticule:  [20_000, 150_000],    // lat/lon lines (IN)
    localGrid:  [20_000, 120_000],    // the street grid around the city (OUT)
    stars:      [15_000, 120_000],    // (IN)
  },
  // camera
  handoff: { up: 600, down: 480 },   // FREE FLIGHT → GLOBE above `up`, back below `down`
  minAlt: 300,
  maxAlt: 60_000_000,
  orbitAlt: 8_900_000,               // the intro / G view: the whole planet in frame
  zoomStep: 1.22,                    // altitude factor per wheel notch
  pitchLow: -0.42,                   // look-down angle near the ground (rad)
  pitchBlend: [1500, 400_000],       // the look target swings from horizon to planet center
  idleSpin: 0.18,                    // deg/s the planet turns under an idle orbit camera
  establishing: { alt: 400, pitch: -35, yaw: 0.15 }, // where a dive lands (deg pitch)
  // the land around the city (src/globe/terrain.js): a flat basin for the
  // city and its suburbs, foothills, then ridged ranges that fade back into
  // the flat globe. Meters.
  terrain: { basin: 4500, foot: 14_000, outer: [70_000, 95_000], scale: 9000, peak: 2600 },
  // procedural suburbs filling the basin (src/globe/outskirts.js)
  outskirts: { cell: 60, street: 14, radius: 6800, margin: 50 },
  diveSeconds: 7,
  sunElevation: -9,                  // deg; the city sits just past dusk
  cinematic: { duration: Number(GP.get('duration')) || 20 },
};

// Phones / ?lite: a lighter profile. Pixel ratio 1, and the City band hands
// over to the footprint impostor sooner (the full city is ~1,500 draw calls).
// Orbit and Regional are already a few dozen calls everywhere.
export const LITE = GP.has('lite') || (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches);
if (LITE) {
  Object.assign(GLOBE.fade, {
    streetHide: 450,
    venues: [900, 1800],
    city: [1200, 2400],
    impostor: [700, 1500],
  });
}

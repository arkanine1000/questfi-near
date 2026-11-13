/**
 * Preview scenarios: what the game server and the chain answer, built from
 * the recorded fixtures in src/dev/fixtures with the edits each scenario
 * needs (the visitor's bets, a settled market, a death...). Every edit is
 * made here, in code, next to the scenario it serves.
 *
 * buildScenario(params) returns a plain spec that network.js serves and
 * PreviewApp mounts. The URL parameters are documented in catalog.js.
 */

import season from '../fixtures/season.json';
import chainFx from '../fixtures/chain.json';
import lobbyFx from '../fixtures/lobby.json';
import landingFx from '../fixtures/landing.json';
import { cutsFrom, settlePayout } from '../../services/marketMath';

export const CONTRACT_ID = 'pass.questfi.testnet';
// Made-up test account ids, in the form the start app gives visitors.
export const VISITOR = 'g-7c4e2b9a.play.questfi.testnet';
export const NEW_ACCOUNT = 'g-1f5d8e03.play.questfi.testnet';
export const GUEST_SLOT = 'questfi.guest.testnet';
// Obviously invented transaction hashes for the visitor's own transactions.
export const FAKE_TX = ['PreviewTx1bet1111111111111111111111111111111', 'PreviewTx2bet2222222222222222222222222222222', 'PreviewTx3c1aim333333333333333333333333333333'];

const clone = (x) => structuredClone(x);
const yocto = (near) => BigInt(Math.round(near * 1e6)) * 10n ** 18n;
const asText = (v) => v.toString();

// ---------------------------------------------------------------------------
// the recorded season
// ---------------------------------------------------------------------------
const SEASON_ID = season.world_id;
const FRAMES = new Map(season.frames.map((f) => [f.tick, f]));
const frameAt = (t) => clone(FRAMES.get(t));
const FINAL = season.final_state;
const BY_NAME = Object.fromEntries(FINAL.roster.map((a) => [a.name, a]));
const PASS = (name) => BY_NAME[name].pass_id;
const AGENT = (name) => BY_NAME[name].agent_id;

// Ids of the extra seasons the landing board lists. Only RUNNING_ALIAS can
// be watched; the others answer 404, which is what a swept season does.
const RUNNING_ALIAS = 'w-4a7c19e2';
const DEAD_WORLD = 'w-0d1e7a5c';

/** The same recorded world under another id. */
function rename(obj, from, to) {
  return JSON.parse(JSON.stringify(obj).replaceAll(from, to));
}

function nearBlock(seasonId, status, methods, extra = {}) {
  return {
    ...FINAL.near,
    season_id: seasonId,
    season_status: status,
    recent_txs: FINAL.near.recent_txs.filter((t) => methods.includes(t.method)),
    ...extra,
  };
}

const STARTED_TXS = ['create_season', 'enter_season', 'start_season'];

/** Prompt-chan's lines. The recording has none (the stream only replays
 * frames), so these are written in her voice. */
const LINES = {
  early: 'Six challengers, one island, and MIMIR is already underground?! Somebody check the odds!',
  run: 'Vex and Bren are double-teaming the Vault Warden in the Western Crypt. Teamwork, how adorable!! ☆',
  dungeon: 'Kell cut through the Shriek Harpy without a word. Roost Harpy, you are next, sweetie.',
  pvp: 'Wait, Bren just swung at Vex?! The Western Crypt partnership is OVER!',
  won: 'GG!! Kell slew the Heart of the Island and walks off with the crown! ☆*:.｡.o(≧▽≦)o.｡.:*☆',
  none: 'Nobody walks off the island this time... the dark keeps all six. See you next season.',
};
const chan = (tick, text) => ({ kind: 'commentary', world_id: SEASON_ID, tick, speaker: 'prompt-chan', text });

/**
 * Site maps as they stand after the last frame a scenario plays: the
 * recorded rooms, with the players put where the roster says they are and
 * the monsters the recorded events show them fighting.
 */
function sitesFor(roster, { pvp = false } = {}) {
  const sites = clone(season.sites);
  for (const site of Object.values(sites)) {
    for (const room of Object.values(site.rooms)) {
      room.players = [];
      room.combat = null;
    }
  }
  for (const a of roster) {
    const p = a.position;
    if (!a.alive || p.kind !== 'dungeon' || !sites[p.site_id]?.rooms[p.room]) continue;
    sites[p.site_id].rooms[p.room].players.push({ agent_id: a.agent_id, name: a.name, color: a.color });
  }
  // tick 14: Kell steps west into the Roost Harpy (combat_start in frame 14)
  const kellRoom = sites.site_5.rooms['2,0'];
  kellRoom.entities = [{ id: 'site_5.harpy_1', name: 'Roost Harpy', type: 'hostile', hp: 9, max_hp: 9 }];
  kellRoom.combat = {
    active: true, combatant_ids: [AGENT('Kell'), 'site_5.harpy_1'], hostile_pairs: [], pvp_active: false,
  };
  if (pvp) {
    // hand edit: the Western Crypt partners turn on each other
    sites.site_2.rooms['4,4'].combat = {
      active: true,
      combatant_ids: [AGENT('Vex'), AGENT('Bren')],
      hostile_pairs: [[AGENT('Vex'), AGENT('Bren')]],
      pvp_active: true,
    };
  }
  return sites;
}

/** Frame 14 with Bren striking Vex: the PvP danger frame lights on it. */
function pvpFrame(base, { kill = false } = {}) {
  const f = clone(base);
  const loc = 'site_2:4,4';
  let seq = Math.max(...f.events.map((e) => e.seq)) + 1;
  const ev = (event_type, data, description, actor = AGENT('Bren')) => ({
    event_type, tick: f.tick, data, description, seq: seq++, actor, location: loc,
  });
  f.events.push(
    ev('agent_thought', { agent: AGENT('Bren'), thought: 'The Warden is dead. The loot splits better one way.' }, 'Bren thinks.'),
    ev('combat_start', { combatant_ids: [AGENT('Bren'), AGENT('Vex')], names: ['Bren', 'Vex'] }, 'Combat breaks out: Bren vs Vex!', null),
    ev('attack', {
      attacker_id: AGENT('Bren'), defender_id: AGENT('Vex'), attack_roll: 17, target_ac: 14, hit: true, damage: kill ? 25 : 6, critical: kill,
    }, `Bren attacks Vex with Longsword: ${kill ? 'Critical hit!' : 'Hit!'} (rolled 17 vs AC 14)`),
    ev('damage', { target_id: AGENT('Vex'), damage: kill ? 25 : 6, hp_remaining: kill ? 0 : 19 }, `Vex takes ${kill ? 25 : 6} damage (${kill ? 0 : 19}/25 HP).`),
  );
  const vex = f.roster.find((a) => a.agent_id === AGENT('Vex'));
  const bren = f.roster.find((a) => a.agent_id === AGENT('Bren'));
  vex.in_combat = !kill;
  bren.in_combat = !kill;
  vex.hp = kill ? 0 : 19;
  if (kill) {
    vex.alive = false;
    vex.cause_of_death = 'slain by Bren';
    bren.kills = 1;
    f.events.push(ev('agent_death', {
      agent: AGENT('Vex'), name: 'Vex', color: vex.color, cause: 'slain', killer: AGENT('Bren'), killer_name: 'Bren',
    }, 'Vex has fallen to Bren.'));
  }
  return f;
}

// ---------------------------------------------------------------------------
// worlds
// ---------------------------------------------------------------------------

/** The recorded season at tick 12, playing ticks 13 and 14 live. */
function runningWorld({
  id = SEASON_ID, host = false, paused = false, locked = false, onChain = true,
  chainError = null, pvp = null, line = LINES.run,
} = {}) {
  const backfill = [1, 2, 9, 10, 11, 12].map(frameAt);
  let live = [13, 14].map(frameAt);
  if (pvp) live = [live[0], pvpFrame(live[1], { kill: pvp === 'kill' })];
  const last = live[live.length - 1];
  const methods = locked ? [...STARTED_TXS, 'lock_market'] : STARTED_TXS;
  const state = {
    ...clone(FINAL),
    phase: 'running',
    tick: 12,
    roster: frameAt(12).roster,
    auto_running: !paused,
    can_control: host,
    winner: null,
    winner_name: null,
    win_reason: null,
    near: onChain
      ? nearBlock(SEASON_ID, 'Running', methods, { chain_error: chainError })
      : { enabled: false },
  };
  const world = {
    state,
    map: clone(season.map),
    sites: sitesFor(last.roster, { pvp: Boolean(pvp) }),
    frames: backfill,
    live: [
      ...live.map((f) => ({ event: 'frame', data: f })),
      { event: 'commentary', data: chan(14, line) },
    ],
  };
  return id === SEASON_ID ? world : rename(world, SEASON_ID, id);
}

/** The recorded season at tick 2: four challengers still on the surface. */
function earlyWorld({ host = false, locked = false } = {}) {
  const state = {
    ...clone(FINAL),
    phase: 'running',
    tick: 2,
    roster: frameAt(2).roster,
    auto_running: true,
    can_control: host,
    winner: null,
    winner_name: null,
    win_reason: null,
    near: nearBlock(SEASON_ID, 'Running', locked ? [...STARTED_TXS, 'lock_market'] : STARTED_TXS),
  };
  return {
    state,
    map: clone(season.map),
    sites: sitesFor(state.roster),
    frames: [frameAt(1)],
    live: [
      { event: 'frame', data: frameAt(2) },
      { event: 'commentary', data: chan(2, LINES.early) },
    ],
  };
}

/** The recorded season after its last tick. */
function finishedWorld({
  extinction = false, settled = true, reason = null, liveEnd = false,
} = {}) {
  const state = clone(FINAL);
  const frames = [frameAt(37), frameAt(38)];
  if (reason) {
    // hand edit: the same crown, won another way
    state.win_reason = reason;
    frames[1].win_reason = reason;
  }
  if (!settled) {
    state.near = nearBlock(SEASON_ID, 'Running', [...STARTED_TXS, 'lock_market', 'report_events'], { queue_depth: 1, queue_depth_total: 1 });
  }
  if (extinction) {
    // hand edit: the same last tick, with nobody left standing
    const causes = ['slain by Wraith Tyrant', 'slain by Threshold Shadow', 'slain by Drowned Skeleton', 'a spike trap', 'slain by Frost Shadow', 'slain by Crypt Skeleton'];
    const kill = (roster) => roster.forEach((a, i) => {
      Object.assign(a, { alive: false, hp: 0, in_combat: false, cause_of_death: causes[i % causes.length] });
    });
    kill(state.roster);
    kill(frames[1].roster);
    Object.assign(state, { winner: null, winner_name: null, win_reason: 'extinction' });
    Object.assign(frames[1], { winner: null, winner_name: null, win_reason: 'extinction' });
    const end = frames[1].events.find((e) => e.event_type === 'season_end');
    end.data = { winner: null, winner_name: null, win_reason: 'extinction', tick: 38 };
    end.description = 'The season is over — no one survived.';
  }
  const signOff = { event: 'commentary', data: chan(38, extinction ? LINES.none : LINES.won) };
  if (liveEnd) {
    // watched to the end: attach at tick 37, the last tick plays live
    return {
      state: {
        ...state, phase: 'running', tick: 37, roster: frames[0].roster, auto_running: true, winner: null, winner_name: null, win_reason: null,
      },
      map: clone(season.map),
      sites: {},
      frames: [frames[0]],
      live: [{ event: 'frame', data: frames[1] }, signOff],
      closeAfter: true,
    };
  }
  return {
    state,
    map: clone(season.map),
    sites: {},
    frames,
    // the server holds a finished stream open for the sign-off, then closes
    live: [signOff],
    closeAfter: true,
  };
}

/** The recorded arena lobby, with challengers seated (hand edit). */
function lobbyWorld({
  seated = 3, host = false, hosted = false, chainOpen = true,
} = {}) {
  const state = clone(lobbyFx.state);
  const id = state.world_id;
  const spawn = season.map.spawn_ring;
  state.roster = FINAL.roster.slice(0, seated).map((a, i) => ({
    in_combat: false,
    agent_id: a.agent_id,
    name: a.name,
    tactics: a.tactics,
    color: a.color,
    // hand edit: the third seat is a visitor's own agent, over the API
    brain: i === 2 ? 'external' : a.brain,
    preset: a.preset,
    ready: i < 2,
    ...(hosted ? {} : { pass_id: a.pass_id }),
    alive: true,
    hp: a.max_hp,
    max_hp: a.max_hp,
    kills: 0,
    mob_kills: 0,
    weapon: a.weapon,
    weapon_bonus: a.weapon_bonus,
    position: { kind: 'overworld', hex: spawn[i], site_id: null, room: null },
    last_action: null,
    cause_of_death: null,
  }));
  state.joined = seated;
  state.can_control = host;
  if (hosted) {
    state.near = { enabled: false };
    state.pool_size = 10;
  }
  if (!chainOpen) {
    // the season is still being opened on NEAR: nothing sent yet
    state.near = { ...state.near, season_status: null, recent_txs: [] };
  }
  return {
    state,
    map: rename(season.map, SEASON_ID, id),
    sites: {},
    frames: [],
    live: [],
  };
}

function lobbyArena({ seated, wait }) {
  const arena = clone(lobbyFx.arena);
  const players = FINAL.roster.slice(0, seated).map((a) => ({ name: a.name, pass_id: a.pass_id }));
  arena.lobby = {
    ...arena.lobby,
    seats_taken: seated,
    players,
    waiting_for: wait,
    starts_in_s: wait === 'countdown' ? 47.6 : null,
  };
  if (wait === 'running_season') {
    arena.running = { world_id: RUNNING_ALIAS, tick: 12, max_ticks: 150, season_status: 'Running', stage: 'ticking' };
  }
  return arena;
}

// ---------------------------------------------------------------------------
// the chain
// ---------------------------------------------------------------------------

// What others have staked, NEAR per pass (hand edit: the recorded season had
// an empty market).
const OTHERS = {
  [PASS('Kell')]: 0.42, [PASS('Marra')]: 0.25, [PASS('Dain')]: 0.18,
  [PASS('Vex')]: 0.12, [PASS('Bren')]: 0.3, [PASS('MIMIR')]: 0.1,
};
const LOBBY_OTHERS = { [PASS('MIMIR')]: 0.05, [PASS('Kell')]: 0.15, [PASS('Marra')]: 0.02 };
const ENTRY_STAKE = '50000000000000000000000';

/**
 * get_season, get_market and the visitor's get_bets for one season, in the
 * recorded shapes. `mine` is the visitor's stake per pass, in NEAR.
 */
function chainSeason(seasonId, {
  status, open, roster, others = OTHERS, mine = {}, winnerPass = null, refund = false,
}) {
  const passes = roster.filter((a) => a.pass_id).map((a) => a);
  const amount = (p) => yocto(others[p] ?? 0) + yocto(mine[p] ?? 0);
  const totals = passes.map((a) => ({ pass_id: a.pass_id, amount: asText(amount(a.pass_id)) }));
  const pool = totals.reduce((s, t) => s + BigInt(t.amount), 0n);
  const settled = status === 'Settled';
  const over = settled || status === 'Cancelled';
  const winnerBets = winnerPass ? amount(winnerPass) : 0n;
  const cuts = cutsFrom(chainFx.config);
  const losing = pool - winnerBets;
  const distributable = settled && !refund
    ? pool - (losing * cuts.agentBps) / 10000n - (losing * cuts.houseBps) / 10000n
    : 0n;
  const myRows = Object.entries(mine).map(([pass_id, near]) => ({ pass_id, amount: asText(yocto(near)) }));
  const myStake = myRows.reduce((s, r) => s + BigInt(r.amount), 0n);
  let claimable = null; // the contract answers null while the season is live
  if (over) {
    if (refund || status === 'Cancelled') claimable = myStake;
    else if (winnerPass && mine[winnerPass]) {
      claimable = settlePayout({
        pool, winnerBets, stakeOnWinner: yocto(mine[winnerPass]), ...cuts,
      });
    } else claimable = 0n;
  }
  return {
    season: {
      ...clone(chainFx.season_settled),
      season_id: seasonId,
      status,
      pot: over ? '0' : asText(BigInt(ENTRY_STAKE) * BigInt(passes.length)),
      winner: winnerPass,
      market_open: open,
      next_seq: over ? 1 : 0,
      entrants: passes.map((a) => ({
        pass_id: a.pass_id,
        name: a.name === 'MIMIR' ? 'MIMIR' : '',
        at_risk: over ? '0' : ENTRY_STAKE,
        alive: a.alive,
      })),
    },
    market: {
      ...clone(chainFx.market_settled),
      open,
      pool: asText(pool),
      totals,
      settled,
      winner: winnerPass,
      status,
      refund,
      winner_bets: asText(winnerBets),
      distributable: asText(distributable),
    },
    bets: { bets: myRows, claimable: claimable == null ? null : asText(claimable) },
  };
}

// ---------------------------------------------------------------------------
// steps: interactions the preview performs once the data is in. Targets are
// found by accessible name (aria-label, else text), never by class name.
// ---------------------------------------------------------------------------
export const STEPS = {
  // the season list
  'open-lobby': [{ click: /^Open a lobby$/ }],
  play: [{ click: /^Play w-[0-9a-f]+: bring your agent$/ }],
  operator: [{ click: /^Operator (sign-in|key (held|refused|accepted))$/ }],
  delete: [{ click: /^Delete w-[0-9a-f]+$/ }],
  // the lobby
  'start-now': [{ click: /^Start the season now$/ }],
  'bring-agent': [{ click: /^Bring your agent$/ }],
  'copy-invite': [{ click: /^Bring your agent$/ }, { click: /^Copy invite for your agent$/, settleMs: 150 }],
  // the top bar
  booth: [{ click: /^Booth settings$/ }],
  settings: [{ click: /^Booth settings$/ }], // the old name for the same dialog
  sound: [{ click: /^Sound effects$/ }],
  'create-account': [{ click: /^Play with a test account/ }],
  // the market dock
  bet: [{ click: /^Bet [\d.]+ NEAR on / }],
  claim: [{ click: /^Claim$/ }],
  help: [{ click: /^How betting works$/ }],
  fold: [{ click: /^Fold the market away$/ }],
  'tab-bets': [{ click: /^Your bets/ }],
  'tab-chain': [{ click: /^On chain$/ }],
  // the field
  'fold-field': [{ click: /^Fold the field away$/ }],
  'fold-both': [{ click: /^Fold the field away$/ }, { click: /^Fold the market away$/ }],
  dossier: [{ click: /^Open the dossier on Kell$/ }],
  'dossier-dead': [{ click: /^Open the dossier on Vex$/ }],
  dossiers: [{ click: /^Open the dossier on Kell$/ }, { click: /^Open the dossier on Bren$/ }],
};

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

const LANDING_ROWS = [
  // the recorded listing: the arena's open lobby and the last season
  ...landingFx.listing.worlds,
  // hand edits: more seasons, in every phase
  { world_id: RUNNING_ALIAS, phase: 'running', tick: 12, joined: 6, pool_size: 6, winner_name: null, can_control: false },
  { world_id: 'w-b3e85d10', phase: 'lobby', tick: 0, joined: 2, pool_size: 10, winner_name: null, can_control: false },
  { world_id: 'w-9d02f6c4', phase: 'finished', tick: 61, joined: 8, pool_size: 8, winner_name: 'Marra', can_control: false },
  { world_id: 'w-61e3ab07', phase: 'finished', tick: 44, joined: 6, pool_size: 6, winner_name: null, can_control: false },
];

function landing({ empty = false, host = false } = {}) {
  const run = runningWorld({ id: RUNNING_ALIAS });
  const rows = LANDING_ROWS.map((r) => ({ ...r, can_control: host }));
  return {
    title: empty ? 'Landing board, nothing on air' : 'Landing board',
    game: {
      list: { ...landingFx.listing, worlds: empty ? [] : rows },
      worlds: empty ? {} : {
        [RUNNING_ALIAS]: run,
        [SEASON_ID]: finishedWorld(),
        [lobbyFx.state.world_id]: lobbyWorld({ seated: 0 }),
      },
      arena: lobbyArena({ seated: 0, wait: 'player' }),
    },
    chain: {
      seasons: {
        [RUNNING_ALIAS]: chainSeason(RUNNING_ALIAS, { status: 'Running', open: true, roster: run.state.roster }),
        [SEASON_ID]: chainSeason(SEASON_ID, { status: 'Settled', open: false, roster: FINAL.roster, winnerPass: PASS('Kell') }),
      },
    },
    guest: true,
    ready: ['list'],
  };
}

function runningScenario(params, {
  title, open = true, mine = {}, locked = false,
} = {}) {
  // entrants=recorded: only the passes that really entered the recorded
  // season on chain (three of six; the others' enter_season failed)
  const entered = params.get('entrants') === 'recorded'
    ? new Set(chainFx.season_settled.entrants.map((e) => e.pass_id)) : null;
  const slip = params.get('follow') === 'slip';
  const host = params.get('host') === '1';
  const world = slip
    ? earlyWorld({ host, locked })
    : runningWorld({
      host,
      paused: params.get('paused') === '1',
      locked,
      onChain: params.get('chain') !== 'off',
      chainError: params.get('chain') === 'error'
        ? 'NEAR RPC error: the operator account cannot pay for gas right now' : null,
    });
  const status = 'Running';
  return {
    title,
    url: slip ? { pass: PASS('Marra') } : {},
    game: { worlds: { [SEASON_ID]: world } },
    chain: {
      seasons: {
        [SEASON_ID]: chainSeason(SEASON_ID, {
          status,
          open: open && !locked,
          roster: entered ? world.state.roster.filter((a) => entered.has(a.pass_id)) : world.state.roster,
          mine,
        }),
      },
    },
    guest: true,
  };
}

const BASES = {
  landing: (p) => landing({ host: p.get('host') === '1' }),
  'landing-empty': () => landing({ empty: true }),
  'landing-notice': () => ({
    ...landing(),
    title: 'Landing board after a dead link',
    url: { world: DEAD_WORLD },
  }),

  boot: () => ({
    title: 'Connecting curtain',
    game: { worlds: { [SEASON_ID]: { ...runningWorld(), stateMode: 'hold' } } },
    ready: ['state-held'],
  }),
  offline: () => ({
    title: 'Signal lost',
    game: { worlds: { [SEASON_ID]: { ...runningWorld(), stateMode: 'down' } } },
    ready: ['state-down'],
  }),
  rotate: (p) => ({ ...runningScenario(p, { title: 'Portrait gate' }) }),

  lobby: (p) => {
    const world = lobbyWorld({ seated: 3 });
    return {
      title: 'Arena lobby, countdown running',
      url: p.get('follow') === 'slip' ? { pass: PASS('Kell') } : {},
      game: {
        worlds: { [world.state.world_id]: world },
        arena: lobbyArena({ seated: 3, wait: 'countdown' }),
        arenaStart: p.get('start') === 'hold'
          ? { hold: true }
          : { status: 429, body: { detail: 'A house season can start again in 212s' } },
      },
      chain: {
        seasons: {
          [world.state.world_id]: chainSeason(world.state.world_id, {
            status: 'Open', open: true, roster: world.state.roster, others: LOBBY_OTHERS,
          }),
        },
      },
      guest: p.get('account') !== 'none',
      ready: ['arena'],
    };
  },
  'lobby-waiting': (p) => {
    const wait = p.get('wait') || 'player';
    const seated = wait === 'player' || wait === 'chain' ? 0 : 1;
    const world = lobbyWorld({ seated, chainOpen: wait !== 'chain' });
    return {
      title: `Arena lobby waiting for ${wait}`,
      game: {
        worlds: { [world.state.world_id]: world },
        arena: lobbyArena({ seated, wait }),
      },
      chain: {
        // waiting for the chain: the contract has no such season yet
        seasons: wait === 'chain' ? {} : {
          [world.state.world_id]: chainSeason(world.state.world_id, {
            status: 'Open', open: true, roster: world.state.roster, others: {},
          }),
        },
      },
      guest: true,
      ready: ['arena'],
    };
  },
  'lobby-hosted': (p) => {
    const world = lobbyWorld({ seated: 4, hosted: true, host: p.get('host') === '1' });
    return {
      title: 'Hosted lobby (no arena, no chain)',
      game: { worlds: { [world.state.world_id]: world }, arena: { enabled: false } },
      contract: false,
      ready: ['arena'],
    };
  },

  'running-open': (p) => runningScenario(p, { title: 'Running, market open, no bets yet' }),
  'running-bet': (p) => runningScenario(p, {
    title: 'Running, the visitor backs two agents',
    mine: { [PASS('Kell')]: 0.05, [PASS('Marra')]: 0.01 },
  }),
  'running-locked': (p) => runningScenario(p, {
    title: 'Running, market locked',
    locked: true,
    mine: { [PASS('Kell')]: 0.05 },
  }),
  'no-account': (p) => ({ ...runningScenario(p, { title: 'Running, no test account in this browser' }), guest: false }),
  'running-sim': (p) => ({
    ...runningScenario(p, { title: p.get('chain') === 'off' ? 'Season off chain: practice chips' : 'No contract: practice chips' }),
    contract: p.get('chain') === 'off',
    storage: p.get('bets') === '1'
      ? { 'sbx-chips': 650, [`sbx-bets:${SEASON_ID}`]: { [AGENT('Kell')]: 250, [AGENT('Bren')]: 100 } }
      : {},
  }),

  'follow-overworld': (p) => ({
    ...runningScenario(p, { title: 'Following Marra on the surface' }),
    url: { pass: PASS('Marra') },
    game: { worlds: { [SEASON_ID]: earlyWorld() } },
  }),
  'hex-picker': (p) => ({
    ...runningScenario(p, { title: 'Crowded hex: who to follow' }),
    // the Western Crypt's mouth, where Vex and Bren went down together
    steps: [{ hex: season.map.sites.site_2.entrances['0,2'] }],
  }),
  'follow-dungeon': (p) => ({
    ...runningScenario(p, { title: 'Following Kell underground' }),
    url: { pass: PASS('Kell') },
    game: { worlds: { [SEASON_ID]: { ...runningWorld({ line: LINES.dungeon }), siteMode: p.get('net') === 'hold' ? 'hold' : 'ok' } } },
    ready: p.get('net') === 'hold' ? ['site-held'] : ['site', 'standin:dungeon'],
    // stall=1: hold past the curtain's 12 s ceiling, to its stalled note
    settleMs: p.get('stall') === '1' ? 12600 : 2600,
  }),
  'follow-dungeon-pvp': (p) => ({
    ...runningScenario(p, { title: 'Following Vex: Bren turns on her' }),
    url: { pass: PASS('Vex') },
    game: { worlds: { [SEASON_ID]: runningWorld({ pvp: 'strike', line: LINES.pvp }) } },
    ready: ['site', 'standin:dungeon'],
    settleMs: 2600,
  }),
  'follow-dungeon-death': (p) => ({
    ...runningScenario(p, { title: 'Following Vex as she falls' }),
    url: { pass: PASS('Vex') },
    game: { worlds: { [SEASON_ID]: runningWorld({ pvp: 'kill', line: LINES.pvp }) } },
    ready: ['site'],
    // the death cut waits 2.6 s after the killing blow; cut=blow shows the
    // HUD in that moment instead
    settleMs: p.get('cut') === 'blow' ? 500 : 3600,
  }),

  'finale-won': (p) => finale('Finale: the visitor backed the winner', {
    mine: { [PASS('Kell')]: 0.05, [PASS('Dain')]: 0.01 }, reason: p.get('reason'),
  }),
  'finale-sim': (p) => ({
    // watched live to the last tick: practice chips settle only when the
    // season ends in front of you (opened on a finished season, the stake
    // has not loaded when settlement runs, and no payout shows)
    ...finale('Finale on practice chips', { liveEnd: true }),
    contract: false,
    // the simulated market's own storage: a stake on Kell, or on Marra
    storage: {
      'sbx-chips': 900,
      [`sbx-bets:${SEASON_ID}`]: { [AGENT(p.get('bet') === 'lost' ? 'Marra' : 'Kell')]: 100 },
    },
  }),
  'finale-lost': () => finale('Finale: the visitor backed a loser', { mine: { [PASS('Marra')]: 0.05 } }),
  'finale-refund': () => finale('Finale: nobody backed the winner, bets refunded', {
    mine: { [PASS('Marra')]: 0.05 }, others: { [PASS('Dain')]: 0.2, [PASS('Vex')]: 0.1 }, refund: true,
  }),
  'finale-settling': () => finale('Finale: waiting for the result on chain', { mine: { [PASS('Kell')]: 0.05 }, settled: false }),
  'finale-none': () => finale('Finale: no one survived', { extinction: true }),

  tv: (p) => ({ ...runningScenario(p, { title: 'TV cut' }), needView: 'tv' }),
};

function finale(title, {
  mine = {}, others = OTHERS, refund = false, settled = true, extinction = false, reason = null, liveEnd = false,
}) {
  const world = finishedWorld({
    extinction, settled, reason, liveEnd,
  });
  const status = settled ? 'Settled' : 'Running';
  return {
    title,
    game: { worlds: { [SEASON_ID]: world } },
    chain: {
      seasons: {
        [SEASON_ID]: chainSeason(SEASON_ID, {
          status,
          open: false,
          roster: FINAL.roster,
          mine,
          others,
          winnerPass: extinction || !settled ? null : PASS('Kell'),
          refund: refund || (extinction && settled),
        }),
      },
    },
    guest: true,
  };
}

/** Sub-state parameters that apply to every scenario. */
function applyParams(spec, p) {
  const out = { ...spec, steps: [...(spec.steps ?? [])], ready: [...(spec.ready ?? [])] };
  const step = p.get('step');
  if (step) {
    if (!STEPS[step]) throw new Error(`Unknown step "${step}". Known: ${Object.keys(STEPS).join(', ')}`);
    out.steps.push(...STEPS[step]);
  }
  const hex = p.get('hex');
  if (hex) out.steps.push({ hex });
  const net = p.get('net');
  if (net === 'hold' || net === 'down') {
    if (out.game?.list) {
      out.game = { ...out.game, listMode: net };
      out.ready = out.ready.filter((k) => k !== 'list').concat(net === 'hold' ? ['list-held'] : ['list-down']);
    }
  }
  if (p.get('host') === 'open' && out.game?.list) {
    out.game = { ...out.game, list: { ...out.game.list, can_create: true, operator_only: false } };
  }
  const operator = p.get('operator');
  if (operator === 'refused' || operator === 'accepted') {
    out.storage = { ...out.storage, 'sbx-admin-key': 'preview-operator-key' };
    out.game = { ...out.game, whoami: { operator: operator === 'accepted', operator_only: true, admin_key_configured: true } };
    if (operator === 'accepted') out.game.list = { ...out.game.list, can_create: true };
    out.ready.push('whoami');
  }
  if (p.get('account') === 'gone') out.guestGone = true;
  out.tx = p.get('tx') || 'pending';
  out.guestApi = p.get('guest') || 'pending';
  out.rpcDown = p.get('rpc') === 'down';
  if (p.get('feed') === '1') out.feed = true;
  return out;
}

/**
 * The scenario named by ?preview=, as a spec. Throws for an unknown name;
 * PreviewApp shows the index instead.
 */
export function buildScenario(params) {
  const name = params.get('preview');
  const base = BASES[name];
  if (!base) return null;
  const spec = applyParams({ contract: true, ...base(params) }, params);
  spec.name = name;
  spec.contractId = spec.contract ? CONTRACT_ID : '';
  // the world the app attaches to, unless the scenario is a landing board
  const worldIds = Object.keys(spec.game?.worlds ?? {});
  if (!spec.game?.list && !spec.url?.world && worldIds.length) {
    spec.url = { ...spec.url, world: worldIds[0] };
  }
  // what must have been answered before the page counts as ready
  if (!spec.ready.some((k) => /^(state|list)-(held|down)$/.test(k))) {
    if (spec.url?.world && spec.game.worlds[spec.url.world]) {
      spec.ready.push('state', 'map', 'stream-done');
    }
    const onChain = spec.game.worlds[spec.url?.world]?.state?.near?.enabled !== false;
    if (spec.contractId && onChain && spec.url?.world && spec.chain?.seasons?.[spec.url.world] && !spec.rpcDown) {
      spec.ready.push('rpc:get_config', 'rpc:get_market');
      spec.liveAfter = ['rpc:get_config', 'rpc:get_market'];
      if (spec.guest && !spec.guestGone) spec.ready.push('rpc:view_account');
    }
  }
  return spec;
}

export const SCENARIO_NAMES = Object.keys(BASES);
export { SEASON_ID, PASS, LINES, FINAL as FINAL_STATE, clone };
export const GALLERY_ROSTER = FINAL.roster;
export const BOSS_SITE_NAME = season.map.sites[season.map.boss_site_id]?.name ?? 'Heart of the Island';
export { chainFx };

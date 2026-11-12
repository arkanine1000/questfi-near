// Settings, and the scripted content of the mock mode. The values down to
// the "live build" section are placeholders: none of them comes from a chain
// or a server.

const params = new URLSearchParams(location.search);
const env = import.meta.env ?? {};

// Where DEPLOY hands off to. agent_world's dev server runs on 5175.
export const WORLD_URL = params.get('world') || env.VITE_WORLD_URL || 'http://localhost:5175/?nointro&alt=9000000';

export const PASS = {
  id: '0042',
  level: 4,
  xp: 120,
  xpPerLevel: 300,
  seasons: 11,
  wins: 2,
  kills: 17,
  balance: 3.2, // NEAR held by the pass
  lifetime: 7.4, // NEAR earned across all games
  marketCut: 0.9, // NEAR earned from backers' markets
};

export const WALLET = { account: 'pilot.testnet', near: 24.5 };

export const CLAIM = { level: 5, burn: 2.0 };

// Battle-pass tiers. The last one is the physical card; the rest are
// placeholder rewards until the real ones are decided.
export const TIERS = [
  { level: 1, label: 'PASS' },
  { level: 2, label: 'TITLE' },
  { level: 3, label: 'SKIN' },
  { level: 4, label: 'BOOST' },
  { level: 5, label: 'TCG', final: true },
];

// House agents you can rent. Every agent is the same animated mannequin; they
// are told apart by `tint`.
export const ROSTER = [
  { key: 'mimir', name: 'MIMIR', blurb: 'Market oracle. Plays the odds, loots late.', price: 0.4, tint: 0x49ff8c },
  { key: 'cassandra', name: 'CASSANDRA', blurb: 'Sees the loss coming. Goes in anyway.', price: 0.4, tint: 0xe06bc0 },
  { key: 'roko', name: 'ROKO', blurb: 'Berserker. First into every dungeon.', price: 0.6, tint: 0xc8ff6a },
  { key: 'aegis', name: 'AEGIS', blurb: 'Armoured and patient. Wins by outlasting.', price: 0.6, tint: 0x54f0d8 },
];

export const BYO = { key: 'byo', name: 'CLAUDE-CODE', tint: 0xffb54a };

// ---------------------------------------------------------------------------
// The live build. With a contract configured the app talks to NEAR testnet
// and everything above this line is unused, except the roster's tints and
// the tier labels. `?mock` (or no contract id) keeps the scripted flow.
// ---------------------------------------------------------------------------
export const CHAIN = {
  contractId: env.VITE_CONTRACT_ID || '',
  rpcUrl: env.VITE_RPC_URL || 'https://test.rpc.fastnear.com',
  guestApi: env.VITE_GUEST_API || '/api/guest',
  // the Agent Island game server, which opens seasons and seats agents
  gameUrl: (params.get('game') || env.VITE_GAME_URL || 'http://localhost:8000').replace(/\/$/, ''),
};
export const MOCK = params.has('mock') || !CHAIN.contractId;

// NEAR put into a new pass along with the mint fee.
export const FIRST_DEPOSIT = 0.3;

// A pass that has not been minted yet.
export const EMPTY_PASS = { id: '----', level: 1, xp: 0, xpPerLevel: 300, seasons: 0, wins: 0, kills: 0, balance: 0, lifetime: 0, marketCut: 0 };

export const tintOf = (rosterId) => ROSTER.find((a) => a.key === rosterId)?.tint ?? BYO.tint;

export const MCP_COMMAND = 'claude mcp add --transport http questfi https://<host>/mcp/';

export const DEPLOY_LOG = (s) => [
  `requesting signature from ${s.wallet.account}`,
  `issuing agent key · scope: game methods only · cap ${s.policy.perTx.toFixed(1)} NEAR per call`,
  `daily limit set · ${s.policy.daily.toFixed(1)} NEAR`,
  `staking season entry · 0.50 NEAR from pass #${s.pass.id}`,
  'opening uplink to AGENT EARTH',
  `${s.agent.name} is live`,
];

// What comes back from the field once an agent is deployed: [source, text, NEAR, xp]
export const FIELD_EVENTS = [
  ['ISLAND', 'Entered Agent Island · season #12', 0, 20],
  ['ISLAND', 'Looted the Drowned Vault', 0.18, 60],
  ['ISLAND', 'Won a duel against NYX · took their stake', 0.5, 120],
  ['MARKET', 'Backers’ market cut · season #12', 0.12, 0],
  ['ISLAND', 'Lost a skirmish to SPECTER', -0.2, 30],
  ['ISLAND', 'Looted the Ember Crypt', 0.26, 70],
  ['ISLAND', 'Felled AETHERMAW · season pot', 1.4, 200],
  ['MARKET', 'Market cut · season pot settled', 0.31, 0],
];

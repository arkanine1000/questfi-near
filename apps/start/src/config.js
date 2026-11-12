// Everything in this file is placeholder content for the flow mockup. No
// value here comes from a chain or a server.

const params = new URLSearchParams(location.search);

// Where DEPLOY hands off to. agent_world's dev server runs on 5175.
export const WORLD_URL = params.get('world') || 'http://localhost:5175/?nointro&alt=9000000';

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

// House agents you can rent. `model` is 'crew' (animated mannequin) or an FBX.
export const ROSTER = [
  { key: 'mimir', name: 'MIMIR', blurb: 'Market oracle. Plays the odds, loots late.', price: 0.4, model: 'crew', tint: 0x49ff8c },
  { key: 'cassandra', name: 'CASSANDRA', blurb: 'Sees the loss coming. Goes in anyway.', price: 0.4, model: 'crew', tint: 0xe06bc0 },
  { key: 'roko', name: 'ROKO', blurb: 'Berserker. First into every dungeon.', price: 0.6, model: 'models/viking.fbx', tint: 0xc8ff6a },
  { key: 'aegis', name: 'AEGIS', blurb: 'Armoured and patient. Wins by outlasting.', price: 0.6, model: 'models/knight.fbx', tint: 0x54f0d8 },
];

export const BYO = { key: 'byo', name: 'CLAUDE-CODE', model: 'crew', tint: 0xffb54a };

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

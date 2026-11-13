/**
 * Every preview URL worth a screenshot, as plain data.
 *
 * No imports, so the screenshot script (scripts/preview-shots.mjs) can read
 * it under Node. `name` names the screenshot file and is what --only takes;
 * `query` is the page's query string. The scenario itself is the `preview`
 * parameter; the others are the sub-state parameters PreviewApp understands:
 *
 *   step=<name>    an interaction the preview performs once the data is in
 *                  (see STEPS in scenarios.js)
 *   tx=pending|fail|ok      what the chain does with a bet or a claim
 *   host=1         this browser holds the season's host key
 *   host=open      the server lets anyone open a lobby
 *   paused=1       the season's clock is stopped
 *   feed=1         the on-chain feed carries this browser's own transactions
 *   rpc=down       the NEAR RPC cannot be reached
 *   net=hold|down  the game server never answers / is down
 *   hex=q,r        click that hex on the island (the crowded-hex picker)
 *   wait=...       what an arena lobby waits for: countdown, player,
 *                  running_season, chain
 *   view=tv        the TV cut (a real app parameter, read at load)
 *
 * `core` scenarios are shot at every default viewport; the rest, sub-states
 * of a core one, at the first only. `viewports` overrides both.
 */

export const DEFAULT_VIEWPORTS = [[1600, 900], [1280, 720], [844, 390]];

export const SCENARIOS = [
  // ---- the landing board ----
  { name: 'landing', core: true, query: 'preview=landing' },
  { name: 'landing-open', query: 'preview=landing&host=open' },
  { name: 'landing-lobby-form', query: 'preview=landing&host=open&step=open-lobby' },
  { name: 'landing-play', query: 'preview=landing&step=play' },
  { name: 'landing-play-more', query: 'preview=landing&step=play-more' },
  { name: 'landing-operator', query: 'preview=landing&step=operator' },
  { name: 'landing-operator-refused', query: 'preview=landing&operator=refused' },
  { name: 'landing-notice', query: 'preview=landing-notice' },
  { name: 'landing-scanning', query: 'preview=landing&net=hold' },
  { name: 'landing-error', query: 'preview=landing&net=down' },
  { name: 'landing-empty', core: true, query: 'preview=landing-empty' },
  { name: 'landing-empty-open', query: 'preview=landing-empty&host=open' },

  // ---- connecting, offline, portrait ----
  { name: 'boot', core: true, query: 'preview=boot' },
  { name: 'offline', core: true, query: 'preview=offline' },
  { name: 'rotate', query: 'preview=rotate', viewports: [[390, 844]] },

  // ---- the lobby ----
  { name: 'lobby', core: true, query: 'preview=lobby' },
  { name: 'lobby-start-refused', query: 'preview=lobby&step=start-now' },
  { name: 'lobby-waiting', core: true, query: 'preview=lobby-waiting' },
  { name: 'lobby-waiting-running', query: 'preview=lobby-waiting&wait=running_season' },
  { name: 'lobby-waiting-chain', query: 'preview=lobby-waiting&wait=chain' },
  { name: 'lobby-invite-more', query: 'preview=lobby&step=invite-more' },
  { name: 'lobby-slip', query: 'preview=lobby&step=follow-first' },
  { name: 'lobby-hosted', query: 'preview=lobby-hosted' },
  { name: 'lobby-hosted-host', query: 'preview=lobby-hosted&host=1' },
  { name: 'lobby-no-account', query: 'preview=lobby&account=none' },

  // ---- a running season and its market ----
  { name: 'running-open', core: true, query: 'preview=running-open' },
  { name: 'running-open-slip', query: 'preview=running-open&follow=slip' },
  { name: 'running-bet', core: true, query: 'preview=running-bet' },
  { name: 'running-bet-slip', query: 'preview=running-bet&follow=slip' },
  { name: 'running-pending', query: 'preview=running-open&follow=slip&step=bet&tx=pending' },
  { name: 'running-bet-failed', query: 'preview=running-open&follow=slip&step=bet&tx=fail' },
  { name: 'running-bet-placed', query: 'preview=running-open&follow=slip&step=bet&tx=ok' },
  { name: 'running-locked', core: true, query: 'preview=running-locked' },
  { name: 'running-locked-slip', query: 'preview=running-locked&follow=slip' },
  { name: 'running-feed', query: 'preview=running-bet&feed=1' },
  { name: 'running-folded', query: 'preview=running-open&step=fold' },
  { name: 'running-settings', query: 'preview=running-open&host=1&step=settings' },
  { name: 'running-paused', query: 'preview=running-open&host=1&paused=1' },
  { name: 'running-rpc-down', query: 'preview=running-open&follow=slip&rpc=down' },
  { name: 'running-chain-error', query: 'preview=running-bet&chain=error' },
  { name: 'running-sim', query: 'preview=running-sim' },
  { name: 'running-sim-bets', query: 'preview=running-sim&step=chip-hover' },
  { name: 'running-off-chain', query: 'preview=running-sim&chain=off' },
  { name: 'no-account', core: true, query: 'preview=no-account' },
  { name: 'no-account-slip', query: 'preview=no-account&follow=slip' },
  { name: 'account-creating', query: 'preview=no-account&step=create-account&guest=pending' },
  { name: 'account-created', query: 'preview=no-account&step=create-account&guest=ok' },
  { name: 'account-refused', query: 'preview=no-account&step=create-account&guest=fail' },
  { name: 'account-gone', query: 'preview=running-open&account=gone' },

  // ---- follow mode ----
  { name: 'follow-overworld', core: true, query: 'preview=follow-overworld' },
  { name: 'hex-picker', core: true, query: 'preview=hex-picker' },
  { name: 'follow-dungeon', core: true, query: 'preview=follow-dungeon' },
  { name: 'follow-dungeon-log', query: 'preview=follow-dungeon&step=combat-log' },
  { name: 'follow-dungeon-chan', query: 'preview=follow-dungeon&step=chan-blip' },
  { name: 'follow-dungeon-pvp', core: true, query: 'preview=follow-dungeon-pvp' },
  { name: 'follow-dungeon-descent', query: 'preview=follow-dungeon&net=hold' },
  { name: 'follow-dungeon-death', query: 'preview=follow-dungeon-death' },

  // ---- the finale ----
  { name: 'finale-won', core: true, query: 'preview=finale-won' },
  { name: 'finale-claiming', query: 'preview=finale-won&step=claim&tx=pending' },
  { name: 'finale-claimed', query: 'preview=finale-won&step=claim&tx=ok' },
  { name: 'finale-lost', core: true, query: 'preview=finale-lost' },
  { name: 'finale-refund', query: 'preview=finale-refund' },
  { name: 'finale-settling', query: 'preview=finale-settling' },
  { name: 'finale-none', core: true, query: 'preview=finale-none' },

  // ---- the TV cut ----
  { name: 'tv', core: true, query: 'preview=tv&view=tv' },
  { name: 'tv-lobby', query: 'preview=lobby&view=tv' },

  // ---- what lives inside the canvases ----
  { name: 'gallery', core: true, query: 'preview=gallery' },
];

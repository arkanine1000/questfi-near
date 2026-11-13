/**
 * Every preview URL worth a screenshot, as plain data.
 *
 * No imports, so the screenshot script (scripts/preview-shots.mjs) can read
 * it under Node. `name` names the screenshot file and is what --only takes;
 * `query` is the page's query string. The scenario itself is the `preview`
 * parameter (see BASES in scenarios.js); the others pick a sub-state:
 *
 *   step=<name>          an interaction performed once the data is in (STEPS
 *                        in scenarios.js)
 *   tx=pending|fail|ok   what the chain does with a bet or a claim
 *   guest=pending|fail|ok  what the test-account service does
 *   follow=slip          follow an agent on the surface (the bet slip)
 *   host=1 | host=open   this browser holds the host key | anyone may open
 *                        a lobby
 *   paused=1             the season's clock is stopped
 *   feed=1               the on-chain feed carries the visitor's own txs
 *   bets=1               practice chips already staked (running-sim)
 *   chain=error|off      the game server's chain trouble | season off chain
 *   rpc=down             the NEAR RPC cannot be reached
 *   account=none|gone    no test account | one that no longer exists
 *   entrants=recorded    only the passes that entered the recorded season
 *   net=hold|down        the scenario's main request never answers | fails
 *   stall=1              hold the dungeon curtain past its 12 s ceiling
 *   cut=blow             the dungeon HUD at the killing blow, before the cut
 *   hex=q,r              click that hex on the island
 *   wait=countdown|player|running_season|chain   what an arena lobby awaits
 *   start=hold           "Start the season now" never answers
 *   operator=refused|accepted  a saved operator key and the server's verdict
 *   reason=boss|last_alive|timeout   how the winner won
 *   bet=lost             (finale-sim) the practice stake was on a loser
 *   view=tv, director=1  the app's own parameters, read at load
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
  { name: 'landing-host', query: 'preview=landing&host=1' },
  { name: 'landing-play', query: 'preview=landing&step=play' },
  { name: 'landing-operator', query: 'preview=landing&step=operator' },
  { name: 'landing-operator-refused', query: 'preview=landing&operator=refused' },
  { name: 'landing-operator-accepted', query: 'preview=landing&operator=accepted' },
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
  { name: 'lobby-slip', query: 'preview=lobby&follow=slip' },
  { name: 'lobby-no-account', query: 'preview=lobby&account=none' },
  { name: 'lobby-copied', query: 'preview=lobby&step=copy-invite' },
  { name: 'lobby-starting', query: 'preview=lobby&start=hold&step=start-now' },
  { name: 'lobby-start-refused', query: 'preview=lobby&step=start-now' },
  { name: 'lobby-waiting', core: true, query: 'preview=lobby-waiting' },
  { name: 'lobby-waiting-running', query: 'preview=lobby-waiting&wait=running_season' },
  { name: 'lobby-waiting-chain', query: 'preview=lobby-waiting&wait=chain' },
  { name: 'lobby-hosted', query: 'preview=lobby-hosted' },
  { name: 'lobby-hosted-host', query: 'preview=lobby-hosted&host=1' },

  // ---- a running season and its market ----
  { name: 'running-open', core: true, query: 'preview=running-open' },
  { name: 'running-open-slip', query: 'preview=running-open&follow=slip' },
  { name: 'running-pending', query: 'preview=running-open&follow=slip&step=bet&tx=pending' },
  { name: 'running-bet-failed', query: 'preview=running-open&follow=slip&step=bet&tx=fail' },
  { name: 'running-bet-placed', query: 'preview=running-open&follow=slip&step=bet&tx=ok' },
  { name: 'running-no-pass', query: 'preview=running-open&follow=slip&entrants=recorded' },
  { name: 'running-bet', core: true, query: 'preview=running-bet' },
  { name: 'running-bet-slip', query: 'preview=running-bet&follow=slip' },
  { name: 'running-feed', query: 'preview=running-bet&feed=1' },
  { name: 'running-chain-error', query: 'preview=running-bet&chain=error' },
  { name: 'running-locked', core: true, query: 'preview=running-locked' },
  { name: 'running-locked-slip', query: 'preview=running-locked&follow=slip' },
  { name: 'running-folded', query: 'preview=running-open&step=fold' },
  { name: 'running-settings', query: 'preview=running-open&host=1&step=settings' },
  { name: 'running-paused', query: 'preview=running-open&host=1&paused=1' },
  { name: 'running-director', query: 'preview=running-open&director=1' },
  { name: 'running-rpc-down', query: 'preview=running-open&follow=slip&rpc=down' },
  { name: 'running-sim', query: 'preview=running-sim' },
  { name: 'running-sim-slip', query: 'preview=running-sim&follow=slip' },
  { name: 'running-sim-bets', query: 'preview=running-sim&bets=1' },
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
  { name: 'follow-dungeon-pvp', core: true, query: 'preview=follow-dungeon-pvp' },
  { name: 'follow-dungeon-descent', query: 'preview=follow-dungeon&net=hold' },
  { name: 'follow-dungeon-stalled', query: 'preview=follow-dungeon&net=hold&stall=1' },
  { name: 'follow-dungeon-fallen', query: 'preview=follow-dungeon-death&cut=blow' },
  { name: 'follow-dungeon-death', query: 'preview=follow-dungeon-death' },

  // ---- the finale ----
  { name: 'finale-won', core: true, query: 'preview=finale-won' },
  { name: 'finale-claiming', query: 'preview=finale-won&step=claim&tx=pending' },
  { name: 'finale-claimed', query: 'preview=finale-won&step=claim&tx=ok' },
  { name: 'finale-timeout', query: 'preview=finale-won&reason=timeout' },
  { name: 'finale-last-alive', query: 'preview=finale-won&reason=last_alive' },
  { name: 'finale-lost', core: true, query: 'preview=finale-lost' },
  { name: 'finale-refund', query: 'preview=finale-refund' },
  { name: 'finale-settling', query: 'preview=finale-settling' },
  { name: 'finale-none', core: true, query: 'preview=finale-none' },
  { name: 'finale-sim-won', query: 'preview=finale-sim' },
  { name: 'finale-sim-lost', query: 'preview=finale-sim&bet=lost' },

  // ---- the TV cut ----
  { name: 'tv', core: true, query: 'preview=tv&view=tv' },
  { name: 'tv-lobby', query: 'preview=lobby&view=tv' },

  // ---- what lives inside the canvases ----
  { name: 'gallery', core: true, query: 'preview=gallery' },
];

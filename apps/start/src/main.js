import * as THREE from 'three';
import { createPost } from './post.js';
import { createCard, CARD_W } from './card.js';
import { createStage } from './stage.js';
import { PASS, WALLET, CLAIM, TIERS, ROSTER, BYO, MCP_COMMAND, DEPLOY_LOG, FIELD_EVENTS, WORLD_URL, MOCK, EMPTY_PASS } from './config.js';
import { createLive } from './live.js';
import { explorerTx } from './near.js';

// QuestFi start app. It runs in one of two modes:
// - live: the account, the pass, the agent key and every balance come from
//   the contract on NEAR testnet (live.js, near.js).
// - mock (`?mock`, or no contract configured): the wallet, balances, deploy
//   log and field events are scripted in config.js.
// The screen code below is shared; where the two differ, it branches on MOCK.

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (n) => `${n.toFixed(2)} NEAR`;
const cap = (n) => (n < 1 ? n.toFixed(2) : n.toFixed(1));
// account ids of test accounts are long; keep the ends
const shortAccount = (id, max = 22) => (id.length > max ? `${id.slice(0, max - 9)}…${id.slice(-8)}` : id);

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const state = {
  screen: 'card', // card → auth → manage → deploy (→ world overlay)
  unlocked: false,
  wallet: null,
  agent: null,
  deployed: false,
  claimed: false,
  flipped: false,
  policy: { perTx: 2.0, daily: 10.0 },
  pass: MOCK ? { ...PASS } : { ...EMPTY_PASS },
  log: [],
  // live mode
  hasPass: MOCK, // false until the account's pass is minted or found
  session: null, // the account and how it signs
  busy: null, // label of the action in flight
  roster: MOCK ? ROSTER : [], // house agents, from the contract
  limits: null, // slider ranges, from the contract's defaults
  limitResults: [], // what the limits test came back with
  policyDirty: false, // sliders moved but not stored yet
  season: null, // the season the pass last entered
};

function setScreen(s) {
  state.screen = s;
  document.body.dataset.screen = s;
}

// ---------------------------------------------------------------------------
// renderer / scene
// ---------------------------------------------------------------------------
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x010603);
scene.fog = new THREE.Fog(0x010603, 9, 26);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 80);
const CAM_POS = new THREE.Vector3(0, 1.5, 6.4);
const CAM_LOOK = new THREE.Vector3(0, 0.55, 0);
camera.position.copy(CAM_POS);
camera.lookAt(CAM_LOOK);

scene.add(new THREE.AmbientLight(0x9fffc8, 0.5));
const key = new THREE.DirectionalLight(0xcfffe0, 1.4);
key.position.set(3, 5, 4);
scene.add(key);

// floor grid + drifting motes
const grid = new THREE.GridHelper(60, 60, 0x0f5a2c, 0x0f5a2c);
grid.material.transparent = true;
grid.material.opacity = 0.35;
grid.position.y = -0.1;
scene.add(grid);

const MOTES = 420;
const motePos = new Float32Array(MOTES * 3);
for (let i = 0; i < MOTES; i++) {
  motePos[i * 3] = (Math.random() - 0.5) * 26;
  motePos[i * 3 + 1] = Math.random() * 7;
  motePos[i * 3 + 2] = (Math.random() - 0.5) * 22 - 3;
}
const moteGeo = new THREE.BufferGeometry();
moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({ color: 0x49ff8c, size: 0.035, transparent: true, opacity: 0.7 }));
scene.add(motes);

const post = createPost(renderer, scene, camera);
const stage = createStage(scene);
stage.group.scale.setScalar(0.001);
const card = createCard();
scene.add(card.group);

// ---------------------------------------------------------------------------
// screen-space placement helpers
// ---------------------------------------------------------------------------
const CARD_DIST = 5.2;
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
// the point under a pixel on the plane `depth` in front of the camera (depth,
// not ray length, so on-screen size is the same anywhere in the frame)
function pointAtPixel(px, py, depth, out) {
  _v.set((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1, 0.5).unproject(camera);
  _v.sub(camera.position).normalize();
  camera.getWorldDirection(_fwd);
  return out.copy(_v.multiplyScalar(depth / _v.dot(_fwd)).add(camera.position));
}
const worldPerPixel = (dist) => (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / innerHeight;

// The card has two homes: centre stage and its slot in the left column. Both
// are recomputed every frame (so it tracks resizes and the column sliding in)
// and `dock` (0 → 1, eased) blends between them on a fixed timeline.
const cardTarget = { pos: new THREE.Vector3(), scale: 1 };
const _centre = new THREE.Vector3();
const _docked = new THREE.Vector3();
const slot = document.querySelector('.card-slot');
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = (x) => 1 - (1 - x) ** 3;
let dock = 0;
function layoutCard() {
  const k = worldPerPixel(CARD_DIST) / CARD_W;
  pointAtPixel(innerWidth / 2, innerHeight * 0.5, CARD_DIST, _centre);
  const centreScale = Math.min(innerWidth * 0.62, innerHeight * 0.78, 640) * k;

  let cx;
  let cy;
  let wpx;
  const r = slot.getBoundingClientRect();
  if (r.width > 0) {
    cx = r.left + r.width / 2;
    cy = r.top + (r.height - 18) / 2;
    wpx = Math.min(r.width - 30, (r.height - 34) * 1.6);
  } else {
    // narrow layout: the slot is hidden, park the card top-centre
    cx = innerWidth / 2;
    cy = 64 + 74;
    wpx = Math.min(innerWidth * 0.5, 210);
  }
  pointAtPixel(cx, cy, CARD_DIST, _docked);

  const e = easeInOut(dock);
  cardTarget.pos.lerpVectors(_centre, _docked, e);
  cardTarget.scale = centreScale + (wpx * k - centreScale) * e;
}

// ---------------------------------------------------------------------------
// card face content
// ---------------------------------------------------------------------------
let lastCardKey = '';
function redrawCard(force = false) {
  const p = state.pass;
  const locked = !state.unlocked;
  // drawing both faces is two large canvases plus texture uploads, so skip it
  // when nothing printed on the card has changed
  const key = [p.id, p.level, p.xp, p.balance.toFixed(2), p.seasons, p.wins, p.kills, p.lifetime.toFixed(2),
    state.wallet?.account, state.agent?.name, locked, state.claimed, state.deployed].join('|');
  if (!force && key === lastCardKey) return;
  lastCardKey = key;
  card.redraw({
    id: p.id,
    level: p.level,
    xpFrac: p.xp / p.xpPerLevel,
    holder: state.wallet ? shortAccount(state.wallet.account).toUpperCase() : 'UNASSIGNED',
    agent: state.agent ? state.agent.name : '— —',
    balance: `${p.balance.toFixed(2)} N`,
    seasons: p.seasons,
    wins: p.wins,
    kills: p.kills,
    lifetime: near(p.lifetime),
    locked,
    status: locked
      ? 'LOCKED · AUTHENTICATE TO OPEN'
      : state.claimed
        ? 'PHYSICAL CARD CLAIMED'
        : state.deployed
          ? 'DEPLOYED · AGENT ISLAND'
          : 'ACTIVE',
  });
}

// ---------------------------------------------------------------------------
// DOM rendering
// ---------------------------------------------------------------------------
function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function pushLog(src, text, amt = 0, { tone = null, link = null } = {}) {
  state.log.unshift({ src, text, amt, tone, link });
  if (state.log.length > 40) state.log.pop();
  renderLog();
}

function renderLog() {
  const ul = $('log');
  ul.replaceChildren();
  if (!state.log.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing yet. Earnings from every game land here and on the pass.';
    ul.appendChild(li);
    return;
  }
  for (const e of state.log) {
    const li = document.createElement('li');
    if (e.tone) li.className = e.tone;
    const s = document.createElement('span');
    s.className = 'src';
    s.textContent = e.src;
    const t = document.createElement(e.link ? 'a' : 'span');
    t.textContent = e.text;
    if (e.link) {
      t.href = e.link;
      t.target = '_blank';
      t.rel = 'noopener';
    }
    const a = document.createElement('span');
    a.className = `amt${e.amt < 0 ? ' neg' : ''}`;
    a.textContent = e.amt ? `${e.amt > 0 ? '+' : ''}${e.amt.toFixed(2)}` : '';
    li.append(s, t, a);
    ul.appendChild(li);
  }
}

function renderRoster() {
  const root = $('roster');
  root.replaceChildren();
  for (const a of state.roster) {
    const b = document.createElement('button');
    b.className = `agent${state.agent?.key === a.key ? ' on' : ''}`;
    b.disabled = state.deployed || !!state.busy;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.color = `#${a.tint.toString(16).padStart(6, '0')}`;
    const mid = document.createElement('span');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = a.name;
    const bl = document.createElement('span');
    bl.className = 'bl';
    bl.textContent = a.blurb;
    mid.append(nm, bl);
    const pr = document.createElement('span');
    pr.className = 'pr';
    pr.textContent = a.price.toFixed(2);
    const sm = document.createElement('small');
    sm.textContent = 'NEAR / SEASON';
    pr.appendChild(sm);
    b.append(dot, mid, pr);
    b.addEventListener('click', () => (MOCK ? linkAgent : live.linkAgent)({ ...a, rented: true }));
    root.appendChild(b);
  }
}

// battle-pass track: one node per tier, filled up to the current level plus
// the XP earned toward the next
function renderTrack() {
  const p = state.pass;
  const top = TIERS[TIERS.length - 1].level;
  const frac = Math.min(1, (p.level - 1 + p.xp / p.xpPerLevel) / (top - 1));
  $('bp-fill').style.width = `${frac * 100}%`;
  const root = $('bp-nodes');
  root.replaceChildren();
  for (const t of TIERS) {
    const n = document.createElement('div');
    const done = p.level >= t.level;
    n.className = `bp-node${done ? ' done' : ''}${p.level === t.level ? ' current' : ''}${t.final ? ' final' : ''}`;
    const dot = document.createElement('span');
    dot.className = 'bp-dot';
    dot.textContent = t.level;
    const lab = document.createElement('span');
    lab.className = 'bp-lab';
    lab.textContent = t.label;
    n.append(dot, lab);
    root.appendChild(n);
  }
}

function renderLimitResults() {
  const ul = $('limit-result');
  ul.replaceChildren();
  for (const r of state.limitResults) {
    const li = document.createElement('li');
    if (r.unexpected) li.className = 'unexpected';
    const b = document.createElement('b');
    b.textContent = r.title;
    const t = document.createElement('span');
    t.textContent = r.text;
    li.append(b, t);
    if (r.link) {
      const a = document.createElement('a');
      a.href = r.link;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = ' View the refused transaction';
      li.appendChild(a);
    }
    ul.appendChild(li);
  }
}

function render() {
  const p = state.pass;
  const w = state.wallet;
  const busy = state.busy;

  // pass
  $('pass-id').textContent = `#${p.id}`;
  $('gate-sub').textContent = state.hasPass ? `PASS #${p.id} · NEAR TESTNET` : 'NEAR TESTNET';
  $('pass-level').textContent = p.level;
  $('pass-xp').textContent = `${p.xp} / ${p.xpPerLevel} XP`;
  renderTrack();

  // one-line summaries on the folded panels
  const sum = (id, text, todo = false) => { $(id).textContent = text; $(id).classList.toggle('todo', todo); };
  sum('sum-wallet', w ? near(p.balance) : MOCK ? 'NOT CONNECTED' : 'NO ACCOUNT', !w);
  sum('sum-link', state.agent ? state.agent.name : 'CHOOSE AGENT', !state.agent);
  sum('sum-policy', `${cap(state.policy.perTx)} / ${cap(state.policy.daily)}`);
  const last = state.log[0];
  sum('sum-log', last ? `${last.text}${last.amt ? `  ${last.amt > 0 ? '+' : ''}${last.amt.toFixed(2)}` : ''}` : '—');

  // wallet
  const wb = $('wallet-btn');
  wb.textContent = w
    ? shortAccount(w.account)
    : MOCK
      ? 'CONNECT NEAR WALLET'
      : busy === 'CREATING TEST ACCOUNT' ? 'CREATING ACCOUNT…' : 'PLAY WITH A TEST ACCOUNT';
  wb.classList.toggle('on', !!w);
  $('wallet-off').hidden = !!w;
  $('wallet-on').hidden = !w;
  $('start-choices').hidden = MOCK || !!w;
  $('guest-btn').disabled = $('connect-btn').disabled = !!busy;
  if (w) {
    $('w-account').textContent = shortAccount(w.account, 26);
    $('w-account').title = w.account;
    $('w-near').textContent = near(w.near);
    $('w-pass').textContent = near(p.balance);
    $('w-life').textContent = near(p.lifetime);
    $('w-cut').textContent = near(p.marketCut);
  }
  $('deposit-btn').disabled = $('withdraw-btn').disabled = !MOCK && (!state.hasPass || !!busy);
  $('keep-btn').hidden = MOCK || !(w?.kind === 'guest' && state.hasPass);
  $('disconnect-btn').hidden = MOCK || w?.kind !== 'wallet';
  $('keep-btn').disabled = $('disconnect-btn').disabled = !!busy;

  // physical card claim
  const eligible = p.level >= CLAIM.level;
  $('bp-reward-tier').textContent = state.claimed ? 'CLAIMED' : eligible ? 'UNLOCKED' : `LEVEL ${CLAIM.level} REWARD`;
  $('slab').classList.toggle('locked', !eligible);
  $('slab').classList.toggle('ready', eligible && !state.claimed);
  syncSlabPreview(slabPreview.classList.contains('show'));
  const cb = $('claim-btn');
  cb.disabled = !eligible || !w || state.claimed || !!busy;
  cb.textContent = state.claimed ? 'CLAIMED' : eligible ? (w ? `CLAIM · BURN ${cap(CLAIM.burn)} NEAR` : 'CONNECT WALLET') : 'LOCKED';

  // policy
  const tx = $('pol-tx');
  const day = $('pol-day');
  if (state.limits) {
    for (const [el, r] of [[tx, state.limits.tx], [day, state.limits.day]]) {
      el.min = r.min;
      el.max = r.max;
      el.step = r.step;
    }
  }
  tx.value = state.policy.perTx;
  day.value = state.policy.daily;
  $('pol-tx-v').textContent = near(state.policy.perTx);
  $('pol-day-v').textContent = near(state.policy.daily);
  tx.disabled = day.disabled = state.deployed || !!busy || (!MOCK && !state.hasPass);
  $('limit-test').hidden = MOCK || !state.hasPass || !state.agent;
  $('test-limit').disabled = !!busy;
  $('test-limit').textContent = busy === 'TESTING THE LIMITS' ? 'TESTING…' : 'TEST THE LIMITS';
  renderLimitResults();

  // centre
  const a = state.agent;
  $('agent-name').textContent = a ? a.name : 'NO AGENT LINKED';
  const st = $('agent-status');
  st.classList.toggle('live', state.deployed);
  st.textContent = !a
    ? ''
    : state.deployed
      ? 'IN THE FIELD · AGENT ISLAND · EARNINGS RETURN TO THE PASS'
      : a.rented
        ? `HOUSE AGENT · ${a.price.toFixed(2)} NEAR PER SEASON · STANDING BY`
        : 'YOUR AGENT · LINKED OVER MCP · STANDING BY';

  const db = $('deploy-btn');
  db.classList.toggle('busy', !!busy);
  if (MOCK) {
    db.textContent = state.deployed ? 'RECALL AGENT' : 'DEPLOY TO AGENT WORLD';
    db.disabled = !state.deployed && !(a && w);
  } else if (busy) {
    db.textContent = `${busy}…`;
    db.disabled = true;
  } else if (w && !state.hasPass) {
    db.textContent = 'MINT AGENT PASS';
    db.disabled = false;
  } else if (state.deployed) {
    db.textContent = 'OPEN AGENT WORLD';
    db.disabled = false;
  } else {
    db.textContent = 'DEPLOY TO AGENT WORLD';
    db.disabled = !(a && w && state.hasPass);
  }

  $('byo-link').disabled = state.deployed || !!busy;
  $('unlink-btn').hidden = MOCK || !a || state.deployed;
  $('unlink-btn').disabled = !!busy;
  renderRoster();
  redrawCard();
}

// ---------------------------------------------------------------------------
// actions of the scripted mode (the live ones are in live.js)
// ---------------------------------------------------------------------------
function linkAgent(def) {
  if (state.deployed) return;
  state.agent = def;
  stage.setAgent(def);
  document.querySelector('[data-fold="link"]').classList.remove('open');
  pushLog('LINK', def.rented ? `Rented ${def.name} from QuestFi` : `Linked ${def.name} over MCP`);
  render();
}

let connecting = false;
async function toggleWallet() {
  if (connecting) return;
  if (state.wallet) {
    if (state.deployed) return toast('RECALL THE AGENT BEFORE DISCONNECTING');
    state.wallet = null;
    pushLog('WALLET', 'Disconnected');
    return render();
  }
  connecting = true;
  $('wallet-btn').textContent = 'CONNECTING…';
  await wait(800);
  connecting = false;
  state.wallet = { ...WALLET };
  pushLog('WALLET', `Connected ${WALLET.account}`);
  render();
}

function applyField([src, text, amt, xp]) {
  const p = state.pass;
  p.balance += amt;
  p.lifetime += amt;
  if (src === 'MARKET') p.marketCut += amt;
  if (/^Entered/.test(text)) p.seasons += 1;
  if (/duel/.test(text)) p.kills += 1;
  if (/AETHERMAW/.test(text)) p.wins += 1;
  p.xp += xp;
  while (p.xp >= p.xpPerLevel) {
    p.xp -= p.xpPerLevel;
    p.level += 1;
    pushLog('PASS', `Pass reached level ${p.level}`);
    toast(`PASS LEVEL ${p.level}`);
  }
  pushLog(src, text, amt);
  render();
}

let fieldTimer = null;
let fieldIdx = 0;
function startField() {
  if (fieldTimer) return;
  fieldTimer = setInterval(() => {
    if (fieldIdx >= FIELD_EVENTS.length) return stopField();
    applyField(FIELD_EVENTS[fieldIdx++]);
  }, 2600);
}
function stopField() {
  clearInterval(fieldTimer);
  fieldTimer = null;
}

async function worldReachable() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    await fetch(WORLD_URL, { mode: 'no-cors', signal: ctl.signal });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

async function deploy() {
  setScreen('deploy');
  layoutCard();
  const ul = $('deploy-log');
  ul.replaceChildren();
  $('deploy-actions').hidden = true;
  $('deploy').hidden = false;

  const lines = DEPLOY_LOG(state);
  for (let i = 0; i < lines.length; i++) {
    const li = document.createElement('li');
    li.textContent = lines[i];
    ul.appendChild(li);
    if (i === lines.length - 2) stage.beamOut();
    await wait(620);
    li.classList.add('ok');
  }
  state.deployed = true;
  pushLog('DEPLOY', `${state.agent.name} deployed to Agent World`);
  render();

  const up = await worldReachable();
  $('enter-world').disabled = !up;
  $('world-note').textContent = up
    ? 'Uplink ready. Agent World opens in orbit over the city.'
    : 'Agent World is not running. Start it with “npm run dev” in apps/world (port 5175), or pass ?world=<url>.';
  $('deploy-actions').hidden = false;
}

function finishDeploy(enterWorld) {
  $('deploy').hidden = true;
  setScreen('manage');
  stage.beamIn();
  if (MOCK) startField();
  layoutCard();
  render();
  if (enterWorld) openWorld();
}

function recall() {
  stopField();
  state.deployed = false;
  pushLog('DEPLOY', `${state.agent.name} recalled · agent key revoked`);
  render();
}

function openWorld() {
  $('world-title').textContent = `AGENT WORLD · ${state.agent.name} · PASS #${state.pass.id}`;
  // hand the pass and account down so the world (and the island venue inside
  // it) know whose agent this is
  const url = new URL(WORLD_URL, location.href);
  url.searchParams.set('pass', state.pass.id);
  if (state.wallet) url.searchParams.set('account', state.wallet.account);
  if (state.season) url.searchParams.set('world', state.season);
  $('world-frame').src = url.href;
  $('world').hidden = false;
}
function closeWorld() {
  $('world-frame').src = 'about:blank';
  $('world').hidden = true;
}

// One dialog for confirmations, results and amounts. Resolves to true (or
// the typed text when it has an input) on OK, and to null on cancel.
let modalDone = null;
function modal({ title, body = '', code = null, link = null, input = null, ok = 'OK', cancel = 'CANCEL' }) {
  closeModal(null);
  $('modal-title').textContent = title;
  const box = $('modal-body');
  box.replaceChildren();
  if (code) {
    const c = document.createElement('div');
    c.className = 'code';
    c.textContent = code;
    box.appendChild(c);
  }
  const text = document.createElement('div');
  text.textContent = body;
  box.appendChild(text);
  if (link) {
    const a = document.createElement('a');
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'View the transaction';
    box.appendChild(a);
  }
  $('modal-field').hidden = !input;
  if (input) {
    $('modal-label').textContent = input.label;
    $('modal-input').value = input.value ?? '';
    setTimeout(() => $('modal-input').select(), 0);
  }
  $('modal-ok').hidden = !ok;
  if (ok) $('modal-ok').textContent = ok;
  $('modal-cancel').textContent = cancel;
  $('modal').hidden = false;
  return new Promise((resolve) => { modalDone = resolve; });
}
function closeModal(result) {
  $('modal').hidden = true;
  const done = modalDone;
  modalDone = null;
  done?.(result);
}

async function openClaim() {
  const yes = await modal({
    title: 'CLAIM PHYSICAL CARD',
    body: `This burns ${near(CLAIM.burn)} from pass #${state.pass.id} and issues a claim ticket for the printed card of this agent. Simulated: nothing is signed or sent.`,
    ok: `BURN ${near(CLAIM.burn)}`,
  });
  if (!yes || state.claimed) return;
  state.pass.balance -= CLAIM.burn;
  state.claimed = true;
  pushLog('CLAIM', 'Burned for physical card claim', -CLAIM.burn);
  render();
  modal({
    title: 'CLAIM TICKET ISSUED',
    code: `QF-TCG-${state.pass.id}-A`,
    body: 'The pass now records the claim. Shipping is handled off-chain against this ticket.',
    ok: null,
    cancel: 'CLOSE',
  });
}

// The deploy terminal as the live build drives it: one line per real step.
const term = {
  open() {
    setScreen('deploy');
    layoutCard();
    $('deploy-log').replaceChildren();
    $('deploy-actions').hidden = true;
    $('deploy').hidden = false;
    return term;
  },
  line(text) {
    const li = document.createElement('li');
    li.textContent = text;
    $('deploy-log').appendChild(li);
    return {
      ok(txHash = null) {
        li.classList.add('ok');
        if (txHash) li.appendChild(txLink(txHash));
      },
      fail() { li.classList.add('fail'); },
    };
  },
  note(text, link = null) {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = text;
    if (link) li.appendChild(txLink(link.split('/').pop()));
    $('deploy-log').appendChild(li);
  },
  async done(ok) {
    $('enter-world').hidden = !ok;
    $('stay-here').textContent = ok ? 'WATCH FROM HERE' : 'BACK';
    if (ok) {
      const up = await worldReachable();
      $('enter-world').disabled = !up;
      $('world-note').textContent = up
        ? 'Uplink ready. Agent World opens in orbit over the city.'
        : 'Agent World is not reachable from this page. The agent is playing all the same.';
    } else {
      $('world-note').textContent = 'The deploy stopped at the step marked failed.';
    }
    $('deploy-actions').hidden = false;
  },
};
function txLink(hash) {
  const a = document.createElement('a');
  a.href = explorerTx(hash);
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = `tx ${hash.slice(0, 8)}…`;
  return a;
}

function openFold(name) {
  const panel = document.querySelector(`[data-fold="${name}"]`);
  panel.parentElement.querySelectorAll('.fold.open').forEach((el) => el.classList.remove('open'));
  panel.classList.add('open');
  panel.querySelector('.fold-head').setAttribute('aria-expanded', 'true');
}
const closeFold = (name) => document.querySelector(`[data-fold="${name}"]`).classList.remove('open');

async function authenticate() {
  if (state.screen !== 'card') return;
  setScreen('auth');
  $('gate-hint').textContent = 'AUTHENTICATING…';
  auth.t = 0;
  auth.active = true; // the frame loop runs the 1.4 s spin and ends it
  // halfway round the card's back is to the viewer: reprint the front now so
  // it comes back around unlocked
  await wait(640);
  state.unlocked = true;
  redrawCard();
  // hand over while the card is still turning, so the spin carries it into
  // the corner and the panels arrive under it rather than after a pause
  await wait(260);
  setScreen('manage');
  render();
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
const live = MOCK ? null : createLive({ state, render, pushLog, toast, stage, modal, term, closeFold });

$('mcp-cmd').textContent = MCP_COMMAND;
$('wallet-btn').addEventListener('click', () => {
  if (MOCK) return toggleWallet();
  if (state.wallet) return openFold('wallet');
  return live.startGuest();
});
$('deploy-btn').addEventListener('click', () => {
  if (MOCK) return state.deployed ? recall() : deploy();
  if (!state.hasPass) return live.mint();
  return state.deployed ? openWorld() : live.deploy();
});
$('enter-world').addEventListener('click', () => finishDeploy(true));
$('stay-here').addEventListener('click', () => finishDeploy(false));
$('world-back').addEventListener('click', closeWorld);
$('claim-btn').addEventListener('click', () => (MOCK ? openClaim() : live.claim()));
$('modal-ok').addEventListener('click', () => closeModal($('modal-field').hidden ? true : $('modal-input').value));
$('modal-cancel').addEventListener('click', () => closeModal(null));
$('modal-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') closeModal($('modal-input').value); });
$('byo-link').addEventListener('click', () => {
  const name = ($('byo-name').value.trim() || BYO.name).toUpperCase();
  (MOCK ? linkAgent : live.linkAgent)({ ...BYO, name, rented: false });
});
if (live) {
  $('guest-btn').addEventListener('click', live.startGuest);
  $('connect-btn').addEventListener('click', live.connectWallet);
  $('disconnect-btn').addEventListener('click', live.disconnect);
  $('keep-btn').addEventListener('click', live.keep);
  $('unlink-btn').addEventListener('click', live.unlink);
  $('test-limit').addEventListener('click', live.testLimits);
  $('deposit-btn').addEventListener('click', live.deposit);
  $('withdraw-btn').addEventListener('click', live.withdraw);
  // a slider let go: store the caps on the pass
  $('pol-tx').addEventListener('change', live.commitPolicy);
  $('pol-day').addEventListener('change', live.commitPolicy);
}
const policySummary = () => { state.policyDirty = true; $('sum-policy').textContent = `${cap(state.policy.perTx)} / ${cap(state.policy.daily)}`; };
$('pol-tx').addEventListener('input', (e) => { state.policy.perTx = +e.target.value; $('pol-tx-v').textContent = near(state.policy.perTx); policySummary(); });
$('pol-day').addEventListener('input', (e) => { state.policy.daily = +e.target.value; $('pol-day-v').textContent = near(state.policy.daily); policySummary(); });
// folding panels: opening one closes the others in the same column
document.querySelectorAll('.fold-head').forEach((head) => head.addEventListener('click', () => {
  const panel = head.parentElement;
  const open = !panel.classList.contains('open');
  panel.parentElement.querySelectorAll('.fold.open').forEach((p) => p.classList.remove('open'));
  panel.classList.toggle('open', open);
  head.setAttribute('aria-expanded', open);
}));
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === tab));
  $('tab-rent').hidden = tab.dataset.tab !== 'rent';
  $('tab-byo').hidden = tab.dataset.tab !== 'byo';
}));
if (MOCK) document.querySelectorAll('[data-mock]').forEach((b) => b.addEventListener('click', () => toast(`${b.dataset.mock.toUpperCase()} · NOT WIRED YET`)));
// graded slab: leans toward the pointer, foil and glare follow it, click flips
const slabEl = $('slab');

// hovering the slab floats a large copy beside the column; it mirrors the
// small one's tilt, foil, flip and locked state. It lives on <body> because
// the column scrolls and would clip it.
const slabPreview = slabEl.cloneNode(true);
slabPreview.removeAttribute('id');
slabPreview.removeAttribute('title');
slabPreview.setAttribute('aria-hidden', 'true');
document.body.appendChild(slabPreview);
const bothSlabs = (prop, value) => {
  slabEl.style.setProperty(prop, value);
  slabPreview.style.setProperty(prop, value);
};
function syncSlabPreview(show) {
  slabPreview.className = `${slabEl.className} preview${show ? ' show' : ''}`;
}
function placeSlabPreview() {
  const r = slabEl.getBoundingClientRect();
  const s = Math.max(0.9, Math.min(1.7, (innerHeight - 120) / 280));
  const w = 160 * s;
  const h = 280 * s;
  const col = $('left').getBoundingClientRect();
  const narrow = innerWidth <= 1020;
  const left = narrow ? (innerWidth - w) / 2 : col.right + 28;
  const top = Math.min(innerHeight - h - 16, Math.max(80, r.top + r.height / 2 - h / 2));
  slabPreview.style.setProperty('--s', s.toFixed(3));
  slabPreview.style.left = `${left}px`;
  slabPreview.style.top = `${top}px`;
}
slabEl.addEventListener('pointerenter', () => {
  placeSlabPreview();
  syncSlabPreview(true);
});
slabEl.addEventListener('pointermove', (e) => {
  const r = slabEl.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  bothSlabs('--mx', `${(x * 100).toFixed(1)}%`);
  bothSlabs('--my', `${(y * 100).toFixed(1)}%`);
  bothSlabs('--rx', `${((0.5 - y) * 18).toFixed(2)}deg`);
  bothSlabs('--ry', `${((x - 0.5) * 22).toFixed(2)}deg`);
});
slabEl.addEventListener('pointerleave', () => {
  bothSlabs('--rx', '0deg');
  bothSlabs('--ry', '0deg');
  syncSlabPreview(false);
});
let slabFlipped = false;
slabEl.addEventListener('click', () => {
  slabFlipped = !slabFlipped;
  bothSlabs('--flip', slabFlipped ? '180deg' : '0deg');
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('modal').hidden) closeModal(null);
    else if (!$('world').hidden) closeWorld();
  }
  if ((e.key === 'Enter' || e.key === ' ') && state.screen === 'card') authenticate();
});

// pointer: tilt, hover, click-through to the 3D card
const pointer = { x: 0, y: 0, ndc: new THREE.Vector2(-2, -2) };
const raycaster = new THREE.Raycaster();
const overUI = (el) => !!el.closest?.('.panel, button, input, #topbar, .term, #modal, #world, #center');
function hitsCard() {
  raycaster.setFromCamera(pointer.ndc, camera);
  return raycaster.intersectObject(card.body, false).length > 0;
}
// drag anywhere on the open scene to spin the agent; the wheel zooms the stage
let lastDragAt = 0;
let stageZoom = 1;
window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || state.screen !== 'manage' || overUI(e.target)) return;
  pointer.ndc.set((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1));
  if (hitsCard()) return;
  stage.dragStart();
  lastDragAt = performance.now();
  document.body.style.cursor = 'grabbing';
  e.preventDefault(); // no text selection while dragging
});
const endDrag = () => {
  if (!stage.dragging) return;
  stage.dragEnd();
  document.body.style.cursor = '';
};
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', endDrag);
window.addEventListener('wheel', (e) => {
  if (state.screen !== 'manage' || overUI(e.target)) return;
  stageZoom = THREE.MathUtils.clamp(stageZoom * Math.exp(-e.deltaY * 0.0012), 0.7, 1.45);
}, { passive: true });

window.addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = (e.clientY / innerHeight) * 2 - 1;
  pointer.ndc.set(pointer.x, -pointer.y);
  if (stage.dragging) {
    const now = performance.now();
    stage.drag(e.movementX, e.movementY, (now - lastDragAt) / 1000);
    lastDragAt = now;
    return;
  }
  const free = !overUI(e.target);
  const hot = free && (state.screen === 'card' || state.screen === 'manage') && hitsCard();
  document.body.style.cursor = hot ? 'pointer' : free && state.screen === 'manage' ? 'grab' : '';
});
window.addEventListener('click', (e) => {
  if (overUI(e.target)) return;
  pointer.ndc.set((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1));
  if (!hitsCard()) return;
  if (state.screen === 'card') authenticate();
  else if (state.screen === 'manage') state.flipped = !state.flipped;
});

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  post.resize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------
// frame loop
// ---------------------------------------------------------------------------
const auth = { active: false, t: 0, spin: 0 };
const clock = new THREE.Clock();
let flip = 0;
let stageIn = 0; // 0 → 1 as the stage rises
let zoomNow = 1;
const tilt = new THREE.Vector2();

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  if (!$('world').hidden) return; // the world owns the screen; don't burn GPU underneath

  const narrow = innerWidth <= 1020;
  // on narrow screens the stage sits in the top of the page, so look lower
  CAM_LOOK.y += ((narrow ? -0.35 : 0.55) - CAM_LOOK.y) * Math.min(1, dt * 3);
  camera.position.set(CAM_POS.x + pointer.x * 0.12, CAM_POS.y - pointer.y * 0.06, CAM_POS.z);
  camera.lookAt(CAM_LOOK);
  camera.updateMatrixWorld();

  // card: glide to its slot, face the camera, tilt with the pointer
  const docked = state.screen === 'manage' || state.screen === 'deploy';
  dock = THREE.MathUtils.clamp(dock + (docked ? dt : -dt) / 0.95, 0, 1);
  layoutCard();
  card.group.position.copy(cardTarget.pos);
  card.group.scale.setScalar(cardTarget.scale);
  card.group.quaternion.copy(camera.quaternion);

  const amp = docked ? 0.35 : 1;
  tilt.x += (pointer.x * 0.5 * amp - tilt.x) * Math.min(1, dt * 6);
  tilt.y += (pointer.y * 0.32 * amp - tilt.y) * Math.min(1, dt * 6);
  if (auth.active) {
    auth.t = Math.min(1, auth.t + dt / 1.4);
    const e = auth.t < 0.5 ? 4 * auth.t ** 3 : 1 - (-2 * auth.t + 2) ** 3 / 2;
    auth.spin = e * Math.PI * 2;
    card.sheenMat.uniforms.scan.value = 1.1 - auth.t * 1.2;
    if (auth.t >= 1) {
      auth.active = false;
      auth.spin = 0; // a full turn, so this is the same pose
      card.sheenMat.uniforms.scan.value = -1;
    }
  }
  flip += ((state.flipped && docked ? Math.PI : 0) - flip) * Math.min(1, dt * 7);
  card.pivot.rotation.set(tilt.y + Math.sin(t * 0.9) * 0.03, tilt.x + Math.sin(t * 0.6) * 0.06 + auth.spin + flip, 0);
  card.pivot.position.y = Math.sin(t * 1.1) * (docked ? 0.015 : 0.05);
  card.sheenMat.uniforms.time.value = t;
  card.sheenMat.uniforms.tilt.value.copy(tilt);

  // stage grows in once the pass is open
  // It follows the card out of the centre: starts once the card is a third of
  // the way to its slot. It is never hidden, only scaled to a speck, so its
  // shaders compile during the card screen and not in the middle of the move.
  const rising = docked && dock > 0.32;
  stageIn = THREE.MathUtils.clamp(stageIn + (rising ? dt : -dt) / 0.9, 0, 1);
  zoomNow += (stageZoom - zoomNow) * Math.min(1, dt * 6);
  stage.group.scale.setScalar(Math.max(0.001, easeOut(stageIn) * zoomNow));
  stage.update(dt, t);

  motes.rotation.y = t * 0.012;
  post.render(t);
}

// canvas text needs the web fonts; draw once now and again when they land
render();
document.fonts?.ready.then(() => redrawCard(true));
frame();
if (live) {
  $('deploy-mode').textContent = 'NEAR TESTNET';
  live.boot();
}

// Model loading is kept away from the transition, because parsing blocks the
// main thread: the mannequin every agent shares loads now, behind the card
// screen.
stage.preload();

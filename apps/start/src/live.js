// The live build's actions. Each one replaces a scripted step of the mockup
// with real calls. main.js owns the screen; this module owns the account,
// the pass and the agent key, and reports back through the hooks in `ui`.
import { AGENT_METHODS, createChain, explainError, explorerTx, fromYocto, passFromView, toYocto } from './near.js';
import { createGame } from './game.js';
import { BYO, CHAIN, CLAIM, EMPTY_PASS, tintOf } from './config.js';

// Where the browser keeps keys. A test account's key has to outlive the tab,
// or the account is lost with it. A wallet user's agent key lasts only for
// the session.
const GUEST_SLOT = 'questfi.guest.testnet';
const MODE_SLOT = 'questfi.mode';
const agentSlot = (passId) => `questfi.agent.${CHAIN.contractId}.${passId}`;

const store = {
  get(area, key) {
    try {
      return JSON.parse(area.getItem(key));
    } catch {
      return null;
    }
  },
  set(area, key, value) {
    try {
      area.setItem(key, JSON.stringify(value));
    } catch {
      // storage is unavailable: the key lives for this page only
    }
  },
  del(area, key) {
    try {
      area.removeItem(key);
    } catch {
      // nothing to remove
    }
  },
};

const fmt = (n) => (Math.round(n * 1000) / 1000).toString();
const short = (text, max = 120) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
// The label each kind of activity row from the contract is shown under.
const SOURCES = {
  mint: 'PASS', card: 'PASS', transfer: 'PASS',
  deposit: 'WALLET', withdraw: 'WALLET',
  link: 'LINK', unlink: 'LINK', key: 'KEY', policy: 'POLICY',
  enter: 'ISLAND', kill: 'ISLAND', death: 'ISLAND', loot: 'ISLAND', win: 'ISLAND', refund: 'ISLAND',
  market_cut: 'MARKET', pay_sent: 'AGENT', pay_received: 'AGENT',
};

export function createLive(ui) {
  const { state } = ui;
  const chain = createChain(CHAIN);
  const game = createGame(CHAIN.gameUrl);
  let config = null; // the contract's Config, read once at start
  let policyOnChain = null;
  let connector = null;
  let pollTimer = null;
  let polling = false;
  const seen = new Set(); // activity rows already in the log
  // Kinds of activity this browser has just logged itself, with a link to the
  // transaction. The contract's own row for the same action is then left out.
  const logged = new Map();
  function logOwn(kind, src, text, link) {
    logged.set(kind, (logged.get(kind) ?? 0) + 1);
    ui.pushLog(src, text, 0, { link });
  }

  // ---- plumbing ---------------------------------------------------------
  // One action at a time: the label shows on the main button while it runs,
  // and a failure lands in the activity log instead of the console only.
  async function run(label, fn) {
    if (state.busy) return undefined;
    state.busy = label;
    ui.render();
    try {
      return await fn();
    } catch (err) {
      const e = explainError(err);
      console.error(`[${label}]`, err);
      ui.pushLog('ERROR', short(e.text), 0, { tone: 'bad', link: e.txHash ? explorerTx(e.txHash) : null });
      ui.toast(short(e.text, 64).toUpperCase());
      return undefined;
    } finally {
      state.busy = null;
      ui.render();
    }
  }

  const keyArea = () => (state.session?.kind === 'guest' ? localStorage : sessionStorage);
  const loadAgentKey = (passId) => store.get(localStorage, agentSlot(passId)) ?? store.get(sessionStorage, agentSlot(passId));
  const saveAgentKey = (passId, linked) => store.set(keyArea(), agentSlot(passId), { secretKey: linked.agentSecretKey, publicKey: linked.publicKey });
  const dropAgentKey = (passId) => {
    store.del(localStorage, agentSlot(passId));
    store.del(sessionStorage, agentSlot(passId));
  };

  function agentDef(link) {
    if (link.kind === 'rented') {
      const listed = state.roster.find((a) => a.key === link.rosterId);
      return { ...(listed ?? { key: link.rosterId, price: 0, tint: tintOf(link.rosterId) }), name: link.name, rented: true, publicKey: link.publicKey };
    }
    return { ...BYO, name: link.name, rented: false, publicKey: link.publicKey };
  }

  // ---- reading the chain ------------------------------------------------
  function applyPass(view) {
    const p = passFromView(view);
    const levelBefore = state.hasPass ? state.pass.level : null;
    const wasDeployed = state.deployed;
    state.pass = p;
    state.hasPass = true;
    policyOnChain = { perTx: p.policy.perTx, daily: p.policy.daily };
    if (!state.policyDirty) state.policy = { ...policyOnChain };
    state.claimed = !!p.claimTicket;
    state.deployed = !!p.activeSeason;
    if (p.activeSeason) state.season = p.activeSeason;

    const agent = p.agent ? agentDef(p.agent) : null;
    if (agent?.key !== state.agent?.key || agent?.name !== state.agent?.name) ui.stage.setAgent(agent);
    state.agent = agent;

    if (levelBefore !== null && p.level > levelBefore) ui.toast(`PASS LEVEL ${p.level}`);
    if (wasDeployed && !state.deployed) ui.toast('THE SEASON IS OVER');
    if (state.deployed) startPolling();
    else stopPolling();
  }

  // Activity arrives newest first. Rows not seen before go into the log
  // oldest first, so the newest ends up on top.
  function applyActivity(rows) {
    const fresh = [];
    for (const row of rows ?? []) {
      const id = `${row.timestamp_ms}|${row.kind}|${row.text}|${row.amount}|${row.negative}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (logged.get(row.kind)) {
        logged.set(row.kind, logged.get(row.kind) - 1);
        continue;
      }
      fresh.push(row);
    }
    for (const row of fresh.reverse()) {
      const amount = fromYocto(row.amount) * (row.negative ? -1 : 1);
      ui.pushLog(SOURCES[row.kind] ?? String(row.kind).toUpperCase().slice(0, 7), row.text, amount);
    }
  }

  async function refresh() {
    const s = state.session;
    if (!s) return;
    const [balance, ids] = await Promise.all([chain.balanceOf(s.accountId), chain.passIdsOf(s.accountId)]);
    state.wallet = { account: s.accountId, near: fromYocto(balance), kind: s.kind };
    if (!ids.length) {
      state.hasPass = false;
      state.pass = { ...EMPTY_PASS };
      state.agent = null;
      state.deployed = false;
      ui.stage.setAgent(null);
      stopPolling();
      return;
    }
    const passId = ids.includes(state.pass.id) ? state.pass.id : ids[0];
    const [view, activity] = await Promise.all([chain.getPass(passId), chain.getActivity(passId, 0, 40)]);
    applyPass(view);
    applyActivity(activity);
  }

  // While the agent is in a season, the pass and its activity are read every
  // three seconds, so kills and winnings show up as they settle.
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (polling || state.busy || !state.hasPass) return;
      polling = true;
      try {
        const [view, activity] = await Promise.all([chain.getPass(state.pass.id), chain.getActivity(state.pass.id, 0, 40)]);
        applyPass(view);
        applyActivity(activity);
        ui.render();
      } catch {
        // a missed poll is retried by the next one
      } finally {
        polling = false;
      }
    }, 3000);
  }
  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // ---- accounts ---------------------------------------------------------
  function useSession(session, mode) {
    state.session = session;
    state.pass = { ...EMPTY_PASS };
    state.hasPass = false;
    state.policyDirty = false;
    store.set(localStorage, MODE_SLOT, mode);
  }

  const startGuest = () =>
    run('CREATING TEST ACCOUNT', async () => {
      const saved = store.get(localStorage, GUEST_SLOT);
      if (saved?.accountId && saved?.secretKey && (await chain.accountExists(saved.accountId))) {
        useSession(chain.owner.guest(saved.accountId, saved.secretKey), 'guest');
      } else {
        const made = await chain.createGuest();
        store.set(localStorage, GUEST_SLOT, { accountId: made.accountId, secretKey: made.secretKey });
        useSession(chain.owner.guest(made.accountId, made.secretKey), 'guest');
        ui.pushLog('ACCOUNT', `Test account created with ${made.grant} NEAR`, 0, { link: explorerTx(made.txHash) });
      }
      await refresh();
    });

  async function walletAccount({ restore = false } = {}) {
    const { NearConnector } = await import('@hot-labs/near-connect');
    connector ??= new NearConnector({ network: 'testnet' });
    let wallet;
    let accounts;
    if (restore) {
      ({ wallet, accounts } = await connector.getConnectedWallet());
    } else {
      wallet = await connector.connect();
      accounts = await wallet.getAccounts();
    }
    const accountId = accounts?.[0]?.accountId;
    if (!accountId) throw new Error('The wallet did not return an account.');
    return { wallet, accountId };
  }

  const connectWallet = () =>
    run('CONNECTING WALLET', async () => {
      const { wallet, accountId } = await walletAccount();
      useSession(chain.owner.wallet(wallet, accountId), 'wallet');
      ui.pushLog('ACCOUNT', `Wallet connected: ${accountId}`);
      await refresh();
    });

  // Leaves the wallet. A test account made earlier in this browser comes back.
  const disconnect = () =>
    run('DISCONNECTING', async () => {
      if (state.session?.kind !== 'wallet') return;
      await connector?.disconnect().catch(() => {});
      stopPolling();
      state.session = null;
      state.wallet = null;
      state.agent = null;
      state.deployed = false;
      state.hasPass = false;
      state.pass = { ...EMPTY_PASS };
      ui.stage.setAgent(null);
      store.del(localStorage, MODE_SLOT);
      const saved = store.get(localStorage, GUEST_SLOT);
      if (saved?.accountId && saved?.secretKey) {
        useSession(chain.owner.guest(saved.accountId, saved.secretKey), 'guest');
        await refresh();
      }
    });

  // ---- the pass ---------------------------------------------------------
  // The mint carries a first deposit: one and a half per-call caps, or less
  // when the account could not also pay for an agent and gas afterwards.
  const mint = () =>
    run('MINTING PASS', async () => {
      const fee = BigInt(config.mint_storage_fee);
      const wanted = (BigInt(config.default_per_call_cap) * 3n) / 2n;
      const spare = (await chain.balanceOf(state.session.accountId)) - fee - toYocto('0.12');
      const first = spare < wanted ? (spare > 0n ? spare : 0n) : wanted;
      const done = await chain.mintPass(state.session, fee + first);
      logOwn('mint', 'PASS', `Minted pass #${done.passId} with ${fmt(fromYocto(first))} NEAR inside`, explorerTx(done.txHash));
      await refresh();
    });

  async function amountPrompt(title, body, suggested) {
    const typed = await ui.modal({ title, body, input: { label: 'AMOUNT · NEAR', value: fmt(suggested) }, ok: title.split(' ')[0] });
    if (typed === null) return null;
    const amount = Number(String(typed).replace(',', '.'));
    if (!(amount > 0)) {
      ui.toast('ENTER AN AMOUNT ABOVE ZERO');
      return null;
    }
    return amount;
  }

  async function deposit() {
    if (!state.hasPass || state.busy) return;
    const amount = await amountPrompt('DEPOSIT TO PASS', `Moves NEAR from ${state.wallet.account} into pass #${state.pass.id}. The agent spends from the pass, never from the account.`, 0.1);
    if (!amount) return;
    await run('DEPOSITING', async () => {
      await chain.deposit(state.session, state.pass.id, toYocto(amount));
      await refresh();
    });
  }

  async function withdraw() {
    if (!state.hasPass || state.busy) return;
    const amount = await amountPrompt('WITHDRAW FROM PASS', `Moves NEAR from pass #${state.pass.id} back to ${state.wallet.account}. Only the owner's key can do this.`, state.pass.balance);
    if (!amount) return;
    await run('WITHDRAWING', async () => {
      await chain.withdraw(state.session, state.pass.id, toYocto(amount));
      await refresh();
    });
  }

  async function claim() {
    if (!state.hasPass || state.busy) return;
    const yes = await ui.modal({
      title: 'CLAIM PHYSICAL CARD',
      body: `This burns ${fmt(CLAIM.burn)} NEAR from pass #${state.pass.id} and issues a claim ticket for the printed card of this agent.`,
      ok: `BURN ${fmt(CLAIM.burn)} NEAR`,
    });
    if (!yes) return;
    await run('CLAIMING', async () => {
      const done = await chain.claimCard(state.session, state.pass.id);
      await refresh();
      ui.modal({
        title: 'CLAIM TICKET ISSUED',
        code: String(done.value),
        body: 'The pass now records the claim. Shipping is handled off-chain against this ticket.',
        link: explorerTx(done.txHash),
        ok: null,
        cancel: 'CLOSE',
      });
    });
  }

  // Slider released: store the caps on the pass.
  function commitPolicy() {
    if (!state.hasPass || !policyOnChain) return undefined;
    const { perTx, daily } = state.policy;
    if (perTx === policyOnChain.perTx && daily === policyOnChain.daily) {
      state.policyDirty = false;
      return undefined;
    }
    return run('SAVING LIMITS', async () => {
      const done = await chain.setPolicy(state.session, state.pass.id, toYocto(perTx), toYocto(daily));
      state.policyDirty = false;
      logOwn('policy', 'POLICY', `Limits set: ${fmt(perTx)} NEAR per call, ${fmt(daily)} NEAR per day`, explorerTx(done.txHash));
      await refresh();
    });
  }

  // ---- the agent --------------------------------------------------------
  const linkAgent = (def) =>
    run('LINKING AGENT', async () => {
      if (!state.hasPass) {
        ui.toast('MINT A PASS FIRST');
        return;
      }
      if (state.deployed) return;
      const previous = state.agent;
      ui.stage.setAgent(def); // on stage while the transactions confirm
      try {
        const linked = await chain.linkAgent(state.session, {
          passId: state.pass.id,
          kind: def.rented ? 'rented' : 'byo',
          name: def.name,
          rosterId: def.rented ? def.key : null,
          priceYocto: def.rented ? def.priceYocto : 0n,
        });
        saveAgentKey(state.pass.id, linked);
        ui.pushLog('KEY', `Agent key issued for ${AGENT_METHODS.join(' and ')} only`, 0, { link: explorerTx(linked.keyTx) });
        if (previous?.publicKey && previous.publicKey !== linked.publicKey) {
          // the earlier agent's key no longer has a link to act for
          await chain.removeKey(state.session, previous.publicKey).catch(() => {});
        }
        ui.closeFold('link');
        await refresh();
      } catch (err) {
        ui.stage.setAgent(previous);
        throw err;
      }
    });

  const unlink = () =>
    run('UNLINKING AGENT', async () => {
      if (!state.agent || state.deployed) return;
      const done = await chain.unlinkAgent(state.session, state.pass.id, state.agent.publicKey);
      dropAgentKey(state.pass.id);
      ui.pushLog('KEY', 'Agent unlinked and its key removed', 0, { link: explorerTx(done.keyTx ?? done.unlinkTx) });
      await refresh();
    });

  // The key this browser holds for the linked agent, as long as it is still
  // on the account. Otherwise a fresh one is issued.
  async function agentKey() {
    const passId = state.pass.id;
    const held = loadAgentKey(passId);
    if (held && (await chain.accessKey(state.session.accountId, held.publicKey))) return { ...held, tx: null };
    const fresh = await chain.rotateAgentKey(state.session, passId, state.agent?.publicKey ?? null);
    saveAgentKey(passId, fresh);
    return { secretKey: fresh.agentSecretKey, publicKey: fresh.publicKey, tx: fresh.keyTx };
  }

  async function waitForSeason(seasonId, status, seconds = 40) {
    const until = Date.now() + seconds * 1000;
    for (;;) {
      const season = await chain.getSeason(seasonId).catch(() => null);
      if (season?.status === status) return season;
      if (Date.now() > until) throw new Error(`Season ${seasonId} did not open on chain in time.`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // The deploy terminal. Every line is a real step and gets its "ok" when
  // the step is done; a line with a transaction links to it.
  async function deploy() {
    if (state.busy || !state.hasPass || !state.agent || state.deployed) return;
    state.busy = 'DEPLOYING';
    ui.render();
    const term = ui.term.open();
    let step = null;
    let live = false;
    try {
      const passId = state.pass.id;

      step = term.line(`spending limits: ${fmt(state.policy.perTx)} NEAR per call, ${fmt(state.policy.daily)} NEAR per day`);
      if (state.policy.perTx !== policyOnChain.perTx || state.policy.daily !== policyOnChain.daily) {
        const set = await chain.setPolicy(state.session, passId, toYocto(state.policy.perTx), toYocto(state.policy.daily));
        state.policyDirty = false;
        step.ok(set.txHash);
      } else {
        step.ok();
      }

      step = term.line(`agent key: may call ${AGENT_METHODS.join(' and ')}, cannot withdraw`);
      const key = await agentKey();
      step.ok(key.tx);

      step = term.line('asking Agent Island for the open season');
      const open = await game.openSeason();
      const season = await waitForSeason(open.world_id, 'Open');
      step.ok();
      term.note(`season ${open.world_id}: entry stake ${fmt(fromYocto(season.entry_stake))} NEAR`);

      step = term.line('entering the season with the agent key, no wallet prompt');
      const entered = await chain.enterSeason(chain.agent(state.session.accountId, key.secretKey), passId, open.world_id);
      step.ok(entered.txHash);
      state.season = open.world_id;

      step = term.line(`seating ${state.agent.name} on Agent Island`);
      await game.join(open.world_id, {
        passId,
        name: state.agent.name,
        rosterId: state.agent.rented ? state.agent.key : null,
        accountId: state.session.accountId,
      });
      step.ok();

      ui.stage.beamOut();
      term.line(`${state.agent.name} is live`).ok();
      live = true;
      await refresh();
    } catch (err) {
      const e = explainError(err);
      console.error('[deploy]', err);
      step?.fail();
      term.note(short(e.text, 200), e.txHash ? explorerTx(e.txHash) : null);
      await refresh().catch(() => {});
    } finally {
      state.busy = null;
      ui.render();
      term.done(live);
    }
  }

  // ---- the limits, shown by breaking them -------------------------------
  // The agent key tries two things it must not be able to do. The first is
  // stopped by the contract (a spend over the owner's cap), the second by the
  // protocol (a withdrawal: the key is not allowed to send it at all).
  const testLimits = () =>
    run('TESTING THE LIMITS', async () => {
      if (!state.hasPass || !state.agent) return;
      const passId = state.pass.id;
      const key = await agentKey();
      const agent = chain.agent(state.session.accountId, key.secretKey);
      const results = [];

      const over = state.pass.policy.perTxYocto + toYocto('0.01');
      const other = passId === '1' ? '2' : '1';
      try {
        const paid = await chain.payAgent(agent, passId, other, over, 'limit test');
        results.push({ unexpected: true, title: 'NOT REFUSED', text: `A spend of ${fmt(fromYocto(over))} NEAR went through.`, link: explorerTx(paid.txHash) });
      } catch (err) {
        const e = explainError(err);
        results.push(e.kind === 'policy'
          ? {
            title: 'REFUSED BY THE CONTRACT',
            text: `The agent key tried to spend ${fmt(fromYocto(over))} NEAR, above the ${fmt(state.pass.policy.perTx)} NEAR per-call cap. The contract answered "${e.text}".`,
            link: e.txHash ? explorerTx(e.txHash) : null,
          }
          : { unexpected: true, title: 'FAILED ANOTHER WAY', text: short(e.text, 200) });
      }

      try {
        const out = await chain.withdrawAsAgent(agent, passId, toYocto('0.01'));
        results.push({ unexpected: true, title: 'NOT REFUSED', text: 'The agent key withdrew from the pass.', link: explorerTx(out.txHash) });
      } catch (err) {
        const e = explainError(err);
        results.push(e.kind === 'protocol'
          ? {
            title: 'REFUSED BY NEAR ITSELF',
            text: `The agent key tried to withdraw from the pass. The network rejected the transaction before it reached the contract: "${e.text}".`,
          }
          : { unexpected: true, title: 'FAILED ANOTHER WAY', text: short(e.text, 200) });
      }

      state.limitResults = results;
      for (const r of results) ui.pushLog(r.unexpected ? 'ERROR' : 'LIMIT', `${r.title}: ${r.text}`, 0, { tone: r.unexpected ? 'bad' : 'warn', link: r.link ?? null });
    });

  // ---- keeping the pass -------------------------------------------------
  // A test account's key lives in this browser. Moving the pass to a wallet
  // transfers the NFT, and with it the balance, the level and the record. The
  // contract clears the agent link on transfer, so the test account and the
  // agent key it issued can no longer act for the pass.
  async function keep() {
    if (state.session?.kind !== 'guest' || !state.hasPass || state.busy) return;
    if (state.deployed) {
      ui.toast('WAIT FOR THE SEASON TO END');
      return;
    }
    let target;
    try {
      target = await walletAccount();
    } catch (err) {
      ui.toast(short(explainError(err).text, 64).toUpperCase());
      return;
    }
    const passId = state.pass.id;
    const yes = await ui.modal({
      title: 'MOVE PASS TO YOUR WALLET',
      body: `Pass #${passId} moves to ${target.accountId} with its ${fmt(state.pass.balance)} NEAR, its level and its record. The agent link is cleared: this test account can no longer act for the pass.`,
      ok: 'MOVE PASS',
    });
    if (!yes) return;
    await run('MOVING PASS', async () => {
      const done = await chain.transferPass(state.session, passId, target.accountId);
      dropAgentKey(passId);
      useSession(chain.owner.wallet(target.wallet, target.accountId), 'wallet');
      logOwn('transfer', 'PASS', `Pass #${passId} moved to ${target.accountId}`, explorerTx(done.txHash));
      await refresh();
    });
  }

  // ---- start ------------------------------------------------------------
  async function boot() {
    try {
      config = await chain.getConfig();
      CLAIM.level = config.claim_level;
      CLAIM.burn = fromYocto(config.claim_burn);
      const cap = fromYocto(config.default_per_call_cap);
      const day = fromYocto(config.default_daily_limit);
      state.limits = { tx: { min: cap / 20, max: cap * 2.5, step: cap / 20 }, day: { min: day / 20, max: day * 2.5, step: day / 20 } };
      state.policy = { perTx: cap, daily: day };
      const roster = await chain.getRoster();
      state.roster = roster.map((r) => ({ key: r.roster_id, name: r.name, blurb: r.blurb, price: fromYocto(r.price), priceYocto: BigInt(r.price), tint: tintOf(r.roster_id) }));
    } catch (err) {
      console.error('[boot]', err);
      state.offline = true;
      ui.pushLog('ERROR', `The contract ${CHAIN.contractId} could not be read. Add ?mock to the address for the scripted demo.`, 0, { tone: 'bad' });
      ui.render();
      return;
    }
    try {
      const guest = store.get(localStorage, GUEST_SLOT);
      if (store.get(localStorage, MODE_SLOT) === 'wallet') {
        const { wallet, accountId } = await walletAccount({ restore: true });
        state.session = chain.owner.wallet(wallet, accountId);
      } else if (guest?.accountId && guest?.secretKey && (await chain.accountExists(guest.accountId))) {
        state.session = chain.owner.guest(guest.accountId, guest.secretKey);
      }
      await refresh();
    } catch (err) {
      console.error('[boot] session', err);
      state.session = null;
    }
    ui.render();
  }

  return { boot, startGuest, connectWallet, disconnect, mint, deposit, withdraw, claim, commitPolicy, linkAgent, unlink, deploy, testLimits, keep, refresh };
}

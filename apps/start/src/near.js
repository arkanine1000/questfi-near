// Every chain call the start app makes lives here, so main.js stays about the
// interface. Nothing in this module touches the DOM or the bundler, so the
// same code runs in the browser and in the terminal walkthrough
// (scripts/walkthrough.mjs).
//
// Two kinds of key sign for an account:
// - the owner's: a test account's own key held in the browser, or a wallet.
//   It can do everything, including `withdraw`.
// - the agent's: a function-call access key on the owner's account, limited
//   by the protocol to `enter_season` and `pay_agent` on the contract. It
//   cannot attach NEAR and cannot call anything else. What it spends comes
//   from the pass balance, under the caps the contract enforces.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, actions as build, getTransactionLastResult, nearToYocto, teraToGas } from 'near-api-js';

export const AGENT_METHODS = ['enter_season', 'pay_agent'];
// What the agent key may burn in gas, from the owner's account, over its life.
export const AGENT_GAS_ALLOWANCE = nearToYocto('0.1');
export const ONE_YOCTO = 1n;

// ---------------------------------------------------------------------------
// amounts: the contract speaks yoctoNEAR as decimal strings
// ---------------------------------------------------------------------------
export function toYocto(near) {
  // sliders and prompts hand over floats; four decimals is finer than any
  // amount the interface offers
  return nearToYocto(typeof near === 'number' ? near.toFixed(4) : String(near));
}
export function fromYocto(yocto) {
  const v = BigInt(yocto ?? 0);
  return Number(v / 10n ** 18n) / 1e6; // exact to a millionth of a NEAR
}

export const explorerTx = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;
export const explorerAccount = (id) => `https://testnet.nearblocks.io/address/${id}`;

// ---------------------------------------------------------------------------
// errors: tell a refusal by the contract from a refusal by the protocol
// ---------------------------------------------------------------------------
// - 'policy':   the contract refused a spend over the owner's caps
// - 'protocol': the access key itself is not allowed to send this
//               transaction, so it never reached the contract
// - 'contract': any other panic in the contract
// - 'funds':    the signing account cannot pay for the transaction
// - 'other':    network trouble and the rest
// What the RPC says when an access key is not allowed to send a transaction.
// Matched on the message: the library names its errors after their classes,
// and a minified build renames those.
const PROTOCOL_REFUSALS = [
  [/Deposit is not allowed with function call/i, 'DepositWithFunctionCall'],
  [/Access key does not allow method/i, 'MethodNameMismatch'],
  [/does not match transaction receiver/i, 'ReceiverMismatch'],
  [/Access key requires full access/i, 'RequiresFullAccess'],
  [/Not enough allowance for access key/i, 'NotEnoughAllowance'],
];

export function explainError(err) {
  const name = String(err?.name ?? '');
  const message = String(err?.message ?? err);
  // A transaction the contract refused still ran, so it has a hash to link.
  // One the protocol refused was never included in a block.
  const txHash = err?.transactionResult?.transaction?.hash ?? null;
  const policy = /POLICY: [^"\\,}]+/.exec(message);
  if (policy) return { kind: 'policy', text: policy[0].trim(), name, txHash };
  const refusal = PROTOCOL_REFUSALS.find(([pattern]) => pattern.test(message));
  if (refusal) return { kind: 'protocol', text: message, name: refusal[1], txHash: null };
  if (/enough balance|LackBalanceForState/i.test(message)) {
    return { kind: 'funds', text: 'The account does not hold enough NEAR for this and its gas. Withdraw some from the pass, then try again.', name, txHash: null };
  }
  const panic = /Smart contract panicked: ([^"\\]+)/.exec(message);
  if (panic) return { kind: 'contract', text: panic[1].trim(), name, txHash };
  return { kind: 'other', text: message, name, txHash };
}

// ---------------------------------------------------------------------------
// steps: one description of an action, turned into whatever the signer wants
// ---------------------------------------------------------------------------
// The gas limit is kept low on purpose. An account must be able to prepay the
// whole limit, at a price padded for the worst case, before the call runs:
// about 0.001 NEAR per Tgas, most of it refunded afterwards. These calls burn
// well under 10 Tgas.
const call = (method, args = {}, { deposit = 0n, gas = 20 } = {}) => ({ type: 'FunctionCall', method, args, deposit: BigInt(deposit), gas: teraToGas(gas) });
const addAgentKey = (publicKey, contractId) => ({ type: 'AddKey', publicKey, contractId });
const deleteKey = (publicKey) => ({ type: 'DeleteKey', publicKey });

function toNearAction(step) {
  if (step.type === 'FunctionCall') return build.functionCall(step.method, step.args, step.gas, step.deposit);
  if (step.type === 'AddKey') return build.addFunctionCallAccessKey(PublicKey.from(step.publicKey), step.contractId, AGENT_METHODS, AGENT_GAS_ALLOWANCE);
  if (step.type === 'DeleteKey') return build.deleteKey(PublicKey.from(step.publicKey));
  throw new Error(`unknown step ${step.type}`);
}

function toWalletAction(step) {
  if (step.type === 'FunctionCall') {
    return { type: 'FunctionCall', params: { methodName: step.method, args: step.args, gas: String(step.gas), deposit: String(step.deposit) } };
  }
  if (step.type === 'AddKey') {
    return {
      type: 'AddKey',
      params: {
        publicKey: step.publicKey,
        accessKey: { permission: { receiverId: step.contractId, methodNames: AGENT_METHODS, allowance: String(AGENT_GAS_ALLOWANCE) } },
      },
    };
  }
  if (step.type === 'DeleteKey') return { type: 'DeleteKey', params: { publicKey: step.publicKey } };
  throw new Error(`unknown step ${step.type}`);
}

// What a finished transaction comes back as: its hash, the value the contract
// returned, and the contract's NEP-297 events.
function outcome(result) {
  const logs = (result?.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? []);
  const events = [];
  for (const line of logs) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    try {
      events.push(JSON.parse(line.slice('EVENT_JSON:'.length)));
    } catch {
      // not ours to parse
    }
  }
  let value = null;
  try {
    value = getTransactionLastResult(result);
  } catch {
    // no JSON value
  }
  return { txHash: result?.transaction?.hash ?? result?.transaction_outcome?.id ?? null, value, logs, events };
}

// ---------------------------------------------------------------------------
// the chain
// ---------------------------------------------------------------------------
export function createChain({ contractId, rpcUrl = 'https://test.rpc.fastnear.com', guestApi = '/api/guest', fetchImpl = globalThis.fetch }) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const view = (method, args = {}) => provider.callFunction({ contractId, method, args });

  // A session is one account and one way of signing for it.
  function keySession(accountId, secretKey, kind) {
    const keyPair = KeyPair.fromString(secretKey);
    const account = new Account(accountId, provider, new KeyPairSigner(keyPair));
    return {
      kind,
      accountId,
      publicKey: keyPair.getPublicKey().toString(),
      async send(receiverId, steps) {
        return outcome(await account.signAndSendTransaction({ receiverId, actions: steps.map(toNearAction), waitUntil: 'FINAL' }));
      },
    };
  }

  const owner = {
    // An account created for the visitor, its key held by the browser.
    guest: (accountId, secretKey) => keySession(accountId, secretKey, 'guest'),
    // A connected wallet (a near-connect wallet object) signs each step.
    wallet: (wallet, accountId) => ({
      kind: 'wallet',
      accountId,
      async send(receiverId, steps) {
        return outcome(await wallet.signAndSendTransaction({ signerId: accountId, receiverId, actions: steps.map(toWalletAction) }));
      },
    }),
  };

  return {
    contractId,
    provider,
    owner,
    // The agent's hands: the owner's account, signed with the limited key.
    agent: (ownerAccountId, agentSecretKey) => keySession(ownerAccountId, agentSecretKey, 'agent'),

    // ---- test accounts ---------------------------------------------------
    // Makes a key pair here, asks the server for an account that carries it,
    // and returns both. The secret key is the caller's to store.
    async createGuest() {
      const keyPair = KeyPair.fromRandom('ed25519');
      const request = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: keyPair.getPublicKey().toString() }),
      };
      // A request that never left (a DNS or connection failure) is tried
      // again. An answer from the server, good or bad, is final: it may have
      // made the account.
      let res;
      for (let attempt = 1; ; attempt += 1) {
        try {
          res = await fetchImpl(guestApi, request);
          break;
        } catch (err) {
          if (attempt === 3) throw new Error('The test account service could not be reached. Check the connection and try again.');
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(body.message || `Test account request failed (${res.status})`), { code: body.error });
      return { accountId: body.accountId, secretKey: keyPair.toString(), txHash: body.txHash, grant: body.grant };
    },

    // ---- views -----------------------------------------------------------
    view,
    getConfig: () => view('get_config'),
    getPass: (passId) => view('get_pass', { pass_id: String(passId) }),
    getActivity: (passId, fromIndex = 0, limit = 40) => view('get_activity', { pass_id: String(passId), from_index: fromIndex, limit }),
    getRoster: () => view('get_roster'),
    getSeason: (seasonId) => view('get_season', { season_id: seasonId }),
    getMarket: (seasonId) => view('get_market', { season_id: seasonId }),
    getAccounting: () => view('get_accounting'),
    async passIdsOf(accountId) {
      const tokens = await view('nft_tokens_for_owner', { account_id: accountId, from_index: '0', limit: 20 });
      return (tokens ?? []).map((t) => t.token_id);
    },
    async accountExists(accountId) {
      try {
        await provider.viewAccount({ accountId });
        return true;
      } catch (err) {
        if (/does not exist|doesn't exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(`${err?.name} ${err?.message}`)) return false;
        throw err;
      }
    },
    // Spendable NEAR on an account, in yocto.
    async balanceOf(accountId) {
      const account = await provider.viewAccount({ accountId });
      return BigInt(account.amount);
    },
    // Whether a public key is on an account, and with which permission.
    async accessKey(accountId, publicKey) {
      try {
        return await provider.viewAccessKey({ accountId, publicKey });
      } catch {
        return null;
      }
    },

    // ---- the owner's actions --------------------------------------------
    // Anything attached above the mint fee lands in the new pass's balance.
    async mintPass(session, depositYocto) {
      const done = await session.send(contractId, [call('mint_pass', {}, { deposit: depositYocto, gas: 30 })]);
      return { ...done, passId: String(done.value) };
    },
    deposit: (session, passId, yocto) => session.send(contractId, [call('deposit', { pass_id: String(passId) }, { deposit: yocto })]),
    withdraw: (session, passId, yocto) =>
      session.send(contractId, [call('withdraw', { pass_id: String(passId), amount: String(yocto) }, { deposit: ONE_YOCTO })]),
    setPolicy: (session, passId, perCallYocto, dailyYocto) =>
      session.send(contractId, [
        call('set_policy', { pass_id: String(passId), per_call_cap: String(perCallYocto), daily_limit: String(dailyYocto) }, { deposit: ONE_YOCTO }),
      ]),
    claimCard: (session, passId) => session.send(contractId, [call('claim_card', { pass_id: String(passId) }, { deposit: ONE_YOCTO })]),
    // Moves the pass, with its balance and record, to another account.
    transferPass: (session, passId, receiverId) =>
      session.send(contractId, [call('nft_transfer', { receiver_id: receiverId, token_id: String(passId) }, { deposit: ONE_YOCTO })]),

    // Links an agent to the pass and gives it its key. Two transactions:
    // the owner's account gains a function-call key for the agent methods,
    // then the contract records the link (and takes the rental for a house
    // agent). Returns the agent's secret key for the caller to hold.
    async linkAgent(session, { passId, kind, name, rosterId = null, priceYocto = 0n }, onStep = () => {}) {
      const keyPair = KeyPair.fromRandom('ed25519');
      const publicKey = keyPair.getPublicKey().toString();
      const added = await session.send(session.accountId, [addAgentKey(publicKey, contractId)]);
      onStep('key', added);
      try {
        const linked = await session.send(contractId, [
          call(
            'link_agent',
            { pass_id: String(passId), kind, name, roster_id: rosterId, public_key: publicKey },
            { deposit: kind === 'rented' ? BigInt(priceYocto) || ONE_YOCTO : ONE_YOCTO },
          ),
        ]);
        onStep('link', linked);
        return { agentSecretKey: keyPair.toString(), publicKey, keyTx: added.txHash, linkTx: linked.txHash };
      } catch (err) {
        // the link was refused: do not leave the unused key on the account
        await session.send(session.accountId, [deleteKey(publicKey)]).catch(() => {});
        throw err;
      }
    },
    // Gives a linked agent a fresh key, when this browser no longer holds the
    // old one. The link, and any rental already paid, stay as they are.
    async rotateAgentKey(session, passId, oldPublicKey = null) {
      const keyPair = KeyPair.fromRandom('ed25519');
      const publicKey = keyPair.getPublicKey().toString();
      const added = await session.send(session.accountId, [addAgentKey(publicKey, contractId)]);
      const set = await session.send(contractId, [call('set_agent_key', { pass_id: String(passId), public_key: publicKey }, { deposit: ONE_YOCTO })]);
      if (oldPublicKey) await session.send(session.accountId, [deleteKey(oldPublicKey)]).catch(() => {});
      return { agentSecretKey: keyPair.toString(), publicKey, keyTx: added.txHash, linkTx: set.txHash };
    },
    // Takes a function-call key off the owner's account.
    removeKey: (session, publicKey) => session.send(session.accountId, [deleteKey(publicKey)]),
    // Clears the link and removes the agent's key from the owner's account.
    async unlinkAgent(session, passId, agentPublicKey) {
      const unlinked = await session.send(contractId, [call('unlink_agent', { pass_id: String(passId) }, { deposit: ONE_YOCTO })]);
      let keyTx = null;
      if (agentPublicKey) {
        keyTx = (await session.send(session.accountId, [deleteKey(agentPublicKey)]).catch(() => null))?.txHash ?? null;
      }
      return { unlinkTx: unlinked.txHash, keyTx };
    },

    // ---- the agent's actions (signed with the limited key, no prompt) ----
    enterSeason: (agentSession, passId, seasonId) =>
      agentSession.send(contractId, [call('enter_season', { pass_id: String(passId), season_id: seasonId })]),
    payAgent: (agentSession, fromPass, toPass, yocto, memo = '') =>
      agentSession.send(contractId, [call('pay_agent', { from_pass: String(fromPass), to_pass: String(toPass), amount: String(yocto), memo })]),
    // The agent key trying what only the owner may do. `withdraw` needs one
    // yocto attached, and a function-call key cannot attach anything, so the
    // protocol turns the transaction away before the contract sees it.
    withdrawAsAgent: (agentSession, passId, yocto) =>
      agentSession.send(contractId, [call('withdraw', { pass_id: String(passId), amount: String(yocto) }, { deposit: ONE_YOCTO })]),
  };
}

// ---------------------------------------------------------------------------
// the contract's PassView, as the interface wants it
// ---------------------------------------------------------------------------
export function passFromView(view) {
  if (!view) return null;
  const totalIn = fromYocto(view.total_in);
  const totalOut = fromYocto(view.total_out);
  return {
    id: view.token_id,
    owner: view.owner_id,
    level: view.level,
    xp: view.xp % view.xp_per_level, // progress inside the current level
    xpTotal: view.xp,
    xpPerLevel: view.xp_per_level,
    seasons: view.seasons,
    wins: view.wins,
    kills: view.kills,
    balance: fromYocto(view.balance),
    balanceYocto: BigInt(view.balance),
    lifetime: totalIn - totalOut,
    marketCut: fromYocto(view.market_cut),
    agent: view.agent
      ? { kind: view.agent.kind, name: view.agent.name, rosterId: view.agent.roster_id, publicKey: view.agent.public_key }
      : null,
    policy: {
      perTx: fromYocto(view.policy.per_call_cap),
      perTxYocto: BigInt(view.policy.per_call_cap),
      daily: fromYocto(view.policy.daily_limit),
      spentToday: fromYocto(view.policy.spent_today),
    },
    activeSeason: view.active_season,
    claimTicket: view.claim_ticket,
  };
}

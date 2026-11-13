// The island's chain calls: read the spectator market, and bet or claim from
// the visitor's test account. A trimmed copy of the start app's near.js (the
// two apps share code by copying it, not through a package), holding only
// what a spectator needs.
//
// The test account signs with its own full-access key, held in this browser.
// Nothing here touches the DOM, so the module also runs under plain Node.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions as build, getTransactionLastResult, nearToYocto, teraToGas } from 'near-api-js';
import { formatNear, fromYocto } from './marketMath.js';

export { fromYocto, formatNear };
export { explorerAccount, explorerTx, shortAccount, shortHash } from './explorer.js';

// Each byte an account stores locks this much of its balance (protocol
// constant on testnet and mainnet).
const STORAGE_BYTE_COST = 10n ** 19n;

// ---------------------------------------------------------------------------
// amounts: the contract speaks yoctoNEAR as decimal strings
// ---------------------------------------------------------------------------
export function toYocto(near) {
  return nearToYocto(typeof near === 'number' ? near.toFixed(6) : String(near));
}

// ---------------------------------------------------------------------------
// errors: what went wrong, in words a spectator can act on
// ---------------------------------------------------------------------------
// kind:
// - 'contract': the contract refused the call (the transaction ran and has a hash)
// - 'balance':  the account cannot pay for the bet plus gas
// - 'account':  the account or its key is not usable
// - 'network':  the RPC or the account service could not be reached
// - 'other':    anything else
const PANIC_WORDS = [
  [/market is closed/i, () => 'Betting on this season is closed.'],
  [/min_bet of (\d+)/i, (m) => `That bet is below the contract's minimum of ${formatNear(m[1])} NEAR.`],
  [/not an entrant/i, () => 'That agent is not entered in this season on chain.'],
  [/season not found/i, () => 'This season is not on chain.'],
  [/not settled or cancelled yet/i, () => 'The season has not been settled on chain yet.'],
  [/nothing to claim/i, () => 'Nothing left to claim: this account has no open bets on the season.'],
];

const NETWORK = /failed to fetch|networkerror|network error|load failed|fetch failed|timeout|timed out|unavailable|bad gateway|internal server error|exceeded \d+ attempts|retries|ECONN|ENOTFOUND|too many requests|rate limit/i;

export function explainError(err) {
  const name = String(err?.name ?? err?.constructor?.name ?? '');
  const message = String(err?.message ?? err ?? '');
  // A transaction the contract refused still ran, so it has a hash to link.
  const txHash = err?.transactionResult?.transaction?.hash ?? null;

  const panic = /Smart contract panicked: ([^"\\]+)/.exec(message);
  if (panic) {
    const raw = panic[1].trim();
    for (const [re, words] of PANIC_WORDS) {
      const m = re.exec(raw);
      if (m) return { kind: 'contract', text: words(m), raw, txHash };
    }
    return { kind: 'contract', text: `The contract refused: ${raw}`, raw, txHash };
  }
  if (/NotEnoughBalance/.test(name) || /not enough balance/i.test(message)) {
    return { kind: 'balance', text: 'The account does not hold enough NEAR for this, gas included.', raw: message, txHash };
  }
  // Matched on the message as well as the class name: a minified build
  // renames classes.
  if (/AccessKeyDoesNotExist|InvalidSignature|InvalidAccessKey/.test(name) || /access key .* does not exist|invalid transaction signature/i.test(message)) {
    return { kind: 'account', text: "This browser's key no longer signs for the test account.", raw: message, txHash };
  }
  if (/AccountDoesNotExist|SignerDoesNotExist/.test(name) || /(account|signer) .* does not exist/i.test(message)) {
    return { kind: 'account', text: 'This test account does not exist on testnet.', raw: message, txHash };
  }
  if (err?.code === 'service' || NETWORK.test(message) || NETWORK.test(name)) {
    return { kind: 'network', text: err?.code === 'service' ? message : 'Could not reach the NEAR network. Check the connection and try again.', raw: message, txHash };
  }
  return { kind: 'other', text: message || 'Something went wrong.', raw: message, txHash };
}

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------
// An account has to hold the price of all the gas a call attaches before the
// call is sent (about 0.001 NEAR per Tgas, most of it returned afterwards).
// So calls attach what they need with room to spare, not the most the
// network allows: a bet uses under 3 Tgas and a claim under 4.
const call = (method, args = {}, { deposit = 0n, gas = 20 } = {}) => build.functionCall(method, args, teraToGas(gas), BigInt(deposit));

// What a finished transaction comes back as: its hash and the value the
// contract returned.
function outcome(result) {
  let value = null;
  try {
    value = getTransactionLastResult(result);
  } catch {
    // no JSON value
  }
  return { txHash: result?.transaction?.hash ?? result?.transaction_outcome?.id ?? null, value };
}

// ---------------------------------------------------------------------------
// the chain
// ---------------------------------------------------------------------------
export function createChain({ contractId, rpcUrl = 'https://test.rpc.fastnear.com', guestApi = '/api/guest', fetchImpl = globalThis.fetch }) {
  // A handful of quick retries, not near-api-js's default dozen: a spectator
  // should hear about a dead connection in seconds, not minutes.
  const provider = new JsonRpcProvider({ url: rpcUrl }, { retries: 4, wait: 400, backoff: 1.6 });
  const view = (method, args = {}) => provider.callFunction({ contractId, method, args });

  return {
    contractId,
    provider,
    explainError,

    // An account created for the visitor, its key held by the browser.
    guest(accountId, secretKey) {
      const keyPair = KeyPair.fromString(secretKey);
      const account = new Account(accountId, provider, new KeyPairSigner(keyPair));
      return {
        kind: 'guest',
        accountId,
        publicKey: keyPair.getPublicKey().toString(),
        async send(receiverId, actions) {
          return outcome(await account.signAndSendTransaction({ receiverId, actions, waitUntil: 'EXECUTED_OPTIMISTIC' }));
        },
      };
    },

    // Makes a key pair here, asks the account service for an account that
    // carries it, and returns both. The secret key is the caller's to store.
    async createGuest() {
      const keyPair = KeyPair.fromRandom('ed25519');
      let res;
      try {
        res = await fetchImpl(guestApi, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicKey: keyPair.getPublicKey().toString() }),
        });
      } catch {
        throw Object.assign(new Error('Could not reach the test account service.'), { code: 'service' });
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.accountId) {
        const fallback = res.status === 404 || res.status === 502 || res.status === 504
          ? 'Test accounts are not available on this server.'
          : `The test account service answered ${res.status}.`;
        throw Object.assign(new Error(body?.message || fallback), { code: 'service', reason: body?.error ?? null, status: res.status });
      }
      return { accountId: body.accountId, secretKey: keyPair.toString(), txHash: body.txHash ?? null, grant: body.grant ?? null };
    },

    // ---- views -----------------------------------------------------------
    view,
    getConfig: () => view('get_config'),
    getSeason: (seasonId) => view('get_season', { season_id: seasonId }),
    getMarket: (seasonId) => view('get_market', { season_id: seasonId }),
    getBets: (seasonId, accountId) => view('get_bets', { season_id: seasonId, account_id: accountId }),
    // An agent pass's record (level, seasons, wins, kills, balance), or null.
    getPass: (passId) => view('get_pass', { pass_id: String(passId) }),
    async accountExists(accountId) {
      try {
        await provider.viewAccount({ accountId });
        return true;
      } catch (err) {
        if (/does not exist|doesn't exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(`${err?.name} ${err?.message}`)) return false;
        throw err;
      }
    },
    // What the account can spend, in yocto: its balance less what its
    // storage locks.
    async balanceOf(accountId) {
      const a = await provider.viewAccount({ accountId });
      const locked = BigInt(a.locked ?? 0);
      const storage = BigInt(a.storage_usage ?? 0) * STORAGE_BYTE_COST;
      const total = BigInt(a.amount) + locked;
      const free = total - (locked > storage ? locked : storage);
      return free > 0n ? free : 0n;
    },

    // ---- the spectator's actions ----------------------------------------
    placeBet: (session, seasonId, passId, yocto) =>
      session.send(contractId, [call('place_bet', { season_id: seasonId, pass_id: String(passId) }, { deposit: yocto })]),
    async claimWinnings(session, seasonId) {
      const done = await session.send(contractId, [call('claim_winnings', { season_id: seasonId })]);
      return { ...done, paid: BigInt(done.value ?? 0) };
    },
  };
}

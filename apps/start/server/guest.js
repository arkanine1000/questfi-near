// Test accounts: a visitor with no wallet gets a NEAR testnet account of
// their own. The browser makes a key pair and sends the public key here; the
// parent account creates `g-<random>.<parent>` holding a small grant, with
// that key as its only key. The private key never leaves the browser.
//
// Server only: this module holds the parent account's key. It runs as a
// Vercel function (api/guest.js) and inside the Vite dev server
// (vite.config.js).
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, actions, nearToYocto } from 'near-api-js';

const DEFAULT_RPC = 'https://test.rpc.fastnear.com';
const SUFFIX_CHARS = 8;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

// Reads the settings from an env object. Returns null when test accounts are
// not configured, so the caller can answer "not available" instead of failing.
export function guestConfig(env) {
  const parentId = env.QUESTFI_GUEST_PARENT_ID;
  const parentKey = env.QUESTFI_GUEST_PARENT_KEY;
  if (!parentId || !parentKey) return null;
  return {
    parentId,
    parentKey,
    rpcUrl: env.QUESTFI_RPC_URL || env.VITE_RPC_URL || DEFAULT_RPC,
    // NEAR each new account starts with.
    grant: env.QUESTFI_GUEST_GRANT || '0.5',
    // No new account while the parent holds less than this many NEAR.
    floor: env.QUESTFI_GUEST_FLOOR || '1',
    perIpPerHour: Number(env.QUESTFI_GUEST_PER_IP_HOUR || 5),
    perDay: Number(env.QUESTFI_GUEST_PER_DAY || 60),
  };
}

export function randomGuestId(parentId, random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  // 252 is the largest multiple of 36 under 256, so the modulo stays uniform.
  let out = '';
  while (out.length < SUFFIX_CHARS) {
    for (const b of random(SUFFIX_CHARS * 2)) {
      if (b < 252 && out.length < SUFFIX_CHARS) out += ALPHABET[b % 36];
    }
  }
  return `g-${out}.${parentId}`;
}

export function isGuestId(accountId, parentId) {
  return typeof accountId === 'string'
    && accountId.endsWith(`.${parentId}`)
    && new RegExp(`^g-[0-9a-z]{${SUFFIX_CHARS}}$`).test(accountId.slice(0, -parentId.length - 1));
}

// An ed25519 public key in NEAR's text form, or null.
export function parsePublicKey(text) {
  if (typeof text !== 'string' || !text.startsWith('ed25519:') || text.length > 80) return null;
  try {
    const key = PublicKey.from(text);
    return key.toString() === text ? key : null;
  } catch {
    return null;
  }
}

class GuestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Rolling-window counters kept in memory. On a serverless host each instance
// has its own, so they slow a script down rather than stop it. The hard limit
// on what test accounts can cost is the parent account's own balance, which
// holds nothing else.
function createLimiter({ perIpPerHour, perDay }, now = () => Date.now()) {
  const byIp = new Map();
  let day = [];
  const prune = (list, windowMs) => list.filter((t) => now() - t < windowMs);
  return {
    check(ip) {
      day = prune(day, 86_400_000);
      if (day.length >= perDay) throw new GuestError(429, 'daily_cap', 'No more test accounts today. Try again tomorrow, or connect a wallet.');
      const mine = prune(byIp.get(ip) ?? [], 3_600_000);
      byIp.set(ip, mine);
      if (mine.length >= perIpPerHour) throw new GuestError(429, 'ip_cap', 'Too many test accounts from this address. Try again in an hour.');
    },
    record(ip) {
      day.push(now());
      if (byIp.size > 5000) byIp.clear();
      byIp.set(ip, [...(byIp.get(ip) ?? []), now()]);
    },
  };
}

export function createGuestService(config) {
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const parent = new Account(config.parentId, provider, new KeyPairSigner(KeyPair.fromString(config.parentKey)));
  const grant = nearToYocto(config.grant);
  const floor = nearToYocto(config.floor);
  const limiter = createLimiter(config);

  return {
    parentId: config.parentId,
    grant: config.grant,

    // Creates the account and returns its id once the creation is final, so
    // the browser's first transaction finds its key in place.
    async create({ publicKey, ip = 'unknown' }) {
      const key = parsePublicKey(publicKey);
      if (!key) throw new GuestError(400, 'bad_key', 'publicKey must be an ed25519 public key.');
      limiter.check(ip);

      const { balance } = await parent.getState();
      if (balance.available < floor + grant) {
        throw new GuestError(503, 'parent_low', 'Test accounts are paused: the funding account needs a top-up.');
      }

      const accountId = randomGuestId(config.parentId);
      limiter.record(ip);
      const result = await parent.signAndSendTransaction({
        receiverId: accountId,
        actions: [actions.createAccount(), actions.transfer(grant), actions.addFullAccessKey(key)],
        waitUntil: 'FINAL',
      });
      return { accountId, grant: config.grant, txHash: result.transaction.hash };
    },
  };
}

// One request in, one `{ status, body }` out, for whichever server hosts it.
// `service` is null when test accounts are not configured.
export async function handleGuestRequest(service, { method, body, ip }) {
  if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed', message: 'POST a JSON body with publicKey.' } };
  if (!service) return { status: 503, body: { error: 'not_configured', message: 'Test accounts are not configured on this server.' } };
  try {
    const created = await service.create({ publicKey: body?.publicKey, ip });
    return { status: 201, body: created };
  } catch (err) {
    if (err instanceof GuestError) return { status: err.status, body: { error: err.code, message: err.message } };
    console.error('[guest] account creation failed:', err?.message ?? err);
    return { status: 502, body: { error: 'chain_error', message: 'The account could not be created. Try again in a moment.' } };
  }
}

// The client address as a proxy passes it on: the first entry of
// x-forwarded-for, else the socket's.
export function clientIp(headers, socketAddress) {
  const forwarded = headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || headers['x-real-ip'] || socketAddress || 'unknown';
}

// Reads a small JSON body from a Node request, or null.
export async function readJson(req, limit = 4096) {
  if (req.body && typeof req.body === 'object') return req.body; // already parsed by the host
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) {
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > limit) return null;
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Preview mode's network: a fetch that answers the game server's routes, its
 * SSE stream, the NEAR RPC and the test-account service from a scenario's
 * fixtures, so the real client code (sandboxApi.js, fetch-event-source,
 * near-api-js) runs unchanged and nothing leaves the page.
 *
 * Same-origin requests for the app's own files pass through. Anything else
 * is refused, and noted, so a stray host shows up rather than being called.
 */

import { CONTRACT_ID, FAKE_TX, NEW_ACCOUNT, VISITOR, chainFx } from './scenarios';

const GAME_BASE = import.meta.env.VITE_BACKEND_URL || '/api';
const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://test.rpc.fastnear.com';
const GUEST_API = import.meta.env.VITE_GUEST_API || '/api/guest';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

/**
 * A promise that never settles on its own, but honours an abort signal. A
 * held request is not "in flight" for readiness: it is meant to hang.
 */
function hold(signal, tracker, tok) {
  tracker.end(tok);
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ---- borsh peeking: enough of a signed transaction to answer it ----------
function decodeTx(b64) {
  const bin = atob(b64);
  const method = /claim_winnings/.test(bin) ? 'claim_winnings' : /place_bet/.test(bin) ? 'place_bet' : 'call';
  const at = bin.indexOf('{"season_id"');
  if (at < 4) return { method };
  const u32 = (i) => bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8) | (bin.charCodeAt(i + 2) << 16) | (bin.charCodeAt(i + 3) << 24);
  const argsLen = u32(at - 4);
  const args = JSON.parse(bin.slice(at, at + argsLen));
  let deposit = 0n;
  const depAt = at + argsLen + 8; // after the u64 gas
  for (let i = 15; i >= 0; i -= 1) deposit = (deposit << 8n) | BigInt(bin.charCodeAt(depAt + i));
  return { method, args, deposit };
}

const bytesOf = (value) => Array.from(new TextEncoder().encode(JSON.stringify(value)));

/**
 * Install the fake network for one scenario spec. `tracker` hears what was
 * answered (see readiness.js).
 */
export function installNetwork(spec, tracker) {
  const realFetch = window.fetch.bind(window);
  const origin = window.location.origin;
  const gameBase = new URL(GAME_BASE, window.location.href).href.replace(/\/$/, '');
  const rpcUrl = new URL(RPC_URL, window.location.href).href;
  const guestUrl = new URL(GUEST_API, window.location.href).href;
  const game = spec.game ?? {};
  // mutable chain state: a placed bet shows up in the next read
  const chain = structuredClone(spec.chain?.seasons ?? {});
  const accounts = new Map([[VISITOR, 4.2], [NEW_ACCOUNT, 5]]);

  // ---------------------------------------------------------------- game
  function sse(world, sinceTick, signal) {
    const enc = new TextEncoder();
    const timers = [];
    let closed = false;
    const stream = new ReadableStream({
      start(controller) {
        const send = (event, data) => {
          if (closed) return;
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const close = () => {
          if (closed) return;
          closed = true;
          timers.forEach(clearTimeout);
          try { controller.close(); } catch { /* already closed */ }
        };
        signal?.addEventListener('abort', close, { once: true });
        for (const f of world.frames ?? []) if (f.tick >= sinceTick) send('frame', f);
        // the live part plays after the page has had time to read the market
        let at = world.liveDelayMs ?? 900;
        for (const item of world.live ?? []) {
          if (item.event === 'frame' && item.data.tick < sinceTick) continue;
          timers.push(setTimeout(() => send(item.event, item.data), at));
          at += item.gapMs ?? 650;
        }
        timers.push(setTimeout(() => {
          if (closed) return;
          tracker.note('stream-done');
          if (world.closeAfter) close();
        }, at));
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  async function answerGame(url, method, signal, tok) {
    const path = url.href.slice(gameBase.length).split('?')[0];
    const q = url.searchParams;
    let m;
    if (method === 'GET' && path === '/world') {
      if (game.listMode === 'hold') { tracker.note('list-held'); return hold(signal, tracker, tok); }
      if (game.listMode === 'down') { tracker.note('list-down'); return json({ detail: 'Bad gateway' }, 502); }
      if (!game.list) return json({ detail: 'Not Found' }, 404);
      tracker.note('list');
      return json(game.list);
    }
    if (method === 'GET' && path === '/world/whoami') {
      tracker.note('whoami');
      return game.whoami ? json(game.whoami) : json({ detail: 'Not Found' }, 404);
    }
    if (method === 'GET' && path === '/near/arena') {
      tracker.note('arena');
      return json(game.arena ?? { enabled: false });
    }
    if (method === 'POST' && path === '/near/arena/start') {
      const a = game.arenaStart ?? { status: 200, body: {} };
      return json(a.body, a.status);
    }
    if (method === 'POST' && path === '/world/new') {
      const id = Object.keys(game.worlds ?? {})[0];
      return id ? json({ world_id: id, host_key: 'preview-host-key', invite_code: null, invite_url: `/world/${id}/invite.md` }) : json({ detail: 'nope' }, 403);
    }
    if ((m = /^\/world\/([^/]+)(\/.*)?$/.exec(path))) {
      const [, id, rest = ''] = m;
      const world = game.worlds?.[id];
      if (method !== 'GET') return world ? json({ ok: true, world_id: id }) : json({ detail: 'Not Found' }, 404);
      if (!world) {
        tracker.note('state-gone');
        return json({ detail: `World '${id}' not found` }, 404);
      }
      if (rest === '/state') {
        if (world.stateMode === 'hold') { tracker.note('state-held'); return hold(signal, tracker, tok); }
        if (world.stateMode === 'down') { tracker.note('state-down'); return json({ detail: 'Service unavailable' }, 503); }
        tracker.note('state');
        return json(world.state);
      }
      if (rest === '/map') { tracker.note('map'); return json(world.map); }
      if (rest === '/events') return json({ events: (world.frames ?? []).flatMap((f) => f.events) });
      if (rest === '/stream') return sse(world, Number(q.get('since_tick') || 0), signal);
      const site = /^\/site\/([^/]+)\/map$/.exec(rest);
      if (site) {
        if (world.siteMode === 'hold') { tracker.note('site-held'); return hold(signal, tracker, tok); }
        const map = world.sites?.[site[1]];
        if (!map) return json({ detail: `Site '${site[1]}' not found` }, 404);
        tracker.note('site');
        return json(map);
      }
    }
    return json({ detail: 'Not Found' }, 404);
  }

  // ----------------------------------------------------------------- rpc
  const header = chainFx.block_header;
  const rpcError = (id, error) => json({ jsonrpc: '2.0', id, error });
  const rpcResult = (id, result) => json({ jsonrpc: '2.0', id, result });

  function view(method, args) {
    const s = chain[args.season_id];
    switch (method) {
      case 'get_config': return chainFx.config;
      case 'get_season': return s?.season ?? null;
      case 'get_market': return s?.market ?? null;
      case 'get_bets':
        if (args.account_id !== VISITOR || !s) return { bets: [], claimable: s?.market?.settled ? '0' : null };
        return s.bets;
      default: return undefined;
    }
  }

  function outcome(txHash, { failure = null, value = null } = {}) {
    const base = structuredClone(chainFx.tx_outcome);
    base.transaction = { ...base.transaction, hash: txHash, signer_id: VISITOR, receiver_id: CONTRACT_ID };
    base.transaction_outcome = { ...base.transaction_outcome, id: txHash };
    base.status = failure
      ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: failure } } } } }
      : { SuccessValue: value == null ? '' : btoa(JSON.stringify(value)) };
    return base;
  }

  async function answerRpc(body, signal, tok) {
    if (spec.rpcDown) {
      tracker.note('rpc-down');
      throw new TypeError('Failed to fetch');
    }
    const { id, method, params } = body;
    if (method === 'query' && params.request_type === 'call_function') {
      if (params.account_id !== CONTRACT_ID) return rpcError(id, { name: 'HANDLER_ERROR', cause: { name: 'NO_CONTRACT_CODE' }, message: 'Server error' });
      const args = JSON.parse(atob(params.args_base64 || 'e30=') || '{}');
      tracker.note(`rpc:${params.method_name}`);
      const value = view(params.method_name, args);
      return rpcResult(id, {
        result: bytesOf(value ?? null), logs: [], block_height: header.height, block_hash: header.hash,
      });
    }
    if (method === 'query' && params.request_type === 'view_account') {
      tracker.note('rpc:view_account');
      const near = spec.guestGone ? null : accounts.get(params.account_id);
      if (near == null) {
        const err = structuredClone(chainFx.unknown_account_error);
        err.cause.info.requested_account_id = params.account_id;
        err.data = `account ${params.account_id} does not exist while viewing`;
        return rpcError(id, err);
      }
      const acct = chainFx.view_account;
      const storage = BigInt(acct.storage_usage) * 10n ** 19n;
      const amount = BigInt(Math.round(near * 1e6)) * 10n ** 18n + storage;
      return rpcResult(id, { ...acct, amount: amount.toString(), block_hash: header.hash, block_height: header.height });
    }
    if (method === 'query' && params.request_type === 'view_access_key') {
      return rpcResult(id, { ...chainFx.access_key, block_hash: header.hash, block_height: header.height });
    }
    if (method === 'block') return rpcResult(id, { author: 'preview', chunks: [], header });
    if (method === 'send_tx' || method === 'broadcast_tx_commit') {
      const tx = decodeTx(params.signed_tx_base64);
      tracker.note(`tx:${tx.method}`);
      if (spec.tx === 'pending') return hold(signal, tracker, tok);
      await sleep(400);
      if (spec.tx === 'fail') {
        return rpcResult(id, outcome(FAKE_TX[0], { failure: 'Smart contract panicked: market is closed' }));
      }
      if (tx.method === 'place_bet' && tx.args) {
        const s = chain[tx.args.season_id];
        if (s) {
          const add = (rows, key) => {
            const row = rows.find((r) => r.pass_id === tx.args.pass_id);
            if (row) row[key] = (BigInt(row[key]) + tx.deposit).toString();
            else rows.push({ pass_id: tx.args.pass_id, [key]: tx.deposit.toString() });
          };
          add(s.bets.bets, 'amount');
          add(s.market.totals, 'amount');
          s.market.pool = (BigInt(s.market.pool) + tx.deposit).toString();
        }
        return rpcResult(id, outcome(FAKE_TX[0]));
      }
      if (tx.method === 'claim_winnings') {
        const s = Object.values(chain).find((x) => x.bets?.claimable);
        return rpcResult(id, outcome(FAKE_TX[2], { value: s?.bets.claimable ?? '0' }));
      }
      return rpcResult(id, outcome(FAKE_TX[0]));
    }
    return rpcError(id, { name: 'REQUEST_VALIDATION_ERROR', message: `preview: no answer for ${method}` });
  }

  // --------------------------------------------------------------- guest
  async function answerGuest(signal, tok) {
    tracker.note('guest-api');
    if (spec.guestApi === 'pending') return hold(signal, tracker, tok);
    await sleep(500);
    if (spec.guestApi === 'fail') return json({ error: 'unavailable', message: 'Test accounts are not available on this server.' }, 503);
    return json({ accountId: NEW_ACCOUNT, txHash: FAKE_TX[1], grant: '5' });
  }

  // --------------------------------------------------------------- fetch
  window.fetch = async function previewFetch(input, init = {}) {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input), window.location.href);
    const method = (init.method || req?.method || 'GET').toUpperCase();
    const signal = init.signal || req?.signal;
    const href = url.href;

    let answer = null;
    if (href === guestUrl && method === 'POST') answer = (tok) => answerGuest(signal, tok);
    else if (href === gameBase || href.startsWith(`${gameBase}/`)) answer = (tok) => answerGame(url, method, signal, tok);
    else if (href === rpcUrl && method === 'POST') {
      const body = JSON.parse(init.body ?? (req ? await req.clone().text() : '{}'));
      answer = (tok) => answerRpc(body, signal, tok);
    } else if (url.origin !== origin) {
      tracker.blocked(href);
      throw new TypeError(`Failed to fetch (preview mode refuses ${url.origin})`);
    } else {
      answer = () => realFetch(input, init);
    }
    const tok = tracker.begin();
    try {
      return await answer(tok);
    } finally {
      tracker.end(tok);
    }
  };
}

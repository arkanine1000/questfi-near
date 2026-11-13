/**
 * The visitor's NEAR test account, shared by the top bar and the market.
 *
 * Off unless VITE_CONTRACT_ID is set: then nothing here loads, near-api-js
 * included, and the market runs on simulated chips as it always has.
 *
 * The account is the one the start app makes. Both apps are served from one
 * origin, so they share it through localStorage under `questfi.guest.testnet`
 * as `{ accountId, secretKey }`. When there is none, the top bar offers to
 * make one: the key pair is generated here, only its public half goes to the
 * account service (VITE_GUEST_API), and the secret key stays in this browser.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';

export const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID || '';
const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://test.rpc.fastnear.com';
const GUEST_API = import.meta.env.VITE_GUEST_API || '/api/guest';
const GUEST_SLOT = 'questfi.guest.testnet';
const BALANCE_EVERY_MS = 15000;
const CONFIG_RETRY_MS = 8000;

function readGuest() {
  try {
    const saved = JSON.parse(localStorage.getItem(GUEST_SLOT));
    if (typeof saved?.accountId === 'string' && typeof saved?.secretKey === 'string' && saved.secretKey.startsWith('ed25519:')) {
      return { accountId: saved.accountId, secretKey: saved.secretKey };
    }
  } catch { /* storage blocked or not JSON */ }
  return null;
}

function writeGuest(guest) {
  try {
    localStorage.setItem(GUEST_SLOT, JSON.stringify({ accountId: guest.accountId, secretKey: guest.secretKey }));
    return true;
  } catch {
    return false; // the account then lasts for this page only
  }
}

const OFF = {
  enabled: false,
  status: 'off',
  error: null,
  chain: null,
  config: null,
  session: null,
  accountId: null,
  balance: null,
  createdTx: null,
  createTestAccount: () => {},
  refreshBalance: () => {},
  dismissError: () => {},
};

const NearContext = createContext(OFF);

// `contractId` defaults to VITE_CONTRACT_ID; preview mode (src/dev/preview)
// names its own, or '' for a season with no chain.
export function NearProvider({ children, contractId = CONTRACT_ID }) {
  if (!contractId) return <NearContext.Provider value={OFF}>{children}</NearContext.Provider>;
  return <LiveNearProvider contractId={contractId}>{children}</LiveNearProvider>;
}

function LiveNearProvider({ children, contractId }) {
  const [chain, setChain] = useState(null);
  const [config, setConfig] = useState(null);
  const [session, setSession] = useState(null);
  // loading | none | creating | ready
  const [status, setStatus] = useState('loading');
  const [balance, setBalance] = useState(null); // spendable yocto, BigInt
  const [error, setError] = useState(null); // plain words for the top bar
  const [createdTx, setCreatedTx] = useState(null);

  // Load the chain module only now, so a build without a contract never
  // ships near-api-js to the browser at all.
  useEffect(() => {
    let cancelled = false;
    import('../services/near.js')
      .then((near) => {
        if (cancelled) return;
        setChain(near.createChain({ contractId, rpcUrl: RPC_URL, guestApi: GUEST_API }));
      })
      .catch(() => {
        if (!cancelled) setError('The NEAR module failed to load. Reload the page to try again.');
      });
    return () => { cancelled = true; };
  }, [contractId]);

  // The contract's Config: the minimum bet and the market cuts. Retried
  // until it arrives; until then the market stays on simulated chips.
  useEffect(() => {
    if (!chain) return undefined;
    let cancelled = false;
    let timer = null;
    let failures = 0;
    const load = async () => {
      try {
        const cfg = await chain.getConfig();
        if (cancelled) return;
        setConfig(cfg);
        if (failures > 0) setError(null);
      } catch (err) {
        if (cancelled) return;
        if (failures === 0) {
          const e = chain.explainError(err);
          setError(e.kind === 'network'
            ? 'Could not reach the NEAR network. The market uses simulated chips until it can.'
            : `Could not read the contract ${chain.contractId}: ${e.text}`);
        }
        failures += 1;
        timer = setTimeout(load, CONFIG_RETRY_MS);
      }
    };
    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [chain]);

  const say = useCallback((err) => {
    setError(chain ? chain.explainError(err).text : String(err?.message ?? err));
  }, [chain]);

  // Adopt the saved test account, if any. Run again when the start app, in
  // another tab of this origin, makes or replaces it.
  const adopt = useCallback(async () => {
    if (!chain) return;
    const saved = readGuest();
    if (!saved) {
      setSession(null);
      setBalance(null);
      setStatus('none');
      return;
    }
    let s;
    try {
      s = chain.guest(saved.accountId, saved.secretKey);
    } catch {
      setStatus('none');
      setError('The saved test account key is not readable. Make a new test account.');
      return;
    }
    try {
      if (!(await chain.accountExists(saved.accountId))) {
        setSession(null);
        setStatus('none');
        setError(`The saved test account ${saved.accountId} no longer exists on testnet.`);
        return;
      }
      setBalance(await chain.balanceOf(saved.accountId));
    } catch (err) {
      say(err); // the network: keep the account, its balance comes later
    }
    setSession(s);
    setStatus('ready');
  }, [chain, say]);

  useEffect(() => { adopt(); }, [adopt]);

  useEffect(() => {
    const onStorage = (e) => { if (e.key === GUEST_SLOT || e.key === null) adopt(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [adopt]);

  const accountId = session?.accountId ?? null;

  const refreshBalance = useCallback(async () => {
    if (!chain || !accountId) return;
    try {
      setBalance(await chain.balanceOf(accountId));
    } catch { /* the next refresh tries again */ }
  }, [chain, accountId]);

  useEffect(() => {
    if (!accountId) return undefined;
    const id = setInterval(refreshBalance, BALANCE_EVERY_MS);
    return () => clearInterval(id);
  }, [accountId, refreshBalance]);

  const createTestAccount = useCallback(async () => {
    if (!chain || status === 'creating') return;
    setStatus('creating');
    setError(null);
    try {
      const made = await chain.createGuest();
      if (!writeGuest(made)) {
        setError('This browser blocks storage, so the new test account lasts only until the page closes.');
      }
      setSession(chain.guest(made.accountId, made.secretKey));
      setCreatedTx(made.txHash ? { txHash: made.txHash, grant: made.grant } : null);
      setStatus('ready');
      try {
        setBalance(await chain.balanceOf(made.accountId));
      } catch { /* shown on the next refresh */ }
    } catch (err) {
      setStatus('none');
      say(err);
    }
  }, [chain, status, say]);

  const value = useMemo(() => ({
    enabled: true,
    status: chain ? status : 'loading',
    error,
    chain,
    config,
    session,
    accountId,
    balance,
    createdTx,
    createTestAccount,
    refreshBalance,
    dismissError: () => setError(null),
  }), [chain, status, error, config, session, accountId, balance, createdTx, createTestAccount, refreshBalance]);

  return <NearContext.Provider value={value}>{children}</NearContext.Provider>;
}

export function useNear() {
  return useContext(NearContext);
}

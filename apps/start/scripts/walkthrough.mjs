#!/usr/bin/env node
// A whole run from a terminal, with the same chain module the start app uses
// (src/near.js): a fresh test account mints a pass, funds it, links an agent
// with a limited key, lets that key enter a season, and then shows the two
// things the key cannot do.
//
//   node scripts/walkthrough.mjs --contract <id> --app <start app url>
//   node scripts/walkthrough.mjs --contract <id> --game <game server url> --app <url>
//
// --contract   the QuestFi contract (or VITE_CONTRACT_ID)
// --app        where the start app is served; its /api/guest makes the test
//              account. Without it, QUESTFI_GUEST_PARENT_ID and
//              QUESTFI_GUEST_PARENT_KEY must be set and the account is made
//              here.
// --game       the game server; the open season is asked of it, the agent is
//              seated there, and the run waits for the season to play and
//              settle (a few minutes). Without it, pass --season <id>, or set
//              QUESTFI_OPERATOR_ID and QUESTFI_OPERATOR_KEY to have a season
//              created, entered and cancelled for the run.
// --keep       print the test account's id at the end (its key is discarded
//              either way; nothing secret is ever printed).
//
// Exit codes: 0 all steps passed, 1 a step failed, 2 bad arguments or setup.
import { readFileSync } from 'node:fs';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, teraToGas } from 'near-api-js';
import { AGENT_METHODS, createChain, explainError, explorerAccount, explorerTx, fromYocto, toYocto } from '../src/near.js';
import { createGame } from '../src/game.js';
import { createGuestService, guestConfig } from '../server/guest.js';

// ---- arguments and settings -------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
};
const env = { ...process.env };
for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n')) {
      const at = line.indexOf('=');
      if (at > 0 && !line.startsWith('#') && env[line.slice(0, at)] === undefined) env[line.slice(0, at)] = line.slice(at + 1).trim();
    }
  } catch {
    // no such file
  }
}

const contractId = flag('contract') || env.VITE_CONTRACT_ID;
const rpcUrl = env.VITE_RPC_URL || 'https://test.rpc.fastnear.com';
const appUrl = typeof flag('app') === 'string' ? flag('app').replace(/\/$/, '') : null;
const gameUrl = typeof flag('game') === 'string' ? flag('game').replace(/\/$/, '') : null;
if (!contractId) {
  console.error('Give the contract: --contract <account id>');
  process.exit(2);
}

const chain = createChain({ contractId, rpcUrl, guestApi: appUrl ? `${appUrl}/api/guest` : '/api/guest' });
const provider = new JsonRpcProvider({ url: rpcUrl });
const near = (yocto) => `${fromYocto(yocto)} NEAR`;

let stepNo = 0;
let failed = false;
async function step(title, fn) {
  stepNo += 1;
  const label = `${String(stepNo).padStart(2)}. ${title}`;
  try {
    const note = await fn();
    console.log(`ok    ${label}${note ? `\n        ${String(note).split('\n').join('\n        ')}` : ''}`);
    return true;
  } catch (err) {
    failed = true;
    console.log(`FAIL  ${label}\n        ${String(err?.message ?? err).slice(0, 400)}`);
    return false;
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

// ---- the run ----------------------------------------------------------------
console.log(`contract ${contractId}  ${explorerAccount(contractId)}\n`);

let config;
let roster;
await step('the contract answers', async () => {
  config = await chain.getConfig();
  roster = await chain.getRoster();
  expect(roster.length > 0, 'the roster is empty: the contract has not been seeded');
  return `mint fee ${near(config.mint_storage_fee)}, default caps ${near(config.default_per_call_cap)} per call and ${near(config.default_daily_limit)} per day, ${roster.length} house agents`;
});
if (failed) process.exit(1);

let owner;
let ownerAccount;
await step('a test account is created', async () => {
  let made;
  if (appUrl) {
    made = await chain.createGuest();
  } else {
    const settings = guestConfig(env);
    expect(settings, 'no --app given and QUESTFI_GUEST_PARENT_ID / QUESTFI_GUEST_PARENT_KEY are not set');
    const keyPair = KeyPair.fromRandom('ed25519');
    const created = await createGuestService(settings).create({ publicKey: keyPair.getPublicKey().toString(), ip: 'walkthrough' });
    made = { ...created, secretKey: keyPair.toString() };
  }
  owner = chain.owner.guest(made.accountId, made.secretKey);
  ownerAccount = new Account(made.accountId, provider, new KeyPairSigner(KeyPair.fromString(made.secretKey)));
  return `${made.accountId} holds ${near(await chain.balanceOf(made.accountId))}\n${explorerTx(made.txHash)}`;
});
if (failed) process.exit(1);

let passId;
const firstDeposit = (BigInt(config.default_per_call_cap) * 3n) / 2n;
await step('it mints a pass, with a first deposit inside', async () => {
  const done = await chain.mintPass(owner, BigInt(config.mint_storage_fee) + firstDeposit);
  passId = done.passId;
  const pass = await chain.getPass(passId);
  expect(pass.owner_id === owner.accountId, `pass owner is ${pass.owner_id}`);
  expect(BigInt(pass.balance) === firstDeposit, `pass balance is ${pass.balance}, expected ${firstDeposit}`);
  return `pass #${passId}, balance ${near(pass.balance)}, level ${pass.level}\n${explorerTx(done.txHash)}`;
});
if (failed) process.exit(1);

await step('the owner deposits and withdraws', async () => {
  const amount = toYocto('0.02');
  const inTx = await chain.deposit(owner, passId, amount);
  expect(BigInt((await chain.getPass(passId)).balance) === firstDeposit + amount, 'the deposit did not land in the pass');
  const outTx = await chain.withdraw(owner, passId, amount);
  expect(BigInt((await chain.getPass(passId)).balance) === firstDeposit, 'the withdrawal did not leave the pass');
  return `${near(amount)} in, ${near(amount)} out\n${explorerTx(inTx.txHash)}\n${explorerTx(outTx.txHash)}`;
});

let agent;
let pick;
await step('it links a house agent and issues the agent key', async () => {
  pick = roster[0];
  const linked = await chain.linkAgent(owner, { passId, kind: 'rented', name: pick.name, rosterId: pick.roster_id, priceYocto: BigInt(pick.price) });
  agent = chain.agent(owner.accountId, linked.agentSecretKey);
  const key = await chain.accessKey(owner.accountId, linked.publicKey);
  const permission = key?.permission?.FunctionCall;
  expect(permission, 'the agent key is not a function-call key');
  expect(permission.receiver_id === contractId, `the key is for ${permission.receiver_id}`);
  expect(JSON.stringify(permission.method_names) === JSON.stringify(AGENT_METHODS), `the key allows ${permission.method_names}`);
  const pass = await chain.getPass(passId);
  expect(pass.agent?.public_key === linked.publicKey, 'the contract did not record the agent key');
  return `${pick.name} for ${near(pick.price)}; the key may call ${permission.method_names.join(' and ')} on ${permission.receiver_id}, nothing else\n${explorerTx(linked.keyTx)}\n${explorerTx(linked.linkTx)}`;
});
if (failed) process.exit(1);

await step('the agent key cannot withdraw: the protocol refuses the transaction', async () => {
  try {
    await chain.withdrawAsAgent(agent, passId, toYocto('0.01'));
  } catch (err) {
    const e = explainError(err);
    expect(e.kind === 'protocol', `refused, but not by the protocol: ${e.text}`);
    const before = await chain.getPass(passId);
    expect(BigInt(before.balance) === firstDeposit, 'the pass balance changed');
    return `${e.name}: "${e.text}"\nnothing reached the contract, so there is no transaction to link`;
  }
  throw new Error('the withdrawal went through');
});

await step('the agent key cannot spend over the per-call cap: the contract refuses', async () => {
  const over = BigInt(config.default_per_call_cap) + toYocto('0.01');
  const other = passId === '1' ? '2' : '1';
  try {
    await chain.payAgent(agent, passId, other, over, 'walkthrough');
  } catch (err) {
    const e = explainError(err);
    expect(e.kind === 'policy', `refused, but not by the policy: ${e.text}`);
    return `tried ${near(over)}; the contract answered "${e.text}"${e.txHash ? `\n${explorerTx(e.txHash)}` : ''}`;
  }
  throw new Error('the payment went through');
});

// ---- a season to enter --------------------------------------------------------
let seasonId = typeof flag('season') === 'string' ? flag('season') : null;
let operator = null;
if (!seasonId && gameUrl) {
  await step('the game server names the open season', async () => {
    const open = await createGame(gameUrl).openSeason();
    seasonId = open.world_id;
    return `season ${seasonId}`;
  });
} else if (!seasonId && env.QUESTFI_OPERATOR_ID && env.QUESTFI_OPERATOR_KEY) {
  await step('an operator opens a season for this run', async () => {
    operator = new Account(env.QUESTFI_OPERATOR_ID, provider, new KeyPairSigner(KeyPair.fromString(env.QUESTFI_OPERATOR_KEY)));
    seasonId = `walk-${Date.now().toString(36)}`;
    const stake = BigInt(config.default_per_call_cap) / 4n;
    const res = await operator.signAndSendTransaction({
      receiverId: contractId,
      actions: [actions.functionCall('create_season', { season_id: seasonId, entry_stake: String(stake) }, teraToGas(30), 0n)],
      waitUntil: 'FINAL',
    });
    return `season ${seasonId}, entry stake ${near(stake)}\n${explorerTx(res.transaction.hash)}`;
  });
}

if (seasonId && !failed) {
  await step('the agent key enters the season: no owner signature, stake from the pass', async () => {
    const before = await chain.getPass(passId);
    const season = await chain.getSeason(seasonId);
    expect(String(season?.status).toLowerCase() === 'open', `season ${seasonId} is ${season?.status ?? 'unknown'}`);
    const entered = await chain.enterSeason(agent, passId, seasonId);
    const after = await chain.getPass(passId);
    expect(BigInt(before.balance) - BigInt(after.balance) === BigInt(season.entry_stake), 'the stake did not leave the pass balance');
    expect(after.active_season === seasonId, 'the pass does not show the season');
    const event = entered.events.find((e) => e.event === 'season_entered');
    expect(event?.data?.[0]?.signed_by_agent_key === true, 'the event does not say the agent key signed');
    return `stake ${near(season.entry_stake)}, pass balance ${near(before.balance)} -> ${near(after.balance)}, signed_by_agent_key: true\n${explorerTx(entered.txHash)}`;
  });
} else if (!seasonId) {
  console.log('skip  no season to enter: give --game <url> or --season <id>');
}

if (gameUrl && seasonId && !failed) {
  await step('the game server seats the agent', async () => {
    const seat = await createGame(gameUrl).join(seasonId, { passId, name: pick.name, rosterId: pick.roster_id, accountId: owner.accountId });
    // a seated player may skip the countdown; if a season is still running,
    // this one starts by itself when that has settled
    const early = await createGame(gameUrl).startNow().then(() => true, () => false);
    const when = early ? 'now' : seat.starts_in_s == null ? 'when the season before it has settled' : `in about ${Math.round(seat.starts_in_s)} s`;
    return `${seat.name} has a seat in ${seat.world_id}; the season starts ${when}`;
  });

  await step('the season plays and settles on chain', async () => {
    const until = Date.now() + 10 * 60_000;
    let season;
    for (;;) {
      season = await chain.getSeason(seasonId);
      if (season.status === 'Settled' || season.status === 'Cancelled') break;
      expect(Date.now() < until, `season ${seasonId} is still ${season.status} after 10 minutes`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    expect(season.status === 'Settled', `the season was ${season.status}`);
    const pass = await chain.getPass(passId);
    expect(pass.active_season === null, 'the pass is still marked as in the season');
    const lines = (await chain.getActivity(passId, 0, 8))
      .filter((a) => ['kill', 'death', 'win', 'loot', 'market_cut'].includes(a.kind))
      .map((a) => `${a.kind}: ${a.text}${BigInt(a.amount) > 0n ? ` (${a.negative ? '-' : '+'}${near(a.amount)})` : ''}`);
    return [`won by pass #${season.winner ?? 'nobody'}; this pass: balance ${near(pass.balance)}, kills ${pass.kills}, wins ${pass.wins}, level ${pass.level}`, ...lines].join('\n');
  });
}

if (operator && seasonId && !failed) {
  await step('the operator cancels the run\'s season and the stake comes back', async () => {
    const res = await operator.signAndSendTransaction({
      receiverId: contractId,
      actions: [actions.functionCall('cancel_season', { season_id: seasonId }, teraToGas(60), 0n)],
      waitUntil: 'FINAL',
    });
    const pass = await chain.getPass(passId);
    expect(pass.active_season === null, 'the pass is still in the season');
    return `pass balance ${near(pass.balance)}\n${explorerTx(res.transaction.hash)}`;
  });
}

await step('the contract holds at least what it owes', async () => {
  const books = await chain.getAccounting();
  expect(books.solvent === true, `not solvent: ${JSON.stringify(books)}`);
  return `owed ${near(books.owed_total)}, on the account ${near(books.account_balance)}, of which storage ${near(books.storage_reserved)}`;
});

console.log(`\n${failed ? 'FAILED' : 'all steps passed'}${flag('keep') ? `  ${explorerAccount(ownerAccount.accountId)}` : ''}`);
process.exit(failed ? 1 : 0);

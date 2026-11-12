// Explorer links and short forms of long ids, for the screen. Kept apart from
// near.js so the interface can use them without loading near-api-js.

export const explorerTx = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;
export const explorerAccount = (id) => `https://testnet.nearblocks.io/address/${id}`;

/**
 * A long account id cut to fit. Test account ids (`g-<8 chars>.<parent>`) run
 * to about 31 characters; their first label is the part that tells them
 * apart, so it is kept whole with the network: `g-ab12cd34…testnet`.
 */
export function shortAccount(id, max = 22) {
  if (!id || id.length <= max) return id ?? '';
  const labels = id.split('.');
  const first = labels[0];
  const last = labels[labels.length - 1];
  if (labels.length > 2 && first.length + last.length + 1 <= max) return `${first}…${last}`;
  return `${id.slice(0, max - 9)}…${id.slice(-8)}`;
}

/** A transaction hash cut to its first six and last four characters. */
export const shortHash = (hash) => (hash ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : '');

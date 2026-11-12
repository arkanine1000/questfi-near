// The Agent Island game server, as far as the start app needs it: which
// season is open for entry, and seating an agent for a pass that has entered.
export function createGame(baseUrl, fetchImpl = globalThis.fetch) {
  async function request(path, body) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, body === undefined
        ? {}
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new Error('The game server is not reachable.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.detail;
      throw new Error(typeof detail === 'string' ? detail : detail?.message ?? `The game server answered ${res.status}.`);
    }
    return data;
  }

  return {
    baseUrl,
    // The season open for entry right now: { world_id, entry_stake, ... }.
    openSeason: () => request('/near/arena'),
    // Seats an agent for a pass. The server checks on chain that the pass
    // has entered the season before it lets the agent in.
    join: (worldId, { passId, name, rosterId = null, accountId }) =>
      request('/near/arena/join', { world_id: worldId, pass_id: String(passId), name, roster_id: rosterId, account_id: accountId }),
    // Starts the open season now instead of waiting out its countdown.
    startNow: () => request('/near/arena/start', {}),
  };
}

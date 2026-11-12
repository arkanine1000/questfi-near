// POST /api/guest { publicKey } -> 201 { accountId, grant, txHash }
// Creates a funded NEAR testnet account for a visitor with no wallet. See
// server/guest.js for what it does and what bounds it.
import { clientIp, createGuestService, guestConfig, handleGuestRequest, readJson } from '../server/guest.js';

let service; // one per warm instance, so its counters persist between requests

export default async function handler(req, res) {
  if (service === undefined) {
    const config = guestConfig(process.env);
    service = config ? createGuestService(config) : null;
  }
  const { status, body } = await handleGuestRequest(service, {
    method: req.method,
    body: req.method === 'POST' ? await readJson(req) : null,
    ip: clientIp(req.headers, req.socket?.remoteAddress),
  });
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

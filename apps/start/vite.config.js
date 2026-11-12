import { defineConfig, loadEnv } from 'vite';

// In development, /api/guest is served by the dev server itself, with the
// same handler the hosted build runs as a function (api/guest.js). The
// settings come from .env.local; without them the endpoint answers 503 and
// the app offers the wallet instead.
function guestApi(mode) {
  return {
    name: 'questfi-guest-api',
    configureServer(server) {
      const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') };
      let service;
      server.middlewares.use('/api/guest', async (req, res) => {
        const guest = await import('./server/guest.js');
        if (service === undefined) {
          const config = guest.guestConfig(env);
          service = config ? guest.createGuestService(config) : null;
        }
        const { status, body } = await guest.handleGuestRequest(service, {
          method: req.method,
          body: req.method === 'POST' ? await guest.readJson(req) : null,
          ip: guest.clientIp(req.headers, req.socket?.remoteAddress),
        });
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: './',
  build: { chunkSizeWarningLimit: 1400 },
  server: { host: true, port: 5177 },
  plugins: [guestApi(mode)],
}));

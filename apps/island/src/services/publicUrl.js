/**
 * The URL of a file in `public/`, wherever the app is served.
 *
 * Files there are named by their root-absolute path ('/crawler/x.webp', see
 * public/README.md). A build for a sub-path (`vite build --base=/island/`)
 * serves them under that path, so every reference goes through here, which
 * puts Vite's base in front: import.meta.env.BASE_URL is '/' by default and
 * '/island/' in that build, giving '/island/crawler/x.webp'.
 *
 * Only for the app's own static files. The game server (VITE_BACKEND_URL,
 * '/api' by default) and the guest endpoint (VITE_GUEST_API) keep the
 * addresses they are given.
 */
const RAW = import.meta.env.BASE_URL || '/';
const BASE = RAW.endsWith('/') ? RAW : `${RAW}/`;

export function publicUrl(path) {
  return `${BASE}${String(path).replace(/^\/+/, '')}`;
}

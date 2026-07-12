// Point this at whichever server you want the extension to talk to:
//   - local `wrangler dev` (server/):       "127.0.0.1:8787"
//   - a deployed Worker (after Piece 8):    "ssynch.<your-subdomain>.workers.dev"
// Left blank until you set one; connect() will refuse to run with this unset.
export const SERVER_HOST = "127.0.0.1:8787";

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function wsUrlForRoom(code) {
  if (!SERVER_HOST) {
    throw new Error("SERVER_HOST is not set in src/shared/config.js — point it at local wrangler dev or your deployed Worker, then rebuild and reload the extension.");
  }
  // wrangler dev serves plain http/ws, not TLS — only deployed *.workers.dev needs wss://.
  const scheme = LOCAL_HOST_RE.test(SERVER_HOST) ? "ws" : "wss";
  return `${scheme}://${SERVER_HOST}/room/${encodeURIComponent(code)}`;
}

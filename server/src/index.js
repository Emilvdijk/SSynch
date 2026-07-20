// Piece 6/7: the Worker routes each room code to its own Durable Object
// instance; the Room DO fans out host events to guests using the WebSocket
// Hibernation API, so idle rooms (paused, or nobody talking) don't burn
// compute duration against the free tier's daily cap.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!match) return new Response("expected /room/<code>", { status: 400 });

    const code = decodeURIComponent(match[1]);
    if (!code) return new Response("missing room code", { status: 400 });

    const id = env.ROOM.idFromName(code);
    const stub = env.ROOM.get(id);
    return stub.fetch(request);
  }
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernation-safe accept: the runtime can drop this object from memory
    // between messages and still deliver future messages/close events later.
    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "hello": {
        ws.serializeAttachment({ role: msg.role, name: msg.name });
        if (msg.role === "guest") {
          const current = this.loadState();
          if (current) ws.send(JSON.stringify({ type: "sync", ...current }));
        }
        this.broadcastPeerCount();
        break;
      }

      case "ping": {
        ws.send(JSON.stringify({ type: "pong", t0: msg.t0, t1: Date.now() }));
        // Cheap self-healing safety net: pings recur periodically regardless
        // of playback state, so this bounds how long a stale peer count from
        // a missed/delayed close event (observed in local wrangler dev — the
        // Hibernation API's close detection isn't always prompt there) can persist.
        this.broadcastPeerCount();
        break;
      }

      case "bye": {
        // Sent just before an intentional disconnect (leave room, close tab)
        // — don't wait for webSocketClose to (maybe, eventually) fire.
        this.broadcastPeerCountExcluding(ws);
        break;
      }

      case "setVideo": {
        if (!this.isHost(ws)) break;
        // duration and className ride along as secondary matching signals
        // for guests whose structural descriptor fails to resolve, or
        // resolves ambiguously among several candidates on the page (see
        // findVideoByDuration/classesOverlap in the extension's
        // video-detector.js) — both optional, may be null.
        const merged = {
          ...(this.loadState() || {}),
          descriptor: msg.descriptor,
          frameUrl: msg.frameUrl,
          pageUrl: msg.pageUrl,
          duration: msg.duration ?? null,
          className: msg.className ?? null
        };
        this.saveState(merged);
        this.broadcast({ type: "sync", ...merged }, ws);
        break;
      }

      case "clearVideo": {
        // Host navigated away without picking a new video on the new page —
        // drop the stale descriptor/frameUrl/pageUrl so guests (and a freshly
        // (re)connecting client) don't get pointed at a dead page.
        if (!this.isHost(ws)) break;
        const merged = { ...(this.loadState() || {}), descriptor: null, frameUrl: null, pageUrl: null, duration: null, className: null };
        this.saveState(merged);
        this.broadcast({ type: "sync", ...merged }, ws);
        break;
      }

      case "state": {
        // Symmetric control: any connected peer (host or guest) may
        // play/pause/seek. Whoever's message the DO processes last "wins" —
        // it gets broadcast to (and applied by) everyone else, including
        // whoever sent the previous state, which is exactly last-writer-wins
        // with no extra conflict-resolution logic needed.
        const merged = { ...(this.loadState() || {}), play: msg.play, currentTime: msg.currentTime, rate: msg.rate, at: msg.at };
        this.saveState(merged);
        this.broadcast({ type: "state", play: msg.play, currentTime: msg.currentTime, rate: msg.rate, at: msg.at }, ws);
        break;
      }

      case "heartbeat": {
        // Host-only, unlike `state` above: heartbeats drive continuous
        // drift-correction (reconcileDrift), and only the host's position
        // should ever be authoritative for that — a guest's own stalls/lag
        // would otherwise drag the host (and every other guest) off a
        // correctly-synced position. Explicit play/pause/seek stays symmetric
        // via `state`; this gate is specifically about the periodic nudge/seek
        // loop. Not persisted: heartbeats are only useful live, and skipping
        // the write keeps a playing room cheap — a freshly (re)connecting
        // client just gets the last saved `state` instead.
        if (!this.isHost(ws)) break;
        this.broadcast({ type: "heartbeat", currentTime: msg.currentTime, at: msg.at }, ws);
        break;
      }
    }
  }

  async webSocketClose(ws) {
    // Don't trust getWebSockets() to have already dropped `ws` by the time
    // this fires — observed in local wrangler dev to sometimes still include
    // it, which would otherwise briefly re-broadcast a stale (too-high) count
    // right after a correct "bye"-triggered update already went out.
    this.broadcastPeerCountExcluding(ws);
  }

  async webSocketError(ws) {
    this.broadcastPeerCountExcluding(ws);
  }

  isHost(ws) {
    const attachment = ws.deserializeAttachment();
    return attachment?.role === "host";
  }

  broadcast(message, exclude) {
    const payload = JSON.stringify(message);
    for (const peer of this.state.getWebSockets()) {
      if (peer !== exclude) peer.send(payload);
    }
  }

  broadcastPeerCount() {
    const count = this.state.getWebSockets().length;
    this.broadcast({ type: "peers", count });
  }

  /** Like broadcastPeerCount, but explicitly excludes `ws` from the count too — not just the recipient list. */
  broadcastPeerCountExcluding(ws) {
    const count = Math.max(0, this.state.getWebSockets().filter((s) => s !== ws).length);
    this.broadcast({ type: "peers", count }, ws);
  }

  saveState(state) {
    this.state.storage.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('state', ?)", JSON.stringify(state));
  }

  loadState() {
    const rows = [...this.state.storage.sql.exec("SELECT v FROM kv WHERE k = 'state'")];
    return rows.length ? JSON.parse(rows[0].v) : null;
  }
}

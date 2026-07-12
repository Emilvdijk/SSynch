# Video Sync Extension — Full Execution Plan

A Chrome extension (Manifest V3) that (1) lets you target and control a `<video>` element on any page, and (2) creates rooms where invited people watch the same video synced to the host's playback state. The backend is a single Cloudflare Worker + Durable Object running on the **free** Workers plan.

The plan is broken into three parts and twelve pieces. Build them roughly in order. Each piece lists **what it is**, **what it needs**, and **implementation detail**. Parts A and B can be built in parallel; Part C is where they meet.

---

## Architecture at a glance

```
┌─────────────────── Chrome (each participant) ───────────────────┐
│                                                                 │
│   Side Panel UI  ◄──── messages ────►  Service Worker           │
│   (create/join,                        (owns the WebSocket,     │
│    pick video)                          holds room identity)    │
│                                              │                  │
│                                        messages (per tab)       │
│                                              ▼                  │
│   Content Script (per frame, all_frames: true)                  │
│   - finds the <video>                                           │
│   - resolves the shared selector                                │
│   - calls play/pause/seek, listens to video events              │
└─────────────────────────────────────────────────────────────────┘
                               │  WebSocket (wss://)
                               ▼
┌──────────────── Cloudflare (free Workers plan) ─────────────────┐
│   Worker (router)  ──►  Durable Object "Room" (one per code)    │
│                          - fans out host events to guests       │
│                          - holds room state in SQLite           │
│                          - uses WebSocket Hibernation API        │
└─────────────────────────────────────────────────────────────────┘
```

**Design rule for v1:** the host is the single source of truth. Guests apply the host's state; they never push playback commands back. Symmetric control (anyone can pause) is a v2 problem.

---

# PART A — The extension (client)

## Piece 0 — Project scaffolding and manifest

**What it is.** The skeleton: `manifest.json`, folder layout, and a build step if you use a bundler.

**What it needs.**
- Manifest V3 (V2 is dead in Chrome).
- Permissions: `scripting`, `storage`, `sidePanel`, `tabs`.
- `host_permissions: ["<all_urls>"]` because you want "any page." This triggers a scary install warning; that's unavoidable for a universal content script.
- A bundler is optional. Vanilla JS works. If you want a React side panel, use Vite with the `@crxjs/vite-plugin` (handles MV3 quirks like HMR and manifest generation).

**Detail.** Minimal manifest:

```json
{
  "manifest_version": 3,
  "name": "Watch Together",
  "version": "0.1.0",
  "permissions": ["scripting", "storage", "sidePanel", "tabs"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "side_panel": { "default_path": "sidepanel.html" },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "all_frames": true,
      "run_at": "document_idle"
    }
  ],
  "action": { "default_title": "Watch Together" }
}
```

`all_frames: true` is essential — embedded players (YouTube etc.) live in child iframes, so the content script must run in every frame, not just the top document.

---

## Piece 1 — Video detection and the element picker

**What it is.** The content-script logic that finds candidate `<video>` elements and lets the host explicitly pick one via an inspect-style overlay.

**What it needs.** DOM access (content script only), a way to compute a **stable descriptor** for the chosen element so other machines can resolve the same one.

**Detail.**

*Auto-detect* first, as a convenience: `document.querySelectorAll('video')`, filter to elements with a real size and `readyState > 0`, pick the largest by rendered area. This is right most of the time.

*Manual picker* for messy pages. Enter "pick mode": listen to `mousemove`, draw a highlight box over the element under the cursor (`document.elementFromPoint`), and on `click` capture the element while `preventDefault()`-ing so you don't trigger the page. If the clicked element isn't a `<video>`, walk up/down the tree to find the nearest one.

*The stable descriptor* is the sync-critical bit. A raw JS reference is useless across machines. Generate something reproducible:
- Prefer a unique attribute: `id`, or a stable `data-*`.
- Otherwise build a structural CSS selector (nth-of-type path from a stable ancestor).
- Store the descriptor **plus the frame URL** (so guests know which frame to resolve it in).

Store this in room state. When a guest joins, their content script runs the same resolution against their copy of the page.

**Gotchas that cost real time.**
- **Shadow DOM:** some players nest `<video>` in a shadow root; `querySelectorAll` won't pierce it. You need to recurse into `shadowRoot`s during detection.
- **Cross-origin iframes:** you run *inside* each frame via `all_frames`, but you cannot reach *into* a cross-origin frame from the parent. Coordinate by messaging through the service worker, keyed by frame.
- **Late-loading video:** SPA players swap the element after navigation. Use a `MutationObserver` to re-detect, and re-resolve the descriptor if the element is replaced.

---

## Piece 2 — The video controller

**What it is.** A thin wrapper around the chosen `HTMLMediaElement` that (a) executes commands and (b) reports the video's own events.

**What it needs.** Nothing beyond the element reference and the messaging channel to the service worker.

**Detail.**

*Commands you send to the element:* `.play()`, `.pause()`, set `.currentTime`, set `.playbackRate`.

*Events you listen for (host side):* `play`, `pause`, `seeked`, `ratechange`. Also `timeupdate` (fires ~4x/sec) but do **not** broadcast every one — you'll flood the socket. Use it only to build periodic heartbeats (Piece 11).

*The echo problem, which will confuse you if you skip it:* when a guest applies `video.pause()`, the element fires its own `pause` event. If your listener rebroadcasts that, you get infinite loops and fighting clients. Guard it: set an `isApplyingRemote` flag before you programmatically change the element, and ignore the resulting events while it's set (clear it on the next tick).

---

## Piece 3 — Service worker and the messaging architecture

**What it is.** The persistent (as much as MV3 allows) background context that owns the WebSocket and relays between UI, content scripts, and the server.

**What it needs.** `chrome.runtime` messaging, `chrome.tabs`/`chrome.scripting` to target the right tab/frame, `chrome.storage.session` for room identity.

**Detail.**

Why the socket lives here and not in the content script: content scripts die on every navigation and reload. A guest who is "linked to the host's page" will navigate, and you don't want the connection to drop each time. The service worker survives navigations (though MV3 can still evict it when idle — see caveat).

Message flow:
- UI → SW: "create room", "join room CODE", "pick video", "leave".
- SW → content script (specific tab/frame): "enter pick mode", "apply state {play, t, rate, at}".
- Content script → SW: "video picked {descriptor}", "host event {type, t, rate}".
- SW ↔ server: the WebSocket (Part C).

**MV3 caveat.** The service worker can be killed after ~30s idle. An open WebSocket counts as activity and keeps it alive while connected, but design defensively: persist room code + role to `chrome.storage.session`, and on worker restart, reconnect and rejoin the room from stored state.

---

## Piece 4 — The UI (side panel)

**What it is.** The human-facing surface: create a room (get a shareable code), join by code, trigger video pick, show connection status and participant count.

**What it needs.** `chrome.sidePanel` (nicer than a popup because it stays open while the user interacts with the page). Plain HTML/JS or a small React app.

**Detail.** Keep it tiny for v1: a "Create room" button that returns a short code (e.g. 6 chars), a code input + "Join," a "Select video on this page" button, and a status line ("Connected · 3 watching · synced"). Everything else is messaging into the service worker. Don't over-invest here until sync works.

---

# PART B — The backend (Cloudflare Durable Object, free tier)

Cloudflare's free Workers plan includes Durable Objects, but **only the SQLite-backed storage backend** (key-value backend is paid-only). Free limits are roughly **100,000 requests/day** and **13,000 GB-s/day** of compute duration, with 5 GB of Durable Object storage. These numbers can change, so check the current pricing page before you rely on them.

## Piece 5 — Account and tooling setup

**What it is.** Getting a Cloudflare account and the `wrangler` CLI working.

**What it needs.**
- A free Cloudflare account (no card required for the free plan).
- Node.js installed locally.
- `npm install -g wrangler`, then `wrangler login`.

**Detail.** Scaffold with `npm create cloudflare@latest watch-sync -- --type=hello-world`. Choose the Worker (not Pages) option. This gives you `src/index.ts`, `wrangler.jsonc`, and a working `wrangler dev` / `wrangler deploy` loop. You'll get a free `*.workers.dev` subdomain, which is exactly the `wss://` endpoint your extension connects to — no custom domain needed.

---

## Piece 6 — The Worker router + the Room Durable Object

**What it is.** A Worker that upgrades incoming WebSocket requests and routes each to the Durable Object instance named after the room code. The Durable Object *is* the room.

**What it needs.**
- A Durable Object class declared in `wrangler.jsonc` with a **SQLite migration** (required for free tier).
- The **WebSocket Hibernation API** (`state.acceptWebSocket()`, not the plain `ws.accept()`). This is the single most important choice for staying on the free tier.

**Why hibernation matters (the free-tier crux).** With the ordinary WebSocket API, calling `accept()` bills you for compute duration for the *entire* time the socket is open — a 2-hour movie means 2 hours of billed duration per room. With the Hibernation API, Cloudflare can evict the object from memory between messages while keeping the sockets open, and you are **not billed for idle duration**. The tradeoff: in-memory variables are lost on eviction, so any room state you care about must live in storage and be re-read when the object wakes. For a watch-party where people pause for 20 minutes, this is the difference between "free" and "over the cap."

**`wrangler.jsonc`:**

```jsonc
{
  "name": "watch-sync",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "durable_objects": {
    "bindings": [{ "name": "ROOM", "class_name": "Room" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["Room"] }
  ]
}
```

`new_sqlite_classes` (not `new_classes`) is what puts you on the free-tier-eligible SQLite backend.

**Worker + Durable Object skeleton:**

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // expect wss://.../room/ABC123
    const code = url.pathname.split("/").pop();
    if (!code) return new Response("missing room code", { status: 400 });

    // one Durable Object instance per room code
    const id = env.ROOM.idFromName(code);
    const stub = env.ROOM.get(id);
    return stub.fetch(request);
  }
};

export class Room {
  state: DurableObjectState;
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    // create the state table once
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)"
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // HIBERNATION: accept via the state, not server.accept()
    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // fires when a hibernated socket receives a message
  async webSocketMessage(ws: WebSocket, message: string) {
    const msg = JSON.parse(message);
    // fan out host events to everyone else; see Piece 7 for the protocol
    if (msg.role === "host") {
      this.saveState(msg);                 // persist to SQLite
      for (const peer of this.state.getWebSockets()) {
        if (peer !== ws) peer.send(message);
      }
    }
    // a guest that just joined asks for current state:
    if (msg.type === "hello") {
      const current = this.loadState();
      if (current) ws.send(JSON.stringify({ type: "sync", ...current }));
    }
  }

  async webSocketClose(ws: WebSocket) {
    // optional: broadcast updated participant count
  }

  private saveState(msg: any) {
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO kv (k, v) VALUES ('state', ?)",
      JSON.stringify(msg)
    );
  }
  private loadState(): any | null {
    const row = [...this.state.storage.sql.exec(
      "SELECT v FROM kv WHERE k = 'state'"
    )][0];
    return row ? JSON.parse(row.v as string) : null;
  }
}
```

Note the object holds **no** long-lived in-memory list of sockets — `this.state.getWebSockets()` returns the live sockets even after the object woke from hibernation, and state is read back from SQLite. That's what keeps it hibernation-safe.

---

## Piece 7 — The room protocol (message schema)

**What it is.** The small set of JSON messages that flow over the socket. Keeping this tight makes everything else easier.

**What it needs.** Nothing extra — just discipline about the shape.

**Detail.** Suggested messages:

```
client → server:
  { type: "hello", role: "host" | "guest", code, name }
  { type: "setVideo", descriptor, frameUrl }          // host only
  { type: "state", play, currentTime, rate, at }      // host, on play/pause/seek
  { type: "heartbeat", currentTime, at }               // host, periodic

server → client:
  { type: "sync", play, currentTime, rate, at, descriptor, frameUrl }  // full snapshot on join
  { type: "state", ... }        // relayed host event
  { type: "heartbeat", ... }    // relayed host heartbeat
  { type: "peers", count }      // participant count changed
```

`at` is **always** a timestamp (host's clock, milliseconds). It is the input to latency compensation in Part C — a state message without a timestamp is unusable for sync.

---

## Piece 8 — Deploy

**What it is.** Shipping the Worker so the extension has a real `wss://` URL.

**What it needs.** `wrangler deploy`.

**Detail.** After deploy you get `https://watch-sync.<your-subdomain>.workers.dev`. Your WebSocket URL is the same host with `wss://` and your path, e.g. `wss://watch-sync.<subdomain>.workers.dev/room/ABC123`. Test it before touching the extension: `npx wscat -c "wss://.../room/TEST"` and send a `hello` message by hand. Getting the handshake working here, in isolation, saves hours of debugging through the extension layer.

---

# PART C — Connecting the extension to Cloudflare

## Piece 9 — WebSocket client in the service worker

**What it is.** The service worker opens and manages the `wss://` connection to the Room DO.

**What it needs.** The deployed URL from Piece 8, reconnection logic.

**Detail.**

```js
let socket = null;

function connect(code, role, name) {
  socket = new WebSocket(`wss://watch-sync.<subdomain>.workers.dev/room/${code}`);
  socket.onopen = () => socket.send(JSON.stringify({ type: "hello", role, name }));
  socket.onmessage = (e) => handleServerMessage(JSON.parse(e.data));
  socket.onclose = () => scheduleReconnect(code, role, name); // backoff
}
```

- On open, send `hello`. A guest immediately receives a `sync` snapshot and applies it (jump to the right time, play/pause).
- `handleServerMessage` forwards playback messages to the active tab's content script via `chrome.tabs.sendMessage` (targeting the right frame).
- Reconnect with exponential backoff; on reconnect, re-send `hello` (the DO re-sends current state). Because room identity is in `chrome.storage.session`, a killed-and-restarted service worker can rejoin transparently.

**CORS/CSP note:** WebSocket connections from an extension service worker are not subject to page CSP, and `wss://*.workers.dev` is allowed by default. You do **not** need to add the server to `host_permissions` for the socket — that list governs content-script injection and `fetch` to pages, not the worker's own outbound WebSocket. (Do keep the server URL in code, not user-editable, for v1.)

---

## Piece 10 — Linking guests to the host's page

**What it is.** Getting every guest onto the same page and the same target element as the host.

**What it needs.** The `setVideo` message (descriptor + frame URL) plus a way to navigate guests.

**Detail.** When the host picks a video, broadcast `setVideo { descriptor, frameUrl }` and also the top-level page URL. On the guest side, the service worker can either:
- **Passive:** show "Host is watching <url> — open it?" and let the guest click (safer, less surprising), or
- **Active:** `chrome.tabs.update(tabId, { url })` to navigate them automatically (smoother, more intrusive).

Once the guest is on the page, their content script resolves `descriptor` in the frame matching `frameUrl` and reports back "resolved" or "not found." Handle "not found" gracefully — it's common on personalized pages (see the honest caveat at the end).

---

## Piece 11 — The sync engine (the actually-hard part)

**What it is.** The logic that makes playback *feel* synchronized despite network latency and clock/decoder drift. This is where naive implementations feel broken.

**What it needs.** Timestamps on every event (`at`), and ideally a clock-offset estimate between each client and the host.

**Detail — two distinct problems:**

**1. Latency compensation (getting the start right).** A `state` message that says "playing, currentTime=42, at=T" arrives some milliseconds later. A guest must not start at 42 — it must start at `42 + (now − T)` (converted to seconds), because that much of the video has elapsed since the host stamped it. To make `(now − T)` meaningful across machines you need the clock offset: do a tiny NTP-style handshake on join (client sends `t0`, server echoes, client measures round-trip and offset), then correct all timestamps by that offset. Without this, everyone is consistently a few hundred ms apart.

**2. Drift correction (staying in sync over time).** Even after a correct start, decoders and clocks diverge over minutes, and buffering drops guests behind. Fix with periodic reconciliation:
- Host emits a `heartbeat { currentTime, at }` every 1–2s **while playing**.
- Each guest computes where it *should* be: `expected = heartbeat.currentTime + (localNow − heartbeat.at + offset)/1000`.
- Compare to `video.currentTime`:
  - **Large gap (> ~1s):** hard-seek. Jarring but necessary.
  - **Small gap (~0.1–1s):** nudge `playbackRate` slightly (e.g. 0.95 or 1.05) to glide back into alignment over a few seconds, then restore 1.0. Much smoother than seeking.
  - **Tiny gap (< ~0.1s):** do nothing; you're synced.

**Free-tier interaction — read this before choosing heartbeat frequency.** Heartbeats keep the Durable Object awake, and an awake object burns compute duration against your 13,000 GB-s/day. A constant 1s heartbeat over a 2-hour movie keeps the object alive the whole time (~900 GB-s per room → roughly a dozen long sessions/day before the free cap). To stretch this:
- Only heartbeat **while playing**; stop during pause so the object hibernates and stops billing duration.
- Consider a slower heartbeat (every 3–5s) and lean more on clients free-running off their local clock between beats. Fewer beats = more idle = more hibernation = less duration billed.
- Event-driven correction (send on play/pause/seek, sparse heartbeats otherwise) is both cheaper and usually good enough for a watch party.

---

## Piece 12 — Hardening and v2

Not needed for a working demo, but the natural next steps:

- **Symmetric control** — let any participant pause. Needs conflict handling (last-writer-wins with timestamps, or explicit "who has the remote").
- **Host handoff** — reassign source-of-truth when the host leaves.
- **Presence/chat** — trivial once the socket exists; just more message types through the same DO.
- **WebRTC** — only if you later want peer-to-peer media or voice; needs the DO as a signaling channel plus STUN/TURN. Not required for control-sync.
- **Reconnection/resume UX** — show "reconnecting…", resync on return.
- **Auth** — room codes are guessable; add a token if rooms should be private.

---

## Suggested build order (fastest path to something real)

1. **Pieces 0–2:** extension that finds and controls a video on the current page (no rooms). Prove you can play/pause/seek from the side panel.
2. **Pieces 5–8:** deploy the Room DO; test the socket with `wscat`, no extension.
3. **Pieces 3, 9:** wire the service worker's socket to the DO; get two browsers into one room exchanging raw `state` messages.
4. **Piece 11 (latency only):** make a guest start at the right time on join.
5. **Piece 11 (drift):** add heartbeats + rate-nudging.
6. **Piece 10 + polish:** guest page-linking, participant count, reconnection.

Get steps 1–4 rock solid before touching drift correction. Most of the "it doesn't work" pain lives in the echo problem (Piece 2), timestamp handling (Piece 11.1), and cross-origin/Shadow-DOM detection (Piece 1).

---

## The honest caveat (design for the clean case first)

"Everyone is on the same page with the same video element" holds cleanly for a **shared static video file** or the **same public YouTube video**. It quietly breaks when the stream is personalized: auth walls, region differences, ad breaks that desync everyone, and DRM-protected players (Netflix, Disney+, etc.). You can often still poke those `<video>` elements, but they personalize per user, fight programmatic control, and controlling them is against their terms of service — don't build your demo on them. Broadcasting the host's URL gets guests to the same *page*, not necessarily the same *playback*. Build and test against a public MP4 or the same YouTube video first; decide later how much of the messy case you actually care about.

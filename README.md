# SSynch

A Chrome extension that syncs `<video>` playback across people watching the same
thing, backed by a Cloudflare Worker + Durable Object on the free plan. Built per
[video-sync-extension-plan.md](video-sync-extension-plan.md).

```
extension/   Chrome MV3 extension (Vite + @crxjs/vite-plugin, plain JS)
server/      Cloudflare Worker + Room Durable Object (wrangler)
```

Both folders have already been `npm install`ed and build successfully. The
Worker's protocol was smoke-tested locally (host connect → `setVideo` →
guest connect → `sync` → `state` → `heartbeat`, all relayed correctly).

## 1. Run the extension locally

```
cd extension
npm run dev
```

This starts Vite in watch mode and writes to `extension/dist`. Load it in Chrome:

1. Go to `chrome://extensions`
2. Enable "Developer mode" (top right)
3. "Load unpacked" → select `extension/dist`
4. Reload the unpacked extension after each change if HMR doesn't pick it up

At this point (Pieces 0-2) you can open the side panel, and — once a room exists —
pick a video and see play/pause/seek detected. The room/sync features need the
server below.

## 2. Stand up the backend

The server needs a Cloudflare account only when you want a public `wss://` URL.
Local development does **not** require an account — `wrangler dev` runs a full
local simulation (Miniflare), which is how this was already verified.

```
cd server
npm run dev          # local only, no login/account needed — http://127.0.0.1:8787
```

When you're ready to get a real `wss://` endpoint reachable from anywhere:

1. Create a free account at https://dash.cloudflare.com/sign-up (no card required for Workers free tier)
2. `npx wrangler login` — opens a browser tab for you to authorize; do this yourself, I won't touch your Cloudflare login
3. `npm run deploy` (runs `wrangler deploy`)
4. Wrangler prints your URL, e.g. `https://ssynch.<your-subdomain>.workers.dev`
5. Open [extension/src/shared/config.js](extension/src/shared/config.js) and set:
   ```js
   export const SERVER_HOST = "ssynch.<your-subdomain>.workers.dev";
   ```
6. `cd extension && npm run build` (or restart `npm run dev`) and reload the unpacked extension

I did not create a Cloudflare account or run `login`/`deploy` — those are yours to
run since they touch your account and publish a live endpoint. Ask if you'd like
me to walk through the actual deploy once you've logged in.

## 3. End-to-end test (two profiles, one machine)

1. Deploy the server (or point both browsers at the same `wrangler dev` host — note
   `wrangler dev` alone won't be reachable from a second machine, only same-machine/profile testing)
2. Open a public MP4 or the same YouTube video in two separate Chrome profiles
3. Profile A: open the side panel → "Create room" → "Select video on this page" → pick the video
4. Profile B: open the side panel → paste the room code → "Join room"
5. Play/pause/seek in Profile A; Profile B should follow within ~1s, and drift-correct via small `playbackRate` nudges during playback

## What's implemented vs. the plan

All 12 pieces are implemented:

- **Detection & picking (Piece 1):** hand-verified selector per major site tried
  first (YouTube `.html5-main-video`, Dailymotion `#video`, Twitch
  `.video-player__container video` — confirmed directly against each site, not
  guessed), then auto-detect ranked by actual on-screen visible area (viewport-clipped,
  `visibility:hidden`/`display:none`/`opacity:0`-aware — not just raw element
  size), manual click-to-pick overlay with sibling-overlay-aware hit search
  (custom players near-universally render their click-catcher/controls as a
  sibling of the `<video>`, not a wrapper — confirmed on Dailymotion),
  shadow-DOM-aware traversal (including a recursive shadow-root-aware
  `MutationObserver` for lazy-loaded videos, needed since a plain observer's
  `subtree:true` doesn't cross shadow boundaries), structural descriptor with
  an `id`-shortcut anchor, duration-based secondary matching when the
  structural descriptor fails, and `MutationObserver` re-detection on SPA swaps.
- **Controller (Piece 2):** play/pause/seek/rate wrapper with the echo guard
  (`isApplyingRemote`) so remote-applied changes don't get rebroadcast as if the
  user drove them.
- **Service worker (Piece 3) + WebSocket client (Piece 9):** room identity
  persisted to `chrome.storage.session`, reconnect with exponential backoff,
  rejoin transparently if the service worker gets evicted mid-room.
- **Side panel (Piece 4):** create/join, pick video, status line, auto-follow toggle.
- **Worker + Room DO (Piece 6):** WebSocket Hibernation API
  (`state.acceptWebSocket`), SQLite-backed storage (`new_sqlite_classes`), no
  in-memory room-state kept across hibernation.
- **Protocol (Piece 7):** `hello/setVideo/state/heartbeat/ping/bye` client→server,
  `sync/state/heartbeat/peers/pong` server→client — see
  [extension/src/shared/protocol.js](extension/src/shared/protocol.js) and
  [server/src/index.js](server/src/index.js). `bye` is sent just before an
  intentional disconnect (leave room, close tab) — `webSocketClose` was
  observed to not fire promptly (sometimes not at all until another message
  arrived) for a plain client-initiated close in local `wrangler dev`, which
  otherwise left peer counts stale for other participants. `ping` is now
  sent *before* `hello` on connect, not after — a guest's `sync` reply
  carries the host's current position, latency-compensated using the clock
  offset sampled from `ping`'s reply; sending hello first meant that initial
  position was usually applied with an uncalibrated (zero) offset, landing
  slightly off and then visibly self-correcting a moment later once a
  heartbeat caught it.
- **Guest linking (Piece 10):** passive by default ("host is watching X, open it?"
  button in the side panel), optional auto-follow toggle for `chrome.tabs.update`.
  `pageUrl` is derived from `sender.tab.url` (the tabs API), not the picking
  frame's own `location.href` — the picked `<video>` can live in a non-top,
  even cross-origin, iframe (confirmed on Dailymotion: the player is on
  `geo.dailymotion.com`, a different origin from the page itself), which
  can't always safely report the top page's URL itself.
- **Joining mid-playback:** a joining guest is landed at the host's actual
  position (via the `sync` message's `play`/`currentTime`/`at`, latency-compensated
  the same way as regular `state` updates) *before* it's allowed to report
  anything of its own. Without this gate, the guest's freshly-loaded,
  not-yet-synced video doing whatever it naturally does on load (autoplay
  from 0:00, or just its default paused state) would get broadcast as a real
  action under symmetric control and reset everyone else's position.
- **Sync engine (Piece 11):** clock-offset handshake (ping/pong measured by the
  service worker, forwarded once to the content script), latency-compensated
  start position, and heartbeat-driven drift correction (hard-seek past 1s,
  rate-nudge between 0.1-1s, hold under 0.1s). Heartbeats only fire while
  playing, both to save the free-tier compute budget and because there's
  nothing to correct while paused.
- **Symmetric control:** any connected peer — host or guest — can play/pause/seek;
  the server relays `state`/`heartbeat` from anyone (see [server/src/index.js](server/src/index.js)),
  and last-writer-wins naturally via the existing timestamp/broadcast ordering —
  no separate conflict resolution needed. Picking *which* video the room
  watches stays host-exclusive (`setVideo`/`clearVideo` are still gated).
- **Robustness (options 1-3):** guest resolution falls back to best-effort
  auto-detect when the structural descriptor fails to match, and retries over
  ~2.6s to cover late-hydrating SPAs, instead of one attempt and giving up
  (see the `setDescriptor` handler in [content.js](extension/src/content.js)).
  If a `<video>` still isn't there after that (browse -> details page ->
  press play sites — Netflix and most streaming-site clones, e.g. cineby.at —
  don't mount one at all until a real person clicks play), it keeps watching
  indefinitely instead of giving up, using the same shadow-DOM-aware
  `observeDeep` mechanism as `watchForReplacement`, cancelled the moment it
  succeeds or a new descriptor arrives. The side panel/overlay show "No video
  on the page yet — press play here" during this wait so it doesn't look stuck.
  `AdGuard` (in [sync-engine.js](extension/src/content/sync-engine.js)) detects
  a likely ad break via `video.duration` swinging away from its established
  baseline and suppresses state/heartbeat broadcast until it reverts — each
  viewer's ad is independently served/timed, so relaying playback position
  during one would seek everyone else into a meaningless spot.
- **Hardening/v2 (Piece 12):** host handoff, presence/chat, WebRTC, and room
  auth are still open per the plan — symmetric control (above) has been pulled forward.

## Known limitations (inherent to the approach, not bugs)

- Personalized/DRM streams (Netflix, Disney+, etc.) will not sync reliably and
  controlling them may violate their terms — test against a public MP4 or a
  shared public YouTube video first, per the plan's honest caveat.
- Cross-origin iframes can't be reached directly from the parent frame; the
  content script runs inside each frame independently and coordinates through
  the service worker.
- **Two distinct reasons "Select video on this page" can fail to find anything**,
  both confirmed directly on Dailymotion and both now handled:
  1. A cookie-consent/ad/paywall overlay iframe sitting on top of the real
     player (`elementFromPoint` over the whole player area hit a Sourcepoint
     consent iframe, not the player). Pick mode shows a hint banner for this —
     deliberately *not* auto-dismissed, since that would mean making a
     privacy/consent decision on the user's behalf.
  2. **Fixed in code**: custom players near-universally render their own
     click-catcher/controls layer as a *sibling* of the `<video>` (both
     inside a shared "player" container), not a wrapper around it — clicking
     anywhere on the visible player hits that sibling, never the video.
     `findNearestVideo` (in [element-picker.js](extension/src/content/element-picker.js))
     now searches each ancestor's subtree while walking up (capped at 8
     levels), not just the originally-clicked element's — verified directly
     against Dailymotion's real `div.vod_click`/`div.controls_layer_1`
     structure. This pattern is common enough (JW Player, Video.js, Vimeo,
     Twitch's own player) that it likely explains most of the "50/50
     depending on site" pattern beyond just Dailymotion.
- `host_permissions: ["<all_urls>"]` triggers Chrome's broad-access install
  warning — unavoidable for a "works on any page" extension.
- The video descriptor is structural (`nth-of-type` position, piercing shadow
  roots) — if the host's and guest's copies of the page differ even slightly
  (different ad slot, cookie banner, A/B test, logged-in vs logged-out state),
  the sibling index can silently point at the wrong element, or nothing at
  all. This is the most likely reason resolution fails on real-world sites;
  it isn't a bug to fix so much as a ceiling on the structural-matching
  approach — pages with more stable per-video `id`/`data-*` attributes
  resolve more reliably (see the anchor shortcut in `computeDescriptor`).
- SPA sites (YouTube's "up next"/suggested video) reuse the same `<video>`
  element across video changes instead of replacing it. Detected via the
  `loadstart` event (see `VideoController.onSourceChanged` in
  [video-controller.js](extension/src/content/video-controller.js)) — a
  heuristic, not a guarantee, since it depends on the site actually firing
  `loadstart` when swapping sources on the same element.
- `AdGuard`'s ad detection is duration-based, not a guarantee: legitimate
  content with a genuinely fluctuating reported duration (some live streams)
  will look like a permanent ad and have its state/heartbeat suppressed.
- The auto-detect fallback (option 1 above) picks the largest visible loaded
  video when the structural descriptor fails — usually right on simple pages,
  but on pages with multiple real videos it can pick the wrong one. The side
  panel flags this ("best-effort match") so it's visible when it happens.

## Nice-to-have (not blocking v1)

- When a guest clicks "Open host's page" while the host is paused, the
  destination page (e.g. YouTube) can autoplay on load before any `state`
  message arrives to correct it. Possible fix: have the guest's tab start
  muted/paused by default until the first real `state`/`sync` is applied.

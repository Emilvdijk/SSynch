# Decisions

Why things are built the way they are, not what the code does line-by-line (that's what
the inline comments and README are for). Read this before making changes so you don't
re-derive settled reasoning from scratch or reintroduce a bug that was already fixed on
purpose. Add to it — or ask whether to — per the instructions in CLAUDE.md.

Dates are commit dates, oldest reasoning first within each section.

## Architecture

- **Chrome extension (MV3) + one Cloudflare Worker with a Durable Object per room.**
  The DO uses the WebSocket Hibernation API specifically so an idle room (paused, or
  nobody talking) doesn't burn compute duration against the free tier's daily cap —
  see the comment at the top of `server/src/index.js`.
- Room state (`descriptor`/`frameUrl`/`pageUrl`/`duration`/`className`/`play`/`currentTime`/
  `rate`/`at`) is persisted in the DO's SQLite-backed storage so a freshly (re)connecting
  guest gets `sync`'d immediately. Heartbeats are deliberately **not** persisted (see below).

## Authority model: what's symmetric vs. host-only

- `state` (play/pause/seek) is **symmetric** — either host or guest may send it, and the
  Durable Object just broadcasts whoever's message it processes last (last-writer-wins,
  no extra conflict resolution). This was a deliberate choice (task #13) so either side
  can pause for a bathroom break, etc.
- `setVideo`/`clearVideo` are **host-only**, gated by `isHost(ws)` in `server/src/index.js`.
  A guest picking a different video on their own page shouldn't redirect the whole room.
- `heartbeat` was originally symmetric like `state`, but was made **host-only on
  2026-07-21** ("Make drift-correction heartbeats host-only"). Heartbeats drive continuous
  drift correction (`reconcileDrift`), which runs every ~2s while playing — a guest's own
  stall/lag being treated as ground truth would drag the host (and every other guest) off
  a correctly-synced position. This was the user's own architectural instinct, confirmed
  by a live `wrangler dev` WebSocket test before shipping.
  **If this ever looks like an inconsistency with `state` being symmetric, it isn't — don't
  "fix" it back to symmetric.**
  Side effect: since the host no longer *receives* heartbeats, `background.js`'s clock-offset
  refresh (`maybeRefreshPingOffset`) had to be called from the outgoing heartbeat-send path
  too, not just the incoming handler, or the host's own clock offset would go stale.
- Not persisting heartbeats keeps a playing room cheap to store; a client that reconnects
  mid-playback gets the last saved `state` and re-derives position from that instead.

## Drift correction & latency compensation (`extension/src/content/sync-engine.js`)

- Clock offset is estimated once via a `ping`/`pong` round trip (`ClockOffset`), so a
  server timestamp (`at`) can be turned into "how many seconds have elapsed, locally."
- `reconcileDrift` thresholds: hard seek if the gap is `> 1.0s` (`LARGE_GAP_SECONDS`),
  rate-nudge (1.05x/0.95x) between `0.1s`–`1.0s` (`SMALL_GAP_SECONDS`), hold (reset rate to
  1.0x) if `<= 0.1s`. These were kept as-is when heartbeats went host-only — the "choppy
  every-2-seconds correction" complaint that prompted that investigation turned out to be
  a symptom of *who* was authoritative, not these thresholds, so don't assume they're
  still worth revisiting without a fresh, specific complaint.
- The Durable Object's `ping` handler also re-broadcasts peer count on every ping (not
  just on `hello`/`bye`/close). This is a cheap self-healing safety net: pings recur
  periodically regardless of playback state, bounding how long a stale peer count from a
  missed/delayed `webSocketClose` (observed to sometimes lag in local `wrangler dev`) can
  persist.
- `AdGuard` (same file) detects a likely ad break via `video.duration` swapping to a
  different value rather than site-specific DOM sniffing, since each viewer's ad is
  independently served/timed and relaying position during one is actively wrong. Requires
  2 stable confirmations (`AD_STABLE_CONFIRMATIONS`) within `2s` tolerance
  (`AD_DURATION_TOLERANCE_S`) before adopting a new baseline, so a one-off blip doesn't
  get treated as a permanent ad state. Known false-positive risk: legitimate content with
  a fluctuating reported duration (some live streams) will look like a permanent ad —
  not fixed, just a known tradeoff.

## Echo guard, seek guard, pause enforcement (`extension/src/content/video-controller.js`)

- `ECHO_GUARD_MS = 50` suppresses locally-caused `play`/`pause`/`ratechange` events for a
  short fixed window right after we apply a remote change, so applying it doesn't get
  misreported back to the server as a user-driven action.
- A fixed timer doesn't work for seeks: seeks can take arbitrarily long on unbuffered/slow
  sites, so a guest's *real* `seeked` event arriving after a short fixed guard would get
  reported and rebroadcast — this was the root cause of the **host visibly jumping when a
  guest joined mid-playback** (fixed 2026-07-14). The fix is event-driven: `_armSeekGuard`
  waits for the actual `seeked` event (matching the target position within 0.5s) instead
  of a timer, capped by `SEEK_GUARD_MAX_MS = 8000` in case it never fires.
- `PAUSE_ENFORCE_MS = 600`: some custom players (confirmed on cineby.at) fight an
  externally-applied `.pause()` by immediately resuming themselves. `_enforcePause()`
  re-asserts `.pause()` on any `play` event for 600ms after a remote pause. Guarded so a
  subsequent *legitimate* remote `play: true` clears pending enforcement first — otherwise
  a real "host pressed play" would get fought by our own enforcement.

## Video identification & matching (`content.js`, `video-detector.js`, `element-picker.js`)

- Videos are matched across independent DOM copies (host vs. guest) via a structural
  descriptor (`nth-of-type` path + `id` anchor), with `duration` and `className` riding
  along as optional secondary signals for when the descriptor fails to resolve or
  resolves ambiguously.
- Pages can have multiple `<video>` candidates, including decoys — confirmed real-world
  case: a `<video class="player-html5"><source src=""></video>` that never hydrates.
  Candidates are filtered to `visibleArea(v) > 0 && (v.readyState > 0 || v.currentSrc)`
  first, then disambiguated by className match against the host's hint or an
  unmuted-over-muted preference, then by geometric closest-to-reference as a last resort
  (fixed 2026-07-14, "Improve video match accuracy on pages with several candidate videos").
- "Browse → details page → press play" sites (Netflix-style, e.g. cineby.at) have no
  `<video>` until the guest manually presses play. Instead of giving up after a few quick
  retries (`RESOLVE_RETRY_DELAYS_MS = [300, 800, 1500]`), unresolved descriptors fall
  through to an **indefinite** `MutationObserver`-based watch (`observeDeep`, shadow-DOM
  aware) that keeps looking until the video appears or the pending resolve is explicitly
  cancelled. This is intentionally generic (not site-specific selectors).

## Recovery: losing the video is never terminal (2026-08-01)

Diagnosed after a real 2-hour session where the host lost control while guests
carried on controlling each other. Root cause was an asymmetry, not a single bug:
`contentScriptReady` was gated to `Role.GUEST`, so a guest whose frame reloaded
re-resolved and re-attached automatically, while a host in the same situation came up
with `controller === null` and **nothing ever called `attach()` again**. Host `videoLost`
made it worse by clearing the descriptor — the one thing needed to re-resolve — so the
host was out of its own room permanently, recoverable only by a manual re-pick.

- `contentScriptReady` now re-resolves for **either** role.
- `videoLost` now attempts a re-resolve of the same descriptor first (content.js already
  retries briefly and then watches indefinitely), and only falls through to clearing when
  there's genuinely nothing left to recover against. A host actually navigating away or
  closing the tab is still handled by the `tabs.onUpdated`/`onRemoved` listeners, which do
  clear — that's what keeps this from leaving guests pointed at a dead page.
- `setDescriptor` therefore carries `asHost`. A host re-attaching must **not** apply
  `initialState`: it's the authority, so the room's last remembered position is just a
  staler copy of where it already is, and applying it would seek the host backwards and
  echo that seek to everyone.
- The `resolved` handler now refreshes `session.frameId` from `sender.frameId`. Frame IDs
  aren't stable across frame reloads, so the one captured at pick time went stale the
  moment an embedded player reloaded itself, after which every `applyState`/`applyHeartbeat`
  was addressed to a frame that no longer existed and silently went nowhere.
- Guests get the same `videoLost` recovery. A guest whose page genuinely *navigated* sends
  `videoLost` with `navigated: true` so background.js skips the pointless re-resolve.

The general principle worth keeping: **every path that can drop the local `controller` needs
a way back.** Nothing in this system re-attaches on its own.

## The overlay has to survive fullscreen (2026-08-01)

While fullscreen is active the browser paints only the fullscreen element's subtree, so an
overlay parked on `<html>` disappears — and the side panel can't be open either. That means
the app's *only* two status surfaces both vanish exactly when a silent failure is most
likely and least noticeable. The 2-hour breakage above went unnoticed for a long time for
precisely this reason.

Fixed by promoting the overlay's shadow host into the **top layer** (`popover="manual"` +
`showPopover()`) while fullscreen is active, rather than re-parenting it into the fullscreen
element. Re-parenting doesn't generalise: players fullscreen a bare `<video>` or a
cross-origin `<iframe>` about as often as a container div, and neither renders child content.

- The `popover` attribute is added only while fullscreen and removed after, so windowed
  behaviour is untouched — in particular the UA's `[popover]:not(:popover-open){display:none}`
  never gets a chance to hide the overlay.
- If `showPopover()` throws (no support), the attribute is backed out for the same reason.
- `:host { all: initial }` already neutralises the UA popover styles (`inset: 0`, `margin`,
  `border`, `padding`, `background`, `overflow`); the inline `top/left: auto` is belt-and-braces.
  Verified live: host/card rects are byte-identical before, during and after promotion, and
  `elementFromPoint` confirms the overlay beats a `position:fixed; z-index:2147483647` rival
  only while the popover is open. Real fullscreen could not be exercised in the embedded
  browser pane (`requestFullscreen` → "Permissions check failed"), so the top-layer-above-
  fullscreen step itself rests on the spec, not on a local observation.

## Keeping a paused room alive (2026-08-01)

Third fix from the same 2-hour-session diagnosis. A paused room produced **zero** traffic
on either leg — heartbeats stop on pause, and `maybeRefreshPingOffset` is reachable only
from heartbeat paths — so the service worker was evicted (~30s idle) and the WebSocket
idle-dropped, with nothing left in existence to ever wake either one. The only thing that
had been preventing this was an accident: the side panel's 2s status poll. That's absent
whenever the panel is closed, which includes all of fullscreen.

Three changes, deliberately kept separate because they fail independently:

1. **`chrome.alarms` keepalive** (`alarms` permission added). Alarms are owned by the
   browser, not the worker, so one survives the eviction it exists to recover from. On each
   fire: reconnect if the socket is down, otherwise ping (which both prevents an idle drop
   and refreshes the clock offset — otherwise impossible while paused). `ensureKeepalive`
   checks `alarms.get` first because re-creating an existing alarm resets its schedule, so a
   frequently-restarting worker would keep pushing the next fire out and never tick.
   **This does not keep the worker continuously alive and cannot**: a WebSocket can't outlive
   the worker that owns it, and a 30s alarm against a 30s idle timeout is a race, not a
   heartbeat. What it buys is bounded recovery (~30s) instead of an indefinite dead room.
   Don't "fix" it later by assuming it was meant to hold the connection open.
2. **Handlers gate on a `ready` promise, not on `session` being non-null.** `loadSession()`
   is async, and the event that wakes an evicted worker is by definition the first to
   arrive — so `if (!session) return;` dropped exactly the message that mattered. Listener
   *registration* stays synchronous at top level (MV3 requires it); only the bodies defer.
3. **The host re-asserts its own state on reconnect** via a `reportState` command to the
   content script. Nothing else did: `hello` replies with `sync` only to guests, so a
   reconnecting host came back believing it was in sync while the room still held pre-drop
   state. Asked of the content script live rather than replayed from a cached value on
   purpose — a remembered position with an old `at` gets latency-compensated *forward* by
   the length of the gap, which is precisely how a peer ends up seeked past the end.

Note the deliberate asymmetry in 3: the host should never *receive* `sync` on reconnect.
That would seek it to the room's remembered position — the same failure the `asHost` flag
above exists to prevent. The host pushes; it doesn't pull.

## `frameUrl` vs `pageUrl`

- `pageUrl` is the top-level tab URL; `frameUrl` is the specific frame's own location —
  needed because the actual `<video>` can live in a cross-origin iframe (e.g. Dailymotion
  embeds).
- Bug (fixed 2026-07-14): `frameUrl` was captured once (`const frameUrl = location.href`)
  at content-script injection time and never refreshed, so after a same-page SPA
  navigation (YouTube clicking a suggested video) it pointed at the old URL and guest
  resolution broke. Both the SPA re-announce path and the manual re-pick path now read
  the live URL (`lastKnownHref` / fresh `location.href`) at send time — **never cache
  `location.href` in a variable that outlives a single synchronous call** in content
  scripts that might run on an SPA.

## Overlay UI (`extension/src/content/overlay.js`)

- Draggable, position persisted globally (not per-site) in `chrome.storage.local` under
  `ssynchOverlayPosition` — added 2026-07-15 because the fixed bottom-right position
  sometimes covers page content the user wants to see.
- Click vs. drag is disambiguated by movement distance: `DRAG_THRESHOLD_PX = 4`. The
  entire top strip of the card (not just the title row's own content box) and the
  collapsed pill are both draggable. Making the *full* strip draggable (not just the
  title text) required a negative-margin/matching-padding trick that also needs an
  explicit `width` matching the parent card — omitting it silently shrinks the row's
  content width. Verified by measuring `getBoundingClientRect()` in a sandbox page before
  shipping, not just by reading the CSS.
- Both `setPointerCapture`/`releasePointerCapture` calls are wrapped in `try {} catch {}`
  — confirmed via live testing that these can throw (`InvalidPointerId`) in edge cases,
  and an uncaught throw here was silently breaking the pill's click-to-expand path.
- Card/pill background is `rgba(18, 18, 22, 0.78)` with `blur(4px)` (explicit
  user-specified values, was `0.88`/`10px` before 2026-07-14).
- **The collapsed pill's play arrow is an inline `<svg>`, not the `▶` character**
  (2026-08-01). Flex centering centers a glyph's *box*; where the ink sits inside that
  box is up to the font, and which font resolves inside the shadow root depends on the
  host page — so `▶` rendered visibly low and left, differently in different places.
  The inline triangle is centered by construction and can't drift. It is placed slightly
  right of where the glyph appeared but slightly *left* of its own bounding-box center,
  the same optical rule the extension icon uses: a right-pointing triangle carries its
  mass at the blunt end, so box-centering reads as shifted right. **Don't "simplify" it
  back to a text glyph.**

## Known, diagnosed, unfixed issues

- **A paused peer can still miss up to ~30s.** The keepalive alarm bounds recovery, it
  doesn't eliminate the gap (see above for why it can't). Both roles do self-heal once
  reconnected — guests via `hello` → `sync`, the host via `reportState` — so this is a
  delay, not a stuck state. Reaching for an offscreen document would close it properly, at
  meaningfully more weight; not worth it unless the 30s floor proves too coarse in practice.
- **`session.lastKnownState` goes stale by hours.** It's only ever written from a `SYNC`
  message; the `STATE` handler forwards to the tab without updating it, and heartbeats
  aren't persisted server-side. `compensatedTime` then does `currentTime + elapsed` with no
  clamp, so a late joiner (or a guest re-resolving after a reload) two hours into a room can
  be seeked ~7200s past the end. The host side of this is covered by `reportState`; the
  guest side is not. A clamp in `compensatedTime` is probably the cheap half of the fix.
- **`AdGuard` barely works, and can swallow real actions.** `AD_STABLE_CONFIRMATIONS = 2`
  against a 2s heartbeat means an ad is only suppressed for ~4s before its duration is
  adopted as the new baseline — and then the *real* content is flagged for another ~4s when
  it returns. Meanwhile `check()` mutates shared pending state from two call sites
  (`reportLocalState` and the heartbeat), so a play/pause landing during a duration blip is
  dropped silently, with no feedback anywhere.
- **Guest stops auto-following after being idle long enough.** Same MV3 eviction family as
  the keepalive work above, and *probably* fixed as a side effect of the alarm — but that
  was never reproduced or re-verified after the change, so treat it as open until someone
  actually checks.

## Icons (2026-08-01)

- **Two source SVGs, not one.** `extension/assets/icon.svg` drives 48/128;
  `extension/assets/icon-small.svg` drives 16/32. This looks like duplication and isn't:
  the detailed geometry (13/128 stroke, 40° gaps between the two sync arcs) rasterises to
  a solid blue disc at 16px — the gaps close under antialiasing and the arrowheads vanish
  entirely, which is exactly the part that distinguishes this from a generic play button.
  The small variant uses a 16/128 stroke, 56° gaps, and a triangle sized to nearly fill
  the ring's bore, because a smaller triangle antialiases to a grey smudge rather than a
  white arrow. Both were checked by rasterising and inspecting at 16× nearest-neighbour
  zoom, not by eyeballing the vector. **Don't consolidate them into one file** without
  redoing that check.
- **The PNGs are committed; there is no icon build step.** They were rasterised once by
  loading each SVG in a browser and drawing it to a canvas — no `sharp`/`resvg` dependency
  was added for something that regenerates roughly never, and none of `magick`,
  `inkscape`, or `rsvg-convert` exists on this machine anyway. Each size is rasterised at
  its own intrinsic size (the SVG's `width`/`height` are rewritten per size) rather than
  downscaled from one big bitmap, which is why the small sizes stay crisp.
- Runtime icons live in `extension/public/icons/` so vite copies them to `dist/icons/`;
  the manifest paths are therefore dist-relative. `assets/` is deliberately *outside*
  `public/` so the SVG sources and the store-listing icon don't get shipped in the
  packaged extension.
- `assets/store-icon-128.png` is the Web Store listing icon and is a different crop on
  purpose: the same art at 96×96 centred in a 128×128 canvas with transparent padding,
  which is what the Store dashboard expects. The manifest's 128 is full-bleed.
- **Burnt amber arrows on a circular dark disc, not blue on a rounded square** — the
  user's call, on the grounds that the square tile read as dull. The amber deliberately
  does *not* match the side panel's `#4f8cff` accent; the icon is the only place the
  extension is seen next to other extensions' icons, so standing out beats matching the
  UI. The disc is full-bleed (`r=64`) with transparent corners, which also means the icon
  carries no visible edge against a dark Chrome toolbar — that's intended, not a
  rendering bug.
- **The palette is deliberately dark and low-glare** (`#c07a35 → #94500e` arrows, `#e6ded4`
  triangle rather than `#ffffff`): this gets used in a darkened room next to a playing
  video, so a bright icon is actively unpleasant. Chosen from a rendered four-way
  comparison, one step brighter than the darkest option that still held its shape at 16px.
  **Don't "improve contrast" by brightening it** — the dimness is the requirement, and the
  16px legibility ceiling was already tested at the chosen value.

## Room state expires after 24 hours (2026-08-01)

- Saved room state used to live forever. It exists for exactly one reason — so a
  late joiner or a client reconnecting after a dropped connection lands at the right
  place in the right video — and that stops being useful long before a day is out.
  Keeping it indefinitely meant the last page a room watched stayed on disk under a
  guessable six-character code, a privacy cost with no matching benefit. `ROOM_TTL_MS`
  in `server/src/index.js` is now 24h, re-armed on every `saveState()` so the countdown
  measures time since last *use*, not since creation.
- **The DO alarm re-arms instead of deleting when peers are still connected.** This
  isn't belt-and-braces, it's load-bearing: heartbeats are deliberately not persisted
  (see the authority-model section), so a room paused for a day with everyone still
  watching writes nothing at all and would otherwise expire out from under them.
- **`alarm()` re-creates the table after `deleteAll()`.** `deleteAll()` drops the `kv`
  table, and the DO can stay in memory to serve the next connection on that room code —
  without `ensureSchema()` the next `saveState()` throws on a missing table. Both this
  and the point above are covered by the live test described below; neither is
  reachable by reading the code alone.
- Verified against `wrangler dev` with `ROOM_TTL_MS` temporarily set to 3s, covering
  four cases: expired room serves no stale state, live room still resumes a late joiner,
  occupied-but-idle room survives its window, and a room code is reusable after expiry.
  **If you change the expiry logic, re-run that** — the test lives only in the session
  scratchpad, so re-create it from these four cases rather than trusting a read-through.
- `PRIVACY.md` states the 24 hours as a promise to users, so the constant and the policy
  have to move together. The promise is only true where the Worker is actually deployed.

## Deployment

- Cloudflare Worker is deployed (`ssynch.emilvdijk.workers.dev`); `SERVER_HOST` in
  `extension/src/shared/config.js` points at it.
- Deploying requires a Cloudflare account, login, and a claimed `workers.dev` subdomain —
  **these steps are the user's own job, never done autonomously**, even though `wrangler
  deploy` itself can be run as a regular command once the account exists.
- Windows' `curl`/Schannel can't do the post-quantum TLS key exchange Cloudflare's edge
  negotiates — this shows up as a curl TLS failure that has nothing to do with the
  server. Verify deployed endpoints with Node's native `fetch`/`WebSocket` instead.

## Verification methodology

- Server/protocol changes (host-gating, message shape) are verified live against a
  temporarily-started `wrangler dev` with a raw WebSocket test script, not just by
  reading the code — this is how the heartbeat host-gate and the peer-count self-heal
  were confirmed.
- UI interaction logic (drag, click-vs-drag, pointer capture) is verified with a small
  sandbox HTML page driven by synthetic `PointerEvent`s, served via a temporary local
  Node HTTP server (the Browser tool's `file://` navigation is denied). This caught both
  the CSS box-model miscalculation and the `InvalidPointerId` throw — code review alone
  missed both.
- Unit tests live in `extension/test/*.test.js`, run via Node's built-in test runner
  (`npm test` → `node --test`), not vitest/jest. Keep the suite green after every change;
  `npx vite build` should also be run clean after source changes.

## Working conventions

- Only commit and/or push when explicitly asked — every time, not just once per session.
- Ask before implementing a design/architecture change rather than silently picking one;
  several of the decisions above (host-only heartbeats, the blur values, drag hit-area
  scope) came from the user's own explicit direction, not autonomous judgment calls.
- Avoid blanket/broad destructive actions when a targeted one is available (e.g. killing
  a specific test-server PID, not `Stop-Process -Name node -Force` which kills every node
  process on the machine).

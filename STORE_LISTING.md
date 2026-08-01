# Chrome Web Store listing copy

Paste-ready answers for the Web Store dashboard. Keep this in sync with the
manifest — a justification that describes a permission the code no longer uses
(or omits one it does) is worse than no justification.

Every claim below was checked against the code on 1 August 2026. If you change
what the extension sends or stores, update this file **and** `PRIVACY.md`.

---

## Single purpose

> SSynch keeps video playback in sync between several people watching the same
> page in different browsers. One person creates a room and picks a video; the
> others join with the room code and their player follows along — play, pause,
> seek, and continuous correction for the drift that accumulates between
> browsers over a long video.

## Permission justifications

Reviewers want each one tied to a specific user-visible feature, in a couple of
sentences. Longer is not better.

### `host_permissions: <all_urls>`

> The people using SSynch choose what to watch together, and that list cannot be
> known in advance — it might be a major streaming service, a self-hosted video
> file, a university lecture page, or a small site nobody has heard of.
> Restricting the extension to a fixed list of hosts would mean it simply does
> not work for whatever the group actually picked.
>
> The content script attaches to the single `<video>` element the host
> explicitly selects, and reads only what it needs to find that same element in
> the other participants' browsers: the element's position in the page
> structure, its id and class names, and its duration. It does not read page
> text, form fields, cookies, or credentials, and it transmits nothing at all
> unless the user is in a room.

### `tabs`

> SSynch ties one specific tab to the room. It needs the tab API to open the
> host's page in a guest's tab when they join, to notice when the host navigates
> away from the shared video so guests are not left following a dead page, and
> to treat closing that tab as leaving the room. This requires the tab's id and
> current address; no other tab is read.

### `storage`

> Stores the current room code, the user's role, and which tab is following the
> room, so that a synced session survives Chrome suspending the extension's
> background service worker mid-video. Also stores the position the user dragged
> the on-screen sync widget to, so it stays out of the way of the player's own
> controls. No browsing data is stored.

### `alarms`

> A paused room generates no network traffic, so Chrome suspends the extension's
> service worker and the connection to the sync server is lost — the user's
> player silently stops following the host, with no error and no way back
> without rejoining. A periodic alarm is the only mechanism that can wake a
> suspended MV3 service worker, and SSynch uses one solely to re-establish that
> connection. It contacts only the extension's own sync server and reads no user
> data.

### `sidePanel`

> The extension's main interface — create a room, join with a code, see how many
> people are connected, leave — is a side panel. This permission is required by
> the `side_panel` manifest key that registers it.

### `scripting` — removed

> Was declared but never called; the content script is registered declaratively
> in the manifest, which does not require it. Dropped on 1 August 2026, so there
> is nothing to justify. If it ever comes back, it needs an entry here.

## Remote code

**No.** All JavaScript is bundled into the uploaded package by vite. The
extension loads no remote scripts, uses no `eval`, and pulls no code from a CDN.
Its only network traffic is a WebSocket to its own sync server.

## Data usage disclosures

Answer the dashboard's checkboxes as follows.

**Collected:**

- **Website content** — the address of the page the host shares, and the id,
  class names, duration, and structural position of the chosen `<video>`
  element. Disclose this; it is page-derived data leaving the browser.
- **Web history** — borderline but disclose it. SSynch transmits only the one
  page address the host deliberately shares with the room, not a browsing
  history, and the listing description should say so plainly. Under-disclosing a
  URL that leaves the browser is the expensive mistake here.

**Not collected:** personally identifiable information, health information,
financial and payment information, authentication information, personal
communications, location, user activity (keystrokes, clicks, mouse position),
and website content beyond the above.

The peer labels sent to the server are the hard-coded strings `"Host"` and
`"Guest"`. There is no field anywhere in the UI to enter a name, so no
user-supplied identifier exists to collect.

**Certifications** (all three are true as written):

- Data is not sold or transferred to third parties outside approved use cases.
- Data is not used or transferred for purposes unrelated to the item's single purpose.
- Data is not used or transferred to determine creditworthiness or for lending purposes.

## Privacy policy URL

Required, because the answers above declare data collection. Host `PRIVACY.md`
at a stable public address and paste that address into the dashboard — GitHub
Pages on this repo is the least-effort option that gives a real URL.

## Short description

The dashboard's summary field. Hard limit 132 characters; this is 106.

> Watch videos together in sync. Create a room, share the code, and everyone's
> player follows — on any site.

## Detailed description

Every claim below is one the extension actually delivers — the drift-correction
and reconnect behaviour especially. Don't add capabilities here that aren't in
the code; a listing that oversells is both a review risk and a refund magnet.

> **Watch together, actually in sync.**
>
> Starting a film "on three" never works. Someone's stream buffers, someone
> pauses to get the door, and twenty minutes later everyone is a different
> distance into the same film.
>
> SSynch keeps every player on the same moment. One person creates a room and
> picks the video; everyone else joins with a six-character code, and their
> player follows.
>
> **How it works**
>
> 1. Click the SSynch icon and hit Create room.
> 2. Share the six-character code with whoever is watching.
> 3. Open your video and hit "Select video on this page". Everyone else's
>    browser opens the same page and locks onto the same video.
> 4. Watch. Play, pause and seek from any side — it applies to everyone.
>
> **What it does**
>
> ▸ **Works on any site.** SSynch attaches to the video player itself rather
> than to a hard-coded list of streaming services, so it behaves the same on a
> big streaming service, a self-hosted file, or a lecture recording.
>
> ▸ **Corrects drift as it goes.** No two browsers play at exactly the same
> speed. Rather than only syncing when somebody clicks something, SSynch keeps
> comparing positions and correcting — an imperceptible speed nudge for a small
> gap, a seek for a large one — so you don't quietly drift apart over a
> two-hour film.
>
> ▸ **Accounts for lag.** Playback positions are corrected for the round-trip
> delay to the server, so joining late or jumping to a new scene doesn't leave
> you a second behind everyone else.
>
> ▸ **Anyone can control it.** Pause to get the door, rewind for the line
> nobody caught — every participant can, not just whoever started the room.
>
> ▸ **Stays out of the way.** A small widget shows who's connected and whether
> you're in sync. Drag it anywhere, collapse it to a single button, and it
> stays visible in fullscreen.
>
> ▸ **Survives real life.** It reconnects on its own after a dropped
> connection, a page reload, or a long pause, and re-finds the video if the
> player rebuilds itself mid-session.
>
> ▸ **Nothing to sign up for.** No account, no email, no profile. Generate a
> code and go.
>
> **What you'll need**
>
> Everyone needs SSynch installed, and everyone needs their own access to
> whatever you're watching. SSynch synchronises playback — it does not stream,
> share, or re-broadcast video. If a site needs a subscription, each person
> still needs their own.
>
> It works with standard HTML5 video players, which covers most of the web.
> Some heavily customised players behave differently, and sites that block
> extensions outright won't work.
>
> **Privacy**
>
> No accounts, no analytics, no tracking, no third parties. To keep a room in
> sync, SSynch sends the address of the page the host shares, a description of
> which video element to control, and the playback position. That's the whole
> list — no page content, and nothing about any other page you visit. Room data
> is deleted 24 hours after a room was last used. Full policy linked below.

## Assets

| Asset | Status |
|---|---|
| Icon, 128×128 | `extension/assets/store-icon-128.png` |
| Screenshot, 1280×800 | `extension/assets/store-screenshot-1280x800.png` |
| Small promo tile, 440×280 | Optional; only needed for homepage promotion. |

The screenshot is drawn from `extension/assets/store-screenshot.svg`, not captured
from a running browser — the overlay in it is redrawn at 2× from the real values in
`overlay.js` (the same `rgba(18,18,22,0.78)` card, `#34d399` dot, `#f0806a` leave
button). **If the overlay's styling changes, that SVG goes stale silently.** Re-render
it by serving the SVG over HTTP and drawing it to a 1280×800 canvas; loading it from
`file://` does not work, because the preview pane sandboxes local files with
`script-src 'none'`.

## Before submitting

- [x] Remove `scripting` from `permissions` and rebuild.
- [x] Add expiry to stored room state — 24 hours, see `DECISIONS.md`.
- [ ] Deploy the server before submitting: the 24-hour expiry `PRIVACY.md`
      promises only exists in the deployed Worker once you `wrangler deploy`.
- [ ] Bump `version` in `extension/package.json`; `0.1.0` is what the manifest
      inherits and every Web Store upload needs a higher one than the last.
- [ ] Host `PRIVACY.md` and have the URL ready.
- [x] Take at least one screenshot.
- [ ] Expect a slow review. `<all_urls>` puts an extension into manual review.

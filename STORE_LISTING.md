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

## Store listing description

> **Watch videos together, actually in sync.**
>
> One person creates a room and picks the video. Everyone else joins with the
> room code, and their player follows along — play, pause, and seek from any
> side, with continuous correction for the drift that builds up between browsers
> over a two-hour film.
>
> - **Works on any site.** SSynch attaches to the video element itself rather
>   than to a hard-coded list of streaming services.
> - **Nothing to sign up for.** No account, no email, no profile. Share a
>   six-character code and start.
> - **Stays out of the way.** A small draggable widget shows who is connected
>   and whether you are in sync. Collapse it to a single button, and it stays
>   visible in fullscreen.
> - **Survives real life.** Reconnects on its own after a dropped connection, a
>   page reload, or a long pause.
>
> SSynch sends only the address of the page being shared and the playback
> position. No page content, no analytics, no tracking. See the privacy policy
> for the full list.

## Assets

| Asset | Status |
|---|---|
| Icon, 128×128 | `extension/assets/store-icon-128.png` |
| Screenshots, 1280×800 or 640×400 | **Not made yet.** At least one is required. |
| Small promo tile, 440×280 | Optional; only needed for homepage promotion. |

## Before submitting

- [x] Remove `scripting` from `permissions` and rebuild.
- [x] Add expiry to stored room state — 24 hours, see `DECISIONS.md`.
- [ ] Deploy the server before submitting: the 24-hour expiry `PRIVACY.md`
      promises only exists in the deployed Worker once you `wrangler deploy`.
- [ ] Bump `version` in `extension/package.json`; `0.1.0` is what the manifest
      inherits and every Web Store upload needs a higher one than the last.
- [ ] Host `PRIVACY.md` and have the URL ready.
- [ ] Take at least one screenshot.
- [ ] Expect a slow review. `<all_urls>` puts an extension into manual review.

# Firefox Add-ons (AMO) listing copy

Paste-ready answers for the AMO submission flow. **This is a separate file from
[`STORE_LISTING.md`](STORE_LISTING.md) on purpose** — the two stores ask
different questions, and the Chrome answers are wrong for Firefox in specific
ways: the Chrome file justifies a `sidePanel` permission the Firefox build
strips, omits the `clipboardWrite` it adds, and describes the UI as a side
panel, which Firefox does not have. Merging them would make it easy to paste a
Chrome answer into an AMO field, which is the exact mistake both files exist to
prevent.

Keep this in sync with three things: the generated Firefox manifest
(`extension/scripts/firefox-manifest.mjs`), [`PRIVACY.md`](PRIVACY.md), and
`STORE_LISTING.md` where the claims genuinely overlap. Every claim below was
checked against the code on 6 August 2026 — except where explicitly marked
UNVERIFIED.

---

## Submission channel

**"On this site"** — listed publicly on addons.mozilla.org, with automatic
updates for users. (The alternative, "On your own", is self-distribution: Mozilla
still signs the `.xpi`, but you host it and push every update by hand.)

An AMO developer account is free. There is no counterpart to Chrome's one-off
$5 registration fee.

## Files to upload

| File | Purpose |
|---|---|
| `extension/ssynch-firefox-1.0.1.zip` | The add-on itself |
| `extension/ssynch-source-1.0.1.zip` | Source code — **mandatory**, see below |

Regenerate both with:

```
cd extension
npm run build:firefox
npx web-ext@8 build --source-dir dist-firefox --artifacts-dir . --overwrite-dest
git archive --format=zip --prefix=SSynch/ -o extension/ssynch-source-1.0.1.zip HEAD   # from repo root
```

`web-ext build` names its output `ssynch-<version>.zip`, which collides with the
Chrome package — **rename it to `ssynch-firefox-<version>.zip` immediately.**
Windows' `Compress-Archive` is not a substitute: it writes backslash path
separators, which violate the ZIP spec and can leave the browser unable to
resolve files the manifest references.

## Source code submission (mandatory)

AMO requires source whenever a build step makes the shipped code hard to read,
and module bundlers are called out by name. Vite qualifies, so this is not
optional and skipping it fails the review.

Paste into **Notes for reviewers → source code instructions**:

> Build environment: Node 22, npm 10. Platform-independent (developed on Windows).
>
>     cd extension
>     npm ci
>     npm run build:firefox
>
> Output appears in `extension/dist-firefox/` and matches the uploaded package.
>
> The manifest is generated, not hand-written. `extension/manifest.config.js` is
> the shared source of truth; `extension/scripts/firefox-manifest.mjs` rewrites it
> for Firefox — an event page instead of a service worker, `side_panel` removed,
> `browser_specific_settings` added. Bundling is vite + @crxjs/vite-plugin with
> vite's default settings; there is no minifier or obfuscator beyond that.
>
> All dependencies come from npm. Full public source, including history:
> https://github.com/Emilvdijk/SSynch

## Notes for reviewers

AMO has no per-permission justification fields — unlike Chrome, everything goes
in one free-text box. Keep it factual and tied to visible features.

> **What it does.** SSynch keeps video playback in sync between several people
> watching the same page in different browsers. One person creates a room and
> picks a video; the others join with a six-character code and their player
> follows — play, pause, seek, and continuous correction for the drift that
> accumulates between browsers over a long video.
>
> **To test it**, you need two browser profiles. In the first: click the toolbar
> icon → "Create room" → open any page with an HTML5 `<video>` → "Select video on
> this page" → click the video. In the second profile: click the icon, paste the
> six-character room code, "Join room". Playback controls in either profile now
> apply to both. No account, login, or test credentials are needed — there is no
> sign-up of any kind.
>
> **`<all_urls>`.** The people using SSynch choose what to watch together, and
> that list cannot be known in advance — a major streaming service, a self-hosted
> file, a lecture recording. A fixed host list would mean it simply does not work
> for whatever the group actually picked. The content script attaches to the
> single `<video>` element the host explicitly selects, and reads only what is
> needed to locate that same element in the other participants' browsers: its
> position in the page structure, its `id` and class names, and its duration. It
> does not read page text, form fields, cookies, or credentials, and transmits
> nothing at all unless the user is in a room.
>
> **`tabs`.** One specific tab is tied to the room. The API is needed to open the
> host's page in a guest's tab when they join, to notice when the host navigates
> away from the shared video so guests are not left following a dead page, and to
> treat closing that tab as leaving the room. This requires that tab's id and
> address; no other tab is read.
>
> **`storage`.** Stores the current room code, the user's role, and which tab is
> following the room, so a synced session survives Firefox suspending the
> extension's background event page mid-video. Also stores the position the user
> dragged the on-screen widget to. No browsing data is stored.
>
> **`alarms`.** A paused room generates no network traffic, so the background
> event page is suspended and the connection to the sync server is lost — the
> user's player silently stops following, with no error and no way back without
> rejoining. A periodic alarm is the only mechanism that can wake a suspended
> event page. It is used solely to re-establish that connection, contacts only
> the extension's own server, and reads no user data.
>
> **`clipboardWrite`.** The on-page widget has a button that copies the
> six-character room code so it can be sent to the people joining. The button
> lives in a content script, where this permission makes the copy independent of
> transient activation.
>
> **Server.** All traffic goes to a single Cloudflare Worker run by the
> developer, `wss://ssynch.emilvdijk.workers.dev`. There are no third-party
> services, analytics, or trackers of any kind. Room state is deleted 24 hours
> after a room was last used.

## Add-on details

**Name**

> SSynch

**Summary**

The dashboard enforces its own limit; this is 106 characters and will fit
comfortably. (It is the same line used for Chrome's 132-character cap.)

> Watch videos together in sync. Create a room, share the code, and everyone's
> player follows — on any site.

**Description**

Reused from `STORE_LISTING.md` with the Chrome-specific bits corrected — see the
UNVERIFIED note below before pasting.

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

The "stays visible in fullscreen" claim was held back until it could be checked,
because it rests on the overlay's `popover`/top-layer promotion rather than on
anything guaranteed. **Confirmed in Firefox Developer Edition on 6 August 2026**
against a real fullscreen video, so it ships. See DECISIONS.md for what that does
and doesn't establish — notably, Chrome still rests on the spec.

**Categories** — up to 2:

> Photos, Music & Videos
> Social & Communication

**Support email**

> emilvdijk@gmail.com

**Homepage / support site**

> https://github.com/Emilvdijk/SSynch

**Privacy policy URL** — verified live and rendering:

> https://emilvdijk.github.io/SSynch/PRIVACY

**License**

> All Rights Reserved

The repository is public but carries no `LICENSE` file, which under default
copyright means exactly this. Chosen deliberately (6 August 2026).
**If a LICENSE is ever added, this field has to change with it.**

## Data collection disclosure

Unlike Chrome's dashboard checkboxes, Firefox reads this from the manifest —
`browser_specific_settings.gecko.data_collection_permissions`, set in
`extension/scripts/firefox-manifest.mjs`. It is shown to users in the install
prompt.

Currently declared: `browsingActivity` (the shared page and frame address) and
`websiteActivity` (play, pause, seek, and the position heartbeat). Deliberately
**not** `technicalAndInteraction` — that covers device info, usage statistics and
crash reports, and SSynch has no telemetry. See DECISIONS.md for the full
reasoning. **This and `PRIVACY.md` must move together.**

## Version notes (1.0.1)

> First Firefox release. Same feature set as the Chrome version, with one
> difference: Firefox has no side panel API, so the toolbar icon opens the same
> interface as a popup.

Starting at 1.0.1 rather than 1.0.0 is not a mistake: the version is shared with
the Chrome build (both inherit it from `extension/package.json`), and 1.0.0 was
already submitted to Google. Keeping one number across both stores is worth more
than a tidy-looking first Firefox release — a single version means one answer to
"which code is this?" instead of two diverging ones.

## Before submitting

- [ ] **Actually run it in Firefox.** Nothing in this listing has been verified
      against a running Firefox — the add-on has only ever been validated
      statically. Load `extension/dist-firefox/` via `about:debugging`, then:
      create a room and confirm it connects, pick a video and confirm sync,
      **check whether the overlay survives fullscreen**, and confirm a room
      recovers after a two-minute pause.
- [ ] Decide the fullscreen bullet based on that test, before pasting the
      description.
- [ ] Confirm the data-collection declaration reads correctly to you — it is a
      public privacy statement and appears in the install prompt.
- [ ] Have both zips ready, with the Firefox one renamed away from
      `ssynch-1.0.1.zip` so it can't be confused with the Chrome package.
- [ ] Expect `<all_urls>` to draw a manual review, as it did on Chrome.

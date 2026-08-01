# SSynch Privacy Policy

**Effective 1 August 2026.**

SSynch is a Chrome extension that keeps video playback in sync between several
people watching the same page. This policy describes exactly what it sends,
where it goes, and how long it stays there.

## Short version

SSynch has no accounts, no logins, and no analytics. It never sees your name,
your email, or anything you type. To keep a group in sync it sends the address
of the page the host chose to share, a description of which video element on
that page to control, and the playback position — nothing else.

## What SSynch sends to its server

Nothing is sent until you create or join a room. Once you are in one, the
extension sends:

| Data | When | Why |
|---|---|---|
| Room code | On connecting | Routes you to the right room. Generated in your browser; not derived from anything about you. |
| Role (`host` or `guest`) | On connecting | Only the host may change which video the room is watching. |
| A fixed label, `"Host"` or `"Guest"` | On connecting | A placeholder. It is hard-coded, not a name you supply — SSynch has no field to enter one. |
| Page address and frame address | When the host picks a video | Guests' browsers open the same page. Without it there is nothing to sync to. |
| A description of the chosen video element | When the host picks a video | Its position in the page structure, its `id` and CSS class names if it has them, and its duration in seconds. Guests use this to find the same video on their copy of the page. |
| Playback state | On play, pause, and seek | Whether it is playing, the position in seconds, the playback speed, and a timestamp. |
| Playback position | About every 2 seconds while playing, from the host only | Corrects the drift that accumulates between browsers. |
| Timestamps for clock comparison | Periodically | Measures the round-trip delay so playback positions can be corrected for network latency. |

## What SSynch does not send

- The contents of any page — no text, images, form fields, or keystrokes.
- The video or audio itself. SSynch controls a player; it never touches the stream.
- Cookies, passwords, session tokens, or anything that could log in as you.
- Your browsing history. The extension transmits the address of the page the
  host deliberately shares with the room, and no other page you visit.
- Any analytics, telemetry, crash reporting, advertising, or tracking of any kind.

There are no third-party services in SSynch. No data is sold, rented, or shared
with anyone.

## Where it goes

To a single server run by SSynch's developer on Cloudflare Workers, at
`ssynch.emilvdijk.workers.dev`. Cloudflare hosts it and is the only other party
that handles the data, as an infrastructure provider. Connections use `wss://`
(encrypted WebSocket).

Room data is stored per room code so that someone joining late, or reconnecting
after a dropped connection, lands at the right place in the right video.

## How long it is kept

**24 hours after a room was last used.** The shared page address, video
description, and playback position are erased automatically once a room has gone
a full day without anyone playing, pausing, or seeking in it, and without anyone
connected to it. Any activity pushes that deadline back, so a room stays alive
for as long as it is genuinely in use — including a long pause with people still
connected.

Nothing is retained beyond that. There are no server-side access logs, request
logs, backups, or records of who connected.

## What is stored in your own browser

- **Session storage** — the current room code, your role, and which tab is
  following the room. Chrome clears this when the browser closes.
- **Local storage** — the position you dragged the on-screen sync widget to.
  Nothing else. This persists until you remove the extension.

Neither is transmitted anywhere.

## Site access

SSynch requests access to all websites because the people using it choose what
to watch, and that list cannot be known in advance — it might be a streaming
service, a self-hosted file, or a lecture page. The extension's content script
is therefore present on every page, but it transmits nothing unless you are in a
room, and it only observes and controls the one video element the host
explicitly selected.

## Who can see your room

Anyone who has your room code can join it and will receive the shared page
address and playback position. Room codes are not secret in any cryptographic
sense — treat one like a meeting link and only share it with people you want in
the room.

## Children

SSynch is not directed at children and does not knowingly collect any
information from them.

## Your choices

Leaving a room stops all transmission immediately. Removing the extension
deletes everything it stored in your browser.

Because SSynch holds no identifiers, there is no account to look up and no way
to associate stored room state with a person — including by the developer.

## Changes

Material changes to this policy will be published here with a new effective
date, and reflected in the extension's Chrome Web Store listing.

## Contact

emil@nimble.expert

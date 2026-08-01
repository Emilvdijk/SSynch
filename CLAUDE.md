# Instructions for Claude Code

- **Read [`DECISIONS.md`](DECISIONS.md) in full before implementing any change in this
  repo.** It records *why* the sync protocol, video-matching, and overlay code are shaped
  the way they are — including decisions that were deliberately reversed or refined over
  time (e.g. heartbeats being host-only, not symmetric like other messages). Skipping it
  risks silently reintroducing a bug that was already fixed on purpose.
- Keep `DECISIONS.md` current: when you make or the user directs a non-obvious
  design/architecture choice (especially one that overrides, refines, or could be
  mistaken for undoing an earlier decision), add an entry — or ask whether to add one, if
  it's ambiguous whether it rises to that level. Don't log routine bug fixes, refactors,
  or anything already obvious from reading the code; only the *why*, not the *what*.
- See `README.md` for setup/run/deploy instructions — that's not duplicated here or in
  `DECISIONS.md`.

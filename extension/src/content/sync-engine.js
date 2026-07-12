// Piece 11: makes playback *feel* synchronized despite network latency and drift.
//
// Two problems, handled separately:
//   1. Latency compensation — a `state`/`sync` message says "playing at T=42 as of
//      server-clock `at`". By the time it arrives, more of the video has elapsed.
//   2. Drift correction — decoders and clocks diverge over minutes; periodic
//      `heartbeat` messages let a guest re-align: hard-seek if far off, nudge
//      playbackRate if close, do nothing if already synced.
//
// Clock offset: estimated once via a ping/pong round trip so "the server's `at`
// timestamp" can be compared to this machine's `Date.now()` meaningfully.

const LARGE_GAP_SECONDS = 1.0;
const SMALL_GAP_SECONDS = 0.1;
const NUDGE_FAST = 1.05;
const NUDGE_SLOW = 0.95;

export class ClockOffset {
  constructor() {
    this.offsetMs = 0; // add this to local Date.now() to estimate server time
  }

  /** Feed a {t0, t1} pong: t0 = our send time, t1 = server's clock when it saw the ping. */
  sample({ t0, t1 }) {
    const now = Date.now();
    const roundTrip = now - t0;
    const serverNowEstimate = t1 + roundTrip / 2;
    this.offsetMs = serverNowEstimate - now;
  }

  /** Convert a server timestamp into "how many seconds ago, from now, in local time." */
  secondsSince(serverAt) {
    const localEquivalentNow = Date.now() + this.offsetMs;
    return (localEquivalentNow - serverAt) / 1000;
  }
}

/**
 * Given a host state/sync message and the clock offset, compute the currentTime
 * a guest should apply *right now* to land where the host actually is.
 */
export function compensatedTime({ currentTime, play, at }, clockOffset) {
  if (!play) return currentTime; // paused: no elapsed-time correction needed
  const elapsed = clockOffset.secondsSince(at);
  return currentTime + Math.max(0, elapsed);
}

/**
 * Drift reconciliation: call on every heartbeat with the controller and clock offset.
 * Applies a hard seek, a rate nudge, or nothing, depending on gap size.
 */
export function reconcileDrift(controller, heartbeat, clockOffset) {
  const expected = compensatedTime({ currentTime: heartbeat.currentTime, play: true, at: heartbeat.at }, clockOffset);
  const actual = controller.el.currentTime;
  const gap = expected - actual;
  const absGap = Math.abs(gap);

  if (absGap > LARGE_GAP_SECONDS) {
    controller.applyRemote({ currentTime: expected });
    return { action: "seek", gap };
  }

  if (absGap > SMALL_GAP_SECONDS) {
    controller.applyRateNudge(gap > 0 ? NUDGE_FAST : NUDGE_SLOW);
    return { action: "nudge", gap };
  }

  if (controller.el.playbackRate !== 1.0) {
    controller.applyRateNudge(1.0);
  }
  return { action: "hold", gap };
}

const AD_DURATION_TOLERANCE_S = 2;
const AD_STABLE_CONFIRMATIONS = 2;

/**
 * Detects a likely ad break via `video.duration` rather than site-specific DOM
 * sniffing: an ad break commonly swaps the element's source to a much shorter
 * (or otherwise different) resource, then swaps back. Each viewer's ad is
 * independently served/timed, so relaying playback position during one is
 * actively wrong — it seeks other viewers into a meaningless position on
 * whatever they're currently seeing. `check()` is meant to be called on every
 * heartbeat/local-state report; while it returns true, don't broadcast.
 *
 * A genuine video change (a different duration that then stays stable) is
 * treated as the new baseline rather than a permanent "in ad" state — though
 * in practice `onSourceChanged`'s URL check (see content.js) already handles
 * real video switches separately; this only needs to cover same-page duration
 * blips. Known false-positive risk: legitimate content with a fluctuating
 * reported duration (e.g. some live streams) will look like a permanent ad.
 */
export class AdGuard {
  constructor() {
    this.baselineDuration = null;
    this.pendingDuration = null;
    this.pendingCount = 0;
  }

  /** Returns true if `duration` looks like an ad relative to the established baseline. */
  check(duration) {
    if (!Number.isFinite(duration) || duration <= 0) return false; // not loaded yet — nothing to compare

    if (this.baselineDuration === null) {
      this.baselineDuration = duration;
      return false;
    }

    if (Math.abs(duration - this.baselineDuration) <= AD_DURATION_TOLERANCE_S) {
      this.pendingDuration = null;
      this.pendingCount = 0;
      return false;
    }

    // Doesn't match baseline. Require it to reappear a couple of times before
    // trusting it (vs. a one-off blip) — once confirmed, adopt it as the new
    // baseline so a real, lasting change stops being treated as "still an ad."
    if (this.pendingDuration !== null && Math.abs(duration - this.pendingDuration) <= AD_DURATION_TOLERANCE_S) {
      this.pendingCount++;
    } else {
      this.pendingDuration = duration;
      this.pendingCount = 1;
    }

    if (this.pendingCount >= AD_STABLE_CONFIRMATIONS) {
      this.baselineDuration = this.pendingDuration;
      this.pendingDuration = null;
      this.pendingCount = 0;
      return false;
    }

    return true;
  }
}

/** Host-side: emit a heartbeat only while playing, every `intervalMs`. Returns a stop function. */
export function startHeartbeat(controller, intervalMs, onBeat) {
  let timer = null;

  const tick = () => {
    if (!controller.el.paused) {
      onBeat({ currentTime: controller.el.currentTime, at: Date.now() });
    }
  };

  const start = () => {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  // Only heartbeat while playing — this is also what lets the Durable Object
  // hibernate (and stop billing compute duration) during long pauses.
  controller.on("play", start);
  controller.on("pause", stop);
  if (!controller.el.paused) start();

  return () => {
    stop();
  };
}

// Piece 2: thin wrapper around the chosen <video> element.
// Executes remote commands, reports local (user-driven) events, and guards
// against the "echo" problem: applying a remote command fires the element's
// own play/pause/seeked events, which must NOT be rebroadcast as if the user
// had just interacted with the video.

const ECHO_GUARD_MS = 50;
// Backstop only — normally the guard clears as soon as the seek it caused
// actually completes (see _armSeekGuard). Real seeks to an unbuffered
// position (e.g. jumping a fresh guest to the host's current timestamp)
// can take far longer than a fixed short timer to finish; if the guard
// cleared first, the resulting `seeked` event looked like a genuine user
// seek, got reported and rebroadcast, and made every OTHER peer (including
// the host) re-seek to ~that same spot — a spurious, visible jump.
const SEEK_GUARD_MAX_MS = 8000;
// Some custom players (state-driven, e.g. React-based ones) keep their own
// internal "should be playing" flag and resume the <video> a moment after an
// externally-triggered pause() if that flag disagrees — confirmed on
// cineby.at: a remote pause visibly hiccups for a frame or two, then the
// site's own player resumes it, so the pause never actually sticks. Keep
// re-asserting pause for this long to win that fight.
const PAUSE_ENFORCE_MS = 600;

export class VideoController {
  /** @param {HTMLMediaElement} el */
  constructor(el) {
    this.el = el;
    this.isApplyingRemote = false;
    // Set by the caller. Chrome's autoplay policy can silently reject a
    // programmatic play() with no user gesture on the page — without this,
    // a guest sees "controllable" while the video simply never starts, with
    // no indication why. Fires again with `false` once a play() succeeds.
    this.onPlayBlocked = null;
    // Set by the caller. Fires when the SAME element starts loading different
    // media (`loadstart`) — SPA sites like YouTube reuse one <video> tag across
    // "suggested video" clicks instead of replacing the element, so the
    // MutationObserver-based "video lost" detection never catches this.
    this.onSourceChanged = null;
    this._guardTimer = null;
    this._listeners = { play: [], pause: [], seeked: [], ratechange: [], timeupdate: [] };

    this._onPlay = () => this._emit("play");
    this._onPause = () => this._emit("pause");
    this._onSeeked = () => this._emit("seeked");
    this._onRateChange = () => this._emit("ratechange");
    this._onTimeUpdate = () => this._emit("timeupdate");
    this._onLoadStart = () => this.onSourceChanged?.();

    el.addEventListener("play", this._onPlay);
    el.addEventListener("pause", this._onPause);
    el.addEventListener("seeked", this._onSeeked);
    el.addEventListener("ratechange", this._onRateChange);
    el.addEventListener("timeupdate", this._onTimeUpdate);
    el.addEventListener("loadstart", this._onLoadStart);
  }

  /** Subscribe to a local video event. Suppressed while a remote command is being applied. */
  on(type, fn) {
    this._listeners[type].push(fn);
    return () => {
      this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
    };
  }

  _emit(type) {
    if (this.isApplyingRemote) return; // echo guard: this event was caused by us, not the user
    for (const fn of this._listeners[type]) fn(this.getState());
  }

  getState() {
    return {
      play: !this.el.paused,
      currentTime: this.el.currentTime,
      rate: this.el.playbackRate
    };
  }

  /** Apply a command that originated remotely (host state, or drift correction). */
  applyRemote({ play, currentTime, rate }) {
    this.isApplyingRemote = true;

    let seekTarget = null;
    if (typeof rate === "number" && Math.abs(this.el.playbackRate - rate) > 0.001) {
      this.el.playbackRate = rate;
    }
    if (typeof currentTime === "number" && Math.abs(this.el.currentTime - currentTime) > 0.05) {
      this.el.currentTime = currentTime;
      seekTarget = currentTime;
    }
    if (typeof play === "boolean") {
      // A remote play must win outright, even if it lands inside a still-active
      // pause-enforcement window from a just-prior remote pause — otherwise
      // _enforcePause's own "play" listener would immediately fight this
      // legitimate one and re-pause it right back.
      if (play) this._clearPauseEnforce?.();
      if (play && this.el.paused) {
        this.el.play().then(
          () => this.onPlayBlocked?.(false),
          () => this.onPlayBlocked?.(true)
        );
      }
      if (!play && !this.el.paused) {
        this.el.pause();
        this._enforcePause();
      }
    }

    // A real seek needs its own (longer, event-driven) guard — see
    // _armSeekGuard. play/pause/rate changes settle within a tick or two, so
    // the fixed short timer is fine for those.
    if (seekTarget !== null) this._armSeekGuard(seekTarget);
    else this._armGuard();
  }

  /** Nudge playback rate for drift correction without it counting as a user ratechange. */
  applyRateNudge(rate) {
    this.isApplyingRemote = true;
    this.el.playbackRate = rate;
    this._armGuard();
  }

  // A single cancellable timer, not one per call — applyRemote/applyRateNudge
  // can land within ECHO_GUARD_MS of each other (e.g. a `state` message right
  // before a heartbeat nudge). Independent timers would let the earlier one
  // clear the guard early, opening a window for a genuine echo to slip through.
  _armGuard() {
    this._clearSeekWait?.();
    if (this._guardTimer) clearTimeout(this._guardTimer);
    this._guardTimer = setTimeout(() => {
      this.isApplyingRemote = false;
      this._guardTimer = null;
    }, ECHO_GUARD_MS);
  }

  // Waits for the `seeked` event our own currentTime assignment causes,
  // however long that actually takes, instead of guessing with a timer.
  // Falls back to SEEK_GUARD_MAX_MS in case it never fires (e.g. the browser
  // decided no seek was actually needed for that delta).
  _armSeekGuard(target) {
    this._clearSeekWait?.();
    if (this._guardTimer) clearTimeout(this._guardTimer);

    const onSeeked = () => {
      // Only release on OUR seek landing — a genuine user seek racing in
      // while ours is still buffering would otherwise clear the guard early
      // and let our own (still pending) seeked event slip through later as
      // if it were the user's.
      if (Math.abs(this.el.currentTime - target) > 0.5) return;
      clear();
      this._armGuard(); // brief trailing guard to also swallow immediate follow-up events
    };
    const timeout = setTimeout(() => {
      clear();
      this.isApplyingRemote = false;
    }, SEEK_GUARD_MAX_MS);
    const clear = () => {
      this.el.removeEventListener("seeked", onSeeked);
      clearTimeout(timeout);
      this._clearSeekWait = null;
    };
    this._clearSeekWait = clear;
    this.el.addEventListener("seeked", onSeeked);
  }

  // See PAUSE_ENFORCE_MS above. Independent of the echo guard (isApplyingRemote)
  // above/below — re-issuing pause() here is idempotent even if a stray extra
  // "pause" report slips out, so it doesn't need to interact with that guard.
  _enforcePause() {
    this._clearPauseEnforce?.();
    const deadline = Date.now() + PAUSE_ENFORCE_MS;
    const onPlay = () => {
      if (Date.now() > deadline) {
        clear();
        return;
      }
      this.el.pause();
    };
    const clear = () => {
      this.el.removeEventListener("play", onPlay);
      clearTimeout(timer);
      this._clearPauseEnforce = null;
    };
    const timer = setTimeout(clear, PAUSE_ENFORCE_MS);
    this._clearPauseEnforce = clear;
    this.el.addEventListener("play", onPlay);
  }

  destroy() {
    this._clearPauseEnforce?.();
    this._clearSeekWait?.();
    if (this._guardTimer) clearTimeout(this._guardTimer);
    this.el.removeEventListener("play", this._onPlay);
    this.el.removeEventListener("pause", this._onPause);
    this.el.removeEventListener("seeked", this._onSeeked);
    this.el.removeEventListener("ratechange", this._onRateChange);
    this.el.removeEventListener("timeupdate", this._onTimeUpdate);
    this.el.removeEventListener("loadstart", this._onLoadStart);
  }
}

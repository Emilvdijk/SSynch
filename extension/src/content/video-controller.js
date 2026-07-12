// Piece 2: thin wrapper around the chosen <video> element.
// Executes remote commands, reports local (user-driven) events, and guards
// against the "echo" problem: applying a remote command fires the element's
// own play/pause/seeked events, which must NOT be rebroadcast as if the user
// had just interacted with the video.

const ECHO_GUARD_MS = 50;

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

    if (typeof rate === "number" && Math.abs(this.el.playbackRate - rate) > 0.001) {
      this.el.playbackRate = rate;
    }
    if (typeof currentTime === "number" && Math.abs(this.el.currentTime - currentTime) > 0.05) {
      this.el.currentTime = currentTime;
    }
    if (typeof play === "boolean") {
      if (play && this.el.paused) {
        this.el.play().then(
          () => this.onPlayBlocked?.(false),
          () => this.onPlayBlocked?.(true)
        );
      }
      if (!play && !this.el.paused) this.el.pause();
    }

    // seeked/play/pause fire asynchronously; hold the guard a beat longer than one tick.
    this._armGuard();
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
    if (this._guardTimer) clearTimeout(this._guardTimer);
    this._guardTimer = setTimeout(() => {
      this.isApplyingRemote = false;
      this._guardTimer = null;
    }, ECHO_GUARD_MS);
  }

  destroy() {
    if (this._guardTimer) clearTimeout(this._guardTimer);
    this.el.removeEventListener("play", this._onPlay);
    this.el.removeEventListener("pause", this._onPause);
    this.el.removeEventListener("seeked", this._onSeeked);
    this.el.removeEventListener("ratechange", this._onRateChange);
    this.el.removeEventListener("timeupdate", this._onTimeUpdate);
    this.el.removeEventListener("loadstart", this._onLoadStart);
  }
}

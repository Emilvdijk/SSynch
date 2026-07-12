// Minimal HTMLMediaElement stand-in for tests: no jsdom, just enough surface
// for VideoController (EventTarget + paused/currentTime/playbackRate + play/pause).
export class FakeVideo extends EventTarget {
  constructor() {
    super();
    this.paused = true;
    this.currentTime = 0;
    this.playbackRate = 1;
  }

  play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  /** Real seeks fire `seeked` asynchronously after the fact; simulate that explicitly. */
  fireSeeked() {
    this.dispatchEvent(new Event("seeked"));
  }

  /** Simulates the SAME element starting to load different media (e.g. YouTube's "up next"). */
  fireLoadStart() {
    this.dispatchEvent(new Event("loadstart"));
  }
}

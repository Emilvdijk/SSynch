import { test } from "node:test";
import assert from "node:assert/strict";
import { VideoController } from "../src/content/video-controller.js";
import { FakeVideo } from "../test-helpers/fake-video.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("echo guard suppresses play/pause caused by applyRemote", async () => {
  const video = new FakeVideo();
  const controller = new VideoController(video);
  let calls = 0;
  controller.on("play", () => calls++);

  controller.applyRemote({ play: true });
  assert.equal(video.paused, false, "the video should actually have started");
  assert.equal(calls, 0, "the resulting play event must not be reported as a local/user event");
});

test("a genuine local play (after the guard window) is still reported", async () => {
  const video = new FakeVideo();
  const controller = new VideoController(video);
  let calls = 0;
  controller.on("play", () => calls++);

  controller.applyRemote({ play: true });
  await wait(70); // past ECHO_GUARD_MS
  video.pause();
  video.play(); // simulates the user clicking play directly
  assert.equal(calls, 1);
});

test("overlapping applyRemote calls keep the guard held for the later window (regression for the shared-timer race)", async () => {
  const video = new FakeVideo();
  const controller = new VideoController(video);

  controller.applyRemote({ play: true });
  await wait(30);
  controller.applyRemote({ rate: 1.05 }); // e.g. a heartbeat-driven nudge landing mid-guard

  await wait(30); // 60ms since the first call, but only 30ms since the second
  assert.equal(controller.isApplyingRemote, true, "the second call's guard window should still be active");

  await wait(30); // 90ms since the first call, 60ms since the second
  assert.equal(controller.isApplyingRemote, false, "the guard should clear once the later window elapses");
});

test("onSourceChanged fires on loadstart, even when the guard is active (SPA reuses the same <video> element)", async () => {
  const video = new FakeVideo();
  const controller = new VideoController(video);
  let sourceChangedCalls = 0;
  controller.onSourceChanged = () => sourceChangedCalls++;

  controller.applyRemote({ play: true }); // guard is active here
  video.fireLoadStart(); // e.g. user clicked a suggested video
  assert.equal(sourceChangedCalls, 1, "a source change must be reported regardless of the echo guard");
});

test("a slow-to-settle remote seek is not echoed, even long after the old fixed guard window would have cleared", async () => {
  const video = new FakeVideo();
  const controller = new VideoController(video);
  let seekedCalls = 0;
  controller.on("seeked", () => seekedCalls++);

  controller.applyRemote({ currentTime: 500 }); // e.g. jumping a fresh guest to the host's timestamp
  await wait(200); // far past the old fixed 50ms guard — real unbuffered seeks can take this long or longer
  video.fireSeeked(); // the browser's real `seeked` event, only now actually arriving
  assert.equal(seekedCalls, 0, "the seek WE caused must not be reported as if the user did it");

  await wait(70); // past the brief trailing guard that follows
  video.currentTime = 600;
  video.fireSeeked(); // a genuine, later, unrelated user seek
  assert.equal(seekedCalls, 1, "a real seek afterward must still be reported");
});

test("applyRemote reports play() rejection via onPlayBlocked (autoplay policy)", async () => {
  const video = new FakeVideo();
  video.play = () => Promise.reject(new Error("NotAllowedError"));
  const controller = new VideoController(video);

  let blocked;
  controller.onPlayBlocked = (isBlocked) => {
    blocked = isBlocked;
  };
  controller.applyRemote({ play: true });
  await wait(0); // let the rejected promise's handler run
  assert.equal(blocked, true);
});

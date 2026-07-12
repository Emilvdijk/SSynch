import { test } from "node:test";
import assert from "node:assert/strict";
import { AdGuard, ClockOffset, compensatedTime, reconcileDrift } from "../src/content/sync-engine.js";

test("ClockOffset.sample estimates ~0 offset for a same-machine round trip", () => {
  const clock = new ClockOffset();
  const t0 = Date.now();
  const t1 = Date.now(); // "server" clock, same machine in this test
  clock.sample({ t0, t1 });
  assert.ok(Math.abs(clock.offsetMs) < 50, `expected a small offset, got ${clock.offsetMs}`);
});

test("compensatedTime returns currentTime unchanged when paused", () => {
  const clock = new ClockOffset();
  const result = compensatedTime({ currentTime: 42, play: false, at: Date.now() }, clock);
  assert.equal(result, 42);
});

test("compensatedTime adds elapsed time since `at` when playing", () => {
  const clock = new ClockOffset();
  const at = Date.now() - 2000; // stamped 2s ago
  const result = compensatedTime({ currentTime: 10, play: true, at }, clock);
  assert.ok(result >= 11.9 && result <= 12.5, `expected ~12s, got ${result}`);
});

function fakeController(currentTime) {
  const calls = { seek: null, nudge: null };
  return {
    el: { currentTime, playbackRate: 1.0 },
    applyRemote: ({ currentTime: t }) => {
      calls.seek = t;
    },
    applyRateNudge: (rate) => {
      calls.nudge = rate;
    },
    calls
  };
}

test("reconcileDrift hard-seeks when the gap is large", () => {
  const controller = fakeController(0); // way behind
  const result = reconcileDrift(controller, { currentTime: 10, at: Date.now() }, new ClockOffset());
  assert.equal(result.action, "seek");
  assert.equal(controller.calls.seek, 10);
});

test("reconcileDrift nudges the rate when the gap is small but non-trivial", () => {
  const controller = fakeController(9.7); // ~0.3s behind
  const result = reconcileDrift(controller, { currentTime: 10, at: Date.now() }, new ClockOffset());
  assert.equal(result.action, "nudge");
  assert.ok(controller.calls.nudge > 1.0, "should speed up to catch up");
});

test("reconcileDrift holds (no-op) when already in sync", () => {
  const controller = fakeController(10.0);
  const result = reconcileDrift(controller, { currentTime: 10, at: Date.now() }, new ClockOffset());
  assert.equal(result.action, "hold");
  assert.equal(controller.calls.seek, null);
  assert.equal(controller.calls.nudge, null);
});

test("AdGuard establishes a baseline on first check and doesn't flag it", () => {
  const guard = new AdGuard();
  assert.equal(guard.check(3600), false);
});

test("AdGuard flags a duration that suddenly differs from the baseline (a likely ad)", () => {
  const guard = new AdGuard();
  guard.check(3600); // baseline: a 1-hour video
  assert.equal(guard.check(15), true, "a 15s duration mid-1hr-video looks like an ad");
});

test("AdGuard stops flagging once the duration reverts to the baseline (ad ended)", () => {
  const guard = new AdGuard();
  guard.check(3600);
  guard.check(15); // ad starts
  assert.equal(guard.check(3600), false, "back to the real content — no longer an ad");
});

test("AdGuard adopts a new duration as the baseline once it's stable for 2 checks (a real video change)", () => {
  const guard = new AdGuard();
  guard.check(3600);
  assert.equal(guard.check(200), true, "first sighting of the new duration — not yet trusted");
  assert.equal(guard.check(200), false, "confirmed stable — adopted as the new baseline");
  assert.equal(guard.check(200), false, "matches the new baseline going forward");
});

test("AdGuard ignores unloaded/invalid durations rather than guessing", () => {
  const guard = new AdGuard();
  guard.check(3600);
  assert.equal(guard.check(NaN), false);
  assert.equal(guard.check(0), false);
  assert.equal(guard.check(3600), false, "baseline untouched by the invalid readings");
});

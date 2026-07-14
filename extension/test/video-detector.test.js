import { test } from "node:test";
import assert from "node:assert/strict";
import { classesOverlap } from "../src/content/video-detector.js";

test("classesOverlap is true when two class lists share at least one class name", () => {
  assert.equal(classesOverlap("mgp_videoElement active", "mgp_videoElement"), true);
  assert.equal(classesOverlap("foo bar", "baz bar"), true);
});

test("classesOverlap is false when class lists share nothing", () => {
  assert.equal(classesOverlap("mgp_videoElement", "mgp_previewClip"), false);
});

test("classesOverlap is false for empty/missing class lists", () => {
  assert.equal(classesOverlap("", "mgp_videoElement"), false);
  assert.equal(classesOverlap("mgp_videoElement", ""), false);
  assert.equal(classesOverlap(null, "mgp_videoElement"), false);
  assert.equal(classesOverlap(undefined, undefined), false);
});

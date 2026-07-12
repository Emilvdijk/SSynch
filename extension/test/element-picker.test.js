import { test } from "node:test";
import assert from "node:assert/strict";
import { findNearestVideo } from "../src/content/element-picker.js";

// Minimal fake DOM nodes: findNearestVideo/findVideoInSubtree only touch
// tagName, children, parentElement and shadowRoot — no jsdom needed.
function makeNode(tagName, children = []) {
  const node = { tagName, children, parentElement: null, shadowRoot: null };
  for (const child of children) child.parentElement = node;
  return node;
}

test("findNearestVideo finds a <video> that IS a sibling of the clicked element (Dailymotion's own structure)", () => {
  // player > [vod_click (clicked), controls_layer_1, video]
  const video = makeNode("VIDEO");
  const vodClick = makeNode("DIV");
  const controls = makeNode("DIV");
  makeNode("DIV", [vodClick, controls, video]); // player, wires parentElement on each child

  assert.equal(findNearestVideo(vodClick), video);
  assert.equal(findNearestVideo(controls), video);
});

test("findNearestVideo still finds a video several ancestors up from a deeply nested click target", () => {
  // player > controls_layer > button > svg > path (clicked), and player > video
  const video = makeNode("VIDEO");
  const path = makeNode("PATH");
  const svg = makeNode("SVG", [path]);
  const button = makeNode("BUTTON", [svg]);
  const controlsLayer = makeNode("DIV", [button]);
  makeNode("DIV", [controlsLayer, video]); // player

  assert.equal(findNearestVideo(path), video);
});

test("findNearestVideo still finds a video that IS an ancestor (or the element itself)", () => {
  const video = makeNode("VIDEO");
  assert.equal(findNearestVideo(video), video);

  const child = makeNode("DIV");
  video.children.push(child);
  child.parentElement = video;
  assert.equal(findNearestVideo(child), video);
});

test("findNearestVideo returns null when nothing is within the search depth", () => {
  const lonely = makeNode("DIV");
  assert.equal(findNearestVideo(lonely), null);
});

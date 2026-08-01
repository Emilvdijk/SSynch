import { test } from "node:test";
import assert from "node:assert/strict";
import { syncFullscreenLayer } from "../src/content/overlay.js";

/**
 * Minimal stand-in for the overlay's shadow-host <div>. Only the surface
 * syncFullscreenLayer actually touches — attributes, the popover methods, and
 * (for the exit path's re-clamp) style/geometry.
 */
function makeHostEl({ showPopoverThrows = false, left = "" } = {}) {
  const attrs = new Map();
  return {
    style: { left },
    shown: 0,
    hidden: 0,
    hasAttribute: (name) => attrs.has(name),
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: (name) => attrs.delete(name),
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    showPopover() {
      if (showPopoverThrows) throw new TypeError("showPopover is not a function");
      this.shown++;
    },
    hidePopover() {
      this.hidden++;
    },
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 230, height: 70 }),
    offsetWidth: 230,
    offsetHeight: 70
  };
}

function withFullscreen(element, fn) {
  const previous = globalThis.document;
  globalThis.document = { fullscreenElement: element, webkitFullscreenElement: null };
  try {
    return fn();
  } finally {
    globalThis.document = previous;
  }
}

test("entering fullscreen promotes the overlay into the top layer", () => {
  const hostEl = makeHostEl();
  withFullscreen({}, () => syncFullscreenLayer(hostEl));

  assert.equal(hostEl.getAttribute("popover"), "manual");
  assert.equal(hostEl.shown, 1, "it must actually be shown — the attribute alone would hide it via the UA's display:none rule");
});

test("leaving fullscreen takes it back out of the top layer", () => {
  const hostEl = makeHostEl();
  withFullscreen({}, () => syncFullscreenLayer(hostEl));
  withFullscreen(null, () => syncFullscreenLayer(hostEl));

  assert.equal(hostEl.hasAttribute("popover"), false, "the attribute must not linger — windowed behaviour has to be exactly as before");
  assert.equal(hostEl.hidden, 1);
});

test("a browser without popover support is left visible, not stuck behind the UA's display:none", () => {
  const hostEl = makeHostEl({ showPopoverThrows: true });
  withFullscreen({}, () => syncFullscreenLayer(hostEl));

  // Backing the attribute out is the whole point: [popover]:not(:popover-open)
  // is display:none, so a failed showPopover that left the attribute behind
  // would hide the overlay everywhere, not just in fullscreen.
  assert.equal(hostEl.hasAttribute("popover"), false);
  assert.equal(hostEl.shown, 0);
});

test("repeat calls while already fullscreen don't re-show it", () => {
  const hostEl = makeHostEl();
  withFullscreen({}, () => {
    syncFullscreenLayer(hostEl);
    syncFullscreenLayer(hostEl);
    syncFullscreenLayer(hostEl);
  });

  assert.equal(hostEl.shown, 1, "showPopover throws on an already-open popover — it must only be called on the transition");
});

test("a fullscreen <video> or cross-origin <iframe> is handled the same way (no re-parenting involved)", () => {
  // The reason for the top layer rather than appendChild: neither of these can
  // render child content, so moving the overlay inside them would lose it.
  for (const fullscreenElement of [{ tagName: "VIDEO" }, { tagName: "IFRAME" }]) {
    const hostEl = makeHostEl();
    withFullscreen(fullscreenElement, () => syncFullscreenLayer(hostEl));
    assert.equal(hostEl.shown, 1, `${fullscreenElement.tagName} fullscreen should still promote the overlay`);
  }
});

test("exiting fullscreen re-clamps a dragged position into the now-smaller viewport", () => {
  // Dragged to x=1500 while fullscreen on a 1920-wide screen, then back to a
  // 1280-wide window — without the re-clamp it would sit off-screen.
  const hostEl = makeHostEl({ left: "1500px" });
  hostEl.getBoundingClientRect = () => ({ left: 1500, top: 10, width: 230, height: 70 });

  const previousWindow = globalThis.window;
  globalThis.window = { innerWidth: 1280, innerHeight: 720 };
  try {
    withFullscreen({}, () => syncFullscreenLayer(hostEl));
    withFullscreen(null, () => syncFullscreenLayer(hostEl));
  } finally {
    globalThis.window = previousWindow;
  }

  assert.equal(hostEl.style.left, "1050px", "clamped to innerWidth - width");
});

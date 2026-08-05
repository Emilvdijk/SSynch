import { test } from "node:test";
import assert from "node:assert/strict";
import { copyText, syncFullscreenLayer } from "../src/content/overlay.js";

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

/**
 * Stubs the globals copyText touches. `clipboard: null` models a NON-SECURE
 * context, where navigator.clipboard is genuinely absent rather than merely
 * failing — that's the http:// case this whole path exists for.
 */
function withClipboardEnv({ clipboard, execCommandResult = true, execCommandThrows = false }, fn) {
  // Node 21+ defines globalThis.navigator as a getter-only accessor, so plain
  // assignment throws — descriptors are the only way to stub and restore it.
  const saved = new Map();
  const stub = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  const restore = () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };

  const created = [];
  stub("navigator", clipboard ? { clipboard } : {});
  stub("document", {
    createElement: () => {
      const el = {
        style: {}, value: "", focused: 0, selected: 0, removed: 0,
        focus() { this.focused++; },
        select() { this.selected++; },
        remove() { this.removed++; }
      };
      created.push(el);
      return el;
    },
    execCommand: (cmd) => {
      if (execCommandThrows) throw new Error("execCommand not allowed");
      return cmd === "copy" ? execCommandResult : false;
    }
  });

  const shadow = { appended: [], appendChild(el) { this.appended.push(el); } };
  // copyText is async, so the globals have to stay stubbed until it settles —
  // restoring in a sync finally would tear them down mid-await.
  return Promise.resolve(fn(shadow, created)).finally(restore);
}

test("copies via the Clipboard API when the page is a secure context", async () => {
  const written = [];
  const result = await withClipboardEnv(
    { clipboard: { writeText: async (t) => void written.push(t) } },
    (shadow) => copyText("ABC123", shadow)
  );
  assert.equal(result, true);
  assert.deepEqual(written, ["ABC123"]);
});

test("falls back to execCommand when navigator.clipboard is absent (http:// page)", async () => {
  // The original bug: a bare navigator.clipboard.writeText() here threw
  // TypeError into an unhandled rejection, and the button silently did nothing.
  const [result, created] = await withClipboardEnv({ clipboard: null }, async (shadow, els) => [
    await copyText("ABC123", shadow),
    els
  ]);
  assert.equal(result, true, "the legacy path must actually run, not just avoid throwing");
  assert.equal(created.length, 1);
  assert.equal(created[0].value, "ABC123");
  assert.equal(created[0].selected, 1, "select() is what execCommand('copy') acts on");
});

test("falls back when the Clipboard API exists but rejects", async () => {
  // Document not focused, or permission denied.
  const result = await withClipboardEnv(
    { clipboard: { writeText: async () => { throw new DOMException("Document is not focused"); } } },
    (shadow) => copyText("ABC123", shadow)
  );
  assert.equal(result, true, "a rejecting Clipboard API should still fall through to the legacy path");
});

test("reports failure instead of throwing when both paths fail", async () => {
  for (const env of [{ clipboard: null, execCommandResult: false }, { clipboard: null, execCommandThrows: true }]) {
    const result = await withClipboardEnv(env, (shadow) => copyText("ABC123", shadow));
    assert.equal(result, false, "a total failure must be reported, so the button can show it");
  }
});

test("the temporary textarea is always cleaned up, including when execCommand throws", async () => {
  for (const env of [{ clipboard: null }, { clipboard: null, execCommandThrows: true }]) {
    const created = await withClipboardEnv(env, async (shadow, els) => {
      await copyText("ABC123", shadow);
      return els;
    });
    assert.equal(created[0].removed, 1, "left behind, the textarea would accumulate in the shadow root on every click");
  }
});

test("the temporary textarea is off-screen rather than hidden", async () => {
  const created = await withClipboardEnv({ clipboard: null }, async (shadow, els) => {
    await copyText("ABC123", shadow);
    return els;
  });
  // display:none / visibility:hidden would make select() a no-op and silently
  // break the only fallback there is.
  assert.equal(created[0].style.display, undefined);
  assert.equal(created[0].style.visibility, undefined);
  assert.equal(created[0].style.position, "fixed");
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

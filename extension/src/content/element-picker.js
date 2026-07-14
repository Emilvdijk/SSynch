// Piece 1: manual "inspect-style" picker for pages where auto-detect guesses wrong.
import { autoDetectVideo, findAllVideos, observeDeep } from "./video-detector.js";

const OVERLAY_ID = "__ssynch-picker-overlay__";

// `enterPickMode` is broadcast to every frame in the tab (a video can be
// inside any iframe). Only the frame the user actually clicks in resolves —
// without this, every sibling frame's capture-phase listeners (which
// preventDefault/stopPropagation every click) stay attached forever,
// silently swallowing all future clicks in e.g. ad iframes. `cancelPickMode`
// lets the other frames clean themselves up once one frame has picked.
let activeCancel = null;

const HINT_ID = "__ssynch-picker-hint__";

/**
 * Enter pick mode: highlight the video under the cursor, resolve on click.
 * Resolves with the picked <video> element, or null if cancelled (Escape,
 * or another frame in this tab already picked one).
 *
 * `showHint` (top frame only, to avoid stacking one per frame) surfaces a
 * banner covering the most common reason clicking silently does nothing:
 * a cookie/ad/paywall overlay iframe sitting on top of the real player and
 * intercepting the click before it ever reaches that frame. We deliberately
 * don't try to detect/dismiss such overlays ourselves — that would mean
 * making a privacy/consent decision on the user's behalf without their
 * actual input.
 */
export function pickVideo(showHint = true) {
  cancelPickMode(); // only one pick session per frame at a time
  return new Promise((resolve) => {
    let hint = null;
    if (showHint) {
      hint = document.createElement("div");
      hint.id = HINT_ID;
      hint.textContent =
        "Pick mode: click the video. Nothing highlighting? Dismiss any cookie/ad banner covering it first, then try again. Esc to cancel.";
      Object.assign(hint.style, {
        position: "fixed",
        top: "12px",
        left: "50%",
        transform: "translateX(-50%)",
        background: "#1a1a1a",
        color: "#fff",
        padding: "8px 14px",
        borderRadius: "6px",
        font: "13px/1.4 system-ui, sans-serif",
        zIndex: "2147483647",
        maxWidth: "90vw",
        textAlign: "center",
        boxShadow: "0 2px 8px rgba(0,0,0,0.3)"
      });
      document.documentElement.appendChild(hint);
    }

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    Object.assign(overlay.style, {
      position: "fixed",
      pointerEvents: "none",
      border: "2px solid #4f8cff",
      background: "rgba(79, 140, 255, 0.15)",
      zIndex: "2147483647",
      display: "none",
      transition: "all 60ms ease-out"
    });
    document.documentElement.appendChild(overlay);

    let hovered = null;

    // Some players ("click play to load the video") don't insert a <video>
    // element until the user interacts with a native play button — there's
    // nothing to click yet when pick mode starts. If the page has none right
    // now, watch for one to appear (and finish loading enough to have real
    // dimensions) and select it automatically instead of leaving the user
    // stuck with an overlay that never highlights anything.
    let stopLazyObserving = null;
    const seenCandidates = new WeakSet();

    const tryAutoResolve = () => {
      const el = autoDetectVideo();
      if (el) {
        cleanup();
        resolve(el);
      }
    };

    const watchLazyCandidates = () => {
      for (const v of findAllVideos()) {
        if (seenCandidates.has(v)) continue;
        seenCandidates.add(v);
        v.addEventListener("loadedmetadata", tryAutoResolve, { once: true });
      }
    };

    if (findAllVideos().length === 0) {
      // observeDeep (not a plain MutationObserver) also catches a video
      // appearing purely inside a shadow root — a plain observer's
      // subtree:true doesn't cross shadow boundaries, which matters on
      // heavily-shadow-DOM sites (e.g. MSN's Fluent UI web-component shell).
      stopLazyObserving = observeDeep(() => {
        watchLazyCandidates();
        tryAutoResolve();
      });
    }

    // Coalesce to at most once per animation frame — findNearestVideo now
    // searches each ancestor's subtree while walking up (needed to see past
    // sibling overlay/click-catcher layers), which is real per-call cost to
    // pay on every pixel of raw mousemove otherwise.
    let rafPending = false;
    let lastMoveEvent = null;

    const processMove = () => {
      rafPending = false;
      const e = lastMoveEvent;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const video = el ? findNearestVideo(el) : null;
      hovered = video;
      if (video) {
        const rect = video.getBoundingClientRect();
        Object.assign(overlay.style, {
          display: "block",
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`
        });
        // Reached a real video under the cursor — the hint has served its purpose.
        if (hint) {
          hint.remove();
          hint = null;
        }
      } else {
        overlay.style.display = "none";
      }
    };

    const onMouseMove = (e) => {
      lastMoveEvent = e;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(processMove);
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      resolve(hovered);
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        cleanup();
        resolve(null);
      }
    };

    const cleanup = () => {
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      if (stopLazyObserving) stopLazyObserving();
      if (hint) hint.remove();
      overlay.remove();
      activeCancel = null;
    };

    activeCancel = () => {
      cleanup();
      resolve(null);
    };

    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
  });
}

/** Cancel this frame's in-progress pick session, if any. Safe to call when there isn't one. */
export function cancelPickMode() {
  activeCancel?.();
}

// Custom players near-universally render a transparent click-catcher and/or
// controls layer as a SIBLING of the actual <video> — both inside a shared
// "player" container a level or two up — rather than wrapping it. Confirmed
// directly on Dailymotion: clicking anywhere on the visible player hits
// div.vod_click or div.controls_layer_1, never the <video> itself, which
// sits next to them under the same parent. Searching only the clicked
// element's own subtree (the old behavior) can never find a sibling —
// searching each ANCESTOR's subtree while walking up does, and still stops
// at the closest match. Capped in depth since this runs on every mousemove.
const MAX_ANCESTOR_SEARCH_DEPTH = 8;

/** Find the <video> nearest to `el`: itself, an ancestor, or under any ancestor up a few levels. */
export function findNearestVideo(el) {
  let node = el;
  let depth = 0;
  while (node && depth < MAX_ANCESTOR_SEARCH_DEPTH) {
    if (node.tagName === "VIDEO") return node;
    const found = collectVideosInSubtree(node);
    if (found.length > 0) return pickPlausibleCandidate(found, el);
    node = node.parentElement;
    depth++;
  }
  return null;
}

function collectVideosInSubtree(root, out = []) {
  if (root.tagName === "VIDEO") {
    out.push(root);
    return out;
  }
  const children = root.children || [];
  for (const child of children) collectVideosInSubtree(child, out);
  if (root.shadowRoot) collectVideosInSubtree(root.shadowRoot, out);
  return out;
}

// Some custom players keep an empty, never-hydrated native <video> tag around
// alongside the real one — e.g. a no-JS/SEO fallback with a blank <source> —
// confirmed directly on a site where the click-catcher's own container held
// exactly that alongside the real player, one level deeper. readyState === 0
// with no currentSrc is a reliable tell that a candidate is that decoy, not
// the one actually playing (autoDetectVideo already filters on this).
function pickPlausibleCandidate(videos, referenceEl) {
  if (videos.length === 1) return videos[0];
  const loaded = videos.filter((v) => v.readyState > 0 || v.currentSrc);
  const pool = loaded.length > 0 ? loaded : videos;
  if (pool.length === 1) return pool[0];
  return closestToElement(pool, referenceEl);
}

// Among several equally-plausible candidates (e.g. the real video plus a
// suggested/preview clip both loaded within the same searched ancestor),
// prefer whichever is geometrically closest to the clicked element instead
// of just the first one encountered in document order.
function closestToElement(videos, referenceEl) {
  if (typeof referenceEl?.getBoundingClientRect !== "function") return videos[0];
  const ref = referenceEl.getBoundingClientRect();
  const refX = (ref.left + ref.right) / 2;
  const refY = (ref.top + ref.bottom) / 2;

  let best = videos[0];
  let bestDist = Infinity;
  for (const v of videos) {
    if (typeof v.getBoundingClientRect !== "function") continue;
    const r = v.getBoundingClientRect();
    const dist = Math.hypot((r.left + r.right) / 2 - refX, (r.top + r.bottom) / 2 - refY);
    if (dist < bestDist) {
      bestDist = dist;
      best = v;
    }
  }
  return best;
}

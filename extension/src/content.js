// Piece 1-2-11 entry point: runs in every frame (all_frames: true). Finds the
// video, lets the user pick one, and relays play/pause/seek/heartbeat to the
// service worker, which owns the actual WebSocket connection (Piece 3/9).
import { autoDetectVideo, computeDescriptor, findVideoByDuration, observeDeep, resolveDescriptor, watchForReplacement } from "./content/video-detector.js";
import { pickVideo, cancelPickMode } from "./content/element-picker.js";
import { VideoController } from "./content/video-controller.js";
import { AdGuard, ClockOffset, compensatedTime, reconcileDrift, startHeartbeat } from "./content/sync-engine.js";
import { createOverlay } from "./content/overlay.js";

const frameUrl = location.href;
const isTopFrame = window === window.top;

// A guest's resolve attempt on late-hydrating SPAs (nothing there yet on the
// first try) retries over this window before falling back to indefinite
// watching (see stopPendingResolve below) — most sites hydrate well within it.
const RESOLVE_RETRY_DELAYS_MS = [300, 800, 1500];

let controller = null;
let stopWatcher = null;
let stopHeartbeat = null;
let adGuard = null;
// Some sites (Netflix-style: browse -> details page -> press play) never
// mount a <video> element until a real person clicks play, whenever they get
// around to it — no fixed retry window can cover that. Once the quick bursts
// above are exhausted, this watches indefinitely instead of giving up (see
// "setDescriptor" below). Cancelled the moment it succeeds, a new descriptor
// arrives, or this frame is told to detach.
let stopPendingResolve = null;
// Host is authoritative from the moment it picks — nothing to wait for. A
// guest starts NOT cleared to report until it's actually been given the
// host's real position (see "setDescriptor" below): otherwise the guest's
// own unsynced video doing whatever it naturally does on load (autoplay from
// 0:00, or just its default paused state) gets reported as a real action and
// broadcast to everyone else, clobbering their position — exactly what
// happened before this existed.
let canReport = false;
const clockOffset = new ClockOffset();

// The floating cinema-style overlay only ever lives in the room's own tab's
// top frame (background.js targets updates there specifically) — never one
// per frame, and never in unrelated tabs.
let overlay = null;

// Duration is meaningful metadata (not loaded yet on preroll ads or before
// metadata fires), used as a secondary matching signal on the resolving side.
function sendableDuration(el) {
  return Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
}

// Announce on every injection (including after a guest navigates to follow
// the host) so the service worker can (re)send the descriptor once this page
// has actually loaded, instead of racing chrome.tabs.update's return value.
chrome.runtime.sendMessage({ event: "contentScriptReady" });

// Playback control (play/pause/seek/heartbeat reporting) is symmetric —
// both host and guest wire it up the same way. `asHost` only still matters
// for onSourceChanged below: picking WHICH video the room watches stays
// host-exclusive, even though controlling playback of it doesn't. It's
// passed explicitly by whichever caller already knows the role (background.js
// knows session.role synchronously) rather than via a follow-up message
// after attach() has already run — that race meant the host's very first
// pick never wired up its own reporting.
function attach(el, asHost) {
  detach();
  controller = new VideoController(el);
  adGuard = new AdGuard();
  canReport = asHost;
  controller.onPlayBlocked = (blocked) => chrome.runtime.sendMessage({ event: "playbackBlocked", blocked });
  stopWatcher = watchForReplacement(el, () => {
    detach();
    // The player got swapped out (SPA navigation). Let the host re-pick, or a
    // guest's next `setDescriptor` message re-resolve automatically.
    chrome.runtime.sendMessage({ event: "videoLost" });
  });

  // loadstart also fires for things that are NOT a real video change: ad
  // breaks commonly swap <video>'s source to the ad creative and back
  // without ever changing the page URL. Only treat it as "the video changed"
  // if the URL changed too — that's what actually distinguishes a genuine
  // SPA video switch (YouTube's "up next") from an ad or a quality/buffer
  // reload of the SAME video. Without this check, every ad break would
  // spuriously re-announce (host) or detach (guest) — the latter breaks
  // sync outright, since nothing re-attaches afterward.
  let lastKnownHref = location.href;
  controller.onSourceChanged = () => {
    if (location.href === lastKnownHref) return; // same page — an ad/quality/buffer event, not a real change
    lastKnownHref = location.href;

    if (asHost) {
      // Still the right element to track — just re-announce it so the room
      // (and guests' auto-follow) picks up the new page/video automatically,
      // instead of requiring the host to click "Select video" again.
      // No pageUrl here — background.js derives it from sender.tab.url,
      // since this frame may not be (and can't always safely know) the top page.
      // frameUrl here must be lastKnownHref (the CURRENT url), not the outer
      // `frameUrl` const — that's captured once at content-script injection
      // and never updated, so on an SPA video swap (no re-injection, e.g.
      // YouTube's "up next") it goes stale. A guest's setDescriptor handler
      // filters on an exact frameUrl match against its own (fresh) location,
      // so a stale value here made it bail out silently forever.
      chrome.runtime.sendMessage({
        event: "videoPicked",
        descriptor: computeDescriptor(el),
        frameUrl: lastKnownHref,
        duration: sendableDuration(el)
      });
    } else {
      // Not the host: this is either a guest's resolved video changing under
      // it, or an unrelated video — either way, stop applying/reporting on it.
      detach();
      chrome.runtime.sendMessage({ event: "videoLost" });
    }
  };

  // Symmetric control: whoever acts locally — host or guest — reports it.
  // The server broadcasts to everyone else and last-writer-wins naturally
  // (see server/src/index.js), so no separate conflict resolution is needed.
  controller.on("play", (state) => reportLocalState(state));
  controller.on("pause", (state) => reportLocalState(state));
  controller.on("seeked", (state) => reportLocalState(state));
  controller.on("ratechange", (state) => reportLocalState(state));
  stopHeartbeat = startHeartbeat(controller, 2000, (heartbeat) => {
    if (!canReport) return; // not yet given the host's real position — nothing legitimate to report
    // Each viewer's ad is independently served/timed — broadcasting position
    // during one seeks everyone else into a meaningless spot on whatever
    // they're currently watching. Detected via duration, not site-specific
    // DOM sniffing (see AdGuard in sync-engine.js).
    if (adGuard.check(controller.el.duration)) return;
    chrome.runtime.sendMessage({ event: "heartbeat", heartbeat });
  });
}

function detach() {
  if (stopWatcher) stopWatcher();
  if (stopHeartbeat) stopHeartbeat();
  if (controller) controller.destroy();
  controller = null;
  stopWatcher = null;
  stopHeartbeat = null;
  adGuard = null;
}

function cancelPendingResolve() {
  if (stopPendingResolve) {
    stopPendingResolve();
    stopPendingResolve = null;
  }
}

function reportLocalState(state) {
  if (!canReport) return; // not yet given the host's real position — nothing legitimate to report
  if (adGuard && adGuard.check(controller.el.duration)) return; // likely mid-ad — don't broadcast it
  chrome.runtime.sendMessage({ event: "localState", state, at: Date.now() });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.cmd) {
    case "enterPickMode": {
      // background.js always knows session.role synchronously, so it's passed
      // directly here rather than arriving via a separate follow-up message.
      const asHost = msg.role === "host";
      pickVideo(isTopFrame).then((el) => {
        if (!el) {
          chrome.runtime.sendMessage({ event: "pickCancelled" });
          return;
        }
        attach(el, asHost);
        const descriptor = computeDescriptor(el);
        // No pageUrl here — background.js derives it from sender.tab.url. The
        // picked video can live in a non-top (even cross-origin) frame, which
        // can't always safely read the top page's own URL itself.
        // location.href (not the outer `frameUrl` const) — a re-pick after an
        // in-page SPA navigation (no content-script re-injection) would
        // otherwise report the page's original, now-stale, URL.
        chrome.runtime.sendMessage({ event: "videoPicked", descriptor, frameUrl: location.href, duration: sendableDuration(el) });
      });
      sendResponse({ ok: true });
      return false;
    }

    case "detach": {
      // background.js confirmed this tab is no longer on the host's page
      // (host moved on, auto-follow off) — stop controlling this video.
      detach();
      cancelPendingResolve();
      sendResponse({ ok: true });
      return false;
    }

    case "cancelPickMode": {
      cancelPickMode();
      sendResponse({ ok: true });
      return false;
    }

    case "setDescriptor": {
      // Guest side only — resolving the host's descriptor onto this frame's video.
      if (msg.frameUrl !== frameUrl) return false;
      cancelPendingResolve(); // a fresh descriptor supersedes anything still being watched for

      const tryResolve = () => {
        let el = resolveDescriptor(msg.descriptor);
        let usedFallback = false;
        if (!el && msg.duration) {
          // Structural match failed but the host told us how long the video
          // is — closer signal than "just pick the biggest one" when there
          // are multiple candidates (main content vs. a recommended-video
          // thumbnail, say).
          el = findVideoByDuration(msg.duration);
          usedFallback = !!el;
        }
        if (!el) {
          // Still nothing — best-effort fallback instead of just giving up,
          // since it's often still right on simpler (single-video) pages.
          el = autoDetectVideo();
          usedFallback = !!el;
        }
        return { el, usedFallback };
      };

      const onFound = (el, usedFallback) => {
        attach(el, false);
        // Land at the host's actual position before allowing this guest to
        // report anything — joining should mean "join the host at his
        // spot," not "everyone jumps to wherever my fresh page happened to
        // start." If there's genuinely nothing to sync to yet (a brand new
        // room, host hasn't pressed play), there's nothing to apply, and
        // canReport still opens up immediately below.
        if (msg.initialState) {
          const currentTime = compensatedTime(
            { currentTime: msg.initialState.currentTime, play: msg.initialState.play, at: msg.initialState.at },
            clockOffset
          );
          controller.applyRemote({ play: msg.initialState.play, rate: msg.initialState.rate, currentTime });
        }
        canReport = true;
        chrome.runtime.sendMessage({ event: "resolved", ok: true, fallback: usedFallback });
      };

      const attempt = (retriesLeft) => {
        const { el, usedFallback } = tryResolve();
        if (el) {
          onFound(el, usedFallback);
          return;
        }

        if (retriesLeft.length > 0) {
          // Nothing there yet — likely a late-hydrating SPA that hasn't
          // mounted the player. Retry a few times before falling back to
          // indefinite watching.
          const [delay, ...rest] = retriesLeft;
          setTimeout(() => attempt(rest), delay);
          return;
        }

        // Quick retries exhausted. Some sites (browse -> details page ->
        // press play, as on Netflix and most streaming-site clones) never
        // mount a <video> at all until a real person clicks play, whenever
        // they get around to it — no fixed window can cover that. Keep
        // watching (shadow-DOM aware, same mechanism as watchForReplacement)
        // instead of giving up; cancelPendingResolve() above/below stops it
        // the moment it succeeds or is superseded.
        chrome.runtime.sendMessage({ event: "resolveWaiting" });
        stopPendingResolve = observeDeep(() => {
          const { el, usedFallback } = tryResolve();
          if (el) {
            cancelPendingResolve();
            onFound(el, usedFallback);
          }
        });
      };

      attempt(RESOLVE_RETRY_DELAYS_MS);
      sendResponse({ ok: true }); // ack receipt only — the real result arrives async via "resolved"/"resolveWaiting"
      return false;
    }

    case "applyState": {
      if (controller) {
        const currentTime = compensatedTime({ currentTime: msg.state.currentTime, play: msg.state.play, at: msg.at }, clockOffset);
        controller.applyRemote({ play: msg.state.play, rate: msg.state.rate, currentTime });
      }
      sendResponse({ ok: !!controller });
      return false;
    }

    case "applyHeartbeat": {
      if (controller) {
        const result = reconcileDrift(controller, msg.heartbeat, clockOffset);
        // Most of the sync engine's work is otherwise invisible — surface it.
        chrome.runtime.sendMessage({ event: "driftStatus", action: result.action, gap: result.gap });
        sendResponse({ ok: true, result });
      } else {
        sendResponse({ ok: false });
      }
      return false;
    }

    case "clockSample": {
      clockOffset.sample(msg.pong);
      sendResponse({ ok: true });
      return false;
    }

    case "updateOverlay": {
      // Only the top frame renders it — a video living in a child/cross-origin
      // frame (e.g. Dailymotion's player) still gets a top-frame-positioned overlay.
      if (!isTopFrame) {
        sendResponse({ ok: true });
        return false;
      }
      if (!msg.session) {
        if (overlay) {
          overlay.destroy();
          overlay = null;
        }
        sendResponse({ ok: true });
        return false;
      }
      if (!overlay) {
        overlay = createOverlay({
          onPickVideo: () => chrome.runtime.sendMessage({ event: "overlayPickVideo" }),
          onOpenHostPage: () => chrome.runtime.sendMessage({ event: "overlayOpenHostPage" }),
          onLeaveRoom: () => chrome.runtime.sendMessage({ event: "overlayLeaveRoom" })
        });
      }
      overlay.update(msg.session);
      sendResponse({ ok: true });
      return false;
    }

    default:
      return false;
  }
});

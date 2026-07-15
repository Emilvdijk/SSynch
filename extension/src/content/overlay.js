// Floating in-page "cinema" companion to the side panel — status + basic
// controls rendered directly on the video's own page. Shadow-DOM encapsulated
// so the host page's CSS can't bleed in (and this overlay's styles can't leak
// out onto the page either). Only ever instantiated in the room's own tab's
// top frame (see content.js) — one overlay, one place, no duplicates.

const HOST_ID = "__ssynch-overlay-host__";
// Global (not per-site/room) — a dragged position is a UI preference the
// user set once, not something tied to a particular page or room.
const POSITION_STORAGE_KEY = "ssynchOverlayPosition";

const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .card {
    position: relative;
    width: 230px;
    background: rgba(18, 18, 22, 0.78);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 14px;
    padding: 12px;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #f2f2f2;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  }
  .card.collapsed { display: none; }
  .row { display: flex; align-items: center; gap: 6px; }
  .title-row {
    /* Negative margins pull the row's box out to the card's own edges (its
       top/left/right padding included) so the FULL top strip is draggable,
       not just the row's own content width; the explicit width (matching
       .card's own 230px) plus matching padding keeps the actual content
       (dot/role/code/buttons) rendered at exactly the same position/width
       as before — the negative margins alone would otherwise also eat into
       the available content width, not just reposition the box. */
    width: 230px;
    margin: -12px -12px 8px -12px;
    padding: 12px 12px 0 12px;
    border-radius: 14px 14px 0 0;
    cursor: grab;
    user-select: none;
  }
  .title-row.dragging { cursor: grabbing; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b6b70; flex: none; }
  .dot.connected { background: #34d399; }
  .dot.reconnecting { background: #eab308; }
  .role { font-weight: 600; letter-spacing: 0.2px; text-transform: uppercase; font-size: 11px; opacity: 0.9; }
  .code { margin-left: auto; opacity: 0.55; font-size: 11px; letter-spacing: 1px; }
  .copy-btn {
    flex: none;
    width: 18px;
    height: 18px;
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.08);
    border: none;
    color: #ccc;
    cursor: pointer;
    font-size: 11px;
    line-height: 1;
    padding: 0;
  }
  .copy-btn:hover { background: rgba(255, 255, 255, 0.16); color: #fff; }
  .collapse-btn {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08);
    border: none;
    color: #ccc;
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
    padding: 0;
  }
  .collapse-btn:hover { background: rgba(255, 255, 255, 0.16); color: #fff; }
  .status {
    opacity: 0.85;
    font-size: 12px;
    white-space: pre-line;
    margin-bottom: 10px;
    min-height: 16px;
  }
  .pick-btn {
    width: 100%;
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 7px;
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
    margin-bottom: 6px;
  }
  .pick-btn:hover { background: rgba(255, 255, 255, 0.16); }
  .pick-btn.hidden { display: none; }
  .open-host-btn {
    width: 100%;
    background: rgba(79, 140, 255, 0.16);
    color: #cfe0ff;
    border: 1px solid rgba(79, 140, 255, 0.35);
    border-radius: 8px;
    padding: 7px;
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
    margin-bottom: 6px;
  }
  .open-host-btn:hover { background: rgba(79, 140, 255, 0.26); }
  .open-host-btn.hidden { display: none; }
  .leave-btn {
    width: 100%;
    background: transparent;
    color: #f0806a;
    border: 1px solid rgba(240, 128, 106, 0.35);
    border-radius: 8px;
    padding: 5px;
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
  }
  .leave-btn:hover { background: rgba(240, 128, 106, 0.1); }
  .pill {
    display: none;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: rgba(18, 18, 22, 0.78);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    border: 1px solid rgba(255, 255, 255, 0.09);
    color: #fff;
    align-items: center;
    justify-content: center;
    cursor: grab;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    font-size: 16px;
    user-select: none;
  }
  .pill.show { display: flex; }
  .pill.dragging { cursor: grabbing; }
`;

const DRIFT_LABELS = { seek: "correcting…", nudge: "adjusting…", hold: "in sync" };

/** Move `hostEl` to (left, top), clamped so it can't be dragged (or restored) off-screen. */
function positionAt(hostEl, left, top) {
  const width = hostEl.offsetWidth;
  const height = hostEl.offsetHeight;
  const maxLeft = Math.max(0, window.innerWidth - width);
  const maxTop = Math.max(0, window.innerHeight - height);
  const clampedLeft = Math.min(Math.max(0, left), maxLeft);
  const clampedTop = Math.min(Math.max(0, top), maxTop);
  Object.assign(hostEl.style, { left: `${clampedLeft}px`, top: `${clampedTop}px`, right: "auto", bottom: "auto" });
}

// A pointerdown that never moves past this is treated as a click, not a
// drag — matters for the pill, which is both the drag handle AND has its
// own "click to expand" behavior.
const DRAG_THRESHOLD_PX = 4;

/**
 * Drag-to-reposition via `handleEl` (the title row, or the collapsed pill).
 * Bottom-right (the default corner) is exactly where a lot of players put
 * their own fullscreen/settings/PiP controls, so a fixed spot inevitably
 * gets in the way on some sites. The dragged position is remembered
 * (chrome.storage.local) across pages/restarts.
 *
 * `onClick`, if given, fires instead of a drag when the pointer never moved
 * past the threshold — used by the pill so dragging it doesn't also expand
 * it, but a genuine click still does.
 */
function setUpDragging(hostEl, handleEl, { onClick } = {}) {
  let pointerId = null;
  let grabOffsetX = 0;
  let grabOffsetY = 0;
  let startX = 0;
  let startY = 0;
  let dragged = false;

  handleEl.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return; // let the copy/collapse buttons handle their own clicks
    const rect = hostEl.getBoundingClientRect();
    grabOffsetX = e.clientX - rect.left;
    grabOffsetY = e.clientY - rect.top;
    startX = e.clientX;
    startY = e.clientY;
    dragged = false;
    pointerId = e.pointerId;
    // setPointerCapture can throw in edge cases (e.g. the pointer having
    // already been released by the time this runs) — never let that abort
    // the rest of the drag/click logic below.
    try {
      handleEl.setPointerCapture(pointerId);
    } catch {
      // no-op: the pointermove/pointerup listeners below don't depend on
      // capture actually having been established, since they're already
      // attached directly to handleEl.
    }
  });

  handleEl.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId) return;
    if (!dragged && Math.hypot(e.clientX - startX, e.clientY - startY) > DRAG_THRESHOLD_PX) {
      dragged = true;
      handleEl.classList.add("dragging");
    }
    if (dragged) positionAt(hostEl, e.clientX - grabOffsetX, e.clientY - grabOffsetY);
  });

  const endDrag = (e) => {
    if (e.pointerId !== pointerId) return;
    // Same reasoning as setPointerCapture above — must not abort before the
    // click/save logic below, which is the entire point of this handler.
    try {
      handleEl.releasePointerCapture(pointerId);
    } catch {
      // no-op
    }
    handleEl.classList.remove("dragging");
    pointerId = null;
    if (dragged) {
      const rect = hostEl.getBoundingClientRect();
      chrome.storage.local.set({ [POSITION_STORAGE_KEY]: { left: rect.left, top: rect.top } });
    } else {
      onClick?.();
    }
  };
  handleEl.addEventListener("pointerup", endDrag);
  handleEl.addEventListener("pointercancel", endDrag);
}

export function createOverlay({ onPickVideo, onOpenHostPage, onLeaveRoom }) {
  let hostEl = document.getElementById(HOST_ID);
  let shadow;

  if (hostEl && hostEl.shadowRoot) {
    shadow = hostEl.shadowRoot;
  } else {
    if (hostEl) hostEl.remove(); // stale non-shadow leftover, shouldn't normally happen
    hostEl = document.createElement("div");
    hostEl.id = HOST_ID;
    Object.assign(hostEl.style, { position: "fixed", bottom: "16px", right: "16px", zIndex: "2147483647" });
    document.documentElement.appendChild(hostEl);
    shadow = hostEl.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="card" id="card">
        <div class="row title-row" id="titleRow">
          <span class="dot" id="dot"></span>
          <span class="role" id="role"></span>
          <span class="code" id="code"></span>
          <button class="copy-btn" id="copyBtn" title="Copy room code">⧉</button>
          <button class="collapse-btn" id="collapseBtn" title="Collapse">–</button>
        </div>
        <div class="status" id="status"></div>
        <button class="pick-btn" id="pickBtn">Select video on this page</button>
        <button class="open-host-btn" id="openHostBtn">Open host's page</button>
        <button class="leave-btn" id="leaveBtn">Leave room</button>
      </div>
      <div class="pill" id="pill" title="Expand">▶</div>
    `;

    const card = shadow.getElementById("card");
    const pill = shadow.getElementById("pill");

    shadow.getElementById("collapseBtn").addEventListener("click", () => {
      card.classList.add("collapsed");
      pill.classList.add("show");
    });
    shadow.getElementById("copyBtn").addEventListener("click", async () => {
      const btn = shadow.getElementById("copyBtn");
      await navigator.clipboard.writeText(shadow.getElementById("code").textContent);
      const original = btn.textContent;
      btn.textContent = "✓";
      setTimeout(() => { btn.textContent = original; }, 1200);
    });
    shadow.getElementById("pickBtn").addEventListener("click", () => onPickVideo());
    shadow.getElementById("openHostBtn").addEventListener("click", () => onOpenHostPage());
    shadow.getElementById("leaveBtn").addEventListener("click", () => onLeaveRoom());

    setUpDragging(hostEl, shadow.getElementById("titleRow"));
    setUpDragging(hostEl, pill, {
      onClick: () => {
        card.classList.remove("collapsed");
        pill.classList.remove("show");
      }
    });
    chrome.storage.local.get(POSITION_STORAGE_KEY).then((stored) => {
      const pos = stored[POSITION_STORAGE_KEY];
      if (pos) positionAt(hostEl, pos.left, pos.top);
    });
  }

  function update(session) {
    const dot = shadow.getElementById("dot");
    dot.className = "dot" + (session.reconnecting ? " reconnecting" : session.connected ? " connected" : "");

    shadow.getElementById("role").textContent = session.role;
    shadow.getElementById("code").textContent = session.code;

    // Only the host's pick gets broadcast to the room — same reasoning as
    // the side panel hiding this for guests (see sidepanel.js).
    shadow.getElementById("pickBtn").classList.toggle("hidden", session.role !== "host");

    // Same condition as the side panel's equivalent button: guest, and the
    // host is known to be on a different page than this tab currently shows.
    const showOpenHostPage = session.role === "guest" && !!session.pendingNavigation;
    shadow.getElementById("openHostBtn").classList.toggle("hidden", !showOpenHostPage);

    const lines = [];
    if (session.reconnecting) lines.push(`Reconnecting… (attempt ${session.reconnectAttempt ?? 1})`);
    else if (session.justReconnected) lines.push("Reconnected ✓");
    else if (!session.connected) lines.push("Connecting…");

    if (!session.descriptor) {
      lines.push(session.role === "guest" ? "Waiting for host's video…" : "No video selected yet");
    } else if (session.videoResolved === true) {
      if (session.driftStatus) lines.push(`Sync: ${DRIFT_LABELS[session.driftStatus.action] || session.driftStatus.action}`);
      else lines.push("Attached — controllable");
    } else if (session.videoResolved === false) {
      lines.push("Not currently synced");
    } else if (session.awaitingPlayback) {
      lines.push("No video yet — press play here");
    } else {
      lines.push("Confirming…");
    }

    if (session.playbackBlocked) lines.push("Playback blocked — click the page to allow it");
    if (showOpenHostPage) lines.push("Host is watching a different page");
    lines.push(`${session.peers ?? 0} watching`);

    shadow.getElementById("status").textContent = lines.join("\n");
  }

  function destroy() {
    hostEl.remove();
  }

  return { update, destroy };
}

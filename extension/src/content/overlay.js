// Floating in-page "cinema" companion to the side panel — status + basic
// controls rendered directly on the video's own page. Shadow-DOM encapsulated
// so the host page's CSS can't bleed in (and this overlay's styles can't leak
// out onto the page either). Only ever instantiated in the room's own tab's
// top frame (see content.js) — one overlay, one place, no duplicates.

const HOST_ID = "__ssynch-overlay-host__";

const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .card {
    position: relative;
    width: 230px;
    background: rgba(18, 18, 22, 0.88);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 14px;
    padding: 12px;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #f2f2f2;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  }
  .card.collapsed { display: none; }
  .row { display: flex; align-items: center; gap: 6px; }
  .title-row { margin-bottom: 8px; }
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
    background: rgba(18, 18, 22, 0.88);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.09);
    color: #fff;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    font-size: 16px;
  }
  .pill.show { display: flex; }
`;

const DRIFT_LABELS = { seek: "correcting…", nudge: "adjusting…", hold: "in sync" };

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
        <div class="row title-row">
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
    pill.addEventListener("click", () => {
      card.classList.remove("collapsed");
      pill.classList.remove("show");
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

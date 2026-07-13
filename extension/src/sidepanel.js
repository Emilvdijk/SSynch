// Piece 4: side panel UI. Everything here is messaging into the service worker;
// no state lives in this page (it can close/reopen freely).
import { Role } from "./shared/protocol.js";

const $ = (id) => document.getElementById(id);

const noRoom = $("noRoom");
const inRoom = $("inRoom");
const roomCode = $("roomCode");
const copyCodeBtn = $("copyCodeBtn");
const statusEl = $("status");
const autoFollowRow = $("autoFollowRow");
const autoFollowCheck = $("autoFollowCheck");
const openHostPageBtn = $("openHostPageBtn");
const pickBtn = $("pickBtn");
const debugDump = $("debugDump");

const DRIFT_LABELS = { seek: "correcting (seeking)", nudge: "correcting (rate nudge)", hold: "in sync" };

function render(session, extra = {}) {
  if (!session) {
    noRoom.classList.remove("hidden");
    inRoom.classList.add("hidden");
    statusEl.textContent = extra.error || "";
    if (debugDump) debugDump.textContent = "(no active room)";
    return;
  }

  noRoom.classList.add("hidden");
  inRoom.classList.remove("hidden");
  roomCode.textContent = session.code;

  const isGuest = session.role === Role.GUEST;
  // Only the host's pick gets broadcast to the room — a guest picking locally
  // just silently diverges their own tracking state instead of following the
  // host's descriptor, which is confusing and never what a guest wants.
  pickBtn.classList.toggle("hidden", isGuest);
  autoFollowRow.classList.toggle("hidden", !isGuest);
  autoFollowCheck.checked = !!session.autoFollow;
  const showOpenHostPage = isGuest && !!session.pendingNavigation;
  openHostPageBtn.classList.toggle("hidden", !showOpenHostPage);

  let connectionLine;
  if (session.justReconnected) connectionLine = "Reconnected ✓";
  else if (session.reconnecting) connectionLine = `Reconnecting… (attempt ${session.reconnectAttempt ?? 1})`;
  else connectionLine = session.connected ? "Connected" : "Connecting…";

  const lines = [`Role: ${session.role}`, connectionLine, `Peers: ${session.peers ?? 0}`];
  if (session.descriptor) {
    if (session.videoResolved === true) {
      lines.push(
        session.videoResolvedVia === "fallback"
          ? "Video attached — best-effort match, double-check it's the right one"
          : "Video attached — controllable"
      );
    } else if (session.videoResolved === false) lines.push("Not currently synced to the host's video.");
    else if (session.awaitingPlayback) lines.push("No video on the page yet — press play here, sync will pick it up automatically.");
    else lines.push("Video linked — confirming…");
  } else if (isGuest) {
    lines.push("Waiting for the host to select a video.");
  } else {
    lines.push('No video selected yet — click "Select video on this page."');
  }
  if (session.playbackBlocked) {
    lines.push("Playback blocked by the browser — click anywhere on the page (not this panel) to allow it to play.");
  }
  if (extra.videoLost) lines.push("Video element disappeared (page navigated?) — pick again.");
  if (showOpenHostPage) lines.push(`Host is watching a different page:\n${session.pendingNavigation}`);
  if (session.videoResolved === true && session.driftStatus) {
    const label = DRIFT_LABELS[session.driftStatus.action] || session.driftStatus.action;
    lines.push(`Sync: ${label} (${session.driftStatus.gap >= 0 ? "+" : ""}${session.driftStatus.gap.toFixed(2)}s)`);
  }
  if (session.connected && session.lastActivityAt) {
    const secs = Math.max(0, Math.round((Date.now() - session.lastActivityAt) / 1000));
    lines.push(`Last update: ${secs}s ago`);
  }
  if (session.lastError) lines.push(session.lastError);

  statusEl.textContent = lines.join("\n");
  if (debugDump) debugDump.textContent = JSON.stringify(session, null, 2);
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ action: "getStatus" });
  render(res?.session);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "statusUpdate") render(msg.session, msg);
});

$("createBtn").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ action: "createRoom", name: "Host" });
  render(res.session);
});

$("joinBtn").addEventListener("click", async () => {
  const code = $("joinCodeInput").value.trim();
  if (!code) return;
  const res = await chrome.runtime.sendMessage({ action: "joinRoom", code, name: "Guest" });
  render(res.session);
});

$("pickBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "pickVideo" });
});

copyCodeBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(roomCode.textContent);
  const original = copyCodeBtn.textContent;
  copyCodeBtn.textContent = "✓";
  setTimeout(() => { copyCodeBtn.textContent = original; }, 1200);
});

$("leaveBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "leaveRoom" });
  render(null);
});

autoFollowCheck.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({ action: "setAutoFollow", value: autoFollowCheck.checked });
});

openHostPageBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "openHostPage" });
});

refresh();

// Belt-and-suspenders: the panel also updates live via the "statusUpdate"
// push from the service worker, but polling catches anything that push
// missed (e.g. the panel wasn't mounted at the exact instant it fired).
setInterval(refresh, 2000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});

// Piece 3 + Piece 9: the service worker owns the WebSocket to the Room Durable
// Object and relays between the side panel UI, the content script in the
// active tab, and the server. It survives navigations but MV3 can still evict
// it when idle, so all room identity is persisted to chrome.storage.session
// and reloaded on every (re)start of this file.
import { wsUrlForRoom } from "./shared/config.js";
import { MessageType, Role } from "./shared/protocol.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const PING_REFRESH_MS = 30000;

/** @type {WebSocket | null} */
let socket = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let lastPingAt = 0;

/**
 * session shape:
 * { code, role, name, connected, peers, descriptor, frameUrl, pageUrl, duration, tabId,
 *   autoFollow, lastKnownState: {play, currentTime, rate, at} | null }
 */
let session = null;

async function loadSession() {
  const stored = await chrome.storage.session.get("session");
  session = stored.session || null;
}

async function saveSession() {
  if (session) await chrome.storage.session.set({ session });
  else await chrome.storage.session.remove("session");
}

function makeRoomCode(length = 6) {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

// "No receiver" is the expected, common case (side panel closed, or a frame
// with no content script) — not a bug. Anything else is unexpected and was
// previously swallowed by a blanket .catch(() => {}), which is exactly why
// genuine failures showed up in NO console at all. Log those specifically.
function logIfUnexpected(context, err) {
  const benign = /Receiving end does not exist|message channel closed|context invalidated/i.test(err?.message || "");
  if (!benign) console.error(`[ssynch] ${context}:`, err);
}

function notifyUI(patch) {
  chrome.runtime.sendMessage({ type: "statusUpdate", session, ...patch }).catch((err) => logIfUnexpected("notifyUI", err));
  // Targeted (not broadcast) — only the room's own tab should ever show the
  // floating overlay, never some unrelated open tab.
  if (session?.tabId != null) {
    sendToTab(session.tabId, { cmd: "updateOverlay", session });
  }
}

function sendToTab(tabId, message, frameId) {
  const options = typeof frameId === "number" ? { frameId } : undefined;
  return chrome.tabs.sendMessage(tabId, message, options).catch((err) => logIfUnexpected(`sendToTab(${tabId}, ${message.cmd})`, err));
}

function sendToServer(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

// Strip only the hash fragment before comparing "is this the same page" —
// fragments are near-universally scroll/UI state, not video identity, but
// the query string is left intact since that's exactly where YouTube (?v=)
// and Twitch (clip=) encode which video you're on. An exact full-string
// match would also false-negative on harmless tracking-param differences
// between the host's and guest's address bar for what's genuinely the same page.
function normalizePageUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// WebSocket lifecycle (Piece 9)
// ---------------------------------------------------------------------------

function connect() {
  if (!session) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  let url;
  try {
    url = wsUrlForRoom(session.code);
  } catch (err) {
    session.lastError = err.message;
    saveSession();
    notifyUI({});
    return;
  }

  session.lastError = null;

  socket = new WebSocket(url);

  socket.onopen = () => {
    const wasReconnecting = !!session.reconnecting;
    reconnectAttempts = 0;
    sendToServer({ type: MessageType.HELLO, role: session.role, name: session.name });
    lastPingAt = Date.now();
    sendToServer({ type: MessageType.PING, t0: lastPingAt });
    if (session.role === Role.HOST && session.descriptor) {
      sendToServer({
        type: MessageType.SET_VIDEO,
        descriptor: session.descriptor,
        frameUrl: session.frameUrl,
        pageUrl: session.pageUrl
      });
    }
    session.connected = true;
    session.lastError = null;
    session.reconnecting = false;
    session.reconnectAttempt = 0;
    // Transient confirmation so a recovered drop is visible, not just silent —
    // a lot of the reconnect machinery is otherwise invisible to the user.
    session.justReconnected = wasReconnecting;
    saveSession();
    notifyUI({});
    if (wasReconnecting) {
      setTimeout(() => {
        if (!session) return;
        session.justReconnected = false;
        saveSession();
        notifyUI({});
      }, 4000);
    }
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  };

  socket.onclose = (event) => {
    if (session) {
      session.connected = false;
      // 1006 = abnormal closure (couldn't reach the host at all — most likely
      // cause: SERVER_HOST points at nothing listening, or ws/wss mismatch).
      session.lastError = event.code === 1006
        ? "Couldn't reach the server — check SERVER_HOST in shared/config.js and that it's running."
        : `Disconnected (${event.code}${event.reason ? `: ${event.reason}` : ""})`;
    }
    saveSession();
    notifyUI({});
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose always follows onerror for a WebSocket and carries the close code; handled there.
  };
}

function scheduleReconnect() {
  if (!session) return;
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts++;
  session.reconnecting = true;
  session.reconnectAttempt = reconnectAttempts;
  saveSession();
  notifyUI({});
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
}

// Shared by the side panel's "Leave room" button and the overlay's — nulling
// `session` means notifyUI()'s normal targeted overlay update can't fire
// (there's no session.tabId anymore), so the old tab is told explicitly.
async function leaveRoom() {
  const tabId = session?.tabId;
  disconnect();
  session = null;
  await saveSession();
  if (tabId != null) sendToTab(tabId, { cmd: "updateOverlay", session: null });
}

// ---------------------------------------------------------------------------
// Server -> extension (Piece 9 + Piece 10 guest linking + Piece 11 sync)
// ---------------------------------------------------------------------------

function handleServerMessage(msg) {
  // Live "is anything actually happening" indicator — a lot of the protocol
  // is otherwise invisible. Kept in-memory only (not worth a disk write per
  // message); the side panel's own poll picks it up within ~2s regardless.
  if (session && msg.type !== MessageType.PONG) session.lastActivityAt = Date.now();

  switch (msg.type) {
    case MessageType.PONG: {
      if (session?.tabId != null) sendToTab(session.tabId, { cmd: "clockSample", pong: { t0: msg.t0, t1: msg.t1 } }, session.frameId);
      break;
    }

    case MessageType.SYNC: {
      session.descriptor = msg.descriptor;
      session.frameUrl = msg.frameUrl;
      session.pageUrl = msg.pageUrl;
      session.duration = msg.duration ?? null;
      session.videoResolved = null; // pending: this frame hasn't tried resolving it yet
      // Cached so a later resolve (e.g. a fresh page load after auto-follow
      // navigates) can still apply the host's position — see resolveOnTab.
      // Absent (not just falsy) when nobody has ever pressed play in this
      // room yet — nothing to sync new joiners to.
      session.lastKnownState = "play" in msg ? { play: msg.play, currentTime: msg.currentTime, rate: msg.rate, at: msg.at } : null;
      saveSession();
      ensureGuestOnPage(msg);
      notifyUI({});
      break;
    }

    case MessageType.STATE: {
      if (session?.tabId != null) {
        sendToTab(session.tabId, { cmd: "applyState", state: { play: msg.play, currentTime: msg.currentTime, rate: msg.rate }, at: msg.at }, session.frameId);
      }
      break;
    }

    case MessageType.HEARTBEAT: {
      if (session?.tabId != null) {
        sendToTab(session.tabId, { cmd: "applyHeartbeat", heartbeat: { currentTime: msg.currentTime, at: msg.at } }, session.frameId);
      }
      // Piggyback a clock-offset refresh on heartbeats rather than a standalone
      // timer — heartbeats only flow while playing, so this inherits the same
      // "no traffic while paused" property that lets the Durable Object hibernate.
      const now = Date.now();
      if (now - lastPingAt > PING_REFRESH_MS) {
        lastPingAt = now;
        sendToServer({ type: MessageType.PING, t0: now });
      }
      break;
    }

    case MessageType.PEERS: {
      console.debug("[ssynch] peers update:", msg.count);
      session.peers = msg.count;
      saveSession();
      notifyUI({});
      break;
    }
  }
}

/** Piece 10: get a guest onto the host's page/frame, then ask its content script to resolve the descriptor. */
async function ensureGuestOnPage(sync) {
  if (session.role !== Role.GUEST || !sync.pageUrl) return;

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) return;

  const onRightPage = normalizePageUrl(activeTab.url) === normalizePageUrl(sync.pageUrl);
  session.tabId = activeTab.id;
  // Persisted (not a one-off broadcast extra) so the side panel shows it
  // correctly even after a poll/reopen, and it clears itself once resolved.
  session.pendingNavigation = onRightPage ? null : sync.pageUrl;
  await saveSession();
  notifyUI({});

  if (!onRightPage) {
    // The host moved on (new page/video) — sever control of whatever this
    // tab was showing before, immediately, rather than leaving it applying
    // stale commands until (or instead of) a navigation happens.
    session.videoResolved = false;
    await saveSession();
    sendToTab(activeTab.id, { cmd: "detach" });

    if (session.autoFollow) {
      await chrome.tabs.update(activeTab.id, { url: sync.pageUrl });
      // Don't resolve here: chrome.tabs.update resolves once navigation is
      // *initiated*, not once the new page's content script has loaded. The
      // new page announces itself via "contentScriptReady" below, which is
      // when resolution actually happens — avoids racing the page load.
    }
    return;
  }

  resolveOnTab(session.tabId, sync.descriptor, sync.frameUrl, sync.duration);
}

function resolveOnTab(tabId, descriptor, frameUrl, duration) {
  // frameId omitted: broadcast to every frame in the tab. Only the frame whose
  // location matches frameUrl will actually resolve (content.js self-filters).
  // lastKnownState rides along so the guest lands at the host's actual
  // position instead of wherever their freshly (re)loaded video happens to
  // start; duration lets it fall back to a duration match if the structural
  // descriptor fails (see findVideoByDuration in video-detector.js).
  sendToTab(tabId, {
    cmd: "setDescriptor",
    descriptor,
    frameUrl,
    initialState: session.lastKnownState || null,
    duration: duration ?? session.duration ?? null
  });
}

// ---------------------------------------------------------------------------
// UI (side panel) -> background
// ---------------------------------------------------------------------------

async function handleUiMessage(msg, sendResponse) {
  switch (msg.action) {
    case "getStatus": {
      sendResponse({ session });
      break;
    }

    case "createRoom": {
      disconnect();
      session = { code: makeRoomCode(), role: Role.HOST, name: msg.name || "Host", connected: false, peers: 0, autoFollow: false };
      await saveSession();
      connect();
      sendResponse({ session });
      break;
    }

    case "joinRoom": {
      disconnect();
      // Defaults on: "follow the host with zero effort" is the expected common case.
      session = { code: msg.code.toUpperCase(), role: Role.GUEST, name: msg.name || "Guest", connected: false, peers: 0, autoFollow: msg.autoFollow !== false };
      await saveSession();
      connect();
      sendResponse({ session });
      break;
    }

    case "leaveRoom": {
      await leaveRoom();
      sendResponse({ ok: true });
      break;
    }

    case "pickVideo": {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab || !session) {
        sendResponse({ ok: false, error: "No active room or tab" });
        break;
      }
      session.tabId = activeTab.id;
      await saveSession();
      await sendToTab(activeTab.id, { cmd: "enterPickMode", role: session.role });
      sendResponse({ ok: true });
      break;
    }

    case "setAutoFollow": {
      if (session) {
        session.autoFollow = !!msg.value;
        await saveSession();
        // Act immediately rather than waiting for the next "sync" — the user
        // just checked the box specifically because they're on the wrong page now.
        if (session.autoFollow && session.pendingNavigation) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab) {
            session.tabId = activeTab.id;
            await saveSession();
            await chrome.tabs.update(activeTab.id, { url: session.pendingNavigation });
          }
        }
      }
      sendResponse({ ok: true });
      break;
    }

    case "openHostPage": {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && session?.pageUrl) {
        session.tabId = activeTab.id;
        await saveSession();
        await chrome.tabs.update(activeTab.id, { url: session.pageUrl });
      }
      sendResponse({ ok: true });
      break;
    }

    default:
      sendResponse({ ok: false, error: `unknown action: ${msg.action}` });
  }
}

// ---------------------------------------------------------------------------
// Content script -> background
// ---------------------------------------------------------------------------

function handleContentMessage(msg, sender) {
  if (!session) return;

  switch (msg.event) {
    case "videoPicked": {
      session.descriptor = msg.descriptor;
      session.frameUrl = msg.frameUrl;
      session.frameId = sender.frameId;
      session.tabId = sender.tab.id;
      session.videoResolved = true; // content.js already called attach() before sending this
      // sender.tab.url (from the tabs API, no cross-origin restriction) is
      // always the real top-level URL — unlike asking the picking frame to
      // report its own location, which is null/wrong whenever the video
      // lives in a non-top (or cross-origin) iframe, as it commonly does
      // (confirmed on Dailymotion: the picked <video> was inside
      // geo.dailymotion.com, a different origin from the page itself).
      session.pageUrl = sender.tab.url;
      session.duration = msg.duration ?? null;
      saveSession();
      if (session.role === Role.HOST) {
        sendToServer({ type: MessageType.SET_VIDEO, descriptor: msg.descriptor, frameUrl: msg.frameUrl, pageUrl: session.pageUrl, duration: session.duration });
      }
      // enterPickMode went to every frame in the tab; tell the others to stand down.
      sendToTab(sender.tab.id, { cmd: "cancelPickMode" });
      notifyUI({});
      break;
    }

    case "localState": {
      // Symmetric control: either role's play/pause/seek gets relayed —
      // see the matching server-side change in server/src/index.js.
      sendToServer({ type: MessageType.STATE, play: msg.state.play, currentTime: msg.state.currentTime, rate: msg.state.rate, at: msg.at });
      break;
    }

    case "heartbeat": {
      sendToServer({ type: MessageType.HEARTBEAT, currentTime: msg.heartbeat.currentTime, at: msg.heartbeat.at });
      break;
    }

    case "driftStatus": {
      // In-memory only (fires ~every 2s while playing) — deliberately not
      // persisted/broadcast on its own; it rides along on the next status poll.
      session.driftStatus = { action: msg.action, gap: msg.gap };
      break;
    }

    case "resolved": {
      session.videoResolved = msg.ok;
      // Structural match failed but a best-effort (largest visible video)
      // fallback found something — likely right, but worth flagging so the
      // user knows to double-check rather than silently trusting it fully.
      session.videoResolvedVia = msg.ok ? (msg.fallback ? "fallback" : "descriptor") : null;
      if (msg.ok) session.pendingNavigation = null;
      saveSession();
      notifyUI({});
      break;
    }

    case "playbackBlocked": {
      session.playbackBlocked = msg.blocked;
      saveSession();
      notifyUI({});
      break;
    }

    case "contentScriptReady": {
      // Fires on every (re)injection, including after a guest navigates to
      // follow the host — this is what actually triggers resolution on the
      // new page, instead of racing chrome.tabs.update's return value.
      if (
        session.role === Role.GUEST &&
        session.descriptor &&
        sender.tab.id === session.tabId &&
        sender.url === session.frameUrl
      ) {
        resolveOnTab(sender.tab.id, session.descriptor, session.frameUrl);
      }
      break;
    }

    case "pickCancelled": {
      // Escape in one frame should exit pick mode everywhere in the tab, not just there.
      sendToTab(sender.tab.id, { cmd: "cancelPickMode" });
      notifyUI({ pickCancelled: true });
      break;
    }

    case "videoLost": {
      session.videoResolved = false;
      if (session.role === Role.HOST) {
        // Genuinely gone (element removed), not just a source swap (that
        // case re-announces instead) — drop the stale descriptor/pageUrl,
        // mirroring the chrome.tabs.onUpdated staleness handling below.
        session.descriptor = null;
        session.frameUrl = null;
        session.pageUrl = null;
        session.frameId = null;
        sendToServer({ type: MessageType.CLEAR_VIDEO });
      }
      saveSession();
      notifyUI({ videoLost: true });
      break;
    }

    // From the floating in-page overlay. Playback commands relay to whichever
    // frame actually holds the video (session.frameId) — the overlay always
    // renders in the top frame for consistent positioning, but the video
    // itself may live in a different (even cross-origin) frame, as it does
    // on Dailymotion.
    case "overlayTogglePlayback": {
      if (session.tabId != null) sendToTab(session.tabId, { cmd: "nativeTogglePlayback" }, session.frameId);
      break;
    }

    case "overlaySeek": {
      if (session.tabId != null) sendToTab(session.tabId, { cmd: "nativeSeek", delta: msg.delta }, session.frameId);
      break;
    }

    case "overlayLeaveRoom": {
      leaveRoom();
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// Host navigated away from the page their video was on, without re-picking —
// drop the now-stale descriptor/pageUrl (both locally and on the server) so
// "Open host's page" and guest resolution don't point at a dead page.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!session || session.role !== Role.HOST) return;
  if (tabId !== session.tabId) return;
  if (!changeInfo.url || normalizePageUrl(changeInfo.url) === normalizePageUrl(session.pageUrl)) return;

  session.descriptor = null;
  session.frameUrl = null;
  session.pageUrl = null;
  session.frameId = null;
  session.videoResolved = false;
  saveSession();
  notifyUI({});
  sendToServer({ type: MessageType.CLEAR_VIDEO });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab) {
    handleContentMessage(msg, sender);
    return false;
  }
  if (msg.action) {
    handleUiMessage(msg, sendResponse);
    return true; // keep the channel open for the async sendResponse
  }
  return false;
});

// Re-establish the socket whenever the service worker (re)starts, using
// whatever room identity survived in chrome.storage.session.
loadSession().then(() => {
  if (session?.code) connect();
});

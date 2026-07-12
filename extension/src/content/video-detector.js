// Piece 1: finds candidate <video> elements (including inside open shadow roots)
// and builds/resolves a stable descriptor so a different machine can find "the same" element.

/** Recursively collect every <video> in `root`, piercing open shadow roots. */
export function findAllVideos(root = document) {
  const videos = [];
  const walk = (node) => {
    if (node.tagName === "VIDEO") videos.push(node);
    const children = node.children || [];
    for (const child of children) walk(child);
    if (node.shadowRoot) walk(node.shadowRoot);
  };
  // document itself has no `.tagName`; start from its children.
  const roots = root === document ? Array.from(document.children) : [root];
  for (const r of roots) walk(r);
  return videos;
}

// A small, hand-verified selector per major site, tried before the generic
// structural/auto-detect path. Each was confirmed directly against the real
// site (not guessed): YouTube's `.html5-main-video`, Dailymotion's `#video`
// (the actual player, on geo.dailymotion.com — a different origin from the
// page), Twitch's `.video-player__container video` (confirmed on both live
// channels and clips). Matched by hostname suffix so subdomains
// (m.youtube.com, geo.dailymotion.com, clips.twitch.tv) share one entry.
const SITE_SELECTORS = [
  { hosts: ["youtube.com"], selector: ".html5-main-video" },
  { hosts: ["dailymotion.com"], selector: "#video" },
  { hosts: ["twitch.tv"], selector: ".video-player__container video" }
];

/** A known-good selector for this hostname, if we have one and it currently matches a real, visible <video>. */
export function findKnownVideo() {
  const host = location.hostname;
  const match = SITE_SELECTORS.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
  if (!match) return null;
  try {
    const el = document.querySelector(match.selector);
    return el && el.tagName === "VIDEO" ? el : null;
  } catch {
    return null; // a malformed selector should never break detection
  }
}

/**
 * The area of `el` actually visible on screen: clipped to the viewport (a
 * video scrolled off-screen or behind other content shouldn't win just for
 * being physically large) and zero for anything hidden via CSS rather than
 * layout (`visibility:hidden`/`display:none`/`opacity:0` all still report a
 * non-zero bounding rect, which a raw width*height check would miss).
 */
function visibleArea(el) {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none" || parseFloat(style.opacity) === 0) return 0;
  const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
  return width * height;
}

/** Auto-detect: a known site selector first, else the most visible loaded video on the page. */
export function autoDetectVideo() {
  const known = findKnownVideo();
  if (known && visibleArea(known) > 0) return known;

  const candidates = findAllVideos().filter((v) => v.readyState > 0 && visibleArea(v) > 0);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => visibleArea(b) - visibleArea(a));
  return candidates[0];
}

const DURATION_MATCH_TOLERANCE_S = 3;

/**
 * Among visible, loaded-metadata candidates, the one whose duration is
 * closest to `targetDuration` (within a few seconds) — a secondary signal
 * for when the structural descriptor fails to match (host's and guest's DOM
 * differ) but the host reported a duration at pick time. Distinguishes "the
 * main video" from e.g. short recommended-video thumbnails on the same page.
 * Returns null for live content (Infinity/NaN duration) — nothing meaningful
 * to match against.
 */
export function findVideoByDuration(targetDuration) {
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) return null;

  let best = null;
  let bestDiff = Infinity;
  for (const v of findAllVideos()) {
    if (!Number.isFinite(v.duration) || v.duration <= 0 || visibleArea(v) <= 0) continue;
    const diff = Math.abs(v.duration - targetDuration);
    if (diff < bestDiff) {
      best = v;
      bestDiff = diff;
    }
  }
  return bestDiff <= DURATION_MATCH_TOLERANCE_S ? best : null;
}

/**
 * Build a descriptor that can be re-resolved later, possibly in a different
 * document (a guest's copy of the same page). Format: an array of steps from
 * an anchor (a stable id, or the document root) down to the element.
 */
export function computeDescriptor(el) {
  const segments = [];
  let current = el;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const root = current.getRootNode();
    const inShadow = root instanceof ShadowRoot;

    if (current.id && !inShadow) {
      segments.unshift({ sel: `#${CSS.escape(current.id)}`, viaShadowRoot: false, isAnchor: true });
      break;
    }

    const parent = current.parentNode;
    const parentIsShadowRoot = parent instanceof ShadowRoot;
    const container = parent;
    const tag = current.tagName.toLowerCase();
    const siblings = container && container.children
      ? Array.from(container.children).filter((c) => c.tagName === current.tagName)
      : [current];
    const idx = siblings.indexOf(current) + 1; // nth-of-type is 1-based

    segments.unshift({ sel: `${tag}:nth-of-type(${idx})`, viaShadowRoot: parentIsShadowRoot });

    if (parentIsShadowRoot) {
      current = parent.host;
    } else if (parent && parent.nodeType === Node.ELEMENT_NODE) {
      current = parent;
    } else {
      break; // reached <html>'s parent (the document)
    }
  }

  return segments;
}

/** Resolve a descriptor built by computeDescriptor() against the current document. */
export function resolveDescriptor(segments) {
  let container = document;
  let el = null;

  for (const seg of segments) {
    if (seg.viaShadowRoot) {
      if (!el || !el.shadowRoot) return null;
      container = el.shadowRoot;
    }
    el = seg.isAnchor
      ? container.querySelector(seg.sel)
      : container.querySelector(`:scope > ${seg.sel}`);
    if (!el) return null;
    container = el;
  }

  return el;
}

/**
 * Like `new MutationObserver(cb).observe(document.documentElement, {childList:true, subtree:true})`,
 * but also recurses into shadow roots — a plain MutationObserver's
 * `subtree:true` does not cross shadow boundaries, so mutations happening
 * purely inside a shadow root (common on heavily-shadow-DOM sites, e.g.
 * MSN's Fluent UI web-component shell) would otherwise go unnoticed. Returns
 * a stop function.
 */
export function observeDeep(callback) {
  const seen = new WeakSet();
  const observers = [];

  function watch(root) {
    if (seen.has(root)) return;
    seen.add(root);
    const obs = new MutationObserver(() => {
      callback();
      scan(root);
    });
    obs.observe(root, { childList: true, subtree: true });
    observers.push(obs);
  }

  function scan(root) {
    const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of all) {
      if (el.shadowRoot) watch(el.shadowRoot);
    }
  }

  watch(document.documentElement);
  scan(document.documentElement);

  return () => {
    for (const obs of observers) obs.disconnect();
  };
}

/**
 * Watch for the target element disappearing (SPA swaps the player after
 * navigation) and re-detect. Calls onLost() once when it happens; caller
 * decides whether to re-run auto-detect or re-resolve the stored descriptor.
 */
export function watchForReplacement(el, onLost) {
  const stop = observeDeep(() => {
    if (!document.documentElement.contains(el) && !isInAnyShadowRoot(el)) {
      stop();
      onLost();
    }
  });
  return stop;
}

function isInAnyShadowRoot(el) {
  const root = el.getRootNode();
  return root instanceof ShadowRoot && root.host && document.documentElement.contains(root.host);
}

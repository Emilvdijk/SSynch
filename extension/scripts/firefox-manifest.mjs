// Chrome manifest -> Firefox manifest. Kept as a pure function separate from the
// file I/O in build-firefox.mjs so it can be unit-tested (test/firefox-manifest.test.js)
// without running a build — this transform is exactly the sort of thing that
// silently rots when someone adds a Chrome-only permission upstream.
//
// The extension's *JavaScript* is byte-identical between the two browsers; only
// the manifest differs. See DECISIONS.md ("Firefox build") for why that's true
// and why it's a rewrite rather than a second bundle.

// Permanent once published to AMO: an add-on is identified by this string, so
// changing it later creates a *different* add-on that existing users are never
// migrated to.
//
// The domain part is never resolved and needn't be a real address — but it IS
// permanent and publicly visible, so it points at a namespace that's actually
// ours (github.com/Emilvdijk/SSynch, and the GitHub Pages site that serves
// PRIVACY.md) rather than at hosting we might migrate off. An earlier draft
// used the Cloudflare `*.workers.dev` subdomain; that's Cloudflare's shared
// free-tier domain, so moving the Worker would have left the add-on's identity
// permanently pointing at infrastructure that no longer existed.
export const GECKO_ID = "ssynch@emilvdijk.github.io";

// The floor is set by permissions, not by any API this code calls:
//   112  background.type: "module" for event pages
//   115  storage.session
//   125  Popover API (the overlay's fullscreen top-layer promotion)
//   127  host_permissions / content_scripts matches are shown in the install
//        prompt and GRANTED AT INSTALL. Before 127 they were opt-in only, so
//        the content script — i.e. all of SSynch — would not run at all until
//        the user found the extensions button and granted access per site.
//        Shipping below this would look like an extension that does nothing.
export const STRICT_MIN_VERSION = "127.0";

// Required for all new AMO submissions since 2025-11-03, and surfaced to users
// in Firefox's install prompt. Chose from Mozilla's own definitions, matched
// against what PRIVACY.md already promises we send:
//   browsingActivity  "specific URLs, domains, or categories of pages users
//                      view" — we transmit the shared pageUrl and frameUrl.
//   websiteActivity   "interactions ... clicking ... and actions" — play,
//                      pause, seek, and the position heartbeat.
// Deliberately NOT technicalAndInteraction: that covers device/browser info,
// extension usage stats and crash reports, and SSynch has no telemetry at all.
//
// Erring toward over-declaring on purpose. PRIVACY.md is maximally explicit
// about what leaves the browser, and a narrower manifest claim would contradict
// it. If PRIVACY.md's "what SSynch sends" table changes, change this too.
export const DATA_COLLECTION = { required: ["browsingActivity", "websiteActivity"] };

// Drift guard. This transform only knows about the manifest as it exists today;
// add a Chrome-only permission or key to manifest.config.js later and the
// Firefox build would happily ship it, with AMO's validator the first thing to
// notice — after upload.
//
// Deliberately an ALLOWLIST rather than a list of known-Chrome-only names: the
// point is to fail on anything *unreviewed*, and a denylist can only catch what
// was predictable when it was written. Adding to these sets is the explicit
// "yes, I checked this works in Firefox" step.
export const REVIEWED_PERMISSIONS = new Set([
  "alarms",       // Firefox honours the same 0.5-minute floor — see background.js
  "storage",      // storage.session since Firefox 115
  "tabs",
  "clipboardWrite"
]);

// Permissions the transform is expected to REMOVE. Listed so that dropping one
// is a deliberate edit here rather than a silent pass-through.
export const STRIPPED_PERMISSIONS = new Set(["sidePanel"]);

export const REVIEWED_MANIFEST_KEYS = new Set([
  "manifest_version", "name", "version", "description",
  "permissions", "host_permissions", "icons",
  "background", "content_scripts", "action",
  "web_accessible_resources", "browser_specific_settings"
]);

function assertNothingUnreviewed(manifest) {
  const unknownKeys = Object.keys(manifest).filter((k) => !REVIEWED_MANIFEST_KEYS.has(k));
  const unknownPermissions = (manifest.permissions ?? []).filter((p) => !REVIEWED_PERMISSIONS.has(p));

  const problems = [
    ...unknownKeys.map((k) => `manifest key "${k}"`),
    ...unknownPermissions.map((p) => `permission "${p}"`)
  ];
  if (problems.length === 0) return;

  throw new Error(
    `Firefox build has unreviewed additions: ${problems.join(", ")}.\n` +
    "Check each against Firefox support, then either handle it in toFirefoxManifest() " +
    "or add it to REVIEWED_MANIFEST_KEYS / REVIEWED_PERMISSIONS in scripts/firefox-manifest.mjs."
  );
}

/**
 * @param {object} chromeManifest parsed dist/manifest.json as emitted by crxjs
 * @returns {object} a new manifest object; the input is not mutated
 */
export function toFirefoxManifest(chromeManifest) {
  const manifest = structuredClone(chromeManifest);

  // Firefox has no service-worker background — bug 1573659 is still open, and
  // background.service_worker is rejected outright. MV3 there is a
  // non-persistent *event page* declared via `scripts`.
  //
  // The entry point is read from the Chrome manifest rather than hardcoded:
  // it's crxjs's generated loader and the filename is not ours to assume. That
  // loader happens to be a one-line ES module (`import './assets/background.js-<hash>.js'`),
  // which is exactly what `type: "module"` here expects — so no second bundle
  // is needed. If crxjs ever emits a genuinely worker-specific loader
  // (importScripts, self.*), this assumption breaks and Firefox needs its own
  // vite config.
  const backgroundEntry = manifest.background?.service_worker;
  if (!backgroundEntry) {
    throw new Error("manifest has no background.service_worker — expected crxjs output");
  }
  manifest.background = { scripts: [backgroundEntry], type: "module" };

  // side_panel is Chrome-only; Firefox's sidebar_action is a different and
  // incompatible API. Dropping it costs almost nothing here because
  // action.default_popup already points at the same page — and in Chrome the
  // toolbar icon opens that popup too, so this is the behaviour users of both
  // builds actually see. Firefox users just can't dock it.
  delete manifest.side_panel;
  manifest.permissions = (manifest.permissions ?? []).filter((p) => !STRIPPED_PERMISSIONS.has(p));

  // clipboardWrite: belt-and-braces, NOT a requirement — worth being accurate
  // about, because the obvious assumption ("Firefox needs this or copy breaks")
  // is wrong. navigator.clipboard.writeText() works from a content script off
  // transient activation alone, and the overlay's copy button calls it
  // synchronously at the top of a click handler, so that activation is intact.
  // The permission only removes the *dependence* on activation.
  //
  // Kept because the cost is one line in the install prompt on an extension
  // that already asks for all-sites access, and it makes the copy button immune
  // to the handler ever growing an `await` before the writeText call. Dropping
  // it is a legitimate call if minimising the prompt matters more.
  //
  // Neither this nor the permission fixes the real failure mode: navigator.clipboard
  // is undefined in a non-secure context, so copy throws on any http:// page.
  if (!manifest.permissions.includes("clipboardWrite")) {
    manifest.permissions.push("clipboardWrite");
  }

  // Chrome-only key. Harmless at runtime, but AMO's validator flags unknown
  // properties and there's no reason to ship a warning.
  for (const entry of manifest.web_accessible_resources ?? []) {
    delete entry.use_dynamic_url;
  }

  // gecko.id is required to sign or publish at all; data_collection_permissions
  // is required for new submissions and drives the install prompt's disclosure.
  manifest.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: STRICT_MIN_VERSION,
      data_collection_permissions: structuredClone(DATA_COLLECTION)
    }
  };

  // Last, so it sees exactly what would be written to disk.
  assertNothingUnreviewed(manifest);

  return manifest;
}

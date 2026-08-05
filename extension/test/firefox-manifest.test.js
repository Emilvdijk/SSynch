import { test } from "node:test";
import assert from "node:assert/strict";
import { DATA_COLLECTION, GECKO_ID, STRICT_MIN_VERSION, toFirefoxManifest } from "../scripts/firefox-manifest.mjs";

// Shaped like real crxjs output (hashed asset names included) so the tests fail
// for the same reasons a real build would.
function chromeManifest(overrides = {}) {
  return {
    manifest_version: 3,
    name: "SSynch",
    version: "1.0.0",
    permissions: ["alarms", "storage", "sidePanel", "tabs"],
    host_permissions: ["<all_urls>"],
    background: { service_worker: "service-worker-loader.js", type: "module" },
    side_panel: { default_path: "src/sidepanel.html" },
    content_scripts: [{ js: ["assets/content.js-APGg9dR7.js"], matches: ["<all_urls>"], all_frames: true }],
    action: { default_popup: "src/sidepanel.html" },
    web_accessible_resources: [
      { matches: ["<all_urls>"], resources: ["assets/content.js-APGg9dR7.js"], use_dynamic_url: false }
    ],
    ...overrides
  };
}

test("background becomes an event page, keeping crxjs's generated entry point", () => {
  const ff = toFirefoxManifest(chromeManifest());
  // Firefox rejects background.service_worker outright (bug 1573659).
  assert.equal(ff.background.service_worker, undefined);
  assert.deepEqual(ff.background, { scripts: ["service-worker-loader.js"], type: "module" });
});

test("the background entry is read from the input, not hardcoded", () => {
  const ff = toFirefoxManifest(chromeManifest({ background: { service_worker: "sw-loader-abc123.js", type: "module" } }));
  assert.deepEqual(ff.background.scripts, ["sw-loader-abc123.js"]);
});

test("throws rather than emitting a background-less manifest", () => {
  assert.throws(() => toFirefoxManifest(chromeManifest({ background: undefined })), /background\.service_worker/);
});

test("Chrome-only side panel is removed, popup is kept", () => {
  const ff = toFirefoxManifest(chromeManifest());
  assert.equal(ff.side_panel, undefined);
  assert.equal(ff.permissions.includes("sidePanel"), false);
  // The popup is the whole reason dropping side_panel is cheap — if this ever
  // goes away, Firefox users lose the UI entirely rather than just the docking.
  assert.equal(ff.action.default_popup, "src/sidepanel.html");
});

test("clipboardWrite is added for the overlay's copy button in content-script context", () => {
  const ff = toFirefoxManifest(chromeManifest());
  assert.equal(ff.permissions.includes("clipboardWrite"), true);
});

test("clipboardWrite is not duplicated if it is already present", () => {
  const ff = toFirefoxManifest(chromeManifest({ permissions: ["storage", "clipboardWrite"] }));
  assert.deepEqual(ff.permissions.filter((p) => p === "clipboardWrite"), ["clipboardWrite"]);
});

test("gecko id, minimum version and data-collection disclosure are set", () => {
  const ff = toFirefoxManifest(chromeManifest());
  assert.deepEqual(ff.browser_specific_settings.gecko, {
    id: GECKO_ID,
    strict_min_version: STRICT_MIN_VERSION,
    data_collection_permissions: { required: ["browsingActivity", "websiteActivity"] }
  });
});

// Required for new AMO submissions and shown in the install prompt, so a typo
// here is a compliance problem rather than a build failure — nothing else would
// catch it. "none" is only valid alone; mixing it with real categories is not.
test("declared data-collection categories are from Mozilla's allowed set", () => {
  const ALLOWED = new Set([
    "none", "personallyIdentifyingInfo", "healthInfo", "financialAndPaymentInfo",
    "authenticationInfo", "personalCommunications", "locationInfo", "browsingActivity",
    "websiteContent", "websiteActivity", "searchTerms", "bookmarksInfo", "technicalAndInteraction"
  ]);
  assert.ok(DATA_COLLECTION.required.length > 0, "required must not be empty");
  for (const value of DATA_COLLECTION.required) assert.ok(ALLOWED.has(value), `unknown category: ${value}`);
  if (DATA_COLLECTION.required.includes("none")) assert.equal(DATA_COLLECTION.required.length, 1);
});

test("the exported disclosure constant cannot be mutated through a built manifest", () => {
  const ff = toFirefoxManifest(chromeManifest());
  ff.browser_specific_settings.gecko.data_collection_permissions.required.push("healthInfo");
  assert.deepEqual(DATA_COLLECTION.required, ["browsingActivity", "websiteActivity"]);
});

test("Chrome-only use_dynamic_url is stripped so AMO's validator stays quiet", () => {
  const ff = toFirefoxManifest(chromeManifest());
  assert.equal("use_dynamic_url" in ff.web_accessible_resources[0], false);
  assert.deepEqual(ff.web_accessible_resources[0].resources, ["assets/content.js-APGg9dR7.js"]);
});

// The transform only knows about today's manifest. These are the tests that
// make a *future* Chrome-only addition fail loudly at build time instead of
// shipping to AMO and being rejected there.
test("an unreviewed permission fails the build rather than shipping", () => {
  assert.throws(
    () => toFirefoxManifest(chromeManifest({ permissions: ["storage", "offscreen"] })),
    /unreviewed additions.*permission "offscreen"/s
  );
});

test("an unreviewed top-level manifest key fails the build rather than shipping", () => {
  assert.throws(
    () => toFirefoxManifest(chromeManifest({ chrome_settings_overrides: { homepage: "x" } })),
    /unreviewed additions.*manifest key "chrome_settings_overrides"/s
  );
});

test("the failure message names every offender and says what to do", () => {
  try {
    toFirefoxManifest(chromeManifest({ permissions: ["offscreen", "favicon"], side_panel: undefined }));
    assert.fail("expected a throw");
  } catch (err) {
    assert.match(err.message, /offscreen/);
    assert.match(err.message, /favicon/);
    assert.match(err.message, /REVIEWED_MANIFEST_KEYS \/ REVIEWED_PERMISSIONS/);
  }
});

test("a permission the transform strips does not trip the guard", () => {
  // sidePanel is Chrome-only and unsupported in Firefox, but it's removed
  // before the check runs — so it must not be reported as unreviewed.
  const ff = toFirefoxManifest(chromeManifest());
  assert.equal(ff.permissions.includes("sidePanel"), false);
});

test("everything else passes through untouched", () => {
  const input = chromeManifest();
  const ff = toFirefoxManifest(input);
  assert.deepEqual(ff.content_scripts, input.content_scripts);
  assert.deepEqual(ff.host_permissions, ["<all_urls>"]);
  assert.equal(ff.version, "1.0.0");
  // The input must not be mutated — build-firefox.mjs reads dist/manifest.json
  // and the Chrome build has to stay valid on disk.
  assert.equal(input.side_panel.default_path, "src/sidepanel.html");
  assert.deepEqual(input.background, { service_worker: "service-worker-loader.js", type: "module" });
});

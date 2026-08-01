import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "SSynch",
  version: pkg.version,
  description: "Watch any video in sync with other people, in real time.",
  // "alarms": the only thing that can wake this service worker on its own once
  // MV3 evicts it — see KEEPALIVE_ALARM in background.js. Without it a paused
  // room has no traffic and therefore nothing left to ever bring it back.
  permissions: ["alarms", "scripting", "storage", "sidePanel", "tabs"],
  host_permissions: ["<all_urls>"],
  // Rasterised from assets/*.svg into public/icons/, so these paths are
  // dist-relative. 16 and 32 come from icon-small.svg — the detailed geometry
  // turns to mush that small; see the comment at the top of that file.
  icons: {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png"
  },
  background: {
    service_worker: "src/background.js",
    type: "module"
  },
  side_panel: {
    default_path: "src/sidepanel.html"
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content.js"],
      all_frames: true,
      run_at: "document_idle"
    }
  ],
  action: {
    default_title: "SSynch",
    default_icon: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png"
    },
    // Same file as side_panel.default_path below — identical content/dark
    // styling on purpose, no duplication. Setting this makes clicking the
    // toolbar icon show a floating popup (from ANY tab) instead of nothing —
    // side_panel alone doesn't open on icon click unless separately
    // configured, and once a popup is set it takes precedence for icon
    // clicks anyway. The side panel itself is unaffected: still reachable
    // via Chrome's own side-panel toggle, just no longer via this icon.
    default_popup: "src/sidepanel.html"
  }
});

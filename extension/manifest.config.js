import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "SSynch",
  version: pkg.version,
  description: "Watch any video in sync with other people, in real time.",
  permissions: ["scripting", "storage", "sidePanel", "tabs"],
  host_permissions: ["<all_urls>"],
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

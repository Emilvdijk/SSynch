// Packages the Firefox build. Run after `vite build` (see the build:firefox
// npm script) — it consumes dist/ and does not invoke vite itself.
//
// Output goes to a separate dist-firefox/ rather than rewriting dist/ in place
// so both builds can be loaded at once (Chrome on dist/, Firefox on
// dist-firefox/) and neither clobbers the other. about:debugging also needs a
// stable path to reload from.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GECKO_ID, STRICT_MIN_VERSION, toFirefoxManifest } from "./firefox-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromeDist = join(root, "dist");
const firefoxDist = join(root, "dist-firefox");

if (!existsSync(join(chromeDist, "manifest.json"))) {
  console.error("dist/manifest.json not found — run `npm run build` first (or use `npm run build:firefox`).");
  process.exit(1);
}

const chromeManifest = JSON.parse(readFileSync(join(chromeDist, "manifest.json"), "utf8"));
const firefoxManifest = toFirefoxManifest(chromeManifest);

rmSync(firefoxDist, { recursive: true, force: true });
cpSync(chromeDist, firefoxDist, { recursive: true });
writeFileSync(join(firefoxDist, "manifest.json"), `${JSON.stringify(firefoxManifest, null, 2)}\n`);

console.log(`dist-firefox/  id=${GECKO_ID}  min Firefox ${STRICT_MIN_VERSION}`);
console.log("Load: about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> dist-firefox/manifest.json");

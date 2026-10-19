import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const dist = path.join(root, "dist");
const modelUrl = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const modelHash = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";
const sha256 = data => createHash("sha256").update(data).digest("hex");
await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "vendor"), { recursive: true });
const files = ["index.html", "app.js", "styles.css", "game-core.mjs", "sensing.mjs", "characters.mjs", "offline-status.mjs", "manifest.webmanifest", "icons", "assets"];
for (const file of files) await cp(file, path.join(dist, file), { recursive: true });
await cp("node_modules/@mediapipe/tasks-vision/vision_bundle.mjs", path.join(dist, "vendor/vision_bundle.mjs"));
await cp("node_modules/@mediapipe/tasks-vision/wasm", path.join(dist, "vendor/wasm"), { recursive: true });
await mkdir(".cache", { recursive: true });
let model;
try { model = await readFile(".cache/face_landmarker.task"); } catch { /* first build */ }
if (!model || sha256(model) !== modelHash) {
  const response = await fetch(modelUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
  model = Buffer.from(await response.arrayBuffer());
  if (sha256(model) !== modelHash) throw new Error("Model checksum mismatch; refusing to publish");
  await writeFile(".cache/face_landmarker.task", model);
}
await writeFile(path.join(dist, "vendor/face_landmarker.task"), model);
let revision = "local";
try { revision = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* source archive */ }
const { version: packageVersion } = JSON.parse(await readFile("package.json", "utf8"));
const version = `${packageVersion} (${revision})`;
await writeFile(path.join(dist, "release.mjs"), `export const VERSION = ${JSON.stringify(version)};\n`);
await cp("THIRD_PARTY_NOTICES.md", path.join(dist, "THIRD_PARTY_NOTICES.md"));
async function inventory(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    result.push(...entry.isDirectory() ? await inventory(file) : [path.relative(dist, file).replaceAll(path.sep, "/")]);
  }
  return result.sort();
}
const assets = await inventory(dist);
const hash = createHash("sha256");
for (const asset of assets) { hash.update(asset); hash.update(await readFile(path.join(dist, asset))); }
const swTemplate = await readFile("sw.js", "utf8");
hash.update(swTemplate);
const buildVersion = hash.digest("hex").slice(0, 16);
const sw = swTemplate.replaceAll("__BUILD_VERSION__", buildVersion)
  .replace("__PRECACHE_ASSETS__", JSON.stringify(assets.map(asset => `./${asset}`)));
await writeFile(path.join(dist, "sw.js"), sw);
console.log(`Built ${version}: ${assets.length} offline assets, cache ${buildVersion}`);

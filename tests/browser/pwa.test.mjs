import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dist = path.join(root, "dist");
const scope = "/mi-tsuketa/";
const mime = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  ".webmanifest": "application/manifest+json", ".json": "application/json",
  ".task": "application/octet-stream", ".wasm": "application/wasm" };

async function inventory(dir, relative = "") {
  const list = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) list.push(...await inventory(path.join(dir, entry.name), name));
    else if (name !== "sw.js") list.push(name);
  }
  return list.sort();
}
const template = await readFile(path.join(root, "sw.js"), "utf8");

// Compose A/B from the real build assets and unmodified production sw.js
// template; change only the version's HTML/module and B's additional asset.
async function variants() {
  const assets = await inventory(dist);
  const index = await readFile(path.join(dist, "index.html"), "utf8");
  const extra = "icons/pwa-update-marker.svg";
  const make = async (label, addExtra = false) => {
    const overlays = new Map([
      ["index.html", Buffer.from(index.replace("</head>", `<meta name="fixture-build" content="${label}"></head>`))],
      ["release.mjs", Buffer.from(`export const VERSION = ${JSON.stringify(`PWA test ${label}`)};\n`)],
    ]);
    if (addExtra) overlays.set(extra, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><title>更新テスト素材</title></svg>'));
    const files = [...assets, ...(addExtra ? [extra] : [])].sort();
    const hash = createHash("sha256");
    for (const asset of files) {
      hash.update(asset);
      hash.update(overlays.get(asset) || await readFile(path.join(dist, asset)));
    }
    hash.update(template);
    const version = hash.digest("hex").slice(0, 16);
    overlays.set("sw.js", Buffer.from(template
      .replaceAll("__BUILD_VERSION__", version)
      .replace("__PRECACHE_ASSETS__", JSON.stringify(files.map(asset => `./${asset}`)))));
    return { overlays, cache: `mi-tsuketa-${version}`, files };
  };
  return { A: await make("A"), B: await make("B", true), bad: await make("bad", true) };
}
async function fixture() {
  const builds = await variants();
  let variant = "A";
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const pathname = decodeURIComponent(url.pathname);
    const asset = pathname.startsWith(scope) ? pathname.slice(scope.length) || "index.html" : null;
    requests.push({ stage: variant, path: asset, method: request.method });
    if (!asset || asset.includes("..") || request.method !== "GET" ||
        ![...builds[variant].files, "sw.js", "index.html"].includes(asset) ||
        (variant === "bad" && asset === "icons/icon.svg")) {
      response.writeHead(404); response.end("Not found"); return;
    }
    try {
      const body = builds[variant].overlays.get(asset) || await readFile(path.join(dist, asset));
      response.writeHead(200, { "Content-Type": mime[path.extname(asset)] || "application/octet-stream",
        "Cache-Control": "no-cache", "Service-Worker-Allowed": scope });
      response.end(body);
    } catch {
      response.writeHead(404); response.end("Not found");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}${scope}`;
  return {
    base, builds, requests,
    use(name) { variant = name; },
    async close() { await new Promise(resolve => server.close(resolve)); },
  };
}
async function cacheKeys(page) {
  return page.evaluate(async () => (await caches.keys()).sort());
}
async function openFirst(context, base) {
  const page = await context.newPage();
  await page.goto(base);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.waitForFunction(() => document.querySelector("#offlineStatus")?.textContent.includes("準備ができました"));
  return page;
}
const buildLabel = page => page.locator('meta[name="fixture-build"]').getAttribute("content");
const status = page => page.locator("#offlineStatus").innerText();

test("real Service Worker A→B update waits for all A tabs and preserves non-app caches", { timeout: 90000 }, async () => {
  const f = await fixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const first = await openFirst(context, f.base);
    assert.equal(await buildLabel(first), "A");
    const second = await context.newPage();
    await second.goto(f.base);
    assert.equal(await buildLabel(second), "A");
    await first.evaluate(async () => { await (await caches.open("other-app-cache")).put("/unrelated", new Response("keep")); });

    f.use("B");
    await first.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await first.waitForFunction(() => Boolean(navigator.serviceWorker.controller &&
      document.querySelector("#offlineStatus").textContent.includes("新しい版の準備ができました")));
    assert.equal(await buildLabel(first), "A");
    assert.equal(await buildLabel(second), "A");
    let keys = await cacheKeys(first);
    assert.ok(keys.includes(f.builds.A.cache), JSON.stringify(keys));
    assert.ok(keys.includes(f.builds.B.cache), JSON.stringify(keys));

    await first.close();
    assert.equal(await buildLabel(second), "A");
    assert.equal(await second.evaluate(async () => (await (await fetch("./release.mjs")).text()).includes("PWA test A")), true);
    await second.close();

    // No controlled clients remain: the browser can activate B without forcing
    // reload. The new navigation must see the new precached document.
    await new Promise(resolve => setTimeout(resolve, 350));
    const latest = await context.newPage();
    await latest.goto(f.base);
    await latest.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    assert.equal(await buildLabel(latest), "B");
    assert.match(await latest.locator("#appVersion").innerText(), /PWA test B/);
    await latest.waitForFunction(async old => !(await caches.keys()).includes(old), f.builds.A.cache);
    keys = await cacheKeys(latest);
    assert.ok(keys.includes(f.builds.B.cache), JSON.stringify(keys));
    assert.ok(keys.includes("other-app-cache"), JSON.stringify(keys));
    const cached = await latest.evaluate(async key =>
      (await (await caches.open(key)).keys()).map(request => request.url), f.builds.B.cache);
    assert.equal(cached.length, f.builds.B.files.length);
    assert.ok(cached.some(url => url.endsWith("/icons/pwa-update-marker.svg")));
    assert.ok(cached.every(url => url.startsWith(f.base) && !/blob:|data:|camera|peek/.test(url)));
    assert.ok(f.requests.every(r => r.method === "GET"));
    assert.equal(await latest.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await context.close();
  } finally { await browser.close(); await f.close(); }
});

test("failed B precache does not destroy A: offline A then recover with successful B", { timeout: 90000 }, async () => {
  const f = await fixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await openFirst(context, f.base);
    assert.equal(await buildLabel(page), "A");

    f.use("bad");
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.waitForFunction(() => document.querySelector("#offlineStatus")?.textContent.includes("更新の準備ができなかった"));
    assert.match(await status(page), /今の版は使えます/);
    assert.ok((await cacheKeys(page)).includes(f.builds.A.cache));

    await context.setOffline(true);
    await page.reload();
    assert.equal(await buildLabel(page), "A");
    await page.waitForFunction(() => document.querySelector("#offlineStatus")?.textContent.includes("準備ができました"));
    assert.equal(await page.locator("#startButton").isVisible(), true);
    await context.setOffline(false);

    f.use("B");
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.waitForFunction(() => document.querySelector("#offlineStatus")?.textContent.includes("新しい版の準備ができました"));
    assert.equal(await buildLabel(page), "A");
    await page.close();
    await new Promise(resolve => setTimeout(resolve, 350));
    const next = await context.newPage();
    await next.goto(f.base);
    assert.equal(await buildLabel(next), "B");
    assert.ok((await cacheKeys(next)).includes(f.builds.A.cache) === false);
    assert.match(await next.locator("#appVersion").innerText(), /PWA test B/);
    await context.close();
  } finally { await browser.close(); await f.close(); }
});

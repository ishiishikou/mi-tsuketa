/* Build replaces these values with a content-addressed version and exact allowlist. */
const CACHE_NAME = "mi-tsuketa-__BUILD_VERSION__";
const ASSETS = __PRECACHE_ASSETS__;
const BASE = new URL("./", self.location.href);
const ALLOWED = new Set(ASSETS.map(path => new URL(path, BASE).href));

self.addEventListener("install", event => {
  // Atomic: a failed download leaves the previous working version active.
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  // Do not skipWaiting during an active game: app code and model stay one version.
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("mi-tsuketa-") && key !== CACHE_NAME) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== BASE.origin) return;
  // Navigation query strings do not create new copies; no arbitrary runtime cache.
  const key = request.mode === "navigate" &&
    (url.pathname === BASE.pathname || url.pathname === new URL("index.html", BASE).pathname)
    ? new URL("index.html", BASE).href : url.href;
  if (!ALLOWED.has(key)) return;
  event.respondWith(caches.open(CACHE_NAME).then(async cache => (await cache.match(key)) || fetch(request)));
});

// Service worker: makes the app (and the map you've viewed) work without signal.
const BUILD = "1791060590";
const SHELL = "paris-shell-" + BUILD;
const TILES = "paris-tiles-v1"; // kept across app updates
const FILES = [
  "./", "index.html", "style.css", "app.js", "manifest.webmanifest",
  "icon-180.png", "icon-192.png", "vendor/leaflet.js", "vendor/leaflet.css", "data.enc.json",
  "vendor/pdf.min.js", "vendor/pdf.worker.min.js",
  "fonts/cormorant.woff2", "fonts/cormorant-italic.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("paris-shell-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Map tiles: saved copy first, otherwise fetch and keep a copy.
  if (url.hostname === "tile.openstreetmap.org") {
    e.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(req.url);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req.url, res.clone());
          return res;
        } catch { return Response.error(); }
      })
    );
    return;
  }

  // Our own files: newest version when online, saved copy when offline.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req, { cache: "no-cache" }) // skip the host's 10-minute cache so updates show up promptly
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html")))
    );
  }
});

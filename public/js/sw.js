// Minimal service worker: cache-first for static vendor assets, network for pages.
const CACHE = 'studio-os-v1';
const STATIC = ['/vendor/pico.min.css', '/vendor/htmx.min.js', '/css/custom.css', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'GET' && STATIC.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request))
    );
  }
});

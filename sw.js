const CACHE = 'left-to-spend-v4';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'budget.mjs', 'manifest.webmanifest', 'fonts/manrope.woff2', 'icons/icon-180.png', 'icons/icon-192.png'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));

self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()),
));

// Prefer the network so updates show at once; a slow or missing network falls back to the cache.
// GitHub API calls are left alone.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; });
    if (!hit) return fresh;
    return Promise.race([fresh.catch(() => hit), new Promise(r => setTimeout(() => r(hit), 1500))]);
  }));
});

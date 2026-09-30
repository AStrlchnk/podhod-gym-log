const CACHE = 'podhod-v10';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon.svg', './data-store.js'];
const ASSET_URLS = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('podhod-v') && key !== CACHE).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !ASSET_URLS.has(event.request.url)) return;
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (!response.ok) return response;
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then(response => response || (event.request.mode === 'navigate' ? caches.match(new URL('./index.html', self.registration.scope).href) : Response.error())))
  );
});

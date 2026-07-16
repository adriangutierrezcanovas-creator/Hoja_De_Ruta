const CACHE_NAME = 'hdr-v3';
const STATIC_ASSETS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.ico',
];
const NAV_PATHS = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  const isNav = request.mode === 'navigate' || NAV_PATHS.includes(url.pathname);
  if (url.pathname.startsWith('/api/') || isNav) {
    // network-first (siempre intenta traer la versión más reciente del HTML/API)
    event.respondWith(
      fetch(request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  const isFont = url.origin.includes('fonts.googleapis.com') || url.origin.includes('fonts.gstatic.com');
  if (isFont || STATIC_ASSETS.includes(url.pathname) || request.method === 'GET') {
    // cache-first
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return res;
        });
      })
    );
  }
});

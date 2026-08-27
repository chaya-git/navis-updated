// Navis PWA Service Worker
const CACHE_NAME = 'navis-v2'; // bumped to force old stale cache (navis-v1) to be deleted
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './connection.css',
  './manifest.json',
  './images/robomanthan_logo.png',
  './images/icon-192.png',
  './images/icon-512.png'
];

// Install: cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: NETWORK-FIRST for app shell files (html/js/css) so code updates
// take effect immediately. Falls back to cache only if offline.
// For everything else (images, fonts, etc.) cache-first is fine since those
// rarely change.
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // API calls (Groq, Google TTS, WebSocket) — always go straight to network
  if (url.includes('groq.com') || url.includes('translate.google.com') || url.startsWith('ws')) {
    return; // let browser handle it normally
  }

  const isAppShellFile = url.endsWith('.html') || url.endsWith('.js') || url.endsWith('.css') || url.endsWith('/');

  if (isAppShellFile) {
    // Network-first: try the network for the freshest file; only use the
    // cached copy if the network request fails (i.e. truly offline).
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Update the cache with the fresh copy for offline fallback later
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Cache-first for static assets (images, icons, etc.)
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
  }
});
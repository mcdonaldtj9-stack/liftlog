/* LiftLog service worker.
   Bump CACHE on every deploy — that's what evicts the old build. */

const CACHE = 'liftlog-v13';

const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/store.js',
  'js/seed.js',
  'js/train.js',
  'js/rest.js',
  'js/rules.js',
  'js/supa.js',
  'js/sync.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

/* How long to wait for the network before falling back to cache. Short enough
   that a dead zone at the gym doesn't feel like a hang. */
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Don't let one 404 asset abort the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function fromNetwork(request, cacheKey) {
  return fetch(request).then((response) => {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(cacheKey || request, copy));
    }
    return response;
  });
}

/* Network first, but never wait longer than NETWORK_TIMEOUT_MS before serving
   what we have. Everything same-origin goes through this: mixing a network-first
   document with cache-first scripts is how you end up running yesterday's JS
   against today's HTML. */
function networkFirst(request, cacheKey) {
  const key = cacheKey || request;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    const timer = setTimeout(() => {
      caches.match(key).then((hit) => { if (hit) finish(hit); });
    }, NETWORK_TIMEOUT_MS);

    fromNetwork(request, cacheKey)
      .then((response) => { clearTimeout(timer); finish(response); })
      .catch(() => {
        clearTimeout(timer);
        caches.match(key)
          .then((hit) => finish(hit || Response.error()))
          .catch(() => finish(Response.error()));
      });
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations all resolve to the one page; cache it under a stable key so the
  // subpath (/liftlog/) and the bare document agree.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, 'index.html'));
    return;
  }

  event.respondWith(networkFirst(request));
});

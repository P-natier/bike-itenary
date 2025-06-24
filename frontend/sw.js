// --- Versioning ---
// This is the most important line. You MUST change this string every
// time you want to deploy a new version of your app's files.
const CACHE_VERSION = 'pathcycle-v1.0.1'; // Example: changed from v1.0.0

// A clear name for your cache
const CACHE_NAME = `${CACHE_VERSION}`;

// --- Files to Cache ---
// These are the "app shell" files required for the app to load.
const URLS_TO_CACHE = [
  '/',
  'index.html',
  'style.css',
  'script.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'favicon.ico',
  'apple-touch-icon.png'
];

// --- INSTALL Event ---
// This runs when a new version of the service worker is detected.
self.addEventListener('install', event => {
  console.log(`[Service Worker] Installing version: ${CACHE_NAME}`);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[Service Worker] Caching app shell');
        return cache.addAll(URLS_TO_CACHE);
      })
      // --- NEW & CRITICAL ---
      // This forces the waiting service worker to become the active service worker.
      .then(() => self.skipWaiting())
  );
});

// --- ACTIVATE Event ---
// This runs after the new service worker has installed.
// It's the perfect place to clean up old, outdated caches.
self.addEventListener('activate', event => {
  console.log(`[Service Worker] Activating version: ${CACHE_NAME}`);
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          // If a cache's name is not our current cache name, it's old. Delete it.
          if (cacheName !== CACHE_NAME) {
            console.log('[Service Worker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // --- NEW & CRITICAL ---
      // This tells the active service worker to take control of all open
      // pages that fall within its scope, forcing them to use the new cache.
      return self.clients.claim();
    })
  );
});

// --- FETCH Event ---
// This runs every time your app tries to fetch a resource.
self.addEventListener('fetch', event => {
  // We only cache GET requests. POST requests to our API should always go to the network.
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(cachedResponse => {
        // If we have a match in the cache, return it.
        if (cachedResponse) {
          return cachedResponse;
        }

        // If not, fetch from the network.
        return fetch(event.request).then(
          networkResponse => {
            // We don't want to cache everything, just valid responses.
            if (!networkResponse || networkResponse.status !== 200) {
              return networkResponse;
            }
            
            // Clone the response because it's a one-time-use stream.
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME)
              .then(cache => {
                cache.put(event.request, responseToCache);
              });
              
            return networkResponse;
          }
        );
      })
  );
});

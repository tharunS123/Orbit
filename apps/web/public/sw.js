/* Orbit service worker: offline app shell + web push. Data offline-ness is handled by the sync
 * engine (IndexedDB); this worker only makes the app itself load without a network. */
const VERSION = 'orbit-v1';
const SHELL = ['/', '/inbox', '/today', '/upcoming', '/lists', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never cache API responses
  // Immutable build assets: cache-first.
  if (url.pathname.startsWith('/_next/static/') || /\.(woff2?|svg|png|ico)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }
  // Pages: network-first, fall back to the cached page (or the cached app shell).
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(url.pathname, copy));
          return res;
        })
        .catch(() => caches.match(url.pathname).then((hit) => hit || caches.match('/inbox') || caches.match('/'))),
    );
  }
});

self.addEventListener('push', (event) => {
  let data = { title: 'Orbit', body: '', path: '/updates', tag: undefined };
  try {
    data = { ...data, ...event.data.json() };
  } catch (e) {
    data.body = event.data ? event.data.text() : '';
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { path: data.path },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.path) || '/updates';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin) {
          w.navigate(path);
          return w.focus();
        }
      }
      return self.clients.openWindow(path);
    }),
  );
});

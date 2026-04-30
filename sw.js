// GAIA v4 — Service Worker (cache + push notifications)
const CACHE_NAME = 'gaia-v4';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// Install
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

// Activate
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
  );
  self.clients.claim();
});

// Fetch : network-first pour /api/*, cache-first pour les assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Toujours réseau pour les APIs (Vercel + Anthropic + ElevenLabs + fonts)
  if (
    url.pathname.startsWith('/api/') ||
    url.hostname === 'api.anthropic.com' ||
    url.hostname === 'api.elevenlabs.io' ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request)
          .then((response) => {
            if (response.ok && event.request.method === 'GET') {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
            }
            return response;
          })
          .catch(() => caches.match('/'))
      );
    })
  );
});

// Push : affichage des notifications reçues
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'GAIA', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'GAIA';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    tag: data.tag || 'gaia',
    vibrate: data.vibrate || [200, 100, 200],
    data: { url: data.url || '/' },
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Click sur notification : focus / ouverture de l'app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          w.navigate(targetUrl).catch(() => {});
          return w.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

// Sync : optionnel pour rejouer des actions hors-ligne
self.addEventListener('sync', (event) => {
  if (event.tag === 'gaia-sync') {
    // hook futur pour replayer les messages programmés
  }
});

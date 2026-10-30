/* GymBro Service Worker v7 */

var CACHE_NAME = 'gymbro-v8';

/* App shell files to cache on install */
var APP_SHELL = [
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700;800&family=Plus+Jakarta+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=DM+Mono:wght@400;500&display=swap',
  'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js',
  'https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

/* Install — cache app shell (index.html excluded — always fetched fresh) */
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.allSettled(
        APP_SHELL.map(function(url) {
          return cache.add(url).catch(function(err) {
            console.log('Could not cache:', url, err);
          });
        })
      );
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

/* Activate — clean up old caches */
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) {
          return key !== CACHE_NAME;
        }).map(function(key) {
          return caches.delete(key);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

/* Listen for the page asking us to activate immediately */
self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* Fetch strategy:
   - API calls        → always network, never cache
   - Supabase calls   → always network, never cache
   - HTML pages       → network first, fall back to cache offline
   - Everything else (including MediaPipe model files) → cache first, fall back to network
   Note: MediaPipe .tflite model files used to be forced network-only.
   That meant the pose-tracking model itself — the thing that actually
   does the rep counting — was never guaranteed to be available offline,
   even though the tracking math itself runs entirely on-device. Letting
   them fall into the normal cache-first bucket below means the first
   online workout caches the model, and every workout after that (online
   or offline) can load it instantly from cache. */
self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  /* Never intercept API calls */
  if (url.indexOf('/api/') > -1) {
    e.respondWith(fetch(e.request));
    return;
  }

  /* Never intercept Supabase calls */
  if (url.indexOf('supabase.co') > -1) {
    e.respondWith(fetch(e.request));
    return;
  }

  /* Network first for HTML — guarantees users always get the latest deploy */
  var isHTML = e.request.headers.get('accept') &&
               e.request.headers.get('accept').indexOf('text/html') > -1;
  if (isHTML) {
    e.respondWith(
      fetch(e.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      }).catch(function() {
        /* Offline fallback — serve cached HTML if network is unavailable */
        return caches.match(e.request).then(function(cached) {
          return cached || caches.match('/index.html');
        });
      })
    );
    return;
  }

  /* Cache first for everything else (fonts, icons, CDN assets) */
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;

      return fetch(e.request).then(function(response) {
        if (
          response &&
          response.status === 200 &&
          (response.type === 'basic' || response.type === 'cors')
        ) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      }).catch(function() {
        /* Nothing to fall back to for non-HTML assets */
        return new Response('', { status: 408, statusText: 'Offline' });
      });
    })
  );
});

/* ── PUSH NOTIFICATIONS ── */
self.addEventListener('push', function(e) {
  var data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch(err) {
    data = { title: 'GymBro', body: e.data ? e.data.text() : 'New notification' };
  }

  var title = data.title || 'GymBro';
  var options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'gymbro-alert',
    data: { url: data.url || '/' }
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

/* When the user taps a push notification, open (or focus) the app */
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var targetUrl = (e.notification.data && e.notification.data.url) || '/';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.indexOf(self.location.origin) === 0 && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

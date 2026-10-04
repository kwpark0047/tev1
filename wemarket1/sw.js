/* TEV1 Service Worker
 * - 정적 리소스: 캐시 우선(Cache-First)
 * - API: 네트워크 우선(Network-First) + 오프라인 폴백
 * - HTML: 네트워크 우선 + 오프라인 페이지 폴백
 * - Background Sync: 오프라인 중 대기한 요청 재시도
 * - Push: 서버 알림 수신
 *
 * 주의: Service Worker는 http(s) URL로만 등록할 수 있으므로 blob URL 등록은
 * 브라우저에 의해 거부된다. 반드시 실제 파일로 서빙해야 한다.
 */
'use strict';

const VERSION = 'v1.0.0';
const STATIC_CACHE = `tev1-static-${VERSION}`;
const DYNAMIC_CACHE = `tev1-dynamic-${VERSION}`;
const PENDING_CACHE = 'tev1-pending';

const OFFLINE_URL = 'offline.html';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './offline.html',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      // 캐시 실패(파일이 없음)가 전체 설치 실패를 만들지 않도록 개별 처리
      .then((cache) => Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('tev1-') && k !== STATIC_CACHE && k !== DYNAMIC_CACHE && k !== PENDING_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isApi(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/');
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline', offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        caches.open(STATIC_CACHE).then((cache) => cache.put(request, response.clone()));
      }
      return response;
    })
    .catch(() => null);
  return cached || (await network) || new Response('', { status: 504 });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 외부 CDN은 관여하지 않음

  if (isApi(url)) {
    event.respondWith(networkFirst(request, DYNAMIC_CACHE));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch (err) {
          return (await caches.match('./index.html')) || (await caches.match(OFFLINE_URL)) || Response.error();
        }
      })()
    );
    return;
  }

  if (/\.(?:js|css|png|jpg|jpeg|gif|svg|ico|woff2?)$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

// ---- Background Sync ----
self.addEventListener('sync', (event) => {
  if (event.tag === 'tev1-sync-pending') {
    event.waitUntil(replayPendingRequests());
  }
});

async function replayPendingRequests() {
  const cache = await caches.open(PENDING_CACHE);
  const requests = await cache.keys();
  for (const request of requests) {
    try {
      const response = await fetch(request);
      if (response.ok) await cache.delete(request);
    } catch (err) {
      // 다음 sync 주기에 다시 시도
    }
  }
}

// ---- Push ----
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    payload = { title: 'TEV1', body: event.data ? event.data.text() : '' };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'TEV1', {
      body: payload.body || '새 알림이 있습니다.',
      icon: payload.icon || './icon-192.png',
      badge: payload.badge || './badge-72.png',
      vibrate: [200, 100, 200],
      data: payload.data || {},
      requireInteraction: true,
      actions: [
        { action: 'open', title: '열기' },
        { action: 'dismiss', title: '닫기' },
      ],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
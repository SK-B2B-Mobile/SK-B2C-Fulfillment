// ★ v30 버그 수정: CACHE_NAME이 'v19'에서 한 번도 안 바뀌어서 브라우저가 계속 옛날
//   index.html을 캐시에서 꺼내 쓰던 문제. 앞으로 코드를 업데이트할 때마다
//   이 CACHE_NAME 숫자를 올려주면(예: v31, v32...) 브라우저가 확실히 새로 받아갑니다.
const CACHE_NAME = 'sk-b2c-v114';
const urlsToCache = [
  '/SK-B2C-Fulfillment/',
  '/SK-B2C-Fulfillment/index.html',
  '/SK-B2C-Fulfillment/manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // ★ index.html(및 페이지 이동 요청)은 항상 네트워크에서 새로 받아오고,
  //   브라우저 HTTP 캐시도 무시(no-store)하도록 강제 — 오프라인일 때만 캐시 사용.
  const isNavigation = event.request.mode === 'navigate' ||
    event.request.url.endsWith('/SK-B2C-Fulfillment/') ||
    event.request.url.endsWith('index.html');

  if (isNavigation) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then(resp => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

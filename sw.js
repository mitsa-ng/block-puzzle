const CACHE_NAME = 'block-puzzle-v21-achievements-refresh';
// 字型快取（C-4）：獨立 cache，跟主快取分開版號管理，activate 清理時要放過它
// （見下方 activate 的 filter 條件），避免每次升版都把已離線快取的字型檔案清掉重抓。
const FONTS_CACHE = 'block-puzzle-fonts-v1';
const ASSETS = [
  './',
  './index.html',
  './multiplayer.js',
  './manifest.json',
  './icon.png',
  './icon-192.png',
  './icon-512.png'
];

function isFontRequest(url) {
  return url.indexOf('fonts.googleapis.com') !== -1 || url.indexOf('fonts.gstatic.com') !== -1;
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== FONTS_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // 字型（C-4）：stale-while-revalidate — 有快取先立即回應，背景同時發新請求更新快取供下次使用；
  // 完全離線且尚無快取時才等待網路。用 event.waitUntil 確保背景更新不會在 respondWith 結束後被中止。
  if (isFontRequest(req.url)) {
    event.respondWith(
      caches.open(FONTS_CACHE).then(cache =>
        cache.match(req).then(cached => {
          const networkFetch = fetch(req).then(res => {
            cache.put(req, res.clone());
            return res;
          }).catch(() => cached);
          event.waitUntil(networkFetch);
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // HTML 一律先走網路，離線才退回快取，避免部署後舊快取永不更新
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 同源程式碼優先取網路最新版，避免舊 Service Worker 把 multiplayer.js
  // 永久鎖在未支援 mpServer 參數的舊版本；離線時才退回快取。
  if (url.origin === self.location.origin && req.destination === 'script') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match(req, { ignoreSearch: true })))
    );
    return;
  }
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req))
  );
});

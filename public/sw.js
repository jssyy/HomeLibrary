/**
 * 离线支持：界面本体和封面走缓存，接口走网络。
 * 目的是让手机断网/服务没开时也能打开看已加载过的内容。
 */
const VERSION = 'hl-v1';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/css/reader.css',
  '/js/app.js',
  '/js/api.js',
  '/js/ui.js',
  '/js/reader.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // 接口：网络优先，断网时回落到缓存
  if (url.pathname.startsWith('/api/')) {
    // 电子书文件太大，交给浏览器自己处理（还要支持 Range）
    if (/\/files\/\d+\/(raw|download)/.test(url.pathname)) return;
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 封面、前端依赖、图标：缓存优先
  if (/^\/(covers|vendor|icons)\//.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((hit) =>
        hit || fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
          return res;
        })
      )
    );
    return;
  }

  // 其余静态资源：缓存优先 + 后台更新
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const network = fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => hit || caches.match('/index.html'));
      return hit || network;
    })
  );
});

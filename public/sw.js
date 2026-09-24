/**
 * 离线支持：界面本体和封面走缓存，接口走网络。
 * 目的是让手机断网/服务没开时也能打开看已加载过的内容。
 */
const VERSION = 'hl-v2';
const SHELL = [
  '/',
  '/index.html',
  '/login.html',
  '/js/auth.js',
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

/** 只缓存正常的 200 响应：未登录时的跳转、401 之类缓存下来会导致登录后还在跳 */
function keep(request, res) {
  if (!res || !res.ok || res.type !== 'basic' || res.redirected) return;
  const copy = res.clone();
  caches.open(VERSION).then((c) => c.put(request, copy));
}

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
    // 电子书文件太大，交给浏览器自己处理（还要支持 Range）；账号接口不缓存
    if (/\/files\/\d+\/(raw|download)/.test(url.pathname) || url.pathname.startsWith('/api/auth/')) return;
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          keep(e.request, res);
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 页面导航：网络优先（登录状态由服务端决定跳不跳登录页），断网才用缓存
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          keep(e.request, res);
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
    );
    return;
  }

  // 封面、前端依赖、图标：缓存优先
  if (/^\/(covers|vendor|icons)\//.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((hit) =>
        hit || fetch(e.request).then((res) => {
          keep(e.request, res);
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
          keep(e.request, res);
          return res;
        })
        .catch(() => hit || caches.match('/index.html'));
      return hit || network;
    })
  );
});

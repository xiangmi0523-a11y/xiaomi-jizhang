/* 晓米记账 · 离线缓存（PWA）
 * - 页面和脚本：先走网络（保证总是最新版），没网时用缓存，离线也能打开记账
 * - 云端（Supabase）请求不经过这里
 */
const VERSION = 'xm-v4.10-2';
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/auth.js',
  '/js/backup.js',
  '/js/bridge.js',
  '/js/budget.js',
  '/js/catart.js',
  '/js/cats.js',
  '/js/catvoice.js',
  '/js/cloud.js',
  '/js/conflicts.js',
  '/js/core.js',
  '/js/durable.js',
  '/js/editor.js',
  '/js/game.js',
  '/js/inn.js',
  '/js/main.js',
  '/js/mine.js',
  '/js/mood.js',
  '/js/pwa.js',
  '/js/receipt.js',
  '/js/remind.js',
  '/js/restore.js',
  '/js/safety.js',
  '/js/savings.js',
  '/js/smart.js',
  '/js/sound.js',
  '/js/themes.js',
  '/js/ui.js',
  '/js/views.js',
  '/icons/icon-152.png',
  '/icons/icon-16.png',
  '/icons/icon-167.png',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-32.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // Supabase 等跨域请求不缓存
  const isPage = req.mode === 'navigate';
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), isPage ? 4000 : 6000);
      const res = await fetch(req, { signal: ctl.signal, cache: 'no-cache' });
      clearTimeout(t);
      if (res && res.ok && res.type === 'basic') cache.put(isPage ? '/' : req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(isPage ? '/' : req, { ignoreSearch: true });
      if (hit) return hit;
      if (isPage) { const home = await cache.match('/index.html'); if (home) return home; }
      throw err;
    }
  })());
});

// Lets the player page itself reload with no server. Only runs on HTTPS or localhost;
// media is cached separately in IndexedDB, which also works on plain-HTTP networks.
const CACHE = 'vitrine-shell-v2';
// The page's first load happens before this worker controls it, so these must be fetched up front.
const SHELL = ['/tv', '/static/player/player.js', '/static/player/player.css', '/shared/schedule.js', '/vendor/hls.min.js',
  '/fonts/display/bricolage-grotesque-latin-wght-normal.woff2', '/fonts/body/instrument-sans-latin-wght-normal.woff2'];
const isPlayerPage = (url) => url.pathname === '/tv' || url.pathname.startsWith('/use/') || url.pathname.startsWith('/group/');
const isShell = (url) => isPlayerPage(url) || SHELL.includes(url.pathname);

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !isShell(url)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // All player pages share one HTML file, so they share one cache entry.
    const key = isPlayerPage(url) ? '/tv' : url.pathname;
    try {
      const res = await fetch(e.request);
      if (res.ok) await cache.put(key, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(key);
      if (hit) return hit;
      throw err;
    }
  })());
});

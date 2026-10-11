// Bump VERSION whenever app files change so phones pick up the new build.
const VERSION = 'hl-v7';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
               'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// App shell: network first (so updates land), cache as offline fallback. Sheet API calls are never cached.
// cache: 'no-cache' revalidates with GitHub Pages every time instead of trusting its 10-minute max-age,
// so a new deploy shows up on the next open (an unchanged file costs only a 304).
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});

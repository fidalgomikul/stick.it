// Service worker: lets stick.it open and work without an internet connection — and even
// without the local server running, once it has been opened once.
//  • the app's own files: network first (so you always get the latest when the server runs),
//    falling back to the cached copy
//  • /api/… (image search, downloads): network only; offline you get a clear message
//  • fonts, the background-removal library and its model: cached the first time they're used
// Projects themselves live in IndexedDB and never depend on this.

const VERSION = '2026-11-17b';
const SHELL = `collage-shell-${VERSION}`;
const RUNTIME = 'collage-runtime';
const SHELL_FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'imaging.js', 'layouts.js', 'backgrounds.js', 'pdf.js', 'project.js',
  'vendor/fabric.min.js', 'vendor/cropper.min.js', 'vendor/cropper.min.css',
  'manifest.webmanifest', 'brand/logo-light.png', 'brand/logo-dark.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
];
// third-party files that are safe to keep (versioned URLs that never change)
const RUNTIME_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'staticimgly.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('collage-shell-') && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

const offlineJson = () => new Response(JSON.stringify({
  error: 'You’re offline. Image search and downloads need an internet connection and the app’s server; everything else keeps working.',
}), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) {
      event.respondWith(fetch(req).catch(offlineJson));
      return;
    }
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
        return res;
      } catch {
        const cached = await caches.match(req, { ignoreSearch: true });
        if (cached) return cached;
        if (req.mode === 'navigate') return caches.match('index.html');
        throw new Error('offline');
      }
    })());
    return;
  }

  if (RUNTIME_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    })());
  }
});

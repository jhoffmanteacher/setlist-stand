/*
 * Setlist Stand service worker.
 *
 * - Precaches every app file under a versioned cache (bump VERSION whenever
 *   any precached file changes: `node tools/checks.mjs --bump`).
 * - A new worker waits until the page posts 'skip-waiting' (no auto-update
 *   mid-gig); activate then removes old setlist-stand-* caches.
 * - Fetch: same-origin GET only, cache-first, network fallback; navigations
 *   fall back to the cached index.html so the app opens offline.
 * - All URLs are relative because the app is served from /setlist-stand/.
 */
const VERSION = '2026-11-21-13';
const CACHE = `setlist-stand-${VERSION}`;

const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/util.js',
  'js/store.js',
  'js/library.js',
  'js/copysong.js',
  'js/collections.js',
  'js/setlists.js',
  'js/viewer.js',
  'js/pagecache.js',
  'js/awake.js',
  'js/ink.js',
  'js/print.js',
  'js/names.js',
  'js/importname.js',
  'js/crop.js',
  'js/songlist.js',
  'js/songpdf.js',
  'js/split.js',
  'js/sharepack.js',
  'js/share.js',
  'js/shareimport.js',
  'js/backup.js',
  'js/driveconfig.js',
  'js/googleauth.js',
  'js/drive.js',
  'js/syncui.js',
  'js/errors.js',
  'js/main.js',
  'vendor/pdf.min.js',
  'vendor/pdf.worker.min.js',
  'vendor/pdf-lib.min.js',
  'vendor/jszip.min.js',
  'vendor/fonts/barlow-400.ttf',
  'vendor/fonts/barlow-500.ttf',
  'vendor/fonts/barlow-600.ttf',
  'vendor/fonts/barlowcondensed-600.ttf',
  'vendor/fonts/barlowcondensed-700.ttf',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

/* {cache:'reload'}: every file comes from the server, never from the browser's HTTP cache. GitHub Pages sends
   max-age=600, so a plain addAll() during a second deploy within ten minutes could store the OLD files under the NEW
   VERSION. addAll() still fails the whole install if any file does not arrive. */
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) =>
    cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('setlist-stand-') && k !== CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.status === 200 && !req.headers.has('range')) {
        cache.put(req, res.clone());
      }
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const shell = await cache.match('index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

/*
 * Setlist Stand service worker.
 *
 * - Precaches every app file under a versioned cache (bump VERSION whenever
 *   any precached file changes: `node tools/checks.mjs --bump`).
 * - A new worker waits until the page posts 'skip-waiting' (no auto-update
 *   mid-gig); activate then removes old setlist-stand-* caches.
 * - Fetch: same-origin GET only, cache-first, network fallback (not stored);
 *   navigations fall back to the cached index.html so the app opens offline.
 * - 'ss-heal' (from js/boot.js): refetch missing precached files when the
 *   server still has this same VERSION (another site may have wiped them).
 * - All URLs are relative because the app is served from /setlist-stand/.
 */
const VERSION = '2026-11-23-7';
const CACHE = `setlist-stand-${VERSION}`;

const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/util.js',
  'js/store.js',
  'js/library.js',
  'js/newversion.js',
  'js/chartfile.js',
  'js/chartupdate.js',
  'js/menubox.js',
  'js/copysong.js',
  'js/collections.js',
  'js/gigdate.js',
  'js/gigui.js',
  'js/downloadall.js',
  'js/nudge.js',
  'js/saving.js',
  'js/setlists.js',
  'js/viewer.js',
  'js/backnav.js',
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
  'js/zipread.js',
  'js/setlisttext.js',
  'js/backup.js',
  'js/driveconfig.js',
  'js/googleauth.js',
  'js/drive.js',
  'js/syncui.js',
  'js/driveops.js',
  'js/drivebackup.js',
  'js/syncmerge.js',
  'js/sync.js',
  'js/syncplan.js',
  'js/syncapply.js',
  'js/syncink.js',
  'js/syncmarks.js',
  'js/syncdialogs.js',
  'js/deleteops.js',
  'js/errors.js',
  'js/boot.js',
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

/* The offline copy refills itself (2026-11-23). Another site on the same github.io address can delete this app's cache
   (guitar-class's worker did: Cache Storage belongs to the whole address, not to a folder). js/boot.js asks for a check
   ('ss-heal') once per page load and after each update check, only when online. Missing files are fetched again ONLY
   when the server still has THIS version (its sw.js holds the same VERSION): otherwise a newer version is out, its own
   install fills its own cache, and this cache is left alone (no files of another version under this version's name).
   The cache is only (re)created once the version matched, so an old worker that is being replaced never brings back
   a cache the new one just deleted. */
async function heal() {
  const want = PRECACHE.map((u) => new URL(u, self.location.href).href);
  let have = new Set();
  if (await caches.has(CACHE)) have = new Set((await (await caches.open(CACHE)).keys()).map((r) => r.url));
  const missing = PRECACHE.filter((u, i) => !have.has(want[i]));
  if (!missing.length) return 'whole';
  let live;
  try {
    const res = await fetch('sw.js', { cache: 'no-store' });
    if (!res.ok) return 'offline';
    live = await res.text();
  } catch {
    return 'offline';
  }
  const m = /const\s+VERSION\s*=\s*'([^']+)'/.exec(live);
  if (!m || m[1] !== VERSION) return 'newer';
  const cache = await caches.open(CACHE);
  await cache.addAll(missing.map((u) => new Request(u, { cache: 'reload' })));
  return 'healed';
}

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
  else if (event.data === 'ss-heal') {
    event.waitUntil(heal().then(
      (r) => { if (event.source) event.source.postMessage({ type: 'ss-heal', result: r }); },
      () => {}));
  }
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
    /* A miss is answered from the network and NOT stored: after another site wiped this cache, the server may already
       hold a newer version, and its files must not land under this version's name. heal() is the one refill. */
    try {
      return await fetch(req);
    } catch (err) {
      if (req.mode === 'navigate') {
        const shell = await cache.match('index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

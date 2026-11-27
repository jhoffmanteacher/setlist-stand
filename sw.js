/*
 * ChartShark service worker.
 *
 * - Precaches every app file under a versioned cache (bump VERSION whenever
 *   any precached file changes: `node tools/checks.mjs --bump`).
 * - A new worker waits until the page posts 'skip-waiting' (no auto-update
 *   mid-gig); activate then removes old setlist-stand-* caches.
 * - Fetch: same-origin GET only. A stored answer is used ONLY for a file in PRECACHE whose stored bytes have the SHA-256
 *   written in HASHES below (checked on every use, nothing remembered), and it is sent as a NEW response made from those
 *   bytes with this file's own Content-Type: no header of the stored entry is passed on. Anything else (a path not in
 *   PRECACHE, a stored entry that fails, a miss) goes to the network and is NOT stored; navigations then fall back to the
 *   cached index.html, if it passes the same check, so the app opens offline.
 * - install and heal() check bytes too (see below). Cache Storage belongs to the whole github.io address, so another site
 *   there can write into this cache; HASHES lives here because the browser keeps sw.js outside Cache Storage.
 * - 'ss-heal' (from js/boot.js): refetch missing or wrong precached files when the
 *   server still has this same VERSION (another site may have wiped or changed them).
 * - A stored file that fails the check is deleted and named to the page ('ss-bad-file'; js/main.js writes one quiet line
 *   in the Problem log).
 * - All URLs are relative because the app is served from /setlist-stand/.
 */
const VERSION = '2026-11-27-2';
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
  'js/readycheck.js',
  'js/songjump.js',
  'js/songsets.js',
  'js/downloadall.js',
  'js/nudge.js',
  'js/saving.js',
  'js/setlists.js',
  'js/viewer.js',
  'js/backnav.js',
  'js/pagecache.js',
  'js/prerender.js',
  'js/awake.js',
  'js/ink.js',
  'js/print.js',
  'js/names.js',
  'js/azstrip.js',
  'js/importname.js',
  'js/crop.js',
  'js/songlist.js',
  'js/songpdf.js',
  'js/split.js',
  'js/sharepack.js',
  'js/share.js',
  'js/shareimport.js',
  'js/zipread.js',
  'js/restoreplan.js',
  'js/restoreask.js',
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

/* SHA-256 of every PRECACHE file, as the server must send it: the committed bytes. WRITTEN BY `node tools/checks.mjs --bump`
   (VERSION and this table together); never edit by hand. tools/checks.mjs fails when it is not exactly right. Keyed by the
   path as written in PRECACHE, so './' and 'index.html' (the same file) are two lines. */
const HASHES = {
  './': 'a8ca1c4cfb69060ad7dd00fcdfc89b8618b2c84121cf9220fc1549ea2e1ed289',
  'css/app.css': 'b2560a018512d2eb4b3907dc94c9eb8ced989a40bc48d46e4806398ba07da4fc',
  'icons/apple-touch-icon.png': 'b8e5bdb080ce8ec1117ad06b15ff7b4eb9b0cb6ee03d27de7099c4137466b573',
  'icons/icon-192.png': '09c8de4951894e45244aad76b586f20b3213410b4e8cf721d053d6ae0d405311',
  'icons/icon-512.png': 'f8b571ad44241adf748fef5fd47cc1aeb87bc4a2a08317a7178c819a2d1b106a',
  'icons/icon-maskable-512.png': '5c54bb1736fc0d4941b24b85aed9e9f1729e23f70bf6806903e06b58775ea4be',
  'index.html': 'a8ca1c4cfb69060ad7dd00fcdfc89b8618b2c84121cf9220fc1549ea2e1ed289',
  'js/awake.js': '5e2c189dbaf850421b76a1a8dafc1143d22903913832c0ec93875ff7a7277563',
  'js/azstrip.js': '59ed96b60694ab504c163f9aaf8fac0cdee5554b54cb23b1249404c59a0d1e2f',
  'js/backnav.js': 'd39acc3113a466b40a2ddbd4174b62e7ffc3233bd79db8bf4aadfccc2f754d41',
  'js/backup.js': '0e4b842385c321e225893531c8013a3c44b9af700bb9498ee1dbf7d695a813b7',
  'js/boot.js': 'e41f709777a3ebae56f696518c4888fa0df1375d0832d2aed75384fd3e35f1e1',
  'js/chartfile.js': 'cf4161021caf3b43a9812c65482f0aeb0747215abee0209bb44df85da5277e6b',
  'js/chartupdate.js': '7db054ba665254e72f66a004786116806f728390e1fab7f97630db1f7abf5f93',
  'js/collections.js': '3d7200eedf226f5df308c3cbcd853364a89341ebfc973340c828985477b659d1',
  'js/copysong.js': '857d399e9d196f58a3766c531a9699c7dfcc39ec8c427deba285913a0fd0a980',
  'js/crop.js': '3e0fa062cbdd805206bf274f8d907443e4b76707bef4cfb10b7bbacbdd87db46',
  'js/deleteops.js': '34c31be6a6a25c8a4abe999ea224559392c6a7e3feb6581aa5cee10ab16a080d',
  'js/downloadall.js': '67cbf91e957c0c3571b9c458bfe686704837aa133511f4455e782e707c5249fd',
  'js/drive.js': '25261083d1bc431f9865de4f01bc666c7abf88f478f91b01c7568c4d14ba8afd',
  'js/drivebackup.js': '22b243900ef2488cf793cb6bdc3a4a3740f1161021f8c66851cbdd4b1e36276d',
  'js/driveconfig.js': '40d2d34a011e08376794c6b50996c4ce05df8d379f1432620296e6277347bea0',
  'js/driveops.js': '3dd3ffd266171dabaa7d298ac157d5538d6ce19215a17e4638b48e6afc9b8120',
  'js/errors.js': '55ee81614f4a40dbb33e74c8e2c900918b764489e4c27ba375c2c48413b6fd7a',
  'js/gigdate.js': '1b95c203e30c661ca6b9ff5e8b844249b66f63097d335092c014bb80762dff9b',
  'js/gigui.js': 'fc3c11f3aa50020c98a37ab045174991e74507e2ec8c63171da02d5160235b8e',
  'js/googleauth.js': '80b649fd4ab750f8c2ca645f48c9e025122d39a8f5e54a7557d2e284a22684d1',
  'js/importname.js': 'd93f36bb749efe31daa2cb9663a073214fe1b1e49fc8ab2ec5980c50f5b3dd77',
  'js/ink.js': 'ace2a4724829be4c34e82a34c76fa67b3e41a1af5194c4abe25e3990b819fb15',
  'js/library.js': '940c36173198763549ebf80efc994856a729262c4a13add24e3e28c6f87689fc',
  'js/main.js': '008cf3890d356e6389429b0f33a0ae93be2dfac39a5212565d01e2337ecc3c3f',
  'js/menubox.js': 'cd13f0277cc0e8c583dc899b0dd0028a68662c0e9c7bf0ada0c8f372c0e84f51',
  'js/names.js': '1913f3a67efaace7a8b7502b404b652469883b12060d823df405be87ce0e11bd',
  'js/newversion.js': '75187c37c570b3e9d2218920a77481d9caad8c5e47d91136ae54c35cb109daac',
  'js/nudge.js': '4ddff5db637953081e764fdabf424294de67947775ce90c803dd23d505b9af59',
  'js/pagecache.js': 'd8ca855e0fef91f0c943ca50402fcbbe6f53e1505df5d4749f351ba36582f8fd',
  'js/prerender.js': 'f28d47f2eab8115f585b9f892d9bfc3bd1ac7ffa3b0f7d93c5ca11fee71e4651',
  'js/print.js': 'b27b90e8eb235ab3f93f483cbf3cb02d00250ce96b51f22ec593783c39a0a42b',
  'js/readycheck.js': 'fcc18c45c419fef68bb7db4e2ec84568b6243f0d2969c0b715b32ee39a30b356',
  'js/restoreask.js': '5a455f521fb06481df08a1ac328eddb0d5f07a7cb32d26023a64ebcd23407fe6',
  'js/restoreplan.js': 'b604d3793df309543ed1c472f96e0194840647de280c87e9c88756b716517b61',
  'js/saving.js': '2b9234b085063277e2b9b6884ce61bcba263223301f2bfaf5907a45d30297eea',
  'js/setlists.js': '4c0c4f137a09cd156d26af3f8a6449fd34ae77fef547446f812a8aac969fe943',
  'js/setlisttext.js': '39d397f07bc18817d7b100e0a162ff845e9cf65f5e091077c8f73542b2236093',
  'js/share.js': '22a3acff79a05beee0c9d6d5fcdd5337037225df904e24d178fec8037e32c523',
  'js/shareimport.js': '9a29c19f041cbaf18f31d4b743d80ef2e776587c6f2082dbe6f896ca4d167fa3',
  'js/sharepack.js': 'f73896e4e6dcbe98b02531818828ebf009e78ca6ed4a351a0798daae809ad46f',
  'js/songjump.js': 'efb9350ac38b9d9863f737a3fb6f1cd0604b3cf933fb847453b58b15ce07d012',
  'js/songlist.js': '0b7d22a612618f60a708af3e6d9283c9aceac2ffeeeafdc4000d315deb6128fe',
  'js/songpdf.js': '320e85d0afed38e7093678bc8beec875b3186be1ee3eed4f1205190d2ae68462',
  'js/songsets.js': '34d913b7bfaf4c7715e4843b28ae2c4147c395092c6f074911d5a7424fe02532',
  'js/split.js': 'dc47ae476e428233cc83039717bbff3893223f06eb10c86a04b11734ec0063f6',
  'js/store.js': 'fbf3343ca1d62739843dbabbc9cda17203720113f533720b90bf6532ab625942',
  'js/sync.js': '458b059593fe7f5682173be8fcd4334619148d428c5c67733fe0721bcf328b9b',
  'js/syncapply.js': '6a96913e71747fcf9ed08779a4ee7225f2cf33fd84acff970d774959aed14b17',
  'js/syncdialogs.js': '741a9d9ad851c581f31742d1f5aa11c8ef437d4059d4b3e60c5a2910ee54af9f',
  'js/syncink.js': '97d929e9f7d9a61f76caeec90a74a1805c1766bd837e4cd8d3c9f8d6d532f77d',
  'js/syncmarks.js': 'ee3f2431455a41dcbdb9d1dd2c0de6849a260f96febb0195453ff159ad22af51',
  'js/syncmerge.js': '318a65f8882358cce4960500264cfa7e4ed8b706f30ac04a59896ff87536a78a',
  'js/syncplan.js': '51bd34f6612f3428da13a11669da6a9ffe3bff6e502135c47d4f44bcad51e16d',
  'js/syncui.js': '6c90125f2cd4fb25db677e4dbd7eb4cdb621f6475fdf4e720007576f5464627e',
  'js/util.js': 'e65628f9474f6b30c0dfb2f7ad92528d92559abf86f4d3b9398c67e4398ebd9c',
  'js/viewer.js': '753308ff7ae533f78cc745cdb982ca9f3f89222df628399428e38d9453cff848',
  'js/zipread.js': '13807393fbe561e0bf016be89633ecc4719193086d7f6907128d32e60178765d',
  'manifest.webmanifest': '12cfcdf2a9e790df8dc729d4e7976ed47538d3b3bbff7503ae713eb32eb3fdde',
  'vendor/fonts/barlow-400.ttf': 'a35caa4687f434d66453c1fe423d7074cfa9fd7ab80c19b0780f3862887d2fc9',
  'vendor/fonts/barlow-500.ttf': '91c841fdfa8e7b94ffedbb983a363947ba6ed720f3bbf0c71d48b618053655bc',
  'vendor/fonts/barlow-600.ttf': 'c15439e7a03af5714282ec1780ff7b0214ec6a7db96300b54928dbcd2569ca0c',
  'vendor/fonts/barlowcondensed-600.ttf': '0d85af813fc3ed87db0c6265515689b2eef5cbaf7aab17922528dfc95a2cd73f',
  'vendor/fonts/barlowcondensed-700.ttf': '7dde307fa887fc65ff5830cfada77a7decc5dae8d3c816c9d39ba3f1af1c4ed7',
  'vendor/jszip.min.js': 'acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e',
  'vendor/pdf-lib.min.js': '0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f',
  'vendor/pdf.min.js': '5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946',
  'vendor/pdf.worker.min.js': 'feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b',
};

/* The Content-Type this worker answers with, by file extension. Never copied from a stored entry: a stored entry can carry
   any header (a Refresh, a wrong type) with correct bytes. tools/checks.mjs fails when a PRECACHE extension has no line here. */
const TYPES = {
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  png: 'image/png',
  ttf: 'font/ttf',
  webmanifest: 'application/manifest+json',
};

const BASE = new URL('./', self.location.href);   // this worker's own folder (the app lives under /setlist-stand/)
const typeOf = (key) => TYPES[(/\.([a-z0-9]+)$/i.exec(key === './' ? 'index.html' : key) || [])[1]] || 'application/octet-stream';
const urlOf = (key) => new URL(key, BASE).href;

/* The PRECACHE entry a request is for, or null. Only the path counts (a ?query is ignored); './' is the folder itself. */
function fileKey(url) {
  const u = new URL(url);
  if (u.origin !== BASE.origin || !u.pathname.startsWith(BASE.pathname)) return null;
  const rel = u.pathname.slice(BASE.pathname.length);
  const key = rel === '' ? './' : rel;
  return Object.prototype.hasOwnProperty.call(HASHES, key) ? key : null;
}

async function sha256(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let hex = '';
  for (const b of d) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/* What is stored for `key`: {} when nothing is (or the cache cannot be read), else {hit, bytes, ok} where ok says the bytes
   have the SHA-256 in HASHES. Looked at again on EVERY use: another page can change an entry between two requests. */
async function look(cache, key) {
  let hit;
  try { hit = await cache.match(urlOf(key), { ignoreVary: true }); } catch { return {}; }
  if (!hit) return {};
  try {
    const bytes = await hit.arrayBuffer();
    return { hit, bytes, ok: (await sha256(bytes)) === HASHES[key] };
  } catch {
    return { hit, bytes: null, ok: false, unreadable: true };      // stored, but it cannot be read now: not used, and not deleted (a good file must not be lost to one failed read; heal() writes over it)
  }
}

/* Every entry stored for that path (a ?query variant, and one stored with a Vary header, too). */
async function drop(cache, key) {
  try {
    for (const k of await cache.keys(urlOf(key), { ignoreSearch: true, ignoreVary: true })) await cache.delete(k, { ignoreVary: true });
  } catch { /* nothing more can be done here; the entry is still never used */ }
}

/* A stored file that is not the file: every entry for that path is deleted, so heal() sees it as missing, and the page is
   told (best effort: no page may be listening yet, or the worker may stop first; the file is never used either way). */
async function dropBad(cache, key) {
  await drop(cache, key);
  try {
    for (const c of await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })) {
      if (c.url.startsWith(BASE.href)) c.postMessage({ type: 'ss-bad-file', file: key });      // this app's pages only, not the other sites on the address
    }
  } catch { /* the Problem log line is best effort */ }
}

/* The answer for `key` from the cache, or null: a NEW response made from the stored bytes, status 200, this worker's own
   Content-Type, no other header. */
async function fromCache(key) {
  try {
    const cache = await caches.open(CACHE);
    const got = await look(cache, key);
    if (got.bytes && got.ok) return new Response(got.bytes, { status: 200, headers: { 'Content-Type': typeOf(key) } });
    if (got.hit && !got.unreadable) await dropBad(cache, key);
  } catch { /* the cache cannot be read at all: the network answers */ }
  return null;
}

/* {cache:'reload'}: every file comes from the server, never from the browser's HTTP cache. GitHub Pages sends
   max-age=600, so a plain addAll() during a second deploy within ten minutes could store the OLD files under the NEW
   VERSION. addAll() still fails the whole install if any file does not arrive. Then every stored file is read back and
   must have the SHA-256 this version was made with: a deploy that is only half out (a stale copy at the server's edge, a
   login page for a file) fails the install, so the old version keeps running. */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
    const wrong = [];
    for (const key of PRECACHE) {
      const got = await look(cache, key);
      if (!got.bytes || !got.ok) wrong.push(key);
    }
    if (wrong.length) {
      /* what failed goes, so the next try starts clean: another page can write into the cache of the NEXT version (its name is a date)
         an entry that addAll() does not replace (one stored with a Vary header, in Safari's engine), and every later try would fail */
      for (const key of wrong) await drop(cache, key);
      throw new Error(`stored files do not match the table: ${wrong.join(', ')}`);
    }
  })());
});

/* The offline copy refills itself (2026-11-23). Another site on the same github.io address can delete this app's cache
   (guitar-class's worker did: Cache Storage belongs to the whole address, not to a folder). js/boot.js asks for a check
   ('ss-heal') once per page load and after each update check, only when online. Missing files are fetched again ONLY
   when the server still has THIS version (its sw.js holds the same VERSION): otherwise a newer version is out, its own
   install fills its own cache, and this cache is left alone (no files of another version under this version's name).
   The cache is only (re)created once the version matched. (A newer worker activating in the middle of a refill could
   still see this cache come back; it reads only its own cache, and its next activate deletes this one again.)
   One refill at a time: a second request while one runs joins it (a load, a return to the screen and an 'online' burst
   close together must not fetch everything three times).
   Bytes too (2026-11-24): a stored file counts as present only when its bytes have the SHA-256 in HASHES; one that does not
   is deleted and counts as missing. 'whole' and 'healed' therefore mean every file is there AND is the file. Every file
   fetched must match the table before anything is stored. */
async function heal() {
  const have = (await caches.has(CACHE)) ? await caches.open(CACHE) : null;
  const looks = have ? await Promise.all(PRECACHE.map((key) => look(have, key))) : [];
  const missing = [];
  for (let i = 0; i < PRECACHE.length; i++) {
    const got = looks[i] || {};
    if (got.bytes && got.ok) continue;
    if (got.hit && !got.unreadable) await dropBad(have, PRECACHE[i]);
    missing.push(PRECACHE[i]);
  }
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
  /* Every answer is checked before ANY is stored: a hotel or school Wi-Fi login page can answer in place of a file (by a
     redirect, or as a page with status 200), and a refill never replaces a file already present, so a bad file would
     stay. Then nothing is stored, and the next time the app is on screen it tries again. The bytes are checked last: a
     file the server sends with the right type but other bytes is as bad as a login page. */
  let got;
  try {
    got = await Promise.all(missing.map(async (u) => {
      const res = await fetch(new Request(u, { cache: 'reload' }));
      const type = res.headers.get('content-type') || '';
      const bad = !res.ok || res.redirected || (/\.(js|css)$/.test(u) && /text\/html/i.test(type));
      if (bad) return null;
      const bytes = await res.arrayBuffer();
      return (await sha256(bytes)) === HASHES[u] ? [u, bytes] : null;
    }));
  } catch {
    return 'offline';
  }
  if (got.some((g) => !g)) return 'refused';
  /* A deploy can land while the files are arriving, and some of them would then be of the new version. Ask the server's
     VERSION again now that all have arrived: if it moved (or cannot be read), store nothing. */
  try {
    const again = await fetch('sw.js', { cache: 'no-store' });
    const m2 = again.ok && /const\s+VERSION\s*=\s*'([^']+)'/.exec(await again.text());
    if (!m2 || m2[1] !== VERSION) return 'newer';
  } catch {
    return 'offline';
  }
  const cache = await caches.open(CACHE);
  await Promise.all(got.map(([u, bytes]) => cache.put(urlOf(u), new Response(bytes, { status: 200, headers: { 'Content-Type': typeOf(u) } }))));
  return 'healed';
}

let healing = null;
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
  else if (event.data === 'ss-heal') {
    healing = healing || heal().finally(() => { healing = null; });
    event.waitUntil(healing.then(
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
    const key = fileKey(req.url);
    if (key) {
      const stored = await fromCache(key);
      if (stored) return stored;
    }
    /* A miss (or a stored file that failed, or a path that is not an app file) is answered from the network and NOT
       stored: after another site wiped this cache, the server may already hold a newer version, and its files must not
       land under this version's name. heal() is the one refill. */
    try {
      return await fetch(req);
    } catch (err) {
      if (req.mode === 'navigate') {
        const shell = await fromCache('index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

/* ════════════════════════════════════════════════════════════════
   Setlist Stand — KILL-SWITCH service worker (break glass; NOT live)

   WHAT IT IS. A complete service worker that switches the app's offline
   copy off. It is kept here, ready and tested, and nothing loads it from
   here. To use it, it is copied over the real worker:

       cp tools/kill-switch/kill-sw.js sw.js

   and pushed. The address must stay `sw.js` at the site root: a browser
   only replaces a worker with one at the same address.

   WHEN TO USE IT. Only when tablets are stuck on a broken copy of the app
   that the normal update does not clear: the update banner never comes,
   or tapping it still shows the broken app (for example a file the real
   worker must download at install is missing, so its install fails on
   every tablet and the old cached copy stays). A bad push on its own does
   NOT need it: revert the push and the real worker updates every tablet
   as usual. Steps: BREAK-GLASS.md (repo root), situation (b).

   WHAT IT DOES on each tablet, the next time the app is opened (the
   browser checks sw.js on every visit):
     install   takes over at once (skipWaiting). It downloads nothing, so
               its install cannot fail.
     activate  deletes this app's caches (every cache whose name starts
               with `setlist-stand-`; other sites on the same github.io
               address keep theirs), takes control of the open pages
               (clients.claim) and posts {type: 'ss-sw-killed'} to each of
               them. js/boot.js then reloads each open tab ONCE, after
               js/main.js left its "back to the song" note, so the tab runs from
               the network and the open song comes back.
     fetch     NO fetch handler. Every request goes straight to the
               network, as if there were no worker. While this is live the
               app needs the network: it does not open offline.
   It NEVER touches IndexedDB, localStorage or sessionStorage: the songs,
   PDFs, setlists and markings stay exactly as they were.
   It does not unregister itself. An unregistered worker comes back only
   when a page registers one again (js/boot.js does that on every load,
   which would install this same file again: a churn on every visit). A
   worker that stays registered and does nothing is replaced in place the
   moment the real sw.js is back.

   HOW TO GO BACK (BREAK-GLASS.md (b), "Going back"). Revert the commit
   that armed it (the real sw.js comes back), `node tools/checks.mjs
   --bump`, `node tools/checks.mjs`, commit, push, live loop. The real
   worker installs over this one and rebuilds the cache; the "Updated. Tap
   to reload" banner appears (or the next fresh start picks it up), and
   the app works offline again.

   CHECKS. While this file is the site's sw.js, `node tools/checks.mjs`
   fails (it reads PRECACHE and VERSION, which this file does not have)
   and so do the git hooks. That is expected during the emergency:
   BREAK-GLASS.md says how to push anyway. `checks.mjs --bump` finds no
   VERSION line here and changes nothing.

   PROOF. `node tools/loops.mjs --only "kill switch"` arms it on a local
   copy of the site in a real browser, checks every promise above, then
   goes back to the real worker and starts offline.
   ════════════════════════════════════════════════════════════════ */

/* Only this app's caches are touched: other sites on the same address
   (the github.io account) may keep caches of their own. */
const SITE_CACHE = /^setlist-stand-/;

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    /* Each step on its own: one that fails must not stop the next. A cache
       that could not be deleted is tried again by the next worker. */
    try {
      const names = await caches.keys();
      await Promise.all(names.filter(n => SITE_CACHE.test(n)).map(n => caches.delete(n).catch(() => false)));
    } catch { /* Cache Storage unavailable: nothing to delete */ }
    try { await self.clients.claim(); } catch { /* the next page load is not served from a cache anyway */ }
    try {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) c.postMessage({ type: 'ss-sw-killed' });
    } catch { /* a tab that misses this runs from the network on its next load */ }
  })());
});

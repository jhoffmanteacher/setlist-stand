/* js/boot.js: the service worker, the "Updated. Tap to reload" banner and the update checks (2026-11-23).

   A CLASSIC script (no import/export), loaded first by index.html with defer. It is its own script, so it runs even when a
   module of the app (js/main.js or anything it imports) fails to load or throws: a broken deploy still shows the banner
   for the next good one. js/main.js never imports this file (a broken boot.js must not take the app down with it); the
   two talk through window.ssBoot, set at the end of the setup below, so main.js can tell when this file failed (it then
   registers sw.js itself, with no banner).

   Rules (CLAUDE.md "Updates", .claude/rules/service-worker.md):
   - a new version waits for a tap on the banner; only the tapped tab reloads, once; never while a song, the songbook
     splitter or a restore/backup box is open (body.playing / .splitting / .busy; the CSS hides the banner then too);
   - the first install fires controllerchange too (clients.claim) and reloads nothing;
   - the kill switch (tools/kill-switch/kill-sw.js) posts ss-sw-killed: reload once;
   - before any reload, js/main.js's note puts the open song back (ssBoot.beforeReload).
   Update checks: at most once per GAP, only while the app is on screen, online, and no song/split/box is open. Kept in
   memory only (no storage key); the page load counts as a check (the browser checked sw.js on that navigation).
   Refill: another site on the same github.io address can delete this app's offline copy (Cache Storage belongs to the
   whole address). On each page load and each time the app is on screen (maybeCheck), the worker is asked ('ss-heal') to
   fetch what is missing again; it does so only when the server still has the SAME version (sw.js heal()). */
(function(){
  'use strict';
  if(!('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  const GAP = 60 * 60 * 1000;          // at most one update check an hour (Jonathan, 2026-11-23)
  const TICK = 5 * 60 * 1000;          // the timer only compares two numbers
  let reg = null, asked = false, reloaded = false, last = Date.now(), beforeReload = null;

  /* A dialog (js/util.js modal(): Edit song, a chart update list, a text import review...) sits UNDER the banner
     (.modal z-index 30, #update 50), so the banner is hidden while one is open and a tap cannot throw the dialog away. */
  const dialogOpen = () => !!document.querySelector('.modal');
  /* The one place that says "a song, the songbook splitter, a restore/backup box or a dialog is open". */
  const quiet = () => { const c = document.body ? document.body.classList : null; return !!c && (c.contains('playing') || c.contains('splitting') || c.contains('busy') || dialogOpen()); };
  function reloadNow(){
    if(reloaded) return; reloaded = true;
    try{ if(beforeReload) beforeReload(); }catch(e){ /* the song is not put back; the reload still happens */ }
    location.reload();
  }
  function banner(){
    let b = document.getElementById('update');
    if(!b){ b = document.createElement('button'); b.id = 'update'; b.hidden = true; b.textContent = 'Updated. Tap to reload'; document.body.appendChild(b); }
    return b;
  }
  function show(w){
    const note = banner();
    note.hidden = false;
    note.onclick = () => {
      if(dialogOpen()) return;                                     // hidden under a dialog: never acted on
      if(w.state === 'redundant'){ note.hidden = true; return; }   // that version was replaced: wait for the next banner
      asked = true;
      if(w.state === 'activated') reloadNow();                     // another tab already switched to it: just load it
      else w.postMessage('skip-waiting');                          // the new worker takes over, controllerchange follows
    };
  }
  /* A new worker that finishes installing gets the banner. It may already be installing when register() resolves
     (its updatefound fired before this ran), so that one is followed too. */
  function track(w){
    if(!w) return;
    const check = () => { if(w.state === 'installed' && sw.controller) show(w); };
    w.addEventListener('statechange', check); check();
  }
  function heal(){
    try{ if(sw.controller && navigator.onLine !== false) sw.controller.postMessage('ss-heal'); }catch(e){ /* nothing to refill with */ }
  }
  function watch(r){
    reg = r;
    if(r.waiting && sw.controller) show(r.waiting);
    track(r.installing);
    r.addEventListener('updatefound', () => track(r.installing));
    heal();
  }
  function underDialog(){ const b = document.getElementById('update'); if(b) b.style.display = dialogOpen() ? 'none' : ''; }
  if(document.body) new MutationObserver(underDialog).observe(document.body, {childList: true});      // dialogs go to the end of <body>
  /* Never mid-song (or mid-split, or under a restore/backup box or a dialog): a controllerchange then (another tab's tap) waits; this
     tab's own tap only happens where the banner shows. */
  sw.addEventListener('controllerchange', () => { if(asked && !quiet()) reloadNow(); });
  /* Listened for from the start, so the kill switch's message is not missed before load. */
  sw.addEventListener('message', e => { if(e.data && e.data.type === 'ss-sw-killed') reloadNow(); });

  /* Every time the app is on screen (and on each tick), online, with no song, split, box or dialog open: first the refill
     (another site may have wiped the offline copy since; it costs one look at the cache when nothing is missing), then,
     at most once per GAP, the update check. */
  function maybeCheck(){
    if(!reg || document.visibilityState !== 'visible' || quiet() || navigator.onLine === false) return;
    heal();
    if(Math.abs(Date.now() - last) < GAP) return;
    last = Date.now();
    reg.update().catch(() => {});      // offline, or the server is down: quiet; the next trigger tries again after GAP
  }
  document.addEventListener('visibilitychange', maybeCheck);
  addEventListener('online', maybeCheck);
  setInterval(maybeCheck, TICK);

  /* On load, as before: the first install downloads every precached file and must not compete with the first draw. The
     window load event fires even when the app's modules failed. */
  const start = () => { sw.register('sw.js').then(watch).catch(() => {}); };
  if(document.readyState === 'complete') start(); else addEventListener('load', start);

  window.ssBoot = Object.freeze({beforeReload(fn){ beforeReload = fn; }});
})();

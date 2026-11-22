import {initErrors, explainError} from './errors.js';
import {$, esc, hooks} from './util.js';
import {openStore, load, ensureHashes, initChanged, songById} from './store.js';
import {renderLibrary, onClick as libraryClick, addFiles, newVersion} from './library.js';
import {renderSetlists, onClick as setlistClick, closeSet, initSetlists} from './setlists.js';
import {backupNow, restoreFrom} from './backup.js';
import {initViewer, openViewer, resumeState} from './viewer.js';
import {initInk} from './ink.js';
import {initCrop} from './crop.js';
import {startSplit, initSplit} from './split.js';
import {importPackage} from './shareimport.js';
import {takeReturn} from './googleauth.js';
import {driveClick, announceSignIn} from './syncui.js';
import {onClick as collClick, initShown} from './collections.js';

/* FIRST, before anything else runs: if the page has just come back from Google's sign-in, read the answer and take the
   `#` part (it holds the token) off the address. Nothing else in the app reads the address. */
const signIn = takeReturn();
initErrors();      // first: the private problem log (Library → Problem log) catches anything that goes wrong after this

/* The database is upgraded the first time this version opens it. A tab still running the OLDER app keeps it open and cannot be
   told to let go, so the upgrade waits: say so in plain words (the message goes by itself when that tab is closed). A tab on this
   version lets go at once when a newer one asks (js/store.js). */
addEventListener('ss-db-blocked', () => {
  const w = $('#warn'); if(!w || w.querySelector('[data-dbblocked]')) return;
  w.insertAdjacentHTML('beforeend', '<p class="warn" role="alert" data-dbblocked>Setlist Stand is open in another tab or window, and it needs to be closed before this one can update your library. Close the other Setlist Stand tab; this one carries on by itself.</p>');
});
addEventListener('ss-db-open', () => { const m = document.querySelector('[data-dbblocked]'); if(m) m.remove(); });
addEventListener('ss-db-changed', () => {
  const w = $('#warn'); if(!w || w.querySelector('[data-dbchanged]')) return;
  w.insertAdjacentHTML('beforeend', '<p class="warn" role="alert" data-dbchanged>Setlist Stand was updated in another tab. Reload this page before you change anything here.</p>');
});

/* Nothing on the screen works until the library has been read: while the upgrade is blocked, or the database cannot be opened, a tap
   on a tab or a picked file must not draw an empty library or write into it. */
let ready = false;
let tab = 'lib';
function render(){
  if(!ready) return;
  $('#tLib').setAttribute('aria-selected', tab === 'lib');
  $('#tSets').setAttribute('aria-selected', tab !== 'lib');
  const v = $('#view');
  if(tab === 'lib') renderLibrary(v); else renderSetlists(v);
}
hooks.render = render;

$('#tLib').onclick = () => { tab = 'lib'; render(); };
$('#tSets').onclick = () => { tab = 'sets'; closeSet(); render(); };
$('#file').onchange = async e => { if(!ready){ e.target.value = ''; return; } const fs = [...e.target.files]; e.target.value = ''; await addFiles(fs); };
$('#newVersionFile').onchange = async e => { if(!ready){ e.target.value = ''; return; } const f = e.target.files[0]; e.target.value = ''; await newVersion(f); };
$('#splitFile').onchange = async e => { if(!ready){ e.target.value = ''; return; } const f = e.target.files[0]; e.target.value = ''; await startSplit(f); };
$('#shareFile').onchange = async e => { if(!ready){ e.target.value = ''; return; } const f = e.target.files[0]; e.target.value = ''; await importPackage(f); };
$('#restoreFile').onchange = async e => { if(!ready){ e.target.value = ''; return; } const f = e.target.files[0]; e.target.value = ''; await restoreFrom(f, render); };

$('#view').addEventListener('click', async e => {
  const b = e.target.closest('button'); if(!b) return;
  const d = b.dataset;
  if('restore' in d) return $('#restoreFile').click();
  if('backup' in d || 'backupnow' in d) return backupNow(b);
  if(await driveClick(b, d)) return;
  if(await collClick(b, d)) return;
  if(await libraryClick(b, d)) return;
  await setlistClick(b, d);
});

/* ---------- offline: the service worker keeps the app on the device ----------
   A new version waits until Jonathan taps "Updated. Tap to reload" (never in the middle of a song). Only the tab whose
   banner was tapped reloads; another open tab keeps running and shows its own banner. The first install also fires
   controllerchange (clients.claim) and must not reload anything. If a song was open, the reload puts it back. */
let reloaded = false;
const reloadNow = () => { if(reloaded) return; reloaded = true; saveResume(); location.reload(); };
function watchUpdates(reg){
  const note = $('#update');
  let asked = false;
  const show = w => {
    note.hidden = false;
    note.onclick = () => {
      if(w.state === 'redundant'){ note.hidden = true; return; }   // that version was replaced: wait for the next banner
      asked = true;
      if(w.state === 'activated') reloadNow();       // another tab already switched to it: just load it
      else w.postMessage('skip-waiting');            // the new worker takes over, controllerchange follows
    };
  };
  /* A new worker that finishes installing gets the banner. It may already be installing when register() resolves
     (its updatefound fired before this ran), so that one is followed too. */
  const track = w => {
    if(!w) return;
    const check = () => { if(w.state === 'installed' && navigator.serviceWorker.controller) show(w); };
    w.addEventListener('statechange', check); check();
  };
  if(reg.waiting && navigator.serviceWorker.controller) show(reg.waiting);
  track(reg.installing);
  reg.addEventListener('updatefound', () => track(reg.installing));
  /* Never mid-song (or mid-split): a controllerchange while a song or the songbook splitter is open (another tab's tap)
     waits; this tab's own tap only happens on the home screen, where the banner shows. */
  navigator.serviceWorker.addEventListener('controllerchange', () => { if(asked && !document.body.classList.contains('playing') && !document.body.classList.contains('splitting') && !document.body.classList.contains('busy')) reloadNow(); });
}
if('serviceWorker' in navigator){
  /* The kill switch (tools/kill-switch/kill-sw.js, BREAK-GLASS.md) emptied the cache and took over: reload this tab once
     so it runs from the network. Listened for from the start, so the message is not missed before load. */
  navigator.serviceWorker.addEventListener('message', e => { if(e.data && e.data.type === 'ss-sw-killed') reloadNow(); });
  addEventListener('load', () => { navigator.serviceWorker.register('sw.js').then(watchUpdates).catch(() => {}); });
}

/* ---------- back to the song after an update reload ---------- */
const RESUME = 'ss-resume';
function saveResume(){
  try{ const r = resumeState(); if(r) sessionStorage.setItem(RESUME, JSON.stringify(r)); }catch(e){}
}
async function applyResume(){
  let r = null;
  try{ r = JSON.parse(sessionStorage.getItem(RESUME) || 'null'); sessionStorage.removeItem(RESUME); }catch(e){}
  if(!r || !Array.isArray(r.queue)) return;
  const ok = r.queue.filter(e => e.type === 'break' || songById(e.id));
  if(ok.length !== r.queue.length || !ok.some(e => e.type === 'song')) return;   // the library changed: do not guess
  await openViewer(r.queue, r.qi, r.page);
}

/* ---------- start ---------- */
(async () => {
  let persistent;
  try{ persistent = await openStore(); }
  catch(e){      // nothing is read or written: either the library was made by a newer version (this copy was rolled back), or the upgrade could not be saved
    const newer = e && e.name === 'VersionError';
    $('#warn').innerHTML = '<p class="warn" role="alert">' + (newer
      ? 'Your library was saved by a newer version of Setlist Stand than this copy. It was left alone. Do not add or restore anything here: see BREAK-GLASS.md, situation (a).'
      : esc(explainError(e, 'The library could not be updated.')) + ' Nothing was changed. Free some space on the tablet, then reload this page.') + '</p>';
    return;
  }
  if(!persistent) $('#warn').innerHTML = '<p class="warn">This browser blocked on-device storage, so music you add here disappears when you close the page.</p>';
  try{ navigator.storage && navigator.storage.persist && navigator.storage.persist(); }catch(e){}
  if(!window.pdfjsLib) $('#warn').innerHTML += '<p class="warn">The PDF reader did not load. Reload the page.</p>';
  else pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  initViewer(); initInk(); initCrop(); initSetlists(); initSplit();
  await load(); initShown(); ready = true; render();
  initChanged().catch(() => {});             // after the first draw: the newest change among the ink pages, for the backup reminder
  announceSignIn(signIn).catch(() => {});      // only when the page came back from a sign-in the person started
  await applyResume();
  ensureHashes().catch(() => {});
})();

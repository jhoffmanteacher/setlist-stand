import {initErrors, explainError} from './errors.js';
import {$, esc, hooks} from './util.js';
import {openStore, load, ensureHashes, initChanged, songById} from './store.js';
import {renderLibrary, onClick as libraryClick, addFiles, newVersion} from './library.js';
import {renderSetlists, onClick as setlistClick, closeSet, showSet, initSetlists} from './setlists.js';
import {importSetlistText} from './setlisttext.js';
import {backupNow, restoreFrom} from './backup.js';
import {initViewer, openViewer, resumeState} from './viewer.js';
import {dropLeftover, sync as syncHistory} from './backnav.js';
import {initInk} from './ink.js';
import {initCrop} from './crop.js';
import {startSplit, initSplit} from './split.js';
import {importPackage} from './shareimport.js';
import {importChartUpdates} from './chartupdate.js';
import {takeReturn} from './googleauth.js';
import {driveClick, announceSignIn} from './syncui.js';
import {onClick as collClick, initShown} from './collections.js';

/* FIRST, before anything else runs: if the page has just come back from Google's sign-in, read the answer and take the
   `#` part (it holds the token) off the address. Nothing else in the app reads the address. */
const signIn = takeReturn();
initErrors();      // first: the private problem log (Library → Problem log) catches anything that goes wrong after this

/* Updates (service worker, "Updated. Tap to reload", update checks, the kill switch's reload) are js/boot.js, a separate
   classic script that runs even when a module here fails to load. This file only leaves the "back to the song" note
   before such a reload. If boot.js itself failed, keep the offline copy installed and updating: no banner then, the
   update takes over when the app is closed and opened again (BREAK-GLASS.md (a)). */
if(window.ssBoot) window.ssBoot.beforeReload(saveResume);
else if('serviceWorker' in navigator) addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });

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
$('#chartUpdateFile').onchange = async e => { if(!ready){ e.target.value = ''; return; } const f = e.target.files[0]; e.target.value = ''; await importChartUpdates(f); };
$('#setTextFile').onchange = async e => { if(!ready){ e.target.value = ''; return; } const f = e.target.files[0]; e.target.value = ''; await importSetlistText(f, showSet); };
$('#restoreFile').onchange = async e => { if(!ready){ e.target.value = ''; return; } const f = e.target.files[0]; e.target.value = ''; await restoreFrom(f, render); };

$('#view').addEventListener('click', async e => {
  const b = e.target.closest('button'); if(!b) return;
  const d = b.dataset;
  if('backupnow' in d) return backupNow(b);          // the reminder's Back up now (the Library's Back up / Sync menu is js/library.js)
  if(await driveClick(b, d)) return;
  if(await collClick(b, d)) return;
  if(await libraryClick(b, d)) return;
  await setlistClick(b, d);
});

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
  await openViewer(r.queue, r.qi, r.page);     // no tap here, so no new history entry: the one from before the reload is reused (js/backnav.js)
}

/* ---------- start ---------- */
(async () => {
  /* A song's history entry left from before a reload goes before anything is read or drawn; an update reload that puts the
     song back reuses it (js/backnav.js). */
  let resuming = false; try{ resuming = !!sessionStorage.getItem(RESUME); }catch(e){}
  await dropLeftover(resuming);
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
  syncHistory();                               // a resume that could not put the song back drops the entry it would have reused
  ensureHashes().catch(() => {});
})();

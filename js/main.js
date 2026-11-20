import {initErrors} from './errors.js';
import {$, hooks} from './util.js';
import {openStore, load, ensureHashes, songById} from './store.js';
import {renderLibrary, onClick as libraryClick, addFiles, replacePdf} from './library.js';
import {renderSetlists, onClick as setlistClick, closeSet, initSetlists} from './setlists.js';
import {backupNow, restoreFrom} from './backup.js';
import {initViewer, openViewer, resumeState} from './viewer.js';
import {initInk} from './ink.js';
import {initCrop} from './crop.js';

initErrors();      // first: the private problem log (Library → Problem log) catches anything that goes wrong after this

let tab = 'lib';
function render(){
  $('#tLib').setAttribute('aria-selected', tab === 'lib');
  $('#tSets').setAttribute('aria-selected', tab !== 'lib');
  const v = $('#view');
  if(tab === 'lib') renderLibrary(v); else renderSetlists(v);
}
hooks.render = render;

$('#tLib').onclick = () => { tab = 'lib'; render(); };
$('#tSets').onclick = () => { tab = 'sets'; closeSet(); render(); };
$('#file').onchange = async e => { const fs = [...e.target.files]; e.target.value = ''; await addFiles(fs); };
$('#replaceFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; await replacePdf(f); };
$('#restoreFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; await restoreFrom(f, render); };

$('#view').addEventListener('click', async e => {
  const b = e.target.closest('button'); if(!b) return;
  const d = b.dataset;
  if('restore' in d) return $('#restoreFile').click();
  if('backup' in d || 'backupnow' in d) return backupNow(b);
  if(await libraryClick(b, d)) return;
  await setlistClick(b, d);
});

/* ---------- offline: the service worker keeps the app on the device ----------
   A new version waits until Jonathan taps "Updated. Tap to reload" (never in the middle of a song). Only the tab whose
   banner was tapped reloads; another open tab keeps running and shows its own banner. The first install also fires
   controllerchange (clients.claim) and must not reload anything. If a song was open, the reload puts it back. */
function watchUpdates(reg){
  const note = $('#update');
  let asked = false, reloaded = false;
  const reloadNow = () => { if(reloaded) return; reloaded = true; saveResume(); location.reload(); };
  const show = w => {
    note.hidden = false;
    note.onclick = () => {
      asked = true;
      if(w.state === 'activated') reloadNow();       // another tab already switched to it: just load it
      else w.postMessage('skip-waiting');            // the new worker takes over, controllerchange follows
    };
  };
  if(reg.waiting && navigator.serviceWorker.controller) show(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const w = reg.installing; if(!w) return;
    w.addEventListener('statechange', () => { if(w.state === 'installed' && navigator.serviceWorker.controller) show(w); });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if(asked) reloadNow(); });
}
if('serviceWorker' in navigator){
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
  const persistent = await openStore();
  if(!persistent) $('#warn').innerHTML = '<p class="warn">This browser blocked on-device storage, so music you add here disappears when you close the page.</p>';
  try{ navigator.storage && navigator.storage.persist && navigator.storage.persist(); }catch(e){}
  if(!window.pdfjsLib) $('#warn').innerHTML += '<p class="warn">The PDF reader did not load. Reload the page.</p>';
  else pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  initViewer(); initInk(); initCrop(); initSetlists();
  await load(); render();
  await applyResume();
  ensureHashes().catch(() => {});
})();

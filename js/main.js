import {$, hooks} from './util.js';
import {openStore, load} from './store.js';
import {renderLibrary, onClick as libraryClick, addFiles} from './library.js';
import {renderSetlists, onClick as setlistClick, closeSet} from './setlists.js';
import {backupNow, restoreFrom} from './backup.js';
import {initViewer} from './viewer.js';
import {initInk} from './ink.js';

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
$('#restoreFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; await restoreFrom(f, render); };

$('#view').addEventListener('click', async e => {
  const b = e.target.closest('button'); if(!b) return;
  const d = b.dataset;
  if('restore' in d) return $('#restoreFile').click();
  if('backup' in d) return backupNow(b);
  if(await libraryClick(b, d)) return;
  await setlistClick(b, d);
});

/* ---------- offline: the service worker keeps the app on the device ---------- */
const hadController = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
function watchUpdates(reg){
  const note = $('#update');
  const show = w => { note.hidden = false; note.onclick = () => w.postMessage('skip-waiting'); };
  if(reg.waiting && navigator.serviceWorker.controller) show(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const w = reg.installing; if(!w) return;
    w.addEventListener('statechange', () => { if(w.state === 'installed' && navigator.serviceWorker.controller) show(w); });
  });
  /* Reload only for a real update. The first install also fires controllerchange (clients.claim) and must not reload the page. */
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if(reloaded || !hadController) return; reloaded = true; location.reload(); });
}
if('serviceWorker' in navigator){
  addEventListener('load', () => { navigator.serviceWorker.register('sw.js').then(watchUpdates).catch(() => {}); });
}

/* ---------- start ---------- */
(async () => {
  const persistent = await openStore();
  if(!persistent) $('#warn').innerHTML = '<p class="warn">This browser blocked on-device storage, so music you add here disappears when you close the page.</p>';
  try{ navigator.storage && navigator.storage.persist && navigator.storage.persist(); }catch(e){}
  if(!window.pdfjsLib) $('#warn').innerHTML += '<p class="warn">The PDF reader did not load. Reload the page.</p>';
  else pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  initViewer(); initInk();
  await load(); render();
})();

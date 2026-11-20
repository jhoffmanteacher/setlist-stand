import {$, esc, uid, toast, form, armed, hooks, modal} from './util.js';
import {putAll, get, load, state, songById, saveSong, sha256, upgradeInk, inkRecord, reconcile, ensureHashes} from './store.js';
import {parseFileName} from './importname.js';
import {displayName} from './names.js';
import {explainError, getProblems, showProblemLog} from './errors.js';
import {openViewer} from './viewer.js';

let q = '', showArchived = false, replaceTarget = null;

export function renderLibrary(v){
  v.innerHTML = `<div class="bar"><input type="search" id="q" placeholder="Search songs" value="${esc(q)}" aria-label="Search songs"><button class="pri" data-add>Add PDFs</button></div><div id="libNudge"></div><div id="libList"></div>
    <label class="sw-row"><input type="checkbox" id="showArch" ${showArchived ? 'checked' : ''}>Show archived</label>
    <div class="bar" style="margin-top:12px"><button data-backup>Back up everything</button><button data-restore>Restore from backup</button></div>
    <p class="hint">A backup is one .zip file with every PDF, setlist and annotation. Save it to Google Drive to keep it safe or move it to another tablet.</p>
    <div id="libSafety"><p class="hint" id="libLastBackup"></p><div id="libStorage"></div><div id="libProblems"></div></div>`;
  $('#q').oninput = e => { q = e.target.value; renderLib(); };
  $('#showArch').onchange = e => { showArchived = e.target.checked; renderLib(); };
  renderLib();
  renderSafety();
}
const matches = s => (s.title + ' ' + s.song + ' ' + s.artist + ' ' + s.version).toLowerCase().includes(q.trim().toLowerCase());
const pages = s => `${esc(s.pages)} page${s.pages == 1 ? '' : 's'}`;
function renderLib(){
  const live = state.songs.filter(s => !s.archived), arch = state.songs.filter(s => s.archived);
  const list = live.filter(matches), alist = arch.filter(matches);
  let html = live.length
    ? `<ul class="list">${list.map(s => { const id = esc(s.id); return `<li class="row"><button class="main" data-open="${id}"><span class="t">${esc(s.title)}</span><span class="s">${pages(s)}</span></button><div class="acts"><button data-edit="${id}">Edit</button><button data-archive="${id}">Archive</button><button data-replace="${id}">Replace PDF</button><button data-del="${id}">Delete</button></div></li>`; }).join('')}</ul>${list.length ? '' : '<p class="empty">No songs match.</p>'}`
    : `<div class="empty"><h2>No music yet</h2><p>Add PDF charts from your tablet's files or Drive. They're saved on this device.</p></div>`;
  if(showArchived){
    html += `<h2 style="margin-top:28px;font-size:26px">Archived</h2>` + (alist.length
      ? `<ul class="list">${alist.map(s => { const id = esc(s.id); return `<li class="row"><button class="main" data-open="${id}"><span class="t">${esc(s.title)}</span><span class="s">${pages(s)} · Archived</span></button><div class="acts"><button data-restoresong="${id}">Restore</button><button data-del="${id}">Delete</button></div></li>`; }).join('')}</ul>`
      : `<p class="hint">${arch.length ? 'No archived songs match.' : 'Nothing archived.'}</p>`);
  }
  $('#libList').innerHTML = html;
}

/* Reads one PDF: page count and hash. Throws if pdf.js cannot open it. */
async function inspect(file){
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({data:new Uint8Array(buf.slice(0))}).promise;
  const n = doc.numPages; doc.destroy();
  return {buf, pages:n, hash:await sha256(buf)};
}

/* Adding PDFs. First every file's hash is compared with the library (live and archived songs) and with the files
   before it in the same batch; PDFs already there are listed in ONE question (skip them, or add anyway).
   Each song is then saved with its PDF in one transaction, so a full tablet never leaves half a song behind. */
const plural = (n, w) => `${n} ${w}${n == 1 ? '' : 's'}`;
export async function addFiles(fileList){
  const fs = [...fileList].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if(!fs.length) return;
  toast(`Adding ${plural(fs.length, 'PDF')}…`);
  await ensureHashes().catch(() => {});
  const known = new Set(state.songs.map(s => s.hash).filter(Boolean)), items = [];
  for(const f of fs){
    let hash = null;
    try{ hash = await sha256(await f.arrayBuffer()); }catch(err){}
    const dup = !!hash && known.has(hash);
    if(hash) known.add(hash);
    items.push({f, dup});
  }
  const dups = items.filter(x => x.dup);
  let skipped = 0;
  if(dups.length && !(await askDuplicates(dups.map(x => x.f.name)))){ skipped = dups.length; }
  let ok = 0, failed = 0;
  const unread = [];
  for(const {f, dup} of items){
    if(dup && skipped) continue;
    let r;
    try{ r = await inspect(f); }catch(err){ unread.push(f.name); continue; }
    const id = uid(), t = Date.now();
    const s = {id, ...parseFileName(f.name), archived:false, pages:r.pages, hash:r.hash, added:t, updated:t};
    s.title = displayName(s);
    try{ await putAll([{store:'files', key:id, value:new Blob([r.buf], {type:'application/pdf'})}, {store:'songs', key:id, value:s}]); ok++; }
    catch(err){
      failed = items.filter(x => !(x.dup && skipped)).length - ok - unread.length;
      await load(); hooks.render();
      toast(ok ? `Added ${plural(ok, 'song')}. ${explainError(err, 'Something went wrong.').replace(' Nothing was changed.', '')} ${failed == 1 ? 'The last PDF was' : `The other ${failed} PDFs were`} not added.`
        : explainError(err));
      return;
    }
  }
  await load(); hooks.render();
  const parts = [];
  if(ok) parts.push(`Added ${plural(ok, 'song')}`);
  if(skipped) parts.push(`Skipped ${skipped} already in your library`);
  if(unread.length) parts.push(`Could not read ${unread.join(', ')}`);
  if(parts.length) toast(parts.join('. ') + (parts.length > 1 ? '.' : ''));
}

/* One question for every PDF that is already in the library. Resolves true for "Add anyway". */
function askDuplicates(names){
  return new Promise(res => {
    const shown = names.slice(0, 8), more = names.length - shown.length;
    const m = modal(`<h2>Already in your library</h2><p>${names.length == 1 ? 'This PDF is' : 'These PDFs are'} already in your library:</p>
      <ul class="duplist">${shown.map(n => `<li>${esc(n)}</li>`).join('')}${more > 0 ? `<li>and ${more} more</li>` : ''}</ul>
      <div class="btns"><button data-dupadd>Add anyway</button><button class="pri" data-dupskip data-x>Skip ${names.length == 1 ? 'it' : 'them'}</button></div>`);
    m.classList.add('dupask');
    const done = v => { m.remove(); removeEventListener('keydown', onKey); res(v); };
    const onKey = e => { if(e.key === 'Escape') done(false); };
    addEventListener('keydown', onKey);
    m.querySelector('[data-dupskip]').onclick = () => done(false);
    m.querySelector('[data-dupadd]').onclick = () => done(true);
    m.querySelector('[data-dupskip]').focus();
  });
}

/* Swap in a corrected PDF. The song keeps its id, details and setlist places; its annotations start fresh. */
export async function replacePdf(file){
  const id = replaceTarget; replaceTarget = null;
  const s = songById(id); if(!s || !file) return;
  let r;
  try{ r = await inspect(file); }catch(err){ toast('Could not read ' + file.name); return; }
  try{
    /* One transaction: the new PDF, the song's new page count and hash, and its cleared annotations are all saved, or none. */
    const {buf, pages:n, hash} = r, ops = [{store:'files', key:id, value:new Blob([buf], {type:'application/pdf'})}];
    for(let p = 1; p <= s.pages; p++){
      const key = id + ':' + p, cur = upgradeInk(await get('ink', key)).record.strokes;
      if(p > n) ops.push({store:'ink', key, delete:true});                                       // that page no longer exists
      else if(cur.length) ops.push({store:'ink', key, value:inkRecord(reconcile(cur, []))});     // keep deletion markers for the pages that remain
    }
    const song = {...s, pages:n, hash, title:displayName(s), updated:Date.now()};
    ops.push({store:'songs', key:id, value:song});
    await putAll(ops);
    await load(); hooks.render(); toast('Chart replaced. Annotations cleared.' + (s.crop ? ' Crop kept. Use Reset in the crop screen if the layout changed.' : ''));
  }catch(err){ await load(); hooks.render(); toast(explainError(err)); }
}

/* Returns true when the click was for the library. */
export async function onClick(b, d){
  if('add' in d){ $('#file').click(); return true; }
  if('persist' in d){ await askPersist(b); return true; }
  if('problems' in d){ showProblemLog(); return true; }
  if(d.open){ openViewer([{type:'song', id:d.open}], 0); return true; }
  if(d.edit){
    const s = songById(d.edit);
    const r = await form('Edit song', [{key:'song', label:'Title', value:s.song}, {key:'artist', label:'Artist', value:s.artist}, {key:'version', label:'Version', value:s.version}]);
    if(r && r.song){ s.song = r.song; s.artist = r.artist; s.version = r.version; await saveSong(s); await load(); hooks.render(); }
    return true;
  }
  if(d.archive || d.restoresong){
    const s = songById(d.archive || d.restoresong); s.archived = !!d.archive;
    await saveSong(s); await load(); hooks.render(); return true;
  }
  if(d.replace){
    if(!armed(b, 'Clears notes. Tap again')) return true;
    replaceTarget = d.replace; $('#replaceFile').click(); return true;
  }
  if(d.del){
    if(!armed(b)) return true;
    const s = songById(d.del); if(!s) return true;
    /* One transaction: the PDF and ink go, the song becomes a deletion marker and the setlists that had it are updated. */
    const t = Date.now(), isIt = it => it.type === 'song' && it.id === s.id;
    const ops = [{store:'files', key:s.id, delete:true}, {deleteInkFor:s.id}, {store:'songs', key:s.id, value:{id:s.id, deleted:true, updated:t}}];
    for(const st of state.sets) if(st.items.some(isIt)) ops.push({store:'sets', key:st.id, value:{...st, items:st.items.filter(it => !isIt(it)), updated:t}});
    try{ await putAll(ops); }
    catch(err){ toast(explainError(err)); }
    await load(); hooks.render(); return true;
  }
  return false;
}

/* ---------- data safety: backup reminder, storage status, problem log ----------
   All of it is read on the device. Every browser API is guarded: if one is missing, that line is simply left out. */
const LAST_BACKUP = 'ss-last-backup', NUDGE_DAYS = 14;
function lastBackup(){ try{ const t = Number(localStorage.getItem(LAST_BACKUP)); return t > 0 ? t : null; }catch(e){ return null; } }
function daysAgo(t){
  const day = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  return Math.max(0, Math.round((day(Date.now()) - day(t)) / 864e5));
}
const agoText = n => n == 0 ? 'today' : n == 1 ? 'yesterday' : `${n} days ago`;

function renderSafety(){
  const nudge = $('#libNudge'), last = $('#libLastBackup');
  if(!nudge || !last) return;
  const t = lastBackup(), n = t == null ? null : daysAgo(t);
  const due = state.songs.length > 0 && (t == null || n > NUDGE_DAYS);
  nudge.innerHTML = due ? `<div class="nudge" role="status"><span>${t == null ? 'You have not backed up yet.' : `Last backup: ${agoText(n)}.`}</span><button data-backupnow>Back up now</button></div>` : '';
  last.textContent = !due && t != null ? `Last backup: ${agoText(n)}.` : '';
  renderProblems();
  renderStorage();
}

function renderProblems(){
  const el = $('#libProblems'); if(!el) return;
  const n = getProblems().length;
  el.innerHTML = n ? `<button class="plbtn" data-problems>Problem log (${n})</button>` : '';
}
addEventListener('ss-problems', renderProblems);

const size = b => b >= 1e9 ? `${+(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : 'less than 1 MB';
async function renderStorage(){
  const el = $('#libStorage'); if(!el) return;
  let est = null, persisted = null;
  try{ if(navigator.storage && navigator.storage.estimate) est = await navigator.storage.estimate(); }catch(e){}
  try{ if(navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); }catch(e){}
  if(!el.isConnected) return;
  const lines = [];
  if(est && typeof est.usage === 'number' && est.quota > 0){
    lines.push(`<p class="hint" data-storage>Storage: ${size(est.usage)} used of about ${size(est.quota)}.</p>`);
    const free = est.quota - est.usage;
    if(free < est.quota * .1 || free < 200e6) lines.push(`<p class="hint warnline">The tablet is nearly full.</p>`);
  }
  if(persisted === false && navigator.storage && navigator.storage.persist)
    lines.push(`<p class="hint warnline" data-unprotected>Your browser may clear this app's data if the tablet runs low on space. Back up regularly.</p><button data-persist>Ask the browser to protect it</button>`);
  else if(persisted === true) lines.push(`<p class="hint" data-protected>The browser will keep this app's data.</p>`);
  el.innerHTML = lines.join('');
}
async function askPersist(b){
  let ok = false;
  try{ b.disabled = true; ok = await navigator.storage.persist(); }catch(e){}
  toast(ok ? "The browser will keep this app's data." : 'The browser did not agree. Back up regularly.');
  await renderStorage();
}

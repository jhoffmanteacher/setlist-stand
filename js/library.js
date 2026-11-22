import {$, esc, toast, form, armed, hooks, modal, busy, pdfPageCount} from './util.js';
import {putAll, get, load, state, songById, saveSong, newSong, sha256, upgradeInk, inkRecord, reconcile, ensureHashes} from './store.js';
import {parseFileName} from './importname.js';
import {displayName, compareSongs} from './names.js';
import {explainError, getProblems, showProblemLog} from './errors.js';
import {openViewer} from './viewer.js';
import {shareSongs} from './share.js';
import {unique} from './shareimport.js';
import {renderDrive} from './syncui.js';
import {copySong} from './copysong.js';
import {pickerHtml, shownColl, joinColls, inShown, collOptions, applyTicks} from './collections.js';

let q = '', showArchived = false, newVersionOf = null, nvRunning = false;

export function renderLibrary(v){
  v.innerHTML = `${pickerHtml()}<div class="bar"><input type="search" id="q" placeholder="Search songs" value="${esc(q)}" aria-label="Search songs"><button class="pri" data-add>Add PDFs</button><button data-split>Split a songbook</button><button data-sharesongs>Share songs</button><button data-shareimport>Import a share package</button></div><div id="libNudge"></div><div id="libList"></div>
    <label class="sw-row"><input type="checkbox" id="showArch" ${showArchived ? 'checked' : ''}>Show archived</label>
    <div class="bar" style="margin-top:12px"><button data-backup>Back up everything</button><button data-restore>Restore from backup</button></div>
    <p class="hint">A backup is one .zip file with every PDF, setlist and annotation. Save it to Google Drive to keep it safe or move it to another tablet.</p>
    <div id="libDrive"></div>
    <div id="libSafety"><p class="hint" id="libLastBackup"></p><div id="libStorage"></div><div id="libProblems"></div></div>`;
  $('#q').oninput = e => { q = e.target.value; renderLib(); };
  $('#showArch').onchange = e => { showArchived = e.target.checked; renderLib(); };
  renderLib();
  renderSafety();
  renderDrive();
}
const matches = s => (s.title + ' ' + s.song + ' ' + s.artist + ' ' + s.version).toLowerCase().includes(q.trim().toLowerCase());
const pages = s => `${esc(s.pages)} page${s.pages == 1 ? '' : 's'}`;
function renderLib(){
  const sorted = state.songs.filter(inShown).sort(compareSongs);      // A to Z by song name, when the list is drawn (the same for Archived and search); only the collection being shown
  const live = sorted.filter(s => !s.archived), arch = sorted.filter(s => s.archived);
  const list = live.filter(matches), alist = arch.filter(matches), coll = shownColl();
  let html = coll && !live.length
    ? `<div class="empty"><h2>No songs in ${esc(coll.name)} yet</h2><p>Add songs from your library to this collection.</p><button class="pri" data-addcollsongs="${esc(coll.id)}">Add songs to ${esc(coll.name)}</button></div>`
    : live.length
    ? `<ul class="list">${list.map(s => { const id = esc(s.id); return `<li class="row"><button class="main" data-open="${id}"><span class="t">${esc(s.title)}</span><span class="s">${pages(s)}</span></button><div class="acts"><button data-edit="${id}">Edit</button><button data-copy="${id}">Copy</button><button data-archive="${id}">Archive</button><button data-newversion="${id}">New version</button><button data-del="${id}">Delete</button></div></li>`; }).join('')}</ul>${list.length ? '' : '<p class="empty">No songs match.</p>'}`
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
  const n = await pdfPageCount(buf);
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
    const s = newSong(parseFileName(f.name), r.pages, r.hash, joinColls()), id = s.id;
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

/* New version (it took the place of Replace PDF, which threw the old chart and its marks away): the file picked becomes the
   song's chart, and the chart it had is kept as an archived song, so nothing is lost.
   - The song keeps its id, details, crop and setlist places, so every setlist plays the new chart and no setlist is written.
     Its PDF, page count and hash become the new file's; its marks start fresh (each becomes a deletion marker through
     reconcile(), as if erased; the ink record of a page the new chart does not have is removed).
   - The old chart becomes a NEW song with a fresh id (unique(), as share import makes them), archived and in no setlist: the
     stored PDF bytes copied as they are (never re-saved, so its hash stays the same), its song and artist, its version with
     "old YYYY-MM-DD" added ("War Pigs (old 2026-11-21) - Black Sabbath", "(in G, old 2026-11-21)"), its crop, and the live
     marks and notes of every page, under the new id (ids, points and times as they were).
   - A PDF already in the library (this song's own included) gets the usual duplicate question first; then one confirm; then
     ONE putAll(): the new PDF, the song, its cleared marks and the old copy's PDF, record and marks are all saved, or none.
   - A song with no stored PDF at all still takes the new chart, but then nothing can move to Archived: the confirm says so
     before anything is written. A stored PDF that is there but cannot be read stops New version: nothing is changed. */
export async function newVersion(file){
  const id = newVersionOf; newVersionOf = null;
  const s = songById(id); if(!s || !file) return;
  if(nvRunning){ toast('A New version is already in progress.'); return; }
  nvRunning = true;
  try{ await runNewVersion(file, id, s); } finally { nvRunning = false; }
}
async function runNewVersion(file, id, s){
  let r, old = null;                                // old: the bytes of the chart the song has now, as they are stored
  /* A waiting box from the pick to the first question: reading a big PDF takes seconds, and the song must not be opened (or
     a second New version started) in that gap. It closes before any question is asked. */
  const job = busy('New version', 'Reading ' + file.name + '…');
  try{
    try{ r = await inspect(file); }catch(err){ toast('Could not read ' + file.name); return; }
    if(job.stopped) return;
    await ensureHashes().catch(() => {});
    const dup = state.songs.some(x => x.hash === r.hash);
    /* No stored PDF at all (nothing to keep) is different from one that is there but cannot be read right now (too little
       memory, a storage hiccup): the second must never be written over, so it stops here and nothing is changed. */
    try{ const f = await get('files', id); if(f) old = await f.arrayBuffer(); }
    catch(err){ toast('Could not read the current chart, so it cannot be kept. Nothing was changed.'); return; }
    if(job.stopped) return;
    job.close();
    if(dup && !(await askDuplicates([file.name]))){ toast('That PDF is already in your library. Nothing was changed.'); return; }
  } finally { job.close(); }
  if(!(await askNewVersion(file.name, s, !!old))) return;
  try{
    const {buf, pages:n, hash} = r, ops = [];
    let copy = null;
    if(old){
      copy = newSong({song:s.song, artist:s.artist, version:oldVersion(s.version)}, s.pages, await sha256(old), s.colls || []);
      copy.id = unique(new Set([...state.songs.map(x => x.id), ...state.sets.map(x => x.id)]));
      copy.archived = true;
      if(s.crop !== undefined) copy.crop = JSON.parse(JSON.stringify(s.crop));
      ops.push({store:'files', key:copy.id, value:new Blob([old], {type:'application/pdf'})}, {store:'songs', key:copy.id, value:copy});
    }
    ops.push({store:'files', key:id, value:new Blob([buf], {type:'application/pdf'})});
    for(let p = 1; p <= s.pages; p++){
      const key = id + ':' + p, cur = upgradeInk(await get('ink', key)).record.strokes, marks = cur.filter(x => !x.deleted);
      if(copy && marks.length) ops.push({store:'ink', key:copy.id + ':' + p, value:inkRecord(marks)});   // the old chart keeps its marks
      if(p > n) ops.push({store:'ink', key, delete:true});                                       // that page no longer exists
      else if(cur.length) ops.push({store:'ink', key, value:inkRecord(reconcile(cur, []))});     // keep deletion markers for the pages that remain
    }
    ops.push({store:'songs', key:id, value:{...s, pages:n, hash, title:displayName(s), updated:Date.now()}});
    /* load() makes new records: a different one here means the song was edited or deleted while the dialogs were open
       (do not bring it back). Checked last, with no wait between it and putAll, because the reads above take time. */
    const cur = await get('songs', id);          // the stored record too: another tab's edit or delete never reaches this tab's list
    if(songById(id) !== s || !cur || cur.deleted || cur.updated !== s.updated || cur.hash !== s.hash){ toast('That song changed in the meantime. Nothing was changed.'); return; }
    await putAll(ops);
    await load(); hooks.render();
    toast((copy ? 'New version in place. The old one is in Archived.' : 'New version in place. Its marks were cleared.') + (s.crop ? ' Crop kept. Use Reset in the crop screen if the layout changed.' : ''));
  }catch(err){ await load(); hooks.render(); toast(explainError(err)); }
}
/* The version an old copy gets: "old 2026-11-21", or "in G, old 2026-11-21" (the date here; the whole stays within the
   200 characters a text field takes, so share import, which refuses longer text, still takes it). */
function oldVersion(v){
  const d = new Date(), tag = `old ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const keep = String(v || '').slice(0, 200 - tag.length - 2).trim();
  return keep ? keep + ', ' + tag : tag;
}
/* The one question before New version writes anything. Resolves true for New version. */
function askNewVersion(name, s, keeps){
  return new Promise(res => {
    const m = modal(`<h2>New version</h2><p>Use <b>${esc(name)}</b> as the new version of <b>${esc(s.title)}</b>? ${keeps ? 'The current chart and its marks move to Archived.'
      : 'The current chart cannot be read on this tablet, so it cannot be kept: its marks are cleared.'}</p>
      <div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>New version</button></div>`);
    m.classList.add('nvask');
    m.querySelector('[data-x]').onclick = () => { m.remove(); res(false); };
    m.querySelector('[data-ok]').onclick = () => { m.remove(); res(true); };
  });
}

/* Returns true when the click was for the library. */
export async function onClick(b, d){
  if('add' in d){ $('#file').click(); return true; }
  if('split' in d){ $('#splitFile').click(); return true; }
  if('sharesongs' in d){ await shareSongs(); return true; }
  if('shareimport' in d){ $('#shareFile').click(); return true; }
  if('persist' in d){ await askPersist(b); return true; }
  if('problems' in d){ showProblemLog(); return true; }
  if(d.open){ openViewer([{type:'song', id:d.open}], 0); return true; }
  if(d.edit){
    const s = songById(d.edit);
    const r = await form('Edit song', [{key:'song', label:'Title', value:s.song}, {key:'artist', label:'Artist', value:s.artist}, {key:'version', label:'Version', value:s.version}],
      {label:'Collections', options:collOptions(s)});
    if(r && r.song){ s.song = r.song; s.artist = r.artist; s.version = r.version; s.colls = applyTicks(s, r.checks); await saveSong(s); await load(); hooks.render(); }
    return true;
  }
  if(d.copy){ await copySong(d.copy); return true; }
  if(d.archive || d.restoresong){
    const s = songById(d.archive || d.restoresong); s.archived = !!d.archive;
    await saveSong(s); await load(); hooks.render(); return true;
  }
  if(d.newversion){ newVersionOf = d.newversion; $('#newVersionFile').click(); return true; }    // nothing is lost: the confirm after the pick is the check
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

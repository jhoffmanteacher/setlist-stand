import {$, esc, toast, form, hooks, modal, busy, pdfPageCount} from './util.js';
import {putAll, get, load, state, songById, saveSong, newSong, sha256, ensureHashes} from './store.js';
import {parseFileName} from './importname.js';
import {compareSongs, songMatches, cutName} from './names.js';
import {stripHtml, fitStrip, STRIP_MIN} from './azstrip.js';
import {explainError, getProblems, showProblemLog} from './errors.js';
import {openViewer} from './viewer.js';
import {shareSongs} from './share.js';
import {menuBox} from './menubox.js';
import {newVersionOps} from './newversion.js';
import {deleteOps} from './deleteops.js';
import {renderDrive, driveSetUp, syncNow, openDriveBox} from './syncui.js';
import {backupNow} from './backup.js';
import {copySong} from './copysong.js';
import {renderNudge} from './nudge.js';
import {commit} from './saving.js';
import {showPicked, pickerHtml, shownColl, joinColls, inShown, collOptions, applyTicks} from './collections.js';

let q = '', showArchived = false, newVersionOf = null, nvRunning = false;
export const newVersionRunning = () => nvRunning;

/* Row 2 of the Library's top: one button for each menu. A new menu is one more button here and one more case in onClick(). */
function menusRowHtml(){
  return '<div class="bar" id="libMenus"><button data-sharemenu>Share / Import</button><button data-backupmenu>Back up / Sync</button></div>';
}
const SHARE_ITEMS = [
  {id: 'split', label: 'Split a songbook', hint: 'Cut one big PDF into separate songs'},
  {id: 'import', label: 'Import a share package', hint: 'Add songs from a file someone sent you'},
  {id: 'chartupdate', label: 'Import chart updates', hint: 'Replace charts with cleaned-up versions from one file'},
  {id: 'share', label: 'Share songs', hint: 'Pick songs, or send a setlist, as one file'},
];
/* Back up / Sync (Jonathan, 2026-11-22: these were at the bottom of the Library). The Sync hint depends on whether Drive has been used here. */
const backupItems = () => [
  {id: 'backup', label: 'Back up everything', hint: 'Save one file with every PDF, setlist and note'},
  {id: 'restore', label: 'Restore from backup', hint: 'Bring your library back from a backup file'},
  {id: 'sync', label: 'Sync with Google Drive', hint: driveSetUp() ? 'Keep your tablets the same' : 'Connect Google Drive first'},
  {id: 'drive', label: 'Google Drive settings', hint: 'Connect or disconnect'},
];

export function renderLibrary(v){
  v.innerHTML = `${pickerHtml()}<div class="bar"><input type="search" id="q" placeholder="Search songs" value="${esc(q)}" aria-label="Search songs"><button class="pri" data-add>Add PDFs</button></div>${menusRowHtml()}<div id="libNudge"></div><p id="libCount" class="hint libcount" aria-live="polite"></p><div class="libwrap" id="libWrap"><div id="libList"></div><div id="libStrip"></div></div>
    <label class="sw-row"><input type="checkbox" id="showArch" ${showArchived ? 'checked' : ''}>Show archived</label>
    <p class="hint" id="libBackupHint">A backup is one .zip file with every PDF, setlist and annotation. Save it to Google Drive to keep it safe or move it to another tablet.</p>
    <div id="libDriveLine"></div>
    <div id="libSafety"><p class="hint" id="libLastBackup"></p><div id="libStorage"></div><div id="libProblems"></div></div>`;
  $('#q').oninput = e => { q = e.target.value; renderLib(); };
  $('#showArch').onchange = e => { showArchived = e.target.checked; renderLib(); };
  renderLib();
  showPicked();
  renderSafety();
  renderDrive();
}
const matches = s => songMatches(s, q);
/* A row's one button (Jonathan, 2026-11-23): everything a song can do is in its menu (songItems), so the title gets the room. */
const moreBtn = s => `<button class="rowmore" data-songmenu="${esc(s.id)}" aria-label="Actions for ${esc(s.title)}" aria-haspopup="dialog">\u22ef</button>`;
const cut = t => t.length > 40 ? t.slice(0, 40) + '\u2026' : t;
const songItems = s => s.archived
  ? [{id: 'restore', label: 'Restore', hint: 'Bring it back into the Library'},
     {id: 'del', label: 'Delete', hint: 'Remove it, its PDF and its marks from this tablet'}]
  : [{id: 'edit', label: 'Edit', hint: 'Change the title, artist, version or collections'},
     {id: 'copy', label: 'Copy', hint: 'A second version of this chart, marked up another way'},
     {id: 'newversion', label: 'New version', hint: 'Use a new PDF; the old chart moves to Archived'},
     {id: 'archive', label: 'Archive', hint: 'Hide it from the Library; it still plays in setlists'},
     {id: 'del', label: 'Delete', hint: 'Remove it, its PDF and its marks from this tablet'}];
const pages = s => `${esc(s.pages)} page${s.pages == 1 ? '' : 's'}`;
function renderLib(){
  const sorted = state.songs.filter(inShown).sort(compareSongs);      // A to Z by song name, when the list is drawn (the same for Archived and search); only the collection being shown
  const live = sorted.filter(s => !s.archived), arch = sorted.filter(s => s.archived);
  const list = live.filter(matches), alist = arch.filter(matches), coll = shownColl();
  let html = coll && !live.length
    ? `<div class="empty"><h2>No songs in ${esc(coll.name)} yet</h2><p>Add songs from your library to this collection.</p><button class="pri" data-addcollsongs="${esc(coll.id)}">Add songs to ${esc(coll.name)}</button></div>`
    : live.length
    ? `<ul class="list">${list.map(s => { const id = esc(s.id); return `<li class="row"><button class="main" data-open="${id}"><span class="t">${esc(s.title)}</span><span class="s">${pages(s)}</span></button>${moreBtn(s)}</li>`; }).join('')}</ul>${list.length ? '' : '<p class="empty">No songs match.</p>'}`
    : `<div class="empty"><h2>No music yet</h2><p>Add PDF charts from your tablet's files or Drive. They're saved on this device.</p></div>`;
  if(showArchived){
    html += `<h2 style="margin-top:28px;font-size:26px">Archived</h2>` + (alist.length
      ? `<ul class="list">${alist.map(s => { const id = esc(s.id); return `<li class="row"><button class="main" data-open="${id}"><span class="t">${esc(s.title)}</span><span class="s">${pages(s)} · Archived</span></button>${moreBtn(s)}</li>`; }).join('')}</ul>`
      : `<p class="hint">${arch.length ? 'No archived songs match.' : 'Nothing archived.'}</p>`);
  }
  $('#libList').innerHTML = html;
  /* The song count and the A to Z strip (js/azstrip.js). The count is of live songs only: "74 songs", and "3 of 74 songs" when a search or
     a collection shows fewer. Both are left out when there are no songs to show. The strip is for a long list, and not while searching. */
  const total = state.songs.filter(s => !s.archived).length;
  $('#libCount').textContent = !live.length || !total ? '' : list.length === total ? plural(total, 'song') : `${list.length} of ${plural(total, 'song')}`;
  const strip = !q.trim() && list.length >= STRIP_MIN;
  $('#libStrip').innerHTML = strip ? stripHtml(list) : '';
  $('#libWrap').classList.toggle('hasaz', strip);
  if(strip) fitStrip();
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

/* (The records it writes are built by newVersionOps() in js/newversion.js, which Import chart updates uses too.)
   New version (it took the place of Replace PDF, which threw the old chart and its marks away): the file picked becomes the
   song's chart, and the chart it had is kept as an archived song, so nothing is lost.
   - The song keeps its id, details and setlist places (its crop is cleared: the new chart starts uncropped, the old copy keeps the crop), so every setlist plays the new chart and no setlist is written.
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
    const {ops, copy} = await newVersionOps(s, r.buf, {pages:r.pages, hash:r.hash}, old);
    /* load() makes new records: a different one here means the song was edited or deleted while the dialogs were open
       (do not bring it back). Checked last, with no wait between it and putAll, because the reads above take time. */
    const cur = await get('songs', id);          // the stored record too: another tab's edit or delete never reaches this tab's list
    if(songById(id) !== s || !cur || cur.deleted || cur.updated !== s.updated || cur.hash !== s.hash){ toast('That song changed in the meantime. Nothing was changed.'); return; }
    await putAll(ops);
    await load(); hooks.render();
    toast((copy ? 'New version in place. The old one is in Archived.' : 'New version in place. Its marks were cleared.') + (s.crop ? ' Its crop was cleared.' : ''));
  }catch(err){ await load(); hooks.render(); toast(explainError(err)); }
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

async function editSong(id){
  const s = songById(id); if(!s) return;
  const r = await form('Edit song', [{key:'song', label:'Title', value:s.song}, {key:'artist', label:'Artist', value:s.artist}, {key:'version', label:'Version', value:s.version}],
    {label:'Collections', options:collOptions(s)});
  if(r && r.song) await commit(() => saveSong({...s, song:cutName(r.song), artist:cutName(r.artist), version:cutName(r.version), colls:applyTicks(s, r.checks)}), 'Could not save the song. Nothing was changed.');
}
async function setArchived(id, on){
  const s = songById(id); if(!s) return;
  await commit(() => saveSong({...s, archived:on}), 'Could not save that. Nothing was changed.');
}
/* Delete is the menu item and then this question (the two taps the "Never" list asks for). Cancel changes nothing. */
function askDelete(s){
  return new Promise(res => {
    const m = modal(`<h2>Delete ${esc(cut(s.title))}?</h2><p>Its PDF and its marks are removed from this tablet, and it leaves every setlist it is in.</p>
      <div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Delete</button></div>`);
    m.classList.add('delask');
    const ok = m.querySelector('[data-ok]'); ok.disabled = true; setTimeout(() => { ok.disabled = false; }, 400);      // a quick double tap on the menu's Delete must not land on this one
    m.querySelector('[data-x]').onclick = () => { m.remove(); res(false); };
    m.querySelector('[data-ok]').onclick = () => { m.remove(); res(true); };
  });
}
async function deleteSong(id){
  const s = songById(id); if(!s || !(await askDelete(s))) return;
  /* One transaction: the PDF and ink go, the song becomes a deletion marker and the setlists that had it are updated (js/deleteops.js,
     shared with sync's "Delete here"; each record gets a time later than its own last one, so the deletion beats what it was made from). */
  try{ await putAll(await deleteOps('song', id)); }       // a read that fails is said plainly too, and nothing is written
  catch(err){ toast(explainError(err)); }
  await load(); hooks.render();
}

/* Returns true when the click was for the library. */
export async function onClick(b, d){
  if('add' in d){ $('#file').click(); return true; }
  if('sharemenu' in d){
    b.focus();                                                  // Safari does not focus a button that was tapped: the box and the dialogs after it give focus back to it
    await menuBox({title: 'Share / Import', items: SHARE_ITEMS, opener: b, run: name => {
      if(name === 'split') $('#splitFile').click();             // runs inside the tap that chose it: a file chooser needs that
      else if(name === 'import') $('#shareFile').click();
      else if(name === 'chartupdate') $('#chartUpdateFile').click();
      else return shareSongs();
    }});
    return true;
  }
  if('backupmenu' in d){
    b.focus();
    await menuBox({title: 'Back up / Sync', items: backupItems(), opener: b, run: name => {
      if(name === 'restore') $('#restoreFile').click();         // inside the tap that chose it: a file chooser needs that
      else if(name === 'backup') return backupNow(b);           // the same backup as the reminder's Back up now; this button says "Working…" meanwhile
      else if(name === 'sync') return syncNow();                // what the old Sync button did: sync, or the sign-in dialog first
      else openDriveBox();
    }});
    return true;
  }
  if('az' in d) return true;                                     // the A to Z strip does its own jumping (js/azstrip.js)
  if('persist' in d){ await askPersist(b); return true; }
  if('problems' in d){ showProblemLog(); return true; }
  if(d.open){ openViewer([{type:'song', id:d.open}], 0); return true; }
  if(d.songmenu){
    const id = d.songmenu, s = songById(id); if(!s) return true;
    b.focus();                                                  // Safari does not focus a button that was tapped: the box and the dialogs after it give focus back to it
    await menuBox({title: cut(s.title), items: songItems(s), opener: b, run: act => {
      if(act === 'edit') return editSong(id);
      if(act === 'copy') return copySong(id);
      if(act === 'newversion'){ newVersionOf = id; $('#newVersionFile').click(); return; }    // inside the tap that chose it: a file chooser needs that. Nothing is lost: the confirm after the pick is the check
      if(act === 'archive' || act === 'restore') return setArchived(id, act === 'archive');
      if(act === 'del') return deleteSong(id);
    }});
    /* The list is drawn again after most of these: the button that opened the menu may be gone (a deleted song's row). */
    if(!document.querySelector('.modal') && (!document.activeElement || document.activeElement === document.body)){
      const mb = document.querySelector(`#libList [data-songmenu="${CSS.escape(id)}"]`) || $('[data-add]'); if(mb) mb.focus();
    }
    return true;
  }
  return false;
}

/* ---------- data safety: storage status, problem log (the backup reminder is js/nudge.js) ----------
   All of it is read on the device. Every browser API is guarded: if one is missing, that line is simply left out. */
function renderSafety(){
  if(!$('#libLastBackup')) return;
  renderNudge();                       // the backup reminder (js/nudge.js): shown after changes since the last backup
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

/* Split a songbook: one big PDF becomes separate songs. The screen lists the songs (a first guess from the PDF's
   bookmarks, then edited by hand or by tapping the first page of each song), shows the book's pages as small pictures,
   and then saves every ticked song as its own PDF. The songbook itself is never saved or changed; only the songs are. */
import {$, esc, toast, modal, busy, armed, hooks} from './util.js';
import {state, putAll, load, sha256, newSong, ensureHashes} from './store.js';
import {parseTypedTitle} from './importname.js';
import {explainError} from './errors.js';
import {joinColls} from './collections.js';
import {readBookmarks, draftRows, sortRows, newRow, endOf, clampPage} from './songlist.js';
import {makeSongPdf, usesLayerRules, budgetFor} from './songpdf.js';

const THUMB_PX = 320, THUMB_Q = .72;      // page pictures: width in pixels, JPEG quality (about 20 KB each)
const plural = (n, w) => `${n} ${w}${n == 1 ? '' : 's'}`;
let S = null;       // the open songbook: {name, n, doc, lib, rows, urls, queue, dirty, ...}; null when the screen is closed

/* ---------- dialogs ---------- */
/* The waiting dialog with a Stop button is busy() in js/util.js, shared with Restore and Back up. */
function notice(title, text){
  const m = modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="btns"><button class="pri" data-x>OK</button></div>`);
  m.querySelector('[data-x]').onclick = () => m.remove();
}
const WHY = {
  password:"This PDF needs a password to open, so it can't be cut into songs.",
  protected:"This PDF is protected (whoever made it set restrictions), so it can't be cut into songs. You can still add the whole book with Add PDFs.",
  cut:"This PDF opens, but it is built in a way that can't be cut into songs here. You can still add the whole book with Add PDFs.",
  layers:"This PDF hides some of its layers, and a song cut from it would show them, so it can't be cut into songs here. You can still add the whole book with Add PDFs.",
  broken:"This PDF could not be read, so it can't be cut into songs.",
};

/* ---------- opening a songbook ---------- */
/* True when the book hides some layers by default (BaseState OFF or an OFF list), asked of pdf.js, which is what shows the
   pages. A song cut from it would not carry the layer settings, so the hidden layers would appear: such a book is refused. */
async function hidesLayers(doc){
  try{ const g = (await doc.getOptionalContentConfig()).getGroups(); return !!g && Object.values(g).some(x => x && x.visible === false); }
  catch(e){ return false; }
}
/* pdf.js (the page pictures) and pdf-lib (the cut) must agree on which object is page k, or a song would be cut from other
   pages than the ones shown (a damaged page tree can make them differ). */
async function samePages(doc, lib, job){
  if(doc.numPages !== lib.getPageCount()) return false;
  for(let i = 1; i <= doc.numPages; i++){
    if(job.stopped) return true;
    const p = await doc.getPage(i), same = !!p.ref && p.ref.num === lib.getPage(i - 1).ref.objectNumber;
    p.cleanup();
    if(!same) return false;
  }
  return true;
}
/* {doc (pdf.js, for the pictures and bookmarks), lib (pdf-lib, for cutting), n, rows}, or {why}, or null when stopped. */
async function openBook(file, job){
  const buf = await file.arrayBuffer();
  if(job.stopped) return null;
  let doc, lib;
  try{ doc = await pdfjsLib.getDocument({data:new Uint8Array(buf.slice(0))}).promise; }   // pdf.js takes the bytes it is given
  catch(e){ return {why:e && e.name === 'PasswordException' ? 'password' : 'broken'}; }
  try{
    /* ignoreEncryption only lets the check run: a protected file is never cut (pdf-lib cannot decode it and would write blank pages) */
    try{ lib = await PDFLib.PDFDocument.load(buf, {ignoreEncryption:true, updateMetadata:false}); }
    catch(e){ doc.destroy(); return {why:'cut'}; }
    if(lib.isEncrypted){ doc.destroy(); return {why:'protected'}; }
    if(await hidesLayers(doc) || usesLayerRules(lib)){ doc.destroy(); return {why:'layers'}; }
    const n = doc.numPages;
    if(n < 1){ doc.destroy(); return {why:'broken'}; }
    job.say('Checking the pages…');
    if(!(await samePages(doc, lib, job))){ doc.destroy(); return {why:'cut'}; }
    if(job.stopped){ doc.destroy(); return null; }
    job.say('Looking for bookmarks…');
    const marks = await readBookmarks(doc, n);
    if(job.stopped){ doc.destroy(); return null; }
    return {doc, lib, n, bookBytes:file.size, rows:draftRows(marks), marks:marks.length};
  }catch(e){ try{ doc.destroy(); }catch(e2){} throw e; }
}

export async function startSplit(file){
  if(!file || S) return;
  const job = busy('Reading the songbook', `Opening ${file.name}…`);
  let book;
  try{ book = await openBook(file, job); }
  catch(err){ job.close(); toast(explainError(err, `Could not read ${file.name}.`)); return; }
  job.close();
  if(!book) return;
  if(book.why){ notice("Can't split this PDF", WHY[book.why]); return; }
  S = {name:file.name.replace(/\.pdf$/i, ''), ...book, urls:[], queue:[], dirty:false, pumping:false};
  $('#splitTitle').textContent = S.name;
  $('#splitSub').textContent = plural(S.n, 'page');
  $('#splitHint').textContent = S.marks
    ? `Found ${plural(S.marks, 'bookmark')}. Untick what is not a song, fix titles and page numbers, or tap a page to add a song that starts there.`
    : 'This PDF has no bookmarks. Tap the first page of each song in the pages next to this list.';
  $('#splitArtist').value = ''; $('#splitAgain').checked = false;
  $('#splitBig').setAttribute('aria-pressed', 'false'); $('#splitPages').classList.remove('big');
  $('#splitter').hidden = false; $('.app').inert = true; document.body.classList.add('splitting');
  const mine = S;
  renderRows(); await buildPages();
  if(S !== mine) return;                 // Escape closed the screen while the pages were being laid out
  refreshPages(); refreshGo();
  $('#splitTitle').focus();
}

function closeSplit(){
  const mine = S; if(!mine) return;
  S = null;
  if(mine.obs) mine.obs.disconnect();
  for(const u of mine.urls) URL.revokeObjectURL(u);
  if(mine.cv) mine.cv.width = mine.cv.height = 0;
  try{ mine.doc.destroy(); }catch(e){}
  $('#splitRows').innerHTML = ''; $('#splitPages').innerHTML = '';
  $('#splitter').hidden = true; $('.app').inert = false; document.body.classList.remove('splitting');
  const b = $('[data-sharemenu]'); if(b) b.focus();
}

/* ---------- the list of songs ---------- */
function renderRows(focus){
  const rows = S.rows;
  $('#splitRows').innerHTML = rows.map((r, i) => {
    const id = esc(r.id), end = endOf(rows, i, S.n);
    return `<li class="srow${r.on ? '' : ' off'}" data-id="${id}" tabindex="-1"><label class="chk"><input type="checkbox" data-k="on"${r.on ? ' checked' : ''} aria-label="Add this song"></label>
      <input type="text" maxlength="200" data-k="title" value="${esc(r.title)}" placeholder="Song title" aria-label="Song title">
      <span class="pgs">Pages <input type="number" inputmode="numeric" min="1" max="${S.n}" data-k="from" value="${r.from}" aria-label="First page"> to <input type="number" inputmode="numeric" min="1" max="${S.n}" data-k="to" value="${end}" data-shown="${end}"${r.to == null ? ' class="auto"' : ''} aria-label="Last page"></span>
      <button data-rm>Remove</button></li>`;
  }).join('');
  if(focus) focusRow(focus.id, focus.k);
}
function focusRow(id, k = 'title'){
  const li = [...$('#splitRows').children].find(x => x.dataset.id === id), el = li && li.querySelector(`[data-k="${k}"]`);
  if(el){ el.focus(); el.scrollIntoView({block:'nearest'}); }
}
/* After an edit: put rows back in page order (re-drawing only if the order changed), update the "to" boxes that follow the
   next row, the pictures and the Add button. Focus stays on the box it was in. */
function afterEdit(){
  if(!S) return;
  const sorted = sortRows(S.rows), moved = sorted.some((r, i) => r !== S.rows[i]);
  S.rows = sorted; S.dirty = true;
  if(moved){
    const a = document.activeElement, li = a && a.closest && a.closest('.srow');
    renderRows(li ? {id:li.dataset.id, k:a.dataset.k} : null);
  } else [...$('#splitRows').children].forEach((li, i) => {
    const to = li.querySelector('[data-k="to"]'), r = S.rows[i];
    const v = String(endOf(S.rows, i, S.n));
    /* a box with the cursor in it is left alone only while its text is not what the app last wrote (someone is typing) */
    if(to !== document.activeElement || to.value === to.dataset.shown){ to.value = v; to.dataset.shown = v; }
    to.classList.toggle('auto', r.to == null);
  });
  refreshPages(); refreshGo();
}
function refreshGo(){
  const k = S.rows.filter(r => r.on).length, go = $('#splitGo');
  go.textContent = k ? `Add ${plural(k, 'song')}` : 'Add songs'; go.disabled = !k;
}
/* After rows were added or removed: draw the list again from the data. */
function redraw(focus){
  S.dirty = true;
  renderRows(focus); refreshPages(); refreshGo();
}

/* ---------- the pages ---------- */
async function buildPages(){
  const mine = S, grid = $('#splitPages');
  try{ const v = (await mine.doc.getPage(1)).getViewport({scale:1}); grid.style.setProperty('--ar', (v.width / v.height).toFixed(4)); }catch(e){}
  if(S !== mine) return;                 // Escape closed the screen while the first page was read
  grid.innerHTML = Array.from({length:S.n}, (_, i) => `<button class="pg" data-p="${i + 1}" aria-label="Page ${i + 1}"><span class="th"><img alt="" hidden></span><span class="pn">${i + 1}</span><span class="nm"></span></button>`).join('');
  /* A picture is drawn only when its page scrolls into view, one at a time. */
  S.obs = new IntersectionObserver(es => {
    for(const e of es) if(e.isIntersecting){ S.obs.unobserve(e.target); S.queue.push(+e.target.dataset.p); }
    pump();
  }, {root:grid, rootMargin:'300px'});
  for(const c of grid.children) S.obs.observe(c);
}
async function pump(){
  const mine = S;
  if(!mine || mine.pumping) return;
  mine.pumping = true;
  while(mine === S && mine.queue.length){
    try{ await thumb(mine, mine.queue.shift()); }catch(e){}
  }
  mine.pumping = false;
}
/* Page pn as a small JPEG in its cell. One canvas is reused and emptied at the end; the pictures cost about 20 KB each. */
async function thumb(mine, pn){
  const page = await mine.doc.getPage(pn);
  try{
    const v1 = page.getViewport({scale:1}), vp = page.getViewport({scale:THUMB_PX / v1.width});
    const cv = mine.cv || (mine.cv = document.createElement('canvas'));
    cv.width = Math.max(1, Math.round(vp.width)); cv.height = Math.max(1, Math.round(vp.height));
    const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
    await page.render({canvasContext:c, viewport:vp}).promise;
    const jpg = await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('no picture')), 'image/jpeg', THUMB_Q));
    if(mine !== S) return;
    const url = URL.createObjectURL(jpg); mine.urls.push(url);
    const img = $('#splitPages').children[pn - 1].querySelector('img'); img.src = url; img.hidden = false;
  } finally { page.cleanup(); }
}
/* Marks the pages: where a ticked song starts, and the pages inside ticked songs. */
function refreshPages(){
  const n = S.n, start = new Map(), more = new Map(), inside = new Uint8Array(n + 2);
  S.rows.forEach((r, i) => {
    if(!r.on) return;
    if(!start.has(r.from)) start.set(r.from, r); else more.set(r.from, (more.get(r.from) || 0) + 1);     // two songs can start on one page
    for(let p = r.from, e = endOf(S.rows, i, n); p <= e; p++) inside[p] = 1;
  });
  const cells = $('#splitPages').children;
  for(let p = 1; p <= n; p++){
    const c = cells[p - 1], r = start.get(p);
    const cls = 'pg' + (r ? ' start' : inside[p] ? ' in' : '');
    if(c.className !== cls) c.className = cls;
    const extra = more.get(p) ? ` +${more.get(p)} more` : '';
    const label = r ? `Page ${p}, a song starts here: ${r.title.trim() || 'no title yet'}${extra}` : inside[p] ? `Page ${p}, inside a song` : `Page ${p}`;
    if(c.getAttribute('aria-label') !== label) c.setAttribute('aria-label', label);
    const nm = c.lastElementChild, t = r ? (r.title.trim() || '…') + extra : '';
    if(nm.textContent !== t) nm.textContent = t;
  }
}

/* ---------- adding the songs ---------- */
async function addSongs(){
  const mine = S, rows = mine.rows;
  if(mine.adding) return;
  const ticked = rows.map((r, i) => ({r, end:endOf(rows, i, mine.n)})).filter(x => x.r.on);
  if(!ticked.length) return;
  const blank = ticked.find(x => !x.r.title.trim());
  if(blank){ toast('Give every song a title first'); focusRow(blank.r.id); return; }
  const again = $('#splitAgain').checked, artist = $('#splitArtist').value.trim();
  mine.adding = true;
  const job = busy('Adding songs', 'Preparing…');       // opened before the first await: Escape and Stop reach this dialog, not the screen behind
  await ensureHashes().catch(() => {});
  const known = new Set(state.songs.map(s => s.hash).filter(Boolean));     // a song whose PDF is already here is skipped, unless "add again" is ticked
  let ok = 0, skipped = 0, failure = null, written = 0;
  const budget = budgetFor(mine.bookBytes), finished = [], uncut = [];        // rows added or skipped (unticked afterwards if the run is not clean); titles that could not be cut
  for(const [k, {r, end}] of ticked.entries()){
    if(job.stopped) break;
    const title = r.title.trim();
    job.say(`Song ${k + 1} of ${ticked.length}: ${title}`);
    await new Promise(res => setTimeout(res, 0));       // let the dialog repaint, and Stop be heard, between songs
    try{
      const {bytes, pages} = await makeSongPdf(mine.lib, r.from, end, budget - written);
      const hash = await sha256(bytes);
      /* Compared with the library as it was before this run: two songs on one page are the same bytes and both belong. */
      if(again || !known.has(hash)){
        const name = parseTypedTitle(title); if(!name.artist && artist) name.artist = artist;
        const s = newSong(name, pages, hash, joinColls());
        /* the PDF and its song in ONE transaction, so a full tablet never leaves half a song behind */
        await putAll([{store:'files', key:s.id, value:new Blob([bytes], {type:'application/pdf'})}, {store:'songs', key:s.id, value:s}]);
        written += bytes.length;          // only what was written counts against the run's space budget
        ok++;
      } else skipped++;
      finished.push(r);
    }catch(err){
      if(err && err.cut){ uncut.push(title); continue; }      // this song cannot be cut cleanly: the others still can
      failure = err; break;
    }
  }
  job.close();
  try{ await load(); hooks.render(); }catch(err){ failure = failure || err; }       // a database error here is reported like any other
  const left = ticked.length - finished.length, said = [ok && `Added ${plural(ok, 'song')}`, skipped && `Skipped ${skipped} already in your library`].filter(Boolean);
  if(!failure && !uncut.length && left === 0){
    toast(said.join('. ') + '.');
    closeSplit();
    return;
  }
  /* Stopped, one song could not be cut, or something went wrong: the screen stays, the songs not added still ticked, so
     nothing marked is lost. */
  for(const r of finished) r.on = false;
  redraw(); mine.adding = false;
  if(!failure && !uncut.length){ toast([...said, `Stopped: ${plural(left, 'song')} not added, still ticked`].join('. ') + '.'); return; }
  const parts = [...said];
  if(uncut.length) parts.push(`${plural(uncut.length, 'song')} could not be cut cleanly out of this book: ${uncut.slice(0, 5).map(t => `"${t}"`).join(', ')}${uncut.length > 5 ? ` and ${uncut.length - 5} more` : ''}`);
  const rest = left - uncut.length;
  if(failure) parts.push(explainError(failure, failure.space ? 'The songs cut from this book would take far more space than the book itself (each carries a copy of something big that the whole book shares), so adding stopped' : 'Something went wrong.').replace(' Nothing was changed.', ''), rest > 0 ? `${plural(rest, 'song')} not added` : 'Close and reopen the app to see the songs');
  if(job.stopped) parts.push('Stopped before the rest');
  if(failure ? rest > 0 : true) parts.push(failure ? (failure.space ? 'The songs not added are still ticked' : 'The songs not added are still ticked: fix the problem and tap Add again') : 'They are still ticked: untick them, or change their pages, and tap Add again');
  notice('Not all songs were added', parts.map(x => x.replace(/\.$/, '')).join('. ') + '.');
}

/* ---------- wiring (once) ---------- */
export function initSplit(){
  $('#splitCancel').onclick = e => {
    if(S && S.dirty && !armed(e.currentTarget, 'Discard? Tap again')) return;
    closeSplit();
  };
  $('#splitGo').onclick = () => { if(S) addSongs(); };
  $('#splitAll').onclick = () => setAll(true);
  $('#splitNone').onclick = () => setAll(false);
  $('#splitArtist').oninput = () => { if(S) S.dirty = true; };
  $('#splitBig').onclick = e => {
    const big = $('#splitPages').classList.toggle('big');
    e.currentTarget.setAttribute('aria-pressed', String(big));
  };
  addEventListener('keydown', e => {
    if(S && e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.modal')) $('#splitCancel').click();
  });

  const rowsEl = $('#splitRows');
  const rowOf = el => { const li = el.closest('.srow'); return li ? S.rows.find(r => r.id === li.dataset.id) : null; };
  rowsEl.addEventListener('input', e => {
    const r = S && e.target.dataset.k === 'title' ? rowOf(e.target) : null;
    if(r){ r.title = e.target.value; S.dirty = true; refreshPages(); }
  });
  rowsEl.addEventListener('change', e => {
    const r = S && rowOf(e.target), k = e.target.dataset.k;
    if(!r) return;
    if(k === 'on'){ r.on = e.target.checked; e.target.closest('.srow').classList.toggle('off', !r.on); }
    else if(k === 'from'){
      r.from = clampPage(e.target.value, S.n, r.from);
      if(r.to != null && r.to < r.from) r.to = r.from;
      e.target.value = r.from;
    }
    else if(k === 'to'){
      r.to = e.target.value.trim() === '' ? null : Math.max(r.from, clampPage(e.target.value, S.n, r.to == null ? r.from : r.to));
      e.target.classList.toggle('auto', r.to == null);
      e.target.dataset.shown = e.target.value = endOf(S.rows, S.rows.indexOf(r), S.n);
    }
    else return;
    S.dirty = true;
    setTimeout(afterEdit, 0);            // after the Tab that caused this change has moved focus
  });
  rowsEl.addEventListener('click', e => {
    const b = e.target.closest('[data-rm]'), r = S && b && rowOf(b);
    if(!r) return;
    const li = b.closest('.srow'), next = li.nextElementSibling || li.previousElementSibling;
    S.rows = S.rows.filter(x => x !== r);
    redraw();
    if(next) focusRow(next.dataset.id, 'on');
  });
  /* Tap a page: a song starts here. A page where a song already starts takes you to that song's row. */
  $('#splitPages').addEventListener('click', e => {
    const c = S && e.target.closest('.pg'); if(!c) return;
    const p = +c.dataset.p;
    let r = S.rows.find(x => x.from === p);
    if(r){
      r.on = true; redraw();
      const li = [...$('#splitRows').children].find(x => x.dataset.id === r.id);
      li.scrollIntoView({block:'center'}); li.focus({preventScroll:true});     // no keyboard pops up for a song that already has a title
    } else {
      r = newRow(p); S.rows = sortRows([...S.rows, r]);
      redraw({id:r.id, k:'title'});                                            // a new song needs its title
    }
  });
}
function setAll(on){
  if(!S) return;
  for(const r of S.rows) r.on = on;
  redraw();
}

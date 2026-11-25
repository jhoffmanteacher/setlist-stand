import {$, toast, hooks} from './util.js';
import {get, getInkPages, songById, cropOf} from './store.js';
import {openCropper} from './crop.js';
import {awakeOpen, awakeClose, initAwake} from './awake.js';
import {PageCache, release} from './pagecache.js';
import {configure as configureReady, kick as kickReady, touch as touchReady, stopReady, snapKey, snapOf, snapCanvas, readyOff} from './prerender.js';
import {initBackNav} from './backnav.js';
import {paint, setAnnot, widthMenu, inkBusy, inkReset, inkPointerDown, inkPointerMove, inkPointerUp, inkPointerCancel} from './ink.js';
import {jumpList} from './songjump.js';

export const stage = $('#stage'), viewer = $('#viewer');
/* cache: rendered pages (js/pagecache.js). prep: queue index -> {id, p: Promise of an open pdf.js document} for the songs
   next to the one showing, kept open so a turn into them has nothing to open (see "Songs next to this one" below).
   bad: the song showing is a chart that could not be opened (missing, damaged): a placeholder page stands in for it.
   hist: the Undo steps of the song showing (js/ink.js), emptied whenever the song changes. */
export const V = {queue:[], qi:0, brk:null, bad:false, page:1, n:0, doc:null, id:null, song:null, per:1, two:true, annot:false, finger:false,
  tool:'pen', color:'#1a1a1a', tok:0, dt:0, busy:false, cache:new PageCache(), prep:new Map(), ink:new Map(), hist:[]};
try{ V.two = localStorage.getItem('ss-two') !== '0'; }catch(e){}

/* The back gesture (one history entry per layer, back means Escape) is js/backnav.js. */

/* entries: [{type:'song', id} | {type:'break', id, name}] */
export async function openViewer(entries, qi, page = 1){
  if(!entries.some(e => e.type === 'song')) return;
  stopReady();                                // pages kept for an earlier queue go
  prune([]); V.queue = entries; V.hist = [];
  jumpable(entries.length > 1);
  viewer.classList.add('on'); viewer.classList.remove('hide');
  document.body.style.overflow = 'hidden';
  document.body.classList.add('playing');      // hides the "Updated. Tap to reload" banner: a stray tap mid-song must not reload the app
  awakeOpen();
  await show(qi, page);
}
/* Where the viewer is, for putting it back after the page reloads. null when it is closed. */
export function resumeState(){
  return viewer.classList.contains('on') && V.queue.length ? {queue:V.queue, qi:V.qi, page:V.brk ? 1 : V.page} : null;
}
export function closeViewer(){
  inkReset();                 // a gesture still open (no pen-up arrived) saves to its own song and page now
  setAnnot(false);
  viewer.classList.remove('on');
  V.tok++; V.dt++; V.brk = null; V.bad = false; V.hist = []; gest = null;
  if(V.doc){ V.doc.destroy(); V.doc = null; }
  prune([]);                                  // songs prepared for a turn that never came: closed, their pages released
  stopReady();                                // the pages drawn ahead for the setlist (js/prerender.js) go too
  V.cache.clear(); setStage();
  document.body.style.overflow = '';
  document.body.classList.remove('playing');
  awakeClose();
  if(fsElement()) exitFs();
  hooks.render();
}
/* Full screen, with the webkit-prefixed names where the plain ones are missing (iPadOS 16.0 to 16.3). */
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
function exitFs(){
  const f = document.exitFullscreen || document.webkitExitFullscreen;
  try{ const p = f && f.call(document); if(p && p.catch) p.catch(() => {}); }catch(e){}
}
function enterFs(){
  const root = document.documentElement, f = root.requestFullscreen || root.webkitRequestFullscreen, no = () => toast('Full screen is not available here');
  if(!f){ no(); return; }
  /* the prefixed call returns nothing and says a refusal by an event */
  if(!root.requestFullscreen){
    document.addEventListener('webkitfullscreenerror', no, {once:true});
    document.addEventListener('webkitfullscreenchange', () => document.removeEventListener('webkitfullscreenerror', no), {once:true});
  }
  let p; try{ p = f.call(root); }catch(e){ no(); return; }
  if(p && p.catch) p.catch(no);
}
const show = (qi, page) => V.queue[qi].type === 'break' ? showBreak(qi) : loadSong(qi, page);
async function showBreak(qi){
  V.tok++; setAnnot(false);
  retire(qi);                                 // the song just left stays open: Back from the break is instant
  V.brk = V.queue[qi]; V.qi = qi; V.song = null; V.id = null; V.page = 1; V.n = 1; V.bad = false; V.hist = [];
  prune(around(qi));
  await draw();
}
/* The PDF of queue entry qi opened: the one prepared for it (taken out of the prepared set), or a new one. Resolves to
   null when the file is missing. */
function takeDoc(qi, id){
  const e = V.prep.get(qi);
  if(e){ V.prep.delete(qi); if(e.id === id) return e.p; dropDoc(e); }
  return openDoc(id);
}
async function openDoc(id){
  const blob = await get('files', id);
  if(!blob) return null;
  const task = pdfjsLib.getDocument({data:new Uint8Array(await blob.arrayBuffer())});
  try{ return await task.promise; }
  catch(err){ try{ task.destroy(); }catch(e){} throw err; }     // a PDF that will not open: its pdf.js worker is closed too, not left running
}
/* A chart that cannot be shown (no stored PDF, a PDF that will not open, its marks unreadable) becomes ONE placeholder page
   that says so: the song counts as shown, so Next and Previous move on past it either way, and nothing can be drawn on
   it (an empty marks map saved over its page would lose the real marks). */
async function loadSong(qi, page){
  const tok = ++V.tok; const id = V.queue[qi].id;
  let doc = null, ink = null;
  try{
    doc = await takeDoc(qi, id);
    if(doc) ink = await getInkPages(id, doc.numPages);     // one read for every page, not one awaited read per page
  }catch(err){
    if(doc) dropDoc({p:Promise.resolve(doc)});           // opened but never shown (the marks read failed): close it, or its worker and bytes leak
    doc = null;
  }
  if(tok !== V.tok){ if(doc) dropDoc({p:Promise.resolve(doc)}); return; }
  retire(qi);
  if(!doc){
    setAnnot(false);
    Object.assign(V, {doc:null, id, qi, n:1, page:1, song:songById(id), ink:new Map(), brk:null, bad:true, hist:[]});
    prune(around(qi));
    await draw();
    return;
  }
  Object.assign(V, {doc, id, qi, n:doc.numPages, song:songById(id), ink, brk:null, bad:false, hist:[]});
  /* From here until draw() puts the new pages up, the stage still shows the song just left; its canvases carry the
     old song's marks map (ink._ink), so js/ink.js ignores a pen-down or Clear on them (they would land on THIS song). */
  V.page = 1; calcPer();
  V.page = page === 'last' ? lastStart() : Math.min(Math.max(1, +page || 1), V.n);
  if(V.per === 2 && V.page % 2 === 0) V.page--;
  prune(around(qi));
  await draw();
}
const perFor = n => (V.two && innerWidth > innerHeight * 1.1 && n > 1) ? 2 : 1;
function calcPer(){
  V.per = perFor(V.n);
  if(V.per === 2 && V.page % 2 === 0) V.page--;
}
const lastStartFor = (n, per) => per === 2 ? (n % 2 ? n : n - 1) : n;
const lastStart = () => lastStartFor(V.n, V.per);

/* ---------- Songs next to this one ----------
   Opening a song is what makes a turn into it slow (pdf.js opens the PDF: most of the time on a tablet), so the songs on
   either side of the one showing (skipping breaks) are opened ahead and kept in V.prep, and the spread a turn would
   land on is drawn into the cache: the first spread of the next song, the last of the previous one. This starts one
   spread early: the next song from the spread before the last (and on the last), the previous song on the first two
   spreads, and on a break page. One spread early because a chart that is a big photo (one ~3000x2400 JPEG a page) takes
   about four times as long to draw as a text page (measured, tools/page-turn-timing.mjs --photo / --library: about
   1 s for one page, 1.2 s for a two-page spread, Chromium at 4x CPU, against 0.25 s), and a person who turns to the
   last page and straight on found it still drawing. The same pages are readied, only sooner: at most one spread more
   is held at a time (on the spread before the last: its two neighbours and the next song's first spread), inside the
   10 pages the js/pagecache.js comment budgets. The song just left is kept open too, for the turn back. Whatever is
   not next to the song showing is closed, its pages dropped from the cache. */
const nextSong = qi => { for(let i = qi + 1; i < V.queue.length; i++) if(V.queue[i].type === 'song') return i; return -1; };
const prevSong = qi => { for(let i = qi - 1; i >= 0; i--) if(V.queue[i].type === 'song') return i; return -1; };
const around = qi => [prevSong(qi), nextSong(qi)];
const dropDoc = e => e.p.then(d => { if(d){ V.cache.dropPrefix(tagOf(d) + ':'); d.destroy(); } }, () => {});
function prune(keep){
  for(const [qi, e] of [...V.prep]) if(!keep.includes(qi)){ V.prep.delete(qi); dropDoc(e); }
}
/* The song on screen is about to be replaced (by qi): its document goes to the prepared set, and prune() decides whether it stays. */
function retire(toQi){
  const doc = V.doc; if(!doc) return;
  V.doc = null;
  const old = V.prep.get(V.qi); if(old) dropDoc(old);
  if(V.id && V.queue[V.qi] && V.qi !== toQi) V.prep.set(V.qi, {id:V.id, p:Promise.resolve(doc)}); else dropDoc({p:Promise.resolve(doc)});
}
/* Gets queue entry qi ready: its PDF open and the spread a turn lands on ('first' going forward, 'last' going back) drawn. */
function prepare(qi, which){
  const e = V.queue[qi]; if(qi < 0 || !e || e.type !== 'song' || qi === V.qi) return;
  let ent = V.prep.get(qi);
  if(!ent){ ent = {id:e.id, p:openDoc(e.id)}; V.prep.set(qi, ent); }   // a PDF that will not open stays a rejection: the turn into it says so
  ent.p.then(doc => {
    if(!doc || V.prep.get(qi) !== ent) return;           // missing, or taken or closed meanwhile
    const n = doc.numPages, per = perFor(n), start = which === 'last' ? lastStartFor(n, per) : 1, {W, H} = stageSize(per), song = songById(e.id);
    for(let i = 0; i < per && start + i <= n; i++) renderPage(start + i, W, H, cropOf(song, start + i), {doc, id:e.id}).catch(() => {});
  }, () => {});                                          // not opened: nothing to draw; a turn into it will show the error
}
const stageSize = per => ({W:Math.floor((stage.clientWidth - 16 - (per - 1) * 6) / per), H:stage.clientHeight - 16});
/* Replaces what the stage shows; the canvases that leave it are emptied unless the cache still keeps them. */
function setStage(...nodes){
  const old = [...stage.querySelectorAll('canvas')];
  stage.replaceChildren(...nodes);
  for(const cv of old) V.cache.unused(cv);
}

/* Draws one page into a canvas that just fits W x H. With a crop, only the kept part is drawn, scaled up to fill.
   src: whose PDF ({doc, id}); the song on screen unless a song being prepared is given. Pages are cached (js/pagecache.js:
   limited by pixels, the oldest first; the canvases of a page that leaves the cache are emptied, which is how iPad
   Safari gets its memory back). */
/* Pages are keyed by the OPEN DOCUMENT, not the song: a song twice in a set, or a PDF replaced, has two documents, and
   closing one must never take pages (or a render still running) from the other. */
const tags = new WeakMap();
let tagN = 0;
const tagOf = doc => { if(!tags.has(doc)) tags.set(doc, 'd' + ++tagN); return tags.get(doc); };
const pageKey = (src, pn, W, H, cr) => tagOf(src.doc) + ':' + pn + ':' + W + 'x' + H + ':' + [cr.x, cr.y, cr.w, cr.h].join(',');
const FULL_CROP = {x:0, y:0, w:1, h:1};
/* One page drawn into a new canvas that just fits W x H (the crop's kept part scaled up to fill): the drawing every turn and the
   background pass of js/prerender.js share, so a page kept for later is the page a turn would have drawn. onTask gets the pdf.js
   RenderTask (the background pass cancels it when the person taps). Resolves to {cv, cw, ch}; the canvas is emptied if it fails. */
export async function paintPage(doc, pn, W, H, cr, onTask){
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const pg = await doc.getPage(pn);
  const v1 = pg.getViewport({scale:1});
  const sc = Math.min(W / (v1.width * cr.w), H / (v1.height * cr.h));
  const cw = Math.floor(v1.width * cr.w * sc), ch = Math.floor(v1.height * cr.h * sc);
  const cv = document.createElement('canvas');
  cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  const vp = pg.getViewport({scale:sc * dpr});
  try{
    const task = pg.render({canvasContext:cv.getContext('2d'), viewport:vp, transform:[1, 0, 0, 1, -cr.x * vp.width, -cr.y * vp.height]});
    if(onTask) onTask(task);
    await task.promise;
  }
  catch(err){ release(cv); throw err; }
  return {cv, cw, ch};
}
export function renderPage(pn, W, H, crop, src = V){
  const cr = crop || FULL_CROP, key = pageKey(src, pn, W, H, cr);
  const hit = V.cache.hit(key);
  if(hit) return hit;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const pr = (async () => {
    /* a page the background pass has already drawn and kept (js/prerender.js) comes back from its picture; any trouble with that and it is drawn as before */
    const snap = src.id ? snapOf(snapKey(src.id, pn, W, H, dpr, cr)) : null;
    if(snap){
      const cv = await snapCanvas(snap);
      if(cv) return {cv, cw:snap.cw, ch:snap.ch, crop};
    }
    const p = await paintPage(src.doc, pn, W, H, cr);
    return {cv:p.cv, cw:p.cw, ch:p.ch, crop};
  })();
  V.cache.put(key, pr, W * H * dpr * dpr);
  return pr;
}
/* ---------- the whole setlist, ready (js/prerender.js) ----------
   readyPlan(): every page of every song of a setlist (a queue of more than one song), as {id, pn, W, H, cr, crop, key}, in the order a
   person will meet them: the rest of the song showing, then each later song, then (for going back) the pages before this one and the
   earlier songs, last page first. Sizes are the ones a turn uses (perFor / stageSize per song), so the keys are the keys renderPage
   asks for. paused(): the person is doing something. */
function readyPlan(){
  if(readyOff() || !viewer.classList.contains('on') || V.queue.filter(e => e.type === 'song').length < 2) return [];
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5), out = [];
  const song = qi => { const e = V.queue[qi]; return e && e.type === 'song' ? songById(e.id) : null; };
  const add = (qi, pns) => {
    const e = V.queue[qi], s = song(qi); if(!s) return;
    const n = qi === V.qi && V.n ? V.n : Math.max(1, s.pages || 1), per = perFor(n), {W, H} = stageSize(per);
    for(const pn of pns(n)){ const crop = cropOf(s, pn), cr = crop || FULL_CROP; out.push({id:e.id, pn, W, H, cr, crop, key:snapKey(e.id, pn, W, H, dpr, cr)}); }
  };
  const up = (a, b) => { const r = []; for(let i = a; i <= b; i++) r.push(i); return r; };          // a, a+1 ... b (none when a > b)
  const down = (a, b) => { const r = []; for(let i = a; i >= b; i--) r.push(i); return r; };        // a, a-1 ... b (none when a < b)
  if(V.brk){                                  // on a break page: the songs after it, then the songs before it
    for(let qi = V.qi + 1; qi < V.queue.length; qi++) add(qi, n => up(1, n));
    for(let qi = V.qi - 1; qi >= 0; qi--) add(qi, n => down(n, 1));
    return out;
  }
  add(V.qi, n => up(Math.min(V.page, n), n));
  for(let qi = V.qi + 1; qi < V.queue.length; qi++) add(qi, n => up(1, n));
  add(V.qi, n => down(Math.min(V.page, n) - 1, 1));
  for(let qi = V.qi - 1; qi >= 0; qi--) add(qi, n => down(n, 1));
  return out;
}
const readyPaused = () => !viewer.classList.contains('on') || V.busy || inkBusy() || V.annot || document.hidden || !!document.querySelector('.modal') || !$('#cropper').hidden;
/* "Ready 7 of 25" in the top bar beside the page line; "All ready" for a few seconds at the end. */
function readyShow(done, total, state){
  const el = $('#vReady'); if(!el) return;
  if(state === 'off' || !total){ el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = state === 'done' && done >= total ? 'All ready' : `Ready ${done} of ${total}`;
}
configureReady({plan: readyPlan, open: openDoc, paint: (doc, it, onTask) => paintPage(doc, it.pn, it.W, it.H, it.cr, onTask), paused: readyPaused, progress: readyShow});
function drawBreak(){
  const nx = V.queue.slice(V.qi + 1).find(e => e.type === 'song'), el = document.createElement('div');
  el.className = 'breakpage';
  el.innerHTML = `<h1></h1><p></p>`;
  el.querySelector('h1').textContent = V.brk.name;
  el.querySelector('p').textContent = nx ? 'Next: ' + (songById(nx.id)?.title || '') : 'End of set';
  setStage(el);
  updateChrome();
  /* a break page is the time to ready the songs on both sides (also after a resize or the Two pages toggle emptied the cache) */
  prepare(nextSong(V.qi), 'first'); prepare(prevSong(V.qi), 'last');
}
/* The placeholder for a chart that could not be opened, or one page that could not be drawn. */
function badPage(msg){
  const el = document.createElement('div');
  el.className = 'badpage'; el.innerHTML = `<h2></h2><p></p>`;
  el.querySelector('h2').textContent = V.song?.title || 'This song';
  el.querySelector('p').textContent = msg;
  return el;
}
export const BAD_CHART = 'This chart could not be opened. Your music is safe.', BAD_PAGE = 'This page could not be shown. Your music is safe.';
function drawBad(){
  setStage(badPage(BAD_CHART));
  updateChrome();
  prepare(nextSong(V.qi), 'first'); prepare(prevSong(V.qi), 'last');
}
export async function draw(){
  touchReady(); kickReady();                    // a draw is the person acting: the background pass waits, then goes on (js/prerender.js)
  /* V.dt first, break or not: a render still running for the page just left (its document is kept open now) must find
     V.dt changed and never paint over the break page */
  const dt = ++V.dt;
  if(V.brk) return drawBreak();
  if(V.bad) return drawBad();
  if(!V.doc) return;
  calcPer();
  const {W, H} = stageSize(V.per);
  const pns = [];
  for(let i = 0; i < V.per; i++){ const p = V.page + i; if(p <= V.n) pns.push(p); }
  const keys = pns.map(p => pageKey(V, p, W, H, cropOf(V.song, p) || FULL_CROP));
  const free = V.cache.hold(keys);                  // these pages must not be evicted before they are on the stage
  try{
    /* a page that fails to draw gets the placeholder in its place: the stage always moves to the page (and song) V holds,
       so Annotate, Crop and Undo never act on a song other than the one showing */
    const res = await Promise.allSettled(pns.map(p => renderPage(p, W, H, cropOf(V.song, p))));
    if(dt !== V.dt) return;
    setStage(...res.map((x, i) => {
      if(x.status !== 'fulfilled') return badPage(BAD_PAGE);
      const r = x.value, sh = document.createElement('div'); sh.className = 'sheet';
      sh.style.width = r.cw + 'px'; sh.style.height = r.ch + 'px';
      const ink = document.createElement('canvas'); ink.className = 'ink'; ink.dataset.pn = pns[i];
      ink.width = r.cv.width; ink.height = r.cv.height; ink._crop = r.crop; ink._ink = V.ink;   // whose marks these are: js/ink.js draws only on the open song's canvases
      sh.append(r.cv, ink);
      try{ paint(ink, V.ink.get(pns[i]) || []); }catch(e){}     // a mark that cannot be drawn never stops the page showing
      return sh;
    }));
  } finally { free(); }
  updateChrome();
  /* Ready the spreads either side, so a turn either way needs no wait; then the songs either side at the ends. */
  const ahead = (start) => { for(let i = 0; i < V.per; i++){ const p = start + i; if(p >= 1 && p <= V.n) renderPage(p, W, H, cropOf(V.song, p)).catch(() => {}); } };
  ahead(V.page + V.per);
  if(V.page > 1) ahead(Math.max(1, V.page - V.per));
  if(V.page + 2 * V.per > V.n) prepare(nextSong(V.qi), 'first');     // from the spread BEFORE the last (see "Songs next to this one")
  if(V.page <= 1 + V.per) prepare(prevSong(V.qi), 'last');
}
const entryLabel = e => e.type === 'break' ? e.name : (songById(e.id)?.title || '');
function updateChrome(){
  const nu = $('#nextup'), songs = V.queue.filter(e => e.type === 'song');
  $('#vAnn').hidden = !!V.brk || V.bad; $('#vCrop').hidden = !!V.brk || V.bad;
  if(V.brk){
    $('#vTitle').textContent = V.brk.name; $('#vSub').textContent = 'Break';
    nu.hidden = true; return;
  }
  $('#vTitle').textContent = V.song ? V.song.title : '';
  const pr = V.per === 2 && V.page < V.n ? `${V.page}–${V.page + 1}` : V.page;
  const k = V.queue.slice(0, V.qi + 1).filter(e => e.type === 'song').length;
  $('#vSub').textContent = (songs.length > 1 ? `Song ${k} of ${songs.length} · ` : '') + (V.bad ? 'Could not open' : `Page ${pr} of ${V.n}`);
  const last = V.bad || V.page + V.per > V.n, nxt = V.queue[V.qi + 1];
  if(last && nxt){ nu.hidden = false; nu.textContent = 'Next: ' + entryLabel(nxt); }
  else if(last && songs.length > 1){ nu.hidden = false; nu.textContent = 'End of set'; }
  else nu.hidden = true;
  $('#v2up').setAttribute('aria-pressed', V.two);
}
async function goTo(qi, page){
  V.busy = true;
  try{ await show(qi, page); } finally{ V.busy = false; }
}
/* No turn while a stroke, an erase or a note drag is under way (pedal, keys, buttons or a second finger): the mark
   belongs to the page it started on, and that page must stay on the screen until the pen lifts. */
const shown = () => !!(V.doc || V.brk || V.bad);     // a placeholder holds page 1 of 1, so a turn always moves past it
export async function next(){
  if(V.busy || inkBusy() || !shown()) return;
  if(!V.brk && V.page + V.per <= V.n){ V.page += V.per; draw(); }
  else if(V.qi < V.queue.length - 1) await goTo(V.qi + 1, 1);
  else toast(V.queue.length > 1 ? 'End of set' : 'Last page');
}
export async function prev(){
  if(V.busy || inkBusy() || !shown()) return;
  if(!V.brk && V.page > 1){ V.page = Math.max(1, V.page - V.per); draw(); }
  else if(V.qi > 0) await goTo(V.qi - 1, 'last');
}

/* ---------- jump to a song (the title in the top bar, when the viewer was opened from a setlist) ---------- */
const ttl = () => $('#vtop .ttl');
function jumpable(on){
  const t = ttl();
  t.classList.toggle('canjump', on);
  if(on){ t.setAttribute('role', 'button'); t.tabIndex = 0; t.setAttribute('aria-haspopup', 'dialog'); t.title = 'Go to another song in this setlist'; }
  else { for(const a of ['role', 'tabindex', 'aria-haspopup', 'title']) t.removeAttribute(a); }
}
function openJump(){
  if(!ttl().classList.contains('canjump') || !viewer.classList.contains('on') || V.busy || inkBusy() || document.querySelector('.modal') || !$('#cropper').hidden) return;
  jumpList(V.queue, V.qi, qi => { if(viewer.classList.contains('on') && qi !== V.qi && !V.busy && !inkBusy()) goTo(qi, 1); },
    () => { if(document.activeElement === ttl()) ttl().blur(); });     // a pedal's Space must turn the page, not open the list again
}

/* ---------- pointers: drawing goes to ink.js, everything else is page turning ---------- */
/* One swipe or tap at a time. A primary pointerdown starts a new one even if the last never ended (its pointerup can
   be lost when the page under the finger is replaced mid-touch); another finger is ignored while a gesture under
   2 s old is open, and starts a new one after that. */
let gest = null;
/* A tap is short and still: a touch that moved 12 px or more, or rested TAP_MS or longer (a hand settling on the screen,
   a palm), turns no page and does not show or hide the bars. */
export const TAP_MS = 500;
stage.addEventListener('pointerdown', e => {
  touchReady();
  if(inkPointerDown(e)) return;
  if(gest && !e.isPrimary && Date.now() - gest.t < 2000) return;
  gest = {id:e.pointerId, x:e.clientX, y:e.clientY, t:Date.now(), ts:e.timeStamp};
});
stage.addEventListener('pointermove', inkPointerMove);
stage.addEventListener('pointerup', e => {
  if(inkPointerUp(e)) return;
  if(!gest || e.pointerId !== gest.id) return;
  const dx = e.clientX - gest.x, dy = e.clientY - gest.y, held = e.timeStamp - gest.ts; gest = null;      // the browser's own times of the two events: a long task between the two handlers must not turn a quick tap into a hold
  if(Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3){ dx < 0 ? next() : prev(); return; }
  if(Math.hypot(dx, dy) < 12 && held < TAP_MS){
    const f = e.clientX / innerWidth;
    if(f < .3) prev(); else if(f > .7) next(); else if(!V.annot) viewer.classList.toggle('hide');
    /* A finger is ignored while annotating unless "Finger draws" is on (the stylus only, so a resting palm marks nothing):
       with Text chosen, a tap in the middle of the page would otherwise seem to do nothing. Tell the player what to press. */
    else if(V.tool === 'text' && !V.finger && e.pointerType === 'touch') toast('To add a note with your finger, tap "Finger draws" first');
  }
});
stage.addEventListener('pointercancel', e => {
  inkPointerCancel(e);
  if(gest && gest.id === e.pointerId) gest = null;
});

export function initViewer(){
  $('#vBack').onclick = closeViewer;
  initBackNav();
  initAwake();
  $('#vCrop').onclick = () => openCropper();
  $('#vPrev').onclick = prev;
  $('#vNext').onclick = next;
  $('#v2up').onclick = () => { V.two = !V.two; try{ localStorage.setItem('ss-two', V.two ? '1' : '0'); }catch(e){} stopReady(); V.cache.clear(); draw(); };
  /* An iPad app opened from the Home Screen icon (navigator.standalone, an iOS-only flag) already fills the screen and the
     browser refuses the Full screen call there, so the button would only say "not available": leave it out. */
  if(navigator.standalone === true) $('#vFull').hidden = true;
  $('#vFull').onclick = () => {
    if(fsElement()){ exitFs(); return; }
    /* The WHOLE page goes full screen, not #viewer: in full screen the browser shows only the full-screen element and
       what is inside it, so with #viewer alone every dialog (appended to body), toast and the crop screen (siblings
       of #viewer) opened out of sight while the viewer behind them was made inert: a freeze. The viewer is
       position:fixed over everything, so the picture is the same. */
    enterFs();
  };
  const t = ttl();
  t.addEventListener('click', e => { if(e.pointerType || e.detail) t.blur(); openJump(); });     // a tap leaves no focus on it (see openJump)
  t.addEventListener('keydown', e => { if((e.key === 'Enter' || e.key === ' ') && t.classList.contains('canjump')){ e.preventDefault(); if(!e.repeat) openJump(); } });
  viewer.addEventListener('click', e => { const b = e.target.closest('button'); if(b) b.blur(); });
  addEventListener('keydown', e => {
    if(e.defaultPrevented || !viewer.classList.contains('on') || !$('#cropper').hidden) return;
    const k = e.key, jm = [...document.querySelectorAll('.modal')].pop(), jl = jm && jm.classList.contains('jumplist') ? jm : null;      // the jump list only when it is the dialog on top
    /* a dialog already took this key, except that a pedal's page-turn key closes the "Go to a song" list (a stray tap on the title opened it) and turns */
    if(document.querySelector('.modal') && !(jl && ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'ArrowLeft', 'ArrowUp', 'PageUp'].includes(k))) return;
    if(jl) jl.remove();
    /* a key held down (a pedal held, a key repeating) turns ONE page, not one per repeat */
    if(['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(k)){ e.preventDefault(); if(!e.repeat) next(); }
    else if(['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)){ e.preventDefault(); if(!e.repeat) prev(); }
    else if(k === 'Escape'){ if(!$('#wdMenu').hidden) widthMenu(false); else if(V.annot) setAnnot(false); else closeViewer(); }   // one layer at a time (back means this too: js/backnav.js)
  });
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if(viewer.classList.contains('on')){ stopReady(); V.cache.clear(); draw(); } }, 150); });
}

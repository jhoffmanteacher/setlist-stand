import {$, toast, hooks} from './util.js';
import {get, getInkPages, songById, cropOf} from './store.js';
import {openCropper} from './crop.js';
import {awakeOpen, awakeClose, initAwake} from './awake.js';
import {PageCache, release} from './pagecache.js';
import {initBackNav} from './backnav.js';
import {paint, setAnnot, widthMenu, inkBusy, inkReset, inkPointerDown, inkPointerMove, inkPointerUp, inkPointerCancel} from './ink.js';

export const stage = $('#stage'), viewer = $('#viewer');
/* cache: rendered pages (js/pagecache.js). prep: queue index -> {id, p: Promise of an open pdf.js document} for the songs
   next to the one showing, kept open so a turn into them has nothing to open (see "Songs next to this one" below). */
export const V = {queue:[], qi:0, brk:null, page:1, n:0, doc:null, id:null, song:null, per:1, two:true, annot:false, finger:false,
  tool:'pen', color:'#1a1a1a', tok:0, dt:0, busy:false, cache:new PageCache(), prep:new Map(), ink:new Map(), hist:[]};
try{ V.two = localStorage.getItem('ss-two') !== '0'; }catch(e){}

/* The back gesture (one history entry per layer, back means Escape) is js/backnav.js. */

/* entries: [{type:'song', id} | {type:'break', id, name}] */
export async function openViewer(entries, qi, page = 1){
  if(!entries.some(e => e.type === 'song')) return;
  prune([]); V.queue = entries; V.hist = [];
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
  V.tok++; V.dt++; V.brk = null; gest = null;
  if(V.doc){ V.doc.destroy(); V.doc = null; }
  prune([]);                                  // songs prepared for a turn that never came: closed, their pages released
  V.cache.clear(); setStage();
  document.body.style.overflow = '';
  document.body.classList.remove('playing');
  awakeClose();
  if(document.fullscreenElement) document.exitFullscreen().catch(() => {});
  hooks.render();
}
const show = (qi, page) => V.queue[qi].type === 'break' ? showBreak(qi) : loadSong(qi, page);
async function showBreak(qi){
  V.tok++; setAnnot(false);
  retire(qi);                                 // the song just left stays open: Back from the break is instant
  V.brk = V.queue[qi]; V.qi = qi; V.song = null; V.id = null; V.page = 1; V.n = 1;
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
  return pdfjsLib.getDocument({data:new Uint8Array(await blob.arrayBuffer())}).promise;
}
async function loadSong(qi, page){
  const tok = ++V.tok; const id = V.queue[qi].id;
  let doc = null;
  try{
    doc = await takeDoc(qi, id);
    if(!doc){ toast('That file is missing'); return; }
    const ink = await getInkPages(id, doc.numPages);     // one read for every page, not one awaited read per page
    if(tok !== V.tok){ dropDoc({p:Promise.resolve(doc)}); return; }
    retire(qi);
    Object.assign(V, {doc, id, qi, n:doc.numPages, song:songById(id), ink, brk:null});
    V.page = 1; calcPer();
    V.page = page === 'last' ? lastStart() : Math.min(Math.max(1, +page || 1), V.n);
    if(V.per === 2 && V.page % 2 === 0) V.page--;
    prune(around(qi));
    await draw();
  }catch(err){
    if(doc && doc !== V.doc) dropDoc({p:Promise.resolve(doc)});     // opened but never shown (the ink read failed): close it, or its worker and bytes leak
    toast('Could not open this PDF');
  }
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
export function renderPage(pn, W, H, crop, src = V){
  const cr = crop || FULL_CROP, key = pageKey(src, pn, W, H, cr);
  const hit = V.cache.hit(key);
  if(hit) return hit;
  const doc = src.doc, dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const pr = (async () => {
    const pg = await doc.getPage(pn);
    const v1 = pg.getViewport({scale:1});
    const sc = Math.min(W / (v1.width * cr.w), H / (v1.height * cr.h));
    const cw = Math.floor(v1.width * cr.w * sc), ch = Math.floor(v1.height * cr.h * sc);
    const cv = document.createElement('canvas');
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    const vp = pg.getViewport({scale:sc * dpr});
    try{ await pg.render({canvasContext:cv.getContext('2d'), viewport:vp, transform:[1, 0, 0, 1, -cr.x * vp.width, -cr.y * vp.height]}).promise; }
    catch(err){ release(cv); throw err; }
    return {cv, cw, ch, crop};
  })();
  V.cache.put(key, pr, W * H * dpr * dpr);
  return pr;
}
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
export async function draw(){
  /* V.dt first, break or not: a render still running for the page just left (its document is kept open now) must find
     V.dt changed and never paint over the break page */
  const dt = ++V.dt;
  if(V.brk) return drawBreak();
  if(!V.doc) return;
  calcPer();
  const {W, H} = stageSize(V.per);
  const pns = [];
  for(let i = 0; i < V.per; i++){ const p = V.page + i; if(p <= V.n) pns.push(p); }
  const keys = pns.map(p => pageKey(V, p, W, H, cropOf(V.song, p) || FULL_CROP));
  const free = V.cache.hold(keys);                  // these pages must not be evicted before they are on the stage
  let res;
  try{
    try{ res = await Promise.all(pns.map(p => renderPage(p, W, H, cropOf(V.song, p)))); }catch(e){ return; }
    if(dt !== V.dt) return;
    setStage(...res.map((r, i) => {
      const sh = document.createElement('div'); sh.className = 'sheet';
      sh.style.width = r.cw + 'px'; sh.style.height = r.ch + 'px';
      const ink = document.createElement('canvas'); ink.className = 'ink'; ink.dataset.pn = pns[i];
      ink.width = r.cv.width; ink.height = r.cv.height; ink._crop = r.crop;
      sh.append(r.cv, ink);
      paint(ink, V.ink.get(pns[i]) || []);
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
  $('#vAnn').hidden = !!V.brk; $('#vCrop').hidden = !!V.brk;
  if(V.brk){
    $('#vTitle').textContent = V.brk.name; $('#vSub').textContent = 'Break';
    nu.hidden = true; return;
  }
  $('#vTitle').textContent = V.song ? V.song.title : '';
  const pr = V.per === 2 && V.page < V.n ? `${V.page}–${V.page + 1}` : V.page;
  const k = V.queue.slice(0, V.qi + 1).filter(e => e.type === 'song').length;
  $('#vSub').textContent = (songs.length > 1 ? `Song ${k} of ${songs.length} · ` : '') + `Page ${pr} of ${V.n}`;
  const last = V.page + V.per > V.n, nxt = V.queue[V.qi + 1];
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
export async function next(){
  if(V.busy || inkBusy() || (!V.doc && !V.brk)) return;
  if(!V.brk && V.page + V.per <= V.n){ V.page += V.per; draw(); }
  else if(V.qi < V.queue.length - 1) await goTo(V.qi + 1, 1);
  else toast(V.queue.length > 1 ? 'End of set' : 'Last page');
}
export async function prev(){
  if(V.busy || inkBusy() || (!V.doc && !V.brk)) return;
  if(!V.brk && V.page > 1){ V.page = Math.max(1, V.page - V.per); draw(); }
  else if(V.qi > 0) await goTo(V.qi - 1, 'last');
}

/* ---------- pointers: drawing goes to ink.js, everything else is page turning ---------- */
/* One swipe or tap at a time. A primary pointerdown starts a new one even if the last never ended (its pointerup can
   be lost when the page under the finger is replaced mid-touch); another finger is ignored while a gesture under
   2 s old is open, and starts a new one after that. */
let gest = null;
stage.addEventListener('pointerdown', e => {
  if(inkPointerDown(e)) return;
  if(gest && !e.isPrimary && Date.now() - gest.t < 2000) return;
  gest = {id:e.pointerId, x:e.clientX, y:e.clientY, t:Date.now()};
});
stage.addEventListener('pointermove', inkPointerMove);
stage.addEventListener('pointerup', e => {
  if(inkPointerUp(e)) return;
  if(!gest || e.pointerId !== gest.id) return;
  const dx = e.clientX - gest.x, dy = e.clientY - gest.y; gest = null;
  if(Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3){ dx < 0 ? next() : prev(); return; }
  if(Math.hypot(dx, dy) < 12){
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
  $('#v2up').onclick = () => { V.two = !V.two; try{ localStorage.setItem('ss-two', V.two ? '1' : '0'); }catch(e){} V.cache.clear(); draw(); };
  /* An iPad app opened from the Home Screen icon (navigator.standalone, an iOS-only flag) already fills the screen and the
     browser refuses the Full screen call there, so the button would only say "not available": leave it out. */
  if(navigator.standalone === true) $('#vFull').hidden = true;
  $('#vFull').onclick = () => {
    if(document.fullscreenElement){ document.exitFullscreen().catch(() => {}); return; }
    /* The WHOLE page goes full screen, not #viewer: in full screen the browser shows only the full-screen element and
       what is inside it, so with #viewer alone every dialog (appended to body), toast and the crop screen (siblings
       of #viewer) opened out of sight while the viewer behind them was made inert: a freeze. The viewer is
       position:fixed over everything, so the picture is the same. */
    const root = document.documentElement, p = root.requestFullscreen ? root.requestFullscreen() : null;
    if(p && p.catch) p.catch(() => toast('Full screen is not available here')); else if(!p) toast('Full screen is not available here');
  };
  viewer.addEventListener('click', e => { const b = e.target.closest('button'); if(b) b.blur(); });
  addEventListener('keydown', e => {
    if(e.defaultPrevented || !viewer.classList.contains('on') || document.querySelector('.modal') || !$('#cropper').hidden) return;   // a dialog already took this key
    const k = e.key;
    if(['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(k)){ e.preventDefault(); next(); }
    else if(['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)){ e.preventDefault(); prev(); }
    else if(k === 'Escape'){ if(!$('#wdMenu').hidden) widthMenu(false); else if(V.annot) setAnnot(false); else closeViewer(); }   // one layer at a time (back means this too: js/backnav.js)
  });
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if(viewer.classList.contains('on')){ V.cache.clear(); draw(); } }, 150); });
}

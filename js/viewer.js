import {$, toast, hooks} from './util.js';
import {get, getInk, state, songById, cropOf} from './store.js';
import {openCropper} from './crop.js';
import {paint, setAnnot, inkPointerDown, inkPointerMove, inkPointerUp, inkPointerCancel} from './ink.js';

export const stage = $('#stage'), viewer = $('#viewer');
export const V = {queue:[], qi:0, brk:null, page:1, n:0, doc:null, id:null, song:null, per:1, two:true, annot:false, finger:false,
  tool:'pen', color:'#1a1a1a', tok:0, dt:0, busy:false, cache:new Map(), ink:new Map(), hist:[]};
try{ V.two = localStorage.getItem('ss-two') !== '0'; }catch(e){}

let wl = null;
async function lock(){ try{ wl = await navigator.wakeLock.request('screen'); }catch(e){} }
function unlock(){ try{ wl && wl.release(); }catch(e){} wl = null; }
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible' && viewer.classList.contains('on')) lock(); });

/* entries: [{type:'song', id} | {type:'break', id, name}] */
export async function openViewer(entries, qi){
  if(!entries.some(e => e.type === 'song')) return;
  V.queue = entries; V.hist = [];
  viewer.classList.add('on'); viewer.classList.remove('hide');
  document.body.style.overflow = 'hidden';
  lock();
  await show(qi, 1);
}
export function closeViewer(){
  setAnnot(false);
  viewer.classList.remove('on');
  V.tok++; V.dt++; V.brk = null;
  if(V.doc){ V.doc.destroy(); V.doc = null; }
  V.cache.clear(); stage.innerHTML = '';
  document.body.style.overflow = '';
  unlock();
  if(document.fullscreenElement) document.exitFullscreen().catch(() => {});
  hooks.render();
}
const show = (qi, page) => V.queue[qi].type === 'break' ? showBreak(qi) : loadSong(qi, page);
async function showBreak(qi){
  V.tok++; setAnnot(false);
  if(V.doc){ V.doc.destroy(); V.doc = null; }
  V.cache.clear(); V.brk = V.queue[qi]; V.qi = qi; V.song = null; V.id = null; V.page = 1; V.n = 1;
  await draw();
}
async function loadSong(qi, page){
  const tok = ++V.tok; const id = V.queue[qi].id;
  try{
    const blob = await get('files', id);
    if(!blob){ toast('That file is missing'); return; }
    const doc = await pdfjsLib.getDocument({data:new Uint8Array(await blob.arrayBuffer())}).promise;
    const ink = new Map();
    for(let p = 1; p <= doc.numPages; p++) ink.set(p, await getInk(id, p));
    if(tok !== V.tok){ doc.destroy(); return; }
    if(V.doc) V.doc.destroy();
    Object.assign(V, {doc, id, qi, n:doc.numPages, song:songById(id), ink, brk:null});
    V.cache.clear(); V.page = 1; calcPer();
    V.page = page === 'last' ? lastStart() : 1;
    await draw();
  }catch(err){ toast('Could not open this PDF'); }
}
function calcPer(){
  V.per = (V.two && innerWidth > innerHeight * 1.1 && V.n > 1) ? 2 : 1;
  if(V.per === 2 && V.page % 2 === 0) V.page--;
}
const lastStart = () => V.per === 2 ? (V.n % 2 ? V.n : V.n - 1) : V.n;

/* Draws one page into a canvas that just fits W x H. With a crop, only the kept part is drawn, scaled up to fill. */
export function renderPage(pn, W, H, crop){
  const cr = crop || {x:0, y:0, w:1, h:1};
  const key = V.id + ':' + pn + ':' + W + 'x' + H + ':' + [cr.x, cr.y, cr.w, cr.h].join(',');
  if(V.cache.has(key)) return V.cache.get(key);
  const doc = V.doc;
  const pr = (async () => {
    const pg = await doc.getPage(pn);
    const v1 = pg.getViewport({scale:1});
    const sc = Math.min(W / (v1.width * cr.w), H / (v1.height * cr.h));
    const cw = Math.floor(v1.width * cr.w * sc), ch = Math.floor(v1.height * cr.h * sc);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const cv = document.createElement('canvas');
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    const vp = pg.getViewport({scale:sc * dpr});
    await pg.render({canvasContext:cv.getContext('2d'), viewport:vp, transform:[1, 0, 0, 1, -cr.x * vp.width, -cr.y * vp.height]}).promise;
    return {cv, cw, ch, crop};
  })();
  V.cache.set(key, pr);
  pr.catch(() => V.cache.delete(key));
  while(V.cache.size > 10) V.cache.delete(V.cache.keys().next().value);
  return pr;
}
function drawBreak(){
  const nx = V.queue.slice(V.qi + 1).find(e => e.type === 'song'), el = document.createElement('div');
  el.className = 'breakpage';
  el.innerHTML = `<h1></h1><p></p>`;
  el.querySelector('h1').textContent = V.brk.name;
  el.querySelector('p').textContent = nx ? 'Next: ' + (songById(nx.id)?.title || '') : 'End of set';
  stage.replaceChildren(el);
  updateChrome();
}
export async function draw(){
  if(V.brk) return drawBreak();
  if(!V.doc) return;
  const dt = ++V.dt; calcPer();
  const pad = 8;
  const W = Math.floor((stage.clientWidth - pad * 2 - (V.per - 1) * 6) / V.per);
  const H = stage.clientHeight - pad * 2;
  const pns = [];
  for(let i = 0; i < V.per; i++){ const p = V.page + i; if(p <= V.n) pns.push(p); }
  let res;
  try{ res = await Promise.all(pns.map(p => renderPage(p, W, H, cropOf(V.song, p)))); }catch(e){ return; }
  if(dt !== V.dt) return;
  stage.replaceChildren(...res.map((r, i) => {
    const sh = document.createElement('div'); sh.className = 'sheet';
    sh.style.width = r.cw + 'px'; sh.style.height = r.ch + 'px';
    const ink = document.createElement('canvas'); ink.className = 'ink'; ink.dataset.pn = pns[i];
    ink.width = r.cv.width; ink.height = r.cv.height; ink._crop = r.crop;
    sh.append(r.cv, ink);
    paint(ink, V.ink.get(pns[i]) || []);
    return sh;
  }));
  updateChrome();
  const nx = V.page + V.per;
  for(let i = 0; i < V.per; i++){ const p = nx + i; if(p <= V.n) renderPage(p, W, H, cropOf(V.song, p)).catch(() => {}); }
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
export async function next(){
  if(V.busy || (!V.doc && !V.brk)) return;
  if(!V.brk && V.page + V.per <= V.n){ V.page += V.per; draw(); }
  else if(V.qi < V.queue.length - 1) await goTo(V.qi + 1, 1);
  else toast(V.queue.length > 1 ? 'End of set' : 'Last page');
}
export async function prev(){
  if(V.busy || (!V.doc && !V.brk)) return;
  if(!V.brk && V.page > 1){ V.page = Math.max(1, V.page - V.per); draw(); }
  else if(V.qi > 0) await goTo(V.qi - 1, 'last');
}

/* ---------- pointers: drawing goes to ink.js, everything else is page turning ---------- */
let gest = null;
stage.addEventListener('pointerdown', e => {
  if(inkPointerDown(e)) return;
  if(gest) return;
  gest = {id:e.pointerId, x:e.clientX, y:e.clientY};
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
  }
});
stage.addEventListener('pointercancel', e => {
  inkPointerCancel(e);
  if(gest && gest.id === e.pointerId) gest = null;
});

export function initViewer(){
  $('#vBack').onclick = closeViewer;
  $('#vCrop').onclick = () => openCropper();
  $('#vPrev').onclick = prev;
  $('#vNext').onclick = next;
  $('#v2up').onclick = () => { V.two = !V.two; try{ localStorage.setItem('ss-two', V.two ? '1' : '0'); }catch(e){} V.cache.clear(); draw(); };
  $('#vFull').onclick = () => {
    if(document.fullscreenElement){ document.exitFullscreen().catch(() => {}); return; }
    const p = viewer.requestFullscreen ? viewer.requestFullscreen() : null;
    if(p && p.catch) p.catch(() => toast('Full screen is not available here')); else if(!p) toast('Full screen is not available here');
  };
  viewer.addEventListener('click', e => { const b = e.target.closest('button'); if(b) b.blur(); });
  addEventListener('keydown', e => {
    if(!viewer.classList.contains('on') || document.querySelector('.modal') || !$('#cropper').hidden) return;
    const k = e.key;
    if(['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(k)){ e.preventDefault(); next(); }
    else if(['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)){ e.preventDefault(); prev(); }
    else if(k === 'Escape'){ V.annot ? setAnnot(false) : closeViewer(); }
  });
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if(viewer.classList.contains('on')){ V.cache.clear(); draw(); } }, 150); });
}

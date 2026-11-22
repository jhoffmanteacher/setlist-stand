/* The crop editor: the whole current page with a draggable box. The box is stored as fractions of the full page. */
import {$, toast} from './util.js';
import {saveSong, cropOf, CROP_MIN} from './store.js';
import {V, renderPage, draw} from './viewer.js';

const MIN = CROP_MIN;                // the box can't get smaller than 8% of the page
let loadTok = 0;
let st = null;                       // {pn, rect, sw, sh} while the editor is open

const sheet = () => $('#cropSheet'), box = () => $('#cropBox');
function place(){
  const r = st.rect, b = box();
  b.style.left = r.x * 100 + '%'; b.style.top = r.y * 100 + '%'; b.style.width = r.w * 100 + '%'; b.style.height = r.h * 100 + '%';
}
export async function openCropper(){
  if(!V.doc || V.brk) return;
  $('#cropper').hidden = false;
  await showPage(V.page);
}
/* Shows page pn in the editor (the arrows in the bar move between pages, so any page of a spread can be cropped). */
async function showPage(pn){
  const cropper = $('#cropper'), stage = $('#cropStage'), token = ++loadTok;
  st = null;
  const W = stage.clientWidth - 32, H = stage.clientHeight - 32;
  let r;
  try{ r = await renderPage(pn, W, H, null); }catch(e){ cropper.hidden = true; return; }
  if(token !== loadTok || cropper.hidden) return;
  const cv = $('#cropCv'); cv.width = r.cv.width; cv.height = r.cv.height;
  cv.getContext('2d').drawImage(r.cv, 0, 0);
  const sh = sheet(); sh.style.width = r.cw + 'px'; sh.style.height = r.ch + 'px';
  const cur = cropOf(V.song, pn);
  st = {pn, rect:cur ? {...cur} : {x:0, y:0, w:1, h:1}};
  place();
  $('#cropHint').textContent = `Page ${pn} of ${V.n}`;
  $('#cropPrev').disabled = pn <= 1; $('#cropNext').disabled = pn >= V.n;
}
function close(){ $('#cropper').hidden = true; st = null; loadTok++; }
async function apply(whole){
  if(!st) return;
  const song = V.song, rect = {x:round(st.rect.x), y:round(st.rect.y), w:round(st.rect.w), h:round(st.rect.h)}, pn = st.pn;
  const full = rect.x <= .002 && rect.y <= .002 && rect.w >= .996 && rect.h >= .996;
  const plain = x => !!x && typeof x === 'object' && !Array.isArray(x);
  if(!plain(song.crop)) song.crop = {all:null, pages:{}};                                    // a crop that came damaged (a sync, a restore) is replaced by the new one
  if(!plain(song.crop.pages)) song.crop.pages = {};
  if(whole){ song.crop = {all:full ? null : rect, pages:{}}; }
  else if(full && !song.crop.all) delete song.crop.pages[pn];
  else song.crop.pages[pn] = rect;      // also when "no crop" is wanted on a page of a cropped song: the full rect overrides
  await saveSong(song);
  close(); V.cache.clear(); draw();
  toast(whole ? 'Cropped the whole song' : `Cropped page ${pn}`);
}
const round = n => Math.round(n * 1e4) / 1e4;

export function initCrop(){
  $('#cropCancel').onclick = close;
  $('#cropPage').onclick = () => apply(false);
  $('#cropSong').onclick = () => apply(true);
  $('#cropPrev').onclick = () => st && showPage(st.pn - 1);
  $('#cropNext').onclick = () => st && showPage(st.pn + 1);
  $('#cropReset').onclick = async () => {
    if(!st) return;
    const song = V.song, pn = st.pn; let msg;
    if(song.crop && song.crop.pages && song.crop.pages[pn]){ delete song.crop.pages[pn]; msg = 'Page crop removed'; }
    else if(song.crop && song.crop.all){ song.crop.all = null; msg = 'Song crop removed'; }
    else { st.rect = {x:0, y:0, w:1, h:1}; place(); toast('This page has no crop'); return; }
    await saveSong(song); close(); V.cache.clear(); draw(); toast(msg);
  };
  addEventListener('keydown', e => { if(st && e.key === 'Escape') close(); });

  /* dragging: a handle resizes, the box body moves */
  let drag = null;
  const stageEl = $('#cropStage');
  stageEl.addEventListener('pointerdown', e => {
    if(!st) return;
    const h = e.target.closest('.ch'), inBox = e.target.closest('#cropBox');
    if(!h && !inBox) return;
    e.preventDefault();
    try{ stageEl.setPointerCapture(e.pointerId); }catch(err){}
    drag = {pid:e.pointerId, mode:h ? h.dataset.h : 'move', x0:e.clientX, y0:e.clientY, r0:{...st.rect}, b:sheet().getBoundingClientRect()};
  });
  stageEl.addEventListener('pointermove', e => {
    if(!drag || e.pointerId !== drag.pid) return;
    const dx = (e.clientX - drag.x0) / drag.b.width, dy = (e.clientY - drag.y0) / drag.b.height, r0 = drag.r0, m = drag.mode;
    let l = r0.x, t = r0.y, r = r0.x + r0.w, b = r0.y + r0.h;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    if(m === 'move'){
      const nx = clamp(l + dx, 0, 1 - r0.w), ny = clamp(t + dy, 0, 1 - r0.h);
      st.rect = {x:nx, y:ny, w:r0.w, h:r0.h}; place(); return;
    }
    if(m.includes('w')) l = clamp(l + dx, 0, r - MIN);
    if(m.includes('e')) r = clamp(r + dx, l + MIN, 1);
    if(m.includes('n')) t = clamp(t + dy, 0, b - MIN);
    if(m.includes('s')) b = clamp(b + dy, t + MIN, 1);
    st.rect = {x:l, y:t, w:r - l, h:b - t}; place();
  });
  const end = e => { if(drag && e.pointerId === drag.pid) drag = null; };
  stageEl.addEventListener('pointerup', end); stageEl.addEventListener('pointercancel', end);
}

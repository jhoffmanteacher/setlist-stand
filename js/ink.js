/* Pen, highlighter, eraser and text notes. Everything is stored apart from the PDF, as fractions of the FULL page,
   so marks never move when a crop changes. A canvas carries the crop it is drawn through in cv._crop. */
import {$, esc, toast, armed, uid, modal} from './util.js';
import {explainError} from './errors.js';
import {putInk, getInk, reconcile, liveStrokes} from './store.js';
import {V, stage, viewer, draw} from './viewer.js';

const FULL = {x:0, y:0, w:1, h:1};
const cropOfCv = cv => cv._crop || FULL;
export const SIZES = {small:.012, medium:.018, large:.028};
const PEN_COLORS = ['#1a1a1a', '#d62828', '#1f5fd6'];
const FONT = '600 {px}px Barlow, system-ui, sans-serif';

export function paint(cv, strokes){
  const c = cv.getContext('2d'), w = cv.width, h = cv.height, cr = cropOfCv(cv), pw = w / cr.w;
  c.clearRect(0, 0, w, h);
  for(const s of strokes){
    if(s.deleted) continue;
    if(s.t === 'text'){
      const px = s.size * pw; c.save(); c.font = FONT.replace('{px}', px); c.fillStyle = s.c; c.textBaseline = 'top';
      s.text.split('\n').forEach((ln, i) => c.fillText(ln, (s.x - cr.x) / cr.w * w, (s.y - cr.y) / cr.h * h + i * px * 1.2));
      c.restore(); continue;
    }
    const X = p => (p[0] - cr.x) / cr.w * w, Y = p => (p[1] - cr.y) / cr.h * h;
    c.save(); c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = s.c; c.lineWidth = s.w * pw;
    if(s.t === 'hl'){ c.globalAlpha = .4; c.lineCap = 'butt'; }
    c.beginPath();
    s.p.forEach((p, i) => i ? c.lineTo(X(p), Y(p)) : c.moveTo(X(p), Y(p)));
    if(s.p.length === 1) c.lineTo(X(s.p[0]) + .5, Y(s.p[0]));
    c.stroke(); c.restore();
  }
}
const r4 = n => Math.round(n * 1e4) / 1e4;
function tidy(s){
  const p = [];
  for(const pt of s.p){ const l = p[p.length - 1]; if(!l || Math.hypot(pt[0] - l[0], pt[1] - l[1]) > .0015) p.push([r4(pt[0]), r4(pt[1])]); }
  return {...s, p};
}
function saveInk(id, pn, strokes){ putInk(id, pn, strokes).catch(err => toast(explainError(err, 'Could not save that mark. Your music is safe.'))); }
/* pointer position as fractions of the full page; null when it cannot be measured (a canvas no longer on the
   screen has zero size, and x / 0 would store Infinity, which no printer can draw) */
function ptOn(cv, e){
  const r = cv.getBoundingClientRect(), cr = cropOfCv(cv);
  if(!cv.isConnected || !(r.width > 0) || !(r.height > 0)) return null;
  const p = [cr.x + (e.clientX - r.left) / r.width * cr.w, cr.y + (e.clientY - r.top) / r.height * cr.h];
  return Number.isFinite(p[0]) && Number.isFinite(p[1]) ? p : null;
}
const toScreen = (cv, r, p) => { const cr = cropOfCv(cv); return [(p[0] - cr.x) / cr.w * r.width, (p[1] - cr.y) / cr.h * r.height]; };

/* The gesture in progress: everything it needs is captured at pointerdown (song id, page, its strokes in c.arr,
   the canvas, the tool), so nothing that changes meanwhile (the song or page on screen, the tool) can send the mark
   to another page or throw. The viewer refuses page turns while it is set (inkBusy). */
let cur = null, raf = 0;
/* A gesture whose pointer sent nothing for 3 s (the app was switched away, capture was lost) is stale: it no longer
   blocks page turns or a new pen-down. It still saves to its own song and page when it ends. */
const STALE_MS = 3000;
const isStale = c => Date.now() - c.t > STALE_MS;
export const inkBusy = () => !!cur && !isStale(cur);
/* Ends the gesture in progress: a stroke or erase saves what is there, a note drag is put back. */
function endCur(keepNote){
  const c = cur; if(!c) return;
  if(c.kind === 'note'){ cur = null; endNote(c, !(keepNote && c.moved)); } else endStroke();
}
export function inkReset(){ endCur(false); }
/* The canvas the gesture draws on. If the viewer redrew the same page (a resize), the new canvas for it. */
function curCv(c){
  if(c.cv.isConnected || V.id !== c.id) return c.cv;
  const cv = stage.querySelector(`.ink[data-pn="${c.pn}"]`);
  if(cv) c.cv = cv;
  return c.cv;
}
/* Shows c.arr on screen and in V.ink, only while that song is still the one open. */
function showArr(c, arr){
  if(V.id !== c.id) return;
  V.ink.set(c.pn, arr);
  const cv = curCv(c); if(cv.isConnected) paint(cv, arr);
}
function live(){
  if(raf) return;
  raf = requestAnimationFrame(() => { raf = 0; if(cur && cur.s && V.id === cur.id){ const cv = curCv(cur); if(cv.isConnected) paint(cv, cur.arr.concat([cur.s])); } });
}
function eraseAt(e){
  const cv = curCv(cur); if(!cv.isConnected) return;
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, cr = cropOfCv(cv);
  if(!(r.width > 0)) return;
  const arr = cur.arr;
  const hit = s => !s.deleted && s.t !== 'text' && Array.isArray(s.p) && s.p.some(p => { const [sx, sy] = toScreen(cv, r, p); return Math.hypot(sx - x, sy - y) < 14 + s.w * r.width / cr.w / 2; });
  if(arr.some(hit)){
    const t = Date.now(), keep = arr.map(s => hit(s) ? {id:s.id, deleted:true, updated:t} : s);
    cur.arr = keep; cur.changed = true; showArr(cur, keep);
  }
}
function endStroke(){
  const c = cur; cur = null;
  if(c.s && c.s.p.length){ c.arr = c.arr.concat([tidy(c.s)]); c.changed = true; }
  if(c.changed){ V.hist.push({id:c.id, pn:c.pn, before:c.before}); saveInk(c.id, c.pn, c.arr); }
  showArr(c, c.arr);
}

/* ---------- text notes ---------- */
const measureCtx = document.createElement('canvas').getContext('2d');
/* the box a note covers, in screen pixels relative to the canvas */
function noteBox(cv, r, n){
  const cr = cropOfCv(cv), px = n.size * r.width / cr.w;
  measureCtx.font = FONT.replace('{px}', px);
  const lines = n.text.split('\n'), [x, y] = toScreen(cv, r, [n.x, n.y]);
  return {x0:x - 6, y0:y - 6, x1:x + Math.max(...lines.map(l => measureCtx.measureText(l).width)) + 6, y1:y + lines.length * px * 1.2 + 6};
}
function noteAt(cv, e){
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  return liveStrokes(V.ink.get(+cv.dataset.pn)).filter(s => s.t === 'text').reverse().find(n => { const b = noteBox(cv, r, n); return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1; });
}
const nearestSize = f => Object.entries(SIZES).sort((a, b) => Math.abs(a[1] - f) - Math.abs(b[1] - f))[0][0];
/* Resolves to {text, size, c}, 'delete', or null. */
function noteDialog(note, color){
  return new Promise(res => {
    const sizeKey = note ? nearestSize(note.size) : (V.textSize || 'medium'), col = note ? note.c : color;
    const m = modal(`<h2>${note ? 'Edit note' : 'New note'}</h2><textarea rows="3" style="min-height:90px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);padding:10px 12px;font:inherit" aria-label="Note text">${esc(note ? note.text : '')}</textarea>
      <div class="btns" style="justify-content:flex-start;flex-wrap:wrap" id="nSizes">${Object.keys(SIZES).map(k => `<button data-size="${k}" aria-pressed="${k === sizeKey}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
      <div class="btns" style="justify-content:flex-start" id="nColors">${PEN_COLORS.map(cc => `<button class="sw" data-color="${cc}" aria-pressed="${cc === col}" aria-label="Colour ${cc}"><i style="background:${cc}"></i></button>`).join('')}</div>
      <div class="btns">${note ? '<button data-del>Delete</button>' : ''}<button data-x>Cancel</button><button class="pri" data-ok>Save</button></div>`);
    let size = sizeKey, c = col; const ta = m.querySelector('textarea'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    const mark = (box, attr, val) => box.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset[attr] === val));
    m.querySelector('#nSizes').onclick = e => { const b = e.target.closest('[data-size]'); if(b){ size = b.dataset.size; mark(m.querySelector('#nSizes'), 'size', size); } };
    m.querySelector('#nColors').onclick = e => { const b = e.target.closest('[data-color]'); if(b){ c = b.dataset.color; mark(m.querySelector('#nColors'), 'color', c); } };
    const done = v => { m.remove(); res(v); };
    m.querySelector('[data-x]').onclick = () => done(null);
    if(note) m.querySelector('[data-del]').onclick = () => done('delete');
    m.querySelector('[data-ok]').onclick = () => { const text = ta.value.replace(/\s+$/, ''); done(text.trim() ? {text, size:SIZES[size], c, sizeKey:size} : (note ? 'delete' : null)); };
  });
}
/* Change one page's strokes as a single undoable step. */
function commit(cv, pn, next){
  const before = (V.ink.get(pn) || []).slice();
  V.ink.set(pn, next); V.hist.push({id:V.id, pn, before}); saveInk(V.id, pn, next); paint(cv, next);
}
async function noteTap(cv, pn, note, pos){
  const color = PEN_COLORS.includes(V.color) ? V.color : PEN_COLORS[0];
  const r = await noteDialog(note, color);
  if(!r) return;
  const arr = V.ink.get(pn) || [], t = Date.now();
  if(note){
    if(r === 'delete') commit(cv, pn, arr.map(s => s.id === note.id ? {id:note.id, deleted:true, updated:t} : s));
    else { V.textSize = r.sizeKey; commit(cv, pn, arr.map(s => s.id === note.id ? {...s, text:r.text, size:r.size, c:r.c, updated:t} : s)); }
  } else {
    V.textSize = r.sizeKey; V.color = r.c;
    commit(cv, pn, arr.concat([{id:uid(), t:'text', x:r4(pos[0]), y:r4(pos[1]), text:r.text, size:r.size, c:r.c, updated:t}]));
  }
}

/* Each handler returns true when the event belonged to drawing. */
export function inkPointerDown(e){
  const cv = e.target.closest('.sheet')?.querySelector('.ink');
  if(cur && isStale(cur)) endCur(true);          // a stuck gesture: save it, then this pen-down starts a new one
  if(V.annot && cv && !cur && (e.pointerType !== 'touch' || V.finger)){
    e.preventDefault();
    try{ stage.setPointerCapture(e.pointerId); }catch(err){}
    const pn = +cv.dataset.pn, pt = ptOn(cv, e);
    if(!pt) return true;
    const arr = (V.ink.get(pn) || []).slice();
    cur = {pid:e.pointerId, t:Date.now(), cv, pn, id:V.id, tool:V.tool, arr, before:arr.slice(), changed:false, s:null};
    if(cur.tool === 'text'){
      const note = noteAt(cv, e);
      Object.assign(cur, {kind:'note', note, pos:pt, x0:e.clientX, y0:e.clientY, moved:false});
    }
    else if(cur.tool === 'erase') eraseAt(e);
    else { cur.s = {id:uid(), updated:Date.now(), t:cur.tool, c:V.color, w:cur.tool === 'hl' ? .02 : .003, p:[pt]}; live(); }
    return true;
  }
  return false;
}
export function inkPointerMove(e){
  if(!cur || e.pointerId !== cur.pid) return;
  cur.t = Date.now();
  if(cur.kind === 'note'){
    if(!cur.note) return;
    if(!cur.moved && Math.hypot(e.clientX - cur.x0, e.clientY - cur.y0) < 8) return;
    const p = ptOn(curCv(cur), e); if(!p) return;
    if(!cur.moved){                   // first move: work on a copy so the undo snapshot keeps the old position
      const copy = {...cur.note};
      cur.arr = cur.arr.map(s => s.id === copy.id ? copy : s); cur.note = copy;
    }
    cur.moved = true;
    const start = cur.pos, n = cur.note;
    n.x = r4(Math.min(1, Math.max(0, n.x + p[0] - start[0]))); n.y = r4(Math.min(1, Math.max(0, n.y + p[1] - start[1]))); cur.pos = p;
    showArr(cur, cur.arr);
    return;
  }
  if(cur.tool === 'erase'){ eraseAt(e); return; }
  if(!cur.s) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e], cv = curCv(cur);
  for(const ev of (evs.length ? evs : [e])){ const p = ptOn(cv, ev); if(p) cur.s.p.push(p); }
  live();
}
function endNote(c, cancelled){
  if(cancelled){ showArr(c, c.before); return; }
  if(c.note && c.moved){            // moved: the note object was edited in place, so save it as one step
    const t = Date.now(), next = c.arr.map(s => s.id === c.note.id ? {...s, updated:t} : s);
    V.hist.push({id:c.id, pn:c.pn, before:c.before}); saveInk(c.id, c.pn, next); showArr(c, next);
  } else if(V.id === c.id && curCv(c).isConnected){   // a tap: the note dialog, only while that page is still shown
    c.cv = curCv(c);
    const orig = c.note && c.before.find(s => s.id === c.note.id);
    noteTap(c.cv, c.pn, orig || null, c.pos);
  }
}
export function inkPointerUp(e){
  if(cur && e.pointerId === cur.pid){
    if(cur.kind === 'note'){ const c = cur; cur = null; endNote(c, false); } else endStroke();
    return true;
  }
  return false;
}
export function inkPointerCancel(e){
  if(cur && e.pointerId === cur.pid){
    if(cur.kind === 'note'){ const c = cur; cur = null; endNote(c, true); } else endStroke();
  }
}

export function setAnnot(on){
  if(!on) inkReset();
  V.annot = on;
  $('#tools').hidden = !on;
  $('#vAnn').setAttribute('aria-pressed', on);
  viewer.classList.toggle('annot', on);
  if(on) viewer.classList.remove('hide');
}
function markTool(){
  for(const b of document.querySelectorAll('#tools [data-tool]'))
    b.setAttribute('aria-pressed', b.dataset.tool === V.tool && (V.tool === 'erase' || V.tool === 'text' || b.dataset.color === V.color));
}
export function initInk(){
  /* Backstop: a pointerup or pointercancel that never reached the stage (it bubbles here after the stage's own
     handler) still ends the gesture, so page turns, refused while inkBusy(), can never stay blocked. */
  addEventListener('pointerup', e => { if(cur && e.pointerId === cur.pid) inkPointerUp(e); });
  addEventListener('pointercancel', e => { if(cur && e.pointerId === cur.pid) inkPointerCancel(e); });
  $('#tools').addEventListener('click', e => {
    const b = e.target.closest('[data-tool]'); if(!b) return;
    if(b.dataset.tool === 'text'){
      if(V.tool === 'text') V.tool = V.prevTool || 'pen'; else { V.prevTool = V.tool; V.tool = 'text'; if(!PEN_COLORS.includes(V.color)) V.color = PEN_COLORS[0]; }
      markTool(); return;
    }
    if(V.tool === 'text' && b.dataset.tool === 'pen'){ V.color = b.dataset.color; markTool(); return; }   // in text mode the pen colours choose the note colour
    V.tool = b.dataset.tool; if(b.dataset.color) V.color = b.dataset.color; markTool();
  });
  /* Undo and Clear wait for the pen: the stroke in progress saves its own snapshot of the page when it ends, which
     would silently put back what they changed. A stale gesture is ended (saved) first. */
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'hidden') inkReset(); });
  $('#tUndo').onclick = () => {
    if(inkBusy()) return;
    inkReset();
    const h = V.hist.pop(); if(!h){ toast('Nothing to undo'); return; }
    if(h.id === V.id){
      const back = reconcile(V.ink.get(h.pn) || [], h.before);
      saveInk(h.id, h.pn, back); V.ink.set(h.pn, back);
      const cv = stage.querySelector(`.ink[data-pn="${h.pn}"]`); if(cv) paint(cv, back); else { V.page = h.pn; draw(); }
    } else {
      /* that song is not open: undo against what is stored now, so strokes added since become deletion markers
         (a raw snapshot would drop them with no marker, and a backup merge would bring them back) */
      getInk(h.id, h.pn).then(stored => saveInk(h.id, h.pn, reconcile(stored, h.before)))
        .catch(err => toast(explainError(err, 'Could not undo that mark. Your music is safe.')));
    }
  };
  $('#tClear').onclick = e => {
    if(inkBusy()) return;
    inkReset();
    if(!armed(e.currentTarget)) return;
    for(const cv of stage.querySelectorAll('.ink')){
      const pn = +cv.dataset.pn, before = V.ink.get(pn) || [];
      if(!liveStrokes(before).length) continue;
      const t = Date.now(), gone = before.map(s => s.deleted ? s : {id:s.id, deleted:true, updated:t});
      V.hist.push({id:V.id, pn, before:before.slice()}); V.ink.set(pn, gone); saveInk(V.id, pn, gone); paint(cv, gone);
    }
  };
  $('#tFinger').onclick = () => { V.finger = !V.finger; $('#tFinger').setAttribute('aria-pressed', V.finger); toast(V.finger ? 'Fingers draw; use the arrows to turn pages' : 'Only the stylus draws'); };
  $('#tDone').onclick = () => setAnnot(false);
  $('#vAnn').onclick = () => setAnnot(!V.annot);
  markTool();
}

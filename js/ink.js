/* Pen, highlighter and eraser. Strokes are stored apart from the PDF as fractions of the full page. */
import {$, toast, armed, uid} from './util.js';
import {putInk, reconcile, liveStrokes} from './store.js';
import {V, stage, viewer, draw} from './viewer.js';

export function paint(cv, strokes){
  const c = cv.getContext('2d'), w = cv.width, h = cv.height;
  c.clearRect(0, 0, w, h);
  for(const s of strokes){
    if(s.deleted) continue;
    c.save(); c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = s.c; c.lineWidth = s.w * w;
    if(s.t === 'hl'){ c.globalAlpha = .4; c.lineCap = 'butt'; }
    c.beginPath();
    s.p.forEach((p, i) => i ? c.lineTo(p[0] * w, p[1] * h) : c.moveTo(p[0] * w, p[1] * h));
    if(s.p.length === 1) c.lineTo(s.p[0][0] * w + .5, s.p[0][1] * h);
    c.stroke(); c.restore();
  }
}
const r4 = n => Math.round(n * 1e4) / 1e4;
function tidy(s){
  const p = [];
  for(const pt of s.p){ const l = p[p.length - 1]; if(!l || Math.hypot(pt[0] - l[0], pt[1] - l[1]) > .0015) p.push([r4(pt[0]), r4(pt[1])]); }
  return {...s, p};
}
function saveInk(id, pn, strokes){ putInk(id, pn, strokes).catch(() => toast('Could not save that mark')); }
function ptOn(cv, e){ const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; }

let cur = null, raf = 0;
function live(){
  if(raf) return;
  raf = requestAnimationFrame(() => { raf = 0; if(cur && cur.s) paint(cur.cv, (V.ink.get(cur.pn) || []).concat([cur.s])); });
}
function eraseAt(e){
  const r = cur.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const arr = V.ink.get(cur.pn) || [];
  const hit = s => !s.deleted && s.p.some(p => Math.hypot(p[0] * r.width - x, p[1] * r.height - y) < 14 + s.w * r.width / 2);
  if(arr.some(hit)){
    const t = Date.now(), keep = arr.map(s => hit(s) ? {id:s.id, deleted:true, updated:t} : s);
    V.ink.set(cur.pn, keep); cur.changed = true; paint(cur.cv, keep);
  }
}
function endStroke(){
  const c = cur; cur = null;
  if(c.s && c.s.p.length){ V.ink.set(c.pn, (V.ink.get(c.pn) || []).concat([tidy(c.s)])); c.changed = true; }
  if(c.changed){ V.hist.push({id:c.id, pn:c.pn, before:c.before}); saveInk(c.id, c.pn, V.ink.get(c.pn)); }
  paint(c.cv, V.ink.get(c.pn) || []);
}

/* Each handler returns true when the event belonged to drawing. */
export function inkPointerDown(e){
  const cv = e.target.closest('.sheet')?.querySelector('.ink');
  if(V.annot && cv && !cur && (e.pointerType !== 'touch' || V.finger)){
    e.preventDefault();
    try{ stage.setPointerCapture(e.pointerId); }catch(err){}
    const pn = +cv.dataset.pn;
    cur = {pid:e.pointerId, cv, pn, id:V.id, before:(V.ink.get(pn) || []).slice(), changed:false, s:null};
    if(V.tool === 'erase') eraseAt(e);
    else { cur.s = {id:uid(), updated:Date.now(), t:V.tool, c:V.color, w:V.tool === 'hl' ? .02 : .003, p:[ptOn(cv, e)]}; live(); }
    return true;
  }
  return false;
}
export function inkPointerMove(e){
  if(!cur || e.pointerId !== cur.pid) return;
  if(V.tool === 'erase'){ eraseAt(e); return; }
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for(const ev of (evs.length ? evs : [e])) cur.s.p.push(ptOn(cur.cv, ev));
  live();
}
export function inkPointerUp(e){
  if(cur && e.pointerId === cur.pid){ endStroke(); return true; }
  return false;
}
export function inkPointerCancel(e){
  if(cur && e.pointerId === cur.pid) endStroke();
}

export function setAnnot(on){
  V.annot = on;
  $('#tools').hidden = !on;
  $('#vAnn').setAttribute('aria-pressed', on);
  viewer.classList.toggle('annot', on);
  if(on) viewer.classList.remove('hide');
}
function markTool(){
  for(const b of document.querySelectorAll('#tools [data-tool]'))
    b.setAttribute('aria-pressed', b.dataset.tool === V.tool && (V.tool === 'erase' || b.dataset.color === V.color));
}
export function initInk(){
  $('#tools').addEventListener('click', e => {
    const b = e.target.closest('[data-tool]'); if(!b) return;
    V.tool = b.dataset.tool; if(b.dataset.color) V.color = b.dataset.color; markTool();
  });
  $('#tUndo').onclick = () => {
    const h = V.hist.pop(); if(!h){ toast('Nothing to undo'); return; }
    if(h.id === V.id){
      const back = reconcile(V.ink.get(h.pn) || [], h.before);
      saveInk(h.id, h.pn, back); V.ink.set(h.pn, back);
      const cv = stage.querySelector(`.ink[data-pn="${h.pn}"]`); if(cv) paint(cv, back); else { V.page = h.pn; draw(); }
    } else saveInk(h.id, h.pn, h.before);
  };
  $('#tClear').onclick = e => {
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

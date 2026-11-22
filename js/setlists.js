import {$, esc, uid, ask, pick, armed, hooks, toast, form} from './util.js';
import {load, state, songById, saveSet, markDeleted, liveItems} from './store.js';
import {openViewer} from './viewer.js';
import {printDialog} from './print.js';
import {shareSet} from './share.js';
import {renderNudge} from './nudge.js';
import {pickerHtml, shownColl, joinColls, inShown, collOptions, applyTicks} from './collections.js';

export let openSet = null;
export const closeSet = () => { openSet = null; };

const HANDLE = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>';
const MOVE_LABEL = 'Drag to reorder, or press the up and down arrow keys';
const songCount = st => liveItems(st).filter(it => it.type === 'song').length;
/* The viewer plays a list of {type:'song', id} and {type:'break', name} entries. */
const entriesOf = st => liveItems(st).map(it => it.type === 'break' ? {type:'break', id:it.id, name:it.name} : {type:'song', id:it.id});

export function renderSetlists(v){
  const {sets} = state;
  if(openSet){
    const st = sets.find(s => s.id === openSet);
    if(!st){ openSet = null; return renderSetlists(v); }
    const items = liveItems(st), n = songCount(st);
    let k = 0;
    v.innerHTML = `<div class="bar"><button data-allsets>&#8249; Setlists</button><h2>${esc(st.name)}</h2></div><div id="libNudge"></div>
      <div class="bar"><button class="pri" data-play="${esc(st.id)}" ${n ? '' : 'disabled'}>Play setlist</button><button data-addto>Add songs</button><button data-addbreak>Add break</button><button data-print ${n ? '' : 'disabled'}>Print PDF</button><button data-shareset ${n ? '' : 'disabled'}>Share</button><button data-dup>Duplicate</button><button data-renset>Rename</button>${state.colls.length ? '<button data-setcolls>Collections</button>' : ''}</div>
      ${items.length ? `<ul class="list" id="items">${items.map((it, i) => {
        if(it.type === 'break') return `<li class="row brk"><button class="handle" aria-label="${MOVE_LABEL}">${HANDLE}</button><span class="num"></span><button class="main" data-renbreak="${esc(i)}"><span class="t">${esc(it.name)}<span class="tag">Break</span></span><span class="s">Tap to rename</span></button><div class="acts"><button data-rm="${esc(i)}">Remove</button></div></li>`;
        const s = songById(it.id); k++;
        return `<li class="row"><button class="handle" aria-label="${MOVE_LABEL}">${HANDLE}</button><span class="num">${esc(k)}</span><button class="main" data-playat="${esc(i)}"><span class="t">${esc(s.title)}${s.archived ? '<span class="tag">Archived</span>' : ''}</span><span class="s">${esc(s.pages)} page${s.pages == 1 ? '' : 's'}</span></button><div class="acts"><button data-rm="${esc(i)}">Remove</button></div></li>`;
      }).join('')}</ul>`
      : `<div class="empty"><h2>Empty setlist</h2><p>Tap Add songs to pick charts from your library.</p></div>`}`;
  } else {
    const shownSets = sets.filter(inShown), coll = shownColl();
    v.innerHTML = pickerHtml() + `<div class="bar"><button class="pri" data-newset>New setlist</button></div><div id="libNudge"></div>` +
      (shownSets.length ? `<ul class="list">${shownSets.map(st => { const n = songCount(st); const id = esc(st.id); return `<li class="row"><button class="main" data-set="${id}"><span class="t">${esc(st.name)}</span><span class="s">${esc(n)} song${n == 1 ? '' : 's'}</span></button><div class="acts"><button data-play="${id}" ${n ? '' : 'disabled'}>Play</button><button data-dupset="${id}">Duplicate</button><button data-delset="${id}">Delete</button></div></li>`; }).join('')}</ul>`
      : coll ? `<div class="empty"><h2>No setlists in ${esc(coll.name)} yet</h2><p>A new setlist joins ${esc(coll.name)} while it is shown.</p></div>`
      : `<div class="empty"><h2>No setlists yet</h2><p>Make one for each gig or rehearsal.</p></div>`);
  }
  renderNudge();                       // the backup reminder, under the bar (js/nudge.js)
}

async function duplicate(st){
  const copy = {id:uid(), name:st.name + ' copy', created:Date.now(), colls:[...(st.colls || [])], items:liveItems(st).map(it => it.type === 'break' ? {...it, id:uid()} : {...it})};
  await saveSet(copy); await load(); openSet = copy.id; hooks.render();
}

/* Returns true when the click was for setlists. */
export async function onClick(b, d){
  const {sets, songs} = state;
  if('newset' in d){
    const n = await ask('New setlist', '');
    if(n){ const st = {id:uid(), name:n, items:[], colls:joinColls(), created:Date.now()}; await saveSet(st); await load(); openSet = st.id; hooks.render(); }
    return true;
  }
  if(d.set){ openSet = d.set; hooks.render(); return true; }
  if('allsets' in d){ openSet = null; hooks.render(); return true; }
  if(d.dupset){ await duplicate(sets.find(s => s.id === d.dupset)); return true; }
  if(d.delset){ if(!armed(b)) return true; await markDeleted('sets', d.delset); await load(); hooks.render(); return true; }
  if(d.play){ const st = sets.find(s => s.id === d.play); openViewer(entriesOf(st), 0); return true; }
  const st = sets.find(s => s.id === openSet);
  if(!st) return false;
  const items = liveItems(st);
  const save = async () => { st.items = items; await saveSet(st); await load(); hooks.render(); };
  if(d.playat){ openViewer(entriesOf(st), +d.playat); return true; }
  if('shareset' in d){ await shareSet(st); return true; }
  if('print' in d){ printDialog(st, items.filter(it => it.type === 'song').map(it => it.id)); return true; }
  if('dup' in d){ await duplicate(st); return true; }
  if('addto' in d){
    /* With a collection shown the list holds its songs, and "Show all songs" reaches the rest. */
    const open = songs.filter(s => !s.archived), c = shownColl();
    const add = await pick(c ? open.filter(inShown) : open, c ? {all:open, ordered:true} : {ordered:true});
    if(add.length){ items.push(...add.map(id => ({type:'song', id}))); await save(); }
    return true;
  }
  if('setcolls' in d){
    const r = await form('Collections of ' + st.name, [], {label:'Collections', options:collOptions(st)});
    if(r){ st.colls = applyTicks(st, r.checks); await saveSet(st); await load(); hooks.render(); }
    return true;
  }
  if('addbreak' in d){ items.push({type:'break', id:uid(), name:'Break'}); await save(); return true; }
  if(d.renbreak){ const it = items[+d.renbreak]; const n = await ask('Rename break', it.name); if(n){ it.name = n; await save(); } return true; }
  if('renset' in d){ const n = await ask('Rename setlist', st.name); if(n){ st.name = n; await save(); } return true; }
  if(d.rm){ items.splice(+d.rm, 1); await save(); return true; }
  return false;
}

/* ---------- drag and drop: the handle on the left of each row ----------
   Pointer events, so a finger, a stylus and a mouse all work. While dragging, rows only move with CSS transforms
   (no layout work per move), and the list scrolls when the pointer is near the top or bottom edge. */
let drag = null;
function placeRows(d){
  const hf = d.rects[d.from].h;
  d.rows.forEach((r, i) => {
    if(i === d.from) return;
    const shift = i > d.from ? (i <= d.to ? -hf : 0) : (i >= d.to ? hf : 0);
    r.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}
function moveDrag(){
  const d = drag, dy = d.cy - d.y0 + (scrollY - d.sy);
  d.li.style.transform = `translateY(${dy}px)`;
  const center = d.rects[d.from].top + d.rects[d.from].h / 2 + dy;
  let to = 0;
  d.rects.forEach((r, i) => { if(i !== d.from && r.top + r.h / 2 < center) to++; });
  if(to !== d.to){ d.to = to; placeRows(d); }
}
/* The list re-rendered under a drag (a save, a tab switch): that drag is over. Its rows are gone, so it must not
   keep its animation frame running, block the next drag or keyboard move, or save indexes of a list that changed. */
function dropStaleDrag(){
  if(drag && !drag.li.isConnected){ cancelAnimationFrame(drag.raf); drag = null; }
  return !drag;
}
function tick(){
  if(dropStaleDrag()) return;
  const y = drag.cy, edge = 90; let v = 0;
  if(y < edge) v = -Math.ceil((edge - y) / 5); else if(y > innerHeight - edge) v = Math.ceil((y - (innerHeight - edge)) / 5);
  if(v){ scrollBy(0, v); moveDrag(); }
  drag.raf = requestAnimationFrame(tick);
}
async function endDrag(e){
  dropStaleDrag();
  const d = drag; if(!d || e.pointerId !== d.pid) return;
  drag = null; cancelAnimationFrame(d.raf);
  const {from, to} = d;
  if(e.type === 'pointercancel' || from === to){ hooks.render(); return; }
  await moveItem(from, to);
}
/* The one save path for a reorder (drag or keyboard): row `from` goes to place `to`. False when no set is open. */
async function moveItem(from, to){
  const st = state.sets.find(s => s.id === openSet); if(!st){ hooks.render(); return false; }
  const items = liveItems(st), [m] = items.splice(from, 1); items.splice(to, 0, m);
  st.items = items; await saveSet(st); await load(); hooks.render();
  return true;
}

/* ---------- keyboard: with a handle focused, ArrowUp / ArrowDown move that row one place ----------
   Moves run one after another (a held key repeats), each from wherever the focused handle is by then. */
let keyChain = Promise.resolve();
async function keyMove(dir){
  const h = document.activeElement;
  if(!h || !h.classList.contains('handle') || !dropStaleDrag()) return;
  const li = h.closest('li.row'), rows = li ? [...li.parentElement.children] : [];
  const from = rows.indexOf(li), to = from + dir;
  if(from < 0 || to < 0 || to >= rows.length) return;
  if(!await moveItem(from, to)) return;
  const nh = document.querySelector(`#items > li.row:nth-child(${to + 1}) .handle`);
  if(nh) nh.focus();
  toast(`Moved to position ${to + 1} of ${rows.length}`);
}
export function initSetlists(){
  const view = $('#view');
  view.addEventListener('keydown', e => {
    if(!e.target.closest('#items .handle') || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    keyChain = keyChain.then(() => keyMove(dir)).catch(() => {});
  });
  view.addEventListener('pointerdown', e => {
    const h = e.target.closest('.handle'); if(!h || !dropStaleDrag()) return;
    const li = h.closest('li.row'), ul = li.parentElement, rows = [...ul.children], sy = scrollY;
    e.preventDefault();
    drag = {pid:e.pointerId, li, rows, from:rows.indexOf(li), to:rows.indexOf(li), y0:e.clientY, cy:e.clientY, sy, raf:0,
      rects:rows.map(r => { const b = r.getBoundingClientRect(); return {top:b.top + sy, h:b.height}; })};
    try{ h.setPointerCapture(e.pointerId); }catch(err){}
    li.classList.add('dragging'); ul.classList.add('sorting');
    tick();
  });
  view.addEventListener('pointermove', e => { if(!dropStaleDrag() && e.pointerId === drag.pid){ drag.cy = e.clientY; moveDrag(); } });
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);
}

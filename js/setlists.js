import {$, esc, uid, ask, pick, hooks, toast, form, modal} from './util.js';
import {state, songById, saveSet, markDeleted, liveItems} from './store.js';
import {openViewer} from './viewer.js';
import {printDialog} from './print.js';
import {downloadAll} from './downloadall.js';
import {shareSet} from './share.js';
import {renderNudge} from './nudge.js';
import {showPicked, pickerHtml, shownColl, joinColls, inShown, collOptions, applyTicks} from './collections.js';
import {gigOf, gigLong, gigShort, groupSets, isOpen, toggleGroup} from './gigdate.js';
import {gigDialog, newSetDialog, offerFill} from './gigui.js';
import {menuBox} from './menubox.js';
import {chooseTextFile} from './setlisttext.js';
import {commit, once} from './saving.js';

export let openSet = null;
export const closeSet = () => { openSet = null; };
export const showSet = id => { openSet = id; };          // a setlist made elsewhere (js/setlisttext.js) opens on the Setlists tab

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
    v.innerHTML = `<div class="bar"><button data-allsets>&#8249; Setlists</button><h2>${esc(st.name)}</h2></div>${gigOf(st) ? `<p class="gigline">${esc(gigLong(gigOf(st)))}</p>` : ''}<div id="libNudge"></div>
      <div class="bar"><button class="pri" data-play="${esc(st.id)}" ${n ? '' : 'disabled'}>Play setlist</button><button data-addto>Add songs</button><button data-addbreak>Add break</button><button data-setmenu>More</button></div>
      ${items.length ? `<ul class="list" id="items">${items.map((it, i) => {
        if(it.type === 'break') return `<li class="row brk"><button class="handle" aria-label="${MOVE_LABEL}">${HANDLE}</button><span class="num"></span><button class="main" data-renbreak="${esc(i)}"><span class="t">${esc(it.name)}<span class="tag">Break</span></span><span class="s">Tap to rename</span></button><div class="acts"><button data-rm="${esc(i)}">Remove</button></div></li>`;
        const s = songById(it.id); k++;
        return `<li class="row"><button class="handle" aria-label="${MOVE_LABEL}">${HANDLE}</button><span class="num">${esc(k)}</span><button class="main" data-playat="${esc(i)}"><span class="t">${esc(s.title)}${s.archived ? '<span class="tag">Archived</span>' : ''}</span><span class="s">${esc(s.pages)} page${s.pages == 1 ? '' : 's'}</span></button><div class="acts"><button data-rm="${esc(i)}">Remove</button></div></li>`;
      }).join('')}</ul>`
      : `<div class="empty"><h2>Empty setlist</h2><p>Tap Add songs to pick charts from your library.</p></div>`}`;
  } else {
    const shownSets = sets.filter(inShown), coll = shownColl();
    v.innerHTML = pickerHtml() + `<div class="bar"><button class="pri" data-newset>New setlist</button><button data-importtext>Import from a text file</button><button data-dlall ${shownSets.some(st => songCount(st)) ? '' : 'disabled'}>Download all</button></div><div id="libNudge"></div>` +
      (shownSets.length ? listHtml(shownSets)
      : coll ? `<div class="empty"><h2>No setlists in ${esc(coll.name)} yet</h2><p>A new setlist joins ${esc(coll.name)} while it is shown.</p></div>`
      : `<div class="empty"><h2>No setlists yet</h2><p>Make one for each gig or rehearsal.</p></div>`);
  }
  showPicked();
  renderNudge();                       // the backup reminder, under the bar (js/nudge.js)
  if(!openSet) offerFill();            // once per tablet: gig dates found in setlist names (js/gigui.js)
}

/* A row's two buttons (Jonathan, 2026-11-23): Play, and one \u22ef that holds Duplicate and Delete, like a song row; the name gets the room. */
const cut = t => t.length > 40 ? t.slice(0, 40) + '\u2026' : t;
const rowHtml = st => {
  const n = songCount(st), id = esc(st.id), g = gigOf(st);
  return `<li class="row"><button class="main" data-set="${id}"><span class="t">${esc(st.name)}</span><span class="s">${g ? esc(gigShort(g)) + ' &middot; ' : ''}${esc(n)} song${n == 1 ? '' : 's'}</span></button><div class="acts"><button data-play="${id}" ${n ? '' : 'disabled'}>Play</button><button class="rowmore" data-setrowmenu="${id}" aria-label="Actions for ${esc(st.name)}" aria-haspopup="dialog">\u22ef</button></div></li>`;
};
const SET_ROW_ITEMS = [{id: 'dup', label: 'Duplicate', hint: 'Make a copy of this setlist'}, {id: 'del', label: 'Delete', hint: 'Remove this setlist (its songs stay in your library)'}];
/* Delete is the menu item and then this question (the two taps the "Never" list asks for). Cancel changes nothing. */
function askDeleteSet(st){
  return new Promise(res => {
    const m = modal(`<h2>Delete ${esc(cut(st.name))}?</h2><p>Its songs stay in your library.</p><div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Delete</button></div>`);
    m.classList.add('delask');
    const ok = m.querySelector('[data-ok]'); ok.disabled = true; setTimeout(() => { ok.disabled = false; }, 400);      // a quick double tap on the menu's Delete must not land on this one
    m.querySelector('[data-x]').onclick = () => { m.remove(); res(false); };
    ok.onclick = () => { m.remove(); res(true); };
  });
}
/* The list of setlists: grouped by gig date when any has one (js/gigdate.js groupSets), else flat as it always was. */
let groups = [];
function listHtml(sets){
  groups = groupSets(sets) || [];
  if(!groups.length) return `<ul class="list">${sets.map(rowHtml).join('')}</ul>`;
  return groups.map(g => {
    const open = isOpen(g);
    return `<h3 class="grp"><button data-grp="${esc(g.id)}" aria-expanded="${open}"><span class="chev" aria-hidden="true">${open ? '&#9662;' : '&#9656;'}</span>${esc(g.label)}${open ? '' : ' (' + g.sets.length + ')'}</button></h3>${open ? `<ul class="list">${g.sets.map(rowHtml).join('')}</ul>` : ''}`;
  }).join('');
}

/* The open setlist's More menu (Jonathan, 2026-11-22: the bar was crowded). Every item does what its own button did. */
const setMenuItems = (st, n) => [
  {id: 'gig', label: 'Gig date', hint: gigOf(st) ? `${gigLong(gigOf(st))} (tap to change)` : 'Set or change the date of this gig'},
  {id: 'print', label: 'Download PDF', hint: 'Save the songs as one PDF', disabled: !n},
  {id: 'share', label: 'Share', hint: 'Send this setlist and its songs as one file', disabled: !n},
  {id: 'dup', label: 'Duplicate', hint: 'Make a copy of this setlist'},
  {id: 'rename', label: 'Rename', hint: 'Change the name'},
  ...(state.colls.length ? [{id: 'colls', label: 'Collections', hint: 'Choose which collections it is in'}] : []),
];

async function duplicate(st){
  const copy = {id:uid(), name:st.name + ' copy', created:Date.now(), colls:[...(st.colls || [])], items:liveItems(st).map(it => it.type === 'break' ? {...it, id:uid()} : {...it})};
  await once('dup', () => commit(async () => { await saveSet(copy); openSet = copy.id; }, 'Could not make the copy. Nothing was changed.'));     // openSet only once the copy is stored
}
/* An edit of the open setlist's items: a COPY of the record is saved, the screen is drawn again from storage (js/saving.js). */
const saveItems = (st, next) => commit(() => saveSet({...st, items:next}), 'Could not save the setlist. Nothing was changed.');

const menuTitle = st => st.name.length > 40 ? st.name.slice(0, 40) + '\u2026' : st.name;
async function changeGig(st){
  const r = await gigDialog('Gig date of ' + st.name, st.gig);
  if(r && (r.gig || undefined) !== st.gig){
    const next = {...st}; if(r.gig) next.gig = r.gig; else delete next.gig;
    await commit(() => saveSet(next), 'Could not save the gig date. Nothing was changed.');
  }
}
async function renameSet(st){ const n = await ask('Rename setlist', st.name); if(n) await commit(() => saveSet({...st, name:n}), 'Could not rename the setlist. Nothing was changed.'); }
async function setColls(st){
  const r = await form('Collections of ' + st.name, [], {label:'Collections', options:collOptions(st)});
  if(r) await commit(() => saveSet({...st, colls:applyTicks(st, r.checks)}), 'Could not save the collections. Nothing was changed.');
}

/* Returns true when the click was for setlists. */
export async function onClick(b, d){
  const {sets, songs} = state;
  if('newset' in d){
    const r = await newSetDialog();
    if(r){
      const st = {id:uid(), name:r.name, items:[], colls:joinColls(), created:Date.now()}; if(r.gig) st.gig = r.gig;
      await once('newset', () => commit(async () => { await saveSet(st); openSet = st.id; }, 'Could not make the setlist. Nothing was changed.'));
    }
    return true;
  }
  if('importtext' in d){ chooseTextFile(); return true; }        // the file chooser opens in the tap; js/setlisttext.js does the rest
  if(d.grp){ const g = groups.find(x => x.id === d.grp); if(g){ toggleGroup(g); hooks.render(); const h = document.querySelector(`[data-grp="${CSS.escape(g.id)}"]`); if(h) h.focus(); } return true; }
  if('dlall' in d){ downloadAll(sets.filter(inShown), shownColl()); return true; }
  if(d.set){ openSet = d.set; hooks.render(); return true; }
  if('allsets' in d){ openSet = null; hooks.render(); return true; }
  if(d.setrowmenu){
    const st = sets.find(x => x.id === d.setrowmenu); if(!st) return true;
    b.focus();                                                  // Safari does not focus a button that was tapped
    let del = false;
    await menuBox({title: cut(st.name), items: SET_ROW_ITEMS, opener: b, run: id => { if(id === 'dup') return duplicate(st); del = true; }});
    if(del){
      if(await askDeleteSet(st)) await once('delset', () => commit(() => markDeleted('sets', st.id), 'Could not delete the setlist. Nothing was changed.'));
      else if(b.isConnected) b.focus();
    }
    return true;
  }
  if(d.play){ const st = sets.find(s => s.id === d.play); openViewer(entriesOf(st), 0); return true; }
  const st = sets.find(s => s.id === openSet);
  if(!st) return false;
  const items = liveItems(st);
  if(d.playat){ openViewer(entriesOf(st), +d.playat); return true; }
  if('addto' in d){
    /* With a collection shown the list holds its songs, and "Show all songs" reaches the rest. */
    const open = songs.filter(s => !s.archived), c = shownColl();
    const add = await pick(c ? open.filter(inShown) : open, c ? {all:open, ordered:true} : {ordered:true});
    if(add.length) await saveItems(st, [...items, ...add.map(id => ({type:'song', id}))]);
    return true;
  }
  if('setmenu' in d){
    b.focus();                                                  // Safari does not focus a button that was tapped: the box and the dialogs after it give focus back to it
    await menuBox({title: menuTitle(st), items: setMenuItems(st, songCount(st)), opener: b, run: id => {
      if(id === 'gig') return changeGig(st);
      if(id === 'print') return printDialog(st, items.filter(it => it.type === 'song').map(it => it.id));
      if(id === 'share') return shareSet(st);
      if(id === 'dup') return duplicate(st);
      if(id === 'rename') return renameSet(st);
      if(id === 'colls') return setColls(st);
    }});
    /* The screen is drawn again after Duplicate, Rename and a saved date or collections: the button that opened the menu is gone. */
    if(!document.querySelector('.modal') && (!document.activeElement || document.activeElement === document.body)){
      const mb = document.querySelector('#view [data-setmenu]'); if(mb) mb.focus();
    }
    return true;
  }
  if('addbreak' in d){ await once('addbreak', () => saveItems(st, [...items, {type:'break', id:uid(), name:'Break'}])); return true; }
  if(d.renbreak){
    const k = +d.renbreak, it = items[k]; if(!it) return true;
    const n = await ask('Rename break', it.name);
    if(n) await saveItems(st, items.map((x, i) => i === k ? {...x, name:n} : x));
    return true;
  }
  if(d.rm){ await once('remove', () => saveItems(st, items.filter((_, i) => i !== +d.rm))); return true; }
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
/* The one save path for a reorder (drag or keyboard): row `from` goes to place `to`. False when no set is open or the save was refused. */
async function moveItem(from, to){
  /* Under once(), with a key that never repeats: a Remove or Add break tapped while this save is still running is ignored (it would be
     built from the list as it was before the move and write over it), and a move is never held back by the 400 ms rule. */
  const ok = await once('move' + (++moves), () => {
    const st = state.sets.find(s => s.id === openSet); if(!st) return false;
    const items = [...liveItems(st)], [m] = items.splice(from, 1); items.splice(to, 0, m);
    return saveItems(st, items);        // a refused save draws the list again from storage: no row keeps a transform, nothing shows an order that was not saved
  });
  if(!ok) hooks.render();               // another save was still running, or no set is open: the rows go back where storage has them
  return ok;
}
let moves = 0;

/* ---------- keyboard: with a handle focused, ArrowUp / ArrowDown move that row one place ----------
   Moves run one after another (a held key repeats), each from wherever the focused handle is by then. */
let keyChain = Promise.resolve();
async function keyMove(dir){
  const h = document.activeElement;
  if(!h || !h.classList.contains('handle') || !dropStaleDrag()) return;
  const li = h.closest('li.row'), rows = li ? [...li.parentElement.children] : [];
  const from = rows.indexOf(li), to = from + dir;
  if(from < 0 || to < 0 || to >= rows.length) return;
  if(!await moveItem(from, to)){ const oh = document.querySelector(`#items > li.row:nth-child(${from + 1}) .handle`); if(oh) oh.focus(); return; }      // the list was drawn again: keep the focus on the row
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

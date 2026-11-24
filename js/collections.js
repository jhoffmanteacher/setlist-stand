import {deleteOps} from './deleteops.js';
import {esc, uid, modal, armed, toast, hooks, pick} from './util.js';
import {state, putAll, load, stamp} from './store.js';
import {explainError} from './errors.js';

/* Collections: the band (or group) a song or setlist is played with. Jonathan names each one and can rename it; one song or
   setlist can be in several; one collection can be the DEFAULT.
   - A collection is {id, name, created, updated} in the `colls` store. Songs and setlists list theirs in `colls` (ids).
     Deleting one leaves {id, deleted:true, updated} and takes its id out of every song and setlist in the SAME putAll, each of
     those records getting a new `updated` (a later sync carries a change only when `updated` moves). Songs, PDFs, marks and
     setlists are never deleted by it. Records are changed by spreading the existing one, so a field this code does not know
     is kept.
   - The default is a setting of THIS tablet (localStorage `ss-default-coll`): never in the library, a backup or a sync.
   - The collection being shown is in memory only. The app opens on the default (or on All). One picker under the tabs
     serves both tabs.
   This file holds the picker, the manager dialog and the helpers the other screens use. */

const DEFAULT_KEY = 'ss-default-coll';
export const MAX_NAME = 200;
let shown = null;                          // a collection id, or null for All

const liveIds = () => new Set(state.colls.map(c => c.id));
export function getDefault(){
  let id = null;
  try{ id = localStorage.getItem(DEFAULT_KEY); }catch(e){}
  return id && liveIds().has(id) ? id : null;       // a default that points at a deleted collection counts as none
}
function setDefault(id){
  try{ if(id) localStorage.setItem(DEFAULT_KEY, id); else localStorage.removeItem(DEFAULT_KEY); }catch(e){}
}
/* On start (and after a restore): show the default collection, or All. */
export function initShown(){ shown = getDefault(); }
/* The collection being shown (its record), or null for All. One that has been deleted since counts as All. */
export function shownColl(){
  const c = shown && state.colls.find(x => x.id === shown);
  if(!c) shown = null;
  return c || null;
}
/* The collection ids a new song or setlist joins: the one being shown, or the default when All is shown, or none. */
export function joinColls(){
  const c = shownColl();
  if(c) return [c.id];
  const d = getDefault();
  return d ? [d] : [];
}
/* True when the record belongs in what is being shown. */
export function inShown(rec){
  const c = shownColl();
  return !c || (Array.isArray(rec.colls) && rec.colls.includes(c.id));
}
/* The options of a "Collections" tick-box group (util.js form) for a song or setlist, and the list of ids to save back:
   the ticked ones plus any id this tablet does not know yet (another tablet's collection that has not arrived). */
export const collOptions = rec => state.colls.map(c => ({value:c.id, label:c.name, on:Array.isArray(rec.colls) && rec.colls.includes(c.id)}));
export function applyTicks(rec, ticked){
  const live = liveIds();
  return [...new Set([...(rec.colls || []).filter(id => !live.has(id)), ...ticked])];
}

/* ---------- the picker under the Library / Setlists tabs ---------- */
export function pickerHtml(){
  const manage = '<button data-collmanage>Collections</button>';
  if(!state.colls.length) return `<div class="collbar">${manage}</div>`;
  const def = getDefault(), cur = shownColl();
  const one = (id, label, on) => `<button data-collpick="${esc(id)}" aria-pressed="${on}">${label}</button>`;
  /* .collchips only matters on a narrow window (CSS): there the chips scroll sideways and the Collections button stays on screen beside them. */
  return `<div class="collbar" role="group" aria-label="Collection"><div class="collchips">${one('all', 'All', !cur)}${state.colls.map(c => one(c.id, esc(c.name) + (c.id === def ? ' (default)' : ''), !!cur && cur.id === c.id)).join('')}</div>${manage}</div>`;
}

/* The picker scrolls sideways on a narrow window: the collection shown is brought into view (the page itself is never scrolled). */
export function showPicked(){
  const bar = document.querySelector('.collchips'), on = bar && bar.querySelector('[aria-pressed=true]');
  if(on && bar.scrollWidth > bar.clientWidth) bar.scrollLeft = Math.max(0, on.offsetLeft - (bar.clientWidth - on.offsetWidth) / 2);
}

/* ---------- names ---------- */
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
/* A text dialog for a collection's name: required, trimmed, at most 200 characters, and not the name of another collection
   (case ignored). The dialog stays open with a one-line message until the name is fine. Resolves to the name or null. */
function askName(title, value, exceptId){
  return new Promise(res => {
    const m = modal(`<h2>${esc(title)}</h2><label class="fld"><span>Name</span><input type="text" maxlength="${MAX_NAME}" value="${esc(value)}"></label>
      <p class="hint warnline" role="alert" data-err hidden></p><div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Save</button></div>`);
    m.classList.add('collname');
    const inp = m.querySelector('input'), err = m.querySelector('[data-err]');
    inp.focus(); inp.select();
    const problem = v => !v ? 'Type a name.' : v.length > MAX_NAME ? `Use ${MAX_NAME} characters or fewer.` : state.colls.some(c => c.id !== exceptId && same(c.name, v)) ? 'There is already a collection with that name.' : '';
    const done = v => { m.remove(); res(v); };
    const save = () => { const v = inp.value.trim(), p = problem(v); err.hidden = !p; err.textContent = p; if(!p) done(v); };
    inp.oninput = () => { err.hidden = true; };
    m.querySelector('[data-x]').onclick = () => done(null);
    m.querySelector('[data-ok]').onclick = save;
    m.onkeydown = e => { if(e.key === 'Enter' && e.target === inp){ e.preventDefault(); save(); } };
  });
}

/* ---------- actions (each is ONE putAll) ---------- */
async function write(ops, failMsg){
  try{ await putAll(ops); }
  catch(err){ toast(explainError(err, failMsg)); }
  await load(); hooks.render();
}
async function newColl(){
  const name = await askName('New collection', '');
  if(!name) return;
  const t = Date.now(), c = {id:uid(), name, created:t, updated:t};
  await write([{store:'colls', key:c.id, value:c}], 'Could not save the collection. Nothing was changed.');
}
async function renameColl(id){
  const c = state.colls.find(x => x.id === id); if(!c) return;
  const name = await askName('Rename collection', c.name, id);
  if(!name || name === c.name) return;
  await write([{store:'colls', key:id, value:{...c, name, updated:stamp(c)}}], 'Could not save the new name. Nothing was changed.');
}
/* Deleting a collection removes its id from every song and setlist that holds it (each gets a new `updated`) in the same
   write as the collection's own deletion marker. Nothing else is touched. Every record is stamped over its own last `updated`
   (stamp in js/store.js). */
async function deleteColl(id){
  const ops = await deleteOps('coll', id);       // the marker, and the collection id taken off every song and setlist that had it (js/deleteops.js, shared with sync)
  try{ await putAll(ops); }
  catch(err){ toast(explainError(err, 'Could not delete the collection. Nothing was changed.')); return false; }
  if(getDefault() === id) setDefault(null);
  if(shown === id) shown = null;
  await load(); hooks.render();
  return true;
}
/* A list of the library's songs that are not in the collection yet, to tick into it. */
export async function addSongsTo(id){
  const c = state.colls.find(x => x.id === id); if(!c) return;
  const rest = state.songs.filter(s => !(s.colls || []).includes(id));
  if(!rest.length){ toast(state.songs.length ? `Every song is already in ${c.name}.` : 'Your library is empty. Add PDFs first.'); return; }
  const ids = new Set(await pick(rest, {title:'Add songs to ' + c.name, button:'Add', needOne:true}));
  if(!ids.size) return;
  await write(state.songs.filter(s => ids.has(s.id)).map(s => ({store:'songs', key:s.id, value:{...s, colls:[...(s.colls || []), id], updated:stamp(s)}})), 'Could not add the songs. Nothing was changed.');
}

/* ---------- the manager dialog ---------- */
export function openManager(){
  const m = modal('<h2>Collections</h2><div class="mgr"></div><div class="btns"><button data-newcoll>New collection</button><button class="pri" data-x>Done</button></div>');
  m.classList.add('collmgr');
  const list = m.querySelector('.mgr');
  let working = false;
  const draw = focus => {
    const def = getDefault();
    list.innerHTML = state.colls.length ? state.colls.map(c => { const id = esc(c.id); return `<div class="mrow"><span class="mname">${esc(c.name)}</span><div class="acts">
        <button data-mren="${id}">Rename</button><button data-mdef="${id}" aria-pressed="${c.id === def}">${c.id === def ? 'Default' : 'Set as default'}</button>
        <button data-madd="${id}">Add songs</button><button data-mdel="${id}">Delete</button></div></div>`; }).join('')
      : '<p class="hint">No collections yet. Make one for each band you play with.</p>';
    const el = focus && m.querySelector(focus);
    if(el) el.focus();
    else if(!m.contains(document.activeElement)) (m.querySelector('[data-newcoll]') || m).focus();
  };
  draw();
  /* Closing (Done or Escape) puts focus back on the Collections button: the screen behind was redrawn while the dialog was open, so the
     button that opened it is no longer in the page. */
  m.querySelector('[data-x]').onclick = () => { m.remove(); const b = document.querySelector('[data-collmanage]'); if(b) b.focus(); };
  m.addEventListener('click', async e => {
    const b = e.target.closest('button'); if(!b || working || !m.contains(b)) return;
    const d = b.dataset;
    if(!('newcoll' in d || d.mren || d.mdef || d.madd || d.mdel)) return;
    if(d.mdel && !armed(b, 'Songs stay in your library')) return;
    working = true;
    try{
      let focus = null;
      if('newcoll' in d){ await newColl(); focus = '[data-newcoll]'; }
      else if(d.mren){ await renameColl(d.mren); focus = `[data-mren="${d.mren}"]`; }
      else if(d.mdef){ const on = getDefault() !== d.mdef; setDefault(on ? d.mdef : null); hooks.render(); focus = `[data-mdef="${d.mdef}"]`; }
      else if(d.madd){ await addSongsTo(d.madd); focus = `[data-madd="${d.madd}"]`; }
      else if(d.mdel){ await deleteColl(d.mdel); focus = '[data-newcoll]'; }
      if(m.isConnected) draw(focus);
    }finally{ working = false; }
  });
}

/* Returns true when the click was for collections. */
export async function onClick(b, d){
  if(d.collpick != null){
    shown = d.collpick === 'all' ? null : d.collpick;
    hooks.render();
    const again = document.querySelector(`[data-collpick="${CSS.escape(d.collpick)}"]`);
    if(again) again.focus();
    return true;
  }
  if('collmanage' in d){ openManager(); return true; }
  if(d.addcollsongs){ await addSongsTo(d.addcollsongs); return true; }
  return false;
}

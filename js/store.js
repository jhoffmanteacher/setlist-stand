import {splitName, displayName, sortKey} from './names.js';
import {uid} from './util.js';

/* Storage: IndexedDB `setlist-stand` (stores songs, files, sets, ink), with an in-memory fallback. */
export let MEM = null;
let dbp;
function db(){
  if(!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('setlist-stand', 1);
    r.onupgradeneeded = () => { for(const n of ['songs', 'files', 'sets', 'ink']) r.result.createObjectStore(n); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn){
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode); const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('aborted'));     // a full disk at commit aborts without an error event
  });
}
export const put = (st, k, v) => MEM ? (MEM[st].set(k, v), Promise.resolve()) : tx(st, 'readwrite', s => s.put(v, k));
export const get = (st, k) => MEM ? Promise.resolve(MEM[st].get(k)) : tx(st, 'readonly', s => s.get(k));
export const del = (st, k) => MEM ? (MEM[st].delete(k), Promise.resolve()) : tx(st, 'readwrite', s => s.delete(k));
export const all = st => MEM ? Promise.resolve([...MEM[st].values()]) : tx(st, 'readonly', s => s.getAll());

/* Every ink page key of a song ("id:1", "id:2", …). */
const inkRange = songId => [songId + ':', songId + ':￿'];
/* Writes many records in ONE transaction: all of them are saved or none are (a reload, a full disk or a crash
   part-way leaves the stores exactly as they were). Runs in order. ops:
   {store, key, value} saves, {store, key, delete:true} removes, {deleteInkFor:songId} removes every ink page of that song. */
export async function putAll(ops){
  const storeOf = o => o.deleteInkFor != null ? 'ink' : o.store;
  if(MEM){
    for(const o of ops){
      if(o.deleteInkFor != null){ const [lo, hi] = inkRange(o.deleteInkFor); for(const k of [...MEM.ink.keys()]) if(k >= lo && k <= hi) MEM.ink.delete(k); }
      else if(o.delete) MEM[o.store].delete(o.key);
      else MEM[o.store].set(o.key, o.value);
    }
    return;
  }
  if(!ops.length) return;
  const d = await db();
  await new Promise((res, rej) => {
    const stores = [...new Set(ops.map(storeOf))], t = d.transaction(stores, 'readwrite');
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('aborted'));
    /* A key range delete is one request, so it stays in order with the puts around it (a cursor would not).
       A request that throws (say a value that cannot be stored) aborts the whole transaction: the earlier ops are undone too. */
    try{
      for(const o of ops){
        const st = t.objectStore(storeOf(o));
        if(o.deleteInkFor != null) st.delete(IDBKeyRange.bound(...inkRange(o.deleteInkFor)));
        else if(o.delete) st.delete(o.key);
        else st.put(o.value, o.key);
      }
    }catch(err){ try{ t.abort(); }catch(e){} rej(err); }
  });
}
/* Reads one record and writes fn(record) back in ONE transaction, so nothing written in between is lost.
   fn returns the new record, or undefined to leave it as it is. Resolves to what was written (or undefined). */
export async function update(store, key, fn){
  if(MEM){ const v = fn(MEM[store].get(key)); if(v !== undefined) MEM[store].set(key, v); return v; }
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite'), st = t.objectStore(store);
    let out;
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('aborted'));
    const r = st.get(key);
    r.onsuccess = () => {
      try{ out = fn(r.result); if(out !== undefined) st.put(out, key); }
      catch(err){ try{ t.abort(); }catch(e){} rej(err); }
    };
  });
}

/* Returns true when on-device storage works, false when it fell back to memory. */
export async function openStore(){
  try{ await db(); return true; }
  catch(e){ MEM = {songs:new Map(), files:new Map(), sets:new Map(), ink:new Map()}; return false; }
}

/* ---------- records ----------
   song  {id, title (derived: "Song (version) - Artist"), song, artist, version, archived, pages, hash, added, updated}
   set   {id, name, songs:[ids], created, updated}
   ink   key "songId:page" -> {updated, strokes:[{id, t, c, w, p, updated} | {id, deleted:true, updated}]}
   A deleted song, set or stroke stays behind as {id, deleted:true, updated} so a later sync can tell
   "deleted" from "never had it". The UI never shows them. */
export const state = {songs:[], sets:[]};   // live (not deleted) records only
const now = () => Date.now();

/* Fills in missing fields. Returns true when the record changed (so it should be saved). */
export function upgradeSong(s){
  if(s.deleted) return false;
  const before = JSON.stringify(s);
  if(typeof s.song !== 'string'){ const n = splitName(s.title || ''); s.song = n.song; s.artist = n.artist; s.version = n.version; }
  s.artist = s.artist || ''; s.version = s.version || '';
  s.archived = !!s.archived;
  if(!s.updated) s.updated = s.added || now();
  s.title = displayName(s);
  return JSON.stringify(s) !== before;
}
export function upgradeSet(st){
  if(st.deleted) return false;
  const before = JSON.stringify(st);
  if(!Array.isArray(st.items)) st.items = (Array.isArray(st.songs) ? st.songs : []).map(id => ({type:'song', id}));
  delete st.songs;
  st.items = st.items.filter(it => it && (it.type === 'break' || (it.type === 'song' && it.id)))
    .map(it => it.type === 'break' ? {type:'break', id:it.id || uid(), name:it.name || 'Break'} : {type:'song', id:it.id});
  if(!st.updated) st.updated = st.created || now();
  return JSON.stringify(st) !== before;
}
/* A set's items minus songs that no longer exist. Breaks always stay. */
export const liveItems = st => st.items.filter(it => it.type === 'break' || songById(it.id));
const byName = (a, b) => sortKey(a.song).localeCompare(sortKey(b.song), undefined, {numeric:true}) ||
  a.song.localeCompare(b.song, undefined, {numeric:true}) || (a.artist + a.version).localeCompare(b.artist + b.version);

export async function load(){
  const songs = await all('songs'), sets = await all('sets');
  for(const s of songs) if(upgradeSong(s)) await put('songs', s.id, s);
  for(const st of sets) if(upgradeSet(st)) await put('sets', st.id, st);
  state.songs = songs.filter(s => !s.deleted).sort(byName);
  state.sets = sets.filter(s => !s.deleted).sort((a, b) => b.created - a.created);
}
export const songById = id => state.songs.find(s => s.id === id);
export const saveSong = s => { s.title = displayName(s); s.updated = now(); return put('songs', s.id, s); };
export const saveSet = st => { st.updated = now(); return put('sets', st.id, st); };
export const markDeleted = (store, id) => put(store, id, {id, deleted:true, updated:now()});

/* SHA-256 of the PDF bytes, as hex. Used later to spot the same chart twice. */
export async function sha256(buf){
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return [...h].map(b => b.toString(16).padStart(2, '0')).join('');
}
/* Songs that came from an older backup or the converter have no hash yet. */
export async function ensureHashes(){
  let n = 0;
  for(const s of state.songs){
    if(s.hash) continue;
    const f = await get('files', s.id); if(!f) continue;
    const hash = await sha256(await f.arrayBuffer());
    /* Hashing takes a while: write onto the record as it is NOW (an edit made meanwhile stays), and never revive a deleted song. */
    /* ...and only onto the same record (same `updated`): a restore that replaced the PDF meanwhile must not get the old file's hash. */
    const saved = await update('songs', s.id, cur => cur && !cur.deleted && !cur.hash && cur.updated === s.updated ? {...cur, hash} : undefined);
    if(saved){ s.hash = hash; n++; }
  }
  return n;
}

/* ---------- ink ---------- */
export const liveStrokes = arr => (arr || []).filter(s => !s.deleted);
export const inkRecord = (strokes) => ({updated:now(), strokes});
/* Older data stored a bare array of strokes with no ids. Give them ids and save once.
   Anything else that is not {updated, strokes:[...]} (a damaged or hand-made record) becomes an empty page;
   stroke entries that are not objects are dropped and `updated` is always a number. */
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
export function upgradeInk(v){
  if(!v) return {record:{updated:0, strokes:[]}, changed:false};
  if(Array.isArray(v)){
    const t = now();
    return {record:{updated:t, strokes:v.filter(isObj).map(s => ({...s, id:s.id || uid(), updated:s.updated || t}))}, changed:true};
  }
  if(!isObj(v) || !Array.isArray(v.strokes)) return {record:{updated:Number(isObj(v) && v.updated) || 0, strokes:[]}, changed:true};
  const strokes = v.strokes.filter(isObj), updated = Number(v.updated) || 0;
  if(strokes.length === v.strokes.length && updated === v.updated) return {record:v, changed:false};
  return {record:{...v, updated, strokes}, changed:true};
}
export async function getInk(songId, pn){
  const key = songId + ':' + pn, v = await get('ink', key);
  const {record, changed} = upgradeInk(v);
  if(changed) await put('ink', key, record);
  return record.strokes;
}
/* Removes every ink page record of a song, whatever its page count was. */
export async function delInkFor(songId){
  const [lo, hi] = inkRange(songId);
  if(MEM){ for(const k of [...MEM.ink.keys()]) if(k >= lo && k <= hi) MEM.ink.delete(k); return; }
  const d = await db();
  await new Promise((res, rej) => {
    const t = d.transaction('ink', 'readwrite'), st = t.objectStore('ink');
    st.openKeyCursor(IDBKeyRange.bound(lo, hi)).onsuccess = e => { const c = e.target.result; if(c){ st.delete(c.key); c.continue(); } };
    t.oncomplete = res; t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('aborted'));
  });
}
export const putInk = (songId, pn, strokes) => put('ink', songId + ':' + pn, inkRecord(strokes));
/* Makes `next` the page's strokes: strokes that vanished become deletion markers,
   strokes that came back (undo) get a fresh timestamp so they beat their old marker. */
export function reconcile(prev, next){
  const t = now(), pm = new Map((prev || []).map(s => [s.id, s])), seen = new Set(), out = [];
  for(const s of next){
    seen.add(s.id); const p = pm.get(s.id);
    const edited = p && !p.deleted && s.t === 'text' && ['text', 'x', 'y', 'size', 'c'].some(k => p[k] !== s[k]);
    out.push(p && ((p.deleted && !s.deleted) || edited) ? {...s, updated:t} : s);
  }
  for(const p of prev || []) if(!seen.has(p.id)) out.push(p.deleted ? p : {id:p.id, deleted:true, updated:t});
  return out;
}

/* Crop: a song has `crop: {all: rect|null, pages: {"2": rect}}` where rect = {x, y, w, h} as fractions of the full page
   (x, y = the top-left corner of the part that is kept). A page's own crop wins over the song-wide one. */
export const cropOf = (song, pn) => (song && song.crop && ((song.crop.pages && song.crop.pages[pn]) || song.crop.all)) || null;

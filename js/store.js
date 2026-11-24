import {splitName, displayName, compareSongs, cutName} from './names.js';
import {uid} from './util.js';

/* Storage: IndexedDB `setlist-stand`, with an in-memory fallback. STORE_NAMES is the ONE list of stores: the upgrade, the
   memory fallback, backup, restore and the tests all read it, so a store added later is carried everywhere.
   Version 1 had songs, files, sets, ink; version 2 adds colls (collections). An upgrade only creates the stores that are
   missing, so a version 1 library keeps every record. */
/* Ids end up in the page's HTML and in storage keys, so they are held to a plain set of characters (js/backup.js checks every id with it). */
export const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/* The latest `updated` this tablet holds or sends: below the largest date JavaScript has; stamp() and inkRecord() never go above it.
   What a sync takes from Drive stops at the same time (MAX_READ in js/syncink.js), so everything made here from it is taken there too.
   js/syncink.js holds a copy of this (it loads in Node). */
export const MAX_U = 8.64e15 - 1e6;
export const STORE_NAMES = ['songs', 'files', 'sets', 'ink', 'colls'];
export const DB_VERSION = 2;
export let MEM = null;
let dbp, upgrading = false;
function db(){
  if(!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('setlist-stand', DB_VERSION);
    r.onupgradeneeded = () => { upgrading = true; for(const n of STORE_NAMES) if(!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n); };
    /* A tab still running the older app (version 1) keeps the database open and cannot be told to let go: the upgrade waits
       until that tab is closed. Say so (main.js shows it); when the tab closes, onsuccess follows and the message goes. */
    r.onblocked = () => dispatchEvent(new Event('ss-db-blocked'));
    r.onsuccess = () => {
      const d = r.result;
      /* A newer app in another tab wants to upgrade the database: let go at once so it is never blocked by this tab. */
      d.onversionchange = () => { d.close(); dbp = null; dispatchEvent(new Event('ss-db-changed')); };
      dispatchEvent(new Event('ss-db-open'));
      res(d);
    };
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
/* A failed request reports its error on the request (e.target.error); the transaction's own `error` is still null at that
   moment in Safari, which would hide a "tablet is full" error behind a generic one. */
const txErr = (t, e) => (e && e.target && e.target.error) || t.error || new Error('The save failed');
async function tx(store, mode, fn){
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode); const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r && r.result); t.onerror = e => rej(txErr(t, e));
    t.onabort = () => rej(t.error || new Error('aborted'));     // a full disk at commit aborts without an error event
  });
}
/* The newest `updated` of any record in any store but `files` (songs, setlists, collections, ink pages, and deletion markers): what
   the backup reminder compares with the time of the last backup (js/nudge.js). It is kept in memory as writes happen: put(),
   putAll() and update() here are the only write paths, so each one tells seen() what it wrote, and load() / initChanged() read it
   from the database at start. A record written with an `updated` that is not newer (a restore of old records, a hash filled in,
   `colls: []` added by the upgrade) changes nothing; a plain delete (no marker, no `updated`) counts as now. */
let newest = 0, newestRec = 0;
export const newestChange = () => newest;
/* The same for what a Drive sync carries (songs, setlists, collections and, since Part 3, ink pages), for the sync reminder. What a sync
   itself writes is in step with Drive and does not count (putAll's fromSync); syncPending() is the one way a sync says it left
   something here that still has to go up. */
export const newestRecordChange = () => newestRec;
const RECORD_STORES = new Set(['songs', 'sets', 'colls', 'ink']);
/* A record dated in the future (it came from a tablet with a wrong clock): READING it (at start, after a reload of the library) says
   nothing about when anything changed here, so it is ignored; WRITING it is a change made now, so a date more than a day ahead counts as now.
   Either way it can never sit above every real change and hide them, and it cannot keep a reminder on. */
const AHEAD = 864e5;
function seen(u, isRecord, read){
  const now = Date.now();
  u = Number(u) || 0;
  if(u > now){ if(read) return; if(u > now + AHEAD) u = now; }       // a date still in the future cannot be a change that already happened: reading it counts for nothing
  let moved = false;
  if(u > newest){ newest = u; moved = true; }
  if(isRecord && u > newestRec){ newestRec = u; moved = true; }
  if(moved) dispatchEvent(new Event('ss-changed'));
}
const seenRec = (st, v, read) => { if(st !== 'files' && v && typeof v === 'object') seen(v.updated, RECORD_STORES.has(st), read); };
/* A sync wrote here, or kept here, something of this tablet's own that is not on Drive yet (a merged page of marks it could not send,
   or one it sends only later in the run): a change to SYNC made now, so the sync reminder is honest if the run ends before it goes up.
   It is not a change to back up (the backup reminder's time does not move). */
export const syncPending = () => { const t = Date.now(); if(t > newestRec){ newestRec = t; dispatchEvent(new Event('ss-changed')); } };
export const put = async (st, k, v) => { await (MEM ? (MEM[st].set(k, v), Promise.resolve()) : tx(st, 'readwrite', s => s.put(v, k))); seenRec(st, v); };
export const get = (st, k) => MEM ? Promise.resolve(MEM[st].get(k)) : tx(st, 'readonly', s => s.get(k));
export const del = async (st, k) => { await (MEM ? (MEM[st].delete(k), Promise.resolve()) : tx(st, 'readwrite', s => s.delete(k))); if(st !== 'files') seen(Date.now(), RECORD_STORES.has(st)); };
export const all = st => MEM ? Promise.resolve([...MEM[st].values()]) : tx(st, 'readonly', s => s.getAll());

/* Every ink page key of a song ("id:1", "id:2", …). */
const inkRange = songId => [songId + ':', songId + ':￿'];
/* Writes many records in ONE transaction: all of them are saved or none are (a reload, a full disk or a crash
   part-way leaves the stores exactly as they were). Runs in order. ops:
   {store, key, value} saves, {store, key, delete:true} removes, {deleteInkFor:songId} removes every ink page of that song.
   A save or remove may carry `ifUpdated` (a number, or null for "not there"): the record at (store, key) must, at the moment of
   writing, have exactly that `updated` (null: no record, or one with no `updated`). It is checked inside the same transaction,
   before anything is written; one that does not match writes NOTHING and putAll rejects with an Error named 'StaleWrite' (sync:
   a record changed by another tab or another tablet's run since it was read is never written over). */
export async function putAll(ops, {fromSync = false} = {}){
  await putAllRaw(ops);
  /* What a sync itself writes (records that came down) is in step with Drive already, so it is not a change to sync; it IS a change since the last
     backup, made now whatever date the record carries. */
  if(fromSync){ if(ops.some(o => o.store !== 'files' && o.deleteInkFor == null)) seen(Date.now(), false); return; }
  for(const o of ops){ if(o.deleteInkFor != null) seen(Date.now(), false); else if(o.delete && o.store !== 'files') seen(Date.now(), RECORD_STORES.has(o.store)); else if(!o.delete) seenRec(o.store, o.value); }       // only a write that went through counts
}
const hasCheck = o => o.deleteInkFor == null && o.ifUpdated !== undefined;
const fresh = (o, cur) => o.ifUpdated === null ? cur === undefined || cur === null || cur.updated == null : !!cur && cur.updated === o.ifUpdated;
function staleWrite(o){ const e = new Error(`${o.store} ${o.key} changed since it was read. Nothing was written.`); e.name = 'StaleWrite'; return e; }
async function putAllRaw(ops){
  const storeOf = o => o.deleteInkFor != null ? 'ink' : o.store;
  if(MEM){
    for(const o of ops) if(hasCheck(o) && !fresh(o, MEM[o.store].get(o.key))) throw staleWrite(o);     // every check before any write
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
    let stale = null;
    t.oncomplete = () => res();
    t.onerror = e => rej(stale || txErr(t, e));
    t.onabort = () => rej(stale || t.error || new Error('aborted'));
    /* A key range delete is one request, so it stays in order with the puts around it (a cursor would not).
       A request that throws (say a value that cannot be stored) aborts the whole transaction: the earlier ops are undone too. */
    try{
      /* The checks are the first requests of the transaction, so each read sees the records as they were before any op here;
         a mismatch aborts the transaction, which undoes every write queued after it. */
      for(const o of ops) if(hasCheck(o)){
        const r = t.objectStore(o.store).get(o.key);
        r.onsuccess = () => { if(!stale && !fresh(o, r.result)){ stale = staleWrite(o); try{ t.abort(); }catch(e){} rej(stale); } };
      }
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
  if(MEM){ const v = fn(MEM[store].get(key)); if(v !== undefined){ seenRec(store, v); MEM[store].set(key, v); } return v; }
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite'), st = t.objectStore(store);
    let out;
    t.oncomplete = () => { if(out !== undefined) seenRec(store, out); res(out); };
    t.onerror = e => rej(txErr(t, e));
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
  catch(e){
    /* A database made by a NEWER version of the app (this code was rolled back): never fall back to memory, where whatever is
       added or restored is lost on reload. main.js says so and stops; a reload after the next update opens it. */
    if(e && (e.name === 'VersionError' || upgrading)) throw e;      // ...or an upgrade that was started and failed (a full tablet): the library is still on disk
    MEM = Object.fromEntries(STORE_NAMES.map(n => [n, new Map()])); return false;
  }
}

/* ---------- records ----------
   song  {id, title (derived: "Song (version) - Artist"), song, artist, version, archived, colls:[collection ids], pages, hash, added, updated}
   set   {id, name, items:[...], colls:[collection ids], created, updated}
   coll  {id, name, created, updated}   (a collection: the band a song or setlist is played with; songs and sets list their collections in `colls`)
   ink   key "songId:page" -> {updated, strokes:[{id, t, c, w, p, updated} | {id, deleted:true, updated}]}
   A deleted song, set or stroke stays behind as {id, deleted:true, updated} so a later sync can tell
   "deleted" from "never had it". The UI never shows them. */
export const state = {songs:[], sets:[], colls:[]};   // live (not deleted) records only
const now = () => Date.now();

/* Fills in missing fields. Returns true when the record changed (so it should be saved). */
export function upgradeSong(s){
  if(s.deleted) return false;
  const before = JSON.stringify(s);
  if(typeof s.song !== 'string'){ const n = splitName(s.title || ''); s.song = cutName(n.song); s.artist = cutName(n.artist); s.version = cutName(n.version); }
  s.artist = s.artist || ''; s.version = s.version || '';
  s.archived = !!s.archived;
  s.colls = cleanColls(s.colls);
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
    .map(it => it.type === 'break' ? {...it, type:'break', id:it.id || uid(), name:it.name || 'Break'} : {...it, type:'song', id:it.id});    // a row keeps any field this version does not know
  st.colls = cleanColls(st.colls);
  if(!st.updated) st.updated = st.created || now();
  return JSON.stringify(st) !== before;
}
/* A record's `colls`: a list of collection ids (strings, each once). Anything else (missing, not a list) is []. Ids of
   collections that are gone or unknown are left in the record (another tablet's collection may not have arrived yet) and
   ignored when a list is drawn (collsOf in js/collections.js). */
export const cleanColls = v => Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && ID_RE.test(x)))] : [];
/* A set's items minus songs that no longer exist. Breaks always stay. */
export const liveItems = st => st.items.filter(it => it.type === 'break' || songById(it.id));
export async function load(){
  const songs = await all('songs'), sets = await all('sets'), colls = await all('colls');
  /* Records that needed filling in (a library from before collections gets `colls: []` on every song and setlist) are saved
     together in ONE transaction; `updated` is not touched, since nothing the person did changed. */
  const ops = [];
  for(const s of songs) if(upgradeSong(s)) ops.push({store:'songs', key:s.id, value:s});
  for(const st of sets) if(upgradeSet(st)) ops.push({store:'sets', key:st.id, value:st});
  /* A failed write here (a full tablet) must not stop the app from starting: the records are already upgraded in memory and the
     write is tried again on the next load. */
  if(ops.length) await putAll(ops).catch(() => {});
  state.songs = songs.filter(s => !s.deleted).sort(compareSongs);     // the lists sort again when they are drawn (compareSongs in js/names.js)
  state.sets = sets.filter(s => !s.deleted).sort((a, b) => b.created - a.created);
  state.colls = colls.filter(c => c && !c.deleted && typeof c.name === 'string').sort(compareColls);
  for(const r of [...songs, ...sets, ...colls]) seenRec('songs', r, true);        // the newest change among the records read here (ink pages: initChanged)
}
/* Reads the ink pages' newest `updated` once at start (after the first draw: it must not slow the Library down). */
export async function initChanged(){
  for(const r of await all('ink')) seenRec('ink', r, true);
}
/* Collections A to Z by name (case and accents ignored, numbers as numbers), the same ties as everywhere: by id. */
const COLL_COLLATOR = new Intl.Collator(undefined, {sensitivity:'base', numeric:true});
export const compareColls = (a, b) => COLL_COLLATOR.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const songById = id => state.songs.find(s => s.id === id);
/* The `updated` of an edit to a record that already exists: now, or one millisecond after the version it was made from when
   that one is later (a copy from a tablet whose clock is ahead), so an edit always beats the version it was made from.
   A brand-new record has nothing to beat (stamp(null) is now). Every edit of an existing song, setlist or collection uses it. */
export const stamp = prev => Math.min(MAX_U, Math.max(Date.now(), (Number(prev && prev.updated) || 0) + 1));
export const saveSong = s => { s.title = displayName(s); s.updated = stamp(s); return put('songs', s.id, s); };
/* The record for a new song whose PDF (pages, hash) is about to be saved under its id. name: {song, artist, version};
   colls: the collections it joins (joinColls() in js/collections.js; [] by default). */
export function newSong(name, pages, hash, colls = []){
  const t = now(), s = {id:uid(), ...name, song:cutName(name.song), artist:cutName(name.artist), version:cutName(name.version), archived:false, colls:[...colls], pages, hash, added:t, updated:t};
  s.title = displayName(s);
  return s;
}
export const saveSet = st => { st.updated = stamp(st); return put('sets', st.id, st); };
/* The marker is stamped over the record as it is stored, read and written in one transaction. */
export const markDeleted = async (store, id) => { await update(store, id, prev => ({id, deleted:true, updated:stamp(prev)})); };

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
/* A page record. Its `updated` is now, or later when it must be: never below the newest entry on it (a stroke stamped past now, see
   stamp()) and always above the page record it replaces (`prev`, the stored record, when there is one), so the page as a whole
   also beats the version it was made from on a tablet whose clock is behind. */
const finiteU = x => { const u = Number(x && x.updated); return Number.isFinite(u) ? u : 0; };
/* Fields of the page other than `updated` and `strokes` (a later version's) are kept from `prev`, as a sync's merge keeps them. */
export const inkRecord = (strokes, prev) => ({...(isObj(prev) ? prev : {}), updated:Math.min(MAX_U, strokes.reduce((m, s) => Math.max(m, finiteU(s)), Math.max(Date.now(), prev ? finiteU(prev) + 1 : 0))), strokes});
/* Older data stored a bare array of strokes with no ids. Give them ids and save once.
   Anything else that is not {updated, strokes:[...]} (a damaged or hand-made record) becomes an empty page;
   stroke entries that are not objects are dropped and `updated` is always a number. */
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
/* The id an old stroke without one gets: from its place in the list and its content (FNV-1a of its JSON), so every tablet and every
   restore of the same old page gives it the SAME id (a random one would make the page double when two tablets sync it). */
export const oldId = (s, i) => { let h = 0x811c9dc5; for(const ch of JSON.stringify(s)){ h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return 'l' + i + '-' + h.toString(16).padStart(8, '0'); };
export function upgradeInk(v){
  if(!v) return {record:{updated:0, strokes:[]}, changed:false};
  if(Array.isArray(v)){
    const t = now();
    return {record:{updated:t, strokes:v.map((s, i) => [s, i]).filter(([s]) => isObj(s)).map(([s, i]) => ({...s, id:s.id || oldId(s, i), updated:s.updated || 0}))}, changed:true};      // no time: 0, the same on every tablet (any real edit or erase wins)
  }
  if(!isObj(v) || !Array.isArray(v.strokes)) return {record:{updated:Number(isObj(v) && v.updated) || 0, strokes:[]}, changed:true};
  const strokes = v.strokes.filter(isObj), updated = Number(v.updated) || 0;
  if(strokes.length === v.strokes.length && updated === v.updated) return {record:v, changed:false};
  return {record:{...v, updated, strokes}, changed:true};
}
/* A mark that cannot be DRAWN is taken out and one whose colour is not "#rrggbb" is drawn black (the mark stays). cleanMark(s) returns
   the mark as it should be kept, or null when nothing of it can be drawn: a note needs a text string and numbers for x, y and size; a pen
   or highlighter line keeps its good points (a point is two numbers) and goes only when none is left; an erase marker is kept as it is.
   Used by restore (js/backup.js) on the backup's pages and by the restore question (js/restoreplan.js) on this tablet's, so both sides of
   the comparison are the same. */
const finite = v => typeof v === 'number' && Number.isFinite(v);
export function cleanMark(s){
  if(!isObj(s)) return null;
  if(s.deleted) return s;
  let out = s;
  if(s.t === 'text'){
    if(typeof s.text !== 'string' || !finite(s.x) || !finite(s.y) || !finite(s.size)) return null;
  }else{
    if(!Array.isArray(s.p)) return null;
    const pts = s.p.filter(pt => Array.isArray(pt) && pt.length >= 2 && finite(pt[0]) && finite(pt[1]));
    if(!pts.length) return null;
    if(pts.length !== s.p.length) out = {...out, p:pts};
  }
  if(!/^#[0-9a-fA-F]{6}$/.test(String(s.c))) out = {...out, c:'#000000'};
  return out;
}
export async function getInk(songId, pn){
  const key = songId + ':' + pn, v = await get('ink', key);
  const {record, changed} = upgradeInk(v);
  if(changed) await put('ink', key, record);
  return record.strokes;
}
/* The strokes of pages 1..n of a song in ONE read transaction (not n awaited reads one after another): Map page -> strokes,
   each page upgraded and saved back exactly as getInk() would. */
export async function getInkPages(songId, n){
  const keys = Array.from({length:n}, (_, i) => songId + ':' + (i + 1));
  let recs;
  if(MEM) recs = keys.map(k => MEM.ink.get(k));
  else {
    const d = await db();
    recs = await new Promise((res, rej) => {
      const t = d.transaction('ink', 'readonly'), st = t.objectStore('ink'), reqs = keys.map(k => st.get(k));
      t.oncomplete = () => res(reqs.map(r => r.result)); t.onerror = e => rej(txErr(t, e));
      t.onabort = () => rej(t.error || new Error('aborted'));
    });
  }
  const out = new Map();
  for(let i = 0; i < n; i++){
    const {record, changed} = upgradeInk(recs[i]);
    if(changed) await put('ink', keys[i], record);
    out.set(i + 1, record.strokes);
  }
  return out;
}
/* Every ink page as [key, stored value], in ONE read (a sync compares them with Drive; nothing is upgraded or written here). */
export async function inkEntries(){
  if(MEM) return [...MEM.ink.entries()];
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('ink', 'readonly'), st = t.objectStore('ink'), ks = st.getAllKeys(), vs = st.getAll();     // the same key order
    t.oncomplete = () => res(ks.result.map((k, i) => [k, vs.result[i]])); t.onerror = e => rej(txErr(t, e));
    t.onabort = () => rej(t.error || new Error('aborted'));
  });
}
/* Removes every ink page record of a song, whatever its page count was. */
export async function delInkFor(songId){
  const [lo, hi] = inkRange(songId);
  if(MEM){ for(const k of [...MEM.ink.keys()]) if(k >= lo && k <= hi) MEM.ink.delete(k); return; }
  const d = await db();
  await new Promise((res, rej) => {
    const t = d.transaction('ink', 'readwrite'), st = t.objectStore('ink');
    st.openKeyCursor(IDBKeyRange.bound(lo, hi)).onsuccess = e => { const c = e.target.result; if(c){ st.delete(c.key); c.continue(); } };
    t.oncomplete = res; t.onerror = e => rej(txErr(t, e));
    t.onabort = () => rej(t.error || new Error('aborted'));
  });
}
/* Read and written in one transaction, so the page's `updated` is stamped over the record as it is stored. */
export const putInk = (songId, pn, strokes) => update('ink', songId + ':' + pn, prev => inkRecord(strokes, prev));
/* Makes `next` the page's strokes: strokes that vanished become deletion markers,
   strokes that came back (undo) or a note put back as it was get a new time so they beat their old marker or version.
   Every such time is stamp()ed over the entry it replaces (and over the one it brings back), never plain now: an entry dated
   ahead (a tablet whose clock is ahead) is still beaten by the change made here. Of two markers for one stroke, the later stays. */
export function reconcile(prev, next){
  const pm = new Map((prev || []).map(s => [s.id, s])), seen = new Set(), out = [];
  for(const s of next){
    seen.add(s.id); const p = pm.get(s.id);
    const edited = p && !p.deleted && s.t === 'text' && ['text', 'x', 'y', 'size', 'c'].some(k => p[k] !== s[k]);
    if(p && ((p.deleted && !s.deleted) || edited)) out.push({...s, updated:Math.max(stamp(p), stamp(s))});
    else out.push(p && p.deleted && s.deleted && finiteU(p) > finiteU(s) ? p : s);
  }
  for(const p of prev || []) if(!seen.has(p.id)) out.push(p.deleted ? p : {id:p.id, deleted:true, updated:stamp(p)});
  return out;
}

/* Crop: a song has `crop: {all: rect|null, pages: {"2": rect}}` where rect = {x, y, w, h} as fractions of the full page
   (x, y = the top-left corner of the part that is kept). A page's own crop wins over the song-wide one. */
/* A usable crop rectangle: numbers inside the page, at least CROP_MIN wide and high (the editor cannot make a smaller one), ending no
   later than the page edge (give or take rounding). The one rule, for cropOf below and for cleanCrop. */
const saneRect = r => isObj(r) && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.x >= 0 && r.y >= 0 && r.x <= 1 && r.y <= 1
  && r.w >= CROP_MIN && r.h >= CROP_MIN && r.x + r.w <= 1.001 && r.y + r.h <= 1.001;
/* A damaged rectangle (from a restore or a sync: records are kept whole, never cleaned) is ignored, never drawn: the page shows
   uncropped instead of blank. A page's own crop that is damaged falls back to the song-wide one. */
export const cropOf = (song, pn) => {
  const c = song && song.crop;
  if(!c) return null;
  const own = c.pages && c.pages[pn];
  return saneRect(own) ? own : saneRect(c.all) ? c.all : null;
};

/* The smallest part of a page a crop may keep: the editor in js/crop.js cannot make a box smaller than this. */
export const CROP_MIN = .08;
/* A crop that came from outside (a share package) made safe to use: {crop, dropped}. A rectangle is kept only if x, y, w and h
   are finite numbers inside the page (x and y from 0 to 1, w and h from CROP_MIN, the box ending no later than the page edge,
   give or take rounding); a page key is kept only if it is a page of the song (1 to `pages`). Anything else is dropped and
   counted, and the song keeps its other crops (a bad margin must not cost a whole package). crop is null if nothing is left. */
export function cleanCrop(c, pages){
  let dropped = 0;
  const rect = r => saneRect(r) ? {x:r.x, y:r.y, w:r.w, h:r.h} : null;
  if(c == null) return {crop:null, dropped:0};
  if(!isObj(c)) return {crop:null, dropped:1};
  const all = c.all == null ? null : rect(c.all);
  if(c.all != null && !all) dropped++;
  const out = {};
  if(c.pages != null){
    if(!isObj(c.pages)) dropped++;
    else for(const [k, r] of Object.entries(c.pages)){
      const q = /^[1-9]\d*$/.test(k) && +k <= pages ? rect(r) : null;
      if(q) out[k] = q; else dropped++;
    }
  }
  return {crop: all || Object.keys(out).length ? {all, pages:out} : null, dropped};
}

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
  });
}
export const put = (st, k, v) => MEM ? (MEM[st].set(k, v), Promise.resolve()) : tx(st, 'readwrite', s => s.put(v, k));
export const get = (st, k) => MEM ? Promise.resolve(MEM[st].get(k)) : tx(st, 'readonly', s => s.get(k));
export const del = (st, k) => MEM ? (MEM[st].delete(k), Promise.resolve()) : tx(st, 'readwrite', s => s.delete(k));
export const all = st => MEM ? Promise.resolve([...MEM[st].values()]) : tx(st, 'readonly', s => s.getAll());

/* Returns true when on-device storage works, false when it fell back to memory. */
export async function openStore(){
  try{ await db(); return true; }
  catch(e){ MEM = {songs:new Map(), files:new Map(), sets:new Map(), ink:new Map()}; return false; }
}

export const state = {songs:[], sets:[]};
export async function load(){
  state.songs = (await all('songs')).sort((a, b) => a.title.localeCompare(b.title, undefined, {numeric:true}));
  state.sets = (await all('sets')).sort((a, b) => b.created - a.created);
}
export const songById = id => state.songs.find(s => s.id === id);

/* The records a deletion writes, for putAll() to write in ONE transaction. One place, so the Delete buttons and sync's
   "Delete here" (a deletion made on the other tablet) cannot drift apart.
     song  the PDF and every ink page go; the song becomes a deletion marker; each live setlist that had it loses the row
           (its `updated` moves, so the edit syncs);
     set   the setlist becomes a deletion marker (songs are untouched);
     coll  the collection becomes a deletion marker; each live song and setlist loses the collection id (their `updated` moves).
   A marker is {id, deleted:true, updated}. `marker` is a ready-made one (sync passes the other tablet's, so both tablets end
   with the same record); without it the marker is stamped over the record it replaces. `ifUpdated` (optional) makes the write
   fail with 'StaleWrite' and change nothing if the record was edited since it was read (see putAll in store.js). Every other
   record gets a time later than its own last one (stamp), so a deletion and its edits beat what they were made from. */
import {all, get, stamp} from './store.js';

const STORE = {song:'songs', set:'sets', coll:'colls'};

/* `leave`: a Set of "kind:id" keys of records that must NOT be edited by the cascade (a setlist or song whose own deletion on the other
   tablet is still waiting for an answer: editing it here would date it newer than the other tablet's marker and bring it back). */
export async function deleteOps(kind, id, {marker, ifUpdated, leave} = {}){
  const skip = (k, r) => leave && leave.has(k + ':' + r.id);
  if(marker && (marker.deleted !== true || marker.id !== id)) throw new Error('not a deletion marker for this record');
  const cur = await get(STORE[kind], id);
  const made = marker || {id, deleted:true, updated:stamp(cur)};
  const guard = ifUpdated === undefined ? {} : {ifUpdated};
  const ops = [];
  if(kind === 'song') ops.push({store:'files', key:id, delete:true}, {deleteInkFor:id});
  ops.push({store:STORE[kind], key:id, value:made, ...guard});
  if(kind === 'song'){
    const isIt = it => it && it.type === 'song' && it.id === id;
    for(const st of await all('sets')){
      if(st && !st.deleted && !skip('set', st) && Array.isArray(st.items) && st.items.some(isIt)) ops.push({store:'sets', key:st.id, value:{...st, items:st.items.filter(it => !isIt(it)), updated:stamp(st)}});
    }
  }
  if(kind === 'coll'){
    for(const [store, list] of [['songs', await all('songs')], ['sets', await all('sets')]]){
      for(const r of list) if(r && !r.deleted && !skip(store === 'songs' ? 'song' : 'set', r) && Array.isArray(r.colls) && r.colls.includes(id)) ops.push({store, key:r.id, value:{...r, colls:r.colls.filter(x => x !== id), updated:stamp(r)}});
    }
  }
  return ops;
}

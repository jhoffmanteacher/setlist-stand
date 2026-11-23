/* The records a New version writes (shared by the New version button in js/library.js and by Import chart updates in
   js/chartupdate.js, so a batch does exactly what one New version does).
   newVersionOps(s, buf, {pages, hash}, old, taken, opts) builds the list of putAll() ops for song `s` taking the new PDF `buf`:
   - the song keeps its id, details and setlist places (no setlist is written); it takes the new pages and hash, its crop is
     cleared (the old layout rarely fits the new chart; the archived copy keeps it) and its title is rebuilt;
   - its marks start fresh (each becomes a deletion marker through reconcile(); a page the new chart does not have is removed);
   - `old` (the stored bytes of the chart it has now, or null when there are none) becomes a NEW archived song with a fresh id
     (unique(), `taken` is the set of ids in use and grows), in no setlist: the same bytes (hash unchanged), "old YYYY-MM-DD" in its
     version, the crop and the live marks of every page under its id.
   opts.check: the song's op and its ink pages' ops carry ifUpdated (the whole write then fails with StaleWrite if any changed since read).
   Resolves to {ops, copy} (copy: the archived song, or null). Nothing is written here. */
import {get, newSong, sha256, upgradeInk, inkRecord, reconcile, stamp, state} from './store.js';
import {displayName} from './names.js';
import {unique} from './util.js';

export const allIds = () => new Set([...state.songs.map(x => x.id), ...state.sets.map(x => x.id)]);

export async function newVersionOps(s, buf, {pages:n, hash}, old, taken = allIds(), {check = false} = {}){
  const id = s.id, ops = [], pages = [], marks = new Map();
  for(let p = 1; p <= s.pages; p++){
    const raw = await get('ink', id + ':' + p), rec = upgradeInk(raw).record;
    pages.push({p, raw, rec});
    marks.set(p, rec.strokes.filter(x => !x.deleted));
  }
  let copy = null;
  if(old){
    const made = archivedCopyOps(s, old, await sha256(old), oldVersion(s.version), taken, marks);
    copy = made.copy; ops.push(...made.ops);
  }
  ops.push({store:'files', key:id, value:new Blob([buf], {type:'application/pdf'})});
  for(const {p, raw, rec} of pages){
    const key = id + ':' + p, cur = rec.strokes;
    /* opts.check: the page must still be as read (a stroke drawn meanwhile in another tab fails the whole write, never lost) */
    const guard = check ? {ifUpdated:raw && raw.updated != null ? raw.updated : null} : {};
    if(p > n) ops.push({store:'ink', key, delete:true, ...guard});                                       // that page no longer exists
    else if(cur.length) ops.push({store:'ink', key, value:inkRecord(reconcile(cur, []), rec), ...guard});     // keep deletion markers for the pages that remain (stamped over the marks and the page)
    else if(check) ops.push({store:'ink', key, delete:true, ...guard});           // a blank page, guarded too: a stroke drawn on it meanwhile refuses the batch
  }
  const {crop:_oldCrop, ...rest} = s;             // the crop belonged to the old chart's layout: the new chart starts uncropped (the archived copy keeps it)
  const song = {store:'songs', key:id, value:{...rest, pages:n, hash, title:displayName(s), updated:stamp(s)}};
  if(check) song.ifUpdated = s.updated;
  ops.push(song);
  return {ops, copy};
}

/* An archived copy of song `s` holding `bytes` (its chart as stored, copied: in Safari a Blob read back from the files store can
   follow the record that replaces it): a NEW song with a fresh id (unique(taken)), in no setlist, `version` as given, the song's
   crop and collections, and the given live marks of each page (`marks`: Map page -> strokes) under the copy's id, with their ids,
   points and `updated` unchanged (so a sync can still recognise them). Used by New version (and chart updates) and by a restore
   (js/restoreplan.js). Resolves nothing and writes nothing: returns {copy, ops}. */
export function archivedCopyOps(s, bytes, hash, version, taken, marks){
  const copy = newSong({song:s.song, artist:s.artist, version}, s.pages, hash, s.colls || []);
  copy.id = unique(taken);
  copy.archived = true;
  if(s.crop !== undefined) copy.crop = JSON.parse(JSON.stringify(s.crop));
  const ops = [{store:'files', key:copy.id, value:new Blob([bytes], {type:'application/pdf'})}, {store:'songs', key:copy.id, value:copy}];
  for(const [p, list] of marks) if(list.length) ops.push({store:'ink', key:copy.id + ':' + p, value:inkRecord(list)});   // the old chart keeps its marks
  return {copy, ops};
}

/* The version an old copy gets: "old 2026-11-21", or "in G, old 2026-11-21" (the date here; the whole stays within the
   200 characters a text field takes, so share import, which refuses longer text, still takes it). A restore's copies use the
   word "before restore": "in G, before restore 2026-11-23". */
export function oldVersion(v, word = 'old'){
  const d = new Date(), tag = `${word} ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const keep = String(v || '').slice(0, 200 - tag.length - 2).trim();
  return keep ? keep + ', ' + tag : tag;
}

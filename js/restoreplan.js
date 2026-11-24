/* What a restore would change on this tablet, and the archived copies that keep what it would otherwise lose (a chart, or a mark).
   planRestore() reads only records and ink pages (no PDF bytes) and decides; buildKeeps() reads the stored PDFs of the charts to keep,
   after the person said Restore. Nothing is written here: js/backup.js writes the copies in the restore's own ONE putAll.

   The rule is about LOSS, not difference: a copy is made exactly when the restore would leave this tablet without a chart or a mark
   it has now. A live song here is LOST when the restore writes over its id (the backup has it live with another chart or without
   some of its marks, or has it deleted and the deletion is not older than the song here) and no live song in the backup HOLDS it: has
   the same chart (PDF hash) and every live mark of every page, exactly. Restoring the same backup twice, or a backup newer than this
   tablet, therefore makes no copies. A setlist changed here after the backup was made is kept as "<name> (before restore)". */
import {all, get, inkEntries, ensureHashes, upgradeInk, sha256, stamp} from './store.js';
import {canon} from './syncmerge.js';
import {unique} from './util.js';
import {archivedCopyOps, oldVersion} from './newversion.js';
import {mb} from './zipread.js';

/* The charts kept in one restore are held in memory until the one write: more than this is refused (the tests lower it). */
export const keepLimits = {maxBytes:300e6};
export const KEEP_WORD = 'before restore';           // "War Pigs (before restore 2026-11-23) - Black Sabbath"
export const SET_TAG = ' (before restore)';          // "Gig October 18 (before restore)"

const json = v => JSON.parse(JSON.stringify(v));
/* One record or stroke as canonical text; null when it cannot be (never equal to anything: "not held", so it is kept). */
const key = v => { try{ return canon(json(v)); }catch(e){ return null; } };
const live = list => list.filter(x => !x.deleted);
const num = v => Number(v) || 0;
const strip = (r, drop) => { const c = {...r}; for(const k of drop) delete c[k]; return c; };
const sameRecord = (a, b, drop = ['updated']) => { const x = key(strip(a, drop)); return x !== null && x === key(strip(b, drop)); };
/* the live strokes of a page as one text, in no particular order (null: one cannot be compared) */
const sig = list => { const k = list.map(key); return k.includes(null) ? null : k.sort().join('\n'); };
const plain = msg => Object.assign(new Error(msg), {plain:msg});
/* The putAll() check for a record or page as read: none, or no `updated` (an old bare-list page): it must still have none; a number or
   text: exactly that; anything else (an object, NaN) cannot be compared once read again, so it is written over unguarded, as before. */
export const ifUpdatedOf = u => u == null ? {ifUpdated:null} : (typeof u === 'string' || Number.isFinite(u)) ? {ifUpdated:u} : {};
export const KEPT = 'restore';                       // a kept setlist copy carries kept:'restore', so a later restore keeps it true

/* The name a kept setlist gets: its own, cut so the whole stays within 200 characters (never half a character), plus the tag, and
   " (n)" for the n-th copy of the same name (n > 1). */
export function copyName(name, n = 1){
  let base = String(name || '');
  const suffix = n > 1 ? ` (${n})` : '', room = 200 - SET_TAG.length - suffix.length;
  if(base.length > room) base = base.slice(0, /[\uD800-\uDBFF]/.test(base[room - 1]) ? room - 1 : room);
  return base.trimEnd() + SET_TAG + suffix;
}

/* data: the checked backup (its live songs and setlists already upgraded, bad gig dates already dropped); incoming: Map song id ->
   {hash} for every live song of the backup (the SHA-256 of its PDF, computed while checking). Resolves to the plan:
   {empty, songs:{add, back, changed:[{id, title, newer, keep}], removed:[{id, title, keep}], stay, noPdf, unreadable:[{id, title, marksOnly}]},
    sets:{add, back, changed:[{id, name, newer, keep}], removed:[{id, name}], stay}, colls:{add, back, changed, removed, stay},
    keep:[{song, marks}], keepBytes, keepSets:[{set, name}], heldBy (Map song id -> the id of the song that holds it), here:{songs, sets, colls} (Maps of the records read), inkHere, incoming, taken}. */
export async function planRestore(data, incoming, {raw = null, unreadable = new Set()} = {}){
  /* the `updated` each backup record had BEFORE the upgrade (an old record with none gets "now" from the upgrade, which would make
     every change made here look older than the backup): missing counts as 0 */
  const bU = (store, b) => raw && raw[store] && raw[store].has(b.id) ? raw[store].get(b.id) : num(b.updated);
  await ensureHashes().catch(() => {});
  const byId = list => new Map(list.map(r => [r.id, r]));
  const here = {songs:byId(await all('songs')), sets:byId(await all('sets')), colls:byId(await all('colls'))};
  const inkHere = new Map(await inkEntries()), ink = data.ink || {};
  const pageHere = k => live(upgradeInk(inkHere.get(k)).record.strokes);
  const pageThere = k => live(upgradeInk(ink[k]).record.strokes);
  const marksHere = t => { const m = new Map(); for(let p = 1; p <= num(t.pages); p++){ const l = pageHere(t.id + ':' + p); if(l.length) m.set(p, l); } return m; };
  const liveHere = (store, id) => { const r = here[store].get(id); return r && !r.deleted ? r : null; };
  /* What STAYS here as it is (the restore does not write over it): a live record whose id is not in the backup, or whose deletion in
     the backup is older than it. A chart and marks such a song holds are not lost either (an earlier "(before restore)" copy, say). */
  const inBackup = list => new Map((list || []).map(r => [r.id, r]));
  const bSongs = inBackup(data.songs), bSets = inBackup(data.sets), bColls = inBackup(data.colls);
  const stays = (r, b) => !r.deleted && (!b || (b.deleted && num(r.updated) > num(b.updated)));
  /* chart hash -> the songs that will hold that chart after the restore: the backup's live songs (marks from the backup) and the songs
     here that stay (marks from this tablet) */
  const holders = new Map(), addHolder = (hash, h) => { const k = String(hash || '').toLowerCase(); if(!k) return; if(!holders.has(k)) holders.set(k, []); holders.get(k).push(h); };
  for(const [id, {hash}] of incoming) addHolder(hash, {id, crop:(bSongs.get(id) || {}).crop, page:p => pageThere(id + ':' + p)});
  for(const r of here.songs.values()) if(stays(r, bSongs.get(r.id))) addHolder(r.hash, {id:r.id, tablet:true, crop:r.crop, page:p => pageHere(r.id + ':' + p)});
  /* a song here is trusted as a holder only once its whole PDF has been read (once per song): a record's hash alone is not the chart,
     and a PDF that is missing or reads only in part holds nothing */
  const fullOk = new Map(), wholeFile = id => { if(!fullOk.has(id)) fullOk.set(id, (async () => { try{ const f = await get('files', id); if(!f) return false; await f.arrayBuffer(); return true; }catch(err){ return false; } })()); return fullOk.get(id); };
  /* held: the id of a song that stays after the restore with the same chart and every live mark (by full content; withCrop: and the
     same crop), the song itself first; null when none does */
  const holds = (h, t, marks, withCrop) => (!withCrop || key(h.crop === undefined ? null : h.crop) === key(t.crop === undefined ? null : t.crop)) &&
    [...marks].every(([p, list]) => { const there = new Set(h.page(p).map(key)); return list.every(s => { const k = key(s); return k !== null && there.has(k); }); });
  const held = async (t, marks, withCrop) => {
    if(!t.hash) return null;
    const hs = holders.get(String(t.hash).toLowerCase()) || [];
    /* another song (a Copy-song twin) holds it only with the same crop too: the kept setlist would play it instead */
    for(const h of [...hs.filter(h => h.id === t.id), ...hs.filter(h => h.id !== t.id)]) if(holds(h, t, marks, withCrop || h.id !== t.id) && (!h.tablet || await wholeFile(h.id))) return h.id;
    return null;
  };
  const marksDiffer = (t, b, marks) => { for(let p = 1; p <= Math.max(num(t.pages), num(b.pages)); p++){ const a = sig(marks.get(p) || []); if(a === null || a !== sig(pageThere(b.id + ':' + p))) return true; } return false; };
  const inkNewer = t => { for(let p = 1; p <= num(t.pages); p++){ const k = t.id + ':' + p, raw = inkHere.get(k); if(raw && num(raw.updated) > num(ink[k] && ink[k].updated)) return true; } return false; };

  const songs = {add:0, back:0, changed:[], removed:[], stay:0, newerKept:0, noPdf:0, unreadable:[]}, keep = [], heldBy = new Map();
  let keepBytes = 0;
  /* The song here is lost unless a song that stays holds it (a crop changed here after the backup counts too: withCrop). A copy needs
     its stored PDF: none here, or one this tablet cannot read, means it cannot be kept (counted and said). Reading the tablet's own
     files never stops a restore. */
  /* heldBy: a song held by ANOTHER song (a Copy-song twin, an earlier copy): a kept setlist plays that one instead. chartSafe: the
     backup puts the same chart back under this id (only the marks are at risk). `unreadable`: ids whose full read failed at the keep step. */
  const lose = async (t, marks, withCrop = false, chartSafe = false) => {
    const by = await held(t, marks, withCrop);
    if(by){ if(by !== t.id) heldBy.set(t.id, by); return false; }
    const cannot = () => { songs.unreadable.push({id:t.id, title:t.title, marksOnly:chartSafe}); return false; };
    if(unreadable.has(t.id)) return cannot();
    let f;
    try{ f = await get('files', t.id); if(f) await f.slice(0, 1).arrayBuffer(); }catch(err){ return cannot(); }
    if(!f){ if(marks.size) songs.noPdf++; return false; }
    keep.push({song:t, marks}); keepBytes += num(f.size);
    return true;
  };
  for(const b of data.songs){
    const t = liveHere('songs', b.id);
    if(b.deleted){
      if(!t) continue;                                                // nothing here to delete
      if(num(t.updated) > bU('songs', b)){ songs.newerKept++; continue; }   // changed here after the backup deleted it: kept as it is
      songs.removed.push({id:t.id, title:t.title, keep:await lose(t, marksHere(t))});
      continue;
    }
    if(!t){ if(here.songs.has(b.id)) songs.back++; else songs.add++; continue; }
    const marks = marksHere(t), there = incoming.get(b.id);
    const differs = String(t.hash || '').toLowerCase() !== (there && there.hash) || !sameRecord(t, b, ['updated', 'hash']) || marksDiffer(t, b, marks);
    if(!differs) continue;
    const newer = num(t.updated) > bU('songs', b) || inkNewer(t);
    /* a crop made here after the backup is kept with the chart (the backup would put its own crop, or none, back) */
    const cropNewer = num(t.updated) > bU('songs', b) && key(t.crop === undefined ? null : t.crop) !== key(b.crop === undefined ? null : b.crop);
    songs.changed.push({id:t.id, title:t.title, newer, keep:await lose(t, marks, cropNewer, String(t.hash || '').toLowerCase() === (there && there.hash))});
  }
  for(const t of here.songs.values()) if(!t.deleted && !bSongs.has(t.id)) songs.stay++;

  /* what a setlist plays, item by item: each song as its chart and live marks here (a kept copy's items point at the archived copies,
     which hold the same chart and marks), each break by its name (a kept copy gets fresh break ids) */
  const plays = id => { const r = liveHere('songs', id); if(!r) return 'missing:' + id; const m = []; for(let p = 1; p <= num(r.pages); p++) m.push(sig(pageHere(id + ':' + p))); return key({h:String(r.hash || '').toLowerCase(), m}); };
  const itemsKey = st => key((Array.isArray(st.items) ? st.items : []).map(it => !it ? null : it.type === 'break' ? {type:'break', name:it.name} : it.type === 'song' ? {type:'song', plays:plays(it.id)} : it));
  const setNames = new Set([...here.sets.values()].filter(r => !r.deleted).map(r => r.name).concat(data.sets.filter(r => !r.deleted).map(r => r.name)));
  const sets = {add:0, back:0, changed:[], removed:[], stay:0, newerKept:0}, keepSets = [];
  for(const b of data.sets){
    const t = liveHere('sets', b.id);
    if(b.deleted){
      if(!t) continue;
      if(num(t.updated) > bU('sets', b)){ sets.newerKept++; continue; }
      sets.removed.push({id:t.id, name:t.name});      // no copy: the deletion only wins over a setlist here that is not newer
      continue;
    }
    if(!t){ if(here.sets.has(b.id)) sets.back++; else sets.add++; continue; }
    if(sameRecord(t, b)) continue;
    const newer = num(t.updated) > bU('sets', b);
    const copyNamed = name => { for(let n = 1; n <= setNames.size + 1; n++) if(name === copyName(t.name, n)) return true; return false; };
    /* an earlier "(before restore)" copy with the same songs, breaks, gig date and collections that stays here already keeps it: no second copy */
    const already = newer && [...here.sets.values()].some(r => stays(r, bSets.get(r.id)) && r !== t && copyNamed(r.name) && itemsKey(r) === itemsKey(t) && key(r.gig === undefined ? null : r.gig) === key(t.gig === undefined ? null : t.gig) && key(r.colls || []) === key(t.colls || []));
    sets.changed.push({id:t.id, name:t.name, newer, keep:newer && !already});
    if(newer && !already){
      let n = 1, name = copyName(t.name);
      while(setNames.has(name)) name = copyName(t.name, ++n);
      setNames.add(name);
      keepSets.push({set:t, name});
    }
  }
  for(const t of here.sets.values()) if(!t.deleted && !bSets.has(t.id)) sets.stay++;

  /* Setlists the restore does not write over (not in the backup, changed here after the backup deleted them, or the same in the
     backup) that play a song this restore replaces or deletes. An ordinary one is never written (a stamp would make it beat the other
     tablet's copy at the next Sync): it plays the backup's version, and a row whose song the backup deletes is hidden when the list is
     drawn (liveItems), the record unchanged; it is named in the question. An earlier
     "(before restore)" copy (kept:'restore') is repointed in place to the new archived copy or the song holding the chart, so it still
     plays exactly what it played. */
  const removedIds = new Set(songs.removed.map(x => x.id)), touched = new Set([...keep.map(k => k.song.id), ...heldBy.keys()]);
  const staying = {play:[], drop:[], keptFix:[]}, affected = new Set();
  for(const r of here.sets.values()){
    if(r.deleted) continue;
    const b = bSets.get(r.id), untouched = stays(r, b), same = !!b && !b.deleted && sameRecord(r, b);
    if(!untouched && !same) continue;
    const ids = (Array.isArray(r.items) ? r.items : []).filter(it => it && it.type === 'song').map(it => it.id);
    /* needsCopy: it plays a song that only an archived copy made by this restore keeps (none when the person restores without copies) */
    if(untouched && r.kept === KEPT){ if(ids.some(id => touched.has(id))){ staying.keptFix.push({set:r, id:r.id, name:r.name, needsCopy:ids.some(id => keep.some(k => k.song.id === id))}); affected.add(r.id); } continue; }
    const drop = untouched ? ids.filter(id => removedIds.has(id)) : [];
    if(drop.length){ staying.drop.push({set:r, ids:drop}); affected.add(r.id); }
    if(ids.some(id => touched.has(id) && !removedIds.has(id))){ staying.play.push({id:r.id, name:r.name}); affected.add(r.id); }
  }
  /* "stays as it is" is never said of a setlist this restore changes or that will play another version */
  const anyStays = songs.stay + sets.stay + songs.newerKept + sets.newerKept > 0;
  sets.stay = [...here.sets.values()].filter(t => !t.deleted && !bSets.has(t.id) && !affected.has(t.id)).length;
  sets.newerKept = [...here.sets.values()].filter(t => !t.deleted && bSets.has(t.id) && bSets.get(t.id).deleted && stays(t, bSets.get(t.id)) && !affected.has(t.id)).length;

  const colls = {add:0, back:0, changed:[], removed:[], stay:0, newerKept:0};
  for(const b of data.colls || []){
    const t = liveHere('colls', b.id);
    if(b.deleted){ if(t){ if(num(t.updated) > bU('colls', b)) colls.newerKept++; else colls.removed.push({id:t.id, name:t.name}); } continue; }
    if(!t){ if(here.colls.has(b.id)) colls.back++; else colls.add++; continue; }
    if(!sameRecord(t, b)) colls.changed.push({id:t.id, name:t.name, newer:num(t.updated) > bU('colls', b)});
  }
  for(const t of here.colls.values()) if(!t.deleted && !bColls.has(t.id)) colls.stay++;

  const empty = ![...here.songs.values(), ...here.sets.values(), ...here.colls.values()].some(r => !r.deleted);
  /* the copies' fresh ids must not collide with a record here NOR with one the same write is about to put */
  const taken = new Set([...here.songs.keys(), ...here.sets.keys(), ...here.colls.keys(), ...data.songs.map(r => r.id), ...data.sets.map(r => r.id), ...(data.colls || []).map(r => r.id)]);
  return {empty, songs, sets, colls, keep, keepBytes, keepSets, heldBy, staying, anyStays:anyStays || colls.stay + colls.newerKept > 0, here, inkHere, incoming, taken};
}

/* The copies' ops, after the person said Restore: each lost chart's stored bytes (read now, one at a time) as a new archived song with
   its crop, collections and live marks, and each kept setlist under a fresh id and its free name, its songs that this restore copies
   pointing at their copies (so it plays what it played before). {copies:false}: the person chose "Restore without keeping copies"
   (the charts were too big to keep): nothing is copied. Resolves to {ops, charts, sets, setNames}, or null when Stop was pressed.
   Throws an Error with a plain sentence (`plain`) when a chart the question promised to keep cannot be read now (the question counted
   every chart it could not read: what is written must be what it said), or the charts are too big after all. */
export async function buildKeeps(plan, job, {copies = true} = {}){
  const ops = [], copyOf = new Map();
  let spent = 0, charts = 0, n = 0;
  for(const {song:t, marks} of copies ? plan.keep : []){
    if(job.stopped) return null;
    job.say(`Keeping chart ${++n} of ${plan.keep.length}…`);
    /* COPY the bytes (Safari: a Blob read back from the files store can follow the record this write replaces) */
    let f, bytes;
    /* a chart whose first byte read in the plan but whose whole file cannot be read now: nothing is written, and restoreFrom asks again
       with it counted (and named) as a chart that cannot be kept */
    try{ f = await get('files', t.id); if(f) bytes = await f.arrayBuffer(); }catch(err){ throw Object.assign(plain(`"${t.title}" could not be read, so it cannot be kept. Nothing was changed.`), {unreadable:t.id}); }
    if(!f) continue;                                                  // gone since the plan: the song's own guard refuses the write
    if((spent += bytes.byteLength) > keepLimits.maxBytes) throw plain(`This restore would replace more charts than the tablet can keep in one go (more than ${mb(keepLimits.maxBytes)}). Nothing was changed.`);
    const made = archivedCopyOps(t, bytes, await sha256(bytes), oldVersion(t.version, KEEP_WORD), plan.taken, marks);
    ops.push(...made.ops); copyOf.set(t.id, made.copy.id);
    charts++;
  }
  if(job.stopped) return null;
  const t0 = Date.now(), setNames = [];
  for(const {set:st, name} of copies ? plan.keepSets : []){
    const c = json(st);
    Object.assign(c, {id:unique(plan.taken), name, created:t0, updated:t0, kept:KEPT});
    c.items = (Array.isArray(c.items) ? c.items : []).map(it => !it ? it
      : it.type === 'break' ? {...it, id:unique(plan.taken)}                                    // fresh break ids, as Duplicate does
      : it.type === 'song' && copyOf.has(it.id) ? {...it, id:copyOf.get(it.id)}                 // the chart it played, now in Archived
      : it.type === 'song' && plan.heldBy.has(it.id) ? {...it, id:plan.heldBy.get(it.id)} : it); // or held by another song that stays
    ops.push({store:'sets', key:c.id, value:c, ifUpdated:null});
    setNames.push(c.name);
  }
  /* an earlier kept copy that stays points at the new archived copy or the holder (only copies made here: none without copies), stamped
     over the record as read and guarded (a change made meanwhile refuses the whole write); ordinary staying setlists are not written */
  const playsNow = id => copyOf.get(id) || plan.heldBy.get(id) || id;
  for(const {set:st} of plan.staying.keptFix){
    const items = st.items.map(it => it && it.type === 'song' && playsNow(it.id) !== it.id ? {...it, id:playsNow(it.id)} : it);
    if(items.some((it, i) => it !== st.items[i])) ops.push({store:'sets', key:st.id, value:{...st, items, updated:stamp(st)}, ...ifUpdatedOf(st.updated)});
  }
  return {ops, charts, sets:setNames.length, setNames};
}

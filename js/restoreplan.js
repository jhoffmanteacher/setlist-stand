/* What a restore would change on this tablet, and the archived copies that keep what it would otherwise lose (a chart, or a mark).
   planRestore() reads only records and ink pages (no PDF bytes) and decides; buildKeeps() reads the stored PDFs of the charts to keep,
   after the person said Restore. Nothing is written here: js/backup.js writes the copies in the restore's own ONE putAll.

   The rule is about LOSS, not difference: a copy is made exactly when the restore would leave this tablet without a chart or a mark
   it has now. A live song here is LOST when the restore writes over its id (the backup has it live with another chart or without
   some of its marks, or has it deleted and the deletion is not older than the song here) and no live song in the backup HOLDS it: has
   the same chart (PDF hash) and every live mark of every page, exactly. Restoring the same backup twice, or a backup newer than this
   tablet, therefore makes no copies. A setlist changed here after the backup was made is kept as "<name> (before restore)". */
import {all, get, inkEntries, ensureHashes, upgradeInk, sha256} from './store.js';
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

/* The name a kept setlist gets: its own, cut so the whole stays within 200 characters (never half a character), plus the tag. */
export function copyName(name){
  let base = String(name || '');
  const room = 200 - SET_TAG.length;
  if(base.length > room) base = base.slice(0, /[\uD800-\uDBFF]/.test(base[room - 1]) ? room - 1 : room);
  return base.trimEnd() + SET_TAG;
}

/* data: the checked backup (its live songs and setlists already upgraded, bad gig dates already dropped); incoming: Map song id ->
   {hash} for every live song of the backup (the SHA-256 of its PDF, computed while checking). Resolves to the plan:
   {empty, songs:{add, back, changed:[{id, title, newer, keep}], removed:[{id, title, keep}], stay, noPdf},
    sets:{add, back, changed:[{id, name, newer, keep}], removed:[{id, name}], stay}, colls:{add, back, changed, removed, stay},
    keep:[{song, marks}], keepBytes, keepSets:[set record], here:{songs, sets, colls} (Maps of the records read), inkHere, incoming, taken}. */
export async function planRestore(data, incoming){
  await ensureHashes().catch(() => {});
  const byId = list => new Map(list.map(r => [r.id, r]));
  const here = {songs:byId(await all('songs')), sets:byId(await all('sets')), colls:byId(await all('colls'))};
  const inkHere = new Map(await inkEntries()), ink = data.ink || {};
  const pageHere = k => live(upgradeInk(inkHere.get(k)).record.strokes);
  const pageThere = k => live(upgradeInk(ink[k]).record.strokes);
  const marksHere = t => { const m = new Map(); for(let p = 1; p <= num(t.pages); p++){ const l = pageHere(t.id + ':' + p); if(l.length) m.set(p, l); } return m; };
  /* chart hash -> the backup's live songs with that chart */
  const byHash = new Map();
  for(const [id, {hash}] of incoming){ if(!byHash.has(hash)) byHash.set(hash, []); byHash.get(hash).push(id); }
  const held = (t, marks) => !!t.hash && (byHash.get(String(t.hash).toLowerCase()) || []).some(y =>
    [...marks].every(([p, list]) => { const there = new Set(pageThere(y + ':' + p).map(key)); return list.every(s => { const k = key(s); return k !== null && there.has(k); }); }));
  const marksDiffer = (t, b, marks) => { for(let p = 1; p <= Math.max(num(t.pages), num(b.pages)); p++){ const a = sig(marks.get(p) || []); if(a === null || a !== sig(pageThere(b.id + ':' + p))) return true; } return false; };
  const inkNewer = t => { for(let p = 1; p <= num(t.pages); p++){ const k = t.id + ':' + p, raw = inkHere.get(k); if(raw && num(raw.updated) > num(ink[k] && ink[k].updated)) return true; } return false; };
  const liveHere = (store, id) => { const r = here[store].get(id); return r && !r.deleted ? r : null; };

  const songs = {add:0, back:0, changed:[], removed:[], stay:0, noPdf:0}, keep = [];
  let keepBytes = 0;
  /* the song here is lost unless the backup holds it; a copy needs its stored PDF (none here: only the marks are lost, and said) */
  const lose = async (t, marks) => {
    if(held(t, marks)) return false;
    const f = await get('files', t.id);
    if(!f){ if(marks.size) songs.noPdf++; return false; }
    keep.push({song:t, marks}); keepBytes += num(f.size);
    return true;
  };
  for(const b of data.songs){
    const t = liveHere('songs', b.id);
    if(b.deleted){
      if(!t) continue;                                                // nothing here to delete
      if(num(t.updated) > num(b.updated)){ songs.stay++; continue; }   // newer here than the deletion: kept as it is
      songs.removed.push({id:t.id, title:t.title, keep:await lose(t, marksHere(t))});
      continue;
    }
    if(!t){ if(here.songs.has(b.id)) songs.back++; else songs.add++; continue; }
    const marks = marksHere(t), there = incoming.get(b.id);
    const differs = String(t.hash || '').toLowerCase() !== (there && there.hash) || !sameRecord(t, b, ['updated', 'hash']) || marksDiffer(t, b, marks);
    if(!differs) continue;
    songs.changed.push({id:t.id, title:t.title, newer:num(t.updated) > num(b.updated) || inkNewer(t), keep:await lose(t, marks)});
  }
  const inBackup = store => new Set((store === 'songs' ? data.songs : store === 'sets' ? data.sets : data.colls || []).map(r => r.id));
  const songIds = inBackup('songs');
  for(const t of here.songs.values()) if(!t.deleted && !songIds.has(t.id)) songs.stay++;

  const sets = {add:0, back:0, changed:[], removed:[], stay:0}, keepSets = [];
  for(const b of data.sets){
    const t = liveHere('sets', b.id);
    if(b.deleted){
      if(!t) continue;
      if(num(t.updated) > num(b.updated)){ sets.stay++; continue; }
      sets.removed.push({id:t.id, name:t.name});      // no copy: the deletion only wins over a setlist here that is not newer
      continue;
    }
    if(!t){ if(here.sets.has(b.id)) sets.back++; else sets.add++; continue; }
    if(sameRecord(t, b)) continue;
    const newer = num(t.updated) > num(b.updated);
    sets.changed.push({id:t.id, name:t.name, newer, keep:newer});
    if(newer) keepSets.push(t);
  }
  const setIds = inBackup('sets');
  for(const t of here.sets.values()) if(!t.deleted && !setIds.has(t.id)) sets.stay++;

  const colls = {add:0, back:0, changed:0, removed:0, stay:0};
  for(const b of data.colls || []){
    const t = liveHere('colls', b.id);
    if(b.deleted){ if(t){ if(num(t.updated) > num(b.updated)) colls.stay++; else colls.removed++; } continue; }
    if(!t){ if(here.colls.has(b.id)) colls.back++; else colls.add++; continue; }
    if(!sameRecord(t, b)) colls.changed++;
  }
  const collIds = inBackup('colls');
  for(const t of here.colls.values()) if(!t.deleted && !collIds.has(t.id)) colls.stay++;

  const empty = ![...here.songs.values(), ...here.sets.values(), ...here.colls.values()].some(r => !r.deleted);
  /* the copies' fresh ids must not collide with a record here NOR with one the same write is about to put */
  const taken = new Set([...here.songs.keys(), ...here.sets.keys(), ...here.colls.keys(), ...data.songs.map(r => r.id), ...data.sets.map(r => r.id), ...(data.colls || []).map(r => r.id)]);
  return {empty, songs, sets, colls, keep, keepBytes, keepSets, here, inkHere, incoming, taken};
}

/* The copies' ops, after the person said Restore: each lost chart's stored bytes (read now, one at a time) as a new archived song with
   its crop, collections and live marks, and each kept setlist under a fresh id. Resolves to {ops, charts, sets, setNames}, or null
   when Stop was pressed. Throws an Error with a plain sentence (`plain`) when a chart cannot be read or the charts are too big. */
export async function buildKeeps(plan, job){
  const ops = [];
  let spent = 0, charts = 0, n = 0;
  for(const {song:t, marks} of plan.keep){
    if(job.stopped) return null;
    job.say(`Keeping chart ${++n} of ${plan.keep.length}…`);
    const f = await get('files', t.id); if(!f) continue;             // gone since the plan: the song's own guard refuses the write
    if((spent += num(f.size)) > keepLimits.maxBytes) throw plain(`This restore would replace more charts than the tablet can keep in one go (more than ${mb(keepLimits.maxBytes)}). Nothing was changed.`);
    /* COPY the bytes (Safari: a Blob read back from the files store can follow the record this write replaces); a chart that is there
       but cannot be read stops the restore, as New version does: it must never be written over */
    let bytes;
    try{ bytes = await f.arrayBuffer(); }catch(err){ throw plain('A chart on this tablet could not be read, so it cannot be kept. Nothing was changed.'); }
    ops.push(...archivedCopyOps(t, bytes, await sha256(bytes), oldVersion(t.version, KEEP_WORD), plan.taken, marks).ops);
    charts++;
  }
  if(job.stopped) return null;
  const t0 = Date.now(), setNames = [];
  for(const st of plan.keepSets){
    const c = json(st);
    Object.assign(c, {id:unique(plan.taken), name:copyName(st.name), created:t0, updated:t0});
    c.items = (Array.isArray(c.items) ? c.items : []).map(it => it && it.type === 'break' ? {...it, id:unique(plan.taken)} : it);   // fresh break ids, as Duplicate does
    ops.push({store:'sets', key:c.id, value:c, ifUpdated:null});
    setNames.push(c.name);
  }
  return {ops, charts, sets:setNames.length, setNames};
}

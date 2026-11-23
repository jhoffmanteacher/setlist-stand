import {toast, saveBlob, hooks, busy} from './util.js';
import {explainError} from './errors.js';
import {gigOf} from './gigdate.js';
import {get, all, load, state, upgradeSong, upgradeSet, upgradeInk, ensureHashes, putAll, sha256, ID_RE} from './store.js';
import {crc32, readCapped, directoryProblem, NOT_PACKAGE, TOO_MANY, mb} from './zipread.js';
import {planRestore, buildKeeps} from './restoreplan.js';
import {askRestore, restoredText, showRestored} from './restoreask.js';

/* Backup version 3: library.json has songs, sets, colls (collections) and ink (with their deletion markers); files/<id>.pdf holds
   each live song's PDF. Version 2 (no colls) and version 1 (the prototype and the MobileSheets converter) are still read, and
   restore with no collections. A backup with a higher version is refused. The version is only a gate for restoreFrom(); the
   per-record checks below (ID_RE, LIMITS, okId, okText, okPage) do not depend on it. */
export const BACKUP_VERSION = 3;
export const LAST_BACKUP = 'ss-last-backup';     // localStorage: time (ms) of the last backup that was saved
/* A backup must always restore. Restore is strict (every live song has its PDF, and the PDF matches the recorded hash), so
   each song's hash is computed here from the PDF actually stored, and a live song with no stored PDF is left out (and counted
   in `skipped`) rather than written as a record without a file. Resolves to {blob, skipped}. */
export async function makeBackup(job){
  const zip = new JSZip(), ink = {}, out = [];
  let skipped = 0, k = 0;
  const songs = await all('songs'), sets = await all('sets'), colls = await all('colls'), total = songs.filter(s => !s.deleted).length;
  for(const s of songs){
    if(job && job.stopped) return null;                    // Stop: nothing is made
    if(s.deleted){ out.push(s); continue; }
    if(job) job.say(`Packing song ${++k} of ${total}…`);
    const f = await get('files', s.id);
    if(!f){ skipped++; continue; }
    const buf = await f.arrayBuffer();
    zip.file('files/' + s.id + '.pdf', buf);
    out.push({...s, hash:await sha256(buf)});
    for(let p = 1; p <= s.pages; p++){
      const key = s.id + ':' + p, {record} = upgradeInk(await get('ink', key));
      if(record.strokes.length) ink[key] = record;
    }
  }
  if(job && job.stopped) return null;
  zip.file('library.json', JSON.stringify({app:'setlist-stand', version:BACKUP_VERSION, saved:new Date().toISOString(), songs:out, sets, colls, ink}));
  if(job) job.say('Making the backup file…');
  const blob = await zip.generateAsync({type:'blob'}, job ? m => job.say(`Making the backup file… ${Math.round(m.percent)}%`) : undefined);
  if(job && job.stopped) return null;                     // pressed during the last step, which cannot be interrupted: the file is thrown away
  return {blob, skipped};
}

/* Back up: a box says what it is doing ("Packing song 12 of 74…", then the percentage of the file) and has Stop, which
   works at any point and saves nothing (and leaves "last backup" as it was). */
export async function backupNow(b){
  if(!state.songs.length && !state.sets.length){ toast('Nothing to back up yet'); return; }
  const label = b.textContent;
  b.disabled = true; b.textContent = 'Working…';
  const job = busy('Backing up', 'Getting ready…');      // before the first await
  let saved = false;
  try{
    const made = await makeBackup(job);
    job.close();
    if(!made) toast('Backup stopped. Nothing was saved.');
    else if(saveBlob(made.blob, 'setlist-stand-backup-' + new Date().toISOString().slice(0, 10) + '.zip')){
      const {skipped} = made;
      saved = true;
      toast(skipped ? `Backup saved. ${skipped == 1 ? '1 song had' : skipped + ' songs had'} no PDF and ${skipped == 1 ? 'was' : 'were'} left out.` : 'Backup saved');
      try{ localStorage.setItem(LAST_BACKUP, String(Date.now())); }catch(e){}
    }
  }
  catch(err){ job.close(); toast(explainError(err, 'Backup failed. Nothing was lost.')); }
  b.disabled = false; b.textContent = label;
  if(saved) hooks.render();         // the backup reminder on the Library changes
}

/* Caps for reading a backup (changeable by the tests). A backup made by the app or the converter is STORED (not compressed), so what
   it unpacks to is about its own size; `ratio` and `slack` leave room for a backup someone re-zipped on a computer. maxFile: the
   file itself; maxDirectory: the zip's list of files, in bytes (about 100000 files); maxJson: library.json; the PDFs together may
   unpack to the file's size times `ratio` plus `slack`, and never more than 3 GB. */
export const restoreLimits = {maxFile:1.5e9, maxDirectory:10e6, maxJson:200e6, ratio:10, slack:100e6};

/* Restore is all or nothing. First everything is checked (the zip is readable and undamaged, library.json is ours,
   every song has its PDF and the PDF matches the hash the backup recorded); then, on a tablet that holds anything, the person is
   asked, in plain words, what will be replaced (js/restoreask.js); only then is it written, in one transaction, together with the
   archived copies of every chart and mark it would otherwise lose and a copy of every setlist changed here since the backup
   (js/restoreplan.js). Any problem, a Cancel, a change made meanwhile in another tab, or an interrupted page, leaves the library
   exactly as it was. Restored records keep the backup's own `updated` (a later Sync brings back what the other tablet changed since).
   opts.drive: Google Drive is set up on this tablet (the question then says what the next Sync does). */
export async function restoreFrom(f, render, {drive = false} = {}){
  if(!f) return;
  /* A box says what is happening, opened before the first await so nothing looks frozen: "Opening the backup…", "Checking
     song 12 of 74…", "Comparing with this tablet…", then (after the question) "Keeping chart 1 of 2…", "Saving to this tablet…".
     Stop works while it is only reading, checking and copying (nothing has been written yet) and says "Restore stopped. Nothing
     was changed."; from the one write on, Stop is taken away. */
  let job = busy('Restoring a backup', 'Opening the backup…');
  const stop = msg => { job.close(); toast(msg); };
  const wasStopped = () => { if(!job.stopped) return false; stop('Restore stopped. Nothing was changed.'); return true; };
  let data, zip, room = 0;
  if(f.size > restoreLimits.maxFile) return stop('That backup is too big for this tablet to open. Nothing was changed.');
  try{
    /* The zip's list of files is measured before JSZip opens it (it builds memory for every record), and it is opened WITHOUT
       checkCRC32, which would inflate every entry just to open it: a small file of deflated zeros could ask for gigabytes.
       Instead every entry is read against a cap, library.json is checked against the CRC-32 the zip records, and each PDF
       against its recorded SHA-256 (or its CRC-32 when the backup has no hash, as a version 1 backup may not). */
    const dir = await directoryProblem(f, restoreLimits.maxDirectory);
    if(dir === TOO_MANY) return stop('That backup has too many files in it. Nothing was changed.');
    if(dir === NOT_PACKAGE) return stop('That file is not a Setlist Stand backup');
    zip = await JSZip.loadAsync(f);
    const entry = zip.file('library.json');
    if(!entry) throw new Error('not a backup');
    /* a first, cheap refusal from the sizes the zip says it holds (they can lie: the reads below are the real guard) */
    room = Math.min(3e9, f.size * restoreLimits.ratio + restoreLimits.slack);
    let declared = 0;
    for(const e of Object.values(zip.files)) if(!e.dir && (e.name === 'library.json' || /^files\/[^/]+\.pdf$/.test(e.name))) declared += Number(e._data && e._data.uncompressedSize) || 0;
    if(declared > room) return stop('That backup is too big to read. Nothing was changed.');
    const raw = await readCapped(entry, Math.min(restoreLimits.maxJson, room));
    if(!raw) return stop('That backup is too big to read. Nothing was changed.');
    const want = entry._data && entry._data.crc32;
    if(typeof want !== 'number' || crc32(raw) !== want >>> 0) return stop('That backup is damaged. Nothing was changed.');
    room -= raw.length;
    data = JSON.parse(new TextDecoder().decode(raw));
    if(data.app !== 'setlist-stand' || !Array.isArray(data.songs) || !Array.isArray(data.sets)) throw new Error('not a backup');
  }catch(err){
    if(zip && zip.file('share.json')) return stop('That is a share package, not a backup. Use Import a share package. Nothing was changed.');
    return stop(/crc|corrupt/i.test(String(err && err.message)) ? 'That backup is damaged. Nothing was changed.' : 'That file is not a Setlist Stand backup');
  }
  if(wasStopped()) return;
  if(Number(data.version) > BACKUP_VERSION) return stop('That backup was made by a newer version of Setlist Stand. Update the app, then try again. Nothing was changed.');
  const bad = validateBackup(data);
  if(bad) return stop(`That backup has something the app can't read (${bad}). Nothing was changed.`);
  let n = 0, sets = 0, k = 0, badGig = 0, plan, keep;
  const total = data.songs.filter(s => !s.deleted).length, room0 = room, incoming = new Map();     // incoming: song id -> {blob, hash}
  try{
    for(const s of data.songs){
      if(wasStopped()) return;
      if(s.deleted) continue;
      job.say(`Checking song ${++k} of ${total}…`);
      const entry = zip.file('files/' + s.id + '.pdf');
      if(!entry) return stop(`That backup is missing the PDF for "${s.title || s.song || s.id}". Nothing was changed.`);
      const buf = await readCapped(entry, room);
      if(!buf) return stop(`That backup is too big to read: its PDFs add up to more than ${mb(room0)}. Nothing was changed.`);
      room -= buf.length;
      if(s.hash) s.hash = s.hash.toLowerCase();
      /* JSZip no longer checks CRCs: a PDF is checked against its recorded SHA-256, or against the zip's CRC-32 when there is none.
         The SHA-256 is kept either way: the plan compares the charts with it. */
      const h = await sha256(buf);
      if(s.hash ? h !== s.hash : crc32(buf) !== (entry._data && entry._data.crc32) >>> 0) return stop(`That backup is damaged ("${s.title || s.song || s.id}" does not match). Nothing was changed.`);
      upgradeSong(s);
      incoming.set(s.id, {blob:new Blob([buf], {type:'application/pdf'}), hash:h});
    }
    for(const st of data.sets){
      if(st.deleted) continue;
      /* A gig that is not a real date is dropped and counted (the rest of the setlist is kept, its `updated` as the backup has it);
         everywhere else a bad gig is just ignored when a list is drawn, and setProblem never refuses a set for it. */
      if(st.gig != null && !gigOf(st)){ delete st.gig; badGig++; }
      upgradeSet(st);
    }
    if(wasStopped()) return;
    job.say('Comparing with this tablet…');
    plan = await planRestore(data, incoming);
  }catch(err){ return stop(explainError(err, 'Could not restore that backup. Nothing was changed.')); }
  if(wasStopped()) return;
  /* An empty tablet (nothing live on it: deletion markers do not count) has nothing to lose, so it is not asked. Otherwise the box
     closes while the question is open (nothing has been written; an update reload there loses nothing) and a new one opens after. */
  let answer = 'keep';
  if(!plan.empty){
    job.close();
    answer = await askRestore(plan, data.saved, drive);
    if(!answer){ toast('Restore cancelled. Nothing was changed.'); return; }
    job = busy('Restoring a backup', 'Getting ready…');
  }
  try{ keep = await buildKeeps(plan, job, {copies:answer !== 'nokeep'}); }
  catch(err){ return stop(explainError(err, 'Could not restore that backup. Nothing was changed.')); }
  if(wasStopped() || !keep) return;
  try{
    const ops = [], skip = new Set(), here = plan.here;
    /* Every op that writes over or removes a record here carries the `updated` the plan read (null: there was none), so a change
       made while the question was open (another tab) refuses the whole write instead of being lost. A deletion marker only wins
       over a record here that is not newer than it. */
    /* (a record here whose `updated` is not a plain number cannot be compared exactly once read again: it is written over unguarded) */
    const exact = v => typeof v === 'number' && Number.isFinite(v);
    const guard = (store, id) => { const r = here[store].get(id); return !r ? {ifUpdated:null} : exact(r.updated) ? {ifUpdated:r.updated} : {}; };
    const newerHere = (store, m) => { const r = here[store].get(m.id); return !!r && !r.deleted && (Number(r.updated) || 0) > (Number(m.updated) || 0); };
    /* the pages of a live song here that the restore writes over or deletes: one guarded delete per page (a stroke drawn meanwhile,
       even on a blank page, makes the write stale), then {deleteInkFor} for any stray page */
    const inkGuards = id => {
      const t = here.songs.get(id), out = [];
      if(!t || t.deleted) return out;
      for(let p = 1; p <= (Number(t.pages) || 0); p++){
        const key = id + ':' + p, raw = plan.inkHere.get(key);
        out.push({store:'ink', key, delete:true, ...(raw == null ? {ifUpdated:null} : exact(raw.updated) ? {ifUpdated:raw.updated} : {})});
      }
      return out;
    };
    for(const s of data.songs){
      if(s.deleted){
        skip.add(s.id);                 // the backup has no annotations for a deleted song: any it lists are left out
        if(newerHere('songs', s)) continue;           // keep the newer song here, with its PDF and annotations
        /* a deleted song: its PDF and annotations on this tablet go too, in the same transaction (a copy is kept when they would be lost) */
        ops.push(...inkGuards(s.id), {store:'files', key:s.id, delete:true}, {deleteInkFor:s.id}, {store:'songs', key:s.id, value:marker(s), ...guard('songs', s.id)});
        continue;
      }
      /* this tablet's annotations of the song are replaced by the backup's (the ink puts come later in the same transaction) */
      ops.push(...inkGuards(s.id), {store:'files', key:s.id, value:incoming.get(s.id).blob}, {store:'songs', key:s.id, value:s, ...guard('songs', s.id)}, {deleteInkFor:s.id}); n++;
    }
    for(const st of data.sets){
      if(st.deleted){ if(!newerHere('sets', st)) ops.push({store:'sets', key:st.id, value:marker(st), ...guard('sets', st.id)}); continue; }
      ops.push({store:'sets', key:st.id, value:st, ...guard('sets', st.id)}); sets++;
    }
    for(const c of data.colls || []){                    // none in a version 1 or 2 backup
      if(c.deleted){ if(!newerHere('colls', c)) ops.push({store:'colls', key:c.id, value:marker(c), ...guard('colls', c.id)}); continue; }
      ops.push({store:'colls', key:c.id, value:c, ...guard('colls', c.id)});
    }
    for(const [k, v] of Object.entries(data.ink || {})) if(!skip.has(k.split(':')[0])) ops.push({store:'ink', key:k, value:upgradeInk(v).record});
    if(wasStopped()) return;
    job.lock('Saving to this tablet…');                 // the one write: from here Stop is gone, and Escape does nothing
    await putAll([...keep.ops, ...ops]);
    /* A restored library counts as backed up until the next change: the restored records are not "changes since the last backup".
       Only when the backup holds everything now here: not when copies were kept, nor when songs, setlists or collections that are
       not in the backup stay on this tablet (they are in no backup yet). */
    if(!keep.charts && !keep.sets && !plan.songs.stay && !plan.sets.stay && !plan.colls.stay) try{ localStorage.setItem(LAST_BACKUP, String(Date.now())); }catch(e){}
  }catch(err){
    return stop(err && err.name === 'StaleWrite' ? 'Something on this tablet changed while the restore was waiting. Nothing was changed. Try the restore again.'
      : explainError(err, 'Could not restore that backup. Nothing was changed.'));
  }
  /* The backup is written by now: a problem from here on must not say "Nothing was changed". */
  try{
    await load(); await ensureHashes(); job.close(); render();
    showRestored(restoredText(n, sets, badGig, keep));
  }catch(err){ stop('The backup was restored, but the screen did not update. Reload the app to see it.'); }
  job.close();
}

const marker = r => ({id:r.id, deleted:true, updated:Number(r.updated) || 0});

/* ---------- what a backup may hold ----------
   Checked before anything is written. Returns null when the backup is fine, else a short reason (shown to the user).
   Ids end up in the page's HTML and in storage keys, so they are held to a plain set of characters. */
export {ID_RE};                  // defined in js/store.js (cleanColls needs it too)
export const LIMITS = {songs:100000, sets:100000, colls:10000, collRefs:1000, items:20000, text:2000, pages:5000, strokes:50000, points:200000};
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
export const okId = id => typeof id === 'string' && ID_RE.test(id);
export const okText = v => v === undefined || v === null || (typeof v === 'string' && v.length <= LIMITS.text);
export const okPage = p => Number.isInteger(p) && p >= 1 && p <= LIMITS.pages;
const cut = v => JSON.stringify(String(v)).slice(0, 40);
/* A song's or setlist's `colls`: absent is fine (older backups); otherwise a list of plain ids. An id of a collection that is not in
   the backup is allowed (it is ignored when a list is drawn). Returns a reason, or null. */
function badColls(r, who){
  if(r.colls == null) return null;
  if(!Array.isArray(r.colls)) return `${who} has collections that are not a list`;
  if(r.colls.length > LIMITS.collRefs) return `${who} is in more than ${LIMITS.collRefs} collections`;
  for(const id of r.colls) if(!okId(id)) return `${who} has a collection id ${cut(id)}`;
  return null;
}
/* One record of each kind, checked on its own: null when it is fine, else the short reason. validateBackup() checks every record
   of a backup with them, and a sync checks every record that comes from Drive with them. A field this code does not know is
   allowed (a newer version may add one); a deletion marker needs only a plain id and `deleted: true`. */
export function songProblem(s){
  if(!isObj(s)) return 'a song that is not a record';
  if(!okId(s.id)) return 'a song id ' + cut(s.id);
  if(s.deleted){
    if(s.deleted !== true) return 'a deleted song marked ' + cut(s.deleted);
    if(s.updated != null && !Number.isFinite(Number(s.updated))) return 'a deleted song with time ' + cut(s.updated);
    return null;
  }
  if(!okPage(s.pages)) return `song ${s.id} has ${cut(s.pages)} pages`;
  for(const k of ['title', 'song', 'artist', 'version']) if(!okText(s[k])) return `song ${s.id} has a ${k} that is not short text`;
  const bad = badColls(s, `song ${s.id}`); if(bad) return bad;
  if(s.hash != null && !(typeof s.hash === 'string' && /^[0-9a-f]{64}$/.test(s.hash.toLowerCase()))) return `song ${s.id} has hash ${cut(s.hash)}`;
  return null;
}
export function setProblem(st){
  if(!isObj(st)) return 'a setlist that is not a record';
  if(!okId(st.id)) return 'a setlist id ' + cut(st.id);
  if(st.deleted){
    if(st.deleted !== true) return 'a deleted setlist marked ' + cut(st.deleted);
    return null;
  }
  if(typeof st.name !== 'string' || st.name.length > LIMITS.text) return `setlist ${st.id} has a name that is not short text`;
  const bad = badColls(st, `setlist ${st.id}`); if(bad) return bad;
  if(st.items != null){
    if(!Array.isArray(st.items)) return `setlist ${st.id} has items that are not a list`;
    if(st.items.length > LIMITS.items) return `setlist ${st.id} has more than ${LIMITS.items} items`;
    for(const it of st.items){
      if(!isObj(it)) return `setlist ${st.id} has an item that is not a record`;
      if(it.type === 'song'){ if(!okId(it.id)) return `setlist ${st.id} has a song id ${cut(it.id)}`; }
      else if(it.type === 'break'){
        if(!okId(it.id)) return `setlist ${st.id} has a break id ${cut(it.id)}`;
        if(typeof it.name !== 'string' || it.name.length > LIMITS.text) return `setlist ${st.id} has a break name that is not short text`;
      }
      else return `setlist ${st.id} has an item of type ${cut(it.type)}`;
    }
  } else if(st.songs != null){                       // version 1: songs:[ids]
    if(!Array.isArray(st.songs)) return `setlist ${st.id} has songs that are not a list`;
    if(st.songs.length > LIMITS.items) return `setlist ${st.id} has more than ${LIMITS.items} items`;
    for(const id of st.songs) if(!okId(id)) return `setlist ${st.id} has a song id ${cut(id)}`;
  }
  return null;
}
export function collProblem(c){
  if(!isObj(c)) return 'a collection that is not a record';
  if(!okId(c.id) || c.id === 'all') return 'a collection id ' + cut(c.id);       // "all" is the picker's own button
  if(c.deleted){
    if(c.deleted !== true) return 'a deleted collection marked ' + cut(c.deleted);
    return null;
  }
  if(typeof c.name !== 'string' || c.name.length > LIMITS.text) return `collection ${c.id} has a name that is not short text`;
  return null;
}
export function validateBackup(data){
  if(!isObj(data) || !Array.isArray(data.songs) || !Array.isArray(data.sets)) return 'no song or setlist list';
  if(data.songs.length > LIMITS.songs) return `more than ${LIMITS.songs} songs`;
  if(data.sets.length > LIMITS.sets) return `more than ${LIMITS.sets} setlists`;
  if(data.ink != null && !isObj(data.ink)) return 'the annotations are not a list of pages';
  if(data.colls != null){                                  // a version 1 or 2 backup has none
    if(!Array.isArray(data.colls)) return 'the collections are not a list';
    if(data.colls.length > LIMITS.colls) return `more than ${LIMITS.colls} collections`;
  }
  for(const [list, what] of [[data.songs, 'song'], [data.sets, 'setlist'], [data.colls || [], 'collection']]){
    const seen = new Set();
    for(const r of list){ if(isObj(r) && okId(r.id)){ if(seen.has(r.id)) return `the ${what} id ${r.id} twice`; seen.add(r.id); } }
  }
  for(const [list, problem] of [[data.songs, songProblem], [data.sets, setProblem], [data.colls || [], collProblem]])
    for(const r of list){ const bad = problem(r); if(bad) return bad; }
  for(const [k, v] of Object.entries(data.ink || {})){ const bad = inkProblem(k, v); if(bad) return bad; }
  return null;
}
/* One ink page (key "songId:page", value {updated, strokes} or an old bare list), checked as a restore checks it: the key
   and the counts. Nothing else (a restore keeps a page whole). A sync checks a page from Drive with this first, then with
   inkShapeProblem() in js/syncink.js. */
export function inkProblem(k, v){
  const m = /^([^:]*):(\d+)$/.exec(k);
  if(!m || !okId(m[1]) || !okPage(Number(m[2]))) return 'an annotation page ' + cut(k);
  const strokes = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.strokes) ? v.strokes : [];
  if(strokes.length > LIMITS.strokes) return `page ${k} has more than ${LIMITS.strokes} strokes`;
  for(const s of strokes) if(isObj(s) && Array.isArray(s.p) && s.p.length > LIMITS.points) return `page ${k} has a stroke of more than ${LIMITS.points} points`;
  return null;
}

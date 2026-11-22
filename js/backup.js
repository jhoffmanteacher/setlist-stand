import {toast, saveBlob, hooks, busy} from './util.js';
import {explainError} from './errors.js';
import {get, all, load, state, upgradeSong, upgradeSet, upgradeInk, ensureHashes, putAll, sha256, ID_RE} from './store.js';

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

/* Restore is all or nothing. First everything is checked (the zip is readable and undamaged, library.json is ours,
   every song has its PDF and the PDF matches the hash the backup recorded); only then is it written, in one
   transaction. Any problem, or an interrupted page, leaves the library exactly as it was. */
export async function restoreFrom(f, render){
  if(!f) return;
  /* A box says what is happening, opened before the first await so nothing looks frozen: "Opening the backup…", "Checking
     song 12 of 74…", "Saving to this tablet…". Stop works while it is only reading and checking (nothing has been written
     yet) and says "Restore stopped. Nothing was changed."; from the one write on, Stop is taken away. */
  const job = busy('Restoring a backup', 'Opening the backup…');
  const stop = msg => { job.close(); toast(msg); };
  const wasStopped = () => { if(!job.stopped) return false; stop('Restore stopped. Nothing was changed.'); return true; };
  let data, zip;
  try{
    zip = await JSZip.loadAsync(f, {checkCRC32:true});
    data = JSON.parse(await zip.file('library.json').async('string'));
    if(data.app !== 'setlist-stand' || !Array.isArray(data.songs) || !Array.isArray(data.sets)) throw new Error('not a backup');
  }catch(err){
    if(zip && zip.file('share.json')) return stop('That is a share package, not a backup. Use Import a share package. Nothing was changed.');
    return stop(/crc/i.test(String(err && err.message)) ? 'That backup is damaged. Nothing was changed.' : 'That file is not a Setlist Stand backup');
  }
  if(wasStopped()) return;
  if(Number(data.version) > BACKUP_VERSION) return stop('That backup was made by a newer version of Setlist Stand. Update the app, then try again. Nothing was changed.');
  const bad = validateBackup(data);
  if(bad) return stop(`That backup has something the app can't read (${bad}). Nothing was changed.`);
  let n = 0, sets = 0, k = 0;
  const total = data.songs.filter(s => !s.deleted).length;
  try{
    const ops = [], skip = new Set();
    /* A deletion marker only wins over a record here that is not newer than it. */
    const local = {songs:new Map((await all('songs')).map(r => [r.id, r])), sets:new Map((await all('sets')).map(r => [r.id, r])), colls:new Map((await all('colls')).map(r => [r.id, r]))};
    const newerHere = (store, m) => { const r = local[store].get(m.id); return !!r && !r.deleted && (Number(r.updated) || 0) > (Number(m.updated) || 0); };
    for(const s of data.songs){
      if(wasStopped()) return;
      if(s.deleted){
        skip.add(s.id);                 // the backup has no annotations for a deleted song: any it lists are left out
        if(newerHere('songs', s)) continue;           // keep the newer song here, with its PDF and annotations
        /* a deleted song: its PDF and annotations on this tablet go too, in the same transaction */
        ops.push({store:'files', key:s.id, delete:true}, {deleteInkFor:s.id}, {store:'songs', key:s.id, value:marker(s)});
        continue;
      }
      job.say(`Checking song ${++k} of ${total}…`);
      const entry = zip.file('files/' + s.id + '.pdf');
      if(!entry) return stop(`That backup is missing the PDF for "${s.title || s.song || s.id}". Nothing was changed.`);
      const buf = await entry.async('arraybuffer');
      if(s.hash) s.hash = s.hash.toLowerCase();
      if(s.hash && await sha256(buf) !== s.hash) return stop(`That backup is damaged ("${s.title || s.song || s.id}" does not match). Nothing was changed.`);
      upgradeSong(s);
      /* this tablet's annotations of the song are replaced by the backup's (the ink puts come later in the same transaction) */
      ops.push({store:'files', key:s.id, value:new Blob([buf], {type:'application/pdf'})}, {store:'songs', key:s.id, value:s}, {deleteInkFor:s.id}); n++;
    }
    for(const st of data.sets){
      if(st.deleted){ if(!newerHere('sets', st)) ops.push({store:'sets', key:st.id, value:marker(st)}); continue; }
      upgradeSet(st); ops.push({store:'sets', key:st.id, value:st}); sets++;
    }
    for(const c of data.colls || []){                    // none in a version 1 or 2 backup
      if(c.deleted){ if(!newerHere('colls', c)) ops.push({store:'colls', key:c.id, value:marker(c)}); continue; }
      ops.push({store:'colls', key:c.id, value:c});
    }
    for(const [k, v] of Object.entries(data.ink || {})) if(!skip.has(k.split(':')[0])) ops.push({store:'ink', key:k, value:upgradeInk(v).record});
    if(wasStopped()) return;
    job.lock('Saving to this tablet…');                 // the one write: from here Stop is gone, and Escape does nothing
    await putAll(ops);
    /* A restored library counts as backed up until the next change: the restored records are not "changes since the last backup". */
    try{ localStorage.setItem(LAST_BACKUP, String(Date.now())); }catch(e){}
  }catch(err){ return stop(explainError(err, 'Could not restore that backup. Nothing was changed.')); }
  /* The backup is written by now: a problem from here on must not say "Nothing was changed". */
  try{
    await load(); await ensureHashes(); job.close(); render();
    toast(`Restored ${n} song${n == 1 ? '' : 's'} and ${sets} setlist${sets == 1 ? '' : 's'}`);
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
  for(const s of data.songs){
    if(!isObj(s)) return 'a song that is not a record';
    if(!okId(s.id)) return 'a song id ' + cut(s.id);
    if(s.deleted){
      if(s.deleted !== true) return 'a deleted song marked ' + cut(s.deleted);
      if(s.updated != null && !Number.isFinite(Number(s.updated))) return 'a deleted song with time ' + cut(s.updated);
      continue;
    }
    if(!okPage(s.pages)) return `song ${s.id} has ${cut(s.pages)} pages`;
    for(const k of ['title', 'song', 'artist', 'version']) if(!okText(s[k])) return `song ${s.id} has a ${k} that is not short text`;
    const bad = badColls(s, `song ${s.id}`); if(bad) return bad;
    if(s.hash != null && !(typeof s.hash === 'string' && /^[0-9a-f]{64}$/.test(s.hash.toLowerCase()))) return `song ${s.id} has hash ${cut(s.hash)}`;
  }
  for(const st of data.sets){
    if(!isObj(st)) return 'a setlist that is not a record';
    if(!okId(st.id)) return 'a setlist id ' + cut(st.id);
    if(st.deleted){
      if(st.deleted !== true) return 'a deleted setlist marked ' + cut(st.deleted);
      continue;
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
  }
  for(const c of data.colls || []){
    if(!isObj(c)) return 'a collection that is not a record';
    if(!okId(c.id) || c.id === 'all') return 'a collection id ' + cut(c.id);       // "all" is the picker's own button
    if(c.deleted){
      if(c.deleted !== true) return 'a deleted collection marked ' + cut(c.deleted);
      continue;
    }
    if(typeof c.name !== 'string' || c.name.length > LIMITS.text) return `collection ${c.id} has a name that is not short text`;
  }
  for(const [k, v] of Object.entries(data.ink || {})){
    const m = /^([^:]*):(\d+)$/.exec(k);
    if(!m || !okId(m[1]) || !okPage(Number(m[2]))) return 'an annotation page ' + cut(k);
    const strokes = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.strokes) ? v.strokes : [];
    if(strokes.length > LIMITS.strokes) return `page ${k} has more than ${LIMITS.strokes} strokes`;
    for(const s of strokes) if(isObj(s) && Array.isArray(s.p) && s.p.length > LIMITS.points) return `page ${k} has a stroke of more than ${LIMITS.points} points`;
  }
  return null;
}

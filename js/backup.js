import {toast, saveBlob, hooks} from './util.js';
import {explainError} from './errors.js';
import {get, all, load, state, upgradeSong, upgradeSet, upgradeInk, ensureHashes, putAll, sha256} from './store.js';

/* Backup version 2: library.json has songs, sets and ink (with their deletion markers); files/<id>.pdf holds each live song's PDF.
   Version 1 (the prototype and the MobileSheets converter) is still read. A backup with a higher version is refused. */
export const BACKUP_VERSION = 2;
export const LAST_BACKUP = 'ss-last-backup';     // localStorage: time (ms) of the last backup that was saved
/* A backup must always restore. Restore is strict (every live song has its PDF, and the PDF matches the recorded hash), so
   each song's hash is computed here from the PDF actually stored, and a live song with no stored PDF is left out (and counted
   in `skipped`) rather than written as a record without a file. Resolves to {blob, skipped}. */
export async function makeBackup(){
  const zip = new JSZip(), ink = {}, out = [];
  let skipped = 0;
  const songs = await all('songs'), sets = await all('sets');
  for(const s of songs){
    if(s.deleted){ out.push(s); continue; }
    const f = await get('files', s.id);
    if(!f){ skipped++; continue; }
    const buf = await f.arrayBuffer();
    zip.file('files/' + s.id + '.pdf', buf);
    out.push({...s, hash:await sha256(buf)});
    for(let p = 1; p <= s.pages; p++){
      const k = s.id + ':' + p, {record} = upgradeInk(await get('ink', k));
      if(record.strokes.length) ink[k] = record;
    }
  }
  zip.file('library.json', JSON.stringify({app:'setlist-stand', version:BACKUP_VERSION, saved:new Date().toISOString(), songs:out, sets, ink}));
  return {blob:await zip.generateAsync({type:'blob'}), skipped};
}

export async function backupNow(b){
  if(!state.songs.length && !state.sets.length){ toast('Nothing to back up yet'); return; }
  const label = b.textContent;
  b.disabled = true; b.textContent = 'Working…';
  let saved = false;
  try{
    const {blob, skipped} = await makeBackup();
    if(saveBlob(blob, 'setlist-stand-backup-' + new Date().toISOString().slice(0, 10) + '.zip')){
      saved = true;
      toast(skipped ? `Backup saved. ${skipped == 1 ? '1 song had' : skipped + ' songs had'} no PDF and ${skipped == 1 ? 'was' : 'were'} left out.` : 'Backup saved');
      try{ localStorage.setItem(LAST_BACKUP, String(Date.now())); }catch(e){}
    }
  }
  catch(err){ toast(explainError(err, 'Backup failed. Nothing was lost.')); }
  b.disabled = false; b.textContent = label;
  if(saved) hooks.render();         // the backup reminder on the Library changes
}

/* Restore is all or nothing. First everything is checked (the zip is readable and undamaged, library.json is ours,
   every song has its PDF and the PDF matches the hash the backup recorded); only then is it written, in one
   transaction. Any problem, or an interrupted page, leaves the library exactly as it was. */
export async function restoreFrom(f, render){
  if(!f) return;
  const stop = msg => { toast(msg); };
  let data, zip;
  try{
    zip = await JSZip.loadAsync(f, {checkCRC32:true});
    data = JSON.parse(await zip.file('library.json').async('string'));
    if(data.app !== 'setlist-stand' || !Array.isArray(data.songs) || !Array.isArray(data.sets)) throw new Error('not a backup');
  }catch(err){
    return stop(/crc/i.test(String(err && err.message)) ? 'That backup is damaged. Nothing was changed.' : 'That file is not a Setlist Stand backup');
  }
  if(Number(data.version) > BACKUP_VERSION) return stop('That backup was made by a newer version of Setlist Stand. Update the app, then try again. Nothing was changed.');
  const bad = validateBackup(data);
  if(bad) return stop(`That backup has something the app can't read (${bad}). Nothing was changed.`);
  let n = 0, sets = 0;
  try{
    const ops = [], gone = new Set();
    for(const s of data.songs){
      if(s.deleted){
        /* a deleted song: its PDF and annotations on this tablet go too, in the same transaction */
        gone.add(s.id);
        ops.push({store:'files', key:s.id, delete:true}, {deleteInkFor:s.id}, {store:'songs', key:s.id, value:marker(s)});
        continue;
      }
      const entry = zip.file('files/' + s.id + '.pdf');
      if(!entry) return stop(`That backup is missing the PDF for "${s.title || s.song || s.id}". Nothing was changed.`);
      const buf = await entry.async('arraybuffer');
      if(s.hash) s.hash = s.hash.toLowerCase();
      if(s.hash && await sha256(buf) !== s.hash) return stop(`That backup is damaged ("${s.title || s.song || s.id}" does not match). Nothing was changed.`);
      upgradeSong(s);
      ops.push({store:'files', key:s.id, value:new Blob([buf], {type:'application/pdf'})}, {store:'songs', key:s.id, value:s}); n++;
    }
    for(const st of data.sets){
      if(st.deleted){ ops.push({store:'sets', key:st.id, value:marker(st)}); continue; }
      upgradeSet(st); ops.push({store:'sets', key:st.id, value:st}); sets++;
    }
    for(const [k, v] of Object.entries(data.ink || {})) if(!gone.has(k.split(':')[0])) ops.push({store:'ink', key:k, value:upgradeInk(v).record});
    await putAll(ops);
  }catch(err){ return stop(explainError(err, 'Could not restore that backup. Nothing was changed.')); }
  /* The backup is written by now: a problem from here on must not say "Nothing was changed". */
  try{
    await load(); await ensureHashes(); render();
    toast(`Restored ${n} song${n == 1 ? '' : 's'} and ${sets} setlist${sets == 1 ? '' : 's'}`);
  }catch(err){ stop('The backup was restored, but the screen did not update. Reload the app to see it.'); }
}

const marker = r => ({id:r.id, deleted:true, updated:Number(r.updated) || 0});

/* ---------- what a backup may hold ----------
   Checked before anything is written. Returns null when the backup is fine, else a short reason (shown to the user).
   Ids end up in the page's HTML and in storage keys, so they are held to a plain set of characters. */
export const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const LIMITS = {songs:100000, sets:100000, items:20000, text:500, pages:5000, strokes:50000, points:200000};
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const okId = id => typeof id === 'string' && ID_RE.test(id);
const okText = v => v === undefined || v === null || (typeof v === 'string' && v.length <= LIMITS.text);
const okPage = p => Number.isInteger(p) && p >= 1 && p <= LIMITS.pages;
const cut = v => JSON.stringify(String(v)).slice(0, 40);
export function validateBackup(data){
  if(!isObj(data) || !Array.isArray(data.songs) || !Array.isArray(data.sets)) return 'no song or setlist list';
  if(data.songs.length > LIMITS.songs) return `more than ${LIMITS.songs} songs`;
  if(data.sets.length > LIMITS.sets) return `more than ${LIMITS.sets} setlists`;
  if(data.ink != null && !isObj(data.ink)) return 'the annotations are not a list of pages';
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
  for(const [k, v] of Object.entries(data.ink || {})){
    const m = /^([^:]*):(\d+)$/.exec(k);
    if(!m || !okId(m[1]) || !okPage(Number(m[2]))) return 'an annotation page ' + cut(k);
    const strokes = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.strokes) ? v.strokes : [];
    if(strokes.length > LIMITS.strokes) return `page ${k} has more than ${LIMITS.strokes} strokes`;
    for(const s of strokes) if(isObj(s) && Array.isArray(s.p) && s.p.length > LIMITS.points) return `page ${k} has a stroke of more than ${LIMITS.points} points`;
  }
  return null;
}

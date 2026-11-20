import {toast, saveBlob, hooks} from './util.js';
import {explainError} from './errors.js';
import {get, all, load, state, upgradeSong, upgradeSet, upgradeInk, ensureHashes, putAll, sha256} from './store.js';

/* Backup version 2: library.json has songs, sets and ink (with their deletion markers); files/<id>.pdf holds each live song's PDF.
   Version 1 (the prototype and the MobileSheets converter) is still read. A backup with a higher version is refused. */
export const BACKUP_VERSION = 2;
export const LAST_BACKUP = 'ss-last-backup';     // localStorage: time (ms) of the last backup that was saved
export async function makeBackup(){
  const zip = new JSZip(), ink = {};
  const songs = await all('songs'), sets = await all('sets');
  for(const s of songs){
    if(s.deleted) continue;
    const f = await get('files', s.id); if(f) zip.file('files/' + s.id + '.pdf', f);
    for(let p = 1; p <= s.pages; p++){
      const k = s.id + ':' + p, {record} = upgradeInk(await get('ink', k));
      if(record.strokes.length) ink[k] = record;
    }
  }
  zip.file('library.json', JSON.stringify({app:'setlist-stand', version:BACKUP_VERSION, saved:new Date().toISOString(), songs, sets, ink}));
  return zip.generateAsync({type:'blob'});
}

export async function backupNow(b){
  if(!state.songs.length && !state.sets.length){ toast('Nothing to back up yet'); return; }
  const label = b.textContent;
  b.disabled = true; b.textContent = 'Working…';
  let saved = false;
  try{
    const blob = await makeBackup();
    if(saveBlob(blob, 'setlist-stand-backup-' + new Date().toISOString().slice(0, 10) + '.zip')){
      saved = true; toast('Backup saved');
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
  try{
    const ops = [];
    let n = 0, sets = 0;
    for(const s of data.songs){
      if(s.deleted){ ops.push({store:'songs', key:s.id, value:s}); continue; }
      const entry = zip.file('files/' + s.id + '.pdf');
      if(!entry) return stop(`That backup is missing the PDF for "${s.title || s.song || s.id}". Nothing was changed.`);
      const buf = await entry.async('arraybuffer');
      if(s.hash && await sha256(buf) !== s.hash) return stop(`That backup is damaged ("${s.title || s.song || s.id}" does not match). Nothing was changed.`);
      upgradeSong(s);
      ops.push({store:'files', key:s.id, value:new Blob([buf], {type:'application/pdf'})}, {store:'songs', key:s.id, value:s}); n++;
    }
    for(const st of data.sets){ upgradeSet(st); ops.push({store:'sets', key:st.id, value:st}); if(!st.deleted) sets++; }
    for(const [k, v] of Object.entries(data.ink || {})) ops.push({store:'ink', key:k, value:upgradeInk(v).record});
    await putAll(ops);
    await load(); await ensureHashes(); render();
    toast(`Restored ${n} song${n == 1 ? '' : 's'} and ${sets} setlist${sets == 1 ? '' : 's'}`);
  }catch(err){ stop(explainError(err, 'Could not restore that backup. Nothing was changed.')); }
}

import {toast, saveBlob} from './util.js';
import {get, put, all, load, state, upgradeSong, upgradeSet, upgradeInk, ensureHashes} from './store.js';

/* Backup version 2: library.json has songs, sets and ink (with their deletion markers); files/<id>.pdf holds each live song's PDF.
   Version 1 (the prototype and the MobileSheets converter) is still read. */
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
  zip.file('library.json', JSON.stringify({app:'setlist-stand', version:2, saved:new Date().toISOString(), songs, sets, ink}));
  return zip.generateAsync({type:'blob'});
}

export async function backupNow(b){
  if(!state.songs.length && !state.sets.length){ toast('Nothing to back up yet'); return; }
  b.disabled = true; b.textContent = 'Working…';
  try{ const blob = await makeBackup(); if(saveBlob(blob, 'setlist-stand-backup-' + new Date().toISOString().slice(0, 10) + '.zip')) toast('Backup saved'); }
  catch(err){ toast('Backup failed'); }
  b.disabled = false; b.textContent = 'Back up everything';
}

export async function restoreFrom(f, render){
  if(!f) return;
  try{
    const zip = await JSZip.loadAsync(f);
    const data = JSON.parse(await zip.file('library.json').async('string'));
    if(data.app !== 'setlist-stand') throw new Error('not a backup');
    let n = 0, sets = 0;
    for(const s of data.songs){
      if(s.deleted){ await put('songs', s.id, s); continue; }
      const pdf = zip.file('files/' + s.id + '.pdf'); if(!pdf) continue;
      await put('files', s.id, new Blob([await pdf.async('arraybuffer')], {type:'application/pdf'}));
      upgradeSong(s); await put('songs', s.id, s); n++;
    }
    for(const st of data.sets){ upgradeSet(st); await put('sets', st.id, st); if(!st.deleted) sets++; }
    for(const [k, v] of Object.entries(data.ink || {})) await put('ink', k, upgradeInk(v).record);
    await load(); await ensureHashes(); render();
    toast(`Restored ${n} song${n == 1 ? '' : 's'} and ${sets} setlist${sets == 1 ? '' : 's'}`);
  }catch(err){ toast('That file is not a Setlist Stand backup'); }
}

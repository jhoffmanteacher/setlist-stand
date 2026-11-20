import {toast, saveBlob} from './util.js';
import {get, put, load, state} from './store.js';

export async function makeBackup(){
  const zip = new JSZip(), ink = {}, {songs, sets} = state;
  for(const s of songs){
    const f = await get('files', s.id); if(f) zip.file('files/' + s.id + '.pdf', f);
    for(let p = 1; p <= s.pages; p++){ const k = s.id + ':' + p, v = await get('ink', k); if(v && v.length) ink[k] = v; }
  }
  zip.file('library.json', JSON.stringify({app:'setlist-stand', version:1, saved:new Date().toISOString(), songs, sets, ink}));
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
    let n = 0;
    for(const s of data.songs){
      const pdf = zip.file('files/' + s.id + '.pdf'); if(!pdf) continue;
      await put('files', s.id, new Blob([await pdf.async('arraybuffer')], {type:'application/pdf'}));
      await put('songs', s.id, s); n++;
    }
    for(const st of data.sets) await put('sets', st.id, st);
    for(const [k, v] of Object.entries(data.ink || {})) await put('ink', k, v);
    await load(); render();
    toast(`Restored ${n} song${n == 1 ? '' : 's'} and ${data.sets.length} setlist${data.sets.length == 1 ? '' : 's'}`);
  }catch(err){ toast('That file is not a Setlist Stand backup'); }
}

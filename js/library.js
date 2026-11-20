import {$, esc, uid, toast, ask, armed, hooks} from './util.js';
import {put, del, load, state, songById} from './store.js';
import {openViewer} from './viewer.js';

export let q = '';

export function renderLibrary(v){
  v.innerHTML = `<div class="bar"><input type="search" id="q" placeholder="Search songs" value="${esc(q)}" aria-label="Search songs"><button class="pri" data-add>Add PDFs</button></div><div id="libList"></div>
    <div class="bar" style="margin-top:28px"><button data-backup>Back up everything</button><button data-restore>Restore from backup</button></div>
    <p class="hint">A backup is one .zip file with every PDF, setlist and annotation. Save it to Google Drive to keep it safe or move it to another tablet.</p>`;
  $('#q').oninput = e => { q = e.target.value; renderLib(); };
  renderLib();
}
function renderLib(){
  const songs = state.songs;
  const list = songs.filter(s => s.title.toLowerCase().includes(q.toLowerCase()));
  $('#libList').innerHTML = songs.length
    ? `<ul class="list">${list.map(s => `<li class="row"><button class="main" data-open="${s.id}"><span class="t">${esc(s.title)}</span><span class="s">${s.pages} page${s.pages == 1 ? '' : 's'}</span></button><div class="acts"><button data-ren="${s.id}">Rename</button><button data-del="${s.id}">Delete</button></div></li>`).join('')}</ul>${list.length ? '' : '<p class="empty">No songs match.</p>'}`
    : `<div class="empty"><h2>No music yet</h2><p>Add PDF charts from your tablet's files or Drive. They're saved on this device.</p></div>`;
}

export async function addFiles(fileList){
  const fs = [...fileList].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if(!fs.length) return;
  toast(`Adding ${fs.length} PDF${fs.length > 1 ? 's' : ''}…`);
  let ok = 0;
  for(const f of fs){
    try{
      const buf = await f.arrayBuffer();
      const doc = await pdfjsLib.getDocument({data:new Uint8Array(buf.slice(0))}).promise;
      const pages = doc.numPages; doc.destroy();
      const id = uid();
      await put('files', id, new Blob([buf], {type:'application/pdf'}));
      await put('songs', id, {id, title:f.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim(), pages, added:Date.now()});
      ok++;
    }catch(err){ toast('Could not read ' + f.name); }
  }
  await load(); hooks.render();
  if(ok) toast(`Added ${ok} song${ok > 1 ? 's' : ''}`);
}

/* Returns true when the click was for the library. */
export async function onClick(b, d){
  if('add' in d){ $('#file').click(); return true; }
  if(d.open){ openViewer([d.open], 0); return true; }
  if(d.ren){
    const s = songById(d.ren); const n = await ask('Rename song', s.title);
    if(n){ s.title = n; await put('songs', s.id, s); await load(); hooks.render(); }
    return true;
  }
  if(d.del){
    if(!armed(b)) return true;
    const s = songById(d.del);
    await del('files', s.id); await del('songs', s.id);
    for(let p = 1; p <= s.pages; p++) await del('ink', s.id + ':' + p);
    for(const st of state.sets){ if(st.songs.includes(s.id)){ st.songs = st.songs.filter(x => x !== s.id); await put('sets', st.id, st); } }
    await load(); hooks.render(); return true;
  }
  return false;
}

import {$, esc, uid, toast, form, armed, hooks} from './util.js';
import {put, del, load, state, songById, saveSong, saveSet, markDeleted, sha256, getInk, putInk, reconcile, delInkFor} from './store.js';
import {parseFileName} from './importname.js';
import {openViewer} from './viewer.js';

let q = '', showArchived = false, replaceTarget = null;

export function renderLibrary(v){
  v.innerHTML = `<div class="bar"><input type="search" id="q" placeholder="Search songs" value="${esc(q)}" aria-label="Search songs"><button class="pri" data-add>Add PDFs</button></div><div id="libList"></div>
    <label class="sw-row"><input type="checkbox" id="showArch" ${showArchived ? 'checked' : ''}>Show archived</label>
    <div class="bar" style="margin-top:12px"><button data-backup>Back up everything</button><button data-restore>Restore from backup</button></div>
    <p class="hint">A backup is one .zip file with every PDF, setlist and annotation. Save it to Google Drive to keep it safe or move it to another tablet.</p>`;
  $('#q').oninput = e => { q = e.target.value; renderLib(); };
  $('#showArch').onchange = e => { showArchived = e.target.checked; renderLib(); };
  renderLib();
}
const matches = s => (s.title + ' ' + s.song + ' ' + s.artist + ' ' + s.version).toLowerCase().includes(q.trim().toLowerCase());
const pages = s => `${s.pages} page${s.pages == 1 ? '' : 's'}`;
function renderLib(){
  const live = state.songs.filter(s => !s.archived), arch = state.songs.filter(s => s.archived);
  const list = live.filter(matches), alist = arch.filter(matches);
  let html = live.length
    ? `<ul class="list">${list.map(s => `<li class="row"><button class="main" data-open="${s.id}"><span class="t">${esc(s.title)}</span><span class="s">${pages(s)}</span></button><div class="acts"><button data-edit="${s.id}">Edit</button><button data-archive="${s.id}">Archive</button><button data-replace="${s.id}">Replace PDF</button><button data-del="${s.id}">Delete</button></div></li>`).join('')}</ul>${list.length ? '' : '<p class="empty">No songs match.</p>'}`
    : `<div class="empty"><h2>No music yet</h2><p>Add PDF charts from your tablet's files or Drive. They're saved on this device.</p></div>`;
  if(showArchived){
    html += `<h2 style="margin-top:28px;font-size:26px">Archived</h2>` + (alist.length
      ? `<ul class="list">${alist.map(s => `<li class="row"><button class="main" data-open="${s.id}"><span class="t">${esc(s.title)}</span><span class="s">${pages(s)} · Archived</span></button><div class="acts"><button data-restoresong="${s.id}">Restore</button><button data-del="${s.id}">Delete</button></div></li>`).join('')}</ul>`
      : `<p class="hint">${arch.length ? 'No archived songs match.' : 'Nothing archived.'}</p>`);
  }
  $('#libList').innerHTML = html;
}

/* Reads one PDF: page count and hash. Throws if pdf.js cannot open it. */
async function inspect(file){
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({data:new Uint8Array(buf.slice(0))}).promise;
  const n = doc.numPages; doc.destroy();
  return {buf, pages:n, hash:await sha256(buf)};
}

export async function addFiles(fileList){
  const fs = [...fileList].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if(!fs.length) return;
  toast(`Adding ${fs.length} PDF${fs.length > 1 ? 's' : ''}…`);
  let ok = 0;
  for(const f of fs){
    try{
      const {buf, pages, hash} = await inspect(f);
      const id = uid(), t = Date.now(), n = parseFileName(f.name);
      await put('files', id, new Blob([buf], {type:'application/pdf'}));
      await saveSong({id, ...n, archived:false, pages, hash, added:t});
      ok++;
    }catch(err){ toast('Could not read ' + f.name); }
  }
  await load(); hooks.render();
  if(ok) toast(`Added ${ok} song${ok > 1 ? 's' : ''}`);
}

/* Swap in a corrected PDF. The song keeps its id, details and setlist places; its annotations start fresh. */
export async function replacePdf(file){
  const id = replaceTarget; replaceTarget = null;
  const s = songById(id); if(!s || !file) return;
  try{
    const {buf, pages:n, hash} = await inspect(file);
    await put('files', id, new Blob([buf], {type:'application/pdf'}));
    for(let p = 1; p <= s.pages; p++){
      const cur = await getInk(id, p);
      if(p > n) await del('ink', id + ':' + p);                       // that page no longer exists
      else if(cur.length) await putInk(id, p, reconcile(cur, []));    // keep deletion markers for the pages that remain
    }
    s.pages = n; s.hash = hash; await saveSong(s);
    await load(); hooks.render(); toast('Chart replaced. Annotations cleared.');
  }catch(err){ toast('Could not read ' + file.name); }
}

/* Returns true when the click was for the library. */
export async function onClick(b, d){
  if('add' in d){ $('#file').click(); return true; }
  if(d.open){ openViewer([d.open], 0); return true; }
  if(d.edit){
    const s = songById(d.edit);
    const r = await form('Edit song', [{key:'song', label:'Title', value:s.song}, {key:'artist', label:'Artist', value:s.artist}, {key:'version', label:'Version', value:s.version}]);
    if(r && r.song){ s.song = r.song; s.artist = r.artist; s.version = r.version; await saveSong(s); await load(); hooks.render(); }
    return true;
  }
  if(d.archive || d.restoresong){
    const s = songById(d.archive || d.restoresong); s.archived = !!d.archive;
    await saveSong(s); await load(); hooks.render(); return true;
  }
  if(d.replace){
    if(!armed(b, 'Clears notes. Tap again')) return true;
    replaceTarget = d.replace; $('#replaceFile').click(); return true;
  }
  if(d.del){
    if(!armed(b)) return true;
    const s = songById(d.del);
    await del('files', s.id);
    await delInkFor(s.id);
    await markDeleted('songs', s.id);
    for(const st of state.sets){ if(st.songs.includes(s.id)){ st.songs = st.songs.filter(x => x !== s.id); await saveSet(st); } }
    await load(); hooks.render(); return true;
  }
  return false;
}

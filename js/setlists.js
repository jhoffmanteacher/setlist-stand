import {esc, uid, ask, pick, armed, hooks} from './util.js';
import {load, state, songById, saveSet, markDeleted} from './store.js';
import {openViewer} from './viewer.js';
import {printDialog} from './print.js';

export let openSet = null;
export const closeSet = () => { openSet = null; };

export function renderSetlists(v){
  const {sets} = state;
  if(openSet){
    const st = sets.find(s => s.id === openSet);
    if(!st){ openSet = null; return renderSetlists(v); }
    const ids = st.songs.filter(songById);
    v.innerHTML = `<div class="bar"><button data-allsets>&#8249; Setlists</button><h2>${esc(st.name)}</h2></div>
      <div class="bar"><button class="pri" data-play="${st.id}" ${ids.length ? '' : 'disabled'}>Play setlist</button><button data-addto>Add songs</button><button data-print ${ids.length ? '' : 'disabled'}>Print PDF</button><button data-renset>Rename</button></div>
      ${ids.length ? `<ul class="list">${ids.map((id, i) => { const s = songById(id); return `<li class="row"><span class="num">${i + 1}</span><button class="main" data-playat="${i}"><span class="t">${esc(s.title)}${s.archived ? '<span class="tag">Archived</span>' : ''}</span><span class="s">${s.pages} page${s.pages == 1 ? '' : 's'}</span></button><div class="acts"><button data-up="${i}" aria-label="Move up" ${i ? '' : 'disabled'}>&#8593;</button><button data-down="${i}" aria-label="Move down" ${i < ids.length - 1 ? '' : 'disabled'}>&#8595;</button><button data-rm="${i}">Remove</button></div></li>`; }).join('')}</ul>`
      : `<div class="empty"><h2>Empty setlist</h2><p>Tap Add songs to pick charts from your library.</p></div>`}`;
  } else {
    v.innerHTML = `<div class="bar"><button class="pri" data-newset>New setlist</button></div>` +
      (sets.length ? `<ul class="list">${sets.map(st => { const n = st.songs.filter(songById).length; return `<li class="row"><button class="main" data-set="${st.id}"><span class="t">${esc(st.name)}</span><span class="s">${n} song${n == 1 ? '' : 's'}</span></button><div class="acts"><button data-play="${st.id}" ${n ? '' : 'disabled'}>Play</button><button data-delset="${st.id}">Delete</button></div></li>`; }).join('')}</ul>`
      : `<div class="empty"><h2>No setlists yet</h2><p>Make one for each gig or rehearsal.</p></div>`);
  }
}

/* Returns true when the click was for setlists. */
export async function onClick(b, d){
  const {sets, songs} = state;
  if('newset' in d){
    const n = await ask('New setlist', '');
    if(n){ const st = {id:uid(), name:n, songs:[], created:Date.now()}; await saveSet(st); await load(); openSet = st.id; hooks.render(); }
    return true;
  }
  if(d.set){ openSet = d.set; hooks.render(); return true; }
  if('allsets' in d){ openSet = null; hooks.render(); return true; }
  if(d.delset){ if(!armed(b)) return true; await markDeleted('sets', d.delset); await load(); hooks.render(); return true; }
  if(d.play){ const st = sets.find(s => s.id === d.play); openViewer(st.songs.filter(songById), 0); return true; }
  const st = sets.find(s => s.id === openSet);
  if(!st) return false;
  const ids = st.songs.filter(songById);
  const save = async () => { st.songs = ids; await saveSet(st); await load(); hooks.render(); };
  if(d.playat){ openViewer(ids, +d.playat); return true; }
  if('print' in d){ printDialog(st, ids); return true; }
  if('addto' in d){ const add = await pick(songs.filter(s => !s.archived)); if(add.length){ ids.push(...add); await save(); } return true; }
  if('renset' in d){ const n = await ask('Rename setlist', st.name); if(n){ st.name = n; await save(); } return true; }
  if(d.up){ const i = +d.up; [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; await save(); return true; }
  if(d.down){ const i = +d.down; [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]]; await save(); return true; }
  if(d.rm){ ids.splice(+d.rm, 1); await save(); return true; }
  return false;
}

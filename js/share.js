/* The Share screens: pick songs (Library) or use a setlist, make the package, save it, offer the share sheet. */
import {esc, toast, modal, pick, fileName, saveBlob, canShareFile, shareBlob} from './util.js';
import {state} from './store.js';
import {explainError} from './errors.js';
import {makePackage, songIdsOf} from './sharepack.js';

const plural = (n, w) => `${n} ${w}${n == 1 ? '' : 's'}`;

/* Library: tick songs, then make the package. */
export async function shareSongs(){
  if(!state.songs.length){ toast('Add some songs first'); return; }
  const ids = await pick(state.songs.map(s => ({id:s.id, title:s.title, archived:s.archived, song:s.song, artist:s.artist, version:s.version})), {title:'Share songs', button:'Share', needOne:true});
  if(ids.length) await sharePackage(ids, null, 'Songs');
}

/* Setlist: every song it uses once, with its order and breaks. */
export async function shareSet(set){
  const ids = songIdsOf(set);
  if(!ids.length){ toast('This setlist has no songs to share'); return; }
  await sharePackage(ids, set, set.name);
}

async function sharePackage(ids, set, label){
  const name = fileName(label) + ' - Setlist Stand share.zip';
  let stopped = false;
  const m = modal(`<h2>Making the package</h2><p class="hint" role="status">${esc(plural(ids.length, 'song'))}…</p><div class="btns"><button data-x>Cancel</button></div>`);
  m.querySelector('[data-x]').onclick = () => { stopped = true; m.remove(); };
  let r;
  try{ r = await makePackage(ids, set, {cancelled:() => stopped}); }
  catch(err){ m.remove(); if(!stopped) toast(explainError(err, 'Could not make the package. Nothing was changed.')); return; }
  if(stopped || r.cancelled) return;
  m.remove();
  if(!r.count){ toast('None of those songs has a PDF to share'); return; }
  saveBlob(r.blob, name);
  const left = r.skipped ? `<p class="hint">${plural(r.skipped, 'song')} had no PDF and ${r.skipped == 1 ? 'was' : 'were'} left out.</p>` : '';
  const done = modal(`<h2>Package saved</h2><p>${esc(plural(r.count, 'song'))} ${r.count == 1 ? 'is' : 'are'} in <b>${esc(name)}</b>. Send it to the other person by AirDrop, email, Drive or any way you like.</p>${left}
    <div class="btns">${canShareFile(r.blob, name) ? '<button data-share>Share…</button>' : ''}<button class="pri" data-x>Done</button></div>`);
  done.querySelector('[data-x]').onclick = () => done.remove();
  const sh = done.querySelector('[data-share]'); if(sh) sh.onclick = () => shareBlob(r.blob, name);
}

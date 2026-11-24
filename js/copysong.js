import {esc, modal, toast, hooks} from './util.js';
import {putAll, get, load, state, songById, upgradeInk, inkRecord} from './store.js';
import {displayName, cutName, compareSongs} from './names.js';
import {explainError} from './errors.js';
import {unique} from './shareimport.js';

/* Copy song: a second version of the same chart (the same PDF marked up another way for another band).
   The copy is a NEW song: a fresh id, the original's details and crop (a deep copy; any field this code does not know is
   carried too), the version the person typed, the original's stored PDF bytes as they are (never re-saved, so the SHA-256 is the
   same), and the original's live marks and notes with fresh stroke ids. Deletion markers are left out. Nothing about the original
   changes, and no setlist: the copy is in none until it is added. The song, its PDF and its marks are ONE putAll(), so a full
   tablet saves nothing. Songs are matched by id, never by hash: two songs may hold the same PDF. */
const same = (a, b) => String(a || '').replace(/\s+/g, ' ').trim().toLowerCase() === String(b || '').replace(/\s+/g, ' ').trim().toLowerCase();

/* A version name is taken when the original or ANY other copy of the same chart has it, live or archived: a song with the same song name
   and artist as compareSongs sees them (case, accents and extra spaces do not matter), and a version equal in the same way. */
const keyOf = (x, version) => ({song:x.song || x.title, artist:x.artist || '', version:String(version || '').replace(/\s+/g, ' ').trim(), id:''});
const sameChart = (a, b) => compareSongs(keyOf(a, ''), keyOf(b, '')) === 0;
const takenBy = (s, v) => state.songs.find(x => x.id !== s.id && sameChart(x, s) && compareSongs(keyOf(x, x.version), keyOf(s, v)) === 0);

/* The dialog. Resolves to the version typed (trimmed), or null for Cancel. Save waits for a name that no copy of this chart has. */
function askVersion(s){
  return new Promise(res => {
    const m = modal(`<h2>Copy song</h2><p>Copy of ${esc(s.title)}</p>
      <label class="fld"><span>Version name</span><input type="text" maxlength="200" data-k="version" value=""></label>
      <p class="hint warnline" role="alert" data-err hidden></p>
      <div class="btns"><button data-x>Cancel</button><button class="pri" data-ok disabled>Save</button></div>`);
    m.classList.add('copyask');
    const inp = m.querySelector('input'), ok = m.querySelector('[data-ok]'), err = m.querySelector('[data-err]');
    const check = () => {
      const v = inp.value.trim(), mine = !!v && (same(v, s.version) || compareSongs(keyOf(s, s.version), keyOf(s, v)) === 0), other = !!v && !mine && takenBy(s, v), dup = mine || !!other;
      ok.disabled = !v || dup;
      err.hidden = !dup;
      err.textContent = mine ? 'That is already this song’s version. Type a different version name.'
        : other ? `${other.archived ? 'An archived' : 'Another'} copy of this song already has that version name. Type a different version name.` : '';
      return !!v && !dup;
    };
    const done = v => { m.remove(); res(v); };
    inp.oninput = check;
    m.querySelector('[data-x]').onclick = () => done(null);
    ok.onclick = () => { if(check()) done(inp.value.trim()); };
    m.onkeydown = e => { if(e.key === 'Enter' && e.target === inp){ e.preventDefault(); if(check()) done(inp.value.trim()); } };
  });
}

/* Asks for the version name, then makes the copy. */
export async function copySong(id){
  const s = songById(id); if(!s) return;
  const version = await askVersion(s);
  if(version == null) return;
  try{
    const t = Date.now(), cur = await get('songs', id);
    if(!cur || cur.deleted){ toast('That song was deleted. Nothing was copied.'); await load(); hooks.render(); return; }
    const f = await get('files', id);
    if(!f){ toast('This song has no PDF stored on this tablet, so it cannot be copied.'); return; }
    const bytes = await f.arrayBuffer();
    const taken = new Set([...state.songs.map(x => x.id), ...state.sets.map(x => x.id)]);
    const copy = {...JSON.parse(JSON.stringify(cur)), id:unique(taken), song:cutName(cur.song), artist:cutName(cur.artist), version:cutName(version), archived:false, added:t, updated:t};
    copy.title = displayName(copy);
    const ops = [{store:'files', key:copy.id, value:new Blob([bytes], {type:'application/pdf'})}, {store:'songs', key:copy.id, value:copy}];
    /* The marks of every page: the live ones only, each with a fresh id and time (a deletion marker means nothing to a new song). */
    const ids = new Set();
    for(let p = 1; p <= cur.pages; p++){
      const strokes = upgradeInk(await get('ink', id + ':' + p)).record.strokes.filter(x => !x.deleted);
      if(!strokes.length) continue;
      ops.push({store:'ink', key:copy.id + ':' + p, value:inkRecord(strokes.map(x => ({...JSON.parse(JSON.stringify(x)), id:unique(ids), updated:t})))});
    }
    await putAll(ops);
    await load(); hooks.render();
    toast('Copied. The new version has the same marks.');
  }catch(err){ await load(); hooks.render(); toast(explainError(err)); }
}

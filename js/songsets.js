import {esc, modal, toast} from './util.js';
import {state, saveSet, liveItems, songById} from './store.js';
import {gigOf, gigShort, todayStr} from './gigdate.js';
import {commit, once} from './saving.js';

/* A song and the setlists it is in (Jonathan, 2026-11-23): the Delete question names them, and "Add to setlist…" in a song's menu
   puts the song at the end of one. Setlists are listed upcoming gigs first (soonest first), then the rest as the Setlists list has
   them (newest made first). A setlist is named by its plain name, with its gig date when it has one. */

const cut = t => t.length > 40 ? t.slice(0, 40) + '…' : t;
export function upcomingFirst(sets, today = todayStr()){
  const up = sets.filter(st => gigOf(st) && gigOf(st) >= today).sort((a, b) => gigOf(a) < gigOf(b) ? -1 : gigOf(a) > gigOf(b) ? 1 : 0);
  return [...up, ...sets.filter(st => !up.includes(st))];
}
export const setLabel = st => st.name + (gigOf(st) ? ` (${gigShort(gigOf(st))})` : '');
export const setsWith = id => upcomingFirst(state.sets.filter(st => liveItems(st).some(it => it.type === 'song' && it.id === id)));

/* The Delete question (the second of the two taps the "Never" list asks for). Resolves 'del', 'archive' (Archive instead, for a song
   that is not archived yet) or null for Cancel. The setlists it is in are named, at most 5, then "and N more". */
export function askDelete(s){
  return new Promise(res => {
    const sets = setsWith(s.id), shown = sets.slice(0, 5), more = sets.length - shown.length;
    const where = sets.length
      ? `<p>It leaves ${sets.length == 1 ? 'this setlist' : `these ${sets.length} setlists`}:</p><ul class="delsets">${shown.map(st => `<li>${esc(setLabel(st))}</li>`).join('')}${more > 0 ? `<li>and ${more} more</li>` : ''}</ul>`
      : '<p>It is in no setlist.</p>';
    const m = modal(`<h2>Delete ${esc(cut(s.title))}?</h2><p>Its PDF and its marks are removed from this tablet.</p>${where}
      ${s.archived ? '' : '<p class="hint">Archive hides it from the Library and keeps it in every setlist.</p>'}
      <div class="btns"><button data-x>Cancel</button>${s.archived ? '' : '<button data-arch>Archive instead</button>'}<button class="pri" data-ok>Delete</button></div>`);
    m.classList.add('delask');
    /* a quick double tap on the menu's Delete must not land on this box's Delete or Archive instead */
    const btns = [...m.querySelectorAll('[data-ok], [data-arch]')];
    for(const b of btns) b.disabled = true;
    setTimeout(() => { for(const b of btns) b.disabled = false; }, 400);
    const done = v => { m.remove(); res(v); };
    m.querySelector('[data-x]').onclick = () => done(null);
    m.querySelector('[data-ok]').onclick = () => done('del');
    const a = m.querySelector('[data-arch]'); if(a) a.onclick = () => done('archive');
  });
}

/* "Add to setlist…": a list of setlists; the one tapped gets the song at its end (ONE write, under once(), as Add songs). */
export function addToSetlist(id){
  const s = songById(id); if(!s) return;
  if(!state.sets.length){ toast('There are no setlists yet. Make one on the Setlists tab.'); return; }
  const sets = upcomingFirst(state.sets);
  return new Promise(res => {
    const count = st => { const n = liveItems(st).filter(it => it.type === 'song').length; return `${n} song${n == 1 ? '' : 's'}`; };
    const m = modal(`<h2>Add to a setlist</h2><p class="hint">${esc(cut(s.title))} goes at the end of the setlist you tap.</p><div class="menulist">${sets.map(st =>
      `<button class="menuitem" data-addset="${esc(st.id)}"><b>${esc(st.name)}</b><span>${gigOf(st) ? esc(gigShort(gigOf(st))) + ' &middot; ' : ''}${count(st)}${liveItems(st).some(it => it.id === id) ? ' &middot; already in it' : ''}</span></button>`).join('')}</div>
      <div class="btns"><button data-x>Cancel</button></div>`);
    m.classList.add('addtoset');
    const picks = [...m.querySelectorAll('[data-addset]')];     // a quick double tap on the menu item must not land on a setlist here
    for(const b of picks) b.disabled = true;
    setTimeout(() => { for(const b of picks) b.disabled = false; }, 400);
    m.querySelector('[data-x]').onclick = () => { m.remove(); res(false); };
    for(const b of m.querySelectorAll('[data-addset]')) b.onclick = async () => {
      m.remove();
      const ok = await once('addtoset', () => {
        const st = state.sets.find(x => x.id === b.dataset.addset);
        if(!st || !songById(id)) return false;
        return commit(async () => { await saveSet({...st, items:[...liveItems(st), {type:'song', id}]}); toast('Added to ' + cut(st.name)); }, 'Could not add the song to the setlist. Nothing was changed.');
      });
      res(ok);
    };
  });
}

import {esc, modal, hooks, toast} from './util.js';
import {state, get, putAll, load, stamp} from './store.js';
import {explainError} from './errors.js';
import {validGig, gigOf, gigLong, fillCandidates, YEAR_MIN, YEAR_MAX} from './gigdate.js';

/* The gig-date dialogs. All go through modal(): focus trapped, Escape cancels, the page behind inert. */
/* Set, change or clear a gig date. Resolves to {gig: 'YYYY-MM-DD'|null} (null = clear) or null for Cancel. */
export function gigDialog(title, current){
  return new Promise(res => {
    const m = modal(`<h2>${esc(title)}</h2><label class="fld"><span>Gig date</span><input type="date" data-gig value="${esc(gigOf({gig:current}) || '')}" min="${YEAR_MIN}-01-01" max="${YEAR_MAX}-12-31"></label><p class="warn" role="alert" data-err hidden>That is not a date this app can keep. Pick a day from 1900 to 2999.</p><div class="btns"><button data-x>Cancel</button><button data-clear ${current ? '' : 'disabled'}>Clear</button><button class="pri" data-ok>Save</button></div>`);
    const i = m.querySelector('input'), done = v => { m.remove(); res(v); };
    m.querySelector('[data-x]').onclick = () => done(null);
    m.querySelector('[data-clear]').onclick = () => done({gig:null});
    /* An empty box is Clear. A typed year the box lets through but that is not a real date (1850, 20266) is not saved: it says so. */
    const save = () => {
      const g = i.value ? validGig(i.value) : null;
      if(i.value && !g){ m.querySelector('[data-err]').hidden = false; i.focus(); return; }
      done({gig:g});
    };
    m.querySelector('[data-ok]').onclick = save;
    m.onkeydown = e => { if(e.key === 'Enter' && e.target === i){ e.preventDefault(); save(); } if(e.key === 'Escape') done(null); };
  });
}
/* New setlist: a name (required) and an optional gig date. Resolves to {name, gig|null} or null. */
export function newSetDialog(){
  return new Promise(res => {
    const m = modal(`<h2>New setlist</h2><label class="fld"><span>Name</span><input type="text" maxlength="200" data-name></label><label class="fld"><span>Gig date (optional)</span><input type="date" data-gig min="${YEAR_MIN}-01-01" max="${YEAR_MAX}-12-31"></label><div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Save</button></div>`);
    const name = m.querySelector('[data-name]'), date = m.querySelector('[data-gig]');
    const done = v => { m.remove(); res(v); };
    const save = () => { const n = name.value.trim(); if(n) done({name:n, gig:date.value ? validGig(date.value) : null}); else name.focus(); };
    m.querySelector('[data-x]').onclick = () => done(null);
    m.querySelector('[data-ok]').onclick = save;
    m.onkeydown = e => { if(e.key === 'Enter' && e.target.matches('input')){ e.preventDefault(); save(); } if(e.key === 'Escape') done(null); };
  });
}
/* The fill-in: one box listing each setlist and the date its name holds, each with a tick box (all ticked).
   Resolves to the list of ticked candidates ({set, gig}), or null for Not now. */
export function fillDialog(cands){
  return new Promise(res => {
    const rows = cands.map((c, i) => `<label class="opt"><input type="checkbox" value="${i}" checked>${esc(c.set.name)} &rarr; ${esc(gigLong(c.gig))}</label>`).join('');
    const m = modal(`<h2>Fill in gig dates?</h2><p class="hint">These setlist names hold a full date. Tick the ones to use as the gig date. Names are not changed.</p><fieldset class="fld checks"><legend>Setlists</legend>${rows}</fieldset><div class="btns"><button data-x>Not now</button><button class="pri" data-ok>Fill in</button></div>`);
    const done = v => { m.remove(); res(v); };
    m.querySelector('[data-x]').onclick = () => done(null);
    m.querySelector('[data-ok]').onclick = () => done([...m.querySelectorAll('input:checked')].map(c => cands[+c.value]));
    m.onkeydown = e => { if(e.key === 'Escape') done(null); };
  });
}

/* The fill-in, once per tablet (localStorage `ss-gig-fill`, set when the person answers; never in the library, a backup or a sync).
   Offered the first time the Setlists list draws with a setlist whose name clearly holds a full date. Fill in writes the ticked
   ones in ONE putAll: only `gig` and `updated` change, never a name. Not now (or Escape) writes nothing and is not asked again.
   Two tablets that each fill in the same setlist write the same gig with different `updated`: harmless, the newer wins. */
const FILL_KEY = 'ss-gig-fill';
let asking = false, answered = false;           // `answered` also holds when the browser will not keep the key
export async function offerFill(){
  let done = answered;
  try{ done = done || !!localStorage.getItem(FILL_KEY); }catch(e){}
  if(done || asking || document.querySelector('.modal')) return;
  const cands = fillCandidates(state.sets);
  if(!cands.length) return;
  asking = true;
  const answer = () => { answered = true; try{ localStorage.setItem(FILL_KEY, '1'); }catch(e){} };
  try{
    const picked = await fillDialog(cands);
    if(!picked){ answer(); return; }                       // Not now: nothing is written, nothing is asked again
    /* Each setlist is read again just before the write: one that was deleted, renamed or given a date while the box was open
       is left alone (the box's copy is old; writing it back would undo that). */
    const ops = [];
    for(const {set, gig} of picked){
      const now = await get('sets', set.id);
      if(!now || now.deleted || now.updated !== set.updated || gigOf(now)) continue;
      ops.push({store:'sets', key:now.id, value:{...now, gig, updated:stamp(now)}});   // stamp(): an edit to an existing record never goes backwards (js/store.js)
    }
    try{
      if(ops.length) await putAll(ops);
      answer();                                            // only once the write went through: a full tablet is asked again
      await load(); hooks.render();
      toast(!ops.length ? 'Nothing needed filling in.' : ops.length == 1 ? 'Gig date filled in.' : `${ops.length} gig dates filled in.`);
    }catch(err){ toast(explainError(err, 'Could not fill in the gig dates. Nothing was changed.')); }
  } finally { asking = false; }
}

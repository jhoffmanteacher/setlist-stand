/* The restore's question ("Restore this backup?", in plain words: what it adds, brings back, puts back and deletes, what is kept in
   Archived, what stays as it is) and the words of its result. Every name comes from the backup or this tablet and is escaped. */
import {esc, modal, toast, armed} from './util.js';
import {oldVersion} from './newversion.js';
import {KEEP_WORD, keepLimits} from './restoreplan.js';
import {mb} from './zipread.js';

const plural = (n, one) => `${n} ${one}${n == 1 ? '' : 's'}`;
const joinParts = parts => parts.length <= 1 ? parts.join('') : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
const counts = (songs, sets, colls = 0) => joinParts([songs && plural(songs, 'song'), sets && plural(sets, 'setlist'), colls && plural(colls, 'collection')].filter(Boolean));
/* a long title is cut for the list (at a whole character) */
const cut = t => { const a = [...String(t || '')]; return a.length > 60 ? a.slice(0, 60).join('') + '…' : a.join(''); };
const names = items => !items.length ? '' : '<ul class="restorenames">' + items.slice(0, 8).map(x => `<li>${esc(cut(x.name))}${x.newer ? ' <span class="hint">(changed here later)</span>' : ''}</li>`).join('') +
  (items.length > 8 ? `<li>… and ${items.length - 8} more</li>` : '') + '</ul>';
const DATE = {weekday:'long', year:'numeric', month:'long', day:'numeric'};
function madeOn(saved){
  if(typeof saved !== 'string' && typeof saved !== 'number') return '';
  const d = new Date(saved);
  return isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(undefined, DATE).format(d);
}

/* The question. Resolves to 'keep' for Restore (with the copies), 'nokeep' for "Restore without keeping copies" (offered, instead of
   Restore, only when the charts to keep are more than keepLimits.maxBytes; never the default), false for Cancel (or Escape).
   plan: planRestore() in js/restoreplan.js; saved: the backup's own `saved` time; drive: Google Drive is set up on this tablet. */
export function askRestore(plan, saved, drive){
  const S = plan.songs, T = plan.sets, C = plan.colls, items = [], after = [];
  const add = counts(S.add, T.add, C.add); if(add) items.push(`It adds ${add}.`);
  const back = counts(S.back, T.back, C.back); if(back) items.push(`It brings back ${back} you deleted on this tablet.`);
  const changed = [...S.changed.map(x => ({name:x.title, newer:x.newer})), ...T.changed.map(x => ({name:x.name, newer:x.newer})), ...C.changed.map(x => ({name:x.name, newer:x.newer}))]
    .sort((a, b) => (b.newer ? 1 : 0) - (a.newer ? 1 : 0));
  const put = counts(S.changed.length, T.changed.length, C.changed.length);
  if(put){
    const total = changed.length, newer = changed.filter(x => x.newer).length;
    const said = !newer ? (changed.length ? ':' : '.')
      : total == 1 ? '. It was changed on this tablet after the backup was made:'
      : `. ${newer == 1 ? '1 of them was' : newer + ' of them were'} changed on this tablet after the backup was made:`;
    items.push(`It puts back the backup's version of ${put}${said}` + names(changed));
  }
  const removed = [...S.removed.map(x => ({name:x.title})), ...T.removed.map(x => ({name:x.name})), ...C.removed.map(x => ({name:x.name}))];
  const del = counts(S.removed.length, T.removed.length, C.removed.length);
  if(del) items.push(`It deletes ${del}, because ${removed.length == 1 ? 'it is' : 'they are'} deleted in the backup:` + names(removed));
  const kc = plan.keep.length, ks = plan.keepSets.length, tooBig = kc > 0 && plan.keepBytes > keepLimits.maxBytes;
  if(!put && !del && !kc && !ks) after.push('Nothing on this tablet is replaced.');
  if(tooBig) after.push(`<b>The ${kc == 1 ? 'chart' : kc + ' charts'} this restore replaces (about ${mb(plan.keepBytes)}) ${kc == 1 ? 'is' : 'are'} too big to keep as ${kc == 1 ? 'a copy' : 'copies'} on this tablet.</b> If you restore, ${kc == 1 ? 'it and its marks are' : 'they and their marks are'} gone${ks ? ', and no setlist copy is kept' : ''}. To keep ${kc == 1 ? 'it' : 'them'}, Cancel and back up first.`);
  else if(kc || ks){
    const parts = [];
    if(kc) parts.push(`${kc == 1 ? '1 chart' : kc + ' charts'} from this tablet, with ${kc == 1 ? 'its' : 'their'} marks, ${kc == 1 ? 'goes' : 'go'} to Archived as "(${esc(oldVersion('', KEEP_WORD))})".`);
    if(ks == 1) parts.push(`A copy of 1 setlist is kept as "${esc(cut(plan.keepSets[0].name))}".`);
    else if(ks) parts.push(`Copies of ${ks} setlists are kept, each named "… (before restore)".`);
    if(plan.keepBytes > 50e6) parts.push(`Keeping them takes about ${Math.round(plan.keepBytes / 1e6)} MB on this tablet.`);
    after.push((kc ? 'Charts and marks are kept: ' : '') + parts.join(' '));
  }
  /* charts this tablet cannot read, by name: the chart itself is lost, or (the backup puts the same chart back) only the marks drawn on it here */
  const unr = (list, one, many) => { if(!list.length) return; const names = list.slice(0, 8).map(x => esc(cut(x.title))).join(', ') + (list.length > 8 ? ` and ${list.length - 8} more` : '');
    after.push(`${list.length == 1 ? '1 chart on this tablet could not be read, so ' + one : list.length + ' charts on this tablet could not be read, so ' + many}: ${names}.`); };
  unr(S.unreadable.filter(x => !x.marksOnly), 'it cannot be kept', 'they cannot be kept');
  unr(S.unreadable.filter(x => x.marksOnly), 'the marks drawn on it here cannot be kept', 'the marks drawn on them here cannot be kept');
  if(S.noPdf) after.push(`${S.noPdf == 1 ? '1 song on this tablet has' : S.noPdf + ' songs on this tablet have'} no chart stored here, so ${S.noPdf == 1 ? 'its' : 'their'} marks cannot be kept.`);
  /* setlists this restore does not write over, but that play a song it replaces or deletes: never "stays as it is" */
  const P = plan.staying, few = list => list.slice(0, 5).map(x => esc(cut(x.name))).join(', ') + (list.length > 5 ? ` and ${list.length - 5} more` : '');
  const sl = (n, rest) => `${n == 1 ? '1 setlist that stays' : n + ' setlists that stay'} ${rest}`;
  /* with the charts too big to keep, an earlier "(before restore)" setlist that needs a new copy plays the backup's version too */
  const fix = tooBig ? P.keptFix.filter(x => !x.needsCopy) : P.keptFix, play = [...P.play, ...(tooBig ? P.keptFix.filter(x => x.needsCopy) : [])];
  if(play.length) after.push(sl(play.length, `will play the backup's version of songs it puts back: ${few(play)}.`) + (kc && !tooBig ? ' The versions from this tablet are in Archived.' : ''));
  if(P.drop.length) after.push(sl(P.drop.length, `will no longer show the songs the backup deletes: ${few(P.drop.map(x => x.set))}.`));
  if(fix.length) after.push(`${fix.length == 1 ? '1 earlier "(before restore)" setlist is' : fix.length + ' earlier "(before restore)" setlists are'} pointed at the kept charts, so ${fix.length == 1 ? 'it plays' : 'they play'} what ${fix.length == 1 ? 'it' : 'they'} played before: ${few(fix)}.`);
  const stay = counts(S.stay, T.stay, C.stay), one = S.stay + T.stay + C.stay == 1;
  if(stay) after.push(`${stay} on this tablet ${one ? 'is' : 'are'} not in the backup. ${one ? 'It stays as it is' : 'They stay as they are'}.`);
  const kn = counts(S.newerKept, T.newerKept, C.newerKept), one2 = S.newerKept + T.newerKept + C.newerKept == 1;
  if(kn) after.push(`${kn} on this tablet ${one2 ? 'is' : 'are'} kept, because you changed ${one2 ? 'it' : 'them'} after the backup deleted ${one2 ? 'it' : 'them'}.`);
  if(drive) after.push('Google Drive: your next Sync brings back anything changed after this backup was made, on either tablet.');
  const when = madeOn(saved);
  return new Promise(res => {
    const m = modal(`<h2>Restore this backup?</h2><div class="restorebody">${when ? `<p>This backup was made on ${esc(when)}.</p>` : ''}` +
      (items.length ? '<ul class="restorelist">' + items.map(t => `<li>${t}</li>`).join('') + '</ul>' : '') +
      after.map(t => `<p>${t}</p>`).join('') + '</div><div class="btns"><button data-x>Cancel</button>' +
      (tooBig ? '<button data-nokeep>Restore without keeping copies</button>' : '<button class="pri" data-ok>Restore</button>') + '</div>');
    m.classList.add('restoreask');
    let done = false;
    const answer = v => { if(done) return; done = true; m.remove(); res(v); };
    m.querySelector('[data-x]').onclick = () => answer(false);
    const ok = m.querySelector('[data-ok]'), nokeep = m.querySelector('[data-nokeep]');
    if(ok) ok.onclick = () => answer('keep');
    /* never the default: focus stays on the box (Enter there does nothing), and a quick tap that opened the box cannot land on it */
    /* it throws charts and marks away: two taps, as every deletion (the first arms it for 3 s and gives focus back to the box, so
       Enter there does nothing) */
    if(nokeep){ nokeep.disabled = true; setTimeout(() => { nokeep.disabled = false; }, 400);
      nokeep.onclick = () => { if(!armed(nokeep, 'Tap again: charts are not kept')){ m.firstElementChild.focus(); return; } answer('nokeep'); }; }
  });
}

/* The result: the toast says what it always said ("Restored 3 songs and 1 setlist", and the gig dates left out); when copies were
   kept, a box that stays until OK says so as well. keep: buildKeeps()'s {charts, sets, setNames}. */
export function restoredText(n, sets, badGig, keep){
  const first = `Restored ${n} song${n == 1 ? '' : 's'} and ${sets} setlist${sets == 1 ? '' : 's'}` + (badGig ? `. ${badGig} gig date${badGig == 1 ? ' that was not a real date was' : 's that were not real dates were'} left out.` : '');
  const more = [];
  if(keep && keep.charts) more.push(`${keep.charts == 1 ? '1 chart' : keep.charts + ' charts'} from this tablet ${keep.charts == 1 ? 'is' : 'are'} in Archived, with ${keep.charts == 1 ? 'its' : 'their'} marks.`);
  if(keep && keep.sets) more.push(keep.sets == 1 ? `A copy of 1 setlist was kept: ${keep.setNames[0]}.` : `Copies of ${keep.sets} setlists were kept: ${keep.setNames.join(', ')}.`);
  return {first, more};
}
export function showRestored({first, more}){
  toast(first);
  if(!more.length) return;
  const m = modal(`<h2>Backup restored</h2><div class="restorebody"><p>${esc(/[.!]$/.test(first) ? first : first + '.')}</p>${more.map(t => `<p>${esc(t)}</p>`).join('')}</div><div class="btns"><button class="pri" data-x>OK</button></div>`);
  m.classList.add('restoredone');
  m.querySelector('[data-x]').onclick = () => m.remove();
}

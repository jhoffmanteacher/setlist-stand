/* The boxes a sync shows besides the "Syncing" box itself (that is busy() in util.js, started by syncui.js): the first-time note,
   the list of deletions made on the other tablet, and the report. Plain words; nothing here vanishes by itself; every name or
   message that came from Drive goes through esc(). */
import {esc, modal, armed} from './util.js';
import {explainError} from './errors.js';
import {LIMIT} from './sync.js';
import {KEEP} from './drivebackup.js';

const WORD = {song:['song', 'songs'], set:['setlist', 'setlists'], coll:['collection', 'collections']};
const count = (n, kind) => `${n} ${WORD[kind][n === 1 ? 0 : 1]}`;
const list = (parts, last = 'and') => parts.length < 3 ? parts.join(` ${last} `) : parts.slice(0, -1).join(', ') + `, ${last} ` + parts.at(-1);
const KINDS = ['song', 'set', 'coll'];

/* Once per tablet, before the first sync. Resolves true for Continue. */
export function introDialog(){
  return new Promise(res => {
    const m = modal(`<h2>Sync your tablets</h2><p>Sync keeps your songs, setlists, collections and your pen marks and notes the same on your tablets, through your own Google Drive. If this is your second tablet, restore a backup from your first one before you sync, so your songs match instead of doubling.</p><p><b>Sync is not a backup.</b> A mistake syncs to your other tablet too. Keep backing up.</p><div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Continue</button></div>`);
    m.querySelector('[data-x]').onclick = () => { m.remove(); res(false); };
    m.querySelector('[data-ok]').onclick = () => { m.remove(); res(true); };
  });
}

/* Deletions made on the other tablet. items: [{kind, id, name}]. Nothing is deleted until the person taps Delete here (two
   taps, like Delete) or Keep. Resolves to Map "kind:id" -> 'delete' | 'keep'; a row left alone is asked again at the next sync. */
export function deletionDialog(items){
  return new Promise(res => {
    const rows = items.map((it, i) => `<li class="row" data-row="${i}"><span class="main"><span class="t">${esc(it.name)}</span><span class="s">${esc(WORD[it.kind][0])}, deleted on your other tablet</span></span><span class="acts"><button data-del="${i}">Delete here</button><button data-keep="${i}">Keep</button></span></li>`).join('');
    const m = modal(`<h2>Deleted on your other tablet</h2><p>These were deleted there. Delete them here too, or keep them (a kept one goes back to your other tablet at the next sync, but not back into the setlists or collections it was taken out of). Nothing is deleted until you tap.</p><ul class="syncdel">${rows}</ul><div class="btns"><button class="pri" data-x data-ok>Done</button></div>`);
    const answers = new Map(), key = i => items[i].kind + ':' + items[i].id;
    /* The answered row's buttons go; focus moves on (to the next row's first button, or Done) so Escape and Tab keep working inside this box. */
    const mark = (i, text) => {
      const row = m.querySelector(`[data-row="${i}"]`); row.querySelector('.acts').innerHTML = `<span class="hint">${esc(text)}</span>`;
      const next = [...m.querySelectorAll('[data-row] .acts button')][0] || m.querySelector('[data-ok]');
      next.focus();
    };
    m.addEventListener('click', e => {
      const b = e.target.closest('button'); if(!b) return;
      if(b.dataset.del != null){ if(!armed(b)) return; answers.set(key(+b.dataset.del), 'delete'); mark(+b.dataset.del, 'Will be deleted here'); }
      else if(b.dataset.keep != null){ answers.set(key(+b.dataset.keep), 'keep'); mark(+b.dataset.keep, 'Kept'); }
    });
    const done = () => { m.remove(); res(answers); };
    m.querySelector('[data-ok]').onclick = done;                       // Escape presses it too (it has data-x)
  });
}

/* The sentence for a run that did not finish. What was done before is kept. */
export function failureText(err){
  const k = err && err.kind;
  if(k === 'auth') return 'Your Google sign-in ran out. Tap Sync to sign in again and finish.';
  if(k === 'offline') return 'The connection to Google was lost. Tap Sync to finish.';
  if(k === 'full') return 'Your Google Drive is full. Free up some space in Drive, then tap Sync.';
  if(k === 'busy') return 'Google is busy right now. Wait a minute, then tap Sync.';
  if(k === 'denied') return 'Google did not give this app permission to use its Drive folder. Tap Disconnect, then Connect again and allow it.';
  if(k === 'off') return 'Google Drive is not switched on for this app in Google\'s settings. That is a setup step, not something wrong on this tablet.';
  if(k === 'big') return 'A PDF is too big to send to Google Drive from this tablet.';
  if(k === 'other' && err.name === 'DriveError') return 'Google did not answer the way the app expected. Tap Sync to try again.';
  return explainError(err);
}

/* The backup copy's line(s) (js/drivebackup.js): after the body and never one of its `lines`, so "Everything is up to date." still shows
   when the only thing that happened is a copy. A copy that was not due says nothing. */
function backupLines(b){
  if(!b || b.state === 'notdue') return '';
  const P = [];
  if(b.state === 'saved'){
    P.push(`Saved a backup copy in your Google Drive (${b.name}, ${b.mb} MB). The last ${KEEP} are kept in the Backups folder.`);
    if(b.skipped) P.push(`${b.skipped} ${b.skipped === 1 ? 'song had' : 'songs had'} no PDF on this tablet and ${b.skipped === 1 ? 'was' : 'were'} left out.`);
    if(b.removed > 0) P.push(`${b.removed} older ${b.removed === 1 ? 'copy was' : 'copies were'} moved to the bin in your Google Drive.`);
    if(b.removed < 0) P.push('Older backup copies could not be tidied up; they are left in the Backups folder.');
  }
  else if(b.state === 'stopped') P.push('The backup copy was stopped. The sync itself is done; a copy is made at a later sync.');
  else if(b.state === 'full') P.push('Your Google Drive is full, so no backup copy was saved. The sync itself is done.');
  else if(b.state === 'toobig') P.push(`Your library (${b.mb} MB) is too big for a backup copy in Google Drive. Use Back up everything instead.`);
  else if(b.state === 'failed') P.push(`The backup copy could not be saved in Google Drive (${b.why}). The sync itself is done; it is tried again at the next sync.`);
  return P.length ? `<div class="syncrep syncbackup"><p>${P.map(esc).join('</p><p>')}</p></div>` : '';
}

/* The report, which stays until OK. state: 'done' | 'stopped' | 'failed'. */
export function reportDialog(rep, state = 'done', failure = ''){
  const lines = [], P = text => lines.push(esc(text));   // every line is HTML that is already safe
  const kindsOf = bag => list(KINDS.filter(k => bag[k]).map(k => count(bag[k], k)));
  if(rep.sent.song + rep.sent.set + rep.sent.coll) P(`Sent ${kindsOf(rep.sent)}.`);
  if(rep.got.song + rep.got.set + rep.got.coll) P(`Got ${kindsOf(rep.got)}.`);
  const pages = n => `${n} ${n === 1 ? 'page' : 'pages'}`, marks = rep.marks || {};
  if(marks.sent) P(`Sent marks on ${pages(marks.sent)}.`);
  if(marks.got) P(`Got marks on ${pages(marks.got)}.`);
  if(rep.survived && rep.survived.length) lines.push(`${rep.survived.length === 1 ? 'A song or setlist was' : rep.survived.length + ' were'} deleted on your other tablet but changed here afterwards, so ${rep.survived.length === 1 ? 'it stays' : 'they stay'} and ${rep.survived.length === 1 ? 'goes' : 'go'} back there: ${list(rep.survived.slice(0, 6).map(n => `'${esc(n.name)}'`))}${rep.survived.length > 6 ? ` and ${rep.survived.length - 6} more` : ''}.`);
  if(rep.repaired) P(`Put back ${rep.repaired} ${rep.repaired === 1 ? 'PDF' : 'PDFs'} that ${rep.repaired === 1 ? 'was' : 'were'} missing or not the right one in Google Drive.`);
  if(rep.unapplied) P(`Your ${rep.unapplied === 1 ? 'answer' : rep.unapplied + ' answers'} about what was deleted on your other tablet ${rep.unapplied === 1 ? 'was' : 'were'} not applied, because the sync stopped first. You are asked again next time.`);
  if(rep.kept) P(`Kept ${rep.kept} here that was deleted on your other tablet.`);
  if(rep.removed) P(`Deleted ${rep.removed} here, as you chose.`);
  if(rep.archived) P(`${rep.archived} ${rep.archived === 1 ? 'chart' : 'charts'} on this tablet ${rep.archived === 1 ? 'was' : 'were'} replaced by a newer one from your other tablet and ${rep.archived === 1 ? 'is' : 'are'} kept in Archived.`);
  if(rep.later) P(`${rep.later} deleted on your other tablet ${rep.later === 1 ? 'is' : 'are'} still waiting for your answer: you are asked again at the next sync.`);
  const names = n => `'${esc(n.name)}'`;
  if(rep.both.length) lines.push(`${rep.both.length} changed on both tablets (the newer one was kept: ${list(rep.both.slice(0, 6).map(n => `${names(n)}${n.kept === 'there' ? ' from your other tablet' : ' from here'}`))}${rep.both.length > 6 ? ` and ${rep.both.length - 6} more` : ''}).`);
  if(rep.changedMeanwhile) P(`${rep.changedMeanwhile} changed on this tablet while syncing: they go at the next sync.`);
  if(rep.limited) P(`${rep.limited} ${rep.limited === 1 ? 'song was' : 'songs were'} not downloaded this time (the limit for one sync is ${Math.round(LIMIT.run / 1e6)} MB). Tap Sync again to get the rest.`);
  if(rep.future.length) P(`${rep.future.length} ${rep.future.length === 1 ? 'record has' : 'records have'} a date more than a day ahead of this tablet's clock (a tablet's clock may be wrong). They were synced like the others.`);
  if(rep.strays) P(`${rep.strays} ${rep.strays === 1 ? 'file' : 'files'} in your Drive folder did not come from this app and ${rep.strays === 1 ? 'was' : 'were'} left alone.`);
  const skipped = rep.skipped.length ? `<p>Skipped, and nothing was written for ${rep.skipped.length === 1 ? 'it' : 'them'}:</p><ul class="duplist">${rep.skipped.slice(0, 12).map(s => `<li>${esc(s.name)}: ${esc(s.why)}</li>`).join('')}${rep.skipped.length > 12 ? `<li>and ${rep.skipped.length - 12} more</li>` : ''}</ul>` : '';
  const title = state === 'done' ? 'Sync finished' : state === 'stopped' ? 'Sync stopped' : 'Sync could not finish';
  const lead = state === 'failed' ? `<p>${esc(failure)}</p><p class="hint">What was done before is kept, and nothing is half written.</p>`
    : state === 'stopped' ? '<p>You stopped it. What was done before is kept, and nothing is half written.</p>' : '';
  const quiet = !lines.length || (lines.length === 1 && rep.strays);                    // nothing but a note about files that are not ours
  const body = (state === 'done' && !rep.skipped.length && quiet ? '<p>Everything is up to date.</p>' : '') + (lines.length ? `<div class="syncrep"><p>${lines.join('</p><p>')}</p></div>` : '');
  const m = modal(`<h2>${title}</h2>${lead}${body}${skipped}${backupLines(rep.backup)}<div class="btns"><button class="pri" data-x data-ok>OK</button></div>`);
  m.querySelector('[data-ok]').onclick = () => m.remove();
  return m;
}

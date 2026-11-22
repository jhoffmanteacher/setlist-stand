import {$} from './util.js';
import {state, newestChange, newestRecordChange} from './store.js';
import {LAST_BACKUP} from './backup.js';
import {lastSync} from './sync.js';

/* The backup reminder (Jonathan, 2026-11-21): shown when something has CHANGED since the last backup, and only then (not by days).
   "Changed" is any record in any store but `files` whose `updated` is later than the time of the last backup (`ss-last-backup`):
   songs, setlists, collections, ink pages and deletion markers; settings in localStorage do not count. js/store.js keeps the
   newest `updated` in memory (newestChange) as writes happen, so working this out costs nothing, and fires `ss-changed` when it
   moves, so the line below appears after any save without a reload. With songs and no backup ever it says so. A restore counts
   as a backup (js/backup.js sets `ss-last-backup`), so the restored library is not reported as changed until the next change.
   It is drawn into #libNudge on the Library and the Setlists tabs (an open setlist too), never in the viewer.
   The same line also says when something has changed since this tablet's last SYNC (`ss-last-sync`, set by js/sync.js; only once
   this tablet has synced) and offers a Sync button next to Back up now. The two are kept apart in the words: a sync is not a
   backup, so syncing never clears the backup reminder and backing up never clears the sync one. */
export function lastBackup(){ try{ const t = Number(localStorage.getItem(LAST_BACKUP)); return t > 0 && t <= Date.now() + 864e5 ? t : null; }catch(e){ return null; } }       // a time saved while the clock was ahead counts as never: it must not hide later changes
export function daysAgo(t){
  const day = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  return Math.max(0, Math.round((day(Date.now()) - day(t)) / 864e5));
}
export const agoText = n => n == 0 ? 'today' : n == 1 ? 'yesterday' : `${n} days ago`;
/* True when the reminder is showing: songs, and no backup ever or a change since the last one. */
export function backupDue(){
  const t = lastBackup();
  return state.songs.length > 0 && (t == null || newestChange() > t);
}
/* True when this tablet has synced before and something has changed since. */
export function syncDue(){
  const t = lastSync();
  return t > 0 && newestRecordChange() > t;       // songs, setlists, collections: ink is not synced yet, so a mark is not a change to sync
}
export function renderNudge(){
  const el = $('#libNudge'); if(!el) return;
  const t = lastBackup(), b = backupDue(), s = syncDue(), st = lastSync();
  const sync = `your last sync (${agoText(daysAgo(st))})`;
  const text = b && s ? (t == null ? `You have not backed up yet. Changes since ${sync}.` : `Changes since your last backup (${agoText(daysAgo(t))}) and ${sync}.`)
    : b ? (t == null ? 'You have not backed up yet.' : `Changes since your last backup (${agoText(daysAgo(t))}).`)
    : s ? `Changes since ${sync}.` : '';
  el.innerHTML = text ? `<div class="nudge" role="status"><span>${text}</span>${b ? '<button data-backupnow>Back up now</button>' : ''}${s ? '<button data-syncnow>Sync</button>' : ''}</div>` : '';
  const last = $('#libLastBackup');
  if(last) last.textContent = !backupDue() && t != null ? `Last backup: ${agoText(daysAgo(t))}.` : '';
}
addEventListener('ss-changed', renderNudge);

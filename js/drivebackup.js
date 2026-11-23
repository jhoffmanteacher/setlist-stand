/* A backup copy in the person's Google Drive, made at the end of a sync that FINISHED (Jonathan, 2026-11-23: it counts as a backup,
   weekly, the last 4 kept, on by default, older ones go to the Drive bin). One job: decide whether a copy is due, make it with
   makeBackup() (the same file Back up everything saves), send it to a marked "Backups" folder the sync never reads, tidy old copies.

   It runs only after the sync has written `ss-last-sync`, so whatever happens here never changes the sync's result: this file
   NEVER throws, it answers with a state the report words (js/syncdialogs.js). Stop (or Cancel) ends only the copy; a full Drive, a
   lost connection or a refusal end only the copy; a file left half sent does not exist (Drive makes a file only when its upload is
   whole, and a stopped upload is aborted).

   Due when BOTH: the newest copy in Drive (Drive's own createdTime: both tablets agree on Google's clock) is EVERY_DAYS or more
   calendar days old, or there is none; AND this tablet's own `ss-drive-backup` is absent or as old (a tablet with a clock far ahead
   cannot make a copy at every sync; a stored time far in the future counts as absent). So two tablets that sync in one week make
   ONE copy between them. `ss-drive-backup` is per tablet: never synced, backed up or shared. */
import {makeBackup, LAST_BACKUP} from './backup.js';
import {all, get} from './store.js';
import {putFile, trashFile, ensureBackups, findBackups, listBackups} from './driveops.js';
import {daysAgo} from './nudge.js';

export const DRIVE_BACKUP = 'ss-drive-backup';        // localStorage: when THIS tablet last sent a backup copy to Drive (ms, when packing began)
export const EVERY_DAYS = 7, KEEP = 4;
export const limits = {maxBytes:300e6};                // the PDFs together: over this no copy is made (an object so a test can lower it)
const mb = n => Math.max(1, Math.round(n / 1e6));
export const copyName = t => 'setlist-stand-backup-' + new Date(t).toISOString().slice(0, 10) + '.zip';   // the name Back up everything gives, so Restore takes it as it is

function ownTime(){
  try{ const t = Number(localStorage.getItem(DRIVE_BACKUP)); return t > 0 && t <= Date.now() + 864e5 ? t : 0; }catch(e){ return 0; }
}
/* `files`: the copies in Drive, newest first. */
function due(files){
  const t = ownTime();
  if(t && daysAgo(t) < EVERY_DAYS) return false;
  if(files.length){ const c = Date.parse(files[0].createdTime); if(Number.isFinite(c) && daysAgo(c) < EVERY_DAYS) return false; }
  return true;
}
/* What the zip would hold: the size of the stored PDFs of the live songs, and whether there is anything at all (a live song or setlist). */
async function inventory(){
  let bytes = 0, any = (await all('sets')).some(s => !s.deleted);
  for(const s of await all('songs')){ if(s.deleted) continue; any = true; const f = await get('files', s.id); if(f) bytes += f.size; }
  return {bytes, any};
}
/* The copies beyond the KEEP newest go to the bin; the one just made is never among them. Resolves to how many were moved. */
async function prune(folder, keepId, signal){
  const files = await listBackups(folder, {signal});
  const keep = new Set([keepId, ...files.filter(f => f.id !== keepId).slice(0, KEEP - 1).map(f => f.id)]);
  let n = 0;
  for(const f of files) if(!keep.has(f.id)){ await trashFile(f.id, {signal}); n++; }
  return n;
}
const whyNot = e => e && e.kind === 'offline' ? 'the connection was lost' : e && e.kind === 'auth' ? 'the Google sign-in ran out' : e && e.kind === 'busy' ? 'Google is busy'
  : e && e.kind === 'denied' ? 'Google did not give this app permission' : e && e.kind === 'big' ? "the browser could not read Google's upload address" : 'something went wrong';

/* -> {state:'notdue'} | {state:'saved', name, mb, skipped, removed} (removed: -1 = the tidy-up failed) | {state:'stopped'} | {state:'full'}
      | {state:'toobig', mb} | {state:'failed', why}. `ctx`: the sync's shared object (layout, say, signal); `stopped`: () => the person pressed Stop. */
export async function driveBackup(ctx, stopped){
  try{
    const signal = ctx.signal;
    const folder = await findBackups(ctx.layout, {signal});            // null: none yet (made at the first copy)
    const files = folder ? await listBackups(folder, {signal}) : [];
    if(!due(files)) return {state:'notdue'};
    const {bytes, any} = await inventory();
    if(!any) return {state:'notdue'};                               // an empty tablet has nothing to keep (Back up everything says the same); an empty copy must never push a good one out
    if(bytes > limits.maxBytes) return {state:'toobig', mb:mb(bytes)};
    const began = Date.now();
    ctx.say('Making a backup copy…');
    const made = await makeBackup({say:ctx.say, get stopped(){ return stopped(); }});
    if(!made) return {state:'stopped'};
    const dir = folder || await ensureBackups(ctx.layout, {signal});
    if(stopped()) return {state:'stopped'};
    ctx.say(`Sending the backup copy to Google Drive (${mb(made.blob.size)} MB)…`);
    const sent = await putFile({parent:dir, name:copyName(began), mime:'application/zip', appProperties:{k:'backup', t:String(began)}, bytes:made.blob}, {signal});
    /* It is in Drive: only now does this tablet remember it, and count it as a backup (the time packing began, so a change made while
       it was being sent still shows the reminder). */
    try{ localStorage.setItem(DRIVE_BACKUP, String(began)); }catch(e){}
    try{ if(!(Number(localStorage.getItem(LAST_BACKUP)) >= began)) localStorage.setItem(LAST_BACKUP, String(began)); }catch(e){}
    let removed = 0;
    try{ removed = await prune(dir, sent.id, signal); }catch(e){ removed = -1; }
    return {state:'saved', name:copyName(began), mb:mb(made.blob.size), skipped:made.skipped, removed};
  }catch(e){
    if(stopped() || (e && e.name === 'AbortError')) return {state:'stopped'};
    if(e && e.kind === 'full') return {state:'full'};
    return {state:'failed', why:whyNot(e)};
  }
}

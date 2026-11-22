/* Sync marks: the pen strokes, highlighter strokes and text notes of one Google Drive sync (Part 3), page by page. js/sync.js runs it
   with the run's `ctx`; what to keep of two versions of a page is mergePage() in js/syncink.js (pure: by stroke id, never by the
   page's `updated`). On Drive: one file per page in "Marks (do not edit)" (js/driveops.js).

   For every page on either side, once the song's own fate is decided (the merge result is written here if it differs from this
   tablet's page, and sent if it differs from Drive's):
     only here, not empty     sent (a page of only erase markers IS sent: the other tablet must learn the erase)
     only on Drive            read, checked, merged into an empty page, written here
     both, the same `c`       nothing
     both, other `c`          Drive's read and checked, mergePage(here, Drive)
   A song's marks sync only while the song is live here, Drive's RECORD of it is this tablet's (the same at the last look, or sent or
   written whole by this run) AND Drive's PDF is its chart (listed so, or put there by this run): marks never revive a song, never go up
   for a song Drive has deleted, does not have or still names another chart for (a record Drive refused after its PDF went up), and
   never move from one chart to another while a newer chart has not come down yet. Every page file names the chart it was drawn on
   (property `h`, the PDF's SHA-256): a Drive page of another chart is never merged here, not even in the run that puts a new chart
   up (this tablet's page replaces it when it has one; else it is left alone and ignored, not listed). Pages past the song's `pages` are neither written nor sent: a Drive
   page past the end is listed, except that the tablet that puts a new, shorter chart on Drive removes those pages of the old one
   (their marks are on its archived copy), so they are not listed for ever; a Drive page of a song neither tablet has is listed.
   The pages of a song that COMES DOWN are read before it and written in its own putAll (incomingPages + mergeIncoming, called by
   download() in js/syncapply.js); everything else is syncMarks(), after the uploads: one small putAll per page, with `ifUpdated`.
   Every page from Drive is checked before anything is written (readPage): its size, JSON, nesting, inkProblem (js/backup.js) and
   inkShapeProblem (js/syncink.js), its `updated` equal to the listed `u` and its canonical hash equal to the listed `c`. A bad page
   is skipped and listed ("<song>: page N: <why>"), never written and never fatal; Google refusing five pages in a row ends the run.
   A Drive file is replaced only while it is still the one that was merged (its `c` is read again first); else the next sync merges
   both. A full Drive stops the sending, not the receiving (ctx.full, set here or by a record upload): js/sync.js ends the run with it
   after the pages that only come down. A page of this
   tablet's that is not sent (skipped, refused, too big, Drive full) counts as a change to sync (syncPending). sweepMarks() removes the Drive pages of songs whose deletion is on Drive and that are deleted (or absent) here. */
import {get, all, putAll, update, inkEntries, upgradeInk, syncPending, ID_RE} from './store.js';
import {canon, digest} from './syncmerge.js';
import {mergePage, inkFileName, inkShapeProblem, MAX_READ} from './syncink.js';
import {inkProblem} from './backup.js';
import {downloadText, putFile, fileProps, deleteFile, inkProps, ensureInk, TooBig} from './driveops.js';
import {DriveError} from './drive.js';
import {nameOf, perFile, refusedText} from './syncplan.js';

const HEX64 = /^[0-9a-f]{64}$/;
const DEPTH = 32;               // a page is 5 deep ({strokes:[{p:[[x, y]]}]}); fields a later version adds may nest a little more
const MORE = 'this sync has already read as much as it will; sync again for the rest';      // the words fetchRecord uses
const lower = h => String(h || '').toLowerCase();
const splitKey = key => { const i = key.lastIndexOf(':'); return {songId:key.slice(0, i), page:Number(key.slice(i + 1))}; };
const cOf = rec => digest(canon(rec));
/* Whether a merge changed what this page SHOWS here (a mark drawn, edited or erased on the other tablet): not just the drawing order
   mergePage settles on (live strokes, then erase markers) or a newer marker for a mark already erased, which are written but not "got". */
const shown = page => new Map((page ? page.strokes : []).filter(s => !s.deleted).map(s => [s.id, JSON.stringify(s)]));
const brought = (before, after) => {
  const a = shown(before), b = shown(after);
  return a.size !== b.size || [...b].some(([id, j]) => a.get(id) !== j);
};

/* ---------- the listing and this tablet's pages ---------- */
/* Drive's pages of one song, from this run's listing: Map page -> listed entry (built once per listing). */
const bySong = new WeakMap();
function drivePages(lib, songId){
  let m = bySong.get(lib);
  if(!m){
    m = new Map();
    for(const [key, e] of lib.ink){ const k = splitKey(key); if(!m.has(k.songId)) m.set(k.songId, new Map()); m.get(k.songId).set(k.page, e); }
    bySong.set(lib, m);
  }
  return m.get(songId) || new Map();
}
/* The stored page, upgraded as opening the song upgrades it. An old bare list gets its ids ONCE: written back before it is synced
   (or every run would give its strokes new ids). null: no page, or it changed while being upgraded (then a write over it is stale). */
async function stored(key, raw){
  if(raw == null) return null;
  const {record, changed} = upgradeInk(raw);
  if(!changed) return record;
  const was = JSON.stringify(raw);
  return (await update('ink', key, cur => cur != null && JSON.stringify(cur) === was ? record : undefined)) || null;
}
/* A stored page as Drive gets it (JSON: a field holding `undefined` is left out, as JSON.stringify leaves it out), checked as a page from
   Drive is checked, so this tablet never sends what the other one would refuse. {rec, c, ifUpdated} ({rec:null} for no page) or {problem}. */
async function sendable(key, page){
  const ifUpdated = page && typeof page.updated === 'number' ? page.updated : null;
  if(!page) return {rec:null, c:null, ifUpdated};
  let rec, c;
  try{ rec = JSON.parse(JSON.stringify(page)); }catch(e){ return {problem:'its marks on this tablet could not be read'}; }
  const prob = pageProblem(key, rec);
  if(prob) return {problem:`its marks on this tablet are damaged (${prob}), so they are not synced`};
  try{ c = await cOf(rec); }catch(e){ return {problem:'its marks on this tablet could not be read'}; }
  return {rec, c, ifUpdated};
}
/* What the other tablet checks on a page it reads (inkShapeProblem: times up to MAX_U): never send what it would refuse at every sync. */
const pageProblem = (key, rec) => (tooDeep(rec, DEPTH) ? 'nested too deep' : null) || inkProblem(key, rec) || inkShapeProblem(rec);
/* Whether a song's marks sync in this run (see the top). `open`: the songs whose record the last look found different on the two sides
   and this run did not settle (an upload Drive refused, a download skipped, a deletion asked about, a record that could not be read). */
function marksSync(ctx, song, open){
  if(!song || song.deleted) return false;
  const h = lower(song.hash), id = song.id;
  if(!HEX64.test(h)) return false;
  const r = ctx.lib.records.song.get(id), pf = ctx.lib.pdfs.get(id);
  const record = ctx.sent.get(id) === 'live' || (!open.has(id) && !!r && !r.d);       // Drive's record is this tablet's
  return record && ((!!pf && pf.h === h) || ctx.pdfOn.get(id) === h);                 // and Drive's PDF is its chart
}
/* The songs of the last look whose record this run did not bring to agree (see marksSync). */
function unsettled(ctx, s2){
  const open = new Set();
  for(const w of s2.work) if(w.kind === 'song' && !(w.op === 'up' ? ctx.sent.get(w.id) === 'live' : ctx.downNow.has(w.id))) open.add(w.id);
  for(const a of s2.asks) if(a.kind === 'song') open.add(a.id);
  for(const k of [...s2.holdOff, ...s2.skips.keys()]) if(k.startsWith('song:')) open.add(k.slice(5));
  return open;
}

/* mine: this tablet holds marks on the page that do not go to Drive because of the skip, a change to sync until they do */
const skipPage = (ctx, song, page, why, mine = false) => { ctx.execSkips.set(`ink:${song.id}:${page}`, {kind:'ink', name:nameOf('song', song), why:`page ${page}: ${why}`}); if(mine) syncPending(); };
const unskipPage = (ctx, song, page) => ctx.execSkips.delete(`ink:${song.id}:${page}`);

/* ---------- a page from Drive ---------- */
/* true when an object or list sits deeper than `max`: walked without recursion, so a hostile file cannot overflow the stack here */
function tooDeep(v, max){
  const stack = [[v, 1]];
  while(stack.length){
    const [x, d] = stack.pop();
    if(d > max) return true;
    for(const y of Array.isArray(x) ? x : Object.values(x)) if(y && typeof y === 'object') stack.push([y, d + 1]);
  }
  return false;
}
/* Drive's page, read and checked: {rec} or {skip, bad}. `bad`: the file itself is wrong (it is not read again this run). Counts the
   pages and bytes it reads in the run's budget for JSON files and Google's refusals in a row (pages counted apart). */
async function readPage(ctx, key, e){
  const L = ctx.limit;
  if(ctx.inkPages >= L.pages || ctx.recBytes > L.records) return {skip:MORE};
  if(e.size > L.page) return {skip:'its file in Drive is too big', bad:true};
  if(e.u > MAX_READ) return {skip:'its file in Drive is dated too far in the future (a tablet\'s clock or the file is wrong), so it is not taken', bad:true};
  let text;
  try{ text = await downloadText(e.fileId, {signal:ctx.signal, maxBytes:L.page, what:'a page of marks'}); }
  catch(err){
    if(err instanceof TooBig) return {skip:'its file in Drive is too big', bad:true};
    if(err instanceof DriveError && err.status === 404) return {skip:'its file is no longer in Drive'};
    if(perFile(err)){ if(++ctx.inkRefusals >= 5) throw err; return {skip:refusedText(err)}; }
    throw err;
  }
  ctx.inkRefusals = 0; ctx.inkPages++; ctx.recBytes += text.length;
  const bad = why => ({skip:why, bad:true});
  let rec;
  try{ rec = JSON.parse(text); }catch(err){ return bad('its file in Drive is not a page of marks'); }
  if(rec && typeof rec === 'object' && tooDeep(rec, DEPTH)) return bad('its file in Drive is nested too deep');
  const prob = inkProblem(key, rec) || inkShapeProblem(rec, MAX_READ);
  if(prob) return bad(`its file in Drive is not valid (${prob})`);
  if(rec.updated !== e.u) return bad('its file in Drive was changed outside the app');
  let c;
  try{ c = await cOf(rec); }catch(err){ return bad('its file in Drive could not be read'); }
  if(c !== e.c) return bad('its file in Drive was changed outside the app');
  return {rec};
}
/* readPage, once per file version and run: a page read (or refused) for one listing is not read again for the same `c`. */
async function fetchPage(ctx, key, e){
  const got = ctx.inkGot.get(key);
  if(got && got.c === e.c) return got.r;
  const r = await readPage(ctx, key, e);
  if(r.rec || r.bad) ctx.inkGot.set(key, {c:e.c, r});
  return r;
}

/* ---------- down: the pages of a song that comes down, in its own write ---------- */
/* rec: Drive's song record (checked, normalised), about to be written. Map page -> {remote, base, ifUpdated} for each page Drive holds
   that differs from this tablet's (Drive's page read and checked). A bad page is skipped and listed; the song still comes down. */
export async function incomingPages(ctx, rec){
  const out = new Map();
  for(const [page, e] of [...drivePages(ctx.lib, rec.id)].sort((x, y) => x[0] - y[0])){
    if(page > rec.pages) continue;
    ctx.check();
    if(e.h !== lower(rec.hash)) continue;                                     // drawn on another chart of the song: never merged into this one
    const key = rec.id + ':' + page, here = await sendable(key, await stored(key, await get('ink', key)));
    if(here.problem){ skipPage(ctx, rec, page, here.problem, true); continue; }
    if(here.c === e.c) continue;                                              // the same page: nothing to read
    const r = await fetchPage(ctx, key, e);
    if(r.skip){ skipPage(ctx, rec, page, r.skip); continue; }
    out.set(page, {remote:r.rec, base:here.rec, ifUpdated:here.ifUpdated});
  }
  return out;
}
/* Puts the merged pages into the song's ops (over a page keepOldChart already started afresh for a new chart, which is then the
   page merged). {got: pages written here, up: a merged page holds this tablet's marks that Drive does not have yet}. */
export function mergeIncoming(ctx, rec, incoming, ops){
  let got = 0, up = false;
  for(const [page, {remote, base, ifUpdated}] of incoming){
    const key = rec.id + ':' + page, i = ops.findIndex(o => o.store === 'ink' && o.key === key);
    if(i >= 0 && ops[i].delete) continue;
    let m, start;
    try{ start = i >= 0 ? JSON.parse(JSON.stringify(ops[i].value)) : base; m = mergePage(start, remote); }catch(err){ skipPage(ctx, rec, page, 'its marks could not be merged'); continue; }
    /* the two sides together can be more than a page may hold (entries, points, size): nothing of it is written, here or there */
    const prob = pageProblem(key, m.record);
    if(prob){ skipPage(ctx, rec, page, `the marks of both tablets together cannot be synced (${prob})`, true); continue; }
    const op = {store:'ink', key, value:m.record, ifUpdated};
    if(i >= 0) ops[i] = op; else if(m.changed.local) ops.push(op);
    if(m.changed.local && brought(start, m.record)) got++;
    if(m.changed.remote) up = true;
  }
  return {got, up};
}

/* ---------- the rest: page by page, after the uploads ---------- */
/* One page to Drive (`R`: the listed file it replaces, or null for a new one). False when it did not go (then the reminder says so). */
async function sendPage(ctx, song, page, rec, R){
  const {layout, signal, rep, limit} = ctx;
  if(ctx.full){ syncPending(); return false; }                              // Drive is full: nothing more is sent this run
  let blob, c;
  try{ blob = new Blob([JSON.stringify(rec)], {type:'application/json'}); c = await cOf(rec); }
  catch(err){ skipPage(ctx, song, page, 'its marks on this tablet could not be read', true); return false; }
  if(blob.size > limit.page){ skipPage(ctx, song, page, 'its marks are too big to sync', true); return false; }
  try{
    if(R && (await fileProps(R.fileId, {signal})).c !== R.c){ syncPending(); return false; }       // changed on Drive since it was read: the next sync merges both
    const parent = R ? undefined : await ensureInk(layout, {signal});          // the Marks folder is made at the first page that needs it
    await putFile({fileId:R ? R.fileId : undefined, parent, name:inkFileName(song.id, page), mime:'application/json',
      appProperties:inkProps(song.id, page, rec.updated, c, lower(song.hash)), bytes:blob}, {signal});
    ctx.inkRefusals = 0; rep.marks.sent++;
    return true;
  }catch(err){
    syncPending();
    if(err instanceof DriveError && err.status === 404) return false;          // removed from Drive meanwhile: it goes at the next sync
    if(err instanceof DriveError && err.kind === 'full'){ ctx.full = err; return false; }      // the pages that only come down still do; the run ends with it
    if(perFile(err)){ if(++ctx.inkRefusals >= 5) throw err; skipPage(ctx, song, page, refusedText(err)); return false; }
    throw err;
  }
}
async function onePage(ctx, song, page, raw, R){
  const key = song.id + ':' + page, here = await sendable(key, await stored(key, raw));
  const mine = !!here.rec && here.rec.strokes.length > 0;
  if(here.problem){ skipPage(ctx, song, page, here.problem, true); return; }
  const same = !!R && R.h === lower(song.hash);                             // Drive's page was drawn on this chart (else it is never merged here)
  let remote = null;
  if(same){
    if(here.c === R.c) return;                                                // the same page on both sides
    const r = await fetchPage(ctx, key, R);
    if(r.skip){ skipPage(ctx, song, page, r.skip, mine); return; }
    remote = r.rec;
  }else if(!mine) return;                                                     // nothing here: no file for it (Drive's page of another chart is left alone)
  let m;
  try{ m = mergePage(here.rec, remote); }catch(err){ skipPage(ctx, song, page, 'its marks could not be merged', mine); return; }
  /* the two sides together can be more than a page may hold (entries, points, size): nothing of it is written, here or there */
  const prob = pageProblem(key, m.record);
  if(prob){ skipPage(ctx, song, page, `the marks of both tablets together cannot be synced (${prob})`, true); return; }
  if(m.changed.local){
    try{ await putAll([{store:'ink', key, value:m.record, ifUpdated:here.ifUpdated}], {fromSync:true}); if(remote && brought(here.rec, m.record)) ctx.rep.marks.got++; }
    catch(err){ if(err && err.name === 'StaleWrite'){ ctx.rep.changedMeanwhile++; return; } throw err; }      // drawn on in another tab meanwhile: the next sync
  }
  if((m.changed.remote || (R && !same)) && !(await sendPage(ctx, song, page, m.record, R))) return;      // (a page of another chart is replaced by this one)
  unskipPage(ctx, song, page);
}
/* A Drive page past the song's last page. Never written. Drawn on another chart (its file's `h`), while Drive holds this one (marksSync):
   the old chart's, whose marks are on its archived copy: removed, also by a later run when the one that put the chart up was cut off.
   Drawn on this very chart: something is wrong, so it is listed. */
async function pastEnd(ctx, song, page, R){
  if(R.h !== lower(song.hash)){
    try{ await deleteFile(R.fileId, {signal:ctx.signal}); }catch(err){ if(!perFile(err)) throw err; }
    return;
  }
  skipPage(ctx, song, page, `the song has no page ${page}`);
}
/* Every page of every song whose marks sync, on either side, against this run's last listing (ctx.lib). A Drive page of a song that is
   neither here nor in Drive's records is listed; one whose song is on its way (not down yet, a deletion asked about, a chart not
   down yet) waits without a word: the song's own line says why. */
export async function syncMarks(ctx, s2){
  const open = unsettled(ctx, s2);
  const songs = ctx.songsNow = new Map((await all('songs')).filter(s => s && typeof s.id === 'string').map(s => [s.id, s]));
  const here = new Map((await inkEntries()).filter(([k]) => typeof k === 'string'));
  const keys = [...new Set([...here.keys(), ...ctx.lib.ink.keys()])].sort();
  for(const key of keys){
    const {songId, page} = splitKey(key), song = songs.get(songId), R = ctx.lib.ink.get(key) || null;
    if(!ID_RE.test(songId) || !Number.isInteger(page) || page < 1) continue;
    if(!marksSync(ctx, song, open)){
      if(R && (!song || song.deleted) && !ctx.lib.records.song.has(songId) && !ctx.sent.has(songId)) skipPage(ctx, song || {id:songId}, page, 'it belongs to no song in your library');
      continue;
    }
    ctx.check(); ctx.say('Syncing marks…');
    if(page > song.pages){ if(R) await pastEnd(ctx, song, page, R); continue; }
    await onePage(ctx, song, page, here.get(key), R);
  }
}
/* The Drive pages of a song whose deletion is on Drive (or went there in this run) and that is deleted or absent here. Idempotent. */
export async function sweepMarks(ctx){
  const {lib, signal} = ctx, songs = ctx.songsNow || new Map();
  for(const [key, e] of lib.ink){
    const id = splitKey(key).songId, r = lib.records.song.get(id), l = songs.get(id);
    if(!((r && r.d) || ctx.sent.get(id) === 'deleted') || (l && !l.deleted)) continue;
    ctx.check();
    try{ await deleteFile(e.fileId, {signal}); }catch(err){ if(!perFile(err)) throw err; }
  }
}

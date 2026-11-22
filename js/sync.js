/* One sync run: songs, setlists, collections and the PDFs (Part 2), and the pages of marks (Part 3: pen, highlighter and text
   notes, merged by stroke id in js/syncink.js, carried out by js/syncmarks.js), between this tablet and the person's Google Drive.
   Only ever started by a tap (Sync). No screen code here: the box, the deletion list and the
   report are js/syncui.js and js/syncdialogs.js; this file is handed `say`, `stopped`, `signal` and `decide`.

   What decides is js/syncmerge.js (pure; by id and `updated` only: never by title or PDF hash, because Copy song makes two songs
   with one PDF). What talks to Drive is js/driveops.js. This file holds the run's order, its report, its limits and `lastSync`;
   reading both sides and deciding is js/syncplan.js, doing it is js/syncapply.js, and the run's shared state goes to both in one
   `ctx` object made here for each run. The decisions are carried out in this order:
     1. one listing of each Drive folder, this tablet's records, the plan;
     2. a record with the same `updated` as Drive's but other content (a tie): Drive's is read and the same rule on both tablets
        picks one, so they stop swapping;
     3. deletions made on the other tablet are LISTED and nothing is deleted until the person taps Delete here or Keep;
     4. upload what is newer here (a song's PDF first, so a reader never meets a record without its file), then download what
        is newer there, one song at a time: the PDF must start with %PDF- and its SHA-256 must equal the record's `hash`, and it
        is written WITH its record (and Drive's pages of marks for it, merged) in ONE putAll, and only if the local record still
        has the `updated` that was read (ifUpdated);
     5. the pages of marks of the songs already here, page by page (js/syncmarks.js), then the sweeps of a deleted song's files;
     6. the report.
   Every unit is safe to repeat. A run that is stopped, loses the network or the sign-in, or is cut off by a reload leaves the
   library whole and the next run finishes the job. Nothing on this tablet is deleted because something is missing from Drive.
   Everything from Drive is untrusted: ids, lengths and counts are checked like a restore (songProblem and the other two from
   backup.js), and a bad record or PDF is skipped and listed by name, never written; one bad song never stops the others. */
import {ensureLayout} from './driveops.js';
import {survey, nameOf} from './syncplan.js';
import {runUps, runDowns, downs, deleteHere, keep, repairPdfs, sweepPdfs} from './syncapply.js';
import {syncMarks, sweepMarks} from './syncmarks.js';

export const LAST_SYNC = 'ss-last-sync';            // localStorage: when this tablet last finished a sync (ms). Per tablet: never synced, backed up or shared.
export const LIMIT = {pdf:100e6, run:500e6, record:1e6, records:50e6,     // bytes: one PDF, all the PDFs downloaded in one run, one record file, all the record files of one run (his library is 43 MB in 74 PDFs, the largest 2.3 MB)
  /* A page of marks: 5 MB, the most one upload request carries (MULTIPART_MAX in js/driveops.js: a page never needs the resumable
     route). A stroke is about 1.5 KB (points thinned to .0015 of the page apart, 4 decimals), a line across the whole page about
     11 KB, so 5 MB holds some 3000 ordinary strokes, or 450 of the longest; Drive's pages read in one run count in `records` too,
     and at most `pages` of them are read (a first sync of his library reads a few hundred; each is one request). */
  page:5e6, pages:2000};
const CAP = {song:20000, set:5000, coll:2000, ink:100000};      // more records of a kind (or pages of marks) than this in Drive is not this app's library: the run is refused (a restore has its own, larger LIMITS)

/* The person pressed Stop (or Cancel took the request in flight with it). `report` is what was done before. */
export class Stopped extends Error { constructor(report){ super('stopped'); this.name = 'Stopped'; this.report = report; } }
/* Drive, the network or this tablet's storage failed part-way; `cause` is the error, `report` what was done before. */
export class Failed extends Error { constructor(cause, report){ super(cause && cause.message || 'failed'); this.name = 'Failed'; this.cause = cause; this.report = report; } }

export const blankReport = () => ({sent:{coll:0, song:0, set:0}, got:{coll:0, song:0, set:0}, marks:{sent:0, got:0}, both:[], skipped:[], future:[], kept:0, removed:0, later:0, limited:0, strays:0, changedMeanwhile:0, archived:0, repaired:0, survived:[], unapplied:0});
export const lastSync = () => { try{ const t = Number(localStorage.getItem(LAST_SYNC)); return t > 0 && t <= Date.now() + 864e5 ? t : 0; }catch(e){ return 0; } };     // a time saved while the clock was ahead counts as never: it must not hide later changes

/* `ui`: {say(text), stopped(), signal, decide(items) -> Promise<Map "kind:id" -> 'delete' | 'keep'>}.
   Resolves to the report; rejects with Stopped or Failed (both carry the report). */
export async function runSync(ui = {}){
  const say = ui.say || (() => {}), stopped = ui.stopped || (() => false), signal = ui.signal, decide = ui.decide || (async () => new Map());
  const rep = blankReport();
  const check = () => { if(stopped()) throw new Stopped(rep); };
  /* Everything this run shares between its steps (js/syncplan.js, js/syncapply.js and js/syncmarks.js are handed it): one object per
     run, so two runs never share state. layout, lib, local and startedAt are set as the run goes; the counters are refusals in a row
     (of PDFs, down and up, of record files, and of pages of marks, counted apart), the bytes read this run (PDFs; record files and
     pages of marks) and the pages of marks read. inkGot: the pages of marks read (or refused) this run, by key and `c`; sent: song id
     -> 'live' | 'deleted' for the song records this run sent; pdfOn: song id -> the hash of its chart this run put (or found) on Drive;
     arrived: the ids of the songs this run's downloads wrote as NEW songs (the only ones keepOldChart may take for an old chart's copy);
     downNow: the songs written from Drive by the last round of downloads; full: Drive said it is full when something was sent (from then
     on nothing more is sent; what only comes down still does, records and marks; the run then ends with it). */
  const ctx = {rep, say, check, signal, synced:lastSync(), limit:LIMIT, cap:CAP,
    layout:null, lib:null, local:null, startedAt:0, spent:0, recBytes:0, refusals:0, recRefusals:0, askKeys:new Set(),
    inkPages:0, inkRefusals:0, inkGot:new Map(), sent:new Map(), pdfOn:new Map(), songsNow:null, arrived:new Set(), downNow:new Set(), full:null,
    /* Skips of the work itself are keyed by record: a song refused once and then stored by the second pass is no longer skipped. */
    execSkips:new Map(), limitedIds:new Set(), keptIds:new Set(), repaired:new Set(), wrote:new Set()};
  ctx.skip = (kind, rec, why) => ctx.execSkips.set(kind + ':' + (rec && rec.id), {kind, name:nameOf(kind, rec), why});
  ctx.unskip = (kind, id) => { ctx.execSkips.delete(kind + ':' + id); ctx.limitedIds.delete(kind + ':' + id); };
  const {execSkips, limitedIds, keptIds, repaired, wrote} = ctx;

  try{
    say('Looking at your Google Drive…');
    ctx.layout = await ensureLayout({signal});
    const s1 = await survey(ctx, new Set());
    const answers = s1.asks.length ? (check(), await decide(s1.asks)) : new Map();
    const given = i => answers.get(i.kind + ':' + i.id) === 'delete' || answers.get(i.kind + ':' + i.id) === 'keep';
    rep.unapplied = s1.asks.filter(given).length;      // answers given and not applied yet: if the sync stops before they are, the report says so
    /* 1. everything newer on Drive comes down first, so this tablet is up to date BEFORE a deletion answer is applied (a deletion
          edits setlists and collections: done on an old copy it would date an old setlist as new and beat the other tablet's). */
    ctx.askKeys = new Set(s1.asks.map(i => i.kind + ':' + i.id));
    await runDowns(ctx, s1.work);
    const notBrought = downs(ctx, s1.work).map(a => a.kind + ':' + a.id).filter(k => !wrote.has(k));        // wanted from Drive, not written (refused, too big, over the budget, changed meanwhile)
    /* 2. the person's answers, on current data */
    const undecided = new Set(), order = {set:0, song:1, coll:2};
    const key = i => i.kind + ':' + i.id;
    /* records a deletion's cascade must NOT edit: questions left unanswered, records whose question could not be read, and records
       that should have come down from Drive and did not (this tablet's copy is stale: dating it new would send it over the other tablet's newer one) */
    const open = new Set([...s1.asks.filter(i => answers.get(key(i)) !== 'delete' && answers.get(key(i)) !== 'keep').map(key), ...s1.holdOff, ...notBrought]);
    for(const item of [...s1.asks].sort((x, y) => order[x.kind] - order[y.kind])){          // a setlist before the song it holds, a song before its collection: a deletion edits what points at it
      check();
      const how = answers.get(item.kind + ':' + item.id);
      if(how === 'delete'){ await deleteHere(ctx, item, open); rep.unapplied--; }
      else if(how === 'keep'){ await keep(ctx, item); keptIds.add(item.kind + ':' + item.id); rep.unapplied--; }
      else { undecided.add(item.kind + ':' + item.id); rep.later++; }
    }
    rep.unapplied = 0;
    /* 3. look again: what is newer here (and what an answer changed) goes up */
    const s2 = await survey(ctx, undecided);
    await runUps(ctx, s2.work); ctx.downNow = new Set(); await runDowns(ctx, s2.work);
    await repairPdfs(ctx, s2);
    await syncMarks(ctx, s2);         // the pages of marks, on current data and the last listing (a song that came down brought its own)
    await sweepPdfs(ctx); await sweepMarks(ctx);
    rep.both = s1.both;
    const skipped = new Map([...s2.skips, ...execSkips]);
    rep.skipped = [...skipped.values()];
    rep.limited = limitedIds.size; rep.repaired = repaired.size;
    rep.survived = s2.survived.filter(x => !keptIds.has(x.key));
    if(ctx.full) throw ctx.full;      // Drive is full: everything that needed no space is done (the report says what); said as always ("Your Google Drive is full...")
    /* "Synced up to here": when the last survey of this tablet began (an edit made after that, in this or another tab, is a change
       since the last sync), or the newest record that came down if that is dated later (a tablet with a clock ahead must not make
       the sync reminder show right after a sync). */
    /* "Synced up to here": when the last survey of this tablet began. A change made after that, in this or another tab, is a change since
       the last sync (js/nudge.js); a record dated ahead is bounded there (store.js), so it cannot hide real changes. */
    try{ localStorage.setItem(LAST_SYNC, String(ctx.startedAt)); }catch(e){}
    return rep;
  }catch(e){
    if(e instanceof Stopped || e instanceof Failed) throw e;
    if(e && e.name === 'AbortError') throw new Stopped(rep);
    throw new Failed(e, rep);
  }
}

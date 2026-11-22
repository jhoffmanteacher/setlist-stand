/* Sync plan: the reading and deciding half of one sync run (js/sync.js runs it). It lists both sides (one listing of each Drive
   folder, this tablet's records), asks js/syncmerge.js what to do, settles ties, reads and checks Drive's record files
   (fetchRecord) and says which deletions made elsewhere must be asked about. It writes nothing on this tablet or in Drive; doing
   is js/syncapply.js. Everything a run shares (the report, the listings, the counters) is in the run's `ctx` (see js/sync.js). */
import {all, upgradeSong, upgradeSet, MAX_U} from './store.js';
import {KINDS, canon, digest, indexOf, plan, breakTie} from './syncmerge.js';
import {songProblem, setProblem, collProblem} from './backup.js';
import {MAX_READ} from './syncink.js';
import {listLibrary, downloadJson, TooBig} from './driveops.js';
import {DriveError} from './drive.js';

const PROBLEM = {coll:collProblem, song:songProblem, set:setProblem};
const NAME = {coll:r => r.name, song:r => r.title || r.song, set:r => r.name};
export const nameOf = (kind, rec) => String((rec && NAME[kind](rec)) || (rec && rec.id) || '').slice(0, 120);
/* Drive's record made the way this app keeps its own: the same upgrade load() applies (a derived title, `colls` cleaned, `archived`
   a boolean, setlist rows tidied). Nothing else is changed: a record is kept WHOLE, every field, so both tablets hold the same
   record (a damaged crop is not cleaned here: cropOf() in store.js ignores a damaged rectangle). The listing's hash is of what Drive
   holds; THIS is what is compared with this tablet's record and what is written, so an upgrade that load() does later changes
   nothing (otherwise the same `updated` with other content would look like a new tie at every sync). */
export function normalize(kind, rec){
  const r = structuredClone(rec);
  if(kind === 'song') upgradeSong(r); else if(kind === 'set') upgradeSet(r);
  return r;
}
/* An error about ONE file (Google would not give or take it) skips that file; an error about the whole run (the sign-in, the
   network, a busy Google, a full Drive, the API switched off) ends it. Five refusals in a row mean it is not about one file. */
export const perFile = err => err instanceof DriveError && (err.kind === 'other' || err.kind === 'big' || err.kind === 'denied');
export const refusedText = err => `Google would not give or take it${err.status ? ' (' + err.status + (err.reason ? ' ' + err.reason : '') + ')' : ''}`;

/* This tablet's records, live ones and deletion markers, by kind and id, and the index syncmerge compares. A record whose
   `updated` is not a date (a restore of something odd) is left out and listed: one such record must not stop every sync. */
async function readLocal(){
  const rec = {coll:await all('colls'), song:await all('songs'), set:await all('sets')}, byId = {}, index = {}, bad = [];
  for(const k of KINDS){
    byId[k] = new Map();
    for(const r of rec[k]){
      if(!r || typeof r.id !== 'string') continue;
      if(typeof r.updated !== 'number' || !(r.updated >= 0 && r.updated <= MAX_U)){ bad.push({kind:k, rec:r}); continue; }
      byId[k].set(r.id, r);
    }
    index[k] = new Map();
    for(const [id, r] of [...byId[k]]){          // one at a time: a record canon() refuses is left out and listed, it must not stop every sync
      try{ for(const [i, e] of await indexOf([r])) index[k].set(i, e); }
      catch(err){ byId[k].delete(id); bad.push({kind:k, rec:r}); }
    }
  }
  return {byId, index, bad};
}
const remoteIndex = lib => Object.fromEntries(KINDS.map(k => [k, new Map([...lib.records[k]].map(([id, e]) => [id, {u:e.u, c:e.c, d:e.d}]))]));

/* The state of both sides now, and what to do about it: {work: [{op:'up'|'down', kind, id, rec?}], asks: [{kind, id, name, marker, here}]}.
   It sets ctx.startedAt, ctx.lib and ctx.local (what the apply half then works from). */
export async function survey(ctx, deferred){
  const {rep, check, signal, synced} = ctx, CAP = ctx.cap;
  check(); ctx.startedAt = Date.now(); const lib = ctx.lib = await listLibrary(ctx.layout, {signal}); const local = ctx.local = await readLocal();
  const startedAt = ctx.startedAt;
  const p = plan(local.index, remoteIndex(lib), {now:Date.now()});
  rep.future = p.future; rep.strays = lib.strays;
  for(const k of KINDS) if(lib.records[k].size > CAP[k]){
    throw Object.assign(new Error('too many records'), {plain:`Your Google Drive folder holds far more ${k === 'coll' ? 'collections' : k === 'set' ? 'setlists' : 'songs'} than this app made (${lib.records[k].size}). Nothing was changed. Look at the "Library data" folder in your Drive.`});
  }
  if(lib.ink.size > CAP.ink) throw Object.assign(new Error('too many pages of marks'), {plain:`Your Google Drive folder holds far more pages of marks than this app made (${lib.ink.size}). Nothing was changed. Look at the "Marks" folder in your Drive.`});
  const work = [], asks = [], both = [], survived = [], skips = new Map(), holdOff = new Set();
  const sskip = (kind, rec, why) => skips.set(kind + ':' + (rec && rec.id), {kind, name:nameOf(kind, rec), why});
  for(const b of local.bad) sskip(b.kind, b.rec, 'it could not be read here (its time is not a date, or it is damaged), so it is not synced');
  const ask = (kind, id, marker) => { if(!deferred.has(kind + ':' + id)) asks.push({kind, id, name:nameOf(kind, local.byId[kind].get(id)), marker, here:local.byId[kind].get(id)}); };
  for(const a of p.actions){
    check();
    const here = local.byId[a.kind].get(a.id), li = local.index[a.kind].get(a.id), ri = lib.records[a.kind].get(a.id);
    if(a.op === 'up' || a.op === 'down'){
      /* both sides live, different content: one of them is thrown away; say so when that version was edited since this tablet last synced
         (a time more than a day ahead says nothing about when it was edited, so such a version is never reported as a conflict) */
      if(li && ri && !li.d && !ri.d && li.c !== ri.c && synced){
        const loser = a.op === 'up' ? ri.u : li.u;
        if(loser > synced && loser <= startedAt + 864e5) both.push({kind:a.kind, name:nameOf(a.kind, here), kept:a.op === 'up' ? 'here' : 'there'});
      }
      /* changed here after it was deleted on the other tablet: it stays, and the report says so */
      if(a.op === 'up' && li && ri && !li.d && ri.d && li.u > ri.u) survived.push({kind:a.kind, name:nameOf(a.kind, here), key:a.kind + ':' + a.id});
      work.push({op:a.op, kind:a.kind, id:a.id});
    }else if(a.op === 'askDelete'){
      const r = await fetchRecord(ctx, a.kind, a.id);
      if(r.skip){ sskip(a.kind, here, r.skip); holdOff.add(a.kind + ':' + a.id); }
      else if(r.rec.deleted !== true) sskip(a.kind, here, 'its file in Drive was changed outside the app');
      else ask(a.kind, a.id, r.rec);
    }else if(a.op === 'tie'){
      const r = await fetchRecord(ctx, a.kind, a.id);
      if(r.skip){ sskip(a.kind, here, r.skip); continue; }
      if(!r.rec.deleted && !here.deleted && canon(normalize(a.kind, r.rec)) === canon(here)) continue;     // only an upgrade apart: the same record
      const win = breakTie(here, r.rec);          // the same `updated` and other content that is not just an upgrade: two real edits made at the same time
      if(!r.rec.deleted && !here.deleted) both.push({kind:a.kind, name:nameOf(a.kind, here), kept:win === 'local' ? 'here' : 'there'});
      if(win === 'local') work.push({op:'up', kind:a.kind, id:a.id});
      else if(r.rec.deleted && !here.deleted) ask(a.kind, a.id, r.rec);          // a deletion is never done without the tap, even one that won a tie
      else work.push({op:'down', kind:a.kind, id:a.id, rec:r.rec});
    }
  }
  return {work, asks, both, skips, survived, local, lib, holdOff};
}

/* Drive's record, read and checked: {rec} or {skip: why}. Checked like a restore: id, lengths, counts; its own id and
   `updated` agree with the properties that were listed, and its canonical hash is the listed one (a file changed by hand,
   or half written, is not trusted). Counts what it reads (ctx.recBytes) and Google's refusals in a row (ctx.recRefusals). */
export async function fetchRecord(ctx, kind, id){
  const {signal} = ctx, LIMIT = ctx.limit;
  const e = ctx.lib.records[kind].get(id);
  if(ctx.recBytes > LIMIT.records) return {skip:'this sync has already read as much as it will; sync again for the rest'};
  if(e.u > MAX_READ) return {skip:'its file in Drive is dated too far in the future (a tablet\'s clock or the file is wrong), so it is not taken'};       // (later than MAX_U is not listed at all: not ours)
  let rec;
  try{ rec = await downloadJson(e.fileId, {signal, maxBytes:LIMIT.record}); }
  catch(err){
    if(err instanceof TooBig) return {skip:'its file in Drive is too big'};
    if(err instanceof DriveError && err.status === 404) return {skip:'its file is no longer in Drive'};
    if(perFile(err)){ if(++ctx.recRefusals >= 5) throw err; return {skip:refusedText(err)}; }
    throw err;
  }
  ctx.recRefusals = 0;
  if(rec.id !== id) return {skip:'its file in Drive belongs to another record'};
  if(typeof rec.updated !== 'number' || !Number.isFinite(rec.updated) || rec.updated !== e.u) return {skip:'its file in Drive was changed outside the app'};
  if((rec.deleted === true) !== e.d) return {skip:'its file in Drive was changed outside the app'};
  const prob = PROBLEM[kind](rec);
  if(prob) return {skip:'its file in Drive is not valid (' + prob + ')'};
  let c;
  try{ c = await digest(canon(rec)); ctx.recBytes += JSON.stringify(rec).length; }catch(err){ return {skip:'its file in Drive could not be read'}; }       // (a record nested too deep for the browser is skipped, never fatal)
  if(c !== e.c) return {skip:'its file in Drive was changed outside the app'};
  return {rec};
}

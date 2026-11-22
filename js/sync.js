/* One sync run: songs, setlists, collections and the PDFs, between this tablet and the person's Google Drive (Part 2).
   Only ever started by a tap (Sync). Marks (ink) are not synced yet. No screen code here: the box, the deletion list and the
   report are js/syncui.js and js/syncdialogs.js; this file is handed `say`, `stopped`, `signal` and `decide`.

   What decides is js/syncmerge.js (pure; by id and `updated` only: never by title or PDF hash, because Copy song makes two songs
   with one PDF). What talks to Drive is js/driveops.js. This file carries the decisions out, in this order:
     1. one listing of each Drive folder, this tablet's records, the plan;
     2. a record with the same `updated` as Drive's but other content (a tie): Drive's is read and the same rule on both tablets
        picks one, so they stop swapping;
     3. deletions made on the other tablet are LISTED and nothing is deleted until the person taps Delete here or Keep;
     4. upload what is newer here (a song's PDF first, so a reader never meets a record without its file), then download what
        is newer there, one song at a time: the PDF must start with %PDF- and its SHA-256 must equal the record's `hash`, and it
        is written WITH its record in ONE putAll, and only if the local record still has the `updated` that was read (ifUpdated);
     5. the report.
   Every unit is safe to repeat. A run that is stopped, loses the network or the sign-in, or is cut off by a reload leaves the
   library whole and the next run finishes the job. Nothing on this tablet is deleted because something is missing from Drive.
   Everything from Drive is untrusted: ids, lengths and counts are checked like a restore (songProblem and the other two from
   backup.js), and a bad record or PDF is skipped and listed by name, never written; one bad song never stops the others. */
import {all, get, putAll, update, stamp, upgradeSong, upgradeSet, newSong, upgradeInk, inkRecord, reconcile} from './store.js';
import {unique} from './shareimport.js';
import {KINDS, canon, digest, indexOf, plan, breakTie} from './syncmerge.js';
import {songProblem, setProblem, collProblem} from './backup.js';
import {ensureLayout, listLibrary, downloadJson, downloadBlob, putFile, patchFile, deleteFile, recordFileName, pdfFileName, recordProps, pdfProps, TooBig} from './driveops.js';
import {DriveError} from './drive.js';
import {deleteOps} from './deleteops.js';

export const LAST_SYNC = 'ss-last-sync';            // localStorage: when this tablet last finished a sync (ms). Per tablet: never synced, backed up or shared.
export const LIMIT = {pdf:100e6, run:500e6, record:1e6, records:50e6};     // bytes: one PDF, all the PDFs downloaded in one run, one record file, all the record files of one run (his library is 43 MB in 74 PDFs, the largest 2.3 MB)
const CAP = {song:20000, set:5000, coll:2000};      // more records of a kind than this in Drive is not this app's library: the run is refused (a restore has its own, larger LIMITS)
const STORE = {coll:'colls', song:'songs', set:'sets'};
const PROBLEM = {coll:collProblem, song:songProblem, set:setProblem};
const NAME = {coll:r => r.name, song:r => r.title || r.song, set:r => r.name};
const HEX64 = /^[0-9a-f]{64}$/;

/* The person pressed Stop (or Cancel took the request in flight with it). `report` is what was done before. */
export class Stopped extends Error { constructor(report){ super('stopped'); this.name = 'Stopped'; this.report = report; } }
/* Drive, the network or this tablet's storage failed part-way; `cause` is the error, `report` what was done before. */
export class Failed extends Error { constructor(cause, report){ super(cause && cause.message || 'failed'); this.name = 'Failed'; this.cause = cause; this.report = report; } }

export const blankReport = () => ({sent:{coll:0, song:0, set:0}, got:{coll:0, song:0, set:0}, both:[], skipped:[], future:[], kept:0, removed:0, later:0, limited:0, strays:0, changedMeanwhile:0, archived:0, repaired:0, survived:[], unapplied:0});
export const lastSync = () => { try{ const t = Number(localStorage.getItem(LAST_SYNC)); return t > 0 && t <= Date.now() + 864e5 ? t : 0; }catch(e){ return 0; } };     // a time saved while the clock was ahead counts as never: it must not hide later changes
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async blob => hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
const nameOf = (kind, rec) => String((rec && NAME[kind](rec)) || (rec && rec.id) || '').slice(0, 120);
/* Drive's record made the way this app keeps its own: the same upgrade load() applies (a derived title, `colls` cleaned, `archived`
   a boolean, setlist rows tidied). Nothing else is changed: a record is kept WHOLE, every field, so both tablets hold the same
   record (a damaged crop is not cleaned here: cropOf() in store.js ignores a damaged rectangle). The listing's hash is of what Drive
   holds; THIS is what is compared with this tablet's record and what is written, so an upgrade that load() does later changes
   nothing (otherwise the same `updated` with other content would look like a new tie at every sync). */
function normalize(kind, rec){
  const r = structuredClone(rec);
  if(kind === 'song') upgradeSong(r); else if(kind === 'set') upgradeSet(r);
  return r;
}
/* An error about ONE file (Google would not give or take it) skips that file; an error about the whole run (the sign-in, the
   network, a busy Google, a full Drive, the API switched off) ends it. Five refusals in a row mean it is not about one file. */
const perFile = err => err instanceof DriveError && (err.kind === 'other' || err.kind === 'big' || err.kind === 'denied');
const replacedVersion = v => {
  const d = new Date(), tag = `replaced ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const keep = String(v || '').slice(0, 200 - tag.length - 2).trim();
  return keep ? keep + ', ' + tag : tag;
};
const refusedText = err => `Google would not give or take it${err.status ? ' (' + err.status + (err.reason ? ' ' + err.reason : '') + ')' : ''}`;

/* This tablet's records, live ones and deletion markers, by kind and id, and the index syncmerge compares. A record whose
   `updated` is not a date (a restore of something odd) is left out and listed: one such record must not stop every sync. */
const MAX_U = 8.64e15 - 1e6;                  // as in js/driveops.js
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

/* `ui`: {say(text), stopped(), signal, decide(items) -> Promise<Map "kind:id" -> 'delete' | 'keep'>}.
   Resolves to the report; rejects with Stopped or Failed (both carry the report). */
export async function runSync(ui = {}){
  const say = ui.say || (() => {}), stopped = ui.stopped || (() => false), signal = ui.signal, decide = ui.decide || (async () => new Map());
  const rep = blankReport();
  const check = () => { if(stopped()) throw new Stopped(rep); };
  /* Skips of the work itself are keyed by record: a song refused once and then stored by the second pass is no longer skipped. */
  const execSkips = new Map(), limitedIds = new Set(), keptIds = new Set(), repaired = new Set(), wrote = new Set();
  const skip = (kind, rec, why) => execSkips.set(kind + ':' + (rec && rec.id), {kind, name:nameOf(kind, rec), why});
  const unskip = (kind, id) => { execSkips.delete(kind + ':' + id); limitedIds.delete(kind + ':' + id); };
  const synced = lastSync();
  let layout, lib, local, spent = 0, recBytes = 0, startedAt = 0, refusals = 0, recRefusals = 0, askKeys = new Set();     // refusals in a row: of PDFs (down and up) and of record files, counted apart

  /* The state of both sides now, and what to do about it: {work: [{op:'up'|'down', kind, id, rec?}], asks: [{kind, id, name, marker, here}]}. */
  async function survey(deferred){
    check(); startedAt = Date.now(); lib = await listLibrary(layout, {signal}); local = await readLocal();
    const p = plan(local.index, remoteIndex(lib), {now:Date.now()});
    rep.future = p.future; rep.strays = lib.strays;
    for(const k of KINDS) if(lib.records[k].size > CAP[k]){
      throw Object.assign(new Error('too many records'), {plain:`Your Google Drive folder holds far more ${k === 'coll' ? 'collections' : k === 'set' ? 'setlists' : 'songs'} than this app made (${lib.records[k].size}). Nothing was changed. Look at the "Library data" folder in your Drive.`});
    }
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
        const r = await fetchRecord(a.kind, a.id);
        if(r.skip){ sskip(a.kind, here, r.skip); holdOff.add(a.kind + ':' + a.id); }
        else if(r.rec.deleted !== true) sskip(a.kind, here, 'its file in Drive was changed outside the app');
        else ask(a.kind, a.id, r.rec);
      }else if(a.op === 'tie'){
        const r = await fetchRecord(a.kind, a.id);
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
     or half written, is not trusted). */
  async function fetchRecord(kind, id){
    const e = lib.records[kind].get(id);
    if(recBytes > LIMIT.records) return {skip:'this sync has already read as much as it will; sync again for the rest'};
    let rec;
    try{ rec = await downloadJson(e.fileId, {signal, maxBytes:LIMIT.record}); }
    catch(err){
      if(err instanceof TooBig) return {skip:'its file in Drive is too big'};
      if(err instanceof DriveError && err.status === 404) return {skip:'its file is no longer in Drive'};
      if(perFile(err)){ if(++recRefusals >= 5) throw err; return {skip:refusedText(err)}; }
      throw err;
    }
    recRefusals = 0;
    if(rec.id !== id) return {skip:'its file in Drive belongs to another record'};
    if(typeof rec.updated !== 'number' || !Number.isFinite(rec.updated) || rec.updated !== e.u) return {skip:'its file in Drive was changed outside the app'};
    if((rec.deleted === true) !== e.d) return {skip:'its file in Drive was changed outside the app'};
    const prob = PROBLEM[kind](rec);
    if(prob) return {skip:'its file in Drive is not valid (' + prob + ')'};
    let c;
    try{ c = await digest(canon(rec)); recBytes += JSON.stringify(rec).length; }catch(err){ return {skip:'its file in Drive could not be read'}; }       // (a record nested too deep for the browser is skipped, never fatal)
    if(c !== e.c) return {skip:'its file in Drive was changed outside the app'};
    return {rec};
  }

  /* ---------- up: this tablet's version goes to Drive ---------- */
  /* A song's PDF is on Drive before the record that names it. false: the song is skipped. */
  async function sendPdf(rec){
    const h = String(rec.hash || '').toLowerCase(), rp = lib.pdfs.get(rec.id), want = pdfFileName(rec.title);
    if(!HEX64.test(h)){ skip('song', rec, 'its PDF has no checksum on this tablet'); return false; }
    if(rp && rp.h === h){ if(rp.name !== want) await patchFile(rp.fileId, {name:want}, {signal}); return true; }
    const blob = await get('files', rec.id);
    if(!blob){ skip('song', rec, 'its PDF is missing on this tablet'); return false; }
    if(await sha256(blob) !== h){ skip('song', rec, 'its PDF on this tablet does not match its details'); return false; }
    await putFile({fileId:rp && rp.fileId, parent:layout.charts, name:want, mime:'application/pdf', appProperties:pdfProps(rec.id, h), bytes:blob}, {signal});
    return true;
  }
  async function upload(a){
    const rec = local.byId[a.kind].get(a.id), li = local.index[a.kind].get(a.id), have = lib.records[a.kind].get(a.id);
    try{
      if(a.kind === 'song' && !rec.deleted && !(await sendPdf(rec))) return;
      const props = recordProps(a.kind, rec, li.u, li.c);
      if(have && !rec.deleted) props.d = null;      // Drive MERGES properties on an update: without this a kept record would stay flagged as a deletion marker
      await putFile({fileId:have && have.fileId, parent:layout.data, name:recordFileName(a.kind, a.id), mime:'application/json',
        appProperties:props, bytes:JSON.stringify(rec)}, {signal});
      if(a.kind === 'song' && rec.deleted){ const pf = lib.pdfs.get(a.id); if(pf) await deleteFile(pf.fileId, {signal}); }     // the marker is up first; its PDF goes after
      rep.sent[a.kind]++; refusals = 0; unskip(a.kind, a.id);
    }catch(err){
      if(err instanceof DriveError && err.status === 404){ skip(a.kind, rec, 'a file in Drive was removed while syncing: it is sent again next time'); return; }
      if(perFile(err)){ if(++refusals >= 5) throw err; skip(a.kind, rec, refusedText(err)); return; }
      throw err;
    }
  }

  /* ---------- down: Drive's version is written here ---------- */
  /* A download is about to put a DIFFERENT chart in place of the one this tablet has for a song (it got a new PDF on the other
     tablet while this one changed the song too: the newer record wins whole, and its chart with it). The chart that would be
     lost, and its marks, are kept as an archived copy in the same write, the way New version keeps them, so a sync never loses a
     chart. Not when this tablet already holds those very bytes under another song (the other tablet's own archived copy, which
     comes down first): then nothing is lost and nothing is doubled. */
  async function keepOldChart(here, rec, ops){
    const stored = await get('files', here.id);
    if(!stored) return false;
    /* COPY the bytes: in Safari a Blob read back from the files store still points at the stored data, which this download is about to
       replace, so storing the same Blob under the copy's id would leave the copy with no PDF at all (the old chart lost). */
    const bytes = await stored.arrayBuffer(), old = new Blob([bytes], {type:'application/pdf'});
    const oldHash = hex(await crypto.subtle.digest('SHA-256', bytes)), songs = await all('songs');
    if(oldHash === String(rec.hash).toLowerCase()) return false;                     // the same bytes: nothing is being replaced
    /* a song that already holds the old bytes takes the old marks only if it is an ARCHIVED copy (never a Copy song in use) and nothing is asking about it */
    const holder = songs.find(x => x && !x.deleted && x.archived === true && x.id !== here.id && !askKeys.has('song:' + x.id) && String(x.hash || '').toLowerCase() === oldHash);
    /* this tablet's marks on the old chart: they do not belong on the new one, whoever holds the old chart afterwards */
    const pages = [];
    for(let p = 1; p <= here.pages; p++){
      const key = here.id + ':' + p, cur = upgradeInk(await get('ink', key)).record.strokes;
      pages.push({p, key, cur, marks:cur.filter(x => !x.deleted)});
    }
    let target = holder || null;                    // where the old marks go: a song that already holds the old chart (the other tablet's archived copy)...
    if(target) for(const pg of pages){              // ...unless it has marks of its own on a page where these marks are, then a copy keeps them apart
      if(!pg.marks.length) continue;
      const has = upgradeInk(await get('ink', target.id + ':' + pg.p)).record.strokes.some(x => !x.deleted);
      if(has){ target = null; break; }
    }
    let made = false;
    if(!target){
      const copy = newSong({song:here.song, artist:here.artist, version:replacedVersion(here.version)}, here.pages, oldHash, here.colls || []);
      copy.id = unique(new Set([...songs.map(x => x.id), ...(await all('sets')).map(x => x.id)]));
      copy.archived = true;
      if(here.crop !== undefined) copy.crop = structuredClone(here.crop);
      ops.push({store:'files', key:copy.id, value:old}, {store:'songs', key:copy.id, value:copy});
      target = copy; made = true;
    }
    for(const pg of pages){
      if(pg.marks.length) ops.push({store:'ink', key:target.id + ':' + pg.p, value:inkRecord(pg.marks)});        // the old chart keeps its marks
      if(pg.p > rec.pages) ops.push({store:'ink', key:pg.key, delete:true});                                       // that page no longer exists
      else if(pg.cur.length) ops.push({store:'ink', key:pg.key, value:inkRecord(reconcile(pg.cur, []))});          // the new chart starts with fresh marks
    }
    return made;
  }
  async function download(a){
    const here = local.byId[a.kind].get(a.id) || null, ifUpdated = here && here.updated != null ? here.updated : null;
    const r = a.rec ? {rec:a.rec} : await fetchRecord(a.kind, a.id);
    if(r.skip){ skip(a.kind, here || {id:a.id}, r.skip); return; }
    const rec = normalize(a.kind, r.rec), ops = [];
    let archivedCopy = false;
    /* A deletion marker is only ever written over nothing or another marker here: over a live record it is a deletion, which is
       asked about first (askDelete), never a plain download. */
    if(rec.deleted){
      if(here && !here.deleted){ skip(a.kind, here, 'a deletion that was not confirmed yet'); return; }
    }else if(a.kind === 'song'){
      const h = String(rec.hash || '').toLowerCase();
      if(!HEX64.test(h)){ skip('song', rec, 'its details have no checksum'); return; }
      const sameFile = here && !here.deleted && String(here.hash || '').toLowerCase() === h && await get('files', a.id);
      if(!sameFile){
        const pf = lib.pdfs.get(a.id);
        if(!pf){ skip('song', rec, 'its PDF is not in Drive (yet)'); return; }
        if(pf.h !== h){ skip('song', rec, 'its PDF in Drive is not the one its details name'); return; }
        if(pf.size > LIMIT.pdf){ skip('song', rec, 'its PDF is too big'); return; }
        if(spent + pf.size > LIMIT.run){ limitedIds.add('song:' + a.id); return; }
        let blob;
        try{ blob = await downloadBlob(pf.fileId, {signal, maxBytes:LIMIT.pdf}); }
        catch(err){
          if(err instanceof TooBig){ skip('song', rec, 'its PDF is too big'); return; }
          if(err instanceof DriveError && err.status === 404){ skip('song', rec, 'its PDF is no longer in Drive'); return; }
          if(perFile(err)){ if(++refusals >= 5) throw err; skip('song', rec, refusedText(err)); return; }
          throw err;
        }
        spent += blob.size; refusals = 0;
        if(await blob.slice(0, 5).text() !== '%PDF-'){ skip('song', rec, 'its PDF in Drive is not a PDF'); return; }
        if(await sha256(blob) !== h){ skip('song', rec, 'its PDF in Drive does not match its details'); return; }
        if(here && !here.deleted) archivedCopy = await keepOldChart(here, rec, ops);       // this tablet's different chart is kept as an archived copy
        ops.push({store:'files', key:a.id, value:blob});
      }
    }
    ops.push({store:STORE[a.kind], key:a.id, value:rec, ifUpdated});
    try{ await putAll(ops, archivedCopy ? undefined : {fromSync:true}); wrote.add(a.kind + ':' + a.id); rep.got[a.kind]++; if(archivedCopy) rep.archived++; unskip(a.kind, a.id); }
    catch(err){ if(err && err.name === 'StaleWrite'){ rep.changedMeanwhile++; return; } throw err; }       // edited in another tab meanwhile: the next sync decides again
  }

  /* ---------- the person's answers about deletions made elsewhere ---------- */
  /* Delete here: what the Delete button does (PDF and marks removed, setlists that held the song edited), in ONE transaction. */
  async function deleteHere(item, leave){
    if(!item.marker || item.marker.deleted !== true) return;       // only ever a real deletion marker
    try{ await putAll(await deleteOps(item.kind, item.id, {marker:item.marker, ifUpdated:item.here.updated, leave})); rep.removed++; }
    catch(err){ if(err && err.name === 'StaleWrite'){ rep.changedMeanwhile++; return; } throw err; }
  }
  /* Keep: this tablet's record is stamped newer than the marker, so it wins at the next plan and goes back up. */
  async function keep(item){
    const done = await update(STORE[item.kind], item.id, cur => cur && !cur.deleted && cur.updated === item.here.updated ? {...cur, updated:stamp(item.marker)} : undefined);
    if(done) rep.kept++; else rep.changedMeanwhile++;
  }

  const ups = w => KINDS.flatMap(k => w.filter(x => x.op === 'up' && x.kind === k));
  /* New songs before songs this tablet already has (so another tablet's archived copy of an old chart is here before the
     replacement of that chart is considered), setlists last. */
  const rank = a => a.kind === 'coll' ? 0 : a.kind === 'song' ? (local.byId.song.get(a.id) ? 2 : 1) : 3;
  const downs = w => w.filter(x => x.op === 'down').sort((x, y) => rank(x) - rank(y) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const runUps = async w => { const l = ups(w); for(const [i, a] of l.entries()){ check(); say(`Sending ${i + 1} of ${l.length}…`); await upload(a); } };
  const runDowns = async w => { const l = downs(w); for(const [i, a] of l.entries()){ check(); say(`Getting ${i + 1} of ${l.length}…`); await download(a); } };
  /* A song whose record Drive and this tablet agree on, but whose PDF is missing in Drive (somebody removed it) or is not the one
     the record names: this tablet puts its own PDF back (sendPdf checks it against the record's hash first). Without this the
     record stays "the same" for ever and a tablet that does not have the song could never get it. */
  async function repairPdfs(sv){
    for(const [id, rec] of sv.local.byId.song){
      if(rec.deleted) continue;
      const re = sv.lib.records.song.get(id), li = sv.local.index.song.get(id), h = String(rec.hash || '').toLowerCase();
      if(!re || re.d || !li || re.c !== li.c || !HEX64.test(h)) continue;
      const pf = sv.lib.pdfs.get(id);
      if(pf && pf.h === h) continue;
      check();
      try{ if(await sendPdf(rec)) repaired.add(id); }
      catch(err){ if(err instanceof DriveError && err.status === 404) continue; if(perFile(err)){ if(++refusals >= 5) throw err; skip('song', rec, refusedText(err)); continue; } throw err; }
    }
  }
  /* A song whose deletion is already on Drive and which this tablet has deleted (or never had) must not leave its PDF behind (a
     run cut off between the marker and the PDF would otherwise leave it for ever). Idempotent. */
  async function sweepPdfs(){
    for(const [id, e] of lib.records.song){
      const pf = lib.pdfs.get(id), l = local.byId.song.get(id);
      if(!e.d || !pf || (l && !l.deleted)) continue;
      check();
      try{ await deleteFile(pf.fileId, {signal}); }catch(err){ if(!perFile(err)) throw err; }
    }
  }

  try{
    say('Looking at your Google Drive…');
    layout = await ensureLayout({signal});
    const s1 = await survey(new Set());
    const answers = s1.asks.length ? (check(), await decide(s1.asks)) : new Map();
    const given = i => answers.get(i.kind + ':' + i.id) === 'delete' || answers.get(i.kind + ':' + i.id) === 'keep';
    rep.unapplied = s1.asks.filter(given).length;      // answers given and not applied yet: if the sync stops before they are, the report says so
    /* 1. everything newer on Drive comes down first, so this tablet is up to date BEFORE a deletion answer is applied (a deletion
          edits setlists and collections: done on an old copy it would date an old setlist as new and beat the other tablet's). */
    askKeys = new Set(s1.asks.map(i => i.kind + ':' + i.id));
    await runDowns(s1.work);
    const notBrought = downs(s1.work).map(a => a.kind + ':' + a.id).filter(k => !wrote.has(k));        // wanted from Drive, not written (refused, too big, over the budget, changed meanwhile)
    /* 2. the person's answers, on current data */
    const undecided = new Set(), order = {set:0, song:1, coll:2};
    const key = i => i.kind + ':' + i.id;
    /* records a deletion's cascade must NOT edit: questions left unanswered, records whose question could not be read, and records
       that should have come down from Drive and did not (this tablet's copy is stale: dating it new would send it over the other tablet's newer one) */
    const open = new Set([...s1.asks.filter(i => answers.get(key(i)) !== 'delete' && answers.get(key(i)) !== 'keep').map(key), ...s1.holdOff, ...notBrought]);
    for(const item of [...s1.asks].sort((x, y) => order[x.kind] - order[y.kind])){          // a setlist before the song it holds, a song before its collection: a deletion edits what points at it
      check();
      const how = answers.get(item.kind + ':' + item.id);
      if(how === 'delete'){ await deleteHere(item, open); rep.unapplied--; }
      else if(how === 'keep'){ await keep(item); keptIds.add(item.kind + ':' + item.id); rep.unapplied--; }
      else { undecided.add(item.kind + ':' + item.id); rep.later++; }
    }
    rep.unapplied = 0;
    /* 3. look again: what is newer here (and what an answer changed) goes up */
    const s2 = await survey(undecided);
    await runUps(s2.work); await runDowns(s2.work);
    await repairPdfs(s2);
    await sweepPdfs();
    rep.both = s1.both;
    const skipped = new Map([...s2.skips, ...execSkips]);
    rep.skipped = [...skipped.values()];
    rep.limited = limitedIds.size; rep.repaired = repaired.size;
    rep.survived = s2.survived.filter(x => !keptIds.has(x.key));
    /* "Synced up to here": when the last survey of this tablet began (an edit made after that, in this or another tab, is a change
       since the last sync), or the newest record that came down if that is dated later (a tablet with a clock ahead must not make
       the sync reminder show right after a sync). */
    /* "Synced up to here": when the last survey of this tablet began. A change made after that, in this or another tab, is a change since
       the last sync (js/nudge.js); a record dated ahead is bounded there (store.js), so it cannot hide real changes. */
    try{ localStorage.setItem(LAST_SYNC, String(startedAt)); }catch(e){}
    return rep;
  }catch(e){
    if(e instanceof Stopped || e instanceof Failed) throw e;
    if(e && e.name === 'AbortError') throw new Stopped(rep);
    throw new Failed(e, rep);
  }
}

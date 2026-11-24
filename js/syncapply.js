/* Sync apply: the doing half of one sync run (js/sync.js runs it; js/syncplan.js decided what to do). It sends this tablet's
   newer records and PDFs to Drive (upload), writes Drive's newer ones here (download, keeping a chart it would replace as an
   archived copy: keepOldChart), carries out the person's answers about deletions made elsewhere (deleteHere, keep), puts back
   PDFs missing in Drive (repairPdfs) and removes the PDFs of deleted songs from Drive (sweepPdfs). A song that comes down brings its
   pages of marks in the same write (js/syncmarks.js reads and merges them). Everything a run shares (the report, the listings, the
   counters, what was written and sent) is in the run's `ctx` (see js/sync.js). */
import {all, get, putAll, update, stamp, newSong, upgradeInk, inkRecord, reconcile, syncPending} from './store.js';
import {unique} from './shareimport.js';
import {KINDS} from './syncmerge.js';
import {downloadBlob, putFile, patchFile, deleteFile, recordFileName, pdfFileName, recordProps, pdfProps, TooBig} from './driveops.js';
import {DriveError} from './drive.js';
import {deleteOps} from './deleteops.js';
import {fetchRecord, normalize, perFile, refusedText, nameOf} from './syncplan.js';
import {mergePage} from './syncink.js';
import {incomingPages, mergeIncoming} from './syncmarks.js';

const STORE = {coll:'colls', song:'songs', set:'sets'};
const HEX64 = /^[0-9a-f]{64}$/;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async blob => hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
const replacedVersion = v => {
  const d = new Date(), tag = `replaced ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const keep = String(v || '').slice(0, 200 - tag.length - 2).trim();
  return keep ? keep + ', ' + tag : tag;
};

/* ---------- up: this tablet's version goes to Drive ---------- */
/* A song's PDF is on Drive before the record that names it. false: the song is skipped. ctx.pdfOn: the songs whose chart is on Drive now. */
async function sendPdf(ctx, rec){
  const {lib, layout, signal, skip} = ctx;
  const h = String(rec.hash || '').toLowerCase(), rp = lib.pdfs.get(rec.id), want = pdfFileName(rec.title);
  if(!HEX64.test(h)){ skip('song', rec, 'its PDF has no checksum on this tablet'); return false; }
  if(rp && rp.h === h){ if(rp.name !== want) await patchFile(rp.fileId, {name:want}, {signal}); ctx.pdfOn.set(rec.id, h); return true; }
  const blob = await get('files', rec.id);
  if(!blob){ skip('song', rec, 'its PDF is missing on this tablet'); return false; }
  if(await sha256(blob) !== h){ skip('song', rec, 'its PDF on this tablet does not match its details'); return false; }
  await putFile({fileId:rp && rp.fileId, parent:layout.charts, name:want, mime:'application/pdf', appProperties:pdfProps(rec.id, h), bytes:blob}, {signal});
  ctx.pdfOn.set(rec.id, h);
  return true;
}
async function upload(ctx, a){
  const {rep, lib, local, layout, signal, skip, unskip} = ctx;
  if(ctx.full) return;                            // Drive is full: nothing more is sent this run; what comes down still does, and the run ends with "full"
  const rec = local.byId[a.kind].get(a.id), li = local.index[a.kind].get(a.id), have = lib.records[a.kind].get(a.id);
  try{
    if(a.kind === 'song' && !rec.deleted && !(await sendPdf(ctx, rec))) return;
    const props = recordProps(a.kind, rec, li.u, li.c);
    if(have && !rec.deleted) props.d = null;      // Drive MERGES properties on an update: without this a kept record would stay flagged as a deletion marker
    await putFile({fileId:have && have.fileId, parent:layout.data, name:recordFileName(a.kind, a.id), mime:'application/json',
      appProperties:props, bytes:JSON.stringify(rec)}, {signal});
    if(a.kind === 'song' && rec.deleted){ const pf = lib.pdfs.get(a.id); if(pf) await deleteFile(pf.fileId, {signal}); }     // the marker is up first; its PDF goes after
    rep.sent[a.kind]++; ctx.refusals = 0; unskip(a.kind, a.id);
    if(a.kind === 'song') ctx.sent.set(a.id, rec.deleted ? 'deleted' : 'live');       // what Drive holds now for it (the marks follow it)
  }catch(err){
    if(err instanceof DriveError && err.status === 404){ skip(a.kind, rec, 'a file in Drive was removed while syncing: it is sent again next time'); return; }
    if(err instanceof DriveError && err.kind === 'full'){ ctx.full = err; return; }
    if(perFile(err)){ if(++ctx.refusals >= 5) throw err; skip(a.kind, rec, refusedText(err)); return; }
    throw err;
  }
}

/* ---------- down: Drive's version is written here ---------- */
/* A download is about to put a DIFFERENT chart in place of the one this tablet has for a song (it got a new PDF on the other
   tablet while this one changed the song too: the newer record wins whole, and its chart with it). The chart that would be
   lost, and its marks, are kept as an archived copy in the same write, the way New version keeps them, so a sync never loses a
   chart. Not when the other tablet's own archived copy of that chart came down in THIS run (new songs come down first): then nothing
   is lost and nothing is doubled, and this tablet's marks are merged (by stroke id) into that copy's. Only a song this run wrote as
   new can be that copy (ctx.arrived): songs are matched by id, never by hash, so a song that was here before the run (a Copy song's
   archived original, say) never takes the marks just because it holds the same PDF.
   incoming: Drive's pages of the song (js/syncmarks.js), which name the marks the other tablet moved to its archived copy.
   With marks to move, a holder must also show it is THIS song's copy: one of its live marks has an id this song's page has here or on
   Drive (ids are never shared between songs; a Copy song's copy holds the same PDF but other ids). Otherwise a separate copy is made.
   Returns {made: a new archived copy, moved: marks were merged into the song that already held the old chart}. */
async function keepOldChart(ctx, here, rec, ops, incoming = new Map()){
  const {askKeys} = ctx;
  const stored = await get('files', here.id);
  if(!stored) return {made:false, moved:false};
  /* COPY the bytes: in Safari a Blob read back from the files store still points at the stored data, which this download is about to
     replace, so storing the same Blob under the copy's id would leave the copy with no PDF at all (the old chart lost). */
  const bytes = await stored.arrayBuffer(), old = new Blob([bytes], {type:'application/pdf'});
  const oldHash = hex(await crypto.subtle.digest('SHA-256', bytes)), songs = await all('songs');
  if(oldHash === String(rec.hash).toLowerCase()) return {made:false, moved:false};     // the same bytes: nothing is being replaced
  /* a song that holds the old bytes takes the old marks only if this run brought it as a new song, it is an ARCHIVED copy (never a Copy song in use) and nothing is asking about it */
  const cands = songs.filter(x => x && !x.deleted && x.archived === true && x.id !== here.id && ctx.arrived.has(x.id) && !askKeys.has('song:' + x.id) && String(x.hash || '').toLowerCase() === oldHash);
  /* this tablet's marks on the old chart: they do not belong on the new one, whoever holds the old chart afterwards. Every ink write
     here carries `ifUpdated` from the page as stored (a page drawn on in another tab meanwhile makes the whole write stale). */
  const was = raw => raw == null ? null : typeof raw.updated === 'number' ? raw.updated : raw.updated == null ? null : undefined;
  const ink = (key, value, w) => ops.push({store:'ink', key, value, ...(w === undefined ? {} : {ifUpdated:w})});
  const pages = [];
  for(let p = 1; p <= here.pages; p++){
    const key = here.id + ':' + p, raw = await get('ink', key), rec0 = upgradeInk(raw).record, cur = rec0.strokes;
    const drive = ((incoming.get(p) || {}).remote || {strokes:[]}).strokes;
    pages.push({p, key, rec0, cur, marks:cur.filter(x => !x.deleted), was:was(raw), drive, ids:new Set([...cur, ...drive].map(x => x.id))});
  }
  const mine = pages.some(pg => pg.cur.length);
  let holder = null;
  for(const x of cands){                          // with no marks to move any of them keeps the old chart; with marks, only this song's copy
    if(!mine){ holder = x; break; }
    for(const pg of pages){
      if(pg.p > x.pages || holder) continue;
      if(upgradeInk(await get('ink', x.id + ':' + pg.p)).record.strokes.some(s => !s.deleted && pg.ids.has(s.id))) holder = x;
    }
    if(holder) break;
  }
  let target = holder;                    // where the old marks go: a song that already holds the old chart (the other tablet's archived copy)...
  const ided = list => list.every(x => typeof x.id === 'string' && x.id);       // (what mergePage can merge)
  if(target) for(const pg of pages){              // ...unless it has marks of its own on a page where these marks are, then a copy keeps them apart
    if(!pg.cur.length) continue;
    /* "of its own": a live mark this song never had. The ids this song's marks had on the page: here, and in Drive's page of the song
       (the other tablet's New version leaves them there as erase markers and puts them, as strokes, on its archived copy). */
    const raw = await get('ink', target.id + ':' + pg.p);
    pg.held = upgradeInk(raw).record; pg.heldWas = was(raw);
    if(pg.held.strokes.some(x => !x.deleted && !pg.ids.has(x.id)) || !ided(pg.held.strokes) || !ided(pg.cur)){ target = null; break; }
  }
  let made = false, moved = false;
  if(!target){
    const copy = newSong({song:here.song, artist:here.artist, version:replacedVersion(here.version)}, here.pages, oldHash, here.colls || []);
    copy.id = unique(new Set([...songs.map(x => x.id), ...(await all('sets')).map(x => x.id)]));
    copy.archived = true;
    if(here.crop !== undefined) copy.crop = structuredClone(here.crop);
    ops.push({store:'files', key:copy.id, value:old}, {store:'songs', key:copy.id, value:copy});
    target = copy; made = true;
  }
  for(const pg of pages){
    const tk = target.id + ':' + pg.p;
    /* A separate copy keeps this tablet's live marks as they are. Drive's erase markers are NOT applied to it: without the other tablet's
       copy here, an erase made there cannot be told from New version clearing the new chart, and applying those would lose the marks. */
    if(made){ if(pg.marks.length) ink(tk, inkRecord(pg.marks), null); }                                        // the old chart keeps its marks (a new song: nothing to erase there)...
    else if(pg.cur.length){                                                                                   // ...merged with the holder's, erase markers too (an erase made here still erases there)
      const json = v => JSON.parse(JSON.stringify(v));                   // (a field holding undefined, which canon refuses, is left out as on Drive)
      /* a mark the other tablet erased BEFORE its New version is not on its copy, only an erase marker on Drive's page of this song: it
         stays erased on the copy (a marker for a mark the copy does hold is New version clearing the new chart, not an erase) */
      const held = new Set(pg.held.strokes.map(x => x.id)), erased = pg.drive.filter(x => x.deleted && !held.has(x.id));
      const ours = mergePage({updated:0, strokes:json(pg.cur)}, {updated:0, strokes:json(erased)}).record.strokes;
      const m = mergePage(json(pg.held), {updated:0, strokes:ours});
      if(m.changed.local){ ink(tk, {...m.record, updated:inkRecord(m.record.strokes, pg.held).updated}, pg.heldWas); moved = true; }
    }
    if(pg.p > rec.pages) ops.push({store:'ink', key:pg.key, delete:true, ...(pg.was === undefined ? {} : {ifUpdated:pg.was})});      // that page no longer exists
    else if(pg.cur.length) ink(pg.key, inkRecord(reconcile(pg.cur, []), pg.rec0), pg.was);                      // the new chart starts with fresh marks (stamped over the page it replaces)
  }
  return {made, moved};
}
async function download(ctx, a){
  const {rep, lib, local, signal, skip, unskip, wrote, limitedIds} = ctx, LIMIT = ctx.limit;
  const here = local.byId[a.kind].get(a.id) || null, ifUpdated = here && here.updated != null ? here.updated : null;
  const r = a.rec ? {rec:a.rec} : await fetchRecord(ctx, a.kind, a.id);
  if(r.skip){ skip(a.kind, here || {id:a.id}, r.skip); return; }
  const rec = normalize(a.kind, r.rec), ops = [];
  let archivedCopy = false, moved = false, incoming = null;
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
      if(ctx.spent + pf.size > LIMIT.run){ limitedIds.add('song:' + a.id); return; }
      let blob;
      try{ blob = await downloadBlob(pf.fileId, {signal, maxBytes:LIMIT.pdf}); }
      catch(err){
        if(err instanceof TooBig){ skip('song', rec, 'its PDF is too big'); return; }
        if(err instanceof DriveError && err.status === 404){ skip('song', rec, 'its PDF is no longer in Drive'); return; }
        if(perFile(err)){ if(++ctx.refusals >= 5) throw err; skip('song', rec, refusedText(err)); return; }
        throw err;
      }
      ctx.spent += blob.size; ctx.refusals = 0;
      if(await blob.slice(0, 5).text() !== '%PDF-'){ skip('song', rec, 'its PDF in Drive is not a PDF'); return; }
      if(await sha256(blob) !== h){ skip('song', rec, 'its PDF in Drive does not match its details'); return; }
      incoming = await incomingPages(ctx, rec);                                                // Drive's marks for it, read and checked before anything is written
      if(here && !here.deleted) ({made:archivedCopy, moved} = await keepOldChart(ctx, here, rec, ops, incoming));      // this tablet's different chart is kept as an archived copy
      ops.push({store:'files', key:a.id, value:blob});
    }else incoming = await incomingPages(ctx, rec);
  }
  ops.push({store:STORE[a.kind], key:a.id, value:rec, ifUpdated});
  const marks = incoming ? mergeIncoming(ctx, rec, incoming, ops) : {got:0, up:false};        // its pages of marks go in the same write (with ifUpdated)
  try{ await putAll(ops, archivedCopy ? undefined : {fromSync:true}); wrote.add(a.kind + ':' + a.id); rep.got[a.kind]++; if(archivedCopy){ rep.archived++; (rep.archivedNames = rep.archivedNames || []).push(nameOf('song', rec)); } unskip(a.kind, a.id); }
  catch(err){ if(err && err.name === 'StaleWrite'){ rep.changedMeanwhile++; return; } throw err; }       // edited in another tab meanwhile: the next sync decides again
  if(a.kind === 'song' && !here && !rec.deleted) ctx.arrived.add(a.id);          // a new song from Drive, written by this run
  if(a.kind === 'song') ctx.downNow.add(a.id);                                    // written from Drive in this round of downloads (js/syncmarks.js)
  rep.marks.got += marks.got;
  if(marks.up || moved) syncPending();             // this tablet's own marks are in what was written and go up later in the run: until then they are a change to sync
}

/* ---------- the person's answers about deletions made elsewhere ---------- */
/* Delete here: what the Delete button does (PDF and marks removed, setlists that held the song edited), in ONE transaction. */
export async function deleteHere(ctx, item, leave){
  const {rep} = ctx;
  if(!item.marker || item.marker.deleted !== true) return;       // only ever a real deletion marker
  try{ await putAll(await deleteOps(item.kind, item.id, {marker:item.marker, ifUpdated:item.here.updated, leave})); rep.removed++; }
  catch(err){ if(err && err.name === 'StaleWrite'){ rep.changedMeanwhile++; return; } throw err; }
}
/* Keep: this tablet's record is stamped newer than the marker, so it wins at the next plan and goes back up. */
export async function keep(ctx, item){
  const {rep} = ctx;
  const done = await update(STORE[item.kind], item.id, cur => cur && !cur.deleted && cur.updated === item.here.updated ? {...cur, updated:stamp(item.marker)} : undefined);
  if(done) rep.kept++; else rep.changedMeanwhile++;
}

const ups = w => KINDS.flatMap(k => w.filter(x => x.op === 'up' && x.kind === k));
/* New songs before songs this tablet already has (so another tablet's archived copy of an old chart is here before the
   replacement of that chart is considered), setlists last. */
const rank = (ctx, a) => a.kind === 'coll' ? 0 : a.kind === 'song' ? (ctx.local.byId.song.get(a.id) ? 2 : 1) : 3;
export const downs = (ctx, w) => w.filter(x => x.op === 'down').sort((x, y) => rank(ctx, x) - rank(ctx, y) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
export const runUps = async (ctx, w) => { const l = ups(w); for(const [i, a] of l.entries()){ ctx.check(); ctx.say(`Sending ${i + 1} of ${l.length}…`); await upload(ctx, a); } };
export const runDowns = async (ctx, w) => { const l = downs(ctx, w); for(const [i, a] of l.entries()){ ctx.check(); ctx.say(`Getting ${i + 1} of ${l.length}…`); await download(ctx, a); } };
/* A song whose record Drive and this tablet agree on, but whose PDF is missing in Drive (somebody removed it) or is not the one
   the record names: this tablet puts its own PDF back (sendPdf checks it against the record's hash first). Without this the
   record stays "the same" for ever and a tablet that does not have the song could never get it. */
export async function repairPdfs(ctx, sv){
  const {check, skip, repaired} = ctx;
  for(const [id, rec] of sv.local.byId.song){
    if(rec.deleted) continue;
    const re = sv.lib.records.song.get(id), li = sv.local.index.song.get(id), h = String(rec.hash || '').toLowerCase();
    if(!re || re.d || !li || re.c !== li.c || !HEX64.test(h)) continue;
    const pf = sv.lib.pdfs.get(id);
    if(pf && pf.h === h) continue;
    check();
    if(ctx.full) return;
    try{ if(await sendPdf(ctx, rec)) repaired.add(id); }
    catch(err){ if(err instanceof DriveError && err.status === 404) continue; if(err instanceof DriveError && err.kind === 'full'){ ctx.full = err; return; } if(perFile(err)){ if(++ctx.refusals >= 5) throw err; skip('song', rec, refusedText(err)); continue; } throw err; }
  }
}
/* A song whose deletion is already on Drive and which this tablet has deleted (or never had) must not leave its PDF behind (a
   run cut off between the marker and the PDF would otherwise leave it for ever). Idempotent. */
export async function sweepPdfs(ctx){
  const {lib, local, check, signal} = ctx;
  for(const [id, e] of lib.records.song){
    const pf = lib.pdfs.get(id), l = local.byId.song.get(id);
    if(!e.d || !pf || (l && !l.deleted)) continue;
    check();
    try{ await deleteFile(pf.fileId, {signal}); }catch(err){ if(!perFile(err)) throw err; }
  }
}

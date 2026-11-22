/*
 * An INDEPENDENT model of Drive sync Part 2 (songs, setlists, collections and PDFs), for the two-tablet loops.
 *
 * Written from the work order ("Part 2: sync songs, setlists and PDFs": Build 1 to 10, Guards) and the shared design note
 * (Drive layout, merge rules), never from js/sync.js, js/syncmerge.js, js/driveops.js, js/deleteops.js or js/syncdialogs.js.
 * Pure Node: no browser, no app code. A loop drives the real app and this model side by side and compares them.
 *
 *   const m = newModel();
 *   addTablet(m, 'A', lib)                    lib = libraryOf(snapshot) (records of every kind + PDF hashes): the tablet as built
 *   copyTablet(m, 'A', 'B')                   B restored from A's backup (same ids, same records, same PDFs, never synced)
 *   localEdit(m, 'A', kind, id, change, win, actual)    an edit made in the app; checks it, then takes the app's record
 *   localNew(m, 'A', kind, actual, win, {pdf})          a record the app made (Copy song, the old chart of New version...)
 *   localDelete(m, 'A', kind, id, win, actualLib)       the Delete button (a song: its PDF goes, its setlists lose it)
 *   adopt(m, 'A', kind, rec, {pdf})                     take a record as it is (written straight into storage by a loop)
 *   const r = sync(m, 'A', {now, answers})              one Sync on A: what A and Drive must hold afterwards, and the report
 *   compareTablet(m, 'A', lib, r.loose) / compareDrive(m, drive, r.loose)   -> list of differences ([] = identical)
 *
 * Kinds: 'song' | 'set' | 'coll'. `win` = {t0, t1}: the tablet's clock just before and just after the action.
 *
 * The rules, in this file's own words:
 *  - A tablet and Drive each hold, per kind, id -> record. A record is live, or a deletion marker {id, deleted:true, updated}
 *    (a marker is just a record). Drive also holds one PDF per live song id: {hash, name}. Nothing is ever matched by title
 *    or by PDF hash: two songs with the same PDF and different ids are two songs.
 *  - A local edit of an existing record gets updated = max(clock, previous updated + 1): it always beats what it was made from.
 *  - Sync, per (kind, id) seen on either side, L = here, R = Drive:
 *      only L .......................... send L (a live song's PDF first, then its record; a marker: record, then the PDF goes)
 *      only R, live .................... get R (its PDF, checked against R.hash, and the record together)
 *      only R, marker .................. nothing (never had it)
 *      L.updated > R.updated ........... send L          (a live L over a remote marker: the song survives, the report says so)
 *      L.updated < R.updated, R live ... get R           (also over a local marker: the newer live record wins)
 *      L.updated < R.updated, R marker . L live: ASK (Delete here / Keep / no answer = asked again next time); L marker: nothing
 *      equal updated, same content ..... nothing (also when they differ only by what loading fills in: upgraded())
 *      equal updated, other content .... the larger canonical JSON text wins on both tablets; a remote marker that would win
 *                                        only by this rule over a live local record is ASKED about, never applied by itself
 *    Absence is never deletion. Keep stamps the local record newer than the marker and sends it in the same run (so the
 *    other tablet gets it back at its next sync). Delete here does what Delete does (PDF gone, setlists that held the song
 *    lose it and are stamped); whether those setlist edits go up in the same run or the next is left open (`loose`).
 *  - "Changed on both tablets": a record whose content here and on Drive both differ from what the two last agreed on, with
 *    different times (a tie is settled, not reported).
 *  - A record dated more than a day after `now` is still synced, and listed in `future` (the report mentions it).
 *  - Drive layout (design note): PDF name = title (control characters removed, at most 200 characters, "Untitled" when empty)
 *    + ".pdf"; record files `<kind>-<id>.json` holding the record as JSON; properties u, c (sha-256 of canon), d, k, id, h.
 */
import crypto from 'node:crypto';

export const KINDS = ['song', 'set', 'coll'];
export const STORE = {song: 'songs', set: 'sets', coll: 'colls'};
export const DAY = 864e5;
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/* JSON text with object keys sorted at every depth, arrays in order, no spaces; undefined members left out as JSON does. */
export function canon(v){
  if(Array.isArray(v)) return '[' + v.map(x => (x === undefined ? 'null' : canon(x))).join(',') + ']';
  if(v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const sha256hex = data => crypto.createHash('sha256').update(data).digest('hex');
export const canonHash = rec => sha256hex(Buffer.from(canon(rec), 'utf8'));
/* "Song (version) - Artist", empty parts left out (CLAUDE.md, data model) */
export const titleOf = s => (s.song || '') + (s.version ? ` (${s.version})` : '') + (s.artist ? ` - ${s.artist}` : '');
/* The Drive name of a song's PDF (design note) */
export function pdfName(title){
  const t = String(title || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 200);
  return (t || 'Untitled') + '.pdf';
}
/* What loading a record fills in (CLAUDE.md data model: a derived title, empty artist and version, archived a boolean, `colls` a
   list of plain ids; a setlist's `colls` too). Two records that differ only by this are the same record: never a conflict, never
   a tie to settle, and a record that comes down is kept in this form. */
const PLAIN_ID = /^[A-Za-z0-9_.-]{1,64}$/;
export function upgraded(kind, r){
  if(!r || r.deleted || kind === 'coll') return r;
  const o = clone(r), ids = v => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && PLAIN_ID.test(x)))] : []);
  o.colls = ids(o.colls);
  if(kind === 'song'){ o.artist = o.artist || ''; o.version = o.version || ''; o.archived = !!o.archived; o.title = titleOf(o); }
  return o;
}
const same = (kind, a, b) => canon(upgraded(kind, a)) === canon(upgraded(kind, b));
/* The name a person sees for a record (what a report or the deletion list names) */
export const nameOf = (kind, r) => (!r ? '' : kind === 'song' ? r.title || titleOf(r) : r.name || '');

const side = () => ({song: new Map(), set: new Map(), coll: new Map()});
export function newModel(){ return {drive: {...side(), pdfs: new Map(), ink: new Map()}, tablets: {}}; }      // ink: Part 3, see the end of this file

/* lib: {songs:{id:rec}, sets:{...}, colls:{...}, files:{id:hash}} (libraryOf() in sync-two.mjs builds it from a snapshot) */
export function addTablet(m, name, lib){
  const t = {name, ...side(), pdfs: new Map(), base: side()};
  for(const k of KINDS) for(const r of Object.values(lib[STORE[k]] || {})) t[k].set(r.id, clone(r));
  for(const [id, h] of Object.entries(lib.files || {})) t.pdfs.set(id, h);
  t.ink = new Map(Object.entries(lib.ink || {}).map(([k, v]) => [k, clone(v)]));
  m.tablets[name] = t;
  return t;
}
export function copyTablet(m, from, name){
  const f = m.tablets[from], t = {name, ...side(), pdfs: new Map(f.pdfs), base: side()};
  for(const k of KINDS) for(const [id, r] of f[k]) t[k].set(id, clone(r));
  t.ink = new Map([...(f.ink || new Map())].map(([k, v]) => [k, clone(v)]));
  m.tablets[name] = t;
  return t;
}
const without = (r, key) => { const o = clone(r); delete o[key]; return o; };
const inWin = (u, lo, hi) => Number.isFinite(u) && u >= lo && u <= hi;

/* An edit made in the app on an existing record: `change` is the fields the person changed (title follows song/artist/version).
   The app's record must be the old one with exactly that change, its `updated` max(clock, old + 1) for a clock inside win. */
export function localEdit(m, name, kind, id, change, win, actual){
  const t = m.tablets[name], prev = t[kind].get(id), out = [];
  if(!prev || prev.deleted) return [`${name}: the model has no live ${kind} ${id} to edit`];
  const want = {...clone(prev), ...clone(change)};
  if(kind === 'song' && ['song', 'artist', 'version'].some(k => k in change)) want.title = titleOf(want);
  if(!actual) out.push(`${name}: the ${kind} ${nameOf(kind, prev)} is gone after the edit`);
  else{
    if(canon(without(want, 'updated')) !== canon(without(actual, 'updated'))) out.push(`${name}: ${kind} ${nameOf(kind, prev)} after the edit is ${canon(actual).slice(0, 300)}, the model expected ${canon(want).slice(0, 300)}`);
    const lo = Math.max(win.t0, prev.updated + 1), hi = Math.max(win.t1, prev.updated + 1);
    if(!inWin(actual.updated, lo, hi)) out.push(`${name}: ${kind} ${nameOf(kind, prev)} was stamped ${actual.updated}, the rule max(clock, ${prev.updated} + 1) gives ${lo}..${hi}`);
    t[kind].set(id, clone(actual));
  }
  return out;
}
/* A record the app made (it chose the id and the time): new id, `updated` inside win; a song brings its PDF hash. */
export function localNew(m, name, kind, actual, win, {pdf} = {}){
  const t = m.tablets[name], out = [];
  if(t[kind].has(actual.id)) out.push(`${name}: the new ${kind} reuses the id ${actual.id}`);
  if(!inWin(actual.updated, win.t0, win.t1)) out.push(`${name}: the new ${kind} ${nameOf(kind, actual)} has updated ${actual.updated}, not ${win.t0}..${win.t1}`);
  t[kind].set(actual.id, clone(actual));
  if(kind === 'song' && pdf) t.pdfs.set(actual.id, pdf);
  return out;
}
/* Delete (two taps). A song: marker, PDF gone, every live setlist that held it loses those rows and is stamped. */
export function localDelete(m, name, kind, id, win, lib){
  const t = m.tablets[name], prev = t[kind].get(id), out = [];
  const got = lib[STORE[kind]][id];
  const lo = Math.max(win.t0, prev.updated + 1), hi = Math.max(win.t1, prev.updated + 1);
  if(!got || got.deleted !== true || Object.keys(got).sort().join() !== 'deleted,id,updated' || !inWin(got.updated, lo, hi)) out.push(`${name}: after Delete the ${kind} ${nameOf(kind, prev)} is ${JSON.stringify(got)}, expected a marker stamped ${lo}..${hi}`);
  t[kind].set(id, clone(got || {id, deleted: true, updated: lo}));
  if(kind === 'song'){
    t.pdfs.delete(id);
    for(const [sid, st] of t.set) if(!st.deleted && (st.items || []).some(it => it.type === 'song' && it.id === id))
      out.push(...localEdit(m, name, 'set', sid, {items: st.items.filter(it => !(it.type === 'song' && it.id === id))}, win, lib.sets[sid]));
  }
  return out;
}
export function adopt(m, name, kind, rec, {pdf} = {}){
  const t = m.tablets[name];
  t[kind].set(rec.id, clone(rec));
  if(kind === 'song' && pdf !== undefined){ if(pdf) t.pdfs.set(rec.id, pdf); else t.pdfs.delete(rec.id); }
}

/* ---------- one Sync on tablet `name` ----------
   now: the tablet's clock at the run. answers: {id: 'delete' | 'keep'} for the deletion list (no entry = left alone).
   invalid: Set of 'kind:id' whose Drive record (or PDF) a tablet must refuse (skipped and listed, never written).
   Returns what the report must say and the places where the app may do either of two correct things (`loose`). */
export function sync(m, name, {now = Date.now(), answers = {}, invalid = new Set()} = {}){
  const t = m.tablets[name], d = m.drive;
  const r = {actions: [], sent: {song: 0, set: 0, coll: 0}, sentMarkers: 0, got: {song: 0, set: 0, coll: 0}, both: [], future: [], asked: [], kept: [], deletedHere: [], survived: [], skipped: [], loose: []};
  const deferred = [];                   // local edits made by Delete here: applied after the plan (they were not in the listing)
  const label = (kind, id) => nameOf(kind, t[kind].get(id) || d[kind].get(id)) || id;
  const up = (kind, id) => {
    const L = t[kind].get(id);
    if(kind === 'song'){
      if(L.deleted) d.pdfs.delete(id);
      else d.pdfs.set(id, {hash: L.hash, name: pdfName(L.title)});
    }
    d[kind].set(id, clone(L));
    if(L.deleted) r.sentMarkers++; else r.sent[kind]++;
    r.actions.push({op: 'up', kind, id});
  };
  const down = (kind, id) => {
    const R = d[kind].get(id);
    if(kind === 'song'){
      const p = d.pdfs.get(id);
      if(!p || p.hash !== R.hash){ r.skipped.push({kind, id, name: label(kind, id), why: p ? 'PDF does not match' : 'no PDF'}); return; }
      t.pdfs.set(id, p.hash);
    }
    t[kind].set(id, upgraded(kind, R));
    r.got[kind]++;
    r.actions.push({op: 'down', kind, id});
  };
  const ask = (kind, id) => {
    const L = t[kind].get(id), R = d[kind].get(id), a = answers[id];
    r.asked.push({kind, id, name: label(kind, id)});
    if(a === 'keep'){
      /* stamped newer than the marker; content as it was; sent in this run */
      const kept = {...clone(L), updated: Math.max(now, R.updated + 1)};
      t[kind].set(id, kept); up(kind, id);
      r.kept.push({kind, id, name: nameOf(kind, L)});
      r.loose.push({where: 'tablet', tablet: name, kind, id, why: 'Keep stamps the record newer than the marker (exact time unknown)', ok: x => !!x && !x.deleted && x.updated > R.updated && canon(without(x, 'updated')) === canon(without(L, 'updated'))});
      r.loose.push({where: 'drive', kind, id, why: 'the kept record is sent in the same run', ok: x => !!x && !x.deleted && x.updated > R.updated && canon(without(x, 'updated')) === canon(without(L, 'updated'))});
    }else if(a === 'delete'){
      r.deletedHere.push({kind, id, name: nameOf(kind, L)});
      t[kind].set(id, clone(R));
      r.loose.push({where: 'tablet', tablet: name, kind, id, why: 'Delete here leaves a marker (the remote one, or one stamped here)', ok: x => !!x && x.deleted === true && x.updated >= R.updated});
      r.loose.push({where: 'drive', kind, id, why: 'the marker on Drive, or a newer one from here', ok: x => !!x && x.deleted === true && x.updated >= R.updated});
      if(kind === 'song'){
        t.pdfs.delete(id);
        for(const [sid, st] of t.set) if(!st.deleted && (st.items || []).some(it => it.type === 'song' && it.id === id)) deferred.push({sid, drop: id});
      }
      r.actions.push({op: 'deleteHere', kind, id});
    }else r.actions.push({op: 'asked', kind, id});
  };

  /* "changed on both" is decided against what the two sides last agreed on, before anything moves */
  for(const kind of KINDS){
    for(const id of new Set([...t[kind].keys(), ...d[kind].keys()])){
      const L = t[kind].get(id), R = d[kind].get(id), base = t.base[kind].get(id);
      for(const x of [L, R]) if(x && x.updated > now + DAY && !r.future.some(f => f.kind === kind && f.id === id)) r.future.push({kind, id, name: label(kind, id)});
      /* (equal times are a tie, settled by the rule below, not a conflict to report; records the same once loaded are the same) */
      if(L && R && base !== undefined && L.updated !== R.updated && !same(kind, L, R)){
        const cl = canon(upgraded(kind, L)), cr = canon(upgraded(kind, R));
        if(cl !== base && cr !== base) r.both.push({kind, id, local: L, remote: R});
      }
    }
  }
  for(const kind of ['coll', 'song', 'set']){
    for(const id of [...new Set([...t[kind].keys(), ...d[kind].keys()])].sort()){
      const L = t[kind].get(id), R = d[kind].get(id);
      if(invalid.has(kind + ':' + id)){ r.skipped.push({kind, id, name: label(kind, id), why: 'invalid on Drive'}); continue; }
      if(!R){ if(L) up(kind, id); continue; }                         // absence is never deletion
      if(!L){ if(!R.deleted) down(kind, id); continue; }               // a marker for something never had: nothing
      if(L.updated > R.updated){ if(R.deleted && !L.deleted) r.survived.push({kind, id, name: nameOf(kind, L)}); up(kind, id); continue; }
      if(L.updated < R.updated){
        if(!R.deleted) down(kind, id);
        else if(!L.deleted) ask(kind, id);
        continue;
      }
      const cl = canon(L), cr = canon(R);
      if(cl === cr || same(kind, L, R)) continue;
      if(cl > cr) up(kind, id);
      else if(R.deleted && !L.deleted) ask(kind, id);                  // a deletion that wins only by the tie rule is asked about
      else down(kind, id);
    }
  }
  /* the winner of each "changed on both" record, by name */
  r.both = r.both.map(b => ({kind: b.kind, id: b.id, name: nameOf(b.kind, b.local.deleted ? b.remote : b.local) || b.id, kept: t[b.kind].get(b.id)}));
  for(const {sid, drop} of deferred){
    const st = t.set.get(sid), before = clone(d.set.get(sid));
    const next = {...clone(st), items: st.items.filter(it => !(it.type === 'song' && it.id === drop)), updated: Math.max(now, st.updated + 1)};
    t.set.set(sid, next);
    r.loose.push({where: 'tablet', tablet: name, kind: 'set', id: sid, why: 'Delete here takes the song out of this setlist (stamped here)', ok: x => !!x && !x.deleted && x.updated > st.updated && canon(without(x, 'updated')) === canon(without(next, 'updated'))});
    r.loose.push({where: 'drive', kind: 'set', id: sid, why: 'the setlist edit made by Delete here may go up in this run or the next', ok: x => canon(x) === canon(before) || (!!x && !x.deleted && canon(without(x, 'updated')) === canon(without(next, 'updated')))});
  }
  settleBase(t, d);
  return r;
}
/* Where a tablet and Drive hold the same record, that is what they last agreed on. */
function settleBase(t, d){
  for(const kind of KINDS) for(const [id, L] of t[kind]){ const R = d[kind].get(id); if(R && same(kind, L, R)) t.base[kind].set(id, canon(upgraded(kind, L))); }
}

/* ---------- comparing ----------
   compareTablet: lib = libraryOf(snapshot(page)). compareDrive: drive = readDrive(google) from sync-two.mjs.
   A `loose` entry accepts any record its `ok` accepts there; the model then takes what the app did. Returns differences. */
export function compareTablet(m, name, lib, loose = []){
  const t = m.tablets[name], out = [];
  for(const kind of KINDS){
    const got = lib[STORE[kind]] || {};
    for(const id of new Set([...t[kind].keys(), ...Object.keys(got)])){
      const want = t[kind].get(id), has = got[id], l = loose.find(x => x.where === 'tablet' && x.tablet === name && x.kind === kind && x.id === id);
      if(l){ if(!l.ok(has)) out.push(`${name} ${kind} ${nameOf(kind, want) || id}: ${canon(has).slice(0, 200)} is not what the model allows (${l.why})`); else t[kind].set(id, clone(has)); continue; }
      if(canon(want) !== canon(has)) out.push(`${name} ${kind} ${nameOf(kind, want || has) || id}: tablet ${canon(has).slice(0, 240)} | model ${canon(want).slice(0, 240)}`);
    }
  }
  const files = lib.files || {};
  for(const id of new Set([...t.pdfs.keys(), ...Object.keys(files)]))
    if(t.pdfs.get(id) !== files[id]) out.push(`${name} PDF of ${nameOf('song', t.song.get(id)) || id}: tablet ${files[id] || 'none'} | model ${t.pdfs.get(id) || 'none'}`);
  settleBase(t, m.drive);
  return out;
}
export function compareDrive(m, drive, loose = []){
  const d = m.drive, out = [];
  for(const kind of KINDS){
    const got = drive.recs[kind];
    for(const id of new Set([...d[kind].keys(), ...got.keys()])){
      const want = d[kind].get(id), has = got.get(id), l = loose.find(x => x.where === 'drive' && x.kind === kind && x.id === id);
      if(l){ if(!l.ok(has)) out.push(`Drive ${kind} ${nameOf(kind, want) || id}: ${canon(has).slice(0, 200)} is not what the model allows (${l.why})`); else if(has) d[kind].set(id, clone(has)); continue; }
      if(canon(want) !== canon(has)) out.push(`Drive ${kind} ${nameOf(kind, want || has) || id}: Drive ${canon(has).slice(0, 240)} | model ${canon(want).slice(0, 240)}`);
    }
  }
  /* a kept song brings its PDF back; a song deleted here (Delete here, then sent) takes it away: the PDFs follow the records */
  for(const l of loose) if(l.where === 'drive' && l.kind === 'song'){ const x = d.song.get(l.id); if(x && !x.deleted) d.pdfs.set(l.id, {hash: x.hash, name: pdfName(x.title)}); else d.pdfs.delete(l.id); }
  /* (what a tablet last agreed with Drive is settled by compareTablet, for the tablet compared) */
  for(const id of new Set([...d.pdfs.keys(), ...drive.pdfs.keys()])){
    const want = d.pdfs.get(id), has = drive.pdfs.get(id);
    if(!want !== !has || (want && (want.hash !== has.hash || want.name !== has.name))) out.push(`Drive PDF of ${nameOf('song', d.song.get(id)) || id}: Drive ${has ? has.name + ' ' + has.hash.slice(0, 12) : 'none'} | model ${want ? want.name + ' ' + want.hash.slice(0, 12) : 'none'}`);
  }
  return out;
}

/* ==================== Marks: Drive sync Part 3 (pen, highlighter and text notes) ====================
   Written from the Part 3 spec, never from js/syncink.js, js/syncapply.js or js/driveops.js. The records (which songs are live
   on a tablet after a run, their pages and charts) are Part 2's and are read from the app; this step models the marks only.

   The rules, in this file's own words:
    - A page is {updated, strokes:[entries]}; an entry is a pen or highlighter stroke, a text note, or the marker an erase
      leaves {id, deleted:true, updated}. Entries are compared BY ID; their order is not modelled.
    - Merge of two pages: every id of either side; for an id on both, the entry with the larger `updated` wins, equal times:
      the larger canonical JSON text (the same answer on both tablets). The page's `updated` is the larger of the two and at
      least its newest entry's.
    - One Sync on a tablet, after its records are settled: a song whose chart was replaced by the run (same id, another PDF
      hash) has its marks (erase markers too) moved onto the archived song that holds the old chart, and starts with Drive's marks only; a
      song that is not live here afterwards has no marks here; Drive's pages of a song whose Drive record is a deletion marker
      are removed. Then every page of a song live here whose chart Drive holds (Drive's PDF has the song's hash here: marks
      never cross from one chart to another), page number 1..pages, seen on either side: both get the merge (a page
      with no entries at all is not a page). Pages past the song's end and pages listed in `invalid` (hostile on Drive) are
      left as they are on both sides.
    - Every Drive page carries h, the SHA-256 of the chart it was drawn on: it is merged on a tablet only when h is that tablet's
      song hash; a page with another h is treated as no page (this tablet's own page for its chart replaces it, with its h).
    - A local action (draw, erase, edit, undo, Clear, New version) is taken from the app as it stored it (inkLocal), after the
      loop has checked it. */
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const inkKeyOf = (id, p) => `${id}:${p}`;
export const splitInkKey = k => { const i = k.lastIndexOf(':'); return {id: k.slice(0, i), p: Number(k.slice(i + 1))}; };
export function inkWinner(a, b){
  if(num(a.updated) !== num(b.updated)) return num(a.updated) > num(b.updated) ? a : b;
  return canon(a) >= canon(b) ? a : b;
}
const entryMap = page => { const m = new Map(); for(const s of (page && Array.isArray(page.strokes) ? page.strokes : [])) m.set(s.id, m.has(s.id) ? inkWinner(m.get(s.id), s) : s); return m; };
export function inkMerge(a, b){
  const out = entryMap(a);
  for(const [id, s] of entryMap(b)) out.set(id, out.has(id) ? inkWinner(out.get(id), s) : s);
  let u = Math.max(num(a && a.updated), num(b && b.updated));
  for(const s of out.values()) u = Math.max(u, num(s.updated));
  return {updated: u, strokes: [...out.values()].map(clone)};
}
const entriesText = page => canon([...entryMap(page).entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
const liveText = page => canon([...entryMap(page).entries()].filter(([, s]) => !s.deleted).sort((x, y) => (x[0] < y[0] ? -1 : 1)));
const pageText = page => entriesText(page) + '|' + (entryMap(page).size ? num(page.updated) : 0);
/* differences between two pages, by id ([] = the same entries) */
export function inkDiff(want, has, {extraMarkers = false} = {}){
  const W = entryMap(want), H = entryMap(has), out = [];
  for(const id of new Set([...W.keys(), ...H.keys()])){
    const w = W.get(id), h = H.get(id);
    if(!h) out.push(`${id} missing (model ${canon(w).slice(0, 120)})`);
    else if(!w){ if(!(extraMarkers && h.deleted === true)) out.push(`${id} should not be there (${canon(h).slice(0, 120)})`); }
    else if(canon(w) !== canon(h) && !(extraMarkers && w.deleted === true && h.deleted === true)) out.push(`${id}: ${canon(h).slice(0, 140)} | model ${canon(w).slice(0, 140)}`);
  }
  return out;
}
export function inkSeed(m, name, ink){ m.tablets[name].ink = new Map(Object.entries(ink || {}).map(([k, v]) => [k, clone(v)])); }
export function inkSeedDrive(m, pages, hs = new Map()){ m.drive.ink = new Map([...pages].map(([k, v]) => [k, clone(v)])); m.drive.inkH = new Map(hs); }
export function inkLocal(m, name, key, page){ const t = m.tablets[name]; if(page && entryMap(page).size) t.ink.set(key, clone(page)); else t.ink.delete(key); }

/* One Sync on tablet `name`: before / after = the tablet's song records (id -> record) before and after the run, driveSongs
   = Drive's song records after it, drivePdfs = Drive's PDFs after it (id -> hash). Returns {sent: pages whose page record changed on Drive (entries or the page's time), got: pages
   whose drawn marks changed here (a mark, a newer version of one, an erase; markers of marks never drawn here do not count), moved, problems}. */
export function inkSync(m, name, {before, after, driveSongs, drivePdfs = null, invalid = new Set()}){
  const t = m.tablets[name], D = m.drive.ink, r = {sent: [], got: [], moved: [], problems: []};
  const liveAfter = id => !!after[id] && !after[id].deleted;
  for(const [id, b] of Object.entries(before)){
    if(b.deleted || !liveAfter(id) || b.hash === after[id].hash) continue;
    const mine = [...t.ink.keys()].filter(k => splitInkKey(k).id === id);
    const cands = Object.values(after).filter(s => !s.deleted && s.archived && s.hash === b.hash && s.id !== id), fresh = cands.filter(s => !before[s.id]);
    const holder = cands.length === 1 ? cands[0] : fresh.length === 1 ? fresh[0] : null;
    /* every entry moves, erase markers too: a mark erased here before the new chart arrived stays erased on the archived copy */
    const allOn = k => [...entryMap(t.ink.get(k)).values()], liveOn = k => allOn(k).filter(s => !s.deleted);
    if(!holder){ if(mine.some(k => liveOn(k).length)) r.problems.push(`${name}: the chart of ${nameOf('song', b)} was replaced and ${cands.length} archived songs hold the old chart (the model needs one)`); }
    else for(const k of mine){ const es = allOn(k); if(es.length){ const hk = inkKeyOf(holder.id, splitInkKey(k).p); t.ink.set(hk, inkMerge(t.ink.get(hk), {updated: 0, strokes: es})); } }
    for(const k of mine) t.ink.delete(k);
    r.moved.push({from: id, to: holder && holder.id});
    /* what the replaced chart's own pages hold here afterwards is Drive's marks; whether the app also leaves markers there for
       the marks it moved away, and how it dates them (they are not drawn), is not settled by the spec: on this song, markers
       the model does not have, or dated otherwise, are accepted (live entries must still be exactly the model's) */
    (m.inkLoose || (m.inkLoose = new Set())).add(id);
  }
  for(const k of [...t.ink.keys()]) if(!liveAfter(splitInkKey(k).id)) t.ink.delete(k);
  for(const k of [...D.keys()]){ const dr = driveSongs[splitInkKey(k).id]; if(dr && dr.deleted) D.delete(k); }
  for(const k of [...new Set([...t.ink.keys(), ...D.keys()])].sort()){
    if(invalid.has(k)) continue;
    const {id, p} = splitInkKey(k);
    if(!liveAfter(id) || !(p >= 1 && p <= num(after[id].pages))) continue;
    /* marks never cross charts: a song's marks sync only while Drive holds the chart this tablet has (drivePdfs: id -> hash) */
    if(drivePdfs && drivePdfs.get(id) !== after[id].hash) continue;
    /* ... and Drive's record of the song names that chart too (a record refused on its way up leaves Drive's old chart in charge) */
    if(drivePdfs && !(driveSongs[id] && !driveSongs[id].deleted && driveSongs[id].hash === after[id].hash)) continue;
    /* a Drive page drawn on another chart (its h is not this song's hash here) is never merged into this chart: as if Drive had
       no page; this tablet's own page for its chart replaces it if it has one */
    const H = m.drive.inkH || (m.drive.inkH = new Map()), hash = after[id].hash;
    const R0 = D.get(k), R = R0 && H.has(k) && H.get(k) !== hash ? null : R0, L = t.ink.get(k), M = inkMerge(L, R);
    if(!M.strokes.length) continue;
    if(liveText(L) !== liveText(M)) r.got.push(k);                    // got: what is drawn here changed (a mark, a newer version, an erase)
    if(pageText(R) !== pageText(M) || (R0 && !R)) r.sent.push(k);
    t.ink.set(k, M); D.set(k, clone(M)); H.set(k, hash);
  }
  return r;
}
/* the tablet's ink (lib = libraryOf()) against the model: every page of a live song, 1..pages, by id */
export function inkCompareTablet(m, name, lib){
  const t = m.tablets[name], out = [];
  for(const k of new Set([...t.ink.keys(), ...Object.keys(lib.ink || {})])){
    const {id, p} = splitInkKey(k), s = lib.songs[id];
    if(!s || s.deleted){ if(lib.ink[k] && entryMap(lib.ink[k]).size) out.push(`${name} holds the marks ${k} of a song that is not live there`); continue; }
    if(!(p >= 1 && p <= num(s.pages))) continue;
    for(const d of inkDiff(t.ink.get(k), lib.ink[k], {extraMarkers: !!(m.inkLoose && m.inkLoose.has(id))})) out.push(`${name} "${nameOf('song', s)}" page ${p}: ${d}`);
  }
  return out;
}
/* Drive's pages (readMarks().pages) against the model, for every page of a song that Drive holds live, 1..pages; a page of a
   song Drive holds as deleted must not be there. */
export function inkCompareDrive(m, pages, driveSongs, hs = null){
  const D = m.drive.ink, H = m.drive.inkH || new Map(), out = [];
  for(const k of new Set([...D.keys(), ...pages.keys()])){
    const {id, p} = splitInkKey(k), s = driveSongs[id];
    if(s && s.deleted){ if(pages.has(k)) out.push(`Drive still holds the marks ${k} of a deleted song`); continue; }
    if(!s || !(p >= 1 && p <= num(s.pages))) continue;
    for(const d of inkDiff(D.get(k), pages.get(k), {extraMarkers: !!(m.inkLoose && m.inkLoose.has(id))})) out.push(`Drive "${nameOf('song', s)}" page ${p}: ${d}`);
    if(hs && H.has(k) && pages.has(k) && hs.get(k) !== H.get(k)) out.push(`Drive "${nameOf('song', s)}" page ${p}: drawn on the chart ${String(hs.get(k)).slice(0, 12)} (h), the model says ${String(H.get(k)).slice(0, 12)}`);
  }
  return out;
}
/* New version on `name` (CLAUDE.md data model): `id` keeps its id and takes the new chart, its live marks become markers
   stamped over them, pages past the new end lose their marks; the archived copy `copyId` holds every live mark exactly, and
   no marker. Checked against what the app stored (inkBefore / inkAfter = the tablet's ink store), then taken. */
export function inkNewVersion(m, name, id, copyId, inkBefore, inkAfter, newPages){
  const out = [], keys = Object.keys(inkBefore).filter(k => splitInkKey(k).id === id);
  for(const k of keys){
    const p = splitInkKey(k).p, was = entryMap(inkBefore[k]), lv = [...was.values()].filter(s => !s.deleted);
    const ck = inkKeyOf(copyId, p), copy = inkAfter[ck];
    if(lv.length || (copy && entryMap(copy).size)) for(const d of inkDiff({strokes: lv}, copy)) out.push(`${name} New version: the archived copy page ${p}: ${d}`);
    const now = entryMap(inkAfter[k]);
    if(p > newPages){ if(now.size) out.push(`${name} New version: page ${p} is past the new chart's end and still has marks`); continue; }
    for(const s of lv){ const x = now.get(s.id); if(!x || x.deleted !== true || !(num(x.updated) > num(s.updated))) out.push(`${name} New version: ${s.id} on page ${p} is ${JSON.stringify(x)}, not a marker stamped after ${s.updated}`); }
    for(const [sid, x] of now) if(!x.deleted) out.push(`${name} New version: ${sid} on page ${p} is still live on the new chart`);
  }
  for(const k of new Set([...keys, ...Object.keys(inkAfter).filter(k => [id, copyId].includes(splitInkKey(k).id))])) inkLocal(m, name, k, inkAfter[k]);
  return out;
}
/* After a comparison passed: on a song whose replaced chart left markers the spec does not settle (m.inkLoose), the model takes the
   pages the app and Drive hold, so its next prediction starts from them (live entries were already checked equal). */
export function inkAdoptLoose(m, name, lib, drivePages){
  if(!m.inkLoose || !m.inkLoose.size) return;
  const t = name && m.tablets[name], D = m.drive.ink;
  if(t) for(const [k, v] of Object.entries(lib.ink || {})) if(m.inkLoose.has(splitInkKey(k).id)) t.ink.set(k, clone(v));
  if(drivePages) for(const [k, v] of drivePages) if(m.inkLoose.has(splitInkKey(k).id)) D.set(k, clone(v));
}

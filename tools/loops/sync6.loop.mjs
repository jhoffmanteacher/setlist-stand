/*
 * Drive sync Part 3, pen marks and text notes between two tablets: "sync 6a" .. "sync 6j" (and, run with SS_BROWSER=webkit,
 * the same loops as "sync 7a" .. "sync 7j": they must pass in both engines).
 *
 * Written from the Part 3 spec, not from js/syncink.js, js/syncapply.js or js/driveops.js. Two browser contexts share ONE
 * stand-in Drive (fake-google.mjs); marks are made through the app's screens (pen, highlighter, text note, eraser, Undo,
 * note dialog and drag) or through its store (js/store.js putInk / stamp / reconcile, as js/ink.js saves them), every Sync
 * through the Sync button. What the app PRODUCED is read back apart from the app: each tablet's IndexedDB, the stand-in's
 * own files (readMarks: the Marks folder, one file per page, its properties and its bytes), the IndexedDB transaction log
 * (a song and its marks in one write) and the request log; marks are compared with the independent model in sync-model.mjs.
 *
 *  6a  pen, highlighter and notes on the SAME page on both tablets, both offline; Sync A, B, A: both hold the union by id,
 *      the model agrees, the counts in the report ("Sent marks on 1 page.", "Got ..."), then "Everything is up to date".
 *  6b  a note edited and moved on B, a stroke erased on A, and an erase undone on A after B erased the same stroke: converge.
 *  6c  a page of 400 strokes and a page of 12 notes; a page of only deletion markers is uploaded; an empty page and a page
 *      past the song's end are not; edits on the other tablet come back.
 *  6d  hostile pages planted in the Marks folder (Infinity, NaN, a 1.2-million-point stroke, nesting 100000 deep, a wrong u,
 *      a wrong c, a 20 MB file, invalid JSON, a page number the song does not have, an unknown song, a deleted song, 50001
 *      strokes): each skipped and named "<song>: page N: <plain reason>", the song and its other pages still sync, nothing
 *      hostile reaches either database, a second Sync is the same.
 *  6e  New version on A while B has an unsynced mark on the old chart: the archived copy holds every old mark on both
 *      tablets (B's too), the new chart starts with fresh marks, a mark on the new chart goes both ways.
 *  6f  B's clock 2 hours behind: its erase and its note edit of A's newer marks still win.
 *  6g  after the sync, Back up -> wipe -> Restore gives the same marks and a Sync with nothing to do; a printed page, read
 *      back with pdf.js, shows both tablets' marks and not the erased one.
 *  6h  a fresh tablet's first Sync cut off mid-download (a reload, Stop, the connection dropped): every song is there WITH its
 *      marks or not there; the next Sync finishes; each song came down with its marks in ONE transaction.
 *  6i  a deleted song: its ink files leave Drive, a page planted for it later is removed and never brings it back.
 *  6j  signed in, marks made on both tablets: nothing is sent to Google without a tap; the reminder offers Sync; it sends them.
 *  6k  Drive full (403 storageQuotaExceeded) at the first sync with marks to send and songs to get: what can come down does,
 *      the plain "Your Google Drive is full", nothing half written, no Marks folder or ink file left; then the marks go.
 *  6l  a run with nothing to send never makes the Marks folder; the first mark makes exactly one.
 *  6m  marks go up only while Drive holds the song's own chart (a refused chart upload keeps them back); then they follow it.
 *  6n  the run that puts a new, shorter chart on Drive removes the old chart's pages past the end.
 *  6p  New version of a Copy song (the original, archived, holds the same PDF): the old marks go to New version's archived copy only.
 *  6o  a Drive page changed between the read and the write (the other tablet's run) is not written over: the next Sync merges.
 *
 * WebKit: nothing is skipped here. sync-two.mjs runs the tablets with the service worker blocked under WebKit (Playwright's
 * WebKit cannot route requests from a page a worker controls); nothing in these loops needs the worker.
 */
import {assert, sleep, diff, snapshot, normalise, backupNow, restoreZip, wipe, idbAll} from './harness.mjs';
import {openTablet, makeFromBackup, tapSync, finishSync, syncTap, libraryOf, readDrive, setClock, clockOf, takeWrites, halfSongs} from './sync-two.mjs';
import {startA, startPair, roles, live, songBy, whole, addCopies, deleteSongUi, saveSong, removeDriveFile, pageErrors, waitBox} from './sync-kit.mjs';
import {newModel, addTablet, canonHash, inkSeed, inkSeedDrive, inkLocal, inkSync, inkCompareTablet, inkCompareDrive, inkNewVersion, inkAdoptLoose} from './sync-model.mjs';
import {readMarks, plantPage, splitKey, entriesOf, liveIds, markerIds, byIdDiff, hostileIn, inkOf, pageOf, putPage, addEntries, eraseIds, editNote,
  penLine, hlLine, textNote, PEN, HL, HOUR, openOn, closeViewer, uiLine, uiNote, uiEditNote, uiMoveNote, uiErase, uiUndo,
  watchReports, syncRead, marksCounts, skippedPage, writesBy, makePdf, newVersionUi, printSetPdf, renderBoxes, loopName} from './sync-ink-kit.mjs';

const VERBOSE = process.argv.includes('--verbose');
export const finished = (r, what) => assert(r.state === 'finished', `${what}: the sync did not finish: ${r.title}: ${r.text.slice(0, 500)}`);
export const noErrors = (...ts) => { for(const t of ts){ const e = pageErrors(t); assert(!e.length, `${t.name}: page errors: ${e.join(' | ')}`); } };
const titleIn = (lib, id) => lib.songs[id].title;
export const closeAll = async (...ts) => { for(const t of ts) if(t) await t.close().catch(() => {}); };

/* A synced pair (startPair) with the report watcher on both. */
export async function pair6(ctx){
  const {A, B} = await startPair(ctx);
  await watchReports(A); await watchReports(B);
  return {A, B};
}
/* A model of both tablets' marks and Drive's, taken now (the tablets and Drive must already agree: checked). */
export async function seedModel(A, B){
  const m = newModel();
  for(const t of [A, B]){ const L = await libraryOf(t); addTablet(m, t.name, L); inkSeed(m, t.name, L.ink); }
  { const rm = readMarks(A.google); inkSeedDrive(m, rm.pages, rm.h); }
  return m;
}
const driveSongs = google => Object.fromEntries(readDrive(google).recs.song);
/* Everything about marks agrees: each tablet with the model, Drive with the model, the Drive layout, nothing hostile stored. */
export async function agree(m, tablets, what, {except} = {}){
  const g = tablets[0].google, marks = readMarks(g, {except}), ds = driveSongs(g), out = [...marks.problems.map(p => 'Drive marks layout: ' + p), ...inkCompareDrive(m, marks.pages, ds, marks.h)];
  const libs = [];
  for(const t of tablets){
    const L = await libraryOf(t); libs.push([t.name, L]);
    out.push(...inkCompareTablet(m, t.name, L), ...whole(L).map(p => `${t.name}: ${p}`), ...hostileIn(L).map(p => `${t.name}: ${p}`));
  }
  assert(!out.length, `${what}: the app, Drive and the model disagree on marks:\n    ` + out.slice(0, 16).join('\n    '));
  for(const [n, L] of libs) inkAdoptLoose(m, n, L, marks.pages);
  return marks;
}
/* A song that came down in this run: the transaction that wrote its PDF also wrote each of its pages that Drive held. */
export function marksApart(writes, pages){
  const out = [];
  for(const w of writes) if(w.op === 'put' && w.store === 'files'){
    const inTx = new Set(writes.filter(x => x.tx === w.tx && x.op === 'put' && x.store === 'ink').map(x => x.key));
    for(const k of pages.keys()) if(splitKey(k).id === w.key && !inTx.has(k)) out.push(`the song ${w.key} was written without its marks ${k} in the same transaction`);
  }
  return out;
}
/* One Sync through the button, the same run in the model, the report's marks counts checked against it, and the agreement. */
export async function doSync(m, t, what, {answers, invalid, except, counts = true, other} = {}){
  const before = (await libraryOf(t)).songs, pagesBefore = readMarks(t.google, {except}).pages;
  t.google.clearLog(); await takeWrites(t);
  const rep = await syncRead(t, {answers});
  finished(rep, what);
  const writes = await takeWrites(t), half = [...halfSongs(writes), ...marksApart(writes, pagesBefore)];
  assert(!half.length, `${what}: ${half.join('; ')}`);
  const after = await libraryOf(t);
  const r = inkSync(m, t.name, {before, after: after.songs, driveSongs: driveSongs(t.google), drivePdfs: new Map([...readDrive(t.google).pdfs].map(([k, v]) => [k, v.hash])), invalid});
  assert(!r.problems.length, `${what}: ${r.problems.join('; ')}`);
  if(VERBOSE) console.log(`    ${what}: ${rep.text}\n      model marks: sent ${r.sent.join(', ') || '-'} got ${r.got.join(', ') || '-'}${r.moved.length ? ' moved ' + JSON.stringify(r.moved) : ''}`);
  if(counts && !r.moved.length){
    /* pages of a song whose chart was replaced may carry markers the spec leaves open (see inkSync): they may add to the counts */
    const c = marksCounts(rep.text), slack = [...readMarks(t.google, {except}).pages.keys()].filter(k => m.inkLoose && m.inkLoose.has(splitKey(k).id)).length;
    const ok = (n, want) => n >= want && n <= want + slack;
    assert(ok(c.sent, r.sent.length) && ok(c.got, r.got.length), `${what}: the report "${rep.text.slice(0, 400)}" counts marks sent on ${c.sent} and got on ${c.got} page(s); the model: sent ${r.sent.length} (${r.sent.join(', ')}), got ${r.got.length} (${r.got.join(', ')})${slack ? ` (give or take ${slack})` : ''}`);
  }
  await agree(m, other ? [t, other] : [t], what, {except});
  return {rep, r, lib: after, writes};
}
/* A Sync with nothing to do: the report says so and nothing is written to Drive. */
export async function upToDate(t, what){
  t.google.clearLog();
  const rep = await syncRead(t);
  finished(rep, what);
  const w = writesBy(t.google, t.name);
  assert(/Everything is up to date/.test(rep.text) && !/marks on/.test(rep.text), `${what}: a Sync with nothing to do says "${rep.text.slice(0, 300)}"`);
  assert(!w.length, `${what}: a Sync with nothing to do wrote to Drive: ${w.map(e => e.method + ' ' + e.path).slice(0, 5).join(', ')}`);
}
export const sameMarks = async (A, B, keys, what) => {
  const ia = await inkOf(A), ib = await inkOf(B);
  for(const k of keys){ const d = byIdDiff(ia[k], ib[k], {la: A.name, lb: B.name}); assert(!d.length, `${what}: ${A.name} and ${B.name} hold different marks on ${k}: ${d.slice(0, 5).join(' | ')}`); }
};
const order = page => (page ? page.strokes : []).map(s => s.id);
const later = (x, y, what) => assert(x && y && Number(x.updated) > Number(y.updated), `${what}: ${JSON.stringify(x).slice(0, 160)} is not stamped after ${JSON.stringify(y).slice(0, 160)}`);

/* ---------- 6a ---------- */
async function loopSamePage(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const {b} = roles(await libraryOf(A));
    const [id] = await addCopies(A, 1, 'sa', {from: b.id}), key = id + ':1';
    finished(await syncRead(A), 'Sync A (a new song, no marks)'); finished(await syncRead(B), 'Sync B (gets it)');
    const m = await seedModel(A, B);
    /* both tablets offline: the marks need no network and nothing reaches Google */
    const g = A.google, n0 = g.requests.length;
    g.offline = true;
    let at = await openOn(A, id, 1);
    const a1 = await uiLine(A, at, 'pen', PEN.black, .2), a2 = await uiLine(A, at, 'hl', HL.yellow, .35), a3 = await uiNote(A, at, .15, .5, 'A says hold');
    await closeViewer(A);
    at = await openOn(B, id, 1);
    const b1 = await uiLine(B, at, 'pen', PEN.red, .65), b2 = await uiLine(B, at, 'hl', HL.green, .8), b3 = await uiNote(B, at, .55, .5, 'B says segue');
    await closeViewer(B);
    g.offline = false;
    assert(g.requests.length === n0, `drawing sent ${g.requests.length - n0} request(s) to Google`);
    for(const t of [A, B]) inkLocal(m, t.name, key, await pageOf(t, key));
    const s1 = await doSync(m, A, 'Sync A (its three marks)', {other: B});
    assert(marksCounts(s1.rep.text).sent === 1 && marksCounts(s1.rep.text).got === 0, 'Sync A: ' + s1.rep.text);
    const s2 = await doSync(m, B, 'Sync B (merges)', {other: A});
    assert(marksCounts(s2.rep.text).sent === 1 && marksCounts(s2.rep.text).got === 1, 'Sync B: ' + s2.rep.text);
    const s3 = await doSync(m, A, 'Sync A (gets B\'s)', {other: B});
    assert(marksCounts(s3.rep.text).sent === 0 && marksCounts(s3.rep.text).got === 1, 'Sync A again: ' + s3.rep.text);
    await upToDate(B, 'Sync B at rest'); await upToDate(A, 'Sync A at rest');
    await sameMarks(A, B, [key], 'at rest');
    const pa = await pageOf(A, key), pb = await pageOf(B, key), want = [a1, a2, a3, b1, b2, b3].map(s => s.id).sort();
    assert(JSON.stringify(liveIds(pa)) === JSON.stringify(want), `A holds ${liveIds(pa)} on the page, the union is ${want}`);
    for(const s of [a1, a2, a3, b1, b2, b3]) assert(JSON.stringify(entriesOf(pa).get(s.id)) === JSON.stringify(s), `a mark changed on its way: ${JSON.stringify(s)} -> ${JSON.stringify(entriesOf(pa).get(s.id))}`);
    assert(JSON.stringify(order(pa)) === JSON.stringify(order(pb)), `the two tablets draw the page in different orders: ${order(pa)} | ${order(pb)}`);
    const rel = (p, ids) => order(p).filter(x => ids.includes(x));
    for(const own of [[a1, a2, a3], [b1, b2, b3]].map(l => l.map(s => s.id))) assert(JSON.stringify(rel(pa, own)) === JSON.stringify(own), `one tablet's own marks are drawn in another order after the sync: ${rel(pa, own)} (drawn ${own})`);
    const d = readMarks(g).pages.get(key);
    assert(d && !byIdDiff(d, pa).length && d.updated >= Math.max(...d.strokes.map(s => s.updated)), 'Drive\'s file for the page does not hold the merged page');
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6b ---------- */
async function loopEdits(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const {b} = roles(await libraryOf(A));
    const [id] = await addCopies(A, 1, 'sb', {from: b.id}), key = id + ':1';
    await addEntries(A, id, 1, [penLine('s6b1', .25), penLine('s6b2', .45, PEN.blue), penLine('s6b3', .65, PEN.red), textNote('s6bn', .3, .85, 'Coda', {size: .028})]);
    finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B');
    const m = await seedModel(A, B), base = entriesOf(await pageOf(A, key));
    /* B: erases s6b2 first, then edits and moves the note */
    let at = await openOn(B, id, 1);
    const bErase = await uiErase(B, at, .45, 's6b2');
    later(bErase, base.get('s6b2'), 'B\'s erase');
    const edited = await uiEditNote(B, at, base.get('s6bn'), 'Coda, slower');
    later(edited, base.get('s6bn'), 'B\'s note edit');
    const moved = await uiMoveNote(B, at, edited, 60, -30);
    later(moved, edited, 'B\'s note move');
    await closeViewer(B);
    await sleep(30);
    /* A: erases s6b3; erases s6b2 too and takes that back with Undo (after B's erase) */
    at = await openOn(A, id, 1);
    const aErase3 = await uiErase(A, at, .65, 's6b3');
    const aErase2 = await uiErase(A, at, .45, 's6b2');
    const back = await uiUndo(A, at, 's6b2');
    later(back, aErase2, 'A\'s Undo'); later(back, bErase, 'A\'s Undo against B\'s earlier erase (the test needs it later)');
    assert(entriesOf(await pageOf(A, key)).get('s6b3').deleted, 'Undo brought back the wrong erase');
    await closeViewer(A);
    for(const t of [A, B]) inkLocal(m, t.name, key, await pageOf(t, key));
    await doSync(m, A, 'Sync A', {other: B}); await doSync(m, B, 'Sync B', {other: A}); await doSync(m, A, 'Sync A again', {other: B});
    await upToDate(B, 'Sync B at rest'); await upToDate(A, 'Sync A at rest');
    for(const t of [A, B]){
      const p = entriesOf(await pageOf(t, key));
      assert(JSON.stringify(p.get('s6b1')) === JSON.stringify(base.get('s6b1')), `${t.name}: the stroke nobody touched changed`);
      assert(JSON.stringify(p.get('s6b2')) === JSON.stringify(back), `${t.name}: the stroke brought back by Undo (later than B's erase) is ${JSON.stringify(p.get('s6b2'))}`);
      assert(p.get('s6b3') && p.get('s6b3').deleted && p.get('s6b3').updated === aErase3.updated, `${t.name}: A's erase did not win: ${JSON.stringify(p.get('s6b3'))}`);
      assert(JSON.stringify(p.get('s6bn')) === JSON.stringify(moved), `${t.name}: the note is not B's edited and moved one: ${JSON.stringify(p.get('s6bn'))}`);
    }
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6c ---------- */
async function loopBigPages(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const {a, b} = roles(await libraryOf(A));
    const [big] = await addCopies(A, 1, 'big', {from: b.id}), [mk, empty] = await addCopies(A, 2, 'one', {from: a.id});
    const t0 = Date.now() - 6e4;
    const strokes = Array.from({length: 400}, (_, i) => (i % 3 === 2 ? hlLine : penLine)(`h${String(i).padStart(3, '0')}`, Math.round((.03 + .94 * i / 400) * 1e4) / 1e4, i % 3 === 2 ? HL.yellow : PEN.black, {n: 12, updated: t0 + i}));
    const notes = Array.from({length: 12}, (_, i) => textNote(`n${String(i).padStart(2, '0')}`, .05 + (i % 3) * .3, .08 + Math.floor(i / 3) * .2, `Note ${i}: vamp ${i + 1} times`, {updated: t0 + 500 + i}));
    await addEntries(A, big, 1, strokes);
    await addEntries(A, big, 2, notes);
    const now = await clockOf(A);
    await putPage(A, mk + ':1', {updated: now, strokes: [{id: 'gone1', deleted: true, updated: now - 9}, {id: 'gone2', deleted: true, updated: now - 4}]});
    await putPage(A, empty + ':1', {updated: now, strokes: []});
    await putPage(A, big + ':5', {updated: now, strokes: [penLine('past', .5, PEN.black, {updated: now})]});
    const s1 = await syncRead(A);
    finished(s1, 'Sync A');
    const c1 = marksCounts(s1.text), D = readMarks(A.google);
    assert(!D.problems.length, 'Drive marks layout: ' + D.problems.join(' | '));
    assert(D.pages.has(big + ':1') && D.pages.has(big + ':2'), 'the 400-stroke page or the 12-note page did not reach Drive');
    assert(D.pages.has(mk + ':1'), 'a page of only deletion markers was not uploaded (the other tablet would keep the strokes)');
    assert(!D.pages.has(empty + ':1') && ![...D.files.values()].some(f => f.appProperties.id === empty), 'an empty page was uploaded');
    assert(!D.pages.has(big + ':5') && ![...D.files.values()].some(f => f.appProperties.id === big && f.appProperties.p === '5'), 'a page past the song\'s end (page 5 of 2) was uploaded');
    assert(c1.sent === 3, `the report says marks were sent on ${c1.sent} page(s), 3 expected: ${s1.text}`);
    await A.page.evaluate(async k => (await import('./js/store.js')).del('ink', k), big + ':5');      // the page past the end has done its job
    const m = await seedModel(A, B);
    const s2 = await doSync(m, B, 'Sync B (gets the big pages)');
    assert(marksCounts(s2.rep.text).got === 2, 'Sync B should say it got marks on the 2 pages it now draws (a page of only markers changes nothing drawn): ' + s2.rep.text);
    const ia = await inkOf(A), ib = await inkOf(B);
    for(const k of [big + ':1', big + ':2', mk + ':1']){
      assert(!byIdDiff(ia[k], ib[k]).length, `${k}: B's page differs from A's: ${byIdDiff(ia[k], ib[k]).slice(0, 3).join(' | ')}`);
      assert(JSON.stringify(order(ia[k])) === JSON.stringify(order(ib[k])), `${k}: the drawing order changed on the way`);
    }
    assert(liveIds(ib[big + ':1']).length === 400 && liveIds(ib[big + ':2']).length === 12 && markerIds(ib[mk + ':1']).join() === 'gone1,gone2', 'B does not hold 400 strokes, 12 notes and the 2 markers');
    assert(!ib[empty + ':1'] && !ib[big + ':5'], 'B holds the empty page or the page past the end');
    /* B adds a stroke and edits a note; A gets both */
    await addEntries(B, big, 1, [penLine('h400', .5, PEN.red)]);
    await editNote(B, big, 2, 'n05', {text: 'Note 5: vamp until cue'});
    for(const k of [big + ':1', big + ':2']) inkLocal(m, 'B', k, await pageOf(B, k));
    await doSync(m, B, 'Sync B (an edit)', {other: A});
    await doSync(m, A, 'Sync A (gets it)', {other: B});
    const pa = await inkOf(A);
    assert(liveIds(pa[big + ':1']).length === 401 && entriesOf(pa[big + ':2']).get('n05').text === 'Note 5: vamp until cue', 'A did not get B\'s stroke and note edit');
    await upToDate(B, 'Sync B at rest'); await upToDate(A, 'Sync A at rest');
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6d ---------- */
const U0 = () => Date.now() - 36e5;
const goodPage = (id, u, y = .5) => ({updated: u, strokes: [penLine(id, y, PEN.blue, {updated: u})]});
function deepText(u, depth){ return `{"updated":${u},"strokes":[{"id":"deep1","t":"pen","c":"#1a1a1a","w":0.003,"p":[[0.2,0.2],[0.4,0.4]],"updated":${u},"x6":${'['.repeat(depth)}${']'.repeat(depth)}}]}`; }
const hashOr = (f, alt) => { try{ return f(); }catch(e){ return alt; } };
async function loopHostile(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const g = A.google, R = roles(await libraryOf(A));
    const hs = await addCopies(A, 4, 'h', {from: R.c.id}), [del] = await addCopies(A, 1, 'z', {from: R.a.id});
    finished(await syncRead(A), 'Sync A (new songs)'); finished(await syncRead(B), 'Sync B (gets them)');
    const L0 = await libraryOf(B), T = id => titleIn(L0, id);
    await deleteSongUi(A, del);
    finished(await syncRead(A), 'Sync A (a deletion)');
    finished(await syncRead(B, {answers: {[T(del)]: 'delete'}}), 'Sync B (deletes it too)');
    assert((await libraryOf(B)).songs[del].deleted, 'the song to delete is still live on B (the test is wrong)');
    const hostileKeys = new Set();
    /* the name a report gives a song: its title before this run or after it (a record that came down in the same run) */
    const listed = (items, LB, id, p) => skippedPage(items, T(id), p) || skippedPage(items, LB.songs[id].title, p);
    const named = (items, LB, cases) => cases.filter(([id, p]) => !listed(items, LB, id, p)).map(([id, p]) => `"${LB.songs[id].title}: page ${p}: <reason>"`);
    const clean = async (t, what) => {
      const L = await libraryOf(t), bad = [...hostileIn(L), ...whole(L)];
      for(const k of hostileKeys) if(L.ink[k]) bad.push(`it holds ink ${k} from a hostile page`);
      assert(!bad.length, `${what}: ${t.name}: ${bad.slice(0, 6).join(' | ')}`);
    };
    /* batch 1 */
    let u = U0(), planted = [];
    const plant = (id, p, rec, o) => { planted.push(plantPage(g, id, p, rec, o)); hostileKeys.add(id + ':' + p); };
    const infText = `{"updated":${u},"strokes":[{"id":"inf1","t":"pen","c":"#1a1a1a","w":0.003,"p":[[0.2,0.2],[1e999,0.3]],"updated":${u}}]}`;
    plant(hs[0], 1, JSON.parse(infText), {text: infText});
    plant(hs[0], 2, null, {text: `{"updated":${u},"strokes":[{"id":"nan1","t":"pen","c":"#1a1a1a","w":0.003,"p":[[NaN,0.3]],"updated":${u}}]}`, props: {u: String(u), c: canonHash({nan: 1})}});
    const million = `{"updated":${u},"strokes":[{"id":"many1","t":"pen","c":"#1a1a1a","w":0.003,"p":[${'[0,0],'.repeat(1199999)}[0,0]],"updated":${u}}]}`;
    plant(hs[1], 1, null, {text: million, props: {u: String(u), c: canonHash(JSON.parse(million))}});
    const deep = deepText(u, 100000);
    plant(hs[1], 2, null, {text: deep, props: {u: String(u), c: hashOr(() => canonHash(JSON.parse(deep)), canonHash({deep: 1}))}});
    plant(hs[1], 3, goodPage('wu1', u), {props: {u: String(u + 7)}});
    plant(hs[2], 1, goodPage('wc1', u), {props: {c: canonHash({other: true})}});
    /* the songs and their good pages still sync: A edits one of them and marks page 3 */
    await saveSong(A, hs[0], {version: 'h 0 edited'});
    await addEntries(A, hs[0], 3, [penLine('good3', .5, PEN.red)]);
    const ra = await syncRead(A);
    finished(ra, 'Sync A (hostile pages on Drive)');
    const rb = await syncRead(B);
    finished(rb, 'Sync B (hostile pages on Drive)');
    const LB = await libraryOf(B);
    assert(LB.songs[hs[0]].version === 'h 0 edited', 'the song with hostile pages did not get its record change');
    assert(liveIds(LB.ink[hs[0] + ':3']).join() === 'good3', 'the good page of the song with hostile pages did not arrive: ' + JSON.stringify(LB.ink[hs[0] + ':3']));
    const cases1 = [[hs[0], 1], [hs[0], 2], [hs[1], 1], [hs[1], 2], [hs[1], 3], [hs[2], 1]];
    const TB = id => LB.songs[id].title;
    for(const [items, who] of [[rb.items, 'B'], [ra.items, 'A']]){
      const out = named(items, LB, cases1);
      assert(!out.length, `${who}: the report does not list ${out.join(', ')} as skipped: ${JSON.stringify(items).slice(0, 900)}`);
    }
    await clean(A, 'after batch 1'); await clean(B, 'after batch 1');
    assert(/Got 1 song/.test(rb.text) && marksCounts(rb.text).got === 1, 'B\'s report does not say it got the song and its good page: ' + rb.text);
    for(const f of planted) if(g.files.has(f)) removeDriveFile(g, f);
    /* batch 2 */
    planted = []; u = U0();
    const point = '[0.123456789012345,0.987654321098765]';
    const bigText = `{"updated":${u},"strokes":[${[0, 1, 2, 3].map(i => `{"id":"big${i}","t":"pen","c":"#1a1a1a","w":0.003,"p":[${Array(150000).fill(point).join(',')}],"updated":${u}}`).join(',')}]}`;
    assert(bigText.length > 20e6, 'the big file is not over 20 MB (the test is wrong)');
    plant(hs[2], 2, null, {text: bigText, props: {u: String(u), c: canonHash(JSON.parse(bigText))}});
    plant(hs[2], 3, null, {text: `{"updated":${u},"strokes":[{"id":"cut1","t":"pen",`, props: {u: String(u), c: canonHash({cut: 1})}});
    plant(hs[3], 7, goodPage('p7', u));
    plant('nosuchsong6', 1, goodPage('ghost1', u));
    plant(del, 1, goodPage('dead1', u));
    const lots = {updated: u, strokes: Array.from({length: 50001}, (_, i) => ({id: 'm' + i, t: 'pen', c: '#1a1a1a', w: .003, p: [[0, 0]], updated: u}))};
    plant(hs[3], 1, lots);
    await addEntries(A, hs[3], 2, [penLine('good32', .3, PEN.red)]);
    const ra2 = await syncRead(A);
    finished(ra2, 'Sync A (batch 2 on Drive)');
    g.clearLog(); await takeWrites(B);
    const rb2 = await syncRead(B);
    finished(rb2, 'Sync B (batch 2 on Drive)');
    const L2 = await libraryOf(B);
    assert(liveIds(L2.ink[hs[3] + ':2']).join() === 'good32', 'the good page next to the hostile ones did not arrive');
    const cases2 = [[hs[2], 2], [hs[2], 3], [hs[3], 7], [hs[3], 1]];
    for(const [items, who] of [[rb2.items, 'B'], [ra2.items, 'A']]){
      const out = named(items, LB, cases2);
      assert(!out.length, `${who}: the report does not list ${out.join(', ')} as skipped: ${JSON.stringify(items).slice(0, 900)}`);
      const p1 = items.filter(s => /: page 1: \S/.test(s) && !s.startsWith(TB(hs[3]) + ':'));
      assert(p1.length >= 1, `${who}: the page of an unknown song is not listed as skipped: ${JSON.stringify(items).slice(0, 600)}`);
      const deadFile = planted.find(f => g.files.has(f) && g.files.get(f).appProperties.id === del);
      assert(!deadFile || p1.length >= 2, `${who}: the page planted for a deleted song is neither listed nor removed from Drive`);
    }
    await clean(A, 'after batch 2'); await clean(B, 'after batch 2');
    for(const [k, v] of Object.entries(L2.ink)) assert(!JSON.stringify(v).includes('ghost1') && !JSON.stringify(v).includes('dead1') && !JSON.stringify(v).includes('"p7"'), `B stored a mark from a page it should have skipped (${k})`);
    assert(!L2.songs.nosuchsong6 && L2.songs[del].deleted, 'a page brought a song with it, or revived the deleted one');
    /* again: the same pages are skipped again, the run finishes, nothing is written for them */
    const rb3 = await syncRead(B);
    finished(rb3, 'Sync B again');
    const w3 = (await takeWrites(B)).filter(w => w.store === 'ink' && hostileKeys.has(w.key));
    assert(!w3.length, 'B wrote hostile pages: ' + JSON.stringify(w3.slice(0, 4)));
    assert(skippedPage(rb3.items, TB(hs[3]), 1), 'the second Sync does not list the hostile page again');
    await clean(B, 'after the second Sync');
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6e ---------- */
async function loopNewVersion(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const {b} = roles(await libraryOf(A));
    await addEntries(A, b.id, 2, [penLine('nv2', .4, PEN.red)]);
    finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B');
    const m = await seedModel(A, B);
    await addEntries(B, b.id, 1, [penLine('nvB', .9, PEN.blue)]);                      // on the OLD chart, not synced yet
    inkLocal(m, 'B', b.id + ':1', await pageOf(B, b.id + ':1'));
    const oldLive = {1: liveIds(await pageOf(A, b.id + ':1')), 2: liveIds(await pageOf(A, b.id + ':2'))};
    const pdf = await makePdf(3, 'sync6-new-chart.pdf');
    const inkBefore = await inkOf(A), songsBefore = (await libraryOf(A)).songs;
    await newVersionUi(A, b.id, pdf.file);
    const LA0 = await libraryOf(A), copy = live(LA0).find(s => !songsBefore[s.id] && s.archived && s.hash === b.hash);
    assert(copy && LA0.files[b.id] === pdf.hash, 'New version did not make an archived copy and take the new chart (the test is wrong)');
    const nv = inkNewVersion(m, 'A', b.id, copy.id, inkBefore, LA0.ink, 3);
    assert(!nv.length, nv.join(' | '));
    await doSync(m, A, 'Sync A (New version)', {other: B});
    await doSync(m, B, 'Sync B (gets the new chart)', {other: A});
    await doSync(m, A, 'Sync A (gets B\'s old mark on the archived copy)', {other: B});
    await doSync(m, B, 'Sync B (at rest)', {other: A});
    for(const t of [A, B]){
      const L = await libraryOf(t), holders = live(L).filter(s => s.hash === b.hash);
      assert(holders.length === 1 && holders[0].id === copy.id && holders[0].archived, `${t.name}: the old chart is held by ${JSON.stringify(holders.map(s => [s.id, s.version, s.archived]))}, expected only the archived copy ${copy.id}`);
      assert(L.files[b.id] === pdf.hash && L.songs[b.id].pages === 3, `${t.name}: the song does not have the new chart`);
      assert(JSON.stringify(liveIds(L.ink[copy.id + ':1'])) === JSON.stringify([...oldLive[1], 'nvB'].sort()), `${t.name}: the archived copy's page 1 holds ${liveIds(L.ink[copy.id + ':1'])}, expected the old marks ${oldLive[1]} and B's nvB`);
      assert(JSON.stringify(liveIds(L.ink[copy.id + ':2'])) === JSON.stringify(oldLive[2]), `${t.name}: the archived copy's page 2 holds ${liveIds(L.ink[copy.id + ':2'])}, expected ${oldLive[2]}`);
      for(const p of [1, 2, 3]) assert(!liveIds(L.ink[b.id + ':' + p]).length, `${t.name}: the new chart has marks on page ${p}: ${liveIds(L.ink[b.id + ':' + p])}`);
    }
    await sameMarks(A, B, [copy.id + ':1', copy.id + ':2', b.id + ':1', b.id + ':2'], 'after New version');
    /* a mark on the new chart goes both ways; the archived copy stays */
    await addEntries(B, b.id, 3, [penLine('fresh3', .5, PEN.black)]);
    inkLocal(m, 'B', b.id + ':3', await pageOf(B, b.id + ':3'));
    await doSync(m, B, 'Sync B (a mark on the new chart)', {other: A});
    await doSync(m, A, 'Sync A (gets it)', {other: B});
    assert(liveIds(await pageOf(A, b.id + ':3')).join() === 'fresh3', 'A did not get the mark on the new chart');
    await upToDate(B, 'Sync B at rest'); await upToDate(A, 'Sync A at rest');
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6f ---------- */
async function loopClockBehind(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const {b} = roles(await libraryOf(A));
    const [id] = await addCopies(A, 1, 'sf', {from: b.id}), key = id + ':1';
    finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B');
    await setClock(B, -2 * HOUR);
    let at = await openOn(A, id, 1);
    const s = await uiLine(A, at, 'pen', PEN.red, .3), n = await uiNote(A, at, .3, .7, 'Hold');
    await closeViewer(A);
    const m = await seedModel(A, B);
    inkLocal(m, 'A', key, await pageOf(A, key));
    await doSync(m, A, 'Sync A (marks made on the clock that is ahead)', {other: B});
    await doSync(m, B, 'Sync B (clock 2 hours behind) gets them', {other: A});
    const bNow = await clockOf(B);
    assert(bNow < s.updated && bNow < n.updated, `B's clock (${bNow}) is not behind the marks' times (${s.updated}) (the test is wrong)`);
    at = await openOn(B, id, 1);
    const mk = await uiErase(B, at, .3, s.id);
    later(mk, s, 'B\'s erase on a clock 2 hours behind');
    const ed = await uiEditNote(B, at, n, 'Hold longer');
    later(ed, n, 'B\'s note edit on a clock 2 hours behind');
    await closeViewer(B);
    inkLocal(m, 'B', key, await pageOf(B, key));
    await doSync(m, B, 'Sync B (its erase and edit)', {other: A});
    await doSync(m, A, 'Sync A (gets them)', {other: B});
    for(const t of [A, B]){
      const p = entriesOf(await pageOf(t, key));
      assert(JSON.stringify(p.get(s.id)) === JSON.stringify(mk), `${t.name}: B's erase lost: ${JSON.stringify(p.get(s.id))}`);
      assert(JSON.stringify(p.get(n.id)) === JSON.stringify(ed), `${t.name}: B's note edit lost: ${JSON.stringify(p.get(n.id))}`);
    }
    /* and back: A edits the note again */
    await editNote(A, id, 1, n.id, {text: 'Hold, then go'});
    inkLocal(m, 'A', key, await pageOf(A, key));
    await doSync(m, A, 'Sync A (edits again)', {other: B});
    await doSync(m, B, 'Sync B (gets it)', {other: A});
    assert(entriesOf(await pageOf(B, key)).get(n.id).text === 'Hold, then go', 'B did not get A\'s later edit');
    await upToDate(B, 'Sync B at rest'); await upToDate(A, 'Sync A at rest');
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6g ---------- */
async function loopRestorePrint(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const {b} = roles(await libraryOf(A)), key = b.id + ':1';
    await addEntries(A, b.id, 1, [penLine('pr1', .12, PEN.red), hlLine('pr2', .75, HL.yellow), hlLine('pr3', .62, HL.green)]);
    await addEntries(B, b.id, 1, [penLine('pb1', .9, PEN.blue)]);
    finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B'); finished(await syncRead(A), 'Sync A again');
    await eraseIds(B, b.id, 1, ['pr2']);
    finished(await syncRead(B), 'Sync B (an erase)'); finished(await syncRead(A), 'Sync A (gets it)');
    await sameMarks(A, B, [key], 'before the print');
    const p = entriesOf(await pageOf(A, key));
    assert(!p.get('pr1').deleted && !p.get('pb1').deleted && !p.get('pr3').deleted && p.get('pr2').deleted, 'A does not hold the marks the print needs: ' + JSON.stringify([...p.keys()]));
    /* print the setlist "Rehearsal" (Fixture Alpha, then the two-page song): its page 2 is the marked page, uncropped */
    const pdf = await printSetPdf(A, 'Rehearsal');
    const look = await renderBoxes(A, pdf, 1, [
      {c: PEN.red, region: [0, .07, 1, .17]}, {c: PEN.blue, region: [0, .85, 1, .95]},
      {c: HL.green, aMin: .3, aMax: .5, tol: 10, region: [0, .57, 1, .67]}, {c: HL.yellow, aMin: .3, aMax: .5, tol: 10, region: [0, .7, 1, .8]}]);
    const [red, blue, green, yellow] = look.boxes, near = (x, y) => Math.abs(x - y) <= .03;
    assert(look.pages === 3, `the printed setlist has ${look.pages} pages, 3 expected`);
    assert(red.n && near(red.x0, .2) && near(red.x1, .8) && near((red.y0 + red.y1) / 2, .12), 'A\'s red stroke is not on the printed page where it was drawn: ' + JSON.stringify(red));
    assert(blue.n && near(blue.x0, .2) && near(blue.x1, .8) && near((blue.y0 + blue.y1) / 2, .9), 'B\'s blue stroke (synced) is not on the printed page: ' + JSON.stringify(blue));
    assert(green.n && near(green.x0, .2) && near(green.x1, .8), 'the green highlighter is not on the printed page: ' + JSON.stringify(green));
    assert(!yellow.n, 'the highlighter erased on B is printed on A: ' + JSON.stringify(yellow));
    /* Back up -> wipe -> Restore on B: the same marks; then a Sync with nothing to do */
    const before = normalise(await snapshot(B.page));
    const bk = await backupNow(B.page);
    await wipe(B.page); await B.s.goto('');
    await B.page.waitForSelector('#libList');
    assert(!Object.keys(await idbAll(B.page, 'ink')).length, 'the wipe left marks (the test is wrong)');
    await restoreZip(B.page, bk.file);
    const after = normalise(await snapshot(B.page)), d = diff(before.ink, after.ink);
    assert(!d.length, 'the marks after Back up -> wipe -> Restore differ: ' + d.join(' | '));
    await sameMarks(A, B, Object.keys(after.ink), 'after the restore');
    await upToDate(B, 'Sync B after the restore');
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6h ---------- */
async function loopCut(ctx){
  const A = await startA(ctx);
  const opened = [];
  try{
    const {b} = roles(await libraryOf(A));
    const ids = await addCopies(A, 6, 'cut', {from: b.id});
    for(const [i, id] of ids.entries()) for(const p of [1, 2]) await addEntries(A, id, p, [penLine(`c${i}p${p}a`, .3, PEN.red), textNote(`c${i}p${p}n`, .2, .7, `Cut ${i} page ${p}`)]);
    finished(await syncTap(A), 'Sync A (everything up)');
    const g = A.google;
    for(const how of ['reload', 'stop', 'offline']){
      const B = await openTablet(ctx, {name: 'B' + how, share: A}); opened.push(B);
      g.latency = 120;
      await tapSync(B);
      const end = Date.now() + 90000;
      for(;;){
        const n = Object.values(await idbAll(B.page, 'songs').catch(() => ({}))).filter(s => !s.deleted).length;
        if(n >= 2) break;
        if(Date.now() > end) throw new Error(`${how}: B never stored 2 songs`);
        await sleep(30);
      }
      if(how === 'reload'){ await B.page.reload(); await B.page.waitForSelector('#libList'); }
      else if(how === 'stop'){ await B.page.locator('.modal').last().getByRole('button', {name: 'Stop', exact: true}).click(); g.latency = 0; const r = await finishSync(B); assert(r.state === 'stopped', `${how}: the report is ${r.title}`); }
      else { g.offline = true; const r = await finishSync(B); g.offline = false; assert(r.state === 'failed', `${how}: the report is ${r.title}`); }
      g.latency = 0;
      await sleep(500);
      const L = await libraryOf(B), D = readMarks(g), songs = live(L), bad = [...whole(L)];
      for(const s of songs) for(const [k, page] of D.pages) if(splitKey(k).id === s.id){ const dd = byIdDiff(page, L.ink[k], {la: 'Drive', lb: 'B'}); if(dd.length) bad.push(`"${s.title}" is on B without its marks ${k} (${dd.slice(0, 2).join('; ')})`); }
      assert(!bad.length, `${how}: after the cut and a reload, a song is half there: ${bad.slice(0, 5).join(' | ')}`);
      const all = [...readDrive(g).recs.song.values()].filter(s => !s.deleted).length;
      assert(songs.length >= 1 && songs.length < all, `${how}: the cut came ${songs.length ? 'after every song arrived' : 'before any song arrived'} (${songs.length} of ${all}): the test did not cut mid-download`);
      if(how === 'reload') await B.page.reload(), await B.page.waitForSelector('#libList');
      await takeWrites(B);
      finished(await syncTap(B), `${how}: the next Sync`);
      const writes = await takeWrites(B), apart = [...marksApart(writes, D.pages), ...halfSongs(writes)];
      assert(!apart.length, `${how}: ${apart.slice(0, 4).join(' | ')}`);
      const L2 = await libraryOf(B);
      for(const [k, page] of D.pages){ const dd = byIdDiff(page, L2.ink[k], {la: 'Drive', lb: 'B'}); assert(!dd.length, `${how}: after the next Sync B's page ${k} differs from Drive's: ${dd.slice(0, 3).join(' | ')}`); }
      assert(!whole(L2).length, `${how}: ${whole(L2).join(' | ')}`);
      noErrors(B);
      await B.close(); opened.pop();
    }
  } finally { await closeAll(A, ...opened); }
}

/* ---------- 6i ---------- */
async function loopDeleted(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const g = A.google, {b} = roles(await libraryOf(A)), title = b.title;
    await addEntries(A, b.id, 2, [penLine('del2', .5, PEN.red)]);
    finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B');
    const onDrive = () => [...g.files.values()].filter(f => !f.trashed && f.appProperties.k === 'ink' && f.appProperties.id === b.id);
    assert(onDrive().length === 2, 'the song\'s two pages are not on Drive before the test (the test is wrong)');
    await deleteSongUi(A, b.id);
    finished(await syncRead(A), 'Sync A (the song deleted)');
    assert(!onDrive().length, `the deleted song's ink files are still on Drive: ${onDrive().map(f => f.name).join(', ')}`);
    /* a page for it planted later (a cut-off run elsewhere) never brings it back, and is removed */
    const u = Date.now();
    plantPage(g, b.id, 1, goodPage('ghost', u));
    const r2 = await syncRead(A);
    finished(r2, 'Sync A (a page for the deleted song on Drive)');
    let LA = await libraryOf(A);
    assert(LA.songs[b.id].deleted && !Object.keys(LA.ink).some(k => k.startsWith(b.id + ':')), 'a page on Drive brought marks of the deleted song back, or the song');
    assert(!onDrive().length, 'the page planted for the deleted song was not removed from Drive');
    /* B: a mark on the song before it hears of the deletion; Delete here */
    await addEntries(B, b.id, 2, [penLine('late', .7, PEN.blue)]);
    const r3 = await syncRead(B, {answers: {[title]: 'delete'}});
    finished(r3, 'Sync B (Delete here)');
    const LB = await libraryOf(B);
    assert(LB.songs[b.id].deleted && !Object.keys(LB.ink).some(k => k.startsWith(b.id + ':')), 'B kept marks of the song it deleted');
    assert(!onDrive().length, `B uploaded marks of a song it deleted: ${onDrive().map(f => f.name).join(', ')}`);
    finished(await syncRead(A), 'Sync A after');
    LA = await libraryOf(A);
    assert(LA.songs[b.id].deleted && !Object.keys(LA.ink).some(k => k.startsWith(b.id + ':')) && !onDrive().length, 'the deleted song\'s marks came back');
    for(const t of [A, B]) assert(!whole(await libraryOf(t)).length, `${t.name}: ${whole(await libraryOf(t)).join(' | ')}`);
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6j ---------- */
async function loopIdle(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const g = A.google, {a, b} = roles(await libraryOf(A));
    const googleUrls = t => t.s.requests.filter(u => /google/i.test(new URL(u).hostname));
    const marks = [A, B].map(t => ({t, g: g.requests.length, u: googleUrls(t).length}));
    const quiet = what => { for(const x of marks){ const extra = [...g.requests.slice(x.g).map(e => e.by + ' ' + e.method + ' ' + e.path), ...googleUrls(x.t).slice(x.u)]; assert(!extra.length, `${what}: ${extra.length} request(s) left for Google without a tap: ${extra.slice(0, 5).join(', ')}`); } };
    await addEntries(A, b.id, 2, [penLine('idleA', .4, PEN.red)]);
    await addEntries(B, a.id, 1, [penLine('idleB', .5, PEN.blue)]);
    let at = await openOn(A, b.id, 1); await uiLine(A, at, 'pen', PEN.black, .92); await closeViewer(A);
    at = await openOn(B, b.id, 1); await uiNote(B, at, .6, .1, 'Idle note'); await closeViewer(B);
    for(const t of [A, B]){
      for(let i = 0; i < 3; i++){ await t.page.click('#tSets'); await sleep(120); await t.page.click('#tLib'); await sleep(120); }
      await t.page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true})); dispatchEvent(new Event('focus')); dispatchEvent(new Event('online')); });
    }
    await sleep(3000);
    quiet('marks made on both tablets, signed in, idle');
    /* the reminder offers Sync (marks are synced now, so they are a change since the last sync) and does nothing by itself */
    await A.page.click('#tSets'); await A.page.click('#tLib');
    await A.page.waitForSelector('#libNudge [data-syncnow]', {timeout: 8000}).catch(() => { throw new Error('after new marks the reminder does not offer Sync (marks are a change since the last sync now)'); });
    await sleep(2500);
    quiet('the reminder line with its Sync button');
    await A.page.click('#libNudge [data-syncnow]');
    const r = await finishSync(A);
    assert(r.state === 'finished' && marksCounts(r.text).sent === 2, 'the reminder\'s Sync did not send the marks on 2 pages: ' + r.text);
    await A.page.click('#tLib'); await sleep(400);
    assert(!(await A.page.locator('#libNudge [data-syncnow]').count()), 'the reminder still offers Sync after the marks were synced');
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- a pair whose Drive has no marks yet (Part 2 libraries: the Marks folder is made at the first page to send) ---------- */
export const marksFolders = google => [...google.files.values()].filter(f => !f.trashed && f.mimeType === 'application/vnd.google-apps.folder' && f.appProperties.setlistStand === 'ink');
export const bare = lib => ({a: songBy(lib, 'Fixture Alpha'), b: songBy(lib, 'two-page')});
export const inkFiles = google => [...google.files.values()].filter(f => !f.trashed && f.appProperties.k === 'ink');
export async function pairNoMarks(ctx){
  const A = await startA(ctx);
  let B = null;
  try{
    await A.page.evaluate(async () => { const st = await import('./js/store.js'); for(const s of st.state.songs) await st.delInkFor(s.id); });
    assert(!Object.keys(await inkOf(A)).length, 'the marks of the test library could not be removed (the test is wrong)');
    finished(await syncTap(A), 'the first Sync on A (no marks)');
    B = await makeFromBackup(ctx, A);
    finished(await syncTap(B), 'the first Sync on B (no marks)');
    await watchReports(A); await watchReports(B);
    return {A, B};
  }catch(e){ await closeAll(A, B); throw e; }
}

/* ---------- 6k: Drive full at the first sync that has marks to send and songs to get ---------- */
async function loopFull(ctx){
  const {A, B} = await pairNoMarks(ctx);
  try{
    const g = A.google, {a, b} = bare(await libraryOf(A));
    const news = await addCopies(A, 2, 'full', {from: b.id});
    finished(await syncRead(A), 'Sync A (two new songs, still no marks)');
    assert(!marksFolders(g).length, 'a run with no marks to send made the Marks folder');
    await addEntries(B, b.id, 1, [penLine('full1', .3, PEN.red)]);
    await addEntries(B, a.id, 1, [textNote('full2', .2, .6, 'Sent when there is room')]);
    g.quotaFull = true;
    await takeWrites(B);
    const r1 = await syncRead(B);
    g.quotaFull = false;
    assert(r1.state === 'failed' && /Your Google Drive is full/.test(r1.text), `a full Drive should end the run with "Your Google Drive is full": ${r1.title}: ${r1.text.slice(0, 300)}`);
    const writes = await takeWrites(B), half = [...halfSongs(writes), ...marksApart(writes, readMarks(g).pages)];
    assert(!half.length, 'Drive full: ' + half.join(' | '));
    const L1 = await libraryOf(B);
    assert(news.every(id => L1.songs[id] && !L1.songs[id].deleted && L1.files[id] === L1.songs[id].hash), 'the songs that could come down did not, before Drive was found full: ' + news.filter(id => !L1.songs[id]).join(', '));
    assert(!whole(L1).length, 'Drive full: ' + whole(L1).join(' | '));
    assert(liveIds(L1.ink[b.id + ':1']).includes('full1') && liveIds(L1.ink[a.id + ':1']).includes('full2'), 'the marks waiting to be sent were lost on B');
    const mf = marksFolders(g);
    assert(mf.length <= 1 && !inkFiles(g).length, `Drive full: ${mf.length} Marks folders and ${inkFiles(g).length} ink files left behind`);
    assert(!readDrive(g).problems.length, 'Drive full: ' + readDrive(g).problems.join(' | '));
    /* room again: the next Sync sends the marks; A gets them */
    const m = await seedModel(A, B);
    const r2 = await doSync(m, B, 'Sync B (room again)', {other: A});
    assert(marksCounts(r2.rep.text).sent === 2, 'B did not send its marks on 2 pages: ' + r2.rep.text);
    assert(marksFolders(g).length === 1, `${marksFolders(g).length} Marks folders after the marks were sent`);
    await doSync(m, A, 'Sync A (gets them)', {other: B});
    await sameMarks(A, B, [b.id + ':1', a.id + ':1'], 'after Drive had room again');
    await upToDate(B, 'Sync B at rest'); await upToDate(A, 'Sync A at rest');
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6l: a run with no marks to send never makes the Marks folder ---------- */
async function loopNoFolder(ctx){
  const {A, B} = await pairNoMarks(ctx);
  try{
    const g = A.google, {a} = bare(await libraryOf(A));
    assert(!marksFolders(g).length && !inkFiles(g).length, 'the first Syncs of a library with no marks made the Marks folder');
    await saveSong(A, a.id, {version: 'a change, no marks'});
    finished(await syncRead(A), 'Sync A (a record change)'); finished(await syncRead(B), 'Sync B (gets it)');
    /* a page with no entries is no page to send */
    await putPage(B, a.id + ':1', {updated: Date.now(), strokes: []});
    finished(await syncRead(B), 'Sync B (an empty page)');
    assert(!marksFolders(g).length && !inkFiles(g).length, 'a run with no marks to send made the Marks folder or an ink file');
    assert(!g.requests.some(e => e.method === 'POST' && /Marks/.test(e.body || '')), 'a request to make the Marks folder was sent');
    /* the first mark: one folder, made once */
    await addEntries(A, a.id, 1, [penLine('first1', .5)]);
    finished(await syncRead(A), 'Sync A (the first mark)'); finished(await syncRead(B), 'Sync B (gets it)');
    await addEntries(B, a.id, 1, [penLine('first2', .6)]);
    finished(await syncRead(B), 'Sync B (a second mark)');
    assert(marksFolders(g).length === 1 && !readDrive(g).problems.length, `${marksFolders(g).length} Marks folders: ${readDrive(g).problems.join(' | ')}`);
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6m: marks never cross charts: they go up only while Drive holds the song's own chart ---------- */
async function loopCross(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const g = A.google, {b} = roles(await libraryOf(A)), k1 = b.id + ':1';
    const drive0 = readMarks(g).pages.get(k1);
    assert(drive0 && liveIds(drive0).length, 'the two-page song has no marks on Drive (the test is wrong)');
    const pdf = await makePdf(2, 'sync6-cross.pdf');
    await newVersionUi(B, b.id, pdf.file);
    await addEntries(B, b.id, 1, [penLine('onnew1', .4, PEN.blue)]);                 // a mark on the NEW chart
    const pf = readDrive(g).pdfs.get(b.id).fileId;
    /* Google refuses that one file (400: not retried, the run goes on without it), so the run reaches the marks with Drive still
       holding the old chart */
    g.failNext(400, {reason: 'badRequest', times: 1000, match: e => e.kind === 'upload' && e.path.includes(pf)});
    const r1 = await syncRead(B);
    g.faults.length = 0;
    assert(r1.state === 'finished' && /Skipped/.test(r1.text), 'the new chart\'s upload was refused: the run should finish and list it as skipped: ' + r1.text);
    assert(readDrive(g).pdfs.get(b.id).hash === b.hash, 'the new chart reached Drive although its upload was refused (the test is wrong)');
    const d1 = readMarks(g).pages.get(k1);
    assert(!byIdDiff(drive0, d1).length, `marks of the new chart went up while Drive still holds the old chart: ${byIdDiff(drive0, d1, {la: 'before', lb: 'after'}).slice(0, 3).join(' | ')}`);
    finished(await syncRead(A), 'Sync A (Drive still has the old chart)');
    const LA = await libraryOf(A);
    assert(!liveIds(LA.ink[k1]).includes('onnew1') && JSON.stringify(liveIds(LA.ink[k1])) === JSON.stringify(liveIds(drive0)), 'A\'s old chart took a mark made on the new chart, or lost its own: ' + liveIds(LA.ink[k1]));
    /* the chart goes up: then the marks follow it, and the old marks stay with the old chart */
    finished(await syncRead(B), 'Sync B (the upload works now)');
    finished(await syncRead(A), 'Sync A (gets the new chart)');
    const L2 = await libraryOf(A), copy = live(L2).find(s => s.archived && s.hash === b.hash);
    assert(L2.files[b.id] === pdf.hash && liveIds(L2.ink[k1]).join() === 'onnew1', 'A\'s new chart does not have exactly the mark made on it: ' + liveIds(L2.ink[k1]));
    assert(copy && JSON.stringify(liveIds(L2.ink[copy.id + ':1'])) === JSON.stringify(liveIds(drive0)), 'the old chart\'s marks are not on its archived copy on A');
    finished(await syncRead(B), 'Sync B (at rest)');
    await sameMarks(A, B, [k1, copy.id + ':1'], 'after the chart went up');
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6n: the run that puts a new, shorter chart on Drive removes the old chart's pages past its end ---------- */
async function loopShorter(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const g = A.google, {c} = roles(await libraryOf(A));
    const [id] = await addCopies(A, 1, 'short', {from: c.id});                      // three pages, live
    for(const p of [1, 2, 3]) await addEntries(A, id, p, [penLine(`sh${p}`, .5, PEN.red)]);
    finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B');
    const pagesOn = () => [...readMarks(g).pages.keys()].filter(k => splitKey(k).id === id).sort();
    assert(pagesOn().length === 3, 'the three pages are not on Drive (the test is wrong)');
    const pdf = await makePdf(1, 'sync6-shorter.pdf');
    await newVersionUi(A, id, pdf.file);
    const copy = live(await libraryOf(A)).find(s => s.archived && s.hash === c.hash && s.id !== c.id && s.id !== id);
    finished(await syncRead(A), 'Sync A (a one-page chart)');
    assert(JSON.stringify(pagesOn()) === JSON.stringify([id + ':1']), `after the one-page chart went up, Drive holds the pages ${pagesOn()} of the song (pages 2 and 3 of the old chart should be gone)`);
    assert(!readDrive(g).problems.length, readDrive(g).problems.join(' | '));
    finished(await syncRead(B), 'Sync B (gets the new chart)');
    for(const t of [A, B]){
      const L = await libraryOf(t);
      assert(!L.ink[id + ':2'] && !L.ink[id + ':3'] && !liveIds(L.ink[id + ':1']).length, `${t.name}: the one-page chart still has the old chart's marks`);
      for(const p of [1, 2, 3]) assert(liveIds(L.ink[copy.id + ':' + p]).join() === `sh${p}`, `${t.name}: the archived copy's page ${p} lost its mark`);
    }
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6o: a Drive page that changes between the read and the write is not written over ---------- */
async function loopRace(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const g = A.google, {b} = roles(await libraryOf(A)), key = b.id + ':1';
    const fid = readMarks(g).files.get(key).id;
    await addEntries(B, b.id, 1, [penLine('mineB', .8, PEN.blue)]);
    /* right after B has read Drive's page, the other tablet's run puts a new version there (a stroke 'conc1') */
    let phase = 0;
    const mutate = () => {
      const f = g.files.get(fid), page = JSON.parse(f.content.toString('utf8')), u = Date.now();
      page.strokes.push(penLine('conc1', .1, PEN.red, {updated: u})); page.updated = Math.max(page.updated + 1, u);
      Object.assign(f, {content: Buffer.from(JSON.stringify(page)), modifiedTime: new Date().toISOString()});
      Object.assign(f.appProperties, {u: String(page.updated), c: canonHash(page)});
    };
    g.failNext(599, {times: 1, match: e => {
      if(phase === 0 && e.kind === 'download' && e.path.endsWith(fid)){ phase = 1; return false; }
      if(phase === 1 && e.by === 'B' && e.kind !== 'preflight'){ phase = 2; mutate(); }
      return false;
    }});
    const r1 = await syncRead(B);
    g.faults.length = 0;
    finished(r1, 'Sync B (the page changes on Drive meanwhile)');
    assert(phase === 2, 'B never read the page from Drive (the test is wrong)');
    const d1 = readMarks(g).pages.get(key);
    assert(liveIds(d1).includes('conc1'), `B's upload wrote over a Drive page that had changed since B read it: the other tablet's stroke is gone (${liveIds(d1)})`);
    finished(await syncRead(B), 'Sync B again (merges both)');
    finished(await syncRead(A), 'Sync A');
    for(const t of [A, B]){ const ids = liveIds(await pageOf(t, key)); assert(ids.includes('conc1') && ids.includes('mineB'), `${t.name} does not hold both versions' marks: ${ids}`); }
    const d2 = readMarks(g).pages.get(key);
    assert(liveIds(d2).includes('conc1') && liveIds(d2).includes('mineB'), 'Drive does not hold both: ' + liveIds(d2));
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6p: New version of a Copy song: its old marks go to its own archived copy, never onto another song with the same PDF ---------- */
async function loopCopyHolder(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const {c} = roles(await libraryOf(A));                                          // archived, three pages
    const [cp] = await addCopies(A, 1, 'hold', {from: c.id});                       // a live copy of it: the same PDF
    await addEntries(A, cp, 1, [penLine('cpm1', .5, PEN.red)]);
    finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B');
    const cBefore = {A: liveIds(await pageOf(A, c.id + ':1')), B: liveIds(await pageOf(B, c.id + ':1'))};
    const pdf = await makePdf(3, 'sync6-copy-holder.pdf'), before = (await libraryOf(A)).songs;
    await newVersionUi(A, cp, pdf.file);
    const copy = live(await libraryOf(A)).find(s => !before[s.id] && s.archived && s.hash === c.hash);
    assert(copy, 'New version made no archived copy (the test is wrong)');
    finished(await syncRead(A), 'Sync A (New version)'); finished(await syncRead(B), 'Sync B (gets it)'); finished(await syncRead(A), 'Sync A again');
    for(const t of [A, B]){
      const L = await libraryOf(t);
      assert(JSON.stringify(liveIds(L.ink[c.id + ':1'])) === JSON.stringify(cBefore[t.name]), `${t.name}: the song "${c.title}", which only shares the PDF, took marks of the chart that was replaced: ${liveIds(L.ink[c.id + ':1'])} (it had ${cBefore[t.name]})`);
      assert(liveIds(L.ink[copy.id + ':1']).join() === 'cpm1', `${t.name}: the archived copy made by New version does not hold the old marks: ${liveIds(L.ink[copy.id + ':1'])}`);
      assert(!liveIds(L.ink[cp + ':1']).length, `${t.name}: the new chart kept the old marks`);
    }
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

export const loops = [
  {name: loopName('a', 'pen, highlighter and notes on the same page on both tablets, drawn offline: after Sync A, B, A both hold the union by id, the model agrees, the report counts the pages, then everything is up to date'), run: loopSamePage},
  {name: loopName('b', 'a note edited and moved on one tablet, a stroke erased on the other, and an erase undone after the other tablet erased the same stroke: the newer entry wins on both'), run: loopEdits},
  {name: loopName('c', 'a page of 400 strokes and one of 12 notes go both ways; a page of only markers is uploaded, an empty page and a page past the song\'s end are not'), run: loopBigPages},
  {name: loopName('d', 'hostile pages on Drive (Infinity, NaN, 1.2 million points, nesting 100000 deep, wrong u or c, 20 MB, invalid JSON, a page the song does not have, an unknown or deleted song, 50001 strokes) are skipped by name and page, nothing hostile is stored, the rest syncs'), run: loopHostile},
  {name: loopName('e', 'New version on one tablet while the other has an unsynced mark on the old chart: the archived copy holds every old mark on both, the new chart starts fresh, marks on it go both ways'), run: loopNewVersion},
  {name: loopName('f', 'a tablet whose clock is 2 hours behind still wins its own erase and note edit of marks made on the other tablet'), run: loopClockBehind},
  {name: loopName('g', 'after a sync, Back up -> wipe -> Restore gives the same marks and nothing to sync; the printed page, read with pdf.js, has both tablets\' marks and not the erased one'), run: loopRestorePrint},
  {name: loopName('h', 'a first Sync cut off mid-download (reload, Stop, connection dropped): each song is there with its marks or not at all; the next Sync finishes; a song and its marks are one write'), run: loopCut},
  {name: loopName('i', 'a deleted song: its ink files leave Drive, a page planted for it is removed and never brings it or its marks back, Delete here on the other tablet uploads none'), run: loopDeleted},
  {name: loopName('j', 'signed in, marks made on both tablets: nothing reaches Google without a tap; the reminder offers Sync and its Sync sends the marks'), run: loopIdle},
  {name: loopName('k', 'Drive full at the first sync with marks to send and songs to get: the songs come down, the run says Drive is full, nothing half written, no Marks folder or ink file left; with room again the marks go and both tablets agree'), run: loopFull},
  {name: loopName('l', 'a run with no marks to send never makes the Marks folder (no marks, a record change, an empty page); the first mark makes one, once'), run: loopNoFolder},
  {name: loopName('m', 'marks never cross charts: while Drive still holds the old chart, marks made on the new one do not go up and the other tablet\'s old chart keeps its own; once the chart is up they follow it'), run: loopCross},
  {name: loopName('n', 'the run that puts a new, shorter chart on Drive removes the old chart\'s pages past its end; the archived copy keeps them on both tablets'), run: loopShorter},
  {name: loopName('o', 'a Drive page that changes between this tablet reading it and writing the merge is not written over: both versions\' marks end on both tablets'), run: loopRace},
  {name: loopName('p', 'New version of a Copy song: on the other tablet its old marks go to the archived copy New version made, never onto the other song that holds the same PDF'), run: loopCopyHolder},
];

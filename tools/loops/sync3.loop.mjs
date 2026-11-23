/*
 * Drive sync Part 2, deletions: "sync 3a" .. "sync 3g". Two (or more) tablets on one stand-in Drive; every deletion is made
 * with the app's own Delete buttons and every Sync through the Sync button and its boxes. What the app PRODUCED is read back
 * from each tablet's IndexedDB, from the stand-in's own files and from its request log (the order of the writes).
 *
 * The rules (work order Part 2, Build 5 and Guards): a deletion made here goes up without asking, its PDF leaves Drive only after
 * the marker is up; a deletion made on the other tablet is LISTED and nothing is deleted before Delete here (two taps) or Keep;
 * Delete here does what Delete does (a twin tablet pressing the real Delete button ends with the same records, times apart);
 * Keep stamps the record newer so it goes back; Escape or Done with nothing answered deletes nothing and asks again; nothing
 * missing from Drive ever deletes anything here; a song edited after its deletion elsewhere survives (the report says so).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert, sleep, diff, restoreZip, TMP, sha256, PDFDocument} from './harness.mjs';
import {openTablet, tapSync, finishSync, syncTap, libraryOf, readDrive, reportCounts} from './sync-two.mjs';
import {startPair, roles, live, libOnly, timeless, whole, assertWhole, deleteSongUi, deleteSetUi, deleteCollUi, saveSong, saveSet,
  writeRecords, putRecordFile, removeDriveFile, recordFileId, pdfFileId, waitBox, pageErrors, H, titleOf, addCopies} from './sync-kit.mjs';
import {inkDiff, splitInkKey} from './sync-model.mjs';
import {songAct} from './songrow.mjs';

/* A check whose failure is collected and reported at the end of the loop (with every other one), so one gap does not hide the
   checks after it. The loop still FAILS. */
const softly = () => { const out = []; const f = (c, msg) => { if(!c) out.push(msg); }; f.end = what => assert(!out.length, `${what}: ` + out.join(' || ')); return f; };
const inkOf = (lib, id) => Object.keys(lib.ink).filter(k => k.startsWith(id + ':'));
const finished = (r, what) => assert(r.state === 'finished', `${what}: the sync did not finish: ${r.title}: ${r.text.slice(0, 400)}`);
const noErrors = (...ts) => { for(const t of ts){ const e = pageErrors(t); assert(!e.length, `${t.name}: page errors: ${e.join(' | ')}`); } };
const sameLib = async (X, Y, what) => {
  const a = libOnly(await libraryOf(X)), b = libOnly(await libraryOf(Y)), ia = a.ink, ib = b.ink;
  delete a.ink; delete b.ink;                                          // marks (Part 3) are compared by stroke id below: their order on a page is not the library
  const d = diff(a, b);
  for(const k of new Set([...Object.keys(ia), ...Object.keys(ib)])){
    const {id, p} = splitInkKey(k), s = a.songs[id];
    if(!s || s.deleted || !(p >= 1 && p <= s.pages)){ if((ia[k] || ib[k]) && (!s || s.deleted)) d.push(`marks ${k} kept for a song that is not live`); continue; }
    d.push(...inkDiff(ia[k], ib[k]).map(x => `marks ${k}: ${x}`));
  }
  assert(!d.length, `${what}: ${X.name} and ${Y.name} do not hold the same library: ${d.join(' | ')}`);
};
/* the d property of the record file of kind/id on Drive */
const dProp = (google, kind, id) => { const f = google.byProp('k', kind).find(f => f.appProperties.id === id); return f ? f.appProperties.d : 'no file'; };

/* ---------- 3a: Delete here, Keep, and the same deletion made with the Delete button on a twin ---------- */
async function loopAnswers(ctx){
  const {A, B} = await startPair(ctx);
  let T = null, C = null;
  try{
    const L0 = await libraryOf(A), {b, c, gig, spare} = roles(L0);
    T = await openTablet(ctx, {name: 'T', share: A}); await restoreZip(T.page, B.backupFile);      // B's twin: the same library, never syncs
    const pdfB = pdfFileId(A.google, b.id), pdfC = pdfFileId(A.google, c.id);
    /* A deletes b (ink; in Gig and Rehearsal), c (archived; in Gig) and the setlist Spare */
    await deleteSongUi(A, b.id); await deleteSongUi(A, c.id); await deleteSetUi(A, spare.id);
    A.google.clearLog();
    const ra = await syncTap(A);
    finished(ra, 'Sync A (three deletions)');
    assert(!ra.asked.length, 'A was asked about its own deletions: ' + JSON.stringify(ra.asked));
    const n = reportCounts(ra.text);
    assert(n.sent.song === 2 && n.sent.set === 3, `A's report should count 2 songs and 3 setlists sent (two markers; Gig and Rehearsal edited; Spare's marker): "${ra.text}"`);
    let drive = readDrive(A.google), LA = await libraryOf(A);
    assert(!drive.problems.length, 'Drive layout after A\'s deletions: ' + drive.problems.join(' | '));
    for(const s of [b, c]){
      assert(!diff(drive.recs.song.get(s.id), LA.songs[s.id]).length && LA.songs[s.id].deleted === true, `the marker of "${s.title}" on Drive is not A's: ${JSON.stringify(drive.recs.song.get(s.id))}`);
      assert(!drive.pdfs.has(s.id), `the PDF of the deleted song "${s.title}" is still on Drive`);
    }
    assert(drive.recs.set.get(spare.id).deleted === true, 'the deleted setlist is not a marker on Drive');
    assert(!A.watch.violations.length && A.watch.pdfRemovals >= 2, `order on Drive: ${A.watch.violations.join(' | ')} (${A.watch.pdfRemovals} PDF removals seen)`);
    for(const [s, fid] of [[b, pdfB], [c, pdfC]]){
      const log = A.google.requests;
      const up = log.find(e => e.kind === 'upload' && e.status === 200 && (e.body || '').includes(`song-${s.id}.json`));
      const del = log.find(e => e.method === 'DELETE' && e.status === 204 && e.path.endsWith('/' + fid));
      assert(up && del && up.n < del.n, `the PDF of "${s.title}" must leave Drive after its marker is up: marker upload #${up && up.n}, PDF removal #${del && del.n}`);
    }

    /* the twin presses the real Delete button for b */
    await deleteSongUi(T, b.id);
    const before = await libraryOf(B);
    assert(inkOf(before, b.id).length && before.files[b.id], 'B has no ink or no PDF for the song (the test is wrong)');

    /* B: Delete here for b, Keep for c and for Spare */
    const rb = await syncTap(B, {answers: {[b.title]: 'delete', [c.title]: 'keep', Spare: 'keep'}});
    finished(rb, 'Sync B (answers the deletion box)');
    assert(rb.asked.length === 3 && [b.title, c.title, 'Spare'].every(x => rb.asked.some(r => r.includes(x))), 'the deletion box did not list b, c and Spare: ' + JSON.stringify(rb.asked));
    assert(/Deleted 1 here/.test(rb.text) && /Kept 2 here/.test(rb.text), `B's report does not say 1 deleted and 2 kept: "${rb.text}"`);
    const LB = await libraryOf(B), LT = await libraryOf(T);
    drive = readDrive(A.google);
    assert(!diff(LB.songs[b.id], drive.recs.song.get(b.id)).length, 'Delete here: B\'s marker is not the one on Drive: ' + JSON.stringify([LB.songs[b.id], drive.recs.song.get(b.id)]));
    assert(!LB.files[b.id] && !inkOf(LB, b.id).length, 'Delete here left the PDF or the marks of the song on B: ' + JSON.stringify({file: LB.files[b.id], ink: inkOf(LB, b.id)}));
    /* the same as the Delete button, times apart. Gig is left out: B got A's newer Gig (without c) before it answered, the twin never syncs. */
    const strip = lib => { const o = JSON.parse(JSON.stringify(libOnly(lib))); delete o.sets[gig.id]; for(const k of ['songs', 'sets', 'colls', 'ink']) for(const id of Object.keys(o[k])) o[k][id] = timeless(o[k][id]); return o; };
    const d = diff(strip(LB), strip(LT));
    assert(!d.length, 'Delete here on B is not what the Delete button did on its twin (times apart): ' + d.join(' | '));
    assertWhole(B, 'after Delete here');
    /* Keep: stamped newer than the marker, the live record and the PDF are back on Drive, the d flag is gone */
    for(const [kind, store, id] of [['song', 'songs', c.id], ['set', 'sets', spare.id]]){
      const m = (await libraryOf(A))[store][id];
      assert(!LB[store][id].deleted && LB[store][id].updated > m.updated, `Keep did not stamp ${id} newer than the marker: ${JSON.stringify([LB[store][id].updated, m.updated])}`);
      assert(!diff(drive.recs[kind].get(id), LB[store][id]).length, `Keep: Drive does not hold B's live ${kind} ${id}: ${JSON.stringify(drive.recs[kind].get(id)).slice(0, 200)}`);
      assert(dProp(A.google, kind, id) === undefined, `Keep: the Drive file of ${kind} ${id} still has d=${dProp(A.google, kind, id)} (it would still read as a deletion)`);
    }
    assert(drive.pdfs.get(c.id) && drive.pdfs.get(c.id).hash === c.hash, 'Keep: the kept song\'s PDF is not back on Drive');
    assert(!B.watch.violations.length, 'order on Drive (B): ' + B.watch.violations.join(' | '));

    /* A gets the kept ones back (record and PDF); a fresh third tablet gets them too */
    const ra2 = await syncTap(A);
    finished(ra2, 'Sync A (gets the kept song back)');
    LA = await libraryOf(A);
    assert(!LA.songs[c.id].deleted && LA.files[c.id] === c.hash && !LA.sets[spare.id].deleted, 'the kept song or setlist did not come back to A with its PDF: ' + JSON.stringify([LA.songs[c.id], LA.files[c.id], LA.sets[spare.id]]).slice(0, 300));
    C = await openTablet(ctx, {name: 'C', share: A});
    finished(await syncTap(C), 'Sync on a fresh tablet');
    const LC = await libraryOf(C);
    assert(LC.songs[c.id] && !LC.songs[c.id].deleted && LC.files[c.id] === c.hash && LC.sets[spare.id] && !LC.sets[spare.id].deleted, 'a fresh tablet did not get the kept song and setlist');
    assert(!LC.songs[b.id], 'a fresh tablet took a record for a song that was deleted before it ever had it: ' + JSON.stringify(LC.songs[b.id]));
    assert(!whole(LC).length, 'the fresh tablet is not whole: ' + whole(LC).join(' | '));

    /* settled: nothing asked again, A = B */
    const rb2 = await syncTap(B);
    assert(!rb2.asked.length, 'the deletion box came back after every row was answered: ' + JSON.stringify(rb2.asked));
    await syncTap(A);
    await sameLib(A, B, 'at the end of 3a');
    noErrors(A, B, T, C);
  } finally { await A.close(); await B.close(); if(T) await T.close(); if(C) await C.close(); }
}

/* ---------- 3b: nothing is deleted without two taps; several connected deletions answered in one run ---------- */
async function loopTaps(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const L0 = await libraryOf(A), {b, reh} = roles(L0);
    await deleteSongUi(A, b.id); await deleteSetUi(A, reh.id);
    finished(await syncTap(A), 'Sync A (a song and the setlist that held it, deleted)');
    const markers = () => { const d = readDrive(A.google); return [d.recs.song.get(b.id), d.recs.set.get(reh.id)].map(r => r && r.deleted === true); };
    const untouched = async what => {
      const L = await libraryOf(B);
      assert(!L.songs[b.id].deleted && L.files[b.id] === b.hash && inkOf(L, b.id).length && !L.sets[reh.id].deleted, `${what}: something was deleted on B: ${JSON.stringify([L.songs[b.id], L.files[b.id], L.sets[reh.id]]).slice(0, 300)}`);
      assert(markers().every(Boolean), `${what}: B sent its live copy over a deletion marker on Drive`);
    };

    /* Escape with nothing answered */
    const r1 = await syncTap(B, {close: 'escape'});
    finished(r1, 'Sync B (Escape)');
    assert(r1.asked.length === 2, 'the deletion box did not list the song and the setlist: ' + JSON.stringify(r1.asked));
    assert(/2 deleted on your other tablet are still waiting for your answer/.test(r1.text), `the report does not say two are still waiting: "${r1.text}"`);
    await untouched('Escape');

    /* Delete here tapped ONCE, then Done */
    await tapSync(B);
    const box = await waitBox(B, /^Deleted on your other tablet/);
    assert(/not back into the setlists or collections/.test(box.text), 'the deletion box does not say a kept song does not go back into its setlists: ' + box.text);
    const first = B.page.locator('.modal').last().locator('[data-del]').first();
    await first.click();
    assert(/Tap again/.test(await first.textContent()), 'one tap on Delete here did not ask for a second tap: ' + await first.textContent());
    await B.page.locator('.modal').last().getByRole('button', {name: 'Done', exact: true}).click();
    const r2 = await finishSync(B);
    finished(r2, 'Sync B (one tap, then Done)');
    assert(/2 deleted on your other tablet are still waiting/.test(r2.text), `after one tap the report does not say both are still waiting: "${r2.text}"`);
    await untouched('one tap on Delete here, then Done');

    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 3c: files missing from Drive never delete anything here ---------- */
async function loopMissing(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const L0 = await libraryOf(A), {a, b, c, gig} = roles(L0), drive0 = readDrive(A.google);
    removeDriveFile(A.google, pdfFileId(A.google, a.id));                           // a PDF removed by hand
    removeDriveFile(A.google, recordFileId(A.google, 'set', gig.id));               // record files removed by hand
    removeDriveFile(A.google, recordFileId(A.google, 'song', c.id));
    /* b's record on Drive names a NEW chart (another tablet replaced the PDF) whose file then went missing */
    const nb = {...drive0.recs.song.get(b.id), hash: H('songbook.pdf'), updated: b.updated + 1000};
    putRecordFile(A.google, drive0, 'song', nb);
    removeDriveFile(A.google, pdfFileId(A.google, b.id));
    const beforeB = libOnly(await libraryOf(B)), beforeA = libOnly(await libraryOf(A));

    const rb = await syncTap(B);
    finished(rb, 'Sync B (files missing from Drive)');
    let d = diff(beforeB, libOnly(await libraryOf(B)));
    assert(!d.length, 'files missing from Drive changed B\'s library: ' + d.join(' | '));
    assert(rb.text.includes(`${b.title}: its PDF is not in Drive (yet)`), `the report does not list "${b.title}" as skipped for its missing PDF: "${rb.text}"`);
    const drive = readDrive(A.google);
    assert(!diff(drive.recs.set.get(gig.id), beforeB.sets[gig.id]).length, 'the setlist whose file was removed from Drive was not sent again');
    assert(!diff(drive.recs.song.get(c.id), beforeB.songs[c.id]).length, 'the song whose record file was removed from Drive was not sent again');
    assert(!B.watch.violations.length, 'order on Drive (B): ' + B.watch.violations.join(' | '));

    const ra = await syncTap(A);
    finished(ra, 'Sync A');
    d = diff(beforeA, libOnly(await libraryOf(A)));
    assert(!d.length, 'files missing from Drive changed A\'s library: ' + d.join(' | '));
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 3d: edited after the deletion survives; a deletion that wins a tie is asked; deleted on both ---------- */
async function loopRaces(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const L0 = await libraryOf(A), {a, b, c} = roles(L0);
    await deleteSongUi(A, a.id); await deleteSongUi(A, c.id);
    await deleteSongUi(B, c.id);                                                     // c: deleted on both
    /* b: a marker on A and an edit on B with the SAME updated (the marker's canon text is the larger, so the tie rule alone would pick it) */
    const U = Math.max(await A.page.evaluate(() => Date.now()), await B.page.evaluate(() => Date.now())) + 5000;
    await A.page.evaluate(async ({id, U}) => { const st = await import('./js/store.js'), {deleteOps} = await import('./js/deleteops.js');
      await st.putAll(await deleteOps('song', id, {marker: {id, deleted: true, updated: U}})); await st.load(); }, {id: b.id, U});
    const bTie = {...(await libraryOf(B)).songs[b.id], version: 'tie on B', updated: U}; bTie.title = titleOf(bTie);
    await writeRecords(B, [{store: 'songs', key: b.id, value: bTie}]);
    finished(await syncTap(A), 'Sync A (two deletions and a marker)');
    await sleep(30);
    const aB = await saveSong(B, a.id, {version: 'edited on B after'});                // after A deleted it
    assert(aB.updated > readDrive(A.google).recs.song.get(a.id).updated, 'the edit on B is not later than the deletion (the test is wrong)');

    const rb = await syncTap(B, {close: 'escape'});
    finished(rb, 'Sync B');
    assert(rb.asked.length === 1 && rb.asked[0].includes(bTie.title), 'B should be asked about the tie only (not the song it edited later, not the song it deleted too): ' + JSON.stringify(rb.asked));
    let LB = await libraryOf(B), drive = readDrive(A.google);
    assert(!LB.songs[b.id].deleted && LB.files[b.id] === b.hash && inkOf(LB, b.id).length, 'a deletion that won a tie was applied without a tap');
    assert(drive.recs.song.get(b.id).deleted === true, 'B sent its tied live record over the marker without an answer');
    assert(!diff(LB.songs[a.id], aB).length && !diff(drive.recs.song.get(a.id), aB).length && drive.pdfs.get(a.id) && drive.pdfs.get(a.id).hash === a.hash, 'the song edited on B after the deletion did not go back to Drive with its PDF');
    assert(LB.songs[c.id].deleted && !LB.files[c.id] && drive.recs.song.get(c.id).deleted && !drive.pdfs.has(c.id), 'the song deleted on both is not deleted everywhere');

    const ra = await syncTap(A);
    finished(ra, 'Sync A (gets the song edited after its deletion)');
    assert(!ra.asked.length, 'A was asked about something: ' + JSON.stringify(ra.asked));
    const LA = await libraryOf(A);
    assert(!diff(LA.songs[a.id], aB).length && LA.files[a.id] === a.hash, 'A did not get back the song B edited after the deletion: ' + JSON.stringify(LA.songs[a.id]).slice(0, 200));
    assert(LA.songs[c.id].deleted && LA.songs[b.id].deleted, 'A lost a deletion');

    /* now B answers the tie: Delete here */
    finished(await syncTap(B, {answers: {[bTie.title]: 'delete'}}), 'Sync B (Delete here for the tie)');
    LB = await libraryOf(B);
    assert(LB.songs[b.id].deleted && !LB.files[b.id] && !diff(LB.songs[b.id], readDrive(A.google).recs.song.get(b.id)).length, 'Delete here for the tie did not leave Drive\'s marker on B');
    await assertWhole(B, '3d'); await assertWhole(A, '3d');
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 3e: a collection deleted on A; B's default points at it; B has a newer song in it ---------- */
async function loopCollection(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const L0 = await libraryOf(A), {a} = roles(L0);
    await B.page.evaluate(() => localStorage.setItem('ss-default-coll', 'cband'));
    await B.page.reload(); await B.page.waitForSelector('#libList');
    assert(await B.page.evaluate(async () => (await import('./js/collections.js')).getDefault()) === 'cband', 'B\'s default collection is not set (the test is wrong)');
    await deleteCollUi(A, 'cband');
    finished(await syncTap(A), 'Sync A (collection deleted)');
    await sleep(30);
    const aB = await saveSong(B, a.id, {version: 'newer on B'});                      // B changes a song of the collection after A deleted it
    const before = await libraryOf(B);
    const had = [...live(before, 'songs').map(r => ['songs', r]), ...live(before, 'sets').map(r => ['sets', r])].filter(([, r]) => (r.colls || []).includes('cband'));
    assert(had.length >= 3, 'B has too few records in the collection (the test is wrong)');

    const rb = await syncTap(B, {answers: {'Band One': 'delete'}});
    finished(rb, 'Sync B (Delete here for the collection)');
    assert(rb.asked.length === 1 && /Band One/.test(rb.asked[0]) && /collection/.test(rb.asked[0]), 'the deletion box did not name the collection: ' + JSON.stringify(rb.asked));
    const LB = await libraryOf(B), drive = readDrive(A.google);
    assert(!diff(LB.colls.cband, drive.recs.coll.get('cband')).length, 'B\'s collection marker is not Drive\'s');
    for(const [store, r] of had){
      const now = LB[store][r.id];
      assert(!(now.colls || []).includes('cband'), `Delete here left the collection on ${store} ${r.id}`);
      assert(now.updated > r.updated, `Delete here took the collection off ${store} ${r.id} without moving its updated (${r.updated} -> ${now.updated})`);
    }
    assert(LB.songs[a.id].version === 'newer on B' && LB.songs[a.id].updated >= aB.updated, 'B\'s newer change to a song of the collection was lost: ' + JSON.stringify(LB.songs[a.id]).slice(0, 200));
    const shown = await B.page.evaluate(async () => { const c = await import('./js/collections.js'); return {def: c.getDefault(), join: c.joinColls(), shown: c.shownColl()}; });
    assert(shown.def === null && !shown.join.length && !shown.shown, 'B\'s default collection still counts after its deletion: ' + JSON.stringify(shown));
    await B.page.click('#tLib');
    const rows = await B.page.locator('#libList [data-open]').count(), want = live(LB).filter(s => !s.archived).length;
    assert(rows === want, `the Library on B shows ${rows} songs, not all ${want} (it still filters by the deleted collection)`);

    finished(await syncTap(A), 'Sync A');
    assert((await libraryOf(A)).songs[a.id].version === 'newer on B', 'A did not get B\'s newer song');
    await sameLib(A, B, 'at the end of 3e');
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 3f: an answer is applied to the current setlist, not the old one ---------- */
async function loopCurrent(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const {b, c, reh} = roles(await libraryOf(A));
    await saveSet(A, reh.id, {items: [...reh.items, {type: 'song', id: c.id}]});      // A adds c to Rehearsal...
    await deleteSongUi(A, b.id);                                                       // ...then deletes b, which is in it
    finished(await syncTap(A), 'Sync A');
    finished(await syncTap(B, {answers: {[b.title]: 'delete'}}), 'Sync B (Delete here; B still had the old Rehearsal)');
    finished(await syncTap(A), 'Sync A again');
    for(const t of [A, B]){
      const items = (await libraryOf(t)).sets[reh.id].items.map(i => i.id);
      assert(items.includes(c.id) && !items.includes(b.id), `${t.name}: Rehearsal should hold the song A added and not the one deleted: ${JSON.stringify(items)}`);
    }
    await sameLib(A, B, 'at the end of 3f');
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 3g: a PDF left on Drive by a cut-off run is swept later; never the PDF of a live song ---------- */
async function loopSweep(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const {b} = roles(await libraryOf(A));
    const fid = pdfFileId(A.google, b.id);
    await deleteSongUi(A, b.id);
    A.google.failNext(500, {times: 20, match: e => e.method === 'DELETE' && e.path.endsWith('/' + fid)});
    await A.page.evaluate(async () => { (await import('./js/drive.js')).tuning.pauseMs = 5; });
    const r1 = await syncTap(A);
    assert(r1.state === 'failed', 'the run whose PDF removal kept failing did not end with a message: ' + r1.text);
    A.google.faults.length = 0;
    let drive = readDrive(A.google);
    assert(drive.recs.song.get(b.id).deleted === true && A.google.files.has(fid), 'the test did not leave a marker with its PDF on Drive');
    /* B still has the song live and is asked: its run must not sweep the PDF */
    finished(await syncTap(B, {close: 'escape'}), 'Sync B (asked, no answer)');
    assert(A.google.files.has(fid), 'the PDF of a song that is still live on B (and asked about) was swept by B\'s Sync');
    const live0 = [...readDrive(A.google).pdfs.keys()];
    finished(await syncTap(A), 'Sync A (the next run sees the marker)');
    drive = readDrive(A.google);
    assert(!A.google.files.has(fid) && !drive.pdfs.has(b.id), 'the PDF left behind by the cut-off run is still on Drive after the next Sync');
    for(const id of live0) if(id !== b.id) assert(drive.pdfs.has(id), `the sweep removed the PDF of a live song ${id}`);
    assert(!drive.problems.length, 'Drive layout after the sweep: ' + drive.problems.join(' | '));
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 3h: several connected deletions answered Delete here in ONE run ----------
   A song and the setlist that held it; a collection and a song in it. Deleting the first edits the second on this tablet (a
   setlist loses the song, a song loses the collection) before the second's answer is applied. */
async function loopConnected(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const {a, b, reh} = roles(await libraryOf(A));
    await deleteSongUi(A, b.id); await deleteSetUi(A, reh.id);
    finished(await syncTap(A), 'Sync A (a song and the setlist that held it, deleted)');
    /* both answered Delete here in one run: the song is in the setlist, so deleting it edits that setlist first */
    const soft = softly();
    const r3 = await syncTap(B, {answers: {[b.title]: 'delete', Rehearsal: 'delete'}});
    finished(r3, 'Sync B (Delete here for both)');
    let LB = await libraryOf(B), drive = readDrive(A.google);
    assert(LB.songs[b.id].deleted && !LB.files[b.id] && !inkOf(LB, b.id).length, 'Delete here did not delete the song on B');
    soft(LB.sets[reh.id].deleted === true, `Delete here did not delete the setlist on B (it was edited by the song's deletion in the same run): ${JSON.stringify(LB.sets[reh.id]).slice(0, 160)}; report: "${r3.text}"`);
    soft(drive.recs.set.get(reh.id).deleted === true, 'the setlist both tablets deleted is live again on Drive');
    finished(await syncTap(A), 'Sync A');
    soft((await libraryOf(A)).sets[reh.id].deleted === true, 'the setlist deleted on both tablets came back on A');

    /* the same with a collection and a song in it */
    await deleteCollUi(A, 'cband'); await deleteSongUi(A, a.id);
    finished(await syncTap(A), 'Sync A (a collection and a song in it, deleted)');
    const r4 = await syncTap(B, {answers: {'Band One': 'delete', [a.title]: 'delete'}});
    finished(r4, 'Sync B (Delete here for the collection and the song)');
    LB = await libraryOf(B); drive = readDrive(A.google);
    assert(LB.colls.cband.deleted === true, 'Delete here did not delete the collection on B');
    soft(LB.songs[a.id].deleted === true && !LB.files[a.id], `Delete here did not delete the song on B (the collection's deletion had edited it in the same run): ${JSON.stringify(LB.songs[a.id]).slice(0, 120)}; report: "${r4.text}"`);
    soft(drive.recs.song.get(a.id).deleted === true, 'the song both tablets deleted is live again on Drive');
    finished(await syncTap(A), 'Sync A');
    soft((await libraryOf(A)).songs[a.id].deleted === true, 'the song deleted on both tablets came back on A');
    await sameLib(A, B, 'at the end of 3h');
    noErrors(A, B);
    soft.end('3h');
  } finally { await A.close(); await B.close(); }
}

/* ---------- 3i: a PDF removed from Drive by hand is put back ---------- */
async function loopHeal(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const {a} = roles(await libraryOf(A));
    removeDriveFile(A.google, pdfFileId(A.google, a.id));
    const before = libOnly(await libraryOf(B));
    finished(await syncTap(B), 'Sync B (a PDF removed from Drive)');
    assert(!diff(before, libOnly(await libraryOf(B))).length, 'a PDF missing from Drive changed B\'s library');
    const drive = readDrive(A.google);
    assert(drive.pdfs.get(a.id) && drive.pdfs.get(a.id).hash === a.hash, 'a song\'s PDF removed from Drive by hand was not put back by the next Sync (Drive has its record, so a tablet that does not have the song skips it for ever)');
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 3j: the report says when a song deleted elsewhere stayed because it was changed here later ---------- */
async function loopSurvivorReport(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const {a} = roles(await libraryOf(A));
    await deleteSongUi(A, a.id);
    finished(await syncTap(A), 'Sync A (a song deleted)');
    await sleep(30);
    const aB = await saveSong(B, a.id, {version: 'edited on B after'});
    const rb = await syncTap(B);
    finished(rb, 'Sync B');
    assert(!rb.asked.length && !(await libraryOf(B)).songs[a.id].deleted, 'the song edited after its deletion was asked about or deleted');
    assert(rb.text.includes(aB.title), `work order Part 2 step 5: "If the local copy is newer than the remote marker, the song stays (it was changed after the deletion): say so in the report." The report: "${rb.text}"`);
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 3k: a deletion answered here never touches a record whose own deletion is still unanswered ---------- */
async function loopUnanswered(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const {a, b, reh} = roles(await libraryOf(A));
    await deleteSongUi(B, b.id); await deleteSetUi(B, reh.id);                 // b is in Rehearsal
    finished(await syncTap(B), 'Sync B (a song and the setlist that held it, deleted)');
    const rehA = (await libraryOf(A)).sets[reh.id];
    const r1 = await syncTap(A, {answers: {[b.title]: 'delete'}});              // Rehearsal left unanswered
    finished(r1, 'Sync A (Delete here for the song only)');
    let LA = await libraryOf(A), drive = readDrive(A.google);
    assert(LA.songs[b.id].deleted === true, 'Delete here did not delete the song');
    assert(!diff(LA.sets[reh.id], rehA).length, 'the unanswered setlist was edited (or re-dated) by the song\'s deletion: ' + JSON.stringify(LA.sets[reh.id]).slice(0, 200));
    assert(drive.recs.set.get(reh.id).deleted === true, 'the unanswered setlist was sent live over the other tablet\'s deletion');
    assert(!r1.text.includes('Rehearsal') && /1 deleted on your other tablet is still waiting/.test(r1.text), `the report must not say the unanswered setlist stays, and must say one is still waiting: "${r1.text}"`);
    const r2 = await syncTap(A, {close: 'escape'});
    assert(r2.asked.length === 1 && r2.asked[0].includes('Rehearsal'), 'the unanswered setlist is not asked about again: ' + JSON.stringify(r2.asked));

    /* a collection deleted with a song in it; Delete here for the collection only */
    await deleteCollUi(B, 'cband'); await deleteSongUi(B, a.id);
    finished(await syncTap(B), 'Sync B (a collection and a song in it, deleted)');
    const aA = (await libraryOf(A)).songs[a.id];
    assert((aA.colls || []).includes('cband'), 'the song is not in the collection (the test is wrong)');
    const r3 = await syncTap(A, {answers: {'Band One': 'delete'}, close: 'done'});
    finished(r3, 'Sync A (Delete here for the collection only)');
    LA = await libraryOf(A); drive = readDrive(A.google);
    assert(LA.colls.cband.deleted === true, 'Delete here did not delete the collection');
    assert(!diff(LA.songs[a.id], aA).length, 'the unanswered song was edited by the collection\'s deletion: ' + JSON.stringify(LA.songs[a.id]).slice(0, 200));
    assert(drive.recs.song.get(a.id).deleted === true, 'the unanswered song was sent live over the other tablet\'s deletion');
    const r4 = await syncTap(A, {close: 'escape'});
    assert(r4.asked.some(x => x.includes(aA.title)), 'the unanswered song is not asked about again: ' + JSON.stringify(r4.asked));
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 3l: answers given, then the run stops before they are applied: the report says so, nothing deleted, asked again ---------- */
async function loopUnapplied(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const g = A.google, {b} = roles(await libraryOf(A));
    await deleteSongUi(A, b.id);
    await addCopies(A, 4, 'ua');                                               // downloads for B to do after the box
    finished(await syncTap(A), 'Sync A');
    const soft = softly();
    for(const how of ['stop', 'offline']){
      await tapSync(B);
      await waitBox(B, /^Deleted on your other tablet/);
      g.latency = 500;
      const del = B.page.locator('.modal').last().locator('[data-del]').first();
      await del.click(); await sleep(150); await del.click();
      await B.page.locator('.modal').last().getByRole('button', {name: 'Done', exact: true}).click();
      const end = Date.now() + 20000;
      while(!/Getting 1 of/.test(await B.page.locator('.modal p[role=status]').textContent().catch(() => ''))){ if(Date.now() > end) throw new Error('the downloads after the deletion box never started'); await sleep(40); }
      if(how === 'stop') await B.page.locator('.modal').last().getByRole('button', {name: 'Stop', exact: true}).click();
      else g.offline = true;
      const r = await finishSync(B);
      g.latency = 0; g.offline = false;
      assert(r.state === (how === 'stop' ? 'stopped' : 'failed'), `${how}: the run did not end as expected: ${r.title}`);
      soft(/answer[^.]*not applied/.test(r.text), `${how} during the downloads after the deletion box: the report does not say the answer was not applied: "${r.text}"`);
      const LB = await libraryOf(B);
      assert(!LB.songs[b.id].deleted && LB.files[b.id] === b.hash, `${how}: the song was deleted although the run stopped before the answers were applied`);
      assert(!whole(LB).length, `${how}: not whole: ` + whole(LB).join(' | '));
    }
    const again = await syncTap(B, {close: 'escape'});
    assert(again.asked.some(x => x.includes(b.title)), 'the next Sync does not ask about the deletion again');
    noErrors(A, B);
    soft.end('3l');
  } finally { await A.close(); await B.close(); }
}

/* ---------- 3m: a deletion's cascade never re-dates a record this tablet failed to bring down ---------- */
async function loopStale(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const g = A.google, {a} = roles(await libraryOf(A));                        // a is in the collection "Band One"
    const p = await makePdf(1500, 'sync3-stale-new.pdf');
    await newVersionB(B, a.id, p.file);
    await saveSong(B, a.id, {version: 'renamed on B'});
    await deleteCollUi(B, 'cband');
    finished(await syncTap(B), 'Sync B (New version, rename, collection deleted)');
    const want = (await libraryOf(B)).songs[a.id];
    const fid = pdfFileId(g, a.id);
    g.failNext(403, {reason: 'cannotDownloadFile', times: 2, match: e => e.by === 'A' && e.kind === 'download' && e.path.endsWith('/' + fid)});
    const ra = await syncTap(A, {answers: {'Band One': 'delete'}});
    g.faults.length = 0;
    finished(ra, 'Sync A (the new chart refused; Delete here for the collection)');
    const LA = await libraryOf(A), drive = readDrive(g);
    assert(!diff(drive.recs.song.get(a.id), want).length && drive.pdfs.get(a.id).hash === p.hash, 'A\'s stale copy of the song was sent over B\'s newer one (the new chart and name were rolled back): ' + JSON.stringify(drive.recs.song.get(a.id)).slice(0, 200));
    assert(LA.songs[a.id].hash === p.hash || ra.text.includes(want.title + ': ') || ra.text.includes(a.title + ': '), `A neither got the new chart nor says it was skipped: "${ra.text}"`);
    assert(LA.colls.cband.deleted === true, 'Delete here did not delete the collection');
    finished(await syncTap(B), 'Sync B');
    assert(!diff((await libraryOf(B)).songs[a.id], want).length, 'B lost its new chart or name');
    finished(await syncTap(A), 'Sync A (the chart comes now)');
    assert((await libraryOf(A)).files[a.id] === p.hash, 'A did not get the new chart at the next Sync');
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}
async function newVersionB(t, id, file){
  const {page} = t;
  await page.click('#tLib');
  if(await page.locator('.collbar [data-collpick="all"]').count()) await page.click('.collbar [data-collpick="all"]');
  await songAct(page, 'newversion', id);
  await page.setInputFiles('#newVersionFile', file);
  await page.waitForSelector('.modal.nvask', {timeout: 15000});
  await page.click('.modal.nvask [data-ok]');
  await page.waitForFunction(() => /^New version in place/.test(document.querySelector('#toast').textContent), null, {timeout: 20000});
}
async function makePdf(pad, name){
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  await doc.attach(crypto.randomBytes(pad), 'pad.bin', {mimeType: 'application/octet-stream'});
  const bytes = Buffer.from(await doc.save({useObjectStreams: false})), file = path.join(TMP, name);
  fs.writeFileSync(file, bytes);
  return {bytes, file, hash: sha256(bytes)};
}

export const loops = [
  {name: 'sync 3a: deletions go up without asking (the PDF leaves Drive after its marker); Delete here = the Delete button on a twin, marker = Drive\'s; Keep goes back to A and to a fresh tablet', run: loopAnswers},
  {name: 'sync 3b: Escape, Done and one tap on Delete here delete nothing and ask again; the box says a kept song does not go back into its setlists', run: loopTaps},
  {name: 'sync 3c: a PDF or record file removed from Drive by hand, or a new chart missing, never deletes anything here and is sent again', run: loopMissing},
  {name: 'sync 3d: a song edited after its deletion survives and comes back; a deletion that wins a tie is asked; deleted on both', run: loopRaces},
  {name: 'sync 3e: a collection deleted elsewhere: listed, Delete here takes it off songs and setlists (stamped), keeps newer songs, and a default pointing at it counts as none', run: loopCollection},
  {name: 'sync 3f: Delete here is applied to the setlist as it is now (a song the other tablet added stays)', run: loopCurrent},
  {name: 'sync 3g: a deleted song\'s PDF left on Drive by a cut-off run is swept by the next run, never while the song is live somewhere', run: loopSweep},
  {name: 'sync 3k: Delete here never edits a setlist or song whose own deletion is still unanswered (it stays as it was, is not sent live over the marker, and is asked again)', run: loopUnanswered},
  {name: 'sync 3l: answers given, then Stop or offline during the downloads before they are applied: the report says they were not applied, nothing is deleted, they are asked again', run: loopUnapplied},
  {name: 'sync 3m: a song whose new chart could not be brought down is not re-dated by a collection\'s Delete here (no rollback of the other tablet\'s chart and name)', run: loopStale},
  {name: 'sync 3h: Delete here for a song and the setlist that held it, and for a collection and a song in it, in one run: all of them deleted, on both tablets', run: loopConnected},
  {name: 'sync 3i: a PDF removed from Drive by hand is put back by the next Sync', run: loopHeal},
  {name: 'sync 3j: a song deleted on one tablet and changed later on the other stays, and the report says so', run: loopSurvivorReport},
];

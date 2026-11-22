/*
 * Drive sync Part 3, the second review's cases: "sync 6y", "6z", "6za" .. "6ze" (under SS_BROWSER=webkit: "sync 7y" ..).
 * Same method as sync6.loop.mjs (whose helpers this file uses); written from the spec, not from js/syncmarks.js.
 *
 *  6y   an old id-less page with no times, restored on two tablets at different times, gets the same ids AND the same times
 *       (0) on both: an erase made on one after the restore is erased on both after a Sync; a stroke drawn later stays.
 *  6z   A erases a mark and then takes New version; B still has the mark live: after both sync to rest it is live nowhere on
 *       either tablet (not on the archived copy, not on the song's pages).
 *  6za  a song S and its Copy C (one PDF, two songs) both get New version on A; B has marks on S's old chart: B's marks end
 *       with S's old chart, never with C's, and C's marks never with S's (a separate archived copy is accepted).
 *  6zb  the run that sends a shorter chart is cut off after the PDF went (the record refused / the connection dropped): the next
 *       Sync removes the old chart's pages past the end from Drive and nothing about them is listed as skipped, on either tablet.
 *  6zc  a Drive page or song record dated exactly at the last date (MAX_U = 8.64e15 - 1e6) is taken; an erase of the page
 *       there ties at MAX_U, the tie goes to the erase on both tablets and nothing is "refused for ever"; dated past it: refused
 *       as "dated too far in the future".
 *  6zd  Drive full while a RECORD has to go up and marks wait on Drive for songs already here: the marks come down, the run ends
 *       with the plain "full" sentence, nothing half written; with room again the next Sync finishes and both tablets agree.
 *  6ze  two tablets' pages that together hold more than 50 000 entries: nothing written on EITHER side (this page unchanged, a
 *       backup still made), listed as skipped, the sync reminder stays on.
 */
import {assert, sleep, backupNow} from './harness.mjs';
import {makeFromBackup, libraryOf, readDrive, takeWrites, halfSongs} from './sync-two.mjs';
import {startA, roles, live, addCopies, saveSong, recordFileId, putRecordFile, whole, titleOf} from './sync-kit.mjs';
import {readMarks, plantPage, entriesOf, liveIds, byIdDiff, inkOf, pageOf, putPage, addEntries, eraseIds, penLine, PEN,
  watchReports, syncRead, marksCounts, skippedPage, makePdf, newVersionUi, loopName, writesBy} from './sync-ink-kit.mjs';
import {finished, noErrors, closeAll, pair6, marksApart, upToDate, sameMarks} from './sync6.loop.mjs';

/* the latest time anything may carry, and the latest a sync takes from Drive (as MAX_U in js/store.js) */
const MAX_U = 8.64e15 - 1e6;
export const allLive = (lib, id) => Object.entries(lib.ink).filter(([, v]) => liveIds(v).includes(id)).map(([k]) => k);
export const shows = async (t, sel) => { await t.page.click('#tSets'); await t.page.click('#tLib'); await sleep(300); return (await t.page.locator('#libNudge ' + sel).count()) > 0; };

/* ---------- 6y ---------- */
async function loopBareTimes(ctx){
  const A = await startA(ctx);
  let C = null, D = null;
  try{
    const {a} = roles(await libraryOf(A)), key = a.id + ':1';
    await putPage(A, key, [{t: 'pen', c: '#1a1a1a', w: .003, p: [[.2, .3], [.6, .3]]}, {t: 'pen', c: '#d62828', w: .003, p: [[.2, .5], [.6, .5]]}, {t: 'text', x: .3, y: .7, text: 'old note', size: .018, c: '#1f5fd6'}]);
    C = await makeFromBackup(ctx, A, {name: 'C'});
    await sleep(1500);
    D = await makeFromBackup(ctx, A, {name: 'D'});
    await watchReports(C); await watchReports(D);
    finished(await syncRead(C), 'Sync C (first)'); finished(await syncRead(D), 'Sync D (first, restored later)');
    const pc = await pageOf(C, key), pd = await pageOf(D, key);
    assert(pc && pd && pc.strokes.length === 3 && pd.strokes.length === 3, `the old page holds ${pc && pc.strokes.length} marks on C and ${pd && pd.strokes.length} on D (3 expected)`);
    assert(JSON.stringify(pc.strokes.map(s => s.id).sort()) === JSON.stringify(pd.strokes.map(s => s.id).sort()), `the old page got different ids on the two tablets: ${pc.strokes.map(s => s.id)} | ${pd.strokes.map(s => s.id)}`);
    assert(pc.strokes.every(s => s.updated === 0) && pd.strokes.every(s => s.updated === 0), `an old mark with no time did not get the time 0 on both tablets: C ${pc.strokes.map(s => s.updated)} | D ${pd.strokes.map(s => s.updated)}`);
    /* an erase on D after the restore; a new stroke on C */
    const victim = pd.strokes.find(s => s.t === 'pen').id;
    await eraseIds(D, a.id, 1, [victim]);
    await addEntries(C, a.id, 1, [penLine('yLater', .9, PEN.blue)]);
    finished(await syncRead(D), 'Sync D (the erase)'); finished(await syncRead(C), 'Sync C'); finished(await syncRead(D), 'Sync D again');
    for(const t of [C, D]){
      const p = entriesOf(await pageOf(t, key));
      assert(p.get(victim) && p.get(victim).deleted === true, `${t.name}: the old mark erased on D after the restore is not erased: ${JSON.stringify(p.get(victim))}`);
      assert(p.get('yLater') && !p.get('yLater').deleted, `${t.name}: the stroke drawn later is not there`);
      assert(p.size === 4, `${t.name}: the page holds ${p.size} entries, 4 expected (3 old, 1 new): it was doubled`);
    }
    await sameMarks(C, D, [key], 'at the end');
    noErrors(C, D);
  } finally { await closeAll(A, C, D); }
}

/* ---------- 6z ---------- */
async function loopErasedThenNew(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const {b} = roles(await libraryOf(A));
    await addEntries(A, b.id, 1, [penLine('zX', .7, PEN.red), penLine('zKeep', .8, PEN.blue)]);
    finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B');
    await eraseIds(A, b.id, 1, ['zX']);
    const pdf = await makePdf(2, 'sync6z.pdf');
    await newVersionUi(A, b.id, pdf.file);
    assert(liveIds(await pageOf(B, b.id + ':1')).includes('zX'), 'B does not have the mark live (the test is wrong)');
    finished(await syncRead(A), 'Sync A (erase, New version)'); finished(await syncRead(B), 'Sync B'); finished(await syncRead(A), 'Sync A again'); finished(await syncRead(B), 'Sync B again');
    for(const t of [A, B]){
      const L = await libraryOf(t), where = allLive(L, 'zX');
      assert(!where.length, `${t.name}: the mark A erased before its New version is live again on ${where.join(', ')}`);
      assert(allLive(L, 'zKeep').length, `${t.name}: the mark nobody erased is gone`);
    }
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6za ---------- */
async function loopTwoCopies(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const {b} = roles(await libraryOf(A));
    const [S] = await addCopies(A, 1, 'S', {from: b.id}), [C] = await addCopies(A, 1, 'C', {from: S});
    await addEntries(A, S, 1, [penLine('sM', .3, PEN.red)]); await addEntries(A, C, 1, [penLine('cM', .3, PEN.blue)]);
    finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B');
    await addEntries(B, S, 1, [penLine('bS', .6, PEN.black)]);                         // not synced
    const p1 = await makePdf(2, 'sync6za-s.pdf'), p2 = await makePdf(2, 'sync6za-c.pdf');
    await newVersionUi(A, S, p1.file); await newVersionUi(A, C, p2.file);
    for(const [t, what] of [[A, 'A'], [B, 'B'], [A, 'A again'], [B, 'B again']]) finished(await syncRead(t), 'Sync ' + what);
    for(const t of [A, B]){
      const L = await libraryOf(t), copies = live(L).filter(s => s.archived && s.hash === b.hash);
      const has = (s, id) => Object.entries(L.ink).some(([k, v]) => k.startsWith(s.id + ':') && liveIds(v).includes(id));
      for(const s of copies){
        assert(!((has(s, 'sM') || has(s, 'bS')) && has(s, 'cM')), `${t.name}: one archived copy "${s.title}" holds marks of both songs: ${Object.entries(L.ink).filter(([k]) => k.startsWith(s.id + ':')).map(([k, v]) => k + ' ' + liveIds(v)).join(' | ')}`);
      }
      for(const id of ['sM', 'bS', 'cM']) assert(copies.some(s => has(s, id)), `${t.name}: the old chart's mark ${id} is on no archived copy`);
      assert(copies.some(s => has(s, 'sM') && has(s, 'bS')), `${t.name}: B's mark on S's old chart is not with S's own old marks`);
      for(const id of [S, C]) assert(!liveIds(L.ink[id + ':1']).some(x => ['sM', 'bS', 'cM'].includes(x)), `${t.name}: a new chart holds old marks: ${liveIds(L.ink[id + ':1'])}`);
    }
    /* the Copy has no marks, and its New version is made FIRST (so its archived copy is the older of the two): S's marks, B's too,
       must still go with S's old chart and never onto the Copy's */
    const [S2] = await addCopies(A, 1, 'S2', {from: b.id}), [C2] = await addCopies(A, 1, 'C2', {from: S2});
    await addEntries(A, S2, 1, [penLine('s2M', .3, PEN.red)]);
    finished(await syncRead(A), 'Sync A (second pair)'); finished(await syncRead(B), 'Sync B (second pair)');
    await addEntries(B, S2, 1, [penLine('b2S', .6, PEN.black)]);
    const before = (await libraryOf(A)).songs;
    await newVersionUi(A, C2, (await makePdf(2, 'sync6za-c2.pdf')).file); await sleep(20);
    const cCopy = live(await libraryOf(A)).find(s => !before[s.id] && s.archived);
    await newVersionUi(A, S2, (await makePdf(2, 'sync6za-s2.pdf')).file);
    const sCopy = live(await libraryOf(A)).find(s => !before[s.id] && s.archived && s.id !== cCopy.id);
    assert(cCopy && sCopy && cCopy.id < sCopy.id, 'the Copy\'s archived copy is not the older id (the test is wrong): ' + [cCopy && cCopy.id, sCopy && sCopy.id]);
    for(const [t, what] of [[A, 'A'], [B, 'B'], [A, 'A again'], [B, 'B again']]) finished(await syncRead(t), 'Sync ' + what + ' (second pair)');
    for(const t of [A, B]){
      const L = await libraryOf(t), on = (id, m) => Object.entries(L.ink).some(([k, v]) => k.startsWith(id + ':') && liveIds(v).includes(m));
      assert(!on(cCopy.id, 'b2S') && !on(cCopy.id, 's2M'), `${t.name}: the marks of S's old chart went onto the archived copy of its Copy song: ${Object.entries(L.ink).filter(([k]) => k.startsWith(cCopy.id + ':')).map(([k, v]) => k + ' ' + liveIds(v)).join(' | ')}`);
      assert(live(L).some(s => s.archived && s.hash === b.hash && on(s.id, 'b2S') && on(s.id, 's2M')), `${t.name}: B's mark on S's old chart is not with S's own old marks`);
    }
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6zb ---------- */
async function loopShorterCut(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const g = A.google, {c} = roles(await libraryOf(A));
    for(const [n, how] of [[0, 'the record refused'], [1, 'the connection dropped at the record'], [2, 'the connection dropped after the record went']]){
      const [id] = await addCopies(A, 1, 'zb' + n, {from: c.id});
      for(const p of [1, 2, 3]) await addEntries(A, id, p, [penLine(`zb${n}p${p}`, .5, PEN.red)]);
      finished(await syncRead(A), `${how}: Sync A`); finished(await syncRead(B), `${how}: Sync B`);
      const pdf = await makePdf(1, `sync6zb${n}.pdf`);
      await newVersionUi(A, id, pdf.file);
      const rf = recordFileId(g, 'song', id), isRec = e => e.kind === 'upload' && e.path.includes(rf);
      if(n === 0) g.failNext(400, {reason: 'badRequest', times: 1000, match: isRec});
      else if(n === 1) g.failNext(503, {times: 1, match: e => { if(!isRec(e)) return false; g.offline = true; return true; }});
      else { let seen = false; g.failNext(503, {times: 1, match: e => { if(isRec(e)){ seen = true; return false; } if(!seen || e.by !== 'A' || e.kind === 'preflight') return false; g.offline = true; return true; }}); }
      const r1 = await syncRead(A);
      g.faults.length = 0; g.offline = false;
      assert(r1.state !== 'finished' || /Skipped/.test(r1.text), `${how}: the cut run says nothing about it: ${r1.text}`);
      assert(readDrive(g).pdfs.get(id).hash === pdf.hash, `${how}: the new chart did not reach Drive before the cut (the test is wrong)`);
      const pagesOn = () => [...readMarks(g).pages.keys()].filter(k => k.startsWith(id + ':')).sort();
      const T = (await libraryOf(A)).songs[id].title;
      const listed = items => [2, 3].filter(p => items.some(s => s.startsWith(T + ': page ' + p + ':') || new RegExp(`: page ${p}: .*(no page|past)`).test(s)));
      const ra = await syncRead(A);
      finished(ra, `${how}: the next Sync A`);
      assert(JSON.stringify(pagesOn()) === JSON.stringify([id + ':1']), `${how}: after the next Sync, Drive still holds the pages ${pagesOn()} of the song (pages 2 and 3 of the old chart should be gone)`);
      assert(!listed(ra.items).length, `${how}: A lists the old chart's pages past the end as skipped: ${JSON.stringify(ra.items)}`);
      for(const [t, w] of [[B, 'B'], [A, 'A'], [B, 'B again']]){
        const r = await syncRead(t);
        finished(r, `${how}: Sync ${w}`);
        assert(!listed(r.items).length, `${how}: ${w} lists the old chart's pages past the end as skipped: ${JSON.stringify(r.items)}`);
      }
      for(const t of [A, B]){ const L = await libraryOf(t); assert(!L.ink[id + ':2'] && !L.ink[id + ':3'] && !liveIds(L.ink[id + ':1']).length, `${how}: ${t.name}: the one-page chart still has old marks`); }
    }
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6zc ---------- */
async function loopLastDate(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const g = A.google, {a} = roles(await libraryOf(A));
    const [atP, atR, overP, overR] = await addCopies(A, 4, 'zc', {from: a.id});
    finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B');
    const L0 = await libraryOf(B), T = id => L0.songs[id].title, OVER = MAX_U + 1000;
    /* at the last date (taken) and past it (refused): a page each, and a song record each */
    plantPage(g, atP, 1, {updated: MAX_U, strokes: [penLine('atMax', .5, PEN.red, {updated: MAX_U})]});
    plantPage(g, overP, 1, {updated: OVER, strokes: [penLine('overMax', .5, PEN.red, {updated: OVER})]});
    let drive = readDrive(g);
    const rec = (id, u, v) => { const r = {...drive.recs.song.get(id), version: v, updated: u}; r.title = titleOf(r); putRecordFile(g, drive, 'song', r); return r; };
    const rAt = rec(atR, MAX_U, 'dated at the last date'), rOver = rec(overR, OVER, 'dated past the last date');
    const rb = await syncRead(B);
    finished(rb, 'Sync B (dates at and past the last one)');
    const LB = await libraryOf(B);
    assert(liveIds(LB.ink[atP + ':1']).includes('atMax'), 'the page dated exactly at the last date was not taken');
    assert(LB.songs[atR].updated === MAX_U && LB.songs[atR].version === rAt.version, 'the song record dated exactly at the last date was not taken');
    assert(!LB.ink[overP + ':1'] && LB.songs[overR].updated !== OVER, 'B stored the page or the record dated past the last date');
    const far = rb.items.filter(x => /dated too far in the future/.test(x));
    assert(far.some(x => x.startsWith(T(overP) + ': page 1:')), `the page dated past the last date is not listed as "dated too far in the future": ${JSON.stringify(rb.items)}`);
    assert(far.some(x => x.startsWith(T(overR) + ':') || x.startsWith(rOver.title + ':')), `the record dated past the last date is not listed as "dated too far in the future": ${JSON.stringify(rb.items)}`);
    assert(!rb.items.some(x => x.startsWith(T(atP) + ':') || x.startsWith(T(atR) + ':') || x.startsWith(rAt.title + ':')), `a page or record dated exactly at the last date is listed as skipped: ${JSON.stringify(rb.items)}`);
    /* the page at the last date is erased on B: the marker ties at the last date and the tie goes to the erase, on both tablets */
    const er = await eraseIds(B, atP, 1, ['atMax']), mk = entriesOf(er).get('atMax');
    assert(mk && mk.deleted && mk.updated === MAX_U, `an erase of a mark dated at the last date is ${JSON.stringify(mk)} (a marker at the last date expected)`);
    for(const [t, w] of [[B, 'B (the erase)'], [A, 'A'], [B, 'B again'], [A, 'A again']]){
      const r = await syncRead(t);
      finished(r, 'Sync ' + w);
      assert(!r.items.some(x => x.startsWith(T(atP) + ':') || x.startsWith(T(atR) + ':')), `Sync ${w} lists a page or record dated at the last date as skipped: ${JSON.stringify(r.items)}`);
    }
    for(const t of [A, B]){
      const p = entriesOf(await pageOf(t, atP + ':1')).get('atMax');
      assert(p && p.deleted === true, `${t.name}: the erase of the mark dated at the last date did not win: ${JSON.stringify(p)}`);
      assert((await libraryOf(t)).songs[atR].updated === MAX_U, `${t.name}: the record dated at the last date did not arrive`);
    }
    /* at rest: nothing goes back and forth (the report still names the records dated ahead and the files past the last date) */
    for(const t of [A, B]){
      g.clearLog();
      const r = await syncRead(t);
      finished(r, `Sync ${t.name} at rest`);
      const w = writesBy(g, t.name);
      assert(!w.length && !marksCounts(r.text).sent && !marksCounts(r.text).got, `Sync ${t.name} at rest still moves something: "${r.text.slice(0, 300)}" (${w.length} writes)`);
    }
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6zd ---------- */
async function loopFullRecord(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const g = A.google, {a, b, c} = roles(await libraryOf(A));
    const [ed] = await addCopies(A, 1, 'zd', {from: b.id});                            // the song whose record B changes (no marks)
    finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B');
    const recv = [[a.id, 1], [b.id, 2], [c.id, 2]];
    for(const [id, p] of recv) await addEntries(A, id, p, [penLine(`fd_${p}_${id}`, .45, PEN.red)]);
    finished(await syncRead(A), 'Sync A (marks on songs B has)');
    await saveSong(B, ed, {version: 'renamed on B'});                                   // a record to send
    g.quotaFull = true;
    await takeWrites(B);
    const r = await syncRead(B);
    g.quotaFull = false;
    assert(r.state === 'failed' && /Your Google Drive is full/.test(r.text), `a full Drive should end the run with "Your Google Drive is full": ${r.title}: ${r.text.slice(0, 300)}`);
    const writes = await takeWrites(B), half = [...halfSongs(writes), ...marksApart(writes, readMarks(g).pages)];
    assert(!half.length, half.join(' | '));
    const L = await libraryOf(B), D = readMarks(g).pages;
    const notDown = recv.filter(([id, p]) => byIdDiff(D.get(id + ':' + p), L.ink[id + ':' + p]).length);
    assert(!notDown.length, `marks waiting on Drive did not come down before the run ended on a full Drive: ${notDown.map(([id, p]) => id + ':' + p).join(', ')}`);
    assert(!whole(L).length && L.songs[ed].version === 'renamed on B', 'B is not whole or lost its edit');
    finished(await syncRead(B), 'Sync B (room again)'); finished(await syncRead(A), 'Sync A');
    await sameMarks(A, B, recv.map(([id, p]) => id + ':' + p), 'after room came back');
    assert((await libraryOf(A)).songs[ed].version === 'renamed on B', 'A did not get B\'s record');
    await upToDate(A, 'Sync A at rest'); await upToDate(B, 'Sync B at rest');
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6ze ---------- */
async function loopOverCap(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const g = A.google, {a} = roles(await libraryOf(A)), key = a.id + ':1', u = Date.now() - 6e4;
    const half = tag => Array.from({length: 26000}, (_, i) => ({id: tag + i, deleted: true, updated: u}));
    await putPage(A, key, {updated: u, strokes: half('ea')});
    await putPage(B, key, {updated: u + 1, strokes: half('eb')});
    finished(await syncRead(A), 'Sync A (26000 entries)');
    const d0 = readMarks(g).pages.get(key), b0 = JSON.stringify(await pageOf(B, key));
    assert(d0 && d0.strokes.length === 26000, 'A\'s page of 26000 entries did not reach Drive (the test is wrong)');
    const rb = await syncRead(B);
    finished(rb, 'Sync B (together over 50000)');
    assert(JSON.stringify(await pageOf(B, key)) === b0, `B wrote something for a page whose two sides together are over the cap: it holds ${(await pageOf(B, key)).strokes.length} entries (its own 26000, unchanged, expected)`);
    const d1 = readMarks(g).pages.get(key);
    assert(d1 && d1.strokes.length === 26000 && !byIdDiff(d0, d1).length, `something was sent to Drive for the page over the cap (${d1 && d1.strokes.length} entries there)`);
    assert(skippedPage(rb.items, (await libraryOf(B)).songs[a.id].title, 1), `the page over the cap is not listed as skipped with a reason: ${JSON.stringify(rb.items)}`);
    assert(await shows(B, '[data-syncnow]'), 'the page could not be synced but the sync reminder is off');
    g.clearLog();
    finished(await syncRead(A), 'Sync A');
    assert((await pageOf(A, key)).strokes.length === 26000, 'A was given something for the page over the cap');
    /* B's own page is whole: a backup of it restores (nothing over the cap was stored) */
    const bk = await backupNow(B.page);
    assert(bk && bk.file, 'B could not back up');
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

export const loops = [
  {name: loopName('y', 'an old page with no ids and no times, restored on two tablets at different times, gets the same ids and times on both: an erase after the restore stays, nothing doubles'), run: loopBareTimes},
  {name: loopName('z', 'a mark erased just before New version, still live on the other tablet, is live nowhere on either tablet after both sync'), run: loopErasedThenNew},
  {name: loopName('za', 'New version of a song and of its Copy (one PDF): each old chart keeps its own marks (the other tablet\'s too), never the other song\'s'), run: loopTwoCopies},
  {name: loopName('zb', 'a shorter chart\'s run cut off after the PDF went (record refused, connection dropped): the next Sync removes the old pages past the end and nothing is listed for ever'), run: loopShorterCut},
  {name: loopName('zc', 'a page or record dated exactly at the last date is taken and an erase of it wins on both (a tie goes to the erase); one dated past it is refused as too far in the future'), run: loopLastDate},
  {name: loopName('zd', 'Drive full while a record must go up and marks wait on Drive: the marks come down, the run says Drive is full, nothing half written; then it finishes and both agree'), run: loopFullRecord},
  {name: loopName('ze', 'two tablets\' pages together over 50000 entries: nothing written on either side, listed as skipped, the sync reminder stays on'), run: loopOverCap},
];

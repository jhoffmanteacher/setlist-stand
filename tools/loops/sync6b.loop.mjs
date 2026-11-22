/*
 * Drive sync Part 3, marks and charts, the review's cases: "sync 6q" .. "sync 6x" (under SS_BROWSER=webkit: "sync 7q" ..).
 * Same method as sync6.loop.mjs (whose helpers this file uses): two tablets on one stand-in Drive, the app for real, what it
 * produced read back apart from it. Written from the spec, not from js/syncmarks.js.
 *
 * Every Marks file carries h, the SHA-256 of the chart its page was drawn on. A Drive page is merged on a tablet only when its h
 * is that tablet's song hash; one with another h is never merged into the other chart; one with no valid h is a stray.
 *
 *  6q  B marks X and syncs; A (not synced since) takes New version of X and syncs: the mark does not land on A's new chart and
 *      A's report does not say it got marks for that page; after B and A sync again: B has the new chart, the old marks (B's
 *      too) on the archived copy, both tablets equal.
 *  6r  B takes New version of X; Sync; Drive refuses the song's RECORD file while the PDF went up: none of B's marks for X (the
 *      markers over the old chart's marks, the new mark) reach Drive; A keeps X's marks; once the record goes, it settles.
 *  6s  a mark erased on B before A's New version reached it stays erased on the archived copy, on both tablets.
 *  6t  a planted Drive page with a stroke with no colour, or a colour that is not one, is skipped with a plain reason; a
 *      damaged page here (no colour, more than 50000 entries, `updated` past the last date) is never uploaded and is listed.
 *  6u  Drive full at a sync with marks to send AND pages and a song waiting on Drive: every page that only needs receiving
 *      comes down (and the song with its marks); the run ends with the plain "full" sentence.
 *  6v  a page send refused (and one cut off by a dropped connection): the SYNC reminder still shows, the BACKUP reminder is as
 *      it was; a finished sync that sent everything clears the sync reminder.
 *  6w  a stroke saved from another tab while a sync is replacing the chart (between its read and its write) is not lost: it
 *      ends on the archived copy on both tablets.
 *  6x  an old id-less page (a bare list) restored on BOTH tablets gets the same ids on both (opened in the viewer on one, only
 *      synced on the other): one sync later the page is not doubled; a page's own unknown fields survive an edit and a sync.
 */
import {assert, sleep, backupNow} from './harness.mjs';
import {makeFromBackup, tapSync, finishSync, libraryOf, readDrive, takeWrites} from './sync-two.mjs';
import {startA, roles, live, addCopies, whole, recordFileId} from './sync-kit.mjs';
import {canonHash} from './sync-model.mjs';
import {readMarks, plantPage, entriesOf, liveIds, byIdDiff, hostileIn, inkOf, pageOf, putPage, addEntries, eraseIds,
  penLine, hlLine, textNote, PEN, openOn, closeViewer, watchReports, syncRead, marksCounts, skippedPage, makePdf, newVersionUi, loopName} from './sync-ink-kit.mjs';
import {finished, noErrors, closeAll, pair6, marksApart, upToDate, sameMarks} from './sync6.loop.mjs';

const MAX_U = 8.64e15 - 1e6;
const hOf = (google, key) => readMarks(google).h.get(key);
const archivedCopy = (lib, hash, not = []) => live(lib).filter(s => s.archived && s.hash === hash && !not.includes(s.id));
const shows = async (t, sel) => { await t.page.click('#tSets'); await t.page.click('#tLib'); await sleep(300); return (await t.page.locator('#libNudge ' + sel).count()) > 0; };
/* uploads of ink files (a new page: its name in the metadata; an existing one: its file id in the address) */
const inkUpload = google => e => e.kind === 'upload' && (/ink-[^"]*\.json/.test(e.body || '') || [...google.files.values()].some(f => f.appProperties.k === 'ink' && e.path.includes(f.id)));

/* ---------- 6q ---------- */
async function loopOtherChart(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const g = A.google, {b} = roles(await libraryOf(A)), k1 = b.id + ':1';
    await addEntries(B, b.id, 1, [penLine('qB', .85, PEN.blue)]);
    await addEntries(B, b.id, 2, [penLine('qB2', .85, PEN.blue)]);                      // page 2: A has no marks there, so A leaves Drive's page (old chart) alone
    finished(await syncRead(B), 'Sync B (a mark on the chart)');
    assert(liveIds(readMarks(g).pages.get(k1)).includes('qB') && hOf(g, k1) === b.hash, 'B\'s mark is not on Drive drawn on the chart b (the test is wrong, or h is not the chart\'s hash)');
    const oldA = liveIds(await pageOf(A, k1));
    const pdf = await makePdf(2, 'sync6q.pdf'), before = (await libraryOf(A)).songs;
    await newVersionUi(A, b.id, pdf.file);
    const copy = live(await libraryOf(A)).find(s => !before[s.id] && s.archived && s.hash === b.hash);
    const ra = await syncRead(A);
    finished(ra, 'Sync A (New version, not synced since B\'s mark)');
    const LA = await libraryOf(A);
    assert(!liveIds(LA.ink[k1]).length, `B's mark made on the OLD chart landed on A's NEW chart: ${liveIds(LA.ink[k1])}`);
    assert(!marksCounts(ra.text).got, `A's report says it got marks, but nothing on Drive belongs to its chart: "${ra.text}"`);
    assert(hOf(g, k1) === undefined || hOf(g, k1) === pdf.hash, 'Drive\'s page 1 of the song is still the old chart\'s after A put the new chart there');
    if(hOf(g, k1) === pdf.hash) assert(!liveIds(readMarks(g).pages.get(k1)).length, 'Drive\'s page for the new chart holds live marks of the old one');
    /* Drive's page 2 is still the OLD chart's (A had nothing there): it gains a mark B has never seen, as another tablet's would */
    {
      const f = readMarks(g).files.get(b.id + ':2');
      assert(f && f.appProperties.h === b.hash, 'Drive\'s page 2 is not the old chart\'s any more (the test is wrong)');
      const pg = JSON.parse(f.content.toString('utf8')), u = Date.now();
      pg.strokes.push(penLine('oldGhost', .2, PEN.red, {updated: u})); pg.updated = Math.max(pg.updated + 1, u);
      Object.assign(f, {content: Buffer.from(JSON.stringify(pg)), modifiedTime: new Date().toISOString()});
      Object.assign(f.appProperties, {u: String(pg.updated), c: canonHash(pg)});
    }
    finished(await syncRead(B), 'Sync B (gets the new chart)');
    assert(!liveIds(await pageOf(B, b.id + ':2')).includes('oldGhost'), 'B merged Drive\'s page of the OLD chart into the new chart it just got (a mark of the old chart is on the new one)');
    finished(await syncRead(A), 'Sync A again');
    finished(await syncRead(B), 'Sync B again');
    for(const t of [A, B]){
      const L = await libraryOf(t), holders = archivedCopy(L, b.hash);
      assert(L.files[b.id] === pdf.hash, `${t.name} does not have the new chart`);
      assert(holders.length === 1 && holders[0].id === copy.id, `${t.name}: the old chart is held by ${holders.map(s => s.id)}, expected only ${copy.id}`);
      assert(JSON.stringify(liveIds(L.ink[copy.id + ':1'])) === JSON.stringify([...oldA, 'qB'].sort()), `${t.name}: the archived copy's page 1 holds ${liveIds(L.ink[copy.id + ':1'])}, expected A's old marks and B's qB`);
      assert(!liveIds(L.ink[k1]).length, `${t.name}: the new chart has marks of the old one: ${liveIds(L.ink[k1])}`);
      assert(!liveIds(L.ink[b.id + ':2']).includes('qB2'), `${t.name}: the new chart's page 2 took B's mark from Drive's page 2 of the OLD chart`);
      assert(liveIds(L.ink[copy.id + ':2']).includes('qB2'), `${t.name}: the archived copy's page 2 lost B's mark: ${liveIds(L.ink[copy.id + ':2'])}`);
    }
    await sameMarks(A, B, [k1, copy.id + ':1', copy.id + ':2'], 'at the end');
    await upToDate(A, 'Sync A at rest'); await upToDate(B, 'Sync B at rest');
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6r ---------- */
async function loopRecordRefused(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const g = A.google, {b} = roles(await libraryOf(A)), k1 = b.id + ':1', k2 = b.id + ':2';
    await addEntries(A, b.id, 2, [penLine('r2', .4, PEN.red)]);
    finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B');
    const drive0 = {[k1]: readMarks(g).pages.get(k1), [k2]: readMarks(g).pages.get(k2)}, aBefore = {[k1]: liveIds(await pageOf(A, k1)), [k2]: liveIds(await pageOf(A, k2))};
    const pdf = await makePdf(2, 'sync6r.pdf');
    await newVersionUi(B, b.id, pdf.file);
    await addEntries(B, b.id, 1, [penLine('rNew', .6, PEN.blue)]);
    const rf = recordFileId(g, 'song', b.id);
    g.failNext(400, {reason: 'badRequest', times: 1000, match: e => e.kind === 'upload' && e.path.includes(rf)});
    const r1 = await syncRead(B);
    g.faults.length = 0;
    assert(r1.state === 'finished' && /Skipped/.test(r1.text), 'the refused record should be skipped and listed: ' + r1.text);
    assert(readDrive(g).recs.song.get(b.id).hash === b.hash, 'the record reached Drive although it was refused (the test is wrong)');
    for(const k of [k1, k2]){
      const d = readMarks(g).pages.get(k), dd = byIdDiff(drive0[k], d, {la: 'before', lb: 'after'});
      assert(!dd.length, `B's marks for the song reached Drive while Drive's record still names the old chart (page ${k}): ${dd.slice(0, 4).join(' | ')}`);
    }
    finished(await syncRead(A), 'Sync A');
    for(const k of [k1, k2]) assert(JSON.stringify(liveIds(await pageOf(A, k))) === JSON.stringify(aBefore[k]), `A's song lost marks on ${k}: ${liveIds(await pageOf(A, k))} (it had ${aBefore[k]})`);
    /* the record goes now: everything settles, the old marks on the archived copy, rNew on the new chart */
    finished(await syncRead(B), 'Sync B (the record goes)'); finished(await syncRead(A), 'Sync A (gets the new chart)'); finished(await syncRead(B), 'Sync B again');
    for(const t of [A, B]){
      const L = await libraryOf(t), cps = archivedCopy(L, b.hash);
      assert(L.files[b.id] === pdf.hash && liveIds(L.ink[k1]).join() === 'rNew', `${t.name}: the new chart does not hold exactly its own mark: ${liveIds(L.ink[k1])}`);
      /* the old marks are kept with the old chart (B's archived copy, which carries them; Part 2 may also make this tablet a
         separate copy of its own: that is Part 2's rule and is reported, not failed, here) */
      const holds = cps.filter(s => ['1', '2'].every(p => { const want = aBefore[b.id + ':' + p]; const got = liveIds(L.ink[s.id + ':' + p]); return want.every(x => got.includes(x)) && !got.includes('rNew'); }));
      assert(holds.length >= 1, `${t.name}: no archived copy of the old chart holds its marks: ${cps.map(s => s.id + ' [' + liveIds(L.ink[s.id + ':1']) + ']').join(' | ')}`);
      if(cps.length > 1) console.log(`    note: ${t.name} holds ${cps.length} archived copies of the old chart after a refused record (Part 2's separate copy)`);
    }
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6s ---------- */
async function loopErasedStays(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const {b} = roles(await libraryOf(A)), k1 = b.id + ':1';
    await addEntries(A, b.id, 1, [penLine('s1', .7, PEN.red), penLine('s2', .8, PEN.blue)]);
    finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B');
    await eraseIds(B, b.id, 1, ['s1']);                                                  // not synced
    const pdf = await makePdf(2, 'sync6s.pdf'), before = (await libraryOf(A)).songs;
    await newVersionUi(A, b.id, pdf.file);
    const copy = live(await libraryOf(A)).find(s => !before[s.id] && s.archived && s.hash === b.hash);
    assert(liveIds(await pageOf(A, copy.id + ':1')).includes('s1'), 'A\'s archived copy does not hold s1 (the test is wrong)');
    finished(await syncRead(A), 'Sync A (New version)'); finished(await syncRead(B), 'Sync B (gets it; it had erased s1)'); finished(await syncRead(A), 'Sync A again');
    for(const t of [A, B]){
      const p = entriesOf(await pageOf(t, copy.id + ':1'));
      assert(p.get('s1') && p.get('s1').deleted === true, `${t.name}: the mark B erased before the New version arrived is back on the archived copy: ${JSON.stringify(p.get('s1'))}`);
      assert(p.get('s2') && !p.get('s2').deleted, `${t.name}: the archived copy lost s2`);
    }
    await sameMarks(A, B, [copy.id + ':1', k1], 'at the end');
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6t ---------- */
async function loopDamaged(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const g = A.google, R = roles(await libraryOf(A));
    const hs = await addCopies(A, 2, 't', {from: R.c.id});                              // two three-page songs
    finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B');
    const L0 = await libraryOf(B), T = id => L0.songs[id].title, u = Date.now() - 6e4;
    const noC = {...penLine('nc1', .3, PEN.black, {updated: u})}; delete noC.c;
    const keys = [[hs[0], 1], [hs[0], 2], [hs[0], 3]];
    plantPage(g, hs[0], 1, {updated: u, strokes: [noC]});
    plantPage(g, hs[0], 2, {updated: u, strokes: [textNote('nc2', .2, .2, 'colour?', {c: 'not a colour', updated: u})]});
    plantPage(g, hs[0], 3, {updated: u, strokes: [hlLine('nc3', .5, '#12', {updated: u})]});
    const rb = await syncRead(B);
    finished(rb, 'Sync B (pages with no usable colour on Drive)');
    const missing = keys.filter(([id, p]) => !skippedPage(rb.items, T(id), p));
    assert(!missing.length, `B does not list ${missing.map(([id, p]) => `"${T(id)}: page ${p}: <plain reason>"`).join(', ')} as skipped: ${JSON.stringify(rb.items).slice(0, 700)}`);
    const LB = await libraryOf(B);
    for(const [id, p] of keys) assert(!LB.ink[id + ':' + p], `B stored the page ${p} of "${T(id)}" that has a mark with no usable colour`);
    /* damaged pages here are never uploaded, and are listed */
    const noC2 = penLine('dc1', .3, PEN.black, {updated: u}); delete noC2.c;
    await putPage(A, hs[1] + ':1', {updated: u, strokes: [noC2]});
    await putPage(A, hs[1] + ':2', {updated: u, strokes: Array.from({length: 50001}, (_, i) => ({id: 'e' + i, deleted: true, updated: u}))});
    await putPage(A, hs[1] + ':3', {updated: MAX_U + 5, strokes: [penLine('far1', .5, PEN.red, {updated: u})]});
    const ra = await syncRead(A);
    finished(ra, 'Sync A (damaged pages here)');
    const D = readMarks(g, {except: new Set([...g.files.values()].filter(f => f.appProperties.id === hs[0]).map(f => f.id))});
    for(const p of [1, 2, 3]) assert(!D.pages.has(hs[1] + ':' + p) && ![...g.files.values()].some(f => !f.trashed && f.appProperties.k === 'ink' && f.appProperties.id === hs[1] && f.appProperties.p === String(p)), `A uploaded its damaged page ${p} of "${T(hs[1])}"`);
    const notListed = [1, 2, 3].filter(p => !skippedPage(ra.items, T(hs[1]), p));
    assert(!notListed.length, `A does not list its damaged page(s) ${notListed.join(', ')} of "${T(hs[1])}" as skipped: ${JSON.stringify(ra.items).slice(0, 700)}`);
    assert(!hostileIn(await libraryOf(B)).length, hostileIn(await libraryOf(B)).join(' | '));
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6u ---------- */
async function loopFullReceive(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const g = A.google, {a, b, c} = roles(await libraryOf(A));
    const [nw] = await addCopies(A, 1, 'fr', {from: b.id});
    const recv = [[a.id, 1], [b.id, 2], [c.id, 1], [c.id, 3], [nw, 1], [nw, 2]];
    for(const [id, p] of recv) await addEntries(A, id, p, [penLine(`fr_${id}_${p}`, .45, PEN.red)]);
    finished(await syncRead(A), 'Sync A (marks on several pages and a new song with marks)');
    await addEntries(B, b.id, 1, [penLine('frB', .9, PEN.blue)]);                       // a page B must send
    g.quotaFull = true;
    await takeWrites(B);
    const r = await syncRead(B);
    g.quotaFull = false;
    assert(r.state === 'failed' && /Your Google Drive is full/.test(r.text), `a full Drive should end the run with "Your Google Drive is full": ${r.title}: ${r.text.slice(0, 300)}`);
    const writes = await takeWrites(B), half = marksApart(writes, readMarks(g).pages);
    assert(!half.length, half.join(' | '));
    const L = await libraryOf(B), D = readMarks(g).pages;
    assert(L.songs[nw] && L.files[nw] === L.songs[nw].hash, 'the new song did not come down before Drive was found full');
    const notDown = recv.filter(([id, p]) => byIdDiff(D.get(id + ':' + p), L.ink[id + ':' + p]).length);
    assert(!notDown.length, `pages that only needed receiving did not come down before the run ended on a full Drive: ${notDown.map(([id, p]) => id + ':' + p).join(', ')}`);
    assert(liveIds(L.ink[b.id + ':1']).includes('frB') && !whole(L).length, 'B lost its own mark or is not whole');
    /* room again */
    finished(await syncRead(B), 'Sync B (room again)'); finished(await syncRead(A), 'Sync A');
    await sameMarks(A, B, [b.id + ':1', ...recv.map(([id, p]) => id + ':' + p)], 'after the room came back');
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6v ---------- */
async function loopReminders(ctx){
  const {A, B} = await pair6(ctx);
  try{
    const g = A.google, {a, b} = roles(await libraryOf(A));
    for(const [how, setup] of [
      ['a refused page', () => g.failNext(400, {reason: 'badRequest', times: 1000, match: inkUpload(g)})],
      /* the page's upload gets a 5xx and the connection is gone for the retry: the run cannot finish */
      ['a dropped connection at the page', () => g.failNext(503, {times: 1, match: e => { if(!inkUpload(g)(e)) return false; g.offline = true; return true; }})],
    ]){
      await addEntries(B, how === 'a refused page' ? a.id : b.id, how === 'a refused page' ? 1 : 2, [penLine('rem' + how.length, .5, PEN.red)]);
      await backupNow(B.page); await sleep(300);
      assert(!(await shows(B, '[data-backupnow]')), `${how}: right after a backup the backup reminder shows (the test is wrong)`);
      assert(await shows(B, '[data-syncnow]'), `${how}: a new mark does not turn the sync reminder on`);
      setup();
      const r = await syncRead(B);
      g.faults.length = 0; g.offline = false;
      assert(r.state !== 'finished' || /Skipped/.test(r.text), `${how}: the report does not say the page was not sent: ${r.text}`);
      assert(await shows(B, '[data-syncnow]'), `${how}: the page did not go to Drive, but the sync reminder is off`);
      assert(!(await shows(B, '[data-backupnow]')), `${how}: a sync that could not send a page turned the BACKUP reminder on (nothing changed on this tablet since the backup)`);
      const r2 = await syncRead(B);
      finished(r2, `${how}: the next Sync`);
      assert(marksCounts(r2.text).sent >= 1, `${how}: the next Sync did not send the page: ${r2.text}`);
      assert(!(await shows(B, '[data-syncnow]')), `${how}: a finished sync that sent everything leaves the sync reminder on`);
      assert(!(await shows(B, '[data-backupnow]')), `${how}: the finished sync turned the backup reminder on`);
    }
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

/* ---------- 6w ---------- */
async function loopOtherTab(ctx){
  const {A, B} = await pair6(ctx);
  let p2 = null;
  try{
    const g = A.google, {b} = roles(await libraryOf(A)), k1 = b.id + ':1';
    const pdf = await makePdf(2, 'sync6w.pdf'), before = (await libraryOf(A)).songs;
    await newVersionUi(A, b.id, pdf.file);
    const copy = live(await libraryOf(A)).find(s => !before[s.id] && s.archived && s.hash === b.hash);
    finished(await syncRead(A), 'Sync A (New version)');
    const inkFile = readMarks(g).files.get(k1);
    assert(inkFile, 'Drive has no page 1 of the song after New version (the test is wrong)');
    /* B syncs; while its run is reading Drive's page 1 (after it read its own), a stroke is saved on B's old chart from another tab */
    p2 = await B.context.newPage();
    await p2.goto(ctx.base + 'css/app.css');
    g.clearLog(); g.latency = 1500;
    await tapSync(B);
    const end = Date.now() + 60000;
    while(!g.requests.some(e => e.by === 'B' && e.kind === 'download' && e.path.endsWith('/' + inkFile.id))){ if(Date.now() > end) throw new Error('B never read Drive\'s page 1 of the song'); await sleep(40); }
    const tab2 = await p2.evaluate(key => new Promise((res, rej) => {
      const r = indexedDB.open('setlist-stand');
      r.onerror = () => rej(r.error);
      r.onsuccess = () => {
        const d = r.result, t = d.transaction('ink', 'readwrite'), st = t.objectStore('ink'), q = st.get(key);
        let rec;
        q.onsuccess = () => { const cur = q.result || {updated: 0, strokes: []}, now = Date.now();
          rec = {...cur, updated: Math.max(now, cur.updated + 1), strokes: [...cur.strokes, {id: 'tab2', t: 'pen', c: '#1f5fd6', w: .003, p: [[.2, .95], [.8, .95]], updated: now}]}; st.put(rec, key); };
        t.oncomplete = () => { d.close(); res(rec); }; t.onerror = () => rej(t.error);
      };
    }), k1);
    const rep = await finishSync(B);
    g.latency = 0;
    assert(rep.state === 'finished', 'the Sync during the other tab\'s save did not finish: ' + rep.text);
    assert(tab2 && tab2.strokes.some(s => s.id === 'tab2'), 'the other tab did not save its stroke (the test is wrong)');
    const LB = await libraryOf(B), where = Object.entries(LB.ink).filter(([, v]) => liveIds(v).includes('tab2')).map(([k]) => k);
    assert(where.length, 'the stroke saved from another tab during the sync is gone: the sync wrote over it');
    /* the next syncs put it with the old chart, on both tablets */
    finished(await syncRead(B), 'Sync B again'); finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B at the end');
    for(const t of [A, B]){
      const L = await libraryOf(t);
      assert(liveIds(L.ink[copy.id + ':1']).includes('tab2'), `${t.name}: the stroke drawn on the old chart in another tab is not on the archived copy: ${liveIds(L.ink[copy.id + ':1'])}`);
      assert(!liveIds(L.ink[k1]).includes('tab2'), `${t.name}: the stroke drawn on the old chart is on the new chart`);
    }
    noErrors(A, B);
  } finally { if(p2) await p2.close().catch(() => {}); await closeAll(A, B); }
}

/* ---------- 6x ---------- */
async function loopBareList(ctx){
  const A = await startA(ctx);
  let B = null;
  try{
    const {a, b} = roles(await libraryOf(A));
    const bareKey = a.id + ':1', extraKey = b.id + ':2';
    const bareList = [{t: 'pen', c: '#1a1a1a', w: .003, p: [[.2, .3], [.6, .3]]}, {t: 'text', x: .3, y: .6, text: 'old note', size: .018, c: '#d62828'}, {t: 'pen', c: '#1a1a1a', w: .003, p: [[.2, .3], [.6, .3]]}];
    await putPage(A, extraKey, {updated: Date.now(), strokes: [penLine('x1', .5, PEN.red)], zz: 'a field from a later version'});
    B = await makeFromBackup(ctx, A);
    await watchReports(A); await watchReports(B);
    /* the same old id-less page (two of its strokes the same) on both tablets, as an old library restored on each would hold it */
    for(const t of [A, B]){ await putPage(t, bareKey, bareList); assert(Array.isArray((await inkOf(t))[bareKey]), 'the bare list was not stored as it is (the test is wrong)'); }
    assert((await pageOf(B, extraKey)).zz === 'a field from a later version', 'the restore dropped the page\'s unknown field');
    /* A opens the song (the viewer upgrades the page); B does not */
    await openOn(A, a.id, 1); await closeViewer(A);
    finished(await syncRead(A), 'Sync A'); finished(await syncRead(B), 'Sync B'); finished(await syncRead(A), 'Sync A again');
    const pa = await pageOf(A, bareKey), pb = await pageOf(B, bareKey);
    assert(pa && pb && !Array.isArray(pa) && !Array.isArray(pb), 'the old page was not upgraded on both tablets');
    assert(pa.strokes.length === 3 && pb.strokes.length === 3 && liveIds(pa).length === 3, `the old page of 3 marks holds ${pa.strokes.length} on A and ${pb.strokes.length} on B after a sync (the two tablets gave it different ids: ${pa.strokes.map(s => s.id)} | ${pb.strokes.map(s => s.id)})`);
    assert(!byIdDiff(pa, pb).length, 'the old page has different marks on the two tablets: ' + byIdDiff(pa, pb).join(' | '));
    /* the page's own unknown field: kept by an edit here and by the sync */
    await addEntries(A, b.id, 2, [penLine('x2', .6, PEN.blue)]);
    assert((await pageOf(A, extraKey)).zz === 'a field from a later version', 'an edit here dropped the page\'s own unknown field');
    finished(await syncRead(A), 'Sync A (the edit)'); finished(await syncRead(B), 'Sync B (gets it)');
    const xb = await pageOf(B, extraKey);
    assert(xb.zz === 'a field from a later version' && liveIds(xb).join() === 'x1,x2', 'the page\'s unknown field or the edit did not reach B: ' + JSON.stringify(xb).slice(0, 200));
    await upToDate(A, 'Sync A at rest'); await upToDate(B, 'Sync B at rest');
    noErrors(A, B);
  } finally { await closeAll(A, B); }
}

export const loops = [
  {name: loopName('q', 'a mark B made on the old chart never lands on the new chart A put on Drive before hearing of it; A does not count it as got; after both sync, the old marks (B\'s too) are on the archived copy on both'), run: loopOtherChart},
  {name: loopName('r', 'New version whose RECORD upload is refused (the PDF went): none of that song\'s marks reach Drive, the other tablet keeps its marks; once the record goes everything settles'), run: loopRecordRefused},
  {name: loopName('s', 'a mark erased on one tablet before the other tablet\'s New version reached it stays erased on the archived copy, on both'), run: loopErasedStays},
  {name: loopName('t', 'a mark with no usable colour is refused from Drive with a plain reason; damaged pages here (no colour, 50001 entries, a time past the last date) are never uploaded and are listed'), run: loopDamaged},
  {name: loopName('u', 'Drive full with marks to send and pages and a song waiting: everything that only needs receiving comes down first, then the plain "full" sentence'), run: loopFullReceive},
  {name: loopName('v', 'a page send refused or cut off: the sync reminder stays on and the backup reminder is as it was; a finished sync that sent everything clears the sync reminder'), run: loopReminders},
  {name: loopName('w', 'a stroke saved from another tab while a sync replaces the chart is not written over and ends on the archived copy on both tablets'), run: loopOtherTab},
  {name: loopName('x', 'an old id-less page restored on both tablets gets the same ids on both (viewer on one, sync on the other) and is not doubled; a page\'s unknown field survives an edit and a sync'), run: loopBareList},
];

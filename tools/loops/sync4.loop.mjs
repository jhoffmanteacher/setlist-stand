/*
 * Drive sync Part 2, a hostile or broken Drive: "sync 4a" .. "sync 4h". The app runs for real; Drive is the stand-in, edited by
 * hand (files a person, another app or a half-finished write could leave) and made to fail (fake-google.mjs: failNext, latency,
 * offline, quotaFull, maxPage, exposeHeaders) or answered by a route of this file (a file whose size Drive does not say).
 *
 * For every case: a plain message or a "skipped" line naming the item and why; the library whole (no song without its PDF, no
 * PDF or marks without a song; every record either as it was or as the other tablet has it: nothing half written); nothing
 * written for the bad item; the other items still sync; and a SECOND run completes.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {FIX, TMP, assert, sleep, diff, sha256, PDFDocument} from './harness.mjs';
import {openTablet, tapSync, finishSync, syncTap, signIn, libraryOf, readDrive, reportCounts} from './sync-two.mjs';
import {canon} from './sync-model.mjs';
import {startA, startPair, roles, live, libOnly, whole, saveSong, saveSet, writeRecords, addCopies, songRecord, putRecordFile, putPdfFile,
  pdfFileId, waitBox, pageErrors, H, fixture, titleOf, YEAR, addMark, marksOn, deleteSongUi} from './sync-kit.mjs';
import {songAct} from './songrow.mjs';

const WEBKIT = process.env.SS_BROWSER === 'webkit';
const finished = (r, what) => assert(r.state === 'finished', `${what}: the sync did not finish: ${r.title}: ${r.text.slice(0, 500)}`);
const failed = (r, re, what) => assert(r.state === 'failed' && re.test(r.text), `${what}: expected "Sync could not finish" saying ${re}; got ${r.title}: ${r.text.slice(0, 400)}`);
const noErrors = (...ts) => { for(const t of ts){ const e = pageErrors(t); assert(!e.length, `${t.name}: page errors: ${e.join(' | ')}`); } };
const tune = t => t.page.evaluate(async () => { (await import('./js/drive.js')).tuning.pauseMs = 5; });
const setLimit = (t, l) => t.page.evaluate(async l => Object.assign((await import('./js/sync.js')).LIMIT, l), l);
const lastSeg = p => decodeURIComponent(p.split('/').pop());
const pdfIdsOf = google => new Set([...readDrive(google).pdfs.values()].map(p => p.fileId));
const writesBy = (google, by) => google.requests.filter(e => e.by === by && (e.kind === 'upload' || (e.kind === 'drive' && ['POST', 'PATCH', 'DELETE', 'PUT'].includes(e.method))));
async function sameSongs(X, Y, what){
  const clean = lib => ({songs: lib.songs, sets: lib.sets, colls: lib.colls, files: lib.files});
  const d = diff(clean(await libraryOf(X)), clean(await libraryOf(Y)));
  assert(!d.length, `${what}: ${X.name} and ${Y.name} do not hold the same library: ${d.join(' | ')}`);
}
/* Nothing half written: the library is whole and every song record is either the one this tablet had or the one Drive's other
   tablet holds (`ref`). */
async function intact(t, before, ref, what){
  const L = await libraryOf(t), p = whole(L);
  assert(!p.length, `${what}: ${t.name}'s library is not whole: ${p.slice(0, 5).join(' | ')}`);
  for(const s of Object.values(L.songs)){
    const was = before.songs[s.id], there = ref.songs[s.id];
    assert((was && !diff(s, was).length) || (there && !diff(s, there).length), `${what}: the song ${s.id} on ${t.name} is neither its old record nor the other tablet's: ${JSON.stringify(s).slice(0, 200)}`);
  }
  return L;
}
/* A valid PDF with `pad` random bytes in it (an attachment): a new chart with its own hash, of about the size asked for. */
async function makePdf(pad, name){
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  await doc.attach(crypto.randomBytes(pad), 'pad.bin', {mimeType: 'application/octet-stream'});
  const bytes = Buffer.from(await doc.save({useObjectStreams: false}));
  const file = path.join(TMP, name);
  fs.writeFileSync(file, bytes);
  return {bytes, file, hash: sha256(bytes)};
}
async function importPdf(t, file){
  const {page} = t, before = new Set(Object.keys((await libraryOf(t)).songs));
  await page.click('#tLib');
  await page.setInputFiles('#file', file);
  const end = Date.now() + 30000;
  for(;;){
    const now = Object.keys((await libraryOf(t)).songs).filter(id => !before.has(id));
    if(now.length) return (await libraryOf(t)).songs[now[0]];
    if(Date.now() > end) throw new Error(`${t.name}: the PDF ${path.basename(file)} was not added`);
    await sleep(200);
  }
}
async function newVersionUi(t, id, file){
  const {page} = t;
  await page.click('#tLib');
  if(await page.locator('.collbar [data-collpick="all"]').count()) await page.click('.collbar [data-collpick="all"]');
  await songAct(page, 'newversion', id);
  await page.setInputFiles('#newVersionFile', file);
  await page.waitForSelector('.modal.nvask, .modal.dupask', {timeout: 15000});
  if(await page.locator('.modal.dupask').count()){ await page.click('.modal.dupask [data-dupadd]'); await page.waitForSelector('.modal.nvask', {timeout: 15000}); }
  await page.click('.modal.nvask [data-ok]');
  await page.waitForFunction(() => /^New version in place/.test(document.querySelector('#toast').textContent), null, {timeout: 20000});
}

/* ---------- 4a: hostile and broken records on Drive (and two on this tablet) ---------- */
async function loopHostile(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const L0 = await libraryOf(B), {a, b} = roles(L0), drive = readDrive(A.google), t = Date.now(), g = A.google;
    const one = fixture('one-page.pdf'), H1 = H('one-page.pdf');
    const S = (id, more = {}) => songRecord(id, {hash: H1, updated: t, ...more});
    const withPdf = (id, rec, bytes = one, h) => { putPdfFile(g, drive, id, bytes, h ? {h} : {}); return putRecordFile(g, drive, 'song', rec); };
    /* good ones, which must arrive */
    const good = S('h4good');
    withPdf('h4good', good);
    const crop = S('h4crop', {hash: H('three-page.pdf'), pages: 3, crop: {all: {x: null, y: 'a', w: .5, h: .5}, pages: {'1': {x: 0, y: 0, w: 'NaN', h: 1}, '2': null, 'zz': {x: 0, y: 0, w: 1, h: 1}, '3': {x: .1, y: .1, w: .5, h: .5}}}});
    withPdf('h4crop', crop, fixture('three-page.pdf'));
    const crop2 = S('h4crop2', {crop: {all: {x: .1, y: .1, w: .5, h: .5}}});          // a crop with no \`pages\`
    withPdf('h4crop2', crop2);
    const set = {id: 'h4set', name: 'H4 set', created: t, updated: t, colls: [], items: [{type: 'song', id: 'h4good'}, {type: 'break', id: 'h4brk', name: 'Half time'}]};
    putRecordFile(g, drive, 'set', set);
    /* not ours by their properties: left alone and counted */
    putRecordFile(g, drive, 'song', S('h4badprop'), {props: {id: '../x'}, name: 'song-h4badprop.json'});
    withPdf('h4ubig', S('h4ubig')); putRecordFile(g, drive, 'song', S('h4ubig'), {props: {u: '9e15'}});
    withPdf('h4uneg', S('h4uneg')); putRecordFile(g, drive, 'song', S('h4uneg'), {props: {u: '-5'}});
    /* ours by their properties, wrong inside: skipped and named */
    const badc = {...S('h4badc'), id: '<b>x'};
    putPdfFile(g, drive, 'h4badc', one); putRecordFile(g, drive, 'song', badc, {props: {id: 'h4badc'}});
    withPdf('h4huge', S('h4huge', {title: 'x'.repeat(3000), song: 'x'.repeat(3000)}));
    withPdf('h4bigrec', S('h4bigrec', {pad: 'y'.repeat(1.1e6)}));
    putRecordFile(g, drive, 'song', S('h4nopdf'));
    withPdf('h4wrong', S('h4wrong'), fixture('two-page.pdf'), H1);
    const notPdf = Buffer.from('This is not a PDF at all, only some text that a person saved as a file.');
    withPdf('h4notpdf', S('h4notpdf', {hash: sha256(notPdf)}), notPdf);
    putRecordFile(g, drive, 'song', {id: 'h4ghost', deleted: true, updated: t});
    withPdf('h4ustr', {...S('h4ustr'), updated: String(t)});
    withPdf('h4uarr', {...S('h4uarr'), updated: [t]});
    /* a "deletion" flag on a live record, and a marker with no flag, over two songs this tablet has */
    putRecordFile(g, drive, 'song', {...drive.recs.song.get(a.id), updated: a.updated + 1000}, {props: {d: '1'}});
    putRecordFile(g, drive, 'song', {id: b.id, deleted: true, updated: b.updated + 1000}, {props: {d: undefined}});
    /* this tablet's own records with times that are not dates */
    await B.page.evaluate(async () => {
      const st = await import('./js/store.js'), blob = new Blob([await (await st.get('files', st.state.songs[0].id)).arrayBuffer()], {type: 'application/pdf'}), t = Date.now();
      await st.putAll([{store: 'files', key: 'h4lstr', value: blob}, {store: 'songs', key: 'h4lstr', value: {...st.state.songs[0], id: 'h4lstr', title: 'h4lstr', song: 'h4lstr', artist: '', version: '', colls: [], updated: 'soon'}},
        {store: 'sets', key: 'h4lbig', value: {id: 'h4lbig', name: 'H4 local big', created: t, colls: [], items: [], updated: 9e15}}]);
      await st.load();
    });
    const before = await libraryOf(B);
    const BAD = ['h4badprop', '../x', 'h4ubig', 'h4uneg', 'h4badc', '<b>x', 'h4huge', 'h4bigrec', 'h4nopdf', 'h4wrong', 'h4notpdf', 'h4ghost', 'h4ustr', 'h4uarr'];
    const ROWS = [['h4badc', 'belongs to another record'], ['h4huge', 'is not valid'], ['h4bigrec', 'is too big'], ['h4nopdf', 'its PDF is not in Drive'],
      ['h4wrong', 'does not match its details'], ['h4notpdf', 'is not a PDF'], ['h4ustr', 'changed outside the app'], ['h4uarr', 'changed outside the app'],
      [a.title, 'changed outside the app'], [b.title, 'changed outside the app'], ['h4lstr', 'its time is not a date'], ['H4 local big', 'its time is not a date']];
    const driveBefore = new Map([...g.files.values()].map(f => [f.id, JSON.stringify([f.appProperties, f.content ? sha256(f.content) : null])]));

    const check = async (r, what) => {
      finished(r, what);
      assert(!r.asked.length, `${what}: a deletion box came up (a record that only looks like a deletion was taken for one): ${JSON.stringify(r.asked)}`);
      for(const [name, why] of ROWS){
        const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ': [^:]*' + why.replace(/[()]/g, '\\$&'));
        assert(re.test(r.text), `${what}: the report does not list "${name}" as skipped because it ${why}: "${r.text.slice(0, 1600)}"`);
      }
      assert(/3 files in your Drive folder did not come from this app and were left alone/.test(r.text), `${what}: the report does not count the 3 files that are not ours: "${r.text.slice(0, 600)}"`);
      const L = await libraryOf(B);
      for(const id of BAD) for(const k of ['songs', 'sets', 'files']) assert(!(id in L[k]), `${what}: something was written for the bad item ${id} (${k})`);
      const p = whole(L).filter(x => !/h4lstr/.test(x));
      assert(!p.length, `${what}: the library is not whole: ${p.join(' | ')}`);
      for(const [id, was] of driveBefore){ const f = g.files.get(id); assert(f && JSON.stringify([f.appProperties, f.content ? sha256(f.content) : null]) === was, `${what}: a file on Drive was changed or removed: ${f ? f.name : id}`); }
      assert(!writesBy(g, 'B').length, `${what}: B wrote to Drive: ${writesBy(g, 'B').map(e => e.method + ' ' + e.path).join(', ')}`);
      return L;
    };
    g.clearLog();
    const r1 = await syncTap(B);
    const L1 = await check(r1, 'the first Sync with a hostile Drive');
    const n1 = reportCounts(r1.text);
    assert(n1.got.song === 3 && n1.got.set === 1 && !n1.sent.song && !n1.sent.set && !n1.sent.coll, `the first Sync should get 3 songs and 1 setlist and send nothing: "${r1.text.slice(0, 300)}"`);
    const rest = lib => { const o = JSON.parse(JSON.stringify(libOnly(lib))); for(const k of ['songs', 'files']){ delete o[k].h4good; delete o[k].h4crop; delete o[k].h4crop2; } delete o.sets.h4set; return o; };
    let d = diff(rest(L1), libOnly(before));
    assert(!d.length, 'the hostile Drive changed records it should not have: ' + d.join(' | '));
    assert(!diff(L1.songs.h4good, good).length && L1.files.h4good === H1 && !diff(L1.sets.h4set, set).length, 'the good song or setlist was not stored as it is on Drive: ' + JSON.stringify([L1.songs.h4good, L1.sets.h4set]).slice(0, 300));
    assert(!diff(L1.songs.h4crop2, crop2).length, 'the song with a crop that has no pages was not stored as it is');
    assert(L1.files.h4crop === H('three-page.pdf') && !diff(L1.songs.h4crop, crop).length, 'the song with a damaged crop was not stored exactly as Drive holds it: ' + JSON.stringify(L1.songs.h4crop.crop));
    /* ...and every page of it is still drawn (not blank) */
    await B.page.click('#tLib');
    await B.page.click('#libList [data-open="h4crop"]');
    await B.page.waitForSelector('#vCrop', {state: 'visible'});
    for(let pn = 1; pn <= 3; pn++){
      const inked = await B.page.waitForFunction(() => {
        const cv = document.querySelector('#stage .sheet canvas:not(.ink)'); if(!cv || !cv.width) return 0;
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0;
        for(let i = 0; i < d.length; i += 4) if(d[i] < 160 && d[i + 3] > 0) n++;
        return n;
      }, null, {timeout: 8000}).then(h => h.jsonValue()).catch(() => 0);
      assert(inked > 20, `page ${pn} of the song with a damaged crop is drawn blank (${inked} dark pixels)`);
      if(pn < 3){ await B.page.click('#vNext'); await sleep(400); }
    }
    await B.page.click('#vBack'); await B.page.waitForSelector('#libList');
    noErrors(B);

    g.clearLog();
    const r2 = await syncTap(B);
    const L2 = await check(r2, 'the second Sync');
    const n2 = reportCounts(r2.text);
    assert(!n2.got.song && !n2.got.set && !n2.sent.song, `the second Sync should get and send nothing: "${r2.text.slice(0, 300)}"`);
    d = diff(libOnly(L2), libOnly(L1));
    assert(!d.length, 'the second Sync changed the library: ' + d.join(' | '));
    /* the Crop screen opens on the damaged crop, and a crop can be saved over it */
    await B.page.click('#tLib');
    await B.page.click('#libList [data-open="h4crop"]');
    await B.page.waitForSelector('#vCrop', {state: 'visible'}); await sleep(400);
    await B.page.click('#vCrop');
    await B.page.waitForSelector('#cropper:not([hidden])', {timeout: 8000}); await sleep(300);
    await B.page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
    await B.page.click('#cropSong');
    await B.page.waitForFunction(() => /Cropped the whole song/.test(document.querySelector('#toast').textContent), null, {timeout: 8000})
      .catch(async () => { throw new Error('saving a crop over the damaged one did not work: ' + await B.page.locator('#toast').textContent() + ' ' + pageErrors(B).join(' | ')); });
    const saved = (await libraryOf(B)).songs.h4crop.crop;
    /* the box opened on the whole page (the damaged rectangles are not used), so "crop the whole song" saves no crop at all */
    assert(saved && JSON.stringify(saved.pages) === '{}' && (saved.all === null || ['x', 'y', 'w', 'h'].every(k => Number.isFinite(saved.all[k]))), 'the crop saved over the damaged one still holds damaged parts: ' + JSON.stringify(saved));
    await B.page.click('#vBack'); await B.page.waitForSelector('#libList');
    /* a page crop saved on a song whose crop came without `pages` */
    await B.page.click('#libList [data-open="h4crop2"]');
    await B.page.waitForSelector('#vCrop', {state: 'visible'}); await sleep(400);
    await B.page.click('#vCrop');
    await B.page.waitForSelector('#cropper:not([hidden])', {timeout: 8000}); await sleep(300);
    await B.page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
    await B.page.click('#cropPage');
    await B.page.waitForFunction(() => /Cropped page 1/.test(document.querySelector('#toast').textContent), null, {timeout: 8000})
      .catch(async () => { throw new Error('saving a page crop on a song whose crop has no pages did not work: ' + pageErrors(B).join(' | ')); });
    await B.page.click('#vBack'); await B.page.waitForSelector('#libList');
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 4b: dates and shapes: upgraded on load, a row field nobody knows, equal times, a year ahead ---------- */
async function loopDates(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const g = A.google, drive = readDrive(g), t = Date.now(), {a, b, gig} = roles(await libraryOf(A));
    /* a song and a setlist that load() would upgrade (no colls, a title not made from the details, a break with no name) */
    putPdfFile(g, drive, 'h4upg', fixture('one-page.pdf'));
    putRecordFile(g, drive, 'song', {id: 'h4upg', title: 'Not derived', song: 'Upg', artist: 'X', version: '', archived: false, pages: 1, hash: H('one-page.pdf'), added: t, updated: t});
    putRecordFile(g, drive, 'set', {id: 'h4upgset', name: 'Upg set', created: t, updated: t, items: [{type: 'break', id: 'h4bk', name: ''}, {type: 'song', id: 'h4upg'}]});
    /* a field this version does not know on a setlist row */
    await saveSet(A, gig.id, {items: gig.items.map((it, i) => i === 0 ? {...it, cue: {fade: 2}} : it)});
    await A.page.reload(); await A.page.waitForSelector('#libList');
    assert(JSON.stringify((await libraryOf(A)).sets[gig.id].items[0].cue) === '{"fade":2}', 'a field on a setlist row did not survive a reload (load())');
    finished(await syncTap(A), 'Sync A');
    finished(await syncTap(B), 'Sync B');
    const LB = await libraryOf(B);
    assert(LB.songs.h4upg && LB.files.h4upg && LB.sets.h4upgset, 'the records to upgrade did not arrive');
    assert(JSON.stringify(LB.sets[gig.id].items[0].cue) === '{"fade":2}', 'a field on a setlist row was lost on the way to B: ' + JSON.stringify(LB.sets[gig.id].items[0]));
    for(const t2 of [B, A]){
      const r = await syncTap(t2);
      finished(r, `the next Sync on ${t2.name}`);
      assert(/Everything is up to date/.test(r.text), `after one Sync the upgraded records come again on ${t2.name} (they must settle): "${r.text}"`);
    }

    /* equal `updated`, different content on the two tablets: one winner, the same on both, then calm */
    const U = Math.max(await A.page.evaluate(() => Date.now()), await B.page.evaluate(() => Date.now())) + 5000;
    const tie = async (tb, version) => { const cur = (await libraryOf(tb)).songs[b.id], rec = {...cur, version, updated: U}; rec.title = titleOf(rec); await writeRecords(tb, [{store: 'songs', key: b.id, value: rec}]); return rec; };
    const ta = await tie(A, 'tie zzz'), tb = await tie(B, 'tie aaa');
    finished(await syncTap(A), 'Sync A (its side of the tie)');
    finished(await syncTap(B), 'Sync B (equal times)');
    finished(await syncTap(A), 'Sync A (equal times)');
    const want = canon(ta) >= canon(tb) ? ta : tb;
    for(const t2 of [A, B]) assert(!diff((await libraryOf(t2)).songs[b.id], want).length, `${t2.name} did not settle on the same record of the tie: ${JSON.stringify((await libraryOf(t2)).songs[b.id]).slice(0, 200)}`);
    for(const t2 of [B, A]) assert(/Everything is up to date/.test((await syncTap(t2)).text), `the tie keeps coming back on ${t2.name}`);

    /* a record dated a year ahead: still synced, the report says so, and a later edit on the other tablet still wins */
    const F = Date.now() + YEAR, fut = {...readDrive(g).recs.song.get(a.id), version: 'from the future', updated: F};
    fut.title = titleOf(fut);
    putRecordFile(g, readDrive(g), 'song', fut);
    const rf = await syncTap(B);
    finished(rf, 'Sync B (a record a year ahead)');
    assert(/1 record has a date more than a day ahead/.test(rf.text) && reportCounts(rf.text).got.song === 1, `the report does not say a date is ahead, or the record did not come: "${rf.text}"`);
    assert(!diff((await libraryOf(B)).songs[a.id], fut).length, 'the record dated ahead was not stored on B');
    const later = await saveSong(B, a.id, {version: 'later on B'});
    assert(later.updated > F, `an edit after a record dated ahead did not beat it (${later.updated} <= ${F})`);
    finished(await syncTap(B), 'Sync B (its later edit)');
    const ra = await syncTap(A);
    finished(ra, 'Sync A (gets B\'s later edit)');
    assert((await libraryOf(A)).songs[a.id].version === 'later on B', 'the edit made after the record dated ahead did not win on A');
    await sameSongs(A, B, 'at the end of 4b');
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 4c: Google in trouble: paging, 429, 500, a 500 that does not stop, offline and 401 part-way ---------- */
async function loopTrouble(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const g = A.google;
    await tune(B);
    let tag = 0;
    const prep = async (n = 3) => { await addCopies(A, n, 't' + (++tag)); finished(await syncTap(A), 'Sync A (new songs for B)'); return {before: await libraryOf(B), ref: await libraryOf(A), pdfs: pdfIdsOf(g)}; };
    const pdfDl = pdfs => e => e.by === 'B' && e.kind === 'download' && pdfs.has(lastSeg(e.path));
    const done = async what => { finished(await syncTap(B), what); await sameSongs(A, B, what); };

    let p = await prep(5);
    g.maxPage = 2; g.clearLog();
    await done('a listing in pages of two');
    g.maxPage = 0;
    assert(g.requests.filter(e => e.by === 'B' && e.query.pageToken).length >= 2, 'the listing was not read in several pages (the test did nothing)');

    for(const status of [429, 500]){
      p = await prep(2); g.clearLog();
      g.failNext(status, {match: pdfDl(p.pdfs)});
      await done(`${status} once, then success`);
      assert(g.requests.some(e => e.status === status), `the ${status} was never sent (the test did nothing)`);
    }

    p = await prep(2);
    g.failNext(500, {times: 1000, match: pdfDl(p.pdfs)});
    failed(await syncTap(B), /Google is busy/, 'a 500 that does not stop');
    g.faults.length = 0;
    await intact(B, p.before, p.ref, 'after a 500 that does not stop');
    await done('the Sync after the 500s');

    p = await prep(3);
    let n = 0;
    g.failNext(599, {match: e => { if(pdfDl(p.pdfs)(e) && ++n === 2) g.offline = true; return false; }});
    const ro = await syncTap(B);
    g.offline = false; g.faults.length = 0;
    failed(ro, /connection to Google was lost/, 'offline part-way');
    assert(/Got [12] songs?\./.test(ro.text), `the report after going offline does not say what was kept: "${ro.text}"`);
    await intact(B, p.before, p.ref, 'after going offline part-way');
    await done('the Sync after going offline');

    p = await prep(3); n = 0;
    g.failNext(401, {match: e => pdfDl(p.pdfs)(e) && ++n === 2});
    const ru = await syncTap(B);
    failed(ru, /sign-in ran out/, '401 part-way');
    assert(/Got 1 song/.test(ru.text) && /Tap Sync/.test(ru.text), `the report after the sign-in ran out does not say what was kept and to Sync again: "${ru.text}"`);
    await intact(B, p.before, p.ref, 'after a 401 part-way');
    await done('the Sync after signing in again');
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 4d: uploads refused: Drive full; a PDF over 5 MB when the upload address cannot be read ---------- */
async function loopUploads(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const g = A.google;
    const song = await importPdf(B, path.join(FIX, 'songbook.pdf'));
    let before = await libraryOf(B);
    g.quotaFull = true;
    failed(await syncTap(B), /Drive is full/, 'Drive full');
    g.quotaFull = false;
    assert(!diff(libOnly(await libraryOf(B)), libOnly(before)).length, 'a refused upload changed the library');
    assert(!g.byProp('id', song.id).length, 'something of the song was written to a full Drive');
    const r1 = await syncTap(B);
    finished(r1, 'the Sync after Drive has room again');
    assert(reportCounts(r1.text).sent.song === 1 && readDrive(g).recs.song.get(song.id) && readDrive(g).pdfs.get(song.id), 'the song did not go up once Drive had room');

    const big = await makePdf(5.6e6, 'sync4-big-chart.pdf');
    const bigSong = await importPdf(B, big.file);
    const [small] = await addCopies(B, 1, 'up');
    assert(bigSong.hash === big.hash, 'the big chart was not stored as it is');
    before = await libraryOf(B);
    const keep = [...g.exposeHeaders];
    g.exposeHeaders = keep.filter(h => h !== 'location');
    const r2 = await syncTap(B);
    g.exposeHeaders = keep;
    finished(r2, 'a PDF over 5 MB that cannot be sent from this tablet');
    assert(r2.text.includes(bigSong.title + ': ') && reportCounts(r2.text).sent.song === 1, `the big song is not listed as skipped, or the small one was not sent: "${r2.text}"`);
    let drive = readDrive(g);
    assert(!drive.recs.song.get(bigSong.id) && !drive.pdfs.get(bigSong.id) && drive.recs.song.get(small) && drive.pdfs.get(small), 'the big song was half sent, or the small one not at all');
    assert(!diff(libOnly(await libraryOf(B)), libOnly(before)).length, 'the refused upload changed the library');
    const r3 = await syncTap(B);
    finished(r3, 'the big PDF once its upload address can be read');
    drive = readDrive(g);
    assert(drive.pdfs.get(bigSong.id) && drive.pdfs.get(bigSong.id).hash === big.hash && drive.recs.song.get(bigSong.id), 'the big PDF did not go up whole');
    assert(g.requests.some(e => e.by === 'B' && e.kind === 'upload' && e.method === 'PUT'), 'the big PDF did not go up as a resumable upload');
    assert(!B.watch.violations.length, 'order on Drive: ' + B.watch.violations.join(' | '));
    finished(await syncTap(A), 'Sync A (gets the big chart)');
    assert((await libraryOf(A)).files[bigSong.id] === big.hash, 'A did not get the big chart byte for byte');
    await sameSongs(A, B, 'at the end of 4d');
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 4e: Stop part-way; a reload while a song is downloading ---------- */
async function loopInterrupted(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const g = A.google;
    await addCopies(A, 4, 'st'); finished(await syncTap(A), 'Sync A');
    let before = await libraryOf(B), ref = await libraryOf(A);
    g.latency = 400;
    await tapSync(B);
    await waitBox(B, /^Syncing/);
    const end = Date.now() + 30000;
    while(!/Getting 2 of/.test(await B.page.locator('.modal p[role=status]').textContent().catch(() => ''))){ if(Date.now() > end) throw new Error('the Syncing box never said "Getting 2 of"'); await sleep(50); }
    await B.page.locator('.modal').last().getByRole('button', {name: 'Stop', exact: true}).click();
    const rs = await finishSync(B);
    g.latency = 0;
    assert(rs.state === 'stopped' && /You stopped it/.test(rs.text), 'Stop did not end the run with "Sync stopped": ' + rs.text);
    const Ls = await intact(B, before, ref, 'after Stop');
    assert(['cpst0', 'cpst1', 'cpst2', 'cpst3'].filter(id => Ls.songs[id]).length < 4, 'Stop did not stop anything (the test did nothing)');
    finished(await syncTap(B), 'the Sync after Stop');
    await sameSongs(A, B, 'after Stop and a second Sync');

    await addCopies(A, 3, 'rl'); finished(await syncTap(A), 'Sync A');
    before = await libraryOf(B); ref = await libraryOf(A);
    const pdfs = pdfIdsOf(g);
    g.latency = 1500;
    await tapSync(B);
    const e2 = Date.now() + 30000;
    while(!g.requests.some(e => e.by === 'B' && e.kind === 'download' && e.status === null && pdfs.has(lastSeg(e.path)))){ if(Date.now() > e2) throw new Error('no PDF download was ever in flight'); await sleep(30); }
    await B.page.reload(); await B.page.waitForSelector('#libList');
    g.latency = 0;
    await sleep(1800);                                                // the cut-off answer arrives (or not) after the reload
    await intact(B, before, ref, 'after a reload part-way through a download');
    finished(await syncTap(B), 'the Sync after the reload (signs in again)');
    await sameSongs(A, B, 'after the reload and a second Sync');
    noErrors(A);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 4f: limits: one PDF over LIMIT.pdf, a file with no size over it, the per-run budget ---------- */
async function loopLimits(ctx){
  const A = await startA(ctx);
  let B = null;
  try{
    const g = A.google, {c} = roles(await libraryOf(A));
    await addCopies(A, 2, 'l');
    finished(await syncTap(A), 'Sync A');
    B = await openTablet(ctx, {name: 'B', share: A});
    await signIn(B);
    await setLimit(B, {pdf: 1200});                                      // three-page.pdf is 1366 bytes, the others are smaller
    const r1 = await syncTap(B);
    finished(r1, 'a PDF over the limit');
    let LB = await libraryOf(B);
    assert(r1.text.includes(`${c.title}: its PDF is too big`) && !LB.songs[c.id] && !LB.files[c.id], `the PDF over the limit was not skipped by name: "${r1.text}"`);
    assert(live(LB).length === live(await libraryOf(A)).length - 1 && !whole(LB).length, 'the songs under the limit did not all arrive whole');

    /* a PDF whose size Drive does not say (no Content-Length, listed small) and that is over the limit */
    let served = 0;
    if(!WEBKIT){
      const bigS = await makePdf(3e6, 'sync4-stream.pdf'), drive = readDrive(g);
      putPdfFile(g, drive, 'h4stream', fixture('one-page.pdf'), {h: bigS.hash});
      putRecordFile(g, drive, 'song', songRecord('h4stream', {hash: bigS.hash}));
      const fid = pdfFileId(g, 'h4stream');
      await B.context.route('https://www.googleapis.com/drive/v3/files/**', async route => {
        const r = route.request(), u = new URL(r.url());
        if(r.method() !== 'GET' || u.pathname !== '/drive/v3/files/' + fid || u.searchParams.get('alt') !== 'media') return route.fallback();
        served++;
        const origin = (await r.allHeaders()).origin;
        return route.fulfill({status: 200, body: bigS.bytes, headers: {'content-type': 'application/pdf', 'content-length': '0', 'access-control-allow-origin': origin || '*', 'access-control-expose-headers': 'content-length, content-type'}});
      });
      await setLimit(B, {pdf: 2e6});
      const r2 = await syncTap(B);
      finished(r2, 'a file with no size over the limit');
      LB = await libraryOf(B);
      assert(served >= 1, 'the file with no size was never asked for (the test did nothing)');
      assert(r2.text.includes('h4stream: its PDF is too big') && !LB.songs.h4stream && !LB.files.h4stream, `a download over the limit with no size was not stopped: "${r2.text}"`);
      await setLimit(B, {pdf: 100e6});
      finished(await syncTap(B), 'the same file under the limit');
      LB = await libraryOf(B);
      assert(LB.files.h4stream === bigS.hash, 'the same file, under the limit, was not stored (the case is not real)');
    }else{
      /* WebKit: the route that answers with no size is Chromium-only (a fulfilled body with content-length 0 is not checked there);
         the song skipped for LIMIT.pdf is fetched here instead, so the budget below starts from the same library */
      await setLimit(B, {pdf: 100e6});
      finished(await syncTap(B), 'the PDF under the limit again');
    }
    assert((await libraryOf(B)).files[c.id] === c.hash, 'the song skipped for LIMIT.pdf did not arrive once the limit was lifted');

    /* the per-run download budget */
    await setLimit(B, {pdf: 100e6});
    const ids = await addCopies(A, 4, 'rn', {from: c.id});
    finished(await syncTap(A), 'Sync A');
    await setLimit(B, {run: 3000});                                    // two of the 1366-byte PDFs
    const r4 = await syncTap(B);
    finished(r4, 'the per-run budget');
    LB = await libraryOf(B);
    assert(/songs? (was|were) not downloaded this time/.test(r4.text) && ids.filter(id => LB.songs[id]).length === 2, `the budget did not stop at two songs and say so: "${r4.text}"`);
    assert(!whole(LB).length, 'the library is not whole after the budget: ' + whole(LB).join(' | '));
    const r5 = await syncTap(B);
    finished(r5, 'the next run after the budget');
    LB = await libraryOf(B);
    assert(!/not downloaded this time/.test(r5.text) && ids.every(id => LB.files[id]), `the next run did not get the rest: "${r5.text}"`);
    noErrors(A, B);
  } finally { await A.close(); if(B) await B.close(); }
}

/* ---------- 4g: Google refuses one file (skipped, the rest arrive); five refusals in a row end the run ---------- */
async function loopRefusals(ctx){
  const A = await startA(ctx);
  let B = null;
  try{
    const g = A.google;
    const ids = await addCopies(A, 3, 'g');
    finished(await syncTap(A), 'Sync A');
    B = await openTablet(ctx, {name: 'B', share: A});
    await signIn(B);
    const f1 = pdfFileId(g, ids[0]), f2 = pdfFileId(g, ids[1]), LA = await libraryOf(A);
    const dl = f => e => e.by === 'B' && e.kind === 'download' && lastSeg(e.path) === f;
    g.failNext(403, {reason: 'cannotDownloadFile', times: 2, match: dl(f1)});      // refused every time it is asked for in this run
    g.failNext(400, {reason: 'badRequest', times: 2, match: dl(f2)});
    const r1 = await syncTap(B);
    g.faults.length = 0;
    finished(r1, 'one file refused');
    let LB = await libraryOf(B);
    assert(r1.text.includes(`${LA.songs[ids[0]].title}: Google would not give or take it (403 cannotDownloadFile)`) && r1.text.includes(`${LA.songs[ids[1]].title}: Google would not give or take it (400`), `the refused files are not listed by name with the reason: "${r1.text}"`);
    assert(!LB.songs[ids[0]] && !LB.songs[ids[1]] && live(LB).length === live(LA).length - 2 && !whole(LB).length, 'the other songs did not all arrive whole');
    const r2 = await syncTap(B);
    finished(r2, 'the Sync after the refusals');
    assert(reportCounts(r2.text).got.song === 2, 'the next Sync did not get the two refused songs: ' + r2.text);

    const more = await addCopies(A, 6, 'h');
    finished(await syncTap(A), 'Sync A');
    const pdfs = new Set(more.map(id => pdfFileId(g, id)));
    const before = await libraryOf(B);
    g.failNext(403, {reason: 'cannotDownloadFile', times: 5, match: e => e.by === 'B' && e.kind === 'download' && pdfs.has(lastSeg(e.path))});
    const r3 = await syncTap(B);
    g.faults.length = 0;
    assert(r3.state === 'failed', 'five refusals in a row did not end the run (it is not about one file): ' + r3.text);
    await intact(B, before, await libraryOf(A), 'after five refusals');
    finished(await syncTap(B), 'the Sync after five refusals');
    LB = await libraryOf(B);
    assert(more.every(id => LB.files[id]), 'the Sync after five refusals did not get every song');
    noErrors(A, B);
  } finally { await A.close(); if(B) await B.close(); }
}

/* ---------- 4h: a chart is never lost; New version does not double ---------- */
async function loopCharts(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const {a, b} = roles(await libraryOf(A));
    const hashesOf = lib => new Set(Object.values(lib.files));
    const replaced = lib => live(lib).filter(s => /replaced \d{4}-\d\d-\d\d/.test(s.version || ''));
    /* the normal flow: New version on A, the archived old chart and the new one reach B, nothing doubled */
    const p1 = await makePdf(2000, 'sync4-new-b.pdf');
    await newVersionUi(A, b.id, p1.file);
    finished(await syncTap(A), 'Sync A (a New version)');
    const rb = await syncTap(B);
    finished(rb, 'Sync B (gets the New version)');
    let LA = await libraryOf(A), LB = await libraryOf(B);
    assert(!/replaced by a newer one/.test(rb.text) && !replaced(LB).length, `the normal New version flow left B with a "replaced" copy: "${rb.text}"`);
    assert(JSON.stringify(Object.keys(LA.songs).sort()) === JSON.stringify(Object.keys(LB.songs).sort()) && LB.files[b.id] === p1.hash && hashesOf(LB).has(b.hash), 'B does not hold the same songs as A after the New version (or lost the old chart)');

    /* the review's case: New version of a on A, then a later change of a's details on B: B's record (old chart) wins */
    const p2 = await makePdf(2000, 'sync4-new-a.pdf');
    await newVersionUi(A, a.id, p2.file);
    await sleep(30);
    await saveSong(B, a.id, {version: 'details on B'});
    finished(await syncTap(A), 'Sync A (New version of a)');
    finished(await syncTap(B), 'Sync B (its later details of a)');
    const ra = await syncTap(A);
    finished(ra, 'Sync A (gets B\'s record of a)');
    finished(await syncTap(B), 'Sync B');
    LA = await libraryOf(A); LB = await libraryOf(B);
    const everywhere = new Set([...hashesOf(LA), ...hashesOf(LB), ...[...readDrive(A.google).pdfs.values()].map(p => p.hash)]);
    assert(everywhere.has(p2.hash) && everywhere.has(a.hash), 'a chart was lost: the new chart or the old one is on neither tablet nor Drive');
    assert(hashesOf(LA).has(p2.hash) && hashesOf(LB).has(p2.hash), 'the new chart A made is not kept on both tablets');
    assert(/^.+: now plays the chart from your other tablet\. The chart it had is in Archived\./m.test(ra.text), `A's report does not name the song and say its old chart was kept in Archived: "${ra.text}"`);
    const rep = replaced(LA);
    assert(rep.length === 1 && rep[0].archived === true && LA.files[rep[0].id] === p2.hash, 'the replaced chart is not one archived copy on A: ' + JSON.stringify(rep).slice(0, 300));
    assert(!whole(LA).length && !whole(LB).length, 'not whole: ' + [...whole(LA), ...whole(LB)].join(' | '));
    await sameSongs(A, B, 'at the end of 4h');
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 4i: a file refused once and given the next time it is asked for, in the same run ---------- */
async function loopRefusedOnce(ctx){
  const A = await startA(ctx);
  let B = null;
  try{
    const g = A.google, ids = await addCopies(A, 2, 'o');
    finished(await syncTap(A), 'Sync A');
    B = await openTablet(ctx, {name: 'B', share: A});
    await signIn(B);
    const f1 = pdfFileId(g, ids[0]), title = (await libraryOf(A)).songs[ids[0]].title;
    g.failNext(403, {reason: 'cannotDownloadFile', match: e => e.by === 'B' && e.kind === 'download' && lastSeg(e.path) === f1});
    const r = await syncTap(B);
    finished(r, 'one refusal');
    const stored = !!(await libraryOf(B)).files[ids[0]], listed = r.text.includes(title + ': ');
    assert(stored !== listed, `the report must tell the truth about "${title}": it is ${stored ? '' : 'not '}stored and ${listed ? '' : 'not '}listed as "Skipped, and nothing was written": "${r.text}"`);
    noErrors(A, B);
  } finally { await A.close(); if(B) await B.close(); }
}

/* ---------- 4j: the per-run budget says how many songs were left for next time ---------- */
async function loopBudgetCount(ctx){
  const A = await startA(ctx);
  let B = null;
  try{
    const {c} = roles(await libraryOf(A));
    await addCopies(A, 4, 'b', {from: c.id});
    finished(await syncTap(A), 'Sync A');
    B = await openTablet(ctx, {name: 'B', share: A});
    await signIn(B);
    const LA = await libraryOf(A), want = live(LA).length;
    await setLimit(B, {run: 3000});                                    // two of the 1366-byte PDFs (the others are smaller)
    const r = await syncTap(B), LB = await libraryOf(B);
    finished(r, 'the per-run budget');
    const left = want - live(LB).length, m = /(\d+) songs? (?:was|were) not downloaded this time/.exec(r.text);
    assert(left > 0 && m && Number(m[1]) === left, `${left} songs were left for the next Sync, the report says: "${r.text}"`);
    noErrors(A, B);
  } finally { await A.close(); if(B) await B.close(); }
}

/* ---------- 4k: the marks follow the old chart (New version on the other tablet) ---------- */
async function loopMarks(ctx){
  const {A, B} = await startPair(ctx);
  let A2 = null, B2 = null;
  try{
    const {b} = roles(await libraryOf(A));                                     // two pages; the fixture library has a mark on page 1 on both tablets
    const shared = marksOn(await libraryOf(A), b.id, 1);
    await addMark(A, b.id, 2, 'markA2'); await addMark(A, b.id, 1, 'markA1');
    await addMark(B, b.id, 1, 'markB1');
    const oldA = {1: marksOn(await libraryOf(A), b.id, 1), 2: marksOn(await libraryOf(A), b.id, 2)};
    const p1 = await makePdf(1500, 'sync4-marks-new.pdf');                      // a ONE-page new chart
    await newVersionUi(B, b.id, p1.file);
    const LB0 = await libraryOf(B), copyB = live(LB0).find(s => s.id !== b.id && s.hash === b.hash && s.archived);
    assert(copyB && marksOn(LB0, copyB.id, 1).includes('markB1'), 'B\'s New version did not keep the old chart and B\'s marks as an archived copy (the test is wrong)');
    finished(await syncTap(B), 'Sync B (New version)');
    const ra = await syncTap(A);
    finished(ra, 'Sync A (gets the new chart)');
    const LA = await libraryOf(A);
    assert(LA.files[b.id] === p1.hash, 'A did not get the new chart');
    assert(!marksOn(LA, b.id, 1).length && !LA.ink[b.id + ':2'], `A's song now shows the new chart with the old chart's marks: page 1 ${JSON.stringify(marksOn(LA, b.id, 1))}, page 2 ${LA.ink[b.id + ':2'] ? 'still there' : 'gone'}`);
    const h1 = live(LA).filter(s => s.hash === b.hash);
    assert(h1.length === 1 && h1[0].id === copyB.id, `A should hold the old chart once, as B's archived copy (no second copy with the same bytes): ${JSON.stringify(h1.map(s => [s.id, s.version]))}`);
    /* Part 3: the archived copy holds A's marks on the old chart AND B's (B's copy came with its marks): the union, by id */
    const both = pn => [...new Set([...oldA[pn], ...marksOn(LB0, copyB.id, pn)])].sort();
    for(const pn of [1, 2]) assert(JSON.stringify(marksOn(LA, copyB.id, pn)) === JSON.stringify(both(pn)), `A's archived copy page ${pn} should hold A's old marks and B's: ${JSON.stringify(marksOn(LA, copyB.id, pn))} (expected ${JSON.stringify(both(pn))})`);
    finished(await syncTap(B), 'Sync B (gets A\'s old marks on the archived copy)');
    const LB1 = await libraryOf(B);
    for(const pn of [1, 2]) assert(JSON.stringify(marksOn(LB1, copyB.id, pn)) === JSON.stringify(both(pn)), `B's archived copy page ${pn} does not end with both tablets' old marks: ${JSON.stringify(marksOn(LB1, copyB.id, pn))} (expected ${JSON.stringify(both(pn))})`);
    assert(!marksOn(LB1, b.id, 1).length, 'B\'s new chart has marks of the old one after A\'s Sync');
    assert(!/now plays the chart from your other tablet/.test(ra.text), 'A says a chart was kept in Archived although B\'s archived copy already holds it: ' + ra.text);
    assert(shared.length, 'the fixture mark is missing (the test is wrong)');
    noErrors(A, B);
    await A.close(); await B.close();

    /* the mirror: the tablet already holds the old chart under another song WITH marks on that page: a separate archived copy keeps its marks apart */
    ({A: A2, B: B2} = await startPair(ctx));
    const {b: b2} = roles(await libraryOf(A2));
    const held = await A2.page.evaluate(async id => { const st = await import('./js/store.js'), s = st.state.songs.find(x => x.id === id), blob = new Blob([await (await st.get('files', id)).arrayBuffer()], {type: 'application/pdf'}), t = Date.now();
      const rec = {...structuredClone(s), id: 'heldcopy', version: 'my own copy', title: s.song + ' (my own copy)' + (s.artist ? ' - ' + s.artist : ''), archived: true, added: t, updated: t};      // an ARCHIVED copy of the old chart: only those hold old marks
      await st.putAll([{store: 'files', key: 'heldcopy', value: blob}, {store: 'songs', key: 'heldcopy', value: rec}]); await st.load(); return rec; }, b2.id);
    await addMark(A2, 'heldcopy', 1, 'markHeld'); await addMark(A2, b2.id, 1, 'markA1');
    const mineBefore = marksOn(await libraryOf(A2), b2.id, 1);
    finished(await syncTap(A2), 'Sync A (its own copy)');
    finished(await syncTap(B2), 'Sync B (gets A\'s copy)');
    const p2 = await makePdf(1500, 'sync4-marks-new2.pdf');
    await newVersionUi(B2, b2.id, p2.file);
    const copy2 = live(await libraryOf(B2)).find(s => s.id !== b2.id && s.id !== 'heldcopy' && s.hash === b2.hash && s.archived);
    await deleteSongUi(B2, copy2.id);                                          // B keeps no archived copy, so A's own copy is the only holder
    finished(await syncTap(B2), 'Sync B (New version, its archived copy deleted)');
    const ra2 = await syncTap(A2);
    finished(ra2, 'Sync A (the holder has marks of its own)');
    const L2 = await libraryOf(A2), rep = live(L2).filter(s => /replaced \d{4}-\d\d-\d\d/.test(s.version || ''));
    assert(JSON.stringify(marksOn(L2, 'heldcopy', 1)) === '["markHeld"]', 'the marks of the song that already held the old chart were changed: ' + JSON.stringify(marksOn(L2, 'heldcopy', 1)));
    assert(rep.length === 1 && rep[0].archived && L2.files[rep[0].id] === b2.hash && JSON.stringify(marksOn(L2, rep[0].id, 1)) === JSON.stringify(mineBefore), `a separate archived copy should keep A's marks on the old chart: ${JSON.stringify(rep.map(s => [s.version, marksOn(L2, s.id, 1)]))}`);
    assert(!marksOn(L2, b2.id, 1).length, 'the new chart kept the old chart\'s marks');
    assert(/^.+: now plays the chart from your other tablet\. The chart it had is in Archived\./m.test(ra2.text), 'the report does not name the song and say its chart was kept in Archived: ' + ra2.text);
    assert(held && !whole(L2).length, 'not whole: ' + whole(L2).join(' | '));
    noErrors(A2, B2);
  } finally { await A.close().catch(() => {}); await B.close().catch(() => {}); if(A2) await A2.close(); if(B2) await B2.close(); }
}

/* ---------- 4l: a real tie (both tablets stamp the same time, other content) is reported where the edit lost ---------- */
async function loopRealTie(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const g = A.google, {a} = roles(await libraryOf(A));
    const F = Date.now() + YEAR, fut = {...readDrive(g).recs.song.get(a.id), version: 'ahead', updated: F};
    fut.title = titleOf(fut);
    putRecordFile(g, readDrive(g), 'song', fut);
    finished(await syncTap(A), 'Sync A (gets the record dated ahead)');
    finished(await syncTap(B), 'Sync B (gets the record dated ahead)');
    const ea = await saveSong(A, a.id, {version: 'edit on A'}), eb = await saveSong(B, a.id, {version: 'edit on B'});
    assert(ea.updated === F + 1 && eb.updated === F + 1, 'the two edits did not get the same time (the test is wrong): ' + [ea.updated, eb.updated]);
    const winner = canon(ea) >= canon(eb) ? ea : eb, loser = winner === ea ? A : B;
    const r1 = await syncTap(A), r2 = await syncTap(B), r3 = await syncTap(A);
    for(const r of [r1, r2, r3]) finished(r, 'a Sync with a tie');
    const onLoser = loser === B ? r2 : r3;
    assert(/1 changed on both tablets/.test(onLoser.text) && onLoser.text.includes(winner.title), `the report on ${loser.name}, whose edit lost the tie, does not say the song changed on both tablets: "${onLoser.text}"`);
    for(const t of [A, B]) assert(!diff((await libraryOf(t)).songs[a.id], winner).length, `${t.name} did not settle on the same record of the tie`);
    for(const t of [A, B]){ const r = await syncTap(t); assert(!/changed on both/.test(r.text) && reportCounts(r.text).got.song === 0 && reportCounts(r.text).sent.song === 0, `the tie comes back on ${t.name}: "${r.text}"`); }
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 4m: "kept in Archived" only when the archived copy was really written ---------- */
async function loopArchiveFails(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const g = A.google, {a} = roles(await libraryOf(A));
    const p2 = await makePdf(2000, 'sync4-arch-new.pdf');
    await newVersionUi(A, a.id, p2.file);
    await sleep(30);
    await saveSong(B, a.id, {version: 'details on B'});
    finished(await syncTap(A), 'Sync A (New version)');
    finished(await syncTap(B), 'Sync B (its later details win)');
    const fid = pdfFileId(g, a.id);
    g.latency = 1200;
    await tapSync(A);
    const end = Date.now() + 30000;
    while(!g.requests.some(e => e.by === 'A' && e.kind === 'download' && e.status === null && lastSeg(e.path) === fid)){ if(Date.now() > end) throw new Error('A never downloaded the chart'); await sleep(30); }
    await saveSong(A, a.id, {version: 'edited during the download'});           // the song changes here while its chart is on its way
    g.latency = 0;
    const r = await finishSync(A);
    finished(r, 'Sync A (the song was edited during the download)');
    const LA = await libraryOf(A);
    assert(!/now plays the chart from your other tablet|The chart it had is in Archived/.test(r.text), `the report says a chart was kept in Archived though nothing was written: "${r.text}"`);
    assert(!live(LA).some(s => /replaced \d{4}-\d\d-\d\d/.test(s.version || '')), 'an archived copy was written although the download was refused');
    assert(LA.songs[a.id].version === 'edited during the download' && !whole(LA).length, 'the edit made during the download was lost, or the library is not whole');
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 4n: refused record files count towards five refusals in a row ---------- */
async function loopRecordRefusals(ctx){
  const A = await startA(ctx);
  let B = null;
  try{
    const g = A.google;
    await addCopies(A, 6, 'rr');
    finished(await syncTap(A), 'Sync A');
    B = await openTablet(ctx, {name: 'B', share: A});
    await signIn(B);
    const recs = new Set(g.byProp('k').filter(f => f.appProperties.k !== 'pdf').map(f => f.id));
    const isRec = e => e.by === 'B' && e.kind === 'download' && recs.has(lastSeg(e.path));
    g.failNext(403, {reason: 'cannotDownloadFile', times: 1000, match: isRec});
    g.clearLog();
    const r = await syncTap(B);
    g.faults.length = 0;
    const seen = g.requests.filter(isRec).length;
    assert(r.state === 'failed', `Google refusing every record file did not end the run with a message: ${r.title}: ${r.text.slice(0, 300)}`);
    assert(seen <= 5, `the run asked for ${seen} record files after Google kept refusing them (five in a row must end it)`);
    assert(!Object.keys((await libraryOf(B)).songs).length, 'something was written');
    finished(await syncTap(B), 'the Sync after the refusals');
    assert(live(await libraryOf(B)).length === live(await libraryOf(A)).length, 'the next Sync did not get everything');
    noErrors(A, B);
  } finally { await A.close(); if(B) await B.close(); }
}

/* ---------- 4o: a record file nested too deep to read is skipped; the others sync ---------- */
async function loopDeep(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const g = A.google, drive = readDrive(g), t = Date.now(), H1 = H('one-page.pdf');
    const N = 200000, deep = '['.repeat(N) + ']'.repeat(N);
    const text = JSON.stringify(songRecord('h4deep', {hash: H1, updated: t})).replace(/}$/, ',"deep":' + deep + '}');
    assert(text.length < 1e6, 'the deep record is not under 1 MB (the test is wrong)');
    putPdfFile(g, drive, 'h4deep', fixture('one-page.pdf'));
    putRecordFile(g, drive, 'song', songRecord('h4deep', {hash: H1, updated: t}), {content: text, props: {c: 'a'.repeat(64)}});
    const good = songRecord('h4fine', {hash: H1, updated: t});
    putPdfFile(g, drive, 'h4fine', fixture('one-page.pdf')); putRecordFile(g, drive, 'song', good);
    for(const n of [1, 2]){
      const r = await syncTap(B);
      finished(r, `Sync ${n} with a record nested too deep`);
      assert(/h4deep: /.test(r.text), `the record nested too deep is not listed as skipped: "${r.text.slice(0, 400)}"`);
      const LB = await libraryOf(B);
      assert(!LB.songs.h4deep && !LB.files.h4deep, 'something was written for the record nested too deep');
      assert(!diff(LB.songs.h4fine, good).length && LB.files.h4fine === H1, 'the other new song did not arrive');
    }
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 4p: a Copy song is not a holder of the old chart's marks ---------- */
async function loopCopyNotHolder(ctx){
  for(const variant of ['copy live', 'copy archived, deleted on A']){
    const {A, B} = await startPair(ctx);
    try{
      const {b} = roles(await libraryOf(A));
      const [cp] = await addCopies(A, 1, 'x', {from: b.id});
      if(variant !== 'copy live') await saveSong(A, cp, {archived: true});
      finished(await syncTap(A), `${variant}: Sync A (the Copy)`);
      finished(await syncTap(B), `${variant}: Sync B (gets the Copy)`);
      await addMark(B, b.id, 1, 'markB');
      const mine = marksOn(await libraryOf(B), b.id, 1);
      const p = await makePdf(1500, 'sync4-copy-new.pdf');
      await newVersionUi(A, b.id, p.file);
      const nv = live(await libraryOf(A)).find(s => s.id !== b.id && s.id !== cp && s.hash === b.hash && s.archived);
      await deleteSongUi(A, nv.id);                                             // A keeps no archived copy of its own
      if(variant !== 'copy live') await deleteSongUi(A, cp);
      finished(await syncTap(A), `${variant}: Sync A (New version)`);
      const rb = await syncTap(B, {answers: variant === 'copy live' ? {} : {'(x 0)': 'delete'}});
      finished(rb, `${variant}: Sync B`);
      const LB = await libraryOf(B);
      assert(LB.files[b.id] === p.hash && !marksOn(LB, b.id, 1).length, `${variant}: B did not get the new chart with fresh marks`);
      const keeper = live(LB).filter(s => s.archived && s.hash === b.hash && s.id !== cp && JSON.stringify(marksOn(LB, s.id, 1)) === JSON.stringify(mine));
      assert(keeper.length === 1 && /replaced \d{4}-\d\d-\d\d/.test(keeper[0].version), `${variant}: B's marks on the old chart are not on a new archived copy: ${JSON.stringify(live(LB).filter(s => s.hash === b.hash).map(s => [s.version, s.archived, marksOn(LB, s.id, 1)]))}`);
      if(variant === 'copy live') assert(!marksOn(LB, cp, 1).length, 'the Copy song took the old chart\'s marks of another song');
      else assert(LB.songs[cp].deleted === true, 'Delete here did not delete the Copy');
      assert(!whole(LB).length, `${variant}: not whole: ` + whole(LB).join(' | '));
      noErrors(A, B);
    } finally { await A.close(); await B.close(); }
  }
}

/* ---------- 4q: a damaged record on this tablet does not stop every sync ---------- */
async function loopDamagedLocal(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const {a, b} = roles(await libraryOf(B));
    await B.page.evaluate(async ({a, b}) => {
      const st = await import('./js/store.js'), pages = []; pages.length = 3;                  // a sparse list: empty slots
      const sa = await st.get('songs', a), sb = await st.get('songs', b);
      await st.putAll([{store: 'songs', key: a, value: {...sa, crop: {all: null, pages}, updated: st.stamp(sa)}}, {store: 'songs', key: b, value: {...sb, crop: 1, updated: st.stamp(sb)}}]);      // edits made here (a newer app, a damaged restore)
      await st.load();
    }, {a: a.id, b: b.id});
    const r1 = await syncTap(B);
    finished(r1, 'Sync with damaged records here');
    assert(new RegExp(a.title.replace(/[()]/g, '\\$&') + ': it could not be read here').test(r1.text), `the song with a damaged crop is not listed as not synced: "${r1.text.slice(0, 500)}"`);
    /* the Crop screen replaces the damaged crop on save, and the song then syncs */
    const stored = await B.page.evaluate(async ({a, b}) => { const st = await import('./js/store.js'); return [(await st.get('songs', a)).crop, (await st.get('songs', b)).crop, st.state.songs.find(x => x.id === b).crop]; }, {a: a.id, b: b.id});
    assert(stored[1] === 1 && stored[2] === 1 && stored[0] && Array.isArray(stored[0].pages), 'the damaged crops are not what the test wrote: ' + JSON.stringify(stored));
    for(const s of [a, b]){
      await B.page.click('#tLib');
      if(await B.page.locator('.collbar [data-collpick="all"]').count()) await B.page.click('.collbar [data-collpick="all"]');
      await B.page.click(`#libList [data-open="${s.id}"]`);
      await B.page.waitForSelector('#vCrop', {state: 'visible'}); await sleep(400);
      await B.page.click('#vCrop');
      await B.page.waitForSelector('#cropper:not([hidden])', {timeout: 8000}); await sleep(300);
      await B.page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
      await B.page.click('#cropSong');
      await B.page.waitForFunction(() => /Cropped the whole song/.test(document.querySelector('#toast').textContent), null, {timeout: 8000})
        .catch(() => { throw new Error(`saving a crop over the damaged one on "${s.title}" did not work: ${pageErrors(B).join(' | ')}`); });
      await B.page.click('#vBack'); await B.page.waitForSelector('#libList');
    }
    const r2 = await syncTap(B);
    finished(r2, 'Sync after the crops were saved');
    assert(!/could not be read here/.test(r2.text) && reportCounts(r2.text).sent.song === 2, `the repaired songs did not sync: "${r2.text}"`);
    finished(await syncTap(A), 'Sync A');
    await sameSongs(A, B, 'at the end of 4q');
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

export const loops = [
  {name: 'sync 4a: a hostile Drive (bad ids, huge text, a record too big, missing or wrong or fake PDFs, a ghost marker, times that are strings or arrays or out of range, fake deletion flags, a damaged crop) and local records with odd times: skipped by name, the good ones arrive, nothing written, a second run completes', run: loopHostile},
  {name: 'sync 4b: records load() would upgrade settle after one Sync; a setlist row field survives; equal times settle the same on both; a year ahead syncs, is reported, and a later edit still wins', run: loopDates},
  {name: 'sync 4c: a paged listing, 429 and 500 then success, a 500 that does not stop, offline and 401 part-way: plain messages, nothing half written, the next run finishes', run: loopTrouble},
  {name: 'sync 4d: a full Drive and a PDF over 5 MB that cannot be sent: plain message or a skipped line, nothing half sent, the next run sends it', run: loopUploads},
  {name: 'sync 4e: Stop part-way and a reload while a PDF downloads leave the library whole; the next run finishes', run: loopInterrupted},
  {name: 'sync 4f: one PDF over LIMIT.pdf, a file with no size over it (stopped while it arrives), and the per-run budget (the rest next time)', run: loopLimits},
  {name: 'sync 4g: one file Google refuses is skipped and the run finishes; five refusals in a row end the run', run: loopRefusals},
  {name: 'sync 4i: a file Google refuses once and gives the next time in the same run is not reported as skipped (the report tells the truth)', run: loopRefusedOnce},
  {name: 'sync 4j: the per-run budget: the report counts exactly the songs left for the next Sync', run: loopBudgetCount},
  {name: 'sync 4k: the marks follow the old chart: New version on the other tablet, the new chart arrives with fresh marks, the old marks on the archived copy (the other tablet\'s, or a separate one when that holds marks of its own)', run: loopMarks},
  {name: 'sync 4l: two edits stamped the same time with other content settle the same on both and the tablet whose edit lost says it changed on both', run: loopRealTie},
  {name: 'sync 4m: "kept in Archived" is said only when the archived copy was written (not when the song changed during its download)', run: loopArchiveFails},
  {name: 'sync 4n: Google refusing every record file ends the run after five, without asking for every record', run: loopRecordRefusals},
  {name: 'sync 4o: a Drive record nested too deep to read is skipped and listed; the others sync; the next run is the same', run: loopDeep},
  {name: 'sync 4p: a Copy song (live, or archived and deleted on the other tablet) never takes the old chart\'s marks: they go to a new archived copy', run: loopCopyNotHolder},
  {name: 'sync 4q: a damaged record here (a sparse crop list, a crop that is a number) does not stop the sync; the Crop screen repairs it and it then syncs', run: loopDamagedLocal},
  {name: 'sync 4h: a chart is never lost (a download that replaces this tablet\'s chart keeps it in Archived) and New version does not double', run: loopCharts},
];

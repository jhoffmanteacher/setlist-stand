/*
 * Drive sync Part 2, two tablets against an independent model: "sync 2a" .. "sync 2d".
 *
 * Two browser contexts (tablet A and tablet B) share ONE stand-in Drive (fake-google.mjs). The app runs for real, every edit is
 * made through its screens, and every Sync through the Sync button (sign-in, first-time note, deletion box, report). After each
 * step what the app PRODUCED is read back through paths that do not go through the app: each tablet's IndexedDB (snapshot), the
 * stand-in's own files (readDrive: layout, properties, bytes), the stand-in's request log, and a watcher that looks at Drive at
 * the moment each write arrives (a song record must never reach Drive before its PDF). All of it is compared with sync-model.mjs,
 * which is written from the work order, not from js/sync*.js.
 *
 * sync 2a  the walk: a library with details, crops, an archived song, a collection, a setlist with a break and a repeated song,
 *          and two songs with the SAME PDF (a Copy song) that stay two; Sync A, a second Sync that sends and gets nothing; B from
 *          A's backup (its first Sync doubles nothing); different songs edited on each (rename, New version, archive, setlist
 *          reorder, collection rename and membership); Sync A, B, A; then A = B = Drive = model, after a reload (signing in
 *          again) and after a backup round trip of each. Drive layout and properties, one PDF file per song (renamed and
 *          replaced in place), foreign files left alone, per-tablet settings and ink never on Drive.
 * sync 2b  the same song and the same setlist changed on both (the newer whole record wins, the report names it), a field this
 *          app does not know survives the trip there and back, and two equal `updated` with different content are settled the
 *          same way on both tablets, after which a Sync on either changes nothing (no swapping back and forth).
 * sync 2c  a tablet whose clock is a year ahead: its record still syncs, the report on the other tablet says a date is ahead,
 *          and a later normal edit on the other tablet still wins.
 * sync 2d  deletions through the helper: a song and a setlist deleted on A; on B the deletion box is answered Keep for the
 *          song and Delete here for the setlist; the song comes back to A with its PDF, the setlist is gone on both.
 * sync 2e  what comes down is checked and written whole: a PDF on Drive whose bytes are not the ones its record names, a song
 *          whose PDF file is gone, and a setlist record this app must refuse (its properties made to agree, so only the record
 *          check can refuse it) are each skipped and named, nothing is written for them and nothing is deleted; once Drive is put
 *          right they arrive, each song's PDF and record in ONE transaction; a setlist edited here while a Sync is getting it is
 *          not written over, and goes up at the next Sync; a record here whose time is not a number is left out and listed.
 * sync 2f  a new chart (New version) on A and newer details on B for the same song: B's whole record wins, no chart bytes are lost
 *          (the chart that lost is kept as ONE archived copy), the tablets end identical and settle.
 */
import fs from 'node:fs';
import path from 'node:path';
import {FIX, assert, sleep, diff, sha256, PDFDocument, backupNow, restoreZip, idbAll, normalise, snapshot} from './harness.mjs';
import {buildLibrary, NOTE} from './share-lib.mjs';
import {openTablet, makeFromBackup, syncTap, tapSync, finishSync, libraryOf, readDrive, reportCounts, clockOf, setClock, takeWrites, halfSongs} from './sync-two.mjs';
import {newModel, addTablet, copyTablet, localEdit, localNew, localDelete, adopt, sync, compareTablet, compareDrive, KINDS, pdfName, titleOf, canonHash} from './sync-model.mjs';

const YEAR = 365 * 864e5;
const VERBOSE = process.argv.includes('--verbose');
const H = f => sha256(fs.readFileSync(path.join(FIX, f)));
const PRIVATE_KEYS = ['ss-default-coll', 'ss-two', 'ss-pen-w', 'ss-last-backup', 'ss-last-sync', 'ss-problems', 'ss-sync-intro', 'ss-google'];
const PROBLEM = 'S2-PRIVATE-PROBLEM-0f3a';
const noModal = page => page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 8000});
const clearToast = page => page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
async function waitToast(page, re, ms = 20000){
  await page.waitForFunction(src => new RegExp(src).test(document.querySelector('#toast').textContent), re.source, {timeout: ms})
    .catch(async () => { throw new Error(`toast ${re} did not show; it says "${await page.locator('#toast').textContent()}"`); });
}
const pageErrors = t => t.s.errors.filter(e => e.startsWith('pageerror'));
const live = (lib, kind = 'songs') => Object.values(lib[kind]).filter(r => !r.deleted);
const songBy = (lib, start) => live(lib).find(s => s.title.toLowerCase().startsWith(start.toLowerCase()));
const ls = t => t.page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])));

/* ---------- screens ---------- */
async function showAll(page, tab = '#tLib'){
  await page.click(tab);
  if(await page.locator('.collbar [data-collpick="all"]').count()) await page.click('.collbar [data-collpick="all"]');
}
/* Runs an action and waits until the stored record (store, id) has changed; returns the clock window {t0, t1}. */
async function act(t, store, id, fn){
  const before = JSON.stringify((await idbAll(t.page, store))[id]);
  const t0 = await clockOf(t);
  await fn();
  const end = Date.now() + 15000;
  while(JSON.stringify((await idbAll(t.page, store))[id]) === before){ if(Date.now() > end) throw new Error(`${t.name}: the ${store} record ${id} did not change`); await sleep(100); }
  await sleep(150);
  return {t0, t1: await clockOf(t)};
}
async function editSong(t, id, {song, artist, version, colls = {}}){
  const {page} = t;
  await showAll(page);
  await page.click(`#libList [data-edit="${id}"]`);
  const m = page.locator('.modal').last();
  for(const [k, v] of Object.entries({song, artist, version})) if(v !== undefined) await m.locator(`input[data-k="${k}"]`).fill(v);
  for(const [c, on] of Object.entries(colls)) await m.locator(`fieldset.checks input[value="${c}"]`).setChecked(on);
  await m.locator('[data-ok]').click(); await noModal(page);
}
async function setArchived(t, id, on){
  const {page} = t;
  await showAll(page);
  if(!on && !(await page.isChecked('#showArch'))) await page.check('#showArch');
  await page.click(on ? `#libList [data-archive="${id}"]` : `#libList [data-restoresong="${id}"]`);
}
async function copySongUi(t, id, version){
  const {page} = t;
  await showAll(page); await clearToast(page);
  await page.click(`#libList [data-copy="${id}"]`);
  await page.locator('.modal.copyask input').fill(version);
  await page.click('.modal.copyask [data-ok]');
  await waitToast(page, /^Copied/);
}
async function newVersionUi(t, id, file){
  const {page} = t;
  await showAll(page); await clearToast(page);
  await page.click(`#libList [data-newversion="${id}"]`);
  await page.setInputFiles('#newVersionFile', path.join(FIX, file));
  await page.waitForSelector('.modal.nvask, .modal.dupask', {timeout: 15000});
  if(await page.locator('.modal.dupask').count()){ await page.click('.modal.dupask [data-dupadd]'); await page.waitForSelector('.modal.nvask', {timeout: 15000}); }
  await page.click('.modal.nvask [data-ok]');
  await waitToast(page, /^New version in place/);
}
async function openSetUi(page, id){ await showAll(page, '#tSets'); if(await page.locator('[data-allsets]').count()) await page.click('[data-allsets]'); await page.click(`#view [data-set="${id}"]`); await page.waitForSelector('#view [data-renset]'); }
async function moveRowDown(t, setId, row){
  const {page} = t;
  await openSetUi(page, setId); await clearToast(page);
  await page.locator(`#items > li.row:nth-child(${row + 1}) .handle`).focus();
  await page.keyboard.press('ArrowDown');
  await waitToast(page, /^Moved to position/);
  await page.click('[data-allsets]');
}
async function renameSetUi(t, setId, name){
  const {page} = t;
  await openSetUi(page, setId);
  await page.click('[data-renset]');
  await page.locator('.modal input').fill(name);
  await page.click('.modal [data-ok]'); await noModal(page);
  await page.click('[data-allsets]');
}
async function renameCollUi(t, cid, name){
  const {page} = t;
  await page.click('#tLib');
  await page.click('[data-collmanage]');
  await page.click(`.collmgr [data-mren="${cid}"]`);
  await page.locator('.collname input').fill(name);
  await page.click('.collname [data-ok]');
  await page.locator('.collmgr .mname', {hasText: name}).waitFor({timeout: 5000});
  await page.click('.collmgr [data-x]'); await noModal(page);
}
async function deleteSongUi(t, id){
  const {page} = t;
  await showAll(page);
  const b = page.locator(`#libList [data-del="${id}"]`);
  await b.click(); await b.click();
}
async function deleteSetUi(t, id){
  const {page} = t;
  await showAll(page, '#tSets');
  if(await page.locator('[data-allsets]').count()) await page.click('[data-allsets]');
  const b = page.locator(`#view [data-delset="${id}"]`);
  await b.click(); await b.click();
}
/* Writes a record straight into the tablet's database (what a newer app, or a hand-made test case, would leave there). */
const writeRecord = (t, store, rec) => t.page.evaluate(async ({store, rec}) => {
  const st = await import('./js/store.js');
  await st.putAll([{store, key: rec.id, value: rec}]);
  await st.load();
}, {store, rec});

/* ---------- the library both tablets start from ---------- */
async function startA(ctx, {copy = false, extraSet = false} = {}){
  const A = await openTablet(ctx, {name: 'A', fixtures: true});
  await buildLibrary(A.page);
  await A.page.evaluate(async extraSet => {
    const st = await import('./js/store.js'), t = Date.now();
    await st.putAll([{store: 'colls', key: 'cband', value: {id: 'cband', name: 'Band One', created: t, updated: t}}]);
    await st.load();
    for(const s of st.state.songs.filter(s => !s.archived)){ s.colls = ['cband']; await st.saveSong(s); }
    for(const x of st.state.sets){ x.colls = ['cband']; await st.saveSet(x); }
    if(extraSet){
      const by = w => st.state.songs.find(s => s.title.toLowerCase().startsWith(w));
      await st.saveSet({id: 'srehearsal', name: 'Rehearsal', created: t, colls: [], items: [{type: 'song', id: by('fixture alpha').id}, {type: 'song', id: by('two-page').id}]});
    }
    await st.load();
  }, extraSet);
  await A.page.reload(); await A.page.waitForSelector('#libList [data-open]');
  if(copy){
    const a = songBy(await libraryOf(A), 'Fixture Alpha');
    await copySongUi(A, a.id, 'for Band Two');
  }
  return A;
}

/* ---------- checks ---------- */
async function agree(m, tablets, what, loose = []){
  const drive = readDrive(tablets[0].google);
  const out = [...drive.problems.map(p => 'Drive layout: ' + p), ...compareDrive(m, drive, loose)];
  for(const t of tablets){
    out.push(...compareTablet(m, t.name, await libraryOf(t), loose));
    out.push(...t.watch.violations.map(v => `${t.name} (order on Drive): ${v}`));
    if(pageErrors(t).length) out.push(`${t.name} page errors: ${pageErrors(t).join(' | ')}`);
  }
  assert(!out.length, `${what}: the app, Drive and the model disagree:\n    ` + out.slice(0, 16).join('\n    '));
  return drive;
}
const short = (m, name, kind, id) => { const x = m.tablets[name][kind].get(id) || m.drive[kind].get(id); return kind === 'song' ? x.song : x.name; };
function checkReport(m, t, rep, r, what, {both = true} = {}){
  const c = reportCounts(rep.text), P = `${what}: the report "${rep.text.slice(0, 500)}"`;
  assert(rep.state === 'finished', `${P} did not finish`);
  if(!r.sentMarkers && !r.asked.length) for(const k of KINDS){
    assert(c.sent[k] === r.sent[k], `${P} counts ${c.sent[k]} ${k} sent; the model sent ${r.sent[k]}`);
    assert(c.got[k] === r.got[k], `${P} counts ${c.got[k]} ${k} got; the model got ${r.got[k]}`);
  }
  const nothing = !r.actions.length && !r.skipped.length;
  assert(c.upToDate === nothing, `${P} ${nothing ? 'does not say' : 'says'} everything is up to date; the model's work: ${JSON.stringify(r.actions).slice(0, 300)}`);
  if(both){
    if(r.both.length) for(const b of r.both) assert(c.both.includes(short(m, t.name, b.kind, b.id)), `${P} does not name "${short(m, t.name, b.kind, b.id)}" as changed on both tablets`);
    else assert(!c.both, `${P} names records as changed on both tablets; the model has none`);
  }
  if(r.future.length){
    const n = /(\d+) records? (?:has|have) a date[^.]*ahead/.exec(rep.text);
    assert(n && Number(n[1]) === r.future.length, `${P} does not say that ${r.future.length} record(s) have a date ahead (${r.future.map(f => short(m, t.name, f.kind, f.id)).join(', ')})`);
  }else assert(!/ahead of this tablet/.test(rep.text), `${P} says a date is ahead; the model has none`);
}
/* One Sync through the button, the same run in the model, and the report checked against it. byName: answers for the box. */
async function doSync(m, t, what, {byName = {}, byId = {}, both = true, invalid} = {}){
  const now = await clockOf(t);
  t.google.clearLog(); await takeWrites(t);
  const rep = await syncTap(t, {answers: byName});
  const log = t.google.requests.slice();
  const half = halfSongs(await takeWrites(t));
  assert(!half.length, `${what}: ${half.join('; ')}`);
  const r = sync(m, t.name, {now, answers: byId, invalid});
  if(r.skipped.length) for(const x of r.skipped) assert(/Skipped/.test(rep.text) && rep.text.includes(short(m, t.name, x.kind, x.id)), `${what}: the report does not list "${short(m, t.name, x.kind, x.id)}" as skipped: ${rep.text.slice(0, 400)}`);
  if(VERBOSE) console.log(`    ${what}: ${rep.text}\n      model: ${JSON.stringify(r.actions)}${r.both.length ? ' both: ' + r.both.map(b => b.id) : ''}${r.future.length ? ' future: ' + r.future.map(f => f.id) : ''}`);
  checkReport(m, t, rep, r, what, {both});
  return {rep, r, log};
}
const writesIn = (log, by) => log.filter(e => e.by === by && (e.kind === 'upload' || (e.kind === 'drive' && ['POST', 'PATCH', 'DELETE', 'PUT'].includes(e.method))));
const downloadsIn = (log, by) => log.filter(e => e.by === by && e.kind === 'download');
function quiet(run, t, what){
  const w = writesIn(run.log, t.name), d = downloadsIn(run.log, t.name);
  assert(!w.length && !d.length, `${what}: a Sync with nothing to do sent ${w.length} write(s) and ${d.length} download(s): ${[...w, ...d].map(e => e.method + ' ' + e.path).slice(0, 6).join(', ')}`);
  assert(!run.r.actions.length, `${what}: the model has work to do (the test is wrong): ${JSON.stringify(run.r.actions)}`);
}
/* Nothing per-tablet and no ink in Drive: names, properties and bytes of every file */
function nothingPrivate(google, extra = []){
  for(const f of google.files.values()){
    const hay = [f.name, JSON.stringify(f.appProperties), f.description || '', f.content ? f.content.toString('latin1') : ''].join('\n');
    for(const k of [...PRIVATE_KEYS, ...extra]) assert(!hay.includes(k), `"${k}" is in the Drive file "${f.name}" (per-tablet settings and ink stay on the tablet)`);
    assert(!/^ink/.test(f.appProperties.k || '') && !/^ink/.test(f.name), `an ink file on Drive: "${f.name}"`);
  }
}
const fileState = f => JSON.stringify({name: f.name, mimeType: f.mimeType, parents: f.parents, appProperties: f.appProperties, modifiedTime: f.modifiedTime, trashed: !!f.trashed, bytes: f.content ? sha256(f.content) : null});
function seedForeign(google, drive){
  const one = fs.readFileSync(path.join(FIX, 'one-page.pdf'));
  const ids = [
    google.addFile({name: 'My own notes.txt', mimeType: 'text/plain', parents: [drive.home.id], content: 'not the app\'s'}),
    google.addFile({name: 'Someone else.pdf', mimeType: 'application/pdf', parents: [drive.charts.id], content: one}),          // the same bytes as a song: never matched by hash
    google.addFile({name: 'song-zz9.json', mimeType: 'application/json', parents: [drive.data.id],                                // our kind of name, but not ours (no properties)
      content: JSON.stringify({id: 'zz9', title: 'Planted', song: 'Planted', artist: '', version: '', archived: false, colls: [], pages: 1, hash: sha256(one), added: 1, updated: Date.now() + 6e5})}),
    google.addFile({name: 'Hidden.pdf', mimeType: 'application/pdf', parents: [drive.charts.id], content: one, byApp: false}),
  ];
  return new Map(ids.map(id => [id, fileState(google.files.get(id))]));
}
function foreignUntouched(google, seeded, what){
  for(const [id, was] of seeded){
    const f = google.files.get(id);
    assert(f && fileState(f) === was, `${what}: a file in the Drive folder that is not the app's was ${f ? 'changed' : 'deleted'}: ${was.slice(0, 80)}`);
  }
}
const libOnly = lib => ({songs: lib.songs, sets: lib.sets, colls: lib.colls, files: lib.files});
async function roundTrip(ctx, t, what){
  const bk = await backupNow(t.page), want = libOnly(await libraryOf(t));
  const c = await ctx.session({serviceWorkers: process.env.SS_BROWSER === 'webkit' ? 'block' : 'allow'});
  try{
    await c.goto(); await restoreZip(c.page, bk.file);
    const d = diff(want, libOnly(normalise(await snapshot(c.page))));
    assert(!d.length, `${what}: ${t.name}'s backup, restored on a fresh tablet, is not ${t.name}'s library: ${d.join(' | ')}`);
  } finally { await c.close(); }
}
async function pdfPages(file){ return (await PDFDocument.load(fs.readFileSync(path.join(FIX, file)))).getPageCount(); }

/* ---------- 2a: the walk ---------- */
async function loopWalk(ctx){
  const A = await startA(ctx, {copy: true});
  let B = null;
  try{
    const m = newModel();
    /* per-tablet settings on A */
    await A.page.evaluate(p => { localStorage.setItem('ss-default-coll', 'cband'); localStorage.setItem('ss-two', '1'); localStorage.setItem('ss-pen-w', 'thick'); localStorage.setItem('ss-problems', JSON.stringify([{t: Date.now(), msg: p}])); }, PROBLEM);
    await A.page.reload(); await A.page.waitForSelector('#libList');
    const L0 = await libraryOf(A);
    addTablet(m, 'A', L0);
    const a = songBy(L0, 'Fixture Alpha (in G)'), b = songBy(L0, 'two-page'), c = songBy(L0, 'three-page'), cp = songBy(L0, 'Fixture Alpha (for Band Two)');
    const gig = live(L0, 'sets')[0];
    assert(a && b && c && cp && gig && c.archived && a.hash === cp.hash && a.id !== cp.id && a.crop && gig.items.some(i => i.type === 'break') && gig.items.filter(i => i.id === a.id).length === 2,
      'the test library is not what the loop needs: ' + JSON.stringify(live(L0).map(s => [s.title, s.archived])));
    const inkA = JSON.stringify(L0.ink);
    assert(inkA.includes(NOTE), 'the test library has no text note');

    /* Sync A: everything goes up; Drive is laid out as the design says */
    const s1 = await doSync(m, A, 'first Sync on A');
    let drive = await agree(m, [A], 'after the first Sync on A');
    assert(s1.r.sent.song === 4 && s1.r.sent.set === 1 && s1.r.sent.coll === 1, 'the model sent ' + JSON.stringify(s1.r.sent));
    assert(A.watch.songWrites >= 4, `the order watcher saw ${A.watch.songWrites} song record writes (4 expected): it is not looking at the uploads`);
    assert(drive.pdfs.has(a.id) && drive.pdfs.has(cp.id) && drive.pdfs.get(a.id).fileId !== drive.pdfs.get(cp.id).fileId, 'two songs with the same PDF do not have one PDF file each on Drive');
    assert(/Last synced/.test(await A.page.locator('#libDriveLine [data-drivestatus]').textContent()) && Number((await ls(A))['ss-last-sync']) > 0, 'the Library does not say when this tablet last synced, or ss-last-sync is not set');
    nothingPrivate(A.google, [NOTE, PROBLEM, '"strokes"']);
    const seeded = seedForeign(A.google, drive);

    /* a second Sync with nothing changed sends nothing and downloads nothing */
    quiet(await doSync(m, A, 'second Sync on A'), A, 'second Sync on A');
    await agree(m, [A], 'after the second Sync on A');

    /* B from A's backup; its first Sync doubles nothing */
    B = await makeFromBackup(ctx, A);
    copyTablet(m, 'A', 'B');
    await B.page.evaluate(() => { localStorage.setItem('ss-two', '0'); localStorage.setItem('ss-pen-w', 'thin'); });
    await agree(m, [A, B], 'B restored from A\'s backup');
    const b1 = await doSync(m, B, 'first Sync on B (restored from A\'s backup)');
    quiet(b1, B, 'first Sync on B');
    assert(live(await libraryOf(B)).length === 4, 'B\'s first Sync doubled songs: ' + live(await libraryOf(B)).map(s => s.title).join(', '));
    await agree(m, [A, B], 'after B\'s first Sync');

    /* different songs edited on each tablet */
    const pdfFileOf = id => readDrive(A.google).pdfs.get(id).fileId;
    const bFile = pdfFileOf(b.id), aFile = pdfFileOf(a.id);
    const probs = [];
    let w = await act(A, 'songs', b.id, () => editSong(A, b.id, {song: 'Two Page Tune', artist: 'The Renamers'}));
    probs.push(...localEdit(m, 'A', 'song', b.id, {song: 'Two Page Tune', artist: 'The Renamers'}, w, (await libraryOf(A)).songs[b.id]));
    w = await act(A, 'sets', gig.id, () => moveRowDown(A, gig.id, 0));
    const moved = [...gig.items]; moved.splice(1, 0, moved.shift());
    probs.push(...localEdit(m, 'A', 'set', gig.id, {items: moved}, w, (await libraryOf(A)).sets[gig.id]));
    w = await act(A, 'colls', 'cband', () => renameCollUi(A, 'cband', 'Band One Renamed'));
    probs.push(...localEdit(m, 'A', 'coll', 'cband', {name: 'Band One Renamed'}, w, (await libraryOf(A)).colls.cband));

    const before = Object.keys((await libraryOf(B)).songs);
    w = await act(B, 'songs', a.id, () => newVersionUi(B, a.id, 'songbook.pdf'));
    const LB = await libraryOf(B), old = live(LB).find(s => !before.includes(s.id));
    probs.push(...localEdit(m, 'B', 'song', a.id, {pages: await pdfPages('songbook.pdf'), hash: H('songbook.pdf')}, w, LB.songs[a.id]));
    assert(old && old.archived === true && old.hash === a.hash && old.song === a.song && /old \d{4}-\d\d-\d\d/.test(old.version), 'New version did not keep the old chart as an archived song: ' + JSON.stringify(old));
    probs.push(...localNew(m, 'B', 'song', old, w, {pdf: a.hash}));
    adopt(m, 'B', 'song', LB.songs[a.id], {pdf: H('songbook.pdf')});
    w = await act(B, 'songs', cp.id, () => editSong(B, cp.id, {colls: {cband: false}}));
    probs.push(...localEdit(m, 'B', 'song', cp.id, {colls: []}, w, (await libraryOf(B)).songs[cp.id]));
    w = await act(B, 'songs', cp.id, () => setArchived(B, cp.id, true));
    probs.push(...localEdit(m, 'B', 'song', cp.id, {archived: true}, w, (await libraryOf(B)).songs[cp.id]));
    assert(!probs.length, 'the edits did not do what the model expects:\n    ' + probs.join('\n    '));
    const inkB = JSON.stringify((await libraryOf(B)).ink);

    /* Sync A, Sync B, Sync A */
    await doSync(m, A, 'Sync A after the edits');
    drive = await agree(m, [A, B], 'after Sync A');
    assert(drive.pdfs.get(b.id).fileId === bFile && drive.pdfs.get(b.id).name === pdfName('Two Page Tune - The Renamers'), 'the renamed song\'s PDF on Drive was not renamed in place: ' + JSON.stringify(drive.pdfs.get(b.id)));
    await doSync(m, B, 'Sync B after the edits');
    drive = await agree(m, [A, B], 'after Sync B');
    assert(drive.pdfs.get(a.id).fileId === aFile && drive.pdfs.get(a.id).hash === H('songbook.pdf'), 'New version did not replace the PDF in the song\'s one Drive file: ' + JSON.stringify(drive.pdfs.get(a.id)));
    assert([...drive.pdfs.values()].filter(p => p.hash === a.hash).length === 2, 'the old chart and the Copy song do not each have their PDF on Drive');
    await doSync(m, A, 'Sync A again');
    await agree(m, [A, B], 'after the last Sync on A');
    const LA = libOnly(await libraryOf(A)), LB2 = libOnly(await libraryOf(B));
    let d = diff(LA, LB2);
    assert(!d.length, 'A and B are not the same library: ' + d.join(' | '));
    assert(LA.files[a.id] === H('songbook.pdf') && LA.songs[a.id].hash === H('songbook.pdf'), 'A did not get the new PDF of the song B gave a new version');
    assert(live({songs: LA.songs}).length === 5, 'A does not have five songs: ' + live({songs: LA.songs}).map(s => s.title).join(', '));
    for(const [n, L] of [['A', LA], ['B', LB2]]){
      const olds = live({songs: L.songs}).filter(s => s.archived && /old \d{4}-/.test(s.version));
      assert(olds.length === 1 && !live({songs: L.songs}).some(s => /replaced \d{4}-/.test(s.version)), `${n} has ${olds.length} archived copies of the old chart (one expected) or a "replaced" copy nobody needed: ` + live({songs: L.songs}).map(s => s.title).join(', '));
    }

    /* after a reload (the sign-in is gone): the same, and a Sync on each changes nothing */
    await A.page.reload(); await B.page.reload();
    await A.page.waitForSelector('#libList'); await B.page.waitForSelector('#libList');
    await agree(m, [A, B], 'after reloading both tablets');
    quiet(await doSync(m, A, 'Sync A after a reload'), A, 'Sync A after a reload');
    quiet(await doSync(m, B, 'Sync B after a reload'), B, 'Sync B after a reload');

    /* per-tablet things stayed per tablet; ink never left; files that are not ours were left alone */
    const sa = await ls(A), sb = await ls(B);
    assert(sa['ss-default-coll'] === 'cband' && sa['ss-two'] === '1' && sa['ss-pen-w'] === 'thick' && (sa['ss-problems'] || '').includes(PROBLEM), 'A\'s own settings changed: ' + JSON.stringify(sa));
    assert(!('ss-default-coll' in sb) && sb['ss-two'] === '0' && sb['ss-pen-w'] === 'thin' && !(sb['ss-problems'] || '').includes(PROBLEM), 'B took settings from A: ' + JSON.stringify(sb));
    nothingPrivate(A.google, [NOTE, PROBLEM, '"strokes"']);
    assert(JSON.stringify((await libraryOf(A)).ink) === inkA, 'a Sync changed A\'s marks (marks are not synced in Part 2)');
    assert(JSON.stringify((await libraryOf(B)).ink) === inkB, 'a Sync changed B\'s marks');
    foreignUntouched(A.google, seeded, 'the end of the walk');
    assert(!live(await libraryOf(A)).some(s => s.title === 'Planted'), 'a file that is not the app\'s became a song');

    /* a backup round trip of each */
    await roundTrip(ctx, A, 'A'); await roundTrip(ctx, B, 'B');
    d = diff(LA, libOnly(await libraryOf(A)));
    assert(!d.length, 'A changed after the backups: ' + d.join(' | '));
  } finally { await A.close(); if(B) await B.close(); }
}

/* ---------- 2b: changed on both; a field nobody knows; equal times ---------- */
async function loopBoth(ctx){
  const A = await startA(ctx);
  let B = null;
  try{
    const m = newModel();
    const L0 = await libraryOf(A);
    addTablet(m, 'A', L0);
    const a = songBy(L0, 'Fixture Alpha'), b = songBy(L0, 'two-page'), c = songBy(L0, 'three-page'), gig = live(L0, 'sets')[0];
    await doSync(m, A, 'first Sync on A');
    B = await makeFromBackup(ctx, A); copyTablet(m, 'A', 'B');
    quiet(await doSync(m, B, 'first Sync on B'), B, 'first Sync on B');

    /* a field this app does not know, on a song and on a collection (a newer version of the app would write such a thing) */
    const probs = [];
    const extra = {nested: [1, 'x', {deep: true}], note: 'from a newer app'};
    for(const [store, kind, id] of [['songs', 'song', c.id], ['colls', 'coll', 'cband']]){
      const cur = (await libraryOf(A))[store][id];
      await writeRecord(A, store, {...cur, futureField: extra, updated: cur.updated + 1});
      adopt(m, 'A', kind, (await libraryOf(A))[store][id]);
    }
    /* the same song and the same setlist changed on both tablets: A first, B later (B's is newer) */
    let w = await act(A, 'songs', a.id, () => editSong(A, a.id, {version: 'in A'}));
    probs.push(...localEdit(m, 'A', 'song', a.id, {version: 'in A'}, w, (await libraryOf(A)).songs[a.id]));
    w = await act(A, 'sets', gig.id, () => renameSetUi(A, gig.id, 'Gig renamed on A'));
    probs.push(...localEdit(m, 'A', 'set', gig.id, {name: 'Gig renamed on A'}, w, (await libraryOf(A)).sets[gig.id]));
    await sleep(30);
    w = await act(B, 'songs', a.id, () => editSong(B, a.id, {version: 'in B'}));
    probs.push(...localEdit(m, 'B', 'song', a.id, {version: 'in B'}, w, (await libraryOf(B)).songs[a.id]));
    w = await act(B, 'sets', gig.id, () => moveRowDown(B, gig.id, 0));
    const moved = [...gig.items]; moved.splice(1, 0, moved.shift());
    probs.push(...localEdit(m, 'B', 'set', gig.id, {items: moved}, w, (await libraryOf(B)).sets[gig.id]));
    assert(!probs.length, 'the edits did not do what the model expects:\n    ' + probs.join('\n    '));

    await doSync(m, A, 'Sync A');
    await agree(m, [A, B], 'after Sync A');
    const rb = await doSync(m, B, 'Sync B (the song and the setlist were changed on both)');
    assert(rb.r.both.length === 2, 'the model does not see two records changed on both: ' + JSON.stringify(rb.r.both));
    await agree(m, [A, B], 'after Sync B');
    const ra = await doSync(m, A, 'Sync A again');
    await agree(m, [A, B], 'after Sync A again');
    assert(!ra.r.both.length, 'model: A changed nothing since its last sync');
    const LA = await libraryOf(A);
    assert(LA.songs[a.id].version === 'in B' && LA.sets[gig.id].name === gig.name && JSON.stringify(LA.sets[gig.id].items) === JSON.stringify(moved), 'the newer whole records did not win on A: ' + JSON.stringify([LA.songs[a.id].version, LA.sets[gig.id].name]));
    assert(JSON.stringify((await libraryOf(B)).songs[c.id].futureField) === JSON.stringify(extra) && JSON.stringify((await libraryOf(B)).colls.cband.futureField) === JSON.stringify(extra), 'a field this app does not know was lost on the way to B');

    /* ...and back: B edits that song (Restore from Archived) and sends it; the field comes back with the edit */
    w = await act(B, 'songs', c.id, () => setArchived(B, c.id, false));
    probs.push(...localEdit(m, 'B', 'song', c.id, {archived: false}, w, (await libraryOf(B)).songs[c.id]));
    assert(!probs.length, probs.join(' | '));
    await doSync(m, B, 'Sync B (the song with the unknown field, restored from Archived)');
    await doSync(m, A, 'Sync A (gets it back)');
    await agree(m, [A, B], 'after the unknown field went there and back');
    const back = (await libraryOf(A)).songs[c.id];
    assert(back.archived === false && JSON.stringify(back.futureField) === JSON.stringify(extra), 'the unknown field did not survive the trip back: ' + JSON.stringify(back));
    /* ...and on a setlist row (the break), which load() must keep too */
    {
      const cur = (await libraryOf(A)).sets[gig.id];
      await writeRecord(A, 'sets', {...cur, items: cur.items.map(it => (it.type === 'break' ? {...it, rowField: {from: 'a newer app'}} : it)), updated: cur.updated + 1});
      await A.page.reload(); await A.page.waitForSelector('#libList');
      const now = (await libraryOf(A)).sets[gig.id];
      assert(now.items.some(it => it.rowField && it.rowField.from === 'a newer app'), 'loading dropped a field this app does not know from a setlist row');
      adopt(m, 'A', 'set', now);
    }
    await doSync(m, A, 'Sync A (a setlist row with a field this app does not know)');
    await doSync(m, B, 'Sync B (gets it)');
    await agree(m, [A, B], 'after the setlist row went to B');
    assert((await libraryOf(B)).sets[gig.id].items.some(it => it.rowField && it.rowField.from === 'a newer app'), 'the setlist row\'s unknown field was lost on the way to B');

    /* equal `updated`, different content, on both tablets: one winner, the same on both, and then calm */
    const U = Math.max(await clockOf(A), await clockOf(B)) + 5000;
    const tie = async (t, store, kind, id, change) => { const cur = (await libraryOf(t))[store][id]; const rec = {...cur, ...change, updated: U}; if(kind === 'song') rec.title = titleOf(rec); await writeRecord(t, store, rec); adopt(m, t.name, kind, (await libraryOf(t))[store][id]); };
    await tie(A, 'songs', 'song', b.id, {version: 'zzz tie'});
    await tie(B, 'songs', 'song', b.id, {version: 'aaa tie'});
    await tie(A, 'colls', 'coll', 'cband', {name: 'Tie aaa'});
    await tie(B, 'colls', 'coll', 'cband', {name: 'Tie zzz'});
    await doSync(m, A, 'Sync A (its side of two ties)', {both: false});
    const rt = await doSync(m, B, 'Sync B (equal times, different content)', {both: false});
    assert(rt.r.actions.some(x => x.op === 'down' && x.id === b.id) && rt.r.actions.some(x => x.op === 'up' && x.id === 'cband'), 'the model does not have one tie won by each side: ' + JSON.stringify(rt.r.actions));
    await agree(m, [A, B], 'after the ties on B');
    await doSync(m, A, 'Sync A after the ties', {both: false});
    await agree(m, [A, B], 'after the ties on A');
    quiet(await doSync(m, B, 'Sync B once the ties are settled'), B, 'Sync B once the ties are settled');
    quiet(await doSync(m, A, 'Sync A once the ties are settled'), A, 'Sync A once the ties are settled');
    const d = diff(libOnly(await libraryOf(A)), libOnly(await libraryOf(B)));
    assert(!d.length, 'A and B did not settle on the same records: ' + d.join(' | '));

    /* a record that differs from Drive's only by what loading fills in (written by an older app: no archived, no empty fields, a title
       that is not the derived one), with the same time: the same record, not a conflict or a tie; nothing moves */
    const f = [...A.google.files.values()].find(x => !x.trashed && x.appProperties.k === 'song' && x.appProperties.id === a.id);
    const raw = JSON.parse(f.content.toString('utf8'));
    assert(raw.archived === false && raw.title === titleOf(raw), 'the song is not what this step needs');
    delete raw.archived; raw.title = 'not the derived title';
    if(raw.version === '') delete raw.version;
    if(Array.isArray(raw.colls) && !raw.colls.length) delete raw.colls;
    f.content = Buffer.from(JSON.stringify(raw)); f.appProperties = {...f.appProperties, c: canonHash(raw)};
    m.drive.song.set(a.id, raw);
    /* (its listed hash differs, so a tablet may fetch the record to see that; it must write nothing, get no PDF and say up to date) */
    for(const t of [B, A, B]){
      const run = await doSync(m, t, `Sync ${t.name} (Drive has an older app's form of a song)`);
      const w = writesIn(run.log, t.name), pdfs = downloadsIn(run.log, t.name).filter(e => !e.path.endsWith('/' + f.id));
      assert(!w.length && !pdfs.length && !run.r.actions.length, `Sync ${t.name} with an older form of a song on Drive wrote ${w.length} file(s) and downloaded ${pdfs.length} other file(s); model: ${JSON.stringify(run.r.actions)}`);
      assert(/Everything is up to date/.test(run.rep.text), `Sync ${t.name} with an older form of a song on Drive does not say everything is up to date: ${run.rep.text}`);
    }
    await agree(m, [A, B], 'after the older form of a song was met');
  } finally { await A.close(); if(B) await B.close(); }
}

/* ---------- 2c: a clock a year ahead ---------- */
async function loopClock(ctx){
  const A = await startA(ctx);
  let B = null;
  try{
    const m = newModel();
    const L0 = await libraryOf(A);
    addTablet(m, 'A', L0);
    const a = songBy(L0, 'Fixture Alpha');
    await doSync(m, A, 'first Sync on A');
    B = await makeFromBackup(ctx, A); copyTablet(m, 'A', 'B');
    quiet(await doSync(m, B, 'first Sync on B'), B, 'first Sync on B');
    await setClock(B, YEAR);
    assert(await clockOf(B) - Date.now() > YEAR - 864e5, 'B\'s clock did not move');
    const probs = [];
    let w = await act(B, 'songs', a.id, () => editSong(B, a.id, {version: 'from the future'}));
    probs.push(...localEdit(m, 'B', 'song', a.id, {version: 'from the future'}, w, (await libraryOf(B)).songs[a.id]));
    assert(!probs.length, probs.join(' | '));
    await doSync(m, B, 'Sync B (clock a year ahead)');
    await agree(m, [A, B], 'after Sync B with its clock a year ahead');
    const ra = await doSync(m, A, 'Sync A (gets a record dated a year ahead)');
    assert(ra.r.future.some(f => f.id === a.id), 'the model does not see the date ahead');
    await agree(m, [A, B], 'after A got the record dated ahead');
    /* a later normal edit on A still wins over the record from the future */
    w = await act(A, 'songs', a.id, () => editSong(A, a.id, {version: 'later on A'}));
    probs.push(...localEdit(m, 'A', 'song', a.id, {version: 'later on A'}, w, (await libraryOf(A)).songs[a.id]));
    assert(!probs.length, probs.join(' | '));
    await doSync(m, A, 'Sync A (its edit after the future date)');
    await doSync(m, B, 'Sync B (gets A\'s later edit)');
    await agree(m, [A, B], 'after A\'s later edit reached B');
    assert((await libraryOf(B)).songs[a.id].version === 'later on A', 'the edit made on A after the future-dated one did not win on B');
  } finally { await A.close(); if(B) await B.close(); }
}

/* ---------- 2d: deletions answered through the box ---------- */
async function loopDeletions(ctx){
  const A = await startA(ctx, {extraSet: true});
  let B = null;
  try{
    const m = newModel();
    const L0 = await libraryOf(A);
    addTablet(m, 'A', L0);
    const b = songBy(L0, 'two-page'), gig = live(L0, 'sets').find(x => x.name !== 'Rehearsal'), reh = L0.sets.srehearsal;
    assert(b && gig && reh && gig.items.some(i => i.id === b.id) && reh.items.some(i => i.id === b.id), 'the test library is not what the loop needs');
    await doSync(m, A, 'first Sync on A');
    B = await makeFromBackup(ctx, A); copyTablet(m, 'A', 'B');
    quiet(await doSync(m, B, 'first Sync on B'), B, 'first Sync on B');

    /* A deletes the song (both setlists lose it) and the setlist Rehearsal */
    const probs = [];
    let w = await act(A, 'songs', b.id, () => deleteSongUi(A, b.id));
    probs.push(...localDelete(m, 'A', 'song', b.id, w, await libraryOf(A)));
    w = await act(A, 'sets', reh.id, () => deleteSetUi(A, reh.id));
    probs.push(...localDelete(m, 'A', 'set', reh.id, w, await libraryOf(A)));
    assert(!probs.length, 'Delete did not do what the model expects:\n    ' + probs.join('\n    '));
    await doSync(m, A, 'Sync A (two deletions go up)');
    let drive = await agree(m, [A, B], 'after A sent its deletions');
    assert(!drive.pdfs.has(b.id) && drive.recs.song.get(b.id).deleted === true && A.watch.pdfRemovals >= 1, 'the deleted song\'s PDF is still on Drive, or its marker is not');

    /* B: the box lists both; Keep the song, Delete here the setlist */
    const run = await doSync(m, B, 'Sync B (answers the deletion box)', {byName: {[b.title]: 'keep', Rehearsal: 'delete'}, byId: {[b.id]: 'keep', [reh.id]: 'delete'}});
    assert(run.rep.asked.some(r => r.includes(b.title)) && run.rep.asked.some(r => r.includes('Rehearsal')) && run.rep.asked.length === 2, 'the deletion box did not list the song and the setlist: ' + JSON.stringify(run.rep.asked));
    drive = await agree(m, [A, B], 'after B answered', run.r.loose);
    assert(drive.pdfs.has(b.id) && (await libraryOf(B)).files[b.id] === b.hash, 'Keep did not put the song and its PDF back on Drive');
    assert((await libraryOf(B)).sets[reh.id].deleted === true, 'Delete here did not delete the setlist on B');
    const back = await doSync(m, A, 'Sync A (the kept song comes back)');
    assert(back.r.got.song === 1, 'model: A gets the kept song back');
    await agree(m, [A, B], 'after the kept song came back to A');
    const LA = await libraryOf(A);
    assert(!LA.songs[b.id].deleted && LA.files[b.id] === b.hash, 'the kept song did not come back to A with its PDF');
    /* settled: nothing is asked again, and the two tablets hold the same */
    const again = await doSync(m, B, 'Sync B once more');
    assert(!again.rep.asked.length, 'the deletion box came back after every row was answered');
    await doSync(m, A, 'Sync A once more');
    await agree(m, [A, B], 'at the end');
    const d = diff(libOnly(await libraryOf(A)), libOnly(await libraryOf(B)));
    assert(!d.length, 'A and B are not the same library: ' + d.join(' | '));
  } finally { await A.close(); if(B) await B.close(); }
}

/* ---------- 2e: what comes down is checked, and written whole ---------- */
async function loopChecked(ctx){
  const A = await startA(ctx);
  let B = null;
  try{
    const m = newModel();
    const L0 = await libraryOf(A);
    addTablet(m, 'A', L0);
    const b = songBy(L0, 'two-page'), gig = live(L0, 'sets')[0];
    await doSync(m, A, 'first Sync on A');
    B = await makeFromBackup(ctx, A); copyTablet(m, 'A', 'B');
    quiet(await doSync(m, B, 'first Sync on B'), B, 'first Sync on B');

    /* A: New version of b (a new PDF, and its old chart as a new archived song), and the setlist renamed */
    const probs = [], before = Object.keys((await libraryOf(A)).songs);
    let w = await act(A, 'songs', b.id, () => newVersionUi(A, b.id, 'songbook.pdf'));
    let LA = await libraryOf(A);
    const O = live(LA).find(s => !before.includes(s.id));
    probs.push(...localEdit(m, 'A', 'song', b.id, {pages: await pdfPages('songbook.pdf'), hash: H('songbook.pdf')}, w, LA.songs[b.id]));
    adopt(m, 'A', 'song', LA.songs[b.id], {pdf: H('songbook.pdf')});
    probs.push(...localNew(m, 'A', 'song', O, w, {pdf: b.hash}));
    w = await act(A, 'sets', gig.id, () => renameSetUi(A, gig.id, 'Gig renamed on A'));
    probs.push(...localEdit(m, 'A', 'set', gig.id, {name: 'Gig renamed on A'}, w, (await libraryOf(A)).sets[gig.id]));
    assert(!probs.length, probs.join(' | '));
    await doSync(m, A, 'Sync A');
    let drive = await agree(m, [A, B], 'after Sync A');

    /* Drive goes wrong: b's PDF bytes are not the ones its record names, O's PDF file is gone, the setlist is one this app must refuse */
    const g = A.google, fileOf = (k, id) => [...g.files.values()].find(f => !f.trashed && f.appProperties.k === k && f.appProperties.id === id);
    const bPdf = g.files.get(drive.pdfs.get(b.id).fileId), goodBytes = bPdf.content;
    bPdf.content = fs.readFileSync(path.join(FIX, 'one-page.pdf'));
    const oPdf = g.files.get(drive.pdfs.get(O.id).fileId), oSaved = {...oPdf};
    g.files.delete(oPdf.id);
    const setFile = fileOf('set', gig.id), setSaved = {content: setFile.content, appProperties: {...setFile.appProperties}};
    const bad = {...JSON.parse(setFile.content.toString('utf8')), items: [{type: 'song', id: 'not a plain id!'}]};
    setFile.content = Buffer.from(JSON.stringify(bad)); setFile.appProperties = {...setFile.appProperties, c: canonHash(bad)};
    const LB0 = await libraryOf(B);
    await doSync(m, B, 'Sync B (three things on Drive are wrong)', {invalid: new Set(['song:' + b.id, 'song:' + O.id, 'set:' + gig.id])});
    const out = compareTablet(m, 'B', await libraryOf(B));
    assert(!out.length, 'B wrote something it had to refuse, or deleted something:\n    ' + out.join('\n    '));
    assert(!diff(libOnly(LB0), libOnly(await libraryOf(B))).length, 'B changed although everything that came down had to be refused');

    /* Drive put right: everything arrives, each song whole */
    bPdf.content = goodBytes; g.files.set(oSaved.id, oSaved); setFile.content = setSaved.content; setFile.appProperties = setSaved.appProperties;
    await doSync(m, B, 'Sync B (Drive put right)');
    await agree(m, [A, B], 'after Drive was put right');
    const LB = await libraryOf(B);
    assert(LB.files[b.id] === H('songbook.pdf') && LB.files[O.id] === b.hash, 'B did not get the new PDF and the old chart');

    /* a setlist edited on B while a Sync is getting Drive's version of it: the edit is kept */
    w = await act(A, 'sets', gig.id, () => renameSetUi(A, gig.id, 'Gig renamed again on A'));
    probs.push(...localEdit(m, 'A', 'set', gig.id, {name: 'Gig renamed again on A'}, w, (await libraryOf(A)).sets[gig.id]));
    assert(!probs.length, probs.join(' | '));
    await doSync(m, A, 'Sync A (the setlist renamed again)');
    const p2 = await B.context.newPage();
    let mine;
    try{
      await p2.goto(ctx.base + 'css/app.css');
      const recFile = fileOf('set', gig.id).id;
      g.clearLog(); g.latency = 2500;
      const now = await clockOf(B);
      await tapSync(B);
      const end = Date.now() + 60000;
      while(!g.requests.some(e => e.by === 'B' && e.kind === 'download' && e.path.endsWith('/' + recFile))){ if(Date.now() > end) throw new Error('B never asked Drive for the setlist'); await sleep(50); }
      mine = await p2.evaluate(id => new Promise((res, rej) => {
        const r = indexedDB.open('setlist-stand');
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const d = r.result, t = d.transaction('sets', 'readwrite'), st = t.objectStore('sets'), q = st.get(id);
          let rec;
          q.onsuccess = () => { rec = {...q.result, name: 'Typed on B meanwhile', updated: Math.max(Date.now(), q.result.updated + 1)}; st.put(rec, id); };
          t.oncomplete = () => { d.close(); res(rec); }; t.onerror = () => rej(t.error);
        };
      }), gig.id);
      const rep = await finishSync(B);
      g.latency = 0;
      assert(rep.state === 'finished', 'the Sync during the edit did not finish: ' + rep.text);
      sync(m, 'B', {now});
    } finally { g.latency = 0; await p2.close(); }
    const kept = (await libraryOf(B)).sets[gig.id];
    assert(JSON.stringify(kept) === JSON.stringify(mine), 'a setlist edited while the Sync was getting it was written over: ' + JSON.stringify(kept).slice(0, 200));
    adopt(m, 'B', 'set', kept);
    /* the edit may go up in the same run (a run surveys again after its downloads) or at the next one: both are right */
    const onDrive = readDrive(g).recs.set.get(gig.id);
    if(JSON.stringify(onDrive) === JSON.stringify(kept)) m.drive.set.set(gig.id, onDrive);
    compareTablet(m, 'B', await libraryOf(B));
    await doSync(m, B, 'Sync B (sends the edit made meanwhile, if it was not sent already)');
    await doSync(m, A, 'Sync A (gets it)');
    await agree(m, [A, B], 'at the end');
    LA = await libraryOf(A);
    assert(LA.sets[gig.id].name === 'Typed on B meanwhile', 'the edit made on B during a Sync did not reach A');

    /* a record here whose time is not a number: left out, and listed, never sent */
    const odd = {id: 'soddtime', name: 'Odd time list', items: [], colls: [], created: 1, updated: 'yesterday'};
    await writeRecord(A, 'sets', odd);
    adopt(m, 'A', 'set', (await libraryOf(A)).sets.soddtime);
    const ro = await doSync(m, A, 'Sync A (a setlist whose time is not a date)', {invalid: new Set(['set:soddtime'])});
    assert(/its time is not a date/.test(ro.rep.text), 'the report does not say why the setlist was left out: ' + ro.rep.text);
    assert(!readDrive(g).recs.set.has('soddtime') && !writesIn(ro.log, 'A').length, 'a record whose time is not a date was sent');
  } finally { await A.close(); if(B) await B.close(); }
}

/* ---------- 2f: a new chart on one tablet, newer details on the other: no chart is lost ---------- */
async function loopChart(ctx){
  const A = await startA(ctx);
  let B = null;
  try{
    const L0 = await libraryOf(A), b = songBy(L0, 'two-page');
    const m = newModel(); addTablet(m, 'A', L0);
    await doSync(m, A, 'first Sync on A');
    B = await makeFromBackup(ctx, A);
    await syncTap(B);
    /* A gives b a new chart (its old chart becomes an archived copy); B, later, edits b's details: B's whole record is newer */
    await newVersionUi(A, b.id, 'songbook.pdf');
    await sleep(30);
    await editSong(B, b.id, {version: 'edited on B'});
    const charts = async () => new Set([...Object.values((await libraryOf(A)).files), ...Object.values((await libraryOf(B)).files)]);
    const before = await charts();
    assert(before.has(H('songbook.pdf')) && before.has(b.hash), 'the test did not make the two charts');
    /* sync until nothing moves (at most four rounds) */
    let calm = false;
    for(let i = 0; i < 4 && !calm; i++){
      A.google.clearLog();
      const ra = await syncTap(A), rb = await syncTap(B);
      const w = writesIn(A.google.requests, 'A').length + writesIn(A.google.requests, 'B').length;
      calm = /Everything is up to date/.test(ra.text) && /Everything is up to date/.test(rb.text) && !w;
      for(const r of [ra, rb]) assert(r.state === 'finished', 'a Sync did not finish: ' + r.text);
    }
    assert(calm, 'the two tablets never settled: every round still had work to do');
    const LA = await libraryOf(A), LB = await libraryOf(B);
    const d = diff(libOnly(LA), libOnly(LB));
    assert(!d.length, 'A and B are not the same library: ' + d.join(' | '));
    const after = await charts();
    for(const h of before) assert(after.has(h), `a chart (sha-256 ${h.slice(0, 12)}) is gone from both tablets`);
    assert(LA.songs[b.id].version === 'edited on B', 'the newer whole record (B\'s details) did not win: ' + LA.songs[b.id].version);
    for(const h of before){
      const n = live(LA).filter(s => s.hash === h).length;
      assert(n >= 1, `no song holds the chart ${h.slice(0, 12)}`);
    }
    const copies = live(LA).filter(s => s.archived && /(old|replaced) \d{4}-/.test(s.version));
    const sb = copies.filter(s => s.hash === H('songbook.pdf')).length;
    assert(sb === (LA.songs[b.id].hash === H('songbook.pdf') ? 0 : 1), `the chart that lost has ${sb} archived copies (one expected): ` + copies.map(s => s.title).join(', '));
    for(const h of new Set(copies.map(s => s.hash))) assert(copies.filter(s => s.hash === h).length === 1, 'an archived copy was doubled: ' + copies.map(s => s.title).join(', '));
    for(const [id, h] of Object.entries(LA.files)) assert(LA.songs[id] && LA.songs[id].hash === h, `a stored PDF does not match its song ${id}`);
    const drive = readDrive(A.google);
    assert(!drive.problems.length, 'Drive layout: ' + drive.problems.join(' | '));
    for(const t of [A, B]) assert(!t.watch.violations.length && !pageErrors(t).length, `${t.name}: ${[...t.watch.violations, ...pageErrors(t)].join(' | ')}`);
  } finally { await A.close(); if(B) await B.close(); }
}

export const loops = [
  {name: 'sync 2a: two tablets: a full library, B from A\'s backup, different songs edited on each (rename, New version, archive, reorder, collection rename and membership); A = B = Drive = the model, after a reload and a backup round trip; layout, order, foreign files, nothing per-tablet on Drive', run: loopWalk},
  {name: 'sync 2b: the same song and setlist changed on both (the newer whole record wins and is named), an unknown field goes there and back, equal times are settled the same way on both and stay settled', run: loopBoth},
  {name: 'sync 2c: a tablet with its clock a year ahead: its record syncs, the other tablet\'s report says a date is ahead, and a later edit there still wins', run: loopClock},
  {name: 'sync 2d: deletions answered through the box: Keep brings the song back with its PDF, Delete here removes the setlist, and nothing is asked again', run: loopDeletions},
  {name: 'sync 2f: a new chart on A and newer details on B for the same song: the newer details win whole, no chart is lost (an archived copy keeps the one that lost, once), and the tablets settle', run: loopChart},
  {name: 'sync 2e: what comes down is checked (a PDF that does not match, a missing PDF, a record to refuse are skipped and named, nothing written or deleted) and written whole; an edit made during a Sync is not written over', run: loopChecked},
];

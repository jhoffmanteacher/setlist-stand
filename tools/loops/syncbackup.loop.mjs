/*
 * Drive sync Job 4: a backup copy of the whole library in the person's Google Drive, made at the end of a finished sync
 * (js/drivebackup.js): "sync backup a" .. "sync backup j". The app runs for real; Drive is the stand-in (fake-google.mjs).
 *
 * The rules under test: a marked "Backups" folder the sync never reads; the copy is the SAME file Back up everything saves (two
 * independent paths to one backup, compared byte for byte, and restored on a fresh tablet); due only when the newest copy in Drive
 * AND this tablet's own note are 7 or more days old; the last 4 kept, older ones moved to the Drive bin, a file that is not ours
 * never touched; the sync is finished whatever happens to the copy (Drive full, Stop, an address that cannot be read, too big).
 *
 * A copy is due at a tablet's FIRST sync, so a case that needs a quiet sync first sets `ss-drive-backup` to now (no copy at that
 * sync) and removes it again before the sync under test (quiet(): nothing is sent, so only the copy can need space or time).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {JSZip, TMP, assert, sleep, diff, sha256, backupNow, restoreZip, PDFDocument} from './harness.mjs';
import {openTablet, tapSync, finishSync, syncTap, libraryOf, readDrive, setClock} from './sync-two.mjs';
import {startA, startPair, live, timelessLib, saveSong, pageErrors} from './sync-kit.mjs';

const DAY = 864e5, FOLDER = 'application/vnd.google-apps.folder';
const finished = (r, what) => assert(r.state === 'finished', `${what}: the sync did not finish: ${r.title}: ${r.text.slice(0, 500)}`);
const noErrors = (...ts) => { for(const t of ts){ const e = pageErrors(t); assert(!e.length, `${t.name}: page errors: ${e.join(' | ')}`); } };
const ls = (t, k) => t.page.evaluate(k => localStorage.getItem(k), k);
const setLs = (t, k, v) => t.page.evaluate(([k, v]) => v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v), [k, v]);
const SAVED = /Saved a backup copy in your Google Drive \((setlist-stand-backup-\d{4}-\d{2}-\d{2}\.zip), (\d+) MB\)\. The last 4 are kept in the Backups folder\./;
const uploads = (t, from) => t.google.requests.slice(from).filter(e => e.by === t.name && e.kind === 'upload');
const copies = g => readDrive(g).backups;
/* The stand-in dates a file with the real clock; in these cases the tablet's clock is moved on. Real Drive's clock and the tablet's agree, so the newest
   copy is dated the way the tablet's clock saw it: `ahead` ms after real time. */
const datedAs = (g, ahead) => { const [newest] = copies(g); g.files.get(newest.id).createdTime = new Date(Date.now() + ahead).toISOString(); };
const sound = (g, what) => { const p = readDrive(g).problems; assert(!p.length, `${what}: Drive layout problems: ${p.join(' | ')}`); };
/* a first sync with no copy (the tablet's own note says it made one just now), then the note is taken away: the next sync finds a copy due */
async function syncedQuietly(t){
  await setLs(t, 'ss-drive-backup', String(Date.now()));
  const r = await syncTap(t);
  finished(r, 'the first Sync (copy held back by the tablet\'s own note)');
  assert(!/backup copy/.test(r.text), 'a backup copy was made or reported although this tablet\'s own note said it made one just now: ' + r.text);
  await setLs(t, 'ss-drive-backup', null);
  return r;
}
const waitStatus = (t, re, ms = 30000) => t.page.waitForFunction(src => new RegExp(src).test((document.querySelector('.modal p[role=status]') || {}).textContent || ''), re.source, {timeout: ms, polling: 'raf'})
  .catch(async () => { throw new Error(`the Syncing box never said ${re}; the top box says: ${JSON.stringify(await t.page.evaluate(() => [...document.querySelectorAll('.modal')].map(m => (m.innerText || '').replace(/\s+/g, ' ').slice(0, 300))))}`); });

/* ---------- a: the first Sync makes one copy; the copy is the very backup Back up everything makes; it restores; it counts as a backup ---------- */
async function loopFirst(ctx){
  const A = await startA(ctx);
  let R = null;
  try{
    const r1 = await syncTap(A);
    finished(r1, 'the first Sync');
    const m = SAVED.exec(r1.text);
    assert(m, 'the report does not say a backup copy was saved: ' + r1.text);
    assert(r1.text.indexOf('Saved a backup copy') > r1.text.indexOf('Sent '), 'the copy\'s line does not come after what the sync did');
    const d = readDrive(A.google);
    assert(!d.problems.length, 'Drive layout: ' + d.problems.join(' | '));
    assert(d.backups.length === 1 && d.backupFolder && d.backups[0].name === m[1], `${d.backups.length} copies in the Backups folder, the report names ${m && m[1]}`);
    assert(!d.foreign.length, 'a file the app made is reported as not ours: ' + d.foreign.map(f => f.name).join(', '));
    assert(!A.watch.violations.length, 'order on Drive: ' + A.watch.violations.join(' | '));
    /* (before Back up everything, which sets the same note) this tablet remembers it, and counts it as a backup (the decision of 2026-11-23): the time packing began */
    const own = Number(await ls(A, 'ss-drive-backup')), last = Number(await ls(A, 'ss-last-backup'));
    assert(own > 0 && Math.abs(own - d.backups[0].t) < 1 && last >= own, `ss-drive-backup ${own}, ss-last-backup ${last}, the file says it began at ${d.backups[0].t}`);
    /* the same backup, made by the other path: Back up everything right after (nothing changed in between) */
    const bk = await backupNow(A.page);
    const mine = await JSZip.loadAsync(fs.readFileSync(bk.file)), theirs = await JSZip.loadAsync(d.backups[0].bytes);
    assert(bk.name === d.backups[0].name, `the copy is named ${d.backups[0].name}, Back up everything names its file ${bk.name}`);
    const strip = async z => { const j = JSON.parse(await z.file('library.json').async('string')); delete j.saved; return j; };
    const dj = diff(await strip(theirs), await strip(mine));
    assert(!dj.length, 'library.json of the copy in Drive differs from the one Back up everything makes: ' + dj.join(' | '));
    const names = z => Object.keys(z.files).filter(n => !z.files[n].dir).sort();
    assert(JSON.stringify(names(theirs)) === JSON.stringify(names(mine)), 'the files in the copy are not the files in the backup');
    for(const n of names(theirs)) if(n !== 'library.json'){
      assert(sha256(await theirs.file(n).async('nodebuffer')) === sha256(await mine.file(n).async('nodebuffer')), `${n} differs between the copy in Drive and the backup`);
    }
    /* and it restores: a fresh tablet restored from the copy holds A's library */
    const file = path.join(TMP, 'drive-copy-a.zip'); fs.writeFileSync(file, d.backups[0].bytes);
    R = await openTablet(ctx, {name: 'R'});
    await restoreZip(R.page, file);
    const dl = diff(timelessLib(await libraryOf(R)), timelessLib(await libraryOf(A)));
    assert(!dl.length, 'a tablet restored from the copy in Drive does not hold A\'s library: ' + dl.slice(0, 5).join(' | '));
    assert(Number(await ls(A, 'ss-last-sync')) > 0, 'ss-last-sync is not set');
    for(const f of A.google.files.values()) assert(!/ss-drive-backup|ss-last-sync/.test(JSON.stringify(f.appProperties) + f.name), 'a per-tablet note is on Drive');
    noErrors(A);
  } finally { await A.close(); if(R) await R.close(); }
}

/* ---------- b: the reminder: a copy counts as a backup until something changes; a quiet sync the same day makes no copy ---------- */
async function loopQuiet(ctx){
  const A = await startA(ctx);
  try{
    finished(await syncTap(A), 'the first Sync');
    await A.page.click('#tSets'); await A.page.click('#tLib'); await sleep(300);
    const nudge = () => A.page.locator('#libNudge').innerText().catch(() => '');
    assert(!/backup/i.test(await nudge()), 'the backup reminder shows right after a sync that saved a copy: ' + await nudge());
    const first = copies(A.google)[0].id, id = live(await libraryOf(A))[0].id;
    await saveSong(A, id, {version: 'changed after the copy'});
    await A.page.click('#tSets'); await A.page.click('#tLib'); await sleep(300);
    assert(/Changes since your last backup \(today\)/.test(await nudge()), 'a change after the copy does not turn the backup reminder on: ' + await nudge());
    const g0 = A.google.requests.length;
    const r2 = await syncTap(A);
    finished(r2, 'the second Sync, the same day');
    assert(!/backup copy/.test(r2.text), 'a second Sync the same day mentions a backup copy: ' + r2.text);
    assert(copies(A.google).length === 1, `${copies(A.google).length} copies after a second Sync the same day`);
    assert(copies(A.google)[0].id === first, 'the copy in Drive was replaced by a second Sync');
    const into = (A.google.files.get(copies(A.google)[0].id).parents || [])[0];
    assert(!uploads(A, g0).some(e => A.google.files.get(e.path.split('/').pop()) && A.google.files.get(e.path.split('/').pop()).parents.includes(into)), 'an upload into the Backups folder at a second Sync the same day');
    assert(uploads(A, g0).length <= 2, `${uploads(A, g0).length} uploads at a second Sync that only sends one changed song`);       // that song's record (and nothing like a copy of the library)
    sound(A.google, 'after a second Sync');
    /* "Everything is up to date" is not lost to a copy: a third Sync with nothing at all to do says it */
    const r3 = await syncTap(A);
    assert(/Everything is up to date/.test(r3.text) && !/backup copy/.test(r3.text), 'a quiet Sync: ' + r3.text);
    noErrors(A);
  } finally { await A.close(); }
}

/* ---------- c: two tablets, one Drive, one week: ONE copy between them ---------- */
async function loopTwo(ctx){
  const {A, B} = await startPair(ctx);
  try{
    assert(copies(A.google).length === 1, 'A\'s first Sync did not make the one copy');
    const rb = await syncTap(B);
    finished(rb, 'B\'s Sync');
    assert(!/backup copy/.test(rb.text), 'B made or reported a copy although A\'s is in Drive: ' + rb.text);
    assert(copies(A.google).length === 1, `${copies(A.google).length} copies after both tablets synced`);
    assert(await ls(B, 'ss-drive-backup') == null, 'B noted a copy it did not make');
    /* B's tablet note alone is not what decides: B has not made one, yet nothing is due; and a week later one tablet makes it, once */
    await setClock(A, 8 * DAY);
    finished(await syncTap(A), 'A, eight days on');
    datedAs(A.google, 8 * DAY);
    await setClock(B, 8 * DAY);
    const rb2 = await syncTap(B);
    finished(rb2, 'B, eight days on');
    assert(!/backup copy/.test(rb2.text), 'B made a second copy at the same moment A had just made one: ' + rb2.text);
    assert(copies(A.google).length === 2, `${copies(A.google).length} copies after eight days and two tablets (2 expected)`);
    sound(A.google, 'two tablets');
    noErrors(A, B);
  } finally { await A.close(); await B.close(); }
}

/* ---------- d: keep the last 4; the older go to the Drive bin; nothing that is not ours is touched ---------- */
async function loopKeep(ctx){
  const A = await startA(ctx);
  try{
    finished(await syncTap(A), 'the first Sync');
    const g = A.google, d0 = readDrive(g);
    /* things that look a little like copies but are not ours to tidy */
    const unmarkedInBackups = g.addFile({name: 'my own notes.zip', mimeType: 'application/zip', parents: [d0.backupFolder.id], content: 'not a backup'});
    const markedInCharts = g.addFile({name: 'setlist-stand-backup-2020-01-01.zip', mimeType: 'application/zip', parents: [d0.charts.id], appProperties: {k: 'backup', t: '1577836800000'}, content: 'strays in Charts'});
    const unmarkedInHome = g.addFile({name: 'setlist-stand-backup-2019-01-01.zip', mimeType: 'application/zip', parents: [d0.home.id], content: 'in the home folder'});
    const names = [];
    for(let i = 1; i <= 5; i++){
      await setClock(A, i * 8 * DAY);
      const r = await syncTap(A);
      finished(r, `the Sync ${i * 8} days on`);
      const m = SAVED.exec(r.text);
      assert(m, `the Sync ${i * 8} days on made no copy: ${r.text}`);
      datedAs(g, i * 8 * DAY);
      assert(/\b1 file in your Drive folder did not come from this app and was left alone\./.test(r.text), `the strays line is not the one stray of Charts: ${r.text}`);
      assert(/Everything is up to date/.test(r.text), 'a copy hid "Everything is up to date": ' + r.text);
      names.push(m[1]);
    }
    const all = g.byProp('k', 'backup', {all: true}).filter(f => f.id !== markedInCharts).sort((a, b) => (a.createdTime < b.createdTime ? 1 : a.createdTime > b.createdTime ? -1 : 0));
    assert(all.length === 6, `${all.length} copies made over six weeks (6 expected)`);
    const kept = all.slice(0, 4), gone = all.slice(4);
    assert(kept.every(f => !f.trashed), 'one of the 4 newest copies is not in Drive any more');
    assert(gone.every(f => f.trashed && f.content && f.content.length > 100), 'the 2 oldest are not in the Drive bin with their content (moved to the bin, never deleted)');
    assert(copies(g).length === 4, `${copies(g).length} copies in the Backups folder, 4 expected`);
    for(const id of [unmarkedInBackups, markedInCharts, unmarkedInHome]) assert(g.files.has(id) && !g.files.get(id).trashed, 'a file that is not a copy of ours was moved or deleted: ' + g.files.get(id)?.name);
    const p = readDrive(g).problems.filter(x => !/is not in the Backups folder/.test(x));
    assert(!p.length, 'Drive layout: ' + p.join(' | '));
    assert(readDrive(g).problems.length === 1, 'the decoy copy in Charts is not the one layout note');
    const f0 = readDrive(g).foreign.map(f => f.id).sort();
    assert(f0.includes(unmarkedInBackups) && f0.includes(unmarkedInHome), 'the files that are not ours are not listed as foreign');
    noErrors(A);
  } finally { await A.close(); }
}

/* ---------- e: Drive full: the sync is finished, the copy says so, nothing is half there; the next sync with room makes it ---------- */
async function loopFull(ctx){
  const A = await startA(ctx);
  try{
    await syncedQuietly(A);
    const g = A.google, full = /Your Google Drive is full, so no backup copy was saved\. The sync itself is done\./;
    const noCopy = async what => {
      assert(await ls(A, 'ss-drive-backup') == null && await ls(A, 'ss-last-backup') == null, `${what}: a copy that was not saved was noted as made`);
      assert(copies(g).length === 0 && ![...g.files.values()].some(f => f.trashed), `${what}: a copy is half there, or something was moved to the bin`);
    };
    /* (1) the stand-in refuses everything that makes a file, even the Backups folder; (2) real Drive makes the empty folder and refuses the upload (it holds bytes) */
    for(const [what, set] of [['the folder is refused', on => { g.quotaFull = on; }], ['the upload is refused', on => { if(on) g.failNext(403, {reason: 'storageQuotaExceeded', times: 50, match: e => e.kind === 'upload'}); else g.faults = []; }]]){
      const before = Number(await ls(A, 'ss-last-sync'));
      set(true);
      const r = await syncTap(A);
      set(false);
      finished(r, `a Sync whose backup copy found Drive full (${what})`);
      assert(full.test(r.text), `${what}: the full Drive is not said: ${r.text}`);
      assert(/Everything is up to date/.test(r.text), `${what}: the report lost "Everything is up to date": ${r.text}`);
      assert(Number(await ls(A, 'ss-last-sync')) > before, `${what}: ss-last-sync was not set by the sync that ended with a full Drive`);
      await noCopy(what);
    }
    const r2 = await syncTap(A);
    finished(r2, 'the Sync with room again');
    assert(SAVED.test(r2.text) && copies(g).length === 1, 'the copy was not made once Drive had room: ' + r2.text);
    sound(g, 'after a full Drive');
    noErrors(A);
  } finally { await A.close(); }
}

/* ---------- f: Stop ends only the copy ---------- */
async function loopStop(ctx){
  const A = await startA(ctx);
  try{
    await syncedQuietly(A);
    /* while it is being sent */
    A.google.latency = 500;
    await tapSync(A);
    await waitStatus(A, /Sending the backup copy/);
    await A.page.locator('.modal').last().getByRole('button', {name: 'Stop', exact: true}).click();
    const r = await finishSync(A);
    A.google.latency = 0;
    assert(r.state === 'finished' && /The backup copy was stopped\. The sync itself is done; a copy is made at a later sync\./.test(r.text), 'Stop while sending: ' + r.title + ': ' + r.text);
    assert(copies(A.google).length === 0, 'a copy is in Drive after Stop');
    assert(await ls(A, 'ss-drive-backup') == null && await ls(A, 'ss-last-backup') == null, 'a stopped copy was noted as made');
    assert(Number(await ls(A, 'ss-last-sync')) > 0, 'ss-last-sync is not set after Stop (the sync was finished)');
    /* The stand-in still finishes a request the page abandoned while it was waiting out its latency (real Drive keeps nothing of an
       upload that was cut off); clear what it makes late, so the next step starts from what real Drive would hold. */
    await sleep(900);
    for(const f of A.google.byProp('k', 'backup')) A.google.files.delete(f.id);
    /* while it is being packed: reading each PDF takes a moment, so "Packing song N of M" stays up long enough to press Stop */
    await A.page.evaluate(() => { const o = Blob.prototype.arrayBuffer; Blob.prototype.arrayBuffer = async function(){ await new Promise(r => setTimeout(r, 500)); return o.call(this); }; });
    await tapSync(A);
    await waitStatus(A, /Packing song/);
    await A.page.locator('.modal').last().getByRole('button', {name: 'Stop', exact: true}).click();
    const r2 = await finishSync(A);
    assert(r2.state === 'finished' && /The backup copy was stopped\./.test(r2.text), 'Stop while packing: ' + r2.title + ': ' + r2.text);
    assert(copies(A.google).length === 0 && await ls(A, 'ss-drive-backup') == null, 'a copy exists, or is noted, after Stop while packing');
    const r3 = await syncTap(A);
    assert(SAVED.test(r3.text) && copies(A.google).length === 1, 'the copy was not made at the next Sync: ' + r3.text);
    sound(A.google, 'after Stop');
    noErrors(A);
  } finally { await A.close(); }
}

/* ---------- g: a library over 5 MB goes as a resumable upload; if Google's upload address cannot be read the copy fails and the sync does not ---------- */
async function loopBig(ctx){
  const A = await startA(ctx);
  try{
    /* one chart of about 5.6 MB: the whole backup is over the 5 MB a single request carries */
    const doc = await PDFDocument.create(); doc.addPage([300, 400]);
    await doc.attach(crypto.randomBytes(5.6e6), 'pad.bin', {mimeType: 'application/octet-stream'});
    const file = path.join(TMP, 'sync-backup-big.pdf'); fs.writeFileSync(file, Buffer.from(await doc.save({useObjectStreams: false})));
    await A.page.click('#tLib'); await A.page.setInputFiles('#file', file);
    const end = Date.now() + 30000;
    while(!Object.values((await libraryOf(A)).songs).some(s => s.pages === 1 && s.hash === sha256(fs.readFileSync(file)))){ if(Date.now() > end) throw new Error('the big PDF was not added'); await sleep(200); }
    await setLs(A, 'ss-drive-backup', String(Date.now()));
    const keep = [...A.google.exposeHeaders];
    A.google.exposeHeaders = keep.filter(h => h !== 'location');
    const r1 = await syncTap(A);                                       // the chart cannot go up either (it is over 5 MB): skipped, the sync finishes
    finished(r1, 'the first Sync with a big chart and an unreadable upload address');
    await setLs(A, 'ss-drive-backup', null);
    const r2 = await syncTap(A);
    A.google.exposeHeaders = keep;
    finished(r2, 'a Sync whose backup copy cannot find the upload address');
    assert(/The backup copy could not be saved in Google Drive \(the browser could not read Google's upload address\)\. The sync itself is done; it is tried again at the next sync\./.test(r2.text), 'the failed copy is not said plainly: ' + r2.text);
    assert(copies(A.google).length === 0 && await ls(A, 'ss-drive-backup') == null, 'something is left of a copy that failed');
    assert(Number(await ls(A, 'ss-last-sync')) > 0, 'ss-last-sync is not set');
    const g0 = A.google.requests.length;
    const r3 = await syncTap(A);                                       // the address can be read now: the chart and the copy both go as resumable uploads
    finished(r3, 'the Sync once the upload address can be read');
    assert(SAVED.test(r3.text), 'no copy at the Sync after: ' + r3.text);
    assert(A.google.requests.slice(g0).some(e => e.kind === 'upload' && e.method === 'PUT'), 'the copy did not go as a resumable upload');
    const d = readDrive(A.google);
    assert(!d.problems.length && d.backups.length === 1, 'Drive layout: ' + d.problems.join(' | '));
    const z = await JSZip.loadAsync(d.backups[0].bytes), lib = await libraryOf(A);
    for(const [id, h] of Object.entries(lib.files)) assert(sha256(await z.file('files/' + id + '.pdf').async('nodebuffer')) === h, `the PDF ${id} in the copy is not the one on the tablet`);
    assert(d.backups[0].bytes.length > 5.6e6, 'the copy is smaller than its big chart');
    noErrors(A);
  } finally { await A.close(); }
}

/* ---------- h: nothing leaves for Google between syncs ---------- */
async function loopNoTap(ctx){
  const A = await startA(ctx);
  try{
    finished(await syncTap(A), 'the first Sync');
    await setClock(A, 9 * DAY);                      // a copy is due, and still nothing goes without a tap
    const g0 = A.google.requests.length;
    await A.page.click('#tSets'); await A.page.click('#tLib');
    await A.page.reload(); await A.page.waitForSelector('#libList [data-open]');
    await A.page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); dispatchEvent(new Event('online')); dispatchEvent(new Event('focus')); });
    await sleep(3000);
    assert(A.google.requests.length === g0, `${A.google.requests.length - g0} request(s) went to Google with no tap while a copy was due: ${A.google.requests.slice(g0, g0 + 5).map(e => e.method + ' ' + e.path).join(', ')}`);
    noErrors(A);
  } finally { await A.close(); }
}

/* ---------- i: too big: no copy is made, the sync is finished ---------- */
async function loopTooBig(ctx){
  const A = await startA(ctx);
  try{
    await syncedQuietly(A);
    await A.page.evaluate(async () => { (await import('./js/drivebackup.js')).limits.maxBytes = 1000; });
    const g0 = A.google.requests.length;
    const r = await syncTap(A);
    finished(r, 'a Sync with a library over the copy limit');
    assert(/Your library \(\d+ MB\) is too big for a backup copy in Google Drive\. Use Back up everything instead\./.test(r.text), 'too big is not said: ' + r.text);
    assert(copies(A.google).length === 0 && !readDrive(A.google).backupFolder && !uploads(A, g0).length, 'something of a copy went to Drive');
    assert(await ls(A, 'ss-drive-backup') == null && Number(await ls(A, 'ss-last-sync')) > 0, 'the notes are wrong after a copy that was too big');
    noErrors(A);
  } finally { await A.close(); }
}

/* ---------- j: when a copy is due: both the newest copy in Drive and this tablet's own note must be 7 or more days old ---------- */
async function loopDue(ctx){
  const A = await startA(ctx);
  try{
    await syncedQuietly(A);
    const g = A.google, ago = d => new Date(Date.now() - d * DAY).toISOString();
    const home = readDrive(g).home.id;
    const folder = g.addFile({name: 'Backups', mimeType: FOLDER, parents: [home], appProperties: {setlistStand: 'backups'}});
    const hand = (days) => g.addFile({name: 'setlist-stand-backup-2026-01-01.zip', mimeType: 'application/zip', parents: [folder], appProperties: {k: 'backup', t: String(Date.now() - days * DAY)}, content: 'an earlier copy', createdTime: ago(days)});
    const step = async (what, want) => {
      const r = await syncTap(A); finished(r, what);
      assert(SAVED.test(r.text) === want, `${what}: ${want ? 'a copy was due and none was made' : 'a copy was made though none was due'}: ${r.text}`);
      return r;
    };
    hand(3);                                                           // Drive's newest copy is 3 days old, this tablet has none noted: not due
    await step('a 3-day-old copy in Drive', false);
    const old = hand(8);                                               // (an older one does not matter: the newest counts)
    await step('a 3-day-old and an 8-day-old copy in Drive', false);
    for(const f of g.byProp('k', 'backup')) g.files.get(f.id).createdTime = ago(8);        // all 8 days old, this tablet noted one 3 days ago: not due
    await setLs(A, 'ss-drive-backup', String(Date.now() - 3 * DAY));
    await step('copies 8 days old in Drive, this tablet\'s own note 3 days old', false);
    await setLs(A, 'ss-drive-backup', String(Date.now() - 8 * DAY));
    await step('copies 8 days old in Drive and this tablet\'s own note 8 days old', true);
    assert(old && copies(g).length >= 3, 'the copies in the Backups folder are not what the test made');
    await setLs(A, 'ss-drive-backup', String(Date.now() + 400 * DAY));                    // a note from a clock that was far ahead counts as none
    for(const f of g.byProp('k', 'backup')) g.files.get(f.id).createdTime = ago(30);
    await step('this tablet\'s own note a year ahead (counts as none), Drive\'s copies 30 days old', true);
    noErrors(A);
  } finally { await A.close(); }
}

/* ---------- k: a tablet with nothing on it makes no copy (an empty copy must never push a good one out) ---------- */
async function loopEmpty(ctx){
  const A = await openTablet(ctx, {name: 'A'});
  try{
    const r = await syncTap(A);
    finished(r, 'the first Sync of an empty tablet');
    assert(!/backup copy/.test(r.text) && copies(A.google).length === 0 && !readDrive(A.google).backupFolder, 'an empty tablet made a backup copy: ' + r.text);
    assert(await ls(A, 'ss-drive-backup') == null && await ls(A, 'ss-last-backup') == null, 'an empty tablet noted a backup');
    noErrors(A);
  } finally { await A.close(); }
}

export const loops = [
  {name: 'sync backup a: the first Sync makes ONE copy in a marked Backups folder, byte for byte the backup Back up everything makes; a tablet restored from it holds the library; it counts as a backup', run: loopFirst},
  {name: 'sync backup b: the backup reminder goes quiet after a copy and comes back with a change; a second Sync the same day makes no copy and still says "Everything is up to date"', run: loopQuiet},
  {name: 'sync backup c: two tablets on one Drive make ONE copy a week between them', run: loopTwo},
  {name: 'sync backup d: the last 4 are kept, older ones go to the Drive bin with their content, files that are not ours are never touched, the strays line is unchanged', run: loopKeep},
  {name: 'sync backup e: a full Drive ends only the copy: the sync is finished, nothing half made, nothing noted, the next Sync makes it', run: loopFull},
  {name: 'sync backup f: Stop (while packing or sending) ends only the copy; the sync is finished and nothing is left in Drive', run: loopStop},
  {name: 'sync backup g: a copy over 5 MB goes as a resumable upload and equals the library; an upload address that cannot be read fails the copy only', run: loopBig},
  {name: 'sync backup h: nothing leaves for Google with no tap, even when a copy is due', run: loopNoTap},
  {name: 'sync backup i: a library over the limit makes no copy and says so; the sync is finished', run: loopTooBig},
  {name: 'sync backup k: a tablet with nothing on it makes no copy', run: loopEmpty},
  {name: 'sync backup j: a copy is due only when Drive\'s newest copy AND this tablet\'s own note are 7 or more days old (a note from a clock far ahead counts as none)', run: loopDue},
];

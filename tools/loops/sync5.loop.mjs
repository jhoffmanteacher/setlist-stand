/*
 * Drive sync Part 2, nothing leaves for Google without a tap: "sync 5a" .. "sync 5b".
 *
 * Work order Part 2, Guards and Hard stops: "No request to Google happens except from the Sync, Connect and Test buttons", no
 * automatic sync, no background sync, no sync on page load; the reminder line's Sync button never syncs by itself. Every request
 * is counted twice, independently: by the stand-in (everything routed to accounts.google.com and www.googleapis.com) and by the
 * browser context's own request log (any address with "google" in it, routed or not).
 */
import {JSZip, assert, sleep} from './harness.mjs';
import fs from 'node:fs';
import {signIn, finishSync, syncTap, libraryOf, readDrive, setClock} from './sync-two.mjs';
import {startA, startPair, roles, live, saveSong, putRecordFile, titleOf, pageErrors, YEAR} from './sync-kit.mjs';
const finished = (r, what) => assert(r.state === 'finished', `${what}: the sync did not finish: ${r.title}: ${r.text.slice(0, 400)}`);
import {backupNow} from './harness.mjs';

const googleUrls = t => t.s.requests.filter(u => /google/i.test(new URL(u).hostname));
const noErrors = t => { const e = pageErrors(t); assert(!e.length, `${t.name}: page errors: ${e.join(' | ')}`); };
/* Marks where the counts stand; quiet(mark, what) asserts nothing was added since. */
const mark = t => ({g: t.google.requests.length, u: googleUrls(t).length});
function quiet(t, m, what){
  const g = t.google.requests.slice(m.g), u = googleUrls(t).slice(m.u);
  assert(!g.length && !u.length, `${what}: ${g.length + u.length} request(s) left for Google without a tap: ${[...g.map(e => e.method + ' ' + e.path), ...u].slice(0, 6).join(', ')}`);
}
/* Everything a person does that is not a Drive button. */
async function everyday(t, what, {hold = 3000} = {}){
  const {page} = t, m = mark(t);
  for(let i = 0; i < 3; i++){ await page.click('#tSets'); await sleep(150); await page.click('#tLib'); await sleep(150); }
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true})); dispatchEvent(new Event('focus')); dispatchEvent(new Event('online')); });
  await page.evaluate(async () => { (await import('./js/util.js')).hooks.render(); });
  await sleep(hold);
  quiet(t, m, `${what}: idle, tab switches, visibilitychange, pageshow, focus, online and a redraw`);
  /* a song opened, page turns, left open, back */
  await page.click('#tLib');
  await page.click('#libList [data-open]');
  await page.waitForSelector('#vNext', {state: 'visible'});
  await sleep(500); await page.click('#vNext'); await sleep(300); await page.click('#vPrev');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(hold);
  quiet(t, m, `${what}: while a song is open`);
  await page.click('#vBack'); await page.waitForSelector('#libList');
  /* a setlist opened and played */
  await page.click('#tSets');
  if(await page.locator('#view [data-set]').count()){ await page.locator('#view [data-set]').first().click(); await sleep(300); await page.click('[data-allsets]'); }
  await page.click('#tLib');
  quiet(t, m, `${what}: setlists`);
}

/* ---------- 5a: a tablet that never taps a Drive button sends nothing to Google ---------- */
async function loopNever(ctx){
  const A = await startA(ctx);
  try{
    const m = mark(A);
    await everyday(A, 'never signed in', {hold: 2000});
    const id = live(await libraryOf(A))[0].id;
    await saveSong(A, id, {version: 'edited, never synced'});
    await sleep(800);
    assert(!(await A.page.locator('#libNudge [data-syncnow]').count()), 'the reminder offers Sync on a tablet that has never synced');
    const bk = await backupNow(A.page);
    await A.page.reload(); await A.page.waitForSelector('#libList');
    await sleep(2000);
    quiet(A, m, 'never signed in: an edit, a backup and a reload');
    assert(A.google.requests.length === 0 && googleUrls(A).length === 0, 'a tablet that never tapped a Drive button sent something to Google');
    const zip = await JSZip.loadAsync(fs.readFileSync(bk.file));
    for(const n of Object.keys(zip.files)){ const txt = await zip.file(n)?.async('string'); if(txt) assert(!/ss-last-sync|ss-sync-intro|ss-google/.test(txt), `the backup file ${n} holds a per-tablet sync setting`); }
    noErrors(A);
  } finally { await A.close(); }
}

/* ---------- 5b: signed in: nothing without a tap; the reminder's Sync button appears after a change and syncs only when tapped ---------- */
async function loopSignedIn(ctx){
  const A = await startA(ctx);
  try{
    await signIn(A);                                                   // Connect: one trip to the sign-in, nothing else
    await sleep(2500);
    assert(A.google.requests.every(e => e.kind === 'auth'), 'Connect sent Drive requests by itself: ' + A.google.requests.filter(e => e.kind !== 'auth').map(e => e.method + ' ' + e.path).join(', '));
    let m = mark(A);
    await everyday(A, 'signed in, before any sync');
    const songs = live(await libraryOf(A));
    await saveSong(A, songs[0].id, {version: 'change one'});
    await sleep(1000);
    assert(!(await A.page.locator('#libNudge [data-syncnow]').count()), 'the reminder offers Sync on a tablet that has never synced');
    quiet(A, m, 'signed in: an edit before the first sync');

    /* the first Sync, by its button */
    const r1 = await syncTap(A);
    assert(r1.state === 'finished' && A.google.requests.length > m.g, 'the Sync button did not sync: ' + r1.text);
    await sleep(500);
    assert(!(await A.page.locator('#libNudge [data-syncnow]').count()), 'the reminder offers Sync right after a sync, with nothing changed');
    m = mark(A);
    await everyday(A, 'signed in, after a sync');

    /* a change: the reminder offers Sync, and does not sync by itself */
    await saveSong(A, songs[1].id, {version: 'change two'});
    await A.page.click('#tSets'); await A.page.click('#tLib');
    await A.page.waitForSelector('#libNudge [data-syncnow]', {timeout: 8000}).catch(() => { throw new Error('the reminder does not offer Sync after a change since the last sync'); });
    await sleep(4000);
    quiet(A, m, 'the reminder line with its Sync button');
    await A.page.click('#tSets');
    assert(await A.page.locator('#libNudge [data-syncnow]').count(), 'the reminder on the Setlists tab does not offer Sync');
    quiet(A, m, 'the reminder on the Setlists tab');
    /* tapping it syncs */
    await A.page.click('#libNudge [data-syncnow]');
    const r2 = await finishSync(A);
    assert(r2.state === 'finished' && /Sent 1 song/.test(r2.text) && A.google.requests.length > m.g, 'the reminder\'s Sync button did not sync the change: ' + r2.text);
    await A.page.click('#tLib'); await sleep(400);
    assert(!(await A.page.locator('#libNudge [data-syncnow]').count()), 'the reminder still offers Sync after the change was synced');

    /* the per-tablet notes are never on Drive or in a backup */
    const ls = await A.page.evaluate(() => [localStorage.getItem('ss-last-sync'), localStorage.getItem('ss-sync-intro')]);
    assert(Number(ls[0]) > 0 && ls[1] === '1', 'ss-last-sync or ss-sync-intro is not set after a sync (the test is wrong): ' + JSON.stringify(ls));
    for(const f of A.google.files.values()){
      const hay = [f.name, JSON.stringify(f.appProperties), f.content ? f.content.toString('latin1') : ''].join('\n');
      assert(!/ss-last-sync|ss-sync-intro/.test(hay), `the Drive file "${f.name}" holds a per-tablet sync setting`);
    }
    const bk = await backupNow(A.page), zip = await JSZip.loadAsync(fs.readFileSync(bk.file));
    for(const n of Object.keys(zip.files)){ const txt = await zip.file(n)?.async('string'); if(txt) assert(!/ss-last-sync|ss-sync-intro/.test(txt), `the backup file ${n} holds a per-tablet sync setting`); }

    /* a page load (the sign-in is in memory only, so it is gone): nothing */
    m = mark(A);
    await A.page.reload(); await A.page.waitForSelector('#libList');
    await sleep(3000);
    quiet(A, m, 'a page load on a tablet that has synced');
    await everyday(A, 'after a reload', {hold: 1500});
    noErrors(A);
  } finally { await A.close(); }
}

/* ---------- 5c: a record dated ahead (from a tablet whose clock is wrong) never hides a real change, and matters for a day at most ---------- */
async function loopAhead(ctx){
  const A = await startA(ctx);
  const tabs = async () => { await A.page.click('#tSets'); await A.page.click('#tLib'); };
  const has = async sel => (await A.page.locator(sel).count()) > 0;
  try{
    finished(await syncTap(A), 'the first Sync');
    const songs = live(await libraryOf(A)), id = songs[0].id, other = songs.find(x => x.id !== id).id;
    /* the song comes back from Drive dated a year ahead (another tablet's clock) */
    const drive = readDrive(A.google), F = Date.now() + YEAR, fut = {...drive.recs.song.get(id), version: 'from ahead', updated: F};
    fut.title = titleOf(fut);
    putRecordFile(A.google, drive, 'song', fut);
    finished(await syncTap(A), 'Sync (gets the record dated ahead)');
    await backupNow(A.page); await sleep(300);
    /* a real change made now must show BOTH reminders: a record dated ahead may not sit above it and hide it (before: it did, for a year) */
    await saveSong(A, other, {version: 'a real change'});
    await tabs();
    assert(await has('#libNudge [data-backupnow]'), 'a real change after a backup shows no backup reminder (a record dated ahead hides it)');
    assert(await has('#libNudge [data-syncnow]'), 'a real change after a sync shows no sync reminder (a record dated ahead hides it)');
    /* two days later the record dated ahead no longer matters: after a backup and a sync, neither reminder is left on */
    await setClock(A, 2 * 86400e3);
    await backupNow(A.page); await sleep(300);
    finished(await syncTap(A), 'Sync (two days later)');
    await tabs();
    assert(!(await has('#libNudge [data-syncnow]')), 'two days later, after a sync, the reminder still says there are changes since the last sync (a record dated a year ahead keeps it on)');
    assert(!(await has('#libNudge [data-backupnow]')), 'two days later, after a backup, the reminder still asks for one (a record dated a year ahead keeps it on)');
    noErrors(A);
  } finally { await A.close(); }
}

const shows = async (t, sel) => { await t.page.click('#tSets'); await t.page.click('#tLib'); await sleep(250); return (await t.page.locator('#libNudge ' + sel).count()) > 0; };

/* ---------- 5d: the other tablet's clock is 2 hours ahead: its edit does not keep this tablet's sync reminder on ---------- */
async function loopClockAhead(ctx){
  const {A, B} = await startPair(ctx);
  try{
    const {a} = roles(await libraryOf(A));
    await backupNow(A.page);
    assert(!(await shows(A, '[data-backupnow]')) && !(await shows(A, '[data-syncnow]')), 'A shows a reminder before the test (the test is wrong)');
    await setClock(B, 2 * 3600e3);
    await saveSong(B, a.id, {version: 'edited on B, clock ahead'});
    finished(await syncTap(B), 'Sync B (clock 2 hours ahead)');
    finished(await syncTap(A), 'Sync A (gets the record dated 2 hours ahead)');
    const why = await A.page.evaluate(async () => ({newest: (await import('./js/store.js')).newestRecordChange(), synced: (await import('./js/sync.js')).lastSync(), now: Date.now()}));
    assert(!(await shows(A, '[data-syncnow]')), `right after a Sync that brought a record dated ahead, A says there are changes since its last sync (newest record change ${why.newest - why.now} ms from now, last sync ${why.synced - why.now} ms)`);
    assert(await shows(A, '[data-backupnow]'), 'after a Sync brought a change, A does not ask for a backup');
    const r2 = await syncTap(A);
    assert(/Everything is up to date/.test(r2.text) && !(await shows(A, '[data-syncnow]')), `a Sync with nothing to do leaves the sync reminder on, or had something to do: "${r2.text}"`);
    await backupNow(A.page);
    assert(!(await shows(A, '[data-backupnow]')), 'right after a backup A still asks for one (a record is dated 2 hours ahead)');
    await sleep(50);
    await saveSong(A, (await libraryOf(A)).songs[a.id].id, {version: 'a later edit on A'});
    assert(await shows(A, '[data-syncnow]'), 'an edit on A after the record dated ahead does not turn the sync reminder on');
    assert(await shows(A, '[data-backupnow]'), 'an edit on A after the record dated ahead does not turn the backup reminder on');
    noErrors(A);
  } finally { await A.close(); await B.close(); }
}

/* ---------- 5e: a backup or sync time stored while the clock was ahead counts as never ---------- */
async function loopStoredAhead(ctx){
  const A = await startA(ctx);
  try{
    finished(await syncTap(A), 'the first Sync');
    await backupNow(A.page);
    const ahead = Date.now() + 3 * 864e5;
    await A.page.evaluate(t => { localStorage.setItem('ss-last-backup', String(t)); localStorage.setItem('ss-last-sync', String(t)); }, ahead);
    await A.page.reload(); await A.page.waitForSelector('#libList');
    const st = await A.page.evaluate(async () => ({sync: (await import('./js/sync.js')).lastSync(), backup: (await import('./js/nudge.js')).lastBackup()}));
    assert(st.sync === 0 && st.backup === null, 'a time stored 3 days ahead is still trusted: ' + JSON.stringify(st));
    assert(/You have not backed up yet/.test(await A.page.locator('#libNudge').textContent()), 'with a backup time 3 days ahead the reminder does not say there is no backup: ' + await A.page.locator('#libNudge').textContent());
    assert(/Not synced on this tablet yet/.test(await A.page.locator('#libDriveLine').textContent()), 'with a sync time 3 days ahead the Library still says when it last synced');
    const id = live(await libraryOf(A))[0].id;
    await saveSong(A, id, {version: 'a change after the clock was fixed'});
    assert(await shows(A, '[data-backupnow]'), 'a change after the clock was fixed is hidden by the backup time stored ahead');
    finished(await syncTap(A), 'a Sync after the clock was fixed');
    assert(!(await shows(A, '[data-syncnow]')), 'right after a Sync the reminder offers Sync');
    await saveSong(A, id, {version: 'and another'});
    assert(await shows(A, '[data-syncnow]'), 'a change after the Sync does not turn the sync reminder on');
    noErrors(A);
  } finally { await A.close(); }
}

export const loops = [
  {name: 'sync 5a: a tablet that never taps a Drive button sends nothing to Google (idle, tabs, visibility, pageshow, a song open, an edit, a backup, a reload) and its backup holds no sync setting', run: loopNever},
  {name: 'sync 5c: a record dated a year ahead never hides a real change from either reminder, and keeps them on for a day at most', run: loopAhead},
  {name: 'sync 5d: the other tablet\'s clock 2 hours ahead: what a Sync brings is not a change to sync but is one to back up; a backup and a later edit work as usual', run: loopClockAhead},
  {name: 'sync 5e: a backup or sync time stored while the clock was ahead counts as never and hides no later change', run: loopStoredAhead},
  {name: 'sync 5b: signed in, nothing leaves without a tap (idle, events, a song open, redraws, the reminder line, a page load); the reminder\'s Sync appears only after a change since a sync and syncs when tapped; sync settings never on Drive or in a backup', run: loopSignedIn},
];

/*
 * Sync reminder: "Last synced N days ago." (js/nudge.js). After 7 calendar days on a tablet that has synced before, the reminder
 * line offers Sync, worked out from the clock alone. Nothing may go to Google without a tap: the whole loop asserts zero requests.
 */
import {assert, sleep, backupNow} from './harness.mjs';
import {startA, saveSong, live} from './sync-kit.mjs';
import {libraryOf, openTablet} from './sync-two.mjs';

const DAY = 864e5;
const line = t => t.page.evaluate(() => { const n = document.querySelector('#libNudge .nudge'); return n ? {text: n.querySelector('span').innerText.trim(), btns: [...n.querySelectorAll('button')].map(b => b.textContent.trim())} : null; });
async function setSync(t, ms){ await t.page.evaluate(v => v === null ? localStorage.removeItem('ss-last-sync') : localStorage.setItem('ss-last-sync', String(v)), ms); await t.page.reload(); await t.page.waitForSelector('#libList'); await sleep(500); }
/* The tablet synced just now (after every record here), then the clock moves n days on: records stay older than the sync. */
async function agoDays(t, n){ await t.page.evaluate(() => localStorage.setItem('ss-last-sync', String(Date.now()))); await t.page.clock.setSystemTime(await t.page.evaluate(() => Date.now()) + n * DAY); await t.page.reload(); await t.page.waitForSelector('#libList'); await sleep(500); }
/* n calendar days ago, at local noon: the app counts calendar days, so "now minus n days minus an hour" made it n + 1 between midnight and 1 am */
const days = n => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime() - n * DAY; };      // for a tablet with no records to compare (loop 2)
const none = async (t, what) => { const l = await line(t); assert(!l, `${what}: a reminder shows: ${JSON.stringify(l)}`); };
const same = async (t, text, btns, what) => { const l = await line(t); assert(l && l.text === text && JSON.stringify(l.btns) === JSON.stringify(btns), `${what}: got ${JSON.stringify(l)}, wanted "${text}" with ${btns.join(', ')}`); };
async function onTabs(t, fn){
  await t.page.click('#tSets'); await sleep(250); await fn('Setlists tab');
  if(await t.page.locator('#view [data-set]').count()){ await t.page.locator('#view [data-set]').first().click(); await sleep(300); await fn('an open setlist'); await t.page.click('#tSets'); await sleep(200); }
  await t.page.click('#tLib'); await sleep(250);
}

async function loopRemind(ctx){
  const A = await startA(ctx);
  try{
    await backupNow(A.page);
    await A.page.evaluate(() => localStorage.setItem('ss-sync-intro', '1'));
    await setSync(A, null);
    await none(A, 'never synced'); await onTabs(A, w => none(A, 'never synced, ' + w));
    await agoDays(A, 6);
    await none(A, '6 days ago');
    await agoDays(A, 7);
    await same(A, 'Last synced 7 days ago.', ['Sync'], '7 days ago, Library');
    await onTabs(A, async w => same(A, 'Last synced 7 days ago.', ['Sync'], '7 days ago, ' + w));
    /* never in the viewer */
    await A.page.click('#libList [data-open]'); await A.page.waitForSelector('#vNext', {state: 'visible'});
    assert(await A.page.evaluate(() => { const v = document.querySelector('#viewer').getBoundingClientRect(), n = document.querySelector('#libNudge .nudge'); if(!n) return true; const r = n.getBoundingClientRect(); return !document.querySelector('#viewer').contains(n) && v.width >= innerWidth && v.height >= innerHeight && getComputedStyle(document.querySelector('#viewer')).position === 'fixed' && r.height > 0; }), 'the reminder is not covered by the viewer');
    await A.page.click('#vBack'); await A.page.waitForSelector('#libList');
    /* a change here: today's combined line, no stale clause */
    const id = live(await libraryOf(A))[0].id;
    await backupNow(A.page); await sleep(50);
    await saveSong(A, id, {version: 'a change'}); await sleep(500);
    await same(A, 'Changes since your last backup (today) and your last sync (7 days ago).', ['Back up now', 'Sync'], 'changed and 7 days');
    await backupNow(A.page); await sleep(300);
    await same(A, 'Changes since your last sync (7 days ago).', ['Sync'], 'backed up, changed since sync');
    /* a time stored a year ahead counts as never */
    await setSync(A, Date.now() + 365 * DAY);
    await none(A, 'a sync time a year ahead');
    /* time passes with the page open: picked up again */
    await agoDays(A, 5);
    await none(A, '5 days ago');
    await A.page.clock.setSystemTime(await A.page.evaluate(() => Date.now()) + 3 * DAY);
    await A.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await sleep(300);
    await same(A, 'Last synced 8 days ago.', ['Sync'], 'after 3 more days, no reload');
    /* backup due and stale together */
    await A.page.evaluate(() => localStorage.removeItem('ss-last-backup'));
    await A.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await sleep(300);
    await same(A, 'You have not backed up yet. Last synced 8 days ago.', ['Back up now', 'Sync'], 'never backed up and stale');
    await backupNow(A.page); await agoDays(A, 8);
    /* the Sync button: signed out, it asks to sign in and sends nothing */
    await A.page.click('#libNudge [data-syncnow]');
    await A.page.waitForSelector('dialog[open], [role=dialog]', {timeout: 5000});
    const txt = await A.page.locator('[role=dialog]').first().innerText();
    assert(/Sign in to sync/.test(txt), 'the reminder\'s Sync did not ask to sign in: ' + txt);
    await A.page.keyboard.press('Escape'); await sleep(300);
    assert(!(await A.page.evaluate(() => sessionStorage.getItem('ss-google-pending') || localStorage.getItem('ss-google-pending'))), 'a sign-in was started');
    assert(A.google.requests.length === 0, `${A.google.requests.length} request(s) went to Google without a tap: ${A.google.requests.map(e => e.method + ' ' + e.path).join(', ')}`);
  } finally { await A.close(); }
}

async function loopNoSongs(ctx){
  const A = await openTablet(ctx, {name: 'E'});
  try{
    await A.page.evaluate(v => localStorage.setItem('ss-last-sync', String(v)), days(9));
    await A.page.reload(); await A.page.waitForSelector('#libList', {state: 'attached'}); await sleep(500);
    assert(await A.page.locator('#libList [data-open]').count() === 0, 'the test library has songs');
    await same(A, 'Last synced 9 days ago.', ['Sync'], 'no songs, synced 9 days ago');
    assert(A.google.requests.length === 0, 'requests went to Google');
  } finally { await A.close(); }
}

export const loops = [
  {name: 'sync reminder 1: "Last synced N days ago." after 7 days (words and buttons with the backup reminder, every tab, never in the viewer, a year ahead = never, redraws when picked up) and zero requests to Google', run: loopRemind},
  {name: 'sync reminder 2: no songs here, synced 9 days ago: the line still shows', run: loopNoSongs},
];

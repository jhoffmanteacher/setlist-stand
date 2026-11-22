/*
 * Data-safety loops: the backup reminder, the storage line, the backup version guard, a full tablet, the private
 * problem log and duplicate imports. Each one drives the real UI in a fresh browser context.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {FIX, TMP, JSZip, assert, sleep, sha256, idbAll, snapshot, diff, backupNow, download} from './harness.mjs';

const songCount = page => page.locator('#libList [data-open]').count();
const waitSongs = (page, n, ms = 15000) => page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, n, {timeout: ms})
  .catch(async () => { throw new Error(`expected ${n} songs, library shows ${await songCount(page)}`); });
const clearToast = page => page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
async function waitToast(page, re, ms = 15000){
  await page.waitForFunction(src => new RegExp(src).test(document.querySelector('#toast').textContent), re.source, {timeout: ms})
    .catch(async () => { throw new Error(`toast ${re} did not show; toast is "${await page.locator('#toast').textContent()}"`); });
  return page.locator('#toast').textContent();
}
async function importFiles(page, files){
  await page.click('#tLib');
  await clearToast(page);
  await page.setInputFiles('#file', files);
}
function expectSame(a, b, what){
  const d = diff(a, b, '', [], 20);
  assert(!d.length, `${what}: ${d.length} difference(s):\n    ` + d.join('\n    '));
}
function noErrors(s, allow = null){
  const bad = s.errors.filter(e => !(allow && allow.test(e)));
  assert(bad.length === 0, 'page errors: ' + bad.join(' | '));
}
const nudgeText = page => page.evaluate(() => document.querySelector('#libNudge')?.innerText.trim() || '');
const lastText = page => page.evaluate(() => document.querySelector('#libLastBackup')?.textContent.trim() || '');
const DAY = 864e5;

export const loops = [

{name: 'hygiene: backup reminder shows when never or long ago backed up, and goes after a backup', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    assert(await nudgeText(page) === '', 'empty library shows a backup reminder: ' + await nudgeText(page));
    assert(await lastText(page) === '', 'empty library shows a last-backup line: ' + await lastText(page));

    await importFiles(page, [path.join(FIX, 'one-page.pdf')]);
    await waitSongs(page, 1);
    assert(/^You have not backed up yet\.\s*Back up now$/.test(await nudgeText(page)), 'reminder after the first song: ' + JSON.stringify(await nudgeText(page)));
    assert(await page.locator('#libNudge').evaluate(n => n.compareDocumentPosition(document.querySelector('#libList')) & Node.DOCUMENT_POSITION_FOLLOWING), 'the reminder is not above the song list');

    /* a real backup through the Library button (a download) */
    const t0 = Date.now();
    const dl = await backupNow(page);
    assert(fs.statSync(dl.file).size > 0, 'backup download is empty');
    await page.waitForFunction(() => !document.querySelector('#libNudge .nudge'), null, {timeout: 5000})
      .catch(async () => { throw new Error('reminder still shown after a backup: ' + await nudgeText(page)); });
    assert(await lastText(page) === 'Last backup: today.', 'hint after a backup: ' + JSON.stringify(await lastText(page)));
    const stored = Number(await page.evaluate(() => localStorage.getItem('ss-last-backup')));
    assert(stored >= t0 - 1000 && stored <= Date.now() + 1000, 'ss-last-backup is not the time of the backup: ' + stored);

    /* 10 days ago: no reminder yet, just the quiet line */
    await page.evaluate(t => localStorage.setItem('ss-last-backup', String(t)), Date.now() - 10 * DAY);
    await s.goto();
    assert(await nudgeText(page) === '', '10 days: reminder shown: ' + await nudgeText(page));
    assert(await lastText(page) === 'Last backup: 10 days ago.', '10 days: hint ' + JSON.stringify(await lastText(page)));

    /* 20 days ago: the reminder, and its own button makes a backup */
    await page.evaluate(t => localStorage.setItem('ss-last-backup', String(t)), Date.now() - 20 * DAY);
    await s.goto();
    assert(/^Last backup: 20 days ago\.\s*Back up now$/.test(await nudgeText(page)), '20 days: reminder ' + JSON.stringify(await nudgeText(page)));
    assert(await lastText(page) === '', '20 days: quiet line shown as well: ' + await lastText(page));
    const dl2 = await download(page, () => page.click('#libNudge [data-backupnow]'));
    assert(/^setlist-stand-backup-.*\.zip$/.test(dl2.name), 'reminder button download name: ' + dl2.name);
    await page.waitForFunction(() => !document.querySelector('#libNudge .nudge'), null, {timeout: 5000})
      .catch(() => { throw new Error('reminder still shown after "Back up now"'); });
    assert(await lastText(page) === 'Last backup: today.', 'hint after "Back up now": ' + JSON.stringify(await lastText(page)));
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'hygiene: storage line shows use and protection, and never breaks when the API is missing', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    await page.waitForSelector('#libStorage [data-storage]', {timeout: 5000}).catch(() => { throw new Error('no storage line'); });
    const line = (await page.locator('#libStorage [data-storage]').textContent()).trim();
    assert(/^Storage: (less than 1 MB|\d+ MB|[\d.]+ GB) used of about [\d.]+ (MB|GB)\.$/.test(line), 'storage line: ' + JSON.stringify(line));
    const persisted = await page.evaluate(() => navigator.storage.persisted());
    if(!persisted){
      const w = (await page.locator('#libStorage [data-unprotected]').textContent()).trim();
      assert(w === "Your browser may clear this app's data if the tablet runs low on space. Back up regularly.", 'unprotected warning: ' + JSON.stringify(w));
      await clearToast(page);
      await page.click('#libStorage [data-persist]');
      await waitToast(page, /^(The browser will keep this app's data\.|The browser did not agree\. Back up regularly\.)$/);
      await sleep(300);
      assert(await page.locator('#libStorage [data-storage]').count() === 1, 'storage line gone after asking for protection');
      const now = await page.evaluate(() => navigator.storage.persisted());
      assert(await page.locator(now ? '#libStorage [data-protected]' : '#libStorage [data-persist]').count() === 1, `line does not match persisted() = ${now} after the tap`);
    } else assert(await page.locator('#libStorage [data-protected]').count() === 1, 'persisted but no "will keep" line');
    noErrors(s);
  } finally { await s.close(); }

  /* nearly full: 950 MB used of 1 GB */
  const f = await ctx.session();
  try{
    await f.context.addInitScript(() => {
      if(navigator.storage) navigator.storage.estimate = async () => ({usage: 950e6, quota: 1e9});
    });
    await f.goto();
    await f.page.waitForSelector('#libStorage [data-storage]', {timeout: 5000});
    const t = (await f.page.locator('#libStorage').innerText()).replace(/\s+/g, ' ');
    assert(t.includes('Storage: 950 MB used of about 1 GB.') && t.includes('The tablet is nearly full.'), 'nearly full: ' + t);
    noErrors(f);
  } finally { await f.close(); }

  /* no storage API at all: nothing shown, nothing thrown */
  const m = await ctx.session();
  try{
    await m.context.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'storage', {get: () => undefined, configurable: true}); });
    await m.goto();
    await sleep(500);
    assert(await m.page.evaluate(() => navigator.storage === undefined), 'could not remove navigator.storage');
    assert((await m.page.locator('#libStorage').innerHTML()).trim() === '', 'storage line shown without the API: ' + await m.page.locator('#libStorage').innerHTML());
    assert(await m.page.locator('#libList').count() === 1, 'library did not render without the storage API');
    noErrors(m);
  } finally { await m.close(); }
}},

{name: 'hygiene: a backup from a newer version is refused and changes nothing; a version-1 backup still restores', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    await importFiles(page, [path.join(FIX, 'one-page.pdf'), path.join(FIX, 'two-page.pdf')]);
    await waitSongs(page, 2);
    const before = await snapshot(page);

    const id = 'v4song' + Date.now().toString(36), buf = fs.readFileSync(path.join(FIX, 'three-page.pdf')), t = Date.now();
    const z3 = new JSZip();
    z3.file(`files/${id}.pdf`, buf);
    z3.file('library.json', JSON.stringify({app: 'setlist-stand', version: 4, saved: new Date().toISOString(),
      songs: [{id, title: 'Future Song', song: 'Future Song', artist: '', version: '', archived: false, pages: 3, hash: sha256(buf), added: t, updated: t}], sets: [], ink: {}}));
    const f3 = path.join(TMP, 'hygiene-v4.zip');
    await fsp.writeFile(f3, await z3.generateAsync({type: 'nodebuffer'}));
    await clearToast(page);
    await page.setInputFiles('#restoreFile', f3);
    const msg = await waitToast(page, /\S/);
    assert(msg === 'That backup was made by a newer version of Setlist Stand. Update the app, then try again. Nothing was changed.', 'v4 restore toast: ' + JSON.stringify(msg));
    await sleep(500);
    expectSame(before, await snapshot(page), 'library after refusing a version-4 backup');
    assert(await songCount(page) === 2, 'song count changed after refusing a version-4 backup');

    const a = 'v1h' + Date.now().toString(36), z1 = new JSZip();
    z1.file(`files/${a}.pdf`, fs.readFileSync(path.join(FIX, 'three-page.pdf')));
    z1.file('library.json', JSON.stringify({app: 'setlist-stand', version: 1, saved: new Date().toISOString(),
      songs: [{id: a, title: 'Old Song - Some Artist', pages: 3, added: 1700000000000}], sets: [{id: 'v1set' + a, name: 'Old Gig', songs: [a], created: 1700000002000}], ink: {}}));
    const f1 = path.join(TMP, 'hygiene-v1.zip');
    await fsp.writeFile(f1, await z1.generateAsync({type: 'nodebuffer'}));
    await clearToast(page);
    await page.setInputFiles('#restoreFile', f1);
    const msg1 = await waitToast(page, /\S/, 30000);
    assert(msg1 === 'Restored 1 song and 1 setlist', 'v1 restore toast: ' + JSON.stringify(msg1));
    await waitSongs(page, 3);
    const songs = Object.values(await idbAll(page, 'songs'));
    assert(songs.some(x => x.id === a && new Set([x.song, x.artist]).has('Old Song') && new Set([x.song, x.artist]).has('Some Artist') && x.pages === 3), 'v1 song not restored and upgraded: ' + JSON.stringify(songs.map(x => [x.id, x.song, x.artist, x.title])));
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'hygiene: a full tablet says so in plain words and leaves the library unchanged', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.context.addInitScript(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...a){
        if(window.__fullDisk) throw new DOMException('The disk is full (test)', 'QuotaExceededError');
        return put.apply(this, a);
      };
    });
    await s.goto();
    await importFiles(page, [path.join(FIX, 'one-page.pdf')]);
    await waitSongs(page, 1);
    await waitToast(page, /^Added 1 song$/);
    const dl = await backupNow(page);
    const before = await snapshot(page);

    await page.evaluate(() => { window.__fullDisk = true; });
    await importFiles(page, [path.join(FIX, 'two-page.pdf'), path.join(FIX, 'three-page.pdf')]);
    const msg = await waitToast(page, /tablet is full|went wrong|Added/);
    assert(msg === 'The tablet is full. Free up some space, then try again. Nothing was changed.', 'import on a full tablet: ' + JSON.stringify(msg));
    await sleep(300);
    expectSame(before, await snapshot(page), 'library after an import on a full tablet');
    assert(await songCount(page) === 1, 'song count changed after an import on a full tablet');

    /* restore on a full tablet: same words, nothing changed */
    await clearToast(page);
    await page.setInputFiles('#restoreFile', dl.file);
    const rmsg = await waitToast(page, /\S/, 30000);
    assert(rmsg === 'The tablet is full. Free up some space, then try again. Nothing was changed.', 'restore on a full tablet: ' + JSON.stringify(rmsg));
    expectSame(before, await snapshot(page), 'library after a restore on a full tablet');

    await page.evaluate(() => { window.__fullDisk = false; });
    await importFiles(page, [path.join(FIX, 'two-page.pdf')]);
    await waitSongs(page, 2);
    await waitToast(page, /^Added 1 song$/);
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'hygiene: problem log records errors on the device only, shows them, and clears', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    await clearToast(page);
    await page.evaluate(() => { setTimeout(() => { throw new Error('boom'); }); });
    await waitToast(page, /^Something went wrong\. Your music is safe\. Details: Library → Problem log\.$/);
    const log = await page.evaluate(() => JSON.parse(localStorage.getItem('ss-problems') || '[]'));
    assert(log.length === 1 && log[0].kind === 'error' && /boom/.test(log[0].msg) && log[0].t > 0, 'problem log entry: ' + JSON.stringify(log));
    await page.waitForSelector('#libProblems [data-problems]', {timeout: 3000});
    assert((await page.locator('#libProblems [data-problems]').textContent()).trim() === 'Problem log (1)', 'button: ' + await page.locator('#libProblems').innerText());

    /* harmless browser noise is not logged */
    await page.evaluate(() => dispatchEvent(new ErrorEvent('error', {message: 'ResizeObserver loop completed with undelivered notifications.'})));
    await sleep(200);
    assert((await page.evaluate(() => JSON.parse(localStorage.getItem('ss-problems')).length)) === 1, 'ResizeObserver noise was logged');

    await page.click('#libProblems [data-problems]');
    const text = await page.locator('.modal .plog').inputValue();
    assert(/error: .*boom/.test(text), 'problem log dialog text: ' + JSON.stringify(text));
    await page.click('.modal [data-plcopy]');              // clipboard or select: must not throw
    await sleep(200);
    await page.click('.modal [data-plclear]');
    await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 3000});
    assert(await page.locator('#libProblems [data-problems]').count() === 0, 'Problem log button still shown after Clear');
    assert(await page.evaluate(() => JSON.parse(localStorage.getItem('ss-problems') || '[]').length) === 0, 'log not empty after Clear');

    /* an unhandled promise rejection is logged too, and a reload keeps the log */
    await page.evaluate(() => { Promise.reject(new Error('bang')); });
    await page.waitForFunction(() => /bang/.test(localStorage.getItem('ss-problems') || ''), null, {timeout: 3000});
    await s.goto();
    assert((await page.locator('#libProblems [data-problems]').textContent()).trim() === 'Problem log (1)', 'button after reload: ' + await page.locator('#libProblems').innerText());

    const own = new URL(ctx.base).host;
    const foreign = s.requests.filter(u => !/^(blob|data):/.test(u) && new URL(u).host !== own);
    assert(foreign.length === 0, 'requests to other hosts: ' + foreign.join(', '));
    noErrors(s, /boom|bang/);
  } finally { await s.close(); }
}},

{name: 'hygiene: duplicate PDFs are found by content and asked about once', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const one = path.join(FIX, 'one-page.pdf'), copy = path.join(TMP, 'One-page copy.pdf');
    fs.copyFileSync(one, copy);
    const h1 = sha256(fs.readFileSync(one));

    /* the same PDF twice in one batch: one question, naming the second; Skip */
    await importFiles(page, [one, copy]);
    await page.waitForSelector('.dupask', {timeout: 15000});
    const q = (await page.locator('.dupask').innerText()).replace(/\s+/g, ' ');
    assert(q.includes('This PDF is already in your library:') && q.includes('One-page copy.pdf') && !q.includes('one-page.pdf'), 'duplicate question: ' + q);
    assert(await page.locator('.dupask [data-dupskip]').evaluate(b => b.classList.contains('pri') && document.activeElement === b), '"Skip" is not the primary, focused button');
    await page.click('.dupask [data-dupskip]');
    assert(await waitToast(page, /Skipped/) === 'Added 1 song. Skipped 1 already in your library.', 'summary toast');
    await waitSongs(page, 1);
    const snap1 = await snapshot(page);

    /* again later: Escape skips, nothing changes */
    await importFiles(page, [one]);
    await page.waitForSelector('.dupask', {timeout: 15000});
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.dupask'), null, {timeout: 3000})
      .catch(async () => { throw new Error('Escape did not close the question; focus on ' + await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))); });
    assert(await waitToast(page, /Skipped/) === 'Skipped 1 already in your library', 'Escape summary toast');
    assert(await page.locator('.dupask').count() === 0, 'question still open after Escape');
    await sleep(300);
    expectSame(snap1, await snapshot(page), 'library after skipping a duplicate');

    /* an archived song still counts */
    await page.click('#libList [data-archive]');
    await waitSongs(page, 0);
    await importFiles(page, [one]);
    await page.waitForSelector('.dupask', {timeout: 15000}).catch(() => { throw new Error('no question for a PDF that is archived'); });

    /* Add anyway: a second song with the same bytes */
    await page.click('.dupask [data-dupadd]');
    assert(await waitToast(page, /^Added/) === 'Added 1 song', 'Add anyway toast');
    await waitSongs(page, 1);
    const songs = Object.values(await idbAll(page, 'songs')).filter(x => !x.deleted);
    assert(songs.length === 2 && songs.every(x => x.hash === h1), 'Add anyway: songs ' + JSON.stringify(songs.map(x => [x.title, x.hash.slice(0, 8), x.archived])));
    noErrors(s);
  } finally { await s.close(); }
}},

];

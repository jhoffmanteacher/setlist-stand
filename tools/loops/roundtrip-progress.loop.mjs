/*
 * Restore and Back up show what they are doing and can be stopped (js/backup.js, busy() in js/util.js), and Stop is safe:
 *   - Restore: the box says "Opening the backup…", "Checking song N of M…" (every N, in order), "Saving to this tablet…";
 *     Stop while it is checking changes NOTHING (the library, compared before and after, field by field and byte by byte);
 *     from the write on, Stop is gone and pressing it (or Escape) does not stop the restore, which still completes whole.
 *   - Back up: "Packing song N of M…", then "Making the backup file…"; Stop downloads nothing and does not set the
 *     "last backup" time; a backup that is not stopped downloads, restores, and sets it.
 * The backup used is built here, in Node, from a fixture PDF with padding after its end (distinct bytes, so distinct hashes),
 * big enough that checking and packing take long enough to press Stop in the middle.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {FIX, TMP, assert, sleep, sha256, snapshot, diff, JSZip, openBackupMenu, answerRestore} from './harness.mjs';

const SONGS = 100, KB = 400;
async function bigBackup(){
  const zip = new JSZip(), songs = [], base = fs.readFileSync(path.join(FIX, 'one-page.pdf')), tag = Date.now().toString(36);
  for(let i = 0; i < SONGS; i++){
    const id = `big${i}x${tag}`, bytes = Buffer.concat([base, Buffer.from('\n%' + 'x'.repeat(KB * 1024) + ` ${i}\n`)]);
    zip.file(`files/${id}.pdf`, bytes);
    songs.push({id, title: `Big ${i}`, song: `Big ${i}`, artist: '', version: '', archived: false, pages: 1, hash: sha256(bytes), added: 1700000000000 + i, updated: 1700000000000 + i});
  }
  zip.file('library.json', JSON.stringify({app: 'setlist-stand', version: 2, saved: new Date().toISOString(), songs, sets: [], ink: {}}));
  const f = path.join(TMP, 'progress-big-backup.zip');
  await fsp.writeFile(f, await zip.generateAsync({type: 'nodebuffer', compression: 'STORE'}));
  return f;
}
/* In the page: write down every distinct line the waiting box shows, with whether its Stop button was hidden at that moment.
   pressOn (a RegExp): press Stop the moment a line matching it appears (a microtask after it was set). */
const startWatch = async (page, pressOn) => {
  await page.evaluate(src => {
    const pressOn = src ? new RegExp(src) : null;
    window.__lines = [];
    window.__obs = new MutationObserver(() => {
      const p = document.querySelector('.modal p[role=status]'); if(!p) return;
      const t = p.textContent, last = window.__lines[window.__lines.length - 1];
      if(!last || last.t !== t){
        const stop = document.querySelector('.modal [data-x]');
        /* is the update banner out of reach while the box is open? (shown by force for a moment, to read how it would be drawn) */
        const u = document.querySelector('#update'); let banner = 'none';
        if(u){ const was = u.hidden; u.hidden = false; banner = getComputedStyle(u).display; u.hidden = was; }
        window.__lines.push({t, stopHidden: !!(stop && stop.hidden), busy: document.body.classList.contains('busy'), banner});
        if(pressOn && pressOn.test(t) && stop) stop.click();
      }
    });
    window.__obs.observe(document.body, {childList: true, subtree: true, characterData: true});
  }, pressOn ? pressOn.source : null);
};
const lines = page => page.evaluate(() => window.__lines);
/* Every line was shown with the page marked busy and the "Updated. Tap to reload" banner out of reach (a tap on it would
   reload the app and throw away a restore or backup under way); afterwards neither holds. */
async function bannerGuard(page, L, what){
  assert(L.length && L.every(x => x.busy && x.banner === 'none'), `${what}: while the box was open the page was not marked busy or the update banner could be tapped: ` + JSON.stringify(L.filter(x => !x.busy || x.banner !== 'none').slice(0, 2)));
  await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 10000});
  assert(await page.evaluate(() => !document.body.classList.contains('busy')), `${what}: the page is still marked busy after the box closed`);
}
const toastText = page => page.locator('#toast').textContent();
async function toastIs(page, re, what){
  await page.waitForFunction(src => new RegExp(src).test(document.querySelector('#toast').textContent), re.source, {timeout: 60000}).catch(() => { throw new Error(what); });
}
const same = (a, b, what) => { const d = diff(a, b, '', [], 20); assert(!d.length, `${what}: ${d.length} difference(s):\n    ` + d.join('\n    ')); };

async function loopRestoreProgress(ctx){
  const f = await bigBackup();
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await page.setInputFiles('#file', path.join(FIX, 'two-page.pdf'));          // something already in the library
    await page.waitForSelector('#libList [data-open]', {timeout: 20000});
    const A = await snapshot(page);

    /* Stop pressed the moment "Checking song 5 of N" shows: nothing changes */
    await startWatch(page, /^Checking song 5 of/);
    await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
    await page.setInputFiles('#restoreFile', f);
    await toastIs(page, /Restore stopped|Restored|not a Setlist|damaged/, 'restore gave no answer');
    assert(/^Restore stopped\. Nothing was changed\.$/.test(await toastText(page)), 'after Stop the message is "' + await toastText(page) + '"');
    await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000});
    const L = await lines(page);
    await bannerGuard(page, L, "a stopped restore");
    assert(L[0] && L[0].t === 'Opening the backup…', 'the first line is "' + (L[0] && L[0].t) + '", not "Opening the backup…"');
    assert(L.some(x => x.t === 'Checking song 5 of ' + SONGS + '…'), 'no "Checking song 5 of ' + SONGS + '…" line: ' + L.map(x => x.t).join(' | '));
    assert(!L.some(x => /^Saving/.test(x.t)), 'Stop was pressed while checking, yet it went on to save: ' + L.map(x => x.t).slice(-3).join(' | '));
    const lastChecked = Math.max(...L.map(x => +(/^Checking song (\d+) of/.exec(x.t) || [])[1] || 0));
    assert(lastChecked <= 6, `Stop was pressed at song 5, yet checking went on to song ${lastChecked} (it should stop at once)`);
    same(A, await snapshot(page), 'Stop during restore checking: the library before (left) and after (right)');
    await page.evaluate(() => window.__obs.disconnect());

    /* not stopped: every step in order, Stop gone during the write and pressing it then changes nothing */
    await startWatch(page, /^Saving to this tablet/);
    await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
    await page.setInputFiles('#restoreFile', f);
    /* the library is not empty: the question comes after the checking, and Stop (pressed on "Saving") comes after its Restore */
    const asked = await answerRestore(page, 'ok', 120000);
    assert(asked && /It adds 100 songs\./.test(asked) && /1 song on this tablet is not in the backup\. It stays as it is\./.test(asked), 'the question: ' + JSON.stringify(asked));
    await toastIs(page, /Restored|stopped|not a Setlist|damaged/, 'the restore gave no answer');
    const msg = await toastText(page);
    assert(msg === `Restored ${SONGS} songs and 0 setlists`, 'a Stop pressed during the write changed the outcome: "' + msg + '"');
    const L2 = (await lines(page)).map(x => x.t);
    const checking = L2.filter(t => /^Checking song/.test(t));
    assert(L2[0] === 'Opening the backup…', 'first line: ' + L2[0]);
    assert(checking[0] === 'Checking song 1 of ' + SONGS + '…' && checking.at(-1) === 'Checking song ' + SONGS + ' of ' + SONGS + '…', 'checking lines: ' + checking[0] + ' … ' + checking.at(-1));
    assert(L2.at(-1) === 'Saving to this tablet…' && L2.indexOf('Saving to this tablet…') > L2.indexOf(checking.at(-1)), 'the last line is not "Saving to this tablet…" after the checking lines: ' + L2.slice(-3).join(' | '));
    const save = (await lines(page)).at(-1);
    await bannerGuard(page, await lines(page), 'a completed restore');
    assert(save.stopHidden, 'the Stop button was still shown while the library was being saved');
    await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 10000});
    const songs = Object.values((await snapshot(page)).songs).filter(x => !x.deleted);
    assert(songs.length === SONGS + 1, `after the restore the library has ${songs.length} songs, expected ${SONGS + 1}`);
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

async function loopBackupProgress(ctx){
  const f = await bigBackup();
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await page.setInputFiles('#restoreFile', f);
    await toastIs(page, /Restored \d+ song/, 'the big backup did not restore');
    await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 10000});
    const A = await snapshot(page);
    assert(/^\d+$/.test(await page.evaluate(() => localStorage.getItem('ss-last-backup')) || ''), 'a restore does not count as a backup (the restored library would be reported as changed)');
    await page.evaluate(() => localStorage.removeItem('ss-last-backup'));        // from here: no backup was ever made, to prove a stopped backup sets nothing
    await page.click('#tLib'); await page.waitForSelector('#view [data-backupmenu]');
    let downloads = 0; page.on('download', () => { downloads++; });

    /* Stop pressed when "Packing song 5 of N" shows: nothing is downloaded, the time is not set */
    await startWatch(page, /^Packing song 5 of/);
    await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
    await openBackupMenu(page, 'backup');
    await toastIs(page, /Backup stopped|Backup saved|failed/, 'the backup gave no answer');
    assert(await toastText(page) === 'Backup stopped. Nothing was saved.', 'after Stop the message is "' + await toastText(page) + '"');
    await sleep(1500);
    assert(downloads === 0, 'Stop pressed while packing, yet ' + downloads + ' file(s) were downloaded');
    assert(await page.evaluate(() => localStorage.getItem('ss-last-backup')) === null, 'a stopped backup set the "last backup" time');
    const L = (await lines(page)).map(x => x.t);
    assert(L.includes('Packing song 5 of ' + (SONGS) + '…'), 'no "Packing song 5 of ' + SONGS + '…" line: ' + L.join(' | '));
    assert(await page.evaluate(() => !document.querySelector('.modal')), 'the box is still open after Stop');
    same(A, await snapshot(page), 'a stopped backup changed the library');
    await page.evaluate(() => window.__obs.disconnect());

    /* not stopped: the lines in order, then it downloads, and the time is set */
    await startWatch(page, null);
    await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
    const [dl] = await Promise.all([page.waitForEvent('download', {timeout: 120000}), openBackupMenu(page, 'backup')]);
    assert(/^ChartShark-backup-\d{4}-\d\d-\d\d-\d{4}\.zip$/.test(dl.suggestedFilename()), 'file name ' + dl.suggestedFilename());
    await toastIs(page, /Backup saved|failed|stopped/, 'no answer after the backup');
    assert(await toastText(page) === 'Backup saved', 'message "' + await toastText(page) + '"');
    await bannerGuard(page, await lines(page), 'a completed backup');
    const L2 = (await lines(page)).map(x => x.t), packing = L2.filter(t => /^Packing song/.test(t));
    assert(packing[0] === 'Packing song 1 of ' + SONGS + '…' && packing.at(-1) === 'Packing song ' + SONGS + ' of ' + SONGS + '…', 'packing lines: ' + packing[0] + ' … ' + packing.at(-1));
    assert(L2.some(t => /^Making the backup file…/.test(t)) && L2.indexOf(packing.at(-1)) < L2.findIndex(t => /^Making the backup file…/.test(t)), 'no "Making the backup file…" line after the packing lines: ' + L2.slice(-4).join(' | '));
    assert(await page.evaluate(() => /^\d+$/.test(localStorage.getItem('ss-last-backup') || '')), 'a saved backup did not set the "last backup" time');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'roundtrip progress: Restore shows its steps, Stop while checking changes nothing, Stop during the write is refused', run: loopRestoreProgress},
  {name: 'roundtrip progress: Back up shows its steps, Stop downloads nothing and leaves the last-backup time alone', run: loopBackupProgress},
];

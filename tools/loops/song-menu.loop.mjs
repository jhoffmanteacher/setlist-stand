/*
 * The song row's one ⋯ button (Jonathan, 2026-11-23). Each Library row is the title and ONE button that opens a menu with every
 * action the row used to show as its own button. Read from the SCREEN, in a library made from a backup built here:
 *  - a row holds exactly one button besides the title button, named "Actions for <title>" (the title is escaped: a title with quotes and
 *    tags cannot add an attribute or an element); the button is the same size on a short and a very long title and is centred on the row
 *  - a long title is never cut: the whole text is in the page, wraps inside the row and does not run under the ⋯ button
 *  - the menu lists Edit, Copy, New version, Archive, Delete for a live song and Restore, Delete for an archived one; Cancel and
 *    Escape close it and give the focus back to the ⋯ button, and change nothing
 *  - Delete is two steps: the menu item changes nothing, the confirm's Cancel (and Escape) change nothing, its Delete deletes (the song
 *    becomes a deletion marker, its PDF goes), and the focus is not left on the page body
 *  - Archive then Restore through the menu move the song between the lists; Edit through the menu opens the same form as before
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {FIX, TMP, assert, sha256, idbAll, snapshot, diff, restoreZip, JSZip} from './harness.mjs';
import {openSongMenu, songAct, answerDelete} from './songrow.mjs';

const LONG = 'A very long song title ' + 'that keeps going and going '.repeat(3) + 'Supercalifragilisticexpialidocious_and_one_more_very_long_unbroken_word "quoted" <b>bold</b>';
const SONGS = [
  {song: LONG, artist: 'Long Artist', version: '', archived: false},
  {song: 'Short', artist: 'Band', version: '', archived: false},
  {song: 'Put Away', artist: 'Band', version: 'old', archived: true},
];
const titleOf = s => s.song + (s.version ? ` (${s.version})` : '') + (s.artist ? ` - ${s.artist}` : '');

async function backupFile(){
  const zip = new JSZip(), base = fs.readFileSync(path.join(FIX, 'one-page.pdf')), tag = Date.now().toString(36), songs = [];
  SONGS.forEach((x, i) => {
    const id = `smn${i}x${tag}`, bytes = Buffer.concat([base, Buffer.from(`\n% song menu ${i}\n`)]);
    zip.file(`files/${id}.pdf`, bytes);
    songs.push({id, title: titleOf(x), song: x.song, artist: x.artist, version: x.version, archived: x.archived, pages: 1, hash: sha256(bytes), added: 1700000000000 + i, updated: 1700000000000 + i});
  });
  zip.file('library.json', JSON.stringify({app: 'setlist-stand', version: 2, saved: new Date().toISOString(), songs, sets: [], ink: {}}));
  const f = path.join(TMP, 'song-menu-backup.zip');
  await fsp.writeFile(f, await zip.generateAsync({type: 'nodebuffer'}));
  return f;
}
const labelsOf = page => page.$$eval('.modal.menubox [data-item]', bs => bs.map(b => b.dataset.item));
const closeMenu = async (page, how) => {
  if(how === 'cancel') await page.click('.modal.menubox [data-x]'); else await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000});
};
const focusOn = page => page.evaluate(() => { const a = document.activeElement; return a ? (a.dataset.songmenu ? 'songmenu:' + a.dataset.songmenu : a.tagName + (a.id ? '#' + a.id : '')) : null; });

async function loopSongMenu(ctx){
  const f = await backupFile();
  const s = await ctx.session();
  try{
    const {page} = s;
    await page.setViewportSize({width: 820, height: 1180});
    await s.goto();
    await restoreZip(page, f);
    await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 2, null, {timeout: 10000});
    const recs = await idbAll(page, 'songs'), idOf = x => Object.values(recs).find(r => r.title === titleOf(x)).id;
    const longId = idOf(SONGS[0]), shortId = idOf(SONGS[1]), oldId = idOf(SONGS[2]);

    /* the row: one button beside the title button; named; the title whole and inside the row; the button the same everywhere */
    const rows = await page.$$eval('#libList li.row', lis => lis.map(li => {
      const main = li.querySelector('.main'), more = li.querySelector('[data-songmenu]'), r = li.getBoundingClientRect(), mr = main.getBoundingClientRect(), br = more.getBoundingClientRect();
      return {buttons: li.querySelectorAll('button').length, acts: !!li.querySelector('.acts'), label: more.getAttribute('aria-label'), id: more.dataset.songmenu, text: li.querySelector('.t').textContent,
        mainW: mr.width, mainRight: mr.right, moreLeft: br.left, moreW: br.width, moreH: br.height, centred: Math.abs((br.top + br.height / 2) - (r.top + r.height / 2)),
        rowH: r.height, extra: [...li.querySelectorAll('[data-x], [style], [onclick]')].length, tall: li.querySelector('.t').getBoundingClientRect().height};
    }));
    assert(rows.length === 2, 'rows: ' + rows.length);
    for(const r of rows){
      assert(r.buttons === 2 && !r.acts, `a row has ${r.buttons} buttons / .acts ${r.acts}`);
      assert(r.label === 'Actions for ' + r.text, `the ⋯ button is named ${JSON.stringify(r.label)}`);
      assert(r.extra === 0, 'a title made an attribute or an element: ' + JSON.stringify(r.text));
      assert(r.mainRight <= r.moreLeft + 0.5, `the title runs under the ⋯ button (${r.mainRight} > ${r.moreLeft})`);
      assert(r.moreW >= 44 && r.moreH >= 44, `the ⋯ button is too small: ${r.moreW} x ${r.moreH}`);
      assert(r.centred <= 1.5, `the ⋯ button is ${r.centred}px off the middle of its row`);
    }
    const long = rows.find(r => r.id === longId), short = rows.find(r => r.id === shortId);
    assert(long.text === titleOf(SONGS[0]), 'the long title is not whole on the screen: ' + long.text);
    assert(long.moreW === short.moreW && long.moreH === short.moreH, `the ⋯ button changes size with the title: ${long.moreW}x${long.moreH} / ${short.moreW}x${short.moreH}`);
    assert(long.tall > short.tall * 1.5, 'the long title did not wrap onto more lines');
    console.log(`    song menu: at 820 px the title has ${Math.round(long.mainW)} px; ⋯ button ${long.moreW}x${long.moreH}; long title ${long.text.length} characters`);

    const before = await snapshot(page);
    /* the menu: items, title, Cancel / Escape, focus back, nothing changed */
    await openSongMenu(page, shortId);
    assert((await labelsOf(page)).join() === 'edit,copy,newversion,archive,del', 'live menu: ' + (await labelsOf(page)).join());
    assert((await page.textContent('.modal.menubox h2')) === 'Short - Band', 'menu title: ' + await page.textContent('.modal.menubox h2'));
    await closeMenu(page, 'cancel');
    assert((await focusOn(page)) === 'songmenu:' + shortId, 'after Cancel the focus is on ' + await focusOn(page));
    await openSongMenu(page, longId);
    assert(/…$/.test(await page.textContent('.modal.menubox h2')), 'a long title is cut with … in the menu heading');
    await closeMenu(page, 'escape');
    assert((await focusOn(page)) === 'songmenu:' + longId, 'after Escape the focus is on ' + await focusOn(page));
    await page.check('#showArch'); await page.waitForSelector('#libList h2');
    await openSongMenu(page, oldId);
    assert((await labelsOf(page)).join() === 'restore,del', 'archived menu: ' + (await labelsOf(page)).join());
    await closeMenu(page, 'cancel');
    await page.uncheck('#showArch');
    assert(diff(before, await snapshot(page)).length === 0, 'opening and closing menus changed the library');

    /* Delete: the item, then the question. Nothing is written until its Delete. */
    await songAct(page, 'del', shortId);
    assert((await page.textContent('.modal.delask h2')).startsWith('Delete Short'), 'delete question: ' + await page.textContent('.modal.delask h2'));
    assert(diff(before, await snapshot(page)).length === 0, 'the Delete menu item alone changed the library');
    await answerDelete(page, false);
    assert(diff(before, await snapshot(page)).length === 0, 'Cancel on the delete question changed the library');
    /* a quick second tap on the menu's Delete must not land on the question's Delete: checked in the same turn as the first tap, so no timing is involved */
    await openSongMenu(page, shortId);
    const armedAtOnce = await page.evaluate(() => { document.querySelector('.modal.menubox [data-item=del]').click(); const ok = document.querySelector('.modal.delask [data-ok]'); return !!ok && ok.disabled; });
    assert(armedAtOnce, 'the delete question\'s Delete button works the moment it appears: a double tap on the menu\'s Delete would delete');
    await page.waitForFunction(() => { const ok = document.querySelector('.modal.delask [data-ok]'); return ok && !ok.disabled; }, null, {timeout: 3000});
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000});
    assert(diff(before, await snapshot(page)).length === 0, 'Escape on the delete question changed the library');
    await songAct(page, 'del', shortId);
    await answerDelete(page, true);
    await page.waitForFunction(id => !document.querySelector(`[data-songmenu="${id}"]`), shortId, {timeout: 5000});
    const after = await idbAll(page, 'songs'), files = await idbAll(page, 'files');
    assert(after[shortId] && after[shortId].deleted === true, 'no deletion marker for the deleted song: ' + JSON.stringify(after[shortId]));
    assert(!files[shortId], 'the deleted song kept its PDF');
    assert(long.id === longId && after[longId] && !after[longId].deleted, 'another song was touched by the delete');
    assert((await focusOn(page)) !== 'BODY', 'after the delete the focus is on the page body');

    /* Archive and Restore, Edit */
    await songAct(page, 'archive', longId);
    await page.waitForFunction(() => !document.querySelector('#libList li.row'), null, {timeout: 5000});
    assert((await idbAll(page, 'songs'))[longId].archived === true, 'Archive did not archive');
    await page.check('#showArch'); await page.waitForSelector('#libList h2');
    await songAct(page, 'restore', longId);
    await page.waitForFunction(id => { const li = document.querySelector(`[data-songmenu="${id}"]`)?.closest('li'); return li && !/Archived/.test(li.querySelector('.s').textContent); }, longId, {timeout: 5000});
    assert((await idbAll(page, 'songs'))[longId].archived === false, 'Restore did not restore');
    await songAct(page, 'edit', longId);
    await page.waitForSelector('.modal input[data-k=song]');
    assert((await page.inputValue('.modal input[data-k=song]')) === SONGS[0].song, 'Edit opened with the wrong title');
    await page.click('.modal [data-x]');
    await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000});
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'song menu: one ⋯ button per row, a long title whole beside it, the menu, Delete as menu item then confirm, focus', run: loopSongMenu},
];

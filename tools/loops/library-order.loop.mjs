/*
 * Library order: A to Z by song name (compareSongs in js/names.js), in the library, the Archived list, search results and
 * the song pickers (Add songs on a setlist, Share songs). Songs with awkward names (mixed case, a number first, an accent,
 * the same name with different artists, a leading "The" / "A" / "An") are put into a library through a backup built
 * here in Node, and the order is read from the SCREEN. The expected orders are written out by hand, not computed with the
 * code under test. Also: the order is made when a list is drawn (a library whose in-memory order is turned around is
 * still drawn A to Z), a renamed song moves to its place at once, a setlist keeps its own drag-and-drop order (and a
 * keyboard move changes only that), and nothing stored changes because of any of it.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {FIX, TMP, assert, sleep, sha256, idbAll, snapshot, diff, restoreZip, JSZip} from './harness.mjs';

/* [song, artist, version, archived]; the title shown is "Song (version) - Artist". The ids follow this order, which is made the OPPOSITE of
   the expected order for the same-name songs (Beta before Alpha, version b before a), so a missing tie-break cannot pass by luck. */
const SONGS = [
  ['zebra crossing', 'Z Band', '', false], ['apple pie', 'Beta Band', '', false], ['Apple Pie', 'Alpha Band', '', false],
  ['10 Years Gone', 'Led', '', false], ['2 Fast', 'Dev', '', false], ['Eclair', 'Pastry', 'b', false], ['Éclair', 'Pastry', 'a', false],
  ['The Weight', 'The Band', '', false], ["A Hard Day's Night", 'Beatles', '', false], ['Zebra', 'Y', '', false], ['An Angel', 'X', '', false],
  ['Banana', 'Q', '', true], ['apple cake', 'R', '', true],
];
const titleOf = ([song, artist, version]) => song + (version ? ` (${version})` : '') + (artist ? ` - ${artist}` : '');
const T = Object.fromEntries(SONGS.map(s => [s[0] + '|' + s[1], titleOf(s)]));
const t = (song, artist) => T[song + '|' + artist];
/* by hand: numbers as numbers, then A to Z, nothing dropped ("A Hard Day's Night", "An Angel", "The Weight" under T), same name by artist then version */
const LIVE = [t('2 Fast', 'Dev'), t('10 Years Gone', 'Led'), t("A Hard Day's Night", 'Beatles'), t('An Angel', 'X'), t('Apple Pie', 'Alpha Band'), t('apple pie', 'Beta Band'),
  t('Éclair', 'Pastry'), t('Eclair', 'Pastry'), t('The Weight', 'The Band'), t('Zebra', 'Y'), t('zebra crossing', 'Z Band')];
const ARCHIVED = [t('apple cake', 'R'), t('Banana', 'Q')];
const BAND = [t('Apple Pie', 'Alpha Band'), t('apple pie', 'Beta Band'), t('The Weight', 'The Band'), t('zebra crossing', 'Z Band')];     // search "band"
const SHARE_ALL = [t('2 Fast', 'Dev'), t('10 Years Gone', 'Led'), t("A Hard Day's Night", 'Beatles'), t('An Angel', 'X'), t('apple cake', 'R') + ' (archived)', t('Apple Pie', 'Alpha Band'),
  t('apple pie', 'Beta Band'), t('Banana', 'Q') + ' (archived)', t('Éclair', 'Pastry'), t('Eclair', 'Pastry'), t('The Weight', 'The Band'), t('Zebra', 'Y'), t('zebra crossing', 'Z Band')];
/* a setlist in an order of its own: NOT alphabetical */
const SET_ORDER = [t('zebra crossing', 'Z Band'), t('2 Fast', 'Dev'), t('The Weight', 'The Band'), t('apple pie', 'Beta Band')];

async function backupFile(){
  const zip = new JSZip(), base = fs.readFileSync(path.join(FIX, 'one-page.pdf')), tag = Date.now().toString(36), songs = [], ids = {};
  SONGS.forEach(([song, artist, version, archived], i) => {
    const id = `ord${i}x${tag}`, bytes = Buffer.concat([base, Buffer.from(`\n% order ${i}\n`)]);
    zip.file(`files/${id}.pdf`, bytes); ids[song + '|' + artist] = id;
    songs.push({id, title: titleOf([song, artist, version]), song, artist, version, archived, pages: 1, hash: sha256(bytes), added: 1700000000000 + i, updated: 1700000000000 + i});
  });
  const items = SET_ORDER.map(title => ({type: 'song', id: songs.find(s => s.title === title).id}));
  const sets = [{id: 'ordset' + tag, name: 'Gig order', items, created: 1700000000000, updated: 1700000000000}];
  zip.file('library.json', JSON.stringify({app: 'setlist-stand', version: 2, saved: new Date().toISOString(), songs, sets, ink: {}}));
  const f = path.join(TMP, 'library-order-backup.zip');
  await fsp.writeFile(f, await zip.generateAsync({type: 'nodebuffer'}));
  return f;
}
const same = (got, want, what) => assert(JSON.stringify(got) === JSON.stringify(want), `${what}:\n    on screen: ${JSON.stringify(got)}\n    expected:  ${JSON.stringify(want)}`);
const lists = page => page.$$eval('#libList ul.list', uls => uls.map(ul => [...ul.querySelectorAll('.t')].map(e => e.textContent.trim())));
const pickerLabels = page => page.$$eval('.modal .pick label', ls => ls.map(l => l.textContent.trim()));

async function loopOrder(ctx){
  const f = await backupFile();
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await restoreZip(page, f);
    await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 11, null, {timeout: 10000});
    const before = await snapshot(page);

    /* the library, and the Archived list under it */
    same((await lists(page))[0], LIVE, 'library order');
    await page.check('#showArch');
    await page.waitForSelector('#libList h2');
    const both = await lists(page);
    same(both[0], LIVE, 'library order with Archived shown'); same(both[1], ARCHIVED, 'Archived list order');

    /* search results keep the order; Archived matches too */
    await page.uncheck('#showArch');
    await page.fill('#q', 'band');
    same((await lists(page))[0], BAND, 'search results for "band"');
    await page.fill('#q', 'a');
    await page.check('#showArch');
    const sa = await lists(page);
    same(sa[1], ARCHIVED, 'Archived search results for "a"');
    same(sa[0], LIVE.filter(x => x.toLowerCase().includes('a')), 'search results for "a"');
    await page.fill('#q', ''); await page.uncheck('#showArch');

    /* drawn, not stored: turn the library's own order around in memory and draw again: still A to Z */
    await page.evaluate(async () => { const {state} = await import('./js/store.js'); state.songs.reverse(); });
    await page.fill('#q', 'x'); await page.fill('#q', '');
    same((await lists(page))[0], LIVE, 'library order after its in-memory order was turned around (the list must be sorted when it is drawn)');

    /* the pickers */
    await page.click('[data-sharesongs]');
    await page.locator('.modal .pick').waitFor();
    same(await pickerLabels(page), SHARE_ALL, 'Share songs picker order');
    await page.click('.modal [data-x]');
    await page.waitForFunction(() => !document.querySelector('.modal'));
    await page.click('#tSets');
    await page.locator('#view [data-set]').first().click();
    await page.waitForSelector('#view [data-addto]');
    await page.click('#view [data-addto]');
    await page.locator('.modal .pick').waitFor();
    same(await pickerLabels(page), LIVE, 'Add songs (setlist) picker order');
    await page.click('.modal [data-x]');
    await page.waitForFunction(() => !document.querySelector('.modal'));

    /* a setlist keeps its own order, and a keyboard move changes only that */
    const rows = () => page.$$eval('#items > li.row .t', ts => ts.map(e => e.textContent.replace(/\s*\(archived\)\s*$/, '').trim()));
    same(await rows(), SET_ORDER, 'the setlist\'s own order (it must not be alphabetized)');
    await page.locator('#items > li.row').nth(1).locator('.handle').focus();
    await page.keyboard.press('ArrowUp');
    const moved = [SET_ORDER[1], SET_ORDER[0], SET_ORDER[2], SET_ORDER[3]];
    await page.waitForFunction(first => document.querySelector('#items > li.row .t')?.textContent.includes(first), SET_ORDER[1].split(' - ')[0], {timeout: 5000});
    same(await rows(), moved, 'the setlist after moving row 2 up with the keyboard');
    await sleep(500);

    /* nothing stored changed because of sorting (only the setlist, which was reordered on purpose) */
    const after = await snapshot(page);
    const d = diff(before.songs, after.songs, '', [], 20);
    assert(!d.length, 'sorting changed stored songs: ' + d.join('; '));
    assert(Object.values(after.sets)[0].items.map(i => (after.songs[i.id] || {}).title).join('|') === moved.join('|'), 'the stored setlist is not in the moved order');

    /* a reload keeps the setlist's order, and the library is still A to Z */
    await s.goto();
    same((await lists(page))[0], LIVE, 'library order after a reload');
    await page.click('#tSets'); await page.locator('#view [data-set]').first().click(); await page.waitForSelector('#items');
    same(await rows(), moved, 'the setlist\'s order after a reload');

    /* a rename moves a song to its place at once: "Zebra" becomes "Aardvark" (after "A Hard Day's Night", before "An Angel") */
    await page.click('#tLib'); await page.waitForSelector('#libList');
    const id = Object.values(after.songs).find(x => x.song === 'Zebra').id;
    await page.click(`#libList [data-edit="${id}"]`);
    await page.locator('.modal input[data-k=song]').fill('Aardvark');
    await page.click('.modal [data-ok]');
    await page.waitForFunction(() => !document.querySelector('.modal') && [...document.querySelectorAll('#libList .t')].some(e => e.textContent.startsWith('Aardvark')), null, {timeout: 5000});
    const renamed =[...LIVE.slice(0, 3), 'Aardvark - Y', ...LIVE.slice(3).filter(x => x !== t('Zebra', 'Y'))];
    same((await lists(page))[0], renamed, 'library order after renaming "Zebra" to "Aardvark"');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'library order: A to Z by song name in the library, Archived, search and both pickers; a setlist keeps its own order; nothing stored changes', run: loopOrder},
];

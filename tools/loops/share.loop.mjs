/*
 * Share loops: songs or a setlist as one file for another person (Share songs, Share).
 *
 * The loop takes what the share PRODUCED (the downloaded zip) and reads it back through an independent path: the zip is
 * opened in Node with JSZip, every PDF in it is hashed and compared with the PDF the app has stored AND with the fixture
 * file it came from, and the package's details, crops, setlist order and breaks are compared with what the library holds.
 * A library with pen strokes and a private text note is shared, and none of it may appear anywhere in the package.
 * Sharing must also leave the library exactly as it was. Nothing is mocked.
 */
import fs from 'node:fs';
import path from 'node:path';
import {FIX, assert, sha256, fileHashes, snapshot, normalise, diff, download, openShareMenu} from './harness.mjs';
import {CROPS, songsOf, importFixtures, buildLibrary, closeDone, readPackage} from './share-lib.mjs';

/* what one package song must equal: the library's record, and the fixture file its PDF came from */
function checkSong(ps, lib, stored, pdfs, what, wantCrop){
  assert(lib, `${what}: no library song for package song ${ps.id}`);
  for(const k of ['song', 'artist', 'version', 'pages']) assert(ps[k] === lib[k], `${what}: ${ps.id}.${k} is ${JSON.stringify(ps[k])}, the library has ${JSON.stringify(lib[k])}`);
  assert(!('title' in ps) && !('archived' in ps) && !('updated' in ps) && !('added' in ps), `${what}: ${ps.id} carries ${Object.keys(ps).join(',')}`);
  const bytes = pdfs[ps.id];
  assert(bytes, `${what}: no PDF for ${ps.id}`);
  assert(sha256(bytes) === ps.hash && ps.hash === stored[lib.id], `${what}: ${ps.id} hash ${ps.hash} / entry ${sha256(bytes)} / stored ${stored[lib.id]}`);
  assert(JSON.stringify(ps.crop) === JSON.stringify(wantCrop), `${what}: ${ps.id} crop ${JSON.stringify(ps.crop)}, expected ${JSON.stringify(wantCrop)}`);
}
function checkClean(pk, what){
  assert(JSON.stringify(Object.keys(pk.share).sort()) === JSON.stringify(['app', 'kind', 'saved', 'setlist', 'songs', 'version']), `${what}: share.json keys ${Object.keys(pk.share)}`);
  assert(pk.share.app === 'setlist-stand' && pk.share.kind === 'share' && pk.share.version === 1, `${what}: ${pk.share.app} ${pk.share.kind} ${pk.share.version}`);
  for(const n of pk.names) assert(n === 'share.json' || /^files\/s\d+\.pdf$/.test(n), `${what}: unexpected entry ${n}`);
  assert(!/"ink"|"strokes"|"t":"(pen|hl|text)"|Private note/.test(pk.text), `${what}: annotation data in share.json`);
  for(const [id, bytes] of Object.entries(pk.pdfs)) assert(!bytes.includes(Buffer.from('Private note')), `${what}: the note's text is in ${id}'s PDF`);
}

async function loopExport(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await importFixtures(page);
    await buildLibrary(page);
    await page.reload(); await page.waitForSelector('#libList [data-open]');
    const lib = Object.fromEntries((await songsOf(page)).map(x => [x.id, x])), stored = await fileHashes(page);
    const fixtureHash = f => sha256(fs.readFileSync(path.join(FIX, f)));
    const before = normalise(await snapshot(page));

    /* ---- a setlist, from the setlist screen ---- */
    await page.click('#tSets');
    await page.click('#view [data-set]');
    await page.waitForSelector('#view [data-shareset]');
    const pk = await readPackage((await download(page, () => page.click('#view [data-shareset]'))).file);
    const done = await closeDone(page);
    assert(/3 songs are in/.test(done) && /Gig Friday - Setlist Stand share\.zip/.test(done), 'done dialog: ' + done);
    checkClean(pk, 'setlist package');
    assert(pk.share.songs.length === 3, `the setlist uses 3 songs (one twice, one archived): the package has ${pk.share.songs.length}`);
    assert(pk.share.songs.map(x => x.id).join() === 's1,s2,s3', 'package ids ' + pk.share.songs.map(x => x.id));
    const libOf = ps => Object.values(lib).find(x => stored[x.id] === ps.hash);
    for(const ps of pk.share.songs) checkSong(ps, libOf(ps), stored, pk.pdfs, 'setlist package', CROPS[libOf(ps).song]);
    assert(sha256(pk.pdfs.s1) === fixtureHash('one-page.pdf') && sha256(pk.pdfs.s2) === fixtureHash('two-page.pdf') && sha256(pk.pdfs.s3) === fixtureHash('three-page.pdf'), 'a packaged PDF is not the file that was added (bytes changed)');
    const sl = pk.share.setlist;
    assert(sl && sl.name === 'Gig: Friday', 'setlist name ' + (sl && sl.name));
    assert(JSON.stringify(sl.items) === JSON.stringify([{type: 'song', id: 's1'}, {type: 'break', name: 'Set 2'}, {type: 'song', id: 's2'}, {type: 'song', id: 's1'}, {type: 'song', id: 's3'}]), 'setlist items ' + JSON.stringify(sl.items));
    const afterSet = normalise(await snapshot(page));
    assert(!diff(before, afterSet).length, 'sharing a setlist changed the library: ' + diff(before, afterSet).join(' | '));

    /* ---- chosen songs, from the Library ---- */
    await page.click('#tLib');
    await page.click('#libList').catch(() => {});
    await openShareMenu(page, 'share');
    const dlg = page.locator('.modal [role=dialog]');
    await dlg.waitFor();
    assert(/^Share songs/.test((await dlg.textContent()).trim()) && await page.locator('.modal [data-ok]').textContent() === 'Share', 'the checklist is titled and labelled for sharing: ' + await dlg.textContent());
    assert(await page.locator('.modal .pick label', {hasText: '(archived)'}).count() === 1, 'the archived song is not tagged in the checklist');
    assert(await page.locator('.modal [data-ok]').isDisabled(), 'Share is enabled with nothing ticked');
    await page.locator('.modal .pick label', {hasText: 'Fixture Alpha'}).locator('input').check();
    assert(!(await page.locator('.modal [data-ok]').isDisabled()), 'Share stays disabled after a song is ticked');
    await page.locator('.modal .pick label', {hasText: 'Two-page'}).locator('input').check();
    const pk2 = await readPackage((await download(page, () => page.click('.modal [data-ok]'))).file);
    assert(/2 songs are in/.test(await closeDone(page)), 'done dialog for two songs');
    checkClean(pk2, 'songs package');
    assert(pk2.share.setlist === null, 'a package of chosen songs holds a setlist');
    assert(pk2.share.songs.length === 2, 'songs package has ' + pk2.share.songs.length);
    for(const ps of pk2.share.songs) checkSong(ps, libOf(ps), stored, pk2.pdfs, 'songs package', CROPS[libOf(ps).song]);
    const ticked = [Object.values(lib).find(x => x.song === 'Fixture Alpha'), Object.values(lib).find(x => /^two-page/i.test(x.title))].map(x => stored[x.id]).sort().join();
    assert(pk2.share.songs.map(x => x.hash).sort().join() === ticked, 'the package holds other songs than the two that were ticked'); 
    const after = normalise(await snapshot(page));
    assert(!diff(before, after).length, 'sharing songs changed the library: ' + diff(before, after).join(' | '));

    /* a song whose PDF is gone is left out, and the dialog says so (the library keeps the song) */
    const two = Object.values(lib).find(x => /^two-page/i.test(x.title));
    await page.evaluate(id => new Promise(res => { const r = indexedDB.open('setlist-stand'); r.onsuccess = () => { const t = r.result.transaction('files', 'readwrite'); t.objectStore('files').delete(id); t.oncomplete = () => { r.result.close(); res(); }; }; }), two.id);
    await openShareMenu(page, 'share');
    await page.locator('.modal .pick label', {hasText: 'Fixture Alpha'}).locator('input').check();
    await page.locator('.modal .pick label', {hasText: 'Two-page'}).locator('input').check();
    const pk3 = await readPackage((await download(page, () => page.click('.modal [data-ok]'))).file);
    const left = await closeDone(page);
    assert(/1 song is in/.test(left) && /1 song had no PDF and was left out/.test(left), 'a song without a PDF: ' + left);
    assert(pk3.share.songs.length === 1 && pk3.share.songs[0].song === 'Fixture Alpha', 'the package of a song with no PDF: ' + JSON.stringify(pk3.share.songs));
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'share 1: a package holds the stored PDF bytes, details, crops, order and breaks, and no annotation; the library is unchanged', run: loopExport},
];

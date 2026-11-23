/*
 * Data-layer hardening: one regression test per fix from the data-layer review.
 *   ink records without strokes, ids in HTML and in restore, one transaction per replace/delete, backups that always
 *   restore, commits that abort, restored deletion markers, ensureHashes vs an edit, restore validation, file-name
 *   parsing, sortKey, and the MobileSheets converter's helpers and stroke ids.
 * Each loop drives the real app (or the real module / script) and asserts the correct behaviour.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {FIX, TMP, ROOT, JSZip, assert, sleep, sha256, idbAll, fileHashes, snapshot, diff, backupNow, wipe} from './harness.mjs';
import {songAct, songActIn, songDelete, answerDelete} from './songrow.mjs';

const ONE = fs.readFileSync(path.join(FIX, 'one-page.pdf')), H1 = sha256(ONE);
const CRAFTED = '" style="position:fixed;inset:0;opacity:0" data-del="ms123';
const REFUSED = /^That backup has something the app can't read \(.+\)\. Nothing was changed\.$/;

const clearToast = page => page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
async function waitToast(page, re, ms = 20000){
  await page.waitForFunction(src => new RegExp(src).test(document.querySelector('#toast').textContent), re.source, {timeout: ms})
    .catch(async () => { throw new Error(`toast ${re} did not show; toast is "${await page.locator('#toast').textContent()}"`); });
  return page.locator('#toast').textContent();
}
const waitSongs = (page, n, ms = 15000) => page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, n, {timeout: ms})
  .catch(async () => { throw new Error(`expected ${n} songs, library shows ${await page.locator('#libList [data-open]').count()}`); });
function expectSame(a, b, what){
  const d = diff(a, b, '', [], 20);
  assert(!d.length, `${what}: ${d.length} difference(s):\n    ` + d.join('\n    '));
}
function noErrors(s, allow = null){
  const bad = s.errors.filter(e => !(allow && allow.test(e)));
  assert(bad.length === 0, 'page errors: ' + bad.join(' | '));
}
/* Runs fn(S, arg) in the page with S = the app's own store.js module (same URL, so the same instance the app uses).
   (Evaluated as a string through the debugger protocol: the page's CSP forbids eval, and this is not the page's own code.) */
const inStore = (page, fn, arg) => page.evaluate(`(async () => {
  const S = await import(new URL('js/store.js', location.href).href);
  return (${fn.toString()})(S, ${JSON.stringify(arg === undefined ? null : arg)});
})()`);
let zipN = 0;
async function zipFile(lib, files = {}){
  const z = new JSZip();
  for(const [id, buf] of Object.entries(files)) z.file(`files/${id}.pdf`, buf);
  z.file('library.json', JSON.stringify({app: 'setlist-stand', version: 2, saved: new Date().toISOString(), songs: [], sets: [], ink: {}, ...lib}));
  const f = path.join(TMP, `hardening-${++zipN}.zip`);
  await fsp.writeFile(f, await z.generateAsync({type: 'nodebuffer'}));
  return f;
}
async function restore(page, file, re = /\S/){
  await page.click('#tLib');
  await clearToast(page);
  await page.setInputFiles('#restoreFile', file);
  return waitToast(page, re, 30000);
}
async function importOne(page, files = ['one-page.pdf']){
  await page.click('#tLib');
  await clearToast(page);
  const n0 = await page.locator('#libList [data-open]').count();
  await page.setInputFiles('#file', files.map(f => path.join(FIX, f)));
  await waitSongs(page, n0 + files.length);
  await waitToast(page, /^Added/);
}
const liveSong = (s, id, extra = {}) => ({id, title: 'Song ' + id, song: 'Song ' + id, artist: '', version: '', archived: false, pages: 1, hash: H1, added: 1, updated: 1, ...extra});

export const loops = [

{name: 'hardening: the song order ignores extra spaces, case and accents and drops no word ("The", "A"); a duplicate-download suffix does not swap title and artist', async run(ctx){
  /* the modules of the folder under test (ctx.root: a scratch copy when tools/plant-faults.mjs plants a fault in it) */
  const R = (ctx && ctx.root) || ROOT;
  const {sortKey, compareSongs} = await import(pathToFileURL(path.join(R, 'js', 'names.js')).href);
  const {parseFileName} = await import(pathToFileURL(path.join(R, 'js', 'importname.js')).href);
  /* sortKey only takes out extra spaces: no leading "The" or "A" is dropped (Jonathan, 2026-11-21) */
  const keys = {'The  End': 'The End', '  The End ': 'The End', 'A   Day\tin': 'A Day in', 'The': 'The', 'Theme': 'Theme', 'An Angel': 'An Angel'};
  for(const [k, want] of Object.entries(keys)) assert(sortKey(k) === want, `sortKey(${JSON.stringify(k)}) = ${JSON.stringify(sortKey(k))}, expected ${JSON.stringify(want)}`);
  /* compareSongs: the whole order, from records given in a different order */
  const S = (id, song, artist = '', version = '') => ({id, song, artist, version});
  const given = [S('9', 'zebra'), S('8', 'The Weight'), S('7', 'Éclair', 'P', 'b'), S('6', 'Eclair', 'P', 'a'), S('5', '10 Years'), S('4', '2 Fast'), S('3', 'apple pie', 'Beta'), S('2', 'Apple Pie', 'Alpha'), S('1', 'A Day'), S('0', 'An Angel'), {id: 'x', title: 'Untitled'}];
  const got = [...given].sort(compareSongs).map(r => r.id);
  /* numbers as numbers; "A Day" and "An Angel" before "Apple" (nothing dropped); the same name in other case goes by artist;
     Éclair (version b) and Eclair (version a) are the same name at base sensitivity, so the version decides: a before b;
     a record with no song is sorted by its title; "The Weight" is under T */
  const expect = ['4', '5', '1', '0', '2', '3', '6', '7', '8', 'x', '9'];
  assert(got.join() === expect.join(), `compareSongs order ${got.join()}, expected ${expect.join()} (2 Fast, 10 Years, A Day, An Angel, Apple Pie/Alpha, apple pie/Beta, Eclair/a, Éclair/b, The Weight, Untitled, zebra)`);
  const names = {
    'War Pigs - Black Sabbath (1).pdf': ['War Pigs', 'Black Sabbath', ''],
    'War Pigs - Black Sabbath (2).pdf': ['War Pigs', 'Black Sabbath', ''],
    'War Pigs - Black Sabbath.pdf': ['War Pigs', 'Black Sabbath', ''],
    'Heart Says Yes (2) - X.pdf': ['Heart Says Yes', 'X', '2'],
    'Heart Says Yes (2) - X (1).pdf': ['Heart Says Yes', 'X', '2'],
    'Flowers in the Ashes (in G).pdf': ['Flowers in the Ashes', '', 'in G'],
    'Neil Young - Harvest Moon - Chords (1).pdf': ['Harvest Moon', 'Neil Young', ''],
    'Neil Young - Harvest Moon - Chords.pdf': ['Harvest Moon', 'Neil Young', ''],
    'Flowers in the Ashes (in G) (1).pdf': ['Flowers in the Ashes', '', 'in G'],
    'Flowers in the Ashes (in G) (2).pdf': ['Flowers in the Ashes', '', 'in G'],
    'Song (2).pdf': ['Song', '', '2'],
  };
  for(const [f, [song, artist, version]] of Object.entries(names)){
    const r = parseFileName(f);
    assert(r.song === song && r.artist === artist && r.version === version, `parseFileName(${JSON.stringify(f)}) = ${JSON.stringify(r)}, expected ${JSON.stringify({song, artist, version})}`);
  }
}},

{name: 'hardening: converter reads any page order, never makes a break from a song with a Files row, gives strokes stable ids', async run(ctx){
  const py = `
import importlib.util,sys,io,json
spec=importlib.util.spec_from_file_location('conv',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
pdf=open(sys.argv[2],'rb').read(); n3=len(m.pypdf.PdfReader(io.BytesIO(pdf)).pages)
out={}
out['orders']={o:m.parse_page_order(o,8) for o in ['', '1-8', '1-3,5,7-8', '3-1', '2', ' 1 - 2 , 4 ', '0-2', '1-9', 'a-b', '1;2']}
out['classify']=[m.classify(False,[])[0], m.classify(True,[])[0], m.classify(True,[b'not a pdf'])[0], m.classify(True,[b'%PDF-1.4 broken'])[0], m.classify(True,[b'junk',pdf])[0]]
k,(data,r)=m.classify(True,[pdf]); t=m.trim(data,r,[2,0]); out['trim']=len(m.pypdf.PdfReader(io.BytesIO(t)).pages)
print(json.dumps(out))`;
  /* -E -s would hide pypdf when it is a user install, so: -E only, run from the empty TMP folder (nothing there to import) */
  const r = JSON.parse(execFileSync('python3', ['-E', '-c', py, path.join(ROOT, 'tools', 'msb_convert.py'), path.join(FIX, 'three-page.pdf')], {encoding: 'utf8', cwd: TMP}));
  const want = {'': [0, 1, 2, 3, 4, 5, 6, 7], '1-8': [0, 1, 2, 3, 4, 5, 6, 7], '1-3,5,7-8': [0, 1, 2, 4, 6, 7], '3-1': [2, 1, 0], '2': [1], ' 1 - 2 , 4 ': [0, 1, 3],
    '0-2': null, '1-9': null, 'a-b': null, '1;2': null};
  for(const [o, w] of Object.entries(want)) assert(JSON.stringify(r.orders[o]) === JSON.stringify(w), `parse_page_order(${JSON.stringify(o)}, 8) = ${JSON.stringify(r.orders[o])}, expected ${JSON.stringify(w)}`);
  assert(JSON.stringify(r.classify) === JSON.stringify(['break', 'missing_file', 'not_pdf', 'not_pdf', 'ok']), 'classify: ' + JSON.stringify(r.classify));
  assert(r.trim === 2, 'trim to 2 pages gave ' + r.trim);
  /* the converted library (when present): every drawn stroke has an id msann<annotation id>_<n>, and ids are unique */
  if(ctx.library){
    const lib = JSON.parse(await (await JSZip.loadAsync(fs.readFileSync(ctx.library))).file('library.json').async('string'));
    const strokes = Object.values(lib.ink).flat();
    const bad = strokes.filter(s => s.t !== 'text' && !/^msann\d+_\d+$/.test(s.id || ''));
    assert(!bad.length, `${bad.length} of ${strokes.length} converted strokes have no stable id (regenerate the library zip with tools/msb_convert.py)`);
    assert(new Set(strokes.map(s => s.id)).size === strokes.length, 'converted stroke ids are not unique');
  }
}},

{name: 'hardening: ids are escaped on screen, and a backup with a crafted or numeric id is refused', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    await importOne(page);
    const before = await snapshot(page);
    for(const [what, lib, files] of [
      ['crafted song id', {songs: [liveSong(CRAFTED, CRAFTED)]}, {[CRAFTED]: ONE}],
      ['numeric song id', {songs: [{...liveSong('n', 'n'), id: 12345}]}, {12345: ONE}],
      ['crafted setlist id', {sets: [{id: CRAFTED, name: 'S', items: [], created: 1}]}],
      ['crafted id in a setlist', {sets: [{id: 'okset', name: 'S', items: [{type: 'song', id: '<b>'}], created: 1}]}],
      ['crafted ink key', {ink: {[CRAFTED + ':1']: {updated: 1, strokes: []}}}],
    ]){
      const msg = await restore(page, await zipFile(lib, files));
      assert(REFUSED.test(msg), `${what}: restore toast ${JSON.stringify(msg)}`);
      expectSame(before, await snapshot(page), `library after refusing a backup with a ${what}`);
    }
    /* records that got in some other way are still drawn safely */
    await inStore(page, async (S, id) => {
      await S.putAll([{store: 'files', key: id, value: new Blob(['%PDF-1.4'])},
        {store: 'songs', key: id, value: {id, title: 'Crafted', song: 'Crafted', artist: '', version: '', archived: false, pages: '<b>2</b>', added: 1, updated: 1}},
        {store: 'sets', key: id, value: {id, name: 'Crafted set', items: [{type: 'song', id}], created: 1, updated: 1}}]);
    }, CRAFTED);
    await s.goto();
    await waitSongs(page, 2);
    assert(await page.locator('#libList [style], #libList b').count() === 0, 'a crafted id or page count became markup in the library: ' + (await page.locator('#libList').innerHTML()).slice(0, 300));
    const dels = await page.locator('#libList [data-songmenu]').evaluateAll(l => l.map(b => b.getAttribute('data-songmenu')));
    assert(dels.length === 2 && dels.includes(CRAFTED), 'data-songmenu attributes: ' + JSON.stringify(dels));
    const labs = await page.locator('#libList [data-songmenu]').evaluateAll(l => l.map(b => b.getAttribute('aria-label')));
    assert(labs.length === 2 && labs.every(x => x.startsWith('Actions for ')) && labs.includes('Actions for Crafted'), 'aria-labels: ' + JSON.stringify(labs));
    assert(await page.locator('#libList [data-del]').count() === 0, 'the crafted id injected a data-del attribute into the library list');
    await page.click('#tSets');
    await page.waitForSelector('#view [data-set]');
    assert(await page.locator('#view [style]').count() === 0, 'a crafted set id became markup in the setlists');
    assert(await page.locator('#view [data-set]').getAttribute('data-set') === CRAFTED, 'data-set attribute is not the crafted id');
    await page.click('#view [data-set]');
    await page.waitForSelector('#items');
    assert(await page.locator('#view [style], #view b').count() === 0, 'crafted values became markup in the open setlist');
    assert(await page.evaluate(async () => (await import(new URL('js/util.js', location.href).href)).esc(`<a href="x" title='y'>&`)) ===
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;', 'esc() does not escape every HTML special character');
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'hardening: restore refuses a backup it cannot read, before writing anything', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    await importOne(page);
    const before = await snapshot(page);
    const big = (n, f) => Array.from({length: n}, (_, i) => f(i));
    const cases = [
      ['pages 0', {songs: [liveSong('a', 'a', {pages: 0})]}],
      ['pages 5001', {songs: [liveSong('a', 'a', {pages: 5001})]}],
      ['pages as text', {songs: [liveSong('a', 'a', {pages: '1'})]}],
      ['pages 1.5', {songs: [liveSong('a', 'a', {pages: 1.5})]}],
      ['a 2001-character title', {songs: [liveSong('a', 'a', {title: 'x'.repeat(2001)})]}],
      ['a song id twice (marker, then live)', {songs: [{id: 'dup', deleted: true, updated: 1}, liveSong('dup', 'dup')]}],
      ['a setlist id twice', {sets: [{id: 'st', name: 'A', items: []}, {id: 'st', name: 'B', items: []}]}],
      ['an artist that is a number', {songs: [liveSong('a', 'a', {artist: 5})]}],
      ['a hash that is not hex', {songs: [liveSong('a', 'a', {hash: 'z'.repeat(64)})]}],
      ['a short hash', {songs: [liveSong('a', 'a', {hash: 'ab'})]}],
      ['an id of 65 characters', {songs: [liveSong('a'.repeat(65), 'a'.repeat(65))]}],
      ['a song that is not a record', {songs: ['a']}],
      ['a deleted song marked "yes"', {songs: [{id: 'a', deleted: 'yes', updated: 1}]}],
      ['more than 100000 songs', {songs: big(100001, i => ({id: 'd' + i, deleted: true, updated: 1}))}],
      ['more than 100000 setlists', {sets: big(100001, i => ({id: 'd' + i, deleted: true, updated: 1}))}],
      ['a setlist with no name', {sets: [{id: 'st', items: []}]}],
      ['a 2001-character setlist name', {sets: [{id: 'st', name: 'x'.repeat(2001), items: []}]}],
      ['more than 20000 items', {sets: [{id: 'st', name: 'S', items: big(20001, () => ({type: 'break', id: 'b', name: 'B'}))}]}],
      ['an item of an unknown type', {sets: [{id: 'st', name: 'S', items: [{type: 'video', id: 'v'}]}]}],
      ['a break with no name', {sets: [{id: 'st', name: 'S', items: [{type: 'break', id: 'b'}]}]}],
      ['a v1 setlist with a bad song id', {sets: [{id: 'st', name: 'S', songs: ['a b']}]}],
      ['ink that is a list', {ink: []}],
      ['an ink key with page 0', {ink: {'a:0': {updated: 1, strokes: []}}}],
      ['an ink key with page 5001', {ink: {'a:5001': {updated: 1, strokes: []}}}],
      ['an ink key with no page', {ink: {'a': {updated: 1, strokes: []}}}],
      ['more than 50000 strokes on a page', {ink: {'a:1': {updated: 1, strokes: big(50001, () => ({}))}}}],
      ['a stroke of more than 200000 points', {ink: {'a:1': {updated: 1, strokes: [{id: 'k', p: big(200001, () => 0)}]}}}],
      /* collections (backup version 3) */
      ['collections that are not a list', {version: 3, colls: {a: 1}}],
      ['a collection that is not a record', {version: 3, colls: ['a']}],
      ['a collection id with a space', {version: 3, colls: [{id: 'a b', name: 'Band', created: 1, updated: 1}]}],
      ['a collection with the id "all" (the picker\'s own button)', {version: 3, colls: [{id: 'all', name: 'X', created: 1, updated: 1}]}],
      ['a collection id of 65 characters', {version: 3, colls: [{id: 'a'.repeat(65), name: 'Band', created: 1, updated: 1}]}],
      ['a collection id twice', {version: 3, colls: [{id: 'c', name: 'A', created: 1, updated: 1}, {id: 'c', deleted: true, updated: 2}]}],
      ['a 10000-character collection name', {version: 3, colls: [{id: 'c', name: 'x'.repeat(10000), created: 1, updated: 1}]}],
      ['a collection name that is a number', {version: 3, colls: [{id: 'c', name: 5, created: 1, updated: 1}]}],
      ['a collection with no name', {version: 3, colls: [{id: 'c', created: 1, updated: 1}]}],
      ['a deleted collection marked "yes"', {version: 3, colls: [{id: 'c', deleted: 'yes', updated: 1}]}],
      ['more than 10000 collections', {version: 3, colls: big(10001, i => ({id: 'd' + i, deleted: true, updated: 1}))}],
      ['a song whose collections are not a list', {version: 3, songs: [liveSong('a', 'a', {colls: 'band'})]}],
      ['a song with a collection id that is a number', {version: 3, songs: [liveSong('a', 'a', {colls: [7]})]}],
      ['a song with a collection id with a space', {version: 3, songs: [liveSong('a', 'a', {colls: ['a b']})]}],
      ['a song with a crafted collection id', {version: 3, songs: [liveSong('a', 'a', {colls: [CRAFTED]})]}],
      ['a song in more than 1000 collections', {version: 3, songs: [liveSong('a', 'a', {colls: big(1001, i => 'c' + i)})]}],
      ['a setlist whose collections are not a list', {version: 3, sets: [{id: 'st', name: 'S', items: [], colls: {}}]}],
      ['a setlist with a bad collection id', {version: 3, sets: [{id: 'st', name: 'S', items: [], colls: ['a b']}]}],
    ];
    for(const [what, lib] of cases){
      const files = Object.fromEntries((lib.songs || []).filter(x => x && typeof x === 'object' && !x.deleted && typeof x.id === 'string').map(x => [x.id, ONE]));
      const msg = await restore(page, await zipFile(lib, files));
      assert(REFUSED.test(msg), `${what}: restore toast ${JSON.stringify(msg)}`);
      if(ctx.opts.verbose) console.log(`  ${what}: ${msg}`);
    }
    expectSame(before, await snapshot(page), 'library after refusing every bad backup');

    /* accepted: an upper-case hash (stored lower-case), a 2000-character title, a v1 set, a break, a marker */
    const ok = await restore(page, await zipFile({songs: [liveSong('up', 'up', {hash: H1.toUpperCase(), title: 'x'.repeat(2000)}), {id: 'gone', deleted: true, updated: 5}],
      sets: [{id: 'v1s', name: 'Old', songs: ['up'], created: 1}, {id: 'v2s', name: 'New', items: [{type: 'break', id: 'b1', name: 'Set 2'}, {type: 'song', id: 'up'}], created: 2}]}, {up: ONE}));
    assert(ok === 'Restored 1 song and 2 setlists', 'valid backup toast: ' + JSON.stringify(ok));
    assert((await idbAll(page, 'songs')).up.hash === H1, 'an upper-case hash was not stored lower-case');
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'hardening: collections in a backup: unknown ids are ignored not refused, a newer local collection beats an older marker, and a crafted name is drawn as text', async run(ctx){
  const s = await ctx.session(), page = s.page;
  const NAME = '<img src=x onerror=alert(1)>"\'';
  try{
    await s.goto();
    await importOne(page);
    /* a collection that already exists here, newer than the backup's marker for it */
    await inStore(page, async S => { await S.putAll([{store: 'colls', key: 'local', value: {id: 'local', name: 'Local band', created: 1, updated: 5000}}]); });
    const msg = await restore(page, await zipFile({version: 3,
      songs: [liveSong('s1', 's1', {colls: ['c1', 'ghost']}), liveSong('s2', 's2')],
      sets: [{id: 'st1', name: 'S', items: [{type: 'song', id: 's1'}], colls: ['ghost'], created: 1, updated: 1}],
      colls: [{id: 'c1', name: NAME, created: 1, updated: 1}, {id: 'local', deleted: true, updated: 10}, {id: 'gone', deleted: true, updated: 3}]}, {s1: ONE, s2: ONE}), /^Restored/);
    assert(msg === 'Restored 2 songs and 1 setlist', 'restore toast: ' + JSON.stringify(msg));
    const A = await snapshot(page);
    assert(A.colls.local && !A.colls.local.deleted && A.colls.local.updated === 5000, 'an older marker deleted a newer local collection: ' + JSON.stringify(A.colls.local));
    assert(A.colls.c1.name === NAME && A.colls.gone.deleted === true, 'restored collections: ' + JSON.stringify(A.colls));
    assert(JSON.stringify(A.songs.s1.colls) === '["c1","ghost"]' && JSON.stringify(A.songs.s2.colls) === '[]' && JSON.stringify(A.sets.st1.colls) === '["ghost"]', 'colls on restored records: ' + JSON.stringify([A.songs.s1.colls, A.songs.s2.colls, A.sets.st1.colls]));
    /* drawn as text, never as markup */
    await s.goto();
    await page.waitForSelector('.collbar [data-collpick]');
    assert(await page.locator('#view img, #view [onerror]').count() === 0, 'a crafted collection name became markup');
    /* ...and in the manager, the Edit dialog's tick boxes and the "Add songs to" list */
    await page.click('#view [data-collmanage]');
    await page.locator('.collmgr .mname').first().waitFor();
    assert(await page.locator('.collmgr img, .collmgr [onerror]').count() === 0 && (await page.locator('.collmgr .mname', {hasText: '<img'}).count()) === 1, 'a crafted collection name is not shown as plain text in the manager');
    await page.click('.collmgr [data-x]');
    await songActIn(page, page.locator('#libList li.row').first(), 'edit');
    await page.locator('.modal fieldset.checks').waitFor();
    assert(await page.locator('.modal img, .modal [onerror]').count() === 0 && await page.locator('.modal fieldset.checks label', {hasText: '<img'}).count() === 1, 'a crafted collection name is not shown as plain text in Edit');
    await page.click('.modal [data-x]');
    const labels = await page.locator('.collbar button').evaluateAll(l => l.map(b => b.textContent));
    assert(JSON.stringify(labels) === JSON.stringify(['All', NAME, 'Local band', 'Collections']), 'picker buttons: ' + JSON.stringify(labels));
    /* choosing it lists only the songs in it; the unknown id "ghost" counts for nothing, and the setlist (in "ghost" only) is not in it */
    await page.click('.collbar [data-collpick="c1"]');
    assert(JSON.stringify(await page.locator('#libList [data-open]').evaluateAll(l => l.map(b => b.getAttribute('data-open')))) === '["s1"]', 'the collection shows the wrong songs');
    await page.click('#tSets');
    await page.waitForSelector('#view .empty');
    assert(await page.locator('#view [data-set]').count() === 0, 'a setlist in an unknown collection only was listed under a real one');
    await page.click('.collbar [data-collpick="all"]');
    assert(await page.locator('#view [data-set]').count() === 1, 'the setlist is missing under All');
    /* a library whose only collection ids are unknown shows no picker but the Collections button, and nothing is hidden */
    await inStore(page, async S => { await S.putAll([{store: 'colls', key: 'c1', value: {id: 'c1', deleted: true, updated: 99}}, {store: 'colls', key: 'local', value: {id: 'local', deleted: true, updated: 99}}]); });
    await s.goto();
    assert(await page.locator('.collbar button').count() === 1 && await page.locator('#libList [data-open]').count() === 3, 'with no live collection the library shows the picker or hides songs');
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'hardening: a failure after the restore is written says so (not "Nothing was changed")', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.context.addInitScript(() => {
      const getAll = IDBObjectStore.prototype.getAll;
      /* restore reads the local records first: fail only the reads after the restore's own write transaction has begun */
      const tx = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(names, mode, ...rest){
        if(window.__failLoad && mode === 'readwrite' && typeof names !== 'string' && names.length > 1) window.__written = true;
        return tx.call(this, names, mode, ...rest);
      };
      IDBObjectStore.prototype.getAll = function(...a){ if(window.__failLoad && window.__written) throw new Error('load failed (test)'); return getAll.apply(this, a); };
    });
    await s.goto();
    await page.evaluate(() => { window.__failLoad = true; });
    const msg = await restore(page, await zipFile({songs: [liveSong('late', 'late')]}, {late: ONE}));
    assert(msg === 'The backup was restored, but the screen did not update. Reload the app to see it.', 'toast: ' + JSON.stringify(msg));
    await page.evaluate(() => { window.__failLoad = false; });
    assert((await idbAll(page, 'songs')).late, 'the restored song is not stored');
    noErrors(s, /load failed/);
  } finally { await s.close(); }
}},

{name: 'hardening: an ink page with no strokes list restores, reads as empty, and the next backup works', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const u = await inStore(page, S => [S.upgradeInk({}), S.upgradeInk({updated: '7', strokes: [1, null, 'x', {id: 'k'}]}), S.upgradeInk('junk'), S.upgradeInk({updated: 3, strokes: [{id: 'a'}]})]);
    assert(JSON.stringify(u[0].record) === '{"updated":0,"strokes":[]}' && u[0].changed, 'upgradeInk({}) = ' + JSON.stringify(u[0]));
    assert(u[1].record.updated === 7 && JSON.stringify(u[1].record.strokes) === '[{"id":"k"}]', 'upgradeInk with junk strokes = ' + JSON.stringify(u[1]));
    assert(JSON.stringify(u[2].record.strokes) === '[]', 'upgradeInk("junk") = ' + JSON.stringify(u[2]));
    assert(!u[3].changed, 'upgradeInk changed a valid record');
    const msg = await restore(page, await zipFile({songs: [liveSong('ik', 'ik')], ink: {'ik:1': {}}}, {ik: ONE}));
    assert(msg === 'Restored 1 song and 0 setlists', 'restore toast: ' + JSON.stringify(msg));
    await clearToast(page);
    const dl = await backupNow(page);
    assert(await waitToast(page, /Backup/) === 'Backup saved', 'backup after restoring an ink page with no strokes: ' + await page.locator('#toast').textContent());
    assert(fs.statSync(dl.file).size > 0, 'empty backup');
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'hardening: a backup always restores (hash from the stored PDF; a song without a PDF is left out and reported)', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    await importOne(page, ['one-page.pdf', 'two-page.pdf']);
    const ids = Object.values(await idbAll(page, 'songs')).sort((a, b) => a.pages - b.pages).map(x => x.id);
    /* song 1: a wrong hash on its record; song 2: no PDF stored (as a crash between two old writes could leave) */
    await inStore(page, async (S, [a, b]) => { await S.put('songs', a, {...await S.get('songs', a), hash: 'f'.repeat(64)}); await S.del('files', b); }, ids);
    await s.goto();
    await clearToast(page);
    const dl = await backupNow(page);
    assert(await waitToast(page, /Backup saved/) === 'Backup saved. 1 song had no PDF and was left out.', 'backup toast: ' + await page.locator('#toast').textContent());
    const lib = JSON.parse(await (await JSZip.loadAsync(fs.readFileSync(dl.file))).file('library.json').async('string'));
    assert(lib.songs.length === 1 && lib.songs[0].id === ids[0] && lib.songs[0].hash === H1, 'backup songs: ' + JSON.stringify(lib.songs.map(x => [x.id, x.hash])));
    await wipe(page); await s.goto();
    const msg = await restore(page, dl.file);
    assert(msg === 'Restored 1 song and 0 setlists', 'restoring that backup: ' + JSON.stringify(msg));
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'hardening: replace PDF and delete song each write in one transaction, and a failure changes nothing', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.context.addInitScript(() => {
      window.__tx = [];
      const tx = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
      IDBDatabase.prototype.transaction = function(names, mode, ...rest){
        const t = tx.call(this, names, mode, ...rest);
        window.__tx.push({stores: (typeof names === 'string' ? [names] : Array.from(names)).sort().join('+'), mode: mode || 'readonly'});
        return t;
      };
      IDBObjectStore.prototype.put = function(...a){
        if(window.__failSets && this.name === 'sets') throw new DOMException('The disk is full (test)', 'QuotaExceededError');
        return put.apply(this, a);
      };
    });
    await s.goto();
    await importOne(page, ['two-page.pdf']);
    const id = Object.keys(await idbAll(page, 'songs'))[0];
    const pen = {id: 'k1', t: 'pen', c: '#000', w: .003, p: [[.1, .1], [.2, .2]], updated: 1};
    await inStore(page, async (S, [id, pen]) => {
      await S.putInk(id, 1, [pen]); await S.putInk(id, 2, [{...pen, id: 'k2'}]);
      await S.saveSet({id: 'gig', name: 'Gig', items: [{type: 'song', id}, {type: 'break', id: 'b', name: 'Break'}], created: 1});
    }, [id, pen]);
    await s.goto();
    const rw = () => page.evaluate(() => window.__tx.filter(t => t.mode === 'readwrite').map(t => t.stores));
    const reset = () => page.evaluate(() => { window.__tx.length = 0; });

    /* New version (the button that took the place of Replace PDF; this loop keeps its old name for tools/plant-faults.mjs):
       the 2-page chart becomes a 1-page one, and the 2-page chart with its marks is kept as an archived song */
    const H2 = sha256(fs.readFileSync(path.join(FIX, 'two-page.pdf')));
    await reset(); await clearToast(page);
    await songAct(page, 'newversion', id);
    await page.setInputFiles('#newVersionFile', path.join(FIX, 'one-page.pdf'));
    await page.click('.modal.nvask [data-ok]');
    await waitToast(page, /^New version in place/);
    await sleep(300);
    const r1 = await rw();
    assert(r1.length === 1 && r1[0] === 'files+ink+songs', 'New version wrote in ' + JSON.stringify(r1));
    const ink = await idbAll(page, 'ink'), songs = await idbAll(page, 'songs'), song = songs[id], hashes = await fileHashes(page);
    assert(!ink[id + ':2'], 'ink of a page that no longer exists was kept');
    assert(ink[id + ':1'] && ink[id + ':1'].strokes.every(x => x.deleted), 'page 1 ink is not deletion markers: ' + JSON.stringify(ink[id + ':1']));
    assert(song.pages === 1 && song.hash === H1 && hashes[id] === H1, 'song after New version: ' + JSON.stringify([song.pages, song.hash]));
    const oldIds = Object.keys(songs).filter(k => k !== id);
    assert(oldIds.length === 1 && songs[oldIds[0]].archived === true && songs[oldIds[0]].hash === H2 && hashes[oldIds[0]] === H2, 'the old chart was not kept as one archived song: ' + JSON.stringify(songs).slice(0, 300));
    const old = oldIds[0];
    assert(JSON.stringify(ink[old + ':1'].strokes) === JSON.stringify([pen]) && JSON.stringify(ink[old + ':2'].strokes) === JSON.stringify([{...pen, id: 'k2'}]), 'the old copy lost its marks: ' + JSON.stringify([ink[old + ':1'], ink[old + ':2']]));
    const oldCopy = {song: songs[old], file: hashes[old], ink1: ink[old + ':1'], ink2: ink[old + ':2']};

    /* delete fails part-way (the set cannot be written): nothing changes */
    const before = await snapshot(page);
    await page.evaluate(() => { window.__failSets = true; });
    await clearToast(page);
    await songDelete(page, id);
    assert(await waitToast(page, /tablet is full/) === 'The tablet is full. Free up some space, then try again. Nothing was changed.', 'delete on a full tablet');
    expectSame(before, await snapshot(page), 'library after a delete that failed part-way');
    await page.evaluate(() => { window.__failSets = false; });

    /* delete: one transaction; PDF and ink gone, marker left, set updated */
    await reset();
    await songDelete(page, id);
    await waitSongs(page, 0);
    await sleep(300);
    const r2 = await rw();
    assert(r2.length === 1 && r2[0] === 'files+ink+sets+songs', 'delete wrote in ' + JSON.stringify(r2));
    const after = await snapshot(page);
    assert(!after.files[id] && !Object.keys(after.ink).some(k => k.startsWith(id + ':')), 'PDF or ink left after delete');
    assert(JSON.stringify(Object.keys(after.songs[id]).sort()) === '["deleted","id","updated"]' && after.songs[id].deleted === true, 'song is not a marker: ' + JSON.stringify(after.songs[id]));
    assert(JSON.stringify(after.sets.gig.items) === '[{"type":"break","id":"b","name":"Break"}]', 'set after delete: ' + JSON.stringify(after.sets.gig.items));
    /* deleting the new chart never touches the old copy in Archived */
    expectSame(oldCopy, {song: after.songs[old], file: after.files[old], ink1: after.ink[old + ':1'], ink2: after.ink[old + ':2']}, 'the archived old copy after the new chart was deleted');
    noErrors(s, /disk is full/);
  } finally { await s.close(); }
}},

{name: 'hardening: a transaction that aborts at commit rejects every save instead of hanging', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    /* window.__abortCommit: once a request has succeeded (nothing else pending), abort its transaction, as a full disk does at
       commit. 'cursor' aborts only when a key cursor has run out (delInkFor), so no request is pending then either. */
    await s.context.addInitScript(() => {
      const hook = (name, cursor) => {
        const orig = IDBObjectStore.prototype[name];
        IDBObjectStore.prototype[name] = function(...a){
          const r = orig.apply(this, a), mode = window.__abortCommit;
          if(mode && cursor === (mode === 'cursor')) r.addEventListener('success', () => { if(!cursor || r.result === null) try{ r.transaction.abort(); }catch(e){} });
          return r;
        };
      };
      hook('put', false); hook('delete', false); hook('get', false); hook('openKeyCursor', true);
    });
    await s.goto();
    const got = await inStore(page, async S => {
      await S.putInk('ab', 1, []);
      window.__abortCommit = true;
      const settle = p => Promise.race([p.then(() => 'resolved', () => 'rejected'), new Promise(r => setTimeout(() => r('hung'), 3000))]);
      const out = {
        put: await settle(S.put('songs', 'ab', {id: 'ab'})),
        del: await settle(S.del('songs', 'ab')),
        putInk: await settle(S.putInk('ab', 1, [])),
        saveSong: await settle(S.saveSong({id: 'ab', song: 'A', artist: '', version: ''})),
        delInkFor: await (async () => { window.__abortCommit = 'cursor'; const v = await settle(S.delInkFor('ab')); window.__abortCommit = true; return v; })(),
        putAll: await settle(S.putAll([{store: 'songs', key: 'ab', value: {id: 'ab'}}])),
        update: S.update ? await settle(S.update('songs', 'ab', () => ({id: 'ab'}))) : 'no update()',
      };
      window.__abortCommit = false;
      return out;
    });
    const bad = Object.entries(got).filter(([, v]) => v !== 'rejected');
    assert(!bad.length, 'saves that did not reject on an aborted commit: ' + JSON.stringify(Object.fromEntries(bad)));
  } finally { await s.close(); }
}},

{name: 'hardening: restoring a deleted song removes its PDF and annotations here', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    await importOne(page);
    const id = Object.keys(await idbAll(page, 'songs'))[0];
    await inStore(page, (S, id) => S.putInk(id, 1, [{id: 'k', t: 'pen', c: '#000', w: .003, p: [[0, 0], [1, 1]], updated: 1}]), id);
    const msg = await restore(page, await zipFile({songs: [{id, deleted: true, updated: 9e12, title: 'kept?', pages: 3}], ink: {[id + ':1']: {updated: 1, strokes: [{id: 'z'}]}}}));
    assert(msg === 'Restored 0 songs and 0 setlists', 'restore toast: ' + JSON.stringify(msg));
    await waitSongs(page, 0);
    const snap = await snapshot(page);
    assert(!snap.files[id], 'the PDF of a song the backup deleted is still stored');
    assert(!Object.keys(snap.ink).some(k => k.startsWith(id + ':')), 'annotations of a song the backup deleted are still stored');
    assert(JSON.stringify(snap.songs[id]) === JSON.stringify({id, deleted: true, updated: 9e12}), 'marker stored as ' + JSON.stringify(snap.songs[id]));
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'hardening: filling in a missing hash keeps an edit made while it was hashing, and never revives a deleted song', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    await importOne(page, ['one-page.pdf', 'two-page.pdf']);
    const ids = Object.keys(await idbAll(page, 'songs'));
    const out = await inStore(page, async (S, [a, b]) => {
      for(const id of [a, b]){ const c = await S.get('songs', id); delete c.hash; await S.put('songs', id, c); }
      await S.load();
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let release, started; const hold = new Promise(r => { release = r; }), go = new Promise(r => { started = r; });
      crypto.subtle.digest = async (...x) => { started(); await hold; return digest(...x); };
      const p = S.ensureHashes();
      await go;                                                      // hashing song a has begun
      await S.put('songs', a, {...await S.get('songs', a), song: 'Edited meanwhile'});
      await S.put('songs', b, {id: b, deleted: true, updated: 9});
      release();
      const n = await p;
      crypto.subtle.digest = digest;
      return {n, a: await S.get('songs', a), b: await S.get('songs', b)};
    }, ids);
    assert(out.a.song === 'Edited meanwhile', 'ensureHashes wrote back a stale record: song = ' + JSON.stringify(out.a.song));
    assert(/^[0-9a-f]{64}$/.test(out.a.hash || ''), 'hash not filled in: ' + out.a.hash);
    assert(JSON.stringify(out.b) === JSON.stringify({id: ids[1], deleted: true, updated: 9}), 'a song deleted while hashing came back: ' + JSON.stringify(out.b));
    assert(out.n === 1, 'ensureHashes counted ' + out.n);
    noErrors(s);
  } finally { await s.close(); }
}},


{name: 'hardening: restore keeps a newer local song or set over an older deletion marker, and restored songs drop local ink the backup lacks', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    await importOne(page, ['one-page.pdf', 'two-page.pdf']);
    const [keep, mix] = Object.values(await idbAll(page, 'songs')).sort((a, b) => a.pages - b.pages).map(x => x.id);
    const pen = id => ({id, t: 'pen', c: '#000', w: .003, p: [[0, 0], [1, 1]], updated: 1});
    await inStore(page, async (S, [keep, mix, a, b, c]) => {
      await S.put('songs', keep, {...await S.get('songs', keep), updated: 5000});
      await S.putInk(keep, 1, [a]);
      await S.putInk(mix, 1, [b]); await S.putInk(mix, 2, [c]);
      await S.put('sets', 'gig', {id: 'gig', name: 'Gig', items: [{type: 'song', id: keep}], colls: [], created: 1, updated: 5000});
    }, [keep, mix, pen('a'), pen('b'), pen('c')]);
    const before = await snapshot(page);
    const two = fs.readFileSync(path.join(FIX, 'two-page.pdf'));
    /* the backup: old markers for `keep` and the set, and `mix` with only page 2 annotated */
    const msg = await restore(page, await zipFile({
      songs: [{id: keep, deleted: true, updated: 10}, liveSong(mix, mix, {pages: 2, hash: sha256(two)})],
      sets: [{id: 'gig', deleted: true, updated: 10}],
      ink: {[mix + ':2']: {updated: 2, strokes: [pen('z')]}}}, {[mix]: two}));
    assert(msg === 'Restored 1 song and 0 setlists', 'restore toast: ' + JSON.stringify(msg));
    const after = await snapshot(page);
    expectSame(before.songs[keep], after.songs[keep], 'a newer local song after an older marker');
    assert(after.files[keep] === before.files[keep], 'the PDF of a newer local song was removed by an older marker');
    expectSame(before.ink[keep + ':1'], after.ink[keep + ':1'], 'the ink of a newer local song after an older marker');
    expectSame(before.sets.gig, after.sets.gig, 'a newer local set after an older marker');
    assert(!after.ink[mix + ':1'], 'local ink the backup does not have was mixed into the restored song');
    assert(JSON.stringify(after.ink[mix + ':2'].strokes.map(x => x.id)) === '["z"]', 'restored song page 2 ink: ' + JSON.stringify(after.ink[mix + ':2']));
    /* a marker NEWER than the local song still deletes it */
    const msg2 = await restore(page, await zipFile({songs: [{id: keep, deleted: true, updated: 9999}]}));
    assert(msg2 === 'Restored 0 songs and 0 setlists', 'second restore toast: ' + JSON.stringify(msg2));
    const s2 = await snapshot(page);
    assert(s2.songs[keep].deleted && !s2.files[keep] && !s2.ink[keep + ':1'], 'a newer marker did not delete the song');
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'hardening: text fields stop at 200 characters, so an app-made backup always passes the 2000-character check', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    await importOne(page);
    await songActIn(page, page.locator('#libList li.row').first(), 'edit');
    await page.waitForSelector('.modal input');
    const lens = await page.locator('.modal input[type=text]').evaluateAll(l => l.map(i => i.maxLength));
    assert(lens.length === 3 && lens.every(n => n === 200), 'Edit song maxlength: ' + JSON.stringify(lens));
    await page.click('.modal [data-x]');
    await page.click('#tSets');
    await page.click('#view [data-newset]');
    await page.waitForSelector('.modal input');
    assert(await page.locator('.modal input[type=text]').evaluate(i => i.maxLength) === 200, 'New setlist name has no maxlength 200');
    await page.click('.modal [data-x]');
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'hardening: a missing hash is not filled in from a PDF that was replaced while hashing', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    await importOne(page);
    const id = Object.keys(await idbAll(page, 'songs'))[0];
    const two = fs.readFileSync(path.join(FIX, 'two-page.pdf')).toString('base64');
    const out = await inStore(page, async (S, [id, two]) => {
      const c = await S.get('songs', id); delete c.hash; await S.put('songs', id, c);
      await S.load();
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let release, started; const hold = new Promise(r => { release = r; }), go = new Promise(r => { started = r; });
      crypto.subtle.digest = async (...x) => { started(); await hold; return digest(...x); };
      const p = S.ensureHashes();
      await go;
      /* meanwhile a restore puts a different PDF under the same id, with a newer record and no hash */
      const bytes = Uint8Array.from(atob(two), ch => ch.charCodeAt(0));
      await S.putAll([{store: 'files', key: id, value: new Blob([bytes], {type: 'application/pdf'})}, {store: 'songs', key: id, value: {...c, pages: 2, updated: c.updated + 1}}]);
      release();
      await p;
      crypto.subtle.digest = digest;
      return S.get('songs', id);
    }, [id, two]);
    assert(out.hash == null, 'the old PDF\'s hash was written onto the replaced song: ' + out.hash);
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'hardening: converter survives a null setlist name and a zero page size, and counts setlist entries it drops', async run(){
  const py = `
import importlib.util,sys,io,json,sqlite3,struct,os,zipfile,contextlib
spec=importlib.util.spec_from_file_location('conv',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
pdf=open(sys.argv[2],'rb').read(); tmp=sys.argv[3]
db=os.path.join(tmp,'synthetic.db')
if os.path.exists(db): os.unlink(db)
c=sqlite3.connect(db)
c.executescript('''create table Songs(Id,Title,CreationDate); create table Files(SongId,Type,PageOrder,SourceFilePageCount);
create table AnnotationsBase(Id,SongId,Type,Page,SourcePageWidth,SourcePageHeight,Opacity); create table AnnotationPoints(AnnotationId,Points);
create table DrawAnnotations(BaseId,LineColor,LineWidth); create table TextboxAnnotations(BaseId,Text,FontSize,TextColor);
create table Crop(SongId,Page,Left,Top,Right,Bottom); create table Setlists(Id,Name,DateCreated); create table SetlistSong(Id,SetlistId,SongId);''')
c.executemany('insert into Songs values(?,?,?)',[(1,'Good Song',0),(2,'Gone Song',0),(3,'Set 2',0)])
c.executemany('insert into Files values(?,?,?,?)',[(1,1,'',3),(2,1,'',1)])
pts=struct.pack('<7d',0,4,1.0,10,10,20,20)
c.executemany('insert into AnnotationsBase values(?,?,?,?,?,?,?)',[(1,1,1,0,0,0,100),(2,1,1,0,None,None,100),(3,1,0,0,0,792,100)])
c.executemany('insert into AnnotationPoints values(?,?)',[(1,pts),(2,pts),(3,struct.pack('<6d',1,1,2,2,1,1))])
c.execute("insert into TextboxAnnotations values(3,'note',12,-16777216)")
c.execute('insert into Setlists values(1,NULL,0)')
c.executemany('insert into SetlistSong values(?,?,?)',[(1,1,1),(2,1,2),(3,1,3)])
c.commit(); c.close()
blob=open(db,'rb').read(); mk=b'\\xab'*8
msb=b'HEADER00'+struct.pack('>Q',len(blob))+blob+mk+struct.pack('>Q',1)+struct.pack('>Q',len(pdf))+pdf
f=os.path.join(tmp,'synthetic.msb'); open(f,'wb').write(msb); out=os.path.join(tmp,'synthetic.zip')
buf=io.StringIO()
with contextlib.redirect_stdout(buf): m.main(f,out)
rep=json.loads(buf.getvalue()); lib=json.loads(zipfile.ZipFile(out).read('library.json'))
print(json.dumps({'rep':rep,'sets':lib['sets'],'ink':lib['ink']}))`;
  const r = JSON.parse(execFileSync('python3', ['-E', '-c', py, path.join(ROOT, 'tools', 'msb_convert.py'), path.join(FIX, 'three-page.pdf'), TMP], {encoding: 'utf8', cwd: TMP}));
  assert(r.sets.length === 1 && r.sets[0].name === '', 'setlist with a NULL name: ' + JSON.stringify(r.sets[0] && r.sets[0].name));
  assert(JSON.stringify(r.sets[0].items.map(i => i.type)) === '["song","break"]', 'setlist items: ' + JSON.stringify(r.sets[0].items));
  assert(r.rep.setlist_entries_dropped === 1, 'setlist_entries_dropped = ' + JSON.stringify(r.rep.setlist_entries_dropped));
  assert(JSON.stringify(r.rep.missing_file) === '["Gone Song"]', 'missing_file = ' + JSON.stringify(r.rep.missing_file));
  assert(Object.keys(r.ink).length === 0, 'annotations with no page size were converted: ' + JSON.stringify(r.ink));
}},

];

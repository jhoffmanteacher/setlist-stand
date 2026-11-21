/*
 * Share import loops: Library -> Import a share package.
 *
 * share 2  the round trip. Library A shares a setlist and some songs through the real buttons; a fresh library B (which already
 *          holds one of the songs, with its own details and crop) imports the file. What B ends up with is compared with A's
 *          records and with the PDF files the songs came from; B's own records must not change at all, one write transaction
 *          must hold the import, and a backup of B must restore.
 * share 3  hostile packages, built in Node (the file is made by somebody else): every refusal gives a plain message and leaves
 *          the library exactly as it was; bad crops are dropped without refusing the package; a title with HTML is shown as text.
 * share 4  all or nothing: a full tablet, and a reload in the middle of the write, never leave half a package.
 * share 5  one import at a time: a second pick while the first is open is turned away and the first carries on; Cancel adds
 *          nothing and frees the next import; the question names the setlist as it will be saved ("Gig (2)").
 */
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {FIX, JSZip, PDFDocument, assert, sleep, sha256, idbAll, fileHashes, snapshot, normalise, diff, download, backupNow, wipe, restoreZip} from './harness.mjs';
import {CROPS, songsOf, importFixtures, buildLibrary, closeDone} from './share-lib.mjs';

/* Wraps IDBDatabase.prototype.transaction before the app starts: every call is recorded in window.__tx as
   {stores, mode, at, puts} (puts = IDBObjectStore.put calls made on that transaction). Same probe as roundtrip.loop.mjs. */
const TX_PROBE = () => {
  window.__tx = [];
  const tx = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put, recs = new WeakMap();
  IDBDatabase.prototype.transaction = function(names, mode, ...rest){
    const t = tx.call(this, names, mode, ...rest);
    const rec = {stores: (typeof names === 'string' ? [names] : Array.from(names)).sort(), mode: mode || 'readonly', at: performance.now(), puts: 0};
    window.__tx.push(rec); recs.set(t, rec);
    return t;
  };
  IDBObjectStore.prototype.put = function(...a){ const r = recs.get(this.transaction); if(r) r.puts++; return put.apply(this, a); };
};

const sha = f => sha256(fs.readFileSync(path.join(FIX, f)));
const waitFor = async (fn, what, ms = 8000) => { const end = Date.now() + ms; let v; while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(80); } throw new Error(typeof what === 'function' ? await what() : what); };
const clearToast = page => page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
const toastText = page => page.locator('#toast').textContent();
const waitToast = (page, re) => page.waitForFunction(re => new RegExp(re).test(document.querySelector('#toast').textContent), re.source, {timeout: 20000});
const noModal = page => page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 8000});

async function sendFile(page, payload){ await page.click('#tLib'); await page.setInputFiles('#shareFile', payload); }
async function confirmText(page){
  const dlg = page.locator('.modal [role=dialog]', {hasText: 'Import share package'});
  await dlg.waitFor({timeout: 30000});
  return dlg.textContent();
}
/* the refusal notice: its text, then OK; no dialog is left open */
async function refusal(page, title = "Can't import that package"){
  const dlg = page.locator('.modal [role=dialog]', {hasText: title});
  await dlg.waitFor({timeout: 30000});
  const text = await dlg.textContent();
  await page.click('.modal [data-x]');
  await noModal(page);
  return text;
}

/* ---------- share 2: the round trip ---------- */
async function loopRoundTrip(ctx){
  /* library A makes two packages through the real buttons */
  let setPkg, songsPkg, aLib, aStored, aSet;
  const sa = await ctx.session();
  try{
    const {page} = sa;
    await sa.goto(); await importFixtures(page); await buildLibrary(page);
    await page.reload(); await page.waitForSelector('#libList [data-open]');
    aLib = Object.fromEntries((await songsOf(page)).map(x => [x.id, x])); aStored = await fileHashes(page);
    aSet = Object.values(await idbAll(page, 'sets')).find(x => !x.deleted);
    await page.click('#tSets'); await page.click('#view [data-set]'); await page.waitForSelector('#view [data-shareset]');
    setPkg = (await download(page, () => page.click('#view [data-shareset]'))).file; await closeDone(page);
    await page.click('#tLib'); await page.click('[data-sharesongs]');
    await page.locator('.modal .pick label', {hasText: 'Fixture Alpha'}).locator('input').check();
    await page.locator('.modal .pick label', {hasText: 'Two-page'}).locator('input').check();
    songsPkg = (await download(page, () => page.click('.modal [data-ok]'))).file; await closeDone(page);
  } finally { await sa.close(); }
  const aOf = hash => Object.values(aLib).find(x => aStored[x.id] === hash);

  /* library B: has one-page.pdf with its OWN details and crop, and a setlist named like the package's */
  const sb = await ctx.session();
  try{
    const {page} = sb;
    await sb.context.addInitScript(TX_PROBE);
    await sb.goto();
    await page.setInputFiles('#file', path.join(FIX, 'one-page.pdf'));
    await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 1, null, {timeout: 20000});
    const MINE = {x: .3, y: .3, w: .4, h: .4};
    await page.evaluate(async M => {
      const st = await import('./js/store.js'), {uid} = await import('./js/util.js');
      const s = st.state.songs[0];
      Object.assign(s, {song: 'Mine', artist: 'B Artist', version: '', crop: {all: M, pages: {}}});
      await st.saveSong(s);
      await st.saveSet({id: uid(), name: 'Gig: Friday', created: Date.now(), items: [{type: 'song', id: s.id}]});
      await st.load();
    }, MINE);
    await page.reload(); await page.waitForSelector('#libList [data-open]');
    const before = normalise(await snapshot(page)), matchedId = (await songsOf(page))[0].id;
    assert(before.files[matchedId] === await sha('one-page.pdf') && aStored[Object.keys(aLib).find(id => aLib[id].song === 'Fixture Alpha')] === before.files[matchedId], 'test setup: B and A must hold the same PDF');

    /* Cancel writes nothing */
    await sendFile(page, setPkg);
    const text = await confirmText(page);
    assert(/2 new songs will be added/.test(text) && /1 song already in your library will stay as they are/.test(text), 'confirm dialog counts: ' + text);
    assert(/Two-page/.test(text) && /Three-page/.test(text) && !/Fixture Alpha|Mine/.test(text.split('Gig')[0]), 'the dialog lists the new songs: ' + text);
    assert(/Gig: Friday/.test(text), 'the dialog names the setlist: ' + text);
    await page.click('.modal [data-x]'); await noModal(page);
    const cancelled = normalise(await snapshot(page));
    assert(!diff(before, cancelled).length, 'Cancel changed the library: ' + diff(before, cancelled).join(' | '));

    /* Add: everything in ONE write */
    await sendFile(page, setPkg);
    await confirmText(page);
    await page.evaluate(() => { window.__tx.length = 0; });
    await clearToast(page);
    await page.click('.modal [data-ok]');
    await waitToast(page, /Added 2 songs/);
    const msg = await toastText(page);
    assert(/1 already in your library/.test(msg) && /the setlist Gig: Friday \(2\)/.test(msg), 'toast: ' + msg);
    const tx = await page.evaluate(() => window.__tx.slice());
    const writers = tx.filter(t => t.mode === 'readwrite' && t.stores.includes('files'));
    assert(writers.length === 1 && writers[0].stores.join() === 'files,sets,songs' && writers[0].puts === 5, 'the import must be one transaction over files, sets and songs with 5 puts (2 PDFs, 2 songs, 1 setlist): ' + JSON.stringify(writers));

    const after = await songsOf(page), stored = await fileHashes(page), sets = Object.values(await idbAll(page, 'sets')).filter(x => !x.deleted);
    assert(after.length === 3, 'B has ' + after.length + ' songs, expected 3');
    const mineAfter = after.find(x => x.id === matchedId);
    const mineBefore = before.songs[matchedId];
    assert(!diff(mineBefore, mineAfter).length, 'a song the library already had was changed by the import: ' + diff(mineBefore, mineAfter).join(' | '));
    const fresh = after.filter(x => x.id !== matchedId), freshByName = {};
    assert(fresh.length === 2, 'two new songs expected');
    for(const x of fresh){
      const src = aOf(x.hash);
      assert(src, `new song "${x.title}" has a hash no song of A has`);
      for(const k of ['song', 'artist', 'version', 'pages']) assert(x[k] === src[k], `${x.title}: ${k} ${JSON.stringify(x[k])} != A's ${JSON.stringify(src[k])}`);
      assert(!x.archived && !x.deleted && x.id !== src.id, `${x.title}: archived, deleted or the sender's id`);
      assert(JSON.stringify(x.crop) === JSON.stringify(CROPS[src.song]), `${x.title}: crop ${JSON.stringify(x.crop)}, expected ${JSON.stringify(CROPS[src.song])}`);
      assert(stored[x.id] === x.hash && x.hash === aStored[src.id], `${x.title}: stored bytes hash ${stored[x.id]}, record ${x.hash}, A ${aStored[src.id]}`);
      freshByName[src.song] = x.id;
    }
    assert(stored[freshByName['Two-page']] === await sha('two-page.pdf') && stored[freshByName['Three-page']] === await sha('three-page.pdf'), 'a stored PDF is not the file it came from');
    assert(!Object.keys(await idbAll(page, 'ink')).length, 'B has annotations from A');
    assert(sets.length === 2, 'B has ' + sets.length + ' setlists, expected 2');
    const orig = sets.find(x => x.name === 'Gig: Friday'), made = sets.find(x => x.name === 'Gig: Friday (2)');
    assert(orig && made, 'setlist names: ' + sets.map(x => x.name));
    assert(!diff(before.sets[orig.id], orig).length, 'the setlist B already had was changed');
    const kinds = made.items.map(it => it.type === 'break' ? 'break:' + it.name : 'song:' + it.id);
    assert(JSON.stringify(kinds) === JSON.stringify(['song:' + matchedId, 'break:Set 2', 'song:' + freshByName['Two-page'], 'song:' + matchedId, 'song:' + freshByName['Three-page']]), 'imported setlist: ' + JSON.stringify(kinds));
    const brk = made.items[1];
    assert(brk.id && brk.id !== aSet.items[1].id, 'the break kept the sender\'s id');

    /* the same package again: nothing new but the setlist, which gets a fresh name and replaces nothing */
    await sendFile(page, setPkg);
    const again = await confirmText(page);
    assert(/No new songs/.test(again) && /3 songs already in your library/.test(again), 'second import dialog: ' + again);
    await clearToast(page); await page.click('.modal [data-ok]'); await waitToast(page, /the setlist/);
    const sets2 = Object.values(await idbAll(page, 'sets')).filter(x => !x.deleted);
    assert(sets2.map(x => x.name).sort().join() === 'Gig: Friday,Gig: Friday (2),Gig: Friday (3)', 'setlist names after a second import: ' + sets2.map(x => x.name));
    assert((await songsOf(page)).length === 3, 'a second import added songs');
    assert(!diff(normalise({a: made}), normalise({a: sets2.find(x => x.id === made.id)})).length, 'the first imported setlist was changed by the second import');

    /* a package of songs the library already has, and no setlist: nothing to do, and no dialog */
    await sendFile(page, songsPkg);
    await waitToast(page, /Nothing new: 2 songs are already in your library/);
    assert(!(await page.locator('.modal').count()), 'a dialog opened for a package with nothing new');

    /* the imported library backs up and restores */
    const zip = await backupNow(page);
    await wipe(page); await sb.goto();
    const restored = await restoreZip(page, zip.file);
    assert(/Restored 3 songs and 3 setlists/.test(restored), 'restore after import: ' + restored);
    assert(sb.errors.length === 0, 'page errors: ' + sb.errors.join(' | '));
  } finally { await sb.close(); }
}

/* ---------- share 3: hostile packages ---------- */
const PDF = fs.readFileSync(path.join(FIX, 'two-page.pdf')), HASH = sha256(PDF);
const base = () => ({app: 'setlist-stand', kind: 'share', version: 1, saved: 'x', songs: [{id: 's1', song: 'Hostile Test', artist: '', version: '', pages: 2, hash: HASH}], setlist: {name: 'Hostile', items: [{type: 'song', id: 's1'}]}});
async function zipOf(share, files = {'files/s1.pdf': PDF}, compression = 'DEFLATE'){
  const z = new JSZip();
  z.file('share.json', typeof share === 'string' ? share : JSON.stringify(share));
  for(const [n, b] of Object.entries(files)) z.file(n, b, {createFolders: false});
  return Buffer.from(await z.generateAsync({type: 'nodebuffer', compression}));
}
/* A valid PDF of about 3 MB (a long run of comment lines in an uncompressed content stream): it compresses to almost nothing. */
async function bigPdf(tag){
  const d = await PDFDocument.create(), p = d.addPage([300, 300]);
  p.drawText(tag, {x: 20, y: 150, size: 18});
  p.node.addContentStream(d.context.register(d.context.stream('% padding\n'.repeat(300000))));
  return Buffer.from(await d.save({updateMetadata: false}));
}
/* a 4 MB file whose list of files is 2.2 MB */
async function hugeList(){ const z = new JSZip(); z.file('share.json', JSON.stringify(base())); for(let i = 0; i < 40000; i++) z.file(String(i).padStart(10, '0'), ''); return Buffer.from(await z.generateAsync({type: 'nodebuffer', compression: 'STORE'})); }
const withSong = (over, extra = {}) => { const d = base(); Object.assign(d.songs[0], over); Object.assign(d, extra); return d; };
const named = buf => ({name: 'package.zip', mimeType: 'application/zip', buffer: buf});

async function loopHostile(ctx){
  const REFUSED = [
    ['not our app', async () => zipOf({...base(), app: 'other'}), /not a Setlist Stand share package/],
    ['kind backup', async () => zipOf({...base(), kind: 'backup'}), /not a Setlist Stand share package/],
    ['a real backup', async () => { const z = new JSZip(); z.file('library.json', JSON.stringify({app: 'setlist-stand', version: 2, songs: [], sets: [], ink: {}})); return Buffer.from(await z.generateAsync({type: 'nodebuffer'})); }, /That is a backup, not a share package/],
    ['no share.json', async () => { const z = new JSZip(); z.file('hello.txt', 'hi'); return Buffer.from(await z.generateAsync({type: 'nodebuffer'})); }, /not a Setlist Stand share package/],
    ['share.json that is not JSON', async () => zipOf('{ nope'), /not a Setlist Stand share package/],
    ['a newer version', async () => zipOf({...base(), version: 99}), /newer version of Setlist Stand/],
    ['an empty package', async () => zipOf({...base(), songs: [], setlist: null}), /package is empty/],
    ['a missing PDF', async () => zipOf(base(), {}), /missing the PDF for "Hostile Test"/],
    ['a hash that does not match', async () => zipOf(withSong({hash: 'f'.repeat(64)})), /damaged \("Hostile Test" does not match\)/],
    ['a hash that is not a hash', async () => zipOf(withSong({hash: 'zzz'})), /can't read .*hash/],
    ['bytes that are not a PDF (hash correct)', async () => { const junk = Buffer.from('this is not a pdf at all'); return zipOf(withSong({hash: sha256(junk)}), {'files/s1.pdf': junk}); }, /not a PDF this app can open/],
    ['an id that climbs out', async () => { const d = withSong({id: '../x'}); d.setlist = null; return zipOf(d, {'files/../x.pdf': PDF}); }, /can't read .*song id/],
    ['an id of 70 characters', async () => { const d = withSong({id: 'a'.repeat(70)}); d.setlist = null; return zipOf(d); }, /can't read .*song id/],
    ['a repeated id', async () => { const d = base(); d.songs.push({...d.songs[0]}); return zipOf(d); }, /can't read .*twice/],
    ['a setlist item for a song that is not there', async () => zipOf(withSong({}, {setlist: {name: 'x', items: [{type: 'song', id: 's9'}]}})), /not in the package/],
    ['a setlist item of a strange type', async () => zipOf(withSong({}, {setlist: {name: 'x', items: [{type: 'script'}]}})), /item of type/],
    ['a title that is not text', async () => zipOf(withSong({song: {a: 1}})), /no usable title/],
    ['a title of 5000 characters', async () => zipOf(withSong({song: 'x'.repeat(5000)})), /no usable title/],
    ['more songs than the limit', async () => { const d = base(); d.songs = Array.from({length: 5001}, (_, i) => ({id: 'a' + i, song: 'S' + i})); d.setlist = null; return zipOf(d, {}); }, /more than 5000 songs/],
    ['a zip with a damaged PDF inside (CRC)', async () => { const buf = await zipOf(base(), {'files/s1.pdf': PDF}, 'STORE'); const at = buf.indexOf(PDF.subarray(200, 216)); assert(at > 0, 'test setup'); buf[at + 4] ^= 0xff; return buf; }, /damaged/],
    ['a truncated zip', async () => { const buf = await zipOf(base()); return buf.subarray(0, buf.length - 40); }, /not a Setlist Stand share package|damaged/],
    ['a small zip that inflates past the cap', async () => zipOf(withSong({hash: 'a'.repeat(64)}), {'files/s1.pdf': Buffer.alloc(30e6)}), /too big/],
    /* everything the import would read is small and valid; only an entry it never reads makes the FILE big, so only the early size check can refuse it */
    ['share.json with one byte changed (CRC)', async () => { const buf = await zipOf(base(), {'files/s1.pdf': PDF}, 'STORE'); const at = buf.indexOf('Hostile Test'); assert(at > 0, 'test setup'); buf[at + 8] = 'X'.charCodeAt(0); return buf; }, /damaged/],
    ['share.json bigger than the cap', async () => zipOf(' '.repeat(2e6) + JSON.stringify({...base(), app: 'other'})), /too big to read/],
    ['a zip with a huge list of files', hugeList, /too many files/],
    /* JSZip finds the end record anywhere in the file, past padding too: a guard that looked only at the last 64 KB would let this open (and all 40000 records are valid) */
    ['a huge list of files with 70 KB of padding after the end record', async () => Buffer.concat([await hugeList(), Buffer.alloc(70000)]), /not a Setlist Stand share package/],
    /* a zip64 marker makes JSZip read the 64-bit fields, not the 32-bit ones the guard measures */
    ['a zip64 marker in the end record (entry count)', async () => { const buf = await zipOf(base(), {'files/s1.pdf': PDF}); const at = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6])); assert(at > 0, 'test setup'); buf.writeUInt16LE(0xFFFF, at + 10); return buf; }, /too many files/],
    ['a zip64 marker in the end record (directory size)', async () => { const buf = await zipOf(base(), {'files/s1.pdf': PDF}); const at = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6])); assert(at > 0, 'test setup'); buf.writeUInt32LE(0xFFFFFFFF, at + 12); return buf; }, /too many files/],
    ['a zip64 marker in the end record (directory offset)', async () => { const buf = await zipOf(base(), {'files/s1.pdf': PDF}); const at = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6])); assert(at > 0, 'test setup'); buf.writeUInt32LE(0xFFFFFFFF, at + 16); return buf; }, /too many files/],
    ['a package file bigger than the limits allow', async () => zipOf(base(), {'files/s1.pdf': PDF, 'junk.bin': randomBytes(7e6)}, 'STORE'), /too big/],
    ['two PDFs that fit the cap one by one but not together', async () => {
      const a = await bigPdf('First big'), b = await bigPdf('Second big'), d = base();
      d.songs = [{id: 's1', song: 'Big one', hash: sha256(a)}, {id: 's2', song: 'Big two', hash: sha256(b)}]; d.setlist = null;
      return zipOf(d, {'files/s1.pdf': a, 'files/s2.pdf': b});
    }, /too big/],
    ['a song with no hash', async () => { const d = base(); delete d.songs[0].hash; return zipOf(d); }, /can't read .*hash/],
  ];
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto(); await importFixtures(page);
    /* the cap lowered, so the inflation case does not need a gigabyte */
    await page.evaluate(async () => { const l = (await import('./js/shareimport.js')).limits; l.maxPdfBytes = 5e6; l.maxJson = 1e6; });
    const baseline = normalise(await snapshot(page));
    for(const [name, make, re] of REFUSED){
      await sendFile(page, named(await make()));
      const text = await refusal(page);
      assert(re.test(text), `${name}: the message is "${text}"`);
      assert(!/Error|undefined|\[object|TypeError/.test(text), `${name}: a raw error reached the message: ${text}`);
      assert(!(await page.locator('.modal').count()), `${name}: a dialog is still open`);
      const now = normalise(await snapshot(page));
      assert(!diff(baseline, now).length, `${name}: the library changed: ${diff(baseline, now).join(' | ')}`);
    }
    /* the other way round: a share package given to Restore is named, and nothing changes */
    await page.click('#tLib'); await clearToast(page);
    await page.setInputFiles('#restoreFile', named(await zipOf(base())));
    await waitToast(page, /share package/);
    assert(/That is a share package, not a backup\. Use Import a share package/.test(await toastText(page)), 'Restore given a package says: ' + await toastText(page));
    assert(!diff(baseline, normalise(await snapshot(page))).length, 'Restore given a share package changed the library');
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }

  /* damaged crops: the package is not refused; the bad parts are dropped and counted, the good one kept */
  const s2 = await ctx.session();
  try{
    const {page} = s2;
    await s2.goto();
    const GOOD = {x: .1, y: .1, w: .5, h: .5};
    const crop = {all: {x: -1, y: 0, w: 1, h: 1}, pages: {'1': GOOD, '2': {x: 0, y: 0, w: .01, h: .5}, '7': GOOD, 'x': GOOD, '0': GOOD}};
    await sendFile(page, named(await zipOf(withSong({crop}, {setlist: null}))));
    const text = await confirmText(page);
    assert(/5 crops in the package could not be used and were left out/.test(text), 'dropped crops are not reported: ' + text);
    await page.click('.modal [data-ok]');
    const song = await waitFor(async () => (await songsOf(page))[0], 'the song was not imported');
    assert(JSON.stringify(song.crop) === JSON.stringify({all: null, pages: {'1': GOOD}}), 'the crop that was kept: ' + JSON.stringify(song.crop));
    assert(song.pages === 2, 'the page count is the real one: ' + song.pages);
    assert(s2.errors.length === 0, 'page errors: ' + s2.errors.join(' | '));
  } finally { await s2.close(); }

  /* a title that is HTML is only ever text, and a lying "pages" is ignored */
  const s3 = await ctx.session();
  try{
    const {page} = s3;
    await s3.goto();
    const evil = '<img src=x onerror="window.__pwned=1">';
    const twice = withSong({song: evil, pages: 99}, {setlist: {name: '<b>set</b>', items: [{type: 'song', id: 's1'}, {type: 'song', id: 's2'}]}});
    twice.songs.push({...twice.songs[0], id: 's2'});              // the same PDF under a second id
    await sendFile(page, named(await zipOf(twice, {'files/s1.pdf': PDF, 'files/s2.pdf': PDF})));
    const text = await confirmText(page);
    assert(text.includes(evil), 'the dialog does not show the title as text: ' + text);
    assert(!(await page.locator('.modal img, .modal b b, .modal li b').count()) && await page.locator('.modal b').textContent() === '<b>set</b>', 'HTML from the package became an element in the dialog (the setlist name must show as the literal text <b>set</b>)');
    await page.click('.modal [data-ok]');
    await waitFor(async () => (await songsOf(page)).length === 1, 'the song was not imported');
    await page.click('#tSets'); await page.click('#tLib'); await sleep(300);
    assert(!(await page.locator('#libList img').count()) && await page.evaluate(() => window.__pwned) === undefined, 'HTML from the package ran or became an element in the library');
    assert((await songsOf(page))[0].pages === 2, 'a lying page count was believed');
    assert((await songsOf(page)).length === 1, 'the same PDF twice in a package became two songs');
    const set = Object.values(await idbAll(page, 'sets')).find(x => !x.deleted);
    assert(set.items.length === 2 && set.items[0].id === set.items[1].id, 'both setlist items must point at the one song: ' + JSON.stringify(set.items));
    assert(s3.errors.length === 0, 'page errors: ' + s3.errors.join(' | '));
  } finally { await s3.close(); }
}

/* ---------- share 4: all or nothing ---------- */
async function fixturePackage(){
  const names = ['one-page.pdf', 'two-page.pdf', 'three-page.pdf'], z = new JSZip(), songs = [];
  names.forEach((f, i) => { const b = fs.readFileSync(path.join(FIX, f)); z.file(`files/s${i + 1}.pdf`, b, {createFolders: false}); songs.push({id: 's' + (i + 1), song: 'Atomic ' + (i + 1), artist: '', version: '', pages: i + 1, hash: sha256(b)}); });
  z.file('share.json', JSON.stringify({app: 'setlist-stand', kind: 'share', version: 1, saved: 'x', songs, setlist: {name: 'Atomic set', items: songs.map(x => ({type: 'song', id: x.id}))}}));
  return named(Buffer.from(await z.generateAsync({type: 'nodebuffer'})));
}
async function bigPackage(n){
  const z = new JSZip(), songs = [];
  for(let i = 0; i < n; i++){
    const d = await PDFDocument.create(); d.addPage([300, 300]).drawText('Song number ' + i, {x: 20, y: 150, size: 18});
    const b = Buffer.from(await d.save({updateMetadata: false}));
    z.file(`files/s${i}.pdf`, b, {createFolders: false}); songs.push({id: 's' + i, song: 'Bulk ' + i, artist: '', version: '', pages: 1, hash: sha256(b)});
  }
  z.file('share.json', JSON.stringify({app: 'setlist-stand', kind: 'share', version: 1, saved: 'x', songs, setlist: {name: 'Bulk set', items: songs.map(x => ({type: 'song', id: x.id}))}}));
  return named(Buffer.from(await z.generateAsync({type: 'nodebuffer'})));
}
async function loopAtomic(ctx){
  /* a full tablet part-way through: nothing is added, the message says so, and a second try works */
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    const before = normalise(await snapshot(page)), pkg = await fixturePackage();
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put; let n = 0;
      window.__restorePut = () => { IDBObjectStore.prototype.put = put; };
      IDBObjectStore.prototype.put = function(...a){ if(this.name === 'files' && ++n >= 2) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); return put.apply(this, a); };
    });
    await sendFile(page, pkg); await confirmText(page); await page.click('.modal [data-ok]');
    const text = await refusal(page, 'Nothing was added');
    assert(/tablet is full/.test(text) && /Nothing was changed/.test(text), 'full-tablet message: ' + text);
    const after = normalise(await snapshot(page));
    assert(!diff(before, after).length, 'a failed import left something behind: ' + diff(before, after).join(' | '));
    await page.evaluate(() => window.__restorePut());
    await sendFile(page, pkg); await confirmText(page); await clearToast(page); await page.click('.modal [data-ok]');
    await waitToast(page, /Added 3 songs/);
    assert((await songsOf(page)).length === 3 && Object.keys(await idbAll(page, 'files')).length === 3, 'the second try did not add the three songs');
  } finally { await s.close(); }

  /* ids are unique even when uid() repeats (it can, in the tight loop of a big package): no song may overwrite another */
  const u = await ctx.session();
  try{
    const {page} = u;
    await u.goto();
    const pkg = await fixturePackage();
    /* a setlist the library already has, whose id is exactly what uid() will return below */
    await page.evaluate(async () => {
      const st = await import('./js/store.js'), id = (1700000000000).toString(36) + (0.123456789).toString(36).slice(2, 7);
      await st.saveSet({id, name: 'My real gig', created: 1, items: []}); await st.load();
    });
    await page.evaluate(() => { Date.now = () => 1700000000000; Math.random = () => 0.123456789; });     // every uid() is now the same
    await sendFile(page, pkg); await confirmText(page); await clearToast(page); await page.click('.modal [data-ok]');
    await waitToast(page, /Added 3 songs/);
    const songs = await songsOf(page), files = Object.keys(await idbAll(page, 'files')), allSets = Object.values(await idbAll(page, 'sets')).filter(x => !x.deleted), set = allSets.find(x => x.name === 'Atomic set');
    assert(allSets.length === 2 && allSets.some(x => x.name === 'My real gig' && !x.items.length), 'the import overwrote or lost a setlist that was already there: ' + JSON.stringify(allSets.map(x => [x.name, x.items.length])));
    assert(songs.length === 3 && new Set(songs.map(x => x.id)).size === 3 && files.length === 3, `colliding ids lost songs: ${songs.length} songs, ${new Set(songs.map(x => x.id)).size} ids, ${files.length} PDFs`);
    assert(set && new Set(set.items.map(x => x.id)).size === 3, 'the setlist items do not point at three different songs: ' + JSON.stringify(set && set.items));
  } finally { await u.close(); }

  /* a reload at several moments right after Add: before or after, never in between */
  const big = await bigPackage(40), outcomes = [];
  for(const delay of [0, 15, 60, 200]){
    const t = await ctx.session();
    try{
      const {page} = t;
      await t.goto();
      await sendFile(page, big); await confirmText(page);
      await page.click('.modal [data-ok]');
      await sleep(delay);
      await page.reload({waitUntil: 'load', timeout: 60000}).catch(() => {});
      await page.waitForSelector('#libList, #view', {timeout: 30000});
      await sleep(1200);
      const songs = Object.keys(await idbAll(page, 'songs')).length, files = Object.keys(await idbAll(page, 'files')).length, sets = Object.values(await idbAll(page, 'sets')).filter(x => !x.deleted).length;
      const none = songs === 0 && files === 0 && sets === 0, all = songs === 40 && files === 40 && sets === 1;
      outcomes.push(`${delay}ms: ${none ? 'nothing' : all ? 'complete' : 'PARTIAL'}`);
      assert(none || all, `a reload ${delay}ms after Add left a PARTIAL import: ${songs} songs, ${files} PDFs, ${sets} setlists`);
    } finally { await t.close(); }
  }
  if(ctx.opts.verbose) console.log('  interrupted imports: ' + outcomes.join('; '));
}

/* ---------- share 5: one import at a time ---------- */
async function loopOneAtATime(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    const pkg = await zipOf(base());
    /* a second pick while the first is open is turned away at once; the first carries on to its question */
    /* not awaited outright: an import that was NOT turned away waits for somebody to answer its question, so the test would hang */
    const {second, toast} = await page.evaluate(async bytes => {
      const {importPackage} = await import('./js/shareimport.js');
      const f = new File([new Uint8Array(bytes)], 'package.zip');
      window.__first = importPackage(f);
      const second = await Promise.race([importPackage(f).then(() => 'turned away'), new Promise(r => setTimeout(() => r('went on'), 1500))]);
      return {second, toast: document.querySelector('#toast').textContent};
    }, [...pkg]);
    assert(second === 'turned away' && /An import is still running/.test(toast), `a second import while one is open: ${second}, toast "${toast}"`);
    const text = await confirmText(page);
    assert(/1 new song will be added/.test(text) && /setlist Hostile, as a new setlist/.test(text), 'the first import lost its question: ' + text);
    assert(await page.locator('.modal').count() === 1, 'the second import opened a dialog of its own');
    /* Cancel adds nothing and frees the next import */
    await page.click('.modal [data-x]');
    await page.evaluate(() => window.__first);
    assert((await songsOf(page)).length === 0, 'Cancel added songs');
    await sendFile(page, named(pkg));
    await confirmText(page);
    await page.click('.modal [data-ok]');
    await waitToast(page, /Added 1 song, the setlist Hostile\./);
    assert((await songsOf(page)).length === 1, 'the import after a Cancel did not add the song');
    /* Cancel on the reading box: the Cancel button exists as soon as the import starts, so it is tapped before anything is read.
       The import stops quietly (no notice, no question), adds nothing, and the next one is not turned away. */
    const quiet = await page.evaluate(async bytes => {
      const {importPackage} = await import('./js/shareimport.js');
      const p = importPackage(new File([new Uint8Array(bytes)], 'package.zip'));
      document.querySelector('.modal [data-x]').click();
      await p;
      return {dialogs: document.querySelectorAll('.modal').length, toast: document.querySelector('#toast').textContent};
    }, [...pkg]);
    assert(quiet.dialogs === 0, 'Cancel on the reading box left a dialog (a notice or a question) open');
    assert(!/still running/.test(quiet.toast), 'an import after the cancelled one was turned away');
    assert((await songsOf(page)).length === 1, 'a cancelled import added songs');
    await sendFile(page, named(pkg));
    await confirmText(page);
    await page.click('.modal [data-x]');
    /* the question names the setlist as it will be saved */
    await sendFile(page, named(pkg));
    const again = await confirmText(page);
    assert(/setlist Hostile \(2\), as a new setlist/.test(again), 'the question does not show the new name: ' + again);
    await page.click('.modal [data-x]');
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'share 2: a package imported into another library gives the same songs, details, crops, setlist and PDF bytes; nothing already there changes; one write', run: loopRoundTrip},
  {name: 'share 3: hostile packages are refused with a plain message and change nothing; bad crops are dropped; HTML stays text', run: loopHostile},
  {name: 'share 4: a full tablet or a reload in the middle of an import never leaves half a package', run: loopAtomic},
  {name: 'share 5: one import at a time; Cancel adds nothing and frees the next; the question names the setlist as it will be saved', run: loopOneAtATime},
];

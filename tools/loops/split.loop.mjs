/*
 * Split loops: one songbook PDF becomes separate songs (Library -> Split a songbook).
 *
 * The loop takes what the split PRODUCED (the song PDFs the app stored) and reads them back through an independent path:
 * pdf.js opens each stored PDF and the source book, and the text and rotation of every page are compared page by page;
 * pdf-lib counts the page objects inside each stored file (a song must hold its own pages and nothing the book's links
 * point at); the stored bytes are hashed and compared with the song record. Nothing is mocked.
 *
 * The book is tests/fixtures/songbook.pdf (12 pages, text only): bookmarks Part One [Song One p1, Song Two - Fixture Artist p3,
 * Song Three (in G) p4], Part Two [Song Four p7, Song Five p7, Song Six p10 (named destination)], Index p12; page 4 is rotated
 * 90 degrees; every page links to page 12 and page 12 links to the songs.
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {FIX, TMP, PDFLib, PDFDocument, PDFDict, PDFName, assert, sleep, sha256, idbAll, fileHashes} from './harness.mjs';
import {KINDS, makeVariant, hiddenLayersBook, damagedTreeBook} from './book-variants.mjs';

const BOOK = path.join(FIX, 'songbook.pdf');
/* what the bookmarks should become, written out by hand from how the fixture was built (not read from the app) */
const EXPECT = [
  {on: true, title: 'Song One', from: 1, to: 2, song: 'Song One', artist: '', version: ''},
  {on: true, title: 'Song Two - Fixture Artist', from: 3, to: 3, song: 'Song Two', artist: 'Fixture Artist', version: ''},
  {on: true, title: 'Song Three (in G)', from: 4, to: 6, song: 'Song Three', artist: '', version: 'in G'},
  {on: true, title: 'Song Four', from: 7, to: 7, song: 'Song Four', artist: '', version: ''},
  {on: true, title: 'Song Five', from: 7, to: 9, song: 'Song Five', artist: '', version: ''},
  {on: true, title: 'Song Six', from: 10, to: 11, song: 'Song Six', artist: '', version: ''},
  {on: false, title: 'Index', from: 12, to: 12},
];

async function waitFor(fn, what, ms = 8000){
  const end = Date.now() + ms; let v;
  while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(80); }
  throw new Error(typeof what === 'function' ? await what() : what);
}
const toastText = page => page.locator('#toast').textContent();
const clearToast = page => page.evaluate(() => { document.querySelector('#toast').textContent = ''; });

/* the Split button, then the file chooser it opens (the real wiring), then wait for the screen */
async function openBook(page, file){
  await page.click('#tLib');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-split]')]);
  await fc.setFiles(file);
  await page.waitForSelector('#splitter:not([hidden])', {timeout: 20000});
  await page.waitForFunction(() => document.querySelectorAll('#splitPages .pg').length > 0);
}
const rowsOf = page => page.$$eval('#splitRows .srow', els => els.map(li => ({
  on: li.querySelector('[data-k=on]').checked, title: li.querySelector('[data-k=title]').value,
  from: Number(li.querySelector('[data-k=from]').value), to: Number(li.querySelector('[data-k=to]').value),
  auto: li.querySelector('[data-k=to]').classList.contains('auto')})));
async function goAndWait(page, closes = true){
  await clearToast(page);
  await page.click('#splitGo');
  await page.waitForFunction(() => /\S/.test(document.querySelector('#toast').textContent), null, {timeout: 30000});
  if(closes) await page.waitForFunction(() => document.querySelector('#splitter').hidden, null, {timeout: 10000});
  return toastText(page);
}

/* Add, expecting the "Not all songs were added" dialog: returns its text and closes it. The splitter stays open. */
async function failDialog(page){
  await page.click('#splitGo');
  const dlg = page.locator('.modal [role=dialog]', {hasText: 'Not all songs were added'});
  await dlg.waitFor({timeout: 30000});
  const text = await dlg.textContent();
  await page.click('.modal [data-x]');
  await page.waitForFunction(() => !document.querySelector('.modal'));
  return text;
}

/* ---------- reading the stored songs back ---------- */
const storedB64 = (page, id) => page.evaluate(id => new Promise((res, rej) => {
  const r = indexedDB.open('setlist-stand');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => {
    const q = r.result.transaction('files').objectStore('files').get(id);
    q.onerror = () => rej(q.error);
    q.onsuccess = async () => {
      const b = new Uint8Array(await q.result.arrayBuffer()); let s = '';
      for(let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      r.result.close(); res(btoa(s));
    };
  };
}), id);
/* text and rotation of every page, as pdf.js sees them */
const pagesOf = (page, b64) => page.evaluate(async b64 => {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const doc = await pdfjsLib.getDocument({data: u}).promise, out = [];
  for(let p = 1; p <= doc.numPages; p++){
    const pg = await doc.getPage(p), tc = await pg.getTextContent();
    out.push({text: tc.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim(), rotate: pg.rotate});
  }
  doc.destroy(); return out;
}, b64);
async function pageObjects(bytes){
  const doc = await PDFDocument.load(bytes, {updateMetadata: false});
  return [...doc.context.enumerateIndirectObjects()].filter(([r, o]) => o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of('Page')).length;
}
const songsOf = async page => Object.values(await idbAll(page, 'songs')).filter(s => !s.deleted);

/* every stored song against the book it was cut from: exactly pages from..to, in order, same rotation, nothing extra */
async function checkSongs(page, want, bookB64, what, perPage = 0){
  const book = await pagesOf(page, bookB64), songs = await songsOf(page), hashes = await fileHashes(page);
  for(const w of want){
    const s = songs.find(x => x.song === w.song && x.artist === w.artist && x.version === w.version);
    assert(s, `${what}: no song record ${JSON.stringify([w.song, w.artist, w.version])} in ${JSON.stringify(songs.map(x => x.title))}`);
    assert(s.pages === w.to - w.from + 1, `${what}: "${w.title}" says ${s.pages} pages, expected ${w.to - w.from + 1}`);
    assert(!s.archived && !s.deleted, `${what}: "${w.title}" archived or deleted`);
    const b64 = await storedB64(page, s.id), bytes = Buffer.from(b64, 'base64');
    assert(sha256(bytes) === s.hash && hashes[s.id] === s.hash, `${what}: "${w.title}" hash ${s.hash} != stored bytes ${sha256(bytes)}`);
    const got = await pagesOf(page, b64), exp = book.slice(w.from - 1, w.to);
    assert(JSON.stringify(got) === JSON.stringify(exp), `${what}: "${w.title}" pages differ from book pages ${w.from}-${w.to}:\n  got ${JSON.stringify(got)}\n  exp ${JSON.stringify(exp)}`);
    const objs = await pageObjects(bytes);
    assert(objs === s.pages, `${what}: "${w.title}" holds ${objs} page objects for ${s.pages} pages (links dragged other pages of the book in)`);
    assert(bytes.length < Buffer.from(bookB64, 'base64').length, `${what}: "${w.title}" (${bytes.length} bytes) is not smaller than the whole book`);
    if(perPage) assert(bytes.length < s.pages * perPage + 60000, `${what}: "${w.title}" is ${bytes.length} bytes for ${s.pages} page(s): it carries pictures of other pages (budget ${perPage} per page)`);
  }
}
const bookB64 = () => fs.readFileSync(BOOK).toString('base64');

/* ---------- 1. a book with bookmarks ---------- */
async function loopBookmarks(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await openBook(page, BOOK);
    const rows = await rowsOf(page);
    assert(rows.length === EXPECT.length, `bookmark rows: ${JSON.stringify(rows)}`);
    EXPECT.forEach((e, i) => {
      const r = rows[i];
      assert(r.on === e.on && r.title === e.title && r.from === e.from && r.to === e.to && r.auto, `row ${i}: got ${JSON.stringify(r)}, expected ${JSON.stringify(e)} (to follows the next row)`);
    });
    assert(await page.locator('#splitGo').textContent() === 'Add 6 songs', 'the Add button does not count the ticked songs');
    /* only a bookmark that is wholly "Contents", "Index"... starts unticked: "Cover Me" and "About a Girl" are songs */
    const front = await page.evaluate(async () => {
      const m = await import('./js/songlist.js');
      return m.draftRows(['Cover Me', 'Index', 'About a Girl', 'Table of Contents', 'Contents Under Pressure'].map((title, i) => ({title, page: i + 1}))).map(r => [r.title, r.on]);
    });
    assert(JSON.stringify(front) === JSON.stringify([['Cover Me', true], ['Index', false], ['About a Girl', true], ['Table of Contents', false], ['Contents Under Pressure', true]]), 'which bookmarks start unticked: ' + JSON.stringify(front));
    assert(await page.evaluate(() => document.querySelector('.app').inert), 'the app behind the splitter is not inert');
    /* pictures of the pages are drawn (a JPEG per visible page) */
    await waitFor(() => page.$$eval('#splitPages img:not([hidden])', e => e.length === 12), 'page pictures were not drawn');
    /* start pages are marked, pages inside a ticked song are marked, the unticked Index page is not */
    const marks = await page.$$eval('#splitPages .pg', els => els.map(e => e.classList.contains('start') ? 's' : e.classList.contains('in') ? 'i' : '-').join(''));
    assert(marks === 'sissiisiisi-', `page marks (s = a song starts, i = inside a song): ${marks}`);

    const msg = await goAndWait(page);
    assert(/Added 6 songs/.test(msg), 'toast: ' + msg);
    assert((await songsOf(page)).length === 6, 'song count after the split');
    assert(Object.keys(await idbAll(page, 'files')).length === 6, 'the files store holds more than the six songs (the book itself must not be saved)');
    await checkSongs(page, EXPECT.filter(e => e.on), bookB64(), 'bookmarked book');

    /* the same book again: every song is already here (same bytes, same hash), so all are skipped.
       Waits past a second first: a PDF that carried a creation date would then differ, and must not. */
    await sleep(1100);
    await openBook(page, BOOK);
    const again = await goAndWait(page);
    assert(/Skipped 6 already in your library/.test(again) && !/Added/.test(again), 'second split: ' + again);
    assert((await songsOf(page)).length === 6, 'a second split added songs that were already there');
    /* ...unless "add again" is ticked */
    await openBook(page, BOOK);
    await page.check('#splitAgain');
    const third = await goAndWait(page);
    assert(/Added 6 songs/.test(third), 'add again: ' + third);
    assert((await songsOf(page)).length === 12, 'add again did not add');

    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    const outside = s.requests.filter(u => !u.startsWith(s.base) && !/^(blob|data):/.test(u));
    assert(!outside.length, 'requests outside the app: ' + outside.join(', '));
  } finally { await s.close(); }
}

/* ---------- 2. a book with no bookmarks: tap the pages, edit the ranges ---------- */
async function plainBook(){
  const src = await PDFDocument.load(fs.readFileSync(BOOK)), out = await PDFDocument.create();
  for(const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
  return Buffer.from(await out.save());
}
async function loopTapping(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    const buffer = await plainBook();
    await page.click('#tLib');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-split]')]);
    await fc.setFiles({name: 'plain book.pdf', mimeType: 'application/pdf', buffer});
    await page.waitForSelector('#splitter:not([hidden])', {timeout: 20000});
    await page.waitForFunction(() => document.querySelectorAll('#splitPages .pg').length === 12);
    assert(/no bookmarks/i.test(await page.locator('#splitHint').textContent()), 'hint for a book without bookmarks: ' + await page.locator('#splitHint').textContent());
    assert((await rowsOf(page)).length === 0 && await page.locator('#splitGo').isDisabled(), 'rows or an enabled Add button before anything was marked');

    /* tap page 2: a song starts there, and its title box has the focus */
    await page.click('#splitPages .pg[data-p="2"]');
    assert(await page.evaluate(() => document.activeElement.dataset.k === 'title'), 'tapping a page does not focus the new song\'s title');
    await page.keyboard.type('First Tune');
    await page.click('#splitPages .pg[data-p="5"]');
    await page.keyboard.type('Second Tune - Some Artist');
    await page.click('#splitPages .pg[data-p="8"]');
    await page.keyboard.type('Blues in F');                // typed titles are taken as typed: not turned into "Blues (in F)"
    let rows = await rowsOf(page);
    assert(JSON.stringify(rows.map(r => [r.title, r.from, r.to, r.auto])) === JSON.stringify([['First Tune', 2, 4, true], ['Second Tune - Some Artist', 5, 7, true], ['Blues in F', 8, 12, true]]), 'after three taps: ' + JSON.stringify(rows));
    await page.click('#splitPages .pg[data-p="5"]');       // a page where a song starts does not add a second row
    assert((await rowsOf(page)).length === 3, 'tapping a start page added a row');
    assert(await page.locator('#splitPages .pg[data-p="2"] .nm').textContent() === 'First Tune', 'the page does not show its song title');

    /* a typed last page is kept (and stops following the next row) */
    const first = page.locator('#splitRows .srow').nth(0);
    await first.locator('[data-k=to]').fill('3'); await page.keyboard.press('Tab');
    await waitFor(async () => (await rowsOf(page))[0].to === 3 && !(await rowsOf(page))[0].auto, 'a typed last page was not kept');
    /* a first page moved past a typed last page drags it along, and the box shows it */
    await first.locator('[data-k=from]').fill('4'); await page.keyboard.press('Tab');
    await waitFor(async () => { const r = (await rowsOf(page))[0]; return r.from === 4 && r.to === 4; }, async () => 'the last-page box after the first page moved past it: ' + JSON.stringify(await rowsOf(page)));
    await first.locator('[data-k=from]').fill('2'); await page.keyboard.press('Tab');
    await first.locator('[data-k=to]').fill('3'); await page.keyboard.press('Tab');
    await waitFor(async () => { const r = (await rowsOf(page))[0]; return r.from === 2 && r.to === 3; }, 'putting the first row back to 2-3');
    /* a first page moved before the other row puts the rows back in page order */
    const second = page.locator('#splitRows .srow').nth(1);
    await second.locator('[data-k=from]').fill('1'); await page.keyboard.press('Tab');
    await waitFor(async () => (await rowsOf(page))[0].title.startsWith('Second'), 'rows were not put back in page order');
    rows = await rowsOf(page);
    assert(rows[0].from === 1 && rows[0].to === 1 && rows[1].from === 2 && rows[1].to === 3, 'ranges after the move: ' + JSON.stringify(rows));
    await page.locator('#splitRows .srow').nth(0).locator('[data-k=from]').fill('5'); await page.keyboard.press('Tab');
    await waitFor(async () => (await rowsOf(page))[0].title.startsWith('First'), 'rows were not put back in page order (2)');

    /* the artist box fills in songs whose title has none */
    await page.fill('#splitArtist', 'Book Artist');
    const msg = await goAndWait(page);
    assert(/Added 3 songs/.test(msg), 'toast: ' + msg);
    await checkSongs(page, [
      {title: 'First Tune', song: 'First Tune', artist: 'Book Artist', version: '', from: 2, to: 3},
      {title: 'Second Tune', song: 'Second Tune', artist: 'Some Artist', version: '', from: 5, to: 7},
      {title: 'Blues in F', song: 'Blues in F', artist: 'Book Artist', version: '', from: 8, to: 12},
    ], buffer.toString('base64'), 'tapped book');

    /* two songs on one page are the same bytes, and both are added (only the library counts as "already here") */
    await page.click('#tLib');
    const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-split]')]);
    await fc2.setFiles({name: 'plain book.pdf', mimeType: 'application/pdf', buffer});
    await page.waitForFunction(() => document.querySelectorAll('#splitPages .pg').length === 12);
    await page.click('#splitPages .pg[data-p="11"]'); await page.keyboard.type('Twin A');
    await page.click('#splitPages .pg[data-p="12"]'); await page.keyboard.type('Twin B');
    await page.locator('#splitRows .srow').nth(1).locator('[data-k=from]').fill('11'); await page.keyboard.press('Tab');
    await page.locator('#splitRows .srow').nth(1).locator('[data-k=to]').fill('11'); await page.keyboard.press('Tab');
    await waitFor(async () => { const r = await rowsOf(page); return r.length === 2 && r[0].from === 11 && r[0].to === 11 && r[1].from === 11 && r[1].to === 11; }, async () => 'twin rows: ' + JSON.stringify(await rowsOf(page)));
    const twins = await goAndWait(page);
    assert(/Added 2 songs/.test(twins) && !/Skipped/.test(twins), 'two songs on one page: ' + twins);
    assert((await songsOf(page)).filter(x => /^Twin /.test(x.song)).length === 2, 'both twins must be in the library');

    /* nothing to add and nothing to lose: Cancel closes at once; after an edit it asks for a second tap */
    await openBook(page, BOOK);
    await page.click('#splitCancel');
    await page.waitForFunction(() => document.querySelector('#splitter').hidden);
    assert(!(await page.evaluate(() => document.querySelector('.app').inert)), 'the app is still inert after Cancel');
    await openBook(page, BOOK);
    await page.click('#splitNone');
    await page.click('#splitCancel');
    assert(!(await page.evaluate(() => document.querySelector('#splitter').hidden)), 'Cancel threw away an edited list on the first tap');
    assert(/Discard/.test(await page.locator('#splitCancel').textContent()), 'Cancel does not ask for a second tap');
    await page.click('#splitCancel');
    await page.waitForFunction(() => document.querySelector('#splitter').hidden);
    assert((await songsOf(page)).length === 5, 'Cancel changed the library');
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- 3. a PDF that cannot be split is named, and nothing changes ---------- */
function encryptPdf(src, dst, user){
  execFileSync('python3', ['-c', `
import sys
from pypdf import PdfReader, PdfWriter
w = PdfWriter(); w.append(PdfReader(sys.argv[1])); w.encrypt(sys.argv[3], 'owner', algorithm='RC4-128'); w.write(sys.argv[2])`, src, dst, user]);
  assert(fs.readFileSync(dst, 'latin1').includes('/Encrypt'), `${path.basename(dst)} is not encrypted (test setup)`);
  return dst;
}
async function loopRefusals(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    const cases = [
      [encryptPdf(BOOK, path.join(TMP, 'split-protected.pdf'), ''), /protected/],
      [encryptPdf(BOOK, path.join(TMP, 'split-password.pdf'), 'secret'), /password/],
      [{name: 'layers.pdf', mimeType: 'application/pdf', buffer: await hiddenLayersBook('off')}, /hides some of its layers/],
      [{name: 'layers2.pdf', mimeType: 'application/pdf', buffer: await hiddenLayersBook('basestate')}, /hides some of its layers/],
      [{name: 'layers3.pdf', mimeType: 'application/pdf', buffer: await hiddenLayersBook('ocmd')}, /hides some of its layers/],
      [{name: 'layers4.pdf', mimeType: 'application/pdf', buffer: await hiddenLayersBook('ocmddirect')}, /hides some of its layers/],
      [{name: 'count.pdf', mimeType: 'application/pdf', buffer: await damagedTreeBook('count')}, /built in a way/],
      [{name: 'junkkid.pdf', mimeType: 'application/pdf', buffer: await damagedTreeBook('junkkid')}, /built in a way/],
      [{name: 'not a pdf.pdf', mimeType: 'application/pdf', buffer: Buffer.from('this is not a pdf at all')}, /could not be read/],
    ];
    for(const [file, re] of cases){
      await page.click('#tLib');
      const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-split]')]);
      await fc.setFiles(file);
      const dlg = page.locator('.modal [role=dialog]', {hasText: "Can't split this PDF"});
      await dlg.waitFor({timeout: 20000});
      const text = await dlg.textContent();
      assert(/Can't split this PDF/.test(text) && re.test(text), `${re}: dialog says "${text}"`);
      assert(await page.evaluate(() => document.querySelector('#splitter').hidden), 'the splitter opened for a PDF that cannot be split');
      await page.click('.modal [data-x]');
      await page.waitForFunction(() => !document.querySelector('.modal'));
      assert((await songsOf(page)).length === 0 && !Object.keys(await idbAll(page, 'files')).length, 'a refused PDF changed the library');
    }
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- 4. a save that fails part-way: whole songs only, and the message says how many were not added ---------- */
async function failFilesFrom(page, n){
  /* the n-th save of a PDF (and every one after it) fails the way a full tablet does */
  await page.evaluate(n => {
    const put = IDBObjectStore.prototype.put; let count = 0;
    window.__restorePut = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function(...a){
      if(this.name === 'files' && ++count >= n) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return put.apply(this, a);
    };
  }, n);
}
async function loopFailure(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await openBook(page, BOOK);
    /* the very first save fails: nothing is added, the list stays (all still ticked), the app behind stays inert */
    await failFilesFrom(page, 1);
    const none = await failDialog(page);
    assert(/tablet is full/.test(none) && /6 songs not added/.test(none) && /still ticked/.test(none), 'first save failed: ' + none);
    assert(!(await page.evaluate(() => document.querySelector('#splitter').hidden)), 'the list was thrown away although nothing was added');
    assert(await page.evaluate(() => document.querySelector('.app').inert && !document.querySelector('#splitter').inert), 'inert state after a dialog closed over the splitter');
    assert((await songsOf(page)).length === 0 && !Object.keys(await idbAll(page, 'files')).length, 'a failed save left something behind');
    assert(await page.locator('#splitGo').textContent() === 'Add 6 songs', 'the rows were unticked although none was added');
    await page.evaluate(() => window.__restorePut());
    const ok = await goAndWait(page);
    assert(/Added 6 songs/.test(ok), 'second try: ' + ok);
  } finally { await s.close(); }
  /* the third save fails: two whole songs are there, with their PDFs, and nothing else (a fresh, empty library).
     The screen stays with the other four still ticked, and one more try adds exactly those. */
  const s2 = await ctx.session();
  try{
    const {page} = s2;
    await s2.goto();
    await openBook(page, BOOK);
    await failFilesFrom(page, 3);
    const some = await failDialog(page);
    assert(/Added 2 songs/.test(some) && /tablet is full/.test(some) && /4 songs not added/.test(some), 'third save failed: ' + some);
    const songs = await songsOf(page), files = Object.keys(await idbAll(page, 'files')).sort();
    assert(songs.length === 2 && JSON.stringify(songs.map(x => x.id).sort()) === JSON.stringify(files), `songs ${songs.length}, files ${files.length}: every song needs its PDF and no PDF may be left without its song`);
    assert(songs.map(x => x.song).sort().join() === 'Song One,Song Two', 'the songs saved before the failure: ' + songs.map(x => x.song));
    assert(!(await page.evaluate(() => document.querySelector('#splitter').hidden)), 'the screen closed after a part-way failure, losing the four songs still to add');
    assert(await page.locator('#splitGo').textContent() === 'Add 4 songs', 'the four songs left are not the ticked ones: ' + await page.locator('#splitGo').textContent());
    await page.evaluate(() => window.__restorePut());
    const rest = await goAndWait(page);
    assert(/Added 4 songs/.test(rest), 'the rest: ' + rest);
    assert((await songsOf(page)).length === 6, 'six songs after the second try');
  } finally { await s2.close(); }
}

/* ---------- 5. books whose pages point at other pages ---------- */
/* How many pages of this PDF carry a sticky note. */
async function pagesWithNotes(bytes){
  const doc = await PDFDocument.load(bytes, {updateMetadata: false});
  return doc.getPages().filter(p => { const a = p.node.Annots(); return a && Array.from({length: a.size()}, (_, i) => a.lookupMaybe(i, PDFDict)).some(d => d && String(d.get(PDFName.of('Subtype'))) === '/Text'); }).length;
}
async function loopHostileBooks(ctx){
  for(const kind of KINDS){
    const s = await ctx.session();
    try{
      const {page} = s;
      await s.goto();
      const buffer = await makeVariant(kind);
      await openBook(page, {name: `${kind}.pdf`, mimeType: 'application/pdf', buffer});
      if(kind === 'shared'){
        /* every song carries all twelve pictures: the run stops when the songs written pass its space budget (lowered here:
           the real floor is 150 MB), having added some, and the rest stay ticked */
        await page.evaluate(async () => { (await import('./js/songpdf.js')).limits.floor = 1e6; });
        const text = await failDialog(page), songs = await songsOf(page);
        const stored = Object.values(await idbAll(page, 'files')).reduce((a, f) => a + f.blob, 0);
        assert(/far more space than the book/.test(text) && /still ticked/.test(text), `${kind}: ${text}`);
        assert(songs.length >= 1 && songs.length <= 4, `${kind}: ${songs.length} songs were written before the budget stopped the run`);
        assert(stored <= 3 * buffer.length, `${kind}: ${stored} bytes written for a ${buffer.length} byte book`);
        assert(await page.locator('#splitGo').textContent() === `Add ${6 - songs.length} songs`, `${kind}: ${await page.locator('#splitGo').textContent()}`);
        continue;
      }
      if(kind === 'pagekey'){
        /* nothing can clean this: the song is refused (named), never saved with the rest of the book inside it */
        const text = await failDialog(page);
        assert(/6 songs could not be cut cleanly/.test(text) && /"Song One"/.test(text) && /still ticked/.test(text), `${kind}: ${text}`);
        assert((await songsOf(page)).length === 0 && !Object.keys(await idbAll(page, 'files')).length, `${kind}: a song that holds other pages of the book was saved`);
        assert(await page.locator('#splitGo').textContent() === 'Add 6 songs', `${kind}: the refused songs are not still ticked`);
        continue;
      }
      if(kind === 'onebad'){
        /* one song cannot be cut: it is named, the other five are still added, and only it stays ticked */
        const text = await failDialog(page);
        assert(/Added 5 songs/.test(text) && /1 song could not be cut cleanly/.test(text) && /"Song Three \(in G\)"/.test(text), `${kind}: ${text}`);
        assert((await songsOf(page)).length === 5, `${kind}: ${(await songsOf(page)).length} songs`);
        assert(await page.locator('#splitGo').textContent() === 'Add 1 song', `${kind}: ${await page.locator('#splitGo').textContent()}`);
        await checkSongs(page, EXPECT.filter(e => e.on && e.song !== 'Song Three'), buffer.toString('base64'), `${kind} book`);
        continue;
      }
      const msg = await goAndWait(page);
      assert(/Added 6 songs/.test(msg), `${kind}: ${msg}`);
      await checkSongs(page, EXPECT.filter(e => e.on), buffer.toString('base64'), `${kind} book`);
      if(kind === 'notes'){
        /* a note that points nowhere else is kept: only what points at other pages is taken off it */
        for(const sg of await songsOf(page)){
          const n = await pagesWithNotes(Buffer.from(await storedB64(page, sg.id), 'base64'));
          assert(n === sg.pages, `notes book: "${sg.title}" keeps the note on ${n} of its ${sg.pages} pages`);
        }
      }
      assert(s.errors.length === 0, `${kind}: page errors: ` + s.errors.join(' | '));
    } finally { await s.close(); }
  }
}

/* ---------- 6. cutting songs one after another gives what cutting each alone gives ---------- */
/* No browser: makeSongPdf is plain pdf-lib. The independent path is a freshly opened copy of the book for every song. */
async function loopOneAfterAnother(ctx){
  globalThis.PDFLib = PDFLib;
  /* from the folder under test (ctx.root: a scratch copy when a fault is planted), not from this repo */
  const {makeSongPdf} = await import(pathToFileURL(path.join(ctx.root, 'js', 'songpdf.js')).href);
  const open = async kind => PDFDocument.load(await makeVariant(kind), {updateMetadata: false});
  const alone = async (kind, from, to) => Buffer.from((await makeSongPdf(await open(kind), from, to)).bytes);
  const notes = async bytes => pagesWithNotes(bytes);

  /* a song that has to drop its notes (page 4's extra note points on) must not take them from the book:
     the next song that shares page 3 keeps its note, and gets the same bytes as when cut alone */
  const book = await open('mixed');
  const a = await makeSongPdf(book, 3, 4), b = await makeSongPdf(book, 3, 3);
  assert(await notes(Buffer.from(b.bytes)) === 1, 'the song cut after a retry lost its note: the book was changed by the retry');
  assert((await alone('mixed', 3, 3)).equals(Buffer.from(b.bytes)), 'the same pages gave different bytes after another song was cut');
  assert(a.pages === 2, 'the song that had to drop its notes');
  /* the other order gives the same bytes too */
  const book2 = await open('mixed');
  const b2 = await makeSongPdf(book2, 3, 3), a2 = await makeSongPdf(book2, 3, 4);
  assert(Buffer.from(b2.bytes).equals(Buffer.from(b.bytes)) && Buffer.from(a2.bytes).equals(Buffer.from(a.bytes)), 'the order the songs are cut in changed their bytes');

  /* a damaged /Annots (a number, a stream, a number for the whole array) never stops a cut */
  const junk = await open('junk');
  for(const [from, to] of [[3, 3], [4, 4], [3, 4]]){
    let r; try{ r = await makeSongPdf(junk, from, to); }catch(e){ throw new Error(`damaged annotations stopped the cut of pages ${from}-${to}: ${e.message}`); }
    assert(r.pages === to - from + 1, `damaged annotations: pages ${from}-${to} gave ${r.pages} pages`);
  }
  assert(await notes(Buffer.from((await makeSongPdf(junk, 3, 3)).bytes)) === 1, 'the one good note among damaged entries was lost');

  /* one list of pictures for every page: every song carries all of them. Nothing is taken out of a page, and a song that
     does not fit the run's room is stopped before it is saved */
  const shared = await open('shared'), bookBytes = (await shared.save()).length;
  assert(bookBytes > 2e6, 'test setup: the shared-pictures book is only ' + bookBytes + ' bytes');
  let err = null; try{ await makeSongPdf(shared, 5, 5, 1e6); }catch(e){ err = e; }
  assert(err && err.space && !err.cut, 'a song heavier than the room was not stopped (' + (err ? err.message : 'no error') + ')');
  const whole = await makeSongPdf(shared, 5, 5);
  assert(whole.pages === 1 && whole.bytes.length > 2e6, 'with room the song must still be cut, whole: ' + whole.bytes.length);
  const kept = shared.getPage(4).node.Resources().lookup(PDFName.of('XObject'), PDFDict).keys().length;
  assert(kept === 12, `a cut took pictures out of the page's resources: ${kept} of 12 are left`);
  /* the budget: the larger of 150 MB and three times the book */
  const {budgetFor, limits} = await import(pathToFileURL(path.join(ctx.root, 'js', 'songpdf.js')).href);
  assert(budgetFor(2.4e6) === limits.floor && budgetFor(100e6) === 300e6, `budget ${budgetFor(2.4e6)} / ${budgetFor(100e6)}`);
  /* a normal song, with or without a room, is never stopped */
  assert((await makeSongPdf(await open('notes'), 1, 6, 1e6)).pages === 6, 'a normal song was stopped for its weight');
}

export const loops = [
  {name: 'split 1: songs cut from a bookmarked songbook hold exactly the book\'s pages and nothing else; a second split is all duplicates', run: loopBookmarks},
  {name: 'split 2: a songbook without bookmarks is marked by tapping pages; typed ranges, order and artist are what is saved', run: loopTapping},
  {name: 'split 3: a protected, password-locked or unreadable PDF is named and nothing changes', run: loopRefusals},
  {name: 'split 4: a save that fails part-way leaves whole songs only, says how many were not added, and keeps the rest ticked', run: loopFailure},
  {name: 'split 5: a book whose pages point at other pages (notes, form fields, article threads, buttons, private keys) gives songs holding only their own pages', run: loopHostileBooks},
  {name: 'split 6: songs cut one after another equal songs cut alone; damaged annotations never stop a cut; a book that makes every song as heavy as the whole book is stopped by the space budget, never edited', run: loopOneAfterAnother},
];

/*
 * Import chart updates (Library -> Share / Import -> Import chart updates; js/chartupdate.js, js/chartfile.js, js/newversion.js).
 *
 * chart update 1  the closed loop. A library with marks, crops, a collection, two setlists and an archived song is backed up;
 *                 tools/make-chart-update.mjs builds a file from that backup and new PDFs (one per kind of row); the app imports it
 *                 through the real buttons. The library read back from IndexedDB is compared with a model written here: every song
 *                 updated keeps its id, details, setlist places and collections and plays the new bytes; one archived copy per
 *                 update holds the old bytes, marks, crop and dated version; the new song is there; nothing else changed. The same
 *                 again after a reload and after Back up -> wipe -> Restore. The maker tool's own lines are checked too.
 * chart update 2  hostile files (built in Node): each is refused with a plain sentence and changes nothing; a share package and a
 *                 chart update file are each named in the other's importer.
 * chart update 3  all or nothing and one at a time: Cancel writes nothing, an unticked song is left alone, a write that fails part-way
 *                 changes nothing, a song edited in another tab while the list is open is skipped and listed (the rest applied), the
 *                 batch is ONE write, a second pick while one is open is turned away.
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {ROOT, TMP, JSZip, PDFDocument, assert, sleep, sha256, idbAll, snapshot, normalise, diff, backupNow, restoreZip, wipe} from './harness.mjs';

const MAKER = path.join(ROOT, 'tools', 'make-chart-update.mjs');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const days = () => [today(), (() => { const d = new Date(Date.now() + 36e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })()];
const FULL = 'The tablet is full. Free up some space, then try again. Nothing was changed.';

/* a valid PDF of `n` pages that no other tag makes */
async function pdf(tag, n = 1){
  const d = await PDFDocument.create();
  for(let i = 1; i <= n; i++) d.addPage([300, 300]).drawText(`${tag} page ${i}`, {x: 20, y: 150, size: 18});
  return Buffer.from(await d.save({updateMetadata: false}));
}
const named = (name, buffer, mimeType = 'application/pdf') => ({name, mimeType, buffer});
const zipFile = buf => ({name: 'chart-updates.zip', mimeType: 'application/zip', buffer: buf});

/* The library: songs from file names (so details come from the names), then marks, a crop, a collection, two setlists, one song archived. */
const OLD = {};
async function oldPdfs(){
  if(OLD.alpha) return OLD;
  Object.assign(OLD, {alpha: await pdf('Alpha old', 1), bravo: await pdf('Bravo old', 2), charlie: await pdf('Charlie old', 3), delta: await pdf('Delta old', 1), echo: await pdf('Echo old', 1), foxtrot: await pdf('Foxtrot old', 1)});
  return OLD;
}
const NAMES = {alpha: 'Alpha (in G) - Band.pdf', bravo: 'Bravo - Band.pdf', charlie: 'Charlie - Band.pdf', delta: 'Delta - Band.pdf', echo: 'Echo - Band.pdf', foxtrot: 'Foxtrot - Band.pdf'};
const CROP = {x: .1, y: .15, w: .8, h: .7};
const pen = (id, y) => ({id, t: 'pen', c: '#1a1a1a', w: .003, p: [[.2, y], [.4, y + .1], [.6, y + .2]], updated: 1700000000000});
const note = id => ({id, t: 'text', x: .3, y: .5, text: 'capo on 3', size: .018, c: '#d62828', updated: 1700000000001});

async function buildLibrary(page){
  const o = await oldPdfs();
  await page.click('#tLib');
  await page.setInputFiles('#file', Object.keys(NAMES).map(k => named(NAMES[k], o[k])));
  await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, 6, {timeout: 30000});
  await page.evaluate(async ({CROP, pens, notes}) => {
    const st = await import('./js/store.js'), {uid} = await import('./js/util.js');
    const by = t => st.state.songs.find(s => s.title.startsWith(t));
    const [a, b, c, d, e, f] = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'].map(by);
    await st.put('colls', 'k1', {id: 'k1', name: 'Band', created: 1700000000000, updated: 1700000000000});
    Object.assign(a, {crop: {all: CROP, pages: {}}, colls: ['k1'], future: {kept: 'a field this code does not know'}}); await st.saveSong(a);
    d.future = 'kept too'; await st.saveSong(d);
    f.archived = true; await st.saveSong(f);
    await st.putInk(a.id, 1, [pens[0], notes[0]]);
    await st.putInk(b.id, 1, [pens[1]]); await st.putInk(b.id, 2, [pens[2]]);
    await st.saveSet({id: uid(), name: 'Gig 1', created: Date.now(), colls: [], items: [{type: 'song', id: a.id}, {type: 'song', id: b.id}, {type: 'song', id: a.id}]});
    await st.saveSet({id: uid(), name: 'Gig 2', created: Date.now(), colls: ['k1'], items: [{type: 'song', id: d.id}, {type: 'break', id: uid(), name: 'Set 2'}, {type: 'song', id: a.id}, {type: 'song', id: f.id}, {type: 'song', id: c.id}]});
    await st.load();
  }, {CROP, pens: [pen('pa1', .2), pen('pb1', .3), pen('pb2', .4)], notes: [note('na1')]});
  await page.reload(); await page.waitForSelector('#libList [data-open]');
}

const waitFor = async (fn, what, ms = 15000) => { const end = Date.now() + ms; let v; while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(80); } throw new Error(typeof what === 'function' ? await what() : what); };
const noModal = page => page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 15000});
const sendFile = async (page, payload) => { await page.click('#tLib'); await page.setInputFiles('#chartUpdateFile', payload); };
const dialog = (page, title, ms = 60000) => { const d = page.locator('.modal [role=dialog]', {hasText: title}); return d.waitFor({timeout: ms}).then(() => d); };
async function refusal(page){
  const d = await dialog(page, "Can't import that file"), text = (await d.textContent()).replace(/\s+/g, ' ').trim();
  await page.click('.modal [data-x]'); await noModal(page);
  return text;
}
/* the review screen as a person sees it: one entry per row */
async function rowsOf(page){
  await page.locator('.modal .cu-list .cu-row').first().waitFor({timeout: 60000});
  return page.evaluate(() => [...document.querySelectorAll('.modal .cu-row')].map(r => ({text: r.textContent.replace(/\s+/g, ' ').trim(), box: r.querySelector('input') ? r.querySelector('input').checked : null})));
}
const applyLabel = page => page.locator('.modal [data-ok]').textContent();
async function result(page){
  const d = page.locator('.modal [role=dialog]').filter({has: page.locator('button.pri[data-x]')});      // the result box (the waiting box has Stop, not OK)
  await d.waitFor({timeout: 60000});
  const text = (await d.textContent()).replace(/\s+/g, ' ').trim();
  await page.click('.modal [data-x]'); await noModal(page);
  return text;
}
const expectSame = (a, b, what) => { const d = diff(a, b, '', [], 20); assert(!d.length, `${what}: ${d.length} difference(s):\n    ` + d.join('\n    ')); };

/* a session whose IndexedDB writes are counted, and where one chosen put can throw "disk full" (window.__fail: {store, key}) */
async function session(ctx){
  const s = await ctx.session();
  await s.context.addInitScript(() => {
    window.__tx = [];
    const tx = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
    IDBDatabase.prototype.transaction = function(names, mode, ...rest){
      const t = tx.call(this, names, mode, ...rest);
      if(mode === 'readwrite') window.__tx.push((typeof names === 'string' ? [names] : Array.from(names)).sort().join('+'));
      return t;
    };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = (...a) => window.__slowHash ? new Promise(r => setTimeout(r, window.__slowHash)).then(() => digest(...a)) : digest(...a);
    IDBObjectStore.prototype.put = function(...a){
      const f = window.__fail;
      if(f && this.name === f.store && String(a[1]) === f.key) throw new DOMException('The disk is full (test)', 'QuotaExceededError');
      return put.apply(this, a);
    };
  });
  await s.goto();
  return s;
}

/* the chart update file for the library `lib` (ids by title), made by the real maker tool from a real backup */
async function makeFile(page, lib, tag){
  const backup = (await backupNow(page)).file;
  const dir = path.join(TMP, 'cu-' + tag + '-' + Date.now()), pdfDir = path.join(dir, 'pdfs');
  fs.mkdirSync(pdfDir, {recursive: true});
  const N = {
    a1: await pdf('Alpha NEW', 2), b1: await pdf('Bravo NEW', 1), f1: await pdf('Foxtrot NEW', 1), g1: await pdf('Golf NEW', 1), a2: await pdf('Alpha SECOND', 1)};
  const o = await oldPdfs();
  const files = [['Alpha (in G) - Band.pdf', N.a1], ['Bravo - Band.pdf', N.b1], ['Charlie - Band.pdf', o.charlie], ['Delta - Band.pdf', o.echo], ['Foxtrot - Band.pdf', N.f1], ['Golf - Band.pdf', N.g1], ['Alpha (in G) - Band (1).pdf', N.a2]];
  const paths = files.map(([n, b]) => { const p = path.join(pdfDir, n); fs.writeFileSync(p, b); return p; });
  /* without --add-new the three that match no song, or a second one for a song, are left out and said so */
  const plain = execFileSync('node', [MAKER, '--backup', backup, '--out', path.join(dir, 'plain.zip'), ...paths], {encoding: 'utf8'});
  for(const n of ['Foxtrot - Band.pdf', 'Golf - Band.pdf', 'Alpha (in G) - Band (1).pdf']) assert(new RegExp('LEFT OUT  ' + n.replace(/[()]/g, '\\$&')).test(plain), 'the maker did not say it left out ' + n + ':\n' + plain);
  assert(/MATCHED   Alpha \(in G\) - Band\.pdf -> Alpha \(in G\) - Band/.test(plain) && /MATCHED   Delta - Band\.pdf -> Delta - Band/.test(plain) && /4 charts, 3 left out/.test(plain), 'the maker lines: ' + plain);
  const out = path.join(dir, 'update.zip');
  const full = execFileSync('node', [MAKER, '--backup', backup, '--out', out, '--add-new', ...paths], {encoding: 'utf8'});
  assert(/Wrote .*: 7 charts\./.test(full), 'the maker with --add-new: ' + full);
  /* the file as the maker wrote it: the PDFs are the files' bytes, the targets are the backup's ids */
  const z = await JSZip.loadAsync(fs.readFileSync(out), {checkCRC32: true});
  const j = JSON.parse(await z.file('update.json').async('string'));
  assert(j.app === 'setlist-stand' && j.kind === 'chart-update' && j.version === 1 && j.charts.length === 7, 'update.json: ' + JSON.stringify(j).slice(0, 300));
  const byName = Object.fromEntries(j.charts.map((c, i) => [files[i][0], c]));
  assert(byName['Alpha (in G) - Band.pdf'].target === lib.Alpha && byName['Delta - Band.pdf'].target === lib.Delta && byName['Charlie - Band.pdf'].target === lib.Charlie, 'targets are the backup ids: ' + JSON.stringify(j.charts.map(c => c.target)));
  for(const [i, [n, b]] of files.entries()){
    const got = Buffer.from(await z.file('files/' + j.charts[i].id + '.pdf').async('uint8array'));
    assert(sha256(got) === sha256(b) && j.charts[i].hash === sha256(b), 'the PDF for ' + n + ' is not the file\'s bytes');
  }
  /* the id of Bravo is "gone" (the name has to find it), Foxtrot's names the ARCHIVED song (never updated) */
  byName['Bravo - Band.pdf'].target = 'gone-1';
  byName['Foxtrot - Band.pdf'].target = lib.Foxtrot;
  z.file('update.json', JSON.stringify(j));
  const file = path.join(dir, 'update-edited.zip');
  fs.writeFileSync(file, await z.generateAsync({type: 'nodebuffer'}));
  return {file, N, o};
}

const idsByTitle = async page => { const m = {}; for(const s of Object.values(await idbAll(page, 'songs'))) if(!s.deleted) m[s.song] = s.id; return m; };

/* ---------- chart update 1: the closed loop ---------- */
async function loopClosed(ctx){
  const s = await session(ctx);
  try{
    const {page} = s;
    await buildLibrary(page);
    const lib = await idsByTitle(page);
    const before = normalise(await snapshot(page));
    const {file, N, o} = await makeFile(page, lib, 'one');
    expectSame(before, normalise(await snapshot(page)), 'making the file changed the library');

    /* the review screen */
    await page.click('[data-sharemenu]');
    const item = page.locator('.modal [data-item="chartupdate"]');
    assert(/Import chart updates/.test(await item.textContent()) && /cleaned-up versions/.test(await item.textContent()), 'the menu item: ' + await item.textContent());
    const labels = await page.locator('.modal [data-item]').allTextContents();
    assert(labels.findIndex(t => /Import chart updates/.test(t)) === labels.findIndex(t => /Import a share package/.test(t)) + 1, 'the item is not right after Import a share package: ' + labels.join(' | '));
    await page.keyboard.press('Escape'); await noModal(page);
    await sendFile(page, file);
    const rows = await rowsOf(page);
    assert(rows.length === 7, `${rows.length} rows, expected 7: ` + JSON.stringify(rows));
    const R = (i, tests) => { for(const [re, want] of tests) assert(re.test(rows[i].text) === want, `row ${i + 1} (${rows[i].text}) ${want ? 'lacks' : 'must not have'} ${re}`); };
    R(0, [[/Alpha \(in G\) - Band/, true], [/Matched by name|also in your library|Not in your library|Already|twice/, false]]);
    assert(rows[0].box === true, 'Alpha (matched by id) is not ticked');
    R(1, [[/Bravo - Band/, true], [/Matched by name/, true]]); assert(rows[1].box === true, 'Bravo (matched by name) is not ticked');
    R(2, [[/Charlie - Band/, true], [/Already up to date/, true]]); assert(rows[2].box === null, 'a song that is already current has a tick box');
    R(3, [[/Delta - Band/, true], [/This PDF is also in your library as Echo - Band/, true]]); assert(rows[3].box === true, 'Delta (its PDF is also Echo\'s) is not ticked');
    R(4, [[/Add as a new song: Foxtrot - Band/, true], [/Not in your library/, true]]); assert(rows[4].box === false, 'a chart for an ARCHIVED song must not be ticked (never updated)');
    R(5, [[/Add as a new song: Golf - Band/, true], [/Not in your library/, true]]); assert(rows[5].box === false, 'a new song starts unticked');
    R(6, [[/Alpha \(in G\) - Band/, true], [/Same song twice in this file/, true]]); assert(rows[6].box === null, 'the second chart for one song has a tick box');
    assert(await applyLabel(page) === 'Apply 3', 'the button says ' + await applyLabel(page));
    await page.locator('.modal .cu-row', {hasText: 'Golf'}).locator('input').check();
    assert(await applyLabel(page) === 'Apply 4', 'after ticking Golf the button says ' + await applyLabel(page));
    assert(!(await page.locator('.modal [data-ok]').isDisabled()), 'Apply is off with 4 ticked');
    await page.evaluate(() => { window.__tx.length = 0; });
    await page.click('.modal [data-ok]');
    const text = await result(page);
    assert(/Updated 3 songs\./.test(text) && /Added 1 new song\./.test(text), 'the result: ' + text);
    assert(/Skipped 2:/.test(text) && /Foxtrot - Band \(not added\)/.test(text) && /same song twice in this file/.test(text), 'the result lists what was skipped: ' + text);
    assert(/1 song already up to date/.test(text), 'the result: ' + text);
    const writes = await page.evaluate(() => window.__tx.slice());
    assert(writes.length === 1, `the batch was ${writes.length} write transactions (${writes.join(' | ')}), expected ONE`);
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));

    /* the model */
    const check = async what => {
      const after = normalise(await snapshot(page)), P = what + ': ';
      const b = before.songs, a = after.songs, hash = buf => sha256(buf);
      /* untouched */
      for(const t of ['Charlie', 'Echo', 'Foxtrot']) expectSame(b[lib[t]], a[lib[t]], P + t + ' was changed');
      /* updated songs: same id and details, the new chart, no crop, a later time */
      const want = {Alpha: [N.a1, 2], Bravo: [N.b1, 1], Delta: [o.echo, 1]};
      const copies = {};
      for(const [t, [buf, pages]] of Object.entries(want)){
        const id = lib[t], {crop: _c, ...rest} = b[id];
        expectSame({...rest, pages, hash: hash(buf), updated: a[id].updated}, a[id], P + t + ' (the song)');
        assert(a[id].updated > b[id].updated, P + t + ' was not stamped');
        assert(after.files[id] === hash(buf), P + t + ' does not hold the new bytes');
        const arch = Object.values(a).filter(x => !(x.id in b) && x.archived && x.song === t);
        assert(arch.length === 1, P + `${arch.length} archived copies of ${t}, expected one`);
        const c = copies[t] = arch[0], oldBuf = o[t.toLowerCase()];
        assert(c.hash === hash(oldBuf) && after.files[c.id] === hash(oldBuf), P + t + "'s archived copy does not hold the old bytes");
        const m = /^(?:in G, )?old (\d{4}-\d\d-\d\d)$/.exec(c.version);
        assert(m && days().includes(m[1]) && (t === 'Alpha') === c.version.startsWith('in G'), P + t + "'s old copy version is " + JSON.stringify(c.version));
        assert(c.artist === 'Band' && c.pages === b[id].pages && JSON.stringify(c.colls) === JSON.stringify(b[id].colls) && JSON.stringify(c.crop) === JSON.stringify(b[id].crop), P + t + "'s old copy details: " + JSON.stringify(c));
      }
      assert(a[lib.Alpha].future && a[lib.Alpha].future.kept === 'a field this code does not know' && a[lib.Delta].future === 'kept too', P + 'a field this code does not know was lost');
      /* marks: the song's start fresh (same ids, now deletion markers; a page the new chart lacks is gone), the old copy keeps the live ones */
      expectSame(['pa1', 'na1'], after.ink[lib.Alpha + ':1'].strokes.map(x => x.id), P + 'Alpha page 1 ids');
      for(const x of after.ink[lib.Alpha + ':1'].strokes) assert(x.deleted === true && Object.keys(x).sort().join() === 'deleted,id,updated', P + 'Alpha still has a live mark: ' + JSON.stringify(x));
      assert(!(lib.Alpha + ':2' in after.ink), P + 'Alpha got a page-2 ink record');
      expectSame(before.ink[lib.Alpha + ':1'].strokes, after.ink[copies.Alpha.id + ':1'].strokes, P + "Alpha's old copy marks");
      assert(after.ink[lib.Bravo + ':1'].strokes.every(x => x.deleted) && !(lib.Bravo + ':2' in after.ink), P + 'Bravo marks: ' + JSON.stringify(Object.keys(after.ink)));
      expectSame(before.ink[lib.Bravo + ':1'].strokes, after.ink[copies.Bravo.id + ':1'].strokes, P + "Bravo's old copy page 1");
      expectSame(before.ink[lib.Bravo + ':2'].strokes, after.ink[copies.Bravo.id + ':2'].strokes, P + "Bravo's old copy page 2");
      /* the new song */
      const golf = Object.values(a).filter(x => !(x.id in b) && x.song === 'Golf');
      assert(golf.length === 1 && !golf[0].archived, P + 'the new song Golf: ' + JSON.stringify(golf));
      expectSame({song: 'Golf', artist: 'Band', version: '', title: 'Golf - Band', archived: false, colls: [], pages: 1, hash: hash(N.g1)}, {song: golf[0].song, artist: golf[0].artist, version: golf[0].version, title: golf[0].title, archived: golf[0].archived, colls: golf[0].colls, pages: golf[0].pages, hash: golf[0].hash}, P + 'Golf');
      assert(after.files[golf[0].id] === hash(N.g1), P + 'Golf has the wrong bytes');
      /* nothing else: no Foxtrot song was added, setlists and collections are the same, and the set of records is exactly the expected one */
      assert(!Object.values(a).some(x => x.song === 'Foxtrot' && !(x.id in b)), P + 'a Foxtrot song was added although it was not ticked');
      expectSame(before.sets, after.sets, P + 'the setlists');
      expectSame(before.colls, after.colls, P + 'the collections');
      assert(Object.keys(a).length === Object.keys(b).length + 4, P + `${Object.keys(a).length} songs, expected ${Object.keys(b).length + 4}`);
      const expectedInk = new Set([...Object.keys(before.ink).filter(k => k !== lib.Bravo + ':2'), copies.Alpha.id + ':1', copies.Bravo.id + ':1', copies.Bravo.id + ':2']);
      expectSame([...expectedInk].sort(), Object.keys(after.ink).sort(), P + 'the set of ink pages');
      return after;
    };
    const first = await check('after the import');
    await page.reload(); await page.waitForSelector('#libList [data-open]');
    await check('after a reload');
    /* a backup round trip */
    const zip = await backupNow(page);
    await wipe(page); await s.goto();
    await restoreZip(page, zip.file);
    expectSame(first, normalise(await snapshot(page)), 'after Back up -> wipe -> Restore');
    await check('after the restore');
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- chart update 2: hostile files ---------- */
const PDF1 = Buffer.from(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'two-page.pdf')));
const goodJson = () => ({app: 'setlist-stand', kind: 'chart-update', version: 1, made: 'x', charts: [{id: 'c1', target: 'whatever', song: 'Hostile Chart', artist: 'Nobody', version: '', hash: sha256(PDF1)}]});
async function zipOf(update, files = {'files/c1.pdf': PDF1}, compression = 'DEFLATE'){
  const z = new JSZip();
  z.file('update.json', typeof update === 'string' ? update : JSON.stringify(update));
  for(const [n, b] of Object.entries(files)) z.file(n, b, {createFolders: false});
  return Buffer.from(await z.generateAsync({type: 'nodebuffer', compression}));
}
const withChart = (over, extra = {}) => { const d = goodJson(); Object.assign(d.charts[0], over); Object.assign(d, extra); return d; };
const endRecord = buf => { const at = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6])); assert(at > 0, 'test setup'); return at; };
async function hugeList(){ const z = new JSZip(); z.file('update.json', JSON.stringify(goodJson())); for(let i = 0; i < 40000; i++) z.file(String(i).padStart(10, '0'), ''); return Buffer.from(await z.generateAsync({type: 'nodebuffer', compression: 'STORE'})); }

async function loopHostile(ctx){
  const REFUSED = [
    ['not our app', async () => zipOf({...goodJson(), app: 'other'}), /not a ChartShark chart update file/],
    ['another kind', async () => zipOf({...goodJson(), kind: 'backup'}), /not a ChartShark chart update file/],
    ['not a zip at all', async () => Buffer.from('hello, this is not a zip'), /not a ChartShark chart update file/],
    ['no update.json', async () => { const z = new JSZip(); z.file('hello.txt', 'hi'); return Buffer.from(await z.generateAsync({type: 'nodebuffer'})); }, /not a ChartShark chart update file/],
    ['update.json that is not JSON', async () => zipOf('{ nope'), /not a ChartShark chart update file/],
    ['a share package', async () => { const z = new JSZip(); z.file('share.json', JSON.stringify({app: 'setlist-stand', kind: 'share', version: 1, songs: [], setlist: null})); return Buffer.from(await z.generateAsync({type: 'nodebuffer'})); }, /share package, not a chart update file\. Use Import a share package/],
    ['a real backup', async () => { const z = new JSZip(); z.file('library.json', JSON.stringify({app: 'setlist-stand', version: 3, songs: [], sets: [], colls: [], ink: {}})); return Buffer.from(await z.generateAsync({type: 'nodebuffer'})); }, /backup, not a chart update file\. Use Restore from backup/],
    ['a newer version', async () => zipOf({...goodJson(), version: 99}), /newer version of ChartShark/],
    ['a version that is not a number', async () => zipOf({...goodJson(), version: 'x'}), /not a ChartShark chart update file/],
    ['an empty file', async () => zipOf({...goodJson(), charts: []}), /file is empty/],
    ['a missing PDF', async () => zipOf(goodJson(), {}), /missing the PDF for "Hostile Chart - Nobody"/],
    ['a hash that does not match', async () => zipOf(withChart({hash: 'f'.repeat(64)})), /damaged \("Hostile Chart - Nobody" does not match\)/],
    ['a hash that is not a hash', async () => zipOf(withChart({hash: 'zzz'})), /can't read .*hash/],
    ['bytes that are not a PDF (hash correct)', async () => { const junk = Buffer.from('this is not a pdf at all'); return zipOf(withChart({hash: sha256(junk)}), {'files/c1.pdf': junk}); }, /not a PDF this app can open/],
    ['an id that climbs out', async () => zipOf(withChart({id: '../x'}), {'files/../x.pdf': PDF1}), /can't read .*chart id/],
    ['an id of 70 characters', async () => zipOf(withChart({id: 'a'.repeat(70)})), /can't read .*chart id/],
    ['a target that climbs out', async () => zipOf(withChart({target: '../../x'})), /can't read .*target/],
    ['a target that is a number', async () => zipOf(withChart({target: 5})), /can't read .*target/],
    ['a repeated id', async () => { const d = goodJson(); d.charts.push({...d.charts[0]}); return zipOf(d); }, /can't read .*twice/],
    ['a title that is not text', async () => zipOf(withChart({song: {a: 1}})), /no usable title/],
    ['a title of 5000 characters', async () => zipOf(withChart({song: 'x'.repeat(5000)})), /no usable title/],
    ['an artist that is not text', async () => zipOf(withChart({artist: ['a']})), /artist that is not short text/],
    ['more charts than the limit', async () => { const d = goodJson(); d.charts = Array.from({length: 3}, (_, i) => ({...d.charts[0], id: 'c' + i})); return zipOf(d, {}); }, /more than 2 charts/],
    ['a small zip that inflates past the cap', async () => zipOf(withChart({hash: 'a'.repeat(64)}), {'files/c1.pdf': Buffer.alloc(30e6)}), /too big/],
    ['a damaged PDF inside (CRC)', async () => { const buf = await zipOf(goodJson(), {'files/c1.pdf': PDF1}, 'STORE'); const at = buf.indexOf(PDF1.subarray(200, 216)); assert(at > 0, 'test setup'); buf[at + 4] ^= 0xff; return buf; }, /damaged/],
    ['update.json with one byte changed (CRC)', async () => { const buf = await zipOf(goodJson(), {'files/c1.pdf': PDF1}, 'STORE'); const at = buf.indexOf('Hostile Chart'); assert(at > 0, 'test setup'); buf[at + 8] = 'X'.charCodeAt(0); return buf; }, /damaged/],
    ['update.json bigger than the cap', async () => zipOf(' '.repeat(2e6) + JSON.stringify({...goodJson(), app: 'other'})), /too big to read/],
    ['a truncated zip', async () => { const buf = await zipOf(goodJson()); return buf.subarray(0, buf.length - 40); }, /not a ChartShark chart update file|damaged/],
    ['a zip64 marker (entry count)', async () => { const buf = await zipOf(goodJson()); buf.writeUInt16LE(0xFFFF, endRecord(buf) + 10); return buf; }, /too many files/],
    ['a zip64 marker (directory size)', async () => { const buf = await zipOf(goodJson()); buf.writeUInt32LE(0xFFFFFFFF, endRecord(buf) + 12); return buf; }, /too many files/],
    ['a zip64 marker (directory offset)', async () => { const buf = await zipOf(goodJson()); buf.writeUInt32LE(0xFFFFFFFF, endRecord(buf) + 16); return buf; }, /too many files/],
    ['bytes after the end record', async () => Buffer.concat([await zipOf(goodJson()), Buffer.alloc(70000)]), /not a ChartShark chart update file/],
    ['a zip with a huge list of files', hugeList, /too many files/],
    ['two PDFs together bigger than the cap', async () => { const a = Buffer.concat([await pdf('big one'), Buffer.alloc(2.5e6)]), b = Buffer.concat([await pdf('big two'), Buffer.alloc(2.5e6)]); const d = goodJson(); d.charts = [{...d.charts[0], id: 'c1', hash: sha256(a)}, {...d.charts[0], id: 'c2', hash: sha256(b)}]; return zipOf(d, {'files/c1.pdf': a, 'files/c2.pdf': b}); }, /too big/],
  ];
  const s = await session(ctx);
  try{
    const {page} = s;
    await buildLibrary(page);
    await page.evaluate(async () => { const l = (await import('./js/shareimport.js')).limits; l.maxPdfBytes = 5e6; l.maxJson = 1e6; l.maxSongs = 2; });
    const baseline = normalise(await snapshot(page));
    for(const [name, make, re] of REFUSED){
      await sendFile(page, zipFile(await make()));
      const text = await refusal(page);
      assert(re.test(text), `${name}: the message is "${text}"`);
      assert(/Nothing was changed\./.test(text), `${name}: the message does not say nothing was changed: ${text}`);
      assert(!/Error|undefined|\[object|TypeError/.test(text), `${name}: a raw error reached the message: ${text}`);
      const now = normalise(await snapshot(page));
      assert(!diff(baseline, now).length, `${name}: the library changed: ${diff(baseline, now).join(' | ')}`);
    }
    /* the other way round: a chart update file given to Import a share package is named, and nothing changes */
    await page.click('#tLib');
    await page.setInputFiles('#shareFile', zipFile(await zipOf(goodJson())));
    const d = await dialog(page, "Can't import that package"), t = await d.textContent();
    assert(/chart update file, not a share package\. Use Import chart updates/.test(t), 'a share import given a chart update file says: ' + t);
    await page.click('.modal [data-x]'); await noModal(page);
    assert(!diff(baseline, normalise(await snapshot(page))).length, 'a share import given a chart update file changed the library');
    /* a title with HTML is only text, on the list and in the result */
    const evil = '<img src=x onerror="window.__pwned=1">';
    const ev = await pdf('evil');
    await sendFile(page, zipFile(await zipOf({...goodJson(), charts: [{id: 'c1', target: 'x', song: evil, artist: '"><b>', version: '', hash: sha256(ev)}]}, {'files/c1.pdf': ev})));
    const rows = await rowsOf(page);
    assert(rows.length === 1 && rows[0].text.includes(evil), 'the list does not show the title as text: ' + JSON.stringify(rows));
    assert(!(await page.locator('.modal img, .modal .cu-row b').count()), 'HTML from the file became an element');
    await page.click('.modal [data-x]'); await noModal(page);
    await sleep(200);
    assert(await page.evaluate(() => window.__pwned) === undefined, 'HTML from the file ran');
    assert(!diff(baseline, normalise(await snapshot(page))).length, 'Cancel on the list changed the library');
    /* a chart whose id and name match nothing, but whose PDF is Echo's: never matched by hash (it is offered as a new song) */
    const o = await oldPdfs();
    await sendFile(page, zipFile(await zipOf({...goodJson(), charts: [{id: 'c1', target: 'gone', song: 'Zulu', artist: 'Band', version: '', hash: sha256(o.echo)}]}, {'files/c1.pdf': o.echo})));
    const hr = await rowsOf(page);
    assert(hr.length === 1 && /Add as a new song: Zulu - Band/.test(hr[0].text) && /also in your library as Echo - Band/.test(hr[0].text) && hr[0].box === false, 'a chart with only Echo\'s PDF: ' + JSON.stringify(hr));
    await page.click('.modal [data-x]'); await noModal(page);
    assert(!diff(baseline, normalise(await snapshot(page))).length, 'Cancel on the hash-only list changed the library');
    /* two songs with one name: the chart is offered as new and says so (never chosen between); a chart matched by id but named
       differently in the file shows the file's name */
    const ids = await page.evaluate(async () => { const st = await import('./js/store.js'); const e = st.state.songs.find(x => x.song === 'Echo');
      const twin = {...st.newSong({song: 'Echo', artist: 'Band', version: ''}, e.pages, e.hash, []), id: 'echotwin'};
      await st.putAll([{store: 'files', key: twin.id, value: await st.get('files', e.id)}, {store: 'songs', key: twin.id, value: twin}]); await st.load();
      return Object.fromEntries(st.state.songs.map(x => [x.song, x.id])); });
    const base2 = normalise(await snapshot(page)), np = await pdf('Echo NEW');
    await sendFile(page, zipFile(await zipOf({...goodJson(), charts: [{id: 'c1', target: 'gone', song: 'Echo', artist: 'Band', version: '', hash: sha256(np)}, {id: 'c2', target: ids.Delta, song: 'Bravo', artist: 'Band', version: '', hash: sha256(np)}]}, {'files/c1.pdf': np, 'files/c2.pdf': np})));
    const ar = await rowsOf(page);
    assert(/Add as a new song: Echo - Band/.test(ar[0].text) && /2 songs in your library have this name/.test(ar[0].text) && ar[0].box === false, 'a name two songs share: ' + JSON.stringify(ar[0]));
    assert(/Delta - Band/.test(ar[1].text) && /In the file: Bravo - Band/.test(ar[1].text) && ar[1].box === true, 'an id match named differently in the file: ' + JSON.stringify(ar[1]));
    await page.click('.modal [data-x]'); await noModal(page);
    /* the same PDF twice under the shared name: only the first can be added */
    await sendFile(page, zipFile(await zipOf({...goodJson(), charts: [{id: 'c1', target: 'g1', song: 'Echo', artist: 'Band', version: '', hash: sha256(np)}, {id: 'c2', target: 'g2', song: 'Echo', artist: 'Band', version: '', hash: sha256(np)}]}, {'files/c1.pdf': np, 'files/c2.pdf': np})));
    const tw = await rowsOf(page);
    assert(tw[0].box === false && tw[1].box === null && /Same PDF twice in this file/.test(tw[1].text), 'the same PDF twice under a shared name: ' + JSON.stringify(tw));
    await page.click('.modal [data-x]'); await noModal(page);
    assert(!diff(base2, normalise(await snapshot(page))).length, 'Cancel changed the library');
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- chart update 3: all or nothing, one at a time ---------- */
async function loopAtomic(ctx){
  const s = await session(ctx);
  try{
    const {page} = s;
    await buildLibrary(page);
    const lib = await idsByTitle(page);
    const {file} = await makeFile(page, lib, 'two');
    const before = normalise(await snapshot(page));
    const same = what => waitFor(async () => !diff(before, normalise(await snapshot(page))).length, async () => what + ': ' + diff(before, normalise(await snapshot(page))).join(' | '), 4000);

    /* Cancel and Escape write nothing */
    await sendFile(page, file); await rowsOf(page);
    await page.click('.modal [data-x]'); await noModal(page); await same('Cancel');
    await sendFile(page, file); await rowsOf(page);
    await page.keyboard.press('Escape'); await noModal(page); await same('Escape');
    /* nothing ticked: Apply is off */
    await sendFile(page, file); await rowsOf(page);
    for(const b of await page.locator('.modal .cu-row input[data-i]').all()) await b.uncheck();
    assert(await applyLabel(page) === 'Apply 0' && await page.locator('.modal [data-ok]').isDisabled(), 'with nothing ticked the button says ' + await applyLabel(page));
    await page.click('.modal [data-x]'); await noModal(page); await same('nothing ticked');

    /* a full tablet part-way: nothing changes (Bravo's PDF is the second one written) */
    await sendFile(page, file); await rowsOf(page);
    await page.evaluate(id => { window.__fail = {store: 'files', key: id}; }, lib.Bravo);
    await page.click('.modal [data-ok]');
    const d = await dialog(page, 'Nothing was changed'); const text = (await d.textContent()).replace(/\s+/g, ' ');
    assert(text.includes(FULL), 'the full-tablet message: ' + text);
    await page.click('.modal [data-x]'); await noModal(page);
    await page.evaluate(() => { window.__fail = null; });
    await same('a write that failed part-way');
    await page.reload(); await page.waitForSelector('#libList [data-open]'); await same('a reload after the failed write');

    /* a song edited in another tab while the list is open: skipped and listed, the rest applied, in ONE write */
    await sendFile(page, file); await rowsOf(page);
    const p2 = await s.context.newPage();
    await p2.goto(s.base + 'index.html'); await p2.waitForSelector('#libList, #view');
    await p2.evaluate(async id => { const st = await import('./js/store.js'); const x = await st.get('songs', id); x.artist = 'Band 2'; await st.saveSong(x); }, lib.Bravo);
    await p2.close();
    await page.evaluate(() => { window.__tx.length = 0; });
    await page.click('.modal [data-ok]');
    const t2 = await result(page);
    assert(/Updated 2 songs\./.test(t2) && /Bravo - Band \(changed while you were looking\)/.test(t2), 'the result when Bravo changed in another tab: ' + t2);
    assert((await page.evaluate(() => window.__tx.slice())).length === 1, 'not one write');
    const after = normalise(await snapshot(page));
    const bravo = Object.values(after.songs).filter(x => x.song === 'Bravo');
    assert(bravo.length === 1 && bravo[0].artist === 'Band 2' && after.files[lib.Bravo] === before.files[lib.Bravo], "Bravo (edited in the other tab) must keep that edit and its chart: " + JSON.stringify(bravo));
    assert(after.files[lib.Alpha] !== before.files[lib.Alpha] && after.files[lib.Delta] !== before.files[lib.Delta], 'the other songs were not updated');
    assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }

  /* one at a time: a second pick while the first list is open is turned away, and the first carries on */
  const s2 = await session(ctx);
  try{
    const {page} = s2;
    await buildLibrary(page);
    const lib = await idsByTitle(page);
    const {file} = await makeFile(page, lib, 'three');
    await sendFile(page, file); await rowsOf(page);
    /* the page behind a dialog is inert, so the file input is driven directly, as a second pick would */
    await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
    await page.setInputFiles('#chartUpdateFile', file);
    await page.waitForFunction(() => /still running/.test(document.querySelector('#toast').textContent), null, {timeout: 10000});
    assert(await page.locator('.modal .cu-row').count() === 7, 'the first list went away');
    await page.click('.modal [data-x]'); await noModal(page);
    /* and a new pick works again after Cancel */
    await sendFile(page, file); assert((await rowsOf(page)).length === 7, 'a pick after Cancel gave no list');
    await page.click('.modal [data-x]'); await noModal(page);

    /* Stop while the file is read: no list, nothing changed */
    const before = normalise(await snapshot(page));
    await page.evaluate(() => { window.__slowHash = 400; document.querySelector('#toast').textContent = ''; });
    await sendFile(page, file);
    await page.locator('.modal [role=dialog]', {hasText: 'Reading'}).waitFor({timeout: 10000});
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => /Stopped\. Nothing was changed/.test(document.querySelector('#toast').textContent), null, {timeout: 15000});
    await noModal(page);
    await page.evaluate(() => { window.__slowHash = 0; });
    assert(!(await page.locator('.cu-list').count()), 'the list opened after Stop');
    expectSame(before, normalise(await snapshot(page)), 'Stop changed the library');

    /* the old charts together over the cap: refused, nothing changed */
    const pre = normalise(await snapshot(page));
    await sendFile(page, file); await rowsOf(page);
    /* the cap sits between the biggest single old chart and the three together: only a sum can refuse it */
    const cap = await page.evaluate(async ids => { const st = await import('./js/store.js'); const sz = []; for(const id of ids) sz.push((await st.get('files', id)).size);
      const c = Math.max(...sz) + 1; (await import('./js/shareimport.js')).limits.maxPdfBytes = c; return {c, sum: sz.reduce((a, b) => a + b, 0)}; }, [lib.Alpha, lib.Bravo, lib.Delta]);
    assert(cap.sum > cap.c, 'test setup: the cap must be below the sum');
    await page.click('.modal [data-ok]');
    const capText = await result(page);
    assert(/Too much to apply at once/.test(capText) && /Nothing was changed/.test(capText), 'the cap: ' + capText);
    await page.evaluate(async () => { (await import('./js/shareimport.js')).limits.maxPdfBytes = 500e6; });
    expectSame(pre, normalise(await snapshot(page)), 'the cap refusal changed the library');

    /* a stroke drawn in another tab while the charts are being got ready: the whole batch is refused, the stroke is kept */
    await sendFile(page, file); await rowsOf(page);
    await page.evaluate(() => { window.__slowHash = 1500; });
    await page.click('.modal [data-ok]');
    await page.locator('.modal [role=dialog]', {hasText: 'chart 2 of'}).waitFor({timeout: 20000});      // Alpha (chart 1) has been read: its page changes after
    const p3 = await s2.context.newPage();
    await p3.goto(s2.base + 'index.html'); await p3.waitForSelector('#libList, #view');
    await p3.evaluate(async id => { const st = await import('./js/store.js'); const r = await st.get('ink', id + ':1'); await st.putInk(id, 1, [...r.strokes, {id: 'late1', t: 'pen', c: '#000000', w: .003, p: [[.1, .1], [.2, .2]], updated: Date.now()}]); }, lib.Alpha);
    await p3.close();
    const late = await dialog(page, 'Nothing was changed', 60000), lt = (await late.textContent()).replace(/\s+/g, ' ');
    assert(/changed while saving/.test(lt), 'a stroke drawn meanwhile: ' + lt);
    await page.click('.modal [data-x]'); await noModal(page);
    await page.evaluate(() => { window.__slowHash = 0; });
    const lateSnap = normalise(await snapshot(page));
    assert(lateSnap.ink[lib.Alpha + ':1'].strokes.some(x => x.id === 'late1' && !x.deleted), 'the stroke drawn meanwhile was lost');
    expectSame(pre.songs, lateSnap.songs, 'a refused batch changed songs'); expectSame(pre.files, lateSnap.files, 'a refused batch changed PDFs');

    /* the same on a BLANK page (no ink record): Delta's page 1, read first, drawn on while Alpha (second) is got ready */
    const blank = normalise(await snapshot(page));
    assert(!blank.ink[lib.Delta + ':1'], 'test setup: Delta page 1 must have no ink record');
    const dNew = await pdf('Delta blank-page test'), aNew = await pdf('Alpha blank-page test');
    await sendFile(page, zipFile(await zipOf({...goodJson(), charts: [{id: 'c1', target: lib.Delta, song: 'Delta', artist: 'Band', version: '', hash: sha256(dNew)}, {id: 'c2', target: lib.Alpha, song: 'Alpha', artist: 'Band', version: 'in G', hash: sha256(aNew)}]}, {'files/c1.pdf': dNew, 'files/c2.pdf': aNew})));
    await rowsOf(page);
    await page.evaluate(() => { window.__slowHash = 1500; });
    await page.click('.modal [data-ok]');
    await page.locator('.modal [role=dialog]', {hasText: 'chart 2 of'}).waitFor({timeout: 20000});
    const p4 = await s2.context.newPage();
    await p4.goto(s2.base + 'index.html'); await p4.waitForSelector('#libList, #view');
    await p4.evaluate(async id => { const st = await import('./js/store.js'); await st.putInk(id, 1, [{id: 'blank1', t: 'pen', c: '#000000', w: .003, p: [[.1, .1], [.2, .2]], updated: Date.now()}]); }, lib.Delta);
    await p4.close();
    const bl = await dialog(page, 'Nothing was changed', 60000), blt = (await bl.textContent()).replace(/\s+/g, ' ');
    assert(/changed while saving/.test(blt), 'a stroke drawn meanwhile on a blank page: ' + blt);
    await page.click('.modal [data-x]'); await noModal(page);
    await page.evaluate(() => { window.__slowHash = 0; });
    const blankAfter = normalise(await snapshot(page));
    assert(blankAfter.ink[lib.Delta + ':1'] && blankAfter.ink[lib.Delta + ':1'].strokes.some(x => x.id === 'blank1' && !x.deleted), 'the stroke drawn on a blank page was lost');
    expectSame(blank.songs, blankAfter.songs, 'a refused batch changed songs (blank page)'); expectSame(blank.files, blankAfter.files, 'a refused batch changed PDFs (blank page)');

    /* a song whose PDF is not on this tablet: the list says its marks are cleared and nothing goes to Archived; it takes the new chart */
    await page.evaluate(async id => { const st = await import('./js/store.js'); await st.del('files', id); }, lib.Bravo);
    const noPdf = normalise(await snapshot(page));
    await sendFile(page, file);
    const rows = await rowsOf(page);
    assert(/not on this tablet: its marks are cleared and nothing goes to Archived/.test(rows[1].text) && !/not on this tablet/.test(rows[0].text), 'the row for Bravo (no stored PDF): ' + JSON.stringify(rows.slice(0, 2)));
    for(const b of await page.locator('.modal .cu-row input[data-i]').all()) await b.uncheck();
    await page.locator('.modal .cu-row', {hasText: 'Bravo'}).locator('input').check();
    await page.click('.modal [data-ok]');
    const t3 = await result(page);
    assert(/Updated 1 song\./.test(t3), 'the result for Bravo with no PDF: ' + t3);
    const after = normalise(await snapshot(page));
    assert(after.files[lib.Bravo] && after.files[lib.Bravo] !== noPdf.songs[lib.Bravo].hash && after.songs[lib.Bravo].hash === after.files[lib.Bravo], 'Bravo does not hold the new chart');
    assert(Object.keys(after.songs).length === Object.keys(noPdf.songs).length, 'an archived copy was made with no PDF to keep');
    assert(after.ink[lib.Bravo + ':1'].strokes.every(x => x.deleted), "Bravo's marks were not cleared");
    assert(s2.errors.length === 0, 'page errors: ' + s2.errors.join(' | '));
  } finally { await s2.close(); }
}

export const loops = [
  {name: 'chart update 1: a file made by the maker tool from a backup is applied as New version to each song; the library matches a hand-written model, after a reload and a backup round trip', run: loopClosed},
  {name: 'chart update 2: hostile files are refused with a plain sentence and change nothing; a share package and a chart update file are named in each other\'s importer', run: loopHostile},
  {name: 'chart update 3: Cancel and a failed write change nothing; a song edited in another tab is skipped and listed; the batch is one write', run: loopAtomic},
];

/*
 * New version (newVersion() in js/library.js): the song keeps its id, so every setlist plays the new chart; the old chart,
 * with its marks and its crop, is kept as ONE new archived song. Closed loop: what the action stored is read back from
 * IndexedDB (every record, and the SHA-256 of every stored PDF computed from its bytes), compared with what went in, and
 * again after a reload and after Back up -> wipe -> Restore; the viewer opens the old copy with its marks and crop.
 * Writes that fail part-way, the duplicate question, Cancel, and deleting either copy later are checked against the same
 * snapshot: nothing else may change.
 */
import fs from 'node:fs';
import path from 'node:path';
import {FIX, assert, sleep, sha256, idbAll, snapshot, diff, backupNow, restoreZip, wipe} from './harness.mjs';

const H = Object.fromEntries(['one-page.pdf', 'two-page.pdf', 'three-page.pdf'].map(f => [f, sha256(fs.readFileSync(path.join(FIX, f)))]));
const FULL = 'The tablet is full. Free up some space, then try again. Nothing was changed.';
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const clearToast = page => page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
async function waitToast(page, re, ms = 20000){
  await page.waitForFunction(src => new RegExp(src).test(document.querySelector('#toast').textContent), re.source, {timeout: ms})
    .catch(async () => { throw new Error(`toast ${re} did not show; toast is "${await page.locator('#toast').textContent()}"`); });
  return page.locator('#toast').textContent();
}
function expectSame(a, b, what){
  const d = diff(a, b, '', [], 20);
  assert(!d.length, `${what}: ${d.length} difference(s):\n    ` + d.join('\n    '));
}
/* Runs fn(S, arg) in the page with S = the app's own store.js (same URL, so the same module instance the app uses). */
const inStore = (page, fn, arg) => page.evaluate(`(async () => {
  const S = await import(new URL('js/store.js', location.href).href);
  return (${fn.toString()})(S, ${JSON.stringify(arg === undefined ? null : arg)});
})()`);

/* A session that counts every readwrite transaction and can make one chosen put throw "disk full" (window.__fail:
   {store, key} fails that record; {store, notPrefix} fails the first put into `store` whose key does not start with it).
   window.__failRead = true makes the next read of a stored PDF (a Blob that is not a picked File) fail once, as a storage
   hiccup or too little memory would. */
async function session(ctx){
  const s = await ctx.session();
  await s.context.addInitScript(() => {
    window.__tx = [];
    const ab = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function(){
      if(window.__failRead && !(this instanceof File)){ window.__failRead = false; return Promise.reject(new DOMException('The file could not be read (test)', 'NotReadableError')); }
      return ab.call(this);
    };
    const tx = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
    IDBDatabase.prototype.transaction = function(names, mode, ...rest){
      const t = tx.call(this, names, mode, ...rest);
      if(mode === 'readwrite') window.__tx.push((typeof names === 'string' ? [names] : Array.from(names)).sort().join('+'));
      return t;
    };
    IDBObjectStore.prototype.put = function(...a){
      const f = window.__fail, k = String(a[1]);
      if(f && this.name === f.store && (f.key != null ? k === f.key : !k.startsWith(f.notPrefix))) throw new DOMException('The disk is full (test)', 'QuotaExceededError');
      return put.apply(this, a);
    };
  });
  await s.goto();
  return s;
}
const writes = page => page.evaluate(() => window.__tx.slice());
const resetWrites = page => page.evaluate(() => { window.__tx.length = 0; });

async function addPdfs(page, files){
  await page.click('#tLib');
  const n0 = await page.locator('#libList [data-open]').count();
  await page.setInputFiles('#file', files.map(f => path.join(FIX, f)));
  await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, n0 + files.length, {timeout: 15000});
  const songs = Object.values(await idbAll(page, 'songs'));
  return files.map(f => songs.find(x => x.hash === H[f]).id);
}
/* Taps New version on a library row and picks `file`; resolves when the duplicate question or the confirm is up. */
async function pickNewVersion(page, id, file){
  await page.click('#tLib');
  await clearToast(page);
  const b = page.locator(`#libList [data-newversion="${id}"]`);
  assert(await b.textContent() === 'New version', `the library button says "${await b.textContent()}"`);
  await b.click();
  assert(await b.textContent() === 'New version', `one tap on New version changed the button to "${await b.textContent()}" (there is no two-tap confirm: the question after the pick is the check)`);
  await page.setInputFiles('#newVersionFile', path.join(FIX, file));
  await page.waitForFunction(() => !!document.querySelector('.modal.dupask, .modal.nvask'), null, {timeout: 15000})
    .catch(async () => { throw new Error('no question after picking ' + file + '; toast "' + await page.locator('#toast').textContent() + '"'); });
}
const question = async page => (await page.locator('.modal.nvask .box p').textContent()).replace(/\s+/g, ' ').trim();
const noModal = page => page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000});

/* Everything New version of song A (from `file`) must have changed in `after`, and nothing else; returns the old copy's id. */
function checkNewVersion(before, after, A, file, days, what){
  const P = what + ': ';
  const fresh = Object.keys(after.songs).filter(k => !(k in before.songs));
  assert(fresh.length === 1, P + `${fresh.length} new song records, expected exactly one (the old copy): ` + fresh.join(', '));
  const O = fresh[0], a0 = before.songs[A], a1 = after.songs[A], o = after.songs[O];
  /* the song: same id, details, crop and archive flag; the new chart's pages and hash; the PDF is the file's bytes */
  expectSame({...a0, pages: a1.pages, hash: H[file], updated: a1.updated}, a1, P + 'the song');
  assert(a1.updated > a0.updated && a1.pages === {'one-page.pdf': 1, 'two-page.pdf': 2, 'three-page.pdf': 3}[file], P + `the song's pages/updated: ${a1.pages}/${a1.updated}`);
  assert(after.files[A] === H[file], P + 'the stored PDF of the song is not the new file (hash ' + after.files[A] + ')');
  /* its marks start fresh: every page that remains holds deletion markers of the same ids; a page past the end is gone */
  for(const k of Object.keys(before.ink).filter(k => k.startsWith(A + ':'))){
    const pn = +k.split(':')[1], r = after.ink[k];
    if(pn > a1.pages){ assert(!r, P + `ink ${k} kept for a page the new chart does not have`); continue; }
    assert(r && JSON.stringify(r.strokes.map(x => x.id)) === JSON.stringify(before.ink[k].strokes.map(x => x.id)), P + `ink ${k} does not hold the same ids: ` + JSON.stringify(r).slice(0, 200));
    for(const x of r.strokes) assert(x.deleted === true && x.updated > 0 && Object.keys(x).sort().join() === 'deleted,id,updated', P + `ink ${k} still has a live mark: ` + JSON.stringify(x).slice(0, 160));
  }
  /* the old copy: archived, details with the version marked old, the old crop, the old PDF bytes, every live old mark */
  const tag = o && /old (\d{4}-\d\d-\d\d)$/.exec(o.version || '');
  assert(tag && days.includes(tag[1]), P + `the old copy's version ${JSON.stringify(o && o.version)}, expected the date ${days.join(' or ')}`);
  const version = (a0.version ? a0.version + ', ' : '') + 'old ' + tag[1];
  const want = {id: O, song: a0.song, artist: a0.artist, version, title: a0.song + ` (${version})` + (a0.artist ? ' - ' + a0.artist : ''), archived: true, pages: a0.pages, hash: a0.hash};
  if('crop' in a0) want.crop = a0.crop;
  assert(Object.keys(o).sort().join() === [...Object.keys(want), 'added', 'updated'].sort().join(), P + 'the old copy has fields ' + Object.keys(o).sort().join());
  expectSame(want, Object.fromEntries(Object.keys(want).map(k => [k, o[k]])), P + 'the old copy');
  assert(o.added > 0 && o.updated >= o.added, P + 'the old copy added/updated ' + o.added + '/' + o.updated);
  assert(after.files[O] === a0.hash && before.files[A] === a0.hash, P + `the old copy's stored PDF hash ${after.files[O]}, the old chart's was ${before.files[A]} (record ${a0.hash})`);
  const oldInk = Object.keys(before.ink).filter(k => k.startsWith(A + ':')).map(k => [O + ':' + k.split(':')[1], before.ink[k].strokes.filter(x => !x.deleted)]).filter(([, v]) => v.length);
  const gotInk = Object.keys(after.ink).filter(k => k.startsWith(O + ':'));
  assert(gotInk.sort().join() === oldInk.map(([k]) => k).sort().join(), P + `the old copy has ink pages ${gotInk.join(', ') || 'none'}, expected ${oldInk.map(([k]) => k).join(', ')}`);
  for(const [k, v] of oldInk) expectSame(v, after.ink[k].strokes, P + `the old copy's marks on ${k}`);
  /* nothing else changed: setlists, other songs, their PDFs and marks */
  expectSame(before.sets, after.sets, P + 'the setlists');
  const others = (snap, extra) => ({songs: Object.fromEntries(Object.entries(snap.songs).filter(([k]) => k !== A && k !== extra)),
    files: Object.fromEntries(Object.entries(snap.files).filter(([k]) => k !== A && k !== extra)),
    ink: Object.fromEntries(Object.entries(snap.ink).filter(([k]) => !k.startsWith(A + ':') && !k.startsWith(extra + ':')))});
  expectSame(others(before, O), others(after, O), P + 'the rest of the library');
  return O;
}

/* The viewer: a song opened from `open` (a selector) shows `title`, page pn of n, drawn through `crop`, with or without marks. */
async function viewerShows(page, open, {title, n, pages}){
  await page.click(open);
  await page.waitForFunction(t => document.querySelector('#viewer').classList.contains('on') && document.querySelector('#vTitle').textContent === t && !!document.querySelector('#stage .ink'), title, {timeout: 8000})
    .catch(async () => { throw new Error(`the viewer did not open "${title}" (title "${await page.locator('#vTitle').textContent()}")`); });
  if(await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
  for(const [pn, {crop, marks}] of Object.entries(pages)){
    if(pn !== '1') await page.keyboard.press('ArrowRight');
    /* from a setlist the line starts with "Song 2 of 3 · " */
    await page.waitForFunction(([pn, n]) => new RegExp(`(^|· )Page ${pn} of ${n}$`).test(document.querySelector('#vSub').textContent) && !!document.querySelector(`#stage .ink[data-pn="${pn}"]`), [pn, n], {timeout: 8000})
      .catch(async () => { throw new Error(`"${title}": expected page ${pn} of ${n}, the viewer shows "${await page.locator('#vSub').textContent()}"`); });
    let got;
    const end = Date.now() + 5000;
    for(;;){
      got = await page.evaluate(pn => {
        const cv = document.querySelector(`#stage .ink[data-pn="${pn}"]`), c = cv._crop;
        const d = cv.width ? cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data : [];
        let px = false; for(let i = 3; i < d.length; i += 4) if(d[i]){ px = true; break; }
        return {crop: c ? {x: c.x, y: c.y, w: c.w, h: c.h} : null, px, w: cv.width};
      }, pn);
      if((JSON.stringify(got.crop) === JSON.stringify(crop) && got.px === marks && got.w > 0) || Date.now() > end) break;
      await sleep(100);
    }
    assert(JSON.stringify(got.crop) === JSON.stringify(crop), `"${title}" page ${pn} is drawn through crop ${JSON.stringify(got.crop)}, expected ${JSON.stringify(crop)}`);
    assert(got.px === marks, `"${title}" page ${pn} ${got.px ? 'shows marks' : 'shows no marks'}, expected ${marks ? 'its marks' : 'none'}`);
  }
  await page.click('#vBack');
  await page.waitForFunction(() => !document.querySelector('#viewer').classList.contains('on'), null, {timeout: 5000});
}
async function archivedRows(page){
  await page.click('#tLib');
  await page.locator('#showArch').setChecked(true);
  await page.waitForFunction(() => [...document.querySelectorAll('#libList h2')].some(h => h.textContent === 'Archived'), null, {timeout: 5000});
  const rows = await page.evaluate(() => [...document.querySelectorAll('#libList li.row')].filter(li => li.querySelector('[data-restoresong]'))
    .map(li => ({id: li.querySelector('.main').dataset.open, t: li.querySelector('.t').textContent, s: li.querySelector('.s').textContent})));
  await page.locator('#showArch').setChecked(false);
  return rows;
}

const CROP = {all: {x: .05, y: .04, w: .9, h: .92}, pages: {'2': {x: .1, y: .1, w: .8, h: .8}}};
const pen = (id, y) => ({id, t: 'pen', c: '#d62828', w: .003, p: [[.2, y], [.4, y + .01], [.6, y + .02]], updated: 100});

export const loops = [

/* the song keeps its id and plays the new chart in both setlists; ONE new archived song holds the old PDF, marks, notes, crop and
   a dated version; Cancel writes nothing; all of it again after a reload and after a backup round trip */
{name: 'new version 1: setlists play the new chart, Archived keeps the old one (reload, backup)', async run(ctx){
  const s = await session(ctx), page = s.page;
  try{
    const [A, B] = await addPdfs(page, ['two-page.pdf', 'one-page.pdf']);
    await inStore(page, async (S, [A, B, CROP, p1, p2, p3]) => {
      const a = await S.get('songs', A);
      Object.assign(a, {song: 'War Pigs', artist: 'Black Sabbath', version: '', crop: CROP}); await S.saveSong(a);
      await S.putInk(A, 1, [p1, {id: 'n1', t: 'text', x: .62, y: .3, text: 'Solo x2', size: .018, c: '#1f5fd6', updated: 101}, {id: 'gone', deleted: true, updated: 99}]);
      await S.putInk(A, 2, [{...p2, t: 'hl', c: '#ffd400', w: .02}]);
      await S.putInk(B, 1, [p3]);
      await S.saveSet({id: 'gig', name: 'Gig', items: [{type: 'song', id: A}, {type: 'break', id: 'b1', name: 'Set 2'}, {type: 'song', id: B}], created: 1});
      await S.saveSet({id: 'wed', name: 'Wedding', items: [{type: 'song', id: B}, {type: 'song', id: A}, {type: 'song', id: A}], created: 2});
    }, [A, B, CROP, pen('p1', .2), pen('p2', .4), pen('p3', .5)]);
    await s.goto();
    const before = await snapshot(page);

    /* the question, then Cancel: nothing written */
    await resetWrites(page);
    await pickNewVersion(page, A, 'three-page.pdf');
    assert(!(await page.locator('.modal.dupask').count()), 'a PDF not in the library brought up the duplicate question');
    const box = page.locator('.modal.nvask .box');
    assert(await box.getAttribute('role') === 'dialog' && await page.locator('.modal.nvask h2').getAttribute('id') === await box.getAttribute('aria-labelledby'), 'the question is not a labelled dialog');
    const q = await question(page);
    assert(q === 'Use three-page.pdf as the new version of War Pigs - Black Sabbath? The current chart and its marks move to Archived.', 'question: ' + q);
    assert(await page.locator('.modal.nvask [data-ok]').textContent() === 'New version' && await page.locator('.modal.nvask [data-x]').textContent() === 'Cancel', 'the question\'s buttons');
    await page.click('.modal.nvask [data-x]');
    await noModal(page); await sleep(300);
    assert(!(await writes(page)).length, 'Cancel wrote: ' + JSON.stringify(await writes(page)));
    expectSame(before, await snapshot(page), 'the library after Cancel');

    /* New version: one transaction */
    const days = [today()];
    await resetWrites(page);
    await pickNewVersion(page, A, 'three-page.pdf');
    await page.click('.modal.nvask [data-ok]');
    const msg = await waitToast(page, /^New version in place/);
    days.push(today());
    assert(msg === 'New version in place. The old one is in Archived. Crop kept. Use Reset in the crop screen if the layout changed.', 'toast: ' + msg);
    await sleep(300);
    const w = await writes(page);
    assert(w.length === 1 && w[0] === 'files+ink+songs', 'New version wrote in ' + JSON.stringify(w) + ' (expected ONE files+ink+songs transaction)');
    const after = await snapshot(page);
    const O = checkNewVersion(before, after, A, 'three-page.pdf', days, 'after New version');
    const oldTitle = after.songs[O].title;
    assert(/^War Pigs \(old \d{4}-\d\d-\d\d\) - Black Sabbath$/.test(oldTitle), 'old copy title ' + oldTitle);

    /* the screens: the library row, Archived, both setlists play the new chart, the old copy opens with its marks and crop */
    const checkScreens = async when => {
      await page.click('#tLib');
      const row = await page.evaluate(A => { const b = document.querySelector(`#libList [data-open="${A}"]`); return b && [b.querySelector('.t').textContent, b.querySelector('.s').textContent]; }, A);
      assert(JSON.stringify(row) === JSON.stringify(['War Pigs - Black Sabbath', '3 pages']), when + ': library row ' + JSON.stringify(row));
      assert(!(await page.locator(`#libList [data-open="${O}"]`).count()), when + ': the old copy is listed in the library (it belongs in Archived)');
      const arch = await archivedRows(page);
      assert(JSON.stringify(arch) === JSON.stringify([{id: O, t: oldTitle, s: '2 pages · Archived'}]), when + ': Archived shows ' + JSON.stringify(arch));
      for(const [set, at] of [['gig', 0], ['wed', 1], ['wed', 2]]){
        await page.click('#tSets');
        await page.click(`#view [data-set="${set}"]`);
        await page.waitForSelector(`#view [data-playat="${at}"]`);
        await viewerShows(page, `#view [data-playat="${at}"]`, {title: 'War Pigs - Black Sabbath', n: 3, pages: {1: {crop: CROP.all, marks: false}, 2: {crop: CROP.pages['2'], marks: false}}});
      }
      await page.click('#tLib');
      await page.locator('#showArch').setChecked(true);
      await viewerShows(page, `#libList [data-open="${O}"]`, {title: oldTitle, n: 2, pages: {1: {crop: CROP.all, marks: true}, 2: {crop: CROP.pages['2'], marks: true}}});
      await page.click('#tLib');
      await page.locator('#showArch').setChecked(false);
    };
    await checkScreens('after New version');

    /* reload */
    await s.goto();
    expectSame(after, await snapshot(page), 'the library after a reload');
    checkNewVersion(before, await snapshot(page), A, 'three-page.pdf', days, 'after a reload');
    await checkScreens('after a reload');

    /* Back up -> wipe -> Restore */
    const want = await snapshot(page);
    const {file} = await backupNow(page);
    await page.goto(s.base + 'css/app.css');
    await wipe(page);
    await s.goto();
    assert(!Object.keys((await snapshot(page)).songs).length, 'the database is not empty after the wipe');
    await restoreZip(page, file);
    const back = await snapshot(page);
    expectSame(want, back, 'the library after Back up -> wipe -> Restore');
    checkNewVersion(before, back, A, 'three-page.pdf', days, 'after a backup round trip');
    await checkScreens('after a backup round trip');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}},

/* a duplicate PDF asks first and Skip or Escape changes nothing; Escape on the question; a write that fails part-way changes
   nothing; "(in G, old ...)"; Add anyway and a 200-character version; deleting either copy never touches the other */
{name: 'new version 2: duplicates, Escape, failed writes, Add anyway, deleting either copy', async run(ctx){
  const s = await session(ctx), page = s.page;
  try{
    const [A, B] = await addPdfs(page, ['two-page.pdf', 'one-page.pdf']);
    await inStore(page, async (S, [A, B, CROP, p1, p2]) => {
      const a = await S.get('songs', A);
      Object.assign(a, {song: 'Flowers in the Ashes', artist: '', version: 'in G', crop: CROP}); await S.saveSong(a);
      const b = await S.get('songs', B);
      Object.assign(b, {song: 'Long One', artist: 'X', version: 'v'.repeat(200)}); await S.saveSong(b);
      await S.putInk(A, 1, [p1]); await S.putInk(A, 2, [p2]);
      await S.saveSet({id: 'gig', name: 'Gig', items: [{type: 'song', id: A}, {type: 'song', id: B}], created: 1});
    }, [A, B, CROP, pen('p1', .2), pen('p2', .4)]);
    await s.goto();
    const before = await snapshot(page);

    /* a PDF already in the library: the duplicate question (another song's PDF, then the song's own), Skip and Escape */
    for(const [file, how] of [['one-page.pdf', 'skip'], ['two-page.pdf', 'escape']]){
      await resetWrites(page);
      await pickNewVersion(page, A, file);
      const dup = page.locator('.modal.dupask');
      assert(await dup.count() === 1, `${file}: no duplicate question`);
      const text = (await dup.textContent()).replace(/\s+/g, ' ');
      assert(/Already in your library/.test(text) && /This PDF is already in your library:/.test(text) && text.includes(file), `${file}: duplicate question "${text}"`);
      if(how === 'skip') await page.click('.modal.dupask [data-dupskip]'); else await page.keyboard.press('Escape');
      assert(await waitToast(page, /already in your library/) === 'That PDF is already in your library. Nothing was changed.', `${file}: toast after ${how}`);
      await noModal(page); await sleep(200);
      assert(!(await writes(page)).length, `${file}: ${how} wrote ` + JSON.stringify(await writes(page)));
      expectSame(before, await snapshot(page), `the library after ${how} on the duplicate question for ${file}`);
    }

    /* Escape on the question cancels */
    await pickNewVersion(page, A, 'three-page.pdf');
    await page.keyboard.press('Escape');
    await noModal(page); await sleep(200);
    expectSame(before, await snapshot(page), 'the library after Escape on the question');

    /* a write that fails part-way (the last record, then one in the middle): nothing changed, also after a reload */
    for(const [fail, what] of [[{store: 'songs', key: A}, 'the song record (the last write)'], [{store: 'ink', notPrefix: A + ':'}, 'the old copy\'s marks (a write in the middle)']]){
      await page.evaluate(f => { window.__fail = f; }, fail);
      await pickNewVersion(page, A, 'three-page.pdf');
      await page.click('.modal.nvask [data-ok]');
      assert(await waitToast(page, /tablet is full/) === FULL, `failing ${what}: toast`);
      await page.evaluate(() => { window.__fail = null; });
      expectSame(before, await snapshot(page), `the library after New version failed at ${what}`);
      await s.goto();
      expectSame(before, await snapshot(page), `the library after New version failed at ${what}, and a reload`);
      assert(!(await archivedRows(page)).length, `failing ${what}: something is in Archived`);
    }

    /* now it works: "(in G, old YYYY-MM-DD)" */
    const days = [today()];
    await pickNewVersion(page, A, 'three-page.pdf');
    await page.click('.modal.nvask [data-ok]');
    await waitToast(page, /^New version in place\. The old one is in Archived\. Crop kept\./);
    days.push(today());
    const s1 = await snapshot(page);
    const O1 = checkNewVersion(before, s1, A, 'three-page.pdf', days, 'New version of a song with a version');
    assert(/^Flowers in the Ashes \(in G, old \d{4}-\d\d-\d\d\)$/.test(s1.songs[O1].title), 'title of the old copy: ' + s1.songs[O1].title);

    /* Add anyway: the song's own PDF again; a 200-character version stays within 200 characters */
    await pickNewVersion(page, B, 'one-page.pdf');
    await page.click('.modal.dupask [data-dupadd]');
    await page.locator('.modal.nvask').waitFor({timeout: 5000});
    await page.click('.modal.nvask [data-ok]');
    assert(await waitToast(page, /^New version in place/) === 'New version in place. The old one is in Archived.', 'toast for a song with no crop');
    const s2 = await snapshot(page);
    const O2 = Object.keys(s2.songs).find(k => !(k in s1.songs));
    const v2 = s2.songs[O2] && s2.songs[O2].version;
    assert(v2 && v2.length === 200 && v2.startsWith('v'.repeat(184) + ', old ') && s2.songs[O2].hash === H['one-page.pdf'] && s2.files[O2] === H['one-page.pdf'] && s2.songs[B].hash === H['one-page.pdf'],
      'Add anyway / long version: ' + JSON.stringify(s2.songs[O2]).slice(0, 120) + ' (' + (v2 || '').length + ' characters)');

    /* deleting the old copy (from Archived) never touches the new chart */
    const nowA = {song: s2.songs[A], file: s2.files[A], ink: Object.fromEntries(Object.entries(s2.ink).filter(([k]) => k.startsWith(A + ':'))), sets: s2.sets};
    await page.click('#tLib');
    await page.locator('#showArch').setChecked(true);
    await page.click(`#libList [data-del="${O1}"]`); await page.click(`#libList [data-del="${O1}"]`);
    await page.waitForFunction(id => !document.querySelector(`#libList [data-open="${id}"]`), O1, {timeout: 5000});
    await page.locator('#showArch').setChecked(false);
    const s3 = await snapshot(page);
    expectSame(nowA, {song: s3.songs[A], file: s3.files[A], ink: Object.fromEntries(Object.entries(s3.ink).filter(([k]) => k.startsWith(A + ':'))), sets: s3.sets}, 'the new chart after its old copy was deleted');
    assert(s3.songs[O1].deleted === true && !s3.files[O1] && !Object.keys(s3.ink).some(k => k.startsWith(O1 + ':')), 'the deleted old copy left its PDF or marks');

    /* deleting the new chart never touches its old copy */
    await pickNewVersion(page, A, 'two-page.pdf');           // two-page.pdf left the library with that old copy: not a duplicate now
    assert(!(await page.locator('.modal.dupask').count()), 'two-page.pdf is still counted as in the library');
    await page.click('.modal.nvask [data-ok]');
    await waitToast(page, /^New version in place/);
    const s4 = await snapshot(page);
    const O3 = checkNewVersion(s3, s4, A, 'two-page.pdf', [today(), ...days], 'a second New version');
    const nowO3 = {song: s4.songs[O3], file: s4.files[O3], ink: Object.fromEntries(Object.entries(s4.ink).filter(([k]) => k.startsWith(O3 + ':')))};
    assert(Object.keys(nowO3.ink).length === 0, 'the second old copy has marks, but the chart it kept had only deletion markers');
    await page.click('#tLib');
    await page.click(`#libList [data-del="${A}"]`); await page.click(`#libList [data-del="${A}"]`);
    await page.waitForFunction(id => !document.querySelector(`#libList [data-open="${id}"]`), A, {timeout: 5000});
    const s5 = await snapshot(page);
    expectSame(nowO3, {song: s5.songs[O3], file: s5.files[O3], ink: Object.fromEntries(Object.entries(s5.ink).filter(([k]) => k.startsWith(O3 + ':')))}, 'the old copy after the new chart was deleted');
    assert(JSON.stringify(s5.sets.gig.items) === JSON.stringify([{type: 'song', id: B}]), 'Gig after the new chart was deleted: ' + JSON.stringify(s5.sets.gig.items));
    assert(!s.errors.filter(e => !/disk is full/.test(e)).length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}},

/* a song whose stored PDF is missing still takes the new chart; the question says nothing can be kept; nothing is archived */
{name: 'new version 3: a song with no stored PDF takes the new chart, nothing archived', async run(ctx){
  const s = await session(ctx), page = s.page;
  try{
    const [C] = await addPdfs(page, ['one-page.pdf']);
    await inStore(page, async (S, [C, p1]) => { await S.putInk(C, 1, [p1]); await S.del('files', C); }, [C, pen('p1', .2)]);
    await s.goto();
    const before = await snapshot(page);
    await resetWrites(page);
    await pickNewVersion(page, C, 'two-page.pdf');
    const q = await question(page);
    assert(q === 'Use two-page.pdf as the new version of One-page? The current chart cannot be read on this tablet, so it cannot be kept: its marks are cleared.', 'question: ' + q);
    await page.click('.modal.nvask [data-ok]');
    assert(await waitToast(page, /^New version in place/) === 'New version in place. Its marks were cleared.', 'toast when nothing could be kept');
    await sleep(300);
    const w = await writes(page);
    assert(w.length === 1 && w[0] === 'files+ink+songs', 'wrote in ' + JSON.stringify(w));
    const after = await snapshot(page);
    assert(JSON.stringify(Object.keys(after.songs)) === JSON.stringify([C]), 'songs after: ' + Object.keys(after.songs).join(', '));
    expectSame({...before.songs[C], pages: 2, hash: H['two-page.pdf'], updated: after.songs[C].updated}, after.songs[C], 'the song');
    assert(after.files[C] === H['two-page.pdf'], 'the song\'s PDF');
    assert(JSON.stringify(after.ink[C + ':1'].strokes) === JSON.stringify([{id: 'p1', deleted: true, updated: after.ink[C + ':1'].strokes[0].updated}]), 'the song\'s ink: ' + JSON.stringify(after.ink));
    assert(!(await archivedRows(page)).length, 'something is in Archived');
  } finally { await s.close(); }
}},

/* a stored PDF that is there but cannot be read (a storage hiccup, too little memory) stops New version before any question:
   it must never be written over as if it were missing */
{name: 'new version 4: a stored PDF that cannot be read stops it, nothing changed', async run(ctx){
  const s = await session(ctx), page = s.page;
  try{
    const [A, B] = await addPdfs(page, ['two-page.pdf', 'one-page.pdf']);
    await inStore(page, async (S, [A, B, CROP, p1]) => {
      const a = await S.get('songs', A); a.crop = CROP; await S.saveSong(a);
      await S.putInk(A, 1, [p1]);
      await S.saveSet({id: 'gig', name: 'Gig', items: [{type: 'song', id: A}, {type: 'song', id: B}], created: 1});
    }, [A, B, CROP, pen('p1', .2)]);
    await s.goto();
    const before = await snapshot(page);
    await page.click('#tLib');
    await clearToast(page); await resetWrites(page);
    await page.evaluate(() => { window.__failRead = true; });
    await page.click(`#libList [data-newversion="${A}"]`);
    await page.setInputFiles('#newVersionFile', path.join(FIX, 'three-page.pdf'));
    await page.waitForFunction(() => !!document.querySelector('.modal') || /Could not read/.test(document.querySelector('#toast').textContent), null, {timeout: 15000})
      .catch(async () => { throw new Error('neither a refusal nor a question; toast "' + await page.locator('#toast').textContent() + '"'); });
    if(await page.locator('.modal').count()) throw new Error('a question showed instead of a refusal: "' + (await page.locator('.modal').textContent()).replace(/\s+/g, ' ').trim().slice(0, 140) + '"');
    assert(await page.evaluate(() => window.__failRead) === false, 'the stored PDF was never read');
    const msg = await page.locator('#toast').textContent();
    assert(msg === 'Could not read the current chart, so it cannot be kept. Nothing was changed.', 'toast: ' + msg);
    await sleep(300);
    assert(!(await writes(page)).length, 'it wrote ' + JSON.stringify(await writes(page)));
    expectSame(before, await snapshot(page), 'the library after a stored PDF could not be read');
    await s.goto();
    expectSame(before, await snapshot(page), 'the library after a stored PDF could not be read, and a reload');
    assert(!(await archivedRows(page)).length, 'something is in Archived');
  } finally { await s.close(); }
}},

/* the song is edited, then deleted, while the question is open (another screen or tab): nothing is written, an edit is not
   undone, a deleted song is not brought back */
{name: 'new version 5: a song edited or deleted while the question is open is not written', async run(ctx){
  const s = await session(ctx), page = s.page;
  try{
    const [A, B] = await addPdfs(page, ['two-page.pdf', 'one-page.pdf']);
    await inStore(page, async (S, [A, B, p1]) => {
      await S.putInk(A, 1, [p1]);
      await S.saveSet({id: 'gig', name: 'Gig', items: [{type: 'song', id: A}, {type: 'song', id: B}], created: 1});
    }, [A, B, pen('p1', .2)]);
    await s.goto();
    const meanwhile = {
      edited: async S_A => inStore(page, async (S, A) => { const a = await S.get('songs', A); a.song = 'Edited Meanwhile'; await S.saveSong(a); await S.load(); }, S_A),
      deleted: async S_A => inStore(page, async (S, A) => {
        const t = Date.now(), st = await S.get('sets', 'gig');
        await S.putAll([{store: 'files', key: A, delete: true}, {deleteInkFor: A}, {store: 'songs', key: A, value: {id: A, deleted: true, updated: t}},
          {store: 'sets', key: 'gig', value: {...st, items: st.items.filter(it => it.id !== A), updated: t}}]);
        await S.load();
      }, S_A),
    };
    for(const how of ['edited', 'deleted']){
      await s.goto();
      await pickNewVersion(page, A, 'three-page.pdf');
      await meanwhile[how](A);
      const then = await snapshot(page);
      await clearToast(page); await resetWrites(page);
      await page.click('.modal.nvask [data-ok]');
      const msg = await waitToast(page, /in the meantime|New version in place/);
      assert(msg === 'That song changed in the meantime. Nothing was changed.', `${how} while the question was open: toast "${msg}"`);
      await sleep(300);
      assert(!(await writes(page)).length, `${how}: it wrote ` + JSON.stringify(await writes(page)));
      expectSame(then, await snapshot(page), `the library after New version on a song ${how} while the question was open`);
      if(how === 'edited') assert(then.songs[A].song === 'Edited Meanwhile' && then.files[A] === H['two-page.pdf'], 'the edit was not in place: ' + JSON.stringify(then.songs[A]));
      else assert(then.songs[A].deleted === true && !then.files[A] && Object.keys(then.songs).length === 2, 'the song was brought back or a copy added: ' + JSON.stringify(then.songs).slice(0, 200));
    }
    await s.goto();
    assert(!(await page.locator(`#libList [data-open="${A}"]`).count()) && !(await archivedRows(page)).length, 'the deleted song or an old copy shows after a reload');
  } finally { await s.close(); }
}},

];

/*
 * Viewer faults (whole-app review, 2026-11-23): what the viewer does when a chart, a page or a mark is damaged, and the
 * small touch, key, crop and full-screen guards. Closed loops where possible: what the app STORED (IndexedDB) and what
 * the stage SHOWS (its canvases' pixels, the placeholder, the counter) are read back; pdf.js workers are counted at the
 * browser's own Worker constructor and terminate(), so a worker left running after the viewer closes is seen.
 * The charts are made here with pdf-lib (text only, no music).
 */
import fs from 'node:fs';
import path from 'node:path';
import {TMP, assert, sha256, sleep, idbAll, PDFLib} from './harness.mjs';

const {PDFDocument, StandardFonts, rgb} = PDFLib;
const BAD_CHART = 'This chart could not be opened. Your music is safe.', BAD_PAGE = 'This page could not be shown. Your music is safe.';
const fmt = o => JSON.stringify(o, (k, v) => typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);
async function waitFor(fn, what, ms = 8000){
  const end = Date.now() + ms; let v;
  while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(100); }
  throw new Error(typeof what === 'function' ? await what() : what);
}
const noErrors = s => assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));

/* A text-only chart: `pages` pages, each saying "<name> page <n>". */
async function chart(name, pages){
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.HelveticaBold);
  for(let i = 1; i <= pages; i++){
    const pg = doc.addPage([612, 792]);
    pg.drawText(`${name} page ${i}`, {x: 60, y: 700, size: 36, font, color: rgb(0, 0, 0)});
  }
  const f = path.join(TMP, `vf-${name}.pdf`);
  fs.writeFileSync(f, await doc.save());
  return f;
}
async function toLibrary(page){
  if(await page.locator('#viewer.on').count()) await page.click('#vBack');
  await page.click('#tLib');
  await page.waitForSelector('#libList');
}
/* Imports the files; returns {basename: {id, title}} found by SHA-256. */
async function importFiles(page, files){
  await toLibrary(page);
  const n0 = await page.locator('#libList [data-open]').count();
  await page.setInputFiles('#file', files);
  await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, n0 + files.length, {timeout: 20000})
    .catch(() => { throw new Error(`import of ${files.length} files did not show in the library`); });
  const songs = Object.values(await idbAll(page, 'songs')), out = {};
  for(const f of files){
    const s = songs.find(x => x.hash === sha256(fs.readFileSync(f)) && !x.deleted);
    assert(s, `${path.basename(f)}: no song record with its hash`);
    out[path.basename(f, '.pdf').slice(3)] = {id: s.id, title: s.title};
  }
  return out;
}
/* One record straight into IndexedDB; text: the value is a Blob of this text instead (bytes that are not a PDF). */
const idbPut = (page, store, key, value, text) => page.evaluate(([store, key, value, text]) => new Promise((res, rej) => {
  if(text !== null) value = new Blob([text], {type: 'application/pdf'});
  const r = indexedDB.open('setlist-stand');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => { const d = r.result, tx = d.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key);
    tx.oncomplete = () => { d.close(); res(); }; tx.onerror = () => rej(tx.error); };
}), [store, key, value, text ?? null]);
const idbDel = (page, store, key) => page.evaluate(([store, key]) => new Promise((res, rej) => {
  const r = indexedDB.open('setlist-stand'); r.onerror = () => rej(r.error);
  r.onsuccess = () => { const d = r.result, tx = d.transaction(store, 'readwrite'); tx.objectStore(store).delete(key);
    tx.oncomplete = () => { d.close(); res(); }; tx.onerror = () => rej(tx.error); };
}), [store, key]);
/* A setlist written straight into IndexedDB (items: song ids, or {brk: name}), then the app reloaded and the set played. */
async function playNewSet(page, setId, items){
  const now = Date.now();
  await idbPut(page, 'sets', setId, {id: setId, name: 'Faults ' + setId, colls: [], created: now, updated: now,
    items: items.map((x, i) => typeof x === 'string' ? {type: 'song', id: x} : {type: 'break', id: setId + 'b' + i, name: x.brk})});
  await page.reload(); await page.waitForSelector('#libList, #view');
  await page.click('#tSets');
  await page.click(`#view [data-play="${setId}"]`);
  await page.waitForSelector('#viewer.on');
}
const title = page => page.locator('#vTitle').textContent();
const sub = page => page.locator('#vSub').textContent();
const pageNo = async page => +((/Page (\d+)/.exec(await sub(page)) || [])[1] || 0);
/* What the stage shows: the placeholder's text, or the page numbers of the sheets drawn. */
const stageNow = page => page.evaluate(() => ({bad: [...document.querySelectorAll('#stage .badpage')].map(b => b.textContent),
  sheets: [...document.querySelectorAll('#stage .sheet .ink')].map(c => +c.dataset.pn)}));
async function oneUp(page){
  await page.evaluate(() => document.querySelector('#viewer').classList.remove('hide'));
  if(await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
}
/* Counts pdf.js workers at the browser's own constructor: made, and ended (terminate()). Installed before the app loads. */
const countWorkers = context => context.addInitScript(() => {
  const W = window.Worker; let made = 0, ended = 0;
  window.__workers = () => ({made, ended, live: made - ended});
  window.Worker = class extends W {
    constructor(...a){ super(...a); made++; }
    terminate(){ if(!this.__ended){ this.__ended = true; ended++; } return super.terminate(); }
  };
});

/* ======================================================================================================== */
export const loops = [

{name: 'viewer faults 1: a setlist with an unreadable and a missing chart shows a placeholder for each, turns move past them both ways, no pdf.js worker is left running', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await countWorkers(s.context);
    await s.goto();
    const c = await importFiles(page, [await chart('Broken', 2), await chart('Alpha', 1), await chart('Missing', 2), await chart('Gamma', 3)]);
    await idbPut(page, 'files', c.Broken.id, null, 'this is not a PDF at all');      // the bytes of a damaged chart
    await idbDel(page, 'files', c.Missing.id);                                        // no PDF stored
    const live0 = await waitFor(async () => { const w = await page.evaluate(() => window.__workers()); return w.live === 0 ? w : null; },
      async () => 'setup: a pdf.js worker is still running after the import: ' + fmt(await page.evaluate(() => window.__workers())));
    assert(live0.made > 0, 'setup: the worker counter saw no pdf.js worker during the import (pdf.js runs without one here, so this loop proves nothing)');
    /* the FIRST song cannot be opened: the placeholder, and every turn still works */
    await playNewSet(page, 'vf1', [c.Broken.id, c.Alpha.id, c.Missing.id, c.Gamma.id]);
    await oneUp(page);
    const at = async (t, want, what) => waitFor(async () => {
      const st = await stageNow(page);
      if(await title(page) !== t) return null;
      return want === 'bad' ? st.bad.length === 1 && st.bad[0].includes(BAD_CHART) && st.bad[0].includes(t) && !st.sheets.length
        : JSON.stringify(st.sheets) === JSON.stringify(want) && !st.bad.length;
    }, async () => `${what}: want "${t}" ${want === 'bad' ? 'placeholder' : 'pages ' + JSON.stringify(want)}, shows "${await title(page)}" ${fmt(await stageNow(page))}`);
    await at(c.Broken.title, 'bad', 'the first song is unreadable');
    assert(await page.locator('#vAnn').isHidden() && await page.locator('#vCrop').isHidden(), 'Annotate or Crop is offered on a chart that could not be opened');
    assert((await sub(page)).includes('Song 1 of 4') && (await sub(page)).includes('Could not open'), 'the counter under the title does not say the chart could not be opened: ' + await sub(page));
    const turns = [['ArrowRight', c.Alpha.title, [1]], ['ArrowRight', c.Missing.title, 'bad'], ['ArrowRight', c.Gamma.title, [1]],
      ['ArrowRight', c.Gamma.title, [2]], ['ArrowRight', c.Gamma.title, [3]], ['ArrowLeft', c.Gamma.title, [2]], ['ArrowLeft', c.Gamma.title, [1]],
      ['ArrowLeft', c.Missing.title, 'bad'], ['ArrowLeft', c.Alpha.title, [1]], ['ArrowLeft', c.Broken.title, 'bad'],
      ['ArrowRight', c.Alpha.title, [1]], ['ArrowRight', c.Missing.title, 'bad'], ['ArrowRight', c.Gamma.title, [1]]];
    for(const [i, [key, t, want]] of turns.entries()){
      await page.keyboard.press(key);
      await at(t, want, `turn ${i + 1} (${key})`);
      const w = await page.evaluate(() => window.__workers());
      assert(w.live <= 4, `turn ${i + 1}: ${w.live} pdf.js workers running (the song showing and the songs either side need at most 3, plus one closing)`);
    }
    /* tapping the placeholder's right side turns too (a person's tap, not only the pedal) */
    await page.keyboard.press('ArrowLeft'); await at(c.Missing.title, 'bad', 'back onto the missing chart');
    await page.mouse.click(Math.round(page.viewportSize().width * .9), 400);
    await at(c.Gamma.title, [1], 'a tap on the right of the placeholder');
    /* closed: every pdf.js worker the viewer started has ended (a failed open used to leave its worker running) */
    await page.click('#vBack');
    await waitFor(async () => (await page.evaluate(() => window.__workers())).live === 0,
      async () => 'after closing the viewer pdf.js workers are still running: ' + fmt(await page.evaluate(() => window.__workers())));
    /* the missing and the broken song's records are untouched, and nothing was written for them */
    const ink = await idbAll(page, 'ink');
    assert(!Object.keys(ink).some(k => k.startsWith(c.Broken.id + ':') || k.startsWith(c.Missing.id + ':')), 'marks were written for a chart that could not be opened: ' + Object.keys(ink).join(', '));
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'viewer faults 2: a page that fails to draw shows the placeholder and the counter moves; after a song change nothing of the song left stays on screen and the pen marks nothing', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const c = await importFiles(page, [await chart('First', 1), await chart('Second', 3)]);
    await playNewSet(page, 'vf2', [c.First.id, c.Second.id]);
    await oneUp(page);
    await waitFor(async () => await title(page) === c.First.title && (await stageNow(page)).sheets.length === 1, 'setup: the first song did not show');
    /* the next song's page 1 fails to draw (its prepared document's getPage refuses page 1) */
    await page.evaluate(async () => {
      const {V} = await import('./js/viewer.js');
      for(let i = 0; i < 3; i++) await Promise.allSettled([...V.cache.values(), ...[...V.prep.values()].map(e => e.p)]);
      const e = V.prep.get(1); if(!e) throw new Error('setup: the next song (entry 1) is not prepared');
      const d = await e.p, gp = d.getPage.bind(d);
      d.getPage = n => n === 1 ? Promise.reject(new Error('a damaged page')) : gp(n);
      V.cache.clear();
    });
    const before = await idbAll(page, 'ink');
    await page.keyboard.press('ArrowRight');
    await waitFor(async () => { const st = await stageNow(page); return await title(page) === c.Second.title && st.bad.length === 1 && st.bad[0].includes(BAD_PAGE) && !st.sheets.length; },
      async () => `a page that failed to draw: want the placeholder for "${c.Second.title}" page 1, shows "${await title(page)}" ${fmt(await stageNow(page))}`);
    assert(await pageNo(page) === 1 && (await sub(page)).includes('of 3'), 'the counter does not say page 1 of 3: ' + await sub(page));
    /* the pen on the placeholder marks nothing on either song */
    if(await page.locator('#tools').isHidden()) await page.click('#vAnn');
    await page.click('#tools [data-tool=pen][data-color="#d62828"]');
    await page.mouse.move(640, 250); await page.mouse.down(); await page.mouse.move(660, 450, {steps: 6}); await page.mouse.up();     // up and down: not a swipe
    assert(await title(page) === c.Second.title && await pageNo(page) === 1, `the stroke over the placeholder moved the viewer: "${await title(page)}" ${await sub(page)}`);
    await sleep(500);
    assert(fmt(await idbAll(page, 'ink')) === fmt(before), 'a stroke over the placeholder was saved: ' + fmt(await idbAll(page, 'ink')));
    await page.click('#tDone');
    /* the counter moves on, and the pages that draw are shown */
    await page.keyboard.press('ArrowRight');
    await waitFor(async () => JSON.stringify((await stageNow(page)).sheets) === '[2]' && await pageNo(page) === 2, async () => 'the turn after the placeholder did not show page 2: ' + fmt(await stageNow(page)));
    await page.keyboard.press('ArrowLeft');
    await waitFor(async () => (await stageNow(page)).bad.length === 1 && await pageNo(page) === 1, async () => 'back onto the damaged page: ' + fmt(await stageNow(page)));
    await page.keyboard.press('ArrowLeft');
    await waitFor(async () => await title(page) === c.First.title && JSON.stringify((await stageNow(page)).sheets) === '[1]', async () => 'back to the first song: ' + fmt(await stageNow(page)));
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'viewer faults 3: damaged marks (a note with no text, a stroke with no point list, points that are not numbers, a colour that is not #rrggbb) are skipped or drawn black; the page and its good marks still draw; Text and the eraser still work', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const c = await importFiles(page, [await chart('Marks', 1)]);
    const id = c.Marks.id, now = Date.now();
    const strokes = [
      {id: 'n1', t: 'text', x: .1, y: .1, size: .02, c: '#d62828', updated: now},                                        // no text
      {id: 's1', t: 'pen', c: '#d62828', w: .003, updated: now},                                                          // no points
      {id: 's2', t: 'pen', c: '#d62828', w: .003, p: 'oops', updated: now},                                               // points not a list
      {id: 's3', t: 'pen', c: 'red', w: .006, p: [[.2, .5], [.6, .5]], updated: now},                                     // colour not #rrggbb: black
      {id: 's4', t: 'pen', c: '#d62828', w: .006, p: [[.2, .7], null, [.6, .7], ['x', 1]], updated: now},                // two bad points
      {id: 'n2', t: 'text', x: .3, y: .25, size: .03, c: 42, text: 'Hello', updated: now},                                // colour a number
      {id: 's5', t: 'pen', c: '#1f5fd6', w: .006, p: [[.2, .85], [.6, .85]], updated: now},                              // a good one
    ];
    await idbPut(page, 'ink', id + ':1', {updated: now, strokes});
    await toLibrary(page);
    await page.click(`#libList [data-open="${id}"]`);
    await oneUp(page);
    await waitFor(async () => (await stageNow(page)).sheets.length === 1, async () => 'the page with damaged marks did not show: ' + fmt(await stageNow(page)) + ' ' + s.errors.join(' | '));
    /* the ink canvas: per band of the page, the pixels of each colour */
    const bands = await page.evaluate(() => {
      const cv = document.querySelector('#stage .ink'), d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, W = cv.width, H = cv.height;
      const at = (y0, y1, test) => { let n = 0; for(let y = Math.floor(y0 * H); y < y1 * H; y++) for(let x = 0; x < W; x++){ const o = (y * W + x) * 4; if(d[o + 3] > 200 && test(d[o], d[o + 1], d[o + 2])) n++; } return n; };
      const dark = (r, g, b) => r < 60 && g < 60 && b < 60, red = (r, g, b) => r > 170 && g < 90 && b < 90, blue = (r, g, b) => b > 150 && r < 90;
      return {black50: at(.47, .53, dark), red70: at(.67, .73, red), blue85: at(.82, .88, blue), black25: at(.24, .32, dark), any10: at(.05, .15, () => true)};
    });
    assert(bands.black50 > 50, 'the stroke with a colour that is not #rrggbb was not drawn (black): ' + fmt(bands));
    assert(bands.red70 > 50, 'the stroke with two bad points lost its good points: ' + fmt(bands));
    assert(bands.blue85 > 50, 'the good stroke after the damaged ones was not drawn: ' + fmt(bands));
    assert(bands.black25 > 20, 'the note with a colour that is not #rrggbb was not drawn (black): ' + fmt(bands));
    assert(bands.any10 === 0, 'something was drawn for the note with no text: ' + fmt(bands));
    /* Text where the damaged note sits opens a NEW note (it is not taken for a note); the eraser over everything throws nothing */
    if(await page.locator('#tools').isHidden()) await page.click('#vAnn');
    const b = await page.locator('#stage .sheet').boundingBox(), P = (fx, fy) => [b.x + b.width * fx, b.y + b.height * fy];
    await page.click('#tools [data-tool=text]');
    await page.mouse.click(...P(.12, .11));
    await page.waitForSelector('.modal textarea');
    assert((await page.locator('.modal h2').textContent()) === 'New note', 'a tap on the damaged note opened: ' + await page.locator('.modal h2').textContent());
    await page.click('.modal [data-x]');
    await page.click('#tools [data-tool=erase]');
    /* one gesture across each stroke's line, slowly (the eraser hits near a stroke's points) */
    await page.mouse.move(...P(.1, .5)); await page.mouse.down();
    for(const [fx, fy] of [[.7, .5], [.7, .7], [.1, .7], [.1, .85], [.7, .85]]) await page.mouse.move(...P(fx, fy), {steps: 60});
    await page.mouse.up();
    await sleep(500);
    const after = (await idbAll(page, 'ink'))[id + ':1'];
    const live = after.strokes.filter(x => !x.deleted).map(x => x.id).sort();
    assert(!live.includes('s3') && !live.includes('s4') && !live.includes('s5'), 'the eraser did not erase the drawable strokes: ' + fmt(after));
    assert(live.includes('n2'), 'the eraser erased a note: ' + fmt(after));
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'viewer faults 4: a touch that rests 500 ms or more is not a tap (no turn, the bars stay); a held key turns one page, not one per repeat', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const c = await importFiles(page, [await chart('Long', 3)]);
    await toLibrary(page);
    await page.click(`#libList [data-open="${c.Long.id}"]`);
    await oneUp(page);
    await waitFor(async () => await pageNo(page) === 1 && (await stageNow(page)).sheets.length === 1, 'setup: page 1 did not show');
    const vw = page.viewportSize().width, R = [Math.round(vw * .85), 420], M = [Math.round(vw * .5), 420];
    /* a resting touch on the right: no turn */
    await page.mouse.move(...R); await page.mouse.down(); await sleep(700); await page.mouse.up();
    await sleep(500);
    assert(await pageNo(page) === 1, 'a touch held 700 ms turned the page to ' + await pageNo(page));
    /* a resting touch in the middle: the bars do not hide */
    const hid0 = await page.locator('#viewer.hide').count();
    await page.mouse.move(...M); await page.mouse.down(); await sleep(700); await page.mouse.up();
    await sleep(300);
    assert(await page.locator('#viewer.hide').count() === hid0, 'a touch held 700 ms in the middle showed or hid the bars');
    /* a quick tap still turns */
    await page.mouse.click(...R);
    await waitFor(async () => await pageNo(page) === 2, 'a quick tap on the right did not turn the page');
    /* a key held down: the browser repeats it; ONE page turns */
    await page.keyboard.down('ArrowLeft'); await sleep(50); await page.keyboard.down('ArrowLeft'); await page.keyboard.down('ArrowLeft'); await page.keyboard.up('ArrowLeft');
    await sleep(800);
    assert(await pageNo(page) === 1, `a held ArrowLeft went from page 2 to page ${await pageNo(page)} (one page expected)`);
    await page.keyboard.down('ArrowRight'); await sleep(50);
    for(let i = 0; i < 4; i++) await page.keyboard.down('ArrowRight');
    await page.keyboard.up('ArrowRight');
    await sleep(800);
    assert(await pageNo(page) === 2, `a held ArrowRight went from page 1 to page ${await pageNo(page)} (one page expected)`);
    const rep = await page.evaluate(() => { const e = new KeyboardEvent('keydown', {key: ' ', repeat: true, bubbles: true, cancelable: true}); dispatchEvent(e); return e.defaultPrevented; });
    assert(rep, 'a repeated Space was not taken by the viewer (the page behind could scroll)');
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'viewer faults 5: Go to a song: the title opens the setlist (breaks as dividers, the song showing marked), a choice goes there, Escape and Back close it, one history entry, fits a phone; not offered for a single song', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const c = await importFiles(page, [await chart('Opener', 1), await chart('Ballad', 2), await chart('Closer', 3)]);
    const items = [c.Opener.id, {brk: 'Intermission'}, c.Ballad.id, c.Closer.id, c.Opener.id, c.Ballad.id, {brk: 'Encore'}, c.Closer.id, c.Opener.id, c.Ballad.id, c.Closer.id, c.Opener.id];
    await playNewSet(page, 'vf5', items);
    await oneUp(page);
    await waitFor(async () => await title(page) === c.Opener.title && (await stageNow(page)).sheets.length === 1, 'setup: the set did not start');
    const depth = () => page.evaluate(() => history.state && history.state.ss === 'viewer' ? history.state.d : 0);
    await waitFor(async () => await depth() === 1, 'setup: the song has no history entry');
    assert(await page.getAttribute('#vtop .ttl', 'role') === 'button', 'the title is not a button when the viewer was opened from a setlist');
    /* the list */
    await page.click('#vtop .ttl');
    await page.waitForSelector('.modal .jump');
    const list = await page.evaluate(() => ({songs: [...document.querySelectorAll('.modal .jump [data-qi]')].map(b => ({qi: +b.dataset.qi, t: b.querySelector('.jt').textContent, cur: b.getAttribute('aria-current')})),
      brks: [...document.querySelectorAll('.modal .jump .jbrk')].map(x => x.textContent), focus: document.activeElement?.dataset?.qi ?? null}));
    const songQi = items.map((x, i) => typeof x === 'string' ? i : -1).filter(i => i >= 0);
    assert(JSON.stringify(list.songs.map(x => x.qi)) === JSON.stringify(songQi), 'the list does not hold every song of the set in order: ' + fmt(list.songs));
    assert(JSON.stringify(list.brks) === '["Intermission","Encore"]', 'the breaks are not shown as dividers: ' + fmt(list.brks));
    assert(list.songs.filter(x => x.cur === 'true').map(x => x.qi).join() === '0' && list.focus === '0', 'the song showing is not the one marked and focused: ' + fmt(list));
    await waitFor(async () => await depth() === 2, async () => 'the list did not add one history entry: d=' + await depth());
    /* a choice goes there (the second Closer, entry 7) and the entry comes off */
    await page.click('.modal .jump [data-qi="7"]');
    await waitFor(async () => !(await page.locator('.modal').count()) && await title(page) === c.Closer.title && await pageNo(page) === 1, async () => `choosing Closer did not go there: "${await title(page)}" ${await sub(page)}`);
    assert((await sub(page)).startsWith('Song 6 of 10'), 'the counter after the jump: ' + await sub(page));
    await waitFor(async () => await depth() === 1, async () => 'the history entry of the list stayed: d=' + await depth());
    /* the keyboard: Enter on the focused title opens it (the current song marked), Escape closes it, and Space then turns the page */
    await page.focus('#vtop .ttl'); await page.keyboard.press('Enter');
    await page.waitForSelector('.modal .jump');
    assert(await page.evaluate(() => document.querySelector('.modal [aria-current]')?.dataset.qi) === '7', 'after the jump the list marks another song');
    await page.keyboard.press('Escape');
    await waitFor(async () => !(await page.locator('.modal').count()), 'Escape did not close the list');
    assert(await title(page) === c.Closer.title, 'Escape on the list changed the song');
    await waitFor(async () => await depth() === 1, async () => 'Escape left the list\'s history entry: d=' + await depth());
    await page.keyboard.press(' ');
    await waitFor(async () => await pageNo(page) === 2, async () => 'Space after closing the list did not turn the page (the title kept the focus?): ' + await sub(page));
    /* Back closes the list and leaves the song open */
    await page.click('#vtop .ttl'); await page.waitForSelector('.modal .jump');
    await waitFor(async () => await depth() === 2, 'the list did not add a history entry the second time');
    await page.goBack();
    await waitFor(async () => !(await page.locator('.modal').count()) && await page.locator('#viewer.on').count(), 'Back did not close the list, or closed the song');
    assert(await title(page) === c.Closer.title && await pageNo(page) === 2, 'Back on the list moved the song or the page');
    /* a phone: heading and Close on screen, the list scrolls inside the box */
    await page.setViewportSize({width: 360, height: 640}); await sleep(300);
    await page.click('#vtop .ttl'); await page.waitForSelector('.modal .jump');
    const fit = await page.evaluate(() => { const box = document.querySelector('.modal .box'), r = e => e.getBoundingClientRect();
      const h = r(box.querySelector('h2')), x = r(box.querySelector('[data-x]')), b = r(box);
      return {h: [h.top, h.bottom], x: [x.top, x.bottom], b: [b.left, b.right, b.top, b.bottom], scrolls: box.scrollHeight > box.clientHeight + 2}; });
    assert(fit.h[0] >= 0 && fit.x[1] <= 640 && fit.b[0] >= 0 && fit.b[1] <= 360 && fit.b[3] <= 640, 'the list does not fit a 360x640 phone: ' + fmt(fit));
    assert(fit.scrolls, 'a 10-song list at 360x640 should scroll inside its box: ' + fmt(fit));
    await page.keyboard.press('Escape');
    await waitFor(async () => !(await page.locator('.modal').count()), 'Escape did not close the list on a phone');
    await page.setViewportSize({width: 1280, height: 800}); await sleep(300);
    /* a single song from the Library: no list */
    await toLibrary(page);
    await page.click(`#libList [data-open="${c.Ballad.id}"]`);
    await waitFor(async () => await title(page) === c.Ballad.title, 'setup: the single song did not open');
    await oneUp(page);
    assert(await page.getAttribute('#vtop .ttl', 'role') === null && await page.getAttribute('#vtop .ttl', 'tabindex') === null, 'the title is a button for a single song');
    await page.click('#vtop .ttl b'); await sleep(400);
    assert(!(await page.locator('.modal').count()), 'a tap on a single song\'s title opened a list');
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'viewer faults 6: the crop editor empties its page-sized canvas when it closes (Cancel, Escape); Full screen uses the webkit-prefixed call where the plain one is missing', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.context.addInitScript(() => {
      if(!location.search.includes('nofs')) return;
      /* iPadOS 16.0-16.3: only the prefixed calls */
      /* set to undefined, not deleted: WebKit puts a deleted built-in straight back */
      const set = (o, k, v) => Object.defineProperty(o, k, {value: v, configurable: true, writable: true});
      window.__wk = 0;
      set(Element.prototype, 'requestFullscreen', undefined); set(Element.prototype, 'webkitRequestFullScreen', undefined);
      set(Document.prototype, 'exitFullscreen', undefined);
      set(Element.prototype, 'webkitRequestFullscreen', location.search.includes('nofs2') ? undefined : function(){ window.__wk++; });
    });
    await s.goto();
    const c = await importFiles(page, [await chart('Crop', 1)]);
    await toLibrary(page);
    await page.click(`#libList [data-open="${c.Crop.id}"]`);
    await oneUp(page);
    await waitFor(async () => (await stageNow(page)).sheets.length === 1, 'setup: the song did not show');
    for(const how of ['Cancel', 'Escape']){
      await page.click('#vCrop');
      await waitFor(() => page.evaluate(() => !document.querySelector('#cropper').hidden && document.querySelector('#cropCv').width > 0), `the crop editor did not draw its page (${how})`);
      if(how === 'Cancel') await page.click('#cropCancel'); else await page.keyboard.press('Escape');
      await waitFor(() => page.evaluate(() => document.querySelector('#cropper').hidden), `${how} did not close the crop editor`);
      const cv = await page.evaluate(() => [document.querySelector('#cropCv').width, document.querySelector('#cropCv').height]);
      assert(cv[0] === 0 && cv[1] === 0, `after ${how} the crop editor's canvas still holds ${cv[0]}x${cv[1]} pixels`);
    }
    /* Full screen with only the prefixed call */
    for(const [q, want] of [['?nofs', 'prefixed'], ['?nofs2', 'none']]){
      await page.goto(s.base + 'index.html' + q); await page.waitForSelector('#libList, #view');
      await toLibrary(page);
      await page.click(`#libList [data-open="${c.Crop.id}"]`);
      await page.waitForSelector('#viewer.on #stage .sheet');
      await page.evaluate(() => { document.querySelector('#viewer').classList.remove('hide'); document.querySelector('#toast').textContent = ''; });
      await page.click('#vFull'); await sleep(300);
      const r = await page.evaluate(() => ({wk: window.__wk, toast: document.querySelector('#toast').textContent}));
      if(want === 'prefixed') assert(r.wk === 1 && !r.toast.includes('not available'), 'without requestFullscreen the prefixed call was not used: ' + fmt(r));
      else assert(r.toast.includes('Full screen is not available here'), 'with no full-screen call at all the button said nothing: ' + fmt(r));
    }
    noErrors(s);
  } finally { await s.close(); }
}},
];

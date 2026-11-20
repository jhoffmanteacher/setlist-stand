/*
 * Viewer hardening: regression tests for the viewer / ink / print / service worker / dialog problems an adversarial
 * review found (each loop names the problem it guards). Closed loops where possible: what the app STORED (IndexedDB),
 * PRINTED (rendered back with pdf.js), CACHED (the service worker's cache, hashed) or SHOWED (computed styles,
 * the page number) is read back and compared with what went in.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {FIX, TMP, assert, sha256, sleep, idbAll, download} from './harness.mjs';
import {makeSiteCopy, removeCopy, intercept, cacheName, precachePaths, waitInstalled, askUpdate, until} from './site-copy.mjs';

const RED = '#d62828';
const fmt = o => JSON.stringify(o, (k, v) => typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);
const keysOf = o => Object.keys(o).sort().join();
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function waitFor(fn, what, ms = 8000){
  const end = Date.now() + ms; let v;
  while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(100); }
  throw new Error(typeof what === 'function' ? await what() : what);
}
const noErrors = s => assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));

/* ---------- driving the app (same selectors as print.loop.mjs / ink-notes.loop.mjs) ---------- */
async function toLibrary(page){
  if(await page.locator('#viewer.on').count()) await page.click('#vBack');
  await page.click('#tLib');
  await page.waitForSelector('#libList');
}
/* Imports files; returns {basename: {id, title}} found by SHA-256. */
async function importFiles(page, files){
  await toLibrary(page);
  const n0 = await page.locator('#libList [data-open]').count();
  await page.setInputFiles('#file', files);
  await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, n0 + files.length, {timeout: 20000})
    .catch(() => { throw new Error(`import of ${files.length} files did not show in the library`); });
  const songs = Object.values(await idbAll(page, 'songs')), out = {};
  for(const f of files){
    const h = sha256(fs.readFileSync(f)), s = songs.find(x => x.hash === h && !x.deleted);
    assert(s, `${path.basename(f)}: no song record with its hash`);
    out[path.basename(f)] = {id: s.id, title: s.title};
  }
  return out;
}
async function newSet(page, name, titles){
  await toLibrary(page);
  await page.click('#tSets');
  await page.click('#view [data-newset]');
  await page.locator('.modal input[type=text]').fill(name);
  await page.click('.modal [data-ok]');
  await page.waitForFunction(n => document.querySelector('#view h2')?.textContent === n, name);
  for(const t of titles){
    const n0 = await page.locator('#items > li.row').count();
    await page.click('#view [data-addto]');
    await page.locator('.modal .pick').waitFor();
    await page.locator('.modal .pick label', {hasText: new RegExp('^' + reEsc(t) + '$')}).locator('input').check();
    await page.click('.modal [data-ok]');
    await page.waitForFunction(n => document.querySelectorAll('#items > li.row').length === n, n0 + 1, {timeout: 5000});
  }
}
async function oneUp(page){
  if(await page.locator('#viewer.hide').count()){ await page.mouse.click(640, 420); await page.waitForSelector('#viewer:not(.hide)'); }
  if(await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
  await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 1 && document.querySelector('#stage .ink'), null, {timeout: 5000});
}
async function playSet(page){
  await page.click('#view [data-play]');
  await page.waitForSelector('#viewer.on #stage .sheet canvas');
  await oneUp(page);
}
async function openSong(page, id){
  await toLibrary(page);
  await page.click(`#libList [data-open="${id}"]`);
  await page.waitForSelector('#viewer.on #stage .sheet canvas');
  await oneUp(page);
}
const title = page => page.locator('#vTitle').textContent();
const pageNo = async page => +((/Page (\d+)/.exec(await page.locator('#vSub').textContent()) || [])[1] || 0);
async function annotPen(page){
  if(!(await page.locator('#tools').isVisible())) await page.click('#vAnn');
  await page.waitForSelector('#tools:not([hidden])');
  await page.click(`#tools [data-tool=pen][data-color="${RED}"]`);
}
const sheetBox = page => page.locator('#stage .sheet').first().boundingBox();
async function stroke(page, a, b, steps = 8){
  const s = await sheetBox(page), P = f => [s.x + s.width * f[0], s.y + s.height * f[1]];
  await page.mouse.move(...P(a)); await page.mouse.down();
  await page.mouse.move(...P(b), {steps}); await page.mouse.up();
}
/* Every stored ink record, with a flag per record for points that are not finite numbers (checked in the page,
   where Infinity is still Infinity). */
const inkAll = page => page.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open('setlist-stand');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => {
    const d = r.result, out = {}, c = d.transaction('ink').objectStore('ink').openCursor();
    c.onsuccess = () => {
      const k = c.result;
      if(!k){ d.close(); res(out); return; }
      const strokes = (k.value && k.value.strokes) || [];
      const bad = strokes.some(s => Array.isArray(s.p) && s.p.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1])));
      out[k.key] = {strokes: JSON.parse(JSON.stringify(strokes)), bad};
      k.continue();
    };
  };
}));
const liveOf = rec => (rec ? rec.strokes : []).filter(s => !s.deleted);

/* Renders PDF bytes with pdf.js in the page: per page its text, dark pixels and red-ink pixels. */
async function renderBack(page, bytes){
  return page.evaluate(async b64 => {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    if(!pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    const doc = await pdfjsLib.getDocument({data: u}).promise, out = [];
    for(let p = 1; p <= doc.numPages; p++){
      const pg = await doc.getPage(p), vp = pg.getViewport({scale: 1});
      const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
      await pg.render({canvasContext: c, viewport: vp}).promise;
      const d = c.getImageData(0, 0, cv.width, cv.height).data; let dark = 0, red = 0;
      for(let i = 0; i < d.length; i += 4){
        if(d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++;
        if(d[i] > 170 && d[i + 1] < 90 && d[i + 2] < 90) red++;
      }
      const tc = await pg.getTextContent();
      out.push({text: tc.items.map(i => i.str).join('').replace(/\s+/g, ' ').trim(), dark, red});
    }
    await doc.destroy();
    return out;
  }, Buffer.from(bytes).toString('base64'));
}
async function openPrint(page, withInk = true){
  await page.click('#view [data-print]');
  const m = page.locator('.modal');
  await m.waitFor();
  await m.locator('#pInk').setChecked(withInk);
  return m;
}
async function closeModal(page){
  if(await page.locator('.modal').count()){ const x = page.locator('.modal [data-x]'); await x.waitFor({timeout: 5000}); await x.click(); }
  await page.waitForFunction(() => !document.querySelector('.modal'));
}

/* ======================================================================================================== */
export const loops = [

{name: 'viewer-hardening 1a: a turn to the next SONG while a stroke is held is refused, and the mark stays in its own song', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const ids = await importFiles(page, [path.join(FIX, 'one-page.pdf'), path.join(FIX, 'two-page.pdf')]);
    const A = ids['one-page.pdf'], B = ids['two-page.pdf'];
    await newSet(page, 'Held', [A.title, B.title]);
    await playSet(page);
    assert(await title(page) === A.title, 'set did not start on ' + A.title);
    await annotPen(page);
    await stroke(page, [.2, .2], [.5, .25]);
    const s1 = await waitFor(async () => liveOf((await inkAll(page))[A.id + ':1'])[0], 'first stroke not saved');
    /* second stroke: pen down, ArrowRight (the pedal) while it is held, keep drawing, pen up */
    const sb = await sheetBox(page), P = f => [sb.x + sb.width * f[0], sb.y + sb.height * f[1]];
    await page.mouse.move(...P([.2, .6])); await page.mouse.down();
    await page.mouse.move(...P([.35, .62]), {steps: 5});
    await page.keyboard.press('ArrowRight');
    await sleep(1200);                                    // a song turn would have loaded the next song by now
    const during = await title(page);
    await page.mouse.move(...P([.5, .65]), {steps: 5});
    await page.mouse.up();
    await sleep(500);
    assert(during === A.title, `the song turned to "${during}" while the pen was down (it must stay on "${A.title}")`);
    const ink = await inkAll(page);
    const a = liveOf(ink[A.id + ':1']);
    assert(a.some(x => x.id === s1.id), `the first mark of ${A.title} is gone after a turn during a stroke: ${fmt(ink[A.id + ':1'])}`);
    assert(a.length === 2 && a.every(x => x.p.every(p => p[1] > .15 && p[1] < .7)), `${A.title} page 1 should hold 2 marks drawn on it: ${fmt(a)}`);
    assert(Object.values(ink).every(r => !r.bad), 'non-finite points stored: ' + fmt(Object.keys(ink).filter(k => ink[k].bad)));
    assert(!Object.keys(ink).some(k => k.startsWith(B.id + ':') && liveOf(ink[k]).length), `${B.title} got marks: ${fmt(ink)}`);
    /* after the pen lifts, the pedal turns again */
    await page.keyboard.press('ArrowRight');
    await waitFor(async () => await title(page) === B.title, `ArrowRight after the stroke did not turn to ${B.title}`);
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'viewer-hardening 1b: a page turn within a song while a stroke is held is refused; no Infinity is stored; switching tool mid-stroke cannot throw', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const {id} = (await importFiles(page, [path.join(FIX, 'two-page.pdf')]))['two-page.pdf'];
    await openSong(page, id);
    await annotPen(page);
    const sb = await sheetBox(page), P = f => [sb.x + sb.width * f[0], sb.y + sb.height * f[1]];
    await page.mouse.move(...P([.2, .3])); await page.mouse.down();
    await page.mouse.move(...P([.3, .32]), {steps: 4});
    await page.keyboard.press('ArrowRight');
    await sleep(800);
    const during = await pageNo(page);
    await page.mouse.move(...P([.45, .35]), {steps: 4});
    await page.mouse.up();
    await sleep(500);
    assert(during === 1, `the page turned to ${during} while the pen was down`);
    let ink = await inkAll(page);
    assert(Object.values(ink).every(r => !r.bad), 'non-finite points stored: ' + fmt(ink));
    const p1 = liveOf(ink[id + ':1']);
    assert(p1.length === 1 && p1[0].p.length > 2, 'stroke not stored whole on page 1: ' + fmt(ink));
    assert(!liveOf(ink[id + ':2']).length, 'page 2 got a mark: ' + fmt(ink[id + ':2']));
    await page.keyboard.press('ArrowRight');
    await waitFor(async () => await pageNo(page) === 2, 'ArrowRight after the stroke did not turn the page');
    /* tool switched in the middle of an eraser gesture (another finger on the toolbar): no error, nothing drawn */
    await page.click('#tools [data-tool=erase]');
    const sb2 = await sheetBox(page), Q = f => [sb2.x + sb2.width * f[0], sb2.y + sb2.height * f[1]];
    await page.mouse.move(...Q([.6, .6])); await page.mouse.down();
    await page.evaluate(c => document.querySelector(`#tools [data-tool=pen][data-color="${c}"]`).click(), RED);
    await page.mouse.move(...Q([.7, .7]), {steps: 5});
    await page.mouse.up();
    await sleep(400);
    ink = await inkAll(page);
    assert(!liveOf(ink[id + ':2']).length, 'the eraser gesture drew a stroke after the tool switch: ' + fmt(ink[id + ':2']));
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'viewer-hardening 1c: print skips non-finite points instead of failing the whole setlist', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const {id, title: t} = (await importFiles(page, [path.join(FIX, 'one-page.pdf')]))['one-page.pdf'];
    /* a damaged record as the old turn-during-stroke bug wrote it, next to a good stroke */
    await page.evaluate(([id, c]) => new Promise((res, rej) => {
      const r = indexedDB.open('setlist-stand');
      r.onsuccess = () => {
        const d = r.result, tx = d.transaction('ink', 'readwrite');
        tx.objectStore('ink').put({updated: 1, strokes: [
          {id: 'good', updated: 1, t: 'pen', c, w: .006, p: [[.2, .2], [.5, .3]]},
          {id: 'inf', updated: 1, t: 'pen', c, w: .006, p: [[.2, .6], [Infinity, Infinity], [.5, .7]]},
          {id: 'nan', updated: 1, t: 'pen', c, w: .006, p: [[NaN, NaN]]}]}, id + ':1');
        tx.oncomplete = () => { d.close(); res(); }; tx.onerror = () => rej(tx.error);
      };
      r.onerror = () => rej(r.error);
    }), [id, RED]);
    await newSet(page, 'Damaged', [t]);
    const m = await openPrint(page, true);
    const dl = await download(page, () => m.locator('[data-ok]').click()).catch(async () => { throw new Error('no PDF: ' + await page.locator('#toast').textContent()); });
    await closeModal(page);
    const pages = await renderBack(page, await fsp.readFile(dl.file));
    assert(pages.length === 1 && pages[0].red > 50 && pages[0].dark > 50, 'printed page: ' + fmt(pages));
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'viewer-hardening 2: an encrypted PDF is named in the print dialog and left out; no blank pages are printed', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    /* encrypted copy of one-page.pdf: empty user password (opens in pdf.js), owner password set */
    const enc = path.join(TMP, 'Locked Chart.pdf');
    execFileSync('python3', ['-c', `import sys
from pypdf import PdfReader, PdfWriter
w = PdfWriter(); w.append(PdfReader(sys.argv[1])); w.encrypt('', 'owner', algorithm='RC4-128'); w.write(sys.argv[2])`, path.join(FIX, 'one-page.pdf'), enc]);
    assert(fs.readFileSync(enc, 'latin1').includes('/Encrypt'), 'fixture is not encrypted');
    await s.goto();
    const ids = await importFiles(page, [path.join(FIX, 'three-page.pdf'), enc, path.join(FIX, 'two-page.pdf')]);
    const L = ids['Locked Chart.pdf'], B = ids['three-page.pdf'], A = ids['two-page.pdf'];
    await newSet(page, 'With lock', [B.title, L.title, A.title, L.title]);
    /* Cancel: nothing is saved */
    let m = await openPrint(page, true);
    let downloads = 0; const onDl = () => downloads++; page.on('download', onDl);
    await m.locator('[data-ok]').click();
    const msg = `${L.title} is password-protected, so it can't be printed; it still plays on the screen.`;
    await page.waitForFunction(t => document.querySelector('.modal')?.textContent.includes(t), msg, {timeout: 20000})
      .catch(async () => { throw new Error(`print dialog does not name the locked song. Dialog: "${await page.locator('.modal').textContent().catch(() => '(closed)')}", toast "${await page.locator('#toast').textContent()}"`); });
    const items = await page.locator('.modal li').allTextContents();
    assert(items.length === 1 && items[0] === msg, 'locked list ' + fmt(items));
    assert(await page.locator('.modal [data-ok]').textContent() === 'Print without them' && await page.locator('.modal [data-x]').textContent() === 'Cancel', 'buttons: ' + fmt(await page.locator('.modal button').allTextContents()));
    await page.click('.modal [data-x]');
    await page.waitForFunction(() => !document.querySelector('.modal'));
    await sleep(800);
    page.off('download', onDl);
    assert(downloads === 0, 'Cancel still saved a PDF');
    /* Print without them */
    m = await openPrint(page, true);
    await m.locator('[data-ok]').click();
    await page.waitForFunction(t => document.querySelector('.modal')?.textContent.includes(t), msg, {timeout: 20000});
    const dl = await download(page, () => page.click('.modal [data-ok]'));
    await closeModal(page);
    const pages = await renderBack(page, await fsp.readFile(dl.file));
    const want = ['B — page 1', 'B — page 2', 'B — page 3', 'A — page 1', 'A — page 2'].map(x => 'Fixture Song ' + x);
    assert(pages.length === want.length, `printed ${pages.length} pages, expected ${want.length}: ${fmt(pages)}`);
    pages.forEach((p, i) => {
      assert(p.text === want[i], `printed page ${i + 1} reads "${p.text}", expected "${want[i]}"`);
      assert(p.dark > 200, `printed page ${i + 1} is blank (${p.dark} dark pixels)`);
    });
    /* the locked song still plays on the screen */
    await openSong(page, L.id);
    const shown = await page.evaluate(() => { const cv = document.querySelector('#stage .sheet canvas:not(.ink)'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for(let i = 0; i < d.length; i += 4) if(d[i + 3] && d[i] < 90) n++; return n; });
    assert(shown > 100, 'the locked song does not render in the viewer');
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'viewer-hardening 3: a deploy within the HTTP cache lifetime installs the NEW files (precache bypasses max-age=600)', async run(ctx){
  const v2 = makeSiteCopy(ctx.root, {marker: 'v2-util', mutate: dir => fs.appendFileSync(path.join(dir, 'js', 'util.js'), '\n/* version 2 of util.js */\n')});
  /* every .js except sw.js answered as GitHub Pages does: Cache-Control: max-age=600 */
  const restore = intercept(ctx.server, (req, res, p) => {
    if(!p.endsWith('.js') || p === '/sw.js') return false;
    let body; try{ body = fs.readFileSync(path.resolve(ctx.server.root, '.' + p)); }catch(e){ return false; }
    ctx.server.hits.push(p);
    res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=600'}).end(body);
    return true;
  });
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    await waitInstalled(page, cacheName(ctx.root), precachePaths(ctx.root));
    ctx.server.root = v2;
    const name2 = cacheName(v2);
    for(let k = 0; k < 3; k++){
      await askUpdate(page);
      try{ await until(() => page.evaluate(async n => { const r = await navigator.serviceWorker.getRegistration(); return !!(r.waiting || (r.active && r.active.scriptURL && await caches.has(n) && !r.installing)); }, name2), 'no v2 worker', 10000); break; }
      catch(e){ if(k === 2) throw e; }
    }
    const got = await page.evaluate(async n => { const r = await (await caches.open(n)).match('js/util.js'); return r ? r.text() : null; }, name2);
    const v1Hash = sha256(fs.readFileSync(path.join(ctx.root, 'js', 'util.js'))), v2Hash = sha256(fs.readFileSync(path.join(v2, 'js', 'util.js')));
    assert(got !== null, `${name2} has no js/util.js`);
    const h = sha256(Buffer.from(got, 'utf8'));
    assert(h === v2Hash, `${name2} holds js/util.js ${h === v1Hash ? 'of VERSION 1 (from the HTTP cache)' : 'with unknown bytes'}: ${h}, want version 2 ${v2Hash}`);
    noErrors(s);
  } finally { restore(); ctx.server.root = ctx.root; await s.close(); removeCopy(v2); }
}},

{name: 'viewer-hardening 4: an update already installing when register() resolves still shows the banner', async run(ctx){
  const v2 = makeSiteCopy(ctx.root, {marker: 'v2-early'});
  /* version 2's install is slow (one big file waits 2 s), so it is still installing when the page gets the registration */
  const restore = intercept(ctx.server, (req, res, p) => {
    if(ctx.server.root !== v2 || p !== '/vendor/pdf.worker.min.js') return false;
    ctx.server.hits.push(p);
    const body = fs.readFileSync(path.join(v2, 'vendor', 'pdf.worker.min.js'));
    setTimeout(() => res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache'}).end(body), 2000);
    return true;
  });
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    await waitInstalled(page, cacheName(ctx.root), precachePaths(ctx.root));
    /* register() resolves only once a new worker is installing: its updatefound has fired before main.js listens */
    await s.context.addInitScript(() => {
      const sw = navigator.serviceWorker; if(!sw) return;
      const orig = sw.register.bind(sw);
      sw.register = (...a) => orig(...a).then(reg => new Promise(res => {
        window.__ssEarly = 'waiting';
        const go = () => { if(reg.installing){ window.__ssEarly = 'installing'; res(reg); return true; } return false; };
        if(go()) return;
        reg.addEventListener('updatefound', () => setTimeout(go, 0));
        reg.update().catch(() => {});
      }));
    });
    ctx.server.root = v2;
    await page.reload();
    await page.waitForSelector('#libList');
    await until(() => page.evaluate(() => window.__ssEarly === 'installing'), async () => 'test setup: register() never resolved with an installing worker: ' + await page.evaluate(() => window.__ssEarly), 20000);
    await until(() => page.evaluate(() => { const b = document.querySelector('#update'); return !!b && !b.hidden; }), async () => {
      const st = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return {waiting: !!r.waiting, installing: !!r.installing}; });
      return `#update never appeared for the worker that was installing when register() resolved (${fmt(st)})`;
    }, 20000);
    noErrors(s);
  } finally { restore(); ctx.server.root = ctx.root; await s.close(); removeCopy(v2); }
}},

{name: 'viewer-hardening 5: a lost pointerup does not kill taps and swipes', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const {id} = (await importFiles(page, [path.join(FIX, 'three-page.pdf')]))['three-page.pdf'];
    await openSong(page, id);
    const vw = await page.evaluate(() => innerWidth), vh = await page.evaluate(() => innerHeight);
    const R = [Math.round(vw * .85), Math.round(vh / 2)];
    const synth = (type, pointerId, isPrimary) => page.evaluate(([type, pointerId, isPrimary, x, y]) => document.querySelector('#stage').dispatchEvent(
      new PointerEvent(type, {pointerId, isPrimary, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true})), [type, pointerId, isPrimary, ...R]);
    /* a touch whose pointerup never arrives (the canvas under it was replaced) */
    await synth('pointerdown', 77, true);
    await page.mouse.click(...R);                              // a real tap on the right: next page
    await waitFor(async () => await pageNo(page) === 2, 'a tap after a lost pointerup did not turn the page');
    /* closing the viewer forgets an open gesture: a second-finger tap works right after reopening */
    await synth('pointerdown', 78, true);
    await page.click('#vBack');
    await openSong(page, id);
    const p0 = await pageNo(page);
    await synth('pointerdown', 79, false); await synth('pointerup', 79, false);
    await waitFor(async () => await pageNo(page) === p0 + 1, 'after closing the viewer an old gesture still blocked taps');
    /* a gesture over 2 s old is dropped */
    await synth('pointerdown', 80, true);
    await sleep(2200);
    await synth('pointerdown', 81, false); await synth('pointerup', 81, false);
    await waitFor(async () => await pageNo(page) === p0 + 2, 'a 2 s old gesture still blocked a tap');
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'viewer-hardening 6: colours have plain fallbacks without light-dark(), dark by media query, themes still work', async run(ctx){
  /* static: every custom property .box, .modal and body use is declared on :root with a plain value, and again in a
     prefers-color-scheme:dark block; light-dark() appears only inside @supports (color:light-dark(...)) */
  const css = fs.readFileSync(path.join(ctx.root, 'css', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = (src, depth0 = []) => {             // [{prelude, body, at: [enclosing at-rule preludes]}]
    const out = []; let i = 0;
    while(i < src.length){
      const o = src.indexOf('{', i); if(o < 0) break;
      const prelude = src.slice(i, o).trim(); let d = 1, j = o + 1;
      while(j < src.length && d){ if(src[j] === '{') d++; else if(src[j] === '}') d--; j++; }
      const body = src.slice(o + 1, j - 1);
      if(prelude.startsWith('@media') || prelude.startsWith('@supports')) out.push(...blocks(body, [...depth0, prelude]));
      else out.push({prelude, body, at: depth0});
      i = j;
    }
    return out;
  };
  const all = blocks(css);
  const used = new Set();
  for(const b of all) if(b.at.length === 0 && /(^|,)\s*(body|\.box|\.modal)\s*(,|$)/.test(b.prelude)) for(const m of b.body.matchAll(/var\(\s*(--[\w-]+)/g)) used.add(m[1]);
  assert(used.size >= 3, 'test setup: found only ' + [...used] + ' in body/.box/.modal');
  const decl = (b, k) => { const m = new RegExp('(?:^|;)\\s*' + k + '\\s*:([^;]+)').exec(b.body); return m ? m[1].trim() : null; };
  const fails = [];
  const plainRoot = all.filter(b => b.at.length === 0 && b.prelude === ':root');
  const darkMedia = all.filter(b => b.at.some(a => /prefers-color-scheme\s*:\s*dark/.test(a)) && /^:root/.test(b.prelude));
  if(!darkMedia.length) fails.push('no @media (prefers-color-scheme:dark) block for :root');
  for(const k of used){
    const v = plainRoot.map(b => decl(b, k)).find(Boolean);
    if(!v || /light-dark/.test(v)) fails.push(`${k}: no plain (non light-dark) value on :root (${v})`);
    if(k !== '--acc'){
      const dv = darkMedia.map(b => decl(b, k)).find(Boolean);
      if(!dv || /light-dark/.test(dv) || dv === v) fails.push(`${k}: no dark value in the dark media block (${dv})`);
    }
  }
  for(const b of all) if(/light-dark\(/.test(b.body) && !b.at.some(a => /^@supports\s*\(\s*color\s*:\s*light-dark\(/.test(a))) fails.push(`light-dark() outside @supports in "${b.prelude}"`);
  assert(!fails.length, fails.join('; '));

  /* live: the same CSS with light-dark() made unsupported (as iPadOS 16 to 17.4 see it) still paints solid boxes in
     both schemes; the real CSS follows the scheme and data-theme */
  const old = css.replace(/@supports\s*\(\s*color\s*:\s*light-dark\([^)]*\)\s*\)\s*\{[\s\S]*?\}\s*\}/g, '').replace(/light-dark\(/g, 'no-such-fn(');
  const probe = page => page.evaluate(() => {
    const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = '<div class="box">x</div>'; document.body.append(m);
    const r = {box: getComputedStyle(m.firstChild).backgroundColor, ink: getComputedStyle(m.firstChild).color, body: getComputedStyle(document.body).backgroundColor};
    m.remove(); return r;
  });
  const OPAQUE = /^rgb\(\d+, \d+, \d+\)$/;
  for(const [label, override] of [['without light-dark()', old], ['real CSS', null]]){
    if(override) ctx.server.overrides.set('/css/app.css', Buffer.from(override)); else ctx.server.overrides.delete('/css/app.css');
    const context = await ctx.browser.newContext({serviceWorkers: 'block'}), page = await context.newPage();
    try{
      await page.goto(ctx.base + 'index.html'); await page.waitForSelector('#view');
      const res = {};
      for(const scheme of ['light', 'dark']){ await page.emulateMedia({colorScheme: scheme}); res[scheme] = await probe(page); }
      for(const sc of ['light', 'dark']) for(const k of ['box', 'ink', 'body']) assert(OPAQUE.test(res[sc][k]), `${label}, ${sc}: ${k} colour is ${res[sc][k]} (not solid)`);
      assert(res.light.box === 'rgb(255, 255, 255)' && res.dark.box === 'rgb(33, 35, 41)', `${label}: box light ${res.light.box}, dark ${res.dark.box}`);
      if(!override){
        await page.evaluate(() => document.documentElement.dataset.theme = 'light');
        const l = await probe(page);
        await page.emulateMedia({colorScheme: 'light'});
        await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
        const d = await probe(page);
        assert(l.box === 'rgb(255, 255, 255)' && d.box === 'rgb(33, 35, 41)', `data-theme: light in a dark system gives ${l.box}, dark in a light system gives ${d.box}`);
      }
    } finally { ctx.server.overrides.delete('/css/app.css'); await context.close(); }
  }
}},

{name: 'viewer-hardening 7: Enter on Cancel in Edit song does not save; Enter in a field still does', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const {id, title: t} = (await importFiles(page, [path.join(FIX, 'one-page.pdf')]))['one-page.pdf'];
    const song = async () => (await idbAll(page, 'songs'))[id];
    const before = await song();
    await page.click(`#libList [data-edit="${id}"]`);
    await page.locator('.modal input[data-k=song]').fill('Changed by mistake');
    await page.locator('.modal [data-x]').focus();
    assert(await page.evaluate(() => document.activeElement?.hasAttribute('data-x')), 'test setup: Cancel is not focused');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000})
      .catch(async () => { throw new Error('Enter on Cancel did not close the dialog; focus on ' + await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))); });
    await sleep(500);
    const after = await song();
    assert(after.song === before.song && after.title === t, `Enter on Cancel saved: song "${after.song}", title "${after.title}" (was "${before.song}")`);
    await page.click(`#libList [data-edit="${id}"]`);
    await page.locator('.modal input[data-k=song]').fill('Saved On Purpose');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000})
      .catch(async () => { throw new Error('Enter in the title field did not close the dialog: ' + await page.evaluate(() => JSON.stringify({modals: document.querySelectorAll('.modal').length, focus: document.activeElement?.outerHTML.slice(0, 80), text: document.querySelector('.modal')?.textContent.slice(0, 80)}))); });
    await waitFor(async () => (await song()).song === 'Saved On Purpose', 'Enter in the title field did not save');
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'viewer-hardening 8: Undo of a mark on a song no longer open leaves a deletion marker', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const ids = await importFiles(page, [path.join(FIX, 'one-page.pdf'), path.join(FIX, 'two-page.pdf')]);
    const A = ids['one-page.pdf'], B = ids['two-page.pdf'];
    await newSet(page, 'Undo', [A.title, B.title]);
    await playSet(page);
    await annotPen(page);
    await stroke(page, [.2, .2], [.5, .25]);
    await waitFor(async () => liveOf((await inkAll(page))[A.id + ':1']).length === 1, 'first stroke not saved');
    await stroke(page, [.2, .5], [.5, .55]);
    const s2 = await waitFor(async () => { const l = liveOf((await inkAll(page))[A.id + ':1']); return l.length === 2 && l[1]; }, 'second stroke not saved');
    await page.keyboard.press('ArrowRight');
    await waitFor(async () => await title(page) === B.title, 'did not turn to the second song');
    await page.click('#tUndo');
    const rec = await waitFor(async () => { const r = (await inkAll(page))[A.id + ':1']; return r && !liveOf(r).some(x => x.id === s2.id) ? r : null; }, 'Undo did not remove the second stroke of the closed song');
    const mk = rec.strokes.find(x => x.id === s2.id);
    assert(mk && mk.deleted === true && keysOf(mk) === 'deleted,id,updated' && mk.updated >= s2.updated, `undone stroke left no deletion marker: ${fmt(rec.strokes)}`);
    assert(liveOf(rec).length === 1, 'first stroke lost: ' + fmt(rec.strokes));
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'viewer-hardening 9: a re-render in the middle of a drag ends that drag (no endless frames, the next move works)', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const ids = await importFiles(page, ['one-page.pdf', 'two-page.pdf', 'three-page.pdf'].map(f => path.join(FIX, f)));
    const titles = Object.values(ids).map(x => x.title);
    await newSet(page, 'Drag', titles);
    const h = await page.locator('#items > li.row').nth(0).locator('.handle').boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 + 30, {steps: 4});
    await page.evaluate(() => {
      const raf = window.requestAnimationFrame.bind(window);
      window.__rafN = 0; window.requestAnimationFrame = cb => { window.__rafN++; return raf(cb); };
      document.querySelector('#tSets').click();                    // the view re-renders under the drag
    });
    await sleep(300);
    const n0 = await page.evaluate(() => window.__rafN); await sleep(600);
    const frames = await page.evaluate(() => window.__rafN) - n0;
    /* the pen lifts somewhere outside the list (the header) */
    const top = await page.locator('header.top h1').boundingBox();
    await page.mouse.move(top.x + 5, top.y + 5, {steps: 3}); await page.mouse.up();
    assert(frames < 3, `the drag kept its animation loop running after the list re-rendered: ${frames} frames in 0.6 s`);
    /* the next keyboard move and drag work */
    await page.locator('#view [data-set]').first().click();
    await page.waitForSelector('#items .handle');
    await page.locator('#items > li.row').nth(0).locator('.handle').focus();
    await page.keyboard.press('ArrowDown');
    await waitFor(async () => (await page.locator('#items > li.row .t').allTextContents())[1]?.startsWith(titles[0]), async () => 'keyboard move after the interrupted drag did nothing: ' + fmt(await page.locator('#items > li.row .t').allTextContents()));
    noErrors(s);
  } finally { await s.close(); }
}},
{name: 'viewer-hardening 10: a gesture that never gets a pen-up goes stale after 3 s; Back ends it; both marks are saved on their own pages', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const {id} = (await importFiles(page, [path.join(FIX, 'two-page.pdf')]))['two-page.pdf'];
    await openSong(page, id);
    await annotPen(page);
    /* a pen stroke whose pointerup and pointercancel never arrive (the app was switched away mid-stroke) */
    const stuck = (pid, pts) => page.evaluate(([pid, pts]) => {
      const cv = document.querySelector('#stage .ink'), b = cv.getBoundingClientRect();
      pts.forEach((f, i) => cv.dispatchEvent(new PointerEvent(i ? 'pointermove' : 'pointerdown',
        {pointerId: pid, isPrimary: true, pointerType: 'pen', clientX: b.x + b.width * f[0], clientY: b.y + b.height * f[1], bubbles: true, cancelable: true})));
    }, [pid, pts]);
    await stuck(55, [[.2, .3], [.3, .32], [.4, .34]]);
    await page.keyboard.press('ArrowRight');
    await sleep(500);
    assert(await pageNo(page) === 1, 'test setup: a fresh gesture should still block the turn');
    await sleep(3000);
    await page.keyboard.press('ArrowRight');
    await waitFor(async () => await pageNo(page) === 2, 'page turns stay blocked after 3 s with no event from the stuck pen');
    await stroke(page, [.3, .6], [.6, .65]);
    let ink = await waitFor(async () => { const k = await inkAll(page); return liveOf(k[id + ':1']).length === 1 && liveOf(k[id + ':2']).length === 1 ? k : null; },
      async () => 'after the stale window a new pen-down did not give one mark on each page: ' + fmt(await inkAll(page)));
    assert(liveOf(ink[id + ':1'])[0].p.every(p => Math.abs(p[1] - .32) < .04), 'the stuck stroke was not saved where it was drawn: ' + fmt(ink[id + ':1']));
    /* a fresh stuck gesture (on page 2, shown now), then Back: it is saved there and the next pen-down works at once */
    await stuck(56, [[.2, .8], [.4, .82]]);
    await page.click('#vBack');
    await openSong(page, id);
    await annotPen(page);
    await stroke(page, [.5, .1], [.8, .12]);
    ink = await waitFor(async () => { const k = await inkAll(page); return liveOf(k[id + ':1']).length === 2 && liveOf(k[id + ':2']).length === 2 ? k : null; },
      async () => 'after Back ended a stuck gesture (on page 2), page 1 should hold 2 marks and page 2 two: ' + fmt(await inkAll(page)));
    assert(liveOf(ink[id + ':2']).length === 2, 'the gesture open at Back was not saved on page 2: ' + fmt(ink[id + ':2']));
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'viewer-hardening 11: Undo and Clear tapped while the pen is held change nothing', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const {id} = (await importFiles(page, [path.join(FIX, 'one-page.pdf')]))['one-page.pdf'];
    await openSong(page, id);
    await annotPen(page);
    await stroke(page, [.2, .2], [.5, .25]);
    const s1 = await waitFor(async () => liveOf((await inkAll(page))[id + ':1'])[0], 'first stroke not saved');
    const sb = await sheetBox(page), P = f => [sb.x + sb.width * f[0], sb.y + sb.height * f[1]];
    const saved = async () => JSON.stringify((await inkAll(page))[id + ':1'].strokes);
    const before = await saved();
    await page.mouse.move(...P([.2, .6])); await page.mouse.down();
    await page.mouse.move(...P([.35, .62]), {steps: 4});
    await page.evaluate(() => document.querySelector('#tUndo').click());          // a finger on Undo
    await sleep(400);
    const afterUndo = await saved();
    await page.evaluate(() => { document.querySelector('#tClear').click(); document.querySelector('#tClear').click(); });
    await sleep(400);
    const afterClear = await saved();
    await page.mouse.move(...P([.5, .65]), {steps: 4}); await page.mouse.up();
    assert(afterUndo === before, 'Undo during a held stroke changed the saved page: ' + afterUndo);
    assert(afterClear === before, 'Clear during a held stroke changed the saved page: ' + afterClear);
    const end = await waitFor(async () => { const l = liveOf((await inkAll(page))[id + ':1']); return l.length === 2 ? l : null; }, async () => 'after the pen lifted: ' + await saved());
    assert(end.some(x => x.id === s1.id), 'first stroke lost');
    /* after the pen lifts, Undo works again */
    await page.click('#tUndo');
    await waitFor(async () => liveOf((await inkAll(page))[id + ':1']).length === 1, 'Undo after the pen lifted did nothing');
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'viewer-hardening 12: a controllerchange while a song is open never reloads, even after an earlier banner tap', async run(ctx){
  const v2 = makeSiteCopy(ctx.root, {marker: 'v2-playing'});
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    await waitInstalled(page, cacheName(ctx.root), precachePaths(ctx.root));
    await page.reload(); await page.waitForSelector('#libList');
    const {id} = (await importFiles(page, [path.join(FIX, 'one-page.pdf')]))['one-page.pdf'];
    ctx.server.root = v2;
    for(let k = 0; k < 3; k++){
      await askUpdate(page);
      try{ await until(() => page.evaluate(() => !document.querySelector('#update').hidden), 'no banner', 10000); break; }
      catch(e){ if(k === 2) throw e; }
    }
    /* the tap's skip-waiting never takes effect (as when that worker goes redundant): no controllerchange follows */
    await page.evaluate(() => { ServiceWorker.prototype.postMessage = () => {}; window.__ssStay = 1; });
    await page.click('#update');
    await sleep(800);
    assert(await page.evaluate(() => window.__ssStay) === 1, 'test setup: the tap reloaded');
    await openSong(page, id);
    assert(await page.evaluate(() => document.body.classList.contains('playing')), 'test setup: body.playing not set');
    let navs = 0; page.on('framenavigated', f => { if(f === page.mainFrame()) navs++; });
    await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));   // another tab tapped its banner
    await sleep(2000);
    const stayed = await page.evaluate(() => window.__ssStay).catch(() => null);
    assert(navs === 0 && stayed === 1, `the tab reloaded mid-song on a controllerchange (navigations ${navs})`);
    assert(await page.locator('#viewer.on').count() === 1, 'the song is no longer open');
    noErrors(s);
  } finally { ctx.server.root = ctx.root; await s.close(); removeCopy(v2); }
}},
];

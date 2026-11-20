/*
 * Setlist Stand smoke test: node tools/smoke.mjs
 *
 * Serves the repo root on a free localhost port, drives headless Chromium
 * (Playwright) at 1280x800 and prints one line per step:
 *   PASS: <step>   or   FAIL: <step>: <why>   (later steps print SKIP)
 * Exits 1 on any failure. A failure screenshot goes to os.tmpdir().
 *
 * To add a step: write `async function stepX(t){ ... }` that throws on failure
 * and append ['name', stepX] to STEPS. `t` holds page, context, base URL and
 * a `data` object steps use to hand values to later steps.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {chromium} from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
/* The vendor files are UMD, but package.json says "type":"module", so a plain
   require() would load them as ESM. Evaluate them as CommonJS instead. */
const require = createRequire(import.meta.url);
function requireUmd(f){
  const module = {exports: {}};
  const fn = vm.runInThisContext(`(function(exports, require, module, __filename, __dirname){${fs.readFileSync(f, 'utf8')}\n})`, {filename: f});
  fn.call(module.exports, module.exports, require, module, f, path.dirname(f));
  return module.exports;
}
const {PDFDocument} = requireUmd(path.join(ROOT, 'vendor', 'pdf-lib.min.js'));
const JSZip = requireUmd(path.join(ROOT, 'vendor', 'jszip.min.js'));

/* ---------- tiny static server ---------- */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
function startServer(){
  const srv = http.createServer(async (req, res) => {
    try{
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if(p.endsWith('/')) p += 'index.html';
      const f = path.resolve(ROOT, '.' + p);
      if(!f.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
      const body = await fsp.readFile(f);
      res.writeHead(200, {'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
      res.end(req.method === 'HEAD' ? undefined : body);
    }catch(e){ res.writeHead(404, {'Content-Type': 'text/plain'}).end('not found'); }
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

/* ---------- helpers ---------- */
function assert(c, msg){ if(!c) throw new Error(msg); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFixtures(){
  const need = ['one-page.pdf', 'two-page.pdf', 'three-page.pdf'].map(f => path.join(FIX, f));
  for(let i = 0; i < 13; i++){
    if(need.every(f => fs.existsSync(f))) return;
    if(i === 0) console.log('waiting for tests/fixtures (node tools/make-fixtures.mjs)…');
    await sleep(20000);
  }
  throw new Error('fixtures missing: ' + need.filter(f => !fs.existsSync(f)).join(', '));
}

/* Reads every key/value of an IndexedDB store in the page. */
const idbAll = (page, store) => page.evaluate(store => new Promise((res, rej) => {
  const r = indexedDB.open('setlist-stand');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => {
    const d = r.result, out = {};
    if(!d.objectStoreNames.contains(store)){ d.close(); res(out); return; }
    const s = d.transaction(store).objectStore(store), c = s.openCursor();
    c.onsuccess = () => { const k = c.result; if(k){ out[k.key] = k.value instanceof Blob ? 'blob:' + k.value.size : k.value; k.continue(); } else { d.close(); res(out); } };
    c.onerror = () => rej(c.error);
  };
}), store);

const subText = page => page.locator('#vSub').textContent();
async function waitSub(page, re, what){
  try{ await page.waitForFunction(src => new RegExp(src).test(document.querySelector('#vSub').textContent), re.source, {timeout: 5000}); }
  catch(e){ throw new Error(`${what}: expected #vSub ~ ${re}, got "${await subText(page)}"`); }
}
/* True when a canvas has any non-transparent pixel (ink) or any non-white pixel (page). */
const canvasHasMarks = (page, sel, mode) => page.evaluate(([sel, mode]) => {
  const cv = document.querySelector(sel); if(!cv || !cv.width) return false;
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  for(let i = 0; i < d.length; i += 4){
    if(mode === 'ink' ? d[i + 3] > 0 : (d[i + 3] > 0 && (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200))) return true;
  }
  return false;
}, [sel, mode]);

async function songCount(page){ return page.locator('#libList [data-open]').count(); }
async function toLibrary(page){
  if(await page.locator('#viewer.on').count()) await page.click('#vBack');
  await page.click('#tLib');
  await page.waitForSelector('#libList');
}
async function openSong(page, title){
  await toLibrary(page);
  await page.locator('#libList [data-open]', {hasText: title}).click();
  await page.waitForSelector('#viewer.on #stage .sheet canvas');
  await page.waitForFunction(t => document.querySelector('#vTitle').textContent === t, title);
}
async function stageTap(page, fx){ await page.mouse.click(Math.round(1280 * fx), 420); }
async function download(page, action){
  const [dl] = await Promise.all([page.waitForEvent('download', {timeout: 20000}), action()]);
  const f = path.join(TMP, `${Date.now()}-${dl.suggestedFilename()}`);
  await dl.saveAs(f);
  return {file: f, name: dl.suggestedFilename()};
}

/* ---------- steps ---------- */
async function stepLoad(t){
  const {page} = t;
  await page.goto(t.base + 'index.html');
  await page.waitForSelector('#libList');
  const sw = await page.evaluate(async () => {
    if(!('serviceWorker' in navigator)) return {err: 'no serviceWorker API'};
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 15000))]);
    if(!reg) return {err: 'navigator.serviceWorker.ready did not resolve in 15s (install failed? check every PRECACHE file exists)'};
    return {state: reg.active && reg.active.state, scope: reg.scope};
  });
  assert(!sw.err, sw.err);
  assert(sw.state === 'activated' || sw.state === 'activating', 'service worker state ' + sw.state);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {timeout: 10000})
    .catch(() => { throw new Error('page is not controlled by the service worker'); });
  const man = await page.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]')?.getAttribute('href');
    if(!href) return {err: 'no <link rel=manifest>'};
    const r = await fetch(href); if(!r.ok) return {err: href + ' HTTP ' + r.status};
    try{ const j = await r.json(); return {name: j.name, icons: (j.icons || []).length}; }catch(e){ return {err: 'manifest is not JSON'}; }
  });
  assert(!man.err, man.err);
  assert(man.name, 'manifest has no name');
}

async function stepAdd(t){
  const {page} = t;
  await page.setInputFiles('#file', [path.join(FIX, 'two-page.pdf'), path.join(FIX, 'three-page.pdf')]);
  await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 2, null, {timeout: 15000})
    .catch(async () => { throw new Error(`expected 2 songs, library shows ${await songCount(page)}`); });
  const text = await page.locator('#libList').innerText();
  assert(/two-page/.test(text) && /three-page/.test(text), 'titles missing in library: ' + text.replace(/\s+/g, ' '));
  assert(/2 pages/.test(text) && /3 pages/.test(text), 'page counts missing in library: ' + text.replace(/\s+/g, ' '));
}

async function stepTwoUp(t){
  const {page} = t;
  await openSong(page, 'two-page');
  await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 2, null, {timeout: 8000})
    .catch(async () => { throw new Error(`expected 2 .sheet in landscape, got ${await page.locator('#stage .sheet').count()}`); });
  const boxes = await page.locator('#stage .sheet').evaluateAll(els => els.map(e => e.getBoundingClientRect().toJSON()));
  assert(boxes[1].left >= boxes[0].right - 1 && Math.abs(boxes[0].top - boxes[1].top) < 2, 'sheets are not side by side');
  await waitSub(page, /Page 1–2 of 2/, 'two-up subtitle');
  assert(await canvasHasMarks(page, '#stage .sheet canvas:not(.ink)', 'page'), 'page canvas looks blank');
}

async function stepTurns(t){
  const {page} = t;
  await openSong(page, 'three-page');
  if(await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
  await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 1, null, {timeout: 5000})
    .catch(() => { throw new Error('one page per view did not show a single .sheet'); });
  await waitSub(page, /^Page 1 of 3$/, 'start');
  await stageTap(page, 0.85);
  await waitSub(page, /^Page 2 of 3$/, 'tap right 30%');
  await page.mouse.move(900, 420); await page.mouse.down();
  await page.mouse.move(800, 422, {steps: 4}); await page.mouse.move(650, 424, {steps: 4});
  await page.mouse.up();
  await waitSub(page, /^Page 3 of 3$/, 'swipe left');
  await page.keyboard.press('ArrowLeft');
  await waitSub(page, /^Page 2 of 3$/, 'ArrowLeft');
  await stageTap(page, 0.12);
  await waitSub(page, /^Page 1 of 3$/, 'tap left 30%');
  await page.keyboard.press('ArrowRight');
  await waitSub(page, /^Page 2 of 3$/, 'ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await waitSub(page, /^Page 1 of 3$/, 'ArrowLeft back to page 1');
}

async function stepAnnotate(t){
  const {page} = t;
  /* still in the three-page song, one page per view, page 1 */
  await page.click('#vAnn');
  assert(await page.locator('#tools').isVisible(), '#tools did not show after Annotate');
  const b = await page.locator('#stage .sheet').first().boundingBox();
  const x0 = b.x + b.width * .3, y0 = b.y + b.height * .4;
  await page.mouse.move(x0, y0); await page.mouse.down();
  for(let i = 1; i <= 10; i++) await page.mouse.move(x0 + i * b.width * .04, y0 + i * b.height * .01);
  await page.mouse.up();
  await waitSub(page, /^Page 1 of 3$/, 'drawing must not turn the page');
  let key = null, strokes = null;
  for(let i = 0; i < 25 && !key; i++){
    const ink = await idbAll(page, 'ink');
    for(const [k, v] of Object.entries(ink)) if(k.endsWith(':1') && Array.isArray(v) && v.length){ key = k; strokes = v; }
    if(!key) await sleep(200);
  }
  assert(key, 'no stroke saved in IndexedDB ink store');
  const s = strokes[0];
  assert(s.p.length >= 2, 'stroke has ' + s.p.length + ' points');
  assert(s.p.every(p => p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1), 'stroke points not in 0..1: ' + JSON.stringify(s.p.slice(0, 3)));
  assert(s.t === 'pen' && /^#[0-9a-f]{6}$/i.test(s.c) && s.w > 0 && s.w < 1, 'stroke shape wrong: ' + JSON.stringify({t: s.t, c: s.c, w: s.w}));
  t.data.inkKey = key;
  await page.click('#tDone');

  await page.reload();
  await page.waitForSelector('#libList [data-open]');
  const after = await idbAll(page, 'ink');
  assert(Array.isArray(after[key]) && after[key].length === strokes.length, 'stroke not stored after reload');
  await openSong(page, 'three-page');
  await waitSub(page, /^Page 1 of 3$/, 'reopen');
  await page.waitForFunction(() => {
    const cv = document.querySelector('#stage .ink[data-pn="1"]'); if(!cv) return false;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    for(let i = 3; i < d.length; i += 4) if(d[i]) return true;
    return false;
  }, null, {timeout: 5000}).catch(() => { throw new Error('ink canvas is blank after reopening the song'); });
}

async function stepOffline(t){
  const {page, context} = t;
  await toLibrary(page);
  await context.setOffline(true);
  try{
    await page.reload();
    await page.waitForSelector('#libList', {timeout: 10000}).catch(() => { throw new Error('app did not load offline'); });
    await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 2, null, {timeout: 8000})
      .catch(async () => { throw new Error(`offline library shows ${await songCount(page)} songs`); });
    assert(await page.evaluate(() => !!window.pdfjsLib && !!window.PDFLib && !!window.JSZip), 'vendor libs missing offline');
    /* Guard against a vacuous pass: an uncached file must not load. */
    const leaked = await page.evaluate(() => fetch('tools/README.md').then(r => r.ok, () => false));
    assert(!leaked, 'network still reachable while offline; offline check would prove nothing');
    await openSong(page, 'two-page');
    await page.waitForFunction(() => {
      const cv = document.querySelector('#stage .sheet canvas'); if(!cv) return false;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      for(let i = 0; i < d.length; i += 4) if(d[i + 3] && d[i] < 200) return true;
      return false;
    }, null, {timeout: 10000}).catch(() => { throw new Error('song canvas did not render offline (pdf.worker cached?)'); });
    await page.click('#vBack');
  } finally { await context.setOffline(false); }
  checkHosts(t);
}

function checkHosts(t){
  const bad = t.external.filter(u => !/^(blob|data):/.test(u));
  assert(!bad.length, 'requests to non-localhost hosts: ' + [...new Set(bad)].slice(0, 5).join(', '));
}

async function printSet(page, withInk){
  await page.click('#view [data-print]');
  const m = page.locator('.modal');
  await m.waitFor();
  await m.locator('#pInk').setChecked(withInk);
  const dl = await download(page, () => m.locator('[data-ok]').click());
  /* Where the browser can share files the dialog stays open with Done. */
  if(await page.locator('.modal').count()){
    const x = page.locator('.modal [data-x]');
    await x.waitFor({timeout: 5000});
    await x.click();
  }
  await page.waitForFunction(() => !document.querySelector('.modal'));
  return dl;
}

async function stepSetlist(t){
  const {page} = t;
  await toLibrary(page);
  await page.click('#tSets');
  await page.click('#view [data-newset]');
  await page.locator('.modal input[type=text]').fill('Gig');
  await page.click('.modal [data-ok]');
  await page.waitForSelector('#view [data-addto]');
  await page.click('#view [data-addto]');
  const boxes = page.locator('.modal .pick input[type=checkbox]');
  await boxes.first().waitFor();
  assert(await boxes.count() === 2, 'pick list has ' + await boxes.count() + ' songs');
  for(let i = 0; i < 2; i++) await boxes.nth(i).check();
  await page.click('.modal [data-ok]');
  await page.waitForFunction(() => document.querySelectorAll('#view [data-playat]').length === 2, null, {timeout: 5000})
    .catch(() => { throw new Error('setlist did not show 2 songs after Add'); });
  await page.click('#view [data-allsets]');
  const row = page.locator('#view [data-set]', {hasText: 'Gig'});
  await row.waitFor();
  assert(/2 songs/.test(await row.innerText()), 'setlist row does not say 2 songs');
  await row.click();
  await page.waitForSelector('#view [data-print]:not([disabled])');

  const out = {};
  for(const withInk of [true, false]){
    const dl = await printSet(page, withInk);
    assert(/\.pdf$/.test(dl.name), 'download name ' + dl.name);
    const bytes = await fsp.readFile(dl.file);
    const doc = await PDFDocument.load(bytes);
    assert(doc.getPageCount() === 5, `${withInk ? 'with' : 'without'} annotations: PDF has ${doc.getPageCount()} pages, expected 5`);
    out[withInk] = bytes.length;
  }
  assert(out[true] > out[false], `PDF with annotations (${out[true]} B) is not larger than without (${out[false]} B)`);
}

async function stepBackup(t){
  const {page} = t;
  await toLibrary(page);
  const dl = await download(page, () => page.click('#view [data-backup]'));
  assert(/\.zip$/.test(dl.name), 'backup name ' + dl.name);
  const zip = await JSZip.loadAsync(await fsp.readFile(dl.file));
  const lj = zip.file('library.json'); assert(lj, 'zip has no library.json');
  const data = JSON.parse(await lj.async('string'));
  assert(data.app === 'setlist-stand', 'library.json app = ' + data.app);
  assert(data.songs.length === 2, 'library.json songs = ' + data.songs.length);
  assert(data.sets.length === 1, 'library.json sets = ' + data.sets.length);
  assert(data.ink && Array.isArray(data.ink[t.data.inkKey]) && data.ink[t.data.inkKey].length, 'library.json lacks ink key ' + t.data.inkKey);
  for(const s of data.songs) assert(zip.file('files/' + s.id + '.pdf'), 'zip lacks files/' + s.id + '.pdf');

  for(let i = 0; i < 2; i++){
    const b = page.locator('#libList [data-del]').first();
    await b.click();
    assert(await b.textContent() === 'Tap again', 'first tap on Delete did not arm it');
    assert(await songCount(page) === 2 - i, 'one tap deleted a song');
    await b.click();
    await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, 1 - i, {timeout: 5000})
      .catch(async () => { throw new Error(`after delete expected ${1 - i} songs, got ${await songCount(page)}`); });
  }
  assert(await page.locator('#libList .empty').count(), 'library does not show the empty state');
  const ink0 = await idbAll(page, 'ink');
  assert(!ink0[t.data.inkKey], 'ink not deleted with its song');

  await page.setInputFiles('#restoreFile', dl.file);
  await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 2, null, {timeout: 15000})
    .catch(async () => { throw new Error(`after restore library shows ${await songCount(page)} songs`); });
  const ink1 = await idbAll(page, 'ink');
  assert(Array.isArray(ink1[t.data.inkKey]) && ink1[t.data.inkKey].length, 'ink not restored');
  await page.click('#tSets');
  const row = page.locator('#view [data-set]', {hasText: 'Gig'});
  await row.waitFor({timeout: 5000});
  assert(/2 songs/.test(await row.innerText()), 'restored setlist row: ' + (await row.innerText()).replace(/\s+/g, ' '));
  await openSong(page, 'three-page');
  await page.waitForFunction(() => {
    const cv = document.querySelector('#stage .ink[data-pn="1"]'); if(!cv) return false;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    for(let i = 3; i < d.length; i += 4) if(d[i]) return true;
    return false;
  }, null, {timeout: 5000}).catch(() => { throw new Error('restored ink not drawn on the song'); });
  await page.click('#vBack');
}

async function stepNoExternal(t){ checkHosts(t); }

const STEPS = [
  ['1 app loads, service worker active, manifest reachable', stepLoad],
  ['2 add two PDFs to the library', stepAdd],
  ['3 two-page song shows two pages side by side', stepTwoUp],
  ['4 page turns: tap, swipe, arrow keys', stepTurns],
  ['5 annotate: stroke saved, survives reload, drawn on reopen', stepAnnotate],
  ['6 offline reload: library and song still work', stepOffline],
  ['7 setlist Gig: add songs, print PDF with and without annotations', stepSetlist],
  ['8 backup, delete everything, restore', stepBackup],
  ['9 no request left localhost during the run', stepNoExternal],
];

/* ---------- runner ---------- */
const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'setlist-smoke-'));
let failed = 0, server, browser;
try{
  await waitFixtures();
  server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 1280, height: 800}, acceptDownloads: true});
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const t = {page, context, base, data: {}, external: [], errors: []};
  context.on('request', r => { const u = r.url(); try{ const h = new URL(u).hostname; if(!['127.0.0.1', 'localhost'].includes(h)) t.external.push(u); }catch(e){ t.external.push(u); } });
  page.on('pageerror', e => t.errors.push(String(e && e.message || e)));
  let stop = false;
  for(const [name, fn] of STEPS){
    if(stop){ console.log(`SKIP: ${name}`); continue; }
    try{ await fn(t); console.log(`PASS: ${name}`); }
    catch(e){
      failed++; stop = true;
      const shot = path.join(TMP, 'fail-' + name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40) + '.png');
      try{ await page.screenshot({path: shot}); }catch(err){}
      console.log(`FAIL: ${name}: ${String(e && e.message || e).split('\n')[0]}`);
      console.log(`      screenshot: ${shot}`);
      if(t.errors.length) console.log('      page errors: ' + t.errors.slice(-3).join(' | '));
    }
  }
  await context.close();
}catch(e){
  failed++;
  console.log(`FAIL: setup: ${e && e.message || e}`);
}finally{
  if(browser) await browser.close().catch(() => {});
  if(server) server.close();
}
process.exit(failed ? 1 : 0);

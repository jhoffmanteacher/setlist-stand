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
import {splitName, displayName} from '../js/names.js';

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

/* Ink records are {updated, strokes:[...]}; live strokes are those without `deleted`. */
const ink0Shape = (ink, key) => ink[key] && ink[key].strokes;
const liveOf = v => (v && Array.isArray(v.strokes) ? v.strokes : []).filter(s => !s.deleted);

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
  assert(/Two-page/.test(text) && /Three-page/.test(text), 'titles (title-cased) missing in library: ' + text.replace(/\s+/g, ' '));
  assert(/2 pages/.test(text) && /3 pages/.test(text), 'page counts missing in library: ' + text.replace(/\s+/g, ' '));
}

async function stepTwoUp(t){
  const {page} = t;
  await openSong(page, 'Two-page');
  await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 2, null, {timeout: 8000})
    .catch(async () => { throw new Error(`expected 2 .sheet in landscape, got ${await page.locator('#stage .sheet').count()}`); });
  const boxes = await page.locator('#stage .sheet').evaluateAll(els => els.map(e => e.getBoundingClientRect().toJSON()));
  assert(boxes[1].left >= boxes[0].right - 1 && Math.abs(boxes[0].top - boxes[1].top) < 2, 'sheets are not side by side');
  await waitSub(page, /Page 1–2 of 2/, 'two-up subtitle');
  assert(await canvasHasMarks(page, '#stage .sheet canvas:not(.ink)', 'page'), 'page canvas looks blank');
}

async function stepTurns(t){
  const {page} = t;
  await openSong(page, 'Three-page');
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
    for(const [k, v] of Object.entries(ink)) if(k.endsWith(':1') && liveOf(v).length){ key = k; strokes = liveOf(v); }
    if(!key) await sleep(200);
  }
  assert(key, 'no stroke saved in IndexedDB ink store');
  assert(Array.isArray(ink0Shape(await idbAll(page, 'ink'), key)), 'ink record is not {updated, strokes:[]}');
  const s = strokes[0];
  assert(typeof s.id === 'string' && s.id && s.updated > 0, 'stroke lacks id/updated: ' + JSON.stringify({id: s.id, updated: s.updated}));
  assert(s.p.length >= 2, 'stroke has ' + s.p.length + ' points');
  assert(s.p.every(p => p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1), 'stroke points not in 0..1: ' + JSON.stringify(s.p.slice(0, 3)));
  assert(s.t === 'pen' && /^#[0-9a-f]{6}$/i.test(s.c) && s.w > 0 && s.w < 1, 'stroke shape wrong: ' + JSON.stringify({t: s.t, c: s.c, w: s.w}));
  t.data.inkKey = key;
  await page.click('#tDone');

  await page.reload();
  await page.waitForSelector('#libList [data-open]');
  const after = await idbAll(page, 'ink');
  assert(liveOf(after[key]).length === strokes.length, 'stroke not stored after reload');
  await openSong(page, 'Three-page');
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
    await openSong(page, 'Two-page');
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
  assert(data.version === 2, 'library.json version = ' + data.version);
  assert(data.songs.length === 2, 'library.json songs = ' + data.songs.length);
  assert(data.sets.length === 1, 'library.json sets = ' + data.sets.length);
  assert(songIds(data.sets[0]).length === 2, 'library.json set Gig items: ' + JSON.stringify(data.sets[0].items));
  assert(data.ink && data.ink[t.data.inkKey] && liveOf(data.ink[t.data.inkKey]).length && data.ink[t.data.inkKey].updated > 0, 'library.json lacks ink {updated, strokes} for ' + t.data.inkKey);
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
  assert(liveOf(ink1[t.data.inkKey]).length, 'ink not restored');
  await page.click('#tSets');
  const row = page.locator('#view [data-set]', {hasText: 'Gig'});
  await row.waitFor({timeout: 5000});
  assert(/2 songs/.test(await row.innerText()), 'restored setlist row: ' + (await row.innerText()).replace(/\s+/g, ' '));
  await openSong(page, 'Three-page');
  await page.waitForFunction(() => {
    const cv = document.querySelector('#stage .ink[data-pn="1"]'); if(!cv) return false;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    for(let i = 3; i < d.length; i += 4) if(d[i]) return true;
    return false;
  }, null, {timeout: 5000}).catch(() => { throw new Error('restored ink not drawn on the song'); });
  await page.click('#vBack');
}

/* ---------- Part 2: song details, archive, replace, delete markers, v1 restore ---------- */
const ED = {song: 'Edited Song', artist: 'Test Artist', version: 'live take'};
const ED_TITLE = 'Edited Song (live take) - Test Artist';
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/* A list row whose title (.t) starts with exactly `title`. */
const rowFor = (page, scope, title) =>
  page.locator(scope + ' li.row').filter({has: page.locator('.t', {hasText: new RegExp('^' + reEsc(title) + '(Archived)?$')})});
async function songRec(page, pred){
  const all = Object.values(await idbAll(page, 'songs'));
  return all.find(pred);
}
/* Sets are {id, name, items:[{type:'song', id} | {type:'break', id, name}], created, updated}. */
const songIds = st => {
  assert(st && Array.isArray(st.items) && !('songs' in st), 'set record is not {items:[...]} (old songs array?): ' + JSON.stringify(st).slice(0, 200));
  return st.items.filter(it => it.type === 'song').map(it => it.id);
};
async function setByName(page, name){
  const sets = Object.values(await idbAll(page, 'sets')).filter(s => !s.deleted && s.name === name);
  assert(sets.length === 1, `expected 1 set "${name}" in IndexedDB, found ${sets.length}`);
  return sets[0];
}
const gigSet = page => setByName(page, 'Gig');
async function openGig(page){
  await toLibrary(page);
  await page.click('#tSets');
  await page.locator('#view [data-set]', {hasText: 'Gig'}).click();
  await page.waitForSelector('#view [data-addto]');
}
async function drawOn(page, sheet){
  const b = await sheet.boundingBox();
  const x0 = b.x + b.width * .3, y0 = b.y + b.height * .4;
  await page.mouse.move(x0, y0); await page.mouse.down();
  for(let i = 1; i <= 10; i++) await page.mouse.move(x0 + i * b.width * .04, y0 + i * b.height * .01);
  await page.mouse.up();
}
async function waitFor(fn, what, ms = 5000){
  const end = Date.now() + ms; let v;
  while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(150); }
  throw new Error(what);
}

async function stepEditSong(t){
  const {page} = t;
  await toLibrary(page);
  const row = rowFor(page, '#libList', 'Two-page');
  await row.waitFor();
  t.data.edId = await row.locator('[data-open]').getAttribute('data-open');
  await row.locator('[data-edit]').click();
  const m = page.locator('.modal');
  await m.waitFor();
  assert(await m.locator('input[data-k=song]').inputValue() === 'Two-page', 'edit dialog Title field = ' + await m.locator('input[data-k=song]').inputValue());
  for(const k of ['song', 'artist', 'version']) await m.locator(`input[data-k=${k}]`).fill(ED[k]);
  await m.locator('[data-ok]').click();
  await page.waitForFunction(() => !document.querySelector('.modal'));
  await rowFor(page, '#libList', ED_TITLE).waitFor({timeout: 5000})
    .catch(async () => { throw new Error('library does not show "' + ED_TITLE + '": ' + (await page.locator('#libList').innerText()).replace(/\s+/g, ' ')); });

  await page.reload();
  await page.waitForSelector('#libList [data-open]');
  await rowFor(page, '#libList', ED_TITLE).waitFor({timeout: 5000}).catch(() => { throw new Error('edited title did not survive reload'); });
  const rec = await songRec(page, s => s.id === t.data.edId);
  assert(rec && rec.song === ED.song && rec.artist === ED.artist && rec.version === ED.version && rec.title === ED_TITLE,
    'stored song record: ' + JSON.stringify(rec && {song: rec.song, artist: rec.artist, version: rec.version, title: rec.title}));

  const shown = async q => { await page.fill('#q', q); return page.locator('#libList [data-open]').evaluateAll(els => els.map(e => e.querySelector('.t').textContent)); };
  for(const q of ['test artist', 'LIVE TAKE']){
    const r = await shown(q);
    assert(r.length === 1 && r[0] === ED_TITLE, `search "${q}" shows ${JSON.stringify(r)}`);
  }
  assert((await shown('zzqx-nothing')).length === 0, 'search for nonsense still shows songs');
  await shown('');
  assert(await songCount(page) === 2, 'clearing search does not show both songs');
}

async function stepArchive(t){
  const {page} = t;
  const id = t.data.edId;
  await toLibrary(page);
  await rowFor(page, '#libList', ED_TITLE).locator('[data-archive]').click();
  await page.waitForFunction(id => !document.querySelector(`#libList [data-open="${id}"]`), id, {timeout: 5000})
    .catch(() => { throw new Error('archived song still listed in the library'); });
  assert(await songCount(page) === 1, 'library shows ' + await songCount(page) + ' songs after archiving one of 2');
  assert((await songRec(page, s => s.id === id)).archived === true, 'song record not archived in IndexedDB');

  await openGig(page);
  const row = rowFor(page, '#view', ED_TITLE);
  await row.waitFor({timeout: 5000}).catch(() => { throw new Error('archived song no longer listed in setlist Gig'); });
  assert(await row.locator('.tag').count() && (await row.locator('.tag').textContent()) === 'Archived', 'setlist row lacks the Archived tag');
  assert(await page.locator('#view [data-playat]').count() === 2, 'setlist does not still show 2 songs');
  /* the Add-songs picker hides archived songs */
  await page.click('#view [data-addto]');
  const picks = await page.locator('.modal .pick label').allInnerTexts();
  assert(picks.length === 1 && !picks.some(x => x.includes('Edited Song')), 'picker shows ' + JSON.stringify(picks));
  await page.click('.modal [data-x]');
  await page.waitForFunction(() => !document.querySelector('.modal'));
  /* it still plays */
  await row.locator('[data-playat]').click();
  await page.waitForSelector('#viewer.on #stage .sheet canvas');
  await page.waitForFunction(t => document.querySelector('#vTitle').textContent === t, ED_TITLE, {timeout: 5000})
    .catch(async () => { throw new Error('viewer title = ' + await page.locator('#vTitle').textContent()); });
  await waitFor(() => canvasHasMarks(page, '#stage .sheet canvas:not(.ink)', 'page'), 'archived song page did not render from the setlist');
  await page.click('#vBack');

  await toLibrary(page);
  await page.check('#showArch');
  await page.locator('#libList h2', {hasText: 'Archived'}).waitFor({timeout: 3000}).catch(() => { throw new Error('no "Archived" heading with Show archived on'); });
  const arow = page.locator(`#libList li.row:has([data-restoresong="${id}"])`);
  assert(await arow.count() === 1, 'archived song not listed with a Restore button');
  await arow.locator('[data-restoresong]').click();
  await page.waitForFunction(id => !document.querySelector(`[data-restoresong="${id}"]`) && document.querySelectorAll('#libList [data-edit]').length === 2, id, {timeout: 5000})
    .catch(() => { throw new Error('Restore did not bring the song back to the library'); });
  await page.uncheck('#showArch');
  assert((await songRec(page, s => s.id === id)).archived === false, 'song record still archived after Restore');
}

async function stepReplace(t){
  const {page} = t;
  const id = t.data.edId;
  await openSong(page, ED_TITLE);
  if(await page.getAttribute('#v2up', 'aria-pressed') !== 'true') await page.click('#v2up');
  await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 2, null, {timeout: 8000})
    .catch(() => { throw new Error('two-page song did not show 2 sheets'); });
  await page.click('#vAnn');
  for(let i = 0; i < 2; i++) await drawOn(page, page.locator('#stage .sheet').nth(i));
  await page.click('#tDone');
  await waitFor(async () => { const ink = await idbAll(page, 'ink'); return liveOf(ink[id + ':1']).length && liveOf(ink[id + ':2']).length; },
    'strokes on both pages not saved before replace');
  await page.click('#vBack');

  const before = await songRec(page, s => s.id === id);
  const posBefore = songIds(await gigSet(page)).indexOf(id);
  assert(posBefore >= 0, 'song not in Gig before replace');
  await toLibrary(page);
  const b = rowFor(page, '#libList', ED_TITLE).locator('[data-replace]');
  await b.click();
  assert(await b.textContent() === 'Clears notes. Tap again', 'first tap on Replace PDF shows "' + await b.textContent() + '"');
  assert(before.pages === 2, 'pages before replace = ' + before.pages);
  await b.click();
  await page.setInputFiles('#replaceFile', path.join(FIX, 'one-page.pdf'));
  await page.waitForFunction(id => /^1 page$/.test(document.querySelector(`#libList [data-open="${id}"] .s`)?.textContent || ''), id, {timeout: 10000})
    .catch(async () => { throw new Error('library row after replace: ' + await rowFor(page, '#libList', ED_TITLE).innerText().catch(() => '(missing)')); });

  const after = await songRec(page, s => s.id === id);
  assert(after && !after.deleted && after.title === ED_TITLE, 'song lost its id or details after replace');
  assert(after.pages === 1, 'pages after replace = ' + after.pages);
  assert(/^[0-9a-f]{64}$/.test(after.hash) && after.hash !== before.hash, `hash not updated (${before.hash} -> ${after.hash})`);
  assert(songIds(await gigSet(page)).indexOf(id) === posBefore, 'song moved or left setlist Gig after replace');
  const ink = await idbAll(page, 'ink');
  for(const k of Object.keys(ink).filter(k => k.startsWith(id + ':'))){
    const v = ink[k];
    assert(v && Array.isArray(v.strokes) && v.strokes.every(s => s.deleted === true && s.id && s.updated), `ink ${k} still has live strokes: ` + JSON.stringify(v).slice(0, 200));
  }
  await openSong(page, ED_TITLE);
  await waitSub(page, /^Page 1 of 1$/, 'replaced chart');
  await sleep(300);
  assert(!(await canvasHasMarks(page, '#stage .ink', 'ink')), 'old annotations still drawn on the replaced chart');
  await page.click('#vBack');
}

async function stepDelete(t){
  const {page} = t;
  const id = t.data.edId;
  await toLibrary(page);
  const b = rowFor(page, '#libList', ED_TITLE).locator('[data-del]');
  await b.click(); await b.click();
  await page.waitForFunction(id => !document.querySelector(`#libList [data-open="${id}"]`), id, {timeout: 5000})
    .catch(() => { throw new Error('deleted song still in the library'); });
  assert(await songCount(page) === 1, 'library shows ' + await songCount(page) + ' songs after delete');
  const rec = (await idbAll(page, 'songs'))[id];
  assert(rec && rec.id === id && rec.deleted === true && rec.updated > 0 && Object.keys(rec).sort().join() === 'deleted,id,updated',
    'song record is not a deletion marker: ' + JSON.stringify(rec));
  assert(!(await idbAll(page, 'files'))[id], 'PDF of deleted song still stored');
  const left = Object.keys(await idbAll(page, 'ink')).filter(k => k.startsWith(id + ':'));
  assert(!left.length, 'ink records of deleted song remain: ' + left.join(', '));
  assert(!songIds(await gigSet(page)).includes(id), 'deleted song still in set Gig (IndexedDB)');
  await openGig(page);
  assert(await page.locator('#view [data-playat]').count() === 1, 'setlist Gig does not show 1 song after delete');
  assert(!(await page.locator('#view').innerText()).includes('Edited Song'), 'deleted song still shown in setlist');
  await page.click('#view [data-allsets]');
  assert(/1 song\b/.test(await page.locator('#view [data-set]', {hasText: 'Gig'}).innerText()), 'set row does not say 1 song');

  await toLibrary(page);
  const dl = await download(page, () => page.click('#view [data-backup]'));
  const zip = await JSZip.loadAsync(await fsp.readFile(dl.file));
  const data = JSON.parse(await zip.file('library.json').async('string'));
  assert(data.version === 2, 'backup version ' + data.version);
  const m = data.songs.find(s => s.id === id);
  assert(m && m.deleted === true && m.updated > 0 && !('title' in m), 'backup lacks the deletion marker: ' + JSON.stringify(m));
  assert(!zip.file('files/' + id + '.pdf'), 'backup still has the deleted PDF');
  assert(data.songs.filter(s => !s.deleted).length === 1, 'backup live songs = ' + data.songs.filter(s => !s.deleted).length);
}

async function stepRestoreV1(t){
  const {page} = t;
  const id = 'v1old' + Date.now().toString(36), setId = 'v1set' + Date.now().toString(36);
  const legacyTitle = 'Old Song - Some Artist';
  const zip = new JSZip();
  zip.file('files/' + id + '.pdf', await fsp.readFile(path.join(FIX, 'one-page.pdf')));
  zip.file('library.json', JSON.stringify({
    app: 'setlist-stand', version: 1, saved: new Date().toISOString(),
    songs: [{id, title: legacyTitle, pages: 1, added: 1700000000000}],
    sets: [{id: setId, name: 'Old Gig', songs: [id], created: 1700000000000}],
    ink: {[id + ':1']: [{t: 'pen', c: '#d62828', w: .003, p: [[.1, .1], [.5, .5]]}]},
  }));
  const f = path.join(TMP, 'v1-backup.zip');
  await fsp.writeFile(f, await zip.generateAsync({type: 'nodebuffer'}));

  await toLibrary(page);
  await page.setInputFiles('#restoreFile', f);
  await page.waitForSelector(`#libList [data-open="${id}"]`, {timeout: 15000})
    .catch(async () => { throw new Error('v1 song not in library after restore; toast: ' + await page.locator('#toast').textContent()); });
  /* Title-only records go through the legacy splitter (js/names.js). */
  const want = splitName(legacyTitle);
  await page.locator(`#libList li.row:has([data-open="${id}"]) [data-edit]`).click();
  const mo = page.locator('.modal'); await mo.waitFor();
  const got = {};
  for(const k of ['song', 'artist', 'version']) got[k] = await mo.locator(`input[data-k=${k}]`).inputValue();
  await mo.locator('[data-x]').click();
  await page.waitForFunction(() => !document.querySelector('.modal'));
  assert(got.song && got.artist && got.song === want.song && got.artist === want.artist && got.version === want.version,
    `edit fields ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  const parts = new Set([got.song, got.artist]);
  assert(parts.has('Old Song') && parts.has('Some Artist'), 'title words lost: ' + JSON.stringify(got));
  const shown = await page.locator(`#libList [data-open="${id}"] .t`).textContent();
  assert(shown === displayName(want), `library row "${shown}"`);

  await page.click('#tSets');
  const srow = page.locator('#view [data-set]', {hasText: 'Old Gig'});
  await srow.waitFor({timeout: 5000}).catch(() => { throw new Error('v1 set "Old Gig" missing'); });
  assert(/1 song\b/.test(await srow.innerText()), 'v1 set row: ' + await srow.innerText());
  const oldGig = await setByName(page, 'Old Gig');
  assert(JSON.stringify(oldGig.items) === JSON.stringify([{type: 'song', id}]) && oldGig.updated > 0,
    'v1 set not upgraded to items: ' + JSON.stringify(oldGig));

  const ink = (await idbAll(page, 'ink'))[id + ':1'];
  assert(ink && !Array.isArray(ink) && ink.updated > 0 && Array.isArray(ink.strokes) && ink.strokes.length === 1,
    'v1 ink not upgraded to {updated, strokes}: ' + JSON.stringify(ink));
  assert(typeof ink.strokes[0].id === 'string' && ink.strokes[0].id && !ink.strokes[0].deleted, 'v1 stroke got no id: ' + JSON.stringify(ink.strokes[0]));
  await waitFor(async () => /^[0-9a-f]{64}$/.test((await songRec(page, s => s.id === id))?.hash || ''), 'v1 song got no 64-hex hash within 5s');
  await toLibrary(page);
}

/* ---------- Part 3: setlist items (breaks), duplicate, drag to reorder, breaks in the viewer ---------- */
const exactText = s => new RegExp('^' + reEsc(s) + '$');
async function openSetNamed(page, name){
  await toLibrary(page);
  await page.click('#tSets');
  await page.locator('#view [data-set]').filter({has: page.locator('.t', {hasText: exactText(name)})}).click();
  await page.waitForFunction(n => document.querySelector('#view h2')?.textContent === n && !!document.querySelector('#view [data-addto]'), name)
    .catch(() => { throw new Error(`setlist "${name}" did not open`); });
}
async function newSet(page, name){
  await toLibrary(page);
  await page.click('#tSets');
  await page.click('#view [data-newset]');
  await page.locator('.modal input[type=text]').fill(name);
  await page.click('.modal [data-ok]');
  await page.waitForFunction(n => document.querySelector('#view h2')?.textContent === n, name);
}
const rowCount = page => page.locator('#items > li.row').count();
/* Adds songs by exact library title through the Add songs picker (in the order given = picker order). */
async function addSongs(page, titles){
  const n0 = await rowCount(page);
  await page.click('#view [data-addto]');
  await page.locator('.modal .pick').waitFor();
  for(const tt of titles){
    const box = page.locator('.modal .pick label', {hasText: exactText(tt)}).locator('input');
    assert(await box.count() === 1, `picker has ${await box.count()} rows titled "${tt}"`);
    await box.check();
  }
  await page.click('.modal [data-ok]');
  await page.waitForFunction(n => document.querySelectorAll('#items > li.row').length === n, n0 + titles.length, {timeout: 5000})
    .catch(async () => { throw new Error(`expected ${n0 + titles.length} rows after Add songs, got ${await rowCount(page)}`); });
}
/* Row labels in screen order: song title or break name (without the tag). */
const rowLabels = page => page.locator('#items > li.row').evaluateAll(els => els.map(li => li.querySelector('.t').firstChild.textContent));
async function itemLabels(page, st){
  const songs = await idbAll(page, 'songs');
  return st.items.map(it => it.type === 'break' ? it.name : (songs[it.id] && songs[it.id].title));
}
const moved = (arr, from, to) => { const a = arr.slice(), [m] = a.splice(from, 1); a.splice(to, 0, m); return a; };
const sameIds = (a, b) => JSON.stringify(a.map(it => it.type + ':' + it.id)) === JSON.stringify(b.map(it => it.type + ':' + it.id));

/* Where to grab row `from` and where to let go so it lands at index `to`. The dragged row's center follows the finger. */
async function dragPoints(page, from, to){
  const rows = page.locator('#items > li.row');
  await rows.nth(from).locator('.handle').scrollIntoViewIfNeeded();
  const h = await rows.nth(from).locator('.handle').boundingBox();
  const r = await rows.nth(to).boundingBox();
  const start = {x: h.x + h.width / 2, y: h.y + h.height / 2};
  const end = {x: start.x, y: to < from ? r.y + 4 : r.y + r.height - 4};
  return {start, end};
}
async function touch(t, type, pt){
  await t.cdp.send('Input.dispatchTouchEvent', {type, touchPoints: pt ? [{x: Math.round(pt.x), y: Math.round(pt.y), id: 1}] : []});
}
async function touchDrag(t, from, to, steps = 12, mid){
  const {start, end} = await dragPoints(t.page, from, to);
  await touch(t, 'touchStart', start);
  for(let i = 1; i <= steps; i++){
    await touch(t, 'touchMove', {x: start.x, y: start.y + (end.y - start.y) * i / steps});
    await sleep(16);
  }
  await sleep(100);
  if(mid) await mid().catch(async e => { await touch(t, 'touchEnd'); throw e; });
  await touch(t, 'touchEnd');
}
async function mouseDrag(page, from, to){
  const {start, end} = await dragPoints(page, from, to);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, {steps: 12});
  await sleep(100);
  await page.mouse.up();
}
/* Waits until the set's saved items are `want` (by type+id), then checks the screen shows them in that order. */
async function expectOrder(page, name, want, what){
  let st;
  await waitFor(async () => { st = await setByName(page, name); return sameIds(st.items, want); }, 'x', 5000)
    .catch(() => { throw new Error(`${what}: saved order ${JSON.stringify(st.items.map(i => i.id))}, expected ${JSON.stringify(want.map(i => i.id))}`); });
  const labels = await itemLabels(page, st);
  await waitFor(async () => JSON.stringify(await rowLabels(page)) === JSON.stringify(labels), 'x', 3000)
    .catch(async () => { throw new Error(`${what}: screen shows ${JSON.stringify(await rowLabels(page))}, expected ${JSON.stringify(labels)}`); });
}

async function stepSetItems(t){
  const {page} = t;
  /* more charts so sets can have 4 distinct songs: library is now Three-page, Old Song, One-page, Two-page */
  await toLibrary(page);
  const n0 = await songCount(page);
  await page.setInputFiles('#file', [path.join(FIX, 'one-page.pdf'), path.join(FIX, 'two-page.pdf')]);
  await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, n0 + 2, {timeout: 15000})
    .catch(async () => { throw new Error(`expected ${n0 + 2} songs after adding 2, got ${await songCount(page)}`); });

  await newSet(page, 'Show');
  await addSongs(page, ['One-page']);
  await page.click('#view [data-addbreak]');
  await page.waitForFunction(() => document.querySelectorAll('#items > li.row').length === 2);
  await addSongs(page, ['Two-page']);
  let st = await setByName(page, 'Show');
  assert(!('songs' in st) && st.items.map(i => i.type).join() === 'song,break,song' && st.items[1].name === 'Break' && st.items[1].id,
    'Show items after add song/break/song: ' + JSON.stringify(st.items));
  const brk = page.locator('#items > li.row').nth(1);
  assert(await brk.evaluate(e => e.classList.contains('brk')), 'break row lacks class brk');
  assert((await brk.locator('.tag').textContent()) === 'Break', 'break row lacks the Break tag');
  assert(await page.locator('#items > li.row .handle').count() === 3, 'not every row has a drag handle');
  assert(!(await page.locator('#view [data-up], #view [data-down]').count()), 'up/down arrows still shown');
  const nums = await page.locator('#items > li.row .num').allTextContents();
  assert(JSON.stringify(nums) === '["1","","2"]', 'row numbers ' + JSON.stringify(nums));

  /* rename the break */
  await brk.locator('[data-renbreak]').click();
  const mi = page.locator('.modal input[type=text]');
  await mi.waitFor();
  assert(await mi.inputValue() === 'Break', 'rename dialog shows ' + await mi.inputValue());
  await mi.fill('Set 2');
  await page.click('.modal [data-ok]');
  await expectOrder(page, 'Show', st.items, 'after rename');
  st = await setByName(page, 'Show');
  assert(st.items[1].name === 'Set 2', 'break not renamed in IndexedDB: ' + JSON.stringify(st.items[1]));
  t.data.show = st;

  /* print skips the break: 1 + 2 pages */
  const dl = await printSet(page, false);
  const doc = await PDFDocument.load(await fsp.readFile(dl.file));
  assert(doc.getPageCount() === 3, `printed set with a break has ${doc.getPageCount()} pages, expected 3`);

  /* removing a song from a set keeps it in the library */
  await addSongs(page, ['Three-page']);
  const threeId = (await setByName(page, 'Show')).items[3].id;
  await page.locator('#items > li.row').nth(3).locator('[data-rm]').click();
  await expectOrder(page, 'Show', st.items, 'after Remove');
  const rec = (await idbAll(page, 'songs'))[threeId];
  assert(rec && !rec.deleted && rec.title === 'Three-page', 'Remove from set touched the song record: ' + JSON.stringify(rec).slice(0, 120));
  assert((await idbAll(page, 'files'))[threeId], 'Remove from set deleted the PDF');
  await toLibrary(page);
  assert(await page.locator(`#libList [data-open="${threeId}"]`).count() === 1, 'removed song no longer in the library');

  /* Duplicate from the setlist screen */
  await openSetNamed(page, 'Show');
  await page.click('#view [data-dup]');
  await page.waitForFunction(() => document.querySelector('#view h2')?.textContent === 'Show copy', null, {timeout: 5000})
    .catch(async () => { throw new Error('Duplicate did not open "Show copy"; heading: ' + await page.locator('#view h2').textContent()); });
  const cp = await setByName(page, 'Show copy');
  assert(cp.id !== st.id, 'copy has the same id');
  assert(JSON.stringify(songIds(cp)) === JSON.stringify(songIds(st)) && cp.items.map(i => i.type).join() === 'song,break,song',
    'copy items ' + JSON.stringify(cp.items));
  assert(cp.items[1].name === 'Set 2' && cp.items[1].id && cp.items[1].id !== st.items[1].id, 'copied break: ' + JSON.stringify(cp.items[1]));
  assert(JSON.stringify(await rowLabels(page)) === JSON.stringify(['One-page', 'Set 2', 'Two-page']), 'copy shows ' + JSON.stringify(await rowLabels(page)));
  assert(JSON.stringify(songIds(await setByName(page, 'Show'))) === JSON.stringify(songIds(st)), 'original changed by Duplicate');

  /* Duplicate from the setlist list */
  await page.click('#view [data-allsets]');
  const gig = await gigSet(page);
  await page.click(`#view [data-dupset="${gig.id}"]`);
  await page.waitForFunction(() => document.querySelector('#view h2')?.textContent === 'Gig copy', null, {timeout: 5000})
    .catch(() => { throw new Error('list Duplicate did not open "Gig copy"'); });
  const gc = await setByName(page, 'Gig copy');
  assert(JSON.stringify(songIds(gc)) === JSON.stringify(songIds(gig)) && gc.items.length === gig.items.length, 'Gig copy items ' + JSON.stringify(gc.items));
}

async function swipeLeft(page){
  await page.mouse.move(900, 420); await page.mouse.down();
  await page.mouse.move(800, 422, {steps: 4}); await page.mouse.move(650, 424, {steps: 4});
  await page.mouse.up();
}
async function expectBreakPage(page, what){
  await page.waitForSelector('#stage .breakpage', {timeout: 5000}).catch(() => { throw new Error(what + ': no .breakpage'); });
  const h1 = await page.locator('#stage .breakpage h1').textContent(), p = await page.locator('#stage .breakpage p').textContent();
  assert(h1 === 'Set 2' && p === 'Next: Two-page', `${what}: break page h1 "${h1}", p "${p}"`);
  assert(!(await page.locator('#stage .sheet').count()), what + ': .sheet shown on the break page');
  assert(await page.locator('#vAnn').isHidden(), what + ': Annotate visible on the break page');
  assert(await page.locator('#nextup').isHidden(), what + ': #nextup shown on the break page');
}
async function expectSong(page, title, sub, what){
  await page.waitForSelector('#stage .sheet canvas', {timeout: 8000}).catch(() => { throw new Error(what + ': no page shown'); });
  await page.waitForFunction(t => document.querySelector('#vTitle').textContent === t, title, {timeout: 5000})
    .catch(async () => { throw new Error(`${what}: title "${await page.locator('#vTitle').textContent()}"`); });
  await waitSub(page, sub, what);
  assert(!(await page.locator('#stage .breakpage').count()), what + ': break page still shown');
  assert(await page.locator('#vAnn').isVisible(), what + ': Annotate hidden on a song page');
}

async function stepViewerBreaks(t){
  const {page} = t;
  await openSetNamed(page, 'Show');
  await page.click('#view [data-play]');
  await expectSong(page, 'One-page', /^Song 1 of 2 · Page 1 of 1$/, 'song A');
  await waitFor(async () => (await page.locator('#nextup').isVisible()) && (await page.locator('#nextup').textContent()) === 'Next: Set 2', 'x', 3000)
    .catch(async () => { throw new Error(`song A last page #nextup "${await page.locator('#nextup').textContent()}" hidden=${await page.locator('#nextup').isHidden()}`); });
  await stageTap(page, 0.85);
  await expectBreakPage(page, 'tap right from song A');
  await page.keyboard.press('ArrowRight');
  await expectSong(page, 'Two-page', /^Song 2 of 2 · Page 1/, 'ArrowRight from the break');
  await page.keyboard.press('ArrowLeft');
  await expectBreakPage(page, 'ArrowLeft from song B');
  await page.keyboard.press('ArrowLeft');
  await expectSong(page, 'One-page', /^Song 1 of 2 · Page 1 of 1$/, 'ArrowLeft from the break');
  assert((await page.locator('#nextup').textContent()) === 'Next: Set 2', 'back on song A, #nextup = ' + await page.locator('#nextup').textContent());
  await swipeLeft(page);
  await expectBreakPage(page, 'swipe from song A');
  await swipeLeft(page);
  await expectSong(page, 'Two-page', /^Song 2 of 2 · Page 1/, 'swipe from the break');
  await page.click('#vBack');
}

async function stepDragTouch(t){
  const {page} = t;
  /* 5 rows: 4 songs and a break */
  await newSet(page, 'Drag');
  await addSongs(page, ['One-page', 'Three-page', 'Two-page', displayName(splitName('Old Song - Some Artist'))]);
  await page.click('#view [data-addbreak]');
  await page.waitForFunction(() => document.querySelectorAll('#items > li.row').length === 5);
  let items = (await setByName(page, 'Drag')).items;
  assert(items.length === 5, 'Drag set has ' + items.length + ' items');

  /* touch: row 3 to the top; mid-way the row is lifted and the others make room */
  await page.evaluate(() => { window.__ptypes = []; addEventListener('pointerdown', e => window.__ptypes.push(e.pointerType), true); });
  await touchDrag(t, 2, 0, 12, async () => {
    const st = await page.evaluate(() => ({lifted: [...document.querySelectorAll('#items > li.row')].findIndex(r => r.classList.contains('dragging')),
      sorting: document.querySelector('#items').classList.contains('sorting'),
      shifted: [...document.querySelectorAll('#items > li.row')].map(r => r.style.transform)}));
    assert(st.lifted === 2 && st.sorting, 'mid-drag: lifted row ' + st.lifted + ', sorting ' + st.sorting);
    assert(/translateY\(\d/.test(st.shifted[0]) && /translateY\(\d/.test(st.shifted[1]) && !st.shifted[3], 'mid-drag row shifts ' + JSON.stringify(st.shifted));
  });
  const ptypes = await page.evaluate(() => window.__ptypes);
  assert(ptypes.length && ptypes.every(p => p === 'touch'), 'drag was not real touch input: pointerTypes ' + JSON.stringify(ptypes));
  items = moved(items, 2, 0);
  await expectOrder(page, 'Drag', items, 'touch drag row 3 to top');
  await page.reload();
  await page.waitForSelector('#libList');
  await openSetNamed(page, 'Drag');
  await expectOrder(page, 'Drag', items, 'after reload');
  /* touch: first row to the middle, then the second row to the end */
  await touchDrag(t, 0, 2);
  items = moved(items, 0, 2);
  await expectOrder(page, 'Drag', items, 'touch drag row 1 to the middle');
  await touchDrag(t, 1, 4);
  items = moved(items, 1, 4);
  await expectOrder(page, 'Drag', items, 'touch drag row 2 to the end');
  /* mouse: last row to the second place */
  await mouseDrag(page, 4, 1);
  items = moved(items, 4, 1);
  await expectOrder(page, 'Drag', items, 'mouse drag');
  /* a tap on a handle without moving changes nothing */
  await touchDrag(t, 3, 3, 1);
  await sleep(300);
  await expectOrder(page, 'Drag', items, 'drag that went nowhere');
  await page.reload();
  await page.waitForSelector('#libList');
  await openSetNamed(page, 'Drag');
  await expectOrder(page, 'Drag', items, 'after reload');
}

async function stepDragLong(t){
  const {page} = t;
  /* a 38-song set written straight into IndexedDB (cycling the 4 library songs) */
  const ids = Object.values(await idbAll(page, 'songs')).filter(s => !s.deleted && !s.archived).map(s => s.id).slice(0, 4);
  assert(ids.length === 4, 'need 4 songs, have ' + ids.length);
  const items = Array.from({length: 38}, (_, i) => ({type: 'song', id: ids[i % 4]}));
  const now = Date.now();
  await page.evaluate(rec => new Promise((res, rej) => {
    const r = indexedDB.open('setlist-stand');
    r.onsuccess = () => { const d = r.result, tx = d.transaction('sets', 'readwrite'); tx.objectStore('sets').put(rec, rec.id); tx.oncomplete = () => { d.close(); res(); }; tx.onerror = () => rej(tx.error); };
    r.onerror = () => rej(r.error);
  }), {id: 'longset' + now.toString(36), name: 'Long', items, created: now, updated: now});
  await page.reload();
  await page.waitForSelector('#libList');
  await openSetNamed(page, 'Long');
  assert(await rowCount(page) === 38, 'Long set shows ' + await rowCount(page) + ' rows');
  const vh = await page.evaluate(() => innerHeight);
  assert(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight * 2), 'Long set does not need scrolling');

  /* grab the last row (page scrolled to the bottom) and hold near the top edge until the list has scrolled up */
  const last = page.locator('#items > li.row').nth(37).locator('.handle');
  await last.scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await sleep(100);
  const sy0 = await page.evaluate(() => scrollY);
  assert(sy0 > 0, 'page not scrolled down');
  const h = await last.boundingBox();
  const start = {x: h.x + h.width / 2, y: h.y + h.height / 2}, edge = {x: start.x, y: 12};
  const t0 = Date.now();
  await touch(t, 'touchStart', start);
  for(let i = 1; i <= 10; i++){ await touch(t, 'touchMove', {x: start.x, y: start.y + (edge.y - start.y) * i / 10}); await sleep(16); }
  await waitFor(() => page.evaluate(() => scrollY === 0), `autoscroll did not reach the top within 15s (scrollY ${sy0} at start)`, 15000)
    .catch(async e => { await touch(t, 'touchEnd'); throw e; });
  for(let i = 0; i < 5; i++){ await touch(t, 'touchMove', {x: edge.x, y: edge.y + (i % 2)}); await sleep(16); }
  await touch(t, 'touchEnd');
  const want = moved(items, 37, 0);
  await expectOrder(page, 'Long', want, 'long list drag last to first');
  const ms = Date.now() - t0;
  assert(await rowCount(page) === 38, 'Long set shows ' + await rowCount(page) + ' rows after the drag');
  console.log(`      info: 38-row touch drag with autoscroll (scrollY ${sy0} -> 0, viewport ${vh}px) took ${ms} ms, saved and redrawn`);
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
  ['9 edit song details; persists; search by artist and version', stepEditSong],
  ['10 archive a song in a setlist; still plays; Show archived; restore', stepArchive],
  ['11 replace PDF: same id and setlist place, notes cleared, new hash', stepReplace],
  ['12 delete leaves a marker in IndexedDB and in the backup', stepDelete],
  ['13 restore a version 1 backup', stepRestoreV1],
  ['14 setlist items: break, rename, print skips it, remove keeps song, duplicate', stepSetItems],
  ['15 viewer plays breaks between songs: tap, swipe, arrow keys, back', stepViewerBreaks],
  ['16 drag to reorder with touch and mouse; order saved and survives reload', stepDragTouch],
  ['17 drag in a 38-song set with autoscroll', stepDragLong],
  ['18 no request left localhost during the run', stepNoExternal],
];

/* ---------- runner ---------- */
const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'setlist-smoke-'));
let failed = 0, server, browser;
try{
  await waitFixtures();
  server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 1280, height: 800}, acceptDownloads: true, hasTouch: true});
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  page.setDefaultTimeout(15000);
  const t = {page, context, cdp, base, data: {}, external: [], errors: []};
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

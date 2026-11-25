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
import zlib from 'node:zlib';
import {createHash} from 'node:crypto';
import {launchBrowser, WEBKIT} from './loops/browser.mjs';
import {acquireSlot} from './loops/slot.mjs';
import {tableProblem} from './loops/swtable.mjs';
import {songAct, songActIn, answerDelete, songDelete} from './loops/songrow.mjs';
import {answerRestore, closeRestored} from './loops/harness.mjs';
import {setAct} from './loops/setrow.mjs';
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
/* While `offline.drop` is set the server hangs up on every request (Playwright's setOffline cuts the page off but not
   always the service worker), and `offline.hits` records what reached it. */
const offline = {drop: false, hits: []};
function startServer(){
  const srv = http.createServer(async (req, res) => {
    if(offline.drop){ offline.hits.push(req.url); req.socket.destroy(); return; }
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
/* Back up everything sits in the Library's Back up / Sync box (Jonathan, 2026-11-22). */
async function tapBackup(page){
  await page.click('#view [data-backupmenu]');
  await page.click('.modal.menubox [data-item="backup"]');
}
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
  offline.drop = true; offline.hits.length = 0;
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
    /* everything came from the service worker's cache: the only thing allowed to knock is the browser's own sw.js update check */
    const knocked = offline.hits.filter(u => !/\/sw\.js(\?|$)/.test(u));
    assert(!knocked.length, 'requests reached the server while offline: ' + knocked.slice(0, 5).join(', '));
  } finally { offline.drop = false; await context.setOffline(false); }
  checkHosts(t);
}

function checkHosts(t){
  const bad = t.external.filter(u => !/^(blob|data):/.test(u));
  assert(!bad.length, 'requests to non-localhost hosts: ' + [...new Set(bad)].slice(0, 5).join(', '));
}

/* An open setlist's More menu (the Gig date, Download PDF, Share, Duplicate, Rename and Collections items): open it, tap one. */
async function setMenu(page, item){
  await page.click('#view [data-setmenu]');
  const box = page.locator('.modal.menubox'); await box.waitFor();
  await box.locator(`[data-item="${item}"]`).click();
}

async function printSet(page, withInk){
  await setMenu(page, 'print');
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
  const row = setRow(page, 'Gig');
  await row.waitFor();
  assert(/2 songs/.test(await row.innerText()), 'setlist row does not say 2 songs');
  await row.click();
  await page.waitForSelector('#view [data-play]:not([disabled])');

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
  const dl = await download(page, () => tapBackup(page));
  assert(/\.zip$/.test(dl.name), 'backup name ' + dl.name);
  const zip = await JSZip.loadAsync(await fsp.readFile(dl.file));
  const lj = zip.file('library.json'); assert(lj, 'zip has no library.json');
  const data = JSON.parse(await lj.async('string'));
  assert(data.app === 'setlist-stand', 'library.json app = ' + data.app);
  assert(data.version === 3, 'library.json version = ' + data.version);
  assert(data.songs.length === 2, 'library.json songs = ' + data.songs.length);
  assert(data.sets.length === 1, 'library.json sets = ' + data.sets.length);
  assert(songIds(data.sets[0]).length === 2, 'library.json set Gig items: ' + JSON.stringify(data.sets[0].items));
  assert(data.ink && data.ink[t.data.inkKey] && liveOf(data.ink[t.data.inkKey]).length && data.ink[t.data.inkKey].updated > 0, 'library.json lacks ink {updated, strokes} for ' + t.data.inkKey);
  for(const s of data.songs) assert(zip.file('files/' + s.id + '.pdf'), 'zip lacks files/' + s.id + '.pdf');

  for(let i = 0; i < 2; i++){
    const did = await page.locator('#libList [data-songmenu]').first().getAttribute('data-songmenu');
    await songAct(page, 'del', did);
    await page.locator('.modal.delask').waitFor({timeout: 5000});
    assert(await songCount(page) === 2 - i, 'the Delete menu item alone deleted a song');
    await answerDelete(page, false);
    assert(await songCount(page) === 2 - i, 'Cancel on the Delete question deleted a song');
    await songDelete(page, did);
    await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, 1 - i, {timeout: 5000})
      .catch(async () => { throw new Error(`after delete expected ${1 - i} songs, got ${await songCount(page)}`); });
  }
  assert(await page.locator('#libList .empty').count(), 'library does not show the empty state');
  const ink0 = await idbAll(page, 'ink');
  assert(!ink0[t.data.inkKey], 'ink not deleted with its song');

  /* the setlist Gig is still here (its songs left it when they were deleted, after the backup): the question comes, and that
     emptied Gig is kept as "Gig (before restore)" */
  const asked = await pickRestore(page, dl.file);
  assert(/It brings back 2 songs you deleted on this tablet\./.test(asked || '') && /A copy of 1 setlist is kept as "Gig \(before restore\)"\./.test(asked), 'the question: ' + JSON.stringify(asked));
  await page.waitForFunction(() => /^Restored/.test(document.querySelector('#toast').textContent), null, {timeout: 30000});
  assert(/A copy of 1 setlist was kept: Gig \(before restore\)\./.test(await closeRestored(page) || ''), 'no "Backup restored" box naming the kept setlist');
  await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 2, null, {timeout: 15000})
    .catch(async () => { throw new Error(`after restore library shows ${await songCount(page)} songs`); });
  const ink1 = await idbAll(page, 'ink');
  assert(liveOf(ink1[t.data.inkKey]).length, 'ink not restored');
  await page.click('#tSets');
  const row = setRow(page, 'Gig');
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
/* Restore through the button: the toast is emptied first, and the "Restore this backup?" question (it comes when the library is not
   empty) is answered Restore. Resolves to the question's text, or null when none came. */
async function pickRestore(page, file){
  await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
  await page.setInputFiles('#restoreFile', file);
  return answerRestore(page, 'ok', 60000);
}
/* The Setlists list row of the setlist named exactly `name` ("Gig", not "Gig (before restore)" or "Old Gig"). */
const setRow = (page, name) => page.locator('#view [data-set]').filter({has: page.locator('.t').getByText(name, {exact: true})});
async function setByName(page, name){
  const sets = Object.values(await idbAll(page, 'sets')).filter(s => !s.deleted && s.name === name);
  assert(sets.length === 1, `expected 1 set "${name}" in IndexedDB, found ${sets.length}`);
  return sets[0];
}
const gigSet = page => setByName(page, 'Gig');
async function openGig(page){
  await toLibrary(page);
  await page.click('#tSets');
  await setRow(page, 'Gig').click();
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
  await songActIn(page, row, 'edit');
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
  await songActIn(page, rowFor(page, '#libList', ED_TITLE), 'archive');
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
  const arow = page.locator(`#libList li.row:has([data-songmenu="${id}"])`);
  assert(await arow.count() === 1, 'archived song not listed with a menu button');
  await songActIn(page, arow, 'restore');
  await page.waitForFunction(id => document.querySelectorAll('#libList [data-songmenu]').length === 2, id, {timeout: 5000})
    .catch(() => { throw new Error('Restore did not bring the song back to the library'); });
  await page.uncheck('#showArch');
  assert((await songRec(page, s => s.id === id)).archived === false, 'song record still archived after Restore');
}

async function stepNewVersion(t){
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
    'strokes on both pages not saved before New version');
  await page.click('#vBack');

  const before = await songRec(page, s => s.id === id), inkBefore = await idbAll(page, 'ink');
  const known = new Set(Object.keys(await idbAll(page, 'songs')));
  const posBefore = songIds(await gigSet(page)).indexOf(id);
  assert(posBefore >= 0, 'song not in Gig before New version');
  assert(before.pages === 2, 'pages before New version = ' + before.pages);
  await toLibrary(page);
  const nvRow = rowFor(page, '#libList', ED_TITLE);
  await nvRow.locator('[data-songmenu]').click();
  assert((await page.locator('.modal.menubox [data-item="newversion"] b').textContent()).trim() === 'New version', 'the menu item says "' + await page.locator('.modal.menubox [data-item="newversion"] b').textContent() + '", not "New version"');
  await page.locator('.modal.menubox [data-item="newversion"]').click();                                // one tap opens the file picker (the confirm comes after the pick)
  await page.setInputFiles('#newVersionFile', path.join(FIX, 'one-page.pdf'));
  const m = page.locator('.modal.nvask');
  await m.waitFor({timeout: 10000}).catch(() => { throw new Error('no New version question after the pick'); });
  const q = (await m.locator('p').textContent()).replace(/\s+/g, ' ').trim();
  assert(q === `Use one-page.pdf as the new version of ${ED_TITLE}? The current chart and its marks move to Archived.`, 'New version question: ' + q);
  assert(await m.locator('[data-ok]').textContent() === 'New version' && await m.locator('[data-x]').textContent() === 'Cancel', 'New version question buttons');
  await m.locator('[data-ok]').click();
  await page.waitForFunction(id => /^1 page$/.test(document.querySelector(`#libList [data-open="${id}"] .s`)?.textContent || ''), id, {timeout: 10000})
    .catch(async () => { throw new Error('library row after New version: ' + await rowFor(page, '#libList', ED_TITLE).innerText().catch(() => '(missing)')); });
  assert(/^New version in place\. The old one is in Archived\./.test(await page.locator('#toast').textContent()), 'toast after New version: ' + await page.locator('#toast').textContent());

  const after = await songRec(page, s => s.id === id);
  assert(after && !after.deleted && after.title === ED_TITLE, 'song lost its id or details after New version');
  assert(after.pages === 1, 'pages after New version = ' + after.pages);
  assert(/^[0-9a-f]{64}$/.test(after.hash) && after.hash !== before.hash, `hash not updated (${before.hash} -> ${after.hash})`);
  assert(songIds(await gigSet(page)).indexOf(id) === posBefore, 'song moved or left setlist Gig after New version');
  const ink = await idbAll(page, 'ink');
  for(const k of Object.keys(ink).filter(k => k.startsWith(id + ':'))){
    const v = ink[k];
    assert(v && Array.isArray(v.strokes) && v.strokes.every(s => s.deleted === true && s.id && s.updated), `ink ${k} still has live strokes: ` + JSON.stringify(v).slice(0, 200));
  }
  /* the old chart: one new archived song with the old hash, the version marked old, and the old marks on the same pages */
  const fresh = Object.values(await idbAll(page, 'songs')).filter(s => !known.has(s.id));
  assert(fresh.length === 1, 'New version made ' + fresh.length + ' new song records');
  const old = fresh[0];
  assert(old.archived === true && old.hash === before.hash && old.pages === 2 && old.song === ED.song && old.artist === ED.artist && /^live take, old \d{4}-\d\d-\d\d$/.test(old.version)
    && old.title === `${ED.song} (${old.version}) - ${ED.artist}`, 'the old copy: ' + JSON.stringify(old));
  for(const pn of [1, 2]) assert(JSON.stringify(liveOf(ink[old.id + ':' + pn])) === JSON.stringify(liveOf(inkBefore[id + ':' + pn])), `the old copy's marks on page ${pn} are not the old chart's`);
  assert(!songIds(await gigSet(page)).includes(old.id), 'the old copy is in setlist Gig');
  await openSong(page, ED_TITLE);
  await waitSub(page, /^Page 1 of 1$/, 'new chart');
  await sleep(300);
  assert(!(await canvasHasMarks(page, '#stage .ink', 'ink')), 'old annotations still drawn on the new chart');
  await page.click('#vBack');

  /* in Archived it opens with its marks; deleting it there never touches the new chart */
  await toLibrary(page);
  await page.check('#showArch');
  const orow = page.locator(`#libList li.row:has([data-songmenu="${old.id}"])`);
  assert(await orow.count() === 1, 'the old copy is not listed under Archived');
  await orow.locator('[data-open]').click();
  await page.waitForFunction(t => document.querySelector('#vTitle').textContent === t && !!document.querySelector('#stage .ink'), old.title, {timeout: 8000});
  await waitSub(page, /^Page 1(–2)? of 2$/, 'old copy');           // two pages side by side is still on from the start of this step
  await waitFor(() => canvasHasMarks(page, '#stage .ink', 'ink'), 'the old copy opens without its marks');
  await page.click('#vBack');
  await toLibrary(page);
  const nowNew = {song: await songRec(page, s => s.id === id), ink: Object.fromEntries(Object.entries(await idbAll(page, 'ink')).filter(([k]) => k.startsWith(id + ':'))), file: (await idbAll(page, 'files'))[id]};
  await songDelete(page, old.id);
  await page.waitForFunction(id => !document.querySelector(`#libList [data-open="${id}"]`), old.id, {timeout: 5000})
    .catch(() => { throw new Error('deleted old copy still listed'); });
  await page.uncheck('#showArch');
  const left = {song: await songRec(page, s => s.id === id), ink: Object.fromEntries(Object.entries(await idbAll(page, 'ink')).filter(([k]) => k.startsWith(id + ':'))), file: (await idbAll(page, 'files'))[id]};
  assert(JSON.stringify(left) === JSON.stringify(nowNew), 'deleting the old copy changed the new chart');
  assert((await songRec(page, s => s.id === old.id)).deleted === true, 'the old copy is not a deletion marker after Delete');
}

async function stepCopySong(t){
  const {page} = t;
  /* Three-page has the stroke drawn in step 5; ED_TITLE (edited in step 9) has version "live take" and no live marks since step 11. */
  const orig = await songRec(page, s => !s.deleted && s.song === 'Three-page');
  assert(orig, 'no Three-page song to copy');
  const known = new Set(Object.keys(await idbAll(page, 'songs')));
  const inkOf = async id => Object.fromEntries(Object.entries(await idbAll(page, 'ink')).filter(([k]) => k.startsWith(id + ':')));
  const before = {song: JSON.stringify(orig), ink: JSON.stringify(await inkOf(orig.id)), file: (await idbAll(page, 'files'))[orig.id], sets: JSON.stringify(await idbAll(page, 'sets'))};
  const origLive = Object.values(await inkOf(orig.id)).flatMap(liveOf);
  assert(origLive.length >= 1, 'Three-page has no marks to copy');
  await toLibrary(page);
  await rowFor(page, '#libList', 'Three-page').locator('[data-songmenu]').click();
  assert((await page.locator('.modal.menubox [data-item="copy"] b').textContent()).trim() === 'Copy', 'the library row menu has no Copy item');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.modal'));

  /* the dialog: shows the original, Save waits for a name, the original's own version is refused (ED_TITLE has "live take") */
  await songActIn(page, rowFor(page, '#libList', ED_TITLE), 'copy');
  let m = page.locator('.modal.copyask');
  await m.waitFor();
  assert((await m.locator('p').first().textContent()) === 'Copy of ' + ED_TITLE, 'dialog line: ' + await m.locator('p').first().textContent());
  assert(await m.locator('[data-ok]').isDisabled(), 'Save is on with an empty version name');
  await m.locator('input').fill('  LIVE   Take ');
  assert(await m.locator('[data-err]').isVisible() && await m.locator('[data-ok]').isDisabled(), 'the original\'s own version is not refused');
  await m.locator('input').press('Enter');
  assert(await m.count() === 1, 'Enter closed the dialog on a refused version name');
  await m.locator('[data-x]').click();
  await page.waitForFunction(() => !document.querySelector('.modal'));
  assert(Object.keys(await idbAll(page, 'songs')).length === known.size, 'a cancelled or refused Copy made a song');

  await songActIn(page, rowFor(page, '#libList', 'Three-page'), 'copy');
  m = page.locator('.modal.copyask');
  await m.waitFor();
  await m.locator('input').fill('copy test');
  await m.locator('[data-ok]').click();
  await page.waitForFunction(() => !document.querySelector('.modal'));
  const title = 'Three-page (copy test)';
  await rowFor(page, '#libList', title).waitFor({timeout: 5000});
  assert(/^Copied\. The new version has the same marks\.$/.test(await page.locator('#toast').textContent()), 'toast: ' + await page.locator('#toast').textContent());
  const fresh = Object.values(await idbAll(page, 'songs')).filter(s => !known.has(s.id));
  assert(fresh.length === 1, 'Copy made ' + fresh.length + ' songs');
  const copy = fresh[0];
  assert(copy.id !== orig.id && copy.title === title && copy.version === 'copy test' && copy.archived === false && copy.pages === orig.pages && copy.hash === orig.hash,
    'the copy: ' + JSON.stringify(copy));

  /* the PDF bytes are the original's (same size here; the hash above is the app's hash of them) and no stroke id is shared */
  const files = await idbAll(page, 'files');
  assert(files[copy.id] === files[orig.id], `copy PDF ${files[copy.id]} is not the original's ${files[orig.id]}`);
  const copyLive = Object.values(await inkOf(copy.id)).flatMap(liveOf), origIds = new Set(origLive.map(x => x.id));
  assert(copyLive.length === origLive.length && copyLive.every(x => !origIds.has(x.id)), 'the copy has the same stroke ids as the original, or a different number of marks');
  assert(JSON.stringify(copyLive.map(x => x.p)) === JSON.stringify(origLive.map(x => x.p)), 'the copy\'s strokes are not the original\'s');
  assert(before.song === JSON.stringify(await songRec(page, s => s.id === orig.id)) && before.ink === JSON.stringify(await inkOf(orig.id)) && before.sets === JSON.stringify(await idbAll(page, 'sets')),
    'Copy changed the original song, its marks or a setlist');
  assert(!Object.values(await idbAll(page, 'sets')).some(st => !st.deleted && songIds(st).includes(copy.id)), 'the copy is in a setlist');

  /* open the copy: the same marks show; one more stroke on the copy; after a reload the original has its strokes only */
  await openSong(page, title);
  await waitFor(() => canvasHasMarks(page, '#stage .ink', 'ink'), 'the copy opens without its marks');
  await page.click('#vAnn');
  await drawOn(page, page.locator('#stage .sheet').first());
  await page.click('#tDone');
  await waitFor(async () => Object.values(await inkOf(copy.id)).flatMap(liveOf).length === origLive.length + 1, 'the stroke drawn on the copy was not saved');
  await page.reload();
  await page.waitForSelector('#libList [data-open]');
  assert(JSON.stringify(await inkOf(orig.id)) === before.ink, 'drawing on the copy changed the original\'s marks');
  assert(Object.values(await inkOf(copy.id)).flatMap(liveOf).length === origLive.length + 1, 'the copy lost a mark after reload');
  await rowFor(page, '#libList', title).waitFor({timeout: 5000});
  /* leave the library as it was for the steps after this one: the copy goes (two taps) */
  await songDelete(page, copy.id);
  await page.waitForFunction(id => !document.querySelector(`#libList [data-open="${id}"]`), copy.id, {timeout: 5000});
}

async function stepDelete(t){
  const {page} = t;
  const id = t.data.edId;
  await toLibrary(page);
  await songActIn(page, rowFor(page, '#libList', ED_TITLE), 'del');
  await page.locator('.modal.delask').waitFor({timeout: 5000});
  assert(!(await idbAll(page, 'songs'))[id].deleted, 'the Delete menu item alone deleted the song');
  await answerDelete(page, false);
  assert(!(await idbAll(page, 'songs'))[id].deleted, 'Cancel on the Delete question deleted the song');
  await songActIn(page, rowFor(page, '#libList', ED_TITLE), 'del');
  await answerDelete(page, true);
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
  assert(/1 song\b/.test(await setRow(page, 'Gig').innerText()), 'set row does not say 1 song');

  await toLibrary(page);
  const dl = await download(page, () => tapBackup(page));
  const zip = await JSZip.loadAsync(await fsp.readFile(dl.file));
  const data = JSON.parse(await zip.file('library.json').async('string'));
  assert(data.version === 3, 'backup version ' + data.version);
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
  const asked = await pickRestore(page, f);
  assert(/It adds 1 song and 1 setlist\./.test(asked || ''), 'the question before a version 1 restore: ' + JSON.stringify(asked));
  await page.waitForSelector(`#libList [data-open="${id}"]`, {timeout: 15000})
    .catch(async () => { throw new Error('v1 song not in library after restore; toast: ' + await page.locator('#toast').textContent()); });
  /* Title-only records go through the legacy splitter (js/names.js). */
  const want = splitName(legacyTitle);
  await songAct(page, 'edit', id);
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
  /* One-page's bytes are already in the library (Old Song): the app asks once about duplicates; add them anyway */
  await page.click('.dupask [data-dupadd]', {timeout: 15000});
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
  await setMenu(page, 'dup');
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
  await page.waitForTimeout(450);          // the same button twice within 400 ms is a double tap and is ignored (js/saving.js once()); a person takes longer than this script
  await setAct(page, 'dup', gig.id);
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
  await page.waitForTimeout(450);          // not a double tap (js/saving.js once(): the same button within 400 ms is ignored)
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

/* ---------- Part 4: crop and text notes ---------- */
const PW = 612, PH = 792;                       // fixture page size (letter, points)
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fmt = o => JSON.stringify(o, (k, v) => typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);
const rectNear = (r, want, tol) => !!r && ['x', 'y', 'w', 'h'].every(k => near(r[k], want[k], tol));
const cropAspect = r => (r.w * PW) / (r.h * PH);
async function songIdOf(page, title){
  await toLibrary(page);
  const row = rowFor(page, '#libList', title);
  assert(await row.count() === 1, `library has ${await row.count()} rows titled "${title}"`);
  return row.locator('[data-open]').getAttribute('data-open');
}
const cropRec = async (page, id) => (await songRec(page, s => s.id === id)).crop;
/* Opens a song in one-page-per-view mode on page `pn`. */
async function openAt(page, title, pn){
  await openSong(page, title);
  if(await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
  await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 1, null, {timeout: 5000});
  await gotoPage(page, pn);
}
async function gotoPage(page, pn){
  for(let i = 0; i < 6; i++){
    const m = /Page (\d+) of (\d+)/.exec(await subText(page));
    const cur = m ? +m[1] : 0;
    if(cur === pn && await page.locator(`#stage .ink[data-pn="${pn}"]`).count()) return;
    if(cur !== pn) await page.keyboard.press(cur < pn ? 'ArrowRight' : 'ArrowLeft');
    await sleep(200);
  }
  await page.waitForSelector(`#stage .ink[data-pn="${pn}"]`, {timeout: 3000}).catch(async () => { throw new Error(`could not get to page ${pn}; #vSub "${await subText(page)}"`); });
}
/* Size of the shown sheet for page pn and of its page canvas (canvas pixels). */
const sheetOf = (page, pn) => page.evaluate(pn => {
  const ink = document.querySelector(`#stage .ink[data-pn="${pn}"]`); if(!ink) return null;
  const b = ink.parentElement.getBoundingClientRect(), cv = ink.parentElement.querySelector('canvas:not(.ink)');
  return {x: b.x, y: b.y, w: b.width, h: b.height, cw: cv.width, ch: cv.height, iw: ink.width, ih: ink.height};
}, pn);
async function expectAspect(page, pn, want, what){
  let s;
  await waitFor(async () => { s = await sheetOf(page, pn); return s && near(s.w / s.h, want, want * .015); }, 'x', 5000)
    .catch(() => { throw new Error(`${what}: page ${pn} sheet aspect ${s && (s.w / s.h).toFixed(4)}, expected ${want.toFixed(4)} (sheet ${fmt(s)})`); });
  return s;
}
async function showChrome(page){
  if(await page.locator('#viewer.hide').count()){ await stageTap(page, .5); await page.waitForSelector('#viewer:not(.hide)'); }
}
async function openCropperUI(page, pn){
  await showChrome(page);
  await page.evaluate(() => { document.querySelector('#cropHint').textContent = ''; });
  await page.click('#vCrop');
  await waitHint(page, pn, 'cropper did not open for page ' + pn);
}
/* The cropper shows page pn: #cropHint reads "Page pn of M". */
async function waitHint(page, pn, what){
  await page.waitForFunction(pn => !document.querySelector('#cropper').hidden && new RegExp('^Page ' + pn + ' of \\d+$').test(document.querySelector('#cropHint').textContent), pn, {timeout: 5000})
    .catch(async () => { throw new Error(`${what}; #cropHint "${await page.locator('#cropHint').textContent()}"`); });
}
const disabledOf = page => page.evaluate(() => ({prev: document.querySelector('#cropPrev').disabled, next: document.querySelector('#cropNext').disabled}));
/* The box as the cropper shows it (fractions of the page, from its % styles). */
const cropBoxShown = page => page.evaluate(() => { const s = document.querySelector('#cropBox').style; return {x: parseFloat(s.left) / 100, y: parseFloat(s.top) / 100, w: parseFloat(s.width) / 100, h: parseFloat(s.height) / 100}; });
/* The mouse sequence for every cropper drag: press on the grab point, 8 moves to the target, release. */
async function mouseLine(page, from, to, steps = 8){
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, {steps});
  await page.mouse.up();
}
/* Drags handle h (nw, n, ne, e, se, s, sw, w) from its centre to (fx, fy) as fractions of the page in the cropper. */
async function dragHandle(page, h, fx, fy){
  const s = await page.locator('#cropSheet').boundingBox(), hb = await page.locator(`#cropBox .ch[data-h=${h}]`).boundingBox();
  await mouseLine(page, {x: hb.x + hb.width / 2, y: hb.y + hb.height / 2}, {x: s.x + s.width * fx, y: s.y + s.height * fy});
}
/* Drags the box body by (dfx, dfy) page fractions, grabbing it at its centre. */
async function dragBox(page, dfx, dfy){
  const s = await page.locator('#cropSheet').boundingBox(), b = await page.locator('#cropBox').boundingBox();
  const from = {x: b.x + b.width / 2, y: b.y + b.height / 2};
  await mouseLine(page, from, {x: from.x + s.width * dfx, y: from.y + s.height * dfy});
}
async function cropperDone(page){ await page.waitForSelector('#cropper', {state: 'hidden', timeout: 5000}); }
async function waitCrop(page, id, pred, what){
  let c;
  await waitFor(async () => { c = await cropRec(page, id); return pred(c || {}); }, 'x', 5000)
    .catch(() => { throw new Error(`${what}: stored crop ${fmt(c)}`); });
  return c;
}
/* Ink pixels (alpha > 0) on page pn's ink canvas, optionally only inside a canvas-pixel rect. */
const inkPixels = (page, pn, rect) => page.evaluate(([pn, rect]) => {
  const cv = document.querySelector(`#stage .ink[data-pn="${pn}"]`); if(!cv) return null;
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  const r = rect ? rect.map(Math.round) : [0, 0, cv.width, cv.height];
  let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for(let y = Math.max(0, r[1]); y < Math.min(cv.height, r[3]); y++) for(let x = Math.max(0, r[0]); x < Math.min(cv.width, r[2]); x++){
    if(d[(y * cv.width + x) * 4 + 3] > 20){ n++; if(x < x0) x0 = x; if(y < y0) y0 = y; if(x > x1) x1 = x; if(y > y1) y1 = y; }
  }
  return {n, x0, y0, x1, y1, w: cv.width, h: cv.height};
}, [pn, rect || null]);
const inkRec = async (page, id, pn) => (await idbAll(page, 'ink'))[id + ':' + pn];
async function newStrokeOn(page, id, pn, oldIds){
  return waitFor(async () => liveOf(await inkRec(page, id, pn)).find(s => s.t !== 'text' && !oldIds.has(s.id)), `no new stroke saved on page ${pn}`);
}
/* Where the stroke starts and ends on screen (from the ink pixels), mapped back through crop cr to full-page fractions. */
async function drawnEnds(page, pn, cr, s){
  const px = await inkPixels(page, pn);
  assert(px && px.n, `page ${pn} ink canvas is blank`);
  const lw = s.w * px.w / cr.w / 2;
  const f = (x, y) => [cr.x + x / px.w * cr.w, cr.y + y / px.h * cr.h];
  return {start: f(px.x0 + lw, px.y0 + lw), end: f(px.x1 + 1 - lw, px.y1 + 1 - lw)};
}
async function expectDrawnAt(page, pn, cr, s, what){
  const a = s.p[0], b = s.p[s.p.length - 1];
  const fits = r => near(r.start[0], a[0], .005) && near(r.start[1], a[1], .005) && near(r.end[0], b[0], .005) && near(r.end[1], b[1], .005);
  /* A redraw (after a crop change, a resize, a reopen) takes a moment, and longer on a slow computer such as GitHub's: a read
     taken too early shows the OLD picture. Look again for up to 6 s; what is reported is what was seen last. */
  let r = await drawnEnds(page, pn, cr, s);
  for(let k = 0; k < 40 && !fits(r); k++){ await sleep(150); try{ r = await drawnEnds(page, pn, cr, s); }catch(e){ /* canvas being replaced: look again */ } }
  assert(fits(r), `${what}: stroke drawn from ${fmt(r.start)} to ${fmt(r.end)} (mapped through crop ${fmt(cr)}), stored ${fmt(a)} to ${fmt(b)}`);
}
async function penOn(page){
  if(!(await page.locator('#tools').isVisible())) await page.click('#vAnn');
  await page.click('#tools [data-tool=pen][data-color="#1a1a1a"]');
}
async function textTool(page){
  if(!(await page.locator('#tools').isVisible())) await page.click('#vAnn');
  if(await page.getAttribute('#tools [data-tool=text]', 'aria-pressed') !== 'true') await page.click('#tools [data-tool=text]');
  assert(await page.getAttribute('#tools [data-tool=text]', 'aria-pressed') === 'true', 'Text tool not pressed');
}
/* Screen point at page fractions (fx, fy) of the uncropped/cropped sheet. */
const at = (s, fx, fy) => ({x: s.x + s.w * fx, y: s.y + s.h * fy});
async function noteDialogFill(page, {text, size, color}, what){
  const m = page.locator('.modal');
  await m.locator('textarea').waitFor({timeout: 5000}).catch(() => { throw new Error(what + ': note dialog did not open'); });
  if(text !== undefined) await m.locator('textarea').fill(text);
  if(size) await m.locator(`[data-size=${size}]`).click();
  if(color) await m.locator(`[data-color="${color}"]`).click();
  await m.locator('[data-ok]').click();
  await page.waitForFunction(() => !document.querySelector('.modal'));
}
const notesOf = async (page, id, pn) => liveOf(await inkRec(page, id, pn)).filter(s => s.t === 'text');

async function stepCropPage(t){
  const {page} = t;
  const id = t.data.cropId = await songIdOf(page, 'Three-page');
  await openAt(page, 'Three-page', 2);
  const before = await expectAspect(page, 2, PW / PH, 'uncropped page 2');
  await openCropperUI(page, 2);
  const shown = await cropBoxShown(page);
  assert(rectNear(shown, {x: 0, y: 0, w: 1, h: 1}, .001), 'cropper box on an uncropped page starts at ' + fmt(shown));
  /* .2-.8 by .25-.75: a square .6 x .6 crop keeps the page's own aspect, so the height is .5 to make the change visible */
  const want = {x: .2, y: .25, w: .6, h: .5};
  await dragHandle(page, 'nw', want.x, want.y);
  await dragHandle(page, 'se', want.x + want.w, want.y + want.h);
  const box = await cropBoxShown(page);
  assert(rectNear(box, want, .03), 'cropper box after dragging NW and SE: ' + fmt(box));
  await page.click('#cropPage');
  await cropperDone(page);
  const c = await waitCrop(page, id, c => c.pages && c.pages['2'], 'Crop this page');
  assert(rectNear(c.pages['2'], want, .03), 'crop.pages["2"] = ' + fmt(c.pages['2']));
  assert(c.all === null, 'crop.all = ' + fmt(c.all));
  assert(Object.keys(c.pages).join() === '2', 'crop.pages keys: ' + Object.keys(c.pages).join());
  const after = await expectAspect(page, 2, cropAspect(c.pages['2']), 'cropped page 2');
  assert(after.cw * after.ch > before.cw * before.ch * 1.1, `cropped page canvas ${after.cw}x${after.ch} not bigger than ${before.cw}x${before.ch}`);
  assert(after.w / (c.pages['2'].w * PW) > before.w / PW * 1.5, 'cropped music is not drawn larger');
  for(const pn of [1, 3]){
    await gotoPage(page, pn);
    await expectAspect(page, pn, PW / PH, `page ${pn} (no crop)`);
  }
}

async function stepCropSong(t){
  const {page} = t;
  const id = t.data.cropId;
  await gotoPage(page, 1);
  await openCropperUI(page, 1);
  const want = {x: .1, y: .1, w: .8, h: .6};
  await dragHandle(page, 'nw', want.x, want.y);
  await dragHandle(page, 'se', want.x + want.w, want.y + want.h);
  await page.click('#cropSong');
  await cropperDone(page);
  const c = await waitCrop(page, id, c => c.all, 'Crop whole song');
  assert(rectNear(c.all, want, .03), 'crop.all = ' + fmt(c.all));
  assert(c.pages && !Object.keys(c.pages).length, 'crop.pages not cleared: ' + fmt(c.pages));
  const asp = cropAspect(c.all);
  assert(!near(asp, PW / PH, .05), 'test crop aspect too close to the page aspect');
  for(const pn of [1, 2, 3]){ await gotoPage(page, pn); await expectAspect(page, pn, asp, `page ${pn} after Crop whole song`); }
}

async function stepCropInk(t){
  const {page} = t;
  const id = t.data.cropId;
  await gotoPage(page, 2);
  const c0 = (await cropRec(page, id)).all;
  const old = new Set(((await inkRec(page, id, 2)) || {strokes: []}).strokes.map(s => s.id));
  await penOn(page);
  const sh = page.locator('#stage .sheet:has(.ink[data-pn="2"])');
  await drawOn(page, sh);
  await page.click('#tDone');
  const s = await newStrokeOn(page, id, 2, old);
  t.data.cropStroke = s.id;
  assert(s.p.every(p => p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1), 'stroke points not in 0..1: ' + fmt(s.p.slice(0, 3)));
  assert(s.p.every(p => p[0] >= c0.x - .01 && p[0] <= c0.x + c0.w + .01 && p[1] >= c0.y - .01 && p[1] <= c0.y + c0.h + .01),
    `stroke on a cropped page has points outside the crop ${fmt(c0)}: ` + fmt(s.p));
  /* drawOn starts at (.3, .4) of the sheet: in full-page fractions that is the crop's x + .3 w, y + .4 h */
  const want0 = [c0.x + .3 * c0.w, c0.y + .4 * c0.h];
  assert(near(s.p[0][0], want0[0], .005) && near(s.p[0][1], want0[1], .005), `stroke start ${fmt(s.p[0])}, expected ${fmt(want0)} (full-page coordinates)`);
  await expectDrawnAt(page, 2, c0, s, 'before the crop change');

  await openCropperUI(page, 2);
  assert(rectNear(await cropBoxShown(page), c0, .001), 'cropper does not open on the current crop: ' + fmt(await cropBoxShown(page)));
  await dragBox(page, -.05, .05);
  await page.click('#cropSong');
  await cropperDone(page);
  const c1 = (await waitCrop(page, id, c => c.all && !rectNear(c.all, c0, .01), 'moved song crop')).all;
  assert(near(c1.x, c0.x - .05, .01) && near(c1.y, c0.y + .05, .01) && near(c1.w, c0.w, .002) && near(c1.h, c0.h, .002), `moved crop ${fmt(c1)} from ${fmt(c0)}`);
  const s1 = (await inkRec(page, id, 2)).strokes.find(x => x.id === s.id);
  assert(JSON.stringify(s1) === JSON.stringify(s), 'stored stroke changed with the crop: ' + fmt(s1) + ' was ' + fmt(s));
  await expectAspect(page, 2, cropAspect(c1), 'redrawn after the crop change');
  await expectDrawnAt(page, 2, c1, s, 'after the crop change (redraw)');
  await openAt(page, 'Three-page', 2);
  await expectAspect(page, 2, cropAspect(c1), 'reopened');
  await expectDrawnAt(page, 2, c1, s, 'after the crop change (reopened)');
}

async function stepCropReset(t){
  const {page} = t;
  const id = t.data.cropId;
  await gotoPage(page, 2);
  const all = (await cropRec(page, id)).all;
  await openCropperUI(page, 2);
  await dragHandle(page, 'se', all.x + all.w * .8, all.y + all.h * .7);
  await page.click('#cropPage');
  await cropperDone(page);
  let c = await waitCrop(page, id, c => c.pages && c.pages['2'], 'page crop on a song-cropped page');
  assert(rectNear(c.all, all, 1e-6), 'song crop changed by Crop this page: ' + fmt(c.all));
  await expectAspect(page, 2, cropAspect(c.pages['2']), 'own page crop');

  await openCropperUI(page, 2);
  await page.click('#cropReset');
  await cropperDone(page);
  c = await waitCrop(page, id, c => c.pages && !c.pages['2'], 'first Reset');
  assert(rectNear(c.all, all, 1e-6), 'first Reset changed the song crop: ' + fmt(c));
  await expectAspect(page, 2, cropAspect(all), 'after first Reset (song crop again)');

  await openCropperUI(page, 2);
  await page.click('#cropReset');
  await cropperDone(page);
  c = await waitCrop(page, id, c => c.all === null, 'second Reset');
  assert(!Object.keys(c.pages || {}).length, 'pages left after second Reset: ' + fmt(c));
  for(const pn of [2, 1]){ await gotoPage(page, pn); await expectAspect(page, pn, PW / PH, `page ${pn} after Reset`); }
}

async function stepTextNotes(t){
  const {page} = t;
  const id = t.data.cropId, pn = 2, RED = '#d62828';
  await gotoPage(page, pn);
  await textTool(page);
  let s = await sheetOf(page, pn);
  /* new note */
  const p0 = at(s, .2, .7);
  await page.mouse.click(p0.x, p0.y);
  await noteDialogFill(page, {text: 'Verse 2', size: 'medium', color: RED}, 'new note');
  let n = await waitFor(async () => (await notesOf(page, id, pn)).find(x => x.text === 'Verse 2'), 'note "Verse 2" not saved');
  assert(n.t === 'text' && typeof n.id === 'string' && n.id && n.updated > 0, 'note record: ' + fmt(n));
  assert(near(n.size, .018, 1e-6) && n.c === RED, `note size ${n.size}, colour ${n.c}`);
  assert(near(n.x, .2, .01) && near(n.y, .7, .01), 'note position ' + fmt({x: n.x, y: n.y}));
  const nid = n.id;
  /* the note box (screen) and a canvas-pixel rect around its first word */
  const box = n => { const q = at(s, n.x, n.y), fpx = n.size * s.w; return {grab: {x: q.x + 8, y: q.y + fpx * .5}, rect: [n.x * s.w, n.y * s.h, n.x * s.w + fpx * 3, n.y * s.h + fpx * 1.2]}; };
  assert((await inkPixels(page, pn, box(n).rect)).n > 10, 'note is not drawn on the ink canvas');

  /* edit by clicking it */
  await page.mouse.click(box(n).grab.x, box(n).grab.y);
  await page.locator('.modal [data-del]').waitFor({timeout: 5000}).catch(() => { throw new Error('clicking the note did not open the edit dialog with Delete'); });
  assert(await page.locator('.modal textarea').inputValue() === 'Verse 2', 'edit dialog text ' + await page.locator('.modal textarea').inputValue());
  await noteDialogFill(page, {text: 'Verse 2 bridge', size: 'large'}, 'edit');
  n = await waitFor(async () => (await notesOf(page, id, pn)).find(x => x.id === nid && x.text === 'Verse 2 bridge'), 'edited note not saved');
  assert(near(n.size, .028, 1e-6) && n.c === RED, 'edited note ' + fmt(n));
  assert(near(n.x, .2, .01) && near(n.y, .7, .01), 'edit moved the note: ' + fmt(n));
  assert((await notesOf(page, id, pn)).filter(x => x.text.startsWith('Verse')).length === 1, 'edit made a second note');

  /* move by dragging */
  const pre = {...n}, g = box(n).grab, DX = 60, DY = 40;
  await page.mouse.move(g.x, g.y); await page.mouse.down();
  await page.mouse.move(g.x + DX, g.y + DY, {steps: 6}); await page.mouse.up();
  await sleep(250);
  assert(!(await page.locator('.modal').count()), 'dragging a note opened the dialog');
  n = await waitFor(async () => (await notesOf(page, id, pn)).find(x => x.id === nid && x.x !== pre.x), 'moved note not saved');
  assert(near(n.x - pre.x, DX / s.w, .006) && near(n.y - pre.y, DY / s.h, .006), `note moved by ${fmt([n.x - pre.x, n.y - pre.y])}, expected ${fmt([DX / s.w, DY / s.h])}`);
  assert(n.text === pre.text && n.size === pre.size && n.c === pre.c, 'move changed text/size/colour: ' + fmt(n));
  assert(n.updated >= pre.updated, 'move did not refresh updated');

  /* undo the move */
  await page.click('#tUndo');
  n = await waitFor(async () => (await notesOf(page, id, pn)).find(x => x.id === nid && x.x === pre.x && x.y === pre.y), 'Undo did not put the note back');
  assert(n.text === pre.text && n.size === pre.size, 'undo changed the note: ' + fmt(n));
  assert((await inkPixels(page, pn, box(n).rect)).n > 10, 'note not drawn back after Undo');

  /* delete via the dialog */
  await page.mouse.click(box(n).grab.x, box(n).grab.y);
  const del = page.locator('.modal [data-del]');
  await del.waitFor({timeout: 5000});
  await del.click();
  await page.waitForFunction(() => !document.querySelector('.modal'));
  const mk = await waitFor(async () => (await inkRec(page, id, pn)).strokes.find(x => x.id === nid && x.deleted), 'Delete left no marker');
  assert(Object.keys(mk).sort().join() === 'deleted,id,updated' && mk.updated > 0, 'deleted note record is not a marker: ' + fmt(mk));
  assert((await inkPixels(page, pn, box(n).rect)).n === 0, 'deleted note still drawn');

  /* the eraser skips notes (and still erases strokes) */
  s = await sheetOf(page, pn);
  const p1 = at(s, .6, .8);
  await page.mouse.click(p1.x, p1.y);
  await noteDialogFill(page, {text: 'Coda'}, 'second note');
  const coda = await waitFor(async () => (await notesOf(page, id, pn)).find(x => x.text === 'Coda'), 'note "Coda" not saved');
  t.data.coda = coda;
  await page.click('#tools [data-tool=erase]');
  const cb = box(coda);
  await mouseLine(page, {x: cb.grab.x - 20, y: cb.grab.y}, {x: cb.grab.x + 60, y: cb.grab.y}, 10);
  const st = (await inkRec(page, id, pn)).strokes.find(x => x.id === t.data.cropStroke);
  assert(st && !st.deleted, 'pen stroke from the crop step missing before the eraser check');
  /* the stroke is at full-page coordinates; page 2 is uncropped now */
  const a = at(s, st.p[0][0], st.p[0][1]), b = at(s, st.p[st.p.length - 1][0], st.p[st.p.length - 1][1]);
  await mouseLine(page, a, b, 10);
  await waitFor(async () => (await inkRec(page, id, pn)).strokes.find(x => x.id === t.data.cropStroke)?.deleted, 'eraser did not erase the pen stroke (eraser check would prove nothing)');
  const c2 = (await notesOf(page, id, pn)).find(x => x.id === coda.id);
  assert(c2 && JSON.stringify(c2) === JSON.stringify(coda), 'eraser touched the note: ' + fmt(c2));
  assert((await inkPixels(page, pn, cb.rect)).n > 10, 'note not drawn after the eraser pass');
  await page.click('#tDone');

  /* reload and reopen */
  await page.reload();
  await page.waitForSelector('#libList [data-open]');
  await openAt(page, 'Three-page', pn);
  const c3 = (await notesOf(page, id, pn)).find(x => x.id === coda.id);
  assert(c3 && c3.text === 'Coda', 'note not stored after reload');
  assert((await inkRec(page, id, pn)).strokes.find(x => x.id === nid)?.deleted, 'deleted note came back after reload');
  s = await sheetOf(page, pn);
  await waitFor(async () => (await inkPixels(page, pn, box(coda).rect)).n > 10, 'note not drawn after reload');
}

/* Draws one pen stroke and one note on page pn of the open song. */
async function strokeAndNote(page, id, pn, text){
  const old = new Set(((await inkRec(page, id, pn)) || {strokes: []}).strokes.map(s => s.id));
  await penOn(page);
  await drawOn(page, page.locator(`#stage .sheet:has(.ink[data-pn="${pn}"])`));
  await newStrokeOn(page, id, pn, old);
  await textTool(page);
  const s = await sheetOf(page, pn), p = at(s, .1, .1);
  await page.mouse.click(p.x, p.y);
  await noteDialogFill(page, {text}, 'note ' + text);
  await waitFor(async () => (await notesOf(page, id, pn)).find(x => x.text === text), `note "${text}" not saved`);
  await page.click('#tDone');
}
const cropBoxOf = pg => { const b = pg.getCropBox(); return [b.x, b.y, b.width, b.height]; };
const boxFor = r => r ? [PW * r.x, PH * (1 - r.y - r.h), PW * r.w, PH * r.h] : [0, 0, PW, PH];
const boxNear = (a, b, tol) => a.every((v, i) => near(v, b[i], tol));

async function stepCropPrint(t){
  const {page} = t;
  const id = t.data.cropId;
  /* song-wide crop .1/.1/.8/.8 on Three-page, a stroke and a note on page 1 */
  await openAt(page, 'Three-page', 1);
  await openCropperUI(page, 1);
  await dragHandle(page, 'nw', .1, .1);
  await dragHandle(page, 'se', .9, .9);
  await page.click('#cropSong');
  await cropperDone(page);
  const all = (await waitCrop(page, id, c => c.all, 'print crop')).all;
  assert(rectNear(all, {x: .1, y: .1, w: .8, h: .8}, .0016), 'dragged song crop not within 1pt of .1/.1/.8/.8: ' + fmt(all));
  await strokeAndNote(page, id, 1, 'Intro');
  /* Two-page: only page 2 cropped */
  const id2 = t.data.cropId2 = await songIdOf(page, 'Two-page');
  await openAt(page, 'Two-page', 2);
  await openCropperUI(page, 2);
  await dragHandle(page, 'nw', .15, .2);
  await page.click('#cropPage');
  await cropperDone(page);
  const c2 = await waitCrop(page, id2, c => c.pages && c.pages['2'], 'Two-page page crop');
  assert(!c2.all && Object.keys(c2.pages).join() === '2', 'Two-page crop ' + fmt(c2));
  await page.click('#vBack');

  await newSet(page, 'Crops');
  await addSongs(page, ['Three-page', 'Two-page']);
  const order = songIds(await setByName(page, 'Crops'));
  const songs = await idbAll(page, 'songs'), want = [];
  for(const sid of order) for(let p = 1; p <= songs[sid].pages; p++){
    const c = songs[sid].crop; want.push(c && ((c.pages && c.pages[p]) || c.all) || null);
  }
  assert(want.length === 5, 'expected 5 pages in set Crops, have ' + want.length);
  const size = {};
  for(const withInk of [true, false]){
    const dl = await printSet(page, withInk);
    const bytes = await fsp.readFile(dl.file), doc = await PDFDocument.load(bytes);
    assert(doc.getPageCount() === 5, `${withInk ? 'with' : 'without'} annotations: ${doc.getPageCount()} pages, expected 5`);
    doc.getPages().forEach((pg, i) => {
      const got = cropBoxOf(pg), exp = boxFor(want[i]);
      assert(boxNear(got, exp, 1), `${withInk ? 'with' : 'without'} annotations: page ${i + 1} CropBox ${fmt(got)}, expected ${fmt(exp)}`);
    });
    for(const i of [0, 1, 2]) assert(boxNear(cropBoxOf(doc.getPage(i)), [61.2, 79.2, 489.6, 633.6], 1), `page ${i + 1} CropBox ${fmt(cropBoxOf(doc.getPage(i)))} not the .1/.1/.8/.8 crop`);
    assert(boxNear(cropBoxOf(doc.getPage(3)), [0, 0, PW, PH], .01), 'Two-page page 1 (no crop) printed with CropBox ' + fmt(cropBoxOf(doc.getPage(3))));
    size[withInk] = bytes.length;
  }
  assert(size[true] > size[false], `PDF with annotations (${size[true]} B) is not larger than without (${size[false]} B)`);
}

async function stepCropBackup(t){
  const {page} = t;
  const id = t.data.cropId;
  const crop = (await songRec(page, s => s.id === id)).crop;
  const notes = {1: await notesOf(page, id, 1), 2: await notesOf(page, id, 2)};
  assert(crop && crop.all && notes[1].length && notes[2].length, 'nothing to check: crop ' + fmt(crop) + ', notes ' + notes[1].length + '/' + notes[2].length);
  await toLibrary(page);
  const dl = await download(page, () => tapBackup(page));
  const data = JSON.parse(await (await JSZip.loadAsync(await fsp.readFile(dl.file))).file('library.json').async('string'));
  assert(JSON.stringify(data.songs.find(s => s.id === id)?.crop) === JSON.stringify(crop), 'backup song crop ' + fmt(data.songs.find(s => s.id === id)?.crop));
  assert(JSON.stringify(data.songs.find(s => s.id === t.data.cropId2)?.crop) === JSON.stringify((await songRec(page, s => s.id === t.data.cropId2)).crop), 'backup lacks the per-page crop');
  for(const pn of [1, 2]) for(const n of notes[pn])
    assert(liveOf(data.ink[id + ':' + pn]).some(x => JSON.stringify(x) === JSON.stringify(n)), `backup lacks note "${n.text}" on page ${pn}`);

  await songActIn(page, rowFor(page, '#libList', 'Three-page'), 'del');
  await answerDelete(page, true);
  await page.waitForFunction(id => !document.querySelector(`#libList [data-open="${id}"]`), id, {timeout: 5000})
    .catch(() => { throw new Error('Three-page not deleted'); });
  assert((await idbAll(page, 'songs'))[id].deleted === true, 'song record not a deletion marker');
  assert(!Object.keys(await idbAll(page, 'ink')).some(k => k.startsWith(id + ':')), 'ink of the deleted song remains');

  const asked = await pickRestore(page, dl.file);
  assert(/It brings back 1 song you deleted on this tablet\./.test(asked || ''), 'the question does not say the deleted song comes back: ' + JSON.stringify(asked));
  await page.waitForFunction(() => /^Restored/.test(document.querySelector('#toast').textContent), null, {timeout: 30000});
  await closeRestored(page);          // a setlist that lost the song when it was deleted is kept as "<name> (before restore)"
  await page.waitForSelector(`#libList [data-open="${id}"]`, {timeout: 15000}).catch(() => { throw new Error('song not back after restore'); });
  const rc = (await songRec(page, s => s.id === id)).crop;
  assert(JSON.stringify(rc) === JSON.stringify(crop), `restored crop ${fmt(rc)}, expected ${fmt(crop)}`);
  for(const pn of [1, 2]){
    const got = await notesOf(page, id, pn);
    for(const n of notes[pn]) assert(got.some(x => JSON.stringify(x) === JSON.stringify(n)), `note "${n.text}" on page ${pn} not restored`);
  }
  await openAt(page, 'Three-page', 1);
  await expectAspect(page, 1, cropAspect(crop.all), 'restored song shows its crop');
  await waitFor(async () => (await inkPixels(page, 1)).n > 0, 'restored notes/ink not drawn');
  await page.click('#vBack');
}

/* Every stream in a PDF file, inflated where it is Flate-compressed, as latin1 text. */
function pdfStreams(buf){
  const out = [], s = buf.toString('latin1');
  let i = 0;
  while((i = s.indexOf('stream', i)) >= 0){
    let a = i + 6;
    if(s[a] === '\r') a++;
    if(s[a] === '\n') a++; else { i = a; continue; }
    const b = s.indexOf('endstream', a); if(b < 0) break;
    const raw = buf.subarray(a, b);
    try{ out.push(zlib.inflateSync(raw).toString('latin1')); }catch(e){ out.push(raw.toString('latin1')); }
    i = b + 9;
  }
  return out;
}
const hexOf = str => [...Buffer.from(str, 'latin1')].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

async function stepPrintSharps(t){
  const {page} = t;
  const id = await songIdOf(page, 'One-page'), TXT = 'C♯ to B♭';
  await openAt(page, 'One-page', 1);
  await textTool(page);
  const s = await sheetOf(page, 1), p = at(s, .15, .2);
  await page.mouse.click(p.x, p.y);
  await noteDialogFill(page, {text: TXT}, 'sharp/flat note');
  await waitFor(async () => (await notesOf(page, id, 1)).find(x => x.text === TXT), 'note "' + TXT + '" not saved');
  await page.click('#tDone');
  await page.click('#vBack');
  await newSet(page, 'Sharps');
  await addSongs(page, ['One-page']);
  const errs = t.errors.length;
  const dl = await printSet(page, true).catch(async e => { throw new Error(`print failed (${e.message.split('\n')[0]}); toast "${await page.locator('#toast').textContent()}"`); });
  assert(t.errors.length === errs, 'page errors while printing: ' + t.errors.slice(errs).join(' | '));
  const bytes = await fsp.readFile(dl.file), doc = await PDFDocument.load(bytes);
  assert(doc.getPageCount() === 1, `printed ${doc.getPageCount()} pages, expected 1`);
  /* pdf-lib writes standard-font text as a WinAnsi hex string: look for "C# to Bb" in the page content */
  const streams = pdfStreams(bytes), want = hexOf('C# to Bb');
  assert(streams.some(x => x.toUpperCase().includes('<' + want + '>')), `no <${want}> ("C# to Bb") text in the PDF's ${streams.length} streams`);
}

async function stepCropSpread(t){
  const {page} = t;
  const id = await songIdOf(page, 'Two-page');
  await openSong(page, 'Two-page');
  /* start clean: step 23 cropped page 2 of this song */
  const c0 = await cropRec(page, id);
  assert(!c0 || !c0.all, 'Two-page unexpectedly has a song-wide crop: ' + fmt(c0));
  if(await page.getAttribute('#v2up', 'aria-pressed') !== 'true') await page.click('#v2up');
  await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 2, null, {timeout: 8000})
    .catch(async () => { throw new Error(`two-page view shows ${await page.locator('#stage .sheet').count()} sheets`); });
  await waitSub(page, /^Page 1–2 of 2$/, 'two-page view');

  await openCropperUI(page, 1);
  assert(await page.locator('#cropHint').textContent() === 'Page 1 of 2', '#cropHint ' + await page.locator('#cropHint').textContent());
  let d = await disabledOf(page);
  assert(d.prev === true && d.next === false, 'on page 1: #cropPrev disabled ' + d.prev + ', #cropNext disabled ' + d.next);
  await page.click('#cropNext');
  await waitHint(page, 2, '#cropNext did not show page 2');
  d = await disabledOf(page);
  assert(d.prev === false && d.next === true, 'on page 2 (last): #cropPrev disabled ' + d.prev + ', #cropNext disabled ' + d.next);
  if(c0 && c0.pages && c0.pages['2']){
    /* page 2 still has its crop from step 23: Reset it, then come back */
    assert(rectNear(await cropBoxShown(page), c0.pages['2'], .001), 'page 2 opened without its own crop: ' + fmt(await cropBoxShown(page)));
    await page.click('#cropReset');
    await cropperDone(page);
    await waitCrop(page, id, c => !(c.pages && c.pages['2']), 'Reset of page 2');
    await openCropperUI(page, 1);
    await page.click('#cropNext');
    await waitHint(page, 2, '#cropNext did not show page 2 (second time)');
  }
  await page.click('#cropPrev');
  await waitHint(page, 1, '#cropPrev did not go back to page 1');
  assert((await disabledOf(page)).prev === true, '#cropPrev enabled on page 1');
  await page.click('#cropNext');
  await waitHint(page, 2, '#cropNext did not show page 2 again');
  assert(rectNear(await cropBoxShown(page), {x: 0, y: 0, w: 1, h: 1}, .001), 'page 2 box not full: ' + fmt(await cropBoxShown(page)));
  const want = {x: .1, y: .15, w: .9, h: .85};
  await dragHandle(page, 'nw', want.x, want.y);
  await page.click('#cropPage');
  await cropperDone(page);
  const c = await waitCrop(page, id, c => c.pages && c.pages['2'], 'Crop this page on page 2 of a spread');
  assert(rectNear(c.pages['2'], want, .03), 'crop.pages["2"] = ' + fmt(c.pages['2']));
  assert(!c.pages['1'] && Object.keys(c.pages).join() === '2', 'crop.pages keys ' + Object.keys(c.pages).join() + ' (page 1 must not be cropped)');
  assert(!c.all, 'crop.all = ' + fmt(c.all));
  await expectAspect(page, 2, cropAspect(c.pages['2']), 'right sheet of the spread');
  await expectAspect(page, 1, PW / PH, 'left sheet of the spread (no crop)');
  await page.click('#v2up');
  await page.click('#vBack');
}

async function stepCropEarly(t){
  const {page} = t;
  const id = await songIdOf(page, 'One-page');
  await openAt(page, 'One-page', 1);
  await showChrome(page);
  const crop0 = JSON.stringify((await cropRec(page, id)) || null), errs = t.errors.length;
  /* the clicks run in one task, so the page cannot have rendered in between */
  const early = await page.evaluate(() => {
    const h = document.querySelector('#cropHint'); h.textContent = '';
    document.querySelector('#vCrop').click();
    document.querySelector('#cropPage').click();
    document.querySelector('#cropReset').click();
    document.querySelector('#cropSong').click();
    return {hint: h.textContent, open: !document.querySelector('#cropper').hidden};
  });
  assert(early.open && early.hint === '', 'clicks were not before the render: ' + fmt(early));
  await waitHint(page, 1, 'cropper did not finish opening after early clicks');
  await sleep(300);
  assert(t.errors.length === errs, 'page errors after early clicks: ' + t.errors.slice(errs).join(' | '));
  assert(!(await page.locator('#cropper').isHidden()), 'early clicks closed the cropper');
  assert(JSON.stringify((await cropRec(page, id)) || null) === crop0, 'early clicks changed the crop: ' + fmt(await cropRec(page, id)));
  const d = await disabledOf(page);
  assert(d.prev && d.next, 'one-page song: arrows not both disabled ' + fmt(d));

  /* the same open editor still works */
  await dragHandle(page, 'se', .8, .7);
  await page.click('#cropPage');
  await cropperDone(page);
  const c = await waitCrop(page, id, c => c.pages && c.pages['1'], 'crop after early clicks');
  assert(rectNear(c.pages['1'], {x: 0, y: 0, w: .8, h: .7}, .03), 'crop.pages["1"] = ' + fmt(c.pages['1']));
  await expectAspect(page, 1, cropAspect(c.pages['1']), 'cropped after early clicks');
  await openCropperUI(page, 1);
  await page.click('#cropReset');
  await cropperDone(page);
  await waitCrop(page, id, c => !(c.pages && c.pages['1']), 'Reset after early clicks');
  assert(t.errors.length === errs, 'page errors: ' + t.errors.slice(errs).join(' | '));
  await page.click('#vBack');
}

/* Split a songbook through the real button's file input: the bookmarks give the songs, each is added as its own PDF. */
async function stepSplitBook(t){
  const {page} = t, before = await songCount(page), errs = t.errors.length;
  await page.click('#tLib');
  await page.setInputFiles('#splitFile', path.join(FIX, 'songbook.pdf'));
  await page.waitForSelector('#splitter:not([hidden])', {timeout: 20000});
  await page.waitForFunction(() => document.querySelectorAll('#splitPages .pg').length === 12);
  assert(await page.locator('#splitRows .srow').count() === 7, 'the bookmarks did not give 7 rows');
  assert(await page.locator('#splitGo').textContent() === 'Add 6 songs', 'Add button: ' + await page.locator('#splitGo').textContent());
  await page.click('#splitGo');
  await page.waitForFunction(() => document.querySelector('#splitter').hidden, null, {timeout: 20000});
  await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, before + 6, {timeout: 10000})
    .catch(async () => { throw new Error(`expected ${before + 6} songs, library shows ${await songCount(page)}`); });
  const text = await page.locator('#libList').innerText();
  assert(/Song Three \(in G\)/.test(text) && /Song Two - Fixture Artist/.test(text), 'split songs missing in library: ' + text.replace(/\s+/g, ' '));
  assert(/Song Five\s+3 pages/.test(text) && /Song Four\s+1 page\b/.test(text), 'page counts of the split songs: ' + text.replace(/\s+/g, ' '));
  assert(t.errors.length === errs, 'page errors: ' + t.errors.slice(errs).join(' | '));
}

/* Share: chosen songs from the Library, then a setlist from its screen. The downloaded zips are read back. */
async function stepShare(t){
  const {page} = t, errs = t.errors.length;
  const closeDone = async () => {
    await page.locator('.modal [role=dialog]', {hasText: 'Package saved'}).waitFor();
    await page.click('.modal [data-x]');
    await page.waitForFunction(() => !document.querySelector('.modal'));
  };
  const read = async dl => {
    const zip = await JSZip.loadAsync(await fsp.readFile(dl.file)), names = Object.keys(zip.files).sort();
    return {names, share: JSON.parse(await zip.file('share.json').async('string'))};
  };
  /* Two songs with different PDFs: "One-page" and "Old Song" (the first two in the list) are the same bytes, and a package holds
     one copy of a PDF, so the next step would rightly count them as one song. */
  const tick = async (...names) => { for(const n of names) await page.locator('.modal .pick label', {hasText: new RegExp('^' + n)}).locator('input').check(); };
  await toLibrary(page);
  await page.click('#view [data-sharemenu]'); await page.click('.modal.menubox [data-item="share"]');
  await page.locator('.modal .pick input[type=checkbox]').first().waitFor();
  await tick('Three-page', 'Two-page');
  const a = await download(page, () => page.click('.modal [data-ok]'));
  assert(/Setlist Stand share\.zip$/.test(a.name), 'package name ' + a.name);
  const pa = await read(a);
  assert(pa.names.join() === 'files/s1.pdf,files/s2.pdf,share.json', 'songs package entries: ' + pa.names);
  assert(pa.share.kind === 'share' && pa.share.songs.length === 2 && pa.share.setlist === null, 'songs package: ' + JSON.stringify(pa.share).slice(0, 200));
  assert(!('ink' in pa.share) && !/"strokes"|"t":"(pen|hl|text)"/.test(JSON.stringify(pa.share)), 'the package holds annotation data');
  await closeDone();
  t.data.shareSongs = a.file;

  await newSet(page, 'Share check');
  await page.click('#view [data-addto]');
  await page.locator('.modal .pick input[type=checkbox]').first().waitFor();
  await tick('Three-page', 'Two-page');
  await page.click('.modal [data-ok]');
  await page.waitForFunction(() => document.querySelectorAll('#view [data-playat]').length === 2);
  const b = await download(page, () => setMenu(page, 'share'));
  const pb = await read(b);
  assert(pb.names.join() === 'files/s1.pdf,files/s2.pdf,share.json', 'setlist package entries: ' + pb.names);
  assert(pb.share.setlist && pb.share.setlist.name === 'Share check' && pb.share.setlist.items.length === 2, 'setlist package: ' + JSON.stringify(pb.share.setlist));
  await closeDone();
  t.data.shareSet = b.file;
  assert(t.errors.length === errs, 'page errors: ' + t.errors.slice(errs).join(' | '));
}

/* Import a share package: the setlist package made in the step before comes back into the same library. Its songs are all
   there already, so nothing is added but the setlist, under a new name; the songs-only package has nothing new. */
async function stepShareImport(t){
  const {page} = t, errs = t.errors.length;
  await toLibrary(page);
  const songs0 = await songCount(page);              // counted on the Library screen: #libList does not exist on the setlist screen the step before ends on
  assert(songs0 > 0, 'no songs counted in the library');
  await page.setInputFiles('#shareFile', t.data.shareSet);
  const dlg = page.locator('.modal [role=dialog]', {hasText: 'Import share package'});
  await dlg.waitFor({timeout: 15000});
  const text = await dlg.textContent();
  assert(/No new songs/.test(text) && /2 songs already in your library/.test(text) && /Share check/.test(text), 'import dialog: ' + text);
  await page.click('.modal [data-ok]');
  await page.waitForFunction(() => /the setlist Share check \(2\)/.test(document.querySelector('#toast').textContent), null, {timeout: 15000});
  assert(await songCount(page) === songs0, 'importing a package of songs already here added songs');
  await page.click('#tSets');
  assert(await page.locator('#view [data-set]', {hasText: 'Share check (2)'}).count() === 1, 'the imported setlist is not in the list');
  await toLibrary(page);
  await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
  await page.setInputFiles('#shareFile', t.data.shareSongs);
  await page.waitForFunction(() => /Nothing new: 2 songs are already in your library/.test(document.querySelector('#toast').textContent), null, {timeout: 15000});
  assert(t.errors.length === errs, 'page errors: ' + t.errors.slice(errs).join(' | '));
}

/* Import chart updates: a file of two charts for two songs here (made in Node like tools/make-chart-update.mjs makes it); one
   is unticked, the other applied. That song keeps its id and plays the new chart; the unticked one is unchanged. */
async function stepChartUpdate(t){
  const {page} = t, errs = t.errors.length;
  await toLibrary(page);
  const fx = ['one-page.pdf', 'two-page.pdf', 'three-page.pdf'].map((f, i) => { const b = fs.readFileSync(path.join(FIX, f)); return {b, pages: i + 1, hash: createHash('sha256').update(b).digest('hex')}; });
  const songs = Object.values(await idbAll(page, 'songs')).filter(s => !s.deleted && !s.archived).slice(0, 2);
  assert(songs.length === 2, 'the chart update step needs two songs');
  const pickFor = s => fx.find(f => f.hash !== s.hash && f.pages !== s.pages && !songs.some(o => o.hash === f.hash));
  const z = new JSZip(), charts = songs.map((s, i) => { const f = pickFor(s); assert(f, 'no fixture differs from ' + s.title); z.file(`files/c${i + 1}.pdf`, f.b, {createFolders: false}); return {id: 'c' + (i + 1), target: s.id, song: s.song, artist: s.artist, version: s.version, hash: f.hash, f}; });
  z.file('update.json', JSON.stringify({app: 'setlist-stand', kind: 'chart-update', version: 1, made: new Date().toISOString(), charts: charts.map(({f, ...c}) => c)}));
  await page.setInputFiles('#chartUpdateFile', {name: 'updates.zip', mimeType: 'application/zip', buffer: Buffer.from(await z.generateAsync({type: 'nodebuffer'}))});
  await page.locator('.modal .cu-list .cu-row').first().waitFor({timeout: 30000});
  assert(await page.locator('.modal .cu-row input:checked').count() === 2, 'both songs are not ticked');
  await page.locator('.modal .cu-row', {hasText: songs[0].title}).locator('input').uncheck();
  assert(await page.locator('.modal [data-ok]').textContent() === 'Apply 1', 'the button does not say Apply 1');
  await page.click('.modal [data-ok]');
  const done = page.locator('.modal [role=dialog]').filter({has: page.locator('button.pri[data-x]')});
  await done.waitFor({timeout: 30000});
  assert(/Updated 1 song\./.test(await done.textContent()), 'result: ' + await done.textContent());
  await page.click('.modal [data-x]');
  const after = Object.fromEntries(Object.values(await idbAll(page, 'songs')).filter(s => !s.deleted).map(s => [s.id, s]));
  assert(after[songs[1].id].hash === charts[1].hash && after[songs[1].id].pages === charts[1].f.pages, 'the applied song does not hold the new chart');
  assert(after[songs[0].id].hash === songs[0].hash && after[songs[0].id].updated === songs[0].updated, 'the unticked song changed');
  await openSong(page, after[songs[1].id].title);
  await page.waitForFunction(n => new RegExp(`Page 1 of ${n}$`).test(document.querySelector('#vSub').textContent), charts[1].f.pages, {timeout: 15000});
  await toLibrary(page);
  assert(t.errors.length === errs, 'page errors: ' + t.errors.slice(errs).join(' | '));
}

async function stepCollections(t){
  const {page} = t;
  await toLibrary(page);
  const n0 = await songCount(page);
  const mgr = async fn => { await page.click('#view [data-collmanage]'); await page.locator('.collmgr').waitFor(); await fn(); await page.click('.collmgr [data-x]'); await page.waitForFunction(() => !document.querySelector('.modal')); };
  const newColl = async name => {
    await page.click('.collmgr [data-newcoll]');
    await page.locator('.collname input').fill(name);
    await page.click('.collname [data-ok]');
    await page.waitForFunction(() => !document.querySelector('.collname'));
    await page.locator('.collmgr .mname', {hasText: name}).waitFor();
  };
  await mgr(async () => { await newColl('Band A'); await newColl('Band B'); });
  const colls = Object.values(await idbAll(page, 'colls')).filter(c => !c.deleted);
  const A = colls.find(c => c.name === 'Band A').id, B = colls.find(c => c.name === 'Band B').id;
  assert(colls.length === 2 && colls.every(c => c.created > 0 && c.updated >= c.created && Object.keys(c).sort().join() === 'created,id,name,updated'), 'collection records: ' + JSON.stringify(colls));
  await mgr(async () => { await page.click(`.collmgr [data-mdef="${A}"]`); await page.locator(`.collmgr [data-mdef="${A}"]`, {hasText: 'Default'}).waitFor(); });
  assert(await page.evaluate(() => localStorage.getItem('ss-default-coll')) === A, 'the default is not kept on this tablet');

  /* the app opens on the default, shows only its songs; a new PDF joins it */
  await page.reload();
  await page.waitForSelector('.collbar [data-collpick]');
  const pressed = async id => (await page.locator(`.collbar [data-collpick="${id}"]`).getAttribute('aria-pressed')) === 'true';
  assert(await pressed(A) && !(await pressed(B)), 'the app did not open on the default collection');
  assert((await page.locator('.collbar button').allTextContents()).join('|') === 'All|Band A (default)|Band B|Collections', 'picker: ' + (await page.locator('.collbar button').allTextContents()).join('|'));
  assert(await songCount(page) === 0 && /No songs in Band A yet/.test(await page.locator('#libList').innerText()), 'Band A is not empty: ' + await page.locator('#libList').innerText());
  await page.setInputFiles('#file', path.join(FIX, 'one-page.pdf'));
  const dup = await page.locator('.dupask [data-dupadd]').waitFor({timeout: 4000}).then(() => true, () => false);
  if(dup) await page.click('.dupask [data-dupadd]');
  await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 1, null, {timeout: 15000});
  const mine = Object.values(await idbAll(page, 'songs')).filter(x => !x.deleted).sort((a, b) => b.added - a.added)[0];
  assert(JSON.stringify(mine.colls) === JSON.stringify([A]), 'the new PDF is not in the default collection: ' + JSON.stringify(mine.colls));

  /* put it in both bands; a new setlist joins the shown collection; B shows only that song, on both tabs */
  await songAct(page, 'edit', mine.id);
  await page.locator('.modal fieldset.checks').waitFor();
  assert(await page.locator(`.modal fieldset.checks input[value="${A}"]`).isChecked() && !(await page.locator(`.modal fieldset.checks input[value="${B}"]`).isChecked()), 'the Edit tick boxes do not show the song in Band A only');
  await page.locator(`.modal fieldset.checks input[value="${B}"]`).check();
  await page.click('.modal [data-ok]');
  await waitFor(async () => (await songRec(page, s => s.id === mine.id)).colls.length === 2, 'the two collections were not saved');
  await page.click('#tSets');
  await page.waitForTimeout(450);          // not a double tap (js/saving.js once(): the same button within 400 ms is ignored)
  await page.click('#view [data-newset]');
  await page.locator('.modal input[type=text]').fill('Band A Gig');
  await page.click('.modal [data-ok]');
  await page.waitForSelector('#view [data-addto]');
  assert(JSON.stringify((await setByName(page, 'Band A Gig')).colls) === JSON.stringify([A]), 'a new setlist did not join the shown collection');
  await page.click('#view [data-allsets]');
  await page.click('#tLib');
  await page.click(`.collbar [data-collpick="${B}"]`);
  assert(await songCount(page) === 1 && await page.locator(`#libList [data-open="${mine.id}"]`).count() === 1, 'Band B does not show just the one song');
  await page.click('#tSets');
  assert(await pressed(B), 'the choice was not kept when the tab changed');
  assert(await page.locator('#view [data-set]').count() === 0, 'Band B shows a setlist that is only in Band A');
  await page.click(`.collbar [data-collpick="all"]`);
  assert(await page.locator('#view [data-set]').count() >= 1, 'All does not show the setlist');

  /* deleting Band B takes two taps, keeps the song (and its place in Band A), and leaves a marker */
  const before = await songRec(page, s => s.id === mine.id);
  await toLibrary(page);
  await page.click('#view [data-collmanage]');
  await page.locator('.collmgr').waitFor();
  const del = page.locator(`.collmgr [data-mdel="${B}"]`);
  await del.click();
  assert(await del.textContent() === 'Tap again to delete', 'first tap on Delete says "' + await del.textContent() + '"');
  assert((await idbAll(page, 'colls'))[B].deleted !== true, 'one tap deleted the collection');
  await del.click();
  await page.waitForFunction(id => !document.querySelector(`.collmgr [data-mdel="${id}"]`), B, {timeout: 5000});
  await page.click('.collmgr [data-x]');
  const marker = (await idbAll(page, 'colls'))[B], after = await songRec(page, s => s.id === mine.id);
  assert(marker.deleted === true && marker.updated > 0 && Object.keys(marker).sort().join() === 'deleted,id,updated', 'collection marker: ' + JSON.stringify(marker));
  assert(JSON.stringify(after.colls) === JSON.stringify([A]) && after.updated > before.updated, 'the song after deleting Band B: ' + JSON.stringify({colls: after.colls, updated: [before.updated, after.updated]}));
  assert((await idbAll(page, 'files'))[mine.id] && !Object.values(await idbAll(page, 'songs')).some(x => x.id === mine.id && x.deleted), 'deleting a collection removed a song or its PDF');
  assert(await songCount(page) === n0 + 1 || await page.locator('.collbar [data-collpick="all"]').getAttribute('aria-pressed') === 'true', 'the library lost songs');
  assert((await page.locator('.collbar button').allTextContents()).join('|') === 'All|Band A (default)|Collections', 'picker after the delete: ' + (await page.locator('.collbar button').allTextContents()).join('|'));
  await page.click('.collbar [data-collpick="all"]');
  assert(await songCount(page) === n0 + 1, `library shows ${await songCount(page)} songs under All, expected ${n0 + 1}`);
  await page.evaluate(() => localStorage.removeItem('ss-default-coll'));
}

async function stepPickOrder(t){
  const {page} = t;
  await toLibrary(page);
  const n0 = await songCount(page);
  const files = ['Pick C', 'Pick A', 'Pick B'].map(n => { const f = path.join(TMP, n + '.pdf'); fs.copyFileSync(path.join(FIX, 'one-page.pdf'), f); return f; });
  await page.setInputFiles('#file', files);
  if(await page.locator('.dupask [data-dupadd]').waitFor({timeout: 4000}).then(() => true, () => false)) await page.click('.dupask [data-dupadd]');
  await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, n0 + 3, {timeout: 15000});
  await page.click('#tSets');
  if(await page.locator('#view [data-allsets]').count()) await page.click('#view [data-allsets]');
  await page.waitForTimeout(450);          // not a double tap (js/saving.js once(): the same button within 400 ms is ignored)
  await page.click('#view [data-newset]');
  await page.locator('.modal input[type=text]').fill('Order Test');
  await page.click('.modal [data-ok]');
  await page.waitForSelector('#view [data-addto]');
  const row = n => page.locator('.modal .pick label', {hasText: new RegExp('^\\d*' + n + '(, \\d+)?$')});
  const badges = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.modal .pick label')].map(l => [l.querySelector('.pt').textContent, l.querySelector('.badge').textContent])));
  const setTitles = async () => { const st = await setByName(page, 'Order Test'), all = await idbAll(page, 'songs'); return songIds(st).map(id => all[id].title); };

  /* tap C, A, B; untap A (B moves up); tap A again: C1 B2 A3, "Add 3", added in that order */
  await page.click('#view [data-addto]');
  await page.locator('.modal .pick').waitFor();
  assert(await page.evaluate(() => !document.activeElement.matches('input')), 'the search box took focus when the dialog opened (the tablet keyboard would pop up)');
  assert(await page.locator('.modal [data-ok]').isDisabled() && await page.locator('.modal [data-ok]').textContent() === 'Add 0', 'the button before any tap: ' + await page.locator('.modal [data-ok]').textContent());
  for(const n of ['Pick C', 'Pick A', 'Pick B']) await row(n).locator('input').check();
  assert(JSON.stringify([(await badges())['Pick C'], (await badges())['Pick A'], (await badges())['Pick B']]) === '["1","2","3"]', 'numbers after C, A, B: ' + JSON.stringify(await badges()));
  await row('Pick A').locator('input').uncheck();
  let b = await badges();
  assert(b['Pick C'] === '1' && b['Pick A'] === '' && b['Pick B'] === '2', 'after untapping A: ' + JSON.stringify(b));
  await row('Pick A').locator('input').check();
  b = await badges();
  assert(b['Pick C'] === '1' && b['Pick B'] === '2' && b['Pick A'] === '3', 'after tapping A again: ' + JSON.stringify(b));
  assert(await row('Pick C').locator('.vh').textContent() === ', 1', 'the row has no number in its label for a screen reader');
  assert(await page.locator('.modal [data-ok]').textContent() === 'Add 3', 'the button says "' + await page.locator('.modal [data-ok]').textContent() + '"');
  await page.click('.modal [data-ok]');
  await page.waitForFunction(() => !document.querySelector('.modal'));
  await waitFor(async () => (await setTitles()).length === 3, 'the three songs were not added');
  assert(JSON.stringify(await setTitles()) === '["Pick C","Pick B","Pick A"]', 'the setlist order after the pick: ' + JSON.stringify(await setTitles()));

  /* search: a number stays while the search hides its song, and the count still counts it; Cancel adds nothing */
  await page.click('#view [data-addto]');
  await page.locator('.modal .pick').waitFor();
  await row('Pick A').locator('input').check();
  await page.fill('.modal .pickq', 'Pick C');
  assert(await page.locator('.modal .pick label').count() === 1, 'the search shows ' + await page.locator('.modal .pick label').count() + ' songs for "Pick C"');
  await row('Pick C').locator('input').check();
  await page.fill('.modal .pickq', '');
  b = await badges();
  assert(b['Pick A'] === '1' && b['Pick C'] === '2', 'numbers after the search was cleared: ' + JSON.stringify(b));
  assert(await page.locator('.modal [data-ok]').textContent() === 'Add 2', 'the count after a search: ' + await page.locator('.modal [data-ok]').textContent());
  await page.fill('.modal .pickq', 'zzqx-no-song');
  assert(/No songs match/.test(await page.locator('.modal .pick').innerText()), 'a search with no match says nothing');
  await page.click('.modal [data-x]');
  await page.waitForFunction(() => !document.querySelector('.modal'));
  assert((await setTitles()).length === 3, 'Cancel added songs');
}

async function stepBackupReminder(t){
  const {page} = t;
  const nudge = () => page.evaluate(() => { const e = document.querySelector('#libNudge .nudge span'); return e ? e.textContent : null; });
  const wantNudge = async what => { await waitFor(async () => (await nudge()) !== null, what + ': no reminder'); assert(/^Changes since your last backup \(today\)\.$/.test(await nudge()), what + ': ' + await nudge()); };
  const noNudge = async what => { await page.waitForFunction(() => !document.querySelector('#libNudge .nudge'), null, {timeout: 5000}).catch(() => { throw new Error(what + ': the reminder is still shown: ' + '' ); }); };
  await toLibrary(page);
  await download(page, () => tapBackup(page));
  await noNudge('after a backup');
  /* one stroke is a change: the reminder shows on the Library and on Setlists, never in the viewer */
  await openSong(page, 'Pick A');
  await page.click('#vAnn');
  await drawOn(page, page.locator('#stage .sheet').first());
  await page.click('#tDone');
  assert(await page.evaluate(() => { const v = document.querySelector('#viewer').getBoundingClientRect(); return !document.querySelector('#viewer .nudge') && [...document.querySelectorAll('.nudge')].every(n => { const r = n.getBoundingClientRect(); return !r.width || document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('#viewer'); }); }), 'the reminder shows over the viewer');
  await page.click('#vBack');
  await page.click('#tLib');
  await wantNudge('Library after a stroke');
  await page.click('#tSets');
  await wantNudge('Setlists after a stroke');
  const dl = await download(page, () => page.click('#libNudge [data-backupnow]'));
  await noNudge('after Back up now');
  await page.click('#tLib'); await noNudge('Library after Back up now');
  /* renaming a setlist brings it back */
  await page.click('#tSets');
  await page.locator('#view [data-set]', {hasText: 'Order Test'}).first().click();
  await page.waitForSelector('#view [data-setmenu]');
  await setMenu(page, 'rename');
  await page.locator('.modal input[type=text]').fill('Order Test Renamed');
  await page.click('.modal [data-ok]');
  await wantNudge('open setlist after a rename');
  /* restoring a backup counts as backed up */
  await page.click('#view [data-allsets]');
  await toLibrary(page);
  const asked = await pickRestore(page, dl.file);
  assert(/A copy of 1 setlist is kept as "Order Test Renamed \(before restore\)"\./.test(asked || ''), 'the question does not say the renamed setlist is kept: ' + JSON.stringify(asked));
  await page.waitForFunction(() => /^Restored/.test(document.querySelector('#toast').textContent), null, {timeout: 30000});
  assert(/A copy of 1 setlist was kept: Order Test Renamed \(before restore\)\./.test(await closeRestored(page) || ''), 'no "Backup restored" box naming the kept setlist');
  /* the copy is in no backup yet: the reminder stays; the backup's name is back, the renamed one kept */
  await wantNudge('after a restore that kept a setlist copy');
  const names = Object.values(await idbAll(page, 'sets')).filter(x => !x.deleted).map(x => x.name);
  assert(names.includes('Order Test') && names.includes('Order Test Renamed (before restore)') && !names.includes('Order Test Renamed'), 'setlists after the restore: ' + JSON.stringify(names));
  /* a restore that keeps nothing counts as backed up: back up, then restore that same backup */
  const dl2 = await download(page, () => page.click('#libNudge [data-backupnow]'));
  await noNudge('after Back up now');
  const asked2 = await pickRestore(page, dl2.file);
  assert(/Nothing on this tablet is replaced\./.test(asked2 || ''), 'restoring the backup just made: ' + JSON.stringify(asked2));
  await page.waitForFunction(() => /^Restored/.test(document.querySelector('#toast').textContent), null, {timeout: 30000});
  assert(!(await closeRestored(page)), 'restoring the backup just made kept something');
  await noNudge('after a restore');
  await page.click('#tSets'); await noNudge('Setlists after a restore');
  await page.click('#tLib');
}

/* Gig dates (js/gigdate.js, js/gigui.js): groups on the Setlists list, the Gig date button, the one-time fill-in from a name. */
async function stepGigDates(t){
  const {page} = t;
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date(), y = now.getFullYear(), today = ymd(now);
  const next = ymd(new Date(y, now.getMonth() + 1, 15)), later = ymd(new Date(y, now.getMonth() + 2, 15));
  const early = `${y}-01-01` < today ? `${y}-01-01` : null;          // none when today is January 1
  const last = `${y - 1}-06-15`;
  const toSets = async () => {
    await toLibrary(page); await page.click('#tSets');
    if(await page.locator('.collbar [data-collpick="all"]').count()) await page.click('.collbar [data-collpick="all"]');
    await page.waitForSelector('#view [data-newset]');
  };
  const make = async (name, gig) => {
    await page.waitForTimeout(450);          // not a double tap (js/saving.js once(): the same button within 400 ms is ignored)
    await page.click('#view [data-newset]');
    await page.locator('.modal input[type=text]').fill(name);
    if(gig) await page.locator('.modal input[type=date]').fill(gig);
    await page.click('.modal [data-ok]');
    await page.waitForFunction(n => document.querySelector('#view h2')?.textContent === n, name);
    await page.click('#view [data-allsets]');
    await page.waitForSelector('#view [data-newset]');
  };
  /* the list as drawn: group headers (label without the arrow, open or not) and this step's rows ("Gd ...") */
  const screen = () => page.evaluate(() => [...document.querySelectorAll('#view h3.grp button, #view li.row .t')]
    .map(e => e.matches('button') ? 'H:' + [...e.childNodes].filter(n => !(n.classList && n.classList.contains('chev'))).map(n => n.textContent).join('') + (e.getAttribute('aria-expanded') === 'true' ? '' : ' [closed]') : e.textContent)
    .filter(s => s.startsWith('H:') || s.startsWith('Gd ')));
  const want = open => ['H:Upcoming', 'Gd Next', 'Gd Later', ...(early ? ['H:' + y, 'Gd Early'] : []), 'H:No date', 'Gd None',
    ...(open ? ['H:' + (y - 1), 'Gd Last'] : ['H:' + (y - 1) + ' (1) [closed]'])];
  const expectScreen = async (open, what) => {
    const w = JSON.stringify(want(open));
    await waitFor(async () => JSON.stringify(await screen()) === w, what).catch(async () => { throw new Error(`${what}: the Setlists list reads ${JSON.stringify(await screen())}, expected ${w}`); });
  };
  const gigOfSet = async name => (await setByName(page, name)).gig;

  await toSets();
  await make('Gd Later', later);
  await make('Gd Next', next);
  if(early) await make('Gd Early', early); else console.log('      (no earlier date this year: today is January 1, that group is not checked)');
  await make('Gd Last', last);
  await make('Gd None', null);
  assert(await gigOfSet('Gd Next') === next && await gigOfSet('Gd Last') === last && (await gigOfSet('Gd None')) === undefined, 'the dates from the New setlist dialog were not saved');
  await expectScreen(false, 'groups');
  await page.click(`h3.grp button[data-grp="y${y - 1}"]`);
  await expectScreen(true, 'last year opened');
  assert(await page.getAttribute(`h3.grp button[data-grp="y${y - 1}"]`, 'aria-expanded') === 'true', 'last year header is not aria-expanded after a tap');

  /* set, change, Cancel and clear on an open setlist; the date in words shows in .gigline */
  await page.locator('#view [data-set]').filter({has: page.locator('.t', {hasText: exactText('Gd None')})}).click();
  await page.waitForSelector('#view [data-setmenu]');
  assert(!(await page.locator('#view .gigline').count()), 'a setlist with no date shows a gig line');
  const long = g => page.evaluate(g => { const [a, b, c] = g.split('-').map(Number); return new Intl.DateTimeFormat(undefined, {weekday:'long', year:'numeric', month:'long', day:'numeric'}).format(new Date(a, b - 1, c)); }, g);
  const gigBox = async (fn) => { await setMenu(page, 'gig'); await page.locator('.modal input[type=date]').waitFor(); await fn(); await page.waitForFunction(() => !document.querySelector('.modal')); };
  const line = async (g, what) => {
    const w = await long(g);
    await waitFor(async () => (await page.locator('#view .gigline').count()) && (await page.locator('#view .gigline').textContent()) === w, `${what}: .gigline is not "${w}"`);
    await waitFor(async () => (await gigOfSet('Gd None')) === g, `${what}: the stored gig is not ${g}`);
  };
  const d1 = `${y}-03-07`, d2 = `${y}-03-21`;
  await gigBox(async () => { await page.locator('.modal input[type=date]').fill(d1); await page.click('.modal [data-ok]'); });
  await line(d1, 'set a date');
  await gigBox(async () => { assert(await page.locator('.modal input[type=date]').inputValue() === d1, 'the Gig date box does not show the date'); await page.locator('.modal input[type=date]').fill(d2); await page.click('.modal [data-ok]'); });
  await line(d2, 'change the date');
  await gigBox(async () => { await page.locator('.modal input[type=date]').fill(d1); await page.click('.modal [data-x]'); });
  await line(d2, 'Cancel');
  await gigBox(async () => { await page.click('.modal [data-clear]'); });
  await waitFor(async () => !(await page.locator('#view .gigline').count()), 'Clear left the gig line');
  assert(!('gig' in await setByName(page, 'Gd None')), 'Clear left a gig in the record');
  await page.click('#view [data-allsets]');

  /* reload: the dates are kept and last year is closed again */
  await page.reload();
  await page.waitForSelector('#libList');
  await toSets();
  await expectScreen(false, 'after a reload');
  assert(await gigOfSet('Gd Later') === later && await gigOfSet('Gd Last') === last && (!early || await gigOfSet('Gd Early') === early), 'a gig date was lost on reload');

  /* the fill-in: a name holding a full date is offered once, Fill in sets the gig and keeps the name */
  assert(!(await page.locator('.modal').count()), 'a dialog showed before any setlist name held a date');
  await page.waitForTimeout(450);          // not a double tap (js/saving.js once(): the same button within 400 ms is ignored)
  await page.click('#view [data-newset]');
  await page.locator('.modal input[type=text]').fill('Sf October 18 2026');
  await page.click('.modal [data-ok]');
  await page.waitForFunction(() => document.querySelector('#view h2')?.textContent === 'Sf October 18 2026');
  await page.click('#view [data-allsets]');
  await page.waitForFunction(() => document.querySelector('.modal h2')?.textContent === 'Fill in gig dates?', null, {timeout: 5000})
    .catch(() => { throw new Error('the fill-in dialog did not appear'); });
  const opts = await page.locator('.modal label.opt').allTextContents();
  assert(opts.length === 1 && opts[0].startsWith('Sf October 18 2026'), 'the fill-in lists ' + JSON.stringify(opts));
  await page.click('.modal [data-ok]');
  await page.waitForFunction(() => !document.querySelector('.modal'));
  await waitFor(async () => (await gigOfSet('Sf October 18 2026')) === '2026-10-18', 'Fill in did not set the gig to 2026-10-18');
  await toSets();
  await sleep(500);
  assert(!(await page.locator('.modal').count()), 'the fill-in dialog came back on the next draw');
  await page.reload();
  await page.waitForSelector('#libList');
  await toSets();
  await sleep(800);
  assert(!(await page.locator('.modal').count()), 'the fill-in dialog came back after a reload');
  assert(await gigOfSet('Sf October 18 2026') === '2026-10-18', 'the filled-in gig was lost on reload');
}

/* Download PDF and Download all (js/print.js setFileName, js/downloadall.js): the dated file name; the zip of every chart of the
   shown setlists once (the stored bytes) and one list file per setlist (empty ones skipped, " (2)" on a name clash); Stop
   part-way, the size refusal; nothing in the library changes. */
async function stepDownloads(t){
  const {page} = t, errs = t.errors.length, gig = '2026-12-05';
  const toSets = async () => {
    await toLibrary(page); await page.click('#tSets');
    if(await page.locator('.collbar [data-collpick="all"]').count()) await page.click('.collbar [data-collpick="all"]');
    if(await page.locator('#view [data-allsets]').count()) await page.click('#view [data-allsets]');
    await page.waitForSelector('#view [data-newset]');
  };
  /* a new setlist (New setlist opens it), with the picker's first song unless empty; then back to the list unless stayOpen */
  const make = async (name, date, withSong, stayOpen) => {
    await toSets();
    await page.waitForTimeout(450);          // not a double tap (js/saving.js once(): the same button within 400 ms is ignored)
    await page.click('#view [data-newset]');
    await page.locator('.modal input[type=text]').fill(name);
    if(date) await page.locator('.modal input[type=date]').fill(date);
    await page.click('.modal [data-ok]');
    await page.waitForFunction(n => document.querySelector('#view h2')?.textContent === n && !!document.querySelector('#view [data-addto]'), name);
    if(withSong){
      await page.click('#view [data-addto]');
      await page.locator('.modal .pick input[type=checkbox]').first().check();
      await page.click('.modal [data-ok]');
      await page.waitForFunction(() => document.querySelectorAll('#view [data-playat]').length === 1, null, {timeout: 5000});
    }
    if(!stayOpen) await toSets();
  };
  const snap = async () => { const o = {}; for(const s of ['songs', 'files', 'sets', 'ink', 'colls']) o[s] = await idbAll(page, s); return JSON.stringify(o); };
  /* counts download events while fn runs and for `ms` after */
  const noDownload = async (fn, ms, what) => {
    let n = 0; const on = () => n++;
    page.on('download', on);
    try{ await fn(); await sleep(ms); } finally { page.off('download', on); }
    assert(!n, `${what}: ${n} download(s) started`);
  };
  const toastIs = (text, what) => page.waitForFunction(s => document.querySelector('#toast.on')?.textContent === s, text, {timeout: 8000})
    .catch(async () => { throw new Error(`${what}: toast "${await page.locator('#toast').textContent()}", expected "${text}"`); });
  const openDlAll = async () => {
    await toSets();
    await page.waitForSelector('#view [data-dlall]:not([disabled])');
    await page.click('#view [data-dlall]');
    await page.locator('.modal h2', {hasText: 'Download all setlists'}).waitFor();
    assert(!(await page.locator('.modal #dInk').count()), 'Download all still has an annotations tick box');
    assert(await page.locator('.modal [data-ok]').textContent() === 'Make zip', 'Download all button: ' + await page.locator('.modal [data-ok]').textContent());
  };

  /* one setlist: the button reads Download PDF, the dialog "Download <name>", the file "<gig> <name>.pdf" */
  await make('Dl Pair', gig, true, true);
  let before = await snap();
  await page.click('#view [data-setmenu]');
  const dlItem = page.locator('.modal.menubox [data-item="print"]'); await dlItem.waitFor();
  assert((await dlItem.locator('b').textContent()) === 'Download PDF', 'the item reads ' + await dlItem.locator('b').textContent());
  await dlItem.click();
  const h = await page.locator('.modal h2').textContent();
  assert(h === 'Download Dl Pair', 'single download dialog title: ' + h);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.modal'));
  const one = await printSet(page, true);
  assert(one.name === `${gig} Dl Pair.pdf`, 'Download PDF file name: ' + one.name);
  assert((await PDFDocument.load(await fsp.readFile(one.file))).getPageCount() >= 1, 'the downloaded PDF has no pages');
  assert(await snap() === before, 'Download PDF changed the library');

  /* Download all under "All": a second "Dl Pair" (same name and date, the same first song) and an empty "Dl Empty" */
  await make('Dl Pair', gig, true);
  await make('Dl Empty', null, false);
  const songsNow = await idbAll(page, 'songs'), filesNow = await idbAll(page, 'files');
  const liveSong = id => songsNow[id] && !songsNow[id].deleted;        // liveItems: a setlist whose songs were all deleted counts as empty
  const fullSets = Object.values(await idbAll(page, 'sets')).filter(s => !s.deleted && s.items.some(it => it.type === 'song' && liveSong(it.id)));
  const full = fullSets.length;
  const used = fullSets.flatMap(s => s.items.filter(it => it.type === 'song' && liveSong(it.id)).map(it => it.id));
  const charts = [...new Set(used)].filter(id => filesNow[id]);          // each distinct chart with a stored PDF, once
  const pairs = fullSets.filter(s => s.name === 'Dl Pair');
  assert(pairs.length === 2, `${pairs.length} "Dl Pair" setlists with songs, expected 2`);
  const shared = pairs[0].items.find(it => it.type === 'song').id;
  assert(pairs[1].items.find(it => it.type === 'song').id === shared, 'the two "Dl Pair" setlists do not share their song');
  before = await snap();
  await openDlAll();
  const z = await download(page, () => page.click('.modal [data-ok]'));
  assert(z.name === 'Setlists - Setlist Stand.zip', 'zip name: ' + z.name);
  if(await page.locator('.modal h2', {hasText: 'Zip saved'}).count()) await page.click('.modal [data-x]');
  else {
    const want = `Saved ${charts.length} chart${charts.length == 1 ? '' : 's'} and ${full} setlist${full == 1 ? '' : 's'}`;
    await toastIs(want, 'Download all');
  }
  await page.waitForFunction(() => !document.querySelector('.modal'));
  const zip = await JSZip.loadAsync(await fsp.readFile(z.file)), names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  const songNames = names.filter(n => n.startsWith('Songs/')), listNames = names.filter(n => n.startsWith('Setlists/'));
  assert(songNames.length + listNames.length === names.length, 'the zip holds files outside Songs/ and Setlists/: ' + JSON.stringify(names));
  assert(songNames.every(n => /^Songs\/[^/]+\.pdf$/.test(n)) && listNames.every(n => /^Setlists\/[^/]+\.txt$/.test(n)), 'zip entry names: ' + JSON.stringify(names));
  assert(songNames.length === charts.length, `the zip holds ${songNames.length} charts, expected ${charts.length} (each distinct chart once; ${used.length} song rows)`);
  assert(listNames.length === full, `the zip holds ${listNames.length} list files, expected ${full} (one per setlist with songs)`);
  /* every chart is the stored bytes (SHA-256 equal to the song's), loads as a PDF, and the shared chart is in once */
  const got = [];
  for(const n of songNames){
    const b = await zip.file(n).async('uint8array');
    assert((await PDFDocument.load(b)).getPageCount() >= 1, `${n} in the zip has no pages`);
    got.push(createHash('sha256').update(b).digest('hex'));
  }
  const wantHashes = charts.map(id => songsNow[id].hash);
  assert(JSON.stringify([...got].sort()) === JSON.stringify([...wantHashes].sort()), 'the charts in the zip are not the stored bytes of the distinct charts');
  const sharedN = got.filter(h => h === songsNow[shared].hash).length, sameHash = wantHashes.filter(h => h === songsNow[shared].hash).length;
  assert(sharedN === sameHash, `the chart used in both "Dl Pair" setlists is in the zip ${sharedN} times, expected ${sameHash}`);
  /* the list files: the two same-named setlists get " (2)", the empty one is not there */
  const mine = listNames.filter(n => /Dl (Pair|Empty)/.test(n)).sort();
  assert(JSON.stringify(mine) === JSON.stringify([`Setlists/${gig} Dl Pair (2).txt`, `Setlists/${gig} Dl Pair.txt`]), 'this step\'s list files: ' + JSON.stringify(mine));
  assert(!names.some(n => /Dl Empty/.test(n)), 'the empty setlist is in the zip');
  const long = await page.evaluate(async g => (await import(new URL('js/gigdate.js', location.href).href)).gigLong(g), gig);
  const wantText = `Dl Pair\n${long}\n\n1. ${songsNow[shared].title}\n`;
  for(const n of mine){
    const txt = await zip.file(n).async('string');
    assert(txt === wantText, `${n} reads ${JSON.stringify(txt)}, expected ${JSON.stringify(wantText)}`);
  }
  assert(await snap() === before, 'Download all changed the library');

  /* Stop part-way: the page itself presses Stop the moment the second chart starts, so it is always mid-build */
  assert(charts.length >= 2, `only ${charts.length} distinct chart(s): Stop part-way needs two`);
  await openDlAll();
  await page.evaluate(() => {
    const ob = new MutationObserver(() => {
      const p = document.querySelector('.modal [role=status]');
      if(p && /^Adding chart 2 of /.test(p.textContent)){ ob.disconnect(); window.__dlStopAt = p.textContent; document.querySelector('.modal [data-x]').click(); }
    });
    ob.observe(document.body, {subtree: true, childList: true, characterData: true});
  });
  await noDownload(async () => {
    await page.click('.modal [data-ok]');
    await toastIs('Stopped. Nothing was downloaded.', 'Stop part-way');
    await page.waitForFunction(() => !document.querySelector('.modal'));
  }, 2000, 'Stop part-way');
  assert(await page.evaluate(() => window.__dlStopAt), 'Stop was not pressed during "Adding chart 2 of N"');

  /* the size refusal: the limit lowered in the module instance the app uses; refused before any work, nothing downloaded */
  const setMax = v => page.evaluate(async v => { (await import(new URL('js/downloadall.js', location.href).href)).limits.maxBytes = v; }, v);
  await setMax(1);
  try{
    await openDlAll();
    await noDownload(async () => {
      await page.click('.modal [data-ok]');
      await page.locator('.modal h2', {hasText: 'Too much to make at once'}).waitFor({timeout: 5000}).catch(() => { throw new Error('no "Too much to make at once" notice'); });
    }, 2000, 'size refusal');
    assert(/too much to make at once on a tablet/.test(await page.locator('.modal').textContent()), 'the refusal text: ' + await page.locator('.modal').textContent());
    await page.click('.modal [data-x]');
    await page.waitForFunction(() => !document.querySelector('.modal'));
  } finally { await setMax(400e6); }
  assert(await snap() === before, 'Stop or the size refusal changed the library');
  assert(t.errors.length === errs, 'page errors: ' + t.errors.slice(errs).join(' | '));
}

/* Import a setlist from a text file: the button on the Setlists list, the review box, one new setlist with the songs in
   file order, a break, a line with no match left out; nothing else in the library changes. */
const readStores = page => page.evaluate(() => new Promise(res => { const r = indexedDB.open('setlist-stand'); r.onsuccess = () => { const d = r.result, out = {};
  const tx = d.transaction(['songs', 'ink', 'sets']); let n = 3; for(const s of ['songs', 'ink', 'sets']){ const q = tx.objectStore(s).getAll(); q.onsuccess = () => { out[s] = q.result; if(!--n){ d.close(); res(out); } }; } }; }));
async function stepTextSetlist(t){
  const {page} = t, errs = t.errors.length;
  await toLibrary(page);
  const before = await readStores(page);
  /* two songs whose full title no other song shares (a title shared by two songs is a "Which one?" line, proven in the loop) */
  const live = before.songs.filter(s => !s.deleted), key = s => s.title.toLowerCase();
  const titles = live.filter(s => /^[a-z]/i.test(s.title) && live.filter(o => key(o) === key(s)).length === 1).slice(0, 2).map(s => s.title);
  assert(titles.length === 2, 'the library has fewer than two songs with a title of their own');
  await page.click('#tSets');
  if(await page.locator('#view [data-allsets]').count()) await page.click('#view [data-allsets]');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.tap('#view [data-importtext]')]);
  await fc.setFiles({name: 'Text gig.txt', mimeType: 'text/plain', buffer: Buffer.from(`1. ${titles[0].toUpperCase()}\r\nBreak\r\n2. ${titles[1]}\r\nNo Such Song Here\r\n`)});
  const box = page.locator('.modal.textimport'); await box.waitFor();
  const counts = await box.locator('[data-counts]').textContent();
  assert(counts === '2 songs found, 1 break, 1 line not found.', 'the review box counts: ' + counts);
  await box.locator('[data-ok]').tap();
  await page.waitForFunction(() => document.querySelector('#view h2')?.textContent === 'Text gig');
  const st = await setByName(page, 'Text gig');
  const after = await readStores(page);
  const name = id => (after.songs.find(s => s.id === id) || {}).title;
  const got = st.items.map(it => it.type === 'break' ? 'B:' + it.name : name(it.id));
  assert(JSON.stringify(got) === JSON.stringify([titles[0], 'B:Break', titles[1]]), 'the text setlist holds ' + JSON.stringify(got));
  assert(/Added the setlist Text gig: 2 songs, 1 line left out/.test(await page.locator('#toast').textContent()), 'toast: ' + await page.locator('#toast').textContent());
  after.sets = after.sets.filter(x => x.id !== st.id);
  assert(JSON.stringify(after) === JSON.stringify(before), 'the import changed songs, ink or another setlist');
  assert(t.errors.length === errs, 'page errors: ' + t.errors.slice(errs).join(' | '));
}

/* The back gesture (page.goBack is the same traversal): one layer at a time, then the song, then the app. Taps are touch taps.
   The walk starts on about:blank so "left the app" is the browser being on about:blank; the app is opened again at the end. */
async function stepBackSwipe(t){
  const {page, base} = t, errs = t.errors.length;
  const st = () => page.evaluate(() => ({url: location.href, len: history.length, mark: history.state && history.state.ss || null,
    viewer: !!document.querySelector('#viewer.on'), annot: document.querySelector('#vAnn').getAttribute('aria-pressed') === 'true',
    crop: !document.querySelector('#cropper').hidden, modals: document.querySelectorAll('.modal').length, set: document.querySelector('#view h2')?.textContent || null}));
  const back = async () => { await page.goBack({timeout: 10000}).catch(e => { if(!/ERR_ABORTED/.test(e.message)) throw e; }); await page.waitForTimeout(250); return page.url() === 'about:blank' ? {url: 'about:blank'} : st(); };
  const open = async () => {
    await page.tap('#tLib');
    await page.locator('#libList [data-open]').first().tap();
    await page.waitForSelector('#viewer.on #stage .sheet canvas');
    await page.evaluate(() => document.querySelector('#viewer').classList.remove('hide'));
    const s = await st(); assert(s.mark === 'viewer', 'opening a song added no history entry: ' + JSON.stringify(s));
  };
  const closed = (s, what) => assert(s.url.startsWith(base) && !s.viewer && s.mark === null, `${what}: ` + JSON.stringify(s));
  const leaves = async what => { const s = await back(); assert(s.url === 'about:blank', `${what}: one Back from the list did not leave the app: ` + JSON.stringify(s)); };
  await page.goto('about:blank');
  await page.goto(base + 'index.html'); await page.waitForSelector('#libList [data-open]');
  const len0 = (await st()).len;

  await open();
  await page.tap('#vNext'); await page.waitForTimeout(200);
  closed(await back(), 'Back from a song (after a page turn)');
  await leaves('after Back closed the song');

  await page.goto(base + 'index.html'); await page.waitForSelector('#libList [data-open]');
  await open();
  await page.tap('#vAnn');
  let s = await back();
  assert(s.viewer && !s.annot && s.mark === 'viewer', 'Back with Annotate on did not just turn it off: ' + JSON.stringify(s));
  await page.tap('#vCrop');
  await page.waitForFunction(() => /Page \d+ of/.test(document.querySelector('#cropHint').textContent));
  s = await back();
  assert(s.viewer && !s.crop && s.mark === 'viewer', 'Back on the Crop screen did not just close it: ' + JSON.stringify(s));
  await page.evaluate(() => { import('./js/util.js').then(u => u.ask('A question over the song', '')); });
  await page.locator('.modal input[type=text]').waitFor();
  s = await back();
  assert(s.viewer && s.modals === 0 && s.mark === 'viewer', 'Back with a dialog open did not just close it: ' + JSON.stringify(s));
  closed(await back(), 'Back after the layers');

  /* a setlist: Back returns to its screen; the app's own Back button leaves no entry */
  await page.tap('#tSets');
  if(await page.locator('#view [data-allsets]').count()) await page.tap('#view [data-allsets]');
  await page.tap('#view [data-newset]');
  await page.locator('.modal input[type=text]').fill('Back swipe');
  await page.tap('.modal [data-ok]');
  await page.waitForSelector('#view [data-addto]');
  await page.tap('#view [data-addto]');
  await page.locator('.modal .pick input').first().check();
  await page.tap('.modal [data-ok]');
  await page.waitForSelector('#items [data-playat]');
  await page.tap('#items [data-playat]');
  await page.waitForSelector('#viewer.on #stage .sheet canvas');
  s = await back(); closed(s, 'Back from a setlist song');
  assert(s.set === 'Back swipe', 'Back did not return to the setlist: ' + JSON.stringify(s));
  await page.tap('#items [data-playat]');
  await page.waitForSelector('#viewer.on #stage .sheet canvas');
  await page.evaluate(() => document.querySelector('#viewer').classList.remove('hide'));
  await page.tap('#vBack');
  await page.waitForFunction(() => !document.querySelector('#viewer.on') && !history.state);
  assert((await st()).len <= len0 + 1, 'the history grew: ' + JSON.stringify(await st()));
  await leaves('after the app\'s Back button');

  await page.goto(base + 'index.html'); await page.waitForSelector('#libList');
  assert(t.errors.length === errs, 'page errors: ' + t.errors.slice(errs).join(' | '));
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
  ['11 New version: same id and setlist place, notes cleared, new hash; the old chart and its marks kept in Archived', stepNewVersion],
  ['11b Copy a song: a second version with the same marks, its own stroke ids and the same PDF; the original is untouched', stepCopySong],
  ['12 delete leaves a marker in IndexedDB and in the backup', stepDelete],
  ['13 restore a version 1 backup', stepRestoreV1],
  ['14 setlist items: break, rename, print skips it, remove keeps song, duplicate', stepSetItems],
  ['15 viewer plays breaks between songs: tap, swipe, arrow keys, back', stepViewerBreaks],
  ['16 drag to reorder with touch and mouse; order saved and survives reload', stepDragTouch],
  ['17 drag in a 38-song set with autoscroll', stepDragLong],
  ['18 crop one page: dragged box saved, only that page drawn cropped and larger', stepCropPage],
  ['19 crop whole song: every page drawn with the song crop', stepCropSong],
  ['20 ink on a cropped page is stored in full-page fractions and stays put when the crop moves', stepCropInk],
  ['21 crop Reset: page crop first, then the song crop', stepCropReset],
  ['22 text notes: add, edit, move, undo, delete, eraser skips them, survive reload', stepTextNotes],
  ['23 print a cropped song: CropBox per page, annotations add bytes', stepCropPrint],
  ['24 backup and restore keep crops and text notes', stepCropBackup],
  ['25 a note with ♯ and ♭ prints as "C# to Bb"', stepPrintSharps],
  ['26 two-page view: the cropper steps to page 2 and crops only that page', stepCropSpread],
  ['27 cropper buttons pressed before the page renders do nothing and throw nothing', stepCropEarly],
  ['28 split a songbook: bookmarks give the songs, each is added as its own PDF', stepSplitBook],
  ['29 share: songs from the Library and a setlist each download as a package with the PDFs, no annotations', stepShare],
  ['30 import a share package: the setlist comes back under a new name, songs already here are not added again', stepShareImport],
  ['30a2 import chart updates: one of two charts unticked; the other song plays its new chart', stepChartUpdate],
  ['30b Collections: Band A and Band B, default opens on Band A, a new PDF joins it, a song in both, delete one keeps the song', stepCollections],
  ['30c Add songs in tap order: numbers, untap renumbers, Add N, setlist ends in that order; search keeps numbers', stepPickOrder],
  ['30d Backup reminder: after a backup none; a stroke or a rename brings it back on Library and Setlists, never in the viewer; a restore clears it', stepBackupReminder],
  ['30e Gig dates: Upcoming, this year, No date, last year closed; set, change, clear; kept on reload; the fill-in from a name, once', stepGigDates],
  ['30f Downloads: Download PDF names the file with the gig date; Download all zips each chart once (Songs/) and a list per setlist with songs (Setlists/, " (2)" on a clash); Stop part-way and the size refusal download nothing; the library is unchanged', stepDownloads],
  ['30f2 Import a setlist from a text file: the review box counts, songs in file order, a break, a no-match line left out, nothing else changed', stepTextSetlist],
  ['30g Back swipe: closes Annotate, the Crop screen, a dialog, then the song (back to the Library or the setlist); then leaves the app', stepBackSwipe],
  ['31 no request left localhost during the run', stepNoExternal],
];

/* ---------- runner ---------- */
/* Under SS_BROWSER=webkit these steps SKIP: they send touch input through Chromium's DevTools protocol (Input.dispatchTouchEvent);
   Playwright's WebKit can tap but cannot drag with a finger. */
const WEBKIT_SKIP = new Map([[stepDragTouch, 'touch drag needs Chromium DevTools (CDP)'], [stepDragLong, 'touch drag needs Chromium DevTools (CDP)']]);
const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'setlist-smoke-'));
process.on('exit', () => { if(!process.env.SS_KEEP_TMP && !failed) try{ fs.rmSync(TMP, {recursive: true, force: true}); }catch(e){} });   // a failed run keeps its folder (the failure screenshot is in it)
let failed = 0, server, browser;
try{
  { const why = tableProblem(ROOT); if(why){ console.log('FAIL: nothing was run: ' + why); process.exit(1); } }      // a stale table keeps the worker from installing: say so
  await waitFixtures();
  server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/`;
  await acquireSlot('smoke');            // one browser run at a time, and only when the Mac is not busy
  browser = await launchBrowser({headless: true});
  const context = await browser.newContext({viewport: {width: 1280, height: 800}, acceptDownloads: true, hasTouch: true});
  const page = await context.newPage();
  const cdp = WEBKIT ? null : await context.newCDPSession(page);      // CDP is Chromium only
  page.setDefaultTimeout(15000);
  const t = {page, context, cdp, base, data: {}, external: [], errors: []};
  context.on('request', r => { const u = r.url(); try{ const h = new URL(u).hostname; if(!['127.0.0.1', 'localhost'].includes(h)) t.external.push(u); }catch(e){ t.external.push(u); } });
  page.on('pageerror', e => t.errors.push(String(e && e.message || e)));
  let stop = false;
  for(const [name, fn] of STEPS){
    if(stop){ console.log(`SKIP: ${name}`); continue; }
    if(WEBKIT && WEBKIT_SKIP.has(fn)){ console.log(`SKIP: ${name} (WebKit: ${WEBKIT_SKIP.get(fn)})`); continue; }
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

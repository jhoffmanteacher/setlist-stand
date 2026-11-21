/*
 * Shared pieces for the closed-loop tests (tools/loops.mjs and tools/loops/*.loop.mjs).
 *
 * A "closed loop" test takes what an action PRODUCES (a backup zip, a printed PDF, a deployed file, a saved
 * record) and feeds it back through an independent path (restore it, render it, hash it, read it from the
 * source of truth), then compares with what went in. Nothing here is mocked.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {launchBrowser, WEBKIT} from './browser.mjs';

export {WEBKIT, ENGINE} from './browser.mjs';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIX = path.join(ROOT, 'tests', 'fixtures');
export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'setlist-loops-'));
/* Downloaded backups and printed PDFs go in TMP (they can be 40 MB each): remove it when the run ends. SS_KEEP_TMP=1 keeps it. */
process.on('exit', () => { if(!process.env.SS_KEEP_TMP) try{ fs.rmSync(TMP, {recursive: true, force: true}); }catch(e){} });
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function assert(c, msg){ if(!c) throw new Error(msg); }
export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/* vendor/*.js are UMD but package.json says "type":"module": evaluate them as CommonJS. */
const require = createRequire(import.meta.url);
export function requireUmd(f){
  const module = {exports: {}};
  const fn = vm.runInThisContext(`(function(exports, require, module, __filename, __dirname){${fs.readFileSync(f, 'utf8')}\n})`, {filename: f});
  fn.call(module.exports, module.exports, require, module, f, path.dirname(f));
  return module.exports;
}
export const PDFLib = requireUmd(path.join(ROOT, 'vendor', 'pdf-lib.min.js'));
export const {PDFDocument, PDFDict, PDFName} = PDFLib;
export const JSZip = requireUmd(path.join(ROOT, 'vendor', 'jszip.min.js'));

/* Private files (the MobileSheets backup and its converted zip) live in the main checkout's untracked "Claude outputs/".
   They are never copied into the repo. Override with SS_MSB / SS_LIBRARY_ZIP. Returns null when absent. */
export function privatePath(name){
  const env = {'MobileSheets_2026-11-18.msb': process.env.SS_MSB, 'setlist-stand-from-mobilesheets.zip': process.env.SS_LIBRARY_ZIP}[name];
  if(env) return fs.existsSync(env) ? env : null;
  try{
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {cwd: ROOT, encoding: 'utf8'}).trim();
    const f = path.join(path.dirname(common), 'Claude outputs', name);
    return fs.existsSync(f) ? f : null;
  }catch(e){ return null; }
}

/* ---------- static server; `overrides` (Map of "/path" -> Buffer) lets a test serve a changed file ---------- */
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.zip': 'application/zip'};
export async function startServer({root = ROOT, overrides = new Map()} = {}){
  /* srv.root can be switched while the server runs (the update loop serves "version 1" then "version 2"). */
  const srv = http.createServer(async (req, res) => {
    const root = srv.root;
    try{
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if(p.endsWith('/')) p += 'index.html';
      srv.hits.push(p);
      const type = TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream';
      const headers = {'Content-Type': type, 'Cache-Control': 'no-cache'};
      if(overrides.has(p)){ res.writeHead(200, headers).end(overrides.get(p)); return; }
      const f = path.resolve(root, '.' + p);
      if(!f.startsWith(root + path.sep)){ res.writeHead(403).end(); return; }
      const body = await fsp.readFile(f);       // read first: a missing file must give a 404, not a half-sent 200
      res.writeHead(200, headers).end(body);
    }catch(e){ res.writeHead(404, {'Content-Type': 'text/plain'}).end('not found'); }
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  srv.base = `http://127.0.0.1:${srv.address().port}/`;
  srv.overrides = overrides; srv.root = root;
  srv.hits = [];            // every path requested, in order (a loop can read or clear it)
  return srv;
}

/* A browser session: new context + page. `errors` collects page errors and console errors; `requests` every URL requested. */
export async function openSession(base, {viewport = {width: 1280, height: 800}, hasTouch = false, browser, storage} = {}){
  const own = !browser;
  browser = browser || await launchBrowser();
  const context = await browser.newContext({viewport, hasTouch, acceptDownloads: true, serviceWorkers: 'allow', ...(storage ? {storageState: storage} : {})});
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if(m.type() === 'error') errors.push('console: ' + m.text()); });
  context.on('request', r => requests.push(r.url()));
  const s = {browser, context, page, errors, requests, base,
    async goto(p = 'index.html'){ await page.goto(base + p); await page.waitForSelector('#libList, #view'); await page.waitForFunction(() => !document.querySelector('#view')?.textContent.includes('Loading'), null, {timeout: 10000}).catch(() => {}); },
    async swReady(){ await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {timeout: 15000}).catch(() => {}); },
    async close(){ await context.close(); if(own) await browser.close(); }};
  return s;
}

/* ---------- reading what the app stored ---------- */
export const idbAll = (page, store) => page.evaluate(store => new Promise((res, rej) => {
  const r = indexedDB.open('setlist-stand');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => {
    const d = r.result, out = {};
    if(!d.objectStoreNames.contains(store)){ d.close(); res(out); return; }
    const s = d.transaction(store).objectStore(store), c = s.openCursor();
    c.onsuccess = () => { const k = c.result; if(k){ out[k.key] = k.value instanceof Blob ? {blob: k.value.size} : k.value; k.continue(); } else { d.close(); res(out); } };
    c.onerror = () => rej(c.error);
  };
}), store);
/* SHA-256 of every stored PDF's bytes, keyed by song id, computed in the page. */
export const fileHashes = page => page.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open('setlist-stand');
  r.onerror = () => rej(r.error);
  r.onsuccess = async () => {
    const d = r.result, out = {};
    const keys = await new Promise(ok => { const q = d.transaction('files').objectStore('files').getAllKeys(); q.onsuccess = () => ok(q.result); });
    for(const k of keys){
      const blob = await new Promise(ok => { const q = d.transaction('files').objectStore('files').get(k); q.onsuccess = () => ok(q.result); });
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
      out[k] = [...h].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    d.close(); res(out);
  };
}));
/* Everything that matters, as plain JSON: songs, sets, ink pages, and each PDF's hash. */
export async function snapshot(page){
  return {songs: await idbAll(page, 'songs'), sets: await idbAll(page, 'sets'), ink: await idbAll(page, 'ink'), files: await fileHashes(page)};
}
/* Drops fields that legitimately change between a backup and its restore (none today), so snapshots compare with deepEqual. */
export function normalise(snap){ return JSON.parse(JSON.stringify(snap)); }

/* Structural diff: returns a list of human-readable differences (empty = equal). */
export function diff(a, b, at = '', out = [], limit = 20){
  if(out.length >= limit) return out;
  if(a === b) return out;
  if(typeof a !== typeof b || a === null || b === null || typeof a !== 'object'){
    if(!(typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9)) out.push(`${at || '(root)'}: ${JSON.stringify(a)?.slice(0, 80)} != ${JSON.stringify(b)?.slice(0, 80)}`);
    return out;
  }
  if(Array.isArray(a) !== Array.isArray(b)){ out.push(`${at}: array vs object`); return out; }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for(const k of keys){
    if(!(k in a)) out.push(`${at}.${k}: missing on left`);
    else if(!(k in b)) out.push(`${at}.${k}: missing on right`);
    else diff(a[k], b[k], `${at}.${k}`, out, limit);
  }
  return out;
}

export async function download(page, action){
  const [dl] = await Promise.all([page.waitForEvent('download', {timeout: 60000}), action()]);
  const f = path.join(TMP, `${Date.now()}-${dl.suggestedFilename()}`);
  await dl.saveAs(f);
  return {file: f, name: dl.suggestedFilename()};
}
/* Restore a Setlist Stand zip through the real Restore button and wait for the toast. */
export async function restoreZip(page, file, timeout = 180000){
  await page.evaluate(() => { const t = document.querySelector('#toast'); if(t) t.textContent = ''; });
  await page.click('#tLib');
  await page.setInputFiles('#restoreFile', file);
  await page.waitForFunction(() => /Restored \d+ song|not a Setlist Stand backup/.test(document.querySelector('#toast').textContent), null, {timeout});
  const msg = await page.locator('#toast').textContent();
  assert(/Restored/.test(msg), 'restore failed: ' + msg);
  await sleep(400);
  return msg;
}
export async function backupNow(page){
  await page.click('#tLib');
  return download(page, () => page.click('[data-backup]'));
}
/* Wipe the app's database (as a fresh install would be). */
export const wipe = async page => {
  /* The app keeps its database open, so the delete is "blocked" until the page goes away. Chromium then finishes it after the
     reload; WebKit drops it and the data stays. Under WebKit delete from a bare page of the same site (no connection open). */
  if(WEBKIT && /^https?:/.test(page.url())) await page.goto(new URL('/css/app.css', page.url()).href);
  await page.evaluate(() => new Promise(res => {
    const r = indexedDB.deleteDatabase('setlist-stand'); r.onsuccess = r.onerror = r.onblocked = () => res();
  }));
};

/* Is the element really DRAWN on the screen the person sees? Not "is it in the page" or "does it have size": in full
   screen the browser draws only the full-screen element and what is inside it, so a dialog outside it is in the page,
   has a size, takes focus, and cannot be seen. The element's area is photographed as it is, with the element switched to
   visibility:hidden, and as it is again; if the browser draws it, the hidden photograph differs from both of the others.
   The two "as it is" photographs must agree (something else repainting in that area, a redraw after a resize, would
   otherwise look like the element): if they do not, the whole check is tried again, and after three tries it throws.
   Nothing is assumed about colours. */
export async function onScreen(page, sel){
  for(let attempt = 1; attempt <= 3; attempt++){
    const r = await page.evaluate(sel => {
      const e = document.querySelector(sel); if(!e) return null;
      const b = e.getBoundingClientRect(), x = Math.max(0, Math.floor(b.x)), y = Math.max(0, Math.floor(b.y));
      return {x, y, width: Math.min(innerWidth, Math.ceil(b.right)) - x, height: Math.min(innerHeight, Math.ceil(b.bottom)) - y};
    }, sel);
    if(!r || r.width < 1 || r.height < 1) return false;
    const shot = () => page.screenshot({clip: r, animations: 'disabled', caret: 'hide'});
    const a = await shot();
    const was = await page.evaluate(sel => { const e = document.querySelector(sel), v = e.style.visibility; e.style.visibility = 'hidden'; return v; }, sel);
    let b, c;
    try{ b = await shot(); }
    finally{ await page.evaluate(([sel, v]) => { const e = document.querySelector(sel); if(e) e.style.visibility = v; }, [sel, was]); }
    c = await shot();
    if(a.equals(c)) return !a.equals(b);
    await sleep(250);
  }
  throw new Error('the screen kept changing under ' + sel + ' while it was being checked (three tries)');
}

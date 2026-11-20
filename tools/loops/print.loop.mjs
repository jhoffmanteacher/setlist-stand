/*
 * Print loops: what the Print PDF button PRODUCES is rendered back with pdf.js (an independent path from pdf-lib,
 * which wrote it), and the pixels and text are compared with what went in (set order, stored strokes and notes,
 * the crop, the viewer's own canvases, the source PDF).
 * Positions are compared in fractions of the shown page (or of the cropped area), never in absolute pixels.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {FIX, TMP, ROOT, assert, sha256, sleep, idbAll, fileHashes, download, requireUmd} from './harness.mjs';

const PL = requireUmd(path.join(ROOT, 'vendor', 'pdf-lib.min.js'));
const PW = 612, PH = 792;                                  // fixture page size (letter, points)
const FIXTURES = {'two-page.pdf': 'A', 'three-page.pdf': 'B', 'one-page.pdf': 'C'};
const RED = '#d62828', BLUE = '#1f5fd6', YELLOW = '#ffd400', GREEN_HL = '#7be07b', MARKER = '#00a000';
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fmt = o => JSON.stringify(o, (k, v) => typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactText = s => new RegExp('^' + reEsc(s) + '$');
const liveOf = v => (v && Array.isArray(v.strokes) ? v.strokes : []).filter(s => !s.deleted);
async function waitFor(fn, what, ms = 6000){
  const end = Date.now() + ms; let v;
  while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(120); }
  throw new Error(what);
}
/* bbox {x0,y0,x1,y1} -> short text */
const bb = b => b && b.n ? `[${[b.x0, b.y0, b.x1, b.y1].map(v => v.toFixed(4)).join(', ')}] (${b.n} px)` : 'none (0 px)';

/* ---------- in-page measuring kit (installed on demand; survives nothing, re-installed after reloads) ---------- */
function kit(){
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  window.__pl = {
    store: {},
    /* Renders every page of a PDF with pdf.js at `scale`; keeps the canvases under `key`; returns size, text and rotation. */
    async render(key, b64, scale){
      if(!pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      const bin = atob(b64), u = new Uint8Array(bin.length);
      for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const doc = await pdfjsLib.getDocument({data: u}).promise, out = [], cvs = [];
      for(let p = 1; p <= doc.numPages; p++){
        const pg = await doc.getPage(p), vp = pg.getViewport({scale});
        const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
        await pg.render({canvasContext: c, viewport: vp}).promise;
        const tc = await pg.getTextContent();
        out.push({w: cv.width, h: cv.height, vw: vp.width / scale, vh: vp.height / scale, rotate: pg.rotate, view: pg.view,
          text: tc.items.map(i => i.str).join('').replace(/\s+/g, ' ').trim(), items: tc.items.map(i => i.str)});
        cvs.push(cv);
      }
      await doc.destroy();
      this.store[key] = cvs;
      return out;
    },
    /* Copies the viewer's page canvas and ink canvas (ink composited on white) of page pn into store[key] = [page, ink]. */
    grabViewer(key, pn){
      const ink = document.querySelector(`#stage .ink[data-pn="${pn}"]`); if(!ink) return null;
      const pageCv = ink.parentElement.querySelector('canvas:not(.ink)');
      const copy = (src, white) => { const cv = document.createElement('canvas'); cv.width = src.width; cv.height = src.height;
        const c = cv.getContext('2d'); if(white){ c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height); } c.drawImage(src, 0, 0); return cv; };
      this.store[key] = [copy(pageCv, true), copy(ink, true)];
      return {w: ink.width, h: ink.height, pw: pageCv.width, ph: pageCv.height};
    },
    /* Bounding box (fractions of the canvas) of pixels that look like colour c laid over white at opacity aMin..aMax.
       spec.dark: pixels with every channel < 90 instead. region: [x0, y0, x1, y1] fractions. */
    box(key, i, spec, region){
      const cv = this.store[key][i], W = cv.width, H = cv.height, d = cv.getContext('2d').getImageData(0, 0, W, H).data;
      const r = region || [0, 0, 1, 1];
      const X0 = Math.max(0, Math.floor(r[0] * W)), Y0 = Math.max(0, Math.floor(r[1] * H)), X1 = Math.min(W, Math.ceil(r[2] * W)), Y1 = Math.min(H, Math.ceil(r[3] * H));
      let c, k, aMin = spec.aMin ?? .5, aMax = spec.aMax ?? 1.02, tol = spec.tol ?? 24;
      if(!spec.dark){ c = hex(spec.c); k = [0, 1, 2].sort((a, b) => c[a] - c[b])[0]; }
      let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for(let y = Y0; y < Y1; y++) for(let x = X0; x < X1; x++){
        const o = (y * W + x) * 4, px = [d[o], d[o + 1], d[o + 2]];
        let ok;
        if(spec.dark) ok = px[0] < 90 && px[1] < 90 && px[2] < 90;
        else {
          const a = (255 - px[k]) / (255 - c[k]);
          ok = a >= aMin && a <= aMax && [0, 1, 2].every(j => Math.abs(255 - a * (255 - c[j]) - px[j]) <= tol);
        }
        if(ok){ n++; if(x < x0) x0 = x; if(y < y0) y0 = y; if(x > x1) x1 = x; if(y > y1) y1 = y; }
      }
      return n ? {n, x0: x0 / W, y0: y0 / H, x1: (x1 + 1) / W, y1: (y1 + 1) / H, W, H} : {n: 0, W, H};
    },
    /* Pixel difference between store[a][i] and store[b][j] (same size required). */
    diff(a, i, b, j){
      const A = this.store[a][i], B = this.store[b][j];
      if(A.width !== B.width || A.height !== B.height) return {size: [A.width, A.height, B.width, B.height]};
      const da = A.getContext('2d').getImageData(0, 0, A.width, A.height).data, db = B.getContext('2d').getImageData(0, 0, B.width, B.height).data;
      let max = 0, nDiff = 0, sum = 0;
      for(let o = 0; o < da.length; o += 4){
        const m = Math.max(Math.abs(da[o] - db[o]), Math.abs(da[o + 1] - db[o + 1]), Math.abs(da[o + 2] - db[o + 2]));
        if(m){ nDiff++; sum += m; } if(m > max) max = m;
      }
      return {max, nDiff, total: da.length / 4, mean: sum / (da.length / 4)};
    },
    /* Like diff, but both pages are first scaled down to w x h (smoothed), so resampling and JPEG noise average out:
       per pixel the largest channel difference; returns its mean, 99th percentile and max. */
    smallDiff(a, i, b, j, w, h){
      const shrink = src => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const c = cv.getContext('2d'); c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
        c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); c.drawImage(src, 0, 0, w, h); return c.getImageData(0, 0, w, h).data; };
      const A = this.store[a][i], B = this.store[b][j], da = shrink(A), db = shrink(B), m = [];
      for(let o = 0; o < da.length; o += 4) m.push(Math.max(Math.abs(da[o] - db[o]), Math.abs(da[o + 1] - db[o + 1]), Math.abs(da[o + 2] - db[o + 2])));
      const sorted = m.slice().sort((x, y) => x - y);
      return {mean: m.reduce((s, v) => s + v, 0) / m.length, p99: sorted[Math.floor(sorted.length * .99)], max: sorted.at(-1), sizes: [A.width, A.height, B.width, B.height]};
    },
  };
}
async function ensureKit(page){ if(!(await page.evaluate(() => !!window.__pl))) await page.evaluate(`(${kit.toString()})()`); }
async function renderPdf(page, key, bytes, scale = 2){
  await ensureKit(page);
  return page.evaluate(([k, b, s]) => window.__pl.render(k, b, s), [key, Buffer.from(bytes).toString('base64'), scale]);
}
async function grabViewer(page, key, pn){ await ensureKit(page); return page.evaluate(([k, p]) => window.__pl.grabViewer(k, p), [key, pn]); }
const boxOf = (page, key, i, spec, region) => page.evaluate(([k, i, s, r]) => window.__pl.box(k, i, s, r), [key, i, spec, region || null]);
const pixDiff = (page, a, i, b, j) => page.evaluate(([a, i, b, j]) => window.__pl.diff(a, i, b, j), [a, i, b, j]);
const smallDiff = (page, a, i, b, j, w, h) => page.evaluate(([a, i, b, j, w, h]) => window.__pl.smallDiff(a, i, b, j, w, h), [a, i, b, j, w, h]);

/* ---------- driving the app ---------- */
async function toLibrary(page){
  if(await page.locator('#viewer.on').count()) await page.click('#vBack');
  await page.click('#tLib');
  await page.waitForSelector('#libList');
}
/* Imports files through the real file picker; returns {fileName: songId} found by the file's SHA-256. */
async function importFiles(page, files){
  await toLibrary(page);
  const n0 = await page.locator('#libList [data-open]').count();
  await page.setInputFiles('#file', files);
  await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, n0 + files.length, {timeout: 15000})
    .catch(() => { throw new Error(`import of ${files.length} files did not show in the library`); });
  const songs = Object.values(await idbAll(page, 'songs')), out = {};
  for(const f of files){
    const h = sha256(fs.readFileSync(f)), s = songs.find(x => x.hash === h && !x.deleted);
    assert(s, `${path.basename(f)}: no song record with its hash`);
    out[path.basename(f)] = s.id;
  }
  return out;
}
const songsById = async page => idbAll(page, 'songs');
async function subPage(page){ const m = /Page (\d+)/.exec(await page.locator('#vSub').textContent()); return m ? +m[1] : 0; }
async function openSong(page, id, pn = 1){
  await toLibrary(page);
  await page.click(`#libList [data-open="${id}"]`);
  await page.waitForSelector('#viewer.on #stage .sheet canvas');
  if(await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
  await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 1, null, {timeout: 5000});
  for(let i = 0; i < 8; i++){
    const cur = await subPage(page);
    if(cur === pn && await page.locator(`#stage .ink[data-pn="${pn}"]`).count()) return;
    if(cur !== pn) await page.keyboard.press(cur < pn ? 'ArrowRight' : 'ArrowLeft');
    await sleep(250);
  }
  await page.waitForSelector(`#stage .ink[data-pn="${pn}"]`, {timeout: 3000}).catch(() => { throw new Error(`could not get to page ${pn}`); });
}
const sheetBox = (page, pn) => page.locator(`#stage .sheet:has(.ink[data-pn="${pn}"])`).boundingBox();
async function annotOn(page){ if(!(await page.locator('#tools').isVisible())) await page.click('#vAnn'); }
async function pickTool(page, tool, color){
  await annotOn(page);
  if(tool === 'text'){ if(await page.getAttribute('#tools [data-tool=text]', 'aria-pressed') !== 'true') await page.click('#tools [data-tool=text]'); return; }
  if(await page.getAttribute('#tools [data-tool=text]', 'aria-pressed') === 'true') await page.click('#tools [data-tool=text]');
  await page.click(color ? `#tools [data-tool=${tool}][data-color="${color}"]` : `#tools [data-tool=${tool}]`);
}
const inkRec = async (page, id, pn) => (await idbAll(page, 'ink'))[id + ':' + pn];
/* Draws through pts (fractions of the shown sheet) with the current tool; returns the new stored stroke. */
async function drawPath(page, id, pn, pts){
  const old = new Set(((await inkRec(page, id, pn)) || {strokes: []}).strokes.map(s => s.id));
  const b = await sheetBox(page, pn), P = p => [b.x + b.width * p[0], b.y + b.height * p[1]];
  await page.mouse.move(...P(pts[0])); await page.mouse.down();
  for(const p of pts.slice(1)) await page.mouse.move(...P(p), {steps: 5});
  await page.mouse.up();
  return waitFor(async () => liveOf(await inkRec(page, id, pn)).find(s => s.t !== 'text' && !old.has(s.id)), `no new stroke saved on page ${pn}`);
}
async function addNote(page, id, pn, fx, fy, {text, size, color}){
  await pickTool(page, 'text');
  const b = await sheetBox(page, pn);
  await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
  const m = page.locator('.modal');
  await m.locator('textarea').waitFor({timeout: 5000}).catch(() => { throw new Error('note dialog did not open'); });
  await m.locator('textarea').fill(text);
  if(size) await m.locator(`[data-size=${size}]`).click();
  if(color) await m.locator(`[data-color="${color}"]`).click();
  await m.locator('[data-ok]').click();
  await page.waitForFunction(() => !document.querySelector('.modal'));
  return waitFor(async () => liveOf(await inkRec(page, id, pn)).find(s => s.t === 'text' && s.text === text && near(s.x, fx, .03) && near(s.y, fy, .03)), `note "${text}" not saved`);
}
async function showChrome(page){
  if(await page.locator('#viewer.hide').count()){ await page.mouse.click(640, 420); await page.waitForSelector('#viewer:not(.hide)'); }
}
/* Crops page pn through the real crop editor: drags the nw and se handles to the given page fractions. */
async function cropUI(page, id, pn, nw, se, whole){
  if(await page.locator('#tools').isVisible()) await page.click('#tDone');
  await showChrome(page);
  await page.click('#vCrop');
  await page.waitForFunction(pn => !document.querySelector('#cropper').hidden && new RegExp('^Page ' + pn + ' of').test(document.querySelector('#cropHint').textContent), pn, {timeout: 5000});
  const drag = async (h, f) => {
    const s = await page.locator('#cropSheet').boundingBox(), hb = await page.locator(`#cropBox .ch[data-h=${h}]`).boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
    await page.mouse.move(s.x + s.width * f[0], s.y + s.height * f[1], {steps: 8}); await page.mouse.up();
  };
  if(nw) await drag('nw', nw);
  if(se) await drag('se', se);
  await page.click(whole ? '#cropSong' : '#cropPage');
  await page.waitForSelector('#cropper', {state: 'hidden', timeout: 5000});
  const want = c => whole ? c && c.all : c && c.pages && c.pages[pn];
  let c;
  await waitFor(async () => want(c = (await songsById(page))[id].crop), 'crop not saved');
  await sleep(300);                                       // the viewer redraws with the crop
  return c;
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
async function addSong(page, title){
  const n0 = await rowCount(page);
  await page.click('#view [data-addto]');
  await page.locator('.modal .pick').waitFor();
  const box = page.locator('.modal .pick label', {hasText: exactText(title)}).locator('input');
  assert(await box.count() === 1, `picker has ${await box.count()} rows titled "${title}"`);
  await box.check();
  await page.click('.modal [data-ok]');
  await page.waitForFunction(n => document.querySelectorAll('#items > li.row').length === n, n0 + 1, {timeout: 5000});
}
async function addBreak(page){
  const n0 = await rowCount(page);
  await page.click('#view [data-addbreak]');
  await page.waitForFunction(n => document.querySelectorAll('#items > li.row').length === n, n0 + 1, {timeout: 5000});
}
async function openSetNamed(page, name){
  await toLibrary(page);
  await page.click('#tSets');
  await page.locator('#view [data-set]').filter({has: page.locator('.t', {hasText: exactText(name)})}).click();
  await page.waitForFunction(n => document.querySelector('#view h2')?.textContent === n && !!document.querySelector('#view [data-addto]'), name);
}
/* A set made of these songs (by id), printed through the real dialog. Returns the PDF bytes. */
async function setOf(page, name, ids){
  const songs = await songsById(page);
  await newSet(page, name);
  for(const id of ids) await addSong(page, songs[id].title);
}
async function printSet(page, withInk){
  await page.click('#view [data-print]');
  const m = page.locator('.modal');
  await m.waitFor();
  await m.locator('#pInk').setChecked(withInk);
  const dl = await download(page, () => m.locator('[data-ok]').click());
  if(await page.locator('.modal').count()){ const x = page.locator('.modal [data-x]'); await x.waitFor({timeout: 5000}); await x.click(); }
  await page.waitForFunction(() => !document.querySelector('.modal'));
  return fsp.readFile(dl.file);
}
/* Bounding box of a stroke's stored points, grown by half its width (w is a fraction of page WIDTH). */
function strokeBox(s, aspect = PW / PH){
  const xs = s.p.map(p => p[0]), ys = s.p.map(p => p[1]), hw = s.w / 2, hh = s.w / 2 * aspect;
  return {x0: Math.min(...xs) - hw, y0: Math.min(...ys) - hh, x1: Math.max(...xs) + hw, y1: Math.max(...ys) + hh};
}
/* rect (full-page fractions) seen through crop cr (fractions of the crop area), clipped to it */
const throughCrop = (r, cr) => {
  const c = {x0: (r.x0 - cr.x) / cr.w, y0: (r.y0 - cr.y) / cr.h, x1: (r.x1 - cr.x) / cr.w, y1: (r.y1 - cr.y) / cr.h};
  return {x0: Math.max(0, c.x0), y0: Math.max(0, c.y0), x1: Math.min(1, c.x1), y1: Math.min(1, c.y1)};
};
/* Box (fractions of the crop area) of the part of stroke s that lies inside crop cr: each segment clipped to the crop
   (Liang-Barsky), grown by half the stroke width, then clipped to the crop area. */
function clippedStrokeBox(s, cr, aspect = PW / PH){
  const pts = [], X0 = cr.x, X1 = cr.x + cr.w, Y0 = cr.y, Y1 = cr.y + cr.h;
  const seg = s.p.length === 1 ? [[s.p[0], s.p[0]]] : s.p.slice(1).map((q, i) => [s.p[i], q]);
  for(const [a, b] of seg){
    const dx = b[0] - a[0], dy = b[1] - a[1]; let t0 = 0, t1 = 1, ok = true;
    for(const [p, q] of [[-dx, a[0] - X0], [dx, X1 - a[0]], [-dy, a[1] - Y0], [dy, Y1 - a[1]]]){
      if(p === 0){ if(q < 0) ok = false; continue; }
      const t = q / p;
      if(p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    if(ok && t0 <= t1) pts.push([a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]);
  }
  if(!pts.length) return null;
  return throughCrop(strokeBox({p: pts, w: s.w}, aspect), cr);
}
const boxNear = (got, want, tx, ty = tx) => !!got && got.n > 0 && near(got.x0, want.x0, tx) && near(got.x1, want.x1, tx) && near(got.y0, want.y0, ty) && near(got.y1, want.y1, ty);
const noErrors = s => assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
async function sourceUntouched(page, ids, files){
  const h = await fileHashes(page);
  for(const [f, id] of Object.entries(ids)) if(files[f]) assert(h[id] === sha256(fs.readFileSync(files[f])), `stored PDF of ${f} changed: SHA-256 ${h[id]} != fixture`);
}

/* ---------- protected (encrypted) PDFs ---------- */
/* An encrypted copy of src, made with pypdf (it lives in the user's site-packages, so python3 runs without -I).
   user '' = opens anywhere without a password (typical for bought charts); owner password set. */
function encryptPdf(src, dst, user = ''){
  execFileSync('python3', ['-c', `import sys
from pypdf import PdfReader, PdfWriter
w = PdfWriter(); w.append(PdfReader(sys.argv[1])); w.encrypt(sys.argv[3], 'owner', algorithm='RC4-128'); w.write(sys.argv[2])`, src, dst, user]);
  assert(fs.readFileSync(dst, 'latin1').includes('/Encrypt'), `${path.basename(dst)} is not encrypted (test setup)`);
  return dst;
}
/* Writes one record straight into IndexedDB (b64: the value is a PDF Blob of these bytes). */
const idbPut = (page, store, key, value, b64) => page.evaluate(([store, key, value, b64]) => new Promise((res, rej) => {
  if(b64){ const bin = atob(b64), u = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); value = new Blob([u], {type: 'application/pdf'}); }
  const r = indexedDB.open('setlist-stand');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => { const d = r.result, tx = d.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key);
    tx.oncomplete = () => { d.close(); res(); }; tx.onerror = () => rej(tx.error); };
}), [store, key, value, b64 || null]);
const dialogText = page => page.locator('.modal').textContent().catch(() => '(closed)');
/* Print through the real dialog up to the protected-charts question; returns its list items and buttons. */
async function askProtected(page, withInk){
  await page.click('#view [data-print]');
  const m = page.locator('.modal');
  await m.waitFor();
  await m.locator('#pInk').setChecked(withInk);
  await m.locator('[data-ok]').click();
  await page.waitForFunction(() => document.querySelector('.modal #printLocked'), null, {timeout: 30000})
    .catch(async () => { throw new Error(`no question about protected charts. Dialog: "${await dialogText(page)}", toast "${await page.locator('#toast').textContent()}"`); });
  return {items: (await page.locator('.modal li').allTextContents()).map(x => x.trim()),
    buttons: (await page.locator('.modal .btns button').allTextContents()).map(x => x.trim()), text: await dialogText(page)};
}
/* Taps "Print them as pictures"; returns the PDF bytes and every progress line shown while it worked. */
async function printAsPictures(page){
  await page.evaluate(() => { window.__stat = []; window.__focus = []; window.__statOb = new MutationObserver(() => {
    const t = document.querySelector('#pStatus')?.textContent;
    if(t && window.__stat.at(-1) !== t){ window.__stat.push(t); window.__focus.push(!!document.activeElement?.closest('.modal')); } });
    window.__statOb.observe(document.body, {subtree: true, childList: true, characterData: true}); });
  const dl = await download(page, () => page.click('.modal [data-pics]'));
  const {statuses, focus} = await page.evaluate(() => { window.__statOb.disconnect(); return {statuses: window.__stat, focus: window.__focus}; });
  /* the pressed button is replaced by the progress screen: focus must stay inside the dialog (Escape and Tab live there) */
  assert(focus.length && focus.every(Boolean), `focus left the dialog while the pictures PDF was made: ${JSON.stringify(focus)}`);
  if(await page.locator('.modal').count()){ const x = page.locator('.modal [data-x]'); await x.waitFor({timeout: 5000}); await x.click(); }
  await page.waitForFunction(() => !document.querySelector('.modal'));
  return {bytes: await fsp.readFile(dl.file), statuses};
}
const PROTECTED_LINE = 'These charts are protected, so they print as pictures: the text will not be selectable and the file is larger.';
/* A picture page must look like the same page printed from the open copy: both shrunk to a quarter of their size,
   mean channel difference under 3 and 99% of pixels within 40 (JPEG and resampling noise; a wrong page, a shifted
   page or missing marks are far outside this). */
const LOOK = {mean: 3, p99: 40};

/* ======================================================================================================== */
export const loops = [

{name: 'print: order and page count follow the set (break skipped, repeat printed twice, archived printed)', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const files = Object.keys(FIXTURES).map(f => path.join(FIX, f));
    const ids = await importFiles(page, files);
    const letter = Object.fromEntries(Object.entries(ids).map(([f, id]) => [id, FIXTURES[f]]));
    const songs0 = await songsById(page);
    const A = ids['two-page.pdf'], B = ids['three-page.pdf'], C = ids['one-page.pdf'];
    await newSet(page, 'Order');
    await addSong(page, songs0[A].title); await addSong(page, songs0[B].title); await addBreak(page);
    await addSong(page, songs0[A].title); await addSong(page, songs0[C].title); await addBreak(page); await addSong(page, songs0[B].title);
    /* archive C after it is in the set (the picker hides archived songs) */
    await toLibrary(page);
    await page.click(`#libList [data-archive="${C}"]`);
    await waitFor(async () => (await songsById(page))[C].archived === true, 'song C not archived');
    const set = Object.values(await idbAll(page, 'sets')).find(x => x.name === 'Order' && !x.deleted);
    assert(set.items.map(i => i.type === 'break' ? '|' : letter[i.id]).join('') === 'AB|AC|B', 'set items ' + fmt(set.items));
    const songs = await songsById(page), want = [];
    for(const it of set.items) if(it.type === 'song') for(let p = 1; p <= songs[it.id].pages; p++) want.push(`Fixture Song ${letter[it.id]} — page ${p}`);
    assert(want.length === 11, 'expected 11 pages, built ' + want.length);
    await openSetNamed(page, 'Order');
    for(const withInk of [true, false]){
      const bytes = await printSet(page, withInk);
      const pages = await renderPdf(page, 'order', bytes, .5);
      const got = pages.map(p => p.text);
      assert(got.length === want.length, `${withInk ? 'with' : 'without'} annotations: ${got.length} pages printed, expected ${want.length}: ${fmt(got)}`);
      got.forEach((t, i) => assert(t === want[i], `${withInk ? 'with' : 'without'} annotations: printed page ${i + 1} reads "${t}", expected "${want[i]}" (all: ${fmt(got)})`));
    }
    await sourceUntouched(page, ids, Object.fromEntries(files.map(f => [path.basename(f), f])));
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'print: ink prints where it was drawn (pen exact colour, highlighter tinted); erased and cleared strokes never print', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const ids = await importFiles(page, [path.join(FIX, 'two-page.pdf')]), id = ids['two-page.pdf'];
    await openSong(page, id, 1);
    await pickTool(page, 'pen', RED);
    const pen = await drawPath(page, id, 1, [[.15, .15], [.25, .2], [.35, .22], [.45, .28]]);
    await pickTool(page, 'hl', YELLOW);
    const hl = await drawPath(page, id, 1, [[.55, .72], [.7, .74], [.85, .76]]);
    /* a blue pen stroke, then erased */
    await pickTool(page, 'pen', BLUE);
    const gone = await drawPath(page, id, 1, [[.2, .85], [.3, .87], [.4, .9]]);
    await pickTool(page, 'erase');
    const b1 = await sheetBox(page, 1);
    await page.mouse.move(b1.x + b1.width * .18, b1.y + b1.height * .85); await page.mouse.down();
    await page.mouse.move(b1.x + b1.width * .42, b1.y + b1.height * .9, {steps: 12}); await page.mouse.up();
    await waitFor(async () => (await inkRec(page, id, 1)).strokes.find(x => x.id === gone.id && x.deleted), 'eraser left no deletion marker for the blue stroke');
    assert(liveOf(await inkRec(page, id, 1)).some(x => x.id === pen.id) && liveOf(await inkRec(page, id, 1)).some(x => x.id === hl.id), 'the eraser removed the red pen or the highlighter too');
    /* page 2: a green highlighter stroke, then Clear */
    await page.click('#tDone');
    await openSong(page, id, 2);
    await pickTool(page, 'hl', GREEN_HL);
    const cleared = await drawPath(page, id, 2, [[.2, .2], [.5, .25], [.8, .3]]);
    await page.click('#tClear'); await page.click('#tClear');
    await waitFor(async () => (await inkRec(page, id, 2)).strokes.find(x => x.id === cleared.id && x.deleted), 'Clear left no deletion marker');
    await page.click('#tDone');
    /* the stored strokes are where the mouse went (otherwise the comparison below proves nothing) */
    assert(near(pen.p[0][0], .15, .01) && near(pen.p[0][1], .15, .01) && near(pen.p.at(-1)[0], .45, .01) && near(pen.p.at(-1)[1], .28, .01), 'stored pen stroke ' + fmt(pen.p));
    await toLibrary(page);
    await setOf(page, 'Ink', [id]);
    const res = {};
    for(const withInk of [true, false]){
      const pages = await renderPdf(page, 'ink' + withInk, await printSet(page, withInk), 2);
      assert(pages.length === 2, `printed ${pages.length} pages, expected 2`);
      const k = 'ink' + withInk;
      res[withInk] = {
        penExact: await boxOf(page, k, 0, {c: RED, aMin: .97, tol: 6}),
        pen: await boxOf(page, k, 0, {c: RED, aMin: .5}),
        hl: await boxOf(page, k, 0, {c: YELLOW, aMin: .3, aMax: .5, tol: 10}),
        hlOpaque: await boxOf(page, k, 0, {c: YELLOW, aMin: .6}),
        blue: await boxOf(page, k, 0, {c: BLUE, aMin: .3}),
        green: await boxOf(page, k, 1, {c: GREEN_HL, aMin: .3, aMax: .5, tol: 10}),
      };
    }
    const on = res[true], off = res[false];
    const penWant = strokeBox(pen), hlWant = strokeBox(hl);
    assert(on.penExact.n > 20, `pen colour ${RED} not printed exactly: ${on.penExact.n} exact pixels`);
    assert(boxNear(on.pen, penWant, pen.w + .015, pen.w * PW / PH + .015), `pen printed at ${bb(on.pen)}, stored stroke box ${fmt(penWant)}`);
    assert(on.hl.n > 200 && on.hlOpaque.n === 0, `highlighter not printed tinted at ~.4: ${on.hl.n} tinted pixels, ${on.hlOpaque.n} near-opaque yellow pixels`);
    assert(boxNear(on.hl, hlWant, hl.w + .015, hl.w * PW / PH + .015), `highlighter printed at ${bb(on.hl)}, stored stroke box ${fmt(hlWant)}`);
    assert(on.blue.n === 0, `erased blue stroke printed: ${bb(on.blue)}`);
    assert(on.green.n === 0, `cleared green highlighter printed on page 2: ${bb(on.green)}`);
    for(const k of ['pen', 'hl', 'blue', 'green']) assert(off[k].n === 0, `annotations OFF but ${k} pixels printed: ${bb(off[k])}`);
    await sourceUntouched(page, ids, {'two-page.pdf': path.join(FIX, 'two-page.pdf')});
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'print: text notes print where they sit, at their size; ♯/♭ print as #/b', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const ids = await importFiles(page, [path.join(FIX, 'one-page.pdf')]), id = ids['one-page.pdf'];
    await openSong(page, id, 1);
    const specs = [{text: 'Verse 2', size: 'small', color: RED, at: [.1, .08]}, {text: 'Verse 2', size: 'medium', color: BLUE, at: [.1, .2]},
      {text: 'Verse 2', size: 'large', color: RED, at: [.1, .32]}, {text: 'C♯ to B♭', size: 'medium', color: BLUE, at: [.15, .7]}];
    const notes = [];
    for(const n of specs) notes.push(await addNote(page, id, 1, n.at[0], n.at[1], n));
    await page.click('#tDone');
    const SZ = {small: .012, medium: .018, large: .028};
    notes.forEach((n, i) => assert(near(n.size, SZ[specs[i].size], 1e-6) && n.c === specs[i].color, `stored note ${i}: ${fmt(n)}`));
    await setOf(page, 'Notes', [id]);
    const [pg] = await renderPdf(page, 'notes', await printSet(page, true), 2);
    const fails = [];
    for(const [i, n] of notes.entries()){
      const lineX = n.size * 1.2, lineY = n.size * 1.2 * PW / PH;
      const region = [n.x - .05, n.y - .04, Math.min(1, n.x + .6), n.y + lineY + .04];
      const b = await boxOf(page, 'notes', 0, {c: n.c, aMin: .5}, region);
      const hPts = b.n ? (b.y1 - b.y0) * PH : 0, want = n.size * PW;
      const msg = `note "${n.text}" (${specs[i].size}, ${n.c}) stored at ${fmt([n.x, n.y])}: printed ${bb(b)}`;
      if(!b.n){ fails.push(msg + ' - not found'); continue; }
      if(!near(b.x0, n.x, lineX) || !near(b.y0, n.y, lineY)) fails.push(`${msg} - top-left off by ${fmt([b.x0 - n.x, b.y0 - n.y])}, tolerance ${fmt([lineX, lineY])}`);
      if(!near(hPts, want, want * .35)) fails.push(`${msg} - ink height ${hPts.toFixed(1)}pt, expected ~${want.toFixed(1)}pt (size x page width, ±35%)`);
    }
    assert(!fails.length, fails.join('; '));
    const items = pg.items.map(x => x.trim());
    assert(items.filter(x => x === 'Verse 2').length === 3, 'printed text items ' + fmt(pg.items));
    assert(items.includes('C# to Bb') && !/[♯♭]/.test(pg.text), `sharps/flats: printed text "${pg.text}", expected an item "C# to Bb"`);
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'print: crop prints what the viewer shows (song-wide and per-page crop, ink inside and clipped)', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const ids = await importFiles(page, [path.join(FIX, 'three-page.pdf'), path.join(FIX, 'two-page.pdf')]);
    const B = ids['three-page.pdf'], A = ids['two-page.pdf'];
    /* Three-page page 1: stroke inside the coming crop (red) and one running out of it (blue); then a song-wide crop */
    await openSong(page, B, 1);
    await pickTool(page, 'pen', RED);
    const inside = await drawPath(page, B, 1, [[.3, .25], [.45, .3], [.6, .35]]);
    await pickTool(page, 'pen', BLUE);
    const out = await drawPath(page, B, 1, [[.55, .75], [.75, .85], [.97, .97]]);
    const all = (await cropUI(page, B, 1, [.12, .1], [.9, .8], true)).all;
    /* Two-page page 2: a stroke, then a crop of that page only; page 1 has a stroke and no crop */
    await openSong(page, A, 1);
    await pickTool(page, 'pen', RED);
    const a1 = await drawPath(page, A, 1, [[.2, .2], [.4, .3]]);
    await page.click('#tDone');
    await openSong(page, A, 2);
    await pickTool(page, 'pen', RED);
    const a2 = await drawPath(page, A, 2, [[.4, .4], [.6, .35], [.8, .3]]);
    const pc = (await cropUI(page, A, 2, [.15, .2], [.95, .9], false)).pages['2'];
    const songs = await songsById(page);
    assert(!songs[A].crop.all, 'Two-page got a song-wide crop: ' + fmt(songs[A].crop));
    /* what the viewer shows, page by page (fractions of the shown, cropped area) */
    const cases = [{id: B, pn: 1, cr: all, strokes: [inside, out], cols: [RED, BLUE]}, {id: B, pn: 2, cr: all, strokes: [], cols: []},
      {id: A, pn: 1, cr: null, strokes: [a1], cols: [RED]}, {id: A, pn: 2, cr: pc, strokes: [a2], cols: [RED]}];
    for(const c of cases){
      await openSong(page, c.id, c.pn);
      await sleep(200);
      const v = await grabViewer(page, 'v', c.pn);
      const cr = c.cr || {x: 0, y: 0, w: 1, h: 1};
      c.viewAspect = v.w / v.h;
      c.view = {text: await boxOf(page, 'v', 0, {dark: true}), ink: []};
      for(const col of c.cols) c.view.ink.push(await boxOf(page, 'v', 1, {c: col, aMin: .5}));
      c.cr = cr;
    }
    if(await page.locator('#viewer.on').count()) await page.click('#vBack');
    await setOf(page, 'Crops', [B, A]);
    const pages = await renderPdf(page, 'crop', await printSet(page, true), 1.5);
    assert(pages.length === 5, `printed ${pages.length} pages, expected 5`);
    const idx = [0, 1, 3, 4], fails = [];
    for(const [k, c] of cases.entries()){
      const pg = pages[idx[k]], i = idx[k], name = `${c.id === B ? 'Three-page' : 'Two-page'} p${c.pn} (crop ${fmt(c.cr)})`;
      const aspect = c.cr.w * PW / (c.cr.h * PH), got = pg.vw / pg.vh;
      if(!near(got, aspect, aspect * .01)) fails.push(`${name}: printed visible area ${pg.vw.toFixed(1)}x${pg.vh.toFixed(1)}pt aspect ${got.toFixed(4)}, crop aspect ${aspect.toFixed(4)}`);
      if(!near(c.viewAspect, aspect, aspect * .015)) fails.push(`${name}: viewer sheet aspect ${c.viewAspect.toFixed(4)}, crop aspect ${aspect.toFixed(4)}`);
      const pt = await boxOf(page, 'crop', i, {dark: true});
      if(!boxNear(pt, c.view.text, .012)) fails.push(`${name}: page text printed at ${bb(pt)}, viewer shows it at ${bb(c.view.text)}`);
      for(const [j, st] of c.strokes.entries()){
        const p = await boxOf(page, 'crop', i, {c: c.cols[j], aMin: .5}), want = clippedStrokeBox(st, c.cr);
        const tx = st.w / c.cr.w + .01, ty = st.w * PW / PH / c.cr.h + .01;
        if(!boxNear(p, c.view.ink[j], tx, ty)) fails.push(`${name}: ${c.cols[j]} stroke printed at ${bb(p)}, viewer ink canvas shows ${bb(c.view.ink[j])}`);
        if(!boxNear(p, want, tx, ty)) fails.push(`${name}: ${c.cols[j]} stroke printed at ${bb(p)}, stored stroke through the crop ${fmt(want)}`);
      }
    }
    /* the blue stroke leaves the crop through its bottom edge: in print it runs right up to that edge (the part inside is all there) */
    const blue = await boxOf(page, 'crop', 0, {c: BLUE, aMin: .5}), unclipped = throughCrop(strokeBox(out), all);
    assert(unclipped.y1 >= 1 && strokeBox(out).y1 > all.y + all.h + .02, 'test setup: the blue stroke does not leave the crop ' + fmt({stroke: strokeBox(out), crop: all}));
    if(!(blue.n && blue.y1 > .99)) fails.push(`clipped stroke should run to the crop's bottom edge in print: ${bb(blue)}`);
    assert(!fails.length, fails.join('; '));
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'print: rotated source PDFs (90/180/270) print in the viewer\'s orientation with ink, note and crop in place', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    /* fixtures: letter page with /Rotate R, a green marker square (unrotated PDF x 100..180, y 160..240) and a label */
    const files = [];
    for(const rot of [0, 90, 180, 270]){
      const doc = await PL.PDFDocument.create(), font = await doc.embedFont(PL.StandardFonts.HelveticaBold);
      const pg = doc.addPage([PW, PH]);
      pg.drawRectangle({x: 100, y: 160, width: 80, height: 80, color: PL.rgb(0, 160 / 255, 0)});
      pg.drawText(`Rotated ${rot}`, {x: 200, y: 400, size: 30, font, color: PL.rgb(0, 0, 0)});
      pg.setRotation(PL.degrees(rot));
      const f = path.join(TMP, `print-loop-rotated-${rot}.pdf`);
      fs.writeFileSync(f, await doc.save());
      files.push({rot, f});
    }
    const ids = await importFiles(page, files.map(x => x.f));
    const marks = {};
    const fails = [];
    for(const {rot, f} of files){
      const id = ids[path.basename(f)];
      await openSong(page, id, 1);
      await pickTool(page, 'pen', RED);
      const st = await drawPath(page, id, 1, [[.3, .55], [.45, .58], [.6, .62]]);
      const note = await addNote(page, id, 1, .5, .2, {text: 'Verse 2', size: 'medium', color: BLUE});
      const cr = (await cropUI(page, id, 1, [.08, .12], [.95, .85], true)).all;
      await sleep(200);
      const v = await grabViewer(page, 'rv', 1);
      const view = {aspect: v.w / v.h, marker: await boxOf(page, 'rv', 0, {c: MARKER, aMin: .9, tol: 30}),
        pen: await boxOf(page, 'rv', 1, {c: RED, aMin: .5}), note: await boxOf(page, 'rv', 1, {c: BLUE, aMin: .5})};
      /* sanity: the viewer shows the marker where the /Rotate says (displayed = unrotated turned clockwise) */
      const u = {x0: 100 / PW, x1: 180 / PW, y0: (PH - 240) / PH, y1: (PH - 160) / PH};
      const turn = {0: q => q, 90: q => ({x0: 1 - q.y1, x1: 1 - q.y0, y0: q.x0, y1: q.x1}), 180: q => ({x0: 1 - q.x1, x1: 1 - q.x0, y0: 1 - q.y1, y1: 1 - q.y0}),
        270: q => ({x0: q.y0, x1: q.y1, y0: 1 - q.x1, y1: 1 - q.x0})}[rot](u);
      const dispW = rot % 180 ? PH : PW, dispH = rot % 180 ? PW : PH;
      const markWant = throughCrop(turn, cr);
      assert(boxNear(view.marker, markWant, .01), `rotation ${rot}: viewer shows the marker at ${bb(view.marker)}, expected ${fmt(markWant)} (test assumption broken)`);
      marks[rot] = {id, st, note, cr, view, dispW, dispH, markWant};
      await page.click('#vBack');
    }
    await setOf(page, 'Rotated', files.map(x => ids[path.basename(x.f)]));
    const pages = await renderPdf(page, 'rot', await printSet(page, true), 1.5);
    assert(pages.length === 4, `printed ${pages.length} pages, expected 4`);
    for(const [i, {rot}] of files.entries()){
      const m = marks[rot], pg = pages[i], name = `rotation ${rot}`;
      const aspect = m.cr.w * m.dispW / (m.cr.h * m.dispH), got = pg.vw / pg.vh;
      if(!near(got, aspect, aspect * .01)) fails.push(`${name}: printed visible area aspect ${got.toFixed(4)} (${pg.vw.toFixed(1)}x${pg.vh.toFixed(1)}pt), viewer/crop aspect ${aspect.toFixed(4)}`);
      const mk = await boxOf(page, 'rot', i, {c: MARKER, aMin: .9, tol: 30});
      if(!boxNear(mk, m.view.marker, .015)) fails.push(`${name}: marker printed at ${bb(mk)}, viewer shows it at ${bb(m.view.marker)}`);
      const pen = await boxOf(page, 'rot', i, {c: RED, aMin: .5});
      const tx = m.st.w / m.cr.w + .015, ty = m.st.w * m.dispW / m.dispH / m.cr.h + .015;
      if(!boxNear(pen, m.view.pen, tx, ty)) fails.push(`${name}: pen stroke printed at ${bb(pen)}, viewer shows it at ${bb(m.view.pen)}`);
      const nb = await boxOf(page, 'rot', i, {c: BLUE, aMin: .5});
      const lx = m.note.size * 1.2 / m.cr.w, ly = m.note.size * 1.2 * m.dispW / m.dispH / m.cr.h;
      const nOk = nb.n && near(nb.x0, m.view.note.x0, lx) && near(nb.y0, m.view.note.y0, ly);
      const hv = (m.view.note.y1 - m.view.note.y0), hp = nb.n ? nb.y1 - nb.y0 : 0;
      if(!nOk) fails.push(`${name}: note printed at ${bb(nb)}, viewer shows it at ${bb(m.view.note)} (top-left tolerance ${fmt([lx, ly])})`);
      else if(!near(hp, hv, hv * .35)) fails.push(`${name}: note printed ${(hp * 100).toFixed(2)}% of the crop tall, viewer ${(hv * 100).toFixed(2)}%`);
    }
    assert(!fails.length, fails.join('; '));
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'print: without any change the printed pages render identically to the source and the stored PDF is untouched', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    await s.goto();
    const files = Object.keys(FIXTURES).map(f => path.join(FIX, f));
    const ids = await importFiles(page, files);
    const order = ['three-page.pdf', 'one-page.pdf', 'two-page.pdf'];
    await setOf(page, 'Plain', order.map(f => ids[f]));
    const src = [];
    for(const f of order){ const r = await renderPdf(page, 'src-' + f, fs.readFileSync(path.join(FIX, f)), 1.5); for(let p = 0; p < r.length; p++) src.push([f, p]); }
    for(const withInk of [true, false]){
      const bytes = await printSet(page, withInk);
      const out = await renderPdf(page, 'plain', bytes, 1.5);
      assert(out.length === src.length, `printed ${out.length} pages, expected ${src.length}`);
      for(const [i, [f, p]] of src.entries()){
        const d = await pixDiff(page, 'plain', i, 'src-' + f, p);
        assert(!d.size, `${withInk ? 'with' : 'without'} annotations: printed page ${i + 1} is ${d.size?.slice(0, 2).join('x')}px, source ${f} p${p + 1} is ${d.size?.slice(2).join('x')}px`);
        assert(d.nDiff / d.total <= 1e-4 && d.max <= 32, `${withInk ? 'with' : 'without'} annotations: printed page ${i + 1} differs from ${f} p${p + 1}: ${d.nDiff} of ${d.total} pixels, max channel diff ${d.max}, mean ${d.mean.toFixed(4)}`);
      }
      const doc = await PL.PDFDocument.load(bytes);
      for(const pg of doc.getPages()){
        const mb = pg.getMediaBox(), cb = pg.getCropBox();
        assert(mb.width === PW && mb.height === PH && cb.width === PW && cb.height === PH && !pg.getRotation().angle, `printed page box ${fmt(mb)} crop ${fmt(cb)} rotate ${pg.getRotation().angle}`);
      }
    }
    await sourceUntouched(page, ids, Object.fromEntries(files.map(f => [path.basename(f), f])));
    noErrors(s);
  } finally { await s.close(); }
}},
{name: 'print: protected charts print as pictures (order, look, pen/highlighter/note, crop, /Rotate 90) next to copied songs', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    /* fixtures: an open /Rotate 90 page with a green marker and a label; encrypted copies of it and of two-page.pdf */
    const doc = await PL.PDFDocument.create(), font = await doc.embedFont(PL.StandardFonts.HelveticaBold);
    const rp = doc.addPage([PW, PH]);
    rp.drawRectangle({x: 100, y: 160, width: 80, height: 80, color: PL.rgb(0, 160 / 255, 0)});
    rp.drawText('Rotated 90', {x: 200, y: 400, size: 30, font, color: PL.rgb(0, 0, 0)});
    rp.setRotation(PL.degrees(90));
    const rotOpen = path.join(TMP, 'pic-rot90-open.pdf'); fs.writeFileSync(rotOpen, await doc.save());
    const twoLocked = encryptPdf(path.join(FIX, 'two-page.pdf'), path.join(TMP, 'pic-two-locked.pdf'));
    const rotLocked = encryptPdf(rotOpen, path.join(TMP, 'pic-rot90-locked.pdf'));
    await s.goto();
    const files = [path.join(FIX, 'two-page.pdf'), twoLocked, rotOpen, rotLocked, path.join(FIX, 'three-page.pdf')];
    const ids = await importFiles(page, files);
    const A = ids['two-page.pdf'], LA = ids['pic-two-locked.pdf'], R = ids['pic-rot90-open.pdf'], LR = ids['pic-rot90-locked.pdf'], B = ids['three-page.pdf'];
    /* the same marks and crop on each protected song and its open twin (stored records are the input) */
    const marks = [{id: 'pen', updated: 1, t: 'pen', c: RED, w: .006, p: [[.15, .15], [.3, .2], [.45, .28]]},
      {id: 'hl', updated: 1, t: 'hl', c: YELLOW, w: .02, p: [[.5, .7], [.7, .72], [.85, .75]]},
      {id: 'note', updated: 1, t: 'text', x: .12, y: .4, text: 'Verse 2', size: .018, c: BLUE}];
    const cropP2 = {x: .1, y: .1, w: .8, h: .75}, cropR = {x: .08, y: .12, w: .87, h: .73};
    for(const id of [A, LA]) for(const pn of [1, 2]) await idbPut(page, 'ink', id + ':' + pn, {updated: 1, strokes: marks});
    for(const id of [R, LR]) await idbPut(page, 'ink', id + ':1', {updated: 1, strokes: marks});
    const songs0 = await songsById(page);
    for(const [id, crop] of [[A, {all: null, pages: {2: cropP2}}], [LA, {all: null, pages: {2: cropP2}}], [R, {all: cropR, pages: {}}], [LR, {all: cropR, pages: {}}]])
      await idbPut(page, 'songs', id, {...songs0[id], crop});
    await s.goto();                                         // the app reads songs (and their crops) at start
    const songs = await songsById(page);
    await setOf(page, 'Pictures', [LA, B, A, LR, R, LA]);
    const ask = await askProtected(page, true);
    assert(fmt(ask.items) === fmt([songs[LA].title, songs[LR].title]), `protected list ${fmt(ask.items)}, expected ${fmt([songs[LA].title, songs[LR].title])}`);
    assert(ask.text.includes(PROTECTED_LINE), 'the dialog does not explain pictures: ' + ask.text);
    assert(fmt(ask.buttons) === fmt(['Cancel', 'Print without them', 'Print them as pictures']), 'buttons ' + fmt(ask.buttons));
    const {bytes, statuses} = await printAsPictures(page);
    assert(statuses.length && statuses.every(t => /^Preparing protected pages: [0-3] of 3$/.test(t)) && statuses.at(-1) === 'Preparing protected pages: 3 of 3',
      'progress lines ' + fmt(statuses));
    /* page order: LA1 LA2 | B1 B2 B3 | A1 A2 | LR1 | R1 | LA1 LA2 */
    const pages = await renderPdf(page, 'pics', bytes, 1);
    assert(pages.length === 11, `printed ${pages.length} pages, expected 11`);
    const opened = {2: 'Fixture Song B — page 1', 3: 'Fixture Song B — page 2', 4: 'Fixture Song B — page 3', 5: 'Fixture Song A — page 1', 6: 'Fixture Song A — page 2', 8: 'Rotated 90'};
    for(const [i, t] of Object.entries(opened)) assert(pages[i].text.includes(t), `printed page ${+i + 1} reads "${pages[i].text}", expected it to contain "${t}"`);
    const pics = {0: 5, 1: 6, 7: 8, 9: 5, 10: 6};          // picture page -> the open twin's printed page
    for(const i of Object.keys(pics)) assert(!/Fixture Song|Rotated/.test(pages[i].text), `printed page ${+i + 1} is not a picture: its text reads "${pages[i].text}"`);
    const fails = [];
    for(const [i, j] of Object.entries(pics).map(([i, j]) => [+i, j])){
      const name = `picture page ${i + 1} vs open page ${j + 1}`;
      if(!near(pages[i].vw, pages[j].vw, .5) || !near(pages[i].vh, pages[j].vh, .5)) fails.push(`${name}: visible area ${pages[i].vw.toFixed(1)}x${pages[i].vh.toFixed(1)}pt vs ${pages[j].vw.toFixed(1)}x${pages[j].vh.toFixed(1)}pt`);
      const d = await smallDiff(page, 'pics', i, 'pics', j, Math.round(pages[j].w / 4), Math.round(pages[j].h / 4));
      if(!(d.mean <= LOOK.mean && d.p99 <= LOOK.p99)) fails.push(`${name}: looks different: mean ${d.mean.toFixed(2)}, p99 ${d.p99}, max ${d.max} (allowed ${fmt(LOOK)})`);
      /* the other page of the same song must look clearly less alike (the order check has teeth) */
      const other = {5: 6, 6: 5, 8: null}[j];
      if(other != null){
        const o = await smallDiff(page, 'pics', i, 'pics', other, Math.round(pages[j].w / 4), Math.round(pages[j].h / 4));
        if(!(o.mean > d.mean * 2 || o.p99 > LOOK.p99)) fails.push(`${name}: open page ${other + 1} looks as alike (mean ${o.mean.toFixed(2)}, p99 ${o.p99}) as its twin (mean ${d.mean.toFixed(2)}, p99 ${d.p99})`);
      }
      for(const [k, spec] of [['pen', {c: RED, aMin: .5}], ['highlighter', {c: YELLOW, aMin: .3, aMax: .5, tol: 10}], ['note', {c: BLUE, aMin: .5}], ...(j === 8 ? [['marker', {c: MARKER, aMin: .9, tol: 30}]] : [])]){
        const got = await boxOf(page, 'pics', i, spec), want = await boxOf(page, 'pics', j, spec);
        if(!want.n) fails.push(`${name}: open page has no ${k} pixels (test setup)`);
        else if(!boxNear(got, want, .006)) fails.push(`${name}: ${k} printed at ${bb(got)}, on the open copy at ${bb(want)}`);
      }
    }
    /* the pages themselves: picture pages have no /Rotate, are as big as the page shown, and carry the same crop */
    const out = await PL.PDFDocument.load(bytes), opg = out.getPages();
    const cropWant = (W, H, c) => ({x: c.x * W, y: (1 - c.y - c.h) * H, width: c.w * W, height: c.h * H});
    const expect = {0: [PW, PH, null], 1: [PW, PH, cropP2], 7: [PH, PW, cropR], 9: [PW, PH, null], 10: [PW, PH, cropP2]};
    for(const [i, [W, H, c]] of Object.entries(expect)){
      const pg = opg[i], mb = pg.getMediaBox(), cb = pg.getCropBox(), want = c ? cropWant(W, H, c) : {x: 0, y: 0, width: W, height: H};
      if(pg.getRotation().angle !== 0 || !near(mb.width, W, .01) || !near(mb.height, H, .01)) fails.push(`page ${+i + 1}: media box ${fmt(mb)} rotate ${pg.getRotation().angle}, expected ${W}x${H} rotate 0`);
      if(!['x', 'y', 'width', 'height'].every(k => near(cb[k], want[k], .5))) fails.push(`page ${+i + 1}: crop box ${fmt(cb)}, expected ${fmt(want)}`);
    }
    assert(pages[7].vw > pages[7].vh, `the /Rotate 90 picture page is ${pages[7].vw.toFixed(1)}x${pages[7].vh.toFixed(1)}pt, expected landscape like the viewer`);
    assert(!fails.length, fails.join('; '));
    await sourceUntouched(page, ids, Object.fromEntries(files.map(f => [path.basename(f), f])));
    noErrors(s);
  } finally { await s.close(); }
}},

{name: 'print: an all-protected set offers only pictures or Cancel; a chart that needs a password is named and left out', async run(ctx){
  const s = await ctx.session(), page = s.page;
  try{
    const oneLocked = encryptPdf(path.join(FIX, 'one-page.pdf'), path.join(TMP, 'pic-one-locked.pdf'));
    /* "Needs Password": imported as an openable protected copy, then its stored bytes are replaced by a copy that
       needs the password "secret" (the app refuses such files at import; a restore can still bring one in) */
    const placeholder = encryptPdf(path.join(FIX, 'three-page.pdf'), path.join(TMP, 'Needs Password.pdf'));
    const pw = fs.readFileSync(encryptPdf(path.join(FIX, 'three-page.pdf'), path.join(TMP, 'pic-real-password.pdf'), 'secret'));
    await s.goto();
    const ids = await importFiles(page, [oneLocked, placeholder, path.join(FIX, 'two-page.pdf')]);
    const LO = ids['pic-one-locked.pdf'], NP = ids['Needs Password.pdf'], A = ids['two-page.pdf'];
    await idbPut(page, 'files', NP, null, pw.toString('base64'));
    const why = await page.evaluate(async b64 => { const bin = atob(b64), u = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      try{ const d = await pdfjsLib.getDocument({data: u}).promise; d.destroy(); return 'opened'; }catch(e){ return e.name; } }, pw.toString('base64'));
    assert(why === 'PasswordException', 'test setup: the password copy gives ' + why + ' in pdf.js');
    const songs = await songsById(page);
    const npLine = `${songs[NP].title} needs a password, so it can't be printed.`;
    /* all protected: no "Print without them" (there would be nothing to print) */
    await setOf(page, 'All locked', [LO, NP, LO]);
    const ask = await askProtected(page, true);
    assert(fmt(ask.items) === fmt([songs[LO].title, npLine]), `list ${fmt(ask.items)}, expected ${fmt([songs[LO].title, npLine])}`);
    assert(fmt(ask.buttons) === fmt(['Cancel', 'Print them as pictures']), 'buttons ' + fmt(ask.buttons));
    const {bytes, statuses} = await printAsPictures(page);
    assert(statuses.at(-1) === 'Preparing protected pages: 1 of 1', 'progress lines ' + fmt(statuses));
    const got = await renderPdf(page, 'allpics', bytes, 1), src = await renderPdf(page, 'one', fs.readFileSync(path.join(FIX, 'one-page.pdf')), 1);
    assert(got.length === 2, `printed ${got.length} pages, expected 2 (the password chart left out)`);
    for(const i of [0, 1]){
      const d = await smallDiff(page, 'allpics', i, 'one', 0, Math.round(src[0].w / 4), Math.round(src[0].h / 4));
      assert(d.mean <= LOOK.mean && d.p99 <= LOOK.p99, `picture page ${i + 1} does not look like one-page.pdf: mean ${d.mean.toFixed(2)}, p99 ${d.p99} (allowed ${fmt(LOOK)})`);
    }
    /* only the password chart and an open song: it is named on its own line; Print without them prints the rest */
    await setOf(page, 'Password and open', [NP, A]);
    const ask2 = await askProtected(page, true);
    assert(fmt(ask2.items) === fmt([npLine]) && !ask2.text.includes(PROTECTED_LINE), 'dialog ' + ask2.text);
    assert(fmt(ask2.buttons) === fmt(['Cancel', 'Print without them']), 'buttons ' + fmt(ask2.buttons));
    const dl = await download(page, () => page.click('.modal [data-without]'));
    if(await page.locator('.modal').count()) await page.click('.modal [data-x]');
    const rest = await renderPdf(page, 'rest', await fsp.readFile(dl.file), .5);
    assert(fmt(rest.map(p => p.text)) === fmt(['Fixture Song A — page 1', 'Fixture Song A — page 2']), 'printed ' + fmt(rest.map(p => p.text)));
    noErrors(s);
  } finally { await s.close(); }
}},
];

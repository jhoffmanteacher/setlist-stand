/*
 * Shared pieces for the marks loops (sync 6, sync model marks; sync 7 = the same under WebKit). Written from the Part 3 spec
 * (pen strokes, highlighter strokes and text notes synced page by page, merged BY STROKE ID), never from js/syncink.js,
 * js/syncapply.js or js/driveops.js. Built on sync-two.mjs (tablets, the Sync button) and sync-kit.mjs (the test library).
 *
 *   readMarks(google, {except}) -> {folder, home, pages: Map "songId:page" -> page record, files: Map key -> Drive file, problems}
 *        the Marks folder and its files read from the stand-in's own store, with the layout the spec gives checked: ONE folder
 *        "Marks (do not edit)" marked {setlistStand:'ink'} in the home folder; one file per page `ink-<songId>-<page>.json`,
 *        appProperties exactly {k:'ink', id, p, u, c, h} (u = the page's `updated`, c = SHA-256 of its canonical JSON, h = SHA-256
 *        of the chart the page was drawn on), never empty; readMarks().h: Map key -> h
 *   entriesOf(page) -> Map id -> entry; liveIds(page); byIdDiff(a, b) -> [differences] (strokes compared by id, not by order)
 *   inkOf(t) -> the tablet's ink store; pageOf(t, key)
 *   putPage(t, key, rec)                      a page written as it is (a hand-made case)
 *   addEntries(t, songId, pn, entries)       new strokes or notes added the way drawing saves them (putInk; markers kept)
 *   eraseIds / editNote / undoErase           the store's own stamp() and reconcile(), as js/ink.js uses them
 *   openOn(t, songId, pn) -> at(fx, fy)       the viewer on that page, one page at a time, Annotate on; then the ui* gestures
 *   watchReports(t); syncRead(t, opts) -> {...syncTap result, items: the report's list items (the Skipped list)}
 *   marksCounts(text) -> {sent, got} from "Sent marks on N page(s)." / "Got marks on N page(s)." (grammar checked)
 *   makePdf(pages, name), newVersionUi(t, id, file)
 *   printSetPdf(t, setName) -> bytes; renderBoxes(t, bytes, index, specs) -> boxes found by colour with pdf.js
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert, sleep, idbAll, PDFDocument, sha256, TMP, download, openSetMenu} from './harness.mjs';
import {canon, canonHash} from './sync-model.mjs';
import {syncTap} from './sync-two.mjs';
import {showAll, noModal} from './sync-kit.mjs';
import {songAct} from './songrow.mjs';

export const MARKS_NAME = 'Marks (do not edit)';
export const HOUR = 36e5;
const FOLDER = 'application/vnd.google-apps.folder';
export const PEN = {black: '#1a1a1a', red: '#d62828', blue: '#1f5fd6'}, HL = {yellow: '#ffd400', green: '#7be07b'};
export const ENGINE_NAME = process.env.SS_BROWSER === 'webkit' ? 'webkit' : 'chromium';
/* "sync 6a" in Chromium; "sync 7a (= sync 6a in WebKit)" in WebKit, so --only "sync 6a" and --only "sync 7" both find it there */
export const loopName = (n, rest) => (ENGINE_NAME === 'webkit' ? `sync 7${n} (= sync 6${n} in WebKit)` : `sync 6${n}`) + ': ' + rest;

/* ---------- Drive ---------- */
export const splitKey = k => { const i = k.lastIndexOf(':'); return {id: k.slice(0, i), p: Number(k.slice(i + 1))}; };
export function readMarks(google, {except = new Set()} = {}){
  const live = [...google.files.values()].filter(f => !f.trashed), problems = [];
  const out = {folder: null, home: null, pages: new Map(), files: new Map(), h: new Map(), problems};
  const charts = live.filter(f => f.mimeType === FOLDER && f.appProperties.setlistStand === 'charts');
  out.home = charts.length === 1 ? charts[0].parents[0] : null;
  const folders = live.filter(f => f.mimeType === FOLDER && f.appProperties.setlistStand === 'ink');
  if(folders.length > 1) problems.push(`${folders.length} Marks folders (one expected)`);
  const folder = out.folder = folders[0] || null;
  if(folder){
    if(folder.name !== MARKS_NAME) problems.push(`the Marks folder is named "${folder.name}"`);
    if(!out.home || folder.parents.length !== 1 || folder.parents[0] !== out.home) problems.push('the Marks folder is not in the home folder (where Charts is)');
    if(Object.keys(folder.appProperties).sort().join() !== 'setlistStand') problems.push('the Marks folder has the properties ' + JSON.stringify(folder.appProperties));
  }
  for(const f of live){
    const p = f.appProperties;
    if(p.k !== 'ink' || except.has(f.id)) continue;
    const where = `the ink file "${f.name}"`;
    if(!folder || !f.parents.includes(folder.id)) problems.push(`${where} is not in the Marks folder`);
    if(Object.keys(p).sort().join() !== 'c,h,id,k,p,u') problems.push(`${where} has the properties ${Object.keys(p).sort().join()} (c, h, id, k, p, u expected)`);
    if(!/^[0-9a-f]{64}$/.test(p.h || '')) problems.push(`${where} has h=${p.h} (the SHA-256 of the chart it was drawn on)`);
    if(f.name !== `ink-${p.id}-${p.p}.json`) problems.push(`${where} should be named ink-${p.id}-${p.p}.json`);
    if(f.mimeType !== 'application/json') problems.push(`${where} is stored as ${f.mimeType}`);
    let rec = null;
    try{ rec = JSON.parse(google.fileBytes(f.id).toString('utf8')); }catch(e){ problems.push(`${where} is not JSON`); continue; }
    if(!rec || !Array.isArray(rec.strokes)) { problems.push(`${where} is not a page {updated, strokes}`); continue; }
    if(!rec.strokes.length) problems.push(`${where} is an empty page (an empty page is never uploaded)`);
    if(p.u !== String(rec.updated)) problems.push(`${where}: u=${p.u}, the page says ${rec.updated}`);
    if(p.c !== canonHash(rec)) problems.push(`${where}: c is not the SHA-256 of the canonical page`);
    const newest = Math.max(0, ...rec.strokes.map(s => Number(s.updated) || 0));
    if(!(rec.updated >= newest)) problems.push(`${where}: the page's updated ${rec.updated} is older than its newest entry ${newest}`);
    const key = p.id + ':' + p.p;
    if(out.pages.has(key)) problems.push(`two ink files for the page ${key}`);
    out.pages.set(key, rec); out.files.set(key, f); out.h.set(key, p.h);
  }
  if(!folder && out.pages.size) problems.push('ink files on Drive but no Marks folder');
  return out;
}
export const marksFolder = google => [...google.files.values()].find(f => !f.trashed && f.mimeType === FOLDER && f.appProperties.setlistStand === 'ink');
/* A page planted in the Marks folder by hand. text: the file's bytes as given (default JSON.stringify(rec)); props override.
   h (the chart it was drawn on) is the hash of the song's PDF on Drive unless props say otherwise. */
export function plantPage(google, songId, p, rec, {text, props = {}, name} = {}){
  const folder = marksFolder(google);
  assert(folder, 'plantPage: no Marks folder on Drive yet (the test is wrong, or the app never made one)');
  const body = text ?? JSON.stringify(rec);
  const pdf = [...google.files.values()].find(f => !f.trashed && f.appProperties.k === 'pdf' && f.appProperties.id === songId);
  const ap = {k: 'ink', id: songId, p: String(p), u: String(rec ? rec.updated : 0), c: rec ? canonHash(rec) : '0'.repeat(64),
    h: pdf ? pdf.appProperties.h : crypto.createHash('sha256').update('no chart ' + songId).digest('hex'), ...props};
  for(const k of Object.keys(ap)) if(ap[k] === undefined) delete ap[k];
  return google.addFile({name: name || `ink-${songId}-${p}.json`, mimeType: 'application/json', parents: [folder.id], appProperties: ap, content: body});
}

/* ---------- pages ---------- */
export const entriesOf = page => { const m = new Map(); for(const s of (page && Array.isArray(page.strokes) ? page.strokes : [])) m.set(s.id, s); return m; };
export const liveIds = page => [...entriesOf(page).values()].filter(s => !s.deleted).map(s => s.id).sort();
export const markerIds = page => [...entriesOf(page).values()].filter(s => s.deleted).map(s => s.id).sort();
export function byIdDiff(a, b, {la = 'left', lb = 'right'} = {}){
  const A = entriesOf(a), B = entriesOf(b), out = [];
  for(const id of new Set([...A.keys(), ...B.keys()])){
    const x = A.get(id), y = B.get(id);
    if(!x) out.push(`${id} only on the ${lb} (${canon(y).slice(0, 120)})`);
    else if(!y) out.push(`${id} only on the ${la} (${canon(x).slice(0, 120)})`);
    else if(canon(x) !== canon(y)) out.push(`${id}: ${la} ${canon(x).slice(0, 140)} | ${lb} ${canon(y).slice(0, 140)}`);
  }
  return out;
}
export const inkOf = t => idbAll(t.page, 'ink');
export const pageOf = async (t, key) => (await inkOf(t))[key] || null;
/* every number in a stored ink page is finite, every point list is short enough, every page a page of a live song */
export function hostileIn(lib){
  const out = [];
  const finite = (v, at) => { if(typeof v === 'number' && !Number.isFinite(v)) out.push(`${at} is ${v}`); else if(Array.isArray(v)) v.forEach((x, i) => finite(x, at + '[' + i + ']')); else if(v && typeof v === 'object') for(const k of Object.keys(v)) finite(v[k], at + '.' + k); };
  const depth = (v, d = 0) => { if(d > 40) return d; if(v && typeof v === 'object'){ let m = d; for(const k of Object.keys(v)){ m = Math.max(m, depth(v[k], d + 1)); if(m > 40) break; } return m; } return d; };
  for(const [k, page] of Object.entries(lib.ink)){
    const {id, p} = splitKey(k), s = lib.songs[id];
    if(!s || s.deleted) out.push(`ink ${k} for a song that is not live here`);
    else if(!(p >= 1 && p <= s.pages)) out.push(`ink ${k} for a page the song does not have (${s.pages} pages)`);
    finite(page, k);
    if(depth(page) > 40) out.push(`ink ${k} is nested more than 40 deep`);
    for(const st of (page && page.strokes) || []) if(Array.isArray(st.p) && st.p.length > 200000) out.push(`ink ${k}: a stroke of ${st.p.length} points`);
    if(page && Array.isArray(page.strokes) && page.strokes.length > 50000) out.push(`ink ${k}: ${page.strokes.length} entries`);
  }
  return out;
}

/* ---------- marks made through the store, the way js/ink.js saves them ---------- */
export const putPage = (t, key, rec) => t.page.evaluate(async ([key, rec]) => { const st = await import('./js/store.js'); await st.put('ink', key, rec); }, [key, rec]);
/* adds entries (their `updated` given, or now on this tablet's clock) to what the page holds, markers and all */
export const addEntries = (t, songId, pn, entries) => t.page.evaluate(async ({songId, pn, entries}) => {
  const st = await import('./js/store.js'), cur = await st.getInk(songId, pn), now = Date.now();
  await st.putInk(songId, pn, [...cur, ...entries.map(e => ({...e, updated: e.updated ?? now}))]);
  return (await st.get('ink', songId + ':' + pn));
}, {songId, pn, entries});
/* the eraser: each live entry named becomes {id, deleted:true, updated:stamp(entry)} */
export const eraseIds = (t, songId, pn, ids) => t.page.evaluate(async ({songId, pn, ids}) => {
  const st = await import('./js/store.js'), cur = await st.getInk(songId, pn);
  await st.putInk(songId, pn, cur.map(s => ids.includes(s.id) && !s.deleted ? {id: s.id, deleted: true, updated: st.stamp(s)} : s));
  return (await st.get('ink', songId + ':' + pn));
}, {songId, pn, ids});
/* a note edited or moved in its dialog: {...note, ...change, updated:stamp(note)} */
export const editNote = (t, songId, pn, id, change) => t.page.evaluate(async ({songId, pn, id, change}) => {
  const st = await import('./js/store.js'), cur = await st.getInk(songId, pn);
  await st.putInk(songId, pn, cur.map(s => s.id === id ? {...s, ...change, updated: st.stamp(s)} : s));
  return (await st.get('ink', songId + ':' + pn));
}, {songId, pn, id, change});
/* Undo of an erase: the page as it was (`entry` back in place of its marker), through reconcile() as Undo saves it */
export const undoErase = (t, songId, pn, entry) => t.page.evaluate(async ({songId, pn, entry}) => {
  const st = await import('./js/store.js'), cur = await st.getInk(songId, pn);
  await st.putInk(songId, pn, st.reconcile(cur, cur.map(s => s.id === entry.id ? entry : s)));
  return (await st.get('ink', songId + ':' + pn));
}, {songId, pn, entry});
export const penLine = (id, y, c = PEN.black, {x0 = .2, x1 = .8, n = 9, w = .003, updated} = {}) =>
  ({id, t: 'pen', c, w, p: Array.from({length: n}, (_, i) => [Math.round((x0 + (x1 - x0) * i / (n - 1)) * 1e4) / 1e4, y]), ...(updated != null ? {updated} : {})});
export const hlLine = (id, y, c = HL.yellow, o = {}) => ({...penLine(id, y, c, o), t: 'hl', w: .02});
export const textNote = (id, x, y, text, {c = PEN.red, size = .018, updated} = {}) => ({id, t: 'text', x, y, text, size, c, ...(updated != null ? {updated} : {})});

/* ---------- the viewer and its gestures (the selectors tools/loops/inkstamp.loop.mjs uses) ---------- */
async function waitFor(fn, what, ms = 8000){
  const end = Date.now() + ms; let v;
  while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(80); }
  throw new Error(typeof what === 'function' ? await what() : what);
}
export async function openOn(t, songId, pn = 1){
  const {page} = t;
  await showAll(page);
  await page.click(`#libList [data-open="${songId}"]`);
  await page.waitForSelector('#viewer.on #stage .sheet canvas');
  if(await page.locator('#viewer.hide').count()){ await page.mouse.click(640, 420); await page.waitForSelector('#viewer:not(.hide)'); }
  if(await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
  await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 1, null, {timeout: 5000});
  for(let i = 0; i < 8; i++){
    const m = /Page (\d+)/.exec(await page.locator('#vSub').textContent()), cur = m ? +m[1] : 0;
    if(cur === pn && await page.locator(`#stage .ink[data-pn="${pn}"]`).count()) break;
    if(cur !== pn) await page.keyboard.press(cur < pn ? 'ArrowRight' : 'ArrowLeft');
    await sleep(250);
  }
  await page.waitForSelector(`#stage .ink[data-pn="${pn}"]`, {timeout: 4000});
  if(await page.locator('#tools').isHidden()) await page.click('#vAnn');
  await page.waitForSelector('#tools:not([hidden])');
  const b = await page.locator(`#stage .ink[data-pn="${pn}"]`).boundingBox();
  const at = (fx, fy) => ({x: b.x + b.width * fx, y: b.y + b.height * fy});
  Object.assign(at, {w: b.width, songId, pn, key: songId + ':' + pn});
  return at;
}
export async function closeViewer(t){
  const {page} = t;
  if(await page.locator('#tools').isVisible().catch(() => false)) await page.click('#tDone');
  if(await page.locator('#viewer.on').count()){
    if(await page.locator('#viewer.hide').count()){ await page.mouse.click(640, 420); await page.waitForSelector('#viewer:not(.hide)'); }
    await page.click('#vBack');
  }
  await page.waitForSelector('#libList, #view', {timeout: 8000});
}
async function pickTool(page, sel){
  if(await page.getAttribute('#tools [data-tool=text]', 'aria-pressed') === 'true' && !sel.includes('text')) await page.click('#tools [data-tool=text]');
  if(await page.getAttribute(sel, 'aria-pressed') !== 'true') await page.click(sel);
  await waitFor(async () => await page.getAttribute(sel, 'aria-pressed') === 'true', `tool ${sel} not pressed`, 3000);
}
async function mouseLine(page, a, b, steps){
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for(let i = 1; i <= steps; i++) await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps);
  await page.mouse.up();
}
/* a line drawn with the pen or highlighter of that colour from (x0, y) to (x1, y); returns the new stored entry */
export async function uiLine(t, at, tool, color, y, {x0 = .2, x1 = .8} = {}){
  const {page} = t, before = new Set([...entriesOf(await pageOf(t, at.key)).keys()]);
  await pickTool(page, `#tools [data-tool=${tool}][data-color="${color}"]`);
  await mouseLine(page, at(x0, y), at(x1, y), 14);
  return waitFor(async () => [...entriesOf(await pageOf(t, at.key)).values()].find(s => !before.has(s.id) && !s.deleted && s.t === tool), `${t.name}: no new ${tool} stroke was saved`);
}
export async function uiNote(t, at, fx, fy, text){
  const {page} = t, before = new Set([...entriesOf(await pageOf(t, at.key)).keys()]);
  await pickTool(page, '#tools [data-tool=text]');
  const p = at(fx, fy);
  await page.mouse.click(p.x, p.y);
  const m = page.locator('.modal');
  await m.locator('textarea').waitFor({timeout: 5000});
  await m.locator('textarea').fill(text);
  await m.locator('[data-ok]').click();
  await noModal(page);
  return waitFor(async () => [...entriesOf(await pageOf(t, at.key)).values()].find(s => !before.has(s.id) && s.t === 'text' && s.text === text), `${t.name}: the note "${text}" was not saved`);
}
const inNote = (at, n) => { const p = at(n.x, n.y); return {x: p.x + 10, y: p.y + n.size * at.w * .4}; };
export async function uiEditNote(t, at, n, text){
  const {page} = t;
  await pickTool(page, '#tools [data-tool=text]');
  const p = inNote(at, n);
  await page.mouse.click(p.x, p.y);
  await page.locator('.modal [data-del]').waitFor({timeout: 5000}).catch(() => { throw new Error(`${t.name}: tapping the note did not open its edit dialog`); });
  await page.locator('.modal textarea').fill(text);
  await page.locator('.modal [data-ok]').click();
  await noModal(page);
  return waitFor(async () => { const s = entriesOf(await pageOf(t, at.key)).get(n.id); return s && s.text === text ? s : null; }, `${t.name}: the note edit was not saved`);
}
export async function uiMoveNote(t, at, n, dx, dy){
  const {page} = t;
  await pickTool(page, '#tools [data-tool=text]');
  const p = inNote(at, n);
  await mouseLine(page, p, {x: p.x + dx, y: p.y + dy}, 12);
  return waitFor(async () => { const s = entriesOf(await pageOf(t, at.key)).get(n.id); return s && (s.x !== n.x || s.y !== n.y) ? s : null; }, `${t.name}: the note move was not saved`);
}
/* the eraser dragged across the page at height y; waits until `id` is a marker */
export async function uiErase(t, at, y, id){
  const {page} = t;
  await pickTool(page, '#tools [data-tool=erase]');
  await mouseLine(page, at(.13, y), at(.87, y), 30);
  return waitFor(async () => { const s = entriesOf(await pageOf(t, at.key)).get(id); return s && s.deleted ? s : null; }, `${t.name}: the eraser did not erase ${id}`);
}
export async function uiUndo(t, at, id){
  await t.page.click('#tUndo');
  return waitFor(async () => { const s = entriesOf(await pageOf(t, at.key)).get(id); return s && !s.deleted ? s : null; }, `${t.name}: Undo did not bring ${id} back`);
}

/* ---------- the report ---------- */
export async function watchReports(t){
  const fn = () => {
    if(window.__ss6rep) return;
    const rep = window.__ss6rep = {items: null, n: 0};
    const look = () => {
      const m = [...document.querySelectorAll('.modal')].at(-1), h = m && m.querySelector('h2');
      if(h && /^Sync (finished|stopped|could not finish)/.test(h.textContent) && !m.__ss6){ m.__ss6 = 1; rep.n++; rep.items = [...m.querySelectorAll('li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()); }
    };
    new MutationObserver(look).observe(document, {childList: true, subtree: true});
  };
  await t.context.addInitScript(fn);
  await t.page.evaluate(fn);
}
export async function syncRead(t, opts){
  const rep = await syncTap(t, opts);
  const items = await t.page.evaluate(() => window.__ss6rep ? window.__ss6rep.items : null);
  assert(items, `${t.name}: the report watcher did not see the report (watchReports not called?)`);
  return {...rep, items};
}
export function marksCounts(text){
  const one = w => {
    const all = [...text.matchAll(new RegExp(w + ' marks on (\\d+) (pages?)\\.', 'g'))];
    assert(all.length <= 1, `the report says "${w} marks" ${all.length} times: "${text}"`);
    if(!all.length) return 0;
    const n = Number(all[0][1]);
    assert((n === 1) === (all[0][2] === 'page'), `the report says "${all[0][0]}" (1 page, 2 pages)`);
    assert(n > 0, `the report says "${all[0][0]}"`);
    return n;
  };
  return {sent: one('Sent'), got: one('Got')};
}
/* the Skipped line of a page: "<song name>: page N: <plain reason>" */
const NOT_PLAIN = /\b(TypeError|RangeError|SyntaxError|ReferenceError|Error:|undefined|\[object)|\.js:\d|Unexpected token|Maximum call stack/;
export function skippedPage(items, name, p){
  const pre = `${name}: page ${p}: `;
  const hit = items.find(s => s.startsWith(pre));
  if(!hit) return null;
  const why = hit.slice(pre.length);
  assert(why.trim().length > 0 && why.length <= 240 && !NOT_PLAIN.test(why), `the reason given for "${pre}" is not plain: "${why}"`);
  return why;
}
export const anyPageLine = (items, p) => items.find(s => new RegExp(`: page ${p}: \\S`).test(s));
export const writesBy = (google, by) => google.requests.filter(e => e.by === by && (e.kind === 'upload' || (e.kind === 'drive' && ['POST', 'PATCH', 'DELETE', 'PUT'].includes(e.method))));

/* ---------- charts ---------- */
/* a valid PDF of `pages` pages with random bytes in it (its own hash) */
export async function makePdf(pages, name){
  const doc = await PDFDocument.create();
  for(let i = 0; i < pages; i++) doc.addPage([612, 792]);
  await doc.attach(crypto.randomBytes(800), 'pad.bin', {mimeType: 'application/octet-stream'});
  const bytes = Buffer.from(await doc.save({useObjectStreams: false}));
  const file = path.join(TMP, name);
  fs.writeFileSync(file, bytes);
  return {bytes, file, hash: sha256(bytes), pages};
}
export async function newVersionUi(t, id, file){
  const {page} = t;
  await showAll(page);
  await songAct(page, 'newversion', id);
  await page.setInputFiles('#newVersionFile', file);
  await page.waitForSelector('.modal.nvask, .modal.dupask', {timeout: 15000});
  if(await page.locator('.modal.dupask').count()){ await page.click('.modal.dupask [data-dupadd]'); await page.waitForSelector('.modal.nvask', {timeout: 15000}); }
  await page.click('.modal.nvask [data-ok]');
  await page.waitForFunction(() => /^New version in place/.test(document.querySelector('#toast').textContent), null, {timeout: 20000});
  await sleep(300);
}

/* ---------- print (the way tools/loops/print.loop.mjs reads a printed PDF back: pdf.js, then pixels by colour) ---------- */
export async function printSetPdf(t, setName){
  const {page} = t;
  await page.click('#tSets');
  if(await page.locator('#view [data-allsets]').count()) await page.click('#view [data-allsets]');
  if(await page.locator('.collbar [data-collpick="all"]').count()) await page.click('.collbar [data-collpick="all"]');
  await page.locator('#view [data-set]').filter({hasText: setName}).first().click();
  await page.waitForFunction(n => document.querySelector('#view h2')?.textContent === n, setName, {timeout: 8000});
  await openSetMenu(page, 'print');                                    // the setlist's Download PDF is an item of its More menu
  const m = page.locator('.modal');
  await m.waitFor();
  await m.locator('#pInk').setChecked(true);
  const dl = await download(page, () => m.locator('[data-ok]').click());
  if(await page.locator('.modal').count()){ const x = page.locator('.modal [data-x]'); await x.waitFor({timeout: 5000}); await x.click(); }
  await noModal(page);
  await page.click('#tLib');
  return fs.readFileSync(dl.file);
}
/* Renders page `index` (0-based) of the PDF with pdf.js in the app's page and finds, for each spec {c, aMin, aMax, tol, region},
   the box (fractions of the page) of the pixels that look like colour c laid over white. */
export async function renderBoxes(t, bytes, index, specs){
  return t.page.evaluate(async ([b64, index, specs]) => {
    if(!window.pdfjsLib) throw new Error('pdf.js is not loaded in the page');
    if(!pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const doc = await pdfjsLib.getDocument({data: u, isEvalSupported: false}).promise;
    const pg = await doc.getPage(index + 1), vp = pg.getViewport({scale: 2});
    const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const c2 = cv.getContext('2d'); c2.fillStyle = '#fff'; c2.fillRect(0, 0, cv.width, cv.height);
    await pg.render({canvasContext: c2, viewport: vp}).promise;
    const W = cv.width, H = cv.height, d = c2.getImageData(0, 0, W, H).data, pages = doc.numPages;
    await doc.destroy();
    const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    return {pages, boxes: specs.map(spec => {
      const r = spec.region || [0, 0, 1, 1], c = hex(spec.c), k = [0, 1, 2].sort((a, b) => c[a] - c[b])[0];
      const aMin = spec.aMin ?? .5, aMax = spec.aMax ?? 1.02, tol = spec.tol ?? 24;
      let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for(let y = Math.floor(r[1] * H); y < Math.ceil(r[3] * H); y++) for(let x = Math.floor(r[0] * W); x < Math.ceil(r[2] * W); x++){
        const o = (y * W + x) * 4, px = [d[o], d[o + 1], d[o + 2]], a = (255 - px[k]) / (255 - c[k]);
        if(a >= aMin && a <= aMax && [0, 1, 2].every(j => Math.abs(255 - a * (255 - c[j]) - px[j]) <= tol)){ n++; if(x < x0) x0 = x; if(y < y0) y0 = y; if(x > x1) x1 = x; if(y > y1) y1 = y; }
      }
      return n ? {n, x0: x0 / W, y0: y0 / H, x1: (x1 + 1) / W, y1: (y1 + 1) / H} : {n: 0};
    })};
  }, [Buffer.from(bytes).toString('base64'), index, specs]);
}

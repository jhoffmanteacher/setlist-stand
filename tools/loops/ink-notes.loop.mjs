/*
 * Ink loop, directed: the eraser and text notes, in a real session.
 * CLAUDE.md: "The eraser does not touch [text notes]." and "Clear page" deletes everything on the page, undoable.
 * A pen stroke is drawn, a note is placed so the stroke runs through it, and the eraser is dragged along the whole
 * stroke, THROUGH the note. What IndexedDB stores and what the ink canvas shows are checked after every step.
 * Gestures and selectors are the ones tools/smoke.mjs and tools/loops/model.loop.mjs use.
 */
import path from 'node:path';
import {FIX, assert, sleep, idbAll, onScreen} from './harness.mjs';

const BLACK = '#1a1a1a', TEXT = 'Coda ♯ hold';
const fmt = o => JSON.stringify(o, (k, v) => typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);
const keysOf = o => Object.keys(o).sort().join();
async function waitFor(fn, what, ms = 6000){
  const end = Date.now() + ms; let v;
  while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(80); }
  throw new Error(typeof what === 'function' ? await what() : what);
}
const inkRec = async (page, key) => (await idbAll(page, 'ink'))[key] || {strokes: []};
const byId = (rec, id) => rec.strokes.find(x => x.id === id);
async function mouseLine(page, a, b, steps){
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for(let i = 1; i <= steps; i++) await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps);
  await page.mouse.up();
}
/* Ink pixels (alpha > 20) on page pn's ink canvas inside a SCREEN rect [x0, y0, x1, y1] (mapped to canvas pixels here). */
const inkPixels = (page, pn, rect) => page.evaluate(([pn, rect]) => {
  const cv = document.querySelector(`#stage .ink[data-pn="${pn}"]`); if(!cv) return -1;
  const b = cv.getBoundingClientRect(), sx = cv.width / b.width, sy = cv.height / b.height;
  const r = rect ? [(rect[0] - b.x) * sx, (rect[1] - b.y) * sy, (rect[2] - b.x) * sx, (rect[3] - b.y) * sy].map(Math.round) : [0, 0, cv.width, cv.height];
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for(let y = Math.max(0, r[1]); y < Math.min(cv.height, r[3]); y++) for(let x = Math.max(0, r[0]); x < Math.min(cv.width, r[2]); x++) if(d[(y * cv.width + x) * 4 + 3] > 20) n++;
  return n;
}, [pn, rect || null]);
async function pickTool(page, sel){
  if(await page.getAttribute('#tools [data-tool=text]', 'aria-pressed') === 'true' && !sel.includes('text')) await page.click('#tools [data-tool=text]');
  await page.click(sel);
  await waitFor(async () => await page.getAttribute(sel, 'aria-pressed') === 'true', `tool ${sel} not pressed`, 3000);
}

async function loopEraserNotes(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await page.setInputFiles('#file', path.join(FIX, 'one-page.pdf'));
    await page.waitForSelector('#libList [data-open]', {timeout: 20000});
    const id = Object.values(await idbAll(page, 'songs')).find(x => !x.deleted)?.id;
    assert(id, 'imported song not found');
    const key = id + ':1';

    /* open it, one page at a time, annotate */
    await page.click(`#libList [data-open="${id}"]`);
    await page.waitForSelector('#viewer.on #stage .sheet canvas');
    if(await page.locator('#viewer.hide').count()){ await page.mouse.click(640, 420); await page.waitForSelector('#viewer:not(.hide)'); }
    if(await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
    await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 1 && document.querySelector('#stage .ink[data-pn="1"]'), null, {timeout: 5000});
    if(await page.locator('#tools').isHidden()) await page.click('#vAnn');
    await page.waitForSelector('#tools:not([hidden])');
    const cvBox = await page.locator('#stage .ink[data-pn="1"]').boundingBox();
    const at = (fx, fy) => ({x: cvBox.x + cvBox.width * fx, y: cvBox.y + cvBox.height * fy});

    /* 1. a pen stroke straight across the page at y = .5 */
    await pickTool(page, `#tools [data-tool=pen][data-color="${BLACK}"]`);
    const A = at(.15, .5), B = at(.85, .5);
    await mouseLine(page, A, B, 24);
    const stroke = await waitFor(async () => (await inkRec(page, key)).strokes.find(x => x.t === 'pen' && !x.deleted), 'pen stroke not saved');
    assert(stroke.p.length > 2 && stroke.p.every(p => Math.abs(p[1] - .5) < .01), 'stroke points not along y = .5: ' + fmt(stroke.p.slice(0, 4)));

    /* 2. a large note whose top-left sits 13 px above the stroke, so the stroke (and the eraser path) runs through its text */
    await pickTool(page, '#tools [data-tool=text]');
    const N0 = {x: at(.4, .5).x, y: A.y - 13};
    await page.mouse.click(N0.x, N0.y);
    const m = page.locator('.modal');
    await m.locator('textarea').waitFor({timeout: 5000});
    await m.locator('textarea').fill(TEXT);
    await m.locator('[data-size=large]').click();
    await m.locator('[data-ok]').click();
    await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000});
    const note = await waitFor(async () => (await inkRec(page, key)).strokes.find(x => x.t === 'text' && !x.deleted && x.text === TEXT), 'note not saved');
    const fpx = note.size * cvBox.width;                         // font size in screen px
    const nx = cvBox.x + note.x * cvBox.width, ny = cvBox.y + note.y * cvBox.height;
    assert(Math.abs(nx - N0.x) < 3 && Math.abs(ny - N0.y) < 3, `note stored at ${fmt([nx, ny])}, clicked at ${fmt([N0.x, N0.y])}`);
    assert(A.y > ny && A.y < ny + fpx * 1.2, `setup: the stroke (y ${A.y.toFixed(1)}) does not pass through the note's text (y ${ny.toFixed(1)}..${(ny + fpx * 1.2).toFixed(1)})`);
    /* where only the note draws: its text above the stroke line; where only the stroke draws: left of the note */
    const noteRect = [nx, ny, nx + fpx * 4, A.y - 4], strokeRect = [A.x + 10, A.y - 4, nx - 20, A.y + 4];
    assert(await inkPixels(page, 1, noteRect) > 10, 'setup: the note is not drawn on the ink canvas');
    assert(await inkPixels(page, 1, strokeRect) > 10, 'setup: the stroke is not drawn on the ink canvas');

    /* 3. the eraser along the whole stroke, through the note */
    await pickTool(page, '#tools [data-tool=erase]');
    await mouseLine(page, {x: A.x - 5, y: A.y}, {x: B.x + 5, y: B.y}, 40);
    let rec = await waitFor(async () => { const r = await inkRec(page, key); return byId(r, stroke.id)?.deleted ? r : null; }, 'the eraser did not erase the stroke');
    const mk = byId(rec, stroke.id);
    assert(keysOf(mk) === 'deleted,id,updated' && mk.updated >= stroke.updated, 'erased stroke is not a deletion marker {id, deleted, updated}: ' + fmt(mk));
    /* give a wrongly-erased note time to reach the database before judging it */
    await sleep(400); rec = await inkRec(page, key);
    assert(JSON.stringify(byId(rec, note.id)) === JSON.stringify(note), 'the eraser touched the note: ' + fmt(byId(rec, note.id)) + ' (was ' + fmt(note) + ')');
    assert(rec.strokes.length === 2, 'page has ' + rec.strokes.length + ' records after the eraser, expected the marker and the note');
    assert(await inkPixels(page, 1, noteRect) > 10, 'the note is no longer drawn after the eraser pass');
    assert(await inkPixels(page, 1, strokeRect) === 0, 'the erased stroke is still drawn');

    /* 4. Undo brings the stroke back (fresh updated) and leaves the note */
    await page.click('#tUndo');
    rec = await waitFor(async () => { const r = await inkRec(page, key); return byId(r, stroke.id) && !byId(r, stroke.id).deleted ? r : null; }, 'Undo did not bring the stroke back');
    let st = byId(rec, stroke.id);
    assert(JSON.stringify(st.p) === JSON.stringify(stroke.p) && st.t === 'pen' && st.c === stroke.c && st.w === stroke.w, 'undone stroke differs: ' + fmt(st));
    assert(st.updated > mk.updated, `undone stroke updated ${st.updated} is not newer than its marker ${mk.updated}`);
    assert(JSON.stringify(byId(rec, note.id)) === JSON.stringify(note), 'Undo of the erase changed the note: ' + fmt(byId(rec, note.id)));
    assert(await inkPixels(page, 1, strokeRect) > 10 && await inkPixels(page, 1, noteRect) > 10, 'after Undo the stroke or the note is not drawn');

    /* 5. Clear page (two taps) deletes BOTH; Undo brings both back */
    await page.click('#tClear'); await page.click('#tClear');
    rec = await waitFor(async () => { const r = await inkRec(page, key); return r.strokes.length && r.strokes.every(x => x.deleted) ? r : null; },
      async () => 'Clear page did not delete everything: ' + fmt((await inkRec(page, key)).strokes.map(x => ({id: x.id, t: x.t, deleted: x.deleted}))));
    assert(rec.strokes.length === 2 && rec.strokes.every(x => keysOf(x) === 'deleted,id,updated'), 'Clear page records are not two deletion markers: ' + fmt(rec.strokes));
    const clearedAt = Math.max(...rec.strokes.map(x => x.updated));
    assert(await inkPixels(page, 1) === 0, 'ink still drawn after Clear page');
    await page.click('#tUndo');
    rec = await waitFor(async () => { const r = await inkRec(page, key); return r.strokes.length === 2 && r.strokes.every(x => !x.deleted) ? r : null; }, 'Undo after Clear page did not bring both back');
    st = byId(rec, stroke.id); const n2 = byId(rec, note.id);
    assert(JSON.stringify(st.p) === JSON.stringify(stroke.p) && st.updated >= clearedAt, 'stroke after Undo of Clear: ' + fmt(st));
    assert(['t', 'x', 'y', 'text', 'size', 'c'].every(k => n2[k] === note[k]) && n2.updated >= clearedAt, 'note after Undo of Clear: ' + fmt(n2) + ' (was ' + fmt(note) + ')');
    assert(await inkPixels(page, 1, strokeRect) > 10 && await inkPixels(page, 1, noteRect) > 10, 'after Undo of Clear the stroke or the note is not drawn');

    /* 6. delete the note from its dialog: a marker, the stroke stays */
    await pickTool(page, '#tools [data-tool=text]');
    await page.mouse.click(nx + 8, ny + fpx * .3);
    const del = page.locator('.modal [data-del]');
    await del.waitFor({timeout: 5000}).catch(() => { throw new Error('clicking the note did not open its edit dialog'); });
    assert(await page.locator('.modal textarea').inputValue() === TEXT, 'edit dialog shows ' + await page.locator('.modal textarea').inputValue());
    await del.click();
    await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000});
    rec = await waitFor(async () => { const r = await inkRec(page, key); return byId(r, note.id)?.deleted ? r : null; }, 'Delete left no marker');
    assert(keysOf(byId(rec, note.id)) === 'deleted,id,updated' && byId(rec, note.id).updated > 0, 'deleted note is not a marker: ' + fmt(byId(rec, note.id)));
    assert(byId(rec, stroke.id) && !byId(rec, stroke.id).deleted, 'deleting the note deleted the stroke');
    assert(await inkPixels(page, 1, noteRect) === 0, 'deleted note still drawn');
    assert(await inkPixels(page, 1, strokeRect) > 10, 'stroke no longer drawn after deleting the note');
    await page.click('#tDone');

    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* Full screen shows only the full-screen element and what is inside it. A note dialog, the crop screen or a toast that
   is outside it is open, has focus, makes the viewer behind it inert, and cannot be seen: the app looks frozen. Each is
   checked against the pixels the browser draws (onScreen), in full screen, in the engine under test. */
async function loopFullScreen(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await page.setInputFiles('#file', path.join(FIX, 'one-page.pdf'));
    await page.waitForSelector('#libList [data-open]', {timeout: 20000});
    const id = Object.values(await idbAll(page, 'songs')).find(x => !x.deleted)?.id;
    assert(id, 'imported song not found');
    await page.click(`#libList [data-open="${id}"]`);
    await page.waitForSelector('#viewer.on #stage .sheet canvas');
    const isFs = () => page.evaluate(() => !!document.fullscreenElement);
    const enterFs = async () => { await page.click('#vFull'); await waitFor(isFs, 'Full screen did not start', 4000); await sleep(300); };
    await enterFs();
    if(await page.locator('#viewer.hide').count()){ await page.evaluate(() => document.querySelector('#viewer').classList.remove('hide')); }
    await page.click('#vAnn');
    await page.waitForSelector('#tools:not([hidden])');

    /* a toast */
    await page.click('#tFinger');
    await waitFor(() => page.evaluate(() => document.querySelector('#toast').classList.contains('on') && getComputedStyle(document.querySelector('#toast')).opacity === '1'), 'no toast after the Finger button', 3000);
    assert(await onScreen(page, '#toast'), 'full screen: the toast is shown but not drawn on the screen');
    await page.click('#tFinger');

    /* Text: tap the page, type, save */
    await pickTool(page, '#tools [data-tool=text]');
    const cv = await page.locator('#stage .ink[data-pn="1"]').boundingBox();
    await page.mouse.click(cv.x + cv.width * .5, cv.y + cv.height * .4);
    await page.locator('.modal textarea').waitFor({timeout: 5000});
    assert(await isFs(), 'setup: not in full screen when the note dialog opened');
    assert(await onScreen(page, '.modal .box'), 'full screen: the note dialog is open (the viewer behind it is inert) but not drawn on the screen');
    await page.locator('.modal textarea').fill('Full screen note');
    await page.locator('.modal [data-ok]').click();
    await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000});
    await waitFor(async () => (await inkRec(page, id + ':1')).strokes.find(x => x.t === 'text' && x.text === 'Full screen note'), 'the note typed in full screen was not stored');
    assert(await page.evaluate(() => !document.querySelector('#viewer').inert), 'the viewer is still inert after the dialog closed');
    assert(await isFs(), 'saving the note left full screen');

    /* leaving full screen with a dialog open: it stays drawn and works, and Cancel gives the viewer back */
    await page.mouse.click(cv.x + cv.width * .3, cv.y + cv.height * .7);
    await page.locator('.modal textarea').waitFor({timeout: 5000});
    await page.evaluate(() => document.exitFullscreen());
    await waitFor(async () => !(await isFs()), 'full screen did not end', 4000);
    await sleep(300);
    assert(await onScreen(page, '.modal .box'), 'after leaving full screen the open dialog is not drawn');
    await page.locator('.modal [data-x]').click();
    await page.waitForFunction(() => !document.querySelector('.modal') && !document.querySelector('#viewer').inert, null, {timeout: 5000});
    assert((await inkRec(page, id + ':1')).strokes.filter(x => x.t === 'text' && !x.deleted).length === 1, 'a cancelled note was stored, or the saved one is gone');

    /* the crop screen */
    await page.click('#tDone');
    await enterFs();
    await page.click('#vCrop');
    await page.waitForSelector('#cropper:not([hidden]) #cropCv', {timeout: 5000});
    await waitFor(() => page.evaluate(() => document.querySelector('#cropBox').style.width), 'the crop box was not placed', 3000);
    assert(await isFs(), 'setup: not in full screen when the crop screen opened');
    assert(await onScreen(page, '#cropper'), 'full screen: the crop screen is open but not drawn on the screen');
    await page.click('#cropCancel');
    await page.waitForSelector('#cropper', {state: 'hidden', timeout: 3000});
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'ink: the eraser removes strokes but never a text note, and undo/clear treat notes as documented', run: loopEraserNotes},
  {name: 'ink: in full screen the note dialog, the crop screen and a toast are drawn on the screen and work', run: loopFullScreen},
];

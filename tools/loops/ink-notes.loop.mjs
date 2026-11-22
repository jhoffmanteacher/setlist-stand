/*
 * Ink loop, directed: the eraser and text notes, in a real session.
 * CLAUDE.md: "The eraser does not touch [text notes]." and "Clear page" deletes everything on the page, undoable.
 * A pen stroke is drawn, a note is placed so the stroke runs through it, and the eraser is dragged along the whole
 * stroke, THROUGH the note. What IndexedDB stores and what the ink canvas shows are checked after every step.
 * Gestures and selectors are the ones tools/smoke.mjs and tools/loops/model.loop.mjs use.
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import {FIX, assert, sleep, idbAll, onScreen, download, openSetMenu} from './harness.mjs';

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

/* The stylus draws with Annotate OFF (a finger only turns pages). It draws with the pen, or the highlighter if that was
   chosen last, or the pen if the last tool was the eraser or Text; a hint says where Undo and the colours are, once.
   Stylus events are sent as real PointerEvents with pointerType "pen" (works in Chromium and WebKit). */
async function loopStylusNoAnnotate(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await page.setInputFiles('#file', path.join(FIX, 'one-page.pdf'));
    await page.waitForSelector('#libList [data-open]', {timeout: 20000});
    const id = Object.values(await idbAll(page, 'songs')).find(x => !x.deleted)?.id;
    assert(id, 'imported song not found');
    const key = id + ':1';
    await page.click(`#libList [data-open="${id}"]`);
    await page.waitForSelector('#viewer.on #stage .sheet canvas');
    if(await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
    await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 1 && document.querySelector('#stage .ink[data-pn="1"]'), null, {timeout: 5000});
    const live = async () => (await inkRec(page, key)).strokes.filter(x => !x.deleted);
    const toastNow = () => page.evaluate(() => { const t = document.querySelector('#toast'); return t.classList.contains('on') && getComputedStyle(t).opacity === '1' ? t.textContent : ''; });
    const cvBox = await page.locator('#stage .ink[data-pn="1"]').boundingBox();
    const at = (fx, fy) => ({x: cvBox.x + cvBox.width * fx, y: cvBox.y + cvBox.height * fy});
    const drag = (type, a, b) => page.evaluate(([type, a, b]) => {
      const st = document.querySelector('#stage'), mk = (t, p) => new PointerEvent(t, {pointerId: type === 'pen' ? 7 : 8, pointerType: type, isPrimary: true, bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, buttons: t === 'pointerup' ? 0 : 1});
      const el = document.elementFromPoint(a.x, a.y);
      el.dispatchEvent(mk('pointerdown', a));
      for(let i = 1; i <= 12; i++) st.dispatchEvent(mk('pointermove', {x: a.x + (b.x - a.x) * i / 12, y: a.y + (b.y - a.y) * i / 12}));
      st.dispatchEvent(mk('pointerup', b));
    }, [type, a, b]);
    assert(await page.evaluate(() => document.querySelector('#viewer').classList.contains('annot')) === false, 'setup: Annotate is on');

    /* a finger does nothing to the marks with Annotate off */
    await drag('touch', at(.4, .2), at(.6, .2)); await sleep(400);
    assert((await live()).length === 0, 'a finger drew with Annotate off');

    /* a stylus draws a pen stroke, black, medium, and says so once */
    await drag('pen', at(.2, .2), at(.8, .2));
    const first = await waitFor(async () => (await live())[0], 'the stylus drew nothing with Annotate off');
    assert(first.t === 'pen' && first.c === BLACK && first.w === .003, `the stylus stroke is ${JSON.stringify([first.t, first.c, first.w])}, expected a black medium pen`);
    assert(/stylus draws/i.test(await toastNow()), 'no hint after the first stylus stroke: ' + JSON.stringify(await toastNow()));
    await waitFor(async () => !(await toastNow()), 'the hint stayed', 9000);
    await drag('pen', at(.2, .3), at(.8, .3));
    await waitFor(async () => (await live()).length === 2, 'the second stylus stroke was not saved');
    await sleep(300);
    assert(!/stylus draws/i.test(await toastNow()), 'the stylus hint showed a second time');

    /* the highlighter, chosen last, is what the stylus uses; the eraser last means the pen (it never erases with Annotate off) */
    await page.click('#vAnn'); await page.waitForSelector('#tools:not([hidden])');
    await pickTool(page, '#tools [data-tool=hl][data-color="#ffd400"]');
    await page.click('#tDone'); await page.waitForSelector('#tools', {state: 'hidden'});
    await drag('pen', at(.2, .7), at(.8, .7));
    const hl = await waitFor(async () => (await live()).find(x => x.t === 'hl'), 'the stylus did not use the highlighter');
    assert(hl.w === .02 && hl.c === '#ffd400', 'the highlighter stroke is ' + JSON.stringify([hl.c, hl.w]));
    await page.click('#vAnn'); await page.waitForSelector('#tools:not([hidden])');
    await pickTool(page, '#tools [data-tool=erase]');
    await page.click('#tDone'); await page.waitForSelector('#tools', {state: 'hidden'});
    const n0 = (await live()).length;
    await drag('pen', at(.2, .85), at(.8, .85));
    await waitFor(async () => (await live()).length === n0 + 1, 'after the eraser, the stylus drew nothing');
    const last = (await live()).find(x => Math.abs(x.p[0][1] - .85) < .02);
    assert(last && last.t === 'pen', 'with the eraser chosen last the stylus did not draw a pen stroke');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* A finger is ignored while annotating unless "Finger draws" is on. With Text chosen, a finger tap in the middle of the
   page used to do nothing at all (a player on an iPad and an Android tablet saw "the note does not show up"): now a toast
   says to tap "Finger draws". The toast must not show for the stylus/mouse, for another tool, or once Finger draws is on
   (then the tap opens the note box). A real touch is sent (hasTouch), so the page sees pointerType "touch". */
async function loopFingerHint(ctx){
  const s = await ctx.session({hasTouch: true});
  try{
    const {page} = s;
    await s.goto();
    await page.setInputFiles('#file', path.join(FIX, 'one-page.pdf'));
    await page.waitForSelector('#libList [data-open]', {timeout: 20000});
    const id = Object.values(await idbAll(page, 'songs')).find(x => !x.deleted)?.id;
    assert(id, 'imported song not found');
    await page.click(`#libList [data-open="${id}"]`);
    await page.waitForSelector('#viewer.on #stage .sheet canvas');
    await page.click('#vAnn');
    await page.waitForSelector('#tools:not([hidden])');
    const toastNow = () => page.evaluate(() => { const t = document.querySelector('#toast'); return t.classList.contains('on') && getComputedStyle(t).opacity === '1' ? t.textContent : ''; });
    const quiet = async () => { await waitFor(async () => !(await toastNow()), 'a toast stayed on screen', 8000); };
    const cv = await page.locator('#stage .ink[data-pn="1"]').boundingBox();
    const mid = {x: cv.x + cv.width * .5, y: cv.y + cv.height * .4};
    const hint = /Finger draws/;
    assert(await page.getAttribute('#tFinger', 'aria-pressed') === 'false', 'setup: Finger draws is already on');

    /* not for a mouse (the stylus), not for the pen, not for the eraser */
    await pickTool(page, '#tools [data-tool=text]');
    await page.mouse.click(mid.x, mid.y);
    await page.locator('.modal textarea').waitFor({timeout: 5000});
    await page.locator('.modal [data-x]').click();
    await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000});
    await sleep(500);
    assert(!hint.test(await toastNow()), 'a mouse click with Text chosen showed the Finger draws hint');
    await pickTool(page, '#tools [data-tool=pen]');
    await page.touchscreen.tap(mid.x, mid.y); await sleep(500);
    assert(!hint.test(await toastNow()), 'a finger tap with the PEN chosen showed the Text hint');

    /* Text chosen, Finger draws off: a finger tap in the middle shows the hint, opens no note box, stores nothing */
    await pickTool(page, '#tools [data-tool=text]');
    await quiet();
    await page.touchscreen.tap(mid.x, mid.y);
    const said = await waitFor(async () => { const t = await toastNow(); return hint.test(t) ? t : ''; }, async () => 'no hint after a finger tap with Text chosen; the toast says: ' + JSON.stringify(await toastNow()), 3000);
    assert(!(await page.locator('.modal').count()), 'a finger tap with Finger draws off opened a note box: ' + said);
    assert(!Object.values(await idbAll(page, 'ink')).some(r => r.strokes?.length), 'a finger tap with Finger draws off stored something');

    /* Finger draws on: the same tap opens the note box, and no hint */
    await page.click('#tFinger');
    await quiet();
    await page.touchscreen.tap(mid.x, mid.y);
    await page.locator('.modal textarea').waitFor({timeout: 5000});
    assert(!hint.test(await toastNow()), 'the Finger draws hint showed although Finger draws is on');
    await page.locator('.modal [data-x]').click();
    await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000});
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* Pen thickness: three buttons beside the pen colours (thin .002, medium .003, thick .005 of the page width). A stroke
   keeps the width it was drawn with, the highlighter stays .02, the choice survives a reload, and the PRINTED PDF
   (read back with pdf.js, an independent path from pdf-lib which wrote it) has lines of those thicknesses. */
const PEN_WIDTHS = {thin: .002, medium: .003, thick: .005};
async function loopPenWidths(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await page.setInputFiles('#file', path.join(FIX, 'one-page.pdf'));
    await page.waitForSelector('#libList [data-open]', {timeout: 20000});
    const id = Object.values(await idbAll(page, 'songs')).find(x => !x.deleted)?.id;
    assert(id, 'imported song not found');
    const key = id + ':1';
    const openAnnot = async () => {
      await page.click(`#libList [data-open="${id}"]`);
      await page.waitForSelector('#viewer.on #stage .sheet canvas');
      await page.evaluate(() => document.querySelector('#viewer').classList.remove('hide'));
      if(await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
      await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 1 && document.querySelector('#stage .ink[data-pn="1"]'), null, {timeout: 5000});
      if(await page.locator('#tools').isHidden()) await page.click('#vAnn');
      await page.waitForSelector('#tools:not([hidden])');
    };
    const pressed = async w => page.getAttribute(`#tools [data-width=${w}]`, 'aria-pressed');
    /* ONE button in the bar opens the row of three; choosing one closes it again and the bar's button shows the choice */
    const menuOpen = () => page.locator('#wdMenu').evaluate(e => !e.hidden && e.getClientRects().length > 0);
    const chooseWidth = async w => {
      await page.click('#tWidth');
      await waitFor(menuOpen, 'the thickness row did not open', 3000);
      await page.click(`#wdMenu [data-width=${w}]`);
      await waitFor(async () => !(await menuOpen()), 'the thickness row did not close after a choice', 3000);
      assert(await page.getAttribute('#tWidth', 'data-cur') === w, `the thickness button does not show ${w}`);
    };
    const live = async () => (await inkRec(page, key)).strokes.filter(x => !x.deleted);
    await openAnnot();
    const cvBox = await page.locator('#stage .ink[data-pn="1"]').boundingBox();
    const at = (fx, fy) => ({x: cvBox.x + cvBox.width * fx, y: cvBox.y + cvBox.height * fy});

    /* the buttons: three, named, medium pressed to begin with (nothing chosen yet) */
    await pickTool(page, `#tools [data-tool=pen][data-color="${BLACK}"]`);
    for(const [w, label] of [['thin', 'Thin line'], ['medium', 'Medium line'], ['thick', 'Thick line']])
      assert(await page.getAttribute(`#tools [data-width=${w}]`, 'aria-label') === label, `the ${w} button is not named "${label}"`);
    assert(await pressed('medium') === 'true' && await pressed('thin') === 'false' && await pressed('thick') === 'false', 'medium is not the first choice');

    /* one stroke with each; rows kept clear of the fixture's title text (about y .48) */
    const rows = {thin: .2, medium: .3, thick: .7};
    for(const [w, fy] of Object.entries(rows)){
      await chooseWidth(w);
      assert(await pressed(w) === 'true' && (await Promise.all(Object.keys(rows).filter(o => o !== w).map(pressed))).every(v => v === 'false'), `after tapping ${w} it is not the only one pressed`);
      await mouseLine(page, at(.2, fy), at(.8, fy), 20);
      await waitFor(async () => (await live()).length === Object.keys(rows).indexOf(w) + 1, `the ${w} stroke was not saved`);
    }
    const stored = await live();
    const wOf = fy => stored.find(x => Math.abs(x.p[0][1] - fy) < .02)?.w;
    for(const [w, fy] of Object.entries(rows)) assert(wOf(fy) === PEN_WIDTHS[w], `the ${w} stroke is stored with w = ${wOf(fy)}, expected ${PEN_WIDTHS[w]}`);

    /* a tap elsewhere closes the row without choosing */
    await page.click('#tWidth'); await waitFor(menuOpen, 'the thickness row did not open', 3000);
    await page.click('#vtop .ttl b');
    await waitFor(async () => !(await menuOpen()), 'a tap elsewhere did not close the thickness row', 3000);
    assert(await page.getAttribute('#tWidth', 'data-cur') === 'thick', 'closing the row without a choice changed the thickness');

    /* the highlighter keeps .02. The thickness buttons are only for the pens, but they STAY where they are (dimmed and not
       pressable for the other tools) so that no other button moves when a tool is picked (Jonathan, 2026-11-21) */
    const state = async () => [await page.locator('#tWidth').evaluate(e => ({shown: e.getClientRects().length > 0, off: e.disabled}))];
    const layout = () => page.$$eval('#tools button, #tools .gap', els => JSON.stringify(els.map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })));
    assert((await state()).every(b => b.shown && !b.off), 'the thickness button is not shown and usable with a pen');
    const penLayout = await layout();
    const notPens = async (what) => {
      assert((await state()).every(b => b.shown && b.off), `the thickness button is not kept in place, dimmed, with ${what}`);
      assert(await layout() === penLayout, `a toolbar button moved when ${what} was chosen`);
      await page.locator('#tWidth').evaluate(e => e.click());
      assert(!(await menuOpen()), `the thickness row opened with ${what} chosen`);
    };
    await pickTool(page, '#tools [data-tool=hl][data-color="#ffd400"]');
    await notPens('the highlighter');
    await mouseLine(page, at(.2, .85), at(.8, .85), 20);
    const hl = await waitFor(async () => (await live()).find(x => x.t === 'hl'), 'the highlighter stroke was not saved');
    assert(hl.w === .02, 'the highlighter stroke has w = ' + hl.w);
    await pickTool(page, '#tools [data-tool=erase]');
    await notPens('the eraser');
    await pickTool(page, '#tools [data-tool=text]');
    await notPens('Text');
    await page.click('#tools [data-tool=text]');                    // Text off: back to the eraser
    await pickTool(page, `#tools [data-tool=pen][data-color="${BLACK}"]`);
    assert((await state()).every(b => b.shown && !b.off) && await pressed('thick') === 'true', 'back on a pen the thickness button is not usable again, or thick is not still chosen');
    assert(await layout() === penLayout, 'a toolbar button moved after going back to a pen');
    assert(await page.evaluate(() => localStorage.getItem('ss-pen-w')) === 'thick', 'the choice is not kept in ss-pen-w');
    const before = JSON.stringify((await live()).map(x => [x.id, x.w]));

    /* a reload: the last choice is still pressed, and no stored stroke changed */
    await s.goto();
    await openAnnot();
    assert(await pressed('thick') === 'true' && await pressed('thin') === 'false' && await pressed('medium') === 'false', 'after a reload the last choice (thick) is not the one pressed');
    assert(JSON.stringify((await live()).map(x => [x.id, x.w])) === before, 'a stored stroke changed its width');

    /* print: a setlist of this song, with the marks */
    await page.click('#vBack'); await page.click('#tLib'); await page.waitForSelector('#libList');
    await page.click('#tSets'); await page.click('#view [data-newset]');
    await page.locator('.modal input[type=text]').fill('Widths');
    await page.click('.modal [data-ok]');
    await page.waitForFunction(() => document.querySelector('#view h2')?.textContent === 'Widths');
    await page.click('#view [data-addto]');
    await page.locator('.modal .pick input').first().check();
    await page.click('.modal [data-ok]');
    await page.waitForFunction(() => document.querySelectorAll('#items > li.row').length === 1, null, {timeout: 5000});
    await openSetMenu(page, 'print');
    const m = page.locator('.modal'); await m.waitFor();
    await m.locator('#pInk').setChecked(true);
    const dl = await download(page, () => m.locator('[data-ok]').click());
    if(await page.locator('.modal').count()){ const x = page.locator('.modal [data-x]'); await x.waitFor({timeout: 5000}); await x.click(); }
    const b64 = (await fsp.readFile(dl.file)).toString('base64');
    /* effective thickness of each line in pixels: the darkness added up down a column through the middle of the page, around its row */
    const th = await page.evaluate(async ([b64, rows]) => {
      if(!pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      const bin = atob(b64), u = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const doc = await pdfjsLib.getDocument({data: u}).promise, pg = await doc.getPage(1), vp = pg.getViewport({scale: 4});
      const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
      await pg.render({canvasContext: c, viewport: vp}).promise;
      const d = c.getImageData(0, 0, cv.width, cv.height).data, out = {W: cv.width, pages: doc.numPages};
      const x0 = Math.floor(cv.width * .45), x1 = Math.floor(cv.width * .55);
      for(const [name, fy] of Object.entries(rows)){
        let sum = 0, n = 0;
        for(let x = x0; x < x1; x++){
          let col = 0;
          for(let y = Math.floor(cv.height * (fy - .03)); y < Math.ceil(cv.height * (fy + .03)); y++){ const o = (y * cv.width + x) * 4; col += (255 - (d[o] + d[o + 1] + d[o + 2]) / 3) / (255 - 26); }
          sum += col; n++;
        }
        out[name] = sum / n;
      }
      await doc.destroy();
      return out;
    }, [b64, rows]);
    assert(th.pages === 1, 'the printed PDF has ' + th.pages + ' pages');
    for(const [w, fy] of Object.entries(rows)){
      const want = PEN_WIDTHS[w] * th.W;
      assert(Math.abs(th[w] - want) <= want * .2, `the printed ${w} line is ${th[w].toFixed(1)} px thick, expected about ${want.toFixed(1)} px (w ${PEN_WIDTHS[w]} of a ${th.W} px page)`);
    }
    assert(th.thin < th.medium && th.medium < th.thick, 'printed thickness is not thin < medium < thick: ' + fmt(th));
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'ink: the eraser removes strokes but never a text note, and undo/clear treat notes as documented', run: loopEraserNotes},
  {name: 'ink: in full screen the note dialog, the crop screen and a toast are drawn on the screen and work', run: loopFullScreen},
  {name: 'ink: the stylus draws with Annotate off (pen, or the highlighter if chosen last), a finger does not, the hint shows once', run: loopStylusNoAnnotate},
  {name: 'ink: a finger tap with Text chosen and Finger draws off says to tap Finger draws; mouse, pen and Finger draws on do not', run: loopFingerHint},
  {name: 'ink: three pen thicknesses are stored, kept after a reload, one button that opens the choices, kept in place (dimmed) for other tools, and print in the same order', run: loopPenWidths},
];

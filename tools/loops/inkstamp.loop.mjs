/*
 * Ink stamp loops: every change to a mark that already exists is stamped OVER that mark (stamp() in js/store.js:
 * max(now, its updated + 1)), never plain Date.now(); a NEW mark is now; a page's `updated` is max(now, its newest
 * entry, the page it replaces + 1). Why: Drive sync merges a page stroke by stroke, newest `updated` winning, so an erase or
 * an edit made here must beat the version it was made from even when that version is dated ahead (a tablet whose clock is ahead).
 *
 * Each loop puts a page whose marks are dated 2 hours AHEAD into the store (through the app's own js/store.js), opens the
 * song, does the REAL gesture in the viewer (eraser drag, note dialog, note drag, Clear page, Undo, pen), or New version
 * from the library, and reads what IndexedDB holds. Every entry the gesture did not touch must be exactly as it was (ids,
 * points, widths, colours, order); a touched one keeps everything but what the gesture changes.
 * Gestures and selectors are the ones tools/loops/ink-notes.loop.mjs uses.
 */
import path from 'node:path';
import {FIX, assert, sleep, idbAll} from './harness.mjs';
import {songAct, songActIn, songDelete, answerDelete} from './songrow.mjs';

const HOUR = 36e5;
const fmt = o => JSON.stringify(o, (k, v) => typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v);
const keysOf = o => Object.keys(o).sort().join();
async function waitFor(fn, what, ms = 6000){
  const end = Date.now() + ms; let v;
  while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(80); }
  throw new Error(typeof what === 'function' ? await what() : what);
}
const inkRec = async (page, key) => (await idbAll(page, 'ink'))[key] || {updated: 0, strokes: []};
const byId = (rec, id) => rec.strokes.find(x => x.id === id);
const browserNow = page => page.evaluate(() => Date.now());
const line = (y, x0 = .15, x1 = .85) => Array.from({length: 15}, (_, i) => [Math.round((x0 + (x1 - x0) * i / 14) * 1e4) / 1e4, y]);
const pen = (id, y, u) => ({id, updated: u, t: 'pen', c: '#1a1a1a', w: .003, p: line(y)});
const hl = (id, y, u) => ({id, updated: u, t: 'hl', c: '#f5c400', w: .02, p: line(y)});
const note = (id, x, y, u, text = 'Fine') => ({id, t: 'text', x, y, text, size: .028, c: '#d62828', updated: u});

async function mouseLine(page, a, b, steps){
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for(let i = 1; i <= steps; i++) await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps);
  await page.mouse.up();
}
async function pickTool(page, sel){
  if(await page.getAttribute('#tools [data-tool=text]', 'aria-pressed') === 'true' && !sel.includes('text')) await page.click('#tools [data-tool=text]');
  if(await page.getAttribute(sel, 'aria-pressed') !== 'true') await page.click(sel);
  await waitFor(async () => await page.getAttribute(sel, 'aria-pressed') === 'true', `tool ${sel} not pressed`, 3000);
}
const noModal = page => page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000});

/* Every entry of `after` must equal the one in `before` with the same id, except the ids in `touched`; the order of ids is kept
   (new ids may only come at the end). Returns the touched pairs. */
function untouched(before, after, touched, what){
  const ids = r => r.strokes.map(x => x.id);
  const a = ids(before), b = ids(after);
  assert(fmt(b.slice(0, a.length)) === fmt(a), `${what}: the entries' ids or order changed: ${fmt(a)} -> ${fmt(b)}`);
  for(const x of before.strokes) if(!touched.includes(x.id))
    assert(JSON.stringify(byId(after, x.id)) === JSON.stringify(x), `${what}: an entry the gesture did not touch changed: ${fmt(x)} -> ${fmt(byId(after, x.id))}`);
}
/* the marker that replaced `was`: {id, deleted, updated} only, dated after `was` */
function isMarkerOver(rec, was, what){
  const m = byId(rec, was.id);
  assert(m && m.deleted === true && keysOf(m) === 'deleted,id,updated', `${what}: not a deletion marker {id, deleted, updated}: ${fmt(m)}`);
  assert(m.updated > was.updated, `${what}: the marker's updated ${m.updated} is not later than the entry it replaces (${was.updated}, ${((was.updated - m.updated) / 6e4).toFixed(0)} min ahead): it would lose to it on a merge`);
  return m;
}
function pageNotLower(after, before, what){
  assert(Number.isFinite(after.updated) && after.updated > before.updated, `${what}: the page's updated ${after.updated} is not later than before (${before.updated})`);
  const newest = Math.max(...after.strokes.map(x => x.updated));
  assert(after.updated >= newest, `${what}: the page's updated ${after.updated} is older than its newest entry (${newest})`);
}

/* A session with one song (`file`) whose page 1 holds `strokes` (page updated `pageU`), put there through the app's js/store.js.
   open: the viewer on page 1, one page at a time, Annotate on. Returns {s, page, id, key, at(fx, fy)}. */
async function setup(ctx, {strokes, pageU, file = 'one-page.pdf', open = true}){
  const s = await ctx.session();
  const {page} = s;
  await s.goto();
  await page.setInputFiles('#file', path.join(FIX, file));
  await page.waitForSelector('#libList [data-open]', {timeout: 20000});
  const id = Object.values(await idbAll(page, 'songs')).find(x => !x.deleted)?.id;
  assert(id, 'imported song not found');
  const key = id + ':1';
  await page.evaluate(async ([key, rec]) => { const m = await import('./js/store.js'); await m.put('ink', key, rec); }, [key, {updated: pageU, strokes}]);
  assert(fmt(await inkRec(page, key)) === fmt({updated: pageU, strokes}), 'setup: the seeded page was not stored as given');
  let at = null;
  if(open){
    await page.click(`#libList [data-open="${id}"]`);
    await page.waitForSelector('#viewer.on #stage .sheet canvas');
    if(await page.locator('#viewer.hide').count()){ await page.mouse.click(640, 420); await page.waitForSelector('#viewer:not(.hide)'); }
    if(await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
    await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 1 && document.querySelector('#stage .ink[data-pn="1"]'), null, {timeout: 5000});
    if(await page.locator('#tools').isHidden()) await page.click('#vAnn');
    await page.waitForSelector('#tools:not([hidden])');
    const b = await page.locator('#stage .ink[data-pn="1"]').boundingBox();
    at = (fx, fy) => ({x: b.x + b.width * fx, y: b.y + b.height * fy});
    at.w = b.width;
  }
  return {s, page, id, key, at};
}
/* a point inside a note's text, in screen pixels */
const inNote = (at, n) => { const p = at(n.x, n.y); return {x: p.x + 10, y: p.y + n.size * at.w * .4}; };
async function openNote(page, at, n){
  await pickTool(page, '#tools [data-tool=text]');
  const p = inNote(at, n);
  await page.mouse.click(p.x, p.y);
  await page.locator('.modal [data-del]').waitFor({timeout: 5000}).catch(() => { throw new Error('tapping the note did not open its edit dialog'); });
}

/* (a) the eraser over a stroke dated 2 hours ahead */
async function loopErase(ctx){
  const F = Date.now() + 2 * HOUR;
  const A = pen('sA', .5, F), B = hl('sB', .2, F - 5), N = note('nN', .3, .7, F + 7);
  const {s, page, key, at} = await setup(ctx, {strokes: [A, B, N], pageU: F + 9});
  try{
    const before = await inkRec(page, key);
    await pickTool(page, '#tools [data-tool=erase]');
    const p0 = at(.13, .5), p1 = at(.87, .5);
    await mouseLine(page, p0, p1, 30);
    const rec = await waitFor(async () => { const r = await inkRec(page, key); return byId(r, A.id)?.deleted ? r : null; }, 'the eraser did not erase the stroke');
    await sleep(300);
    const after = await inkRec(page, key);
    isMarkerOver(after, A, 'erase');
    untouched(before, after, [A.id], 'erase');
    pageNotLower(after, before, 'erase');
    assert(rec.strokes.length === 3, 'erase: the page has ' + rec.strokes.length + ' entries, expected 3');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* (b) a text note dated 2 hours ahead: edited, then moved, then deleted, each over the last */
async function loopNote(ctx){
  const F = Date.now() + 2 * HOUR;
  const A = pen('sA', .3, F + 3), N = note('nN', .3, .6, F);
  const {s, page, key, at} = await setup(ctx, {strokes: [A, N], pageU: F + 4});
  try{
    /* edit */
    let before = await inkRec(page, key);
    await openNote(page, at, N);
    await page.locator('.modal textarea').fill('Fine edited');
    await page.locator('.modal [data-ok]').click();
    await noModal(page);
    let after = await waitFor(async () => { const r = await inkRec(page, key); return byId(r, N.id)?.text === 'Fine edited' ? r : null; }, 'the edit was not saved');
    const e = byId(after, N.id);
    assert(e.updated > N.updated, `edit: the note's updated ${e.updated} is not later than the note it edits (${N.updated}): the edit would lose on a merge`);
    assert(['t', 'x', 'y', 'size', 'c'].every(k => e[k] === N[k]) && keysOf(e) === keysOf(N), 'edit: the note changed more than its text: ' + fmt(e));
    untouched(before, after, [N.id], 'edit'); pageNotLower(after, before, 'edit');

    /* move: drag it 60 px right, 40 px down */
    before = after;
    await pickTool(page, '#tools [data-tool=text]');
    const p = inNote(at, e);
    await mouseLine(page, p, {x: p.x + 60, y: p.y + 40}, 12);
    after = await waitFor(async () => { const r = await inkRec(page, key); return byId(r, N.id) && byId(r, N.id).x !== e.x ? r : null; }, 'the move was not saved');
    const m = byId(after, N.id);
    assert(m.updated > e.updated, `move: the note's updated ${m.updated} is not later than the note it moves (${e.updated})`);
    assert(m.x > e.x && m.y > e.y && ['t', 'text', 'size', 'c'].every(k => m[k] === e[k]) && keysOf(m) === keysOf(e), 'move: the note changed more than its place: ' + fmt(m));
    untouched(before, after, [N.id], 'move'); pageNotLower(after, before, 'move');

    /* delete from its dialog */
    before = after;
    await openNote(page, at, m);
    await page.locator('.modal [data-del]').click();
    await noModal(page);
    after = await waitFor(async () => { const r = await inkRec(page, key); return byId(r, N.id)?.deleted ? r : null; }, 'Delete left no marker');
    isMarkerOver(after, m, 'delete note');
    untouched(before, after, [N.id], 'delete note'); pageNotLower(after, before, 'delete note');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* (c) Clear page: every live entry becomes a marker over itself; a marker already there is left as it was */
async function loopClear(ctx){
  const F = Date.now() + 2 * HOUR;
  const A = pen('sA', .5, F), B = hl('sB', .2, F + 11), N = note('nN', .3, .7, F + 22), M = {id: 'sM', deleted: true, updated: F + 33};
  const {s, page, key} = await setup(ctx, {strokes: [A, M, B, N], pageU: F + 44});
  try{
    const before = await inkRec(page, key);
    await page.click('#tClear'); await page.click('#tClear');
    const after = await waitFor(async () => { const r = await inkRec(page, key); return r.strokes.every(x => x.deleted) ? r : null; }, 'Clear page did not delete everything');
    for(const x of [A, B, N]) isMarkerOver(after, x, 'clear ' + x.t);
    untouched(before, after, [A.id, B.id, N.id], 'clear'); pageNotLower(after, before, 'clear');
    assert(after.strokes.length === 4, 'clear: the page has ' + after.strokes.length + ' entries, expected 4');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* (d) Undo: an erase undone brings the stroke back later than its marker; a note move undone puts it back later than the move */
async function loopUndo(ctx){
  const F = Date.now() + 2 * HOUR;
  const A = pen('sA', .5, F), N = note('nN', .3, .7, F + 50);
  const {s, page, key, at} = await setup(ctx, {strokes: [A, N], pageU: F + 60});
  try{
    let before = await inkRec(page, key);
    await pickTool(page, '#tools [data-tool=erase]');
    await mouseLine(page, at(.13, .5), at(.87, .5), 30);
    let after = await waitFor(async () => { const r = await inkRec(page, key); return byId(r, A.id)?.deleted ? r : null; }, 'the eraser did not erase the stroke');
    const mk = isMarkerOver(after, A, 'erase before undo');
    before = after;
    await page.click('#tUndo');
    after = await waitFor(async () => { const r = await inkRec(page, key); return byId(r, A.id) && !byId(r, A.id).deleted ? r : null; }, 'Undo did not bring the stroke back');
    const back = byId(after, A.id);
    assert(back.updated > mk.updated, `undo erase: the stroke's updated ${back.updated} is not later than its marker (${mk.updated}): the erase would win on a merge`);
    assert(JSON.stringify({...back, updated: 0}) === JSON.stringify({...A, updated: 0}), 'undo erase: the stroke came back different: ' + fmt(back));
    untouched(before, after, [A.id], 'undo erase'); pageNotLower(after, before, 'undo erase');

    /* a note move, undone */
    before = after;
    await pickTool(page, '#tools [data-tool=text]');
    const p = inNote(at, N);
    await mouseLine(page, p, {x: p.x + 50, y: p.y - 30}, 10);
    after = await waitFor(async () => { const r = await inkRec(page, key); return byId(r, N.id).x !== N.x ? r : null; }, 'the move was not saved');
    const moved = byId(after, N.id);
    assert(moved.updated > N.updated, `move: updated ${moved.updated} not later than the note (${N.updated})`);
    before = after;
    await page.click('#tUndo');
    after = await waitFor(async () => { const r = await inkRec(page, key); return byId(r, N.id).x === N.x ? r : null; }, 'Undo did not put the note back');
    const put = byId(after, N.id);
    assert(put.updated > moved.updated, `undo move: the note's updated ${put.updated} is not later than the moved note (${moved.updated}): the move would win on a merge`);
    assert(JSON.stringify({...put, updated: 0}) === JSON.stringify({...N, updated: 0}), 'undo move: the note came back different: ' + fmt(put));
    untouched(before, after, [N.id], 'undo move'); pageNotLower(after, before, 'undo move');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* (e) New version clears the song's marks: every marker is later than the mark it replaces, the page later than before; the
   archived copy keeps the marks exactly. Then reconcile() itself, read from the page by import. */
async function loopNewVersion(ctx){
  const F = Date.now() + 2 * HOUR;
  const A = pen('sA', .5, F), B = hl('sB', .2, F + 5), N = note('nN', .3, .7, F + 9), M = {id: 'sM', deleted: true, updated: F + 13};
  const {s, page, id, key} = await setup(ctx, {strokes: [A, B, M, N], pageU: F + HOUR, open: false});
  try{
    const before = await inkRec(page, key);
    await songAct(page, 'newversion', id);
    await page.setInputFiles('#newVersionFile', path.join(FIX, 'two-page.pdf'));
    await page.locator('.modal.nvask [data-ok]').waitFor({timeout: 15000}).catch(async () => { throw new Error('no New version question; toast "' + await page.locator('#toast').textContent() + '"'); });
    await page.click('.modal.nvask [data-ok]');
    const songs = await waitFor(async () => { const v = Object.values(await idbAll(page, 'songs')); return v.length === 2 ? v : null; }, 'New version made no archived copy');
    const copy = songs.find(x => x.id !== id);
    assert(copy && copy.archived, 'the archived copy is not archived');
    const ink = await idbAll(page, 'ink'), after = ink[key];
    assert(after && after.strokes.every(x => x.deleted), 'New version left live marks on the song: ' + fmt(after));
    for(const x of [A, B, N]) isMarkerOver(after, x, 'New version ' + x.t);
    untouched(before, after, [A.id, B.id, N.id], 'New version'); pageNotLower(after, before, 'New version');
    const kept = ink[copy.id + ':1'];
    assert(kept && JSON.stringify(kept.strokes) === JSON.stringify([A, B, N]), 'the archived copy does not hold the marks exactly as they were: ' + fmt(kept));
    assert(kept.updated >= Math.max(A.updated, B.updated, N.updated), `the copy's page updated ${kept.updated} is older than its newest mark`);

    /* reconcile() as js/ink.js (Undo) and New version call it */
    const r = await page.evaluate(([F]) => import('./js/store.js').then(m => {
      const S = {id: 'x', t: 'pen', c: '#1a1a1a', w: .003, p: [[.1, .1], [.2, .2]], updated: F};
      const Nt = {id: 'n', t: 'text', x: .1, y: .1, text: 'a', size: .018, c: '#1a1a1a', updated: F + 3};
      return {
        gone: m.reconcile([S], []),                                                               // a stroke that vanished
        revived: m.reconcile([{id: 'x', deleted: true, updated: F + 5}], [S]),                     // undo of an erase
        edited: m.reconcile([Nt], [{...Nt, x: .4, updated: F - 9}]),                               // undo of a note move
        markers: m.reconcile([{id: 'x', deleted: true, updated: F + 7}], [{id: 'x', deleted: true, updated: F + 1}]),
        same: m.reconcile([S, Nt], [S, Nt]),
        page: m.inkRecord([S], {updated: F + 20}).updated, fresh: m.inkRecord([S]).updated, empty: m.inkRecord([], {updated: 5}).updated, now: Date.now()};
    }), [F]);
    assert(r.gone.length === 1 && r.gone[0].deleted && r.gone[0].updated > F, 'reconcile: the marker of a vanished stroke is not later than the stroke: ' + fmt(r.gone));
    assert(r.revived[0].updated > F + 5 && !r.revived[0].deleted, 'reconcile: a stroke brought back is not later than its marker: ' + fmt(r.revived));
    assert(r.edited[0].updated > F + 3 && r.edited[0].x === .4, 'reconcile: a note put back is not later than the version it replaces: ' + fmt(r.edited));
    assert(r.markers[0].updated === F + 7, 'reconcile: of two markers for one stroke the earlier was kept: ' + fmt(r.markers));
    assert(fmt(r.same) === fmt([{id: 'x', t: 'pen', c: '#1a1a1a', w: .003, p: [[.1, .1], [.2, .2]], updated: F}, {id: 'n', t: 'text', x: .1, y: .1, text: 'a', size: .018, c: '#1a1a1a', updated: F + 3}]), 'reconcile: nothing changed but the entries did: ' + fmt(r.same));
    assert(r.page === F + 21, `inkRecord: a page over one dated ${F + 20} is ${r.page}, expected one later`);
    assert(r.fresh === F, `inkRecord: a new page holding a stroke dated ${F} is dated ${r.fresh}`);
    assert(Math.abs(r.empty - r.now) < 5000, `inkRecord: an empty page over an old one is not dated now: ${r.empty}`);
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* (f) a new pen stroke and a new note on a page dated ahead are dated NOW (never pushed into the future); the page is later than before */
async function loopNew(ctx){
  const F = Date.now() + 2 * HOUR;
  const A = pen('sA', .5, F), N = note('nN', .3, .7, F + 1);
  const {s, page, key, at} = await setup(ctx, {strokes: [A, N], pageU: F + HOUR});
  try{
    let before = await inkRec(page, key);
    await pickTool(page, '#tools [data-tool=pen][data-color="#1a1a1a"]');
    const t0 = await browserNow(page);
    await mouseLine(page, at(.2, .3), at(.8, .32), 20);
    let after = await waitFor(async () => { const r = await inkRec(page, key); return r.strokes.length === 3 ? r : null; }, 'the new stroke was not saved');
    const t1 = await browserNow(page);
    const S = after.strokes[2];
    assert(S.t === 'pen' && S.id !== A.id && S.id !== N.id && S.p.length > 2, 'the new stroke: ' + fmt(S));
    assert(S.updated >= t0 - 50 && S.updated <= t1, `a new stroke is dated ${S.updated}, not now (${t0}..${t1}; the page's newest is ${F + 1})`);
    untouched(before, after, [], 'new stroke'); pageNotLower(after, before, 'new stroke');

    /* a new note on an empty spot */
    before = after;
    await pickTool(page, '#tools [data-tool=text]');
    const t2 = await browserNow(page);
    const p = at(.6, .85);
    await page.mouse.click(p.x, p.y);
    await page.locator('.modal textarea').waitFor({timeout: 5000});
    await page.locator('.modal textarea').fill('New note');
    await page.locator('.modal [data-ok]').click();
    await noModal(page);
    after = await waitFor(async () => { const r = await inkRec(page, key); return r.strokes.length === 4 ? r : null; }, 'the new note was not saved');
    const t3 = await browserNow(page);
    const Q = after.strokes[3];
    assert(Q.t === 'text' && Q.text === 'New note', 'the new note: ' + fmt(Q));
    assert(Q.updated >= t2 - 50 && Q.updated <= t3, `a new note is dated ${Q.updated}, not now (${t2}..${t3})`);
    untouched(before, after, [], 'new note'); pageNotLower(after, before, 'new note');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* (g) opening a song whose page is dated ahead, a note dialog cancelled, the eraser over empty paper, Back and a reload write
   nothing: the page is byte for byte what was stored (ids, points, times) */
async function loopNothingElse(ctx){
  const F = Date.now() + 2 * HOUR;
  const A = pen('sA', .5, F), B = hl('sB', .2, F + 1), N = note('nN', .3, .7, F + 2), M = {id: 'sM', deleted: true, updated: F + 3};
  const {s, page, key, at} = await setup(ctx, {strokes: [A, B, M, N], pageU: F + 4});
  try{
    const before = await inkRec(page, key);
    /* taps that are not changes: Text on a note then Cancel; the eraser over empty paper */
    await openNote(page, at, N);
    await page.locator('.modal [data-x]').click();
    await noModal(page);
    await pickTool(page, '#tools [data-tool=erase]');
    await mouseLine(page, at(.1, .9), at(.9, .9), 10);
    await page.click('#tDone');
    await page.click('#vBack');
    await sleep(400);
    await page.reload(); await page.waitForSelector('#libList [data-open]', {timeout: 20000});
    const after = await inkRec(page, key);
    assert(JSON.stringify(after) === JSON.stringify(before), 'a page nobody changed was written: ' + fmt(before) + ' -> ' + fmt(after));
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'ink stamp a: the eraser over a stroke dated ahead leaves a marker later than it; the page is later; nothing else changes', run: loopErase},
  {name: 'ink stamp b: a note dated ahead, edited, moved and deleted, is each time later than the version before', run: loopNote},
  {name: 'ink stamp c: Clear page makes every mark a marker later than itself and leaves an old marker alone', run: loopClear},
  {name: 'ink stamp d: Undo of an erase and of a note move are later than what they undo', run: loopUndo},
  {name: 'ink stamp e: New version and reconcile() date their markers after the marks they replace; the archived copy keeps them exactly', run: loopNewVersion},
  {name: 'ink stamp f: a new stroke and a new note on a page dated ahead are dated now; the page is later than before', run: loopNew},
  {name: 'ink stamp g: looking, a cancelled note dialog and the eraser over empty paper write nothing', run: loopNothingElse},
];

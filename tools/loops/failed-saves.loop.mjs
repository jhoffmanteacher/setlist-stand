/*
 * Failed saves (js/saving.js; commit() and once()). An edit made on a screen saves a COPY of the record, so a refused save (tablet full)
 * says why in plain words and leaves the screen, the memory and the database exactly as they were. Closed loop: the fault is a
 * wrapped IDBObjectStore.put that throws "disk full" for one store; each step acts through the real buttons and then reads
 *   1. the toast: exactly the plain sentence
 *   2. storage: every store equal to the snapshot taken before (no write at all)
 *   3. memory: the app's own state (js/store.js) equals storage for every song and setlist
 *   4. the screen: the rows read from #libList / #items equal what they were, no row keeps a transform or a drag class
 *   5. the dialog opened again (after the fault is off) shows the OLD values, and so does a reload
 *   6. the problem log (ss-problems) holds no "promise" entry: nothing was left as an unhandled rejection
 * and a double tap on Remove, Add break, Duplicate or New setlist writes once while normal use is never blocked.
 */
import fs from 'node:fs';
import path from 'node:path';
import {FIX, assert, sleep, idbAll, snapshot, diff, openSetMenu} from './harness.mjs';
import {songAct, answerDelete} from './songrow.mjs';
import {setAct, setDelete} from './setrow.mjs';

const FULL = 'The tablet is full. Free up some space, then try again. Nothing was changed.';
const FILES = ['one-page.pdf', 'two-page.pdf', 'three-page.pdf'];

const waitFor = async (fn, what, ms = 8000) => { const end = Date.now() + ms; let v; while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(80); } throw new Error(typeof what === 'function' ? await what() : what); };
const clearToast = page => page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
const toastText = page => page.locator('#toast').textContent();
async function waitToast(page, re, ms = 8000){
  await waitFor(async () => re.test(await toastText(page)), async () => `toast ${re} did not show; toast is "${await toastText(page)}"`, ms);
  return toastText(page);
}
function expectSame(a, b, what){
  const d = diff(a, b, '', [], 20);
  assert(!d.length, `${what}: ${d.length} difference(s):\n    ` + d.join('\n    '));
}
const fault = (page, store) => page.evaluate(s => { window.__fail = s; }, store);
const inStore = (page, fn, arg) => page.evaluate(`(async () => {
  const S = await import(new URL('js/store.js', location.href).href);
  return (${fn.toString()})(S, ${JSON.stringify(arg === undefined ? null : arg)});
})()`);

async function session(ctx){
  const s = await ctx.session();
  await s.context.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(...a){
      if(window.__fail && this.name === window.__fail) throw new DOMException('The disk is full (test)', 'QuotaExceededError');
      return put.apply(this, a);
    };
  });
  await s.goto();
  return s;
}

/* Three songs, one collection and one setlist: song 1, a break, song 2, song 3. Returns {ids, setId}. */
async function seed(page){
  await page.setInputFiles('#file', FILES.map(f => path.join(FIX, f)));
  await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 3, null, {timeout: 15000});
  const songs = Object.values(await idbAll(page, 'songs')).filter(x => !x.deleted).sort((a, b) => a.pages - b.pages);
  const ids = songs.map(x => x.id);
  await inStore(page, async (S, a) => {
    await S.put('colls', 'c1', {id: 'c1', name: 'Band One', created: 1700000000000, updated: 1700000000000});
    await S.saveSet({id: 'set1', name: 'Gig One', colls: [], created: 1700000000000, items: [{type: 'song', id: a[0]}, {type: 'break', id: 'brk1', name: 'Set break'}, {type: 'song', id: a[1]}, {type: 'song', id: a[2]}]});
  }, ids);
  await page.reload(); await page.waitForSelector('#libList');
  await waitFor(async () => (await page.locator('#libList [data-open]').count()) === 3, 'library not drawn after the seed');
  return {ids, setId: 'set1'};
}

const libRows = page => page.$$eval('#libList li.row .t', xs => xs.map(x => x.textContent));
const itemRows = page => page.$$eval('#items > li.row', xs => xs.map(x => x.querySelector('.t').textContent + '|' + (x.querySelector('.num') || {}).textContent));
const promises = page => page.evaluate(() => { try{ return JSON.parse(localStorage.getItem('ss-problems') || '[]').filter(p => p.kind === 'promise').map(p => p.msg); }catch(e){ return []; } });

/* memory equals storage: every live song and setlist in the app's state is the stored record, field for field */
async function memoryEqualsStorage(page, what){
  const mem = await inStore(page, S => ({songs: S.state.songs, sets: S.state.sets}));
  for(const [name, list] of [['songs', mem.songs], ['sets', mem.sets]]){
    const stored = await idbAll(page, name);
    for(const r of list) expectSame(JSON.parse(JSON.stringify(stored[r.id])), JSON.parse(JSON.stringify(r)), `${what}: memory vs storage for ${name} ${r.id}`);
  }
}
async function calm(page, what){
  const bad = await page.$$eval('[style*="translate"], .dragging, .sorting', xs => xs.length);
  assert(bad === 0, `${what}: ${bad} row(s) still carry a drag transform or class`);
}
/* After a refused save: the toast, nothing written, memory = storage, no unhandled rejection. */
async function refused(page, before, what, re = /tablet is full/){
  assert(await waitToast(page, re) === FULL, `${what}: toast "${await toastText(page)}"`);
  await sleep(250);
  expectSame(before, await snapshot(page), `${what}: storage changed`);
  await memoryEqualsStorage(page, what);
  await calm(page, what);
  const p = await promises(page);
  assert(!p.length, `${what}: unhandled rejection logged: ${p.join(' / ')}`);
}

async function openSet(page, name = 'Gig One'){
  await page.click('#tSets');
  if(await page.locator('#view [data-allsets]').count()) await page.click('#view [data-allsets]');
  await page.locator('#view .row .main', {hasText: name}).first().click();
  await page.waitForSelector('#view [data-addto]');
  await waitFor(async () => (await page.locator('#items > li.row').count()) > 0, 'the setlist shows no rows');
}

/* ---------- songs: Edit, Archive, Restore, Delete ---------- */
async function loopSongs(ctx){
  const s = await session(ctx);
  try{
    const {page} = s, {ids} = await seed(page);
    const before = await snapshot(page), rows0 = await libRows(page), id = ids[0], old = (await idbAll(page, 'songs'))[id];
    await fault(page, 'songs');

    await clearToast(page);
    await songAct(page, 'edit', id);
    await page.locator('.modal [data-k=song]').fill('Changed Title');
    await page.locator('.modal [data-k=artist]').fill('Changed Artist');
    await page.click('.modal [data-ok]');
    await refused(page, before, 'Edit');
    expectSame(rows0, await libRows(page), 'Edit: the Library rows changed on screen');
    await fault(page, null);
    await songAct(page, 'edit', id);
    assert(await page.locator('.modal [data-k=song]').inputValue() === old.song && await page.locator('.modal [data-k=artist]').inputValue() === old.artist, 'Edit opened again shows the unsaved values');
    await page.click('.modal [data-x]');
    await fault(page, 'songs');

    await clearToast(page);
    await songAct(page, 'archive', id);
    await refused(page, before, 'Archive');
    expectSame(rows0, await libRows(page), 'Archive: the Library rows changed on screen');
    assert(await page.locator('#libList [data-open]').count() === 3, 'Archive: the song left the list although nothing was saved');

    /* Restore needs an archived song: archive for real, then refuse the restore */
    await fault(page, null);
    await songAct(page, 'archive', id);
    await waitFor(async () => (await idbAll(page, 'songs'))[id].archived === true, 'Archive did not save with the fault off');
    await waitFor(async () => (await page.locator('#libList [data-open]').count()) === 2, 'the archived song is still listed');
    const archivedSnap = await snapshot(page);
    await page.locator('#libList').getByText('Show archived').first().click().catch(() => {});
    const sh = page.locator('#view').getByRole('checkbox', {name: /archived/i});
    if(await sh.count() && !(await sh.first().isChecked())) await sh.first().check();
    await waitFor(async () => (await page.locator('#libList [data-open]').count()) === 3, 'Show archived did not list the archived song');
    await fault(page, 'songs'); await clearToast(page);
    await songAct(page, 'restore', id);
    await refused(page, archivedSnap, 'Restore');
    assert(await page.locator('#libList [data-open]').count() === 3, 'Restore: the list changed');

    /* Delete: a refused write says why and keeps the song and its PDF */
    await clearToast(page);
    await songAct(page, 'del', id);
    await answerDelete(page, true);
    await refused(page, archivedSnap, 'Delete');

    await fault(page, null);
    await page.reload(); await page.waitForSelector('#libList');
    expectSame(archivedSnap, await snapshot(page), 'after a reload');
  } finally { await s.close(); }
}

/* ---------- setlists: every edit of the open setlist and of the list ---------- */
async function loopSets(ctx){
  const s = await session(ctx);
  try{
    const {page} = s, {ids} = await seed(page);
    await openSet(page);
    const before = await snapshot(page), items0 = await itemRows(page), title0 = await page.locator('#view h2').textContent();
    const same = async what => { expectSame(items0, await itemRows(page), `${what}: the rows changed on screen`); assert(await page.locator('#view h2').textContent() === title0, `${what}: the title changed on screen`); };
    await fault(page, 'sets');

    await clearToast(page);
    await page.click('#view [data-addbreak]');
    await refused(page, before, 'Add break'); await same('Add break');

    await clearToast(page);
    await page.click('#view [data-addto]');
    await page.locator('.modal .pick').waitFor();
    await page.locator('.modal .pick label').first().locator('input').check();
    await page.click('.modal [data-ok]');
    await refused(page, before, 'Add songs'); await same('Add songs');

    await clearToast(page);
    await page.click('#items > li:nth-child(1) [data-rm]');
    await refused(page, before, 'Remove'); await same('Remove');

    await clearToast(page);
    await page.click('#items [data-renbreak]');
    await page.locator('.modal input[type=text]').fill('Renamed break');
    await page.click('.modal [data-ok]');
    await refused(page, before, 'Rename break'); await same('Rename break');

    await clearToast(page);
    await openSetMenu(page, 'rename');
    await page.locator('.modal input[type=text]').fill('Gig Renamed');
    await page.click('.modal [data-ok]');
    await refused(page, before, 'Rename'); await same('Rename');

    await clearToast(page);
    await openSetMenu(page, 'gig');
    await page.locator('.modal [data-gig]').fill('2031-05-05');
    await page.click('.modal [data-ok]');
    await refused(page, before, 'Gig date'); await same('Gig date');
    assert(await page.locator('#view .gigline').count() === 0, 'Gig date: a date is shown that was not saved');

    await clearToast(page);
    await openSetMenu(page, 'colls');
    await page.locator('.modal fieldset.checks input').first().check();
    await page.click('.modal [data-ok]');
    await refused(page, before, 'Collections'); await same('Collections');

    await clearToast(page);
    await openSetMenu(page, 'dup');
    await refused(page, before, 'Duplicate (More menu)'); await same('Duplicate (More menu)');
    assert(await page.locator('#view h2').first().textContent() === 'Gig One', 'Duplicate: the screen moved to a copy that was not saved');

    /* with the fault off the dialogs show what is stored: the old values */
    await fault(page, null);
    await openSetMenu(page, 'rename');
    assert(await page.locator('.modal input[type=text]').inputValue() === 'Gig One', 'Rename opened again shows an unsaved name');
    await page.click('.modal [data-x]');
    await openSetMenu(page, 'gig');
    assert(await page.locator('.modal [data-gig]').inputValue() === '', 'Gig date opened again shows an unsaved date');
    await page.click('.modal [data-x]');
    await openSetMenu(page, 'colls');
    assert(await page.locator('.modal fieldset.checks input:checked').count() === 0, 'Collections opened again shows an unsaved tick');
    await page.click('.modal [data-x]');
    await page.reload(); await page.waitForSelector('#libList');
    expectSame(before, await snapshot(page), 'after a reload');

    /* the list: New setlist, Duplicate, Delete */
    await page.click('#tSets');
    if(await page.locator('#view [data-allsets]').count()) await page.click('#view [data-allsets]');
    await page.waitForSelector('#view [data-newset]');
    const list0 = await page.$$eval('#view li.row .t', xs => xs.map(x => x.textContent));
    await fault(page, 'sets');
    await clearToast(page);
    await page.click('#view [data-newset]');
    await page.locator('.modal input[type=text]').fill('Never Saved');
    await page.click('.modal [data-ok]');
    await refused(page, before, 'New setlist');
    expectSame(list0, await page.$$eval('#view li.row .t', xs => xs.map(x => x.textContent)), 'New setlist: the list changed on screen');
    assert(await page.locator('#view [data-addto]').count() === 0, 'New setlist: the screen opened a setlist that was not saved');

    await sleep(450); await clearToast(page);
    await setAct(page, 'dup');
    await refused(page, before, 'Duplicate (list)');
    expectSame(list0, await page.$$eval('#view li.row .t', xs => xs.map(x => x.textContent)), 'Duplicate: the list changed on screen');

    await sleep(450); await clearToast(page);
    await setDelete(page);
    await refused(page, before, 'Delete setlist');
    expectSame(list0, await page.$$eval('#view li.row .t', xs => xs.map(x => x.textContent)), 'Delete setlist: the list changed on screen');

    /* and with the fault off they all work */
    await fault(page, null); await sleep(450);
    await setAct(page, 'dup');
    await waitFor(async () => (await page.$$eval('#view h2', xs => xs.map(x => x.textContent))).includes('Gig One copy'), 'Duplicate did not open its copy');
    assert(ids.length === 3, 'seed');
  } finally { await s.close(); }
}

/* ---------- reorder: drag from the handle and the arrow keys ---------- */
async function loopReorder(ctx){
  const s = await session(ctx);
  try{
    const {page} = s; await seed(page); await openSet(page);
    const before = await snapshot(page), items0 = await itemRows(page);
    await fault(page, 'sets');

    /* keyboard: no "Moved to position" toast when the save was refused */
    await clearToast(page);
    await page.locator('#items > li:nth-child(1) .handle').focus();
    await page.keyboard.press('ArrowDown');
    await refused(page, before, 'keyboard move');
    await sleep(500);
    assert(await toastText(page) === FULL, 'keyboard move: the toast changed to "' + await toastText(page) + '"');
    expectSame(items0, await itemRows(page), 'keyboard move: the rows changed on screen');

    /* drag: the rows come back from their transforms and show the stored order */
    await clearToast(page);
    const h = await page.locator('#items > li:nth-child(1) .handle').boundingBox(), r2 = await page.locator('#items > li:nth-child(3)').boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2, r2.y + r2.height * .8, {steps: 10});
    assert(await page.$$eval('#items .dragging', xs => xs.length) === 1, 'drag: no row is being dragged');
    await page.mouse.up();
    await refused(page, before, 'drag');
    expectSame(items0, await itemRows(page), 'drag: the rows changed on screen');

    /* fault off: the same drag saves, and the new order is on screen and in storage */
    await fault(page, null); await clearToast(page);
    const h2 = await page.locator('#items > li:nth-child(1) .handle').boundingBox();
    await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2); await page.mouse.down();
    await page.mouse.move(h2.x + h2.width / 2, r2.y + r2.height * .8, {steps: 10});
    await page.mouse.up();
    await waitFor(async () => (await itemRows(page))[0] !== items0[0], 'the drag with the fault off did not reorder');
    const stored = (await idbAll(page, 'sets')).set1.items.map(x => x.type === 'break' ? x.name : x.id);
    const shown = await page.$$eval('#items > li.row', xs => xs.map(x => x.querySelector('.t').textContent));
    assert(shown.length === stored.length && shown[0] !== items0[0].split('|')[0], 'the order on screen is not the stored one');
    await page.keyboard.press('Escape').catch(() => {});
    await memoryEqualsStorage(page, 'after the drag');
  } finally { await s.close(); }
}

/* ---------- crop ---------- */
async function loopCrop(ctx){
  const s = await session(ctx);
  try{
    const {page} = s, {ids} = await seed(page), id = ids[0];
    await page.click(`#libList [data-open="${id}"]`);
    await page.waitForSelector('#stage .sheet', {timeout: 10000});
    const crop = () => idbAll(page, 'songs').then(r => r[id].crop);
    const live = () => page.evaluate(async () => { const {V} = await import(new URL('js/viewer.js', location.href).href); return V.song.crop === undefined ? null : JSON.parse(JSON.stringify(V.song.crop)); });
    const openCropper = async () => {
      if(await page.locator('#viewer.hide').count()){ await page.mouse.click(640, 420); await page.waitForSelector('#viewer:not(.hide)'); }
      await page.click('#vCrop');
      await page.waitForFunction(() => !document.querySelector('#cropper').hidden && /^Page 1 of/.test(document.querySelector('#cropHint').textContent), null, {timeout: 5000});
    };
    const drag = async (h, f) => {
      const sh = await page.locator('#cropSheet').boundingBox(), hb = await page.locator(`#cropBox .ch[data-h=${h}]`).boundingBox();
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
      await page.mouse.move(sh.x + sh.width * f[0], sh.y + sh.height * f[1], {steps: 8}); await page.mouse.up();
    };
    const before = await snapshot(page);
    await fault(page, 'songs');
    for(const [what, btn] of [['Crop this page', '#cropPage'], ['Crop whole song', '#cropSong']]){
      await openCropper(); await clearToast(page);
      await drag('nw', [.2, .2]); await drag('se', [.8, .8]);
      await page.click(btn);
      assert(await waitToast(page, /tablet is full/) === FULL, `${what}: toast`);
      await sleep(250);
      assert(await page.locator('#cropper').isVisible(), `${what}: the crop screen closed although nothing was saved`);
      expectSame(before, await snapshot(page), `${what}: storage changed`);
      assert(await crop() === undefined && await live() === null, `${what}: the song holds a crop that was not saved: ${JSON.stringify(await live())}`);
      assert(!(await promises(page)).length, `${what}: an unhandled rejection was logged`);
      await page.click('#cropCancel');
      await page.waitForSelector('#cropper', {state: 'hidden'});
      assert(await live() === null, `${what}: after Cancel the viewer holds a crop`);
    }
    /* with the fault off the same crop saves and the viewer takes it */
    await fault(page, null); await openCropper();
    await drag('nw', [.2, .2]); await drag('se', [.8, .8]);
    await page.click('#cropPage'); await page.waitForSelector('#cropper', {state: 'hidden', timeout: 5000});
    const saved = await waitFor(async () => (await crop()) && (await crop()).pages && (await crop()).pages[1], 'the crop was not saved with the fault off');
    expectSame(await crop(), await live(), 'the viewer record and the stored crop');
    assert(saved.w < .9, 'the saved crop is the whole page');

    /* Reset with the fault on: the crop stays everywhere */
    const cropped = await snapshot(page);
    await fault(page, 'songs'); await openCropper(); await clearToast(page);
    await page.click('#cropReset');
    assert(await waitToast(page, /tablet is full/) === FULL, 'Reset: toast');
    await sleep(250);
    assert(await page.locator('#cropper').isVisible(), 'Reset: the crop screen closed although nothing was saved');
    expectSame(cropped, await snapshot(page), 'Reset: storage changed');
    expectSame(await crop(), await live(), 'Reset: the viewer record lost the crop that is still stored');
    await fault(page, null);
    await page.click('#cropReset'); await page.waitForSelector('#cropper', {state: 'hidden', timeout: 5000});
    await waitFor(async () => !(await crop()).pages[1], 'Reset with the fault off did not remove the page crop');
  } finally { await s.close(); }
}

/* ---------- double taps write once, and normal use is never blocked ---------- */
async function loopDouble(ctx){
  const s = await session(ctx);
  try{
    const {page} = s; await seed(page); await openSet(page);
    const setItems = async () => (await idbAll(page, 'sets')).set1.items;
    const n0 = (await setItems()).length;

    /* A double tap: the second tap lands the moment the list has been drawn again from the first one's save (the row that was
       second is now the one under the finger; a quick double tap on Add break comes just after the first break appeared). */
    const tapTwice = (sel, again) => page.evaluate(([sel, again]) => new Promise(res => {
      const v = document.querySelector('#view'), n0 = document.querySelectorAll('#items > li').length;
      let fired = false;
      new MutationObserver((_, o) => {
        if(fired || document.querySelectorAll('#items > li').length === n0) return;       // a redraw of the reminder line is not the list
        fired = true; o.disconnect(); document.querySelector(again).click(); setTimeout(res, 100);
      }).observe(v, {childList: true, subtree: true});
      document.querySelector(sel).click();
    }), [sel, again]);

    await tapTwice('#view [data-addbreak]', '#view [data-addbreak]');
    await waitFor(async () => (await setItems()).length >= n0 + 1, 'Add break did not write');
    await sleep(900);
    assert((await setItems()).length === n0 + 1, `a double tap on Add break wrote ${(await setItems()).length - n0} breaks`);

    /* Remove: the second tap lands on the row that moved up */
    const ids0 = (await setItems()).map(x => x.id);
    await tapTwice('#items > li:nth-child(2) [data-rm]', '#items > li:nth-child(2) [data-rm]');
    await sleep(900);
    const ids1 = (await setItems()).map(x => x.id);
    assert(ids1.length === ids0.length - 1 && !ids1.includes(ids0[1]) && ids1.filter(x => ids0.includes(x)).length === ids1.length, `a double tap on Remove removed ${ids0.length - ids1.length} rows`);
    assert((await itemRows(page)).length === ids1.length, 'the screen and storage disagree after Remove');

    /* a deliberate second Remove after a pause works */
    await page.click('#items > li:nth-child(2) [data-rm]');
    await waitFor(async () => (await setItems()).length === ids1.length - 1, 'a Remove after a pause was ignored');

    /* Duplicate and New setlist from the list */
    await page.click('#view [data-allsets]'); await page.waitForSelector('#view [data-newset]');
    const sets = async () => Object.values(await idbAll(page, 'sets')).filter(x => !x.deleted);
    await sleep(500);
    await page.click('#view [data-setrowmenu]');
    await page.locator('.modal.menubox').waitFor();
    await page.evaluate(() => { const b = document.querySelector('.modal.menubox [data-item="dup"]'); b.click(); b.click(); });
    await waitFor(async () => (await sets()).length === 2, 'Duplicate did not write');
    await sleep(800);
    assert((await sets()).length === 2, `a double tap on Duplicate made ${(await sets()).length - 1} copies`);

    await page.click('#view [data-allsets]'); await page.waitForSelector('#view [data-newset]');
    await sleep(500);
    await page.click('#view [data-newset]');
    await page.locator('.modal input[type=text]').fill('Fresh');
    await page.evaluate(() => { const b = document.querySelector('.modal [data-ok]'); b.click(); b.click(); });
    await waitFor(async () => (await sets()).length === 3, 'New setlist did not write');
    await sleep(800);
    assert((await sets()).length === 3, `a double tap on Save made ${(await sets()).length - 2} setlists`);
  } finally { await s.close(); }
}

export const loops = [
  {name: 'failed saves: Edit, Archive, Restore and Delete of a song', run: loopSongs},
  {name: 'failed saves: setlist Add songs, Add break, Rename break, Remove, Rename, Gig date, Collections, Duplicate, New setlist, Delete', run: loopSets},
  {name: 'failed saves: drag and keyboard reorder', run: loopReorder},
  {name: 'failed saves: crop page, crop song and reset', run: loopCrop},
  {name: 'failed saves: a double tap writes once', run: loopDouble},
];

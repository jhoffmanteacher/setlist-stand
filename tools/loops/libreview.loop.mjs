/*
 * Library and setlist fixes from the whole-app review (work order 2026-11-23, Group L). Each loop builds a library as a backup here,
 * restores it through the real Restore button, acts through the real buttons and reads the result back from STORAGE and the SCREEN:
 *  libreview 1  Remove in a setlist takes the row out at once and offers Undo for 6 seconds: Undo (by Tab + Enter, and by a tap) puts the
 *               song or the break back at its place; a second Remove within the 6 seconds is the one Undo undoes; after 6 s Undo is gone;
 *               a refused Undo save says so and changes nothing.
 *  libreview 2  A double tap on the song picker's Add N at phone width (412 px), with a row's Remove under the button: the songs are
 *               added once and NOTHING is removed (mouse and touch); a tap elsewhere right after a dialog closes still works.
 *  libreview 3  The Delete question names the setlists the song is in (upcoming first, 5 then "and N more") and offers Archive instead;
 *               "Add to setlist…" adds at the end with one write; the picker says "Only archived songs match"; Edit with the title emptied
 *               keeps the box open; Copy refuses a version another copy has; a collection delete whose read fails says so and changes
 *               nothing; a Library whose songs are all archived says so instead of "No music yet".
 *  libreview 4  The Tonight line: a setlist dated today shows on the Library and the Setlists list, the first by name, with Play (opens its
 *               first song) and "and N more setlists today" (opens the Setlists list); none when no gig is today.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {FIX, TMP, assert, sleep, sha256, idbAll, restoreZip, JSZip} from './harness.mjs';
import {songAct, openSongMenu} from './songrow.mjs';

const T = 1700000000000;
const pad = n => String(n).padStart(2, '0');
const dayFromNow = n => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const titleOf = s => s.song + (s.version ? ` (${s.version})` : '') + (s.artist ? ` - ${s.artist}` : '');
const FULL = 'The tablet is full. Free up some space, then try again. Nothing was changed.';

/* A version 3 backup: songs [{id, song, artist, version?, archived?, colls?}], sets [{id, name, items, gig?, created?}], colls. */
async function backup(name, {songs, sets = [], colls = []}){
  const zip = new JSZip(), base = fs.readFileSync(path.join(FIX, 'one-page.pdf'));
  const recs = songs.map((x, i) => {
    const bytes = Buffer.concat([base, Buffer.from(`\n% libreview ${name} ${i}\n`)]);
    zip.file(`files/${x.id}.pdf`, bytes);
    return {id: x.id, title: titleOf({version: '', ...x}), song: x.song, artist: x.artist || '', version: x.version || '', archived: !!x.archived, colls: x.colls || [], pages: 1, hash: sha256(bytes), added: T + i, updated: T + i};
  });
  const srecs = sets.map((st, i) => ({colls: [], created: T + 1000 + i, updated: T + 1000 + i, ...st}));
  zip.file('library.json', JSON.stringify({app: 'setlist-stand', version: 3, saved: new Date().toISOString(), songs: recs, sets: srecs, colls: colls.map(c => ({created: T, updated: T, ...c})), ink: {}}));
  const f = path.join(TMP, `libreview-${name}.zip`);
  await fsp.writeFile(f, await zip.generateAsync({type: 'nodebuffer'}));
  return f;
}
/* A session whose IndexedDB writes (put) or reads (getAll) to one store can be made to fail: window.__fail / window.__failRead = store name. */
async function session(ctx, opts = {}){
  const s = await ctx.session(opts);
  await s.context.addInitScript(() => {
    try{ localStorage.setItem('ss-gig-fill', '1'); }catch(e){}
    const put = IDBObjectStore.prototype.put, getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.put = function(...a){ if(window.__fail && this.name === window.__fail) throw new DOMException('The disk is full (test)', 'QuotaExceededError'); return put.apply(this, a); };
    IDBObjectStore.prototype.getAll = function(...a){ if(window.__failRead && this.name === window.__failRead) throw new Error('read failed (test)'); return getAll.apply(this, a); };
  });
  await s.goto();
  return s;
}
const clearToast = page => page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
const toastText = page => page.locator('#toast').textContent();
async function waitToast(page, re, ms = 8000){
  await page.waitForFunction(src => new RegExp(src).test(document.querySelector('#toast').textContent), re.source, {timeout: ms})
    .catch(async () => { throw new Error(`toast ${re} did not show; toast is "${await toastText(page)}"`); });
  return toastText(page);
}
const noModal = page => page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 8000});
const setItems = async (page, id) => (await idbAll(page, 'sets'))[id].items.map(it => it.type === 'break' ? `brk:${it.id}:${it.name}` : it.id);
async function toSets(page){
  await page.click('#tSets');
  await page.waitForSelector('#view [data-newset], #view [data-allsets]');
  if(await page.locator('#view [data-allsets]').count()){ await page.click('#view [data-allsets]'); await page.waitForSelector('#view [data-newset]'); }
}
async function openSet(page, id){ await toSets(page); await page.click(`#view [data-set="${id}"]`); await page.waitForSelector('#view [data-addto]'); }
const rows = page => page.locator('#items > li');
/* a tap on the toast's Undo button; on failure, says what was there */
async function tapUndo(page, step){
  await page.locator('#toast .toastact').click({timeout: 5000}).catch(async err => {
    const why = await page.evaluate(() => { const t = document.querySelector('#toast'), b = t.querySelector('.toastact'), r = b && b.getBoundingClientRect(), e = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {cls: t.className, text: t.textContent, button: !!b, rect: r && [r.left, r.top, r.width, r.height].map(Math.round), at: e ? e.tagName + '.' + e.className : null, pe: b && getComputedStyle(b).pointerEvents}; });
    throw new Error(`${step}: could not tap Undo (${JSON.stringify(why)}): ${err.message.split('\n')[0]}`);
  });
}

/* ---------- libreview 1: Undo after Remove ---------- */
async function loopUndo(ctx){
  const songs = [{id: 'ua', song: 'Alpha', artist: 'One'}, {id: 'ub', song: 'Bravo', artist: 'Two'}, {id: 'uc', song: 'Charlie', artist: 'Three'}];
  const f = await backup('undo', {songs, sets: [{id: 'us', name: 'Undo Gig', items: [{type: 'song', id: 'ua'}, {type: 'break', id: 'ubrk', name: 'Set break'}, {type: 'song', id: 'ub'}, {type: 'song', id: 'uc'}]}]});
  const s = await session(ctx);
  try{
    const {page} = s;
    await restoreZip(page, f);
    await openSet(page, 'us');
    const start = ['ua', 'brk:ubrk:Set break', 'ub', 'uc'];
    assert((await setItems(page, 'us')).join() === start.join(), 'the setlist did not restore as built: ' + (await setItems(page, 'us')).join());

    /* Remove Bravo (row 3): gone at once from storage and the screen; the toast names it and has an Undo button */
    await clearToast(page);
    await rows(page).nth(2).locator('[data-rm]').click();
    assert(await waitToast(page, /^Removed Bravo - Two\.\s*Undo$/), 'toast');
    assert((await setItems(page, 'us')).join() === 'ua,brk:ubrk:Set break,uc', 'Remove did not remove Bravo: ' + (await setItems(page, 'us')).join());
    assert(await rows(page).count() === 3, 'the screen still shows 4 rows after Remove');
    const ub = await page.locator('#toast .toastact').boundingBox(), vw = page.viewportSize();
    assert(ub && ub.width >= 44 && ub.height >= 44 && ub.x >= 0 && ub.x + ub.width <= vw.width && ub.y + ub.height <= vw.height, 'the Undo button is too small or off the screen: ' + JSON.stringify(ub));
    /* reachable by the keyboard: Tab from the page reaches it, Enter presses it */
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    let reached = false;
    for(let i = 0; i < 80 && !reached; i++){ await page.keyboard.press('Tab'); reached = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('toastact')); }
    assert(reached, 'Tab never reaches the Undo button');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#items > li').length === 4, null, {timeout: 5000});
    assert((await setItems(page, 'us')).join() === start.join(), 'Undo did not put Bravo back at its place: ' + (await setItems(page, 'us')).join());
    assert(!(await page.locator('#toast .toastact').count()), 'the Undo button is still there after Undo');
    await sleep(450);

    /* the break: removed and put back with its id and its name, by a tap on Undo */
    await clearToast(page);
    await rows(page).nth(1).locator('[data-rm]').click();
    await waitToast(page, /^Removed the break .Set break.\.\s*Undo$/);
    assert((await setItems(page, 'us')).join() === 'ua,ub,uc', 'Remove did not remove the break');
    await tapUndo(page, 'the break');
    await page.waitForFunction(() => document.querySelectorAll('#items > li').length === 4, null, {timeout: 5000});
    assert((await setItems(page, 'us')).join() === start.join(), 'Undo did not put the break back as it was: ' + (await setItems(page, 'us')).join());
    await sleep(450);

    /* two Removes within 6 seconds: the toast names the second, and Undo puts back only the second */
    await rows(page).nth(0).locator('[data-rm]').click();
    await waitToast(page, /^Removed Alpha/);
    await sleep(450);
    await clearToast(page);
    await rows(page).nth(2).locator('[data-rm]').click();                     // Charlie, now the third row
    await waitToast(page, /^Removed Charlie - Three\.\s*Undo$/);
    assert((await setItems(page, 'us')).join() === 'brk:ubrk:Set break,ub', 'two Removes: ' + (await setItems(page, 'us')).join());
    await tapUndo(page, 'two Removes');
    await page.waitForFunction(() => document.querySelectorAll('#items > li').length === 3, null, {timeout: 5000});
    assert((await setItems(page, 'us')).join() === 'brk:ubrk:Set break,ub,uc', 'Undo after two Removes: ' + (await setItems(page, 'us')).join());
    await sleep(450);

    /* a dialog opened while Undo shows takes the Undo away (the dialog saves the setlist it opened with): a tap where Undo was does
       nothing; adding Bravo back through Add songs leaves it there once, and nothing else changes */
    await clearToast(page);
    await rows(page).nth(1).locator('[data-rm]').click();
    await waitToast(page, /^Removed Bravo - Two\.\s*Undo$/);
    const undoAt = await page.locator('#toast .toastact').boundingBox();
    await page.click('#view [data-addto]');
    await page.locator('.modal .pick').waitFor();
    assert(!(await page.locator('#toast .toastact').count()), 'the Undo button is still there while Add songs is open');
    await page.mouse.click(undoAt.x + undoAt.width / 2, undoAt.y + undoAt.height / 2);
    await sleep(400);
    assert(await page.locator('.modal .pick').count() === 1, 'a tap where Undo was closed Add songs');
    assert((await setItems(page, 'us')).join() === 'brk:ubrk:Set break,uc', 'a tap where Undo was (Add songs open) changed the setlist: ' + (await setItems(page, 'us')).join());
    await page.locator('.modal .pick label', {hasText: 'Bravo'}).locator('input').check();
    await page.click('.modal [data-ok]');
    await noModal(page);
    await page.waitForFunction(() => document.querySelectorAll('#items > li').length === 3, null, {timeout: 5000});
    await sleep(300);
    assert((await setItems(page, 'us')).join() === 'brk:ubrk:Set break,uc,ub', 'Add songs after a Remove: ' + (await setItems(page, 'us')).join());
    assert(!(await page.locator('#toast .toastact').count()), 'the Undo button came back after Add songs');
    await sleep(450);

    /* with no dialog open, Undo still works */
    await rows(page).nth(2).locator('[data-rm]').click();
    await waitToast(page, /^Removed Bravo/);
    await tapUndo(page, 'Undo with no dialog');
    await page.waitForFunction(() => document.querySelectorAll('#items > li').length === 3, null, {timeout: 5000});
    assert((await setItems(page, 'us')).join() === 'brk:ubrk:Set break,uc,ub', 'Undo with no dialog open: ' + (await setItems(page, 'us')).join());
    await sleep(450);

    /* after 6 seconds the Undo is gone and the Remove stands */
    await rows(page).nth(1).locator('[data-rm]').click();
    await waitToast(page, /^Removed Charlie/);
    await sleep(5000);
    assert(await page.locator('#toast .toastact').count() === 1, 'the Undo button went before 6 seconds');
    await sleep(1500);
    assert(!(await page.locator('#toast .toastact').count()) && !(await page.locator('#toast.on').count()), 'the Undo button is still there after 6 seconds');
    assert((await setItems(page, 'us')).join() === 'brk:ubrk:Set break,ub', 'the Remove did not stand: ' + (await setItems(page, 'us')).join());

    /* a refused Undo save (tablet full): says so, and the setlist stays as the Remove left it */
    await rows(page).nth(1).locator('[data-rm]').click();
    await waitToast(page, /^Removed Bravo/);
    const before = (await setItems(page, 'us')).join();
    await page.evaluate(() => { window.__fail = 'sets'; });
    await tapUndo(page, 'a refused Undo');
    assert(await waitToast(page, /tablet is full/) === FULL, 'a refused Undo: ' + await toastText(page));
    await page.evaluate(() => { window.__fail = null; });
    assert((await setItems(page, 'us')).join() === before && await rows(page).count() === 1, 'a refused Undo changed the setlist');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- libreview 2: a double tap on Add N removes nothing ---------- */
async function loopDoubleAdd(ctx){
  const songs = [{id: 'da', song: 'Alpha', artist: 'One'}, {id: 'db', song: 'Bravo', artist: 'Two'}, {id: 'dc', song: 'Charlie', artist: 'Three'}, {id: 'dd', song: 'Delta', artist: 'Four'}];
  const items = [{type: 'song', id: 'da'}, {type: 'song', id: 'db'}, {type: 'song', id: 'dc'}, ...Array.from({length: 15}, (_, i) => ({type: 'break', id: 'dbrk' + i, name: 'Break ' + (i + 1)}))];
  const f = await backup('double', {songs, sets: [{id: 'ds', name: 'Double Gig', items}]});
  const s = await session(ctx, {viewport: {width: 412, height: 915}, hasTouch: true});
  try{
    const {page} = s;
    await restoreZip(page, f);
    await openSet(page, 'ds');
    const pickOpen = async () => { await page.evaluate(() => document.querySelector('#view [data-addto]').click()); await page.locator('.modal .pick').waitFor(); };
    const tick = async title => { await page.locator('.modal .pick label', {hasText: title}).locator('input').check(); };
    const centre = sel => page.evaluate(sel => { const b = document.querySelector(sel).getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2}; }, sel);

    let lastAdd = null;
    for(const how of ['mouse', 'touch']){
      const n0 = (await setItems(page, 'ds')).length;
      /* where the picker's Add button sits; then the page is scrolled so a row's Remove is under that very point */
      await pickOpen(); await tick('Delta');
      const add = await centre('.modal [data-ok]');
      await page.click('.modal [data-x]'); await noModal(page); await sleep(450);
      const under = await page.evaluate(({x, y}) => {
        const rms = [...document.querySelectorAll('#items [data-rm]')], b = rms[8].getBoundingClientRect();
        if(x < b.left || x > b.right) return `the Remove buttons (${Math.round(b.left)} to ${Math.round(b.right)}) are not under the Add button (x ${Math.round(x)})`;
        window.scrollBy(0, b.top + b.height / 2 - y);
        const e = document.elementFromPoint(x, y);
        return e && e.closest('[data-rm]') ? '' : `after scrolling, ${e ? e.outerHTML.slice(0, 80) : 'nothing'} is under the Add button`;
      }, add);
      assert(!under, 'test setup: ' + under);
      await pickOpen(); await tick('Delta');
      const add2 = await centre('.modal [data-ok]'); lastAdd = add;
      assert(Math.abs(add2.x - add.x) < 2 && Math.abs(add2.y - add.y) < 2, 'the picker moved between openings');

      const t0 = Date.now();
      if(how === 'mouse') await page.mouse.click(add.x, add.y); else await page.touchscreen.tap(add.x, add.y);
      await page.waitForFunction(n => document.querySelectorAll('#items > li').length === n, n0 + 1, {timeout: 3000, polling: 'raf'});
      if(how === 'mouse') await page.mouse.click(add.x, add.y); else await page.touchscreen.tap(add.x, add.y);
      const gap = Date.now() - t0;
      assert(gap < 380, `the second tap came ${gap} ms after the first: too late to be a double tap (a slow machine; run it again)`);
      const onRm = await page.evaluate(({x, y}) => { const e = document.elementFromPoint(x, y); return !!(e && e.closest('[data-rm]')); }, add);
      assert(onRm, 'test setup: the second tap did not land on a Remove button');
      await sleep(900);
      const now = await setItems(page, 'ds');
      assert(now.length === n0 + 1, `${how}: a double tap on Add 1 left ${now.length} items (expected ${n0 + 1}): the second tap ${now.length < n0 + 1 ? 'removed a row' : 'added again'}`);
      assert(now[now.length - 1] === 'dd', `${how}: Delta is not at the end: ${now.join()}`);
      assert(!(await page.locator('#toast .toastact').count()), `${how}: an Undo toast showed, so a Remove ran`);
      /* the added Delta goes again for the next round (by code, so no tap is involved) */
      await page.evaluate(async () => {
        const S = await import(new URL('js/store.js', location.href).href), U = await import(new URL('js/util.js', location.href).href);
        const st = (await S.get('sets', 'ds')); await S.saveSet({...st, items: st.items.slice(0, -1)}); await S.load(); U.hooks.render();
      });
      await sleep(450);
    }

    /* a third tap is meant: Add closes the picker, a tap elsewhere ends the guard, and a tap back on the same spot then removes that row */
    {
      const add = lastAdd, n2 = (await setItems(page, 'ds')).length;
      const other = await page.evaluate(({y}) => { const b = [...document.querySelectorAll('#items .num')].map(n => n.getBoundingClientRect()).find(b => Math.abs(b.top + b.height / 2 - y) > 80 && b.top > 0 && b.bottom < innerHeight); return b && {x: b.left + b.width / 2, y: b.top + b.height / 2}; }, add);
      assert(other && await page.evaluate(({x, y}) => !!document.elementFromPoint(x, y)?.closest('[data-rm]'), add), 'test setup: no row number away from the Add button, or no Remove under it');
      await pickOpen(); await tick('Delta');
      const t0 = Date.now();
      await page.mouse.click(add.x, add.y);
      await page.waitForFunction(n => document.querySelectorAll('#items > li').length === n, n2 + 1, {timeout: 3000, polling: 'raf'});
      await page.mouse.click(other.x, other.y);
      await page.mouse.click(add.x, add.y);
      const gap = Date.now() - t0;
      assert(gap < 380, `the third tap came ${gap} ms after the first (a slow machine; run it again)`);
      await page.waitForFunction(n => document.querySelectorAll('#items > li').length === n, n2, {timeout: 3000})
        .catch(async () => { throw new Error(`a tap back on the Add button's spot after a tap elsewhere was swallowed (${(await setItems(page, 'ds')).length} items, expected ${n2})`); });
      await sleep(450);
    }

    /* a tap somewhere else right after a dialog closed is never held back: Cancel, then at once a Remove 80 px away */
    await page.evaluate(() => window.scrollTo(0, 0));
    const n1 = (await setItems(page, 'ds')).length;
    await pickOpen();
    const cancel = await centre('.modal [data-x]');
    const rm = await page.evaluate(({y}) => { const b = [...document.querySelectorAll('#items [data-rm]')].map(r => r.getBoundingClientRect()).find(b => Math.abs(b.top + b.height / 2 - y) > 80 && b.top > 0 && b.bottom < innerHeight); return b && {x: b.left + b.width / 2, y: b.top + b.height / 2}; }, cancel);
    assert(rm, 'test setup: no Remove button on screen away from Cancel');
    await page.mouse.click(cancel.x, cancel.y);
    await page.mouse.click(rm.x, rm.y);
    await page.waitForFunction(n => document.querySelectorAll('#items > li').length === n, n1 - 1, {timeout: 3000})
      .catch(() => { throw new Error('a Remove tapped right after the picker was cancelled (somewhere else) was swallowed'); });
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- libreview 3: Delete names setlists, Archive instead, Add to setlist, picker, Edit, Copy, collection delete, all archived ---------- */
async function loopSongFixes(ctx){
  const songs = [{id: 'sx', song: 'Xylo', artist: 'Band'}, {id: 'sy', song: 'Yankee', artist: 'Band'}, {id: 'sz', song: 'Zulu', artist: 'Gone', archived: true},
    {id: 'cp', song: 'Copyme', artist: 'Band'}, {id: 'cpt', song: 'copyme', artist: 'band', version: 'Trio'}, {id: 'cpo', song: 'Copyme', artist: 'Band', version: 'old 2026-11-21', archived: true},
    {id: 'sl', song: 'Lonely', artist: 'Nobody', colls: ['c1']}];
  const x = {type: 'song', id: 'sx'};
  const sets = [
    {id: 'p1', name: 'Plain 1', items: [x], created: T + 10}, {id: 'p2', name: 'Plain 2', items: [x], created: T + 20},
    {id: 'p3', name: 'Plain 3', items: [x], created: T + 30}, {id: 'old', name: 'Old', items: [x], gig: '2020-03-14', created: T + 40},
    {id: 'later', name: 'Later', items: [x], gig: dayFromNow(30), created: T + 50}, {id: 'soon', name: 'Soon', items: [x, {type: 'song', id: 'sy'}], gig: dayFromNow(1), created: T + 5},
    {id: 'p4', name: 'Plain 4', items: [x], created: T + 60},
  ];
  const f = await backup('fixes', {songs, sets, colls: [{id: 'c1', name: 'Band One'}]});
  const s = await session(ctx);
  try{
    const {page} = s;
    await restoreZip(page, f);
    await page.click('#tLib');

    /* the Delete question names the setlists: upcoming first (soonest first), then the rest newest made first; 5 then "and 2 more" */
    await songAct(page, 'del', 'sx');
    const dq = page.locator('.modal.delask');
    await dq.waitFor();
    const lis = await dq.locator('ul.delsets li').allTextContents();
    assert(lis.length === 6 && /^Soon \(.+\)$/.test(lis[0]) && /^Later \(.+\)$/.test(lis[1]) && lis[2] === 'Plain 4' && /^Old \(.+\)$/.test(lis[3]) && lis[4] === 'Plain 3' && lis[5] === 'and 2 more',
      'the Delete question lists: ' + JSON.stringify(lis));
    assert(/these 7 setlists/.test(await dq.innerText()), 'the Delete question does not say how many setlists: ' + await dq.innerText());
    /* Archive instead: the song is archived, still in every setlist, its PDF kept */
    await dq.locator('[data-arch]').click();
    await noModal(page);
    await page.waitForFunction(() => !document.querySelector('#libList [data-open="sx"]'), null, {timeout: 5000});
    const songsNow = await idbAll(page, 'songs'), filesNow = await idbAll(page, 'files'), setsNow = await idbAll(page, 'sets');
    assert(songsNow.sx.archived === true && !songsNow.sx.deleted && !!filesNow.sx, 'Archive instead did not archive (or deleted): ' + JSON.stringify(songsNow.sx));
    assert(sets.every(st => setsNow[st.id].items.some(it => it.id === 'sx')), 'Archive instead took the song out of a setlist');
    /* an archived song's question has no Archive instead; a song in no setlist says so */
    await page.check('#showArch'); await page.waitForSelector('#libList h2');
    await songAct(page, 'del', 'sx'); await dq.waitFor();
    assert(!(await dq.locator('[data-arch]').count()), 'an archived song is offered Archive instead');
    await page.keyboard.press('Escape'); await noModal(page);
    await page.uncheck('#showArch');
    await songAct(page, 'del', 'sl'); await dq.waitFor();
    assert(/It is in no setlist/.test(await dq.innerText()) && await dq.locator('[data-arch]').count() === 1, 'a song in no setlist: ' + await dq.innerText());
    await dq.locator('[data-x]').click(); await noModal(page);
    assert(!(await idbAll(page, 'songs')).sl.archived, 'Cancel on the Delete question changed the song');

    /* Add to setlist…: upcoming first; Escape writes nothing; a tap adds the song at the end, once; the toast says where */
    const sets0 = JSON.stringify(await idbAll(page, 'sets'));
    await songAct(page, 'addset', 'sy');
    const al = page.locator('.modal.addtoset');
    await al.waitFor();
    const names = await al.locator('[data-addset] b').allTextContents();
    assert(names.slice(0, 2).join() === 'Soon,Later' && names.length === 7, 'Add to setlist lists: ' + names.join());
    assert(/already in it/.test(await al.locator('[data-addset="soon"]').innerText()), 'Add to setlist does not say the song is already in Soon');
    await page.keyboard.press('Escape'); await noModal(page);
    assert(JSON.stringify(await idbAll(page, 'sets')) === sets0, 'Escape on Add to setlist changed a setlist');
    await clearToast(page);
    await songAct(page, 'addset', 'sy'); await al.waitFor();
    await al.locator('[data-addset="p2"]').click();
    assert(await waitToast(page, /^Added to/) === 'Added to Plain 2', 'Add to setlist toast: ' + await toastText(page));
    const p2 = (await idbAll(page, 'sets')).p2;
    assert(p2.items.map(it => it.id).join() === 'sx,sy', 'Add to setlist did not add at the end: ' + p2.items.map(it => it.id).join());
    assert(Object.entries(await idbAll(page, 'sets')).every(([id, v]) => id === 'p2' || JSON.stringify(v) === JSON.stringify(JSON.parse(sets0)[id])), 'Add to setlist changed another setlist');

    /* the picker: a search that matches only archived songs says so */
    await openSet(page, 'p1');
    await page.click('#view [data-addto]'); await page.locator('.modal .pick').waitFor();
    await page.fill('.modal .pickq', 'Zulu');
    assert((await page.locator('.modal .pick').innerText()).trim() === 'Only archived songs match. Tick Show archived to see them.', 'archived-only search: ' + await page.locator('.modal .pick').innerText());
    await page.fill('.modal .pickq', 'qqqzzz');
    assert((await page.locator('.modal .pick').innerText()).trim() === 'No songs match.', 'no-match search: ' + await page.locator('.modal .pick').innerText());
    await page.click('.modal [data-x]'); await noModal(page);

    /* Edit with the title emptied: the box stays open, says why, focus in the title; nothing saved; then a title saves every field */
    await page.click('#tLib');
    const y0 = JSON.stringify((await idbAll(page, 'songs')).sy);
    await songAct(page, 'edit', 'sy');
    await page.locator('.modal input[data-k=song]').fill('   ');
    await page.locator('.modal input[data-k=artist]').fill('New Artist');
    await page.click('.modal [data-ok]');
    await sleep(300);
    assert(await page.locator('.modal input[data-k=song]').count() === 1, 'Edit with an empty title closed the box');
    assert((await page.locator('.modal [data-err]').innerText()) === 'A song needs a title.', 'the empty-title message: ' + await page.locator('.modal [data-err]').innerText());
    assert(await page.evaluate(() => document.activeElement && document.activeElement.dataset.k === 'song'), 'focus is not in the Title field');
    assert(await page.locator('.modal input[data-k=artist]').inputValue() === 'New Artist', 'the Artist typed was lost');
    assert(JSON.stringify((await idbAll(page, 'songs')).sy) === y0, 'Edit with an empty title saved something');
    await page.locator('.modal input[data-k=song]').fill('Yankee Two');
    await page.click('.modal [data-ok]'); await noModal(page);
    await page.waitForFunction(() => /Yankee Two - New Artist/.test(document.querySelector('#libList').textContent), null, {timeout: 5000});

    /* Copy: a version another copy has (live or archived; case and spaces ignored) is refused; a new one is saved */
    const n0 = Object.values(await idbAll(page, 'songs')).filter(r => !r.deleted).length;
    await songAct(page, 'copy', 'cp');
    const cq = page.locator('.modal.copyask');
    await cq.waitFor();
    const tryV = async v => { await cq.locator('input').fill(v); return {off: await cq.locator('[data-ok]').isDisabled(), msg: (await cq.locator('[data-err]').isVisible()) ? await cq.locator('[data-err]').innerText() : ''}; };
    let r = await tryV('  trio ');
    assert(r.off && /^Another copy of this song already has that version name/.test(r.msg), 'Copy with a live copy\'s version: ' + JSON.stringify(r));
    r = await tryV('OLD  2026-11-21');
    assert(r.off && /^An archived copy of this song already has that version name/.test(r.msg), 'Copy with an archived copy\'s version: ' + JSON.stringify(r));
    r = await tryV('Quartet');
    assert(!r.off && !r.msg, 'Copy with a new version is refused: ' + JSON.stringify(r));
    await cq.locator('[data-ok]').click(); await noModal(page);
    await page.waitForFunction(() => /Copyme \(Quartet\)/.test(document.querySelector('#libList').textContent), null, {timeout: 5000});
    assert(Object.values(await idbAll(page, 'songs')).filter(r => !r.deleted).length === n0 + 1, 'Copy with a new version did not copy');

    /* a collection delete whose read fails: the plain sentence, nothing changed */
    const c0 = JSON.stringify(await idbAll(page, 'colls')), s0 = JSON.stringify(await idbAll(page, 'songs'));
    await page.click('#view [data-collmanage]'); await page.locator('.collmgr').waitFor();
    const del = page.locator('.collmgr [data-mdel="c1"]');
    await del.click();
    assert(await del.textContent() === 'Tap again to delete', 'first tap on a collection\'s Delete reads ' + await del.textContent());
    await clearToast(page);
    await page.evaluate(() => { window.__failRead = 'songs'; });
    await del.click();
    const ct = await waitToast(page, /collection/);
    await page.evaluate(() => { window.__failRead = null; });
    assert(ct === 'Could not delete the collection. Nothing was changed.', 'a collection delete with a failed read says: ' + ct);
    assert(JSON.stringify(await idbAll(page, 'colls')) === c0 && JSON.stringify(await idbAll(page, 'songs')) === s0, 'a collection delete with a failed read changed something');
    await page.click('.collmgr [data-x]'); await noModal(page);
    const problems = await page.evaluate(() => JSON.parse(localStorage.getItem('ss-problems') || '[]').filter(p => p.kind === 'promise'));
    assert(!problems.length, 'an unhandled rejection reached the problem log: ' + JSON.stringify(problems));
  } finally { await s.close(); }

  /* a Library whose songs are all archived says so, not "No music yet" */
  const g = await backup('allarch', {songs: [{id: 'aa', song: 'Put Away', artist: 'Band', archived: true}]});
  const s2 = await session(ctx);
  try{
    const {page} = s2;
    await restoreZip(page, g);
    await page.click('#tLib');
    const h = await page.locator('#libList .empty h2').textContent();
    assert(h === 'All your songs are archived' && /Tick Show archived/.test(await page.locator('#libList .empty').innerText()), 'every song archived: the Library says "' + h + '"');
    await page.check('#showArch');
    await page.waitForSelector('#libList [data-open="aa"]');
    assert(!/No music yet/.test(await page.locator('#libList').innerText()), 'Show archived: "No music yet" is shown');
    assert(!s2.errors.length, 'page errors: ' + s2.errors.join(' | '));
  } finally { await s2.close(); }
}

/* ---------- libreview 4: the Tonight line ---------- */
async function loopTonight(ctx){
  const songs = [{id: 'ta', song: 'Opener', artist: 'Band'}, {id: 'tb', song: 'Second', artist: 'Band'}, {id: 'tc', song: 'Zed Song', artist: 'Band'}];
  const sets = [
    {id: 'tz', name: 'Zebra Club', items: [{type: 'song', id: 'tc'}], gig: dayFromNow(0)},
    {id: 'tal', name: 'alpha Bar', items: [{type: 'break', id: 'tbrk', name: 'Doors'}, {type: 'song', id: 'ta'}, {type: 'song', id: 'tb'}], gig: dayFromNow(0)},
    {id: 'tn', name: 'Next Week', items: [{type: 'song', id: 'tb'}], gig: dayFromNow(7)},
  ];
  const f = await backup('tonight', {songs, sets, colls: [{id: 'tco', name: 'Other Band'}]});
  const s = await session(ctx);
  try{
    const {page} = s;
    await restoreZip(page, f);
    await page.click('#tLib');
    const line = page.locator('#view .tonight');
    await line.waitFor({timeout: 5000});
    assert((await line.locator('.tn1').innerText()).trim() === 'Tonight: alpha Bar', 'the Library\'s Tonight line: ' + await line.innerText());
    assert((await line.locator('button.tnmore').innerText()).trim() === 'and 1 more setlist today', 'the "more" part: ' + await line.innerText());
    const lineBox = await line.boundingBox(), first = await page.locator('#view .collbar').boundingBox();
    assert(lineBox.y < first.y, 'the Tonight line is not at the top of the Library');
    /* it shows whatever collection is shown */
    await page.click('.collbar [data-collpick="tco"]');
    await line.waitFor();
    await page.click('.collbar [data-collpick="all"]');
    /* the Setlists list: the same line; "and 1 more" is plain text there */
    await toSets(page);
    await line.waitFor();
    assert((await line.locator('.tn1').innerText()).trim() === 'Tonight: alpha Bar' && !(await line.locator('button.tnmore').count()) && /and 1 more setlist today/.test(await line.innerText()), 'the Setlists list\'s Tonight line: ' + await line.innerText());
    /* inside an open setlist it is not shown */
    await page.click('#view [data-set="tn"]'); await page.waitForSelector('#view [data-addto]');
    assert(!(await line.count()), 'the Tonight line shows inside an open setlist');
    /* "and 1 more setlists today" opens the Setlists list */
    await page.click('#tLib'); await line.waitFor();
    await line.locator('button.tnmore').click();
    await page.waitForSelector('#view [data-newset]');
    assert(await page.getAttribute('#tSets', 'aria-selected') === 'true', '"and 1 more" did not open the Setlists tab');
    /* Play opens the viewer at alpha Bar's first entry (its break, as Play setlist does) */
    await page.click('#tLib'); await line.waitFor();
    await line.locator('[data-tonight]').click();
    await page.waitForSelector('#viewer.on');
    await page.waitForFunction(() => /Doors/.test(document.querySelector('#stage').textContent), null, {timeout: 8000})
      .catch(async () => { throw new Error('Play did not open alpha Bar at its first entry: the viewer shows "' + (await page.locator('#viewer').innerText()).slice(0, 120) + '"'); });
    await page.click('#vBack');
    await page.waitForFunction(() => !document.querySelector('#viewer.on'), null, {timeout: 8000});
    /* a setlist for tonight with no songs: Play is greyed; and no gig today: no line */
    await page.evaluate(async () => {
      const S = await import(new URL('js/store.js', location.href).href), U = await import(new URL('js/util.js', location.href).href);
      for(const id of ['tal', 'tz']){ const st = await S.get('sets', id); await S.saveSet(id === 'tal' ? {...st, items: []} : {...st, gig: '2020-01-01'}); }
      await S.load(); U.hooks.render();
    });
    await page.waitForFunction(() => !document.querySelector('#view .tonight .tnmore'), null, {timeout: 5000});
    assert(await line.locator('[data-tonight]').isDisabled(), 'Play is not greyed for an empty setlist tonight');
    await page.evaluate(async () => {
      const S = await import(new URL('js/store.js', location.href).href), U = await import(new URL('js/util.js', location.href).href);
      const st = await S.get('sets', 'tal'); await S.saveSet({...st, gig: '2020-01-02'});
      await S.load(); U.hooks.render();
    });
    await page.waitForFunction(() => !document.querySelector('#view .tonight'), null, {timeout: 5000});
    await toSets(page);
    assert(!(await line.count()), 'a Tonight line with no gig today (Setlists list)');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- libreview 5: a double tap on the song menu's "Add to setlist…" adds the song to no setlist ---------- */
async function loopDoubleAddToSet(ctx){
  const songs = [{id: 'qa', song: 'Alpha', artist: 'One'}, {id: 'qb', song: 'Bravo', artist: 'Two'}];
  const sets = Array.from({length: 6}, (_, i) => ({id: 'q' + i, name: 'Setlist ' + (i + 1), items: [{type: 'song', id: 'qb'}], created: T + i}));
  const f = await backup('doubleset', {songs, sets});
  const s = await session(ctx, {viewport: {width: 412, height: 915}, hasTouch: true});
  try{
    const {page} = s;
    await restoreZip(page, f);
    await page.click('#tLib');
    const sets0 = JSON.stringify(await idbAll(page, 'sets'));
    for(const how of ['mouse', 'touch']){
      const box = await openSongMenu(page, 'qa');
      const b = await box.locator('[data-item="addset"]').boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2;
      const t0 = Date.now();
      if(how === 'mouse') await page.mouse.click(x, y); else await page.touchscreen.tap(x, y);
      await page.locator('.modal.addtoset').waitFor({timeout: 3000});
      const under = await page.evaluate(({x, y}) => { const e = document.elementFromPoint(x, y)?.closest('[data-addset]'); return e ? e.dataset.addset : ''; }, {x, y});
      if(how === 'mouse') await page.mouse.click(x, y); else await page.touchscreen.tap(x, y);
      const gap = Date.now() - t0;
      assert(under, 'test setup: no setlist button under the menu\'s Add to setlist item');
      assert(gap < 380, `the second tap came ${gap} ms after the first (a slow machine; run it again)`);
      await sleep(900);
      assert(JSON.stringify(await idbAll(page, 'sets')) === sets0, `${how}: a double tap on Add to setlist… added the song to a setlist (${under} was under the second tap)`);
      assert(await page.locator('.modal.addtoset').count() === 1, `${how}: the setlist list closed by itself`);
      assert(!(await page.locator('.modal.addtoset [data-addset]:disabled').count()), `${how}: the setlist buttons stay greyed`);
      await page.keyboard.press('Escape'); await noModal(page); await sleep(450);
    }
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'libreview 1: setlist Remove offers Undo for 6 s (Tab + Enter and tap), it puts the song or break back at its place, a second Remove is the one undone, a refused Undo says so', run: loopUndo},
  {name: 'libreview 2: a double tap on the picker\'s Add N (412 px, mouse and touch) adds once and removes nothing behind it; a tap elsewhere right after a dialog closes works', run: loopDoubleAdd},
  {name: 'libreview 3: Delete names the setlists and offers Archive instead; Add to setlist; archived-only search; Edit with no title; Copy version clash; collection delete read fails; all archived', run: loopSongFixes},
  {name: 'libreview 5: a double tap on a song menu\'s Add to setlist… (412 px, 6 setlists, mouse and touch) adds the song to no setlist', run: loopDoubleAddToSet},
  {name: 'libreview 4: the Tonight line on the Library and the Setlists list: first by name, Play, and N more, empty, none', run: loopTonight},
];

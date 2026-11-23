/*
 * Collections loops: the database upgrade that adds the `colls` store, and what share packages do (and do not do) with collections.
 *
 * collections 1  a version 1 database with real records (PDFs, marks, a setlist, a crop, deletion markers) is opened by this version:
 *                every record, PDF and ink page is exactly what it was, apart from `colls: []` on each song and setlist, and the
 *                store `colls` exists. A second load changes nothing.
 * collections 2  a tab still running the old app keeps the database open: the upgrade waits, the page says so in plain words, and
 *                carries on by itself when that tab lets go. A tab on this version lets go when a newer version asks.
 * share 6        a package made from a library with collections holds no collection data; importing it puts the new songs and the
 *                setlist in the collection that is shown (or the default, when All is shown) and leaves a song the library already
 *                had exactly as it was, collections included.
 */
import fs from 'node:fs';
import path from 'node:path';
import {FIX, assert, sha256, snapshot, normalise, diff, download, idbAll, openSetMenu} from './harness.mjs';
import {songAct, songActIn, songDelete, answerDelete} from './songrow.mjs';
import {importFixtures, buildLibrary, closeDone, readPackage, songsOf} from './share-lib.mjs';

const bytesOf = f => Array.from(fs.readFileSync(path.join(FIX, f)));
const hashOf = f => sha256(fs.readFileSync(path.join(FIX, f)));

/* A version 1 library, written the way the previous app wrote it: a database at version 1 with four stores and no `colls` anywhere. */
function oldLibrary(){
  const H1 = hashOf('one-page.pdf'), H3 = hashOf('three-page.pdf');
  return {
    songs: [
      {id: 'upa', title: 'Alpha Song - Alpha Artist', song: 'Alpha Song', artist: 'Alpha Artist', version: '', archived: false, pages: 1, hash: H1, added: 1700000000000, updated: 1700000000500,
        crop: {all: {x: .1, y: .1, w: .8, h: .8}, pages: {}}},
      {id: 'upb', title: 'Beta Tune (in G) - Beta Artist', song: 'Beta Tune', artist: 'Beta Artist', version: 'in G', archived: true, pages: 3, hash: H3, added: 1700000000100, updated: 1700000000600},
      {id: 'upz', deleted: true, updated: 1700000000900}],
    sets: [
      {id: 'ups', name: 'Old Gig', items: [{type: 'song', id: 'upa'}, {type: 'break', id: 'upbrk', name: 'Set 2'}, {type: 'song', id: 'upb'}], created: 1700000001000, updated: 1700000001500},
      {id: 'upsz', deleted: true, updated: 1700000001900}],
    ink: {'upa:1': {updated: 1700000002000, strokes: [{id: 'k1', t: 'pen', c: '#1a1a1a', w: .003, p: [[.1, .1], [.5, .5]], updated: 1700000002000},
      {id: 'k2', deleted: true, updated: 1700000002100}]}},
    files: {upa: 'one-page.pdf', upb: 'three-page.pdf'},
  };
}
/* In a bare page of the site (no app running): open the database at version 1, create the four old stores, write the records.
   keepOpen: leave the connection open, as a tab running the old app does (window.__old). */
const writeV1 = (page, lib, keepOpen = false) => page.evaluate(({lib, bytes, keepOpen}) => new Promise((res, rej) => {
  const r = indexedDB.open('setlist-stand', 1);
  r.onupgradeneeded = () => { for(const n of ['songs', 'files', 'sets', 'ink']) r.result.createObjectStore(n); };
  r.onerror = () => rej(r.error);
  r.onsuccess = () => {
    const d = r.result, t = d.transaction(['songs', 'files', 'sets', 'ink'], 'readwrite');
    for(const s of lib.songs) t.objectStore('songs').put(s, s.id);
    for(const s of lib.sets) t.objectStore('sets').put(s, s.id);
    for(const [k, v] of Object.entries(lib.ink)) t.objectStore('ink').put(v, k);
    for(const [id, f] of Object.entries(lib.files)) t.objectStore('files').put(new Blob([new Uint8Array(bytes[f])], {type: 'application/pdf'}), id);
    t.oncomplete = () => { if(keepOpen) window.__old = d; else d.close(); res(); };
    t.onerror = () => rej(t.error);
  };
}), {lib, bytes: Object.fromEntries(Object.values(lib.files).map(f => [f, bytesOf(f)])), keepOpen});
const dbInfo = page => page.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open('setlist-stand');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => { const d = r.result, o = {version: d.version, stores: [...d.objectStoreNames].sort()}; d.close(); res(o); };
}));

async function loopUpgrade(ctx){
  const lib = oldLibrary(), s = await ctx.session();
  try{
    const {page} = s;
    await page.goto(s.base + 'css/app.css');                       // a page of the site with no app in it: the database is written first
    await writeV1(page, lib);
    assert((await dbInfo(page)).version === 1, 'the test database is not at version 1');
    await s.goto();                                                // this version opens it and upgrades it
    const info = await dbInfo(page);
    assert(info.version === 2 && info.stores.join() === 'colls,files,ink,sets,songs', 'after the upgrade: ' + JSON.stringify(info));
    const A = normalise(await snapshot(page));
    /* every record is what it was; the only difference is `colls: []` on a live song or setlist (a deletion marker gets nothing) */
    const want = {songs: {}, sets: {}};
    for(const x of lib.songs) want.songs[x.id] = x.deleted ? x : {...x, colls: []};
    for(const x of lib.sets) want.sets[x.id] = x.deleted ? x : {...x, colls: []};
    const d = diff(want.songs, A.songs, 'songs').concat(diff(want.sets, A.sets, 'sets'), diff(lib.ink, A.ink, 'ink'));
    assert(!d.length, 'the upgrade changed more than adding `colls: []`:\n    ' + d.join('\n    '));
    assert(JSON.stringify(Object.keys(A.colls)) === '[]', 'the upgrade made collections: ' + JSON.stringify(A.colls));
    for(const [id, f] of Object.entries(lib.files)) assert(A.files[id] === hashOf(f), `the PDF of ${id} changed in the upgrade (${A.files[id]})`);
    /* the library works: the live song is listed, the archived one is under Show archived, the setlist plays both */
    assert(await page.locator('#libList [data-open]').count() === 1, 'the library lists ' + await page.locator('#libList [data-open]').count() + ' songs after the upgrade');
    await page.check('#showArch');
    assert(await page.locator('#libList [data-open]').count() === 2, 'Show archived does not list the archived song after the upgrade');
    assert(await page.locator('.collbar button').count() === 1 && /^Collections$/.test(await page.locator('.collbar button').textContent()), 'with no collections the picker is not just the Collections button');
    await page.click('#tSets');
    await page.locator('#view [data-set]', {hasText: 'Old Gig'}).click();
    assert(await page.locator('#items > li.row').count() === 3, 'the old setlist does not show its three rows');
    /* loading again changes nothing (the upgrade is done once) */
    await page.reload(); await page.waitForSelector('#libList');
    const diff2 = diff(A, normalise(await snapshot(page)));
    assert(!diff2.length, 'a second load changed the library: ' + diff2.join(' | '));
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

async function loopBlocked(ctx){
  const s = await ctx.session();
  try{
    /* ---- a tab on the OLD app holds the database open: the upgrade waits, says so, and goes on when that tab lets go ---- */
    const old = s.page, lib = oldLibrary();
    await old.goto(s.base + 'css/app.css');
    await writeV1(old, lib, true);
    const b = await s.context.newPage(), errs = [];
    b.on('pageerror', e => errs.push(e.message));
    await b.goto(s.base + 'index.html', {waitUntil: 'domcontentloaded'});
    await b.waitForSelector('[data-dbblocked]', {timeout: 10000}).catch(() => { throw new Error('the page did not say that another tab is blocking the update'); });
    const msg = await b.locator('[data-dbblocked]').textContent();
    assert(/Close the other Setlist Stand tab/.test(msg), 'the blocked message: ' + msg);
    assert(await b.locator('#libList').count() === 0 && await b.locator('[data-add]').count() === 0, 'the library is drawn while the upgrade is blocked');
    assert((await old.evaluate(() => window.__old.version)) === 1, 'the old tab\'s database is not at version 1');
    await old.evaluate(() => window.__old.close());                // the old tab lets go (or is closed)
    await b.waitForSelector('#libList', {timeout: 15000}).catch(() => { throw new Error('the page did not carry on after the old tab let go'); });
    assert(await b.locator('[data-dbblocked]').count() === 0, 'the blocked message is still shown after the upgrade went through');
    assert((await dbInfo(b)).version === 2, 'the database is not at version 2 after the old tab let go');
    assert(await b.locator('#libList [data-open]').count() === 1, 'the old library is not listed after the upgrade: ' + await b.locator('#libList').innerText());
    assert(!errs.length, 'page errors: ' + errs.join(' | '));

    /* ---- this version lets go when a newer one asks ---- */
    const c = await s.context.newPage();
    await c.goto(s.base + 'css/app.css');
    const outcome = await c.evaluate(() => new Promise(res => {
      const r = indexedDB.open('setlist-stand', 3);
      r.onupgradeneeded = () => {};
      r.onblocked = () => res('blocked');
      r.onsuccess = () => { r.result.close(); res('opened'); };
      r.onerror = () => res('error');
    }));
    assert(outcome === 'opened', 'a newer version asking to upgrade was ' + outcome + ' by the open tab (it must let go)');
    await b.waitForSelector('[data-dbchanged]', {timeout: 5000}).catch(() => { throw new Error('the tab that let go does not tell the person to reload'); });
  } finally { await s.close(); }
}


/* A full tablet at the first start must not stop the app; a library made by a NEWER version is never read into memory. */
async function loopStartup(ctx){
  const lib = oldLibrary();
  /* ---- the upgrade write fails (a full tablet): the app still starts, shows the library, and writes on a later start ---- */
  let s = await ctx.session();
  try{
    const {page} = s;
    await s.context.addInitScript(() => {
      window.__failPuts = /index\.html$/.test(location.pathname) && !!sessionStorage.getItem('fail-puts');
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...a){ if(window.__failPuts && this.name === 'songs') throw new DOMException('full', 'QuotaExceededError'); return put.apply(this, a); };
    });
    await page.goto(s.base + 'css/app.css');
    await writeV1(page, lib);
    await page.evaluate(() => sessionStorage.setItem('fail-puts', '1'));
    await page.goto(s.base + 'index.html');
    await page.waitForSelector('#libList [data-open]', {timeout: 15000}).catch(() => { throw new Error('the app did not start when the upgrade write failed: ' + s.errors.join(' | ')); });
    assert(await page.locator('#libList [data-open]').count() === 1, 'the library is not listed when the upgrade write failed');
    assert((await normaliseSongs(page)).every(x => x.colls === undefined), 'the failed write changed a song record');
    await page.evaluate(() => sessionStorage.removeItem('fail-puts'));
    await page.reload(); await page.waitForSelector('#libList [data-open]');
    assert((await normaliseSongs(page)).every(x => Array.isArray(x.colls)), 'the next start did not finish the upgrade');
  } finally { await s.close(); }

  /* ---- a database at a higher version than this app knows: no memory fallback, a plain message, nothing changed ---- */
  s = await ctx.session();
  try{
    const {page} = s;
    await page.goto(s.base + 'css/app.css');
    await page.evaluate(() => new Promise((res, rej) => {
      const r = indexedDB.open('setlist-stand', 3);
      r.onupgradeneeded = () => { for(const n of ['songs', 'files', 'sets', 'ink', 'colls']) r.result.createObjectStore(n); r.transaction.objectStore('songs').put({id: 'n1', title: 'Newer', song: 'Newer', artist: '', version: '', archived: false, pages: 1, added: 1, updated: 1}, 'n1'); };
      r.onsuccess = () => { r.result.close(); res(); }; r.onerror = () => rej(r.error);
    }));
    await page.goto(s.base + 'index.html', {waitUntil: 'domcontentloaded'});
    await page.waitForSelector('#warn .warn', {timeout: 10000});
    const msg = await page.locator('#warn').innerText();
    assert(/newer version of Setlist Stand/.test(msg) && !/blocked on-device storage/.test(msg), 'the message for a newer library: ' + msg);
    assert(await page.locator('[data-add]').count() === 0, 'the app drew a library over a database it cannot open');
    const info = await dbInfo(page);
    assert(info.version === 3, 'the newer database was changed: ' + JSON.stringify(info));
    assert(/BREAK-GLASS/.test(msg), 'the message does not point at BREAK-GLASS: ' + msg);
    /* nothing works until the library is read: a tab tap draws no empty library, a picked file is turned away and writes nothing */
    await page.click('#tLib');
    await page.setInputFiles('#file', path.join(FIX, 'one-page.pdf'));
    await page.waitForTimeout(500);
    assert(await page.locator('#view').innerText() === '', 'the screen drew something over a library it cannot open: ' + await page.locator('#view').innerText());
    assert((await dbInfo(page)).version === 3 && (await idbAll(page, 'files') && Object.keys(await idbAll(page, 'files')).length === 0), 'a file picked while the library could not be opened was written');
  } finally { await s.close(); }

  /* ---- the upgrade itself fails (a full tablet cannot make the new store): the real library stays on disk, no memory fallback ---- */
  s = await ctx.session();
  try{
    const {page} = s;
    await s.context.addInitScript(() => {
      const make = IDBDatabase.prototype.createObjectStore;
      IDBDatabase.prototype.createObjectStore = function(...a){ if(/index\.html$/.test(location.pathname) && sessionStorage.getItem('fail-create')) throw new DOMException('full', 'QuotaExceededError'); return make.apply(this, a); };
    });
    await page.goto(s.base + 'css/app.css');
    await writeV1(page, lib);
    await page.evaluate(() => sessionStorage.setItem('fail-create', '1'));
    await page.goto(s.base + 'index.html', {waitUntil: 'domcontentloaded'});
    await page.waitForSelector('#warn .warn', {timeout: 10000});
    const msg = await page.locator('#warn').innerText();
    assert(!/blocked on-device storage/.test(msg) && /Nothing was changed/.test(msg), 'a failed upgrade is shown as: ' + msg);
    assert(await page.locator('[data-add]').count() === 0, 'the app drew a library after the upgrade failed');
    await page.evaluate(() => sessionStorage.removeItem('fail-create'));
    await page.reload(); await page.waitForSelector('#libList [data-open]', {timeout: 15000});
    assert(await page.locator('#libList [data-open]').count() === 1, 'the library is not there after space was freed');
  } finally { await s.close(); }

  /* ---- ids in `colls` are held to the plain set backup.js allows ---- */
  s = await ctx.session();
  try{
    await s.goto();
    const got = await s.page.evaluate(async () => { const st = await import('./js/store.js'); return st.cleanColls(['ok', 'ok', 'a b', 'x'.repeat(65), 5, '', null, '<b>', 'fine-2']); });
    assert(JSON.stringify(got) === '["ok","fine-2"]', 'cleanColls: ' + JSON.stringify(got));
  } finally { await s.close(); }
}
const normaliseSongs = async page => Object.values(await idbAll(page, 'songs')).filter(x => !x.deleted);

/* The in-memory fallback (storage blocked) has the collections store too; and a default that points at a deleted collection counts as none. */
async function loopMemoryAndStaleDefault(ctx){
  let s = await ctx.session();
  try{
    const {page} = s;
    await page.addInitScript(() => { indexedDB.open = function(){ const r = {}; setTimeout(() => { r.error = new DOMException('blocked', 'SecurityError'); if(r.onerror) r.onerror({target: r}); }, 0); return r; }; });
    await page.goto(s.base + 'index.html');
    await page.waitForSelector('#libList');
    assert(/blocked on-device storage/.test(await page.locator('#warn').innerText()), 'the blocked-storage warning is missing');
    await page.setInputFiles('#file', path.join(FIX, 'one-page.pdf'));
    await page.waitForSelector('#libList [data-open]', {timeout: 15000});
    await page.click('#view [data-collmanage]');
    await page.click('.collmgr [data-newcoll]');
    await page.locator('.collname input').fill('Memory Band');
    await page.click('.collname [data-ok]');
    await page.locator('.collmgr .mname', {hasText: 'Memory Band'}).waitFor({timeout: 5000});
    await page.click('.collmgr [data-x]');
    await songActIn(page, page.locator('#libList li.row').first(), 'edit');
    await page.locator('.modal fieldset.checks label', {hasText: 'Memory Band'}).locator('input').check();
    await page.click('.modal [data-ok]');
    await page.waitForFunction(() => !document.querySelector('.modal'));
    await page.click('.collbar [data-collpick]:not([data-collpick="all"])');
    assert(await page.locator('#libList [data-open]').count() === 1, 'the collection made in memory does not hold the song');
    assert(!s.errors.length, 'page errors in memory mode: ' + s.errors.join(' | '));
  } finally { await s.close(); }

  s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await putColls(page, [['clive', 'Live Band']]);
    await page.evaluate(async () => { const st = await import('./js/store.js'); await st.putAll([{store: 'colls', key: 'cdead', value: {id: 'cdead', deleted: true, updated: 5}}]); localStorage.setItem('ss-default-coll', 'cdead'); });
    await page.reload(); await page.waitForSelector('.collbar [data-collpick]');
    assert(await page.locator('.collbar [data-collpick="all"]').getAttribute('aria-pressed') === 'true', 'the app opened on a default that no longer exists');
    assert(!/\(default\)/.test((await page.locator('.collbar').innerText())), 'a default that was deleted is still marked: ' + await page.locator('.collbar').innerText());
    await page.setInputFiles('#file', path.join(FIX, 'one-page.pdf'));
    await page.waitForSelector('#libList [data-open]', {timeout: 15000});
    const rec = Object.values(await idbAll(page, 'songs'))[0];
    assert(JSON.stringify(rec.colls) === '[]', 'a new song joined a default that no longer exists: ' + JSON.stringify(rec.colls));
  } finally { await s.close(); }
}

async function chooseColl(page, id){
  await page.click('#tLib');
  await page.click(`.collbar [data-collpick="${id}"]`);
}
async function importPackage(page, file){
  await page.click('#tLib');
  await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
  await page.setInputFiles('#shareFile', file);
  const dlg = page.locator('.modal [role=dialog]', {hasText: 'Import share package'});
  await dlg.waitFor({timeout: 30000});
  await page.click('.modal [data-ok]');
  await page.waitForFunction(() => /^Added/.test(document.querySelector('#toast').textContent), null, {timeout: 20000});
}
const putColls = (page, list) => page.evaluate(async list => {
  const st = await import('./js/store.js'), t = Date.now();
  await st.putAll(list.map(([id, name]) => ({store: 'colls', key: id, value: {id, name, created: t, updated: t}})));
  await st.load();
}, list);

async function loopShare(ctx){
  /* ---- library A: collections everywhere; its package must hold none of it ---- */
  let setFile, aBefore;
  const sa = await ctx.session();
  try{
    const {page} = sa;
    await sa.goto(); await importFixtures(page); await buildLibrary(page);
    await putColls(page, [['ca', 'A Band'], ['cb', 'Other Band']]);
    await page.evaluate(async () => {
      const st = await import('./js/store.js');
      for(const s of st.state.songs){ s.colls = ['ca', 'cb']; await st.saveSong(s); }
      for(const x of st.state.sets){ x.colls = ['ca']; await st.saveSet(x); }
      await st.load();
    });
    await page.reload(); await page.waitForSelector('#libList [data-open]');
    aBefore = normalise(await snapshot(page));
    assert(Object.values(aBefore.songs).filter(x => !x.deleted).every(x => x.colls.length === 2), 'the test library does not have its collections');
    await page.click('#tSets'); await page.click('#view [data-set]'); await page.waitForSelector('#view [data-setmenu]');
    const dl = await download(page, () => openSetMenu(page, 'share'));
    await closeDone(page);
    setFile = dl.file;
    const pk = await readPackage(setFile);
    assert(!/colls|A Band|Other Band|"ca"|"cb"/.test(pk.text), 'collection data in share.json: ' + pk.text.slice(0, 300));
    assert(JSON.stringify(Object.keys(pk.share).sort()) === JSON.stringify(['app', 'kind', 'saved', 'setlist', 'songs', 'version']) && pk.share.version === 1, 'share.json keys/version: ' + Object.keys(pk.share) + ' ' + pk.share.version);
    for(const ps of pk.share.songs) assert(Object.keys(ps).every(k => ['id', 'song', 'artist', 'version', 'pages', 'hash', 'crop'].includes(k)), 'a package song carries ' + Object.keys(ps));
    assert(Object.keys(pk.share.setlist).sort().join() === 'items,name', 'the package setlist carries ' + Object.keys(pk.share.setlist));
    const d = diff(aBefore, normalise(await snapshot(page)));
    assert(!d.length, 'sharing changed the library: ' + d.join(' | '));
  } finally { await sa.close(); }

  /* ---- library B: has one-page (the package's first song) in its own collection X; Y is shown while the package is imported ---- */
  const sb = await ctx.session();
  try{
    const {page} = sb;
    await sb.goto();
    await page.setInputFiles('#file', path.join(FIX, 'one-page.pdf'));
    await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 1, null, {timeout: 20000});
    await putColls(page, [['cx', 'Receiver X'], ['cy', 'Receiver Y']]);
    const mine = (await songsOf(page))[0];
    await page.evaluate(async () => { const st = await import('./js/store.js'); const s = st.state.songs[0]; s.colls = ['cx']; await st.saveSong(s); await st.load(); });
    await page.reload(); await page.waitForSelector('.collbar [data-collpick]');
    const before = normalise(await snapshot(page));
    await chooseColl(page, 'cy');
    await importPackage(page, setFile);
    const A = normalise(await snapshot(page));
    const live = Object.values(A.songs).filter(x => !x.deleted), fresh = live.filter(x => x.id !== mine.id);
    assert(fresh.length === 2 && fresh.every(x => JSON.stringify(x.colls) === '["cy"]'), 'new songs are not in the shown collection: ' + JSON.stringify(fresh.map(x => [x.title, x.colls])));
    const d = diff(before.songs[mine.id], A.songs[mine.id]);
    assert(!d.length && JSON.stringify(A.songs[mine.id].colls) === '["cx"]', 'a song the library already had changed (collections included): ' + d.join(' | '));
    const sets = Object.values(A.sets).filter(x => !x.deleted);
    assert(sets.length === 1 && JSON.stringify(sets[0].colls) === '["cy"]', 'the imported setlist is not in the shown collection: ' + JSON.stringify(sets.map(x => [x.name, x.colls])));
    assert(JSON.stringify(Object.keys(A.colls).sort()) === '["cx","cy"]', 'importing made collections: ' + Object.keys(A.colls));
    assert(!sb.errors.length, 'page errors: ' + sb.errors.join(' | '));
  } finally { await sb.close(); }

  /* ---- library C: empty, the default collection is Z and All is shown: what is imported joins the default ---- */
  const sc = await ctx.session();
  try{
    const {page} = sc;
    await sc.goto();
    await putColls(page, [['cz', 'Receiver Z']]);
    await page.evaluate(() => localStorage.setItem('ss-default-coll', 'cz'));
    await page.reload(); await page.waitForSelector('.collbar [data-collpick]');
    assert(await page.locator('.collbar [data-collpick="cz"]').getAttribute('aria-pressed') === 'true', 'the app did not open on the default collection');
    await chooseColl(page, 'all');
    assert(await page.locator('.collbar [data-collpick="all"]').getAttribute('aria-pressed') === 'true', 'All is not shown');
    await importPackage(page, setFile);
    const A = normalise(await snapshot(page));
    const live = Object.values(A.songs).filter(x => !x.deleted), sets = Object.values(A.sets).filter(x => !x.deleted);
    assert(live.length === 3 && live.every(x => JSON.stringify(x.colls) === '["cz"]'), 'imported songs are not in the default collection: ' + JSON.stringify(live.map(x => [x.title, x.colls])));
    assert(sets.length === 1 && JSON.stringify(sets[0].colls) === '["cz"]', 'the imported setlist is not in the default collection: ' + JSON.stringify(sets.map(x => [x.name, x.colls])));
    assert(!sc.errors.length, 'page errors: ' + sc.errors.join(' | '));
  } finally { await sc.close(); }
}

export const loops = [
  {name: 'collections 1: a version 1 database upgrades with every record, PDF and mark unchanged but `colls: []`, and a second load changes nothing', run: loopUpgrade},
  {name: 'collections 2: a tab on the old app blocks the upgrade, the page says so and goes on when it lets go; this version lets go when a newer one asks', run: loopBlocked},
  {name: 'collections 3: a failed upgrade write does not stop the app, a newer database is never read into memory, and colls ids stay plain', run: loopStartup},
  {name: 'collections 4: the in-memory fallback has the collections store, and a default that points at a deleted collection counts as none', run: loopMemoryAndStaleDefault},
  {name: 'share 6: a package holds no collection; an import joins the shown (or default) collection and leaves a matched song as it was', run: loopShare},
];

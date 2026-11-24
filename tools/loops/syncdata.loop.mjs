/*
 * Sync data layer (Drive sync Part 2): what a sync will rely on in js/store.js and js/backup.js. Nothing is mocked: the real
 * screens make the edits, and what they stored is read back from IndexedDB.
 *
 * sync 0a  every edit of an existing record beats the version it was made from, even one stamped a YEAR ahead (a copy from a
 *          tablet whose clock is wrong): each record's `updated` is pushed a year into the future directly in IndexedDB, then
 *          each edit is made through the screens (setlist rename, items, collections of a setlist, archive and unarchive,
 *          details, crop, New version, collection rename, add songs to a collection, delete a collection with songs and
 *          setlists in it, delete a setlist, delete a song that is in a setlist). Each new `updated` must be later than the
 *          one before it and no later than stamp() allows (one millisecond after it, or now). New records get about now.
 * sync 0b  putAll with `ifUpdated`: a matching check writes everything; a check that no longer matches (another tab wrote in
 *          between) writes NOTHING in any store, for a save and for a delete, and rejects with name 'StaleWrite'; null means
 *          "not there"; the next plain putAll still works. Both on IndexedDB and in the in-memory fallback.
 * sync 0c  songProblem / setProblem / collProblem accept good records (unknown fields too) and refuse bad ones with the SAME
 *          message validateBackup gave before they were split out; the same bad record inside a backup zip is refused by
 *          Restore with that message, and the library is left as it was.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import {FIX, TMP, JSZip, assert, idbAll, snapshot, diff, openSetMenu} from './harness.mjs';
import {songAct, songActIn, songDelete, answerDelete} from './songrow.mjs';
import {setDelete} from './setrow.mjs';

const YEAR = 365 * 864e5;
const H64 = 'ab'.repeat(32);
const noModal = page => page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000});
const clearToast = page => page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
async function waitToast(page, re, ms = 20000){
  await page.waitForFunction(src => new RegExp(src).test(document.querySelector('#toast').textContent), re.source, {timeout: ms})
    .catch(async () => { throw new Error(`toast ${re} did not show; toast is "${await page.locator('#toast').textContent()}"`); });
  return page.locator('#toast').textContent();
}
/* Runs fn(S, arg) in the page with S = the app's own store.js (the same module instance the app uses). */
const inStore = (page, fn, arg) => page.evaluate(`(async () => {
  const S = await import(new URL('js/store.js', location.href).href);
  return (${fn.toString()})(S, ${JSON.stringify(arg === undefined ? null : arg)});
})()`);
const rec = async (page, store, id) => (await idbAll(page, store))[id];

/* ---------- sync 0a ---------- */
/* Every song, setlist and collection: `updated` set to a year from now (each a little apart), written straight into IndexedDB. */
const pushToFuture = page => page.evaluate(year => new Promise((res, rej) => {
  const r = indexedDB.open('setlist-stand');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => {
    const d = r.result, t = d.transaction(['songs', 'sets', 'colls'], 'readwrite'), base = Date.now() + year;
    let i = 0;
    for(const n of ['songs', 'sets', 'colls']){
      const st = t.objectStore(n), c = st.openCursor();
      c.onsuccess = () => { const k = c.result; if(k){ st.put({...k.value, updated: base + 1000 * ++i}, k.key); k.continue(); } };
    }
    t.oncomplete = () => { d.close(); res(); };
    t.onerror = () => rej(t.error);
  };
}), YEAR);

async function loopStamps(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    /* ---- brand-new records get about now ---- */
    const t0 = Date.now();
    await page.setInputFiles('#file', ['one-page.pdf', 'two-page.pdf', 'three-page.pdf'].map(f => path.join(FIX, f)));
    await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 3, null, {timeout: 20000});
    await page.click('#tSets');
    for(const name of ['Gig', 'Second', 'Spare']){
      await page.click('#view [data-newset]');
      await page.locator('.modal input[type=text]').fill(name);
      await new Promise(r => setTimeout(r, 450));        // New setlist ignores a second tap within 400 ms of the last one (js/saving.js once()): a person cannot tap that fast
      await page.click('.modal [data-ok]'); await noModal(page);
      await page.click('#view [data-allsets]').catch(() => {});
      await page.click('#tSets');
    }
    await page.click('#tLib');
    await page.click('#view [data-collmanage]');
    for(const name of ['Keep Band', 'Gone Band']){
      await page.click('.collmgr [data-newcoll]');
      await page.locator('.collname input').fill(name);
      await page.click('.collname [data-ok]');
      await page.locator('.collmgr .mname', {hasText: name}).waitFor({timeout: 5000});
    }
    await page.click('.collmgr [data-x]'); await noModal(page);
    const t1 = Date.now();
    const songs = Object.values(await idbAll(page, 'songs')), sets = Object.values(await idbAll(page, 'sets')), colls = Object.values(await idbAll(page, 'colls'));
    assert(songs.length === 3 && sets.length === 3 && colls.length === 2, `made ${songs.length} songs, ${sets.length} setlists, ${colls.length} collections`);
    for(const r of [...songs, ...sets, ...colls]) assert(r.updated >= t0 - 1000 && r.updated <= t1 + 1000, `a new record ${r.id} (${r.name || r.title}) has updated ${r.updated}, not about now (${t0}..${t1})`);
    const by = t => songs.find(x => x.title.toLowerCase().startsWith(t)), setBy = n => sets.find(x => x.name === n), collBy = n => colls.find(x => x.name === n);
    const A = by('one-page'), B = by('two-page'), C = by('three-page'), S1 = setBy('Gig'), S2 = setBy('Second'), S3 = setBy('Spare'), K1 = collBy('Keep Band'), K2 = collBy('Gone Band');
    /* the setlists' songs and the collection to delete hold records (written with the app's own save, before the clocks jump) */
    await inStore(page, async (S, ids) => {
      const st = S.state, one = id => st.sets.find(x => x.id === id), song = id => st.songs.find(x => x.id === id);
      Object.assign(one(ids.S1), {items: [{type: 'song', id: ids.A}, {type: 'song', id: ids.B}], colls: [ids.K2]});
      Object.assign(one(ids.S2), {items: [{type: 'song', id: ids.C}, {type: 'song', id: ids.A}], colls: [ids.K2]});
      for(const id of [ids.S1, ids.S2]) await S.saveSet(one(id));
      for(const id of [ids.A, ids.B]){ song(id).colls = [ids.K2]; await S.saveSong(song(id)); }
      await S.load();
    }, {A: A.id, B: B.id, C: C.id, S1: S1.id, S2: S2.id, K2: K2.id});

    /* ---- every record a year ahead, then edits through the screens ---- */
    await pushToFuture(page);
    await page.reload(); await page.waitForSelector('#libList [data-open]');
    const checked = [];
    /* each edit: the `updated` of every record it changes, read just before and just after */
    async function edit(what, recs, act){
      const before = {};
      for(const [st, id] of recs) before[st + ':' + id] = (await rec(page, st, id)).updated;
      await act();
      for(const [st, id] of recs){
        const k = st + ':' + id, prev = before[k];
        let cur;
        for(let i = 0; i < 50; i++){ cur = await rec(page, st, id); if(cur && cur.updated !== prev) break; await new Promise(r => setTimeout(r, 100)); }
        const u = cur && cur.updated;
        assert(prev > Date.now() + YEAR / 2, `${what}: ${k} was not a year ahead before the edit (${prev})`);
        assert(typeof u === 'number' && u > prev, `${what}: ${k} has updated ${u}, not later than the ${prev} it was made from`);
        assert(u <= Math.max(prev + 1, Date.now()), `${what}: ${k} has updated ${u}, later than stamp() allows (${prev} + 1, or now)`);
        checked.push(what + ' ' + k);
      }
    }
    const openSet = async id => { await page.click('#tSets'); await page.click(`#view [data-set="${id}"]`); await page.waitForSelector('#view [data-addto]'); };
    const ask = async v => { const i = page.locator('.modal input[type=text]'); await i.waitFor({timeout: 5000}); await i.fill(v); await page.click('.modal [data-ok]'); await noModal(page); };

    await edit('rename a setlist', [['sets', S1.id]], async () => { await openSet(S1.id); await openSetMenu(page, 'rename'); await ask('Gig renamed'); });
    await edit('add a break to a setlist', [['sets', S1.id]], async () => { await openSet(S1.id); await page.click('#view [data-addbreak]'); });
    await edit('remove a song from a setlist', [['sets', S2.id]], async () => { await openSet(S2.id); await page.click('#view [data-rm="1"]'); });
    await edit("a setlist's collections", [['sets', S3.id]], async () => {
      await openSet(S3.id); await openSetMenu(page, 'colls');
      await page.locator('.modal fieldset.checks label', {hasText: 'Keep Band'}).locator('input').check();
      await page.click('.modal [data-ok]'); await noModal(page);
    });
    await page.click('#tLib');
    await edit('edit details', [['songs', A.id]], async () => {
      await songAct(page, 'edit', A.id);
      await page.locator('.modal input[data-k=artist]').fill('Year Ahead');
      await page.click('.modal [data-ok]'); await noModal(page);
    });
    await edit('archive', [['songs', C.id]], () => songAct(page, 'archive', C.id));
    await edit('unarchive', [['songs', C.id]], async () => {
      await page.locator('#showArch').setChecked(true);
      await songAct(page, 'restore', C.id);
      await page.waitForFunction(id => { const b = document.querySelector(`#libList [data-songmenu="${id}"]`); return !b || !/ · Archived$/.test(b.closest('li').querySelector('.s').textContent); }, C.id, {timeout: 5000});
      await page.locator('#showArch').setChecked(false);
    });
    await edit('crop', [['songs', B.id]], async () => {
      await page.click(`#libList [data-open="${B.id}"]`);
      await page.waitForFunction(() => document.querySelector('#viewer').classList.contains('on') && !!document.querySelector('#stage .ink'), null, {timeout: 8000});
      await page.click('#vCrop');
      await page.waitForFunction(() => !document.querySelector('#cropper').hidden && /^Page 1 of/.test(document.querySelector('#cropHint').textContent), null, {timeout: 5000});
      await page.click('#cropSong');
      await page.waitForSelector('#cropper', {state: 'hidden', timeout: 5000});
      await page.click('#vBack');
      await page.waitForFunction(() => !document.querySelector('#viewer').classList.contains('on'), null, {timeout: 5000});
    });
    const known = new Set(Object.keys(await idbAll(page, 'songs')));
    const tNv = Date.now();
    await edit('New version', [['songs', C.id]], async () => {
      await page.click('#tLib'); await clearToast(page);
      await songAct(page, 'newversion', C.id);
      await page.setInputFiles('#newVersionFile', path.join(FIX, 'one-page.pdf'));
      await page.waitForFunction(() => !!document.querySelector('.dupask, .nvask'), null, {timeout: 15000});
      if(await page.locator('.dupask').count()) await page.click('.dupask [data-dupadd]');
      await page.locator('.nvask').waitFor({timeout: 5000});
      await page.click('.nvask [data-ok]');
      await waitToast(page, /^New version in place/);
    });
    const old = Object.values(await idbAll(page, 'songs')).find(x => !known.has(x.id));
    assert(old && old.updated >= tNv - 1000 && old.updated <= Date.now() + 1000, `New version: the old chart's new song has updated ${old && old.updated}, not about now`);
    const mgr = async () => { await page.click('#tLib'); await page.click('#view [data-collmanage]'); await page.locator('.collmgr').waitFor({timeout: 5000}); };
    await edit('rename a collection', [['colls', K1.id]], async () => {
      await mgr(); await page.click(`.collmgr [data-mren="${K1.id}"]`);
      await page.locator('.collname input').fill('Kept Band');
      await page.click('.collname [data-ok]');
      await page.locator('.collmgr .mname', {hasText: 'Kept Band'}).waitFor({timeout: 5000});
      await page.click('.collmgr [data-x]'); await noModal(page);
    });
    await edit('add songs to a collection', [['songs', B.id], ['songs', C.id]], async () => {
      await mgr(); await page.click(`.collmgr [data-madd="${K1.id}"]`);
      await page.locator('.modal .pick').waitFor({timeout: 5000});
      for(const id of [B.id, C.id]) await page.check(`.modal .pick input[value="${id}"]`);
      await page.click('.modal .pick ~ .btns [data-ok]');
      await page.waitForFunction(() => !document.querySelector('.modal .pick'), null, {timeout: 5000});
      await page.click('.collmgr [data-x]'); await noModal(page);
    });
    await edit('delete a collection with songs and setlists in it', [['colls', K2.id], ['songs', A.id], ['songs', B.id], ['sets', S1.id], ['sets', S2.id]], async () => {
      await mgr();
      const b = page.locator(`.collmgr [data-mdel="${K2.id}"]`);
      await b.click(); await b.click();
      await page.waitForFunction(id => !document.querySelector(`.collmgr [data-mdel="${id}"]`), K2.id, {timeout: 5000});
      await page.click('.collmgr [data-x]'); await noModal(page);
    });
    const k2 = await rec(page, 'colls', K2.id);
    assert(k2.deleted === true, 'the deleted collection is not a marker: ' + JSON.stringify(k2));
    await edit('delete a setlist', [['sets', S3.id]], async () => {
      await page.click('#tSets');
      await setDelete(page, S3.id);
      await page.waitForFunction(id => !document.querySelector(`#view [data-set="${id}"]`), S3.id, {timeout: 5000});
    });
    assert((await rec(page, 'sets', S3.id)).deleted === true, 'the deleted setlist is not a marker');
    await edit('delete a song that is in a setlist', [['songs', A.id], ['sets', S1.id]], async () => {
      await page.click('#tLib');
      await songDelete(page, A.id);
      await page.waitForFunction(id => !document.querySelector(`#libList [data-open="${id}"]`), A.id, {timeout: 5000});
    });
    assert((await rec(page, 'songs', A.id)).deleted === true, 'the deleted song is not a marker');
    assert(!(await rec(page, 'sets', S1.id)).items.some(it => it.id === A.id), 'the deleted song is still in its setlist');
    /* the store functions themselves, on records that are NOT ahead: an edit is now, and never earlier than the record */
    const r = await inStore(page, async S => {
      const out = [], t = Date.now();
      const st = {id: 'stampnow', name: 'x', items: [], colls: [], created: t - 5000, updated: t - 5000};
      await S.saveSet(st); out.push(['saveSet', st.updated, t]);
      out.push(['stamp(null)', S.stamp(null), t], ['stamp(past)', S.stamp({updated: 1}), t], ['stamp(same ms)', S.stamp({updated: t + 50}), t + 51]);
      await S.markDeleted('sets', 'stampnow');
      out.push(['markDeleted', (await S.get('sets', 'stampnow')).updated, t]);
      return out;
    });
    for(const [what, u, want] of r) assert(u >= want && u <= Math.max(want, Date.now()) + 2000, `${what} gave ${u}, expected about ${want}`);
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
    assert(checked.length === 20, `checked ${checked.length} record edits, expected 20: ${checked.join('; ')}`);
  } finally { await s.close(); }
}

/* ---------- sync 0b ---------- */
/* In the page: every case of putAll with ifUpdated, read back with get(). Returns a list of problems (empty = fine). */
const ifUpdatedCases = async S => {
  const bad = [], get = (st, k) => S.get(st, k);
  const stale = async (what, ops) => {
    try{ await S.putAll(ops); bad.push(what + ': putAll went through'); }
    catch(e){ if(!e || e.name !== 'StaleWrite') bad.push(`${what}: rejected with ${e && e.name} ${e && e.message}, not StaleWrite`); }
  };
  const want = async (what, st, k, u) => { const r = await get(st, k); const got = r === undefined ? undefined : r.updated; if(got !== u) bad.push(`${what}: ${st} ${k} has updated ${got}, expected ${u}`); };
  await S.putAll([{store: 'songs', key: 'x1', value: {id: 'x1', song: 'X', pages: 1, updated: 100}}, {store: 'sets', key: 'y1', value: {id: 'y1', name: 'Y', items: [], updated: 200}},
    {store: 'colls', key: 'nou', value: {id: 'nou', name: 'no time'}}]);
  /* a matching check writes everything, across three stores; null = not there, or there with no `updated` */
  await S.putAll([{store: 'songs', key: 'x1', value: {id: 'x1', song: 'X', pages: 1, updated: 101}, ifUpdated: 100},
    {store: 'sets', key: 'y1', value: {id: 'y1', name: 'Y', items: [], updated: 201}, ifUpdated: 200},
    {store: 'colls', key: 'z1', value: {id: 'z1', name: 'Z', updated: 5}, ifUpdated: null},
    {store: 'colls', key: 'nou', value: {id: 'nou', name: 'now timed', updated: 6}, ifUpdated: null}]).catch(e => bad.push('a matching check was refused: ' + e.name + ' ' + e.message));
  await want('matching', 'songs', 'x1', 101); await want('matching', 'sets', 'y1', 201); await want('matching', 'colls', 'z1', 5); await want('matching (null, no updated)', 'colls', 'nou', 6);
  /* another tab writes x1 in between; this write was planned against 101: nothing of it lands, the set written BEFORE the check included */
  await S.putAll([{store: 'songs', key: 'x1', value: {id: 'x1', song: 'X other tab', pages: 1, updated: 150}}]);
  const n0 = S.newestChange();
  await stale('a stale save', [{store: 'sets', key: 'y1', value: {id: 'y1', name: 'Y', items: [], updated: 9e15}}, {store: 'colls', key: 'w1', value: {id: 'w1', name: 'W', updated: 9e15}},
    {store: 'songs', key: 'x1', value: {id: 'x1', song: 'X', pages: 1, updated: 9e15}, ifUpdated: 101}]);
  await want('after a stale save', 'songs', 'x1', 150); await want('after a stale save', 'sets', 'y1', 201); await want('after a stale save', 'colls', 'w1', undefined);
  if((await get('songs', 'x1')).song !== 'X other tab') bad.push("a stale save overwrote the other tab's record");
  if(S.newestChange() !== n0) bad.push(`a write that failed counted as a change (newestChange ${n0} -> ${S.newestChange()})`);
  /* a stale delete: the record stays, and so does everything else in the batch */
  await stale('a stale delete', [{store: 'sets', key: 'y1', value: {id: 'y1', name: 'Y', items: [], updated: 300}}, {store: 'colls', key: 'z1', delete: true, ifUpdated: 4}]);
  await want('after a stale delete', 'colls', 'z1', 5); await want('after a stale delete', 'sets', 'y1', 201);
  /* a stale check that comes FIRST, with writes after it */
  await stale('a stale check first', [{store: 'colls', key: 'z1', value: {id: 'z1', name: 'Z', updated: 7}, ifUpdated: 6}, {store: 'sets', key: 'y1', value: {id: 'y1', name: 'Y', items: [], updated: 301}}]);
  await want('after a stale check first', 'colls', 'z1', 5); await want('after a stale check first', 'sets', 'y1', 201);
  /* null means absent: a record that is there makes it stale */
  await stale('null over a record', [{store: 'songs', key: 'x1', value: {id: 'x1', song: 'X', pages: 1, updated: 151}, ifUpdated: null}]);
  await want('after null over a record', 'songs', 'x1', 150);
  /* a check on a record that is not there (a number expected) is stale too */
  await stale('a number over nothing', [{store: 'songs', key: 'nobody', value: {id: 'nobody', pages: 1, updated: 1}, ifUpdated: 1}]);
  await want('after a number over nothing', 'songs', 'nobody', undefined);
  /* a matching delete removes it; the failed transactions left nothing locked: plain putAll and put still work */
  await S.putAll([{store: 'colls', key: 'z1', delete: true, ifUpdated: 5}]).catch(e => bad.push('a matching delete was refused: ' + e.name));
  await want('after a matching delete', 'colls', 'z1', undefined);
  await S.putAll([{store: 'sets', key: 'y1', value: {id: 'y1', name: 'Y', items: [], updated: 400}}]).catch(e => bad.push('a plain putAll after the failures: ' + e.name + ' ' + e.message));
  await want('a plain putAll after the failures', 'sets', 'y1', 400);
  await S.put('songs', 'x2', {id: 'x2', pages: 1, updated: 1}).catch(e => bad.push('a put after the failures: ' + e.name));
  await want('a put after the failures', 'songs', 'x2', 1);
  return bad;
};
async function loopIfUpdated(ctx){
  let s = await ctx.session();
  try{
    await s.goto();
    const bad = await inStore(s.page, ifUpdatedCases);
    assert(!bad.length, 'IndexedDB:\n    ' + bad.join('\n    '));
    /* and a second reader (raw IndexedDB, a new connection) sees the same */
    const sets = await idbAll(s.page, 'sets'), colls = await idbAll(s.page, 'colls');
    assert(sets.y1.updated === 400 && !colls.w1 && !colls.z1, 'read back raw: ' + JSON.stringify({y1: sets.y1, w1: colls.w1, z1: colls.z1}));
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
  if(process.env.SS_BROWSER === 'webkit'){ console.log('    note: the in-memory half of sync 0b is not run in WebKit (the script that blocks the database does not take effect there); Chromium runs it'); return; }
  s = await ctx.session();
  try{
    const {page} = s;
    await page.addInitScript(() => { indexedDB.open = function(){ const r = {}; setTimeout(() => { r.error = new DOMException('blocked', 'SecurityError'); if(r.onerror) r.onerror({target: r}); }, 0); return r; }; });
    await page.goto(s.base + 'index.html');
    await page.waitForSelector('#libList');
    assert(await inStore(page, S => !!S.MEM), 'the in-memory fallback is not in use');
    const bad = await inStore(page, ifUpdatedCases);
    assert(!bad.length, 'in-memory fallback:\n    ' + bad.join('\n    '));
  } finally { await s.close(); }
}

/* ---------- sync 0c ---------- */
/* want: the message validateBackup gave for a backup holding just this record BEFORE the checks were split out (js/backup.js at
   298ab88), written out here so it stays the reference; null = accepted. */
const LONG = 'x'.repeat(2001);
const song = x => ({id: 's1', title: 'T', song: 'T', artist: '', version: '', archived: false, colls: [], pages: 2, hash: H64, added: 1, updated: 2, ...x});
const set = x => ({id: 'l1', name: 'Gig', items: [{type: 'song', id: 's1'}, {type: 'break', id: 'b1', name: 'Break'}], colls: [], created: 1, updated: 2, ...x});
const coll = x => ({id: 'c1', name: 'Band', created: 1, updated: 2, ...x});
export const CASES = [
  {kind: 'song', name: 'a full song with unknown fields', rec: song({future: {a: [1, 2]}, rating: 5})},
  {kind: 'song', name: 'an old song (title and pages only)', rec: {id: 's1', title: 'Old', pages: 1}},
  {kind: 'song', name: 'an upper-case hash', rec: song({hash: H64.toUpperCase()})},
  {kind: 'song', name: 'a song marker with an extra field', rec: {id: 's1', deleted: true, updated: 5, extra: 'x'}},
  {kind: 'song', name: 'a song marker with no time', rec: {id: 's1', deleted: true}},
  {kind: 'song', name: 'a song at the collection limit', rec: song({colls: Array.from({length: 1000}, (_, i) => 'c' + i)})},
  {kind: 'song', name: 'not a record', rec: 'song', want: 'a song that is not a record'},
  {kind: 'song', name: 'an array', rec: [], want: 'a song that is not a record'},
  {kind: 'song', name: 'an id with a space', rec: song({id: 'a b'}), want: 'a song id "a b"'},
  {kind: 'song', name: 'an id of 65 characters', rec: song({id: 'x'.repeat(65)}), want: 'a song id "' + 'x'.repeat(39)},
  {kind: 'song', name: 'a number id', rec: song({id: 5}), want: 'a song id "5"'},
  {kind: 'song', name: 'an HTML id', rec: song({id: '<b>'}), want: 'a song id "<b>"'},
  {kind: 'song', name: 'no id', rec: song({id: undefined}), want: 'a song id "undefined"'},
  {kind: 'song', name: 'no pages', rec: song({pages: 0}), want: 'song s1 has "0" pages'},
  {kind: 'song', name: 'pages as text', rec: song({pages: '2'}), want: 'song s1 has "2" pages'},
  {kind: 'song', name: 'too many pages', rec: song({pages: 5001}), want: 'song s1 has "5001" pages'},
  {kind: 'song', name: 'a huge title', rec: song({title: LONG}), want: 'song s1 has a title that is not short text'},
  {kind: 'song', name: 'an artist that is a number', rec: song({artist: 5}), want: 'song s1 has a artist that is not short text'},
  {kind: 'song', name: 'a version that is a list', rec: song({version: ['a']}), want: 'song s1 has a version that is not short text'},
  {kind: 'song', name: 'collections that are not a list', rec: song({colls: 'c1'}), want: 'song s1 has collections that are not a list'},
  {kind: 'song', name: 'too many collections', rec: song({colls: Array.from({length: 1001}, (_, i) => 'c' + i)}), want: 'song s1 is in more than 1000 collections'},
  {kind: 'song', name: 'a bad collection id', rec: song({colls: ['ok', 'no way']}), want: 'song s1 has a collection id "no way"'},
  {kind: 'song', name: 'a short hash', rec: song({hash: 'abc'}), want: 'song s1 has hash "abc"'},
  {kind: 'song', name: 'a hash that is a number', rec: song({hash: 12}), want: 'song s1 has hash "12"'},
  {kind: 'song', name: 'a marker without deleted:true', rec: {id: 's1', deleted: 'yes', updated: 5}, want: 'a deleted song marked "yes"'},
  {kind: 'song', name: 'a marker with a bad time', rec: {id: 's1', deleted: true, updated: 'soon'}, want: 'a deleted song with time "soon"'},
  {kind: 'song', name: 'a marker with a bad id', rec: {id: 'a/b', deleted: true, updated: 5}, want: 'a song id "a/b"'},
  {kind: 'song', name: 'a marker missing `deleted` (only id and time)', rec: {id: 's1', updated: 5}, want: 'song s1 has "undefined" pages'},
  {kind: 'set', name: 'a full setlist with unknown fields', rec: set({future: true, notes: {a: 1}})},
  {kind: 'set', name: 'an old setlist (songs:[ids])', rec: {id: 'l1', name: 'Old', songs: ['s1', 's2']}},
  {kind: 'set', name: 'a setlist with no items', rec: {id: 'l1', name: 'Empty'}},
  {kind: 'set', name: 'a setlist marker', rec: {id: 'l1', deleted: true, updated: 3, extra: 1}},
  {kind: 'set', name: 'a setlist marker with a bad time (allowed, as before)', rec: {id: 'l1', deleted: true, updated: 'x'}},
  {kind: 'set', name: 'not a record', rec: null, want: 'a setlist that is not a record'},
  {kind: 'set', name: 'a bad id', rec: set({id: 'l 1'}), want: 'a setlist id "l 1"'},
  {kind: 'set', name: 'no name', rec: set({name: undefined}), want: 'setlist l1 has a name that is not short text'},
  {kind: 'set', name: 'a huge name', rec: set({name: LONG}), want: 'setlist l1 has a name that is not short text'},
  {kind: 'set', name: 'too many collections', rec: set({colls: Array.from({length: 1001}, (_, i) => 'c' + i)}), want: 'setlist l1 is in more than 1000 collections'},
  {kind: 'set', name: 'items that are not a list', rec: set({items: {a: 1}}), want: 'setlist l1 has items that are not a list'},
  {kind: 'set', name: 'too many items', rec: set({items: Array.from({length: 20001}, () => ({type: 'song', id: 's1'}))}), want: 'setlist l1 has more than 20000 items'},
  {kind: 'set', name: 'an item that is null', rec: set({items: [{type: 'song', id: 's1'}, null]}), want: 'setlist l1 has an item that is not a record'},
  {kind: 'set', name: 'a song item with a bad id', rec: set({items: [{type: 'song', id: '../x'}]}), want: 'setlist l1 has a song id "../x"'},
  {kind: 'set', name: 'a break with a bad id', rec: set({items: [{type: 'break', id: 7, name: 'B'}]}), want: 'setlist l1 has a break id "7"'},
  {kind: 'set', name: 'a break with a number name', rec: set({items: [{type: 'break', id: 'b1', name: 3}]}), want: 'setlist l1 has a break name that is not short text'},
  {kind: 'set', name: 'an item of an unknown type', rec: set({items: [{type: 'video', id: 'v1'}]}), want: 'setlist l1 has an item of type "video"'},
  {kind: 'set', name: 'old songs that are not a list', rec: {id: 'l1', name: 'Old', songs: 's1'}, want: 'setlist l1 has songs that are not a list'},
  {kind: 'set', name: 'old songs with a bad id', rec: {id: 'l1', name: 'Old', songs: ['s1', 'bad id']}, want: 'setlist l1 has a song id "bad id"'},
  {kind: 'set', name: 'a marker without deleted:true', rec: {id: 'l1', deleted: 1, updated: 3}, want: 'a deleted setlist marked "1"'},
  {kind: 'coll', name: 'a collection with unknown fields', rec: coll({colour: 'red'})},
  {kind: 'coll', name: 'a collection marker', rec: {id: 'c1', deleted: true, updated: 9}},
  {kind: 'coll', name: 'not a record', rec: 4, want: 'a collection that is not a record'},
  {kind: 'coll', name: 'the id "all"', rec: coll({id: 'all'}), want: 'a collection id "all"'},
  {kind: 'coll', name: 'a marker with the id "all"', rec: {id: 'all', deleted: true, updated: 9}, want: 'a collection id "all"'},
  {kind: 'coll', name: 'a bad id', rec: coll({id: 'c:1'}), want: 'a collection id "c:1"'},
  {kind: 'coll', name: 'no name', rec: coll({name: null}), want: 'collection c1 has a name that is not short text'},
  {kind: 'coll', name: 'a huge name', rec: coll({name: LONG}), want: 'collection c1 has a name that is not short text'},
  {kind: 'coll', name: 'a marker without deleted:true', rec: {id: 'c1', deleted: 'true', updated: 9}, want: 'a deleted collection marked "true"'},
];
const wrap = c => ({app: 'setlist-stand', version: 3, saved: new Date().toISOString(), songs: c.kind === 'song' ? [c.rec] : [], sets: c.kind === 'set' ? [c.rec] : [], colls: c.kind === 'coll' ? [c.rec] : [], ink: {}});
async function loopValidators(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    /* the validators, and validateBackup on a backup of each record, in the page (the folder under test) */
    const got = await page.evaluate(async cases => {
      const B = await import(new URL('js/backup.js', location.href).href);
      const fn = {song: B.songProblem, set: B.setProblem, coll: B.collProblem};
      return cases.map(c => {
        const one = fn[c.kind](c.rec), lib = {app: 'setlist-stand', version: 3, songs: c.kind === 'song' ? [c.rec] : [], sets: c.kind === 'set' ? [c.rec] : [], colls: c.kind === 'coll' ? [c.rec] : [], ink: {}};
        return {one, all: B.validateBackup(lib)};
      });
    }, CASES);
    const bad = [];
    CASES.forEach((c, i) => {
      const want = c.want === undefined ? null : c.want;
      if(got[i].one !== want) bad.push(`${c.kind}Problem(${c.name}) = ${JSON.stringify(got[i].one)}, expected ${JSON.stringify(want)}`);
      if(got[i].all !== want) bad.push(`validateBackup(${c.name}) = ${JSON.stringify(got[i].all)}, expected ${JSON.stringify(want)}`);
    });
    assert(!bad.length, bad.length + ' validator result(s) wrong:\n    ' + bad.slice(0, 20).join('\n    '));
    /* the same bad records inside a backup zip: Restore refuses with that message and changes nothing */
    await page.setInputFiles('#file', path.join(FIX, 'one-page.pdf'));
    await page.waitForSelector('#libList [data-open]', {timeout: 15000});
    const before = await snapshot(page);
    let n = 0;
    for(const c of CASES.filter(x => x.want)){
      const z = new JSZip();
      z.file('library.json', JSON.stringify(wrap(c)));
      const f = path.join(TMP, `syncdata-${++n}.zip`);
      await fsp.writeFile(f, await z.generateAsync({type: 'nodebuffer'}));
      await page.click('#tLib'); await clearToast(page);
      await page.setInputFiles('#restoreFile', f);
      const msg = await waitToast(page, /\S/, 30000);
      const want = `That backup has something the app can't read (${c.want}). Nothing was changed.`;
      assert(msg === want, `Restore of a backup with ${c.kind} "${c.name}" says "${msg}", expected "${want}"`);
    }
    const d = diff(before, await snapshot(page));
    assert(!d.length, 'a refused restore changed the library:\n    ' + d.join('\n    '));
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'sync 0a: every edit of a song, setlist or collection beats its own previous `updated`, even one a year ahead; new records are now', run: loopStamps},
  {name: 'sync 0b: putAll with ifUpdated writes all or nothing across stores, rejects a stale save or delete as StaleWrite, on IndexedDB and in memory', run: loopIfUpdated},
  {name: 'sync 0c: songProblem / setProblem / collProblem accept good records (unknown fields too) and refuse bad ones with the messages Restore always gave', run: loopValidators},
];

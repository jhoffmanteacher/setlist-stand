/*
 * Restore over a library that is in use (js/backup.js restoreFrom, js/restoreplan.js, js/restoreask.js): the person is asked first, in
 * plain words, and every chart or mark the restore would otherwise lose is kept as an archived copy, a setlist changed here since the
 * backup as "<name> (before restore)"; still ONE write, all or nothing.
 * Closed loop: what the restore stored is read back from IndexedDB (every record, and the SHA-256 of every stored PDF computed from its
 * bytes) and compared with a model written HERE, by hand, from the backup file and the library as it was before (not by the app):
 * the backup's records exactly, plus exactly the copies the rules call for; then again after a reload, after Back up -> wipe ->
 * Restore, and after restoring the same backup a second time (no second copies). Cancel, Escape, Stop, a full tablet, a change made
 * meanwhile in a second tab, the size cap and a reload at any moment each leave the library exactly as it was, or whole.
 * The names start "roundtrip over" so `--only roundtrip` runs them too.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import {TMP, JSZip, PDFLib, PDFDocument, assert, sleep, sha256, idbAll, snapshot, normalise, diff, backupNow, wipe, restoreZip, answerRestore, closeRestored} from './harness.mjs';
import {songDelete} from './songrow.mjs';

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const title = (song, version, artist) => song + (version ? ` (${version})` : '') + (artist ? ' - ' + artist : '');
const STALE = 'Something on this tablet changed while the restore was waiting. Nothing was changed. Try the restore again.';
const FULL = 'The tablet is full. Free up some space, then try again. Nothing was changed.';

const clearToast = page => page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
async function waitToast(page, re, ms = 30000){
  await page.waitForFunction(src => new RegExp(src).test(document.querySelector('#toast').textContent), re.source, {timeout: ms})
    .catch(async () => { throw new Error(`toast ${re} did not show; toast is "${await page.locator('#toast').textContent()}"`); });
  return page.locator('#toast').textContent();
}
function expectSame(a, b, what){
  const d = diff(a, b, '', [], 20);
  assert(!d.length, `${what}: ${d.length} difference(s):\n    ` + d.join('\n    '));
}
const noModal = (page, what) => page.waitForFunction(() => !document.querySelector('.modal') && !document.body.classList.contains('busy'), null, {timeout: 8000})
  .catch(() => { throw new Error(what + ': a box is still open, or the page is still marked busy'); });
/* Runs fn(S, arg) in the page with S = the app's own store.js (same URL, so the same module instance the app uses). */
const inStore = (page, fn, arg) => page.evaluate(`(async () => {
  const S = await import(new URL('js/store.js', location.href).href);
  return (${fn.toString()})(S, ${JSON.stringify(arg === undefined ? null : arg)});
})()`);
const libJson = async f => JSON.parse(await (await JSZip.loadAsync(await fsp.readFile(f))).file('library.json').async('string'));

/* A PDF of `pages` pages with its own text (so its own bytes and hash). */
async function makePdf(label, pages){
  const d = await PDFDocument.create(), font = await d.embedFont(PDFLib.StandardFonts.Helvetica);
  for(let i = 1; i <= pages; i++) d.addPage([300, 400]).drawText(`${label} page ${i}`, {x: 20, y: 350, size: 16, font});
  return Buffer.from(await d.save());
}
const pen = (id, x, u = 1000) => ({id, t: 'pen', c: '#1a1a1a', w: .003, p: [[x, .2], [x + .1, .3], [x + .2, .25]], updated: u});
const note = (id, text, u = 1000) => ({id, t: 'text', x: .5, y: .6, text, size: .018, c: '#1f5fd6', updated: u});

/* A session whose puts can be made to fail (window.__fail = {store, key}: that record's put throws "disk full"), whose stored PDFs
   can be made unreadable (window.__failGet = [song ids]: reading that PDF from the files store throws, as a lost blob or Chrome's
   "Failed to read large IndexedDB value" does; window.__failBytes = [song ids]: the PDF read from the files store is a Blob whose
   bytes cannot be read, nor any slice of it, as Safari's NotReadableError after an update does; window.__failFull = [song ids]: its first
   byte reads but the whole file does not), and which notes whether the restore question ever appeared (window.__asked). */
async function session(ctx){
  const s = await ctx.session();
  await s.context.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(...a){
      const f = window.__fail;
      if(f && this.name === f.store && String(a[1]) === f.key) throw new DOMException('The disk is full (test)', 'QuotaExceededError');
      return put.apply(this, a);
    };
    const get = IDBObjectStore.prototype.get, bad = new WeakSet(), badFull = new WeakSet();
    IDBObjectStore.prototype.get = function(k){
      if(this.name === 'files' && (window.__failGet || []).includes(String(k))) throw new DOMException('Failed to read large IndexedDB value (test)', 'UnknownError');
      const req = get.call(this, k);
      if(this.name === 'files' && (window.__failBytes || []).includes(String(k))) req.addEventListener('success', () => { if(req.result) bad.add(req.result); });
      if(this.name === 'files' && (window.__failFull || []).includes(String(k))) req.addEventListener('success', () => { if(req.result) badFull.add(req.result); });
      return req;
    };
    const ab = Blob.prototype.arrayBuffer, slice = Blob.prototype.slice;
    Blob.prototype.slice = function(...a){ const r = slice.apply(this, a); if(bad.has(this)) bad.add(r); return r; };
    Blob.prototype.arrayBuffer = function(){
      if(bad.has(this) || badFull.has(this)) return Promise.reject(new DOMException('The file could not be read (test)', 'NotReadableError'));
      return ab.call(this);
    };
    window.__asked = 0;
    new MutationObserver(() => { if(document.querySelector('.modal.restoreask')) window.__asked++; }).observe(document, {childList: true, subtree: true});
  });
  await s.goto();
  return s;
}
async function pick(page, file){
  await page.click('#tLib');
  await clearToast(page);
  await page.setInputFiles('#restoreFile', file);
}

/* ---------- the model: what a restore of backup F over `before` must leave, written from the rules, not from the app ----------
   keep: tablet song ids whose chart and live marks must be kept as archived copies; keepSets: tablet setlist ids kept as
   "<name> (before restore)". The copies' own ids and times are read from `after` (they are new), everything else is predicted. */
function model(before, F, after, {keep = [], keepSets = [], heldBy = {}} = {}){
  const want = normalise(before), errs = [];
  for(const s of F.songs){
    for(const k of Object.keys(want.ink)) if(k.startsWith(s.id + ':')) delete want.ink[k];
    if(s.deleted){ delete want.files[s.id]; want.songs[s.id] = {id: s.id, deleted: true, updated: Number(s.updated) || 0}; continue; }
    want.songs[s.id] = s; want.files[s.id] = s.hash;
  }
  const liveF = new Set(F.songs.filter(s => !s.deleted).map(s => s.id));
  for(const [k, v] of Object.entries(F.ink || {})) if(liveF.has(k.split(':')[0])) want.ink[k] = v;
  for(const st of F.sets) want.sets[st.id] = st;
  for(const c of F.colls || []) want.colls[c.id] = c;
  const newSongs = Object.keys(after.songs).filter(k => !(k in want.songs)), newSets = Object.keys(after.sets).filter(k => !(k in want.sets));
  if(newSongs.length !== keep.length) errs.push(`${newSongs.length} new song record(s), expected ${keep.length} archived cop${keep.length == 1 ? 'y' : 'ies'}: ` + newSongs.map(k => after.songs[k].title).join(' | '));
  if(newSets.length !== keepSets.length) errs.push(`${newSets.length} new setlist(s), expected ${keepSets.length}: ` + newSets.map(k => after.sets[k].name).join(' | '));
  const used = new Set(), copyOf = {};
  for(const from of keep){
    const t = before.songs[from], id = newSongs.find(k => !used.has(k) && after.songs[k].hash === t.hash);
    if(!id){ errs.push(`no archived copy holding the chart of "${t.title}" (hash ${String(t.hash).slice(0, 12)})`); continue; }
    used.add(id); copyOf[from] = id;
    const got = after.songs[id], version = (t.version ? t.version + ', ' : '') + 'before restore ' + today();
    const w = {id, song: t.song, artist: t.artist, version, archived: true, colls: t.colls, pages: t.pages, hash: t.hash, added: got.added, updated: got.updated, title: title(t.song, version, t.artist)};
    if('crop' in t) w.crop = t.crop;
    if(!(got.added > 0 && got.updated === got.added)) errs.push(`copy of "${t.title}": added/updated ${got.added}/${got.updated}`);
    want.songs[id] = w; want.files[id] = before.files[from];
    for(const k of Object.keys(before.ink).filter(k => k.startsWith(from + ':'))){
      const live = before.ink[k].strokes.filter(x => !x.deleted), key = id + ':' + k.split(':')[1];
      if(!live.length) continue;
      const u = after.ink[key] && after.ink[key].updated;
      if(!(typeof u === 'number' && u >= Math.max(...live.map(x => x.updated)))) errs.push(`copy of "${t.title}": ink page ${key} updated ${u}`);
      want.ink[key] = {updated: u, strokes: live};
    }
  }
  for(const from of keepSets){
    const st = before.sets[from], name = st.name + ' (before restore)', id = newSets.find(k => after.sets[k].name === name);
    if(!id){ errs.push(`no setlist "${name}"`); continue; }
    const g = after.sets[id], oldIds = new Set(st.items.filter(it => it.type === 'break').map(it => it.id));
    want.sets[id] = {...st, id, name, created: g.created, updated: g.updated, kept: 'restore', items: st.items.map((it, i) => it.type === 'break' ? {...it, id: (g.items[i] || {}).id} : it.type === 'song' && copyOf[it.id] ? {...it, id: copyOf[it.id]} : it.type === 'song' && heldBy[it.id] ? {...it, id: heldBy[it.id]} : it)};
    if(!(g.created > 0 && g.updated === g.created)) errs.push(`"${name}": created/updated ${g.created}/${g.updated}`);
    for(const it of g.items) if(it.type === 'break' && (oldIds.has(it.id) || it.id in after.songs || it.id in after.sets)) errs.push(`"${name}": the break keeps an id in use: ${it.id}`);
  }
  /* an earlier kept copy ("(before restore)", kept:'restore') that stays is pointed in place at the new copies (or holders) */
  const inF = new Map(F.sets.map(x => [x.id, x]));
  for(const st of Object.values(before.sets)){
    if(st.deleted || st.kept !== 'restore') continue;
    const b = inF.get(st.id);
    if(b && !(b.deleted && st.updated > (Number(b.updated) || 0))) continue;
    const items = st.items.map(it => it.type === 'song' && (copyOf[it.id] || heldBy[it.id]) ? {...it, id: copyOf[it.id] || heldBy[it.id]} : it);
    if(JSON.stringify(items) === JSON.stringify(st.items)) continue;
    const g = after.sets[st.id];
    if(!(g && g.updated > st.updated)) errs.push(`the kept setlist "${st.name}" was not stamped when it was pointed at the new copies`);
    want.sets[st.id] = {...st, items, updated: g && g.updated};
  }
  return [...errs, ...diff(want, after, '', [], 30)];
}

/* ---------- a library written straight into the store, and its backup built here in Node (loops 2 to 5) ---------- */
let seedN = 0;
async function seedLibrary(page){
  const tag = 'o' + (++seedN) + Date.now().toString(36);
  const pdfs = {ra: await makePdf('Ra ' + tag, 1), rb: await makePdf('Rb ' + tag, 2), rc: await makePdf('Rc ' + tag, 1)};
  const t = 1700000000000, songs = Object.entries(pdfs).map(([id, buf], i) => ({id, title: 'Over ' + id, song: 'Over ' + id, artist: '', version: '', archived: false, colls: [], pages: id === 'rb' ? 2 : 1, hash: sha256(buf), added: t + i, updated: t + i}));
  const sets = [{id: 'rs', name: 'Gig', items: [{type: 'song', id: 'ra'}, {type: 'break', id: 'rbrk', name: 'Set 2'}, {type: 'song', id: 'rb'}, {type: 'song', id: 'rc'}], colls: [], created: t, updated: t}];
  const ink = {'ra:1': {updated: t, strokes: [pen('ka', .1, t)]}, 'rb:1': {updated: t, strokes: [pen('kb', .2, t)]}};
  const data = {app: 'setlist-stand', version: 3, saved: new Date(t + 5000).toISOString(), songs, sets, colls: [], ink};
  const z = new JSZip();
  for(const [id, buf] of Object.entries(pdfs)) z.file(`files/${id}.pdf`, buf);
  z.file('library.json', JSON.stringify(data));
  const file = path.join(TMP, `over-${tag}.zip`);
  await fsp.writeFile(file, await z.generateAsync({type: 'nodebuffer', compression: 'STORE'}));
  const b64 = Object.fromEntries(Object.entries(pdfs).map(([id, buf]) => [id, buf.toString('base64')]));
  await inStore(page, async (S, {data, b64}) => {
    const ops = [];
    for(const [id, b] of Object.entries(b64)) ops.push({store: 'files', key: id, value: new Blob([Uint8Array.from(atob(b), c => c.charCodeAt(0))], {type: 'application/pdf'})});
    for(const s of data.songs) ops.push({store: 'songs', key: s.id, value: s});
    for(const st of data.sets) ops.push({store: 'sets', key: st.id, value: st});
    for(const [k, v] of Object.entries(data.ink)) ops.push({store: 'ink', key: k, value: v});
    await S.putAll(ops);
  }, {data, b64});
  return {file, data, pdfs};
}
/* A backup zip built here from `data` (live songs' PDFs from `pdfs`) */
async function zipOf(data, pdfs, name){
  const z = new JSZip();
  for(const s of data.songs) if(!s.deleted) z.file(`files/${s.id}.pdf`, pdfs[s.id]);
  z.file('library.json', JSON.stringify(data));
  const f = path.join(TMP, name);
  await fsp.writeFile(f, await z.generateAsync({type: 'nodebuffer', compression: 'STORE'}));
  return f;
}
/* After the backup: a new mark on rb (page 1) and on rc, and the setlist renamed. A restore then keeps two charts and one setlist. */
async function changeLibrary(page){
  await inStore(page, async S => {
    await S.putInk('rb', 1, [...(await S.getInk('rb', 1)), {id: 'nb', t: 'pen', c: '#d62828', w: .003, p: [[.5, .5], [.6, .6]], updated: Date.now()}]);
    await S.putInk('rc', 1, [{id: 'nc', t: 'text', x: .3, y: .3, text: 'Capo 2', size: .018, c: '#1f5fd6', updated: Date.now()}]);
    const st = await S.get('sets', 'rs'); st.name = 'Gig changed here'; await S.saveSet(st);
  });
}
async function seeded(ctx){
  const s = await session(ctx);
  const b = await seedLibrary(s.page);
  await changeLibrary(s.page);
  await s.goto();
  return {s, ...b};
}
const KEEP2 = {keep: ['rb', 'rc'], keepSets: ['rs']};

/* ---------- loop 1 ---------- */
async function loopModel(ctx){
  const s = await session(ctx), page = s.page;
  try{
    /* the library, through the Add PDFs button; marks, a crop, a setlist with a break and a collection through the app's store */
    const files = {A: await makePdf('Over Alpha', 1), B: await makePdf('Over Bravo', 2), C: await makePdf('Over Charlie', 1), E: await makePdf('Over Echo', 1), A2: await makePdf('Over Alpha two', 2), D: await makePdf('Over Delta', 1)};
    const write = async (k, name) => { const f = path.join(TMP, name); await fsp.writeFile(f, files[k]); return f; };
    await page.setInputFiles('#file', [await write('A', 'Over Alpha.pdf'), await write('B', 'Over Bravo.pdf'), await write('C', 'Over Charlie.pdf'), await write('E', 'Over Echo.pdf')]);
    await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 4, null, {timeout: 20000});
    const byHash = async k => Object.values(await idbAll(page, 'songs')).find(x => !x.deleted && x.hash === sha256(files[k])).id;
    const [A, B, C, E] = [await byHash('A'), await byHash('B'), await byHash('C'), await byHash('E')];
    const CROP = {all: {x: .1, y: .05, w: .8, h: .7}, pages: {}}, CROP2 = {all: null, pages: {2: {x: .2, y: .2, w: .6, h: .5}}};
    await inStore(page, async (S, {A, B, C, E, CROP, m}) => {
      await S.putAll([{store: 'colls', key: 'oband', value: {id: 'oband', name: 'Over Band', created: 1, updated: 1}}]);
      const a = await S.get('songs', A); a.crop = CROP; a.colls = ['oband']; await S.saveSong(a);
      await S.putInk(A, 1, [m.a1, m.an]); await S.putInk(B, 1, [m.b1]); await S.putInk(C, 1, [m.c1]); await S.putInk(E, 1, [m.e1]);
      await S.saveSet({id: 'overset', name: 'Over Set', items: [{type: 'song', id: A}, {type: 'break', id: 'obrk', name: 'Set 2'}, {type: 'song', id: B}, {type: 'song', id: C}, {type: 'song', id: E}], colls: [], created: 1});
    }, {A, B, C, E, CROP, m: {a1: pen('a1', .1), an: note('an', 'Solo x2'), b1: pen('b1', .2), c1: pen('c1', .3), e1: pen('e1', .4)}});
    await s.goto();
    const F1file = (await backupNow(page)).file, F1 = await libJson(F1file);

    /* changed since the backup: New version of A (its old chart goes to Archived as "old"), a crop and a mark on the new chart,
       a mark on B, C's artist, D added, E deleted, the setlist reordered */
    await page.click(`#libList [data-songmenu="${A}"]`);
    await page.locator('.modal.menubox [data-item="newversion"]').click();
    await page.setInputFiles('#newVersionFile', await write('A2', 'Over Alpha two.pdf'));
    await page.locator('.modal.nvask [data-ok]').click();
    await waitToast(page, /^New version in place/);
    await inStore(page, async (S, {A, B, C, CROP2, m}) => {
      const a = await S.get('songs', A); a.crop = CROP2; await S.saveSong(a);
      await S.putInk(A, 2, [m.a2]);
      await S.putInk(B, 1, [...(await S.getInk(B, 1)), m.b2]);
      const c = await S.get('songs', C); c.artist = 'Someone Else'; await S.saveSong(c);
      const st = await S.get('sets', 'overset'); st.items = st.items.slice().reverse(); await S.saveSet(st);
    }, {A, B, C, CROP2, m: {a2: pen('a2', .5, Date.now()), b2: note('b2', 'Watch the ending', Date.now())}});
    await s.goto();
    await page.setInputFiles('#file', [await write('D', 'Over Delta.pdf')]);
    await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 5, null, {timeout: 20000});
    await songDelete(page, E);
    await page.waitForFunction(id => !document.querySelector(`#libList [data-open="${id}"]`), E, {timeout: 8000});
    const before = await snapshot(page);
    const oldA = Object.keys(before.songs).find(k => before.songs[k].archived && /old \d{4}/.test(before.songs[k].version || ''));
    assert(oldA && before.files[oldA] === sha256(files.A), 'New version did not leave the old chart of A in Archived');

    /* the question, read from the screen */
    await pick(page, F1file);
    const q = await answerRestore(page, 'ok');
    assert(q, 'no question before a restore over a library in use');
    const expectQ = [
      /^Restore this backup\?/,
      /This backup was made on \S.*\d{4}\./,
      /It brings back 1 song you deleted on this tablet\./,
      /It puts back the backup's version of 3 songs and 1 setlist\. 4 of them were changed on this tablet after the backup was made:/,
      /Over Alpha \(changed here later\)/, /Over Bravo \(changed here later\)/, /Over Charlie - Someone Else \(changed here later\)/, /Over Set \(changed here later\)/,
      new RegExp(`Charts and marks are kept: 2 charts from this tablet, with their marks, go to Archived as "\\(before restore ${today()}\\)"\\. A copy of 1 setlist is kept as "Over Set \\(before restore\\)"\\.`),
      /2 songs on this tablet are not in the backup\. They stay as they are\./];
    for(const re of expectQ) assert(re.test(q), `the question does not say ${re}:\n${q}`);
    for(const re of [/It adds/, /It deletes/, /Google Drive/, /no chart stored here/, /Nothing on this tablet is replaced/]) assert(!re.test(q), `the question says ${re} when it should not:\n${q}`);
    const msg = await waitToast(page, /^Restored|Nothing was changed/, 60000);
    assert(msg === 'Restored 4 songs and 1 setlist', 'restore toast: ' + JSON.stringify(msg));
    const kept = await closeRestored(page);
    assert(/2 charts from this tablet are in Archived, with their marks\./.test(kept || '') && /A copy of 1 setlist was kept: Over Set \(before restore\)\./.test(kept), 'the result box: ' + JSON.stringify(kept));
    await noModal(page, 'after the restore');
    const after = await snapshot(page);
    /* the model: F1 exactly, A2 and B (with its new mark) kept, C and E not (nothing of theirs was lost), D and A's "old" copy untouched */
    let d = model(before, F1, after, {keep: [A, B], keepSets: ['overset']});
    assert(!d.length, `the library after the restore differs from the model (${d.length}):\n    ` + d.slice(0, 20).join('\n    '));
    assert(after.songs[A].hash === sha256(files.A) && after.files[A] === sha256(files.A), 'A does not play its backup chart again');
    for(const k of [oldA, Object.keys(before.songs).find(k => before.songs[k].hash === sha256(files.D))]) expectSame(before.songs[k], after.songs[k], 'a song that is not in the backup');
    /* the copies' fresh ids may not collide with what the backup is about to write: the plan counts the backup's ids as taken */
    const taken = await page.evaluate(async () => { const m = await import(new URL('js/restoreplan.js', location.href).href);
      const p = await m.planRestore({songs: [{id: 'zzBackupSong', deleted: true, updated: 1}], sets: [{id: 'zzBackupSet', deleted: true, updated: 1}], colls: [{id: 'zzBackupColl', deleted: true, updated: 1}], ink: {}}, new Map());
      return ['zzBackupSong', 'zzBackupSet', 'zzBackupColl'].filter(id => p.taken.has(id)); });
    assert(taken.length === 3, 'the ids the backup writes are not counted as taken: only ' + JSON.stringify(taken));

    /* reload; Back up -> wipe -> Restore (an empty tablet: no question); the copies round trip */
    await s.goto();
    expectSame(after, await snapshot(page), 'after a reload (right) vs after the restore (left)');
    const F2file = (await backupNow(page)).file;
    await wipe(page); await s.goto();
    await restoreZip(page, F2file);
    assert(restoreZip.last.asked === null && restoreZip.last.kept === null, 'an empty tablet was asked, or kept something: ' + JSON.stringify(restoreZip.last));
    expectSame(after, await snapshot(page), 'after Back up -> wipe -> Restore (right) vs after the restore (left)');

    /* the same backup again: nothing is put back or kept, no second copies */
    await pick(page, F1file);
    const q2 = await answerRestore(page, 'ok');
    assert(/Nothing on this tablet is replaced\./.test(q2 || '') && /4 songs and 1 setlist on this tablet are not in the backup\. They stay as they are\./.test(q2), 'the second question:\n' + q2);
    for(const re of [/puts back/, /are kept/, /Archived/, /deletes/, /brings back/]) assert(!re.test(q2), `the second question says ${re}:\n${q2}`);
    assert(await waitToast(page, /^Restored|Nothing was changed/, 60000) === 'Restored 4 songs and 1 setlist', 'second restore toast');
    assert(await closeRestored(page) === null, 'the second restore of the same backup says it kept something');
    expectSame(after, await snapshot(page), 'after restoring the same backup again (right) vs after the first (left)');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- loop 2 ---------- */
async function loopNothing(ctx){
  const {s, file} = await seeded(ctx), page = s.page;
  try{
    const b0 = await snapshot(page);
    const unchanged = async what => { await noModal(page, what); expectSame(b0, await snapshot(page), what + ': the library before (left) and after (right)'); };
    /* Cancel (with Google Drive set up here: the question says what the next Sync does) */
    await page.evaluate(() => localStorage.setItem('ss-last-sync', String(Date.now() - 60000)));
    await pick(page, file);
    const q = await answerRestore(page, 'x');
    assert(/Google Drive: your next Sync brings back anything changed after this backup was made, on either tablet\./.test(q || ''), 'the question on a tablet that syncs:\n' + q);
    assert(await waitToast(page, /\S/) === 'Restore cancelled. Nothing was changed.', 'Cancel: ' + await page.locator('#toast').textContent());
    await unchanged('Cancel');
    await page.evaluate(() => localStorage.removeItem('ss-last-sync'));
    /* Escape */
    await pick(page, file);
    await page.locator('.modal.restoreask').waitFor({timeout: 60000});
    assert(!(await page.evaluate(() => /Google Drive/.test(document.querySelector('.modal.restoreask').innerText))), 'the Drive line on a tablet that never synced');
    await page.keyboard.press('Escape');
    assert(await waitToast(page, /\S/) === 'Restore cancelled. Nothing was changed.', 'Escape: ' + await page.locator('#toast').textContent());
    await unchanged('Escape');
    /* Stop while comparing, and while keeping chart 1 of 2 */
    for(const [line, ask] of [['Comparing with this tablet…', false], ['Keeping chart 1 of 2…', true]]){
      await page.evaluate(line => {
        window.__asked = 0;
        const o = new MutationObserver(() => { const p = document.querySelector('.modal p[role=status]'); if(p && p.textContent === line){ o.disconnect(); document.querySelector('.modal [data-x]').click(); } });
        o.observe(document.body, {childList: true, subtree: true, characterData: true});
      }, line);
      await pick(page, file);
      if(ask) assert(await answerRestore(page, 'ok'), 'no question before keeping');
      assert(await waitToast(page, /\S/, 60000) === 'Restore stopped. Nothing was changed.', `Stop on "${line}": ` + await page.locator('#toast').textContent());
      if(!ask) assert(await page.evaluate(() => window.__asked) === 0, 'Stop while comparing, yet the question came');
      await unchanged(`Stop on "${line}"`);
    }
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- loop 3 ---------- */
async function loopEmpty(ctx){
  for(const markers of [false, true]){
    const s = await session(ctx), page = s.page;
    try{
      /* a backup made in another library: seed one, back it up as built, then wipe it */
      const {file, data} = await seedLibrary(page);
      await wipe(page); await s.goto();
      if(markers) await inStore(page, S => S.putAll([{store: 'songs', key: 'zgone', value: {id: 'zgone', deleted: true, updated: 5}}, {store: 'sets', key: 'zset', value: {id: 'zset', deleted: true, updated: 5}}, {store: 'colls', key: 'zcoll', value: {id: 'zcoll', deleted: true, updated: 5}}]));
      const b0 = await snapshot(page);
      await page.evaluate(() => { window.__asked = 0; localStorage.removeItem('ss-last-backup'); });
      await pick(page, file);
      const msg = await waitToast(page, /^Restored|Nothing was changed|not a/, 60000);
      const what = markers ? 'a tablet holding only deletion markers' : 'an empty tablet';
      assert(msg === 'Restored 3 songs and 1 setlist', `${what}: toast ${JSON.stringify(msg)}`);
      assert(await page.evaluate(() => window.__asked) === 0, `${what} was asked before the restore (nothing on it can be lost)`);
      assert(await closeRestored(page) === null, `${what}: the restore says it kept something`);
      const d = model(b0, data, await snapshot(page));
      assert(!d.length, `${what}: the library differs from the backup:\n    ` + d.slice(0, 12).join('\n    '));
      assert(/^\d+$/.test(await page.evaluate(() => localStorage.getItem('ss-last-backup')) || ''), `${what}: a restore that kept nothing does not count as a backup`);
      assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
  }
}

/* ---------- loop 4 ---------- */
async function loopAllOrNothing(ctx){
  const {s, file, data} = await seeded(ctx), page = s.page;
  try{
    const b0 = await snapshot(page);
    /* (a) the tablet is full at the write (the setlist's put fails, after the copies' puts were queued): nothing, not even a copy */
    await page.evaluate(() => { window.__fail = {store: 'sets', key: 'rs'}; });
    await pick(page, file);
    assert(await answerRestore(page, 'ok'), '(a) no question');
    assert(await waitToast(page, /\S/, 60000) === FULL, '(a) full tablet: ' + await page.locator('#toast').textContent());
    await page.evaluate(() => { window.__fail = null; });
    await noModal(page, '(a)');
    expectSame(b0, await snapshot(page), '(a) a full tablet: the library before (left) and after (right)');

    /* (b) and (c): while the question is open a SECOND tab of the app draws on a page that was blank, or edits a song that the
       restore writes over (and keeps no copy of); Restore then refuses, and the change made meanwhile is still there */
    const p2 = await s.context.newPage();
    await p2.goto(s.base + 'index.html'); await p2.waitForSelector('#libList');
    /* an old page saved as a bare list (no `updated`) and a setlist saved with no `updated`: they are guarded too ("still none") */
    await inStore(page, async S => {
      const st = await S.get('sets', 'rs'); delete st.updated;
      await S.putAll([{store: 'ink', key: 'ra:1', value: [{t: 'pen', c: '#1a1a1a', w: .003, p: [[.3, .3], [.4, .4]]}]}, {store: 'sets', key: 'rs', value: st}]);
    });
    for(const [what, change] of [
      ['(c2) a stroke on an old page saved as a bare list', S => S.putInk('ra', 1, [{id: 'meanwhile2', t: 'pen', c: '#d62828', w: .003, p: [[.5, .5], [.6, .6]], updated: Date.now()}])],
      ['(c3) a rename of a setlist saved with no `updated`', async S => { const st = await S.get('sets', 'rs'); st.name = 'Renamed meanwhile'; await S.saveSet(st); }],
      ['(b) a stroke on a blank page', S => S.putInk('rb', 2, [{id: 'meanwhile', t: 'pen', c: '#1a1a1a', w: .003, p: [[.1, .1], [.2, .2]], updated: Date.now()}])],
      ['(c) an edit of a song the backup has unchanged', async S => { const a = await S.get('songs', 'ra'); a.artist = 'Edited meanwhile'; await S.saveSong(a); }]]){
      await pick(page, file);
      await page.locator('.modal.restoreask').waitFor({timeout: 60000});
      await inStore(p2, change);
      const mid = await snapshot(page);
      assert(diff(b0, mid).length, what + ': the second tab changed nothing (test setup)');
      await page.click('.modal.restoreask [data-ok]');
      assert(await waitToast(page, /\S/, 60000) === STALE, what + ': ' + await page.locator('#toast').textContent());
      await noModal(page, what);
      expectSame(mid, await snapshot(page), what + ': the library with the change (left) and after the refused restore (right)');
    }
    await p2.close();
    const b1 = await snapshot(page);
    /* (d) more charts to keep than the cap: no dead end. The question says so and offers "Restore without keeping copies" beside
       Cancel instead of Restore; it is never the default (Enter does nothing); chosen, the backup is restored and nothing is copied */
    await page.evaluate(async () => { (await import(new URL('js/restoreplan.js', location.href).href)).keepLimits.maxBytes = 1000; });
    await pick(page, file);
    const box = page.locator('.modal.restoreask');
    await box.waitFor({timeout: 60000});
    const q = (await box.locator('.box').innerText()).replace(/\s+/g, ' ');
    assert(/The \d+ charts this restore replaces \(about \d+ KB\) are too big to keep as copies on this tablet\. If you restore, they and their marks are gone, and no setlist copy is kept\. To keep them, Cancel and back up first\./.test(q), '(d) the question: ' + q);
    assert(!/are kept:/.test(q), '(d) the question still says the charts are kept: ' + q);
    assert(!(await box.locator('[data-ok]').count()) && await box.locator('[data-nokeep]').textContent() === 'Restore without keeping copies' && !(await box.locator('[data-nokeep]').evaluate(b => b.classList.contains('pri'))), '(d) the buttons: ' + await box.locator('.btns').innerText());
    const nk = box.locator('[data-nokeep]');
    await sleep(600); await page.keyboard.press('Enter'); await sleep(600);
    assert(await box.count() === 1 && await nk.textContent() === 'Restore without keeping copies', '(d) Enter chose or armed "Restore without keeping copies"');
    /* it throws charts and marks away: two taps. The first arms it; Enter then does nothing; the second restores */
    await nk.click(); await sleep(300);
    assert(await box.count() === 1 && await nk.textContent() === 'Tap again: charts are not kept', '(d) one tap on "Restore without keeping copies" did not just arm it: ' + (await box.count() ? await nk.textContent() : 'the box is gone'));
    await page.keyboard.press('Enter'); await sleep(600);
    assert(await box.count() === 1, '(d) Enter after the first tap restored without keeping copies');
    await nk.click();
    assert(/^Restored 3 songs and 1 setlist$/.test(await waitToast(page, /^Restored|Nothing was changed/, 60000)), '(d): ' + await page.locator('#toast').textContent());
    assert(await closeRestored(page) === null, '(d) a restore without copies says it kept something');
    await page.evaluate(async () => { (await import(new URL('js/restoreplan.js', location.href).href)).keepLimits.maxBytes = 300e6; });
    const dd = model(b1, data, await snapshot(page));
    assert(!dd.length, '(d) restore without keeping copies: the library is not the backup with nothing kept:\n    ' + dd.slice(0, 12).join('\n    '));
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- loop 5 ---------- */
async function loopReload(ctx){
  const outcomes = [];
  for(const delay of [0, 5, 15, 30, 100, 600]){
    const {s, file, data} = await seeded(ctx), page = s.page;
    try{
      const b0 = await snapshot(page);
      await pick(page, file);
      assert(await answerRestore(page, 'ok'), 'no question');
      await sleep(delay);
      await page.reload({waitUntil: 'load', timeout: 120000}).catch(() => {});
      await page.waitForSelector('#libList, #view', {timeout: 60000});
      await sleep(1000);
      const B = await snapshot(page);
      const same = !diff(b0, B).length, d = model(b0, data, B, KEEP2), done = !d.length;
      outcomes.push(`${delay}ms: ${same ? 'before' : done ? 'after' : 'PARTIAL'}`);
      assert(same || done, `a reload ${delay}ms after Restore left a library that is neither the one before nor the whole restore with its copies:\n    ` + d.slice(0, 12).join('\n    '));
      const errs = process.env.SS_BROWSER === 'webkit' ? s.errors.filter(e => !/due to access control checks/i.test(e)) : s.errors;
      assert(!errs.length, 'page errors: ' + errs.join(' | '));
    } finally { await s.close(); }
  }
  /* and the same restore left alone gives the whole model */
  const {s, file, data} = await seeded(ctx);
  try{
    const b0 = await snapshot(s.page);
    await pick(s.page, file);
    assert(await answerRestore(s.page, 'ok'), 'no question');
    await waitToast(s.page, /^Restored/, 60000);
    await closeRestored(s.page);
    const d = model(b0, data, await snapshot(s.page), KEEP2);
    assert(!d.length, 'the restore left alone differs from the model:\n    ' + d.slice(0, 12).join('\n    '));
  } finally { await s.close(); }
  if(ctx.opts.verbose) console.log('  reloads after Restore: ' + outcomes.join('; '));
}

/* ---------- loop 6 ---------- */
const songsOf = snap => Object.values(snap.songs).filter(x => !x.deleted);
const copiesOf = snap => songsOf(snap).filter(x => x.archived && /before restore \d{4}-\d\d-\d\d$/.test(x.version || ''));
const setCopiesOf = snap => Object.values(snap.sets).filter(x => !x.deleted && /\(before restore\)( \(\d+\))?$/.test(x.name));
async function restoreOver(page, file, what){
  await pick(page, file);
  const q = await answerRestore(page, 'ok');
  assert(q, what + ': no question');
  const msg = await waitToast(page, /^Restored|Nothing was changed/, 60000);
  assert(/^Restored/.test(msg), what + ': ' + msg);
  return {q, kept: await closeRestored(page)};
}
async function loopTablet(ctx){
  /* (a) a chart this tablet cannot read (the record, or only its bytes) never blocks a restore: the question counts it, the rest is
     kept, the backup restored. A chart that cannot be read only AFTER the question promised to keep it stops the restore before the
     write ("could not be read just now"): what is written is always what the question said. */
  for(const how of ['get', 'bytes', 'full']){
    const {s, file, data} = await seeded(ctx), page = s.page;
    try{
      const b0 = await snapshot(page);
      await page.evaluate(() => localStorage.removeItem('ss-last-backup'));
      if(how === 'get') await page.evaluate(() => { window.__failGet = ['rb']; });
      if(how === 'bytes') await page.evaluate(() => { window.__failBytes = ['rb']; });
      await pick(page, file);
      const box = page.locator('.modal.restoreask');
      await box.waitFor({timeout: 60000});
      const q = (await box.locator('.box').innerText()).replace(/\s+/g, ' ');
      if(how === 'full'){
        /* its first byte reads, so the question promises it; the whole file does not: nothing is written and the question comes again,
           naming it; Restore then goes ahead without it */
        assert(/Charts and marks are kept: 2 charts from this tablet/.test(q) && !/could not be read/.test(q), `(a ${how}) the first question: ` + q);
        await page.evaluate(() => { window.__failFull = ['rb']; });
        await box.locator('[data-ok]').click();
        await page.waitForFunction(() => /could not be read/.test(document.querySelector('.modal.restoreask')?.innerText || ''), null, {timeout: 60000})
          .catch(async () => { throw new Error(`(a ${how}) the question did not come again naming the chart; toast "${await page.locator('#toast').textContent()}"`); });
        const q2 = (await box.locator('.box').innerText()).replace(/\s+/g, ' ');
        assert(/1 chart on this tablet could not be read, so the marks drawn on it here cannot be kept: Over rb\./.test(q2) && /Charts and marks are kept: 1 chart from this tablet/.test(q2), `(a ${how}) the second question: ` + q2);
        await page.evaluate(() => { window.__failFull = null; });          // (the snapshot reads every stored PDF: rb is not in the keep list any more)
        expectSame(b0, await snapshot(page), `(a ${how}) before the second answer: the library before (left) and now (right)`);
      }
      else assert(/1 chart on this tablet could not be read, so the marks drawn on it here cannot be kept: Over rb\./.test(q) && /Charts and marks are kept: 1 chart from this tablet/.test(q), `(a ${how}) the question: ` + q);
      await box.locator('[data-ok]').click();
      const msg = await waitToast(page, /^Restored|Nothing was changed/, 60000);
      assert(msg === 'Restored 3 songs and 1 setlist', `(a ${how}) a chart that cannot be read blocked the restore: ` + msg);
      await closeRestored(page);
      await page.evaluate(() => { window.__failGet = null; window.__failBytes = null; window.__failFull = null; });
      /* copies were kept (in no backup yet), though nothing else here stays: this restore does not count as a backup */
      assert(await page.evaluate(() => localStorage.getItem('ss-last-backup')) === null, `(a ${how}) a restore that kept copies counted as a backup`);
      const d = model(b0, data, await snapshot(page), {keep: ['rc'], keepSets: ['rs']});
      assert(!d.length, `(a ${how}) the library differs from the backup plus the one readable copy:\n    ` + d.slice(0, 12).join('\n    '));
      assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
  }

  /* (g) a song here that stays and has rb's chart hash and marks, but no stored PDF, does not "hold" rb: rb is still kept */
  { const {s, file, data} = await seeded(ctx), page = s.page;
    try{
      await inStore(page, async S => {
        const b = await S.get('songs', 'rb'), ink = await S.get('ink', 'rb:1');
        await S.putAll([{store: 'songs', key: 'rz', value: {...b, id: 'rz', archived: true}}, {store: 'ink', key: 'rz:1', value: ink}]);
      });
      await s.goto();
      const b0 = await snapshot(page);
      const {q} = await restoreOver(page, file, '(g)');
      assert(/Charts and marks are kept: 2 charts from this tablet/.test(q), '(g) a song with no stored PDF counted as holding rb:\n' + q);
      const d = model(b0, data, await snapshot(page), KEEP2);
      assert(!d.length, '(g) the library differs from the model:\n    ' + d.slice(0, 12).join('\n    '));
    } finally { await s.close(); } }

  const {s, file, data} = await seeded(ctx), page = s.page;
  try{
    /* (b) restoring A, then B, then A again: what an earlier copy already holds is not copied twice; a setlist copy with the same
       songs is not made twice, and a second, different one is named "(2)" */
    const FB = (await backupNow(page)).file;                 // B: this tablet as changed (rb and rc marked, the setlist renamed)
    await restoreOver(page, file, '(b) A');
    const s1 = await snapshot(page);
    assert(copiesOf(s1).length === 2 && setCopiesOf(s1).length === 1, `(b) the first restore of A kept ${copiesOf(s1).length} charts and ${setCopiesOf(s1).length} setlists`);
    await restoreOver(page, FB, '(b) B');
    const {q: q3} = await restoreOver(page, file, '(b) A again');
    assert(!/are kept|Archived/.test(q3), '(b) restoring A again offers to keep what the earlier copies hold:\n' + q3);
    const s3 = await snapshot(page);
    assert(copiesOf(s3).length === 2 && setCopiesOf(s3).length === 1, `(b) after A, B, A: ${copiesOf(s3).length} archived charts and ${setCopiesOf(s3).length} setlist copies, expected 2 and 1 (copies multiplied)`);
    expectSame(s1, s3, '(b) after A (left) vs after A, B, A (right)');
    await inStore(page, async S => { const st = await S.get('sets', 'rs'); st.name = 'Gig changed here'; st.items = st.items.slice().reverse(); await S.saveSet(st); });
    const {q: q4} = await restoreOver(page, file, '(b) A after another change');
    assert(/A copy of 1 setlist is kept as "Gig changed here \(before restore\) \(2\)"\./.test(q4) && !/Charts and marks are kept/.test(q4), '(b) the second setlist copy\'s name (and no chart said kept):\n' + q4);
    assert(setCopiesOf(await snapshot(page)).map(x => x.name).sort().join('|') === 'Gig changed here (before restore)|Gig changed here (before restore) (2)', '(b) the setlist copies: ' + setCopiesOf(await snapshot(page)).map(x => x.name).join(' | '));

    /* (c) a crop made here after the backup, on a chart and marks the backup holds: kept with an archived copy that has the crop */
    const CROP = {all: {x: .1, y: .1, w: .7, h: .6}, pages: {}};
    await inStore(page, async (S, CROP) => { const a = await S.get('songs', 'ra'); a.crop = CROP; await S.saveSong(a); }, CROP);
    const c0 = await snapshot(page);
    const {q: q5} = await restoreOver(page, file, '(c) crop');
    assert(/Charts and marks are kept: 1 chart from this tablet/.test(q5), '(c) the question does not keep the cropped chart:\n' + q5);
    const c1 = await snapshot(page), d = model(c0, data, c1, {keep: ['ra']});
    assert(!d.length, '(c) the library differs from the backup plus a copy of ra with its crop:\n    ' + d.slice(0, 12).join('\n    '));

    /* (d) a record or page here whose `updated` is not a plain number never blocks a restore (it is written over, as before) */
    await inStore(page, async S => {
      const a = await S.get('songs', 'ra'), p = await S.get('ink', 'rb:1');
      await S.putAll([{store: 'songs', key: 'ra', value: {...a, artist: 'Odd time', updated: {when: 5}}}, {store: 'ink', key: 'rb:1', value: {...p, updated: {when: 6}}},
        {store: 'sets', key: 'rs', value: {...(await S.get('sets', 'rs')), updated: 'soon'}}]);
    });
    const e0 = await snapshot(page);
    await pick(page, file);
    assert(await answerRestore(page, 'ok'), '(d) no question');
    const m = await waitToast(page, /\S/, 60000);
    assert(/^Restored 3 songs and 1 setlist$/.test(m), '(d) a record with an odd `updated` blocked the restore: ' + m);
    await closeRestored(page);
    for(const id of ['ra', 'rb', 'rc']) expectSame(data.songs.find(x => x.id === id), (await snapshot(page)).songs[id], `(d) ${id} after the restore`);
    assert(diff(e0, await snapshot(page)).length, '(d) nothing changed (test setup)');

    /* (f) a gig date set here on a setlist whose songs an earlier copy already holds is not lost: a new copy keeps it */
    await restoreOver(page, FB, '(f) B');
    await inStore(page, async S => { const st = await S.get('sets', 'rs'); st.gig = '2026-12-24'; await S.saveSet(st); });
    const {q: q6} = await restoreOver(page, file, '(f) A');
    assert(/A copy of 1 setlist is kept as "Gig changed here \(before restore\) \(3\)"\./.test(q6), '(f) the setlist with a gig date changed here is not kept:\n' + q6);
    assert(setCopiesOf(await snapshot(page)).some(x => x.gig === '2026-12-24'), '(f) no setlist copy has the gig date set here');

    /* (e) "last backup" is set only when the backup holds everything here: a setlist not in it, or a copy, keeps the reminder */
    await page.evaluate(() => localStorage.removeItem('ss-last-backup'));
    await restoreOver(page, file, '(e) with setlists that stay');
    assert(await page.evaluate(() => localStorage.getItem('ss-last-backup')) === null, '(e) a restore that left setlists the backup does not have counted as a backup');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- loop 7 ---------- */
const b64of = buf => buf.toString('base64');
const putFile = (page, id, buf) => inStore(page, async (S, {id, b}) => S.putAll([{store: 'files', key: id, value: new Blob([Uint8Array.from(atob(b), c => c.charCodeAt(0))], {type: 'application/pdf'})}]), {id, b: b64of(buf)});
const songItems = st => st.items.filter(it => it.type === 'song').map(it => it.id);
async function loopKeptSetlist(ctx){
  /* (h) a replaced (3a) or deleted (3b) song held by a Copy-song twin that stays: no chart copy is needed, and the kept setlist plays
     the twin, not the backup's older chart and not a deleted song */
  for(const how of ['replaced', 'deleted']){
    const s = await session(ctx), page = s.page;
    try{
      const {file, data, pdfs} = await seedLibrary(page);
      const X = await makePdf('Rb newer ' + how, 1), HX = sha256(X);
      await putFile(page, 'rb', X); await putFile(page, 'rt', X);
      await inStore(page, async (S, HX) => {
        const b = await S.get('songs', 'rb');
        await S.putAll([{store: 'songs', key: 'rb', value: {...b, pages: 1, hash: HX, updated: Date.now()}}, {store: 'ink', key: 'rb:1', delete: true},
          {store: 'songs', key: 'rt', value: {...b, id: 'rt', song: 'Over twin', title: 'Over twin', pages: 1, hash: HX, updated: Date.now()}}]);
        const st = await S.get('sets', 'rs'); st.name = 'Gig changed here'; await S.saveSet(st);
      }, HX);
      await s.goto();
      const F = how === 'replaced' ? data : {...data, songs: data.songs.map(x => x.id === 'rb' ? {id: 'rb', deleted: true, updated: 9e12} : x), ink: {'ra:1': data.ink['ra:1']}};
      const f = how === 'replaced' ? file : await zipOf(F, pdfs, `over-del-${Date.now()}.zip`);
      const b0 = await snapshot(page);
      const {q} = await restoreOver(page, f, `(h ${how})`);
      assert(!/Charts and marks are kept/.test(q) && /A copy of 1 setlist is kept as "Gig changed here \(before restore\)"\./.test(q), `(h ${how}) the question:\n` + q);
      const after = await snapshot(page), [kept] = setCopiesOf(after);
      assert(kept && JSON.stringify(songItems(kept)) === JSON.stringify(['ra', 'rt', 'rc']), `(h ${how}) the kept setlist plays ${JSON.stringify(kept && songItems(kept))}, expected ["ra","rt","rc"] (rb's chart is held by its twin rt)`);
      const d = model(b0, F, after, {keepSets: ['rs'], heldBy: {rb: 'rt'}});
      assert(!d.length, `(h ${how}) the library differs from the model:\n    ` + d.slice(0, 12).join('\n    '));
      assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
  }

  /* (i) a version 1 backup (records with no `updated`, created 0): a crop and a break added here after it are newer than the backup */
  { const s = await session(ctx), page = s.page;
    try{
      const buf = await makePdf('Old one', 1), id = 'v1o' + Date.now().toString(36), sid = 'v1s' + Date.now().toString(36);
      const F = {app: 'setlist-stand', version: 1, saved: new Date(1700000000000).toISOString(), songs: [{id, title: 'Old Song - Some Artist', pages: 1}],
        sets: [{id: sid, name: 'Old Gig', songs: [id], created: 0}], ink: {}};
      const f = await zipOf(F, {[id]: buf}, `over-v1-${Date.now()}.zip`);
      await pick(page, f);
      assert(/^Restored 1 song and 1 setlist/.test(await waitToast(page, /^Restored|Nothing was changed|not a/, 60000)), '(i) the first restore');
      await inStore(page, async (S, {id, sid}) => {
        const a = await S.get('songs', id); a.crop = {all: {x: .1, y: .1, w: .8, h: .8}, pages: {}}; await S.saveSong(a);
        const st = await S.get('sets', sid); st.items = [...st.items, {type: 'break', id: 'v1brk', name: 'Encore'}]; await S.saveSet(st);
      }, {id, sid});
      await s.goto();
      const b0 = await snapshot(page);
      const {q} = await restoreOver(page, f, '(i) again');
      assert(/Charts and marks are kept: 1 chart from this tablet/.test(q) && /A copy of 1 setlist is kept as "Old Gig \(before restore\)"\./.test(q), '(i) the crop and the break made here are not kept:\n' + q);
      const after = await snapshot(page), [c] = copiesOf(after), [k] = setCopiesOf(after);
      assert(c && JSON.stringify(c.crop) === JSON.stringify(b0.songs[id].crop) && after.files[c.id] === sha256(buf), '(i) the archived copy does not carry the crop made here: ' + JSON.stringify(c));
      assert(k && k.items.some(it => it.type === 'break' && it.name === 'Encore') && songItems(k)[0] === c.id, '(i) the kept setlist: ' + JSON.stringify(k && k.items));
      assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); } }

  /* (j) a page in a (hand-made) backup for a song the backup does not list is not written over the marks of that song here, which
     the question says stays as it is; (k) a kept setlist's name stays within 200 characters with " (before restore) (2)" */
  { const s = await session(ctx), page = s.page;
    try{
      const {data, pdfs} = await seedLibrary(page);
      const Q = await makePdf('Rq mine', 1), LONG = 'L'.repeat(200), mine = pen('mine', .4);
      await putFile(page, 'rq', Q);
      await inStore(page, async (S, {HQ, mine, LONG}) => {
        const a = await S.get('songs', 'ra');
        await S.putAll([{store: 'songs', key: 'rq', value: {...a, id: 'rq', song: 'Over rq', title: 'Over rq', hash: HQ, updated: Date.now()}}, {store: 'ink', key: 'rq:1', value: {updated: mine.updated, strokes: [mine]}},
          {store: 'sets', key: 'rlong', value: {id: 'rlong', name: 'L'.repeat(183) + ' (before restore)', items: [], colls: [], created: 1, updated: 1}}]);
        const st = await S.get('sets', 'rs'); st.name = LONG; await S.saveSet(st);
      }, {HQ: sha256(Q), mine, LONG});
      await s.goto();
      const F = {...data, ink: {...data.ink, 'rq:1': {updated: 9e12, strokes: [pen('theirs', .7, 9e12)]}}};
      const f = await zipOf(F, pdfs, `over-rq-${Date.now()}.zip`);
      const b0 = await snapshot(page);
      const {q} = await restoreOver(page, f, '(j)');
      assert(/1 song and 1 setlist on this tablet are not in the backup\. They stay as they are\./.test(q), '(j) the question:\n' + q);
      const after = await snapshot(page);
      expectSame(b0.ink['rq:1'], after.ink['rq:1'], '(j) the marks of a song that stays (left: before, right: after)');
      const names = setCopiesOf(after).map(x => x.name).filter(n => n.startsWith('LL') && n !== 'L'.repeat(183) + ' (before restore)');
      assert(names.length === 1 && names[0].length <= 200 && names[0].endsWith(' (before restore) (2)'), '(k) the kept setlist with a 200-character name: ' + JSON.stringify(names.map(n => [n.length, n.slice(-24)])));
      assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); } }
}

/* ---------- loop 8 ---------- */
const setItems = st => st.items.map(it => it.type === 'break' ? 'break:' + it.name : it.id);
async function loopStaying(ctx){
  /* (s1) a setlist made here after the backup plays a song the restore replaces: it is left as it is (it plays the backup's version),
     and the question names it instead of saying it stays as it is */
  { const {s, file, data} = await seeded(ctx), page = s.page;
    try{
      await inStore(page, S => S.saveSet({id: 'rn', name: 'New Gig', items: [{type: 'song', id: 'rb'}, {type: 'song', id: 'ra'}], colls: [], created: Date.now()}));
      await s.goto();
      const b0 = await snapshot(page);
      const {q} = await restoreOver(page, file, '(s1)');
      assert(/1 setlist that stays will play the backup's version of songs it puts back: New Gig\. The versions from this tablet are in Archived\./.test(q), '(s1) the question does not name the setlist that will play the backup\'s version:\n' + q);
      assert(!/setlists? on this tablet (is|are) not in the backup/.test(q), '(s1) the question says that setlist stays as it is:\n' + q);
      const d = model(b0, data, await snapshot(page), KEEP2);
      assert(!d.length, '(s1) the library differs from the model (New Gig untouched):\n    ' + d.slice(0, 12).join('\n    '));
      assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); } }

  /* (s1b) the backup deletes the song: it leaves that setlist as a deletion here does (items filtered, stamped); a song changed here
     after the backup deleted it is kept, said in plain words; a collection changed here is named */
  { const {s, data, pdfs} = await seeded(ctx), page = s.page;
    try{
      await inStore(page, async S => {
        await S.saveSet({id: 'rn', name: 'New Gig', items: [{type: 'song', id: 'rb'}, {type: 'song', id: 'ra'}], colls: [], created: Date.now()});
        await S.putAll([{store: 'colls', key: 'rcoll', value: {id: 'rcoll', name: 'Band here', created: 1, updated: Date.now()}}]);
        const c = await S.get('songs', 'rc'); c.artist = 'Edited after'; await S.saveSong(c);
      });
      await s.goto();
      const F = {...data, songs: data.songs.map(x => x.id === 'rb' ? {id: 'rb', deleted: true, updated: Date.now() + 864e5} : x.id === 'rc' ? {id: 'rc', deleted: true, updated: 1700000000005} : x),
        ink: {'ra:1': data.ink['ra:1']}, colls: [{id: 'rcoll', name: 'Band then', created: 1, updated: 2}]};
      const f = await zipOf(F, pdfs, `over-s1b-${Date.now()}.zip`);
      const b0 = await snapshot(page);
      const {q} = await restoreOver(page, f, '(s1b)');
      assert(/1 setlist that stays will lose the songs the backup deletes, as deleting a song here does: New Gig\./.test(q), '(s1b) the question:\n' + q);
      assert(/1 song on this tablet is kept, because you changed it after the backup deleted it\./.test(q) && !/song on this tablet is not in the backup/.test(q), '(s1b) a song kept because it changed after the backup deleted it:\n' + q);
      assert(/It puts back the backup's version of [^:]*1 collection[^:]*:/.test(q) && /Band here \(changed here later\)/.test(q), '(s1b) the collection put back is not named:\n' + q);
      const a = await snapshot(page), rn = a.sets.rn;
      assert(JSON.stringify(setItems(rn)) === '["ra"]' && rn.updated > b0.sets.rn.updated && rn.name === 'New Gig', '(s1b) the staying setlist after the backup deleted rb: ' + JSON.stringify(rn));
      expectSame(b0.songs.rc, a.songs.rc, '(s1b) the song changed here after the backup deleted it');
      assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); } }

  /* (s2) restore A keeps "Gig changed here (before restore)"; restore B then replaces ra, which that copy plays: the copy is pointed in
     place at ra's new archived copy, so it still plays chart A, item by item; the ordinary setlist that plays ra is named */
  { const {s, file, data, pdfs} = await seeded(ctx), page = s.page;
    try{
      await restoreOver(page, file, '(s2) A');
      const s1 = await snapshot(page), [K] = setCopiesOf(s1);
      assert(K && K.kept === 'restore', '(s2) the kept setlist copy is not marked kept:\'restore\': ' + JSON.stringify(K));
      const playsOf = (snap, st) => st.items.map(it => it.type === 'break' ? 'break:' + it.name : JSON.stringify([snap.songs[it.id] && snap.songs[it.id].hash, ...[1, 2].map(p => ((snap.ink[it.id + ':' + p] || {}).strokes || []).filter(x => !x.deleted).map(x => x.id).sort().join())]));
      const want = playsOf(s1, K);
      const A2 = await makePdf('Ra newer chart', 1);
      const FB = {...data, songs: data.songs.map(x => x.id === 'ra' ? {...x, hash: sha256(A2), updated: x.updated + 1} : x), ink: {'rb:1': data.ink['rb:1']}};
      const fb = await zipOf(FB, {...pdfs, ra: A2}, `over-s2b-${Date.now()}.zip`);
      const {q} = await restoreOver(page, fb, '(s2) B');
      assert(/1 earlier "\(before restore\)" setlist is pointed at the kept charts, so it plays what it played before\./.test(q), '(s2) the question:\n' + q);
      assert(/1 setlist that stays will play the backup's version of songs it puts back: Gig\./.test(q), '(s2) the ordinary setlist that plays ra is not named:\n' + q);
      const s2 = await snapshot(page), K2 = s2.sets[K.id];
      assert(JSON.stringify(playsOf(s2, K2)) === JSON.stringify(want), '(s2) the kept setlist no longer plays what it played:\n    before ' + JSON.stringify(want) + '\n    after  ' + JSON.stringify(playsOf(s2, K2)));
      assert(K2.kept === 'restore' && K2.updated > K.updated && K2.name === K.name, '(s2) the kept setlist record: ' + JSON.stringify(K2));
      /* the mark survives a backup round trip */
      const bk = (await backupNow(page)).file;
      await wipe(page); await s.goto();
      await restoreZip(page, bk);
      expectSame(s2, await snapshot(page), '(s2) after Back up -> wipe -> Restore (right) vs before (left)');
      assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); } }

  /* (s3) a song here that would hold rb's chart, but whose PDF reads only in part, holds nothing: rb is kept as a copy */
  { const s = await session(ctx), page = s.page;
    try{
      const {file, data} = await seedLibrary(page);
      const X = await makePdf('Rb newer twin', 1), HX = sha256(X);
      await putFile(page, 'rb', X); await putFile(page, 'rt', X);
      await inStore(page, async (S, HX) => {
        const b = await S.get('songs', 'rb');
        await S.putAll([{store: 'songs', key: 'rb', value: {...b, pages: 1, hash: HX, updated: Date.now()}}, {store: 'ink', key: 'rb:1', delete: true},
          {store: 'songs', key: 'rt', value: {...b, id: 'rt', song: 'Over twin', title: 'Over twin', pages: 1, hash: HX, updated: Date.now()}}]);
      }, HX);
      await s.goto();
      const b0 = await snapshot(page);
      await page.evaluate(() => { window.__failFull = ['rt']; });
      const {q} = await restoreOver(page, file, '(s3)');
      await page.evaluate(() => { window.__failFull = null; });
      assert(/Charts and marks are kept: 1 chart from this tablet/.test(q), '(s3) a twin that reads only in part was trusted to hold rb:\n' + q);
      const d = model(b0, data, await snapshot(page), {keep: ['rb']});
      assert(!d.length, '(s3) the library differs from the model:\n    ' + d.slice(0, 12).join('\n    '));
      assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); } }
}

export const loops = [
  {name: 'roundtrip over 1: a backup restored over a library changed since it was made asks first, then gives back the backup plus exactly the copies a hand-written model expects (reload, backup, the same backup again)', run: loopModel},
  {name: 'roundtrip over 2: Cancel, Escape and Stop (while comparing, while keeping a chart) change nothing', run: loopNothing},
  {name: 'roundtrip over 3: an empty tablet (or one holding only deletion markers) restores without a question', run: loopEmpty},
  {name: 'roundtrip over 4: all or nothing with copies: a full tablet, a stroke or an edit in a second tab while asked, the size cap', run: loopAllOrNothing},
  {name: 'roundtrip over 6: the tablet\'s own state never blocks or multiplies: an unreadable chart, copies already held, a second setlist copy, a crop made here, an odd `updated`, "last backup" with records that stay', run: loopTablet},
  {name: 'roundtrip over 7: the kept setlist plays what it played (a twin holds the chart), a version 1 backup counts as older, a backup page for a song it does not list, a long setlist name', run: loopKeptSetlist},
  {name: 'roundtrip over 8: setlists the restore does not write over: named when they will play the backup\'s version, a deleted song leaves them, an earlier kept copy is repointed and still plays what it played; a holder must read whole', run: loopStaying},
  {name: 'roundtrip over 5: a reload at any moment after Restore leaves the library as it was or whole, copies included', run: loopReload},
];

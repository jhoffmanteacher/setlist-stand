/*
 * Round-trip loops: what a backup PRODUCES is opened independently (JSZip + SHA-256 in Node), restored onto a wiped
 * app through the real UI, and the restored IndexedDB is compared field by field with what went in.
 * Also: v1 backups upgrade and survive a round trip, the real converted library survives one, the converter's output
 * matches an independent read of the .msb (tools/loops/msb-expected.py), and a restore is all or nothing.
 * Private files are read in place; only ids and counts are printed; nothing is written outside harness TMP.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {FIX, TMP, ROOT, assert, sha256, sleep, idbAll, snapshot, diff, restoreZip, backupNow, wipe, JSZip, PDFDocument, openSetMenu} from './harness.mjs';

/* ---------- small UI helpers (approaches copied from tools/smoke.mjs) ---------- */
const liveOf = v => (v && Array.isArray(v.strokes) ? v.strokes : []).filter(s => !s.deleted);
const fixHash = f => sha256(fs.readFileSync(path.join(FIX, f)));
async function waitFor(fn, what, ms = 6000){
  const end = Date.now() + ms; let v;
  while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(120); }
  throw new Error(what);
}
async function toLibrary(page){
  if(await page.locator('#viewer.on').count()) await page.click('#vBack');
  await page.click('#tLib');
  await page.waitForSelector('#libList');
}
const songs = async page => Object.values(await idbAll(page, 'songs'));
const songRec = async (page, id) => (await idbAll(page, 'songs'))[id];
async function openAt(page, id, pn){
  await toLibrary(page);
  await page.click(`#libList [data-open="${id}"]`);
  await page.waitForSelector('#viewer.on #stage .sheet canvas');
  if(await page.getAttribute('#v2up', 'aria-pressed') === 'true'){ await showChrome(page); await page.click('#v2up'); }
  await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 1, null, {timeout: 5000});
  await gotoPage(page, pn);
}
async function gotoPage(page, pn){
  for(let i = 0; i < 8; i++){
    const m = /Page (\d+) of (\d+)/.exec(await page.locator('#vSub').textContent());
    const cur = m ? +m[1] : 0;
    if(cur === pn && await page.locator(`#stage .ink[data-pn="${pn}"]`).count()) return;
    if(cur !== pn) await page.keyboard.press(cur < pn ? 'ArrowRight' : 'ArrowLeft');
    await sleep(200);
  }
  await page.waitForSelector(`#stage .ink[data-pn="${pn}"]`, {timeout: 3000});
}
async function showChrome(page){
  if(await page.locator('#viewer.hide').count()){ await page.mouse.click(640, 420); await page.waitForSelector('#viewer:not(.hide)'); }
}
const sheetBox = (page, pn) => page.locator(`#stage .sheet:has(.ink[data-pn="${pn}"])`).boundingBox();
async function line(page, pn, fx, fy){
  const b = await sheetBox(page, pn), x0 = b.x + b.width * fx, y0 = b.y + b.height * fy;
  await page.mouse.move(x0, y0); await page.mouse.down();
  for(let i = 1; i <= 10; i++) await page.mouse.move(x0 + i * b.width * .04, y0 + i * b.height * .01);
  await page.mouse.up();
}
async function annotOn(page){
  if(!(await page.locator('#tools').isVisible())){ await showChrome(page); await page.click('#vAnn'); }
}
async function drawStroke(page, id, pn, tool, fx, fy){
  await annotOn(page);
  const n0 = liveOf((await idbAll(page, 'ink'))[id + ':' + pn]).length;
  await page.click(tool === 'hl' ? '#tools [data-tool=hl][data-color="#ffd400"]' : '#tools [data-tool=pen][data-color="#1a1a1a"]');
  await line(page, pn, fx, fy);
  await waitFor(async () => liveOf((await idbAll(page, 'ink'))[id + ':' + pn]).length > n0, `${tool} stroke not saved on ${id}:${pn}`);
}
async function addNote(page, id, pn, text){
  await annotOn(page);
  if(await page.getAttribute('#tools [data-tool=text]', 'aria-pressed') !== 'true') await page.click('#tools [data-tool=text]');
  const b = await sheetBox(page, pn);
  await page.mouse.click(b.x + b.width * .1, b.y + b.height * .1);
  const m = page.locator('.modal');
  await m.locator('textarea').waitFor({timeout: 5000});
  await m.locator('textarea').fill(text);
  await m.locator('[data-ok]').click();
  await page.waitForFunction(() => !document.querySelector('.modal'));
  await waitFor(async () => liveOf((await idbAll(page, 'ink'))[id + ':' + pn]).some(s => s.t === 'text' && s.text === text), `note "${text}" not saved`);
  await page.click('#tools [data-tool=text]');           // back to the pen
  await page.click('#tDone');
}
async function dragHandle(page, h, fx, fy){
  const s = await page.locator('#cropSheet').boundingBox(), hb = await page.locator(`#cropBox .ch[data-h=${h}]`).boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
  await page.mouse.move(s.x + s.width * fx, s.y + s.height * fy, {steps: 8}); await page.mouse.up();
}
async function crop(page, id, pn, r, whole){
  await showChrome(page);
  await page.evaluate(() => { document.querySelector('#cropHint').textContent = ''; });
  await page.click('#vCrop');
  await page.waitForFunction(pn => !document.querySelector('#cropper').hidden && document.querySelector('#cropHint').textContent.startsWith('Page ' + pn + ' of'), pn, {timeout: 5000});
  await dragHandle(page, 'nw', r.x, r.y);
  await dragHandle(page, 'se', r.x + r.w, r.y + r.h);
  await page.click(whole ? '#cropSong' : '#cropPage');
  await page.waitForSelector('#cropper', {state: 'hidden', timeout: 5000});
  await waitFor(async () => { const c = (await songRec(page, id)).crop; return c && (whole ? c.all : c.pages && c.pages[pn]); }, `crop of ${id} not saved`);
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
async function addSongs(page, titles){
  const n0 = await rowCount(page);
  await page.click('#view [data-addto]');
  await page.locator('.modal .pick').waitFor();
  for(const t of titles){
    const box = page.locator('.modal .pick label').filter({hasText: new RegExp('^' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')}).locator('input');
    assert(await box.count() === 1, `picker has ${await box.count()} rows titled "${t}"`);
    await box.check();
  }
  await page.click('.modal [data-ok]');
  await page.waitForFunction(n => document.querySelectorAll('#items > li.row').length === n, n0 + titles.length, {timeout: 5000});
}
async function setNamed(page, name){
  const l = (await idbAll(page, 'sets')); return Object.values(l).find(s => !s.deleted && s.name === name);
}
async function twoTap(page, sel){ const b = page.locator(sel); await b.click(); await b.click(); }
/* ---------- collections through the real UI ---------- */
const collRecs = async page => Object.values(await idbAll(page, 'colls'));
const noModal = page => page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000});
async function openManager(page){
  await toLibrary(page);
  await page.click('#view [data-collmanage]');
  await page.locator('.collmgr').waitFor();
}
async function closeManager(page){ await page.click('.collmgr [data-x]'); await noModal(page); }
async function makeColl(page, name){
  await openManager(page);
  await page.click('.collmgr [data-newcoll]');
  await page.locator('.collname input').fill(name);
  await page.click('.collname [data-ok]');
  await page.waitForFunction(() => !document.querySelector('.collname'), null, {timeout: 5000});
  await closeManager(page);
  return (await waitFor(async () => (await collRecs(page)).find(c => !c.deleted && c.name === name), 'collection ' + name + ' not saved')).id;
}
async function deleteColl(page, id){
  await openManager(page);
  await twoTap(page, `.collmgr [data-mdel="${id}"]`);
  await page.waitForFunction(id => !document.querySelector(`.collmgr [data-mdel="${id}"]`), id, {timeout: 5000});
  await closeManager(page);
}
/* In a dialog with a Collections group: tick exactly `ids`, then Save. */
async function tickIn(page, ids){
  await page.locator('.modal fieldset.checks').waitFor();
  const all = await page.locator('.modal fieldset.checks input').evaluateAll(els => els.map(e => e.value));
  for(const id of all) await page.locator(`.modal fieldset.checks input[value="${id}"]`).setChecked(ids.includes(id));
  await page.click('.modal [data-ok]');
  await noModal(page);
}
async function tickSong(page, songId, ids){
  await toLibrary(page);
  await page.click(`#libList [data-edit="${songId}"]`);
  await tickIn(page, ids);
}
async function tickSet(page, name, ids){
  await toLibrary(page);
  await page.click('#tSets');
  await page.locator('#view [data-set]', {hasText: name}).click();
  await openSetMenu(page, 'colls');
  await tickIn(page, ids);
}
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/* Restore through the UI without asserting success: returns the toast text. */
async function restoreAny(page, file, timeout = 180000){
  await toLibrary(page);
  await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
  await page.setInputFiles('#restoreFile', file);
  await page.waitForFunction(() => document.querySelector('#toast').textContent.trim() && !/^Adding/.test(document.querySelector('#toast').textContent), null, {timeout});
  await sleep(500);
  return page.locator('#toast').textContent();
}
async function wipeReload(s){
  await wipe(s.page);
  await s.goto();
  const snap = await snapshot(s.page);
  assert(Object.keys(snap).includes('colls') && Object.values(snap).every(o => !Object.keys(o).length), 'database not empty after wipe + reload');
}
const readZip = async f => JSZip.loadAsync(await fsp.readFile(f));
const libJson = async zip => JSON.parse(await zip.file('library.json').async('string'));
function expectSame(a, b, what){
  const d = diff(a, b, '', [], 40);
  assert(!d.length, `${what}: ${d.length}${d.length >= 40 ? '+' : ''} difference(s):\n    ` + d.join('\n    '));
}

/* ---------- loop 1: a rich library built through the UI ---------- */
let gen1 = null;              // {file, snap, ids} of the first backup, reused by loop 2 when both run
async function buildRich(s){
  const {page} = s;
  await s.goto();
  const doomed = path.join(TMP, 'Doomed Song.pdf');
  fs.copyFileSync(path.join(FIX, 'one-page.pdf'), doomed);
  await page.setInputFiles('#file', [path.join(FIX, 'one-page.pdf'), path.join(FIX, 'two-page.pdf'), path.join(FIX, 'three-page.pdf'), doomed]);
  await page.click('.dupask [data-dupadd]', {timeout: 20000});      // Doomed Song has One-page's bytes: add it anyway
  await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 4, null, {timeout: 20000});
  const by = Object.fromEntries((await songs(page)).map(x => [x.song, x.id]));
  const ids = {one: by['One-page'], two: by['Two-page'], three: by['Three-page'], doomed: by['Doomed Song']};
  assert(Object.values(ids).every(Boolean), 'imported songs not found by title: ' + JSON.stringify(Object.keys(by)));

  /* Edit title / artist / version */
  await page.click(`#libList [data-edit="${ids.two}"]`);
  const m = page.locator('.modal'); await m.waitFor();
  await m.locator('input[data-k=song]').fill('Round Trip');
  await m.locator('input[data-k=artist]').fill('The Loops');
  await m.locator('input[data-k=version]').fill('live');
  await m.locator('[data-ok]').click();
  await waitFor(async () => (await songRec(page, ids.two)).song === 'Round Trip', 'edit not saved');
  /* Archive */
  await page.click(`#libList [data-archive="${ids.one}"]`);
  await waitFor(async () => (await songRec(page, ids.one)).archived === true, 'archive not saved');

  /* Pen, highlighter, a text note, a page crop on Three-page; a whole-song crop on Round Trip */
  await openAt(page, ids.three, 1);
  await drawStroke(page, ids.three, 1, 'pen', .3, .4);
  await drawStroke(page, ids.three, 1, 'hl', .3, .6);
  await addNote(page, ids.three, 1, 'C♯ to B♭');
  await gotoPage(page, 2);
  await crop(page, ids.three, 2, {x: .2, y: .25, w: .6, h: .5}, false);
  await openAt(page, ids.two, 1);
  await crop(page, ids.two, 1, {x: .1, y: .1, w: .8, h: .6}, true);
  await toLibrary(page);

  /* Setlist with songs and a renamed break; a second set that gets deleted */
  const T = async id => (await songRec(page, id)).title;
  await newSet(page, 'Gig');
  await addSongs(page, [await T(ids.two), await T(ids.three), await T(ids.doomed)]);
  await page.click('#view [data-addbreak]');
  await page.waitForFunction(() => document.querySelectorAll('#items > li.row').length === 4);
  await page.click('#view [data-renbreak="3"]');
  await page.locator('.modal input[type=text]').fill('Intermission');
  await page.click('.modal [data-ok]');
  await waitFor(async () => (await setNamed(page, 'Gig'))?.items.some(it => it.type === 'break' && it.name === 'Intermission'), 'break rename not saved');
  await addSongs(page, [await T(ids.three)]);
  await newSet(page, 'Scratch');
  await addSongs(page, [await T(ids.three)]);
  const scratch = (await setNamed(page, 'Scratch')).id;
  await page.click('#view [data-allsets]');
  await twoTap(page, `#view [data-delset="${scratch}"]`);
  await waitFor(async () => (await idbAll(page, 'sets'))[scratch]?.deleted === true, 'set deletion marker not saved');
  /* Delete a song (it leaves a marker and drops out of Gig) */
  await toLibrary(page);
  await twoTap(page, `#libList [data-del="${ids.doomed}"]`);
  await waitFor(async () => (await songRec(page, ids.doomed))?.deleted === true, 'song deletion marker not saved');
  /* Three collections: Round Trip is in two of them at once, Three-page in the second and the third; Gig is in the first.
     The third is deleted again, so it is a marker and Three-page no longer lists it. */
  const A = await makeColl(page, 'Band A'), B = await makeColl(page, 'Band B'), C = await makeColl(page, 'Band C');
  await tickSong(page, ids.two, [A, B]);
  await tickSong(page, ids.three, [B, C]);
  await tickSet(page, 'Gig', [A]);
  await waitFor(async () => sameSet((await songRec(page, ids.two)).colls, [A, B]) && sameSet((await setNamed(page, 'Gig')).colls, [A]), 'collections not saved on the song and the set');
  await deleteColl(page, C);
  await waitFor(async () => (await idbAll(page, 'colls'))[C]?.deleted === true && sameSet((await songRec(page, ids.three)).colls, [B]), 'deleting Band C did not leave a marker and take it off Three-page');
  await sleep(300);
  return {...ids, scratch, collA: A, collB: B, collC: C};
}
async function makeGen1(ctx){
  const s = await ctx.session();
  try{
    const ids = await buildRich(s);
    const snap = await snapshot(s.page);
    const {file} = await backupNow(s.page);
    gen1 = {file, snap, ids};
    return {s, ...gen1};
  } catch(e){ await s.close(); throw e; }
}

async function loopBackupRestore(ctx){
  const {s, file, snap: A, ids} = await makeGen1(ctx);
  try{
    /* Independent read of the zip */
    const zip = await readZip(file), data = await libJson(zip);
    assert(data.app === 'setlist-stand' && data.version === 3, `library.json app/version ${data.app}/${data.version}, expected setlist-stand/3`);
    const want = {[ids.one]: fixHash('one-page.pdf'), [ids.two]: fixHash('two-page.pdf'), [ids.three]: fixHash('three-page.pdf')};
    const live = data.songs.filter(x => !x.deleted);
    assert(live.length === 3, `backup has ${live.length} live songs, expected 3`);
    for(const so of live){
      const f = zip.file('files/' + so.id + '.pdf');
      assert(f, `backup lacks files/${so.id}.pdf`);
      const h = sha256(await f.async('nodebuffer'));
      assert(h === A.files[so.id], `files/${so.id}.pdf SHA-256 ${h} != stored in app ${A.files[so.id]}`);
      assert(h === want[so.id], `files/${so.id}.pdf SHA-256 ${h} != original fixture ${want[so.id]}`);
      assert(so.hash === h, `song ${so.id}.hash ${so.hash} != its file ${h}`);
    }
    const pdfs = Object.keys(zip.files).filter(n => n.startsWith('files/') && !zip.files[n].dir);
    assert(pdfs.length === 3, 'backup files/: ' + pdfs.join(', '));
    const sm = data.songs.find(x => x.id === ids.doomed), tm = data.sets.find(x => x.id === ids.scratch);
    assert(sm && sm.deleted === true && sm.updated > 0 && Object.keys(sm).sort().join() === 'deleted,id,updated', 'song deletion marker missing/wrong: ' + JSON.stringify(sm));
    assert(tm && tm.deleted === true && tm.updated > 0, 'set deletion marker missing: ' + JSON.stringify(tm));
    const ink = liveOf(data.ink[ids.three + ':1']);
    assert(ink.some(x => x.t === 'pen') && ink.some(x => x.t === 'hl') && ink.some(x => x.t === 'text' && x.text === 'C♯ to B♭'),
      'backup ink page lacks pen/hl/note: ' + JSON.stringify(ink.map(x => x.t + (x.text ? ':' + x.text : ''))));
    expectSame(A.ink, data.ink, 'backup ink vs app ink');
    const bs = id => data.songs.find(x => x.id === id), gigOf = d => d.sets.find(x => x.name === 'Gig' && !x.deleted);
    assert(bs(ids.three).crop?.pages?.['2'] && bs(ids.two).crop?.all, 'backup lacks crops: ' + JSON.stringify([bs(ids.three).crop, bs(ids.two).crop]));
    /* collections: version 3 lists them, with the deleted one as a marker; songs and sets carry their ids; deleting Band C took its id off Three-page */
    assert(Array.isArray(data.colls) && data.colls.length === 3, 'backup colls: ' + JSON.stringify(data.colls));
    const cm = data.colls.find(x => x.id === ids.collC);
    assert(cm && cm.deleted === true && cm.updated > 0 && Object.keys(cm).sort().join() === 'deleted,id,updated', 'collection deletion marker missing/wrong: ' + JSON.stringify(cm));
    assert(data.colls.filter(x => !x.deleted).map(x => x.name).sort().join() === 'Band A,Band B' && data.colls.filter(x => !x.deleted).every(x => x.created > 0 && x.updated >= x.created), 'live collections: ' + JSON.stringify(data.colls));
    assert(sameSet(bs(ids.two).colls, [ids.collA, ids.collB]) && sameSet(bs(ids.three).colls, [ids.collB]) && bs(ids.one).colls.length === 0, 'song collections: ' + JSON.stringify(live.map(x => [x.id, x.colls])));
    assert(sameSet(data.sets.find(x => x.name === 'Gig' && !x.deleted).colls, [ids.collA]), 'Gig collections: ' + JSON.stringify(gigOf(data)));
    expectSame(A.colls, Object.fromEntries(data.colls.map(x => [x.id, x])), 'backup collections vs the app\'s');
    for(const so of data.songs) expectSame(A.songs[so.id], so, `backup song ${so.id}`);
    for(const st of data.sets) expectSame(A.sets[st.id], st, `backup set ${st.id}`);
    const gig = data.sets.find(x => x.name === 'Gig' && !x.deleted);
    assert(gig && gig.items.map(i => i.type === 'break' ? 'B:' + i.name : i.id).join() === [ids.two, ids.three, 'B:Intermission', ids.three].join(),
      'backup Gig items: ' + JSON.stringify(gig && gig.items));

    /* Wipe, reload, restore through the UI, compare everything */
    await wipeReload(s);
    const msg = await restoreZip(s.page, file);
    assert(/Restored 3 songs and 1 setlist\b/.test(msg), 'restore toast: ' + msg);
    expectSame(A, await snapshot(s.page), 'snapshot before backup (left) vs after wipe + restore (right)');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- loop 2: back up the restored library again ---------- */
async function loopSecondGeneration(ctx){
  if(!gen1){ const r = await makeGen1(ctx); await r.s.close(); }
  const s = await ctx.session();
  try{
    await s.goto();
    await restoreZip(s.page, gen1.file);
    expectSame(gen1.snap, await snapshot(s.page), 'first-generation snapshot vs restored');
    const {file: f2} = await backupNow(s.page);
    const z1 = await readZip(gen1.file), z2 = await readZip(f2);
    const d1 = await libJson(z1), d2 = await libJson(z2);
    assert(d1.saved && d2.saved, 'library.json lacks saved');
    delete d1.saved; delete d2.saved;
    expectSame(d1, d2, 'library.json gen 1 (left) vs gen 2 (right), ignoring saved');
    const names = z => Object.keys(z.files).filter(n => !z.files[n].dir).sort();
    assert(names(z1).join() === names(z2).join(), `zip entries differ: ${names(z1).join()} vs ${names(z2).join()}`);
    for(const n of names(z1).filter(n => n.startsWith('files/'))){
      const a = await z1.file(n).async('nodebuffer'), b = await z2.file(n).async('nodebuffer');
      assert(Buffer.compare(a, b) === 0, `${n} is not byte-identical between generations (${a.length} vs ${b.length} bytes)`);
    }
  } finally { await s.close(); }
}

/* ---------- loop 3: a version-1 backup ---------- */
async function loopV1(ctx){
  const a = 'v1a' + Date.now().toString(36), b = 'v1b' + Date.now().toString(36), st = 'v1s' + Date.now().toString(36);
  const zip = new JSZip();
  zip.file(`files/${a}.pdf`, fs.readFileSync(path.join(FIX, 'one-page.pdf')));
  zip.file(`files/${b}.pdf`, fs.readFileSync(path.join(FIX, 'three-page.pdf')));
  zip.file('library.json', JSON.stringify({app: 'setlist-stand', version: 1, saved: new Date().toISOString(),
    songs: [{id: a, title: 'Old Song - Some Artist', pages: 1, added: 1700000000000}, {id: b, title: 'Another Tune in G', pages: 3, added: 1700000001000}],
    sets: [{id: st, name: 'Old Gig', songs: [a, b, a], created: 1700000002000}],
    ink: {[a + ':1']: [{t: 'pen', c: '#d62828', w: .003, p: [[.1, .1], [.5, .5]]}],
      [b + ':2']: [{t: 'hl', c: '#ffd400', w: .02, p: [[.2, .3], [.6, .3]]}, {t: 'pen', c: '#1a1a1a', w: .003, p: [[.3, .3], [.4, .6]]}]}}));
  const f = path.join(TMP, 'roundtrip-v1.zip');
  await fsp.writeFile(f, await zip.generateAsync({type: 'nodebuffer'}));
  const s = await ctx.session();
  try{
    await s.goto();
    await restoreZip(s.page, f);
    await waitFor(async () => (await songs(s.page)).every(x => /^[0-9a-f]{64}$/.test(x.hash || '')), 'v1 songs got no hash');
    const A = await snapshot(s.page);
    const {file: b2} = await backupNow(s.page);
    const d = await libJson(await readZip(b2));
    assert(d.version === 3, 'backup of a v1 restore has version ' + d.version);
    assert(Array.isArray(d.colls) && d.colls.length === 0 && !Object.keys(A.colls).length, 'a v1 restore has collections: ' + JSON.stringify(d.colls));
    for(const x of [...d.songs, ...d.sets]) assert(Array.isArray(x.colls) && x.colls.length === 0, 'record not given colls [] by a v1 restore: ' + JSON.stringify(x));
    for(const x of d.songs) assert(/^[0-9a-f]{64}$/.test(x.hash || '') && x.updated > 0 && typeof x.song === 'string' && 'artist' in x && 'version' in x,
      'song not upgraded in the v2 backup: ' + JSON.stringify(x));
    assert(d.songs.find(x => x.id === a).hash === fixHash('one-page.pdf'), 'v1 song hash != its PDF');
    for(const x of d.sets) assert(Array.isArray(x.items) && !('songs' in x) && x.updated > 0, 'set not upgraded: ' + JSON.stringify(x));
    assert(d.sets[0].items.map(i => i.type + ':' + i.id).join() === [a, b, a].map(i => 'song:' + i).join(), 'set order lost: ' + JSON.stringify(d.sets[0].items));
    for(const [k, v] of Object.entries(d.ink)){
      assert(!Array.isArray(v) && v.updated > 0 && Array.isArray(v.strokes), `ink ${k} not {updated, strokes}`);
      for(const x of v.strokes) assert(typeof x.id === 'string' && x.id && x.updated > 0, `stroke in ${k} lacks id/updated: ` + JSON.stringify(x));
    }
    assert(Object.keys(d.ink).sort().join() === [a + ':1', b + ':2'].sort().join() && d.ink[b + ':2'].strokes.length === 2, 'ink pages: ' + Object.keys(d.ink).join());
    await wipeReload(s);
    await restoreZip(s.page, b2);
    expectSame(A, await snapshot(s.page), 'v1 restore (left) vs restore of its v2 backup (right)');
  } finally { await s.close(); }
}

/* ---------- loop 4: the real converted library ---------- */
const liveSongs = snap => Object.values(snap.songs).filter(x => !x.deleted);
const liveSets = snap => Object.values(snap.sets).filter(x => !x.deleted);
async function loopRealLibrary(ctx){
  const s = await ctx.session();
  try{
    await s.goto();
    await restoreZip(s.page, ctx.library);
    const A = await snapshot(s.page);
    const cropped = liveSongs(A).filter(x => x.crop && (x.crop.all || Object.keys(x.crop.pages || {}).length));
    const notes = Object.values(A.ink).reduce((n, v) => n + liveOf(v).filter(x => x.t === 'text').length, 0);
    const brk = liveSets(A).map(x => x.items.filter(i => i.type === 'break').length);
    const got = {songs: liveSongs(A).length, sets: liveSets(A).length, inkPages: Object.keys(A.ink).length, crop: cropped.length,
      cropAll: cropped.filter(x => x.crop.all).length, notes, breaks: brk.reduce((a, b) => a + b, 0), setsWithBreaks: brk.filter(Boolean).length};
    const want = {songs: 74, sets: 13, inkPages: 41, crop: 58, cropAll: 20, notes: 11, breaks: 10, setsWithBreaks: 6};
    assert(JSON.stringify(got) === JSON.stringify(want), `counts after restore ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);

    const {file} = await backupNow(s.page);
    const zb = await readZip(file), zl = await readZip(ctx.library);
    const pdfs = z => Object.keys(z.files).filter(n => n.startsWith('files/') && !z.files[n].dir).sort();
    assert(pdfs(zb).join() === pdfs(zl).join(), `backup has ${pdfs(zb).length} PDFs, library zip ${pdfs(zl).length}`);
    for(const n of pdfs(zb)){
      const hb = sha256(await zb.file(n).async('nodebuffer')), hl = sha256(await zl.file(n).async('nodebuffer'));
      assert(hb === hl, `${n}: backup SHA-256 ${hb.slice(0, 12)}… != library zip ${hl.slice(0, 12)}…`);
      assert(hb === A.files[n.slice(6, -4)], `${n}: backup bytes differ from the app's stored bytes`);
    }
    await wipeReload(s);
    await restoreZip(s.page, file);
    expectSame(A, await snapshot(s.page), 'real library: restored (left) vs after backup, wipe, restore (right)');
  } finally { await s.close(); }
}

/* ---------- loop 5: converter output vs an independent read of the .msb ---------- */
/* Stored PDF bytes of one song, out of IndexedDB. */
const storedPdf = async (page, id) => Buffer.from(await page.evaluate(id => new Promise((res, rej) => {
  const r = indexedDB.open('setlist-stand');
  r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').get(id);
    q.onsuccess = async () => { const b = new Uint8Array(await q.result.arrayBuffer()); let s = ''; for(let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768)); r.result.close(); res(btoa(s)); };
    q.onerror = () => rej(q.error); };
  r.onerror = () => rej(r.error);
}), id), 'base64');

async function loopConverter(ctx){
  const exp = JSON.parse(execFileSync('python3', ['-I', path.join(ROOT, 'tools', 'loops', 'msb-expected.py'), ctx.msb], {encoding: 'utf8', maxBuffer: 64 << 20}));
  assert(exp.songs.length && exp.annotated.length && exp.notes.length && exp.sets.length && exp.crops.length, 'msb-expected.py found nothing: ' +
    JSON.stringify(Object.fromEntries(Object.entries(exp).map(([k, v]) => [k, v.length]))));
  const s = await ctx.session();
  const probs = [];
  const P = m => { if(probs.length < 40) probs.push(m); };
  try{
    await s.goto();
    await restoreZip(s.page, ctx.library);
    const A = await snapshot(s.page);
    const appSongs = Object.fromEntries(liveSongs(A).map(x => [x.id, x]));
    const ms = id => 'ms' + id;

    /* songs and page counts (stored PDF page count via pdf-lib) */
    const expIds = new Set(exp.songs.map(x => ms(x.id)));
    for(const id of Object.keys(appSongs)) if(!expIds.has(id)) P(`song ${id} is in the app but has no PDF in the .msb`);
    const sizes = {};
    for(const e of exp.songs){
      const id = ms(e.id), a = appSongs[id];
      if(!a){ P(`song ${id} (has a PDF in the .msb) missing from the app`); continue; }
      const doc = await PDFDocument.load(await storedPdf(s.page, id), {ignoreEncryption: true, updateMetadata: false});
      const n = doc.getPageCount();
      if(n !== a.pages) P(`song ${id}: stored PDF has ${n} pages, song.pages = ${a.pages}`);
      if(a.pages !== e.pages) P(`song ${id}: song.pages = ${a.pages}, MobileSheets shows ${e.pages}`);
      sizes[id] = doc.getPages().map(pg => { const b = pg.getCropBox(), r = ((pg.getRotation().angle % 360) + 360) % 180; return r ? [b.height, b.width] : [b.width, b.height]; });
    }

    /* annotated pages */
    const appPages = new Set(Object.entries(A.ink).filter(([, v]) => liveOf(v).length).map(([k]) => k));
    const expPages = new Set(exp.annotated.map(([id, pg]) => ms(id) + ':' + pg));
    for(const k of expPages) if(!appPages.has(k)) P(`page ${k} is annotated in the .msb but has no ink in the app`);
    for(const k of appPages) if(!expPages.has(k)) P(`page ${k} has ink in the app but no annotation in the .msb`);

    /* note texts, per page, as multisets */
    const bag = list => { const m = {}; for(const [k, t] of list) (m[k] = m[k] || []).push(t); for(const k in m) m[k].sort(); return m; };
    const appNotes = bag(Object.entries(A.ink).flatMap(([k, v]) => liveOf(v).filter(x => x.t === 'text').map(x => [k, x.text])));
    const expNotes = bag(exp.notes.map(n => [ms(n.song) + ':' + n.page, n.text.replace(/^\n+|\n+$/g, '')]));
    for(const k of new Set([...Object.keys(appNotes), ...Object.keys(expNotes)])){
      const a = appNotes[k] || [], e = expNotes[k] || [];
      if(JSON.stringify(a) !== JSON.stringify(e)) P(`notes on ${k}: app has ${a.length}, .msb has ${e.length}${a.length === e.length ? ' (texts differ)' : ''}`);
    }

    /* setlists: order of songs, break positions and names */
    const appSets = Object.fromEntries(liveSets(A).map(x => [x.id, x]));
    if(Object.keys(appSets).length !== exp.sets.length) P(`app has ${Object.keys(appSets).length} setlists, .msb ${exp.sets.length}`);
    for(const e of exp.sets){
      const a = appSets['msset' + e.id];
      if(!a){ P(`setlist msset${e.id} missing`); continue; }
      if(a.name !== e.name) P(`setlist msset${e.id}: name differs`);
      const want = e.items.map(i => i.song != null ? 'song:' + ms(i.song) : 'break:' + i.brk);
      const got = a.items.map(i => i.type === 'song' ? 'song:' + i.id : 'break:' + i.name);
      if(want.length !== got.length) P(`setlist msset${e.id}: ${got.length} items, .msb ${want.length}`);
      const i = want.findIndex((w, j) => w !== got[j]);
      if(i >= 0) P(`setlist msset${e.id}: item ${i + 1} is ${got[i]?.startsWith('song:') ? got[i] : 'a break'}, .msb has ${want[i].startsWith('song:') ? want[i] : 'a break'}${got[i]?.startsWith('break:') && want[i].startsWith('break:') ? ' (break names differ)' : ''}`);
    }

    /* crops: the converter's documented rule (nonzero rect that is not the full page, a margin >= 0.5%), page sizes from pdf-lib */
    const expCrop = new Set();
    for(const [sid, pg, l, t, r, b] of exp.crops){
      const id = ms(sid), dims = sizes[id];
      if(!dims || pg >= dims.length || !(l || t || r || b)) continue;
      const [w, h] = dims[pg], x = Math.max(0, l / w), y = Math.max(0, t / h), x2 = Math.min(1, r / w), y2 = Math.min(1, b / h);
      if(x < .005 && y < .005 && x2 > .995 && y2 > .995) continue;
      expCrop.add(id);
    }
    const appCrop = new Set(liveSongs(A).filter(x => x.crop && (x.crop.all || Object.keys(x.crop.pages || {}).length)).map(x => x.id));
    if(appCrop.size !== expCrop.size) P(`${appCrop.size} songs have a crop in the app, ${expCrop.size} by the .msb Crop rows`);
    for(const id of expCrop) if(!appCrop.has(id)) P(`song ${id}: .msb Crop rows say cropped, app has no crop`);
    for(const id of appCrop) if(!expCrop.has(id)) P(`song ${id}: app has a crop, .msb Crop rows say none`);

    assert(!probs.length, `${probs.length} difference(s) between the app and the .msb:\n    ` + probs.join('\n    '));
  } finally { await s.close(); }
}

/* ---------- loop 6: restore is all or nothing ---------- */
async function seeded(ctx, init){
  const s = await ctx.session();
  if(init) await s.context.addInitScript(init);        // runs in every page of the session before the app's own scripts
  await s.goto();
  await s.page.setInputFiles('#file', ['one-page.pdf', 'two-page.pdf', 'three-page.pdf'].map(f => path.join(FIX, f)));
  await s.page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 3, null, {timeout: 20000});
  await waitFor(async () => (await songs(s.page)).every(x => x.hash), 'hashes');
  return s;
}
/* A valid v2 backup of `n` new songs (one-page fixture), as a STORE zip so its PDF bytes sit in the file as-is.
   ink: true gives every song an annotated page 1 (one pen stroke). */
async function v2zip(n, {missing = -1, ink = false, colls = false} = {}){
  const pdf = fs.readFileSync(path.join(FIX, 'one-page.pdf')), h = sha256(pdf), t = Date.now(), z = new JSZip(), list = [], inkRecs = {};
  for(let i = 0; i < n; i++){
    const id = 'rz' + t.toString(36) + '_' + i;
    list.push({id, title: 'Zip Song ' + i, song: 'Zip Song ' + i, artist: '', version: '', archived: false, pages: 1, hash: h, added: t, updated: t, ...(colls ? {colls: ['rzc' + t.toString(36) + (i % 2)]} : {})});
    if(i !== missing) z.file(`files/${id}.pdf`, pdf);
    if(ink) inkRecs[id + ':1'] = {updated: t, strokes: [{id: 'rzk' + i, t: 'pen', c: '#1a1a1a', w: .003, p: [[.1, .1], [.5, .5]], updated: t}]};
  }
  const cid = k => 'rzc' + t.toString(36) + k;
  z.file('library.json', JSON.stringify({app: 'setlist-stand', version: colls ? 3 : 2, saved: new Date().toISOString(), songs: list,
    sets: [{id: 'rzset' + t.toString(36), name: 'Zip Set', items: list.map(x => ({type: 'song', id: x.id})), ...(colls ? {colls: [cid(0)]} : {}), created: t, updated: t}], ink: inkRecs,
    ...(colls ? {colls: [{id: cid(0), name: 'Zip A', created: t, updated: t}, {id: cid(1), name: 'Zip B', created: t, updated: t}, {id: cid(2), deleted: true, updated: t}]} : {})}));
  return z.generateAsync({type: 'nodebuffer', compression: 'STORE'});
}
async function unchangedAfter(s, buf, name){
  const f = path.join(TMP, name); await fsp.writeFile(f, buf);
  const before = await snapshot(s.page);
  const msg = await restoreAny(s.page, f, 60000);
  const after = await snapshot(s.page);
  const d = diff(before, after, '', [], 8);
  const errs = [];
  if(d.length) errs.push(`${name}: existing library changed (${Object.keys(after.songs).length - Object.keys(before.songs).length} song records added; toast "${msg}"): ${d.slice(0, 4).join('; ')}`);
  if(/^Restored/.test(msg)) errs.push(`${name}: toast says "${msg}" for a damaged backup`);
  else if(!msg.trim()) errs.push(`${name}: no message shown`);
  return errs;
}
async function loopCorrupt(ctx){
  const s = await seeded(ctx);
  try{
    const good = await v2zip(3), errs = [];
    errs.push(...await unchangedAfter(s, good.subarray(0, Math.floor(good.length * .6)), 'truncated.zip'));
    /* flip bytes inside the last PDF's data: the zip's CRC-32 no longer matches */
    const bad = Buffer.from(good), pdf = fs.readFileSync(path.join(FIX, 'one-page.pdf'));
    const at = bad.lastIndexOf(pdf);
    assert(at > 0, 'could not find PDF bytes in the generated zip');
    for(let i = 0; i < 16; i++) bad[at + Math.floor(pdf.length / 2) + i] ^= 0xff;
    errs.push(...await unchangedAfter(s, bad, 'crc-mismatch.zip'));
    assert(!errs.length, errs.join(' | '));
  } finally { await s.close(); }
}
async function loopMissingPdf(ctx){
  const s = await seeded(ctx);
  try{
    const errs = await unchangedAfter(s, await v2zip(4, {missing: 2}), 'missing-pdf.zip');
    assert(!errs.length, errs.join(' | '));
  } finally { await s.close(); }
}
/* Reload the page at several moments after the restore starts. Whatever the moment, the library must be exactly what it
   was before (the restore never got written) or the complete restored library, never a partial one. The moments are fixed
   delays, not "when some songs are written", because a restore that is all-or-nothing never shows a half-written state. */
async function loopInterrupt(ctx){
  let file = ctx.library, src = 'real library', delays = [150, 700, 1500, 3000];
  if(!file){ file = path.join(TMP, 'roundtrip-60.zip'); await fsp.writeFile(file, await v2zip(60)); src = 'generated 60-song zip'; delays = [20, 80, 200, 500]; }
  const keys = o => Object.keys(o).sort().join();
  const stores = ['songs', 'files', 'sets', 'ink'];
  /* the record keys a complete restore ADDS (each session seeds its own few records with random ids, so compare
     "this session's records + the restored ones", never one session's keys with another's) */
  const restored = {};
  { const s = await seeded(ctx);
    try{
      const before = await snapshot(s.page); await restoreZip(s.page, file); const full = await snapshot(s.page);
      for(const k of stores) restored[k] = Object.keys(full[k]).filter(x => !(x in before[k]));
    } finally { await s.close(); } }
  const plus = (b0, k) => [...Object.keys(b0[k]), ...restored[k]].sort().join();
  const outcomes = [];
  for(const delay of delays){
    const s = await seeded(ctx);
    try{
      const {page} = s;
      const b0 = await snapshot(page);
      await toLibrary(page);
      await page.setInputFiles('#restoreFile', file);
      await sleep(delay);
      await page.reload({waitUntil: 'load', timeout: 120000}).catch(() => {});
      await page.waitForSelector('#libList, #view', {timeout: 60000});
      await sleep(1500);
      const B = await snapshot(page);
      const same = stores.every(k => keys(B[k]) === keys(b0[k]));
      const done = stores.every(k => keys(B[k]) === plus(b0, k));
      outcomes.push(`${delay}ms: ${same ? 'unchanged' : done ? 'complete' : 'PARTIAL'}`);
      assert(same || done, `reload ${delay}ms into the restore of the ${src} left a PARTIAL library: ` +
        stores.map(k => `${k} ${Object.keys(B[k]).length} (before ${Object.keys(b0[k]).length}, complete ${Object.keys(b0[k]).length + restored[k].length})`).join(', '));
      /* This test reloads the page while it is still reading the picked file. WebKit reports that cancelled read as a failed
         blob fetch ("... due to access control checks") from the page being torn down; that is the interruption itself, not an app error. */
      const errs = process.env.SS_BROWSER === 'webkit' ? s.errors.filter(e => !/due to access control checks/i.test(e)) : s.errors;
      assert(errs.length === 0, 'page errors: ' + errs.join(' | '));
    } finally { await s.close(); }
  }
  if(ctx.opts.verbose) console.log('  interrupted restores: ' + outcomes.join('; '));
}

/* ---------- loop 7: the restore is written in ONE transaction ---------- */
/* Timing cannot prove all-or-nothing (a reload rarely lands between two small writes), so count instead. Before the app
   starts, IDBDatabase.prototype.transaction is wrapped: every call is recorded in window.__tx as {stores, mode, at, puts}
   (puts = IDBObjectStore.put calls made on that transaction). */
const TX_PROBE = () => {
  window.__tx = [];
  const tx = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put, recs = new WeakMap();
  IDBDatabase.prototype.transaction = function(names, mode, ...rest){
    const t = tx.call(this, names, mode, ...rest);
    const rec = {stores: (typeof names === 'string' ? [names] : Array.from(names)).sort(), mode: mode || 'readonly', at: performance.now(), puts: 0};
    window.__tx.push(rec); recs.set(t, rec);
    return t;
  };
  IDBObjectStore.prototype.put = function(...a){ const r = recs.get(this.transaction); if(r) r.puts++; return put.apply(this, a); };
};
/* The restore of a version 2 backup (no collections) and of a version 3 one (with them): each is exactly one readwrite transaction. */
async function loopOneTransaction(ctx){ await oneTransaction(ctx, false); await oneTransaction(ctx, true); }
async function oneTransaction(ctx, v3){
  const N = 12, file = path.join(TMP, 'roundtrip-onetx' + (v3 ? '-v3' : '') + '.zip');
  await fsp.writeFile(file, await v2zip(N, {ink: true, colls: v3}));
  const data = await libJson(await readZip(file));
  /* every record the restore must write: a PDF + a song record per live song, each set, each ink page */
  const want = {stores: v3 ? ['colls', 'files', 'ink', 'sets', 'songs'] : ['files', 'ink', 'sets', 'songs'], puts: 2 * data.songs.length + data.sets.length + Object.keys(data.ink).length + (data.colls || []).length};
  const s = await seeded(ctx, TX_PROBE);
  try{
    const {page} = s;
    await toLibrary(page);
    assert(await page.evaluate(() => Array.isArray(window.__tx) && window.__tx.length > 0), 'the transaction probe is not installed (window.__tx empty after seeding)');
    /* start counting now; note the moment the "Restored" toast appears */
    await page.evaluate(() => {
      window.__tx.length = 0; window.__toastAt = null;
      const t = document.querySelector('#toast');
      new MutationObserver(() => { if(window.__toastAt == null && /^Restored/.test(t.textContent)) window.__toastAt = performance.now(); })
        .observe(t, {childList: true, characterData: true, subtree: true});
    });
    const msg = await restoreZip(page, file);
    assert(new RegExp(`Restored ${N} songs and 1 setlist\\b`).test(msg), 'restore toast: ' + msg);
    const {tx, toastAt} = await page.evaluate(() => ({tx: window.__tx.slice(), toastAt: window.__toastAt}));
    assert(toastAt != null, 'the "Restored" toast time was not recorded');
    /* THE RULE. Counted: every readwrite transaction that started before the "Restored" toast appeared (later ones are not
       part of the restore). Not counted, and only these: a transaction touching nothing but 'songs' that started AFTER a
       transaction covering all four stores had started. Those are the separate song-record updates the app makes once the
       restore is written (ensureHashes filling in a missing hash, load() upgrading a record). A songs-only write BEFORE
       the all-stores transaction is counted: that would be the restore itself writing songs one by one. */
    const rw = tx.filter(t => t.mode === 'readwrite' && t.at < toastAt);
    const firstAll = rw.find(t => want.stores.every(k => t.stores.includes(k)));
    const counted = rw.filter(t => !(firstAll && t !== firstAll && t.at >= firstAll.at && t.stores.join() === 'songs'));
    const show = l => l.map(t => `[${t.stores.join('+')}: ${t.puts} put${t.puts == 1 ? '' : 's'}]`).join(' ');
    assert(counted.length === 1, `restore wrote in ${counted.length} readwrite transactions, expected exactly 1: ${show(counted.slice(0, 12))}${counted.length > 12 ? ' …' : ''}`);
    const [one] = counted;
    assert(one.stores.slice().sort().join() === want.stores.join(), `the restore transaction covers ${one.stores.join(', ')}, expected ${want.stores.join(', ')}`);
    assert(one.puts === want.puts, `the restore transaction made ${one.puts} puts, expected ${want.puts} (${N} PDFs + ${N} songs + ${data.sets.length} set + ${(data.colls || []).length} collections + ${Object.keys(data.ink).length} ink pages)`);
    if(ctx.opts.verbose) console.log('  readwrite transactions during the restore: ' + show(rw));
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- loop: a version 2 backup (made before collections) restores with no collections ---------- */
async function loopV2(ctx){
  const file = path.join(TMP, 'roundtrip-v2.zip');
  await fsp.writeFile(file, await v2zip(4, {ink: true}));
  assert((await libJson(await readZip(file))).version === 2, 'the generated backup is not version 2');
  const s = await ctx.session();
  try{
    await s.goto();
    const msg = await restoreZip(s.page, file);
    assert(/^Restored 4 songs and 1 setlist\b/.test(msg), 'restore toast: ' + msg);
    const A = await snapshot(s.page);
    assert(Object.keys(A).includes('colls') && !Object.keys(A.colls).length, 'a version 2 restore made collections: ' + JSON.stringify(A.colls));
    for(const x of [...Object.values(A.songs), ...Object.values(A.sets)]) assert(Array.isArray(x.colls) && x.colls.length === 0, 'no `colls: []` on a record restored from version 2: ' + JSON.stringify(x).slice(0, 160));
    const {file: b3} = await backupNow(s.page);
    const d = await libJson(await readZip(b3));
    assert(d.version === 3 && Array.isArray(d.colls) && !d.colls.length, 'the backup of it: version ' + d.version + ', colls ' + JSON.stringify(d.colls));
    await wipeReload(s);
    await restoreZip(s.page, b3);
    expectSame(A, await snapshot(s.page), 'version 2 restore (left) vs restore of its version 3 backup (right)');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- loop: a field the app does not know survives (Sync compatibility 2 and 3) ----------
   A song and a setlist carrying `zzz: 1` go through Edit, a collection tick, a backup and a restore, and through deleting the
   collection, with the field intact; and deleting the collection moves `updated` on exactly the records that held it. */
async function putRaw(page, store, id, fields){      // (no eval: the page's CSP forbids it, so the fields are data, not code)
  await page.evaluate(([store, id, fields]) => new Promise((res, rej) => {
    const r = indexedDB.open('setlist-stand');
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const d = r.result, t = d.transaction(store, 'readwrite'), st = t.objectStore(store), g = st.get(id);
      g.onsuccess = () => { st.put(Object.assign(g.result, fields), id); };
      t.oncomplete = () => { d.close(); res(); }; t.onerror = () => rej(t.error);
    };
  }), [store, id, fields]);
}
async function loopUnknownFields(ctx){
  const s = await seeded(ctx);
  try{
    const {page} = s;
    const [one, two] = (await songs(page)).sort((a, b) => a.song < b.song ? -1 : 1).map(x => x.id);     // One-page, Three-page, Two-page by name: use the first two
    await newSet(page, 'Unknown');
    await addSongs(page, [(await songRec(page, one)).title]);
    const setId = (await setNamed(page, 'Unknown')).id;
    for(const [store, id] of [['songs', one], ['songs', two], ['sets', setId]]) await putRaw(page, store, id, {zzz: 1, zzzObj: {k: [1, 2]}});
    await page.reload(); await page.waitForSelector('#libList [data-open]');       // load() runs upgradeSong / upgradeSet on the planted records
    const keep = async what => {
      for(const [store, id] of [['songs', one], ['songs', two], ['sets', setId]]){
        const r = (await idbAll(page, store))[id];
        assert(r && r.zzz === 1 && JSON.stringify(r.zzzObj) === '{"k":[1,2]}', `${what}: ${store} ${id} lost its unknown fields: ` + JSON.stringify(r));
      }
    };
    await keep('after a reload (upgrade in place)');
    const C = await makeColl(page, 'Keep');
    /* Edit (title, plus a collection tick), then a tick on the setlist */
    await toLibrary(page);
    await page.click(`#libList [data-edit="${one}"]`);
    await page.locator('.modal input[data-k=song]').fill('Edited Name');
    await page.locator(`.modal fieldset.checks input[value="${C}"]`).check();
    await page.click('.modal [data-ok]'); await noModal(page);
    await tickSet(page, 'Unknown', [C]);
    await waitFor(async () => sameSet((await songRec(page, one)).colls, [C]) && sameSet((await setNamed(page, 'Unknown')).colls, [C]), 'ticks not saved');
    assert((await songRec(page, one)).song === 'Edited Name', 'edit not saved');
    await keep('after Edit and a collection tick');
    /* Copy keeps them too (it spreads the whole record) */
    await toLibrary(page);
    await page.click(`#libList [data-copy="${one}"]`);
    await page.locator('.copyask input').fill('with field');
    await page.click('.copyask [data-ok]'); await noModal(page);
    const copy = await waitFor(async () => (await songs(page)).find(x => x.version === 'with field'), 'copy not saved');
    assert(copy.zzz === 1 && sameSet(copy.colls, [C]), 'the copy lost the unknown field or the collection: ' + JSON.stringify(copy));
    /* backup -> wipe -> restore */
    const A = await snapshot(page);
    const {file} = await backupNow(page);
    const d = await libJson(await readZip(file));
    assert(d.songs.find(x => x.id === one).zzz === 1 && d.sets.find(x => x.id === setId).zzz === 1, 'the backup lost the unknown fields');
    await wipeReload(s);
    await restoreZip(page, file);
    expectSame(A, await snapshot(page), 'before the backup (left) vs after wipe + restore (right)');
    await keep('after backup, wipe and restore');
    /* deleting the collection: the records that held it get a new `updated`; the others do not; the field stays */
    const before = {songs: await idbAll(page, 'songs'), sets: await idbAll(page, 'sets')};
    await deleteColl(page, C);
    await waitFor(async () => (await idbAll(page, 'colls'))[C]?.deleted === true, 'collection marker not saved');
    const after = {songs: await idbAll(page, 'songs'), sets: await idbAll(page, 'sets')};
    for(const store of ['songs', 'sets']) for(const [id, r] of Object.entries(after[store])){
      const held = (before[store][id].colls || []).includes(C);
      assert(held ? r.updated > before[store][id].updated && !r.colls.includes(C) : r.updated === before[store][id].updated, `${store} ${id} (${held ? 'held' : 'did not hold'} the collection): updated ${before[store][id].updated} -> ${r.updated}, colls ${JSON.stringify(r.colls)}`);
    }
    await keep('after deleting the collection');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'roundtrip: backup → wipe → restore reproduces every record', run: loopBackupRestore},
  {name: 'roundtrip: second generation backup is identical', run: loopSecondGeneration},
  {name: 'roundtrip: v1 backup upgrades and survives a round trip', run: loopV1},
  {name: 'roundtrip: real library round trip', needs: ['library'], run: loopRealLibrary},
  {name: 'roundtrip: converter output matches the MobileSheets backup it came from', needs: ['msb', 'library'], run: loopConverter},
  {name: 'roundtrip: a version 2 backup restores with no collections, and its version 3 backup round trips', run: loopV2},
  {name: 'roundtrip: unknown fields survive Edit, a collection tick, Copy, backup, restore and deleting the collection; `updated` moves on exactly the records that held it', run: loopUnknownFields},
  {name: 'roundtrip: restore all or nothing: truncated or CRC-damaged zip changes nothing', run: loopCorrupt},
  {name: 'roundtrip: restore all or nothing: a backup missing a PDF changes nothing', run: loopMissingPdf},
  {name: 'roundtrip: restore all or nothing: reload mid-restore leaves before or after, never partial', run: loopInterrupt},
  {name: 'roundtrip: restore writes everything in one transaction', run: loopOneTransaction},
];

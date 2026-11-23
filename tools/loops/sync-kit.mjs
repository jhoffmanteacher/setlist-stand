/*
 * Shared pieces for the sync loops sync 3 (deletions), sync 4 (a hostile or broken Drive) and sync 5 (nothing without a tap).
 * Built on sync-two.mjs (tablets, the Sync button, reading Drive); this file adds the library both tablets start from, edits
 * made the way the app makes them, files planted on Drive by hand, and the "library is whole" check.
 *
 *   const A = await startA(ctx)                 fixtures + details, crops, ink, an archived song, a collection "Band One" (cband)
 *                                               and three setlists: "Gig: Friday", "Rehearsal" (srehearsal), "Spare" (sspare)
 *   const {A, B} = await startPair(ctx)         A synced, B made from A's backup and synced (nothing to do)
 *   whole(lib) -> [problems]                    every live song has its PDF (hash equal), no PDF or ink without a live song
 *   putRecordFile(google, drive, kind, rec, {props, content})   a record file in the data folder, made or replaced by hand
 *   putPdfFile(google, drive, id, bytes, {h})   a PDF file in Charts, made or replaced by hand
 *   addCopies(t, n, tag, {from})                n new songs (new ids, each with its own copy of a PDF) written straight into storage
 */
import fs from 'node:fs';
import path from 'node:path';
import {FIX, assert, sleep, diff, sha256, idbAll} from './harness.mjs';
import {buildLibrary} from './share-lib.mjs';
import {openTablet, makeFromBackup, syncTap, libraryOf, readDrive} from './sync-two.mjs';
import {canonHash, titleOf} from './sync-model.mjs';
import {songDelete} from './songrow.mjs';

export const YEAR = 365 * 864e5;
export const H = f => sha256(fs.readFileSync(path.join(FIX, f)));
export const fixture = f => fs.readFileSync(path.join(FIX, f));
export const live = (lib, kind = 'songs') => Object.values(lib[kind]).filter(r => !r.deleted);
export const songBy = (lib, start) => live(lib).find(s => s.title.toLowerCase().startsWith(start.toLowerCase()));
export const pageErrors = t => t.s.errors.filter(e => e.startsWith('pageerror'));
export const libOnly = lib => ({songs: lib.songs, sets: lib.sets, colls: lib.colls, files: lib.files, ink: lib.ink});
export const noModal = page => page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 8000});
/* the record without its top-level `updated` (two tablets doing the same thing at different moments) */
export const timeless = r => { if(!r || typeof r !== 'object') return r; const o = {...r}; delete o.updated; return o; };
export const timelessLib = lib => Object.fromEntries(Object.entries(libOnly(lib)).map(([k, v]) => [k, k === 'files' ? v : Object.fromEntries(Object.entries(v).map(([id, r]) => [id, timeless(r)]))]));

export async function startA(ctx, {name = 'A'} = {}){
  const A = await openTablet(ctx, {name, fixtures: true});
  await buildLibrary(A.page);
  await A.page.evaluate(async () => {
    const st = await import('./js/store.js'), t = Date.now();
    await st.putAll([{store: 'colls', key: 'cband', value: {id: 'cband', name: 'Band One', created: t, updated: t}}]);
    await st.load();
    for(const s of st.state.songs.filter(s => !s.archived)){ s.colls = ['cband']; await st.saveSong(s); }
    for(const x of st.state.sets){ x.colls = ['cband']; await st.saveSet(x); }
    const by = w => st.state.songs.find(s => s.title.toLowerCase().startsWith(w));
    await st.saveSet({id: 'srehearsal', name: 'Rehearsal', created: t, colls: ['cband'], items: [{type: 'song', id: by('fixture alpha').id}, {type: 'song', id: by('two-page').id}]});
    await st.saveSet({id: 'sspare', name: 'Spare', created: t, colls: [], items: [{type: 'song', id: by('fixture alpha').id}]});
    await st.load();
  });
  await A.page.reload(); await A.page.waitForSelector('#libList [data-open]');
  return A;
}
/* The songs and setlists of startA by role: a = Fixture Alpha (one-page), b = two-page (ink, in Gig and Rehearsal), c = three-page (archived) */
export function roles(lib){
  const r = {a: songBy(lib, 'Fixture Alpha'), b: songBy(lib, 'two-page'), c: songBy(lib, 'three-page'),
    gig: live(lib, 'sets').find(x => x.name === 'Gig: Friday'), reh: lib.sets.srehearsal, spare: lib.sets.sspare};
  assert(Object.values(r).every(Boolean) && r.c.archived && Object.keys(lib.ink).some(k => k.startsWith(r.b.id + ':')), 'the test library is not what the loop needs');
  return r;
}
export async function startPair(ctx){
  const A = await startA(ctx);
  let B = null;
  try{
    const ra = await syncTap(A);
    assert(ra.state === 'finished', 'the first Sync on A did not finish: ' + ra.text);
    B = await makeFromBackup(ctx, A);
    const rb = await syncTap(B);
    assert(rb.state === 'finished' && /Everything is up to date/.test(rb.text), 'B, restored from A\'s backup, had something to do at its first Sync: ' + rb.text);
    return {A, B};
  }catch(e){ await A.close(); if(B) await B.close(); throw e; }
}

/* A library is whole: every live song has its PDF with the recorded hash; no PDF and no ink page without a live song. */
export function whole(lib){
  const out = [];
  for(const s of live(lib)) if(lib.files[s.id] !== s.hash) out.push(`the song "${s.title}" has ${lib.files[s.id] ? 'another PDF' : 'no PDF'}`);
  for(const id of Object.keys(lib.files)) if(!lib.songs[id] || lib.songs[id].deleted) out.push(`a PDF (${id}) with no live song`);
  for(const k of Object.keys(lib.ink)){ const id = k.split(':')[0]; if(!lib.songs[id] || lib.songs[id].deleted) out.push(`an ink page ${k} with no live song`); }
  return out;
}
export async function assertWhole(t, what){
  const p = whole(await libraryOf(t));
  assert(!p.length, `${what}: ${t.name}'s library is not whole: ${p.slice(0, 6).join(' | ')}`);
}

/* ---------- edits made the way the app makes them ---------- */
export async function showAll(page, tab = '#tLib'){
  await page.click(tab);
  if(await page.locator('.collbar [data-collpick="all"]').count()) await page.click('.collbar [data-collpick="all"]');
}
/* Runs fn and waits until the stored record changed. */
export async function until(t, store, id, fn){
  const before = JSON.stringify((await idbAll(t.page, store))[id]);
  await fn();
  const end = Date.now() + 15000;
  while(JSON.stringify((await idbAll(t.page, store))[id]) === before){ if(Date.now() > end) throw new Error(`${t.name}: the ${store} record ${id} did not change`); await sleep(100); }
  await sleep(100);
}
export async function deleteSongUi(t, id){
  const {page} = t;
  await until(t, 'songs', id, async () => {
    await showAll(page);
    if(!(await page.isChecked('#showArch').catch(() => false))) await page.check('#showArch').catch(() => {});
    await songDelete(page, id);
  });
}
export async function deleteSetUi(t, id){
  const {page} = t;
  await until(t, 'sets', id, async () => {
    await showAll(page, '#tSets');
    if(await page.locator('[data-allsets]').count()) await page.click('[data-allsets]');
    const b = page.locator(`#view [data-delset="${id}"]`);
    await b.click(); await b.click();
  });
}
export async function deleteCollUi(t, cid){
  const {page} = t;
  await until(t, 'colls', cid, async () => {
    await page.click('#tLib');
    await page.click('[data-collmanage]');
    const b = page.locator(`.collmgr [data-mdel="${cid}"]`);
    await b.click(); await b.click();
  });
  if(await page.locator('.collmgr [data-x]').count()) await page.click('.collmgr [data-x]');
  await noModal(page);
}
/* A change saved through the store (saveSong / saveSet stamp it as every edit screen does). */
export const saveSong = (t, id, change) => t.page.evaluate(async ({id, change}) => {
  const st = await import('./js/store.js'), s = structuredClone(st.state.songs.find(x => x.id === id));
  Object.assign(s, change); await st.saveSong(s); await st.load();
  return (await st.get('songs', id));
}, {id, change});
export const saveSet = (t, id, change) => t.page.evaluate(async ({id, change}) => {
  const st = await import('./js/store.js'), s = structuredClone(st.state.sets.find(x => x.id === id));
  Object.assign(s, change); await st.saveSet(s); await st.load();
  return (await st.get('sets', id));
}, {id, change});
/* Writes records straight into storage (a hand-made test case). */
export const writeRecords = (t, ops) => t.page.evaluate(async ops => {
  const st = await import('./js/store.js');
  await st.putAll(ops); await st.load();
}, ops);
/* n new songs: copies of an existing song's PDF under new ids (each its own PDF on Drive), not archived, in no collection. */
export const addCopies = (t, n, tag, {from = null} = {}) => t.page.evaluate(async ({n, tag, from}) => {
  const st = await import('./js/store.js'), songs = st.state.songs.filter(s => !s.archived), ops = [], ids = [];
  for(let k = 0; k < n; k++){
    const s = from ? st.state.songs.find(x => x.id === from) : songs[k % songs.length], blob = new Blob([await (await st.get('files', s.id)).arrayBuffer()], {type: 'application/pdf'}), t0 = Date.now() + k;
    const id = `cp${tag}${k}`, version = `${tag} ${k}`;
    const rec = {...structuredClone(s), id, version, archived: false, colls: [], added: t0, updated: t0};
    delete rec.crop;
    rec.title = rec.song + (version ? ` (${version})` : '') + (rec.artist ? ` - ${rec.artist}` : '');
    ops.push({store: 'files', key: id, value: blob}, {store: 'songs', key: id, value: rec});
    ids.push(id);
  }
  await st.putAll(ops); await st.load();
  return ids;
}, {n, tag, from});

/* Marks: a pen stroke with a given id on page pn, added to what the page already has (through putInk, as drawing saves). */
export const addMark = (t, songId, pn, sid) => t.page.evaluate(async ({songId, pn, sid}) => {
  const st = await import('./js/store.js'), cur = (st.upgradeInk(await st.get('ink', songId + ':' + pn)).record.strokes || []).filter(x => !x.deleted);
  await st.putInk(songId, pn, [...cur, {id: sid, t: 'pen', c: '#1a1a1a', w: .004, p: [[.2, .2], [.5, .5]], updated: Date.now()}]);
}, {songId, pn, sid});
/* the ids of the live strokes (and text notes) on one ink page of a library snapshot */
export const marksOn = (lib, songId, pn) => ((lib.ink[songId + ':' + pn] || {}).strokes || []).filter(x => !x.deleted).map(x => x.id).sort();

/* ---------- Drive edited by hand ---------- */
export const songRecord = (id, {title = id, hash, pages = 1, updated = Date.now(), ...more} = {}) =>
  ({id, title, song: title, artist: '', version: '', archived: false, colls: [], pages, hash, added: updated, updated, ...more});
const fileOf = (google, folder, k, id) => [...google.files.values()].find(f => !f.trashed && f.parents.includes(folder) && f.appProperties.k === k && f.appProperties.id === id);
/* A record file as the app writes it (properties from the record) unless props/content say otherwise; an existing file for the
   same kind and id is overwritten in place. props: values undefined are left out. */
export function putRecordFile(google, drive, kind, rec, {props = {}, content, name} = {}){
  const text = content ?? JSON.stringify(rec);
  const p = {k: kind, id: rec.id, u: String(rec.updated), c: canonHash(rec), ...(rec.deleted === true ? {d: '1'} : {}), ...props};
  for(const k of Object.keys(p)) if(p[k] === undefined) delete p[k];
  const old = fileOf(google, drive.data.id, kind, p.id);
  if(old){ Object.assign(old, {content: Buffer.from(text), appProperties: p, modifiedTime: new Date().toISOString()}); return old.id; }
  return google.addFile({name: name || `${kind}-${p.id}.json`, mimeType: 'application/json', parents: [drive.data.id], appProperties: p, content: text});
}
export function putPdfFile(google, drive, id, bytes, {h = sha256(bytes), name = id + '.pdf'} = {}){
  const old = fileOf(google, drive.charts.id, 'pdf', id), p = {k: 'pdf', id, h};
  if(old){ Object.assign(old, {content: Buffer.from(bytes), appProperties: p, modifiedTime: new Date().toISOString()}); return old.id; }
  return google.addFile({name, mimeType: 'application/pdf', parents: [drive.charts.id], appProperties: p, content: bytes});
}
export const removeDriveFile = (google, fileId) => { assert(google.files.has(fileId), 'no such Drive file ' + fileId); google.files.delete(fileId); };
export const recordFileId = (google, kind, id) => { const f = google.byProp('k', kind).find(f => f.appProperties.id === id); return f && f.id; };
export const pdfFileId = (google, id) => { const f = google.byProp('k', 'pdf').find(f => f.appProperties.id === id); return f && f.id; };

/* Waits until the top box's title matches re; returns {title, text}. */
export async function waitBox(t, re, ms = 30000){
  const end = Date.now() + ms;
  for(;;){
    const d = await t.page.evaluate(() => { const m = [...document.querySelectorAll('.modal')].at(-1); if(!m) return null; const h = m.querySelector('h2');
      return {title: h ? h.textContent.trim() : '', text: (m.innerText || m.textContent).replace(/\s+/g, ' ').trim()}; }).catch(() => null);
    if(d && re.test(d.title)) return d;
    if(Date.now() > end) throw new Error(`${t.name}: no box "${re.source}" came up (the top box is ${d ? '"' + d.title + '"' : 'none'})`);
    await sleep(100);
  }
}
export {diff, readDrive, libraryOf, titleOf};

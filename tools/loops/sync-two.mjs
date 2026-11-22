/*
 * Two tablets, one Drive: helpers for the sync loops (sync 2, and sync 3 / 4 / 5 build on them). The app runs for real; the
 * ONE stand-in is Google at the network edge (fake-google.mjs), shared by both tablets' browser contexts.
 *
 *   const A = await openTablet(ctx, {name: 'A', fixtures: true})    a tablet (own browser context) with a fresh stand-in Drive
 *   const B = await openTablet(ctx, {name: 'B', share: A})           a second tablet on the SAME Drive (A.google === B.google's Drive)
 *   const B = await makeFromBackup(ctx, A)                           B started the recommended way: A's backup (real Back up button)
 *                                                                    restored on a fresh tablet (real Restore): same ids as A
 *   const rep = await syncTap(A, {answers: {'Gig: Friday': 'delete', 'Two-page': 'keep'}})
 *        taps Sync, gets through "Sync your tablets" and "Sign in to sync" (the sign-in is in memory only, so after any reload
 *        the tablet signs in again), answers the "Deleted on your other tablet" box by name (rows not named are left alone;
 *        close: 'done' | 'escape'), reads the report box and closes it: {title, text, state: 'finished'|'stopped'|'failed', asked: [row texts]}
 *        Split in two for loops that act mid-run: await tapSync(A) (returns once a sync box is up), then await finishSync(A, opts).
 *   await libraryOf(A) -> {songs, sets, colls, files: {id: sha256}, ink}   the tablet's stored library (snapshot(), normalised)
 *   readDrive(A.google) -> {home, charts, data, recs: {song, set, coll: Map id -> record}, pdfs: Map id -> {hash, name, fileId},
 *                           foreign: [files that are not ours], problems: [layout faults]}   read from the stand-in's own files
 *   reportCounts(rep.text) -> {sent: {song, set, coll}, got: {...}, upToDate, both: 'the "changed on both tablets" part'}
 *   await setClock(A, ms) moves A's clock (A's browser context only) ms from real time; await clockOf(A) reads it
 *   await takeWrites(A) -> the IndexedDB puts and deletes since the last call ({tx, op, store, key}); halfSongs(writes) -> problems
 *   A.watch: {violations: [], songWrites, pdfRemovals}  filled as requests reach the stand-in: a song record written to Drive while
 *        its PDF (same id, same hash, bytes matching) is not there yet, or a PDF removed while its song is still live on Drive
 *   A.page, A.s (session: errors, requests), A.google (the stand-in view, requests tagged by: A.name), await A.close()
 */
import crypto from 'node:crypto';
import {sleep, snapshot, normalise, backupNow, restoreZip} from './harness.mjs';
import {importFixtures} from './share-lib.mjs';
import {installFakeGoogle} from './fake-google.mjs';
import {parseMultipart} from './fake-google-query.mjs';
import {KINDS, canonHash, pdfName, titleOf} from './sync-model.mjs';

const FOLDER = 'application/vnd.google-apps.folder';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const authCount = g => g.requests.filter(r => r.kind === 'auth').length;
export const HOME_NAME = 'Setlist Stand', CHARTS_NAME = 'Charts', DATA_NAME = 'Library data (do not edit)';
export const REPORT_TITLES = /^Sync (finished|stopped|could not finish)/;

export async function openTablet(ctx, {name = 'A', share = null, fixtures = false} = {}){
  /* Playwright's WebKit cannot intercept requests from a page a service worker controls (sync.loop.mjs): the worker is off there. */
  const s = await ctx.session({serviceWorkers: process.env.SS_BROWSER === 'webkit' ? 'block' : 'allow'});
  const google = await installFakeGoogle(s.context, {appBase: ctx.base, name, ...(share ? {share: share.google} : {})});
  const t = {name, ctx, s, page: s.page, context: s.context, google, watch: {violations: [], songWrites: 0, pdfRemovals: 0},
    async close(){ await s.close(); }};
  await watchOrder(t);
  await recordTransactions(s.context);
  await s.goto('');
  if(fixtures) await importFixtures(s.page);
  return t;
}

/* ---------- the order rule, checked at the moment Drive receives each write ----------
   Registered after the stand-in, so it sees each request first and then hands it on unchanged (route.fallback()). */
async function watchOrder(t){
  const g = t.google, w = t.watch;
  const say = msg => { if(w.violations.length < 50) w.violations.push(msg); };
  const pdfOk = (id, hash) => [...g.files.values()].some(f => !f.trashed && f.appProperties.k === 'pdf' && f.appProperties.id === id && f.appProperties.h === hash && sha(g.fileBytes(f.id)) === hash);
  const songOnDrive = id => [...g.files.values()].find(f => !f.trashed && f.appProperties.k === 'song' && f.appProperties.id === id);
  function removing(f){
    if(!f || f.appProperties.k !== 'pdf') return;
    w.pdfRemovals++;
    const rec = songOnDrive(f.appProperties.id);
    if(!rec || rec.appProperties.d !== '1') say(`the PDF "${f.name}" was removed from Drive while its song record there is ${rec ? 'live' : 'missing'} (the marker must be up first)`);
  }
  async function inspect(r){
    const u = new URL(r.url()), q = Object.fromEntries(u.searchParams), method = r.method();
    if(method === 'OPTIONS') return;
    const plain = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if(plain){
      const f = g.files.get(decodeURIComponent(plain[1]));
      if(method === 'DELETE') removing(f);
      else if(method === 'PATCH' && /"trashed"\s*:\s*true/.test(r.postData() || '')) removing(f);
      return;
    }
    const up = u.pathname.match(/^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/);
    if(!up) return;
    const buf = r.postDataBuffer(); if(!buf) return;
    const target = up[1] ? g.files.get(decodeURIComponent(up[1])) : null;
    let kind = null, content = null;
    if(method === 'PUT'){
      const sess = g.sessions.get(q.upload_id); if(!sess) return;
      const f = sess.fileId && g.files.get(sess.fileId);
      kind = (sess.body.appProperties || {}).k || (f && f.appProperties.k); content = buf;
    }else if(q.uploadType === 'multipart'){
      const parts = parseMultipart((await r.allHeaders())['content-type'], buf);
      if(parts.length !== 2) return;
      let meta = {}; try{ meta = JSON.parse(parts[0].body.toString('utf8')); }catch(e){}
      kind = (meta.appProperties || {}).k || (target && target.appProperties.k); content = parts[1].body;
    }else if(q.uploadType === 'media'){ kind = target && target.appProperties.k; content = buf; }
    else return;                                          // a resumable session being opened: its bytes come with the PUT
    if(kind === 'pdf' && target && (target.trashed)) say(`a PDF was written into a trashed file "${target.name}"`);
    if(kind !== 'song') return;
    let rec;
    try{ rec = JSON.parse(content.toString('utf8')); }catch(e){ say('a song record sent to Drive is not JSON'); return; }
    if(!rec || rec.deleted) return;
    w.songWrites++;
    if(!pdfOk(rec.id, rec.hash)) say(`the record of "${rec.title}" (${rec.id}) reached Drive before its PDF with hash ${String(rec.hash).slice(0, 12)}`);
  }
  await t.context.route('https://www.googleapis.com/**', async route => {
    try{ await inspect(route.request()); }catch(e){ say('order watcher: ' + e.message); }
    await route.fallback();
  });
}

/* ---------- which records each IndexedDB transaction wrote ----------
   Observed in the page (the app's code is not changed): every put and delete, with its transaction, store and key, so a loop
   can check that a song's PDF and its record were written together ("a song is never half there"). */
function recordTransactions(context){
  return context.addInitScript(() => {
    if(window.__s2tx) return;
    const log = window.__s2tx = [], ids = new WeakMap();
    let n = 0;
    const T = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(...a){ const t = T.apply(this, a); ids.set(t, ++n); return t; };
    for(const op of ['put', 'delete']){
      const f = IDBObjectStore.prototype[op];
      IDBObjectStore.prototype[op] = function(...a){
        try{
          const key = op === 'put' ? a[1] : a[0];
          log.push({tx: ids.get(this.transaction), op, store: this.name, key: typeof key === 'string' ? key : null});
          if(log.length > 20000) log.splice(0, 5000);
        }catch(e){}
        return f.apply(this, a);
      };
    }
  });
}
/* The writes logged since the last call (the log restarts with each page load). */
export const takeWrites = t => t.page.evaluate(() => { const l = window.__s2tx || []; const out = l.slice(); l.length = 0; return out; });
/* Problems: a PDF put without its song record in the same transaction. */
export function halfSongs(writes){
  const out = [];
  for(const w of writes) if(w.op === 'put' && w.store === 'files' && !writes.some(x => x.tx === w.tx && x.op === 'put' && x.store === 'songs' && x.key === w.key))
    out.push(`the PDF of song ${w.key} was written without its record in the same transaction`);
  return out;
}

/* ---------- dialogs ---------- */
const top = page => page.evaluate(() => {
  const m = [...document.querySelectorAll('.modal')].at(-1); if(!m) return null;
  const h = m.querySelector('h2');
  return {title: h ? h.textContent.replace(/\s+/g, ' ').trim() : '', text: (m.innerText || m.textContent).replace(/\s+/g, ' ').trim()};
}).catch(() => null);                                    // the page is between two documents (the trip to Google)
const press = (page, label) => page.locator('.modal').last().getByRole('button', {name: label, exact: true}).click();
const settled = async (page, ms = 20000) => {
  const end = Date.now() + ms;
  while(Date.now() < end){
    if(await page.evaluate(() => document.readyState === 'complete' && !!document.querySelector('#libDrive [data-drivestatus]')).catch(() => false)) return;
    await sleep(150);
  }
  throw new Error('the Library did not come back after the sign-in');
};
const stamp = (t, what) => `${t.name}: ${what}`;

/* Signs in from the Library's Connect button (Sync signs in by itself; this is for loops that want to be signed in first). */
export async function signIn(t){
  const {page, google} = t;
  Object.assign(google.auth, {mode: 'ok', expiresIn: 3599});
  const n0 = authCount(google);
  await page.click('#tLib');
  await page.click('#libDrive [data-driveconnect]');
  await page.click('.modal [data-ok]');
  const end = Date.now() + 20000;
  while(authCount(google) === n0){ if(Date.now() > end) throw new Error(stamp(t, 'the app never went to the sign-in address')); await sleep(100); }
  await sleep(300); await settled(page);
  const d = await top(page);
  if(d) throw new Error(stamp(t, `a box after signing in: ${d.title}: ${d.text.slice(0, 200)}`));
}

/* Taps Sync and gets through the first-time note and the sign-in. Returns the first sync box ({title, text}). */
export async function tapSync(t, {timeout = 40000} = {}){
  const {page, google} = t;
  Object.assign(google.auth, {mode: 'ok', expiresIn: 3599});
  await page.click('#tLib');
  if(await top(page)) throw new Error(stamp(t, 'a box is open before Sync was tapped: ' + (await top(page)).title));
  await page.click('#libDrive [data-syncnow]');
  const end = Date.now() + timeout;
  let intro = 0, trips = 0;
  for(;;){
    const d = await top(page);
    if(d){
      if(/^Sync your tablets/.test(d.title)){ if(++intro > 1) throw new Error(stamp(t, 'the first-time note came twice')); await press(page, 'Continue'); await sleep(150); continue; }
      if(/^Sign in to sync/.test(d.title)){
        if(++trips > 2) throw new Error(stamp(t, 'asked to sign in three times in one Sync'));
        const n0 = authCount(google);
        await page.click('.modal [data-ok]');
        while(authCount(google) === n0){ if(Date.now() > end) throw new Error(stamp(t, 'Continue never went to the sign-in address')); await sleep(100); }
        await sleep(300); await settled(page);
        continue;
      }
      if(/^(Syncing|Deleted on your other tablet)/.test(d.title) || REPORT_TITLES.test(d.title)) return d;
      throw new Error(stamp(t, `an unexpected box while starting a sync: "${d.title}": ${d.text.slice(0, 240)}`));
    }
    if(Date.now() > end) throw new Error(stamp(t, 'no sync box came up after tapping Sync' + (trips ? ' and signing in (the sync did not start by itself)' : '')));
    await sleep(100);
  }
}

/* Answers the deletion box by name (the longest name a row holds), one row at a time: Keep, or Delete here tapped twice.
   A row is the list item holding a Keep button. Returns the rows as they were when the box came up. */
async function answerDeletions(t, answers, close){
  const {page} = t, done = new Set();
  const scan = () => page.evaluate(() => {
    const m = [...document.querySelectorAll('.modal')].at(-1); if(!m) return [];
    const txt = e => (e.innerText || e.textContent).replace(/\s+/g, ' ').trim();
    return [...m.querySelectorAll('li, .row')].filter(r => !r.querySelector('li, .row')).map((row, i) => {
      const bs = [...row.querySelectorAll('button')], keep = bs.find(b => txt(b) === 'Keep'), del = bs.find(b => /^Delete here/.test(txt(b)));
      if(keep) keep.dataset.s2keep = String(i);
      if(del) del.dataset.s2del = String(i);
      return {i, text: txt(row), keep: !!keep, del: !!del};
    });
  });
  const rows = (await scan()).map(r => r.text);
  for(let guard = 0; guard < 200; guard++){
    const list = await scan();
    const next = list.map(r => ({...r, name: Object.keys(answers).filter(n => r.text.includes(n)).sort((a, b) => b.length - a.length)[0]}))
      .find(r => r.name && !done.has(r.name) && (r.keep || r.del));
    if(!next) break;
    done.add(next.name);
    const m = page.locator('.modal').last();
    if(answers[next.name] === 'keep'){
      if(!next.keep) throw new Error(stamp(t, `the deletion row "${next.text}" has no Keep button`));
      await m.locator(`[data-s2keep="${next.i}"]`).click();
    }else if(answers[next.name] === 'delete'){
      if(!next.del) throw new Error(stamp(t, `the deletion row "${next.text}" has no Delete here button`));
      const b = m.locator(`[data-s2del="${next.i}"]`);
      await b.click(); await sleep(150); await b.click();
    }else throw new Error(`syncTap: the answer for "${next.name}" must be 'delete' or 'keep'`);
    await sleep(200);
  }
  if(close === 'done') await press(page, 'Done');
  else if(close === 'escape') await page.keyboard.press('Escape');
  return rows;
}

/* Waits for the end of the run (answering the deletion box), reads the report and closes it with OK. */
export async function finishSync(t, {answers = {}, close = 'done', timeout = 180000} = {}){
  const {page} = t, end = Date.now() + timeout, asked = [];
  let boxes = 0;
  for(;;){
    const d = await top(page);
    if(d && /^Deleted on your other tablet/.test(d.title)){
      if(++boxes > 1) throw new Error(stamp(t, 'the deletion box came twice in one run'));
      asked.push(...await answerDeletions(t, answers, close));
      if(close === 'none') return {title: d.title, text: d.text, state: 'asking', asked};
      await sleep(200); continue;
    }
    if(d && REPORT_TITLES.test(d.title)){
      const state = /finished/.test(d.title) ? 'finished' : /stopped/.test(d.title) ? 'stopped' : 'failed';
      await press(page, 'OK');
      await page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 8000}).catch(async () => { throw new Error(stamp(t, 'the report did not close on OK: ' + JSON.stringify(await top(page)))); });
      return {title: d.title, text: d.text, state, asked};
    }
    if(d && !/^Syncing/.test(d.title)) throw new Error(stamp(t, `an unexpected box during a sync: "${d.title}": ${d.text.slice(0, 240)}`));
    if(Date.now() > end) throw new Error(stamp(t, 'the sync did not end with a report: ' + (d ? d.text.slice(0, 200) : 'no box')));
    await sleep(120);
  }
}
export async function syncTap(t, opts = {}){
  await tapSync(t, opts);
  return finishSync(t, opts);
}

/* Starts tablet `name` from `from`'s backup, made and restored through the real buttons. {tablet, file}. */
export async function makeFromBackup(ctx, from, {name = 'B'} = {}){
  const bk = await backupNow(from.page);
  const t = await openTablet(ctx, {name, share: from});
  await restoreZip(t.page, bk.file);
  return Object.assign(t, {backupFile: bk.file});
}

/* ---------- reading ---------- */
export async function libraryOf(t){ return normalise(await snapshot(t.page)); }
export const clockOf = t => t.page.evaluate(() => Date.now());
export const setClock = (t, ms) => t.page.clock.setSystemTime(Date.now() + ms);

/* What is on the shared Drive, read from the stand-in's own store (not through the app), with the design's layout checked. */
export function readDrive(google){
  const live = [...google.files.values()].filter(f => !f.trashed), problems = [];
  const out = {home: null, charts: null, data: null, recs: {song: new Map(), set: new Map(), coll: new Map()}, pdfs: new Map(), foreign: [], problems, files: live};
  const charts = live.filter(f => f.mimeType === FOLDER && f.appProperties.setlistStand === 'charts');
  const data = live.filter(f => f.mimeType === FOLDER && f.appProperties.setlistStand === 'data');
  if(!charts.length && !data.length){ if(live.some(f => f.appProperties.k)) problems.push('files of the app with no sub-folders'); return out; }
  if(charts.length !== 1 || data.length !== 1){ problems.push(`${charts.length} Charts folders and ${data.length} data folders (one of each expected)`); }
  out.charts = charts[0] || null; out.data = data[0] || null;
  if(out.charts && out.charts.name !== CHARTS_NAME) problems.push(`the charts folder is named "${out.charts.name}"`);
  if(out.data && out.data.name !== DATA_NAME) problems.push(`the data folder is named "${out.data.name}"`);
  const parents = new Set([...charts, ...data].flatMap(f => f.parents));
  if(parents.size !== 1) problems.push('the sub-folders are not in one folder');
  out.home = google.files.get([...parents][0]) || null;
  if(!out.home || out.home.mimeType !== FOLDER || out.home.name !== HOME_NAME || !Object.keys(out.home.appProperties).length) problems.push('the sub-folders are not in the marked "Setlist Stand" folder');
  const ours = new Set([out.home && out.home.id, out.charts && out.charts.id, out.data && out.data.id].filter(Boolean));
  const keys = f => Object.keys(f.appProperties).sort().join(',');
  for(const f of live){
    const p = f.appProperties, k = p.k;
    if(ours.has(f.id)) continue;
    if(!k){ if(f.parents.some(x => ours.has(x))) out.foreign.push(f); continue; }
    if(k === 'pdf'){
      if(!out.charts || !f.parents.includes(out.charts.id)) problems.push(`the PDF "${f.name}" is not in the Charts folder`);
      if(keys(f) !== 'h,id,k') problems.push(`the PDF "${f.name}" has the properties ${keys(f)} (h, id, k expected)`);
      if(!/^[0-9a-f]{64}$/.test(p.h || '')) problems.push(`the PDF "${f.name}" has h=${p.h}`);
      if(sha(google.fileBytes(f.id)) !== p.h) problems.push(`the bytes of the PDF "${f.name}" do not match its h`);
      if(f.mimeType !== 'application/pdf') problems.push(`the PDF "${f.name}" is stored as ${f.mimeType}`);
      if(out.pdfs.has(p.id)) problems.push(`two PDF files for the song ${p.id}`);
      out.pdfs.set(p.id, {hash: p.h, name: f.name, fileId: f.id});
    }else if(KINDS.includes(k)){
      const where = `the record file "${f.name}"`;
      if(!out.data || !f.parents.includes(out.data.id)) problems.push(`${where} is not in the data folder`);
      if(f.name !== `${k}-${p.id}.json`) problems.push(`${where} should be named ${k}-${p.id}.json`);
      if(f.mimeType !== 'application/json') problems.push(`${where} is stored as ${f.mimeType}`);
      let rec = null;
      try{ rec = JSON.parse(google.fileBytes(f.id).toString('utf8')); }catch(e){ problems.push(`${where} is not JSON`); continue; }
      const marker = !!rec && rec.deleted === true;
      if(keys(f) !== (marker ? 'c,d,id,k,u' : 'c,id,k,u')) problems.push(`${where} has the properties ${keys(f)}`);
      if(marker !== (p.d === '1')) problems.push(`${where}: d=${p.d} for a ${marker ? 'deletion marker' : 'live record'}`);
      if(!rec || rec.id !== p.id) problems.push(`${where} holds the record ${rec && rec.id}`);
      if(p.u !== String(rec && rec.updated)) problems.push(`${where}: u=${p.u}, the record says ${rec && rec.updated}`);
      if(p.c !== canonHash(rec)) problems.push(`${where}: c is not the sha-256 of the canonical record`);
      if(out.recs[k].has(p.id)) problems.push(`two record files for ${k} ${p.id}`);
      out.recs[k].set(p.id, rec);
    }else problems.push(`a file of an unknown kind k=${k}: "${f.name}"`);
  }
  for(const [id, pdf] of out.pdfs){
    const rec = out.recs.song.get(id);
    if(!rec || rec.deleted) problems.push(`the PDF "${pdf.name}" belongs to a song that is ${rec ? 'deleted' : 'not'} on Drive`);
    else if(pdf.name !== pdfName(rec.title) && pdf.name !== pdfName(titleOf(rec))) problems.push(`the PDF of "${rec.title}" is named "${pdf.name}", not "${pdfName(rec.title)}"`);
  }
  for(const [id, rec] of out.recs.song) if(!rec.deleted && !(out.pdfs.get(id) && out.pdfs.get(id).hash === rec.hash)) problems.push(`the song "${rec.title}" is on Drive without its PDF`);
  return out;
}

/* The counts a report gives: "Sent 3 songs, 1 setlist, 0 collections." and "Got ...". A kind it does not name counts 0. */
export function reportCounts(text){
  const part = w => { const m = new RegExp('(?:^|[^A-Za-z])' + w + '\\b([^.]*)\\.').exec(text); return m ? m[1] : ''; };
  const count = s => { const o = {song: 0, set: 0, coll: 0}; for(const [, n, w] of s.matchAll(/(\d+) (song|setlist|collection)s?\b/g)) o[{song: 'song', setlist: 'set', collection: 'coll'}[w]] = Number(n); return o; };
  const both = /\d+ changed on both tablets.*?\)\.(?=\s|$)/.exec(text) || /\d+ changed on both tablets[^.]*/.exec(text);
  return {sent: count(part('Sent')), got: count(part('Got')), upToDate: /Everything is up to date/.test(text), both: both ? both[0] : ''};
}

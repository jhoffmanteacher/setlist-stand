/* model.loop.mjs — seeded, model-based closed-loop test of the whole app.

     node tools/loops.mjs --only model [--seed S] [--cases N] [--case I] [--verbose]

   THE QUESTION. After any mix of what a user does (import, edit, archive, delete, replace a chart, build and
   reorder setlists with breaks, draw, erase, undo, clear, text notes, crops, reloads), does the app show and
   store exactly what it should, and does a backup bring all of it back?

   HOW. Each case drives the REAL UI (Playwright, mouse pointer events, the app's own dialogs and two-tap
   confirms) with a seeded random sequence of ~25 actions. An independent MODEL (plain JS objects in this file,
   written from CLAUDE.md, docs/DECISIONS.md and the documented rules, not from the app's state) tracks what the
   library, the setlists and every annotated page should hold. After every action the model is compared with
   IndexedDB (every record, deletion markers included) and with the screen the action left open; every 6 actions,
   after each reload and at the end, with every screen (library + archived list, setlist list, each setlist).
   At the end of a case: Back up (UI) -> wipe the database -> Restore (UI) -> the snapshot equals the snapshot
   taken before the backup, and the model still matches.

   WHAT THE MODEL LEARNS FROM THE APP. Only what the app makes up and a model cannot know: record ids (song, set,
   break, stroke and note ids, taken from IndexedDB right after the action that made them), and positions measured
   from the pointer (a crop rect, a note's x/y), which are first checked to be within a few pixels of where the
   test dragged/clicked and then adopted. Nothing the RNG decides depends on those, so the printed timeline is the
   same byte for byte for the same seed.

   GEOMETRY. Strokes go in "slots" (2 columns x 8 rows) and notes in a third column, far enough apart that the
   eraser (14 px + half the line width) only ever hits the stroke it is dragged along, and notes never overlap.
   Crops keep margins of at most 8%, so every slot stays visible and clear of the viewer's top and bottom bars.

   OUTPUT. stdout is the same for the same seed. --verbose prints each case's whole timeline. Every failure names
   the case, the action and the differences, and prints the replay command:
     node tools/loops.mjs --only model --seed <S> --case <N> --verbose
   SS_MODEL_PROFILE=1 prints each action's and check's time on stderr (stdout unchanged).

   TIME. About 11 s a case (opening a chart in pdf.js is most of it): the default 12 cases take 130-140 s on the
   Mac with other work running. The service worker is blocked in these contexts (the offline/update loop covers it).

   PROVED NOT VACUOUS (2026-11-19) on scratch copies served with --root: "A " no longer ignored in js/names.js
   sortKey -> fails (seed 1, case 12, library order); Undo restoring the page without reconcile() in js/ink.js ->
   fails (seed 1, case 2, the undone stroke's deletion marker missing).
*/
import fs from 'node:fs';
import path from 'node:path';
import {FIX, sha256, idbAll, snapshot, diff, restoreZip, backupNow, wipe, sleep} from './harness.mjs';

const NAME = 'model: random action sequences match the model, survive reload and a backup round trip';
const DEFAULT_CASES = 10, ACTIONS = 22, FULL_EVERY = 6;   // ~100 s: sized so a full run does not hog the Mac (see CLAUDE.md)

/* ---------- fixtures: what the file name and the PDF say ---------- */
const FIXTURES = {
  'one-page.pdf': {pages: 1, song: 'One-page'},
  'two-page.pdf': {pages: 2, song: 'Two-page'},
  'three-page.pdf': {pages: 3, song: 'Three-page'},
};
for(const f of Object.keys(FIXTURES)) FIXTURES[f].hash = sha256(fs.readFileSync(path.join(FIX, f)));
const FILES = Object.keys(FIXTURES);

/* ---------- words (accents, sharps and flats, leading The/A/An, numbers) ---------- */
const SONGS = ['Étude', 'The Ångström Waltz', 'A Night in B♭', 'F♯ Blues', 'An Older Song', 'the café', 'Zoë', 'Über Alles',
  '12 Bar', '2 Bar', 'Ça Plane', 'Señor', 'apple', 'The', 'A Apple', 'Eb Shuffle', 'E♭ Shuffle', 'öde', 'A Zebra', 'The Zoo',
  'An Ending', 'A Bossa', 'Bossa'];
const ARTISTS = ['', '', 'Beyoncé', 'Sigur Rós', 'The Beatles', 'Mötley Crüe', 'B♭ Band', 'live'];
const VERSIONS = ['', '', 'in B♭', 'in F♯', 'live', 'OLD', 'é', '2'];
const SET_NAMES = ['Gig', 'Sunday Service', 'Café Set', 'Jazz in B♭', 'F♯ Night', 'Ölfest', 'The Wedding'];
const BREAK_NAMES = ['Set 2', 'Intermission', 'Pause café', 'Encore ♯', 'Break ♭'];
const NOTE_TEXTS = ['Verse', 'Coda ♯', 'Café', 'Solo x2', 'D.S. al Coda', 'B♭ riff', 'Tacet', 'Ritard'];
const PEN = ['#1a1a1a', '#d62828', '#1f5fd6'], HL = ['#ffd400', '#7be07b'];
const SIZES = {small: .012, medium: .018, large: .028};

/* slots, as fractions of the FULL page */
const ROWS = [.18, .26, .34, .42, .50, .58, .66, .74];
const COLS = [.16, .40], LEN = .18, NOTE_X = .66;
const PW = 612, PH = 792;

/* ---------- seeded RNG (mulberry32) ---------- */
function hash32(str){ let h = 2166136261; for(const c of str){ h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed){
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  r.int = n => Math.floor(r() * n);
  r.pick = arr => arr[r.int(arr.length)];
  r.chance = p => r() < p;
  r.frac = (lo, hi) => Math.round((lo + r() * (hi - lo)) * 100) / 100;
  return r;
}

/* ---------- the model's own rules (from CLAUDE.md, docs/DECISIONS.md) ---------- */
const titleOf = s => s.song + (s.version ? ` (${s.version})` : '') + (s.artist ? ` - ${s.artist}` : '');
/* Library order (Jonathan, 2026-11-21): A to Z by song name, case and accents ignored, numbers in natural order, NO word
   dropped ("The Weight" is under T); the same name goes by artist, then version. Equal ones keep their stored (id) order. */
const COLL = new Intl.Collator(undefined, {sensitivity: 'base', numeric: true});
const nameOf = s => (s.song || s.title || '').replace(/\s+/g, ' ').trim();
const byNameNoId = (a, b) => COLL.compare(nameOf(a), nameOf(b)) || COLL.compare(a.artist || '', b.artist || '') || COLL.compare(a.version || '', b.version || '');
const byName = (a, b) => byNameNoId(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const pagesText = n => `${n} page${n == 1 ? '' : 's'}`;
const cropOf = (s, pn) => (s.crop && ((s.crop.pages && s.crop.pages[pn]) || s.crop.all)) || null;

const liveSongs = M => M.songs.filter(s => !s.deleted);
const libSongs = M => liveSongs(M).filter(s => !s.archived);
const liveSets = M => M.sets.filter(s => !s.deleted);
const songOf = (M, label) => M.songs.find(s => s.label === label);
const pageItems = (s, pn) => { if(!s.ink.has(pn)) s.ink.set(pn, []); return s.ink.get(pn); };
const liveOn = (s, pn) => (s.ink.get(pn) || []).filter(i => !i.deleted);
const clone = o => JSON.parse(JSON.stringify(o));
const tomb = it => ({id: it.id, deleted: true});
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fmt = o => JSON.stringify(o, (k, v) => typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);

/* ---------- small UI helpers ---------- */
async function until(fn, ms = 5000, what = 'condition'){
  const end = Date.now() + ms; let v;
  for(;;){ v = await fn(); if(v) return v; if(Date.now() > end) throw new Error('timed out waiting for ' + (typeof what === 'function' ? await what() : what)); await sleep(60); }
}
/* Repeats a check that returns a list of problems until it is empty or time runs out; returns the last list. */
async function settle(fn, ms = 3000){
  const end = Date.now() + ms; let p;
  for(;;){ p = await fn(); if(!p.length || Date.now() > end) return p; await sleep(80); }
}
const noModal = page => page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 5000});
async function askFill(page, value){
  const i = page.locator('.modal input[type=text]');
  await i.waitFor({timeout: 5000});
  await i.fill(value);
  await page.click('.modal [data-ok]');
  await noModal(page);
}
const clearToast = page => page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
const waitToast = (page, re, ms = 15000) => page.waitForFunction(src => new RegExp(src).test(document.querySelector('#toast').textContent), re.source, {timeout: ms})
  .catch(async () => { throw new Error(`toast ${re} did not show (toast: "${await page.locator('#toast').textContent()}")`); });

async function closeViewer(s, M){
  const {page} = s;
  if(!(await page.locator('#cropper').isHidden())) await page.click('#cropCancel');
  if(await page.locator('#viewer.on').count()){
    await page.click('#vBack');
    await page.waitForSelector('#viewer.on', {state: 'detached', timeout: 5000}).catch(() => {});
    await page.waitForFunction(() => !document.querySelector('#viewer').classList.contains('on'), null, {timeout: 5000});
  }
  M.viewer = null;
}
async function toLib(s, M){
  await closeViewer(s, M);
  await s.page.click('#tLib');
  await s.page.waitForSelector('#libList');
  M.ui = {screen: 'lib'};
}
async function setShowArch(s, on){
  const b = s.page.locator('#showArch');
  if((await b.isChecked()) !== on) await b.setChecked(on);
  await s.page.waitForFunction(on => !!([...document.querySelectorAll('#libList h2')].find(h => h.textContent === 'Archived')) === on, on, {timeout: 5000});
}
async function toSets(s, M){
  await closeViewer(s, M);
  await s.page.click('#tSets');
  await s.page.waitForSelector('#view [data-newset]');
  M.ui = {screen: 'sets'};
}
async function openSetUI(s, M, set){
  if(M.ui.screen === 'set' && M.ui.set === set.label && !M.viewer) return;
  await toSets(s, M);
  await s.page.click(`#view [data-set="${set.id}"]`);
  await s.page.waitForFunction(n => document.querySelector('#view h2')?.textContent === n && !!document.querySelector('#view [data-addto]'), set.name, {timeout: 5000});
  M.ui = {screen: 'set', set: set.label};
}

/* ---------- reading the screens ---------- */
const readLib = page => page.evaluate(() => {
  const L = document.querySelector('#libList');
  return {rows: [...L.querySelectorAll('li.row')].map(li => ({id: li.querySelector('.main').dataset.open, t: li.querySelector('.t').textContent,
    s: li.querySelector('.s').textContent, arch: !!li.querySelector('[data-restoresong]')})),
    empty: !!L.querySelector('.empty h2'), archHead: [...L.querySelectorAll('h2')].some(h => h.textContent === 'Archived')};
});
function checkLib(M, got, showArch){
  const out = [], live = libSongs(M).sort(byName), arch = liveSongs(M).filter(s => s.archived).sort(byName);
  const want = live.map(s => ({id: s.id, t: titleOf(s), s: pagesText(s.pages), arch: false}));
  if(showArch) want.push(...arch.map(s => ({id: s.id, t: titleOf(s), s: pagesText(s.pages) + ' · Archived', arch: true})));
  const lab = r => { const s = M.songs.find(x => x.id === r.id); return `${s ? s.label : '?'} "${r.t}" (${r.s})`; };
  if(JSON.stringify(got.rows) !== JSON.stringify(want)) out.push(`library rows:\n      shown    ${got.rows.map(lab).join(' | ')}\n      expected ${want.map(lab).join(' | ')}`);
  if(got.empty !== !live.length) out.push(`library "No music yet" shown=${got.empty}, live songs=${live.length}`);
  if(got.archHead !== showArch) out.push(`"Archived" heading shown=${got.archHead}, Show archived=${showArch}`);
  return out;
}
const readSets = page => page.evaluate(() => [...document.querySelectorAll('#view li.row')].map(li => ({id: li.querySelector('.main').dataset.set,
  t: li.querySelector('.t').textContent, s: li.querySelector('.s').textContent, play: !li.querySelector('[data-play]').disabled})));
const songCountOf = (M, set) => set.items.filter(it => it.type === 'song').length;
function checkSets(M, got){
  const want = liveSets(M).slice().sort((a, b) => b.n - a.n).map(st => { const n = songCountOf(M, st); return {id: st.id, t: st.name, s: `${n} song${n == 1 ? '' : 's'}`, play: n > 0}; });
  return JSON.stringify(got) === JSON.stringify(want) ? [] : [`setlist list:\n      shown    ${fmt(got)}\n      expected ${fmt(want)}`];
}
const readSet = page => page.evaluate(() => ({h2: document.querySelector('#view h2')?.textContent, empty: !!document.querySelector('#view .empty'),
  play: !document.querySelector('#view [data-play]').disabled,
  rows: [...document.querySelectorAll('#items > li.row')].map(li => ({brk: li.classList.contains('brk'), num: li.querySelector('.num').textContent,
    t: li.querySelector('.t').firstChild.textContent, tag: li.querySelector('.tag')?.textContent || null, s: li.querySelector('.s').textContent,
    handle: !!li.querySelector('.handle')}))}));
function checkSet(M, set, got){
  let k = 0;
  const rows = set.items.map(it => {
    if(it.type === 'break') return {brk: true, num: '', t: it.name, tag: 'Break', s: 'Tap to rename', handle: true};
    const s = songOf(M, it.label); k++;
    return {brk: false, num: String(k), t: titleOf(s), tag: s.archived ? 'Archived' : null, s: pagesText(s.pages), handle: true};
  });
  const want = {h2: set.name, empty: !set.items.length, play: k > 0, rows};
  return JSON.stringify(got) === JSON.stringify(want) ? [] : [`setlist ${set.label} "${set.name}":\n      shown    ${fmt(got)}\n      expected ${fmt(want)}`];
}

/* ---------- IndexedDB vs model ---------- */
const keysAre = (o, ks) => JSON.stringify(Object.keys(o).sort()) === JSON.stringify(ks.slice().sort());
async function readDb(page){
  const [songs, sets, ink, files] = await Promise.all(['songs', 'sets', 'ink', 'files'].map(st => idbAll(page, st)));
  return {songs, sets, ink, files};
}
function checkDb(M, db){
  const out = [], P = m => out.push(m);
  /* songs */
  const ids = new Set(M.songs.map(s => s.id));
  for(const k of Object.keys(db.songs)) if(!ids.has(k)) P(`songs: unexpected record ${k} ${fmt(db.songs[k]).slice(0, 120)}`);
  for(const s of M.songs){
    const r = db.songs[s.id];
    if(!r){ P(`songs: ${s.label} (${s.id}) missing`); continue; }
    if(s.deleted){
      if(!(keysAre(r, ['id', 'deleted', 'updated']) && r.id === s.id && r.deleted === true && r.updated > 0)) P(`songs: ${s.label} should be a deletion marker {id, deleted, updated}, is ${fmt(r).slice(0, 160)}`);
      continue;
    }
    const want = {id: s.id, song: s.song, artist: s.artist, version: s.version, title: titleOf(s), archived: s.archived, pages: s.pages, hash: s.hash};
    if(s.crop !== undefined) want.crop = s.crop;
    if(!keysAre(r, [...Object.keys(want), 'added', 'updated'])) P(`songs: ${s.label} fields ${Object.keys(r).sort().join(',')}`);
    const d = diff(want, Object.fromEntries(Object.keys(want).map(k => [k, r[k]])));
    if(d.length) P(`songs: ${s.label} ${d.join('; ')}`);
    if(!(r.added > 0 && r.updated >= r.added)) P(`songs: ${s.label} added/updated ${r.added}/${r.updated}`);
  }
  /* files: one per live song, the bytes of the file picked */
  const live = liveSongs(M);
  for(const k of Object.keys(db.files)) if(!live.some(s => s.id === k)) P(`files: unexpected PDF ${k} (${M.songs.find(s => s.id === k)?.label || 'unknown'})`);
  for(const s of live) if(!db.files[s.id]) P(`files: ${s.label} has no PDF`);
  /* sets */
  const sids = new Set(M.sets.map(s => s.id));
  for(const k of Object.keys(db.sets)) if(!sids.has(k)) P(`sets: unexpected record ${k} ${fmt(db.sets[k]).slice(0, 120)}`);
  for(const st of M.sets){
    const r = db.sets[st.id];
    if(!r){ P(`sets: ${st.label} missing`); continue; }
    if(st.deleted){
      if(!(keysAre(r, ['id', 'deleted', 'updated']) && r.deleted === true && r.updated > 0)) P(`sets: ${st.label} should be a deletion marker, is ${fmt(r).slice(0, 160)}`);
      continue;
    }
    if(!keysAre(r, ['id', 'name', 'items', 'created', 'updated'])) P(`sets: ${st.label} fields ${Object.keys(r).sort().join(',')}`);
    if(r.name !== st.name) P(`sets: ${st.label} name ${fmt(r.name)} != ${fmt(st.name)}`);
    const want = st.items.map(it => it.type === 'break' ? {type: 'break', id: it.id, name: it.name} : {type: 'song', id: songOf(M, it.label).id});
    const d = diff(want, r.items);
    if(d.length) P(`sets: ${st.label} items ${d.join('; ')}\n      stored   ${fmt(r.items)}\n      expected ${fmt(want)}`);
  }
  /* ink: one record per page that ever had a mark (live songs only), each mark by id */
  const inkWant = new Map();
  for(const s of live) for(const [pn, items] of s.ink) if(items.length) inkWant.set(s.id + ':' + pn, {s, pn, items});
  for(const k of Object.keys(db.ink)) if(!inkWant.has(k)) P(`ink: unexpected page record ${k} (${M.songs.find(s => k.startsWith(s.id + ':'))?.label || 'unknown song'}) ${fmt(db.ink[k]).slice(0, 120)}`);
  for(const [k, {s, pn, items}] of inkWant){
    const r = db.ink[k], where = `ink ${s.label} p${pn}`;
    if(!r){ P(`${where}: missing (model has ${items.length} marks)`); continue; }
    if(!keysAre(r, ['updated', 'strokes']) || !Array.isArray(r.strokes)){ P(`${where}: record is not {updated, strokes}`); continue; }
    const byId = new Map(r.strokes.map(x => [x.id, x]));
    if(byId.size !== r.strokes.length) P(`${where}: duplicate ids`);
    const wantLive = items.filter(i => !i.deleted).length, gotLive = r.strokes.filter(x => !x.deleted).length;
    if(wantLive !== gotLive) P(`${where}: ${gotLive} live marks stored, model has ${wantLive}`);
    for(const x of r.strokes) if(!items.some(i => i.id === x.id)) P(`${where}: unexpected mark ${fmt(x).slice(0, 120)}`);
    for(const i of items){
      const x = byId.get(i.id);
      if(!x){ P(`${where}: mark ${i.id} (${i.deleted ? 'deleted' : i.kind}) missing`); continue; }
      if(i.deleted){
        if(!(keysAre(x, ['id', 'deleted', 'updated']) && x.deleted === true && x.updated > 0)) P(`${where}: ${i.id} should be a deletion marker, is ${fmt(x).slice(0, 140)}`);
        continue;
      }
      if(x.deleted){ P(`${where}: ${i.kind} ${i.id}${i.text ? ' "' + i.text + '"' : ''} is deleted, model has it live`); continue; }
      if(i.kind === 'text'){
        if(!keysAre(x, ['id', 't', 'x', 'y', 'text', 'size', 'c', 'updated'])) P(`${where}: note fields ${Object.keys(x).sort()}`);
        const d = diff({t: 'text', text: i.text, size: i.size, c: i.c, x: i.x, y: i.y}, {t: x.t, text: x.text, size: x.size, c: x.c, x: x.x, y: x.y});
        if(d.length) P(`${where}: note ${i.id} ${d.join('; ')}`);
      } else {
        if(!keysAre(x, ['id', 't', 'c', 'w', 'p', 'updated'])) P(`${where}: stroke fields ${Object.keys(x).sort()}`);
        if(x.t !== i.kind || x.c !== i.c || x.w !== (i.kind === 'hl' ? .02 : .003)) P(`${where}: stroke ${i.id} is ${fmt({t: x.t, c: x.c, w: x.w})}, model ${fmt({t: i.kind, c: i.c})}`);
        const a = x.p[0], b = x.p[x.p.length - 1];
        if(!(x.p.length >= 2 && near(a[0], i.a[0], .006) && near(a[1], i.a[1], .006) && near(b[0], i.b[0], .006) && near(b[1], i.b[1], .006)))
          P(`${where}: stroke ${i.id} runs ${fmt(a)}..${fmt(b)}, drawn ${fmt(i.a)}..${fmt(i.b)}`);
      }
    }
  }
  return out;
}

/* ---------- the viewer ---------- */
const sheetOf = (page, pn) => page.evaluate(pn => {
  const ink = document.querySelector(`#stage .ink[data-pn="${pn}"]`); if(!ink) return null;
  const b = ink.parentElement.getBoundingClientRect();
  return {x: b.x, y: b.y, w: b.width, h: b.height, crop: ink._crop ? {x: ink._crop.x, y: ink._crop.y, w: ink._crop.w, h: ink._crop.h} : null};
}, pn);
const inkHasPixels = (page, pn) => page.evaluate(pn => {
  const cv = document.querySelector(`#stage .ink[data-pn="${pn}"]`); if(!cv) return null;
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  for(let i = 3; i < d.length; i += 4) if(d[i]) return true;
  return false;
}, pn);
/* Waits until page pn is the one shown, drawn through the crop the model says it has; returns its sheet. */
async function shownSheet(s, M, song, pn){
  const want = JSON.stringify(cropOf(song, pn));
  let sh;
  await until(async () => { sh = await sheetOf(s.page, pn); return sh && JSON.stringify(sh.crop) === want && sh.w > 50; }, 5000,
    () => `page ${pn} of ${song.label} drawn through crop ${want} (shown: ${fmt(sh)}; #vSub "${s.page.locator('#vSub').textContent()}")`);
  return sh;
}
async function ensureViewer(s, M, song, pn){
  const {page} = s;
  if(!(M.viewer && M.viewer.label === song.label)){
    await toLib(s, M);
    await page.click(`#libList [data-open="${song.id}"]`);
    await page.waitForFunction(t => document.querySelector('#viewer').classList.contains('on') && document.querySelector('#vTitle').textContent === t && !!document.querySelector('#stage .ink'), titleOf(song), {timeout: 8000})
      .catch(async () => { throw new Error(`viewer did not open ${song.label} "${titleOf(song)}" (title "${await page.locator('#vTitle').textContent()}")`); });
    if(await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
    await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 1, null, {timeout: 5000});
    M.viewer = {label: song.label, hist: [], page: 1};
    M.ui = {screen: 'viewer'};
  }
  for(let i = 0; i < 8; i++){
    const m = /Page (\d+) of (\d+)/.exec(await page.locator('#vSub').textContent());
    const cur = m ? +m[1] : 0;
    if(cur === pn && await page.locator(`#stage .ink[data-pn="${pn}"]`).count()) break;
    if(cur === pn){ await page.waitForSelector(`#stage .ink[data-pn="${pn}"]`, {timeout: 3000}).catch(() => {}); continue; }
    const sub = await page.locator('#vSub').textContent();
    if(m) await page.keyboard.press(cur < pn ? 'ArrowRight' : 'ArrowLeft');
    await page.waitForFunction(t => document.querySelector('#vSub').textContent !== t, sub, {timeout: 1500}).catch(() => {});
  }
  M.viewer.page = pn;
  return shownSheet(s, M, song, pn);
}
async function annotOn(page){ if(await page.locator('#tools').isHidden()) await page.click('#vAnn'); }
async function pickTool(page, kind, color){
  await annotOn(page);
  const textOn = await page.getAttribute('#tools [data-tool=text]', 'aria-pressed') === 'true';
  if(kind === 'text'){ if(!textOn) await page.click('#tools [data-tool=text]'); return; }
  if(textOn) await page.click('#tools [data-tool=text]');       // in text mode a pen button only picks the note colour
  await page.click(kind === 'erase' ? '#tools [data-tool=erase]' : `#tools [data-tool=${kind}][data-color="${color}"]`);
  await until(async () => (await page.getAttribute(kind === 'erase' ? '#tools [data-tool=erase]' : `#tools [data-tool=${kind}][data-color="${color}"]`, 'aria-pressed')) === 'true', 3000, `tool ${kind} ${color || ''} pressed`);
}
const scr = (sh, cr, fx, fy) => { const c = cr || {x: 0, y: 0, w: 1, h: 1}; return {x: sh.x + (fx - c.x) / c.w * sh.w, y: sh.y + (fy - c.y) / c.h * sh.h}; };
async function mouseLine(page, a, b, steps = 6){
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for(let i = 1; i <= steps; i++) await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps);
  await page.mouse.up();
}
/* the id of the one mark on the page that the model does not know yet */
async function newMarkId(s, song, pn, pred, what){
  const known = new Set((song.ink.get(pn) || []).map(i => i.id));
  return until(async () => {
    const r = (await idbAll(s.page, 'ink'))[song.id + ':' + pn];
    const fresh = (r && r.strokes || []).filter(x => !known.has(x.id));
    return fresh.length === 1 && pred(fresh[0]) ? fresh[0] : null;
  }, 4000, what);
}
const noteGrab = (sh, cr, n) => { const p = scr(sh, cr, n.x, n.y), c = cr || {w: 1}; return {x: p.x + 8, y: p.y + n.size * sh.w / c.w * .5}; };
async function noteDialog(page, {text, size, color}, del){
  const m = page.locator('.modal');
  await m.locator('textarea').waitFor({timeout: 5000});
  if(del){ await m.locator('[data-del]').click(); await noModal(page); return; }
  await m.locator('textarea').fill(text);
  await m.locator(`[data-size=${size}]`).click();
  await m.locator(`[data-color="${color}"]`).click();
  await m.locator('[data-ok]').click();
  await noModal(page);
}
async function openCropperUI(page, pn){
  await page.evaluate(() => { document.querySelector('#cropHint').textContent = ''; });
  await page.click('#vCrop');
  await page.waitForFunction(pn => !document.querySelector('#cropper').hidden && new RegExp('^Page ' + pn + ' of \\d+$').test(document.querySelector('#cropHint').textContent), pn, {timeout: 5000});
}
async function dragHandle(page, h, fx, fy){
  const s = await page.locator('#cropSheet').boundingBox(), hb = await page.locator(`#cropBox .ch[data-h=${h}]`).boundingBox();
  await mouseLine(page, {x: hb.x + hb.width / 2, y: hb.y + hb.height / 2}, {x: s.x + s.width * fx, y: s.y + s.height * fy}, 8);
}

/* ---------- model edits shared by actions ---------- */
function histPush(M, song, pn){ M.viewer.hist.push({pn, before: clone(song.ink.get(pn) || [])}); }
const freeStrokeSlots = (song, pn) => { const used = new Set(liveOn(song, pn).filter(i => i.kind !== 'text').map(i => i.slot)); const out = []; for(let c = 0; c < COLS.length; c++) for(let r = 0; r < ROWS.length; r++) if(!used.has(c * 10 + r)) out.push(c * 10 + r); return out; };
const freeNoteRows = (song, pn) => { const used = new Set(liveOn(song, pn).filter(i => i.kind === 'text').map(i => i.row)); return ROWS.map((_, r) => r).filter(r => !used.has(r)); };
const strokesOn = (song, pn) => liveOn(song, pn).filter(i => i.kind !== 'text');
const notesOn = (song, pn) => liveOn(song, pn).filter(i => i.kind === 'text');

/* ---------- actions ----------
   plan(M, r) -> args or null (precondition failed); it may only use what the RNG and the model's own decisions give,
   never an id or a measured position, so the timeline is the same for the same seed. */
function inkTarget(M, r, ok){
  /* stay on the song that is open (same undo history) most of the time */
  const songs = libSongs(M).filter(s => s.pages);
  const cur = M.viewer && songOf(M, M.viewer.label);
  const pages = s => Array.from({length: s.pages}, (_, i) => i + 1).filter(pn => ok(s, pn));
  if(cur && r.chance(.75)){
    const ps = pages(cur);
    if(ps.length) return {song: cur.label, pn: ps.includes(M.viewer.page) && r.chance(.6) ? M.viewer.page : r.pick(ps)};
  }
  const cands = songs.filter(s => pages(s).length).sort((a, b) => a.n - b.n);
  if(!cands.length) return null;
  const s = r.pick(cands);
  return {song: s.label, pn: r.pick(pages(s))};
}

const A = {};
A.import = {w: 2.5, plan: (M, r) => ({files: Array.from({length: r.chance(.3) ? 2 : 1}, () => r.pick(FILES))}),
  desc: a => `import ${a.files.join(', ')}`,
  async run(s, M, a){
    await toLib(s, M);
    await clearToast(s.page);
    await s.page.setInputFiles('#file', a.files.map(f => path.join(FIX, f)));
    /* a PDF already in the library (or twice in the batch) brings up one question: the model always adds anyway */
    await s.page.waitForFunction(() => !!document.querySelector('.dupask') || /^Added \d+ song/.test(document.querySelector('#toast').textContent), null, {timeout: 15000});
    if(await s.page.locator('.dupask').count()) await s.page.click('.dupask [data-dupadd]');
    await waitToast(s.page, /^Added \d+ song/);
    const known = new Set(M.songs.map(x => x.id));
    let fresh;
    await until(async () => { fresh = Object.values(await idbAll(s.page, 'songs')).filter(x => !known.has(x.id)); return fresh.length >= a.files.length; }, 5000, 'the imported song records');
    if(fresh.length !== a.files.length) throw new Error(`import of ${a.files.length} file(s) made ${fresh.length} song records`);
    fresh.sort((x, y) => x.added - y.added);
    for(const f of a.files){
      const fx = FIXTURES[f], i = fresh.findIndex(x => x.hash === fx.hash);
      if(i < 0) throw new Error(`no new song record with the hash of ${f}`);
      const [rec] = fresh.splice(i, 1);
      M.songs.push({label: 'S' + (++M.nSong), n: M.nSong, id: rec.id, song: fx.song, artist: '', version: '', archived: false,
        pages: fx.pages, hash: fx.hash, crop: undefined, ink: new Map(), deleted: false});
    }
    a.got = M.songs.slice(-a.files.length).map(x => x.label).join(', ');
  }};
A.edit = {w: 3.5, plan: (M, r) => { const c = libSongs(M); if(!c.length) return null; return {song: r.pick(c).label, v: {song: r.pick(SONGS), artist: r.pick(ARTISTS), version: r.pick(VERSIONS)}}; },
  desc: a => `edit ${a.song} -> ${fmt(a.v)}`,
  async run(s, M, a){
    const song = songOf(M, a.song);
    await toLib(s, M);
    await s.page.click(`#libList [data-edit="${song.id}"]`);
    const m = s.page.locator('.modal');
    await m.waitFor();
    const shown = await m.locator('input[data-k=song]').inputValue();
    if(shown !== song.song) throw new Error(`edit dialog for ${song.label} shows Title "${shown}", model "${song.song}"`);
    for(const k of ['song', 'artist', 'version']) await m.locator(`input[data-k=${k}]`).fill(a.v[k]);
    await m.locator('[data-ok]').click();
    await noModal(s.page);
    Object.assign(song, a.v);
  }};
A.archive = {w: 1.2, plan: (M, r) => { const c = libSongs(M); return c.length ? {song: r.pick(c).label} : null; },
  desc: a => `archive ${a.song}`,
  async run(s, M, a){
    const song = songOf(M, a.song);
    await toLib(s, M);
    await s.page.click(`#libList [data-archive="${song.id}"]`);
    song.archived = true;
  }};
A.unarchive = {w: 1.2, plan: (M, r) => { const c = liveSongs(M).filter(x => x.archived); return c.length ? {song: r.pick(c).label} : null; },
  desc: a => `restore archived ${a.song} (Show archived)`,
  async run(s, M, a){
    const song = songOf(M, a.song);
    await toLib(s, M);
    await setShowArch(s, true);
    const got = await readLib(s.page), p = checkLib(M, got, true);
    if(p.length) throw new Error('with Show archived on: ' + p.join('\n    '));
    await s.page.click(`#libList [data-restoresong="${song.id}"]`);
    song.archived = false;
    await s.page.waitForFunction(id => !document.querySelector(`[data-restoresong="${id}"]`), song.id, {timeout: 5000});
    await setShowArch(s, false);
  }};
A.deleteSong = {w: 0.8, plan: (M, r) => { const c = liveSongs(M); return c.length ? {song: r.pick(c).label} : null; },
  desc: a => `delete song ${a.song} (two taps)`,
  async run(s, M, a){
    const song = songOf(M, a.song);
    await toLib(s, M);
    if(song.archived) await setShowArch(s, true);
    const b = s.page.locator(`#libList [data-del="${song.id}"]`);
    await b.click();
    if(await b.textContent() !== 'Tap again') throw new Error(`first tap on Delete shows "${await b.textContent()}"`);
    await b.click();
    await s.page.waitForFunction(id => !document.querySelector(`#libList [data-open="${id}"]`), song.id, {timeout: 5000});
    if(song.archived) await setShowArch(s, false);
    song.deleted = true; song.ink = new Map();
    for(const st of liveSets(M)) st.items = st.items.filter(it => !(it.type === 'song' && it.label === song.label));
  }};
A.replace = {w: 1.5, plan: (M, r) => { const c = libSongs(M); return c.length ? {song: r.pick(c).label, file: r.pick(FILES)} : null; },
  desc: a => `replace PDF of ${a.song} with ${a.file} (two taps)`,
  async run(s, M, a){
    const song = songOf(M, a.song), fx = FIXTURES[a.file];
    await toLib(s, M);
    const b = s.page.locator(`#libList [data-replace="${song.id}"]`);
    await b.click();
    if(await b.textContent() !== 'Clears notes. Tap again') throw new Error(`first tap on Replace PDF shows "${await b.textContent()}"`);
    await clearToast(s.page);
    await b.click();
    await s.page.setInputFiles('#replaceFile', path.join(FIX, a.file));
    await waitToast(s.page, /^Chart replaced/);
    /* annotations start fresh: every mark of the pages that remain becomes a deletion marker; pages past the end go */
    for(const [pn, items] of [...song.ink]){
      if(pn > fx.pages) song.ink.delete(pn);
      else song.ink.set(pn, items.map(tomb));
    }
    song.pages = fx.pages; song.hash = fx.hash;
  }};
A.newSet = {w: 1.5, plan: (M, r) => ({name: r.pick(SET_NAMES)}),
  desc: a => `new setlist "${a.name}"`,
  async run(s, M, a){
    await toSets(s, M);
    await s.page.click('#view [data-newset]');
    await askFill(s.page, a.name);
    await s.page.waitForFunction(n => document.querySelector('#view h2')?.textContent === n, a.name, {timeout: 5000});
    const known = new Set(M.sets.map(x => x.id));
    const rec = await until(async () => Object.values(await idbAll(s.page, 'sets')).find(x => !known.has(x.id)), 4000, 'the new set record');
    const st = {label: 'L' + (++M.nSet), n: M.nSet, id: rec.id, name: a.name, items: [], deleted: false};
    M.sets.push(st); M.ui = {screen: 'set', set: st.label};
    a.got = st.label;
  }};
const setPick = (M, r, ok) => { const c = liveSets(M).filter(ok); return c.length ? r.pick(c) : null; };
A.addSongs = {w: 4, plan: (M, r) => {
    const st = setPick(M, r, x => x.items.length <= 4), pool = libSongs(M);
    if(!st || !pool.length) return null;
    const k = 1 + r.int(3), chosen = [];
    for(let i = 0; i < k; i++){
      const c = pool.filter(x => !chosen.includes(x) && !chosen.some(y => byNameNoId(x, y) === 0));
      if(!c.length) break;
      chosen.push(r.pick(c));
    }
    return {set: st.label, songs: chosen.map(x => x.label)};
  },
  desc: a => `add ${a.songs.join(', ')} to ${a.set} (picker)`,
  async run(s, M, a){
    const st = M.sets.find(x => x.label === a.set);
    await openSetUI(s, M, st);
    await s.page.click('#view [data-addto]');
    await s.page.locator('.modal .pick').waitFor();
    const listed = await s.page.locator('.modal .pick input').evaluateAll(els => els.map(e => e.value));
    const want = libSongs(M).sort(byName).map(x => x.id);
    if(JSON.stringify(listed) !== JSON.stringify(want)) throw new Error(`picker lists ${listed.map(id => M.songs.find(x => x.id === id)?.label)}, expected ${want.map(id => M.songs.find(x => x.id === id)?.label)} (non-archived, library order)`);
    for(const l of a.songs) await s.page.check(`.modal .pick input[value="${songOf(M, l).id}"]`);
    await s.page.click('.modal [data-ok]');
    await noModal(s.page);
    /* added in the picker's (library) order, not in the order ticked */
    const add = a.songs.map(l => songOf(M, l)).sort(byName);
    st.items.push(...add.map(x => ({type: 'song', label: x.label})));
  }};
A.addBreak = {w: 2.5, plan: (M, r) => { const st = setPick(M, r, x => x.items.length <= 6); return st ? {set: st.label} : null; },
  desc: a => `add a break to ${a.set}`,
  async run(s, M, a){
    const st = M.sets.find(x => x.label === a.set);
    await openSetUI(s, M, st);
    await s.page.click('#view [data-addbreak]');
    const rec = await until(async () => { const x = (await idbAll(s.page, 'sets'))[st.id]; return x && x.items.length === st.items.length + 1 ? x : null; }, 4000, 'the break in the set record');
    const last = rec.items[rec.items.length - 1];
    if(!(last.type === 'break' && typeof last.id === 'string' && last.id)) throw new Error('new last item is not a break with an id: ' + fmt(last));
    st.items.push({type: 'break', id: last.id, name: 'Break'});
  }};
A.renameBreak = {w: 2, plan: (M, r) => {
    const st = setPick(M, r, x => x.items.some(it => it.type === 'break')); if(!st) return null;
    const idx = st.items.map((it, i) => it.type === 'break' ? i : -1).filter(i => i >= 0);
    return {set: st.label, i: r.pick(idx), name: r.pick(BREAK_NAMES)};
  },
  desc: a => `rename item ${a.i + 1} (break) of ${a.set} to "${a.name}"`,
  async run(s, M, a){
    const st = M.sets.find(x => x.label === a.set);
    await openSetUI(s, M, st);
    await s.page.click(`#view [data-renbreak="${a.i}"]`);
    await askFill(s.page, a.name);
    st.items[a.i].name = a.name;
  }};
A.removeItem = {w: 2, plan: (M, r) => { const st = setPick(M, r, x => x.items.length); return st ? {set: st.label, i: r.int(st.items.length)} : null; },
  desc: a => `remove item ${a.i + 1} of ${a.set}`,
  async run(s, M, a){
    const st = M.sets.find(x => x.label === a.set);
    await openSetUI(s, M, st);
    await s.page.click(`#view [data-rm="${a.i}"]`);
    st.items.splice(a.i, 1);
  }};
A.dupSet = {w: 1.2, plan: (M, r) => { const st = setPick(M, r, () => true); return st ? {set: st.label, inside: r.chance(.5)} : null; },
  desc: a => `duplicate ${a.set} (${a.inside ? 'inside the setlist' : 'from the list'})`,
  async run(s, M, a){
    const st = M.sets.find(x => x.label === a.set);
    if(a.inside){ await openSetUI(s, M, st); await s.page.click('#view [data-dup]'); }
    else { await toSets(s, M); await s.page.click(`#view [data-dupset="${st.id}"]`); }
    await s.page.waitForFunction(n => document.querySelector('#view h2')?.textContent === n, st.name + ' copy', {timeout: 5000});
    const known = new Set(M.sets.map(x => x.id));
    const rec = await until(async () => Object.values(await idbAll(s.page, 'sets')).find(x => !known.has(x.id)), 4000, 'the copy');
    if(rec.items.length !== st.items.length) throw new Error(`copy has ${rec.items.length} items, ${st.label} has ${st.items.length}`);
    const items = st.items.map((it, i) => {
      if(it.type !== 'break') return {...it};
      const id = rec.items[i] && rec.items[i].id;
      if(!id || id === it.id) throw new Error(`break ${i + 1} of the copy: id ${id} (source ${it.id}); a copied break needs its own id`);
      return {type: 'break', id, name: it.name};
    });
    const c = {label: 'L' + (++M.nSet), n: M.nSet, id: rec.id, name: st.name + ' copy', items, deleted: false};
    M.sets.push(c); M.ui = {screen: 'set', set: c.label};
    a.got = c.label;
  }};
A.renameSet = {w: 1, plan: (M, r) => { const st = setPick(M, r, () => true); return st ? {set: st.label, name: r.pick(SET_NAMES)} : null; },
  desc: a => `rename ${a.set} to "${a.name}"`,
  async run(s, M, a){
    const st = M.sets.find(x => x.label === a.set);
    await openSetUI(s, M, st);
    await s.page.click('#view [data-renset]');
    await askFill(s.page, a.name);
    await s.page.waitForFunction(n => document.querySelector('#view h2')?.textContent === n, a.name, {timeout: 5000});
    st.name = a.name;
  }};
A.deleteSet = {w: 0.8, plan: (M, r) => { const st = setPick(M, r, () => true); return st ? {set: st.label} : null; },
  desc: a => `delete setlist ${a.set} (two taps)`,
  async run(s, M, a){
    const st = M.sets.find(x => x.label === a.set);
    await toSets(s, M);
    const b = s.page.locator(`#view [data-delset="${st.id}"]`);
    await b.click();
    if(await b.textContent() !== 'Tap again') throw new Error(`first tap on Delete shows "${await b.textContent()}"`);
    await b.click();
    await s.page.waitForFunction(id => !document.querySelector(`#view [data-set="${id}"]`), st.id, {timeout: 5000});
    st.deleted = true;
  }};
A.reorder = {w: 4, plan: (M, r) => {
    const st = setPick(M, r, x => x.items.length >= 2); if(!st) return null;
    const from = r.int(st.items.length); let to = r.int(st.items.length - 1); if(to >= from) to++;
    return {set: st.label, from, to};
  },
  desc: a => `drag item ${a.from + 1} of ${a.set} to place ${a.to + 1} (mouse, handle)`,
  async run(s, M, a){
    const st = M.sets.find(x => x.label === a.set), page = s.page;
    await openSetUI(s, M, st);
    const rows = page.locator('#items > li.row');
    const h = await rows.nth(a.from).locator('.handle').boundingBox(), rt = await rows.nth(a.to).boundingBox();
    const start = {x: h.x + h.width / 2, y: h.y + h.height / 2}, end = {x: start.x, y: a.to < a.from ? rt.y + 4 : rt.y + rt.height - 4};
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(end.x, end.y, {steps: 12});
    await sleep(60);
    await page.mouse.up();
    const [m] = st.items.splice(a.from, 1); st.items.splice(a.to, 0, m);
  }};

/* ink actions: all open the song (from the library) on page pn, one page per view */
const inkAct = (w, ok, extra, desc, run) => ({w, ink: true,
  plan: (M, r) => { const t = inkTarget(M, r, ok); return t ? {...t, ...extra(songOf(M, t.song), t.pn, r)} : null; },
  desc: a => `${a.song} p${a.pn}: ${desc(a)}`,
  async run(s, M, a){ const song = songOf(M, a.song); const sh = await ensureViewer(s, M, song, a.pn); await run(s, M, a, song, sh); }});
async function drawStroke(s, M, a, song, sh, kind){
  await pickTool(s.page, kind, a.c);
  const col = Math.floor(a.slot / 10), row = a.slot % 10, cr = cropOf(song, a.pn);
  const A0 = [COLS[col], ROWS[row]], B0 = [COLS[col] + LEN, ROWS[row] + .01];
  await mouseLine(s.page, scr(sh, cr, ...A0), scr(sh, cr, ...B0), 6);
  const x = await newMarkId(s, song, a.pn, x => !x.deleted && x.t === kind, `the new ${kind} stroke on ${song.label} p${a.pn}`);
  histPush(M, song, a.pn);
  pageItems(song, a.pn).push({id: x.id, kind, c: a.c, slot: a.slot, a: A0, b: B0});
}
A.pen = inkAct(4, (s, pn) => freeStrokeSlots(s, pn).length, (s, pn, r) => ({slot: r.pick(freeStrokeSlots(s, pn)), c: r.pick(PEN)}),
  a => `pen stroke ${a.c} in slot ${a.slot}`, (s, M, a, song, sh) => drawStroke(s, M, a, song, sh, 'pen'));
A.hl = inkAct(2.5, (s, pn) => freeStrokeSlots(s, pn).length, (s, pn, r) => ({slot: r.pick(freeStrokeSlots(s, pn)), c: r.pick(HL)}),
  a => `highlighter ${a.c} in slot ${a.slot}`, (s, M, a, song, sh) => drawStroke(s, M, a, song, sh, 'hl'));
A.erase = inkAct(2, (s, pn) => strokesOn(s, pn).length, (s, pn, r) => ({slot: r.pick(strokesOn(s, pn)).slot}),
  a => `erase the stroke in slot ${a.slot}`,
  async (s, M, a, song, sh) => {
    const it = strokesOn(song, a.pn).find(i => i.slot === a.slot), cr = cropOf(song, a.pn);
    await pickTool(s.page, 'erase');
    await mouseLine(s.page, scr(sh, cr, ...it.a), scr(sh, cr, ...it.b), 6);
    histPush(M, song, a.pn);
    song.ink.set(a.pn, song.ink.get(a.pn).map(i => i.id === it.id ? tomb(i) : i));
  });
A.undo = {w: 3.5, ink: true, plan: (M) => M.viewer ? {song: M.viewer.label} : null,
  desc: a => `${a.song}: undo`,
  async run(s, M, a){
    const song = songOf(M, a.song);
    await annotOn(s.page);
    await clearToast(s.page);
    await s.page.click('#tUndo');
    const h = M.viewer.hist.pop();
    if(!h){ await waitToast(s.page, /^Nothing to undo$/, 3000); return; }
    /* the page goes back to how it was; marks added since become deletion markers */
    const before = new Map(h.before.map(i => [i.id, i]));
    song.ink.set(h.pn, (song.ink.get(h.pn) || []).map(i => before.has(i.id) ? before.get(i.id) : tomb(i)));
    if(h.pn !== M.viewer.page) M.viewer.page = h.pn;      // undo on another page shows that page
    a.pn = h.pn;
  }};
A.clear = inkAct(1, (s, pn) => liveOn(s, pn).length, () => ({}), () => 'clear page (two taps)',
  async (s, M, a, song) => {
    await annotOn(s.page);
    const b = s.page.locator('#tClear');
    await b.click();
    if(await b.textContent() !== 'Tap again') throw new Error(`first tap on Clear page shows "${await b.textContent()}"`);
    await b.click();
    histPush(M, song, a.pn);
    song.ink.set(a.pn, song.ink.get(a.pn).map(i => i.deleted ? i : tomb(i)));
  });
A.noteAdd = inkAct(2.5, (s, pn) => freeNoteRows(s, pn).length, (s, pn, r) => ({row: r.pick(freeNoteRows(s, pn)), text: r.pick(NOTE_TEXTS), size: r.pick(Object.keys(SIZES)), c: r.pick(PEN)}),
  a => `new text note "${a.text}" ${a.size} ${a.c} in note row ${a.row}`,
  async (s, M, a, song, sh) => {
    await pickTool(s.page, 'text');
    const cr = cropOf(song, a.pn), want = [NOTE_X, ROWS[a.row] - .01], p = scr(sh, cr, ...want);
    await s.page.mouse.click(p.x, p.y);
    await noteDialog(s.page, {text: a.text, size: a.size, color: a.c});
    const x = await newMarkId(s, song, a.pn, x => x.t === 'text', `the new note on ${song.label} p${a.pn}`);
    if(!(near(x.x, want[0], .006) && near(x.y, want[1], .006))) throw new Error(`note saved at ${fmt([x.x, x.y])}, clicked at ${fmt(want)}`);
    histPush(M, song, a.pn);
    pageItems(song, a.pn).push({id: x.id, kind: 'text', row: a.row, text: a.text, size: SIZES[a.size], c: a.c, x: x.x, y: x.y});
  });
A.noteEdit = inkAct(1.5, (s, pn) => notesOn(s, pn).length, (s, pn, r) => ({row: r.pick(notesOn(s, pn)).row, text: r.pick(NOTE_TEXTS), size: r.pick(Object.keys(SIZES)), c: r.pick(PEN)}),
  a => `edit the note in row ${a.row} -> "${a.text}" ${a.size} ${a.c}`,
  async (s, M, a, song, sh) => {
    const n = notesOn(song, a.pn).find(i => i.row === a.row), g = noteGrab(sh, cropOf(song, a.pn), n);
    await pickTool(s.page, 'text');
    await s.page.mouse.click(g.x, g.y);
    await s.page.locator('.modal [data-del]').waitFor({timeout: 5000}).catch(() => { throw new Error(`tapping note "${n.text}" did not open the edit dialog`); });
    const shown = await s.page.locator('.modal textarea').inputValue();
    if(shown !== n.text) throw new Error(`edit dialog shows "${shown}", model note is "${n.text}"`);
    await noteDialog(s.page, {text: a.text, size: a.size, color: a.c});
    histPush(M, song, a.pn);
    Object.assign(n, {text: a.text, size: SIZES[a.size], c: a.c});
  });
A.noteMove = inkAct(1.5, (s, pn) => notesOn(s, pn).length && freeNoteRows(s, pn).length, (s, pn, r) => ({row: r.pick(notesOn(s, pn)).row, to: r.pick(freeNoteRows(s, pn))}),
  a => `drag the note in row ${a.row} to row ${a.to}`,
  async (s, M, a, song, sh) => {
    const n = notesOn(song, a.pn).find(i => i.row === a.row), cr = cropOf(song, a.pn), g = noteGrab(sh, cr, n);
    const dy = ROWS[a.to] - ROWS[a.row], c = cr || {h: 1};
    await pickTool(s.page, 'text');
    await mouseLine(s.page, g, {x: g.x, y: g.y + dy / c.h * sh.h}, 6);
    const x = await until(async () => { const r = (await idbAll(s.page, 'ink'))[song.id + ':' + a.pn]; const v = r && r.strokes.find(q => q.id === n.id); return v && v.y !== n.y ? v : null; }, 4000, 'the moved note saved');
    if(await s.page.locator('.modal').count()) throw new Error('dragging a note opened the note dialog');
    if(!(near(x.x, n.x, .006) && near(x.y, n.y + dy, .006))) throw new Error(`note moved to ${fmt([x.x, x.y])}, dragged to ${fmt([n.x, n.y + dy])}`);
    histPush(M, song, a.pn);
    Object.assign(n, {row: a.to, x: x.x, y: x.y});
  });
A.noteDelete = inkAct(1, (s, pn) => notesOn(s, pn).length, (s, pn, r) => ({row: r.pick(notesOn(s, pn)).row}),
  a => `delete the note in row ${a.row} (dialog)`,
  async (s, M, a, song, sh) => {
    const n = notesOn(song, a.pn).find(i => i.row === a.row), g = noteGrab(sh, cropOf(song, a.pn), n);
    await pickTool(s.page, 'text');
    await s.page.mouse.click(g.x, g.y);
    await noteDialog(s.page, {}, true);
    histPush(M, song, a.pn);
    song.ink.set(a.pn, song.ink.get(a.pn).map(i => i.id === n.id ? tomb(i) : i));
  });
const cropRect = r => { const x = r.frac(.02, .08), y = r.frac(.02, .06); return {x, y, w: Math.round((1 - x - r.frac(.02, .08)) * 100) / 100, h: Math.round((1 - y - r.frac(.02, .06)) * 100) / 100}; };
async function doCrop(s, M, a, song, whole){
  const page = s.page, c = a.rect;
  await openCropperUI(page, a.pn);
  await dragHandle(page, 'nw', c.x, c.y);
  await dragHandle(page, 'se', c.x + c.w, c.y + c.h);
  await page.click(whole ? '#cropSong' : '#cropPage');
  await page.waitForSelector('#cropper', {state: 'hidden', timeout: 5000});
  const pick = rec => rec && rec.crop && (whole ? rec.crop.all : rec.crop.pages && rec.crop.pages[a.pn]);
  const rec = await until(async () => { const r = (await idbAll(page, 'songs'))[song.id]; return pick(r) && (!whole || !Object.keys(r.crop.pages).length) ? r : null; }, 4000, 'the crop saved');
  const got = pick(rec);
  if(!['x', 'y', 'w', 'h'].every(k => near(got[k], c[k], .01))) throw new Error(`crop saved as ${fmt(got)}, dragged to ${fmt(c)}`);
  if(whole) song.crop = {all: got, pages: {}};
  else { song.crop = song.crop || {all: null, pages: {}}; song.crop.pages[a.pn] = got; }
}
A.cropPage = inkAct(1.2, () => true, (s, pn, r) => ({rect: cropRect(r)}), a => `crop this page to ${fmt(a.rect)}`, (s, M, a, song) => doCrop(s, M, a, song, false));
A.cropSong = inkAct(0.8, () => true, (s, pn, r) => ({rect: cropRect(r)}), a => `crop the whole song to ${fmt(a.rect)}`, (s, M, a, song) => doCrop(s, M, a, song, true));
A.cropReset = inkAct(1, s => !!s.crop, () => ({}), () => 'crop Reset',
  async (s, M, a, song) => {
    const page = s.page;
    await openCropperUI(page, a.pn);
    await clearToast(page);
    await page.click('#cropReset');
    if(song.crop.pages[a.pn]){ delete song.crop.pages[a.pn]; await waitToast(page, /^Page crop removed$/, 4000); }
    else if(song.crop.all){ song.crop.all = null; await waitToast(page, /^Song crop removed$/, 4000); }
    else { await waitToast(page, /^This page has no crop$/, 4000); await page.click('#cropCancel'); }
    await page.waitForSelector('#cropper', {state: 'hidden', timeout: 5000});
  });
A.reload = {w: 0.7, plan: () => ({}), desc: () => 'reload the page', async run(s, M){ await s.page.reload(); await afterLoad(s, M); }};

async function afterLoad(s, M){
  await s.page.waitForSelector('#libList');
  M.ui = {screen: 'lib'}; M.viewer = null;
}

/* ---------- checks ---------- */
async function checkScreen(s, M){
  const page = s.page;
  if(M.ui.screen === 'lib') return checkLib(M, await readLib(page), false);
  if(M.ui.screen === 'sets') return checkSets(M, await readSets(page));
  if(M.ui.screen === 'set'){ const st = M.sets.find(x => x.label === M.ui.set); return checkSet(M, st, await readSet(page)); }
  if(M.ui.screen === 'viewer' && M.viewer){
    const song = songOf(M, M.viewer.label), pn = M.viewer.page, out = [];
    const t = await page.locator('#vTitle').textContent();
    if(t !== titleOf(song)) out.push(`viewer title "${t}", model "${titleOf(song)}"`);
    const sub = await page.locator('#vSub').textContent();
    if(sub !== `Page ${pn} of ${song.pages}`) out.push(`viewer shows "${sub}", model Page ${pn} of ${song.pages}`);
    const sh = await sheetOf(page, pn);
    if(!sh) out.push(`page ${pn} not shown`);
    else {
      if(JSON.stringify(sh.crop) !== JSON.stringify(cropOf(song, pn))) out.push(`page ${pn} drawn through crop ${fmt(sh.crop)}, model ${fmt(cropOf(song, pn))}`);
      const cr = cropOf(song, pn) || {w: 1, h: 1}, aspect = (cr.w * PW) / (cr.h * PH);
      if(!near(sh.w / sh.h, aspect, aspect * .02)) out.push(`page ${pn} sheet aspect ${(sh.w / sh.h).toFixed(3)}, crop gives ${aspect.toFixed(3)}`);
      const px = await inkHasPixels(page, pn), want = liveOn(song, pn).length > 0;
      if(px !== want) out.push(`ink canvas of page ${pn} ${px ? 'has marks' : 'is blank'}, model has ${liveOn(song, pn).length} live marks`);
    }
    return out;
  }
  return [];
}
async function fullCheck(s, M){
  const out = [];
  await toLib(s, M);
  out.push(...await settle(async () => checkLib(M, await readLib(s.page), false)));
  if(liveSongs(M).some(x => x.archived)){
    await setShowArch(s, true);
    out.push(...await settle(async () => checkLib(M, await readLib(s.page), true)));
    await setShowArch(s, false);
  }
  await toSets(s, M);
  out.push(...await settle(async () => checkSets(M, await readSets(s.page))));
  for(const st of liveSets(M).sort((a, b) => a.n - b.n)){
    await openSetUI(s, M, st);
    out.push(...await settle(async () => checkSet(M, st, await readSet(s.page))));
  }
  return out;
}

/* ---------- one case ----------
   Its own browser context, like ctx.session() but with the service worker blocked: this loop is about data, the
   worker's precache of every app file per case only costs time (the offline/update loop covers the worker). */
async function openCase(ctx){
  const context = await ctx.browser.newContext({viewport: {width: 1280, height: 800}, acceptDownloads: true, serviceWorkers: 'block'});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if(m.type() === 'error') errors.push('console: ' + m.text()); });
  return {context, page, errors, base: ctx.base,
    async goto(){ await page.goto(ctx.base + 'index.html'); await page.waitForSelector('#libList'); },
    close: () => context.close()};
}
async function runCase(ctx, seed, c, log){
  const r = rng(hash32(`model:${seed}:${c}`));
  const M = {songs: [], sets: [], nSong: 0, nSet: 0, ui: {screen: 'lib'}, viewer: null};
  const s = await openCase(ctx);
  const where = {step: 'start'};
  let nActions = 0;
  const fail = (msg) => { const e = new Error(msg); e.where = where.step; throw e; };
  const check = async (label, full) => {
    let p = await settle(async () => checkDb(M, await readDb(s.page)));
    if(p.length) fail(`${label}: IndexedDB differs from the model:\n    ${p.join('\n    ')}`);
    p = await settle(() => checkScreen(s, M), 2000);
    if(p.length) fail(`${label}: the screen differs from the model:\n    ${p.join('\n    ')}`);
    if(full){ p = await fullCheck(s, M); if(p.length) fail(`${label}: full screen check:\n    ${p.join('\n    ')}`); }
    if(s.errors.length) fail(`${label}: page errors: ${s.errors.join(' | ')}`);
  };
  try{
    await s.goto();
    await afterLoad(s, M);
    const names = Object.keys(A);
    for(let i = 1; i <= ACTIONS; i++){
      /* pick an action by weight among those whose precondition holds (the first is always an import) */
      let name, args;
      if(i === 1){ name = 'import'; args = A.import.plan(M, r); }
      else {
        const cands = [];
        for(const n of names){
          if(n === 'import' && liveSongs(M).length >= 8) continue;
          cands.push(n);
        }
        for(let tries = 0; tries < 50 && !args; tries++){
          let x = r() * cands.reduce((t, n) => t + A[n].w, 0);
          name = cands.find(n => (x -= A[n].w) < 0) || cands[cands.length - 1];
          args = A[name].plan(M, r);
        }
        if(!args){ name = 'import'; args = A.import.plan(M, r); }
      }
      const act = A[name];
      where.step = `#${i} ${act.desc(args)}`;
      if(!act.ink && M.viewer && name !== 'reload') await closeViewer(s, M);
      const t0 = Date.now();
      await act.run(s, M, args);
      const t1 = Date.now();
      nActions++;
      log(`  #${i} ${act.desc(args)}${args.got ? ' -> ' + args.got : ''}`);
      await check(`#${i} ${name}`, i % FULL_EVERY === 0 || name === 'reload');
      if(process.env.SS_MODEL_PROFILE) console.error(`    [${name}: action ${t1 - t0} ms, check ${Date.now() - t1} ms]`);
    }
    where.step = 'reload at the end';
    log('  reload, then check everything');
    await s.page.reload(); await afterLoad(s, M);
    await check('after the final reload', true);

    where.step = 'backup -> wipe -> restore';
    if(!liveSongs(M).length && !liveSets(M).length){ log('  (nothing live: no backup round trip)'); return nActions; }
    log('  back up (UI), wipe, restore (UI), compare snapshots');
    await toLib(s, M);
    const before = await snapshot(s.page);
    const {file} = await backupNow(s.page);
    await s.page.goto(s.base + 'css/app.css');
    await wipe(s.page);
    const left = await s.page.evaluate(async () => (await indexedDB.databases()).map(d => d.name));
    if(left.includes('setlist-stand')) fail('the wipe did not delete the database');
    await s.goto(); await afterLoad(s, M);
    const empty = await snapshot(s.page);
    if(Object.keys(empty.songs).length || Object.keys(empty.sets).length || Object.keys(empty.ink).length) fail('database not empty after the wipe');
    await restoreZip(s.page, file);
    const after = await snapshot(s.page);
    const d = diff(before, after);
    if(d.length) fail(`snapshot after backup -> wipe -> restore differs from before:\n    ${d.join('\n    ')}`);
    await check('after the restore', true);
    return nActions;
  } finally { await s.close(); }
}

export const loops = [{
  name: NAME,
  async run(ctx){
    const {seed, verbose} = ctx.opts;
    const n = ctx.opts.cases || DEFAULT_CASES;
    const cases = ctx.opts.case != null ? [ctx.opts.case] : Array.from({length: n}, (_, i) => i + 1);
    const fails = [];
    let total = 0;
    for(const c of cases){
      const lines = [];
      const T0 = Date.now(); const log = l => { lines.push(l); if(verbose) console.log(l); if(process.env.SS_MODEL_PROFILE) console.error(`    [t=${Date.now() - T0} ms]`); };
      if(verbose) console.log(`case ${c} (seed ${seed})`);
      try{ total += await runCase(ctx, seed, c, log); }
      catch(e){
        const replay = `node tools/loops.mjs --only model --seed ${seed} --case ${c} --verbose`;
        const msg = `case ${c} (seed ${seed}) failed at ${e.where || '?'}:\n  ${e.message}\n  timeline so far:\n${lines.slice(-6).join('\n')}\n  replay: ${replay}`;
        console.log('  FAIL ' + msg);
        fails.push(`case ${c}: ${replay}`);
      }
    }
    console.log(`  model: ${cases.length} case(s), ${total} actions, seed ${seed}, ${fails.length} failed`);
    if(fails.length) throw new Error(`${fails.length} of ${cases.length} cases failed:\n  ${fails.join('\n  ')}`);
  }
}];

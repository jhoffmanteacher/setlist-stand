/*
 * Gig-date loops: a setlist may carry `gig: 'YYYY-MM-DD'` (absent = none). js/gigdate.js holds the pure parts, js/gigui.js the
 * dialogs and the once-per-tablet fill-in from names (localStorage `ss-gig-fill`), js/setlists.js the grouped list.
 *
 * gigdates 1  Node only: the name parser against a table written by hand (N of N), validGig / cleanGig / gigOf edge cases, and
 *             groupSets with a fixed `today` (upcoming across years, this year, No date, earlier years closed by default).
 * gigdates 2  the browser: the groups and rows READ FROM THE SCREEN equal an order written here by hand; last year starts closed and
 *             opens with a tap; set, change, clear and cancel a date on an open setlist; New setlist with a date; Duplicate drops
 *             the date; reload keeps the dates and closes last year again; a bad stored gig is drawn as No date and left alone;
 *             the fill-in is offered once, writes only the ticked sets' `gig` and `updated`, and Not now writes nothing.
 *             Records are read back straight from IndexedDB (harness idbAll / snapshot), not through the app.
 * gigdates 3  backups and share packages: dated sets round trip exactly (an unknown field too); version 1, 2 and 3 backups with
 *             no gig restore with none; a share package from a dated setlist holds no date, and an imported package (even one
 *             that carries a `gig` someone put in it) gives a setlist with none.
 * gigdates 4  a hostile backup: bad gig dates are dropped and counted at restore, the rest of each set kept.
 *             (Depends on the restore heal in js/backup.js restoreFrom: toast " k gig date(s) that were not real dates were left out.")
 * The tablet's "today" is the browser's local date; the browser runs on this machine, so Node's local date is the same one.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {FIX, TMP, JSZip, assert, sleep, sha256, idbAll, snapshot, diff, download, backupNow, restoreZip, wipe} from './harness.mjs';
import {importFixtures, songsOf, closeDone, readPackage} from './share-lib.mjs';
import * as G from '../../js/gigdate.js';

/* ---------- small helpers ---------- */
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOff = n => { const t = new Date(); return ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() + n)); };
const localDate = g => { const [y, m, d] = g.split('-').map(Number); return new Date(y, m - 1, d); };
const fmt = (lang, long) => new Intl.DateTimeFormat(lang, long ? {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'} : {weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'});
const waitFor = async (fn, what, ms = 8000) => { const end = Date.now() + ms; let v; while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(100); } throw new Error(typeof what === 'function' ? await what() : what); };
const noModal = page => page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 8000});
const clearToast = page => page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
const waitToast = (page, re, ms = 20000) => page.waitForFunction(src => new RegExp(src).test(document.querySelector('#toast').textContent), re.source, {timeout: ms})
  .catch(async () => { throw new Error(`toast ${re} did not show; toast is "${await page.locator('#toast').textContent()}"`); });
function expectSame(a, b, what){
  const d = diff(a, b, '', [], 30);
  assert(!d.length, `${what}: ${d.length} difference(s):\n    ` + d.join('\n    '));
}
const without = (r, ...keys) => { const o = {...r}; for(const k of keys) delete o[k]; return o; };
const setsOf = async page => Object.values(await idbAll(page, 'sets')).filter(x => !x.deleted);
const setNamed = async (page, name) => (await setsOf(page)).find(x => x.name === name);

/* Writes whole set records straight into IndexedDB (no app code), each replacing whatever had its id. */
const putSets = (page, recs) => page.evaluate(recs => new Promise((res, rej) => {
  const r = indexedDB.open('setlist-stand');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => {
    const d = r.result, t = d.transaction('sets', 'readwrite');
    for(const x of recs) t.objectStore('sets').put(x, x.id);
    t.oncomplete = () => { d.close(); res(); }; t.onerror = () => rej(t.error);
  };
}), recs);
let seq = 0;
const rid = p => p + Date.now().toString(36) + String(seq++).padStart(5, '0');      // ids written later sort later
const setRec = (name, extra = {}, created = Date.now()) => ({id: rid('gs'), name, items: [], colls: [], created, updated: created, ...extra});

/* The Setlists list as drawn: {flat:[rows]} without headers, else {groups:[{label, id, expanded, rows|null}], lists}. */
const readList = page => page.evaluate(() => {
  const v = document.querySelector('#view');
  const rows = ul => [...ul.querySelectorAll(':scope > li.row')].map(li => ({id: li.querySelector('[data-set]').dataset.set, name: li.querySelector('.t').textContent, sub: li.querySelector('.s').textContent}));
  const heads = [...v.querySelectorAll('h3.grp')];
  if(!heads.length){ const ul = v.querySelector('ul.list'); return {flat: ul ? rows(ul) : []}; }
  return {lists: v.querySelectorAll('ul.list').length, groups: heads.map(h => {
    const b = h.querySelector('button[data-grp]');
    const label = [...b.childNodes].filter(n => !(n.nodeType === 1 && n.classList.contains('chev'))).map(n => n.textContent).join('');
    const next = h.nextElementSibling;
    return {label, id: b.dataset.grp, expanded: b.getAttribute('aria-expanded'), rows: next && next.matches('ul.list') ? rows(next) : null};
  })};
});
/* Compares the drawn groups with [{label, expanded, names|null}] written by hand. */
async function expectGroups(page, want, what){
  const got = await readList(page);
  assert(got.groups, `${what}: the list has no group headers: ${JSON.stringify(got)}`);
  const shape = got.groups.map(g => ({label: g.label, expanded: g.expanded, names: g.rows && g.rows.map(r => r.name)}));
  assert(JSON.stringify(shape) === JSON.stringify(want), `${what}:\n    on screen ${JSON.stringify(shape)}\n    expected  ${JSON.stringify(want)}`);
  assert(got.lists === want.filter(g => g.names).length, `${what}: ${got.lists} lists drawn for ${want.filter(g => g.names).length} open groups`);
  return got;
}
async function toSets(page){
  if(await page.locator('#view [data-allsets]').count()) await page.click('#view [data-allsets]');
  await page.click('#tSets');
  await page.waitForSelector('#view [data-newset]');
}
async function openSet(page, id){
  /* a closed group (an earlier year) does not draw its rows: open the closed ones first */
  if(!await page.locator(`#view [data-set="${id}"]`).count())
    for(let i = 0; i < 50 && await page.locator('#view button[data-grp][aria-expanded="false"]').count(); i++) await page.locator('#view button[data-grp][aria-expanded="false"]').first().click();
  await page.click(`#view [data-set="${id}"]`);
  await page.waitForSelector('#view [data-gig]');
}
const gigline = page => page.evaluate(() => document.querySelector('#view .gigline')?.textContent ?? null);
async function wipeReload(s){
  await wipe(s.page);
  await s.goto();
  const snap = await snapshot(s.page);
  assert(Object.values(snap).every(o => !Object.keys(o).length), 'database not empty after wipe + reload');
}
const readZip = async f => JSZip.loadAsync(await fsp.readFile(f));
const libJson = async zip => JSON.parse(await zip.file('library.json').async('string'));

/* ---------- gigdates 1: Node only ---------- */
const NAME_TABLE = [
  /* the work order's table */
  ['Sf October 18 2026', '2026-10-18'],
  ['18 Oct 2026', '2026-10-18'],
  ['Gig 2026-03-07', '2026-03-07'],
  ['Party 3/7/2026', '2026-03-07'],
  ['Blue Oak February 31', null],
  ['Ocean Ale House March 2026', null],
  ['Ameswell Jan 31', null],
  ['Mt Carmel 26 24', null],
  ['February 31 2026', null],
  ['Oct 1 2026 and Oct 2 2026', null],
  /* more: separators, case, short and full month names */
  ['Oct 18, 2026', '2026-10-18'],
  ['Oct. 18, 2026', '2026-10-18'],
  ['18 October, 2026', '2026-10-18'],
  ['SF OCTOBER 18 2026', '2026-10-18'],
  ['sf october 18 2026', '2026-10-18'],
  ['Show 10/18/2026', '2026-10-18'],
  ['12/25/2026 Xmas party', '2026-12-25'],
  ['June 1 2026', '2026-06-01'],
  ['Jun 1 2026', '2026-06-01'],
  ['1 June 2026', '2026-06-01'],
  ['Wedding Sep 5 2026', '2026-09-05'],
  ['May 9 2026 brunch', '2026-05-09'],
  /* leap days */
  ['Leap February 29 2028', '2028-02-29'],
  ['Feb 29 2000', '2000-02-29'],
  ['February 29 2027', null],
  ['Feb 29 2100', null],
  ['2028-02-29', '2028-02-29'],
  ['2027-02-29', null],
  ['2/29/2028', '2028-02-29'],
  ['2/29/2027', null],
  /* ordinals, two-digit or missing years, impossible parts */
  ['October 18th 2026', null],
  ['18th Oct 2026', null],
  ['Oct 18 26', null],
  ['Party 3/7/26', null],
  ['October 2026', null],
  ['October 18', null],
  ['13/1/2026', null],
  ['0/5/2026', null],
  ['2026-13-01', null],
  ['2026-00-10', null],
  ['2026-04-31', null],
  ['April 31 2026', null],
  ['Oct 0 2026', null],
  ['2026-3-7', null],
  /* a month name inside a word, the three-letter rule, digits glued on */
  ['Mayday 5 2026', null],
  ['Marching 18 2026', null],
  ['Sept 18 2026', null],                 // "Sept" is neither the full name nor the three-letter form
  ['12026-10-18', null],
  ['2026-10-188', null],
  ['Oct 18 20266', null],
  /* two dates, in any mix of forms, are never a date */
  ['Gig 2026-03-07 and 2026-03-08', null],
  ['Oct 18 2026 / 18 Oct 2026', null],
  ['3/7/2026 or 2026-03-07', null],
  /* nothing at all */
  ['', null],
  ['Rehearsal', null],
];
async function loopNode(ctx){
  const bad = [];
  for(const [name, want] of NAME_TABLE){ const got = G.dateInName(name); if(got !== want) bad.push(`dateInName(${JSON.stringify(name)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); }
  const matched = NAME_TABLE.length - bad.length;
  console.log(`  gigdates parser table: ${matched} of ${NAME_TABLE.length} match`);
  for(const v of [null, undefined, 42, {}, ['2026-10-18']]) if(G.dateInName(v) !== null) bad.push(`dateInName(${JSON.stringify(v)}) is not null`);

  const VALID = [['2026-10-18', true], ['2024-02-29', true], ['2026-02-29', false], ['2026-02-28', true], ['2026-04-30', true], ['2026-04-31', false],
    ['2026-13-01', false], ['2026-00-10', false], ['2026-01-00', false], ['2026-01-32', false], ['2026-1-01', false], ['2026-01-1', false],
    [' 2026-01-01', false], ['2026-01-01 ', false], ['2026-01-01\n', false], ['2026/01/01', false], ['26-01-01', false], ['+2026-01-01', false],
    ['1900-01-01', true], ['1899-12-31', false], ['2999-12-31', true], ['3000-01-01', false], ['2000-02-29', true], ['1900-02-29', false],
    ['2026-10-18' + 'x'.repeat(9990), false], ['x'.repeat(10000), false], ['', false]];
  for(const [v, ok] of VALID){ const got = G.validGig(v); if(got !== (ok ? v : null)) bad.push(`validGig(${JSON.stringify(v.slice(0, 30))}) = ${JSON.stringify(got)}`); }
  for(const v of [null, undefined, 20261018, true, {}, ['2026-10-18'], new Date(2026, 9, 18)]) if(G.validGig(v) !== null) bad.push(`validGig(${String(v)}) is not null`);

  const CLEAN = [[undefined, {gig: null, dropped: 0}], [null, {gig: null, dropped: 0}], ['2026-10-18', {gig: '2026-10-18', dropped: 0}],
    ['2026-02-31', {gig: null, dropped: 1}], ['2026-13-01', {gig: null, dropped: 1}], [20261018, {gig: null, dropped: 1}],
    ['x'.repeat(10000), {gig: null, dropped: 1}], ['', {gig: null, dropped: 1}], [{}, {gig: null, dropped: 1}]];
  for(const [v, want] of CLEAN){ const got = G.cleanGig(v); if(JSON.stringify(got) !== JSON.stringify(want)) bad.push(`cleanGig(${JSON.stringify(v)?.slice(0, 30)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); }
  for(const [st, want] of [[{gig: '2026-10-18'}, '2026-10-18'], [{gig: '2026-02-31'}, null], [{gig: 5}, null], [{}, null], [null, null], [undefined, null]])
    if(G.gigOf(st) !== want) bad.push(`gigOf(${JSON.stringify(st)}) = ${JSON.stringify(G.gigOf(st))}`);
  if(G.todayStr(new Date(2026, 0, 5)) !== '2026-01-05' || G.todayStr(new Date(2026, 11, 31, 23, 59)) !== '2026-12-31') bad.push('todayStr is not the local calendar date');

  /* fillCandidates: only live sets with no real gig and a name holding one date */
  const fc = G.fillCandidates([
    {id: 'a', name: 'Sf October 18 2026'}, {id: 'b', name: 'Party 3/7/2026', gig: '2026-01-01'}, {id: 'c', name: 'Ameswell Jan 31'},
    {id: 'd', name: '18 Oct 2026', deleted: true}, {id: 'e', name: 'Gig 2026-03-07'}]);
  if(JSON.stringify(fc.map(c => [c.set.id, c.gig])) !== JSON.stringify([['a', '2026-10-18'], ['e', '2026-03-07']])) bad.push('fillCandidates: ' + JSON.stringify(fc.map(c => [c.set.id, c.gig])));

  /* groupSets, today fixed at 2026-11-22 */
  const S = (id, gig, created) => ({id, name: id, created, ...(gig === undefined ? {} : {gig})});
  const sets = [
    S('up-today', '2026-11-22', 1), S('up-next-year', '2027-01-05', 2), S('up-dec-old', '2026-12-01', 3), S('up-dec-new', '2026-12-01', 4), S('up-far', '2031-06-01', 5),
    S('ty-yesterday', '2026-11-21', 6), S('ty-jan', '2026-01-01', 7),
    S('none-old', undefined, 8), S('none-new', undefined, 12), S('none-badgig', '2026-02-31', 10), S('none-number', 20261018, 11), S('none-null', null, 9),
    S('y25-dec', '2025-12-31', 13), S('y25-mar', '2025-03-01', 14), S('y24', '2024-07-04', 15), S('y19', '2019-05-05', 16)];
  const want = [
    ['up', 'Upcoming', true, ['up-today', 'up-dec-new', 'up-dec-old', 'up-next-year', 'up-far']],
    ['y2026', '2026', true, ['ty-yesterday', 'ty-jan']],
    ['none', 'No date', true, ['none-new', 'none-number', 'none-badgig', 'none-null', 'none-old']],
    ['y2025', '2025', false, ['y25-dec', 'y25-mar']],
    ['y2024', '2024', false, ['y24']],
    ['y2019', '2019', false, ['y19']]];
  const shape = gs => gs && gs.map(g => [g.id, g.label, g.open, g.sets.map(x => x.id)]);
  const got = G.groupSets([...sets].reverse(), '2026-11-22');
  if(JSON.stringify(shape(got)) !== JSON.stringify(want)) bad.push(`groupSets:\n      got  ${JSON.stringify(shape(got))}\n      want ${JSON.stringify(want)}`);
  /* on New Year's Day nothing is "this year's past"; a year with nothing in it has no group; no dated set means no groups */
  const jan1 = G.groupSets([S('a', '2026-01-01', 1), S('b', '2025-12-31', 2), S('c', undefined, 3)], '2026-01-01');
  if(JSON.stringify(shape(jan1)) !== JSON.stringify([['up', 'Upcoming', true, ['a']], ['none', 'No date', true, ['c']], ['y2025', '2025', false, ['b']]])) bad.push('groupSets on Jan 1: ' + JSON.stringify(shape(jan1)));
  const onlyOld = G.groupSets([S('a', '2020-02-02', 1)], '2026-11-22');
  if(JSON.stringify(shape(onlyOld)) !== JSON.stringify([['y2020', '2020', false, ['a']]])) bad.push('groupSets with one old gig: ' + JSON.stringify(shape(onlyOld)));
  if(G.groupSets([S('a', undefined, 1), S('b', '2026-02-31', 2), S('c', 7, 3)], '2026-11-22') !== null) bad.push('groupSets with no real date is not null (the flat list)');
  if(G.groupSets([], '2026-11-22') !== null) bad.push('groupSets([]) is not null');
  /* open / closed state: earlier years start closed, a toggle flips it and a second toggle flips it back */
  const g25 = got.find(g => g.id === 'y2025'), gUp = got.find(g => g.id === 'up');
  if(G.isOpen(g25) !== false || G.isOpen(gUp) !== true) bad.push('isOpen before any tap: ' + [G.isOpen(g25), G.isOpen(gUp)]);
  G.toggleGroup(g25); G.toggleGroup(gUp);
  if(G.isOpen(g25) !== true || G.isOpen(gUp) !== false) bad.push('isOpen after one tap: ' + [G.isOpen(g25), G.isOpen(gUp)]);
  G.toggleGroup(g25); G.toggleGroup(gUp);
  if(G.isOpen(g25) !== false || G.isOpen(gUp) !== true) bad.push('isOpen after two taps: ' + [G.isOpen(g25), G.isOpen(gUp)]);

  /* words: in American English, by hand (other locales: only that it is the same as Intl's own) */
  if(/^en-US/.test(Intl.DateTimeFormat().resolvedOptions().locale)){
    if(G.gigLong('2026-10-18') !== 'Sunday, October 18, 2026') bad.push('gigLong: ' + G.gigLong('2026-10-18'));
    if(G.gigShort('2026-10-18') !== 'Sun, Oct 18, 2026') bad.push('gigShort: ' + G.gigShort('2026-10-18'));
    if(G.gigLong('2028-02-29') !== 'Tuesday, February 29, 2028') bad.push('gigLong leap day: ' + G.gigLong('2028-02-29'));
  }
  assert(!bad.length, `${bad.length} problem(s), parser ${matched} of ${NAME_TABLE.length} match:\n    ` + bad.join('\n    '));
}

/* ---------- gigdates 2: the list, dates and the fill-in ---------- */
async function loopList(ctx){
  const now = new Date(), Y = now.getFullYear(), TODAY = dayOff(0);
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    const lang = await page.evaluate(() => navigator.language);
    const short = g => fmt(lang, false).format(localDate(g)), long = g => fmt(lang, true).format(localDate(g));
    const t = Date.now();
    /* earlier this year: New Year's Day and yesterday, when they are before today and in this year */
    const yesterday = dayOff(-1), jan1 = `${Y}-01-01`;
    const thisYear = [];
    if(yesterday.startsWith(String(Y)) && yesterday > jan1) thisYear.push(['Yesterday Gig', yesterday]);
    if(jan1 < TODAY) thisYear.push(['New Year Gig', jan1]);
    if(!thisYear.length) console.log('  (today is January 1: no date earlier this year can exist; the this-year group is checked to be absent)');
    const recs = {
      today: setRec('Today Gig', {gig: TODAY}, t - 20000),
      soon: setRec('Soon Gig', {gig: dayOff(20)}, t - 19000),
      nextYear: setRec('Next Year Gig', {gig: `${Y + 1}-06-15`}, t - 18000),
      lastSpring: setRec('Last Spring', {gig: `${Y - 1}-04-12`}, t - 17000),
      lastWinter: setRec('Last Winter', {gig: `${Y - 1}-12-20`}, t - 16000),
      old: setRec('Old Gig', {gig: `${Y - 2}-08-08`}, t - 15000),
      undatedOld: setRec('Undated Old', {zzz: 1}, t - 5000),
      badFeb: setRec('Bad Feb', {gig: '2026-02-31'}, t - 4000),
      badNumber: setRec('Bad Number', {gig: 20261018}, t - 3000),
      badLong: setRec('Bad Long', {gig: '2026-10-18' + 'x'.repeat(9990)}, t - 2000),
      undatedNew: setRec('Undated New', {}, t - 1000),
    };
    thisYear.forEach(([name, gig], i) => { recs['ty' + i] = setRec(name, {gig}, t - 14000 + i); });
    await putSets(page, Object.values(recs));
    await s.goto();
    const stored0 = await idbAll(page, 'sets');
    await toSets(page);
    assert(!await page.locator('.modal').count(), 'a dialog opened on the Setlists list although no name holds a date');

    /* the groups, as decided: Upcoming soonest first (across years), this year newest first, No date newest made first, earlier years closed */
    const NODATE = ['Undated New', 'Bad Long', 'Bad Number', 'Bad Feb', 'Undated Old'];
    const want0 = [
      {label: 'Upcoming', expanded: 'true', names: ['Today Gig', 'Soon Gig', 'Next Year Gig']},
      ...(thisYear.length ? [{label: String(Y), expanded: 'true', names: thisYear.map(x => x[0])}] : []),
      {label: 'No date', expanded: 'true', names: NODATE},
      {label: `${Y - 1} (2)`, expanded: 'false', names: null},
      {label: `${Y - 2} (1)`, expanded: 'false', names: null}];
    const g0 = await expectGroups(page, want0, 'the grouped list');
    /* each row: the date in short words, then the song count; a bad gig shows no date */
    const byName = Object.fromEntries(Object.values(recs).map(r => [r.name, r]));
    for(const g of g0.groups) for(const r of g.rows || []){
      const gig = r.name.startsWith('Bad') ? null : byName[r.name].gig;       // the "Bad ..." sets hold dates that are not real
      const want = (gig ? short(gig) + ' · ' : '') + '0 songs';
      assert(r.sub === want, `row "${r.name}" reads ${JSON.stringify(r.sub)}, expected ${JSON.stringify(want)}`);
    }
    if(/^en-US/.test(lang) && TODAY === '2026-11-22') assert(g0.groups[0].rows[0].sub === 'Sun, Nov 22, 2026 · 0 songs', 'today\'s row in words: ' + g0.groups[0].rows[0].sub);

    /* last year opens with a tap and closes again; Upcoming closes with a tap */
    const ly = `#view button[data-grp="y${Y - 1}"]`;
    await page.click(ly);
    await page.waitForFunction(sel => document.querySelector(sel)?.getAttribute('aria-expanded') === 'true', ly);
    const lastOpen = want0.map(g => g.label === `${Y - 1} (2)` ? {label: String(Y - 1), expanded: 'true', names: ['Last Winter', 'Last Spring']} : g);
    await expectGroups(page, lastOpen, 'after a tap on last year');
    await page.click('#view button[data-grp="up"]');
    await page.waitForFunction(() => document.querySelector('#view button[data-grp="up"]')?.getAttribute('aria-expanded') === 'false');
    await expectGroups(page, lastOpen.map(g => g.label === 'Upcoming' ? {label: 'Upcoming (3)', expanded: 'false', names: null} : g), 'after a tap on Upcoming');
    await page.click('#view button[data-grp="up"]');
    await page.waitForFunction(() => document.querySelector('#view button[data-grp="up"]')?.getAttribute('aria-expanded') === 'true');
    await expectGroups(page, lastOpen, 'after a second tap on Upcoming');

    /* a bad stored gig is ignored when drawn and left as it is in the record; its open setlist shows no date */
    await openSet(page, recs.badLong.id);
    assert(await gigline(page) === null, 'a setlist with a 10 000 character gig shows a date line: ' + await gigline(page));
    await page.click('#view [data-allsets]');
    await openSet(page, recs.badNumber.id);
    assert(await gigline(page) === null, 'a setlist with a number for a gig shows a date line');
    await page.click('#view [data-allsets]');

    /* set, change and clear a date on an open setlist (Undated Old, which carries an unknown field) */
    const U = recs.undatedOld.id, D1 = dayOff(5), D2 = `${Y - 1}-02-02`;
    await openSet(page, U);
    assert(await gigline(page) === null, 'an undated setlist shows a date line');
    const before = (await idbAll(page, 'sets'))[U];
    await page.click('#view [data-gig]');
    await page.locator('.modal input[type=date]').waitFor();
    assert(await page.locator('.modal input[type=date]').inputValue() === '', 'the Gig date box of an undated setlist is not empty');
    assert(await page.locator('.modal [data-clear]').isDisabled(), 'Clear is offered for a setlist with no date');
    await page.locator('.modal input[type=date]').fill(D1);
    await page.click('.modal [data-x]'); await noModal(page);
    expectSame(before, (await idbAll(page, 'sets'))[U], 'Cancel in the Gig date dialog');
    assert(await gigline(page) === null, 'Cancel showed a date');

    const step = async (what, act, wantGig) => {
      const prev = (await idbAll(page, 'sets'))[U];
      await page.click('#view [data-gig]');
      await page.locator('.modal input[type=date]').waitFor();
      await act();
      await noModal(page);
      const r = await waitFor(async () => { const x = (await idbAll(page, 'sets'))[U]; return x.updated > prev.updated && x; }, `${what}: updated did not move`);
      if(wantGig) assert(r.gig === wantGig, `${what}: stored gig ${JSON.stringify(r.gig)}, expected ${wantGig}`);
      else assert(!('gig' in r), `${what}: the record still has a gig: ${JSON.stringify(r.gig)}`);
      expectSame(without(before, 'gig', 'updated'), without(r, 'gig', 'updated'), `${what}: fields other than gig and updated`);
      await page.waitForFunction(w => (document.querySelector('#view .gigline')?.textContent ?? null) === w, wantGig ? long(wantGig) : null, {timeout: 5000})
        .catch(async () => { throw new Error(`${what}: the date line reads ${JSON.stringify(await gigline(page))}, expected ${JSON.stringify(wantGig && long(wantGig))}`); });
    };
    await step('set a date', async () => { await page.locator('.modal input[type=date]').fill(D1); await page.click('.modal [data-ok]'); }, D1);
    if(/^en-US/.test(lang) && D1 === '2026-11-27') assert(await gigline(page) === 'Friday, November 27, 2026', 'the date line in words: ' + await gigline(page));
    await step('change the date', async () => {
      assert(await page.locator('.modal input[type=date]').inputValue() === D1, 'the Gig date box does not show the date');
      assert(!await page.locator('.modal [data-clear]').isDisabled(), 'Clear is not offered for a dated setlist');
      await page.locator('.modal input[type=date]').fill(D2); await page.click('.modal [data-ok]');
    }, D2);
    await step('clear the date', () => page.click('.modal [data-clear]'), null);
    assert((await idbAll(page, 'sets'))[U].zzz === 1, 'the unknown field did not survive the gig date');

    /* New setlist with a date, and one without */
    await page.click('#view [data-allsets]');
    const D3 = dayOff(10);
    await page.click('#view [data-newset]');
    await page.locator('.modal input[type=text]').fill('Fresh Gig');
    await page.locator('.modal input[type=date]').fill(D3);
    await page.click('.modal [data-ok]');
    await page.waitForFunction(() => document.querySelector('#view h2')?.textContent === 'Fresh Gig');
    assert(await gigline(page) === long(D3), 'new dated setlist date line: ' + await gigline(page));
    const fresh = await waitFor(() => setNamed(page, 'Fresh Gig'), 'Fresh Gig not saved');
    assert(fresh.gig === D3, 'New setlist stored gig ' + JSON.stringify(fresh.gig));
    await page.click('#view [data-allsets]');
    await page.click('#view [data-newset]');
    await page.locator('.modal input[type=text]').fill('Fresh Undated');
    await page.click('.modal [data-ok]');
    await page.waitForFunction(() => document.querySelector('#view h2')?.textContent === 'Fresh Undated');
    assert(!('gig' in await waitFor(() => setNamed(page, 'Fresh Undated'), 'Fresh Undated not saved')), 'a setlist made without a date has a gig');

    /* Duplicate does not copy the date; the original keeps it */
    await page.click('#view [data-allsets]');
    await page.click(`#view [data-dupset="${recs.soon.id}"]`);
    await page.waitForFunction(() => document.querySelector('#view h2')?.textContent === 'Soon Gig copy');
    assert(await gigline(page) === null, 'the copy shows a date');
    const copy = await waitFor(() => setNamed(page, 'Soon Gig copy'), 'copy not saved');
    assert(!('gig' in copy), 'Duplicate copied the gig: ' + JSON.stringify(copy.gig));
    assert((await idbAll(page, 'sets'))[recs.soon.id].gig === recs.soon.gig, 'Duplicate changed the original\'s gig');

    /* reload: the dates are kept, last year is closed again, the bad gigs are still drawn as No date and still stored as they were */
    const gigs = async () => Object.fromEntries((await setsOf(page)).map(x => [x.id, 'gig' in x ? x.gig : '(none)']));
    const gigsBefore = await gigs();
    await s.goto();
    expectSame(gigsBefore, await gigs(), 'gig of every setlist before (left) and after (right) a reload');
    await toSets(page);
    await expectGroups(page, [
      {label: 'Upcoming', expanded: 'true', names: ['Today Gig', 'Fresh Gig', 'Soon Gig', 'Next Year Gig']},
      ...(thisYear.length ? [{label: String(Y), expanded: 'true', names: thisYear.map(x => x[0])}] : []),
      {label: 'No date', expanded: 'true', names: ['Soon Gig copy', 'Fresh Undated', ...NODATE]},
      {label: `${Y - 1} (2)`, expanded: 'false', names: null},
      {label: `${Y - 2} (1)`, expanded: 'false', names: null}], 'after a reload');
    const stored1 = await idbAll(page, 'sets');
    for(const k of ['badFeb', 'badNumber', 'badLong']) expectSame(stored0[recs[k].id], stored1[recs[k].id], `the stored record of ${recs[k].name} (a bad gig is ignored, not rewritten, outside a restore)`);
    assert(!await page.locator('.modal').count(), 'a dialog opened after the reload');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }

  await loopFillIn(ctx);
  await loopNotNow(ctx);
}

/* the fill-in: offered once, the ticked ones get their date, nothing else changes */
async function loopFillIn(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    const lang = await page.evaluate(() => navigator.language), long = g => fmt(lang, true).format(localDate(g));
    const t = Date.now();
    const R = {
      sf: setRec('Sf October 18 2026', {zzz: 1, zzzObj: {k: [1, 2]}}, t - 1000),
      party: setRec('Party 3/7/2026', {}, t - 2000),
      ames: setRec('Ameswell Jan 31', {}, t - 3000),
      two: setRec('Gig 2026-03-07 and 2026-03-08', {}, t - 4000),
      dated: setRec('Dated 2026-05-05', {gig: '2026-06-06'}, t - 5000),
    };
    await putSets(page, Object.values(R));
    await s.goto();
    assert(await page.evaluate(() => localStorage.getItem('ss-gig-fill')) === null, 'ss-gig-fill is set before the question was asked');
    const before = await snapshot(page);
    await page.click('#tSets');
    const dlg = page.locator('.modal [role=dialog]', {hasText: 'Fill in gig dates?'});
    await dlg.waitFor({timeout: 8000}).catch(() => { throw new Error('the fill-in dialog did not appear'); });
    assert((await dlg.locator('h2').textContent()) === 'Fill in gig dates?', 'fill-in title');
    const opts = dlg.locator('label.opt');
    const texts = (await opts.allTextContents()).map(x => x.trim());
    assert(JSON.stringify(texts) === JSON.stringify([`Sf October 18 2026 → ${long('2026-10-18')}`, `Party 3/7/2026 → ${long('2026-03-07')}`]),
      'the fill-in offers ' + JSON.stringify(texts) + ' (only the two names that clearly hold one full date, and no setlist that has a date)');
    if(/^en-US/.test(lang)) assert(texts[0] === 'Sf October 18 2026 → Sunday, October 18, 2026', 'fill-in row in words: ' + texts[0]);
    assert(await opts.locator('input[type=checkbox]:checked').count() === 2, 'not every candidate starts ticked');
    assert(await page.locator('.modal').count() === 1, 'more than one dialog open');
    await opts.filter({hasText: 'Party 3/7/2026'}).locator('input').uncheck();
    await clearToast(page);
    await page.click('.modal [data-ok]');
    await noModal(page);
    await waitToast(page, /^Gig date filled in\.$/);
    const after = await snapshot(page);
    const sf0 = before.sets[R.sf.id], sf1 = after.sets[R.sf.id];
    assert(sf1.gig === '2026-10-18', 'Fill in stored ' + JSON.stringify(sf1.gig));
    assert(sf1.name === 'Sf October 18 2026', 'Fill in renamed the setlist: ' + sf1.name);
    assert(sf1.updated > sf0.updated, `Fill in did not move updated (${sf0.updated} -> ${sf1.updated})`);
    assert(sf1.zzz === 1 && JSON.stringify(sf1.zzzObj) === '{"k":[1,2]}', 'Fill in lost an unknown field: ' + JSON.stringify(sf1));
    expectSame(without(sf0, 'updated'), without(sf1, 'gig', 'updated'), 'Fill in changed more than gig and updated');
    const rest = snap => ({...snap, sets: without(snap.sets, R.sf.id)});
    expectSame(rest(before), rest(after), 'Fill in changed something besides the ticked setlist (the unticked one must stay blank)');
    assert(!('gig' in after.sets[R.party.id]), 'the unticked setlist got a gig');
    assert(await page.evaluate(() => localStorage.getItem('ss-gig-fill')) !== null, 'ss-gig-fill not set after Fill in');
    /* not offered again: a reload, the Setlists tab, and the Library and back */
    await s.goto();
    await page.click('#tSets'); await page.waitForSelector('#view [data-newset]');
    await sleep(800);
    assert(!await page.locator('.modal').count(), 'the fill-in was offered again after a reload (the unticked setlist still holds a date)');
    await page.click('#tLib'); await page.click('#tSets'); await sleep(500);
    assert(!await page.locator('.modal').count(), 'the fill-in was offered again on a second visit');
    expectSame(after, await snapshot(page), 'the library after the reload');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}
/* Not now writes nothing, and it is never offered again */
async function loopNotNow(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await putSets(page, [setRec('Gig 2026-03-07', {}, Date.now() - 1000)]);
    await s.goto();
    const before = await snapshot(page);
    await page.click('#tSets');
    await page.locator('.modal [role=dialog]', {hasText: 'Fill in gig dates?'}).waitFor({timeout: 8000}).catch(() => { throw new Error('the fill-in dialog did not appear'); });
    await page.click('.modal [data-x]');
    await noModal(page);
    await sleep(400);
    expectSame(before, await snapshot(page), 'Not now');
    assert(await page.evaluate(() => localStorage.getItem('ss-gig-fill')) !== null, 'ss-gig-fill not set after Not now');
    await s.goto();
    await page.click('#tSets'); await page.waitForSelector('#view [data-newset]');
    await sleep(800);
    assert(!await page.locator('.modal').count(), 'the fill-in was offered again after Not now');
    expectSame(before, await snapshot(page), 'the library after Not now and a reload');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- gigdates 3: backups and share packages ---------- */
const PDF1 = () => fs.readFileSync(path.join(FIX, 'one-page.pdf'));
/* A backup of one song and the given sets, as `version` 1, 2 or 3 would have written it. */
async function oldZip(version, sets){
  const pdf = PDF1(), t = 1700000000000, id = 'gz' + version + Date.now().toString(36), z = new JSZip();
  z.file(`files/${id}.pdf`, pdf);
  const song = version === 1 ? {id, title: 'Old Song - Some Artist', pages: 1, added: t}
    : {id, title: 'Zip Song', song: 'Zip Song', artist: '', version: '', archived: false, pages: 1, hash: sha256(pdf), added: t, updated: t, ...(version === 3 ? {colls: []} : {})};
  z.file('library.json', JSON.stringify({app: 'setlist-stand', version, saved: new Date().toISOString(), songs: [song],
    sets: sets.map(st => version === 1 ? {id: st.id, name: st.name, songs: [id], created: t} : {items: [{type: 'song', id}], created: t, updated: t, ...(version === 3 ? {colls: []} : {}), ...st}),
    ink: {}, ...(version === 3 ? {colls: []} : {})}));
  const f = path.join(TMP, `gigdates-v${version}-${Date.now()}.zip`);
  await fsp.writeFile(f, await z.generateAsync({type: 'nodebuffer', compression: 'STORE'}));
  return {file: f, songId: id};
}
async function loopBackups(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await importFixtures(page);
    const songs = await songsOf(page), t = Date.now();
    const R = [
      setRec('Dated', {gig: '2026-10-18', items: [{type: 'song', id: songs[0].id}]}, t - 3000),
      setRec('Undated', {items: [{type: 'song', id: songs[1].id}]}, t - 2000),
      setRec('Old and odd', {gig: '2025-01-02', zzz: 1, zzzObj: {k: [1, 2]}, items: [{type: 'break', id: rid('gb'), name: 'Set 2'}]}, t - 1000)];
    await putSets(page, R);
    await s.goto();
    const A = await snapshot(page);
    const {file} = await backupNow(page);
    const data = await libJson(await readZip(file));
    assert(data.version === 3, 'backup version ' + data.version);
    const bset = id => data.sets.find(x => x.id === id);
    assert(bset(R[0].id).gig === '2026-10-18' && bset(R[2].id).gig === '2025-01-02' && bset(R[2].id).zzz === 1, 'the backup lost a gig or the unknown field');
    assert(!('gig' in bset(R[1].id)), 'the backup gave an undated set a gig: ' + JSON.stringify(bset(R[1].id)));
    for(const st of data.sets) expectSame(A.sets[st.id], st, `backup set ${st.name}`);
    await wipeReload(s);
    const msg = await restoreZip(page, file);
    assert(/^Restored 3 songs and 3 setlists$/.test(msg.trim()), 'restore toast (no gig date was dropped, so none is mentioned): ' + msg);
    expectSame(A, await snapshot(page), 'snapshot before the backup (left) vs after wipe + restore (right)');

    /* version 1, 2 and 3 backups that have never heard of gig dates restore with none, and the list stays flat */
    for(const v of [1, 2, 3]){
      await wipeReload(s);
      const ids = [rid('gv'), rid('gv')];
      const {file: f} = await oldZip(v, [{id: ids[0], name: 'Old Set A'}, {id: ids[1], name: 'Old Set B'}]);
      const m = await restoreZip(page, f);
      assert(/^Restored 1 song and 2 setlists$/.test(m.trim()), `version ${v} restore toast: ` + m);
      const sets = await setsOf(page);
      assert(sets.length === 2 && sets.every(x => !('gig' in x)), `a version ${v} restore gave a set a gig: ` + JSON.stringify(sets.map(x => [x.name, x.gig])));
      assert(sets.every(x => x.items.length === 1 && x.items[0].type === 'song'), `version ${v} items: ` + JSON.stringify(sets.map(x => x.items)));
      await toSets(page);
      const l = await readList(page);
      assert(l.flat && JSON.stringify(l.flat.map(r => r.name).sort()) === '["Old Set A","Old Set B"]' && l.flat.every(r => r.sub === '1 song'), `version ${v}: the list is not the flat list of old: ` + JSON.stringify(l));
      assert(!await page.locator('.modal').count(), `version ${v}: a dialog opened`);
      await page.click('#tLib');
    }
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }

  /* a share package made from a dated setlist holds no date; importing a package gives a setlist with none */
  let pkgFile, pk;
  const sa = await ctx.session();
  try{
    const {page} = sa;
    await sa.goto();
    await page.setInputFiles('#file', path.join(FIX, 'one-page.pdf'));
    await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 1, null, {timeout: 20000});
    const [song] = await songsOf(page);
    const st = setRec('Friday Show', {gig: '2026-10-18', items: [{type: 'song', id: song.id}, {type: 'break', id: rid('gb'), name: 'Set 2'}]});
    await putSets(page, [st]);
    await sa.goto();
    const before = await snapshot(page);
    await toSets(page);
    await openSet(page, st.id);
    pkgFile = (await download(page, () => page.click('#view [data-shareset]'))).file;
    await closeDone(page);
    pk = await readPackage(pkgFile);
    const keys = [];
    const walk = (v, at) => { if(v && typeof v === 'object') for(const [k, x] of Object.entries(v)){ keys.push(at + '.' + k); walk(x, at + '.' + k); } };
    walk(pk.share, 'share');
    assert(!keys.some(k => /gig/i.test(k.split('.').pop())), 'share.json has a gig field: ' + keys.filter(k => /gig/i.test(k)).join(', '));
    assert(!pk.text.includes('2026-10-18') && !/october|oct 18|10\/18\/2026/i.test(pk.text), 'the gig date is in share.json: ' + pk.text.slice(0, 300));
    assert(JSON.stringify(Object.keys(pk.share.setlist).sort()) === '["items","name"]', 'setlist keys in the package: ' + Object.keys(pk.share.setlist));
    assert(pk.share.setlist.name === 'Friday Show' && pk.share.version === 1, 'package setlist name or SHARE_VERSION: ' + pk.share.setlist.name + ' ' + pk.share.version);
    expectSame(before, await snapshot(page), 'sharing a dated setlist changed the library');
    assert(!sa.errors.length, 'page errors: ' + sa.errors.join(' | '));
  } finally { await sa.close(); }

  /* the same package with a gig planted in its setlist (someone else's file, or a later version): still no date here */
  const z = new JSZip();
  z.file('share.json', JSON.stringify({...pk.share, setlist: {...pk.share.setlist, gig: '2026-10-18'}}));
  for(const [id, bytes] of Object.entries(pk.pdfs)) z.file(`files/${id}.pdf`, bytes);
  const planted = path.join(TMP, 'gigdates-planted-share.zip');
  await fsp.writeFile(planted, await z.generateAsync({type: 'nodebuffer', compression: 'STORE'}));

  const sb = await ctx.session();
  try{
    const {page} = sb;
    await sb.goto();
    const importPkg = async (f, toast) => {
      await page.click('#tLib');
      await clearToast(page);
      await page.setInputFiles('#shareFile', f);
      await page.locator('.modal [role=dialog]', {hasText: 'Import share package'}).waitFor({timeout: 30000})
        .catch(async () => { throw new Error('no import question; ' + (await page.locator('.modal').textContent().catch(() => 'no dialog'))); });
      await page.click('.modal [data-ok]');
      await waitToast(page, toast);
      await noModal(page);
    };
    await importPkg(pkgFile, /^Added 1 song, the setlist Friday Show\.$/);
    let st = await setNamed(page, 'Friday Show');
    assert(st && !('gig' in st), 'a setlist imported from a package has a gig: ' + JSON.stringify(st));
    await importPkg(planted, /the setlist Friday Show \(2\)\.$/);
    st = await setNamed(page, 'Friday Show (2)');
    assert(st && !('gig' in st), 'a package with a planted gig gave the imported setlist a gig: ' + JSON.stringify(st));
    await toSets(page);
    const l = await readList(page);
    assert(l.flat && l.flat.length === 2, 'imported setlists are not the flat undated list: ' + JSON.stringify(l));
    assert(!sb.errors.length, 'page errors: ' + sb.errors.join(' | '));
  } finally { await sb.close(); }
}

/* ---------- gigdates 4: a backup with bad gig dates (DEPENDS ON THE RESTORE HEAL in js/backup.js restoreFrom) ---------- */
async function loopHostile(ctx){
  const LONG = '2026-10-18' + 'x'.repeat(9990);
  const sets = [
    {id: rid('gh'), name: 'Good Date', gig: '2026-10-18', zzz: 1},
    {id: rid('gh'), name: 'Bad Month', gig: '2026-13-01'},
    {id: rid('gh'), name: 'Bad Day', gig: '2026-02-31', zzz: 1, zzzObj: {k: [1, 2]}},
    {id: rid('gh'), name: 'Bad Type', gig: 20261018},
    {id: rid('gh'), name: 'Bad Long', gig: LONG},
    {id: rid('gh'), name: 'No Gig'}];
  assert(LONG.length === 10000, 'test setup: the long gig is not 10 000 characters');
  const {file} = await oldZip(3, sets);
  const backup = (await libJson(await readZip(file))).sets;
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await clearToast(page);
    await page.click('#tLib');
    await page.setInputFiles('#restoreFile', file);
    await waitToast(page, /Restored|Nothing was changed|not a Setlist Stand backup/, 60000);
    const msg = (await page.locator('#toast').textContent()).trim();
    /* NOT pending: a bad gig never refuses the backup */
    assert(/^Restored 1 song and 6 setlists\b/.test(msg), 'a backup with bad gig dates was not restored: ' + msg);
    /* PENDING HEAL: the toast counts the dropped dates */
    assert(/^Restored 1 song and 6 setlists\. 4 gig date(?:s|\(s\))? that were not real dates were left out\.$/.test(msg), 'restore toast does not count the 4 dropped gig dates: ' + msg);
    const got = Object.fromEntries((await setsOf(page)).map(x => [x.id, x]));
    for(const b of backup){
      const r = got[b.id];
      assert(r, `set ${b.name} not restored`);
      /* NOT pending: the good one keeps its date and every set keeps all its other fields */
      if(b.name === 'Good Date') expectSame(b, r, 'Good Date (kept whole, gig and unknown field included)');
      else expectSame(without(b, 'gig'), without(r, 'gig'), `${b.name}: fields other than gig`);
      /* PENDING HEAL: the bad gig is gone from the record */
      if(b.name.startsWith('Bad')) assert(!('gig' in r), `${b.name}: the bad gig ${JSON.stringify(String(r.gig).slice(0, 20))} was kept`);
      if(b.name === 'No Gig') assert(!('gig' in r), 'No Gig got a gig');
    }
    /* NOT pending: on screen the bad ones are No date */
    await toSets(page);
    /* No date: all made at the same moment, so by id (rid() ids sort in the order written). Good Date (2026-10-18) sits where
       its date puts it today: Upcoming, this year's past (2026), or a closed earlier year placed after No date. */
    const noDate = {label: 'No date', expanded: 'true', names: ['Bad Month', 'Bad Day', 'Bad Type', 'Bad Long', 'No Gig']};
    const want = dayOff(0) <= '2026-10-18' ? [{label: 'Upcoming', expanded: 'true', names: ['Good Date']}, noDate]
      : new Date().getFullYear() === 2026 ? [{label: '2026', expanded: 'true', names: ['Good Date']}, noDate]
      : [noDate, {label: '2026 (1)', expanded: 'false', names: null}];
    await expectGroups(page, want, 'the restored list');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'gigdates 1: parser table, validGig / cleanGig, and the groups in Node', run: loopNode},
  {name: 'gigdates 2: the list, dates and the fill-in', run: loopList},
  {name: 'gigdates 3: backups and share packages', run: loopBackups},
  {name: 'gigdates 4: a backup with bad gig dates restores with them dropped and counted, the rest of each set kept (needs the restore heal)', run: loopHostile},
];

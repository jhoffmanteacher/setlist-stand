/*
 * phone 1: the Library, the Setlists list and every dialog at phone size (Part 1 of the phone-layout work order, Jonathan, 2026-11-23).
 *
 * One loop per screen size (360x800, 390x844, 412x915, 360x640, 360x420 = 800 with the keyboard up, 800x360, 915x412, 844x390), each in a
 * phone-like Chromium context (isMobile, hasTouch, deviceScaleFactor 2, `screen` equal to the window) holding a library restored from a
 * backup built here: 37 songs (one with a very long title), two collections (one named "Thursday Jazz Trio at the Harbor"), dated and
 * undated setlists (one with a break and a very long name), and the backup reminder showing. Every screen below is opened through its
 * REAL button and read from the SCREEN; nothing is computed with the code under test. For each screen the loop asserts
 *   - the page does not scroll sideways (scrollWidth <= window width), before and after the last item is tapped;
 *   - the dialog's buttons are fully on the screen, and nothing covers them (what is at a button's centre is the button);
 *   - the dialog's heading is on the screen;
 *   - the LAST item of the dialog can be reached (scrolled to) and tapped, and does what it should (a menu's last item opens the next
 *     box, a tick box becomes ticked, a field takes its text, a Delete button arms);
 *   - the dialog closes by tapping its Cancel / Close / Done.
 * Per size it also asserts: the A to Z strip's letters (when shown) are each at least 14 px high and do not overlap, at the top, in the
 * middle and at the foot of the page; a long toast is at least 80% of the screen wide and inside it; nothing stored changed; no page errors.
 * It prints N of N per size and, for the work order, the first song row's top, the strip's smallest letter and whether a song row shows
 * without scrolling. Safe areas are drawn as 0 here (see plant-faults for the one the loops cannot see).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {FIX, TMP, assert, sleep, sha256, snapshot, diff, restoreZip, JSZip, WEBKIT} from './harness.mjs';
import {openTablet, syncTap, libraryOf, readDrive, reportCounts} from './sync-two.mjs';
import {openOn, closeViewer, uiLine, pageOf, entriesOf, PEN} from './sync-ink-kit.mjs';

const SIZES = [[360, 800], [390, 844], [412, 915], [360, 640], [360, 420], [800, 360], [915, 412], [844, 390]];
const BAND = 'Thursday Jazz Trio at the Harbor';
const NAMES = [
  ["'Round Midnight", 'Monk'], ['2 Fast', 'Dev'], ['A Day in the Life', 'Beatles'], ['Agua de Beber', 'Jobim'], ["Ain't No Sunshine", 'Withers'],
  ['Alone Together', 'Dietz'], ['Back in Black', 'AC/DC'], ['Blackbird', 'Beatles'], ['Come Together', 'Beatles'], ['Dock of the Bay', 'Redding'],
  ["Don't Stop", 'Mac'], ['Fly Me to the Moon', 'Howard'], ['Fool on the Hill', 'Beatles'], ['Georgia on My Mind', 'Carmichael'], ['Hotel California', 'Eagles'],
  ['I Shot the Sheriff', 'Marley'], ['Jolene', 'Parton'], ['Kansas City', 'Leiber'], ['Layla', 'Clapton'], ['Let It Be', 'Beatles'],
  ['Misty', 'Garner'], ['Moondance', 'Morrison'], ['Nights in White Satin', 'Moody Blues'], ['Over the Rainbow', 'Arlen'], ['Purple Haze', 'Hendrix'],
  ['Respect', 'Redding'], ['Stand by Me', 'King'], ['Sultans of Swing', 'Dire Straits'], ['Take Five', 'Brubeck'], ['Under the Bridge', 'Chili Peppers'],
  ['Valerie', 'Winehouse'], ['What a Wonderful World', 'Armstrong'], ['Wonderwall', 'Oasis'], ['Yesterday', 'Beatles'], ['Zombie', 'Cranberries'], ['Zorba', 'Theodorakis'],
];
const LONG = {song: 'The Extremely Long Song Name That Goes On and On for a Very Long Time', artist: 'Someone With a Really Long Artist Name and Band',
  version: 'arranged for the Thursday Jazz Trio at the Harbor'};
const LONG_SET = 'Thursday Jazz Trio at the Harbor Summer Series Opening Night Extended Edition';
const pad = n => String(n).padStart(2, '0');
const dayFromNow = n => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/* A backup (version 3) of the whole fixture library. */
async function backupFile(){
  const zip = new JSZip(), base = fs.readFileSync(path.join(FIX, 'one-page.pdf')), songs = [], T = 1700000000000;
  const all = [...NAMES.map(([song, artist]) => ({song, artist, version: ''})), {...LONG}];
  all.forEach((x, i) => {
    const id = i === all.length - 1 ? 'ph-long' : `ph${i}`, bytes = Buffer.concat([base, Buffer.from(`\n% phone ${i}\n`)]);
    zip.file(`files/${id}.pdf`, bytes);
    const v = x.version ? ` (${x.version})` : '', title = `${x.song}${v} - ${x.artist}`;
    songs.push({id, title, song: x.song, artist: x.artist, version: x.version, archived: false, colls: i < 14 || id === 'ph-long' ? ['phh'] : i < 22 ? ['phb'] : [], pages: 1,
      hash: sha256(bytes), added: T + i, updated: T + i});
  });
  const ids = songs.map(s => s.id), sg = (...ix) => ix.map(i => ({type: 'song', id: ids[i]}));
  const set = (id, name, items, extra = {}) => ({id, name, items, colls: [], created: T, updated: T, ...extra});
  const sets = [
    set('phs1', LONG_SET, [...sg(0, 1, 2, 3), {type: 'break', id: 'phbrk', name: 'Set break'}, ...sg(4, 5, 6, 36)], {gig: dayFromNow(40), colls: ['phh']}),
    set('phs2', 'Rehearsal', sg(7, 8, 9)),
    set('phs3', 'Old wedding', sg(10, 11), {gig: '2020-03-14'}),
    set('phs4', 'Next week', sg(12, 13), {gig: dayFromNow(7)}),
    set('phs5', 'Empty list', []),
    ...[18, 19, 20, 21, 22, 23].map((d, i) => set(`phf${i}`, `Harbor Gig October ${d} 2031`, sg(14 + i))),
  ];
  const colls = [{id: 'phh', name: BAND, created: T, updated: T}, {id: 'phb', name: 'Band Two', created: T, updated: T}];
  zip.file('library.json', JSON.stringify({app: 'setlist-stand', version: 3, saved: new Date().toISOString(), songs, sets, colls, ink: {}}));
  const f = path.join(TMP, 'phone-backup.zip');
  await fsp.writeFile(f, await zip.generateAsync({type: 'nodebuffer'}));
  return f;
}
const textFile = () => Buffer.from([...NAMES.slice(0, 30).map(([s], i) => `${i + 1}. ${s}`), 'Break', 'A song that is not in the library at all', ...NAMES.slice(30).map(([s]) => s)].join('\n'));

/* ---------- reading the screen ---------- */
const sideways = page => page.evaluate(() => ({sw: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), w: window.innerWidth}));
const modalCount = page => page.locator('.modal').count();
async function closeAll(page){
  for(let i = 0; i < 6 && await modalCount(page); i++){ await page.keyboard.press('Escape'); await sleep(120); }
  for(let i = 0; i < 4 && await modalCount(page); i++){ await page.locator('.modal').last().locator('[data-x]').first().click({force: true}).catch(() => {}); await sleep(120); }
}
const toLib = async page => { await closeAll(page); await page.locator('#tLib').tap(); await page.waitForSelector('#libList [data-open]'); };
async function toSets(page){
  await closeAll(page); await page.locator('#tSets').tap();
  await page.waitForSelector('[data-newset], [data-allsets]');
  if(await page.locator('[data-allsets]').count()){ await page.locator('[data-allsets]').tap(); await page.waitForSelector('[data-newset]'); }
}
async function openSet(page, id){ await toSets(page); await page.locator(`[data-set="${id}"]`).tap(); await page.waitForSelector('[data-setmenu]'); }
async function menuItem(page, buttonSel, item, wait = '.modal'){
  await page.locator(buttonSel).tap(); await page.locator('.modal.menubox').waitFor();
  await page.locator(`.modal.menubox [data-item="${item}"]`).tap(); await page.locator(wait).last().waitFor();
}
const topModal = page => page.locator('.modal').last();
/* geometry of the top dialog: its box, its buttons, its heading */
const dialogGeo = page => page.evaluate(() => {
  const ms = document.querySelectorAll('.modal'), m = ms[ms.length - 1]; if(!m) return null;
  const box = m.querySelector('.box'), W = window.innerWidth, H = window.innerHeight;
  const rect = e => { const b = e.getBoundingClientRect(); return {l: b.left, t: b.top, r: b.right, b: b.bottom}; };
  const hit = e => { const b = e.getBoundingClientRect(), c = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2); return !!c && (c === e || e.contains(c)); };
  const btns = [...box.querySelectorAll('.btns button')].filter(b => b.getBoundingClientRect().width > 0).map(b => ({name: b.textContent.trim().slice(0, 20), ...rect(b), hit: hit(b)}));
  const h = box.querySelector('h1, h2, h3'), hr = h ? rect(h) : null;
  return {W, H, box: rect(box), btns, h: h ? {...hr, hit: hit(h)} : null, scrolls: box.scrollHeight > box.clientHeight + 1};
});
const inside = (r, W, H) => r.l >= -0.5 && r.t >= -0.5 && r.r <= W + 0.5 && r.b <= H + 0.5;
const fmt = r => `[${Math.round(r.l)},${Math.round(r.t)} to ${Math.round(r.r)},${Math.round(r.b)}]`;

/* ---------- one size ---------- */
function recorder(){
  const checks = [];
  return {checks, ok: (name, cond, detail = '') => { checks.push({name, pass: !!cond, detail: cond ? '' : detail}); return !!cond; },
    get passed(){ return checks.filter(c => c.pass).length; }, failures(){ return checks.filter(c => !c.pass).map(c => `${c.name}: ${c.detail}`); }};
}

/* One dialog screen. def = {name, open(page), last (a selector inside the dialog or null), lastAct ('tap' | 'fill'), lastOk(page) -> what must be true after, lastWhy} */
async function dialogScreen(page, rec, def){
  const tag = def.name;
  try{
    await def.open(page);
    await sleep(150);
    let g = await dialogGeo(page);
    if(!rec.ok(`${tag}: a dialog opened`, !!g, 'no .modal on the screen')) return;
    const s0 = await sideways(page);
    rec.ok(`${tag}: no sideways scroll`, s0.sw <= s0.w, `scrollWidth ${s0.sw} > window ${s0.w}`);
    rec.ok(`${tag}: box on screen`, inside(g.box, g.W, g.H), `box ${fmt(g.box)} on a ${g.W}x${g.H} screen`);
    const bad = g.btns.filter(b => !inside(b, g.W, g.H) || !b.hit);
    rec.ok(`${tag}: buttons on screen and not covered`, g.btns.length > 0 && !bad.length, `${g.btns.length ? bad.map(b => `${b.name} ${fmt(b)}${b.hit ? '' : ' covered'}`).join(', ') : 'no buttons'} (screen ${g.W}x${g.H})`);
    rec.ok(`${tag}: heading on screen`, !g.h || (inside(g.h, g.W, g.H) && g.h.hit), g.h ? `heading ${fmt(g.h)}${g.h.hit ? '' : ' covered'}` : '');
    if(def.last){
      const loc = topModal(page).locator(def.last).last();
      /* what a finger does: scroll every scrolling box around the item (the dialog, a list inside it) all the way to its end */
      await loc.evaluate(e => { for(let a = e.parentElement; a && !a.classList.contains('modal'); a = a.parentElement) if(a.scrollHeight > a.clientHeight + 1) a.scrollTop = a.scrollHeight; e.scrollIntoView({block: 'nearest'}); }).catch(() => {});      // (a fieldset reports no overflow but does scroll: scrollIntoView reaches it)
      await sleep(100);
      const state = await loc.evaluate(e => {
        const b = e.getBoundingClientRect(), c = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
        const own = !!c && (c === e || e.contains(c) || c.contains(e) || (c.closest('label') && c.closest('label') === e.closest('label')));
        const bt = e.closest('.box') && e.closest('.box').querySelector('.btns'), br = bt && bt.getBoundingClientRect();
        const under = !!br && br.width > 0 && b.bottom > br.top + 0.5 && b.top < br.bottom;       // the item's lower part runs under the buttons
        return {l: b.left, t: b.top, r: b.right, b: b.bottom, own, under, btnTop: br ? br.top : null, W: innerWidth, H: innerHeight, covered: c ? (c.className || c.tagName) : 'nothing'};
      }).catch(err => ({err: err.message}));
      if(!rec.ok(`${tag}: last item reachable and clear of the buttons`, !state.err && state.own && !state.under && inside(state, state.W, state.H),
        state.err || `${def.last} at ${fmt(state)} on a ${state.W}x${state.H} screen${state.own ? '' : ', covered by ' + state.covered}${state.under ? `, its lower edge ${Math.round(state.b)} runs under the buttons that start at ${Math.round(state.btnTop)}` : ''}`)){ await closeAll(page); return; }
      try{
        const was = await loc.evaluate(e => e.checked).catch(() => null);
        if(def.lastAct === 'fill') await loc.fill(def.fill, {timeout: 4000}); else if(def.lastAct !== 'none') await loc.tap({timeout: 4000});
        await sleep(200);
        rec.ok(`${tag}: last item acts`, await def.lastOk(page, was), def.lastWhy || 'the last item did nothing');
      }catch(err){ rec.ok(`${tag}: last item acts`, false, 'tap failed: ' + err.message.split('\n')[0]); }
      const s1 = await sideways(page);
      rec.ok(`${tag}: no sideways scroll after the last item`, s1.sw <= s1.w, `scrollWidth ${s1.sw} > window ${s1.w}`);
      const g2 = await dialogGeo(page);
      if(g2){
        const bad2 = g2.btns.filter(b => !inside(b, g2.W, g2.H) || !b.hit);
        rec.ok(`${tag}: buttons still on screen after the last item`, !bad2.length, bad2.map(b => `${b.name} ${fmt(b)}`).join(', '));
      }
    }
    /* close by tapping Cancel / Close / Done of whatever is on top, until none is left */
    let open = await modalCount(page), closed = true;
    for(let i = 0; i < open + 1 && await modalCount(page); i++){
      const before = await modalCount(page);
      await topModal(page).locator('.btns [data-x]').first().tap({timeout: 3000}).catch(() => {});
      await sleep(250);
      if(await modalCount(page) >= before){ closed = false; break; }
    }
    rec.ok(`${tag}: closes by a tap on its Cancel`, closed && !(await modalCount(page)), `${await modalCount(page)} dialog(s) still open`);
  }catch(err){
    rec.ok(`${tag}: ran`, false, err.message.split('\n')[0]);
  }finally{ await closeAll(page); }
}

const SCREENS = [
  {name: 'song menu', open: async p => { await toLib(p); await p.locator('#libList [data-songmenu="ph-long"]').tap(); await p.locator('.modal.menubox').waitFor(); },
    last: '[data-item]', lastOk: async p => !!(await p.locator('.modal.delask').count()), lastWhy: 'Delete did not open its question'},
  {name: 'song Delete question', open: async p => { await toLib(p); await p.locator('#libList [data-songmenu="ph-long"]').tap(); await p.locator('[data-item="del"]').tap(); await p.locator('.modal.delask').waitFor(); },
    last: null},
  {name: 'Edit song', open: async p => { await toLib(p); await p.locator('#libList [data-songmenu="ph-long"]').tap(); await p.locator('[data-item="edit"]').tap(); await p.locator('.modal [data-ok]').waitFor(); },
    last: 'fieldset.checks input[type=checkbox]', lastOk: async (p, was) => (await topModal(p).locator('fieldset.checks input').last().isChecked()) !== was, lastWhy: 'the last collection box did not change'},
  {name: 'Share / Import menu', open: async p => { await toLib(p); await p.locator('[data-sharemenu]').tap(); await p.locator('.modal.menubox').waitFor(); },
    last: '[data-item="share"]', lastOk: async p => /Share songs/.test(await topModal(p).locator('h2').innerText()), lastWhy: 'Share songs did not open'},
  {name: 'Share songs', open: async p => { await toLib(p); await menuItem(p, '[data-sharemenu]', 'share'); await p.locator('.modal .pick').waitFor(); },
    last: '.pick label', lastOk: async p => (await topModal(p).locator('.pick input').last().isChecked()), lastWhy: 'the last song did not get ticked'},
  {name: 'Back up / Sync menu', open: async p => { await toLib(p); await p.locator('[data-backupmenu]').tap(); await p.locator('.modal.menubox').waitFor(); },
    last: '[data-item="drive"]', lastOk: async p => !!(await p.locator('.modal.drivebox').count()), lastWhy: 'Google Drive settings did not open'},
  {name: 'Google Drive box', open: async p => { await toLib(p); await menuItem(p, '[data-backupmenu]', 'drive', '.modal.drivebox'); },
    last: '#driveCtl button, #driveCtl p', lastAct: 'none', lastOk: async () => true},
  {name: 'Restore this backup? question', open: async p => { await toLib(p); await p.setInputFiles('#restoreFile', await backupFile()); await p.locator('.modal.restoreask').waitFor({timeout: 120000}); },
    last: null},
  {name: 'Setlists row menu', open: async p => { await toSets(p); await p.locator('[data-setrowmenu="phs1"]').tap(); await p.locator('.modal.menubox').waitFor(); },
    last: '[data-item="del"]', lastOk: async p => !!(await p.locator('.modal.delask').count()), lastWhy: 'Delete did not open its question'},
  {name: 'Setlist Delete question', open: async p => { await toSets(p); await p.locator('[data-setrowmenu="phs1"]').tap(); await p.locator('[data-item="del"]').tap(); await p.locator('.modal.delask').waitFor(); },
    last: null},
  {name: 'New setlist', open: async p => { await toSets(p); await p.locator('[data-newset]').tap(); await p.locator('.modal [data-name]').waitFor(); },
    last: '[data-gig]', lastAct: 'fill', fill: '2031-02-03', lastOk: async p => (await topModal(p).locator('[data-gig]').inputValue()) === '2031-02-03', lastWhy: 'the date did not take'},
  {name: 'open setlist More menu', open: async p => { await openSet(p, 'phs1'); await p.locator('[data-setmenu]').tap(); await p.locator('.modal.menubox').waitFor(); },
    last: '[data-item="colls"]', lastOk: async p => /Collections/.test(await topModal(p).locator('h2').innerText()) && !(await p.locator('.modal.menubox').count()), lastWhy: 'Collections did not open'},
  {name: 'setlist Collections', open: async p => { await openSet(p, 'phs1'); await menuItem(p, '[data-setmenu]', 'colls'); await p.locator('.modal fieldset.checks').waitFor(); },
    last: 'fieldset.checks input[type=checkbox]', lastOk: async (p, was) => (await topModal(p).locator('fieldset.checks input').last().isChecked()) !== was, lastWhy: 'the last box did not change'},
  {name: 'gig-date dialog', open: async p => { await openSet(p, 'phs1'); await menuItem(p, '[data-setmenu]', 'gig'); await p.locator('.modal [data-gig]').waitFor(); },
    last: '[data-gig]', lastAct: 'fill', fill: '2031-02-03', lastOk: async p => (await topModal(p).locator('[data-gig]').inputValue()) === '2031-02-03', lastWhy: 'the date did not take'},
  {name: 'Add songs', open: async p => { await openSet(p, 'phs2'); await p.locator('[data-addto]').tap(); await p.locator('.modal .pick').waitFor(); },
    last: '.pick label', lastOk: async p => /Add 1/.test(await topModal(p).locator('.btns .pri').innerText()), lastWhy: 'the last song did not get number 1 (the button does not read "Add 1")'},
  {name: 'Download PDF', open: async p => { await openSet(p, 'phs1'); await menuItem(p, '[data-setmenu]', 'print'); await p.locator('#pInk').waitFor(); },
    last: '#pInk', lastOk: async p => !(await p.locator('#pInk').isChecked()), lastWhy: 'the annotations box did not untick'},
  {name: 'Collections manager', open: async p => { await toLib(p); await p.locator('[data-collmanage]').tap(); await p.locator('.modal .mgr .mrow').first().waitFor(); },
    last: '.mrow [data-mdel]', lastOk: async p => /Songs stay in your library/.test(await topModal(p).locator('.mrow [data-mdel]').last().innerText()), lastWhy: 'Delete did not ask for its second tap'},
  {name: 'New collection name', open: async p => { await toLib(p); await p.locator('[data-collmanage]').tap(); await p.locator('[data-newcoll]').tap(); await p.locator('.modal input[type=text]').waitFor(); },
    last: 'input[type=text]', lastAct: 'fill', fill: 'A new band', lastOk: async p => (await topModal(p).locator('input[type=text]').inputValue()) === 'A new band', lastWhy: 'the name did not take'},
  {name: 'text import review', open: async p => {
      await toSets(p);
      const [fc] = await Promise.all([p.waitForEvent('filechooser', {timeout: 5000}), p.locator('[data-importtext]').tap()]);
      await fc.setFiles({name: 'Phone import.txt', mimeType: 'text/plain', buffer: textFile()});
      await p.locator('.modal.textimport').waitFor({timeout: 10000}); },
    last: 'ol.tlines li', lastOk: async () => true},
  {name: 'gig-date fill-in', open: async p => {
      await p.evaluate(() => localStorage.removeItem('ss-gig-fill'));
      await toLib(p); await p.locator('#tSets').tap(); await p.locator('.modal fieldset.checks').waitFor({timeout: 6000}); },
    last: 'fieldset.checks input[type=checkbox]', lastOk: async (p, was) => (await topModal(p).locator('fieldset.checks input').last().isChecked()) !== was, lastWhy: 'the last box did not change'},
];

/* the strip: every letter drawn at least 14 px high and clear of its neighbours, at the top, the middle and the foot of the page */
async function stripState(page){
  return page.evaluate(() => {
    const el = document.getElementById('azStrip'); if(!el) return {none: true};
    const H = innerHeight, cs = getComputedStyle(el), hidden = cs.visibility === 'hidden' || cs.display === 'none';
    const letters = [...el.querySelectorAll('[data-az]')].filter(b => getComputedStyle(b).display !== 'none').map(b => { const r = b.getBoundingClientRect(); return {L: b.dataset.az, t: r.top, b: r.bottom, h: r.height}; });
    return {hidden, cls: el.className, H, letters: hidden ? [] : letters};
  });
}
async function stripChecks(page, rec, minLetter){
  const seen = [];
  for(const [name, y] of [['top', 0], ['middle', 0.5], ['foot', 1]]){
    await page.evaluate(f => window.scrollTo(0, f * (document.documentElement.scrollHeight - innerHeight)), y);
    await sleep(350);
    const s = await stripState(page);
    if(s.none){ rec.ok(`strip at ${name}: drawn`, false, 'no strip with 37 songs'); continue; }
    seen.push(`${name}:${s.hidden ? 'off' : s.letters.length}`);
    let why = '';
    const ls = s.letters;
    for(let i = 0; i < ls.length; i++){
      if(ls[i].h < 14 - 0.01) why = `letter ${ls[i].L} is ${ls[i].h.toFixed(1)} px high`;
      else if(ls[i].t < -0.5 || ls[i].b > s.H + 0.5) why = `letter ${ls[i].L} at ${Math.round(ls[i].t)} to ${Math.round(ls[i].b)} is off a ${s.H} px screen`;
      else if(i && ls[i].t < ls[i - 1].b - 0.5) why = `letters ${ls[i - 1].L} and ${ls[i].L} overlap (${ls[i - 1].b.toFixed(1)} over ${ls[i].t.toFixed(1)})`;
      if(why) break;
    }
    rec.ok(`strip at ${name} (${s.hidden ? 'hidden' : s.letters.length + ' letters'}): each letter at least 14 px, none over another`, !why, why);
    for(const l of ls) minLetter.v = Math.min(minLetter.v, l.h);
  }
  await page.evaluate(() => window.scrollTo(0, 0)); await sleep(250);
  return seen.join(' ');
}

async function toast(page, rec, wide = true){
  await toLib(page);
  const msg = 'This is a long message that explains what went wrong and what to do about it, the way a refusal in this app does. Nothing was changed.';
  await page.evaluate(m => import(new URL('js/util.js', location.href).href).then(u => u.toast(m)), msg);
  await sleep(450);
  const t = await page.evaluate(() => { const e = document.getElementById('toast'), b = e.getBoundingClientRect(); return {l: b.left, r: b.right, w: b.width, W: innerWidth, on: e.classList.contains('on')}; });
  if(wide) rec.ok('long toast: at least 80% of the screen wide and inside it', t.on && t.w >= 0.8 * t.W && t.l >= -0.5 && t.r <= t.W + 0.5, `toast ${t.w.toFixed(0)} px wide of ${t.W} (${(100 * t.w / t.W).toFixed(0)}%), from ${t.l.toFixed(0)} to ${t.r.toFixed(0)}`);
  return t;
}

async function reminder(page, mode){
  await page.evaluate(m => { localStorage.removeItem('ss-last-backup'); if(m === 'both') localStorage.setItem('ss-last-sync', '1699999999999'); else localStorage.removeItem('ss-last-sync'); }, mode);
  await toLib(page); await page.locator('#tSets').tap(); await page.waitForSelector('[data-newset], [data-allsets]'); await toLib(page);
  await page.waitForSelector('#libNudge .nudge');
  if(mode === 'both') assert(await page.locator('#libNudge [data-backupnow]').count() && await page.locator('#libNudge [data-syncnow]').count(), 'the reminder does not show both Back up now and Sync');
}
const libTop = page => page.evaluate(() => { window.scrollTo(0, 0); const r = document.querySelector('#libList .row'); if(!r) return null; const b = r.getBoundingClientRect(); return {top: b.top, bottom: b.bottom, H: innerHeight}; });

async function runSize(ctx, [W, H], out){
  const rec = recorder(), session = await ctx.session({viewport: {width: W, height: H}, screen: {width: W, height: H}, hasTouch: true, isMobile: true, deviceScaleFactor: 2});
  const info = {};
  try{
    const {page} = session;
    await session.goto();
    await page.evaluate(() => { try{ localStorage.setItem('ss-gig-fill', '1'); }catch(e){} });
    await restoreZip(page, await backupFile());
    await page.waitForSelector('#libList [data-open]');
    const w = await page.evaluate(() => ({w: innerWidth, h: innerHeight, dpr: devicePixelRatio, sw: screen.width, sh: screen.height, touch: navigator.maxTouchPoints > 0}));
    rec.ok('the device is the size asked for', w.w === W && w.h === H && w.dpr === 2 && w.sw === W && w.sh === H, JSON.stringify(w));
    const before = await snapshot(page);
    await reminder(page, 'plain');

    /* the Library */
    const s0 = await sideways(page);
    rec.ok('Library: no sideways scroll', s0.sw <= s0.w, `scrollWidth ${s0.sw} > window ${s0.w}`);
    const lib = await libTop(page);
    info.rowTop = lib && Math.round(lib.top);
    info.rowShows = !!lib && lib.top >= 0 && lib.bottom <= lib.H;
    if(W === 360 && H === 800) rec.ok('Library: the first song row starts at y <= 430 with two collections and the reminder', lib && lib.top <= 430, `the first row starts at y = ${lib && Math.round(lib.top)}`);
    /* Sideways the header is taller than the screen can spare: the agreed answer (work order, Part 1 Build 2) is that it scrolls away and the list is reachable, with the strip at hand. */
    if(W === 800 && H === 360){
      const r = await page.evaluate(async () => { const row = document.querySelector('#libList .row'); row.scrollIntoView({block: 'start'}); await new Promise(r => setTimeout(r, 150)); const b = row.getBoundingClientRect(), a = document.getElementById('azStrip'); return {top: b.top, bottom: b.bottom, H: innerHeight, strip: !!a && getComputedStyle(a).visibility !== 'hidden' && a.getBoundingClientRect().height > 100}; });
      rec.ok('Library: scrolled past the header, a song row shows and the A to Z strip is there (800x360)', r.top >= 0 && r.bottom <= r.H && r.strip, JSON.stringify(r));
    }
    const rm = await page.evaluate(() => [...document.querySelectorAll('#libList .rowmore')].every(b => { const r = b.getBoundingClientRect(); return r.right <= innerWidth + 0.5 && r.left >= -0.5; }));
    rec.ok('Library: every row\'s ⋯ button is inside the screen', rm, 'a ⋯ button is off the screen');
    const bars = await page.evaluate(() => [...document.querySelectorAll('.top h1, .tabs button, #q, [data-add], [data-sharemenu], [data-backupmenu], .nudge button')].filter(e => e.getBoundingClientRect().width).every(e => { const r = e.getBoundingClientRect(); return r.right <= innerWidth + 0.5 && r.left >= -0.5; }));
    rec.ok('Library: the header, search, menu buttons and reminder buttons are inside the screen', bars, 'one of them is off the screen');
    const minLetter = {v: 99};
    info.strip = await stripChecks(page, rec, minLetter);
    info.minLetter = minLetter.v === 99 ? null : Math.round(minLetter.v * 10) / 10;
    await reminder(page, 'both');
    const both = await libTop(page); info.rowTopBoth = both && Math.round(both.top);
    await reminder(page, 'plain');

    /* the Setlists list */
    await toSets(page);
    const s2 = await sideways(page);
    rec.ok('Setlists list: no sideways scroll', s2.sw <= s2.w, `scrollWidth ${s2.sw} > window ${s2.w}`);
    const rows = await page.evaluate(() => [...document.querySelectorAll('[data-play], [data-setrowmenu]')].filter(b => b.getBoundingClientRect().width).every(b => { const r = b.getBoundingClientRect(); return r.right <= innerWidth + 0.5 && r.left >= -0.5; }));
    rec.ok('Setlists list: every Play and ⋯ button is inside the screen', rows, 'one is off the screen');
    await toast(page, rec);

    for(const def of SCREENS) await dialogScreen(page, rec, def);

    await toLib(page);
    await sleep(300);
    const d = diff(before, await snapshot(page), '', [], 8);
    rec.ok('nothing stored changed', !d.length, d.join('; '));
    rec.ok('no page errors', !session.errors.length, session.errors.join(' | '));
  }catch(err){
    rec.ok('the walk ran to the end', false, err.stack ? err.stack.split('\n').slice(0, 3).join(' / ') : String(err));
  }finally{ await session.close(); }
  out.push({W, H, rec, info});
  console.log(`  ${W}x${H}: ${rec.passed} of ${rec.checks.length}`);
  const f = rec.failures();
  assert(!f.length, `${W}x${H}: ${rec.passed} of ${rec.checks.length} checks passed. Failed:\n    ` + f.join('\n    '));
}

/* One loop per size, each printing its measurements. */
const sizeLoop = size => ({
  name: `phone 1 ${size[0]}x${size[1]}: every screen and dialog fits, buttons on screen, last item reachable, strip letters apart, wide toast`,
  async run(ctx){
    const out = [];
    try{ await runSize(ctx, size, out); }
    finally{
      for(const o of out) console.log(`    measured ${o.W}x${o.H}: first song row top ${o.info.rowTop} px (with both reminder buttons ${o.info.rowTopBoth}), a song row ${o.info.rowShows ? 'shows' : 'does not show'} without scrolling, strip ${o.info.strip} smallest letter ${o.info.minLetter === null ? 'none drawn' : o.info.minLetter + ' px'}`);
    }
  },
});
/* No user-agent sniffing anywhere in the app (Jonathan, 2026-11-23): what the browser calls itself says nothing about the screen. The files the
   test server serves are read from disk (ctx.root, the scratch copy in plant-faults) and comments are left out. tools/checks.mjs pins the same. */
const noSniffing = {
  name: 'phone 1 no sniffing: js/*.js and sw.js never read navigator.userAgent, userAgentData, platform or vendor',
  async run(ctx){
    const files = [...fs.readdirSync(path.join(ctx.root, 'js')).filter(f => f.endsWith('.js')).map(f => path.join('js', f)), 'sw.js'];
    assert(files.length > 20, 'found only ' + files.length + ' app files');
    const hits = [];
    for(const f of files){
      const src = fs.readFileSync(path.join(ctx.root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
      for(const m of src.matchAll(/\bnavigator\s*(?:\.\s*|\[\s*['"`])(?:userAgentData|userAgent|platform|vendor)\b|\buserAgentData\b/g)) hits.push(`${f}: ${m[0]}`);
    }
    assert(!hits.length, 'the app reads what the browser calls itself: ' + hits.join('; '));
  },
};
/* Safe areas (the notch and the home bar). Playwright draws env(safe-area-inset-*) as 0, so the loop asks Chromium's DevTools to pretend
   (Emulation.setSafeAreaInsetsOverride) and then checks that dialogs and the toast keep inside what is left. Chromium only. */
const INSETS = [
  {W: 390, H: 844, i: {top: 59, bottom: 34, left: 0, right: 0}, what: 'an iPhone upright'},
  {W: 844, H: 390, i: {top: 0, bottom: 21, left: 59, right: 59}, what: 'an iPhone sideways'},
  {W: 360, H: 640, i: {top: 60, bottom: 60, left: 40, right: 40}, what: 'generous insets on a small phone'},
];
const safeScreens = ['song menu', 'Edit song', 'Share songs', 'Collections manager', 'text import review'].map(n => SCREENS.find(x => x.name === n));
const safeArea = {
  name: 'phone 1 safe area: dialogs and the toast keep inside the notch and home-bar insets (Chromium DevTools override)',
  async run(ctx){
    if(WEBKIT) return;
    const rec = recorder();
    for(const {W, H, i, what} of INSETS){
      const session = await ctx.session({viewport: {width: W, height: H}, screen: {width: W, height: H}, hasTouch: true, isMobile: true, deviceScaleFactor: 2});
      try{
        const {page} = session;
        await session.goto();
        await page.evaluate(() => { try{ localStorage.setItem('ss-gig-fill', '1'); }catch(e){} });
        await restoreZip(page, await backupFile());
        await page.waitForSelector('#libList [data-open]');
        const cdp = await session.context.newCDPSession(page);
        await cdp.send('Emulation.setSafeAreaInsetsOverride', {insets: i});
        const seen = await page.evaluate(() => { const e = document.createElement('div'); e.style.cssText = 'position:fixed;padding-top:env(safe-area-inset-top);padding-left:env(safe-area-inset-left)'; document.body.append(e); const c = getComputedStyle(e); const r = [c.paddingTop, c.paddingLeft]; e.remove(); return r; });
        const tag = `${W}x${H} (${what})`;
        if(!rec.ok(`${tag}: the browser applies the insets`, seen[0] === i.top + 'px' && seen[1] === i.left + 'px', `env() reads ${seen.join(', ')}, wanted top ${i.top} left ${i.left}`)) continue;
        for(const def of safeScreens){
          try{
            await def.open(page); await sleep(200);
            const g = await dialogGeo(page);
            const ok = g && g.box.l >= i.left - 0.5 && g.box.r <= W - i.right + 0.5 && g.box.t >= i.top - 0.5 && g.box.b <= H - i.bottom + 0.5;
            rec.ok(`${tag}: ${def.name} inside the safe area`, ok, g ? `box ${fmt(g.box)}, safe area [${i.left},${i.top} to ${W - i.right},${H - i.bottom}]` : 'no dialog');
          }catch(err){ rec.ok(`${tag}: ${def.name} ran`, false, err.message.split('\n')[0]); }
          finally{ await closeAll(page); }
        }
        await toLib(page);
        const t = await toast(page, rec, false);
        rec.ok(`${tag}: the toast inside the safe area`, t.l >= i.left - 0.5 && t.r <= W - i.right + 0.5, `toast ${t.l.toFixed(0)} to ${t.r.toFixed(0)}, safe ${i.left} to ${W - i.right}`);
      } finally{ await session.close(); }
    }
    console.log(`  safe area: ${rec.passed} of ${rec.checks.length}`);
    const f = rec.failures();
    assert(!f.length, `safe area: ${rec.passed} of ${rec.checks.length} checks passed. Failed:\n    ` + f.join('\n    '));
  },
};

/* ---------- a third device: a phone on the same Drive as two tablets ---------- */
const PHONE_DEVICE = {viewport: {width: 412, height: 915}, screen: {width: 412, height: 915}, hasTouch: true, isMobile: true, deviceScaleFactor: 2};
const inkPixels = (page, pn, rect) => page.evaluate(([pn, rect]) => {          // alpha > 20 pixels of a page's ink canvas inside a fraction rect [x0, y0, x1, y1] of the page
  const cv = document.querySelector(`#stage .ink[data-pn="${pn}"]`); if(!cv) return -1;
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, r = [rect[0] * cv.width, rect[1] * cv.height, rect[2] * cv.width, rect[3] * cv.height].map(Math.round);
  let n = 0;
  for(let y = Math.max(0, r[1]); y < Math.min(cv.height, r[3]); y++) for(let x = Math.max(0, r[0]); x < Math.min(cv.width, r[2]); x++) if(d[(y * cv.width + x) * 4 + 3] > 20) n++;
  return n;
}, [pn, rect]);
const thirdDevice = {
  name: 'phone 1 third device: a phone (412x915) and two tablets share one Drive; the phone\'s song and setlist edits reach both tablets, a pen mark from a tablet is drawn on the phone\'s page',
  async run(ctx){
    const file = await backupFile(), T = {};
    const open = async (name, device, share) => {
      const t = await openTablet(ctx, {name, device, ...(share ? {share} : {})});
      await t.page.evaluate(() => { try{ localStorage.setItem('ss-gig-fill', '1'); }catch(e){} });
      await restoreZip(t.page, file);
      return (T[name] = t);
    };
    const A = await open('A', {});
    try{
      const B = await open('B', {}, A), C = await open('C', PHONE_DEVICE, A);
      const all = [A, B, C], errs = () => all.flatMap(t => t.s.errors.filter(e => e.startsWith('pageerror') && !/ResizeObserver loop/.test(e))   /* browser noise: js/errors.js ignores it too */
        .filter(Boolean).map(e => `${t.name}: ${e}`));
      const same = async (what, ts = all) => {
        const libs = await Promise.all(ts.map(libraryOf)), out = [];
        for(let i = 1; i < libs.length; i++) out.push(...diff(libs[0], libs[i], '', [], 8).map(d => `${ts[0].name} vs ${ts[i].name}: ${d}`));
        assert(!out.length, `${what}: the tablets differ:\n    ` + out.join('\n    '));
      };
      const finished = (rep, t, what) => assert(rep.state === 'finished', `${t.name} ${what}: ${rep.title}: ${rep.text.slice(0, 300)}`);
      /* all three start from the same library; A sends it, B and C find it already there */
      finished(await syncTap(A), A, 'first sync');
      for(const t of [B, C]) finished(await syncTap(t), t, 'first sync');
      await same('after the first syncs');
      const before = await libraryOf(A);

      /* the phone edits a song through its real menu and a setlist through its real More menu, then syncs */
      const {page: p} = C;
      await toLib(p);
      await p.locator('#libList [data-songmenu="ph5"]').tap(); await p.locator('.modal.menubox [data-item="edit"]').tap();
      await p.locator('.modal [data-k=version]').waitFor();
      await p.locator('.modal [data-k=artist]').fill('Dietz and Schwartz'); await p.locator('.modal [data-k=version]').fill('in G from the phone');
      await p.locator('.modal [data-ok]').tap(); await p.waitForSelector('.modal', {state: 'detached'});
      await openSet(p, 'phs2');
      await menuItem(p, '[data-setmenu]', 'rename', '.modal input'); await p.locator('.modal input').fill('Rehearsal from the phone'); await p.locator('.modal [data-ok]').tap();
      await p.waitForSelector('.modal', {state: 'detached'});
      await p.locator('[data-addto]').tap(); await p.locator('.modal .pick').waitFor();
      await p.locator('.modal .pick label').first().tap(); await p.locator('.modal [data-ok]').tap(); await p.waitForSelector('.modal', {state: 'detached'});
      await sleep(300);
      const edited = await libraryOf(C), song = edited.songs.ph5, set = edited.sets.phs2;
      assert(song.version === 'in G from the phone' && song.artist === 'Dietz and Schwartz' && song.title === 'Alone Together (in G from the phone) - Dietz and Schwartz', `the phone's song edit was not saved: ${JSON.stringify(song)}`);
      assert(set.name === 'Rehearsal from the phone' && set.items.length === before.sets.phs2.items.length + 1, `the phone's setlist edit was not saved: ${JSON.stringify(set)}`);
      const rep = await syncTap(C); finished(rep, C, 'sync of the edits');
      const c = reportCounts(rep.text);
      assert(c.sent.song === 1 && c.sent.set === 1 && c.sent.coll === 0, `the phone should have sent 1 song and 1 setlist: ${rep.text.slice(0, 300)}`);
      for(const t of [A, B]){
        const r = await syncTap(t); finished(r, t, 'sync after the phone\'s edits');
        const g = reportCounts(r.text).got;
        assert(g.song === 1 && g.set === 1, `${t.name} should have got 1 song and 1 setlist: ${r.text.slice(0, 300)}`);
        const L = await libraryOf(t);
        assert(L.songs.ph5.title === song.title && L.sets.phs2.name === set.name && JSON.stringify(L.sets.phs2.items) === JSON.stringify(set.items), `${t.name} does not hold the phone's edits`);
      }
      await same('after the phone\'s edits');
      /* readDrive's pdfName() keeps the slash of "AC/DC" in a file name; the app writes "AC-DC" (fileName() turns slashes into "-"): not a Drive fault */
      const layout = d => d.problems.filter(x => !/Back in Black - AC-DC\.pdf/.test(x));
      const D = readDrive(A.google);
      assert(!layout(D).length, 'Drive layout: ' + layout(D).join('; '));
      assert(D.recs.song.get('ph5').title === song.title && D.recs.set.get('phs2').name === set.name, 'Drive does not hold the phone\'s edits');

      /* a pen mark drawn on tablet A reaches the phone and is drawn on its page */
      const at = await openOn(A, 'ph8', 1), stroke = await uiLine(A, at, 'pen', PEN.red, .5);
      await closeViewer(A);
      finished(await syncTap(A), A, 'sync of the mark');
      const r2 = await syncTap(C); finished(r2, C, 'sync that brings the mark');
      const got = await pageOf(C, 'ph8:1'), mine = await pageOf(A, 'ph8:1');
      assert(got && entriesOf(got).has(stroke.id) && JSON.stringify([...entriesOf(got).keys()].sort()) === JSON.stringify([...entriesOf(mine).keys()].sort()), `the mark did not reach the phone: ${JSON.stringify(got)}`);
      await p.reload(); await p.waitForSelector('#libList [data-open]');
      await p.locator('#libList [data-open="ph8"]').tap();
      await p.waitForSelector('#viewer.on #stage .ink[data-pn="1"]');
      await p.waitForFunction(() => { const c = document.querySelector('#stage .ink[data-pn="1"]'); return c && c.width > 50; });
      let on = 0, off = 0;
      for(let i = 0; i < 20 && on < 20; i++){ await sleep(250); on = await inkPixels(p, 1, [.15, .47, .85, .53]); off = await inkPixels(p, 1, [.15, .05, .85, .2]); }
      assert(on > 20 && off === 0, `the phone's page does not draw A's line where it was drawn (${on} marked pixels on the line, ${off} elsewhere)`);
      const sw = await sideways(p); assert(sw.sw <= sw.w, `the viewer on the phone scrolls sideways (${sw.sw} > ${sw.w})`);
      await p.keyboard.press('Escape'); await p.waitForSelector('#libList [data-open]');
      finished(await syncTap(B), B, 'last sync');
      await same('at the end');
      const D2 = readDrive(A.google);
      assert(!layout(D2).length && D2.ink.has('ph8:1'), 'Drive layout at the end: ' + layout(D2).join('; '));
      for(const t of all) assert(!t.watch.violations.length, `${t.name} (order on Drive): ${t.watch.violations.join('; ')}`);
      assert(!errs().length, 'page errors: ' + errs().join(' | '));
      console.log('  phone 1 third device: edits of a 412x915 phone reach A and B (1 song, 1 setlist each); A\'s mark is drawn on the phone (' + on + ' pixels)');
    } finally{ for(const t of Object.values(T)) await t.close().catch(() => {}); }
  },
};
export const loops = [...SIZES.map(sizeLoop), noSniffing, safeArea, thirdDevice];

/*
 * Library strip: the song count and the A to Z strip on the Library (js/azstrip.js, js/names.js songLetter / firstAtOrAfter).
 * The songs are put into a library through a backup built here in Node, with names whose order and letters are WRITTEN BY HAND
 * below (a leading apostrophe, a number, an accent that is the only song of its letter, a lower case "the", two songs of one name, one in another alphabet, no Q and
 * no X); the strip, the jumps and the count are read from the SCREEN. Nothing is computed with the code under test.
 *   1  820 x 1180 with touch: 27 letters named as written, one Tab stop that the arrow keys, Home and End move; Q and X dimmed
 *   2  every letter, tapped, brings the hand-written first song of that letter (for Q and X the next letter's) to the top, or into view
 *      at the foot of the page; "#" goes to the top; Enter and Space on a letter also move the focus to that song
 *   3  sliding along the strip (a touch drag by the DevTools protocol under Chromium, the mouse under both) ends on the letter reached
 *      and the page never scrolls sideways
 *   4  the count: "40 songs"; a search "6 of 40 songs" and no strip; cleared, the strip is back; a collection of 12 "12 of 40 songs"
 *      and no strip (under 30); archived songs never counted, shown or not
 *   5  (library strip 2) 29 songs: no strip; 30 songs: the strip; none: no count; one: "1 song"
 *   6  at 820 x 1180, 1180 x 820 and 390 x 844 every letter is on the screen, at least 28 px high on the tall tablet, clear of every
 *      row's menu button and title and of the hints under the list, and still there after scrolling to the foot of the page
 *   7  none of it changes anything stored
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {FIX, TMP, assert, sleep, sha256, snapshot, diff, restoreZip, JSZip, ENGINE} from './harness.mjs';

/* [song, artist], in the order they must appear in the Library: by hand. */
const LIVE = [
  ["'Round Midnight", 'Monk'], ['2 Fast', 'Dev'], ['10 Years Gone', 'Led'],
  ['A Day in the Life', 'Beatles'], ['Água de Beber', 'Jobim'], ["Ain't No Sunshine", 'Withers'], ['Alone Together', 'Dietz'],
  ['Back in Black', 'AC/DC'], ['Blackbird', 'Beatles'], ['Come Together', 'Beatles'], ['Dock of the Bay', 'Redding'], ["Don't Stop", 'Mac'],
  ['ébano', 'Silva'], ['Fly Me to the Moon', 'Howard'], ['Fool on the Hill', 'Beatles'], ['Georgia on My Mind', 'Carmichael'], ['Hotel California', 'Eagles'],
  ['I Shot the Sheriff', 'Marley'], ['Jolene', 'Parton'], ['Kansas City', 'Leiber'], ['Layla', 'Clapton'], ['Let It Be', 'Beatles'],
  ['Misty', 'Garner'], ['Moondance', 'Morrison'], ['Nights in White Satin', 'Moody Blues'], ['Over the Rainbow', 'Arlen'], ['Purple Haze', 'Hendrix'],
  ['Respect', 'Redding'], ['Stand by Me', 'King'], ['Sultans of Swing', 'Dire Straits'], ['Take Five', 'Brubeck'], ['the Weight', 'The Band'],
  ['Under the Bridge', 'Chili Peppers'], ['Valerie', 'Winehouse'], ['What a Wonderful World', 'Armstrong'], ['Wonderwall', 'Oasis'],
  ['Yesterday', 'Beatles'], ['Zombie', 'Cranberries'], ['Zombie', 'Dev'], ['Жук', 'Кино'],
];
const ARCHIVED = [['Old Chart', 'Q'], ['Another Old One', 'R'], ['Zzz Old', 'S']];
const titleOf = ([song, artist]) => `${song} - ${artist}`;
/* by hand: the first song of each letter that has songs (Q and X have none: they go to the next letter's first song) */
const FIRST = {'#': "'Round Midnight", A: 'A Day in the Life', B: 'Back in Black', C: 'Come Together', D: 'Dock of the Bay', E: 'ébano', F: 'Fly Me to the Moon',
  G: 'Georgia on My Mind', H: 'Hotel California', I: 'I Shot the Sheriff', J: 'Jolene', K: 'Kansas City', L: 'Layla', M: 'Misty', N: 'Nights in White Satin',
  O: 'Over the Rainbow', P: 'Purple Haze', Q: 'Respect', R: 'Respect', S: 'Stand by Me', T: 'Take Five', U: 'Under the Bridge', V: 'Valerie',
  W: 'What a Wonderful World', X: 'Yesterday', Y: 'Yesterday', Z: 'Zombie'};
const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const NONE = ['Q', 'X'];
const nameOf = L => L === '#' ? 'Jump to songs that start with a number or a sign' : `Jump to ${L}`;
const firstTitle = L => titleOf(LIVE.find(x => x[0] === FIRST[L]));

/* A backup (version 3) of the given songs; withBand puts the first 12 live songs in one collection. */
async function backupFile(live, archived, tag, withBand){
  const zip = new JSZip(), base = fs.readFileSync(path.join(FIX, 'one-page.pdf')), songs = [];
  [...live.map(x => [...x, false]), ...archived.map(x => [...x, true])].forEach(([song, artist, arch], i) => {
    const id = `az${i}x${tag}`, bytes = Buffer.concat([base, Buffer.from(`\n% az ${tag} ${i}\n`)]);
    zip.file(`files/${id}.pdf`, bytes);
    songs.push({id, title: `${song} - ${artist}`, song, artist, version: '', archived: arch, colls: withBand && !arch && i < 12 ? ['azband'] : [], pages: 1, hash: sha256(bytes), added: 1700000000000 + i, updated: 1700000000000 + i});
  });
  const colls = withBand ? [{id: 'azband', name: 'Band One', created: 1700000000000, updated: 1700000000000}] : [];
  zip.file('library.json', JSON.stringify({app: 'setlist-stand', version: 3, saved: new Date().toISOString(), songs, sets: [], colls, ink: {}}));
  const f = path.join(TMP, `az-backup-${tag}.zip`);
  await fsp.writeFile(f, await zip.generateAsync({type: 'nodebuffer'}));
  return f;
}
const count = page => page.locator('#libCount').innerText();
const stripLetters = page => page.$$eval('#azStrip [data-az]', bs => bs.map(b => b.dataset.az));
const hasStrip = page => page.locator('#azStrip').count().then(n => n > 0);
const titles = page => page.$$eval('#libList ul.list:first-of-type .t', ts => ts.map(e => e.textContent.trim()));
/* where the row of a song stands: its top in the viewport, and whether the page can scroll no further */
const rowOf = (page, title) => page.evaluate(title => {
  const row = [...document.querySelectorAll('#libList ul.list')[0].querySelectorAll('.row')].find(r => r.querySelector('.t').textContent.trim() === title);
  if(!row) return null;
  const r = row.getBoundingClientRect(), d = document.documentElement;
  return {top: r.top, bottom: r.bottom, h: window.innerHeight, atEnd: window.scrollY + window.innerHeight >= d.scrollHeight - 2};
}, title);
const inPlace = (r, what) => {
  assert(r, `${what}: no such row`);
  assert(r.top >= -1 && r.bottom <= r.h + 1, `${what}: the row is not on the screen (top ${Math.round(r.top)}, bottom ${Math.round(r.bottom)}, screen ${r.h})`);
  assert(r.atEnd || r.top <= 14, `${what}: the row is at ${Math.round(r.top)} px, not at the top of the screen`);
};
const scrollTop = page => page.evaluate(() => window.scrollTo(0, 0));
const center = async loc => { const b = await loc.boundingBox(); return {x: b.x + b.width / 2, y: b.y + b.height / 2}; };

async function sessionWith(ctx, file, viewport){
  const s = await ctx.session({viewport, hasTouch: true});
  await s.goto();
  await restoreZip(s.page, file);
  await s.page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length > 0, null, {timeout: 10000});
  return s;
}

async function loopStrip(ctx){
  assert(LIVE.length === 40, 'the test list is not 40 songs');
  const f = await backupFile(LIVE, ARCHIVED, 'a', true);
  const s = await sessionWith(ctx, f, {width: 820, height: 1180});
  try{
    const {page} = s;
    const before = await snapshot(page);
    assert(JSON.stringify(await titles(page)) === JSON.stringify(LIVE.map(titleOf)), 'the Library is not in the hand-written order:\n    ' + (await titles(page)).join(' | '));

    /* 1 the strip, its names, one Tab stop, the arrow keys */
    assert(await hasStrip(page), 'no A to Z strip with 40 songs');
    assert((await page.locator('#azStrip').getAttribute('aria-label')) === 'Jump to a letter', 'the strip has no name');
    assert(JSON.stringify(await stripLetters(page)) === JSON.stringify(LETTERS), 'the strip letters are ' + (await stripLetters(page)).join(''));
    for(const L of LETTERS){
      const got = await page.locator(`#azStrip [data-az="${L}"]`).getAttribute('aria-label');
      assert(got === nameOf(L), `letter ${L} is named "${got}", expected "${nameOf(L)}"`);
      assert((await page.locator(`#azStrip [data-az="${L}"]`).innerText()) === L, `letter ${L} shows the wrong text`);
    }
    const dimmed = await page.$$eval('#azStrip [data-az].none', bs => bs.map(b => b.dataset.az));
    assert(JSON.stringify(dimmed) === JSON.stringify(NONE), 'dimmed letters: ' + dimmed.join(''));
    assert((await page.locator('#azStrip [tabindex="0"]').count()) === 1, 'the strip is not one Tab stop');
    assert((await page.locator('#azStrip button:not([tabindex="-1"])').count()) === 1, 'more than one letter can be reached with Tab');
    const active = () => page.evaluate(() => document.activeElement.dataset.az);
    await page.locator('#azStrip [data-az="#"]').focus();
    await page.keyboard.press('ArrowDown');
    assert((await active()) === 'A', 'ArrowDown did not move to A');
    await page.keyboard.press('End');
    assert((await active()) === 'Z', 'End did not move to Z');
    await page.keyboard.press('ArrowUp');
    assert((await active()) === 'Y', 'ArrowUp did not move to Y');
    await page.keyboard.press('Home');
    assert((await active()) === '#', 'Home did not move to #');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    assert((await page.locator('#azStrip [tabindex="0"]').getAttribute('data-az')) === 'B', 'the Tab stop did not follow the focus');

    /* 2 every letter, tapped */
    await page.evaluate(() => document.activeElement.blur());
    for(const L of LETTERS){
      await page.locator(`#azStrip [data-az="${L}"]`).tap();
      await sleep(60);
      inPlace(await rowOf(page, firstTitle(L)), `letter ${L} (${FIRST[L]})`);
    }
    await page.locator('#azStrip [data-az="M"]').tap();
    await page.locator('#azStrip [data-az="#"]').tap();
    await sleep(80);
    inPlace(await rowOf(page, titleOf(LIVE[0])), '"#" after M');
    /* a key press: jumps and moves the focus to that song */
    await page.locator('#azStrip [data-az="T"]').focus();
    await page.keyboard.press('Enter');
    await sleep(100);
    const focusedTitle = () => page.evaluate(() => { const e = document.activeElement; return e && e.closest && e.closest('#libList') && e.querySelector('.t') ? e.querySelector('.t').textContent.trim() : null; });
    assert((await focusedTitle()) === 'Take Five - Brubeck', 'Enter on T left the focus on ' + await focusedTitle());
    inPlace(await rowOf(page, 'Take Five - Brubeck'), 'Enter on T');
    await page.locator('#azStrip [data-az="E"]').focus();
    await page.keyboard.press('Space');
    await sleep(100);
    assert((await focusedTitle()) === 'ébano - Silva', 'Space on E left the focus on ' + await focusedTitle());

    /* 3 sliding: from A to M, ending with M's first song at the top (from the top of the page: the letters must not move under the finger) */
    const slide = async how => {
      await scrollTop(page); await sleep(300);
      const A = await center(page.locator('#azStrip [data-az="A"]')), M = await center(page.locator('#azStrip [data-az="M"]'));
      if(how === 'touch'){
        const cdp = await page.context().newCDPSession(page);
        const pt = (x, y) => [{x, y, id: 1}];
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: pt(A.x, A.y)});
        for(let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: pt(A.x, A.y + (M.y - A.y) * i / 10)});
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
        await cdp.detach();
      }else{
        await page.mouse.move(A.x, A.y); await page.mouse.down();
        for(let i = 1; i <= 10; i++) await page.mouse.move(A.x, A.y + (M.y - A.y) * i / 10);
        await page.mouse.up();
      }
      await sleep(250);
      inPlace(await rowOf(page, 'Misty - Garner'), `a ${how} slide from A to M`);
      const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      assert(w[0] <= w[1], `the page scrolls sideways after the ${how} slide (${w[0]} > ${w[1]})`);
    };
    if(ENGINE !== 'webkit') await slide('touch');
    await slide('mouse');

    /* 4 the count */
    await scrollTop(page); await sleep(100);
    assert((await count(page)) === '40 songs', 'the count reads "' + await count(page) + '"');
    await page.check('#showArch');
    assert((await count(page)) === '40 songs', 'archived songs were counted: "' + await count(page) + '"');
    await page.uncheck('#showArch');
    await page.fill('#q', 'beatles');
    assert((await count(page)) === '6 of 40 songs', 'a search for "beatles" reads "' + await count(page) + '", expected "6 of 40 songs"');
    assert(!(await hasStrip(page)), 'the strip is shown while searching');
    await page.fill('#q', 'e');       // most of the library: more than 30 songs, and still no strip
    const many = await page.locator('#libList ul.list .row').count();
    assert(many >= 30 && (await count(page)) === `${many} of 40 songs`, `a search for "e" reads "${await count(page)}" over ${many} rows`);
    assert(!(await hasStrip(page)), 'the strip is shown while searching (a long result)');
    await page.fill('#q', 'nothing like this');
    assert((await count(page)) === '0 of 40 songs', 'no match reads "' + await count(page) + '"');
    await page.fill('#q', 'jolene');
    assert((await count(page)) === '1 of 40 songs', 'one match reads "' + await count(page) + '"');
    await page.fill('#q', '');
    assert((await count(page)) === '40 songs' && await hasStrip(page), 'the search was cleared and the count or the strip did not come back');
    assert((await page.locator('#libCount').getAttribute('aria-live')) === 'polite', 'the count is not a polite live region');
    await page.click('.collbar [data-collpick="azband"]');
    await page.waitForFunction(() => document.querySelectorAll('#libList ul.list .row').length === 12);
    assert((await count(page)) === '12 of 40 songs', 'a collection of 12 reads "' + await count(page) + '"');
    assert(!(await hasStrip(page)), 'the strip is shown for a list of 12');
    assert((await page.evaluate(() => getComputedStyle(document.querySelector('#libWrap')).display)) !== 'grid', 'the list is still in a two-column grid with no strip');
    await page.click('.collbar [data-collpick="all"]');
    await page.waitForFunction(() => document.querySelectorAll('#libList ul.list .row').length === 40);
    assert((await count(page)) === '40 songs' && await hasStrip(page), 'All again: the count or the strip is missing');

    /* 6 geometry, at three sizes, at the top and at the foot of the page */
    for(const [w, h, tall] of [[820, 1180, true], [1180, 820, false], [390, 844, false]]){
      await page.setViewportSize({width: w, height: h}); await sleep(300);
      for(const where of ['top', 'foot']){
        await page.evaluate(wh => window.scrollTo(0, wh === 'foot' ? document.documentElement.scrollHeight : 0), where);
        await sleep(300);
        const g = await page.evaluate(() => {
          const s = document.querySelector('#azStrip').getBoundingClientRect();
          const out = {w: innerWidth, h: innerHeight, sw: document.documentElement.scrollWidth, hit: [],
            letters: [...document.querySelectorAll('#azStrip [data-az]')].map(b => { const r = b.getBoundingClientRect(); return [b.dataset.az, r.top, r.bottom]; })};
          for(const el of document.querySelectorAll('#libList .rowmore, #libList .t, #libWrap ~ .hint, #libWrap ~ .sw-row, #libWrap ~ #libSafety *')){
            const r = el.getBoundingClientRect();
            if(r.bottom > 0 && r.top < innerHeight && r.right > s.left && r.left < s.right) out.hit.push(el.className + ':' + el.textContent.trim().slice(0, 20));
          }
          return out;
        });
        const at = `${w} x ${h} at the ${where}`;
        assert(g.letters.length === 27, `${at}: ${g.letters.length} letters`);
        for(const [L, top, bottom] of g.letters) assert(top >= -1 && bottom <= g.h + 1, `${at}: letter ${L} is off the screen (${Math.round(top)} to ${Math.round(bottom)} of ${g.h})`);
        const hmin = Math.min(...g.letters.map(l => l[2] - l[1]));
        if(tall) assert(hmin >= 28, `${at}: the smallest letter is ${hmin.toFixed(1)} px high`);
        assert(hmin >= 15, `${at}: letters are only ${hmin.toFixed(1)} px high`);
        assert(!g.hit.length, `${at}: the strip covers ${g.hit.join(', ')}`);
        assert(g.sw <= g.w, `${at}: the page is wider than the screen (${g.sw} > ${g.w})`);
      }
    }

    /* 7 nothing stored changed */
    await sleep(300);
    const d = diff(before, await snapshot(page), '', [], 20);
    assert(!d.length, 'the strip or the count changed something stored: ' + d.join('; '));
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

async function loopThreshold(ctx){
  const mk = n => Array.from({length: n}, (_, i) => [`Song ${String.fromCharCode(65 + i % 26)}${i}`, 'Z']);
  for(const [n, strip] of [[29, false], [30, true]]){
    const s = await sessionWith(ctx, await backupFile(mk(n), [], 't' + n, false), {width: 820, height: 1180});
    try{
      const {page} = s;
      assert((await titles(page)).length === n, `${n} songs: ${(await titles(page)).length} rows`);
      assert((await hasStrip(page)) === strip, `${n} songs: the strip is ${strip ? 'missing' : 'shown'}`);
      assert((await count(page)) === `${n} songs`, `${n} songs: the count reads "${await count(page)}"`);
      assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
  }
  /* no live song (only an archived one): no count line; one song: "1 song" */
  for(const [n, want] of [[0, ''], [1, '1 song']]){
    const s = await ctx.session({viewport: {width: 820, height: 1180}});
    try{
      await s.goto(); await restoreZip(s.page, await backupFile(mk(n), n ? [] : ARCHIVED, 'e' + n, false));
      assert((await count(s.page)) === want, `${n} songs: the count reads "${await count(s.page)}", expected "${want}"`);
      assert(!(await hasStrip(s.page)), `${n} songs: a strip`);
    } finally { await s.close(); }
  }
}

export const loops = [
  {name: 'library strip: the A to Z strip names, taps, slides, keys and geometry; the song count; nothing stored changes', run: loopStrip},
  {name: 'library strip 2: the strip appears at 30 songs and not at 29; the count for none and for one', run: loopThreshold},
];

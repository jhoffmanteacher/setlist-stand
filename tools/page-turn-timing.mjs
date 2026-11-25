/*
 * Page-turn timing ("faster page turns" work order, Part 3). Measures how long a page turn takes in the viewer,
 * and how many pixels of rendered pages the viewer keeps in memory, so a change can be compared with "before".
 *
 *   caffeinate -i node tools/page-turn-timing.mjs --label before [--root <dir>] [--turns 20]
 *   caffeinate -i node tools/page-turn-timing.mjs --photo --label before --turns 8      (photo charts against text charts)
 *   caffeinate -i node tools/page-turn-timing.mjs --library --label before --turns 8    (two songs from the private backup)
 *   caffeinate -i node tools/page-turn-timing.mjs --setlist --label a [--songs 8] [--pages 2] [--pace 800] [--lead 3000] [--ready on|off]
 *       (a person playing a setlist of short photo charts and turning every --pace ms, never waiting for the prefetch;
 *        every turn is 'inside' a song or 'across' into the next; --ready off sets localStorage['ss-ready']='0' before the app loads)
 *
 * Setup: Chromium 1280x800, deviceScaleFactor 2, CPU throttled 4x (CDP Emulation.setCPUThrottlingRate), one page,
 * service worker blocked (it takes no part in a page turn). Four text-only PDFs of 24 pages are generated with the
 * vendored pdf-lib into a temp folder (never in the repo), added with the #file input, and a setlist
 * "Timing set" = song A, song B, a break, song C is built through the Setlists screen. "Two pages" is turned off so
 * one tap is one page. The throttle is switched on after the library is built and before the first turn.
 *
 * A turn = a real mouse click on the stage (right 30% = next, left 30% = previous; Playwright's mouse down/up give real
 * pointer events). The clock starts at the tap's pointerup (a capture listener on #stage) and stops when
 *   (a) the new page is on screen: the sub title (#vSub) shows the expected "Song k of 3 / Page n of 24", and
 *       #stage holds a page canvas that is not the one that was showing (a break turn: .breakpage with the expected name);
 *   (b) the canvas is painted: a copy scaled down to 160x100 has a pixel that is not white (checked right after the
 *       stop time was taken; if it is blank the clock keeps running until it is not).
 * The stop time is taken in a MutationObserver callback on #stage / #vSub, so it is not rounded to a frame; compositing
 * the frame (up to about 16 ms more) is not counted. The same in "before" and "after".
 *
 * Between turns the script waits like a person pausing: every promise in V.cache has settled (the prefetch), then a
 * fixed SETTLE_MS, then again every promise settled. The same for every turn type.
 *
 * Turn types (TURNS each):
 *   1  forward inside a song        a 24-page song walked page 1 -> 21 with the prefetch done between turns
 *   2  back inside a song, cold     the viewer is opened fresh on page p, then back to p-1 (never rendered in this view)
 *   2b back, page just left         p -> p+1 -> p+2, then back to p+1 (the page that was just left; a cache hit today)
 *   3  into the next song           last page of A -> page 1 of B (the viewer is opened fresh on A's last page each time)
 *   4  back into the previous song  page 1 of B -> last page of A
 *   5  through a break              last page of B -> break page -> page 1 of C; the figure is the two taps added up
 *                                   (5a = song -> break, 5b = break -> song), the pause between them is not counted
 * Opening the viewer fresh is not timed; it is the way to get the same starting state again and again.
 *
 * Cache pixels: after each turn (right after it, and again after the settle) the viewer's V.cache is read with
 * cacheStats() below. Peak = the largest sum of cv.width * cv.height over the cached canvases, and the largest number
 * of entries. To point it at a changed cache (a different structure), edit ONLY cacheStats(): it runs in the page and
 * must return {pixels, entries}. It may import('./js/viewer.js') and read whatever the new cache is (for example a
 * Map of canvases instead of promises: drop the await); keep the rest as it is.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startServer, ROOT, PDFDocument, sleep, assert, privatePath, restoreZip} from './loops/harness.mjs';
import {makePhotoPdfs, cropSongs} from './loops/photo-pdf.mjs';
import {launchBrowser} from './loops/browser.mjs';
import {acquireSlot, releaseSlot} from './loops/slot.mjs';

const SCRATCH = process.env.SS_TIMING_OUT || os.tmpdir();      // where the JSON and the temporary PDFs go (nothing is written in the repo)
const PAGES = 24, SETTLE_MS = 1200, TIMEOUT = 15000;

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const root = path.resolve(opt('root', ROOT)), label = opt('label', 'run'), TURNS = +opt('turns', 20);
const OUT = path.join(SCRATCH, `timing-${label}.json`);
const PHOTO = args.includes('--photo'), LIBRARY = args.includes('--library');
const SETLIST = args.includes('--setlist');
const SONGS = +opt('songs', 8), SPAGES = +opt('pages', 2), PACE = +opt('pace', 800), LEAD = +opt('lead', 3000), READY = opt('ready', 'on');
const DWELL = opt('dwell', '') ? opt('dwell', '').split(',') : [];     // --dwell prep,0,500,1000: turns made before the prefetch is waited for

/* ---------- the one function that reads the cache (runs in the page) ---------- */
const cacheStats = async () => {
  const {V} = await import('./js/viewer.js');
  let pixels = 0;
  const all = await Promise.allSettled([...V.cache.values()]);
  for(const r of all) if(r.status === 'fulfilled' && r.value && r.value.cv) pixels += r.value.cv.width * r.value.cv.height;
  return {pixels, entries: V.cache.size};
};

/* ---------- PDFs ---------- */
async function makePdfs(dir, names = ['A', 'B', 'C'], PAGES = 24, prefix = 'Timing Song'){
  fs.mkdirSync(dir, {recursive: true});
  const files = [];
  for(const n of names){
    const doc = await PDFDocument.create();
    const font = await doc.embedFont('Helvetica'), bold = await doc.embedFont('Helvetica-Bold');
    for(let p = 1; p <= PAGES; p++){
      const pg = doc.addPage([612, 792]);
      pg.drawText(`Timing song ${n}, page ${p}`, {x: 60, y: 700, size: 36, font: bold});
      for(let l = 0; l < 14; l++) pg.drawText(`Line ${l + 1}: the quick brown fox plays chart ${n} bar ${p * 8 + l}`, {x: 60, y: 640 - l * 36, size: 20, font});
      pg.drawRectangle({x: 60, y: 60, width: 492, height: 40, borderWidth: 3});
    }
    const f = path.join(dir, `${prefix} ${n}.pdf`);
    fs.writeFileSync(f, await doc.save()); files.push(f);
  }
  return files;
}

/* ---------- in-page helpers, installed once ---------- */
const INSTALL = () => {
  const stage = document.querySelector('#stage'), sub = document.querySelector('#vSub');
  const painted = cv => {
    const s = document.createElement('canvas'); s.width = 160; s.height = 100;
    const c = s.getContext('2d', {willReadFrequently: true});
    c.fillStyle = '#fff'; c.fillRect(0, 0, 160, 100);
    c.drawImage(cv, 0, 0, 160, 100);
    const d = c.getImageData(0, 0, 160, 100).data;
    for(let i = 0; i < d.length; i += 4) if(d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) return true;
    return false;
  };
  /* arm(expect): resolves {ms} from the next pointerup on the stage until the expected page is shown and painted.
     expect = {sub: RegExp source} for a song page, {brk: 'name'} for a break page. */
  window.__arm = expect => new Promise((resolve, reject) => {
    const re = expect.sub ? new RegExp(expect.sub) : null;
    let t0 = null, old = null, obs = null, timer = null, done = false;
    const finish = (fn, v) => { if(done) return; done = true; obs && obs.disconnect(); clearTimeout(timer); stage.removeEventListener('pointerup', up, true); fn(v); };
    const check = () => {
      if(t0 === null) return;
      const now = performance.now();
      if(expect.brk){
        const el = stage.querySelector('.breakpage');
        if(el && el.querySelector('h1').textContent === expect.brk) finish(resolve, {ms: now - t0, frame: 'break', painted: true});
        return;
      }
      const cv = stage.querySelector('.sheet canvas:not(.ink)');
      if(!cv || cv === old || !re.test(sub.textContent)) return;
      if(painted(cv)) finish(resolve, {ms: now - t0, painted: true});     // a blank canvas keeps the clock running
    };
    const up = (e) => {
      t0 = e.timeStamp; old = stage.querySelector('.sheet canvas:not(.ink)');
      obs = new MutationObserver(check); obs.observe(stage, {childList: true, subtree: true}); obs.observe(sub, {childList: true, characterData: true, subtree: true});
      check();
    };
    /* the timeout starts when the turn is armed, not at the tap: a tap that never comes must not hang the run */
    timer = setTimeout(() => finish(reject, new Error('timeout: expected ' + JSON.stringify(expect) + ', sub "' + sub.textContent + '"')), 30000);
    stage.addEventListener('pointerup', up, true);
  });
  /* the same wait for the page to be there after an untimed open */
  window.__waitShown = (srcRe) => new Promise((resolve, reject) => {
    const re = new RegExp(srcRe), t = setTimeout(() => { reject(new Error('open timeout ' + srcRe)); }, 15000);
    const poll = () => {
      const cv = stage.querySelector('.sheet canvas:not(.ink)');
      if(cv && re.test(sub.textContent) && painted(cv)){ clearTimeout(t); resolve(true); } else setTimeout(poll, 20);
    };
    poll();
  });
  /* A fresh open: the viewer is CLOSED first (Back), so nothing from the last turn is left open or drawn (openViewer alone
     keeps the song that was on screen open for a turn back, which would let a later turn "go back" to a song that is
     already there instead of one that was prepared). */
  window.__open = async (qi, page) => { const m = await import('./js/viewer.js'); m.closeViewer(); await m.openViewer(m.V.queue, qi, page); };
  /* everything the viewer is drawing or opening ahead has finished: the cache AND the prepared songs */
  /* a prepared song's pages join the cache only after its PDF has opened, so wait again until nothing new appeared */
  window.__settled = async () => {
    const m = await import('./js/viewer.js');
    const all = () => [...m.V.cache.values(), ...[...(m.V.prep || new Map()).values()].map(e => e.p)];
    for(let i = 0; i < 6; i++){ const ps = all(); await Promise.allSettled(ps); await new Promise(r => setTimeout(r, 0)); const now = all(); if(now.length === ps.length && now.every(p => ps.includes(p))) return; }
  };
};

/* ---------- photo mode (--photo, --library): turn types 3 and 4 only, photo songs against text songs ----------
 * --photo: two photo songs (each page one ~3000x2400 JPEG, js tools/loops/photo-pdf.mjs) and two text songs, 2 pages
 * each, every song with a crop, generated at run time in the temp folder. --library: also the two songs Jonathan
 * named, from his private converted backup (read in place from "Claude outputs/", never copied; skipped when absent).
 * Each pair is played as a set of two songs (queue built from the song ids, as a setlist gives it), in the one-page
 * and the two-page layout. 3 = last spread of the first song -> first spread of the second; 4 = back again. Same
 * clock, same settle as above; "drawn ahead" counts the turns that landed on a canvas the cache held before the tap.
 */
async function compare(page, context, work, errors){
  /* a restore replaces every song, so the generated songs and the library are two runs */
  if(PHOTO && LIBRARY) throw new Error('run --photo and --library as two runs (a restore replaces the generated songs)');
  const groups = [];          // {kind, a, b} by title
  if(PHOTO){
    const ph = await makePhotoPdfs(page, work, [{file: 'Photo Song A', label: 'Photo A'}, {file: 'Photo Song B', label: 'Photo B'}]);
    const tx = await makePdfs(work, ['A', 'B'], 2, 'Text Song');
    await page.setInputFiles('#file', [...ph, ...tx]);
    await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 4, null, {timeout: 60000});
    const titles = await page.evaluate(async () => (await import('./js/store.js')).state.songs.map(s => s.title));
    const t = re => { const x = titles.find(v => re.test(v)); assert(x, 'no title ' + re + ' in ' + JSON.stringify(titles)); return x; };
    const [pa, pb, ta, tb] = [/Photo Song A/, /Photo Song B/, /Text Song A/, /Text Song B/].map(t);
    await cropSongs(page, [pa, pb, ta, tb]);
    groups.push({kind: 'photo', a: pa, b: pb}, {kind: 'text', a: ta, b: tb});
  }
  if(LIBRARY){
    const zip = privatePath('setlist-stand-from-mobilesheets.zip');
    if(!zip) console.log('SKIP library: the converted backup is not in Claude outputs/');
    else {
      await restoreZip(page, zip, 600000);
      const titles = await page.evaluate(async () => (await import('./js/store.js')).state.songs.map(s => s.title));
      const a = titles.find(v => /^Searching for a Home/i.test(v)), b = titles.find(v => /^In Between \(lyrics\)/i.test(v));
      if(!a || !b) console.log('SKIP library: songs not found');
      else groups.push({kind: 'library', a, b});
    }
  }

  await page.evaluate(INSTALL);
  await page.evaluate(() => {
    window.__open2 = async (ids, two, qi, pg) => { const m = await import('./js/viewer.js'); m.closeViewer(); m.V.two = two; await m.openViewer(ids.map(id => ({type: 'song', id})), qi, pg); };
    window.__cached = async () => { const {V} = await import('./js/viewer.js'); const rs = await Promise.allSettled([...V.cache.values()]); window.__beforeCvs = rs.filter(r => r.status === 'fulfilled').map(r => r.value.cv); };
    window.__wasCached = () => [...document.querySelectorAll('#stage .sheet canvas:not(.ink)')].every(c => window.__beforeCvs.includes(c));
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
  const rows = [], t0 = Date.now();
  for(const g of groups){
    const info = await page.evaluate(async ([a, b]) => { const st = (await import('./js/store.js')).state.songs; const f = t => st.find(s => s.title === t); return [f(a), f(b)].map(s => ({id: s.id, pages: s.pages})); }, [g.a, g.b]);
    for(const two of [false, true]){
      const [A, B] = info, per = n => two && n > 1 ? 2 : 1, last = n => per(n) === 2 ? (n % 2 ? n : n - 1) : n;
      const pr = (p, n) => per(n) === 2 && p < n ? `${p}–${p + 1}` : `${p}`;
      const sub = (k, p, n) => `^Song ${k} of 2 · Page ${pr(p, n)} of ${n}$`;
      const ids = [A.id, B.id];
      for(const type of [3, 4]){
        const ms = [], hits = []; let peak = 0;
        const sample = async () => { const s = await page.evaluate(cacheStats); if(s.pixels > peak) peak = s.pixels; };
        for(let i = 0; i < TURNS; i++){
          const [qi, pg, frac, expect] = type === 3 ? [0, 'last', 0.85, sub(2, 1, B.pages)] : [1, 1, 0.15, sub(1, last(A.pages), A.pages)];
          await page.evaluate(([ids, two, qi, pg]) => window.__open2(ids, two, qi, pg), [ids, two, qi, pg]);
          await page.evaluate(re => window.__waitShown(re), type === 3 ? sub(1, last(A.pages), A.pages) : sub(2, 1, B.pages));
          await page.evaluate(() => window.__settled()); await sleep(SETTLE_MS); await page.evaluate(() => window.__settled());
          await sample();
          await page.evaluate(() => window.__cached());
          const armed = page.evaluate(e => window.__arm(e), {sub: expect});
          await sleep(30);
          await page.mouse.move(1280 * frac, 400); await page.mouse.down(); await page.mouse.up();
          const r = await armed;
          ms.push(r.ms); hits.push(await page.evaluate(() => window.__wasCached()));
          await sample();
          await page.evaluate(() => window.__settled()); await sample();
        }
        const s = stat(ms);
        rows.push({kind: g.kind, layout: two ? 'two pages' : 'one page', type, n: s.n, median_ms: Math.round(s.median), worst_ms: Math.round(s.worst), drawn_ahead: hits.filter(Boolean).length, peak_pixels: peak, raw: ms});
        const r = rows[rows.length - 1];
        console.log(`  ${r.kind} ${r.layout} type ${type}: median ${r.median_ms} ms, worst ${r.worst_ms} ms, drawn ahead ${r.drawn_ahead}/${r.n}, peak ${(peak / 1e6).toFixed(2)} Mpx`);
      }
      /* A person does not wait for the prefetch: the turn into the next song after arriving on the last spread
         and staying there DWELL ms (one page: arrived by a turn from page 1; two pages: the song's only spread, opened).
         'prep' = arrival -> everything drawn ahead has finished (no tap). */
      for(const d of DWELL){
        const ms = [], hits = []; let peak = 0;
        for(let i = 0; i < TURNS; i++){
          if(two){ await page.evaluate(([ids]) => window.__open2(ids, true, 0, 1), [ids]); }
          else {
            await page.evaluate(([ids]) => window.__open2(ids, false, 0, 1), [ids]);
            await page.evaluate(re => window.__waitShown(re), sub(1, 1, A.pages));
            await page.evaluate(() => window.__settled()); await sleep(SETTLE_MS); await page.evaluate(() => window.__settled());
            const go = page.evaluate(e => window.__arm(e), {sub: sub(1, last(A.pages), A.pages)});
            await sleep(30); await page.mouse.move(1280 * 0.85, 400); await page.mouse.down(); await page.mouse.up();
            await go;
          }
          await page.evaluate(re => window.__waitShown(re), sub(1, last(A.pages), A.pages));
          if(d === 'prep'){ ms.push(await page.evaluate(async () => { const t = performance.now(); await window.__settled(); return performance.now() - t; })); continue; }
          await sleep(+d);
          await page.evaluate(() => window.__cached());
          const armed = page.evaluate(e => window.__arm(e), {sub: sub(2, 1, B.pages)});
          await sleep(30); await page.mouse.move(1280 * 0.85, 400); await page.mouse.down(); await page.mouse.up();
          const r = await armed; ms.push(r.ms); hits.push(await page.evaluate(() => window.__wasCached()));
          const c = await page.evaluate(cacheStats); if(c.pixels > peak) peak = c.pixels;
          await page.evaluate(() => window.__settled());
        }
        const s = stat(ms);
        rows.push({kind: g.kind, layout: two ? 'two pages' : 'one page', type: d === 'prep' ? 'prep' : '3 dwell ' + d, n: s.n, median_ms: Math.round(s.median), worst_ms: Math.round(s.worst), drawn_ahead: d === 'prep' ? '-' : hits.filter(Boolean).length, peak_pixels: peak, raw: ms});
        const r = rows[rows.length - 1];
        console.log(`  ${r.kind} ${r.layout} ${r.type}: median ${r.median_ms} ms, worst ${r.worst_ms} ms, drawn ahead ${r.drawn_ahead}/${r.n}`);
      }
    }
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);
  const lines = [`Page-turn timing (photo mode), label "${label}", root ${root}`,
    `Chromium 1280x800 @2x, CPU 4x, ${TURNS} turns per row, settle ${SETTLE_MS} ms (+ prefetch settled), ${seconds} s`,
    '', pad('songs', 9) + pad('layout', 11) + pad('turn', 28) + lpad('median ms', 10) + lpad('worst ms', 10) + lpad('ahead', 8) + lpad('peak Mpx', 10),
    ...rows.map(r => pad(r.kind, 9) + pad(r.layout, 11) + pad(r.type === 3 ? '3 into the next song' : r.type === 4 ? '4 back into previous' : r.type, 28) + lpad(r.median_ms, 10) + lpad(r.worst_ms, 10) + lpad(r.drawn_ahead + '/' + r.n, 8) + lpad((r.peak_pixels / 1e6).toFixed(2), 10)),
    '', errors.length ? 'PAGE ERRORS: ' + errors.join(' | ') : 'No page errors.'];
  console.log(lines.join('\n'));
  fs.writeFileSync(OUT, JSON.stringify({label, root, mode: PHOTO ? 'photo' : 'library', when: new Date().toISOString(), turns: TURNS, settleMs: SETTLE_MS, rows, errors}, null, 2));
  console.log('JSON: ' + OUT);
  if(errors.length) process.exitCode = 1;
}

/* ---------- setlist mode (--setlist): a quick player turning through a whole setlist of photo charts ---------- */
async function setlistMode(page, context, work, errors){
  assert(READY === 'on' || READY === 'off', '--ready must be on or off');
  const names = Array.from({length: SONGS}, (_, i) => `Photo Set ${String(i + 1).padStart(2, '0')}`);
  const files = await makePhotoPdfs(page, work, names.map(n => ({file: n, label: n})), {pages: SPAGES});
  await page.setInputFiles('#file', files);
  await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, SONGS, {timeout: 120000});
  const titles = await page.evaluate(async () => (await import('./js/store.js')).state.songs.map(s => s.title));
  const order = names.map(n => { const x = titles.find(v => v.toLowerCase().replace(/\W+/g, '') === n.toLowerCase().replace(/\W+/g, '')); assert(x, 'no title for ' + n + ' in ' + JSON.stringify(titles)); return x; });
  await page.click('#tSets');
  await page.click('#view [data-newset]');
  await page.locator('.modal input[type=text]').fill('Timing set');
  await page.click('.modal [data-ok]');
  await page.waitForFunction(() => document.querySelector('#view h2')?.textContent === 'Timing set');
  for(let i = 0; i < names.length; i++){          // one at a time, so the order is the order of the names
    await page.click('#view [data-addto]');
    await page.locator('.modal .pick').waitFor();
    await page.locator('.modal .pick label', {hasText: new RegExp('^\\s*' + order[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$')}).locator('input').check();
    await page.click('.modal [data-ok]');
    await page.waitForFunction(n => document.querySelectorAll('#items > li.row').length === n, i + 1);
  }
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
  await page.click('#view [data-play]');
  const play0 = Date.now();
  await page.waitForSelector('#viewer.on #stage .sheet canvas');
  if((await page.getAttribute('#v2up', 'aria-pressed')) === 'true') await page.click('#v2up');
  await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 1);
  await page.evaluate(INSTALL);
  await sleep(Math.max(0, LEAD - (Date.now() - play0)));
  const turns = [], t0 = Date.now();
  let last = Date.now(), k = 1, p = 1;
  while(!(k === SONGS && p === SPAGES)){
    const across = p === SPAGES, nk = across ? k + 1 : k, np = across ? 1 : p + 1;
    const armed = page.evaluate(e => window.__arm(e), {sub: `^Song ${nk} of ${SONGS} · Page ${np} of ${SPAGES}$`});
    await sleep(30);
    const wait = last + PACE - Date.now();           // a turn that took longer than the pace is finished first (the arm is one turn at a time)
    if(wait > 0) await sleep(wait);
    last = Date.now();
    await page.mouse.move(1280 * 0.85, 400); await page.mouse.down(); await page.mouse.up();
    const r = await armed;
    turns.push({kind: across ? 'across' : 'inside', ms: Math.round(r.ms * 10) / 10, song: nk, page: np});
    k = nk; p = np;
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);
  const rows = ['inside', 'across'].map(kind => { const s = stat(turns.filter(t => t.kind === kind).map(t => t.ms)); return {kind, n: s.n, s}; }).filter(r => r.n);
  const f = x => String(Math.round(x));
  const slow = [...turns].sort((a, b) => b.ms - a.ms).slice(0, 5);
  const lines = [`Page-turn timing (setlist mode), label "${label}", root ${root}`,
    `Chromium 1280x800 @2x, CPU 4x, ready ${READY}, ${SONGS} songs x ${SPAGES} pages, pace ${PACE} ms, lead ${LEAD} ms, ${seconds} s`,
    '', pad('kind', 9) + lpad('n', 4) + lpad('median ms', 11) + lpad('p90 ms', 9) + lpad('worst ms', 10) + lpad('best ms', 9),
    ...rows.map(r => { const v = turns.filter(t => t.kind === r.kind).map(t => t.ms).sort((a, b) => a - b); const p90 = v[Math.min(v.length - 1, Math.ceil(v.length * 0.9) - 1)];
      r.p90 = p90; return pad(r.kind, 9) + lpad(r.n, 4) + lpad(f(r.s.median), 11) + lpad(f(p90), 9) + lpad(f(r.s.worst), 10) + lpad(f(r.s.best), 9); }),
    '', '5 slowest turns:', ...slow.map(t => `  ${lpad(f(t.ms), 6)} ms  ${t.kind}  song ${t.song}, page ${t.page}`),
    '', errors.length ? 'PAGE ERRORS: ' + errors.join(' | ') : 'No page errors.'];
  console.log(lines.join('\n'));
  fs.writeFileSync(OUT, JSON.stringify({label, root, mode: 'setlist', when: new Date().toISOString(), ready: READY, songs: SONGS, pages: SPAGES, pace: PACE, lead: LEAD,
    summary: rows.map(r => ({kind: r.kind, n: r.n, median_ms: Math.round(r.s.median), p90_ms: Math.round(r.p90), worst_ms: Math.round(r.s.worst), best_ms: Math.round(r.s.best)})), turns, errors}, null, 2));
  console.log('JSON: ' + OUT);
  if(errors.length) process.exitCode = 1;
}

/* ---------- main ---------- */
const turnTypes = {};
const peak = {pixels: 0, entries: 0};
const stat = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return {n, median: n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2, worst: s[n - 1], best: s[0]}; };
const rec = (k, ms) => (turnTypes[k] ||= []).push(ms);

async function main(){
  await acquireSlot('page-turn-timing');
  let browser, srv;
  try{
    const work = fs.mkdtempSync(path.join(SCRATCH, 'timing-pdfs-'));
    srv = await startServer({root});
    browser = await launchBrowser();
    const context = await browser.newContext({viewport: {width: 1280, height: 800}, deviceScaleFactor: 2, serviceWorkers: 'block'});
    if(SETLIST && READY === 'off') await context.addInitScript(() => { try{ localStorage.setItem('ss-ready', '0'); }catch(e){} });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if(m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(srv.base + 'index.html');
    await page.waitForSelector('#libList, #view');
    await page.waitForFunction(() => !document.querySelector('#view')?.textContent.includes('Loading'), null, {timeout: 10000}).catch(() => {});
    if(SETLIST){ await setlistMode(page, context, work, errors); fs.rmSync(work, {recursive: true, force: true}); return; }
    if(PHOTO || LIBRARY){ await compare(page, context, work, errors); fs.rmSync(work, {recursive: true, force: true}); return; }
    const pdfs = await makePdfs(work);

    /* library: add the three PDFs the way a person does */
    await page.setInputFiles('#file', pdfs);
    await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 3, null, {timeout: 60000});
    const titles = await page.locator('#libList [data-open] .t').allTextContents();
    const tA = titles.find(t => /Song A$/i.test(t)), tB = titles.find(t => /Song B$/i.test(t)), tC = titles.find(t => /Song C$/i.test(t));
    assert(tA && tB && tC, 'titles not found: ' + JSON.stringify(titles));
    /* setlist: A, B, break, C */
    await page.click('#tSets');
    await page.click('#view [data-newset]');
    await page.locator('.modal input[type=text]').fill('Timing set');
    await page.click('.modal [data-ok]');
    await page.waitForFunction(() => document.querySelector('#view h2')?.textContent === 'Timing set');
    const addSongs = async list => {
      const n0 = await page.locator('#items > li.row').count();
      await page.click('#view [data-addto]');
      await page.locator('.modal .pick').waitFor();
      for(const t of list) await page.locator('.modal .pick label', {hasText: new RegExp('^\\s*' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$')}).locator('input').check();
      await page.click('.modal [data-ok]');
      await page.waitForFunction(n => document.querySelectorAll('#items > li.row').length === n, n0 + list.length);
    };
    await addSongs([tA, tB]);
    await page.click('#view [data-addbreak]');
    await page.waitForFunction(() => document.querySelectorAll('#items > li.row').length === 3);
    await addSongs([tC]);
    const kinds = await page.locator('#items > li.row').evaluateAll(els => els.map(e => e.classList.contains('brk') ? 'break' : 'song'));
    assert(kinds.join() === 'song,song,break,song', 'setlist rows: ' + kinds.join());

    /* open it, Two pages off */
    await page.click('#view [data-play]');
    await page.waitForSelector('#viewer.on #stage .sheet canvas');
    if((await page.getAttribute('#v2up', 'aria-pressed')) === 'true') await page.click('#v2up');
    await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 1);
    await page.evaluate(INSTALL);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});

    const sample = async () => {
      const s = await page.evaluate(cacheStats);
      if(s.pixels > peak.pixels) peak.pixels = s.pixels;
      if(s.entries > peak.entries) peak.entries = s.entries;
    };
    const settle = async () => {
      await page.evaluate(() => window.__settled());
      await sleep(SETTLE_MS);
      await page.evaluate(() => window.__settled());
      await sample();
    };
    const subRe = (k, p) => `^Song ${k} of 3 · Page ${p} of ${PAGES}$`;
    const openAt = async (qi, p) => {
      await page.evaluate(([qi, p]) => window.__open(qi, p), [qi, p]);
      await page.evaluate(re => window.__waitShown(re), subRe(qi === 3 ? 3 : qi + 1, p));
      await settle();
    };
    const tap = async (frac, expect) => {
      const armed = page.evaluate(e => window.__arm(e), expect);
      await sleep(30);
      await page.mouse.move(1280 * frac, 400);
      await page.mouse.down();
      await page.mouse.up();
      const r = await armed;
      await sample();
      await settle();
      return r.ms;
    };
    const NEXT = 0.85, PREV = 0.15, song = (k, p) => ({sub: subRe(k, p)});
    const t0 = Date.now();

    /* 1: forward inside a song */
    await openAt(0, 1);
    for(let i = 0; i < TURNS; i++) rec('1 forward inside a song', await tap(NEXT, song(1, i + 2)));
    /* 2: back inside a song, cold (fresh open on page p) */
    for(let i = 0; i < TURNS; i++){ const p = 3 + i; await openAt(0, p); rec('2 back inside a song (cold page)', await tap(PREV, song(1, p - 1))); }
    /* 2b: back to the page just left */
    await openAt(0, 1);
    for(let i = 1; i <= TURNS; i++){
      await tap(NEXT, song(1, i + 1)); await tap(NEXT, song(1, i + 2));       // untimed
      rec('2b back to the page just left', await tap(PREV, song(1, i + 1)));
    }
    /* 3: into the next song */
    for(let i = 0; i < TURNS; i++){ await openAt(0, PAGES); rec('3 into the next song', await tap(NEXT, song(2, 1))); }
    /* 4: back into the previous song */
    for(let i = 0; i < TURNS; i++){ await openAt(1, 1); rec('4 back into the previous song', await tap(PREV, song(1, PAGES))); }
    /* 5: through a break */
    for(let i = 0; i < TURNS; i++){
      await openAt(1, PAGES);
      const a = await tap(NEXT, {brk: 'Break'}), b = await tap(NEXT, song(3, 1));
      rec('5a song -> break page', a); rec('5b break page -> song', b); rec('5 through a break (a + b)', a + b);
    }
    const seconds = Math.round((Date.now() - t0) / 1000);

    /* report */
    const keys = Object.keys(turnTypes).sort();
    const table = keys.map(k => { const s = stat(turnTypes[k]); return {type: k, n: s.n, median_ms: Math.round(s.median), worst_ms: Math.round(s.worst), best_ms: Math.round(s.best)}; });
    const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);
    const lines = [`Page-turn timing, label "${label}", root ${root}`,
      `Chromium 1280x800 @2x, CPU 4x, Two pages off, ${TURNS} turns per type, settle ${SETTLE_MS} ms (+ prefetch settled), ${seconds} s`,
      '', pad('turn type', 38) + lpad('n', 4) + lpad('median ms', 11) + lpad('worst ms', 10) + lpad('best ms', 9),
      ...table.map(r => pad(r.type, 38) + lpad(r.n, 4) + lpad(r.median_ms, 11) + lpad(r.worst_ms, 10) + lpad(r.best_ms, 9)),
      '', `Peak cached canvas pixels: ${peak.pixels} (${(peak.pixels / 1e6).toFixed(2)} Mpx, ${(peak.pixels * 4 / 1048576).toFixed(1)} MiB as RGBA)`,
      `Largest cache: ${peak.entries} entries`,
      errors.length ? 'PAGE ERRORS: ' + errors.join(' | ') : 'No page errors.'];
    console.log(lines.join('\n'));
    fs.writeFileSync(OUT, JSON.stringify({label, root, when: new Date().toISOString(), turns: TURNS, settleMs: SETTLE_MS, pages: PAGES,
      table, raw: turnTypes, peakCachePixels: peak.pixels, peakCacheEntries: peak.entries, errors}, null, 2));
    console.log('JSON: ' + OUT);
    fs.rmSync(work, {recursive: true, force: true});
    if(errors.length) process.exitCode = 1;
  } finally {
    try{ if(browser) await browser.close(); }catch(e){}
    try{ if(srv) srv.close(); }catch(e){}
    releaseSlot();
  }
}
main().catch(e => { console.error(e); process.exit(1); });

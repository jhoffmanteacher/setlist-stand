/*
 * Page-turn timing ("faster page turns" work order, Part 3). Measures how long a page turn takes in the viewer,
 * and how many pixels of rendered pages the viewer keeps in memory, so a change can be compared with "before".
 *
 *   caffeinate -i node tools/page-turn-timing.mjs --label before [--root <dir>] [--turns 20]
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
import {startServer, ROOT, PDFDocument, sleep, assert} from './loops/harness.mjs';
import {launchBrowser} from './loops/browser.mjs';
import {acquireSlot, releaseSlot} from './loops/slot.mjs';

const SCRATCH = process.env.SS_TIMING_OUT || os.tmpdir();      // where the JSON and the temporary PDFs go (nothing is written in the repo)
const PAGES = 24, SETTLE_MS = 1200, TIMEOUT = 15000;

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const root = path.resolve(opt('root', ROOT)), label = opt('label', 'run'), TURNS = +opt('turns', 20);
const OUT = path.join(SCRATCH, `timing-${label}.json`);

/* ---------- the one function that reads the cache (runs in the page) ---------- */
const cacheStats = async () => {
  const {V} = await import('./js/viewer.js');
  let pixels = 0;
  const all = await Promise.allSettled([...V.cache.values()]);
  for(const r of all) if(r.status === 'fulfilled' && r.value && r.value.cv) pixels += r.value.cv.width * r.value.cv.height;
  return {pixels, entries: V.cache.size};
};

/* ---------- PDFs ---------- */
async function makePdfs(dir){
  fs.mkdirSync(dir, {recursive: true});
  const names = ['A', 'B', 'C'], files = [];
  for(const n of names){
    const doc = await PDFDocument.create();
    const font = await doc.embedFont('Helvetica'), bold = await doc.embedFont('Helvetica-Bold');
    for(let p = 1; p <= PAGES; p++){
      const pg = doc.addPage([612, 792]);
      pg.drawText(`Timing song ${n}, page ${p}`, {x: 60, y: 700, size: 36, font: bold});
      for(let l = 0; l < 14; l++) pg.drawText(`Line ${l + 1}: the quick brown fox plays chart ${n} bar ${p * 8 + l}`, {x: 60, y: 640 - l * 36, size: 20, font});
      pg.drawRectangle({x: 60, y: 60, width: 492, height: 40, borderWidth: 3});
    }
    const f = path.join(dir, `Timing Song ${n}.pdf`);
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
    const up = () => {
      t0 = performance.now(); old = stage.querySelector('.sheet canvas:not(.ink)');
      obs = new MutationObserver(check); obs.observe(stage, {childList: true, subtree: true}); obs.observe(sub, {childList: true, characterData: true, subtree: true});
      timer = setTimeout(() => finish(reject, new Error('timeout: expected ' + JSON.stringify(expect) + ', sub "' + sub.textContent + '"')), 15000);
      check();
    };
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
  window.__open = async (qi, page) => { const m = await import('./js/viewer.js'); await m.openViewer(m.V.queue, qi, page); };
  window.__settled = async () => { const m = await import('./js/viewer.js'); await Promise.allSettled([...m.V.cache.values()]); };
};

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
    const pdfs = await makePdfs(work);
    srv = await startServer({root});
    browser = await launchBrowser();
    const context = await browser.newContext({viewport: {width: 1280, height: 800}, deviceScaleFactor: 2, serviceWorkers: 'block'});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if(m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(srv.base + 'index.html');
    await page.waitForSelector('#libList, #view');
    await page.waitForFunction(() => !document.querySelector('#view')?.textContent.includes('Loading'), null, {timeout: 10000}).catch(() => {});

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

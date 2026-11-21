/*
 * Page-turn loops: the viewer readies the pages and songs next to the one showing (js/viewer.js, js/pagecache.js), and
 * what it readies is checked in the real app, in a real setlist with a break, through the canvases and documents
 * themselves: a turn must land on a canvas that was drawn BEFORE the tap and on the document that was opened BEFORE it
 * (same objects, so nothing was opened or drawn again); a song prepared and not played is closed and its pages are
 * emptied; the cache never holds more pixels than its limit. How fast it is: node tools/page-turn-timing.mjs.
 */
import path from 'node:path';
import fs from 'node:fs';
import {TMP, assert, sleep, idbAll, PDFDocument} from './harness.mjs';

const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta'], PAGES = 3;
async function makePdfs(){
  const out = [];
  for(const n of NAMES){
    const doc = await PDFDocument.create(), font = await doc.embedFont('Helvetica-Bold');
    for(let p = 1; p <= PAGES; p++) doc.addPage([612, 792]).drawText(`${n} page ${p}`, {x: 60, y: 700, size: 40, font});
    const f = path.join(TMP, `${n} turns.pdf`); fs.writeFileSync(f, await doc.save()); out.push(f);
  }
  return out;
}
async function waitFor(fn, what, ms = 8000){
  const end = Date.now() + ms; let v;
  while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(60); }
  throw new Error(typeof what === 'function' ? await what() : what);
}

async function loopTurns(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    const files = await makePdfs();
    for(const [i, f] of files.entries()){
      await page.setInputFiles('#file', f);
      await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, i + 1, {timeout: 20000});
    }
    /* a setlist: Alpha, Bravo, a break, Charlie, Delta */
    await page.click('#tSets'); await page.click('#view [data-newset]');
    await page.locator('.modal input[type=text]').fill('Turns');
    await page.click('.modal [data-ok]');
    await page.waitForFunction(() => document.querySelector('#view h2')?.textContent === 'Turns');
    const rows = () => page.locator('#items > li.row').count();
    const addSong = async n => {
      const n0 = await rows();
      await page.click('#view [data-addto]');
      await page.locator('.modal .pick').waitFor();
      await page.locator('.modal .pick label', {hasText: new RegExp('^' + n)}).locator('input').check();
      await page.click('.modal [data-ok]');
      await page.waitForFunction(k => document.querySelectorAll('#items > li.row').length === k, n0 + 1, {timeout: 5000});
    };
    await addSong('Alpha'); await addSong('Bravo');
    const n0 = await rows(); await page.click('#view [data-addbreak]');
    await page.waitForFunction(k => document.querySelectorAll('#items > li.row').length === k, n0 + 1, {timeout: 5000});
    await addSong('Charlie'); await addSong('Delta');
    await page.click('#view [data-play]');
    await page.waitForSelector('#viewer.on #stage .sheet canvas');
    await page.evaluate(() => document.querySelector('#viewer').classList.remove('hide'));
    if(await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
    await waitFor(() => page.evaluate(() => document.querySelectorAll('#stage .sheet').length === 1 && /Page 1 of 3/.test(document.querySelector('#vSub').textContent)), 'Alpha did not show one page');

    /* in the page: look at the viewer's own state */
    await page.evaluate(() => {
      window.__v = import('./js/viewer.js');
      window.__pc = import('./js/pagecache.js');
      window.__settle = async () => { const {V} = await window.__v; for(let i = 0; i < 3; i++) await Promise.allSettled([...V.cache.values(), ...[...V.prep.values()].map(e => e.p)]); };
      /* every canvas the cache holds right now, and every document the viewer holds (current and prepared) */
      window.__snap = async () => { const {V} = await window.__v; const rs = await Promise.allSettled([...V.cache.values()]);
        return {cvs: rs.filter(r => r.status === 'fulfilled').map(r => r.value.cv), docs: [V.doc, ...(await Promise.all([...V.prep.values()].map(e => e.p)))].filter(Boolean)}; };
      window.__seen = {cvs: [], docs: []};
      window.__note = async () => { const x = await window.__snap(); for(const c of x.cvs) if(!window.__seen.cvs.includes(c)) window.__seen.cvs.push(c); for(const d of x.docs) if(!window.__seen.docs.includes(d)) window.__seen.docs.push(d); };
    });
    const state = () => page.evaluate(async () => { const {V} = await window.__v; return {qi: V.qi, brk: !!V.brk, page: V.page, prep: [...V.prep.keys()].sort(), title: document.querySelector('#vTitle').textContent, size: V.cache.size}; });
    const settle = async () => { await page.evaluate(() => window.__settle()); await page.evaluate(() => window.__note()); };
    const pixelsOk = async what => {
      const r = await page.evaluate(async () => { const {MAX_PIXELS, MAX_ENTRIES} = await window.__pc; const {cvs} = await window.__snap(); return {px: cvs.reduce((a, c) => a + c.width * c.height, 0), n: cvs.length, MAX_PIXELS, MAX_ENTRIES}; });
      assert(r.px <= r.MAX_PIXELS && r.n <= r.MAX_ENTRIES, `${what}: the cache holds ${r.n} pages, ${r.px} pixels (limits ${r.MAX_ENTRIES}, ${r.MAX_PIXELS})`);
    };
    /* a turn (a button, as a person's tap would do): returns when the viewer shows the expected title and page */
    const turn = async (dir, title, pg) => {
      await page.click(dir === 'next' ? '#vNext' : '#vPrev');
      await waitFor(async () => { const t = await state(); return t.title.includes(title) && !t.brk && t.page === pg && await page.evaluate(() => !!document.querySelector('#stage .sheet canvas:not(.ink)')); }, async () => `after ${dir}: expected ${title} page ${pg}, got ${JSON.stringify(await state())}`);
    };
    /* Each turn below is checked the same way: was what is on the stage drawn, and its document opened, BEFORE the tap?
       (the same canvas and document objects as in the snapshot taken just before the tap) */
    /* Alpha: page 1 -> 3. At its last page the next song (Bravo, entry 1) is prepared. */
    await settle();
    assert((await state()).prep.length === 0, 'something was prepared before the end of the first song: ' + JSON.stringify(await state()));
    await turn('next', 'Alpha', 2); await turn('next', 'Alpha', 3);
    await settle();
    let st = await state();
    assert(JSON.stringify(st.prep) === '[1]', 'on the last page of Alpha the next song is not the one prepared: ' + JSON.stringify(st));
    const preparedBravo = await page.evaluate(async () => { const {V} = await window.__v; return (await V.prep.get(1).p) === null ? 'none' : 'doc'; });
    assert(preparedBravo === 'doc', 'the prepared Bravo has no document');
    await pixelsOk('on Alpha page 3');

    /* into Bravo: its first page was drawn and its document opened before the tap */
    await page.evaluate(async () => { window.__before = await window.__snap(); });
    await page.click('#vNext');
    await waitFor(async () => (await state()).title.includes('Bravo'), 'the turn into Bravo did not happen');
    let r = await page.evaluate(async () => { const {V} = await window.__v, cv = document.querySelector('#stage .sheet canvas:not(.ink)'); return {docWas: window.__before.docs.includes(V.doc), cvWas: window.__before.cvs.includes(cv) && cv.width > 0}; });
    assert(r.docWas, 'turning into Bravo opened its PDF again: the document was not the prepared one');
    assert(r.cvWas, 'turning into Bravo drew its first page again: the canvas was not the prepared one');
    await settle();
    st = await state();
    assert(JSON.stringify(st.prep) === '[0]', 'in Bravo the song just left (Alpha, entry 0) should be the one kept: ' + JSON.stringify(st));

    /* back into Alpha: its last page is the one it was left on, ready (document and canvas) */
    await page.evaluate(async () => { window.__before = await window.__snap(); });
    await page.click('#vPrev');
    await waitFor(async () => { const t = await state(); return t.title.includes('Alpha') && t.page === 3; }, async () => 'going back did not land on Alpha page 3: ' + JSON.stringify(await state()));
    r = await page.evaluate(async () => { const {V} = await window.__v, cv = document.querySelector('#stage .sheet canvas:not(.ink)'); return {docWas: window.__before.docs.includes(V.doc), cvWas: window.__before.cvs.includes(cv) && cv.width > 0}; });
    assert(r.docWas && r.cvWas, 'going back into Alpha opened or drew it again: ' + JSON.stringify(r));
    await settle();

    /* forward through the break to Charlie; Alpha is no longer next to anything: closed, its pages emptied */
    await turn('next', 'Bravo', 1); await turn('next', 'Bravo', 2); await turn('next', 'Bravo', 3);
    await settle();
    const docs0 = await page.evaluate(() => window.__seen.docs.map(d => d.loadingTask.destroyed));
    await page.click('#vNext');
    await waitFor(async () => (await state()).brk, 'the turn into the break did not happen');
    await settle();
    st = await state();
    assert(JSON.stringify(st.prep) === '[1,3]', 'on the break the songs either side (Bravo, Charlie) should be the prepared ones: ' + JSON.stringify(st));
    await sleep(150);
    const gone = await page.evaluate(() => ({docs: window.__seen.docs.map(d => d.loadingTask.destroyed), cvs: window.__seen.cvs.map(c => c.width)}));
    assert(gone.docs.filter(Boolean).length === docs0.filter(Boolean).length + 1, `Alpha's document was not closed on the break (${JSON.stringify(docs0)} -> ${JSON.stringify(gone.docs)})`);
    await pixelsOk('on the break');

    /* the break -> Charlie: opened and drawn before the tap */
    await page.evaluate(async () => { window.__before = await window.__snap(); });
    await page.click('#vNext');
    await waitFor(async () => (await state()).title.includes('Charlie'), 'the turn out of the break did not happen');
    r = await page.evaluate(async () => { const {V} = await window.__v, cv = document.querySelector('#stage .sheet canvas:not(.ink)'); return {docWas: window.__before.docs.includes(V.doc), cvWas: window.__before.cvs.includes(cv) && cv.width > 0}; });
    assert(r.docWas && r.cvWas, 'turning from the break into Charlie opened or drew it again: ' + JSON.stringify(r));

    /* to Charlie's last page: Delta is prepared; Back to the library: everything prepared is closed and every page emptied */
    await turn('next', 'Charlie', 2); await turn('next', 'Charlie', 3);
    await settle();
    st = await state();
    assert(JSON.stringify(st.prep) === '[1,4]' || JSON.stringify(st.prep) === '[4]', 'on the last page of Charlie Delta should be prepared: ' + JSON.stringify(st));
    await pixelsOk('on Charlie page 3');
    /* a song never visited, entered from the middle of the set: Bravo opened cold on its first page, the song before it (Alpha) is readied */
    await page.evaluate(async () => { const m = await window.__v; await m.openViewer(m.V.queue, 1, 1); });
    await waitFor(async () => { const t = await state(); return t.title.includes('Bravo') && t.page === 1; }, 'reopening Bravo on page 1 did not show it');
    await settle();
    await page.evaluate(async () => { window.__before = await window.__snap(); });
    await page.click('#vPrev');
    await waitFor(async () => { const t = await state(); return t.title.includes('Alpha') && t.page === 3; }, 'going back from Bravo (opened cold) did not land on Alpha page 3');
    r = await page.evaluate(async () => { const {V} = await window.__v, cv = document.querySelector('#stage .sheet canvas:not(.ink)'); return {docWas: window.__before.docs.includes(V.doc), cvWas: window.__before.cvs.includes(cv) && cv.width > 0}; });
    assert(r.docWas && r.cvWas, 'going back into Alpha from a Bravo opened cold opened or drew Alpha after the tap (the previous song is not prepared): ' + JSON.stringify(r));

    /* inside a song: opened cold on the middle page, both neighbours are drawn before any tap */
    for(const [dir, button, want] of [['next', '#vNext', 3], ['back', '#vPrev', 1]]){
      await page.evaluate(async () => { const m = await window.__v; await m.openViewer(m.V.queue, 3, 2); });
      await waitFor(async () => { const t = await state(); return t.title.includes('Charlie') && t.page === 2; }, 'reopening Charlie on page 2 did not show it');
      await settle();
      await page.evaluate(async () => { window.__before = await window.__snap(); });
      await page.click(button);
      await waitFor(() => page.evaluate(w => document.querySelector('#stage .ink')?.dataset.pn == w, want), `${dir} inside Charlie did not show page ${want}`);   // the stage, not just V.page
      r = await page.evaluate(async () => { const cv = document.querySelector('#stage .sheet canvas:not(.ink)'); return {cvWas: window.__before.cvs.includes(cv) && cv.width > 0}; });
      assert(r.cvWas, `turning ${dir} inside a song drew page ${want} after the tap: it was not readied (the neighbour on that side is not prefetched)`);
    }
    await page.click('#vBack');
    await page.waitForFunction(() => !document.querySelector('#viewer').classList.contains('on'));
    await sleep(200);
    const after = await page.evaluate(async () => { const {V} = await window.__v; return {prep: V.prep.size, cache: V.cache.size, docs: window.__seen.docs.map(d => d.loadingTask.destroyed), live: window.__seen.cvs.filter(c => c.width > 0).length, seen: window.__seen.cvs.length}; });
    assert(after.prep === 0 && after.cache === 0, `Back left ${after.prep} prepared songs and ${after.cache} cached pages`);
    assert(after.docs.every(Boolean), `Back left ${after.docs.filter(d => !d).length} of ${after.docs.length} PDFs open`);
    assert(after.live === 0, `Back left ${after.live} of ${after.seen} page canvases holding memory`);
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* The cache itself, with stand-in canvases: the pixel limit, the order things go in, and what is never evicted. */
async function loopCacheLimit(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    const out = await page.evaluate(async () => {
      const {PageCache, MAX_PIXELS, MAX_ENTRIES} = await import('./js/pagecache.js');
      const tick = () => new Promise(r => setTimeout(r, 30));
      const fake = (w, h) => ({width: w, height: h, isConnected: false});
      const put = (c, k, w, h) => { const cv = fake(w, h); c.put(k, Promise.resolve({cv}), w * h); return cv; };
      const res = {MAX_PIXELS, MAX_ENTRIES};
      /* 1. eight 4-megapixel pages: the limit holds, the oldest go and are emptied, the newest stay whole */
      let c = new PageCache(); const a = []; for(let i = 0; i < 8; i++) a.push(put(c, 'a' + i, 2000, 2000));
      await tick();
      res.px1 = c.total(); res.kept1 = [...c.keys()].join(); res.emptied1 = a.map(x => x.width === 0).join(); res.whole1 = a.slice(-3).every(x => x.width === 2000);
      /* 2. a pinned page stays through the squeeze */
      c = new PageCache(); const p = put(c, 'p', 2000, 2000); await tick(); const free = c.hold(['p']);
      const more = []; for(let i = 0; i < 8; i++) more.push(put(c, 'm' + i, 2000, 2000));
      await tick(); res.pinnedKept = c.has('p') && p.width === 2000; free(); await tick(); res.pinnedFreed = !c.has('p') || c.total() <= MAX_PIXELS;
      /* 3. a render still running is never evicted, and counts by its estimate */
      c = new PageCache(); let finish; const slow = new Promise(r => { finish = r; }); c.put('slow', slow, 30e6);
      const b = []; for(let i = 0; i < 4; i++) b.push(put(c, 'b' + i, 2000, 2000)); await tick();
      res.slowKept = c.has('slow'); const cvSlow = fake(5000, 5000); finish({cv: cvSlow}); await tick();   // ends at 25 megapixels: over the limit alone
      res.slowThenTrimmed = c.total() <= MAX_PIXELS && cvSlow.width === 0 ? 'evicted-and-emptied' : (c.has('slow') ? 'kept' : 'gone-not-emptied');
      /* 4. many tiny pages: the count limit */
      c = new PageCache(); for(let i = 0; i < 40; i++) put(c, 't' + i, 10, 10); await tick(); res.count = c.size;
      /* 5. a canvas on screen is not emptied by eviction; unused() empties it once it leaves the screen */
      c = new PageCache(); const shown = put(c, 's', 2000, 2000); shown.isConnected = true; await tick();
      for(let i = 0; i < 8; i++) put(c, 'x' + i, 2000, 2000); await tick();
      res.shownKept = !c.has('s') && shown.width === 2000; shown.isConnected = false; c.unused(shown); res.shownEmptied = shown.width === 0;
      /* 6. dropPrefix and clear empty what they drop */
      c = new PageCache(); const d1 = put(c, 'd1:1', 100, 100), d2 = put(c, 'd2:1', 100, 100); await tick(); c.dropPrefix('d1:'); await tick();
      res.prefix = [d1.width, d2.width, c.size].join(); c.clear(); await tick(); res.cleared = [d2.width, c.size].join();
      return res;
    });
    assert(out.px1 <= out.MAX_PIXELS, `eight 4-megapixel pages left ${out.px1} pixels in the cache (limit ${out.MAX_PIXELS})`);
    assert(out.kept1 === 'a2,a3,a4,a5,a6,a7' || out.kept1 === 'a3,a4,a5,a6,a7' || out.kept1.endsWith('a7') && out.kept1.split(',').length <= 6, 'the oldest pages did not go first: ' + out.kept1);
    assert(out.emptied1.startsWith('true,true') && out.whole1, `evicted pages were not emptied, or kept ones were: ${out.emptied1}`);
    assert(out.pinnedKept, 'a page being waited for (held) was evicted');
    assert(out.pinnedFreed, 'after hold() was released the cache stayed over its limit');
    assert(out.slowKept, 'a render still running was evicted');
    assert(out.slowThenTrimmed === 'evicted-and-emptied', 'a render that ended over the limit was not trimmed: ' + out.slowThenTrimmed);
    assert(out.count <= out.MAX_ENTRIES, `40 tiny pages left ${out.count} entries (limit ${out.MAX_ENTRIES})`);
    assert(out.shownKept, 'a canvas on screen was emptied by eviction');
    assert(out.shownEmptied, 'unused() did not empty a canvas that left the screen');
    assert(out.prefix === '0,100,1', 'dropPrefix: ' + out.prefix);
    assert(out.cleared === '0,0', 'clear: ' + out.cleared);
  } finally { await s.close(); }
}

export const loops = [
  {name: 'page turns: the next and previous song and page are opened and drawn before the tap; unplayed songs are closed and their pages emptied', run: loopTurns},
  {name: 'page turns: the page cache stays under its pixel and count limits, never evicts what is on screen or being drawn, and empties what leaves', run: loopCacheLimit},
];

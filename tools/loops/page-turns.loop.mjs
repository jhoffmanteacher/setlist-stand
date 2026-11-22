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
import {makePhotoPdfs, cropSongs} from './photo-pdf.mjs';

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

/* The four songs and the setlist Alpha, Bravo, (break), Charlie, Delta, played from its start. twoUp: leave "Two pages"
   on (the default on a landscape tablet); otherwise turn it off so one tap is one page. */
async function playSet(s, twoUp){
  const {page} = s;
  {
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
    if(!twoUp && await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
    await waitFor(() => page.evaluate(n => document.querySelectorAll('#stage .sheet').length === n && /Page 1[–-]?2? ?of 3|Page 1 of 3/.test(document.querySelector('#vSub').textContent), twoUp ? 2 : 1), 'Alpha did not show ' + (twoUp ? 'a spread' : 'one page'));
  }
}
/* In the page: ways to look at the viewer's own state (the cache, the prepared songs, every canvas and document ever seen). */
async function installKit(page){
  {
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
    /* everything drawn and opened ahead has finished; remember it as "before the tap" */
    const before = async () => { await settle(); await page.evaluate(async () => { window.__before = await window.__snap(); }); };
    /* after a turn: the canvases on the stage and the document in use were all there before the tap, and they are the right
       song's (its own text, "<Name> page <n>", on each page shown: a turn that landed on the wrong song's page fails here) */
    const landed = async (name, pages, what) => {
      const r = await page.evaluate(async ([name, pages]) => {
        const {V} = await window.__v, cvs = [...document.querySelectorAll('#stage .sheet canvas:not(.ink)')], shown = [...document.querySelectorAll('#stage .ink')].map(i => +i.dataset.pn);
        const text = async pn => (await (await V.doc.getPage(pn)).getTextContent()).items.map(i => i.str).join(' ');
        const right = []; for(const pn of pages) right.push((await text(pn)).includes(name + ' page ' + pn));
        return {docWas: window.__before.docs.includes(V.doc), cvWas: cvs.length === pages.length && cvs.every(c => window.__before.cvs.includes(c) && c.width > 0), shown, right};
      }, [name, pages]);
      assert(JSON.stringify(r.shown) === JSON.stringify(pages) && r.right.every(Boolean), `${what}: the stage shows pages ${JSON.stringify(r.shown)}, expected ${name} ${JSON.stringify(pages)} (text check ${JSON.stringify(r.right)})`);
      assert(r.docWas, `${what}: the document was opened after the tap (it was not the prepared or kept one)`);
      assert(r.cvWas, `${what}: a page was drawn after the tap (it was not readied)`);
    };
    return {state, settle, before, landed};
  }
}

async function loopTurns(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await playSet(s, false);
    const {state, settle, before, landed} = await installKit(page);
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
    /* Alpha: page 1 -> 3. From the page before its last the next song (Bravo, entry 1) is prepared, not sooner. Opened
       again first: the set opened on the two-page spread 1-2, which IS the spread before Alpha's last, so Bravo was
       rightly prepared there before "Two pages" was turned off. */
    await page.evaluate(async () => { const m = await window.__v; m.closeViewer(); await m.openViewer(m.V.queue, 0, 1); });
    await waitFor(async () => { const t = await state(); return t.title.includes('Alpha') && t.page === 1; }, 'reopening Alpha on page 1 did not show it');
    await settle();
    assert((await state()).prep.length === 0, 'something was prepared before the page before the last of the first song: ' + JSON.stringify(await state()));
    await turn('next', 'Alpha', 2);
    await settle();
    assert(JSON.stringify((await state()).prep) === '[1]', 'on the page before the last of Alpha the next song is not the one prepared: ' + JSON.stringify(await state()));
    await turn('next', 'Alpha', 3);
    await settle();
    let st = await state();
    assert(JSON.stringify(st.prep) === '[1]', 'on the last page of Alpha the next song is not the one prepared: ' + JSON.stringify(st));
    const preparedBravo = await page.evaluate(async () => { const {V} = await window.__v; return (await V.prep.get(1).p) === null ? 'none' : 'doc'; });
    assert(preparedBravo === 'doc', 'the prepared Bravo has no document');
    await pixelsOk('on Alpha page 3');

    /* into Bravo: its first page was drawn and its document opened before the tap */
    await before();
    await page.click('#vNext');
    await waitFor(async () => (await state()).title.includes('Bravo'), 'the turn into Bravo did not happen');
    await landed('Bravo', [1], 'turning into Bravo');
    await settle();
    st = await state();
    assert(JSON.stringify(st.prep) === '[0]', 'in Bravo the song just left (Alpha, entry 0) should be the one kept: ' + JSON.stringify(st));

    /* back into Alpha: its last page is the one it was left on, ready (document and canvas) */
    await before();
    await page.click('#vPrev');
    await waitFor(async () => { const t = await state(); return t.title.includes('Alpha') && t.page === 3; }, async () => 'going back did not land on Alpha page 3: ' + JSON.stringify(await state()));
    await landed('Alpha', [3], 'going back into Alpha');
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
    await before();
    await page.click('#vNext');
    await waitFor(async () => (await state()).title.includes('Charlie'), 'the turn out of the break did not happen');
    await landed('Charlie', [1], 'turning from the break into Charlie');

    /* to Charlie's last page: Delta is prepared; Back to the library: everything prepared is closed and every page emptied */
    await turn('next', 'Charlie', 2); await turn('next', 'Charlie', 3);
    await settle();
    st = await state();
    assert(JSON.stringify(st.prep) === '[1,4]' || JSON.stringify(st.prep) === '[4]', 'on the last page of Charlie Delta should be prepared: ' + JSON.stringify(st));
    await pixelsOk('on Charlie page 3');
    /* a song never visited, entered from the middle of the set: Bravo opened cold on its first page, the song before it (Alpha) is readied */
    await page.evaluate(async () => { const m = await window.__v; await m.openViewer(m.V.queue, 1, 1); });
    await waitFor(async () => { const t = await state(); return t.title.includes('Bravo') && t.page === 1; }, 'reopening Bravo on page 1 did not show it');
    await before();
    await page.click('#vPrev');
    await waitFor(async () => { const t = await state(); return t.title.includes('Alpha') && t.page === 3; }, 'going back from Bravo (opened cold) did not land on Alpha page 3');
    await landed('Alpha', [3], 'going back into Alpha from a Bravo opened cold (the previous song is not prepared)');

    /* inside a song: opened cold on the middle page, both neighbours are drawn before any tap */
    for(const [dir, button, want] of [['next', '#vNext', 3], ['back', '#vPrev', 1]]){
      await page.evaluate(async () => { const m = await window.__v; await m.openViewer(m.V.queue, 3, 2); });
      await waitFor(async () => { const t = await state(); return t.title.includes('Charlie') && t.page === 2; }, 'reopening Charlie on page 2 did not show it');
      await before();
      await page.click(button);
      await waitFor(() => page.evaluate(w => document.querySelector('#stage .ink')?.dataset.pn == w, want), `${dir} inside Charlie did not show page ${want}`);   // the stage, not just V.page
      await landed('Charlie', [want], `turning ${dir} inside a song opened cold in the middle (the neighbour on that side is not prefetched)`);
    }

    /* a break entered cold (the set opened ON the break, as a resume after an update can): both songs next to it are readied, both ways */
    const openAt = async (qi, pg) => { await page.evaluate(async ([qi, pg]) => { const m = await window.__v; await m.openViewer(m.V.queue, qi, pg); }, [qi, pg]); };
    await openAt(2, 1);
    await waitFor(async () => (await state()).brk, 'reopening on the break did not show it');
    await before();
    await page.click('#vNext');
    await waitFor(async () => (await state()).title.includes('Charlie'), 'out of a break opened cold: Charlie did not show');
    await landed('Charlie', [1], 'turning out of a break opened cold');
    await openAt(2, 1);
    await waitFor(async () => (await state()).brk, 'reopening on the break did not show it');
    await before();
    await page.click('#vPrev');
    await waitFor(async () => { const t = await state(); return t.title.includes('Bravo') && t.page === 3; }, 'back out of a break opened cold: Bravo page 3 did not show');
    await landed('Bravo', [3], 'turning back out of a break opened cold');

    /* a resize (or the Two pages toggle) on a break page empties the cache: the songs either side are readied again, at the new size */
    await openAt(2, 1);
    await waitFor(async () => (await state()).brk, 'reopening on the break did not show it');
    const vp = page.viewportSize();
    await page.setViewportSize({width: vp.width - 120, height: vp.height - 60});
    await sleep(600);                                                   // the viewer redraws 150 ms after the last resize
    await before();
    await page.click('#vNext');
    await waitFor(async () => (await state()).title.includes('Charlie'), 'out of the break after a resize: Charlie did not show');
    await landed('Charlie', [1], 'turning out of a break after the window was resized');
    await page.setViewportSize(vp);
    await sleep(500);                                                   // the viewer's own redraw after this resize (150 ms debounce) must be over, or it would repaint a break page and hide a late render below

    /* a render still running for the page just left must never paint over the break page that follows it:
       three turns in one breath, the last one into the break (the break shows at once; the render ends after it) */
    await page.evaluate(async () => { const m = await window.__v; m.closeViewer(); await m.openViewer(m.V.queue, 1, 1); });   // closed first: nothing of Bravo is drawn yet
    await waitFor(async () => { const t = await state(); return t.title.includes('Bravo') && t.page === 1; }, 'reopening Bravo did not show it');
    await page.evaluate(async () => { const m = await window.__v; m.next(); m.next(); m.next(); });
    await waitFor(async () => (await state()).brk, 'three quick turns did not end on the break');
    await sleep(700);
    const stageNow = await page.evaluate(() => ({brk: document.querySelectorAll('#stage .breakpage').length, sheets: document.querySelectorAll('#stage .sheet').length}));
    assert(stageNow.brk === 1 && stageNow.sheets === 0, `a late render painted over the break page: the stage holds ${stageNow.brk} break page and ${stageNow.sheets} sheets`);
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

/* The same readiness with "Two pages" ON (the default on a landscape tablet): a turn is a spread, the last spread of a
   3-page song is its single last page, and the song entered from the next song is entered on a two-page spread. */
async function loopTurnsTwoUp(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await playSet(s, true);
    const {state, settle, before, landed} = await installKit(page);
    const shown = pns => waitFor(() => page.evaluate(p => JSON.stringify([...document.querySelectorAll('#stage .ink')].map(i => +i.dataset.pn)) === JSON.stringify(p), pns), `the stage did not show pages ${JSON.stringify(pns)}`);
    const titled = name => waitFor(async () => (await state()).title.includes(name), `${name} did not show`);
    const openAt = async (qi, pg) => { await page.evaluate(async ([qi, pg]) => { const m = await window.__v; await m.openViewer(m.V.queue, qi, pg); }, [qi, pg]); };

    await shown([1, 2]);
    await page.click('#vNext'); await shown([3]);                      // Alpha's last spread: the single page 3
    await before();
    await page.click('#vNext'); await titled('Bravo'); await shown([1, 2]);
    await landed('Bravo', [1, 2], 'two pages: turning into Bravo (both pages of its first spread)');
    await before();
    await page.click('#vPrev'); await titled('Alpha'); await shown([3]);
    await landed('Alpha', [3], 'two pages: going back into Alpha (its last spread)');

    await openAt(3, 1); await titled('Charlie'); await shown([1, 2]);   // opened cold: the next spread is drawn ahead
    await before();
    await page.click('#vNext'); await shown([3]);
    await landed('Charlie', [3], 'two pages: turning to the next spread inside a song');

    await openAt(4, 1); await titled('Delta'); await shown([1, 2]);     // Delta opened cold: the song before it is readied on ITS last spread
    await before();
    await page.click('#vPrev'); await titled('Charlie'); await shown([3]);
    await landed('Charlie', [3], 'two pages: going back into Charlie (an odd number of pages: its last spread is page 3 alone)');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* Charts that are big photos (each page one ~3000x2400 JPEG, made at run time, with a crop): a photo page takes several
   times longer to draw than a text page, so the next song must be readied while the page BEFORE the last shows, not
   only on the last: a person who turns to the last page and straight on into the next song still lands on a page drawn
   before the tap. "Before the tap" here is strict: only what had FINISHED drawing when the tap came (nothing is waited for). */
async function loopPhotoTurns(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    const files = await makePhotoPdfs(page, path.join(TMP, 'photo-turns'), [{file: 'Echo photo', label: 'Echo'}, {file: 'Foxtrot photo', label: 'Foxtrot'}]);
    await page.setInputFiles('#file', files);
    await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 2, null, {timeout: 30000});
    const titles = await page.evaluate(async () => (await import('./js/store.js')).state.songs.map(x => x.title));
    const echo = titles.find(t => /^Echo/.test(t)), fox = titles.find(t => /^Foxtrot/.test(t));
    assert(echo && fox, 'photo songs not added: ' + JSON.stringify(titles));
    await cropSongs(page, [echo, fox]);
    const {state, settle, before, landed} = await installKit(page);
    await page.evaluate(() => {
      /* what had finished when this runs: a render or an open still under way is left out, never waited for */
      window.__ready = async () => {
        const {V} = await window.__v, NO = {};
        const now = ps => Promise.all(ps.map(p => Promise.race([p, Promise.resolve(NO)]).catch(() => NO)));
        const cvs = (await now([...V.cache.values()])).filter(r => r !== NO && r).map(r => r.cv);
        const docs = [V.doc, ...(await now([...V.prep.values()].map(e => e.p)))].filter(d => d && d !== NO);
        window.__before = {cvs, docs};
      };
    });
    const open = (two, qi, pg) => page.evaluate(async ([two, qi, pg, a, b]) => {
      const m = await window.__v, st = (await import('./js/store.js')).state.songs, id = t => st.find(x => x.title === t).id;
      m.closeViewer(); m.V.two = two; await m.openViewer([{type: 'song', id: id(a)}, {type: 'song', id: id(b)}], qi, pg);
    }, [two, qi, pg, echo, fox]);
    const shown = (name, pns) => waitFor(async () => { const t = await state(); return t.title.includes(name) && await page.evaluate(p => JSON.stringify([...document.querySelectorAll('#stage .ink')].map(i => +i.dataset.pn)) === JSON.stringify(p), pns); },
      async () => `expected ${name} ${JSON.stringify(pns)}, got ${JSON.stringify(await state())}`, 20000);

    /* one page at a time: Echo page 1 (the page before the last), everything settled; then page 2 and at once on into Foxtrot */
    await open(false, 0, 1); await shown('Echo', [1]); await settle();
    await page.click('#vNext'); await shown('Echo', [2]);
    await page.evaluate(() => window.__ready());
    await page.click('#vNext'); await shown('Foxtrot', [1]);
    await landed('Foxtrot', [1], 'photo charts: straight on from the last page into the next song (readied while the page before the last showed)');
    /* and back: Echo's last page, ready */
    await before();
    await page.click('#vPrev'); await shown('Echo', [2]);
    await landed('Echo', [2], 'photo charts: back into the previous song');
    /* two pages: the one spread of Echo, then into Foxtrot's first spread, and back */
    await open(true, 0, 1); await shown('Echo', [1, 2]);
    await before();
    await page.click('#vNext'); await shown('Foxtrot', [1, 2]);
    await landed('Foxtrot', [1, 2], 'photo charts, two pages: into the next song');
    await before();
    await page.click('#vPrev'); await shown('Echo', [1, 2]);
    await landed('Echo', [1, 2], 'photo charts, two pages: back into the previous song');
    const px = await page.evaluate(async () => { const {MAX_PIXELS} = await window.__pc; const {cvs} = await window.__snap(); return {px: cvs.reduce((a, c) => a + c.width * c.height, 0), MAX_PIXELS}; });
    assert(px.px <= px.MAX_PIXELS, `photo charts: the cache holds ${px.px} pixels (limit ${px.MAX_PIXELS})`);
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
  {name: 'page turns: with two pages showing, a turn into the next or previous song, or the next spread, is opened and drawn before the tap', run: loopTurnsTwoUp},
  {name: 'page turns: photo charts (one big JPEG a page, cropped): the next song is drawn before the tap, even straight on from its last page', run: loopPhotoTurns},
  {name: 'page turns: the page cache stays under its pixel and count limits, never evicts what is on screen or being drawn, and empties what leaves', run: loopCacheLimit},
];

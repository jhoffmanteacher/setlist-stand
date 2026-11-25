/*
 * Ready loops (2026-11-25): "Play the setlist" draws every page of the setlist in the background and keeps each as a small picture
 * (js/prerender.js), so a turn onto a page that was not next to the one showing no longer waits for pdf.js. Checked in the real app, in
 * a real setlist, through what the app PRODUCES: the pdf.js calls themselves (a spy counts every document opened and closed and every
 * page drawn), the pictures it keeps (compared with the same page drawn fresh), the text of the "Ready 7 of 25" line, and the page
 * on the stage after each turn.
 *
 *   a  Play: every page of the setlist is kept, "Ready N of M" runs up to "All ready" and goes, the page line is untouched, one
 *      pdf.js document is open at a time and none is left open
 *   b  the turns that follow draw nothing (no pdf.js render) and show the right pages; a kept page equals the page drawn fresh;
 *      with `ss-ready` = '0' the same walk draws every page again (the control: the spy sees what it should)
 *   c  it works only while the person does not: a tap, Annotate, a dialog and a hidden page each stop it, and it goes on after
 *   d  the limit, closing the viewer, a resize and the Two pages switch: the pictures go, and come back at the new size
 *   e  a song that will not open is left out and the rest is done; a single song gets no pass
 *   f  a tap while a page is being drawn cancels that page
 *   g  a crop edited while pictures are kept: the pictures of the new crop are used, never the old ones
 *   h  on a retina screen (deviceScaleFactor 2) the kept pages are the right size, and the page on the stage after a turn is the page drawn fresh
 */
import path from 'node:path';
import fs from 'node:fs';
import {TMP, assert, sleep, PDFDocument} from './harness.mjs';
import {makePhotoPdfs, cropSongs} from './photo-pdf.mjs';

/* ---- in the page, before anything runs: a spy on pdf.js and a log of what the "Ready" line says ---- */
const spyScript = () => {
  window.__pdf = {open: 0, opened: 0, max: 0, renders: 0};
  let lib;
  Object.defineProperty(window, 'pdfjsLib', {configurable: true, get(){ return lib; }, set(v){
    if(!v || v.noEval || typeof v.getDocument !== 'function'){ lib = v; return; }
    const real = v.getDocument;
    lib = Object.create(v, {getDocument: {value: src => {
      const t = real.call(v, src);
      let doc0 = null, closed = false;
      const closeOnce = () => { if(doc0 && !closed){ closed = true; window.__pdf.open--; } };        // closed through the document or through the loading task: either counts once
      const p = t.promise.then(doc => {
        const S = window.__pdf; doc0 = doc; S.open++; S.opened++; S.max = Math.max(S.max, S.open);
        const d0 = doc.destroy.bind(doc);
        doc.destroy = (...a) => { closeOnce(); return d0(...a); };
        const g0 = doc.getPage.bind(doc);
        doc.getPage = async n => { const pg = await g0(n); if(!pg.__spy){ const r0 = pg.render.bind(pg); pg.render = (...a) => { window.__pdf.renders++; return r0(...a); }; pg.__spy = true; } return pg; };
        return doc;
      });
      return new Proxy(t, {get(o, k){
        if(k === 'promise') return p;
        if(k === 'destroy') return (...a) => { closeOnce(); return o.destroy(...a); };
        const x = o[k]; return typeof x === 'function' ? x.bind(o) : x;
      }});
    }}});
  }});
  window.__ready = [];
  new MutationObserver(() => {
    const el = document.getElementById('vReady'); if(!el) return;
    const t = el.hidden ? '' : el.textContent, L = window.__ready;
    if(L[L.length - 1] !== t) L.push(t);
  }).observe(document, {subtree: true, childList: true, characterData: true, attributes: true});
};
const fast = (page, extra = {}) => page.evaluate(async x => { const m = await import('./js/prerender.js'); Object.assign(m.TUNE, {idle: 60, tick: 30, kick: 150, hide: 700, gap: 0}, x); }, extra);
const state = page => page.evaluate(async () => { const m = await import('./js/prerender.js'); const s = m.readyState(); return {snaps: s.snaps, bytes: s.bytes, running: s.running, live: s.live, cancels: s.cancels, drawing: s.drawing, failed: s.failed, shown: s.shown, keys: s.keys}; });
const pdfStats = page => page.evaluate(() => ({...window.__pdf}));
const vState = page => page.evaluate(async () => { const {V} = await import('./js/viewer.js'); return {qi: V.qi, page: V.page, per: V.per, prep: V.prep.size, doc: !!V.doc, title: document.querySelector('#vTitle').textContent, sub: document.querySelector('#vSub').textContent}; });
async function waitFor(fn, what, ms = 20000){
  const end = Date.now() + ms; let v;
  while(Date.now() < end){ v = await fn(); if(v) return v; await sleep(50); }
  throw new Error(typeof what === 'function' ? await what() : what);
}
/* until the pass has kept `n` pages and stopped */
const kept = (page, n, ms = 30000) => waitFor(async () => { const s = await state(page); return s.snaps >= n && !s.running ? s : null; }, async () => `the pass kept ${(await state(page)).snaps} of ${n} pages: ${JSON.stringify((await state(page)).shown)}`, ms);

/* ---- the library and the setlist ---- */
async function textPdfs(names, pages){
  const out = [];
  for(const n of names){
    const doc = await PDFDocument.create(), font = await doc.embedFont('Helvetica-Bold');
    for(let p = 1; p <= pages; p++) doc.addPage([612, 792]).drawText(`${n} page ${p}`, {x: 60, y: 700, size: 40, font});
    const f = path.join(TMP, `${n} ready.pdf`); fs.writeFileSync(f, await doc.save()); out.push(f);
  }
  return out;
}
async function addPdfs(page, files){
  for(const [i, f] of files.entries()){
    await page.setInputFiles('#file', f);
    await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, i + 1, {timeout: 30000});
  }
}
/* A setlist of the named songs (in order); `brk`: put a break after that many songs. Leaves the Setlists screen with the set open. */
async function makeSet(page, name, titles, brk = 0){
  await page.click('#tSets'); await page.click('#view [data-newset]');
  await page.locator('.modal input[type=text]').fill(name);
  await page.click('.modal [data-ok]');
  await page.waitForFunction(n => document.querySelector('#view h2')?.textContent === n, name);
  const rows = () => page.locator('#items > li.row').count();
  const add = async t => {
    await sleep(450);
    const n0 = await rows();
    await page.click('#view [data-addto]');
    await page.locator('.modal .pick').waitFor();
    await page.locator('.modal .pick label', {hasText: new RegExp('^' + t)}).locator('input').check();
    await page.click('.modal [data-ok]');
    await page.waitForFunction(k => document.querySelectorAll('#items > li.row').length === k, n0 + 1, {timeout: 5000});
  };
  for(const [i, t] of titles.entries()){
    await add(t);
    if(brk && i + 1 === brk){ const n0 = await rows(); await page.click('#view [data-addbreak]'); await page.waitForFunction(k => document.querySelectorAll('#items > li.row').length === k, n0 + 1, {timeout: 5000}); }
  }
}
const play = async page => { await page.click('#view [data-play]'); await page.waitForSelector('#viewer.on #stage .sheet canvas'); await page.evaluate(() => document.querySelector('#viewer').classList.remove('hide')); };
async function session(ctx, {off = false, viewport, dsf} = {}){
  const s = await ctx.session({serviceWorkers: 'block', ...(viewport ? {viewport} : {}), ...(dsf ? {deviceScaleFactor: dsf} : {})});
  await s.page.addInitScript(spyScript);
  if(off) await s.page.addInitScript(() => { try{ localStorage.setItem('ss-ready', '0'); }catch(e){} });
  return s;
}
const NAMES = ['Alpha', 'Bravo', 'Charlie'];
/* Alpha, Bravo, (break), Charlie, 3 pages each: 9 pages */
async function textSet(ctx, opts){
  const s = await session(ctx, opts), {page} = s;
  await s.goto();
  await addPdfs(page, await textPdfs(NAMES, 3));
  await makeSet(page, 'Ready set', NAMES, 2);
  await fast(page);
  return s;
}

/* The page on show's kept pictures (pages 1 and 2) against the same pages drawn fresh with the song's own crop, and page 1's picture against page 2 drawn fresh. In the page, on the song showing. */
const fidelity = page => page.evaluate(async () => {
  const pre = await import('./js/prerender.js'), vw = await import('./js/viewer.js'), st = await import('./js/store.js'), {V} = vw;
  const FULL = {x: 0, y: 0, w: 1, h: 1};
  const cropKey = pn => { const c = st.cropOf(V.song, pn) || FULL; return [c.x, c.y, c.w, c.h].join(','); };
  const key = pn => pre.readyState().keys.find(k => k.startsWith(V.id + '|' + pn + '|') && k.endsWith('|' + cropKey(pn)));      // the picture made for the crop the song has NOW
  const small = cv => { const c = document.createElement('canvas'); c.width = 96; c.height = 76; const x = c.getContext('2d'); x.drawImage(cv, 0, 0, 96, 76); return x.getImageData(0, 0, 96, 76).data; };
  const diff = (a, b) => { let t = 0; for(let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]); return t / a.length; };
  const [W, H] = key(1).split('|')[2].split('@')[0].split('x').map(Number);
  const snap = [await pre.snapCanvas(pre.snapOf(key(1))), await pre.snapCanvas(pre.snapOf(key(2)))];
  const fresh = [(await vw.paintPage(V.doc, 1, W, H, st.cropOf(V.song, 1) || FULL)).cv, (await vw.paintPage(V.doc, 2, W, H, st.cropOf(V.song, 2) || FULL)).cv];
  const r = {same1: diff(small(snap[0]), small(fresh[0])), same2: diff(small(snap[1]), small(fresh[1])), cross: diff(small(snap[0]), small(fresh[1])), size: [snap[0].width, snap[0].height, fresh[0].width, fresh[0].height]};
  for(const c of [...snap, ...fresh]) c.width = c.height = 0;
  return r;
});

/* The page on the stage against the same page drawn fresh (same size, same crop), and its CSS size against the canvas size / pixel ratio. In the page, on the song showing. */
const stageMatches = page => page.evaluate(async () => {
  const pre = await import('./js/prerender.js'), vw = await import('./js/viewer.js'), st = await import('./js/store.js'), {V} = vw;
  const FULL = {x: 0, y: 0, w: 1, h: 1}, c = st.cropOf(V.song, V.page) || FULL, suffix = [c.x, c.y, c.w, c.h].join(',');
  const key = pre.readyState().keys.find(k => k.startsWith(V.id + '|' + V.page + '|') && k.endsWith('|' + suffix));
  const [W, H] = key.split('|')[2].split('@')[0].split('x').map(Number), dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const small = cv => { const x = document.createElement('canvas'); x.width = 96; x.height = 76; const g = x.getContext('2d'); g.drawImage(cv, 0, 0, 96, 76); return g.getImageData(0, 0, 96, 76).data; };
  const diff = (a, b) => { let t = 0; for(let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]); return t / a.length; };
  const cv = document.querySelector('#stage .sheet canvas:not(.ink)'), sheet = cv.parentElement;
  const fresh = await vw.paintPage(V.doc, V.page, W, H, c);
  const r = {diff: diff(small(cv), small(fresh.cv)), cssW: parseFloat(sheet.style.width), canvasW: cv.width, freshW: fresh.cv.width, dpr};
  fresh.cv.width = fresh.cv.height = 0;
  return r;
});

const PHOTOS = ['Photo One', 'Photo Two', 'Photo Three', 'Photo Four', 'Photo Five'];
/* Three scanned songs of two pages (the LAST one cropped: the song next to the first is drawn by the normal prefetch before the pass starts, so only a later song shows whether the pass keeps crops right), a setlist of them, "Two pages" as the app has it (on). big: larger scans, so a page takes longer. */
async function photoSet(ctx, opts = {}){
  const names = PHOTOS.slice(0, opts.songs || 3);
  const s = await session(ctx, opts), {page} = s;
  await s.goto();
  const dir = path.join(TMP, 'ready-photos-' + Math.random().toString(36).slice(2, 7));
  await addPdfs(page, await makePhotoPdfs(page, dir, names.map(f => ({file: f, label: f})), {pages: 2, size: opts.big ? [2600, 2100] : [1500, 1200], quality: 0.7}));
  await cropSongs(page, [names[names.length - 1]]);
  await makeSet(page, 'Photo set', names);
  await fast(page);
  return s;
}

export const loops = [
{
  name: 'ready a: Play keeps every page of the setlist: "Ready N of M" runs up to "All ready" and goes, one document is open at a time and none is left open',
  async run(ctx){
    const s = await textSet(ctx), {page} = s;
    try{
      await play(page);
      const st = await kept(page, 9);
      assert(st.snaps === 9, `the pass kept ${st.snaps} pages, want 9 (three songs of three pages)`);
      assert(st.bytes > 0 && st.failed === 0, `bytes ${st.bytes}, failed ${st.failed}`);
      assert(st.live === 0, `the pass still holds ${st.live} canvases once it is done (each is emptied the moment its picture is made)`);
      /* the order the pages were kept in: the rest of the song showing, then each later song, page by page */
      const order = await page.evaluate(async () => { const st = await import('./js/store.js'), m = await import('./js/prerender.js'); return m.readyState().keys.map(k => { const [id, pn] = k.split('|'); return st.state.songs.find(x => x.id === id).title.split(' ')[0] + ' ' + pn; }); });
      assert(order.join() === 'Alpha 1,Alpha 2,Alpha 3,Bravo 1,Bravo 2,Bravo 3,Charlie 1,Charlie 2,Charlie 3', 'the pages were kept in this order: ' + order.join());
      /* the line */
      await waitFor(async () => (await page.evaluate(() => window.__ready)).slice(-1)[0] === '', 'the "Ready" line never went away', 8000);
      const said = await page.evaluate(() => window.__ready);
      assert(said.some(t => /^Ready \d+ of 9$/.test(t)), 'the line never said "Ready N of 9": ' + JSON.stringify(said));
      assert(said.includes('All ready'), 'the line never said "All ready": ' + JSON.stringify(said));
      assert(said.every(t => t === '' || /^(Ready \d+ of 9|All ready)$/.test(t)), 'the line said something else: ' + JSON.stringify(said));
      /* the page line the other loops read is untouched */
      const v = await vState(page);
      assert(v.sub === 'Song 1 of 3 · Page 1–2 of 3' || v.sub === 'Song 1 of 3 · Page 1 of 3', `the page line says "${v.sub}"`);
      /* documents: the pass opens one at a time and closes it; only the viewer's own stay open */
      await sleep(500);
      const d = await pdfStats(page), now = await vState(page);
      assert(d.open === 1 + now.prep, `${d.open} pdf.js documents are open, the viewer holds ${1 + now.prep} (the one showing and ${now.prep} prepared): the pass left one open`);
      assert(d.max <= 3 + 1, `up to ${d.max} documents were open at once`);
      /* a turn later, with everything kept: the line stays away (a pass with nothing to do says nothing) */
      const n0 = (await page.evaluate(() => window.__ready)).length;
      await page.keyboard.press('ArrowRight'); await sleep(2500);
      const after = (await page.evaluate(() => window.__ready)).slice(n0);
      assert(!after.length, 'the "Ready" line came back after a turn with everything already kept: ' + JSON.stringify(after));
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
  }
},
{
  name: 'ready b: the turns that follow draw nothing and show the right pages; a kept page equals the page drawn fresh; with ss-ready=0 the same turns draw again',
  async run(ctx){
    const s = await photoSet(ctx), {page} = s;
    try{
      await play(page); await kept(page, 6);
      /* a kept page against the same page drawn fresh (the JPEG costs a little, never the page), and against ANOTHER page (so "equal" means something) */
      const f = await fidelity(page);
      assert(f.size[0] === f.size[2] && f.size[1] === f.size[3], `a kept page is ${f.size[0]}x${f.size[1]}, the page drawn fresh ${f.size[2]}x${f.size[3]}`);
      assert(f.same1 < 4 && f.same2 < 4, `a kept page differs from the page drawn fresh by ${f.same1.toFixed(2)} and ${f.same2.toFixed(2)} (of 255) on average, want under 4`);
      assert(f.cross > 3 * Math.max(f.same1, f.same2, 1), `a kept page differs from ANOTHER page by only ${f.cross.toFixed(2)} (against ${Math.max(f.same1, f.same2).toFixed(2)} from its own): the comparison cannot tell pages apart`);
      /* the turns: forward through the songs and back; the last song has a crop, so its pages are kept cropped */
      await page.evaluate(() => { window.__pdf.renders = 0; });
      const seen = [];
      for(const key of ['ArrowRight', 'ArrowRight']){
        await page.keyboard.press(key); await sleep(500);
        seen.push((await vState(page)).title);
      }
      const d = await pdfStats(page);
      assert(d.renders === 0, `${d.renders} pages were drawn by pdf.js during turns that every page of was already kept for`);
      const sm = await stageMatches(page);
      assert(sm.diff < 4 && Math.abs(sm.cssW - sm.canvasW / sm.dpr) <= 1.5, `the page on the stage after the turns differs from the page drawn fresh by ${sm.diff.toFixed(2)} (of 255) and is ${sm.cssW} CSS px wide for a ${sm.canvasW}px canvas at ${sm.dpr}x`);
      /* the last song is cropped: its kept pages are the cropped pages, equal to the pages drawn fresh with that crop */
      const f3 = await fidelity(page);
      assert(f3.same1 < 4 && f3.same2 < 4, `the CROPPED song's kept pages differ from the pages drawn fresh by ${f3.same1.toFixed(2)} and ${f3.same2.toFixed(2)} (of 255) on average, want under 4`);
      for(const key of ['ArrowLeft', 'ArrowLeft']){
        await page.keyboard.press(key); await sleep(500);
        seen.push((await vState(page)).title);
      }
      assert(seen.join(' > ') === 'Photo Two > Photo Three > Photo Two > Photo One', 'the turns showed ' + seen.join(' > '));
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
    /* the control: switched off, nothing is kept and the same turns DO draw (so the spy above sees what it should) */
    const c = await photoSet(ctx, {off: true});
    try{
      await play(c.page); await sleep(2500);
      const st = await state(c.page);
      assert(st.snaps === 0 && !st.running, `ss-ready=0 and the pass kept ${st.snaps} pages (running ${st.running})`);
      assert(await c.page.evaluate(() => document.getElementById('vReady').hidden), 'the "Ready" line shows with ss-ready=0');
      await c.page.evaluate(() => { window.__pdf.renders = 0; });
      for(const key of ['ArrowRight', 'ArrowRight']){ await c.page.keyboard.press(key); await sleep(700); }
      assert((await pdfStats(c.page)).renders >= 1, 'with ss-ready=0 the turns drew nothing: the spy sees no pdf.js renders, so the check above proves nothing');
    } finally { await c.close(); }
  }
},
{
  name: 'ready c: it works only while the person does not: Annotate, a dialog, a hidden page and a tap each stop it, and it goes on after',
  async run(ctx){
    const s = await photoSet(ctx, {songs: 5}), {page} = s;      // ten pages
    /* Timings (measured: a page takes 130 to 430 ms to keep). A rest of 700 ms follows every page, and the wait after a touch is 2500 ms, so with the person's
       action noticed the next page comes at least 2.6 s later, and without it about 1.1 s later: a window of 1.8 s tells the two apart, and ten pages
       leave work for every step. */
    const touch = () => page.evaluate(async () => (await import('./js/prerender.js')).touch());
    const chrome = () => page.evaluate(() => document.querySelector('#viewer').classList.remove('hide'));      // the tap below hid the top bar
    const snaps = async () => (await state(page)).snaps;
    /* waits until a page has JUST been kept (the pass is now resting 700 ms before the next), runs `act`, and then nothing may be kept for
       1800 ms: with the person's action noticed the next page waits 2500 ms after it; without, it would start 700 ms after the last */
    const quiet = async (what, act) => {
      const n = await snaps();
      await waitFor(async () => (await snaps()) > n, 'the pass never kept another page', 15000);
      const t0 = await snaps();
      assert(t0 < 6, `test setup: the pass had finished before ${what}`);
      await act();
      await sleep(80);
      const t1 = await snaps();
      await sleep(1800);
      assert((await snaps()) === t1, `the pass kept a page within 1.9 s of ${what}`);
    };
    /* a condition is applied, the pass is touched, and once the wait after the touch is over nothing may be kept for 1.5 s */
    const stays = async (what, apply, release) => {
      await chrome(); await apply(); await touch();
      await sleep(3000);                                           // the wait after the touch is over; a page being drawn has finished
      const a = await snaps();
      assert(a < 6, `test setup: the pass had finished before "${what}"`);
      const seen = [];
      for(let i = 0; i < 6; i++){ await sleep(250); const x = await state(page); seen.push(`${x.snaps}${x.running ? 'r' : ''}`); }
      assert(seen.every(x => parseInt(x) === a), `the pass kept pages while ${what} (kept pages over 1.5 s, from ${a}: ${seen.join(' ')})`);
      await release();
    };
    try{
      await fast(page, {idle: 2500, kick: 100, gap: 700});
      await play(page);
      await waitFor(async () => (await snaps()) >= 1, 'the pass never kept a page', 15000);
      await quiet('a tap', () => page.mouse.click(640, 400));
      await quiet('a page turn', () => page.keyboard.press('ArrowRight'));
      await quiet('a redraw (what the Crop screen and a resize do)', () => page.evaluate(async () => (await import('./js/viewer.js')).draw()));
      await waitFor(() => page.evaluate(async () => !(await import('./js/viewer.js')).V.busy), 'the turn never finished', 10000);      // a title tap during a turn does nothing
      await stays('a dialog was open', async () => { await page.click('#vTitle'); await page.locator('.modal').waitFor(); }, async () => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.modal')); });
      await stays('a turn was under way', () => page.evaluate(async () => { (await import('./js/viewer.js')).V.busy = true; }), () => page.evaluate(async () => { (await import('./js/viewer.js')).V.busy = false; }));
      await stays('Annotate was on', () => page.click('#vAnn'), () => page.click('#tDone'));
      await stays('the Crop screen was open', () => page.click('#vCrop'), async () => { await page.click('#cropCancel'); await page.waitForFunction(() => document.querySelector('#cropper').hidden); });
      await stays('the page was hidden', () => page.evaluate(() => Object.defineProperty(document, 'hidden', {configurable: true, get: () => true})), () => page.evaluate(() => { delete document.hidden; }));
      await fast(page, {idle: 60, gap: 0});
      await kept(page, 10);
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
  }
},
{
  name: 'ready d: the size limit stops it, closing the viewer, a resize and the Two pages switch let the pictures go, and they come back at the new size',
  async run(ctx){
    const s = await photoSet(ctx), {page} = s;
    try{
      await fast(page, {max: 1, hide: 5000});
      await play(page);
      await kept(page, 1);
      await sleep(600);
      let st = await state(page);
      assert(st.snaps === 1, `with the limit at 1 byte the pass kept ${st.snaps} pages, want 1`);
      assert(/^Ready 1 of 6$/.test(await page.evaluate(() => document.getElementById('vReady').textContent)), 'the line does not say "Ready 1 of 6" when the limit stopped it');
      /* the limit lifted; a turn and back starts it again */
      await fast(page, {max: 1e9, hide: 700});
      await page.keyboard.press('ArrowRight'); await sleep(500); await page.keyboard.press('ArrowLeft');
      await kept(page, 6);
      /* closing the viewer lets everything go */
      await page.click('#vBack'); await sleep(600);
      st = await state(page);
      assert(st.snaps === 0 && st.bytes === 0 && !st.running, `after Back: ${st.snaps} pictures kept, ${st.bytes} bytes, running ${st.running}`);
      assert(await page.evaluate(() => document.getElementById('vReady').hidden), 'the "Ready" line is still showing after Back');
      assert((await pdfStats(page)).open === 0, `${(await pdfStats(page)).open} pdf.js documents are open after Back`);
      /* a resize: the pictures are made again at the new size */
      await play(page); await kept(page, 6);
      const sizeOf = keys => [...new Set(keys.map(k => k.split('|')[2]))].join();
      const before = sizeOf((await state(page)).keys);
      await page.setViewportSize({width: 1100, height: 760});
      await waitFor(async () => { const x = await state(page); return x.snaps === 6 && !x.running && sizeOf(x.keys) !== before ? x : null; }, async () => `after a resize the pictures are ${sizeOf((await state(page)).keys)} (${(await state(page)).snaps} kept), were ${before}`, 25000);
      /* the Two pages switch */
      const was = sizeOf((await state(page)).keys);
      await page.click('#v2up');
      await waitFor(async () => { const x = await state(page); return x.snaps === 6 && !x.running && sizeOf(x.keys) !== was ? x : null; }, async () => `after Two pages the pictures are ${sizeOf((await state(page)).keys)}, were ${was}`, 25000);
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
  }
},
{
  name: 'ready e: a song that will not open is left out and the rest is done; a single song gets no pass',
  async run(ctx){
    const s = await photoSet(ctx), {page} = s;
    try{
      /* song two's stored PDF becomes rubbish (the file is damaged) */
      await page.evaluate(async () => {
        const st = await import('./js/store.js'), id = st.state.songs.find(x => x.title === 'Photo Two').id;
        const three = st.state.songs.find(x => x.title === 'Photo Three'); three.pages = 3; await st.saveSong(three);      // the record says three pages, the PDF has two: page 3 will not draw
        await new Promise((ok, no) => { const r = indexedDB.open('setlist-stand'); r.onerror = () => no(r.error); r.onsuccess = () => { const d = r.result, tx = d.transaction('files', 'readwrite'); tx.objectStore('files').put(new Blob(['this is not a pdf']), id); tx.oncomplete = () => { d.close(); ok(); }; tx.onerror = () => no(tx.error); }; });
      });
      await play(page);
      const st = await kept(page, 4);
      assert(st.snaps === 4 && st.failed >= 2, `kept ${st.snaps} pages with ${st.failed} failures; want the 4 pages of the two good songs, a song that will not open and a page that will not draw left out`);
      await waitFor(async () => (await page.evaluate(() => window.__ready)).includes('All ready'), 'the line never said "All ready" with one song left out', 8000);
      /* "All ready" is only said when what is kept equals what is counted: so the pages of the song that will not open, and the page that will not draw, were left out of the count */
      await page.keyboard.press('ArrowRight'); await sleep(900);
      assert((await vState(page)).title === 'Photo Two' && await page.locator('#stage .badpage').count() === 1, 'the song that will not open does not show the placeholder page');
      await page.keyboard.press('ArrowRight'); await sleep(900);
      assert((await vState(page)).title === 'Photo Three', 'the turn did not go on past the song that will not open');
      /* a single song opened from the Library: nothing is done ahead */
      await page.click('#vBack'); await page.click('#tLib');
      await page.locator('#libList [data-open]', {hasText: 'Photo One'}).click();
      await page.waitForSelector('#viewer.on #stage .sheet canvas'); await sleep(2000);
      const one = await state(page);
      assert(one.snaps === 0 && !one.running, `a single song kept ${one.snaps} pictures (running ${one.running})`);
    } finally { await s.close(); }
  }
},
{
  name: 'ready f: the pass never draws while the viewer is drawing, and a tap while a page is being drawn cancels that page',
  async run(ctx){
    const s = await photoSet(ctx, {big: true, songs: 5}), {page} = s;
    try{
      await fast(page, {idle: 60, kick: 100, gap: 0});
      await play(page);
      /* the viewer's own pages (the one showing, the spread ahead, the next song) are drawn first; the pass waits for them */
      const overlap = await page.evaluate(async () => {
        const {V} = await import('./js/viewer.js'), pre = await import('./js/prerender.js');
        let hit = 0, looks = 0; const end = Date.now() + 2500;
        while(Date.now() < end){ looks++; const own = [...V.cache.keys()].some(k => !V.cache.settled.has(k)); if(pre.readyState().drawing && own) hit++; await new Promise(r => setTimeout(r, 8)); }
        return {hit, looks};
      });
      assert(overlap.hit === 0, `the pass was drawing a page while the viewer was drawing its own, ${overlap.hit} times in ${overlap.looks} looks`);
      let cancelled = 0;
      for(let attempt = 0; attempt < 4 && !cancelled; attempt++){
        await waitFor(async () => (await state(page)).drawing, 'the pass never had a page under way', 15000);
        await page.mouse.click(640, 400);
        await sleep(300);
        cancelled = (await state(page)).cancels;
      }
      assert(cancelled >= 1, 'a tap while a page was being drawn did not cancel it (pdf.js kept drawing a page nobody is waiting for)');
      await page.evaluate(() => document.querySelector('#viewer').classList.remove('hide'));
      await kept(page, 10);
      assert((await state(page)).live === 0, 'a canvas is still held after the pass');
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
  }
},
{
  name: 'ready g: a crop edited while pictures are kept: the pictures of the new crop are used, never the old ones',
  async run(ctx){
    const s = await photoSet(ctx), {page} = s;
    try{
      await play(page); await kept(page, 6);
      /* Photo Two gets a crop, as the Crop screen would store it, and the viewer redraws (js/crop.js does both) */
      await cropSongs(page, ['Photo Two'], {x: .25, y: .2, w: .5, h: .6});
      await page.evaluate(async () => (await import('./js/viewer.js')).draw());
      await waitFor(async () => { const x = await state(page); return !x.running && x.keys.filter(k => k.endsWith('|0.25,0.2,0.5,0.6')).length === 2 ? x : null; }, async () => `the pictures for the new crop were never made: ${JSON.stringify((await state(page)).keys)}`, 20000);
      const after = await state(page);
      assert(after.snaps === 6, `after the crop edit ${after.snaps} pictures are kept, want 6: the pictures of the old crop were not let go`);
      await page.evaluate(() => { window.__pdf.renders = 0; });
      await page.keyboard.press('ArrowRight'); await sleep(700);
      assert((await vState(page)).title === 'Photo Two', 'the turn did not reach Photo Two');
      assert((await pdfStats(page)).renders === 0, 'the turn into the song with the new crop drew with pdf.js: the pictures made for the new crop were not used');
      const f = await fidelity(page);
      assert(f.same1 < 4 && f.same2 < 4, `with a new crop the page on show differs from the page drawn fresh by ${f.same1.toFixed(2)} and ${f.same2.toFixed(2)} (of 255): a picture of the OLD crop was used`);
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
  }
},
{
  name: 'ready h: on a retina screen the kept pages are the right size and the page on the stage after a turn is the page drawn fresh',
  async run(ctx){
    const s = await photoSet(ctx, {dsf: 2}), {page} = s;
    try{
      await play(page); await kept(page, 6);
      const f = await fidelity(page);
      assert(f.size[0] === f.size[2] && f.size[1] === f.size[3], `at 2x a kept page is ${f.size[0]}x${f.size[1]}, the page drawn fresh ${f.size[2]}x${f.size[3]}`);
      assert(f.same1 < 4 && f.same2 < 4, `at 2x a kept page differs from the page drawn fresh by ${f.same1.toFixed(2)} and ${f.same2.toFixed(2)} (of 255)`);
      await page.evaluate(() => { window.__pdf.renders = 0; });
      for(const t of ['Photo Two', 'Photo Three']){
        await page.keyboard.press('ArrowRight'); await sleep(600);
        assert((await vState(page)).title === t, 'the turn did not reach ' + t);
        const sm = await stageMatches(page);
        assert(sm.dpr === 2, 'test setup: the pixel ratio is ' + sm.dpr);
        assert(sm.canvasW === sm.freshW, `${t}: the canvas on the stage is ${sm.canvasW}px wide, drawn fresh ${sm.freshW}px`);
        assert(Math.abs(sm.cssW - sm.canvasW / 2) <= 1.5, `${t}: the page is ${sm.cssW} CSS px wide for a ${sm.canvasW}px canvas at 2x (a kept page's size taken for its CSS size)`);
        assert(sm.diff < 4, `${t}: the page on the stage differs from the page drawn fresh by ${sm.diff.toFixed(2)} (of 255)`);
      }
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
  }
},
];

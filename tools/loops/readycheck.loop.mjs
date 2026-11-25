/*
 * "Ready for the gig" loops (2026-11-23): the setlist's ready check (js/readycheck.js readyCheck), the "Works offline" line
 * (js/boot.js ssBoot.offline() -> js/readycheck.js readyLine) and the "did not start" box (js/boot.js, js/main.js started()).
 *
 * What is closed here:
 * - ready check: the charts are put into the library through the app's own Add PDFs, then broken behind its back in IndexedDB
 *   (a PDF deleted, a PDF's bytes replaced by junk). The rows and the last line the check PRODUCES are compared with what was
 *   done to the stored files, the page counts with the fixtures' own page counts (pdf-lib in node), and the whole database
 *   (snapshot) before and after (it writes nothing). pdf.js workers are counted at the browser's Worker constructor: every
 *   chart opened is a worker started, and every one is ended when the check is over (stopped or not). One case cuts the
 *   network first (the gig): the server must see no request at all while the check runs.
 * - offline line: the real service worker's answer to js/boot.js's refill request; a file deleted from the offline copy and
 *   answered 404 by the server makes the line say "incomplete", the file served again makes it say "Works offline." and
 *   the file is back in the cache. The line element is drawn once and must change IN PLACE (no redraw by the screen).
 * - did not start: js/main.js served broken (a syntax error, the way update g2 plants it): the box shows after about 8 s
 *   with a Reload button, does not cover the "Updated. Tap to reload" banner, and Reload with the good file starts the app
 *   and hides the box. main.js served late (10 s): the box shows, then goes away by itself when the app starts.
 *
 * js/readycheck.js is imported by the test (the lead wires it into the setlist's More menu and the Library). Until then
 * it is in sw.js PRECACHE, so it is imported BEFORE the network is cut.
 */
import fs from 'node:fs';
import path from 'node:path';
import {FIX, assert, sleep, snapshot, diff, PDFDocument} from './harness.mjs';
import {makeSiteCopy, removeCopy, askUpdate, swState, missing404, goOffline, cacheName, precachePaths, waitInstalled, intercept, until} from './site-copy.mjs';

const pagesOf = async f => (await PDFDocument.load(fs.readFileSync(path.join(FIX, f)))).getPageCount();

/* Counts pdf.js workers from the first script on: made, and still running (not terminated). `delay` (ms) holds back every
   message the page sends a worker, so a check takes long enough to be stopped half-way. */
const countWorkers = (context, delay = 0) => context.addInitScript(delay => {
  const W = window.Worker; if(!W) return;
  let made = 0, live = 0;
  window.Worker = class extends W {
    constructor(...a){ super(...a); made++; live++; this.__on = true; }
    terminate(){ if(this.__on){ this.__on = false; live--; } return super.terminate(); }
    postMessage(...a){ if(delay) setTimeout(() => { if(this.__on) super.postMessage(...a); }, delay); else super.postMessage(...a); }
  };
  window.__workers = () => ({made, live});
}, delay);
const workers = page => page.evaluate(() => window.__workers());

/* Add the three fixtures through Add PDFs; returns {one, two, three} song ids (by page count). */
async function addThree(page){
  await page.setInputFiles('#file', ['one-page.pdf', 'two-page.pdf', 'three-page.pdf'].map(f => path.join(FIX, f)));
  await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 3, null, {timeout: 20000});
  const songs = await page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('setlist-stand'); r.onerror = () => rej(r.error);
    r.onsuccess = () => { const q = r.result.transaction('songs').objectStore('songs').getAll(); q.onsuccess = () => { r.result.close(); res(q.result); }; };
  }));
  const by = n => songs.find(s => s.pages === n && !s.deleted);
  assert(by(1) && by(2) && by(3), 'test setup: the three fixtures are not in the library: ' + JSON.stringify(songs.map(s => [s.title, s.pages])));
  return {one: by(1), two: by(2), three: by(3)};
}
/* Raw IndexedDB writes (no app code): op 'set' puts a set record, 'drop' deletes a stored PDF, 'junk' replaces one with bytes
   that are not a PDF pdf.js can open. */
const idb = (page, op, arg) => page.evaluate(([op, arg]) => new Promise((res, rej) => {
  const r = indexedDB.open('setlist-stand'); r.onerror = () => rej(r.error);
  r.onsuccess = () => {
    const d = r.result, t = d.transaction(op === 'set' ? 'sets' : 'files', 'readwrite'), st = t.objectStore(op === 'set' ? 'sets' : 'files');
    if(op === 'set') st.put(arg, arg.id);
    else if(op === 'drop') st.delete(arg);
    else st.put(new Blob(['%PDF-1.4 this is not a chart ' + 'x'.repeat(500)], {type: 'application/pdf'}), arg);
    t.oncomplete = () => { d.close(); res(); }; t.onerror = () => rej(t.error);
  };
}), [op, arg]);
const putSet = (page, set) => idb(page, 'set', set);
const dropFile = (page, id) => idb(page, 'drop', id);
const junkFile = (page, id) => idb(page, 'junk', id);

const setOf = (ids, name = 'Friday gig') => ({id: 'rcset' + Date.now().toString(36), name, colls: [], created: Date.now(), updated: Date.now(),
  items: ids.map((id, i) => id === 'break' ? {type: 'break', id: 'rcbrk' + i, name: 'Set break'} : {type: 'song', id})});
const importCheck = page => page.evaluate(async () => { window.__rc = await import(new URL('js/readycheck.js', location.href).href); });
/* Opens the check for set `id` (as the lead's More menu item will); the promise it returns is kept in window.__rcDone. */
const startCheck = (page, id) => page.evaluate(id => { window.__rcDone = null; window.__rc.readyCheck(id).then(r => { window.__rcDone = r; }); }, id);
const readBox = page => page.evaluate(() => {
  const m = document.querySelector('.modal'); if(!m) return null;
  return {title: m.querySelector('h2')?.textContent, status: m.querySelector('[data-rcstatus]')?.textContent || '',
    rows: [...m.querySelectorAll('[data-rc]')].map(li => ({state: li.dataset.rc, t: li.querySelector('.t').textContent, s: li.querySelector('.s').textContent})),
    button: m.querySelector('[data-x]')?.textContent, role: m.querySelector('[role=dialog]') ? 'dialog' : null};
});
const finished = page => until(async () => (await readBox(page))?.button === 'Close', 'the ready check did not finish (no Close button)', 30000);
async function closeBox(page){
  await page.keyboard.press('Escape');      // Escape presses the box's [data-x]: Close once it has finished
  await until(() => page.evaluate(() => !document.querySelector('.modal') && !!window.__rcDone), 'Escape did not close the finished ready check', 5000);
  return page.evaluate(() => window.__rcDone);
}
const textOf = page => page.evaluate(() => document.querySelector('#nostart:not([hidden])')?.textContent || null);
const boxShown = page => page.evaluate(() => { const b = document.querySelector('#nostart'); return !!b && !b.hidden && b.getBoundingClientRect().height > 0; });

export const loops = [
{
  name: 'readycheck 1: every chart opens with the network cut: "All 3 charts are ready.", page counts right, nothing written, every worker ended',
  async run(ctx){
    const s = await ctx.session();
    await countWorkers(s.context);
    let online = null;
    try{
      const {page} = s;
      await s.goto();
      await waitInstalled(page, cacheName(ctx.root), precachePaths(ctx.root));
      await page.reload(); await page.waitForSelector('#libList');
      const {one, two, three} = await addThree(page);
      const set = setOf([three.id, 'break', one.id, three.id, two.id]);      // a song twice and a break: three distinct charts
      await putSet(page, set);
      await page.reload(); await page.waitForSelector('#libList [data-open]');
      await importCheck(page);
      const before = await snapshot(page), w0 = await workers(page);
      online = await goOffline(s.context, ctx.server);
      ctx.server.hits.length = 0;
      await startCheck(page, set.id);
      await finished(page);
      const box = await readBox(page);
      const hits = ctx.server.hits.slice();
      await online(); online = null;
      assert(box.role === 'dialog', 'the ready check is not a dialog (modal())');
      assert(!hits.length, 'the ready check used the network: ' + hits.join(', '));
      assert(box.status === 'All 3 charts are ready.', `last line "${box.status}", want "All 3 charts are ready."`);
      const want = [[three.title, await pagesOf('three-page.pdf')], [one.title, await pagesOf('one-page.pdf')], [two.title, await pagesOf('two-page.pdf')]];
      assert(box.rows.length === 3, `${box.rows.length} rows, want 3 (each chart once, in setlist order, no break): ` + JSON.stringify(box.rows));
      want.forEach(([t, n], i) => {
        const r = box.rows[i];
        assert(r.t === t && r.state === 'ok' && r.s === `${n} page${n === 1 ? '' : 's'}. OK`, `row ${i + 1} ${JSON.stringify(r)}, want "${t}" with "${n} page(s). OK"`);
      });
      const w1 = await workers(page);
      assert(w1.made - w0.made >= 3, `the check started ${w1.made - w0.made} pdf.js workers for 3 charts: it did not open them`);
      assert(w1.live === w0.live, `${w1.live - w0.live} pdf.js worker(s) left running after the check (each chart's document must be destroyed)`);
      const res = await closeBox(page);
      assert(res && res.ok.length === 3 && !res.missing.length && !res.bad.length && !res.stopped, 'readyCheck resolved to ' + JSON.stringify(res));
      const d = diff(before, await snapshot(page));
      assert(!d.length, 'the ready check changed the library: ' + d.join('; '));
      assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
    } finally { if(online) await online(); await s.close(); }
  }
},
{
  name: 'readycheck 2: a missing chart and a chart that will not open are each named, on a phone, nothing written, every worker ended',
  async run(ctx){
    const s = await ctx.session({viewport: {width: 360, height: 640}, hasTouch: true, serviceWorkers: 'block'});
    await countWorkers(s.context);
    try{
      const {page} = s;
      await s.goto();
      const {one, two, three} = await addThree(page);
      const set = setOf([one.id, two.id, three.id], 'Saturday wedding');
      await putSet(page, set);
      await dropFile(page, two.id);           // no PDF stored for it
      await junkFile(page, three.id);         // a PDF that pdf.js cannot open
      await page.reload(); await page.waitForSelector('#libList [data-open]');
      await importCheck(page);
      const before = await snapshot(page), w0 = await workers(page);
      await startCheck(page, set.id);
      await finished(page);
      const box = await readBox(page);
      assert(box.rows.length === 3, 'rows ' + JSON.stringify(box.rows));
      assert(box.rows[0].state === 'ok' && box.rows[0].t === one.title, 'row 1 ' + JSON.stringify(box.rows[0]));
      assert(box.rows[1].state === 'missing' && box.rows[1].t === two.title && /^Missing/.test(box.rows[1].s), 'row 2 (no stored PDF) ' + JSON.stringify(box.rows[1]));
      assert(box.rows[2].state === 'bad' && box.rows[2].t === three.title && box.rows[2].s === 'Will not open', 'row 3 (junk bytes) ' + JSON.stringify(box.rows[2]));
      assert(box.status.includes(`No PDF on this tablet for ${two.title}.`), `last line does not name the missing chart: "${box.status}"`);
      assert(box.status.includes(`will not open: ${three.title}.`), `last line does not name the chart that will not open: "${box.status}"`);
      assert(!/ready\./.test(box.status), `last line says ready with two problems: "${box.status}"`);
      /* phone: the heading and the Close button are on screen */
      const fit = await page.evaluate(() => {
        const m = document.querySelector('.modal'), inView = el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && r.height > 0; };
        return {h2: inView(m.querySelector('h2')), btn: inView(m.querySelector('[data-x]')), wide: document.documentElement.scrollWidth <= innerWidth};
      });
      assert(fit.h2 && fit.btn && fit.wide, 'the ready check does not fit a 360x640 phone: ' + JSON.stringify(fit));
      const w1 = await workers(page);
      assert(w1.live === w0.live, `${w1.live - w0.live} pdf.js worker(s) left running (a chart that will not open must still be destroyed)`);
      const res = await closeBox(page);
      assert(res.ok.length === 1 && res.missing[0] === two.title && res.bad[0] === three.title && !res.stopped, 'readyCheck resolved to ' + JSON.stringify(res));
      const d = diff(before, await snapshot(page));
      assert(!d.length, 'the ready check changed the library: ' + d.join('; '));
      assert(!s.errors.filter(e => !/pdf|Invalid PDF|InvalidPDF|worker/i.test(e)).length, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
  }
},
{
  name: 'readycheck 3: Stop half-way ends at once, says how far it got, and leaves no worker running',
  async run(ctx){
    const s = await ctx.session({serviceWorkers: 'block'});
    await countWorkers(s.context, 700);           // every message to a pdf.js worker waits 700 ms: one chart takes several seconds, so a Stop that waited for it would be far over the limit below
    try{
      const {page} = s;
      await s.goto();
      const {one, two, three} = await addThree(page);
      const set = setOf([one.id, two.id, three.id]);
      await putSet(page, set);
      await page.reload(); await page.waitForSelector('#libList [data-open]', {timeout: 20000});
      await importCheck(page);
      const before = await snapshot(page), w0 = await workers(page);
      await startCheck(page, set.id);
      await until(async () => (await readBox(page))?.rows.length >= 1, 'the first chart was never listed', 30000);
      await page.click('.modal [data-x]');      // Stop, while the second chart is being read
      const t0 = Date.now();
      await finished(page);
      const took = Date.now() - t0;
      const box = await readBox(page);
      assert(box.rows.length < 3, `Stop did not stop: ${box.rows.length} of 3 charts listed`);
      assert(took < 1200, `Stop took ${took} ms: the chart being read must be dropped at once`);
      assert(box.status.startsWith(`Stopped after ${box.rows.length} of 3 charts.`), `last line "${box.status}"`);
      assert(!/All 3 charts/.test(box.status), 'a stopped check says every chart is ready');
      await sleep(2500);                         // a check that carried on behind the box would list more rows by now
      const later = await readBox(page);
      assert(later.rows.length === box.rows.length, `the check carried on after Stop: ${later.rows.length} rows`);
      const w1 = await workers(page);
      assert(w1.live === w0.live, `${w1.live - w0.live} pdf.js worker(s) left running after Stop`);
      const res = await closeBox(page);
      assert(res.stopped === true, 'readyCheck resolved to ' + JSON.stringify(res));
      const d = diff(before, await snapshot(page));
      assert(!d.length, 'the ready check changed the library: ' + d.join('; '));
    } finally { await s.close(); }
  }
},
{
  name: 'readycheck 4: the offline line follows the real offline copy: whole, a file missing and not fetchable, refilled',
  async run(ctx){
    const s = await ctx.session();
    let restore = null;
    try{
      const {page} = s;
      await s.goto();
      const name = cacheName(ctx.root), want = precachePaths(ctx.root);
      await waitInstalled(page, name, want);
      /* first visit: no answer until the worker controls the page, then "whole" (js/boot.js asks at controllerchange) */
      await until(() => page.evaluate(() => window.ssBoot.offline() === 'ok'), 'first visit: ssBoot.offline() never became "ok" after the install', 15000)
        .catch(async e => { throw new Error(e.message + ` (it is ${await page.evaluate(() => window.ssBoot.offline())})`); });
      await page.reload(); await page.waitForSelector('#libList');
      await until(() => page.evaluate(() => window.ssBoot.offline() === 'ok'), 'returning visit: ssBoot.offline() is not "ok"', 15000);
      await importCheck(page);
      /* the line, drawn ONCE where the lead will put it; it must change in place */
      await page.evaluate(() => {
        window.__events = [];
        addEventListener('ss-offline-state', e => window.__events.push(e.detail));
        const d = document.createElement('div'); d.id = 'rcLineHost'; d.innerHTML = window.__rc.readyLineHtml(); document.querySelector('#view').prepend(d);
      });
      const line = () => page.evaluate(() => { const p = document.querySelector('#rcLineHost [data-readyline]'); return {t: p.textContent, hidden: p.hidden, warn: p.classList.contains('warnline')}; });
      let l = await line();
      assert(l.t === 'Works offline.' && !l.hidden && !l.warn, 'whole copy: line ' + JSON.stringify(l));
      /* another site deletes one file from the offline copy, and the server cannot give it back */
      const lost = 'js/names.js';
      assert(await page.evaluate(async ([n, f]) => (await caches.open(n)).delete(f), [name, lost]), 'test setup: could not delete a cached file');
      restore = missing404(ctx.server, ['/' + lost]);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));     // the app comes back on screen: js/boot.js asks for a refill
      await until(async () => (await line()).t.startsWith('Offline copy incomplete'), async () => 'missing file not refillable: line ' + JSON.stringify(await line()) + ', ssBoot ' + await page.evaluate(() => window.ssBoot.offline()), 15000);
      l = await line();
      assert(l.t === 'Offline copy incomplete: keep the app open with internet for a minute.' && !l.hidden && l.warn, 'incomplete: line ' + JSON.stringify(l));
      /* the server has the file again: the next refill heals it and the line says so */
      restore(); restore = null;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await until(async () => (await line()).t === 'Works offline.', async () => 'after the refill: line ' + JSON.stringify(await line()), 15000);
      assert(await page.evaluate(async ([n, f]) => !!(await (await caches.open(n)).match(f)), [name, lost]), `the line says "Works offline." but ${lost} is not back in the offline copy`);
      const ev = await page.evaluate(() => window.__events);
      assert(JSON.stringify(ev) === JSON.stringify(['incomplete', 'ok']), 'ss-offline-state events ' + JSON.stringify(ev) + ', want ["incomplete","ok"]');
      /* answers the app does not know change nothing; "newer" (a new version is out, this copy is not whole) is incomplete */
      const say = r => page.evaluate(r => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', {data: {type: 'ss-heal', result: r}})), r);
      await say('something else'); await sleep(200);
      assert((await line()).t === 'Works offline.', 'an unknown answer changed the line: ' + JSON.stringify(await line()));
      await say('newer');
      await until(async () => (await line()).t.startsWith('Offline copy incomplete'), '"newer" did not make the line say incomplete', 5000);
      await say('offline');
      assert((await page.evaluate(() => window.ssBoot.offline())) === 'incomplete', '"offline" is not incomplete');
      await say('healed');
      await until(async () => (await line()).t === 'Works offline.', '"healed" did not make the line say Works offline', 5000);
      assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
    } finally { if(restore) restore(); await s.close(); }
  }
},
{
  name: 'readycheck 5: no service worker answer yet: the line is empty and hidden',
  async run(ctx){
    const s = await ctx.session({serviceWorkers: 'block'});
    try{
      const {page} = s;
      await s.goto();
      await importCheck(page);
      const r = await page.evaluate(() => ({state: window.ssBoot.offline(), line: window.__rc.readyLine(), html: window.__rc.readyLineHtml()}));
      assert(r.state === null && r.line === '', 'unknown state: ' + JSON.stringify(r));
      assert(/\shidden[\s>]/.test(r.html), 'the unknown line is not hidden: ' + r.html);
    } finally { await s.close(); }
  }
},
{
  name: 'readycheck 6: did not start: a broken js/main.js shows the box after about 8 s (not over the update banner); Reload with the fix starts the app',
  async run(ctx){
    const s = await ctx.session({serviceWorkers: 'block'});
    const ov = ctx.server.overrides;
    try{
      const {page} = s;
      /* a good start: no box, ever */
      await s.goto(); await page.waitForSelector('#libList');
      await sleep(9000);
      assert(!(await boxShown(page)), 'the "did not start" box showed although the app started');
      /* a deploy whose js/main.js does not parse */
      ov.set('/js/main.js', Buffer.from(fs.readFileSync(path.join(ctx.root, 'js', 'main.js'), 'utf8') + '\n)(\n'));
      await page.reload(); await page.waitForLoadState('load');
      await sleep(2000);
      assert(await page.locator('#libList').count() === 0, 'test setup: the broken js/main.js still drew the library');
      assert(!(await boxShown(page)), 'the box showed before about 8 s');
      await until(() => boxShown(page), 'the "did not start" box did not show within 12 s of a broken js/main.js', 12000);
      const t = await textOf(page);
      assert(t.includes('ChartShark did not start. Your music is safe.'), 'box text: ' + t);
      /* the update banner, when it shows, stays on top and tappable */
      const top = await page.evaluate(() => {
        const u = document.querySelector('#update'); u.hidden = false;
        const r = u.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        u.hidden = true; return hit === u || u.contains(hit);
      });
      assert(top, 'the "did not start" box covers the "Updated. Tap to reload" banner');
      /* the fix is on the server: Reload starts the app */
      ov.delete('/js/main.js');
      await Promise.all([page.waitForEvent('load'), page.getByRole('button', {name: 'Reload', exact: true}).click()]);
      await page.waitForSelector('#libList', {timeout: 15000});
      await sleep(500);
      assert(!(await boxShown(page)), 'the box still shows after the app started');
    } finally { ov.delete('/js/main.js'); await s.close(); }
  }
},
{
  name: 'readycheck 7: did not start: a js/main.js that arrives late (10 s) shows the box, which goes away by itself when the app starts',
  async run(ctx){
    const s = await ctx.session({serviceWorkers: 'block'});
    const src = fs.readFileSync(path.join(ctx.root, 'js', 'main.js'));
    let restore = null;
    try{
      const {page} = s;
      restore = intercept(ctx.server, (req, res, p) => {
        if(p !== '/js/main.js') return false;
        ctx.server.hits.push(p);
        setTimeout(() => res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache'}).end(src), 10000);
        return true;
      });
      await page.goto(ctx.base + 'index.html', {waitUntil: 'commit'});
      await until(() => boxShown(page), 'the box did not show while js/main.js was late', 12000);
      await page.waitForSelector('#libList', {timeout: 20000});
      await sleep(300);
      assert(!(await boxShown(page)), 'the box stayed after the app started late');
    } finally { if(restore) restore(); await s.close(); }
  }
},
{
  name: 'readycheck 8: did not start with a fix WAITING: Reload on the box takes the waiting version (no plain reload of the broken page)',
  async run(ctx){
    const brk = dir => { const f = path.join(dir, 'js', 'main.js'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + '\n)(\n'); };
    const v2 = makeSiteCopy(ctx.root, {marker: 'v2-broken-main', mutate: brk});
    const v3 = makeSiteCopy(ctx.root, {marker: 'v3', bumps: 2});
    const s = await ctx.session();
    const marker = page => page.evaluate(() => document.querySelector('meta[name=ss-marker]')?.content || null);
    const update = async (page, what) => { for(let k = 0; k < 3; k++){ await askUpdate(page); try{ return await until(async () => (await swState(page)).waiting, what, 10000); }catch(e){ if(k === 2) throw e; } } };
    try{
      const {page} = s;
      await s.goto();
      await waitInstalled(page, cacheName(ctx.root), precachePaths(ctx.root));
      await page.reload(); await page.waitForSelector('#libList');
      /* version 2 (js/main.js does not parse) goes in by the usual tap on the banner */
      ctx.server.root = v2;
      await update(page, 'version 2 did not wait for the tap');
      await until(() => page.evaluate(() => { const b = document.querySelector('#update'); return !!b && !b.hidden && b.getBoundingClientRect().height > 0; }), '#update did not show for version 2', 5000);
      await page.click('#update');
      await until(async () => (await marker(page)) === 'v2-broken-main', 'the tap did not reload into version 2', 15000);
      await until(() => boxShown(page), 'the "did not start" box did not show with version 2', 14000);
      assert(await page.locator('#libList').count() === 0, 'test setup: version 2 drew the library: its broken js/main.js did not break the app');
      /* the fix is deployed and waits (a worker only takes over when told to) */
      ctx.server.root = v3;
      await update(page, 'version 3 did not wait while the box was up');
      await page.getByRole('button', {name: 'Reload', exact: true}).click();
      await page.waitForSelector('#libList', {timeout: 15000})
        .catch(() => { throw new Error('Reload on the box did not bring the waiting fix in: the broken version 2 reloaded itself'); });
      assert(await marker(page) === 'v3', 'the page after Reload is not version 3: ' + await marker(page));
      await sleep(500);
      assert(!(await boxShown(page)), 'the box still shows after the fix started');
    } finally { ctx.server.root = ctx.root; await s.close(); removeCopy(v2); removeCopy(v3); }
  }
},
];

/*
 * Kill-switch loop: the break-glass worker (tools/kill-switch/kill-sw.js, BREAK-GLASS.md (b)) in a real browser.
 *
 * Version 1 is the folder the loops serve (ctx.root), installed with a library built through the UI (three fixture
 * PDFs, a setlist, a pen stroke) and a song open on page 2. "Version 2 = kill switch armed" is a copy of it
 * (site-copy.mjs makeSiteCopy, marker "killed") whose sw.js is kill-sw.js, exactly as BREAK-GLASS.md arms it.
 * "Going back" is another copy (marker "back") with the real sw.js and a bumped VERSION, as the revert + --bump does.
 *
 * What is closed: what the kill worker PRODUCED (the caches left, the page after its reload, the library in
 * IndexedDB, the requests the server saw) is read back and compared with what went in (no `setlist-stand-` cache,
 * the "killed" marker served from the network, the snapshot taken before). Then the real worker's cache is compared
 * with sw.js PRECACHE and an offline cold start (site-copy.mjs goOffline) shows the library again.
 */
import fs from 'node:fs';
import path from 'node:path';
import {FIX, ROOT, assert, sleep, snapshot, diff, idbAll} from './harness.mjs';
import {makeSiteCopy, removeCopy, goOffline, cacheName, precachePaths, navCounter, swState, cacheKeys, waitInstalled, askUpdate, until} from './site-copy.mjs';

const bannerShown = page => page.evaluate(() => { const b = document.querySelector('#update'); return !!b && !b.hidden && b.getBoundingClientRect().height > 0; });
const marker = page => page.evaluate(() => document.querySelector('meta[name=ss-marker]')?.content || null);
const siteCaches = page => page.evaluate(async () => (await caches.keys()).filter(k => k.startsWith('setlist-stand-')));
const liveOf = v => (v && Array.isArray(v.strokes) ? v.strokes : []).filter(s => !s.deleted);
function checker(){
  const bad = [];
  return {check(ok, msg){ if(!ok) bad.push(msg); return ok; }, done(){ if(bad.length) throw new Error(bad.join(' | ')); }};
}
const pageRenders = page => page.waitForFunction(() => {
  const cv = document.querySelector('#stage .sheet canvas:not(.ink)'); if(!cv || !cv.width) return false;
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  for(let i = 0; i < d.length; i += 4) if(d[i + 3] && d[i] < 200) return true;
  return false;
}, null, {timeout: 10000}).then(() => true, () => false);
async function toLibrary(page){
  if(await page.locator('#viewer.on').count()) await page.click('#vBack');
  await page.click('#tLib');
  await page.waitForSelector('#libList');
}
async function openSong(page, title){
  await toLibrary(page);
  await page.locator('#libList [data-open]', {hasText: title}).click();
  await page.waitForSelector('#viewer.on #stage .sheet canvas');
  await page.waitForFunction(t => document.querySelector('#vTitle').textContent === t, title);
  if(await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
  await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 1);
}
async function updateUntil(page, pred, what){
  const notes = [];
  for(let k = 0; k < 3; k++){
    const r = await askUpdate(page).catch(e => 'evaluate failed (the page was reloading?): ' + e.message.split('\n')[0]);
    try{ return await until(pred, what, 10000); }
    catch(e){ notes.push(`try ${k + 1}: update() ${r}, ${e.message}`); }
  }
  throw new Error(`${what} after 3 update() calls: ${notes.join('; ')}`);
}

/* The library, through the UI: three fixtures, a setlist of two songs, a pen stroke on Three-page page 1. */
async function buildLibrary(page){
  await page.setInputFiles('#file', ['one-page.pdf', 'two-page.pdf', 'three-page.pdf'].map(f => path.join(FIX, f)));
  await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 3, null, {timeout: 15000});
  await page.click('#tSets');
  await page.click('#view [data-newset]');
  await page.locator('.modal input[type=text]').fill('Kill-switch gig');
  await page.click('.modal [data-ok]');
  await page.waitForFunction(() => document.querySelector('#view h2')?.textContent === 'Kill-switch gig');
  await page.click('#view [data-addto]');
  await page.locator('.modal .pick').waitFor();
  for(const t of ['One-page', 'Three-page']) await page.locator('.modal .pick label', {hasText: new RegExp('^' + t + '$')}).locator('input').check();
  await page.click('.modal [data-ok]');
  await page.waitForFunction(() => document.querySelectorAll('#items > li.row').length === 2, null, {timeout: 5000});
  await openSong(page, 'Three-page');
  await page.click('#vAnn');
  await page.click('#tools [data-tool=pen][data-color="#1a1a1a"]');
  const b = await page.locator('#stage .sheet').first().boundingBox();
  const x0 = b.x + b.width * .3, y0 = b.y + b.height * .4;
  await page.mouse.move(x0, y0); await page.mouse.down();
  for(let i = 1; i <= 10; i++) await page.mouse.move(x0 + i * b.width * .04, y0 + i * b.height * .01);
  await page.mouse.up();
  await until(async () => Object.values(await idbAll(page, 'ink')).some(v => liveOf(v).some(s => s.t === 'pen')), 'stroke not saved');
  await page.click('#tDone');
  const sets = Object.values(await idbAll(page, 'sets')).filter(x => !x.deleted);
  assert(sets.length === 1 && sets[0].items.length === 2, 'set not saved: ' + JSON.stringify(sets));
}

export const loops = [
{
  name: 'kill switch: armed it empties the cache, reloads once and keeps the library; disarmed the real worker and offline come back',
  async run(ctx){
    const t0 = Date.now();
    const killSrc = [path.join(ctx.root, 'tools', 'kill-switch', 'kill-sw.js'), path.join(ROOT, 'tools', 'kill-switch', 'kill-sw.js')].find(f => fs.existsSync(f));
    assert(killSrc, 'tools/kill-switch/kill-sw.js not found');
    const killed = makeSiteCopy(ctx.root, {marker: 'killed', rehash: false, mutate: dir => fs.copyFileSync(killSrc, path.join(dir, 'sw.js'))});
    const back = makeSiteCopy(ctx.root, {marker: 'back'});
    const s = await ctx.session();
    const {page, context} = s;
    /* Counts the kill worker's messages in this tab (sessionStorage survives the reload; the app never reads this key). */
    await page.addInitScript(() => {
      navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', e => {
        if(e.data && e.data.type === 'ss-sw-killed') sessionStorage.setItem('loop-killed', String(Number(sessionStorage.getItem('loop-killed') || 0) + 1));
      });
    });
    const nav = await navCounter(page, ctx.server);
    let online = null;
    try{
      const c = checker();
      /* version 1: install, returning visit, library, a song open on page 2 */
      await s.goto();
      await waitInstalled(page, cacheName(ctx.root), precachePaths(ctx.root));
      await page.reload(); await page.waitForSelector('#libList');
      assert(await page.evaluate(() => !!navigator.serviceWorker.controller), 'the returning visit is not controlled');
      await buildLibrary(page);
      await openSong(page, 'Three-page');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => /^Page 2 of 3$/.test(document.querySelector('#vSub').textContent), null, {timeout: 5000});
      const before = await snapshot(page);
      c.check(s.errors.length === 0, 'page errors before the kill switch: ' + s.errors.join(' | '));
      console.log(`  info: version 1 installed and library built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

      /* ---------- arm the kill switch ---------- */
      const t1 = Date.now();
      ctx.server.root = killed;
      ctx.server.hits.length = 0;
      nav.reset();
      await updateUntil(page, async () => nav.get().loads >= 1 && await marker(page) === 'killed', 'the open tab did not reload into the kill-switch copy');
      await page.waitForSelector('#libList, #viewer.on', {timeout: 10000});
      await sleep(3000);                                  // a second reload would show up here
      const n = nav.get();
      c.check(n.committed === 1 && n.docs === 1 && n.loads === 1 && n.asked === 1, `kill switch: want exactly one reload of the open tab, got ${nav.text()}`);
      const msgs = await page.evaluate(() => Number(sessionStorage.getItem('loop-killed') || 0));
      c.check(msgs === 1, `the tab got ${msgs} "ss-sw-killed" message(s), want 1`);
      console.log(`  info: kill switch took over and the tab reloaded in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
      const st = await swState(page);
      c.check(st.active === 'activated' && !st.waiting && !st.installing && st.controller, 'kill worker not the active, controlling worker: ' + JSON.stringify(st));
      c.check(!st.caches.length, 'setlist-stand caches left by the kill switch: ' + JSON.stringify(st.caches));
      c.check(ctx.server.hits.includes('/sw.js'), 'the kill-switch sw.js was never fetched');
      /* the reload and everything it loaded came from the network (the old cache had neither the marker nor these hits) */
      const want = ['/index.html', '/js/main.js', '/js/store.js', '/css/app.css'];
      const missed = want.filter(p => !ctx.server.hits.includes(p));
      c.check(!missed.length, 'after the kill switch these did not come from the network: ' + missed.join(', '));
      const nv = await page.evaluate(() => performance.getEntriesByType('navigation')[0].workerStart);
      console.log(`  info: navigation workerStart after the kill switch = ${nv} (0 = no worker started for it)`);
      c.check(!(await bannerShown(page)), '#update banner shown after the kill-switch reload');
      /* nothing the musician saved changed */
      const d = diff(before, await snapshot(page));
      c.check(!d.length, 'library changed across the kill switch: ' + d.join('; '));
      /* the open song came back (resume note), and the app works online */
      await page.waitForSelector('#viewer.on #stage .sheet canvas', {timeout: 10000}).catch(() => {});
      const placed = await page.evaluate(() => ({on: !!document.querySelector('#viewer.on'), title: document.querySelector('#vTitle')?.textContent, sub: document.querySelector('#vSub')?.textContent}));
      c.check(placed.on && placed.title === 'Three-page' && /Page 2 of 3/.test(placed.sub || ''), `the open song did not come back after the kill-switch reload: viewer ${placed.on ? 'open' : 'closed'}, "${placed.title}", "${placed.sub}"`);
      ctx.server.hits.length = 0;
      await toLibrary(page);
      c.check(await page.locator('#libList [data-open]').count() === 3, 'library does not list 3 songs under the kill switch');
      await openSong(page, 'One-page');
      c.check(await pageRenders(page), 'a song does not render under the kill switch');
      c.check(ctx.server.hits.includes('/vendor/pdf.worker.min.js'), 'opening a song under the kill switch did not fetch the PDF worker from the network');
      await toLibrary(page);
      c.check(!(await siteCaches(page)).length, 'a setlist-stand cache came back while the kill switch is live: ' + JSON.stringify(await siteCaches(page)));
      c.check(s.errors.length === 0, 'page errors under the kill switch: ' + s.errors.join(' | '));

      /* ---------- go back: the real worker, bumped VERSION ---------- */
      const t2 = Date.now();
      const backName = cacheName(back);
      ctx.server.root = back;
      nav.reset();
      await updateUntil(page, () => bannerShown(page), '#update did not appear for the real worker after the kill switch');
      c.check(nav.get().committed === 0, 'the page reloaded by itself when the real worker came back: ' + nav.text());
      nav.reset();
      await page.click('#update');
      await until(async () => nav.get().loads >= 1 && await marker(page) === 'back', 'the tap on #update did not reload into the real worker', 15000)
        .catch(e => c.check(false, `${e.message} (${nav.text()})`));
      await waitInstalled(page, backName, precachePaths(back));
      await sleep(2000);
      const n2 = nav.get();
      c.check(n2.committed === 1 && n2.loads === 1, `going back: want exactly one reload on the tap, got ${nav.text()}`);
      const st2 = await swState(page);
      c.check(st2.caches.length === 1 && st2.caches[0] === backName, `caches after going back ${JSON.stringify(st2.caches)}, want ["${backName}"]`);
      const keys = new Set(await cacheKeys(page, backName) || []);
      const lack = precachePaths(back).filter(p => !keys.has(p));
      c.check(!lack.length, 'the rebuilt cache lacks: ' + lack.map(p => p || './').join(', '));
      console.log(`  info: real worker back and cache rebuilt in ${((Date.now() - t2) / 1000).toFixed(1)} s`);
      c.check(s.errors.length === 0, 'page errors while going back: ' + s.errors.join(' | '));
      await page.close();

      /* offline cold start on the real worker */
      online = await goOffline(context, ctx.server);
      ctx.server.hits.length = 0;
      const p2 = await context.newPage(), err2 = [];
      p2.on('pageerror', e => err2.push('pageerror: ' + e.message));
      p2.on('console', m => { if(m.type() === 'error') err2.push('console: ' + m.text()); });
      await p2.goto(ctx.base + 'index.html');
      await p2.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 3, null, {timeout: 15000})
        .catch(async () => c.check(false, 'offline cold start after going back: library shows ' + await p2.locator('#libList [data-open]').count() + ' songs, want 3'));
      c.check(await marker(p2) === 'back', 'offline cold start is not the version that came back: marker ' + await marker(p2));
      await openSong(p2, 'Three-page');
      c.check(await pageRenders(p2), 'a song does not render offline after going back');
      await toLibrary(p2);
      const d2 = diff(before, await snapshot(p2));
      c.check(!d2.length, 'library changed after going back: ' + d2.join('; '));
      const other = ctx.server.hits.filter(p => p !== '/sw.js');
      c.check(!other.length, 'requests reached the network on the offline cold start: ' + [...new Set(other)].join(', '));
      c.check(err2.length === 0, 'page errors at the offline cold start: ' + err2.join(' | '));
      console.log(`  info: whole loop ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      c.done();
    } finally { if(online) await online(); ctx.server.root = ctx.root; nav.close(); await s.close(); removeCopy(killed); removeCopy(back); }
  }
},
];

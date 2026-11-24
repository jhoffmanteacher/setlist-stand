/*
 * Offline loops: once the service worker is installed, the whole app runs with no network at all.
 *
 * "Offline" is site-copy.mjs goOffline(): context.setOffline(true) AND the loops' server drops every connection
 * (Playwright's setOffline does not cut the service worker off; measured: its fetches still reached the server).
 * ctx.server.hits is cleared when the network goes away and must still be empty at the end: every request was
 * answered by the worker's cache, nothing even tried the network. What the app PRODUCES offline (ink, notes and
 * crops in IndexedDB, a printed PDF, a backup zip) is read back through an independent path (pdf-lib, JSZip, the
 * store) and compared with what was done.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {FIX, TMP, assert, sleep, idbAll, PDFDocument, JSZip, restoreZip, openBackupMenu, openSetMenu, snapshot, diff} from './harness.mjs';
import {cacheName, precachePaths, waitInstalled, navCounter, goOffline, throttleProxy, until, makeSiteCopy, removeCopy, cacheKeys, swState, toRepoPath, intercept} from './site-copy.mjs';

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const liveOf = v => (v && Array.isArray(v.strokes) ? v.strokes : []).filter(s => !s.deleted);
const subText = page => page.locator('#vSub').textContent();
async function waitSub(page, re, what){
  await page.waitForFunction(src => new RegExp(src).test(document.querySelector('#vSub').textContent), re.source, {timeout: 8000})
    .catch(async () => { throw new Error(`${what}: #vSub "${await subText(page)}", want ${re}`); });
}
/* A page with errors collected (pageerror + console errors). */
async function newPage(context){
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if(m.type() === 'error') errors.push('console: ' + m.text()); });
  return {page, errors};
}
const pageNotBlank = (page, ms = 10000) => page.waitForFunction(() => {
  const cvs = [...document.querySelectorAll('#stage .sheet canvas:not(.ink)')]; if(!cvs.length) return false;
  return cvs.every(cv => {
    if(!cv.width) return false;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    for(let i = 0; i < d.length; i += 4) if(d[i + 3] && (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200)) return true;
    return false;
  });
}, null, {timeout: ms}).then(() => true, () => false);
async function download(page, action){
  const [dl] = await Promise.all([page.waitForEvent('download', {timeout: 60000}), action()]);
  const f = path.join(TMP, `${Date.now()}-${dl.suggestedFilename()}`);
  await dl.saveAs(f);
  return {file: f, name: dl.suggestedFilename()};
}
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
async function songId(page, title){
  const s = Object.values(await idbAll(page, 'songs')).filter(x => !x.deleted && x.title === title);
  assert(s.length === 1, `${s.length} songs titled ${title}`);
  return s[0].id;
}
const sheetBox = page => page.locator('#stage .sheet').first().boundingBox();
async function backupAndRead(page){
  await toLibrary(page);
  const dl = await download(page, () => openBackupMenu(page, 'backup'));
  assert(/\.zip$/.test(dl.name), 'backup name ' + dl.name);
  const zip = await JSZip.loadAsync(fs.readFileSync(dl.file));
  const lj = zip.file('library.json'); assert(lj, 'backup zip has no library.json');
  return {zip, data: JSON.parse(await lj.async('string'))};
}
/* Everything must come from the worker's cache. The one exception is the browser's own update check of sw.js
   (made on navigations; the Service Worker spec sends it past the worker, so no worker can answer it): on a real
   offline device it fails at once, here it reaches the dropping server (Playwright's offline does not cover it). */
function noNetwork(hits){
  const other = hits.filter(p => p !== '/sw.js');
  assert(!other.length, 'requests reached the network while offline (not answered by the service worker): ' + [...new Set(other)].join(', '));
}

/* What another site on the same address does (guitar-class's worker, 2026-11-23): delete every cache it does not own. */
const wipeCaches = page => page.evaluate(async () => { for(const k of await caches.keys()) await caches.delete(k); return (await caches.keys()).length; });
/* The page hears the worker's answer to js/boot.js's 'ss-heal' (window.__ssHeal), from the first script on. */
const listenHeal = context => context.addInitScript(() => {
  if(navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', e => { if(e.data && e.data.type === 'ss-heal') window.__ssHeal = e.data.result; });
});
/* A fresh session with the app installed (returning visit) and one song in the library. */
async function installedWithSong(ctx){
  const s = await ctx.session();
  await listenHeal(s.context);
  await s.goto();
  await waitInstalled(s.page, cacheName(ctx.root), precachePaths(ctx.root));
  await s.page.reload(); await s.page.waitForSelector('#libList');
  assert(await s.page.evaluate(() => !!navigator.serviceWorker.controller), 'test setup: the returning visit is not controlled');
  await s.page.setInputFiles('#file', path.join(FIX, 'three-page.pdf'));
  await s.page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 1, null, {timeout: 15000});
  return s;
}
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
/* The app comes back on screen (no reload): what a tablet does when Setlist Stand is switched back to. */
const backOnScreen = page => page.evaluate(() => { window.__ssHeal = null; Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'visible'}); document.dispatchEvent(new Event('visibilitychange')); });
/* SHA-256 of every entry of cache `name`, read in the page (null when missing). */
const cachedHashes = (page, name, want) => page.evaluate(async ([name, want]) => {
  const c = await caches.open(name), out = {};
  for(const p of want){ const r = await c.match(p || './'); out[p] = r ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', await r.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('') : null; }
  return out;
}, [name, want]);

export const loops = [
{
  name: 'offline g: offline cold start serves the whole app',
  async run(ctx){
    const s = await ctx.session();
    let online = null;
    try{
      /* online: install, put the fixtures in the library */
      await s.goto();
      await waitInstalled(s.page, cacheName(ctx.root), precachePaths(ctx.root));
      await s.page.setInputFiles('#file', ['one-page.pdf', 'two-page.pdf', 'three-page.pdf'].map(f => path.join(FIX, f)));
      await s.page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 3, null, {timeout: 15000});
      assert(s.errors.length === 0, 'page errors while online: ' + s.errors.join(' | '));
      await s.page.close();
      /* offline cold start */
      online = await goOffline(s.context, ctx.server);
      ctx.server.hits.length = 0;
      const {page, errors} = await newPage(s.context);
      await page.goto(ctx.base + 'index.html');
      await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 3, null, {timeout: 15000})
        .catch(async () => { throw new Error('offline cold start: library shows ' + await page.locator('#libList [data-open]').count() + ' songs, want 3'); });
      assert(errors.length === 0, 'page errors at the offline cold start: ' + errors.join(' | '));
      assert(await page.evaluate(() => fetch('tools/README.md').then(r => r.ok, () => false)) === false, 'an uncached file still loads: the network is not cut off');
      ctx.server.hits.length = 0; errors.length = 0;   // that probe was meant to fail (at the server, and as a console error)

      /* open a song, turn pages */
      await openSong(page, 'Three-page');
      const id = await songId(page, 'Three-page');
      await waitSub(page, /^Page 1 of 3$/, 'open');
      assert(await pageNotBlank(page), 'page 1 canvas blank offline');
      await page.keyboard.press('ArrowRight'); await waitSub(page, /^Page 2 of 3$/, 'ArrowRight');
      await page.keyboard.press('ArrowRight'); await waitSub(page, /^Page 3 of 3$/, 'ArrowRight');
      assert(await pageNotBlank(page), 'page 3 canvas blank offline');
      await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
      await waitSub(page, /^Page 1 of 3$/, 'back to page 1');

      /* a stroke on page 1 */
      await page.click('#vAnn');
      await page.click('#tools [data-tool=pen][data-color="#1a1a1a"]');
      let b = await sheetBox(page);
      const x0 = b.x + b.width * .3, y0 = b.y + b.height * .4;
      await page.mouse.move(x0, y0); await page.mouse.down();
      for(let i = 1; i <= 10; i++) await page.mouse.move(x0 + i * b.width * .04, y0 + i * b.height * .01);
      await page.mouse.up();
      const stroke = await until(async () => liveOf((await idbAll(page, 'ink'))[id + ':1']).find(x => x.t === 'pen'), 'stroke not saved offline');
      assert(near(stroke.p[0][0], .3, .01) && near(stroke.p[0][1], .4, .01), 'stroke starts at ' + JSON.stringify(stroke.p[0]));
      /* a text note on page 1 */
      await page.click('#tools [data-tool=text]');
      await page.mouse.click(b.x + b.width * .2, b.y + b.height * .7);
      await page.locator('.modal textarea').waitFor({timeout: 5000});
      await page.locator('.modal textarea').fill('Offline note');
      await page.locator('.modal [data-ok]').click();
      await page.waitForFunction(() => !document.querySelector('.modal'));
      const note = await until(async () => liveOf((await idbAll(page, 'ink'))[id + ':1']).find(x => x.t === 'text' && x.text === 'Offline note'), 'text note not saved offline');
      assert(near(note.x, .2, .01) && near(note.y, .7, .01), 'note at ' + JSON.stringify({x: note.x, y: note.y}));
      await page.click('#tDone');
      /* crop page 1 */
      await page.click('#vCrop');
      await page.waitForFunction(() => !document.querySelector('#cropper').hidden && /^Page 1 of 3$/.test(document.querySelector('#cropHint').textContent), null, {timeout: 5000});
      const cs = await page.locator('#cropSheet').boundingBox(), hb = await page.locator('#cropBox .ch[data-h=nw]').boundingBox();
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
      await page.mouse.move(cs.x + cs.width * .1, cs.y + cs.height * .1, {steps: 8}); await page.mouse.up();
      await page.click('#cropPage');
      await page.waitForSelector('#cropper', {state: 'hidden', timeout: 5000});
      const crop = await until(async () => { const r = (await idbAll(page, 'songs'))[id]; return r.crop && r.crop.pages && r.crop.pages['1']; }, 'crop not saved offline');
      assert(near(crop.x, .1, .03) && near(crop.y, .1, .03) && near(crop.x + crop.w, 1, .01), 'crop ' + JSON.stringify(crop));
      assert(await pageNotBlank(page), 'cropped page blank');

      /* a setlist with a break, printed */
      await toLibrary(page);
      await page.click('#tSets');
      await page.click('#view [data-newset]');
      await page.locator('.modal input[type=text]').fill('Offline gig');
      await page.click('.modal [data-ok]');
      await page.waitForFunction(() => document.querySelector('#view h2')?.textContent === 'Offline gig');
      const add = async title => {
        const n0 = await page.locator('#items > li.row').count();
        await page.click('#view [data-addto]');
        await page.locator('.modal .pick').waitFor();
        await page.locator('.modal .pick label', {hasText: new RegExp('^' + title + '$')}).locator('input').check();
        await page.click('.modal [data-ok]');
        await page.waitForFunction(n => document.querySelectorAll('#items > li.row').length === n, n0 + 1, {timeout: 5000});
      };
      await add('One-page');
      await page.click('#view [data-addbreak]');
      await page.waitForFunction(() => document.querySelectorAll('#items > li.row').length === 2);
      await add('Three-page');
      const set = Object.values(await idbAll(page, 'sets')).find(x => x.name === 'Offline gig' && !x.deleted);
      assert(set && set.items.map(i => i.type).join() === 'song,break,song', 'set items ' + JSON.stringify(set && set.items));
      await openSetMenu(page, 'print');
      await page.locator('.modal #pInk').setChecked(true);
      const pdf = await download(page, () => page.locator('.modal [data-ok]').click());
      if(await page.locator('.modal').count()){ await page.locator('.modal [data-x]').click(); }
      await page.waitForFunction(() => !document.querySelector('.modal'));
      const doc = await PDFDocument.load(fs.readFileSync(pdf.file));
      assert(doc.getPageCount() === 4, `printed set (One-page, break, Three-page) has ${doc.getPageCount()} pages, want 4`);

      /* back up, read the zip back */
      const {zip, data} = await backupAndRead(page);
      assert(data.songs.length === 3, 'backup songs ' + data.songs.length);
      for(const x of data.songs) assert(zip.file('files/' + x.id + '.pdf'), 'backup lacks files/' + x.id + '.pdf');
      const bset = data.sets.find(x => x.name === 'Offline gig');
      assert(bset && JSON.stringify(bset.items) === JSON.stringify(set.items), 'backup set items ' + JSON.stringify(bset && bset.items));
      const bink = liveOf(data.ink[id + ':1']);
      assert(bink.some(x => x.id === stroke.id) && bink.some(x => x.id === note.id), 'backup lacks the offline stroke or note');
      const bsong = data.songs.find(x => x.id === id);
      assert(bsong.crop && bsong.crop.pages && JSON.stringify(bsong.crop.pages['1']) === JSON.stringify(crop), 'backup crop ' + JSON.stringify(bsong.crop));

      assert(errors.length === 0, 'page errors offline: ' + errors.join(' | '));
      noNetwork(ctx.server.hits);
    } finally { if(online) await online(); await s.close(); }
  }
},
{
  name: 'offline h: offline after a slow install',
  async run(ctx){
    const KBPS = 400, LATENCY = 400;
    const proxy = await throttleProxy(ctx.base, {kbps: KBPS, latency: LATENCY});
    const context = await ctx.browser.newContext({viewport: {width: 1280, height: 800}, acceptDownloads: true, serviceWorkers: 'allow'});
    let proxyOpen = true;
    try{
      const {page, errors} = await newPage(context);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: LATENCY, downloadThroughput: KBPS * 1000 / 8, uploadThroughput: KBPS * 1000 / 8});
      const nav = await navCounter(page, null);
      const t0 = Date.now();
      await page.goto(proxy.base + 'index.html', {timeout: 180000});
      await page.waitForSelector('#libList', {timeout: 180000});
      const shown = Date.now() - t0;
      await waitInstalled(page, cacheName(ctx.root), precachePaths(ctx.root), 300000);
      const installed = Date.now() - t0;
      await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
      await sleep(2000);
      const n = nav.get();
      console.log(`  info: slow first visit (${KBPS} kbps, ${LATENCY} ms, page and worker): library shown after ${(shown / 1000).toFixed(1)} s, cache full after ${(installed / 1000).toFixed(1)} s`);
      assert(n.committed === 1 && n.docs === 1 && n.loads === 1 && n.asked === 0, 'the slow first visit reloaded: ' + nav.text());
      nav.close();
      await page.setInputFiles('#file', path.join(FIX, 'two-page.pdf'));
      await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 1, null, {timeout: 15000});
      await page.close();
      /* offline: the proxy is gone (connections refused) and the context is offline */
      await context.setOffline(true);
      proxy.close(); proxy.closeAllConnections(); proxyOpen = false;
      ctx.server.hits.length = 0;
      const p2 = await newPage(context);
      await p2.page.goto(proxy.base + 'index.html');
      await p2.page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 1, null, {timeout: 15000})
        .catch(() => { throw new Error('offline cold start after the slow install: the library did not show the song'); });
      await openSong(p2.page, 'Two-page');
      await waitSub(p2.page, /^Page 1 of 2$/, 'open offline');
      assert(await pageNotBlank(p2.page), 'page 1 blank offline');
      await p2.page.keyboard.press('ArrowRight');
      await waitSub(p2.page, /^Page 2 of 2$/, 'turn offline');
      assert(await pageNotBlank(p2.page), 'page 2 blank offline');
      const {zip, data} = await backupAndRead(p2.page);
      assert(data.songs.length === 1 && zip.file('files/' + data.songs[0].id + '.pdf'), 'offline backup: ' + JSON.stringify(data.songs.map(x => x.title)));
      assert(errors.length === 0 && p2.errors.length === 0, 'page errors: ' + [...errors, ...p2.errors].join(' | '));
      noNetwork(ctx.server.hits);
    } finally { await context.close(); if(proxyOpen){ proxy.close(); proxy.closeAllConnections(); } }
  }
},
{
  name: 'offline i: offline with the real library',
  needs: ['library'],
  async run(ctx){
    const s = await ctx.session();
    let online = null;
    try{
      await s.goto();
      await waitInstalled(s.page, cacheName(ctx.root), precachePaths(ctx.root));
      await restoreZip(s.page, ctx.library);
      /* ss-gig-fill: the real library has setlists named with a date, so the one-time 'Fill in gig dates?' box would open over the Setlists
         list and make the page inert; this loop is about playing offline, not about that box (it is tested in 'gigdates 2'). */
      await s.page.evaluate(() => { localStorage.setItem('ss-two', '0'); localStorage.setItem('ss-gig-fill', '1'); });     // ss-two: one page per view: every page is its own step
      assert(s.errors.length === 0, 'page errors during the restore: ' + s.errors.join(' | '));
      await s.page.close();
      online = await goOffline(s.context, ctx.server);
      ctx.server.hits.length = 0;
      const {page, errors} = await newPage(s.context);
      await page.goto(ctx.base + 'index.html');
      await page.waitForSelector('#libList [data-open]', {timeout: 30000});
      await page.click('#tSets');
      const first = page.locator('#view [data-play]').first();
      await first.waitFor({timeout: 10000}).catch(() => { throw new Error('the restored library has no setlist to play'); });
      const setId = await first.getAttribute('data-play');
      /* the expected run, from the store (not from the viewer) */
      const songs = await idbAll(page, 'songs'), set = (await idbAll(page, 'sets'))[setId];
      const live = set.items.filter(it => it.type === 'break' || (songs[it.id] && !songs[it.id].deleted));
      const nSongs = live.filter(it => it.type === 'song').length;
      const steps = [];
      let k = 0;
      for(const it of live){
        if(it.type === 'break'){ steps.push({title: it.name, sub: 'Break', brk: true}); continue; }
        k++;
        for(let p = 1; p <= songs[it.id].pages; p++) steps.push({title: songs[it.id].title, sub: (nSongs > 1 ? `Song ${k} of ${nSongs} · ` : '') + `Page ${p} of ${songs[it.id].pages}`});
      }
      await first.click();
      const bad = [];
      for(let i = 0; i < steps.length; i++){
        const w = steps[i];
        const ok = await page.waitForFunction(w => document.querySelector('#vTitle').textContent === w.title && document.querySelector('#vSub').textContent === w.sub
          && (w.brk ? !!document.querySelector('#stage .breakpage') : !!document.querySelector('#stage .sheet canvas')), w, {timeout: 15000}).then(() => true, () => false);
        if(!ok){
          bad.push(`step ${i + 1}/${steps.length}: want "${w.title}" "${w.sub}", shows "${await page.locator('#vTitle').textContent()}" "${await subText(page)}"`);
          break;
        }
        if(!w.brk && !(await pageNotBlank(page, 15000))) bad.push(`step ${i + 1}: "${w.title}" ${w.sub}: page canvas blank`);
        if(i < steps.length - 1) await page.keyboard.press('ArrowRight');
      }
      console.log(`  info: played set "${set.name}": ${nSongs} songs, ${live.length - nSongs} breaks, ${steps.length} views`);
      assert(!bad.length, bad.slice(0, 5).join(' | '));
      assert(errors.length === 0, 'page errors offline: ' + errors.join(' | '));
      noNetwork(ctx.server.hits);
    } finally { if(online) await online(); await s.close(); }
  }
},
{
  name: 'offline j: another site wipes the offline copy: one online visit refills every file, then the app opens offline',
  async run(ctx){
    const s = await installedWithSong(ctx);
    let online = null;
    try{
      const {page} = s;
      const name = cacheName(ctx.root), want = precachePaths(ctx.root);
      assert(await wipeCaches(page) === 0, 'test setup: the caches could not be deleted');
      /* one ordinary online visit, no song opened: the worker refills its own cache from the server (same version) */
      await page.reload(); await page.waitForSelector('#libList [data-open]');
      await waitInstalled(page, name, want, 20000)
        .catch(async e => { throw new Error(`the offline copy was not refilled after another site wiped it: ${e.message} (the worker answered ${await page.evaluate(() => window.__ssHeal)})`); });
      const said = await page.evaluate(() => window.__ssHeal);
      assert(said === 'healed', `the worker answered "${said}" to the refill, want "healed"`);
      /* every refilled entry holds the server's bytes */
      const got = await page.evaluate(async ([name, want]) => {
        const c = await caches.open(name), out = {};
        for(const p of want){ const r = await c.match(p || './'); out[p] = r ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', await r.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('') : null; }
        return out;
      }, [name, want]);
      const wrong = want.filter(p => got[p] !== sha(fs.readFileSync(path.join(ctx.root, toRepoPath(p)))));
      assert(!wrong.length, 'refilled entries that differ from the files on the server: ' + wrong.map(p => p || './').join(', '));
      assert(s.errors.length === 0, 'page errors while online: ' + s.errors.join(' | '));
      await page.close();
      /* offline cold start */
      online = await goOffline(s.context, ctx.server);
      ctx.server.hits.length = 0;
      const {page: p2, errors} = await newPage(s.context);
      await p2.goto(ctx.base + 'index.html');
      await p2.waitForSelector('#libList [data-open]', {timeout: 15000}).catch(() => { throw new Error('the app did not open offline after the refill'); });
      await openSong(p2, 'Three-page');
      assert(await pageNotBlank(p2), 'the song does not render offline after the refill');
      assert(errors.length === 0, 'page errors offline: ' + errors.join(' | '));
      noNetwork(ctx.server.hits);
    } finally { if(online) await online(); await s.close(); }
  }
},
{
  name: 'offline k: a wiped offline copy is not refilled with a NEWER version from the server; that version waits for its tap',
  async run(ctx){
    const v2 = makeSiteCopy(ctx.root, {marker: 'v2'});
    const s = await installedWithSong(ctx);
    try{
      const {page} = s;
      const before = await snapshot(page);
      const v1Name = cacheName(ctx.root), v2Name = cacheName(v2);
      ctx.server.root = v2;
      assert(await wipeCaches(page) === 0, 'test setup: the caches could not be deleted');
      await page.reload(); await page.waitForSelector('#libList [data-open]');
      /* the browser's own check on that visit finds version 2; it installs into ITS cache and waits for the tap */
      await until(async () => { const b = await page.evaluate(() => { const u = document.querySelector('#update'); return !!u && !u.hidden; }); return b; },
        async () => 'version 2 was not offered after the wiped copy was opened: ' + JSON.stringify(await swState(page)), 20000);
      await until(() => page.evaluate(() => window.__ssHeal), 'the worker never answered the refill request', 10000);
      const said = await page.evaluate(() => window.__ssHeal);
      assert(said === 'newer', `the worker answered "${said}" to the refill while the server holds a newer version, want "newer"`);
      await sleep(1000);
      const old = await cacheKeys(page, v1Name);
      assert(!old || !old.length, `version 1's cache ${v1Name} was refilled with ${old.length} file(s) while the server holds version 2 (files of another version under this version's name): ${old.slice(0, 5).map(p => p || './').join(', ')}`);
      /* the tap brings version 2 in, whole, and the library is untouched */
      await page.click('#update');
      await until(async () => await page.evaluate(() => document.querySelector('meta[name=ss-marker]')?.content || null) === 'v2' && await page.locator('#libList [data-open]').count() === 1,
        'the tap did not bring version 2 in', 15000);
      await until(async () => { const st = await swState(page); return st.caches.length === 1 && st.caches[0] === v2Name; },
        async () => `caches after the tap ${JSON.stringify((await swState(page)).caches)}, want only ["${v2Name}"]`, 10000);
      const keys = new Set(await cacheKeys(page, v2Name) || []);
      const missing = precachePaths(v2).filter(p => !keys.has(p));
      assert(!missing.length, `version 2 cache lacks: ${missing.join(', ')}`);
      const d = diff(before, await snapshot(page));
      assert(!d.length, 'library changed: ' + d.join('; '));
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    } finally { ctx.server.root = ctx.root; await s.close(); removeCopy(v2); }
  }
},
{
  name: 'offline l: the offline copy is wiped while the app stays open: coming back on screen (no reload, within the hour) refills it',
  async run(ctx){
    const s = await installedWithSong(ctx);
    let online = null;
    try{
      const {page} = s;
      const name = cacheName(ctx.root), want = precachePaths(ctx.root);
      await sleep(1000);                       // the load's own refill request has been answered (the copy was whole)
      assert(await wipeCaches(page) === 0, 'test setup: the caches could not be deleted');
      await backOnScreen(page);
      await waitInstalled(page, name, want, 20000)
        .catch(async e => { throw new Error(`coming back on screen did not refill the wiped offline copy: ${e.message} (the worker answered ${await page.evaluate(() => window.__ssHeal)})`); });
      const said = await page.evaluate(() => window.__ssHeal);
      assert(said === 'healed', `the worker answered "${said}" to the refill, want "healed"`);
      assert(s.errors.length === 0, 'page errors while online: ' + s.errors.join(' | '));
      await page.close();
      online = await goOffline(s.context, ctx.server);
      ctx.server.hits.length = 0;
      const {page: p2, errors} = await newPage(s.context);
      await p2.goto(ctx.base + 'index.html');
      await p2.waitForSelector('#libList [data-open]', {timeout: 15000}).catch(() => { throw new Error('the app did not open offline after the refill'); });
      await openSong(p2, 'Three-page');
      assert(await pageNotBlank(p2), 'the song does not render offline after the refill');
      assert(errors.length === 0, 'page errors offline: ' + errors.join(' | '));
      noNetwork(ctx.server.hits);
    } finally { if(online) await online(); await s.close(); }
  }
},
{
  name: 'offline m: a Wi-Fi login page answering in place of a file is never stored by the refill; clean answers fill the copy',
  async run(ctx){
    const s = await installedWithSong(ctx);
    const file = '/vendor/pdf.worker.min.js';
    let mode = 'redirect';
    const restore = intercept(ctx.server, (req, res, p) => {
      if(p !== file || mode === 'clean') return false;
      ctx.server.hits.push(p);
      if(mode === 'redirect') res.writeHead(302, {Location: '/login.html'}).end();
      else res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache'}).end('<!DOCTYPE html><title>Log in to the Wi-Fi</title>');
      return true;
    });
    const login = intercept(ctx.server, (req, res, p) => {
      if(p !== '/login.html') return false;
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}).end('<!DOCTYPE html><title>Log in to the Wi-Fi</title>');
      return true;
    });
    try{
      const {page} = s;
      const name = cacheName(ctx.root), want = precachePaths(ctx.root);
      await sleep(1000);
      for(const m of ['redirect', 'page']){
        mode = m;
        assert(await wipeCaches(page) === 0, 'test setup: the caches could not be deleted');
        await backOnScreen(page);
        await until(() => page.evaluate(() => window.__ssHeal), `the worker never answered the refill request (${m})`, 15000);
        const said = await page.evaluate(() => window.__ssHeal);
        assert(said === 'refused', `with ${file} answered by a login ${m === 'redirect' ? 'redirect' : 'page (status 200, text/html)'} the refill answered "${said}", want "refused"`);
        await sleep(500);
        const keys = await cacheKeys(page, name) || [];
        assert(!keys.length, `the refill stored ${keys.length} file(s) although ${file} came back as a login ${m}: ${keys.slice(0, 4).map(k => k || './').join(', ')}${keys.includes(file.slice(1)) ? ' (including the login page as ' + file + ')' : ''}`);
      }
      /* the Wi-Fi lets it through: the next time on screen fills the copy, with the server's own bytes */
      mode = 'clean';
      await backOnScreen(page);
      await waitInstalled(page, name, want, 20000)
        .catch(async e => { throw new Error(`clean answers did not refill the copy: ${e.message} (the worker answered ${await page.evaluate(() => window.__ssHeal)})`); });
      const got = await cachedHashes(page, name, want);
      const wrong = want.filter(p => got[p] !== sha(fs.readFileSync(path.join(ctx.root, toRepoPath(p)))));
      assert(!wrong.length, 'refilled entries that differ from the files on the server: ' + wrong.map(p => p || './').join(', '));
    } finally { login(); restore(); await s.close(); }
  }
},
{
  name: 'offline n: a deploy that lands while the refill is fetching files: the refill stores nothing (it asks the server\'s VERSION again after the files arrive)',
  async run(ctx){
    const s = await installedWithSong(ctx);
    const file = '/vendor/pdf.worker.min.js', real = fs.readFileSync(path.join(ctx.root, 'sw.js'), 'utf8');
    let armed = false, lateAnswers = 0;
    /* The first look at the server's sw.js (before any file is fetched) is the real one: the same version. Then, as soon as a file
       is asked for, the "deploy lands": the NEXT look at sw.js names another version. */
    const fileWatch = intercept(ctx.server, (req, res, p) => { if(p === file && !lateAnswers) armed = true; return false; });
    const swWatch = intercept(ctx.server, (req, res, p) => {
      if(p !== '/sw.js' || !armed) return false;
      armed = false; lateAnswers++;
      res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache'}).end(real.replace(/(const\s+VERSION\s*=\s*')[^']+'/, "$1deployed-while-refilling'"));
      return true;
    });
    try{
      const {page} = s;
      const name = cacheName(ctx.root), want = precachePaths(ctx.root);
      await sleep(1000);                                           // the load's own refill request was answered (the copy was whole)
      assert(await wipeCaches(page) === 0, 'test setup: the caches could not be deleted');
      await backOnScreen(page);
      await until(() => page.evaluate(() => window.__ssHeal), 'the worker never answered the refill request', 15000);
      const said = await page.evaluate(() => window.__ssHeal);
      assert(lateAnswers === 1, `the refill looked at the server's sw.js ${lateAnswers ? 'more than once' : 'only before the files arrived (a deploy landing meanwhile goes unseen)'}`);
      assert(said === 'newer', `a deploy landed while the files were arriving and the refill answered "${said}", want "newer"`);
      await sleep(500);
      const keys = await cacheKeys(page, name) || [];
      assert(!keys.length, `the refill stored ${keys.length} file(s) although the server's VERSION changed while they were fetched: ${keys.slice(0, 4).map(k => k || './').join(', ')}`);
      /* nothing is stuck: with the server steady again, the next time on screen fills the copy with the server's own bytes */
      await backOnScreen(page);
      await waitInstalled(page, name, want, 20000)
        .catch(async e => { throw new Error(`a later refill did not fill the copy: ${e.message} (the worker answered ${await page.evaluate(() => window.__ssHeal)})`); });
      const got = await cachedHashes(page, name, want);
      const wrong = want.filter(p => got[p] !== sha(fs.readFileSync(path.join(ctx.root, toRepoPath(p)))));
      assert(!wrong.length, 'refilled entries that differ from the files on the server: ' + wrong.map(p => p || './').join(', '));
    } finally { swWatch(); fileWatch(); await s.close(); }
  }
},
];

/*
 * Update loops: a REAL service worker in headless Chromium against "version 1" and "version 2" of the site.
 *
 * Version 1 is the folder the loops serve (ctx.root). Version 2 is a copy of it (site-copy.mjs makeSiteCopy: no
 * node_modules/.git, <meta name="ss-marker" content="v2"> in index.html, `node tools/checks.mjs --bump` run in the
 * copy so sw.js has a new VERSION). A loop "deploys" version 2 by switching ctx.server.root to the copy, then calls
 * registration.update() as a visit would; ctx.server.root is put back in `finally`.
 *
 * What is closed here: what the worker PRODUCED (its caches, the page that lands after the reload, the library in
 * IndexedDB) is read back and compared with what went in (sw.js PRECACHE, the version-2 marker, the snapshot taken
 * before the update). Reloads are counted by the browser several ways (site-copy.mjs navCounter): committed
 * navigations, document requests (also those the worker answers from its cache), load events, and navigations the
 * page asked for (CDP), so a double location.reload() cannot pass as one.
 *
 * A "returning visit" = the page is reloaded once after the first install, so it was controlled when it loaded
 * (js/main.js hadController is true), as a musician's tab normally is.
 */
import fs from 'node:fs';
import path from 'node:path';
import {FIX, assert, sleep, snapshot, diff} from './harness.mjs';
import {makeSiteCopy, removeCopy, missing404, goOffline, cacheName, precachePaths, navCounter, swState, cacheKeys, waitInstalled, askUpdate, until} from './site-copy.mjs';

const subText = page => page.locator('#vSub').textContent();
const bannerShown = page => page.evaluate(() => { const b = document.querySelector('#update'); return !!b && !b.hidden && b.getBoundingClientRect().height > 0; });
/* The app decided to offer the update (the banner is not [hidden]); it may still be out of sight while a song is on screen. */
const bannerOffered = page => page.evaluate(() => { const b = document.querySelector('#update'); return !!b && !b.hidden; });
const marker = page => page.evaluate(() => document.querySelector('meta[name=ss-marker]')?.content || null);

/* Collects failed checks so one run reports all of them; done() throws with every one. */
function checker(){
  const bad = [];
  return {check(ok, msg){ if(!ok) bad.push(msg); return ok; }, done(){ if(bad.length) throw new Error(bad.join(' | ')); }};
}

/* Fresh context on version 1: first visit, wait until the worker controls the page and the cache is full. */
async function firstVisit(ctx){
  const s = await ctx.session();
  const nav = await navCounter(s.page, ctx.server);
  await s.goto();
  await waitInstalled(s.page, cacheName(ctx.root), precachePaths(ctx.root));
  return {s, nav};
}
/* Reload so the page was controlled when it loaded (a returning visit). */
async function returning(s, nav){
  await s.page.reload();
  await s.page.waitForSelector('#libList');
  const ws = await s.page.evaluate(() => performance.getEntriesByType('navigation')[0].workerStart > 0 && !!navigator.serviceWorker.controller);
  assert(ws, 'the returning visit was not served by the service worker');
  nav.reset();
}
async function addSong(page, file = 'three-page.pdf'){
  const n0 = await page.locator('#libList [data-open]').count();
  await page.setInputFiles('#file', path.join(FIX, file));
  await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, n0 + 1, {timeout: 15000});
}
/* Opens the only (or the titled) song, one page per view, on page pn. */
async function openAt(page, title, pn){
  await page.locator('#libList [data-open]', {hasText: title}).click();
  await page.waitForSelector('#viewer.on #stage .sheet canvas');
  if(await page.getAttribute('#v2up', 'aria-pressed') === 'true') await page.click('#v2up');
  await page.waitForFunction(() => document.querySelectorAll('#stage .sheet').length === 1);
  for(let i = 1; i < pn; i++) await page.keyboard.press('ArrowRight');
  await page.waitForFunction(re => new RegExp(re).test(document.querySelector('#vSub').textContent), `^Page ${pn} of \\d+$`, {timeout: 5000});
}
const pageRenders = page => page.waitForFunction(() => {
  const cv = document.querySelector('#stage .sheet canvas:not(.ink)'); if(!cv || !cv.width) return false;
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  for(let i = 0; i < d.length; i += 4) if(d[i + 3] && d[i] < 200) return true;
  return false;
}, null, {timeout: 10000}).then(() => true, () => false);

/* Deploys `dir` and asks for an update until a new worker shows up (installing, waiting or active as `want`), at most
   3 times: Chrome sometimes folds an update() into a check it already made (seen in the guitar-class loop). */
async function updateUntil(page, pred, what){
  const notes = [];
  for(let k = 0; k < 3; k++){
    const r = await askUpdate(page);
    try{ return {notes, r, v: await until(pred, what, 10000)}; }
    catch(e){ notes.push(`try ${k + 1}: update() ${r}, ${e.message}`); }
  }
  throw new Error(`${what} after 3 update() calls: ${notes.join('; ')}`);
}

/* After a reload starts, waits until the new document is up and ready (the library or the viewer drawn). */
async function waitNewDoc(page, nav, ms = 15000){
  await until(async () => nav.get().loads >= 1 && await page.evaluate(() => !!document.querySelector('#libList, #view .list, #view h2, #viewer.on')), 'the page did not reload', ms);
}

export const loops = [
{
  name: 'update a: first install: no reload, every precached file cached',
  async run(ctx){
    const {s, nav} = await firstVisit(ctx);
    try{
      const c = checker();
      await sleep(2000);                       // a reload asked for at controllerchange would have happened by now
      const n = nav.get();
      c.check(n.committed === 1 && n.docs === 1 && n.loads === 1 && n.asked === 0, `first visit reloaded: ${nav.text()} (want 1, 1, 1, 0 asked)`);
      const want = precachePaths(ctx.root), name = cacheName(ctx.root);
      const st = await swState(s.page);
      c.check(st.controller && st.active === 'activated', 'worker not active and controlling: ' + JSON.stringify(st));
      c.check(st.caches.length === 1 && st.caches[0] === name, `caches ${JSON.stringify(st.caches)}, want exactly ["${name}"]`);
      const keys = new Set(await cacheKeys(s.page, name) || []);
      const missing = want.filter(p => !keys.has(p));
      c.check(!missing.length, `PRECACHE entries not in ${name}: ${missing.map(p => p || './').join(', ')}`);
      c.check(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
      c.done();
    } finally { nav.close(); await s.close(); }
  }
},
{
  name: 'update b: banner waits out the song, no automatic reload, one reload on tap after Back',
  async run(ctx){
    const v2 = makeSiteCopy(ctx.root, {marker: 'v2'});
    const {s, nav} = await firstVisit(ctx);
    const {page} = s;
    try{
      const c = checker();
      await returning(s, nav);
      await addSong(page);
      await openAt(page, 'Three-page', 2);
      await page.evaluate(() => { window.__ssOld = 'still here'; });
      const before = await snapshot(page);
      const v1Name = cacheName(ctx.root), v2Name = cacheName(v2);
      ctx.server.root = v2;
      nav.reset();
      await updateUntil(page, () => bannerOffered(page), '#update was not offered');
      /* a song is on screen: the banner must be out of sight (a stray tap mid-song must not reload the app) */
      c.check(!(await bannerShown(page)), 'the update banner is visible over a song that is playing');
      /* the page must not reload by itself */
      const t0 = Date.now();
      while(Date.now() - t0 < 8000){
        const n = nav.get();
        if(n.committed || n.docs || n.asked) break;
        await sleep(250);
      }
      const n8 = nav.get();
      c.check(!n8.committed && !n8.docs && !n8.loads && !n8.asked, `the page reloaded by itself after the update was found: ${nav.text()}`);
      const kept = await page.evaluate(() => window.__ssOld).catch(() => null);
      c.check(kept === 'still here', 'in-page variable lost before the tap (page was replaced)');
      c.check(/^Page 2 of 3$/.test(await subText(page)), `viewer moved before the tap: #vSub "${await subText(page)}"`);
      c.check(await marker(page) === null, 'version 2 marker in the DOM before the tap');
      /* Back to the library: now the banner shows, and the tap reloads once */
      await page.click('#vBack');
      await until(() => bannerShown(page), 'the update banner did not show after going Back', 5000);
      nav.reset();
      await page.click('#update');
      await waitNewDoc(page, nav).catch(e => c.check(false, `after the tap: ${e.message} (${nav.text()})`));
      await sleep(3000);                       // a second reload would show up here
      const n = nav.get();
      c.check(n.committed === 1 && n.docs === 1 && n.loads === 1 && n.asked === 1, `tap on #update: want exactly one reload, got ${nav.text()}`);
      c.check(await marker(page) === 'v2', `version 2 marker not in the DOM after the reload (${await marker(page)})`);
      const st = await swState(page);
      c.check(st.caches.length === 1 && st.caches[0] === v2Name, `caches after the update ${JSON.stringify(st.caches)}, want only ["${v2Name}"] (old ${v1Name} deleted)`);
      const keys = new Set(await cacheKeys(page, v2Name) || []);
      const missing = precachePaths(v2).filter(p => !keys.has(p));
      c.check(!missing.length, `version 2 cache lacks: ${missing.join(', ')}`);
      const shell = await page.evaluate(() => fetch('./').then(r => r.text()));
      c.check(shell.includes('name="ss-marker" content="v2"'), "fetch('./') after the update is not version 2");
      const d = diff(before, await snapshot(page));
      c.check(!d.length, 'library changed across the update: ' + d.join('; '));
      c.check(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
      /* The update was taken from the library, so no song reopens. (A song that IS open when a reload happens, which only the
         kill switch can cause now, comes back: kill-switch.loop.mjs checks that.) */
      await sleep(1500);
      const placed = await page.evaluate(() => ({on: !!document.querySelector('#viewer.on'), lib: !!document.querySelector('#libList [data-open]'), playing: document.body.classList.contains('playing')}));
      c.check(!placed.on && placed.lib && !placed.playing, `after the update reload from the library: viewer ${placed.on ? 'open' : 'closed'}, library ${placed.lib ? 'shown' : 'missing'}, body.playing ${placed.playing}`);
      c.done();
    } finally { ctx.server.root = ctx.root; nav.close(); await s.close(); removeCopy(v2); }
  }
},
{
  name: 'update b2: a tab still open from the first install reloads once on tap',
  async run(ctx){
    /* The person installs the app and keeps that same tab open (no reload) until the next deploy. */
    const v2 = makeSiteCopy(ctx.root, {marker: 'v2'});
    const {s, nav} = await firstVisit(ctx);
    const {page} = s;
    try{
      const c = checker();
      await addSong(page);
      ctx.server.root = v2;
      nav.reset();
      await updateUntil(page, () => bannerShown(page), '#update did not appear');
      nav.reset();
      await page.click('#update');
      await waitNewDoc(page, nav, 10000).catch(async e => {
        const st = await swState(page);
        c.check(false, `tap on #update in the tab of the first install: ${e.message} (${nav.text()}); caches now ${JSON.stringify(st.caches)}, worker ${st.active}, controller ${st.controller}: ` +
          'js/main.js watchUpdates skips location.reload() when hadController is false, and hadController is false for the whole life of the tab that did the first install');
      });
      await sleep(2000);
      const n = nav.get();
      c.check(n.committed === 1 && n.docs === 1 && n.loads === 1, `want exactly one reload, got ${nav.text()}`);
      c.check(await marker(page) === 'v2', 'version 2 marker not in the DOM after the tap');
      c.check(await bannerShown(page) === false, '#update still shown after the tap');
      c.done();
    } finally { ctx.server.root = ctx.root; nav.close(); await s.close(); removeCopy(v2); }
  }
},
{
  name: 'update c: no update when nothing changed',
  async run(ctx){
    const {s, nav} = await firstVisit(ctx);
    const {page} = s;
    try{
      const c = checker();
      await returning(s, nav);
      const st0 = await swState(page);
      for(let i = 0; i < 2; i++){ const r = await askUpdate(page); c.check(r === 'ok', 'update() ' + r); }
      await sleep(4000);
      c.check(!(await bannerShown(page)), '#update shown although nothing changed');
      const n = nav.get();
      c.check(!n.committed && !n.docs && !n.loads && !n.asked, 'page reloaded: ' + nav.text());
      const st = await swState(page);
      c.check(!st.installing && !st.waiting, 'a new worker appeared: ' + JSON.stringify(st));
      c.check(JSON.stringify(st.caches) === JSON.stringify(st0.caches), `caches changed ${JSON.stringify(st0.caches)} -> ${JSON.stringify(st.caches)}`);
      c.check(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
      c.done();
    } finally { nav.close(); await s.close(); }
  }
},
{
  name: 'update d: a broken deploy keeps the old version working',
  async run(ctx){
    const gone = 'js/crop.js';
    const v2 = makeSiteCopy(ctx.root, {marker: 'v2-broken', mutate: dir => fs.rmSync(path.join(dir, gone))});
    const {s, nav} = await firstVisit(ctx);
    const {page, context} = s;
    let restore404 = null;
    try{
      const c = checker();
      await returning(s, nav);
      await addSong(page);
      const v1Name = cacheName(ctx.root);
      ctx.server.root = v2;
      restore404 = missing404(ctx.server, ['/' + gone]);
      ctx.server.hits.length = 0;
      /* the broken worker is fetched, tries to install, and fails: the server sees sw.js and the missing file */
      await updateUntil(page, async () => ctx.server.hits.includes('/' + gone) && !(await swState(page)).installing, 'version 2 never tried to install');
      await sleep(3000);
      const st = await swState(page);
      c.check(!st.waiting && !st.installing && st.active === 'activated' && st.controller, 'worker state after the failed install: ' + JSON.stringify(st));
      c.check(!(await bannerShown(page)), '#update shown for a deploy that failed to install');
      const n = nav.get();
      c.check(!n.committed && !n.docs && !n.asked, 'page reloaded: ' + nav.text());
      const left = st.caches.filter(k => k !== v1Name);
      if(left.length) console.log(`  info: the failed install left cache(s) ${left.join(', ')} (${JSON.stringify(await Promise.all(left.map(k => cacheKeys(page, k).then(x => (x || []).length))))} entries); the next good update's activate deletes them`);
      c.check(st.caches.includes(v1Name), `version 1 cache ${v1Name} gone: ${JSON.stringify(st.caches)}`);
      /* still works online (the broken version 2 is what the server has now) */
      await page.locator('#libList [data-open]', {hasText: 'Three-page'}).click();
      c.check(await pageRenders(page), 'song does not render after the failed update');
      await page.click('#vBack');
      /* and offline */
      const online = await goOffline(context, ctx.server);
      try{
        await page.reload();
        await page.waitForSelector('#libList [data-open]', {timeout: 10000});
        c.check(await marker(page) === null, 'offline reload shows the broken version 2');
        await page.locator('#libList [data-open]', {hasText: 'Three-page'}).click();
        c.check(await pageRenders(page), 'song does not render offline after the failed update');
        await page.click('#vBack');
      } finally { await online(); }
      c.check(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
      c.done();
    } finally { restore404 && restore404(); ctx.server.root = ctx.root; nav.close(); await s.close(); removeCopy(v2); }
  }
},
{
  name: 'update e: update while offline is quiet',
  async run(ctx){
    const v2 = makeSiteCopy(ctx.root, {marker: 'v2'});
    const {s, nav} = await firstVisit(ctx);
    const {page, context} = s;
    try{
      const c = checker();
      await returning(s, nav);
      await addSong(page);
      ctx.server.root = v2;                  // a new version IS out there, but this device cannot reach it
      const online = await goOffline(context, ctx.server);
      ctx.server.hits.length = 0;
      try{
        const r = await askUpdate(page);
        console.log(`  info: registration.update() offline: ${r}`);
        await sleep(4000);
        c.check(!(await bannerShown(page)), '#update shown while offline');
        const st = await swState(page);
        c.check(!st.installing && !st.waiting, 'a new worker appeared offline: ' + JSON.stringify(st));
        c.check(nav.get().committed === 0, 'page reloaded: ' + nav.text());
        c.check(s.errors.length === 0, 'console errors after the offline update: ' + s.errors.join(' | '));
        await page.reload();
        await page.waitForSelector('#libList [data-open]', {timeout: 10000}).catch(() => c.check(false, 'app did not open offline'));
        await page.locator('#libList [data-open]', {hasText: 'Three-page'}).click();
        c.check(await pageRenders(page), 'song does not render offline');
        c.check(!(await bannerShown(page)), '#update shown after the offline reload');
        c.check(s.errors.length === 0, 'console errors after the offline reload: ' + s.errors.join(' | '));
        /* only the worker's own update checks may try the network (and get no answer) */
        const tried = ctx.server.hits.filter(p => p !== '/sw.js');
        c.check(!tried.length, 'requests other than the sw.js update check went to the network while offline: ' + tried.join(', '));
        console.log(`  info: while offline the browser tried sw.js ${ctx.server.hits.length - tried.length} time(s) (update checks, no answer)`);
      } finally { await online(); }
      c.done();
    } finally { ctx.server.root = ctx.root; nav.close(); await s.close(); removeCopy(v2); }
  }
},
{
  name: 'update f: old tab and new tab',
  async run(ctx){
    const v2 = makeSiteCopy(ctx.root, {marker: 'v2'});
    const {s, nav} = await firstVisit(ctx);
    const A = s.page;
    let navB = null;
    try{
      const c = checker();
      await returning(s, nav);
      await addSong(A);
      const B = await s.context.newPage();
      const errB = [];
      B.on('pageerror', e => errB.push('pageerror: ' + e.message));
      B.on('console', m => { if(m.type() === 'error') errB.push('console: ' + m.text()); });
      await B.goto(ctx.base + 'index.html');
      await B.waitForSelector('#libList [data-open]');
      assert(await B.evaluate(() => !!navigator.serviceWorker.controller), 'tab B is not controlled');
      await B.locator('#libList [data-open]', {hasText: 'Three-page'}).click();
      await B.waitForSelector('#viewer.on #stage .sheet canvas');
      await B.evaluate(() => { window.__ssOld = 'B'; });
      navB = await navCounter(B, null);
      const snapA = await snapshot(A), snapB = await snapshot(B);
      ctx.server.root = v2;
      nav.reset();
      await updateUntil(A, () => bannerShown(A), '#update did not appear in tab A');
      console.log(`  info: tab B ${await bannerShown(B) ? 'shows' : 'does not show'} the banner before A taps`);
      await A.click('#update');
      await waitNewDoc(A, nav).catch(e => c.check(false, `tab A after the tap: ${e.message}`));
      await sleep(4000);
      const n = nav.get();
      c.check(n.committed === 1 && n.docs === 1 && n.loads === 1 && n.asked === 1, `tab A: want exactly one reload, got ${nav.text()}`);
      c.check(await marker(A) === 'v2', 'tab A is not version 2 after its reload');
      const nb = navB.get();
      const bKept = await B.evaluate(() => window.__ssOld).catch(() => null);
      c.check(!nb.committed && !nb.docs && !nb.asked && bKept === 'B',
        `tab B was forced to reload when tab A tapped #update (${navB.text()}): js/main.js watchUpdates reloads on every controllerchange, and skip-waiting + clients.claim() changes the controller of every open tab`);
      if(!nb.committed) c.check(await B.locator('#viewer.on').count() === 1, 'tab B lost its open song without reloading');
      console.log(`  info: tab B after A's update: ${nb.committed ? 'reloaded' : 'stayed'}, banner ${await bannerShown(B) ? 'shown' : 'hidden'}, marker ${await marker(B)}`);
      const dA = diff(snapA, await snapshot(A)), dB = diff(snapB, await snapshot(B));
      c.check(!dA.length, 'tab A library changed: ' + dA.join('; '));
      c.check(!dB.length, 'tab B library changed: ' + dB.join('; '));
      c.check(s.errors.length === 0 && errB.length === 0, 'page errors: ' + [...s.errors, ...errB].join(' | '));
      c.done();
    } finally { ctx.server.root = ctx.root; nav.close(); navB && navB.close(); await s.close(); removeCopy(v2); }
  }
},
];

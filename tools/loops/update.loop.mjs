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
 * A "returning visit" = the page is reloaded once after the first install, so it was controlled when it loaded,
 * as a musician's tab normally is.
 *
 * The registration, the banner, the controllerchange rule and the update checks of an app left open are js/boot.js
 * (2026-11-23), a classic script of its own, so a deploy that breaks a module of the app still shows the banner for
 * the next good one (update g, g2). A "version 3" is makeSiteCopy(..., {bumps: 2}): a VERSION different from version 2.
 */
import fs from 'node:fs';
import path from 'node:path';
import {FIX, assert, sleep, snapshot, diff, openMenu} from './harness.mjs';
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

/* update g / g2: version 2 breaks the app's modules (the page stays blank); version 3 is the fix. The banner for version 3
   must still appear on the blank page (js/boot.js runs on its own), and one tap must bring version 3 in. */
async function brokenModuleThenFix(ctx, {file, plant, mk, needError}){
  const v2 = makeSiteCopy(ctx.root, {marker: mk, mutate: dir => { const f = path.join(dir, file); fs.writeFileSync(f, plant(fs.readFileSync(f, 'utf8'))); }});
  const v3 = makeSiteCopy(ctx.root, {marker: 'v3', bumps: 2});
  const {s, nav} = await firstVisit(ctx);
  const {page} = s;
  try{
    const c = checker();
    await returning(s, nav);
    await addSong(page);
    const before = await snapshot(page);
    /* the broken version 2 goes in the usual way (version 1's banner, a tap) */
    ctx.server.root = v2;
    await updateUntil(page, () => bannerShown(page), '#update did not appear for version 2');
    nav.reset();
    await page.click('#update');
    await until(async () => nav.get().loads >= 1 && await marker(page) === mk, `the tap did not reload into version 2 (${nav.text()})`, 15000);
    await sleep(1500);
    assert(await page.locator('#libList').count() === 0, `test setup: version 2 drew the library: the planted ${file} fault did not break the app`);
    if(needError) assert(s.errors.some(e => e.includes(needError)), `test setup: no page error "${needError}" (errors: ${s.errors.join(' | ') || 'none'})`);
    const k = s.errors.length;
    /* the fix is deployed while the blank page is open */
    ctx.server.root = v3;
    await updateUntil(page, () => bannerShown(page), `#update did not appear on the page broken by ${file}: the banner depends on the app's modules`);
    nav.reset();
    await page.click('#update');
    await waitNewDoc(page, nav).catch(e => c.check(false, `after the tap on the broken page: ${e.message} (${nav.text()})`));
    await sleep(2000);                       // a second reload would show up here
    const n = nav.get();
    c.check(n.committed === 1 && n.docs === 1 && n.loads === 1 && n.asked === 1, `tap on #update on the broken page: want exactly one reload, got ${nav.text()}`);
    c.check(await marker(page) === 'v3', `version 3 marker not in the DOM after the tap (${await marker(page)})`);
    c.check(await page.locator('#libList [data-open]', {hasText: 'Three-page'}).count() === 1, 'version 3 does not show the song in the library');
    const v3Name = cacheName(v3);
    const st = await swState(page);
    c.check(st.caches.length === 1 && st.caches[0] === v3Name, `caches after the fix ${JSON.stringify(st.caches)}, want only ["${v3Name}"]`);
    const keys = new Set(await cacheKeys(page, v3Name) || []);
    const missing = precachePaths(v3).filter(p => !keys.has(p));
    c.check(!missing.length, `version 3 cache lacks: ${missing.join(', ')}`);
    const d = diff(before, await snapshot(page));
    c.check(!d.length, 'library changed across the broken version and the fix: ' + d.join('; '));
    c.check(s.errors.length === k, 'page errors once version 3 loaded: ' + s.errors.slice(k).join(' | '));
    c.done();
  } finally { ctx.server.root = ctx.root; nav.close(); await s.close(); removeCopy(v2); removeCopy(v3); }
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
{
  name: 'update g: a deploy whose js/library.js throws still shows the banner, and one tap brings the fix',
  run: ctx => brokenModuleThenFix(ctx, {file: 'js/library.js', mk: 'v2-broken-module',
    plant: src => "throw new Error('planted: js/library.js is broken');\n" + src, needError: 'planted: js/library.js is broken'}),
},
{
  name: 'update g2: a deploy whose js/main.js does not parse still shows the banner, and one tap brings the fix',
  run: ctx => brokenModuleThenFix(ctx, {file: 'js/main.js', mk: 'v2-broken-main', plant: src => src + '\n)(\n'}),
},
{
  name: 'update h: an app left open finds a new version by itself, at most once an hour, never while a song is open',
  async run(ctx){
    /* Playwright's clock: Date and the page's timers are fake from the first script on, and keep flowing at real speed
       until moved. The test itself never calls registration.update(): every /sw.js request below is the app's own check. */
    const v2 = makeSiteCopy(ctx.root, {marker: 'v2'});
    const s = await ctx.session();
    const {page, context} = s;
    const nav = await navCounter(page, ctx.server);
    let online = null;
    const swHits = () => ctx.server.hits.filter(p => p === '/sw.js').length;
    /* who asked for sw.js, for the failure messages: the browser's update check sends "Service-Worker: script" */
    const t0 = Date.now(), swLog = [];
    const onReq = req => { if(/\/sw\.js(\?|$)/.test(req.url)) swLog.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${req.headers['service-worker'] || 'no Service-Worker header'} ${req.headers['sec-fetch-dest'] || ''}`); };
    ctx.server.on('request', onReq);
    const who = (n = 3) => ` [sw.js requests: ${swLog.slice(-n).join('; ')}]`;
    /* Chrome also asks for sw.js by itself: its own check for a navigation runs about a second after the page's last
       request (opening the first song fetches the PDF reader), and one update() can be followed by a second request
       (measured here: pairs 0.1 to 0.6 s apart, with js/boot.js's refill request switched off too). Before each window
       that must stay quiet, wait until no sw.js request came for 3 s, so every request counted is a new one. */
    const settle = async () => { const end = Date.now() + 20000; let n = -1, since = Date.now();
      while(Date.now() < end){ if(swLog.length !== n){ n = swLog.length; since = Date.now(); } else if(Date.now() - since >= 3000) return; await sleep(200); } };
    const setVisible = state => page.evaluate(st => { Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => st}); document.dispatchEvent(new Event('visibilitychange')); }, state);
    const jump = async ms => { const now = await page.evaluate(() => Date.now()); await page.clock.setSystemTime(now + ms); };
    try{
      const c = checker();
      await page.clock.install();
      await s.goto();
      await waitInstalled(page, cacheName(ctx.root), precachePaths(ctx.root));
      /* a returning visit (returning() reads performance, which the fake clock replaces: the controller says the same) */
      ctx.server.hits.length = 0;
      await page.reload();
      await page.waitForSelector('#libList');
      assert(await page.evaluate(() => !!navigator.serviceWorker.controller), 'the returning visit was not served by the service worker');
      nav.reset();
      /* The browser's own check of sw.js for that navigation may come a moment after the page loaded (Chrome defers it):
         let it happen while the server still has version 1, so the only checks after the switch are the app's. */
      await addSong(page);
      /* a song is open: two hours pass, no check */
      await openAt(page, 'Three-page', 1);
      await settle();
      ctx.server.root = v2;
      ctx.server.hits.length = 0;
      await page.clock.fastForward('02:00:00');
      await sleep(3000);
      c.check(!swHits(), `the app checked for an update while a song was open (${swHits()} sw.js request(s))` + who());
      let st = await swState(page);
      c.check(!st.installing && !st.waiting, 'a new worker appeared while a song was open: ' + JSON.stringify(st));
      c.check(!(await bannerOffered(page)), 'the update banner was offered while a song was open');
      const n0 = nav.get();
      c.check(!n0.docs && !n0.loads && !n0.asked, 'the page reloaded while a song was open: ' + nav.text());
      /* Back: the next tick finds the new version */
      await page.click('#vBack');
      await page.waitForSelector('#libList');
      await page.waitForFunction(() => !history.state); await sleep(300);
      nav.reset();
      await page.clock.fastForward('00:05:01');
      await until(() => bannerShown(page), 'the open app never found the new version by itself', 15000)
        .catch(e => c.check(false, `${e.message} (${swHits()} sw.js request(s) since the song was opened)`));
      c.check(swHits() > 0, 'the banner showed but no sw.js request reached the server');
      /* not again within the hour */
      await settle();
      ctx.server.hits.length = 0;
      await page.clock.fastForward('00:50:00');
      await sleep(2000);
      c.check(!swHits(), `the app checked again 50 minutes after its last check (${swHits()} sw.js request(s))` + who());
      await page.clock.fastForward('00:15:00');
      await until(async () => swHits() > 0, 'no update check 65 minutes after the last one', 10000).catch(e => c.check(false, e.message));
      /* coming back on screen checks too (no tick): the clock is moved without firing any timer */
      ctx.server.hits.length = 0;
      await jump(61 * 60e3);
      await setVisible('visible');
      await until(async () => swHits() > 0, 'coming back on screen an hour after the last check did not check', 5000).catch(e => c.check(false, e.message));
      /* hidden does not */
      await settle();
      ctx.server.hits.length = 0;
      await jump(61 * 60e3);
      await setVisible('hidden');
      await sleep(2000);
      c.check(!swHits(), `the app checked for an update while it was hidden (${swHits()} sw.js request(s))` + who());
      /* offline is quiet */
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'visible'}); });
      await settle();
      online = await goOffline(context, ctx.server);
      assert(await page.evaluate(() => navigator.onLine) === false, 'test setup: navigator.onLine is still true with the context offline');
      ctx.server.hits.length = 0;
      await jump(2 * 60 * 60e3);
      await setVisible('visible');
      await sleep(2000);
      c.check(!swHits(), `the app tried to check for an update while offline (${swHits()} sw.js request(s))` + who());
      /* back online: the 'online' event checks (two hours since the last one) */
      await online(); online = null;
      await until(async () => swHits() > 0, 'coming back online two hours after the last check did not check', 5000).catch(e => c.check(false, e.message));
      /* nothing reloaded by itself */
      const n = nav.get();
      c.check(!n.committed && !n.docs && !n.loads && !n.asked, 'the page reloaded by itself: ' + nav.text());
      st = await swState(page);
      c.check(!!st.waiting && st.caches.includes(cacheName(v2)), 'version 2 is not waiting for the tap: ' + JSON.stringify(st));
      c.check(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
      c.done();
    } finally { ctx.server.off('request', onReq); if(online) await online(); ctx.server.root = ctx.root; nav.close(); await s.close(); removeCopy(v2); }
  }
},
{
  name: 'update i: a deploy whose js/boot.js throws: the app still opens and installs, and takes the fix after a close and reopen',
  async run(ctx){
    const v2 = makeSiteCopy(ctx.root, {marker: 'v2-broken-boot', mutate: dir => {
      const f = path.join(dir, 'js', 'boot.js'); fs.writeFileSync(f, "throw new Error('planted: js/boot.js is broken');\n" + fs.readFileSync(f, 'utf8'));
    }});
    const v3 = makeSiteCopy(ctx.root, {marker: 'v3', bumps: 2});
    let fresh = null, s = null, nav = null;
    const pages = [];
    try{
      const c = checker();
      /* a first visit to that version still installs the offline copy (js/main.js's fallback register) */
      ctx.server.root = v2;
      fresh = await ctx.session();
      await fresh.goto();
      await fresh.page.waitForSelector('#libList', {timeout: 15000}).catch(() => c.check(false, 'first visit to a version whose js/boot.js throws: the library is not drawn'));
      await waitInstalled(fresh.page, cacheName(v2), precachePaths(v2), 30000)
        .catch(e => c.check(false, `first visit to a version whose js/boot.js throws: ${e.message} (js/main.js must register sw.js when window.ssBoot is missing)`));
      await fresh.close(); fresh = null;
      ctx.server.root = ctx.root;

      ({s, nav} = await firstVisit(ctx));
      const {page} = s;
      await returning(s, nav);
      await addSong(page);
      const before = await snapshot(page);
      /* version 2 goes in through version 1's banner */
      ctx.server.root = v2;
      await updateUntil(page, () => bannerShown(page), '#update did not appear for version 2');
      nav.reset();
      await page.click('#update');
      await until(async () => nav.get().loads >= 1 && await marker(page) === 'v2-broken-boot', `the tap did not reload into version 2 (${nav.text()})`, 15000);
      await page.waitForSelector('#libList [data-open]', {timeout: 10000}).catch(() => c.check(false, 'the app does not open when js/boot.js throws'));
      assert(await page.evaluate(() => window.ssBoot === undefined), 'test setup: window.ssBoot is set although js/boot.js throws');
      assert(s.errors.some(e => e.includes('planted: js/boot.js is broken')), 'test setup: no page error from the planted js/boot.js');
      /* the fix is deployed: it installs and waits, with no banner (the documented degraded path) */
      ctx.server.root = v3;
      nav.reset();
      await updateUntil(page, async () => !!(await swState(page)).waiting, 'version 3 did not install while the page with the broken js/boot.js was open');
      await sleep(2000);
      c.check(!(await bannerOffered(page)), 'a banner was offered although js/boot.js is broken (the test does not test what it says)');
      const n = nav.get();
      c.check(!n.committed && !n.docs && !n.loads && !n.asked, 'the page reloaded by itself: ' + nav.text());
      /* close the app and open it again: version 3 takes over once no page uses version 2 */
      nav.close(); nav = null;
      await page.close();
      let p2 = null, mk = null;
      for(let k = 0; k < 5 && mk !== 'v3'; k++){
        if(p2) await p2.close();
        await sleep(1000);
        p2 = await s.context.newPage();
        const errs = []; pages.push(errs);
        p2.on('pageerror', e => errs.push('pageerror: ' + e.message));
        p2.on('console', m => { if(m.type() === 'error') errs.push('console: ' + m.text()); });
        await p2.goto(ctx.base + 'index.html');
        await p2.waitForSelector('#libList, #view', {timeout: 15000}).catch(() => {});
        mk = await marker(p2);
      }
      c.check(mk === 'v3', `after closing and opening the app again the page is ${mk}, want v3`);
      await p2.waitForSelector('#libList [data-open]', {timeout: 10000}).catch(() => c.check(false, 'version 3 does not show the library'));
      c.check(await p2.evaluate(() => !!window.ssBoot), 'version 3 has no window.ssBoot');
      const v3Name = cacheName(v3);
      await until(async () => { const st = await swState(p2); return st.caches.length === 1 && st.caches[0] === v3Name && st.controller; },
        async () => `caches after the reopen ${JSON.stringify((await swState(p2)).caches)}, want only ["${v3Name}"] and a controller`, 10000).catch(e => c.check(false, e.message));
      const keys = new Set(await cacheKeys(p2, v3Name) || []);
      const missing = precachePaths(v3).filter(p => !keys.has(p));
      c.check(!missing.length, `version 3 cache lacks: ${missing.join(', ')}`);
      const d = diff(before, await snapshot(p2));
      c.check(!d.length, 'library changed across the broken version and the fix: ' + d.join('; '));
      const last = pages[pages.length - 1];
      c.check(!last.length, 'page errors in version 3: ' + last.join(' | '));
      c.done();
    } finally { ctx.server.root = ctx.root; if(nav) nav.close(); if(fresh) await fresh.close(); if(s) await s.close(); removeCopy(v2); removeCopy(v3); }
  }
},
{
  name: 'update j: the banner is hidden while a dialog is open (a tap cannot throw the dialog away) and shows when it closes',
  async run(ctx){
    const v2 = makeSiteCopy(ctx.root, {marker: 'v2'});
    const {s, nav} = await firstVisit(ctx);
    const {page} = s;
    const dialog = () => page.locator('.modal').count();
    try{
      const c = checker();
      await returning(s, nav);
      await addSong(page);
      /* a dialog is open when the update is found */
      await openMenu(page, 'Back up / Sync');
      ctx.server.root = v2;
      nav.reset();
      await updateUntil(page, () => bannerOffered(page), '#update was not offered');
      await sleep(500);
      c.check(!(await bannerShown(page)), 'the update banner shows over an open dialog');
      await page.evaluate(() => document.getElementById('update').click());      // a click that reaches it anyway
      await sleep(2000);
      let n = nav.get();
      c.check(!n.committed && !n.docs && !n.loads && !n.asked && await dialog() === 1, `a click on the hidden banner, with a dialog open, reloaded or closed it (${nav.text()}, ${await dialog()} dialog(s))`);
      await page.keyboard.press('Escape');
      await until(async () => !(await dialog()), 'the dialog did not close on Escape', 5000);
      await until(() => bannerShown(page), 'the update banner did not show once the dialog closed', 5000).catch(e => c.check(false, e.message));
      /* the banner is up and a dialog opens over it */
      await openMenu(page, 'Back up / Sync');
      await sleep(300);
      c.check(!(await bannerShown(page)), 'the update banner stays on top of a dialog opened after it');
      await page.keyboard.press('Escape');
      await until(async () => !(await dialog()), 'the dialog did not close on Escape', 5000);
      await until(() => bannerShown(page), 'the update banner did not come back after the second dialog', 5000).catch(e => c.check(false, e.message));
      /* and then the tap works as always: one reload into version 2 */
      nav.reset();
      await page.click('#update');
      await waitNewDoc(page, nav).catch(e => c.check(false, `after the tap: ${e.message} (${nav.text()})`));
      await sleep(2000);
      n = nav.get();
      c.check(n.committed === 1 && n.docs === 1 && n.loads === 1 && n.asked === 1, `tap on #update: want exactly one reload, got ${nav.text()}`);
      c.check(await marker(page) === 'v2', 'version 2 marker not in the DOM after the tap');
      c.check(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
      c.done();
    } finally { ctx.server.root = ctx.root; nav.close(); await s.close(); removeCopy(v2); }
  }
},
];

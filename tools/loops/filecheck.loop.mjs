/*
 * File-check loops (2026-11-24): the worker uses a stored app file only when its bytes are the file.
 *
 * Cache Storage belongs to the whole github.io address, so a script on ANOTHER site of that address can write into this app's
 * cache. These loops are that other site: each one changes Cache Storage from a page (c.put / c.delete, exactly what such a
 * script could do), then reads back what the APP does: which code runs (a marker the replaced file sets), what the answer
 * looks like (headers), what the cache holds afterwards (SHA-256 of every entry against the file on the server), and whether
 * the app opens with no network once one online visit has put things right.
 *
 *   a  a stored js/googleauth.js is replaced (with a working copy that also sets a marker) and so is an icon the page
 *      has not asked for: online, the script never runs, the app starts, the Problem log names both files, and the refill
 *      puts the real bytes back
 *   b  the same with no network: it never runs; one online visit and the app opens offline again
 *   c  a stored index.html (and the folder entry './') is replaced: online and offline the replaced page is never shown
 *   d  right bytes stored with a Refresh header, a CSP header and a wrong Content-Type: the page does not leave, the answer
 *      carries the worker's own Content-Type and none of the stored headers
 *   e  an entry for a path that is not in PRECACHE (js/extra.js, privacy.html) is never served from the cache
 *   f  other bytes stored under js/main.js?x=1 are never served, with the real file stored or not
 *   g  the server sends other bytes for one file (right type, same VERSION): the refill stores nothing and says 'refused'
 *   h  a deploy in which one file does not match its table: the install fails and the old version keeps working
 *   i  another page fills the NEXT version's cache with an entry stored under a Vary header (a name it can guess: VERSION is a
 *      date; in Safari's engine the install's own write does not replace it): the update still installs within a few tries
 *   (j, the checks run in a Windows-style git checkout, is tools/loops/filecheck-git.loop.mjs)
 *
 * No Chromium-only tool (CDP) is used, so all of them run under WebKit too (SS_BROWSER=webkit).
 */
import fs from 'node:fs';
import path from 'node:path';
import {assert, sleep} from './harness.mjs';
import {cacheName, precachePaths, waitInstalled, goOffline, intercept, makeSiteCopy, removeCopy, swState, cacheKeys, askUpdate, until, toRepoPath} from './site-copy.mjs';
import {sha256} from './harness.mjs';

const EVIL = 'window.__ssEvil = (window.__ssEvil || 0) + 1;';
const EVIL_PAGE = '<!doctype html><title>EVIL</title><p>This page was put in the cache by another site.</p>';
const fileOf = (ctx, rel) => fs.readFileSync(path.join(ctx.root, toRepoPath(rel)));
const hex = buf => sha256(buf);

/* Another site's write into the cache: `rel` is resolved against the page ('./' is the folder itself). */
const put = (page, name, rel, body, headers = {}, reqHeaders = {}) => page.evaluate(async ([name, rel, b64, headers, reqHeaders]) => {
  const c = await caches.open(name);
  await c.put(new Request(new URL(rel, document.baseURI).href, {headers: reqHeaders}), new Response(Uint8Array.from(atob(b64), ch => ch.charCodeAt(0)), {status: 200, headers}));
}, [name, rel, Buffer.from(body).toString('base64'), headers, reqHeaders]);
const del = (page, name, rel) => page.evaluate(async ([name, rel]) => (await caches.open(name)).delete(new URL(rel, document.baseURI).href), [name, rel]);
/* SHA-256 of what is stored under `rel` (null when nothing). */
const stored = (page, name, rel) => page.evaluate(async ([name, rel]) => {
  const r = await (await caches.open(name)).match(new URL(rel, document.baseURI).href);
  return r ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', await r.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('') : null;
}, [name, rel]);
/* The entries of PRECACHE whose stored bytes are not the server's file. */
async function wrongEntries(ctx, page, name){
  const bad = [];
  for(const p of precachePaths(ctx.root)){
    const want = hex(fileOf(ctx, p || 'index.html')), got = await stored(page, name, p || './');
    if(got !== want) bad.push(p || './');
  }
  return bad;
}
/* A request made by the page (so it goes through the worker): status, headers that matter, and the SHA-256 of the body. */
const get = (page, url) => page.evaluate(async url => {
  try{
    const r = await fetch(url, {cache: 'no-store'});
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await r.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
    return {status: r.status, type: r.headers.get('content-type'), refresh: r.headers.get('refresh'), evil: r.headers.get('x-evil'), csp: r.headers.get('content-security-policy'), sha};
  }catch(e){ return {error: String(e && e.message || e)}; }
}, url);
const marker = page => page.evaluate(() => window.__ssEvil || 0);
const problems = page => page.evaluate(() => { try{ return JSON.parse(localStorage.getItem('ss-problems') || '[]'); }catch(e){ return []; } });
/* The page hears the worker's answer to js/boot.js's 'ss-heal' (window.__ssHeal), from the first script on. */
const listenHeal = context => context.addInitScript(() => {
  if(navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', e => { if(e.data && e.data.type === 'ss-heal') window.__ssHeal = e.data.result; });
});
/* The app comes back on screen (no reload): what a tablet does when ChartShark is switched back to. */
const backOnScreen = page => page.evaluate(() => { window.__ssHeal = null; Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'visible'}); document.dispatchEvent(new Event('visibilitychange')); });
const healAnswer = (page, what) => until(() => page.evaluate(() => window.__ssHeal), what, 15000);
const libShown = (page, ms = 15000) => page.waitForSelector('#libList', {timeout: ms}).then(() => true, () => false);
/* A returning visit (the page is controlled when it loads), with the worker's refill answers heard. */
async function installed(ctx){
  const s = await ctx.session();
  await listenHeal(s.context);
  await s.goto();
  await waitInstalled(s.page, cacheName(ctx.root), precachePaths(ctx.root));
  await s.page.reload(); await s.page.waitForSelector('#libList');
  assert(await s.page.evaluate(() => !!navigator.serviceWorker.controller), 'test setup: the returning visit is not controlled');
  await sleep(500);
  return s;
}
/* Everything in the cache is the server's bytes again (the refill is done). */
async function refilled(ctx, page, name, what){
  await waitInstalled(page, name, precachePaths(ctx.root), 20000).catch(e => { throw new Error(`${what}: ${e.message}`); });
  const bad = await wrongEntries(ctx, page, name);
  assert(!bad.length, `${what}: stored entries that are not the server's bytes: ${bad.join(', ')}`);
}
async function openedPage(context){
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  return {page, errors};
}

export const loops = [
{
  name: 'filecheck a: a stored js/googleauth.js is replaced: online it never runs, the log names it, the refill puts the real file back',
  async run(ctx){
    const s = await installed(ctx);
    try{
      const {page} = s, name = cacheName(ctx.root);
      const real = fileOf(ctx, 'js/googleauth.js');
      /* a working copy of the file with a marker added: with no check the app starts AND the marker is set */
      await put(page, name, 'js/googleauth.js', Buffer.concat([real, Buffer.from('\n' + EVIL + '\n')]), {'Content-Type': 'text/javascript'});
      assert(await stored(page, name, 'js/googleauth.js') !== hex(real), 'test setup: the replacement was not stored');
      /* and a file the page does not ask for at start (the refill's own look at the cache must find it), stored with a Vary header
         and the request header it names: a plain lookup does not match it, so deleting it must not depend on the request's headers */
      await put(page, name, 'icons/icon-512.png', 'this is not a PNG', {'Content-Type': 'image/png', 'Vary': 'X-Foo'}, {'X-Foo': 'a'});
      await page.reload();
      assert(await libShown(page), 'the app did not start after a stored js/googleauth.js was replaced');
      assert(await marker(page) === 0, 'the replaced js/googleauth.js RAN (its marker is set): another site can put its own code in the app');
      const said = await healAnswer(page, 'the worker never answered the refill request');
      assert(said === 'healed', `the worker answered "${said}" to the refill, want "healed"`);
      await refilled(ctx, page, name, 'after the refill');
      const keys = await cacheKeys(page, name) || [], want = precachePaths(ctx.root);
      assert(keys.length === want.length, `the cache holds ${keys.length} entries after the refill, want ${want.length} (one per PRECACHE entry): ${keys.filter((k, i) => keys.indexOf(k) !== i).map(k => k || './').join(', ') || 'no duplicate named'}`);
      const log = (await problems(page)).filter(p => p.kind === 'offline copy');
      for(const f of ['js/googleauth.js', 'icons/icon-512.png']) assert(log.some(p => p.msg.includes(f)), `the Problem log has no line naming ${f}: ` + JSON.stringify((await problems(page)).map(p => p.kind + ': ' + p.msg)));
      assert(!(await page.locator('.modal').count()), 'a dialog opened');
      assert(!/went wrong/i.test(await page.locator('#toast').textContent()), 'a "Something went wrong" toast showed: the log line should be quiet');
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
  }
},
{
  name: 'filecheck b: the same with no network: it never runs; one online visit and the app opens offline again',
  async run(ctx){
    const s = await installed(ctx);
    let online = null;
    try{
      const {page} = s, name = cacheName(ctx.root);
      await put(page, name, 'js/googleauth.js', Buffer.concat([fileOf(ctx, 'js/googleauth.js'), Buffer.from('\n' + EVIL + '\n')]), {'Content-Type': 'text/javascript'});
      await page.close();
      online = await goOffline(s.context, ctx.server);
      let {page: p2} = await openedPage(s.context);
      await p2.goto(ctx.base + 'index.html').catch(() => {});
      await sleep(2500);
      assert(await marker(p2) === 0, 'offline, the replaced js/googleauth.js RAN (its marker is set)');
      const opened = await p2.locator('#libList').count();
      console.log(`  info: offline with a replaced js/googleauth.js the app ${opened ? 'opened (?)' : 'did not open (as decided: the file is not run, and there is no good copy to fall back on)'}`);
      assert(!opened, 'offline, the app opened although its js/googleauth.js was replaced and no good copy exists: something ran the replaced file or a stale copy');
      await p2.close();
      /* one online visit */
      await online(); online = null;
      const {page: p3, errors} = await openedPage(s.context);
      await p3.goto(ctx.base + 'index.html');
      assert(await libShown(p3), 'online, the app did not start after the replaced file was dropped');
      assert(await marker(p3) === 0, 'online, the replaced js/googleauth.js ran');
      await refilled(ctx, p3, name, 'after one online visit');
      await p3.close();
      /* offline again: works */
      online = await goOffline(s.context, ctx.server);
      const {page: p4, errors: e4} = await openedPage(s.context);
      await p4.goto(ctx.base + 'index.html');
      assert(await libShown(p4), 'after one online visit the app still does not open offline');
      assert(await marker(p4) === 0, 'offline, after the refill, the marker is set');
      assert(errors.length === 0 && e4.length === 0, 'page errors: ' + [...errors, ...e4].join(' | '));
    } finally { if(online) await online(); await s.close(); }
  }
},
{
  name: 'filecheck c: a stored index.html (and the folder entry) is replaced: online and offline the replaced page is never shown',
  async run(ctx){
    const s = await installed(ctx);
    let online = null;
    try{
      const {page, context} = s, name = cacheName(ctx.root);
      const evilBoth = async () => { for(const rel of ['./', 'index.html']) await put(page, name, rel, EVIL_PAGE, {'Content-Type': 'text/html'}); };
      /* online: both ways of opening the app */
      for(const url of [ctx.base, ctx.base + 'index.html']){
        await evilBoth();
        const p = await context.newPage();
        await p.goto(url);
        assert(await libShown(p), `online, opening ${url} did not show the app`);
        assert(!/EVIL/.test(await p.title()) && !/another site/.test(await p.content()), `online, opening ${url} showed the replaced page`);
        await p.close();
      }
      await refilled(ctx, page, name, 'after the online visits');
      /* offline: the replaced page is not shown (and there is no good copy until one online visit) */
      await evilBoth();
      await page.close();
      online = await goOffline(context, ctx.server);
      for(const url of [ctx.base, ctx.base + 'index.html']){
        const p = await context.newPage();
        await p.goto(url).catch(() => {});
        await sleep(500);
        const html = await p.content().catch(() => '');
        assert(!/EVIL/.test(await p.title().catch(() => '')) && !/another site/.test(html), `offline, opening ${url} showed the replaced page`);
        await p.close();
      }
      await online(); online = null;
      /* one online visit puts it right; then offline works again */
      const v = await context.newPage();
      await v.goto(ctx.base);
      assert(await libShown(v), 'online again, the app did not start');
      await refilled(ctx, v, name, 'after one more online visit');
      await v.close();
      online = await goOffline(context, ctx.server);
      const o = await context.newPage();
      await o.goto(ctx.base);
      assert(await libShown(o), 'after one online visit the app still does not open offline');
    } finally { if(online) await online(); await s.close(); }
  }
},
{
  name: 'filecheck d: right bytes stored with a Refresh header, a CSP header and a wrong Content-Type: nothing of them reaches the page',
  async run(ctx){
    const s = await installed(ctx);
    try{
      const {page, context} = s, name = cacheName(ctx.root);
      const hostile = {'Refresh': '0;url=' + ctx.base + 'privacy.html', 'Content-Type': 'text/plain', 'X-Evil': 'yes', 'Content-Security-Policy': "default-src 'none'"};
      for(const rel of ['./', 'index.html', 'js/util.js']) await put(page, name, rel, fileOf(ctx, rel === './' ? 'index.html' : rel), hostile);
      assert(await stored(page, name, 'js/util.js') === hex(fileOf(ctx, 'js/util.js')), 'test setup: the right bytes were not stored');
      const p = await context.newPage(), errors = [];
      p.on('pageerror', e => errors.push('pageerror: ' + e.message));
      await p.goto(ctx.base);
      assert(await libShown(p), 'the app did not start with hostile headers on its stored files');
      await sleep(3000);                    // a Refresh header would have moved the page by now
      assert(p.url() === ctx.base, `the page left ${ctx.base} for ${p.url()}: a stored Refresh header was passed on`);
      const expect = {'js/util.js': 'text/javascript; charset=utf-8', 'index.html': 'text/html; charset=utf-8', './': 'text/html; charset=utf-8'};
      for(const [rel, type] of Object.entries(expect)){
        const r = await get(p, rel === './' ? ctx.base : rel);
        assert(!r.error && r.status === 200, `${rel}: ${r.error || 'HTTP ' + r.status}`);
        assert(r.type === type, `${rel} came with Content-Type "${r.type}", want the worker's own "${type}"`);
        assert(r.refresh === null && r.evil === null && r.csp === null, `${rel} carried stored headers: refresh=${r.refresh} x-evil=${r.evil} csp=${r.csp}`);
        assert(r.sha === hex(fileOf(ctx, rel === './' ? 'index.html' : rel)), `${rel}: the bytes sent are not the file`);
      }
      assert(errors.length === 0, 'page errors: ' + errors.join(' | '));
    } finally { await s.close(); }
  }
},
{
  name: 'filecheck e: an entry for a path that is not in PRECACHE (js/extra.js, privacy.html) is never served from the cache',
  async run(ctx){
    const s = await installed(ctx);
    let online = null;
    try{
      const {page, context} = s, name = cacheName(ctx.root);
      await put(page, name, 'js/extra.js', EVIL, {'Content-Type': 'text/javascript'});
      await put(page, name, 'privacy.html', EVIL_PAGE, {'Content-Type': 'text/html'});
      const privacy = hex(fs.readFileSync(path.join(ctx.root, 'privacy.html')));
      const x = await get(page, 'js/extra.js'), pr = await get(page, 'privacy.html');
      assert(x.status === 404, `js/extra.js (not an app file, absent on the server) answered ${x.error || 'HTTP ' + x.status}: served from the cache?`);
      assert(pr.status === 200 && pr.sha === privacy, 'privacy.html was not the server\'s file: ' + (pr.error || `HTTP ${pr.status}, sha ${String(pr.sha).slice(0, 12)}`));
      const p = await context.newPage();
      await p.goto(ctx.base + 'privacy.html');
      assert(!/EVIL/.test(await p.title()), 'privacy.html opened as the replaced page');
      await p.close();
      /* offline: neither is answered from the cache */
      await page.close();
      online = await goOffline(context, ctx.server);
      const q = await context.newPage();
      await q.goto(ctx.base + 'index.html');
      assert(await libShown(q), 'test setup: the app did not open offline');
      const ox = await get(q, 'js/extra.js'), op = await get(q, 'privacy.html');
      assert(ox.error, `offline, js/extra.js was answered (HTTP ${ox.status}): served from the cache`);
      assert(op.error, `offline, privacy.html was answered (HTTP ${op.status}): served from the cache`);
      const n = await context.newPage();
      await n.goto(ctx.base + 'privacy.html').catch(() => {});
      assert(!/EVIL/.test(await n.title().catch(() => '')) && !/another site/.test(await n.content().catch(() => '')), 'offline, privacy.html showed the replaced page');
    } finally { if(online) await online(); await s.close(); }
  }
},
{
  name: 'filecheck f: other bytes stored under js/main.js?x=1 are never served, with the real file stored or not',
  async run(ctx){
    const s = await installed(ctx);
    let online = null;
    try{
      const {page} = s, name = cacheName(ctx.root);
      const real = hex(fileOf(ctx, 'js/main.js'));
      await put(page, name, 'js/main.js?x=1', EVIL, {'Content-Type': 'text/javascript'});
      let r = await get(page, 'js/main.js?x=1');
      assert(r.status === 200 && r.sha === real, `js/main.js?x=1 with the real file stored: answered ${r.error || 'HTTP ' + r.status} with sha ${String(r.sha).slice(0, 12)}, want js/main.js ${real.slice(0, 12)}`);
      /* the real entry gone: the answer comes from the server, not from the ?x=1 entry */
      assert(await del(page, name, 'js/main.js'), 'test setup: the real js/main.js entry was not there to delete');
      ctx.server.hits.length = 0;
      r = await get(page, 'js/main.js?x=1');
      assert(r.status === 200 && r.sha === real, `js/main.js?x=1 with only the ?x=1 entry stored: answered ${r.error || 'HTTP ' + r.status} with sha ${String(r.sha).slice(0, 12)} (want the server's js/main.js ${real.slice(0, 12)})`);
      assert(ctx.server.hits.includes('/js/main.js'), 'the answer did not come from the server: it was served from the ?x=1 entry');
      /* no network: nothing to serve, and the ?x=1 entry is not it */
      await put(page, name, 'js/main.js?x=1', EVIL, {'Content-Type': 'text/javascript'});
      await del(page, name, 'js/main.js');
      online = await goOffline(s.context, ctx.server);
      r = await get(page, 'js/main.js?x=1');
      assert(r.error, `offline, js/main.js?x=1 was answered (HTTP ${r.status}, sha ${String(r.sha).slice(0, 12)}): served from the ?x=1 entry`);
    } finally { if(online) await online(); await s.close(); }
  }
},
{
  name: 'filecheck g: the server sends other bytes for a file (right type, same VERSION): the refill stores nothing and says refused',
  async run(ctx){
    const s = await installed(ctx);
    const file = '/js/nudge.js';
    let wrong = true;
    const restore = intercept(ctx.server, (req, res, p) => {
      if(p !== file || !wrong) return false;
      ctx.server.hits.push(p);
      res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache'}).end('/* not the file */ window.__ssEvil = 1;\n');
      return true;
    });
    try{
      const {page} = s, name = cacheName(ctx.root);
      await page.evaluate(async () => { for(const k of await caches.keys()) await caches.delete(k); });
      await backOnScreen(page);
      const said = await healAnswer(page, 'the worker never answered the refill request');
      assert(said === 'refused', `with ${file} sent as other bytes (status 200, text/javascript) the refill answered "${said}", want "refused"`);
      await sleep(500);
      const keys = await cacheKeys(page, name) || [];
      assert(!keys.length, `the refill stored ${keys.length} file(s) although ${file} came back as other bytes: ${keys.slice(0, 4).map(k => k || './').join(', ')}`);
      /* the server is right again: the next time on screen fills the copy with its own bytes */
      wrong = false;
      await backOnScreen(page);
      await refilled(ctx, page, name, 'with the right bytes the refill did not fill the copy');
      assert(await healAnswer(page, 'no answer') === 'healed', 'the refill did not answer "healed"');
    } finally { restore(); await s.close(); }
  }
},
{
  name: 'filecheck h: a deploy in which one file does not match its table: the install fails, the old version keeps working',
  async run(ctx){
    const changed = 'js/nudge.js';
    /* `rehash: false`: the table is the one --bump wrote BEFORE the file changed, as if the file were a stale copy at the server's edge */
    const v2 = makeSiteCopy(ctx.root, {marker: 'v2-half-deployed', rehash: false, mutate: dir => fs.appendFileSync(path.join(dir, changed), '\n/* changed after the table was written */\n')});
    const s = await installed(ctx);
    let online = null;
    try{
      const {page} = s, v1Name = cacheName(ctx.root);
      await page.locator('#libList').waitFor();
      ctx.server.root = v2;
      ctx.server.hits.length = 0;
      /* the new worker is fetched, downloads every file, checks them, and fails: no banner, nothing waiting */
      let tries = 0, st = null;
      for(; tries < 3; tries++){
        await askUpdate(page);
        const tried = await until(async () => ctx.server.hits.includes('/' + changed) && !(await swState(page)).installing, null, 10000).then(() => true, () => false);
        if(tried){ st = await swState(page); break; }
      }
      assert(st, 'version 2 never tried to install (3 update() calls)');
      await sleep(2500);
      st = await swState(page);
      assert(!st.waiting && !st.installing && st.active === 'activated' && st.controller, 'worker state after the failed install: ' + JSON.stringify(st));
      assert(!(await page.evaluate(() => { const b = document.querySelector('#update'); return !!b && !b.hidden; })), '#update is offered for a deploy that failed to install');
      assert(st.caches.includes(v1Name), `version 1's cache ${v1Name} is gone: ${JSON.stringify(st.caches)}`);
      /* the old version still runs, online and offline */
      assert(await page.evaluate(() => document.querySelector('meta[name=ss-marker]')?.content || null) === null, 'the page shows version 2');
      await page.reload(); assert(await libShown(page), 'online, the old version does not start after the failed update');
      assert(await page.evaluate(() => document.querySelector('meta[name=ss-marker]')?.content || null) === null, 'after a reload the page shows version 2');
      online = await goOffline(s.context, ctx.server);
      await page.reload();
      assert(await libShown(page, 10000), 'offline, the old version does not start after the failed update');
      assert(await page.evaluate(() => document.querySelector('meta[name=ss-marker]')?.content || null) === null, 'offline, the page shows version 2');
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    } finally { if(online) await online(); ctx.server.root = ctx.root; await s.close(); removeCopy(v2); }
  }
},
{
  name: 'filecheck i: another page fills the NEXT version\'s cache with an entry stored under a Vary header: the update still installs',
  async run(ctx){
    const v2 = makeSiteCopy(ctx.root, {marker: 'v2-squatted'});
    const s = await installed(ctx);
    try{
      const {page} = s, v2Name = cacheName(v2);
      /* the cache of the version that is NOT out yet; the entry is not the file, and carries a Vary header and the request header it names */
      await put(page, v2Name, 'js/nudge.js', EVIL, {'Content-Type': 'text/javascript', 'Vary': 'X-Foo'}, {'X-Foo': 'a'});
      ctx.server.root = v2;
      let tries = 0, waiting = false;
      for(; tries < 4 && !waiting; ){
        tries++;
        await askUpdate(page);
        waiting = await until(async () => (await swState(page)).waiting, null, 8000).then(() => true, () => false);
      }
      assert(waiting, `version 2 never installed in ${tries} tries: an entry another page stored in its cache keeps every update from installing`);
      assert(await page.evaluate(() => { const b = document.querySelector('#update'); return !!b && !b.hidden; }), '#update is not offered although version 2 is waiting');
      assert(await marker(page) === 0, 'the planted marker ran');
      console.log(`  info: version 2 installed after ${tries} update() call(s)`);
    } finally { ctx.server.root = ctx.root; await s.close(); removeCopy(v2); }
  }
},
];

/*
 * Live loops (needs --live <url>, e.g. https://jhoffmanteacher.github.io/setlist-stand/): the deployed site, read only.
 * Only GET requests; nothing is written anywhere. The sub-path comes from the URL, never from a constant.
 *
 *   j  every file sw.js precaches, as the live site serves it, has the SHA-256 of the source of truth, and the live
 *      sw.js has the source's VERSION. Source of truth: `--live-compare=git` (default) = origin/main (git show, run in
 *      the repo); `--live-compare=tree` (or SS_LIVE_COMPARE=tree) = the folder the loops serve (ctx.root), which is
 *      what a local validation against a local server needs. `--wait <s>` (or ctx.opts.wait, SS_LIVE_WAIT) retries a
 *      mismatch for that long, so a CI run can wait for the Pages deploy; default 0.
 *   k  a fresh browser installs the live site from its sub-path: the worker's scope is the live URL, it controls the
 *      page, the manifest's start_url/scope/id and every icon resolve under the sub-path (each icon 200, PNG, the
 *      size its `sizes` says, read from the PNG header), no request leaves the live host, no page errors; then with
 *      the network cut the page reloads and shows the app.
 */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {ROOT, assert, sleep, sha256} from './harness.mjs';
import {parsePrecache, parseVersion, toRepoPath, until} from './site-copy.mjs';

const argv = process.argv.slice(2);
const argOf = name => { const eq = argv.find(a => a.startsWith(name + '=')); if(eq) return eq.slice(name.length + 1); const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const compareMode = () => argOf('--live-compare') || process.env.SS_LIVE_COMPARE || 'git';
const waitSeconds = ctx => Number(ctx.opts.wait || argOf("--wait") || process.env.SS_LIVE_WAIT || 0) || 0;

/* The source of truth: (repo path) -> Buffer. */
function source(ctx){
  const mode = compareMode();
  if(mode === 'tree') return {mode: 'tree ' + ctx.root, read: p => fs.readFileSync(path.join(ctx.root, p))};
  assert(mode === 'git', `--live-compare must be tree or git, not "${mode}"`);
  try{ execFileSync('git', ['rev-parse', '--verify', 'origin/main'], {cwd: ROOT, stdio: 'ignore'}); }
  catch(e){ throw new Error('no origin/main in ' + ROOT + ' (git fetch first, or --live-compare=tree)'); }
  return {mode: 'git origin/main', read: p => execFileSync('git', ['show', `origin/main:${p}`], {cwd: ROOT, maxBuffer: 64 << 20})};
}
async function get(url){
  const u = new URL(url); u.searchParams.set('loops', Date.now());     // past any CDN copy; static hosts ignore the query
  const r = await fetch(u, {method: 'GET', cache: 'no-store', redirect: 'follow'});
  return {status: r.status, type: r.headers.get('content-type') || '', body: Buffer.from(await r.arrayBuffer())};
}
const pngSize = b => (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null;

export const loops = [
{
  name: 'live j: deployed files equal the repo',
  needs: ['live'],
  async run(ctx){
    const src = source(ctx);
    const swSrc = src.read('sw.js').toString('utf8');
    const entries = parsePrecache(swSrc), version = parseVersion(swSrc);
    const deadline = Date.now() + waitSeconds(ctx) * 1000;
    for(let round = 1; ; round++){
      const bad = [];
      const swLive = await get(new URL('sw.js', ctx.live).href);
      if(swLive.status !== 200) bad.push(`sw.js: HTTP ${swLive.status}`);
      else{
        let lv = null; try{ lv = parseVersion(swLive.body.toString('utf8')); }catch(e){}
        if(lv !== version) bad.push(`sw.js VERSION live ${lv}, ${src.mode} ${version}`);
        if(sha256(swLive.body) !== sha256(Buffer.from(swSrc))) bad.push('sw.js: bytes differ');
      }
      for(const e of entries){
        const repo = toRepoPath(e), url = new URL(e, ctx.live).href;
        const r = await get(url);
        if(r.status !== 200){ bad.push(`${e}: HTTP ${r.status}`); continue; }
        const want = sha256(src.read(repo)), got = sha256(r.body);
        if(want !== got) bad.push(`${e}: live sha256 ${got.slice(0, 12)} (${r.body.length} B) != ${src.mode} ${want.slice(0, 12)}`);
      }
      if(!bad.length){ console.log(`  info: ${entries.length} precached files + sw.js equal ${src.mode} (VERSION ${version}) after ${round} round(s)`); return; }
      if(Date.now() + 15000 > deadline) throw new Error(`live ${ctx.live} differs from ${src.mode} (${bad.length}): ${bad.slice(0, 12).join('; ')}`);
      console.log(`  waiting for the deploy (${bad.length} differences, round ${round}): ${bad.slice(0, 3).join('; ')}`);
      await sleep(15000);
    }
  }
},
{
  name: 'live k: live site installs and works offline from its sub-path',
  needs: ['live'],
  async run(ctx){
    const live = new URL(ctx.live).href, host = new URL(live).host;
    const context = await ctx.browser.newContext({viewport: {width: 1280, height: 800}, serviceWorkers: 'allow'});
    try{
      const page = await context.newPage();
      const errors = [], urls = [];
      page.on('pageerror', e => errors.push('pageerror: ' + e.message));
      page.on('console', m => { if(m.type() === 'error') errors.push('console: ' + m.text()); });
      context.on('request', r => urls.push(r.url()));
      await page.goto(live);
      await page.waitForSelector('#libList', {timeout: 30000});
      const reg = await until(() => page.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration();
        return r && r.active && r.active.state === 'activated' && navigator.serviceWorker.controller ? {scope: r.scope, script: r.active.scriptURL} : null;
      }), 'the service worker did not activate and control the live page in 60 s', 60000, 300);
      assert(reg.scope === live, `service worker scope ${reg.scope}, want ${live}`);
      assert(reg.script === new URL('sw.js', live).href, `service worker script ${reg.script}`);
      /* the cache is full before going offline */
      const want = parsePrecache((await get(new URL('sw.js', live).href)).body.toString('utf8')).map(e => new URL(e, live).href);
      await until(() => page.evaluate(async want => {
        const k = (await caches.keys()).find(n => n.startsWith('setlist-stand-')); if(!k) return false;
        const have = new Set((await (await caches.open(k)).keys()).map(r => r.url));
        return want.every(u => have.has(u));
      }, want), 'the live cache never held every PRECACHE entry', 60000, 300);

      /* the manifest, resolved under the sub-path */
      const manHref = await page.evaluate(() => document.querySelector('link[rel=manifest]')?.href);
      assert(manHref && manHref.startsWith(live), `manifest link ${manHref} is not under ${live}`);
      const man = await get(manHref);
      assert(man.status === 200, `manifest HTTP ${man.status}`);
      const m = JSON.parse(man.body.toString('utf8'));
      const under = (field, v) => { const u = new URL(v, manHref).href; assert(u.startsWith(live), `manifest ${field} "${v}" resolves to ${u}, outside ${live}`); return u; };
      under('start_url', m.start_url); under('scope', m.scope);
      if(m.id) under('id', m.id);
      assert(Array.isArray(m.icons) && m.icons.length, 'manifest has no icons');
      for(const ic of m.icons){
        const u = under('icon', ic.src), r = await get(u);
        assert(r.status === 200, `icon ${ic.src}: HTTP ${r.status}`);
        const sz = pngSize(r.body);
        assert(sz, `icon ${ic.src} is not a PNG`);
        const sizes = String(ic.sizes || '').split(/\s+/).filter(Boolean);
        assert(sizes.includes(`${sz[0]}x${sz[1]}`), `icon ${ic.src} is ${sz[0]}x${sz[1]}, manifest says "${ic.sizes}"`);
      }
      const hosts = [...new Set(urls.filter(u => /^https?:/.test(u)).map(u => new URL(u).host))];
      assert(hosts.length === 1 && hosts[0] === host, `hosts requested: ${hosts.join(', ')} (want only ${host})`);
      assert(errors.length === 0, 'page errors online: ' + errors.join(' | '));

      /* offline: the context is offline and every request is refused (the worker's too, through the route) */
      let tried = [];
      await context.route('**/*', r => { tried.push(r.request().url()); return r.abort('internetdisconnected'); });
      await context.setOffline(true);
      await page.reload();
      await page.waitForSelector('#libList', {timeout: 15000}).catch(() => { throw new Error('the live page did not reload offline'); });
      assert(await page.evaluate(() => !!navigator.serviceWorker.controller && !!window.pdfjsLib && !!window.PDFLib && !!window.JSZip), 'offline reload: not controlled, or a vendor library missing');
      assert(await page.locator('#tLib').isVisible() && await page.locator('#tSets').isVisible(), 'offline reload: the tabs are not shown');
      const leaked = await page.evaluate(() => fetch('tools/README.md?x=' + Date.now()).then(r => r.ok, () => false));
      assert(!leaked, 'an uncached URL still loads offline: the network is not cut off, the offline check proves nothing');
      errors.length = 0;   // the probe's own failure
      await page.reload();
      await page.waitForSelector('#libList', {timeout: 15000});
      const other = tried.filter(u => !/\/sw\.js(\?|$)/.test(u) && !/tools\/README\.md/.test(u));
      assert(!other.length, 'offline reload needed the network for: ' + [...new Set(other)].join(', '));
      console.log(`  info: offline, the browser asked the network for ${tried.length} URL(s), all refused: ${[...new Set(tried.map(u => new URL(u).pathname))].join(', ') || 'none'}`);
      assert(errors.length === 0, 'page errors offline: ' + errors.join(' | '));
    } finally { await context.close(); }
  }
},
];

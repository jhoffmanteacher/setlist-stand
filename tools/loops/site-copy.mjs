/*
 * Shared pieces for the service-worker loops (update.loop.mjs, offline.loop.mjs, live.loop.mjs).
 *
 *  - parsePrecache / parseVersion / toRepoPath: read sw.js the way tools/checks.mjs does.
 *  - makeSiteCopy(from, {marker, mutate}): "version 2" of the site = a copy of the served folder (no node_modules,
 *    no .git) with <meta name="ss-marker" content="..."> in index.html and `node tools/checks.mjs --bump` run IN THE
 *    COPY (only --bump: the full checks compare with origin/main). `mutate(dir)` can then plant a fault.
 *  - navCounter(page): reloads counted by the browser, several ways (see the comment there).
 *  - waitInstalled(page): the worker is active, controls the page, and its cache holds every PRECACHE entry.
 *  - throttleProxy(target, {kbps, latency}): a local HTTP proxy that slows EVERYTHING down, service worker included.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {TMP, sleep, assert} from './harness.mjs';

/* ---------- sw.js, read as tools/checks.mjs reads it ---------- */
function stripJsComments(src){
  let out = '';
  for(let i = 0; i < src.length; i++){
    const c = src[i], n = src[i + 1];
    if(c === '"' || c === "'" || c === '`'){
      const q = c; out += c;
      for(i++; i < src.length && src[i] !== q; i++){ out += src[i]; if(src[i] === '\\') out += src[++i] ?? ''; }
      out += src[i] ?? '';
    } else if(c === '/' && n === '/'){ while(i < src.length && src[i] !== '\n') i++; out += '\n'; }
    else if(c === '/' && n === '*'){ const end = src.indexOf('*/', i + 2); out += src.slice(i, end < 0 ? src.length : end + 2).replace(/[^\n]/g, ' '); i = end < 0 ? src.length : end + 1; }
    else out += c;
  }
  return out;
}
export function parsePrecache(src){
  const m = /const\s+PRECACHE\s*=\s*\[([\s\S]*?)\]/.exec(src);
  if(!m) throw new Error('could not find `const PRECACHE = [...]` in sw.js');
  return [...stripJsComments(m[1]).matchAll(/(['"`])([^'"`]*)\1/g)].map(x => x[2]);
}
export function parseVersion(src){
  const m = /const\s+VERSION\s*=\s*['"]([^'"]+)['"]/.exec(src);
  if(!m) throw new Error('could not find `const VERSION = ...` in sw.js');
  return m[1];
}
export const toRepoPath = u => (u === './' || u === '' ? 'index.html' : u.replace(/^\.\//, ''));
export const swOf = root => fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
export const cacheName = root => 'setlist-stand-' + parseVersion(swOf(root));
/* Every PRECACHE entry as a URL path relative to the site ('./' stays '', i.e. the folder itself). */
export const precachePaths = root => parsePrecache(swOf(root)).map(u => (u === './' ? '' : u.replace(/^\.\//, '')));

/* ---------- version 2 ---------- */
let copies = 0;
export function makeSiteCopy(from, {marker = 'v2', mutate} = {}){
  const dir = path.join(TMP, `site-${marker}-${process.pid}-${++copies}`);
  const skip = new Set(['node_modules', '.git', 'Claude outputs']);
  fs.cpSync(from, dir, {recursive: true, filter: src => !skip.has(path.basename(src))});
  const idx = path.join(dir, 'index.html');
  const html = fs.readFileSync(idx, 'utf8');
  assert(html.includes('</head>'), 'index.html has no </head>');
  fs.writeFileSync(idx, html.replace('</head>', `<meta name="ss-marker" content="${marker}">\n</head>`));
  const before = parseVersion(swOf(dir));
  execFileSync(process.execPath, [path.join(dir, 'tools', 'checks.mjs'), '--bump'], {cwd: dir, stdio: 'ignore'});
  const after = parseVersion(swOf(dir));
  assert(after !== before, `checks.mjs --bump did not change VERSION in the copy (${before})`);
  if(mutate) mutate(dir);
  return dir;
}
export const removeCopy = dir => { try{ fs.rmSync(dir, {recursive: true, force: true}); }catch(e){} };

/* The loops' server (harness.mjs startServer) cannot answer a missing file: it calls res.writeHead(200) BEFORE
   awaiting readFile, so the rejection's writeHead(404) throws ERR_HTTP_HEADERS_SENT and the process dies. Until that
   is fixed, a loop that needs a 404 answers those paths itself: missing404(server, ['/js/x.js']) puts a dispatcher in
   front of the server's request listeners (the path is still recorded in server.hits) and returns a restore(). */
export function intercept(server, handle){
  const saved = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if(p.endsWith('/')) p += 'index.html';
    if(handle(req, res, p)) return;
    for(const l of saved) l.call(server, req, res);
  });
  let done = false;
  return () => { if(done) return; done = true; server.removeAllListeners('request'); for(const l of saved) server.on('request', l); };
}
export const missing404 = (server, paths) => intercept(server, (req, res, p) => {
  if(!paths.includes(p)) return false;
  server.hits.push(p); res.writeHead(404, {'Content-Type': 'text/plain'}).end('not found'); return true;
});

/* Offline, for every target. Playwright's context.setOffline(true) cuts the PAGE off, but not the service worker:
   measured here, a worker's update check and its install fetches still reached the server with the context
   offline. So "offline" = context.setOffline(true) AND the server drops every connection without an answer (the
   request is still recorded in server.hits, so "hits is empty" still proves nothing tried the network).
   Returns an async restore(). */
export async function goOffline(context, server){
  await context.setOffline(true);
  const restore = intercept(server, (req, res, p) => { server.hits.push(p); req.socket.destroy(); return true; });
  return async () => { restore(); await context.setOffline(false); };
}

/* ---------- reloads, counted by the browser ----------
   committed: main-frame navigations committed (Playwright 'framenavigated').
   docs:      main-frame document requests the browser made (Playwright 'request' with isNavigationRequest()); this
              includes the ones the service worker answers from its cache, which never reach the server.
   loads:     'load' events of the page.
   asked:     navigations the page asked for (CDP Page.frameRequestedNavigation): two location.reload() calls in a row
              commit only once, so "committed" alone cannot see a double reload.
   serverDocs: navigations that reached the local server (Sec-Fetch-Mode: navigate), as information: once a worker
              controls the page a reload is answered from the cache and does not reach the server.
   An "exactly one reload" needs committed, docs and loads all to be 1 (and asked <= 1). */
export async function navCounter(page, server){
  const c = {committed: 0, docs: 0, loads: 0, asked: 0, serverDocs: 0};
  page.on('framenavigated', f => { if(f === page.mainFrame()) c.committed++; });
  page.on('request', r => { if(r.isNavigationRequest() && r.frame() === page.mainFrame()) c.docs++; });
  page.on('load', () => c.loads++);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  let main = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
  cdp.on('Page.frameNavigated', p => { if(!p.frame.parentId) main = p.frame.id; });
  cdp.on('Page.frameRequestedNavigation', p => { if(p.frameId === main) c.asked++; });
  let onReq = null;
  if(server){ onReq = req => { if(req.headers['sec-fetch-mode'] === 'navigate') c.serverDocs++; }; server.on('request', onReq); }
  return {
    get: () => ({...c}),
    reset(){ for(const k in c) c[k] = 0; },
    text: () => `${c.committed} committed, ${c.docs} document request(s), ${c.loads} load event(s), ${c.asked} asked for, ${c.serverDocs} reached the server`,
    close(){ if(onReq) server.off('request', onReq); cdp.detach().catch(() => {}); },
  };
}

/* ---------- the worker ---------- */
export const swState = page => page.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  const st = w => w ? w.state : null;
  return {controller: !!navigator.serviceWorker.controller, active: st(r && r.active), waiting: st(r && r.waiting), installing: st(r && r.installing),
    scope: r && r.scope, caches: (await caches.keys()).filter(k => k.startsWith('setlist-stand-'))};
});
/* Keys (URL pathnames relative to the scope) of a cache, read in the page. */
export const cacheKeys = (page, name) => page.evaluate(async name => {
  if(!(await caches.has(name))) return null;
  const scope = (await navigator.serviceWorker.getRegistration()).scope;
  return (await (await caches.open(name)).keys()).map(r => r.url.startsWith(scope) ? r.url.slice(scope.length) : r.url);
}, name);
/* Waits until the worker is active, controls the page, and cache `name` holds every path in `want`. */
export async function waitInstalled(page, name, want, ms = 60000){
  const end = Date.now() + ms; let last = null;
  while(Date.now() < end){
    last = await page.evaluate(async ([name, want]) => {
      const r = await navigator.serviceWorker.getRegistration();
      if(!r || !r.active || r.active.state !== 'activated' || !navigator.serviceWorker.controller) return {why: 'worker ' + (r && r.active ? r.active.state : 'not active') + ', controller ' + !!navigator.serviceWorker.controller};
      if(!(await caches.has(name))) return {why: 'no cache ' + name + ' (have ' + (await caches.keys()).join(', ') + ')'};
      const have = new Set((await (await caches.open(name)).keys()).map(q => q.url.slice(r.scope.length)));
      const missing = want.filter(p => !have.has(p));
      return missing.length ? {why: 'not cached yet: ' + missing.join(', ')} : {ok: true};
    }, [name, want]).catch(e => ({why: e.message}));
    if(last.ok) return;
    await sleep(200);
  }
  throw new Error('service worker did not install: ' + last.why);
}
/* registration.update(), called in the page; resolves to 'ok' or the error text. */
export const askUpdate = page => page.evaluate(() => navigator.serviceWorker.getRegistration()
  .then(r => r.update()).then(() => 'ok', e => 'rejected: ' + (e && e.message)));

/* Waits until fn() is truthy (polling), or throws `what`. */
export async function until(fn, what, ms = 10000, step = 150){
  const end = Date.now() + ms; let v;
  while(Date.now() < end){ v = await fn().catch(() => null); if(v) return v; await sleep(step); }
  throw new Error(typeof what === 'function' ? await what() : what);
}

/* ---------- a slow network, service worker included ----------
   Page-level CDP Network.emulateNetworkConditions does not slow the requests the service worker makes while it
   installs (they belong to the worker's target, not the page's), so this proxy slows everything instead: every
   response waits `latency` ms, then its bytes leave at most `kbps` kilobits per second IN TOTAL (shared by all
   responses, as one slow connection would). It forwards to `target` (the loops' server, which still records hits). */
export async function throttleProxy(target, {kbps = 400, latency = 400} = {}){
  const t = new URL(target);
  const bytesPerMs = kbps * 1000 / 8 / 1000;
  let free = 0;          // time when the shared "wire" is next free
  const srv = http.createServer((req, res) => {
    const up = http.request({host: t.hostname, port: t.port, path: req.url, method: req.method, headers: {...req.headers, host: t.host}}, async r => {
      const chunks = []; for await (const ch of r) chunks.push(ch);
      const body = Buffer.concat(chunks);
      await sleep(latency);
      res.writeHead(r.statusCode, r.headers);
      for(let i = 0; i < body.length; i += 4096){
        const part = body.subarray(i, i + 4096);
        const now = Date.now(); free = Math.max(free, now) + part.length / bytesPerMs;
        if(free > now) await sleep(free - now);
        if(res.destroyed) return;
        res.write(part);
      }
      res.end();
    });
    up.on('error', () => { try{ res.writeHead(502).end(); }catch(e){} });
    req.pipe(up);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  srv.base = `http://127.0.0.1:${srv.address().port}/`;
  return srv;
}

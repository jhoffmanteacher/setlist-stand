/*
 * Closed-loop tests: node tools/loops.mjs [--only <text>] [--live <url>] [--root <dir>] [--seed N] [--case N] [--cases N] [--verbose] [--wait SEC] [--list]
 *
 * Each file tools/loops/*.loop.mjs exports `loops = [{name, needs?, run(ctx)}]`.
 *   needs: any of 'library' (converted MobileSheets zip), 'msb' (the MobileSheets backup), 'live' (--live URL)
 *   ctx:   {base (local server URL), server, live (URL or null), library, msb, session(opts), browser,
 *           root (the folder served: --root tests a scratch copy with a planted fault), opts {seed, case, cases, verbose}}
 *   A seeded loop prints, for every failure, the command that replays it: node tools/loops.mjs --only <name> --seed S --case N --verbose
 * A loop throws on failure. Loops whose `needs` are missing print SKIP (never FAIL). Exit code 1 on any FAIL.
 * The private files are found in the main checkout's "Claude outputs/" (or SS_MSB / SS_LIBRARY_ZIP) and are never copied.
 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {launchBrowser, WEBKIT} from './loops/browser.mjs';
import {ROOT, startServer, openSession, privatePath} from './loops/harness.mjs';
import {acquireSlot} from './loops/slot.mjs';
import {tableProblem} from './loops/swtable.mjs';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const only = opt('--only'), live = (opt('--live') || process.env.SS_LIVE_URL || '').replace(/\/?$/, '/') || null;
const liveUrl = live && live !== '/' ? live : null;

const dir = path.join(ROOT, 'tools', 'loops');
const all = [];
for(const f of fs.readdirSync(dir).filter(f => f.endsWith('.loop.mjs')).sort()){
  const m = await import(pathToFileURL(path.join(dir, f)).href);
  for(const l of m.loops || []) all.push({...l, file: f});
}
if(args.includes('--list')){ for(const l of all) console.log(`${l.file}  ${l.name}${l.needs ? '  [needs ' + l.needs.join(', ') + ']' : ''}`); process.exit(0); }

const root = opt('--root') ? path.resolve(opt('--root')) : ROOT;
{ const why = tableProblem(root); if(why){ console.log('FAIL: nothing was run: ' + why); process.exit(1); } }      // a stale table keeps every worker from installing: say so, instead of a loop failing for no visible reason
await acquireSlot('loops');            // one browser run at a time, and only when the Mac is not busy
const server = await startServer({root});
const browser = await launchBrowser();
const o = {seed: Number(opt('--seed') || 1), case: opt('--case') == null ? null : Number(opt('--case')), cases: opt('--cases') == null ? null : Number(opt('--cases')), verbose: args.includes('--verbose'), wait: Number(opt('--wait') || 0)};
const ctx = {root, opts: o, base: server.base, server, live: liveUrl, library: privatePath('setlist-stand-from-mobilesheets.zip'), msb: privatePath('MobileSheets_2026-11-18.msb'),
  browser, session: o => openSession(server.base, {browser, ...o})};
/* Under SS_BROWSER=webkit these loops SKIP: they drive Chromium's DevTools protocol (CDP), which WebKit does not have. */
const CDP = 'needs Chromium DevTools (CDP) to count reloads or throttle the network';
const WEBKIT_SKIP = [[/^update /, CDP], [/^kill switch/, CDP], [/^offline h:/, CDP]];
let failed = 0, n = 0;
const failedNames = [];
const skippedWebkit = [];
for(const l of all){
  if(only && !(l.name + ' ' + l.file).toLowerCase().includes(only.toLowerCase())) continue;
  n++;
  const why = WEBKIT && WEBKIT_SKIP.find(([re]) => re.test(l.name));
  if(why){ console.log(`SKIP: ${l.name} (WebKit: ${why[1]})`); skippedWebkit.push(l.name); continue; }
  const missing = (l.needs || []).filter(k => !ctx[k]);
  if(missing.length){ console.log(`SKIP: ${l.name} (needs ${missing.join(', ')})`); continue; }
  const t0 = Date.now();
  try{ await l.run(ctx); console.log(`PASS: ${l.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch(e){
    failed++; failedNames.push(l.name);
    const msg = String(e && e.message || e).replace(/\r/g, '').split('\n');
    console.log(`FAIL: ${l.name}: ${msg[0]}`);
    for(const more of msg.slice(1)) console.log(`      | ${more}`);
    if(process.env.SS_TRACE) console.log(e.stack);
  }
}
await browser.close(); server.close();
if(skippedWebkit.length) console.log(`skipped under WebKit (${skippedWebkit.length}): ${skippedWebkit.join('; ')}`);
if(failedNames.length) console.log(`failed loops: ${failedNames.join('; ')}`);
console.log(failed ? `${failed} of ${n} loops FAILED` : `all ${n} loops ran clean`);
process.exit(failed ? 1 : 0);

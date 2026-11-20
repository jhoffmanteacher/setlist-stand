#!/usr/bin/env node
/* plant-faults.mjs — prove the closed loops have teeth.

     node tools/plant-faults.mjs                  plant every fault below, one at a time, and run its loop
     node tools/plant-faults.mjs --list           print the table and whether each `find` still occurs once; run nothing
     node tools/plant-faults.mjs --only <id>      just this fault (a comma list works too)
     node tools/plant-faults.mjs --jobs 1         accepted for symmetry; faults always run one at a time

   HOW. One scratch copy of the repo is made in the system temp folder (node_modules and .git left out, node_modules
   linked in). Every `--only` text the chosen faults use is first run once on the UNMODIFIED copy
   (`node tools/loops.mjs --root <scratch> --only <text>`); if one fails there the run stops (exit 1): a fault's
   verdict would mean nothing. Then each fault is planted in the copy (its `find` text, which must occur exactly once in
   the file, becomes `replace`), its loop runs, and the file is put back from the repo. The loop must go RED (exit 1
   with a FAIL line): CAUGHT. Anything else GOT THROUGH: a gap in the tests. A fault whose `find` no longer occurs
   exactly once is STALE (the code moved on: update the table). `flaky: true` faults (timing based) run up to 3 times
   and count as caught if any run fails. `also` names cheap non-browser tools to run on the planted copy too; a FAIL
   line they print that they do not print on the clean copy is reported as "also caught by".

   Browser runs go through tools/loops.mjs, which takes the one-browser-at-a-time slot, so this never starts two.
   Exit 1 if anything got through, is stale, or the clean copy fails. The scratch copy is removed at the end. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FAULTS = [
  {id: 'backup-no-ink', file: 'js/backup.js', find: 'songs:out, sets, ink}));', replace: 'songs:out, sets}));',
    loop: 'reproduces every record', why: 'a backup without annotations loses every mark on restore'},
  {id: 'restore-skips-missing-pdf', file: 'js/backup.js',
    find: 'if(!entry) return stop(`That backup is missing the PDF for "${s.title || s.song || s.id}". Nothing was changed.`);',
    replace: 'if(!entry) continue;',
    loop: 'missing a PDF', why: 'restore is all or nothing: a missing PDF must abort, not drop the song'},
  {id: 'restore-not-one-transaction', file: 'js/backup.js', find: 'await putAll(ops);', replace: 'for(const o of ops) await putAll([o]);',
    loop: 'restore writes everything in one transaction', why: 'records written one by one: a reload part-way leaves a half-restored library'},
  {id: 'print-no-cropbox', file: 'js/print.js', find: 'pg.setCropBox(', replace: '// pg.setCropBox(',
    loop: 'print: crop prints', why: 'a cropped song prints uncropped'},
  {id: 'print-ink-4pc-low', file: 'js/print.js', find: 'const [X, Y] = toPdf(box, rot, p[0], p[1]);', replace: 'const [X, Y] = toPdf(box, rot, p[0], p[1] + .04);',
    loop: 'ink prints where it was drawn', why: 'strokes print 4% lower than they were drawn'},
  {id: 'print-notes-not-rotated', file: 'js/print.js', find: 'font, color:hexRgb(s.c), rotate:degrees(rot)}', replace: 'font, color:hexRgb(s.c)}',
    loop: 'rotated source PDFs', why: 'text notes on a rotated PDF print sideways'},
  {id: 'sortkey-keeps-the', file: 'js/names.js', find: '/^(the|an|a) (.*)$/s', replace: '/^(an|a) (.*)$/s',
    loop: 'model.loop', why: 'library order stops ignoring a leading "The"'},
  {id: 'upgradeset-drops-breaks', file: 'js/store.js', find: "it && (it.type === 'break' || (it.type === 'song' && it.id))", replace: "it && (it.type === 'song' && it.id)",
    loop: 'reproduces every record', why: 'every load/restore silently removes the breaks from setlists'},
  {id: 'delete-keeps-ink', file: 'js/library.js', find: '{deleteInkFor:s.id}, ', replace: '',
    loop: 'model.loop', why: 'a deleted song leaves its ink records behind'},
  {id: 'eraser-erases-notes', file: 'js/ink.js',
    find: "const hit = s => !s.deleted && s.t !== 'text' && Array.isArray(s.p) && s.p.some(p => { const [sx, sy] = toScreen(cv, r, p); return Math.hypot(sx - x, sy - y) < 14 + s.w * r.width / cr.w / 2; });",
    replace: "const hit = s => !s.deleted && (s.t === 'text' ? Math.abs(s.x * r.width - x) < 60 && Math.abs(s.y * r.height - y) < 40 : Array.isArray(s.p) && s.p.some(p => { const [sx, sy] = toScreen(cv, r, p); return Math.hypot(sx - x, sy - y) < 14 + s.w * r.width / cr.w / 2; }));",
    loop: 'ink: the eraser', why: 'the eraser deletes a text note it passes over (notes are only deleted from their own menu)'},
  {id: 'crop-xy-swapped', file: 'js/crop.js', find: 'rect = {x:round(st.rect.x), y:round(st.rect.y)', replace: 'rect = {x:round(st.rect.y), y:round(st.rect.x)',
    loop: 'model.loop', why: 'the saved crop is not the one drawn (the print crop loop takes the saved crop as truth, so only the model, which checks it against the drag, can see this)'},
  {id: 'reload-on-every-controllerchange', file: 'js/main.js',
    find: "addEventListener('controllerchange', () => { if(asked) reloadNow(); });",
    replace: "addEventListener('controllerchange', () => { if(!reloaded){ reloaded = true; location.reload(); } });",
    loop: 'update.loop', why: 'the first install (clients.claim) and other tabs reload by themselves, mid-song'},
  {id: 'banner-reloads-at-once', file: 'js/main.js', find: 'const show = w => {', replace: "const show = w => { asked = true; w.postMessage('skip-waiting');",
    loop: 'update.loop', why: 'an update reloads the app without waiting for a tap'},
  {id: 'precache-misses-css', file: 'sw.js', find: "  'css/app.css',\n", replace: '',
    loop: 'offline g', also: ['checks'], why: 'offline the app opens without its stylesheet'},
  {id: 'activate-keeps-old-caches', file: 'sw.js', find: ".filter((k) => k.startsWith('setlist-stand-') && k !== CACHE)", replace: '.filter((k) => false)',
    loop: 'update.loop', why: 'every update leaves the old cache behind (storage grows; only the new cache should remain)'},
  {id: 'no-resume-after-reload', file: 'js/main.js', find: 'function saveResume(){', replace: 'function saveResume(){ return;',
    loop: 'kill switch', why: 'after a reload in the middle of a song, the open song is gone'},
  {id: 'banner-over-song', file: 'css/app.css', find: 'body.playing #update{display:none}', replace: 'body.playing #update{}',
    loop: 'update b', why: 'the "Tap to reload" banner shows over a song that is playing, so a stray tap reloads the app mid-song'},
  {id: 'kill-switch-no-reload', file: 'js/main.js', find: "if(e.data && e.data.type === 'ss-sw-killed') reloadNow();", replace: '',
    loop: 'kill switch', why: 'after the emergency worker clears the cache, the open tab keeps running from the old app'},
  {id: 'precache-uses-http-cache', file: 'sw.js', find: "new Request(url, { cache: 'reload' })", replace: 'url',
    loop: 'viewer-hardening 3', why: 'a deploy within ten minutes of the last one can cache the OLD files under the NEW version'},
  {id: 'page-turn-mid-stroke', file: 'js/viewer.js', find: 'export async function next(){\n  if(V.busy || inkBusy() ||', replace: 'export async function next(){\n  if(V.busy ||',
    loop: 'viewer-hardening 1a', why: 'a page turn while the pen is down moves the stroke to another song'},
  {id: 'form-enter-on-cancel', file: 'js/util.js', find: "e.key === 'Enter' && e.target.matches('input[type=text]')", replace: "e.key === 'Enter'",
    loop: 'viewer-hardening 7', why: 'Enter on Cancel in Edit song saves the changes'},
  {id: 'restore-no-validation', file: 'js/backup.js', find: 'const bad = validateBackup(data);', replace: 'const bad = null;',
    loop: 'hardening: restore refuses', why: 'a backup with a crafted id or a wrong-shaped record is written into the library'},
  {id: 'tx-no-onabort', file: 'js/store.js', find: "t.onabort = () => rej(t.error || new Error('aborted'));     // a full disk", replace: '// a full disk',
    loop: 'hardening: a transaction that aborts', why: 'a save that the browser aborts at commit never finishes, so the app waits forever'},
  {id: 'upgradeink-keeps-bad-record', file: 'js/store.js',
    find: 'if(!isObj(v) || !Array.isArray(v.strokes)) return {record:{updated:Number(isObj(v) && v.updated) || 0, strokes:[]}, changed:true};',
    replace: 'if(!isObj(v)) return {record:{updated:0, strokes:[]}, changed:true};',
    loop: 'hardening: an ink page with no strokes list', why: 'one damaged ink page makes every later backup fail'},
  {id: 'delete-song-not-atomic', file: 'js/library.js', find: "try{ await putAll(ops); }\n    catch(err){ toast(explainError(err)); }", replace: "try{ for(const o of ops) await putAll([o]); }\n    catch(err){ toast(explainError(err)); }",
    loop: 'hardening: replace PDF and delete song', why: 'a failure part-way through a delete leaves a song without its file, or a setlist pointing at nothing'},
  {id: 'import-hashes-file-name', file: 'js/library.js', find: 'pages:r.pages, hash:r.hash, added:t, updated:t};',
    replace: 'pages:r.pages, hash:await sha256(new TextEncoder().encode(f.name)), added:t, updated:t};',
    loop: 'import.loop', why: 'the stored hash is not the PDF\'s, so duplicates and restore checks go wrong'},
  {id: 'duplicate-shares-break-ids', file: 'js/setlists.js', find: "it.type === 'break' ? {...it, id:uid()} : {...it}", replace: '{...it}',
    loop: 'model.loop', why: 'a duplicated setlist\'s breaks keep the original ids (renaming one could rename the other)'},
];

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
if(opt('--jobs') && opt('--jobs') !== '1') console.log('plant-faults: --jobs is always 1 (one browser run at a time)');
const onlyIds = opt('--only') ? opt('--only').split(',').map(s => s.trim()) : null;
if(onlyIds){ const bad = onlyIds.filter(id => !FAULTS.some(f => f.id === id)); if(bad.length){ console.error('unknown fault id: ' + bad.join(', ')); process.exit(2); } }
const chosen = FAULTS.filter(f => !onlyIds || onlyIds.includes(f.id));

const count = (hay, needle) => { let n = 0, i = -1; while((i = hay.indexOf(needle, i + 1)) >= 0) n++; return n; };
const occurrences = f => { try{ return count(fs.readFileSync(path.join(ROOT, f.file), 'utf8'), f.find); }catch(e){ return 0; } };

if(args.includes('--list')){
  for(const f of chosen){
    const n = occurrences(f);
    console.log(`${f.id.padEnd(34)} ${f.file.padEnd(16)} --only "${f.loop}"${f.flaky ? '  [flaky x3]' : ''}${n === 1 ? '' : `  STALE (find occurs ${n}x)`}\n    ${f.why}`);
  }
  process.exit(0);
}

/* ---------- scratch copy ---------- */
let scratch = null;
const cleanup = () => { if(scratch){ try{ fs.rmSync(scratch, {recursive: true, force: true}); }catch(e){} scratch = null; } };
process.on('exit', cleanup);
for(const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(130); });

let child = null;
function run(cmd, argv, timeoutMs){
  return new Promise(res => {
    const t0 = Date.now(); let out = '';
    child = spawn(cmd, argv, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { out += '\n(plant-faults: stopped after ' + timeoutMs / 60e3 + ' minutes)'; child.kill('SIGTERM'); }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); child = null; res({code, out, secs: (Date.now() - t0) / 1000}); });
  });
}
for(const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if(child) child.kill('SIGTERM'); });
const LOOP_TIMEOUT = 30 * 60e3;
const loopRun = text => run(process.execPath, [path.join(ROOT, 'tools', 'loops.mjs'), '--root', scratch, '--only', text], LOOP_TIMEOUT);
const failLines = out => out.split('\n').filter(l => l.startsWith('FAIL'));
const trunc = (s, n = 160) => s.length > n ? s.slice(0, n - 1) + '…' : s;
const ALSO = {checks: () => run(process.execPath, [path.join(scratch, 'tools', 'checks.mjs')], 5 * 60e3)};

let planted = 0, caught = 0, through = [], stale = [];
try{
  const live = [];
  for(const f of chosen){ const n = occurrences(f); if(n === 1) live.push(f); else { stale.push(f.id); console.log(`STALE  ${f.id}  (${f.file}: find occurs ${n}x)`); } }

  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plant-faults-'));
  fs.cpSync(ROOT, scratch, {recursive: true, filter: src => { const rel = path.relative(ROOT, src); return rel !== 'node_modules' && rel !== '.git'; }});
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
  console.log(`scratch copy: ${scratch}`);

  /* clean copy first */
  const texts = [...new Set(live.map(f => f.loop))];
  for(const text of texts){
    const r = await loopRun(text);
    const fails = failLines(r.out), ran = /all (\d+) loops ran clean/.exec(r.out);
    if(r.code !== 0 || fails.length || !ran || ran[1] === '0' || !/^PASS/m.test(r.out)){
      console.log(`CLEAN RUN FAILED  --only "${text}"  (${r.secs.toFixed(0)}s): verdicts would mean nothing`);
      console.log((fails.length ? fails.map(l => '  ' + trunc(l)).join('\n') : r.out.split('\n').slice(-15).join('\n')));
      console.log(`plant-faults: 0 planted, 0 caught, 0 got through, ${stale.length} stale (clean run failed)`);
      process.exitCode = 1; throw null;
    }
    console.log(`clean  --only "${text}"  (${r.secs.toFixed(0)}s)`);
  }
  const alsoBase = {};
  for(const k of new Set(live.flatMap(f => f.also || []))) alsoBase[k] = new Set(failLines((await ALSO[k]()).out));

  /* one fault at a time */
  for(const f of live){
    const dst = path.join(scratch, f.file), src = fs.readFileSync(path.join(ROOT, f.file), 'utf8');
    fs.writeFileSync(dst, src.replace(f.find, () => f.replace));
    planted++;
    try{
      let hit = null, total = 0;
      for(let k = 0; k < (f.flaky ? 3 : 1) && !hit; k++){
        const r = await loopRun(f.loop); total += r.secs;
        const fails = failLines(r.out);
        if(r.code === 1 && fails.length) hit = fails[0];
        else if(r.code !== 0) console.log(`  (${f.id}: loops.mjs exited ${r.code} without a FAIL line: not counted)\n` + r.out.split('\n').slice(-8).map(l => '    ' + l).join('\n'));
      }
      const also = [];
      for(const k of f.also || []){ const r = await ALSO[k](); if(failLines(r.out).some(l => !alsoBase[k].has(l))) also.push(k); }
      const alsoTxt = f.also ? `; also caught by: ${also.length ? also.join(', ') : 'none of ' + f.also.join(', ')}` : '';
      if(hit){
        caught++;
        const name = /^FAIL: (.*?): /.exec(hit)?.[1] || f.loop;
        console.log(`CAUGHT  ${f.id}  (${trunc(name, 70)}, ${total.toFixed(0)}s${alsoTxt})\n    ${trunc(hit)}`);
      } else {
        through.push(f.id);
        console.log(`GOT THROUGH  ${f.id}  (--only "${f.loop}"${f.flaky ? ', 3 runs' : ''}, ${total.toFixed(0)}s${alsoTxt}): ${f.why}`);
      }
    } finally {
      fs.writeFileSync(dst, src);            // put the file back from the repo
    }
  }
  console.log(`plant-faults: ${planted} planted, ${caught} caught, ${through.length} got through, ${stale.length} stale`);
  if(through.length || stale.length) process.exitCode = 1;
}catch(e){
  if(e !== null){ console.error('plant-faults crashed: ' + (e && e.stack || e)); process.exitCode = 2; }
}finally{
  cleanup();
}

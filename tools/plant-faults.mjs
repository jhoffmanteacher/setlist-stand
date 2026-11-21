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
  {id: 'fullscreen-viewer-only', file: 'js/viewer.js', find: 'const root = document.documentElement, p = root.requestFullscreen', replace: 'const root = viewer, p = root.requestFullscreen',
    loop: 'ink: in full screen', why: 'only #viewer goes full screen, so the note dialog, the crop screen and every toast open out of sight while the viewer behind is inert: the app looks frozen'},
  {id: 'pen-width-mapping', file: 'js/ink.js', find: 'export const PEN_W = {thin:.002, medium:.003, thick:.005};', replace: 'export const PEN_W = {thin:.003, medium:.003, thick:.003};',
    loop: 'three pen thicknesses', why: 'the three thickness buttons all draw the same line: the choice does nothing'},
  {id: 'pen-width-not-kept', file: 'js/ink.js', find: "penW = w.dataset.width; try{ localStorage.setItem('ss-pen-w', penW); }catch(err){}", replace: 'penW = w.dataset.width;',
    loop: 'three pen thicknesses', why: 'the thickness choice is forgotten when the app is reopened'},
  {id: 'highlighter-takes-pen-width', file: 'js/ink.js', find: "w:cur.tool === 'hl' ? HL_W : PEN_W[penW]", replace: 'w:PEN_W[penW]',
    loop: 'three pen thicknesses', why: 'the highlighter becomes a thin line like the pen'},
  {id: 'print-ignores-pen-width', file: 'js/print.js', find: 'borderWidth:s.w * dispW,', replace: 'borderWidth:.003 * dispW,',
    loop: 'three pen thicknesses', why: 'the screen shows three line thicknesses but the printed page draws every pen line the same'},
  {id: 'turns-no-prev-page-prefetch', file: 'js/viewer.js', find: '  if(V.page > 1) ahead(Math.max(1, V.page - V.per));\n', replace: '',
    loop: 'page turns: the next and previous song', why: 'turning back a page inside a song waits for the page to draw (only the next page is readied)'},
  {id: 'turns-no-next-song-prepare', file: 'js/viewer.js', find: "  if(V.page + V.per > V.n) prepare(nextSong(V.qi), 'first');\n", replace: '',
    loop: 'page turns: the next and previous song', why: 'the turn into the next song of a setlist opens its PDF and draws its page after the tap'},
  {id: 'turns-no-prev-song-prepare', file: 'js/viewer.js', find: "  if(V.page === 1) prepare(prevSong(V.qi), 'last');\n", replace: '',
    loop: 'page turns: the next and previous song', why: 'going back into the previous song waits for it to open'},
  {id: 'turns-prepared-songs-never-closed', file: 'js/viewer.js', find: 'if(!keep.includes(qi)){ V.prep.delete(qi); dropDoc(e); }', replace: 'if(false){ V.prep.delete(qi); dropDoc(e); }',
    loop: 'page turns: the next and previous song', why: 'songs prepared and not played stay open (their PDFs and pages) for the whole evening'},
  {id: 'turns-late-render-over-break', file: 'js/viewer.js', find: "  const dt = ++V.dt;\n  if(V.brk) return drawBreak();\n  if(!V.doc) return;\n  calcPer();", replace: "  if(V.brk) return drawBreak();\n  if(!V.doc) return;\n  const dt = ++V.dt; calcPer();",
    loop: 'page turns: the next and previous song', why: 'a page still drawing for the song just left paints over the break page that follows it'},
  {id: 'turns-break-no-prepare', file: 'js/viewer.js', find: "  prepare(nextSong(V.qi), 'first'); prepare(prevSong(V.qi), 'last');\n", replace: '',
    loop: 'page turns: the next and previous song', why: 'on a break page the songs either side are not readied (or not again after a resize)'},
  {id: 'turns-prepare-wrong-song', file: 'js/viewer.js', find: 'ent = {id:e.id, p:openDoc(e.id)};', replace: 'ent = {id:e.id, p:openDoc(V.id || e.id)};',
    loop: 'page turns: the next and previous song', why: 'the song readied for a turn is the wrong one: the turn lands on another song\'s pages under the right title'},
  {id: 'restore-stop-ignored', file: 'js/backup.js', find: "      if(wasStopped()) return;\n      if(s.deleted){", replace: '      if(s.deleted){',
    loop: 'roundtrip progress: Restore', why: 'Stop pressed while a restore is checking is ignored: it goes on and saves'},
  {id: 'restore-stop-not-locked', file: 'js/backup.js', find: "job.lock('Saving to this tablet…');", replace: "job.say('Saving to this tablet…');",
    loop: 'roundtrip progress: Restore', why: 'the Stop button is still there during the one write, so it looks as if it could stop a save half way'},
  {id: 'backup-stop-ignored', file: 'js/backup.js', find: 'const made = await makeBackup(job);', replace: 'const made = await makeBackup();',
    loop: 'roundtrip progress: Back up', why: 'Stop pressed while backing up is ignored: the file is downloaded anyway'},
  {id: 'backup-stopped-sets-time', file: 'js/backup.js', find: "if(!made) toast('Backup stopped. Nothing was saved.');", replace: "if(!made){ toast('Backup stopped. Nothing was saved.'); try{ localStorage.setItem(LAST_BACKUP, String(Date.now())); }catch(e){} }",
    loop: 'roundtrip progress: Back up', why: 'a stopped backup counts as a backup: the reminder to back up goes quiet although nothing was saved'},
  {id: 'busy-banner-tappable', file: 'css/app.css', find: 'body.playing #update,body.splitting #update,body.busy #update{display:none}', replace: 'body.playing #update,body.splitting #update{display:none}',
    loop: 'roundtrip progress: Restore', why: 'the "Updated. Tap to reload" banner can be tapped over a restore or backup box: the tap reloads the app and throws the job away'},
  {id: 'busy-not-marked', file: 'js/util.js', find: "  document.body.classList.add('busy');\n", replace: '',
    loop: 'roundtrip progress: Restore', why: 'a restore or backup box does not mark the page busy, so nothing holds back an update reload'},
  {id: 'order-not-sorted-when-drawn', file: 'js/library.js', find: 'const sorted = [...state.songs].sort(compareSongs);', replace: 'const sorted = [...state.songs];',
    loop: 'library order', why: 'the library list is drawn in whatever order the songs are held in memory, so a song added or renamed during a session can land in the wrong place'},
  {id: 'order-picker-not-sorted', file: 'js/util.js', find: 'songs = [...songs].sort(compareSongs);', replace: 'songs = [...songs];',
    loop: 'library order', why: 'the song pickers (Add songs on a setlist, Share songs) are not in A to Z order'},
  {id: 'order-numbers-as-text', file: 'js/names.js', find: "{ sensitivity: 'base', numeric: true }", replace: "{ sensitivity: 'base', numeric: false }",
    loop: 'library order', why: '"10 Years Gone" sorts before "2 Fast"'},
  {id: 'order-case-and-accents-count', file: 'js/names.js', find: "{ sensitivity: 'base', numeric: true }", replace: "{ sensitivity: 'variant', numeric: true }",
    loop: 'library order', why: 'upper and lower case and accents decide the order of songs that have the same name, ahead of artist and version'},
  {id: 'order-no-artist-tiebreak', file: 'js/names.js', find: '    || COLLATOR.compare(text(a.artist), text(b.artist))\n', replace: '',
    loop: 'library order', why: 'two songs with the same name are not ordered by artist'},
  {id: 'order-no-version-tiebreak', file: 'js/names.js', find: '    || COLLATOR.compare(text(a.version), text(b.version))\n', replace: '',
    loop: 'library order', why: 'two songs with the same name and artist are not ordered by version'},
  {id: 'cache-no-pixel-limit', file: 'js/pagecache.js', find: 'if(total <= MAX_PIXELS && this.size <= MAX_ENTRIES) return;', replace: 'if(this.size <= MAX_ENTRIES) return;',
    loop: 'page turns: the page cache stays', why: 'the page cache is limited by count only: big pages can fill an iPad\'s canvas memory'},
  {id: 'cache-canvas-not-emptied', file: 'js/pagecache.js', find: 'export function release(cv){ cv.width = 0; cv.height = 0; }', replace: 'export function release(cv){}',
    loop: 'page turns: the page cache stays', why: 'canvases that leave the cache keep their memory (iPad Safari only takes it back from an emptied canvas)'},
  {id: 'awake-ignores-preference', file: 'js/awake.js', find: "const wanted = () => { if(chosen !== null) return chosen; try{ return localStorage.getItem(KEY) !== '0'; }catch(e){ return true; } };", replace: 'const wanted = () => true;',
    loop: 'wakelock: the lock follows', why: 'the "Screen can dim" setting is saved but ignored: the screen is kept on anyway, and a song opened with it off still asks for the lock'},
  {id: 'awake-release-not-shown', file: 'js/awake.js', find: "got.addEventListener('release', () => { if(sentinel === got){ sentinel = null; render(); } });", replace: '',
    loop: 'wakelock: the lock follows', why: 'when the system takes the screen lock back, the button still says the screen stays on'},
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
  {id: 'sortkey-drops-the', file: 'js/names.js', find: "export const sortKey = song => String(song ?? '').replace(/\\s+/g, ' ').trim();", replace: "export const sortKey = song => String(song ?? '').replace(/\\s+/g, ' ').trim().replace(/^the /i, '');",
    loop: 'model.loop', why: 'the library skips a leading "The" again when it sorts ("The Weight" is under W): Jonathan wants every word counted'},
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
    find: "addEventListener('controllerchange', () => { if(asked && !document.body.classList.contains('playing') && !document.body.classList.contains('splitting') && !document.body.classList.contains('busy')) reloadNow(); });",
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
  {id: 'banner-over-song', file: 'css/app.css', find: 'body.playing #update,body.splitting #update,body.busy #update{display:none}', replace: 'body.splitting #update,body.busy #update{display:none}',
    loop: 'update b', why: 'the "Tap to reload" banner shows over a song that is playing, so a stray tap reloads the app mid-song'},
  {id: 'kill-switch-no-reload', file: 'js/main.js', find: "if(e.data && e.data.type === 'ss-sw-killed') reloadNow();", replace: '',
    loop: 'kill switch', why: 'after the emergency worker clears the cache, the open tab keeps running from the old app'},
  {id: 'precache-uses-http-cache', file: 'sw.js', find: "new Request(url, { cache: 'reload' })", replace: 'url',
    loop: 'viewer-hardening 3', why: 'a deploy within ten minutes of the last one can cache the OLD files under the NEW version'},
  {id: 'page-turn-mid-stroke', file: 'js/viewer.js', find: 'export async function next(){\n  if(V.busy || inkBusy() ||', replace: 'export async function next(){\n  if(V.busy ||',
    loop: 'viewer-hardening 1a', why: 'a page turn while the pen is down moves the stroke to another song'},
  {id: 'stuck-pen-blocks-turns', file: 'js/ink.js', find: 'export const inkBusy = () => !!cur && !isStale(cur);', replace: 'export const inkBusy = () => !!cur;',
    loop: 'viewer-hardening 10', why: 'a pen-up that never arrives blocks page turns and new strokes until the app reloads'},
  {id: 'undo-during-stroke', file: 'js/ink.js', find: "$('#tUndo').onclick = () => {\n    if(inkBusy()) return;\n", replace: "$('#tUndo').onclick = () => {\n",
    loop: 'viewer-hardening 11', why: 'Undo with a finger while the pen is down is silently put back when the stroke ends'},
  {id: 'controllerchange-mid-song', file: 'js/main.js', find: "if(asked && !document.body.classList.contains('playing') && !document.body.classList.contains('splitting') && !document.body.classList.contains('busy')) reloadNow();", replace: "if(asked && !document.body.classList.contains('splitting') && !document.body.classList.contains('busy')) reloadNow();",
    loop: 'viewer-hardening 12', why: 'a second tab updating reloads this tab in the middle of a song'},
  {id: 'old-marker-wipes-newer-song', file: 'js/backup.js', find: "if(newerHere('songs', s)) continue;", replace: '',
    loop: 'restore keeps a newer local song', why: 'restoring a backup that marks a song deleted wipes the PDF and marks of a newer copy on this tablet'},
  {id: 'restore-mixes-local-ink', file: 'js/backup.js', find: "{store:'songs', key:s.id, value:s}, {deleteInkFor:s.id}); n++;", replace: "{store:'songs', key:s.id, value:s}); n++;",
    loop: 'restore keeps a newer local song', why: 'a restored song keeps local annotations the backup lacks, on top of the backup\'s PDF'},
  {id: 'duplicate-ids-accepted', file: 'js/backup.js', find: "if(seen.has(r.id)) return `the ${what} id ${r.id} twice`; ", replace: '',
    loop: 'hardening: restore refuses', why: 'a backup with the same id twice (a marker, then a live record) is accepted and loses the song\'s marks'},
  {id: 'ensurehashes-stale-hash', file: 'js/store.js', find: '&& cur.updated === s.updated ? {...cur, hash}', replace: '? {...cur, hash}',
    loop: 'a missing hash is not filled in', why: 'a PDF replaced while it was being hashed gets the OLD file\'s hash'},
  {id: 'names-copy-suffix', file: 'js/importname.js', find: "raw = raw.replace(/^(.*\\))\\s*\\(\\d{1,2}\\)$/, '$1');", replace: '',
    loop: 'hardening: the song order', why: '"Song (in G) (1).pdf" (downloaded twice) is read as version 1'},
  {id: 'form-no-maxlength', file: 'js/util.js', find: '<input type="text" maxlength="200" data-k=', replace: '<input type="text" data-k=',
    loop: 'text fields stop at 200', why: 'a very long title can make the next backup unrestorable'},
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
  {id: 'import-hashes-file-name', file: 'js/library.js', find: 'newSong(parseFileName(f.name), r.pages, r.hash)',
    replace: 'newSong(parseFileName(f.name), r.pages, await sha256(new TextEncoder().encode(f.name)))',
    loop: 'import.loop', why: 'the stored hash is not the PDF\'s, so duplicates and restore checks go wrong'},
  {id: 'duplicate-shares-break-ids', file: 'js/setlists.js', find: "it.type === 'break' ? {...it, id:uid()} : {...it}", replace: '({...it})',
    loop: 'model.loop', why: 'a duplicated setlist\'s breaks keep the original ids (renaming one could rename the other)'},
  {id: 'dialog-tab-native', file: 'js/util.js',
    find: "    e.preventDefault();\n    const f = focusables(m); if(!f.length){ box.focus(); return; }",
    replace: "    const f = focusables(m); if(!f.length){ e.preventDefault(); box.focus(); return; }\n    if(f.indexOf(document.activeElement) > 0 && f.indexOf(document.activeElement) < f.length - 1) return;\n    e.preventDefault();",
    loop: 'viewer-hardening 13', why: 'in Safari, Tab skips the dialog buttons and focus falls out onto the page behind'},
  {id: 'private-window-message', file: 'js/errors.js', find: 'if(isPrivateWindow(err)) return', replace: 'if(false) return',
    loop: 'viewer-hardening 14', why: 'in a private Safari window every import fails with only a generic message'},
  {id: 'print-picture-marks-misplaced', file: 'js/print.js', find: 'await markPage(pg, {x:0, y:0, width:pic.w, height:pic.h}, 0, id, song, i + 1);',
    replace: 'await markPage(pg, {x:0, y:0, width:pic.h, height:pic.w}, 0, id, song, i + 1);',
    loop: 'print: protected charts print as pictures', why: 'marks and crop on a protected chart printed as a picture land in the wrong place'},
  {id: 'print-protected-still-dropped', file: 'js/print.js', find: 'if(r.pics) for(const [i, pic] of r.pics.entries()){', replace: 'if(false) for(const [i, pic] of r.pics.entries()){',
    loop: 'all-protected set', why: '"Print them as pictures" still leaves the protected charts out'},
  {id: 'print-progress-loses-focus', file: 'js/print.js', find: "    box.focus();                            // the button that was pressed is gone", replace: "    // box.focus();                            // the button that was pressed is gone",
    loop: 'print: protected charts print as pictures', why: 'with a keyboard, the progress screen drops focus out of the dialog and Escape stops working'},
  {id: 'awake-storage-blocked', file: 'js/awake.js', find: 'if(chosen !== null) return chosen; ', replace: '',
    loop: 'wakelock: the choice holds', why: 'with storage blocked, turning the screen lock off does not stick: it turns amber "may dim" and comes back'},
  {id: 'split-last-page-missing', file: 'js/songpdf.js', find: 'for(let i = from - 1; i <= to - 1; i++) idx.push(i);', replace: 'for(let i = from - 1; i < to - 1; i++) idx.push(i);',
    loop: 'split 1', why: 'every song loses its last page'},
  {id: 'split-writes-dates', file: 'js/songpdf.js', find: 'PDFLib.PDFDocument.create({updateMetadata:false})', replace: 'PDFLib.PDFDocument.create()',
    loop: 'split 1', why: 'each song PDF carries the time it was made, so splitting the same book twice is never spotted as duplicates'},
  {id: 'split-adds-duplicates', file: 'js/split.js', find: 'if(again || !known.has(hash)){', replace: 'if(true){',
    loop: 'split 1', why: 'splitting a book that is already in the library adds every song a second time'},
  {id: 'split-song-and-pdf-apart', file: 'js/split.js',
    find: "await putAll([{store:'files', key:s.id, value:new Blob([bytes], {type:'application/pdf'})}, {store:'songs', key:s.id, value:s}]);",
    replace: "await putAll([{store:'songs', key:s.id, value:s}]); await putAll([{store:'files', key:s.id, value:new Blob([bytes], {type:'application/pdf'})}]);",
    loop: 'split 4', why: 'a full tablet leaves a song in the library with no PDF behind it'},
  {id: 'split-end-overlaps-next', file: 'js/songlist.js', find: 'return next ? Math.max(r.from, next.from - 1) : n;', replace: 'return next ? Math.max(r.from, next.from) : n;',
    loop: 'split 1', why: 'every song also holds the first page of the next one'},
  {id: 'split-sections-become-songs', file: 'js/songlist.js', find: 'if(kids){ kept = true; continue; }', replace: 'if(kids) kept = true;',
    loop: 'split 1', why: 'a bookmark section such as "Part One" is listed as a song of its own'},
  {id: 'split-rows-not-sorted', file: 'js/songlist.js', find: 'a[0].from - b[0].from || a[1] - b[1]', replace: 'a[1] - b[1]',
    loop: 'split 2', why: 'a song moved to an earlier page stays where it was in the list, and the page ranges overlap'},
  {id: 'split-protected-cut', file: 'js/split.js', find: "if(lib.isEncrypted){ doc.destroy(); return {why:'protected'}; }", replace: '',
    loop: 'split 3', why: 'a protected songbook is cut into songs of blank pages'},
  {id: 'split-artist-overrides', file: 'js/split.js', find: 'if(!name.artist && artist) name.artist = artist;', replace: 'if(artist) name.artist = artist;',
    loop: 'split 2', why: 'the artist box replaces the artist typed in a song title'},
  {id: 'split-cancel-no-confirm', file: 'js/split.js', find: "if(S && S.dirty && !armed(e.currentTarget, 'Discard? Tap again')) return;", replace: '',
    loop: 'split 2', why: 'one stray tap on Cancel throws away a list that took minutes to mark'},
  {id: 'split-app-reachable', file: 'js/util.js', find: "el.inert = on || (s === '.app' && splitting);", replace: 'el.inert = on;',
    loop: 'split 4', why: 'after a dialog closes over the splitter, the app hidden behind it can be tabbed into again'},
  {id: 'controllerchange-mid-split', file: 'js/main.js', find: " && !document.body.classList.contains('splitting') && !document.body.classList.contains('busy')) reloadNow();", replace: " && !document.body.classList.contains('busy')) reloadNow();",
    loop: 'viewer-hardening 12', why: 'a second tab updating reloads this tab in the middle of marking a songbook, and the marks are lost'},
  {id: 'banner-over-split', file: 'css/app.css', find: 'body.playing #update,body.splitting #update,body.busy #update{display:none}', replace: 'body.playing #update,body.busy #update{display:none}',
    loop: 'viewer-hardening 12', why: 'the "Tap to reload" banner shows over the songbook splitter, so a stray tap reloads the app and loses the marks'},
  {id: 'split-notes-keep-pointers', file: 'js/songpdf.js', find: "const AWAY = ['P', 'A', 'AA', 'Dest', 'IRT'], PAGE_AWAY", replace: 'const AWAY = [], PAGE_AWAY',
    loop: 'split 5', why: 'a note keeps its /P (its page), so every song drags more of the book along; the safety net then drops every note'},
  {id: 'split-no-stray-check', file: 'js/songpdf.js', find: 'if(pageObjects(out) !== idx.length) continue;', replace: '',
    loop: 'split 5', why: 'a song that holds other pages of the book (through a pointer nobody listed) is saved as it is'},
  {id: 'split-stray-song-saved', file: 'js/songpdf.js', find: "throw cutError('The pages of this song point at other pages of the book');",
    replace: 'return {bytes:new Uint8Array([37, 80, 68, 70]), pages:to - from + 1};',
    loop: 'split 5', why: 'a song that cannot be cut cleanly is saved as an empty file instead of being refused'},
  {id: 'split-layers-cut', file: 'js/split.js', find: "if(await hidesLayers(doc) || usesLayerRules(lib)){ doc.destroy(); return {why:'layers'}; }", replace: "if(false){ doc.destroy(); return {why:'layers'}; }",
    loop: 'split 3', why: 'a book that hides layers is cut, and the hidden layers appear in the songs'},
  {id: 'split-title-rewritten', file: 'js/importname.js', find: "\n  return {song:title, artist, version:''};\n}", replace: "\n  return splitName(title);\n}",
    loop: 'split 2', why: 'a title typed by hand is rewritten like an old file name ("Blues in F" becomes "Blues (in F)")'},
  {id: 'split-twins-skipped', file: 'js/split.js', find: 'const name = parseTypedTitle(title);', replace: 'known.add(hash); const name = parseTypedTitle(title);',
    loop: 'split 2', why: 'two songs on one page are the same bytes, so the second is skipped as "already in your library"'},
  {id: 'split-failure-closes', file: 'js/split.js', find: '  redraw(); mine.adding = false;', replace: '  closeSplit(); return;',
    loop: 'split 4', why: 'a full tablet part-way through closes the screen and loses every song still to add'},
  {id: 'split-to-box-stale', file: 'js/split.js', find: '    if(to !== document.activeElement || to.value === to.dataset.shown){ to.value = v; to.dataset.shown = v; }',
    replace: '    if(r.to == null && to !== document.activeElement){ to.value = v; to.dataset.shown = v; }',
    loop: 'split 2', why: 'the last-page box still shows an old number after the first page moved past it, while the song is cut to a different range'},
  {id: 'split-front-matter-prefix', file: 'js/songlist.js', find: ')\\s*$/i;', replace: ')/i;',
    loop: 'split 1', why: 'real songs such as "Cover Me" or "About a Girl" start unticked because they begin with a front-matter word'},
  {id: 'split-room-ignored', file: 'js/songpdf.js', find: "if(weightOf(out) > room) throw Object.assign(new Error('The songs would take more space than the run may use'), {space:true});", replace: '',
    loop: 'split 6', why: 'a book that makes every song as heavy as the whole book writes the whole book into every song (a 100 MB book would write gigabytes)'},
  {id: 'split-budget-not-passed', file: 'js/split.js', find: 'makeSongPdf(mine.lib, r.from, end, budget - written)', replace: 'makeSongPdf(mine.lib, r.from, end)',
    loop: 'split 5', why: 'the run never stops for space: every song is written even when each is as heavy as the book'},
  {id: 'split-ocmd-cut', file: 'js/split.js', find: 'if(await hidesLayers(doc) || usesLayerRules(lib)){', replace: 'if(await hidesLayers(doc)){',
    loop: 'split 3', why: 'a book that hides content with a layer rule is cut, and the hidden content appears in the songs'},
  {id: 'split-retry-takes-book-notes', file: 'js/songpdf.js', find: '    if(allAnnots) idx.forEach((i, k) => { if(own[k]) src.getPage(i).node.set(key, own[k]); });', replace: '',
    loop: 'split 6', why: 'a song that had to drop its notes takes them out of the book, so the next song that shares a page loses its notes too'},
  {id: 'split-annots-key-moved', file: 'js/songpdf.js', find: "node.set(key('Annots'), ctx.obj([])); return; }", replace: "node.delete(key('Annots')); return; }",
    loop: 'split 6', why: 'the same pages give different bytes depending on which song was cut before, so a second split is not spotted as duplicates'},
  {id: 'split-uncut-stops-run', file: 'js/split.js', find: 'if(err && err.cut){ uncut.push(title); continue; }', replace: 'if(false){ uncut.push(title); continue; }',
    loop: 'split 5', why: 'one song that cannot be cut stops the run, and the good songs after it are never tried'},
  {id: 'split-pages-disagree', file: 'js/split.js', find: "if(!(await samePages(doc, lib, job))){ doc.destroy(); return {why:'cut'}; }", replace: '',
    loop: 'split 3', why: 'a damaged page tree makes a song be cut from other pages than the ones shown on screen'},
  {id: 'share-has-ink-key', file: 'js/sharepack.js', find: "kind:'share', version:SHARE_VERSION, saved:new Date().toISOString(), songs, setlist}", replace: "kind:'share', version:SHARE_VERSION, saved:new Date().toISOString(), songs, setlist, ink:{}}",
    loop: 'share 1', why: 'a package carries an annotation list, even an empty one: the receiver is told to expect marks'},
  {id: 'share-changes-pdf-bytes', file: 'js/sharepack.js', find: "zip.file('files/' + pid + '.pdf', buf, {createFolders:false});", replace: "zip.file('files/' + pid + '.pdf', buf.slice(0, buf.byteLength - 1), {createFolders:false});",
    loop: 'share 1', why: 'the PDF in the package is not the stored one, so its hash does not match and the receiver cannot spot songs it already has'},
  {id: 'share-drops-crop', file: 'js/sharepack.js', find: 'const crop = cropOf(s); if(crop) rec.crop = crop;', replace: '',
    loop: 'share 1', why: 'crops do not travel with the songs (Jonathan decided they do)'},
  {id: 'share-leaks-library-fields', file: 'js/sharepack.js', find: 'songs.push(rec); local.set(id, pid);', replace: 'rec.title = s.title; rec.archived = s.archived; songs.push(rec); local.set(id, pid);',
    loop: 'share 1', why: 'a package carries the sender\'s archive flag and derived title'},
  {id: 'share-set-leaves-out-archived', file: 'js/sharepack.js', find: "if(it.type === 'song' && !ids.includes(it.id)) ids.push(it.id);", replace: "if(it.type === 'song' && !ids.includes(it.id) && !songById(it.id).archived) ids.push(it.id);",
    loop: 'share 1', why: 'a setlist is shared without its archived songs, so the receiver\'s copy has holes'},
  {id: 'share-set-loses-breaks', file: 'js/sharepack.js', find: "it.type === 'break' || local.has(it.id))", replace: 'local.has(it.id))',
    loop: 'share 1', why: 'the breaks of a shared setlist are lost'},
  {id: 'share-pick-title-fixed', file: 'js/util.js', find: '<h2>${esc(title)}</h2><div class="pick">', replace: '<h2>Add songs</h2><div class="pick">',
    loop: 'share 1', why: 'the Share songs checklist is titled "Add songs"'},
  {id: 'share-folder-entry', file: 'js/sharepack.js', find: "zip.file('files/' + pid + '.pdf', buf, {createFolders:false});", replace: "zip.file('files/' + pid + '.pdf', buf);",
    loop: 'share 1', why: 'the zip gets a stray "files/" folder entry, so it holds more than share.json and the PDFs'},
  {id: 'share-copies-crop-junk', file: 'js/sharepack.js', find: '? {x:r.x, y:r.y, w:r.w, h:r.h} : null;', replace: '? r : null;',
    loop: 'share 1', why: 'a damaged crop in the sender\'s library (extra fields) travels to the receiver'},
  {id: 'share-keeps-dead-page-keys', file: 'js/sharepack.js', find: "/^[1-9]\\d*$/.test(k) && +k <= song.pages", replace: "/^\\d+$/.test(k)",
    loop: 'share 1', why: 'a crop for a page this song does not have (page 0, page 9 of 3) travels with the song'},
  {id: 'share-silent-skip', file: 'js/sharepack.js', find: 'if(!f){ skipped++; continue; }', replace: 'if(!f){ continue; }',
    loop: 'share 1', why: 'a song whose PDF is missing is left out of the package without a word'},
  {id: 'share-button-always-on', file: 'js/util.js', find: 'if(needOne){ ok.disabled = true;', replace: 'if(false){ ok.disabled = true;',
    loop: 'share 1', why: 'Share is pressable with nothing ticked'},
  {id: 'import-hash-unchecked', file: 'js/shareimport.js', find: 'if(hash !== ps.hash.toLowerCase())', replace: 'if(false)',
    loop: 'share 3', why: 'a package whose PDF does not match its recorded hash (damaged, or swapped) is imported'},
  {id: 'import-pages-from-file', file: 'js/shareimport.js', find: 'try{ pages = await pdfPageCount(bytes); }catch(err){', replace: 'try{ pages = ps.pages; }catch(err){',
    loop: 'share 3', why: 'the page count is taken from the package, so a lying count is believed and a file that is not a PDF is stored'},
  {id: 'import-crop-unchecked', file: 'js/shareimport.js', find: 'const {crop, dropped:d} = cleanCrop(ps.crop, pages);', replace: 'const {crop, dropped:d} = {crop:ps.crop || null, dropped:0};',
    loop: 'share 3', why: 'a crop from somebody else\'s package (negative, tiny, off the page) is stored as it is'},
  {id: 'cleancrop-min-ignored', file: 'js/store.js', find: '&& r.w >= CROP_MIN && r.h >= CROP_MIN', replace: '',
    loop: 'share 3', why: 'a crop box smaller than the editor allows is accepted from a package'},
  {id: 'import-matched-added-again', file: 'js/shareimport.js', find: 'if(known.has(hash)){ target.set(ps.id, {id:known.get(hash)}); matchedIds.add(known.get(hash)); continue; }', replace: 'if(false){ continue; }',
    loop: 'share 2', why: 'songs the library already has are added a second time'},
  {id: 'import-same-pdf-twice', file: 'js/shareimport.js', find: 'if(byHash.has(hash)){ target.set(ps.id, {fresh:byHash.get(hash)}); continue; }', replace: 'if(false){ continue; }',
    loop: 'share 3', why: 'the same PDF twice in one package becomes two songs'},
  {id: 'import-set-name-collides', file: 'js/shareimport.js', find: 'for(let n = 2; names.has(name); n++) name = `${base} (${n})`;', replace: '',
    loop: 'share 2', why: 'an imported setlist gets the name of one already there'},
  {id: 'import-record-by-record', file: 'js/shareimport.js', find: '  await putAll(ops);\n  return {added:plan.fresh.length, setName};', replace: '  for(const o of ops) await putAll([o]);\n  return {added:plan.fresh.length, setName};',
    loop: 'share 2', why: 'the package is written one record at a time: a reload part-way leaves half of it'},
  {id: 'import-title-not-escaped', file: 'js/shareimport.js', find: '.map(f => `<li>${esc(f.title)}</li>`)', replace: '.map(f => `<li>${f.title}</li>`)',
    loop: 'share 3', why: 'a song title with HTML in a package becomes an element in the confirm dialog'},
  {id: 'import-cap-ignored', file: 'js/shareimport.js', find: 'const bytes = await readCapped(pdf, room);', replace: 'const bytes = await readCapped(pdf, Infinity);',
    loop: 'share 3', why: 'a small zip that inflates to gigabytes is inflated completely'},
  {id: 'import-no-confirm', file: 'js/shareimport.js', find: '  if(!(await confirmDialog(plan))) return;\n', replace: '',
    loop: 'share 2', why: 'a package is written without asking, so Cancel cannot stop it'},
  {id: 'import-newer-version-ok', file: 'js/shareimport.js', find: 'if(Number(data.version) > SHARE_VERSION)', replace: 'if(false)',
    loop: 'share 3', why: 'a package from a newer version of the app is read as if this app understood it'},
  {id: 'restore-share-package-unnamed', file: 'js/backup.js', find: "    if(zip && zip.file('share.json')) return stop('That is a share package, not a backup. Use Import a share package. Nothing was changed.');\n", replace: '',
    loop: 'share 3', why: 'Restore given a share package says only "not a backup", not where to go'},
  {id: 'import-room-per-file', file: 'js/shareimport.js', find: '      room -= bytes.length;\n', replace: '',
    loop: 'share 3', why: 'the size cap applies to each PDF alone, so a package of many just-under-the-cap PDFs fills the tablet'},
  {id: 'import-file-size-unchecked', file: 'js/shareimport.js', find: 'if(file.size > limits.maxPdfBytes + limits.maxJson)', replace: 'if(false)',
    loop: 'share 3', why: 'a package file of any size is read into memory'},
  {id: 'import-hash-optional', file: 'js/shareimport.js', find: "if(!(typeof s.hash === 'string' && /^[0-9a-f]{64}$/i.test(s.hash))) return", replace: "if(s.hash != null && !(typeof s.hash === 'string' && /^[0-9a-f]{64}$/i.test(s.hash))) return",
    loop: 'share 3', why: 'a song with no recorded hash is accepted, so a damaged PDF in it is never noticed'},
  {id: 'import-ids-collide', file: 'js/shareimport.js', find: '    s.id = unique(taken);\n', replace: '',
    loop: 'share 4', why: 'two songs of one package can get the same id, and the second silently overwrites the first'},
  {id: 'import-json-crc-unchecked', file: 'js/shareimport.js', find: "if(typeof want !== 'number' || crc32(raw) !== want >>> 0) return bad('That package is damaged.');", replace: '',
    loop: 'share 3', why: 'a share.json with a changed byte (a crop, a title, the setlist order) is accepted: nothing in the zip is checked any more'},
  {id: 'import-json-cap-ignored', file: 'js/shareimport.js', find: 'const raw = await readCapped(entry, limits.maxJson);', replace: 'const raw = await readCapped(entry, Infinity);',
    loop: 'share 3', why: 'a share.json of any inflated size is read into memory'},
  {id: 'import-directory-unchecked', file: 'js/shareimport.js', find: 'const dir = await directoryProblem(file);', replace: 'const dir = null;',
    loop: 'share 3', why: 'a small zip with a huge list of files costs gigabytes of memory just to open'},
  {id: 'import-set-id-not-unique', file: 'js/shareimport.js', find: '    const id = unique(taken);\n    ops.push({store:\'sets\'', replace: '    const id = uid();\n    ops.push({store:\'sets\'',
    loop: 'share 4', why: 'an imported setlist can take the id of one already there and silently replace it'},
  {id: 'import-directory-padding', file: 'js/shareimport.js', find: 'return NOT_PACKAGE;                             // no such record at the end of the file: not a zip', replace: 'return null;',
    loop: 'share 3', why: 'padding after a zip\'s end record hides a huge list of files from the guard, and JSZip (which searches the whole file) opens it'},
  {id: 'import-directory-zip64', file: 'js/shareimport.js', find: '[4, 6, 8, 10].some(o => tail.getUint16(i + o, true) === 0xFFFF) || ', replace: '',
    loop: 'share 3', why: 'a zip64 marker makes JSZip read other size fields than the ones the guard measured'},
  {id: 'import-directory-zip64-32bit', file: 'js/shareimport.js', find: ' || [12, 16].some(o => tail.getUint32(i + o, true) === 0xFFFFFFFF)', replace: '',
    loop: 'share 3', why: 'a zip64 marker in the 32-bit size or offset field makes JSZip read the 64-bit record, so a huge file list opens'},
  {id: 'import-cancel-not-honoured', file: 'js/shareimport.js', find: '  if(stopped) return;\n', replace: '',
    loop: 'share 5', why: 'Cancel on the reading box ends in a notice (or a question) the person did not ask for'},
  {id: 'import-no-single-flight', file: 'js/shareimport.js', find: "if(running){ toast('An import is still running. Try again when it has finished.'); return; }", replace: '',
    loop: 'share 5', why: 'a second import started while the first is open or writing adds every song twice'},
  {id: 'import-question-wrong-name', file: 'js/shareimport.js', find: '<b>${esc(freeSetName(plan.setlist))}</b>', replace: "<b>${esc(plan.setlist.name.trim() || 'Shared setlist')}</b>",
    loop: 'share 5', why: 'the question says the setlist will be called "Gig" when it will be saved as "Gig (2)"'},
  {id: 'new-version-marks-not-copied', file: 'js/library.js', find: "      if(copy && marks.length) ops.push({store:'ink', key:copy.id + ':' + p, value:inkRecord(marks)});   // the old chart keeps its marks\n", replace: '',
    loop: 'new version 1', why: 'New version moves the old chart to Archived without its marks: they are lost'},
  {id: 'new-version-old-not-archived', file: 'js/library.js', find: '      copy.archived = true;\n', replace: '',
    loop: 'new version 1', why: 'the old chart shows in the library next to the new one instead of in Archived'},
  {id: 'new-version-crop-not-kept', file: 'js/library.js', find: '      if(s.crop !== undefined) copy.crop = JSON.parse(JSON.stringify(s.crop));\n', replace: '',
    loop: 'new version 1', why: 'the old copy opens without the crop the chart had'},
  {id: 'new-version-old-gets-new-bytes', file: 'js/library.js', find: "{store:'files', key:copy.id, value:new Blob([old], {type:'application/pdf'})}", replace: "{store:'files', key:copy.id, value:new Blob([buf], {type:'application/pdf'})}",
    loop: 'new version 1', why: 'the archived old copy holds the NEW chart\'s PDF (and a hash that is not of its bytes)'},
  {id: 'new-version-no-question', file: 'js/library.js', find: '  if(!(await askNewVersion(file.name, s, !!old))) return;\n', replace: '',
    loop: 'new version 1', why: 'New version writes as soon as a file is picked: there is no question and no Cancel'},
  {id: 'new-version-two-writes', file: 'js/library.js', find: '    await putAll(ops);\n    await load(); hooks.render();\n    toast((copy', replace: '    for(const o of ops) await putAll([o]);\n    await load(); hooks.render();\n    toast((copy',
    loop: 'new version 2', why: 'a full tablet part-way through New version leaves half of it saved (an old copy without its marks, or a song without its PDF)'},
  {id: 'new-version-no-duplicate-question', file: 'js/library.js', find: 'if(dup && !(await askDuplicates([file.name]))){', replace: 'if(false){',
    loop: 'new version 2', why: 'a PDF already in the library becomes a new version without the duplicate question'},
  {id: 'new-version-long-version', file: 'js/library.js', find: '.slice(0, 200 - tag.length - 2)', replace: '',
    loop: 'new version 2', why: 'a long version makes the old copy\'s version longer than 200 characters, which share import refuses'},
  {id: 'new-version-unreadable-as-missing', file: 'js/library.js', find: "  catch(err){ toast('Could not read the current chart, so it cannot be kept. Nothing was changed.'); return; }", replace: '  catch(err){}',
    loop: 'new version 4', why: 'a stored PDF that only failed to read this once is treated as missing: the new chart goes in and the old chart and its marks are lost'},
  {id: 'new-version-no-changed-check', file: 'js/library.js', find: "    if(songById(id) !== s || !cur || cur.deleted || cur.updated !== s.updated || cur.hash !== s.hash){ toast('That song changed in the meantime. Nothing was changed.'); return; }\n", replace: '',
    loop: 'new version 5', why: 'a song edited or deleted while the question is open is written back as it was (an edit undone, a deleted song brought back)'},
  {id: 'new-version-other-tab-unseen', file: 'js/library.js', find: 'if(songById(id) !== s || !cur || cur.deleted || cur.updated !== s.updated || cur.hash !== s.hash){', replace: 'if(songById(id) !== s){',
    loop: 'new version 5', why: 'a song edited or deleted in ANOTHER tab while the question is open is written back as it was: only this tab\'s own list is checked'},
  {id: 'new-version-not-one-at-a-time', file: 'js/library.js', find: "  if(nvRunning){ toast('A New version is already in progress.'); return; }\n", replace: '',
    loop: 'new version 6', why: 'a second New version started while the first is still reading runs alongside it'},
  {id: 'finger-hint-missing', file: 'js/viewer.js', find: "else if(V.tool === 'text' && !V.finger && e.pointerType === 'touch') toast(", replace: "else if(false) toast(",
    loop: 'finger tap', why: 'a finger tap with Text chosen does nothing and says nothing: the player thinks notes are broken'},
  {id: 'finger-hint-for-every-tool', file: 'js/viewer.js', find: "else if(V.tool === 'text' && !V.finger && e.pointerType === 'touch') toast(", replace: "else if(!V.finger && e.pointerType === 'touch') toast(",
    loop: 'finger tap', why: 'the Text hint shows when the pen is chosen too'},
  {id: 'width-button-hidden-for-other-tools', file: 'js/ink.js', find: "tw.disabled = V.tool !== 'pen';", replace: "tw.disabled = V.tool !== 'pen'; tw.hidden = V.tool !== 'pen';",
    loop: 'pen thicknesses', why: 'the thickness button vanishes for the highlighter and every button after it jumps sideways'},
  {id: 'width-button-live-for-other-tools', file: 'js/ink.js', find: "tw.disabled = V.tool !== 'pen';", replace: "tw.disabled = false;",
    loop: 'pen thicknesses', why: 'the thickness button looks pressable with the highlighter, eraser or Text, where it does nothing'},
  {id: 'width-menu-stays-open', file: 'js/ink.js', find: "markTool(); widthMenu(false); return;", replace: "markTool(); return;",
    loop: 'pen thicknesses', why: 'the row of three thicknesses stays over the page after one is chosen'},
  {id: 'width-menu-no-outside-close', file: 'js/ink.js', find: "if(!$('#wdMenu').hidden && !e.target.closest('.wdwrap')) widthMenu(false);", replace: "",
    loop: 'pen thicknesses', why: 'the row of thicknesses stays open when the player taps the page instead'},
  {id: 'stylus-needs-annotate', file: 'js/ink.js', find: "const stylus = !V.annot && e.pointerType === 'pen';", replace: "const stylus = false;",
    loop: 'the stylus draws with Annotate off', why: 'the stylus does nothing until Annotate is tapped'},
  {id: 'stylus-erases-with-annotate-off', file: 'js/ink.js', find: "const tool = stylus && V.tool !== 'hl' ? 'pen' : V.tool;", replace: "const tool = V.tool;",
    loop: 'the stylus draws with Annotate off', why: 'with the eraser chosen last, a stylus stroke erases marks with Annotate off'},
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
    try{
      /* A planted mistake that does not even parse makes the app fail to load, so every loop "catches" it by timing out
         (and slowly). That says nothing about the tests: refuse it and fix the table entry. */
      if(/\.m?js$/.test(f.file) && (await run(process.execPath, ['--check', dst], 60e3)).code !== 0){
        stale.push(f.id); console.log(`BAD FAULT  ${f.id}  (${f.file}: the planted text does not parse; fix its \`replace\`)`);
        continue;
      }
      planted++;
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

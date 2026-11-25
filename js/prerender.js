/* Pages of a setlist drawn ahead of time and kept as small pictures ("Ready 7 of 25"; Jonathan, 2026-11-25).

   WHY. A turn into a chart that is a big scan waits while pdf.js draws it (about a second for one page on a tablet), and the viewer
   only readies the song either side of the one showing. On a setlist of short scanned songs, played at a normal pace, some turns
   therefore take longer than others. The drawn pages themselves cannot all be kept: iPad Safari gives a tab about 384 MB for ALL its
   canvases (js/pagecache.js), and the page cache holds about 12 pages. A drawn page kept as a JPEG is a few hundred KB, so a whole
   setlist fits in about 10 to 30 MB, and putting one back on a canvas takes tens of milliseconds, not a second.

   WHAT. When a setlist is played (a queue of more than one song) the viewer starts a background pass that draws the pages one at a
   time, the ones next in play order first, each with the very same drawing code as a page turn (viewer.js paintPage: same size, same
   crop, same device pixel ratio), saves each as a JPEG here and empties its canvas at once. renderPage() in viewer.js asks snapOf()
   before it asks pdf.js. Nothing is written to storage: the pictures live in memory, for as long as the viewer is open and the
   window keeps its size, and are never part of a backup, a share package or a sync. The PDF and the marks are never touched.

   MANNERS. It only works while the person is not: nothing within TUNE.idle of a tap, a turn or a key, never while a pen stroke is
   open, Annotate or the Crop screen or a dialog is up, the page is hidden, or a turn is under way; a page being drawn when a tap
   arrives is cancelled (pdf.js RenderTask.cancel) and tried again later. One pdf.js document is open at a time (the song being
   done) and is closed when the next song starts. A page that will not draw, or a song that will not open, is left out and the
   pass goes on. All the pictures together stop at TUNE.max (MAX_BYTES). `localStorage` `ss-ready` = '0' switches the whole thing off
   (a loop that measures the old behaviour, or Jonathan if it ever misbehaves).

   This file knows nothing about pdf.js or the viewer: viewer.js hands over what it needs (configure()). */
import {release} from './pagecache.js';

export const MAX_BYTES = 150 * 1024 * 1024;
export const QUALITY = 0.92;
/* An object so a loop can change them. idle: no work within this many milliseconds of a tap, turn or key. tick: how often a waiting
   pass looks again. kick: how long after a draw a pass is (re)started. hide: how long "All ready" stays. max: all the pictures together, in bytes.
   gap: a rest after every page, so the tablet's own work (a tap, a turn, the pen) is never queued behind a run of pages. */
export const TUNE = {idle: 700, tick: 200, kick: 1200, hide: 4000, max: MAX_BYTES, gap: 100};

const snaps = new Map();           // key -> {blob, pw, ph, cw, ch, crop, bytes}
const failed = new Set();          // keys (or 'song:<id>') that cannot be drawn: not tried again until the next reset
let env = null, run = 0, running = false, bytes = 0, live = 0, cancels = 0, lastTouch = 0, inflight = null, kickT = 0, hideT = 0, shown = {done: 0, total: 0, state: 'off'};

export const readyOff = () => { try{ return localStorage.getItem('ss-ready') === '0'; }catch(e){ return false; } };
export const snapKey = (id, pn, W, H, dpr, cr) => id + '|' + pn + '|' + W + 'x' + H + '@' + dpr + '|' + [cr.x, cr.y, cr.w, cr.h].join(',');
export const snapOf = key => (readyOff() ? null : snaps.get(key) || null);
/* For a loop: what is kept and how the pass stands. */
export const readyState = () => ({snaps: snaps.size, bytes, running, live, cancels, drawing: !!inflight, failed: failed.size, shown: {...shown}, keys: [...snaps.keys()]});

/* What viewer.js hands over:
     plan()                      the pages to keep, in play order: [{id, pn, key, ...whatever paint() needs}]; [] when nothing is to be done
     open(id)                    Promise of an open pdf.js document for song id (it is closed with .destroy())
     paint(doc, item, onTask)    Promise of {cv, cw, ch}: the page drawn exactly as a turn draws it (onTask gets the RenderTask)
     paused()                    true while the person is doing something
     progress(done, total, state)  state 'run', 'done' or 'off' */
export function configure(e){ env = e; }

/* A snapshot put back on a canvas, or null (the caller then draws the page with pdf.js as it always did). */
export async function snapCanvas(s){
  let cv = null;
  try{
    cv = document.createElement('canvas');
    cv.width = s.pw; cv.height = s.ph;
    const ctx = cv.getContext('2d');
    if(window.createImageBitmap){
      const bmp = await createImageBitmap(s.blob);
      try{ ctx.drawImage(bmp, 0, 0, s.pw, s.ph); } finally { if(bmp.close) bmp.close(); }
    } else {
      const url = URL.createObjectURL(s.blob);
      try{
        const img = new Image();
        await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = url; });
        ctx.drawImage(img, 0, 0, s.pw, s.ph);
      } finally { URL.revokeObjectURL(url); }
    }
    return cv;
  }catch(e){ if(cv){ release(cv); } return null; }
}

/* Something the person did: work stops at once (a page being drawn is cancelled) and waits IDLE_MS. */
export function touch(){
  lastTouch = Date.now();
  if(inflight){ try{ inflight.cancel(); }catch(e){} }
}
/* Everything let go: the pictures, the failures, a pass in progress. */
export function stopReady(){
  run++; running = false; clearTimeout(kickT); clearTimeout(hideT);
  if(inflight){ try{ inflight.cancel(); }catch(e){} }
  snaps.clear(); failed.clear(); bytes = 0;
  show(0, 0, 'off');
}
/* A page was drawn: (re)start the pass a moment later if there is anything left to do. */
export function kick(){
  if(!env || readyOff()) return;
  clearTimeout(kickT);
  kickT = setTimeout(() => { if(!running) sweep(++run); }, TUNE.kick);
}

function show(done, total, state){
  shown = {done, total, state};
  if(env) try{ env.progress(done, total, state); }catch(e){}
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* Waits until the person is not busy; false when this pass was stopped meanwhile. */
async function calm(my){
  for(;;){
    if(my !== run) return false;
    if(!env.paused() && Date.now() - lastTouch >= TUNE.idle) return true;
    await sleep(TUNE.tick);
  }
}
const closeDoc = d => { if(d){ try{ d.destroy(); }catch(e){} } };

async function sweep(my){
  if(!env || running || readyOff()) return;
  running = true;
  let doc = null, docId = null, made = 0;       // made: pages this pass has kept (a pass with nothing to do, after a turn, says nothing)
  try{
    for(;;){
      if(my !== run) return;
      const plan = env.plan();
      if(!plan.length){ show(0, 0, 'off'); return; }
      /* a picture the plan no longer asks for (a crop was edited, so its key changed) is let go: only what a turn can use stays in memory */
      const wanted = new Set(plan.map(p => p.key));
      for(const [k, v] of snaps) if(!wanted.has(k)){ snaps.delete(k); bytes -= v.bytes; }
      /* pages that cannot be drawn (a page that failed, a song that will not open) are not counted: "Ready 9 of 9" is the end */
      const bad = p => failed.has(p.key) || failed.has('song:' + p.id);
      const keys = [...new Set(plan.filter(p => !bad(p)).map(p => p.key))];
      const done = keys.filter(k => snaps.has(k)).length;
      const item = plan.find(p => !snaps.has(p.key) && !bad(p));
      if(!item || bytes >= TUNE.max){
        if(made){ show(done, keys.length, 'done'); hideT = setTimeout(() => { if(my === run) show(0, 0, 'off'); }, TUNE.hide); }
        else show(0, 0, 'off');
        return;
      }
      show(done, keys.length, 'run');
      if(!await calm(my)) return;
      if(docId !== item.id){
        closeDoc(doc); doc = null; docId = item.id;
        try{ doc = await env.open(item.id); }catch(e){ doc = null; }
        if(my !== run){ closeDoc(doc); doc = null; return; }
        if(!doc){ failed.add('song:' + item.id); continue; }
        continue;                          // opening a big PDF takes a while: look again (plan, calm) before drawing anything
      }
      let cv = null, cancelled = false, task = null;
      try{
        const r = await env.paint(doc, item, t => {
          task = inflight = t;
          /* a tap (or a stop) that came while the page was still being fetched from the document: cancel at once, nothing is waiting for it */
          if(my !== run || Date.now() - lastTouch < TUNE.idle){ try{ t.cancel(); }catch(e){} }
        });
        cv = r.cv; live++;
        if(my !== run) return;
        const blob = await new Promise(ok => { try{ cv.toBlob(ok, 'image/jpeg', QUALITY); }catch(e){ ok(null); } });
        if(!blob){ failed.add(item.key); }
        else if(my === run){ snaps.set(item.key, {blob, pw: cv.width, ph: cv.height, cw: r.cw, ch: r.ch, crop: item.crop, bytes: blob.size}); bytes += blob.size; made++; }
      }catch(e){
        /* pdf.js says a cancelled render by an exception named RenderingCancelledException: the person did something, the page is tried again */
        if(e && e.name === 'RenderingCancelledException'){ cancelled = true; cancels++; } else failed.add(item.key);
      } finally {
        if(inflight === task) inflight = null;          // only this page's own task (a pass that was stopped must not clear the next pass's)
        if(cv){ release(cv); if(cv.width === 0) live--; }          // emptied at once: only then is it let go of (live counts the canvases held, for a loop)
      }
      await sleep(cancelled ? 0 : TUNE.gap);
    }
  } finally {
    closeDoc(doc);
    if(my === run) running = false;
  }
}

/* The back gesture (Android's back, the iPad's edge swipe) while a song is open: one browser-history entry per LAYER.

   The layers, bottom to top: the song, Annotate, the line-thickness menu, the Crop screen, each dialog (depth()). Each
   layer that a TAP opens gets one history entry ({ss:'viewer', d:<depth>}, same address), pushed while the tap's user
   activation is still on: Chrome's back button skips an entry that was left by a pushState made without one (its
   "history manipulation intervention"), so an entry pushed from code that runs by itself (popstate, a timer, a page load)
   could make the next back leave the app. A layer that opens without a tap gets no entry.

   Back means Escape: popstate presses Escape once for each entry the gesture took (a dialog's Cancel, the Crop screen,
   the menu, Annotate off, then the song: the viewer's own Escape). A layer closed any other way (its own button, Escape,
   a dialog closing after its write) takes its entry off with history.go(-n), once (`expect` counts our own steps back
   until their popstate arrives; nothing is pushed or popped meanwhile). The one exception: when a gesture leaves a layer
   open (a dialog that ignores Escape mid-write, or one that opened without a tap and so had no entry of its own), the
   entry is put back from popstate, without a tap: the song must never be left open with no entry under it.

   No song open: no entry, no handling; back leaves the app from the Library and Setlists screens as it always did.
   Start-up: an entry left from before a reload is taken off before anything is drawn (dropLeftover), unless the song is
   being put back after an update reload: then that entry is reused, never doubled. */
import {$} from './util.js';

const MARK = 'viewer';
const depthOf = st => st && st.ss === MARK && Number.isInteger(st.d) && st.d > 0 ? st.d : 0;
const now = () => { try{ return depthOf(history.state); }catch(e){ return 0; } };

export function depth(){
  const v = $('#viewer'); if(!v || !v.classList.contains('on')) return 0;
  let n = 1;
  if(v.classList.contains('annot')) n++;
  const wm = $('#wdMenu'); if(wm && !wm.hidden) n++;
  const cr = $('#cropper'); if(cr && !cr.hidden) n++;
  n += document.querySelectorAll('.modal').length;
  return n;
}

let lastInput = 0, expect = 0, last = 0, gen = 0;
/* A tap is under way (or just was): Chrome and Safari 16.4+ say so; older Safari: an input in the last second. */
const active = () => navigator.userActivation ? navigator.userActivation.isActive : Date.now() - lastInput < 1000;
function push(){ try{ history.pushState({ss:MARK, d:now() + 1}, ''); }catch(e){} last = now(); }
/* Push until the depth is `want`, but never forever: a push the browser silently drops (a flood limit) must not freeze the tab. */
function pushTo(want){ for(let i = 0; now() < want && i < 10; i++){ const before = now(); push(); if(now() === before) break; } }
function stepBack(k){
  expect++; const g = ++gen;
  setTimeout(() => { if(g === gen && expect){ expect = 0; last = now(); sync(); } }, 1500);   // a popstate that never comes must not stop the next layer
  try{ history.go(-k); }catch(e){ expect = 0; }
}
/* Entries follow the layers: one off for each layer gone, one on for each layer a tap opened. */
export function sync(){
  if(expect) return;                     // our own step back is on its way
  const have = now(), want = depth();
  if(have > want) stepBack(have - want);
  else if(have < want && active()) pushTo(want);
  last = now();
}
/* Exactly what the Escape key does at this moment: sent to the top dialog (to its focused field, or to the dialog), or else
   to what has focus, so it reaches the same listeners a real key press would. */
function pressEscape(){
  const top = [...document.querySelectorAll('.modal')].pop(), a = document.activeElement;
  const to = top ? (top.contains(a) ? a : top.firstElementChild) : (a && a !== document.documentElement ? a : document.body);
  to.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', code:'Escape', bubbles:true, cancelable:true}));
}
function onPop(){
  const at = now(), was = last;
  last = at;
  if(expect){ expect--; return sync(); }                          // our own step back has arrived: catch up with anything opened or closed meanwhile
  if(at >= was) return sync();                                     // forward, or nothing taken: entries follow the layers again
  for(let i = 0; i < was - at && depth() > at; i++){ const d = depth(); pressEscape(); if(depth() >= d) break; }
  if(depth() > at){ pushTo(depth()); }              // a layer stayed open (it ignores Escape, or had no entry): keep one entry under each
  else sync();
}

let leftover = null;
/* Start-up, FIRST (before the library is read or anything drawn): an entry left from before a reload is taken off, unless the
   open song is being put back (an update reload: `ss-resume`), whose entry is then reused. Resolves when it is done. */
export function dropLeftover(resuming){
  const d = now();
  if(!d) return Promise.resolve();
  if(resuming){ last = d; return Promise.resolve(); }
  return leftover || (leftover = new Promise(res => {
    const done = () => { removeEventListener('popstate', done); clearTimeout(t); last = now(); res(); };
    const t = setTimeout(done, 1500);
    addEventListener('popstate', done);
    try{ history.go(-d); }catch(e){ done(); }
  }));
}

export function initBackNav(){
  last = now();
  for(const k of ['pointerdown', 'keydown', 'click', 'touchend']) addEventListener(k, e => { if(e.isTrusted) lastInput = Date.now(); }, true);   // not our own synthetic Escape or click
  addEventListener('popstate', onPop);
  let queued = false;
  const later = () => { if(!queued){ queued = true; queueMicrotask(() => { queued = false; sync(); }); } };
  const mo = new MutationObserver(later);
  mo.observe(document.body, {childList:true});
  for(const s of ['#viewer', '#cropper', '#wdMenu']){ const el = $(s); if(el) mo.observe(el, {attributes:true, attributeFilter:['class', 'hidden']}); }
}

import {esc} from './util.js';
import {LETTERS, songLetter, firstAtOrAfter} from './names.js';

/* The A to Z strip on the Library's right edge (Jonathan, 2026-11-23). One job: draw the 27 letters, jump the list to a letter, and
   keep the strip as tall as the screen under it. The letter and the jump target come from names.js, the same collator that sorts
   the list, so the strip can never disagree with it. Nothing is stored. */
export const STRIP_MIN = 30;         // shown only for a list longer than about two screens (13 rows fit on an 820 x 1180 iPad)

let dragging = null;                 // {id, last}: a finger or the mouse is sliding on the strip
let drawn = [];                      // the list the strip was last drawn for (live songs, sorted, after collection and search)
let current = '#';                   // the letter that holds the one Tab stop
const label = L => L === '#' ? 'Jump to songs that start with a number or a sign' : `Jump to ${L}`;

/* The strip for a sorted list; the library puts it in #libStrip. A letter with no song is dimmed but still works (it goes to the
   next letter's first song). One Tab stop: the arrow keys, Home and End move inside. */
export function stripHtml(list){
  drawn = list;
  const have = new Set(list.map(songLetter));
  if(!LETTERS.includes(current)) current = '#';
  return `<nav id="azStrip" class="az" aria-label="Jump to a letter">${LETTERS.map(L =>
    `<button type="button" data-az="${esc(L)}" class="${have.has(L) ? '' : 'none'}" aria-label="${esc(label(L))}" tabindex="${L === current ? 0 : -1}">${esc(L)}</button>`).join('')}</nav>`;
}

/* Scroll the list so the letter's first song is at the top. focus: also move the keyboard focus to that row (for a keyboard or a
   screen reader; a finger does not need it). An empty list: nothing. */
export function jumpTo(L, list, {focus} = {}){
  const s = firstAtOrAfter(list || drawn, L); if(!s) return;
  const b = document.querySelector(`#libList [data-open="${CSS.escape(s.id)}"]`); if(!b) return;
  const row = b.closest('li') || b;
  row.scrollIntoView({block: 'start'});
  if(focus) b.focus({preventScroll: true});
}

/* The strip is fixed to the screen's right edge, as high as the library's list starts (the header is above it at first) and then at the
   top of the screen, and as tall as the screen under that, so every letter is on screen also at the foot of the page. It is not
   position:sticky: a sticky strip cannot leave the list's own box, so at the foot of the page it would be pushed up and out of sight.
   The empty column #libStrip keeps its place in the page; --az-top is that column's top. Called when the strip is drawn, on scroll
   and on resize, and when the page's content changes height. */
let watching = false, queued = false;
function measure(){
  const el = document.getElementById('azStrip'), cell = document.getElementById('libStrip'); if(!el || !cell) return;
  el.style.setProperty('--az-top', Math.round(cell.getBoundingClientRect().top) + 'px');
  fitLetters(el);
}
/* Room for the letters: 27 letters at least MIN_LETTER px each when the strip is tall enough. A shorter strip draws fewer letters, evenly
   spaced and each at least LEAD_H px tall with a dot under it (sliding still reaches every letter: letterAt() works from the finger's
   height), and one too short for six letters is hidden until the page is scrolled and there is room (as a phone's contact list does). */
const MIN_LETTER = 14, LEAD_H = 20, MIN_LEADS = 6;
function fitLetters(el){
  const all = [...el.querySelectorAll('[data-az]')], H = el.getBoundingClientRect().height;
  const clear = () => { el.classList.remove('thin', 'low'); for(const b of all) b.classList.remove('off', 'lead', 'last'); };
  clear();
  if(H >= all.length * MIN_LETTER) return;
  const leads = Math.floor(H / LEAD_H);
  if(leads < MIN_LEADS){ el.classList.add('low'); return; }
  el.classList.add('thin');
  const pick = new Set(Array.from({length: leads}, (_, i) => Math.round(i * (all.length - 1) / (leads - 1))));
  all.forEach((b, i) => { if(pick.has(i)) b.classList.add('lead'); else b.classList.add('off'); });
  all[[...pick].pop()].classList.add('last');
  if(el.querySelector('[tabindex="0"].off')){ for(const b of all) b.tabIndex = -1; el.querySelector('.lead').tabIndex = 0; }
}
/* Not while a finger is sliding on the strip: the letters must not move under it (the strip goes to its place when the finger lifts). */
const later = () => { if(queued || dragging) return; queued = true; requestAnimationFrame(() => { queued = false; if(!dragging) measure(); }); };
export function fitStrip(){
  measure();
  if(watching) return;
  watching = true;
  addEventListener('scroll', () => { if(!dragging) measure(); }, {passive: true});     // in the scroll event itself, so the strip does not trail the page
  addEventListener('resize', later);
  const view = document.getElementById('view');
  if(view && typeof ResizeObserver === 'function') new ResizeObserver(later).observe(view);
}

/* Touch and mouse: the letter under the finger jumps the list, and sliding along the strip scrubs through it (like the contacts list
   on a phone). Registered here, once, so main.js is not touched. */
const letterAt = (x, y) => {
  const strip = document.getElementById('azStrip');
  if(strip && strip.classList.contains('thin')){            // letters left out: the finger's height says which letter (a hidden one included)
    const r = strip.getBoundingClientRect(); return LETTERS[Math.min(LETTERS.length - 1, Math.max(0, Math.floor((y - r.top) / r.height * LETTERS.length)))];
  }
  const e = document.elementFromPoint(x, y); const b = e && e.closest && e.closest('#azStrip [data-az]'); return b ? b.dataset.az : null; };
document.addEventListener('pointerdown', e => {
  if(e.button > 0) return;
  const b = e.target.closest && e.target.closest('#azStrip [data-az]'); if(!b) return;
  e.preventDefault();
  try{ document.getElementById('azStrip').setPointerCapture(e.pointerId); }catch(err){}
  dragging = {id: e.pointerId, last: b.dataset.az, y0: e.clientY};
  jumpTo(dragging.last, drawn);
});
document.addEventListener('pointermove', e => {
  if(!dragging || e.pointerId !== dragging.id) return;
  const strip = document.getElementById('azStrip'); if(!strip){ dragging = null; return; }
  const r = strip.getBoundingClientRect();
  if(strip.classList.contains('thin') && Math.abs(e.clientY - dragging.y0) < 12 && !dragging.moved) return;     // a finger's wobble on a short strip's letter stays on that letter
  dragging.moved = true;
  const L = letterAt(r.left + r.width / 2, Math.min(Math.max(e.clientY, r.top + 1), r.bottom - 1));
  if(L && L !== dragging.last){ dragging.last = L; jumpTo(L, drawn); }
});
const done = e => { if(dragging && e.pointerId === dragging.id){ dragging = null; later(); } };
document.addEventListener('pointerup', done);
document.addEventListener('pointercancel', done);

/* Keyboard and screen reader: Enter or Space on a letter (a click with no pointer, detail 0) jumps AND moves the focus to the first row.
   A finger's or mouse's click already jumped on pointerdown. */
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('#azStrip [data-az]'); if(!b) return;
  if(e.detail === 0) jumpTo(b.dataset.az, drawn, {focus: true});
});
document.addEventListener('focusin', e => {
  const b = e.target.closest && e.target.closest('#azStrip [data-az]'); if(!b) return;
  current = b.dataset.az;
  for(const x of document.querySelectorAll('#azStrip [data-az]')) x.tabIndex = x === b ? 0 : -1;
});
document.addEventListener('keydown', e => {
  const b = e.target.closest && e.target.closest('#azStrip [data-az]'); if(!b || e.altKey || e.ctrlKey || e.metaKey) return;
  const all = [...document.querySelectorAll('#azStrip [data-az]:not(.off)')], i = all.indexOf(b);
  const to = e.key === 'ArrowDown' ? Math.min(i + 1, all.length - 1) : e.key === 'ArrowUp' ? Math.max(i - 1, 0) : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : -1;
  if(to < 0) return;
  e.preventDefault(); all[to].focus();
});

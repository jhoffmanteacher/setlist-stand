/* Small helpers shared by every module. */
import {compareSongs, songMatches} from './names.js';

/* The Content-Security-Policy in index.html forbids eval. pdf.js would otherwise probe it with new Function(""), which
   the browser reports as a policy violation; isEvalSupported:false makes it draw glyphs without compiled code.
   This file is imported first by every module, so the wrapper is in place before any PDF opens. */
if(window.pdfjsLib && !window.pdfjsLib.noEval){
  const lib = window.pdfjsLib, getDocument = lib.getDocument;
  const opts = src => typeof src === 'string' || src instanceof URL ? {url:String(src)}
    : src instanceof ArrayBuffer || ArrayBuffer.isView(src) ? {data:src} : {...src};
  /* pdfjsLib's exports are read-only getters, so the page gets a stand-in whose prototype is the real library. */
  window.pdfjsLib = Object.create(lib, {
    getDocument:{value:src => getDocument({...opts(src), isEvalSupported:false})},
    noEval:{value:true},
  });
}

/* The number of pages pdf.js finds in PDF bytes (an ArrayBuffer or a Uint8Array). Throws if it cannot open them. */
export async function pdfPageCount(bytes){
  const task = pdfjsLib.getDocument({data:new Uint8Array(bytes.slice(0))});
  try{ return (await task.promise).numPages; }
  finally{ task.destroy(); }              // also when the file cannot be opened: no worker is left holding its bytes
}

export const $ = s => document.querySelector(s);
export const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
/* An id nobody has used: uid() can repeat when it is called in a tight loop (a big package), and a repeated key would silently
   overwrite the record written before it. `taken` is the set of ids in use; the new id is added to it. Share import, New version,
   Copy song, a restore's kept copies and sync make ids with it (js/shareimport.js re-exports it for its old importers). */
export const unique = taken => { let id = uid(), n = 0; while(taken.has(id)) id = uid() + (++n > 3 ? n.toString(36) : ''); taken.add(id); return id; };

/* Modules call hooks.render() to redraw the home screen; main.js fills it in. */
export const hooks = {render(){}};

/* toast(message) shows a line at the foot of the screen for a moment. toast(message, {action, run, ms}) adds ONE button (Undo) beside it:
   a real button, so it is reached by Tab and pressed by Enter; tapping it hides the toast and calls run(). The button is taken away when
   the toast goes (after `ms`, default 6 s) or when the next toast replaces it: only the newest action can be pressed. */
let toastT;
function hideToast(){
  const t = $('#toast'); t.classList.remove('on', 'act');
  const b = t.querySelector('.toastact'); if(b) b.remove();
}
export function toast(m, {action = '', run = null, ms = 0} = {}){
  const t = $('#toast'); t.textContent = m;
  const act = !!(action && run);
  if(act){
    const b = document.createElement('button'); b.type = 'button'; b.className = 'toastact'; b.textContent = action;
    b.onclick = () => { if(!b.isConnected) return; hideToast(); clearTimeout(toastT); run(); };
    t.append(' ', b);
  }
  t.classList.add('on'); t.classList.toggle('act', act);
  /* a short message stays 2.2 s; a long one (a refusal that explains itself) stays long enough to read, up to 9 s */
  clearTimeout(toastT); toastT = setTimeout(hideToast, ms || (act ? 6000 : Math.min(9000, Math.max(2200, String(m).length * 55))));
}

/* The second tap of a double tap must not land on the page behind a dialog the first tap closed (at 412 px the song picker's Add
   button sits over a setlist row's Remove). When a dialog is closed by a real tap (modal()'s remove, inside that tap's event), a real
   pointer, mouse or touch event within QUIET ms and NEAR px of that tap, and outside any dialog, is swallowed with the rest of its gesture.
   A tap anywhere else, a key, and a click made by code (a file chooser opened from a menu) are never held back. menuBox's item runs in
   the tap that chose it, while that tap is still being handled, so this never touches it. */
const QUIET = 400, NEAR = 40;
let guard = null, eatUntil = 0, eatAt = null, eatenAt = 0;
const eaten = new Set();                   // pointers whose pointerdown was swallowed: the rest of their gesture goes too (for 3 s at most)
const near = (x, y, p) => !!p && Math.abs(x - p.x) <= NEAR && Math.abs(y - p.y) <= NEAR;
const inDialog = t => !!(t && t.closest && t.closest('.modal'));
const guarded = (x, y, t) => !!guard && performance.now() < guard.until && near(x, y, guard) && !inDialog(t);
const eat = e => { e.stopImmediatePropagation(); if(e.cancelable) e.preventDefault(); };
function armGuard(){
  const e = window.event;          // the event being handled when the dialog closed, if any
  if(!e || !e.isTrusted || typeof e.clientX !== 'number' || (e.type === 'click' && e.detail === 0)) return;      // a key (Enter, Escape) is not a tap
  guard = {until: performance.now() + QUIET, x: e.clientX, y: e.clientY};
}
const pt = e => e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : e;
const eating = () => { if(eaten.size && performance.now() - eatenAt > 3000) eaten.clear(); return eaten.size > 0; };
addEventListener('pointerdown', e => { if(e.isTrusted && guarded(e.clientX, e.clientY, e.target)){ eating(); eaten.add(e.pointerId); eatenAt = performance.now(); eat(e); } }, true);
for(const type of ['pointermove', 'pointerup', 'pointercancel']) addEventListener(type, e => {
  if(!eating() || !eaten.has(e.pointerId)) return;
  if(type !== 'pointermove'){ eaten.delete(e.pointerId); eatUntil = performance.now() + 800; eatAt = {x: e.clientX, y: e.clientY}; }
  eat(e);
}, true);
/* (no touchstart: a non-passive one on the window would make every scroll wait for this script; the app has no touch listeners, and the
   touchend and click of a swallowed tap are swallowed here) */
for(const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'touchend']) addEventListener(type, e => {
  if(!e.isTrusted) return;
  const p = pt(e);
  if(eating() || (performance.now() < eatUntil && near(p.clientX, p.clientY, eatAt)) || guarded(p.clientX, p.clientY, e.target)) eat(e);
}, {capture: true, passive: false});

/* Every dialog goes through modal(): it is a real dialog for screen readers and keyboards. Focus moves in and Tab
   stays inside; Escape presses Cancel ([data-x]) or closes it; the page behind is inert while it is open; and
   m.remove() (however the caller closes it) gives focus back to whatever had it before.
   Where it is mounted: a dialog goes to the end of <body>, the toast and the crop screen sit beside #viewer. That only
   works because FULL SCREEN is asked of the whole page (document.documentElement, see #vFull in viewer.js): a browser
   in full screen draws just the full-screen element and what is inside it, so with #viewer alone a dialog opened out of
   sight while the viewer behind it was inert, which looked like a freeze. Keep every dialog, toast and screen inside the
   full-screen element; never make a part of the page the full-screen element. */
const BEHIND = ['.app', '#viewer', '#cropper', '#splitter'];
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([type=hidden]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
const focusables = m => [...m.querySelectorAll(FOCUSABLE)].filter(el => el.getClientRects().length);
/* The songbook splitter covers the whole page, so the app under it stays inert even after a dialog above it closes. */
function setBehind(on){
  const sp = $('#splitter'), splitting = !!sp && !sp.hidden;
  for(const s of BEHIND){ const el = $(s); if(el) el.inert = on || (s === '.app' && splitting); }
}
export function modal(html){
  const opener = document.activeElement;
  const m = document.createElement('div'); m.className = 'modal';
  const hid = 'dlg' + uid();
  m.innerHTML = `<div class="box" role="dialog" aria-modal="true" tabindex="-1">${html}</div>`;
  const box = m.firstElementChild, h = box.querySelector('h1, h2, h3');
  if(h){ h.id = h.id || hid; box.setAttribute('aria-labelledby', h.id); }
  document.body.append(m);
  setBehind(true);
  const first = box.querySelector('input:not([type=hidden]), textarea, select');
  (first || box).focus();
  m.addEventListener('keydown', e => {
    if(e.key === 'Escape'){
      /* preventDefault marks it handled: the viewer's own Escape (close Annotate / the viewer) skips it. It still
         bubbles, so a dialog's own window listener also sees it. */
      const first = !e.defaultPrevented; e.preventDefault();
      if(!first || !m.isConnected) return;
      const x = m.querySelector('[data-x]');
      if(x) x.click(); else m.remove();
      return;
    }
    if(e.key !== 'Tab') return;
    /* Tab always moves focus here by itself, never by the browser's own Tab stops: Safari's default skips buttons and
       checkboxes, which would drop focus out of the dialog (onto the page behind, where Escape does nothing). */
    e.preventDefault();
    const f = focusables(m); if(!f.length){ box.focus(); return; }
    const i = f.indexOf(document.activeElement);
    f[e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === -1 || i === f.length - 1 ? 0 : i + 1)].focus();
  });
  const remove = m.remove.bind(m);
  m.remove = () => {
    if(!m.isConnected) return;
    remove();
    armGuard();                                                // a double tap's second tap must not land on the page behind

    if(!document.querySelector('.modal')) setBehind(false);   // else another dialog is still open: keep the page inert
    if(opener && opener.isConnected && opener !== document.body && typeof opener.focus === 'function') opener.focus();
  };
  return m;
}
/* A waiting dialog with a status line (role=status, so a screen reader reads each change) and a Stop button; Escape presses
   Stop. `job.stopped` turns true when Stop is pressed: the caller decides when to carry on, and where it is safe to stop.
   job.say(text) changes the line; job.close() removes the box; job.lock(text) takes Stop away (and makes Escape do
   nothing) for the part of a job that cannot be stopped, such as the one write that saves a restored library.
   Open it before the first await of a long job: Escape and Stop then reach this dialog, not the screen behind. */
export function busy(title, text){
  const m = modal(`<h2>${esc(title)}</h2><p class="hint" role="status">${esc(text)}</p><div class="btns"><button data-x>Stop</button></div>`);
  const line = m.querySelector('p'), stop = m.querySelector('[data-x]'), box = m.firstElementChild;
  /* body.busy hides the "Updated. Tap to reload" banner (it sits above dialogs) and holds back an update reload: a tap on it
     must not throw away a restore or a backup that is under way. */
  document.body.classList.add('busy');
  const job = {stopped:false, locked:false, say:t => { if(line.textContent !== t) line.textContent = t; },    // not rewritten when unchanged: a screen reader would read it again
    close:() => { document.body.classList.remove('busy'); m.remove(); },
    lock:t => { job.locked = true; stop.hidden = true; box.focus(); if(t) job.say(t); }};   // hiding the focused Stop would drop focus onto the page behind
  stop.onclick = () => { if(job.locked) return; job.stopped = true; line.textContent = 'Stopping…'; };
  return job;
}
export function ask(title, val = ''){
  return new Promise(res => {
    const m = modal(`<h2>${esc(title)}</h2><input type="text" maxlength="200" value="${esc(val)}"><div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Save</button></div>`);
    const i = m.querySelector('input'); i.focus(); i.select();
    const done = v => { m.remove(); res(v); };
    m.querySelector('[data-x]').onclick = () => done(null);
    m.querySelector('[data-ok]').onclick = () => done(i.value.trim() || null);
    i.onkeydown = e => { if(e.key === 'Enter'){ e.preventDefault(); done(i.value.trim() || null); } if(e.key === 'Escape') done(null); };   // see form()
  });
}
/* A dialog with several text fields. fields: [{key, label, value}]. Resolves to {key: value} or null.
   checks (optional): {label, options:[{value, label, on}]} adds a group of tick boxes under the fields (the Collections of a
   song or a setlist); the result then also has `checks`: the values ticked. With no text fields the first tick box takes focus.
   check (optional): v => null, or [key, message] for a value that cannot be saved: Save then keeps the box open, says the message
   under the fields and puts focus in that field (Edit song with its title emptied). */
export function form(title, fields, checks, check = null){
  return new Promise(res => {
    const group = checks && checks.options.length ? `<fieldset class="fld checks"><legend>${esc(checks.label)}</legend>${checks.options.map(o => `<label class="opt"><input type="checkbox" value="${esc(o.value)}" ${o.on ? 'checked' : ''}>${esc(o.label)}</label>`).join('')}</fieldset>` : '';
    const m = modal(`<h2>${esc(title)}</h2>${fields.map(f => `<label class="fld"><span>${esc(f.label)}</span><input type="text" maxlength="200" data-k="${f.key}" value="${esc(f.value || '')}"></label>`).join('')}${check ? '<p class="hint warnline" role="alert" data-err hidden></p>' : ''}${group}<div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Save</button></div>`);
    const ins = [...m.querySelectorAll('input[type=text]')], err = m.querySelector('[data-err]');
    if(ins[0]){ ins[0].focus(); ins[0].select(); }
    if(err) m.addEventListener('input', () => { err.hidden = true; });
    const done = ok => {
      const v = ok ? Object.fromEntries(ins.map(i => [i.dataset.k, i.value.trim()])) : null;
      const bad = v && check && check(v);
      if(bad){ err.textContent = bad[1]; err.hidden = false; const i = ins.find(x => x.dataset.k === bad[0]); if(i) i.focus(); return; }
      if(v && checks) v.checks = [...m.querySelectorAll('fieldset.checks input:checked')].map(c => c.value);
      m.remove(); res(v);
    };
    m.querySelector('[data-x]').onclick = () => done(false);
    m.querySelector('[data-ok]').onclick = () => done(true);
    /* Enter saves only from a text field: on Cancel (or any other button) it presses that button, as a click would.
       preventDefault: otherwise the same key press goes on to "click" the button focus returns to (Edit), which
       opens the dialog again. */
    m.onkeydown = e => { if(e.key === 'Enter' && e.target.matches('input[type=text]')){ e.preventDefault(); done(true); } if(e.key === 'Escape') done(false); };
  });
}
/* A checklist of songs with a search box: resolves to the ticked ids. The title and the button can be changed ({title, button});
   the defaults are the setlist's "Add songs". The list is A to Z (compareSongs).
   - ordered: true (only "Add songs" on a setlist): each song tapped gets the next number (1, 2, 3...), shown where the tick box is;
     tapping a numbered song takes its number away and the songs after it move up one; the button reads "Add N" and waits for a
     song; the ids come back in number order. A song can be picked once per dialog. Without it the ids come back in list order.
   - all: a longer list of songs; a "Show all songs" switch then swaps the short list (`songs`) for it. A song ticked in one stays
     ticked in the other.
   - archived: songs passed with `archived: true` are hidden until a "Show archived" box is ticked (the box appears only when the list
     has one); they then read "(archived)". A song ticked stays ticked while the box hides it, like a search.
   - the search box narrows the list (songMatches in js/names.js, the Library's own match); songs ticked or numbered keep their tick
     or number while a search hides them, and the button still counts them. It does not take focus when the dialog opens (the
     on-screen keyboard of a tablet would cover the list): focus starts on the dialog itself.
   Every row is a real checkbox; with numbers its label ends ", N" for a screen reader. Nothing is returned until the button. */
export function pick(songs, {title = 'Add songs', button = 'Add', needOne = false, all = null, ordered = false} = {}){
  const sorted = list => [...list].sort(compareSongs);          // A to Z by song name, like the library (items carry song, artist, version, or just a title)
  const short = sorted(songs), long = all ? sorted(all) : short, order = [];       // order: the ids picked, in the order they were tapped
  let showAll = false, showArch = false, q = '';
  const hasArch = long.some(s => s.archived);
  return new Promise(res => {
    const rows = () => {
      const every = showAll ? long : short, base = every.filter(s => showArch || !s.archived), list = base.filter(s => songMatches(s, q));
      if(!list.length) return `<p>${!base.length ? (every.length ? 'Only archived songs are left. Tick Show archived to see them.' : 'Your library is empty. Add PDFs first.')
        : !showArch && every.some(s => s.archived && songMatches(s, q)) ? 'Only archived songs match. Tick Show archived to see them.' : 'No songs match.'}</p>`;
      return list.map(s => { const n = order.indexOf(s.id) + 1;
        return `<label${ordered ? ' class="po"' : ''}><input type="checkbox" value="${esc(s.id)}" ${n ? 'checked' : ''}>${ordered ? `<span class="badge" aria-hidden="true">${n || ''}</span>` : ''}<span class="pt">${esc(s.title)}${s.archived ? ' (archived)' : ''}</span>${ordered && n ? `<span class="vh">, ${n}</span>` : ''}</label>`; }).join('');
    };
    const m = modal(`<h2>${esc(title)}</h2><input type="search" class="pickq" aria-label="Search songs" placeholder="Search songs" autocomplete="off" autocapitalize="off" spellcheck="false">${all ? '<label class="sw-row"><input type="checkbox" data-showall>Show all songs</label>' : ''}${hasArch ? '<label class="sw-row"><input type="checkbox" data-showarch>Show archived</label>' : ''}<div class="pick">${rows()}</div><div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>${esc(button)}</button></div>`);
    const ok = m.querySelector('[data-ok]'), box = m.querySelector('.pick');
    m.firstElementChild.focus();                       // modal() puts focus in the first field, which is the search box: the tablet keyboard must not pop up by itself
    const sync = () => {
      ok.textContent = ordered ? `${button} ${order.length}` : button;
      if(needOne || ordered) ok.disabled = !order.length;                              // the button waits for a pick
    };
    sync();
    /* numbers are rewritten in place (no redraw, so the list keeps its scroll position and the focus stays on the row) */
    const renumber = () => {
      if(!ordered) return;
      for(const l of box.querySelectorAll('label.po')){
        const n = order.indexOf(l.querySelector('input').value) + 1;
        l.querySelector('.badge').textContent = n || '';
        let v = l.querySelector('.vh');
        if(n){ if(!v){ v = document.createElement('span'); v.className = 'vh'; l.append(v); } v.textContent = ', ' + n; } else if(v) v.remove();
      }
    };
    m.addEventListener('input', e => { if(e.target.matches('.pickq')){ q = e.target.value; box.innerHTML = rows(); } });
    m.addEventListener('change', e => {
      if(e.target.matches('[data-showall]')){ showAll = e.target.checked; box.innerHTML = rows(); return; }
      if(e.target.matches('[data-showarch]')){ showArch = e.target.checked; box.innerHTML = rows(); return; }
      if(!e.target.matches('.pick input')) return;
      const id = e.target.value, i = order.indexOf(id);
      if(e.target.checked && i < 0) order.push(id); else if(!e.target.checked && i >= 0) order.splice(i, 1);
      renumber(); sync();
    });
    m.querySelector('[data-x]').onclick = () => { m.remove(); res([]); };
    ok.onclick = () => { const ids = ordered ? [...order] : long.filter(s => order.includes(s.id)).map(s => s.id); m.remove(); res(ids); };
  });
}
/* two-tap confirm instead of confirm() */
export function armed(btn, msg = 'Tap again'){
  if(btn.dataset.armed) return true;
  const t = btn.textContent; btn.dataset.armed = 1; btn.textContent = msg;
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = t; }, 3000);
  return false;
}

/* A name safe to save a file under: slashes become '-' (a date such as 10/18/2026 stays readable); the other characters a file system
   refuses, control characters and the invisible direction marks (a name must not read backwards in a file list) are dropped; the
   letters are put in one composed form (so "Café" typed two ways is one name); leading dots and spaces go (a leading dot makes a hidden
   file) and trailing dots and spaces go (Windows); and it is cut to 150 characters AND 200 bytes of UTF-8, at a whole character
   (a file name is limited to 255 bytes, and an accented or Japanese letter takes 2 or 3, which must still leave room for " (2).pdf"). */
export const fileName = s => {
  const n = String(s).normalize('NFC').replace(/[\\/]+/g, '-').replace(/[:*?"<>|\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, '').replace(/^[.\s]+/, '');
  let out = '', bytes = 0, chars = 0;
  for(const ch of n){
    const b = new TextEncoder().encode(ch).length;
    if(chars + 1 > 150 || bytes + b > 200) break;
    out += ch; bytes += b; chars++;
  }
  return out.replace(/[.\s]+$/, '') || 'setlist';
};

/* Downloads use a plain <a download>. */
export function saveBlob(blob, name){
  const u = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = u; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
  return true;
}
/* Android share sheet, where the browser can share files. */
export const canShareFile = (blob, name) => {
  try{ return !!(navigator.canShare && navigator.canShare({files:[new File([blob], name, {type:blob.type})]})); }
  catch(e){ return false; }
};
export async function shareBlob(blob, name){
  try{ await navigator.share({files:[new File([blob], name, {type:blob.type})], title:name}); return true; }
  catch(e){ if(e && e.name !== 'AbortError') toast('Sharing is not available here'); return false; }
}

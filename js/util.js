/* Small helpers shared by every module. */

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

/* Modules call hooks.render() to redraw the home screen; main.js fills it in. */
export const hooks = {render(){}};

let toastT;
export function toast(m){
  const t = $('#toast'); t.textContent = m; t.classList.add('on');
  /* a short message stays 2.2 s; a long one (a refusal that explains itself) stays long enough to read, up to 9 s */
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), Math.min(9000, Math.max(2200, String(m).length * 55)));
}

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
  const line = m.querySelector('p'), stop = m.querySelector('[data-x]');
  const job = {stopped:false, locked:false, say:t => { line.textContent = t; }, close:() => m.remove(),
    lock:t => { job.locked = true; stop.hidden = true; if(t) line.textContent = t; }};
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
/* A dialog with several text fields. fields: [{key, label, value}]. Resolves to {key: value} or null. */
export function form(title, fields){
  return new Promise(res => {
    const m = modal(`<h2>${esc(title)}</h2>${fields.map(f => `<label class="fld"><span>${esc(f.label)}</span><input type="text" maxlength="200" data-k="${f.key}" value="${esc(f.value || '')}"></label>`).join('')}<div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Save</button></div>`);
    const ins = [...m.querySelectorAll('input')]; ins[0].focus(); ins[0].select();
    const done = ok => { const v = ok ? Object.fromEntries(ins.map(i => [i.dataset.k, i.value.trim()])) : null; m.remove(); res(v); };
    m.querySelector('[data-x]').onclick = () => done(false);
    m.querySelector('[data-ok]').onclick = () => done(true);
    /* Enter saves only from a text field: on Cancel (or any other button) it presses that button, as a click would.
       preventDefault: otherwise the same key press goes on to "click" the button focus returns to (Edit), which
       opens the dialog again. */
    m.onkeydown = e => { if(e.key === 'Enter' && e.target.matches('input[type=text]')){ e.preventDefault(); done(true); } if(e.key === 'Escape') done(false); };
  });
}
/* A checklist of songs: resolves to the ticked ids. The title and the button can be changed ({title, button}); the defaults are the setlist's "Add songs". */
export function pick(songs, {title = 'Add songs', button = 'Add', needOne = false} = {}){
  return new Promise(res => {
    const m = modal(`<h2>${esc(title)}</h2><div class="pick">${songs.map(s => `<label><input type="checkbox" value="${esc(s.id)}">${esc(s.title)}</label>`).join('') || '<p>Your library is empty. Add PDFs first.</p>'}</div><div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>${esc(button)}</button></div>`);
    const ok = m.querySelector('[data-ok]');
    if(needOne){ ok.disabled = true; m.addEventListener('change', () => { ok.disabled = !m.querySelector('input:checked'); }); }     // the button waits for a tick
    m.querySelector('[data-x]').onclick = () => { m.remove(); res([]); };
    m.querySelector('[data-ok]').onclick = () => { const ids = [...m.querySelectorAll('input:checked')].map(c => c.value); m.remove(); res(ids); };
  });
}
/* two-tap confirm instead of confirm() */
export function armed(btn, msg = 'Tap again'){
  if(btn.dataset.armed) return true;
  const t = btn.textContent; btn.dataset.armed = 1; btn.textContent = msg;
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = t; }, 3000);
  return false;
}

export const fileName = s => s.replace(/[\\/:*?"<>|]+/g, '').trim() || 'setlist';

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

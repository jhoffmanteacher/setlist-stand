/* Small helpers shared by every module. */
export const $ = s => document.querySelector(s);
export const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* Modules call hooks.render() to redraw the home screen; main.js fills it in. */
export const hooks = {render(){}};

let toastT;
export function toast(m){
  const t = $('#toast'); t.textContent = m; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2200);
}

export function modal(html){
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="box">${html}</div>`; document.body.append(m); return m;
}
export function ask(title, val = ''){
  return new Promise(res => {
    const m = modal(`<h2>${esc(title)}</h2><input type="text" value="${esc(val)}"><div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Save</button></div>`);
    const i = m.querySelector('input'); i.focus(); i.select();
    const done = v => { m.remove(); res(v); };
    m.querySelector('[data-x]').onclick = () => done(null);
    m.querySelector('[data-ok]').onclick = () => done(i.value.trim() || null);
    i.onkeydown = e => { if(e.key === 'Enter') done(i.value.trim() || null); if(e.key === 'Escape') done(null); };
  });
}
/* A dialog with several text fields. fields: [{key, label, value}]. Resolves to {key: value} or null. */
export function form(title, fields){
  return new Promise(res => {
    const m = modal(`<h2>${esc(title)}</h2>${fields.map(f => `<label class="fld"><span>${esc(f.label)}</span><input type="text" data-k="${f.key}" value="${esc(f.value || '')}"></label>`).join('')}<div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Save</button></div>`);
    const ins = [...m.querySelectorAll('input')]; ins[0].focus(); ins[0].select();
    const done = ok => { const v = ok ? Object.fromEntries(ins.map(i => [i.dataset.k, i.value.trim()])) : null; m.remove(); res(v); };
    m.querySelector('[data-x]').onclick = () => done(false);
    m.querySelector('[data-ok]').onclick = () => done(true);
    m.onkeydown = e => { if(e.key === 'Enter') done(true); if(e.key === 'Escape') done(false); };
  });
}
export function pick(songs){
  return new Promise(res => {
    const m = modal(`<h2>Add songs</h2><div class="pick">${songs.map(s => `<label><input type="checkbox" value="${s.id}">${esc(s.title)}</label>`).join('') || '<p>Your library is empty. Add PDFs first.</p>'}</div><div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Add</button></div>`);
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

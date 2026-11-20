import {esc, toast, modal} from './util.js';

/* Plain words for what went wrong, and a small private problem log.
   The log lives only in this browser (localStorage `ss-problems`, the last 30 entries). Nothing is ever sent anywhere. */

const isQuota = err => !!err && (err.name === 'QuotaExceededError' || err.code === 22 || /quota/i.test(String(err.message || '')));

/* One plain sentence for an error. `fallback` replaces the generic sentence when the caller knows better. */
export function explainError(err, fallback = 'Something went wrong. Nothing was lost.'){
  if(isQuota(err)) return 'The tablet is full. Free up some space, then try again. Nothing was changed.';
  return fallback;
}

const KEY = 'ss-problems', MAX = 30;
export function getProblems(){
  try{ const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; }catch(e){ return []; }
}
export function clearProblems(){
  try{ localStorage.removeItem(KEY); }catch(e){}
  dispatchEvent(new Event('ss-problems'));
}

let lastToast = 0;
export function logProblem(kind, message){
  const msg = String(message == null ? '' : message).slice(0, 300);
  if(/ResizeObserver loop/i.test(msg)) return;               // harmless browser noise
  try{
    const list = getProblems();
    list.push({t:Date.now(), kind:String(kind), msg});
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  }catch(e){}
  if(Date.now() - lastToast > 10000){
    lastToast = Date.now();
    try{ toast('Something went wrong. Your music is safe. Details: Library → Problem log.'); }catch(e){}
  }
  try{ dispatchEvent(new Event('ss-problems')); }catch(e){}
}

const describe = r => r && typeof r === 'object' ? (r.name && r.message ? r.name + ': ' + r.message : r.message || String(r)) : String(r);

let installed = false;
export function initErrors(){
  if(installed) return; installed = true;
  addEventListener('error', e => {
    const where = e.filename ? ` (${String(e.filename).split('/').pop()}:${e.lineno || 0})` : '';
    logProblem('error', (e.message || describe(e.error)) + where);
  });
  addEventListener('unhandledrejection', e => logProblem('promise', describe(e.reason)));
  addEventListener('securitypolicyviolation', e => logProblem('blocked', `${e.violatedDirective || ''} ${e.blockedURI || ''}`.trim()));
}

const line = p => `${new Date(p.t).toLocaleString()}  ${p.kind}: ${p.msg}`;

/* The Problem log dialog: the entries as plain text, Copy, Clear and Close. */
export function showProblemLog(){
  const text = getProblems().map(line).join('\n');
  const m = modal(`<h2>Problem log</h2><p class="hint">Kept only on this tablet. Copy it if you want to tell someone about a problem.</p>
    <textarea class="plog" readonly rows="10" aria-label="Problem log">${esc(text)}</textarea>
    <div class="btns"><button data-plcopy>Copy</button><button data-plclear>Clear</button><button class="pri" data-plclose data-x>Close</button></div>`);
  const ta = m.querySelector('textarea');
  const close = () => { m.remove(); removeEventListener('keydown', onKey); };
  const onKey = e => { if(e.key === 'Escape') close(); };
  addEventListener('keydown', onKey);
  m.querySelector('[data-plclose]').onclick = close;
  m.querySelector('[data-plclear]').onclick = () => { clearProblems(); ta.value = ''; close(); };
  m.querySelector('[data-plcopy]').onclick = async () => {
    try{
      if(navigator.clipboard && navigator.clipboard.writeText){ await navigator.clipboard.writeText(ta.value); toast('Copied'); return; }
    }catch(e){}
    ta.focus(); ta.select(); toast('Selected. Use Copy from the menu.');
  };
  m.querySelector('[data-plclose]').focus();
}

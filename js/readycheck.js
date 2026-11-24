/* "Ready for the gig" (2026-11-23): the ready check of a setlist, and the "Works offline" line.

   readyCheck(setOrId): a modal() that opens every distinct chart of the setlist from this tablet's own storage (the `files`
   store and pdf.js; no network), ONE at a time, each pdf.js document destroyed before the next (no worker left behind), and
   lists each chart as "N pages. OK", "Missing" (no PDF stored for it) or "Will not open". The last line says "All N charts
   are ready." or names the charts with a problem in plain words. Stop ends it after the chart being read (that one is
   dropped at once). It writes nothing, anywhere. Resolves to {ok, missing, bad, stopped} (titles) when the box closes.

   readyLine(): the plain line for the Library: "Works offline." / "Offline copy incomplete: ..." / '' while unknown. The
   state comes from js/boot.js (window.ssBoot.offline(), the service worker's answer to its refill request 'ss-heal'), which
   fires 'ss-offline-state' on window when it changes. readyLineHtml() is the element to put on a screen; it is kept up to
   date in place, so the screen needs no redraw. Unknown (no service worker yet, the app opened without internet, or
   js/boot.js failed) shows nothing: the line never nags. */
import {esc, modal} from './util.js';
import {get, state, songById, liveItems} from './store.js';

const LIMIT = 30000;            // one chart that takes longer than this to open counts as one that will not open

/* ---------- the offline line ---------- */
export function offlineState(){
  try{ const b = window.ssBoot; return b && typeof b.offline === 'function' ? b.offline() : null; }catch(e){ return null; }
}
export function readyLine(){
  const s = offlineState();
  return s === 'ok' ? 'Works offline.'
    : s === 'incomplete' ? 'Offline copy incomplete: keep the app open with internet for a minute.'
    : '';
}
const lineClass = () => 'hint readyline' + (offlineState() === 'incomplete' ? ' warnline' : '');
export function readyLineHtml(){
  const t = readyLine();
  return `<p class="${lineClass()}" data-readyline aria-live="polite"${t ? '' : ' hidden'}>${esc(t)}</p>`;
}
function refreshLine(){
  for(const el of document.querySelectorAll('[data-readyline]')){
    const t = readyLine();
    if(el.textContent !== t) el.textContent = t;
    el.hidden = !t; el.className = lineClass();
  }
}
addEventListener('ss-offline-state', refreshLine);

/* ---------- the ready check ---------- */
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
/* Settles with the promise, or rejects after `ms` (a chart that hangs pdf.js must not hang the check) or as soon as Stop is
   pressed (pdf.js does not always settle a loading task that is destroyed half-way). */
function within(p, ms, job){
  let t;
  return Promise.race([p, job.stop, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('too slow')), ms); })]).finally(() => clearTimeout(t));
}

/* One chart: 'missing' (no stored PDF), 'bad' (stored but pdf.js cannot open it or one of its pages) or 'ok' with its page count.
   job.task is the pdf.js loading task while it runs, so Stop can drop it at once. */
async function checkChart(id, job){
  let blob;
  try{ blob = await get('files', id); }catch(e){ return {state:'bad'}; }
  if(!blob) return {state:'missing'};
  let buf;
  try{ buf = await blob.arrayBuffer(); }catch(e){ return {state:'bad'}; }
  if(job.stopped) return {state:'stopped'};
  const task = pdfjsLib.getDocument({data:new Uint8Array(buf)});
  job.task = task;
  try{
    const end = Date.now() + LIMIT;
    const doc = await within(task.promise, LIMIT, job);
    for(let p = 1; p <= doc.numPages; p++){
      if(job.stopped) return {state:'stopped'};
      await within(doc.getPage(p), Math.max(1, end - Date.now()), job);
    }
    return doc.numPages > 0 ? {state:'ok', pages:doc.numPages} : {state:'bad'};
  }catch(e){
    return job.stopped ? {state:'stopped'} : {state:'bad'};
  }finally{
    job.task = null;
    /* waited for (one chart's worker at a time), but never for long: a destroy that does not settle must not hang the check */
    await Promise.race([Promise.resolve().then(() => task.destroy()).catch(() => {}), new Promise(r => setTimeout(r, 2000))]);
  }
}

/* The charts of a setlist, each once, in setlist order (a song that is in it twice is checked once). */
function chartsOf(st){
  const seen = new Set(), out = [];
  for(const it of liveItems(st)){
    if(it.type !== 'song' || seen.has(it.id)) continue;
    const s = songById(it.id); if(!s) continue;
    seen.add(it.id); out.push(s);
  }
  return out;
}

function rowHtml(s, r){
  const what = r.state === 'ok' ? `${plural(r.pages, 'page')}. OK` : r.state === 'missing' ? 'Missing: no PDF on this tablet' : 'Will not open';
  return `<li class="row rc-${r.state}" data-rc="${r.state}"><span class="t">${esc(s.title)}</span><span class="s">${esc(what)}</span></li>`;
}
const names = list => list.length <= 5 ? list.join(', ') : list.slice(0, 5).join(', ') + ` and ${list.length - 5} more`;
function summary(total, res, stopped){
  const ok = res.filter(r => r.state === 'ok').length;
  const missing = res.filter(r => r.state === 'missing').map(r => r.title), bad = res.filter(r => r.state === 'bad').map(r => r.title);
  const parts = [];
  if(stopped) parts.push(`Stopped after ${res.length} of ${plural(total, 'chart')}.`);
  if(!missing.length && !bad.length){
    if(!stopped) parts.push(total === 1 ? 'The chart is ready.' : `All ${total} charts are ready.`);
    else if(ok) parts.push(ok === 1 ? 'That one is ready.' : `Those ${ok} are ready.`);
  }else{
    if(missing.length) parts.push(`No PDF on this tablet for ${names(missing)}.`);
    if(bad.length) parts.push(`${bad.length === 1 ? 'This chart' : 'These charts'} will not open: ${names(bad)}.`);
    parts.push('Give each one its PDF again with New version (the song’s ⋯ menu in the Library), or restore a backup.');
  }
  return parts.join(' ');
}

export function readyCheck(setOrId){
  const id = typeof setOrId === 'string' ? setOrId : setOrId && setOrId.id;
  const st = state.sets.find(x => x.id === id) || (typeof setOrId === 'object' ? setOrId : null);
  return new Promise(resolve => {
    const charts = st ? chartsOf(st) : [];
    const m = modal(`<h2>Ready check</h2><p class="hint rcname">${esc(st ? st.name : '')}</p>
      <p class="hint" role="status" data-rcstatus></p><ul class="list rclist" data-rclist></ul>
      <div class="btns"><button data-x>Stop</button></div>`);
    const line = m.querySelector('[data-rcstatus]'), list = m.querySelector('[data-rclist]'), x = m.querySelector('[data-x]');
    let stopNow;
    const job = {stopped:false, task:null, done:false, stop:new Promise((_, rej) => { stopNow = rej; })};
    job.stop.catch(() => {});
    const res = [];
    const say = t => { if(line.textContent !== t) line.textContent = t; };
    const finish = () => {
      job.done = true;
      x.textContent = 'Close';
      x.onclick = () => { m.remove(); resolve(result()); };
    };
    const result = () => ({ok:res.filter(r => r.state === 'ok').map(r => r.title), missing:res.filter(r => r.state === 'missing').map(r => r.title),
      bad:res.filter(r => r.state === 'bad').map(r => r.title), stopped:job.stopped});
    x.onclick = () => {
      if(job.done) return;
      job.stopped = true; say('Stopping…'); stopNow(new Error('stopped'));
      if(job.task) Promise.resolve().then(() => job.task && job.task.destroy()).catch(() => {});      // the chart being read is dropped at once
    };
    if(!charts.length){ say('This setlist has no songs.'); finish(); return; }
    if(!window.pdfjsLib){ say('The PDF reader did not load. Reload the page, then check again.'); finish(); return; }
    (async () => {
      for(let i = 0; i < charts.length && !job.stopped; i++){
        const s = charts[i];
        say(`Checking ${i + 1} of ${plural(charts.length, 'chart')}: ${s.title}`);
        const r = await checkChart(s.id, job);
        if(r.state === 'stopped') break;
        res.push({...r, title:s.title});
        if(m.isConnected) list.insertAdjacentHTML('beforeend', rowHtml(s, r));
      }
      say(summary(charts.length, res, job.stopped));
      finish();
    })();
  });
}

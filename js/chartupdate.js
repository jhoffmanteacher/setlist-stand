/* Import chart updates (Share / Import menu): one file of cleaned-up charts (js/chartfile.js reads and checks it), each applied as
   the NEW VERSION of its song, the way the New version button does it (the records are built by newVersionOps() in js/newversion.js,
   which both use). The person sees a list first (every update ticked, a chart that matches no song offered as a new song, unticked)
   and can untick any. Then ONE putAll() writes the whole batch: every ticked update and every ticked new song, or nothing.
   Nothing outside the batch is touched: no setlist is written (a song keeps its id), no other song, mark, collection or PDF. */
import {esc, toast, modal, busy, hooks} from './util.js';
import {get, putAll, load, newSong, songById} from './store.js';
import {explainError} from './errors.js';
import {joinColls} from './collections.js';
import {unique, importRunning, limits} from './shareimport.js';
import {newVersionRunning} from './library.js';
import {newVersionOps, allIds} from './newversion.js';
import {readChartFile, matchCharts} from './chartfile.js';

const plural = (n, w) => `${n} ${w}${n == 1 ? '' : 's'}`;
let running = false;

function notice(title, lines){
  const m = modal(`<h2>${esc(title)}</h2>${lines.map(l => l.startsWith('<ul') ? l : `<p>${l}</p>`).join('')}<div class="btns"><button class="pri" data-x>OK</button></div>`);
  m.querySelector('[data-x]').onclick = () => m.remove();
}
const list = items => '<ul class="duplist">' + items.slice(0, 8).map(t => `<li>${t}</li>`).join('') + (items.length > 8 ? `<li>and ${items.length - 8} more</li>` : '') + '</ul>';

/* One import at a time, from the pick until the result is on the screen. */
export async function importChartUpdates(file){
  if(!file) return;
  if(running || importRunning() || newVersionRunning()){ toast('An import is still running. Try again when it has finished.'); return; }
  running = true;
  try{ await run(file); } finally { running = false; }
}

async function run(file){
  const job = busy('Chart updates', 'Reading the file…');           // opened before the first await: Escape and Stop reach it
  let read, rows;
  try{
    read = await readChartFile(file, {say:job.say, stopped:() => job.stopped});
    if(read.error === 'stopped' || (job.stopped && !read.error)){ toast('Stopped. Nothing was changed.'); return; }
    if(read.error){ job.close(); notice("Can't import that file", [esc(read.error)]); return; }
    rows = await matchCharts(read.charts);
    /* a song with no stored PDF takes the new chart with nothing to keep (as New version does): the list says so before Apply */
    for(const r of rows) if(r.kind === 'update') r.noFile = !(await get('files', r.song.id));
    if(job.stopped){ toast('Stopped. Nothing was changed.'); return; }
  }catch(err){ job.close(); notice("Can't import that file", [esc(explainError(err, 'That file could not be read. Nothing was changed.'))]); return; }
  finally { job.close(); }
  if(!rows.some(r => r.kind === 'update' || r.kind === 'new')){
    const cur = rows.filter(r => r.kind === 'current').length;
    notice('Chart updates', [cur ? `${cur == rows.length ? 'Every chart in this file' : plural(cur, 'chart')} is already up to date.` : 'Nothing in this file can be applied.', 'Nothing was changed.']);
    return;
  }
  const ticked = await review(rows);
  if(!ticked) return;
  await apply(rows, ticked);
}

const noteOf = r => r.kind === 'twice' ? (r.song ? 'Same song twice in this file: only the first one is used' : 'Same PDF twice in this file: only the first one is used')
  : r.kind === 'current' ? 'Already up to date' : r.kind === 'new' ? 'Not in your library' : r.by === 'name' ? 'Matched by name' : '';

/* The list. Resolves to the set of row numbers ticked, or null for Cancel. */
function review(rows){
  return new Promise(res => {
    const html = rows.map((r, i) => {
      const title = r.song ? r.song.title : r.chart.label;
      const notes = [r.many && r.kind === 'new' ? `${r.many} songs in your library have this name` : noteOf(r), r.other ? `In the file: ${r.chart.label}` : '', r.noFile ? 'Its current chart is not on this tablet: its marks are cleared and nothing goes to Archived' : '',
        r.also && r.kind !== 'current' ? `This PDF is also in your library as ${r.also}` : ''].filter(Boolean);
      const body = `<span class="pt">${r.kind === 'new' ? 'Add as a new song: ' : ''}${esc(title)}</span>${notes.map(n => `<span class="cu-n">${esc(n)}</span>`).join('')}`;
      return r.kind === 'update' || r.kind === 'new'
        ? `<label class="cu-row"><input type="checkbox" data-i="${i}" ${r.kind === 'update' ? 'checked' : ''}><span class="cu-b">${body}</span></label>`
        : `<div class="cu-row cu-off"><span class="cu-b">${body}</span></div>`;
    }).join('');
    const m = modal(`<h2>Chart updates</h2><p class="hint">${plural(rows.length, 'chart')} in this file. Untick any you do not want.</p>
      <div class="pick cu-list">${html}</div>
      <p class="hint">Each song keeps its place in your setlists. The old chart and its marks go to Archived.</p>
      <div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Apply</button></div>`);
    m.classList.add('chartupdate');
    const ok = m.querySelector('[data-ok]'), boxes = [...m.querySelectorAll('input[data-i]')];
    const chosen = () => new Set(boxes.filter(b => b.checked).map(b => +b.dataset.i));
    const sync = () => { const n = chosen().size; ok.textContent = `Apply ${n}`; ok.disabled = !n; };
    sync();
    m.addEventListener('change', sync);
    m.querySelector('[data-x]').onclick = () => { m.remove(); res(null); };
    ok.onclick = () => { const c = chosen(); m.remove(); res(c); };
  });
}

/* Builds every ticked chart's ops, re-checks each song, then writes ALL in one putAll. */
async function apply(rows, ticked){
  const job = busy('Chart updates', 'Getting ready…');
  const skipped = [];                                        // [title, why]
  const groups = [];                                         // {row, ops, song}
  let wrote = false, saved = false;
  try{
    const taken = allIds(), colls = joinColls(), todo = rows.map((r, i) => [r, i]).filter(([r, i]) => ticked.has(i));
    let n = 0, oldBytes = 0;
    for(const [r] of todo){
      if(job.stopped){ job.close(); toast('Stopped. Nothing was changed.'); return; }
      job.say(`Getting chart ${++n} of ${todo.length} ready…`);
      if(r.kind === 'new'){
        const s = newSong(r.chart.name, r.chart.pages, r.chart.hash, colls);
        s.id = unique(taken);
        groups.push({row:r, song:null, ops:[{store:'files', key:s.id, value:new Blob([r.chart.bytes], {type:'application/pdf'})}, {store:'songs', key:s.id, value:s}]});
        r.chart.bytes = null;                                // the Blob has its own copy: do not hold every PDF twice
        continue;
      }
      const s = r.song;
      if(songById(s.id) !== s){ skipped.push([s.title, 'changed while you were looking']); continue; }
      let old = null;
      try{
        const f = await get('files', s.id);
        /* the old charts are held too until the write: together they may be no bigger than the file's own cap */
        if(f && (oldBytes += f.size) > limits.maxPdfBytes){ job.close(); notice('Chart updates', ['Too much to apply at once. Untick some songs and try again.', 'Nothing was changed.']); return; }
        if(f) old = await f.arrayBuffer();
      }
      catch(err){ skipped.push([s.title, 'its current chart could not be read']); continue; }      // never written over: it may still be there
      const {ops} = await newVersionOps(s, r.chart.bytes, {pages:r.chart.pages, hash:r.chart.hash}, old, taken, {check:true});
      groups.push({row:r, song:s, ops});
      r.chart.bytes = null;
    }
    /* The records again as stored, with no wait before the write: another tab's edit or delete never reaches this tab's list. */
    const keep = [];
    for(const g of groups){
      if(g.song){
        const cur = await get('songs', g.song.id);
        if(songById(g.song.id) !== g.song || !cur || cur.deleted || cur.updated !== g.song.updated || cur.hash !== g.song.hash){ skipped.push([g.song.title, 'changed while you were looking']); continue; }
      }
      keep.push(g);
    }
    if(job.stopped){ job.close(); toast('Stopped. Nothing was changed.'); return; }
    if(!keep.length){ job.close(); notice('Chart updates', ['Nothing was applied. Nothing was changed.', ...(skipped.length ? [`Skipped ${skipped.length}:`, list(skipped.map(([t, w]) => `${esc(t)} (${w})`))] : [])]); return; }
    job.lock('Saving to this tablet…');
    wrote = true;
    await putAll(keep.flatMap(g => g.ops));
    saved = true;
    await load().catch(() => {}); hooks.render();
    job.close();
    const upd = keep.filter(g => g.song).length, add = keep.length - upd;
    const left = rows.filter((r, i) => !ticked.has(i) && r.kind === 'new').map(r => [r.chart.label, 'not added']);
    const twice = rows.filter(r => r.kind === 'twice').map(r => [r.song ? r.song.title : r.chart.label, 'same song twice in this file']);
    const all = [...skipped, ...left, ...twice];
    const unticked = rows.filter((r, i) => !ticked.has(i) && r.kind === 'update').length, cur = rows.filter(r => r.kind === 'current').length;
    const head = [upd ? `Updated ${plural(upd, 'song')}.` : '', add ? `Added ${plural(add, 'new song')}.` : ''].filter(Boolean).join(' ');
    notice('Chart updates', [head || 'Nothing was applied.', ...(all.length ? [`Skipped ${all.length}:`, list(all.map(([t, w]) => `${esc(t)} (${w})`))] : []),
      ...[cur ? `${plural(cur, 'song')} already up to date.` : '', unticked ? `${plural(unticked, 'song')} left unticked.` : ''].filter(Boolean).map(esc)]);
  }catch(err){
    job.close();
    if(saved){ notice('Chart updates', ['The charts were saved, but the screen did not update. Reload the app to see them.']); return; }
    if(wrote){ await load().catch(() => {}); hooks.render(); }       // the write failed: nothing was written, but redraw from what is stored
    notice('Nothing was changed', [esc(explainError(err, err && err.name === 'StaleWrite' ? 'A song changed while saving. Nothing was changed.' : 'Something went wrong while saving. Nothing was changed.'))]);
  }
}

import {esc, modal, busy, toast, fileName, saveBlob, canShareFile, shareBlob} from './util.js';
import {get, liveItems, songById} from './store.js';
import {explainError} from './errors.js';
import {gigOf, gigLong} from './gigdate.js';
import {setBaseName} from './print.js';

/* Download all: one zip with every chart of the setlists the Setlists list shows, each chart ONCE (Songs/<title>.pdf, the stored
   bytes exactly as they are, so a chart used in twelve setlists is in the zip once), and one small list file per setlist
   (Setlists/<name>.txt: its name, gig date, and its songs and breaks in order) (Jonathan, 2026-11-22; this replaced "one PDF per
   setlist", which copied every chart into every setlist and grew with the number of setlists). It is a way to keep the charts and
   the lists outside the app. It carries no marks (they live apart from the PDF); to print a setlist with its marks use Download PDF
   on the open setlist (js/print.js), which builds one PDF of its charts in order. Setlists with no songs are skipped. Nothing is
   written to the library and no PDF is changed. Stop, at any point, downloads nothing. */

/* The most the zip may hold. The zip is held in memory whole, about three times over while it is made (the PDFs, the zip's own copy,
   then the file; JSZip peak measured at 3.0x), so 150 MB is about 450 MB on a tablet that may have 2 or 3 GB. Checked before any
   work, from the stored size of every distinct chart. An object so a test can lower it. */
export const limits = {maxBytes: 150e6};

const songIdsOf = st => liveItems(st).filter(it => it.type === 'song').map(it => it.id);
const titleOf = id => (songById(id) || {}).title || 'A song';
const TOO_MUCH = ['Too much to make at once', 'That is too much to make at once on a tablet. Show one collection first.'];

/* Names that are all different (case ignored): " (2)", " (3)" on a clash, before the extension. */
export function uniqueNames(bases, ext){
  const used = new Set();
  return bases.map(base => {
    let n = base, k = 1;
    while(used.has(n.toLowerCase())) n = `${base} (${++k})`;
    used.add(n.toLowerCase());
    return n + ext;
  });
}
/* A message that stays until OK. */
function notice(title, text){
  return new Promise(res => {
    const m = modal(`<h2>${esc(title)}</h2><p class="hint">${esc(text)}</p><div class="btns"><button class="pri" data-x>OK</button></div>`);
    m.querySelector('[data-x]').onclick = () => { m.remove(); res(); };
  });
}

/* The list file of one setlist: its name, its date in words, then the songs numbered and the breaks as they come. A song whose PDF
   is not on this tablet is listed and says so. */
export function listText(st, fileOf){
  const lines = [st.name], g = gigOf(st);
  if(g) lines.push(gigLong(g));
  lines.push('');
  let k = 0;
  for(const it of liveItems(st)){
    if(it.type === 'break') lines.push(`--- ${it.name} ---`);
    else lines.push(`${++k}. ${titleOf(it.id)}${fileOf.has(it.id) ? '' : ' (no PDF on this tablet)'}`);
  }
  return lines.join('\n') + '\n';
}

export function downloadAll(sets, coll){
  const list = sets.filter(st => songIdsOf(st).length), skipped = sets.length - list.length;
  if(!list.length){ toast('No setlists with songs to download'); return; }
  const m = modal(`<h2>Download all setlists</h2><p class="hint">Makes one zip file with each chart once, and a list of songs for each of your ${list.length} setlist${list.length == 1 ? '' : 's'}.${skipped ? ` ${skipped} setlist${skipped == 1 ? ' has' : 's have'} no songs and ${skipped == 1 ? 'is' : 'are'} skipped.` : ''} Charts are saved as they are, without your marks. To print a setlist with your marks, open it and tap Download PDF.</p>
    <div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Make zip</button></div>`);
  m.querySelector('[data-x]').onclick = () => m.remove();
  m.querySelector('[data-ok]').onclick = () => { m.remove(); run(list, coll); };
}

async function run(list, coll){
  const job = busy('Downloading setlists', 'Getting ready…');            // before the first await: Escape and Stop reach this box
  const stopped = () => { job.close(); toast('Stopped. Nothing was downloaded.'); };
  try{
    const ids = [...new Set(list.flatMap(songIdsOf))];
    let size = 0; const have = [];
    for(const id of ids){ const b = await get('files', id); if(b){ size += b.size; have.push(id); } }
    if(size > limits.maxBytes){ job.close(); await notice(...TOO_MUCH); return; }
    if(job.stopped) return stopped();
    const zip = new JSZip(), fileOf = new Map();
    uniqueNames(have.map(id => fileName(titleOf(id))), '.pdf').forEach((n, i) => fileOf.set(have[i], 'Songs/' + n));
    for(const [i, id] of have.entries()){
      if(job.stopped) return stopped();
      job.say(`Adding chart ${i + 1} of ${have.length}: ${titleOf(id)}…`);
      const b = await get('files', id);
      if(!b){ fileOf.delete(id); continue; }                              // deleted while this runs: listed as having no PDF
      zip.file(fileOf.get(id), await b.arrayBuffer());                    // the bytes as they are; nothing is stored again
    }
    uniqueNames(list.map(setBaseName), '.txt').forEach((n, i) => zip.file('Setlists/' + n, listText(list[i], fileOf)));
    const left = [];
    for(const st of list) for(const id of new Set(songIdsOf(st))) if(!fileOf.has(id)) left.push({set:st.name, title:titleOf(id)});
    if(job.stopped) return stopped();                                      // Stop on the last chart: do not build a zip that is then thrown away
    job.say('Making the zip file…');
    const blob = await zip.generateAsync({type:'blob', compression:'STORE'}, m => { if(!job.stopped) job.say(`Making the zip file… ${Math.round(m.percent)}%`); });
    if(job.stopped) return stopped();                                      // pressed during the last step, which cannot be interrupted: the file is thrown away
    job.close();
    const name = fileName(coll ? `Setlists - ${coll.name} - ChartShark` : 'Setlists - ChartShark') + '.zip';
    saveBlob(blob, name);
    finish(blob, name, fileOf.size, list.length, left);
  }catch(err){ job.close(); toast(explainError(err, 'Could not make the zip. Nothing was downloaded.')); }
}

/* After the save: a box that stays until OK when a chart is missing or the browser can share the file, else a toast. */
function finish(blob, name, charts, lists, left){
  const share = canShareFile(blob, name);
  if(!left.length && !share){ toast(`Saved ${charts} chart${charts == 1 ? '' : 's'} and ${lists} setlist${lists == 1 ? '' : 's'}`); return; }
  const m = modal(`<h2>Zip saved</h2><p class="hint">${esc(charts)} chart${charts == 1 ? '' : 's'} and ${esc(lists)} setlist${lists == 1 ? '' : 's'} in ${esc(name)}, in your downloads.</p>
    ${left.length ? `<p class="hint">Not in the zip:</p><ul class="locked left">${left.map(x => `<li>${esc(x.set)}: ${esc(x.title)} has no PDF on this tablet</li>`).join('')}</ul>` : ''}
    <div class="btns">${share ? '<button data-share>Share…</button>' : ''}<button class="pri" data-x>Done</button></div>`);
  m.querySelector('[data-x]').onclick = () => m.remove();
  if(share) m.querySelector('[data-share]').onclick = () => shareBlob(blob, name);
}

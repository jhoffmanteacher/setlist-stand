import {esc, modal, busy, toast, fileName, saveBlob, canShareFile, shareBlob} from './util.js';
import {get, liveItems, songById} from './store.js';
import {explainError} from './errors.js';
import {buildSetPdf, setFileName} from './print.js';

/* Download all: one PDF for each setlist the Setlists list shows, in one zip file (Jonathan, 2026-11-21).
   Every PDF comes from buildSetPdf() in js/print.js, the same call Download PDF makes, so a setlist's PDF here equals the one it
   downloads alone (pages, marks, notes, crops). Protected charts go in as pictures without asking; a chart that cannot be read
   at all is left out and named at the end. Setlists with no songs are skipped. One setlist is built at a time and the zip is
   stored without compression (PDFs barely shrink). Nothing is written to the library. Stop, at any point, downloads nothing. */

/* The most the zip may hold, estimated from the stored size of every song in every setlist (a song used in two setlists counts twice,
   because each setlist's PDF holds its own copy). A tablet's memory holds the zip whole, so above this it is refused before any work.
   An object so a test can lower it. */
export const limits = {maxBytes: 400e6};

const songIds = st => liveItems(st).filter(it => it.type === 'song').map(it => it.id);
const WHY = {password:'needs a password', broken:'could not be read'};

async function estimate(list){
  let n = 0;
  for(const st of list) for(const id of songIds(st)){ const b = await get('files', id); if(b) n += b.size; }
  return n;
}
/* The file names inside the zip: as a single download names them, and " (2)", " (3)" when two would be the same (case ignored). */
export function zipNames(list){
  const used = new Set();
  return list.map(st => {
    const base = setFileName(st).replace(/\.pdf$/, '');
    let n = base, k = 1;
    while(used.has(n.toLowerCase())) n = `${base} (${++k})`;
    used.add(n.toLowerCase());
    return n + '.pdf';
  });
}
/* A message that stays until OK. */
function notice(title, text){
  return new Promise(res => {
    const m = modal(`<h2>${esc(title)}</h2><p class="hint">${esc(text)}</p><div class="btns"><button class="pri" data-x>OK</button></div>`);
    m.querySelector('[data-x]').onclick = () => { m.remove(); res(); };
  });
}

export function downloadAll(sets, coll){
  const list = sets.filter(st => songIds(st).length), skipped = sets.length - list.length;
  if(!list.length){ toast('No setlists with songs to download'); return; }
  const m = modal(`<h2>Download all setlists</h2><p class="hint">Makes one PDF for each of your ${list.length} setlist${list.length == 1 ? '' : 's'}, in one zip file. Protected charts are included as pictures.${skipped ? ` ${skipped} setlist${skipped == 1 ? ' has' : 's have'} no songs and ${skipped == 1 ? 'is' : 'are'} skipped.` : ''}</p>
    <label class="opt"><input type="checkbox" id="dInk" checked>Include my annotations</label>
    <div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Make zip</button></div>`);
  m.querySelector('[data-x]').onclick = () => m.remove();
  m.querySelector('[data-ok]').onclick = () => { const withInk = m.querySelector('#dInk').checked; m.remove(); run(list, coll, withInk); };
}

async function run(list, coll, withInk){
  const job = busy('Downloading setlists', 'Getting ready…');            // before the first await: Escape and Stop reach this box
  const stopped = () => { job.close(); toast('Stopped. Nothing was downloaded.'); };
  try{
    if(await estimate(list) > limits.maxBytes){
      job.close();
      await notice('Too much to make at once', 'That is too much to make at once on a tablet. Download setlists one at a time, or show one collection first.');
      return;
    }
    const zip = new JSZip(), names = zipNames(list), left = [];
    let made = 0;
    for(const [i, st] of list.entries()){
      if(job.stopped) return stopped();
      job.say(`Making setlist ${i + 1} of ${list.length}: ${st.name}…`);
      const r = await buildSetPdf(songIds(st), withInk, {pictures:true, cancelled:() => job.stopped});
      if(r.cancelled || job.stopped) return stopped();
      for(const x of r.left) left.push({set:st.name, title:(songById(x.id) || {}).title || 'A song', why:WHY[x.why] || WHY.broken});
      if(r.bytes){ zip.file(names[i], r.bytes, {binary:true}); made++; }
    }
    if(!made){ job.close(); await notice('Nothing to download', 'None of the setlists could be made into a PDF.'); return; }
    job.say('Making the zip file…');
    const blob = await zip.generateAsync({type:'blob', compression:'STORE'}, m => job.say(`Making the zip file… ${Math.round(m.percent)}%`));
    if(job.stopped) return stopped();                                      // pressed during the last step, which cannot be interrupted: the file is thrown away
    job.close();
    const name = fileName(coll ? `Setlists - ${coll.name} - Setlist Stand` : 'Setlists - Setlist Stand') + '.zip';
    saveBlob(blob, name);
    finish(blob, name, made, left);
  }catch(err){ job.close(); toast(explainError(err, 'Could not make the zip. Nothing was downloaded.')); }
}

/* After the save: a box that stays until OK when a chart was left out or the browser can share the file, else a toast. */
function finish(blob, name, made, left){
  const share = canShareFile(blob, name);
  if(!left.length && !share){ toast(`Saved ${made} setlist PDF${made == 1 ? '' : 's'}`); return; }
  const m = modal(`<h2>Zip saved</h2><p class="hint">${esc(made)} setlist PDF${made == 1 ? '' : 's'} in ${esc(name)}, in your downloads.</p>
    ${left.length ? `<p class="hint">Left out:</p><ul class="locked left">${left.map(x => `<li>${esc(x.set)}: ${esc(x.title)} ${esc(x.why)}</li>`).join('')}</ul>` : ''}
    <div class="btns">${share ? '<button data-share>Share…</button>' : ''}<button class="pri" data-x>Done</button></div>`);
  m.querySelector('[data-x]').onclick = () => m.remove();
  if(share) m.querySelector('[data-share]').onclick = () => shareBlob(blob, name);
}

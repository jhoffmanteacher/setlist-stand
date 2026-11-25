/* The chart update file: one zip of cleaned-up charts, each to become the NEW VERSION of a song already in the library
   (js/chartupdate.js shows the list and applies them). The zip holds update.json and files/<id>.pdf:
     update.json = {app:'setlist-stand', kind:'chart-update', version:1, made, charts:[{id, target, song, artist, version, hash}]}
   id: a name inside the file (c1, c2...); target: the library song id it is meant for (it may name a song this library does not
   have); song / artist / version: short text; hash: the SHA-256 of the PDF, required. Nothing else travels: no marks, crops,
   setlists or collections. tools/make-chart-update.mjs builds it.
   The file is untrusted. It is read with the same checks as a share package (share import's own functions: the file's size and
   zip directory, update.json against its recorded CRC-32, every PDF read in pieces against a cap and its SHA-256 compared, opened in
   pdf.js); any problem refuses the whole file with one plain sentence and changes nothing.
   Matching (matchCharts) is by the target id first, then by name (song, artist and version as compareSongs compares them: case and
   accents ignored), and NEVER by hash; the hash only says "already up to date" and "this PDF is also in your library". */
import {pdfPageCount} from './util.js';
import {state, sha256, ensureHashes} from './store.js';
import {compareSongs, displayName, cutName} from './names.js';
import {ID_RE, LIMITS, okText as okName} from './backup.js';
import {limits, isObj, short, mb, crc32, readCapped, directoryProblem, NOT_PACKAGE, TOO_MANY} from './shareimport.js';

export const CHART_UPDATE_VERSION = 1;
const NOT_UPDATE = 'That file is not a ChartShark chart update file.';

function checkCharts(d){
  if(d.charts.length > limits.maxSongs) return `more than ${limits.maxSongs} charts`;
  const ids = new Set();
  for(const c of d.charts){
    if(!isObj(c)) return 'a chart that is not a record';
    if(typeof c.id !== 'string' || !ID_RE.test(c.id)) return 'a chart id ' + short(c.id);
    if(ids.has(c.id)) return `the chart id ${c.id} twice`;
    ids.add(c.id);
    if(typeof c.target !== 'string' || !ID_RE.test(c.target)) return `chart ${c.id} has a target ${short(c.target)}`;
    if(typeof c.song !== 'string' || !c.song.trim() || c.song.length > LIMITS.text) return `chart ${c.id} has no usable title`;
    for(const k of ['artist', 'version']) if(c[k] != null && !okName(c[k])) return `chart ${c.id} has a ${k} that is not short text`;
    if(!(typeof c.hash === 'string' && /^[0-9a-f]{64}$/i.test(c.hash))) return `chart ${c.id} has no valid hash`;
  }
  return null;
}

/* Reads and checks a chart update file. opts.say(text) reports progress ("Reading chart 3 of 14…"); opts.stopped() is true after Stop.
   Resolves to {error} (a plain sentence; nothing was changed), {error:'stopped'}, or {charts:[{id, target, name, bytes, hash, pages, label}]}
   (name: {song, artist, version}, trimmed; label: the title as shown). */
export async function readChartFile(file, opts = {}){
  const say = opts.say || (() => {}), stopped = opts.stopped || (() => false);
  const bad = msg => ({error:msg + ' Nothing was changed.'});
  const damaged = err => /crc|corrupt/i.test(String(err && err.message));
  if(file.size > limits.maxPdfBytes + limits.maxJson) return bad(`That file is too big: more than ${mb(limits.maxPdfBytes)}.`);
  const dir = await directoryProblem(file);
  if(dir) return bad(dir === NOT_PACKAGE ? NOT_UPDATE : dir === TOO_MANY ? 'That file has too many files in it.' : dir);
  let zip;
  try{ zip = await JSZip.loadAsync(file); }                     // no checkCRC32: see readPackage() in js/shareimport.js (the cap, and the hashes below)
  catch(err){ return bad(damaged(err) ? 'That file is damaged.' : NOT_UPDATE); }
  const entry = zip.file('update.json');
  if(!entry) return bad(zip.file('share.json') ? 'That is a share package, not a chart update file. Use Import a share package.'
    : zip.file('library.json') ? 'That is a backup, not a chart update file. Use Restore from backup.' : NOT_UPDATE);
  try{
    let data;
    try{
      const raw = await readCapped(entry, limits.maxJson);
      if(!raw) return bad('That file is too big to read.');
      const want = entry._data && entry._data.crc32;
      if(typeof want !== 'number' || crc32(raw) !== want >>> 0) return bad('That file is damaged.');
      data = JSON.parse(new TextDecoder().decode(raw));
    }catch(err){ return bad(damaged(err) ? 'That file is damaged.' : NOT_UPDATE); }
    if(!isObj(data) || data.app !== 'setlist-stand' || data.kind !== 'chart-update' || !Array.isArray(data.charts)) return bad(NOT_UPDATE);
    if(!(Number(data.version) >= 1)) return bad(NOT_UPDATE);
    if(Number(data.version) > CHART_UPDATE_VERSION) return bad('That file was made by a newer version of ChartShark. Update the app, then try again.');
    const problem = checkCharts(data);
    if(problem) return bad(`That file has something the app can't read (${problem}).`);
    if(!data.charts.length) return bad('That file is empty.');
    const out = [];
    let room = limits.maxPdfBytes, n = 0;
    for(const c of data.charts){
      if(stopped()) return {error:'stopped'};
      say(`Reading chart ${++n} of ${data.charts.length}…`);
      const name = {song:c.song.trim(), artist:String(c.artist || '').trim(), version:String(c.version || '').trim()}, label = displayName({song:cutName(name.song), artist:cutName(name.artist), version:cutName(name.version)});
      const pdf = zip.file('files/' + c.id + '.pdf');
      if(!pdf) return bad(`That file is missing the PDF for "${label}".`);
      const bytes = await readCapped(pdf, room);
      if(!bytes) return bad(`That file is too big: its PDFs add up to more than ${mb(limits.maxPdfBytes)}.`);
      room -= bytes.length;
      const hash = await sha256(bytes);
      if(hash !== c.hash.toLowerCase()) return bad(`That file is damaged ("${label}" does not match).`);
      let pages;
      try{ pages = await pdfPageCount(bytes); }catch(err){ return bad(`"${label}" in that file is not a PDF this app can open.`); }
      if(!(pages >= 1)) return bad(`"${label}" in that file has no pages.`);
      if(pages > LIMITS.pages) return bad(`"${label}" in that file has ${pages} pages, which is more than the app takes.`);
      out.push({id:c.id, target:c.target, name, bytes, hash, pages, label});
    }
    return {charts:out};
  }catch(err){ return bad(damaged(err) ? 'That file is damaged.' : 'That file could not be read.'); }
}

/* Two names are the same when song, artist and version compare equal the way the library's order compares them. */
const sameName = (a, b) => compareSongs({...a, id:''}, {...b, id:''}) === 0;
const trimName = s => ({song:String(s.song || '').trim(), artist:String(s.artist || '').trim(), version:String(s.version || '').trim()});

/* Decides what each chart would do, from the library as it is now. Resolves to rows, in the file's order:
   {chart, kind, song, by, also}
   kind: 'update' (a live, not archived song takes it; by: 'id' or 'name'), 'current' (that song already has exactly this PDF),
   'new' (no song matches: it can be added as a new song), 'twice' (a second chart for a song, or the same PDF again as a new
   song, that an earlier row already covers: listed, never applied).
   many: how many songs have the chart's name when more than one does (it is then offered as new, never chosen between);
   other: matched by id although the file names it differently (shown, so a wrong chart is seen before Apply).
   also: the title of ANOTHER song that already holds this very PDF (live or archived), or null. Archived songs are never updated:
   an id that names one falls through to the name, which only looks at songs that are not archived. */
export async function matchCharts(charts){
  await ensureHashes().catch(() => {});
  const live = state.songs.filter(s => !s.archived), byId = new Map(live.map(s => [s.id, s]));
  const covered = new Set(), newHashes = new Set(), rows = [];
  for(const chart of charts){
    let song = byId.get(chart.target), by = song ? 'id' : null, many = 0;
    if(!song){
      const same = live.filter(s => sameName(trimName(s), chart.name));
      if(same.length === 1){ song = same[0]; by = 'name'; }
      else if(same.length > 1) many = same.length;          // never chosen between: offered as new, and the list says why
    }
    const other = state.songs.find(s => s.hash === chart.hash && (!song || s.id !== song.id));
    const also = other ? other.title : null;
    if(!song){
      if(newHashes.has(chart.hash)) rows.push({chart, kind:'twice', song:null, by:null, also, many});     // the same PDF twice as new songs: one song
      else { newHashes.add(chart.hash); rows.push({chart, kind:'new', song:null, by:null, also, many}); }
      continue;
    }
    if(covered.has(song.id)){ rows.push({chart, kind:'twice', song, by, also}); continue; }
    covered.add(song.id);
    rows.push({chart, kind:song.hash === chart.hash ? 'current' : 'update', song, by, also, other:by === 'id' && !sameName(trimName(song), chart.name)});
  }
  return rows;
}

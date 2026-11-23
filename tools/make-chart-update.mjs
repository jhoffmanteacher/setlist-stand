/* Builds a chart update file (see js/chartfile.js) from a Setlist Stand backup and a folder of cleaned-up PDFs:
     node tools/make-chart-update.mjs --backup <backup.zip> --out <file.zip> [--add-new] <pdf>...
   Each PDF is matched to ONE song in the backup by its file name ("Song (version) - Artist.pdf", read with js/importname.js and
   compared like the library's order compares names: case and accents ignored). The song's id in the backup becomes the chart's
   `target`. A PDF that matches no song, or more than one, is listed and left out, unless --add-new is given: it then goes in with
   a target that is in no library, and the app offers it as a new song. A second PDF for a song an earlier PDF already took is left
   out. The PDFs go into the zip exactly as they are (never changed). Nothing is written but --out; never run this inside the repo's
   tracked folders (put the output in "Claude outputs/"). */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseFileName} from '../js/importname.js';
import {compareSongs, displayName} from '../js/names.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function requireUmd(f){                         // vendor/*.js are UMD and package.json says "type":"module"
  const module = {exports: {}};
  vm.runInThisContext(`(function(exports, require, module, __filename, __dirname){${fs.readFileSync(f, 'utf8')}\n})`, {filename: f})
    .call(module.exports, module.exports, () => { throw new Error('no require'); }, module, f, path.dirname(f));
  return module.exports;
}
const JSZip = requireUmd(path.join(ROOT, 'vendor', 'jszip.min.js'));

const args = process.argv.slice(2);
let backup = null, out = null, addNew = false;
const pdfs = [];
for(let i = 0; i < args.length; i++){
  const a = args[i];
  if(a === '--backup') backup = args[++i];
  else if(a === '--out') out = args[++i];
  else if(a === '--add-new') addNew = true;
  else if(a.startsWith('--')){ console.error('Unknown option ' + a); process.exit(2); }
  else pdfs.push(a);
}
if(!backup || !out || !pdfs.length){
  console.error('Usage: node tools/make-chart-update.mjs --backup <backup.zip> --out <file.zip> [--add-new] <pdf>...');
  process.exit(2);
}

const zipIn = await JSZip.loadAsync(fs.readFileSync(backup));
const libFile = zipIn.file('library.json');
if(!libFile){ console.error('That is not a Setlist Stand backup (no library.json).'); process.exit(2); }
const lib = JSON.parse(await libFile.async('string'));
if(!lib || lib.app !== 'setlist-stand' || !Array.isArray(lib.songs)){ console.error('That is not a Setlist Stand backup.'); process.exit(2); }
const songs = lib.songs.filter(s => s && !s.deleted && !s.archived && typeof s.id === 'string');   // archived charts are never updated
const trim = s => ({song:String(s.song || '').trim(), artist:String(s.artist || '').trim(), version:String(s.version || '').trim()});
const same = (a, b) => compareSongs({...a, id:''}, {...b, id:''}) === 0;

const zip = new JSZip(), charts = [], taken = new Map();           // taken: song id -> the PDF that took it
let left = 0;
for(const file of pdfs){
  const base = path.basename(file), bytes = fs.readFileSync(file);
  if(bytes.subarray(0, 5).toString('latin1') !== '%PDF-'){ console.log(`LEFT OUT  ${base}: not a PDF`); left++; continue; }
  const name = trim(parseFileName(base));
  if(!name.song){ console.log(`LEFT OUT  ${base}: no song name in the file name`); left++; continue; }
  const hits = songs.filter(s => same(trim(s), name));
  let target = null, why = null;
  if(hits.length === 1){
    if(taken.has(hits[0].id)) why = `a second PDF for "${displayName(trim(hits[0]))}" (${taken.get(hits[0].id)} already took it)`;
    else target = hits[0].id;
  }else why = hits.length ? `${hits.length} songs in the backup have that name` : 'no song in the backup has that name';
  if(why && !addNew){ console.log(`LEFT OUT  ${base}: ${why}`); left++; continue; }
  const id = 'c' + (charts.length + 1);
  if(target) taken.set(target, base);
  charts.push({id, target:target || 'new-' + id, ...name, hash:crypto.createHash('sha256').update(bytes).digest('hex')});
  zip.file('files/' + id + '.pdf', bytes, {createFolders:false});
  console.log(target ? `MATCHED   ${base} -> ${displayName(trim(hits[0]))}` : `NEW SONG  ${base}: ${why}`);
}
if(!charts.length){ console.error('Nothing to write: no PDF matched a song.'); process.exit(1); }
zip.file('update.json', JSON.stringify({app:'setlist-stand', kind:'chart-update', version:1, made:new Date().toISOString(), charts}));
fs.writeFileSync(out, await zip.generateAsync({type:'nodebuffer'}));
console.log(`Wrote ${out}: ${charts.length} chart${charts.length == 1 ? '' : 's'}${left ? `, ${left} left out` : ''}.`);

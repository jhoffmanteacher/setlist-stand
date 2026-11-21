/* Import a share package: songs (and maybe a setlist) from another person's Setlist Stand.
   The file comes from somebody else, so everything in it is untrusted. It is read and checked completely BEFORE anything is
   written: the file (its size, and its zip directory: size, padding, zip64), share.json (against the CRC-32 the zip records for it; ours,
   not from a newer version, plain ids, short text, a required hash, a setlist that only
   names songs in the package), every PDF (present, its SHA-256 equal to the one recorded, opens in pdf.js, counted as it is
   read so a small file that inflates huge is stopped at a cap), every crop (bad parts are dropped, the rest kept). Songs the
   library already has (same SHA-256) are matched and left exactly as they are; nothing in this library is ever changed or
   replaced. Then ONE putAll() writes the new songs, their PDFs and the setlist: all or nothing. */
import {esc, toast, modal, uid, hooks, pdfPageCount} from './util.js';
import {state, putAll, load, newSong, sha256, ensureHashes, cleanCrop} from './store.js';
import {displayName} from './names.js';
import {explainError} from './errors.js';
import {ID_RE, LIMITS} from './backup.js';
import {SHARE_VERSION} from './sharepack.js';

/* maxPdfBytes: the PDFs of one package together; maxJson: share.json; maxSongs: songs in one package; maxDirectory: the zip's
   list of files, in bytes (a real package needs a few hundred KB). Changeable by the tests. */
export const limits = {maxPdfBytes:500e6, maxJson:20e6, maxSongs:5000, maxDirectory:2e6};
const plural = (n, w) => `${n} ${w}${n == 1 ? '' : 's'}`;
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const okText = v => typeof v === 'string' && v.length <= 200;
const short = v => typeof v === 'string' || typeof v === 'number' ? JSON.stringify(String(v)).slice(0, 40) : '(not text)';
const mb = n => n >= 1e6 ? Math.round(n / 1e6) + ' MB' : Math.round(n / 1e3) + ' KB';

/* The CRC-32 a zip entry records for its bytes. */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for(let n = 0; n < 256; n++){ let c = n; for(let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = bytes => { let c = 0xFFFFFFFF; for(let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

const NOT_PACKAGE = 'That file is not a Setlist Stand share package.', TOO_MANY = 'That package has too many files in it.';

/* Why the zip's list of files (its "central directory") cannot be opened safely, as a plain sentence, or null when it is fine.
   JSZip builds heap for every record just to open a zip and has no limit of its own: a small file with a million records costs
   about a gigabyte. So the end-of-directory record must be the last thing in the file (padding after it is never in a real package;
   JSZip searches the whole file backwards, so a guard that only looked at the last 64 KB would miss it), it must not be zip64 (JSZip then reads the 64-bit fields,
   not the 32-bit ones measured here), and the span from where the list starts to where that record sits must be small. A real
   package has none of the first two problems and a list of a few hundred KB. */
async function directoryProblem(file){
  const tail = new DataView(await file.slice(Math.max(0, file.size - 65557)).arrayBuffer());
  for(let i = tail.byteLength - 22; i >= 0; i--){
    if(tail.getUint32(i, true) !== 0x06054b50) continue;
    const at = file.size - tail.byteLength + i;
    if(at + 22 + tail.getUint16(i + 20, true) !== file.size) return NOT_PACKAGE;           // bytes after the record
    if([4, 6, 8, 10].some(o => tail.getUint16(i + o, true) === 0xFFFF) || [12, 16].some(o => tail.getUint32(i + o, true) === 0xFFFFFFFF)) return TOO_MANY;   // zip64
    return at - tail.getUint32(i + 16, true) > limits.maxDirectory ? TOO_MANY : null;
  }
  return NOT_PACKAGE;                             // no such record at the end of the file: not a zip
}

/* A zip entry's bytes, read in pieces and counted as they come: resolves to null as soon as they pass `room` bytes (the
   rest is never inflated). Rejects with the zip's own error. */
function readCapped(entry, room){
  return new Promise((res, rej) => {
    const chunks = []; let n = 0;
    const h = entry.internalStream('uint8array');
    h.on('data', c => { n += c.length; if(n > room){ h.pause(); res(null); } else chunks.push(c); })
      .on('error', rej)
      .on('end', () => { const out = new Uint8Array(n); let o = 0; for(const c of chunks){ out.set(c, o); o += c.length; } res(out); });
    h.resume();
  });
}

/* Returns null when share.json is fine, else a short reason. */
function checkShare(d){
  if(d.songs.length > limits.maxSongs) return `more than ${limits.maxSongs} songs`;
  const ids = new Set();
  for(const s of d.songs){
    if(!isObj(s)) return 'a song that is not a record';
    if(typeof s.id !== 'string' || !ID_RE.test(s.id)) return 'a song id ' + short(s.id);
    if(ids.has(s.id)) return `the song id ${s.id} twice`;
    ids.add(s.id);
    if(typeof s.song !== 'string' || !s.song.trim() || s.song.length > 200) return `song ${s.id} has no usable title`;
    for(const k of ['artist', 'version']) if(s[k] != null && !okText(s[k])) return `song ${s.id} has a ${k} that is not short text`;
    if(!(typeof s.hash === 'string' && /^[0-9a-f]{64}$/i.test(s.hash))) return `song ${s.id} has no valid hash`;      // required: it is how a damaged PDF is noticed
  }
  const st = d.setlist;
  if(st != null){
    if(!isObj(st)) return 'a setlist that is not a record';
    if(!okText(st.name)) return 'a setlist name that is not short text';
    if(!Array.isArray(st.items)) return 'setlist items that are not a list';
    if(st.items.length > LIMITS.items) return `more than ${LIMITS.items} setlist items`;
    for(const it of st.items){
      if(!isObj(it)) return 'a setlist item that is not a record';
      if(it.type === 'song'){ if(typeof it.id !== 'string' || !ids.has(it.id)) return 'a setlist item for a song that is not in the package'; }
      else if(it.type === 'break'){ if(!okText(it.name)) return 'a break name that is not short text'; }
      else return 'a setlist item of type ' + short(it.type);
    }
  }
  return null;
}

/* Reads and checks a package. Resolves to {error} (a plain sentence; nothing was changed) or a plan:
   {fresh:[{ps, bytes, hash, pages, crop, title}], matched, dropped, setlist, target}
   fresh: songs this library does not have; matched: how many of the package's songs it already has; dropped: crops thrown
   away; target: package song id -> {id} (a song already here) or {fresh: index into `fresh`}. */
export async function readPackage(file, isStopped = () => false){
  const bad = msg => ({error:msg + ' Nothing was changed.'});
  const damaged = err => /crc|corrupt/i.test(String(err && err.message));
  /* A file bigger than the PDFs and share.json may be together is refused before it is read at all. */
  if(file.size > limits.maxPdfBytes + limits.maxJson) return bad(`That package is too big: more than ${mb(limits.maxPdfBytes)}.`);
  const dir = await directoryProblem(file);
  if(dir) return bad(dir);
  let zip;
  /* No checkCRC32: with it JSZip inflates every entry completely just to open the zip, which would defeat the cap in readCapped.
     A damaged PDF is caught anyway: every song's recorded SHA-256 is required and compared below. */
  try{ zip = await JSZip.loadAsync(file); }
  catch(err){ return bad(damaged(err) ? 'That package is damaged.' : 'That file is not a Setlist Stand share package.'); }
  const entry = zip.file('share.json');
  if(!entry) return bad(zip.file('library.json') ? 'That is a backup, not a share package. Use Restore from backup.' : 'That file is not a Setlist Stand share package.');
  try{
    let data;
    try{
      const raw = await readCapped(entry, limits.maxJson);
      if(!raw) return bad('That package is too big to read.');
      /* with no CRC check at load, share.json is checked here against the CRC-32 the zip recorded for it (a missing one fails too) */
      const want = entry._data && entry._data.crc32;
      if(typeof want !== 'number' || crc32(raw) !== want >>> 0) return bad('That package is damaged.');
      data = JSON.parse(new TextDecoder().decode(raw));
    }catch(err){ return bad(damaged(err) ? 'That package is damaged.' : 'That file is not a Setlist Stand share package.'); }
    if(!isObj(data) || data.app !== 'setlist-stand' || data.kind !== 'share' || !Array.isArray(data.songs)) return bad('That file is not a Setlist Stand share package.');
    if(Number(data.version) > SHARE_VERSION) return bad('That package was made by a newer version of Setlist Stand. Update the app, then try again.');
    const problem = checkShare(data);
    if(problem) return bad(`That package has something the app can't read (${problem}).`);
    if(!data.songs.length && !data.setlist) return bad('That package is empty.');
    await ensureHashes().catch(() => {});
    const known = new Map(state.songs.filter(s => s.hash).map(s => [s.hash, s.id]));       // SHA-256 -> this library's song id
    const fresh = [], byHash = new Map(), target = new Map(), matchedIds = new Set();
    let room = limits.maxPdfBytes, dropped = 0;
    for(const ps of data.songs){
      if(isStopped()) return {error:'stopped'};                // Cancel was tapped: stop reading, so a retry does not hold two packages
      const label = displayName({song:ps.song.trim(), artist:String(ps.artist || '').trim(), version:String(ps.version || '').trim()});
      const pdf = zip.file('files/' + ps.id + '.pdf');
      if(!pdf) return bad(`That package is missing the PDF for "${label}".`);
      const bytes = await readCapped(pdf, room);
      if(!bytes) return bad(`That package is too big: its PDFs add up to more than ${mb(limits.maxPdfBytes)}.`);
      room -= bytes.length;
      const hash = await sha256(bytes);
      if(hash !== ps.hash.toLowerCase()) return bad(`That package is damaged ("${label}" does not match).`);
      if(known.has(hash)){ target.set(ps.id, {id:known.get(hash)}); matchedIds.add(known.get(hash)); continue; }
      if(byHash.has(hash)){ target.set(ps.id, {fresh:byHash.get(hash)}); continue; }          // the same PDF twice in one package: one song
      let pages;
      try{ pages = await pdfPageCount(bytes); }catch(err){ return bad(`"${label}" in that package is not a PDF this app can open.`); }
      if(!(pages >= 1)) return bad(`"${label}" in that package has no pages.`);
      if(pages > LIMITS.pages) return bad(`"${label}" in that package has ${pages} pages, which is more than the app takes.`);
      const {crop, dropped:d} = cleanCrop(ps.crop, pages);
      dropped += d;
      byHash.set(hash, fresh.length); target.set(ps.id, {fresh:fresh.length});
      fresh.push({ps, bytes, hash, pages, crop, title:label});
    }
    return {fresh, matched:matchedIds.size, dropped, setlist:data.setlist || null, target};
  }catch(err){ return bad(damaged(err) ? 'That package is damaged.' : 'That package could not be read.'); }
}

/* The name the imported setlist will get: its own, or "<name> (2)", "(3)" when a setlist here already has that name. */
function freeSetName(setlist){
  const names = new Set(state.sets.map(x => x.name)), base = setlist.name.trim() || 'Shared setlist';
  let name = base;
  for(let n = 2; names.has(name); n++) name = `${base} (${n})`;
  return name;
}

/* One question before anything is written. Resolves true for Add. */
function confirmDialog(plan){
  return new Promise(res => {
    const shown = plan.fresh.slice(0, 8).map(f => `<li>${esc(f.title)}</li>`).join('') + (plan.fresh.length > 8 ? `<li>and ${plan.fresh.length - 8} more</li>` : '');
    const lines = [plan.fresh.length ? `${plural(plan.fresh.length, 'new song')} will be added` : 'No new songs',
      plan.matched ? `${plural(plan.matched, 'song')} already in your library will stay as they are` : ''].filter(Boolean);
    const set = plan.setlist ? `<p>It also adds the setlist <b>${esc(freeSetName(plan.setlist))}</b>, as a new setlist.</p>` : '';
    const crops = plan.dropped ? `<p class="hint">${plural(plan.dropped, 'crop')} in the package could not be used and ${plan.dropped == 1 ? 'was' : 'were'} left out.</p>` : '';
    const m = modal(`<h2>Import share package</h2><p>${esc(lines.join('. '))}.</p>${shown ? `<ul class="duplist">${shown}</ul>` : ''}${set}${crops}
      <div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Add</button></div>`);
    m.querySelector('[data-x]').onclick = () => { m.remove(); res(false); };
    m.querySelector('[data-ok]').onclick = () => { m.remove(); res(true); };
  });
}
function notice(title, text){
  const m = modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="btns"><button class="pri" data-x>OK</button></div>`);
  m.querySelector('[data-x]').onclick = () => m.remove();
}

/* Writes the plan in ONE transaction: every new song's PDF and record (fresh ids) and the setlist (a fresh id, fresh break
   ids, a name that does not collide with a setlist already here). Resolves to {added, setName}. */
/* An id nobody has used: uid() can repeat when it is called in a tight loop (a big package), and a repeated key would silently
   overwrite the song written before it. */
const unique = taken => { let id = uid(), n = 0; while(taken.has(id)) id = uid() + (++n > 3 ? n.toString(36) : ''); taken.add(id); return id; };

async function commit(plan){
  const t = Date.now(), ops = [], ids = [];
  const taken = new Set([...state.songs.map(s => s.id), ...state.sets.map(s => s.id)]);
  for(const f of plan.fresh){
    const s = newSong({song:f.ps.song.trim(), artist:String(f.ps.artist || '').trim(), version:String(f.ps.version || '').trim()}, f.pages, f.hash);
    if(f.crop) s.crop = f.crop;
    s.id = unique(taken);
    ids.push(s.id);
    ops.push({store:'files', key:s.id, value:new Blob([f.bytes], {type:'application/pdf'})}, {store:'songs', key:s.id, value:s});
    f.bytes = null;                                 // the Blob has its own copy: do not hold every PDF twice while the write runs
  }
  let setName = null;
  if(plan.setlist){
    setName = freeSetName(plan.setlist);
    const items = plan.setlist.items.map(it => {
      if(it.type === 'break') return {type:'break', id:unique(taken), name:it.name.trim() || 'Break'};
      const g = plan.target.get(it.id);
      return {type:'song', id:g.id || ids[g.fresh]};
    });
    const id = unique(taken);
    ops.push({store:'sets', key:id, value:{id, name:setName, items, created:t, updated:t}});
  }
  await putAll(ops);
  return {added:plan.fresh.length, setName};
}

/* One import at a time, from the moment a file is picked until the screen shows the result. A second one started while the
   first is writing would read the library as it was before the first (so it would add every song again) and, once Cancel is
   tapped on the reading box, would hold two packages in memory. */
let running = false;
export async function importPackage(file){
  if(!file) return;
  if(running){ toast('An import is still running. Try again when it has finished.'); return; }
  running = true;
  try{ await runImport(file); }
  finally{ running = false; }
}

async function runImport(file){
  let stopped = false;
  const m = modal('<h2>Reading the package</h2><p class="hint" role="status">Checking every song…</p><div class="btns"><button data-x>Cancel</button></div>');
  m.querySelector('[data-x]').onclick = () => { stopped = true; m.remove(); };
  let plan;
  try{ plan = await readPackage(file, () => stopped); }
  catch(err){ m.remove(); if(!stopped) notice("Can't import that package", explainError(err, 'That package could not be read. Nothing was changed.')); return; }
  if(stopped) return;
  m.remove();
  if(plan.error){ notice("Can't import that package", plan.error); return; }
  if(!plan.fresh.length && !plan.setlist){ toast(`Nothing new: ${plural(plan.matched, 'song')} ${plan.matched == 1 ? 'is' : 'are'} already in your library.`); return; }
  if(!(await confirmDialog(plan))) return;
  /* the hidden [data-x] is what Escape clicks (modal() would otherwise close the box mid-write and the screen behind would come alive) */
  const w = modal('<h2>Adding songs</h2><p class="hint" role="status">Saving the package…</p><button data-x hidden></button>');       // the screen behind stays inert until it is written
  let r;
  try{ r = await commit(plan); }
  catch(err){ w.remove(); notice('Nothing was added', explainError(err, 'Something went wrong while adding the package. Nothing was changed.')); return; }
  try{ await load(); hooks.render(); }
  catch(err){ w.remove(); toast('The package was added, but the screen did not update. Reload the app to see it.'); return; }
  w.remove();
  const parts = [r.added ? `Added ${plural(r.added, 'song')}` : '', plan.matched ? `${plan.matched} already in your library` : '', r.setName ? `the setlist ${r.setName}` : ''].filter(Boolean);
  toast(parts.join(', ') + '.');
}

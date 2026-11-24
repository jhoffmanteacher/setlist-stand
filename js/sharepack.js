/* Share packages: chosen songs, or a whole setlist, as one zip for another person's Setlist Stand.
   The zip holds share.json and files/<id>.pdf. The PDFs are the stored bytes, copied as they are (never saved again), so a
   song's SHA-256 is the same on both tablets: that is how the receiver spots songs they already have. A package carries
   each song's title parts, page count and crop, and for a setlist its order and breaks. It never carries annotations,
   archive flags, timestamps or this library's ids (songs are numbered s1, s2... inside the package). */
import {get, songById, liveItems, sha256} from './store.js';
import {cutName} from './names.js';

export const SHARE_VERSION = 1;

/* A crop with something in it, copied; null when there is none (a song with {all:null, pages:{}} has no crop). Only
   rectangles with four finite numbers go in, and only those four numbers: a damaged crop in this library (a restore does
   not check crops) must not travel to somebody else's. */
const num = v => typeof v === 'number' && Number.isFinite(v);
const rectOf = r => r && typeof r === 'object' && !Array.isArray(r) && [r.x, r.y, r.w, r.h].every(num) ? {x:r.x, y:r.y, w:r.w, h:r.h} : null;
function cropOf(song){
  const c = song.crop;
  if(!c || typeof c !== 'object') return null;
  const all = rectOf(c.all), pages = {};
  if(c.pages && typeof c.pages === 'object' && !Array.isArray(c.pages))
    for(const [k, r] of Object.entries(c.pages)){ const q = rectOf(r); if(q && /^[1-9]\d*$/.test(k) && +k <= song.pages) pages[k] = q; }      // a real page of this song
  return all || Object.keys(pages).length ? {all, pages} : null;
}

/* The songs a setlist uses, each once, in order of first use (archived ones too: the setlist needs them). */
export function songIdsOf(set){
  const ids = [];
  for(const it of liveItems(set)) if(it.type === 'song' && !ids.includes(it.id)) ids.push(it.id);
  return ids;
}

/* songIds: the songs to put in, in order. set: null, or the setlist whose order and breaks go with them.
   opts.cancelled() stops early (resolves to {blob:null, cancelled:true}).
   Resolves to {blob, count, skipped}: skipped songs had no stored PDF and are left out (a setlist then lacks them too). */
export async function makePackage(songIds, set, opts = {}){
  const zip = new JSZip(), songs = [], local = new Map();
  let skipped = 0;
  for(const id of songIds){
    if(opts.cancelled && opts.cancelled()) return {blob:null, cancelled:true};
    const s = songById(id); if(!s || local.has(id)) continue;
    const f = await get('files', id);
    if(!f){ skipped++; continue; }
    const buf = await f.arrayBuffer(), pid = 's' + (songs.length + 1);
    zip.file('files/' + pid + '.pdf', buf, {createFolders:false});       // no "files/" folder entry: the zip holds only share.json and the PDFs
    const rec = {id:pid, song:cutName(s.song), artist:cutName(s.artist), version:cutName(s.version), pages:s.pages, hash:await sha256(buf)};
    const crop = cropOf(s); if(crop) rec.crop = crop;
    songs.push(rec); local.set(id, pid);
  }
  let setlist = null;
  if(set) setlist = {name:cutName(set.name), items:liveItems(set).filter(it => it.type === 'break' || local.has(it.id))
    .map(it => it.type === 'break' ? {type:'break', name:cutName(it.name)} : {type:'song', id:local.get(it.id)})};
  zip.file('share.json', JSON.stringify({app:'setlist-stand', kind:'share', version:SHARE_VERSION, saved:new Date().toISOString(), songs, setlist}));
  return {blob:await zip.generateAsync({type:'blob'}), count:songs.length, skipped};
}

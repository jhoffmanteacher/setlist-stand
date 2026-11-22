/* What a sync does to Google Drive (Parts 2 and 3): the three sub-folders, ONE listing of each, downloads, uploads, rename, delete.
   Built on the thin client in js/drive.js (token, retries, plain errors). Nothing here decides anything about the library:
   js/syncmerge.js decides, js/sync.js carries it out (js/syncplan.js reads both sides, js/syncapply.js does the work).

   Layout, inside the home folder "Setlist Stand" (found by its private mark, see drive.js):
     Charts                          one PDF per song: name "<title>.pdf", properties {k:'pdf', id:<song id>, h:<sha-256 hex>}
     Library data (do not edit)      one JSON file per record: name "<kind>-<id>.json", the record itself as the content,
                                     properties {k:<kind>, id, u:<updated>, c:<canonical hash>, d:'1' for a deletion marker}
     Marks (do not edit)             one JSON file per ink page (Part 3): name "ink-<song id>-<page>.json" (inkFileName in
                                     js/syncink.js), the page record {updated, strokes} as the content, properties
                                     {k:'ink', id:<song id>, p:<page>, u:<updated>, c:<canonical hash>, h:<the chart's sha-256>}
                                     (parseInkProps; a file without a usable h is a stray)
   The properties are what ONE listing needs to tell what changed, so nothing is downloaded to find out. A file the app did
   not make, or one whose properties are not ours, is never touched. Two files for one record (two tablets made it at the same
   moment) are not an error: the one with the larger `u` is used, then the oldest, then the smaller file id, so every tablet
   picks the same one; the others are left alone. */
import {call, readJson, odd, listAll, okFileId, FOLDER_MIME, ensureFolder, DriveError} from './drive.js';
import {ID_RE} from './store.js';
import {parseInkProps, DATE_MAX} from './syncink.js';

export const MULTIPART_MAX = 5 * 1024 * 1024;       // up to this, one request; over it, a resumable upload (needs the session address to be readable)
const SUBS = {charts:'Charts', data:'Library data (do not edit)', ink:'Marks (do not edit)'};
const LIST_FIELDS = 'nextPageToken,files(id,name,mimeType,createdTime,size,appProperties)';
const FILE_FIELDS = 'id,name,appProperties';
const HEX64 = /^[0-9a-f]{64}$/;
export const KIND_MARKS = ['coll', 'song', 'set'];

const byAge = (a, b) => String(a.createdTime || '').localeCompare(String(b.createdTime || '')) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const oldestFirst = byAge;                                      // folders: oldest first, then the smaller id

async function findSub(home, mark, {signal}){
  const found = await listAll({q:`mimeType = '${FOLDER_MIME}' and trashed = false and '${home}' in parents and appProperties has { key='setlistStand' and value='${mark}' }`,
    fields:'nextPageToken,files(id,createdTime)', pageSize:'100'}, {signal});
  return found.sort(oldestFirst);
}
/* One sub-folder: found, or made once (and looked for again, so two tablets that each made one agree on the oldest). */
async function ensureSub(home, mark, {signal}){
  let found = await findSub(home, mark, {signal});
  if(found.length) return found[0].id;
  const res = await call('/files', {method:'POST', query:{fields:'id'}, signal,
    json:{name:SUBS[mark], mimeType:FOLDER_MIME, parents:[home], appProperties:{setlistStand:mark}}});
  const made = await readJson(res);
  if(!okFileId(made.id)) throw odd('a new sub-folder with no usable id');
  found = await findSub(home, mark, {signal});
  return found.length ? found[0].id : made.id;
}
/* {home, charts, data, ink}: the folder ids, made when they are not there yet. The Marks folder is only LOOKED FOR here (ink: null when
   there is none): it is made by ensureInk() at the first page of marks that has to be sent, so a run with no marks to send never makes
   it, and a full Drive still downloads everything and fails only at the upload that needs space (as in Part 2). */
export async function ensureLayout({signal} = {}){
  const home = (await ensureFolder({signal})).id;
  const charts = await ensureSub(home, 'charts', {signal}), data = await ensureSub(home, 'data', {signal});
  const ink = (await findSub(home, 'ink', {signal}))[0];
  return {home, charts, data, ink:ink ? ink.id : null};
}
/* The Marks folder's id, found or made once (same rules as the other two); kept in the layout for the rest of the run. */
export async function ensureInk(layout, {signal} = {}){
  if(!layout.ink) layout.ink = await ensureSub(layout.home, 'ink', {signal});
  return layout.ink;
}

/* The better of two files for one thing: the larger `u` (records only), then the older, then the smaller file id. */
function better(a, b){
  if(Number.isFinite(a.u) && Number.isFinite(b.u) && a.u !== b.u) return b.u > a.u ? b : a;
  return byAge({createdTime:b.createdTime, id:b.fileId}, {createdTime:a.createdTime, id:a.fileId}) < 0 ? b : a;
}

/* What Drive holds, from one listing of each folder:
     pdfs     Map song id -> {fileId, name, h, size, createdTime}
     records  {coll, song, set}: Map id -> {fileId, name, u, c, d, createdTime}
     ink      Map "songId:page" -> {fileId, u, c, h, size, createdTime}   (a page of marks; same rule for two files of one page)
     strays   how many files in the three folders are not ours (left alone) */
export async function listLibrary({charts, data, ink: marks}, {signal} = {}){
  const pdfs = new Map(), records = {coll:new Map(), song:new Map(), set:new Map()}, ink = new Map();
  let strays = 0;
  for(const f of await listAll({q:`'${data}' in parents and trashed = false`, fields:LIST_FIELDS, pageSize:'1000'}, {signal})){
    const p = f.appProperties || {}, u = Number(p.u);
    if(!records[p.k] || typeof p.id !== 'string' || !ID_RE.test(p.id) || !Number.isFinite(u) || !HEX64.test(p.c || '')){ strays++; continue; }
    if(u < 0 || u > DATE_MAX){ strays++; continue; }          // (a time past MAX_U but still a date is listed: the run refuses it by name, fetchRecord)
    const e = {fileId:f.id, name:f.name, u, c:p.c, d:p.d === '1', createdTime:f.createdTime};
    const had = records[p.k].get(p.id);
    records[p.k].set(p.id, had ? better(had, e) : e);
  }
  for(const f of await listAll({q:`'${charts}' in parents and trashed = false`, fields:LIST_FIELDS, pageSize:'1000'}, {signal})){
    const p = f.appProperties || {};
    if(p.k !== 'pdf' || typeof p.id !== 'string' || !ID_RE.test(p.id) || !HEX64.test(p.h || '')){ strays++; continue; }
    const e = {fileId:f.id, name:f.name, h:p.h, size:Number(f.size) || 0, createdTime:f.createdTime, u:NaN};
    const had = pdfs.get(p.id);
    pdfs.set(p.id, had ? better(had, e) : e);
  }
  for(const f of marks ? await listAll({q:`'${marks}' in parents and trashed = false`, fields:LIST_FIELDS, pageSize:'1000'}, {signal}) : []){      // no Marks folder yet: no pages
    const p = parseInkProps(f.appProperties);          // checks the id, the page number, u (a date, written as String() writes it; one past MAX_U is refused by name when read) and c
    if(!p){ strays++; continue; }
    const key = p.songId + ':' + p.page, e = {fileId:f.id, u:p.u, c:p.c, h:p.h, size:Number(f.size) || 0, createdTime:f.createdTime};
    const had = ink.get(key);
    ink.set(key, had ? better(had, e) : e);
  }
  return {pdfs, records, ink, strays};
}

/* ---------- names and properties ---------- */
export const recordFileName = (kind, id) => `${kind}-${id}.json`;
/* "<title>.pdf": no control characters or slashes, at most 200 characters before the extension, "Untitled" when empty. */
export function pdfFileName(title){
  const t = String(title ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '-').trim().slice(0, 200).trim();
  return (t || 'Untitled') + '.pdf';
}
export const recordProps = (kind, rec, u, c) => ({k:kind, id:rec.id, u:String(u), c, ...(rec.deleted ? {d:'1'} : {})});
export const pdfProps = (id, h) => ({k:'pdf', id, h});
export const inkProps = (songId, page, u, c, h) => ({k:'ink', id:songId, p:String(page), u:String(u), c, h});

/* ---------- downloads ---------- */
export class TooBig extends Error { constructor(what){ super(`${what} is too big`); this.name = 'TooBig'; } }
/* A network failure while the body was still arriving rejects with a TypeError; Cancel with an AbortError. */
const bodyOf = async (res, read) => {
  try{ return await read(res); }
  catch(e){ if(e instanceof TooBig || (e && e.name === 'AbortError')) throw e; if(e instanceof TypeError) throw new DriveError('offline'); throw odd('a download that could not be read'); }
};
const sizeHeader = res => { const n = Number(res.headers.get('content-length')); return Number.isFinite(n) && n > 0 ? n : 0; };
/* The body as a Blob, read in pieces and STOPPED (the rest of the download is cancelled) as soon as it is over `maxBytes`, so a
   file with no Content-Length, or a compressed one, is never held whole before the limit applies. */
async function readLimited(res, maxBytes, what){
  if(maxBytes && sizeHeader(res) > maxBytes){ try{ await res.body?.cancel(); }catch(e){} throw new TooBig(what); }
  if(!res.body || !res.body.getReader){ const b = await res.blob(); if(maxBytes && b.size > maxBytes) throw new TooBig(what); return b; }
  const reader = res.body.getReader(), parts = []; let size = 0;
  for(;;){
    const {done, value} = await reader.read();
    if(done) break;
    size += value.byteLength;
    if(maxBytes && size > maxBytes){ try{ await reader.cancel(); }catch(e){} throw new TooBig(what); }
    parts.push(value);
  }
  return new Blob(parts, {type:res.headers.get('content-type') || ''});
}
/* A file's content as text, never more than maxBytes (TooBig). Whether it is JSON is the caller's question (a page of marks that is
   not JSON is a bad file, not a refusal by Google). */
export async function downloadText(fileId, {signal, maxBytes = 1e6, what = 'a record'} = {}){
  const res = await call('/files/' + encodeURIComponent(fileId), {query:{alt:'media'}, signal});
  return bodyOf(res, async r => (await readLimited(r, maxBytes, what)).text());
}
/* A record file's JSON, as an object (never an array). */
export async function downloadJson(fileId, {signal, maxBytes = 1e6} = {}){
  const text = await downloadText(fileId, {signal, maxBytes});
  let j; try{ j = JSON.parse(text); }catch(e){ throw odd('a record that is not JSON'); }
  if(!j || typeof j !== 'object' || Array.isArray(j)) throw odd('a record that is not an object');
  return j;
}
/* A PDF's bytes as a Blob, never larger than maxBytes. */
export async function downloadBlob(fileId, {signal, maxBytes} = {}){
  const res = await call('/files/' + encodeURIComponent(fileId), {query:{alt:'media'}, signal});
  return bodyOf(res, r => readLimited(r, maxBytes, 'a PDF'));
}

/* ---------- uploads ---------- */
const boundary = () => 'ss' + [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
/* Makes a file (no fileId) in `parent`, or replaces the content (and name and properties) of fileId. bytes: a Blob, text or
   bytes. Up to MULTIPART_MAX in one request; over it a resumable upload: ask for a session address, then send the bytes
   to it in one request. If the address cannot be read (the browser hides the header) a too-big PDF is refused (kind 'big').
   Only a GET is ever sent again after a lost answer (drive.js), so a lost answer here can leave a second file for one record
   or PDF: listLibrary() then picks the same one on every tablet. Returns {id, name, appProperties}. */
export async function putFile({fileId, parent, name, mime, appProperties, bytes}, {signal} = {}){
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes]), size = blob.size;
  const meta = {...(name != null ? {name} : {}), ...(appProperties ? {appProperties} : {}), ...(fileId ? {} : {parents:[parent], mimeType:mime})};
  const path = fileId ? '/files/' + encodeURIComponent(fileId) : '/files', method = fileId ? 'PATCH' : 'POST';
  let res;
  if(size <= MULTIPART_MAX){
    const b = boundary();
    const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`, blob, `\r\n--${b}--`]);
    res = await call(path, {method, base:'upload', query:{uploadType:'multipart', fields:FILE_FIELDS}, headers:{'Content-Type':`multipart/related; boundary=${b}`}, body, signal});
  }else{
    const init = await call(path, {method, base:'upload', query:{uploadType:'resumable', fields:FILE_FIELDS}, json:meta, signal});
    const where = init.headers.get('location');
    if(!where) throw new DriveError('big');
    res = await call(null, {method:'PUT', url:where, headers:{'Content-Type':mime}, body:blob, signal});
  }
  const j = await readJson(res);
  if(!okFileId(j.id)) throw odd('an uploaded file with no usable id');
  return j;
}
/* A file's properties as Drive holds them NOW (a page of marks is replaced only if it is still the one that was merged). */
export async function fileProps(fileId, {signal} = {}){
  const j = await readJson(await call('/files/' + encodeURIComponent(fileId), {query:{fields:'id,appProperties'}, signal}));
  return j.appProperties && typeof j.appProperties === 'object' ? j.appProperties : {};
}
/* Renames a file or changes its properties without touching its content. */
export async function patchFile(fileId, {name, appProperties}, {signal} = {}){
  const res = await call('/files/' + encodeURIComponent(fileId), {method:'PATCH', query:{fields:FILE_FIELDS}, signal,
    json:{...(name != null ? {name} : {}), ...(appProperties ? {appProperties} : {})}});
  return readJson(res);
}
/* Removes a file for good. A file that is already gone is done (somebody deleted it by hand). */
export async function deleteFile(fileId, {signal} = {}){
  try{ await call('/files/' + encodeURIComponent(fileId), {method:'DELETE', signal}); }
  catch(e){ if(!(e instanceof DriveError && e.status === 404)) throw e; }
}

/*
 * The parts of the fake Google Drive (fake-google.mjs) that are pure functions and can be checked in Node alone:
 * the `q` search grammar, the `fields` projection, `orderBy`, and the page token.
 *
 * Two kinds of refusal, kept apart on purpose:
 *  - DriveError: something real Drive also refuses (a q it cannot parse, an unknown field name). Answered the way
 *    Drive answers it, so the app's error handling is tested against the real shape.
 *  - NotModelled: something real Drive ACCEPTS that this stand-in does not imitate (`or`, `fullText contains`, a real
 *    field like `owners`). Answered 501 with a plain message, so a loop fails loudly instead of passing or failing on
 *    behaviour real Drive does not have.
 */
import crypto from 'node:crypto';

export class DriveError extends Error {
  constructor(code, reason, message, extra = {}){ super(message); this.code = code; this.reason = reason; this.extra = extra; }
}
export class NotModelled extends Error {}

export const FOLDER = 'application/vnd.google-apps.folder';

const invalidQ = () => new DriveError(400, 'invalid', 'Invalid Value', {locationType: 'parameter', location: 'q'});

/* ---------- q ---------- */
/* Tokens: single-quoted strings with backslash escapes (Drive's only string form), words, operators, braces. */
function tokenize(q){
  const out = [];
  for(let i = 0; i < q.length;){
    const c = q[i];
    if(/\s/.test(c)){ i++; continue; }
    if(c === "'"){
      let s = ''; i++;
      for(;; i++){
        if(i >= q.length) throw invalidQ();                       // unterminated string
        if(q[i] === '\\'){ if(i + 1 >= q.length) throw invalidQ(); s += q[++i]; continue; }
        if(q[i] === "'"){ i++; break; }
        s += q[i];
      }
      out.push({t: 'str', v: s}); continue;
    }
    const op = /^(!=|<=|>=|=|<|>)/.exec(q.slice(i));
    if(op){ out.push({t: 'op', v: op[1]}); i += op[1].length; continue; }
    if('{}()'.includes(c)){ out.push({t: c}); i++; continue; }
    const w = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(q.slice(i));
    if(!w) throw invalidQ();
    out.push({t: 'word', v: w[0]}); i += w[0].length;
  }
  return out;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/* Real Drive search terms this stand-in does not imitate: accepted by Google, so refusing them with a 400 would lie. */
const UNMODELLED_TERMS = new Set(['fullText', 'starred', 'viewedByMeTime', 'properties', 'visibility', 'sharedWithMe',
  'owners', 'writers', 'readers', 'shortcutDetails.targetId', 'hidden', 'memberCount', 'organizerCount', 'labels']);

/* "name contains": Drive documents PREFIX matching only ("HelloWorld" matches 'Hello', not 'World'). Case-insensitive
   matching on the start of the name or of any word in it is this stand-in's guess at the rest; do not rely on more. */
const containsName = (name, v) => { const n = name.toLowerCase(), x = v.toLowerCase(); return n.startsWith(x) || n.split(/[^a-z0-9]+/).some(w => w.startsWith(x)); };

/* Returns {test(file) -> bool, trashed: whether q mentions trashed}. `root` resolves the 'root' alias. */
export function parseQ(q, {root} = {}){
  if(q == null || q === '') return {test: () => true, trashed: false};
  const tk = tokenize(q);
  let i = 0, trashed = false;
  const peek = () => tk[i], next = () => tk[i++];
  const word = v => { const t = next(); if(!t || t.t !== 'word' || t.v !== v) throw invalidQ(); };
  const str = () => { const t = next(); if(!t || t.t !== 'str') throw invalidQ(); return t.v; };
  const op = allowed => { const t = next(); if(!t || t.t !== 'op' || !allowed.includes(t.v)) throw invalidQ(); return t.v; };
  const cmp = (o, a, b) => ({'=': a === b, '!=': a !== b, '<': a < b, '<=': a <= b, '>': a > b, '>=': a >= b})[o];
  function clause(){
    const t = next();
    if(!t) throw invalidQ();
    if(t.t === '(') throw new NotModelled('fake-google: parentheses in q are not modelled');
    if(t.t === 'word' && t.v === 'not'){ const c = clause(); return f => !c(f); }
    if(t.t === 'str'){                                            // 'ID' in parents
      const nt = next(); if(!nt || nt.t !== 'word' || nt.v !== 'in') throw invalidQ();
      const what = next(); if(!what || what.t !== 'word') throw invalidQ();
      if(['owners', 'writers', 'readers'].includes(what.v)) throw new NotModelled(`fake-google: '${what.v}' in q is not modelled`);
      if(what.v !== 'parents') throw invalidQ();
      const id = t.v === 'root' ? root : t.v;
      return f => f.parents.includes(id);
    }
    if(t.t !== 'word') throw invalidQ();
    if(UNMODELLED_TERMS.has(t.v)) throw new NotModelled(`fake-google: the q term '${t.v}' is not modelled`);
    switch(t.v){
      case 'name': {
        const o = peek()?.t === 'word' && peek().v === 'contains' ? (next(), 'contains') : op(['=', '!=']);
        const v = str();
        return o === 'contains' ? f => containsName(f.name, v) : f => cmp(o, f.name, v);
      }
      case 'mimeType': {
        const o = peek()?.t === 'word' && peek().v === 'contains' ? (next(), 'contains') : op(['=', '!=']);
        const v = str();
        return o === 'contains' ? f => f.mimeType.includes(v) : f => cmp(o, f.mimeType, v);
      }
      case 'trashed': {
        const o = op(['=', '!=']); const b = next();
        if(!b || b.t !== 'word' || (b.v !== 'true' && b.v !== 'false')) throw invalidQ();
        trashed = true; const v = b.v === 'true';
        return f => cmp(o, !!f.trashed, v);
      }
      case 'modifiedTime': case 'createdTime': {
        const o = op(['=', '!=', '<', '<=', '>', '>=']); const v = str();
        if(!RFC3339.test(v)) throw invalidQ();
        const ms = Date.parse(v); if(!Number.isFinite(ms)) throw invalidQ();
        const k = t.v;
        return f => cmp(o, Date.parse(f[k]), ms);
      }
      case 'appProperties': {                                     // appProperties has { key='k' and value='v' }
        word('has'); if(next()?.t !== '{') throw invalidQ();
        word('key'); op(['=']); const k = str(); word('and'); word('value'); op(['=']); const v = str();
        if(next()?.t !== '}') throw invalidQ();
        return f => Object.prototype.hasOwnProperty.call(f.appProperties, k) && f.appProperties[k] === v;
      }
      default: throw invalidQ();
    }
  }
  const parts = [clause()];
  while(i < tk.length){
    const t = next();
    if(t.t === 'word' && t.v === 'or') throw new NotModelled("fake-google: 'or' in q is not modelled");
    if(t.t !== 'word' || t.v !== 'and') throw invalidQ();
    parts.push(clause());
  }
  return {test: f => parts.every(p => p(f)), trashed};
}

/* ---------- fields ---------- */
/* Parses "a,b(c,d),e/f,*" into {name: subtree | true}. `e/f` is Drive's path form of `e(f)`. */
export function parseFields(s){
  let i = 0;
  const bad = () => new DriveError(400, 'invalidParameter', `Invalid field selection ${s}`, {locationType: 'parameter', location: 'fields'});
  function list(){
    const out = {};
    for(;;){
      const m = /^\s*(\*|[A-Za-z_][A-Za-z0-9_]*)\s*/.exec(s.slice(i));
      if(!m) throw bad();
      i += m[0].length;
      let sub = true;
      if(s[i] === '('){ i++; sub = list(); if(s[i] !== ')') throw bad(); i++; }
      else if(s[i] === '/'){ i++; sub = list1(); }
      out[m[1]] = sub === true || out[m[1]] === true ? true : {...(out[m[1]] || {}), ...sub};
      while(s[i] === ' ') i++;
      if(s[i] === ','){ i++; continue; }
      return out;
    }
  }
  function list1(){ const m = /^(\*|[A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(i)); if(!m) throw bad(); i += m[0].length;
    if(s[i] === '/'){ i++; return {[m[1]]: list1()}; } if(s[i] === '('){ i++; const l = list(); if(s[i] !== ')') throw bad(); i++; return {[m[1]]: l}; } return {[m[1]]: true}; }
  if(typeof s !== 'string' || !s.trim()) throw bad();
  const tree = list();
  if(i !== s.length) throw bad();
  return tree;
}

/* What this stand-in fills in on a file. REAL_FILE are genuine Drive v3 file fields it does not fill in (501, not 400). */
export const FILE_FIELDS = ['kind', 'id', 'name', 'mimeType', 'parents', 'appProperties', 'createdTime', 'modifiedTime',
  'trashed', 'size', 'description', 'md5Checksum', 'sha1Checksum', 'sha256Checksum'];
const REAL_FILE = new Set(['starred', 'explicitlyTrashed', 'properties', 'version', 'webViewLink', 'webContentLink', 'iconLink',
  'thumbnailLink', 'hasThumbnail', 'thumbnailVersion', 'owners', 'ownedByMe', 'capabilities', 'permissions', 'permissionIds',
  'headRevisionId', 'quotaBytesUsed', 'originalFilename', 'fullFileExtension', 'fileExtension', 'spaces', 'viewedByMe',
  'viewedByMeTime', 'modifiedByMeTime', 'modifiedByMe', 'sharedWithMeTime', 'shared', 'sharingUser', 'lastModifyingUser',
  'trashedTime', 'trashingUser', 'copyRequiresWriterPermission', 'writersCanShare', 'viewersCanCopyContent', 'folderColorRgb',
  'driveId', 'teamDriveId', 'contentHints', 'imageMediaMetadata', 'videoMediaMetadata', 'isAppAuthorized', 'exportLinks',
  'shortcutDetails', 'contentRestrictions', 'resourceKey', 'linkShareMetadata', 'labelInfo', 'hasAugmentedPermissions',
  'downloadRestrictions', 'inheritedPermissionsDisabled']);
export const LIST_SCHEMA = {kind: 1, nextPageToken: 1, incompleteSearch: 1, files: 'file'};

function checkFile(sub, path){
  for(const [k, v] of Object.entries(sub)){
    if(k === '*') continue;
    if(REAL_FILE.has(k)) throw new NotModelled(`fake-google: the file field '${k}' is not modelled`);
    if(!FILE_FIELDS.includes(k)) throw new DriveError(400, 'invalidParameter', `Invalid field selection ${path}${k}`, {locationType: 'parameter', location: 'fields'});
    if(v !== true && k !== 'appProperties') throw new DriveError(400, 'invalidParameter', `Invalid field selection ${path}${k}`, {locationType: 'parameter', location: 'fields'});
  }
}
/* Throws for an unknown name; `schema` is LIST_SCHEMA or 'file'. */
export function checkFields(tree, schema){
  if(schema === 'file') return checkFile(tree, '');
  for(const [k, v] of Object.entries(tree)){
    if(k === '*') continue;
    if(!(k in schema)) throw new DriveError(400, 'invalidParameter', `Invalid field selection ${k}`, {locationType: 'parameter', location: 'fields'});
    if(schema[k] === 'file' && v !== true) checkFile(v, k + '/');
    else if(schema[k] !== 'file' && v !== true) throw new DriveError(400, 'invalidParameter', `Invalid field selection ${k}`, {locationType: 'parameter', location: 'fields'});
  }
}
/* Keeps only the selected keys. A selected key the object does not have is left out, as Drive leaves it out. */
export function project(obj, tree){
  if(tree === true || tree['*']) return obj;
  const out = {};
  for(const [k, sub] of Object.entries(tree)){
    if(!(k in obj)) continue;
    const v = obj[k];
    if(sub === true) out[k] = v;
    else if(Array.isArray(v)) out[k] = v.map(x => project(x, sub));
    else if(v && typeof v === 'object') out[k] = k === 'appProperties' ? Object.fromEntries(Object.entries(v).filter(([p]) => p in sub || sub['*'])) : project(v, sub);
  }
  return out;
}

/* ---------- orderBy ---------- */
const SORT = {createdTime: f => Date.parse(f.createdTime), modifiedTime: f => Date.parse(f.modifiedTime), recency: f => Date.parse(f.modifiedTime),
  name: f => f.name.toLowerCase(), name_natural: f => f.name.toLowerCase(), folder: f => (f.mimeType === FOLDER ? 0 : 1)};
const REAL_SORT = new Set(['modifiedByMeTime', 'quotaBytesUsed', 'sharedWithMeTime', 'starred', 'viewedByMeTime']);
/* Without orderBy Drive promises no order; this stand-in sorts by id (random), so creation order is NOT what comes back. */
export function sorter(orderBy){
  const keys = (orderBy || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const [k, dir, ...rest] = s.split(/\s+/);
    if(REAL_SORT.has(k)) throw new NotModelled(`fake-google: orderBy ${k} is not modelled`);
    if(!SORT[k] || rest.length || (dir && dir !== 'desc')) throw new DriveError(400, 'invalid', 'Invalid Value', {locationType: 'parameter', location: 'orderBy'});
    return {get: SORT[k], desc: dir === 'desc', natural: k === 'name_natural'};
  });
  return (a, b) => {
    for(const {get, desc, natural} of keys){
      const x = get(a), y = get(b);
      const c = natural ? String(x).localeCompare(String(y), 'en', {numeric: true}) : (x < y ? -1 : x > y ? 1 : 0);
      if(c) return desc ? -c : c;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/* ---------- page tokens: opaque to the app, tied to the query that made them ---------- */
const queryKey = query => crypto.createHash('sha256').update(JSON.stringify([query.q || '', query.orderBy || '', query.spaces || ''])).digest('base64url').slice(0, 12);
export const makePageToken = (offset, query) => Buffer.from(JSON.stringify({o: offset, k: queryKey(query)})).toString('base64url');
export function readPageToken(tok, query){
  try{
    const {o, k} = JSON.parse(Buffer.from(tok, 'base64url').toString());
    if(Number.isInteger(o) && o >= 0 && k === queryKey(query)) return o;
  }catch(e){}
  throw new DriveError(400, 'invalid', 'Invalid Value', {locationType: 'parameter', location: 'pageToken'});
}

/* ---------- multipart/related upload bodies (uploadType=multipart) ---------- */
/* Binary safe: works on a Buffer and never turns the media part into text. Returns [{headers (lower-case names), body: Buffer}].
   The boundary is the one in the request's Content-Type (quoted or not). A part may say Content-Transfer-Encoding: base64
   (decoded here); any other encoding but binary/7bit/8bit is not modelled. */
export function parseMultipart(contentType, buf){
  const bad = msg => new DriveError(400, 'badRequest', msg);
  const m = /^\s*multipart\/related\s*;(?:[^;]*;)*?\s*boundary\s*=\s*(?:"([^"]+)"|([^\s;]+))/i.exec(contentType || '');
  if(!m) throw bad('Invalid multipart request: Content-Type must be multipart/related with a boundary.');
  const dash = Buffer.from('--' + (m[1] || m[2])), crlfDash = Buffer.concat([Buffer.from('\r\n'), dash]);
  /* A delimiter line is the boundary followed by CRLF, or by two dashes at the end; anything else is part of the data. */
  const delimAt = (from, key) => {
    for(let i = buf.indexOf(key, from); i >= 0; i = buf.indexOf(key, i + 1)){
      const rest = buf.subarray(i + key.length, i + key.length + 2).toString('latin1');
      if(rest === '--' || rest === '\r\n' || rest[0] === ' ' || rest[0] === '\t') return i;
    }
    return -1;
  };
  const parts = [];
  let at = delimAt(0, dash);
  if(at < 0) throw bad('Invalid multipart request: the boundary was not found.');
  for(;;){
    at += dash.length;
    if(buf.subarray(at, at + 2).toString('latin1') === '--') return parts;                 // closing delimiter
    const eol = buf.indexOf('\r\n', at); if(eol < 0) throw bad('Invalid multipart request: unterminated.');
    const start = eol + 2, end = delimAt(start - 2, crlfDash);                           // the CRLF before a delimiter belongs to the delimiter
    if(end < 0) throw bad('Invalid multipart request: the closing boundary is missing.');
    const raw = buf.subarray(start, end);
    let headers = {}, body = raw;
    if(raw.subarray(0, 2).toString('latin1') === '\r\n') body = raw.subarray(2);          // no headers at all
    else{
      const split = raw.indexOf('\r\n\r\n'); if(split < 0) throw bad('Invalid multipart request: a part has no body.');
      for(const line of raw.subarray(0, split).toString('latin1').split('\r\n')){ const i = line.indexOf(':'); if(i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
      body = raw.subarray(split + 4);
    }
    const enc = (headers['content-transfer-encoding'] || 'binary').toLowerCase();
    if(enc === 'base64') body = Buffer.from(body.toString('latin1').replace(/\s+/g, ''), 'base64');
    else if(!['binary', '7bit', '8bit'].includes(enc)) throw new NotModelled(`fake-google: Content-Transfer-Encoding ${enc} in a multipart part is not modelled`);
    parts.push({headers, body: Buffer.from(body)});
    at = end + 2;                                                                         // onto the next delimiter's dashes
  }
}

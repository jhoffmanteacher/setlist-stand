/*
 * A stand-in for Google sign-in and the Google Drive v3 REST API, at the network edge only.
 *
 * Real Google cannot be reached from the loops. This file answers `https://accounts.google.com/**` and
 * `https://www.googleapis.com/**` with Playwright's context.route(); the app, its service worker and its
 * Content-Security-Policy run for real. Because this is the ONE thing faked, it copies Drive's behaviour wherever the
 * app could lean on it (error shapes, CORS, default fields, sizes as strings, no promised order, paging, drive.file
 * visibility, upload kinds, downloads), and it refuses with 501 anything real Drive accepts but it does not imitate, so a
 * loop cannot pass on behaviour real Drive does not have. Where it is NOT faithful is listed at the end.
 *
 *   const google  = await installFakeGoogle(context,  {appBase});                                // the loop mutates google.auth, google.offline, ...
 *   const googleB = await installFakeGoogle(contextB, {appBase: baseB, share: google, name: 'B'}); // a second tablet, the SAME Drive
 *
 * The q grammar, fields projection, orderBy, page tokens and the multipart parser are in fake-google-query.mjs.
 */
import crypto from 'node:crypto';
import {DriveError, NotModelled, FOLDER, parseQ, parseFields, checkFields, project, LIST_SCHEMA, sorter,
  makePageToken, readPageToken, parseMultipart} from './fake-google-query.mjs';

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';
const URLSAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const randomChars = n => [...crypto.randomBytes(n)].map(b => URLSAFE[b & 63]).join('');
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* Real file ids are 33 url-safe characters (most start with "1"); the root folder's id starts with "0A". */
const newId = () => '1' + randomChars(32);
const now = () => new Date().toISOString();           // Drive's RFC 3339 with milliseconds and Z
/* The next modifiedTime of a file: now, but never the same as (or before) the one it had, so every change is visible. */
const tick = prev => new Date(Math.max(Date.now(), Date.parse(prev) + 1)).toISOString();
const DEFAULT_FILE = {kind: true, id: true, name: true, mimeType: true};
const CORE = Symbol('fake-google shared state');

/* Google's error body: {error:{code, message, errors:[{message, domain, reason, ...}], status?}} */
function gErr(code, reason, message, extra = {}, {domain = 'global', status} = {}){
  return {error: {code, message, errors: [{message, domain, reason, ...extra}], ...(status ? {status} : {})}};
}
const FAULT = {
  401: ['authError', 'Invalid Credentials', 'global'], 403: ['userRateLimitExceeded', 'User Rate Limit Exceeded', 'usageLimits'],
  429: ['rateLimitExceeded', 'Rate Limit Exceeded', 'usageLimits'], 500: ['backendError', 'Backend Error', 'global'],
  502: ['backendError', 'Bad Gateway', 'global'], 503: ['backendError', 'Backend Error', 'global'],
};
const LOGIN_REQUIRED = gErr(401, 'required', 'Login Required.', {locationType: 'header', location: 'Authorization'}, {status: 'UNAUTHENTICATED'});
const BAD_TOKEN = {error: {code: 401, message: 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.',
  errors: [{message: 'Invalid Credentials', domain: 'global', reason: 'authError', location: 'Authorization', locationType: 'header'}], status: 'UNAUTHENTICATED'}};
const NO_SCOPE = gErr(403, 'insufficientPermissions', 'Insufficient Permission', {}, {status: 'PERMISSION_DENIED'});
NO_SCOPE.error.message = 'Request had insufficient authentication scopes.';
const QUOTA_FULL = () => [403, gErr(403, 'storageQuotaExceeded', "The user's Drive storage quota has been exceeded.", {}, {domain: 'usageLimits'})];
const notFound = id => new DriveError(404, 'notFound', `File not found: ${id}.`, {locationType: 'parameter', location: 'fileId'});
const badBody = msg => new DriveError(400, 'badRequest', msg);
const utf8 = s => Buffer.byteLength(s, 'utf8');
const mimeOf = h => { const m = String(h || '').split(';')[0].trim().toLowerCase(); return m || null; };      // a Content-Type without its parameters
const CAN_308 = ua => /Chrome\/|Firefox\//.test(ua || '');           // Playwright's WebKit refuses to fulfill a redirect status (3xx)

/* The Drive: its files, tokens, switches and the logic of every route. One per Drive; every tablet (context) that shares it gets
   its own view (installFakeGoogle) with its own routes, address and name. */
function newCore(clientId, appBase){
  const rootId = '0A' + randomChars(17) + 'Uk9PVA';
  const google = {
    clientId, appBase, rootId, n: 0,
    auth: {mode: 'ok', errorCode: 'server_error', expiresIn: 3599},
    tokens: new Map(), issued: [], files: new Map(), sessions: new Map(), requests: [], faults: [], lost: [],
    offline: false, quotaFull: false, apiEnabled: true, maxPage: 0, latency: 0,
    /* Response headers page JavaScript may read across origins. Google's exact list is not known here. `location` (a resumable
       upload's session address) is listed because a resumable upload cannot work without it, but a loop may remove it to test an
       app that cannot read it. Retry-After is NOT exposed by default: the app must work without reading it (a loop may push
       'retry-after' to test the other path). */
    exposeHeaders: ['content-length', 'content-type', 'date', 'server', 'location'],
    clearLog(){ google.requests.length = 0; },
    requestsBy(name){ return google.requests.filter(r => r.by === name); },
    expire(token){ for(const [t, v] of google.tokens) if(!token || t === token) v.expires = 0; },
    failNext(status, {reason, times = 1, match = () => true, retryAfter, body} = {}){ google.faults.push({status, reason, times, match, retryAfter, body}); },
    /* The request is carried out (a folder IS made, a file IS written) but its answer never arrives: the connection drops on the way back. */
    loseAnswerNext({times = 1, match = () => true} = {}){ google.lost.push({times, match}); },
    /* Seeding. byApp:false is a file this app did not create: under drive.file it is invisible to the app (404, never listed). */
    addFile({name, mimeType = 'application/octet-stream', parents = [], appProperties = {}, content, byApp = true, trashed = false, createdTime, modifiedTime} = {}){
      const id = newId(), t = now();
      google.files.set(id, {id, name, mimeType, parents: parents.length ? parents.map(p => (p === 'root' ? rootId : p)) : [rootId],
        appProperties: {...appProperties}, createdTime: createdTime || t, modifiedTime: modifiedTime || createdTime || t, trashed,
        content: content == null ? undefined : Buffer.from(content), byApp});
      return id;
    },
    /* Inspection for loops (these see every file, including the ones the app may not see). trashed ones only with {all: true}. */
    list(parentId){ return [...google.files.values()].filter(f => !f.trashed && (!parentId || f.parents.includes(parentId === 'root' ? rootId : parentId))); },
    filesIn(folderId, {all = false} = {}){ const id = folderId === 'root' ? rootId : folderId; return [...google.files.values()].filter(f => f.parents.includes(id) && (all || !f.trashed)); },
    byProp(key, value, {all = false} = {}){ return [...google.files.values()].filter(f => (all || !f.trashed) && Object.prototype.hasOwnProperty.call(f.appProperties, key) && (value === undefined || f.appProperties[key] === value)); },
    fileBytes(id){ const f = google.files.get(id); if(!f) throw new Error(`fake-google: no file ${id}`); return Buffer.from(f.content || Buffer.alloc(0)); },
    folders(name){ return google.list().filter(f => f.mimeType === FOLDER && (name == null || f.name === name)); },
  };

  /* The resource as Drive returns it: size is an int64 STRING, folders and Google types have no size or checksums. */
  function view(f){
    const out = {kind: 'drive#file', id: f.id, name: f.name, mimeType: f.mimeType, parents: [...f.parents], createdTime: f.createdTime,
      modifiedTime: f.modifiedTime, trashed: !!f.trashed};
    if(Object.keys(f.appProperties).length) out.appProperties = {...f.appProperties};
    if(f.description != null) out.description = f.description;
    if(!f.mimeType.startsWith('application/vnd.google-apps.')){
      const c = f.content || Buffer.alloc(0);
      out.size = String(c.length);
      for(const h of ['md5', 'sha1', 'sha256']) out[h + 'Checksum'] = crypto.createHash(h).update(c).digest('hex');
    }
    return out;
  }
  const visible = id => { const f = google.files.get(id); return f && f.byApp ? f : null; };
  const fieldsOf = (query, schema, dflt) => { if(query.fields == null) return dflt; const t = parseFields(query.fields); checkFields(t, schema); return t; };

  /* appProperties: strings only, key+value at most 124 bytes (UTF-8), at most 30 per app. null removes (PATCH). */
  function applyProps(target, props, {allowNull}){
    if(props == null) return;
    if(typeof props !== 'object' || Array.isArray(props)) throw badBody('Invalid value for appProperties');
    for(const [k, v] of Object.entries(props)){
      if(v === null && allowNull){ delete target[k]; continue; }
      if(typeof v !== 'string' || !k) throw new DriveError(400, 'invalidAppProperties', `Invalid value for appProperties.${k}`);
      if(utf8(k) + utf8(v) > 124) throw new DriveError(400, 'invalidAppProperties', `The size of the custom property ${k} exceeds the limit of 124 bytes.`);
      target[k] = v;
    }
    if(Object.keys(target).length > 30) throw new DriveError(400, 'invalidAppProperties', 'The limit of 30 custom properties per file per app has been exceeded.');
  }
  const BODY_MODELLED = new Set(['name', 'mimeType', 'parents', 'appProperties', 'description', 'trashed', 'createdTime', 'modifiedTime']);
  const BODY_REAL = new Set(['id', 'properties', 'starred', 'originalFilename', 'contentHints', 'folderColorRgb', 'copyRequiresWriterPermission',
    'writersCanShare', 'viewedByMeTime', 'shortcutDetails', 'contentRestrictions', 'inheritedPermissionsDisabled', 'downloadRestrictions', 'labelInfo']);
  function readBody(buf){
    let body = {};
    if(buf && buf.length){ try{ body = JSON.parse(buf.toString('utf8')); }catch(e){ throw new DriveError(400, 'parseError', 'Parse Error'); } }
    if(!body || typeof body !== 'object' || Array.isArray(body)) throw new DriveError(400, 'parseError', 'Parse Error');
    for(const k of Object.keys(body)){
      if(BODY_REAL.has(k)) throw new NotModelled(`fake-google: the request field '${k}' is not modelled`);
      if(!BODY_MODELLED.has(k)) throw new DriveError(400, 'badRequest', `Invalid JSON payload received. Unknown name "${k}": Cannot find field.`);
    }
    return body;
  }
  const parentOf = p => { const id = p === 'root' ? rootId : p; if(id === rootId) return id; const f = visible(id); if(!f) throw notFound(p); if(f.mimeType !== FOLDER) throw new DriveError(400, 'badRequest', 'The specified parent is not a folder.' /* shape not checked against Drive */); return id; };

  /* A new file record from a request body (not stored: the caller stores it). Validates parents and appProperties. */
  function buildFile(body, content, mimeFallback){
    if(body.parents != null && (!Array.isArray(body.parents) || body.parents.some(p => typeof p !== 'string'))) throw badBody('Invalid value for parents');
    if(body.parents && body.parents.length > 1) throw new DriveError(403, 'cannotAddParent', 'Increasing the number of parents is not allowed.');
    const parents = body.parents && body.parents.length ? [parentOf(body.parents[0])] : [rootId];
    const props = {}; applyProps(props, body.appProperties, {allowNull: false});
    const t = now();
    return {id: newId(), name: body.name == null ? 'Untitled' : String(body.name), mimeType: body.mimeType || mimeFallback || 'application/octet-stream', parents,
      appProperties: props, createdTime: body.createdTime || t, modifiedTime: body.modifiedTime || t, trashed: !!body.trashed, byApp: true,
      ...(content !== undefined ? {content} : {}), ...(body.description != null ? {description: String(body.description)} : {})};
  }
  /* A change to an existing file (PATCH, or the end of an update upload). Everything is checked before anything is changed, so a
     refused change leaves the file as it was; to only check, call it on a copy ({...f}). `content` undefined = metadata only. */
  function applyPatch(f, query, body, content){
    if('parents' in body) throw new DriveError(403, 'fieldNotWritable', 'The resource body includes fields which are not directly writable.');
    const props = {...f.appProperties}; applyProps(props, body.appProperties, {allowNull: true});
    let parents = [...f.parents];
    const ids = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);
    for(const p of ids(query.removeParents)) parents = parents.filter(x => x !== (p === 'root' ? rootId : p));
    for(const p of ids(query.addParents)){ const pid = parentOf(p); if(!parents.includes(pid)) parents.push(pid); }
    if(parents.length > 1) throw new DriveError(403, 'cannotAddParent', 'Increasing the number of parents is not allowed.');
    if(body.name != null) f.name = String(body.name);
    if(body.mimeType != null) f.mimeType = body.mimeType;
    if(body.description != null) f.description = String(body.description);
    if(body.trashed != null) f.trashed = !!body.trashed;
    if(content !== undefined) f.content = content;
    f.appProperties = props; f.parents = parents;
    f.modifiedTime = body.modifiedTime || tick(f.modifiedTime);
  }

  /* ---------- the Drive routes; each returns [status, body, contentType?, extraHeaders?] ---------- */
  function listFiles(query){
    if(query.spaces && query.spaces !== 'drive'){
      if(query.spaces.split(',').every(s => ['drive', 'appDataFolder', 'photos'].includes(s.trim()))) throw new NotModelled(`fake-google: spaces=${query.spaces} is not modelled`);
      throw new DriveError(400, 'invalid', 'Invalid Value', {locationType: 'parameter', location: 'spaces'});
    }
    const size = query.pageSize == null ? 100 : Number(query.pageSize);
    if(!Number.isInteger(size) || size < 1 || size > 1000) throw new DriveError(400, 'invalid', `Invalid value '${query.pageSize}'. Values must be within the range: [1, 1000]`, {locationType: 'parameter', location: 'pageSize'});
    const fields = fieldsOf(query, LIST_SCHEMA, null);
    const {test} = parseQ(query.q, {root: rootId});
    const sort = sorter(query.orderBy);
    /* Like Drive, trashed files are returned unless q says `trashed = false`: the app has to ask. */
    const all = [...google.files.values()].filter(f => f.byApp && test(f)).sort(sort);
    const start = query.pageToken ? readPageToken(query.pageToken, query) : 0;
    const take = google.maxPage ? Math.min(size, google.maxPage) : size;
    const page = all.slice(start, start + take);
    const more = start + take < all.length;
    const out = {kind: 'drive#fileList', ...(more ? {nextPageToken: makePageToken(start + take, query)} : {}), incompleteSearch: false,
      files: page.map(view)};
    return [200, fields ? project(out, fields) : {...out, files: out.files.map(f => project(f, DEFAULT_FILE))}];
  }
  function createFile(query, buf){
    if(google.quotaFull) return QUOTA_FULL();
    const body = readBody(buf), fields = fieldsOf(query, 'file', DEFAULT_FILE);
    const f = buildFile(body);
    google.files.set(f.id, f);
    return [200, project(view(f), fields)];
  }
  function getFile(id, query){
    const f = visible(id); if(!f) throw notFound(id);
    if(query.alt === 'media'){
      if(f.mimeType === FOLDER) throw new DriveError(400, 'badRequest', 'A folder has no content to download.' /* status and reason not checked against Drive */, {locationType: 'parameter', location: 'alt'});
      if(f.mimeType.startsWith('application/vnd.google-apps.')) throw new DriveError(403, 'fileNotDownloadable', 'Only files with binary content can be downloaded. Use Export with Docs Editors files.', {locationType: 'parameter', location: 'alt'});
      return [200, f.content || Buffer.alloc(0), f.mimeType];
    }
    return [200, project(view(f), fieldsOf(query, 'file', DEFAULT_FILE))];
  }
  function patchFile(id, query, buf){
    const f = visible(id); if(!f) throw notFound(id);
    const body = readBody(buf), fields = fieldsOf(query, 'file', DEFAULT_FILE);
    applyPatch(f, query, body);
    return [200, project(view(f), fields)];
  }
  /* Real Drive deletes permanently (no trash), and a folder's contents go with it. */
  function deleteFile(id){
    if(!visible(id)) throw notFound(id);
    const gone = new Set([id]);
    for(let grew = true; grew;){ grew = false; for(const f of google.files.values()) if(!gone.has(f.id) && f.parents.some(p => gone.has(p))){ gone.add(f.id); grew = true; } }
    for(const g of gone) google.files.delete(g);
    return [204, null];
  }

  /* ---------- uploads: /upload/drive/v3/files (POST create, PATCH one update) and the resumable session address (PUT) ---------- */
  /* media: the body is the content. multipart: multipart/related, a JSON metadata part then the media part. resumable: a POST with
     JSON metadata answers 200 with a Location (the session address); one PUT of all the bytes to it finishes the upload. */
  function upload(method, id, query, buf, h){
    if(method === 'PUT') return resumablePut(query, buf, h);
    if(!((method === 'POST' && !id) || (method === 'PATCH' && id))) throw new NotModelled(`fake-google: ${method} /upload/drive/v3/files${id ? '/{id}' : ''} is not modelled`);
    const type = query.uploadType;
    if(type == null) throw new DriveError(400, 'badRequest', 'Invalid upload request: uploadType is required.', {locationType: 'parameter', location: 'uploadType'});
    if(!['media', 'multipart', 'resumable'].includes(type)) throw new DriveError(400, 'invalid', 'Invalid Value', {locationType: 'parameter', location: 'uploadType'});
    const target = id ? visible(id) : null;
    if(id && !target) throw notFound(id);
    if(google.quotaFull) return QUOTA_FULL();
    const fields = fieldsOf(query, 'file', DEFAULT_FILE);
    if(type === 'resumable'){
      const body = readBody(buf), mime = mimeOf(h['x-upload-content-type']);
      if(target) applyPatch({...target}, query, body); else buildFile(body, undefined, mime);          // refuse a bad request now, as Drive does when the session is opened
      const sid = 'AD-' + randomChars(60);
      google.sessions.set(sid, {id: sid, fileId: id || null, body, query: {...query}, mime, doneId: null});
      return [200, Buffer.alloc(0), 'application/json; charset=UTF-8', {location: `${UPLOAD_BASE}${id ? '/' + id : ''}?uploadType=resumable&upload_id=${sid}`}];
    }
    let body = {}, content, mime;
    if(type === 'media'){ content = Buffer.from(buf || Buffer.alloc(0)); mime = mimeOf(h['content-type']); }
    else{
      const parts = parseMultipart(h['content-type'], buf || Buffer.alloc(0));
      if(parts.length !== 2) throw badBody(`Invalid multipart request with ${parts.length} mime parts.`);
      if(!/^(application|text)\/json\b/i.test(parts[0].headers['content-type'] || '')) throw badBody('Invalid multipart request: the first part must be the JSON metadata.');
      body = readBody(parts[0].body); content = parts[1].body; mime = mimeOf(parts[1].headers['content-type']);
    }
    return [200, project(view(commit(target, query, body, content, mime)), fields)];
  }
  function commit(target, query, body, content, mime){
    if(target){ applyPatch(target, query, body, content); return target; }
    const f = buildFile(body, content, mime);
    google.files.set(f.id, f);
    return f;
  }
  function resumablePut(query, buf, h){
    const s = google.sessions.get(query.upload_id);
    if(!s) throw new DriveError(404, 'notFound', 'Not Found');
    const fieldsFor = () => fieldsOf({fields: query.fields ?? s.query.fields}, 'file', DEFAULT_FILE);
    const answerDone = () => { const f = visible(s.doneId); if(!f) throw notFound(s.doneId); return [200, project(view(f), fieldsFor())]; };
    const data = Buffer.from(buf || Buffer.alloc(0));
    const cr = h['content-range'];
    if(cr){
      const m = /^bytes (?:\*|(\d+)-(\d+))\/(\d+|\*)$/.exec(cr);
      if(!m) throw badBody('Invalid Content-Range header.');
      if(m[1] == null){                                                           // the status query: how much has been received?
        if(s.doneId) return answerDone();
        if(!CAN_308(h['user-agent'])) throw new NotModelled('fake-google: the status answer (308) cannot be fulfilled by this browser engine');
        return [308, Buffer.alloc(0), null];                                       // nothing received: Drive sends no Range header
      }
      if(Number(m[1]) !== 0 || Number(m[2]) !== data.length - 1 || Number(m[3]) !== data.length) throw new NotModelled('fake-google: resumable uploads in several pieces are not modelled (one PUT of all the bytes)');
    }
    if(s.doneId) return answerDone();                                              // the answer to the finishing PUT was lost: say it again, write nothing twice
    if(google.quotaFull) return QUOTA_FULL();
    const target = s.fileId ? visible(s.fileId) : null;
    if(s.fileId && !target) throw notFound(s.fileId);
    const f = commit(target, s.query, s.body, data, s.mime || mimeOf(h['content-type']));
    s.doneId = f.id;
    return [200, project(view(f), fieldsFor())];
  }

  google._drive = {listFiles, createFile, getFile, patchFile, deleteFile, upload};
  return google;
}

export async function installFakeGoogle(context, {appBase, clientId: clientIdArg = '553752641676-d3mb2enmv622rpl2bjlfvqpfe7922h18.apps.googleusercontent.com', share, name} = {}){
  if(!appBase) throw new Error('installFakeGoogle: appBase is required');
  if(share && !share[CORE]) throw new Error('installFakeGoogle: share must be what installFakeGoogle returned');
  const google = share ? share[CORE] : newCore(clientIdArg, appBase);      // the Drive itself, shared by every tablet that was given `share`
  const label = name || (share ? 'B' : 'A');
  const clientId = google.clientId;
  const drive = google._drive;

  /* ---------- CORS like Google: echo the Origin, answer preflights without any auth check ---------- */
  function cors(origin, extra = {}){
    return {...(origin ? {'access-control-allow-origin': origin} : {}), vary: 'Origin, X-Origin, Referer', 'access-control-expose-headers': google.exposeHeaders.join(', '), ...extra};
  }
  async function entryFor(route, kind){
    const r = route.request(), u = new URL(r.url()), h = await r.allHeaders();
    const query = Object.fromEntries(u.searchParams);
    const tokenInUrl = 'access_token' in query || google.issued.some(t => r.url().includes(t) || decodeURIComponent(u.pathname).includes(t));
    const e = {n: ++google.n, by: label, kind, method: r.method(), path: u.pathname, query, authorization: h.authorization ?? null, tokenInUrl,
      origin: h.origin ?? null, status: null, t0: Date.now(), ms: 0};
    if(kind !== 'auth' && r.method() === 'OPTIONS' && h['access-control-request-method']){ e.kind = 'preflight'; e.requestHeaders = h['access-control-request-headers'] || ''; }
    else if(kind === 'drive' && u.pathname.startsWith('/upload/')) e.kind = 'upload';
    else if(kind === 'drive' && r.method() === 'GET' && query.alt === 'media') e.kind = 'download';
    google.requests.push(e);
    return {e, r, u, h, query};
  }
  const finish = (e, status) => { e.status = status; e.ms = Date.now() - e.t0; delete e.t0; };
  async function abortIfOffline(route, e){ if(!google.offline) return false; finish(e, 'aborted'); await route.abort('internetdisconnected'); return true; }

  /* ---------- sign-in: Google checks the request, then redirects with the token in the FRAGMENT ---------- */
  async function onAuth(route){
    const {e, u, h, query} = await entryFor(route, 'auth');
    if(await abortIfOffline(route, e)) return;
    const page = (status, why) => { e.authError = why; finish(e, status); return route.fulfill({status, contentType: 'text/html; charset=utf-8', body: `<!doctype html><title>Error</title><h1>Access blocked: Authorisation error</h1><p>Error ${status}: ${why}</p>`}); };
    if(u.pathname !== '/o/oauth2/v2/auth') return page(404, 'not_found');
    if(query.client_id !== clientId) return page(400, 'invalid_client');
    if(query.redirect_uri !== appBase) return page(400, 'redirect_uri_mismatch');
    if(query.response_type !== 'token') return page(400, 'unsupported_response_type');
    if(!(query.scope || '').split(/\s+/).includes(DRIVE_FILE)) return page(400, 'invalid_scope');
    const a = google.auth, state = query.state;
    const issue = scope => {
      const token = 'ya29.' + crypto.randomBytes(90).toString('base64url');
      google.tokens.set(token, {expires: Date.now() + (a.expiresIn ?? 3599) * 1000, scope, mode: a.mode});
      google.issued.push(token);
      return `access_token=${token}&token_type=Bearer&expires_in=${a.expiresIn ?? 3599}&scope=${encodeURIComponent(scope)}`;
    };
    const st = s => (s == null ? '' : `&state=${encodeURIComponent(s)}`);
    let frag;
    switch(a.mode){
      case 'ok': frag = issue(query.scope) + st(state) + '&authuser=0'; break;
      case 'denied': frag = 'error=access_denied' + st(state); break;
      case 'error': frag = 'error=' + encodeURIComponent(a.errorCode || 'server_error') + st(state); break;
      case 'wrong-state': frag = issue(query.scope) + st(randomChars(24)) + '&authuser=0'; break;
      case 'no-state': frag = issue(query.scope) + '&authuser=0'; break;
      case 'no-scope': frag = issue('openid') + st(state) + '&authuser=0'; break;
      case 'nothing': frag = null; break;
      default: throw new Error(`fake-google: unknown auth mode ${a.mode}`);
    }
    const location = frag == null ? appBase : appBase.replace(/#.*$/, '') + '#' + frag;
    finish(e, 302);
    /* Google answers with a 302 whose Location carries the fragment. Playwright's WebKit refuses to fulfill a redirect
       status ("Cannot fulfill with redirect status"), so there the same address is reached with location.replace() from
       a tiny page on accounts.google.com (also no history entry). e.redirectVia says which path was taken. */
    const ua = h['user-agent'] || '';
    if(/Chrome\/|Firefox\//.test(ua)){ e.redirectVia = '302'; return route.fulfill({status: 302, headers: {location}, body: ''}); }
    e.redirectVia = 'script';      // a failed fulfill still marks the route handled, so the engine is chosen up front
    return route.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><script>location.replace(${JSON.stringify(location).replace(/</g, '\\u003c')})</script>`});
  }

  /* ---------- the API host ---------- */
  async function onApi(route){
    const {e, r, u, h, query} = await entryFor(route, 'drive');
    if(await abortIfOffline(route, e)) return;
    const origin = h.origin;
    if(e.kind === 'preflight'){
      finish(e, 200);
      return route.fulfill({status: 200, body: '', headers: cors(origin, {'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': h['access-control-request-headers'] || '', 'access-control-max-age': '3600', 'content-type': 'text/html; charset=UTF-8'})});
    }
    if(google.latency) await sleep(google.latency);
    /* type: a Content-Type, or null for none. An empty Buffer is an empty body (the resumable session answer, a 308). */
    const send = (status, body, type = 'application/json; charset=UTF-8', extra = {}) => {
      finish(e, status);
      const raw = status === 204 || body == null ? '' : Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 1);
      return route.fulfill({status, body: raw, headers: cors(origin, {...(status === 204 || type == null ? {} : {'content-type': type}), ...extra})});
    };
    const post = r.postDataBuffer();
    if(post){ e.bytes = post.length; e.body = post.toString('utf8').slice(0, 2000); }
    const fault = google.faults.find(f => f.times > 0 && f.match(e));
    if(fault){
      fault.times--; google.faults = google.faults.filter(f => f.times > 0);
      const [reason, message, domain] = FAULT[fault.status] || ['backendError', 'Backend Error', 'global'];
      const body = fault.body ?? gErr(fault.status, fault.reason || reason, message, {}, {domain, ...(fault.status === 401 ? {status: 'UNAUTHENTICATED'} : {})});
      return send(fault.status, body, undefined, fault.retryAfter != null ? {'retry-after': String(fault.retryAfter)} : {});
    }
    /* A resumable session address is its own credential (Drive's documented PUT carries no Authorization header). */
    const sessionPut = e.kind === 'upload' && r.method() === 'PUT' && google.sessions.has(query.upload_id);
    if(!sessionPut){
      /* Credentials: a bearer header, or (accepted by Drive, never wanted from the app; logged as tokenInUrl) ?access_token= */
      const m = /^Bearer\s+(\S+)$/i.exec(h.authorization || '');
      const token = m ? m[1] : query.access_token;
      if(!token) return send(401, LOGIN_REQUIRED);
      const tok = google.tokens.get(token);
      if(!tok || tok.expires <= Date.now()) return send(401, BAD_TOKEN);
      if(!google.apiEnabled) return send(403, gErr(403, 'accessNotConfigured', `Google Drive API has not been used in project ${clientId.split('-')[0]} before or it is disabled. Enable it by visiting the Google Cloud console then retry.`, {extendedHelp: 'console'}, {domain: 'usageLimits', status: 'PERMISSION_DENIED'}));
      if(!tok.scope.split(/\s+/).includes(DRIVE_FILE)) return send(403, NO_SCOPE);
    }
    try{
      /* A body the browser sent that the route could not read (Playwright gives none for some body kinds) must never pass as an empty file. */
      const want = Number(h['content-length'] || 0);
      if(e.kind === 'upload' && query.uploadType === 'multipart' && r.method() !== 'PUT' && !post) throw new NotModelled('fake-google: the multipart request body could not be read (this browser engine gave the route no body)');
      if(want > 0 && (!post || post.length !== want)) throw new NotModelled(`fake-google: the request body could not be read (${want} bytes announced, ${post ? post.length : 'none'} seen)`);
      const body = post || Buffer.alloc(0);
      const up = e.kind === 'upload' ? u.pathname.match(/^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/) : null;
      if(e.kind === 'upload' && !up) throw new DriveError(404, 'notFound', 'Not Found');
      const p = up || u.pathname.match(/^\/drive\/v3\/files(?:\/([^/]+))?$/);
      if(!p) throw (u.pathname.startsWith('/drive/v3/') ? new NotModelled(`fake-google: ${r.method()} ${u.pathname} is not modelled`) : new DriveError(404, 'notFound', 'Not Found'));
      const id = p[1] && decodeURIComponent(p[1]);
      const route2 = `${r.method()} ${id ? 'one' : 'all'}`;
      const out = up ? drive.upload(r.method(), id, query, body, h)
        : route2 === 'GET all' ? drive.listFiles(query) : route2 === 'POST all' ? drive.createFile(query, body)
        : route2 === 'GET one' ? drive.getFile(id, query) : route2 === 'PATCH one' ? drive.patchFile(id, query, body)
        : route2 === 'DELETE one' ? drive.deleteFile(id) : null;
      if(!out) throw new NotModelled(`fake-google: ${r.method()} ${u.pathname} is not modelled`);
      const lost = google.lost.find(f => f.times > 0 && f.match(e));
      if(lost){ lost.times--; google.lost = google.lost.filter(f => f.times > 0); finish(e, 'answer lost'); return route.abort('connectionreset'); }
      return send(out[0], out[1], out[2], out[3]);
    }catch(err){
      if(err instanceof DriveError) return send(err.code, gErr(err.code, err.reason, err.message, err.extra));
      if(err instanceof NotModelled) return send(501, {error: {code: 501, message: err.message, errors: [{reason: 'notModelledByFake', message: err.message}]}});
      throw err;
    }
  }

  /* Playwright's WebKit hands a route NO body (postDataBuffer() is null) for a request whose fetch body is a Blob; the headers (content-type
     with its boundary) arrive intact, and real Safari does send the Blob. So under WebKit only, every page of this context reads a Blob
     body into bytes before it calls fetch for an upload address: the same bytes and headers go out, and the route can see them. */
  let engine = ''; try{ engine = context.browser()?.browserType().name() || ''; }catch(e){}
  if(engine === 'webkit') await context.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async function(input, init){
      const url = String((input && input.url) || input);
      if(init && init.body instanceof Blob && url.startsWith('https://www.googleapis.com/upload/')){
        const type = init.body.type, headers = new Headers(init.headers || {});
        if(type && !headers.has('content-type')) headers.set('content-type', type);
        init = {...init, headers, body: new Uint8Array(await init.body.arrayBuffer())};
      }
      return original.call(this, input, init);
    };
  });
  await context.route('https://accounts.google.com/**', onAuth);
  await context.route('https://www.googleapis.com/**', onApi);
  /* What the loop holds: the shared Drive, except what belongs to this tablet (its sign-in address, its name, its own routes). */
  const own = {appBase, name: label, [CORE]: google, async close(){ await context.unroute('https://accounts.google.com/**', onAuth); await context.unroute('https://www.googleapis.com/**', onApi); }};
  return new Proxy(google, {get: (t, k) => (k in own ? own[k] : t[k]), set: (t, k, v) => { if(k in own) own[k] = v; else t[k] = v; return true; }, has: (t, k) => k in own || k in t});
}

/*
 * What this stand-in does and does not model
 *  - Sign-in: the implicit flow (response_type=token) only, checked for client_id, an EXACT redirect_uri, response_type
 *    and the drive.file scope. No consent screen, no account chooser, no prompt=none/silent re-auth, no popup or GIS
 *    library flow, no oauth2.googleapis.com (token revoke, tokeninfo): those addresses are NOT routed, so a call to them
 *    goes to the real network and fails offline. One account: a token issued to any tablet works on every tablet.
 *  - Two tablets, one Drive: installFakeGoogle(contextB, {appBase, share: googleA, name: 'B'}) serves the same files, sessions,
 *    tokens, sign-in mode and fault switches (failNext, loseAnswerNext, offline, quotaFull, apiEnabled, latency, maxPage,
 *    exposeHeaders, auth) to a second context; a write through the view sets the shared value. Only the redirect back after
 *    sign-in (each context's own appBase) and the `by` tag in the request log differ. Real tablets would also differ in
 *    clocks, caches and connections; here there is one clock and no per-device rate limit.
 *  - drive.file visibility is modelled one way: a seeded file with byApp:false is invisible (404, never listed). Sharing,
 *    permissions, owners, shared drives and the "opened with the picker" grant are not modelled.
 *  - Paging uses offsets over the live store: a file created between pages can shift the next page, which is roughly
 *    what real Drive risks too. Without orderBy the order is by random id, not creation order. Search is immediate:
 *    real Drive's search can lag behind a fresh create (eventual consistency) and this does not imitate that.
 *  - "name contains" is prefix matching, case-insensitive, on the name or any word in it (Drive documents prefix only).
 *    "name =" is exact and case-sensitive here; real Drive's case rules are not confirmed.
 *  - Uploads (/upload/drive/v3/files): POST create and PATCH /{id} update with uploadType=media (the body is the content; a create
 *    is named "Untitled"), multipart (multipart/related: a JSON metadata part, then the media part; parsed on bytes, base64
 *    parts accepted; exactly two parts) and resumable (POST with JSON metadata -> 200, empty body, a `Location` header with a
 *    session address on the same host holding upload_id; ONE PUT of all the bytes there finishes it with 200 and the file; a
 *    Content-Range of bytes 0-(N-1)/N is accepted; the status query, a PUT with Content-Range `bytes *` over N, answers the file once finished or
 *    308 with no Range header before that (Chromium and Firefox only: Playwright's WebKit cannot fulfill a 3xx, so it gets
 *    501); a second PUT after the finish answers the same file and writes nothing; the session address is its own credential, no
 *    token is checked on it). A file made by resumable exists only after the PUT. Not modelled, 501: resumable uploads in
 *    pieces, other Content-Transfer-Encodings. Not checked: X-Upload-Content-Length against the bytes, session expiry (a week
 *    in Drive), ETags, revisions. The response is the file limited by `fields` (default kind, id, name, mimeType). A create
 *    takes its mimeType from the metadata, else the media part's Content-Type (X-Upload-Content-Type for resumable, then the
 *    PUT's), else application/octet-stream; an UPDATE keeps the file's mimeType unless the metadata names one.
 *  - Metadata rules for create, update and PATCH: `parents` on create names at most one folder that exists and is visible
 *    to the app (404 if not, 400 if it is not a folder); `parents` in a PATCH body is refused (403 fieldNotWritable; use
 *    addParents/removeParents); appProperties are strings (a null removes the key on update only), key + value at most 124
 *    bytes, at most 30 per file, else 400 reason invalidAppProperties; an update merges the keys it names and keeps the rest;
 *    `name`, `trashed` (true and false), `description`, createdTime and modifiedTime (an explicit one is taken as given; else
 *    modifiedTime moves to now and is never equal to the one before, so every content or metadata change shows). size is a string,
 *    md5, sha1 and sha256 are computed from the stored bytes.
 *  - Downloads: GET /drive/v3/files/{id}?alt=media gives the bytes with the file's mimeType and Content-Length; unknown or
 *    invisible 404; Google-type files 403 fileNotDownloadable; a FOLDER is answered 400 here (real Drive's status and reason for
 *    a folder were not checked). A trashed file can still be downloaded, as in Drive. No Range requests, no HEAD, no export.
 *  - Faults: failNext, loseAnswerNext and latency apply to every request that reaches the API host, uploads and downloads
 *    included (the request log's `kind` is 'upload' for /upload/ paths, 'download' for alt=media GETs, 'preflight', 'auth' and
 *    'drive' for the rest; a failNext match function reads it). A fault answers BEFORE the request is read, so nothing is written.
 *    quotaFull answers 403 storageQuotaExceeded to every upload create/update (at opening a resumable session and again at its
 *    PUT) and to a metadata-only create; renames, trashing and deletes still work (real Drive's quota rules are more subtle).
 *    A request body the browser announced but Playwright could not hand over is refused 501 rather than read as empty.
 *  - Not modelled (answered 501 so a loop fails loudly): `or`, parentheses, fullText and other q terms, file fields beyond
 *    FILE_FIELDS, spaces other than drive, /about, /changes, revisions, copy, export, generateIds, emptyTrash, permissions,
 *    batch.
 *  - Trash: `trashed` is stored and searchable and PATCH can set it; trashed files are listed unless q says
 *    trashed = false (real Drive's default). No trash expiry. DELETE is permanent and takes a folder's contents too.
 *  - No storage quota accounting (only the quotaFull switch), no rate limiting (only failNext), no ETags,
 *    no If-Match, no 304s, no gzip, no batch endpoint, no quota per user or per project, no limit on file size.
 *  - CORS preflights: the handler answers them like Google (echoes the origin and the asked headers, no auth check, kind
 *    'preflight'), but Playwright's Chromium answers a cross-origin preflight to a fulfilled route by itself, so a loop
 *    usually sees none in the log. Whether Drive allows every header an app might send was not checked.
 *  - WebKit: Playwright's WebKit gives a route no body for a fetch whose body is a Blob (headers, boundary included, are intact;
 *    real Safari does send it). Under WebKit the stand-in therefore adds an init script that turns a Blob body of a request to
 *    /upload/ into bytes before fetch is called (same bytes, same headers; every context it is installed in). A multipart upload
 *    that still reaches the route with no body is answered 501, never read as empty. An empty media upload also arrives with no body
 *    in Chromium, so it is not refused.
 *  - A lost answer (loseAnswerNext) is the request carried out and then the connection reset; nothing else drops an answer part-way.
 *  - Headers page JavaScript can read: content-length, content-type, date, server and location (so a resumable session address
 *    can be read). Retry-After is sent only when failNext asks for it and is not exposed unless a loop adds it to
 *    google.exposeHeaders. Google's real exposed-header list was not checked; a loop may remove `location` to test an app that
 *    cannot read it.
 *  - Size is an int64 string and folders have none, as in Drive.
 */

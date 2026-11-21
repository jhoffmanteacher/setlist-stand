/*
 * A stand-in for Google sign-in and the Google Drive v3 REST API, at the network edge only.
 *
 * Real Google cannot be reached from the loops. This file answers `https://accounts.google.com/**` and
 * `https://www.googleapis.com/**` with Playwright's context.route(); the app, its service worker and its
 * Content-Security-Policy run for real. Because this is the ONE thing faked, it copies Drive's behaviour wherever the
 * app could lean on it (error shapes, CORS, default fields, sizes as strings, no promised order, paging, drive.file
 * visibility), and it refuses with 501 anything real Drive accepts but it does not imitate, so a loop cannot pass on
 * behaviour real Drive does not have. Where it is NOT faithful is listed at the end.
 *
 *   const google = await installFakeGoogle(context, {appBase});   // the loop mutates google.auth, google.offline, ...
 *
 * The q grammar, fields projection, orderBy and page tokens are in fake-google-query.mjs.
 */
import crypto from 'node:crypto';
import {DriveError, NotModelled, FOLDER, parseQ, parseFields, checkFields, project, LIST_SCHEMA, sorter,
  makePageToken, readPageToken} from './fake-google-query.mjs';

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const URLSAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const randomChars = n => [...crypto.randomBytes(n)].map(b => URLSAFE[b & 63]).join('');
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* Real file ids are 33 url-safe characters (most start with "1"); the root folder's id starts with "0A". */
const newId = () => '1' + randomChars(32);
const now = () => new Date().toISOString();           // Drive's RFC 3339 with milliseconds and Z
const DEFAULT_FILE = {kind: true, id: true, name: true, mimeType: true};

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
const notFound = id => new DriveError(404, 'notFound', `File not found: ${id}.`, {locationType: 'parameter', location: 'fileId'});
const badBody = msg => new DriveError(400, 'badRequest', msg);
const utf8 = s => Buffer.byteLength(s, 'utf8');

export async function installFakeGoogle(context, {appBase, clientId = '553752641676-d3mb2enmv622rpl2bjlfvqpfe7922h18.apps.googleusercontent.com'} = {}){
  if(!appBase) throw new Error('installFakeGoogle: appBase is required');
  const rootId = '0A' + randomChars(17) + 'Uk9PVA';
  let n = 0;
  const google = {
    clientId, appBase, rootId,
    auth: {mode: 'ok', errorCode: 'server_error', expiresIn: 3599},
    tokens: new Map(), issued: [], files: new Map(), requests: [], faults: [], lost: [],
    offline: false, quotaFull: false, apiEnabled: true, maxPage: 0, latency: 0,
    /* Response headers page JavaScript may read across origins. Google's exact list is not known here, so Retry-After is
       NOT exposed by default: the app must work without reading it (a loop may push 'retry-after' to test the other path). */
    exposeHeaders: ['content-length', 'content-type', 'date', 'server'],
    clearLog(){ google.requests.length = 0; },
    expire(token){ for(const [t, v] of google.tokens) if(!token || t === token) v.expires = 0; },
    failNext(status, {reason, times = 1, match = () => true, retryAfter, body} = {}){ google.faults.push({status, reason, times, match, retryAfter, body}); },
    /* The request is carried out (a folder IS made) but its answer never arrives: the connection drops on the way back. */
    loseAnswerNext({times = 1, match = () => true} = {}){ google.lost.push({times, match}); },
    /* Seeding. byApp:false is a file this app did not create: under drive.file it is invisible to the app (404, never listed). */
    addFile({name, mimeType = 'application/octet-stream', parents = [], appProperties = {}, content, byApp = true, trashed = false, createdTime, modifiedTime} = {}){
      const id = newId(), t = now();
      google.files.set(id, {id, name, mimeType, parents: parents.length ? parents.map(p => (p === 'root' ? rootId : p)) : [rootId],
        appProperties: {...appProperties}, createdTime: createdTime || t, modifiedTime: modifiedTime || createdTime || t, trashed,
        content: content == null ? undefined : Buffer.from(content), byApp});
      return id;
    },
    list(parentId){ return [...google.files.values()].filter(f => !f.trashed && (!parentId || f.parents.includes(parentId === 'root' ? rootId : parentId))); },
    folders(name){ return google.list().filter(f => f.mimeType === FOLDER && (name == null || f.name === name)); },
    async close(){ await context.unroute('https://accounts.google.com/**', onAuth); await context.unroute('https://www.googleapis.com/**', onApi); },
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
      if(typeof v !== 'string' || !k) throw badBody(`Invalid value for appProperties.${k}`);
      if(utf8(k) + utf8(v) > 124) throw new DriveError(400, 'badRequest', `The size of the custom property ${k} exceeds the limit of 124 bytes.`);
      target[k] = v;
    }
    if(Object.keys(target).length > 30) throw new DriveError(400, 'badRequest', 'The limit of 30 custom properties per file per app has been exceeded.');
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

  /* ---------- the Drive routes; each returns [status, body] ---------- */
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
    if(google.quotaFull) return [403, gErr(403, 'storageQuotaExceeded', "The user's Drive storage quota has been exceeded.", {}, {domain: 'usageLimits'})];
    const body = readBody(buf), fields = fieldsOf(query, 'file', DEFAULT_FILE);
    if(body.parents != null && (!Array.isArray(body.parents) || body.parents.some(p => typeof p !== 'string'))) throw badBody('Invalid value for parents');
    if(body.parents && body.parents.length > 1) throw new DriveError(403, 'cannotAddParent', 'Increasing the number of parents is not allowed.');
    const parents = body.parents && body.parents.length ? [parentOf(body.parents[0])] : [rootId];
    const props = {}; applyProps(props, body.appProperties, {allowNull: false});
    const t = now();
    const f = {id: newId(), name: body.name == null ? 'Untitled' : String(body.name), mimeType: body.mimeType || 'application/octet-stream', parents,
      appProperties: props, createdTime: body.createdTime || t, modifiedTime: body.modifiedTime || t, trashed: !!body.trashed, byApp: true,
      ...(body.description != null ? {description: String(body.description)} : {})};
    google.files.set(f.id, f);
    return [200, project(view(f), fields)];
  }
  function getFile(id, query){
    const f = visible(id); if(!f) throw notFound(id);
    if(query.alt === 'media'){
      if(f.mimeType.startsWith('application/vnd.google-apps.')) throw new DriveError(403, 'fileNotDownloadable', 'Only files with binary content can be downloaded. Use Export with Docs Editors files.', {locationType: 'parameter', location: 'alt'});
      return [200, f.content || Buffer.alloc(0), f.mimeType];
    }
    return [200, project(view(f), fieldsOf(query, 'file', DEFAULT_FILE))];
  }
  function patchFile(id, query, buf){
    const f = visible(id); if(!f) throw notFound(id);
    const body = readBody(buf), fields = fieldsOf(query, 'file', DEFAULT_FILE);
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
    f.appProperties = props; f.parents = parents;
    f.modifiedTime = body.modifiedTime || now();
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

  /* ---------- CORS like Google: echo the Origin, answer preflights without any auth check ---------- */
  function cors(origin, extra = {}){
    return {...(origin ? {'access-control-allow-origin': origin} : {}), vary: 'Origin, X-Origin, Referer', 'access-control-expose-headers': google.exposeHeaders.join(', '), ...extra};
  }
  async function entryFor(route, kind){
    const r = route.request(), u = new URL(r.url()), h = await r.allHeaders();
    const query = Object.fromEntries(u.searchParams);
    const tokenInUrl = 'access_token' in query || google.issued.some(t => r.url().includes(t) || decodeURIComponent(u.pathname).includes(t));
    const e = {n: ++n, kind, method: r.method(), path: u.pathname, query, authorization: h.authorization ?? null, tokenInUrl,
      origin: h.origin ?? null, status: null, t0: Date.now(), ms: 0};
    if(kind !== 'auth' && r.method() === 'OPTIONS' && h['access-control-request-method']){ e.kind = 'preflight'; e.requestHeaders = h['access-control-request-headers'] || ''; }
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
    if(u.pathname.startsWith('/upload/')) e.kind = 'upload';
    if(await abortIfOffline(route, e)) return;
    const origin = h.origin;
    if(e.kind === 'preflight'){
      finish(e, 200);
      return route.fulfill({status: 200, body: '', headers: cors(origin, {'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': h['access-control-request-headers'] || '', 'access-control-max-age': '3600', 'content-type': 'text/html; charset=UTF-8'})});
    }
    if(google.latency) await sleep(google.latency);
    const send = (status, body, type = 'application/json; charset=UTF-8', extra = {}) => {
      finish(e, status);
      const raw = status === 204 ? '' : Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 1);
      return route.fulfill({status, body: raw, headers: cors(origin, {...(status === 204 ? {} : {'content-type': type}), ...extra})});
    };
    if(r.postDataBuffer()) e.body = r.postDataBuffer().toString('utf8').slice(0, 2000);
    const fault = google.faults.find(f => f.times > 0 && f.match(e));
    if(fault){
      fault.times--; google.faults = google.faults.filter(f => f.times > 0);
      const [reason, message, domain] = FAULT[fault.status] || ['backendError', 'Backend Error', 'global'];
      const body = fault.body ?? gErr(fault.status, fault.reason || reason, message, {}, {domain, ...(fault.status === 401 ? {status: 'UNAUTHENTICATED'} : {})});
      return send(fault.status, body, undefined, fault.retryAfter != null ? {'retry-after': String(fault.retryAfter)} : {});
    }
    /* Credentials: a bearer header, or (accepted by Drive, never wanted from the app; logged as tokenInUrl) ?access_token= */
    const m = /^Bearer\s+(\S+)$/i.exec(h.authorization || '');
    const token = m ? m[1] : query.access_token;
    if(!token) return send(401, LOGIN_REQUIRED);
    const tok = google.tokens.get(token);
    if(!tok || tok.expires <= Date.now()) return send(401, BAD_TOKEN);
    if(!google.apiEnabled) return send(403, gErr(403, 'accessNotConfigured', `Google Drive API has not been used in project ${clientId.split('-')[0]} before or it is disabled. Enable it by visiting the Google Cloud console then retry.`, {extendedHelp: 'console'}, {domain: 'usageLimits', status: 'PERMISSION_DENIED'}));
    if(!tok.scope.split(/\s+/).includes(DRIVE_FILE)) return send(403, NO_SCOPE);
    try{
      if(e.kind === 'upload') throw new NotModelled('fake-google: uploads (/upload/drive/v3) are not modelled yet');
      const p = u.pathname.match(/^\/drive\/v3\/files(?:\/([^/]+))?$/);
      if(!p) throw (u.pathname.startsWith('/drive/v3/') ? new NotModelled(`fake-google: ${r.method()} ${u.pathname} is not modelled`) : new DriveError(404, 'notFound', 'Not Found'));
      const id = p[1] && decodeURIComponent(p[1]);
      const route2 = `${r.method()} ${id ? 'one' : 'all'}`;
      const out = route2 === 'GET all' ? listFiles(query) : route2 === 'POST all' ? createFile(query, r.postDataBuffer())
        : route2 === 'GET one' ? getFile(id, query) : route2 === 'PATCH one' ? patchFile(id, query, r.postDataBuffer())
        : route2 === 'DELETE one' ? deleteFile(id) : null;
      if(!out) throw new NotModelled(`fake-google: ${r.method()} ${u.pathname} is not modelled`);
      const lost = google.lost.find(f => f.times > 0 && f.match(e));
      if(lost){ lost.times--; google.lost = google.lost.filter(f => f.times > 0); finish(e, 'answer lost'); return route.abort('connectionreset'); }
      return send(out[0], out[1], out[2]);
    }catch(err){
      if(err instanceof DriveError) return send(err.code, gErr(err.code, err.reason, err.message, err.extra));
      if(err instanceof NotModelled) return send(501, {error: {code: 501, message: err.message, errors: [{reason: 'notModelledByFake', message: err.message}]}});
      throw err;
    }
  }

  await context.route('https://accounts.google.com/**', onAuth);
  await context.route('https://www.googleapis.com/**', onApi);
  return google;
}

/*
 * What this stand-in does and does not model
 *  - Sign-in: the implicit flow (response_type=token) only, checked for client_id, an EXACT redirect_uri, response_type
 *    and the drive.file scope. No consent screen, no account chooser, no prompt=none/silent re-auth, no popup or GIS
 *    library flow, no oauth2.googleapis.com (token revoke, tokeninfo): those addresses are NOT routed, so a call to them
 *    goes to the real network and fails offline.
 *  - drive.file visibility is modelled one way: a seeded file with byApp:false is invisible (404, never listed). Sharing,
 *    permissions, owners, shared drives and the "opened with the picker" grant are not modelled.
 *  - Paging uses offsets over the live store: a file created between pages can shift the next page, which is roughly
 *    what real Drive risks too. Without orderBy the order is by random id, not creation order. Search is immediate:
 *    real Drive's search can lag behind a fresh create (eventual consistency) and this does not imitate that.
 *  - "name contains" is prefix matching, case-insensitive, on the name or any word in it (Drive documents prefix only).
 *    "name =" is exact and case-sensitive here; real Drive's case rules are not confirmed.
 *  - Not modelled (answered 501 so a loop fails loudly): uploads (simple, multipart, resumable), `or`, parentheses,
 *    fullText and other q terms, file fields beyond FILE_FIELDS, spaces other than drive, /about, /changes, revisions,
 *    copy, export, generateIds, emptyTrash, permissions.
 *  - Trash: `trashed` is stored and searchable and PATCH can set it; trashed files are listed unless q says
 *    trashed = false (real Drive's default). No trash expiry. DELETE is permanent and takes a folder's contents too.
 *  - No storage quota accounting (only the quotaFull switch, on create), no rate limiting (only failNext), no ETags,
 *    no If-Match, no 304s, no gzip, no batch endpoint, no quota per user or per project.
 *  - A lost answer (loseAnswerNext) is the request carried out and then the connection reset; nothing else drops an answer part-way.
 *  - Retry-After is sent only when failNext asks for it, and is not exposed to page JavaScript unless the loop adds
 *    it to google.exposeHeaders (Google's exposed-header list was not checked).
 *  - Size is an int64 string and folders have none, as in Drive. md5/sha1/sha256 checksums are computed from content.
 */

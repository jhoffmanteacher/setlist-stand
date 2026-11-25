/* A thin Google Drive v3 client over fetch(). Everything goes to DRIVE_API with the token in the Authorization header,
   never in an address. Every call can be aborted (signal). Failures become a DriveError that carries one plain sentence
   (`plain`, read by explainError() in errors.js), so a screen never shows a stack trace.

   The app sees only the files it made itself (the drive.file permission). Its home is one folder named "ChartShark",
   found by name AND a private property AND its type, so a second tablet finds the same folder instead of making another. */
import {DRIVE_API, UPLOAD_API, FOLDER_NAME} from './driveconfig.js';
import {getToken, forgetToken} from './googleauth.js';
import {logProblem} from './errors.js';

/* How hard a busy Google is retried: `retries` more tries, pausing pauseMs, then twice that, and so on (or Google's own
   Retry-After, at most 30 s). A loop makes pauseMs small. */
export const tuning = {retries:3, pauseMs:1000};

const MESSAGES = {
  auth:    'Your Google sign-in has run out. Tap Connect again. Nothing was changed.',
  offline: 'Cannot reach Google. Check the internet connection, then try again. Nothing was changed.',
  full:    'Your Google Drive is full. Free up some space in Drive, then try again. Nothing was changed.',
  busy:    'Google is busy right now. Wait a minute, then try again. Nothing was changed.',
  denied:  'Google did not give this app permission to use its Drive folder. Tap Disconnect, then Connect again and allow it. Nothing was changed.',
  off:     'Google Drive is not switched on for this app in Google\'s settings. That is a setup step, not something wrong on this tablet. Nothing was changed.',
  other:   'Google did not answer the way the app expected. Nothing was changed.',
  big:     'This PDF is too big to send to Google Drive from this tablet. Nothing was changed.',
};
export class DriveError extends Error {
  /* reason: Google's short code for the failure (letters, digits, _ . - only, so nothing odd is ever shown or logged) */
  constructor(kind, {status = 0, reason = ''} = {}){
    super(`Drive ${kind}${status ? ' ' + status : ''}${reason ? ' ' + reason : ''}`);
    this.name = 'DriveError'; this.kind = kind; this.status = status; this.reason = reason;
    this.plain = MESSAGES[kind] || MESSAGES.other;
  }
}

const SAFE_REASON = /^[A-Za-z0-9_.-]{1,60}$/;
async function failureInfo(res){
  let j = null;
  try{ j = await res.json(); }catch(e){}
  const e = j && j.error, first = e && Array.isArray(e.errors) && e.errors[0], det = e && Array.isArray(e.details) && e.details[0];
  const pick = [first && first.reason, det && det.reason, e && typeof e.status === 'string' ? e.status : null].find(r => typeof r === 'string' && SAFE_REASON.test(r));
  return pick || '';
}
const classify = (status, reason) => {
  if(status === 401) return 'auth';
  if(status === 403){
    if(reason === 'storageQuotaExceeded') return 'full';
    if(reason === 'insufficientPermissions') return 'denied';
    if(reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED') return 'off';
    if(/^(rateLimitExceeded|userRateLimitExceeded|backendError)$/.test(reason)) return 'busy';
    return 'other';
  }
  return status === 429 || status >= 500 ? 'busy' : 'other';
};

function pause(ms, signal){
  return new Promise((res, rej) => {
    if(signal && signal.aborted) return rej(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => { if(signal) signal.removeEventListener('abort', stop); res(); }, ms);
    const stop = () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); };
    if(signal) signal.addEventListener('abort', stop, {once:true});
  });
}
const retryAfterMs = res => { const s = Number(res.headers.get('Retry-After')); return s > 0 ? Math.min(s, 30) * 1000 : 0; };

/* One request, with the retries a busy Google gets. Returns the Response of a success; throws DriveError (or an AbortError).
   `base: 'upload'` goes to the upload address; `url` is a full address Google handed out (the session address of a resumable
   upload), which must still be under one of the two Google API addresses; `body` is raw bytes (a Blob or text) with its own
   Content-Type in `headers`; `json` is a JSON body. */
export async function call(path, {method = 'GET', query, json, body, headers, base = 'api', url: whole, signal} = {}){
  const url = whole || (base === 'upload' ? UPLOAD_API : DRIVE_API) + path + (query ? '?' + new URLSearchParams(query) : '');
  if(!url.startsWith(DRIVE_API + '/') && !url.startsWith(UPLOAD_API + '/')) throw new DriveError('other');
  for(let attempt = 0; ; attempt++){
    const token = getToken();                       // asked again each time: the token may end while it waits
    if(!token) throw new DriveError('auth');
    if(navigator.onLine === false) throw new DriveError('offline');
    let res;
    try{
      res = await fetch(url, {method, signal, credentials:'omit', referrerPolicy:'no-referrer',
        headers:{Authorization:'Bearer ' + token, ...(json ? {'Content-Type':'application/json'} : {}), ...headers}, body:json ? JSON.stringify(json) : body});
    }catch(err){
      if(err && err.name === 'AbortError') throw err;
      /* fetch only rejects when no answer came back (a network blip, or no internet the browser did not notice): try
         again like a busy Google before saying so. Only a request that asks (GET) is sent again: one that makes something
         may have been done, with only its answer lost, and sending it again could make a second folder or file. The caller
         looks again before it tries again. */
      if(method === 'GET' && attempt < tuning.retries){ await pause(tuning.pauseMs * 2 ** attempt, signal); continue; }
      /* A refusal by the browser (the CSP, or CORS) rejects the same way as no internet: leave one line in the problem log
         (the error's name only, never an address) so the two can be told apart. */
      logProblem('drive', `Drive request got no answer (${err && err.name || 'error'}, online=${navigator.onLine})`, {quiet:true});
      throw new DriveError('offline');
    }
    if(res.ok) return res;
    const reason = await failureInfo(res), kind = classify(res.status, reason);
    if(kind === 'busy' && attempt < tuning.retries){ await pause(retryAfterMs(res) || tuning.pauseMs * 2 ** attempt, signal); continue; }
    if(kind === 'auth') forgetToken();              // Google says this token is no good: do not show "connected" any more
    /* A failure the person cannot fix by waiting or signing in goes in the private problem log, so it can be read out
       later. Only the kind, the status and Google's short code: never the token. */
    if(kind !== 'auth' && kind !== 'full') logProblem('drive', `Drive ${kind} ${res.status}${reason ? ' ' + reason : ''}`, {quiet:true});
    throw new DriveError(kind, {status:res.status, reason});
  }
}
/* An answer that is not the shape Drive documents: one plain sentence for the person, and a line for the problem log. */
export function odd(why){ logProblem('drive', 'Drive answer not as expected: ' + why, {quiet:true}); return new DriveError('other'); }
export async function readJson(res){
  let j;
  try{ j = await res.json(); }
  catch(e){
    if(e && e.name === 'AbortError') throw e;                       // Cancel while the answer was still arriving
    if(e instanceof TypeError) throw new DriveError('offline');     // the connection dropped part-way through it
    throw odd('not JSON');
  }
  if(j && typeof j === 'object') return j;
  throw odd('not an object');
}

export const okFileId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{4,200}$/.test(s);
export const quote = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");          // for a value inside '...' in a Drive query
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const HOME_PROP = {key:'setlistStand', value:'home'};
const MAX_PAGES = 500;

/* Every page of a listing. Drive may return fewer than asked per page and says so with nextPageToken; a token that comes
   back twice or a listing of more than MAX_PAGES pages is a broken answer, not something to wait for. */
export async function listAll(query, {signal} = {}){
  const out = [], seen = new Set();
  let token = '';
  for(let page = 0; page < MAX_PAGES; page++){
    const res = await call('/files', {query:{...query, ...(token ? {pageToken:token} : {})}, signal});
    const j = await readJson(res);
    if(!Array.isArray(j.files)) throw odd('no files list');
    for(const f of j.files){ if(!f || typeof f !== 'object' || !okFileId(f.id)) throw odd('a file with no usable id'); out.push(f); }
    if(!j.nextPageToken) return out;
    if(typeof j.nextPageToken !== 'string' || seen.has(j.nextPageToken)) throw odd('a page token that repeats');
    seen.add(j.nextPageToken); token = j.nextPageToken;
  }
  throw odd('more pages than any folder has');
}

/* The folders this account's app made, oldest first (two tablets that made one at the same moment leave two; every tablet
   then picks the oldest, so they agree). A folder is the app's by the private mark Drive keeps on it, NOT by its name, so
   renaming it in Drive changes nothing (Jonathan, 2026-11-21). A folder somebody else made with the same name has no mark
   and is never taken. */
async function homeFolders({signal} = {}){
  const found = await listAll({
    q:`mimeType = '${FOLDER_MIME}' and trashed = false and appProperties has { key='${HOME_PROP.key}' and value='${HOME_PROP.value}' }`,
    fields:'nextPageToken,files(id,createdTime)', pageSize:'100', orderBy:'createdTime'}, {signal});
  return found.sort((a, b) => String(a.createdTime || '').localeCompare(String(b.createdTime || '')) || (a.id < b.id ? -1 : 1));
}

/* Finds the folder, or makes it once. {id, created}. After making one, the list is read again: if another tablet made one
   a moment earlier, the older one is the home (this one is left empty; nothing is ever deleted here). */
export async function ensureFolder({signal} = {}){
  const found = await homeFolders({signal});
  if(found.length) return {id:found[0].id, created:false};
  const res = await call('/files', {method:'POST', query:{fields:'id'}, signal,
    json:{name:FOLDER_NAME, mimeType:FOLDER_MIME, appProperties:{[HOME_PROP.key]:HOME_PROP.value}}});
  const made = await readJson(res);
  if(!okFileId(made.id)) throw odd('a new folder with no usable id');
  const again = await homeFolders({signal});
  return {id:again.length ? again[0].id : made.id, created:true};
}

/* The files directly inside a folder (all pages), as Drive reports them. */
export function listFolder(folderId, {signal} = {}){
  if(!okFileId(folderId)) throw odd('a folder id that is not one');
  return listAll({q:`'${folderId}' in parents and trashed = false`, fields:'nextPageToken,files(id,name,mimeType,modifiedTime,size,appProperties)', pageSize:'1000'}, {signal});
}

/*
 * The Google Drive stand-in itself (tools/loops/fake-google.mjs), tested through REAL browser fetches. "sync fake a" .. "sync fake k".
 *
 * Every other Drive loop leans on the stand-in, so it must behave like Drive v3 for what the app uses: uploads (multipart, media,
 * resumable), downloads, appProperties rules, listing filters, paging, quota, faults, and two tablets sharing one Drive. These
 * loops send requests from a page on a local origin with a token the stand-in's own sign-in issued, so CORS, preflights and
 * header exposure apply as they do to the app. The app is not involved (the page is a 404 text page on the local server), and the
 * expected answers are written here from Drive's documented behaviour, not read from the stand-in. Nothing is mocked here.
 */
import crypto from 'node:crypto';
import {assert, sleep, WEBKIT} from './harness.mjs';
import {installFakeGoogle} from './fake-google.mjs';

const CLIENT_ID = '553752641676-d3mb2enmv622rpl2bjlfvqpfe7922h18.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'application/vnd.google-apps.folder';
const D = 'https://www.googleapis.com/drive/v3/files', U = 'https://www.googleapis.com/upload/drive/v3/files';
const FIELDS = 'id,name,mimeType,parents,appProperties,createdTime,modifiedTime,size,md5Checksum,trashed';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const md5 = b => crypto.createHash('md5').update(b).digest('hex');
const sorted = a => [...a].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* Bytes that break a text-only parser or a sloppy boundary search: a PDF-like head, random binary, CR LF and dashes, a line that
   starts like the boundary but is not it, and a tail that is not valid UTF-8. */
const BOUNDARY = 'ssBoundary_7b1';
function chart(n = 150000){
  return Buffer.concat([Buffer.from('%PDF-1.7\r\n%\xe2\xe3\xcf\xd3\r\n', 'latin1'), crypto.randomBytes(n), Buffer.from(`\r\n--${BOUNDARY}_decoy\r\n`),
    Buffer.from([0, 255, 13, 10, 45, 45, 0, 254, 253, 0xc3, 0x28])]);
}
function multipart(meta, bytes, mediaType, {boundary = BOUNDARY, quote = false} = {}){
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\n${mediaType ? `Content-Type: ${mediaType}\r\n` : ''}\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--`)]);
  return {body, headers: {'content-type': `multipart/related; boundary=${quote ? `"${boundary}"` : boundary}`}};
}

/* One tablet: a context with the stand-in installed, signed in through the stand-in's own address (the token comes from the redirect). */
async function tablet(ctx, {share, name, path = 'fake-a'} = {}){
  const s = await ctx.session({serviceWorkers: 'block'});
  const appBase = ctx.base + path;               // not the app: a 404 text page on the same local origin
  const google = await installFakeGoogle(s.context, {appBase, share, name});
  const t = {s, page: s.page, google, appBase, name};
  t.token = await signIn(t);
  return t;
}
async function signIn(t, redirect = t.appBase){
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirect)}&response_type=token&scope=${encodeURIComponent(SCOPE)}&state=x`;
  await t.page.goto(url).catch(() => {});
  await t.page.waitForFunction(() => /access_token=/.test(location.hash) || /Access blocked/.test(document.body?.textContent || ''), null, {timeout: 10000});
  const hash = await t.page.evaluate(() => location.hash);
  return new URLSearchParams(hash.slice(1)).get('access_token');
}

/* One fetch from the page. o: {method, url, headers, body (Buffer), json, as: 'blob'|'bytes', auth: false, token}. Returns what the page could read. */
function call(t, o){
  const o2 = {...o, body: o.json !== undefined ? Buffer.from(JSON.stringify(o.json)).toString('base64') : o.body == null ? null : Buffer.from(o.body).toString('base64'),
    headers: {...(o.json !== undefined ? {'content-type': 'application/json'} : {}), ...(o.headers || {})}};
  return t.page.evaluate(async ({token, o}) => {
    const bytes = o.body == null ? null : Uint8Array.from(atob(o.body), c => c.charCodeAt(0));
    const init = {method: o.method, headers: {...(o.auth === false ? {} : {authorization: 'Bearer ' + (o.token ?? token)}), ...o.headers}};
    if(bytes) init.body = o.as === 'blob' ? new Blob([bytes]) : bytes;
    let res;
    try{ res = await fetch(o.url, init); }catch(e){ return {error: String(e)}; }
    const buf = new Uint8Array(await res.arrayBuffer());
    const headers = {}; res.headers.forEach((v, k) => { headers[k] = v; });
    const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
    let text = null, json = null;
    if(buf.length < 100000){ text = new TextDecoder().decode(buf); if(/json/.test(res.headers.get('content-type') || '')) try{ json = JSON.parse(text); }catch(e){} }
    return {status: res.status, headers, sha: hex, len: buf.length, text, json};
  }, {token: t.token, o: o2});
}
const get = (t, url, o) => call(t, {method: 'GET', url, ...o});
const mkfolder = async (t, name = 'Charts', parents) => { const r = await call(t, {method: 'POST', url: D, json: {name, mimeType: FOLDER, ...(parents ? {parents} : {})}}); assert(r.status === 200, 'folder not made: ' + r.text); return r.json; };
const reason = r => r.json?.error?.errors?.[0]?.reason;
function expect(r, status, what, why){
  assert(r.status === status && (why == null || reason(r) === why), `${what}: expected ${status}${why ? ' ' + why : ''}, got ${r.error || r.status + ' ' + (r.text || '').slice(0, 200)}`);
  return r;
}
const listAll = async (t, q, extra = '') => {
  const out = []; let tok = '';
  do{
    const r = expect(await get(t, `${D}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('nextPageToken,files(id,name,mimeType,appProperties,trashed)')}${extra}${tok}`), 200, 'listing ' + q);
    out.push(...r.json.files); tok = r.json.nextPageToken ? '&pageToken=' + encodeURIComponent(r.json.nextPageToken) : '';
  }while(tok);
  return out;
};
const withTablet = (fn, opts) => async ctx => { const t = await tablet(ctx, opts); try{ await fn(t, ctx); } finally { await t.google.close(); await t.s.close(); } };

/* ---------- a: multipart create and update, with binary bytes ---------- */
async function multipartLoop(t){
  const {google} = t;
  const folder = await mkfolder(t);
  const bytes1 = chart(), meta = {name: 'Song (v1) - Artist.pdf', mimeType: 'application/pdf', parents: [folder.id], appProperties: {k: 'pdf', id: 's1', h: sha(bytes1)}};
  /* create: Uint8Array body, then a Blob body (the app will send Blobs from its storage) */
  for(const as of ['bytes', 'blob']){
    const b = as === 'blob' ? chart(80000) : bytes1;
    const made = expect(await call(t, {method: 'POST', url: `${U}?uploadType=multipart`, ...multipart({...meta, appProperties: {k: 'pdf', id: 'x' + as}}, b, 'application/octet-stream'), as}), 200, `multipart create (${as})`);
    assert(same(sorted(Object.keys(made.json)), ['id', 'kind', 'mimeType', 'name']) && made.json.kind === 'drive#file' && made.json.mimeType === 'application/pdf' && made.json.name === meta.name,
      `a create answers with the default fields only: ${made.text}`);
    const full = expect(await get(t, `${D}/${made.json.id}?fields=${FIELDS}`), 200, 'metadata read').json;
    assert(full.size === String(b.length) && full.md5Checksum === md5(b), `size ${full.size} / md5 ${full.md5Checksum} are not those of the ${b.length} bytes sent`);
    assert(same(full.parents, [folder.id]) && full.appProperties.id === 'x' + as && full.trashed === false, 'parents, appProperties or trashed wrong: ' + JSON.stringify(full));
    assert(full.createdTime === full.modifiedTime && !Number.isNaN(Date.parse(full.createdTime)), 'a new file has one creation and modification time');
    const dl = expect(await get(t, `${D}/${made.json.id}?alt=media`), 200, `download (${as})`);
    assert(dl.sha === sha(b) && dl.len === b.length, `the downloaded bytes are not the bytes sent (${dl.len} vs ${b.length})`);
    assert(dl.headers['content-type'] === 'application/pdf' && dl.headers['content-length'] === String(b.length), `download headers: ${dl.headers['content-type']} / ${dl.headers['content-length']}`);
    assert(google.fileBytes(made.json.id).equals(b), 'fileBytes() does not hold the bytes sent');
  }
  assert(google.filesIn(folder.id).length === 2 && google.byProp('k', 'pdf').length === 2, 'filesIn / byProp do not see the two files');
  /* no metadata mimeType: the media part's type; quoted boundary; no media type at all */
  const m2 = expect(await call(t, {method: 'POST', url: `${U}?uploadType=multipart&fields=id,name,mimeType`, ...multipart({name: 'n.bin'}, Buffer.from([1, 2, 3]), 'application/x-chart', {quote: true})}), 200, 'quoted boundary');
  assert(m2.json.mimeType === 'application/x-chart', 'with no mimeType in the metadata the file takes the media part\'s type: ' + m2.text);
  const m3 = expect(await call(t, {method: 'POST', url: `${U}?uploadType=multipart&fields=id,mimeType`, ...multipart({name: 'n.bin'}, Buffer.from([1]), null)}), 200, 'no media type');
  assert(m3.json.mimeType === 'application/octet-stream', 'no type anywhere is application/octet-stream: ' + m3.text);
  /* update: same file, new bytes, metadata merged, times move */
  const first = expect(await call(t, {method: 'POST', url: `${U}?uploadType=multipart&fields=${FIELDS}`, ...multipart(meta, bytes1, 'application/pdf')}), 200, 'create for update').json;
  const bytes2 = chart(60000);
  await sleep(5);
  const up = expect(await call(t, {method: 'PATCH', url: `${U}/${first.id}?uploadType=multipart&fields=${FIELDS}`, ...multipart({name: 'Renamed.pdf', appProperties: {b: '2'}}, bytes2, 'application/pdf')}), 200, 'multipart update').json;
  assert(up.id === first.id && up.createdTime === first.createdTime && Date.parse(up.modifiedTime) > Date.parse(first.modifiedTime), 'an update keeps the id and creation time and moves modifiedTime');
  assert(up.name === 'Renamed.pdf' && up.mimeType === 'application/pdf' && same(up.parents, [folder.id]), 'an update renames, keeps the type and the parent: ' + JSON.stringify(up));
  assert(same(up.appProperties, {k: 'pdf', id: 's1', h: sha(bytes1), b: '2'}), 'an update merges the appProperties it names and keeps the others: ' + JSON.stringify(up.appProperties));
  assert(up.size === String(bytes2.length) && up.md5Checksum === md5(bytes2), 'the update changed size and md5');
  assert((await get(t, `${D}/${first.id}?alt=media`)).sha === sha(bytes2), 'the download after an update is not the new bytes');
  const again = expect(await call(t, {method: 'PATCH', url: `${U}/${first.id}?uploadType=multipart&fields=modifiedTime`, ...multipart({}, bytes2, 'application/pdf')}), 200, 'second update at once').json;
  assert(Date.parse(again.modifiedTime) > Date.parse(up.modifiedTime), 'two changes in a row give two different modifiedTimes');
  const empty = expect(await call(t, {method: 'PATCH', url: `${U}/${first.id}?uploadType=multipart&fields=size`, ...multipart({}, Buffer.alloc(0), 'application/pdf')}), 200, 'empty media').json;
  assert(empty.size === '0', 'an empty media part makes an empty file');
  /* a request Drive refuses changes nothing */
  const n0 = google.files.size;
  const one = Buffer.from(`--${BOUNDARY}\r\nContent-Type: application/json\r\n\r\n{"name":"x"}\r\n--${BOUNDARY}--`);
  expect(await call(t, {method: 'POST', url: `${U}?uploadType=multipart`, body: one, headers: {'content-type': `multipart/related; boundary=${BOUNDARY}`}}), 400, 'one part only');
  expect(await call(t, {method: 'POST', url: `${U}?uploadType=multipart`, ...{...multipart(meta, bytes1, 'application/pdf'), headers: {'content-type': 'multipart/related'}}}), 400, 'no boundary');
  expect(await call(t, {method: 'POST', url: `${U}?uploadType=multipart`, ...{...multipart(meta, bytes1, 'application/pdf'), headers: {'content-type': 'application/pdf'}}}), 400, 'not multipart');
  expect(await call(t, {method: 'POST', url: `${U}?uploadType=multipart`, body: Buffer.from(`--${BOUNDARY}\r\nContent-Type: application/json\r\n\r\n{"name":"x"}\r\n--${BOUNDARY}\r\n\r\nabc`), headers: {'content-type': `multipart/related; boundary=${BOUNDARY}`}}), 400, 'no closing boundary');
  expect(await call(t, {method: 'POST', url: `${U}?uploadType=multipart`, ...multipart({name: 'x', bogus: 1}, bytes1, 'application/pdf')}), 400, 'unknown metadata field');
  expect(await call(t, {method: 'POST', url: `${U}?uploadType=multipart`, body: Buffer.from(`--${BOUNDARY}\r\nContent-Type: application/json\r\n\r\n{nope\r\n--${BOUNDARY}\r\n\r\nabc\r\n--${BOUNDARY}--`), headers: {'content-type': `multipart/related; boundary=${BOUNDARY}`}}), 400, 'metadata that is not JSON');
  assert(google.files.size === n0, 'a refused upload still made a file');
  const log = google.requests.filter(r => r.kind === 'upload' && r.method === 'POST');
  assert(log.length >= 8 && log.every(r => r.path === '/upload/drive/v3/files'), 'uploads are not logged as kind upload');
}

/* ---------- b: media (simple) uploads ---------- */
async function mediaLoop(t){
  const {google} = t;
  const b1 = chart(50000), b2 = chart(20000);
  const made = expect(await call(t, {method: 'POST', url: `${U}?uploadType=media&fields=id,name,mimeType,size`, body: b1, headers: {'content-type': 'application/pdf'}}), 200, 'media create').json;
  assert(made.name === 'Untitled' && made.mimeType === 'application/pdf' && made.size === String(b1.length), 'a media create is Untitled, takes the Content-Type: ' + JSON.stringify(made));
  expect(await call(t, {method: 'PATCH', url: `${D}/${made.id}`, json: {name: 'Song.pdf', appProperties: {k: 'pdf'}}}), 200, 'name it');
  const up = expect(await call(t, {method: 'PATCH', url: `${U}/${made.id}?uploadType=media&fields=name,size,mimeType,appProperties`, body: b2, headers: {'content-type': 'application/pdf'}, as: 'blob'}), 200, 'media update').json;
  assert(up.name === 'Song.pdf' && up.size === String(b2.length) && up.appProperties.k === 'pdf' && up.mimeType === 'application/pdf', 'a media update changes the bytes only: ' + JSON.stringify(up));
  assert((await get(t, `${D}/${made.id}?alt=media`)).sha === sha(b2), 'download after a media update');
  const bare = expect(await call(t, {method: 'POST', url: `${U}?uploadType=media&fields=mimeType`, body: Buffer.from([7, 8, 9])}), 200, 'no Content-Type').json;
  assert(bare.mimeType === 'application/octet-stream', 'a media create with no type is application/octet-stream (or the browser default): ' + bare.mimeType);
  expect(await call(t, {method: 'POST', url: U, body: b2}), 400, 'no uploadType');
  expect(await call(t, {method: 'POST', url: `${U}?uploadType=bogus`, body: b2}), 400, 'unknown uploadType');
  expect(await call(t, {method: 'PATCH', url: `${U}/nope?uploadType=media`, body: b2}), 404, 'update of an unknown file', 'notFound');
  assert(google.files.size === 2, 'the media loop left an unexpected number of files');
}

/* ---------- c: resumable, with `location` exposed (the default) ---------- */
async function resumableLoop(t){
  const {google} = t;
  const folder = await mkfolder(t);
  const bytes = chart(120000), meta = {name: 'R.pdf', mimeType: 'application/pdf', parents: [folder.id], appProperties: {k: 'pdf'}};
  const init = expect(await call(t, {method: 'POST', url: `${U}?uploadType=resumable&fields=${FIELDS}`, json: meta, headers: {'x-upload-content-type': 'application/pdf', 'x-upload-content-length': String(bytes.length)}}), 200, 'resumable start');
  const loc = init.headers.location;
  assert(init.len === 0 && loc && new URL(loc).origin === 'https://www.googleapis.com' && new URL(loc).searchParams.get('upload_id') && new URL(loc).searchParams.get('uploadType') === 'resumable', 'the start answers 200, an empty body and a Location with an upload_id: ' + loc);
  assert(google.filesIn(folder.id).length === 0, 'a resumable file exists before its bytes were sent');
  /* status query before anything was sent (the 308 cannot be made in Playwright\'s WebKit: there it is a 501) */
  const st = await call(t, {method: 'PUT', url: loc, headers: {'content-range': `bytes */${bytes.length}`}});
  assert(WEBKIT ? st.status === 501 : st.status === 308, `the status query before the bytes: ${st.status}`);
  assert(google.filesIn(folder.id).length === 0, 'a status query made a file');
  const done = expect(await call(t, {method: 'PUT', url: loc, body: bytes, as: 'blob', headers: {'content-type': 'application/pdf'}}), 200, 'resumable finish');
  const f = done.json;
  assert(f.name === 'R.pdf' && f.mimeType === 'application/pdf' && f.size === String(bytes.length) && f.md5Checksum === md5(bytes) && same(f.parents, [folder.id]) && f.appProperties.k === 'pdf', 'the finished file: ' + done.text);
  assert((await get(t, `${D}/${f.id}?alt=media`)).sha === sha(bytes), 'the downloaded bytes are not the bytes sent');
  /* the status query after it finished, and a second PUT (the first answer was lost): the same file, nothing written twice */
  if(!WEBKIT) assert(expect(await call(t, {method: 'PUT', url: loc, headers: {'content-range': `bytes */${bytes.length}`}}), 200, 'status after finish').json.id === f.id, 'status after finish names another file');
  const again = expect(await call(t, {method: 'PUT', url: loc, body: bytes, headers: {'content-type': 'application/pdf'}}), 200, 'second PUT');
  assert(again.json.id === f.id && google.filesIn(folder.id).length === 1, 'a second PUT made a second file');
  /* a PUT with no Authorization header works (the session address is the credential); default fields; the type comes from X-Upload-Content-Type */
  const i2 = expect(await call(t, {method: 'POST', url: `${U}?uploadType=resumable`, json: {name: 'R2.bin'}, headers: {'x-upload-content-type': 'application/x-chart'}}), 200, 'second start');
  const d2 = expect(await call(t, {method: 'PUT', url: i2.headers.location, body: Buffer.from([1, 2, 3]), auth: false}), 200, 'PUT without a token');
  assert(same(sorted(Object.keys(d2.json)), ['id', 'kind', 'mimeType', 'name']) && d2.json.mimeType === 'application/x-chart', 'default fields and the X-Upload-Content-Type: ' + d2.text);
  /* resumable update of the first file */
  const b3 = chart(30000);
  const i3 = expect(await call(t, {method: 'PATCH', url: `${U}/${f.id}?uploadType=resumable&fields=${FIELDS}`, json: {appProperties: {c: '3'}}}), 200, 'resumable update start');
  assert((await get(t, `${D}/${f.id}?alt=media`)).sha === sha(bytes), 'opening an update session changed the file');
  const u3 = expect(await call(t, {method: 'PUT', url: i3.headers.location, body: b3}), 200, 'resumable update finish').json;
  assert(u3.id === f.id && u3.size === String(b3.length) && u3.appProperties.c === '3' && u3.appProperties.k === 'pdf' && Date.parse(u3.modifiedTime) > Date.parse(f.modifiedTime), 'resumable update: ' + JSON.stringify(u3));
  /* refusals */
  expect(await call(t, {method: 'PUT', url: `${U}?uploadType=resumable&upload_id=nope`, body: bytes}), 404, 'unknown session');
  const n = google.sessions.size;
  expect(await call(t, {method: 'POST', url: `${U}?uploadType=resumable`, json: {name: 'x', appProperties: {a: 1}}}), 400, 'bad metadata at the start', 'invalidAppProperties');
  expect(await call(t, {method: 'POST', url: `${U}?uploadType=resumable`, json: {name: 'x', parents: ['nope']}}), 404, 'missing parent at the start');
  assert(google.sessions.size === n, 'a refused start opened a session');
  const i4 = expect(await call(t, {method: 'POST', url: `${U}?uploadType=resumable`, json: {name: 'x'}}), 200, 'start for pieces');
  expect(await call(t, {method: 'PUT', url: i4.headers.location, body: bytes.subarray(0, 10), headers: {'content-range': `bytes 0-9/${bytes.length}`}}), 501, 'pieces are not modelled');
}

/* ---------- d: resumable when `location` is not readable; Retry-After exposure ---------- */
async function exposeLoop(t){
  const {google} = t;
  assert(google.exposeHeaders.includes('location') && !google.exposeHeaders.includes('retry-after'), 'defaults: location exposed, retry-after not: ' + google.exposeHeaders);
  google.exposeHeaders = google.exposeHeaders.filter(h => h !== 'location');
  const n = google.sessions.size;
  const hidden = expect(await call(t, {method: 'POST', url: `${U}?uploadType=resumable`, json: {name: 'x'}}), 200, 'start with location hidden');
  assert(hidden.headers.location === undefined, 'the page can read Location although it is not exposed');
  assert(google.sessions.size === n + 1 && google.files.size === 0, 'the start still opened a session and made no file');
  google.exposeHeaders.push('location');
  const shown = expect(await call(t, {method: 'POST', url: `${U}?uploadType=resumable`, json: {name: 'x'}}), 200, 'start with location exposed again');
  assert(/upload_id=/.test(shown.headers.location || ''), 'Location is readable again once it is listed');
  google.failNext(429, {retryAfter: 3});
  const r1 = expect(await get(t, `${D}?pageSize=1`), 429, 'a 429');
  assert(r1.headers['retry-after'] === undefined, 'Retry-After was readable though not exposed');
  google.exposeHeaders.push('retry-after'); google.failNext(429, {retryAfter: 3});
  assert(expect(await get(t, `${D}?pageSize=1`), 429, 'a 429').headers['retry-after'] === '3', 'Retry-After is not readable once exposed');
}

/* ---------- e: appProperties limits and merge ---------- */
async function propsLoop(t){
  const {google} = t;
  const mk = props => call(t, {method: 'POST', url: `${U}?uploadType=multipart&fields=id,appProperties`, ...multipart({name: 'p.bin', appProperties: props}, Buffer.from('x'), 'text/plain')});
  const props = n => Object.fromEntries(Array.from({length: n}, (_, i) => ['key' + i, 'v' + i]));
  const thirty = expect(await mk(props(30)), 200, '30 properties').json;
  assert(Object.keys(thirty.appProperties).length === 30, 'thirty properties are kept');
  const n0 = google.files.size;
  expect(await mk(props(31)), 400, '31 properties', 'invalidAppProperties');
  expect(await mk({a: 5}), 400, 'a number value', 'invalidAppProperties');
  expect(await mk({a: null}), 400, 'a null value on create', 'invalidAppProperties');
  expect(await mk({a: {b: 'c'}}), 400, 'an object value', 'invalidAppProperties');
  expect(await mk(['a']), 400, 'a list');
  assert(google.files.size === n0, 'a refused create made a file');
  /* key + value at most 124 bytes (UTF-8 bytes, not characters) */
  expect(await mk({['k'.repeat(24)]: 'v'.repeat(100)}), 200, 'exactly 124 bytes');
  expect(await mk({['k'.repeat(24)]: 'v'.repeat(101)}), 400, '125 bytes', 'invalidAppProperties');
  expect(await mk({k: 'é'.repeat(62)}), 400, '125 bytes in 63 characters (UTF-8)', 'invalidAppProperties');
  expect(await mk({k: 'é'.repeat(61)}), 200, '123 bytes in 62 characters');
  expect(await mk({['k'.repeat(125)]: ''}), 400, 'a key of 125 bytes', 'invalidAppProperties');
  /* PATCH merges, null removes, the rest stays; a refused PATCH changes nothing */
  const f = expect(await call(t, {method: 'POST', url: `${D}?fields=id,modifiedTime`, json: {name: 'm', appProperties: {a: '1', b: '2', c: '3'}}}), 200, 'create').json;
  await sleep(5);
  const p = expect(await call(t, {method: 'PATCH', url: `${D}/${f.id}?fields=appProperties,modifiedTime,name`, json: {appProperties: {b: '22', c: null, d: '4'}}}), 200, 'merge').json;
  assert(same(p.appProperties, {a: '1', b: '22', d: '4'}) && p.name === 'm' && Date.parse(p.modifiedTime) > Date.parse(f.modifiedTime), 'a PATCH merges (null removes) and leaves the name: ' + JSON.stringify(p));
  expect(await call(t, {method: 'PATCH', url: `${D}/${f.id}`, json: {appProperties: props(30), name: 'changed'}}), 400, '33 after the merge', 'invalidAppProperties');
  const after = (await get(t, `${D}/${f.id}?fields=appProperties,name`)).json;
  assert(same(after, {appProperties: {a: '1', b: '22', d: '4'}, name: 'm'}), 'a refused PATCH changed the file: ' + JSON.stringify(after));
  const all = {k: 'v'.repeat(10)};
  const u = expect(await call(t, {method: 'PATCH', url: `${U}/${f.id}?uploadType=multipart&fields=appProperties`, ...multipart({appProperties: {...all, a: null}}, Buffer.from('y'), 'text/plain')}), 200, 'merge through an upload').json;
  assert(same(u.appProperties, {b: '22', d: '4', ...all}), 'an upload update merges too: ' + JSON.stringify(u));
  assert(google.byProp('b', '22').map(x => x.id).join() === f.id, 'byProp finds the file by key and value');
  expect(await call(t, {method: 'PATCH', url: `${D}/${f.id}`, json: {properties: {x: 'y'}}}), 501, 'public properties are not modelled');
}

/* ---------- f: rename, trash, untrash, delete ---------- */
async function lifecycleLoop(t){
  const {google} = t;
  const folder = await mkfolder(t);
  const b = chart(2000);
  const f = expect(await call(t, {method: 'POST', url: `${U}?uploadType=multipart&fields=id,modifiedTime`, ...multipart({name: 'one.pdf', mimeType: 'application/pdf', parents: [folder.id]}, b, 'application/pdf')}), 200, 'create').json;
  await sleep(5);
  const r = expect(await call(t, {method: 'PATCH', url: `${D}/${f.id}?fields=name,modifiedTime,size`, json: {name: 'two.pdf'}}), 200, 'rename').json;
  assert(r.name === 'two.pdf' && r.size === String(b.length) && Date.parse(r.modifiedTime) > Date.parse(f.modifiedTime), 'rename keeps the bytes and moves modifiedTime: ' + JSON.stringify(r));
  const inFolder = q => listAll(t, `'${folder.id}' in parents and ${q}`);
  assert((await inFolder("name = 'two.pdf'")).length === 1 && (await inFolder("name = 'one.pdf'")).length === 0, 'the listing does not follow the rename');
  expect(await call(t, {method: 'PATCH', url: `${D}/${f.id}`, json: {trashed: true}}), 200, 'trash');
  assert((await inFolder('trashed = false')).length === 0 && (await inFolder('trashed = true')).length === 1, 'trashed = false must leave out a trashed file, trashed = true find it');
  assert((await listAll(t, `'${folder.id}' in parents`)).length === 1, 'without trashed = false Drive lists trashed files too');
  assert((await get(t, `${D}/${f.id}?alt=media`)).sha === sha(b), 'a trashed file can still be downloaded');
  assert(google.filesIn(folder.id).length === 0 && google.filesIn(folder.id, {all: true}).length === 1, 'filesIn hides trashed files unless asked');
  expect(await call(t, {method: 'PATCH', url: `${D}/${f.id}?fields=trashed`, json: {trashed: false}}), 200, 'untrash');
  assert((await inFolder('trashed = false')).length === 1, 'an untrashed file is listed again');
  expect(await call(t, {method: 'PATCH', url: `${D}/${f.id}`, json: {parents: ['root']}}), 403, 'parents in a PATCH body', 'fieldNotWritable');
  expect(await call(t, {method: 'DELETE', url: `${D}/${f.id}`}), 204, 'delete');
  expect(await get(t, `${D}/${f.id}`), 404, 'a deleted file', 'notFound');
  expect(await get(t, `${D}/${f.id}?alt=media`), 404, 'a deleted file\'s bytes', 'notFound');
  expect(await call(t, {method: 'DELETE', url: `${D}/${f.id}`}), 404, 'delete twice');
  expect(await call(t, {method: 'PATCH', url: `${D}/${f.id}`, json: {name: 'x'}}), 404, 'rename after delete');
  expect(await call(t, {method: 'PATCH', url: `${U}/${f.id}?uploadType=media`, body: b}), 404, 'upload to a deleted file');
  /* a folder takes its contents with it */
  const g = expect(await call(t, {method: 'POST', url: `${U}?uploadType=media&fields=id`, body: b}), 200, 'file in the root').json;
  await call(t, {method: 'PATCH', url: `${D}/${g.id}?addParents=${folder.id}&removeParents=root`, json: {}});
  assert(google.filesIn(folder.id).length === 1, 'addParents / removeParents did not move the file');
  expect(await call(t, {method: 'DELETE', url: `${D}/${folder.id}`}), 204, 'delete the folder');
  expect(await get(t, `${D}/${g.id}`), 404, 'a file in a deleted folder');
  assert(google.files.size === 0, 'files are left after the folder went: ' + google.files.size);
}

/* ---------- g: the quota is full ---------- */
async function quotaLoop(t){
  const {google} = t;
  const folder = await mkfolder(t);
  const b1 = chart(5000), b2 = chart(6000);
  const f = expect(await call(t, {method: 'POST', url: `${U}?uploadType=multipart&fields=id`, ...multipart({name: 'q.pdf', parents: [folder.id]}, b1, 'application/pdf')}), 200, 'create before').json;
  const open = expect(await call(t, {method: 'POST', url: `${U}?uploadType=resumable`, json: {name: 'late.pdf', parents: [folder.id]}}), 200, 'a session opened before the quota filled');
  google.quotaFull = true;
  const n = google.files.size;
  expect(await call(t, {method: 'POST', url: `${U}?uploadType=multipart`, ...multipart({name: 'new.pdf', parents: [folder.id]}, b2, 'application/pdf')}), 403, 'multipart create', 'storageQuotaExceeded');
  expect(await call(t, {method: 'POST', url: `${U}?uploadType=media`, body: b2}), 403, 'media create', 'storageQuotaExceeded');
  expect(await call(t, {method: 'POST', url: `${U}?uploadType=resumable`, json: {name: 'x'}}), 403, 'resumable start', 'storageQuotaExceeded');
  expect(await call(t, {method: 'PATCH', url: `${U}/${f.id}?uploadType=multipart`, ...multipart({}, b2, 'application/pdf')}), 403, 'multipart update', 'storageQuotaExceeded');
  expect(await call(t, {method: 'PATCH', url: `${U}/${f.id}?uploadType=media`, body: b2}), 403, 'media update', 'storageQuotaExceeded');
  expect(await call(t, {method: 'PUT', url: open.headers.location, body: b2}), 403, 'the PUT of a session opened earlier', 'storageQuotaExceeded');
  assert(google.files.size === n && google.fileBytes(f.id).equals(b1), 'a refused upload changed something');
  expect(await call(t, {method: 'PATCH', url: `${D}/${f.id}`, json: {name: 'still-works.pdf'}}), 200, 'a rename with a full quota');
  google.quotaFull = false;
  expect(await call(t, {method: 'PUT', url: open.headers.location, body: b2}), 200, 'the same PUT with room again');
  expect(await call(t, {method: 'POST', url: `${U}?uploadType=media`, body: b2}), 200, 'create with room again');
}

/* ---------- h: 404s, visibility, credentials ---------- */
async function refusalLoop(t){
  const {google} = t;
  const folder = await mkfolder(t), file = google.addFile({name: 'plain', mimeType: 'text/plain', parents: [folder.id], content: 'hello'});
  const foreign = google.addFile({name: 'not ours', mimeType: 'text/plain', content: 'secret', byApp: false});
  const foreignFolder = google.addFile({name: 'foreign folder', mimeType: FOLDER, byApp: false});
  const doc = google.addFile({name: 'a doc', mimeType: 'application/vnd.google-apps.document'});
  assert((await get(t, `${D}/${file}?alt=media`)).text === 'hello', 'a seeded file is downloadable');
  expect(await get(t, `${D}/nope?alt=media`), 404, 'an unknown id', 'notFound');
  expect(await get(t, `${D}/${foreign}?alt=media`), 404, 'a file the app did not make (drive.file)', 'notFound');
  expect(await get(t, `${D}/${foreign}`), 404, 'its metadata');
  expect(await call(t, {method: 'PATCH', url: `${U}/${foreign}?uploadType=media`, body: Buffer.from('x')}), 404, 'an update of it');
  expect(await call(t, {method: 'DELETE', url: `${D}/${foreign}`}), 404, 'a delete of it');
  assert(google.fileBytes(foreign).toString() === 'secret', 'the invisible file changed');
  assert(!(await listAll(t, 'trashed = false')).some(x => x.id === foreign || x.id === foreignFolder), 'an invisible file is listed');
  expect(await get(t, `${D}/${folder.id}?alt=media`), 400, 'a folder cannot be downloaded');
  expect(await get(t, `${D}/${doc}?alt=media`), 403, 'a Google doc cannot be downloaded', 'fileNotDownloadable');
  const up = (parents, type = 'multipart') => call(t, {method: 'POST', url: `${U}?uploadType=${type}`, ...multipart({name: 'x', parents}, Buffer.from('x'), 'text/plain')});
  expect(await up(['nope']), 404, 'a parent that does not exist', 'notFound');
  expect(await up([foreignFolder]), 404, 'a parent the app did not make', 'notFound');
  expect(await up([file]), 400, 'a parent that is not a folder');
  expect(await up([folder.id, 'root']), 403, 'two parents', 'cannotAddParent');
  assert((await up([folder.id])).status === 200 && (await up(['root'])).status === 200, 'a folder and the root are good parents');
  /* credentials */
  const mp = {method: 'POST', url: `${U}?uploadType=media`, body: Buffer.from('x')};
  expect(await call(t, {...mp, auth: false}), 401, 'no token');
  expect(await call(t, {...mp, token: 'ya29.not-a-token'}), 401, 'a made-up token', 'authError');
  expect(await get(t, `${D}/${file}?alt=media`, {auth: false}), 401, 'a download with no token');
  google.expire(t.token);
  expect(await call(t, mp), 401, 'an expired token on an upload');
  expect(await get(t, `${D}/${file}?alt=media`), 401, 'an expired token on a download');
  const t2 = await signIn(t); t.token = t2;
  google.apiEnabled = false; expect(await call(t, mp), 403, 'API switched off', 'accessNotConfigured'); google.apiEnabled = true;
  assert((await call(t, mp)).status === 200, 'a new token works');
}

/* ---------- i: listing filters and paging ---------- */
async function listingLoop(t){
  const {google} = t;
  const folder = await mkfolder(t, 'Charts'), other = await mkfolder(t, 'Data');
  const mk = (name, parents, props, type = 'application/pdf') => call(t, {method: 'POST', url: `${U}?uploadType=multipart&fields=id`, ...multipart({name, mimeType: type, parents: [parents], appProperties: props}, Buffer.from(name), type)}).then(r => expect(r, 200, 'make ' + name).json.id);
  const ids = {};
  for(const [n, p, props, type] of [['a.pdf', folder.id, {k: 'song'}], ['b.pdf', folder.id, {k: 'song'}], ['c.pdf', folder.id, {k: 'set'}], ["d'e.pdf", folder.id, {k: 'song', x: 'y'}], ['f.json', other.id, {k: 'song'}, 'application/json'], ['g.json', other.id, {k: 'coll'}, 'application/json']]) ids[n] = await mk(n, p, props, type);
  await call(t, {method: 'PATCH', url: `${D}/${ids['b.pdf']}`, json: {trashed: true}});
  const names = r => sorted(r.map(x => x.name)), want = l => sorted(l);
  assert(same(names(await listAll(t, "appProperties has { key='k' and value='song' } and trashed = false")), want(["d'e.pdf", 'a.pdf', 'f.json'])), 'appProperties has { key and value }');
  assert(same(names(await listAll(t, "appProperties has { key='k' and value='song' }")), want(["d'e.pdf", 'a.pdf', 'b.pdf', 'f.json'])), 'without trashed = false the trashed one is listed');
  assert(same(names(await listAll(t, `'${folder.id}' in parents and trashed = false`)), want(["d'e.pdf", 'a.pdf', 'c.pdf'])), "'<folder>' in parents");
  assert(same(names(await listAll(t, `'${other.id}' in parents and appProperties has { key='k' and value='coll' }`)), want(['g.json'])), 'in parents and appProperties');
  assert(same(names(await listAll(t, "name = 'a.pdf'")), want(['a.pdf'])) && same(names(await listAll(t, "name = 'd\\'e.pdf'")), want(["d'e.pdf"])), 'name = (and a quote escaped with a backslash)');
  assert(same(names(await listAll(t, `mimeType = 'application/json' and '${other.id}' in parents`)), want(['f.json', 'g.json'])), 'mimeType =');
  assert(same(names(await listAll(t, `mimeType = '${FOLDER}' and trashed = false`)), want(['Charts', 'Data'])), 'mimeType = folder');
  assert(same(names(await listAll(t, "appProperties has { key='x' and value='y' }")), want(["d'e.pdf"])), 'a key only one file has');
  assert((await listAll(t, "appProperties has { key='k' and value='nothing' }")).length === 0, 'a value nobody has');
  expect(await get(t, `${D}?q=${encodeURIComponent("name ==")}`), 400, 'a q Drive cannot parse');
  expect(await get(t, `${D}?q=${encodeURIComponent("fullText contains 'a'")}`), 501, 'a q term that is not modelled');
  /* paging: pageSize 2 over 8 files (6 + 2 folders), every file exactly once, tokens only for the same query */
  const seen = []; let tok = '', pages = 0;
  do{
    const r = expect(await get(t, `${D}?pageSize=2&fields=nextPageToken,files(id)${tok}`), 200, 'page').json;
    assert(r.files.length <= 2 && (r.nextPageToken || r.files.length > 0), 'a page is at most pageSize'); seen.push(...r.files.map(f => f.id)); pages++;
    tok = r.nextPageToken ? '&pageToken=' + encodeURIComponent(r.nextPageToken) : '';
  }while(tok && pages < 20);
  assert(pages === 4 && new Set(seen).size === 8 && seen.length === 8, `paging with pageSize=2: ${pages} pages, ${seen.length} ids, ${new Set(seen).size} different (8 files in all)`);
  const first = expect(await get(t, `${D}?pageSize=2&fields=nextPageToken,files(id)`), 200, 'first page').json;
  expect(await get(t, `${D}?pageSize=2&q=${encodeURIComponent('trashed = false')}&pageToken=${encodeURIComponent(first.nextPageToken)}`), 400, 'a page token used with another query');
  expect(await get(t, `${D}?pageSize=0`), 400, 'pageSize 0'); expect(await get(t, `${D}?pageSize=1001`), 400, 'pageSize 1001');
  const sizes = (await get(t, `${D}?q=${encodeURIComponent(`'${folder.id}' in parents and trashed = false`)}&orderBy=name&fields=files(name,size)`)).json.files;
  assert(same(sizes.map(f => f.name), ['a.pdf', "d'e.pdf", 'c.pdf'].sort()) && sizes.every(f => f.size === String(f.name.length)), 'orderBy name and the size as a string: ' + JSON.stringify(sizes));
  assert(google.filesIn(folder.id).length === 3 && google.filesIn(folder.id, {all: true}).length === 4 && google.byProp('k', 'song').length === 3, 'filesIn / byProp');
}

/* ---------- j: two tablets, one Drive ---------- */
async function twoTabletsLoop(ctx){
  const a = await tablet(ctx, {path: 'fake-a'});
  const b = await tablet(ctx, {path: 'manifest.webmanifest', share: a.google, name: 'B'});
  try{
    assert(a.google.name === 'A' && b.google.name === 'B', 'the views carry their names');
    assert(b.google.appBase !== a.google.appBase && b.google.requests === a.google.requests && b.google.files === a.google.files && b.google.tokens === a.google.tokens, 'a view has its own address and the Drive\'s files, tokens and log');
    const bytes = chart(40000);
    const folder = await mkfolder(a);
    const made = expect(await call(a, {method: 'POST', url: `${U}?uploadType=multipart&fields=id,name`, ...multipart({name: 'from-a.pdf', parents: [folder.id], mimeType: 'application/pdf', appProperties: {k: 'pdf'}}, bytes, 'application/pdf')}), 200, 'A makes a file').json;
    /* the file made in A is there in B (with B's own token, and with A's) */
    assert((await get(b, `${D}/${made.id}?alt=media`)).sha === sha(bytes), 'B cannot download what A made');
    assert((await get(b, `${D}/${made.id}?alt=media`, {token: a.token})).sha === sha(bytes), 'a token issued to A does not work for B');
    assert((await get(a, `${D}/${made.id}?alt=media`, {token: b.token})).sha === sha(bytes), 'a token issued to B does not work for A');
    assert(same((await listAll(b, `'${folder.id}' in parents and trashed = false`)).map(f => f.name), ['from-a.pdf']), 'B\'s listing does not show A\'s file');
    /* B changes it, A sees the change */
    const up = expect(await call(b, {method: 'PATCH', url: `${U}/${made.id}?uploadType=multipart&fields=size`, ...multipart({name: 'from-b.pdf'}, Buffer.from('bb'), 'application/pdf')}), 200, 'B updates').json;
    assert(up.size === '2' && (await get(a, `${D}/${made.id}?fields=name`)).json.name === 'from-b.pdf', 'A does not see B\'s update');
    /* who asked: `by` */
    const by = n => a.google.requestsBy(n).filter(r => r.kind === 'upload' && r.method !== 'OPTIONS');
    assert(by('A').length === 1 && by('B').length === 1 && a.google.requests.every(r => r.by === 'A' || r.by === 'B') && b.google.requestsBy('B').length === a.google.requestsBy('B').length, 'requests are not tagged by the tablet that sent them: ' + JSON.stringify(a.google.requests.map(r => r.by + r.kind)));
    assert(a.google.requests.filter(r => r.kind === 'auth').map(r => r.by).join() === 'A,B', 'each sign-in is logged against its own tablet');
    /* each context is sent back to its OWN address; another context's address is refused */
    const refused = await signIn(b, a.appBase).catch(() => 'refused');
    assert(refused === 'refused' || refused == null, 'B was sent to A\'s address: ' + refused);
    await b.page.goto(b.appBase);
    /* a fault switch set through one view is seen by the other */
    b.google.quotaFull = true;
    expect(await call(a, {method: 'POST', url: `${U}?uploadType=media`, body: Buffer.from('x')}), 403, 'quota set through B, seen by A', 'storageQuotaExceeded');
    a.google.quotaFull = false;
    expect(await call(b, {method: 'POST', url: `${U}?uploadType=media`, body: Buffer.from('x')}), 200, 'quota cleared through A, seen by B');
    a.google.failNext(503, {match: e => e.kind === 'upload'});
    assert(b.google.faults.length === 1, 'a fault queued through A is not in B\'s view');
    expect(await call(b, {method: 'POST', url: `${U}?uploadType=media`, body: Buffer.from('x')}), 503, 'a fault queued through A hits B');
    assert(a.google.faults.length === 0, 'the fault was not used up');
    b.google.offline = true;
    assert((await get(a, `${D}?pageSize=1`)).error, 'offline set through B does not cut A off');
    a.google.offline = false;
    assert((await get(b, `${D}?pageSize=1`)).status === 200, 'offline cleared through A does not let B through');
    b.google.latency = 250; const t0 = Date.now(); await get(a, `${D}?pageSize=1`); b.google.latency = 0;
    assert(Date.now() - t0 >= 240, 'latency set through B does not slow A');
    b.google.exposeHeaders = b.google.exposeHeaders.filter(h => h !== 'location');
    assert((await call(a, {method: 'POST', url: `${U}?uploadType=resumable`, json: {name: 'x'}})).headers.location === undefined, 'exposeHeaders changed through B is not seen by A');
    a.google.exposeHeaders.push('location');
    assert(/upload_id/.test((await call(b, {method: 'POST', url: `${U}?uploadType=resumable`, json: {name: 'x'}})).headers.location), 'exposeHeaders changed through A is not seen by B');
    /* a resumable session opened by A can be finished by B (it is the Drive's) */
    const open = await call(a, {method: 'POST', url: `${U}?uploadType=resumable&fields=id`, json: {name: 'shared-session'}});
    expect(await call(b, {method: 'PUT', url: open.headers.location, body: Buffer.from('zz')}), 200, 'B finishes A\'s session');
    a.google.clearLog(); assert(b.google.requests.length === 0, 'clearLog on one view did not clear the shared log');
  } finally { await a.google.close(); await b.google.close(); await a.s.close(); await b.s.close(); }
}

/* ---------- k: faults, lost answers and delay apply to uploads and downloads ---------- */
async function faultLoop(t){
  const {google} = t;
  const folder = await mkfolder(t);
  const b = chart(8000);
  const up = (name = 'f.pdf') => call(t, {method: 'POST', url: `${U}?uploadType=multipart&fields=id`, ...multipart({name, parents: [folder.id]}, b, 'application/pdf')});
  const made = expect(await up('seed.pdf'), 200, 'seed').json;
  /* a fault that matches uploads: the list passes, the upload fails once, nothing is written, the retry works */
  google.failNext(503, {match: e => e.kind === 'upload'});
  expect(await get(t, `${D}?pageSize=1`), 200, 'a list is not an upload');
  expect(await get(t, `${D}/${made.id}?alt=media`), 200, 'a download is not an upload');
  const n = google.files.size;
  expect(await up(), 503, 'the matching upload', 'backendError');
  assert(google.files.size === n, 'a failed upload wrote a file');
  expect(await up('retry.pdf'), 200, 'the retry');
  /* by kind download, by method, by path */
  google.failNext(500, {match: e => e.kind === 'download'});
  expect(await get(t, `${D}/${made.id}?fields=id`), 200, 'metadata is not a download');
  expect(await get(t, `${D}/${made.id}?alt=media`), 500, 'the matching download');
  assert((await get(t, `${D}/${made.id}?alt=media`)).sha === sha(b), 'the download after the fault');
  google.failNext(429, {match: e => e.method === 'PATCH'});
  expect(await get(t, `${D}/${made.id}`), 200, 'a GET is not a PATCH');
  expect(await call(t, {method: 'PATCH', url: `${U}/${made.id}?uploadType=media`, body: b}), 429, 'a matching PATCH upload');
  google.failNext(503, {match: e => /^\/upload\//.test(e.path) && e.method === 'PUT'});
  const open = expect(await call(t, {method: 'POST', url: `${U}?uploadType=resumable`, json: {name: 'sess.pdf', parents: [folder.id]}}), 200, 'start passes the PUT fault');
  expect(await call(t, {method: 'PUT', url: open.headers.location, body: b}), 503, 'the PUT of a session');
  assert(google.filesIn(folder.id).every(f => f.name !== 'sess.pdf'), 'a failed PUT wrote a file');
  expect(await call(t, {method: 'PUT', url: open.headers.location, body: b}), 200, 'the same PUT again');
  /* lost answers: the upload IS carried out, the page sees the connection drop */
  const before = google.filesIn(folder.id).length;
  google.loseAnswerNext({match: e => e.kind === 'upload'});
  const lost = await up('lost.pdf');
  assert(lost.error, 'the page saw an answer to a lost one: ' + JSON.stringify(lost));
  assert(google.filesIn(folder.id).length === before + 1 && google.filesIn(folder.id).some(f => f.name === 'lost.pdf'), 'a lost answer should still have written the file');
  google.loseAnswerNext({match: e => e.kind === 'download'});
  assert((await get(t, `${D}/${made.id}?alt=media`)).error, 'a lost download answer reached the page');
  /* delay applies to uploads and downloads */
  google.latency = 300;
  let t0 = Date.now(); await up('slow.pdf'); assert(Date.now() - t0 >= 280, 'latency did not slow an upload');
  t0 = Date.now(); await get(t, `${D}/${made.id}?alt=media`); assert(Date.now() - t0 >= 280, 'latency did not slow a download');
  google.latency = 0;
  /* the log kinds */
  const kinds = google.requests.filter(r => r.method !== 'OPTIONS').map(r => `${r.method} ${r.kind}`);
  assert(kinds.includes('GET download') && kinds.includes('POST upload') && kinds.includes('PUT upload') && kinds.includes('PATCH upload') && kinds.includes('GET drive'), 'log kinds: ' + [...new Set(kinds)]);
  assert(google.requests.every(r => r.method !== 'OPTIONS' || r.kind === 'preflight'), 'a preflight is not logged as its own kind');   // Playwright's Chromium answers preflights itself, so there may be none to see
  assert(google.requests.filter(r => r.kind === 'upload').every(r => r.bytes === undefined || r.method !== 'POST' || r.bytes > 0), 'upload entries carry the number of bytes');
}

export const loops = [
  {name: 'sync fake a: multipart create and update through real fetches keep every byte, merge appProperties, move modifiedTime, and refuse a broken body', run: withTablet(multipartLoop)},
  {name: 'sync fake b: media (simple) uploads create and update; no or unknown uploadType is refused', run: withTablet(mediaLoop)},
  {name: 'sync fake c: resumable uploads (Location, one PUT, status query, repeat PUT, update session) hold the bytes and make the file only at the end', run: withTablet(resumableLoop)},
  {name: 'sync fake d: Location and Retry-After reach the page only when listed in exposeHeaders', run: withTablet(exposeLoop)},
  {name: 'sync fake e: appProperties limits (30, 124 bytes, strings), merge, null removes, a refused change changes nothing', run: withTablet(propsLoop)},
  {name: 'sync fake f: rename, trash, untrash, delete (a folder takes its files), and the 404s after', run: withTablet(lifecycleLoop)},
  {name: 'sync fake g: a full quota refuses every upload (and an old session) with storageQuotaExceeded and changes nothing', run: withTablet(quotaLoop)},
  {name: 'sync fake h: unknown and invisible files, bad parents, folders and docs, missing, made-up and expired tokens', run: withTablet(refusalLoop)},
  {name: 'sync fake i: listing filters (appProperties has, in parents, name, mimeType, trashed) and paging with pageSize', run: withTablet(listingLoop)},
  {name: 'sync fake j: two tablets share one Drive, one account, one set of fault switches, each its own sign-in address and by tag', run: twoTabletsLoop},
  {name: 'sync fake k: failNext, loseAnswerNext and latency match and hit uploads and downloads; the log names each kind', run: withTablet(faultLoop)},
];

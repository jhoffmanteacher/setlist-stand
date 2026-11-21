/*
 * Google Drive loops, Part 1: signing in and a test folder (nothing is synced yet). "sync 1a" .. "sync 1h".
 *
 * The app runs for real (its own storage, service worker and Content-Security-Policy). The ONE stand-in is Google's two
 * addresses at the network edge (tools/loops/fake-google.mjs): it serves the sign-in redirect and a Drive that behaves like
 * Drive (paging, 401, 403 full, 429, 5xx, CORS). Everything the app PRODUCES is read back through an independent path:
 * the sign-in address the app built is read from what the stand-in received, the token is searched for in every place it
 * must never be, the library is compared before and after, the Content-Security-Policy is read from the served file, and
 * the sources are read for where Google's addresses live. Real Google is tested by Jonathan on his tablets (the gate).
 */
import fs from 'node:fs';
import path from 'node:path';
import {assert, sleep, snapshot, normalise, diff, download, JSZip, WEBKIT} from './harness.mjs';
import {goOffline, until as untilRaw} from './site-copy.mjs';
import {importFixtures} from './share-lib.mjs';
import {installFakeGoogle} from './fake-google.mjs';

/* written here on purpose, not read from the app: the app has to agree with these */
const CLIENT_ID = '553752641676-d3mb2enmv622rpl2bjlfvqpfe7922h18.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' blob: data: https://www.googleapis.com; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const FOLDER = 'application/vnd.google-apps.folder';
const toGoogle = u => /^https:\/\/(accounts\.google\.com|www\.googleapis\.com)([/?#]|$)/.test(u);
const until = (fn, what, ms, step) => untilRaw(async () => fn(), what, ms, step);      // site-copy's until() wants a promise from fn

async function open(ctx, {fixtures = false} = {}){
  /* Playwright's WebKit cannot intercept a request made by a page that a service worker controls: it goes to the real Google
     (which answers 401 to the stand-in's token). In WebKit the worker is switched off for these loops; Chromium keeps it. */
  const s = await ctx.session({serviceWorkers: process.env.SS_BROWSER === 'webkit' ? 'block' : 'allow'});
  const google = await installFakeGoogle(s.context, {appBase: ctx.base});
  s.navs = [];
  s.page.on('framenavigated', f => { if(f === s.page.mainFrame()) s.navs.push(f.url()); });
  await s.goto('');
  if(fixtures) await importFixtures(s.page);
  return {s, page: s.page, google, base: ctx.base};
}
const ls = page => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])));
const dialogText = async page => (await page.locator('.modal [role=dialog]').first().textContent()).replace(/\s+/g, ' ').trim();
const noModal = page => page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 8000});
async function closeDialog(page){ await page.click('.modal [data-x]'); await noModal(page); }
/* the page is loaded again after a trip to Google: wait for the Library's Drive line */
const settled = (page, what = 'the Library did not come back') => until(() => page.evaluate(() => document.readyState === 'complete' && !!document.querySelector('#libDrive [data-drivestatus]')), what, 15000);
const authCount = g => g.requests.filter(r => r.kind === 'auth').length;
const driveCalls = g => g.requests.filter(r => r.kind === 'drive');
const pageErrors = s => s.errors.filter(e => e.startsWith('pageerror'));
const problems = async page => JSON.parse((await ls(page))['ss-problems'] || '[]');

/* Taps Connect (or Connect again in an open dialog), goes to the stand-in, comes back; returns once the Library is drawn. */
async function trip(h, auth = {}){
  const {page, google} = h;
  Object.assign(google.auth, {mode: 'ok', errorCode: 'server_error', expiresIn: 3599}, auth);
  const n0 = authCount(google);
  if(!(await page.locator('.modal').count())) await page.click('[data-driveconnect]');
  await page.click('.modal [data-ok]');
  await until(() => authCount(google) > n0, 'the app never went to the sign-in address', 15000);
  await sleep(300);
  await settled(page);
}
const connectOk = async h => { await trip(h); assert(/Connected to Google Drive until/.test(await h.page.locator('#libDrive').textContent()), 'not connected after a good sign-in: ' + await h.page.locator('#libDrive').textContent()); };
async function runTest(page){
  await page.click('[data-drivetest]');
  const t = await until(async () => { const x = await dialogText(page).catch(() => null); return x && !/^Testing the connection/.test(x) ? x : null; }, 'the test never gave a result', 20000);
  await closeDialog(page);
  return t;
}

/* ---------- 1a: Connect from a clean library ---------- */
async function loopConnect(ctx){
  const h = await open(ctx, {fixtures: true}), {s, page, google} = h;
  try{
    assert(google.requests.length === 0, 'the app talked to Google before any button was tapped');
    await page.click('#libList [data-open]'); await page.waitForSelector('body.playing');
    await sleep(500);
    assert(google.requests.length === 0, 'the app talked to Google while a song was open');
    await page.click('#vBack'); await page.waitForFunction(() => !document.body.classList.contains('playing'));
    const before = normalise(await snapshot(page));
    assert(/Connect Google Drive/.test(await page.locator('#libDrive').textContent()), 'no Connect button on a clean library');

    /* Cancel and Escape leave nothing behind and do not leave the app */
    await page.click('[data-driveconnect]');
    assert(/can see only the files it makes itself/.test(await dialogText(page)), 'the Connect dialog does not explain what Google will ask');
    await closeDialog(page);
    await page.click('[data-driveconnect]'); await page.keyboard.press('Escape'); await noModal(page);
    assert(!('ss-google-pending' in await ls(page)) && google.requests.length === 0, 'Cancel left a note or went to Google');
    /* Cancel AFTER Continue, while Google is slow to answer: the trip must really stop (window.stop), or Google's page replaces the app a moment later */
    const slow = async r => { await sleep(1500); await r.fallback().catch(() => {}); };
    await s.context.route('https://accounts.google.com/**', slow);
    await page.evaluate(() => { window.__stayed = true; });                              // a marker: a page that was left and reloaded loses it
    const navs = s.navs.length;
    await page.click('[data-driveconnect]');
    /* Continue, then Cancel 300 ms later, both scheduled inside the page: while a navigation is pending, Playwright holds back any
       call of its own (click, evaluate) until the navigation is over, which a real finger does not have to wait for */
    await page.evaluate(() => {
      const ok = document.querySelector('.modal [data-ok]'); ok.focus(); ok.click();                 // a finger on Continue
      setTimeout(() => { window.__focusKept = !!document.activeElement && !!document.activeElement.closest('.modal'); document.querySelector('.modal [data-x]').click(); }, 300);
    });
    await sleep(3000);
    let wentAnyway = false;
    if(process.env.SS_BROWSER === 'webkit'){
      /* Safari's engine (as driven by Playwright) does not always stop a navigation that is still waiting for Google's first byte
         (window.stop() is not honoured once the request is held): the page may go to Google and come back with the answer. That
         is not a safe stop of the trip, so it is reported as a known difference, but what MUST hold is still checked: the answer
         that comes back is refused (the note was dropped by Cancel), nothing is kept, and the person is told so. */
      wentAnyway = await until(async () => { const r = await page.evaluate(() => ({kept: window.__stayed === true, modal: !!document.querySelector('.modal')})).catch(() => null); return r && !r.kept ? 'gone' : r && !r.modal ? 'stayed' : null; }, 'the page neither stayed nor came back', 15000) === 'gone';
      if(wentAnyway){
        await until(async () => /did not come from a sign-in started in this window/.test(await dialogText(page).catch(() => '')), 'the answer to a cancelled sign-in was not turned away in plain words', 15000);
        await closeDialog(page);
      }
    }
    await noModal(page);
    const left = await ls(page);
    if(!wentAnyway){
      assert(await page.evaluate(() => window.__focusKept === true), 'Continue switched itself off and dropped focus to the page behind, so Escape would no longer reach the dialog');
      const stayed = await page.evaluate(() => window.__stayed === true);
      assert(stayed && s.navs.length === navs && !('ss-google' in left) && !('ss-google-pending' in left), `Cancel after Continue did not stop the trip: page kept=${stayed}, navigations=${s.navs.length - navs}, token=${'ss-google' in left}, note=${'ss-google-pending' in left}`);
    }else{
      assert(!('ss-google' in left) && !('ss-google-pending' in left), `a cancelled sign-in's answer was kept: token=${'ss-google' in left}, note=${'ss-google-pending' in left}`);
      console.log('    note: in this browser engine Cancel after Continue did not stop the page going to Google; the answer was refused and nothing was kept');
    }
    await s.context.unroute('https://accounts.google.com/**', slow);

    /* the trip itself */
    await trip(h);
    const a = google.requests.find(r => r.kind === 'auth'), q = a.query;
    assert(a.path === new URL(AUTH).pathname && a.method === 'GET', `the app went to ${a.method} ${a.path}, not ${AUTH}`);
    assert(JSON.stringify(Object.keys(q).sort()) === JSON.stringify(['client_id', 'redirect_uri', 'response_type', 'scope', 'state']), 'the sign-in address carries ' + Object.keys(q).join(','));
    assert(q.client_id === CLIENT_ID, 'client_id ' + q.client_id);
    assert(q.redirect_uri === h.base, `redirect_uri ${q.redirect_uri} is not the app's own start address ${h.base}`);
    assert(q.response_type === 'token' && q.scope === SCOPE, `response_type ${q.response_type}, scope ${q.scope}`);
    assert(/^[0-9a-f]{32}$/.test(q.state), 'state is not a long random value: ' + q.state);
    assert(a.status === 302 && !a.authError, 'the stand-in refused the sign-in: ' + a.authError);
    assert(s.navs.some(u => u.includes('#access_token=')), 'the stand-in never delivered a token in the address (the test proves nothing)');
    const where = await page.evaluate(() => ({hash: location.hash, href: location.href}));
    assert(where.hash === '' && !/access_token/.test(where.href), 'the address still holds the answer: ' + where.href);
    if(!WEBKIT){
      const cdp = await page.context().newCDPSession(page);
      const hist = await cdp.send('Page.getNavigationHistory'); await cdp.detach();
      for(const e of hist.entries) assert(!/access_token/.test(e.url) && !e.url.includes('#'), 'the history keeps the answer: ' + e.url);
    }
    const kept = await ls(page), tok = google.issued.at(-1), saved = JSON.parse(kept['ss-google']);
    assert(saved.token === tok && Math.abs(saved.exp - (Date.now() + 3599e3)) < 120e3, 'the stored token or its end time is wrong');
    assert(!('ss-google-pending' in kept), 'the one-time note was left behind');
    assert(/Connected to Google Drive until/.test(await page.locator('#libDrive').textContent()), 'the Library does not say connected');
    assert(driveCalls(google).length === 0, 'Drive was called before Test connection was tapped');
    const after = normalise(await snapshot(page));
    assert(!diff(before, after).length, 'signing in changed the library: ' + diff(before, after).join(' | '));

    /* still connected after a reload (a closed and reopened app) */
    await page.reload(); await settled(page); await sleep(400);
    assert(/Connected to Google Drive until/.test(await page.locator('#libDrive').textContent()), 'connected state lost on reload');
    assert(driveCalls(google).length === 0, 'Drive was called by opening the app (only a button may do that)');

    /* the test, then the token is searched for everywhere it must never be */
    assert(/Connected\. Folder 'Setlist Stand' is ready \(0 files\)/.test(await runTest(page)), 'the test connection result');
    const calls = driveCalls(google);
    assert(calls.length >= 2 && calls.every(c => c.authorization === 'Bearer ' + tok && !c.tokenInUrl), 'a Drive call lacked the Authorization header, or put the token in the address');
    assert(google.requests.every(r => !r.tokenInUrl), 'the token was sent in an address');
    assert(s.requests.every(u => !u.includes(tok)), 'the token is in a requested address');
    const stores = await page.evaluate(() => ({ls: Object.entries(localStorage).filter(([k]) => k !== 'ss-google').map(([, v]) => v), ss: Object.keys(sessionStorage).map(k => sessionStorage.getItem(k)), dom: document.documentElement.outerHTML}));
    assert(![...stores.ls, ...stores.ss, stores.dom].some(v => String(v).includes(tok)), 'the token is stored or shown somewhere other than ss-google');
    assert(!JSON.stringify(await snapshot(page)).includes(tok), 'the token is in the library database');
    const bk = await download(page, () => page.click('[data-backup]'));
    const zip = await JSZip.loadAsync(fs.readFileSync(bk.file));
    for(const n of Object.keys(zip.files)) if(!zip.files[n].dir) assert(!Buffer.from(await zip.file(n).async('uint8array')).includes(Buffer.from(tok)), `the token is in the backup (${n})`);
    assert(!(await problems(page)).length, 'the problem log has entries after a clean sign-in: ' + JSON.stringify(await problems(page)));
    assert(pageErrors(s).length === 0 && s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    /* every request went to the app, the sign-in address or the Drive address, nowhere else */
    const origins = new Set(s.requests.filter(u => /^https?:/.test(u)).map(u => new URL(u).origin));
    for(const o of origins) assert([new URL(h.base).origin, 'https://accounts.google.com', 'https://www.googleapis.com'].includes(o), 'a request went to ' + o);
  } finally { await s.close(); }
}

/* ---------- 1b: a sign-in that is refused changes nothing ---------- */
const REFUSED = [
  {name: 'denied', auth: {mode: 'denied'}, text: /did not allow access/},
  {name: 'error', auth: {mode: 'error', errorCode: 'server_error'}, text: /could not sign you in \(server_error\)/},
  {name: 'wrong state', auth: {mode: 'wrong-state'}, text: /did not match the sign-in started here/},
  {name: 'no state', auth: {mode: 'no-state'}, text: /did not match the sign-in started here/},
  {name: 'permission not given', auth: {mode: 'no-scope'}, text: /did not give this app permission/},
  {name: 'ends at once', auth: {mode: 'ok', expiresIn: 45}, text: /ends right away/},
  {name: 'ends in a year', auth: {mode: 'ok', expiresIn: 31536000}, text: /not what the app expected/},
];
async function loopRefused(ctx){
  const h = await open(ctx, {fixtures: true}), {s, page, google} = h;
  try{
    const before = normalise(await snapshot(page));
    for(const r of REFUSED){
      await trip(h, r.auth);
      await until(() => page.locator('.modal [role=dialog]').count(), `${r.name}: nothing was said (was the sign-in accepted?)`, 4000);
      const text = await dialogText(page);
      assert(r.text.test(text) && /Nothing was changed/.test(text), `${r.name}: the message is "${text}"`);
      assert(!/Error|undefined|\bat\b.*\.js/.test(text), `${r.name}: the message looks technical: ${text}`);
      await closeDialog(page);
      const kept = await ls(page);
      assert(!('ss-google' in kept) && !('ss-google-pending' in kept), `${r.name}: something was kept: ${Object.keys(kept)}`);
      assert(await page.evaluate(() => location.hash === ''), `${r.name}: the answer is still in the address`);
      assert(/Connect Google Drive/.test(await page.locator('#libDrive').textContent()), `${r.name}: the Library does not offer Connect`);
      const after = normalise(await snapshot(page));
      assert(!diff(before, after).length, `${r.name}: the library changed: ` + diff(before, after).join(' | '));
    }
    assert(driveCalls(google).length === 0, 'a refused sign-in went on to call Drive');
    const states = google.requests.filter(r => r.kind === 'auth').map(r => r.query.state);
    assert(states.length >= REFUSED.length && new Set(states).size === states.length, 'two sign-in trips used the same state: ' + states.join(' '));

    /* an answer with no trip behind it: nothing started here (no note), an old note, a replayed answer */
    const tokenAnswer = state => `#access_token=ya29.${'x'.repeat(60)}&token_type=Bearer&expires_in=3599&scope=${encodeURIComponent(SCOPE)}&state=${state}`;
    const arrive = async (hash, setup) => {
      await page.goto('about:blank');
      if(setup) await setup();
      await page.goto(h.base + hash);
      await settled(page);
    };
    await arrive(tokenAnswer('0123456789abcdef0123456789abcdef'));
    const fm = await dialogText(page);
    assert(/did not come from a sign-in started in this window/.test(fm) && /This window is the browser, not the installed app/.test(fm), 'an answer with no sign-in behind it was not turned away, or does not say which window this is: ' + fm);
    await closeDialog(page);
    /* the iPad's Home Screen app says so through navigator.standalone: the message must name it as the installed app */
    await s.context.addInitScript(() => { Object.defineProperty(navigator, 'standalone', {get: () => true, configurable: true}); });
    await arrive(tokenAnswer('0123456789abcdef0123456789abcdef'));
    assert(/This window is the installed app/.test(await dialogText(page)), 'in the Home Screen app the message does not say it is the installed app: ' + await dialogText(page));
    await closeDialog(page);
    assert(!('ss-google' in await ls(page)) && await page.evaluate(() => location.hash === ''), 'a foreign answer was kept, or left in the address');
    const old = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await page.goto(h.base);
    await page.evaluate(([old, t]) => localStorage.setItem('ss-google-pending', JSON.stringify({state: old, t, then: 'connect'})), [old, Date.now() - 16 * 60e3]);
    await arrive(tokenAnswer(old));
    assert(/took more than 15 minutes/.test(await dialogText(page)) && !('ss-google' in await ls(page)) && !('ss-google-pending' in await ls(page)), 'an answer to a sign-in started 16 minutes ago was accepted, said the wrong thing, or its note was kept');
    await closeDialog(page);
    /* a note that never got an answer does not linger for ever */
    await page.evaluate(([old, t]) => localStorage.setItem('ss-google-pending', JSON.stringify({state: old, t, then: 'connect'})), [old, Date.now() - 16 * 60e3]);
    await page.reload(); await settled(page);
    assert(!('ss-google-pending' in await ls(page)), 'an old note was kept');
    /* a good trip, then the same answer replayed: refused, and the token already kept is untouched */
    await trip(h);
    const good = await ls(page), fragment = s.navs.filter(u => u.includes('#access_token=')).at(-1).slice(h.base.length);
    await arrive(fragment);
    assert(/did not come from a sign-in started in this window/.test(await dialogText(page)), 'a replayed answer was accepted');
    await closeDialog(page);
    assert((await ls(page))['ss-google'] === good['ss-google'], 'a replayed answer changed the stored token');
    assert(pageErrors(s).length === 0, 'page errors: ' + s.errors.join(' | '));

    /* the trip that gets no answer at all: the note stays (the person may still be at Google), nothing else happens */
    await page.evaluate(() => localStorage.removeItem('ss-google'));
    await page.reload(); await settled(page);                                          // the Library is drawn again, with its Connect button
    assert(await page.locator('[data-driveconnect]').count() === 1, 'no Connect button after the token was removed');
    await trip(h, {mode: 'nothing'});
    const quiet = await ls(page);
    assert(!('ss-google' in quiet) && !(await page.locator('.modal').count()), 'a sign-in with no answer connected or complained');
    assert('ss-google-pending' in quiet, 'the note of a trip that is only a minute old was dropped (the person may still be at Google)');
    /* Back from Google with the Back button (the page comes back from the browser's cache; Playwright's Chromium switches that cache off,
       so the event is sent by hand): that trip was abandoned, and the open Connect dialog can be used again */
    await page.evaluate(() => { localStorage.setItem('ss-google-pending', JSON.stringify({state: 'b'.repeat(32), t: Date.now(), then: 'connect'})); });
    await page.click('[data-driveconnect]');
    await page.evaluate(() => { const ok = document.querySelector('.modal [data-ok]'); ok.disabled = true; });   // what Continue does while the page is leaving
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true})));
    assert(!('ss-google-pending' in await ls(page)), 'coming back with the Back button kept the note of the abandoned trip');
    assert(await page.evaluate(() => !document.querySelector('.modal [data-ok]').disabled), 'coming back with the Back button left Continue switched off');
    await closeDialog(page);
  } finally { await s.close(); }
}

/* ---------- 1c: a token that is ending is not used; Connect again carries on with the test ---------- */
async function loopTokenLife(ctx){
  const h = await open(ctx), {s, page, google} = h;
  try{
    await trip(h, {expiresIn: 75});                       // good for a little over a minute
    assert(/Connected to Google Drive until/.test(await page.locator('#libDrive').textContent()), 'a token with 75 seconds left was not accepted');
    await page.evaluate(() => { const t = JSON.parse(localStorage.getItem('ss-google')); t.exp = Date.now() + 30e3; localStorage.setItem('ss-google', JSON.stringify(t)); });
    await page.reload(); await settled(page);
    assert(/ran out.*Tap Connect again/.test(await page.locator('#libDrive').textContent()), 'an ending token is still shown as connected: ' + await page.locator('#libDrive').textContent());
    google.clearLog();
    await page.click('[data-drivetest]');
    const text = await dialogText(page);
    assert(/Your Google sign-in has run out\. Tap Connect again/.test(text), 'Test connection with an ending token: ' + text);
    assert(google.requests.length === 0, 'an ending token was used for a request');
    /* Connect again from this dialog: the test the person asked for runs by itself when they are back */
    await trip(h);
    const res = await until(async () => { const x = await dialogText(page).catch(() => null); return x && /Connected\./.test(x) ? x : null; }, 'the test did not carry on after signing in again', 20000);
    assert(/Folder 'Setlist Stand' is ready/.test(res), res);
    await closeDialog(page);
    assert(pageErrors(s).length === 0, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- 1d: the folder is made once and found again; every page of a listing is read ---------- */
async function loopFolder(ctx){
  const h = await open(ctx), {s, page, google} = h;
  let made;
  try{
    await connectOk(h);
    assert(/is ready \(0 files\)\. The folder was just made/.test(await runTest(page)), 'first test');
    made = google.folders('Setlist Stand');
    assert(made.length === 1 && made[0].mimeType === FOLDER && Object.keys(made[0].appProperties).length > 0, 'the first test did not make exactly one marked folder: ' + JSON.stringify(made));
    const t2 = await runTest(page);
    assert(/is ready \(0 files\)/.test(t2) && !/just made/.test(t2), 'second test: ' + t2);
    assert(google.folders('Setlist Stand').length === 1, 'the second test made a second folder');
    assert(google.requests.filter(r => r.method === 'POST').length === 1, 'folders created: ' + google.requests.filter(r => r.method === 'POST').length);
    const queries = driveCalls(google).filter(r => r.method === 'GET').map(r => r.query.q || '');
    const folderQ = queries.find(x => /name = /.test(x)) || '', listQ = queries.find(x => /in parents/.test(x)) || '';
    for(const part of ["name = 'Setlist Stand'", `mimeType = '${FOLDER}'`, 'trashed = false', 'appProperties has']) assert(folderQ.includes(part), `the query that finds the folder lacks "${part}": ${folderQ}`);
    assert(listQ.includes('trashed = false'), 'the listing of the folder counts trashed files: ' + listQ);
    /* 250 files, Drive answers 100 at a time: all three pages are read */
    for(let i = 0; i < 250; i++) google.addFile({name: `f${i}.json`, mimeType: 'application/json', parents: [made[0].id]});
    google.maxPage = 100; google.clearLog();
    assert(/is ready \(250 files\)/.test(await runTest(page)), 'a listing in several pages was cut short');
    const pages = driveCalls(google).filter(r => /in parents/.test(r.query.q || ''));
    assert(pages.length === 3 && pages.filter(r => r.query.pageToken).length === 2, `the listing took ${pages.length} requests`);
    assert(pages.every(r => /nextPageToken/.test(r.query.fields || '') && /files\(/.test(r.query.fields || '')), 'the app does not ask Drive for the fields it needs (Drive would send only id and name)');
    assert(pageErrors(s).length === 0, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }

  /* another tablet's folder is found, not copied; the oldest of two wins; a look-alike without the mark is ignored */
  const o = await open(ctx), g = o.google;
  try{
    const mk = (created, props = made[0].appProperties) => { const id = g.addFile({name: 'Setlist Stand', mimeType: FOLDER, appProperties: props}); g.files.get(id).createdTime = created; return id; };
    const newer = mk('2026-03-02T10:00:00.000Z'), older = mk('2026-03-01T10:00:00.000Z'), alike = mk('2026-01-01T10:00:00.000Z', {});
    const gone = mk('2026-01-02T10:00:00.000Z'); g.files.get(gone).trashed = true;                 // the oldest marked folder, but in the Drive trash
    const notDir = g.addFile({name: 'Setlist Stand', mimeType: 'application/json', appProperties: made[0].appProperties}); g.files.get(notDir).createdTime = '2026-01-03T10:00:00.000Z';   // marked, oldest, not a folder
    g.addFile({name: 'chart.pdf', mimeType: 'application/pdf', parents: [older]});
    await connectOk(o);
    assert(/is ready \(1 file\)/.test(await runTest(o.page)), 'the other tablet\'s folder was not used');
    assert(!g.requests.some(r => r.method === 'POST'), 'a second folder was made although one was there');
    assert(driveCalls(g).some(r => (r.query.q || '').includes(`'${older}' in parents`)) && ![newer, alike, gone, notDir].some(id => driveCalls(g).some(r => (r.query.q || '').includes(`'${id}' in parents`))), 'not the oldest marked, live folder');
  } finally { await o.s.close(); }
  const p = await open(ctx), g2 = p.google;
  try{
    const only = g2.addFile({name: 'Setlist Stand', mimeType: FOLDER});            // a look-alike with no mark
    await connectOk(p);
    const said = await runTest(p.page), now = g2.folders('Setlist Stand');
    assert(/just made/.test(said), 'a look-alike folder without the mark was used instead of making the app\'s own: ' + said);
    assert(now.length === 2 && driveCalls(g2).some(r => r.method === 'POST'), `the look-alike was not left alone and a marked folder made (${now.length} folders)`);
    assert(driveCalls(g2).filter(r => (r.query.q || '').includes('in parents')).every(r => !(r.query.q || '').includes(`'${only}' in parents`)), 'the look-alike folder was listed');
  } finally { await p.s.close(); }
}

/* ---------- 1e: failures are said plainly, and change nothing ---------- */
async function loopFailures(ctx){
  const h = await open(ctx, {fixtures: true}), {s, page, google} = h;
  const say = async () => { const t = await runTest(page); return t; };
  try{
    await page.evaluate(async () => { (await import('./js/drive.js')).tuning.pauseMs = 5; });
    await connectOk(h);
    const before = normalise(await snapshot(page));
    const plain = (t, re, what) => { assert(re.test(t) && /Nothing was changed/.test(t) && !/Error|undefined|status|\b\d{3}\b/.test(t.replace(/Folder.*?\)/, '')), `${what}: "${t}"`); };
    const stillConnected = async what => assert((await ls(page))['ss-google'], what + ': the sign-in was forgotten');

    /* offline: the app does not even try */
    google.clearLog(); await s.context.setOffline(true);
    const asked = s.requests.length;
    plain(await say(), /Cannot reach Google/, 'offline');
    assert(google.requests.length === 0 && !s.requests.slice(asked).some(toGoogle), 'offline: a request was sent');
    /* Connect while offline must not leave the app (the tablet would be stranded on an error page) */
    const url = page.url(); await page.evaluate(() => { const t = JSON.parse(localStorage.getItem('ss-google')); t.exp = Date.now() - 1000; localStorage.setItem('ss-google', JSON.stringify(t)); });
    await page.reload().catch(() => {}); await s.context.setOffline(false); await page.reload(); await settled(page); await s.context.setOffline(true);
    await page.click('[data-driveconnect]'); await page.click('.modal [data-ok]');
    await until(async () => /You are offline/.test(await dialogText(page).catch(() => '')), 'Connect while offline did not say so', 10000);
    assert(page.url() === url && authCount(google) === 0 && !('ss-google-pending' in await ls(page)), 'Connect while offline left the app or left a note');
    await closeDialog(page); await s.context.setOffline(false);
    await trip(h);                                                  // back to a good sign-in for the cases below
    await page.waitForSelector('#libDrive [data-drivetest]');
    /* online but Google unreachable */
    google.clearLog(); google.offline = true; plain(await say(), /Cannot reach Google/, 'unreachable'); google.offline = false;
    assert(google.requests.filter(r => r.status === 'aborted').length >= 2, 'a request that got no answer was not tried again before giving up');
    await stillConnected('offline');
    /* Drive full */
    google.quotaFull = true; plain(await say(), /Drive is full/, 'full'); google.quotaFull = false;
    assert(google.folders('Setlist Stand').length === 0, 'a failed folder creation left a folder');
    /* the Drive API switched off for the project */
    google.apiEnabled = false; plain(await say(), /not switched on/, 'api off'); google.apiEnabled = true;
    const log = await problems(page);
    assert(log.some(e => /Drive off 403 accessNotConfigured/.test(e.msg)), 'the failure is not in the problem log: ' + JSON.stringify(log));
    /* busy: two 429s then success; then more 503s than the retries allow */
    google.clearLog(); google.failNext(429, {times: 2});
    assert(/Connected\./.test(await say()), 'two 429s then success did not end in success');
    assert(google.requests.filter(r => r.status === 429).length === 2, 'the 429s were not retried');
    google.clearLog(); google.failNext(503, {times: 40});
    plain(await say(), /Google is busy/, 'busy');
    const tries = google.requests.filter(r => r.status === 503).length;
    assert(tries >= 2 && tries <= 6, `a busy Google was tried ${tries} times`);
    google.faults.length = 0;
    /* the rate limit that Drive sends as a 403 is waited out like a 429; a refused permission is not retried */
    google.clearLog(); google.failNext(403, {reason: 'userRateLimitExceeded', times: 2});
    assert(/Connected\./.test(await say()) && google.requests.filter(r => r.status === 403).length === 2, 'a 403 rate limit was not waited out');
    google.clearLog(); google.failNext(403, {reason: 'insufficientPermissions', times: 5});
    plain(await say(), /did not give this app permission/, 'permission');
    assert(google.requests.filter(r => r.status === 403).length === 1, 'a refused permission was retried');
    google.faults.length = 0;
    assert(!!(await problems(page)).some(e => /Drive denied 403 insufficientPermissions/.test(e.msg)), 'a refused permission is not in the problem log');
    /* Retry-After: Google's own wait is honoured (the app's pause is a few milliseconds here, so only Retry-After can take a second) */
    google.exposeHeaders.push('retry-after'); google.clearLog(); google.failNext(429, {retryAfter: 1});
    const t0 = Date.now(); assert(/Connected\./.test(await say()), 'a 429 with Retry-After did not end in success');
    assert(Date.now() - t0 >= 900, `Retry-After: 1 was not waited for (${Date.now() - t0} ms)`);
    /* an HTML error page instead of JSON (a proxy, a 502): still "busy", never a stack trace */
    google.clearLog(); google.failNext(502, {times: 8, body: Buffer.from('<html><h1>Bad Gateway</h1></html>')});
    plain(await say(), /Google is busy/, 'an HTML 502'); google.faults.length = 0;
    /* a listing whose next-page token never changes is a broken answer, not an endless wait */
    google.clearLog(); google.failNext(200, {times: 10, match: r => /in parents/.test(r.query.q || ''), body: {files: [], nextPageToken: 'same'}});
    plain(await say(), /did not answer the way the app expected/, 'a repeating page token');
    assert(driveCalls(google).filter(r => /in parents/.test(r.query.q || '')).length <= 3, 'a repeating page token was followed more than twice'); google.faults.length = 0;
    /* a Google that answers with rubbish */
    google.failNext(400, {times: 1, body: Buffer.from('<html>oops</html>')});
    plain(await say(), /did not answer the way the app expected/, 'unexpected');
    /* nothing above wrote a token anywhere it must not, or changed the library */
    const tok = google.issued.at(-1);
    assert(!JSON.stringify(await problems(page)).includes(tok), 'the token is in the problem log');
    assert(!(await page.locator('#toast').textContent()).includes(tok), 'the token is in a toast');
    const after = normalise(await snapshot(page));
    assert(!diff(before, after).length, 'failures changed the library: ' + diff(before, after).join(' | '));
    await stillConnected('failures');

    /* Cancel while Google is slow: no result, no error, the page is fine */
    const logged = (await problems(page)).length;
    google.latency = 1500; google.clearLog();
    await page.click('[data-drivetest]');
    await until(() => driveCalls(google).length >= 1, 'the test sent no request', 8000);
    const sent = driveCalls(google).length;
    await page.click('.modal [data-x]'); await noModal(page);
    await sleep(2400);
    assert(!(await page.locator('.modal').count()) && (await problems(page)).length === logged, 'Cancel was followed by a result or an error');
    assert(driveCalls(google).length === sent && !google.requests.some(r => r.method === 'POST'), `Cancel did not stop the work: ${driveCalls(google).length - sent} more request(s) after it`);
    google.latency = 0;

    /* Google takes the token back: the app says so and forgets it. Cancel leaves focus on the Library line (the button that was
       tapped is gone, redrawn as Connect), not on the page behind */
    google.expire();
    await page.click('[data-drivetest]');
    await until(async () => /Sign in again/.test(await dialogText(page).catch(() => '')), 'a refused token did not ask to sign in again', 15000);
    assert(!('ss-google' in await ls(page)), 'a token Google refused is still kept');
    await closeDialog(page);
    assert(await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('#libDrive')), 'after Cancel on "Sign in again" focus is not in the Drive line');
    /* and Connect again carries on with the test */
    await trip(h); google.expire(); await page.click('[data-drivetest]');
    await until(async () => /Sign in again/.test(await dialogText(page).catch(() => '')), 'a second refused token did not ask to sign in again', 15000);
    await trip(h);
    assert(await until(async () => { const x = await dialogText(page).catch(() => null); return x && /Connected\./.test(x) ? x : null; }, 'no test after signing in again', 20000));
    await closeDialog(page);

    /* the folder IS made, but the answer is lost on the way back: the app must not send the creation again (that would make a
       second folder), and the next test finds the one that was made */
    for(const f of google.folders('Setlist Stand')) google.files.delete(f.id);
    const posts = () => google.requests.filter(r => r.method === 'POST').length;
    google.clearLog(); google.loseAnswerNext({match: r => r.method === 'POST'});
    plain(await say(), /Cannot reach Google/, 'a lost answer');
    assert(posts() === 1, `a folder creation whose answer was lost was sent ${posts()} times`);
    assert(google.folders('Setlist Stand').length === 1, `${google.folders('Setlist Stand').length} folders after a lost answer`);
    assert(/Connected\./.test(await say()) && google.folders('Setlist Stand').length === 1 && posts() === 1, 'the next test made another folder instead of finding the one that was made');
    assert(pageErrors(s).length === 0, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- 1f: Disconnect ---------- */
async function loopDisconnect(ctx){
  const h = await open(ctx, {fixtures: true}), {s, page, google} = h;
  try{
    await connectOk(h);
    const before = normalise(await snapshot(page)), n = google.requests.length;
    await page.click('[data-drivedisconnect]');
    assert(/forgets the sign-in/.test(await dialogText(page)) && /not touched/.test(await dialogText(page)), 'the Disconnect dialog does not say what happens');
    await closeDialog(page);
    assert((await ls(page))['ss-google'], 'Cancel disconnected');
    await page.click('[data-drivedisconnect]'); await page.keyboard.press('Escape'); await noModal(page);
    assert((await ls(page))['ss-google'], 'Escape disconnected');
    await page.click('[data-drivedisconnect]'); await page.click('.modal [data-ok]'); await noModal(page);
    const kept = await ls(page);
    assert(!('ss-google' in kept) && !('ss-google-pending' in kept), 'Disconnect left the sign-in: ' + Object.keys(kept));
    assert(/Connect Google Drive/.test(await page.locator('#libDrive').textContent()), 'the Library does not offer Connect after Disconnect');
    assert(google.requests.length === n, 'Disconnect called Google (it must only forget the sign-in here)');
    await page.reload(); await settled(page);
    assert(/Connect Google Drive/.test(await page.locator('#libDrive').textContent()), 'disconnected state lost on reload');
    const after = normalise(await snapshot(page));
    assert(!diff(before, after).length, 'Disconnect changed the library: ' + diff(before, after).join(' | '));
    assert(pageErrors(s).length === 0, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- 1g: the Content-Security-Policy and where Google's addresses live ---------- */
async function loopCsp(ctx){
  const h = await open(ctx), {s, page} = h;
  try{
    const served = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content);
    assert(served === POLICY, 'the Content-Security-Policy is not the agreed one:\n  served  ' + served + '\n  agreed  ' + POLICY);
    const cs = served.split(';').map(x => x.trim()).find(x => x.startsWith('connect-src'));
    assert(cs === "connect-src 'self' blob: data: https://www.googleapis.com", 'connect-src is ' + cs);
    /* the browser really enforces it: Drive's address is allowed, the sign-in address and any other host are not */
    const tryFetch = url => page.evaluate(async url => {
      let blocked = false; const on = e => { blocked = true; };
      document.addEventListener('securitypolicyviolation', on);
      try{ await fetch(url, {mode: 'no-cors'}); }catch(e){}
      await new Promise(r => setTimeout(r, 100)); document.removeEventListener('securitypolicyviolation', on); return blocked;
    }, url);
    assert(await tryFetch('https://example.com/x') === true, 'a request to another host was not blocked by the policy');
    assert(await tryFetch('https://accounts.google.com/o/oauth2/v2/auth') === true, 'a data request to the sign-in address was not blocked');
    assert(await tryFetch('https://www.googleapis.com/drive/v3/about') === false, 'a request to Drive was blocked by the policy');
    /* the sources: Google's addresses live in js/driveconfig.js only; no client secret; the worker never touches Google */
    const root = ctx.root, files = [...fs.readdirSync(path.join(root, 'js')).map(f => 'js/' + f), 'sw.js', 'css/app.css', 'manifest.webmanifest'];
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
    const text = f => f === 'index.html' ? html : fs.readFileSync(path.join(root, f), 'utf8');
    for(const f of [...files, 'index.html']){
      if(f === 'js/driveconfig.js') continue;
      const t = text(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert(!/googleapis\.com|accounts\.google\.com|googleusercontent\.com|553752641676/.test(t), `${f} holds a Google address or the Client ID (they live in js/driveconfig.js only)`);
    }
    const SECRET = new RegExp(['client' + '_secret', 'GOCSPX' + '-'].join('|'));       // built in pieces so this file does not trip the repo check for the same words
    for(const f of [...files, 'index.html']) assert(!SECRET.test(text(f)), `${f} mentions a client secret`);
    assert(/new URL\(req\.url\)\.origin !== self\.location\.origin\) return;/.test(fs.readFileSync(path.join(root, 'sw.js'), 'utf8')), 'the service worker no longer ignores other hosts');
    assert(pageErrors(s).length === 0, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- 1h: never touched, and offline, the app is exactly as before ---------- */
async function loopOffline(ctx){
  const h = await open(ctx, {fixtures: true}), {s, page, google} = h;
  try{
    await s.swReady();
    await page.click('#libList [data-open]'); await page.waitForSelector('body.playing');
    await page.click('#vBack'); await page.waitForFunction(() => !document.body.classList.contains('playing'));
    assert(google.requests.length === 0 && !s.requests.some(toGoogle), 'a library that never touched Connect still talked to Google');
    /* connected, then offline with the stand-in switched off: the app opens, plays, and says nothing to Google */
    await connectOk(h);
    await s.swReady();
    await google.close();
    const back = await goOffline(s.context, ctx.server);
    try{
      await page.reload(); await settled(page);
      assert(/Connected to Google Drive until/.test(await page.locator('#libDrive').textContent()), 'offline, the connected line is gone');
      const n = s.requests.length;
      await page.click('#libList [data-open]'); await page.waitForSelector('body.playing');
      await page.click('#vNext').catch(() => {}); await sleep(600);
      assert(await page.locator('#stage canvas').count() > 0, 'a song did not open offline');
      assert(!s.requests.slice(n).some(toGoogle), 'a request to Google left while a song was open');
      await page.click('#vBack'); await page.waitForFunction(() => !document.body.classList.contains('playing'));
      await page.click('[data-drivetest]');
      assert(/Cannot reach Google/.test(await until(async () => { const x = await dialogText(page).catch(() => null); return x && !/^Testing/.test(x) ? x : null; }, 'no answer offline', 15000)), 'offline test message');
      await closeDialog(page);
    } finally { await back(); }
    assert(pageErrors(s).length === 0, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'sync 1a: Connect goes out with the right client, scope and state, comes back clean, keeps the token nowhere else; the library is unchanged', run: loopConnect},
  {name: 'sync 1b: a refused, foreign, old or replayed sign-in changes nothing and says so in plain words', run: loopRefused},
  {name: 'sync 1c: a token with under a minute left is not used; Connect again carries on with the test', run: loopTokenLife},
  {name: 'sync 1d: the folder is made once, another tablet\'s is found, every page of a listing is read', run: loopFolder},
  {name: 'sync 1e: offline, full, busy, off, rubbish, Cancel and a refused token are each said plainly and change nothing', run: loopFailures},
  {name: 'sync 1f: Disconnect forgets the sign-in here and calls nobody', run: loopDisconnect},
  {name: 'sync 1g: the Content-Security-Policy is the agreed one and Google\'s addresses live in one file', run: loopCsp},
  {name: 'sync 1h: never connected, or connected and offline, the app opens and plays and sends nothing to Google', run: loopOffline},
];

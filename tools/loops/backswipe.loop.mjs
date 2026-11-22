/*
 * Back swipe loops: the back gesture (Android's back, the iPad's edge swipe) closes what is open in the viewer, one
 * layer at a time, and never the app; from the list it leaves the app as it always did.
 *
 * What is closed here: the app PRODUCES history entries (one pushState per layer a tap opens, history.go(-n) when a layer
 * closes some other way) and the browser's own Back (page.goBack()) is fed through them. Each step then reads the result
 * from independent places: the address the browser shows, history.length and history.state, and what is on the screen
 * (the viewer, the Library list, the setlist's rows, a dialog). Every walk starts on about:blank, so "Back left the app"
 * is checked by the browser being on about:blank again.
 * page.goBack() is NOT exactly a gesture: it goes to the previous entry even when Chrome's back button would skip it (an
 * entry left by a pushState made without a tap, Chrome's "history manipulation intervention"). So loop (g) records
 * navigator.userActivation.isActive at every pushState the app makes and requires it to be true (Chromium; WebKit only
 * where the API exists).
 */
import path from 'node:path';
import {FIX, assert, sleep} from './harness.mjs';

const SONGS = ['one-page.pdf', 'two-page.pdf', 'three-page.pdf'];

async function waitFor(fn, what, ms = 8000){
  const t0 = Date.now();
  for(;;){
    const v = await fn(); if(v) return v;
    if(Date.now() - t0 > ms) throw new Error(what);
    await sleep(80);
  }
}
/* What the page says about itself right now. */
const state = page => page.evaluate(() => ({url: location.href, len: history.length, mark: history.state && history.state.ss || null, d: history.state && history.state.d || 0,
  viewer: !!document.querySelector('#viewer.on'), annot: document.querySelector('#vAnn')?.getAttribute('aria-pressed') === 'true',
  crop: !document.querySelector('#cropper')?.hidden, modals: document.querySelectorAll('.modal').length,
  lib: !!document.querySelector('#libList'), rows: document.querySelectorAll('#items > li.row').length,
  set: document.querySelector('#view h2')?.textContent || null, title: document.querySelector('#vTitle')?.textContent || ''}));
const show = s => JSON.stringify(s);

/* A fresh session that starts on about:blank and goes to the app (two history entries), with the three fixture songs. */
async function fresh(ctx, opts){
  const s = await ctx.session(opts);
  const {page} = s;
  assert(page.url() === 'about:blank', 'the session does not start on about:blank: ' + page.url());
  await s.goto();
  await page.click('#tLib');
  await page.setInputFiles('#file', SONGS.map(f => path.join(FIX, f)));
  await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, SONGS.length, {timeout: 15000});
  const st = await state(page);
  assert(st.len === 2 && st.mark === null, 'the Library added a history entry: ' + show(st));
  return s;
}
async function openSong(page, title = 'three'){
  await page.click('#tLib');
  await page.locator('#libList [data-open]', {hasText: new RegExp(title, 'i')}).first().click();
  await page.waitForSelector('#viewer.on #stage .sheet canvas');
  await page.evaluate(() => document.querySelector('#viewer').classList.remove('hide'));
  const st = await state(page);
  assert(st.mark === 'viewer', 'opening a song added no history entry: ' + show(st));
  return st;
}
/* The browser's Back, then a moment for the app's popstate handling (and its own history calls) to settle. */
async function back(page){
  await page.goBack({timeout: 10000}).catch(e => { if(!/about:blank|net::ERR_ABORTED/.test(e.message)) throw e; });
  await sleep(250);
  if(page.url() !== 'about:blank') await page.waitForSelector('#view', {timeout: 10000});
  return page.url() === 'about:blank' ? {url: 'about:blank'} : state(page);
}
/* Back from the list leaves the app: the browser is on about:blank again. */
async function leaves(page, what){
  const st = await back(page);
  assert(st.url === 'about:blank', `${what}: one Back from the list did not leave the app: ` + show(st));
}
/* The song closed and the page is still the app, on the screen it was opened from. */
function closedTo(st, base, what, on = 'lib'){
  assert(st.url === base + 'index.html' || st.url === base, `${what}: Back left the app (or changed the address): ` + show(st));
  assert(!st.viewer, `${what}: Back did not close the song: ` + show(st));
  assert(st.mark === null, `${what}: a song's history entry is left behind: ` + show(st));
  if(on === 'lib') assert(st.lib, `${what}: the Library is not showing after Back: ` + show(st));
  else assert(st.set === on && st.rows > 0, `${what}: Back did not return to the setlist "${on}": ` + show(st));
}
async function newSet(page, name, titles, brk){
  await page.click('#tSets');
  if(await page.locator('#view [data-allsets]').count()) await page.click('#view [data-allsets]');
  await page.click('#view [data-newset]');
  await page.locator('.modal input[type=text]').fill(name);
  await page.click('.modal [data-ok]');
  await page.waitForSelector('#view [data-addto]');
  for(const [i, t] of titles.entries()){
    if(i === brk){ const n = await page.locator('#items > li.row').count(); await page.click('#view [data-addbreak]'); await page.waitForFunction(k => document.querySelectorAll('#items > li.row').length === k, n + 1); }
    const n = await page.locator('#items > li.row').count();
    await page.click('#view [data-addto]');
    await page.locator('.modal .pick').waitFor();
    await page.locator('.modal .pick label', {hasText: new RegExp(t, 'i')}).first().locator('input').check();
    await page.click('.modal [data-ok]');
    await page.waitForFunction(k => document.querySelectorAll('#items > li.row').length === k, n + 1, {timeout: 5000});
  }
  const st = await state(page);
  assert(st.mark === null && st.len === 2, 'making a setlist added a history entry: ' + show(st));
}

/* ---------- (a) a song from the Library; page turns add nothing; the Library screens add nothing ---------- */
async function libraryLoop(ctx){
  const s = await fresh(ctx);
  try{
    const {page} = s;
    /* the other screens of the app: the Setlists tab, a menu box: no entry, no handling */
    await page.click('#tSets'); await page.click('#tLib');
    await page.locator('#view').getByRole('button', {name: 'Share / Import', exact: true}).click();
    await page.locator('.modal.menubox').waitFor();
    await page.click('.modal.menubox [data-x]');
    let st = await state(page);
    assert(st.len === 2 && st.mark === null, 'the Library screens added a history entry: ' + show(st));

    const o = await openSong(page);
    assert(o.len === 3, 'opening a song did not add exactly one entry: ' + show(o));
    for(let i = 0; i < 2; i++){ await page.click('#vNext'); await sleep(150); }
    await waitFor(async () => /Page 3 of 3|Page 3/.test(await page.textContent('#vSub')), 'the page did not turn to page 3');
    await page.click('#vPrev'); await sleep(150);
    st = await state(page);
    assert(st.len === 3 && st.mark === 'viewer', 'a page turn changed the history: ' + show(st));
    st = await back(page);
    closedTo(st, ctx.base, 'Back from a song opened in the Library');
    await leaves(page, 'after closing a song with Back');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- (b) one layer at a time: Annotate, the Crop screen, a dialog ---------- */
async function layersLoop(ctx){
  const s = await fresh(ctx);
  try{
    const {page} = s;
    /* Annotate on: the first Back turns it off, the second closes the song, the third leaves */
    await openSong(page);
    await page.click('#vAnn');
    await waitFor(async () => (await state(page)).annot, 'Annotate did not turn on');
    let st = await back(page);
    assert(st.viewer && !st.annot && st.mark === 'viewer' && st.url !== 'about:blank', 'Back with Annotate on did not just turn Annotate off: ' + show(st));
    st = await back(page);
    closedTo(st, ctx.base, 'second Back after Annotate');
    await leaves(page, 'after Annotate');

    /* the Crop screen */
    await s.goto(); await openSong(page);
    await page.click('#vCrop');
    await waitFor(async () => /Page 1 of/.test(await page.textContent('#cropHint')) && (await state(page)).crop, 'the Crop screen did not open');
    st = await back(page);
    assert(st.viewer && !st.crop && st.mark === 'viewer', 'Back on the Crop screen did not just close it: ' + show(st));
    st = await back(page);
    closedTo(st, ctx.base, 'second Back after Crop');
    await leaves(page, 'after Crop');

    /* a dialog (a question box) over the song: Back is its Cancel */
    await s.goto(); await openSong(page);
    await page.evaluate(() => { window.__asked = 'open'; import('./js/util.js').then(u => u.ask('A question over the song', 'x')).then(v => { window.__asked = v; }); });
    await page.locator('.modal input[type=text]').waitFor();
    st = await back(page);
    assert(st.viewer && st.modals === 0 && st.mark === 'viewer', 'Back with a dialog open did not just close the dialog: ' + show(st));
    assert(await page.evaluate(() => window.__asked) === null, 'Back did not answer the dialog with Cancel: ' + await page.evaluate(() => window.__asked));
    /* two layers at once: a dialog over Annotate */
    await page.click('#vAnn');
    await page.evaluate(() => { import('./js/util.js').then(u => u.ask('Another question', '')); });
    await page.locator('.modal input[type=text]').waitFor();
    st = await back(page);
    assert(st.viewer && st.annot && st.modals === 0, 'Back closed more than the dialog on top: ' + show(st));
    st = await back(page);
    assert(st.viewer && !st.annot && st.mark === 'viewer', 'Back after the dialog did not turn Annotate off: ' + show(st));
    st = await back(page);
    closedTo(st, ctx.base, 'Back after a dialog and Annotate');
    await leaves(page, 'after a dialog');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- (c) a dialog that ignores Escape (a write in progress): Back changes nothing ---------- */
async function lockedLoop(ctx){
  const s = await fresh(ctx);
  try{
    const {page} = s;
    await openSong(page);
    await page.evaluate(async () => { const u = await import('./js/util.js'); window.__job = u.busy('Saving', 'Saving to this tablet…'); window.__job.lock(); });
    for(let i = 0; i < 2; i++){
      const st = await back(page);
      assert(st.viewer && st.modals === 1 && st.mark === 'viewer' && st.d >= 1, `Back ${i + 1} with a locked dialog changed something: ` + show(st));
    }
    await page.evaluate(() => window.__job.close());
    const st = await back(page);
    closedTo(st, ctx.base, 'Back after the locked dialog closed');
    await leaves(page, 'after a locked dialog');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- (d) a setlist: Back returns to the setlist's screen; a break page; the app's own Back button ---------- */
async function setlistLoop(ctx){
  const s = await fresh(ctx);
  try{
    const {page} = s;
    await newSet(page, 'Gig', ['one', 'two'], 1);       // one, a break, two
    await page.click('#view [data-play]');
    await page.waitForSelector('#viewer.on #stage .sheet canvas');
    let st = await state(page);
    assert(st.mark === 'viewer' && st.len === 3, 'Play setlist did not add one entry: ' + show(st));
    st = await back(page);
    closedTo(st, ctx.base, 'Back from a setlist song', 'Gig');

    /* a break page: Back closes the song from it, to the setlist */
    await page.click('#view [data-play]');
    await page.waitForSelector('#viewer.on #stage .sheet canvas');
    await page.click('#vNext');
    await page.waitForSelector('#stage .breakpage');
    st = await back(page);
    closedTo(st, ctx.base, 'Back from a break page', 'Gig');

    /* a song tapped in the setlist, closed with the app's own Back button: then ONE Back leaves the app */
    await page.locator('#items [data-playat]').last().click();
    await page.waitForSelector('#viewer.on #stage .sheet canvas');
    await page.click('#vBack');
    await page.waitForSelector('#viewer.on', {state: 'hidden'});
    await waitFor(async () => (await state(page)).mark === null, 'the Back button left the song\'s history entry: ' + show(await state(page)));
    st = await state(page);
    assert(st.set === 'Gig', 'the Back button did not return to the setlist: ' + show(st));
    await leaves(page, 'after the app\'s Back button');

    /* Escape closes the song the same way */
    await s.goto(); await openSong(page);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#viewer.on', {state: 'hidden'});
    await waitFor(async () => (await state(page)).mark === null, 'Escape left the song\'s history entry');
    await leaves(page, 'after Escape');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- (e) fifty opens and closes: the history does not grow ---------- */
async function fiftyLoop(ctx){
  const s = await fresh(ctx);
  try{
    const {page} = s;
    const start = (await state(page)).len;
    let after1 = null;
    for(let i = 0; i < 50; i++){
      await page.locator('#libList [data-open]').nth(i % 3).click();
      await page.waitForSelector('#viewer.on');
      await page.waitForFunction(() => history.state && history.state.ss === 'viewer');
      if(i % 2){ await page.click('#vBack'); await page.waitForSelector('#viewer.on', {state: 'hidden'}); await page.waitForFunction(() => !history.state); }
      else { const st = await back(page); assert(!st.viewer && st.mark === null, `Back ${i}: ` + show(st)); }
      const len = (await state(page)).len;
      if(after1 === null) after1 = len;
      assert(len === after1 && len <= start + 1, `after ${i + 1} opens and closes history.length is ${len} (started at ${start}, ${after1} after the first)`);
    }
    await leaves(page, 'after fifty opens and closes');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- (f) a reload with a song open ---------- */
async function reloadLoop(ctx){
  const s = await fresh(ctx);
  try{
    const {page} = s;
    /* an update reload (what reloadNow() does: the open song saved in ss-resume, then a reload): the song comes back with
       the entry from before, never a second one */
    const o = await openSong(page);
    await page.click('#vNext');
    await waitFor(async () => /Page 3/.test(await page.textContent('#vSub')), 'the page did not turn');
    await page.evaluate(async () => { const {resumeState} = await import('./js/viewer.js'); sessionStorage.setItem('ss-resume', JSON.stringify(resumeState())); });
    await page.addInitScript(PUSH_PROBE);
    await page.reload();
    await page.waitForSelector('#viewer.on #stage .sheet canvas');
    await sleep(400);
    let st = await state(page);
    assert(st.len === o.len && st.mark === 'viewer' && /Page 3/.test(await page.textContent('#vSub')), 'after an update reload the song is not back on one entry: ' + show(st));
    assert(!(await page.evaluate(() => window.__pushes.length)), 'the update reload pushed a history entry (it must reuse the one from before; Playwright\'s own calls can count as taps, so any push is refused here): ' + JSON.stringify(await page.evaluate(() => window.__pushes)));
    await page.evaluate(() => { window.__sameDoc = true; });
    st = await back(page);
    closedTo(st, ctx.base, 'Back after an update reload');
    /* either is right (the song closes, the app stays): the browser may load the page again for the entry from before the reload */
    if(ctx.opts.verbose) console.log('  after an update reload, Back ' + (await page.evaluate(() => window.__sameDoc) ? 'stayed in the same page (popstate)' : 'loaded the page again'));
    await leaves(page, 'after an update reload');

    /* a plain reload with a song open (no ss-resume): the list shows, and the song's leftover entry is taken off, so one
       Back leaves the app */
    await s.goto(); await openSong(page);
    /* the entry must be gone BEFORE the list is first drawn (taking it off later can load the page again under his finger) */
    await page.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { const v = document.querySelector('#view'); if(!v) return;
      new MutationObserver((ms, o) => { if(v.querySelector('#libList')){ window.__dAtDraw = history.state && history.state.d || 0; o.disconnect(); } }).observe(v, {childList: true, subtree: true}); }); });
    await page.reload();
    await page.waitForSelector('#libList [data-open]');
    assert(await page.evaluate(() => window.__dAtDraw) === 0, 'the list was drawn while the song\'s old history entry was still there: ' + await page.evaluate(() => window.__dAtDraw));
    await waitFor(async () => (await state(page)).mark === null, 'a leftover song entry stayed after a plain reload: ' + show(await state(page)));
    st = await state(page);
    assert(!st.viewer && st.lib, 'a plain reload did not show the Library: ' + show(st));
    await leaves(page, 'after a plain reload');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- (g) every entry is pushed in a tap (Chrome's back skips one that is not) ---------- */
const PUSH_PROBE = () => {
  window.__pushes = [];
  const ps = history.pushState;
  history.pushState = function(...a){ window.__pushes.push({d: a[0] && a[0].d, active: navigator.userActivation ? navigator.userActivation.isActive : null}); return ps.apply(this, a); };
};
async function activationLoop(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await page.addInitScript(PUSH_PROBE);
    await s.goto();
    await page.setInputFiles('#file', SONGS.map(f => path.join(FIX, f)));
    await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, SONGS.length, {timeout: 15000});
    const hasApi = await page.evaluate(() => !!navigator.userActivation);
    /* song -> Annotate -> a text note's dialog, each opened by a tap; then Back three times */
    await openSong(page);
    await page.click('#vAnn');
    await page.click('#tools [data-tool=text]');
    const sh = await page.locator('#stage .sheet').first().boundingBox();
    await page.mouse.click(sh.x + sh.width * .3, sh.y + sh.height * .3);
    await page.locator('.modal textarea').waitFor();
    let st = await state(page);
    assert(st.d === 3 && st.len === 5, 'song, Annotate and the note dialog are not three entries: ' + show(st));
    st = await back(page);
    assert(st.viewer && st.annot && st.modals === 0 && st.d === 2, 'Back 1 did not just close the note dialog: ' + show(st));
    st = await back(page);
    assert(st.viewer && !st.annot && st.d === 1, 'Back 2 did not just turn Annotate off: ' + show(st));
    st = await back(page);
    closedTo(st, ctx.base, 'Back 3');
    /* Crop -> Back x2 */
    await openSong(page);
    await page.click('#vCrop');
    await waitFor(async () => /Page 1 of/.test(await page.textContent('#cropHint')), 'the Crop screen did not draw');
    st = await back(page);
    assert(st.viewer && !st.crop && st.d === 1, 'Back on the Crop screen: ' + show(st));
    st = await back(page);
    closedTo(st, ctx.base, 'Back after Crop');
    const pushes = await page.evaluate(() => window.__pushes);
    assert(pushes.length === 5, 'expected 5 pushes (song, Annotate, dialog, song, Crop): ' + JSON.stringify(pushes));
    if(hasApi) assert(pushes.every(p => p.active === true), 'a history entry was pushed without a tap (Chrome\'s back would skip it): ' + JSON.stringify(pushes));
    await leaves(page, 'after the activation walk');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- (h) the line-thickness menu is its own layer; a quick reopen after Back; Crop closed while it still draws ---------- */
async function moreLayersLoop(ctx){
  const s = await fresh(ctx);
  try{
    const {page} = s;
    await openSong(page);
    await page.click('#vAnn');
    await page.click('#tools [data-tool=pen][data-color="#1a1a1a"]').catch(() => {});
    await page.click('#tWidth');
    await page.waitForSelector('#wdMenu:not([hidden])');
    let st = await back(page);
    assert(st.viewer && st.annot && await page.locator('#wdMenu').isHidden() && st.d === 2, 'Back with the thickness menu open did not just close the menu: ' + show(st));
    st = await back(page);
    assert(st.viewer && !st.annot && st.d === 1, 'Back after the menu did not just turn Annotate off: ' + show(st));
    /* the on-screen Back button, then a song tapped at once (no wait): one entry, Back closes it */
    /* both taps in one go, so the second lands while the first song's step back is certainly still on its way */
    await page.evaluate(() => { document.querySelector('#vBack').click(); document.querySelectorAll('#libList [data-open]')[1].click(); });
    await page.waitForSelector('#viewer.on #stage .sheet canvas');
    await waitFor(async () => (await state(page)).d === 1, 'a song opened right after Back has no history entry: ' + show(await state(page)));
    st = await back(page);
    closedTo(st, ctx.base, 'Back after a quick reopen');
    /* Crop tapped and Back at once, before its page is drawn: the Crop screen closes, the song stays */
    await openSong(page);
    await page.click('#vCrop');
    st = await back(page);
    assert(st.viewer && !st.crop && st.d === 1, 'Back while Crop was still drawing: ' + show(st));
    st = await back(page);
    closedTo(st, ctx.base, 'Back after the early Crop');
    await leaves(page, 'after more layers');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'backswipe: Back closes a song opened in the Library, then leaves the app; page turns and the Library add no entry', run: libraryLoop},
  {name: 'backswipe: one layer at a time: Annotate, the Crop screen, a dialog, a dialog over Annotate', run: layersLoop},
  {name: 'backswipe: a dialog that ignores Escape (a write in progress) ignores Back too', run: lockedLoop},
  {name: 'backswipe: a setlist song and a break page return to the setlist; the Back button and Escape leave no entry', run: setlistLoop},
  {name: 'backswipe: fifty opens and closes leave the history length where it was', run: fiftyLoop},
  {name: 'backswipe: every history entry is pushed in a tap (song, Annotate, a note dialog, Crop), never from Back', run: activationLoop},
  {name: 'backswipe: the thickness menu is its own layer; a song tapped right after Back gets its entry; Crop closes while it draws', run: moreLayersLoop},
  {name: 'backswipe: an update reload reuses the song\'s entry; a plain reload drops the leftover one', run: reloadLoop},
];

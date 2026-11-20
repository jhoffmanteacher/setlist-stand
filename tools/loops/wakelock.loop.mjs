/*
 * Keep-the-screen-on loops: the viewer asks the browser to keep the screen awake, and its button tells the truth.
 *
 * navigator.wakeLock is replaced (page.addInitScript) by a fake that counts requests and releases, can fire the
 * system's 'release' event, and can refuse (mode 'reject') or not exist at all (mode 'missing'). What is closed
 * here: what the app PRODUCED (its requests and releases, the button's aria-pressed, data-state and labels, the
 * saved `ss-awake` preference, the toasts it showed, the boxes of the top bar) is read back and compared with what
 * the fake says really happened.
 */
import path from 'node:path';
import {FIX, assert, sleep} from './harness.mjs';

const MAY_DIM = 'This tablet may dim the screen. Set Auto-Lock to Never in Settings.';

async function waitFor(fn, what, ms = 6000){
  const t0 = Date.now();
  for(;;){
    const v = await fn(); if(v) return v;
    if(Date.now() - t0 > ms) throw new Error(what);
    await sleep(100);
  }
}

/* The fake lock, the toast recorder, from the first script on. `mode`: 'ok' | 'reject' | 'missing'. */
const stub = (page, mode) => page.addInitScript(mode => {
  window.__toasts = [];
  document.addEventListener('DOMContentLoaded', () => {
    const t = document.querySelector('#toast'); if(!t) return;
    new MutationObserver(ms => { for(const m of ms) for(const n of m.addedNodes) if(n.textContent) window.__toasts.push(n.textContent); }).observe(t, {childList: true});
  });
  const W = window.__wl = {mode, requests: 0, released: 0, system: 0, live: new Set(),
    held(){ return W.live.size; },
    fire(){ for(const s of [...W.live]){ W.live.delete(s); s.released = true; W.system++; s.dispatchEvent(new Event('release')); } }};
  if(mode === 'missing'){
    try{ delete Navigator.prototype.wakeLock; }catch(e){}
    Object.defineProperty(navigator, 'wakeLock', {configurable: true, value: undefined});
    return;
  }
  Object.defineProperty(navigator, 'wakeLock', {configurable: true, value: {request: async type => {
    W.requests++;
    if(W.mode === 'reject') throw new DOMException('Not allowed', 'NotAllowedError');
    const s = new EventTarget(); s.type = type; s.released = false;
    s.release = async () => { if(s.released) return; s.released = true; W.live.delete(s); W.released++; s.dispatchEvent(new Event('release')); };
    W.live.add(s);
    return s;
  }}});
}, mode);

const wl = page => page.evaluate(() => ({requests: window.__wl.requests, released: window.__wl.released, system: window.__wl.system, held: window.__wl.held()}));
const toasts = page => page.evaluate(() => window.__toasts.slice());
const btn = page => page.evaluate(() => {
  const b = document.querySelector('#vAwake'), r = b.getBoundingClientRect();
  let pref = null; try{ pref = localStorage.getItem('ss-awake'); }catch(e){}
  return {state: b.dataset.state, pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label') || '', title: b.title, pref, w: r.width, h: r.height};
});
const inState = (page, state, pressed) => waitFor(async () => { const b = await btn(page); return b.state === state && b.pressed === pressed && b; },
  `the button is not "${state}" with aria-pressed ${pressed}`).catch(async e => { throw new Error(e.message + ': ' + JSON.stringify(await btn(page))); });
/* Clicks the button and returns the next toast it raised. */
async function tap(page){
  const n = (await toasts(page)).length;
  await page.click('#vAwake');
  return waitFor(async () => (await toasts(page))[n], 'the button showed no toast');
}

async function addSong(page){
  await page.click('#tLib');
  await page.setInputFiles('#file', path.join(FIX, 'two-page.pdf'));
  await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 1, null, {timeout: 15000});
  await waitFor(async () => (await toasts(page)).some(t => /^Added 1 song/.test(t)), 'the import toast did not show');
  await page.evaluate(() => { window.__toasts.length = 0; });     // from here on, only the toasts of the screen-on button
}
async function open(page){
  await page.click('#tLib');
  await page.locator('#libList [data-open]').first().click();
  await page.waitForSelector('#viewer.on #stage .sheet canvas');
}
const close = async page => { await page.click('#vBack'); await page.waitForSelector('#viewer.on', {state: 'hidden'}); };

/* The top bar at one size: nothing sticks out of the screen or the bar, nothing overlaps, at most two rows (one when wide), 44px target. */
async function layout(page, w, h, what){
  await page.setViewportSize({width: w, height: h});
  await sleep(400);                                   // the resize redraw runs after 150 ms
  const L = await page.evaluate(() => {
    const box = e => { const b = e.getBoundingClientRect(); return {id: e.id || e.className, x: b.x, y: b.y, r: b.right, b: b.bottom, w: b.width, h: b.height}; };
    const bar = document.querySelector('#vtop');
    return {vw: innerWidth, bar: box(bar), items: [...bar.children].map(box).filter(i => i.w > 0 && i.h > 0), scroll: [document.documentElement.scrollWidth - innerWidth, bar.scrollWidth - bar.clientWidth]};
  });
  const where = `${what} at ${w}x${h}`, dump = () => ' ' + JSON.stringify(L.items.map(i => [i.id, Math.round(i.x), Math.round(i.y), Math.round(i.w), Math.round(i.h)]));
  const awake = L.items.find(i => i.id === 'vAwake');
  assert(awake, `${where}: the screen-on button is not in the top bar`);
  assert(awake.w >= 43.5 && awake.h >= 43.5, `${where}: the button is ${awake.w}x${awake.h}, under 44px`);
  for(const i of L.items){
    assert(i.x >= -.5 && i.r <= L.vw + .5, `${where}: ${i.id} sticks out of the screen sideways` + dump());
    assert(i.y >= L.bar.y - .5 && i.b <= L.bar.b + .5, `${where}: ${i.id} sticks out of the bar` + dump());
  }
  for(let a = 0; a < L.items.length; a++) for(let b = a + 1; b < L.items.length; b++){
    const p = L.items[a], q = L.items[b];
    const ox = Math.min(p.r, q.r) - Math.max(p.x, q.x), oy = Math.min(p.b, q.b) - Math.max(p.y, q.y);
    assert(!(ox > .5 && oy > .5), `${where}: ${p.id} and ${q.id} overlap` + dump());
  }
  assert(L.scroll[0] <= 1 && L.scroll[1] <= 1, `${where}: the page or the bar scrolls sideways (${L.scroll.join(', ')})`);
  /* at 768 wide the bar already wraps (Full screen goes to a second row); more than two rows would mean the new button made it worse */
  assert(Math.max(...L.items.map(i => i.y)) - Math.min(...L.items.map(i => i.y)) < 70, `${where}: the bar needs more than two rows` + dump());
  assert(w > 1000 ? Math.max(...L.items.map(i => i.y)) - Math.min(...L.items.map(i => i.y)) < 12 : true, `${where}: the bar wraps although the screen is wide` + dump());
  const title = L.items.find(i => i.id === 'ttl');
  assert(title && title.w >= 40, `${where}: the title has no room (${title && title.w}px)` + dump());
}

/* ---------- (a) the lock follows the viewer, the preference and the button ---------- */
async function lockLoop(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await stub(page, 'ok');
    await s.goto();
    await addSong(page);
    assert((await wl(page)).requests === 0, 'the lock was requested before any song was opened');

    /* open: requested, held, shown */
    await open(page);
    await waitFor(async () => (await wl(page)).held === 1, 'no screen lock after opening a song: ' + JSON.stringify(await wl(page)));
    let b = await inState(page, 'held', 'true');
    assert(b.pref !== '0', 'the preference is off by default: ' + b.pref);
    assert(/Keep screen on/.test(b.label), 'aria-label: ' + b.label);
    assert((await wl(page)).requests === 1, 'requests after open: ' + (await wl(page)).requests);
    await layout(page, 1280, 800, 'held');
    await layout(page, 768, 1024, 'held');
    await layout(page, 1280, 800, 'held');

    /* the button turns it off and on, and remembers */
    assert(await tap(page) === 'Screen can dim', 'toast after turning off');
    b = await inState(page, 'off', 'false');
    assert(b.pref === '0', 'preference after turning off: ' + b.pref);
    let n = await wl(page);
    assert(n.held === 0 && n.released === 1, 'turning off did not release the lock: ' + JSON.stringify(n));
    await layout(page, 768, 1024, 'off');
    await layout(page, 1280, 800, 'off');
    assert(await tap(page) === 'Screen stays on', 'toast after turning on');
    b = await inState(page, 'held', 'true');
    assert(b.pref === '1', 'preference after turning on: ' + b.pref);
    n = await wl(page);
    assert(n.held === 1 && n.requests === 2, 'turning on did not ask for the lock: ' + JSON.stringify(n));

    /* the system takes the lock back: the button says so, with no toast, and the page asks again when it is shown */
    const t0 = (await toasts(page)).length;
    await page.evaluate(() => window.__wl.fire());
    b = await inState(page, 'dim', 'false');
    assert(/may dim/.test(b.label) && /may dim/.test(b.title), 'not-held label/title do not say so: ' + JSON.stringify(b));
    assert((await toasts(page)).length === t0, 'a system release raised a toast: ' + (await toasts(page)).slice(t0).join(' | '));
    await layout(page, 768, 1024, 'not held');
    await layout(page, 1280, 800, 'not held');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await inState(page, 'held', 'true');
    n = await wl(page);
    assert(n.held === 1 && n.requests === 3, 'visibilitychange did not ask again: ' + JSON.stringify(n));

    /* with the preference off, showing the page again asks for nothing */
    await tap(page);
    await inState(page, 'off', 'false');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await sleep(500);
    n = await wl(page);
    assert(n.requests === 3 && n.held === 0, 'visibilitychange asked for the lock with the preference off: ' + JSON.stringify(n));

    /* close: nothing held; reopen with the preference off: nothing requested */
    await close(page);
    assert((await wl(page)).held === 0, 'the lock is still held after the viewer closed');
    await open(page);
    await sleep(600);
    n = await wl(page);
    assert(n.requests === 3 && n.held === 0, 'a song opened with the preference off still asked for the lock: ' + JSON.stringify(n));
    await inState(page, 'off', 'false');
    assert(await page.evaluate(() => localStorage.getItem('ss-awake')) === '0', 'the preference was lost');

    /* turn it on inside the viewer; closing releases it */
    assert(await tap(page) === 'Screen stays on', 'toast after turning on');
    await inState(page, 'held', 'true');
    assert((await wl(page)).requests === 4, 'requests after turning on: ' + (await wl(page)).requests);
    await close(page);
    n = await wl(page);
    assert(n.held === 0, 'the lock is still held after the viewer closed: ' + JSON.stringify(n));
    assert(n.requests === n.released + n.system, `every lock must be given back: ${n.requests} requested, ${n.released} released, ${n.system} taken by the system`);
    assert(!(await toasts(page)).some(t => /dim the screen/.test(t)), 'the "may dim" toast showed although the lock worked: ' + (await toasts(page)).join(' | '));
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- (b) a refused request: not held, one toast per page load ---------- */
async function rejectLoop(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await stub(page, 'reject');
    await s.goto();
    await addSong(page);

    await open(page);
    let b = await inState(page, 'dim', 'false');
    assert(/may dim/.test(b.label) && /may dim/.test(b.title), 'not-held label/title do not say so: ' + JSON.stringify(b));
    await waitFor(async () => (await toasts(page)).length >= 1, 'no toast when the lock was refused');
    assert((await toasts(page)).join('|') === MAY_DIM, 'toast: ' + (await toasts(page)).join(' | '));
    await layout(page, 768, 1024, 'refused');
    await layout(page, 1280, 800, 'refused');
    await close(page);
    await open(page);
    await close(page);
    await open(page);
    await sleep(600);
    assert((await toasts(page)).length === 1, 'more than one toast in one page load: ' + (await toasts(page)).join(' | '));
    assert((await wl(page)).requests >= 3, 'a later open did not try again: ' + JSON.stringify(await wl(page)));
    await inState(page, 'dim', 'false');

    /* turning it off is a different state from "not held" */
    assert(await tap(page) === 'Screen can dim', 'toast after turning off');
    b = await inState(page, 'off', 'false');
    assert(!/may dim/.test(b.label), 'the off state says "may dim": ' + b.label);
    await close(page);

    /* a new page load: with the preference off there is no toast; turned on again, there is one, once */
    await page.reload();
    await page.waitForSelector('#libList [data-open]');
    assert(await page.evaluate(() => localStorage.getItem('ss-awake')) === '0', 'the preference did not survive a reload');
    await open(page);
    await inState(page, 'off', 'false');
    await sleep(600);
    assert(!(await toasts(page)).length, 'a toast with the preference off: ' + (await toasts(page)).join(' | '));
    await close(page);
    await page.evaluate(() => localStorage.setItem('ss-awake', '1'));
    await open(page);
    await inState(page, 'dim', 'false');
    await waitFor(async () => (await toasts(page)).length >= 1, 'no toast on the new page load');
    await close(page);
    await open(page);
    await sleep(600);
    assert((await toasts(page)).join('|') === MAY_DIM, 'toasts on the new page load: ' + (await toasts(page)).join(' | '));
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- (c) no navigator.wakeLock at all (older iPadOS) ---------- */
async function missingLoop(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await stub(page, 'missing');
    await s.goto();
    assert(await page.evaluate(() => typeof navigator.wakeLock) === 'undefined', 'the test did not remove navigator.wakeLock');
    await addSong(page);
    await open(page);
    const b = await inState(page, 'dim', 'false');
    assert(/may dim/.test(b.label) && /may dim/.test(b.title), 'not-held label/title do not say so: ' + JSON.stringify(b));
    await waitFor(async () => (await toasts(page)).length >= 1, 'no toast without navigator.wakeLock');
    assert((await toasts(page)).join('|') === MAY_DIM, 'toast: ' + (await toasts(page)).join(' | '));
    await layout(page, 768, 1024, 'no wakeLock');
    await layout(page, 1280, 800, 'no wakeLock');
    /* the button still works as a preference */
    assert(await tap(page) === 'Screen can dim', 'toast after turning off');
    await inState(page, 'off', 'false');
    assert(await tap(page) === MAY_DIM, 'turning it on where it cannot work must not say "Screen stays on"');
    await inState(page, 'dim', 'false');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- (d) localStorage blocked (Safari "Block all cookies"): the choice still works for this page load ---------- */
async function blockedStorageLoop(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await stub(page, 'ok');
    await page.addInitScript(() => {
      const boom = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
      Storage.prototype.getItem = boom; Storage.prototype.setItem = boom; Storage.prototype.removeItem = boom;
    });
    await s.goto();
    await addSong(page);
    await open(page);
    await waitFor(async () => (await wl(page)).held === 1, 'no screen lock after opening a song with storage blocked: ' + JSON.stringify(await wl(page)));
    await inState(page, 'held', 'true');
    /* turning it off must stick even though nothing can be saved: off, not "may dim", and no new lock when the page comes back */
    assert(await tap(page) === 'Screen can dim', 'toast after turning off with storage blocked');
    await inState(page, 'off', 'false');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await sleep(600);
    const n = await wl(page);
    assert(n.held === 0 && n.requests === 1, 'the lock came back after the user turned it off (storage blocked): ' + JSON.stringify(n));
    assert(await tap(page) === 'Screen stays on', 'toast after turning on with storage blocked');
    await inState(page, 'held', 'true');
    assert((await wl(page)).held === 1, 'turning it on did not take the lock');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'wakelock: the lock follows the viewer, the preference and the button; a system release shows; bar layout', run: lockLoop},
  {name: 'wakelock: the choice holds when localStorage is blocked', run: blockedStorageLoop},
  {name: 'wakelock: a refused lock shows as not held, with one toast per page load', run: rejectLoop},
  {name: 'wakelock: no navigator.wakeLock shows as not held', run: missingLoop},
];

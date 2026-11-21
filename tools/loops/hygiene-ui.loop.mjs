/*
 * Hygiene loops: the Content-Security-Policy holds for every feature, dialogs behave as real dialogs (focus, Tab,
 * Escape, inert page), setlist rows reorder from the keyboard, and the tablet CSS is in force.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import {FIX, TMP, JSZip, assert, sleep, sha256, idbAll, download, backupNow, wipe, restoreZip, PDFDocument} from './harness.mjs';

const FIXTURES = ['one-page.pdf', 'two-page.pdf', 'three-page.pdf'];
const ALLOWED_SOURCES = new Set(["'self'", "'none'", "'unsafe-inline'", 'data:', 'blob:']);

/* Collects every CSP violation the page reports, from the very first script on. */
const watchCsp = page => page.addInitScript(() => {
  window.__csp = [];
  addEventListener('securitypolicyviolation', e => window.__csp.push({dir: e.violatedDirective, uri: e.blockedURI, file: e.sourceFile, line: e.lineNumber, sample: e.sample}), true);
});
const cspNow = page => page.evaluate(() => window.__csp || []);
async function waitFor(fn, what, ms = 8000){
  const t0 = Date.now();
  for(;;){
    const v = await fn(); if(v) return v;
    if(Date.now() - t0 > ms) throw new Error(what);
    await sleep(150);
  }
}
const noModal = page => page.waitForFunction(() => !document.querySelector('.modal'), null, {timeout: 8000});

async function importFixtures(page){
  await page.click('#tLib');
  await page.setInputFiles('#file', FIXTURES.map(f => path.join(FIX, f)));
  await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 3, null, {timeout: 15000});
}
async function openSong(page, title){
  if(await page.locator('#viewer.on').count()) await page.click('#vBack');
  await page.click('#tLib');
  await page.locator('#libList [data-open]', {hasText: title}).first().click();
  await page.waitForSelector('#viewer.on #stage .sheet canvas');
  await page.waitForSelector('#stage .ink');
}
async function showChrome(page){
  if(await page.locator('#viewer.hide').count()){ await page.mouse.click(640, 420); await page.waitForSelector('#viewer:not(.hide)'); }
}
async function newSet(page, name, titles){
  await page.click('#tSets');
  if(await page.locator('#view [data-allsets]').count()) await page.click('#view [data-allsets]');
  await page.click('#view [data-newset]');
  await page.locator('.modal input[type=text]').fill(name);
  await page.click('.modal [data-ok]');
  await page.waitForSelector('#view [data-addto]');
  await page.click('#view [data-addto]');
  await page.locator('.modal .pick').waitFor();
  for(const t of titles) await page.locator('.modal .pick label', {hasText: t}).locator('input').check();
  await page.click('.modal [data-ok]');
  await page.waitForFunction(n => document.querySelectorAll('#items > li.row').length === n, titles.length, {timeout: 5000});
}
const liveSets = async page => Object.values(await idbAll(page, 'sets')).filter(s => !s.deleted);

/* ---------- (a) CSP: every feature runs with zero violations ---------- */
async function cspLoop(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await watchCsp(page);
    await s.goto();
    await s.swReady();

    /* the policy itself */
    const metas = await page.evaluate(() => [...document.querySelectorAll('meta[http-equiv]')].filter(m => /^content-security-policy$/i.test(m.httpEquiv)).map(m => m.content));
    assert(metas.length === 1, `${metas.length} CSP meta tags`);
    const dirs = Object.fromEntries(metas[0].split(';').map(d => d.trim()).filter(Boolean).map(d => { const [k, ...v] = d.split(/\s+/); return [k.toLowerCase(), v]; }));
    assert((dirs['default-src'] || []).join(' ') === "'self'", 'default-src is ' + JSON.stringify(dirs['default-src']));
    assert((dirs['script-src'] || []).join(' ') === "'self'", 'script-src is ' + JSON.stringify(dirs['script-src']));
    assert(!/unsafe-eval|wasm-unsafe-eval|https?:|\*/i.test(metas[0]), 'policy allows eval, a host or a wildcard: ' + metas[0]);
    for(const [k, v] of Object.entries(dirs)) for(const src of v) assert(ALLOWED_SOURCES.has(src), `${k} allows "${src}"`);
    for(const k of ['object-src', 'base-uri', 'form-action']) assert((dirs[k] || []).join() === "'none'", `${k} is ${JSON.stringify(dirs[k])}`);
    assert(await page.evaluate(() => document.querySelector('meta[name=referrer]')?.content) === 'no-referrer', 'no referrer meta');
    assert(await page.evaluate(() => window.pdfjsLib.noEval === true && Object.getPrototypeOf(window.pdfjsLib).getDocument !== window.pdfjsLib.getDocument),
      'pdfjsLib.getDocument is not wrapped with isEvalSupported:false');

    /* import, open, draw, text note */
    await importFixtures(page);
    await openSong(page, 'Three-page');
    await page.click('#vAnn');
    await page.click('#tools [data-tool=pen][data-color="#1a1a1a"]');
    const b = await page.locator('#stage .sheet').first().boundingBox();
    const x0 = b.x + b.width * .3, y0 = b.y + b.height * .4;
    await page.mouse.move(x0, y0); await page.mouse.down();
    for(let i = 1; i <= 8; i++) await page.mouse.move(x0 + i * b.width * .04, y0 + i * b.height * .01);
    await page.mouse.up();
    await waitFor(async () => Object.values(await idbAll(page, 'ink')).some(v => (v.strokes || []).some(x => !x.deleted && x.t === 'pen')), 'stroke not saved');
    await page.click('#tools [data-tool=text]');
    await page.mouse.click(b.x + b.width * .2, b.y + b.height * .7);
    await page.locator('.modal textarea').fill('Verse 2');
    await page.click('.modal [data-ok]');
    await noModal(page);
    await waitFor(async () => Object.values(await idbAll(page, 'ink')).some(v => (v.strokes || []).some(x => x.t === 'text' && x.text === 'Verse 2')), 'text note not saved');
    await page.click('#tDone');

    /* crop */
    await showChrome(page);
    await page.click('#vCrop');
    await page.waitForFunction(() => !document.querySelector('#cropper').hidden && /^Page \d+ of \d+$/.test(document.querySelector('#cropHint').textContent), null, {timeout: 8000});
    const sh = await page.locator('#cropSheet').boundingBox(), hb = await page.locator('#cropBox .ch[data-h=nw]').boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
    await page.mouse.move(sh.x + sh.width * .15, sh.y + sh.height * .15, {steps: 8}); await page.mouse.up();
    await page.click('#cropPage');
    await page.waitForSelector('#cropper', {state: 'hidden', timeout: 8000});
    await waitFor(async () => Object.values(await idbAll(page, 'songs')).some(x => x.crop), 'crop not saved');
    await page.click('#vBack');

    /* set with a break, print */
    await newSet(page, 'Gig', ['One-page', 'Three-page']);
    await page.click('#view [data-addbreak]');
    await page.waitForFunction(() => document.querySelectorAll('#items > li.row').length === 3);
    await page.click('#view [data-print]');
    await page.locator('.modal #pInk').setChecked(true);
    const pdf = await download(page, () => page.click('.modal [data-ok]'));
    if(await page.locator('.modal').count()){ await page.locator('.modal [data-x]').waitFor({timeout: 8000}); await page.click('.modal [data-x]'); }
    await noModal(page);
    const doc = await PDFDocument.load(await fsp.readFile(pdf.file));
    assert(doc.getPageCount() === 4, 'printed PDF has ' + doc.getPageCount() + ' pages, expected 4');

    /* backup, wipe, restore, reload through the service worker */
    const zip = await backupNow(page);
    await wipe(page);
    await s.goto();
    assert(!Object.keys(await idbAll(page, 'songs')).length, 'database not empty after wipe');
    const msg = await restoreZip(page, zip.file);
    assert(/Restored 3 songs and 1 setlist\b/.test(msg), 'restore toast: ' + msg);
    await page.reload();
    await page.waitForSelector('#libList [data-open]');
    assert(await page.evaluate(() => !!navigator.serviceWorker.controller), 'the reload is not controlled by the service worker');
    await openSong(page, 'Three-page');
    await page.click('#vBack');

    /* fonts are the bundled ones */
    const fonts = await page.evaluate(async () => { await document.fonts.ready; await document.fonts.load('700 20px "Barlow Condensed"'); await document.fonts.load('16px Barlow');
      return [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/"/g, '') + ' ' + f.weight); });
    assert(fonts.some(f => /^Barlow 400/.test(f)) && fonts.some(f => /^Barlow Condensed 700/.test(f)), 'bundled fonts not loaded: ' + fonts.join(', '));

    await sleep(300);
    const v = await cspNow(page);
    assert(!v.length, `${v.length} CSP violations: ` + JSON.stringify(v.slice(0, 3)));
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));

    /* and the policy really blocks eval (which also proves the listener works) */
    /* page.evaluate itself is exempt from CSP (DevTools), so the eval runs from a page task */
    await page.evaluate(() => setTimeout(() => { try{ eval('1'); window.__eval = 'eval ran'; }catch(e){ window.__eval = e.name; } }, 0));
    const r = await waitFor(() => page.evaluate(() => window.__eval), 'the eval task did not run', 3000);
    assert(r === 'EvalError', 'eval in the page: ' + r);
    const after = await waitFor(async () => { const x = await cspNow(page); return x.length ? x : null; }, 'blocked eval raised no securitypolicyviolation event', 3000);
    assert(after.length === 1 && /^script-src/.test(after[0].dir), 'violations after eval: ' + JSON.stringify(after));
  } finally { await s.close(); }
}

/* ---------- (b) dialogs ---------- */
async function checkDialog(page, what){
  const d = await page.evaluate(() => {
    const box = document.querySelector('.modal [role=dialog]'); if(!box) return null;
    const lab = document.getElementById(box.getAttribute('aria-labelledby') || '');
    return {modal: box.getAttribute('aria-modal'), label: lab ? lab.textContent : null, labelTag: lab && lab.tagName,
      inside: box.contains(document.activeElement), inert: ['.app', '#viewer', '#cropper'].map(s => document.querySelector(s).inert)};
  });
  assert(d, `${what}: no [role=dialog] in .modal`);
  assert(d.modal === 'true', `${what}: aria-modal ${d.modal}`);
  assert(d.label && /^H[1-3]$/.test(d.labelTag), `${what}: aria-labelledby does not name the heading (${JSON.stringify(d)})`);
  assert(d.inside, `${what}: focus is not inside the dialog`);
  assert(d.inert.every(Boolean), `${what}: page behind not inert: ` + JSON.stringify(d.inert));
  for(const key of ['Tab', 'Shift+Tab']){
    for(let i = 0; i < 9; i++){
      await page.keyboard.press(key);
      const inside = await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('.modal'));
      assert(inside, `${what}: focus left the dialog after ${key} x${i + 1}`);
    }
  }
}
async function escapeBack(page, opener, what){
  await page.keyboard.press('Escape');
  await noModal(page).catch(() => { throw new Error(`${what}: Escape did not close the dialog`); });
  const st = await page.evaluate(sel => ({back: document.activeElement === document.querySelector(sel), active: document.activeElement && document.activeElement.outerHTML.slice(0, 80),
    inert: ['.app', '#viewer', '#cropper'].map(s => document.querySelector(s).inert)}), opener);
  assert(st.back, `${what}: focus did not return to ${opener}; it is on ${st.active}`);
  assert(st.inert.every(x => !x), `${what}: page still inert after closing: ` + JSON.stringify(st.inert));
}
async function dialogLoop(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await importFixtures(page);

    /* library Edit (form) */
    const id = await page.locator('#libList [data-edit]').first().getAttribute('data-edit');
    const ed = `#libList [data-edit="${id}"]`;
    await page.focus(ed); await page.keyboard.press('Enter');
    await page.locator('.modal').waitFor();
    await checkDialog(page, 'Edit dialog');
    await escapeBack(page, ed, 'Edit dialog');
    assert(!(await page.locator('.modal').count()), 'Edit dialog still open');

    /* library Share songs (checklist), then the package-saved dialog */
    const sh = '#view [data-sharesongs]';
    await page.focus(sh); await page.keyboard.press('Enter');
    await page.locator('.modal .pick').waitFor();
    await checkDialog(page, 'Share songs dialog');
    await escapeBack(page, sh, 'Share songs dialog');
    await page.focus(sh); await page.keyboard.press('Enter');
    await page.locator('.modal .pick input').first().check();
    await download(page, () => page.click('.modal [data-ok]'));
    await page.locator('.modal [role=dialog]', {hasText: 'Package saved'}).waitFor();
    await checkDialog(page, 'Package saved dialog');
    await escapeBack(page, sh, 'Package saved dialog');

    /* import: the confirm dialog (a package with one song this library does not have), then the refusal notice for a file
       that is not a package */
    const doc = await PDFDocument.create(); doc.addPage([300, 300]).drawText('Hygiene import', {x: 20, y: 150, size: 18});
    const bytes = Buffer.from(await doc.save({updateMetadata: false})), z = new JSZip();
    z.file('files/s1.pdf', bytes, {createFolders: false});
    z.file('share.json', JSON.stringify({app: 'setlist-stand', kind: 'share', version: 1, saved: 'x', songs: [{id: 's1', song: 'Hygiene import', artist: '', version: '', pages: 1, hash: sha256(bytes)}], setlist: null}));
    const goodPkg = path.join(TMP, 'hygiene-package.zip');
    await fsp.writeFile(goodPkg, Buffer.from(await z.generateAsync({type: 'nodebuffer'})));
    await page.setInputFiles('#shareFile', goodPkg);
    await page.locator('.modal [role=dialog]', {hasText: 'Import share package'}).waitFor();
    await checkDialog(page, 'Import confirm dialog');
    await escapeBack(page, sh, 'Import confirm dialog');
    const junk = path.join(TMP, 'not-a-package.zip');
    await fsp.writeFile(junk, 'this is not a share package');
    await page.setInputFiles('#shareFile', junk);
    await page.locator('.modal [role=dialog]', {hasText: "Can't import that package"}).waitFor();
    await checkDialog(page, 'Import refusal notice');
    await escapeBack(page, sh, 'Import refusal notice');

    /* new-setlist ask */
    await page.click('#tSets');
    await page.focus('#view [data-newset]'); await page.keyboard.press('Enter');
    await page.locator('.modal input[type=text]').waitFor();
    assert(await page.evaluate(() => document.activeElement === document.querySelector('.modal input[type=text]')), 'ask dialog: the text field does not have focus');
    await checkDialog(page, 'New setlist dialog');
    await escapeBack(page, '#view [data-newset]', 'New setlist dialog');
    assert(!(await liveSets(page)).length, 'Escape on New setlist made a setlist');

    /* the pick dialog has no Escape handler of its own: Escape presses its Cancel */
    await newSet(page, 'Esc', ['One-page']);
    await page.focus('#view [data-addto]'); await page.keyboard.press('Enter');
    await page.locator('.modal .pick').waitFor();
    await checkDialog(page, 'Add songs dialog');
    await escapeBack(page, '#view [data-addto]', 'Add songs dialog');
    assert(await page.locator('#items > li.row').count() === 1, 'Escape on Add songs added songs');

    /* the note dialog over the viewer: Escape cancels the note only, the viewer stays in Annotate */
    await openSong(page, 'Three-page');
    await page.click('#vAnn');
    await page.click('#tools [data-tool=text]');
    const b = await page.locator('#stage .sheet').first().boundingBox();
    await page.mouse.click(b.x + b.width * .3, b.y + b.height * .5);
    await page.locator('.modal textarea').waitFor();
    await checkDialog(page, 'Note dialog');
    await page.keyboard.press('Escape');
    await noModal(page);
    assert(await page.locator('#viewer.on').count() && await page.locator('#tools').isVisible(), 'Escape in the note dialog also closed Annotate or the viewer');
    assert(!(await page.evaluate(() => document.querySelector('#viewer').inert)), 'viewer still inert');
    const notes = Object.values(await idbAll(page, 'ink')).flatMap(v => (v.strokes || []).filter(x => x.t === 'text' && !x.deleted));
    assert(!notes.length, 'Escape saved a note');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- (c) keyboard reorder and (d) tablet CSS ---------- */
async function reorderLoop(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    await importFixtures(page);
    const titles = ['One-page', 'Two-page', 'Three-page'];   // the set lists them in library order
    await newSet(page, 'Keys', titles);
    const set0 = (await liveSets(page)).find(x => x.name === 'Keys');
    const [i1, i2, i3] = set0.items.map(it => it.id);
    const t2 = (await idbAll(page, 'songs'))[i2].title, isT2 = t => t.startsWith(t2);
    const order = async () => (await liveSets(page)).find(x => x.name === 'Keys').items.map(it => it.id);
    const handle = n => page.locator('#items > li.row').nth(n).locator('.handle');
    const label = await handle(0).getAttribute('aria-label');
    assert(label === 'Drag to reorder, or press the up and down arrow keys', 'handle aria-label: ' + label);
    const focusedRow = () => page.evaluate(() => { const a = document.activeElement; return a && a.classList.contains('handle') ? [...a.closest('ul').children].indexOf(a.closest('li')) : -1; });
    const rowTitle = n => page.locator('#items > li.row').nth(n).locator('.t').innerText();
    const clearToast = () => page.evaluate(() => { document.querySelector('#toast').textContent = ''; });

    await handle(1).focus();
    assert(await focusedRow() === 1, 'second handle cannot take focus');
    await clearToast();
    await page.keyboard.press('ArrowUp');
    await waitFor(async () => (await order()).join() === [i2, i1, i3].join(), 'ArrowUp: stored order ' + (await order()).join() + ' != ' + [i2, i1, i3].join());
    await waitFor(async () => await focusedRow() === 0 && isT2(await rowTitle(0)), 'ArrowUp: focus is not on the moved item\'s handle (row ' + await focusedRow() + ')');
    const toast = await waitFor(async () => { const t = await page.locator('#toast').textContent(); return /Moved to position/.test(t) && t; }, 'no "Moved to position" toast');
    assert(toast === 'Moved to position 1 of 3', 'toast: ' + toast);
    assert(await page.getAttribute('#toast', 'role') === 'status', 'toast is not role=status');

    await page.reload();
    await page.waitForSelector('#libList');
    await page.click('#tSets');
    await page.locator('#view [data-set]', {hasText: 'Keys'}).click();
    await page.waitForSelector('#items');
    assert((await order()).join() === [i2, i1, i3].join(), 'order after reload ' + (await order()).join());
    assert(isT2(await rowTitle(0)), 'first row after reload: ' + await rowTitle(0));

    /* two quick presses run one after the other */
    await handle(0).focus();
    await clearToast();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await waitFor(async () => (await order()).join() === [i1, i3, i2].join(), 'ArrowDown x2: stored order ' + (await order()).join() + ' != ' + [i1, i3, i2].join());
    await waitFor(async () => await focusedRow() === 2 && isT2(await rowTitle(2)), 'ArrowDown x2: focus not on the moved item (row ' + await focusedRow() + ')');
    await waitFor(async () => await page.locator('#toast').textContent() === 'Moved to position 3 of 3', 'toast after ArrowDown x2: ' + await page.locator('#toast').textContent());
    /* at the end, ArrowDown changes nothing */
    await page.keyboard.press('ArrowDown');
    await sleep(400);
    assert((await order()).join() === [i1, i3, i2].join(), 'ArrowDown on the last row moved it');

    /* (d) tablet CSS */
    const home = await page.evaluate(() => {
      const cs = sel => getComputedStyle(document.querySelector(sel));
      return {btn: cs('#view [data-addto]').touchAction, handle: cs('#items .handle').touchAction, handleSel: cs('#items .handle').userSelect,
        body: cs('body').overscrollBehaviorY};
    });
    assert(home.btn === 'manipulation', 'button touch-action ' + home.btn);
    assert(home.handle === 'none', 'handle touch-action ' + home.handle);
    assert(home.handleSel === 'none', 'handle user-select ' + home.handleSel);
    assert(home.body !== 'none', 'body overscroll-behavior is none on the home screen');
    await page.click('#tLib');
    const field = await page.evaluate(() => getComputedStyle(document.querySelector('#q')).userSelect);
    assert(field !== 'none', 'search field user-select ' + field);
    await openSong(page, 'Three-page');
    const vw = await page.evaluate(() => {
      const cs = sel => getComputedStyle(document.querySelector(sel));
      return {ob: cs('#viewer').overscrollBehaviorY, obx: cs('#viewer').overscrollBehaviorX, us: cs('#viewer').userSelect, body: cs('body').overscrollBehaviorY,
        html: cs('html').overscrollBehaviorY, stage: cs('#stage').touchAction, cropper: cs('#cropper').overscrollBehaviorY};
    });
    assert(vw.ob === 'none' && vw.obx === 'none', 'viewer overscroll-behavior ' + vw.ob + '/' + vw.obx);
    assert(vw.us === 'none', 'viewer user-select ' + vw.us);
    assert(vw.body === 'none' && vw.html === 'none', `with the viewer open: body overscroll ${vw.body}, html ${vw.html}`);
    assert(vw.stage === 'none', 'stage touch-action ' + vw.stage);
    assert(vw.cropper === 'none', 'cropper overscroll-behavior ' + vw.cropper);
    const css = await page.evaluate(async () => (await fetch('css/app.css')).text());
    for(const k of ['top', 'bottom', 'left', 'right']) assert(css.includes(`env(safe-area-inset-${k})`), `css/app.css has no env(safe-area-inset-${k})`);
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'hygiene: CSP holds for import, view, ink, notes, crop, print, backup, restore, service worker, fonts', run: cspLoop},
  {name: 'hygiene: dialogs trap focus, Escape cancels, focus returns, page behind is inert', run: dialogLoop},
  {name: 'hygiene: setlist rows reorder with arrow keys; tablet CSS (overscroll, touch-action, safe areas)', run: reorderLoop},
];

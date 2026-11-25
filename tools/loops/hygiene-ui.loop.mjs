/*
 * Hygiene loops: the Content-Security-Policy holds for every feature, dialogs behave as real dialogs (focus, Tab,
 * Escape, inert page), setlist rows reorder from the keyboard, and the tablet CSS is in force.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import {FIX, TMP, JSZip, assert, sleep, sha256, idbAll, download, backupNow, wipe, restoreZip, PDFDocument, openShareMenu, openBackupMenu, driveBox, WEBKIT, openSetMenu} from './harness.mjs';
import {installFakeGoogle} from './fake-google.mjs';
import {setAct, setDelete, answerSetDelete} from './setrow.mjs';

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
  await sleep(450);                         // New setlist ignores a second tap within 400 ms of the last one (js/saving.js once()): a person cannot tap that fast
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
    /* pdf.js 3.11.174 is older than CVE-2024-4367, so every PDF must reach it with isEvalSupported:false (js/util.js's stand-in). The vendored
       library is wrapped, from before any page script, by a spy that records what each getDocument call RECEIVES: the stand-in then wraps the
       spy, so a stand-in that passes true, one that is missing, or a call that goes round it (through the prototype) shows up here. */
    await page.addInitScript(() => {
      let lib; window.__pdfOpens = [];
      Object.defineProperty(window, 'pdfjsLib', {configurable: true, get(){ return lib; }, set(v){
        if(!v || v.noEval || typeof v.getDocument !== 'function'){ lib = v; return; }      // the stand-in (js/util.js), or something that is not the library
        const real = v.getDocument;
        lib = Object.create(v, {getDocument: {value: src => { window.__pdfOpens.push({isEvalSupported: src ? src.isEvalSupported : undefined}); return real.call(v, src); }}});
      }});
    });
    const guarded = async what => {
      const opens = await page.evaluate(() => window.__pdfOpens || []);
      assert(opens.length > 0, `${what}: no PDF reached pdfjsLib.getDocument (the guard cannot be checked)`);
      const bad = opens.filter(o => o.isEvalSupported !== false);
      assert(!bad.length, `${what}: ${bad.length} of ${opens.length} PDF opens reached pdf.js without isEvalSupported:false (CVE-2024-4367 is blocked by this and by the page policy)`);
    };
    await s.goto();
    await s.swReady();

    /* the policy itself */
    const metas = await page.evaluate(() => [...document.querySelectorAll('meta[http-equiv]')].filter(m => /^content-security-policy$/i.test(m.httpEquiv)).map(m => m.content));
    assert(metas.length === 1, `${metas.length} CSP meta tags`);
    const dirs = Object.fromEntries(metas[0].split(';').map(d => d.trim()).filter(Boolean).map(d => { const [k, ...v] = d.split(/\s+/); return [k.toLowerCase(), v]; }));
    assert((dirs['default-src'] || []).join(' ') === "'self'", 'default-src is ' + JSON.stringify(dirs['default-src']));
    assert((dirs['script-src'] || []).join(' ') === "'self'", 'script-src is ' + JSON.stringify(dirs['script-src']));
    /* one outside host is allowed, by the Google Drive work order, and since 2026-11-24 only two paths of it: Drive's two API addresses, in connect-src and nowhere else */
    const GOOGLE_SOURCES = ['https://www.googleapis.com/drive/v3/', 'https://www.googleapis.com/upload/drive/v3/'];
    assert(JSON.stringify((dirs['connect-src'] || []).filter(x => /^[a-z]+:\/\//i.test(x)).sort()) === JSON.stringify([...GOOGLE_SOURCES].sort()),
      'connect-src does not hold exactly Drive\'s two API paths: ' + JSON.stringify(dirs['connect-src']));
    assert(!/unsafe-eval|wasm-unsafe-eval|\*/i.test(metas[0]) && GOOGLE_SOURCES.every(g => metas[0].split(g).length === 2) && !/https?:/i.test(GOOGLE_SOURCES.reduce((t, g) => t.split(g).join(''), metas[0])),
      'policy allows eval, a wildcard, the whole of www.googleapis.com or a host besides Drive\'s two API paths: ' + metas[0]);
    for(const [k, v] of Object.entries(dirs)) for(const src of v) assert(ALLOWED_SOURCES.has(src) || (k === 'connect-src' && GOOGLE_SOURCES.includes(src)), `${k} allows "${src}"`);
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
    await openSetMenu(page, 'print');
    await page.locator('.modal #pInk').setChecked(true);
    const pdf = await download(page, () => page.click('.modal [data-ok]'));
    if(await page.locator('.modal').count()){ await page.locator('.modal [data-x]').waitFor({timeout: 8000}); await page.click('.modal [data-x]'); }
    await noModal(page);
    const doc = await PDFDocument.load(await fsp.readFile(pdf.file));
    assert(doc.getPageCount() === 4, 'printed PDF has ' + doc.getPageCount() + ' pages, expected 4');
    await guarded('after importing, viewing, cropping and printing');

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
    await guarded('after the reload through the service worker');
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
    const boxes = document.querySelectorAll('.modal [role=dialog]'), box = boxes[boxes.length - 1]; if(!box) return null;      // the top one, when a dialog opened another
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
/* The setlist's More box by keyboard: focus the button, Enter, then Enter on the item. */
async function viaKeys(page, more, item){
  await page.focus(more); await page.keyboard.press('Enter');
  await page.locator('.modal.menubox').waitFor();
  await page.focus(`.modal.menubox [data-item="${item}"]`); await page.keyboard.press('Enter');
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

    /* library Edit (form), reached by keyboard through the row's one button, ⋯ (its menu box, then the Edit item); the dialog gives the focus back to ⋯ */
    const id = await page.locator('#libList [data-songmenu]').first().getAttribute('data-songmenu');
    const ed = `#libList [data-songmenu="${id}"]`;
    await viaKeys(page, ed, 'edit');
    await page.locator('.modal.menubox').waitFor({state: 'detached'});
    await page.locator('.modal').waitFor();
    await checkDialog(page, 'Edit dialog');
    await escapeBack(page, ed, 'Edit dialog');
    assert(!(await page.locator('.modal').count()), 'Edit dialog still open');

    /* library Copy (a text field) */
    const cp = ed;
    await viaKeys(page, cp, 'copy');
    await page.locator('.modal.copyask').waitFor();
    await checkDialog(page, 'Copy dialog');
    await escapeBack(page, cp, 'Copy dialog');

    /* Collections: the manager, the name dialog on top of it, then the Edit dialog's tick boxes */
    const mg = '#view [data-collmanage]';
    await page.focus(mg); await page.keyboard.press('Enter');
    await page.locator('.collmgr').waitFor();
    await checkDialog(page, 'Collections manager');
    await page.click('.collmgr [data-newcoll]');
    await page.locator('.collname').waitFor();
    await checkDialog(page, 'Collection name dialog');
    await page.keyboard.press('Escape');                                   // Escape on the name dialog closes only that one
    await page.waitForFunction(() => !document.querySelector('.collname') && !!document.querySelector('.collmgr'), null, {timeout: 5000})
      .catch(() => { throw new Error('Escape on the collection name dialog did not close just that dialog'); });
    assert(await page.evaluate(() => !!document.activeElement.closest('.collmgr')) && await page.evaluate(() => document.querySelector('.app').inert), 'after the name dialog closes, focus is not in the manager or the page is no longer inert');
    await page.click('.collmgr [data-newcoll]');
    await page.locator('.collname input').fill('Hygiene Band');
    await page.keyboard.press('Enter');                                     // Enter saves from the text field
    await page.waitForFunction(() => !document.querySelector('.collname'), null, {timeout: 5000});
    await page.locator('.collmgr .mname', {hasText: 'Hygiene Band'}).waitFor();
    await page.focus('.collmgr [data-mdel]'); await page.keyboard.press('Enter');    // first tap only arms it: nothing is deleted
    assert(await page.locator('.collmgr .mname', {hasText: 'Hygiene Band'}).count() === 1, 'one tap on Delete deleted the collection');
    await page.keyboard.press('Escape');                                    // Escape on the manager (Done)
    await noModal(page).catch(() => { throw new Error('Escape did not close the Collections manager'); });
    assert(await page.evaluate(() => document.activeElement === document.querySelector('[data-collmanage]')), 'focus did not return to the Collections button');
    await viaKeys(page, ed, 'edit');
    await page.locator('.modal fieldset.checks').waitFor();
    await checkDialog(page, 'Edit dialog with Collections tick boxes');
    await escapeBack(page, ed, 'Edit dialog with Collections tick boxes');

    /* a setlist's Add songs (numbers, a search box): focus starts on the dialog, not the search box; Escape adds nothing */
    const aSong = await page.locator('#libList [data-open] .t').first().evaluate(l => l.firstChild.textContent);
    await page.click('#tSets');

    /* Setlists -> Import from a text file: the review box traps focus, Escape writes nothing, focus goes back to the button */
    const it = '#view [data-importtext]', setsBefore = await page.locator('#view [data-set]').count();
    await page.focus(it);
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
    await fc.setFiles({name: 'Hygiene text.txt', mimeType: 'text/plain', buffer: Buffer.from(`${aSong}\nBreak\nNo such song at all\n`)});
    await page.locator('.modal.textimport').waitFor();
    await checkDialog(page, 'Text setlist review box');
    await escapeBack(page, it, 'Text setlist review box');
    assert(await page.locator('#view [data-set]').count() === setsBefore && !(await page.getByText('Hygiene text').count()), 'Escape on the text setlist review box made a setlist');

    await page.click('#view [data-newset]');
    await page.locator('.modal input[type=text]').fill('Pick Dialog');
    await page.click('.modal [data-ok]');
    await page.waitForSelector('#view [data-addto]');
    const at = '#view [data-addto]';
    await page.focus(at); await page.keyboard.press('Enter');
    await page.locator('.modal .pick').waitFor();
    assert(await page.evaluate(() => !document.activeElement.matches('input')), 'Add songs: the search box took focus when the dialog opened');
    await checkDialog(page, 'Add songs dialog (numbered, with a search box)');
    const labels = page.locator('.modal .pick label input');
    await labels.nth(1).check(); await labels.nth(0).check();
    assert(await page.locator('.modal [data-ok]').textContent() === 'Add 2', 'Add songs: the button count after two taps: ' + await page.locator('.modal [data-ok]').textContent());
    await page.fill('.modal .pickq', 'zzqx-nothing');
    assert(await page.locator('.modal [data-ok]').textContent() === 'Add 2', 'Add songs: the count changed while a search hid the numbered songs');
    await page.keyboard.press('Escape');                                    // Escape in the search box cancels the whole dialog
    await noModal(page).catch(() => { throw new Error('Add songs: Escape did not close the dialog'); });
    assert(await page.locator('#items > li.row').count() === 0, 'Add songs: Escape added songs');
    assert(await page.evaluate(sel => document.activeElement === document.querySelector(sel), at), 'Add songs: focus did not return to the Add songs button');
    await page.click('#view [data-allsets]');
    /* Delete a setlist: the menu item alone deletes nothing; Cancel and Escape in the question change nothing; Delete in the question deletes */
    const setsPre = JSON.stringify(await idbAll(page, 'sets'));
    await setAct(page, 'del');
    await page.locator('.modal.delask h2').waitFor({timeout: 5000});
    assert(await liveSets(page).then(x => x.length) === 1 && JSON.stringify(await idbAll(page, 'sets')) === setsPre, 'the Delete menu item alone changed the setlist');
    await answerSetDelete(page, false);
    assert(JSON.stringify(await idbAll(page, 'sets')) === setsPre && await page.locator('#view [data-set]').count() === 1, 'Cancel in the setlist Delete question changed something');
    await setAct(page, 'del');
    await page.locator('.modal.delask').waitFor({timeout: 5000});
    await page.keyboard.press('Escape');
    await noModal(page);
    assert(JSON.stringify(await idbAll(page, 'sets')) === setsPre && await page.locator('#view [data-set]').count() === 1, 'Escape in the setlist Delete question changed something');
    await sleep(450);
    await setDelete(page);                                                                      // the setlist was only for this check
    await page.waitForFunction(() => !document.querySelector('#view [data-set]'), null, {timeout: 5000});
    await page.click('#tLib');

    /* library Share songs (checklist), then the package-saved dialog */
    const sh = '#view [data-sharemenu]';                                     // Share songs sits in the Share / Import box; the dialogs it opens give focus back to this button
    const openShareSongs = async () => { await page.focus(sh); await page.keyboard.press('Enter'); await page.locator('.modal.menubox [data-item=share]').click(); };
    await openShareSongs();
    await page.locator('.modal .pick').waitFor();
    await checkDialog(page, 'Share songs dialog');
    await escapeBack(page, sh, 'Share songs dialog');
    await openShareSongs();
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

/* ---------- (b2) the gig-date dialogs: New setlist (name + date), Gig date, the once-per-tablet fill-in ----------
   Its own session: the fill-in comes up over the Setlists list the first time a setlist's name holds a full date, and would
   otherwise land on top of the other dialog checks. */
async function gigDialogLoop(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await s.goto();
    const ns = '#view [data-newset]', sets = async () => (await liveSets(page)).sort((a, b) => a.created - b.created);
    await page.click('#tSets');
    assert(!(await page.locator('.modal').count()), 'a dialog came up over an empty Setlists list');

    /* New setlist: a name and a date box; focus on the name; Escape makes nothing */
    await page.focus(ns); await page.keyboard.press('Enter');
    await page.locator('.modal input[type=text]').waitFor();
    assert(await page.locator('.modal input[type=date]').count() === 1, 'New setlist: no date box');
    assert(await page.evaluate(() => document.activeElement === document.querySelector('.modal input[type=text]')), 'New setlist: the name field does not have focus');
    await checkDialog(page, 'New setlist dialog (name and gig date)');
    await page.locator('.modal input[type=text]').fill('Escaped Gig');
    await page.locator('.modal input[type=date]').fill('2026-12-05');
    await page.focus('.modal input[type=text]');
    await escapeBack(page, ns, 'New setlist dialog (name and gig date)');
    assert(!(await sets()).length, 'Escape on New setlist made a setlist');

    /* Enter on Cancel cancels (it does not save from the name typed); Enter with no name saves nothing and keeps the dialog */
    await page.focus(ns); await page.keyboard.press('Enter');
    await page.locator('.modal input[type=text]').fill('Cancelled Gig');
    await page.focus('.modal [data-x]'); await page.keyboard.press('Enter');
    await noModal(page).catch(() => { throw new Error('New setlist: Enter on Cancel did not close the dialog'); });
    assert(!(await sets()).length, 'New setlist: Enter on Cancel made a setlist');
    await page.focus(ns); await page.keyboard.press('Enter');
    await page.locator('.modal input[type=text]').waitFor();
    await page.keyboard.press('Enter');
    await sleep(300);
    assert(await page.locator('.modal input[type=text]').count() === 1 && !(await sets()).length, 'New setlist: Enter with no name closed the dialog or made a setlist');

    /* Enter in the name field saves, with the date */
    await page.locator('.modal input[type=date]').fill('2026-12-05');
    await page.locator('.modal input[type=text]').fill('Hygiene Gig');
    await page.focus('.modal input[type=text]'); await page.keyboard.press('Enter');
    await noModal(page).catch(() => { throw new Error('New setlist: Enter in the name field did not save'); });
    await page.waitForSelector('#view [data-setmenu]');
    let [st] = await sets();
    assert(st && st.name === 'Hygiene Gig' && st.gig === '2026-12-05', 'New setlist: Enter in the name field saved ' + JSON.stringify(st));

    /* Gig date: the dialog shows the date; a changed box then Escape changes nothing */
    const gb = '#view [data-setmenu]';
    await viaKeys(page, gb, 'gig');
    await page.locator('.modal input[type=date]').waitFor();
    assert(await page.locator('.modal input[type=date]').inputValue() === '2026-12-05', 'Gig date dialog shows ' + await page.locator('.modal input[type=date]').inputValue());
    await checkDialog(page, 'Gig date dialog');
    await page.locator('.modal input[type=date]').fill('2027-01-09');
    await escapeBack(page, gb, 'Gig date dialog');
    let [now] = await sets();
    assert(JSON.stringify(now) === JSON.stringify(st), 'Escape on the Gig date dialog changed the setlist: ' + JSON.stringify(now));
    /* Cancel by Enter changes nothing either, Clear stays a real button */
    await viaKeys(page, gb, 'gig');
    await page.locator('.modal input[type=date]').fill('2027-01-09');
    await page.focus('.modal [data-x]'); await page.keyboard.press('Enter');
    await noModal(page);
    [now] = await sets();
    assert(JSON.stringify(now) === JSON.stringify(st), 'Enter on Cancel in the Gig date dialog changed the setlist: ' + JSON.stringify(now));

    /* the fill-in: a setlist whose name holds a full date, then the list; Escape = Not now: nothing written, never offered again */
    await page.click('#tSets');
    assert(!(await page.locator('.modal').count()), 'a dialog came up over the list before any name held a date');
    await page.focus(ns); await page.keyboard.press('Enter');
    await page.locator('.modal input[type=text]').fill('Sf October 18 2026');
    await sleep(450);                         // New setlist ignores a second tap within 400 ms of the last one (js/saving.js once()): a person cannot tap that fast
    await page.keyboard.press('Enter');
    await noModal(page);
    await page.waitForSelector('#view [data-setmenu]');
    assert(!(await page.locator('.modal').count()), 'the fill-in came up over an open setlist');
    const before = await sets();
    await page.focus('#tSets'); await page.keyboard.press('Enter');
    await page.locator('.modal h2', {hasText: 'Fill in gig dates?'}).waitFor({timeout: 5000}).catch(() => { throw new Error('the fill-in dialog did not come up'); });
    const opts = await page.evaluate(() => [...document.querySelectorAll('.modal label.opt input')].map(i => i.checked));
    assert(opts.length === 1 && opts[0], 'fill-in: expected one ticked row, got ' + JSON.stringify(opts));
    await checkDialog(page, 'Fill-in dialog');
    await escapeBack(page, '#tSets', 'Fill-in dialog');
    assert(JSON.stringify(await sets()) === JSON.stringify(before), 'Escape on the fill-in wrote to a setlist: ' + JSON.stringify(await sets()));
    assert(await page.evaluate(() => localStorage.getItem('ss-gig-fill')) !== null, 'Escape on the fill-in did not note the answer (ss-gig-fill)');
    await page.click('#tLib'); await page.click('#tSets');
    await page.waitForSelector(ns);
    await sleep(300);
    assert(!(await page.locator('.modal').count()), 'the fill-in was offered again after Escape');
    await page.reload();
    await page.waitForSelector('#libList');
    await page.click('#tSets');
    await page.waitForSelector(ns);
    await sleep(300);
    assert(!(await page.locator('.modal').count()), 'the fill-in was offered again after a reload');
    assert(JSON.stringify(await sets()) === JSON.stringify(before), 'the setlists changed after the fill-in was declined');
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* ---------- (b3) the download dialogs: Download <name>, Download all, and the Download all busy box ----------
   The busy box is held open by a readwrite transaction on `files` in a second connection (the size estimate's reads wait
   behind it), so it stays up for the focus checks; Escape (= Stop) lets it go 300 ms later. */
async function downloadDialogLoop(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    let downloads = 0;
    page.on('download', () => downloads++);
    await s.goto();
    await importFixtures(page);
    await newSet(page, 'Dl A', ['One-page']);
    await newSet(page, 'Dl B', ['Two-page']);
    const before = JSON.stringify(await liveSets(page));

    /* Download <name> on an open setlist */
    const pb = '#view [data-setmenu]';
    await viaKeys(page, pb, 'print');
    await page.locator('.modal h2', {hasText: 'Download Dl B'}).waitFor({timeout: 5000}).catch(() => { throw new Error('the Download Dl B dialog did not open'); });
    await checkDialog(page, 'Download <name> dialog');
    await escapeBack(page, pb, 'Download <name> dialog');

    /* Download all on the list */
    await page.click('#view [data-allsets]');
    const da = '#view [data-dlall]';
    await page.waitForSelector(da + ':not([disabled])');
    await page.focus(da); await page.keyboard.press('Enter');
    await page.locator('.modal h2', {hasText: 'Download all setlists'}).waitFor({timeout: 5000}).catch(() => { throw new Error('the Download all dialog did not open'); });
    assert(!(await page.locator('.modal #dInk').count()), 'the Download all dialog still has an annotations tick box');
    const btns = (await page.locator('.modal .btns button').allTextContents()).join('|');
    assert(btns === 'Cancel|Make zip', 'the Download all buttons read ' + btns);
    await checkDialog(page, 'Download all dialog');
    await escapeBack(page, da, 'Download all dialog');

    /* the busy box: held open, focus trapped; Escape = Stop, then nothing is downloaded */
    await page.evaluate(() => new Promise((res, rej) => {
      const r = indexedDB.open('setlist-stand');
      r.onerror = () => rej(r.error);
      r.onsuccess = () => {
        const d = r.result, tx = d.transaction('files', 'readwrite'), st = tx.objectStore('files');
        const spin = () => { if(!window.__dlRelease) st.count().onsuccess = spin; };
        spin();
        tx.oncomplete = () => d.close();
        addEventListener('keydown', e => { if(e.key === 'Escape') setTimeout(() => { window.__dlRelease = true; }, 300); }, {capture: true});
        res();
      };
    }));
    await page.focus(da); await page.keyboard.press('Enter');
    await page.locator('.modal [data-ok]').waitFor();
    await page.focus('.modal [data-ok]'); await page.keyboard.press('Enter');
    await page.locator('.modal h2', {hasText: 'Downloading setlists'}).waitFor({timeout: 5000}).catch(() => { throw new Error('the busy box did not open'); });
    assert(await page.locator('.modal [role=status]').textContent() === 'Getting ready…', 'busy box status: ' + await page.locator('.modal [role=status]').textContent());
    await checkDialog(page, 'Download all busy box');
    assert(await page.locator('.modal h2', {hasText: 'Downloading setlists'}).count() === 1, 'the busy box closed before Escape (the hold did not hold)');
    await escapeBack(page, da, 'Download all busy box (Escape = Stop)');
    await page.waitForFunction(() => document.querySelector('#toast.on')?.textContent === 'Stopped. Nothing was downloaded.', null, {timeout: 5000})
      .catch(async () => { throw new Error('after Escape on the busy box the toast reads "' + await page.locator('#toast').textContent() + '"'); });
    await sleep(1500);
    assert(!downloads, `${downloads} download(s) started from the download dialogs`);
    assert(JSON.stringify(await liveSets(page)) === before, 'the download dialogs changed a setlist');
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

/* ---------- (e) the Library's menu boxes (Share / Import now; reused for the others) ---------- */
/* Any menu box: the heading and the items with their one-line hints are exactly `want`, the tap targets are big, the box
   fits the screen, focus is inside and Tab / Shift+Tab never leave it, Escape and Cancel close it and put the focus back
   on the button that opened it. `sel` finds the menu button, `buttonText` is its text. */
async function checkMenuBox(page, sel, buttonText, title, want, at){
  const btn = page.locator(sel);
  const back = async how => assert(await btn.evaluate(b => b === document.activeElement), `${at}: ${how} did not give the focus back to ${buttonText}`);
  for(const how of ['Escape', 'Cancel']){
    await btn.focus(); await page.keyboard.press('Enter');
    await page.locator('.modal.menubox').waitFor();
    if(how === 'Escape'){
      await checkDialog(page, `${at} ${buttonText} box`);
      const d = await page.evaluate(() => {
        const m = document.querySelector('.modal.menubox'), r = m.querySelector('[role=dialog]').getBoundingClientRect();
        return {title: m.querySelector('h2').textContent,
          items: [...m.querySelectorAll('[data-item]')].map(x => ({id: x.dataset.item, label: x.querySelector('b').textContent, hint: x.querySelector('span').textContent, h: x.getBoundingClientRect().height})),
          buttons: [...m.querySelectorAll('button')].map(x => x.textContent.replace(/\s+/g, ' ').trim()), cancelH: m.querySelector('[data-x]').getBoundingClientRect().height,
          fits: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight};
      });
      assert(d.title === title, `${at}: the box is titled ${d.title}`);
      assert(JSON.stringify(d.items.map(({id, label, hint}) => [id, label, hint])) === JSON.stringify(want), `${at}: the items are ${JSON.stringify(d.items)}`);
      assert(d.buttons.length === want.length + 1 && d.buttons[want.length] === 'Cancel', `${at}: the box holds ${JSON.stringify(d.buttons)}`);
      assert(d.items.every(x => x.h >= 44) && d.cancelH >= 44, `${at}: a tap target is under 44 px: ${JSON.stringify(d.items.map(x => x.h))} ${d.cancelH}`);
      assert(d.fits, `${at}: the box does not fit the screen`);
      await escapeBack(page, sel, `${at} ${buttonText} box`);
    }else{
      await page.click('.modal.menubox [data-x]'); await noModal(page);
      await back('Cancel');
    }
  }
}
async function shareMenuLoop(ctx){
  for(const [w, h] of [[1280, 800], [800, 1280]]){
    const s = await ctx.session({viewport: {width: w, height: h}});
    const at = `${w}x${h}`;
    try{
      const {page} = s;
      await s.goto();
      await importFixtures(page);

      /* the top: row 1 is the search box and Add PDFs; row 2 (#libMenus) holds the menu buttons; the three old buttons are gone */
      for(const gone of ['[data-split]', '[data-sharesongs]', '[data-shareimport]']) assert(await page.locator('#view ' + gone).count() === 0, `${at}: the Library still has ${gone}`);
      const row1 = await page.locator('#view .bar').first().locator('button').allTextContents();
      assert(JSON.stringify(row1) === JSON.stringify(['Add PDFs']), `${at}: row 1 holds ${JSON.stringify(row1)}`);
      const row2 = await page.locator('#view #libMenus button').allTextContents();
      assert(row2[0] === 'Share / Import' && await page.locator('#view [data-sharemenu]').count() === 1, `${at}: row 2 holds ${JSON.stringify(row2)}`);
      assert(await page.evaluate(() => document.querySelector('#libMenus').previousElementSibling === document.querySelector('#view .bar')), `${at}: row 2 is not right under row 1`);

      await checkMenuBox(page, '#view [data-sharemenu]', 'Share / Import', 'Share / Import', [
        ['split', 'Split a songbook', 'Cut one big PDF into separate songs'],
        ['import', 'Import a share package', 'Add songs from a file someone sent you'],
        ['chartupdate', 'Import chart updates', 'Replace charts with cleaned-up versions from one file'],
        ['share', 'Share songs', 'Pick songs, or send a setlist, as one file']], at);
      assert(await page.locator('#splitter:not([hidden])').count() === 0 && await page.locator('.modal').count() === 0, `${at}: Cancel started something`);

      /* each item starts its own action, and the box is gone */
      for(const [item, id] of [['split', 'splitFile'], ['import', 'shareFile'], ['chartupdate', 'chartUpdateFile']]){
        const [fc] = await Promise.all([page.waitForEvent('filechooser', {timeout: 8000}), openShareMenu(page, item)]);
        assert(await fc.element().evaluate(e => e.id) === id, `${at}: ${item} opened the wrong file chooser`);
        await noModal(page);
      }
      await openShareMenu(page, 'share');
      await page.locator('.modal .pick').waitFor();
      assert(await page.locator('.modal.menubox').count() === 0, `${at}: the Share / Import box is still open behind the Share songs list`);
      assert((await page.locator('.modal [role=dialog] h2').first().textContent()).startsWith('Share songs'), `${at}: Share songs did not open its list`);
      await escapeBack(page, '#view [data-sharemenu]', `${at} Share songs from the box`);
    } finally { await s.close(); }
  }
}


/* ---------- (e3) Import chart updates: the list is a real dialog (js/chartupdate.js) ---------- */
async function chartUpdateDialogLoop(ctx){
  for(const [w, h] of [[1280, 800], [800, 1280]]){
    const s = await ctx.session({viewport: {width: w, height: h}});
    const at = `chart updates ${w}x${h}`;
    try{
      const {page} = s;
      await s.goto(); await importFixtures(page);
      const newPdf = await fsp.readFile(path.join(FIX, 'three-page.pdf'));
      const z = new JSZip();
      /* the library holds "One-page"; the file offers 40 charts: one for it (by name) and 39 that are new songs, so the list must scroll */
      const charts = [{id: 'c1', target: 'gone', song: 'One-page', artist: '', version: '', hash: sha256(newPdf)}];
      z.file('files/c1.pdf', newPdf);
      for(let i = 2; i <= 40; i++){ const d = await PDFDocument.create(); d.addPage([200, 200]).drawText('x' + i, {x: 10, y: 100}); const b = Buffer.from(await d.save({updateMetadata: false}));
        charts.push({id: 'c' + i, target: 'gone' + i, song: 'Brand new ' + i, artist: '', version: '', hash: sha256(b)}); z.file('files/c' + i + '.pdf', b); }
      z.file('update.json', JSON.stringify({app: 'setlist-stand', kind: 'chart-update', version: 1, made: 'x', charts}));
      const file = {name: 'u.zip', mimeType: 'application/zip', buffer: Buffer.from(await z.generateAsync({type: 'nodebuffer'}))};
      const before = JSON.stringify(Object.values(await idbAll(page, 'songs')).map(x => [x.id, x.updated, x.hash]).sort());
      await page.setInputFiles('#chartUpdateFile', file);
      await page.locator('.modal .cu-list .cu-row').first().waitFor({timeout: 30000});
      await checkDialog(page, at + ' list');
      const fit = await page.evaluate(() => { const b = document.querySelector('.modal.chartupdate [role=dialog]').getBoundingClientRect(), ok = document.querySelector('.modal.chartupdate [data-ok]').getBoundingClientRect(), l = document.querySelector('.cu-list');
        return {box: b.bottom <= innerHeight && b.top >= 0, ok: ok.bottom <= innerHeight && ok.top >= 0, scrolls: l.scrollHeight > l.clientHeight, okH: ok.height}; });
      assert(fit.box && fit.ok, `${at}: the buttons are not on the screen: ${JSON.stringify(fit)}`);
      assert(fit.scrolls && fit.okH >= 44, `${at}: the list does not scroll, or the button is small: ${JSON.stringify(fit)}`);
      /* Escape is Cancel: nothing is written, the page is alive again */
      await page.keyboard.press('Escape'); await noModal(page);
      assert(await page.evaluate(() => !document.querySelector('.app').inert), `${at}: the page is still inert after Escape`);
      assert(JSON.stringify(Object.values(await idbAll(page, 'songs')).map(x => [x.id, x.updated, x.hash]).sort()) === before, `${at}: Escape on the list changed the library`);
      assert(s.errors.length === 0, `${at}: page errors: ` + s.errors.join(' | '));
    } finally { await s.close(); }
  }
}

/* ---------- (e2) the open setlist's More box (Jonathan, 2026-11-22: the setlist bar was crowded) ---------- */
const SETMENU_ITEMS = (gigHint, colls = true) => [
  ['gig', 'Gig date', gigHint],
  ['ready', 'Ready check', 'Open every chart now to be sure each one is here'],
  ['print', 'Download PDF', 'Save the songs as one PDF'],
  ['share', 'Share', 'Send this setlist and its songs as one file'],
  ['dup', 'Duplicate', 'Make a copy of this setlist'],
  ['rename', 'Rename', 'Change the name'],
  ...(colls ? [['colls', 'Collections', 'Choose which collections it is in']] : [])];
async function setMenuLoop(ctx){
  for(const [w, h] of [[1280, 800], [800, 1280]]){
    const s = await ctx.session({viewport: {width: w, height: h}});
    const at = `${w}x${h}`, more = '#view [data-setmenu]';
    try{
      const {page} = s;
      await s.goto();
      await importFixtures(page);
      /* a collection, so the Collections item is there */
      await page.click('[data-collmanage]'); await page.locator('.collmgr').waitFor();
      await page.click('.collmgr [data-newcoll]'); await page.locator('.collname input').fill('Menu Band'); await page.keyboard.press('Enter');
      await page.locator('.collmgr .mname', {hasText: 'Menu Band'}).waitFor(); await page.keyboard.press('Escape'); await noModal(page);

      /* an EMPTY setlist: the bar, the old buttons gone, Download PDF and Share greyed */
      await page.click('#tSets'); await page.click('#view [data-newset]');
      await page.locator('.modal input[type=text]').fill('Empty menu'); await page.click('.modal [data-ok]');
      await page.waitForSelector(more);
      const bar = await page.locator('#view .bar').nth(1).locator('button').allTextContents();
      assert(JSON.stringify(bar) === JSON.stringify(['Play setlist', 'Add songs', 'Add break', 'More']), `${at}: the bar holds ${JSON.stringify(bar)}`);
      assert(JSON.stringify(await page.locator('#view .bar').first().locator('button').allTextContents()) === JSON.stringify(['‹ Setlists']), `${at}: the top row changed`);
      for(const gone of ['[data-print]', '[data-shareset]', '[data-dup]', '[data-renset]', '[data-gig]', '[data-setcolls]'])
        assert(await page.locator('#view ' + gone).count() === 0, `${at}: the setlist screen still has ${gone}`);
      assert(await page.locator('#view [data-play]').isDisabled(), `${at}: Play setlist is on for an empty setlist`);
      const barH = await page.locator('#view .bar').nth(1).locator('button').evaluateAll(bs => bs.map(b => b.getBoundingClientRect().height));
      assert(barH.every(x => x >= 44), `${at}: a bar button is under 44 px: ${JSON.stringify(barH)}`);
      await checkMenuBox(page, more, 'More', 'Empty menu', SETMENU_ITEMS('Set or change the date of this gig'), at);
      await page.focus(more); await page.keyboard.press('Enter'); await page.locator('.modal.menubox').waitFor();
      const off = await page.locator('.modal.menubox [data-item]').evaluateAll(bs => bs.map(b => [b.dataset.item, b.disabled]));
      assert(JSON.stringify(off) === JSON.stringify([['gig', false], ['ready', true], ['print', true], ['share', true], ['dup', false], ['rename', false], ['colls', false]]), `${at}: disabled items of an empty setlist ${JSON.stringify(off)}`);
      await page.keyboard.press('Escape'); await noModal(page);

      /* songs and a date: Download PDF and Share on, the date in the Gig date hint in the screen's own words */
      await page.click('#view [data-addto]'); await page.locator('.modal .pick').waitFor();
      for(const t of ['One-page', 'Two-page']) await page.locator('.modal .pick label', {hasText: t}).locator('input').check();
      await page.click('.modal [data-ok]');
      await page.waitForFunction(() => document.querySelectorAll('#items > li.row').length === 2);
      await openSetMenu(page, 'gig');
      await page.locator('.modal input[type=date]').fill('2026-12-05'); await page.click('.modal [data-ok]'); await noModal(page);
      await page.locator('#view .gigline').waitFor();
      const line = await page.locator('#view .gigline').textContent();
      assert(/2026/.test(line) && /5/.test(line), `${at}: the gig line reads ${line}`);
      await checkMenuBox(page, more, 'More', 'Empty menu', SETMENU_ITEMS(`${line} (tap to change)`), at + ' dated');
      await page.focus(more); await page.keyboard.press('Enter'); await page.locator('.modal.menubox').waitFor();
      const on = await page.locator('.modal.menubox [data-item]').evaluateAll(bs => bs.map(b => b.disabled));
      assert(on.every(x => !x), `${at}: an item is off for a setlist with songs: ${JSON.stringify(on)}`);
      await page.keyboard.press('Escape'); await noModal(page);
      const backOnMore = async what => assert(await waitFor(async () => page.evaluate(sel => document.activeElement === document.querySelector(sel), more), `${at}: ${what}: focus is not on More; it is on ` + await page.evaluate(() => document.activeElement && document.activeElement.outerHTML.slice(0, 80))), what);

      /* each item starts its own action; closing the dialog gives the focus back to More */
      await viaKeys(page, more, 'gig');
      await page.locator('.modal input[type=date]').waitFor();
      assert(await page.locator('.modal input[type=date]').inputValue() === '2026-12-05', `${at}: Gig date opened with another date`);
      await escapeBack(page, more, `${at} Gig date from the box`);
      await viaKeys(page, more, 'ready');
      await page.locator('.modal h2', {hasText: 'Ready check'}).waitFor({timeout: 5000});
      await page.locator('.modal [data-x]', {hasText: 'Close'}).waitFor({timeout: 15000});      // while it runs Escape means Stop; once it is done Escape closes
      await escapeBack(page, more, `${at} Ready check from the box`);
      await viaKeys(page, more, 'print');
      await page.locator('.modal h2', {hasText: 'Download Empty menu'}).waitFor({timeout: 5000});
      await escapeBack(page, more, `${at} Download PDF from the box`);
      await viaKeys(page, more, 'colls');
      await page.locator('.modal h2', {hasText: 'Collections of Empty menu'}).waitFor({timeout: 5000});
      await page.locator('.modal fieldset.checks').waitFor();
      await escapeBack(page, more, `${at} Collections from the box`);
      const sharePk = await download(page, () => viaKeys(page, more, 'share'));
      assert(/Setlist Stand share\.zip$/.test(sharePk.name), `${at}: Share saved ${sharePk.name}`);
      await page.locator('.modal h2', {hasText: 'Package saved'}).waitFor({timeout: 8000});
      await page.keyboard.press('Escape'); await noModal(page);
      await backOnMore('Share from the box, after Done');
      await viaKeys(page, more, 'rename');
      await page.locator('.modal h2', {hasText: 'Rename setlist'}).waitFor({timeout: 5000});
      await escapeBack(page, more, `${at} Rename from the box`);
      const nameBefore = (await liveSets(page)).map(x => x.name).sort().join('|');
      assert(nameBefore === 'Empty menu', `${at}: the dialogs changed a setlist: ${nameBefore}`);

      /* Rename saves: the screen is drawn again, and the focus lands on the new More button */
      await viaKeys(page, more, 'rename');
      await page.locator('.modal input[type=text]').fill('Menu renamed'); await page.keyboard.press('Enter'); await noModal(page);
      await page.waitForFunction(() => document.querySelector('#view h2')?.textContent === 'Menu renamed');
      await backOnMore('Rename saved');
      /* Duplicate makes the copy and opens it, with the focus on its More button */
      await viaKeys(page, more, 'dup');
      await page.waitForFunction(() => document.querySelector('#view h2')?.textContent === 'Menu renamed copy', null, {timeout: 5000});
      await backOnMore('Duplicate');
      const names = (await liveSets(page)).map(x => x.name).sort();
      assert(JSON.stringify(names) === JSON.stringify(['Menu renamed', 'Menu renamed copy']), `${at}: the setlists are ${JSON.stringify(names)}`);
      assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
  }
}

/* ---------- (f) the Back up / Sync box and the Google Drive box ---------- */
const NOT_SET_UP = 'Sync keeps your songs, setlists, collections and your pen marks and notes the same on your tablets, through your own Google Drive. Not synced on this tablet yet. Sync is not a backup.';
/* The Google Drive box as it is drawn: its heading, the status sentence, the buttons (data name and text) and their heights, the
   read-only line at the bottom of the Library, and whether the box fits the screen. */
const driveDrawn = page => page.evaluate(() => {
  const m = document.querySelector('.modal.drivebox'); if(!m) return null;
  const c = m.querySelector('#driveCtl'), st = c.querySelector('[data-drivestatus]'), line = document.querySelector('#libDriveLine'), r = m.querySelector('[role=dialog]').getBoundingClientRect();
  return {title: m.querySelector('h2').textContent, status: st ? st.textContent : null, warn: !!(st && st.classList.contains('warnline')),
    buttons: [...c.querySelectorAll('button')].map(b => [Object.keys(b.dataset)[0], b.textContent]), close: m.querySelector(':scope > [role=dialog] > .btns').textContent.trim(),
    heights: [...m.querySelectorAll('button')].map(b => b.getBoundingClientRect().height),
    line: line ? line.textContent : null, lineButtons: line ? line.querySelectorAll('button').length : -1, lineWarn: !!(line && line.querySelector('.warnline')),
    fits: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, focusIn: m.contains(document.activeElement)};
});
async function driveBoxIs(page, at, what, status, buttons, warn = false){
  const d = await driveDrawn(page);
  assert(d, `${at} ${what}: the Google Drive box is not open`);
  assert(d.title === 'Google Drive' && d.close === 'Close', `${at} ${what}: the box is titled "${d.title}" with "${d.close}"`);
  assert(status.test(d.status), `${at} ${what}: the box says "${d.status}"`);
  assert(JSON.stringify(d.buttons) === JSON.stringify(buttons), `${at} ${what}: the box holds ${JSON.stringify(d.buttons)}`);
  assert(d.warn === warn && d.lineWarn === warn, `${at} ${what}: the sentence is${d.warn ? '' : ' not'} drawn as a warning (the bottom line: ${d.lineWarn})`);
  assert(d.line === d.status && d.lineButtons === 0, `${at} ${what}: the Library's bottom line says "${d.line}" (${d.lineButtons} buttons), the box "${d.status}"`);
  assert(d.heights.every(h => h >= 44), `${at} ${what}: a tap target is under 44 px: ${JSON.stringify(d.heights)}`);
  assert(d.fits, `${at} ${what}: the box does not fit the screen`);
  return d;
}
const BACKUP_ITEMS = hintSync => [
  ['backup', 'Back up everything', 'Save one file with every PDF, setlist and note'],
  ['restore', 'Restore from backup', 'Bring your library back from a backup file'],
  ['sync', 'Sync with Google Drive', hintSync],
  ['drive', 'Google Drive settings', 'Connect or disconnect']];
async function backupMenuLoop(ctx){
  for(const [w, h] of [[1280, 800], [800, 1280]]){
    /* Playwright's WebKit cannot intercept a request made by a page a service worker controls (see sync.loop.mjs): off there */
    const s = await ctx.session({viewport: {width: w, height: h}, serviceWorkers: WEBKIT ? 'block' : 'allow'});
    const at = `${w}x${h}`, opener = '#view [data-backupmenu]';
    try{
      const {page} = s;
      const google = await installFakeGoogle(s.context, {appBase: ctx.base});
      await s.goto();
      await importFixtures(page);

      /* row 2 holds both menu buttons; the old bottom buttons and the old Drive control are gone */
      const row2 = await page.locator('#view #libMenus button').allTextContents();
      assert(JSON.stringify(row2) === JSON.stringify(['Share / Import', 'Back up / Sync']), `${at}: row 2 holds ${JSON.stringify(row2)}`);
      for(const gone of ['[data-backup]', '[data-restore]', '#libDrive', '[data-driveconnect]', '[data-drivedisconnect]', '[data-syncnow]'])
        assert(await page.evaluate(sel => [...document.querySelectorAll('#view ' + sel)].filter(e => !e.closest('#libNudge')).length, gone) === 0, `${at}: the Library still has ${gone}`);
      /* the bottom: Show archived, the backup hint, ONE read-only Drive line, then the status lines; nothing else */
      const bottom = await page.evaluate(() => {
        const list = document.querySelector('#libWrap'), out = [];       // the list and the A to Z strip's column are in #libWrap
        for(let e = list.nextElementSibling; e; e = e.nextElementSibling) out.push(e.id || e.className);
        const line = document.querySelector('#libDriveLine');
        return {out, line: line && line.textContent, buttons: line ? line.querySelectorAll('button').length : -1,
          hint: document.querySelector('#libBackupHint')?.textContent};
      });
      assert(JSON.stringify(bottom.out) === JSON.stringify(['sw-row', 'libBackupHint', 'libDriveLine', 'libSafety']), `${at}: the bottom of the Library holds ${JSON.stringify(bottom.out)}`);
      assert(bottom.line === NOT_SET_UP && bottom.buttons === 0, `${at}: the Drive line at the bottom says "${bottom.line}" with ${bottom.buttons} buttons`);
      assert(/one \.zip file with every PDF, setlist and annotation.*Google Drive.*another tablet/.test(bottom.hint || ''), `${at}: the backup hint is "${bottom.hint}"`);

      /* the box itself: exact items and hints, focus, Escape and Cancel; Drive not used here yet */
      await checkMenuBox(page, opener, 'Back up / Sync', 'Back up / Sync', BACKUP_ITEMS('Connect Google Drive first'), at);
      assert(await page.locator('.modal').count() === 0, `${at}: Cancel started something`);

      /* each item starts its own action, and the box is gone */
      const dl = await download(page, () => openBackupMenu(page, 'backup'));
      assert(/^setlist-stand-backup-\d{4}-\d\d-\d\d-\d{4}\.zip$/.test(dl.name) && (await JSZip.loadAsync(await fsp.readFile(dl.file))).file('library.json'), `${at}: Back up everything gave ${dl.name}`);
      await noModal(page);
      assert(await page.locator(opener).textContent() === 'Back up / Sync' && await page.locator(opener).isEnabled(), `${at}: the Back up / Sync button was not given back after the backup`);
      const [fc] = await Promise.all([page.waitForEvent('filechooser', {timeout: 8000}), openBackupMenu(page, 'restore')]);
      assert(await fc.element().evaluate(e => e.id) === 'restoreFile', `${at}: Restore from backup opened the wrong file chooser`);
      await noModal(page);
      await openBackupMenu(page, 'sync');
      await page.locator('.modal [role=dialog]', {hasText: 'Sync your tablets'}).waitFor({timeout: 8000});
      assert(await page.locator('.modal.menubox').count() === 0 && await page.locator('.modal').count() === 1, `${at}: Sync with Google Drive did not open the first-time note alone`);
      await checkDialog(page, `${at} Sync from the box`);
      await escapeBack(page, opener, `${at} Sync from the box`);
      assert(google.requests.length === 0, `${at}: Google was called before anyone said Continue`);

      /* Google Drive settings: the box, not connected */
      await openBackupMenu(page, 'drive');
      await page.locator('.modal.drivebox').waitFor({timeout: 8000});
      assert(await page.locator('.modal').count() === 1, `${at}: the Back up / Sync box is still open behind the Google Drive box`);
      await driveBoxIs(page, at, 'not connected', new RegExp('^' + NOT_SET_UP.replace(/\./g, '\\.') + '$'), [['syncnow', 'Sync'], ['driveconnect', 'Connect Google Drive']]);
      await checkDialog(page, `${at} Google Drive box`);
      await escapeBack(page, opener, `${at} Google Drive box (Escape)`);
      await driveBox(page);
      await page.click('.modal.drivebox > [role=dialog] > .btns [data-x]'); await noModal(page);
      assert(await page.evaluate(sel => document.activeElement === document.querySelector(sel), opener), `${at}: Close on the Google Drive box did not give the focus back to Back up / Sync`);

      /* connected: Connect in the box goes to Google and comes back */
      Object.assign(google.auth, {mode: 'ok', expiresIn: 3599});
      await driveBox(page);
      await page.click('.modal.drivebox [data-driveconnect]');
      await page.click('.modal [data-ok]');
      await waitFor(() => page.evaluate(() => document.readyState === 'complete' && /Connected to Google Drive until/.test(document.querySelector('#libDriveLine')?.textContent || '')).catch(() => false), `${at}: not connected after the sign-in`, 20000);
      await sleep(300);
      if(await page.locator('.modal').count()) throw new Error(`${at}: a box after signing in: ` + await page.locator('.modal').last().textContent());
      await checkMenuBox(page, opener, 'Back up / Sync', 'Back up / Sync', BACKUP_ITEMS('Keep your tablets the same'), `${at} connected`);
      await driveBox(page);
      await driveBoxIs(page, at, 'connected', /^Connected to Google Drive until .+\. Not synced on this tablet yet\.$/, [['syncnow', 'Sync'], ['drivedisconnect', 'Disconnect']]);
      /* Google takes the token back during a Sync (the first Sync on this tablet starts with its note: Continue): the report comes over the
         box, OK gives the focus back inside the box, which is still right, and the box shows the new state at once (Connect, no Disconnect) */
      google.expire();
      await page.click('.modal.drivebox [data-syncnow]');
      await page.locator('.modal [role=dialog]', {hasText: 'Sync your tablets'}).waitFor({timeout: 8000});
      await page.locator('.modal').last().locator('[data-ok]').click();
      await page.locator('.modal [role=dialog]', {hasText: 'Sync could not finish'}).waitFor({timeout: 20000});
      await checkDialog(page, `${at} Sync report`);
      assert(/Your Google sign-in ran out\. Tap Sync to sign in again/.test(await page.locator('.modal').last().textContent()), `${at}: a refused token was not said in the report`);
      await page.locator('.modal').last().locator('[data-ok]').click();
      await waitFor(() => page.evaluate(() => document.querySelectorAll('.modal').length === 1), `${at}: the Sync report did not close`);
      const after = await driveBoxIs(page, at, 'after a refused token', new RegExp('^' + NOT_SET_UP.replace(/\./g, '\\.') + '$'), [['syncnow', 'Sync'], ['driveconnect', 'Connect Google Drive']]);
      assert(after.focusIn, `${at}: after OK on the Sync report focus is not in the Google Drive box`);
      /* connect again, then the sign-in runs out while the box is open: it is redrawn in place */
      await page.click('.modal.drivebox [data-driveconnect]');
      await page.click('.modal [data-ok]');
      await waitFor(() => page.evaluate(() => document.readyState === 'complete' && /Connected to Google Drive until/.test(document.querySelector('#libDriveLine')?.textContent || '')).catch(() => false), `${at}: not connected after signing in again`, 20000);
      await sleep(300);
      await driveBox(page);
      await page.clock.setFixedTime(Date.now() + 4000e3);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));          // the tablet is picked up again
      await driveBoxIs(page, at, 'sign-in ended', /^Your Google sign-in ran out at .+\. Tap Sync or Connect again\. Not synced on this tablet yet\.$/,
        [['syncnow', 'Sync'], ['driveconnect', 'Connect again'], ['drivedisconnect', 'Disconnect']], true);
      /* Disconnect from the box: the box shows Connect at once, the focus stays in it, Close gives it back to the menu button */
      await page.click('.modal.drivebox [data-drivedisconnect]');
      await page.locator('.modal').last().locator('[data-ok]').click();
      await waitFor(() => page.evaluate(() => document.querySelectorAll('.modal').length === 1), `${at}: the Disconnect dialog did not close`);
      const off = await driveBoxIs(page, at, 'after Disconnect', new RegExp('^' + NOT_SET_UP.replace(/\./g, '\\.') + '$'), [['syncnow', 'Sync'], ['driveconnect', 'Connect Google Drive']]);
      assert(off.focusIn, `${at}: after Disconnect focus is not in the Google Drive box`);
      await escapeBack(page, opener, `${at} Google Drive box after Disconnect`);
      const errs = s.errors.filter(e => e.startsWith('pageerror'));                              // (the 401 of the refused token is logged by the browser on purpose)
      assert(!errs.length, `${at}: page errors: ` + errs.join(' | '));
    } finally { await s.close(); }
  }
}

export const loops = [
  {name: 'hygiene-ui chart updates: the list is a real dialog (focus kept, buttons on screen, the list scrolls, Escape cancels and writes nothing), also on a portrait tablet', run: chartUpdateDialogLoop},
  {name: 'hygiene: CSP holds for import, view, ink, notes, crop, print, backup, restore, service worker, fonts', run: cspLoop},
  {name: 'hygiene: dialogs trap focus, Escape cancels, focus returns, page behind is inert', run: dialogLoop},
  {name: 'hygiene: gig-date dialogs (New setlist with a date, Gig date, the fill-in) trap focus; Escape and Cancel change nothing; Enter in the name saves', run: gigDialogLoop},
  {name: 'hygiene: download dialogs (Download <name>, Download all, its busy box) trap focus; Escape cancels or stops and downloads nothing', run: downloadDialogLoop},
  {name: 'hygiene-ui share menu: the Library bar has one Share / Import button; its box lists four items, traps focus, closes on Escape and Cancel, and each item starts its action (also on a portrait tablet)', run: shareMenuLoop},
  {name: 'hygiene-ui setlist menu: an open setlist shows Play setlist, Add songs, Add break and More; the box lists Gig date, Download PDF, Share, Duplicate, Rename and Collections with hints, greys Download PDF and Share when empty, traps focus, gives focus back on Escape, Cancel and after Rename or Duplicate, and each item starts its action (also on a portrait tablet)', run: setMenuLoop},
  {name: 'hygiene-ui backup menu: the Library bar has a Back up / Sync button and its bottom only a read-only Drive line; the box lists four items, traps focus, closes on Escape and Cancel, each item starts its action, and the Google Drive box shows not connected, connected and sign-in ended and stays right while open (also on a portrait tablet)', run: backupMenuLoop},
  {name: 'hygiene: setlist rows reorder with arrow keys; tablet CSS (overscroll, touch-action, safe areas)', run: reorderLoop},
];

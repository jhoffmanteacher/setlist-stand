/*
 * Text setlist loops: Setlists -> Import from a text file.
 *
 * What is closed here: text files are written in Node, each with a setlist written down BY HAND beside it (song titles
 * and break names, in order: an independent expectation, not computed by the app's matcher). They go in through the real
 * screen (file chooser, review box, the choices tapped, Add), and the setlist is read back from IndexedDB and compared
 * item by item. Every import must be ONE write transaction (only the `sets` store, one put), and every other store
 * (songs, files, ink, colls) must be exactly as it was. Hostile files (too big, too many lines, binary, a script line,
 * a 100,000-character line, HTML in the file name) are refused or shown as text, and change nothing. The setlist made
 * survives a reload and a backup -> wipe -> restore.
 */
import {PDFDocument, assert, sleep, snapshot, diff, idbAll, backupNow, wipe, restoreZip} from './harness.mjs';

/* Wraps IDBDatabase.prototype.transaction before the app starts (the same probe as the share import loop). */
const TX_PROBE = () => {
  window.__tx = [];
  const tx = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put, recs = new WeakMap();
  IDBDatabase.prototype.transaction = function(names, mode, ...rest){
    const t = tx.call(this, names, mode, ...rest);
    const rec = {stores: (typeof names === 'string' ? [names] : Array.from(names)).sort(), mode: mode || 'readonly', puts: 0};
    window.__tx.push(rec); recs.set(t, rec);
    return t;
  };
  IDBObjectStore.prototype.put = function(...a){ const r = recs.get(this.transaction); if(r) r.puts++; return put.apply(this, a); };
};

/* The library, by file name (title first: "Song (version) - Artist.pdf"). */
const LIB = ['Café del Mar - Energy 52', 'Don’t Stop Believin’ - Journey', 'War Pigs - Black Sabbath', 'War Pigs (in G) - Black Sabbath',
  'Hallelujah - Leonard Cohen', 'Hallelujah - Jeff Buckley', 'Old Song - Someone', 'Yesterday - The Beatles', '99 Luftballons - Nena',
  '1999 - Prince', 'Superstition - Stevie Wonder'];
const COPY = 'Yesterday (for duo) - The Beatles';          // made with Copy song
const ARCHIVED = 'Old Song - Someone';

async function pdfFor(title){
  const d = await PDFDocument.create(); const p = d.addPage([300, 300]);
  p.drawText(title.replace(/[^\x20-\x7e]/g, '?'), {x: 20, y: 150, size: 10});
  return Buffer.from(await d.save());
}
async function waitFor(fn, what, ms = 10000){
  const t0 = Date.now();
  for(;;){ const v = await fn(); if(v) return v; if(Date.now() - t0 > ms) throw new Error(typeof what === 'function' ? await what() : what); await sleep(80); }
}
const liveSets = async page => Object.values(await idbAll(page, 'sets')).filter(s => !s.deleted);
const songsByTitle = async page => new Map(Object.values(await idbAll(page, 'songs')).filter(s => !s.deleted).map(s => [s.title, s]));
const writes = page => page.evaluate(() => window.__tx.filter(t => t.mode === 'readwrite'));
const enc = s => Buffer.from(s, 'utf8');

async function buildLibrary(page){
  await page.click('#tLib');
  await page.setInputFiles('#file', await Promise.all(LIB.map(async t => ({name: t + '.pdf', mimeType: 'application/pdf', buffer: await pdfFor(t)}))));
  await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, LIB.length, {timeout: 20000});
  const by = await songsByTitle(page);
  for(const t of LIB) assert(by.has(t), `the fixture "${t}" did not get that title: ` + [...by.keys()].join(' | '));
  /* Copy song (the real button) and Archive */
  await page.locator(`#libList [data-copy="${by.get('Yesterday - The Beatles').id}"]`).click();
  await page.locator('.modal input[type=text]').fill('for duo');
  await page.click('.modal [data-ok]');
  await waitFor(async () => (await songsByTitle(page)).has(COPY), 'Copy song did not make the copy');
  await page.locator(`#libList [data-archive="${by.get(ARCHIVED).id}"]`).click();
  await waitFor(async () => (await songsByTitle(page)).get(ARCHIVED).archived, 'the song was not archived');
}

/* Imports one file through the screen. opts.choices: {line text: option text | 'Leave this line out'}; opts.cancel: 'button' |
   'escape'; opts.button: pick the file through the button's file chooser. Returns {set (the new setlist or null), box (the
   review box's text), counts, rows, html}. */
async function importText(page, name, data, opts = {}){
  await page.click('#tSets');
  if(await page.locator('#view [data-allsets]').count()) await page.click('#view [data-allsets]');
  await page.evaluate(() => { window.__tx.length = 0; document.querySelector('#toast').textContent = ''; });
  const before = new Set((await liveSets(page)).map(s => s.id));
  const file = {name, mimeType: opts.type || 'text/plain', buffer: Buffer.isBuffer(data) ? data : enc(data)};
  if(opts.button){
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#view [data-importtext]')]);
    await fc.setFiles(file);
  } else await page.setInputFiles('#setTextFile', file);
  await page.locator('.modal h2').first().waitFor({timeout: 10000});
  const title = await page.locator('.modal h2').first().textContent();
  if(title !== 'Import setlist'){
    const text = await page.locator('.modal').textContent();
    await page.click('.modal [data-x]');
    return {refused: text, set: null};
  }
  const box = page.locator('.modal.textimport');
  const res = {box: await box.textContent(), html: await box.innerHTML(), counts: await box.locator('[data-counts]').textContent(),
    rows: await box.locator('li.tl').evaluateAll(ls => ls.map(l => ({cls: l.className, in: l.querySelector('.tl-in').textContent, out: l.querySelector('.tl-out')?.textContent || ''})))};
  if(opts.cancel === 'escape'){ await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.modal')); res.set = null; return res; }
  if(opts.cancel){ await box.locator('[data-x]').click(); await page.waitForFunction(() => !document.querySelector('.modal')); res.set = null; return res; }
  const choose = Object.entries(opts.choices || {});
  if(choose.length) assert(await box.locator('[data-ok]').isDisabled(), 'Add works before the choices are made');
  for(const [line, option] of choose){
    const li = box.locator('li.tl.choose').filter({has: page.locator('.tl-in', {hasText: line})}).first();
    await li.locator('label', {hasText: option}).first().locator('input').check();
  }
  await box.locator('[data-ok]').click();
  await page.waitForFunction(() => /^Added the setlist|No songs were chosen/.test(document.querySelector('#toast').textContent) || document.querySelector('.modal h2')?.textContent === 'Nothing was added', null, {timeout: 10000});
  res.toast = await page.locator('#toast').textContent();
  const made = (await liveSets(page)).filter(s => !before.has(s.id));
  assert(made.length <= 1, 'more than one setlist was made');
  res.set = made[0] || null;
  res.writes = await writes(page);
  return res;
}

/* An expected setlist written by hand: ['S', title] | ['B', break name]. Compared item by item; break ids must be new and plain. */
function sameItems(set, want, by, what){
  const got = set.items.map(it => it.type === 'break' ? ['B', it.name] : ['S', [...by.values()].find(s => s.id === it.id)?.title || '?' + it.id]);
  const bad = [];
  for(let i = 0; i < Math.max(got.length, want.length); i++) if(JSON.stringify(got[i]) !== JSON.stringify(want[i])) bad.push(`#${i + 1}: got ${JSON.stringify(got[i])}, want ${JSON.stringify(want[i])}`);
  assert(!bad.length, `${what}: ${bad.slice(0, 5).join('; ')}`);
  for(const it of set.items) if(it.type === 'break') assert(/^[a-z0-9]+$/i.test(it.id), `${what}: a break id is not a plain id: ${it.id}`);
  return got.length;
}
const oneWrite = (r, what) => assert(r.writes.length === 1 && r.writes[0].stores.join() === 'sets' && r.writes[0].puts === 1,
  `${what}: the import must be ONE write transaction over sets with one put: ` + JSON.stringify(r.writes));
const others = s => ({songs: s.songs, files: s.files, ink: s.ink, colls: s.colls});

const CASES = [
  {name: 'numbers and bullets, case, accents, quotes.txt', want: [['S', 'Café del Mar - Energy 52'], ['S', 'Don’t Stop Believin’ - Journey'], ['S', 'Superstition - Stevie Wonder'], ['S', '99 Luftballons - Nena'], ['S', '1999 - Prince'], ['S', ARCHIVED], ['S', '99 Luftballons - Nena'], ['S', 'Superstition - Stevie Wonder']],
    text: '1. cafe DEL mar\n2) Don\'t Stop Believin\' - Journey\n- superstition\n* 99 Luftballons\n• 1999\n(6) old  song\n99 Luftballons\n12 Superstition\n'},
  {name: 'Song - Artist and choices.txt', want: [['S', 'War Pigs - Black Sabbath'], ['S', 'War Pigs (in G) - Black Sabbath'], ['S', 'Hallelujah - Jeff Buckley'], ['S', 'Hallelujah - Leonard Cohen'], ['S', 'Yesterday - The Beatles'], ['S', 'War Pigs (in G) - Black Sabbath']],
    text: 'War Pigs - Black Sabbath\nWar Pigs (in G) - Black Sabbath\nHallelujah\nhallelujah - leonard cohen\nYesterday\nYesterday – The Beatles\nWar Pigs\nNothing Like This\n',
    choices: {'Hallelujah': 'Hallelujah - Jeff Buckley', 'Yesterday': 'Leave this line out', 'War Pigs': 'War Pigs (in G) - Black Sabbath'}, counts: '4 songs found, 3 to choose, 1 line not found', left: 2},
  {name: 'breaks, CRLF.txt', want: [['S', 'Superstition - Stevie Wonder'], ['B', 'Break'], ['B', 'Break'], ['B', 'Set break 2'], ['B', 'Intermission'], ['B', 'Break'], ['S', 'Café del Mar - Energy 52']],
    text: 'Superstition\r\n---\r\nBreak\r\n[Set break 2]\r\n== Intermission ==\r\nBreak My Stride\r\n***\r\nCafé del Mar\r\n# a comment\r\n\r\n', counts: '2 songs found, 5 breaks, 1 line not found'},
  {name: 'CR and mixed line ends.txt', want: [['S', 'Superstition - Stevie Wonder'], ['S', 'Café del Mar - Energy 52'], ['S', 'War Pigs - Black Sabbath'], ['S', '1999 - Prince']],
    text: 'Superstition\rCafé del Mar\nWar Pigs - Black Sabbath\r\n1999'},
  {name: 'byte-order mark.txt', want: [['S', 'Superstition - Stevie Wonder'], ['S', 'Café del Mar - Energy 52']],
    data: Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), enc('Superstition\nCafé del Mar\n')])},
  {name: 'utf-16 le.txt', want: [['S', 'Café del Mar - Energy 52'], ['S', 'Don’t Stop Believin’ - Journey']],
    data: Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('Café del Mar\r\nDon’t Stop Believin’ - Journey\r\n', 'utf16le')])},
  {name: 'utf-16 be.txt', want: [['S', 'Superstition - Stevie Wonder'], ['S', 'Café del Mar - Energy 52']],
    data: (() => { const le = Buffer.from('Superstition\nCafé del Mar', 'utf16le'), be = Buffer.alloc(le.length); for(let i = 0; i < le.length; i += 2){ be[i] = le[i + 1]; be[i + 1] = le[i]; } return Buffer.concat([Buffer.from([0xFE, 0xFF]), be]); })()},
  {name: 'windows-1252.txt', want: [['S', 'Café del Mar - Energy 52'], ['S', 'Don’t Stop Believin’ - Journey']],
    data: Buffer.from([...Buffer.from('Caf', 'latin1'), 0xE9, ...Buffer.from(' del Mar\r\nDon', 'latin1'), 0x92, ...Buffer.from('t Stop Believin', 'latin1'), 0x92, ...Buffer.from(' - Journey\r\n', 'latin1')])},
  {name: 'a script line.txt', want: [['S', 'Superstition - Stevie Wonder']], script: true,
    text: '<img src=x onerror="window.__xss=1">\nSuperstition\n<script>window.__xss=2</script>\n'},
  {name: 'a long line.txt', want: [['S', 'Superstition - Stevie Wonder']], long: true,
    text: 'a'.repeat(100000) + '\nSuperstition\n'},
  {name: 'exactly 1 MB.txt', want: [['S', 'Superstition - Stevie Wonder']],
    data: (() => { const head = enc('Superstition\n# '); return Buffer.concat([head, Buffer.alloc(1024 * 1024 - head.length, 0x61)]); })()},
  {name: '<b onmouseover=x>Html</b> name.txt', want: [['S', '1999 - Prince']], setName: '<b onmouseover=x>Html</b> name', text: '1999\n'},
];
const REFUSED = [
  {what: 'an empty file', name: 'empty.txt', data: Buffer.alloc(0), re: /has no song names in it\. Nothing was changed/},
  {what: 'a file of comments and blank lines', name: 'blank.txt', text: '# just a comment\n\n   \n', re: /has no song names in it/},
  {what: 'only breaks', name: 'only breaks.txt', text: '---\nBreak\nSet break 2\n', re: /None of the lines in that file match a song/},
  {what: 'no line matches', name: 'nothing.txt', text: 'Nothing\nAlso nothing\n', re: /None of the lines in that file match a song/},
  {what: '501 lines', name: '501.txt', text: 'Superstition\n'.repeat(501), re: /more than 500 lines/},
  {what: '1 MB and one byte', name: 'big.txt', data: Buffer.concat([enc('Superstition\n'), Buffer.alloc(1024 * 1024 - 12, 0x61)]), re: /too big for a setlist/},
  {what: 'a binary file named .txt', name: 'binary.txt', data: Buffer.from(Array.from({length: 4000}, (_, i) => (i * 37 + 11) % 256)), re: /not a plain text file/},
  {what: 'a PDF', name: 'chart.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4\n1 0 obj\n'), re: /not a plain text file/},
];

async function mainLoop(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await page.addInitScript(TX_PROBE);
    await s.goto();
    await buildLibrary(page);
    /* a default collection: a text setlist joins it, as every new setlist does (joinColls) */
    await page.evaluate(async () => { const st = await import('./js/store.js'), t = Date.now(); await st.putAll([{store: 'colls', key: 'bandA', value: {id: 'bandA', name: 'Band A', created: t, updated: t}}]); localStorage.setItem('ss-default-coll', 'bandA'); });
    await page.reload(); await page.waitForFunction(() => document.querySelector('#tLib') && /Band A/.test(document.querySelector('#view')?.textContent || ''));   // the Library now shows Band A (empty): the import still matches every song
    const by = await songsByTitle(page);
    const start = await snapshot(page);
    let n = 0, items = 0;
    const made = [];

    /* the button on the Setlists list opens a chooser for text files */
    await page.click('#tSets');
    const btn = page.locator('#view [data-importtext]');
    assert(await btn.textContent() === 'Import from a text file', 'the button is not on the Setlists list');
    const bb = await btn.boundingBox(); assert(bb.height >= 44, 'the button is smaller than a touch target: ' + bb.height);
    assert(await page.getAttribute('#setTextFile', 'accept') === '.txt,text/plain', 'the chooser does not ask for text files');

    for(const [i, c] of CASES.entries()){
      const before = await snapshot(page);
      const r = await importText(page, c.name, c.data || c.text, {choices: c.choices, button: i === 0});
      assert(!r.refused, `${c.name}: refused: ${r.refused}`);
      assert(r.set, `${c.name}: no setlist was made (toast: ${r.toast})`);
      oneWrite(r, c.name);
      items += sameItems(r.set, c.want, by, c.name); n++;
      const after = await snapshot(page);
      const d = diff(others(before), others(after));
      assert(!d.length, `${c.name}: songs, files, ink or collections changed: ` + d.join('; '));
      assert(Object.keys(after.sets).length === Object.keys(before.sets).length + 1, `${c.name}: other setlists changed`);
      for(const id of Object.keys(before.sets)) assert(!diff(before.sets[id], after.sets[id]).length, `${c.name}: setlist ${id} changed`);
      const want = c.setName || c.name.replace(/\.txt$/, '');
      assert(r.set.name === want, `${c.name}: the setlist is named "${r.set.name}", not "${want}"`);
      assert(!('gig' in r.set) && JSON.stringify(r.set.colls) === '["bandA"]' && r.set.created === r.set.updated, `${c.name}: gig, colls or dates: ` + JSON.stringify({gig: r.set.gig, colls: r.set.colls, c: r.set.created, u: r.set.updated}));
      if(c.counts) assert(r.counts === c.counts + '.', `${c.name}: the counts say "${r.counts}", want "${c.counts}."`);
      if(c.left) assert(new RegExp(`${c.left} lines left out`).test(r.toast), `${c.name}: toast "${r.toast}"`);
      assert(await page.evaluate(() => document.querySelector('#view h2')?.textContent) === r.set.name, `${c.name}: the new setlist did not open`);
      if(c.script){
        assert(await page.evaluate(() => window.__xss) === undefined, 'a line from the file ran as a script');
        assert(r.rows[0].in === '<img src=x onerror="window.__xss=1">' && !/<img|<script/i.test(r.html.replace(/&lt;/g, '')), 'a line from the file was put in the page as HTML: ' + r.rows[0].in);
        assert(r.rows[0].cls.includes('none'), 'the script line was not "no match"');
      }
      if(c.long) assert(r.rows[0].cls.includes('none') && r.rows[0].in.length < 100, 'the long line was not shortened and marked no match: ' + r.rows[0].in.length);
      if(i === 0){
        assert(r.rows.find(x => /old/i.test(x.in)).out === ARCHIVED + ' (archived)', 'the archived song is not marked "(archived)" in the box');
        assert(r.rows.every(x => x.cls.includes('ok')), 'case 1 rows: ' + JSON.stringify(r.rows.map(x => x.cls)));
      }
      if(c.name.startsWith('Song - Artist')){
        const ch = r.box;
        for(const t of ['Hallelujah - Leonard Cohen', 'Hallelujah - Jeff Buckley', 'Yesterday - The Beatles', COPY, 'Leave this line out']) assert(ch.includes(t), `the choice list lacks "${t}"`);
      }
      made.push(r.set.id);
    }

    /* the same file name twice: the "(2)" rule, the first setlist untouched */
    const first = (await liveSets(page)).find(x => x.name === 'breaks, CRLF');
    const r2 = await importText(page, 'breaks, CRLF.txt', 'Superstition\n');
    assert(r2.set && r2.set.name === 'breaks, CRLF (2)', 'a second import with the same name: ' + r2.set?.name);
    oneWrite(r2, 'second import');
    assert(!diff(first, (await liveSets(page)).find(x => x.id === first.id)).length, 'the first setlist changed when the second came in');
    made.push(r2.set.id); n++; items += 1;

    /* Cancel and Escape write nothing */
    for(const how of ['button', 'escape']){
      const before = await snapshot(page);
      await page.evaluate(() => { window.__tx.length = 0; });
      const r = await importText(page, 'cancel me.txt', 'Superstition\nCafé del Mar\n', {cancel: how});
      assert(!r.set, `${how}: a setlist was made`);
      assert(!(await writes(page)).length, `${how}: something was written: ` + JSON.stringify(await writes(page)));
      assert(!diff(before, await snapshot(page)).length, `${how}: the library changed`);
    }
    /* refusals: one plain sentence, nothing written */
    for(const c of REFUSED){
      const before = await snapshot(page);
      await page.evaluate(() => { window.__tx.length = 0; });
      const r = await importText(page, c.name, c.data || c.text, {type: c.type});
      assert(r.refused && c.re.test(r.refused), `${c.what}: not refused as expected: ` + (r.refused || 'a review box opened'));
      assert(!(await writes(page)).length && !diff(before, await snapshot(page)).length, `${c.what}: something was written`);
    }

    /* everything else exactly as it started; the setlists survive a reload and a backup round trip */
    const end = await snapshot(page);
    const d = diff(others(start), others(end));
    assert(!d.length, 'songs, files, ink or collections changed over the run: ' + d.join('; '));
    await page.reload(); await page.waitForSelector('#libList, #view');
    const afterReload = await idbAll(page, 'sets');
    assert(!diff(end.sets, afterReload).length, 'the setlists changed over a reload');
    const {file} = await backupNow(page);
    await wipe(page);
    await s.goto();
    await restoreZip(page, file);
    const restored = await idbAll(page, 'sets');
    for(const id of made) assert(!diff(end.sets[id], restored[id]).length, `setlist ${end.sets[id].name} changed over backup, wipe and restore: ` + diff(end.sets[id], restored[id]).join('; '));
    if(ctx.opts.verbose) console.log(`  ${n} of ${n} text setlists matched (${items} items), each one write; ${REFUSED.length} of ${REFUSED.length} refusals and 2 cancels wrote nothing`);
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

/* A song really called "Break" is a song, never a break; a second pick while the box is open is turned away. */
async function songWinsLoop(ctx){
  const s = await ctx.session();
  try{
    const {page} = s;
    await page.addInitScript(TX_PROBE);
    await s.goto();
    await page.setInputFiles('#file', await Promise.all(['Break - Garbage', 'Superstition - Stevie Wonder'].map(async t => ({name: t + '.pdf', mimeType: 'application/pdf', buffer: await pdfFor(t)}))));
    await page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 2, null, {timeout: 15000});
    const by = await songsByTitle(page);
    const r = await importText(page, 'song wins.txt', 'Break\n---\nSuperstition\n');
    oneWrite(r, 'song wins');
    sameItems(r.set, [['S', 'Break - Garbage'], ['B', 'Break'], ['S', 'Superstition - Stevie Wonder']], by, 'a song called Break');

    /* a second file picked while the review box is open: turned away, the first import still works */
    await page.click('#tSets');
    await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
    await page.setInputFiles('#setTextFile', {name: 'one.txt', mimeType: 'text/plain', buffer: enc('Superstition\n')});
    await page.locator('.modal.textimport').waitFor();
    await page.setInputFiles('#setTextFile', {name: 'two.txt', mimeType: 'text/plain', buffer: enc('Break\n')});
    await waitFor(async () => /still running/.test(await page.locator('#toast').textContent()), 'a second file was not turned away');
    assert(await page.locator('.modal').count() === 1, 'a second review box opened');
    await page.click('.modal.textimport [data-ok]');
    await waitFor(async () => (await liveSets(page)).some(x => x.name === 'one'), 'the first import did not finish');
    assert(!(await liveSets(page)).some(x => x.name === 'two'), 'the second file made a setlist');

    /* 500 lines: the list scrolls, Cancel and Add stay on the screen, at both sizes */
    for(const vp of [{width: 1280, height: 800}, {width: 800, height: 1280}]){
      await page.setViewportSize(vp);
      await page.click('#tSets');
      await page.setInputFiles('#setTextFile', {name: 'long.txt', mimeType: 'text/plain', buffer: enc('Superstition\nBreak\n'.repeat(250))});
      const box = page.locator('.modal.textimport'); await box.waitFor();
      const g = await box.evaluate(m => { const l = m.querySelector('.tlines'), r = b => m.querySelector(b).getBoundingClientRect();
        return {scrolls: l.scrollHeight > l.clientHeight + 10, ok: r('[data-ok]').bottom, x: r('[data-x]').bottom, rows: m.querySelectorAll('li.tl').length, h: innerHeight}; });
      assert(g.rows === 500 && g.scrolls && g.ok <= g.h && g.x <= g.h, `500 lines at ${vp.width}x${vp.height}: ` + JSON.stringify(g));
      await box.locator('[data-x]').click(); await page.waitForFunction(() => !document.querySelector('.modal'));
    }
    assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
  } finally { await s.close(); }
}

export const loops = [
  {name: 'setlisttext: text files become the setlists written down by hand, each in one write; refusals and Cancel write nothing; reload and backup keep them', run: mainLoop},
  {name: 'setlisttext: a song called Break is a song; a second file while the box is open is turned away', run: songWinsLoop},
];

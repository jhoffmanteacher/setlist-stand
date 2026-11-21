/* Shared by the share loops (share.loop.mjs, shareimport.loop.mjs): the fixture library worth sharing, and reading a package. */
import fs from 'node:fs';
import path from 'node:path';
import {FIX, JSZip, idbAll} from './harness.mjs';

export const FIXTURES = ['one-page.pdf', 'two-page.pdf', 'three-page.pdf'];
export const NOTE = 'Private note: capo on 3, ask Dana';           // the text note that must never leave the tablet
export const A_CROP = {x: .1, y: .15, w: .8, h: .7}, B_CROP = {x: .2, y: .2, w: .6, h: .6};
/* what each song's crop must look like in a package (written here, not read from the app): damaged parts are left out */
export const CROPS = {'Fixture Alpha': {all: A_CROP, pages: {}}, 'Two-page': {all: null, pages: {'2': B_CROP}}, 'Three-page': {all: {x: .1, y: .1, w: .5, h: .5}, pages: {}}};

export const songsOf = async page => Object.values(await idbAll(page, 'songs')).filter(s => !s.deleted);
export async function importFixtures(page){
  await page.setInputFiles('#file', FIXTURES.map(f => path.join(FIX, f)));
  await page.waitForFunction(n => document.querySelectorAll('#libList [data-open]').length === n, FIXTURES.length, {timeout: 20000});
}

/* A library worth sharing: details, a song-wide crop, a per-page crop, ink and a text note, an archived song, and a setlist
   with a break, a song twice and the archived song. Built through the app's own store functions. */
export async function buildLibrary(page){
  return page.evaluate(async ({A_CROP, B_CROP, NOTE}) => {
    const st = await import('./js/store.js'), {uid} = await import('./js/util.js');
    const by = t => st.state.songs.find(s => s.title.toLowerCase().startsWith(t));
    const a = by('one-page'), b = by('two-page'), c = by('three-page');
    Object.assign(a, {song: 'Fixture Alpha', artist: 'The Tests', version: 'in G', crop: {all: A_CROP, pages: {}}});
    Object.assign(b, {crop: {all: null, pages: {'2': B_CROP}}});
    c.crop = {all: {x: .1, y: .1, w: .5, h: .5, junk: 'z'}, pages: {'1': null, '2': {x: 'a'}, 'two': {x: 0, y: 0, w: 1, h: 1}, '0': {x: 0, y: 0, w: .5, h: .5}, '9': {x: 0, y: 0, w: .5, h: .5}}};      // a damaged crop in the library: bad rects, and keys that are not pages of a 3-page song
    c.archived = true;
    for(const s of [a, b, c]) await st.saveSong(s);
    await st.putInk(b.id, 1, [
      {id: uid(), t: 'pen', c: '#1a1a1a', w: .004, p: [[.2, .2], [.4, .3], [.6, .4]], updated: Date.now()},
      {id: uid(), t: 'text', x: .3, y: .5, text: NOTE, size: .018, c: '#d62828', updated: Date.now()}]);
    await st.saveSet({id: uid(), name: 'Gig: Friday', created: Date.now(), items: [
      {type: 'song', id: a.id}, {type: 'break', id: uid(), name: 'Set 2'}, {type: 'song', id: b.id}, {type: 'song', id: a.id}, {type: 'song', id: c.id}]});
    await st.load();
  }, {A_CROP, B_CROP, NOTE});
}

export async function closeDone(page){
  const dlg = page.locator('.modal [role=dialog]', {hasText: 'Package saved'});
  await dlg.waitFor({timeout: 20000});
  const text = await dlg.textContent();
  await page.click('.modal [data-x]');
  await page.waitForFunction(() => !document.querySelector('.modal'));
  return text;
}
export async function readPackage(file){
  const zip = await JSZip.loadAsync(fs.readFileSync(file), {checkCRC32: true});
  const names = Object.keys(zip.files).sort();                  // folder entries count: there must be none
  const share = JSON.parse(await zip.file('share.json').async('string'));
  const pdfs = {};
  for(const n of names) if(/^files\/.+\.pdf$/.test(n)) pdfs[n.slice(6, -4)] = Buffer.from(await zip.file(n).async('uint8array'));
  return {names, share, pdfs, text: await zip.file('share.json').async('string')};
}


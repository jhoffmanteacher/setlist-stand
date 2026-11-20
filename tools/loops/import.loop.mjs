/* Import loop: the bytes the app stores for an imported PDF are exactly the bytes of the file picked. */
import fs from 'node:fs';
import path from 'node:path';
import {FIX, assert, sha256, idbAll, fileHashes} from './harness.mjs';

export const loops = [{
  name: 'import: stored PDF bytes, page count and hash equal the file picked',
  async run(ctx){
    const s = await ctx.session();
    try{
      await s.goto();
      const files = ['one-page.pdf', 'two-page.pdf', 'three-page.pdf'];
      await s.page.setInputFiles('#file', files.map(f => path.join(FIX, f)));
      await s.page.waitForFunction(() => document.querySelectorAll('#libList [data-open]').length === 3, null, {timeout: 15000});
      const songs = Object.values(await idbAll(s.page, 'songs')), hashes = await fileHashes(s.page);
      const pages = {'one-page.pdf': 1, 'two-page.pdf': 2, 'three-page.pdf': 3};
      for(const f of files){
        const want = sha256(fs.readFileSync(path.join(FIX, f)));
        const song = songs.find(x => x.hash === want);
        assert(song, `${f}: no song record with the file's SHA-256`);
        assert(hashes[song.id] === want, `${f}: stored bytes hash ${hashes[song.id]} != file ${want}`);
        assert(song.pages === pages[f], `${f}: pages ${song.pages} != ${pages[f]}`);
      }
      assert(s.errors.length === 0, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
  }
}];

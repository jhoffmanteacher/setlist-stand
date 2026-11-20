/*
 * Which browser engine the test tools drive. Default Chromium; SS_BROWSER=webkit runs the same tests in Playwright's
 * WebKit (the engine behind Safari on iPad). Install it once: node node_modules/playwright/cli.js install webkit
 * Everything that launches a browser (smoke.mjs, loops.mjs, harness.mjs) goes through launchBrowser().
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium, webkit} from 'playwright';

const want = (process.env.SS_BROWSER || 'chromium').toLowerCase();
if(want !== 'chromium' && want !== 'webkit') throw new Error(`SS_BROWSER must be "chromium" or "webkit", not "${process.env.SS_BROWSER}"`);
export const WEBKIT = want === 'webkit';
export const ENGINE = want;

/* Playwright's normal WebKit context is private (nothing on disk), and a private WebKit context cannot store a Blob in
   IndexedDB ("UnknownError: Error preparing Blob/File data to be stored in object store"); the app keeps every PDF as
   a Blob, so nothing could be added. Under WebKit each context is therefore a persistent one (a profile folder in the
   temp folder, deleted when the context closes). This object has the few Browser methods the tools use. */
function webkitBrowser(launchOpts){
  const open = new Set();
  return {
    async newContext(opts = {}){
      const {storageState, ...rest} = opts;
      if(storageState) throw new Error('WebKit contexts here are persistent profiles: storageState is not supported');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-webkit-'));
      const context = await webkit.launchPersistentContext(dir, {...launchOpts, ...rest});
      const close = context.close.bind(context);
      open.add(context);
      context.close = async () => { open.delete(context); try{ await close(); } finally{ try{ fs.rmSync(dir, {recursive: true, force: true}); }catch(e){} } };
      return context;
    },
    async close(){ for(const c of [...open]) await c.close().catch(() => {}); },
  };
}

export const launchBrowser = opts => WEBKIT ? Promise.resolve(webkitBrowser(opts)) : chromium.launch(opts);

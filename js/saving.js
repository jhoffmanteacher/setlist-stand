import {toast, hooks} from './util.js';
import {load} from './store.js';
import {explainError} from './errors.js';

/* Every edit made on a screen saves a COPY of the record (never the one in `state`, which is what the screen is drawn from), then
   draws the screen again from storage. A refused save (tablet full, private window, a record changed in another tab) says why in
   plain words and leaves the screen exactly as storage has it. Resolves true when the write went through. */
export async function commit(write, fail = 'Could not save that. Nothing was changed.'){
  let ok = false;
  try{ await write(); ok = true; }catch(err){ toast(explainError(err, fail)); }
  try{ await load(); }catch(e){}
  hooks.render();
  return ok;
}

/* One edit at a time, and the same edit not twice in a row: a tap while an earlier tap's save is still running, or on the SAME button (`key`)
   within 400 ms after its screen was drawn again, is ignored (a double tap on Remove, Add break or Duplicate must write once; the second
   tap of a quick double would otherwise land on the row that moved up into the place of the removed one). A different button is never held
   back by it. 400 ms is the same pause as the Delete confirm (js/library.js). */
let running = false, lastKey = '', quietUntil = 0;
export async function once(key, fn){
  if(running || (key === lastKey && Date.now() < quietUntil)) return false;
  running = true;
  try{ return await fn(); } finally { running = false; lastKey = key; quietUntil = Date.now() + 400; }
}

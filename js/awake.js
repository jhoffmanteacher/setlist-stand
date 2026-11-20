import {$, toast} from './util.js';

/* Keeps the screen on while a song is open, and tells the truth about it.
   Preference: localStorage `ss-awake` ('0' = off, anything else = on). The button's state:
     held       the browser gave us the lock                -> aria-pressed true
     off        the preference is off                      -> aria-pressed false
     dim        the preference is on but there is no lock  -> aria-pressed false, amber, "may dim"
   (no navigator.wakeLock, the request was refused, or the system took the lock back: the sentinel's 'release' event) */
const KEY = 'ss-awake';
const MAY_DIM = 'This tablet may dim the screen. Set Auto-Lock to Never in Settings.';
let sentinel = null, pending = null, isOpen = false, warned = false;
/* The choice made in this page load wins; storage may be blocked (Safari "Block all cookies") or fail to save. */
let chosen = null;

const wanted = () => { if(chosen !== null) return chosen; try{ return localStorage.getItem(KEY) !== '0'; }catch(e){ return true; } };
const state = () => sentinel ? 'held' : wanted() ? 'dim' : 'off';

function render(){
  const b = $('#vAwake'); if(!b) return;
  const s = state();
  b.dataset.state = s;
  b.setAttribute('aria-pressed', s === 'held' ? 'true' : 'false');
  b.setAttribute('aria-label', s === 'dim' ? 'Keep screen on (this tablet may dim the screen)' : 'Keep screen on');
  b.title = s === 'held' ? 'Screen stays on. Tap to let it dim.' : s === 'off' ? 'Screen can dim. Tap to keep it on.' : 'This tablet may dim the screen. Tap to stop trying.';
}

/* Asks for the lock if the viewer is open and the preference is on. Resolves to true when we hold it. */
function acquire(){
  if(sentinel) return Promise.resolve(true);
  if(!isOpen || !wanted()) return Promise.resolve(false);
  return pending || (pending = ask().finally(() => { pending = null; }));
}
async function ask(){
  let got = null;
  try{ got = await navigator.wakeLock.request('screen'); }catch(e){}      // missing, refused, or the page is hidden
  if(got && (!isOpen || !wanted())){ try{ got.release(); }catch(e){} got = null; }   // closed or switched off while we waited
  if(got){
    sentinel = got;
    got.addEventListener('release', () => { if(sentinel === got){ sentinel = null; render(); } });   // the system took it back
  }
  render();
  return !!sentinel;
}
function release(){
  const s = sentinel; sentinel = null;
  try{ s && s.release(); }catch(e){}
  render();
}

/* The viewer opened: ask for the lock, and say so once per page load if this tablet will not keep the screen on. */
export async function awakeOpen(){
  isOpen = true; render();
  const ok = await acquire();
  if(!ok && isOpen && wanted() && !warned){ warned = true; toast(MAY_DIM); }
}
export function awakeClose(){ isOpen = false; release(); }

export function initAwake(){
  const b = $('#vAwake');
  b.onclick = async () => {
    if(state() === 'off'){
      chosen = true;
      try{ localStorage.setItem(KEY, '1'); }catch(e){}
      render();
      if(await acquire()) toast('Screen stays on'); else if(isOpen){ warned = true; toast(MAY_DIM); }
    }else{
      chosen = false;
      try{ localStorage.setItem(KEY, '0'); }catch(e){}
      release();
      toast('Screen can dim');
    }
  };
  /* A hidden page loses its lock; get it back when the page is shown again, if the preference is on. */
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') acquire(); });
  render();
}

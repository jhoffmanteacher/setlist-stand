/* Go to another song from inside the viewer: the song title in the viewer's top bar, when the viewer was opened from a
   setlist, opens this list of the setlist's songs (breaks shown as dividers, the song showing marked "Now"). Tapping a
   song goes to its first page. It is a modal(): Escape and the back gesture close it, and it is one history entry like
   any dialog (js/backnav.js). The box scrolls as a whole, so a long setlist fits a phone. */
import {esc, modal} from './util.js';
import {songById} from './store.js';

/* queue: the viewer's entries ({type:'song', id} | {type:'break', name}); cur: the entry showing; go(qi): called with the
   entry chosen; closed(): called once the list has gone, whichever way. */
export function jumpList(queue, cur, go, closed){
  let k = 0;
  const rows = queue.map((e, qi) => {
    if(e.type === 'break') return `<li class="jbrk">${esc(e.name || 'Break')}</li>`;
    k++;
    const now = qi === cur;
    return `<li><button data-qi="${qi}"${now ? ' aria-current="true"' : ''}><span class="jn">${k}</span><span class="jt">${esc(songById(e.id)?.title || 'Untitled song')}</span>${now ? '<span class="jnow">Now</span>' : ''}</button></li>`;
  }).join('');
  const m = modal(`<h2>Go to a song</h2><ul class="jump">${rows}</ul><div class="btns"><button data-x>Close</button></div>`);
  const rm = m.remove;
  m.remove = () => { const was = m.isConnected; rm.call(m);if(was && closed) closed(); };
  m.querySelector('[data-x]').onclick = () => m.remove();
  m.querySelector('.jump').onclick = e => {
    const b = e.target.closest('[data-qi]'); if(!b) return;
    m.remove(); go(+b.dataset.qi);
  };
  const here = m.querySelector('[aria-current]');
  if(here){ here.focus(); here.scrollIntoView({block:'nearest'}); }
  return m;
}

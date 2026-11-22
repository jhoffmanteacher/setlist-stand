/* One box for every menu on the Library (Share / Import, and the ones after it): a heading, big buttons each with a
   one-line hint under the label, and Cancel. This file only draws the box and says which item was tapped; what an item
   does is up to the caller.
   menuBox({title, items:[{id, label, hint, disabled?}], opener, run}) resolves with the chosen id, or null when the box
   was cancelled (Cancel or Escape; focus goes back to `opener`). `run(id)` is called in the very tap that chose the
   item, after the box has closed, so the browser still treats a file chooser opened from it as the person's own tap;
   the promise then waits for whatever run() returns. */
import {modal, esc} from './util.js';

export function menuBox({title, items, opener, run}){
  return new Promise(res => {
    const m = modal(`<h2>${esc(title)}</h2><div class="menulist">${items.map(i =>
      `<button class="menuitem" data-item="${esc(i.id)}"${i.disabled ? ' disabled' : ''}><b>${esc(i.label)}</b><span>${esc(i.hint)}</span></button>`).join('')}</div>
      <div class="btns"><button data-x>Cancel</button></div>`);
    m.classList.add('menubox');
    m.querySelector('[data-x]').onclick = () => { m.remove(); if(opener && opener.isConnected) opener.focus(); res(null); };
    for(const b of m.querySelectorAll('[data-item]')) b.onclick = () => {
      const id = b.dataset.item;
      m.remove();                                            // focus goes back to the button that opened the box
      res(Promise.resolve(run ? run(id) : null).then(() => id));
    };
  });
}

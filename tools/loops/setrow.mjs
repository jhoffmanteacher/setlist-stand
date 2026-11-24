/* The Setlists list's rows have two buttons: Play and one ⋯ (data-setrowmenu="<setlist id>") that opens a menu box with
   Duplicate (data-item="dup") and Delete (data-item="del"), like the Library's song rows (js/setlists.js; Jonathan, 2026-11-23).
   These helpers are what the loops and the smoke test use where they used to tap a row's own Duplicate / Delete button.
   Pure Playwright, no app knowledge beyond the data keys; modelled on songrow.mjs. Without an id they use the first row.
   Actions: 'dup' | 'del'. 'dup' acts at once; 'del' only chooses the menu item: the app then asks "Delete <name>?"
   (a modal with Cancel and Delete); setDelete() / answerSetDelete() answer it. */
import {answerDelete} from './songrow.mjs';

const moreSel = id => id ? `#view [data-setrowmenu="${id}"]` : '#view [data-setrowmenu]';

/* The menu box for a setlist row, opened (or already open). */
export async function openSetRowMenu(page, id){
  const box = page.locator('.modal.menubox');
  if(!(await box.count())) await page.locator(moreSel(id)).first().click();
  await box.waitFor({timeout: 8000});
  return box;
}
/* Taps one item of a setlist row's menu. */
export async function setAct(page, act, id){
  const box = await openSetRowMenu(page, id);
  await box.locator(`[data-item="${act}"]`).click();
}
/* The Delete confirm that follows the 'del' item: true = answered Delete, false = Cancel. */
export const answerSetDelete = answerDelete;
/* Menu item Delete, then Delete in the confirm. */
export async function setDelete(page, id){
  await setAct(page, 'del', id);
  await answerSetDelete(page, true);
}

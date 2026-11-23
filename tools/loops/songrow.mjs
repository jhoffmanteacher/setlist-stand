/* The Library's song rows have ONE button, ⋯ (data-songmenu="<song id>"), that opens a menu box (Jonathan, 2026-11-23). These
   helpers are what the loops and the smoke test use where they used to tap a row's own Edit / Copy / Archive / New version /
   Delete / Restore button. Pure Playwright, no app knowledge beyond the data keys; shared by tools/smoke.mjs and tools/loops/*.
   Actions: 'edit' | 'copy' | 'newversion' | 'archive' | 'restore' | 'del'. 'del' only chooses the menu item: the app then asks
   "Delete <title>?" (a modal with Cancel and Delete); songDelete() answers it. */

/* The menu box for a song, opened (or already open). */
export async function openSongMenu(page, id){
  const box = page.locator('.modal.menubox');
  if(!(await box.count())) await page.click(`#libList [data-songmenu="${id}"]`);
  await box.waitFor({timeout: 8000});
  return box;
}
/* Taps one item of a song's menu. For 'newversion' call it inside page.waitForEvent('filechooser') as before. */
export async function songAct(page, act, id){
  const box = await openSongMenu(page, id);
  await box.locator(`[data-item="${act}"]`).click();
}
/* The same for a row found some other way (a locator for the li.row, e.g. by its title). */
export async function songActIn(page, row, act){
  await row.locator('[data-songmenu]').click();
  const box = page.locator('.modal.menubox');
  await box.waitFor({timeout: 8000});
  await box.locator(`[data-item="${act}"]`).click();
}
/* The Delete confirm that follows the 'del' item: true = answered Delete, false = Cancel. */
export async function answerDelete(page, yes = true){
  const m = page.locator('.modal.delask');
  await m.waitFor({timeout: 8000});
  await m.locator(yes ? '[data-ok]' : '[data-x]').click();
  await m.waitFor({state: 'detached', timeout: 8000});
}
/* Menu item Delete, then Delete in the confirm. */
export async function songDelete(page, id){
  await songAct(page, 'del', id);
  await answerDelete(page, true);
}

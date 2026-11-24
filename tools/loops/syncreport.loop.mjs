/*
 * The sync report's wording for a chart replaced by the other tablet's (2026-11-23, review fixes): one line per song that names it,
 * "<title>: now plays the chart from your other tablet. The chart it had is in Archived.", at most 5 lines and then "and N more".
 * The real report box (reportDialog in js/syncdialogs.js) is drawn in the real app from a report the loop builds; the run that
 * produces such a report on two tablets is in "sync 4" (sync4.loop.mjs), which checks the same sentence with a real Sync.
 */
import {assert} from './harness.mjs';

const LINE = t => `${t}: now plays the chart from your other tablet. The chart it had is in Archived.`;

async function reportLines(page, names, archived){
  return page.evaluate(async ([names, archived]) => {
    const {reportDialog} = await import('./js/syncdialogs.js'), {blankReport} = await import('./js/sync.js');
    const rep = blankReport(); rep.archived = archived; rep.archivedNames = names;
    const m = reportDialog(rep);
    const lines = [...m.querySelectorAll('.syncrep p')].map(p => p.textContent), html = m.querySelector('.syncrep').innerHTML;
    m.remove();
    return {lines, html};
  }, [names, archived]);
}

export const loops = [
  {name: 'sync report: a chart replaced by the other tablet is named per song (one line each, "and N more" past 5), the title is escaped', async run(ctx){
    const s = await ctx.session();
    try{
      await s.goto();
      const one = await reportLines(s.page, ['Autumn Leaves'], 1);
      assert(JSON.stringify(one.lines) === JSON.stringify([LINE('Autumn Leaves')]), 'one song: ' + JSON.stringify(one.lines));
      const five = await reportLines(s.page, ['A', 'B', 'C', 'D', 'E'], 5);
      assert(JSON.stringify(five.lines) === JSON.stringify(['A', 'B', 'C', 'D', 'E'].map(LINE)), 'five songs: ' + JSON.stringify(five.lines));
      const names = ['One', 'Two <b>x</b>', 'Three', 'Four', 'Five', 'Six', 'Seven'];
      const seven = await reportLines(s.page, names, 7);
      assert(seven.lines.length === 6 && seven.lines.slice(0, 5).every((l, i) => l === LINE(names[i])), 'seven songs, the first five: ' + JSON.stringify(seven.lines));
      assert(/^and 2 more\b/.test(seven.lines[5]) && /Archived/.test(seven.lines[5]), 'seven songs, the last line: ' + seven.lines[5]);
      assert(!seven.html.includes('<b>x</b>'), 'a title with markup was put into the report as markup');
      assert(!seven.lines.some(l => /replaced by a newer one/.test(l)), 'the old wording is still there: ' + JSON.stringify(seven.lines));
      assert(!s.errors.length, 'page errors: ' + s.errors.join(' | '));
    } finally { await s.close(); }
  }},
];

/* The draft list of songs in a songbook: a first guess from the PDF's own bookmarks, then edited by hand.
   A row is {id, on, title, from, to}: `from` is the song's first page; `to` is its last page, or null for "the page before
   the next row" (the last row then runs to the end of the book). Rows are kept in page order. Two rows may share a page. */
import {uid} from './util.js';

/* Bookmarks that are almost surely not songs start unchecked (the list still shows them: one tap puts them back). */
const FRONT = /^(?:(?:(?:front|back) )?cover|(?:table of )?contents?|index(?:es)?|title page|copyright(?: page)?|about(?: this book)?|introduction|intro|foreword|preface|acknowledg(?:e)?ments?)\s*$/i;
const MAX_MARKS = 5000, MAX_DEPTH = 8;      // a damaged or hostile outline cannot make this run for ever

const clean = t => [...String(t == null ? '' : t)].filter(c => c.codePointAt(0) >= 32 && c !== '\x7f').join('').replace(/\s+/g, ' ').trim().slice(0, 200);

/* The bookmarks of an open pdf.js document that point at a page and have no bookmarks under them (a section such as
   "Part One" or "A" is not a song), in book order: [{title, page}], pages 1-based. Anything it cannot read is left out. */
export async function readBookmarks(doc, n){
  let tree;
  try{ tree = await doc.getOutline(); }catch(e){ return []; }
  if(!Array.isArray(tree)) return [];
  const pageOf = async dest => {
    try{
      if(typeof dest === 'string') dest = await doc.getDestination(dest);
      if(!Array.isArray(dest) || !dest.length) return null;
      const i = Number.isInteger(dest[0]) ? dest[0] : await doc.getPageIndex(dest[0]);
      return Number.isInteger(i) && i >= 0 && i < n ? i + 1 : null;
    }catch(e){ return null; }
  };
  const out = []; let seen = 0;
  /* Returns true when something under `items` was kept, so its parent is then a section and not a song. */
  const walk = async (items, depth) => {
    let kept = false;
    for(const it of items){
      if(!it || ++seen > MAX_MARKS) break;
      const kids = depth < MAX_DEPTH && Array.isArray(it.items) && it.items.length ? await walk(it.items, depth + 1) : false;
      if(kids){ kept = true; continue; }
      const page = it.dest ? await pageOf(it.dest) : null, title = clean(it.title);
      if(page && title){ out.push({title, page}); kept = true; }
    }
    return kept;
  };
  await walk(tree, 0);
  return out;
}

/* Rows sorted by first page; rows with the same first page keep the order they had. */
export const sortRows = rows => rows.map((r, i) => [r, i]).sort((a, b) => a[0].from - b[0].from || a[1] - b[1]).map(x => x[0]);

export const draftRows = marks => sortRows(marks.map(m => ({id:uid(), on:!FRONT.test(m.title), title:m.title, from:m.page, to:null})));

export const newRow = from => ({id:uid(), on:true, title:'', from, to:null});

/* The last page of rows[i] (rows sorted, n pages in the book). A row that is not ticked still ends the row before it:
   unticking "Index" does not put the index into the last song. */
export function endOf(rows, i, n){
  const r = rows[i];
  if(r.to != null) return Math.min(n, Math.max(r.from, r.to));
  const next = rows[i + 1];
  return next ? Math.max(r.from, next.from - 1) : n;
}

/* A page number typed by hand: a whole number from 1 to n, else `fallback`. */
export function clampPage(text, n, fallback){
  const t = String(text).trim(), v = t === '' ? NaN : Math.round(Number(t));
  return Number.isFinite(v) ? Math.min(n, Math.max(1, v)) : fallback;
}

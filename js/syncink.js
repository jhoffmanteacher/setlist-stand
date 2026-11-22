/* Sync ink: how one Google Drive sync merges the pen marks and text notes of one page. Pure: no screen, no database, no
   network; the same file runs in the browser and in Node (tools/loops/syncink.loop.mjs tests it there).

   An ink page is {updated, strokes:[...]} (key "songId:page"). A stroke is a pen or highlighter line
   {id, t:'pen'|'hl', c, w, p, updated}, a text note {id, t:'text', x, y, text, size, c, updated}, or the marker an erase
   leaves {id, deleted:true, updated}. Every entry is kept whole (a field this code does not know travels with it).

   mergePage(local, remote) merges by STROKE ID, never by the page's `updated`:
     - every id on either side is in the result (a stroke one side does not have is new there, never a deletion);
     - for an id on both sides the entry with the larger `updated` wins: an erase beats an older stroke, a stroke drawn
       again (undo) or a note edited later beats an older erase;
     - the same `updated`: the deletion marker wins over a live stroke (an erase is never undone by a copy stamped in the
       same millisecond); otherwise the entry whose canonical text (canon, js/syncmerge.js) is the larger wins. Both
       tablets ask the same question of the same two entries, so they pick the same one;
     - the page's `updated` is the larger of the two pages' and at least the newest entry's;
     - fields of the page other than `updated` and `strokes` come from the page with the larger `updated` (the same: the
       larger canonical text).
   The order of the result (it is the drawing order: a later line is drawn over an earlier one):
     - live strokes first. Each side's live strokes keep their order. When both sides hold their common live strokes in
       the same order (the usual case), the two lists are interleaved: at each step the next stroke that the other side
       does not have, or the shared one when both are at it; when both next strokes are one-sided the smaller id goes
       first. If the two orders disagree (it needs a reorder the app never makes) every live stroke is put in id order,
       which for the app's ids (they start with the time they were made) is the order they were drawn in.
     - then the deletion markers, in id order (they are not drawn; where they sit does not matter).
   This is the same on both tablets whichever side is "local" (mergePage(a, b) and mergePage(b, a) give the same text)
   and merging the result with either side again changes nothing, so after one more round two tablets and Drive hold
   the same page. `changed` says whether the result differs from each side (canonical text), so a sync knows what to
   write here and what to upload. A missing side (null) is an empty page.

   A page from Drive is checked before it is merged: inkProblem() in js/backup.js (the key, the counts: exactly what a
   restore checks) and then inkShapeProblem() below (what this version needs to draw it: finite numbers, a list of points
   for a line, text for a note, plain ids, no id twice). */
import {canon} from './syncmerge.js';

/* Copies of ID_RE (js/store.js) and of LIMITS (js/backup.js): those files need a browser, this one must load in Node.
   tools/loops/syncink.loop.mjs checks that they are equal to the originals. */
export const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const INK_LIMITS = {pages:5000, text:2000, strokes:50000, points:200000};
export const MAX_U = 8.64e15 - 1e6;                // as MAX_U in js/store.js: the latest time held or sent (stamp() never goes above it)
/* The latest time a sync TAKES from Drive (a page, its marks, a record): MAX_U itself, the same cap as here (stamp() and inkRecord() never
   go above it, so whatever this tablet makes from what it took stays sendable and takeable). Later than this, up to DATE_MAX (the last
   date JavaScript has), a file is listed and refused by name; later than DATE_MAX it is not ours (a stray). */
export const MAX_READ = MAX_U;
export const DATE_MAX = 8.64e15;
const HEX64 = /^[0-9a-f]{64}$/;
/* A point may lie off the page (a line drawn past the edge keeps its points, and a crop scales them), but not this far. */
const FAR = 10;

const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const time = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const byId = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const isMarker = s => !!s.deleted;

/* The entry that wins for one id (see the rules above). Never depends on which side it came from. */
function pick(a, b){
  const ta = time(a.updated), tb = time(b.updated);
  if(ta !== tb) return ta > tb ? a : b;
  if(isMarker(a) !== isMarker(b)) return isMarker(a) ? a : b;
  if(JSON.stringify(a) === JSON.stringify(b)) return a;           // the same entry (the usual case): no need for canon
  return canon(a) >= canon(b) ? a : b;
}

/* One side as {page, order: ids in first-seen order, map: id -> entry}. Two entries with the same id on one side (damaged
   data) are settled by pick(), like two sides. */
function side(v, name){
  if(v == null) return {page:{updated:0, strokes:[]}, order:[], map:new Map()};
  if(!isObj(v) || !Array.isArray(v.strokes)) throw new TypeError(`mergePage: the ${name} page is not {updated, strokes:[...]}`);
  const order = [], map = new Map();
  v.strokes.forEach((s, i) => {
    if(!isObj(s) || typeof s.id !== 'string' || !s.id) throw new TypeError(`mergePage: the ${name} page has an entry ${i} with no id`);
    if(map.has(s.id)) map.set(s.id, pick(map.get(s.id), s));
    else { map.set(s.id, s); order.push(s.id); }
  });
  return {page:v, order, map};
}

/* The two lists of live stroke ids (each in its own side's order) as one list (see "The order" above). */
function interleave(A, B){
  const inA = new Set(A), inB = new Set(B);
  const ca = A.filter(id => inB.has(id)), cb = B.filter(id => inA.has(id));
  if(ca.some((id, i) => id !== cb[i])) return [...new Set([...A, ...B])].sort(byId);
  const out = [];
  let i = 0, j = 0;
  while(i < A.length || j < B.length){
    if(i >= A.length){ out.push(B[j++]); continue; }
    if(j >= B.length){ out.push(A[i++]); continue; }
    const a = A[i], b = B[j];
    if(a === b){ out.push(a); i++; j++; continue; }
    const soloA = !inB.has(a), soloB = !inA.has(b);
    if(soloA && soloB){ if(a < b){ out.push(a); i++; } else { out.push(b); j++; } }
    else if(soloA){ out.push(a); i++; }
    else { out.push(b); j++; }                     // soloB: both shared and different cannot happen, the orders agree
  }
  return out;
}

const extrasOf = page => { const o = {}; for(const k of Object.keys(page)) if(k !== 'updated' && k !== 'strokes') o[k] = page[k]; return o; };

export function mergePage(local, remote){
  const L = side(local, 'local'), R = side(remote, 'remote');
  const win = new Map();
  for(const [id, s] of L.map) win.set(id, s);
  for(const [id, s] of R.map) win.set(id, win.has(id) ? pick(win.get(id), s) : s);
  /* each side's live strokes whose winner is live, in that side's order */
  const liveIn = S => S.order.filter(id => !isMarker(S.map.get(id)) && !isMarker(win.get(id)));
  const live = interleave(liveIn(L), liveIn(R));
  const placed = new Set(live);
  const markers = [...win.keys()].filter(id => !placed.has(id)).sort(byId);
  const strokes = [...live, ...markers].map(id => win.get(id));
  /* the page's own fields: from the newer page (the same time: the larger canonical text) */
  const tl = time(L.page.updated), tr = time(R.page.updated);
  const el = extrasOf(L.page), er = extrasOf(R.page);
  const extras = tl !== tr ? (tl > tr ? el : er) : canon(el) >= canon(er) ? el : er;
  let updated = Math.max(tl, tr);
  for(const s of strokes) updated = Math.max(updated, time(s.updated));
  const record = {...extras, updated, strokes};
  /* A side differs when its canonical text does. Asked part by part (the page time, its other fields, then entry by
     entry; an entry that is the same object, or has the same JSON text, is the same), so a page of hundreds of strokes
     is not written out twice for every sync. */
  const ce = canon(extras);
  const differs = P => {
    if(P.strokes.length !== strokes.length || P.updated !== updated || canon(extrasOf(P)) !== ce) return true;
    return P.strokes.some((a, i) => { const b = strokes[i]; return a !== b && (a.id !== b.id || (JSON.stringify(a) !== JSON.stringify(b) && canon(a) !== canon(b))); });
  };
  return {record, changed:{local: differs(L.page), remote: differs(R.page)}};
}

/* A page with nothing on it, not even a marker, is not worth a Drive file. A page whose strokes were all erased is NOT
   empty: its markers must reach the other tablet, or the strokes would stay there. */
export const isEmpty = record => !isObj(record) || !Array.isArray(record.strokes) || record.strokes.length === 0;

/* ---------- Drive names and properties ---------- */
const okPage = p => Number.isInteger(p) && p >= 1 && p <= INK_LIMITS.pages;
const checkKey = (songId, page) => {
  if(typeof songId !== 'string' || !ID_RE.test(songId) || !okPage(page)) throw new TypeError(`ink page ${String(songId).slice(0, 70)}:${page} is not a song id and a page number`);
};
/* The local store key of an ink page ("songId:page"). */
export const inkIndexKey = (songId, page) => { checkKey(songId, page); return songId + ':' + page; };
/* The Drive file name of an ink page. The key's colon is not in the id grammar, so the name uses dashes; ids may hold
   dashes too, but the page number is always the part after the last one. The name is only a label: the file is found by
   its properties (parseInkProps). */
export const inkFileName = (songId, page) => { checkKey(songId, page); return `ink-${songId}-${page}.json`; };
/* The appProperties of an ink page's Drive file, {k:'ink', id, p, u, c, h} (all strings, as Drive keeps them), read back as
   {songId, page, u, c, h}; null for anything else. `p` and `u` must be written exactly as String() writes the number. `h` is the
   SHA-256 (lower-case hex) of the chart the marks were drawn on: a page is only ever merged into that chart. */
export function parseInkProps(props){
  if(!isObj(props) || props.k !== 'ink') return null;
  const {id, p, u, c, h} = props;
  if(typeof id !== 'string' || !ID_RE.test(id)) return null;
  if(typeof p !== 'string' || !/^[1-9][0-9]*$/.test(p) || !okPage(Number(p))) return null;
  if(typeof u !== 'string' || !/^[0-9]/.test(u)) return null;
  const n = Number(u);
  if(!Number.isFinite(n) || n < 0 || n > DATE_MAX || String(n) !== u) return null;
  if(typeof c !== 'string' || !HEX64.test(c)) return null;
  if(typeof h !== 'string' || !HEX64.test(h)) return null;
  return {songId:id, page:Number(p), u:n, c, h};
}

/* ---------- a page from Drive: can this version draw it? ---------- */
const fin = v => typeof v === 'number' && Number.isFinite(v);
const near = v => fin(v) && v >= -FAR && v <= 1 + FAR;
const okTime = (v, max = MAX_U) => v === undefined || (fin(v) && v >= 0 && v <= max);
/* "#rrggbb", as the app and the MobileSheets converter write every colour (print reads it as three hex pairs) */
const okColour = v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const cutId = v => JSON.stringify(String(v)).slice(0, 40);
/* null when the page can be merged and drawn, else a short plain reason. Checked after inkProblem() (which checks the key
   and the counts). Only the {updated, strokes} form: an old bare list would be given new ids and times on each tablet. `maxU`: the
   latest time allowed (MAX_U for a page here, MAX_READ for one from Drive). */
export function inkShapeProblem(record, maxU = MAX_U){
  if(!isObj(record) || !Array.isArray(record.strokes)) return 'the page is not a list of marks';
  if(!okTime(record.updated, maxU) || record.updated === undefined) return 'the page has no usable time';
  const seen = new Set();
  for(const s of record.strokes){
    if(!isObj(s)) return 'a mark that is not a record';
    if(typeof s.id !== 'string' || !ID_RE.test(s.id)) return 'a mark id ' + cutId(s.id);
    if(seen.has(s.id)) return `the mark ${s.id} twice`;
    seen.add(s.id);
    if(!okTime(s.updated, maxU)) return `mark ${s.id} has no usable time`;
    if(s.deleted !== undefined){
      if(s.deleted !== true) return `mark ${s.id} is erased as ${cutId(s.deleted)}`;
      continue;
    }
    if(!okColour(s.c)) return `mark ${s.id} has no colour like #rrggbb`;
    if(s.t === 'text'){
      if(typeof s.text !== 'string' || s.text.length > INK_LIMITS.text) return `note ${s.id} has no short text`;
      if(!near(s.x) || !near(s.y)) return `note ${s.id} is not on the page`;
      if(!fin(s.size) || s.size < 0 || s.size > 1) return `note ${s.id} has size ${cutId(s.size)}`;
      continue;
    }
    /* a pen or highlighter line, or a kind this version does not know: it is drawn as a line, so it needs its points */
    if(!Array.isArray(s.p) || s.p.length > INK_LIMITS.points) return `mark ${s.id} has no list of points`;
    for(const pt of s.p) if(!Array.isArray(pt) || pt.length < 2 || !near(pt[0]) || !near(pt[1])) return `mark ${s.id} has a point that is not on the page`;
    if(!fin(s.w) || s.w < 0 || s.w > 1) return `mark ${s.id} has width ${cutId(s.w)}`;
  }
  return null;
}

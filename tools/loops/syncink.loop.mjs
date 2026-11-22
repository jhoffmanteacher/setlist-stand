/* syncink.loop.mjs — the Drive sync merge of pen marks and text notes (js/syncink.js), in Node: no browser page, no Drive.

     node tools/loops.mjs --only "sync ink" [--seed S] [--cases N] [--case I] [--verbose]

   a  a table of cases for mergePage, each run both ways round (local and Drive swapped): strokes drawn on two tablets,
      the same stroke newer on one side, an erase against an older stroke, a stroke drawn again (undo) against an older
      erase, the same time settled the same way on both tablets, a text note edited on one tablet, a stroke only one side
      has, empty and missing sides, the page's `updated`, fields this code does not know, the drawing order, and inputs
      that are not ink pages.
   b  CONVERGENCE. Two tablets and one Drive holding one record per page; seeded random drawing, notes, erasing, note
      edits, undo of an erase, Clear, clocks apart, syncs in random order and cut off part way (a page written here but
      not uploaded, or the other way). Every merge is checked against this file's own rules: every id of either side is
      in the result with the winning entry (so no stroke is lost without a marker and no marker is dropped unless a newer
      stroke replaced it), merge(a, b) = merge(b, a), merging the result with either side changes nothing, the contents
      (entry per id) are associative, and the drawing order keeps each side's order. After a last round (A, B, A) both
      tablets and Drive hold the same pages, by this file's own canonical text, and every stroke ever made is there in
      its newest version. Some scenarios start from pages of several hundred strokes.
   c  inkProblem (js/backup.js) says exactly what validateBackup says for an ink page (same pages refused, same words;
      the expected words are the ones validateBackup gave before inkProblem existed), and inkShapeProblem
      (js/syncink.js) refuses what this version could not draw: non-finite or far-off numbers, a note with no text, a
      line with no points, an id twice. Good pages pass both: unknown fields, a 12-note page, a page of 400 strokes.
      The copies of ID_RE and LIMITS in js/syncink.js equal the originals.
   d  Drive names and properties: inkIndexKey, inkFileName (one name per page, the page number read back after the last
      dash), parseInkProps round trips {k, id, p, u, c, h} (h: the chart's SHA-256) and refuses anything malformed, a file with
      no valid h included; isEmpty.
   The app code is imported from ctx.root, so a fault planted in a scratch copy is the code tested. */
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {assert} from './harness.mjs';

const load = ctx => import(pathToFileURL(path.join(ctx.root, 'js', 'syncink.js')).href);
/* js/backup.js reads `window` when it loads (through js/util.js); nothing in what is tested here uses it. */
async function loadBackup(ctx){
  const had = 'window' in globalThis;
  if(!had) globalThis.window = {};
  try{ return await import(pathToFileURL(path.join(ctx.root, 'js', 'backup.js')).href); }
  finally{ if(!had) delete globalThis.window; }
}
const hexOf = s => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));

/* ---------- seeded RNG (mulberry32, as in model.loop.mjs) ---------- */
function hash32(str){ let h = 2166136261; for(const c of str){ h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed){
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  r.int = n => Math.floor(r() * n);
  r.pick = arr => arr[r.int(arr.length)];
  r.chance = p => r() < p;
  r.shuffle = arr => { const a2 = [...arr]; for(let i = a2.length - 1; i > 0; i--){ const j = r.int(i + 1); [a2[i], a2[j]] = [a2[j], a2[i]]; } return a2; };
  return r;
}

/* ---------- this file's own rules, written apart from js/syncink.js ---------- */
function refCanon(v){
  if(Array.isArray(v)) return '[' + v.map(refCanon).join(',') + ']';
  if(v && typeof v === 'object'){
    const ks = []; for(const k in v) ks.push(k);
    ks.sort();                                       // by UTF-16 code unit
    return '{' + ks.map(k => JSON.stringify(k) + ':' + refCanon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
/* the same canonical text (the JSON text first: it is quicker, and equal JSON is equal canonical text) */
const same = (a, b) => {
  if(a === b) return true;
  if(a && b && Array.isArray(a.strokes) && Array.isArray(b.strokes) && a.strokes.length !== b.strokes.length) return false;
  return JSON.stringify(a) === JSON.stringify(b) || refCanon(a) === refCanon(b);
};
const T = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const EMPTY = {updated: 0, strokes: []};
/* the entry that must win for one id: newer `updated`; the same time: the erase; else the larger canonical text */
function refWin(a, b){
  if(T(a.updated) !== T(b.updated)) return T(a.updated) > T(b.updated) ? a : b;
  if(!!a.deleted !== !!b.deleted) return a.deleted ? a : b;
  return same(a, b) || refCanon(a) >= refCanon(b) ? a : b;
}
/* id -> winning entry over the given pages */
function refWinners(...pages){
  const w = new Map();
  for(const p of pages) for(const s of (p || EMPTY).strokes) w.set(s.id, w.has(s.id) ? refWin(w.get(s.id), s) : s);
  return w;
}
const contents = rec => { const m = new Map(); for(const s of rec.strokes) m.set(s.id, refCanon(s)); return [...m].sort((a, b) => a[0] < b[0] ? -1 : 1).map(e => e.join('=')).join('|') + '@' + rec.updated; };

/* Checks one merge result against the rules above. Returns a list of problems (empty when right). `order` adds the
   drawing-order checks. */
function checkMerge(M, L, R, res, {order = true, full = true} = {}){
  const bad = [];
  const rec = res.record, ids = rec.strokes.map(s => s.id);
  if(new Set(ids).size !== ids.length) bad.push('an id twice in the result');
  const want = refWinners(L, R), byId = new Map(rec.strokes.map(s => [s.id, s]));
  for(const [id, s] of want){
    const got = byId.get(id);
    if(!got) bad.push(`stroke ${id} is lost (no entry and no marker)`);
    else if(!same(got, s)) bad.push(`stroke ${id}: kept ${refCanon(got).slice(0, 90)}, the winner is ${refCanon(s).slice(0, 90)}`);
  }
  for(const id of ids) if(!want.has(id)) bad.push(`stroke ${id} came from nowhere`);
  let u = Math.max(T((L || EMPTY).updated), T((R || EMPTY).updated));
  for(const s of want.values()) u = Math.max(u, T(s.updated));
  if(rec.updated !== u) bad.push(`page updated ${rec.updated}, expected ${u}`);
  if(res.changed.local !== !same(rec, L || EMPTY)) bad.push(`changed.local is ${res.changed.local}`);
  if(res.changed.remote !== !same(rec, R || EMPTY)) bad.push(`changed.remote is ${res.changed.remote}`);
  /* the same on the other tablet (sides swapped) */
  const sw = M.mergePage(R, L);
  if(!same(sw.record, rec)) bad.push('merge(b, a) differs from merge(a, b)');
  if(sw.changed.local !== res.changed.remote || sw.changed.remote !== res.changed.local) bad.push('changed flags not swapped when the sides are');
  /* merging the result again changes nothing (with either side, either way round, and with itself) */
  for(const [what, x, first] of full ? [['local', L, true], ['remote', R, false], ['itself', rec, true]] : [['local', L, true]]){
    const a = first ? M.mergePage(rec, x) : M.mergePage(x, rec);
    if(!same(a.record, rec) || (first ? a.changed.local : a.changed.remote)) bad.push(`merging the result with ${what} changes it`);
  }
  if(order) bad.push(...checkOrder(L, R, rec));
  return bad;
}
/* Drawing order: live strokes first, markers after them in id order; each side's live strokes in that side's order when
   the two sides agree on the order of the ones they share, else every live stroke in id order. */
function checkOrder(L, R, rec){
  const bad = [];
  const firstMarker = rec.strokes.findIndex(s => s.deleted);
  if(firstMarker >= 0 && rec.strokes.slice(firstMarker).some(s => !s.deleted)) bad.push('a live stroke after a marker');
  const marks = rec.strokes.filter(s => s.deleted).map(s => s.id);
  if(marks.some((id, i) => i && marks[i - 1] >= id)) bad.push('markers not in id order');
  const liveRes = rec.strokes.filter(s => !s.deleted).map(s => s.id), liveSet = new Set(liveRes);
  const seq = P => { const out = [], seen = new Set(); for(const s of (P || EMPTY).strokes) if(!s.deleted && liveSet.has(s.id) && !seen.has(s.id)){ seen.add(s.id); out.push(s.id); } return out; };
  const a = seq(L), b = seq(R), inA = new Set(a), inB = new Set(b);
  const ca = a.filter(id => inB.has(id)), cb = b.filter(id => inA.has(id));
  const agree = ca.every((id, i) => id === cb[i]);
  if(agree){
    for(const [name, s] of [['local', a], ['remote', b]]){
      const set = new Set(s), got = liveRes.filter(id => set.has(id));
      if(got.join() !== s.join()) bad.push(`the ${name} drawing order is not kept: ${s.join(' ')} became ${got.join(' ')}`);
    }
  } else if(liveRes.some((id, i) => i && liveRes[i - 1] >= id)) bad.push('the two orders disagree, but the live strokes are not in id order');
  return bad;
}

/* ---------- strokes ---------- */
const COLOURS = ['#000000', '#d32f2f', '#1565c0', '#ffeb3b', '#2e7d32'];
const WORDS = ['Capo 2', 'rit.', 'D.S. al coda', 'tacet', 'x2', 'Fine', 'É', 'B♭ here', 'swing', 'line\nbreak'];
const r4 = n => Math.round(n * 1e4) / 1e4;
const pen = (id, u, x = {}) => ({id, t: 'pen', c: '#000000', w: .003, p: [[.1, .2], [.15, .25]], updated: u, ...x});
const hl = (id, u, x = {}) => ({id, t: 'hl', c: '#ffeb3b', w: .02, p: [[.3, .3], [.5, .3]], updated: u, ...x});
const txt = (id, u, text = 'Capo 2', x = {}) => ({id, t: 'text', x: .1, y: .1, text, size: .018, c: '#d32f2f', updated: u, ...x});
const mark = (id, u) => ({id, deleted: true, updated: u});
const page = (u, ...strokes) => ({updated: u, strokes});
function randStroke(r, id, u){
  const k = r.int(10);
  if(k < 3) return {id, t: 'text', x: r4(r()), y: r4(r()), text: r.pick(WORDS), size: r.pick([.012, .018, .028]), c: r.pick(COLOURS), updated: u};
  const p = Array.from({length: 1 + r.int(5)}, () => [r4(r() * 1.1 - .05), r4(r() * 1.1 - .05)]);
  const s = {id, t: k < 5 ? 'hl' : 'pen', c: r.pick(COLOURS), w: k < 5 ? .02 : r.pick([.0015, .003, .006]), p, updated: u};
  if(r.chance(.05)) s.pressure = p.map(() => r4(r()));                    // a field this version does not know
  return s;
}

/* ---------- a: the table ---------- */
/* [what, local, remote, expected strokes (in order), expected page updated] */
const CASES = [
  ['disjoint strokes on two tablets', page(10, pen('a1', 10)), page(20, hl('b1', 20)), [pen('a1', 10), hl('b1', 20)], 20],
  ['the same stroke, newer on Drive', page(10, pen('a1', 10)), page(20, pen('a1', 20, {c: '#1565c0'})), [pen('a1', 20, {c: '#1565c0'})], 20],
  ['the same stroke, newer here', page(30, pen('a1', 30, {w: .006})), page(20, pen('a1', 20)), [pen('a1', 30, {w: .006})], 30],
  ['an erase beats an older stroke', page(10, pen('a1', 10), pen('a2', 11)), page(20, mark('a1', 20), pen('a2', 11)), [pen('a2', 11), mark('a1', 20)], 20],
  ['an older stroke never undoes an erase (the stroke side has the newer page)', page(90, pen('a1', 10), txt('n1', 90)), page(20, mark('a1', 20)), [txt('n1', 90), mark('a1', 20)], 90],
  ['a stroke drawn again (undo) beats an older erase', page(20, mark('a1', 20)), page(30, pen('a1', 30)), [pen('a1', 30)], 30],
  ['an older erase never removes a stroke drawn again (the erase side has the newer page)', page(99, mark('a1', 20), pen('z9', 99)), page(30, pen('a1', 30)), [pen('a1', 30), pen('z9', 99), ], 99],
  ['the same time, two different notes: the larger canonical text, on both tablets', page(50, txt('n1', 50, 'Capo 2')), page(50, txt('n1', 50, 'Capo 3')), [txt('n1', 50, 'Capo 3')], 50],
  ['the same time, the keys in another order on each tablet: still the larger canonical text', page(50, {updated: 50, id: 'n1', t: 'text', x: .1, y: .1, text: 'A', size: .018, c: '#d32f2f'}), page(50, txt('n1', 50, 'B')), [txt('n1', 50, 'B')], 50],
  ['the same time, two different lines', page(50, pen('a1', 50, {c: '#d32f2f'})), page(50, pen('a1', 50, {c: '#000000'})), [pen('a1', 50, {c: '#d32f2f'})], 50],
  ['the same time, an erase and a stroke: the erase', page(50, pen('a1', 50)), page(50, mark('a1', 50)), [mark('a1', 50)], 50],
  ['the same time, an erase with an extra field and a stroke with one', page(50, pen('a1', 50, {a: 1})), page(50, {...mark('a1', 50), z: 1}), [{...mark('a1', 50), z: 1}], 50],
  ['a text note edited on one tablet (text and place)', page(10, txt('n1', 10), pen('a1', 5)), page(40, txt('n1', 40, 'Capo 4', {x: .5, y: .62}), pen('a1', 5)), [txt('n1', 40, 'Capo 4', {x: .5, y: .62}), pen('a1', 5)], 40],
  ['a stroke only this tablet has', page(10, pen('a1', 5), pen('a2', 10)), page(5, pen('a1', 5)), [pen('a1', 5), pen('a2', 10)], 10],
  ['a stroke only Drive has', page(5, pen('a1', 5)), page(10, pen('a1', 5), pen('a2', 10)), [pen('a1', 5), pen('a2', 10)], 10],
  ['a marker only one side has (drawn and erased there)', page(5, pen('a1', 5)), page(10, pen('a1', 5), mark('a2', 10)), [pen('a1', 5), mark('a2', 10)], 10],
  ['no page here', null, page(10, pen('a1', 10)), [pen('a1', 10)], 10],
  ['no page on Drive', page(10, txt('n1', 10)), null, [txt('n1', 10)], 10],
  ['both missing', null, null, [], 0],
  ['an empty page and a missing one', page(7), null, [], 7],
  ['the page updated is at least the newest stroke', page(100, pen('a1', 50)), page(10, pen('a2', 200)), [pen('a1', 50), pen('a2', 200)], 200],
  ['the page updated is the larger page time when the strokes are older', page(100, pen('a1', 5)), page(300, pen('a1', 5)), [pen('a1', 5)], 300],
  ['a stroke with no time loses to any timed one and the page keeps its time', page(5, {id: 'a1', t: 'pen', c: '#000000', w: .003, p: [[0, 0]]}), page(3, pen('a1', 1)), [pen('a1', 1)], 5],
  ['unknown fields of a stroke travel with it', page(10, pen('a1', 10, {pressure: [.5, .7], layer: {n: 2}})), page(5), [pen('a1', 10, {pressure: [.5, .7], layer: {n: 2}})], 10],
  ['order: each side keeps its own; one-sided strokes side by side go by id', page(30, pen('a', 1), pen('b', 2), pen('c', 3)), page(30, pen('a', 1), pen('x', 4), pen('c', 3)), ['a', 'b', 'x', 'c'], 30],
  ['order: a stroke Drive has after the last shared one stays last', page(30, pen('m', 1), pen('a', 2)), page(30, pen('m', 1), pen('a', 2), pen('0', 5)), ['m', 'a', '0'], 30],
  ['order: the two sides disagree, so id order', page(30, pen('b', 1), pen('a', 2)), page(30, pen('a', 2), pen('b', 1)), ['a', 'b'], 30],
  ['order: markers after live strokes, in id order, wherever they were', page(30, mark('m2', 3), pen('z', 1), mark('m1', 4), pen('y', 2)), null, ['z', 'y', 'm1', 'm2'], 30],
  ['order: a stroke drawn again takes its place among the live ones', page(30, pen('a', 1), mark('b', 20), pen('c', 3)), page(30, pen('a', 1), pen('b', 25), pen('c', 3)), ['a', 'b', 'c'], 30],
  ['the same stroke twice on one side (damaged): the newer one, once', page(9, pen('a1', 5), pen('a1', 9, {c: '#d32f2f'})), null, [pen('a1', 9, {c: '#d32f2f'})], 9],
  ['a page field this code does not know: from the newer page', {updated: 10, strokes: [], v: 2}, {updated: 20, strokes: [], v: 3}, [], 20, {v: 3}],
];

async function loopTable(ctx){
  const M = await load(ctx);
  const bad = [];
  for(const [what, L, R, want, u, extra] of CASES){
    for(const [nameL, a, b] of [['here', L, R], ['Drive', R, L]]){
      const ia = refCanon(a), ib = refCanon(b);
      let res;
      try{ res = M.mergePage(clone(a), clone(b)); }catch(e){ bad.push(`${what} (${nameL} as local): threw ${e.message}`); continue; }
      const rec = res.record;
      const ids = rec.strokes.map(s => s.id);
      if(want.length && typeof want[0] === 'string'){
        if(ids.join(' ') !== want.join(' ')) bad.push(`${what} (${nameL} as local): order ${ids.join(' ')}, expected ${want.join(' ')}`);
      } else if(refCanon(rec.strokes) !== refCanon(want)) bad.push(`${what} (${nameL} as local): strokes ${refCanon(rec.strokes)}, expected ${refCanon(want)}`);
      if(rec.updated !== u) bad.push(`${what} (${nameL} as local): page updated ${rec.updated}, expected ${u}`);
      if(extra) for(const [k, v] of Object.entries(extra)) if(refCanon(rec[k]) !== refCanon(v)) bad.push(`${what}: page field ${k} is ${refCanon(rec[k])}`);
      for(const p of checkMerge(M, a, b, res)) bad.push(`${what} (${nameL} as local): ${p}`);
      if(refCanon(a) !== ia || refCanon(b) !== ib) bad.push(`${what}: mergePage changed its input`);
    }
  }
  /* changed flags, spelled out */
  const f = (L, R) => { const c = M.mergePage(L, R).changed; return `${c.local} ${c.remote}`; };
  const P = page(10, pen('a1', 10));
  for(const [what, got, want] of [
    ['the same page on both sides', f(P, clone(P)), 'false false'],
    ['the same page, keys in another order', f(P, {strokes: [{updated: 10, p: [[.1, .2], [.15, .25]], w: .003, c: '#000000', t: 'pen', id: 'a1'}], updated: 10}), 'false false'],
    ['Drive is newer', f(P, page(20, pen('a1', 20))), 'true false'],
    ['here is newer', f(page(20, pen('a1', 20)), P), 'false true'],
    ['each has a stroke the other lacks', f(P, page(10, pen('a2', 10))), 'true true'],
    ['nothing here', f(null, P), 'true false'],
    ['nothing on Drive', f(P, null), 'false true'],
    ['nothing anywhere', f(null, null), 'false false'],
    ['an empty page here', f(page(0), null), 'false false'],
  ]) if(got !== want) bad.push(`changed, ${what}: ${got}, expected ${want}`);
  /* not ink pages: refused, never guessed */
  for(const [what, L, R] of [['a bare list (the old form: upgradeInk first)', [pen('a', 1)], null], ['text', null, 'page'], ['strokes not a list', {updated: 1, strokes: 'x'}, null],
    ['a stroke with no id', page(1, {t: 'pen', p: [], w: .003}), null], ['a stroke that is not a record', null, page(1, 'x')], ['an empty id', page(1, pen('', 1)), null]]){
    let threw = false;
    try{ M.mergePage(L, R); }catch(e){ threw = e instanceof TypeError; }
    if(!threw) bad.push(`mergePage took ${what} without a TypeError`);
  }
  /* a 12-note page and pages of several hundred strokes, drawn on both tablets */
  const r = rng(hash32('syncink:table'));
  const notes = page(100, ...Array.from({length: 12}, (_, i) => txt('n' + String(i).padStart(2, '0'), 50 + i, r.pick(WORDS), {x: r4(r()), y: r4(r())})));
  const notes2 = clone(notes); notes2.strokes[3] = {...notes2.strokes[3], text: 'edited', updated: 200}; notes2.strokes.push(txt('n99', 201)); notes2.updated = 201;
  const nres = M.mergePage(notes, notes2);
  bad.push(...checkMerge(M, notes, notes2, nres).map(p => '12 notes: ' + p));
  if(nres.record.strokes.length !== 13 || nres.record.strokes[3].text !== 'edited') bad.push('12 notes: the edit or the new note is missing');
  const base = Array.from({length: 300}, (_, i) => randStroke(r, 'k' + String(i).padStart(4, '0'), 1000 + i));
  const A = page(5000, ...clone(base), ...Array.from({length: 150}, (_, i) => randStroke(r, 'a' + i, 3000 + i)));
  const B = page(5100, ...clone(base), ...Array.from({length: 150}, (_, i) => randStroke(r, 'b' + i, 3000 + i)));
  for(let i = 0; i < 300; i += 7) A.strokes[i] = mark(A.strokes[i].id, 4000 + i);           // erased on A
  for(let i = 3; i < 300; i += 11) B.strokes[i] = {...B.strokes[i], updated: 4100 + i};     // touched on B
  const t0 = Date.now(), big = M.mergePage(A, B), ms = Date.now() - t0;
  bad.push(...checkMerge(M, A, B, big).map(p => '600 strokes: ' + p));
  if(big.record.strokes.length !== 600) bad.push(`600 strokes: the result has ${big.record.strokes.length}`);
  if(ms > 500) bad.push(`600 strokes took ${ms} ms to merge`);
  assert(!bad.length, `mergePage:\n    ${bad.slice(0, 30).join('\n    ')}`);
  console.log(`  sync ink a: ${CASES.length} cases both ways round, 12 notes, 600 strokes merged in ${ms} ms`);
}

/* ---------- b: convergence ---------- */
function scenario(M, seed, n, log, stats){
  const r = rng(hash32(`syncink:${seed}:${n}`));
  const big = n % 200 === 0;
  const keys = ['s1:1', 's1:2', 's2:1', 's3:4'].slice(0, 1 + r.int(big ? 2 : 4));
  const skews = [[0, 0], [0, 0], [0, 3], [-5, 7], [0, -40], [0, 3e5], [-864e5, 0]];
  const [sa, sb] = r.pick(skews);
  const tabs = {A: {name: 'A', ink: new Map(), skew: sa, lastLive: new Map()}, B: {name: 'B', ink: new Map(), skew: sb, lastLive: new Map()}};
  const drive = new Map(), versions = new Map(), keyOf = new Map();
  let g = 1e6, made = 0;
  const clock = t => Math.max(0, g + t.skew);
  const stamp = (t, prev) => Math.max(clock(t), T(prev && prev.updated) + 1);
  const remember = (t, key, s) => {
    if(!versions.has(s.id)){ versions.set(s.id, []); keyOf.set(s.id, key); }
    versions.get(s.id).push(clone(s));
    if(!s.deleted) t.lastLive.set(s.id, clone(s));
  };
  const save = (t, key, strokes) => t.ink.set(key, {updated: clock(t), strokes});            // inkRecord: the page time is the clock
  const pageOf = (t, key) => t.ink.get(key) || {updated: 0, strokes: []};

  /* where both tablets start: restored from one backup (the same pages), or B empty */
  const shared = r.chance(.6) || big;
  for(const key of keys){
    const count = big ? 150 + r.int(250) : r.int(5);
    if(!count) continue;
    const strokes = Array.from({length: count}, () => randStroke(r, 'base' + (made++), g - 1000 + r.int(900)));
    for(const s of strokes) remember(tabs.A, key, s);
    tabs.A.ink.set(key, {updated: g - 10, strokes: clone(strokes)});
    if(shared){ tabs.B.ink.set(key, {updated: g - 10, strokes: clone(strokes)}); for(const s of strokes) tabs.B.lastLive.set(s.id, clone(s)); }
  }

  const sync = (t, cut) => {
    stats.syncs++;
    const order = r.shuffle([...new Set([...t.ink.keys(), ...drive.keys()])]);
    for(const key of order){
      if(cut && r.chance(.25)){ stats.cut++; log(`  ${t.name} sync cut off before ${key}`); return; }
      const L = t.ink.get(key) || null, D = drive.get(key) || null;
      const res = M.mergePage(L, D);
      stats.merges++;
      const full = r.chance(big ? .1 : .3); if(full) stats.full++;
      const bad = checkMerge(M, L, D, res, {full});
      if(bad.length) throw new Error(`${t.name} sync, page ${key}: ${bad.slice(0, 4).join('; ')}`);
      /* the contents (entry per id, and the page time) do not depend on how three pages are grouped */
      const other = tabs[t.name === 'A' ? 'B' : 'A'].ink.get(key) || null;
      if(r.chance(big ? .05 : .12)){
        const x = M.mergePage(M.mergePage(L, D).record, other).record, y = M.mergePage(L, M.mergePage(D, other).record).record, z = M.mergePage(M.mergePage(L, other).record, D).record;
        if(contents(x) !== contents(y) || contents(x) !== contents(z)) throw new Error(`page ${key}: merging three pages gives different strokes depending on the grouping`);
        stats.assoc++;
      }
      for(const s of res.record.strokes) if(!s.deleted) t.lastLive.set(s.id, clone(s));
      const lost = cut && r.chance(.1) ? r.pick(['here', 'Drive']) : null;             // the run stops half-way through this page
      if(res.changed.local && lost !== 'here') t.ink.set(key, clone(res.record));
      if(res.changed.remote && !M.isEmpty(res.record) && lost !== 'Drive') drive.set(key, clone(res.record));
      if(res.changed.local || res.changed.remote) log(`  ${t.name} sync ${key}: ${res.record.strokes.length} entries, wrote ${res.changed.local && lost !== 'here' ? 'here ' : ''}${res.changed.remote && lost !== 'Drive' ? 'Drive' : ''}`);
      if(lost){ stats.cut++; log(`  ${t.name} sync cut off while writing ${key} (${lost} not written)`); return; }
    }
  };

  const steps = big ? 6 + r.int(8) : 8 + r.int(25);
  for(let i = 0; i < steps; i++){
    g += r.pick([0, 0, 1, 1, 2, 5, 1000]);                    // 0: two things in the same millisecond
    const t = tabs[r.chance(.5) ? 'A' : 'B'], key = r.pick(keys), P = pageOf(t, key), k = r.int(100);
    const live = P.strokes.filter(s => !s.deleted), notes = live.filter(s => s.t === 'text');
    const markers = P.strokes.filter(s => s.deleted && t.lastLive.has(s.id));
    if(k < 22){
      const s = randStroke(r, t.name + (made++), clock(t)); remember(t, key, s); save(t, key, [...P.strokes, s]);
      log(`${t.name} draws ${s.id} (${s.t}) on ${key} at ${s.updated}`);
    } else if(k < 34 && live.length){
      const v = r.pick(live), m = mark(v.id, stamp(t, v)); remember(t, key, m);
      save(t, key, P.strokes.map(s => s.id === v.id ? m : s));
      log(`${t.name} erases ${v.id} on ${key} at ${m.updated}`);
    } else if(k < 44 && notes.length){
      const v = r.pick(notes), e = {...v, text: r.pick(WORDS) + (r.chance(.5) ? '!' : ''), x: r4(r()), updated: stamp(t, v)}; remember(t, key, e);
      save(t, key, P.strokes.map(s => s.id === v.id ? e : s));
      log(`${t.name} edits note ${v.id} on ${key} at ${e.updated}`);
    } else if(k < 50 && markers.length){
      const v = r.pick(markers), back = {...t.lastLive.get(v.id), updated: stamp(t, v)}; remember(t, key, back);
      save(t, key, P.strokes.map(s => s.id === v.id ? back : s));
      log(`${t.name} undoes the erase of ${v.id} on ${key} at ${back.updated}`);
    } else if(k < 53 && live.length){
      const gone = P.strokes.map(s => s.deleted ? s : mark(s.id, stamp(t, s))); for(const s of gone) if(!P.strokes.includes(s)) remember(t, key, s);
      save(t, key, gone); log(`${t.name} clears ${key}`);
    } else if(k < 57 && P.strokes.some(s => s.deleted)){
      save(t, key, [...P.strokes.filter(s => !s.deleted), ...r.shuffle(P.strokes.filter(s => s.deleted))]);   // as reconcile() leaves it: markers at the end
      log(`${t.name} undo leaves the markers of ${key} at the end`);
    } else if(k < 62){
      t.skew += r.pick([-3e5, -2, 2, 864e5]); log(`${t.name} clock now ${t.skew} off`);
    } else {
      log(`${t.name} syncs`); sync(t, r.chance(.3));
    }
  }
  /* the last round, nothing cut off, no edits */
  sync(tabs.A, false); sync(tabs.B, false); sync(tabs.A, false);
  const all = [...new Set([...tabs.A.ink.keys(), ...tabs.B.ink.keys(), ...drive.keys()])];
  for(const key of all){
    const a = tabs.A.ink.get(key), b = tabs.B.ink.get(key), d = drive.get(key);
    if(refCanon(a || EMPTY) !== refCanon(b || EMPTY)) throw new Error(`page ${key}: the two tablets differ after the last round`);
    if(!(d == null && M.isEmpty(a)) && refCanon(a || EMPTY) !== refCanon(d || EMPTY)) throw new Error(`page ${key}: Drive differs from the tablets after the last round`);
    stats.pages++;
  }
  /* every stroke ever made is on its page in its newest version (an erased one as its marker) */
  for(const [id, vs] of versions){
    const rec = tabs.A.ink.get(keyOf.get(id)), got = rec && rec.strokes.find(s => s.id === id);
    const want = vs.reduce(refWin);
    if(!got) throw new Error(`stroke ${id} is lost (no entry and no marker) on ${keyOf.get(id)}`);
    if(refCanon(got) !== refCanon(want)) throw new Error(`stroke ${id}: ${refCanon(got).slice(0, 100)} is kept, its newest version is ${refCanon(want).slice(0, 100)}`);
    if(got.deleted) stats.erased++; else stats.live++;
  }
  for(const key of all) for(const s of tabs.A.ink.get(key).strokes) if(!versions.has(s.id)) throw new Error(`stroke ${s.id} came from nowhere`);
  if(big) stats.big++;
  stats.steps += steps;
}

async function loopConverge(ctx){
  const M = await load(ctx);
  const {seed, verbose} = ctx.opts;
  const n = ctx.opts.cases || 2000;
  const cases = ctx.opts.case != null ? [ctx.opts.case] : Array.from({length: n}, (_, i) => i + 1);
  const t0 = Date.now();
  const stats = {syncs: 0, cut: 0, merges: 0, full: 0, assoc: 0, pages: 0, live: 0, erased: 0, steps: 0, big: 0};
  for(const c of cases){
    const lines = [];
    const log = l => { lines.push(l); if(verbose) console.log(l); };
    try{ scenario(M, seed, c, log, stats); }
    catch(e){
      throw new Error(`scenario ${c} (seed ${seed}): ${e.message}\n  last steps:\n${lines.slice(-12).join('\n')}\n  replay: node tools/loops.mjs --only "sync ink b" --seed ${seed} --case ${c} --verbose`);
    }
  }
  console.log(`  sync ink b: ${cases.length} scenarios (${stats.big} with pages of several hundred strokes), seed ${seed}, ${stats.steps} steps, ${stats.syncs} syncs (${stats.cut} cut off), `
    + `${stats.merges} merges checked (${stats.full} with every side merged again), ${stats.assoc} three-page groupings; at the end ${stats.pages} pages equal everywhere, ${stats.live} live strokes and ${stats.erased} erased ones in their newest version; ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/* ---------- c: inkProblem and inkShapeProblem ---------- */
const K = 's1:1';
const many = (n, f) => Array.from({length: n}, (_, i) => f(i));
/* [what, key, value, the words validateBackup gave before inkProblem existed (null: accepted)] */
const BACKUP_CASES = [
  ['a good page with unknown fields', K, page(10, pen('a1', 10, {pressure: [1]}), hl('a2', 10), txt('n1', 10), mark('a3', 11), {id: 'a4', t: 'shape', p: [[0, 0]], w: .01, updated: 3}), null],
  ['a 12-note page', K, page(10, ...many(12, i => txt('n' + i, i))), null],
  ['a page of 400 strokes', K, page(10, ...many(400, i => pen('k' + i, i))), null],
  ['an old bare list', K, [pen('a1', 1), {t: 'pen', p: [[0, 0]], w: .003}], null],
  ['a key with a leading zero page (taken as page 2 today)', 's1:02', page(1), null],
  ['the last page', 's1:5000', page(1), null],
  ['a value that is not a page (restored as an empty page)', K, 'junk', null],
  ['strokes that are not a list (restored as an empty page)', K, {updated: 1, strokes: 'x'}, null],
  ['a NaN point (a restore keeps the page whole)', K, page(1, pen('a1', 1, {p: [[NaN, 0]]})), null],
  ['a note with no text (a restore keeps the page whole)', K, page(1, txt('n1', 1, 5)), null],
  ['exactly the stroke limit', K, page(1, ...many(50000, i => ({id: 'm' + i, deleted: true, updated: 1}))), null],
  ['exactly the point limit', K, page(1, pen('a1', 1, {p: many(200000, () => [0, 0])})), null],
  ['no colon', 'abc', page(1), 'an annotation page "abc"'],
  ['page 0', 's1:0', page(1), 'an annotation page "s1:0"'],
  ['page 5001', 's1:5001', page(1), 'an annotation page "s1:5001"'],
  ['a negative page', 's1:-1', page(1), 'an annotation page "s1:-1"'],
  ['a fractional page', 's1:1.5', page(1), 'an annotation page "s1:1.5"'],
  ['no page', 's1:', page(1), 'an annotation page "s1:"'],
  ['no song id', ':1', page(1), 'an annotation page ":1"'],
  ['two colons', 's1:1:2', page(1), 'an annotation page "s1:1:2"'],
  ['a space in the id', 'a b:1', page(1), 'an annotation page "a b:1"'],
  ['an HTML id', '<b>:1', page(1), 'an annotation page "<b>:1"'],
  ['an id of 65 characters', 'x'.repeat(65) + ':1', page(1), 'an annotation page "' + 'x'.repeat(39)],
  ['50001 strokes', K, page(1, ...many(50001, i => ({id: 'm' + i, deleted: true, updated: 1}))), 'page s1:1 has more than 50000 strokes'],
  ['50001 strokes in an old bare list', K, many(50001, () => ({})), 'page s1:1 has more than 50000 strokes'],
  ['a stroke of 200001 points', K, page(1, pen('a1', 1), pen('a2', 1, {p: many(200001, () => [0, 0])})), 'page s1:1 has a stroke of more than 200000 points'],
];
/* [what, value, inkShapeProblem's words (null: can be drawn)] */
const REFUSED = Symbol('refused with a plain reason');
const SHAPE_CASES = [
  ['a good page with unknown fields', page(10, pen('a1', 10, {pressure: [1]}), hl('a2', 10), txt('n1', 10), mark('a3', 11), {...mark('a5', 1), extra: 1}, {id: 'a4', t: 'shape', c: '#123456', p: [[0, 0]], w: .01, updated: 3}), null],
  ['a 12-note page', page(10, ...many(12, i => txt('n' + i, i))), null],
  ['a page of 400 strokes', page(10, ...many(400, i => pen('k' + i, i))), null],
  ['a page from the converter (no stroke times, a tiny width, a size of 0)', page(5, {t: 'pen', id: 'msann3_0', c: '#000000', w: 0, p: [[.1, .1]]}, {t: 'text', id: 'msnote4', x: .2, y: .3, text: 'Intro', size: 0, c: '#000000'}), null],
  ['a line that runs off the page', page(1, pen('a1', 1, {p: [[-.3, 1.4], [2, -1]]})), null],
  ['an empty page', page(0), null],
  ['a page whose strokes are all erased', page(9, mark('a1', 9), mark('a2', 9)), null],
  ['an old bare list', [pen('a1', 1)], 'the page is not a list of marks'],
  ['text', 'junk', 'the page is not a list of marks'],
  ['strokes not a list', {updated: 1, strokes: 'x'}, 'the page is not a list of marks'],
  ['no page time', {strokes: []}, 'the page has no usable time'],
  ['a page time as text', {updated: '5', strokes: []}, 'the page has no usable time'],
  ['a negative page time', page(-1), 'the page has no usable time'],
  ['an infinite page time', page(Infinity), 'the page has no usable time'],
  ['a page time past the last date', page(9e15), 'the page has no usable time'],
  ['a mark that is not a record', page(1, 'x'), 'a mark that is not a record'],
  ['a mark that is a list', page(1, []), 'a mark that is not a record'],
  ['a mark with no id', page(1, {t: 'pen', p: [], w: .003}), 'a mark id "undefined"'],
  ['a number id', page(1, pen(5, 1)), 'a mark id "5"'],
  ['an id with a space', page(1, pen('a b', 1)), 'a mark id "a b"'],
  ['an id twice', page(1, pen('a1', 1), mark('a1', 2)), 'the mark a1 twice'],
  ['a NaN time', page(1, pen('a1', NaN)), 'mark a1 has no usable time'],
  ['a time as text', page(1, pen('a1', '5')), 'mark a1 has no usable time'],
  ['a negative time', page(1, mark('a1', -5)), 'mark a1 has no usable time'],
  ['erased as text', page(1, {id: 'a1', deleted: 'yes', updated: 1}), 'mark a1 is erased as "yes"'],
  ['erased as false', page(1, pen('a1', 1, {deleted: false})), 'mark a1 is erased as "false"'],
  ['a colour that is a number', page(1, pen('a1', 1, {c: 5})), 'mark a1 has no colour like #rrggbb'],
  ['a note whose text is a number', page(1, txt('n1', 1, 5)), 'note n1 has no short text'],
  ['a note with no text', page(1, txt('n1', 1, 'a', {text: undefined})), 'note n1 has no short text'],
  ['a note of 2001 characters', page(1, txt('n1', 1, 'x'.repeat(2001))), 'note n1 has no short text'],
  ['a note at NaN', page(1, txt('n1', 1, 'a', {x: NaN})), 'note n1 is not on the page'],
  ['a note at null', page(1, txt('n1', 1, 'a', {y: null})), 'note n1 is not on the page'],
  ['a note at Infinity', page(1, txt('n1', 1, 'a', {y: Infinity})), 'note n1 is not on the page'],
  ['a note 50 pages away', page(1, txt('n1', 1, 'a', {x: 50})), 'note n1 is not on the page'],
  ['a note with size NaN', page(1, txt('n1', 1, 'a', {size: NaN})), 'note n1 has size "NaN"'],
  ['a note with a negative size', page(1, txt('n1', 1, 'a', {size: -1})), 'note n1 has size "-1"'],
  ['a note wider than the page', page(1, txt('n1', 1, 'a', {size: 2})), 'note n1 has size "2"'],
  ['a line with no points', page(1, {id: 'a1', t: 'pen', c: '#000000', w: .003, updated: 1}), 'mark a1 has no list of points'],
  ['points as text', page(1, pen('a1', 1, {p: 'x'})), 'mark a1 has no list of points'],
  ['a kind this version does not know, with no points', page(1, {id: 'a1', t: 'shape', c: '#000000', updated: 1}), 'mark a1 has no list of points'],
  ['a NaN point', page(1, pen('a1', 1, {p: [[.1, .1], [NaN, 0]]})), 'mark a1 has a point that is not on the page'],
  ['an infinite point', page(1, pen('a1', 1, {p: [[0, Infinity]]})), 'mark a1 has a point that is not on the page'],
  ['a null point (JSON writes NaN as null)', page(1, pen('a1', 1, {p: [[null, 0]]})), 'mark a1 has a point that is not on the page'],
  ['a point with one number', page(1, pen('a1', 1, {p: [[0]]})), 'mark a1 has a point that is not on the page'],
  ['a point that is text', page(1, pen('a1', 1, {p: ['x']})), 'mark a1 has a point that is not on the page'],
  ['a point a million pages away', page(1, hl('a1', 1, {p: [[1e6, 0]]})), 'mark a1 has a point that is not on the page'],
  ['a point eleven pages to the left', page(1, pen('a1', 1, {p: [[-11, 0]]})), 'mark a1 has a point that is not on the page'],
  ['a width NaN', page(1, pen('a1', 1, {w: NaN})), 'mark a1 has width "NaN"'],
  ['no width', page(1, pen('a1', 1, {w: undefined})), 'mark a1 has width "undefined"'],
  ['a negative width', page(1, pen('a1', 1, {w: -1})), 'mark a1 has width "-1"'],
  ['a width of two pages', page(1, pen('a1', 1, {w: 2})), 'mark a1 has width "2"'],
  ['too many points', page(1, pen('a1', 1, {p: many(200001, () => [0, 0])})), 'mark a1 has no list of points'],
  /* every line and note is drawn in its colour: one with no colour, or a colour that is not "#rrggbb", is refused (the words are
     the code's; REFUSED = any plain reason) */
  ['a pen line with no colour', page(1, pen('a1', 1, {c: undefined})), REFUSED],
  ['a highlighter with no colour', page(1, hl('a1', 1, {c: undefined})), REFUSED],
  ['a note with no colour', page(1, txt('n1', 1, 'a', {c: undefined})), REFUSED],
  ['a colour that is a word', page(1, pen('a1', 1, {c: 'red'})), REFUSED],
  ['a colour of five digits', page(1, hl('a1', 1, {c: '#12345'})), REFUSED],
  ['an empty colour', page(1, txt('n1', 1, 'a', {c: ''})), REFUSED],
  ['a colour with a script in it', page(1, pen('a1', 1, {c: '#000000;background:url(x)'})), REFUSED],
];

async function loopChecks(ctx){
  const M = await load(ctx), B = await loadBackup(ctx);
  const bad = [];
  assert(typeof B.inkProblem === 'function', 'js/backup.js has no inkProblem');
  /* the copies in js/syncink.js */
  if(M.ID_RE.source !== B.ID_RE.source || M.ID_RE.flags !== B.ID_RE.flags) bad.push(`ID_RE in js/syncink.js is ${M.ID_RE}, js/store.js has ${B.ID_RE}`);
  for(const k of Object.keys(M.INK_LIMITS)) if(M.INK_LIMITS[k] !== B.LIMITS[k]) bad.push(`INK_LIMITS.${k} is ${M.INK_LIMITS[k]}, LIMITS.${k} is ${B.LIMITS[k]}`);
  for(const [what, key, value, want] of BACKUP_CASES){
    const got = B.inkProblem(key, value);
    const viaBackup = B.validateBackup({songs: [], sets: [], ink: {[key]: value}});
    if(got !== want) bad.push(`inkProblem, ${what}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    if(viaBackup !== want) bad.push(`validateBackup, ${what}: ${JSON.stringify(viaBackup)}, expected ${JSON.stringify(want)}`);
  }
  /* validateBackup stops at the first bad page, in the order of the list, as before */
  const two = B.validateBackup({songs: [], sets: [], ink: {'s1:1': page(1), 'bad': page(1), 's1:0': page(1)}});
  if(two !== 'an annotation page "bad"') bad.push(`validateBackup with two bad pages: ${two}`);
  if(B.validateBackup({songs: [], sets: [], ink: []}) !== 'the annotations are not a list of pages') bad.push('validateBackup takes a list as the annotations');
  for(const [what, value, want] of SHAPE_CASES){
    const got = M.inkShapeProblem(value);
    if(want === REFUSED ? !(typeof got === 'string' && got.trim() && got.length <= 200 && !/Error|undefined|\[object/.test(got)) : got !== want) bad.push(`inkShapeProblem, ${what}: ${JSON.stringify(got)}, expected ${want === REFUSED ? 'a plain reason' : JSON.stringify(want)}`);
  }
  /* what a sync does with a page from Drive: both checks, on the page as Drive's JSON file gives it back (JSON writes
     NaN and Infinity as null and leaves out undefined): every page keeps its verdict */
  const fromDrive = (key, v) => B.inkProblem(key, v) || M.inkShapeProblem(v);
  for(const [what, value, want] of SHAPE_CASES){
    const got = fromDrive(K, JSON.parse(JSON.stringify(value)));
    if((got === null) !== (want === null)) bad.push(`from Drive (after JSON), ${what}: ${JSON.stringify(got)}`);
  }
  if(fromDrive('bad', page(1)) !== 'an annotation page "bad"') bad.push('from Drive, a bad key is not refused first');
  if(!fromDrive(K, page(1, ...many(50001, i => mark('m' + i, 1))))) bad.push('from Drive, a page of 50001 entries is not refused');
  /* a merged page is still a page both checks pass */
  const res = M.mergePage(SHAPE_CASES[0][1], SHAPE_CASES[2][1]).record;
  if(fromDrive(K, res) !== null) bad.push('a merge of two good pages fails the checks: ' + fromDrive(K, res));
  assert(!bad.length, `ink checks:\n    ${bad.slice(0, 30).join('\n    ')}`);
  console.log(`  sync ink c: ${BACKUP_CASES.length} pages give validateBackup's own words, ${SHAPE_CASES.length} shape cases`);
}

/* ---------- d: names and properties ---------- */
async function loopNames(ctx){
  const M = await load(ctx);
  const bad = [];
  const eq = (what, got, want) => { if(got !== want) bad.push(`${what}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); };
  eq('inkIndexKey', M.inkIndexKey('s1', 3), 's1:3');
  eq('inkFileName', M.inkFileName('s1', 3), 'ink-s1-3.json');
  eq('inkFileName with dashes in the id', M.inkFileName('a-1', 2), 'ink-a-1-2.json');
  eq('inkFileName, last page', M.inkFileName('x', 5000), 'ink-x-5000.json');
  for(const [what, id, p] of [['a space', 'a b', 1], ['a colon', 'a:1', 1], ['page 0', 's1', 0], ['page 5001', 's1', 5001], ['page 1.5', 's1', 1.5], ['page as text', 's1', '3'], ['no id', undefined, 1], ['65 characters', 'x'.repeat(65), 1]]){
    for(const f of ['inkIndexKey', 'inkFileName']){
      let threw = false;
      try{ M[f](id, p); }catch(e){ threw = e instanceof TypeError; }
      if(!threw) bad.push(`${f} took ${what}`);
    }
  }
  /* one name per page: the id and page are read back after the last dash, for ids full of dashes and digits */
  const r = rng(hash32('syncink:names'));
  const chars = 'ab-1-_.9Z';
  const names = new Map();
  for(let i = 0; i < 3000; i++){
    const id = Array.from({length: 1 + r.int(8)}, () => r.pick([...chars])).join(''), p = 1 + r.int(r.chance(.5) ? 12 : 5000);
    const name = M.inkFileName(id, p), m = /^ink-(.+)-([0-9]+)\.json$/.exec(name);
    if(!m || m[1] !== id || Number(m[2]) !== p) bad.push(`${name} does not read back as ${id} page ${p}`);
    if(names.has(name) && names.get(name) !== id + ':' + p) bad.push(`${name} names two pages`);
    names.set(name, id + ':' + p);
  }
  /* properties: written as a sync writes them, read back. h = the SHA-256 (lowercase hex) of the chart the page was drawn on */
  const hex = hexOf('x'), chart = hexOf('the chart');
  for(let i = 0; i < 500; i++){
    const id = 'k' + Array.from({length: r.int(10)}, () => r.pick([...chars])).join(''), p = 1 + r.int(5000);
    const u = r.pick([0, 1, 1.8e12 + r.int(1e9), 8.64e15 - 1e6, r.int(1e6) / 7]), h = hexOf('chart ' + i);
    const props = {k: 'ink', id, p: String(p), u: String(u), c: hex, h};
    const got = M.parseInkProps(props);
    if(!got || got.songId !== id || got.page !== p || got.u !== u || got.c !== hex || got.h !== h) bad.push(`props ${JSON.stringify(props)} read back as ${JSON.stringify(got)}`);
  }
  {
    const got = M.parseInkProps({k: 'ink', id: 's1', p: '2', u: '5', c: hex, h: chart, x: 'y'});
    if(!got || got.songId !== 's1' || got.page !== 2 || got.u !== 5 || got.c !== hex || got.h !== chart || 'x' in got) bad.push('extra properties are not ignored: ' + JSON.stringify(got));
  }
  const good = {k: 'ink', id: 's1', p: '2', u: '1800000000000', c: hex, h: chart};
  if(!M.parseInkProps(good)) bad.push('parseInkProps refused a good set of properties');
  for(const [what, props] of [['null', null], ['a list', []], ['text', 'ink'], ['another kind', {...good, k: 'song'}], ['no kind', {...good, k: undefined}],
    ['a bad id', {...good, id: 'a b'}], ['no id', {...good, id: undefined}], ['an id as a number', {...good, id: 5}],
    ['page 0', {...good, p: '0'}], ['page 01', {...good, p: '01'}], ['page 5001', {...good, p: '5001'}], ['page 1.0', {...good, p: '1.0'}], ['page " 1"', {...good, p: ' 1'}], ['page as a number', {...good, p: 2}], ['page -1', {...good, p: '-1'}],
    ['u empty', {...good, u: ''}], ['u " 5"', {...good, u: ' 5'}], ['u 0x10', {...good, u: '0x10'}], ['u 1e3', {...good, u: '1e3'}], ['u -1', {...good, u: '-1'}], ['u 05', {...good, u: '05'}], ['u 1.50', {...good, u: '1.50'}],
    ['u past the last date', {...good, u: '9000000000000000'}], ['u NaN', {...good, u: 'NaN'}], ['u Infinity', {...good, u: 'Infinity'}], ['u as a number', {...good, u: 5}], ['no u', {...good, u: undefined}],
    ['c upper case', {...good, c: hex.toUpperCase()}], ['c short', {...good, c: hex.slice(1)}], ['no c', {...good, c: undefined}],
    ['no h (a file from before charts were named: a stray)', {...good, h: undefined}], ['h upper case', {...good, h: chart.toUpperCase()}], ['h short', {...good, h: chart.slice(1)}],
    ['h not hex', {...good, h: 'z'.repeat(64)}], ['h as a number', {...good, h: 5}], ['h empty', {...good, h: ''}]]){
    const props2 = props && typeof props === 'object' && !Array.isArray(props) ? Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)) : props;
    if(M.parseInkProps(props2) !== null) bad.push(`parseInkProps took ${what}`);
  }
  /* isEmpty */
  for(const [what, rec, want] of [['no page', null, true], ['no strokes', page(5), true], ['strokes not a list', {updated: 1, strokes: 'x'}, true], ['one stroke', page(1, pen('a', 1)), false], ['only markers', page(1, mark('a', 1)), false]])
    eq(`isEmpty, ${what}`, M.isEmpty(rec), want);
  assert(!bad.length, `names and properties:\n    ${bad.slice(0, 30).join('\n    ')}`);
}

export const loops = [
  {name: 'sync ink a: mergePage by stroke id, newer wins, an erase beats an older stroke, ties the same both ways, order kept', run: loopTable},
  {name: 'sync ink b: two tablets and Drive hold the same marks after random drawing, erasing, note edits, undo and syncs; no stroke lost', run: loopConverge},
  {name: "sync ink c: inkProblem says what validateBackup said; inkShapeProblem refuses what cannot be drawn", run: loopChecks},
  {name: 'sync ink d: ink file names and properties round trip; malformed properties are refused', run: loopNames},
];

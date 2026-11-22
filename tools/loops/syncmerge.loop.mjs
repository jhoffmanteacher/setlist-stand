/* syncmerge.loop.mjs — the Drive sync merge rules (js/syncmerge.js), in Node: no browser page, no Drive.

     node tools/loops.mjs --only "sync merge" [--seed S] [--cases N] [--case I] [--verbose]

   a  every cell of the rule table, with entries made by hand, then once more from real records through indexOf.
   b  canon and digest: key order never matters (at every depth), array order does, a field this code does not know
      changes the hash, a known answer checked against Node's own SHA-256, unicode, and the values JSON cannot carry
      exactly are refused.
   c  breakTie names the same record on both tablets (arguments swapped), for many random pairs.
   d  CONVERGENCE. Two tablets and one Drive, seeded random edits, new records, deletions, collisions on the same
      `updated`, clocks days apart or a year ahead, syncs in random order and cut off part way, and the person's
      answer to "deleted on another tablet" (Keep, Delete here, or no tap yet). The plan is carried out HERE, the way a
      real run does it (down: local := Drive's, up: Drive := local, tie: breakTie decides; an edit is stamped
      max(clock, previous + 1)). Every step checks that a live record is never replaced by an older one and never
      by a deletion marker without a tap, not even when the two have the same `updated` (a delete and an edit in the
      same millisecond: the tablet with the live record is asked). After a last round (A, B, A) with no edits, both tablets and Drive hold the
      same records, compared with this file's own canonical text (not the module's), except where a question is
      still waiting for a tap.
   e  `future` (and the `now` option) and the order of `actions`.
   The app code is imported from ctx.root, so a fault planted in a scratch copy is the code tested. */
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {assert} from './harness.mjs';

const load = ctx => import(pathToFileURL(path.join(ctx.root, 'js', 'syncmerge.js')).href);
const DAY = 864e5, NOW = 1.8e12;
const hexOf = s => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const C1 = hexOf('one'), C2 = hexOf('two');

/* ---------- seeded RNG (mulberry32, as in model.loop.mjs) ---------- */
function hash32(str){ let h = 2166136261; for(const c of str){ h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed){
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  r.int = n => Math.floor(r() * n);
  r.pick = arr => arr[r.int(arr.length)];
  r.chance = p => r() < p;
  return r;
}

/* This file's own canonical text: written apart from js/syncmerge.js (keys by code unit, recursively), used to judge it. */
function refCanon(v){
  if(Array.isArray(v)) return '[' + v.map(refCanon).join(',') + ']';
  if(v && typeof v === 'object'){
    const ks = []; for(const k in v) ks.push(k);
    ks.sort((a, b) => { for(let i = 0; i < Math.min(a.length, b.length); i++){ const d = a.charCodeAt(i) - b.charCodeAt(i); if(d) return d; } return a.length - b.length; });
    return '{' + ks.map(k => JSON.stringify(k) + ':' + refCanon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/* ---------- a: the rule table ---------- */
const E = (u, c, d = false) => ({u, c, d});
/* [what, L, R, expected op or null, counts as same] */
const TABLE = [];
{
  const LIVE = false, MARK = true;
  TABLE.push(['only L live', E(5, C1), null, 'up']);
  TABLE.push(['only L marker', E(5, C1, MARK), null, 'up']);
  TABLE.push(['only R live', null, E(5, C1), 'down']);
  TABLE.push(['only R marker (never had it)', null, E(5, C1, MARK), null]);
  for(const [lc, rc, cw] of [[C1, C1, 'same c'], [C1, C2, 'different c']]){
    for(const [ld, rd] of [[LIVE, LIVE], [LIVE, MARK], [MARK, LIVE], [MARK, MARK]]){
      if(cw === 'same c' && ld !== rd) continue;              // one hash cannot be a live record and a marker
      const w = `L ${ld ? 'marker' : 'live'} R ${rd ? 'marker' : 'live'}, ${cw}`;
      TABLE.push([`L newer, ${w}`, E(9, lc, ld), E(5, rc, rd), 'up']);
      TABLE.push([`L older, ${w}`, E(5, lc, ld), E(9, rc, rd), !rd ? 'down' : ld ? null : 'askDelete']);
      TABLE.push([`equal u, ${w}`, E(7, lc, ld), E(7, rc, rd), cw === 'same c' ? null : rd && !ld ? 'askDelete' : ld && !rd ? 'up' : 'tie', cw === 'same c']);
    }
  }
  /* the cells that matter most, with the u far apart, at 0, and a year ahead */
  TABLE.push(['L live u 0 vs R live u 1', E(0, C1), E(1, C2), 'down']);
  TABLE.push(['L live a year ahead vs R marker now', E(NOW + 365 * DAY, C1), E(NOW, C2, true), 'up']);
  TABLE.push(['L live now vs R marker a year ahead', E(NOW, C1), E(NOW + 365 * DAY, C2, true), 'askDelete']);
  TABLE.push(['L marker a year ahead vs R live now', E(NOW + 365 * DAY, C1, true), E(NOW, C2), 'up']);
  TABLE.push(['equal u 0, L live vs R marker', E(0, C1), E(0, C2, true), 'askDelete']);
  TABLE.push(['equal u 0, L marker vs R live', E(0, C1, true), E(0, C2), 'up']);
  TABLE.push(['equal u a year ahead, L live vs R marker', E(NOW + 365 * DAY, C1), E(NOW + 365 * DAY, C2, true), 'askDelete']);
  TABLE.push(['equal u a year ahead, L marker vs R live', E(NOW + 365 * DAY, C1, true), E(NOW + 365 * DAY, C2), 'up']);
}

async function loopTable(ctx){
  const M = await load(ctx);
  assert(JSON.stringify(M.KINDS) === '["coll","song","set"]', `KINDS is ${JSON.stringify(M.KINDS)}`);
  const bad = [];
  for(const kind of M.KINDS) for(const [what, L, R, want, same] of TABLE){
    const local = {coll: new Map(), song: new Map(), set: new Map()}, remote = {coll: new Map(), song: new Map(), set: new Map()};
    if(L) local[kind].set('x', L);
    if(R) remote[kind].set('x', R);
    const p = M.plan(local, remote, {now: NOW});
    const got = p.actions.length ? p.actions.map(a => `${a.op} ${a.kind} ${a.id}`).join('; ') : null;
    const exp = want ? `${want} ${kind} x` : null;
    if(got !== exp) bad.push(`${kind}, ${what}: got ${got || 'nothing'}, expected ${exp || 'nothing'}`);
    if(p.same !== (same ? 1 : 0)) bad.push(`${kind}, ${what}: same = ${p.same}, expected ${same ? 1 : 0}`);
  }
  assert(!bad.length, `rule table:\n    ${bad.join('\n    ')}`);

  /* missing kinds and empty input */
  const e = M.plan({}, {}, {now: NOW});
  assert(e.actions.length === 0 && e.future.length === 0 && e.same === 0, 'an empty plan is not empty');
  const half = M.plan({song: new Map([['a', E(1, C1)]])}, {}, {now: NOW});
  assert(half.actions.length === 1 && half.actions[0].op === 'up', 'a side with no map for a kind is not taken as empty');

  /* the same cells from real records: indexOf -> plan */
  const live = (id, u, x = 1) => ({id, song: 'Song ' + x, artist: '', archived: false, colls: [], pages: 1, added: 1, updated: u});
  const mark = (id, u) => ({id, deleted: true, updated: u});
  const idx = async rs => ({coll: new Map(), song: await M.indexOf(rs), set: new Map()});
  const L = await idx([live('a', 5), live('b', 5), live('c', 9), live('d', 5), mark('e', 5), live('f', 7, 1), live('g', 7), mark('h', 3), mark('j', 4), mark('m', 6)]);
  const R = await idx([live('b', 5), live('c', 5, 2), mark('d', 9), live('e', 9), live('f', 7, 2), mark('g', 7), mark('h', 8), live('i', 1), live('j', 4), mark('m', 6)]);
  const got = M.plan(L, R, {now: NOW});
  const exp = 'up song a; up song c; askDelete song d; down song e; tie song f; askDelete song g; down song i; up song j';
  assert(got.actions.map(a => `${a.op} ${a.kind} ${a.id}`).join('; ') === exp, `from records: ${JSON.stringify(got.actions)}, expected ${exp}`);
  assert(got.same === 2, `from records: same = ${got.same}, expected 2 (b, m)`);
  const ix = await M.indexOf([live('a', 5), mark('e', 6), {id: 'old', song: 'No date'}]);
  assert(ix.get('a').d === false && ix.get('e').d === true && ix.get('e').u === 6 && ix.get('a').u === 5, 'indexOf entries');
  assert(ix.get('a').c === hexOf(refCanon(live('a', 5))), 'indexOf c is not the SHA-256 of the canonical text');
  assert(ix.get('old').u === 0, 'a record with no updated');
  /* an entry plan cannot judge is refused, never guessed */
  for(const [what, ent] of [['u NaN', E(NaN, C1)], ['u as text', E('5', C1)], ['no c', {u: 5, d: false}], ['c not hex', E(5, 'abc')]]){
    let threw = false;
    try{ M.plan({song: new Map([['a', ent]])}, {}, {now: NOW}); }catch(err){ threw = true; }
    assert(threw, `plan took an entry with ${what}`);
  }
}

/* ---------- b: canon and digest ---------- */
function randValue(r, depth){
  const k = r.int(depth > 2 ? 5 : 8);
  if(k === 0) return null;
  if(k === 1) return r.chance(.5);
  if(k === 2) return r.pick([0, -1, 3.25, 1e21, 2 ** 53 - 1, 1e-7, 12345]);
  if(k === 3 || k === 4) return r.pick(['', 'a', 'É', 'é', 'B♭', 'F♯', '🎸', 'line\nbreak', '"q"', '\\', ' ', 'Ça']);
  if(k === 5 || k === 6){ const o = {}; for(let i = r.int(5); i-- > 0;) o[r.pick(['id', 'b', 'a', 'Z', '10', '2', 'é', 'é', 'x y', '_'])] = randValue(r, depth + 1); return o; }
  return Array.from({length: r.int(4)}, () => randValue(r, depth + 1));
}
function shuffled(v, r){
  if(Array.isArray(v)) return v.map(x => shuffled(x, r));
  if(v && typeof v === 'object'){
    const ks = Object.keys(v);
    for(let i = ks.length - 1; i > 0; i--){ const j = r.int(i + 1); [ks[i], ks[j]] = [ks[j], ks[i]]; }
    const o = {}; for(const k of ks) o[k] = shuffled(v[k], r); return o;
  }
  return v;
}

async function loopCanon(ctx){
  const M = await load(ctx);
  /* key order, at every depth (the object is built in another order at every level) */
  const a = {id: 's1', z: 1, crop: {pages: {'2': {x: 0, y: 0, w: 1, h: .5}, '10': {h: 1, w: 1, y: 0, x: 0}}, all: null}, items: [{type: 'song', id: 'q'}]};
  const b = {items: [{id: 'q', type: 'song'}], crop: {all: null, pages: {'10': {x: 0, y: 0, w: 1, h: 1}, '2': {h: .5, w: 1, x: 0, y: 0}}}, z: 1, id: 's1'};
  assert(M.canon(a) === M.canon(b), `key order changes canon:\n    ${M.canon(a)}\n    ${M.canon(b)}`);
  const r = rng(hash32('canon'));
  for(let i = 0; i < 500; i++){
    const v = randValue(r, 0), w = shuffled(v, r);
    const cv = M.canon(v);
    assert(cv === M.canon(w), `key order changes canon for ${JSON.stringify(v)} vs ${JSON.stringify(w)}`);
    assert(cv === refCanon(v), `canon differs from the plain definition:\n    ${cv}\n    ${refCanon(v)}`);
    assert(M.canon(JSON.parse(JSON.stringify(v))) === cv, 'a record read back from Drive JSON has another canon');
    assert(!/[ \t]/.test(cv.replace(/"(?:[^"\\]|\\.)*"/g, '')), `canon has spaces outside strings: ${cv}`);
  }
  /* array order matters */
  assert(M.canon([1, 2]) !== M.canon([2, 1]), 'array order is ignored');
  const set1 = {id: 'x', items: [{type: 'song', id: 'a'}, {type: 'song', id: 'b'}], updated: 5};
  const set2 = {id: 'x', items: [{type: 'song', id: 'b'}, {type: 'song', id: 'a'}], updated: 5};
  assert(await M.digest(M.canon(set1)) !== await M.digest(M.canon(set2)), 'two setlist orders give the same hash');
  /* a field this code does not know changes c, at the top and deep inside */
  const base = {id: 'x', song: 'A', crop: {all: null}, updated: 5};
  const c0 = await M.digest(M.canon(base));
  assert(c0 !== await M.digest(M.canon({...base, futureField: 1})), 'an unknown field does not change the hash');
  assert(c0 !== await M.digest(M.canon({...base, crop: {all: null, later: true}})), 'an unknown nested field does not change the hash');
  assert(c0 !== await M.digest(M.canon({...base, futureField: null})), 'an unknown null field does not change the hash');

  /* known answer: the canonical text written out by hand, its hash from node:crypto */
  const rec = {updated: 1763700000000, id: 'abc_1', song: 'Café B♭ 🎸', artist: '', archived: false, colls: ['c2', 'c1'], pages: 3,
    crop: {pages: {'10': {x: .1, y: 0, w: .8, h: 1}, '2': {x: 0, y: 0, w: 1, h: .5}}, all: null}, added: 1763600000000, extra: {b: [true, null, -0.5], a: 'é'}};
  const text = '{"added":1763600000000,"archived":false,"artist":"","colls":["c2","c1"],"crop":{"all":null,"pages":{"10":{"h":1,"w":0.8,"x":0.1,"y":0},"2":{"h":0.5,"w":1,"x":0,"y":0}}},'
    + '"extra":{"a":"é","b":[true,null,-0.5]},"id":"abc_1","pages":3,"song":"Café B♭ 🎸","updated":1763700000000}';
  assert(M.canon(rec) === text, `canon of the fixed record:\n    ${M.canon(rec)}\n    expected ${text}`);
  const want = hexOf(text);
  const got = await M.digest(M.canon(rec));
  assert(got === want, `digest of the fixed record: ${got}, node:crypto says ${want}`);
  assert(await M.digest('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'digest of empty text');
  /* unicode: the UTF-8 bytes are hashed; composed and decomposed é are different records (no silent normalising) */
  for(const s of ['É', 'é', '🎸', 'B♭ F♯', ' ', 'ü'.repeat(300)]) assert(await M.digest(s) === hexOf(s), `digest of ${JSON.stringify(s)} is not SHA-256 of its UTF-8`);
  assert(M.canon({s: 'é'}) !== M.canon({s: 'é'}), 'two spellings of é canonicalise the same');
  assert(JSON.parse(M.canon({s: '🎸 "'})).s === '🎸 "', 'unicode does not survive canon');
  assert(M.canon(-0) === '0' && M.canon(1e21) === '1e+21' && M.canon(0.1) === '0.1', 'numbers are not written as JSON writes them');
  /* what JSON cannot carry exactly is refused with an error, never dropped or turned into null */
  const sparse = [1]; sparse[2] = 3;
  const cyc = {id: 'x'}; cyc.self = cyc;
  const refuse = [['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['undefined', undefined], ['a field undefined', {id: 'x', crop: undefined}],
    ['NaN inside', {id: 'x', crop: {all: {x: NaN}}}], ['undefined in an array', [1, undefined]], ['a function', {f(){}}], ['a Date', {d: new Date(0)}],
    ['a sparse array', sparse], ['a cycle', cyc], ['a bigint', 1n], ['a symbol', Symbol('s')], ['a Map', new Map()]];
  for(const [what, v] of refuse){
    let err = null;
    try{ M.canon(v); }catch(e){ err = e; }
    assert(err instanceof Error && err.message, `canon took ${what}`);
  }
}

/* ---------- c: breakTie names the same record on both tablets ---------- */
async function loopTie(ctx){
  const M = await load(ctx);
  const r = rng(hash32('tie'));
  const pairs = [[{id: 'x', a: 1, updated: 5}, {id: 'x', a: 2, updated: 5}], [{id: 'x', deleted: true, updated: 5}, {id: 'x', song: 'A', updated: 5}],
    [{id: 'x', s: 'ab'}, {id: 'x', s: 'a'}], [{id: 'x', s: 'é'}, {id: 'x', s: 'é'}], [{id: 'x', s: '🎸'}, {id: 'x', s: '￿'}]];
  for(let i = 0; i < 3000; i++){
    const a = {id: 'x', updated: 5, v: randValue(r, 1)};
    const b = r.chance(.3) ? {...a, v: randValue(r, 1)} : {...a, w: randValue(r, 2)};
    pairs.push([a, b]);
  }
  let checked = 0;
  for(const [a, b] of pairs){
    if(refCanon(a) === refCanon(b)) continue;
    const onA = M.breakTie(a, b), onB = M.breakTie(b, a);
    assert(onA === 'local' || onA === 'remote', `breakTie said ${onA}`);
    const keptA = onA === 'local' ? a : b, keptB = onB === 'local' ? b : a;
    assert(keptA === keptB, `the two tablets keep different records:\n    ${JSON.stringify(a)}\n    ${JSON.stringify(b)}\n    A says ${onA}, B says ${onB}`);
    assert(M.breakTie(a, b) === onA, 'breakTie gives another answer the second time');
    checked++;
  }
  assert(checked > 2500, `only ${checked} pairs were different`);
  /* the same record written in another key order is no tie: both keep their own, which is the same record */
  assert(M.breakTie({id: 'x', a: 1}, {a: 1, id: 'x'}) === 'local', 'the same record in another key order');
}

/* ---------- d: convergence ---------- */
const KINDS_T = ['coll', 'song', 'set'];
const WORDS = ['A', 'B', 'Café', 'B♭', '🎸', 'x'];
function content(r, kind, id){
  if(kind === 'song'){
    const s = {id, song: r.pick(WORDS), artist: r.pick(['', 'Zoë']), archived: r.chance(.2), colls: r.chance(.5) ? [] : ['c' + r.int(3)], pages: 1 + r.int(3), added: 1};
    if(r.chance(.3)) s.later = {kept: r.pick(WORDS)};           // a field this code does not know
    if(r.chance(.2)) s.crop = {all: null, pages: {'2': {x: 0, y: 0, w: 1, h: .5}}};
    return s;
  }
  if(kind === 'set') return {id, name: r.pick(WORDS), items: Array.from({length: r.int(3)}, (_, i) => r.chance(.7) ? {type: 'song', id: 'k' + r.int(5)} : {type: 'break', id: 'b' + i, name: r.pick(WORDS)}), created: 1};
  return {id, name: r.pick(WORDS), created: 1};
}
const isLive = rec => rec && rec.deleted !== true;

async function scenario(M, seed, n, log){
  const r = rng(hash32(`syncmerge:${seed}:${n}`));
  let T = NOW + r.int(1000);
  const OFFS = [0, 0, 0, 3 * DAY, -2 * DAY, 365 * DAY, -40 * DAY];
  const tab = name => ({name, off: r.pick(OFFS), db: {coll: new Map(), song: new Map(), set: new Map()}, pending: new Set()});
  const A = tab('A'), B = tab('B'), tabs = [A, B];
  const drive = {coll: new Map(), song: new Map(), set: new Map()};
  const clock = t => T + t.off;
  const stamp = (t, prev) => Math.max(clock(t), (Number(prev && prev.updated) || 0) + 1);
  const cache = new Map();
  const entryOf = async rec => {                               // indexOf, one record at a time, remembered by canon text
    const key = M.canon(rec);
    if(!cache.has(key)) cache.set(key, (await M.indexOf([rec])).get(rec.id));
    return cache.get(key);
  };
  let ids = 0, syncs = 0, steps = 0;
  const seen = {tie: 0, askDelete: 0, keep: 0, delete: 0, cut: 0, future: 0, live: 0, gone: 0};
  const fail = msg => { throw new Error(msg); };
  const liveIds = (t, kind) => [...t.db[kind].entries()].filter(([, v]) => isLive(v)).map(([id]) => id);

  const sync = async (t, {taps = true, cut = false} = {}) => {
    syncs++;
    const local = {}, remote = {};
    for(const kind of KINDS_T){
      local[kind] = new Map();
      for(const [id, rec] of t.db[kind]) local[kind].set(id, await entryOf(rec));
      remote[kind] = drive[kind];                                // {record, u, c, d}: plan reads u, c, d
    }
    const p = M.plan(local, remote, {now: clock(t)});
    const acts = cut ? p.actions.slice(0, r.int(p.actions.length + 1)) : p.actions;
    if(cut) seen.cut++;
    seen.future += p.future.length;
    t.pending.clear();
    const up = async (kind, id, why) => {
      const rec = structuredClone(t.db[kind].get(id)), had = drive[kind].get(id);
      const level = rec.updated === had?.u && (why === 'tie' || (!isLive(rec) && !had.d));   // a tie, or this tablet's marker over a live record of the same time
      if(had && !(rec.updated > had.u || level)) fail(`${t.name} up ${kind} ${id}: u ${rec.updated} over Drive's ${had.u}`);
      drive[kind].set(id, {record: rec, ...(await entryOf(rec))});
    };
    const down = (kind, id, why) => {
      const had = t.db[kind].get(id), rem = drive[kind].get(id);
      if(!rem) fail(`${t.name} down ${kind} ${id}: Drive has no such record`);
      if(!isLive(rem.record) && (isLive(had) || why !== 'tie')) fail(`${t.name} down ${kind} ${id}: a deletion marker taken over a live record without a tap`);
      if(had && !(rem.u > had.updated || (why === 'tie' && rem.u === had.updated))) fail(`${t.name} down ${kind} ${id}: Drive's u ${rem.u} over the local ${had.updated} (an older record wins)`);
      t.db[kind].set(id, shuffled(rem.record, r));              // stored here with its keys in another order: the same record
    };
    for(const {op, kind, id} of acts){
      const loc = t.db[kind].get(id), rem = drive[kind].get(id);
      if(op in seen) seen[op]++;
      log(`    ${t.name} ${op} ${kind} ${id}${loc ? ` L${isLive(loc) ? '' : '(marker)'} u=${loc.updated}` : ''}${rem ? ` R${rem.d ? '(marker)' : ''} u=${rem.u}` : ''}`);
      if(op === 'up') await up(kind, id, 'up');
      else if(op === 'down') down(kind, id, 'down');
      else if(op === 'tie'){
        if(!loc || !rem || loc.updated !== rem.u) fail(`${t.name} tie ${kind} ${id} without the same u on both sides`);
        if(M.breakTie(loc, rem.record) === 'local') await up(kind, id, 'tie'); else down(kind, id, 'tie');
      } else if(op === 'askDelete'){
        if(!isLive(loc) || !rem || !rem.d || !(rem.u >= loc.updated)) fail(`${t.name} askDelete ${kind} ${id} for something that is not a newer marker over a live record`);
        const ans = taps === 'answer' ? r.pick(['keep', 'delete']) : taps ? r.pick(['keep', 'keep', 'delete', 'delete', 'wait']) : 'wait';
        if(ans in seen) seen[ans]++;
        log(`      tap: ${ans}`);
        if(ans === 'keep') t.db[kind].set(id, {...loc, updated: Math.max(clock(t), rem.u + 1)});
        else if(ans === 'delete') t.db[kind].set(id, {id, deleted: true, updated: rem.u});
        else t.pending.add(kind + ' ' + id);
      } else fail(`unknown op ${op}`);
    }
    return p;
  };

  const STEPS = 20 + r.int(25);
  for(; steps < STEPS; steps++){
    const t = r.pick(tabs), o = t === A ? B : A, kind = r.pick(KINDS_T);
    if(r.chance(.15)) T += r.pick([1, 60e3, 3600e3, DAY]); else T += r.int(3);
    if(r.chance(.03)){ t.off = r.pick(OFFS); log(`  ${t.name} clock now ${t.off / DAY} days off`); }
    const k = r.int(100);
    if(k < 30){ log(`  sync ${t.name}`); await sync(t, {cut: r.chance(.15)}); continue; }
    const live = liveIds(t, kind);
    if(k < 45 || !live.length){
      const id = 'k' + (++ids);
      t.db[kind].set(id, {...content(r, kind, id), updated: clock(t)});
      log(`  ${t.name} new ${kind} ${id} u=${clock(t)}`);
    } else if(k < 70){
      const id = r.pick(live), prev = t.db[kind].get(id);
      t.db[kind].set(id, {...content(r, kind, id), updated: stamp(t, prev)});
      log(`  ${t.name} edit ${kind} ${id} u=${t.db[kind].get(id).updated}`);
    } else if(k < 82){
      const id = r.pick(live), prev = t.db[kind].get(id);
      t.db[kind].set(id, {id, deleted: true, updated: stamp(t, prev)});
      log(`  ${t.name} delete ${kind} ${id} u=${t.db[kind].get(id).updated}`);
    } else {
      /* a collision: both tablets change the same version of a record in the same millisecond (one may delete it) */
      const both = live.filter(id => { const x = o.db[kind].get(id); return isLive(x) && x.updated === t.db[kind].get(id).updated; });
      if(!both.length) continue;
      const id = r.pick(both), u = t.db[kind].get(id).updated + 1;
      t.db[kind].set(id, {...content(r, kind, id), updated: u});
      o.db[kind].set(id, r.chance(.3) ? {id, deleted: true, updated: u} : {...content(r, kind, id), updated: u});
      log(`  collision on ${kind} ${id} u=${u}${isLive(o.db[kind].get(id)) ? '' : ` (${o.name} deletes)`}`);
    }
  }
  /* the person answers every question once on each tablet, then the last round: no edits, no taps */
  log('  each tablet answers its questions');
  for(const t of r.chance(.5) ? [A, B] : [B, A]) await sync(t, {taps: 'answer'});
  log('  last round A, B, A');
  for(const t of [A, B, A]) await sync(t, {taps: false});
  const waiting = new Set([...A.pending, ...B.pending]);
  /* settled: one more plan on either tablet finds nothing to do but the questions still waiting */
  for(const t of tabs){
    const local = {};
    for(const kind of KINDS_T){ local[kind] = new Map(); for(const [id, rec] of t.db[kind]) local[kind].set(id, await entryOf(rec)); }
    const left = M.plan(local, drive, {now: clock(t)}).actions.filter(a => !(a.op === 'askDelete' && t.pending.has(a.kind + ' ' + a.id)));
    if(left.length) fail(`${t.name} still has work after the last round: ${left.map(a => `${a.op} ${a.kind} ${a.id}`).join(', ')}`);
  }
  for(const kind of KINDS_T){
    const all = new Set([...A.db[kind].keys(), ...B.db[kind].keys(), ...drive[kind].keys()]);
    for(const id of all){
      const a = A.db[kind].get(id), b = B.db[kind].get(id), d = drive[kind].get(id);
      if(!d) fail(`${kind} ${id} never reached Drive`);
      if(waiting.has(kind + ' ' + id)){
        for(const t of tabs) if(t.pending.has(kind + ' ' + id) && !isLive(t.db[kind].get(id))) fail(`${t.name} lost ${kind} ${id} while its question waits`);
        if(!d.d) fail(`${kind} ${id} waits for a tap but Drive holds a live record`);
        continue;
      }
      const recs = [a, b, d.record];
      if(recs.some(isLive)){
        seen.live++;
        const cs = recs.map(x => x ? refCanon(x) : '(none)');
        if(!(cs[0] === cs[1] && cs[1] === cs[2])) fail(`${kind} ${id} differs after the last round:\n      A ${cs[0]}\n      B ${cs[1]}\n      Drive ${cs[2]}`);
      }
      else seen.gone++;
      /* otherwise deleted everywhere (absent here = never had it); markers may carry different times: plan leaves an older local marker as it is */
    }
  }
  return {syncs, steps, waiting: waiting.size, seen};
}

async function loopConverge(ctx){
  const M = await load(ctx);
  const {seed, verbose} = ctx.opts;
  const n = ctx.opts.cases || 2500;
  const cases = ctx.opts.case != null ? [ctx.opts.case] : Array.from({length: n}, (_, i) => i + 1);
  const t0 = Date.now();
  let syncs = 0, steps = 0, waiting = 0;
  const seen = {};
  for(const c of cases){
    const lines = [];
    const log = l => { lines.push(l); if(verbose) console.log(l); };
    try{ const s = await scenario(M, seed, c, log); syncs += s.syncs; steps += s.steps; waiting += s.waiting; for(const k in s.seen) seen[k] = (seen[k] || 0) + s.seen[k]; }
    catch(e){
      throw new Error(`scenario ${c} (seed ${seed}): ${e.message}\n  last steps:\n${lines.slice(-12).join('\n')}\n  replay: node tools/loops.mjs --only "sync merge d" --seed ${seed} --case ${c} --verbose`);
    }
  }
  console.log(`  sync merge: ${cases.length} scenarios, seed ${seed}, ${steps} steps, ${syncs} syncs (${seen.cut} cut off), ${seen.tie} ties, ${seen.askDelete} questions`
    + ` (${seen.keep} Keep, ${seen.delete} Delete here, ${waiting} still waiting), ${seen.future} future entries; at the end ${seen.live} live records equal everywhere, ${seen.gone} deleted; ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/* ---------- e: future, now, and the order of actions ---------- */
async function loopFuture(ctx){
  const M = await load(ctx);
  const m = pairs => new Map(pairs);
  const local = {song: m([['a', E(NOW + DAY, C1)], ['b', E(NOW + DAY + 1, C1)], ['c', E(NOW, C1)], ['d', E(NOW + 30 * DAY, C1)]]), coll: m([['z', E(NOW + 365 * DAY, C1, true)]])};
  const remote = {song: m([['c', E(NOW + 2 * DAY, C2)], ['d', E(NOW + 40 * DAY, C2)], ['e', E(NOW + 365 * DAY, C2)]]), set: m([['q', E(NOW + 3 * DAY, C2, true)]])};
  const p = M.plan(local, remote, {now: NOW});
  const fut = p.future.map(f => `${f.kind} ${f.id} ${f.u - NOW}`).join('; ');
  const want = `coll z ${365 * DAY}; song b ${DAY + 1}; song c ${2 * DAY}; song d ${40 * DAY}; song e ${365 * DAY}; set q ${3 * DAY}`;
  assert(fut === want, `future: got ${fut || 'nothing'}, expected ${want}`);
  /* still synced: every one of them has its action (q, a marker only on Drive, has none) */
  const acts = p.actions.map(a => `${a.op} ${a.kind} ${a.id}`).join('; ');
  assert(acts === 'up coll z; up song a; up song b; down song c; down song d; down song e', `actions with future entries: ${acts}`);
  /* a day ahead exactly is not the future; `now` defaults to the clock */
  assert(M.plan({song: m([['a', E(Date.now() + 2 * DAY, C1)]])}, {}).future.length === 1, 'without `now`, two days ahead of the clock is not reported');
  assert(M.plan({song: m([['a', E(Date.now(), C1)]])}, {}).future.length === 0, 'without `now`, a record made now is reported as future');
  assert(M.plan(local, remote, {now: NOW + 400 * DAY}).future.length === 0, '`now` is ignored');

  /* order: KINDS first, then id by code unit, whatever order the maps were filled in */
  const ids = ['b', 'a', 'B', 'a1', '10', '9', 'é', 'e', '_'];
  const sorted = [...ids].sort((x, y) => x < y ? -1 : x > y ? 1 : 0);
  const fill = list => ({set: m(list.map(id => [id, E(1, C1)])), song: m(list.map(id => [id, E(1, C1)])), coll: m(list.map(id => [id, E(1, C1)]))});
  const p1 = M.plan(fill(ids), {}, {now: NOW}), p2 = M.plan(fill([...ids].reverse()), {}, {now: NOW});
  const want2 = ['coll', 'song', 'set'].flatMap(k => sorted.map(id => `up ${k} ${id}`)).join('; ');
  assert(p1.actions.map(a => `${a.op} ${a.kind} ${a.id}`).join('; ') === want2, `action order: ${p1.actions.map(a => a.kind + ' ' + a.id).join(', ')}`);
  assert(JSON.stringify(p1) === JSON.stringify(p2), 'two runs on the same input in another map order disagree');
  /* local-only and remote-only ids interleave in one sorted list */
  const p3 = M.plan({song: m([['b', E(1, C1)], ['d', E(1, C1)]])}, {song: m([['c', E(1, C1)], ['a', E(1, C1)]])}, {now: NOW});
  assert(p3.actions.map(a => a.op + ' ' + a.id).join(', ') === 'down a, up b, down c, up d', `mixed order: ${p3.actions.map(a => a.op + ' ' + a.id).join(', ')}`);
}

export const loops = [
  {name: 'sync merge a: every cell of the rule table gives its action (and indexOf, from real records)', run: loopTable},
  {name: 'sync merge b: canon ignores key order at every depth, keeps array order, refuses NaN and undefined; digest is SHA-256 of UTF-8', run: loopCanon},
  {name: 'sync merge c: breakTie names the same record on both tablets', run: loopTie},
  {name: 'sync merge d: two tablets and Drive agree after random edits, deletions, collisions, odd clocks and taps; nothing live deleted without a tap', run: loopConverge},
  {name: 'sync merge e: future entries are reported (and `now` is used); actions come out by kind, then id', run: loopFuture},
];

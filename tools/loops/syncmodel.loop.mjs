/*
 * "sync model marks" (under WebKit: "sync 7 model marks"): seeded random sequences of marks on two tablets with Syncs in
 * between, against the independent model of Part 3 (the marks step in sync-model.mjs, written from the spec, never from
 * js/syncink.js).
 *
 *     node tools/loops.mjs --only "sync model marks" [--seed S] [--cases N] [--case I] [--verbose]
 *
 * Each case: a synced pair (startPair) plus a live three-page song; in odd cases tablet B's clock is 2 hours behind. Then a
 * random sequence on either tablet: draw a pen or highlighter stroke, add a text note, erase a stroke, edit or move a note,
 * undo an erase made on that tablet (reconcile, as Undo saves it), Sync, and, on A, New version (made through the Library's
 * button, with a new chart of 1 to 3 pages; the tablets are synced just before and B syncs just after, so B never draws on an
 * old chart it has not heard is replaced: what the app does with such marks is a Part 2 rule, tested in sync 6e). Marks are made
 * through js/store.js the way js/ink.js saves them (putInk, stamp, reconcile); each local action is checked (a new mark is
 * dated now, an erase or edit is stamped after what it replaces, nothing else on the page changes) and then taken by the
 * model. After every Sync: the tablet, the other tablet and Drive (readMarks: layout, u, c) equal the model by stroke id, and
 * the report's "Sent / Got marks on N page(s)" equal the model's. At the end: Syncs A, B, A, B; then a Sync on each says
 * "Everything is up to date" and writes nothing; the same after a reload; and after Back up -> wipe -> Restore on A.
 * A failure prints the command that replays it.
 */
import {assert, sleep, backupNow, restoreZip, wipe, idbAll} from './harness.mjs';
import {syncTap, libraryOf, readDrive, setClock, clockOf, takeWrites, halfSongs} from './sync-two.mjs';
import {startPair, roles, live, addCopies, whole} from './sync-kit.mjs';
import {newModel, addTablet, inkSeed, inkSeedDrive, inkLocal, inkSync, inkCompareTablet, inkCompareDrive, inkNewVersion, inkAdoptLoose, canon} from './sync-model.mjs';
import {readMarks, splitKey, entriesOf, hostileIn, inkOf, pageOf, addEntries, eraseIds, editNote, undoErase, penLine, hlLine, textNote, PEN, HL, HOUR,
  watchReports, syncRead, marksCounts, writesBy, makePdf, newVersionUi, ENGINE_NAME} from './sync-ink-kit.mjs';

const NAME = ENGINE_NAME === 'webkit' ? 'sync 7 model marks (= sync model marks in WebKit)' : 'sync model marks';
const STEPS = 18;

function hash32(str){ let h = 2166136261; for(const c of str){ h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed){
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  r.int = n => Math.floor(r() * n);
  r.pick = arr => arr[r.int(arr.length)];
  r.chance = p => r() < p;
  return r;
}
const r4 = v => Math.round(v * 1e4) / 1e4;
const driveSongs = google => Object.fromEntries(readDrive(google).recs.song);

async function runCase(ctx, seed, ci){
  const R = rng(hash32(`sync-marks:${seed}:${ci}`)), log = [];
  const say = s => { log.push(s); if(ctx.opts.verbose) console.log('    ' + s); };
  const {A, B} = await startPair(ctx);
  const T = {A, B};
  try{
    await watchReports(A); await watchReports(B);
    const {c} = roles(await libraryOf(A));
    await addCopies(A, 1, 'mm', {from: c.id});                       // a live three-page song
    for(const t of [A, B]){ const rep = await syncRead(t); assert(rep.state === 'finished', 'setup sync: ' + rep.text); }
    if(ci % 2 === 1){ await setClock(B, -2 * HOUR); say('B\'s clock is 2 hours behind'); }
    const m = newModel();
    for(const t of [A, B]){ const L = await libraryOf(t); addTablet(m, t.name, L); inkSeed(m, t.name, L.ink); }
    { const rm = readMarks(A.google); inkSeedDrive(m, rm.pages, rm.h); }
    const erased = {A: [], B: []};
    let n = 0;
    const mid = id => `${ci}x${n++}${id}`;

    const check = async (what, tablets = [A, B]) => {
      const g = A.google, marks = readMarks(g), ds = driveSongs(g), out = [...marks.problems.map(p => 'Drive marks layout: ' + p), ...inkCompareDrive(m, marks.pages, ds, marks.h)];
      const libs = [];
      for(const t of tablets){ const L = await libraryOf(t); libs.push([t.name, L]); out.push(...inkCompareTablet(m, t.name, L), ...whole(L).map(p => `${t.name}: ${p}`), ...hostileIn(L).map(p => `${t.name}: ${p}`)); }
      assert(!out.length, `${what}: the app, Drive and the model disagree on marks:\n    ` + out.slice(0, 14).join('\n    '));
      for(const [n, L] of libs) inkAdoptLoose(m, n, L, marks.pages);
    };
    const sync = async (who, what) => {
      const t = T[who], before = (await libraryOf(t)).songs;
      await takeWrites(t);
      const rep = await syncRead(t);
      assert(rep.state === 'finished', `${what}: the sync did not finish: ${rep.text.slice(0, 400)}`);
      const half = halfSongs(await takeWrites(t));
      assert(!half.length, `${what}: ${half.join('; ')}`);
      const after = (await libraryOf(t)).songs;
      const r = inkSync(m, who, {before, after, driveSongs: driveSongs(t.google), drivePdfs: new Map([...readDrive(t.google).pdfs].map(([k, v]) => [k, v.hash]))});
      assert(!r.problems.length, `${what}: ${r.problems.join('; ')}`);
      say(`${what}: "${rep.text.slice(0, 160)}" | model sent ${r.sent.length} got ${r.got.length}${r.moved.length ? ' moved ' + r.moved.length : ''}`);
      if(!r.moved.length){
        const cn = marksCounts(rep.text), slack = [...readMarks(t.google).pages.keys()].filter(k => m.inkLoose && m.inkLoose.has(splitKey(k).id)).length;
        const ok = (x, w) => x >= w && x <= w + slack;
        assert(ok(cn.sent, r.sent.length) && ok(cn.got, r.got.length), `${what}: the report counts marks sent on ${cn.sent} and got on ${cn.got} page(s); the model sent ${r.sent.length} (${r.sent.join(', ')}) and got ${r.got.length} (${r.got.join(', ')}): "${rep.text.slice(0, 300)}"`);
      }
      await check(what);
      return rep;
    };
    /* the pages marks may go on: every page of every live song this tablet has */
    const pagesOf = async t => live(await libraryOf(t)).flatMap(s => Array.from({length: s.pages}, (_, i) => ({id: s.id, p: i + 1, key: s.id + ':' + (i + 1)})));
    /* a local action: the page before and after, checked, then taken by the model */
    const local = async (who, key, before, after, what, {added = [], changed = []} = {}) => {
      const B0 = entriesOf(before), A0 = entriesOf(after);
      for(const [id, e] of B0) if(!changed.includes(id)) assert(JSON.stringify(A0.get(id)) === JSON.stringify(e), `${what}: ${id} changed although the action did not touch it`);
      for(const id of changed) assert(Number(A0.get(id).updated) > Number(B0.get(id).updated), `${what}: ${id} was stamped ${A0.get(id).updated}, not after the entry it replaces (${B0.get(id).updated})`);
      for(const id of added) assert(A0.has(id) && !B0.has(id), `${what}: ${id} was not added`);
      assert(A0.size === B0.size + added.length, `${what}: the page has ${A0.size} entries, ${B0.size + added.length} expected`);
      inkLocal(m, who, key, after);
    };

    await check('the start');
    for(let step = 0; step < STEPS; step++){
      const who = R.chance(.5) ? 'A' : 'B', t = T[who], roll = R();
      const tag = `case ${ci} step ${step} (${who})`;
      if(roll < .22 || step === 0){                                      // draw
        const {id, p, key} = R.pick(await pagesOf(t)), before = await pageOf(t, key), hl = R.chance(.35), sid = mid('s');
        const t0 = await clockOf(t);
        const line = (hl ? hlLine : penLine)(sid, r4(.05 + R() * .9), hl ? R.pick(Object.values(HL)) : R.pick(Object.values(PEN)), {x0: r4(.05 + R() * .3), x1: r4(.6 + R() * .35), n: 3 + R.int(6)});
        const after = await addEntries(t, id, p, [line]);
        const got = entriesOf(after).get(sid);
        assert(got && got.updated >= t0 && got.updated <= (await clockOf(t)), `${tag}: a new stroke is not dated now on the tablet's clock: ${got && got.updated}`);
        await local(who, key, before, after, `${tag} draw`, {added: [sid]});
        say(`${tag}: draw ${sid} on ${key}`);
      }else if(roll < .32){                                              // a note
        const {id, p, key} = R.pick(await pagesOf(t)), before = await pageOf(t, key), sid = mid('n');
        const after = await addEntries(t, id, p, [textNote(sid, r4(R() * .8), r4(R() * .9), `note ${sid}`, {c: R.pick(Object.values(PEN)), size: R.pick([.012, .018, .028])})]);
        await local(who, key, before, after, `${tag} note`, {added: [sid]});
        say(`${tag}: note ${sid} on ${key}`);
      }else if(roll < .47){                                              // erase a stroke
        const ink = await inkOf(t), choices = (await pagesOf(t)).flatMap(x => [...entriesOf(ink[x.key]).values()].filter(s => !s.deleted && s.t !== 'text').map(s => ({...x, s})));
        if(!choices.length) continue;
        const ch = R.pick(choices), before = ink[ch.key], after = await eraseIds(t, ch.id, ch.p, [ch.s.id]);
        assert(entriesOf(after).get(ch.s.id).deleted === true, `${tag}: the erase left no marker`);
        await local(who, ch.key, before, after, `${tag} erase`, {changed: [ch.s.id]});
        erased[who].push({key: ch.key, id: ch.id, p: ch.p, entry: ch.s});
        say(`${tag}: erase ${ch.s.id} on ${ch.key}`);
      }else if(roll < .62){                                              // edit or move a note
        const ink = await inkOf(t), choices = (await pagesOf(t)).flatMap(x => [...entriesOf(ink[x.key]).values()].filter(s => !s.deleted && s.t === 'text').map(s => ({...x, s})));
        if(!choices.length) continue;
        const ch = R.pick(choices), before = ink[ch.key];
        const change = R.chance(.5) ? {text: ch.s.text + ' +'} : {x: r4(Math.min(.9, ch.s.x + .03)), y: r4(Math.max(0, ch.s.y - .02))};
        const after = await editNote(t, ch.id, ch.p, ch.s.id, change);
        await local(who, ch.key, before, after, `${tag} edit note`, {changed: [ch.s.id]});
        say(`${tag}: edit ${ch.s.id} on ${ch.key} ${JSON.stringify(change)}`);
      }else if(roll < .72){                                              // undo an erase made here, if its marker is still what this tablet holds
        const ink = await inkOf(t), choices = erased[who].filter(e => { const x = entriesOf(ink[e.key]).get(e.entry.id); return x && x.deleted; });
        if(!choices.length) continue;
        const ch = R.pick(choices), before = ink[ch.key], mk = entriesOf(before).get(ch.entry.id);
        const after = await undoErase(t, ch.id, ch.p, ch.entry), back = entriesOf(after).get(ch.entry.id);
        assert(back && !back.deleted && back.updated > mk.updated && canon({...back, updated: 0}) === canon({...ch.entry, updated: 0}), `${tag}: Undo did not bring ${ch.entry.id} back as it was, stamped after its marker: ${JSON.stringify(back)}`);
        await local(who, ch.key, before, after, `${tag} undo`, {changed: [ch.entry.id]});
        erased[who] = erased[who].filter(e => e !== ch);
        say(`${tag}: undo erase of ${ch.entry.id} on ${ch.key}`);
      }else if(roll < .94){                                              // Sync
        await sync(who, `${tag} Sync`);
      }else{                                                             // New version on A (synced before, B synced after)
        await sync('B', `${tag} Sync B before New version`); await sync('A', `${tag} Sync A before New version`);
        const songs = live(await libraryOf(A)).filter(s => !s.archived), X = R.pick(songs), pages = 1 + R.int(3);
        const pdf = await makePdf(pages, `marks-model-${seed}-${ci}-${step}.pdf`);
        const inkBefore = await inkOf(A), before = (await libraryOf(A)).songs;
        await newVersionUi(A, X.id, pdf.file);
        const LA = await libraryOf(A), copy = live(LA).find(s => !before[s.id] && s.archived && s.hash === X.hash);
        assert(copy && LA.files[X.id] === pdf.hash, `${tag}: New version did not keep the old chart as an archived copy`);
        const nv = inkNewVersion(m, 'A', X.id, copy.id, inkBefore, LA.ink, pages);
        assert(!nv.length, `${tag}: ${nv.join(' | ')}`);
        erased.A = erased.A.filter(e => e.id !== X.id); erased.B = erased.B.filter(e => e.id !== X.id);
        say(`${tag}: New version of ${X.title} (${pages} pages), archived copy ${copy.id}`);
        await sync('A', `${tag} Sync A after New version`); await sync('B', `${tag} Sync B after New version`);
      }
    }
    for(const [i, who] of ['A', 'B', 'A', 'B'].entries()) await sync(who, `case ${ci} final Sync ${i + 1} (${who})`);
    const rest = async what => {
      for(const t of [A, B]){
        t.google.clearLog();
        const rep = await syncRead(t), w = writesBy(t.google, t.name);
        assert(rep.state === 'finished' && /Everything is up to date/.test(rep.text) && !w.length, `${what}: a Sync on ${t.name} with nothing to do says "${rep.text.slice(0, 300)}" and wrote ${w.length} time(s) to Drive`);
      }
    };
    await rest(`case ${ci} at rest`);
    const ia = await inkOf(A), ib = await inkOf(B), byId = p => canon([...entriesOf(p).values()].sort((x, y) => (x.id < y.id ? -1 : 1)));
    for(const {key} of await pagesOf(A)) assert(byId(ia[key]) === byId(ib[key]), `case ${ci}: at rest A and B hold different marks on ${key}`);
    /* a reload, and a backup round trip of A */
    for(const t of [A, B]){ await t.page.reload(); await t.page.waitForSelector('#libList'); }
    await check(`case ${ci} after a reload`);
    const bk = await backupNow(A.page), was = await inkOf(A);
    await wipe(A.page); await A.s.goto(''); await A.page.waitForSelector('#libList');
    assert(!Object.keys(await idbAll(A.page, 'ink')).length, 'the wipe left marks (the test is wrong)');
    await restoreZip(A.page, bk.file);
    assert(canon(await inkOf(A)) === canon(was), `case ${ci}: the marks after Back up -> wipe -> Restore differ from before`);
    await check(`case ${ci} after a backup round trip of A`);
    await rest(`case ${ci} after the restore`);
  }catch(e){
    e.message = `${e.message}\n    replay: node tools/loops.mjs --only "${NAME.split(' (')[0]}" --seed ${seed} --case ${ci} --verbose${ctx.opts.verbose ? '' : '\n    last steps: ' + log.slice(-6).join(' / ')}`;
    throw e;
  }finally{ await A.close().catch(() => {}); await B.close().catch(() => {}); }
}

async function loopModel(ctx){
  const seed = ctx.opts.seed, cases = ctx.opts.case != null ? [ctx.opts.case] : Array.from({length: ctx.opts.cases || 2}, (_, i) => i);
  for(const ci of cases) await runCase(ctx, seed, ci);
}

export const loops = [
  {name: NAME + ': seeded random draw, notes, erase, edit, undo and New version on two tablets (one with its clock 2 hours behind) with Syncs between agree with the independent model by stroke id after every Sync, at rest, after a reload and after a backup round trip', run: loopModel},
];

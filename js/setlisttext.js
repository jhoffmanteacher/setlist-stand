/* Import a setlist from a text file (Setlists -> Import from a text file; Jonathan, 2026-11-21): one song per line, read,
   matched against the Library, shown in ONE review box, then written as ONE new setlist in ONE putAll(). Nothing but that
   setlist is ever written: no song is made from a line that matched nothing, no song, PDF, mark or other setlist is touched.
   The file comes from outside the app: it is size- and line-limited, decoded carefully, and every piece of it shown on screen
   goes through esc() (or textContent); no line ever becomes an id or a key.

   The first half (decodeText, cleanLine, parseText, matchLine, planText) is plain data in, plain data out, so the loop
   tests it without the screen. */
import {$, esc, modal, toast, hooks} from './util.js';
import {state, putAll, load} from './store.js';
import {joinColls} from './collections.js';
import {freeSetName, unique} from './shareimport.js';
import {explainError} from './errors.js';

export const LIMITS = {maxBytes:1024 * 1024, maxLines:500, maxLine:200};

/* ---------- reading the bytes ----------
   UTF-8 (a byte-order mark taken off), UTF-16 when it has a byte-order mark, otherwise Windows-1252 when the bytes are not
   valid UTF-8. A file with NUL bytes (and no UTF-16 mark), or one that is mostly control characters, is not text.
   Resolves to {text} or {error}. */
export function decodeText(bytes){
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text;
  try{
    if(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) text = new TextDecoder('utf-8').decode(b.subarray(3));
    else if(b[0] === 0xFF && b[1] === 0xFE) text = new TextDecoder('utf-16le').decode(b.subarray(2));
    else if(b[0] === 0xFE && b[1] === 0xFF) text = new TextDecoder('utf-16be').decode(b.subarray(2));
    else {
      if(b.includes(0)) return {error:'not text'};
      try{ text = new TextDecoder('utf-8', {fatal:true}).decode(b); }
      catch(e){ text = new TextDecoder('windows-1252').decode(b); }
    }
  }catch(e){ return {error:'not text'}; }
  const odd = (text.match(/[\u0000-\u0008\u000e-\u001f\u007f�]/g) || []).length;
  if(text.length && odd / text.length > 0.02) return {error:'not text'};
  return {text};
}

/* ---------- one line ---------- */
/* Control characters, zero-width and direction marks, soft hyphens and byte-order marks go; whitespace becomes one space. */
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
export const cleanLine = s => String(s).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
/* A bullet, or a number such as "1.", "1)", "(1)", "1:", "1 -", "#1" or a plain "1 " at the start. */
const BULLET = /^(?:[-*•·‣◦▪●○■□–—+>]+\s*|\(?#?\d{1,3}(?:[.):\]]|\s+[-–—]|\s)\s*)/u;
const stripBullet = s => s.replace(BULLET, '').trim();
/* A break: only dashes, equals signs or asterisks (three or more), or "break", "set break" or "intermission" (any case,
   optionally a number), with any brackets or dashes around it taken off. */
const RULE = /^[-–—=*_~\s]{3,}$/u;
const AROUND = /^[\s[\](){}<>\-–—=*:|]+|[\s[\](){}<>\-–—=*:|]+$/gu;
export function breakName(s){
  if(RULE.test(s) && /[-–—=*]{3,}|(?:[-–—=*]\s*){3,}/u.test(s)) return 'Break';
  const inner = s.replace(AROUND, '');
  if(/^(?:set\s+break|break|intermission)(?:\s*\d{1,3})?$/i.test(inner)) return inner.toLowerCase() === 'break' ? 'Break' : inner;
  return null;
}

/* ---------- matching a line to songs ----------
   Upper and lower case, accents, extra spaces, curly or straight quotes and apostrophes, and different dashes do not matter. */
export const norm = s => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[‘’‚‛′`´]/g, "'").replace(/[“”„‟″]/g, '"')
  .replace(/[‐-―−]/g, '-').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
const titleOf = s => s.title || [s.song, s.version ? `(${s.version})` : '', s.artist ? `- ${s.artist}` : ''].filter(Boolean).join(' ');
/* The songs a line could mean: the whole line against the full title ("Song (version) - Artist"), else against the song
   name alone, else, when the line has " - ", the part before as the song name and the part after as the artist. */
export function matchLine(line, songs){
  const q = norm(line); if(!q) return [];
  let hit = songs.filter(s => norm(titleOf(s)) === q);
  if(!hit.length) hit = songs.filter(s => norm(s.song || s.title) === q);
  if(!hit.length && q.includes(' - ')){
    const parts = q.split(' - '), found = new Set();
    for(let i = 1; i < parts.length; i++){
      const name = parts.slice(0, i).join(' - '), artist = parts.slice(i).join(' - ');
      for(const s of songs) if(norm(s.song) === name && norm(s.artist) === artist) found.add(s);
    }
    hit = [...found];
  }
  return hit;
}

/* ---------- the whole file ----------
   Each line becomes {n (line number), text (cleaned, shortened for the screen), kind, ids?, name?}:
   'song' (one song: ids[0]), 'choice' (several: ids), 'break' (name), 'none' (no match). Empty lines and lines that begin
   with '#' are left out. Resolves to {lines, counts} or {error}. A song beats a break ("Break" in the Library is a song). */
export function planText(text, songs){
  const raw = String(text).split(/\r\n|\r|\n/);
  const lines = [];
  for(let i = 0; i < raw.length; i++){
    const t = cleanLine(raw[i]);
    if(!t || t.startsWith('#')) continue;
    if(lines.length >= LIMITS.maxLines) return {error:'too many'};
    const shown = [...t].length > LIMITS.maxLine ? [...t].slice(0, 60).join('') + '…' : t;
    const ln = {n:i + 1, text:shown};
    lines.push(ln);
    if(shown !== t){ ln.kind = 'none'; continue; }            // longer than any song name: shown shortened, never matched
    const bare = stripBullet(t);
    let hit = bare ? matchLine(bare, songs) : [];
    if(!hit.length && bare !== t) hit = matchLine(t.replace(/^[-*•·‣◦▪●○■□–—+>]+\s*/u, ''), songs);   // "99 Luftballons": the number is the name
    const brk = hit.length ? null : breakName(bare || t);
    if(hit.length === 1){ ln.kind = 'song'; ln.ids = [hit[0].id]; }
    else if(hit.length > 1){ ln.kind = 'choice'; ln.ids = hit.map(s => s.id); }
    else if(brk){ ln.kind = 'break'; ln.name = brk; }
    else ln.kind = 'none';
  }
  if(!lines.length) return {error:'empty'};
  const c = k => lines.filter(l => l.kind === k).length;
  const counts = {song:c('song'), choice:c('choice'), break:c('break'), none:c('none')};
  if(!counts.song && !counts.choice) return {error:'no match', counts};
  return {lines, counts};
}

/* The setlist's name: the file name without its extension, cleaned, at most 200 characters; "Imported setlist" when empty. */
export function nameFromFile(name){
  const n = cleanLine(String(name || '').replace(/\.[^.]{0,10}$/, ''));
  return [...n].slice(0, 200).join('').trim() || 'Imported setlist';
}

/* ---------- the screen ---------- */
const plural = (n, w) => `${n} ${w}${n == 1 ? '' : 's'}`;
const MESSAGES = {
  big:'That file is too big for a setlist (more than 1 MB). Nothing was changed.',
  type:'That is not a plain text file. Save the setlist as a .txt file, one song per line. Nothing was changed.',
  'not text':'That is not a plain text file. Save the setlist as a .txt file, one song per line. Nothing was changed.',
  empty:'That file has no song names in it. Nothing was changed.',
  'too many':`That file has more than ${LIMITS.maxLines} lines of songs and breaks. Nothing was changed.`,
  'no match':'None of the lines in that file match a song in your Library. Nothing was changed.',
};
function notice(title, text){
  const m = modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="btns"><button class="pri" data-x>OK</button></div>`);
  m.querySelector('[data-x]').onclick = () => m.remove();
}
const countLine = c => [plural(c.song, 'song') + ' found', c.choice ? `${c.choice} to choose` : '', c.break ? plural(c.break, 'break') : '',
  c.none ? `${plural(c.none, 'line')} not found` : ''].filter(Boolean).join(', ');

/* The review box. Resolves to the setlist's items ([{type:'song', id} | {type:'break', name}], in file order) or null. */
function review(plan, name){
  return new Promise(res => {
    const byId = new Map(state.songs.map(s => [s.id, s]));
    const label = id => { const s = byId.get(id); return s.title + (s.archived ? ' (archived)' : ''); };
    const row = (l, i) => {
      const line = `<span class="tl-in">${esc(l.text)}</span>`;
      if(l.kind === 'song') return `<li class="tl ok">${line}<span class="tl-out">${esc(label(l.ids[0]))}</span></li>`;
      if(l.kind === 'break') return `<li class="tl brk">${line}<span class="tl-out">Break: ${esc(l.name)}</span></li>`;
      if(l.kind === 'none') return `<li class="tl none">${line}<span class="tl-out">No match: left out</span></li>`;
      return `<li class="tl choose">${line}<fieldset><legend class="tl-out">Which one?</legend>${l.ids.map((id, k) =>
        `<label class="opt"><input type="radio" name="c${i}" value="${k}">${esc(label(id))}</label>`).join('')}<label class="opt"><input type="radio" name="c${i}" value="out">Leave this line out</label></fieldset></li>`;
    };
    const m = modal(`<h2>Import setlist</h2><p>It will be saved as <b>${esc(name)}</b>.</p><p class="hint" data-counts>${esc(countLine(plan.counts))}.</p>
      <ol class="tlines">${plan.lines.map(row).join('')}</ol><p class="hint" data-left></p>
      <div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Add</button></div>`);
    m.classList.add('textimport');
    const ok = m.querySelector('[data-ok]'), left = m.querySelector('[data-left]');
    const answer = i => { const r = m.querySelector(`input[name="c${i}"]:checked`); return r ? r.value : null; };
    const sync = () => {
      const open = plan.lines.filter((l, i) => l.kind === 'choice' && answer(i) === null).length;
      ok.disabled = !!open;
      left.textContent = open ? `Choose a song (or "Leave this line out") for ${plural(open, 'line')} marked "Which one?".` : '';
    };
    sync();
    m.addEventListener('change', sync);
    m.querySelector('[data-x]').onclick = () => { m.remove(); res(null); };
    ok.onclick = () => {
      if(ok.disabled) return;
      const items = [];
      plan.lines.forEach((l, i) => {
        if(l.kind === 'song') items.push({type:'song', id:l.ids[0]});
        else if(l.kind === 'break') items.push({type:'break', name:l.name});
        else if(l.kind === 'choice'){ const a = answer(i); if(a !== null && a !== 'out') items.push({type:'song', id:l.ids[+a]}); }
      });
      m.remove(); res(items);
    };
  });
}

/* One import at a time, from the file being picked until the result is on screen. */
let running = false;
export async function importSetlistText(file, show){
  if(!file) return;
  if(running){ toast('An import is still running. Try again when it has finished.'); return; }
  running = true;
  try{ await run(file, show); }
  finally{ running = false; }
}
async function run(file, show){
  const fail = key => notice("Can't import that setlist", MESSAGES[key]);
  if(file.size > LIMITS.maxBytes) return fail('big');
  if(file.type && file.type !== 'text/plain' && !/\.txt$/i.test(file.name || '')) return fail('type');
  let bytes;
  try{ bytes = new Uint8Array(await file.arrayBuffer()); }
  catch(err){ return notice("Can't import that setlist", explainError(err, 'That file could not be read. Nothing was changed.')); }
  if(bytes.length > LIMITS.maxBytes) return fail('big');
  const d = decodeText(bytes);
  if(d.error) return fail(d.error);
  const songs = state.songs.filter(s => !s.deleted);
  const plan = planText(d.text, songs);
  if(plan.error) return fail(plan.error);
  const base = nameFromFile(file.name), name = freeSetName({name:base});
  const chosen = await review(plan, name);
  if(!chosen) return;
  const songsIn = chosen.filter(it => it.type === 'song').length;
  if(!songsIn){ toast('No songs were chosen, so no setlist was made.'); return; }
  /* ONE write: the new setlist and nothing else (fresh id and break ids, the collections every new setlist gets, no gig date) */
  const taken = new Set([...state.songs.map(s => s.id), ...state.sets.map(s => s.id)]);
  const id = unique(taken), t = Date.now(), setName = freeSetName({name:base});       // asked again: a setlist made while the box was open
  const items = chosen.map(it => it.type === 'break' ? {type:'break', id:unique(taken), name:it.name} : it);
  const w = modal('<h2>Adding the setlist</h2><p class="hint" role="status">Saving…</p><button data-x hidden></button>');   // Escape (and back) do nothing mid-write
  try{ await putAll([{store:'sets', key:id, value:{id, name:setName, items, colls:joinColls(), created:t, updated:t}}]); }
  catch(err){ w.remove(); return notice('Nothing was added', explainError(err, 'The setlist could not be saved. Nothing was changed.')); }
  w.remove();
  try{ await load(); if(show) show(id); hooks.render(); }
  catch(err){ toast('The setlist was added, but the screen did not update. Reload the app to see it.'); return; }
  const out = plan.lines.length - chosen.length;
  toast(`Added the setlist ${setName}: ${plural(songsIn, 'song')}` + (out ? `, ${plural(out, 'line')} left out.` : '.'));
}

/* The button on the Setlists list opens the file chooser (in the tap itself). */
export const chooseTextFile = () => $('#setTextFile').click();

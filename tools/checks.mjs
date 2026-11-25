#!/usr/bin/env node
// Setlist Stand pre-ship checks. Zero dependencies.
//   node tools/checks.mjs          run all checks (exit 1 on any FAIL)
//   node tools/checks.mjs --bump   write a new VERSION (YYYY-MM-DD-N) AND the SHA-256 table (HASHES) into sw.js
//   node tools/checks.mjs --rehash write the SHA-256 table only (for the loops and plant-faults, which change files in a scratch copy)
// Paths resolve from this file's location, so it works from any cwd/worktree.

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW = path.join(ROOT, 'sw.js');
const APP_DIRS = ['css', 'js', 'vendor', 'icons'];
const APP_FILES = ['index.html', 'manifest.webmanifest'];
const IGNORE = new Set(['.DS_Store', 'Thumbs.db']);

// The only remote URLs app code may hold, per file. A match is allowed only in that file and only when its text equals
// one of these exactly (a fifth URL in the file, or one of these in another file, still fails).
const ALLOWED_URLS = {
  'js/driveconfig.js': [
    'https://www.googleapis.com/auth/drive.file',
    'https://accounts.google.com/o/oauth2/v2/auth',
    'https://www.googleapis.com/drive/v3',
    'https://www.googleapis.com/upload/drive/v3',
  ],
};

// The Content-Security-Policy index.html must carry, exactly (order of directives and of sources is ignored).
// Loosening the CSP needs Jonathan's OK; when he gives it, change this pinned policy in the same commit.
const PINNED_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
  + "font-src 'self'; connect-src 'self' blob: data: https://www.googleapis.com; worker-src 'self' blob:; "
  + "manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
// A remote URL: http(s):// in any case, or a protocol-relative //host in a string, after src=/href= or in url( ).
const URL_RE = /https?:\/\/[^\s'"`)<>]*|(?:['"`]|\b(?:src|href)\s*=\s*['"]?|url\(\s*['"]?)\/\/[a-z0-9][^\s'"`)<>]*/gi;
const CSP_META = /<meta\b[^>]*?\bhttp-equiv\s*=\s*(["']?)content-security-policy\1[^>]*>/gi;

// Google client secret markers, built from pieces so this file does not flag itself.
const SECRET_MARKS = ['client' + '_secret', 'GOCSPX' + '-'];
const BINARY_EXT = new Set(['.png', '.pdf', '.zip', '.ttf', '.ico', '.msb', '.woff', '.woff2']);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git']);           // at any depth
const SKIP_ROOT_DIRS = new Set(['vendor', 'Claude outputs']);  // at the repo root only

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const red = (s) => (color ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (color ? `\x1b[32m${s}\x1b[0m` : s);
const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);

let failures = 0;
const pass = (name) => console.log(green(`PASS ${name}`));
const fail = (name, why) => { failures++; console.log(red(`FAIL ${name}: ${why}`)); };
const note = (name, why) => console.log(dim(`SKIP ${name}: ${why}`));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((d) => {
    if (IGNORE.has(d.name)) return [];
    const r = `${rel}/${d.name}`;
    return d.isDirectory() ? walk(r) : [r];
  });
}

const jsFiles = () => walk('js').filter((f) => f.endsWith('.js'));

function parseVersion(src) {
  const m = /const\s+VERSION\s*=\s*['"]([^'"]+)['"]/.exec(src);
  return m ? m[1] : null;
}

let precacheError = null; // why PRECACHE could not be read, when it was found but its text did not parse
function parsePrecache(src) {
  const m = /const\s+PRECACHE\s*=\s*\[([\s\S]*?)\]/.exec(src);
  if (!m) return null;
  const [text, why] = tryStrip(stripJsComments, m[1]);
  if (why) { precacheError = why; return null; }
  return [...text.matchAll(/(['"`])([^'"`]*)\1/g)].map((x) => x[2]);
}

// Normalise a PRECACHE URL to a repo path ('./' -> index.html).
const toRepoPath = (u) => (u === './' || u === '' ? 'index.html' : u.replace(/^\.\//, ''));

// ---- the SHA-256 table in sw.js (HASHES) and the Content-Type table (TYPES) ----
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const HASHES_RE = /const\s+HASHES\s*=\s*\{[^}]*\}/;
// The table as written in sw.js: {path -> hash} (entries in order), or null when it is not there. Reads the text with comments stripped.
function parseHashes(src) {
  const [text, why] = tryStrip(stripJsComments, src);
  if (why) return null;
  const m = /const\s+HASHES\s*=\s*\{([^}]*)\}/.exec(text);
  if (!m) return null;
  return [...m[1].matchAll(/(['"])([^'"]*)\1\s*:\s*(['"])([^'"]*)\3/g)].map((x) => [x[2], x[4]]);
}
function parseTypes(src) {
  const [text, why] = tryStrip(stripJsComments, src);
  if (why) return null;
  const m = /const\s+TYPES\s*=\s*\{([^}]*)\}/.exec(text);
  if (!m) return null;
  return new Map([...m[1].matchAll(/([A-Za-z0-9_]+)\s*:\s*(['"])([^'"]*)\2/g)].map((x) => [x[1], x[3]]));
}
// The table every PRECACHE file should have, from the files as they are on disk now: [[path as written in PRECACHE, sha256]], sorted.
function hashRows(list) {
  return [...new Set(list)].sort().map((u) => {
    const f = path.join(ROOT, toRepoPath(u));
    if (!fs.existsSync(f)) throw new Error(`PRECACHE lists ${u} but ${toRepoPath(u)} is not on disk`);
    return [u, sha256Hex(fs.readFileSync(f))];
  });
}
// Files (repo paths) whose copy on disk differs from the copy git holds ONLY in line endings: CRLF on disk, LF in git. This is what a
// checkout made while core.autocrlf was on leaves behind when .gitattributes (`* -text`) arrives later: git status can stay clean (it does
// not read a file again while its size and time are unchanged), but a table made from these files is wrong for the bytes a commit holds
// and GitHub Pages serves. A file git has not seen, or no git at all, is not reported.
function crlfOnly(files) {
  const out = [];
  for (const f of files) {
    let work, blob;
    try { work = fs.readFileSync(path.join(ROOT, f)); } catch { continue; }
    if (!work.includes('\r\n')) continue;
    try { blob = execFileSync('git', ['cat-file', 'blob', `:${f}`], { cwd: ROOT, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { continue; }
    if (!blob.equals(work) && blob.equals(Buffer.from(work.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'))) out.push(f);
  }
  return out;
}
const crlfFix = (list) => `${list.slice(0, 6).join(', ')}${list.length > 6 ? ` and ${list.length - 6} more` : ''} have Windows line endings (CRLF) on disk but LF in git (a checkout made while core.autocrlf was on, before .gitattributes said "* -text"), so a hash table made from them would be wrong for what git commits and GitHub Pages serves. Fix (nothing is lost: only the line endings differ): git config core.autocrlf false, then ${list.length > 6 ? 'make a fresh clone' : `delete ${list.join(' ')} and bring them back with git checkout -- ${list.join(' ')} (git does not rewrite a file whose size and time it already knows, so the files must be deleted first)`}, then node tools/checks.mjs --bump`;

// sw.js text with its HASHES table replaced by `rows`, one entry per line, sorted (the one format; the check compares text).
const withTable = (src, rows) => src.replace(HASHES_RE, () => `const HASHES = {\n${rows.map(([k, h]) => `  '${k}': '${h}',`).join('\n')}\n}`);

// Remove // and /* */ comments (blanked to spaces, newlines kept, so length and line numbers stay) while leaving
// string, template and regular-expression contents intact, so 'https://x' is never mistaken for a line comment and
// a quote inside a regex (/'/g) never looks like the start of a string. Throws when a string, template or block
// comment is still open at the end (the check must fail then, never pass on text it could not read).
const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_KEYWORD = /(?:^|[^\w$.])(?:return|typeof|case|do|else|in|of|void|delete|new|throw|yield)$/;
function stripJsComments(src) {
  let out = '', i = 0;
  const subs = []; // one entry per open `${ }`: how many `{` are open inside it
  const parens = []; // one entry per open `(`: is it the head of if / while / for / with (a regex may follow its `)`)?
  let headClosed = false; // did the last `)` close such a head?
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  // Copy template text from i up to its closing backtick, or up to and including a `${` (a substitution opens).
  const template = () => {
    for (; i < src.length; i++) {
      const c = src[i];
      out += c;
      if (c === '\\') out += src[++i] ?? '';
      else if (c === '`') { i++; return; }
      else if (c === '$' && src[i + 1] === '{') { out += '{'; i += 2; subs.push(0); return; }
    }
    throw new Error('unterminated template');
  };
  // Where a regex literal starting at i ends (index of its closing slash), or -1 when this slash is a division.
  const regexEnd = () => {
    let k = out.length - 1;
    while (k >= 0 && /\s/.test(out[k])) k--;
    if (k >= 0) {
      const prev = out[k];
      if ((prev === '+' || prev === '-') && out[k - 1] === prev) return -1;                       // n++ / 2: a division
      if (prev === ')') { if (!headClosed) return -1; }                                            // f(x) / 2 is a division, if (x) /re/.test(y) is not
      else if (!REGEX_AFTER.has(prev) && !REGEX_KEYWORD.test(out.slice(Math.max(0, k - 7), k + 1))) return -1;
    }
    for (let j = i + 1, cls = false; j < src.length && src[j] !== '\n'; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '[') cls = true;
      else if (src[j] === ']') cls = false;
      else if (src[j] === '/' && !cls) return j;
    }
    return -1;
  };
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === '\\') j += src[j + 1] === '\r' && src[j + 2] === '\n' ? 2 : 1;
        else if (src[j] === '\n') throw new Error('unterminated string');
      }
      if (j >= src.length) throw new Error('unterminated string');
      out += src.slice(i, j + 1); i = j + 1;
    } else if (c === '`') {
      out += c; i++; template();
    } else if (c === '/' && n === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      out += blank(src.slice(i, j)); i = j;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated comment');
      out += blank(src.slice(i, end + 2)); i = end + 2;
    } else if (c === '/' && regexEnd() > 0) {
      const end = regexEnd();
      out += src.slice(i, end + 1); i = end + 1;
    } else if (c === '}' && subs.length && !subs[subs.length - 1]) {
      subs.pop(); out += c; i++; template();
    } else {
      if (subs.length && (c === '{' || c === '}')) subs[subs.length - 1] += c === '{' ? 1 : -1;
      if (c === '(') parens.push(/(?:^|[^\w$.])(?:if|while|for|with|for\s+await)\s*$/.test(out));
      else if (c === ')') headClosed = parens.pop() === true;
      out += c; i++;
    }
  }
  if (subs.length) throw new Error('unterminated template');
  return out;
}

// Same, but a failure to read the text comes back as a note instead of an exception: [stripped, null] or [null, why].
function tryStrip(fn, src) {
  try { return [fn(src), null]; } catch (e) { return [null, e.message]; }
}

function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function stripHtml(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    // Clickable links are allowed to point off-site.
    .replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])[^"']*\2/gi, '$1""')
    // Inline scripts: strip their JS comments too.
    .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_, a, b, c) => a + stripJsComments(b) + c);
}

function lineOf(src, idx) { return src.slice(0, idx).split('\n').length; }

// Blank out ONLY the CSP meta tag (its characters become spaces, newlines stay) so a URL anywhere else still fails.
const blankCspMeta = (html) => html.replace(CSP_META, (m) => m.replace(/[^\n]/g, ' '));

// "a; b 'x' y" -> directives {name -> Set(sources)} plus any directive name that appears twice.
function parseCsp(text) {
  const dirs = new Map(), repeated = [];
  for (const part of text.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    const key = name.toLowerCase();
    if (dirs.has(key)) repeated.push(key);
    dirs.set(key, new Set(sources));
  }
  return { dirs, repeated };
}

// What differs between the policy found and the pinned one, as short phrases (empty list = equal).
function cspDiff(found, pinned) {
  const out = found.repeated.map((d) => `${d} appears twice`);
  for (const [d, want] of pinned.dirs) {
    const have = found.dirs.get(d);
    if (!have) { out.push(`missing directive ${d}`); continue; }
    const extra = [...have].filter((s) => !want.has(s)), lost = [...want].filter((s) => !have.has(s));
    if (extra.length) out.push(`${d}: extra ${extra.join(' ')}`);
    if (lost.length) out.push(`${d}: missing ${lost.join(' ')}`);
  }
  for (const d of found.dirs.keys()) if (!pinned.dirs.has(d)) out.push(`extra directive ${d}`);
  return out;
}

// Every file in the repo (relative paths) except tool/vendor folders and the machine's own files.
function walkRepo(rel = '') {
  return fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }).flatMap((d) => {
    if (d.isSymbolicLink() || IGNORE.has(d.name) || SKIP_DIRS.has(d.name) || (!rel && SKIP_ROOT_DIRS.has(d.name))) return [];
    const r = rel ? `${rel}/${d.name}` : d.name;
    return d.isDirectory() ? walkRepo(r) : [r];
  });
}

// "line mark" for every line of text holding one of the marks.
const marksIn = (text, marks) => text.split('\n').flatMap((ln, i) => marks.filter((m) => ln.includes(m)).map((m) => `${i + 1} ${m}`));

// ---------------------------------------------------------------- --bump, --rehash
/* --bump writes the new VERSION and the SHA-256 of every PRECACHE file into sw.js together (nobody writes the table by hand).
   --rehash writes the table only: the loops and plant-faults use it after they change a file in a scratch copy of the site, so
   the copy's worker still matches its own files. Neither writes anything when a PRECACHE file is missing. */
if (process.argv.includes('--bump') || process.argv.includes('--rehash')) {
  const src = fs.readFileSync(SW, 'utf8');
  const list = parsePrecache(src);
  if (!list) { console.error('could not read PRECACHE from sw.js'); process.exit(1); }
  if (!HASHES_RE.test(src)) { console.error('could not find `const HASHES = {...}` in sw.js'); process.exit(1); }
  let out;
  try { out = withTable(src, hashRows(list)); } catch (e) { console.error(e.message); process.exit(1); }
  if (process.argv.includes('--bump')) {
    const crlf = crlfOnly([...new Set(list.map(toRepoPath))]);
    if (crlf.length) { console.error(`not bumped: ${crlfFix(crlf)}`); process.exit(1); }
    const cur = parseVersion(src);
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const m = cur && /^(\d{4}-\d{2}-\d{2})-(\d+)$/.exec(cur);
    const next = `${today}-${m && m[1] === today ? Number(m[2]) + 1 : 1}`;
    out = out.replace(/(const\s+VERSION\s*=\s*)(['"])[^'"]*\2/, `$1'${next}'`);
    console.log(`VERSION ${cur} -> ${next}`);
  }
  fs.writeFileSync(SW, out);
  console.log(`HASHES: ${new Set(list).size} entries`);
  process.exit(0);
}

// ---------------------------------------------------------------- (a) syntax
/* js/boot.js and sw.js are CLASSIC scripts (the browser runs them as a script, not as a module), so they are parsed as one with
   vm.Script: a top-level `await`, `import` or `import.meta`, which a module may use, is a syntax error there and fails here. Every
   other js/*.js file is an ES module and goes through `node --check` as a .mjs. */
const CLASSIC = new Set(['js/boot.js', 'sw.js']);
{
  const name = 'syntax (node --check; boot.js and sw.js as classic scripts)';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setlist-checks-'));
  const bad = [];
  try {
    const targets = jsFiles().filter((f) => !CLASSIC.has(f));
    for (const rel of targets) {
      const file = path.join(tmp, rel.replace(/[\\/]/g, '__') + '.mjs');
      fs.copyFileSync(path.join(ROOT, rel), file);
      try {
        execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        const msg = String(e.stderr || '').split('\n').find((l) => /Error/.test(l)) || 'syntax error';
        bad.push(`${rel} (${msg.trim()})`);
      }
    }
    for (const rel of CLASSIC) {
      if (!exists(rel)) continue;
      try {
        new vm.Script(read(rel), { filename: rel });
      } catch (e) {
        bad.push(`${rel} as a classic script (${String(e && e.message).split('\n')[0]})`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  bad.length ? fail(name, bad.join('; ')) : pass(name);
}

// ---------------------------------------------------------------- (b) precache
const swSrc = exists('sw.js') ? read('sw.js') : '';
const precache = parsePrecache(swSrc);
{
  if (!precache) {
    fail('precache parse', precacheError ? `cannot parse sw.js (${precacheError})` : 'could not find `const PRECACHE = [...]` in sw.js');
  } else {
    const missing = precache.filter((u) => !exists(toRepoPath(u)));
    missing.length
      ? fail('precache files exist', `listed in PRECACHE but missing on disk: ${missing.join(', ')}`)
      : pass('precache files exist');

    const listed = new Set(precache.map(toRepoPath));
    const appFiles = [...APP_FILES.filter(exists), ...APP_DIRS.flatMap(walk)];
    const unlisted = appFiles.filter((f) => !listed.has(f));
    unlisted.length
      ? fail('app files precached', `on disk but not in PRECACHE: ${unlisted.join(', ')}`)
      : pass('app files precached');
  }
}

// ---------------------------------------------------------------- (c)(d) app code scans
{
  const code = [], unparsable = [];
  const add = (f, fn) => {
    const [text, why] = tryStrip(fn, read(f));
    why ? unparsable.push(`cannot parse ${f} (${why})`) : code.push([f, text]);
  };
  for (const f of jsFiles()) add(f, stripJsComments);
  if (exists('sw.js')) add('sw.js', stripJsComments);
  if (exists('index.html')) add('index.html', (t) => blankCspMeta(stripHtml(t)));
  if (exists('css/app.css')) add('css/app.css', stripCssComments);
  const scan = (name, re, label, allowed = () => false) => {
    const hits = [...unparsable];
    for (const [f, src] of code) {
      for (const m of src.matchAll(re)) {
        if (!allowed(f, m[0])) hits.push(`${f}:${lineOf(src, m.index)} ${label(m)}`);
      }
    }
    hits.length ? fail(name, hits.join('; ')) : pass(name);
  };
  // http(s) URLs in any letter case, and protocol-relative ones ("//host/x" in quotes or after src=, href=, url( ).
  scan('no remote URLs in app code', URL_RE, (m) => m[0], (f, url) => !!ALLOWED_URLS[f]?.includes(url));
  scan('no window.claude in app code', /window\s*\.\s*claude\b/g, () => 'window.claude');
  // No user-agent sniffing (Jonathan, 2026-11-23): a phone is told from a tablet by its screen (isPhone() in js/device.js), never by what the browser calls itself.
  scan('no user-agent sniffing in app code', /\bnavigator\s*(?:\.\s*|\[\s*['"`])(?:userAgentData|userAgent|platform|vendor)\b|\buserAgentData\b/g, (m) => m[0].replace(/\s+/g, ' '), (f) => !/^(js\/[^/]+\.js|sw\.js)$/.test(f));
}

// ---------------------------------------------------------------- (c2) CSP pinned
{
  const name = 'CSP pinned';
  const [html, why] = exists('index.html') ? tryStrip(stripHtml, read('index.html')) : ['', null];
  const metas = html ? [...html.matchAll(CSP_META)] : [];
  if (why) {
    fail(name, `cannot parse index.html (${why})`);
  } else if (metas.length !== 1) {
    fail(name, metas.length ? `${metas.length} Content-Security-Policy meta tags in index.html, need exactly 1` : 'no Content-Security-Policy meta tag in index.html');
  } else {
    const content = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i.exec(metas[0][0]);
    // A CSP meta only governs what comes after it, so no script, link or style tag may come before it.
    const early = /<(script|link|style)\b/i.exec(html.slice(0, metas[0].index));
    if (!content) fail(name, 'the Content-Security-Policy meta tag has no content');
    else {
      const diff = cspDiff(parseCsp(content[2]), parseCsp(PINNED_CSP));
      if (early) fail(name, `<${early[1].toLowerCase()}> on line ${lineOf(html, early.index)} comes before the Content-Security-Policy meta tag (line ${lineOf(html, metas[0].index)}), which only covers what follows it`);
      else diff.length ? fail(name, `differs from the pinned policy in tools/checks.mjs: ${diff.join('; ')}`) : pass(name);
    }
  }
}

// ---------------------------------------------------------------- (c4) pdf.js eval guard
/* The vendored pdf.js (3.11.174) is older than CVE-2024-4367 (fixed in 4.2.67): a hostile PDF could run code when pdf.js is allowed to
   compile code. Two things block it here: the page's CSP has no 'unsafe-eval' (pinned above), and js/util.js replaces window.pdfjsLib
   with a stand-in whose getDocument adds isEvalSupported:false AFTER the caller's options (so a caller cannot turn it back on). This
   pins the second: the stand-in is there and passes false on every call; no app file sets isEvalSupported to anything else; every
   file that calls pdfjsLib.getDocument( imports ./util.js (which installs the stand-in before any PDF opens); nothing calls
   getDocument on another object (the real library under the stand-in, reached through its prototype, or a saved copy). */
{
  const name = 'pdf.js eval guard';
  const bad = [], text = new Map();
  for (const f of jsFiles()) {
    const [t, why] = tryStrip(stripJsComments, read(f));
    why ? bad.push(`cannot parse ${f} (${why})`) : text.set(f, t);
  }
  const STAND_IN_CALL = /getDocument\s*:\s*\{\s*value\s*:[^}]*?=>\s*getDocument\(\s*\{\s*\.\.\.[^{}]*?,\s*isEvalSupported\s*:\s*false\s*\}\s*\)/;
  const CAPTURE = /getDocument\s*=\s*lib\.getDocument\b/;
  const util = text.get('js/util.js');
  if (!util) bad.push('js/util.js is missing');
  else {
    if (!/window\.pdfjsLib\s*=\s*Object\.create\(\s*lib\b/.test(util)) bad.push('js/util.js no longer replaces window.pdfjsLib with the stand-in');
    if (!STAND_IN_CALL.test(util)) bad.push("the stand-in in js/util.js does not call getDocument with isEvalSupported:false after the caller's options");
    if (!CAPTURE.test(util)) bad.push('js/util.js does not keep the real getDocument for the stand-in to call');
    if (!/noEval\s*:\s*\{\s*value\s*:\s*true\s*\}/.test(util)) bad.push('the stand-in in js/util.js does not set noEval');
  }
  let callers = 0;
  for (const [f, t0] of text) {
    for (const m of t0.matchAll(/isEvalSupported\b(?!\s*:\s*false\b)/g)) bad.push(`${f}:${lineOf(t0, m.index)} isEvalSupported is set to something other than false`);
    // the stand-in's own two uses of the word are the only ones allowed to be anything but pdfjsLib.getDocument(
    const t = f === 'js/util.js' ? t0.replace(STAND_IN_CALL, '').replace(CAPTURE, '') : t0;
    for (const m of t.matchAll(/\bgetDocument\b/g)) {
      const before = t.slice(0, m.index), after = t.slice(m.index + 11);
      if (!(/\bpdfjsLib\s*\.\s*$/.test(before) && /^\s*\(/.test(after))) bad.push(`${f}:${lineOf(t, m.index)} getDocument is used other than as pdfjsLib.getDocument(`);
    }
    if (f !== 'js/util.js') {
      for (const m of t.matchAll(/\bpdfjsLib\s*=(?!=)/g)) bad.push(`${f}:${lineOf(t, m.index)} pdfjsLib is assigned outside js/util.js`);
      for (const m of t.matchAll(/getPrototypeOf\s*\(\s*(?:window\s*\.\s*)?pdfjsLib\b|pdfjsLib\s*\.\s*__proto__/g)) bad.push(`${f}:${lineOf(t, m.index)} reaches the real pdf.js under the stand-in`);
    }
    if (/\bpdfjsLib\s*\.\s*getDocument\s*\(/.test(t)) {
      callers++;
      if (f !== 'js/util.js' && !/\bfrom\s*['"]\.\/util\.js['"]/.test(t)) bad.push(`${f} calls pdfjsLib.getDocument( but does not import ./util.js (which installs the stand-in)`);
    }
  }
  bad.length ? fail(name, `${bad.slice(0, 6).join('; ')}${bad.length > 6 ? `; and ${bad.length - 6} more` : ''}`) : pass(`${name} (${callers} files call getDocument, all through the stand-in)`);
}

// ---------------------------------------------------------------- (g) boot script
/* js/boot.js registers the service worker and shows "Updated. Tap to reload" even when a module of the app does not load,
   so: it exists, it is a CLASSIC script (no import/export, no import()), index.html loads it FIRST of all scripts with
   defer (no type=module, no async), no app file imports it, and no other file registers sw.js except js/main.js's one
   fallback (guarded by window.ssBoot). */
{
  const name = 'boot script first';
  const bad = [];
  if (!exists('js/boot.js')) bad.push('js/boot.js is missing');
  else {
    const [code, why] = tryStrip(stripJsComments, read('js/boot.js'));
    if (why) bad.push(`cannot parse js/boot.js (${why})`);
    else if (/^\s*(import|export)\b/m.test(code) || /\bimport\s*\(/.test(code)) bad.push('js/boot.js has import/export: it must stay a classic script');
  }
  const [html, hwhy] = exists('index.html') ? tryStrip(stripHtml, read('index.html')) : ['', 'index.html is missing'];
  const first = hwhy ? '' : ((/<script\b[^>]*>/i.exec(html) || [''])[0]);
  // The tag's attributes, read one by one (name -> value, '' for a bare attribute), so data-src= or a comment-like text cannot pass.
  const attrs = new Map([...first.replace(/^<script\b/i, '').replace(/\/?>$/, '').matchAll(/([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)]
    .map((m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']));
  const type = (attrs.get('type') || '').trim().toLowerCase();
  if (hwhy) bad.push(`cannot parse index.html (${hwhy})`);
  else if (attrs.get('src') !== 'js/boot.js') bad.push(`the first <script> in index.html is not js/boot.js (${first || 'none'})`);
  else if (!attrs.has('defer') || attrs.has('async') || attrs.has('nomodule') || (attrs.has('type') && type !== 'text/javascript')) bad.push(`js/boot.js must load as a classic script with defer, and nothing else (${first})`);
  const stripped = jsFiles().map((f) => [f, tryStrip(stripJsComments, read(f))[0] || '']);
  const importers = stripped.filter(([f, t]) => f !== 'js/boot.js' && /\bboot\.js\b/.test(t)).map(([f]) => f);
  if (importers.length) bad.push(`js/boot.js is named in ${importers.join(', ')}: no module may import it (a broken boot.js would take the app down)`);
  const regs = stripped.flatMap(([f, t]) => (t.match(/serviceWorker\s*\.\s*register\s*\(|\bsw\s*\.\s*register\s*\(/g) || []).map(() => f));
  const others = regs.filter((f) => f !== 'js/boot.js' && f !== 'js/main.js');
  if (regs.filter((f) => f === 'js/boot.js').length !== 1) bad.push('js/boot.js must call register exactly once');
  if (regs.filter((f) => f === 'js/main.js').length > 1) bad.push('js/main.js may hold only the one fallback register');
  if (others.length) bad.push(`serviceWorker.register outside js/boot.js: ${others.join(', ')}`);
  if (regs.includes('js/main.js') && !/if\s*\(\s*window\.ssBoot\s*\)/.test(stripped.find(([f]) => f === 'js/main.js')[1])) bad.push('js/main.js registers sw.js without the window.ssBoot guard');
  bad.length ? fail(name, bad.join('; ')) : pass(name);
}

// ---------------------------------------------------------------- (c3) no Google client secret
{
  const name = 'no Google client secret in the repo';
  const appFiles = [...jsFiles(), ...['sw.js', 'index.html', 'css/app.css', 'manifest.webmanifest'].filter(exists)];
  const hits = appFiles.flatMap((f) => marksIn(read(f), SECRET_MARKS).map((h) => `${f}:${h}`));
  const covered = new Set(appFiles);
  for (const f of walkRepo()) {
    if (covered.has(f) || BINARY_EXT.has(path.extname(f).toLowerCase())) continue;
    if (fs.statSync(path.join(ROOT, f)).size > MAX_TEXT_BYTES) continue;
    hits.push(...marksIn(read(f), SECRET_MARKS.slice(1)).map((h) => `${f}:${h}`));
  }
  hits.length ? fail(name, hits.join('; ')) : pass(name);
}

// ---------------------------------------------------------------- (e) VERSION bump
{
  const name = 'VERSION bumped vs origin/main';
  let mainSw = null;
  try { mainSw = git('show', 'origin/main:sw.js'); } catch { /* none yet */ }
  if (mainSw === null) {
    note(name, 'origin/main has no sw.js yet');
  } else if (!precache) {
    fail(name, 'cannot read PRECACHE from sw.js');
  } else {
    const changed = new Set([
      ...git('diff', '--name-only', 'origin/main').split('\n'),
      ...git('ls-files', '--others', '--exclude-standard').split('\n'),
    ].filter(Boolean));
    const hit = [...new Set(precache.map(toRepoPath))].filter((f) => changed.has(f));
    const cur = parseVersion(swSrc), old = parseVersion(mainSw);
    if (!hit.length) pass(`${name} (no precached files changed)`);
    else if (cur === old) fail(name, `VERSION still '${cur}' but changed: ${hit.join(', ')} (run: node tools/checks.mjs --bump)`);
    else pass(`${name} (${old} -> ${cur})`);
  }
}

// ---------------------------------------------------------------- (e2) the SHA-256 table in sw.js
/* The worker answers from its cache only when a stored file has the SHA-256 written in HASHES (sw.js), because another site on the
   same github.io address can write into Cache Storage. So the table must be exactly right for the files as committed: an entry for
   every PRECACHE file, none for anything else, each hash equal to the file's bytes, written the way `--bump` writes it. A stale
   table is EXPECTED while you work (the Stop hook lets it through; run `node tools/checks.mjs --bump` in the part's last commit)
   and is REFUSED at a push to main (.githooks/pre-push). */
{
  const name = 'sw.js hash table';
  if (!precache) {
    fail(name, 'cannot read PRECACHE from sw.js');
  } else {
    const table = parseHashes(swSrc);
    if (!table) fail(name, 'could not find `const HASHES = {...}` in sw.js (run: node tools/checks.mjs --bump)');
    else {
      const bad = [];
      const have = new Map(table);
      if (have.size !== table.length) bad.push('an entry appears twice');
      const listed = [...new Set(precache)];
      for (const u of listed) {
        if (!have.has(u)) { bad.push(`no entry for ${u}`); continue; }
        const f = path.join(ROOT, toRepoPath(u));
        if (!fs.existsSync(f)) continue;               // 'precache files exist' says so
        if (sha256Hex(fs.readFileSync(f)) !== have.get(u)) bad.push(`wrong hash for ${u}`);
      }
      for (const k of have.keys()) if (!listed.includes(k)) bad.push(`entry for ${k} is not in PRECACHE`);
      // The worker finds an entry by the path the browser asks for, so it must be written as that plain path ('./' for the folder): './js/x.js' or a %-escape would pass every other check and then never be served from the cache.
      for (const u of listed) if (u !== './' && new URL(u, 'https://h/b/').pathname.slice(3) !== u) bad.push(`${u} is not written as a plain path (the worker would never find it; write ${new URL(u, 'https://h/b/').pathname.slice(3)})`);
      if (!bad.length) {
        let exact = null;
        try { exact = withTable(swSrc, hashRows(listed)) === swSrc; } catch { exact = true; }
        if (!exact) bad.push('the table is not written the way --bump writes it (one entry per line, sorted)');
      }
      bad.length ? fail(name, `${bad.slice(0, 8).join('; ')}${bad.length > 8 ? `; and ${bad.length - 8} more` : ''} (run: node tools/checks.mjs --bump)`) : pass(`${name} (${table.length} entries)`);
    }
  }
}

// ---------------------------------------------------------------- (e3) a Content-Type for every kind of file
/* The worker sends a stored file with a Content-Type of its own (the TYPES table in sw.js), never one from the stored entry. A new
   kind of file in PRECACHE without a line there would be sent as application/octet-stream: caught here, not on a tablet. */
{
  const name = 'sw.js Content-Type table';
  const types = parseTypes(swSrc);
  if (!precache) fail(name, 'cannot read PRECACHE from sw.js');
  else if (!types) fail(name, 'could not find `const TYPES = {...}` in sw.js');
  else {
    // the way sw.js's typeOf() reads it: the letters after the last dot, as written (a .JS would not be found there either)
    const exts = [...new Set(precache.map((u) => (/\.([a-z0-9]+)$/i.exec(toRepoPath(u)) || [])[1] || ''))];
    const none = exts.filter((e) => !types.get(e));
    none.length ? fail(name, `PRECACHE holds file(s) of kind ${none.map((e) => `.${e || '(none)'}`).join(', ')} with no Content-Type in TYPES`) : pass(`${name} (${exts.length} kinds)`);
  }
}

// ---------------------------------------------------------------- (e4) git commits the served files as they are
/* The table holds the hash of the bytes GitHub Pages will serve, which are the COMMITTED bytes. A checkout that converts line endings
   (core.autocrlf, a text attribute: Jonathan also works from Windows) makes the working files differ from what a commit would
   store, and the table (made from the working files) would then be wrong for what is deployed. .gitattributes turns the conversion
   off; this asks git what it WOULD commit and fails if it differs from the file on disk. */
{
  const name = 'git commits the served files as they are (no line-ending conversion)';
  if (!precache) {
    note(name, 'PRECACHE could not be read');
  } else {
    const files = [...new Set(precache.map(toRepoPath))].sort();
    const hashAll = (extra) => execFileSync('git', ['hash-object', ...extra, '--stdin-paths'], { cwd: ROOT, input: files.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['pipe', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
    let converted = null;
    try {
      git('rev-parse', '--is-inside-work-tree');
      const withFilters = hashAll([]), raw = hashAll(['--no-filters']);
      converted = files.length === withFilters.length && files.length === raw.length ? files.filter((f, i) => withFilters[i] !== raw[i]) : null;
    } catch { converted = null; }
    const crlf = converted === null ? [] : crlfOnly(files);
    if (converted === null) note(name, 'git could not be asked here (not a git checkout)');
    else if (crlf.length) fail(name, crlfFix(crlf));
    else if (converted.length) fail(name, `git would change the line endings of ${converted.slice(0, 6).join(', ')}${converted.length > 6 ? ` and ${converted.length - 6} more` : ''} when it commits them, so the bytes GitHub Pages serves would not be the bytes the hash table in sw.js was made from. .gitattributes has "* -text" for this; check "git config core.autocrlf" (want false) and check the files out again`);
    else pass(name);
  }
}

// ---------------------------------------------------------------- (f) DB_VERSION never goes down
/* A tablet that has already upgraded its database cannot open it with an older number (VersionError), so reverting a commit that
   raised DB_VERSION would hide every library (BREAK-GLASS.md, situation (a)). */
{
  const name = 'DB_VERSION not lower than on origin/main';
  const num = (src) => { const m = /DB_VERSION\s*=\s*(\d+)/.exec(src || ''); return m ? Number(m[1]) : null; };
  let mainStore = null;
  try { mainStore = git('show', 'origin/main:js/store.js'); } catch { /* none yet */ }
  const cur = num(read('js/store.js')), old = num(mainStore);
  if (cur === null) fail(name, 'js/store.js has no DB_VERSION');
  else if (old !== null && cur < old) fail(name, `DB_VERSION is ${cur} but origin/main has ${old}: keep the higher number (and its stores) when reverting`);
  else pass(name);
}

process.exit(failures ? 1 : 0);

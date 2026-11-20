#!/usr/bin/env node
// Setlist Stand pre-ship checks. Zero dependencies.
//   node tools/checks.mjs          run all checks (exit 1 on any FAIL)
//   node tools/checks.mjs --bump   write a new VERSION (YYYY-MM-DD-N) into sw.js
// Paths resolve from this file's location, so it works from any cwd/worktree.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW = path.join(ROOT, 'sw.js');
const APP_DIRS = ['css', 'js', 'vendor', 'icons'];
const APP_FILES = ['index.html', 'manifest.webmanifest'];
const IGNORE = new Set(['.DS_Store', 'Thumbs.db']);

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

function parsePrecache(src) {
  const m = /const\s+PRECACHE\s*=\s*\[([\s\S]*?)\]/.exec(src);
  if (!m) return null;
  return [...stripJsComments(m[1]).matchAll(/(['"`])([^'"`]*)\1/g)].map((x) => x[2]);
}

// Normalise a PRECACHE URL to a repo path ('./' -> index.html).
const toRepoPath = (u) => (u === './' || u === '' ? 'index.html' : u.replace(/^\.\//, ''));

// Remove // and /* */ comments while leaving string/template contents intact,
// so 'https://x' is never mistaken for a line comment.
function stripJsComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c;
      for (i++; i < src.length && src[i] !== q; i++) {
        out += src[i];
        if (src[i] === '\\') out += src[++i] ?? '';
      }
      out += src[i] ?? '';
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const chunk = src.slice(i, end < 0 ? src.length : end + 2);
      out += chunk.replace(/[^\n]/g, ' ');
      i = end < 0 ? src.length : end + 1;
    } else out += c;
  }
  return out;
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

// ---------------------------------------------------------------- --bump
if (process.argv.includes('--bump')) {
  const src = fs.readFileSync(SW, 'utf8');
  const cur = parseVersion(src);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const m = cur && /^(\d{4}-\d{2}-\d{2})-(\d+)$/.exec(cur);
  const next = `${today}-${m && m[1] === today ? Number(m[2]) + 1 : 1}`;
  fs.writeFileSync(SW, src.replace(/(const\s+VERSION\s*=\s*)(['"])[^'"]*\2/, `$1'${next}'`));
  console.log(`VERSION ${cur} -> ${next}`);
  process.exit(0);
}

// ---------------------------------------------------------------- (a) syntax
{
  const name = 'syntax (node --check)';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setlist-checks-'));
  const bad = [];
  try {
    const targets = jsFiles().map((f) => [f, true]);
    if (exists('sw.js')) targets.push(['sw.js', false]);
    for (const [rel, isModule] of targets) {
      let file = path.join(ROOT, rel);
      if (isModule) {
        file = path.join(tmp, rel.replace(/[\\/]/g, '__') + '.mjs');
        fs.copyFileSync(path.join(ROOT, rel), file);
      }
      try {
        execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        const msg = String(e.stderr || '').split('\n').find((l) => /Error/.test(l)) || 'syntax error';
        bad.push(`${rel} (${msg.trim()})`);
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
    fail('precache parse', 'could not find `const PRECACHE = [...]` in sw.js');
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
  const code = [
    ...jsFiles().map((f) => [f, stripJsComments(read(f))]),
    ...['sw.js'].filter(exists).map((f) => [f, stripJsComments(read(f))]),
    ...['index.html'].filter(exists).map((f) => [f, stripHtml(read(f))]),
    ...['css/app.css'].filter(exists).map((f) => [f, stripCssComments(read(f))]),
  ];
  const scan = (name, re, label) => {
    const hits = [];
    for (const [f, src] of code) {
      for (const m of src.matchAll(re)) hits.push(`${f}:${lineOf(src, m.index)} ${label(m)}`);
    }
    hits.length ? fail(name, hits.join('; ')) : pass(name);
  };
  scan('no remote URLs in app code', /https?:\/\/[^\s'"`)<>]*/g, (m) => m[0]);
  scan('no window.claude in app code', /window\s*\.\s*claude\b/g, () => 'window.claude');
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

process.exit(failures ? 1 : 0);

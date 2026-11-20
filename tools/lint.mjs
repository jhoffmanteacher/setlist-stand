#!/usr/bin/env node
/* lint.mjs: the name checker, ESLint over the app's modules, sw.js and the tools (ported from guitar-class).

     node tools/lint.mjs              a short report; exits 0 (report-only), also when ESLint cannot run (it says so)
     node tools/lint.mjs --strict     exit 1 when an error-level finding is left, 2 when ESLint cannot run
     node tools/lint.mjs --verbose    also list every warning (no-unused-vars)
     node tools/lint.mjs --github     also print GitHub annotations (::warning per finding, ::notice with counts)
     node tools/lint.mjs --root=DIR   lint another folder (a scratch copy)

   Zero dependencies itself. It runs ESLint fetched by npx at the exact versions pinned in eslint.config.mjs
   (`npx --yes -p eslint@X -p globals@Y node tools/lint.mjs --inner ...`), so nothing is installed in the repo.
   npx needs the network the first time; after that npm's cache. Not part of tools/checks.mjs; GitHub runs it
   report-only (.github/workflows/checks.yml, job "lint"). Files and rules: eslint.config.mjs. */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const a = argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const ROOT = resolve(opt('root', TOOL_ROOT));

function cannotRun(why) {
  console.error('lint: ESLint did not run: ' + why);
  if (flag('github')) console.log(`::warning title=lint did not run::${why.replace(/\r?\n/g, ' ')}`);
  process.exit(flag('strict') ? 2 : 0);
}
if (!existsSync(join(ROOT, 'sw.js')) && !existsSync(join(ROOT, 'js'))) cannotRun(`${ROOT} has no sw.js or js/`);

let cfg;
try { cfg = await import(pathToFileURL(join(TOOL_ROOT, 'eslint.config.mjs')).href); } catch (e) { cannotRun('eslint.config.mjs did not load: ' + e.message); }
const { ESLINT_VERSION, GLOBALS_VERSION, configs } = cfg;

/* ── Outer run: fetch the pinned ESLint with npx and run this file again inside it ── */
if (!flag('inner')) {
  const win = process.platform === 'win32';
  const q = (a) => (win && /[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a);   // npx.cmd needs a shell there
  const r = spawnSync(win ? 'npx.cmd' : 'npx', ['--yes', '-p', `eslint@${ESLINT_VERSION}`, '-p', `globals@${GLOBALS_VERSION}`,
    'node', fileURLToPath(import.meta.url), '--inner', ...argv].map(q), { stdio: 'inherit', shell: win });
  if (r.error) cannotRun('could not start npx: ' + r.error.message);
  // The inner run exits 0, or 3 for "--strict and findings are left"; anything else means npx or the run broke.
  if (r.status !== 0 && r.status !== 3) cannotRun(`npx exited ${r.status ?? 'on signal ' + r.signal}`);
  process.exit(r.status === 3 ? 1 : 0);
}

/* ── Inner run: eslint and globals are on PATH (npx put their .bin there) ── */
function npxModules() {
  for (const d of (process.env.PATH || '').split(delimiter)) {
    if (existsSync(join(d, 'eslint')) || existsSync(join(d, 'eslint.cmd'))) {
      const nm = dirname(d);
      if (existsSync(join(nm, 'eslint', 'package.json')) && existsSync(join(nm, 'globals', 'package.json'))) return nm;
    }
  }
  cannotRun('--inner found no eslint + globals install on PATH (run it without --inner)');
}
const req = createRequire(join(npxModules(), 'noop.js'));
const { Linter } = req('eslint');
const GLOBALS = req('globals');
const realVersion = req('eslint/package.json').version;
if (realVersion !== ESLINT_VERSION) cannotRun(`npx gave ESLint ${realVersion}, pinned ${ESLINT_VERSION}`);

/* The files: js/**\/*.js, sw.js, tools/**\/*.mjs, .claude/hooks/*.mjs, eslint.config.mjs. */
function walk(rel, test) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
  return readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((d) => {
    const r = `${rel}/${d.name}`;
    return d.isDirectory() ? (d.name === 'node_modules' ? [] : walk(r, test)) : test(d.name) ? [r] : [];
  });
}
const files = [
  ...walk('js', (n) => n.endsWith('.js')),
  ...['sw.js', 'eslint.config.mjs'].filter((f) => existsSync(join(ROOT, f))),
  ...walk('tools', (n) => n.endsWith('.mjs')),
  ...walk('.claude/hooks', (n) => n.endsWith('.mjs')),
];

const linter = new Linter({ cwd: ROOT });
const config = configs(GLOBALS);
const findings = [];
const parseErrors = [];
for (const rel of files) {
  const msgs = linter.verify(readFileSync(join(ROOT, rel), 'utf8'), config, { filename: join(ROOT, rel) });
  for (const m of msgs) {
    if (m.fatal) parseErrors.push({ file: rel, line: m.line, text: m.message });
    else if (m.ruleId) findings.push({ file: rel, line: m.line, rule: m.ruleId, text: m.message, severity: m.severity });
  }
}

/* ── Report ── */
const errors = findings.filter((f) => f.severity === 2);
const warnings = findings.filter((f) => f.severity !== 2);
const count = {};
for (const f of findings) count[f.rule] = (count[f.rule] || 0) + 1;
const countLine = Object.entries(count).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(' · ') || 'no findings';
console.log(`lint: ESLint ${ESLINT_VERSION} over ${files.length} files: ${errors.length} errors, ${warnings.length} warnings${parseErrors.length ? `, ${parseErrors.length} PARSE ERRORS` : ''}`);
console.log('  ' + countLine + '   (no-unused-vars is a warning; the rest are errors)');
const ghEsc = (x) => String(x).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/::/g, ': :');
const annotate = (f) => { if (flag('github')) console.log(`::warning file=${ghEsc(f.file)},line=${f.line},title=${ghEsc(f.rule || 'parse error')}::${ghEsc(f.text)}`); };
for (const p of parseErrors) { console.log(`  PARSE ERROR ${p.file}:${p.line} ${p.text}`); annotate(p); }
for (const f of errors) { console.log(`  ${f.file}:${f.line} ${f.rule}: ${f.text}`); annotate(f); }
if (flag('verbose')) for (const f of warnings) { console.log(`  ${f.file}:${f.line} ${f.rule}: ${f.text} (warning)`); annotate(f); }
else if (warnings.length) console.log(`  ${warnings.length} warnings (list them with --verbose)`);
if (flag('github')) console.log(`::notice title=lint (report-only)::${countLine}`);
const strictBad = errors.length + parseErrors.length;
if (flag('strict') && strictBad) { console.log(`lint: --strict: ${strictBad} error-level finding(s) left`); process.exitCode = 3; }   // the outer run turns 3 into exit 1

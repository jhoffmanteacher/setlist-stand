/*
 * File-check loop j (2026-11-24): tools/checks.mjs where the line endings can go wrong. The hash table in sw.js is the SHA-256 of the
 * bytes GitHub Pages serves, which are the COMMITTED bytes; Jonathan also works from Windows, where git (core.autocrlf=true) turns LF
 * into CRLF at checkout. This builds real git repositories in the temp folder, clones them the way a Windows machine does, and runs
 * the real tools/checks.mjs in each:
 *   - a clone of a repository WITH .gitattributes ("* -text") keeps LF: every check passes;
 *   - a clone of one WITHOUT it has CRLF files: the table check and the line-ending check go red, and the second says why;
 *   - a clone checked out BEFORE .gitattributes existed, which then pulls it: the files stay CRLF on disk while git status is clean
 *     (git does not read a file again while its size and time are unchanged): the line-ending check still goes red, and --bump
 *     refuses to write a table made from them;
 *   - the fix the message gives (core.autocrlf false, check the files out again) makes --bump and every check pass.
 * No browser is used; the real checks.mjs of the folder being tested (ctx.root) is the one run.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {TMP, assert} from './harness.mjs';

const GIT_ID = ['-c', 'user.email=loops@example.invalid', '-c', 'user.name=loops', '-c', 'commit.gpgsign=false'];
function git(cwd, ...args){
  const r = spawnSync('git', [...GIT_ID, ...args], {cwd, encoding: 'utf8', maxBuffer: 1 << 26});
  assert(r.status === 0, `git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  return r.stdout;
}
const checks = (dir, ...flags) => {
  const r = spawnSync(process.execPath, [path.join(dir, 'tools', 'checks.mjs'), ...flags], {cwd: dir, encoding: 'utf8', env: {...process.env, NO_COLOR: '1'}, maxBuffer: 1 << 26});
  return {code: r.status, out: (r.stdout || '') + (r.stderr || ''), fails: (r.stdout || '').split('\n').filter(l => l.startsWith('FAIL'))};
};
/* What checks.mjs needs, copied from the folder under test (no node_modules, no .git, nothing private). */
function copyTree(from, to, {withAttributes}){
  for(const e of ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'vendor', 'icons', 'tools/checks.mjs']){
    fs.mkdirSync(path.dirname(path.join(to, e)), {recursive: true});
    fs.cpSync(path.join(from, e), path.join(to, e), {recursive: true});
  }
  if(withAttributes) fs.copyFileSync(path.join(from, '.gitattributes'), path.join(to, '.gitattributes'));
}
function origin(ctx, name, withAttributes){
  const dir = path.join(TMP, `fc-${name}`);
  fs.mkdirSync(dir, {recursive: true});
  git(dir, 'init', '-q', '-b', 'main');
  copyTree(ctx.root, dir, {withAttributes});
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', name);
  return dir;
}
const windowsClone = (src, name) => { const dir = path.join(TMP, `fc-${name}`); git(TMP, 'clone', '-q', '-c', 'core.autocrlf=true', src, dir); return dir; };
const crlfCount = (dir, f) => (fs.readFileSync(path.join(dir, f), 'utf8').match(/\r\n/g) || []).length;
const hasFail = (r, re) => r.fails.some(l => re.test(l));

export const loops = [
{
  name: 'filecheck j: checks.mjs in a Windows-style checkout (core.autocrlf=true): right with .gitattributes, red and saying why without it or when files were left CRLF; --bump refuses then',
  async run(ctx){
    const withAttr = origin(ctx, 'with-attributes', true), without = origin(ctx, 'without-attributes', false);
    assert(!checks(withAttr).fails.length, 'test setup: checks.mjs is not green in a plain copy: ' + checks(withAttr).fails.join(' | '));

    /* 1. a Windows clone of a repository that has .gitattributes keeps LF, and the table is right for what git holds */
    const a = windowsClone(withAttr, 'clone-with');
    assert(crlfCount(a, 'js/util.js') === 0, 'test setup: a clone with .gitattributes got CRLF in js/util.js');
    const ra = checks(a);
    assert(!ra.fails.length, 'a Windows clone WITH .gitattributes is not green: ' + ra.fails.join(' | '));

    /* 2. a Windows clone of one without it has CRLF files: red, and the line-ending check says why */
    const b = windowsClone(without, 'clone-without');
    assert(crlfCount(b, 'js/util.js') > 100, 'test setup: a clone without .gitattributes did not get CRLF');
    const rb = checks(b);
    assert(hasFail(rb, /^FAIL sw\.js hash table/), 'a Windows clone without .gitattributes: the hash table check did not go red');
    assert(hasFail(rb, /^FAIL git commits the served files as they are.*line endings/), 'a Windows clone without .gitattributes: the line-ending check did not go red and say why: ' + rb.fails.join(' | '));

    /* 3. checked out BEFORE .gitattributes existed, then it arrives: the files stay CRLF, git status is clean, git would not convert
          (it has `-text` now) so only a look at the bytes finds them */
    fs.copyFileSync(path.join(ctx.root, '.gitattributes'), path.join(b, '.gitattributes'));
    git(b, 'add', '.gitattributes'); git(b, 'commit', '-q', '-m', 'gitattributes arrives');
    assert(crlfCount(b, 'js/util.js') > 100, 'test setup: the files lost their CRLF');
    const rc = checks(b);
    assert(hasFail(rc, /^FAIL git commits the served files as they are.*Windows line endings/), 'files left CRLF from before .gitattributes: the line-ending check did not go red and say why: ' + rc.fails.join(' | '));
    const bump = checks(b, '--bump');
    assert(bump.code === 1 && /not bumped.*Windows line endings/.test(bump.out), `--bump wrote a table from CRLF files (exit ${bump.code}): ${bump.out.slice(0, 300)}`);

    /* 4. the fix the message gives */
    git(b, 'config', 'core.autocrlf', 'false'); git(b, 'checkout', 'HEAD', '--', '.');
    assert(crlfCount(b, 'js/util.js') === 0, 'test setup: the checkout did not bring the LF files back');
    const fixed = checks(b, '--bump');
    assert(fixed.code === 0, '--bump after the fix failed: ' + fixed.out.slice(0, 300));
    const rd = checks(b);
    assert(!rd.fails.filter(l => !/VERSION bumped/.test(l)).length, 'after the fix a check is still red: ' + rd.fails.join(' | '));
  }
},
];

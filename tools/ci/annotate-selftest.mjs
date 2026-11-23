#!/usr/bin/env node
/* Self-test for tools/ci/run-and-annotate.mjs (2026-11-23). No browser. Runs the wrapper around a fake tool (this same
   file with --emit <case>) and checks the ::error / ::notice lines it prints. Run: node tools/ci/annotate-selftest.mjs */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const WRAPPER = join(dirname(SELF), 'run-and-annotate.mjs');
const out = (...l) => console.log(l.join('\n'));

const emit = {
  'loops-fail'() {
    for (let i = 1; i <= 50; i++) { out(`PASS: loop ${i} (0.1s)`); out(`  info: noise ${i}`); }
    out('FAIL: update a: first reason', 'FAIL: update b: second reason', '      | line one', '      | line two', '      | line three', 'FAIL: update c: third');
    out('failed loops: a; b; c', '3 of 53 loops FAILED'); process.exitCode = 1;
  },
  'many-fails'() { for (let i = 1; i <= 120; i++) out(`FAIL: loop ${i}: ${'x'.repeat(2000)}`); out('120 of 120 loops FAILED'); process.exitCode = 1; },
  'smoke-fail'() { out('PASS: add', 'FAIL: open: timeout 15000ms', '      screenshot: /tmp/x.png', '      page errors: a | b', 'SKIP: draw'); process.exitCode = 1; },
  'checks-fail'() { out('PASS syntax', 'FAIL CSP pinned: differs from the pin'); process.exitCode = 1; },
  'escape'() { out('FAIL: esc: 100% done, a:b, c::d\r'); process.exitCode = 1; },
  'pass'() { out('PASS: a', 'PASS: b', 'all 5 loops ran clean'); },
  'hang'() { out('FAIL: early: x'); setTimeout(() => {}, 60000); },
  'cannot-run'() { out('could not run: no Chrome'); process.exitCode = 2; },
};
if (process.argv[2] === '--emit') { emit[process.argv[3]](); } else await main();

function unesc(s, prop) {
  let r = s.replace(/%0D/g, '\r').replace(/%0A/g, '\n');
  if (prop) r = r.replace(/%3A/g, ':').replace(/%2C/g, ',');
  return r.replace(/%25/g, '%');
}
function run(name, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'annot-'));
  const summary = join(dir, 'summary.md');
  return new Promise((res) => {
    const c = spawn(process.execPath, [WRAPPER, '--title', 'fake', '--log', join(dir, 'log.txt'), ...extra, '--', process.execPath, SELF, '--emit', name],
      { env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
    let so = ''; c.stdout.on('data', d => so += d); c.stderr.on('data', () => {});
    c.on('close', (code) => {
      const ann = so.split('\n').map(l => l.match(/^::(error|notice) title=(.*?)::(.*)$/)).filter(Boolean)
        .map(m => ({ level: m[1], title: unesc(m[2], true), body: unesc(m[3]) }));
      res({ code, ann, lines: so.split('\n'), summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '' });
    });
  });
}

async function main() {
  let bad = 0;
  const t = async (name, extra, exit, check) => {
    try {
      const r = await run(name, extra);
      if (r.code !== exit) throw new Error(`exit ${r.code}, wanted ${exit}`);
      check(r);
      console.log(`PASS: ${name}`);
    } catch (e) { bad++; console.log(`FAIL: ${name}: ${e.message}`); }
  };
  const ok = (c, m) => { if (!c) throw new Error(m); };
  const errs = (r) => r.ann.filter(a => a.level === 'error');

  await t('loops-fail', [], 1, r => {
    const [a, b] = errs(r); ok(errs(r).length === 2, 'want 2 errors');
    const i = ['FAIL: update a', 'FAIL: update b', 'FAIL: update c'].map(s => a.body.indexOf(s));
    ok(i[0] >= 0 && i[0] < i[1] && i[1] < i[2], 'FAIL lines missing or out of order');
    ok(a.body.includes('      | line one'.trim()) && a.body.includes('| line three'), 'continuation lines missing');
    ok(!a.body.includes('info:'), 'info line leaked');
    ok(a.body.endsWith('3 of 53 loops FAILED'), 'final line not last');
    ok(a.title.endsWith('3 of 53 loops FAILED'), 'title lacks final line');
    ok(b.body.includes('failed loops: a; b; c'), 'second annotation is not the tail');
    ok(r.summary.includes('FAIL: update a'), 'summary lacks FAIL lines');
  });
  await t('many-fails', [], 1, r => {
    const a = errs(r)[0]; const n = a.body.split('\n').filter(l => l.startsWith('FAIL: loop')).length;
    ok(n === 40, `${n} FAIL lines, wanted 40`);
    ok(a.body.includes('… and 80 more FAIL line(s)'), 'no "more" line');
    ok(a.body.endsWith('120 of 120 loops FAILED'), 'final line not last');
    ok(a.body.split('\n').some(l => l.endsWith('x …')), 'long lines not cut');
    ok(a.body.length <= 48100, `body ${a.body.length} chars`);
    ok(r.lines.filter(l => l.startsWith('::error')).length === 2, 'an annotation spans stdout lines');
  });
  await t('smoke-fail', [], 1, r => {
    const a = errs(r)[0].body; ok(a.includes('FAIL: open: timeout') && a.includes('screenshot: /tmp/x.png') && a.includes('page errors: a | b'), 'smoke lines missing');
  });
  await t('checks-fail', [], 1, r => ok(errs(r)[0].body.includes('FAIL CSP pinned: differs from the pin'), 'line missing'));
  await t('escape', [], 1, r => {
    ok(errs(r)[0].body.includes('FAIL: esc: 100% done, a:b, c::d') && !errs(r)[0].body.includes('\r'), `body: ${JSON.stringify(errs(r)[0].body)}`);
    ok(r.lines.filter(l => l.startsWith('::error')).length === 2, 'raw newline escaped');
  });
  await t('pass', [], 0, r => ok(r.ann.length === 1 && r.ann[0].level === 'notice', 'want exactly one notice'));
  await t('hang', ['--deadline', '0.05'], 1, r => {
    const a = errs(r)[0]; ok(a.title.includes('stopped after 0.05 min by --deadline'), 'title: ' + a.title); ok(a.body.includes('FAIL: early: x'), 'early FAIL missing');
  });
  await t('cannot-run', [], 2, r => ok(errs(r)[0].body.includes('could not run: no Chrome'), 'line missing'));
  console.log(bad ? `${bad} case(s) FAILED` : 'all cases passed');
  process.exit(bad ? 1 : 0);
}

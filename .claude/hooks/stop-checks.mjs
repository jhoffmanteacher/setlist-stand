#!/usr/bin/env node
/* Claude Code Stop hook: the "did I just break something?" step, done for you (ported from guitar-class).

   When Claude finishes a turn and code files (js/mjs/css/html/json, not .claude/ or docs) are changed in the
   working tree, this runs `node tools/checks.mjs` (read-only, about a second). If a check fails, it BLOCKS the
   stop and hands the failing lines back, so the fix happens in the same turn. Wired in .claude/settings.json.

   Built so that it can never trap a session:
   - It only runs when the set of changed code files (and their sizes and times) differs from the last state it
     checked; a read-only or chat-only turn costs nothing.
   - "FAIL VERSION bumped vs origin/main" and "FAIL sw.js hash table" are EXPECTED, not failures: CLAUDE.md bumps VERSION
     (and writes the SHA-256 table of sw.js with it) last, in a part's last commit (node tools/checks.mjs --bump).
     .githooks/pre-push enforces both before a push to main.
   - It blocks at most MAX_BLOCKS times per turn (prompt_id), and never twice for the identical file state.
     Claude Code also caps consecutive stop-hook continuations itself.
   - Every internal problem (no git, no tools/checks.mjs, a crash, a timeout) fails OPEN: the stop is allowed
     (with a short note when something went wrong).
   - Off switch: SS_STOP_CHECKS=0 in the environment.
   It does not replace the git hooks, tools/smoke.mjs or tools/loops.mjs. Node only, no dependencies. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_BLOCKS = 3;
const CHECK_TIMEOUT_MS = 60000;
const CODE = /\.(js|mjs|cjs|css|html|json|webmanifest)$/i;
const SKIP = /^(\.claude\/|node_modules\/|docs\/|Claude outputs\/)/;
// The hash-table line is expected only when the table is STALE (wrong hash, missing or extra entry, not written the way --bump writes it); a table that cannot be read at all is a real failure.
const EXPECTED = /^FAIL (?:VERSION bumped vs origin\/main:|sw\.js hash table: (?!could not find|cannot read|an entry appears twice))/;

const done = (obj) => { if (obj) console.log(JSON.stringify(obj)); process.exit(0); };
const note = (msg) => done({ systemMessage: msg });

try {
  if (process.env.SS_STOP_CHECKS === '0') done();

  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no stdin payload: fine */ }

  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
  let root;
  try { root = git(input.cwd || process.cwd(), 'rev-parse', '--show-toplevel').trim(); } catch { done(); }   // not a git checkout
  if (!existsSync(join(root, 'tools', 'checks.mjs'))) done();                                               // not this repo, or checks gone

  // Changed code files: modified, added, renamed and untracked (deleted ones have nothing to check).
  const changed = () => {
    const parts = git(root, 'status', '--porcelain=v1', '-z', '-uall').split('\0').filter(Boolean);
    const files = [];
    for (let i = 0; i < parts.length; i++) {
      const st = parts[i].slice(0, 2), p = parts[i].slice(3);
      if (st[0] === 'R' || st[0] === 'C') i++;
      if (st.includes('D')) continue;
      if (CODE.test(p) && !SKIP.test(p)) files.push(p);
    }
    return [...new Set(files)].sort();
  };
  let files;
  try { files = changed(); } catch { done(); }
  if (!files.length) done();

  const fingerprint = (list) => {
    const h = createHash('sha1');
    for (const f of list) {
      let s;
      try { const st = statSync(join(root, f)); s = st.size + ':' + Math.round(st.mtimeMs); } catch { s = 'gone'; }
      h.update(f + '\0' + s + '\0');
    }
    return h.digest('hex');
  };
  const statePath = join(tmpdir(), `ss-stop-checks-${String(input.session_id || 'nosession').replace(/[^\w-]/g, '')}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}.json`);
  let state = {};
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* first run */ }
  const save = (s) => { try { writeFileSync(statePath, JSON.stringify(s)); } catch { /* best effort */ } };

  const fp = fingerprint(files);
  if (state.fp === fp && state.result === 'pass') done();                        // this exact state already passed
  if (state.fp === fp && state.result === 'fail') note('Stop-hook checks still fail on the same files; not blocking again.');

  const run = spawnSync(process.execPath, [join(root, 'tools', 'checks.mjs')], { cwd: root, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: 1 << 26, env: { ...process.env, NO_COLOR: '1' } });
  if (run.error || run.status === null) note(`Stop-hook checks could not run (${run.error ? run.error.code || run.error.message : 'timed out'}); allowing the stop.`);

  const lines = (run.stdout + '\n' + run.stderr).replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const failing = lines.filter((l) => /^FAIL /.test(l) && !EXPECTED.test(l));
  const turn = String(input.prompt_id || '');
  if (!failing.length) {
    // exit 1 with no FAIL line at all is a crash of checks.mjs, not a verdict: fail open, do not record a pass.
    if (run.status !== 0 && !lines.some((l) => EXPECTED.test(l))) note(`Stop-hook checks exited ${run.status} without a FAIL line; allowing the stop. ${lines.find((l) => /Error/.test(l)) || lines.filter(Boolean).slice(-1)[0] || ''}`);
    save({ fp, result: 'pass', blocks: 0, turn });
    done();
  }

  // The retry budget is per turn: a failure left unfixed in one turn must not silence the hook in later turns.
  const blocks = (state.turn === turn ? state.blocks || 0 : 0) + 1;
  save({ fp, result: 'fail', blocks, turn });
  if (blocks > MAX_BLOCKS) note(`Stop-hook checks still fail after ${MAX_BLOCKS} tries; handing back to you. First failure: ${failing[0]}`);

  done({
    decision: 'block',
    reason: [
      `node tools/checks.mjs fails after your edits (${files.slice(0, 8).join(', ')}${files.length > 8 ? ', ...' : ''}).`,
      'Fix the cause; do not loosen a check. The "VERSION bumped" and "sw.js hash table" lines are expected until the part\'s last commit (node tools/checks.mjs --bump) and are not failures here.',
      `Re-run: node tools/checks.mjs   (attempt ${blocks} of ${MAX_BLOCKS}; off switch: SS_STOP_CHECKS=0)`,
      '',
      ...failing.slice(0, 40),
    ].join('\n'),
  });
} catch (e) {
  note(`Stop-hook checks hit an internal problem (${e && e.message}); allowing the stop.`);
}

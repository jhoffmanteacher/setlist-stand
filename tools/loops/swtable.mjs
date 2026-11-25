/*
 * Is the SHA-256 table in a folder's sw.js (HASHES) right for the folder's own files? (2026-11-24)
 *
 * The worker checks every stored file against that table, so a folder served with a STALE table (a file changed since
 * `node tools/checks.mjs --bump` or `--rehash`) never installs a worker: every loop that waits for one then fails with
 * "service worker did not install", which says nothing about what is wrong. tools/loops.mjs and tools/smoke.mjs call
 * tableProblem(root) before they start a browser and stop with the real reason. Reads only; no dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
/* null when the table is right for the files (or the folder has no worker); else one sentence saying what to run. */
export function tableProblem(root){
  const f = path.join(root, 'sw.js');
  if(!fs.existsSync(f)) return null;
  const src = stripComments(fs.readFileSync(f, 'utf8'));
  const pre = /const\s+PRECACHE\s*=\s*\[([\s\S]*?)\]/.exec(src), tab = /const\s+HASHES\s*=\s*\{([^}]*)\}/.exec(src);
  if(!pre || !tab) return null;                       // not this app's worker (the kill switch's, for one): nothing to check
  const have = new Map([...tab[1].matchAll(/(['"])([^'"]*)\1\s*:\s*(['"])([^'"]*)\3/g)].map(x => [x[2], x[4]]));
  const stale = [];
  for(const u of new Set([...pre[1].matchAll(/(['"`])([^'"`]*)\1/g)].map(x => x[2]))){
    const file = path.join(root, u === './' || u === '' ? 'index.html' : u.replace(/^\.\//, ''));
    const sum = fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
    if(sum !== have.get(u)) stale.push(u);
  }
  return stale.length
    ? `the hash table in ${f} is stale for ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ` and ${stale.length - 5} more` : ''}: the worker would refuse these files and no loop could install it. Run: node tools/checks.mjs --rehash (--bump in the part's last commit)`
    : null;
}
